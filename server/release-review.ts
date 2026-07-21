import { createHash, randomUUID } from 'node:crypto'

import type { ManjuDatabase } from './database.js'
import type { QualityDownloadAuthorization } from './quality-check.js'
import {
  QualityCheckError,
  QualityCheckService,
} from './quality-check.js'
import { validateCurrentQualityReleasePolicy } from './quality-release-policy.js'

export type ReleaseReviewDecision = 'approve' | 'reject'

export interface ReleaseReviewChecklist {
  audioVideoSync: boolean
  subtitleSyncAndComplete: boolean
  characterVisualSemantics: boolean
}

export interface ReleaseReviewRecord {
  id: string
  projectId: string
  episodeId: string
  exportId: string
  outputAssetId: string
  outputAssetChecksum: string
  timelineRevisionId: string
  storyRevisionId: string
  qualityReportId: string
  qualityPolicyVersion: number
  decision: ReleaseReviewDecision
  checklist: ReleaseReviewChecklist
  notes: string | null
  reviewedAt: string
}

interface StoredReleaseReviewRecord extends ReleaseReviewRecord {
  idempotencyKeyHash: string
  requestHash: string
}

export type ReleaseReviewInvalidReason =
  | 'SUPERSEDED'
  | 'QUALITY_NOT_CURRENT'
  | 'QUALITY_REPORT_CHANGED'
  | 'QUALITY_POLICY_CHANGED'
  | 'EXPORT_BINDING_CHANGED'
  | 'TIMELINE_REVISION_CHANGED'
  | 'STORY_REVISION_CHANGED'

export interface ReleaseReviewView extends ReleaseReviewRecord {
  isCurrent: boolean
  invalidReasons: ReleaseReviewInvalidReason[]
}

export interface CreateReleaseReviewInput {
  exportId: string
  idempotencyKey: string
  decision: ReleaseReviewDecision
  checklist: ReleaseReviewChecklist
  notes?: string | null
}

export interface CreateReleaseReviewResult {
  created: boolean
  releaseReview: ReleaseReviewView
}

export interface ReleaseDownloadAuthorization extends QualityDownloadAuthorization {
  releaseReview: ReleaseReviewView
}

export type ReleaseReviewErrorCode =
  | 'EXPORT_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_RELEASE_REVIEW'
  | 'RELEASE_REVIEW_REJECTED'
  | 'RELEASE_REVIEW_REQUIRED'
  | 'RELEASE_REVIEW_STALE'

