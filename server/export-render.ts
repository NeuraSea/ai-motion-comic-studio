import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  parseCanonicalTimelineDocument,
  type CanonicalTimelineElement,
  type CanonicalTimelineDocument,
} from '../apps/opencut-editor/src/canonical-timeline-codec.js'
import {
  classifyTimelineAssetScope,
  isTimelineElementHidden,
  isTimelineTrackHidden,
  projectTimelineMediaParticipation,
} from '../apps/opencut-editor/src/timeline-media-policy.js'
import {
  compileRenderSemanticPlan,
  RENDER_SEMANTIC_PLAN_VERSION,
  RenderSemanticPlanError,
  shortVideoFillDescriptor,
  type RenderSemanticAssetBinding,
  type RenderSemanticAudioRole,
  type RenderSemanticPlan,
} from '../apps/opencut-editor/src/render-semantic-plan.js'

import {
  type GenerationJobRecord,
  type ManjuDatabase,
  type MediaAssetRecord,
} from './database.js'
import {
  FfmpegRenderError,
  createFfmpegRenderer,
  type BurnedSubtitleTrack,
  type FfmpegRenderer,
  type FfmpegRendererRuntimeReceipt,
  type ImageFit,
  type ImmutableRenderTimelineSnapshot,
  type RenderAspectRatio,
  type RenderResolution,
} from './ffmpeg-renderer.js'
import { MediaStore, MediaStoreError } from './media.js'
import {
  currentMediaAuthority,
  timelineMediaAuthorityReceipt,
} from './media-authority.js'
import { parseStoryDocument } from './story-schema.js'
import {
  parseCanonicalSpeechSubtitleCues,
} from './speech-subtitle.js'
import type { TimelineDocumentService } from './timeline-documents.js'
import type { JsonObject, JsonValue } from './types.js'
import {
  JobCancelledError,
  JobExecutionError,
  type JobErrorCategory,
  type JobHandler,
  type JobRecord,
} from './worker.js'

export const EXPORT_RENDER_JOB_TYPE = 'export.render'
export const EXPORT_RENDER_RESOURCE_KEY = 'renderer:ffmpeg'
export const EXPORT_RENDER_SNAPSHOT_VERSION = 3 as const

const OUTPUT_FRAME_RATE = 24
const MAX_EXPORT_CLIPS = 1_000
const MAX_EXPORT_AUDIO_CLIPS = 256
const MAX_EXPORT_FRAMES = OUTPUT_FRAME_RATE * 60 * 60 * 6
const MAX_SUBTITLE_TEXT_LENGTH = 10_000
const MAX_EXPORT_OUTPUT_BYTES = 250 * 1024 * 1024
const TITLE_CARD_DURATION_FRAMES = OUTPUT_FRAME_RATE * 3
export const REVIEW_WATERMARK_TEXT = '漫剧工作台 · 审片版'

export type ExportRenderStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale'

export type ExportRenderErrorCode =
  | 'ASSET_NOT_FOUND'
  | 'ASSET_NOT_READY'
  | 'ASSET_PROJECT_MISMATCH'
  | 'EPISODE_NOT_FOUND'
  | 'EPISODE_PROJECT_MISMATCH'
  | 'EXPORT_NOT_FOUND'
  | 'EXPORT_STATE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_EXPORT_REQUEST'
  | 'INVALID_TIMELINE'
  | 'PIPELINE_RUN_MISMATCH'
  | 'PIPELINE_RUN_NOT_FOUND'
  | 'STORY_REVISION_NOT_FOUND'
  | 'TIMELINE_DOCUMENT_NOT_FOUND'
  | 'TIMELINE_MEDIA_RECONCILIATION_REQUIRED'
  | 'TIMELINE_REVISION_CONFLICT'
  | 'TIMELINE_REVISION_NOT_FOUND'
  | 'UNSUPPORTED_AUDIO_ASSET'
  | 'UNSUPPORTED_TIMELINE'
  | 'UNSUPPORTED_VISUAL_ASSET'

export class ExportRenderError extends Error {
  constructor(
    readonly code: ExportRenderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ExportRenderError'
  }
}

export interface ExportVisualClipSnapshot {
  /** Absent only for legacy image-only snapshots written before video MVP. */
  type?: 'image' | 'video'
  id: string
  startFrame: number
  durationFrames: number
  assetId: string
  fit: ImageFit
  /** Present and immutable for video clips. */
  sourceStartSeconds?: number
  /** Present and immutable for video clips. */
  sourceDurationSeconds?: number
}

export interface ExportAudioClipSnapshot {
  id: string
  startFrame: number
  durationFrames: number
  assetId: string
  sourceStartSeconds: number
  volume: number
  /**
   * Optional for snapshots created before automatic dialogue ducking. New
   * snapshots pin the role when canonical metadata or the immutable asset kind
   * can identify it, so workers never have to re-read mutable database state.
   */
  audioRole?: 'dialogue' | 'bgm' | 'sfx'
  /** Optional clip-relative fade duration pinned from canonical audio params. */
  fadeInSeconds?: number
  /** Optional clip-relative fade duration pinned from canonical audio params. */
  fadeOutSeconds?: number
}

export interface ExportSubtitleCueSnapshot {
  id: string
  startFrame: number
  durationFrames: number
  text: string
}

export interface ExportBrandingCueSnapshot {
  startFrame: number
  durationFrames: number
  text: string
}

/**
 * Export-only overlays. These cues never extend the visual timeline: title
 * overlays occupy the first/last three seconds (or the whole render when it
 * is shorter), while the review watermark spans the existing render.
 */
export interface ExportBrandingSnapshot {
  introTitle: ExportBrandingCueSnapshot | null
  outroCard: ExportBrandingCueSnapshot | null
  reviewWatermark: ExportBrandingCueSnapshot | null
}

/**
 * Durable, provider-independent export input. It intentionally stores asset
 * IDs rather than filesystem paths; the worker resolves and stages immutable
 * MediaStore files immediately before invoking FFmpeg.
 */
export interface DurableExportTimelineSnapshot {
  /** Version 1 is the legacy image-only shape and remains renderable. */
  version: 1 | 2 | typeof EXPORT_RENDER_SNAPSHOT_VERSION
  timelineDocumentId: string
  timelineRevisionId: string
  storyRevisionId: string
  ticksPerSecond: number
  frameRate: typeof OUTPUT_FRAME_RATE
  visualClips: ExportVisualClipSnapshot[]
  audioClips: ExportAudioClipSnapshot[]
  subtitleCues: ExportSubtitleCueSnapshot[]
  /**
   * Required for version 3 snapshots. This is the renderer-neutral,
   * revision/asset-pinned source of truth consumed by new workers. The
   * legacy clip arrays above remain as a stable read-model and for replaying
   * snapshots created before the shared semantic compiler existed.
   */
  semanticPlan?: RenderSemanticPlan
  /** Absent only on exports created before export-only branding was added. */
  branding?: ExportBrandingSnapshot
}

export interface ExportSpecification {
  version: 1
  resolution: RenderResolution
  aspectRatio: RenderAspectRatio
  kenBurns: boolean
  burnSubtitles: boolean
  introTitle: boolean
  outroCard: boolean
  reviewWatermark: boolean
  videoCodec: 'h264'
  pixelFormat: 'yuv420p'
  frameRate: 24
  audioCodec: 'aac'
  audioSampleRate: 48_000
  timelineRevisionId: string
  storyRevisionId: string
}

export interface ExportRecord {
  id: string
  projectId: string
  episodeId: string
  status: ExportRenderStatus
  timelineSnapshot: DurableExportTimelineSnapshot
  timelineRevisionId: string
  outputAssetId: string | null
  specification: ExportSpecification
  error: JsonObject | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface CreateExportRenderInput {
  projectId: string
  episodeId: string
  /** Explicit immutable revision. Historical revisions are allowed. */
  timelineRevisionId?: string
  /** Parsed If-Match revision. When present it must still be the document head. */
  expectedTimelineRevisionId?: string
  resolution: RenderResolution
  kenBurns?: boolean
  burnSubtitles?: boolean
  introTitle?: boolean
  outroCard?: boolean
  reviewWatermark?: boolean
  /** Optional orchestration parent; never inferred from a client key. */
  pipelineRunId?: string
  idempotencyKey: string
}

export interface CreateExportRenderResult {
  created: boolean
  export: ExportRecord
  job: GenerationJobRecord
}

export type ExportRenderJobInput = JsonObject & {
  exportId: string
  /** Present on newly-created jobs; optional only for legacy persisted jobs. */
  timelineRevisionId?: string
  /** Immutable Story authority used by Episode-scoped clients before output exists. */
  storyRevisionId?: string
}

export interface ExportRenderOutput extends JsonObject {
  exportId: string
  timelineRevisionId: string
  storyRevisionId: string
  asset: JsonObject
}

interface TimelineElement {
  id: string
  type: string
  mediaId?: string
  sourceType?: 'upload' | 'library'
  sourceUrl?: string
  startTime: number
  duration: number
  trimStart?: number
  trimEnd?: number
  sourceDuration?: number
  retimeRate?: number
  hidden?: boolean
  isSourceAudioEnabled?: boolean
  animations?: Record<string, unknown>
  effects?: Record<string, unknown>[]
  masks?: Record<string, unknown>[]
  name?: string
  params?: Record<string, unknown>
  manju?: Record<string, unknown>
}

interface TimelineTrack {
  id: string
  type: string
  elements: TimelineElement[]
  hidden?: boolean
  muted?: boolean
}

interface ParsedTracks {
  overlay: TimelineTrack[]
  main: TimelineTrack
  audio: TimelineTrack[]
}

interface TimelineRevisionRow {
  id: string
  documentId: string
  projectId: string
  episodeId: string
  sourceRevisionId: string | null
  snapshot: JsonObject
}

/**
 * Provider-free input for the renderer-neutral exportability gate.
 *
 * This deliberately accepts an in-memory candidate document so callers such
 * as Agentic auto-edit can validate a preview before it becomes an immutable
 * timeline revision. Asset identities are still resolved exclusively from
 * the trusted repository; callers cannot supply checksums, durations or media
 * roles.
 */
export interface ExportRenderSemanticValidationInput {
  projectId: string
  episodeId: string
  timelineDocumentId: string
  timelineRevisionId: string
  storyRevisionId: string
  document: JsonObject
}

interface StagedAsset {
  asset: MediaAssetRecord
  path: string
  checksum: string
  mimeType: string
}

type FfmpegRendererPort = Pick<FfmpegRenderer, 'render'> & Partial<Pick<
  FfmpegRenderer,
  'runtimeDiagnosticReceipt'
>>

const MAX_EXPORT_DIAGNOSTIC_STDERR_BYTES = 8 * 1_024
const MAX_EXPORT_DIAGNOSTIC_PINS = 32

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ExportRenderError('INVALID_EXPORT_REQUEST', `${label} 必须是字符串`)
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ExportRenderError('INVALID_EXPORT_REQUEST', `${label} 格式无效`)
  }
  return normalized
}

function parseJsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'string') throw new Error(`${label} is not JSON text`)
  const parsed: unknown = JSON.parse(value)
  if (!isPlainObject(parsed)) throw new Error(`${label} is not a JSON object`)
  return parsed as JsonObject
}

function requiredRowString(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not text`)
  return value
}

function nullableRowString(row: Record<string, unknown>, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not nullable text`)
  return value
}

function asTimelineRevisionRow(row: Record<string, unknown>): TimelineRevisionRow {
  return {
    id: requiredRowString(row, 'id'),
    documentId: requiredRowString(row, 'document_id'),
    projectId: requiredRowString(row, 'project_id'),
    episodeId: requiredRowString(row, 'episode_id'),
    sourceRevisionId: nullableRowString(row, 'source_revision_id'),
    snapshot: parseJsonObject(row.snapshot_json, 'snapshot_json'),
  }
}

function asExportRecord(row: Record<string, unknown>): ExportRecord {
  const status = requiredRowString(row, 'status') as ExportRenderStatus
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled', 'stale'].includes(status)) {
    throw new Error(`Database contains unsupported export status: ${status}`)
  }
  const snapshot = parseJsonObject(row.timeline_snapshot_json, 'timeline_snapshot_json')
  const specificationValue = parseJsonObject(row.specification_json, 'specification_json')
  const storedAspect = specificationValue.aspectRatio
  const aspectRatio = storedAspect === undefined
    ? '16:9'
    : storedAspect
  if (aspectRatio !== '16:9' && aspectRatio !== '9:16' && aspectRatio !== '1:1') {
    throw new Error('Database contains unsupported export aspect ratio')
  }
  const storedBrandingBoolean = (
    key: 'introTitle' | 'outroCard' | 'reviewWatermark',
  ): boolean => {
    const value = specificationValue[key]
    // Exports created before branding support have no such keys. They must
    // keep their original byte semantics after a restart.
    if (value === undefined) return false
    if (typeof value !== 'boolean') {
      throw new Error(`Database contains invalid export ${key} setting`)
    }
    return value
  }
  const specification = {
    ...specificationValue,
    aspectRatio,
    introTitle: storedBrandingBoolean('introTitle'),
    outroCard: storedBrandingBoolean('outroCard'),
    reviewWatermark: storedBrandingBoolean('reviewWatermark'),
  } as unknown as ExportSpecification
  return {
    id: requiredRowString(row, 'id'),
    projectId: requiredRowString(row, 'project_id'),
    episodeId: requiredRowString(row, 'episode_id'),
    status,
    timelineSnapshot: snapshot as unknown as DurableExportTimelineSnapshot,
    timelineRevisionId: requiredRowString(row, 'timeline_document_revision_id'),
    outputAssetId: nullableRowString(row, 'output_asset_id'),
    specification,
    error: row.error_json === null || row.error_json === undefined
      ? null
      : parseJsonObject(row.error_json, 'error_json'),
    createdAt: requiredRowString(row, 'created_at'),
    updatedAt: requiredRowString(row, 'updated_at'),
    completedAt: nullableRowString(row, 'completed_at'),
  }
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ExportRenderError('INVALID_TIMELINE', `${label} 必须是不小于 ${minimum} 的安全整数`)
  }
  return value as number
}

function frameForTicks(value: number, ticksPerSecond: number, label: string, minimum = 0): number {
  safeInteger(value, label, minimum)
  const numerator = value * OUTPUT_FRAME_RATE
  if (!Number.isSafeInteger(numerator) || numerator % ticksPerSecond !== 0) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      `${label} 必须对齐 ${OUTPUT_FRAME_RATE} fps 帧边界`,
    )
  }
  return numerator / ticksPerSecond
}

