import { isDeepStrictEqual } from 'node:util'

import type { ManjuDatabase, MediaAssetRecord } from './database.js'
import {
  isShotVideoReferenceRecommendation,
  resolveShotVideoManualReferenceOptions,
  resolveShotVideoReferenceRecommendation,
  type ShotVideoReferenceRecommendation,
  type ShotReferenceRecommendationTarget,
} from './shot-video-reference-recommendation.js'
import type { ImageGenerationInput } from './types.js'
import type { VisualAssetEntityBinding } from './visual-asset-generation.js'
import { JobExecutionError } from './worker.js'

export const STORYBOARD_IMAGE_KIND = 'storyboard'
export const STORYBOARD_READY_STATUS = 'storyboard_ready'
export const MAX_STORYBOARD_REFERENCE_ASSETS = 4
export const STORYBOARD_REFERENCE_DECISION_VERSION = 1 as const
export const STORYBOARD_REFERENCE_DECISION_POLICY = 'deterministic-character-view-location-v1' as const

export interface StoryboardShotTarget {
  databaseShotId: string
  databaseSceneId: string
  publicShotId: string
  publicSceneId: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  storyboardAssetId: string | null
  /** Dialogue subjects authored by the current Story graph, never by the client. */
  subjectNames: string[]
  scene: string
  action: string
  framing: string
  movement: string
  prompt: string
}

export interface StoryboardLocationReferencePin {
  databaseLocationId: string
  locationId: string
  locationName: string
  locationVersion: number
  assetId: string
  assetVersion: number
  assetChecksum: string
  assetSourceRevisionId: string
  /** Null only for a legacy location lock created before asset.lock auditing. */
  lockAuditRevisionId: string | null
}

/**
 * Complete server-authored evidence for the references of one paid storyboard
 * request. Character slot provenance lives in `recommendation.characters`;
 * the current-scene location is independently pinned below. The final ordered
 * IDs are persisted as well so a worker can prove that the bytes it is about
 * to load are exactly the admitted decision.
 */
export interface StoryboardReferenceDecision {
  version: typeof STORYBOARD_REFERENCE_DECISION_VERSION
  policy: typeof STORYBOARD_REFERENCE_DECISION_POLICY
  source: 'agentic_auto' | 'explicit_opt_out'
  shotId: string
  sceneId: string
  sourceRevisionId: string
  recommendation: ShotVideoReferenceRecommendation | null
  locationPin: StoryboardLocationReferencePin | null
  referenceAssetIds: string[]
  rationale: string
}

/**
 * Durable, server-created binding stored with the job input. The public IDs
 * remain the API contract; databaseShotId prevents a later graph replacement
 * from silently retargeting an already-submitted paid job.
 */
export interface StoryboardImageBinding {
  episodeId: string
  shotId: string
  sceneId?: string
  databaseShotId: string
  expectedRevisionId: string
}

/** Source provenance fixed when any episode-scoped production image is queued. */
export interface EpisodeImageBinding {
  episodeId: string
  expectedRevisionId: string
  stylePreset: string
  aspectRatio: string
}

export interface StoryboardImageJobInput extends ImageGenerationInput {
  /**
   * Versioned client intent used only to prove an exact Idempotency-Key
   * replay before mutable Story/Provider bindings are resolved again.
   */
  idempotencyRequest?: {
    schemaVersion: 1
    episodeId: string | null
    requestedProviderId: string | null
    input: ImageGenerationInput
  }
  storyboardBinding?: StoryboardImageBinding
  episodeBinding?: EpisodeImageBinding
  /** Server-created immutable binding for character/location/prop candidates. */
  assetEntityBinding?: VisualAssetEntityBinding
  /** Server-resolved immutable asset IDs. Clients cannot provide this field. */
  referenceAssetIds?: string[]
  /** Server-authored reference evidence. Clients cannot provide this field. */
  storyboardReferenceDecision?: StoryboardReferenceDecision
}

export type StoryboardImageErrorCode =
  | 'AMBIGUOUS_STORYBOARD_SHOT_ID'
  | 'STORYBOARD_SHOT_NOT_FOUND'
  | 'EPISODE_NOT_FOUND'
  | 'INVALID_REFERENCE_ASSET'
  | 'STORYBOARD_REFERENCE_MANUAL_REQUIRED'
  | 'STORY_REVISION_MISSING'
  | 'STORY_GRAPH_INCONSISTENT'

export class StoryboardImageError extends Error {
  constructor(readonly code: StoryboardImageErrorCode, message: string) {
    super(message)
    this.name = 'StoryboardImageError'
  }
}