export class ReleaseReviewError extends Error {
  constructor(readonly code: ReleaseReviewErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ReleaseReviewError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rowString(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not text`)
  return value
}

function rowNullableString(row: Record<string, unknown>, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not nullable text`)
  return value
}

function rowPositiveInteger(row: Record<string, unknown>, column: string): number {
  const value = row[column]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Database column ${column} is not a positive integer`)
  }
  return value
}

function parseChecklist(value: unknown): ReleaseReviewChecklist {
  if (!isPlainObject(value)) {
    throw new ReleaseReviewError('INVALID_RELEASE_REVIEW', '审片检查项必须是 JSON 对象')
  }
  const expected = [
    'audioVideoSync',
    'subtitleSyncAndComplete',
    'characterVisualSemantics',
  ] as const
  const unknown = Object.keys(value).filter((key) => !expected.includes(key as typeof expected[number]))
  if (unknown.length > 0) {
    throw new ReleaseReviewError(
      'INVALID_RELEASE_REVIEW',
      `不支持的审片检查项: ${unknown.join(', ')}`,
    )
  }
  for (const key of expected) {
    if (typeof value[key] !== 'boolean') {
      throw new ReleaseReviewError('INVALID_RELEASE_REVIEW', `${key} 必须是布尔值`)
    }
  }
  return {
    audioVideoSync: value.audioVideoSync as boolean,
    subtitleSyncAndComplete: value.subtitleSyncAndComplete as boolean,
    characterVisualSemantics: value.characterVisualSemantics as boolean,
  }
}

function recordFromRow(row: Record<string, unknown>): StoredReleaseReviewRecord {
  const decision = rowString(row, 'decision')
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error(`Database contains unsupported release review decision: ${decision}`)
  }
  const checklistText = rowString(row, 'checklist_json')
  let checklistValue: unknown
  try {
    checklistValue = JSON.parse(checklistText)
  } catch (error) {
    throw new Error('Database release review checklist is invalid JSON', { cause: error })
  }
  let checklist: ReleaseReviewChecklist
  try {
    checklist = parseChecklist(checklistValue)
  } catch (error) {
    throw new Error('Database release review checklist does not match the schema', { cause: error })
  }
  return {
    id: rowString(row, 'id'),
    projectId: rowString(row, 'project_id'),
    episodeId: rowString(row, 'episode_id'),
    exportId: rowString(row, 'export_id'),
    outputAssetId: rowString(row, 'output_asset_id'),
    outputAssetChecksum: rowString(row, 'output_asset_checksum'),
    timelineRevisionId: rowString(row, 'timeline_revision_id'),
    storyRevisionId: rowString(row, 'story_revision_id'),
    qualityReportId: rowString(row, 'quality_report_id'),
    qualityPolicyVersion: rowPositiveInteger(row, 'quality_policy_version'),
    decision,
    checklist,
    notes: rowNullableString(row, 'notes'),
    idempotencyKeyHash: rowString(row, 'idempotency_key_hash'),
    requestHash: rowString(row, 'request_hash'),
    reviewedAt: rowString(row, 'reviewed_at'),
  }
}

function normalizedIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ReleaseReviewError('INVALID_RELEASE_REVIEW', `${label} 必须是字符串`)
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ReleaseReviewError('INVALID_RELEASE_REVIEW', `${label} 格式无效`)
  }
  return normalized
}

function normalizedNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new ReleaseReviewError('INVALID_RELEASE_REVIEW', 'notes 必须是字符串或 null')
  }
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new ReleaseReviewError('INVALID_RELEASE_REVIEW', 'notes 格式无效或超过 2000 字符')
  }
  return normalized
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function reviewRequestHash(input: {
  decision: ReleaseReviewDecision
  checklist: ReleaseReviewChecklist
  notes: string | null
}): string {
  return sha256(JSON.stringify({
    decision: input.decision,
    checklist: {
      audioVideoSync: input.checklist.audioVideoSync,
      subtitleSyncAndComplete: input.checklist.subtitleSyncAndComplete,
      characterVisualSemantics: input.checklist.characterVisualSemantics,
    },
    notes: input.notes,
  }))
}

function publicRecord(record: StoredReleaseReviewRecord): ReleaseReviewRecord {
  return {
    id: record.id,
    projectId: record.projectId,
    episodeId: record.episodeId,
    exportId: record.exportId,
    outputAssetId: record.outputAssetId,
    outputAssetChecksum: record.outputAssetChecksum,
    timelineRevisionId: record.timelineRevisionId,
    storyRevisionId: record.storyRevisionId,
    qualityReportId: record.qualityReportId,
    qualityPolicyVersion: record.qualityPolicyVersion,
    decision: record.decision,
    checklist: { ...record.checklist },
    notes: record.notes,
    reviewedAt: record.reviewedAt,
  }
}

export class ReleaseReviewRepository {
  constructor(private readonly database: ManjuDatabase) {}

  findByIdempotencyHash(exportId: string, idempotencyKeyHash: string): StoredReleaseReviewRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(`
      SELECT * FROM release_reviews
       WHERE export_id = ? AND idempotency_key_hash = ?
       LIMIT 1
    `, exportId, idempotencyKeyHash))
    return row ? recordFromRow(row) : undefined
  }

  latest(exportId: string): StoredReleaseReviewRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(`
      SELECT * FROM release_reviews
       WHERE export_id = ?
       ORDER BY reviewed_at DESC, rowid DESC
       LIMIT 1
    `, exportId))
    return row ? recordFromRow(row) : undefined
  }

  list(exportId: string): StoredReleaseReviewRecord[] {
    return this.database.withSql((sql) => sql.all(`
      SELECT * FROM release_reviews
       WHERE export_id = ?
       ORDER BY reviewed_at DESC, rowid DESC
    `, exportId)).map(recordFromRow)
  }

  insert(record: StoredReleaseReviewRecord): void {
    const changes = this.database.withSql((sql) => sql.run(`
      INSERT INTO release_reviews (
        id, project_id, episode_id, export_id, output_asset_id,
        output_asset_checksum, timeline_revision_id, story_revision_id,
        quality_report_id, quality_policy_version, decision, checklist_json,
        notes, idempotency_key_hash, request_hash, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    record.id,
    record.projectId,
    record.episodeId,
    record.exportId,
    record.outputAssetId,
    record.outputAssetChecksum,
    record.timelineRevisionId,
    record.storyRevisionId,
    record.qualityReportId,
    record.qualityPolicyVersion,
    record.decision,
    JSON.stringify(record.checklist),
    record.notes,
    record.idempotencyKeyHash,
    record.requestHash,
    record.reviewedAt,
    )).changes
    if (changes !== 1) throw new Error('Unable to persist release review')
  }
}