function exportSafeString(
  value: string,
  path: string,
  maximumLength: number,
): string {
  const normalized = value.trim()
  if (!normalized
    || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ExportRenderError('INVALID_TIMELINE', `${path} 格式无效`)
  }
  return normalized
}

/** Apply export resource limits after the shared codec owns domain parsing. */
function toExportElement(
  value: CanonicalTimelineElement,
  path: string,
): TimelineElement {
  const id = exportSafeString(value.id, `${path}.id`, 200)
  const mediaId = 'mediaId' in value
    ? exportSafeString(value.mediaId, `${path}.mediaId`, 200)
    : undefined
  const sourceUrl = 'sourceUrl' in value
    ? exportSafeString(value.sourceUrl, `${path}.sourceUrl`, 2_048)
    : undefined
  if (value.sourceDuration !== undefined) {
    safeInteger(value.sourceDuration, `${path}.sourceDuration`, 1)
  }
  const retimeRate = value.retime?.rate
  if (retimeRate !== undefined && retimeRate > 16) {
    throw new ExportRenderError('INVALID_TIMELINE', `${path}.retime 超出导出安全上限`)
  }
  return {
    id,
    type: value.type,
    ...(mediaId === undefined ? {} : { mediaId }),
    ...(value.type === 'audio' ? { sourceType: value.sourceType } : {}),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    startTime: value.startTime,
    duration: value.duration,
    trimStart: value.trimStart,
    trimEnd: value.trimEnd,
    ...(value.sourceDuration === undefined ? {} : { sourceDuration: value.sourceDuration }),
    ...(retimeRate === undefined ? {} : { retimeRate }),
    ...(value.hidden === undefined ? {} : { hidden: value.hidden }),
    ...('isSourceAudioEnabled' in value && value.isSourceAudioEnabled !== undefined
      ? { isSourceAudioEnabled: value.isSourceAudioEnabled }
      : {}),
    ...(value.animations === undefined ? {} : { animations: value.animations }),
    ...(value.effects === undefined ? {} : { effects: value.effects }),
    ...('masks' in value && value.masks !== undefined ? { masks: value.masks } : {}),
    name: value.name,
    params: value.params,
    ...(value.manju === undefined ? {} : { manju: value.manju }),
  }
}

function toExportTrack(
  value: {
    id: string
    type: string
    elements: CanonicalTimelineElement[]
    hidden?: boolean
    muted?: boolean
  },
  path: string,
): TimelineTrack {
  return {
    id: exportSafeString(value.id, `${path}.id`, 200),
    type: value.type,
    ...(value.hidden === undefined ? {} : { hidden: value.hidden }),
    ...(value.muted === undefined ? {} : { muted: value.muted }),
    elements: value.elements.map((element, index) => (
      toExportElement(element, `${path}.elements[${index}]`)
    )),
  }
}

function parseTracks(document: JsonObject): { ticksPerSecond: number; tracks: ParsedTracks } {
  let canonical
  try {
    canonical = parseCanonicalTimelineDocument(document)
  } catch (cause) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      cause instanceof Error
        ? `时间线不符合 pinned OpenCut canonical schema: ${cause.message}`
        : '时间线不符合 pinned OpenCut canonical schema',
      { cause },
    )
  }
  return {
    ticksPerSecond: canonical.ticksPerSecond,
    tracks: {
      overlay: canonical.tracks.overlay.map((track, index) => (
        toExportTrack(track, `tracks.overlay[${index}]`)
      )),
      main: toExportTrack(canonical.tracks.main, 'tracks.main'),
      audio: canonical.tracks.audio.map((track, index) => (
        toExportTrack(track, `tracks.audio[${index}]`)
      )),
    },
  }
}

function normalizedStoryId(params: Record<string, unknown> | undefined, key: string): string | null {
  const value = params?.[key]
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ExportRenderError('INVALID_TIMELINE', `时间线 params.${key} 格式无效`)
  }
  return normalized || null
}

function requireReadyAsset(
  database: ManjuDatabase,
  assetId: string,
  projectId: string,
  episodeId: string,
): MediaAssetRecord {
  const asset = database.getMediaAsset(assetId)
  if (!asset) throw new ExportRenderError('ASSET_NOT_FOUND', `资产不存在: ${assetId}`)
  if (classifyTimelineAssetScope(asset, { projectId, episodeId }) !== 'allowed') {
    throw new ExportRenderError('ASSET_PROJECT_MISMATCH', `资产 ${assetId} 不属于当前分集`)
  }
  if (asset.status !== 'ready' || !asset.filePath || !asset.mimeType) {
    throw new ExportRenderError('ASSET_NOT_READY', `资产 ${assetId} 尚未可用`)
  }
  return asset
}

function immutableAudioRole(asset: MediaAssetRecord): RenderSemanticAudioRole | undefined {
  if (asset.kind === 'speech' || asset.kind === 'dialogue.speech' || asset.kind.endsWith('.speech')) {
    return 'dialogue'
  }
  if (asset.kind === 'bgm') return 'bgm'
  if (asset.kind === 'sfx') return 'sfx'
  if (asset.mimeType === 'video/mp4' || asset.mimeType === 'video/webm') {
    const policy = asset.generationParameters.audioPolicy
    // Generated source audio is ambience/effects, not a substitute for the
    // separately managed dialogue track.
    if (policy === 'sfx_only' || policy === 'provider_audio') return 'sfx'
  }
  return undefined
}

function semanticMediaType(
  asset: MediaAssetRecord,
  expected: 'image' | 'video' | 'audio',
): RenderSemanticAssetBinding['mediaType'] {
  const supported = expected === 'image'
    ? Boolean(asset.mimeType?.startsWith('image/'))
    : expected === 'video'
      ? asset.mimeType === 'video/mp4' || asset.mimeType === 'video/webm'
      : asset.mimeType === 'audio/mpeg' || asset.mimeType === 'audio/wav'
  if (!supported) {
    throw new ExportRenderError(
      expected === 'audio' ? 'UNSUPPORTED_AUDIO_ASSET' : 'UNSUPPORTED_VISUAL_ASSET',
      `资产 ${asset.id} 不是受支持的 ${expected} 媒体`,
    )
  }
  return expected
}

function semanticSourceDurationFrames(
  asset: MediaAssetRecord,
  expected: 'video' | 'audio',
): number {
  const seconds = asset.durationSeconds
  const frames = typeof seconds === 'number' && Number.isFinite(seconds)
    ? expected === 'audio'
      ? Math.ceil(seconds * OUTPUT_FRAME_RATE)
      : Math.round(seconds * OUTPUT_FRAME_RATE)
    : Number.NaN
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > OUTPUT_FRAME_RATE * 86_400) {
    throw new ExportRenderError(
      expected === 'audio' ? 'UNSUPPORTED_AUDIO_ASSET' : 'UNSUPPORTED_VISUAL_ASSET',
      `${expected === 'audio' ? '音频' : '视频'}资产 ${asset.id} 缺少可信源时长，无法固化裁剪`,
    )
  }
  return frames
}

interface ActiveSemanticMedia {
  element: CanonicalTimelineElement & { mediaId: string }
  expected: 'image' | 'video' | 'audio'
}

function activeSemanticMedia(document: CanonicalTimelineDocument): ActiveSemanticMedia[] {
  const result: ActiveSemanticMedia[] = []
  for (const track of [...document.tracks.overlay, document.tracks.main, ...document.tracks.audio]) {
    for (const element of track.elements) {
      const participation = projectTimelineMediaParticipation(track, element)
      if ((element.type === 'image' || element.type === 'video') && participation.visual) {
        result.push({ element, expected: element.type })
        continue
      }
      if (element.type === 'audio' && participation.timelineAudio && element.sourceType === 'upload') {
        result.push({ element, expected: 'audio' })
      }
    }
  }
  return result
}

/**
 * Complete redundant source-duration/end-trim fields from immutable asset
 * metadata before invoking the shared compiler. Legacy canonical documents
 * commonly persisted trimEnd=0 even when a source was longer than the visible
 * selection; start+duration are the actual selection, so deriving the
 * remainder does not reinterpret the edit.
 */
function compileExportSemanticPlan(
  database: ManjuDatabase,
  revision: TimelineRevisionRow,
  input: Pick<CreateExportRenderInput, 'projectId' | 'episodeId'> & {
    aspectRatio: RenderAspectRatio
    storyRevisionId: string
  },
): RenderSemanticPlan {
  let document: CanonicalTimelineDocument
  try {
    document = parseCanonicalTimelineDocument(revision.snapshot)
  } catch (cause) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      cause instanceof Error
        ? `时间线不符合 pinned OpenCut canonical schema: ${cause.message}`
        : '时间线不符合 pinned OpenCut canonical schema',
      { cause },
    )
  }

  const bindings = new Map<string, RenderSemanticAssetBinding>()
  for (const { element, expected } of activeSemanticMedia(document)) {
    const asset = requireReadyAsset(
      database,
      element.mediaId,
      input.projectId,
      input.episodeId,
    )
    const mediaType = semanticMediaType(asset, expected)
    if (!Number.isSafeInteger(asset.version) || asset.version < 1) {
      throw new ExportRenderError('ASSET_NOT_READY', `资产 ${asset.id} 缺少有效版本号`)
    }
    if (typeof asset.checksum !== 'string' || !/^[0-9a-f]{64}$/i.test(asset.checksum)) {
      throw new ExportRenderError('ASSET_NOT_READY', `资产 ${asset.id} 缺少 SHA-256 校验和`)
    }
    const sourceDurationFrames = expected === 'image'
      ? undefined
      : semanticSourceDurationFrames(asset, expected)
    const binding: RenderSemanticAssetBinding = {
      assetId: asset.id,
      version: asset.version,
      checksum: asset.checksum,
      mediaType,
      ...(sourceDurationFrames === undefined ? {} : { sourceDurationFrames }),
      ...(expected === 'image' ? {} : { audioRole: immutableAudioRole(asset) }),
    }
    const existing = bindings.get(asset.id)
    if (existing && (existing.mediaType !== binding.mediaType
      || existing.sourceDurationFrames !== binding.sourceDurationFrames
      || existing.audioRole !== binding.audioRole)) {
      throw new ExportRenderError(
        'INVALID_TIMELINE',
        `资产 ${asset.id} 在同一时间线中被解释为冲突的媒体类型或角色`,
      )
    }
    bindings.set(asset.id, binding)

    const shortVideoFill = shortVideoFillDescriptor(element, `timeline element ${element.id}`)
    if (shortVideoFill) {
      if (expected !== 'video') {
        throw new ExportRenderError(
          'INVALID_TIMELINE',
          `短视频填充绑定只能用于视频片段 ${element.id}`,
        )
      }
      const fallback = requireReadyAsset(
        database,
        shortVideoFill.fallbackAssetId,
        input.projectId,
        input.episodeId,
      )
      const fallbackMediaType = semanticMediaType(fallback, 'image')
      if (!Number.isSafeInteger(fallback.version) || fallback.version < 1
        || typeof fallback.checksum !== 'string'
        || !/^[0-9a-f]{64}$/i.test(fallback.checksum)) {
        throw new ExportRenderError(
          'ASSET_NOT_READY',
          `短视频填充资产 ${fallback.id} 缺少有效版本或 SHA-256 校验和`,
        )
      }
      const fallbackBinding: RenderSemanticAssetBinding = {
        assetId: fallback.id,
        version: fallback.version,
        checksum: fallback.checksum,
        mediaType: fallbackMediaType,
      }
      const previousFallback = bindings.get(fallback.id)
      if (previousFallback && previousFallback.mediaType !== 'image') {
        throw new ExportRenderError(
          'INVALID_TIMELINE',
          `资产 ${fallback.id} 在同一时间线中具有冲突媒体类型`,
        )
      }
      bindings.set(fallback.id, fallbackBinding)
    }

    if (sourceDurationFrames !== undefined) {
      const startFrame = frameForTicks(
        element.trimStart,
        document.ticksPerSecond,
        `${element.id}.trimStart`,
      )
      const durationFrames = shortVideoFill
        ? frameForTicks(
            shortVideoFill.sourceDurationTicks,
            document.ticksPerSecond,
            `${element.id}.manju.shortVideoFill.sourceDurationTicks`,
            1,
          )
        : frameForTicks(
            element.duration,
            document.ticksPerSecond,
            `${element.id}.duration`,
            1,
          )
      const endTrimFrames = sourceDurationFrames - startFrame - durationFrames
      if (endTrimFrames < 0) {
        throw new ExportRenderError(
          'INVALID_TIMELINE',
          `片段 ${element.id} 的裁剪范围超出资产 ${asset.id} 的可信源时长`,
        )
      }
      const ticksPerFrame = document.ticksPerSecond / OUTPUT_FRAME_RATE
      if (!Number.isSafeInteger(ticksPerFrame)) {
        throw new ExportRenderError('UNSUPPORTED_TIMELINE', '时间线无法精确表示 24 fps')
      }
      element.trimEnd = endTrimFrames * ticksPerFrame
      if (element.sourceDuration === undefined) {
        element.sourceDuration = sourceDurationFrames * ticksPerFrame
      }
    }
  }

  try {
    return compileRenderSemanticPlan({
      timelineDocument: document,
      timelineDocumentId: revision.documentId,
      timelineRevisionId: revision.id,
      storyRevisionId: input.storyRevisionId,
      aspectRatio: input.aspectRatio,
      assets: [...bindings.values()],
    })
  } catch (cause) {
    if (cause instanceof RenderSemanticPlanError) {
      const code: ExportRenderErrorCode = cause.code === 'UNSUPPORTED_TIMELINE'
        ? 'UNSUPPORTED_TIMELINE'
        : cause.code === 'ASSET_BINDING_MISSING'
          ? 'ASSET_NOT_FOUND'
          : 'INVALID_TIMELINE'
      throw new ExportRenderError(
        code,
        `共享渲染语义计划拒绝时间线（${cause.path}）：${cause.message}`,
        { cause },
      )
    }
    throw cause
  }
}

/**
 * Compile the exact semantic plan used by formal export without creating an
 * export row, generation job, staged file, or Provider request.
 *
 * Formal export and Agentic auto-edit both enter through this function. That
 * keeps "exportable" tied to the real renderer contract instead of a second,
 * weaker collection of receipt heuristics.
 */
