import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type {
  GenerationJobRecord,
  ManjuDatabase,
  MediaAssetRecord,
} from './database.js'
import { stableAssetIdForVersion } from './asset-identity.js'
import { imageDimensions, MediaStore, MediaStoreError } from './media.js'
import { getProviderDefinition } from './providers/catalog.js'
import { CodexToolsImageProvider, ImageProviderError } from './providers/codex-tools.js'
import {
  ProviderConfigurationError,
  ProviderService,
  type ProviderPublicState,
} from './providers/service.js'
import type {
  ImageEditMode,
  ImageGenerationInput,
  ImageProvider,
  JsonObject,
  ProviderImageReference,
} from './types.js'
import {
  VISUAL_ASSET_ENTITY_TYPES,
  VisualAssetGenerationError,
  createVisualAssetEntityBinding,
  resolveVisualAssetEntity,
  type VisualAssetEntityBinding,
  type VisualAssetEntityType,
} from './visual-asset-generation.js'
import {
  JobExecutionError,
  type JobHandler,
  type JobHandlerContext,
  type JobRecord,
} from './worker.js'

export const ASSET_IMAGE_EDIT_JOB_TYPE = 'asset.image.edit'
export const MAX_ASSET_IMAGE_EDIT_REFERENCES = 4
export const MAX_ASSET_IMAGE_EDIT_SOURCE_BYTES = 30 * 1024 * 1024
export const MAX_ASSET_IMAGE_EDIT_TOTAL_BYTES = 60 * 1024 * 1024

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export type AssetImageEditErrorCode =
  | 'ASSET_VERSION_FAMILY_BUSY'
  | 'ASSET_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_ASSET_ETAG'
  | 'INVALID_REFERENCE_ASSET'
  | 'INVALID_SOURCE_ASSET'
  | 'PRECONDITION_FAILED'
  | 'PROJECT_NOT_FOUND'
  | 'PROVIDER_CAPABILITY_MISSING'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_NOT_FOUND'
  | 'SOURCE_REVISION_MISSING'
  | 'STALE_SOURCE'

export class AssetImageEditError extends Error {
  constructor(
    readonly code: AssetImageEditErrorCode,
    message: string,
    readonly details?: JsonObject,
  ) {
    super(message)
    this.name = 'AssetImageEditError'
  }
}

export interface AssetImageSnapshotBinding {
  assetId: string
  checksum: string
  version: number
  kind: string
  mimeType: string
  episodeId: string | null
  sourceRevisionId: string | null
  entityType: VisualAssetEntityType | null
  entityId: string | null
}

export interface AssetImageEditBinding {
  schemaVersion: 1
  mode: ImageEditMode
  projectId: string
  sourceScope: 'episode' | 'project'
  expectedSourceRevisionId: string | null
  source: AssetImageSnapshotBinding
  references: AssetImageSnapshotBinding[]
  assetEntityBinding: VisualAssetEntityBinding | null
  nextVersion: number
}

export interface AssetImageEditJobInput extends ImageGenerationInput {
  operation: typeof ASSET_IMAGE_EDIT_JOB_TYPE
  sourceAssetId: string
  editBinding: AssetImageEditBinding
  assetEntityBinding?: VisualAssetEntityBinding
}

export interface PrepareAssetImageEditInput {
  projectId: string
  sourceAssetId: string
  sourceIfMatch: string
  mode: ImageEditMode
  referenceAssetIds: readonly string[]
}

export interface AssetImageEditProviderBinding {
  providerId: string
  model: string
  configRevision: number
}

export interface AssetImageEditReplayRequest {
  projectId: string
  sourceAssetId: string
  sourceIfMatch: string
  mode: ImageEditMode
  prompt: string
  size: ImageGenerationInput['size']
  quality: ImageGenerationInput['quality']
  referenceAssetIds: readonly string[]
  requestedProviderId?: string
}

function normalizedMimeType(value: string | null): string {
  return value?.split(';', 1)[0].trim().toLowerCase() ?? ''
}

function entityIdentity(value: unknown): { entityType: VisualAssetEntityType; entityId: string } | null {
  if (!isPlainObject(value)) return null
  const entityType = value.entityType
  const entityId = value.entityId
  if (entityType === undefined && entityId === undefined) return null
  if (!VISUAL_ASSET_ENTITY_TYPES.includes(entityType as VisualAssetEntityType)
    || typeof entityId !== 'string' || !entityId) {
    throw new AssetImageEditError('INVALID_SOURCE_ASSET', '源资产的实体绑定无效')
  }
  return { entityType: entityType as VisualAssetEntityType, entityId }
}

function assetEntityIdentity(
  database: ManjuDatabase,
  asset: MediaAssetRecord,
): { entityType: VisualAssetEntityType; entityId: string } | null {
  const fromParameters = entityIdentity(asset.generationParameters)
  const generationJob = asset.generationJobId
    ? database.getGenerationJob(asset.generationJobId)
    : undefined
  // Only the server-created immutable binding is authoritative. Job metadata
  // is client-influenced on legacy generation routes and must never relabel an
  // edited output as a character/location/prop candidate.
  const fromJob = entityIdentity(generationJob?.input.assetEntityBinding)
  if (fromParameters && fromJob && (fromParameters.entityType !== fromJob.entityType
    || fromParameters.entityId !== fromJob.entityId)) {
    throw new AssetImageEditError('INVALID_SOURCE_ASSET', '源资产与生成任务的实体绑定冲突')
  }
  return fromParameters ?? fromJob
}

function snapshot(
  database: ManjuDatabase,
  asset: MediaAssetRecord,
): AssetImageSnapshotBinding {
  const mimeType = normalizedMimeType(asset.mimeType)
  if (asset.status !== 'ready' || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) || !asset.checksum) {
    throw new AssetImageEditError(
      'INVALID_SOURCE_ASSET',
      '源资产必须是 ready 状态、内容已固化的受支持图片',
    )
  }
  if (!/^[a-f0-9]{64}$/i.test(asset.checksum)) {
    throw new AssetImageEditError('INVALID_SOURCE_ASSET', '源资产缺少可验证的内容校验和')
  }
  const entity = assetEntityIdentity(database, asset)
  return {
    assetId: asset.id,
    checksum: asset.checksum.toLowerCase(),
    version: asset.version,
    kind: asset.kind,
    mimeType,
    episodeId: asset.episodeId,
    sourceRevisionId: asset.sourceRevisionId,
    entityType: entity?.entityType ?? null,
    entityId: entity?.entityId ?? null,
  }
}

