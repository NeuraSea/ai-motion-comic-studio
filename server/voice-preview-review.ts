import { createHash, randomUUID } from 'node:crypto'

import type { GenerationJobRecord, ManjuDatabase, MediaAssetRecord } from './database.js'
import { CHARACTER_VOICE_PREVIEW_JOB_TYPE } from './character-voice-preview.js'
import { PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE } from './project-narrator-voice-preview.js'

export type VoicePreviewReviewDecision = 'approve' | 'reject'
export type VoicePreviewReviewSubjectType = 'character' | 'project_narrator'
export type VoicePreviewReviewInvalidReason =
  | 'SUPERSEDED'
  | 'STORY_REVISION_CHANGED'
  | 'PROVIDER_REVISION_CHANGED'
  | 'PREVIEW_BINDING_CHANGED'
  | 'PLAYBACK_EVIDENCE_LEGACY'

export interface VoicePreviewPlaybackEvidence {
  version: 'legacy-ended-v1' | 'html-media-played-v1'
  durationSeconds?: number
  ranges?: Array<{ startSeconds: number; endSeconds: number }>
}

interface CurrentVoicePreviewPlaybackEvidence extends VoicePreviewPlaybackEvidence {
  version: 'html-media-played-v1'
  durationSeconds: number
  ranges: Array<{ startSeconds: number; endSeconds: number }>
}

export interface VoicePreviewReviewRecord {
  id: string
  projectId: string
  episodeId: string
  subjectType: VoicePreviewReviewSubjectType
  subjectId: string
  previewJobId: string
  previewAssetId: string
  previewAssetChecksum: string
  voiceId: string
  providerId: string
  model: string
  providerConfigRevision: number
  catalogFingerprint: string
  storyRevisionId: string
  decision: VoicePreviewReviewDecision
  notes: string | null
  playbackCompletedAt: string
  playbackEvidence: VoicePreviewPlaybackEvidence
  reviewedAt: string
}

interface StoredVoicePreviewReviewRecord extends VoicePreviewReviewRecord {
  idempotencyKeyHash: string
  requestHash: string
}

export interface VoicePreviewReviewView extends VoicePreviewReviewRecord {
  isCurrent: boolean
  invalidReasons: VoicePreviewReviewInvalidReason[]
}

export interface CreateVoicePreviewReviewInput {
  projectId: string
  previewJobId: string
  idempotencyKey: string
  decision: VoicePreviewReviewDecision
  playbackCompleted: boolean
  playbackEvidence: unknown
  notes?: string | null
}

export interface CreateVoicePreviewReviewResult {
  created: boolean
  review: VoicePreviewReviewView
}

export type VoicePreviewReviewErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_VOICE_PREVIEW_REVIEW'
  | 'PREVIEW_ASSET_NOT_READY'
  | 'PREVIEW_JOB_NOT_FOUND'
  | 'PREVIEW_JOB_NOT_SUCCEEDED'
  | 'PREVIEW_PROJECT_MISMATCH'
  | 'UNSUPPORTED_PREVIEW_JOB'

export class VoicePreviewReviewError extends Error {
  constructor(readonly code: VoicePreviewReviewErrorCode, message: string) {
    super(message)
    this.name = 'VoicePreviewReviewError'
  }
}

type SqlRow = Record<string, unknown>

function rowString(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not text`)
  return value
}

function rowNullableString(row: SqlRow, column: string): string | null {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not nullable text`)
  return value
}

