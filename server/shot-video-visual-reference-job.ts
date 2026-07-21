import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { ManjuDatabase } from './database.js'
import { MediaStore, MediaStoreError } from './media.js'
import { ProviderConfigurationError, ProviderService } from './providers/service.js'
import { OpenAICompatibleTextProvider, TextProviderError } from './providers/text.js'
import { shotVideoReferenceAssetEligibility } from './shot-video-reference-asset.js'
import { resolvePublicShotVideoTarget } from './shot-video-generation.js'
import {
  analyzeShotVideoVisualReferences,
  isShotVideoVisualReferenceAnalysis,
  SHOT_VIDEO_VISUAL_REFERENCE_MAX_IMAGES,
  ShotVideoVisualReferenceAnalysisError,
  shotVideoVisualReferenceInputFingerprint,
  type ShotVideoVisualReferenceAnalysis,
  type ShotVideoVisualReferenceAnalysisInput,
  type ShotVideoVisualReferenceBoundCandidate,
  type ShotVideoVisualReferenceCandidate,
  type ShotVideoVisualCandidateKind,
  type ShotVideoVisualReferenceShot,
} from './shot-video-visual-reference-analysis.js'
import type { PersistedVisionSelectedReferenceAssessment } from './shot-video-reference-plan.js'
import type { JsonObject } from './types.js'
import { JobExecutionError, type JobHandler } from './worker.js'

export const SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE = 'shot.video.reference.analyze'
export const SHOT_VIDEO_VISUAL_REFERENCE_JOB_VERSION = 1 as const

// Base64 expands by roughly 4/3. Keep the encoded data URL below the
// provider's 4 MiB input guard instead of relying on a nominal "3 MiB" raw
// limit that can cross it after padding and the MIME prefix are added.
const MAX_VISION_SOURCE_BYTES = 3_000_000
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

export interface ShotVideoVisualReferenceSelector {
  shotId: string
  sceneId?: string
}

export const SHOT_VIDEO_VISUAL_REFERENCE_BATCH_VERSION = 1 as const

/**
 * Immutable admission metadata shared by every independently runnable child
 * in one user-requested batch. The batch itself is derived from these durable
 * rows, so no in-memory coordinator is required after a process restart.
 */
export interface ShotVideoVisualReferenceBatchBinding {
  version: typeof SHOT_VIDEO_VISUAL_REFERENCE_BATCH_VERSION
  batchId: string
  requestFingerprint: string
  selectionIndex: number
  selectionCount: number
}

export interface ShotVideoVisualReferenceJobInput {
  version: typeof SHOT_VIDEO_VISUAL_REFERENCE_JOB_VERSION
  episodeId: string
  expectedStoryRevisionId: string
  inputFingerprint: string
  selectors: ShotVideoVisualReferenceSelector[]
  shots: ShotVideoVisualReferenceShot[]
  candidates: ShotVideoVisualReferenceBoundCandidate[]
  batch?: ShotVideoVisualReferenceBatchBinding
}

export interface ShotVideoVisualReferenceJobOutput {
  analysis: ShotVideoVisualReferenceAnalysis
}

export class ShotVideoVisualReferenceJobError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'SHOT_NOT_FOUND'
      | 'STORYBOARD_REQUIRED'
      | 'REFERENCE_SCOPE_TOO_LARGE'
      | 'REFERENCE_ASSET_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'ShotVideoVisualReferenceJobError'
  }
}

export class ShotVideoVisualReferenceResolutionError extends Error {
  constructor(
    readonly code:
      | 'VIDEO_REFERENCE_ANALYSIS_NOT_FOUND'
      | 'VIDEO_REFERENCE_ANALYSIS_NOT_READY'
      | 'VIDEO_REFERENCE_ANALYSIS_STALE'
      | 'VIDEO_REFERENCE_ANALYSIS_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'ShotVideoVisualReferenceResolutionError'
  }
}

interface VisualEntity {
  type: 'character' | 'location' | 'prop'
  id: string
  name: string
  lockedAssetId: string | null
}

interface CharacterSlot {
  characterId: string
  characterName: string
  view: 'front' | 'side' | 'back'
  assetId: string
}