type SqlRow = Record<string, unknown>

function requiredString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value) {
    throw new StoryboardImageError('STORY_GRAPH_INCONSISTENT', `剧本镜头字段 ${key} 无效`)
  }
  return value
}

function stringValue(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new StoryboardImageError('STORY_GRAPH_INCONSISTENT', `制作绑定字段 ${key} 无效`)
  }
  return value
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new StoryboardImageError('STORY_GRAPH_INCONSISTENT', `剧本镜头字段 ${key} 无效`)
  }
  return value
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

const PUBLIC_LOCATION_ID = `CASE
  WHEN typeof(json_extract(locations.metadata_json, '$.storyId')) = 'text'
    AND length(trim(json_extract(locations.metadata_json, '$.storyId'))) > 0
  THEN json_extract(locations.metadata_json, '$.storyId')
  ELSE locations.id
END`

const SUPPORTED_REFERENCE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

const TARGET_SELECT = `
  SELECT
    shots.id AS database_shot_id,
    scenes.id AS database_scene_id,
    ${PUBLIC_SHOT_ID} AS public_shot_id,
    ${PUBLIC_SCENE_ID} AS public_scene_id,
    shots.storyboard_asset_id,
    shots.source_revision_id AS shot_source_revision_id,
    episodes.id AS episode_id,
    episodes.project_id,
    episodes.source_revision_id AS episode_source_revision_id,
    shots.description AS shot_action,
    shots.framing AS shot_framing,
    shots.movement AS shot_movement,
    shots.prompt AS shot_prompt,
    trim(scenes.title || ' ' || scenes.description) AS scene_context,
    COALESCE((
      SELECT json_group_array(subject.name)
      FROM (
        SELECT DISTINCT characters.name AS name
        FROM dialogue_lines
        JOIN characters ON characters.id = dialogue_lines.character_id
        WHERE dialogue_lines.shot_id = shots.id
        ORDER BY characters.name
      ) AS subject
    ), '[]') AS subject_names_json
  FROM shots
  JOIN scenes ON scenes.id = shots.scene_id
  JOIN episodes ON episodes.id = scenes.episode_id
`

function targetFromRow(row: SqlRow): StoryboardShotTarget {
  const episodeRevisionId = nullableString(row, 'episode_source_revision_id')
  if (!episodeRevisionId) {
    throw new StoryboardImageError(
      'STORY_REVISION_MISSING',
      '分集尚未绑定可追溯的剧本修订，不能安全生成分镜',
    )
  }
  if (nullableString(row, 'shot_source_revision_id') !== episodeRevisionId) {
    throw new StoryboardImageError(
      'STORY_GRAPH_INCONSISTENT',
      '镜头与分集的剧本修订不一致，不能安全生成分镜',
    )
  }
  let subjectNames: unknown
  try {
    subjectNames = JSON.parse(requiredString(row, 'subject_names_json'))
  } catch {
    throw new StoryboardImageError('STORY_GRAPH_INCONSISTENT', '镜头对话角色索引无效')
  }
  if (!Array.isArray(subjectNames)
    || subjectNames.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new StoryboardImageError('STORY_GRAPH_INCONSISTENT', '镜头对话角色索引无效')
  }
  return {
    databaseShotId: requiredString(row, 'database_shot_id'),
    databaseSceneId: requiredString(row, 'database_scene_id'),
    publicShotId: requiredString(row, 'public_shot_id'),
    publicSceneId: requiredString(row, 'public_scene_id'),
    projectId: requiredString(row, 'project_id'),
    episodeId: requiredString(row, 'episode_id'),
    sourceRevisionId: episodeRevisionId,
    storyboardAssetId: nullableString(row, 'storyboard_asset_id'),
    subjectNames: [...new Set(subjectNames.map((name) => name.trim()))],
    scene: stringValue(row, 'scene_context'),
    action: stringValue(row, 'shot_action'),
    framing: stringValue(row, 'shot_framing'),
    movement: stringValue(row, 'shot_movement'),
    prompt: stringValue(row, 'shot_prompt'),
  }
}

