import type { Express, NextFunction, Request, Response } from 'express'

import type {
  ManjuDatabase,
  MediaAssetRecord,
  RevisionRecord,
} from './database.js'
import { stableAssetIdForVersion } from './asset-identity.js'
import { TURNAROUND_DERIVATION_ALGORITHM } from './asset-turnaround-derivation.js'
import {
  episodeEtag,
  episodeVersionMatches,
  versionTokenFromEtag,
} from './episode-version.js'
import type { JsonObject, JsonValue } from './types.js'

export const ASSET_LOCK_TARGET_TYPES = ['character', 'location', 'prop'] as const
export type AssetLockTargetType = (typeof ASSET_LOCK_TARGET_TYPES)[number]

export const CHARACTER_VISUAL_REFERENCE_ROLES = ['front', 'side', 'back'] as const
export type CharacterVisualReferenceRole = (typeof CHARACTER_VISUAL_REFERENCE_ROLES)[number]

export interface CharacterVisualReferenceIds {
  frontAssetId: string
  sideAssetId: string
  backAssetId: string
}

export interface CharacterVisualReferenceSet extends CharacterVisualReferenceIds {
  auditRevisionId: string
}

export interface AssetLockStaleResult {
  assets: number
  jobs: number
  exports: number
  qualityReports: number
  pipelineRuns: number
}

export interface AssetLockTarget {
  type: AssetLockTargetType
  id: string
  name: string
  version: number
  lockedAssetId: string | null
}

export interface CharacterVisualReferenceTarget extends AssetLockTarget {
  type: 'character'
  references: CharacterVisualReferenceSet
}

interface DurableAssetLockTarget extends AssetLockTarget {
  databaseId: string
}

export interface LockAssetInput {
  assetId: string
  projectId: string
  episodeId: string
  targetType: AssetLockTargetType
  targetId: string
  expectedRevisionId: string | null
}

export interface LockCharacterVisualReferencesInput extends CharacterVisualReferenceIds {
  projectId: string
  episodeId: string
  targetId: string
  expectedRevisionId: string | null
}

export interface AssetLockResult {
  asset: MediaAssetRecord
  target: AssetLockTarget
  revision: RevisionRecord
  sourceRevisionId: string
  stale: AssetLockStaleResult
  idempotent: boolean
  /** False only for a legacy lock which predates asset.lock audit revisions. */
  auditRevision: boolean
}

export interface CharacterVisualReferenceLockResult {
  assets: Record<CharacterVisualReferenceRole, MediaAssetRecord>
  target: CharacterVisualReferenceTarget
  revision: RevisionRecord
  sourceRevisionId: string
  stale: AssetLockStaleResult
  idempotent: boolean
  auditRevision: true
}

export type AssetLockErrorCode =
  | 'AMBIGUOUS_ASSET_LOCK_TARGET'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_NOT_IMAGE'
  | 'ASSET_NOT_READY'
  | 'ASSET_SOURCE_REVISION_MISMATCH'
  | 'ASSET_TARGET_MISMATCH'
  | 'ASSET_TURNAROUND_FAMILY_MISMATCH'
  | 'ASSET_TURNAROUND_ROLE_MISMATCH'
  | 'EPISODE_NOT_FOUND'
  | 'INVALID_ETAG'
  | 'INVALID_REQUEST'
  | 'LOCK_CONFLICT'
  | 'PRECONDITION_REQUIRED'
  | 'PROJECT_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'SOURCE_REVISION_MISSING'
  | 'TARGET_NOT_FOUND'

/** An HTTP-safe error. Details never contain filesystem paths or story text. */
export class AssetLockError extends Error {
  constructor(
    readonly status: number,
    readonly code: AssetLockErrorCode,
    message: string,
    readonly details?: JsonValue,
  ) {
    super(message)
    this.name = 'AssetLockError'
  }
}

type SqlRow = Record<string, unknown>