interface RawCandidate {
  assetId: string
  kind: ShotVideoVisualCandidateKind
  entityId: string
  entityName: string
  selectable: boolean
  sortKey: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 256
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function publicId(row: Record<string, unknown>): string {
  return typeof row.public_id === 'string' && row.public_id.trim()
    ? row.public_id.trim()
    : String(row.id ?? '')
}

function normalized(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').toLocaleLowerCase()
}

function mentions(text: string, entity: Pick<VisualEntity, 'id' | 'name'>): boolean {
  return Boolean((entity.name && text.includes(normalized(entity.name)))
    || (entity.id && text.includes(normalized(entity.id))))
}

function visualEntities(database: ManjuDatabase, projectId: string, episodeId: string): VisualEntity[] {
  const read = (type: VisualEntity['type'], table: 'characters' | 'locations' | 'props'): VisualEntity[] => (
    database.withSql((sql) => sql.all(`
      SELECT id,
        CASE
          WHEN typeof(json_extract(metadata_json, '$.storyId')) = 'text'
            AND length(trim(json_extract(metadata_json, '$.storyId'))) > 0
          THEN json_extract(metadata_json, '$.storyId')
          ELSE id
        END AS public_id,
        name,
        locked_asset_id
      FROM ${table}
      WHERE project_id = ? AND episode_id = ?
      ORDER BY id
    `, projectId, episodeId)).flatMap((row) => {
      const id = publicId(row)
      const name = typeof row.name === 'string' ? row.name.trim() : ''
      const lockedAssetId = typeof row.locked_asset_id === 'string' ? row.locked_asset_id : null
      return id && name ? [{ type, id, name, lockedAssetId }] : []
    })
  )
  return [
    ...read('character', 'characters'),
    ...read('location', 'locations'),
    ...read('prop', 'props'),
  ]
}

function characterSlots(
  database: ManjuDatabase,
  projectId: string,
  episodeId: string,
): CharacterSlot[] {
  return database.withSql((sql) => sql.all(`
    SELECT
      CASE
        WHEN typeof(json_extract(characters.metadata_json, '$.storyId')) = 'text'
          AND length(trim(json_extract(characters.metadata_json, '$.storyId'))) > 0
        THEN json_extract(characters.metadata_json, '$.storyId')
        ELSE characters.id
      END AS public_id,
      characters.name,
      character_visual_references.role,
      character_visual_references.asset_id
    FROM character_visual_references
    JOIN characters ON characters.id = character_visual_references.character_id
    WHERE character_visual_references.project_id = ?
      AND character_visual_references.episode_id = ?
    ORDER BY characters.id,
      CASE character_visual_references.role
        WHEN 'front' THEN 1 WHEN 'side' THEN 2 WHEN 'back' THEN 3 ELSE 4 END
  `, projectId, episodeId)).flatMap((row) => {
    const characterId = publicId(row)
    const characterName = typeof row.name === 'string' ? row.name.trim() : ''
    const view = row.role
    const assetId = typeof row.asset_id === 'string' ? row.asset_id : ''
    return characterId && characterName && assetId && (view === 'front' || view === 'side' || view === 'back')
      ? [{ characterId, characterName, view, assetId }]
      : []
  })
}

function shotMetadata(database: ManjuDatabase, databaseShotId: string): {
  code: string
  title: string
  locationId: string | null
} {
  const row = database.withSql((sql) => sql.get(`
    SELECT shots.code, shots.title,
      json_extract(scenes.metadata_json, '$.locationId') AS location_id
    FROM shots JOIN scenes ON scenes.id = shots.scene_id
    WHERE shots.id = ?
  `, databaseShotId))
  if (!row || typeof row.code !== 'string' || typeof row.title !== 'string') {
    throw new ShotVideoVisualReferenceJobError('SHOT_NOT_FOUND', '镜头结构数据不完整')
  }
  return {
    code: row.code,
    title: row.title,
    locationId: typeof row.location_id === 'string' && row.location_id.trim()
      ? row.location_id.trim()
      : null,
  }
}

function eligibleCandidate(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string
    sourceRevisionId: string
    visualId: string
    raw: RawCandidate
  },
): ShotVideoVisualReferenceBoundCandidate {
  const eligibility = shotVideoReferenceAssetEligibility(database, {
    projectId: input.projectId,
    episodeId: input.episodeId,
    sourceRevisionId: input.sourceRevisionId,
    assetId: input.raw.assetId,
  })
  if (eligibility.status !== 'eligible') {
    throw new ShotVideoVisualReferenceJobError(
      'REFERENCE_ASSET_INVALID',
      `视觉候选图 ${input.raw.entityName} 不再属于当前剧本修订`,
    )
  }
  return {
    visualId: input.visualId,
    assetId: eligibility.asset.id,
    assetVersion: eligibility.asset.version,
    assetChecksum: eligibility.asset.checksum,
    assetSourceRevisionId: eligibility.asset.sourceRevisionId,
    kind: input.raw.kind,
    entityId: input.raw.entityId,
    entityName: input.raw.entityName,
    selectable: input.raw.selectable,
  }
}