export function validateExportRenderSemantics(
  database: ManjuDatabase,
  input: ExportRenderSemanticValidationInput,
): RenderSemanticPlan {
  const episode = database.withSql((sql) => sql.get(
    'SELECT project_id, aspect_ratio FROM episodes WHERE id = ?',
    input.episodeId,
  ))
  if (!episode) throw new ExportRenderError('EPISODE_NOT_FOUND', '分集不存在')
  if (episode.project_id !== input.projectId) {
    throw new ExportRenderError('EPISODE_PROJECT_MISMATCH', '分集不属于当前项目')
  }
  const aspectRatio = episode.aspect_ratio
  if (aspectRatio !== '16:9' && aspectRatio !== '9:16' && aspectRatio !== '1:1') {
    throw new ExportRenderError('INVALID_EXPORT_REQUEST', '分集画幅只支持 16:9、9:16 或 1:1')
  }
  return compileExportSemanticPlan(database, {
    id: input.timelineRevisionId,
    documentId: input.timelineDocumentId,
    projectId: input.projectId,
    episodeId: input.episodeId,
    sourceRevisionId: input.storyRevisionId,
    snapshot: structuredClone(input.document),
  }, {
    projectId: input.projectId,
    episodeId: input.episodeId,
    aspectRatio,
    storyRevisionId: input.storyRevisionId,
  })
}

function fitFromParams(params: Record<string, unknown> | undefined): ImageFit {
  const fit = params?.fit
  if (fit === undefined || fit === 'cover') return 'cover'
  if (fit === 'contain') return 'contain'
  throw new ExportRenderError('INVALID_TIMELINE', '图片 fit 只支持 cover 或 contain')
}

function volumeFromParams(params: Record<string, unknown> | undefined): number {
  const value = params?.volume
  if (value === undefined) return 1
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 4) {
    throw new ExportRenderError('INVALID_TIMELINE', '音频 volume 必须介于 0 和 4 之间')
  }
  return value
}

function audioRoleForSnapshot(
  params: Record<string, unknown> | undefined,
  asset: MediaAssetRecord,
): ExportAudioClipSnapshot['audioRole'] {
  const rawRole = params?.audioRole
  if (rawRole !== undefined
    && rawRole !== 'dialogue'
    && rawRole !== 'bgm'
    && rawRole !== 'sfx') {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      '音频 audioRole 只支持 dialogue、bgm 或 sfx',
    )
  }

  // Managed dialogue created before audioRole existed already has one of these
  // immutable associations. Keep accepting both names because historical
  // timeline documents used storyDialogueLineId while current materialization
  // uses dialogueLineId.
  const dialogueLineId = normalizedStoryId(params, 'dialogueLineId')
  const storyDialogueLineId = normalizedStoryId(params, 'storyDialogueLineId')
  const isDialogueAsset = asset.kind === 'speech' || asset.kind === 'dialogue.speech'
  const inferredDialogue = Boolean(dialogueLineId || storyDialogueLineId || isDialogueAsset)
  if (rawRole !== undefined && inferredDialogue && rawRole !== 'dialogue') {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      `对白资产 ${asset.id} 的 audioRole 不能标记为 ${rawRole}`,
    )
  }
  return rawRole ?? (inferredDialogue ? 'dialogue' : undefined)
}

function fadesFromAudioParams(
  params: Record<string, unknown> | undefined,
  durationSeconds: number,
): Pick<ExportAudioClipSnapshot, 'fadeInSeconds' | 'fadeOutSeconds'> {
  const fade = (key: 'fadeInSeconds' | 'fadeOutSeconds'): number | undefined => {
    const value = params?.[key]
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new ExportRenderError('INVALID_TIMELINE', `音频 ${key} 必须是有限非负数`)
    }
    if (value > durationSeconds) {
      throw new ExportRenderError('INVALID_TIMELINE', `音频 ${key} 不能超过片段时长`)
    }
    return value
  }
  const fadeInSeconds = fade('fadeInSeconds')
  const fadeOutSeconds = fade('fadeOutSeconds')
  if ((fadeInSeconds ?? 0) + (fadeOutSeconds ?? 0) > durationSeconds) {
    throw new ExportRenderError('INVALID_TIMELINE', '音频淡入与淡出时长之和不能超过片段时长')
  }
  return {
    ...(fadeInSeconds === undefined ? {} : { fadeInSeconds }),
    ...(fadeOutSeconds === undefined ? {} : { fadeOutSeconds }),
  }
}

function subtitleText(element: TimelineElement): string | null {
  const raw = typeof element.params?.text === 'string' ? element.params.text : element.name
  if (typeof raw !== 'string') return null
  const normalized = raw
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!normalized) return null
  if (normalized.length > MAX_SUBTITLE_TEXT_LENGTH) {
    throw new ExportRenderError('INVALID_TIMELINE', `字幕 ${element.id} 文本过长`)
  }
  return normalized
}

function assertNoUnsupportedEffects(element: TimelineElement): void {
  if ((element.effects?.length ?? 0) > 0) {
    throw new ExportRenderError(
      'UNSUPPORTED_TIMELINE',
      `片段 ${element.id} 使用了当前正式导出尚不支持的特效`,
    )
  }
}

function wordSubtitleCues(
  asset: MediaAssetRecord,
  element: TimelineElement,
  dialogueLineId: string,
  ticksPerSecond: number,
  totalFrames: number,
): ExportSubtitleCueSnapshot[] | null {
  const parameters = asset.generationParameters
  if (parameters.lineId !== dialogueLineId || !isPlainObject(parameters.subtitle)) return null
  const subtitle = parameters.subtitle
  if (subtitle.mode !== 'word') return null

  let canonicalCues
  try {
    canonicalCues = parseCanonicalSpeechSubtitleCues(subtitle.cues, {
      ...(typeof asset.durationSeconds === 'number'
        ? { durationMs: asset.durationSeconds * 1_000, endToleranceMs: 500 }
        : {}),
    })
  } catch {
    return null
  }

  const startFrame = frameForTicks(element.startTime, ticksPerSecond, `${element.id}.startTime`)
  const durationFrames = frameForTicks(element.duration, ticksPerSecond, `${element.id}.duration`, 1)
  if (startFrame >= totalFrames || startFrame + durationFrames > totalFrames) return null
  const trimStartMs = ((element.trimStart ?? 0) * 1_000) / ticksPerSecond
  const visibleDurationMs = (element.duration * 1_000) / ticksPerSecond
  const cues: ExportSubtitleCueSnapshot[] = []

  for (const [index, cue] of canonicalCues.entries()) {
    const cueStartMs = cue.startMs
    const cueEndMs = cue.endMs
    const relativeStartMs = Math.max(0, cueStartMs - trimStartMs)
    const relativeEndMs = Math.min(visibleDurationMs, cueEndMs - trimStartMs)
    if (relativeEndMs <= relativeStartMs) continue
    const cueStartFrame = Math.max(
      0,
      Math.min(durationFrames, Math.round((relativeStartMs * OUTPUT_FRAME_RATE) / 1_000)),
    )
    let cueEndFrame = Math.max(
      0,
      Math.min(durationFrames, Math.round((relativeEndMs * OUTPUT_FRAME_RATE) / 1_000)),
    )
    if (cueEndFrame <= cueStartFrame && cueStartFrame < durationFrames) {
      cueEndFrame = cueStartFrame + 1
    }
    if (cueEndFrame <= cueStartFrame) continue
    cues.push({
      id: `dialogue-${element.id}-word-${index + 1}`,
      startFrame: startFrame + cueStartFrame,
      durationFrames: cueEndFrame - cueStartFrame,
      text: cue.text,
    })
  }
  return cues.length > 0 ? cues : null
}

interface ManagedSubtitleCue {
  cueSetId: string
  dialogueLineId: string
  storySceneId: string
  storyShotId: string
  speechAssetId: string
  sourceAudioElementId: string
  sourceCueIndex: number
  sourceStartMs: number
  sourceEndMs: number
  snapshot: ExportSubtitleCueSnapshot
}

function managedIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ExportRenderError('INVALID_TIMELINE', `${label} 必须是字符串`)
  }
  const normalized = value.trim()
  if (!normalized
    || normalized !== value
    || normalized.length > 200
    || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ExportRenderError('INVALID_TIMELINE', `${label} 格式无效`)
  }
  return normalized
}

function normalizedSubtitleValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ExportRenderError('INVALID_TIMELINE', `${label} 必须是字符串`)
  }
  const normalized = value
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!normalized || normalized.length > MAX_SUBTITLE_TEXT_LENGTH) {
    throw new ExportRenderError('INVALID_TIMELINE', `${label} 格式无效`)
  }
  return normalized
}

function managedSubtitleCue(
  database: ManjuDatabase,
  element: TimelineElement,
  audioElements: ReadonlyMap<string, TimelineElement>,
  ticksPerSecond: number,
  totalFrames: number,
): ManagedSubtitleCue | null {
  const raw = element.manju?.subtitleCue
  const hasManagedParams = element.params?.manjuRole === 'speech-subtitle'
    || element.params?.subtitleCueSetId !== undefined
    || element.params?.sourceAudioElementId !== undefined
  if (raw === undefined && !hasManagedParams) return null
  if (!isPlainObject(raw)) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      `托管字幕 ${element.id} 缺少可验证的 manju.subtitleCue 来源信息`,
    )
  }
  const expectedKeys = new Set([
    'version',
    'cueSetId',
    'dialogueLineId',
    'storySceneId',
    'storyShotId',
    'speechAssetId',
    'sourceAudioElementId',
    'sourceCueIndex',
    'sourceStartMs',
    'sourceEndMs',
    'sourceAudioStartTime',
    'sourceAudioTrimStart',
    'sourceAudioDuration',
  ])
  if (raw.version !== 1 || Object.keys(raw).some((key) => !expectedKeys.has(key))) {
    throw new ExportRenderError('INVALID_TIMELINE', `托管字幕 ${element.id} 的来源版本或字段无效`)
  }

  const cueSetId = managedIdentifier(raw.cueSetId, `${element.id}.manju.subtitleCue.cueSetId`)
  const dialogueLineId = managedIdentifier(
    raw.dialogueLineId,
    `${element.id}.manju.subtitleCue.dialogueLineId`,
  )
  const storySceneId = managedIdentifier(
    raw.storySceneId,
    `${element.id}.manju.subtitleCue.storySceneId`,
  )
  const storyShotId = managedIdentifier(
    raw.storyShotId,
    `${element.id}.manju.subtitleCue.storyShotId`,
  )
  const speechAssetId = managedIdentifier(
    raw.speechAssetId,
    `${element.id}.manju.subtitleCue.speechAssetId`,
  )
  const sourceAudioElementId = managedIdentifier(
    raw.sourceAudioElementId,
    `${element.id}.manju.subtitleCue.sourceAudioElementId`,
  )
  const sourceCueIndex = safeInteger(
    raw.sourceCueIndex,
    `${element.id}.manju.subtitleCue.sourceCueIndex`,
  )
  const sourceStartMs = safeInteger(
    raw.sourceStartMs,
    `${element.id}.manju.subtitleCue.sourceStartMs`,
  )
  const sourceEndMs = safeInteger(
    raw.sourceEndMs,
    `${element.id}.manju.subtitleCue.sourceEndMs`,
    1,
  )
  if (sourceEndMs <= sourceStartMs) {
    throw new ExportRenderError('INVALID_TIMELINE', `托管字幕 ${element.id} 的源时间范围无效`)
  }

  const audio = audioElements.get(sourceAudioElementId)
  if (!audio || !audio.mediaId) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      `托管字幕 ${element.id} 引用的当前可听音频 ${sourceAudioElementId} 不存在`,
    )
  }
  const audioStartTime = safeInteger(
    raw.sourceAudioStartTime,
    `${element.id}.manju.subtitleCue.sourceAudioStartTime`,
  )
  const audioTrimStart = safeInteger(
    raw.sourceAudioTrimStart,
    `${element.id}.manju.subtitleCue.sourceAudioTrimStart`,
  )
  const audioDuration = safeInteger(
    raw.sourceAudioDuration,
    `${element.id}.manju.subtitleCue.sourceAudioDuration`,
    1,
  )
  if (audioStartTime !== audio.startTime
    || audioTrimStart !== (audio.trimStart ?? 0)
    || audioDuration !== audio.duration) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      `托管字幕 ${element.id} 对应的音频已移动或裁剪，请重新应用字幕`,
    )
  }
  if (audio.mediaId !== speechAssetId) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      `托管字幕 ${element.id} 对应的语音资产已变化，请重新应用字幕`,
    )
  }
  const speechAsset = database.getMediaAsset(speechAssetId)
  if (!speechAsset || (speechAsset.kind !== 'speech' && speechAsset.kind !== 'dialogue.speech')) {
    throw new ExportRenderError('INVALID_TIMELINE', `托管字幕 ${element.id} 未绑定有效语音资产`)
  }
  const bindings: Array<[string, string]> = [
    ['dialogueLineId', dialogueLineId],
    ['storySceneId', storySceneId],
    ['storyShotId', storyShotId],
  ]
  for (const [key, expected] of bindings) {
    if (normalizedStoryId(audio.params, key) !== expected) {
      throw new ExportRenderError(
        'INVALID_TIMELINE',
        `托管字幕 ${element.id} 与当前音频的 ${key} 绑定不一致`,
      )
    }
  }

  const expectedParams: Array<[string, string | number]> = [
    ['manjuRole', 'speech-subtitle'],
    ['dialogueLineId', dialogueLineId],
    ['storySceneId', storySceneId],
    ['storyShotId', storyShotId],
    ['speechAssetId', speechAssetId],
    ['sourceAudioElementId', sourceAudioElementId],
    ['subtitleCueSetId', cueSetId],
    ['sourceCueIndex', sourceCueIndex],
  ]
  for (const [key, expected] of expectedParams) {
    if (element.params?.[key] !== expected) {
      throw new ExportRenderError(
        'INVALID_TIMELINE',
        `托管字幕 ${element.id} 的 params.${key} 与来源信息不一致`,
      )
    }
  }

  const text = subtitleText(element)
  if (!text
    || normalizedSubtitleValue(element.name, `${element.id}.name`) !== text
    || normalizedSubtitleValue(element.params?.content, `${element.id}.params.content`) !== text
    || normalizedSubtitleValue(element.params?.text, `${element.id}.params.text`) !== text) {
    throw new ExportRenderError('INVALID_TIMELINE', `托管字幕 ${element.id} 的显示文本字段不一致`)
  }

  const audioStartFrame = frameForTicks(audio.startTime, ticksPerSecond, `${audio.id}.startTime`)
  const audioDurationFrames = frameForTicks(audio.duration, ticksPerSecond, `${audio.id}.duration`, 1)
  const trimStartMs = ((audio.trimStart ?? 0) * 1_000) / ticksPerSecond
  const visibleDurationMs = (audio.duration * 1_000) / ticksPerSecond
  const relativeStartMs = Math.max(0, sourceStartMs - trimStartMs)
  const relativeEndMs = Math.min(visibleDurationMs, sourceEndMs - trimStartMs)
  if (relativeEndMs <= relativeStartMs) {
    throw new ExportRenderError('INVALID_TIMELINE', `托管字幕 ${element.id} 不在当前音频裁剪范围内`)
  }
  const relativeStartFrame = Math.max(
    0,
    Math.min(audioDurationFrames, Math.round((relativeStartMs * OUTPUT_FRAME_RATE) / 1_000)),
  )
  let relativeEndFrame = Math.max(
    0,
    Math.min(audioDurationFrames, Math.round((relativeEndMs * OUTPUT_FRAME_RATE) / 1_000)),
  )
  if (relativeEndFrame <= relativeStartFrame && relativeStartFrame < audioDurationFrames) {
    relativeEndFrame = relativeStartFrame + 1
  }
  const startFrame = frameForTicks(element.startTime, ticksPerSecond, `${element.id}.startTime`)
  const durationFrames = frameForTicks(element.duration, ticksPerSecond, `${element.id}.duration`, 1)
  if (startFrame !== audioStartFrame + relativeStartFrame
    || durationFrames !== relativeEndFrame - relativeStartFrame
    || startFrame >= totalFrames
    || startFrame + durationFrames > totalFrames) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      `托管字幕 ${element.id} 的时间位置与来源 cue 不一致`,
    )
  }

  return {
    cueSetId,
    dialogueLineId,
    storySceneId,
    storyShotId,
    speechAssetId,
    sourceAudioElementId,
    sourceCueIndex,
    sourceStartMs,
    sourceEndMs,
    snapshot: { id: element.id, startFrame, durationFrames, text },
  }
}

