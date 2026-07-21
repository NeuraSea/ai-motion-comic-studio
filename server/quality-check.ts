import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type {
  GenerationJobRecord,
  ManjuDatabase,
  MediaAssetRecord,
} from './database.js'
import type { ExportRecord, ExportRenderService } from './export-render.js'
import {
  FfmpegRenderError,
  resolutionDimensions,
  SpawnProcessRunner,
  type ProcessRunResult,
  type RenderProcessRunner,
} from './ffmpeg-renderer.js'
import { MediaStore, MediaStoreError } from './media.js'
import type { JsonObject, JsonValue } from './types.js'
import {
  JobCancelledError,
  JobExecutionError,
  type JobHandler,
  type JobRecord,
} from './worker.js'
import {
  resolveRuntimeFfmpegPath,
  resolveRuntimeFfprobePath,
} from './ffmpeg-runtime.js'

export const QUALITY_CHECK_JOB_TYPE = 'quality.check'
export const QUALITY_CHECK_RESOURCE_KEY = 'analyzer:ffmpeg'
export const QUALITY_REPORT_VERSION = 1 as const
// Version 2 adds authoritative subtitle timing and safe-area checks. Reports
// produced under the five-check v1 policy must never authorize a new release.
export const QUALITY_POLICY_VERSION = 2 as const

const MAX_QC_MEDIA_BYTES = 250 * 1024 * 1024
const DEFAULT_PROCESS_TIMEOUT_MS = 2 * 60 * 1_000
const MAX_STDOUT_BYTES = 2 * 1024 * 1024
const MAX_STDERR_BYTES = 2 * 1024 * 1024
const FRAME_RATE_TOLERANCE = 0.001
const DURATION_TOLERANCE_SECONDS = 0.1

function bundledFfmpegPath(): string | null {
  return resolveRuntimeFfmpegPath()
}

function bundledFfprobePath(): string | null {
  return resolveRuntimeFfprobePath()
}

export type QualityReportStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'stale'

export type QualityCheckStatus = 'passed' | 'failed' | 'warning' | 'skipped'

export interface QualityCheckResult {
  id:
    | 'decodable'
    | 'ffprobe.specification'
    | 'video.black-frames'
    | 'audio.silence'
    | 'audio.peak'
    | 'subtitle.timing'
    | 'subtitle.safe-area'
  status: QualityCheckStatus
  severity: 'error' | 'warning' | 'info'
  message: string
  metrics: JsonObject
}

export interface QualityExpectedSpecification {
  container: 'mp4'
  durationSeconds: number
  frameCount: number
  videoCodec: 'h264'
  width: number
  height: number
  pixelFormat: 'yuv420p'
  frameRate: 24
  audioCodec: 'aac'
  audioSampleRate: 48_000
  audioChannels: 2
}

export interface QualityPolicy {
  version: typeof QUALITY_POLICY_VERSION
  blackDetectMinimumSeconds: number
  blackPixelThreshold: number
  blackPictureRatio: number
  maxBlackRatio: number
  maxContinuousBlackSeconds: number
  silenceDetectMinimumSeconds: number
  silenceThresholdDb: number
  maxSilenceRatio: number
  maxContinuousSilenceSeconds: number
  peakWarningDbfs: number
  peakFailureDbfs: number
}

export const DEFAULT_QUALITY_POLICY: QualityPolicy = Object.freeze({
  version: QUALITY_POLICY_VERSION,
  blackDetectMinimumSeconds: 0.5,
  blackPixelThreshold: 0.10,
  blackPictureRatio: 0.98,
  maxBlackRatio: 0.10,
  maxContinuousBlackSeconds: 2,
  silenceDetectMinimumSeconds: 0.5,
  silenceThresholdDb: -50,
  maxSilenceRatio: 0.50,
  maxContinuousSilenceSeconds: 5,
  peakWarningDbfs: -1,
  peakFailureDbfs: -0.1,
})

export interface QualityReportBinding {
  version: 1
  exportId: string
  outputAssetId: string
  outputAssetChecksum: string
  timelineRevisionId: string
  storyRevisionId: string
  exportSpecification: JsonObject
  expected: QualityExpectedSpecification
}

export interface QualityReportDocument {
  version: typeof QUALITY_REPORT_VERSION
  binding: QualityReportBinding
  policy: QualityPolicy
  checks: QualityCheckResult[]
  metrics: JsonObject
  summary: {
    passed: boolean | null
    failedChecks: number
    warningChecks: number
  }
}

export interface QualityReportRecord {
  id: string
  projectId: string
  episodeId: string
  exportId: string
  status: QualityReportStatus
  document: QualityReportDocument
  passed: boolean
  createdAt: string
  completedAt: string | null
}

export interface QualityAnalysisResult {
  passed: boolean
  checks: QualityCheckResult[]
  metrics: JsonObject
}

export interface QualityAnalysisRequest {
  /** Server-created, resolved path. Never accepted from an HTTP request. */
  inputPath: string
  expected: QualityExpectedSpecification
  policy: QualityPolicy
  signal?: AbortSignal
}

export interface QualityAnalyzerPort {
  analyze(request: QualityAnalysisRequest): Promise<QualityAnalysisResult>
}

export type QualityCheckErrorCode =
  | 'ASSET_BINDING_CONFLICT'
  | 'ASSET_NOT_READY'
  | 'ASSET_PROJECT_MISMATCH'
  | 'EXPORT_NOT_READY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_QUALITY_REQUEST'
  | 'PIPELINE_RUN_MISMATCH'
  | 'PIPELINE_RUN_NOT_FOUND'
  | 'QUALITY_CHECK_FAILED'
  | 'QUALITY_CHECK_PENDING'
  | 'QUALITY_CHECK_REQUIRED'
  | 'QUALITY_REPORT_NOT_FOUND'
  | 'QUALITY_REPORT_STALE'
  | 'QUALITY_STATE_CONFLICT'

export class QualityCheckError extends Error {
  constructor(readonly code: QualityCheckErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'QualityCheckError'
  }
}

export type QualityAnalysisErrorCode =
  | 'BINARY_UNAVAILABLE'
  | 'CANCELLED'
  | 'PROCESS_OUTPUT_LIMIT'
  | 'PROCESS_SPAWN_FAILED'
  | 'TIMEOUT'
  | 'UNSAFE_INPUT_PATH'

export class QualityAnalysisError extends Error {
  constructor(readonly code: QualityAnalysisErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'QualityAnalysisError'
  }
}

interface RawProbeStream {
  codec_type?: unknown
  codec_name?: unknown
  width?: unknown
  height?: unknown
  pix_fmt?: unknown
  r_frame_rate?: unknown
  avg_frame_rate?: unknown
  sample_rate?: unknown
  channels?: unknown
  nb_frames?: unknown
}

interface RawProbeDocument {
  streams?: unknown
  format?: unknown
}

interface DetectedInterval {
  startSeconds: number
  endSeconds: number
  durationSeconds: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new QualityCheckError('INVALID_QUALITY_REQUEST', `${label} 必须是字符串`)
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new QualityCheckError('INVALID_QUALITY_REQUEST', `${label} 格式无效`)
  }
  return normalized
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Database column ${key} is not text`)
  return value
}

function rowNullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Database column ${key} is not nullable text`)
  return value
}

function parseObjectText(value: unknown, key: string): JsonObject {
  if (typeof value !== 'string') throw new Error(`Database column ${key} is not JSON text`)
  const parsed: unknown = JSON.parse(value)
  if (!isPlainObject(parsed)) throw new Error(`Database column ${key} is not a JSON object`)
  return parsed as JsonObject
}