function addRawCandidate(target: Map<string, RawCandidate>, candidate: RawCandidate): void {
  const existing = target.get(candidate.assetId)
  if (existing && !isDeepStrictEqual(existing, candidate)) {
    throw new ShotVideoVisualReferenceJobError(
      'REFERENCE_ASSET_INVALID',
      `Asset ${candidate.assetId} 同时具有冲突的视觉候选身份`,
    )
  }
  target.set(candidate.assetId, candidate)
}

export function prepareShotVideoVisualReferenceJob(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string
    selectors: readonly ShotVideoVisualReferenceSelector[]
  },
): ShotVideoVisualReferenceJobInput {
  if (!boundedIdentifier(input.projectId)
    || !boundedIdentifier(input.episodeId)
    || input.selectors.length < 1
    || input.selectors.length > 24
    || input.selectors.some((selector) => (
      !boundedIdentifier(selector.shotId)
      || (selector.sceneId !== undefined && !boundedIdentifier(selector.sceneId))
    ))
    || new Set(input.selectors.map((selector) => `${selector.sceneId ?? ''}:${selector.shotId}`)).size
      !== input.selectors.length) {
    throw new ShotVideoVisualReferenceJobError('INVALID_REQUEST', '逐镜视觉分析范围无效')
  }
  const targets = input.selectors.map((selector) => resolvePublicShotVideoTarget(database, {
    projectId: input.projectId,
    episodeId: input.episodeId,
    shotId: selector.shotId,
    ...(selector.sceneId ? { sceneId: selector.sceneId } : {}),
  }))
  const revisions = new Set(targets.map((target) => target.sourceRevisionId))
  if (revisions.size !== 1) {
    throw new ShotVideoVisualReferenceJobError('INVALID_REQUEST', '所选镜头不属于同一剧本修订')
  }
  const sourceRevisionId = targets[0]!.sourceRevisionId
  const entities = visualEntities(database, input.projectId, input.episodeId)
  const characters = entities.filter((entity) => entity.type === 'character')
  const locations = entities.filter((entity) => entity.type === 'location')
  const props = entities.filter((entity) => entity.type === 'prop' && entity.lockedAssetId)
  const slots = characterSlots(database, input.projectId, input.episodeId)
  const rawCandidates = new Map<string, RawCandidate>()
  const rawAssetIdsByShot = new Map<string, Set<string>>()

  for (const [index, target] of targets.entries()) {
    if (!target.storyboardAssetId) {
      throw new ShotVideoVisualReferenceJobError(
        'STORYBOARD_REQUIRED',
        `镜头 ${target.publicShotId} 还没有当前修订的分镜图，无法做视觉选镜`,
      )
    }
    const metadata = shotMetadata(database, target.databaseShotId)
    const shotAssets = new Set<string>()
    addRawCandidate(rawCandidates, {
      assetId: target.storyboardAssetId,
      kind: 'storyboard',
      entityId: target.publicShotId,
      entityName: `${metadata.code} · ${metadata.title}`,
      selectable: true,
      sortKey: `0:${String(index).padStart(3, '0')}`,
    })
    shotAssets.add(target.storyboardAssetId)

    const text = normalized([target.scene, target.action, target.prompt].filter(Boolean).join('\n'))
    const subjectNames = new Set((target.subjectNames ?? []).map(normalized))
    const relevantCharacters = characters.filter((entity) => (
      subjectNames.has(normalized(entity.name)) || mentions(text, entity)
    ))
    for (const character of relevantCharacters) {
      if (character.lockedAssetId) {
        addRawCandidate(rawCandidates, {
          assetId: character.lockedAssetId,
          kind: 'character-primary',
          entityId: character.id,
          entityName: character.name,
          selectable: false,
          sortKey: `1:${character.id}:0`,
        })
        shotAssets.add(character.lockedAssetId)
      }
      for (const slot of slots.filter((candidate) => candidate.characterId === character.id)) {
        addRawCandidate(rawCandidates, {
          assetId: slot.assetId,
          kind: `character-${slot.view}`,
          entityId: character.id,
          entityName: character.name,
          selectable: true,
          sortKey: `1:${character.id}:${{ front: 1, side: 2, back: 3 }[slot.view]}`,
        })
        shotAssets.add(slot.assetId)
      }
    }

    const sceneLocations = locations.filter((entity) => (
      (metadata.locationId !== null && entity.id === metadata.locationId) || mentions(text, entity)
    ))
    for (const location of sceneLocations) {
      if (!location.lockedAssetId) continue
      addRawCandidate(rawCandidates, {
        assetId: location.lockedAssetId,
        kind: 'location',
        entityId: location.id,
        entityName: location.name,
        selectable: true,
        sortKey: `3:${location.id}`,
      })
      shotAssets.add(location.lockedAssetId)
    }

    for (const prop of props.filter((entity) => mentions(text, entity))) {
      addRawCandidate(rawCandidates, {
        assetId: prop.lockedAssetId!,
        kind: 'prop',
        entityId: prop.id,
        entityName: prop.name,
        selectable: true,
        sortKey: `2:${prop.id}`,
      })
      shotAssets.add(prop.lockedAssetId!)
    }
    rawAssetIdsByShot.set(target.publicShotId, shotAssets)
  }

  // Let the visual model discover a visible prop even when the script used a
  // synonym (for example “剑柄” for a locked “长剑”). Explicit entities
  // above remain mandatory; remaining capacity is filled deterministically.
  for (const prop of props) {
    if (!rawCandidates.has(prop.lockedAssetId!)) {
      if (rawCandidates.size >= SHOT_VIDEO_VISUAL_REFERENCE_MAX_IMAGES) continue
      addRawCandidate(rawCandidates, {
        assetId: prop.lockedAssetId!,
        kind: 'prop',
        entityId: prop.id,
        entityName: prop.name,
        selectable: true,
        sortKey: `2:${prop.id}`,
      })
    }
    if (rawCandidates.has(prop.lockedAssetId!)) {
      for (const shotAssets of rawAssetIdsByShot.values()) shotAssets.add(prop.lockedAssetId!)
    }
  }
  if (rawCandidates.size > SHOT_VIDEO_VISUAL_REFERENCE_MAX_IMAGES) {
    throw new ShotVideoVisualReferenceJobError(
      'REFERENCE_SCOPE_TOO_LARGE',
      `当前镜头与必需视觉候选共 ${rawCandidates.size} 张，超过单次 ${SHOT_VIDEO_VISUAL_REFERENCE_MAX_IMAGES} 张上限；请分批选镜`,
    )
  }
  const orderedRaw = [...rawCandidates.values()].sort((left, right) => (
    left.sortKey.localeCompare(right.sortKey) || left.assetId.localeCompare(right.assetId)
  ))
  const visualIdByAssetId = new Map(orderedRaw.map((candidate, index) => [
    candidate.assetId,
    `I${String(index + 1).padStart(2, '0')}`,
  ]))
  const candidates = orderedRaw.map((raw) => eligibleCandidate(database, {
    projectId: input.projectId,
    episodeId: input.episodeId,
    sourceRevisionId,
    visualId: visualIdByAssetId.get(raw.assetId)!,
    raw,
  }))
  const shots = targets.map((target): ShotVideoVisualReferenceShot => {
    const metadata = shotMetadata(database, target.databaseShotId)
    const tokens = [...(rawAssetIdsByShot.get(target.publicShotId) ?? [])]
      .map((assetId) => visualIdByAssetId.get(assetId))
      .filter((visualId): visualId is string => Boolean(visualId))
    const relevantCharacterNames = new Set((target.subjectNames ?? []).map(normalized))
    const text = normalized([target.action, target.prompt].filter(Boolean).join('\n'))
    return {
      shotId: target.publicShotId,
      sceneId: target.publicSceneId,
      code: metadata.code,
      title: metadata.title,
      description: target.action ?? '',
      framing: target.shotSize ?? '',
      movement: target.cameraMovement ?? '',
      prompt: target.prompt,
      candidateVisualIds: tokens,
      storyboardVisualId: visualIdByAssetId.get(target.storyboardAssetId!) ?? null,
      characters: characters.filter((entity) => (
        relevantCharacterNames.has(normalized(entity.name)) || mentions(text, entity)
      )).map((entity) => ({ characterId: entity.id, characterName: entity.name })),
    }
  })
  const fingerprint = shotVideoVisualReferenceInputFingerprint({
    projectId: input.projectId,
    episodeId: input.episodeId,
    sourceRevisionId,
    shots,
    candidates,
  })
  return {
    version: SHOT_VIDEO_VISUAL_REFERENCE_JOB_VERSION,
    episodeId: input.episodeId,
    expectedStoryRevisionId: sourceRevisionId,
    inputFingerprint: fingerprint,
    selectors: input.selectors.map((selector) => ({ ...selector })),
    shots,
    candidates,
  }
}

