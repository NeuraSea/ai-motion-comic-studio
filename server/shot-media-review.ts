import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type {
  GenerationJobRecord,
  ManjuDatabase,
  MediaAssetRecord,
} from './database.js'
import { episodeEtag, episodeVersionMatches } from './episode-version.js'
import {
  isShotVideoReferenceDecision,
  validateCurrentAgenticReferenceDecision,
} from './shot-video-reference-recommendation.js'
import type { JsonValue } from './types.js'

export type ShotMediaType = 'storyboard' | 'video'
export type ShotMediaReviewDecision = 'adopt' | 'reject' | 'restore'
export const SHOT_VIDEO_HISTORY_ADOPTION_JOB_TYPE = 'shot.video.history.adopt'

export interface ShotMediaReviewScope {
  projectId: string
  episodeId: string
  shotId: string
  sceneId?: string
  mediaType: ShotMediaType
}

export interface ListShotMediaReviewInput extends ShotMediaReviewScope {
  limit?: number
  offset?: number
}

export interface DecideShotMediaInput extends ShotMediaReviewScope {
  decision: ShotMediaReviewDecision
  assetId: string
  note?: string
  expectedEpisodeVersion: string
  idempotencyKey: string
}

export interface ShotMediaCandidate {
  id: string
  projectId: string
  episodeId: string
  kind: string
  version: number
  status: string
  mimeType: string
  width: number | null
  height: number | null
  durationSeconds: number | null
  checksum: string
  sourceRevisionId: string
  parentAssetId: string | null
  generationJobId: string
  url: string
  createdAt: string
  selected: boolean
  eligible: boolean
  eligibilityError: string | null
  lastDecision: ShotMediaReviewDecision | null
}

export interface ShotMediaReviewRecord {
  id: string
  projectId: string
  episodeId: string
  databaseShotId: string
  shotId: string
  sceneId: string
  sourceRevisionId: string
  mediaType: ShotMediaType
  decision: ShotMediaReviewDecision
  assetId: string
  previousAssetId: string | null
  selectedAssetId: string | null
  /** Selected video pointer cleared because a storyboard change invalidated its provenance. */
  clearedVideoAssetId: string | null
  note: string | null
  timelineReconcileRequired: boolean
  stale: {
    generationJobs: number
    /** Active exact-same-shot shot.video.generate Jobs cancelled by a storyboard change. */
    shotVideoJobs: number
    exports: number
    qualityReports: number
    pipelineRuns: number
  }
  createdAt: string
}

export interface ShotMediaReviewSnapshot {
  projectId: string
  episodeId: string
  databaseShotId: string
  shotId: string
  sceneId: string
  sourceRevisionId: string
  mediaType: ShotMediaType
  episodeEtag: string
  currentSelection: ShotMediaCandidate | null
  currentSelectionAssetId: string | null
  candidates: ShotMediaCandidate[]
  history: ShotMediaReviewRecord[]
  pagination: { limit: number; offset: number }
}

export interface ShotMediaDecisionResult {
  review: ShotMediaReviewRecord
  episodeEtag: string
  currentSelectionAssetId: string | null
  clearedVideoAssetId: string | null
  timelineReconcileRequired: boolean
  idempotent: boolean
  headAdvanced: boolean
}

export type ShotMediaReviewErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'EPISODE_NOT_FOUND'
  | 'SHOT_NOT_FOUND'
  | 'AMBIGUOUS_SHOT_ID'
  | 'SOURCE_REVISION_MISSING'
  | 'PRECONDITION_FAILED'
  | 'ASSET_NOT_FOUND'
  | 'INVALID_MEDIA_CANDIDATE'
  | 'MEDIA_ALREADY_SELECTED'
  | 'SELECTED_MEDIA_CANNOT_BE_REJECTED'
  | 'RESTORE_HISTORY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CORRUPT_MEDIA_REVIEW'

export class ShotMediaReviewError extends Error {
  constructor(
    readonly code: ShotMediaReviewErrorCode,
    message: string,
    readonly details?: JsonValue,
  ) {
    super(message)
    this.name = 'ShotMediaReviewError'
  }
}

type SqlRow = Record<string, unknown>

interface DurableShotScope {
  projectId: string
  episodeId: string
  databaseShotId: string
  publicShotId: string
  publicSceneId: string
  sourceRevisionId: string
  episodeUpdatedAt: string
  storyboardAssetId: string | null
  videoAssetId: string | null
}

interface DurableVideoReferencePin {
  assetId: string
  role: 'first_frame' | 'last_frame' | 'reference_image'
  version: number
  checksum: string
  sourceRevisionId: string
}

const PUBLIC_SHOT_ID = `CASE
  WHEN typeof(json_extract(shots.metadata_json, '$.storyId')) = 'text'
    AND length(trim(json_extract(shots.metadata_json, '$.storyId'))) > 0
  THEN json_extract(shots.metadata_json, '$.storyId')
  ELSE shots.id
END`

const PUBLIC_SCENE_ID = `CASE
  WHEN typeof(json_extract(scenes.metadata_json, '$.storyId')) = 'text'
    AND length(trim(json_extract(scenes.metadata_json, '$.storyId'))) > 0
  THEN json_extract(scenes.metadata_json, '$.storyId')
  ELSE scenes.id
END`

const IMAGE_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm'])
const MAX_PAGE_SIZE = 200

function text(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value) {
    throw new ShotMediaReviewError('CORRUPT_MEDIA_REVIEW', `字段 ${key} 无效`)
  }
  return value
}

function nullableText(row: SqlRow, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new ShotMediaReviewError('CORRUPT_MEDIA_REVIEW', `字段 ${key} 无效`)
  }
  return value
}

function count(row: SqlRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ShotMediaReviewError('CORRUPT_MEDIA_REVIEW', `字段 ${key} 无效`)
  }
  return value
}