function referenceSnapshot(database: ManjuDatabase, asset: MediaAssetRecord): AssetImageSnapshotBinding {
  try {
    return snapshot(database, asset)
  } catch (error) {
    if (error instanceof AssetImageEditError) {
      throw new AssetImageEditError(
        'INVALID_REFERENCE_ASSET',
        '参考资产必须是 ready 状态、内容已固化的受支持图片',
      )
    }
    throw error
  }
}

/** Strong metadata ETag: byte identity plus the immutable asset version. */
export function assetImageEditEtag(asset: MediaAssetRecord): string | null {
  if (!asset.checksum || !/^[a-f0-9]{64}$/i.test(asset.checksum)) return null
  return `"asset-v${asset.version}-${asset.checksum.toLowerCase()}"`
}

function episodeSourceRevision(
  database: ManjuDatabase,
  projectId: string,
  episodeId: string,
): string {
  const row = database.withSql((sql) => sql.get(`
    SELECT source_revision_id FROM episodes WHERE id = ? AND project_id = ?
  `, episodeId, projectId))
  if (!row) throw new AssetImageEditError('INVALID_SOURCE_ASSET', '源资产所属分集不存在')
  if (typeof row.source_revision_id !== 'string' || !row.source_revision_id) {
    throw new AssetImageEditError('SOURCE_REVISION_MISSING', '源资产所属分集缺少可追溯的剧本修订')
  }
  return row.source_revision_id
}

function lineageRoot(database: ManjuDatabase, source: MediaAssetRecord): string {
  let current = source
  const visited = new Set<string>()
  while (current.parentAssetId) {
    if (visited.has(current.id)) {
      throw new AssetImageEditError('INVALID_SOURCE_ASSET', '源资产的版本谱系存在循环')
    }
    visited.add(current.id)
    const parent = database.getMediaAsset(current.parentAssetId)
    if (!parent || parent.projectId !== source.projectId) {
      throw new AssetImageEditError('INVALID_SOURCE_ASSET', '源资产的版本谱系不完整')
    }
    current = parent
  }
  return current.id
}

function nextAssetVersion(
  database: ManjuDatabase,
  source: MediaAssetRecord,
  entity: { entityType: VisualAssetEntityType; entityId: string } | null,
): number {
  let row: Record<string, unknown> | undefined
  if (entity && source.episodeId && source.sourceRevisionId) {
    row = database.withSql((sql) => sql.get(`
      SELECT MAX(media_assets.version) AS max_version
      FROM media_assets
      LEFT JOIN generation_jobs ON generation_jobs.id = media_assets.generation_job_id
      WHERE media_assets.project_id = ?
        AND media_assets.episode_id = ?
        AND media_assets.source_revision_id = ?
        AND (
          (
            json_extract(media_assets.generation_parameters_json, '$.entityType') = ?
            AND json_extract(media_assets.generation_parameters_json, '$.entityId') = ?
          )
          OR (
            json_extract(generation_jobs.input_json, '$.assetEntityBinding.entityType') = ?
            AND json_extract(generation_jobs.input_json, '$.assetEntityBinding.entityId') = ?
          )
        )
    `,
    source.projectId,
    source.episodeId,
    source.sourceRevisionId,
    entity.entityType,
    entity.entityId,
    entity.entityType,
    entity.entityId,
    ))
  } else {
    const rootId = lineageRoot(database, source)
    row = database.withSql((sql) => sql.get(`
      WITH RECURSIVE family(id) AS (
        SELECT ?
        UNION
        SELECT media_assets.id
        FROM media_assets
        JOIN family ON media_assets.parent_asset_id = family.id
        WHERE media_assets.project_id = ?
      )
      SELECT MAX(media_assets.version) AS max_version
      FROM media_assets JOIN family ON family.id = media_assets.id
    `, rootId, source.projectId))
  }
  const maximum = row?.max_version
  if (typeof maximum !== 'number' || !Number.isInteger(maximum) || maximum < 1) {
    throw new AssetImageEditError('INVALID_SOURCE_ASSET', '无法解析源资产的版本族')
  }
  return maximum + 1
}

function versionAlreadyClaimed(
  database: ManjuDatabase,
  source: MediaAssetRecord,
  binding: AssetImageEditBinding,
  excludeAssetId: string,
): boolean {
  let row: Record<string, unknown> | undefined
  if (binding.assetEntityBinding && source.episodeId && source.sourceRevisionId) {
    const entityBinding = binding.assetEntityBinding
    row = database.withSql((sql) => sql.get(`
      SELECT COUNT(*) AS candidate_count
      FROM media_assets
      LEFT JOIN generation_jobs ON generation_jobs.id = media_assets.generation_job_id
      WHERE media_assets.project_id = ?
        AND media_assets.episode_id = ?
        AND media_assets.source_revision_id = ?
        AND media_assets.version = ?
        AND media_assets.id <> ?
        AND (
          (
            json_extract(media_assets.generation_parameters_json, '$.entityType') = ?
            AND json_extract(media_assets.generation_parameters_json, '$.entityId') = ?
          )
          OR (
            json_extract(generation_jobs.input_json, '$.assetEntityBinding.entityType') = ?
            AND json_extract(generation_jobs.input_json, '$.assetEntityBinding.entityId') = ?
          )
        )
    `,
    source.projectId,
    source.episodeId,
    source.sourceRevisionId,
    binding.nextVersion,
    excludeAssetId,
    entityBinding.entityType,
    entityBinding.entityId,
    entityBinding.entityType,
    entityBinding.entityId,
    ))
  } else {
    const rootId = lineageRoot(database, source)
    row = database.withSql((sql) => sql.get(`
      WITH RECURSIVE family(id) AS (
        SELECT ?
        UNION
        SELECT media_assets.id
        FROM media_assets
        JOIN family ON media_assets.parent_asset_id = family.id
        WHERE media_assets.project_id = ?
      )
      SELECT COUNT(*) AS candidate_count
      FROM media_assets JOIN family ON family.id = media_assets.id
      WHERE media_assets.version = ? AND media_assets.id <> ?
    `, rootId, source.projectId, binding.nextVersion, excludeAssetId))
  }
  return typeof row?.candidate_count !== 'number' || row.candidate_count > 0
}

