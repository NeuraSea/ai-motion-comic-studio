import type { ManjuDatabase, MediaAssetRecord } from './database.js'
import type { JsonObject } from './types.js'
import { JobExecutionError } from './worker.js'

export const VISUAL_ASSET_ENTITY_TYPES = ['character', 'location', 'prop'] as const
export type VisualAssetEntityType = (typeof VISUAL_ASSET_ENTITY_TYPES)[number]

export interface VisualAssetEntityBinding {
  episodeId: string
  entityType: VisualAssetEntityType
  entityId: string
  databaseEntityId: string
  expectedRevisionId: string
  parentAssetId: string | null
  nextVersion: number
}

export interface VisualAssetEntityTarget {
  type: VisualAssetEntityType
  id: string
  name: string
  description: string
  visualDescription: string
  role: string | null
  version: number
  lockedAssetId: string | null
  /** Present only for characters; each role is an independently persisted Asset slot. */
  lockedReferences?: {
    frontAssetId: string | null
    sideAssetId: string | null
    backAssetId: string | null
  }
}

export type VisualAssetGenerationErrorCode =
  | 'AMBIGUOUS_VISUAL_ASSET_TARGET'
  | 'EPISODE_NOT_FOUND'
  | 'INVALID_VISUAL_ASSET_TARGET'
  | 'STORY_GRAPH_INCONSISTENT'
  | 'STORY_REVISION_MISSING'
  | 'VISUAL_ASSET_TARGET_NOT_FOUND'

export class VisualAssetGenerationError extends Error {
  constructor(
    readonly code: VisualAssetGenerationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'VisualAssetGenerationError'
  }
}

type SqlRow = Record<string, unknown>

const TABLES: Record<VisualAssetEntityType, 'characters' | 'locations' | 'props'> = {
  character: 'characters',
  location: 'locations',
  prop: 'props',
}

const DESCRIPTION_COLUMNS: Record<VisualAssetEntityType, string> = {
  character: 'story_description',
  location: 'story_description',
  prop: 'story_description',
}

const PUBLIC_ID = `CASE
  WHEN typeof(json_extract(metadata_json, '$.storyId')) = 'text'
    AND length(trim(json_extract(metadata_json, '$.storyId'))) > 0
  THEN json_extract(metadata_json, '$.storyId')
  ELSE id
END`

function stringValue(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new VisualAssetGenerationError(
      'STORY_GRAPH_INCONSISTENT',
      `视觉资产目标字段 ${key} 无效`,
    )
  }
  return value
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new VisualAssetGenerationError(
      'STORY_GRAPH_INCONSISTENT',
      `视觉资产目标字段 ${key} 无效`,
    )
  }
  return value
}

function numberValue(row: SqlRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new VisualAssetGenerationError(
      'STORY_GRAPH_INCONSISTENT',
      `视觉资产目标字段 ${key} 无效`,
    )
  }
  return value
}

function episodeRevision(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string },
): string {
  const row = database.withSql((sql) => sql.get(`
    SELECT source_revision_id
    FROM episodes
    WHERE id = ? AND project_id = ?
  `, input.episodeId, input.projectId))
  if (!row) {
    throw new VisualAssetGenerationError(
      'EPISODE_NOT_FOUND',
      '分集不存在或不属于指定项目',
    )
  }
  const revisionId = nullableString(row, 'source_revision_id')
  if (!revisionId) {
    throw new VisualAssetGenerationError(
      'STORY_REVISION_MISSING',
      '分集尚未绑定可追溯的剧本修订，不能生成视觉资产',
    )
  }
  return revisionId
}

function latestCandidate(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string
    entityType: VisualAssetEntityType
    entityId: string
    sourceRevisionId: string
  },
): Pick<MediaAssetRecord, 'id' | 'version'> | null {
  const row = database.withSql((sql) => sql.get(`
    SELECT media_assets.id, media_assets.version
    FROM media_assets
    LEFT JOIN generation_jobs ON generation_jobs.id = media_assets.generation_job_id
    WHERE media_assets.project_id = ?
      AND media_assets.episode_id = ?
      AND media_assets.source_revision_id = ?
      AND media_assets.status = 'ready'
      AND media_assets.mime_type LIKE 'image/%'
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
    ORDER BY media_assets.created_at DESC, media_assets.id DESC
    LIMIT 1
  `,
  input.projectId,
  input.episodeId,
  input.sourceRevisionId,
  input.entityType,
  input.entityId,
  input.entityType,
  input.entityId,
  ))
  if (!row) return null
  return { id: stringValue(row, 'id'), version: numberValue(row, 'version') }
}

interface DurableTarget extends VisualAssetEntityTarget {
  databaseId: string
  sourceRevisionId: string
}