export function parseShotVideoVisualReferenceJobInput(
  value: unknown,
): ShotVideoVisualReferenceJobInput {
  if (!isRecord(value)
    || !exactKeys(value, [
      'version', 'episodeId', 'expectedStoryRevisionId', 'inputFingerprint',
      'selectors', 'shots', 'candidates', 'batch',
    ])
    || value.version !== SHOT_VIDEO_VISUAL_REFERENCE_JOB_VERSION
    || !boundedIdentifier(value.episodeId)
    || !boundedIdentifier(value.expectedStoryRevisionId)
    || typeof value.inputFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.inputFingerprint)
    || !Array.isArray(value.selectors)
    || !Array.isArray(value.shots)
    || !Array.isArray(value.candidates)
    || (value.batch !== undefined && (
      !isRecord(value.batch)
      || !exactKeys(value.batch, [
        'version', 'batchId', 'requestFingerprint', 'selectionIndex', 'selectionCount',
      ])
      || value.batch.version !== SHOT_VIDEO_VISUAL_REFERENCE_BATCH_VERSION
      || !boundedIdentifier(value.batch.batchId)
      || typeof value.batch.requestFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.batch.requestFingerprint)
      || !Number.isInteger(value.batch.selectionIndex)
      || (value.batch.selectionIndex as number) < 0
      || !Number.isInteger(value.batch.selectionCount)
      || (value.batch.selectionCount as number) < 1
      || (value.batch.selectionCount as number) > 24
      || (value.batch.selectionIndex as number) >= (value.batch.selectionCount as number)
    ))) {
    throw new JobExecutionError(
      'VIDEO_REFERENCE_ANALYSIS_INPUT_INVALID',
      '逐镜视觉分析任务参数无效',
      false,
      'validation',
    )
  }
  return value as unknown as ShotVideoVisualReferenceJobInput
}