export function prepareAssetImageEdit(
  database: ManjuDatabase,
  input: PrepareAssetImageEditInput,
): AssetImageEditBinding {
  const project = database.getProject(input.projectId)
  if (!project) throw new AssetImageEditError('PROJECT_NOT_FOUND', '项目不存在')
  const source = database.getMediaAsset(input.sourceAssetId)
  // Ownership failures deliberately look identical to missing assets.
  if (!source || source.projectId !== input.projectId) {
    throw new AssetImageEditError('ASSET_NOT_FOUND', '资产不存在或不属于当前项目')
  }
  const expectedSourceRevisionId = source.episodeId
    ? episodeSourceRevision(database, input.projectId, source.episodeId)
    : source.sourceRevisionId
  if (source.sourceRevisionId !== expectedSourceRevisionId) {
    throw new AssetImageEditError(
      'STALE_SOURCE',
      '源资产不属于当前分集或项目修订',
    )
  }
  if (!source.episodeId && expectedSourceRevisionId !== null
    && project.currentRevisionId !== expectedSourceRevisionId) {
    throw new AssetImageEditError(
      'STALE_SOURCE',
      '项目级源资产不属于当前项目修订',
    )
  }
  const sourceBinding = snapshot(database, source)
  const currentEtag = assetImageEditEtag(source)
  if (!currentEtag || input.sourceIfMatch !== currentEtag) {
    throw new AssetImageEditError(
      'PRECONDITION_FAILED',
      '源资产版本已变更，请刷新后重试',
      { currentEtag: currentEtag ?? null },
    )
  }
  if (input.referenceAssetIds.length > MAX_ASSET_IMAGE_EDIT_REFERENCES) {
    throw new AssetImageEditError(
      'INVALID_REFERENCE_ASSET',
      `参考图不能超过 ${MAX_ASSET_IMAGE_EDIT_REFERENCES} 张`,
    )
  }
  if (input.mode === 'variation' && input.referenceAssetIds.length > 0) {
    throw new AssetImageEditError(
      'INVALID_REFERENCE_ASSET',
      'variation 使用真实 images/variations 协议，只接受主图；多参考图请使用 edit',
    )
  }
  const uniqueIds = [...new Set(input.referenceAssetIds)]
  if (uniqueIds.length !== input.referenceAssetIds.length || uniqueIds.includes(source.id)) {
    throw new AssetImageEditError('INVALID_REFERENCE_ASSET', '参考图不能重复或与主图相同')
  }
  const references = uniqueIds.map((assetId) => {
    const asset = database.getMediaAsset(assetId)
    if (!asset || asset.projectId !== input.projectId) {
      throw new AssetImageEditError(
        'INVALID_REFERENCE_ASSET',
        '参考资产不存在或不属于当前项目',
      )
    }
    const reference = referenceSnapshot(database, asset)
    if (reference.episodeId !== source.episodeId
      || reference.sourceRevisionId !== expectedSourceRevisionId) {
      throw new AssetImageEditError(
        'INVALID_REFERENCE_ASSET',
        '参考图必须与主图属于同一分集和当前源修订',
      )
    }
    if (sourceBinding.entityType
      && (reference.entityType !== sourceBinding.entityType
        || reference.entityId !== sourceBinding.entityId)) {
      throw new AssetImageEditError(
        'INVALID_REFERENCE_ASSET',
        '实体绑定图片的参考图必须显式绑定到同一角色、场景或道具',
      )
    }
    return reference
  })
  let assetEntityBinding: VisualAssetEntityBinding | null = null
  if (sourceBinding.entityType && sourceBinding.entityId) {
    if (!source.episodeId || !expectedSourceRevisionId) {
      throw new AssetImageEditError('INVALID_SOURCE_ASSET', '实体绑定的源资产缺少分集与源修订')
    }
    const entity = resolveVisualAssetEntity(database, {
      projectId: input.projectId,
      episodeId: source.episodeId,
      entityType: sourceBinding.entityType,
      entityId: sourceBinding.entityId,
    })
    if (entity.sourceRevisionId !== expectedSourceRevisionId) {
      throw new AssetImageEditError('STALE_SOURCE', '源资产的实体绑定已过期')
    }
    assetEntityBinding = {
      episodeId: source.episodeId,
      entityType: entity.type,
      entityId: entity.id,
      databaseEntityId: entity.databaseId,
      expectedRevisionId: expectedSourceRevisionId,
      parentAssetId: source.id,
      nextVersion: nextAssetVersion(database, source, {
        entityType: entity.type,
        entityId: entity.id,
      }),
    }
  }
  const nextVersion = assetEntityBinding?.nextVersion ?? nextAssetVersion(database, source, null)
  return {
    schemaVersion: 1,
    mode: input.mode,
    projectId: input.projectId,
    sourceScope: source.episodeId ? 'episode' : 'project',
    expectedSourceRevisionId,
    source: sourceBinding,
    references,
    assetEntityBinding,
    nextVersion,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validSnapshot(value: unknown): value is AssetImageSnapshotBinding {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'assetId',
    'checksum',
    'version',
    'kind',
    'mimeType',
    'episodeId',
    'sourceRevisionId',
    'entityType',
    'entityId',
  ])) return false
  return typeof value.assetId === 'string' && Boolean(value.assetId)
    && typeof value.checksum === 'string' && /^[a-f0-9]{64}$/.test(value.checksum)
    && Number.isInteger(value.version) && (value.version as number) > 0
    && typeof value.kind === 'string' && Boolean(value.kind)
    && typeof value.mimeType === 'string' && SUPPORTED_IMAGE_MIME_TYPES.has(value.mimeType)
    && (value.episodeId === null || typeof value.episodeId === 'string')
    && (value.sourceRevisionId === null || typeof value.sourceRevisionId === 'string')
    && (value.entityType === null || VISUAL_ASSET_ENTITY_TYPES.includes(value.entityType as VisualAssetEntityType))
    && (value.entityId === null || typeof value.entityId === 'string')
    && ((value.entityType === null) === (value.entityId === null))
}