function asQualityReport(row: Record<string, unknown>): QualityReportRecord {
  const status = rowString(row, 'status') as QualityReportStatus
  if (!['queued', 'running', 'passed', 'failed', 'cancelled', 'stale'].includes(status)) {
    throw new Error(`Database contains unsupported quality report status: ${status}`)
  }
  const exportId = rowNullableString(row, 'export_id')
  if (!exportId) throw new Error('Quality report is missing export_id')
  const document = parseObjectText(row.checks_json, 'checks_json') as unknown as QualityReportDocument
  if (!isPlainObject(document.binding) || document.binding.exportId !== exportId) {
    throw new Error('Quality report has an invalid immutable binding')
  }
  return {
    id: rowString(row, 'id'),
    projectId: rowString(row, 'project_id'),
    episodeId: rowString(row, 'episode_id'),
    exportId,
    status,
    document,
    passed: row.passed === 1,
    createdAt: rowString(row, 'created_at'),
    completedAt: rowNullableString(row, 'completed_at'),
  }
}

function finitePositive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new QualityCheckError('ASSET_BINDING_CONFLICT', `${label} 无效`)
  }
  return value
}

function integerPositive(value: unknown, label: string): number {
  const parsed = finitePositive(value, label)
  if (!Number.isSafeInteger(parsed)) {
    throw new QualityCheckError('ASSET_BINDING_CONFLICT', `${label} 必须是正整数`)
  }
  return parsed
}

function expectedDimensions(record: ExportRecord): { width: number; height: number } {
  const specification = record.specification as unknown as Record<string, unknown>
  if (Number.isSafeInteger(specification.width) && Number.isSafeInteger(specification.height)) {
    return {
      width: integerPositive(specification.width, 'export width'),
      height: integerPositive(specification.height, 'export height'),
    }
  }
  if (specification.aspectRatio === '16:9'
    || specification.aspectRatio === '9:16'
    || specification.aspectRatio === '1:1') {
    return resolutionDimensions(record.specification.resolution, specification.aspectRatio)
  }
  // Compatibility for a pre-aspect-ratio v4 export record. New exports always
  // persist aspectRatio, while old 720p/1080p records were landscape-only.
  return resolutionDimensions(record.specification.resolution, '16:9')
}

function expectedSpecification(record: ExportRecord): QualityExpectedSpecification {
  const frameCount = record.timelineSnapshot.visualClips.reduce(
    (total, clip) => total + clip.durationFrames,
    0,
  )
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
    throw new QualityCheckError('ASSET_BINDING_CONFLICT', '导出快照的帧数无效')
  }
  const dimensions = expectedDimensions(record)
  return {
    container: 'mp4',
    durationSeconds: frameCount / 24,
    frameCount,
    videoCodec: 'h264',
    ...dimensions,
    pixelFormat: 'yuv420p',
    frameRate: 24,
    audioCodec: 'aac',
    audioSampleRate: 48_000,
    audioChannels: 2,
  }
}

function validateExportAsset(record: ExportRecord, asset: MediaAssetRecord | undefined): MediaAssetRecord {
  if (record.status !== 'succeeded' || !record.outputAssetId) {
    throw new QualityCheckError('EXPORT_NOT_READY', '导出尚未成功生成可质检的成片')
  }
  if (!asset || asset.id !== record.outputAssetId) {
    throw new QualityCheckError('ASSET_NOT_READY', '导出成片资产不存在')
  }
  if (asset.projectId !== record.projectId || asset.episodeId !== record.episodeId) {
    throw new QualityCheckError('ASSET_PROJECT_MISMATCH', '导出成片资产不属于当前分集')
  }
  if (asset.status !== 'ready'
    || asset.kind !== 'export.video'
    || asset.mimeType !== 'video/mp4'
    || !asset.filePath
    || !asset.checksum
    || !/^[a-f0-9]{64}$/.test(asset.checksum)) {
    throw new QualityCheckError('ASSET_NOT_READY', '导出成片资产尚未达到质检条件')
  }
  if (asset.sourceRevisionId !== record.timelineSnapshot.storyRevisionId
    || asset.generationParameters.timelineRevisionId !== record.timelineRevisionId
    || asset.generationParameters.storyRevisionId !== record.timelineSnapshot.storyRevisionId) {
    throw new QualityCheckError('ASSET_BINDING_CONFLICT', '成片资产与导出的不可变修订绑定不一致')
  }
  return asset
}

function initialDocument(record: ExportRecord, asset: MediaAssetRecord): QualityReportDocument {
  return {
    version: QUALITY_REPORT_VERSION,
    binding: {
      version: 1,
      exportId: record.id,
      outputAssetId: asset.id,
      outputAssetChecksum: asset.checksum!,
      timelineRevisionId: record.timelineRevisionId,
      storyRevisionId: record.timelineSnapshot.storyRevisionId,
      exportSpecification: structuredClone(record.specification) as unknown as JsonObject,
      expected: expectedSpecification(record),
    },
    policy: structuredClone(DEFAULT_QUALITY_POLICY),
    checks: [],
    metrics: {},
    summary: { passed: null, failedChecks: 0, warningChecks: 0 },
  }
}

function bindingMatches(left: QualityReportBinding, right: QualityReportBinding): boolean {
  return left.exportId === right.exportId
    && left.outputAssetId === right.outputAssetId
    && left.outputAssetChecksum === right.outputAssetChecksum
    && left.timelineRevisionId === right.timelineRevisionId
    && left.storyRevisionId === right.storyRevisionId
    && JSON.stringify(left.exportSpecification) === JSON.stringify(right.exportSpecification)
    && JSON.stringify(left.expected) === JSON.stringify(right.expected)
}

function hasPublishedAnalysis(report: QualityReportRecord): boolean {
  return typeof report.document.summary?.passed === 'boolean'
}

export interface CreateQualityCheckInput {
  exportId: string
  idempotencyKey: string
  /** Optional orchestration parent for the durable QC child job. */
  pipelineRunId?: string
}

export interface CreateQualityCheckResult {
  created: boolean
  report: QualityReportRecord
  job: GenerationJobRecord
}

export interface QualityDownloadAuthorization {
  export: ExportRecord
  asset: MediaAssetRecord
  report: QualityReportRecord
}

export type QualityCheckJobInput = JsonObject & {
  qualityReportId: string
  exportId: string
  outputAssetId: string
  outputAssetChecksum: string
  /** Present on newly-created jobs; optional only for legacy persisted jobs. */
  timelineRevisionId?: string
  storyRevisionId?: string
}

export interface QualityCheckJobOutput extends JsonObject {
  qualityReportId: string
  exportId: string
  outputAssetId: string
  passed: boolean
}

interface DurableQualityJobBinding {
  projectId: string
  episodeId: string | null
  input: QualityCheckJobInput
}

export interface QualityCheckServiceOptions {
  now?: () => string
  idFactory?: () => string
}

export class QualityCheckService {
  private readonly now: () => string
  private readonly idFactory: () => string

  constructor(
    private readonly database: ManjuDatabase,
    private readonly exports: ExportRenderService,
    options: QualityCheckServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
  }

