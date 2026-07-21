import type { ManjuDatabase } from './database.js'
import type { SeedanceImageRole } from './providers/seedance.js'
import {
  shotVideoReferenceAssetEligibility,
  shotVideoWholeTurnaroundReferenceAsset,
} from './shot-video-reference-asset.js'
import type { ShotVideoTarget } from './shot-video-generation.js'
import {
  recommendCharacterReferenceView,
  type ShotVideoReferenceRecommendation,
} from './shot-video-reference-recommendation.js'
import { SHOT_VIDEO_VISUAL_REFERENCE_CONFIDENCE_THRESHOLD } from './shot-video-visual-reference-analysis.js'

export const SHOT_VIDEO_REFERENCE_PLAN_VERSION = 1 as const
export const SHOT_VIDEO_REFERENCE_PLAN_POLICY = 'deterministic-reference-safety-v1' as const
export const MAX_SHOT_VIDEO_REFERENCE_IMAGES = 9 as const

interface PersistedVisionReferenceBinding {
  version: 1
  source: 'persisted_vision'
  shotId: string
  sceneId: string
  sourceRevisionId: string
}

export interface PersistedVisionSafetyAssessment extends PersistedVisionReferenceBinding {
  mode?: 'safety_assessment'
  identitySensitive: boolean
  allowStoryboardFallback: boolean
  rationale: string
}

/**
 * Revision-bound result copied from a succeeded server-side visual-analysis
 * Job. This is deliberately not accepted from the batch HTTP request.
 */
export interface PersistedVisionSelectedReferenceAssessment extends PersistedVisionReferenceBinding {
  mode: 'selected_references'
  status: 'recommended' | 'manual_required'
  strategy: 'first_frame' | 'multi_reference' | 'text_only' | 'manual_review'
  confidence: number
  rationale: string
  visualEvidence: string[]
  selectedReferences: Array<{
    assetId: string
    role: 'first_frame' | 'reference_image'
    purpose: string
  }>
  missingCharacterViews: Array<{
    characterId: string
    characterName: string
    view: 'front' | 'side' | 'back' | 'uncertain'
    rationale: string
  }>
}

export type PersistedVisionReferenceAssessment =
  | PersistedVisionSafetyAssessment
  | PersistedVisionSelectedReferenceAssessment

export interface ShotVideoContextReferencePin {
  entityType: 'prop' | 'location'
  entityId: string
  entityName: string
  entityVersion: number
  assetId: string
  assetVersion: number
  assetChecksum: string
  assetSourceRevisionId: string
}

export interface ShotVideoContextReferenceIssue {
  entityType: 'prop' | 'location'
  entityId: string
  entityName: string
  assetId: string
  reason: 'locked_asset_unavailable'
}

export type ShotVideoReferencePlanReason =
  | 'REFERENCE_PLAN_READY'
  | 'IDENTITY_REFERENCE_REQUIRED'
  | 'STORYBOARD_FALLBACK_UNSAFE'
  | 'CONTEXT_REFERENCE_INVALID'
  | 'PERSISTED_VISION_SELECTION_INVALID'
  | 'REFERENCE_IMAGE_LIMIT_EXCEEDED'

export interface ShotVideoReferencePlan {
  version: typeof SHOT_VIDEO_REFERENCE_PLAN_VERSION
  policy: typeof SHOT_VIDEO_REFERENCE_PLAN_POLICY
  assessmentSource: 'deterministic_safety' | 'persisted_vision'
  status: 'ready' | 'manual_required'
  reasonCode: ShotVideoReferencePlanReason
  shotId: string
  sceneId: string
  sourceRevisionId: string
  identitySensitive: boolean
  safeStoryboardFallback: boolean
  storyboardAnchorAssetId: string | null
  characterReferenceAssetIds: string[]
  contextPins: ShotVideoContextReferencePin[]
  contextIssues: ShotVideoContextReferenceIssue[]
  selectedReferences: Array<{ assetId: string; role: SeedanceImageRole }>
  rationale: string
}