function validateManagedSubtitleSets(
  cues: readonly ManagedSubtitleCue[],
): Set<string> {
  const byAudioElement = new Map<string, ManagedSubtitleCue[]>()
  for (const cue of cues) {
    byAudioElement.set(cue.sourceAudioElementId, [
      ...(byAudioElement.get(cue.sourceAudioElementId) ?? []),
      cue,
    ])
  }
  for (const [audioElementId, group] of byAudioElement) {
    group.sort((left, right) => left.sourceCueIndex - right.sourceCueIndex)
    const first = group[0]
    let previousEndMs = 0
    group.forEach((cue, index) => {
      if (cue.sourceCueIndex !== index
        || cue.cueSetId !== first.cueSetId
        || cue.dialogueLineId !== first.dialogueLineId
        || cue.storySceneId !== first.storySceneId
        || cue.storyShotId !== first.storyShotId
        || cue.speechAssetId !== first.speechAssetId
        || cue.sourceStartMs < previousEndMs) {
        throw new ExportRenderError(
          'INVALID_TIMELINE',
          `音频 ${audioElementId} 的托管字幕 cue-set 不完整或相互冲突`,
        )
      }
      previousEndMs = cue.sourceEndMs
    })
  }
  return new Set(byAudioElement.keys())
}

function dialogueSubtitleCues(
  database: ManjuDatabase,
  storySnapshot: JsonObject,
  tracks: ParsedTracks,
  ticksPerSecond: number,
  totalFrames: number,
  excludedAudioElementIds: ReadonlySet<string> = new Set(),
): ExportSubtitleCueSnapshot[] {
  let story
  try {
    story = parseStoryDocument(storySnapshot)
  } catch (error) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      '时间线固化的剧本修订不是可用的结构化剧本，无法生成烧录字幕',
      { cause: error },
    )
  }
  const lines = new Map<string, Array<{ sceneId: string; shotId: string; text: string }>>()
  story.scenes.forEach((scene) => scene.shots.forEach((shot) => shot.dialogueLines.forEach((line) => {
    lines.set(line.id, [
      ...(lines.get(line.id) ?? []),
      { sceneId: scene.id, shotId: shot.id, text: line.text },
    ])
  })))
  return tracks.audio.flatMap((track) => track.elements
    .filter((element) => projectTimelineMediaParticipation(track, element).timelineAudio)
    .flatMap((element): ExportSubtitleCueSnapshot[] => {
    if (excludedAudioElementIds.has(element.id)) return []
    if (!element.mediaId) return []
    const dialogueLineId = normalizedStoryId(element.params, 'dialogueLineId')
    if (!dialogueLineId) return []
    const sceneId = normalizedStoryId(element.params, 'storySceneId')
    const shotId = normalizedStoryId(element.params, 'storyShotId')
    const candidates = (lines.get(dialogueLineId) ?? []).filter((candidate) => (
      (!sceneId || candidate.sceneId === sceneId)
      && (!shotId || candidate.shotId === shotId)
    ))
    if (candidates.length === 0) {
      throw new ExportRenderError(
        'INVALID_TIMELINE',
        `音频元素 ${element.id} 引用的对白 ${dialogueLineId} 不存在于固化剧本修订`,
      )
    }
    if (candidates.length > 1) {
      throw new ExportRenderError(
        'INVALID_TIMELINE',
        `音频元素 ${element.id} 的 dialogueLineId 不唯一，必须同时固化 storySceneId/storyShotId`,
      )
    }
    const asset = database.getMediaAsset(element.mediaId)
    const persistedWordCues = asset
      ? wordSubtitleCues(
          asset,
          element,
          dialogueLineId,
          ticksPerSecond,
          totalFrames,
        )
      : null
    if (persistedWordCues) return persistedWordCues
    const text = candidates[0].text
    const normalizedText = subtitleText({
      id: element.id,
      type: 'text',
      startTime: element.startTime,
      duration: element.duration,
      name: text,
    })
    if (!normalizedText) return []
    const startFrame = frameForTicks(element.startTime, ticksPerSecond, `${element.id}.startTime`)
    const durationFrames = frameForTicks(element.duration, ticksPerSecond, `${element.id}.duration`, 1)
    if (startFrame >= totalFrames || startFrame + durationFrames > totalFrames) {
      throw new ExportRenderError('INVALID_TIMELINE', `字幕 ${element.id} 超出视频时长`)
    }
      return [{ id: `dialogue-${element.id}`, startFrame, durationFrames, text: normalizedText }]
    }))
}

function brandingSnapshot(
  storySnapshot: JsonObject,
  episodeTitleValue: string,
  totalFrames: number,
  input: Pick<
    CreateExportRenderInput,
    'introTitle' | 'outroCard' | 'reviewWatermark'
  >,
): ExportBrandingSnapshot {
  const introTitle = input.introTitle === true
  const outroCard = input.outroCard === true
  const reviewWatermark = input.reviewWatermark === true
  if (!introTitle && !outroCard && !reviewWatermark) {
    return { introTitle: null, outroCard: null, reviewWatermark: null }
  }

  let story
  try {
    story = parseStoryDocument(storySnapshot)
  } catch (cause) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      '时间线固化的剧本修订不是可用的结构化剧本，无法生成标题落版',
      { cause },
    )
  }
  const storyTitle = exportSafeString(story.title, 'story.title', 200)
  const episodeTitle = exportSafeString(episodeTitleValue, 'episode.title', 200)
  const titleDurationFrames = Math.min(TITLE_CARD_DURATION_FRAMES, totalFrames)
  const introText = storyTitle === episodeTitle
    ? storyTitle
    : `${storyTitle}\n${episodeTitle}`
  const outroText = storyTitle === episodeTitle
    ? `${storyTitle}\n本集完`
    : `${storyTitle}\n${episodeTitle} · 本集完`

  return {
    introTitle: introTitle ? {
      startFrame: 0,
      durationFrames: titleDurationFrames,
      text: introText,
    } : null,
    outroCard: outroCard ? {
      startFrame: totalFrames - titleDurationFrames,
      durationFrames: titleDurationFrames,
      text: outroText,
    } : null,
    reviewWatermark: reviewWatermark ? {
      startFrame: 0,
      durationFrames: totalFrames,
      text: REVIEW_WATERMARK_TEXT,
    } : null,
  }
}