  create(inputValue: CreateQualityCheckInput): CreateQualityCheckResult {
    const exportId = requiredString(inputValue.exportId, 'exportId')
    const idempotencyKey = requiredString(inputValue.idempotencyKey, 'Idempotency-Key')
    const pipelineRunId = inputValue.pipelineRunId === undefined
      ? undefined
      : requiredString(inputValue.pipelineRunId, 'pipelineRunId')
    return this.database.transaction(() => {
      const record = this.exports.require(exportId)
      if (pipelineRunId) {
        const pipelineRun = this.database.getPipelineRun(pipelineRunId)
        if (!pipelineRun) {
          throw new QualityCheckError('PIPELINE_RUN_NOT_FOUND', 'Pipeline Run 不存在')
        }
        if (pipelineRun.projectId !== record.projectId
          || pipelineRun.episodeId !== record.episodeId) {
          throw new QualityCheckError(
            'PIPELINE_RUN_MISMATCH',
            'Pipeline Run 不属于当前导出的项目和分集',
          )
        }
      }
      const existingJob = this.database.findGenerationJobByIdempotencyKey(
        record.projectId,
        idempotencyKey,
      )
      if (existingJob) {
        const reportId = existingJob.type === QUALITY_CHECK_JOB_TYPE
          && typeof existingJob.input.qualityReportId === 'string'
          ? existingJob.input.qualityReportId
          : null
        const report = reportId ? this.get(reportId) : undefined
        if (!report
          || report.exportId !== exportId
          || existingJob.pipelineRunId !== (pipelineRunId ?? null)) {
          throw new QualityCheckError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key 已用于另一个不同的任务',
          )
        }
        return { created: false, report, job: existingJob }
      }

      const asset = validateExportAsset(record, this.database.getMediaAsset(record.outputAssetId!))
      const document = initialDocument(record, asset)
      const reportId = this.idFactory()
      const jobId = this.idFactory()
      const now = this.now()
      this.database.withSql((sql) => sql.run(`
        INSERT INTO quality_reports (
          id, project_id, episode_id, export_id, status, checks_json,
          passed, created_at, completed_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, NULL)
      `,
      reportId,
      record.projectId,
      record.episodeId,
      record.id,
      JSON.stringify(document),
      now))
      const job = this.database.createGenerationJob({
        id: jobId,
        projectId: record.projectId,
        episodeId: record.episodeId,
        pipelineRunId: pipelineRunId ?? null,
        type: QUALITY_CHECK_JOB_TYPE,
        status: 'queued',
        resourceType: 'quality.report',
        resourceId: reportId,
        idempotencyKey,
        input: {
          qualityReportId: reportId,
          exportId: record.id,
          outputAssetId: asset.id,
          outputAssetChecksum: asset.checksum!,
          timelineRevisionId: document.binding.timelineRevisionId,
          storyRevisionId: document.binding.storyRevisionId,
        },
      })
      return { created: true, report: this.require(reportId), job }
    })
  }

  get(id: string): QualityReportRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(
      'SELECT * FROM quality_reports WHERE id = ?',
      id,
    ))
    return row ? asQualityReport(row) : undefined
  }

  require(id: string): QualityReportRecord {
    const record = this.get(id)
    if (!record) {
      throw new QualityCheckError('QUALITY_REPORT_NOT_FOUND', '质检报告不存在')
    }
    return record
  }

  jobForReport(reportId: string): GenerationJobRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(`
      SELECT id FROM generation_jobs
       WHERE type = ? AND resource_id = ?
       ORDER BY attempt DESC, created_at DESC, id DESC LIMIT 1
    `, QUALITY_CHECK_JOB_TYPE, reportId))
    return typeof row?.id === 'string' ? this.database.getGenerationJob(row.id) : undefined
  }

  /**
   * Authorizes release of an export from durable server state only.
   *
   * The caller never supplies a quality-report ID. We deliberately select the
   * newest report for the export, then recompute the immutable binding from the
   * current export and output asset. A prior passing report therefore cannot
   * release a replacement output, nor can it be used after a newer check has
   * started, failed, or become stale.
   */
  requireDownloadAuthorization(exportIdValue: string): QualityDownloadAuthorization {
    const exportId = requiredString(exportIdValue, 'exportId')
    const exported = this.exports.require(exportId)
    const asset = validateExportAsset(
      exported,
      exported.outputAssetId ? this.database.getMediaAsset(exported.outputAssetId) : undefined,
    )
    const row = this.database.withSql((sql) => sql.get(`
      SELECT * FROM quality_reports
       WHERE export_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1
    `, exported.id))
    if (!row) {
      throw new QualityCheckError(
        'QUALITY_CHECK_REQUIRED',
        '成片尚无质检报告，完成并通过最新质检后才能下载',
      )
    }

    const report = asQualityReport(row)
    if (report.projectId !== exported.projectId
      || report.episodeId !== exported.episodeId
      || report.exportId !== exported.id) {
      throw new QualityCheckError(
        'ASSET_BINDING_CONFLICT',
        '最新质检报告不属于当前导出',
      )
    }
    const currentBinding = initialDocument(exported, asset).binding
    if (!bindingMatches(report.document.binding, currentBinding)) {
      throw new QualityCheckError(
        'ASSET_BINDING_CONFLICT',
        '最新质检报告与当前成片校验和或不可变修订不一致',
      )
    }
    if (report.status === 'stale') {
      throw new QualityCheckError(
        'QUALITY_REPORT_STALE',
        '最新质检报告已过期，请重新质检当前成片',
      )
    }
    if (report.status === 'queued' || report.status === 'running') {
      throw new QualityCheckError(
        'QUALITY_CHECK_PENDING',
        '最新质检尚未完成，通过后才能下载成片',
      )
    }
    if (report.status === 'failed' || report.status === 'cancelled') {
      throw new QualityCheckError(
        'QUALITY_CHECK_FAILED',
        report.status === 'failed'
          ? '最新质检未通过，修复问题并重新质检后才能下载'
          : '最新质检已取消，请重新质检并通过后下载',
      )
    }
    if (report.status !== 'passed'
      || !report.passed
      || report.document.summary?.passed !== true
      || !report.completedAt) {
      throw new QualityCheckError(
        'QUALITY_STATE_CONFLICT',
        '最新质检报告的通过状态不完整，拒绝下载',
      )
    }
    return { export: exported, asset, report }
  }

  /** Revalidates every mutable pointer against the report's frozen binding. */
  requireExecutable(
    record: QualityReportRecord,
    job: DurableQualityJobBinding,
  ): { asset: MediaAssetRecord; exportRecord: ExportRecord } {
    if (record.status === 'stale') {
      throw new QualityCheckError('QUALITY_REPORT_STALE', '质检报告绑定的制作内容已过期')
    }
    if (record.projectId !== job.projectId
      || record.episodeId !== job.episodeId
      || record.id !== job.input.qualityReportId
      || record.exportId !== job.input.exportId) {
      throw new QualityCheckError('ASSET_BINDING_CONFLICT', '质检 Job 与报告绑定不一致')
    }
    const binding = record.document.binding
    if (binding.outputAssetId !== job.input.outputAssetId
      || binding.outputAssetChecksum !== job.input.outputAssetChecksum
      || (job.input.timelineRevisionId !== undefined
        && binding.timelineRevisionId !== job.input.timelineRevisionId)
      || (job.input.storyRevisionId !== undefined
        && binding.storyRevisionId !== job.input.storyRevisionId)) {
      throw new QualityCheckError('ASSET_BINDING_CONFLICT', '质检 Job 的资产绑定已被篡改')
    }
    const exported = this.exports.require(record.exportId)
    const asset = validateExportAsset(exported, this.database.getMediaAsset(binding.outputAssetId))
    const currentBinding = initialDocument(exported, asset).binding
    if (!bindingMatches(binding, currentBinding)) {
      throw new QualityCheckError('ASSET_BINDING_CONFLICT', '质检报告的不可变导出/资产绑定不一致')
    }
    return { asset, exportRecord: exported }
  }

  complete(reportId: string, result: QualityAnalysisResult): QualityReportRecord {
    return this.database.transaction(() => {
      const report = this.require(reportId)
      if (report.status === 'stale') {
        throw new QualityCheckError('QUALITY_REPORT_STALE', '质检期间制作内容已变更，结果已过期')
      }
      if (hasPublishedAnalysis(report) && report.completedAt) {
        return report
      }
      const failedChecks = result.checks.filter((check) => check.status === 'failed').length
      const warningChecks = result.checks.filter((check) => check.status === 'warning').length
      if (result.passed !== (failedChecks === 0)) {
        throw new QualityCheckError('QUALITY_STATE_CONFLICT', '质检汇总与检查项不一致')
      }
      const document: QualityReportDocument = {
        ...report.document,
        checks: structuredClone(result.checks),
        metrics: structuredClone(result.metrics),
        summary: { passed: result.passed, failedChecks, warningChecks },
      }
      const status: QualityReportStatus = result.passed ? 'passed' : 'failed'
      const completedAt = this.now()
      const changed = this.database.withSql((sql) => sql.run(`
        UPDATE quality_reports
           SET status = ?, checks_json = ?, passed = ?, completed_at = ?
         WHERE id = ? AND status NOT IN ('cancelled', 'stale')
      `, status, JSON.stringify(document), result.passed ? 1 : 0, completedAt, report.id).changes)
      if (changed !== 1) {
        throw new QualityCheckError('QUALITY_STATE_CONFLICT', '质检任务已终止，拒绝迟到结果')
      }
      return this.require(report.id)
    })
  }

  syncJob(job: GenerationJobRecord): QualityReportRecord | undefined {
    if (job.type !== QUALITY_CHECK_JOB_TYPE || !job.resourceId) return undefined
    const report = this.get(job.resourceId)
    if (!report || report.status === 'stale') return report
    // complete() is the authoritative, atomic report publication. Progress or
    // recovery events can arrive in the small window before JobWorker marks
    // the durable job succeeded; they must not demote a published result.
    if (hasPublishedAnalysis(report)) {
      return report
    }
    const nextStatus: QualityReportStatus = job.status === 'waiting_provider'
      ? 'running'
      : job.status === 'succeeded'
        ? 'failed'
        : job.status
    const terminal = nextStatus === 'failed' || nextStatus === 'cancelled'
    this.database.withSql((sql) => sql.run(`
      UPDATE quality_reports
         SET status = ?, passed = 0, completed_at = ?
       WHERE id = ? AND status <> 'stale'
    `, nextStatus, terminal ? job.completedAt ?? this.now() : null, report.id))
    return this.require(report.id)
  }
}