/** Resolve an external StoryDocument shot ID only within its owner scope. */
export function resolvePublicStoryboardShot(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string; shotId: string; sceneId?: string },
): StoryboardShotTarget {
  const sceneId = input.sceneId ?? null
  const rows = database.withSql((sql) => sql.all(`
    ${TARGET_SELECT}
    WHERE episodes.project_id = ?
      AND episodes.id = ?
      AND ${PUBLIC_SHOT_ID} = ?
      AND (? IS NULL OR ${PUBLIC_SCENE_ID} = ?)
    ORDER BY scenes.id, shots.id
    LIMIT 2
  `, input.projectId, input.episodeId, input.shotId, sceneId, sceneId))
  if (rows.length === 0) {
    throw new StoryboardImageError(
      'STORYBOARD_SHOT_NOT_FOUND',
      '镜头不存在，或不属于指定项目、分集与场景',
    )
  }
  if (rows.length > 1) {
    throw new StoryboardImageError(
      'AMBIGUOUS_STORYBOARD_SHOT_ID',
      '该镜头 ID 在分集中不唯一，请提供 sceneId',
    )
  }
  return targetFromRow(rows[0])
}

export function createStoryboardImageBinding(target: StoryboardShotTarget): StoryboardImageBinding {
  return {
    episodeId: target.episodeId,
    shotId: target.publicShotId,
    sceneId: target.publicSceneId,
    databaseShotId: target.databaseShotId,
    expectedRevisionId: target.sourceRevisionId,
  }
}