const TARGET_TABLES: Record<AssetLockTargetType, 'characters' | 'locations' | 'props'> = {
  character: 'characters',
  location: 'locations',
  prop: 'props',
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

const IMAGE_KIND_TOKEN = /(?:^|[._-])(?:character|concept|environment|generated|image|keyframe|location|portrait|prop|reference|storyboard|turnaround)(?:$|[._-])/

const DOWNSTREAM_ASSET_KINDS = [
  'storyboard',
  'shot.storyboard',
  'storyboard.image',
  'keyframe',
  'video',
  'shot.video',
  'preview',
  'timeline.preview',
  'export',
  'episode.export',
  'final.video',
] as const

const DOWNSTREAM_JOB_TYPES = [
  'shot.storyboard.generate',
  'shot.video.generate',
  'video.generate',
  'timeline.preview.render',
  'export.render',
  'quality.check',
] as const

const STORYBOARD_IMAGE_KINDS = [
  'storyboard',
  'shot.storyboard',
  'storyboard.image',
  'keyframe',
] as const

const EMPTY_STALE: AssetLockStaleResult = {
  assets: 0,
  jobs: 0,
  exports: 0,
  qualityReports: 0,
  pipelineRuns: 0,
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value) {
    throw new Error(`Database column ${key} is not non-empty text`)
  }
  return value
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Database column ${key} is not nullable text`)
  return value
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number') throw new Error(`Database column ${key} is not numeric`)
  return value
}

const PUBLIC_TARGET_ID = `CASE
  WHEN typeof(json_extract(metadata_json, '$.storyId')) = 'text'
    AND length(trim(json_extract(metadata_json, '$.storyId'))) > 0
  THEN json_extract(metadata_json, '$.storyId')
  ELSE id
END`

function resolveTarget(
  database: ManjuDatabase,
  input: Pick<LockAssetInput, 'projectId' | 'episodeId' | 'targetType' | 'targetId'>,
): DurableAssetLockTarget {
  // TARGET_TABLES is a closed enum map. No request value is interpolated as SQL.
  const table = TARGET_TABLES[input.targetType]
  const rows = database.withSql((sql) => sql.all(`
    SELECT
      id AS database_id,
      ${PUBLIC_TARGET_ID} AS public_id,
      name,
      version,
      locked_asset_id
    FROM ${table}
    WHERE project_id = ?
      AND episode_id = ?
      AND ${PUBLIC_TARGET_ID} = ?
    ORDER BY id
    LIMIT 2
  `, input.projectId, input.episodeId, input.targetId))
  if (rows.length === 0) {
    throw new AssetLockError(404, 'TARGET_NOT_FOUND', '视觉资产目标不存在或不属于指定项目与分集')
  }
  if (rows.length > 1) {
    throw new AssetLockError(409, 'AMBIGUOUS_ASSET_LOCK_TARGET', '目标公开 ID 在分集中不唯一，无法安全锁定')
  }
  const row = rows[0]
  return {
    databaseId: requiredString(row, 'database_id'),
    type: input.targetType,
    id: requiredString(row, 'public_id'),
    name: requiredString(row, 'name'),
    version: requiredNumber(row, 'version'),
    lockedAssetId: nullableString(row, 'locked_asset_id'),
  }
}

function assertImageAsset(
  database: ManjuDatabase,
  asset: MediaAssetRecord,
  sourceRevisionId: string,
  target: Pick<AssetLockTarget, 'type' | 'id'>,
): void {
  if (asset.status !== 'ready') {
    throw new AssetLockError(409, 'ASSET_NOT_READY', '只有 ready 状态的视觉资产可以锁定')
  }
  const mimeType = asset.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const kind = asset.kind.trim().toLowerCase()
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) || !IMAGE_KIND_TOKEN.test(kind)) {
    throw new AssetLockError(422, 'ASSET_NOT_IMAGE', '锁定资产必须是受支持的图片类型与图片资产类别')
  }
  if (asset.sourceRevisionId !== sourceRevisionId) {
    throw new AssetLockError(
      409,
      'ASSET_SOURCE_REVISION_MISMATCH',
      '图片资产不是基于当前分集剧本修订生成，不能锁定',
      { currentRevisionId: sourceRevisionId, assetRevisionId: asset.sourceRevisionId },
    )
  }
  // Provider outputs used by the workbench are bound to exactly one normalized
  // entity at submission time. Never let a generic or differently-targeted
  // paid image be relabelled as another character/location/prop at lock time.
  if (asset.generationJobId) {
    const generationJob = database.getGenerationJob(asset.generationJobId)
    const binding = generationJob?.input.assetEntityBinding
    const metadata = generationJob?.input.metadata
    const bindingObject = binding && typeof binding === 'object' && !Array.isArray(binding)
      ? binding as JsonObject
      : null
    const metadataObject = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata as JsonObject
      : null
    const entityType = asset.generationParameters.entityType
      ?? bindingObject?.entityType
      ?? metadataObject?.entityType
      ?? (metadataObject?.characterId !== undefined ? 'character'
        : metadataObject?.locationId !== undefined ? 'location'
          : metadataObject?.propId !== undefined ? 'prop' : undefined)
    const entityId = asset.generationParameters.entityId
      ?? bindingObject?.entityId
      ?? metadataObject?.entityId
      ?? metadataObject?.[`${target.type}Id`]
    if (entityType !== target.type || entityId !== target.id) {
      throw new AssetLockError(
        409,
        'ASSET_TARGET_MISMATCH',
        '该图片候选未绑定到所选角色、场景或道具，不能锁定',
      )
    }
  }
}

interface TurnaroundAssetFamily {
  jobId: string
  sourceAssetId: string
  sourceChecksum: string
  sourceVersion: number
}

interface DurableCharacterVisualReference {
  role: CharacterVisualReferenceRole
  assetId: string | null
  version: number
  auditRevisionId: string
}

function objectValue(value: unknown): JsonObject | null {
  return isPlainObject(value) ? value as JsonObject : null
}

function exactString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function exactNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function referenceAssetId(
  input: CharacterVisualReferenceIds,
  role: CharacterVisualReferenceRole,
): string {
  return input[`${role}AssetId`]
}

function assertTurnaroundReferenceAsset(
  database: ManjuDatabase,
  asset: MediaAssetRecord,
  sourceRevisionId: string,
  target: DurableAssetLockTarget,
  role: CharacterVisualReferenceRole,
): TurnaroundAssetFamily {
  assertImageAsset(database, asset, sourceRevisionId, target)
  if (asset.kind !== `character-reference.${role}`
    || asset.source !== 'derived'
    || asset.providerId !== null
    || asset.generationParameters.operation !== 'asset.image.turnaround.derive'
    || (asset.generationParameters.algorithm !== TURNAROUND_DERIVATION_ALGORITHM
      && asset.generationParameters.algorithm !== 'ffmpeg-crop-v1')
    || asset.generationParameters.orientation !== role) {
    throw new AssetLockError(
      409,
      'ASSET_TURNAROUND_ROLE_MISMATCH',
      `${role} 槽必须绑定服务端本地派生的对应三视图`,
    )
  }
  if (!asset.checksum
    || !/^[a-f0-9]{64}$/i.test(asset.checksum)
    || !asset.width || !Number.isInteger(asset.width) || asset.width < 1
    || !asset.height || !Number.isInteger(asset.height) || asset.height < 1
    || !asset.generationJobId
    || !asset.parentAssetId) {
    throw new AssetLockError(409, 'ASSET_TURNAROUND_FAMILY_MISMATCH', '三视图资产缺少可验证的派生谱系')
  }

  const job = database.getGenerationJob(asset.generationJobId)
  const input = objectValue(job?.input)
  const binding = objectValue(input?.assetEntityBinding)
  const durableSource = objectValue(input?.source)
  const sourceCharacter = objectValue(durableSource?.character)
  const parameterBinding = objectValue(asset.generationParameters.assetEntityBinding)
  const parameterSource = objectValue(asset.generationParameters.source)
  if (!job
    || job.type !== 'asset.image.turnaround.derive'
    || job.status !== 'succeeded'
    || job.projectId !== asset.projectId
    || job.episodeId !== asset.episodeId
    || job.providerId !== null
    || job.providerConfigRevision !== null
    || input?.operation !== 'asset.image.turnaround.derive'
    || (input?.algorithm !== TURNAROUND_DERIVATION_ALGORITHM
      && input?.algorithm !== 'ffmpeg-crop-v1')
    || input?.sourceAssetId !== asset.parentAssetId
    || binding?.entityType !== 'character'
    || binding?.entityId !== target.id
    || binding?.databaseEntityId !== target.databaseId
    || binding?.episodeId !== asset.episodeId
    || binding?.expectedRevisionId !== sourceRevisionId
    || sourceCharacter?.entityType !== 'character'
    || sourceCharacter?.entityId !== target.id
    || sourceCharacter?.databaseEntityId !== target.databaseId
    || sourceCharacter?.episodeId !== asset.episodeId
    || sourceCharacter?.expectedRevisionId !== sourceRevisionId
    || parameterBinding?.entityType !== 'character'
    || parameterBinding?.entityId !== target.id
    || parameterBinding?.databaseEntityId !== target.databaseId
    || parameterBinding?.expectedRevisionId !== sourceRevisionId
    || asset.generationParameters.entityType !== 'character'
    || asset.generationParameters.entityId !== target.id) {
    throw new AssetLockError(
      409,
      'ASSET_TARGET_MISMATCH',
      '三视图的不可变任务绑定与所选角色不一致',
    )
  }

  const sourceAssetId = exactString(durableSource?.assetId)
  const sourceChecksum = exactString(durableSource?.checksum)?.toLowerCase() ?? null
  const sourceVersion = exactNumber(durableSource?.version)
  const sourceWidth = exactNumber(durableSource?.width)
  const sourceHeight = exactNumber(durableSource?.height)
  const sourceMimeType = exactString(durableSource?.mimeType)?.split(';', 1)[0]?.trim().toLowerCase() ?? null
  if (!sourceAssetId
    || sourceAssetId !== asset.parentAssetId
    || !sourceChecksum || !/^[a-f0-9]{64}$/.test(sourceChecksum)
    || !sourceVersion || sourceVersion < 1
    || !sourceWidth || sourceWidth < 1
    || !sourceHeight || sourceHeight < 1
    || !sourceMimeType || !SUPPORTED_IMAGE_MIME_TYPES.has(sourceMimeType)
    || durableSource?.projectId !== asset.projectId
    || durableSource?.episodeId !== asset.episodeId
    || durableSource?.sourceRevisionId !== sourceRevisionId
    || parameterSource?.assetId !== sourceAssetId
    || exactString(parameterSource?.checksum)?.toLowerCase() !== sourceChecksum
    || exactNumber(parameterSource?.version) !== sourceVersion
    || exactNumber(parameterSource?.width) !== sourceWidth
    || exactNumber(parameterSource?.height) !== sourceHeight
    || parameterSource?.sourceRevisionId !== sourceRevisionId) {
    throw new AssetLockError(409, 'ASSET_TURNAROUND_FAMILY_MISMATCH', '三视图资产的源图谱系不一致')
  }
  const sourceAsset = database.getMediaAsset(sourceAssetId)
  if (!sourceAsset
    || sourceAsset.projectId !== asset.projectId
    || sourceAsset.episodeId !== asset.episodeId
    || sourceAsset.status !== 'ready'
    || sourceAsset.version !== sourceVersion
    || sourceAsset.checksum?.toLowerCase() !== sourceChecksum
    || sourceAsset.width !== sourceWidth
    || sourceAsset.height !== sourceHeight
    || sourceAsset.mimeType?.split(';', 1)[0]?.trim().toLowerCase() !== sourceMimeType
    || sourceAsset.sourceRevisionId !== sourceRevisionId) {
    throw new AssetLockError(409, 'ASSET_TURNAROUND_FAMILY_MISMATCH', '三视图的源图已变更或不可用')
  }
  assertImageAsset(database, sourceAsset, sourceRevisionId, target)

  const outputs = job.output?.assets
  const publishedOutputs = Array.isArray(outputs) ? outputs.flatMap((value) => {
    const item = objectValue(value)
    const outputAsset = objectValue(item?.asset)
    const outputRole = exactString(item?.role)
    const outputAssetId = exactString(outputAsset?.id)
    return outputRole && CHARACTER_VISUAL_REFERENCE_ROLES.includes(outputRole as CharacterVisualReferenceRole)
      && outputAssetId
      ? [{ role: outputRole as CharacterVisualReferenceRole, assetId: outputAssetId }]
      : []
  }) : []
  const published = publishedOutputs.length === 3
    && new Set(publishedOutputs.map((output) => output.role)).size === 3
    && new Set(publishedOutputs.map((output) => output.assetId)).size === 3
    && publishedOutputs.some((output) => output.role === role && output.assetId === asset.id)
  if (!published) {
    throw new AssetLockError(
      409,
      'ASSET_TURNAROUND_FAMILY_MISMATCH',
      '三视图资产不在已成功任务的固化输出中',
    )
  }
  return {
    jobId: job.id,
    sourceAssetId,
    sourceChecksum,
    sourceVersion,
  }
}

function currentCharacterVisualReferences(
  database: ManjuDatabase,
  characterDatabaseId: string,
): DurableCharacterVisualReference[] {
  return database.withSql((sql) => sql.all(`
    SELECT role, asset_id, version, audit_revision_id
    FROM character_visual_references
    WHERE character_id = ?
    ORDER BY CASE role WHEN 'front' THEN 1 WHEN 'side' THEN 2 ELSE 3 END
  `, characterDatabaseId)).map((row) => ({
    role: requiredString(row, 'role') as CharacterVisualReferenceRole,
    assetId: nullableString(row, 'asset_id'),
    version: requiredNumber(row, 'version'),
    auditRevisionId: requiredString(row, 'audit_revision_id'),
  }))
}

function latestCharacterVisualReferenceAudit(
  database: ManjuDatabase,
  input: Pick<LockCharacterVisualReferencesInput,
    'projectId' | 'episodeId' | 'targetId' | 'frontAssetId' | 'sideAssetId' | 'backAssetId'>,
): RevisionRecord | undefined {
  const row = database.withSql((sql) => sql.get(`
    SELECT id
    FROM revisions
    WHERE project_id = ?
      AND json_extract(snapshot_json, '$.kind') = 'character.visual-references.lock'
      AND json_extract(snapshot_json, '$.episodeId') = ?
      AND json_extract(snapshot_json, '$.target.id') = ?
      AND json_extract(snapshot_json, '$.references.front.assetId') = ?
      AND json_extract(snapshot_json, '$.references.side.assetId') = ?
      AND json_extract(snapshot_json, '$.references.back.assetId') = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `,
  input.projectId,
  input.episodeId,
  input.targetId,
  input.frontAssetId,
  input.sideAssetId,
  input.backAssetId,
  ))
  const id = row && typeof row.id === 'string' ? row.id : undefined
  return id ? database.getRevision(id) : undefined
}

function latestAuditRevision(
  database: ManjuDatabase,
  input: Pick<LockAssetInput, 'projectId' | 'episodeId' | 'targetType' | 'targetId' | 'assetId'>,
): RevisionRecord | undefined {
  const row = database.withSql((sql) => sql.get(`
    SELECT id
    FROM revisions
    WHERE project_id = ?
      AND json_extract(snapshot_json, '$.kind') = 'asset.lock'
      AND json_extract(snapshot_json, '$.episodeId') = ?
      AND json_extract(snapshot_json, '$.target.type') = ?
      AND json_extract(snapshot_json, '$.target.id') = ?
      AND json_extract(snapshot_json, '$.target.lockedAssetId') = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, input.projectId, input.episodeId, input.targetType, input.targetId, input.assetId))
  const id = row && typeof row.id === 'string' ? row.id : undefined
  return id ? database.getRevision(id) : undefined
}

