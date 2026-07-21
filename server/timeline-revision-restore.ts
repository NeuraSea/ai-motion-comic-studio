import { createHash, randomUUID } from 'node:crypto'

import type { ManjuDatabase } from './database.js'
import {
  TimelineDocumentError,
  type TimelineDocumentService,
  type TimelineDocumentSnapshot,
} from './timeline-documents.js'

export type TimelineRevisionRestoreErrorCode =
  | 'INVALID_TIMELINE_RESTORE_REQUEST'
  | 'TIMELINE_RESTORE_IDEMPOTENCY_CONFLICT'
  | 'TIMELINE_RESTORE_SCOPE_MISMATCH'
  | 'TIMELINE_RESTORE_INCOMPATIBLE'
  | 'CORRUPT_TIMELINE_RESTORE'

export class TimelineRevisionRestoreError extends Error {
  constructor(
    readonly code: TimelineRevisionRestoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TimelineRevisionRestoreError'
  }
}

export interface TimelineRevisionRestoreRecord {
  id: string
  documentId: string
  projectId: string
  episodeId: string
  baseRevisionId: string
  targetRevisionId: string
  resultRevisionId: string
  createdAt: string
}

export interface TimelineRevisionRestoreStaleResult {
  exports: number
  qualityReports: number
  pipelineRuns: number
  generationJobs: number
}

export interface RestoreTimelineRevisionInput {
  projectId: string
  episodeId: string
  documentId: string
  targetRevisionId: string
  expectedRevisionId: string
  idempotencyKey: string
  summary?: string
}

export interface RestoreTimelineRevisionResult {
  timeline: TimelineDocumentSnapshot
  operationResultTimeline: TimelineDocumentSnapshot
  headAdvanced: boolean
  restore: TimelineRevisionRestoreRecord
  stale: TimelineRevisionRestoreStaleResult
  idempotent: boolean
}

interface RestoreRow extends Record<string, unknown> {
  id: unknown
  document_id: unknown
  project_id: unknown
  episode_id: unknown
  base_revision_id: unknown
  target_revision_id: unknown
  result_revision_id: unknown
  request_hash: unknown
  stale_exports: unknown
  stale_quality_reports: unknown
  stale_pipeline_runs: unknown
  stale_generation_jobs: unknown
  created_at: unknown
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new TimelineRevisionRestoreError(
      'CORRUPT_TIMELINE_RESTORE',
      `Timeline restore column ${key} is not text`,
    )
  }
  return value
}

function requiredCount(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TimelineRevisionRestoreError(
      'CORRUPT_TIMELINE_RESTORE',
      `Timeline restore column ${key} is not a count`,
    )
  }
  return value as number
}

function normalizeIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(normalized)) {
    throw new TimelineRevisionRestoreError(
      'INVALID_TIMELINE_RESTORE_REQUEST',
      `${label} is invalid`,
    )
  }
  return normalized
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 8 || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TimelineRevisionRestoreError(
      'INVALID_TIMELINE_RESTORE_REQUEST',
      'Idempotency-Key is invalid',
    )
  }
  return normalized
}