function validEntityBinding(value: unknown): value is VisualAssetEntityBinding {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'episodeId',
    'entityType',
    'entityId',
    'databaseEntityId',
    'expectedRevisionId',
    'parentAssetId',
    'nextVersion',
  ])) return false
  return typeof value.episodeId === 'string' && Boolean(value.episodeId)
    && VISUAL_ASSET_ENTITY_TYPES.includes(value.entityType as VisualAssetEntityType)
    && typeof value.entityId === 'string' && Boolean(value.entityId)
    && typeof value.databaseEntityId === 'string' && Boolean(value.databaseEntityId)
    && typeof value.expectedRevisionId === 'string' && Boolean(value.expectedRevisionId)
    && (value.parentAssetId === null || typeof value.parentAssetId === 'string')
    && Number.isInteger(value.nextVersion) && (value.nextVersion as number) > 0
}

function durableBinding(value: unknown): AssetImageEditBinding {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'schemaVersion',
    'mode',
    'projectId',
    'sourceScope',
    'expectedSourceRevisionId',
    'source',
    'references',
    'assetEntityBinding',
    'nextVersion',
  ])
    || value.schemaVersion !== 1
    || (value.mode !== 'edit' && value.mode !== 'variation')
    || typeof value.projectId !== 'string' || !value.projectId
    || (value.sourceScope !== 'episode' && value.sourceScope !== 'project')
    || (value.expectedSourceRevisionId !== null
      && (typeof value.expectedSourceRevisionId !== 'string' || !value.expectedSourceRevisionId))
    || !validSnapshot(value.source)
    || !Array.isArray(value.references)
    || value.references.length > MAX_ASSET_IMAGE_EDIT_REFERENCES
    || !value.references.every(validSnapshot)
    || (value.assetEntityBinding !== null && !validEntityBinding(value.assetEntityBinding))
    || !Number.isInteger(value.nextVersion) || (value.nextVersion as number) < 2) {
    throw new JobExecutionError(
      'INVALID_ASSET_EDIT_BINDING',
      '图片编辑任务缺少安全的源资产快照绑定',
      false,
      'validation',
    )
  }
  const binding = value as unknown as AssetImageEditBinding
  const referenceIds = binding.references.map((reference) => reference.assetId)
  if (new Set(referenceIds).size !== referenceIds.length || referenceIds.includes(binding.source.assetId)) {
    throw new JobExecutionError(
      'INVALID_ASSET_EDIT_BINDING',
      '图片编辑任务的参考资产绑定无效',
      false,
      'validation',
    )
  }
  if ((binding.sourceScope === 'episode') !== (binding.source.episodeId !== null)
    || binding.source.sourceRevisionId !== binding.expectedSourceRevisionId
    || binding.references.some((reference) => (
      reference.episodeId !== binding.source.episodeId
      || reference.sourceRevisionId !== binding.expectedSourceRevisionId
    ))
    || (binding.source.entityType !== null && binding.references.some((reference) => (
      reference.entityType !== binding.source.entityType
      || reference.entityId !== binding.source.entityId
    )))
    || (binding.assetEntityBinding !== null && (
      binding.assetEntityBinding.episodeId !== binding.source.episodeId
      || binding.assetEntityBinding.entityType !== binding.source.entityType
      || binding.assetEntityBinding.entityId !== binding.source.entityId
      || binding.assetEntityBinding.expectedRevisionId !== binding.expectedSourceRevisionId
      || binding.assetEntityBinding.parentAssetId !== binding.source.assetId
      || binding.assetEntityBinding.nextVersion !== binding.nextVersion
    ))) {
    throw new JobExecutionError(
      'INVALID_ASSET_EDIT_BINDING',
      '图片编辑任务的源修订、实体或版本族绑定不一致',
      false,
      'validation',
    )
  }
  return binding
}

function sameAssetImageEditFamily(
  database: ManjuDatabase,
  left: AssetImageEditBinding,
  right: AssetImageEditBinding,
): boolean {
  if (left.projectId !== right.projectId) return false
  if (left.source.assetId === right.source.assetId) return true
  if (left.assetEntityBinding && right.assetEntityBinding) {
    return left.assetEntityBinding.episodeId === right.assetEntityBinding.episodeId
      && left.assetEntityBinding.expectedRevisionId === right.assetEntityBinding.expectedRevisionId
      && left.assetEntityBinding.entityType === right.assetEntityBinding.entityType
      && left.assetEntityBinding.entityId === right.assetEntityBinding.entityId
  }
  const leftSource = database.getMediaAsset(left.source.assetId)
  const rightSource = database.getMediaAsset(right.source.assetId)
  if (!leftSource || !rightSource
    || leftSource.projectId !== left.projectId
    || rightSource.projectId !== right.projectId) return false
  try {
    return lineageRoot(database, leftSource) === lineageRoot(database, rightSource)
  } catch {
    return false
  }
}

/**
 * Admission guard for the immutable nextVersion reservation. The provider:image
 * worker is still serial and revalidates the version immediately before a paid
 * request; this guard prevents a known-conflicting second job from entering the
 * queue in the first place.
 */