function markVisualDownstreamStale(
  database: ManjuDatabase,
  input: { episodeId: string; lockedAssetId: string; auditRevisionId: string },
): AssetLockStaleResult {
  const now = new Date().toISOString()
  return database.withSql((sql) => {
    const assets = sql.run(`
      UPDATE media_assets
      SET status = 'stale', updated_at = ?
      WHERE id <> ?
        AND status <> 'stale'
        AND (
          (
            episode_id = ?
            AND lower(kind) IN (${placeholders(DOWNSTREAM_ASSET_KINDS)})
          )
          OR id IN (
            SELECT shots.storyboard_asset_id
            FROM shots
            JOIN scenes ON scenes.id = shots.scene_id
            WHERE scenes.episode_id = ? AND shots.storyboard_asset_id IS NOT NULL
            UNION
            SELECT shots.video_asset_id
            FROM shots
            JOIN scenes ON scenes.id = shots.scene_id
            WHERE scenes.episode_id = ? AND shots.video_asset_id IS NOT NULL
            UNION
            SELECT exports.output_asset_id
            FROM exports
            WHERE exports.episode_id = ? AND exports.output_asset_id IS NOT NULL
          )
          OR generation_job_id IN (
            SELECT generation_jobs.id
            FROM generation_jobs
            WHERE generation_jobs.episode_id = ?
              AND (
                generation_jobs.type IN (${placeholders(DOWNSTREAM_JOB_TYPES)})
                OR (
                  generation_jobs.type IN ('asset.image.generate', 'image.generate')
                  AND lower(json_extract(generation_jobs.input_json, '$.metadata.kind'))
                    IN (${placeholders(STORYBOARD_IMAGE_KINDS)})
                )
              )
          )
        )
    `,
    now,
    input.lockedAssetId,
    input.episodeId,
    ...DOWNSTREAM_ASSET_KINDS,
    input.episodeId,
    input.episodeId,
    input.episodeId,
    input.episodeId,
    ...DOWNSTREAM_JOB_TYPES,
    ...STORYBOARD_IMAGE_KINDS,
    ).changes

    const jobs = sql.run(`
      UPDATE generation_jobs
      SET
        status = CASE
          WHEN status IN ('queued', 'running', 'waiting_provider') THEN 'cancelled'
          ELSE status
        END,
        progress_detail_json = json_set(
          progress_detail_json,
          '$.stale', json('true'),
          '$.staleReason', 'visual_asset_lock_changed',
          '$.staleRevisionId', ?
        ),
        error_json = CASE
          WHEN status IN ('queued', 'running', 'waiting_provider') THEN json_object(
            'code', 'STALE_VISUAL_LOCK',
            'message', '视觉资产锁定已变更，任务结果已过期',
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
          type IN (${placeholders(DOWNSTREAM_JOB_TYPES)})
          OR (
            type IN ('asset.image.generate', 'image.generate')
            AND lower(json_extract(input_json, '$.metadata.kind'))
              IN (${placeholders(STORYBOARD_IMAGE_KINDS)})
          )
        )
        AND COALESCE(json_extract(progress_detail_json, '$.stale'), 0) <> 1
    `,
    input.auditRevisionId,
    now,
    now,
    input.episodeId,
    ...DOWNSTREAM_JOB_TYPES,
    ...STORYBOARD_IMAGE_KINDS,
    ).changes

    const exports = sql.run(`
      UPDATE exports SET status = 'stale', updated_at = ?
      WHERE episode_id = ? AND status <> 'stale'
    `, now, input.episodeId).changes
    const qualityReports = sql.run(`
      UPDATE quality_reports SET status = 'stale', passed = 0
      WHERE episode_id = ? AND status <> 'stale'
    `, input.episodeId).changes
    const pipelineRuns = sql.run(`
      UPDATE pipeline_runs SET status = 'stale', updated_at = ?, completed_at = ?
      WHERE episode_id = ? AND status <> 'stale'
    `, now, now, input.episodeId).changes
    return { assets, jobs, exports, qualityReports, pipelineRuns }
  })
}