export interface ReleaseReviewServiceOptions {
  now?: () => string
  idFactory?: () => string
  repository?: ReleaseReviewRepository
}

export class ReleaseReviewService {
  private readonly now: () => string
  private readonly idFactory: () => string
  private readonly repository: ReleaseReviewRepository

  constructor(
    private readonly database: ManjuDatabase,
    private readonly qualityChecks: QualityCheckService,
    options: ReleaseReviewServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
    this.repository = options.repository ?? new ReleaseReviewRepository(database)
  }

  requireTechnicalAuthorization(exportId: string): QualityDownloadAuthorization {
    const authorized = this.qualityChecks.requireDownloadAuthorization(exportId)
    const policy = validateCurrentQualityReleasePolicy(authorized.report)
    if (!policy.ok) {
      throw new QualityCheckError(
        'QUALITY_CHECK_REQUIRED',
        `最新质检报告不符合当前发布策略：${policy.reason}，请重新质检`,
      )
    }
    return authorized
  }

  create(inputValue: CreateReleaseReviewInput): CreateReleaseReviewResult {
    const exportId = normalizedIdentifier(inputValue.exportId, 'exportId')
    const idempotencyKey = normalizedIdentifier(inputValue.idempotencyKey, 'Idempotency-Key')
    const decision = inputValue.decision
    if (decision !== 'approve' && decision !== 'reject') {
      throw new ReleaseReviewError('INVALID_RELEASE_REVIEW', 'decision 必须是 approve 或 reject')
    }
    const checklist = parseChecklist(inputValue.checklist)
    const values = Object.values(checklist)
    if (decision === 'approve' && values.some((value) => !value)) {
      throw new ReleaseReviewError('INVALID_RELEASE_REVIEW', '批准发行前必须确认全部审片检查项')
    }
    if (decision === 'reject' && values.every(Boolean)) {
      throw new ReleaseReviewError('INVALID_RELEASE_REVIEW', '驳回发行时至少需要一项检查不通过')
    }
    const notes = normalizedNotes(inputValue.notes)
    const idempotencyKeyHash = sha256(idempotencyKey)
    const requestHash = reviewRequestHash({ decision, checklist, notes })

    return this.database.transaction(() => {
      const existing = this.repository.findByIdempotencyHash(exportId, idempotencyKeyHash)
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ReleaseReviewError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key 已用于另一个不同的审片决定',
          )
        }
        return {
          created: false,
          releaseReview: this.decorate(existing, this.repository.latest(exportId)?.id),
        }
      }