export function assertNoActiveAssetImageEditConflict(
  database: ManjuDatabase,
  binding: AssetImageEditBinding,
): void {
  const source = database.getMediaAsset(binding.source.assetId)
  const entity = binding.assetEntityBinding
    ? {
        entityType: binding.assetEntityBinding.entityType,
        entityId: binding.assetEntityBinding.entityId,
      }
    : null
  if (!source || nextAssetVersion(database, source, entity) !== binding.nextVersion) {
    throw new AssetImageEditError(
      'ASSET_VERSION_FAMILY_BUSY',
      '同一视觉资产版本族已发生变化，请刷新后重试；未发起新的计费请求',
    )
  }
  const rows = database.withSql((sql) => sql.all(`
    SELECT id FROM generation_jobs
    WHERE project_id = ?
      AND type IN (?, 'asset.image.generate')
      AND status IN ('queued', 'running', 'waiting_provider')
    ORDER BY created_at, id
  `, binding.projectId, ASSET_IMAGE_EDIT_JOB_TYPE))
  for (const row of rows) {
    if (typeof row.id !== 'string') continue
    const job = database.getGenerationJob(row.id)
    if (!job) continue
    let conflicts = false
    if (job.type === 'asset.image.generate') {
      const generatedBinding = validEntityBinding(job.input.assetEntityBinding)
        ? job.input.assetEntityBinding
        : null
      conflicts = Boolean(binding.assetEntityBinding && generatedBinding
        && generatedBinding.episodeId === binding.assetEntityBinding.episodeId
        && generatedBinding.expectedRevisionId === binding.assetEntityBinding.expectedRevisionId
        && generatedBinding.entityType === binding.assetEntityBinding.entityType
        && generatedBinding.entityId === binding.assetEntityBinding.entityId)
    } else {
      let activeBinding: AssetImageEditBinding | null = null
      try {
        activeBinding = durableBinding(job.input.editBinding)
      } catch {
        // A malformed active row cannot reserve a broad entity family, but its
        // server-authored resource_id still safely reserves the exact source.
        conflicts = job.resourceId === binding.source.assetId
      }
      if (activeBinding) conflicts = sameAssetImageEditFamily(database, binding, activeBinding)
    }
    if (!conflicts) continue
    throw new AssetImageEditError(
      'ASSET_VERSION_FAMILY_BUSY',
      '同一视觉资产版本族已有图片生成或编辑任务，未发起新的计费请求',
      { activeJobId: job.id },
    )
  }
}

/** Symmetric admission guard used by server-created entity generations. */
export function assertNoActiveVisualAssetGenerationConflict(
  database: ManjuDatabase,
  projectId: string,
  binding: VisualAssetEntityBinding,
): void {
  const current = createVisualAssetEntityBinding(database, {
    projectId,
    episodeId: binding.episodeId,
    entityType: binding.entityType,
    entityId: binding.entityId,
  })
  if (!isDeepStrictEqual(current, binding)) {
    throw new AssetImageEditError(
      'ASSET_VERSION_FAMILY_BUSY',
      '同一视觉资产版本族已发生变化，请刷新后重试；未发起新的计费请求',
    )
  }
  const rows = database.withSql((sql) => sql.all(`
    SELECT id FROM generation_jobs
    WHERE project_id = ?
      AND type IN (?, 'asset.image.generate')
      AND status IN ('queued', 'running', 'waiting_provider')
    ORDER BY created_at, id
  `, projectId, ASSET_IMAGE_EDIT_JOB_TYPE))
  for (const row of rows) {
    if (typeof row.id !== 'string') continue
    const job = database.getGenerationJob(row.id)
    if (!job) continue
    let active: VisualAssetEntityBinding | null = null
    if (job.type === 'asset.image.generate') {
      active = validEntityBinding(job.input.assetEntityBinding)
        ? job.input.assetEntityBinding
        : null
    } else {
      try {
        active = durableBinding(job.input.editBinding).assetEntityBinding
      } catch {
        active = null
      }
    }
    if (!active
      || active.episodeId !== binding.episodeId
      || active.expectedRevisionId !== binding.expectedRevisionId
      || active.entityType !== binding.entityType
      || active.entityId !== binding.entityId) continue
    throw new AssetImageEditError(
      'ASSET_VERSION_FAMILY_BUSY',
      '同一视觉资产版本族已有图片生成或编辑任务，未发起新的计费请求',
      { activeJobId: job.id },
    )
  }
}

function sameSnapshot(
  database: ManjuDatabase,
  asset: MediaAssetRecord | undefined,
  binding: AssetImageSnapshotBinding,
): boolean {
  let entity: { entityType: VisualAssetEntityType; entityId: string } | null = null
  if (asset) {
    try {
      entity = assetEntityIdentity(database, asset)
    } catch {
      return false
    }
  }
  return Boolean(asset)
    && asset!.id === binding.assetId
    && asset!.status === 'ready'
    && asset!.checksum?.toLowerCase() === binding.checksum
    && asset!.version === binding.version
    && asset!.kind === binding.kind
    && normalizedMimeType(asset!.mimeType) === binding.mimeType
    && asset!.episodeId === binding.episodeId
    && asset!.sourceRevisionId === binding.sourceRevisionId
    && (entity?.entityType ?? null) === binding.entityType
    && (entity?.entityId ?? null) === binding.entityId
}

function assertCurrentBinding(
  database: ManjuDatabase,
  binding: AssetImageEditBinding,
  publishedAssetId?: string,
): void {
  const project = database.getProject(binding.projectId)
  if (!project) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '项目已删除，未发起图片编辑计费请求',
      false,
      'validation',
    )
  }
  if (binding.sourceScope === 'episode') {
    const row = database.withSql((sql) => sql.get(`
      SELECT source_revision_id FROM episodes WHERE id = ? AND project_id = ?
    `, binding.source.episodeId, binding.projectId))
    if (!row || row.source_revision_id !== binding.expectedSourceRevisionId) {
      throw new JobExecutionError(
        'STALE_SOURCE',
        '分集源修订已变更，未发起图片编辑计费请求',
        false,
        'validation',
      )
    }
  } else if (binding.expectedSourceRevisionId !== null
    && project.currentRevisionId !== binding.expectedSourceRevisionId) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '项目源修订已变更，未发起图片编辑计费请求',
      false,
      'validation',
    )
  }
  const source = database.getMediaAsset(binding.source.assetId)
  if (!sameSnapshot(database, source, binding.source) || source?.projectId !== binding.projectId) {
    throw new JobExecutionError(
      'STALE_SOURCE_ASSET',
      '源图内容或版本已变更，未发起图片编辑计费请求',
      false,
      'validation',
    )
  }
  if (binding.assetEntityBinding) {
    let entity
    try {
      entity = resolveVisualAssetEntity(database, {
        projectId: binding.projectId,
        episodeId: binding.assetEntityBinding.episodeId,
        entityType: binding.assetEntityBinding.entityType,
        entityId: binding.assetEntityBinding.entityId,
      })
    } catch (error) {
      if (error instanceof VisualAssetGenerationError) {
        throw new JobExecutionError('STALE_ASSET_ENTITY', '源资产绑定的视觉实体已变更', false, 'validation')
      }
      throw error
    }
    if (entity.databaseId !== binding.assetEntityBinding.databaseEntityId
      || entity.sourceRevisionId !== binding.assetEntityBinding.expectedRevisionId
      || entity.type !== binding.assetEntityBinding.entityType
      || entity.id !== binding.assetEntityBinding.entityId) {
      throw new JobExecutionError('STALE_ASSET_ENTITY', '源资产绑定的视觉实体已变更', false, 'validation')
    }
  }
  for (const reference of binding.references) {
    const asset = database.getMediaAsset(reference.assetId)
    if (!sameSnapshot(database, asset, reference) || asset?.projectId !== binding.projectId) {
      throw new JobExecutionError(
        'STALE_REFERENCE_ASSET',
        '参考图内容或版本已变更，未发起图片编辑计费请求',
        false,
        'validation',
      )
    }
  }
  const entity = binding.assetEntityBinding
    ? {
        entityType: binding.assetEntityBinding.entityType,
        entityId: binding.assetEntityBinding.entityId,
      }
    : null
  const versionConflict = publishedAssetId
    ? versionAlreadyClaimed(database, source!, binding, publishedAssetId)
    : nextAssetVersion(database, source!, entity) !== binding.nextVersion
  if (versionConflict) {
    throw new JobExecutionError(
      'ASSET_VERSION_CONFLICT',
      '同一视觉资产版本族已新增候选，请刷新后重试',
      false,
      'validation',
    )
  }
}