interface ContextEntityRow {
  entityType: 'prop' | 'location'
  entityId: string
  entityName: string
  entityVersion: number
  lockedAssetId: string
}

function compact(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/[\t\r\n ]+/g, ' ').trim().toLocaleLowerCase()
}

function stringValue(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

function positiveInteger(row: Record<string, unknown>, key: string): number | null {
  const value = row[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null
}

const PUBLIC_ENTITY_ID = `CASE
  WHEN typeof(json_extract(metadata_json, '$.storyId')) = 'text'
    AND length(trim(json_extract(metadata_json, '$.storyId'))) > 0
  THEN json_extract(metadata_json, '$.storyId')
  ELSE id
END`

function contextEntityRows(database: ManjuDatabase, target: ShotVideoTarget): ContextEntityRow[] {
  const read = (
    entityType: ContextEntityRow['entityType'],
    table: 'props' | 'locations',
  ): ContextEntityRow[] => database.withSql((sql) => sql.all(`
    SELECT
      ${PUBLIC_ENTITY_ID} AS public_entity_id,
      name,
      version,
      locked_asset_id
    FROM ${table}
    WHERE project_id = ?
      AND episode_id = ?
      AND locked_asset_id IS NOT NULL
    ORDER BY id
  `, target.projectId, target.episodeId)).flatMap((row) => {
    const entityId = stringValue(row, 'public_entity_id')
    const entityName = stringValue(row, 'name')
    const entityVersion = positiveInteger(row, 'version')
    const lockedAssetId = stringValue(row, 'locked_asset_id')
    return entityId && entityName && entityVersion && lockedAssetId
      ? [{ entityType, entityId, entityName, entityVersion, lockedAssetId }]
      : []
  })
  // Prop details affect the subject before the wider location context. This
  // order is stable across restarts and independent of insertion timestamps.
  return [...read('prop', 'props'), ...read('location', 'locations')]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function explicitlyMentions(haystack: string, value: string): boolean {
  const needle = compact(value)
  if (!needle) return false
  if (/[^\x00-\x7f]/u.test(needle)) return haystack.includes(needle)
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:$|[^a-z0-9])`, 'iu').test(haystack)
}

function relevantContextEntities(
  database: ManjuDatabase,
  target: ShotVideoTarget,
): ContextEntityRow[] {
  const propText = compact([target.action, target.prompt].filter(Boolean).join(' '))
  const locationText = compact([target.scene, target.action, target.prompt].filter(Boolean).join(' '))
  return contextEntityRows(database, target).filter((entity) => explicitlyMentions(
    entity.entityType === 'prop' ? propText : locationText,
    entity.entityName,
  ) || explicitlyMentions(
    entity.entityType === 'prop' ? propText : locationText,
    entity.entityId,
  ))
}

function contextPinForEntity(
  database: ManjuDatabase,
  target: ShotVideoTarget,
  entity: ContextEntityRow,
): ShotVideoContextReferencePin | null {
  const eligibility = shotVideoReferenceAssetEligibility(database, {
    projectId: target.projectId,
    episodeId: target.episodeId,
    sourceRevisionId: target.sourceRevisionId,
    assetId: entity.lockedAssetId,
  })
  if (eligibility.status !== 'eligible') return null
  return {
    entityType: entity.entityType,
    entityId: entity.entityId,
    entityName: entity.entityName,
    entityVersion: entity.entityVersion,
    assetId: eligibility.asset.id,
    assetVersion: eligibility.asset.version,
    assetChecksum: eligibility.asset.checksum,
    assetSourceRevisionId: eligibility.asset.sourceRevisionId,
  }
}

function currentShotCharacterSlotAssetIds(
  database: ManjuDatabase,
  target: ShotVideoTarget,
  recommendation: ShotVideoReferenceRecommendation,
): Set<string> {
  const characterIds = new Set(recommendation.characters.map((character) => compact(character.characterId)))
  const characterNames = new Set([
    ...recommendation.characters.map((character) => compact(character.characterName)),
    ...(target.subjectNames ?? []).map((name) => compact(name)),
  ])
  const rows = database.withSql((sql) => sql.all(`
    SELECT
      CASE
        WHEN typeof(json_extract(characters.metadata_json, '$.storyId')) = 'text'
          AND length(trim(json_extract(characters.metadata_json, '$.storyId'))) > 0
        THEN json_extract(characters.metadata_json, '$.storyId')
        ELSE characters.id
      END AS public_character_id,
      characters.name AS character_name,
      character_visual_references.asset_id
    FROM characters
    JOIN character_visual_references
      ON character_visual_references.character_id = characters.id
     AND character_visual_references.project_id = characters.project_id
     AND character_visual_references.episode_id = characters.episode_id
    WHERE characters.project_id = ?
      AND characters.episode_id = ?
    ORDER BY characters.id,
      CASE character_visual_references.role
        WHEN 'front' THEN 1 WHEN 'side' THEN 2 WHEN 'back' THEN 3 ELSE 4
      END
  `, target.projectId, target.episodeId))
  const assetIds = new Set<string>()
  for (const row of rows) {
    if (!characterIds.has(compact(stringValue(row, 'public_character_id')))
      && !characterNames.has(compact(stringValue(row, 'character_name')))) continue
    const assetId = stringValue(row, 'asset_id')
    if (!assetId) continue
    const eligibility = shotVideoReferenceAssetEligibility(database, {
      projectId: target.projectId,
      episodeId: target.episodeId,
      sourceRevisionId: target.sourceRevisionId,
      assetId,
    })
    if (eligibility.status === 'eligible') assetIds.add(assetId)
  }
  return assetIds
}

function otherShotStoryboardAssetIds(
  database: ManjuDatabase,
  target: ShotVideoTarget,
  storyboardAnchorAssetId: string | null,
): Set<string> {
  const assetIds = new Set(database.withSql((sql) => sql.all(`
    SELECT shots.storyboard_asset_id
    FROM shots
    JOIN scenes ON scenes.id = shots.scene_id
    JOIN episodes ON episodes.id = scenes.episode_id
    WHERE episodes.project_id = ?
      AND scenes.episode_id = ?
      AND shots.storyboard_asset_id IS NOT NULL
    ORDER BY scenes.sequence, shots.sequence
  `, target.projectId, target.episodeId)).map((row) => stringValue(row, 'storyboard_asset_id')))
  if (storyboardAnchorAssetId) assetIds.delete(storyboardAnchorAssetId)
  assetIds.delete('')
  return assetIds
}

const WIDE_OR_ESTABLISHING = /(?:超远景|大全景|远景|建立镜头|航拍|鸟瞰|俯瞰|extreme[ -]wide|very wide|long shot|establishing|aerial|bird[' -]?s[ -]?eye)/iu
const IDENTITY_SENSITIVE = /(?:正脸|正面|侧脸|侧面|背影|背对|特写|近景|肖像|表情|眼神|眼睛|面部|脸|凝视|服饰|服装|造型|发饰|徽记|纹样|身份特征|front[ -]?(?:view|facing)|profile|side[ -]?view|rear[ -]?view|back[ -]?view|close[ -]?up|portrait|facial|expression|eyes?|gaze|costume|outfit|identity detail)/iu
const DISTANT_MINOR_SUBJECT = /(?:小小(?:的)?(?:身影|人影|剪影|人物|角色)|小人(?:物)?|小剪影|远处(?:的)?(?:小人(?:物)?|剪影)|tiny (?:figure|silhouette|character)|distant silhouette)/iu

function deterministicAssessment(
  target: ShotVideoTarget,
  recommendation: ShotVideoReferenceRecommendation,
): {
  identitySensitive: boolean
  allowStoryboardFallback: boolean
  storyboardOnlyFallback: boolean
  rationale: string
} {
  const direction = recommendCharacterReferenceView({
    shotSize: target.shotSize,
    cameraMovement: target.cameraMovement,
    action: target.action,
    prompt: target.prompt,
    hasDialogueSubject: (target.subjectNames?.length ?? 0) > 0,
  })
  const text = compact([target.shotSize, target.cameraMovement, target.action, target.prompt].filter(Boolean).join(' '))
  // Real production prompts often repeat a full character costume bible even
  // when the rendered subject is only a tiny silhouette. Composition evidence
  // wins in that narrow case; explicit camera-relative direction still does not.
  const visuallyMinorDistantSubject = WIDE_OR_ESTABLISHING.test(text)
    && DISTANT_MINOR_SUBJECT.test(text)
    && direction.status !== 'recommended'
    && direction.reasonCode !== 'conflicting_direction_cues'
  const identitySensitive = !visuallyMinorDistantSubject && (
    recommendation.status === 'recommended'
      || recommendation.characters.some((character) => character.view !== null)
      || direction.status === 'recommended'
      || direction.reasonCode === 'conflicting_direction_cues'
      || IDENTITY_SENSITIVE.test(text)
      || (target.subjectNames?.length ?? 0) > 0
  )
  const fallbackSubjectIsSafe = visuallyMinorDistantSubject
    || recommendation.status === 'not_applicable'
    || (recommendation.status === 'manual_required'
      && recommendation.characters.length > 0
      && recommendation.characters.length <= MAX_SHOT_VIDEO_REFERENCE_IMAGES)
  const allowStoryboardFallback = fallbackSubjectIsSafe
    && !identitySensitive
    && WIDE_OR_ESTABLISHING.test(text)
  return {
    identitySensitive,
    allowStoryboardFallback,
    storyboardOnlyFallback: visuallyMinorDistantSubject,
    rationale: allowStoryboardFallback
      ? '远景/建立镜头不依赖角色面部或明确朝向，可仅用当前同镜分镜图作首帧引导。'
      : identitySensitive
        ? '镜头对角色视角/面部/身份细节敏感，不得用分镜首帧掩盖缺失的角色槽位。'
        : '当前证据不足以安全自动决定角色参考图。',
  }
}

function validatedAssessment(
  target: ShotVideoTarget,
  recommendation: ShotVideoReferenceRecommendation,
  override: PersistedVisionReferenceAssessment | undefined,
): {
  source: ShotVideoReferencePlan['assessmentSource']
  identitySensitive: boolean
  allowStoryboardFallback: boolean
  storyboardOnlyFallback: boolean
  rationale: string
  selectedReferenceAssessment: PersistedVisionSelectedReferenceAssessment | null
} {
  if (!override) {
    return {
      source: 'deterministic_safety',
      ...deterministicAssessment(target, recommendation),
      selectedReferenceAssessment: null,
    }
  }
  if (override.version !== 1
    || override.source !== 'persisted_vision'
    || override.shotId !== target.publicShotId
    || override.sceneId !== target.publicSceneId
    || override.sourceRevisionId !== target.sourceRevisionId
    || typeof override.rationale !== 'string'
    || !override.rationale.trim()) {
    throw new TypeError('Persisted vision reference assessment does not match the current shot')
  }
  if (override.mode === 'selected_references') {
    const structurallyValid = (override.status === 'recommended' || override.status === 'manual_required')
      && ['first_frame', 'multi_reference', 'text_only', 'manual_review'].includes(override.strategy)
      && Number.isFinite(override.confidence)
      && override.confidence >= 0
      && override.confidence <= 1
      && Array.isArray(override.visualEvidence)
      && override.visualEvidence.length <= 8
      && override.visualEvidence.every((evidence) => typeof evidence === 'string'
        && evidence.trim().length > 0
        && evidence.length <= 300)
      && Array.isArray(override.selectedReferences)
      && override.selectedReferences.length <= MAX_SHOT_VIDEO_REFERENCE_IMAGES
      && override.selectedReferences.every((reference) => reference !== null
        && typeof reference === 'object'
        && typeof reference.assetId === 'string'
        && reference.assetId.length > 0
        && (reference.role === 'first_frame' || reference.role === 'reference_image')
        && typeof reference.purpose === 'string'
        && reference.purpose.trim().length > 0
        && reference.purpose.length <= 300)
      && new Set(override.selectedReferences.map((reference) => reference.assetId)).size
        === override.selectedReferences.length
      && Array.isArray(override.missingCharacterViews)
      && override.missingCharacterViews.length <= 64
      && override.missingCharacterViews.every((missing) => missing !== null
        && typeof missing === 'object'
        && typeof missing.characterId === 'string'
        && missing.characterId.length > 0
        && typeof missing.characterName === 'string'
        && missing.characterName.length > 0
        && ['front', 'side', 'back', 'uncertain'].includes(missing.view)
        && typeof missing.rationale === 'string'
        && missing.rationale.trim().length > 0)
      && new Set(override.missingCharacterViews.map((missing) => missing.characterId)).size
        === override.missingCharacterViews.length
    if (!structurallyValid) {
      throw new TypeError('Persisted vision reference assessment does not match the current shot')
    }
    const identitySensitive = override.missingCharacterViews.length > 0
      || (recommendation.characters.length > 0
        && deterministicAssessment(target, recommendation).identitySensitive)
    return {
      source: 'persisted_vision',
      identitySensitive,
      allowStoryboardFallback: override.strategy === 'first_frame',
      storyboardOnlyFallback: override.strategy === 'first_frame',
      rationale: override.rationale.trim(),
      selectedReferenceAssessment: override,
    }
  }
  if (typeof override.identitySensitive !== 'boolean'
    || typeof override.allowStoryboardFallback !== 'boolean'
    || (override.identitySensitive && override.allowStoryboardFallback)) {
    throw new TypeError('Persisted vision reference assessment does not match the current shot')
  }
  return {
    source: 'persisted_vision',
    identitySensitive: override.identitySensitive,
    allowStoryboardFallback: override.allowStoryboardFallback,
    storyboardOnlyFallback: false,
    rationale: override.rationale.trim(),
    selectedReferenceAssessment: null,
  }
}

interface NormalizedPersistedVisionSelection {
  status: 'ready' | 'manual_required' | 'invalid'
  selectedReferences: Array<{ assetId: string; role: SeedanceImageRole }>
  selectedCharacterAssetIds: string[]
  selectedContextPins: ShotVideoContextReferencePin[]
  safeStoryboardFallback: boolean
  rationale: string
}

function normalizePersistedVisionSelection(
  database: ManjuDatabase,
  target: ShotVideoTarget,
  recommendation: ShotVideoReferenceRecommendation,
  storyboardAnchorAssetId: string | null,
  assessment: PersistedVisionSelectedReferenceAssessment,
): NormalizedPersistedVisionSelection {
  if (assessment.status === 'manual_required') {
    if (assessment.strategy !== 'manual_review' || assessment.selectedReferences.length !== 0) {
      return {
        status: 'invalid',
        selectedReferences: [],
        selectedCharacterAssetIds: [],
        selectedContextPins: [],
        safeStoryboardFallback: false,
        rationale: '持久化视觉结果的人工复核状态与参考图选择冲突。',
      }
    }
    return {
      status: 'manual_required',
      selectedReferences: [],
      selectedCharacterAssetIds: [],
      selectedContextPins: [],
      safeStoryboardFallback: false,
      rationale: assessment.rationale,
    }
  }
  const selected = assessment.selectedReferences
  const strategyIsConsistent = assessment.missingCharacterViews.length === 0
    && assessment.confidence >= SHOT_VIDEO_VISUAL_REFERENCE_CONFIDENCE_THRESHOLD
    && assessment.strategy !== 'manual_review'
    && (assessment.strategy !== 'first_frame'
      || (selected.length === 1
        && selected[0]?.role === 'first_frame'
        && selected[0]?.assetId === storyboardAnchorAssetId))
    && (assessment.strategy !== 'multi_reference'
      || (selected.length >= 1 && selected.every((reference) => reference.role === 'reference_image')))
    && (assessment.strategy !== 'text_only' || selected.length === 0)
  if (!strategyIsConsistent) {
    return {
      status: 'invalid',
      selectedReferences: [],
      selectedCharacterAssetIds: [],
      selectedContextPins: [],
      safeStoryboardFallback: false,
      rationale: '持久化视觉结果的策略、置信度、缺失角色槽位与参考图不一致。',
    }
  }

  const characterAssetIds = currentShotCharacterSlotAssetIds(database, target, recommendation)
  const contextPinsByAssetId = new Map<string, ShotVideoContextReferencePin>()
  for (const entity of contextEntityRows(database, target)) {
    const pin = contextPinForEntity(database, target, entity)
    if (pin && !contextPinsByAssetId.has(pin.assetId)) contextPinsByAssetId.set(pin.assetId, pin)
  }
  const forbiddenStoryboards = otherShotStoryboardAssetIds(database, target, storyboardAnchorAssetId)
  const selectedCharacterAssetIds: string[] = []
  const selectedContextPins: ShotVideoContextReferencePin[] = []
  for (const reference of selected) {
    if (forbiddenStoryboards.has(reference.assetId)) {
      return {
        status: 'invalid',
        selectedReferences: [],
        selectedCharacterAssetIds: [],
        selectedContextPins: [],
        safeStoryboardFallback: false,
        rationale: `持久化视觉结果错误引用了其他镜头的分镜 ${reference.assetId}。`,
      }
    }
    if (reference.assetId === storyboardAnchorAssetId) continue
    if (characterAssetIds.has(reference.assetId)) {
      selectedCharacterAssetIds.push(reference.assetId)
      continue
    }
    const contextPin = contextPinsByAssetId.get(reference.assetId)
    if (contextPin) {
      selectedContextPins.push(contextPin)
      continue
    }
    return {
      status: 'invalid',
      selectedReferences: [],
      selectedCharacterAssetIds: [],
      selectedContextPins: [],
      safeStoryboardFallback: false,
      rationale: `持久化视觉结果引用了不属于当前镜头候选集的 Asset ${reference.assetId}。`,
    }
  }
  return {
    status: 'ready',
    selectedReferences: selected.map(({ assetId, role }) => ({ assetId, role })),
    selectedCharacterAssetIds,
    selectedContextPins,
    safeStoryboardFallback: assessment.strategy === 'first_frame',
    rationale: assessment.rationale,
  }
}

function basePlan(
  target: ShotVideoTarget,
  recommendation: ShotVideoReferenceRecommendation,
  storyboardAnchorAssetId: string | null,
  assessment: ReturnType<typeof validatedAssessment>,
  contextPins: ShotVideoContextReferencePin[],
  contextIssues: ShotVideoContextReferenceIssue[],
): Omit<ShotVideoReferencePlan, 'status' | 'reasonCode' | 'selectedReferences' | 'rationale' | 'safeStoryboardFallback'> {
  return {
    version: SHOT_VIDEO_REFERENCE_PLAN_VERSION,
    policy: SHOT_VIDEO_REFERENCE_PLAN_POLICY,
    assessmentSource: assessment.source,
    shotId: target.publicShotId,
    sceneId: target.publicSceneId,
    sourceRevisionId: target.sourceRevisionId,
    identitySensitive: assessment.identitySensitive,
    storyboardAnchorAssetId,
    characterReferenceAssetIds: recommendation.references.map((reference) => reference.assetId),
    contextPins,
    contextIssues,
  }
}

/**
 * Non-billable deterministic safety plan. It consumes an already-authoritative
 * character recommendation and can later consume a persisted vision assessment
 * without allowing a client-authored override. It never reads another Shot, so
 * a following storyboard can never become an implicit last frame.
 */
export function createShotVideoReferencePlan(
  database: ManjuDatabase,
  input: {
    target: ShotVideoTarget
    recommendation: ShotVideoReferenceRecommendation
    storyboardAnchorAssetId: string | null
    persistedVisionAssessment?: PersistedVisionReferenceAssessment
  },
): ShotVideoReferencePlan {
  const { target, recommendation, storyboardAnchorAssetId } = input
  const assessment = validatedAssessment(target, recommendation, input.persistedVisionAssessment)
  const contextPins: ShotVideoContextReferencePin[] = []
  const contextIssues: ShotVideoContextReferenceIssue[] = []
  for (const entity of relevantContextEntities(database, target)) {
    const pin = contextPinForEntity(database, target, entity)
    if (!pin) {
      contextIssues.push({
        entityType: entity.entityType,
        entityId: entity.entityId,
        entityName: entity.entityName,
        assetId: entity.lockedAssetId,
        reason: 'locked_asset_unavailable',
      })
      continue
    }
    contextPins.push(pin)
  }
  const persistedSelection = assessment.selectedReferenceAssessment
    ? normalizePersistedVisionSelection(
      database,
      target,
      recommendation,
      storyboardAnchorAssetId,
      assessment.selectedReferenceAssessment,
    )
    : null
  const mergedContextPins = persistedSelection
    ? [...contextPins, ...persistedSelection.selectedContextPins]
      .filter((pin, index, pins) => pins.findIndex((candidate) => candidate.assetId === pin.assetId) === index)
    : contextPins
  const base = basePlan(
    target,
    recommendation,
    storyboardAnchorAssetId,
    assessment,
    mergedContextPins,
    contextIssues,
  )
  if (persistedSelection) {
    base.characterReferenceAssetIds = [
      ...base.characterReferenceAssetIds,
      ...persistedSelection.selectedCharacterAssetIds,
    ].filter((assetId, index, assetIds) => assetIds.indexOf(assetId) === index)
  }
  if (contextIssues.length > 0) {
    return {
      ...base,
      status: 'manual_required',
      reasonCode: 'CONTEXT_REFERENCE_INVALID',
      safeStoryboardFallback: false,
      selectedReferences: [],
      rationale: '镜头明确提到的已锁定道具/场景图已失效，请刷新或重新锁定。',
    }
  }
  if (persistedSelection) {
    if (persistedSelection.status !== 'ready') {
      return {
        ...base,
        status: 'manual_required',
        reasonCode: persistedSelection.status === 'invalid'
          ? 'PERSISTED_VISION_SELECTION_INVALID'
          : assessment.identitySensitive
            ? 'IDENTITY_REFERENCE_REQUIRED'
            : 'STORYBOARD_FALLBACK_UNSAFE',
        safeStoryboardFallback: false,
        selectedReferences: [],
        rationale: persistedSelection.rationale,
      }
    }
    return {
      ...base,
      status: 'ready',
      reasonCode: 'REFERENCE_PLAN_READY',
      safeStoryboardFallback: persistedSelection.safeStoryboardFallback,
      selectedReferences: persistedSelection.selectedReferences,
      rationale: persistedSelection.rationale,
    }
  }
  if (recommendation.status === 'manual_required') {
    const fallbackAllowed = assessment.allowStoryboardFallback && !assessment.identitySensitive
    if (!fallbackAllowed || !storyboardAnchorAssetId) {
      return {
        ...base,
        status: 'manual_required',
        reasonCode: assessment.identitySensitive
          ? 'IDENTITY_REFERENCE_REQUIRED'
          : 'STORYBOARD_FALLBACK_UNSAFE',
        safeStoryboardFallback: false,
        selectedReferences: [],
        rationale: storyboardAnchorAssetId
          ? assessment.rationale
          : `${assessment.rationale}当前也没有可验证的同镜分镜图。`,
      }
    }
    return {
      ...base,
      status: 'ready',
      reasonCode: 'REFERENCE_PLAN_READY',
      safeStoryboardFallback: true,
      // A conservative fallback intentionally ignores contextual multi-image
      // expansion: the current Shot storyboard is the sole composition truth.
      selectedReferences: [{ assetId: storyboardAnchorAssetId, role: 'first_frame' }],
      rationale: assessment.rationale,
    }
  }

  if (assessment.source === 'persisted_vision'
    && assessment.identitySensitive
    && recommendation.status !== 'recommended') {
    return {
      ...base,
      status: 'manual_required',
      reasonCode: 'IDENTITY_REFERENCE_REQUIRED',
      safeStoryboardFallback: false,
      selectedReferences: [],
      rationale: assessment.rationale,
    }
  }

  if (assessment.allowStoryboardFallback
    && storyboardAnchorAssetId
    && (assessment.storyboardOnlyFallback
      || contextPins.every((pin) => pin.entityType === 'location'))) {
    return {
      ...base,
      status: 'ready',
      reasonCode: 'REFERENCE_PLAN_READY',
      safeStoryboardFallback: true,
      // The current storyboard already contains the wide-shot location
      // composition. Re-adding its location lock would unnecessarily turn a
      // safe first-frame guide into multi-reference mode.
      selectedReferences: [{ assetId: storyboardAnchorAssetId, role: 'first_frame' }],
      rationale: assessment.rationale,
    }
  }

  const sourceOrderedIds = [
    ...(storyboardAnchorAssetId ? [storyboardAnchorAssetId] : []),
    ...recommendation.references.map((reference) => reference.assetId),
    ...contextPins.map((pin) => pin.assetId),
  ].filter((assetId, index, values) => values.indexOf(assetId) === index)
  // View slots decide which side of a character the shot needs, but Seedance
  // receives the complete same-source turnaround sheet as the identity fact.
  // The storyboard remains first and owns composition. This also avoids
  // sending three independent-looking people when multiple view crops belong
  // to one character sheet.
  const wholeTurnaroundAssetIds = new Set<string>()
  const orderedIds = sourceOrderedIds
    .map((assetId) => {
      const turnaround = shotVideoWholeTurnaroundReferenceAsset(database, {
        projectId: target.projectId,
        episodeId: target.episodeId,
        sourceRevisionId: target.sourceRevisionId,
        characterViewAssetId: assetId,
      })
      if (!turnaround) return assetId
      wholeTurnaroundAssetIds.add(turnaround.id)
      return turnaround.id
    })
    .filter((assetId, index, values) => values.indexOf(assetId) === index)
  if (orderedIds.length > MAX_SHOT_VIDEO_REFERENCE_IMAGES) {
    return {
      ...base,
      status: 'manual_required',
      reasonCode: 'REFERENCE_IMAGE_LIMIT_EXCEEDED',
      safeStoryboardFallback: false,
      selectedReferences: [],
      rationale: `当前同镜分镜、角色槽位与明确场景/道具共需要 ${orderedIds.length} 张参考图，超过 Seedance ${MAX_SHOT_VIDEO_REFERENCE_IMAGES} 张上限。`,
    }
  }
  const onlyStoryboard = orderedIds.length === 1 && orderedIds[0] === storyboardAnchorAssetId
  return {
    ...base,
    status: 'ready',
    reasonCode: 'REFERENCE_PLAN_READY',
    safeStoryboardFallback: onlyStoryboard,
    selectedReferences: orderedIds.map((assetId) => ({
      assetId,
      role: onlyStoryboard ? 'first_frame' : 'reference_image',
    })),
    rationale: orderedIds.length === 0
      ? '当前镜头没有可安全自动绑定的参考图。'
      : onlyStoryboard
        ? '仅使用当前同镜分镜图作首帧引导。'
        : wholeTurnaroundAssetIds.size > 0
          ? `已按稳定顺序组合同镜分镜、${wholeTurnaroundAssetIds.size} 张同源整张三视图与 ${contextPins.length} 张明确道具/场景锁定图；角色槽位只用于视角判断和审计。`
          : `已按稳定顺序组合同镜分镜、角色槽位与 ${contextPins.length} 张明确道具/场景锁定图。`,
  }
}