export function bindShotVideoVisualReferenceBatch(
  input: ShotVideoVisualReferenceJobInput,
  batch: ShotVideoVisualReferenceBatchBinding,
): ShotVideoVisualReferenceJobInput {
  if (input.selectors.length !== 1 || input.shots.length !== 1) {
    throw new ShotVideoVisualReferenceJobError(
      'INVALID_REQUEST',
      '批量视觉分析的每个持久任务必须只绑定一个镜头',
    )
  }
  return parseShotVideoVisualReferenceJobInput(structuredClone({ ...input, batch }))
}

/** Batch metadata is coordination-only and never weakens visual authority. */
export function sameShotVideoVisualReferenceAuthority(
  left: ShotVideoVisualReferenceJobInput,
  right: ShotVideoVisualReferenceJobInput,
): boolean {
  const { batch: _leftBatch, ...leftAuthority } = left
  const { batch: _rightBatch, ...rightAuthority } = right
  return isDeepStrictEqual(leftAuthority, rightAuthority)
}

async function dataUrlForCandidate(
  mediaStore: MediaStore,
  candidate: ShotVideoVisualReferenceBoundCandidate,
): Promise<string> {
  let opened: Awaited<ReturnType<MediaStore['openAsset']>>
  try {
    opened = await mediaStore.openAsset(candidate.assetId)
  } catch (error) {
    if (error instanceof MediaStoreError) {
      throw new JobExecutionError(
        'VIDEO_REFERENCE_IMAGE_UNAVAILABLE',
        '视觉分析图片已不可用，请刷新后重新分析',
        false,
        'validation',
      )
    }
    throw error
  }
  try {
    if (!IMAGE_MIME.has(opened.mimeType) || opened.size < 1 || opened.size > MAX_VISION_SOURCE_BYTES) {
      throw new JobExecutionError(
        'VIDEO_REFERENCE_IMAGE_TOO_LARGE',
        `视觉分析图片 ${candidate.entityName} 超出 3MB 受控输入上限，请先生成缩略版`,
        false,
        'validation',
      )
    }
    const bytes = await opened.file.readFile()
    const checksum = createHash('sha256').update(bytes).digest('hex')
    if (checksum !== candidate.assetChecksum || opened.asset.version !== candidate.assetVersion) {
      throw new JobExecutionError(
        'VIDEO_REFERENCE_IMAGE_CHANGED',
        '视觉分析图片与固化绑定不一致，不会继续请求模型',
        false,
        'validation',
      )
    }
    return `data:${opened.mimeType};base64,${Buffer.from(bytes).toString('base64')}`
  } finally {
    await opened.file.close().catch(() => undefined)
  }
}