function publicTarget(target: DurableAssetLockTarget): AssetLockTarget {
  return {
    type: target.type,
    id: target.id,
    name: target.name,
    version: target.version,
    lockedAssetId: target.lockedAssetId,
  }
}

/**
 * Locks a ready image to one normalized story entity.
 *
 * The Episode HTTP ETag combines the story source revision and episode
 * updatedAt. The separate asset.lock revision is an append-only audit event,
 * so a visual choice cannot corrupt the StoryDocument snapshot consumed by
 * story editing/restoration.
 */
export class AssetLockService {
  constructor(private readonly database: ManjuDatabase) {}

  lock(input: LockAssetInput): AssetLockResult {
    return this.database.transaction(() => {
      const project = this.database.getProject(input.projectId)
      if (!project) throw new AssetLockError(404, 'PROJECT_NOT_FOUND', '项目不存在')

      const episodeRow = this.database.withSql((sql) => sql.get(`
        SELECT source_revision_id
        FROM episodes
        WHERE id = ? AND project_id = ?
      `, input.episodeId, input.projectId))
      if (!episodeRow) {
        throw new AssetLockError(404, 'EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
      }
      const sourceRevisionId = nullableString(episodeRow, 'source_revision_id')
      if (!sourceRevisionId) {
        throw new AssetLockError(409, 'SOURCE_REVISION_MISSING', '分集尚未绑定可追溯的剧本修订')
      }
      if (input.expectedRevisionId !== sourceRevisionId) {
        throw new AssetLockError(
          412,
          'REVISION_CONFLICT',
          '分集剧本已更新，请刷新后重试锁定',
          { currentRevisionId: sourceRevisionId },
        )
      }

      const target = resolveTarget(this.database, input)
      const asset = this.database.getMediaAsset(input.assetId)
      // Ownership mismatches are deliberately indistinguishable from missing
      // assets so callers cannot probe another project or episode.
      if (!asset || asset.projectId !== input.projectId || asset.episodeId !== input.episodeId) {
        throw new AssetLockError(404, 'ASSET_NOT_FOUND', '图片资产不存在或不属于指定项目与分集')
      }
      assertImageAsset(this.database, asset, sourceRevisionId, target)

      if (target.lockedAssetId === asset.id) {
        const audit = latestAuditRevision(this.database, input)
        const revision = audit ?? this.database.getRevision(sourceRevisionId)
        if (!revision) {
          throw new AssetLockError(409, 'SOURCE_REVISION_MISSING', '分集剧本修订记录不存在')
        }
        return {
          asset,
          target: publicTarget(target),
          revision,
          sourceRevisionId,
          stale: { ...EMPTY_STALE },
          idempotent: true,
          auditRevision: Boolean(audit),
        }
      }

      const now = new Date().toISOString()
      const auditSnapshot: JsonObject = {
        version: 1,
        kind: 'asset.lock',
        projectId: input.projectId,
        episodeId: input.episodeId,
        sourceRevisionId,
        target: {
          type: target.type,
          id: target.id,
          previousLockedAssetId: target.lockedAssetId,
          lockedAssetId: asset.id,
        },
        asset: {
          id: asset.id,
          assetId: stableAssetIdForVersion(this.database, input.projectId, asset.id) ?? asset.id,
          assetVersionId: asset.id,
          kind: asset.kind,
          version: asset.version,
          mimeType: asset.mimeType,
          checksum: asset.checksum,
          sourceRevisionId: asset.sourceRevisionId,
        },
        createdAt: now,
      }
      const revision = this.database.createRevision({
        projectId: input.projectId,
        parentRevisionId: project.currentRevisionId ?? sourceRevisionId,
        summary: `锁定${target.type === 'character' ? '角色' : target.type === 'location' ? '场景' : '道具'}视觉资产 ${target.name}`.slice(0, 500),
        snapshot: auditSnapshot,
        createdAt: now,
      })

      const table = TARGET_TABLES[input.targetType]
      const changed = this.database.withSql((sql) => sql.run(`
        UPDATE ${table}
        SET locked_asset_id = ?, version = version + 1, updated_at = ?
        WHERE id = ?
          AND locked_asset_id IS ?
          AND project_id = ?
          AND episode_id = ?
          AND EXISTS (
            SELECT 1 FROM episodes
            WHERE episodes.id = ?
              AND episodes.project_id = ?
              AND episodes.source_revision_id = ?
          )
      `,
      asset.id,
      now,
      target.databaseId,
      target.lockedAssetId,
      input.projectId,
      input.episodeId,
      input.episodeId,
      input.projectId,
      sourceRevisionId,
      )).changes
      if (changed !== 1) {
        throw new AssetLockError(409, 'LOCK_CONFLICT', '视觉资产目标已被其他操作更新，请刷新后重试')
      }

      const stale = markVisualDownstreamStale(this.database, {
        episodeId: input.episodeId,
        lockedAssetId: asset.id,
        auditRevisionId: revision.id,
      })
      const updatedTarget = resolveTarget(this.database, input)
      return {
        asset,
        target: publicTarget(updatedTarget),
        revision,
        sourceRevisionId,
        stale,
        idempotent: false,
        auditRevision: true,
      }
    })
  }
}

function characterReferenceSet(
  input: CharacterVisualReferenceIds,
  auditRevisionId: string,
): CharacterVisualReferenceSet {
  return {
    frontAssetId: input.frontAssetId,
    sideAssetId: input.sideAssetId,
    backAssetId: input.backAssetId,
    auditRevisionId,
  }
}

function characterReferenceTarget(
  target: DurableAssetLockTarget,
  references: CharacterVisualReferenceSet,
): CharacterVisualReferenceTarget {
  return {
    ...publicTarget(target),
    type: 'character',
    references,
  }
}

/**
 * Atomically binds a complete front/side/back set to a character.
 *
 * `characters.locked_asset_id` remains the independently reviewed primary
 * image. The three role slots are only accepted when their durable job and
 * source bindings prove that they came from one successful local turnaround
 * derivation for this exact character and Story revision.
 */
export class CharacterVisualReferenceLockService {
  constructor(private readonly database: ManjuDatabase) {}