function parseRate(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN
  const [numeratorValue, denominatorValue = '1'] = value.split('/', 2)
  const numerator = Number(numeratorValue)
  const denominator = Number(denominatorValue)
  return denominator === 0 ? Number.NaN : numerator / denominator
}

function parseFinite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function rounded(value: number): number {
  return Number(value.toFixed(6))
}

function check(
  id: QualityCheckResult['id'],
  status: QualityCheckStatus,
  message: string,
  metrics: JsonObject = {},
): QualityCheckResult {
  return {
    id,
    status,
    severity: status === 'failed' ? 'error' : status === 'warning' ? 'warning' : 'info',
    message,
    metrics,
  }
}

const MAX_SUBTITLE_QC_CUES = 10_000
const MAX_SUBTITLE_QC_TEXT_CODE_UNITS = 100_000
const MAX_SUBTITLE_QC_VIOLATION_SAMPLES = 32
const MAX_SUBTITLE_QC_DIMENSION = 16_384
const MAX_SUBTITLE_QC_FRAMES = 24 * 60 * 60 * 6
const SUBTITLE_MAX_LINES = 2
const SUBTITLE_MAX_READING_CHARACTERS_PER_SECOND = 20

interface ParsedSubtitleCue {
  index: number
  id: string
  startFrame: number
  endFrame: number
  durationFrames: number
  text: string
}

interface SubtitleQcLayout {
  width: number
  height: number
  frameCount: number
  fontSizePixels: number
  marginXPixels: number
  marginYPixels: number
  outlinePixels: number
  safeWidthPixels: number
}

function boundedSubtitleViolation(
  samples: JsonObject[],
  value: JsonObject,
): void {
  if (samples.length < MAX_SUBTITLE_QC_VIOLATION_SAMPLES) samples.push(value)
}

function subtitleRejectedChecks(
  message: string,
  metrics: JsonObject,
): [QualityCheckResult, QualityCheckResult] {
  return [
    check('subtitle.timing', 'failed', message, structuredClone(metrics)),
    check('subtitle.safe-area', 'failed', message, structuredClone(metrics)),
  ]
}

function subtitleLayout(
  expected: Pick<QualityExpectedSpecification, 'width' | 'height' | 'frameCount' | 'frameRate'>,
): SubtitleQcLayout | null {
  if (!Number.isSafeInteger(expected.width)
    || expected.width < 1
    || expected.width > MAX_SUBTITLE_QC_DIMENSION
    || !Number.isSafeInteger(expected.height)
    || expected.height < 1
    || expected.height > MAX_SUBTITLE_QC_DIMENSION
    || !Number.isSafeInteger(expected.frameCount)
    || expected.frameCount < 1
    || expected.frameCount > MAX_SUBTITLE_QC_FRAMES
    || expected.frameRate !== 24) return null

  const shortEdge = Math.min(expected.width, expected.height)
  // These ratios mirror export-render.ts subtitlesAsAss(): the ASS play
  // resolution uses 6% horizontal / 7% vertical margins and a subtitle font
  // equal to 4.8% of the short edge. Applying the ratios to the final expected
  // dimensions preserves the same layout after libass scaling.
  const marginXPixels = Math.round(expected.width * 0.06)
  const marginYPixels = Math.round(expected.height * 0.07)
  const fontSizePixels = Math.max(1, Math.round(shortEdge * 0.048))
  const outlinePixels = Math.max(1, Math.round(shortEdge * (3 / 1_080)))
  const safeWidthPixels = expected.width - (2 * marginXPixels)
  if (safeWidthPixels < 1) return null
  return {
    width: expected.width,
    height: expected.height,
    frameCount: expected.frameCount,
    fontSizePixels,
    marginXPixels,
    marginYPixels,
    outlinePixels,
    safeWidthPixels,
  }
}

function subtitleReadableCharacters(value: string): number {
  let count = 0
  for (const character of value) {
    if (!/\s/u.test(character)) count += 1
  }
  return count
}

function estimatedSubtitleLineWidth(value: string, layout: SubtitleQcLayout): number {
  let ems = 0
  for (const character of value) {
    // The renderer uses a generic bold sans-serif fallback. Treat every
    // visible code point as a full em (and whitespace as half an em) so the
    // estimate is deliberately conservative across CJK, Latin and emoji
    // fallback fonts. Combining/format marks do not add an advance width.
    if (/\p{Mark}|\u200d|\ufe0e|\ufe0f/u.test(character)) continue
    ems += /\s/u.test(character) ? 0.5 : 1
  }
  return Math.ceil((ems * layout.fontSizePixels) + (2 * layout.outlinePixels))
}

/**
 * Deterministically checks only the immutable subtitle cues pinned by an
 * ExportRecord. No mutable Story/timeline state or rendered pixels are read.
 */