function normalizeSnapshot(
  database: ManjuDatabase,
  revision: TimelineRevisionRow,
  input: Pick<
    CreateExportRenderInput,
    | 'projectId'
    | 'episodeId'
    | 'kenBurns'
    | 'burnSubtitles'
    | 'introTitle'
    | 'outroCard'
    | 'reviewWatermark'
  > & { episodeTitle: string; aspectRatio: RenderAspectRatio },
): DurableExportTimelineSnapshot {
  const { ticksPerSecond, tracks } = parseTracks(revision.snapshot)
  const visualTracks = [...tracks.overlay.filter((track) => track.type === 'video'), tracks.main]
    .filter((track) => !isTimelineTrackHidden(track))
    .map((track) => ({
      ...track,
      elements: track.elements.filter((element) => (
        projectTimelineMediaParticipation(track, element).visual
      )),
    }))
    .filter((track) => track.elements.length > 0)
  if (visualTracks.length === 0) {
    throw new ExportRenderError('INVALID_TIMELINE', '时间线至少需要一个图片或视频片段')
  }
  if (visualTracks.length > 1) {
    throw new ExportRenderError(
      'UNSUPPORTED_TIMELINE',
      '当前 MVP 导出只支持一条非空视觉轨道，不会默默丢弃叠加画面',
    )
  }
  if (tracks.overlay.some((track) => (
    !isTimelineTrackHidden(track)
    && (track.type === 'graphic' || track.type === 'effect')
    && track.elements.some((element) => !isTimelineElementHidden(track, element))
  ))) {
    throw new ExportRenderError(
      'UNSUPPORTED_TIMELINE',
      '当前 MVP 导出尚不支持图形/特效轨道，已停止而非忽略这些元素',
    )
  }

  const owningVisualTrack = visualTracks[0]
  const sourceVisuals = owningVisualTrack.elements
    .map((element) => ({ track: owningVisualTrack, element }))
    .sort((left, right) => (
      left.element.startTime - right.element.startTime
      || left.element.id.localeCompare(right.element.id)
    ))
  if (sourceVisuals.length > MAX_EXPORT_CLIPS) {
    throw new ExportRenderError('INVALID_TIMELINE', `视觉片段不能超过 ${MAX_EXPORT_CLIPS} 个`)
  }
  const seenElementIds = new Set<string>()
  const sourceAudioClips: ExportAudioClipSnapshot[] = []
  let expectedStartFrame = 0
  const visualClips = sourceVisuals.map(({ track, element }): ExportVisualClipSnapshot => {
    if (seenElementIds.has(element.id)) {
      throw new ExportRenderError('INVALID_TIMELINE', `时间线元素 ID 重复: ${element.id}`)
    }
    seenElementIds.add(element.id)
    if (element.type !== 'image' && element.type !== 'video') {
      throw new ExportRenderError(
        'UNSUPPORTED_VISUAL_ASSET',
        `视觉片段 ${element.id} 的类型是 ${element.type}；当前真实导出仅支持图片或视频`,
      )
    }
    assertNoUnsupportedEffects(element)
    if (element.retimeRate !== undefined && element.retimeRate !== 1) {
      throw new ExportRenderError(
        'UNSUPPORTED_TIMELINE',
        `视觉片段 ${element.id} 使用了变速；当前正式导出尚不支持变速片段`,
      )
    }
    const startFrame = frameForTicks(element.startTime, ticksPerSecond, `${element.id}.startTime`)
    const durationFrames = frameForTicks(element.duration, ticksPerSecond, `${element.id}.duration`, 1)
    if (startFrame !== expectedStartFrame) {
      throw new ExportRenderError(
        'INVALID_TIMELINE',
        `视觉片段 ${element.id} 与前一片段不连续；MVP 导出只支持无缝硬切`,
      )
    }
    expectedStartFrame += durationFrames
    const assetId = element.mediaId ?? null
    if (!assetId || assetId.startsWith('manju:pending:')) {
      throw new ExportRenderError(
        'ASSET_NOT_FOUND',
        `视觉片段 ${element.id} 的不可变时间线快照缺少已解析 mediaId`,
      )
    }
    const asset = requireReadyAsset(database, assetId, input.projectId, input.episodeId)
    if (element.type === 'image' && !asset.mimeType?.startsWith('image/')) {
      throw new ExportRenderError(
        'UNSUPPORTED_VISUAL_ASSET',
        `视觉片段 ${element.id} 引用的资产 ${asset.id} 不是图片`,
      )
    }
    if (element.type === 'video'
      && asset.mimeType !== 'video/mp4'
      && asset.mimeType !== 'video/webm') {
      throw new ExportRenderError(
        'UNSUPPORTED_VISUAL_ASSET',
        `视觉片段 ${element.id} 引用的资产 ${asset.id} 不是受支持的 MP4/WebM 视频`,
      )
    }
    const base: ExportVisualClipSnapshot = {
      type: element.type as 'image' | 'video',
      id: element.id,
      startFrame,
      durationFrames,
      assetId: asset.id,
      fit: fitFromParams(element.params),
    }
    if (element.type === 'image') return base

    const sourceDurationSeconds = asset.durationSeconds
    if (typeof sourceDurationSeconds !== 'number'
      || !Number.isFinite(sourceDurationSeconds)
      || sourceDurationSeconds <= 0
      || sourceDurationSeconds > 86_400) {
      throw new ExportRenderError(
        'UNSUPPORTED_VISUAL_ASSET',
        `视频资产 ${asset.id} 缺少可信源时长，无法固化裁剪`,
      )
    }
    const sourceStartSeconds = (element.trimStart ?? 0) / ticksPerSecond
    const shortVideoFill = shortVideoFillDescriptor(
      element as unknown as CanonicalTimelineElement,
      `timeline element ${element.id}`,
    )
    const selectedDurationFrames = shortVideoFill
      ? frameForTicks(
          shortVideoFill.sourceDurationTicks,
          ticksPerSecond,
          `${element.id}.manju.shortVideoFill.sourceDurationTicks`,
          1,
        )
      : durationFrames
    const selectedDurationSeconds = selectedDurationFrames / OUTPUT_FRAME_RATE
    if (sourceStartSeconds + selectedDurationSeconds > sourceDurationSeconds + 0.1) {
      throw new ExportRenderError(
        'INVALID_TIMELINE',
        `视频片段 ${element.id} 的裁剪范围超出源视频时长`,
      )
    }
    const videoClip = {
      ...base,
      sourceStartSeconds,
      sourceDurationSeconds,
    }
    if (projectTimelineMediaParticipation(track, element).sourceAudio) {
      const sourceAudioId = `${element.id}:source-audio`
      if (seenElementIds.has(sourceAudioId)) {
        throw new ExportRenderError('INVALID_TIMELINE', `时间线元素 ID 重复: ${sourceAudioId}`)
      }
      seenElementIds.add(sourceAudioId)
      const audioRole = audioRoleForSnapshot(element.params, asset)
      sourceAudioClips.push({
        id: sourceAudioId,
        startFrame,
        durationFrames: selectedDurationFrames,
        assetId: asset.id,
        sourceStartSeconds,
        volume: volumeFromParams(element.params),
        ...(audioRole === undefined ? {} : { audioRole }),
      })
    }
    return videoClip
  })

  const totalFrames = expectedStartFrame
  if (totalFrames > MAX_EXPORT_FRAMES) {
    throw new ExportRenderError('INVALID_TIMELINE', '单次导出时长不能超过 6 小时')
  }
  const audioClips = [
    ...sourceAudioClips,
    ...tracks.audio.flatMap((track) => track.elements
      .filter((element) => projectTimelineMediaParticipation(track, element).timelineAudio)
      .map((element) => ({ track, element })))
    .map(({ element }): ExportAudioClipSnapshot => {
      if (seenElementIds.has(element.id)) {
        throw new ExportRenderError('INVALID_TIMELINE', `时间线元素 ID 重复: ${element.id}`)
      }
      seenElementIds.add(element.id)
      if (element.type !== 'audio') {
        throw new ExportRenderError('INVALID_TIMELINE', `音频轨道元素 ${element.id} 不是 audio`)
      }
      assertNoUnsupportedEffects(element)
      if (element.retimeRate !== undefined && element.retimeRate !== 1) {
        throw new ExportRenderError(
          'UNSUPPORTED_TIMELINE',
          `音频片段 ${element.id} 使用了变速；当前正式导出尚不支持音频变速`,
        )
      }
      if (!element.mediaId) {
        throw new ExportRenderError(
          'UNSUPPORTED_AUDIO_ASSET',
          element.sourceType === 'library' || element.sourceUrl
            ? `音频片段 ${element.id} 是外部媒体库引用，正式导出只接受已固化 mediaId`
            : `音频片段 ${element.id} 的不可变时间线快照缺少 mediaId`,
        )
      }
      const assetId = element.mediaId
      const asset = requireReadyAsset(database, assetId, input.projectId, input.episodeId)
      if (asset.mimeType !== 'audio/mpeg' && asset.mimeType !== 'audio/wav') {
        throw new ExportRenderError(
          'UNSUPPORTED_AUDIO_ASSET',
          `音频片段 ${element.id} 引用的资产 ${asset.id} 不是受支持的语音文件`,
        )
      }
      const startFrame = frameForTicks(element.startTime, ticksPerSecond, `${element.id}.startTime`)
      const durationFrames = frameForTicks(element.duration, ticksPerSecond, `${element.id}.duration`, 1)
      if (startFrame >= totalFrames || startFrame + durationFrames > totalFrames) {
        throw new ExportRenderError('INVALID_TIMELINE', `音频片段 ${element.id} 超出视频时长`)
      }
      const audioRole = audioRoleForSnapshot(element.params, asset)
      return {
        id: element.id,
        startFrame,
        durationFrames,
        assetId: asset.id,
        sourceStartSeconds: (element.trimStart ?? 0) / ticksPerSecond,
        volume: volumeFromParams(element.params),
        ...(audioRole === undefined ? {} : { audioRole }),
        ...fadesFromAudioParams(element.params, durationFrames / OUTPUT_FRAME_RATE),
      }
    }),
  ]
  if (audioClips.length > MAX_EXPORT_AUDIO_CLIPS) {
    throw new ExportRenderError('INVALID_TIMELINE', `音频片段不能超过 ${MAX_EXPORT_AUDIO_CLIPS} 个`)
  }

  const activeAudioElements = tracks.audio.flatMap((track) => track.elements
    .filter((element) => projectTimelineMediaParticipation(track, element).timelineAudio))
  const activeAudioElementsById = new Map(
    activeAudioElements.map((element) => [element.id, element] as const),
  )
  const explicitSubtitleCues: ExportSubtitleCueSnapshot[] = []
  const managedSubtitleCues: ManagedSubtitleCue[] = []
  if (input.burnSubtitles === true) {
    for (const track of tracks.overlay.filter((candidate) => (
      candidate.type === 'text' && !isTimelineTrackHidden(candidate)
    ))) {
      for (const element of track.elements.filter((candidate) => (
        !isTimelineElementHidden(track, candidate)
      ))) {
        if (element.type !== 'text') {
          throw new ExportRenderError('INVALID_TIMELINE', `字幕轨道元素 ${element.id} 不是 text`)
        }
        if (seenElementIds.has(element.id)) {
          throw new ExportRenderError('INVALID_TIMELINE', `时间线元素 ID 重复: ${element.id}`)
        }
        seenElementIds.add(element.id)
        assertNoUnsupportedEffects(element)
        const managed = managedSubtitleCue(
          database,
          element,
          activeAudioElementsById,
          ticksPerSecond,
          totalFrames,
        )
        if (managed) {
          managedSubtitleCues.push(managed)
          explicitSubtitleCues.push(managed.snapshot)
          continue
        }
        const text = subtitleText(element)
        if (!text) continue
        const startFrame = frameForTicks(element.startTime, ticksPerSecond, `${element.id}.startTime`)
        const durationFrames = frameForTicks(element.duration, ticksPerSecond, `${element.id}.duration`, 1)
        if (startFrame >= totalFrames || startFrame + durationFrames > totalFrames) {
          throw new ExportRenderError('INVALID_TIMELINE', `字幕 ${element.id} 超出视频时长`)
        }
        explicitSubtitleCues.push({ id: element.id, startFrame, durationFrames, text })
      }
    }
  }

  const storyRevisionId = revision.sourceRevisionId
  if (!storyRevisionId) {
    throw new ExportRenderError(
      'STORY_REVISION_NOT_FOUND',
      '时间线修订没有固化来源剧本修订，无法可重现地导出',
    )
  }
  const storyRevision = database.getRevision(storyRevisionId)
  if (!storyRevision || storyRevision.projectId !== input.projectId) {
    throw new ExportRenderError('STORY_REVISION_NOT_FOUND', '时间线引用的剧本修订不存在')
  }
  let subtitleCues: ExportSubtitleCueSnapshot[] = []
  if (input.burnSubtitles === true) {
    const coveredAudioElementIds = validateManagedSubtitleSets(managedSubtitleCues)
    subtitleCues = [
      ...explicitSubtitleCues,
      ...dialogueSubtitleCues(
      database,
      storyRevision.snapshot,
      tracks,
      ticksPerSecond,
      totalFrames,
        coveredAudioElementIds,
      ),
    ].sort((left, right) => (
      left.startFrame - right.startFrame
      || left.id.localeCompare(right.id)
    ))
  }
  const branding = brandingSnapshot(
    storyRevision.snapshot,
    input.episodeTitle,
    totalFrames,
    input,
  )
  const semanticPlan = validateExportRenderSemantics(database, {
    projectId: input.projectId,
    episodeId: input.episodeId,
    timelineDocumentId: revision.documentId,
    timelineRevisionId: revision.id,
    storyRevisionId,
    document: revision.snapshot,
  })
  if (semanticPlan.totalFrames !== totalFrames) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      '共享渲染语义计划与导出时间线总帧数不一致',
    )
  }
  if (input.kenBurns === true
    && semanticPlan.visualClips.some((clip) => clip.uniformScaleMotion !== undefined)) {
    throw new ExportRenderError(
      'UNSUPPORTED_TIMELINE',
      '时间线已固化逐帧缩放动画，不能再叠加 legacy Ken Burns',
    )
  }
  const semanticVisualClips: ExportVisualClipSnapshot[] = semanticPlan.visualClips.map((clip) => ({
    type: clip.mediaType,
    id: clip.id,
    startFrame: clip.startFrame,
    durationFrames: clip.durationFrames,
    assetId: clip.asset.assetId,
    fit: clip.fit,
    ...(clip.mediaType === 'video' ? {
      sourceStartSeconds: clip.sourceTrim!.startFrame / OUTPUT_FRAME_RATE,
      sourceDurationSeconds: clip.asset.sourceDurationFrames! / OUTPUT_FRAME_RATE,
    } : {}),
  }))
  const semanticAudioClips: ExportAudioClipSnapshot[] = semanticPlan.audioClips.map((clip) => ({
    id: clip.id,
    startFrame: clip.startFrame,
    durationFrames: clip.durationFrames,
    assetId: clip.asset.assetId,
    sourceStartSeconds: clip.sourceTrim.startFrame / OUTPUT_FRAME_RATE,
    volume: clip.linearGain,
    audioRole: clip.role,
    ...(clip.fadeInSeconds > 0 ? { fadeInSeconds: clip.fadeInSeconds } : {}),
    ...(clip.fadeOutSeconds > 0 ? { fadeOutSeconds: clip.fadeOutSeconds } : {}),
  }))
  const semanticSubtitleCues: ExportSubtitleCueSnapshot[] = input.burnSubtitles === true
    ? semanticPlan.subtitleCues.map((cue) => ({
        id: cue.id,
        startFrame: cue.startFrame,
        durationFrames: cue.durationFrames,
        text: cue.text,
      }))
    : []
  return {
    version: EXPORT_RENDER_SNAPSHOT_VERSION,
    timelineDocumentId: semanticPlan.timelineDocumentId,
    timelineRevisionId: semanticPlan.timelineRevisionId,
    storyRevisionId,
    ticksPerSecond: semanticPlan.ticksPerSecond,
    frameRate: semanticPlan.frameRate,
    visualClips: semanticVisualClips,
    audioClips: semanticAudioClips,
    subtitleCues: semanticSubtitleCues,
    semanticPlan,
    branding,
  }
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value)
}

function exportSpecification(
  input: CreateExportRenderInput,
  revisions: {
    timelineRevisionId: string
    storyRevisionId: string
    aspectRatio: RenderAspectRatio
  },
): ExportSpecification {
  return {
    version: 1,
    resolution: input.resolution,
    aspectRatio: revisions.aspectRatio,
    kenBurns: input.kenBurns === true,
    burnSubtitles: input.burnSubtitles === true,
    introTitle: input.introTitle === true,
    outroCard: input.outroCard === true,
    reviewWatermark: input.reviewWatermark === true,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    frameRate: OUTPUT_FRAME_RATE,
    audioCodec: 'aac',
    audioSampleRate: 48_000,
    timelineRevisionId: revisions.timelineRevisionId,
    storyRevisionId: revisions.storyRevisionId,
  }
}

function validateCreateInput(input: CreateExportRenderInput): CreateExportRenderInput {
  const projectId = requiredString(input.projectId, 'projectId')
  const episodeId = requiredString(input.episodeId, 'episodeId')
  const idempotencyKey = requiredString(input.idempotencyKey, 'Idempotency-Key')
  if (input.resolution !== '720p' && input.resolution !== '1080p') {
    throw new ExportRenderError('INVALID_EXPORT_REQUEST', 'resolution 只支持 720p 或 1080p')
  }
  if (input.kenBurns !== undefined && typeof input.kenBurns !== 'boolean') {
    throw new ExportRenderError('INVALID_EXPORT_REQUEST', 'kenBurns 必须是布尔值')
  }
  if (input.burnSubtitles !== undefined && typeof input.burnSubtitles !== 'boolean') {
    throw new ExportRenderError('INVALID_EXPORT_REQUEST', 'burnSubtitles 必须是布尔值')
  }
  if (input.introTitle !== undefined && typeof input.introTitle !== 'boolean') {
    throw new ExportRenderError('INVALID_EXPORT_REQUEST', 'introTitle 必须是布尔值')
  }
  if (input.outroCard !== undefined && typeof input.outroCard !== 'boolean') {
    throw new ExportRenderError('INVALID_EXPORT_REQUEST', 'outroCard 必须是布尔值')
  }
  if (input.reviewWatermark !== undefined && typeof input.reviewWatermark !== 'boolean') {
    throw new ExportRenderError('INVALID_EXPORT_REQUEST', 'reviewWatermark 必须是布尔值')
  }
  const timelineRevisionId = input.timelineRevisionId === undefined
    ? undefined
    : requiredString(input.timelineRevisionId, 'timelineRevisionId')
  const expectedTimelineRevisionId = input.expectedTimelineRevisionId === undefined
    ? undefined
    : requiredString(input.expectedTimelineRevisionId, 'If-Match')
  const pipelineRunId = input.pipelineRunId === undefined
    ? undefined
    : requiredString(input.pipelineRunId, 'pipelineRunId')
  if (!timelineRevisionId && !expectedTimelineRevisionId) {
    throw new ExportRenderError(
      'INVALID_EXPORT_REQUEST',
      '必须提供 timelineRevisionId 或 If-Match 以固化不可变时间线修订',
    )
  }
  if (timelineRevisionId && expectedTimelineRevisionId
    && timelineRevisionId !== expectedTimelineRevisionId) {
    throw new ExportRenderError(
      'TIMELINE_REVISION_CONFLICT',
      'timelineRevisionId 与 If-Match 指向不同修订',
    )
  }
  return {
    ...input,
    projectId,
    episodeId,
    idempotencyKey,
    ...(timelineRevisionId ? { timelineRevisionId } : {}),
    ...(expectedTimelineRevisionId ? { expectedTimelineRevisionId } : {}),
    ...(pipelineRunId ? { pipelineRunId } : {}),
  }
}

export interface ExportRenderServiceOptions {
  now?: () => string
  idFactory?: () => string
}

export class ExportRenderService {
  private readonly now: () => string
  private readonly idFactory: () => string

  constructor(
    private readonly database: ManjuDatabase,
    // Kept as an explicit dependency to ensure this service shares the same
    // durable timeline subsystem as the API; revision reads remain direct so
    // historical immutable revisions can be exported.
    private readonly timelines: TimelineDocumentService,
    options: ExportRenderServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
  }