export function resolveEpisodeImageBinding(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string },
): EpisodeImageBinding {
  const row = database.withSql((sql) => sql.get(`
    SELECT source_revision_id, style_preset, aspect_ratio
    FROM episodes
    WHERE id = ? AND project_id = ?
  `, input.episodeId, input.projectId))
  if (!row) {
    throw new StoryboardImageError('EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
  }
  const sourceRevisionId = nullableString(row, 'source_revision_id')
  if (!sourceRevisionId) {
    throw new StoryboardImageError(
      'STORY_REVISION_MISSING',
      '分集尚未绑定可追溯的剧本修订，不能安全生成制作资产',
    )
  }
  return {
    episodeId: input.episodeId,
    expectedRevisionId: sourceRevisionId,
    stylePreset: stringValue(row, 'style_preset'),
    aspectRatio: requiredString(row, 'aspect_ratio'),
  }
}

function assertReferenceAsset(
  database: ManjuDatabase,
  assetId: string,
  input: { projectId: string; episodeId: string; sourceRevisionId: string },
): MediaAssetRecord {
  const asset = database.getMediaAsset(assetId)
  // Ownership failures intentionally look identical to missing assets so a
  // corrupted/cross-project lock cannot become an asset enumeration oracle.
  if (!asset || asset.projectId !== input.projectId || asset.episodeId !== input.episodeId) {
    throw new StoryboardImageError(
      'INVALID_REFERENCE_ASSET',
      '锁定参考图不存在或不属于当前项目与分集',
    )
  }
  const mimeType = asset.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (asset.status !== 'ready' || !SUPPORTED_REFERENCE_MIME_TYPES.has(mimeType)) {
    throw new StoryboardImageError(
      'INVALID_REFERENCE_ASSET',
      '锁定参考资产必须是 ready 状态的受支持图片',
    )
  }
  if (asset.sourceRevisionId !== input.sourceRevisionId) {
    throw new StoryboardImageError(
      'INVALID_REFERENCE_ASSET',
      '锁定参考图不属于当前剧本修订，请重新生成并锁定',
    )
  }
  return asset
}

function resolveCurrentSceneLocationPin(
  database: ManjuDatabase,
  target: StoryboardShotTarget,
): StoryboardLocationReferencePin | null {
  const locationRow = database.withSql((sql) => sql.get(`
    SELECT
      locations.id AS database_location_id,
      ${PUBLIC_LOCATION_ID} AS public_location_id,
      locations.name AS location_name,
      locations.version AS location_version,
      locations.locked_asset_id,
      (
        SELECT revisions.id
        FROM revisions
        WHERE revisions.project_id = episodes.project_id
          AND json_extract(revisions.snapshot_json, '$.kind') = 'asset.lock'
          AND json_extract(revisions.snapshot_json, '$.episodeId') = episodes.id
          AND json_extract(revisions.snapshot_json, '$.target.type') = 'location'
          AND json_extract(revisions.snapshot_json, '$.target.id') = ${PUBLIC_LOCATION_ID}
          AND json_extract(revisions.snapshot_json, '$.target.lockedAssetId') = locations.locked_asset_id
        ORDER BY revisions.created_at DESC, revisions.id DESC
        LIMIT 1
      ) AS lock_audit_revision_id
    FROM scenes
    JOIN episodes ON episodes.id = scenes.episode_id
    JOIN locations
      ON locations.project_id = episodes.project_id
      AND locations.episode_id = episodes.id
      AND ${PUBLIC_LOCATION_ID} = json_extract(scenes.metadata_json, '$.locationId')
    WHERE scenes.id = ?
      AND episodes.id = ?
      AND episodes.project_id = ?
    LIMIT 1
  `, target.databaseSceneId, target.episodeId, target.projectId))
  if (!locationRow) return null
  const locationAssetId = nullableString(locationRow, 'locked_asset_id')
  if (!locationAssetId) return null
  const asset = assertReferenceAsset(database, locationAssetId, {
    projectId: target.projectId,
    episodeId: target.episodeId,
    sourceRevisionId: target.sourceRevisionId,
  })
  if (asset.version < 1 || !asset.checksum || !/^[a-f0-9]{64}$/.test(asset.checksum)) {
    throw new StoryboardImageError(
      'INVALID_REFERENCE_ASSET',
      '当前场景锁定图缺少可验证的版本或校验和',
    )
  }
  const locationVersion = locationRow.location_version
  if (typeof locationVersion !== 'number' || !Number.isInteger(locationVersion) || locationVersion < 1) {
    throw new StoryboardImageError('STORY_GRAPH_INCONSISTENT', '当前场景锁定版本无效')
  }
  return {
    databaseLocationId: requiredString(locationRow, 'database_location_id'),
    locationId: requiredString(locationRow, 'public_location_id'),
    locationName: requiredString(locationRow, 'location_name'),
    locationVersion,
    assetId: asset.id,
    assetVersion: asset.version,
    assetChecksum: asset.checksum,
    assetSourceRevisionId: target.sourceRevisionId,
    lockAuditRevisionId: nullableString(locationRow, 'lock_audit_revision_id'),
  }
}

function automaticStoryboardReferenceDecision(
  database: ManjuDatabase,
  target: StoryboardShotTarget,
): StoryboardReferenceDecision {
  const recommendationTarget: ShotReferenceRecommendationTarget = {
    publicShotId: target.publicShotId,
    publicSceneId: target.publicSceneId,
    projectId: target.projectId,
    episodeId: target.episodeId,
    sourceRevisionId: target.sourceRevisionId,
    subjectNames: target.subjectNames,
    scene: target.scene,
    action: target.action,
    shotSize: target.framing,
    cameraMovement: target.movement,
    prompt: target.prompt,
  }
  let recommendation = resolveShotVideoReferenceRecommendation(database, recommendationTarget)
  if (recommendation.status === 'manual_required'
    && recommendation.characters.length > 0
    && recommendation.characters.every((character) => character.view === null)) {
    const options = resolveShotVideoManualReferenceOptions(database, recommendationTarget, recommendation)
    const frontPins = options.characters.map((character) => (
      character.slots.find((slot) => slot.view === 'front') ?? null
    ))
    if (frontPins.every((pin) => pin !== null)) {
      recommendation = {
        ...recommendation,
        status: 'recommended',
        confidence: 0.5,
        rationale: '镜头目标朝向未明确；分镜图仅使用当前锁定的正面槽位作为角色身份锚点，目标画面朝向仍由镜头 Prompt 决定。',
        characters: frontPins.map((pin) => ({
          characterId: pin.characterId,
          characterName: pin.characterName,
          status: 'recommended',
          view: 'front',
          confidence: 0.5,
          rationale: '正面槽位仅作为分镜图身份锚点，不表示目标镜头为正面；最终朝向由镜头 Prompt 决定。',
          assetId: pin.assetId,
          assetVersion: pin.assetVersion,
          assetChecksum: pin.assetChecksum,
          assetSourceRevisionId: pin.assetSourceRevisionId,
          slotVersion: pin.slotVersion,
          slotAuditRevisionId: pin.slotAuditRevisionId,
        })),
        references: frontPins.map((pin) => ({
          assetId: pin.assetId,
          role: 'reference_image' as const,
        })),
      }
    }
  }
  if (recommendation.status === 'manual_required') {
    const details = recommendation.characters.map((character) => {
      if (character.view === null) return `${character.characterName}：镜头文本未明确正/侧/背`
      const label = { front: '正面', side: '侧面', back: '背面' }[character.view]
      return `${character.characterName}：已判断为${label}，但当前${label}槽位不可用`
    }).join('；')
    throw new StoryboardImageError(
      'STORYBOARD_REFERENCE_MANUAL_REQUIRED',
      `${details || recommendation.rationale}。分镜图已尝试使用当前正面槽位作为身份锚点，但至少一个角色缺少可验证的当前槽位；请修复角色资产，或显式关闭“使用锁定参考图”后生成纯文本分镜。`,
    )
  }
  const locationPin = resolveCurrentSceneLocationPin(database, target)
  const referenceAssetIds = recommendation.references.map((reference) => reference.assetId)
  if (locationPin && !referenceAssetIds.includes(locationPin.assetId)) {
    referenceAssetIds.push(locationPin.assetId)
  }
  if (referenceAssetIds.length > MAX_STORYBOARD_REFERENCE_ASSETS) {
    throw new StoryboardImageError(
      'STORYBOARD_REFERENCE_MANUAL_REQUIRED',
      `镜头需要 ${referenceAssetIds.length} 张角色/场景参考图，超过分镜生成上限 ${MAX_STORYBOARD_REFERENCE_ASSETS}，请人工精简镜头主体。`,
    )
  }
  return {
    version: STORYBOARD_REFERENCE_DECISION_VERSION,
    policy: STORYBOARD_REFERENCE_DECISION_POLICY,
    source: 'agentic_auto',
    shotId: target.publicShotId,
    sceneId: target.publicSceneId,
    sourceRevisionId: target.sourceRevisionId,
    recommendation,
    locationPin,
    referenceAssetIds,
    rationale: referenceAssetIds.length > 0
      ? `${recommendation.rationale}${locationPin ? ' 同时保留当前场景锁定图。' : ''}`
      : '镜头没有可安全自动绑定的角色或场景参考图。',
  }
}

export function createStoryboardReferenceDecision(
  database: ManjuDatabase,
  target: StoryboardShotTarget,
  options: { useLockedReferences: boolean },
): StoryboardReferenceDecision {
  if (options.useLockedReferences) return automaticStoryboardReferenceDecision(database, target)
  return {
    version: STORYBOARD_REFERENCE_DECISION_VERSION,
    policy: STORYBOARD_REFERENCE_DECISION_POLICY,
    source: 'explicit_opt_out',
    shotId: target.publicShotId,
    sceneId: target.publicSceneId,
    sourceRevisionId: target.sourceRevisionId,
    recommendation: null,
    locationPin: null,
    referenceAssetIds: [],
    rationale: '用户明确关闭锁定参考图；本任务以纯文本生成。',
  }
}

/** @deprecated Prefer the durable decision, not a bare list of IDs. */
export function resolveLockedStoryboardReferenceAssetIds(
  database: ManjuDatabase,
  target: StoryboardShotTarget,
): string[] {
  return createStoryboardReferenceDecision(database, target, {
    useLockedReferences: true,
  }).referenceAssetIds
}

function validEpisodeBinding(value: unknown): value is EpisodeImageBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const binding = value as Partial<EpisodeImageBinding>
  return typeof binding.episodeId === 'string' && Boolean(binding.episodeId)
    && typeof binding.expectedRevisionId === 'string' && Boolean(binding.expectedRevisionId)
    && typeof binding.stylePreset === 'string'
    && typeof binding.aspectRatio === 'string' && Boolean(binding.aspectRatio)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key))
}