export function analyzeSubtitleQuality(
  cuesValue: unknown,
  expected: Pick<QualityExpectedSpecification, 'width' | 'height' | 'frameCount' | 'frameRate'>,
): [QualityCheckResult, QualityCheckResult] {
  const layout = subtitleLayout(expected)
  if (!layout) {
    return subtitleRejectedChecks('字幕质检绑定的成片规格无效，拒绝发布', {
      reason: 'invalid-expected-specification',
    })
  }
  if (!Array.isArray(cuesValue)) {
    return subtitleRejectedChecks('导出快照的字幕数据无效，拒绝发布', {
      reason: 'invalid-subtitle-cues',
    })
  }
  if (cuesValue.length === 0) {
    const metrics: JsonObject = { cueCount: 0 }
    return [
      check('subtitle.timing', 'skipped', '导出快照未包含烧录字幕，已跳过字幕时序检查', metrics),
      check('subtitle.safe-area', 'skipped', '导出快照未包含烧录字幕，已跳过字幕安全区检查', metrics),
    ]
  }
  if (cuesValue.length > MAX_SUBTITLE_QC_CUES) {
    return subtitleRejectedChecks('导出快照的字幕数量超过质检上限，拒绝发布', {
      reason: 'cue-count-limit',
      cueCount: MAX_SUBTITLE_QC_CUES + 1,
      maximumCueCount: MAX_SUBTITLE_QC_CUES,
    })
  }

  const timingViolations: JsonObject[] = []
  const safeAreaViolations: JsonObject[] = []
  const parsedForTiming: ParsedSubtitleCue[] = []
  const seenIds = new Set<string>()
  let totalTextCodeUnits = 0
  let invalidTimingCueCount = 0
  let outOfBoundsCueCount = 0
  let invalidSafeAreaCueCount = 0
  let lineLimitViolationCount = 0
  let widthViolationCount = 0
  let maximumEstimatedLineWidthPixels = 0

  for (const [index, rawCue] of cuesValue.entries()) {
    if (!isPlainObject(rawCue)) {
      invalidTimingCueCount += 1
      invalidSafeAreaCueCount += 1
      boundedSubtitleViolation(timingViolations, { index, code: 'invalid-cue' })
      boundedSubtitleViolation(safeAreaViolations, { index, code: 'invalid-cue' })
      continue
    }
    const id = typeof rawCue.id === 'string' ? rawCue.id.trim() : ''
    const text = typeof rawCue.text === 'string' ? rawCue.text : null
    const validId = Boolean(id)
      && id.length <= 200
      && !/[\u0000-\u001f\u007f]/.test(id)
      && !seenIds.has(id)
    if (validId) seenIds.add(id)
    const validText = text !== null
      && Boolean(text.trim())
      && text.length <= 10_000
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
    if (text !== null) totalTextCodeUnits += text.length
    if (totalTextCodeUnits > MAX_SUBTITLE_QC_TEXT_CODE_UNITS) {
      return subtitleRejectedChecks('导出快照的字幕文本总量超过质检上限，拒绝发布', {
        reason: 'text-size-limit',
        cueCount: cuesValue.length,
        maximumTextCodeUnits: MAX_SUBTITLE_QC_TEXT_CODE_UNITS,
      })
    }

    const startFrame = rawCue.startFrame
    const durationFrames = rawCue.durationFrames
    const validFrameValues = Number.isSafeInteger(startFrame)
      && Number.isSafeInteger(durationFrames)
      && Number(startFrame) >= 0
      && Number(durationFrames) > 0
    const endFrame = validFrameValues ? Number(startFrame) + Number(durationFrames) : Number.NaN
    const inBounds = validFrameValues
      && Number.isSafeInteger(endFrame)
      && endFrame <= layout.frameCount
    if (!validId || !validText || !validFrameValues) {
      invalidTimingCueCount += 1
      boundedSubtitleViolation(timingViolations, {
        index,
        code: !validId ? 'invalid-id' : !validText ? 'invalid-text' : 'invalid-frame-range',
      })
    } else if (!inBounds) {
      outOfBoundsCueCount += 1
      boundedSubtitleViolation(timingViolations, { index, code: 'out-of-bounds' })
    } else {
      parsedForTiming.push({
        index,
        id,
        startFrame: Number(startFrame),
        durationFrames: Number(durationFrames),
        endFrame,
        text,
      })
    }

    if (!validId || !validText) {
      invalidSafeAreaCueCount += 1
      boundedSubtitleViolation(safeAreaViolations, {
        index,
        code: !validId ? 'invalid-id' : 'invalid-text',
      })
      continue
    }
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines.length > SUBTITLE_MAX_LINES) {
      lineLimitViolationCount += 1
      boundedSubtitleViolation(safeAreaViolations, {
        index,
        code: 'too-many-lines',
        lineCount: Math.min(lines.length, SUBTITLE_MAX_LINES + 1),
      })
    }
    let cueMaximumWidth = 0
    for (const line of lines.slice(0, SUBTITLE_MAX_LINES + 1)) {
      cueMaximumWidth = Math.max(cueMaximumWidth, estimatedSubtitleLineWidth(line, layout))
    }
    maximumEstimatedLineWidthPixels = Math.max(maximumEstimatedLineWidthPixels, cueMaximumWidth)
    if (cueMaximumWidth > layout.safeWidthPixels) {
      widthViolationCount += 1
      boundedSubtitleViolation(safeAreaViolations, {
        index,
        code: 'estimated-width-exceeded',
        estimatedWidthPixels: Math.min(cueMaximumWidth, MAX_SUBTITLE_QC_DIMENSION * 10_000),
      })
    }
  }

  parsedForTiming.sort((left, right) => (
    left.startFrame - right.startFrame
    || left.endFrame - right.endFrame
    || left.index - right.index
  ))
  let overlapCueCount = 0
  let active: ParsedSubtitleCue | null = null
  for (const cue of parsedForTiming) {
    if (active && cue.startFrame < active.endFrame) {
      overlapCueCount += 1
      boundedSubtitleViolation(timingViolations, {
        index: cue.index,
        code: 'overlap',
        overlapsIndex: active.index,
      })
      if (cue.endFrame > active.endFrame) active = cue
    } else {
      active = cue
    }
  }

  let fastReadingCueCount = 0
  let maximumCharactersPerSecond = 0
  for (const cue of parsedForTiming) {
    const charactersPerSecond = subtitleReadableCharacters(cue.text)
      / (cue.durationFrames / 24)
    maximumCharactersPerSecond = Math.max(maximumCharactersPerSecond, charactersPerSecond)
    if (charactersPerSecond > SUBTITLE_MAX_READING_CHARACTERS_PER_SECOND) {
      fastReadingCueCount += 1
      boundedSubtitleViolation(timingViolations, {
        index: cue.index,
        code: 'fast-reading',
        charactersPerSecond: rounded(charactersPerSecond),
      })
    }
  }

  const timingFailureCount = invalidTimingCueCount + outOfBoundsCueCount + overlapCueCount
  const timingStatus: QualityCheckStatus = timingFailureCount > 0
    ? 'failed'
    : fastReadingCueCount > 0 ? 'warning' : 'passed'
  const timingViolationCount = timingFailureCount + fastReadingCueCount
  const timing = check(
    'subtitle.timing',
    timingStatus,
    timingStatus === 'failed'
      ? '字幕存在非法、越界或重叠时序，拒绝发布'
      : timingStatus === 'warning'
        ? '字幕时序有效，但部分字幕阅读速度过快'
        : '字幕时序均在成片范围内且互不重叠',
    {
      cueCount: cuesValue.length,
      frameCount: layout.frameCount,
      invalidCueCount: invalidTimingCueCount,
      outOfBoundsCueCount,
      overlapCueCount,
      fastReadingCueCount,
      readingSpeedLimitCharactersPerSecond: SUBTITLE_MAX_READING_CHARACTERS_PER_SECOND,
      maximumCharactersPerSecond: rounded(maximumCharactersPerSecond),
      violationSample: timingViolations as unknown as JsonValue,
      omittedViolationCount: Math.max(0, timingViolationCount - timingViolations.length),
    },
  )

  const safeAreaFailureCount = invalidSafeAreaCueCount
    + lineLimitViolationCount
    + widthViolationCount
  const safeArea = check(
    'subtitle.safe-area',
    safeAreaFailureCount > 0 ? 'failed' : 'passed',
    safeAreaFailureCount > 0
      ? '字幕行数或保守估算宽度超出正式 ASS 安全区，拒绝发布'
      : '字幕行数和保守估算宽度均在正式 ASS 安全区内',
    {
      cueCount: cuesValue.length,
      width: layout.width,
      height: layout.height,
      fontSizePixels: layout.fontSizePixels,
      marginXPixels: layout.marginXPixels,
      marginYPixels: layout.marginYPixels,
      outlinePixels: layout.outlinePixels,
      safeWidthPixels: layout.safeWidthPixels,
      maximumLines: SUBTITLE_MAX_LINES,
      invalidCueCount: invalidSafeAreaCueCount,
      lineLimitViolationCount,
      widthViolationCount,
      maximumEstimatedLineWidthPixels: Math.min(
        maximumEstimatedLineWidthPixels,
        MAX_SUBTITLE_QC_DIMENSION * 10_000,
      ),
      violationSample: safeAreaViolations as unknown as JsonValue,
      omittedViolationCount: Math.max(0, safeAreaFailureCount - safeAreaViolations.length),
    },
  )
  return [timing, safeArea]
}