      this.requireExportExists(exportId)
      const authorized = this.requireTechnicalAuthorization(exportId)
      const binding = authorized.report.document.binding
      const record: StoredReleaseReviewRecord = {
        id: this.idFactory(),
        projectId: authorized.export.projectId,
        episodeId: authorized.export.episodeId,
        exportId: authorized.export.id,
        outputAssetId: authorized.asset.id,
        outputAssetChecksum: authorized.asset.checksum!,
        timelineRevisionId: binding.timelineRevisionId,
        storyRevisionId: binding.storyRevisionId,
        qualityReportId: authorized.report.id,
        qualityPolicyVersion: authorized.report.document.policy.version,
        decision,
        checklist,
        notes,
        idempotencyKeyHash,
        requestHash,
        reviewedAt: this.now(),
      }
      const headReasons = this.headInvalidReasons(record)
      if (headReasons.length > 0) {
        throw new ReleaseReviewError(
          'RELEASE_REVIEW_STALE',
          `当前制作修订已变化（${headReasons.join(', ')}），请重新导出并质检后审片`,
        )
      }
      this.repository.insert(record)
      return {
        created: true,
        releaseReview: this.decorate(record, record.id, authorized),
      }
    })
  }

  list(exportIdValue: string): ReleaseReviewView[] {
    const exportId = normalizedIdentifier(exportIdValue, 'exportId')
    this.requireExportExists(exportId)
    const records = this.repository.list(exportId)
    const latestId = records[0]?.id
    return records.map((record) => this.decorate(record, latestId))
  }

  requireReleaseAuthorization(exportIdValue: string): ReleaseDownloadAuthorization {
    const exportId = normalizedIdentifier(exportIdValue, 'exportId')
    const authorized = this.requireTechnicalAuthorization(exportId)
    const latest = this.repository.latest(exportId)
    if (!latest) {
      throw new ReleaseReviewError(
        'RELEASE_REVIEW_REQUIRED',
        '成片已通过技术质检，但尚未完成人工发行复验',
      )
    }
    if (latest.decision === 'reject') {
      throw new ReleaseReviewError(
        'RELEASE_REVIEW_REJECTED',
        '最新人工发行复验已驳回，请修订、重新质检并再次审片',
      )
    }
    const releaseReview = this.decorate(latest, latest.id, authorized)
    if (!releaseReview.isCurrent) {
      throw new ReleaseReviewError(
        'RELEASE_REVIEW_STALE',
        `人工发行复验已因制作或质检变化失效（${releaseReview.invalidReasons.join(', ')}）`,
      )
    }
    return { ...authorized, releaseReview }
  }

  private decorate(
    record: StoredReleaseReviewRecord,
    latestId: string | undefined,
    knownAuthorization?: QualityDownloadAuthorization,
  ): ReleaseReviewView {
    const invalidReasons: ReleaseReviewInvalidReason[] = []
    if (latestId !== record.id) invalidReasons.push('SUPERSEDED')

    let authorized = knownAuthorization
    if (!authorized) {
      try {
        authorized = this.requireTechnicalAuthorization(record.exportId)
      } catch {
        invalidReasons.push('QUALITY_NOT_CURRENT')
      }
    }
    if (authorized) {
      const binding = authorized.report.document.binding
      if (authorized.report.id !== record.qualityReportId) {
        invalidReasons.push('QUALITY_REPORT_CHANGED')
      }
      if (authorized.report.document.policy.version !== record.qualityPolicyVersion) {
        invalidReasons.push('QUALITY_POLICY_CHANGED')
      }
      if (authorized.export.projectId !== record.projectId
        || authorized.export.episodeId !== record.episodeId
        || authorized.asset.id !== record.outputAssetId
        || authorized.asset.checksum !== record.outputAssetChecksum
        || binding.outputAssetId !== record.outputAssetId
        || binding.outputAssetChecksum !== record.outputAssetChecksum) {
        invalidReasons.push('EXPORT_BINDING_CHANGED')
      }
      if (binding.timelineRevisionId !== record.timelineRevisionId) {
        invalidReasons.push('TIMELINE_REVISION_CHANGED')
      }
      if (binding.storyRevisionId !== record.storyRevisionId) {
        invalidReasons.push('STORY_REVISION_CHANGED')
      }
    }
    invalidReasons.push(...this.headInvalidReasons(record))
    return {
      ...publicRecord(record),
      isCurrent: invalidReasons.length === 0,
      invalidReasons: [...new Set(invalidReasons)],
    }
  }

  private headInvalidReasons(record: ReleaseReviewRecord): ReleaseReviewInvalidReason[] {
    const row = this.database.withSql((sql) => sql.get(`
      SELECT
        episodes.source_revision_id AS story_revision_id,
        timeline_documents.current_revision_id AS timeline_revision_id
      FROM episodes
      LEFT JOIN timeline_documents
        ON timeline_documents.episode_id = episodes.id
       AND timeline_documents.project_id = episodes.project_id
      WHERE episodes.id = ? AND episodes.project_id = ?
      LIMIT 1
    `, record.episodeId, record.projectId))
    const reasons: ReleaseReviewInvalidReason[] = []
    if (row?.story_revision_id !== record.storyRevisionId) {
      reasons.push('STORY_REVISION_CHANGED')
    }
    if (row?.timeline_revision_id !== record.timelineRevisionId) {
      reasons.push('TIMELINE_REVISION_CHANGED')
    }
    return reasons
  }

  private requireExportExists(exportId: string): void {
    const row = this.database.withSql((sql) => sql.get(
      'SELECT id FROM exports WHERE id = ?',
      exportId,
    ))
    if (!row) {
      throw new ReleaseReviewError('EXPORT_NOT_FOUND', '导出记录不存在')
    }
  }
}