function isLocationPin(value: unknown): value is StoryboardLocationReferencePin {
  if (!isRecord(value) || !hasExactKeys(value, [
    'databaseLocationId',
    'locationId',
    'locationName',
    'locationVersion',
    'assetId',
    'assetVersion',
    'assetChecksum',
    'assetSourceRevisionId',
    'lockAuditRevisionId',
  ])) return false
  return typeof value.databaseLocationId === 'string' && Boolean(value.databaseLocationId)
    && typeof value.locationId === 'string' && Boolean(value.locationId)
    && typeof value.locationName === 'string' && Boolean(value.locationName)
    && Number.isInteger(value.locationVersion) && (value.locationVersion as number) >= 1
    && typeof value.assetId === 'string' && Boolean(value.assetId)
    && Number.isInteger(value.assetVersion) && (value.assetVersion as number) >= 1
    && typeof value.assetChecksum === 'string' && /^[a-f0-9]{64}$/.test(value.assetChecksum)
    && typeof value.assetSourceRevisionId === 'string' && Boolean(value.assetSourceRevisionId)
    && (value.lockAuditRevisionId === null
      || (typeof value.lockAuditRevisionId === 'string' && Boolean(value.lockAuditRevisionId)))
}

export function isStoryboardReferenceDecision(value: unknown): value is StoryboardReferenceDecision {
  if (!isRecord(value) || !hasExactKeys(value, [
    'version',
    'policy',
    'source',
    'shotId',
    'sceneId',
    'sourceRevisionId',
    'recommendation',
    'locationPin',
    'referenceAssetIds',
    'rationale',
  ])) return false
  if (value.version !== STORYBOARD_REFERENCE_DECISION_VERSION
    || value.policy !== STORYBOARD_REFERENCE_DECISION_POLICY
    || (value.source !== 'agentic_auto' && value.source !== 'explicit_opt_out')
    || typeof value.shotId !== 'string' || !value.shotId
    || typeof value.sceneId !== 'string' || !value.sceneId
    || typeof value.sourceRevisionId !== 'string' || !value.sourceRevisionId
    || typeof value.rationale !== 'string' || !value.rationale
    || !Array.isArray(value.referenceAssetIds)
    || value.referenceAssetIds.length > MAX_STORYBOARD_REFERENCE_ASSETS
    || value.referenceAssetIds.some((id) => typeof id !== 'string' || !id)
    || new Set(value.referenceAssetIds).size !== value.referenceAssetIds.length
    || (value.locationPin !== null && !isLocationPin(value.locationPin))) return false
  if (value.source === 'explicit_opt_out') {
    return value.recommendation === null
      && value.locationPin === null
      && value.referenceAssetIds.length === 0
  }
  if (!isShotVideoReferenceRecommendation(value.recommendation)
    || value.recommendation.status === 'manual_required'
    || value.recommendation.shotId !== value.shotId
    || value.recommendation.sceneId !== value.sceneId
    || value.recommendation.sourceRevisionId !== value.sourceRevisionId) return false
  const expectedIds = value.recommendation.references.map((reference) => reference.assetId)
  if (value.locationPin && !expectedIds.includes(value.locationPin.assetId)) {
    expectedIds.push(value.locationPin.assetId)
  }
  return isDeepStrictEqual(value.referenceAssetIds, expectedIds)
    && (!value.locationPin || value.locationPin.assetSourceRevisionId === value.sourceRevisionId)
}