  create(inputValue: CreateExportRenderInput): CreateExportRenderResult {
    const input = validateCreateInput(inputValue)
    return this.database.transaction(() => {
      const episode = this.database.withSql((sql) => sql.get(
        'SELECT project_id, title, aspect_ratio FROM episodes WHERE id = ?',
        input.episodeId,
      ))
      if (!episode) throw new ExportRenderError('EPISODE_NOT_FOUND', '分集不存在')
      if (episode.project_id !== input.projectId) {
        throw new ExportRenderError('EPISODE_PROJECT_MISMATCH', '分集不属于当前项目')
      }
      if (input.pipelineRunId) {
        const pipelineRun = this.database.getPipelineRun(input.pipelineRunId)
        if (!pipelineRun) {
          throw new ExportRenderError('PIPELINE_RUN_NOT_FOUND', 'Pipeline Run 不存在')
        }
        if (pipelineRun.projectId !== input.projectId
          || pipelineRun.episodeId !== input.episodeId) {
          throw new ExportRenderError(
            'PIPELINE_RUN_MISMATCH',
            'Pipeline Run 不属于当前项目和分集',
          )
        }
      }
      const aspectRatio = episode.aspect_ratio
      if (aspectRatio !== '16:9' && aspectRatio !== '9:16' && aspectRatio !== '1:1') {
        throw new ExportRenderError('INVALID_EXPORT_REQUEST', '分集画幅只支持 16:9、9:16 或 1:1')
      }

      // Idempotency is evaluated before mutable-head preconditions. A client
      // retrying the exact accepted operation must receive its original task
      // even if the timeline head advanced after the first response was lost.
      const requestedRevisionId = input.timelineRevisionId ?? input.expectedTimelineRevisionId!
      const existingJob = this.database.findGenerationJobByIdempotencyKey(
        input.projectId,
        input.idempotencyKey,
      )
      if (existingJob) {
        const exportId = existingJob.type === EXPORT_RENDER_JOB_TYPE
          && typeof existingJob.input.exportId === 'string'
          ? existingJob.input.exportId
          : null
        const existingExport = exportId ? this.get(exportId) : undefined
        const specification = existingExport?.specification
        if (!existingExport
          || existingExport.episodeId !== input.episodeId
          || specification?.timelineRevisionId !== requestedRevisionId
          || specification.resolution !== input.resolution
          || specification.kenBurns !== (input.kenBurns === true)
          || specification.burnSubtitles !== (input.burnSubtitles === true)
          || specification.introTitle !== (input.introTitle === true)
          || specification.outroCard !== (input.outroCard === true)
          || specification.reviewWatermark !== (input.reviewWatermark === true)
          || existingJob.pipelineRunId !== (input.pipelineRunId ?? null)) {
          throw new ExportRenderError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key 已用于另一个不同的任务',
          )
        }
        return { created: false, export: existingExport, job: existingJob }
      }

      let currentTimeline: ReturnType<TimelineDocumentService['get']>
      try {
        currentTimeline = this.timelines.get(input.episodeId)
      } catch (error) {
        const code = isPlainObject(error) ? error.code : undefined
        if (code === 'TIMELINE_DOCUMENT_NOT_FOUND') {
          throw new ExportRenderError('TIMELINE_DOCUMENT_NOT_FOUND', '分集尚无已保存时间线', { cause: error })
        }
        throw error
      }
      const currentRevisionId = currentTimeline.revision.id
      if (input.expectedTimelineRevisionId
        && currentRevisionId !== input.expectedTimelineRevisionId) {
        throw new ExportRenderError(
          'TIMELINE_REVISION_CONFLICT',
          '时间线已更新，请刷新后重新导出',
        )
      }
      const pinnedRevisionId = input.timelineRevisionId
        ?? input.expectedTimelineRevisionId
        ?? currentRevisionId
      const revisionRow = this.database.withSql((sql) => sql.get(`
        SELECT * FROM timeline_document_revisions
         WHERE id = ? AND episode_id = ?
      `, pinnedRevisionId, input.episodeId))
      if (!revisionRow) {
        throw new ExportRenderError('TIMELINE_REVISION_NOT_FOUND', '指定的时间线修订不存在')
      }
      const revision = asTimelineRevisionRow(revisionRow)
      if (revision.projectId !== input.projectId) {
        throw new ExportRenderError('EPISODE_PROJECT_MISMATCH', '时间线修订不属于当前项目')
      }
      if (!revision.sourceRevisionId) {
        throw new ExportRenderError(
          'STORY_REVISION_NOT_FOUND',
          '时间线修订没有固化来源剧本修订，无法可重现地导出',
        )
      }
      const authority = currentMediaAuthority(this.database, {
        projectId: input.projectId,
        episodeId: input.episodeId,
      })
      const authorityReceipt = timelineMediaAuthorityReceipt(this.database, revision.id)
      if (authority.receiptRequired
        && (revision.sourceRevisionId !== authority.sourceRevisionId
          || authorityReceipt?.documentId !== revision.documentId
          || authorityReceipt?.projectId !== input.projectId
          || authorityReceipt?.episodeId !== input.episodeId
          || authorityReceipt?.sourceRevisionId !== authority.sourceRevisionId
          || authorityReceipt?.fingerprint !== authority.fingerprint)) {
        throw new ExportRenderError(
          'TIMELINE_MEDIA_RECONCILIATION_REQUIRED',
          '镜头选版已变化，请先对账当前媒体后再导出',
        )
      }
      const specification = exportSpecification(input, {
        timelineRevisionId: revision.id,
        storyRevisionId: revision.sourceRevisionId,
        aspectRatio,
      })

      // Resolve mutable relational links exactly once, only for a new task.
      // Subsequent idempotent requests return the already-pinned export even
      // if a later story edit has correctly marked its assets stale.
      const snapshot = normalizeSnapshot(this.database, revision, {
        ...input,
        aspectRatio,
        episodeTitle: requiredRowString(episode, 'title'),
      })

      const exportId = this.idFactory()
      const jobId = this.idFactory()
      const now = this.now()
      this.database.withSql((sql) => sql.run(`
        INSERT INTO exports (
          id, project_id, episode_id, status, timeline_snapshot_json,
          output_asset_id, specification_json, error_json, created_at,
          updated_at, completed_at, timeline_document_revision_id
        ) VALUES (?, ?, ?, 'queued', ?, NULL, ?, NULL, ?, ?, NULL, ?)
      `,
      exportId,
      input.projectId,
      input.episodeId,
      serializeJson(snapshot),
      serializeJson(specification),
      now,
      now,
      snapshot.timelineRevisionId))
      const job = this.database.createGenerationJob({
        id: jobId,
        projectId: input.projectId,
        episodeId: input.episodeId,
        pipelineRunId: input.pipelineRunId ?? null,
        type: EXPORT_RENDER_JOB_TYPE,
        status: 'queued',
        resourceType: EXPORT_RENDER_RESOURCE_KEY,
        resourceId: exportId,
        idempotencyKey: input.idempotencyKey,
        input: {
          exportId,
          timelineRevisionId: snapshot.timelineRevisionId,
          storyRevisionId: snapshot.storyRevisionId,
        },
      })
      const created = this.require(exportId)
      return { created: true, export: created, job }
    })
  }

  get(id: string): ExportRecord | undefined {
    const row = this.database.withSql((sql) => sql.get('SELECT * FROM exports WHERE id = ?', id))
    return row ? asExportRecord(row) : undefined
  }

  require(id: string): ExportRecord {
    const record = this.get(id)
    if (!record) throw new ExportRenderError('EXPORT_NOT_FOUND', '导出记录不存在')
    return record
  }

  jobForExport(exportId: string): GenerationJobRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(`
      SELECT id FROM generation_jobs
       WHERE type = ? AND resource_id = ?
       ORDER BY attempt DESC, created_at DESC, id DESC LIMIT 1
    `, EXPORT_RENDER_JOB_TYPE, exportId))
    return typeof row?.id === 'string' ? this.database.getGenerationJob(row.id) : undefined
  }

  /** Mirror durable worker state into the export read model. */
  syncJob(job: GenerationJobRecord): ExportRecord | undefined {
    if (job.type !== EXPORT_RENDER_JOB_TYPE || !job.resourceId) return undefined
    const record = this.get(job.resourceId)
    if (!record) return undefined
    // A story edit atomically marks the export stale and cancels its job in
    // SQLite. A late in-process worker event must never resurrect that read
    // model as running/succeeded.
    if (record.status === 'stale') return record
    const status = job.status === 'waiting_provider' ? 'running' : job.status
    const now = this.now()
    const completedAt = status === 'succeeded' || status === 'failed' || status === 'cancelled'
      ? job.completedAt ?? now
      : null
    this.database.withSql((sql) => sql.run(`
      UPDATE exports SET status = ?, error_json = ?, updated_at = ?, completed_at = ?
       WHERE id = ?
    `,
    status,
    job.error ? serializeJson(job.error) : null,
    now,
    completedAt,
    record.id))
    return this.require(record.id)
  }

  attachOutput(exportId: string, asset: MediaAssetRecord, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    const record = this.require(exportId)
    if (asset.projectId !== record.projectId || asset.episodeId !== record.episodeId) {
      throw new ExportRenderError('ASSET_PROJECT_MISMATCH', '导出资产不属于当前分集')
    }
    const changed = this.database.withSql((sql) => sql.run(`
      UPDATE exports SET output_asset_id = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('failed', 'cancelled', 'stale')
    `, asset.id, this.now(), exportId).changes)
    if (changed !== 1) {
      throw new ExportRenderError('EXPORT_STATE_CONFLICT', '导出任务已终止，拒绝关联迟到的成片')
    }
  }
}

function mimeExtension(mimeType: string): string {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'audio/mpeg') return 'mp3'
  if (mimeType === 'audio/wav') return 'wav'
  if (mimeType === 'video/mp4') return 'mp4'
  if (mimeType === 'video/webm') return 'webm'
  throw new ExportRenderError('ASSET_NOT_READY', `无法暂存媒体类型 ${mimeType}`)
}

async function stageAsset(
  mediaStore: MediaStore,
  assetId: string,
  directory: string,
  index: number,
): Promise<StagedAsset> {
  const opened = await mediaStore.openAsset(assetId)
  try {
    const path = join(directory, `asset-${index}.${mimeExtension(opened.mimeType)}`)
    const bytes = await opened.file.readFile()
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    return {
      asset: opened.asset,
      path,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      mimeType: opened.mimeType,
    }
  } finally {
    await opened.file.close().catch(() => undefined)
  }
}

function semanticPlanForRender(record: ExportRecord): RenderSemanticPlan | null {
  if (record.timelineSnapshot.version !== EXPORT_RENDER_SNAPSHOT_VERSION) return null
  const plan = record.timelineSnapshot.semanticPlan
  if (!plan
    || (plan.version !== 1
      && plan.version !== 2
      && plan.version !== 3
      && plan.version !== 4
      && plan.version !== RENDER_SEMANTIC_PLAN_VERSION)
    || plan.timelineDocumentId !== record.timelineSnapshot.timelineDocumentId
    || plan.timelineRevisionId !== record.timelineRevisionId
    || plan.storyRevisionId !== record.timelineSnapshot.storyRevisionId
    || plan.aspectRatio !== record.specification.aspectRatio
    || plan.frameRate !== OUTPUT_FRAME_RATE
    || !Array.isArray(plan.visualClips)
    || !Array.isArray(plan.audioClips)
    || !Array.isArray(plan.subtitleCues)) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      '版本 3 导出快照缺少匹配修订、剧本和画幅的共享渲染语义计划',
    )
  }
  assertSemanticPlanCompositorVersion(plan)
  const totalFrames = plan.visualClips.reduce((sum, clip) => sum + clip.durationFrames, 0)
  if (!Number.isSafeInteger(plan.totalFrames)
    || plan.totalFrames < 1
    || totalFrames !== plan.totalFrames) {
    throw new ExportRenderError('INVALID_TIMELINE', '共享渲染语义计划总帧数无效')
  }
  return plan
}

function assertSemanticPlanCompositorVersion(plan: RenderSemanticPlan): void {
  if (plan.version === 1 && plan.visualClips.some((clip) => clip.shapeMask !== undefined)) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      'RenderSemanticPlan v1 不能携带形状遮罩语义',
    )
  }
  if (plan.version === 1 && plan.visualClips.some((clip) => clip.opacityFade !== undefined)) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      'RenderSemanticPlan v1 不能携带透明度组合语义',
    )
  }
  if (plan.version === 2 && plan.visualClips.some((clip) => clip.shapeMask !== undefined)) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      'RenderSemanticPlan v2 不能携带形状遮罩语义',
    )
  }
  if ((plan.version === 1 || plan.version === 2 || plan.version === 3)
    && plan.visualClips.some((clip) => clip.uniformScaleMotion !== undefined)) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      `RenderSemanticPlan v${plan.version} 不能携带逐帧缩放语义`,
    )
  }
  const shapeMasks = plan.visualClips.flatMap((clip) => (
    clip.shapeMask ? [clip.shapeMask] : []
  ))
  if ((plan.version === 3 || plan.version === 4) && shapeMasks.some((mask) => (
    mask.version !== 1 || 'inverted' in mask
  ))) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      `RenderSemanticPlan v${plan.version} 不能携带反向形状遮罩语义`,
    )
  }
  if (plan.version === RENDER_SEMANTIC_PLAN_VERSION && shapeMasks.some((mask) => (
    mask.version !== 2 || typeof (mask as { inverted?: unknown }).inverted !== 'boolean'
  ))) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      `RenderSemanticPlan v${RENDER_SEMANTIC_PLAN_VERSION} 形状遮罩必须携带 v2 极性语义`,
    )
  }
}