function providerError(error: unknown): JobExecutionError {
  if (error instanceof ShotVideoVisualReferenceAnalysisError) {
    return new JobExecutionError(error.code, error.message, false, 'validation')
  }
  if (error instanceof TextProviderError) {
    return new JobExecutionError(
      error.code,
      error.message,
      error.retryable,
      error.code === 'PROVIDER_AUTH_FAILED' ? 'authentication' : 'provider',
    )
  }
  return new JobExecutionError(
    'VIDEO_REFERENCE_ANALYSIS_FAILED',
    '视觉选镜分析失败，请稍后手动重试',
    true,
    'provider',
  )
}

export function createShotVideoVisualReferenceHandler(dependencies: {
  database: ManjuDatabase
  mediaStore: MediaStore
  providerService: ProviderService
  textCompatibleFetch?: typeof fetch
}): JobHandler<ShotVideoVisualReferenceJobInput, JsonObject> {
  return async (job, context) => {
    const priorState = isRecord(job.providerState) ? job.providerState : undefined
    if (priorState?.operation === SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE
      && (priorState.phase === 'submitting' || priorState.phase === 'response-received')) {
      throw new JobExecutionError(
        'VIDEO_REFERENCE_ANALYSIS_OUTCOME_UNKNOWN',
        '上次视觉分析在进程中断前已发出，结果无法确认；系统不会自动重提，请主动发起新一轮',
        false,
        'provider',
      )
    }
    const input = parseShotVideoVisualReferenceJobInput(job.input)
    if (!job.projectId) {
      throw new JobExecutionError(
        'VIDEO_REFERENCE_ANALYSIS_INPUT_INVALID',
        '逐镜视觉分析任务缺少项目绑定',
        false,
        'validation',
      )
    }
    const projectId = job.projectId
    const current = prepareShotVideoVisualReferenceJob(dependencies.database, {
      projectId,
      episodeId: input.episodeId,
      selectors: input.selectors,
    })
    if (current.expectedStoryRevisionId !== input.expectedStoryRevisionId
      || current.inputFingerprint !== input.inputFingerprint
      || !isDeepStrictEqual(current.shots, input.shots)
      || !isDeepStrictEqual(current.candidates, input.candidates)) {
      throw new JobExecutionError(
        'STALE_SOURCE',
        '分镜、角色槽位或视觉资产已变化，请基于最新修订重新分析',
        false,
        'validation',
      )
    }
    const durable = dependencies.database.getGenerationJob(job.id)
    if (!durable || !durable.providerId || durable.providerConfigRevision === null || !durable.model) {
      throw new JobExecutionError(
        'VIDEO_REFERENCE_ANALYSIS_PROVIDER_INVALID',
        '视觉分析任务没有固化文本 Provider 修订',
        false,
        'validation',
      )
    }
    let profile
    try {
      profile = await dependencies.providerService.materializeExecutionProfile(
        durable.providerId,
        durable.providerConfigRevision,
      )
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        throw new JobExecutionError(error.code, '视觉分析 Provider 修订不可用', false, 'validation')
      }
      throw error
    }
    if (profile.kind !== 'text'
      || (profile.adapter !== 'codex-tools' && profile.adapter !== 'openai-compatible')
      || !profile.baseUrl?.trim()
      || !profile.model?.trim()
      || profile.model !== durable.model) {
      throw new JobExecutionError(
        'VIDEO_REFERENCE_ANALYSIS_PROVIDER_INVALID',
        '当前 Provider 不支持受控多模态结构输出',
        false,
        'validation',
      )
    }
    await context.reportProgress(10, { stage: 'binding-images' })
    const candidates: ShotVideoVisualReferenceCandidate[] = []
    for (const [index, candidate] of input.candidates.entries()) {
      candidates.push({
        ...candidate,
        dataUrl: await dataUrlForCandidate(dependencies.mediaStore, candidate),
      })
      await context.reportProgress(10 + Math.round(((index + 1) / input.candidates.length) * 25), {
        stage: 'binding-images',
      })
    }
    const provider = new OpenAICompatibleTextProvider({
      name: profile.providerId,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      model: profile.model,
      ...(dependencies.textCompatibleFetch ? { fetch: dependencies.textCompatibleFetch } : {}),
      ...(profile.adapter === 'codex-tools'
        ? { protocol: 'responses' as const, reasoningEffort: 'medium' as const }
        : {}),
    })
    await context.waitingForProvider({
      operation: SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
      phase: 'submitting',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: profile.providerId,
      providerConfigRevision: profile.configRevision,
      inputFingerprint: input.inputFingerprint,
      submittedAt: new Date().toISOString(),
    })
    let analysis: ShotVideoVisualReferenceAnalysis
    try {
      const analysisInput: ShotVideoVisualReferenceAnalysisInput = {
        projectId,
        episodeId: input.episodeId,
        sourceRevisionId: input.expectedStoryRevisionId,
        shots: input.shots,
        candidates,
        idempotencyKey: job.id,
      }
      analysis = await analyzeShotVideoVisualReferences(provider, analysisInput, context.signal)
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason
      throw providerError(error)
    }
    await context.waitingForProvider({
      operation: SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
      phase: 'response-received',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: profile.providerId,
      providerConfigRevision: profile.configRevision,
      inputFingerprint: input.inputFingerprint,
      receivedAt: new Date().toISOString(),
    })
    await context.reportProgress(95, { stage: 'vision-plan-validated' })
    return { analysis: analysis as unknown as JsonObject }
  }
}