async function loadBoundImage(
  database: ManjuDatabase,
  mediaStore: MediaStore,
  binding: AssetImageSnapshotBinding,
  signal: AbortSignal,
): Promise<{ reference: ProviderImageReference; size: number }> {
  let opened
  try {
    opened = await mediaStore.openAsset(binding.assetId)
  } catch (error) {
    if (error instanceof MediaStoreError) {
      throw new JobExecutionError(
        'ASSET_IMAGE_UNAVAILABLE',
        '图片文件不可用，未发起图片编辑计费请求',
        false,
        'validation',
      )
    }
    throw error
  }
  try {
    if (opened.size > MAX_ASSET_IMAGE_EDIT_SOURCE_BYTES) {
      throw new JobExecutionError(
        'ASSET_IMAGE_TOO_LARGE',
        '单张编辑图片不能超过 30MB，未发起计费请求',
        false,
        'validation',
      )
    }
    const bytes = await opened.file.readFile()
    signal.throwIfAborted()
    const checksum = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== opened.size
      || checksum !== binding.checksum
      || opened.mimeType !== binding.mimeType
      || !sameSnapshot(database, opened.asset, binding)) {
      throw new JobExecutionError(
        'STALE_ASSET_BYTES',
        '图片文件与固化校验和不一致，未发起计费请求',
        false,
        'validation',
      )
    }
    return { reference: { bytes, mimeType: opened.mimeType }, size: bytes.byteLength }
  } finally {
    await opened.file.close().catch(() => undefined)
  }
}

function requiredCapability(mode: ImageEditMode): 'edit' | 'variations' {
  return mode === 'edit' ? 'edit' : 'variations'
}

function assertProviderState(
  provider: ProviderPublicState | undefined,
  job: JobRecord<AssetImageEditJobInput>,
  mode: ImageEditMode,
): ProviderPublicState {
  if (!provider
    || provider.kind !== 'image'
    || !provider.enabled
    || provider.credentialState === 'missing'
    || provider.configRevision !== job.providerConfigRevision
    || provider.model !== job.model) {
    throw new JobExecutionError(
      'PROVIDER_CONFIGURATION_DRIFT',
      'Provider 配置已变更，未发起图片编辑计费请求',
      false,
      'validation',
    )
  }
  if (!provider.capabilities.includes(requiredCapability(mode))) {
    throw new JobExecutionError(
      'PROVIDER_CAPABILITY_MISSING',
      `当前 Provider 未明确声明 ${requiredCapability(mode)} 能力`,
      false,
      'validation',
    )
  }
  return provider
}

function providerExecutionError(error: ImageProviderError): JobExecutionError {
  const upper = error.code.toUpperCase()
  const category = upper.includes('AUTH') || upper.includes('API_KEY')
    ? 'authentication'
    : upper.includes('CONTENT') || upper.includes('SAFETY')
      ? 'content_policy'
      : upper.includes('INVALID') || upper.includes('UNSAFE') || upper.includes('TOO_LARGE')
        ? 'validation'
        : 'provider'
  return new JobExecutionError(error.code, error.message, error.retryable, category)
}

function assertPublication(
  database: ManjuDatabase,
  input: {
    jobId: string
    binding: AssetImageEditBinding
    providerId: string
    providerConfigRevision: number
    model: string
    publishedAssetId: string
  },
): void {
  const job = database.getGenerationJob(input.jobId)
  if (!job
    || job.type !== ASSET_IMAGE_EDIT_JOB_TYPE
    || job.projectId !== input.binding.projectId
    || (job.status !== 'running' && job.status !== 'waiting_provider')
    || job.providerId !== input.providerId
    || job.providerConfigRevision !== input.providerConfigRevision
    || job.model !== input.model) {
    throw new JobExecutionError(
      'JOB_NOT_ACTIVE',
      '图片编辑任务已取消、结束或绑定已变更；生成资产已回滚',
      false,
      'cancelled',
    )
  }
  assertCurrentBinding(database, input.binding, input.publishedAssetId)
  const provider = database.getProviderConnection(input.providerId)
  if (!provider
    || !provider.enabled
    || provider.configRevision !== input.providerConfigRevision
    || provider.defaultModel !== input.model) {
    throw new JobExecutionError(
      'PROVIDER_CONFIGURATION_DRIFT',
      'Provider 在生成期间已变更；生成资产已回滚',
      false,
      'validation',
    )
  }
}

export interface AssetImageEditHandlerDependencies {
  database: ManjuDatabase
  mediaStore: MediaStore
  providerService: ProviderService
  injectedProvider?: ImageProvider
  generationTimeoutMs: number
  publicAsset: (asset: MediaAssetRecord) => JsonObject
  publishAsset: (asset: MediaAssetRecord) => void
}