function validateStagedSemanticAssets(
  plan: RenderSemanticPlan,
  staged: ReadonlyMap<string, StagedAsset>,
): void {
  const mediaTypes = new Map<string, 'image' | 'video' | 'audio'>()
  for (const clip of plan.visualClips) mediaTypes.set(clip.asset.assetId, clip.mediaType)
  for (const clip of plan.audioClips) {
    if (!mediaTypes.has(clip.asset.assetId)) mediaTypes.set(clip.asset.assetId, 'audio')
  }
  const pins = [...plan.visualClips, ...plan.audioClips].map((clip) => clip.asset)
  const seen = new Map<string, string>()
  for (const pin of pins) {
    const signature = JSON.stringify(pin)
    const previous = seen.get(pin.assetId)
    if (previous !== undefined && previous !== signature) {
      throw new ExportRenderError('INVALID_TIMELINE', `资产 ${pin.assetId} 在共享计划中的固化身份冲突`)
    }
    seen.set(pin.assetId, signature)
    const item = staged.get(pin.assetId)
    if (!item) throw new ExportRenderError('ASSET_NOT_FOUND', `共享计划资产不存在: ${pin.assetId}`)
    if (item.asset.version !== pin.version || item.checksum !== pin.checksum) {
      throw new ExportRenderError(
        'ASSET_NOT_READY',
        `资产 ${pin.assetId} 的版本或文件校验和已偏离导出固化值`,
      )
    }
    const expectedType = mediaTypes.get(pin.assetId)!
    semanticMediaType(item.asset, expectedType)
    if (pin.sourceDurationFrames !== null) {
      const actualFrames = semanticSourceDurationFrames(
        item.asset,
        expectedType === 'video' ? 'video' : 'audio',
      )
      if (actualFrames !== pin.sourceDurationFrames) {
        throw new ExportRenderError(
          'ASSET_NOT_READY',
          `资产 ${pin.assetId} 的可信源时长已偏离导出固化值`,
        )
      }
    }
  }
}

export interface RenderTimelineFromSemanticPlanInput {
  plan: RenderSemanticPlan
  /** Resolve only already-staged, immutable plan assets to trusted local paths. */
  assetPath(assetId: string): string | undefined
  kenBurns: boolean
  subtitles?: BurnedSubtitleTrack
}

/**
 * The single production adapter from renderer-neutral semantics to FFmpeg's
 * immutable request. Keeping this pure lets browser and server compare the
 * same pinned plan before codec-specific rendering begins.
 */
export function renderTimelineFromSemanticPlan(
  input: RenderTimelineFromSemanticPlanInput,
): ImmutableRenderTimelineSnapshot {
  assertSemanticPlanCompositorVersion(input.plan)
  const pathFor = (assetId: string): string => {
    const path = input.assetPath(assetId)
    if (!path) {
      throw new ExportRenderError('ASSET_NOT_FOUND', `共享计划资产尚未完成暂存: ${assetId}`)
    }
    return path
  }
  const visualClips: ImmutableRenderTimelineSnapshot['visualClips'] = input.plan.visualClips
    .map((clip) => {
      const common = {
        id: clip.id,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        assetPath: pathFor(clip.asset.assetId),
        fit: clip.fit,
        ...(clip.opacityFade ? { opacityFade: clip.opacityFade } : {}),
        ...(clip.shapeMask ? { shapeMask: clip.shapeMask } : {}),
      }
      if (clip.mediaType === 'image') {
        if (clip.uniformScaleMotion && input.kenBurns) {
          throw new ExportRenderError(
            'INVALID_TIMELINE',
            `共享图片片段 ${clip.id} 已携带逐帧缩放，不能再叠加 legacy Ken Burns`,
          )
        }
        return {
          ...common,
          mediaType: 'image' as const,
          kenBurns: input.kenBurns,
          ...(clip.uniformScaleMotion
            ? { uniformScaleMotion: clip.uniformScaleMotion }
            : {}),
        }
      }
      if (clip.uniformScaleMotion) {
        throw new ExportRenderError(
          'INVALID_TIMELINE',
          `共享视频片段 ${clip.id} 不能携带逐帧缩放语义`,
        )
      }
      if (!clip.sourceTrim || clip.asset.sourceDurationFrames === null) {
        throw new ExportRenderError('INVALID_TIMELINE', `共享视频片段 ${clip.id} 缺少源裁剪信息`)
      }
      return {
        ...common,
        mediaType: 'video' as const,
        sourceStartSeconds: clip.sourceTrim.startFrame / OUTPUT_FRAME_RATE,
        sourceDurationSeconds: clip.asset.sourceDurationFrames / OUTPUT_FRAME_RATE,
      }
    })
  const audioClips: NonNullable<ImmutableRenderTimelineSnapshot['audioClips']> = input.plan.audioClips
    .map((clip) => ({
      id: clip.id,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
      assetPath: pathFor(clip.asset.assetId),
      sourceStartSeconds: clip.sourceTrim.startFrame / OUTPUT_FRAME_RATE,
      volume: clip.linearGain,
      audioRole: clip.role,
      fadeInSeconds: clip.fadeInSeconds,
      fadeOutSeconds: clip.fadeOutSeconds,
      duckingWindows: clip.duckingWindows,
    }))
  return {
    revisionId: input.plan.timelineRevisionId,
    frameRate: input.plan.frameRate,
    visualClips,
    audioClips,
    ...(input.subtitles ? { subtitles: input.subtitles } : {}),
  }
}

function srtTimestamp(frame: number): string {
  const milliseconds = Math.round((frame / OUTPUT_FRAME_RATE) * 1_000)
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
  const remainder = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`
}

export function subtitlesAsSrt(cues: readonly ExportSubtitleCueSnapshot[]): string {
  return cues.map((cue, index) => [
    String(index + 1),
    `${srtTimestamp(cue.startFrame)} --> ${srtTimestamp(cue.startFrame + cue.durationFrames)}`,
    cue.text,
    '',
  ].join('\n')).join('\n')
}

function assTimestamp(frame: number): string {
  const centiseconds = Math.round((frame / OUTPUT_FRAME_RATE) * 100)
  const hours = Math.floor(centiseconds / 360_000)
  const minutes = Math.floor((centiseconds % 360_000) / 6_000)
  const seconds = Math.floor((centiseconds % 6_000) / 100)
  const remainder = centiseconds % 100
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(2, '0')}`
}

/**
 * Neutralize every user-derived ASS control surface. Do not rely on `\{`
 * compatibility: libass/VSFilter variants disagree on whether it opens an
 * override block, so control glyphs become visually equivalent full-width
 * text. The only remaining backslash is our server-authored line break.
 */
export function escapeAssText(value: string): string {
  return value
    .replace(/\\/g, '＼')
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/\r\n?|\n/g, '\\N')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function assFadeOverride(cue: ExportBrandingCueSnapshot): string {
  const durationMs = Math.round((cue.durationFrames / OUTPUT_FRAME_RATE) * 1_000)
  const fadeMs = Math.min(300, Math.max(0, Math.floor(durationMs / 4)))
  return `{\\fad(${fadeMs},${fadeMs})}`
}

function assPlayResolution(aspectRatio: RenderAspectRatio): { x: number; y: number } {
  if (aspectRatio === '9:16') return { x: 1_080, y: 1_920 }
  if (aspectRatio === '1:1') return { x: 1_080, y: 1_080 }
  return { x: 1_920, y: 1_080 }
}

/**
 * One safe ASS document combines optional timeline subtitles with immutable
 * export-only title cards/watermark. All styles use libass' generic sans-serif
 * fallback; no client-provided font or path reaches the renderer.
 */
export function subtitlesAsAss(
  cues: readonly ExportSubtitleCueSnapshot[],
  branding: ExportBrandingSnapshot,
  aspectRatio: RenderAspectRatio,
): string {
  const play = assPlayResolution(aspectRatio)
  const shortEdge = Math.min(play.x, play.y)
  const marginX = Math.round(play.x * 0.06)
  const marginY = Math.round(play.y * 0.07)
  const subtitleSize = Math.round(shortEdge * 0.048)
  const titleSize = Math.round(shortEdge * 0.072)
  const outroSize = Math.round(shortEdge * 0.062)
  const watermarkSize = Math.round(shortEdge * 0.028)
  const styles = [
    `Style: Subtitle,sans-serif,${subtitleSize},&H00FFFFFF,&H000000FF,&H00101010,&H98000000,-1,0,0,0,100,100,0,0,1,3,1,2,${marginX},${marginX},${marginY},1`,
    `Style: IntroTitle,sans-serif,${titleSize},&H00FFFFFF,&H000000FF,&H00101010,&H88000000,-1,0,0,0,100,100,1,0,1,4,1,5,${marginX},${marginX},${marginY},1`,
    `Style: OutroCard,sans-serif,${outroSize},&H00FFFFFF,&H000000FF,&H00101010,&H88000000,-1,0,0,0,100,100,1,0,1,4,1,5,${marginX},${marginX},${marginY},1`,
    `Style: Watermark,sans-serif,${watermarkSize},&H50FFFFFF,&H000000FF,&H80101010,&H80000000,0,0,0,0,100,100,0,0,1,1,0,9,${marginX},${marginX},${marginY},1`,
  ]
  const event = (
    layer: number,
    style: 'Subtitle' | 'IntroTitle' | 'OutroCard' | 'Watermark',
    cue: ExportSubtitleCueSnapshot | ExportBrandingCueSnapshot,
    prefix = '',
  ): string => (
    `Dialogue: ${layer},${assTimestamp(cue.startFrame)},${assTimestamp(cue.startFrame + cue.durationFrames)},${style},,0,0,0,,${prefix}${escapeAssText(cue.text)}`
  )
  const events = cues.map((cue) => event(0, 'Subtitle', cue))
  if (branding.introTitle) {
    events.push(event(10, 'IntroTitle', branding.introTitle, assFadeOverride(branding.introTitle)))
  }
  if (branding.outroCard) {
    events.push(event(10, 'OutroCard', branding.outroCard, assFadeOverride(branding.outroCard)))
  }
  if (branding.reviewWatermark) {
    events.push(event(20, 'Watermark', branding.reviewWatermark, assFadeOverride(branding.reviewWatermark)))
  }
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${play.x}`,
    `PlayResY: ${play.y}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n')
}

function brandingForRender(record: ExportRecord): ExportBrandingSnapshot | null {
  const enabled = record.specification.introTitle
    || record.specification.outroCard
    || record.specification.reviewWatermark
  if (!enabled) return null
  const branding = record.timelineSnapshot.branding
  if (!branding
    || (record.specification.introTitle && !branding.introTitle)
    || (record.specification.outroCard && !branding.outroCard)
    || (record.specification.reviewWatermark && !branding.reviewWatermark)) {
    throw new ExportRenderError(
      'INVALID_TIMELINE',
      '导出快照缺少已开启的标题落版或审片水印固化数据',
    )
  }
  return {
    introTitle: record.specification.introTitle ? branding.introTitle : null,
    outroCard: record.specification.outroCard ? branding.outroCard : null,
    reviewWatermark: record.specification.reviewWatermark ? branding.reviewWatermark : null,
  }
}

function publicAsset(asset: MediaAssetRecord, exportId: string): JsonObject {
  return {
    id: asset.id,
    projectId: asset.projectId,
    episodeId: asset.episodeId,
    kind: asset.kind,
    version: asset.version,
    status: asset.status,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.durationSeconds,
    checksum: asset.checksum,
    source: asset.source,
    providerId: asset.providerId,
    generationJobId: asset.generationJobId,
    sourceRevisionId: asset.sourceRevisionId,
    parentAssetId: asset.parentAssetId,
    // Export videos are never exposed through the generic asset-content route:
    // every byte-serving URL must traverse the export's QC download gate.
    url: `/api/v1/exports/${encodeURIComponent(exportId)}/download`,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  }
}

interface ExportDiagnosticAssetPin {
  assetId: string
  version: number | null
  checksum: string | null
  sourceDurationFrames: number | null
}

function boundedUtf8(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return { text: value, truncated: false }
  let bytes = 0
  let text = ''
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maximumBytes) break
    text += character
    bytes += size
  }
  return { text, truncated: true }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Redact before truncation so a secret can never straddle the durable bound. */