/**
 * Resolve one Shot's authoritative visual plan from a succeeded durable Job.
 *
 * The public batch request is allowed to name only the Job. It can never post
 * a model-authored Asset list directly. Before every free preflight and paid
 * confirmation we rebuild the complete analysis scope from current durable
 * state, so a changed storyboard/slot/lock invalidates the whole analysis
 * instead of silently falling back to deterministic first-frame guidance.
 */
export function resolvePersistedShotVideoVisionAssessment(
  database: ManjuDatabase,
  input: {
    jobId: string
    projectId: string
    episodeId: string
    sourceRevisionId: string
    shotId: string
    sceneId: string
  },
): PersistedVisionSelectedReferenceAssessment {
  if (!boundedIdentifier(input.jobId)
    || !boundedIdentifier(input.projectId)
    || !boundedIdentifier(input.episodeId)
    || !boundedIdentifier(input.sourceRevisionId)
    || !boundedIdentifier(input.shotId)
    || !boundedIdentifier(input.sceneId)) {
    throw new ShotVideoVisualReferenceResolutionError(
      'VIDEO_REFERENCE_ANALYSIS_INVALID',
      '视觉选镜任务绑定无效',
    )
  }
  const job = database.getGenerationJob(input.jobId)
  if (!job
    || job.type !== SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE
    || job.projectId !== input.projectId
    || job.episodeId !== input.episodeId) {
    throw new ShotVideoVisualReferenceResolutionError(
      'VIDEO_REFERENCE_ANALYSIS_NOT_FOUND',
      '找不到当前项目的视觉选镜任务，请重新分析',
    )
  }
  if (job.status !== 'succeeded') {
    throw new ShotVideoVisualReferenceResolutionError(
      'VIDEO_REFERENCE_ANALYSIS_NOT_READY',
      job.status === 'failed' || job.status === 'cancelled'
        ? '视觉选镜任务未成功，请主动发起新一轮分析'
        : '视觉选镜任务尚未完成，请稍后刷新',
    )
  }

  let bound: ShotVideoVisualReferenceJobInput
  try {
    bound = parseShotVideoVisualReferenceJobInput(job.input)
  } catch {
    throw new ShotVideoVisualReferenceResolutionError(
      'VIDEO_REFERENCE_ANALYSIS_INVALID',
      '视觉选镜任务缺少可验证的输入绑定，请重新分析',
    )
  }
  if (bound.episodeId !== input.episodeId
    || bound.expectedStoryRevisionId !== input.sourceRevisionId
    || !bound.selectors.some((selector) => (
      selector.shotId === input.shotId
      && (selector.sceneId === undefined || selector.sceneId === input.sceneId)
    ))) {
    throw new ShotVideoVisualReferenceResolutionError(
      'VIDEO_REFERENCE_ANALYSIS_STALE',
      '视觉选镜结果不属于当前剧本修订或镜头，请重新分析',
    )
  }

  let current: ShotVideoVisualReferenceJobInput
  try {
    current = prepareShotVideoVisualReferenceJob(database, {
      projectId: input.projectId,
      episodeId: input.episodeId,
      selectors: bound.selectors,
    })
  } catch {
    throw new ShotVideoVisualReferenceResolutionError(
      'VIDEO_REFERENCE_ANALYSIS_STALE',
      '分镜、角色视角槽位或锁定素材已变化，请重新运行 AI 视觉分析',
    )
  }
  if (!sameShotVideoVisualReferenceAuthority(bound, current)) {
    throw new ShotVideoVisualReferenceResolutionError(
      'VIDEO_REFERENCE_ANALYSIS_STALE',
      '分镜、角色视角槽位或锁定素材已变化，请重新运行 AI 视觉分析',
    )
  }

  const output = job.output
  const analysisValue = output && exactKeys(output, ['analysis']) ? output.analysis : undefined
  if (!isShotVideoVisualReferenceAnalysis(analysisValue)
    || analysisValue.projectId !== input.projectId
    || analysisValue.episodeId !== input.episodeId
    || analysisValue.sourceRevisionId !== input.sourceRevisionId
    || analysisValue.inputFingerprint !== bound.inputFingerprint
    || analysisValue.plans.length !== bound.shots.length) {
    throw new ShotVideoVisualReferenceResolutionError(
      'VIDEO_REFERENCE_ANALYSIS_INVALID',
      '视觉选镜任务的输出无法验证，请重新分析',
    )
  }
  const expectedShotIds = new Set(bound.shots.map((shot) => shot.shotId))
  if (analysisValue.plans.some((plan) => !expectedShotIds.has(plan.shotId))) {
    throw new ShotVideoVisualReferenceResolutionError(
      'VIDEO_REFERENCE_ANALYSIS_INVALID',
      '视觉选镜任务的镜头范围不完整，请重新分析',
    )
  }
  const candidateByAssetId = new Map(bound.candidates.map((candidate) => [candidate.assetId, candidate]))
  for (const candidatePlan of analysisValue.plans) {
    const boundShot = bound.shots.find((shot) => shot.shotId === candidatePlan.shotId)
    if (!boundShot || boundShot.sceneId !== candidatePlan.sceneId) {
      throw new ShotVideoVisualReferenceResolutionError(
        'VIDEO_REFERENCE_ANALYSIS_INVALID',
        '视觉选镜任务的镜头范围不完整，请重新分析',
      )
    }
    const allowedVisualIds = new Set(boundShot.candidateVisualIds)
    const expectedCharacterIds = new Set(boundShot.characters.map((character) => character.characterId))
    const invalidReference = candidatePlan.selectedReferences.some((reference) => {
      const candidate = candidateByAssetId.get(reference.assetId)
      if (!candidate || !candidate.selectable || !allowedVisualIds.has(candidate.visualId)) return true
      if (reference.role === 'first_frame') {
        return boundShot.storyboardVisualId === null
          || candidate.visualId !== boundShot.storyboardVisualId
          || candidate.kind !== 'storyboard'
      }
      // A storyboard is valid only when it is the current Shot's own candidate;
      // another Shot can never be smuggled in as a generic reference image.
      return candidate.kind === 'storyboard' && candidate.visualId !== boundShot.storyboardVisualId
    })
    const invalidMissingView = candidatePlan.missingCharacterViews.some((missing) => (
      !expectedCharacterIds.has(missing.characterId)
    ))
    if (invalidReference || invalidMissingView) {
      throw new ShotVideoVisualReferenceResolutionError(
        'VIDEO_REFERENCE_ANALYSIS_INVALID',
        '视觉选镜结果引用了当前镜头候选集之外的素材，请重新分析',
      )
    }
  }
  const plan = analysisValue.plans.find((candidate) => (
    candidate.shotId === input.shotId && candidate.sceneId === input.sceneId
  ))
  if (!plan) {
    throw new ShotVideoVisualReferenceResolutionError(
      'VIDEO_REFERENCE_ANALYSIS_INVALID',
      '视觉选镜任务没有返回当前镜头的计划，请重新分析',
    )
  }
  return {
    version: 1,
    source: 'persisted_vision',
    mode: 'selected_references',
    shotId: plan.shotId,
    sceneId: plan.sceneId,
    sourceRevisionId: analysisValue.sourceRevisionId,
    status: plan.status,
    strategy: plan.strategy,
    confidence: plan.confidence,
    rationale: plan.rationale,
    visualEvidence: [...plan.visualEvidence],
    selectedReferences: plan.selectedReferences.map((reference) => ({ ...reference })),
    missingCharacterViews: plan.missingCharacterViews.map((missing) => ({ ...missing })),
  }
}