export function createAssetImageEditHandler(
  dependencies: AssetImageEditHandlerDependencies,
): JobHandler<AssetImageEditJobInput, JsonObject> {
  return async (
    job: JobRecord<AssetImageEditJobInput>,
    context: JobHandlerContext,
  ): Promise<JsonObject> => {
    const durable = dependencies.database.getGenerationJob(job.id)
    if (!durable) throw new JobExecutionError('JOB_NOT_FOUND', '图片编辑任务不存在', false, 'validation')
    if (!durable.providerId || durable.providerConfigRevision === null || !durable.model) {
      throw new JobExecutionError('PROVIDER_NOT_CONFIGURED', '任务缺少固化的图片 Provider 绑定', false, 'validation')
    }
    const binding = durableBinding(job.input.editBinding)
    if (job.input.operation !== ASSET_IMAGE_EDIT_JOB_TYPE
      || job.input.sourceAssetId !== binding.source.assetId) {
      throw new JobExecutionError(
        'INVALID_ASSET_EDIT_BINDING',
        '图片编辑任务的 operation/sourceAssetId 与固化快照不一致',
        false,
        'validation',
      )
    }
    if (job.projectId !== binding.projectId || durable.projectId !== binding.projectId) {
      throw new JobExecutionError('INVALID_ASSET_EDIT_BINDING', '图片编辑任务与项目绑定不一致', false, 'validation')
    }
    if (!isDeepStrictEqual(job.input.assetEntityBinding ?? null, binding.assetEntityBinding)) {
      throw new JobExecutionError(
        'INVALID_ASSET_EDIT_BINDING',
        '图片编辑任务的公开实体绑定与源快照不一致',
        false,
        'validation',
      )
    }
    if (job.input.count !== 1) {
      throw new JobExecutionError('INVALID_ASSET_EDIT_COUNT', '持久图片编辑任务一次只能生成一张', false, 'validation')
    }

    const priorState = isPlainObject(job.providerState) ? job.providerState : undefined
    if (priorState?.operation === ASSET_IMAGE_EDIT_JOB_TYPE
      && (priorState.phase === 'submitting' || priorState.phase === 'response-received')
      && priorState.providerSupportsIdempotency !== true) {
      throw new JobExecutionError(
        'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
        '上次图片编辑请求结果无法确认。为避免重复计费，系统不会自动重提。',
        false,
        'provider',
      )
    }

    assertCurrentBinding(dependencies.database, binding)
    const providers = await dependencies.providerService.list()
    assertProviderState(
      providers.find((candidate) => candidate.id === durable.providerId),
      job,
      binding.mode,
    )

    let profile
    try {
      profile = await dependencies.providerService.materializeExecutionProfile(
        durable.providerId,
        durable.providerConfigRevision,
      )
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        throw new JobExecutionError(error.code, error.message, false, 'validation')
      }
      throw error
    }
    if (profile.kind !== 'image'
      || profile.model !== durable.model
      || profile.configRevision !== durable.providerConfigRevision
      || (profile.adapter !== 'codex-tools' && profile.adapter !== 'openai-compatible')
      || !profile.baseUrl) {
      throw new JobExecutionError(
        'PROVIDER_CONFIGURATION_DRIFT',
        '固化的图片 Provider 执行配置无效或已漂移',
        false,
        'validation',
      )
    }
    const definition = getProviderDefinition(durable.providerId)
    if (!definition?.capabilities.includes(requiredCapability(binding.mode))) {
      throw new JobExecutionError(
        'PROVIDER_CAPABILITY_MISSING',
        `Provider 目录未明确声明 ${requiredCapability(binding.mode)} 能力`,
        false,
        'validation',
      )
    }
    const executionProvider = dependencies.injectedProvider && durable.providerId === 'codex-tools-image'
      ? dependencies.injectedProvider
      : new CodexToolsImageProvider({
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
          model: profile.model,
        })
    const adapterCapability = binding.mode === 'edit'
      ? executionProvider.supportsImageEdits
      : executionProvider.supportsImageVariations
    if (adapterCapability !== true || typeof executionProvider.edit !== 'function') {
      throw new JobExecutionError(
        'PROVIDER_CAPABILITY_MISSING',
        `当前图片 Adapter 未明确实现 ${binding.mode} 能力`,
        false,
        'validation',
      )
    }

    const source = await loadBoundImage(
      dependencies.database,
      dependencies.mediaStore,
      binding.source,
      context.signal,
    )
    const references = [] as ProviderImageReference[]
    let totalBytes = source.size
    for (const referenceBinding of binding.references) {
      const loaded = await loadBoundImage(
        dependencies.database,
        dependencies.mediaStore,
        referenceBinding,
        context.signal,
      )
      totalBytes += loaded.size
      if (totalBytes > MAX_ASSET_IMAGE_EDIT_TOTAL_BYTES) {
        throw new JobExecutionError(
          'ASSET_IMAGES_TOO_LARGE',
          '主图与参考图总大小不能超过 60MB，未发起计费请求',
          false,
          'validation',
        )
      }
      references.push(loaded.reference)
    }

    // Close configuration/source races created by the asynchronous Keychain
    // and file reads immediately before the first paid POST.
    assertCurrentBinding(dependencies.database, binding)
    assertProviderState(
      (await dependencies.providerService.list()).find((candidate) => candidate.id === durable.providerId),
      job,
      binding.mode,
    )

    await context.reportProgress(5, {
      stage: 'provider-request',
      mode: binding.mode,
      sourceAssetId: binding.source.assetId,
      referenceAssetIds: binding.references.map((reference) => reference.assetId),
    })
    await context.waitingForProvider({
      operation: ASSET_IMAGE_EDIT_JOB_TYPE,
      mode: binding.mode,
      phase: 'submitting',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: durable.providerId,
      providerConfigRevision: durable.providerConfigRevision,
      sourceAssetId: binding.source.assetId,
      referenceAssetIds: binding.references.map((reference) => reference.assetId),
      submittedAt: new Date().toISOString(),
    })
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('asset image edit timeout')), dependencies.generationTimeoutMs)
    timer.unref()
    const signal = AbortSignal.any([context.signal, timeout.signal])
    let images
    try {
      images = await executionProvider.edit(job.input, signal, source.reference, references, binding.mode)
    } catch (error) {
      if (context.signal.aborted) throw error
      if (timeout.signal.aborted) {
        throw new JobExecutionError('PROVIDER_TIMEOUT', '图片编辑超时，请稍后重试', true, 'timeout')
      }
      if (error instanceof ImageProviderError) {
        if (error.code !== 'UPSTREAM_UNAVAILABLE') {
          await context.waitingForProvider({
            operation: ASSET_IMAGE_EDIT_JOB_TYPE,
            mode: binding.mode,
            phase: 'failed',
            clientRequestId: job.id,
            providerSupportsIdempotency: false,
            providerId: durable.providerId,
            providerConfigRevision: durable.providerConfigRevision,
            providerFailureConfirmed: true,
            providerErrorCode: error.code,
            failedAt: new Date().toISOString(),
          })
        }
        throw providerExecutionError(error)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (images.length !== 1) {
      throw new JobExecutionError('INVALID_IMAGE_RESPONSE', '图片服务返回数量与固化请求不一致', true, 'provider')
    }
    await context.waitingForProvider({
      operation: ASSET_IMAGE_EDIT_JOB_TYPE,
      mode: binding.mode,
      phase: 'response-received',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: durable.providerId,
      providerConfigRevision: durable.providerConfigRevision,
      receivedAt: new Date().toISOString(),
      imageCount: 1,
    })
    context.signal.throwIfAborted()

    const image = images[0]
    const dimensions = imageDimensions(image.bytes, image.mimeType)
    const generationParameters: JsonObject = {
      operation: ASSET_IMAGE_EDIT_JOB_TYPE,
      assetFamilyId: stableAssetIdForVersion(
        dependencies.database,
        binding.projectId,
        binding.source.assetId,
      ) ?? binding.source.assetId,
      mode: binding.mode,
      prompt: job.input.prompt,
      size: job.input.size,
      quality: job.input.quality,
      source: {
        assetId: binding.source.assetId,
        checksum: binding.source.checksum,
        version: binding.source.version,
        sourceRevisionId: binding.source.sourceRevisionId,
      },
      references: binding.references.map((reference) => ({
        assetId: reference.assetId,
        checksum: reference.checksum,
        version: reference.version,
        sourceRevisionId: reference.sourceRevisionId,
      })),
      provider: {
        providerId: durable.providerId,
        model: durable.model,
        configRevision: durable.providerConfigRevision,
      },
      ...(binding.assetEntityBinding ? {
        entityType: binding.assetEntityBinding.entityType,
        entityId: binding.assetEntityBinding.entityId,
        sourceRevisionId: binding.assetEntityBinding.expectedRevisionId,
        assetEntityBinding: { ...binding.assetEntityBinding },
      } : {}),
    }
    const asset = await dependencies.mediaStore.save({
      projectId: binding.projectId,
      episodeId: binding.source.episodeId,
      kind: binding.source.kind,
      version: binding.nextVersion,
      bytes: image.bytes,
      mimeType: image.mimeType,
      source: 'provider',
      providerId: durable.providerId,
      generationJobId: job.id,
      generationParameters,
      sourceRevisionId: binding.expectedSourceRevisionId,
      parentAssetId: binding.source.assetId,
      width: dimensions.width,
      height: dimensions.height,
    }, {
      afterCreate(createdAsset, transaction) {
        context.signal.throwIfAborted()
        assertPublication(transaction, {
          jobId: job.id,
          binding,
          providerId: durable.providerId!,
          providerConfigRevision: durable.providerConfigRevision!,
          model: durable.model!,
          publishedAssetId: createdAsset.id,
        })
      },
    })
    dependencies.publishAsset(asset)
    await context.reportProgress(95, {
      stage: 'saving-asset',
      mode: binding.mode,
      assetId: asset.id,
    })
    return {
      images: [{
        ...dependencies.publicAsset(asset),
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
      }],
      edit: {
        mode: binding.mode,
        sourceAssetId: binding.source.assetId,
        referenceAssetIds: binding.references.map((reference) => reference.assetId),
      },
    }
  }
}