function skippedChecks(reason: string): QualityCheckResult[] {
  return [
    check('video.black-frames', 'skipped', reason),
    check('audio.silence', 'skipped', reason),
    check('audio.peak', 'skipped', reason),
  ]
}

function invalidProbeResult(expected: QualityExpectedSpecification, reason: string): QualityAnalysisResult {
  const checks = [
    check('decodable', 'failed', reason),
    check('ffprobe.specification', 'failed', '无法验证容器、视频流和音频流规格'),
    ...skippedChecks('媒体不可解码，已跳过内容检测'),
  ]
  return {
    passed: false,
    checks,
    metrics: { expected: structuredClone(expected) as unknown as JsonValue },
  }
}

function parseBlackIntervals(stderr: string, durationSeconds: number): DetectedInterval[] {
  const intervals: DetectedInterval[] = []
  const expression = /black_start:\s*(-?\d+(?:\.\d+)?)\s+black_end:\s*(-?\d+(?:\.\d+)?)\s+black_duration:\s*(\d+(?:\.\d+)?)/g
  for (const match of stderr.matchAll(expression)) {
    const start = Math.max(0, Number(match[1]))
    const end = Math.min(durationSeconds, Number(match[2]))
    const reportedDuration = Number(match[3])
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(reportedDuration) || end <= start) continue
    intervals.push({
      startSeconds: rounded(start),
      endSeconds: rounded(end),
      durationSeconds: rounded(Math.min(reportedDuration, end - start)),
    })
  }
  return intervals
}

function parseSilenceIntervals(stderr: string, durationSeconds: number): DetectedInterval[] {
  const events: Array<{ index: number; type: 'start' | 'end'; value: number; duration?: number }> = []
  for (const match of stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)) {
    events.push({ index: match.index ?? 0, type: 'start', value: Number(match[1]) })
  }
  for (const match of stderr.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)/g)) {
    events.push({
      index: match.index ?? 0,
      type: 'end',
      value: Number(match[1]),
      duration: Number(match[2]),
    })
  }
  events.sort((left, right) => left.index - right.index)
  const intervals: DetectedInterval[] = []
  let activeStart: number | null = null
  for (const event of events) {
    if (event.type === 'start') {
      activeStart = Math.max(0, event.value)
      continue
    }
    if (activeStart === null) continue
    const end = Math.min(durationSeconds, event.value)
    if (Number.isFinite(end) && end > activeStart) {
      intervals.push({
        startSeconds: rounded(activeStart),
        endSeconds: rounded(end),
        durationSeconds: rounded(Math.min(event.duration ?? end - activeStart, end - activeStart)),
      })
    }
    activeStart = null
  }
  if (activeStart !== null && activeStart < durationSeconds) {
    intervals.push({
      startSeconds: rounded(activeStart),
      endSeconds: rounded(durationSeconds),
      durationSeconds: rounded(durationSeconds - activeStart),
    })
  }
  return intervals
}

function intervalMetrics(intervals: DetectedInterval[], durationSeconds: number): JsonObject {
  const totalSeconds = intervals.reduce((total, interval) => total + interval.durationSeconds, 0)
  const longestSeconds = intervals.reduce(
    (longest, interval) => Math.max(longest, interval.durationSeconds),
    0,
  )
  return {
    count: intervals.length,
    totalSeconds: rounded(totalSeconds),
    longestSeconds: rounded(longestSeconds),
    ratio: durationSeconds > 0 ? rounded(Math.min(1, totalSeconds / durationSeconds)) : 0,
    intervals: intervals.map((interval) => ({ ...interval })) as unknown as JsonValue,
  }
}

function peakDbfs(stderr: string): number | null {
  const matches = [...stderr.matchAll(/max_volume:\s*(-?\d+(?:\.\d+)?|-inf)\s*dB/gi)]
  const raw = matches.at(-1)?.[1]
  if (!raw || raw.toLowerCase() === '-inf') return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function processFailed(result: ProcessRunResult): boolean {
  return result.exitCode !== 0
}

async function safeInputPath(path: string): Promise<void> {
  if (!path || path.includes('\0') || !isAbsolute(path) || resolve(path) !== path) {
    throw new QualityAnalysisError('UNSAFE_INPUT_PATH', '质检输入必须是服务端解析的绝对路径')
  }
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > MAX_QC_MEDIA_BYTES) {
      throw new QualityAnalysisError('UNSAFE_INPUT_PATH', '质检输入必须是大小受限的普通文件')
    }
    if (await realpath(path) !== path) {
      throw new QualityAnalysisError('UNSAFE_INPUT_PATH', '质检输入路径不能经过符号链接')
    }
  } catch (error) {
    if (error instanceof QualityAnalysisError) throw error
    throw new QualityAnalysisError('UNSAFE_INPUT_PATH', '质检输入文件不存在', { cause: error })
  }
}

function analysisError(error: unknown): never {
  if (error instanceof QualityAnalysisError) throw error
  if (error instanceof FfmpegRenderError) {
    const supported = new Set<QualityAnalysisErrorCode>([
      'CANCELLED',
      'PROCESS_OUTPUT_LIMIT',
      'PROCESS_SPAWN_FAILED',
      'TIMEOUT',
    ])
    const code: QualityAnalysisErrorCode = supported.has(error.code as QualityAnalysisErrorCode)
      ? error.code as QualityAnalysisErrorCode
      : 'PROCESS_SPAWN_FAILED'
    throw new QualityAnalysisError(code, error.message, { cause: error })
  }
  throw error
}

export interface FfmpegQualityAnalyzerOptions {
  ffmpegPath?: string | null
  ffprobePath?: string | null
  runner?: RenderProcessRunner
  processTimeoutMs?: number
}

export class FfmpegQualityAnalyzer implements QualityAnalyzerPort {
  private readonly ffmpegPath: string | null
  private readonly ffprobePath: string | null
  private readonly runner: RenderProcessRunner
  private readonly processTimeoutMs: number

  constructor(options: FfmpegQualityAnalyzerOptions = {}) {
    this.ffmpegPath = options.ffmpegPath === undefined ? bundledFfmpegPath() : options.ffmpegPath
    this.ffprobePath = options.ffprobePath === undefined ? bundledFfprobePath() : options.ffprobePath
    this.runner = options.runner ?? new SpawnProcessRunner()
    this.processTimeoutMs = options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
  }