function rowPositiveInteger(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Database column ${column} is not a positive integer`)
  }
  return value
}

function normalizedIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new VoicePreviewReviewError('INVALID_VOICE_PREVIEW_REVIEW', `${label} 必须是字符串`)
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new VoicePreviewReviewError('INVALID_VOICE_PREVIEW_REVIEW', `${label} 格式无效`)
  }
  return normalized
}

function normalizedNotes(value: unknown, decision: VoicePreviewReviewDecision): string | null {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new VoicePreviewReviewError('INVALID_VOICE_PREVIEW_REVIEW', 'notes 必须是字符串或 null')
  }
  const notes = typeof value === 'string' ? value.trim() : ''
  if (notes.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)) {
    throw new VoicePreviewReviewError('INVALID_VOICE_PREVIEW_REVIEW', 'notes 格式无效或超过 2000 字符')
  }
  if (decision === 'reject' && !notes) {
    throw new VoicePreviewReviewError('INVALID_VOICE_PREVIEW_REVIEW', '淘汰试听时必须填写原因')
  }
  return notes || null
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const PLAYBACK_TOLERANCE_SECONDS = 0.2

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index])
}

function normalizedPlaybackEvidence(value: unknown): CurrentVoicePreviewPlaybackEvidence {
  const evidence = plainObject(value)
  if (!evidence
    || !exactKeys(evidence, ['version', 'durationSeconds', 'ranges'])
    || evidence.version !== 'html-media-played-v1'
    || typeof evidence.durationSeconds !== 'number'
    || !Number.isFinite(evidence.durationSeconds)
    || evidence.durationSeconds <= 0
    || evidence.durationSeconds > 600
    || !Array.isArray(evidence.ranges)
    || evidence.ranges.length < 1
    || evidence.ranges.length > 64) {
    throw new VoicePreviewReviewError(
      'INVALID_VOICE_PREVIEW_REVIEW',
      '完整播放证据格式无效',
    )
  }
  const durationSeconds = evidence.durationSeconds as number
  const ranges = evidence.ranges.map((value, index) => {
    const range = plainObject(value)
    if (!range
      || !exactKeys(range, ['startSeconds', 'endSeconds'])
      || typeof range.startSeconds !== 'number'
      || !Number.isFinite(range.startSeconds)
      || range.startSeconds < 0
      || typeof range.endSeconds !== 'number'
      || !Number.isFinite(range.endSeconds)
      || range.endSeconds <= range.startSeconds
      || range.endSeconds > durationSeconds + PLAYBACK_TOLERANCE_SECONDS) {
      throw new VoicePreviewReviewError(
        'INVALID_VOICE_PREVIEW_REVIEW',
        `完整播放证据的第 ${index + 1} 个区间无效`,
      )
    }
    return { startSeconds: range.startSeconds, endSeconds: range.endSeconds }
  })
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!
    if (index === 0 && range.startSeconds > PLAYBACK_TOLERANCE_SECONDS) {
      throw new VoicePreviewReviewError(
        'INVALID_VOICE_PREVIEW_REVIEW',
        '完整播放证据未从音频起点开始',
      )
    }
    const previous = ranges[index - 1]
    if (previous && (
      range.startSeconds < previous.startSeconds
      || range.startSeconds > previous.endSeconds + PLAYBACK_TOLERANCE_SECONDS
    )) {
      throw new VoicePreviewReviewError(
        'INVALID_VOICE_PREVIEW_REVIEW',
        '完整播放证据存在跳播或乱序区间',
      )
    }
  }
  if (ranges[ranges.length - 1]!.endSeconds
      < durationSeconds - PLAYBACK_TOLERANCE_SECONDS) {
    throw new VoicePreviewReviewError(
      'INVALID_VOICE_PREVIEW_REVIEW',
      '完整播放证据未覆盖音频结尾',
    )
  }
  return {
    version: 'html-media-played-v1',
    durationSeconds,
    ranges,
  }
}

function playbackEvidenceFromRow(row: SqlRow): VoicePreviewPlaybackEvidence {
  const raw = rowString(row, 'playback_evidence_json')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Database voice preview playback evidence is not JSON')
  }
  const value = plainObject(parsed)
  if (value?.version === 'legacy-ended-v1' && exactKeys(value, ['version'])) {
    return { version: 'legacy-ended-v1' }
  }
  try {
    return normalizedPlaybackEvidence(value)
  } catch (error) {
    throw new Error('Database voice preview playback evidence is invalid', { cause: error })
  }
}

function requestHashWithEvidence(
  decision: VoicePreviewReviewDecision,
  notes: string | null,
  playbackEvidence: CurrentVoicePreviewPlaybackEvidence,
): string {
  return sha256(JSON.stringify({ decision, notes, playbackCompleted: true, playbackEvidence }))
}

function recordFromRow(row: SqlRow): StoredVoicePreviewReviewRecord {
  const subjectType = rowString(row, 'subject_type')
  if (subjectType !== 'character' && subjectType !== 'project_narrator') {
    throw new Error(`Unsupported voice preview review subject: ${subjectType}`)
  }
  const decision = rowString(row, 'decision')
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error(`Unsupported voice preview review decision: ${decision}`)
  }
  return {
    id: rowString(row, 'id'),
    projectId: rowString(row, 'project_id'),
    episodeId: rowString(row, 'episode_id'),
    subjectType,
    subjectId: rowString(row, 'subject_id'),
    previewJobId: rowString(row, 'preview_job_id'),
    previewAssetId: rowString(row, 'preview_asset_id'),
    previewAssetChecksum: rowString(row, 'preview_asset_checksum'),
    voiceId: rowString(row, 'voice_id'),
    providerId: rowString(row, 'provider_id'),
    model: rowString(row, 'model'),
    providerConfigRevision: rowPositiveInteger(row, 'provider_config_revision'),
    catalogFingerprint: rowString(row, 'catalog_fingerprint'),
    storyRevisionId: rowString(row, 'story_revision_id'),
    decision,
    notes: rowNullableString(row, 'notes'),
    playbackCompletedAt: rowString(row, 'playback_completed_at'),
    playbackEvidence: playbackEvidenceFromRow(row),
    idempotencyKeyHash: rowString(row, 'idempotency_key_hash'),
    requestHash: rowString(row, 'request_hash'),
    reviewedAt: rowString(row, 'reviewed_at'),
  }
}

function publicRecord(record: StoredVoicePreviewReviewRecord): VoicePreviewReviewRecord {
  const { idempotencyKeyHash: _idempotencyKeyHash, requestHash: _requestHash, ...result } = record
  return result
}

function nextReviewTimestamp(proposed: string, previous: string | null): string {
  const proposedMs = Date.parse(proposed)
  const previousMs = previous === null ? Number.NaN : Date.parse(previous)
  return new Date(Math.max(
    Number.isFinite(proposedMs) ? proposedMs : Date.now(),
    Number.isFinite(previousMs) ? previousMs + 1 : 0,
  )).toISOString()
}

function outputAssetId(job: GenerationJobRecord): string | null {
  const asset = job.output?.asset
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return null
  return typeof asset.id === 'string' && asset.id ? asset.id : null
}

function requiredInputString(job: GenerationJobRecord, key: string): string {
  const value = job.input[key]
  if (typeof value !== 'string' || !value) {
    throw new VoicePreviewReviewError(
      'PREVIEW_ASSET_NOT_READY',
      `试听任务缺少不可变 ${key} 绑定，不能创建验收记录`,
    )
  }
  return value
}

function resolveSubject(job: GenerationJobRecord): {
  subjectType: VoicePreviewReviewSubjectType
  subjectId: string
} {
  if (job.type === CHARACTER_VOICE_PREVIEW_JOB_TYPE) {
    return { subjectType: 'character', subjectId: requiredInputString(job, 'characterId') }
  }
  if (job.type === PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE) {
    return { subjectType: 'project_narrator', subjectId: job.projectId }
  }
  throw new VoicePreviewReviewError('UNSUPPORTED_PREVIEW_JOB', '该任务不是角色或项目旁白试听')
}

export class VoicePreviewReviewService {
  private readonly now: () => string
  private readonly idFactory: () => string

  constructor(
    private readonly database: ManjuDatabase,
    options: { now?: () => string; idFactory?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
  }

  create(inputValue: CreateVoicePreviewReviewInput): CreateVoicePreviewReviewResult {
    const projectId = normalizedIdentifier(inputValue.projectId, 'projectId')
    const previewJobId = normalizedIdentifier(inputValue.previewJobId, 'previewJobId')
    const idempotencyKey = normalizedIdentifier(inputValue.idempotencyKey, 'Idempotency-Key')
    const decision = inputValue.decision
    if (decision !== 'approve' && decision !== 'reject') {
      throw new VoicePreviewReviewError(
        'INVALID_VOICE_PREVIEW_REVIEW',
        'decision 必须是 approve 或 reject',
      )
    }
    if (inputValue.playbackCompleted !== true) {
      throw new VoicePreviewReviewError(
        'INVALID_VOICE_PREVIEW_REVIEW',
        '必须完整播放当前试听音频后才能提交验收决定',
      )
    }
    const notes = normalizedNotes(inputValue.notes, decision)
    const playbackEvidence = normalizedPlaybackEvidence(inputValue.playbackEvidence)
    const idempotencyKeyHash = sha256(idempotencyKey)
    const hash = requestHashWithEvidence(decision, notes, playbackEvidence)

    return this.database.transaction(() => {
      const existingRow = this.database.withSql((sql) => sql.get(`
        SELECT * FROM voice_preview_reviews
         WHERE project_id = ? AND idempotency_key_hash = ?
         LIMIT 1
      `, projectId, idempotencyKeyHash))
      if (existingRow) {
        const existing = recordFromRow(existingRow)
        if (existing.previewJobId !== previewJobId || existing.requestHash !== hash) {
          throw new VoicePreviewReviewError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key 已用于另一个不同的试听验收决定',
          )
        }
        return { created: false, review: this.decorate(existing) }
      }

      const { job, asset } = this.requireReviewablePreview(projectId, previewJobId)
      if (asset.durationSeconds === null
        || !Number.isFinite(asset.durationSeconds)
        || asset.durationSeconds <= 0
        || Math.abs(asset.durationSeconds - playbackEvidence.durationSeconds) > 0.25) {
        throw new VoicePreviewReviewError(
          'INVALID_VOICE_PREVIEW_REVIEW',
          '播放证据时长与受控试听 Asset 不一致',
        )
      }
      const subject = resolveSubject(job)
      const latestReview = this.database.withSql((sql) => sql.get(`
        SELECT reviewed_at FROM voice_preview_reviews
         WHERE preview_job_id = ?
         ORDER BY reviewed_at DESC, id DESC
         LIMIT 1
      `, previewJobId))
      const reviewedAt = nextReviewTimestamp(
        this.now(),
        typeof latestReview?.reviewed_at === 'string' ? latestReview.reviewed_at : null,
      )
      const record: StoredVoicePreviewReviewRecord = {
        id: this.idFactory(),
        projectId,
        episodeId: job.episodeId!,
        ...subject,
        previewJobId,
        previewAssetId: asset.id,
        previewAssetChecksum: asset.checksum!,
        voiceId: requiredInputString(job, 'voiceId'),
        providerId: job.providerId!,
        model: job.model!,
        providerConfigRevision: job.providerConfigRevision!,
        catalogFingerprint: requiredInputString(job, 'expectedCatalogFingerprint'),
        storyRevisionId: requiredInputString(job, 'expectedStoryRevisionId'),
        decision,
        notes,
        playbackCompletedAt: reviewedAt,
        playbackEvidence,
        idempotencyKeyHash,
        requestHash: hash,
        reviewedAt,
      }
      this.database.withSql((sql) => sql.run(`
        INSERT INTO voice_preview_reviews (
          id, project_id, episode_id, subject_type, subject_id,
          preview_job_id, preview_asset_id, preview_asset_checksum, voice_id,
          provider_id, model, provider_config_revision, catalog_fingerprint,
          story_revision_id, decision, notes, playback_completed_at, playback_evidence_json,
          idempotency_key_hash, request_hash, reviewed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.id,
      record.projectId,
      record.episodeId,
      record.subjectType,
      record.subjectId,
      record.previewJobId,
      record.previewAssetId,
      record.previewAssetChecksum,
      record.voiceId,
      record.providerId,
      record.model,
      record.providerConfigRevision,
      record.catalogFingerprint,
      record.storyRevisionId,
      record.decision,
      record.notes,
      record.playbackCompletedAt,
      JSON.stringify(record.playbackEvidence),
      record.idempotencyKeyHash,
      record.requestHash,
      record.reviewedAt,
      ))
      return { created: true, review: this.decorate(record) }
    })
  }

  list(projectIdValue: string, previewJobIdValue: string): VoicePreviewReviewView[] {
    const projectId = normalizedIdentifier(projectIdValue, 'projectId')
    const previewJobId = normalizedIdentifier(previewJobIdValue, 'previewJobId')
    const job = this.database.getGenerationJob(previewJobId)
    if (!job) throw new VoicePreviewReviewError('PREVIEW_JOB_NOT_FOUND', '试听任务不存在')
    if (job.projectId !== projectId) {
      throw new VoicePreviewReviewError('PREVIEW_PROJECT_MISMATCH', '试听任务不属于指定项目')
    }
    resolveSubject(job)
    return this.database.withSql((sql) => sql.all(`
      SELECT * FROM voice_preview_reviews
       WHERE project_id = ? AND preview_job_id = ?
       ORDER BY reviewed_at DESC, id DESC
    `, projectId, previewJobId)).map(recordFromRow).map((record) => this.decorate(record))
  }

  private decorate(record: StoredVoicePreviewReviewRecord): VoicePreviewReviewView {
    const invalidReasons: VoicePreviewReviewInvalidReason[] = []
    if (record.playbackEvidence.version !== 'html-media-played-v1') {
      invalidReasons.push('PLAYBACK_EVIDENCE_LEGACY')
    }
    const latest = this.database.withSql((sql) => sql.get(`
      SELECT id FROM voice_preview_reviews
       WHERE preview_job_id = ?
       ORDER BY reviewed_at DESC, id DESC
       LIMIT 1
    `, record.previewJobId))
    if (latest?.id !== record.id) invalidReasons.push('SUPERSEDED')

    const episode = this.database.withSql((sql) => sql.get(
      'SELECT source_revision_id FROM episodes WHERE id = ? AND project_id = ?',
      record.episodeId,
      record.projectId,
    ))
    if (episode?.source_revision_id !== record.storyRevisionId) {
      invalidReasons.push('STORY_REVISION_CHANGED')
    }
    const provider = this.database.getProviderConnection(record.providerId)
    if (!provider || provider.configRevision !== record.providerConfigRevision) {
      invalidReasons.push('PROVIDER_REVISION_CHANGED')
    }
    try {
      this.requireReviewablePreview(record.projectId, record.previewJobId, record)
    } catch {
      invalidReasons.push('PREVIEW_BINDING_CHANGED')
    }
    return {
      ...publicRecord(record),
      isCurrent: invalidReasons.length === 0,
      invalidReasons: [...new Set(invalidReasons)],
    }
  }

  private requireReviewablePreview(
    projectId: string,
    previewJobId: string,
    expected?: VoicePreviewReviewRecord,
  ): { job: GenerationJobRecord; asset: MediaAssetRecord } {
    const job = this.database.getGenerationJob(previewJobId)
    if (!job) throw new VoicePreviewReviewError('PREVIEW_JOB_NOT_FOUND', '试听任务不存在')
    if (job.projectId !== projectId) {
      throw new VoicePreviewReviewError('PREVIEW_PROJECT_MISMATCH', '试听任务不属于指定项目')
    }
    resolveSubject(job)
    if (job.status !== 'succeeded') {
      throw new VoicePreviewReviewError('PREVIEW_JOB_NOT_SUCCEEDED', '试听任务尚未成功完成')
    }
    if (!job.episodeId || !job.providerId || !job.model || !job.providerConfigRevision) {
      throw new VoicePreviewReviewError('PREVIEW_ASSET_NOT_READY', '试听任务缺少完整 Provider 绑定')
    }
    const assetId = outputAssetId(job)
    const asset = assetId ? this.database.getMediaAsset(assetId) : undefined
    if (!asset
      || asset.projectId !== projectId
      || asset.episodeId !== job.episodeId
      || asset.generationJobId !== job.id
      || asset.status !== 'ready'
      || !asset.checksum
      || !/^[0-9a-f]{64}$/.test(asset.checksum)) {
      throw new VoicePreviewReviewError('PREVIEW_ASSET_NOT_READY', '试听音频 Asset 尚未就绪或绑定无效')
    }
    if (expected && (
      expected.previewAssetId !== asset.id
      || expected.previewAssetChecksum !== asset.checksum
      || expected.voiceId !== job.input.voiceId
      || expected.catalogFingerprint !== job.input.expectedCatalogFingerprint
      || expected.storyRevisionId !== job.input.expectedStoryRevisionId
      || expected.providerId !== job.providerId
      || expected.model !== job.model
      || expected.providerConfigRevision !== job.providerConfigRevision
    )) {
      throw new VoicePreviewReviewError('PREVIEW_ASSET_NOT_READY', '试听任务或音频绑定已变化')
    }
    return { job, asset }
  }
}