/** Resolves only the normalized entity graph owned by the requested project and episode. */
export function resolveVisualAssetEntity(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string
    entityType: VisualAssetEntityType
    entityId: string
  },
): DurableTarget {
  const revisionId = episodeRevision(database, input)
  const table = TABLES[input.entityType]
  const descriptionColumn = DESCRIPTION_COLUMNS[input.entityType]
  const rows = database.withSql((sql) => sql.all(`
    SELECT
      id AS database_id,
      ${PUBLIC_ID} AS public_id,
      name,
      ${descriptionColumn} AS description,
      visual_description,
      CASE WHEN '${input.entityType}' = 'character'
        THEN json_extract(metadata_json, '$.role')
        ELSE NULL
      END AS role,
      version,
      locked_asset_id
    FROM ${table}
    WHERE project_id = ?
      AND episode_id = ?
      AND ${PUBLIC_ID} = ?
    ORDER BY id
    LIMIT 2
  `, input.projectId, input.episodeId, input.entityId))
  if (rows.length === 0) {
    throw new VisualAssetGenerationError(
      'VISUAL_ASSET_TARGET_NOT_FOUND',
      '角色、场景或道具不存在，或不属于指定项目与分集',
    )
  }
  if (rows.length > 1) {
    throw new VisualAssetGenerationError(
      'AMBIGUOUS_VISUAL_ASSET_TARGET',
      '视觉资产目标公开 ID 在分集中不唯一',
    )
  }
  const row = rows[0]
  return {
    databaseId: stringValue(row, 'database_id'),
    sourceRevisionId: revisionId,
    type: input.entityType,
    id: stringValue(row, 'public_id'),
    name: stringValue(row, 'name'),
    description: stringValue(row, 'description'),
    visualDescription: stringValue(row, 'visual_description'),
    role: nullableString(row, 'role'),
    version: numberValue(row, 'version'),
    lockedAssetId: nullableString(row, 'locked_asset_id'),
  }
}

export function createVisualAssetEntityBinding(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string
    entityType: VisualAssetEntityType
    entityId: string
  },
): VisualAssetEntityBinding {
  const target = resolveVisualAssetEntity(database, input)
  const parent = latestCandidate(database, {
    ...input,
    sourceRevisionId: target.sourceRevisionId,
  })
  return {
    episodeId: input.episodeId,
    entityType: target.type,
    entityId: target.id,
    databaseEntityId: target.databaseId,
    expectedRevisionId: target.sourceRevisionId,
    parentAssetId: parent?.id ?? null,
    nextVersion: (parent?.version ?? 0) + 1,
  }
}

function identifier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= 200 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null
}

/**
 * Converts public metadata into a closed entity selector. New clients use
 * entityType/entityId; the three legacy ID keys remain accepted for existing
 * persisted jobs and are normalized into the same server-created binding.
 */
export function visualAssetEntitySelector(metadata: JsonObject | undefined): {
  entityType: VisualAssetEntityType
  entityId: string
} | null {
  if (!metadata) return null
  const explicitType = identifier(metadata.entityType)
  const explicitId = identifier(metadata.entityId)
  const hasExplicitSelector = Object.hasOwn(metadata, 'entityType') || Object.hasOwn(metadata, 'entityId')
  if (hasExplicitSelector) {
    if (!explicitType || !explicitId || !VISUAL_ASSET_ENTITY_TYPES.includes(
      explicitType as VisualAssetEntityType,
    )) {
      throw new VisualAssetGenerationError(
        'INVALID_VISUAL_ASSET_TARGET',
        'metadata.entityType/entityId 必须同时指定有效的 character、location 或 prop 目标',
      )
    }
    return { entityType: explicitType as VisualAssetEntityType, entityId: explicitId }
  }

  const legacy = [
    ['character', metadata.characterId],
    ['location', metadata.locationId],
    ['prop', metadata.propId],
  ] as const
  const hasLegacySelector = legacy.some(([, rawId]) => rawId !== undefined)
  const selected = legacy.flatMap(([entityType, rawId]) => {
    const entityId = identifier(rawId)
    return entityId ? [{ entityType, entityId }] : []
  })
  if (selected.length > 1 || (hasLegacySelector && selected.length === 0)) {
    throw new VisualAssetGenerationError(
      'INVALID_VISUAL_ASSET_TARGET',
      '图片生成请求一次只能绑定一个角色、场景或道具',
    )
  }
  return selected[0] ?? null
}

function validBinding(value: unknown): value is VisualAssetEntityBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<VisualAssetEntityBinding>
  return typeof candidate.episodeId === 'string' && Boolean(candidate.episodeId)
    && VISUAL_ASSET_ENTITY_TYPES.includes(candidate.entityType as VisualAssetEntityType)
    && typeof candidate.entityId === 'string' && Boolean(candidate.entityId)
    && typeof candidate.databaseEntityId === 'string' && Boolean(candidate.databaseEntityId)
    && typeof candidate.expectedRevisionId === 'string' && Boolean(candidate.expectedRevisionId)
    && (candidate.parentAssetId === null || typeof candidate.parentAssetId === 'string')
    && Number.isInteger(candidate.nextVersion) && (candidate.nextVersion ?? 0) > 0
}