  async analyze(request: QualityAnalysisRequest): Promise<QualityAnalysisResult> {
    request.signal?.throwIfAborted()
    if (!this.ffmpegPath || !this.ffprobePath) {
      throw new QualityAnalysisError('BINARY_UNAVAILABLE', '当前平台没有可用的 FFmpeg/ffprobe 固定二进制')
    }
    await safeInputPath(request.inputPath)
    const cwd = resolve(request.inputPath, '..')
    let probeResult: ProcessRunResult
    try {
      probeResult = await this.runner.run({
        command: this.ffprobePath,
        args: [
          '-v', 'error',
          '-show_entries',
          'format=format_name,duration,size:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,sample_rate,channels,nb_frames',
          '-of', 'json',
          request.inputPath,
        ],
        cwd,
        signal: request.signal,
        timeoutMs: this.processTimeoutMs,
        maxStdoutBytes: MAX_STDOUT_BYTES,
        maxStderrBytes: MAX_STDERR_BYTES,
      })
    } catch (error) {
      analysisError(error)
    }
    if (processFailed(probeResult)) {
      return invalidProbeResult(request.expected, 'ffprobe 无法解析成片，媒体不可解码')
    }

    let probe: RawProbeDocument
    try {
      probe = JSON.parse(probeResult.stdout.toString('utf8')) as RawProbeDocument
    } catch {
      return invalidProbeResult(request.expected, 'ffprobe 返回的媒体信息无效')
    }
    if (!Array.isArray(probe.streams) || !isPlainObject(probe.format)) {
      return invalidProbeResult(request.expected, 'ffprobe 返回的媒体流信息不完整')
    }
    const streams = probe.streams as RawProbeStream[]
    const videos = streams.filter((stream) => stream.codec_type === 'video')
    const audios = streams.filter((stream) => stream.codec_type === 'audio')
    const video = videos[0]
    const audio = audios[0]
    const format = probe.format
    const actualDuration = parseFinite(format.duration)
    const actualFrameRate = parseRate(video?.avg_frame_rate ?? video?.r_frame_rate)
    const actualFrames = video?.nb_frames === undefined ? null : parseFinite(video.nb_frames)
    const violations: string[] = []
    const formatNames = typeof format.format_name === 'string' ? format.format_name.split(',') : []
    if (!formatNames.includes(request.expected.container)) violations.push('container')
    if (videos.length !== 1) violations.push('videoStreamCount')
    if (audios.length !== 1) violations.push('audioStreamCount')
    if (video?.codec_name !== request.expected.videoCodec) violations.push('videoCodec')
    if (video?.width !== request.expected.width || video?.height !== request.expected.height) {
      violations.push('resolution')
    }
    if (video?.pix_fmt !== request.expected.pixelFormat) violations.push('pixelFormat')
    if (!Number.isFinite(actualFrameRate)
      || Math.abs(actualFrameRate - request.expected.frameRate) > FRAME_RATE_TOLERANCE) {
      violations.push('frameRate')
    }
    if (audio?.codec_name !== request.expected.audioCodec) violations.push('audioCodec')
    if (parseFinite(audio?.sample_rate) !== request.expected.audioSampleRate) {
      violations.push('audioSampleRate')
    }
    if (audio?.channels !== request.expected.audioChannels) violations.push('audioChannels')
    if (actualDuration === null
      || Math.abs(actualDuration - request.expected.durationSeconds) > DURATION_TOLERANCE_SECONDS) {
      violations.push('duration')
    }
    if (actualFrames !== null && actualFrames !== request.expected.frameCount) violations.push('frameCount')

    const specificationMetrics: JsonObject = {
      expected: structuredClone(request.expected) as unknown as JsonValue,
      actual: {
        formatNames,
        durationSeconds: actualDuration,
        videoStreamCount: videos.length,
        audioStreamCount: audios.length,
        videoCodec: typeof video?.codec_name === 'string' ? video.codec_name : null,
        width: typeof video?.width === 'number' ? video.width : null,
        height: typeof video?.height === 'number' ? video.height : null,
        pixelFormat: typeof video?.pix_fmt === 'string' ? video.pix_fmt : null,
        frameRate: Number.isFinite(actualFrameRate) ? rounded(actualFrameRate) : null,
        frameCount: actualFrames,
        audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
        audioSampleRate: parseFinite(audio?.sample_rate),
        audioChannels: typeof audio?.channels === 'number' ? audio.channels : null,
      },
      violations,
    }
    const checks: QualityCheckResult[] = [check(
      'ffprobe.specification',
      violations.length === 0 ? 'passed' : 'failed',
      violations.length === 0 ? '成片容器与音视频规格符合导出快照' : '成片规格与导出快照不一致',
      specificationMetrics,
    )]

    let blackResult: ProcessRunResult
    try {
      blackResult = await this.runner.run({
        command: this.ffmpegPath,
        args: [
          '-hide_banner', '-nostdin', '-i', request.inputPath,
          '-map', '0:v:0', '-an',
          '-vf', `blackdetect=d=${request.policy.blackDetectMinimumSeconds}:pix_th=${request.policy.blackPixelThreshold}:pic_th=${request.policy.blackPictureRatio}`,
          '-f', 'null', '-',
        ],
        cwd,
        signal: request.signal,
        timeoutMs: this.processTimeoutMs,
        maxStdoutBytes: MAX_STDOUT_BYTES,
        maxStderrBytes: MAX_STDERR_BYTES,
      })
    } catch (error) {
      analysisError(error)
    }

    let audioResult: ProcessRunResult | null = null
    if (audios.length > 0) {
      try {
        audioResult = await this.runner.run({
          command: this.ffmpegPath,
          args: [
            '-hide_banner', '-nostdin', '-i', request.inputPath,
            '-map', '0:a:0', '-vn',
            '-af', `silencedetect=noise=${request.policy.silenceThresholdDb}dB:d=${request.policy.silenceDetectMinimumSeconds},volumedetect`,
            '-f', 'null', '-',
          ],
          cwd,
          signal: request.signal,
          timeoutMs: this.processTimeoutMs,
          maxStdoutBytes: MAX_STDOUT_BYTES,
          maxStderrBytes: MAX_STDERR_BYTES,
        })
      } catch (error) {
        analysisError(error)
      }
    }

    const decodeFailed = processFailed(blackResult) || (audioResult !== null && processFailed(audioResult))
    checks.unshift(check(
      'decodable',
      decodeFailed ? 'failed' : 'passed',
      decodeFailed ? 'FFmpeg 无法完整解码成片音视频流' : 'FFmpeg 已完整解码成片音视频流',
      {
        videoExitCode: blackResult.exitCode,
        audioExitCode: audioResult?.exitCode ?? null,
      },
    ))

    if (processFailed(blackResult)) {
      checks.push(check('video.black-frames', 'failed', '视频解码失败，无法完成黑帧检测'))
    } else {
      const blackIntervals = parseBlackIntervals(
        blackResult.stderr.toString('utf8'),
        request.expected.durationSeconds,
      )
      const metrics = intervalMetrics(blackIntervals, request.expected.durationSeconds)
      const failed = Number(metrics.ratio) > request.policy.maxBlackRatio
        || Number(metrics.longestSeconds) > request.policy.maxContinuousBlackSeconds
      const status: QualityCheckStatus = failed ? 'failed' : blackIntervals.length > 0 ? 'warning' : 'passed'
      checks.push(check(
        'video.black-frames',
        status,
        failed
          ? '黑帧占比或连续时长超过发布阈值'
          : blackIntervals.length > 0 ? '检测到少量黑帧，请人工确认是否为有意转场' : '未检测到达到阈值的黑帧',
        metrics,
      ))
    }

    if (audios.length === 0) {
      checks.push(check('audio.silence', 'failed', '成片缺少音频流，无法执行静音检测'))
      checks.push(check('audio.peak', 'failed', '成片缺少音频流，无法执行峰值检测'))
    } else if (!audioResult || processFailed(audioResult)) {
      checks.push(check('audio.silence', 'failed', '音频解码失败，无法完成静音检测'))
      checks.push(check('audio.peak', 'failed', '音频解码失败，无法完成峰值检测'))
    } else {
      const stderr = audioResult.stderr.toString('utf8')
      const silenceIntervals = parseSilenceIntervals(stderr, request.expected.durationSeconds)
      const metrics = intervalMetrics(silenceIntervals, request.expected.durationSeconds)
      const failed = Number(metrics.ratio) > request.policy.maxSilenceRatio
        || Number(metrics.longestSeconds) > request.policy.maxContinuousSilenceSeconds
      const silenceStatus: QualityCheckStatus = failed
        ? 'failed'
        : silenceIntervals.length > 0 ? 'warning' : 'passed'
      checks.push(check(
        'audio.silence',
        silenceStatus,
        failed
          ? '静音占比或连续时长超过发布阈值'
          : silenceIntervals.length > 0 ? '检测到短暂静音，请人工确认节奏' : '未检测到达到阈值的静音段',
        metrics,
      ))

      const peak = peakDbfs(stderr)
      const peakStatus: QualityCheckStatus = peak !== null && peak >= request.policy.peakFailureDbfs
        ? 'failed'
        : peak !== null && peak >= request.policy.peakWarningDbfs ? 'warning' : 'passed'
      checks.push(check(
        'audio.peak',
        peakStatus,
        peakStatus === 'failed'
          ? '音频峰值过高，存在削波风险'
          : peakStatus === 'warning' ? '音频峰值接近满刻度，请人工复核' : '音频峰值处于安全范围',
        { maxVolumeDbfs: peak },
      ))
    }

    const passed = checks.every((item) => item.status !== 'failed')
    return {
      passed,
      checks,
      metrics: {
        analyzedDurationSeconds: request.expected.durationSeconds,
        checkCount: checks.length,
      },
    }
  }
}