function normalizeSummary(value: string | undefined, targetRevisionId: string): string {
  const normalized = value?.trim()
  return (normalized || `恢复时间线修订 ${targetRevisionId.slice(0, 8)}`).slice(0, 500)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requestHash(input: {
  projectId: string
  episodeId: string
  documentId: string
  targetRevisionId: string
  expectedRevisionId: string
  summary: string
}): string {
  return sha256(JSON.stringify({ version: 1, ...input }))
}

function recordFromRow(row: RestoreRow): TimelineRevisionRestoreRecord {
  return {
    id: requiredString(row, 'id'),
    documentId: requiredString(row, 'document_id'),
    projectId: requiredString(row, 'project_id'),
    episodeId: requiredString(row, 'episode_id'),
    baseRevisionId: requiredString(row, 'base_revision_id'),
    targetRevisionId: requiredString(row, 'target_revision_id'),
    resultRevisionId: requiredString(row, 'result_revision_id'),
    createdAt: requiredString(row, 'created_at'),
  }
}

function staleFromRow(row: RestoreRow): TimelineRevisionRestoreStaleResult {
  return {
    exports: requiredCount(row, 'stale_exports'),
    qualityReports: requiredCount(row, 'stale_quality_reports'),
    pipelineRuns: requiredCount(row, 'stale_pipeline_runs'),
    generationJobs: requiredCount(row, 'stale_generation_jobs'),
  }
}

function assertSnapshotScope(
  snapshot: TimelineDocumentSnapshot,
  input: Pick<RestoreTimelineRevisionInput, 'projectId' | 'episodeId' | 'documentId'>,
): void {
  if (snapshot.timelineDocument.id !== input.documentId
    || snapshot.timelineDocument.projectId !== input.projectId
    || snapshot.timelineDocument.episodeId !== input.episodeId
    || snapshot.revision.documentId !== input.documentId
    || snapshot.revision.projectId !== input.projectId
    || snapshot.revision.episodeId !== input.episodeId) {
    throw new TimelineRevisionRestoreError(
      'TIMELINE_RESTORE_SCOPE_MISMATCH',
      '时间线修订不属于当前项目、分集或文档',
    )
  }
}

function assertRestoreCompatible(
  current: TimelineDocumentSnapshot,
  target: TimelineDocumentSnapshot,
): void {
  if (target.timelineDocument.schemaVersion !== current.timelineDocument.schemaVersion
    || target.revision.schemaVersion !== current.revision.schemaVersion
    || target.timelineDocument.upstreamCommit !== current.timelineDocument.upstreamCommit
    || target.revision.upstreamCommit !== current.revision.upstreamCommit
    || target.timelineDocument.sourceRevisionId !== current.timelineDocument.sourceRevisionId
    || target.revision.sourceRevisionId !== current.revision.sourceRevisionId) {
    throw new TimelineRevisionRestoreError(
      'TIMELINE_RESTORE_INCOMPATIBLE',
      '历史修订的剧本源、OpenCut schema 或上游 commit 与当前时间线不一致',
    )
  }
}

export interface TimelineRevisionRestoreServiceOptions {
  now?: () => string
  idFactory?: () => string
}

/**
 * Restores an immutable historical snapshot by appending a new head revision.
 * The target and previous head are never moved or deleted. Idempotency and all
 * downstream staleness markers commit in the same SQLite transaction.
 */
export class TimelineRevisionRestoreService {
  private readonly now: () => string
  private readonly idFactory: () => string

  constructor(
    private readonly database: ManjuDatabase,
    private readonly timelines: TimelineDocumentService,
    options: TimelineRevisionRestoreServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
  }

  restore(raw: RestoreTimelineRevisionInput): RestoreTimelineRevisionResult {
    const input = {
      projectId: normalizeIdentifier(raw.projectId, 'projectId'),
      episodeId: normalizeIdentifier(raw.episodeId, 'episodeId'),
      documentId: normalizeIdentifier(raw.documentId, 'documentId'),
      targetRevisionId: normalizeIdentifier(raw.targetRevisionId, 'targetRevisionId'),
      expectedRevisionId: normalizeIdentifier(raw.expectedRevisionId, 'expectedRevisionId'),
      idempotencyKey: normalizeIdempotencyKey(raw.idempotencyKey),
      summary: normalizeSummary(raw.summary, raw.targetRevisionId),
    }
    const keyHash = sha256(input.idempotencyKey)
    const fingerprint = requestHash(input)

    return this.database.transaction(() => {
      const current = this.timelines.get(input.episodeId)
      assertSnapshotScope(current, input)

      const replayRow = this.database.withSql((sql) => sql.get(`
        SELECT * FROM timeline_revision_restores
        WHERE project_id = ? AND idempotency_key_hash = ?
      `, input.projectId, keyHash) as RestoreRow | undefined)
      if (replayRow) {
        if (requiredString(replayRow, 'request_hash') !== fingerprint) {
          throw new TimelineRevisionRestoreError(
            'TIMELINE_RESTORE_IDEMPOTENCY_CONFLICT',
            'Idempotency-Key 已被另一个时间线恢复请求使用',
          )
        }
        const restore = recordFromRow(replayRow)
        if (restore.projectId !== input.projectId
          || restore.episodeId !== input.episodeId
          || restore.documentId !== input.documentId
          || restore.baseRevisionId !== input.expectedRevisionId
          || restore.targetRevisionId !== input.targetRevisionId) {
          throw new TimelineRevisionRestoreError(
            'CORRUPT_TIMELINE_RESTORE',
            '幂等恢复记录与原请求绑定不一致',
          )
        }
        const operationResultTimeline = this.timelines.getRevision(restore.resultRevisionId)
        assertSnapshotScope(operationResultTimeline, input)
        return {
          timeline: current,
          operationResultTimeline,
          headAdvanced: current.revision.id !== operationResultTimeline.revision.id,
          restore,
          stale: staleFromRow(replayRow),
          idempotent: true,
        }
      }

      if (current.revision.id !== input.expectedRevisionId) {
        throw new TimelineDocumentError(
          'TIMELINE_DOCUMENT_CONFLICT',
          '时间线已在其他编辑会话中更新，未恢复历史修订',
          current.revision.id,
        )
      }
      const target = this.timelines.getRevision(input.targetRevisionId)
      assertSnapshotScope(target, input)
      assertRestoreCompatible(current, target)

      const restored = this.timelines.save({
        projectId: input.projectId,
        episodeId: input.episodeId,
        expectedRevisionId: current.revision.id,
        schemaVersion: current.timelineDocument.schemaVersion,
        upstreamCommit: current.timelineDocument.upstreamCommit,
        summary: input.summary,
        document: target.document,
      })
      if (restored.revision.parentRevisionId !== current.revision.id
        || restored.timelineDocument.sourceRevisionId !== current.timelineDocument.sourceRevisionId
        || restored.revision.sourceRevisionId !== current.revision.sourceRevisionId) {
        throw new TimelineRevisionRestoreError(
          'CORRUPT_TIMELINE_RESTORE',
          '时间线恢复未创建预期的新子修订',
        )
      }

      const now = this.now()
      const stale = this.database.withSql((sql) => {
        const generationJobs = sql.run(`
          UPDATE generation_jobs
          SET status = 'cancelled',
              error_json = json_object(
                'code', 'STALE_TIMELINE_REVISION',
                'message', '时间线已恢复为新修订，原生产任务已过期',
                'retryable', json('false'),
                'category', 'cancelled'
              ),
              completed_at = ?, updated_at = ?
          WHERE pipeline_run_id IN (
            SELECT id FROM pipeline_runs WHERE episode_id = ? AND status <> 'stale'
          )
            AND status IN ('queued', 'running', 'waiting_provider')
        `, now, now, input.episodeId).changes
        const exports = sql.run(`
          UPDATE exports SET status = 'stale', updated_at = ?
          WHERE episode_id = ? AND status <> 'stale'
        `, now, input.episodeId).changes
        const qualityReports = sql.run(`
          UPDATE quality_reports SET status = 'stale', passed = 0
          WHERE episode_id = ? AND status <> 'stale'
        `, input.episodeId).changes
        const pipelineRuns = sql.run(`
          UPDATE pipeline_runs
          SET status = 'stale',
              error_json = json_object(
                'code', 'STALE_TIMELINE_REVISION',
                'message', '时间线已恢复为新修订'
              ),
              updated_at = ?, completed_at = ?
          WHERE episode_id = ? AND status <> 'stale'
        `, now, now, input.episodeId).changes
        return { exports, qualityReports, pipelineRuns, generationJobs }
      })

      const restore: TimelineRevisionRestoreRecord = {
        id: this.idFactory(),
        documentId: input.documentId,
        projectId: input.projectId,
        episodeId: input.episodeId,
        baseRevisionId: current.revision.id,
        targetRevisionId: target.revision.id,
        resultRevisionId: restored.revision.id,
        createdAt: now,
      }
      this.database.withSql((sql) => sql.run(`
        INSERT INTO timeline_revision_restores (
          id, document_id, project_id, episode_id, base_revision_id,
          target_revision_id, result_revision_id, idempotency_key_hash,
          request_hash, stale_exports, stale_quality_reports,
          stale_pipeline_runs, stale_generation_jobs, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      restore.id,
      restore.documentId,
      restore.projectId,
      restore.episodeId,
      restore.baseRevisionId,
      restore.targetRevisionId,
      restore.resultRevisionId,
      keyHash,
      fingerprint,
      stale.exports,
      stale.qualityReports,
      stale.pipelineRuns,
      stale.generationJobs,
      restore.createdAt,
      ))

      return {
        timeline: restored,
        operationResultTimeline: restored,
        headAdvanced: false,
        restore,
        stale,
        idempotent: false,
      }
    })
  }
}