export function visualAssetEntityBindingForJob(
  jobType: string,
  input: { metadata?: JsonObject; assetEntityBinding?: VisualAssetEntityBinding },
): VisualAssetEntityBinding | null {
  if (jobType !== 'asset.image.generate') return null
  const selector = visualAssetEntitySelector(input.metadata)
  if (!selector) return null
  if (!validBinding(input.assetEntityBinding)) {
    throw new JobExecutionError(
      'INVALID_VISUAL_ASSET_BINDING',
      '视觉资产任务缺少安全的实体与剧本修订绑定',
      false,
      'validation',
    )
  }
  if (
    input.assetEntityBinding.entityType !== selector.entityType
    || input.assetEntityBinding.entityId !== selector.entityId
  ) {
    throw new JobExecutionError(
      'INVALID_VISUAL_ASSET_BINDING',
      '视觉资产任务的实体元数据与服务端绑定不一致',
      false,
      'validation',
    )
  }
  return input.assetEntityBinding
}

/** Re-resolves the immutable normalized target immediately before a paid call. */
export function resolveDurableVisualAssetEntity(
  database: ManjuDatabase,
  projectId: string,
  binding: VisualAssetEntityBinding,
): DurableTarget {
  let target: DurableTarget
  try {
    target = resolveVisualAssetEntity(database, {
      projectId,
      episodeId: binding.episodeId,
      entityType: binding.entityType,
      entityId: binding.entityId,
    })
  } catch (error) {
    if (error instanceof VisualAssetGenerationError) {
      throw new JobExecutionError(error.code, error.message, false, 'validation')
    }
    throw error
  }
  if (target.databaseId !== binding.databaseEntityId) {
    throw new JobExecutionError(
      'VISUAL_ASSET_TARGET_CHANGED',
      '角色、场景或道具实体已被替换，未发起图片生成计费请求',
      false,
      'validation',
    )
  }
  if (target.sourceRevisionId !== binding.expectedRevisionId) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '源剧本已修改，请基于最新剧本重新生成视觉资产',
      false,
      'validation',
    )
  }
  return target
}

export function listVisualAssetTargets(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string },
): VisualAssetEntityTarget[] {
  episodeRevision(database, input)
  const targets: VisualAssetEntityTarget[] = []
  const characterReferences = new Map<string, {
    frontAssetId: string | null
    sideAssetId: string | null
    backAssetId: string | null
  }>()
  const referenceRows = database.withSql((sql) => sql.all(`
    SELECT character_id, role, asset_id
    FROM character_visual_references
    WHERE project_id = ? AND episode_id = ?
  `, input.projectId, input.episodeId))
  for (const row of referenceRows) {
    const characterId = stringValue(row, 'character_id')
    const references = characterReferences.get(characterId) ?? {
      frontAssetId: null,
      sideAssetId: null,
      backAssetId: null,
    }
    const role = stringValue(row, 'role')
    const assetId = nullableString(row, 'asset_id')
    if (role === 'front') references.frontAssetId = assetId
    else if (role === 'side') references.sideAssetId = assetId
    else if (role === 'back') references.backAssetId = assetId
    characterReferences.set(characterId, references)
  }
  for (const entityType of VISUAL_ASSET_ENTITY_TYPES) {
    const table = TABLES[entityType]
    const descriptionColumn = DESCRIPTION_COLUMNS[entityType]
    const rows = database.withSql((sql) => sql.all(`
      SELECT
        id AS database_id,
        ${PUBLIC_ID} AS public_id,
        name,
        ${descriptionColumn} AS description,
        visual_description,
        CASE WHEN '${entityType}' = 'character'
          THEN json_extract(metadata_json, '$.role')
          ELSE NULL
        END AS role,
        version,
        locked_asset_id
      FROM ${table}
      WHERE project_id = ? AND episode_id = ?
      ORDER BY CAST(json_extract(metadata_json, '$.sequence') AS INTEGER), created_at, id
    `, input.projectId, input.episodeId))
    for (const row of rows) {
      const target: VisualAssetEntityTarget = {
        type: entityType,
        id: stringValue(row, 'public_id'),
        name: stringValue(row, 'name'),
        description: stringValue(row, 'description'),
        visualDescription: stringValue(row, 'visual_description'),
        role: nullableString(row, 'role'),
        version: numberValue(row, 'version'),
        lockedAssetId: nullableString(row, 'locked_asset_id'),
      }
      if (entityType === 'character') {
        target.lockedReferences = characterReferences.get(stringValue(row, 'database_id')) ?? {
          frontAssetId: null,
          sideAssetId: null,
          backAssetId: null,
        }
      }
      targets.push(target)
    }
  }
  return targets
}