  lock(input: LockCharacterVisualReferencesInput): CharacterVisualReferenceLockResult {
    return this.database.transaction(() => {
      const project = this.database.getProject(input.projectId)
      if (!project) throw new AssetLockError(404, 'PROJECT_NOT_FOUND', '项目不存在')

      const episodeRow = this.database.withSql((sql) => sql.get(`
        SELECT source_revision_id
        FROM episodes
        WHERE id = ? AND project_id = ?
      `, input.episodeId, input.projectId))
      if (!episodeRow) {
        throw new AssetLockError(404, 'EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
      }
      const sourceRevisionId = nullableString(episodeRow, 'source_revision_id')
      if (!sourceRevisionId) {
        throw new AssetLockError(409, 'SOURCE_REVISION_MISSING', '分集尚未绑定可追溯的剧本修订')
      }
      if (input.expectedRevisionId !== sourceRevisionId) {
        throw new AssetLockError(
          412,
          'REVISION_CONFLICT',
          '分集剧本已更新，请刷新后重试三视图绑定',
          { currentRevisionId: sourceRevisionId },
        )
      }

      const target = resolveTarget(this.database, {
        projectId: input.projectId,
        episodeId: input.episodeId,
        targetType: 'character',
        targetId: input.targetId,
      })
      const requestedIds = CHARACTER_VISUAL_REFERENCE_ROLES.map((role) => referenceAssetId(input, role))
      if (new Set(requestedIds).size !== CHARACTER_VISUAL_REFERENCE_ROLES.length) {
        throw new AssetLockError(400, 'INVALID_REQUEST', 'front、side、back 必须是三个不同的资产')
      }

      const assets = {} as Record<CharacterVisualReferenceRole, MediaAssetRecord>
      const families = {} as Record<CharacterVisualReferenceRole, TurnaroundAssetFamily>
      for (const role of CHARACTER_VISUAL_REFERENCE_ROLES) {
        const assetId = referenceAssetId(input, role)
        const asset = this.database.getMediaAsset(assetId)
        if (!asset || asset.projectId !== input.projectId || asset.episodeId !== input.episodeId) {
          // Do not reveal whether an asset exists in another project/Episode.
          throw new AssetLockError(404, 'ASSET_NOT_FOUND', `${role} 三视图资产不存在或不属于当前分集`)
        }
        assets[role] = asset
        families[role] = assertTurnaroundReferenceAsset(
          this.database,
          asset,
          sourceRevisionId,
          target,
          role,
        )
      }
      const family = families.front
      if (CHARACTER_VISUAL_REFERENCE_ROLES.some((role) => (
        families[role].jobId !== family.jobId
        || families[role].sourceAssetId !== family.sourceAssetId
        || families[role].sourceChecksum !== family.sourceChecksum
        || families[role].sourceVersion !== family.sourceVersion
      ))) {
        throw new AssetLockError(
          409,
          'ASSET_TURNAROUND_FAMILY_MISMATCH',
          'front、side、back 必须来自同一次本地三视图派生任务与同一源图',
        )
      }

      const current = currentCharacterVisualReferences(this.database, target.databaseId)
      const matchesCurrent = current.length === 3 && CHARACTER_VISUAL_REFERENCE_ROLES.every((role) => (
        current.find((reference) => reference.role === role)?.assetId === referenceAssetId(input, role)
      ))
      if (matchesCurrent) {
        const revision = latestCharacterVisualReferenceAudit(this.database, input)
        if (!revision) {
          throw new AssetLockError(
            409,
            'LOCK_CONFLICT',
            '当前三视图绑定缺少可验证的审计修订，拒绝猜测恢复',
          )
        }
        return {
          assets,
          target: characterReferenceTarget(target, characterReferenceSet(input, revision.id)),
          revision,
          sourceRevisionId,
          stale: { ...EMPTY_STALE },
          idempotent: true,
          auditRevision: true,
        }
      }

      const previous = Object.fromEntries(CHARACTER_VISUAL_REFERENCE_ROLES.map((role) => [
        role,
        current.find((reference) => reference.role === role)?.assetId ?? null,
      ])) as Record<CharacterVisualReferenceRole, string | null>
      const now = new Date().toISOString()
      const references = Object.fromEntries(CHARACTER_VISUAL_REFERENCE_ROLES.map((role) => [
        role,
        {
          assetId: assets[role].id,
          stableAssetId: stableAssetIdForVersion(
            this.database,
            input.projectId,
            assets[role].id,
          ) ?? assets[role].id,
          assetVersionId: assets[role].id,
          kind: assets[role].kind,
          version: assets[role].version,
          mimeType: assets[role].mimeType,
          checksum: assets[role].checksum,
          sourceRevisionId: assets[role].sourceRevisionId,
        },
      ])) as JsonObject
      const revision = this.database.createRevision({
        projectId: input.projectId,
        parentRevisionId: project.currentRevisionId ?? sourceRevisionId,
        summary: `锁定角色三视图 ${target.name}`.slice(0, 500),
        snapshot: {
          version: 1,
          kind: 'character.visual-references.lock',
          projectId: input.projectId,
          episodeId: input.episodeId,
          sourceRevisionId,
          target: {
            type: 'character',
            id: target.id,
            databaseVersion: target.version,
            primaryLockedAssetId: target.lockedAssetId,
          },
          previousReferences: previous,
          references,
          turnaround: {
            derivationJobId: family.jobId,
            sourceAssetId: family.sourceAssetId,
            sourceChecksum: family.sourceChecksum,
            sourceVersion: family.sourceVersion,
          },
          createdAt: now,
        },
        createdAt: now,
      })

      for (const role of CHARACTER_VISUAL_REFERENCE_ROLES) {
        const changed = this.database.withSql((sql) => sql.run(`
          INSERT INTO character_visual_references (
            character_id, project_id, episode_id, role, asset_id,
            version, audit_revision_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(character_id, role) DO UPDATE SET
            asset_id = excluded.asset_id,
            version = character_visual_references.version + 1,
            audit_revision_id = excluded.audit_revision_id,
            updated_at = excluded.updated_at
        `,
        target.databaseId,
        input.projectId,
        input.episodeId,
        role,
        assets[role].id,
        revision.id,
        now,
        )).changes
        if (changed !== 1) {
          throw new AssetLockError(409, 'LOCK_CONFLICT', '三视图槽位已被其他操作更新，请刷新后重试')
        }
      }
      const targetChanged = this.database.withSql((sql) => sql.run(`
        UPDATE characters
        SET version = version + 1, updated_at = ?
        WHERE id = ?
          AND project_id = ?
          AND episode_id = ?
          AND version = ?
          AND locked_asset_id IS ?
          AND EXISTS (
            SELECT 1 FROM episodes
            WHERE episodes.id = ?
              AND episodes.project_id = ?
              AND episodes.source_revision_id = ?
          )
      `,
      now,
      target.databaseId,
      input.projectId,
      input.episodeId,
      target.version,
      target.lockedAssetId,
      input.episodeId,
      input.projectId,
      sourceRevisionId,
      )).changes
      if (targetChanged !== 1) {
        throw new AssetLockError(409, 'LOCK_CONFLICT', '角色已被其他操作更新，请刷新后重试')
      }

      // One set mutation invalidates downstream work exactly once. The three
      // derived reference Assets and their local derivation Job are not part
      // of the downstream kind/type allowlists and therefore remain ready.
      const stale = markVisualDownstreamStale(this.database, {
        episodeId: input.episodeId,
        lockedAssetId: assets.front.id,
        auditRevisionId: revision.id,
      })
      const updatedTarget = resolveTarget(this.database, {
        projectId: input.projectId,
        episodeId: input.episodeId,
        targetType: 'character',
        targetId: input.targetId,
      })
      return {
        assets,
        target: characterReferenceTarget(updatedTarget, characterReferenceSet(input, revision.id)),
        revision,
        sourceRevisionId,
        stale,
        idempotent: false,
        auditRevision: true,
      }
    })
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new AssetLockError(400, 'INVALID_REQUEST', `${label} 必须是字符串`)
  }
  const normalized = value.trim()
  if (
    !normalized
    || normalized.length > 200
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new AssetLockError(400, 'INVALID_REQUEST', `${label} 格式无效`)
  }
  return normalized
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value
}

function parseIfMatch(request: Request): string {
  const raw = request.get('if-match')
  if (!raw) {
    throw new AssetLockError(428, 'PRECONDITION_REQUIRED', '必须提供 If-Match 分集剧本版本')
  }
  const version = versionTokenFromEtag(raw)
  if (!version) throw new AssetLockError(400, 'INVALID_ETAG', 'If-Match 分集版本格式无效')
  return version
}

function parseLockBody(value: unknown): Omit<LockAssetInput, 'assetId' | 'expectedRevisionId'> {
  if (!isPlainObject(value)) {
    throw new AssetLockError(400, 'INVALID_REQUEST', '视觉资产锁定请求必须是 JSON 对象')
  }
  const allowed = new Set(['projectId', 'episodeId', 'targetType', 'targetId'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AssetLockError(400, 'INVALID_REQUEST', '视觉资产锁定请求包含不支持的字段')
  }
  if (!ASSET_LOCK_TARGET_TYPES.includes(value.targetType as AssetLockTargetType)) {
    throw new AssetLockError(400, 'INVALID_REQUEST', 'targetType 必须是 character、location 或 prop')
  }
  return {
    projectId: identifier(value.projectId, 'projectId'),
    episodeId: identifier(value.episodeId, 'episodeId'),
    targetType: value.targetType as AssetLockTargetType,
    targetId: identifier(value.targetId, 'targetId'),
  }
}

function parseCharacterVisualReferenceLockBody(
  value: unknown,
): Omit<LockCharacterVisualReferencesInput, 'expectedRevisionId'> {
  if (!isPlainObject(value)) {
    throw new AssetLockError(400, 'INVALID_REQUEST', '角色三视图绑定请求必须是 JSON 对象')
  }
  const allowed = new Set([
    'projectId',
    'episodeId',
    'targetId',
    'frontAssetId',
    'sideAssetId',
    'backAssetId',
  ])
  const keys = Object.keys(value)
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw new AssetLockError(
      400,
      'INVALID_REQUEST',
      '请求必须且只能包含 projectId、episodeId、targetId、frontAssetId、sideAssetId、backAssetId',
    )
  }
  return {
    projectId: identifier(value.projectId, 'projectId'),
    episodeId: identifier(value.episodeId, 'episodeId'),
    targetId: identifier(value.targetId, 'targetId'),
    frontAssetId: identifier(value.frontAssetId, 'frontAssetId'),
    sideAssetId: identifier(value.sideAssetId, 'sideAssetId'),
    backAssetId: identifier(value.backAssetId, 'backAssetId'),
  }
}

function publicAsset(asset: MediaAssetRecord): JsonObject {
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
    url: `/api/v1/assets/${encodeURIComponent(asset.id)}/content`,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  }
}

function publicRevision(revision: RevisionRecord): JsonObject {
  return {
    id: revision.id,
    projectId: revision.projectId,
    parentRevisionId: revision.parentRevisionId,
    summary: revision.summary,
    createdAt: revision.createdAt,
  }
}

export interface AssetLockHttpDependencies {
  database: ManjuDatabase
  onLocked?: (result: AssetLockResult) => void
  onCharacterReferencesLocked?: (result: CharacterVisualReferenceLockResult) => void
}

export function mountAssetLockRoutes(app: Express, dependencies: AssetLockHttpDependencies): void {
  const service = new AssetLockService(dependencies.database)
  const referenceService = new CharacterVisualReferenceLockService(dependencies.database)
  app.post('/api/v1/assets/:assetId/lock', (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    try {
      const body = parseLockBody(request.body)
      const expectedVersion = parseIfMatch(request)
      const { result, etag } = dependencies.database.transaction(() => {
        const row = dependencies.database.withSql((sql) => sql.get(`
          SELECT source_revision_id, updated_at
          FROM episodes
          WHERE id = ? AND project_id = ?
        `, body.episodeId, body.projectId))
        if (!row) {
          throw new AssetLockError(404, 'EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
        }
        const sourceRevisionId = nullableString(row, 'source_revision_id')
        if (!sourceRevisionId) {
          throw new AssetLockError(409, 'SOURCE_REVISION_MISSING', '分集尚未绑定可追溯的剧本修订')
        }
        const updatedAt = nullableString(row, 'updated_at')
        if (!updatedAt) {
          throw new AssetLockError(409, 'SOURCE_REVISION_MISSING', '分集版本字段无效')
        }
        const episodeVersion = { sourceRevisionId, updatedAt }
        if (!episodeVersionMatches(episodeVersion, expectedVersion)) {
          throw new AssetLockError(
            412,
            'REVISION_CONFLICT',
            '分集已更新，请刷新后重试锁定',
            {
              currentRevisionId: sourceRevisionId,
              currentEtag: episodeEtag(episodeVersion),
            },
          )
        }
        return {
          result: service.lock({
            ...body,
            assetId: identifier(routeParam(request.params.assetId), 'assetId'),
            expectedRevisionId: sourceRevisionId,
          }),
          etag: episodeEtag(episodeVersion),
        }
      })
      dependencies.onLocked?.(result)
      response.setHeader('ETag', etag)
      response.setHeader('X-Asset-Lock-Revision', result.revision.id)
      response.status(result.idempotent ? 200 : 201).json({
        asset: publicAsset(result.asset),
        target: result.target,
        revision: publicRevision(result.revision),
        sourceRevisionId: result.sourceRevisionId,
        stale: result.stale,
        idempotent: result.idempotent,
        auditRevision: result.auditRevision,
      })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/v1/character-visual-references/lock', (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    try {
      const body = parseCharacterVisualReferenceLockBody(request.body)
      const expectedVersion = parseIfMatch(request)
      const { result, etag } = dependencies.database.transaction(() => {
        const row = dependencies.database.withSql((sql) => sql.get(`
          SELECT source_revision_id, updated_at
          FROM episodes
          WHERE id = ? AND project_id = ?
        `, body.episodeId, body.projectId))
        if (!row) {
          throw new AssetLockError(404, 'EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
        }
        const sourceRevisionId = nullableString(row, 'source_revision_id')
        if (!sourceRevisionId) {
          throw new AssetLockError(409, 'SOURCE_REVISION_MISSING', '分集尚未绑定可追溯的剧本修订')
        }
        const updatedAt = nullableString(row, 'updated_at')
        if (!updatedAt) {
          throw new AssetLockError(409, 'SOURCE_REVISION_MISSING', '分集版本字段无效')
        }
        const episodeVersion = { sourceRevisionId, updatedAt }
        if (!episodeVersionMatches(episodeVersion, expectedVersion)) {
          throw new AssetLockError(
            412,
            'REVISION_CONFLICT',
            '分集已更新，请刷新后重试三视图绑定',
            {
              currentRevisionId: sourceRevisionId,
              currentEtag: episodeEtag(episodeVersion),
            },
          )
        }
        return {
          result: referenceService.lock({ ...body, expectedRevisionId: sourceRevisionId }),
          etag: episodeEtag(episodeVersion),
        }
      })
      dependencies.onCharacterReferencesLocked?.(result)
      response.setHeader('ETag', etag)
      response.setHeader('X-Character-Visual-References-Revision', result.revision.id)
      response.status(result.idempotent ? 200 : 201).json({
        assets: Object.fromEntries(CHARACTER_VISUAL_REFERENCE_ROLES.map((role) => [
          role,
          publicAsset(result.assets[role]),
        ])),
        target: result.target,
        revision: publicRevision(result.revision),
        sourceRevisionId: result.sourceRevisionId,
        stale: result.stale,
        idempotent: result.idempotent,
        auditRevision: result.auditRevision,
      })
    } catch (error) {
      next(error)
    }
  })
}