export function summarizeFfmpegStderr(
  value: string | undefined,
  sensitivePaths: readonly string[],
): { text: string | null; truncated: boolean } {
  if (!value?.trim()) return { text: null, truncated: false }
  let redacted = value
  for (const path of [...new Set(sensitivePaths.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    redacted = redacted.replace(
      new RegExp(`${escapeRegularExpression(path)}(?:[\\/][^\\s'\"]*)?`, 'g'),
      '[render-task]',
    )
  }
  redacted = redacted
    .replace(/\b(?:sk|ark)-[A-Za-z0-9._-]{8,}\b/g, '[redacted-token]')
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[redacted-token]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\/)[^"'\r\n]+\1/g, '$1[path]$1')
    .replace(/(^|[\s=(])(?:[A-Za-z]:[\\/]|\/)[^\s,;)\]]+/gm, '$1[path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  const bounded = boundedUtf8(redacted, MAX_EXPORT_DIAGNOSTIC_STDERR_BYTES)
  return { text: bounded.text || null, truncated: bounded.truncated }
}

function exportDiagnosticPins(
  record: ExportRecord,
  database: ManjuDatabase,
): ExportDiagnosticAssetPin[] {
  const semanticPlan = record.timelineSnapshot.semanticPlan
  const pins = semanticPlan
    ? [...semanticPlan.visualClips, ...semanticPlan.audioClips].map((clip) => ({
        assetId: clip.asset.assetId,
        version: clip.asset.version,
        checksum: clip.asset.checksum,
        sourceDurationFrames: clip.asset.sourceDurationFrames,
      }))
    : [...record.timelineSnapshot.visualClips, ...record.timelineSnapshot.audioClips].map((clip) => {
        const asset = database.getMediaAsset(clip.assetId)
        return {
          assetId: clip.assetId,
          version: asset?.version ?? null,
          checksum: asset?.checksum ?? null,
          sourceDurationFrames: typeof asset?.durationSeconds === 'number'
            ? Math.round(asset.durationSeconds * OUTPUT_FRAME_RATE)
            : null,
        }
      })
  const unique = new Map<string, ExportDiagnosticAssetPin>()
  for (const pin of pins) {
    if (!unique.has(pin.assetId)) unique.set(pin.assetId, pin)
  }
  return [...unique.values()].sort((left, right) => left.assetId.localeCompare(right.assetId))
}

function jsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function diagnosticRuntimeReceipt(value: FfmpegRendererRuntimeReceipt): object {
  const audit = value.audit
  return {
    schemaVersion: 1,
    source: String(value.source).slice(0, 64),
    releaseEligible: value.releaseEligible === true,
    audit: audit ? {
      schemaVersion: 1,
      source: String(audit.source).slice(0, 64),
      target: {
        platform: audit.target.platform.slice(0, 64),
        arch: audit.target.arch.slice(0, 64),
      },
      sourceVersion: audit.sourceVersion.slice(0, 128),
      manifestSha256: audit.manifestSha256,
      verificationReceiptSha256: audit.verificationReceiptSha256,
      ffmpegSha256: audit.ffmpegSha256,
      ffprobeSha256: audit.ffprobeSha256,
    } : null,
  }
}

function exportFailureDiagnostics(input: {
  error: unknown
  category: JobErrorCategory
  record: ExportRecord | undefined
  database: ManjuDatabase
  renderer: FfmpegRendererPort
  taskDirectory: string | null
  runtimeDirectory: string
}): JsonObject {
  const stderr = input.error instanceof FfmpegRenderError ? input.error.stderr : undefined
  const stderrSummary = summarizeFfmpegStderr(stderr, [
    input.taskDirectory ?? '',
    input.runtimeDirectory,
  ])
  let rawRuntimeReceipt: FfmpegRendererRuntimeReceipt = {
    schemaVersion: 1,
    source: 'injected',
    releaseEligible: false,
    audit: null,
  }
  try {
    rawRuntimeReceipt = input.renderer.runtimeDiagnosticReceipt?.() ?? rawRuntimeReceipt
  } catch {
    // Diagnostic introspection must never replace the original render error.
  }
  let pins: ExportDiagnosticAssetPin[] = []
  try {
    if (input.record) pins = exportDiagnosticPins(input.record, input.database)
  } catch {
    // A malformed historical snapshot must not replace the original failure.
  }
  const shownPins = pins.slice(0, MAX_EXPORT_DIAGNOSTIC_PINS)
  const record = input.record
  return jsonObject({
    schemaVersion: 1,
    renderer: 'ffmpeg',
    category: input.category,
    stderr: stderrSummary.text,
    stderrTruncated: stderrSummary.truncated,
    runtimeReceipt: diagnosticRuntimeReceipt(rawRuntimeReceipt),
    inputPins: {
      exportId: record?.id ?? null,
      timelineRevisionId: record?.timelineRevisionId ?? null,
      storyRevisionId: record?.timelineSnapshot.storyRevisionId ?? null,
      resolution: record?.specification.resolution ?? null,
      aspectRatio: record?.specification.aspectRatio ?? null,
      assetPinCount: pins.length,
      assetPinsTruncated: pins.length > shownPins.length,
      assetPinSetSha256: createHash('sha256').update(JSON.stringify(pins)).digest('hex'),
      assetPins: shownPins,
    },
  })
}

function handlerError(
  error: unknown,
  diagnostics: (category: JobErrorCategory) => JsonObject,
): Error {
  if (error instanceof JobExecutionError) {
    if (error.category === 'cancelled' || error.diagnostics) return error
    return new JobExecutionError(error.code, error.message, error.retryable, error.category, {
      cause: error,
      diagnostics: diagnostics(error.category),
    })
  }
  if (error instanceof ExportRenderError) {
    return new JobExecutionError(error.code, error.message, false, 'validation', {
      cause: error,
      diagnostics: diagnostics('validation'),
    })
  }
  if (error instanceof FfmpegRenderError) {
    if (error.code === 'CANCELLED') return new JobCancelledError(error.message, { cause: error })
    const retryable = error.code === 'TIMEOUT' || error.code === 'PROCESS_SPAWN_FAILED'
    const category = error.code === 'TIMEOUT' ? 'timeout' : 'internal'
    return new JobExecutionError(error.code, error.message, retryable, category, {
      cause: error,
      diagnostics: diagnostics(category),
    })
  }
  if (error instanceof MediaStoreError) {
    const retryable = error.code === 'ASSET_FILE_MISSING'
    return new JobExecutionError(error.code, error.message, retryable, 'validation', {
      cause: error,
      diagnostics: diagnostics('validation'),
    })
  }
  return new JobExecutionError(
    'UNEXPECTED_JOB_ERROR',
    '任务执行失败，请查看服务日志',
    true,
    'internal',
    { cause: error, diagnostics: diagnostics('internal') },
  )
}

export interface CreateExportRenderHandlerOptions {
  database: ManjuDatabase
  mediaStore: MediaStore
  exports: ExportRenderService
  runtimeDirectory: string
  renderer?: FfmpegRendererPort
  publishAsset?: (asset: MediaAssetRecord) => void
}

export function createExportRenderJobHandler(
  options: CreateExportRenderHandlerOptions,
): JobHandler<ExportRenderJobInput, ExportRenderOutput> {
  const renderer = options.renderer ?? createFfmpegRenderer()
  return async (job: JobRecord<ExportRenderJobInput>, context): Promise<ExportRenderOutput> => {
    let diagnosticRecord: ExportRecord | undefined
    let diagnosticTaskDirectory: string | null = null
    try {
      const exportId = typeof job.input?.exportId === 'string' ? job.input.exportId : ''
      if (!exportId) {
        throw new ExportRenderError('INVALID_EXPORT_REQUEST', '导出 Job 缺少 exportId')
      }
      const record = options.exports.require(exportId)
      diagnosticRecord = record
      if (record.projectId !== job.projectId) {
        throw new ExportRenderError('EPISODE_PROJECT_MISMATCH', '导出 Job 与导出记录不属于同一项目')
      }
      if ((job.input.timelineRevisionId !== undefined
          && job.input.timelineRevisionId !== record.timelineRevisionId)
        || (job.input.storyRevisionId !== undefined
          && job.input.storyRevisionId !== record.timelineSnapshot.storyRevisionId)) {
        throw new ExportRenderError('INVALID_EXPORT_REQUEST', '导出 Job 与不可变时间线 / 剧本修订绑定不一致')
      }
      if (record.outputAssetId) {
        const opened = await options.mediaStore.openAsset(record.outputAssetId)
        await opened.file.close()
        const existing = opened.asset
        if (existing.projectId !== record.projectId
          || existing.episodeId !== record.episodeId
          || opened.mimeType !== 'video/mp4') {
          throw new ExportRenderError('ASSET_PROJECT_MISMATCH', '导出记录引用的成片资产无效')
        }
        return {
          exportId,
          timelineRevisionId: record.timelineRevisionId,
          storyRevisionId: record.timelineSnapshot.storyRevisionId,
          asset: publicAsset(existing, exportId),
        }
      }

      await context.reportProgress(5, { stage: 'staging-assets' })
      const createdDirectory = await mkdtemp(join(options.runtimeDirectory, 'export-render-'))
      diagnosticTaskDirectory = createdDirectory
      try {
        const directory = await realpath(createdDirectory)
        diagnosticTaskDirectory = directory
        const semanticPlan = semanticPlanForRender(record)
        const uniqueAssetIds = [...new Set([
          ...(semanticPlan
            ? semanticPlan.visualClips.map((clip) => clip.asset.assetId)
            : record.timelineSnapshot.visualClips.map((clip) => clip.assetId)),
          ...(semanticPlan
            ? semanticPlan.audioClips.map((clip) => clip.asset.assetId)
            : record.timelineSnapshot.audioClips.map((clip) => clip.assetId)),
        ])]
        const staged = new Map<string, StagedAsset>()
        for (let index = 0; index < uniqueAssetIds.length; index += 1) {
          context.signal.throwIfAborted()
          const item = await stageAsset(options.mediaStore, uniqueAssetIds[index], directory, index)
          staged.set(uniqueAssetIds[index], item)
        }
        if (semanticPlan) validateStagedSemanticAssets(semanticPlan, staged)
        let subtitlePath: string | undefined
        let subtitleFormat: 'srt' | 'ass' | undefined
        const branding = brandingForRender(record)
        if (branding) {
          subtitlePath = join(directory, 'timeline-overlays.ass')
          subtitleFormat = 'ass'
          await writeFile(
            subtitlePath,
            subtitlesAsAss(
              record.specification.burnSubtitles
                ? (semanticPlan?.subtitleCues ?? record.timelineSnapshot.subtitleCues)
                : [],
              branding,
              record.specification.aspectRatio,
            ),
            { flag: 'wx', mode: 0o600 },
          )
        } else if (record.specification.burnSubtitles
          && (semanticPlan?.subtitleCues.length ?? record.timelineSnapshot.subtitleCues.length) > 0) {
          subtitlePath = join(directory, 'timeline-subtitles.srt')
          subtitleFormat = 'srt'
          await writeFile(
            subtitlePath,
            subtitlesAsSrt(semanticPlan?.subtitleCues ?? record.timelineSnapshot.subtitleCues),
            { flag: 'wx', mode: 0o600 },
          )
        }

        const subtitles: BurnedSubtitleTrack | undefined = subtitlePath && subtitleFormat
          ? { assetPath: subtitlePath, format: subtitleFormat, burnIn: true }
          : undefined
        let timeline: ImmutableRenderTimelineSnapshot
        if (semanticPlan) {
          timeline = renderTimelineFromSemanticPlan({
            plan: semanticPlan,
            assetPath: (assetId) => staged.get(assetId)?.path,
            kenBurns: record.specification.kenBurns,
            ...(subtitles ? { subtitles } : {}),
          })
        } else {
          const renderVisualClips: ImmutableRenderTimelineSnapshot['visualClips'] = record
            .timelineSnapshot.visualClips.map((clip) => {
              const common = {
                id: clip.id,
                startFrame: clip.startFrame,
                durationFrames: clip.durationFrames,
                assetPath: staged.get(clip.assetId)!.path,
                fit: clip.fit,
              }
              if (clip.type !== 'video') {
                return {
                  ...common,
                  mediaType: 'image' as const,
                  kenBurns: record.specification.kenBurns,
                }
              }
              if (typeof clip.sourceStartSeconds !== 'number'
                || typeof clip.sourceDurationSeconds !== 'number') {
                throw new ExportRenderError(
                  'INVALID_TIMELINE',
                  `固化视频片段 ${clip.id} 缺少源裁剪信息`,
                )
              }
              return {
                ...common,
                mediaType: 'video' as const,
                sourceStartSeconds: clip.sourceStartSeconds,
                sourceDurationSeconds: clip.sourceDurationSeconds,
              }
            })
          const renderAudioClips: NonNullable<ImmutableRenderTimelineSnapshot['audioClips']> = record
            .timelineSnapshot.audioClips.map((clip) => ({
              id: clip.id,
              startFrame: clip.startFrame,
              durationFrames: clip.durationFrames,
              assetPath: staged.get(clip.assetId)!.path,
              sourceStartSeconds: clip.sourceStartSeconds,
              volume: clip.volume,
              ...(clip.audioRole === undefined ? {} : { audioRole: clip.audioRole }),
              ...(clip.fadeInSeconds === undefined ? {} : { fadeInSeconds: clip.fadeInSeconds }),
              ...(clip.fadeOutSeconds === undefined ? {} : { fadeOutSeconds: clip.fadeOutSeconds }),
            }))
          timeline = {
            revisionId: record.timelineRevisionId,
            frameRate: OUTPUT_FRAME_RATE,
            visualClips: renderVisualClips,
            audioClips: renderAudioClips,
            ...(subtitles ? { subtitles } : {}),
          }
        }
        await context.reportProgress(20, { stage: 'rendering' })
        const outputPath = join(directory, 'output.mp4')
        const rendered = await renderer.render({
          timeline,
          resolution: record.specification.resolution,
          aspectRatio: record.specification.aspectRatio,
          outputPath,
          signal: context.signal,
        })
        if (rendered.outputPath !== outputPath) {
          throw new JobExecutionError(
            'INVALID_RENDER_OUTPUT',
            '媒体处理器返回了任务目录之外的输出',
            false,
            'internal',
          )
        }
        context.signal.throwIfAborted()
        await context.reportProgress(90, { stage: 'publishing' })
        const outputInfo = await stat(rendered.outputPath)
        if (!outputInfo.isFile() || outputInfo.size < 1 || outputInfo.size > MAX_EXPORT_OUTPUT_BYTES) {
          throw new JobExecutionError(
            'MEDIA_TOO_LARGE',
            `导出成片必须是不超过 ${MAX_EXPORT_OUTPUT_BYTES} 字节的非空文件`,
            false,
            'validation',
          )
        }
        const asset = await options.mediaStore.save({
          projectId: record.projectId,
          episodeId: record.episodeId,
          kind: 'export.video',
          bytes: await readFile(rendered.outputPath),
          mimeType: 'video/mp4',
          source: 'renderer',
          generationJobId: job.id,
          generationParameters: {
            resolution: record.specification.resolution,
            aspectRatio: record.specification.aspectRatio,
            videoCodec: record.specification.videoCodec,
            pixelFormat: record.specification.pixelFormat,
            frameRate: record.specification.frameRate,
            audioCodec: record.specification.audioCodec,
            audioSampleRate: record.specification.audioSampleRate,
            kenBurns: record.specification.kenBurns,
            burnSubtitles: record.specification.burnSubtitles,
            introTitle: record.specification.introTitle,
            outroCard: record.specification.outroCard,
            reviewWatermark: record.specification.reviewWatermark,
            timelineRevisionId: record.timelineRevisionId,
            storyRevisionId: record.timelineSnapshot.storyRevisionId,
          },
          sourceRevisionId: record.timelineSnapshot.storyRevisionId,
          width: rendered.width,
          height: rendered.height,
          durationSeconds: rendered.durationSeconds,
        }, {
          afterCreate(asset, _database) {
            options.exports.attachOutput(exportId, asset, context.signal)
          },
        })
        options.publishAsset?.(asset)
        await context.reportProgress(98, { stage: 'finalizing' })
        return {
          exportId,
          timelineRevisionId: record.timelineRevisionId,
          storyRevisionId: record.timelineSnapshot.storyRevisionId,
          asset: publicAsset(asset, exportId),
        }
      } finally {
        await rm(createdDirectory, { recursive: true, force: true })
      }
    } catch (error) {
      throw handlerError(error, (category) => exportFailureDiagnostics({
        error,
        category,
        record: diagnosticRecord,
        database: options.database,
        renderer,
        taskDirectory: diagnosticTaskDirectory,
        runtimeDirectory: options.runtimeDirectory,
      }))
    }
  }
}

export function exportRecordAsJson(
  record: ExportRecord,
  job: GenerationJobRecord | undefined,
  asset: MediaAssetRecord | undefined,
): JsonObject {
  return {
    id: record.id,
    projectId: record.projectId,
    episodeId: record.episodeId,
    status: record.status,
    timelineRevisionId: record.timelineRevisionId,
    storyRevisionId: record.timelineSnapshot.storyRevisionId,
    specification: structuredClone(record.specification) as unknown as JsonValue,
    outputAsset: asset ? publicAsset(asset, record.id) : null,
    downloadUrl: asset && record.status === 'succeeded'
      ? `/api/v1/exports/${encodeURIComponent(record.id)}/download`
      : null,
    reviewDownloadUrl: asset && record.status === 'succeeded'
      ? `/api/v1/exports/${encodeURIComponent(record.id)}/review-download`
      : null,
    jobId: job?.id ?? null,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  }
}