/**
 * Paid-call gate: parse the durable JSON, bind it to the current Shot, then
 * author the decision again from current relational state. Any slot, audit,
 * checksum, location lock, Story field, or ordered-ID drift fails closed.
 */
export function assertCurrentStoryboardReferenceDecision(
  database: ManjuDatabase,
  input: {
    target: StoryboardShotTarget
    decision: unknown
    referenceAssetIds: readonly string[]
  },
): StoryboardReferenceDecision {
  if (!isStoryboardReferenceDecision(input.decision)) {
    throw new JobExecutionError(
      'INVALID_STORYBOARD_REFERENCE_DECISION',
      '分镜图片任务缺少完整的服务端参考图决策',
      false,
      'validation',
    )
  }
  const decision = input.decision
  if (decision.shotId !== input.target.publicShotId
    || decision.sceneId !== input.target.publicSceneId
    || decision.sourceRevisionId !== input.target.sourceRevisionId
    || !isDeepStrictEqual(decision.referenceAssetIds, [...input.referenceAssetIds])) {
    throw new JobExecutionError(
      'INVALID_STORYBOARD_REFERENCE_DECISION',
      '分镜参考图决策与持久任务绑定不一致',
      false,
      'validation',
    )
  }
  let current: StoryboardReferenceDecision
  try {
    current = createStoryboardReferenceDecision(database, input.target, {
      useLockedReferences: decision.source === 'agentic_auto',
    })
  } catch (error) {
    if (error instanceof StoryboardImageError) {
      throw new JobExecutionError(
        'STALE_STORYBOARD_REFERENCE_DECISION',
        '镜头视角、角色三视图或当前场景锁定已改变，未发起图片生成计费请求',
        false,
        'validation',
        { cause: error },
      )
    }
    throw error
  }
  if (!isDeepStrictEqual(current, decision)) {
    throw new JobExecutionError(
      'STALE_STORYBOARD_REFERENCE_DECISION',
      '角色视角槽位或当前场景参考图在排队期间已改变，未发起图片生成计费请求',
      false,
      'validation',
    )
  }
  return decision
}

export function resolveDurableEpisodeImageBinding(
  database: ManjuDatabase,
  projectId: string,
  binding: EpisodeImageBinding | undefined,
): EpisodeImageBinding | null {
  if (!binding) return null
  if (!validEpisodeBinding(binding)) {
    throw new JobExecutionError(
      'INVALID_EPISODE_BINDING',
      '图片任务缺少安全的分集与剧本修订绑定',
      false,
      'validation',
    )
  }
  let current: EpisodeImageBinding
  try {
    current = resolveEpisodeImageBinding(database, { projectId, episodeId: binding.episodeId })
  } catch (error) {
    if (error instanceof StoryboardImageError) throw executionError(error)
    throw error
  }
  if (current.expectedRevisionId !== binding.expectedRevisionId) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '源剧本已修改，请基于最新分集重新生成图片',
      false,
      'validation',
    )
  }
  if (
    current.stylePreset !== binding.stylePreset
    || current.aspectRatio !== binding.aspectRatio
  ) {
    throw new JobExecutionError(
      'STALE_RENDER_SETTINGS',
      '画面风格或画幅已修改，请基于最新分集重新生成图片',
      false,
      'validation',
    )
  }
  return binding
}