async function stageBoundAsset(
  mediaStore: MediaStore,
  asset: MediaAssetRecord,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const opened = await mediaStore.openAsset(asset.id)
  try {
    if (opened.asset.id !== asset.id
      || opened.asset.checksum !== asset.checksum
      || opened.mimeType !== 'video/mp4'
      || opened.size < 1
      || opened.size > MAX_QC_MEDIA_BYTES) {
      throw new QualityCheckError('ASSET_BINDING_CONFLICT', '质检资产文件与不可变索引不一致')
    }
    const digest = createHash('sha256')
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        digest.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(
      opened.file.createReadStream(),
      hasher,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      { signal },
    )
    if (digest.digest('hex') !== asset.checksum) {
      throw new QualityCheckError('ASSET_BINDING_CONFLICT', '质检资产内容校验和与不可变绑定不一致')
    }
  } finally {
    await opened.file.close().catch(() => undefined)
  }
}

function handlerError(error: unknown): Error {
  if (error instanceof JobExecutionError) return error
  if (error instanceof QualityCheckError) {
    if (error.code === 'QUALITY_REPORT_STALE') {
      return new JobCancelledError(error.message, { cause: error })
    }
    return new JobExecutionError(error.code, error.message, false, 'validation', { cause: error })
  }
  if (error instanceof QualityAnalysisError) {
    if (error.code === 'CANCELLED') return new JobCancelledError(error.message, { cause: error })
    const retryable = error.code === 'TIMEOUT' || error.code === 'PROCESS_SPAWN_FAILED'
    return new JobExecutionError(
      error.code,
      error.message,
      retryable,
      error.code === 'TIMEOUT' ? 'timeout' : 'internal',
      { cause: error },
    )
  }
  if (error instanceof MediaStoreError) {
    return new JobExecutionError(error.code, error.message, false, 'validation', { cause: error })
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new JobCancelledError('质检任务已取消', { cause: error })
  }
  return error instanceof Error ? error : new Error('Unknown quality check failure')
}

export interface CreateQualityCheckHandlerOptions {
  database: ManjuDatabase
  mediaStore: MediaStore
  qualityChecks: QualityCheckService
  runtimeDirectory: string
  analyzer?: QualityAnalyzerPort
}

export function createQualityCheckJobHandler(
  options: CreateQualityCheckHandlerOptions,
): JobHandler<QualityCheckJobInput, QualityCheckJobOutput> {
  const analyzer = options.analyzer ?? new FfmpegQualityAnalyzer()
  return async (job: JobRecord<QualityCheckJobInput>, context): Promise<QualityCheckJobOutput> => {
    try {
      const reportId = typeof job.input?.qualityReportId === 'string'
        ? job.input.qualityReportId
        : ''
      if (!reportId) {
        throw new QualityCheckError('INVALID_QUALITY_REQUEST', '质检 Job 缺少 qualityReportId')
      }
      const report = options.qualityChecks.require(reportId)
      if (hasPublishedAnalysis(report) && report.completedAt) {
        return {
          qualityReportId: report.id,
          exportId: report.exportId,
          outputAssetId: report.document.binding.outputAssetId,
          passed: report.passed,
        }
      }
      const durable = options.database.getGenerationJob(job.id)
      if (!durable || durable.type !== QUALITY_CHECK_JOB_TYPE) {
        throw new QualityCheckError('INVALID_QUALITY_REQUEST', '质检 Job 不存在')
      }
      const executable = options.qualityChecks.requireExecutable(report, {
        projectId: durable.projectId,
        episodeId: durable.episodeId,
        input: job.input,
      })
      const asset = executable.asset
      await context.reportProgress(5, { stage: 'staging-export', outputAssetId: asset.id })
      const createdDirectory = await mkdtemp(join(options.runtimeDirectory, 'quality-check-'))
      const directory = await realpath(createdDirectory)
      try {
        const inputPath = join(directory, 'input.mp4')
        await stageBoundAsset(options.mediaStore, asset, inputPath, context.signal)
        await context.reportProgress(15, { stage: 'analyzing-media' })
        const mediaResult = await analyzer.analyze({
          inputPath,
          expected: structuredClone(report.document.binding.expected),
          policy: structuredClone(report.document.policy),
          signal: context.signal,
        })
        context.signal.throwIfAborted()
        const mediaPassed = mediaResult.checks.every((item) => item.status !== 'failed')
        if (mediaResult.passed !== mediaPassed) {
          throw new QualityCheckError(
            'QUALITY_STATE_CONFLICT',
            '媒体质检汇总与检查项不一致',
          )
        }
        await context.reportProgress(88, { stage: 'analyzing-subtitles' })
        const subtitleChecks = analyzeSubtitleQuality(
          executable.exportRecord.timelineSnapshot.subtitleCues,
          report.document.binding.expected,
        )
        const checks = [...mediaResult.checks, ...subtitleChecks]
        const result: QualityAnalysisResult = {
          passed: checks.every((item) => item.status !== 'failed'),
          checks,
          metrics: {
            ...structuredClone(mediaResult.metrics),
            mediaCheckCount: mediaResult.checks.length,
            subtitleCheckCount: subtitleChecks.length,
            checkCount: checks.length,
          },
        }
        await context.reportProgress(90, { stage: 'persisting-report' })
        const completed = options.qualityChecks.complete(report.id, result)
        await context.reportProgress(98, {
          stage: 'finalizing',
          passed: completed.passed,
          failedChecks: completed.document.summary.failedChecks,
          warningChecks: completed.document.summary.warningChecks,
        })
        return {
          qualityReportId: completed.id,
          exportId: completed.exportId,
          outputAssetId: completed.document.binding.outputAssetId,
          passed: completed.passed,
        }
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (error) {
      throw handlerError(error)
    }
  }
}

export function qualityReportAsJson(
  report: QualityReportRecord,
  job: GenerationJobRecord | undefined,
): JsonObject {
  return {
    id: report.id,
    projectId: report.projectId,
    episodeId: report.episodeId,
    exportId: report.exportId,
    outputAssetId: report.document.binding.outputAssetId,
    outputAssetChecksum: report.document.binding.outputAssetChecksum,
    timelineRevisionId: report.document.binding.timelineRevisionId,
    storyRevisionId: report.document.binding.storyRevisionId,
    status: report.status,
    passed: report.document.summary.passed,
    policy: structuredClone(report.document.policy) as unknown as JsonValue,
    expected: structuredClone(report.document.binding.expected) as unknown as JsonValue,
    checks: structuredClone(report.document.checks) as unknown as JsonValue,
    metrics: structuredClone(report.document.metrics),
    summary: structuredClone(report.document.summary) as unknown as JsonValue,
    jobId: job?.id ?? null,
    jobStatus: job?.status ?? null,
    error: job?.error ?? null,
    createdAt: report.createdAt,
    completedAt: report.completedAt,
  }
}