function asMediaType(value: unknown): ShotMediaType {
  if (value === 'storyboard' || value === 'video') return value
  throw new ShotMediaReviewError('CORRUPT_MEDIA_REVIEW', '审片媒体类型无效')
}

function asDecision(value: unknown): ShotMediaReviewDecision {
  if (value === 'adopt' || value === 'reject' || value === 'restore') return value
  throw new ShotMediaReviewError('CORRUPT_MEDIA_REVIEW', '审片决策类型无效')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nextEpisodeUpdatedAt(previous: string, proposed: string): string {
  const previousMs = Date.parse(previous)
  const proposedMs = Date.parse(proposed)
  return new Date(Math.max(
    Number.isFinite(proposedMs) ? proposedMs : Date.now(),
    Number.isFinite(previousMs) ? previousMs + 1 : 0,
  )).toISOString()
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requestHash(input: DecideShotMediaInput): string {
  return sha256(JSON.stringify({
    version: 1,
    projectId: input.projectId,
    episodeId: input.episodeId,
    shotId: input.shotId,
    sceneId: input.sceneId ?? null,
    mediaType: input.mediaType,
    decision: input.decision,
    assetId: input.assetId,
    note: input.note?.trim() || null,
    expectedEpisodeVersion: input.expectedEpisodeVersion,
  }))
}

function currentAssetId(scope: DurableShotScope, mediaType: ShotMediaType): string | null {
  return mediaType === 'storyboard' ? scope.storyboardAssetId : scope.videoAssetId
}

function bindingFor(job: GenerationJobRecord, mediaType: ShotMediaType): Record<string, unknown> | null {
  const raw = mediaType === 'storyboard' ? job.input.storyboardBinding : job.input.binding
  return isRecord(raw) ? raw : null
}

function videoReferenceProvenanceError(
  database: ManjuDatabase,
  asset: MediaAssetRecord,
  job: GenerationJobRecord,
  scope: DurableShotScope,
): string | null {
  const decision = job.input.referenceDecision
  if (!isShotVideoReferenceDecision(decision)) {
    return '候选视频缺少完整的参考图决策来源'
  }
  if (decision.recommendation.shotId !== scope.publicShotId
    || decision.recommendation.sceneId !== scope.publicSceneId
    || decision.recommendation.sourceRevisionId !== scope.sourceRevisionId) {
    return '候选视频的参考图决策不属于当前 Scene/Shot/source revision'
  }
  const publishedDecision = asset.generationParameters.referenceDecision
  if (!isShotVideoReferenceDecision(publishedDecision)
    || !isDeepStrictEqual(publishedDecision, decision)) {
    return '候选视频的 Job 决策与 Asset 发布元数据不一致'
  }
  if (!validateCurrentAgenticReferenceDecision(database, {
    projectId: scope.projectId,
    episodeId: scope.episodeId,
    sourceRevisionId: scope.sourceRevisionId,
    databaseShotId: scope.databaseShotId,
    decision,
  })) {
    return '候选视频的角色参考槽位或分镜锚点已发生变化'
  }

  const referencesValue = job.input.references
  if (referencesValue !== undefined
    && (!Array.isArray(referencesValue) || referencesValue.length === 0)) {
    return '候选视频的持久参考图绑定不完整'
  }
  const rawReferences = referencesValue === undefined ? [] : referencesValue
  if (rawReferences.some((reference) => !isRecord(reference)
    || typeof reference.assetId !== 'string'
    || !['first_frame', 'last_frame', 'reference_image'].includes(String(reference.role))
    || !Number.isInteger(reference.version)
    || (reference.version as number) < 1
    || typeof reference.checksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(reference.checksum)
    || reference.sourceRevisionId !== scope.sourceRevisionId)) {
    return '候选视频的持久参考图 version/checksum/source revision 绑定无效'
  }
  const references = rawReferences as unknown as DurableVideoReferencePin[]
  if (decision.selectedReferences.length !== references.length
    || decision.selectedReferences.some((reference, index) => (
      reference.assetId !== references[index]?.assetId
      || reference.role !== references[index]?.role
    ))) {
    return '候选视频的参考图决策与持久 Job 绑定互相矛盾'
  }

  const publishedReferences = asset.generationParameters.referenceAssets
  if (references.length === 0) {
    if (publishedReferences !== undefined
      || decision.storyboardAnchorAssetId !== null
      || (decision.source === 'agentic_auto'
        ? decision.resolution !== 'not_applicable'
          || decision.recommendation.status !== 'not_applicable'
        : decision.resolution !== 'manual_override')) {
      return '候选视频无参考图但未固化为明确的独立文生视频'
    }
  } else if (!Array.isArray(publishedReferences)
    || !isDeepStrictEqual(publishedReferences, references)) {
    return '候选视频的 Job 参考图与 Asset 发布元数据不一致'
  }

  const storyboardReferenceIds: string[] = []
  for (const reference of references) {
    const referenceAsset = database.getMediaAsset(reference.assetId)
    if (!referenceAsset
      || referenceAsset.projectId !== scope.projectId
      || referenceAsset.sourceRevisionId !== scope.sourceRevisionId
      || referenceAsset.status !== 'ready'
      || referenceAsset.version !== reference.version
      || referenceAsset.checksum !== reference.checksum) {
      return '候选视频的参考图 Asset version/checksum/source revision 已漂移'
    }
    if (referenceAsset.kind === 'storyboard') {
      storyboardReferenceIds.push(referenceAsset.id)
      const referenceJob = referenceAsset.generationJobId
        ? database.getGenerationJob(referenceAsset.generationJobId)
        : undefined
      const storyboardError = candidateError(
        database,
        referenceAsset,
        referenceJob,
        scope,
        'storyboard',
      )
      if (storyboardError) {
        return `候选视频引用的分镜图来源无效：${storyboardError}`
      }
    }
  }

  if (decision.storyboardAnchorAssetId !== null) {
    const anchor = database.getMediaAsset(decision.storyboardAnchorAssetId)
    if (!anchor
      || anchor.id !== scope.storyboardAssetId
      || anchor.projectId !== scope.projectId
      || anchor.episodeId !== scope.episodeId
      || anchor.sourceRevisionId !== scope.sourceRevisionId
      || anchor.kind !== 'storyboard'
      || anchor.status !== 'ready') {
      return '候选视频的分镜锚点已不是当前镜头选中版本'
    }
  }
  if (decision.source === 'agentic_auto'
    && storyboardReferenceIds.length > 0
    && decision.storyboardAnchorAssetId !== scope.storyboardAssetId) {
    return '候选视频的 Agentic 分镜锚点与实际参考图互相矛盾'
  }
  return null
}

function candidateError(
  database: ManjuDatabase,
  asset: MediaAssetRecord,
  job: GenerationJobRecord | undefined,
  scope: DurableShotScope,
  mediaType: ShotMediaType,
): string | null {
  if (asset.projectId !== scope.projectId
    || asset.episodeId !== scope.episodeId
    || asset.sourceRevisionId !== scope.sourceRevisionId) {
    return '候选资产不属于当前项目、分集或剧本修订'
  }
  if (asset.status !== 'ready') return '候选资产尚未处于 ready 状态'
  if (!asset.checksum || !/^[a-f0-9]{64}$/.test(asset.checksum)) return '候选资产缺少可校验的不可变 checksum'
  if (mediaType === 'storyboard') {
    if (asset.kind !== 'storyboard' || !asset.mimeType || !IMAGE_MIME_TYPES.has(asset.mimeType)) {
      return '候选资产不是受支持的分镜图片'
    }
  } else if (asset.kind !== 'shot.video' || !asset.mimeType || !VIDEO_MIME_TYPES.has(asset.mimeType)) {
    return '候选资产不是受支持的逐镜视频'
  }
  if (!asset.generationJobId || !job
    || job.id !== asset.generationJobId
    || job.projectId !== scope.projectId
    || job.episodeId !== scope.episodeId
    || job.status !== 'succeeded') {
    return '候选资产缺少已成功的同分集持久生成任务绑定'
  }
  const metadata = isRecord(job.input.metadata) ? job.input.metadata : null
  const historicalAdoption = isRecord(job.input.historyAdoption)
    ? job.input.historyAdoption
    : null
  const isHistoricalVideoAdoption = mediaType === 'video'
    && job.type === 'shot.video.generate'
    && job.input.operation === SHOT_VIDEO_HISTORY_ADOPTION_JOB_TYPE
  if (isHistoricalVideoAdoption) {
    const sourceAssetId = historicalAdoption
      && typeof historicalAdoption.sourceAssetId === 'string'
      ? historicalAdoption.sourceAssetId
      : null
    const priorSourceRevisionId = historicalAdoption
      && typeof historicalAdoption.priorSourceRevisionId === 'string'
      ? historicalAdoption.priorSourceRevisionId
      : null
    const currentSourceRevisionId = historicalAdoption
      && typeof historicalAdoption.currentSourceRevisionId === 'string'
      ? historicalAdoption.currentSourceRevisionId
      : null
    const sourceAsset = sourceAssetId ? database.getMediaAsset(sourceAssetId) : undefined
    const priorRevision = priorSourceRevisionId
      ? database.getRevision(priorSourceRevisionId)
      : undefined
    const currentRevision = currentSourceRevisionId
      ? database.getRevision(currentSourceRevisionId)
      : undefined
    if (!historicalAdoption
      || historicalAdoption.providerCallRequired !== false
      || !sourceAsset
      || asset.parentAssetId !== sourceAsset.id
      || sourceAsset.projectId !== scope.projectId
      || sourceAsset.episodeId !== scope.episodeId
      || sourceAsset.kind !== 'shot.video'
      || sourceAsset.checksum !== asset.checksum
      || sourceAsset.mimeType !== asset.mimeType
      || sourceAsset.width !== asset.width
      || sourceAsset.height !== asset.height
      || sourceAsset.durationSeconds !== asset.durationSeconds
      || sourceAsset.sourceRevisionId !== priorSourceRevisionId
      || currentSourceRevisionId !== scope.sourceRevisionId
      || !priorRevision
      || !currentRevision
      || priorRevision.projectId !== scope.projectId
      || currentRevision.projectId !== scope.projectId
      || !isDeepStrictEqual(priorRevision.snapshot, currentRevision.snapshot)) {
      return '历史逐镜视频缺少可核验的当前修订收养链'
    }
  }
  if (mediaType === 'storyboard'
    ? job.type !== 'asset.image.generate' || metadata?.kind !== 'storyboard'
    : job.type !== 'shot.video.generate' && !isHistoricalVideoAdoption) {
    return '候选资产的生成任务类型不匹配'
  }
  const binding = bindingFor(job, mediaType)
  const expected = {
    databaseShotId: scope.databaseShotId,
    episodeId: scope.episodeId,
    shotId: scope.publicShotId,
    sceneId: scope.publicSceneId,
    expectedRevisionId: scope.sourceRevisionId,
  }
  if (!binding || Object.entries(expected).some(([key, value]) => binding[key] !== value)) {
    return '候选资产的持久任务未绑定当前准确 Scene/Shot/source revision'
  }
  const parameters = asset.generationParameters
  if (parameters.shotId !== scope.publicShotId || parameters.sceneId !== scope.publicSceneId) {
    return '候选资产的发布元数据与当前 Scene/Shot 不匹配'
  }
  if (mediaType === 'storyboard' && parameters.sourceRevisionId !== scope.sourceRevisionId) {
    return '候选分镜的发布元数据与当前剧本修订不匹配'
  }
  if (mediaType === 'video' && !isHistoricalVideoAdoption) {
    const referenceError = videoReferenceProvenanceError(database, asset, job, scope)
    if (referenceError) return referenceError
  }
  return null
}

/**
 * Fail closed when a selected video may have consumed the storyboard being
 * replaced. The only reusable case is a fully auditable text-only generation:
 * both the durable Job and the published Asset say there was no storyboard
 * anchor and no reference image at all. Historical/incomplete provenance is
 * deliberately not treated as proof of independence.
 */
function selectedVideoIsProvablyStoryboardIndependent(
  database: ManjuDatabase,
  asset: MediaAssetRecord,
  job: GenerationJobRecord | undefined,
  scope: DurableShotScope,
): boolean {
  if (candidateError(database, asset, job, scope, 'video') !== null || !job) return false
  if (job.input.references !== undefined) return false

  const decision = job.input.referenceDecision
  if (!isShotVideoReferenceDecision(decision)
    || decision.storyboardAnchorAssetId !== null
    || decision.selectedReferences.length !== 0
    || (decision.source === 'agentic_auto'
      ? decision.resolution !== 'not_applicable'
        || decision.recommendation.status !== 'not_applicable'
      : decision.resolution !== 'manual_override')) return false

  const publishedDecision = asset.generationParameters.referenceDecision
  if (!isShotVideoReferenceDecision(publishedDecision)
    || !isDeepStrictEqual(publishedDecision, decision)
    || asset.generationParameters.referenceAssets !== undefined) return false

  const jobSpec = job.input.spec
  if (jobSpec !== undefined
    && (!isRecord(jobSpec)
      || !Array.isArray(jobSpec.references)
      || jobSpec.references.length !== 0)) return false
  const publishedSpec = asset.generationParameters.videoGenerationSpec
  if (publishedSpec !== undefined
    && (!isRecord(publishedSpec)
      || !Array.isArray(publishedSpec.references)
      || publishedSpec.references.length !== 0)) return false
  return true
}

function decisionFromRow(row: SqlRow, scope?: DurableShotScope): ShotMediaReviewRecord {
  const databaseShotId = text(row, 'shot_id')
  return {
    id: text(row, 'id'),
    projectId: text(row, 'project_id'),
    episodeId: text(row, 'episode_id'),
    databaseShotId,
    shotId: scope?.publicShotId ?? databaseShotId,
    sceneId: scope?.publicSceneId ?? '',
    sourceRevisionId: text(row, 'source_revision_id'),
    mediaType: asMediaType(row.media_type),
    decision: asDecision(row.decision),
    assetId: text(row, 'asset_id'),
    previousAssetId: nullableText(row, 'previous_asset_id'),
    selectedAssetId: nullableText(row, 'selected_asset_id'),
    clearedVideoAssetId: nullableText(row, 'cleared_video_asset_id'),
    note: nullableText(row, 'note'),
    timelineReconcileRequired: row.timeline_reconcile_required === 1,
    stale: {
      generationJobs: count(row, 'stale_generation_jobs'),
      shotVideoJobs: count(row, 'stale_shot_video_jobs'),
      exports: count(row, 'stale_exports'),
      qualityReports: count(row, 'stale_quality_reports'),
      pipelineRuns: count(row, 'stale_pipeline_runs'),
    },
    createdAt: text(row, 'created_at'),
  }
}

function publicCandidate(
  asset: MediaAssetRecord,
  selectedAssetId: string | null,
  error: string | null,
  lastDecision: ShotMediaReviewDecision | null,
): ShotMediaCandidate {
  return {
    id: asset.id,
    projectId: asset.projectId,
    episodeId: asset.episodeId!,
    kind: asset.kind,
    version: asset.version,
    status: asset.status,
    mimeType: asset.mimeType ?? 'application/octet-stream',
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.durationSeconds,
    checksum: asset.checksum ?? '',
    sourceRevisionId: asset.sourceRevisionId ?? '',
    parentAssetId: asset.parentAssetId,
    generationJobId: asset.generationJobId ?? '',
    url: `/api/v1/assets/${encodeURIComponent(asset.id)}/content`,
    createdAt: asset.createdAt,
    selected: asset.id === selectedAssetId,
    eligible: error === null,
    eligibilityError: error,
    lastDecision,
  }
}

export class ShotMediaReviewRepository {
  constructor(private readonly database: ManjuDatabase) {}

  findByIdempotencyHash(projectId: string, keyHash: string): SqlRow | undefined {
    return this.database.withSql((sql) => sql.get(`
      SELECT * FROM shot_media_review_decisions
       WHERE project_id = ? AND idempotency_key_hash = ?
    `, projectId, keyHash))
  }

  listHistory(
    scope: Pick<DurableShotScope, 'projectId' | 'episodeId' | 'databaseShotId' | 'sourceRevisionId'>,
    mediaType: ShotMediaType,
    limit: number,
    offset: number,
  ): SqlRow[] {
    return this.database.withSql((sql) => sql.all(`
      SELECT * FROM shot_media_review_decisions
       WHERE project_id = ? AND episode_id = ? AND shot_id = ?
         AND source_revision_id = ? AND media_type = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?
    `,
    scope.projectId,
    scope.episodeId,
    scope.databaseShotId,
    scope.sourceRevisionId,
    mediaType,
    limit,
    offset,
    ))
  }

  insert(input: {
    id: string
    scope: DurableShotScope
    mediaType: ShotMediaType
    decision: ShotMediaReviewDecision
    assetId: string
    previousAssetId: string | null
    selectedAssetId: string | null
    clearedVideoAssetId: string | null
    note: string | null
    expectedEpisodeVersion: string
    keyHash: string
    requestHash: string
    timelineReconcileRequired: boolean
    stale: ShotMediaReviewRecord['stale']
    createdAt: string
  }): void {
    this.database.withSql((sql) => sql.run(`
      INSERT INTO shot_media_review_decisions (
        id, project_id, episode_id, shot_id, source_revision_id, media_type,
        decision, asset_id, previous_asset_id, selected_asset_id, note,
        expected_episode_version, idempotency_key_hash, request_hash,
        timeline_reconcile_required, cleared_video_asset_id,
        stale_generation_jobs, stale_shot_video_jobs, stale_exports,
        stale_quality_reports, stale_pipeline_runs, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.id,
    input.scope.projectId,
    input.scope.episodeId,
    input.scope.databaseShotId,
    input.scope.sourceRevisionId,
    input.mediaType,
    input.decision,
    input.assetId,
    input.previousAssetId,
    input.selectedAssetId,
    input.note,
    input.expectedEpisodeVersion,
    input.keyHash,
    input.requestHash,
    input.timelineReconcileRequired ? 1 : 0,
    input.clearedVideoAssetId,
    input.stale.generationJobs,
    input.stale.shotVideoJobs,
    input.stale.exports,
    input.stale.qualityReports,
    input.stale.pipelineRuns,
    input.createdAt,
    ))
  }
}

export interface ShotMediaReviewServiceOptions {
  now?: () => string
  idFactory?: () => string
}

export class ShotMediaReviewService {
  private readonly now: () => string
  private readonly idFactory: () => string
  private readonly repository: ShotMediaReviewRepository

  constructor(
    private readonly database: ManjuDatabase,
    options: ShotMediaReviewServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
    this.repository = new ShotMediaReviewRepository(database)
  }

  list(input: ListShotMediaReviewInput): ShotMediaReviewSnapshot {
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, input.limit ?? 100))
    const offset = Math.max(0, input.offset ?? 0)
    const scope = this.resolveScope(input)
    const selectedAssetId = currentAssetId(scope, input.mediaType)
    const historyRows = this.repository.listHistory(scope, input.mediaType, limit, offset)
    const history = historyRows.map((row) => decisionFromRow(row, scope))
    const latestByAsset = new Map<string, ShotMediaReviewDecision>()
    for (const review of this.repository.listHistory(scope, input.mediaType, MAX_PAGE_SIZE, 0)) {
      const assetId = text(review, 'asset_id')
      if (!latestByAsset.has(assetId)) latestByAsset.set(assetId, asDecision(review.decision))
    }
    const candidateIds = this.candidateIds(scope, input.mediaType, limit, offset)
    const candidates = candidateIds.map((assetId) => {
      const asset = this.database.getMediaAsset(assetId)
      if (!asset) throw new ShotMediaReviewError('CORRUPT_MEDIA_REVIEW', '候选资产已丢失')
      const job = asset.generationJobId
        ? this.database.getGenerationJob(asset.generationJobId)
        : undefined
      return publicCandidate(
        asset,
        selectedAssetId,
        candidateError(this.database, asset, job, scope, input.mediaType),
        latestByAsset.get(asset.id) ?? null,
      )
    })

    let currentSelection: ShotMediaCandidate | null = null
    if (selectedAssetId) {
      const selected = this.database.getMediaAsset(selectedAssetId)
      if (selected && selected.projectId === scope.projectId && selected.episodeId === scope.episodeId) {
        const job = selected.generationJobId
          ? this.database.getGenerationJob(selected.generationJobId)
          : undefined
        currentSelection = publicCandidate(
          selected,
          selectedAssetId,
          candidateError(this.database, selected, job, scope, input.mediaType),
          latestByAsset.get(selected.id) ?? null,
        )
      }
    }
    return {
      projectId: scope.projectId,
      episodeId: scope.episodeId,
      databaseShotId: scope.databaseShotId,
      shotId: scope.publicShotId,
      sceneId: scope.publicSceneId,
      sourceRevisionId: scope.sourceRevisionId,
      mediaType: input.mediaType,
      episodeEtag: episodeEtag({
        sourceRevisionId: scope.sourceRevisionId,
        updatedAt: scope.episodeUpdatedAt,
      }),
      currentSelection,
      currentSelectionAssetId: selectedAssetId,
      candidates,
      history,
      pagination: { limit, offset },
    }
  }

  decide(input: DecideShotMediaInput): ShotMediaDecisionResult {
    const normalized: DecideShotMediaInput = {
      ...input,
      note: input.note?.trim() || undefined,
    }
    const keyHash = sha256(normalized.idempotencyKey)
    const fingerprint = requestHash(normalized)
    return this.database.transaction(() => {
      const replay = this.repository.findByIdempotencyHash(normalized.projectId, keyHash)
      if (replay) {
        if (text(replay, 'request_hash') !== fingerprint) {
          throw new ShotMediaReviewError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key 已用于另一个逐镜媒体决策',
          )
        }
        return this.replayResult(replay, normalized)
      }

      const scope = this.resolveScope(normalized)
      if (!episodeVersionMatches({
        sourceRevisionId: scope.sourceRevisionId,
        updatedAt: scope.episodeUpdatedAt,
      }, normalized.expectedEpisodeVersion)) {
        throw new ShotMediaReviewError(
          'PRECONDITION_FAILED',
          '分集或镜头选版已更新，未采用候选素材',
          {
            currentEtag: episodeEtag({
              sourceRevisionId: scope.sourceRevisionId,
              updatedAt: scope.episodeUpdatedAt,
            }),
            currentRevisionId: scope.sourceRevisionId,
          },
        )
      }
      const asset = this.database.getMediaAsset(normalized.assetId)
      // Deliberately hide cross-project/cross-episode existence.
      if (!asset || asset.projectId !== scope.projectId || asset.episodeId !== scope.episodeId) {
        throw new ShotMediaReviewError(
          'ASSET_NOT_FOUND',
          '候选资产不存在或不属于当前项目与分集',
        )
      }
      const job = asset.generationJobId
        ? this.database.getGenerationJob(asset.generationJobId)
        : undefined
      const invalid = candidateError(this.database, asset, job, scope, normalized.mediaType)
      if (invalid) {
        throw new ShotMediaReviewError('INVALID_MEDIA_CANDIDATE', invalid, {
          assetId: asset.id,
          mediaType: normalized.mediaType,
        })
      }

      const previousAssetId = currentAssetId(scope, normalized.mediaType)
      // Generation currently publishes and links a successful Asset in one
      // atomic operation. A human still needs to be able to record an explicit
      // adoption of that already-current result. It is an audited no-op: the
      // Episode version advances, but valid downstream work is not staled.
      if (normalized.decision === 'restore' && previousAssetId === asset.id) {
        throw new ShotMediaReviewError(
          'MEDIA_ALREADY_SELECTED',
          '该候选已是当前镜头的选中版本',
        )
      }
      if (normalized.decision === 'reject' && previousAssetId === asset.id) {
        throw new ShotMediaReviewError(
          'SELECTED_MEDIA_CANNOT_BE_REJECTED',
          '当前选中版本不能只记录为拒绝；请先采用另一个候选',
        )
      }
      if (normalized.decision === 'restore' && !this.wasPreviouslySelected(scope, normalized.mediaType, asset.id)) {
        throw new ShotMediaReviewError(
          'RESTORE_HISTORY_REQUIRED',
          '只能恢复当前剧本修订下曾经选中过的镜头版本',
        )
      }

      const reviewId = this.idFactory()
      const selectionChanged = normalized.decision !== 'reject' && previousAssetId !== asset.id
      const selectedAssetId = normalized.decision === 'reject' ? previousAssetId : asset.id
      const createdAt = nextEpisodeUpdatedAt(scope.episodeUpdatedAt, this.now())
      const clearedVideoAssetId = selectionChanged
        && normalized.mediaType === 'storyboard'
        && scope.videoAssetId
        && !this.selectedVideoIsProvablyIndependent(scope)
        ? scope.videoAssetId
        : null
      if (selectionChanged) {
        const changed = normalized.mediaType === 'storyboard'
          ? this.database.withSql((sql) => sql.run(`
              UPDATE shots
                 SET storyboard_asset_id = ?,
                     video_asset_id = ?,
                     status = ?,
                     updated_at = ?
               WHERE id = ?
                 AND source_revision_id = ?
                 AND storyboard_asset_id IS ?
                 AND video_asset_id IS ?
            `,
            asset.id,
            clearedVideoAssetId ? null : scope.videoAssetId,
            clearedVideoAssetId || !scope.videoAssetId ? 'storyboard_ready' : 'video_ready',
            createdAt,
            scope.databaseShotId,
            scope.sourceRevisionId,
            previousAssetId,
            scope.videoAssetId,
            )).changes
          : this.database.withSql((sql) => sql.run(`
              UPDATE shots SET video_asset_id = ?, status = 'video_ready', updated_at = ?
               WHERE id = ? AND source_revision_id = ? AND video_asset_id IS ?
            `,
            asset.id,
            createdAt,
            scope.databaseShotId,
            scope.sourceRevisionId,
            previousAssetId,
            )).changes
        if (changed !== 1) {
          throw new ShotMediaReviewError(
            'PRECONDITION_FAILED',
            '镜头选中版本已并发变更，未采用候选素材',
          )
        }
      }

      const stale = selectionChanged
        ? this.markDownstreamStale(scope, normalized.mediaType, reviewId, asset.id, createdAt)
        : { generationJobs: 0, shotVideoJobs: 0, exports: 0, qualityReports: 0, pipelineRuns: 0 }
      const episodeChanged = this.database.withSql((sql) => sql.run(`
        UPDATE episodes SET updated_at = ?
         WHERE id = ? AND project_id = ? AND source_revision_id = ? AND updated_at = ?
      `,
      createdAt,
      scope.episodeId,
      scope.projectId,
      scope.sourceRevisionId,
      scope.episodeUpdatedAt,
      )).changes
      if (episodeChanged !== 1) {
        throw new ShotMediaReviewError(
          'PRECONDITION_FAILED',
          '分集在选版期间已变更，未写入审计决策',
        )
      }

      this.repository.insert({
        id: reviewId,
        scope,
        mediaType: normalized.mediaType,
        decision: normalized.decision,
        assetId: asset.id,
        previousAssetId,
        selectedAssetId,
        clearedVideoAssetId,
        note: normalized.note ?? null,
        expectedEpisodeVersion: normalized.expectedEpisodeVersion,
        keyHash,
        requestHash: fingerprint,
        timelineReconcileRequired: selectionChanged,
        stale,
        createdAt,
      })
      const row = this.repository.findByIdempotencyHash(normalized.projectId, keyHash)
      if (!row) throw new ShotMediaReviewError('CORRUPT_MEDIA_REVIEW', '审片记录写入后丢失')
      return {
        review: decisionFromRow(row, scope),
        episodeEtag: episodeEtag({
          sourceRevisionId: scope.sourceRevisionId,
          updatedAt: createdAt,
        }),
        currentSelectionAssetId: selectedAssetId,
        clearedVideoAssetId,
        timelineReconcileRequired: selectionChanged,
        idempotent: false,
        headAdvanced: false,
      }
    })
  }

  private resolveScope(input: Pick<ShotMediaReviewScope, 'projectId' | 'episodeId' | 'shotId' | 'sceneId'>): DurableShotScope {
    if (!this.database.getProject(input.projectId)) {
      throw new ShotMediaReviewError('PROJECT_NOT_FOUND', '项目不存在')
    }
    const sceneId = input.sceneId ?? null
    const rows = this.database.withSql((sql) => sql.all(`
      SELECT
        shots.id AS database_shot_id,
        ${PUBLIC_SHOT_ID} AS public_shot_id,
        ${PUBLIC_SCENE_ID} AS public_scene_id,
        shots.source_revision_id AS shot_source_revision_id,
        shots.storyboard_asset_id,
        shots.video_asset_id,
        episodes.id AS episode_id,
        episodes.project_id,
        episodes.source_revision_id AS episode_source_revision_id,
        episodes.updated_at AS episode_updated_at
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
      JOIN episodes ON episodes.id = scenes.episode_id
      WHERE episodes.project_id = ? AND episodes.id = ?
        AND ${PUBLIC_SHOT_ID} = ?
        AND (? IS NULL OR ${PUBLIC_SCENE_ID} = ?)
      ORDER BY scenes.id, shots.id
      LIMIT 2
    `, input.projectId, input.episodeId, input.shotId, sceneId, sceneId))
    if (rows.length === 0) {
      const episode = this.database.withSql((sql) => sql.get(`
        SELECT id FROM episodes WHERE id = ? AND project_id = ?
      `, input.episodeId, input.projectId))
      if (!episode) {
        throw new ShotMediaReviewError(
          'EPISODE_NOT_FOUND',
          '分集不存在或不属于指定项目',
        )
      }
      throw new ShotMediaReviewError(
        'SHOT_NOT_FOUND',
        '镜头不存在或不属于指定分集与场景',
      )
    }
    if (rows.length > 1) {
      throw new ShotMediaReviewError(
        'AMBIGUOUS_SHOT_ID',
        '该镜头 ID 在分集中不唯一，必须提供 sceneId',
      )
    }
    const row = rows[0]
    const episodeRevisionId = nullableText(row, 'episode_source_revision_id')
    if (!episodeRevisionId
      || nullableText(row, 'shot_source_revision_id') !== episodeRevisionId) {
      throw new ShotMediaReviewError(
        'SOURCE_REVISION_MISSING',
        '镜头与分集未绑定同一份当前剧本修订',
      )
    }
    return {
      projectId: text(row, 'project_id'),
      episodeId: text(row, 'episode_id'),
      databaseShotId: text(row, 'database_shot_id'),
      publicShotId: text(row, 'public_shot_id'),
      publicSceneId: text(row, 'public_scene_id'),
      sourceRevisionId: episodeRevisionId,
      episodeUpdatedAt: text(row, 'episode_updated_at'),
      storyboardAssetId: nullableText(row, 'storyboard_asset_id'),
      videoAssetId: nullableText(row, 'video_asset_id'),
    }
  }

  private candidateIds(
    scope: DurableShotScope,
    mediaType: ShotMediaType,
    limit: number,
    offset: number,
  ): string[] {
    const kind = mediaType === 'storyboard' ? 'storyboard' : 'shot.video'
    const jobType = mediaType === 'storyboard' ? 'asset.image.generate' : 'shot.video.generate'
    const binding = mediaType === 'storyboard' ? 'storyboardBinding' : 'binding'
    return this.database.withSql((sql) => sql.all(`
      SELECT media_assets.id
        FROM media_assets
        JOIN generation_jobs ON generation_jobs.id = media_assets.generation_job_id
       WHERE media_assets.project_id = ?
         AND media_assets.episode_id = ?
         AND media_assets.source_revision_id = ?
         AND media_assets.kind = ?
         AND media_assets.status = 'ready'
         AND generation_jobs.project_id = ?
         AND generation_jobs.episode_id = ?
         AND generation_jobs.type IN (?, ?)
         AND generation_jobs.status = 'succeeded'
         AND json_extract(generation_jobs.input_json, '$.${binding}.databaseShotId') = ?
         AND json_extract(generation_jobs.input_json, '$.${binding}.shotId') = ?
         AND json_extract(generation_jobs.input_json, '$.${binding}.sceneId') = ?
         AND json_extract(generation_jobs.input_json, '$.${binding}.expectedRevisionId') = ?
       ORDER BY media_assets.created_at DESC, media_assets.id DESC
       LIMIT ? OFFSET ?
    `,
    scope.projectId,
    scope.episodeId,
    scope.sourceRevisionId,
    kind,
    scope.projectId,
    scope.episodeId,
    jobType,
    mediaType === 'video' ? SHOT_VIDEO_HISTORY_ADOPTION_JOB_TYPE : jobType,
    scope.databaseShotId,
    scope.publicShotId,
    scope.publicSceneId,
    scope.sourceRevisionId,
    limit,
    offset,
    )).map((row) => text(row, 'id'))
  }

  private wasPreviouslySelected(
    scope: DurableShotScope,
    mediaType: ShotMediaType,
    assetId: string,
  ): boolean {
    return Boolean(this.database.withSql((sql) => sql.get(`
      SELECT 1 AS found
        FROM shot_media_review_decisions
       WHERE project_id = ? AND episode_id = ? AND shot_id = ?
         AND source_revision_id = ? AND media_type = ?
         AND (selected_asset_id = ? OR previous_asset_id = ?)
       LIMIT 1
    `,
    scope.projectId,
    scope.episodeId,
    scope.databaseShotId,
    scope.sourceRevisionId,
    mediaType,
    assetId,
    assetId,
    )))
  }

  private markDownstreamStale(
    scope: DurableShotScope,
    mediaType: ShotMediaType,
    reviewId: string,
    selectedAssetId: string,
    now: string,
  ): ShotMediaReviewRecord['stale'] {
    return this.database.withSql((sql) => {
      const shotVideoJobs = mediaType === 'storyboard'
        ? sql.all(`
            SELECT id FROM generation_jobs
             WHERE project_id = ?
               AND episode_id = ?
               AND type = 'shot.video.generate'
               AND status IN ('queued', 'running', 'waiting_provider')
               AND json_extract(input_json, '$.binding.databaseShotId') = ?
               AND json_extract(input_json, '$.binding.expectedRevisionId') = ?
             ORDER BY id
          `,
          scope.projectId,
          scope.episodeId,
          scope.databaseShotId,
          scope.sourceRevisionId,
          ).length
        : 0
      const generationJobs = sql.run(`
        UPDATE generation_jobs
        SET status = CASE
              WHEN status IN ('queued', 'running', 'waiting_provider') THEN 'cancelled'
              ELSE status
            END,
            progress_detail_json = json_set(
              progress_detail_json,
              '$.stale', json('true'),
              '$.staleReason', 'shot_media_selection_changed',
              '$.shotMediaReviewId', ?,
              '$.selectedAssetId', ?
            ),
            error_json = CASE
              WHEN status IN ('queued', 'running', 'waiting_provider') THEN json_object(
                'code', 'STALE_SHOT_MEDIA_SELECTION',
                'message', '镜头选中的媒体版本已变更，下游任务已过期',
                'retryable', json('false'),
                'category', 'cancelled'
              )
              ELSE error_json
            END,
            completed_at = CASE
              WHEN status IN ('queued', 'running', 'waiting_provider') THEN ?
              ELSE completed_at
            END,
            updated_at = ?
        WHERE episode_id = ?
          AND (
            type IN ('timeline.preview.render', 'export.render', 'quality.check')
            OR (
              ? = 'storyboard'
              AND type = 'shot.video.generate'
              AND status IN ('queued', 'running', 'waiting_provider')
              AND project_id = ?
              AND json_extract(input_json, '$.binding.databaseShotId') = ?
              AND json_extract(input_json, '$.binding.expectedRevisionId') = ?
            )
          )
          AND (
            status IN ('queued', 'running', 'waiting_provider')
            OR COALESCE(json_extract(progress_detail_json, '$.shotMediaReviewId'), '') <> ?
          )
      `,
      reviewId,
      selectedAssetId,
      now,
      now,
      scope.episodeId,
      mediaType,
      scope.projectId,
      scope.databaseShotId,
      scope.sourceRevisionId,
      reviewId,
      ).changes
      const exports = sql.run(`
        UPDATE exports SET status = 'stale', updated_at = ?
         WHERE episode_id = ? AND status <> 'stale'
      `, now, scope.episodeId).changes
      const qualityReports = sql.run(`
        UPDATE quality_reports SET status = 'stale', passed = 0
         WHERE episode_id = ? AND status <> 'stale'
      `, scope.episodeId).changes
      const pipelineRuns = sql.run(`
        UPDATE pipeline_runs
           SET status = 'stale',
               error_json = json_object(
                 'code', 'STALE_SHOT_MEDIA_SELECTION',
                 'message', '镜头选中的媒体版本已变更，请重新对账时间线'
               ),
               updated_at = ?, completed_at = ?
         WHERE episode_id = ? AND status <> 'stale'
      `, now, now, scope.episodeId).changes
      return { generationJobs, shotVideoJobs, exports, qualityReports, pipelineRuns }
    })
  }

  private selectedVideoIsProvablyIndependent(scope: DurableShotScope): boolean {
    if (!scope.videoAssetId) return true
    const asset = this.database.getMediaAsset(scope.videoAssetId)
    if (!asset) return false
    const job = asset.generationJobId
      ? this.database.getGenerationJob(asset.generationJobId)
      : undefined
    return selectedVideoIsProvablyStoryboardIndependent(this.database, asset, job, scope)
  }

  private replayResult(row: SqlRow, input: DecideShotMediaInput): ShotMediaDecisionResult {
    const episode = this.database.withSql((sql) => sql.get(`
      SELECT source_revision_id, updated_at FROM episodes
       WHERE id = ? AND project_id = ?
    `, input.episodeId, input.projectId))
    let currentScope: DurableShotScope | undefined
    try {
      const resolved = this.resolveScope(input)
      if (resolved.databaseShotId === row.shot_id
        && resolved.sourceRevisionId === row.source_revision_id) currentScope = resolved
    } catch {
      // Exact idempotent replay remains readable after later Story replacement
      // or Episode deletion. The immutable record still carries databaseShotId;
      // public IDs are enriched only when the original scope is still current.
    }
    const review = decisionFromRow(row, currentScope)
    if (!episode) {
      return {
        review,
        episodeEtag: '',
        currentSelectionAssetId: null,
        clearedVideoAssetId: review.clearedVideoAssetId,
        timelineReconcileRequired: review.timelineReconcileRequired,
        idempotent: true,
        headAdvanced: true,
      }
    }
    const sourceRevisionId = nullableText(episode, 'source_revision_id')
    const updatedAt = text(episode, 'updated_at')
    const current = this.database.withSql((sql) => sql.get(`
      SELECT shots.storyboard_asset_id, shots.video_asset_id
        FROM shots
        JOIN scenes ON scenes.id = shots.scene_id
       WHERE shots.id = ? AND scenes.episode_id = ?
       LIMIT 1
    `, review.databaseShotId, input.episodeId))
    const selected = current
      ? nullableText(current, input.mediaType === 'storyboard' ? 'storyboard_asset_id' : 'video_asset_id')
      : null
    return {
      review,
      episodeEtag: episodeEtag({ sourceRevisionId, updatedAt }),
      currentSelectionAssetId: selected,
      clearedVideoAssetId: review.clearedVideoAssetId,
      timelineReconcileRequired: review.timelineReconcileRequired,
      idempotent: true,
      headAdvanced: sourceRevisionId !== review.sourceRevisionId
        || selected !== review.selectedAssetId,
    }
  }
}