/**
 * Final publication guard. MediaStore invokes this inside the same SQLite
 * transaction that creates the immutable asset row, so a direct SQL
 * cancellation or render-settings change cannot race a Provider response.
 */
export function assertEpisodeImagePublication(
  database: ManjuDatabase,
  input: {
    projectId: string
    jobId: string
    binding: EpisodeImageBinding
  },
): void {
  const row = database.withSql((sql) => sql.get(`
    SELECT
      generation_jobs.status AS job_status,
      generation_jobs.project_id AS job_project_id,
      generation_jobs.episode_id AS job_episode_id,
      episodes.source_revision_id,
      episodes.style_preset,
      episodes.aspect_ratio
    FROM generation_jobs
    JOIN episodes ON episodes.id = ?
    WHERE generation_jobs.id = ?
      AND episodes.project_id = ?
  `, input.binding.episodeId, input.jobId, input.projectId))
  if (!row
    || row.job_project_id !== input.projectId
    || row.job_episode_id !== input.binding.episodeId) {
    throw new JobExecutionError(
      'INVALID_EPISODE_BINDING',
      '图片任务与分集绑定不一致；生成资产已回滚',
      false,
      'validation',
    )
  }
  if (row.job_status !== 'running' && row.job_status !== 'waiting_provider') {
    throw new JobExecutionError(
      'JOB_NOT_ACTIVE',
      '图片任务已取消或结束；生成资产已回滚',
      false,
      'cancelled',
    )
  }
  if (row.source_revision_id !== input.binding.expectedRevisionId) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '源剧本在图片生成期间已修改；生成资产已回滚',
      false,
      'validation',
    )
  }
  if (
    row.style_preset !== input.binding.stylePreset
    || row.aspect_ratio !== input.binding.aspectRatio
  ) {
    throw new JobExecutionError(
      'STALE_RENDER_SETTINGS',
      '画面风格或画幅在图片生成期间已修改；生成资产已回滚',
      false,
      'validation',
    )
  }
}

export function validateDurableReferenceAssetIds(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeBinding: EpisodeImageBinding | null
    referenceAssetIds: unknown
  },
): string[] {
  if (input.referenceAssetIds === undefined) return []
  if (!Array.isArray(input.referenceAssetIds)
    || input.referenceAssetIds.length > MAX_STORYBOARD_REFERENCE_ASSETS
    || input.referenceAssetIds.some((id) => typeof id !== 'string' || !id)) {
    throw new JobExecutionError(
      'INVALID_REFERENCE_ASSET',
      '图片任务的参考资产绑定无效',
      false,
      'validation',
    )
  }
  const ids = [...new Set(input.referenceAssetIds)] as string[]
  if (ids.length !== input.referenceAssetIds.length || (ids.length > 0 && !input.episodeBinding)) {
    throw new JobExecutionError(
      'INVALID_REFERENCE_ASSET',
      '图片任务的参考资产绑定无效',
      false,
      'validation',
    )
  }
  if (!input.episodeBinding) return ids
  try {
    for (const id of ids) {
      assertReferenceAsset(database, id, {
        projectId: input.projectId,
        episodeId: input.episodeBinding.episodeId,
        sourceRevisionId: input.episodeBinding.expectedRevisionId,
      })
    }
  } catch (error) {
    if (error instanceof StoryboardImageError) throw executionError(error)
    throw error
  }
  return ids
}

function validBinding(value: unknown): value is StoryboardImageBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const binding = value as Partial<StoryboardImageBinding>
  return typeof binding.episodeId === 'string' && Boolean(binding.episodeId)
    && typeof binding.shotId === 'string' && Boolean(binding.shotId)
    && (binding.sceneId === undefined || (typeof binding.sceneId === 'string' && Boolean(binding.sceneId)))
    && typeof binding.databaseShotId === 'string' && Boolean(binding.databaseShotId)
    && typeof binding.expectedRevisionId === 'string' && Boolean(binding.expectedRevisionId)
}

/**
 * Non-storyboard and legacy image jobs deliberately return null so their
 * existing behavior is unchanged. A v1 storyboard job, however, must contain
 * the validated server binding and must be single-output for atomic linking.
 */