export function assertAssetImageEditProviderCapability(
  provider: ProviderPublicState | undefined,
  mode: ImageEditMode,
): ProviderPublicState {
  if (!provider) throw new AssetImageEditError('PROVIDER_NOT_FOUND', '图片 Provider 不存在')
  if (provider.kind !== 'image') throw new AssetImageEditError('PROVIDER_NOT_FOUND', '图片 Provider 不存在')
  if (!provider.enabled || provider.credentialState === 'missing' || !provider.model) {
    throw new AssetImageEditError('PROVIDER_NOT_CONFIGURED', '请先配置并启用图片 Provider')
  }
  const capability = requiredCapability(mode)
  if (!provider.capabilities.includes(capability)) {
    throw new AssetImageEditError(
      'PROVIDER_CAPABILITY_MISSING',
      `当前 Provider 未明确声明 ${capability} 能力，不会降级为文生图`,
    )
  }
  return provider
}

export function sameAssetImageEditSubmission(
  existing: GenerationJobRecord,
  input: AssetImageEditJobInput,
  provider: AssetImageEditProviderBinding,
): boolean {
  return existing.type === ASSET_IMAGE_EDIT_JOB_TYPE
    && existing.providerId === provider.providerId
    && existing.model === provider.model
    && existing.providerConfigRevision === provider.configRevision
    && isDeepStrictEqual(existing.input, input)
}

/** Exact HTTP replay comparison, deliberately excluding derived nextVersion. */
export function sameAssetImageEditReplay(
  existing: GenerationJobRecord,
  request: AssetImageEditReplayRequest,
): boolean {
  if (existing.type !== ASSET_IMAGE_EDIT_JOB_TYPE
    || existing.projectId !== request.projectId
    || (request.requestedProviderId && existing.providerId !== request.requestedProviderId)) return false
  const input = existing.input as Partial<AssetImageEditJobInput>
  let binding: AssetImageEditBinding
  try {
    binding = durableBinding(input.editBinding)
  } catch {
    return false
  }
  const expectedEtag = `"asset-v${binding.source.version}-${binding.source.checksum}"`
  return input.prompt === request.prompt
    && input.size === request.size
    && input.quality === request.quality
    && input.count === 1
    && input.operation === ASSET_IMAGE_EDIT_JOB_TYPE
    && input.sourceAssetId === request.sourceAssetId
    && binding.projectId === request.projectId
    && binding.source.assetId === request.sourceAssetId
    && expectedEtag === request.sourceIfMatch
    && binding.mode === request.mode
    && isDeepStrictEqual(
      binding.references.map((reference) => reference.assetId),
      [...request.referenceAssetIds],
    )
}