export function storyboardBindingForJob(
  jobType: string,
  input: StoryboardImageJobInput,
): StoryboardImageBinding | null {
  if (jobType !== 'asset.image.generate' || input.metadata?.kind !== STORYBOARD_IMAGE_KIND) return null
  if (input.count !== 1) {
    throw new JobExecutionError(
      'INVALID_STORYBOARD_COUNT',
      '分镜图片任务一次只能生成一张图片',
      false,
      'validation',
    )
  }
  if (!validBinding(input.storyboardBinding)) {
    throw new JobExecutionError(
      'INVALID_STORYBOARD_BINDING',
      '分镜图片任务缺少安全的镜头与剧本修订绑定',
      false,
      'validation',
    )
  }
  return input.storyboardBinding
}

function executionError(error: StoryboardImageError): JobExecutionError {
  const code = error.code === 'STORY_REVISION_MISSING' || error.code === 'STORY_GRAPH_INCONSISTENT'
    ? 'STALE_SOURCE'
    : error.code
  return new JobExecutionError(code, error.message, false, 'validation', { cause: error })
}

/** Re-resolve the public target immediately before the paid Provider call. */
export function resolveDurableStoryboardShot(
  database: ManjuDatabase,
  projectId: string,
  binding: StoryboardImageBinding,
): StoryboardShotTarget {
  let target: StoryboardShotTarget
  try {
    target = resolvePublicStoryboardShot(database, {
      projectId,
      episodeId: binding.episodeId,
      shotId: binding.shotId,
      ...(binding.sceneId ? { sceneId: binding.sceneId } : {}),
    })
  } catch (error) {
    if (error instanceof StoryboardImageError) throw executionError(error)
    throw error
  }
  if (target.databaseShotId !== binding.databaseShotId) {
    throw new JobExecutionError(
      'STORYBOARD_TARGET_CHANGED',
      '镜头实体已被替换，未发起图片生成计费请求',
      false,
      'validation',
    )
  }
  if (target.sourceRevisionId !== binding.expectedRevisionId) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '源剧本已修改，请基于最新镜头重新生成图片',
      false,
      'validation',
    )
  }
  return target
}

/**
 * Link the new immutable asset with an optimistic relational update. This is
 * called from MediaStore.save(afterCreate), so throwing rolls back both the
 * media_assets row and this update; MediaStore then removes the published file.
 */
export function linkStoryboardAsset(
  database: ManjuDatabase,
  asset: MediaAssetRecord,
  input: {
    binding: StoryboardImageBinding
    expectedPreviousAssetId: string | null
    signal?: AbortSignal
  },
): void {
  input.signal?.throwIfAborted()
  const sceneId = input.binding.sceneId ?? null
  const changed = database.withSql((sql) => sql.run(`
    UPDATE shots
    SET storyboard_asset_id = ?, status = ?, updated_at = ?
    WHERE shots.id = ?
      AND shots.source_revision_id = ?
      AND shots.storyboard_asset_id IS ?
      AND ${PUBLIC_SHOT_ID} = ?
      AND EXISTS (
        SELECT 1
        FROM scenes
        JOIN episodes ON episodes.id = scenes.episode_id
        WHERE scenes.id = shots.scene_id
          AND episodes.project_id = ?
          AND episodes.id = ?
          AND episodes.source_revision_id = ?
          AND (? IS NULL OR ${PUBLIC_SCENE_ID} = ?)
      )
  `,
  asset.id,
  STORYBOARD_READY_STATUS,
  new Date().toISOString(),
  input.binding.databaseShotId,
  input.binding.expectedRevisionId,
  input.expectedPreviousAssetId,
  input.binding.shotId,
  asset.projectId,
  input.binding.episodeId,
  input.binding.expectedRevisionId,
  sceneId,
  sceneId,
  )).changes
  if (changed === 1) return

  const currentRevisionId = database.withSql((sql) => sql.get(
    'SELECT source_revision_id FROM episodes WHERE id = ? AND project_id = ?',
    input.binding.episodeId,
    asset.projectId,
  ))?.source_revision_id
  if (currentRevisionId !== input.binding.expectedRevisionId) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '源剧本在图片生成期间已修改；新资产已回滚，原分镜链接保持不变',
      false,
      'validation',
    )
  }
  throw new JobExecutionError(
    'STORYBOARD_LINK_CONFLICT',
    '镜头或其分镜链接在图片生成期间已改变；新资产已回滚',
    false,
    'validation',
  )
}
