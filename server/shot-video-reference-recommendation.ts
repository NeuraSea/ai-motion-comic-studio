import type { ManjuDatabase } from './database.js'
import { shotVideoReferenceAssetEligibility } from './shot-video-reference-asset.js'

export const SHOT_VIDEO_REFERENCE_RECOMMENDATION_VERSION = 1 as const
export const SHOT_VIDEO_REFERENCE_RECOMMENDATION_POLICY = 'deterministic-character-view-v1' as const

export type CharacterVisualReferenceView = 'front' | 'side' | 'back'
export type ShotVideoReferenceRecommendationStatus =
  | 'recommended'
  | 'manual_required'
  | 'not_applicable'

export interface CharacterViewDirectionDecision {
  status: 'recommended' | 'manual_required' | 'not_required'
  view: CharacterVisualReferenceView | null
  confidence: number | null
  reasonCode:
    | 'explicit_front'
    | 'explicit_side'
    | 'explicit_back'
    | 'facial_detail'
    | 'lateral_action'
    | 'dialogue_portrait'
    | 'insert_detail_not_required'
    | 'peripheral_distant_identity_anchor'
    | 'conflicting_direction_cues'
    | 'insufficient_direction_evidence'
    | 'distant_character_not_required'
  rationale: string
}

export interface ShotVideoCharacterReferenceRecommendation {
  characterId: string
  characterName: string
  status: 'recommended' | 'manual_required'
  view: CharacterVisualReferenceView | null
  confidence: number | null
  rationale: string
  assetId: string | null
  assetVersion: number | null
  assetChecksum: string | null
  assetSourceRevisionId: string | null
  slotVersion: number | null
  slotAuditRevisionId: string | null
}

export interface ShotVideoReferenceRecommendation {
  version: typeof SHOT_VIDEO_REFERENCE_RECOMMENDATION_VERSION
  policy: typeof SHOT_VIDEO_REFERENCE_RECOMMENDATION_POLICY
  status: ShotVideoReferenceRecommendationStatus
  shotId: string
  sceneId: string
  sourceRevisionId: string
  confidence: number | null
  rationale: string
  characters: ShotVideoCharacterReferenceRecommendation[]
  references: Array<{ assetId: string; role: 'reference_image' }>
}

export interface ShotVideoReferenceDecision {
  version: 1
  /** Legacy name means server-authored, not necessarily an LLM invocation. */
  source: 'agentic_auto' | 'manual_override'
  /** Explicitly distinguishes the deterministic safety net from real visual analysis. */
  automaticPolicy?: 'deterministic_safety' | 'persisted_vision'
  /** Present only when automaticPolicy is backed by a succeeded durable vision Job. */
  visionAnalysisJobId?: string
  /**
   * How the final paid-request references were resolved. Optional only for
   * backward compatibility with decisions persisted before this audit field
   * existed.
   */
  resolution?: 'character_views' | 'storyboard_anchor' | 'not_applicable' | 'manual_override'
  recommendation: ShotVideoReferenceRecommendation
  /** Current Shot pointer observed while the automatic decision was authored. */
  storyboardAnchorAssetId: string | null
  /** Final roles sent to Seedance after merging the current-shot storyboard anchor. */
  selectedReferences: Array<{
    assetId: string
    role: 'first_frame' | 'last_frame' | 'reference_image'
  }>
  /**
   * Present when a manual UI choice came from a real character role slot.
   * Generic advanced Asset overrides remain supported without this field.
   */
  manualCharacterSlotPins?: ShotVideoManualCharacterSlotPin[]
}

export interface ShotVideoManualCharacterSlotPin {
  characterId: string
  characterName: string
  view: CharacterVisualReferenceView
  assetId: string
  assetVersion: number
  assetChecksum: string
  assetSourceRevisionId: string
  slotVersion: number
  slotAuditRevisionId: string
}

export interface ShotVideoManualReferenceOptions {
  version: 1
  shotId: string
  sceneId: string
  sourceRevisionId: string
  selectionPolicy: {
    maximumReferences: 9
    slotSelectionAllowed: boolean
    reason: 'all_relevant_characters_required' | 'related_character_limit_exceeded'
  }
  characters: Array<{
    characterId: string
    characterName: string
    rationale: string
    slots: ShotVideoManualCharacterSlotPin[]
  }>
}

export interface ShotVideoManualCharacterSlotSelector {
  characterId: string
  view: CharacterVisualReferenceView
}

export interface ShotReferenceRecommendationTarget {
  publicShotId: string
  publicSceneId: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  subjectNames?: readonly string[]
  scene?: string
  action?: string
  shotSize?: string
  cameraMovement?: string
  prompt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

/** Strict durable JSON guard; recommendation provenance is part of the paid request audit. */
export function isShotVideoReferenceDecision(value: unknown): value is ShotVideoReferenceDecision {
  if (!isRecord(value)
    || !exactKeys(value, [
      'version', 'source', 'resolution', 'recommendation', 'storyboardAnchorAssetId', 'selectedReferences',
      'automaticPolicy', 'visionAnalysisJobId', 'manualCharacterSlotPins',
    ])
    || value.version !== 1
    || (value.source !== 'agentic_auto' && value.source !== 'manual_override')
    || (value.automaticPolicy !== undefined
      && value.automaticPolicy !== 'deterministic_safety'
      && value.automaticPolicy !== 'persisted_vision')
    || (value.visionAnalysisJobId !== undefined
      && (typeof value.visionAnalysisJobId !== 'string'
        || value.visionAnalysisJobId.length < 1
        || value.visionAnalysisJobId.length > 256))
    || (value.resolution !== undefined
      && !['character_views', 'storyboard_anchor', 'not_applicable', 'manual_override'].includes(String(value.resolution)))
    || (value.storyboardAnchorAssetId !== null
      && (typeof value.storyboardAnchorAssetId !== 'string' || !value.storyboardAnchorAssetId))
    || !Array.isArray(value.selectedReferences)
    || value.selectedReferences.length > 9
    || !value.selectedReferences.every((reference) => isRecord(reference)
      && exactKeys(reference, ['assetId', 'role'])
      && typeof reference.assetId === 'string'
      && Boolean(reference.assetId)
      && ['first_frame', 'last_frame', 'reference_image'].includes(String(reference.role)))
    || !isRecord(value.recommendation)) return false
  if (value.source === 'manual_override'
    && (value.automaticPolicy !== undefined || value.visionAnalysisJobId !== undefined)) return false
  if (value.automaticPolicy === 'persisted_vision' && value.visionAnalysisJobId === undefined) return false
  if (value.visionAnalysisJobId !== undefined && value.automaticPolicy !== 'persisted_vision') return false
  const selectedReferences = value.selectedReferences as unknown[]
  if (value.manualCharacterSlotPins !== undefined) {
    if (value.source !== 'manual_override'
      || !Array.isArray(value.manualCharacterSlotPins)
      || value.manualCharacterSlotPins.length < 1
      || value.manualCharacterSlotPins.length > 9
      || !value.manualCharacterSlotPins.every((pin) => isManualCharacterSlotPin(pin))) return false
    const ids = value.manualCharacterSlotPins.map((pin) => (pin as ShotVideoManualCharacterSlotPin).assetId)
    if (new Set(ids).size !== ids.length
      || ids.some((assetId) => !selectedReferences.some((reference: unknown) => (
        isRecord(reference)
        && reference.assetId === assetId
        && reference.role === 'reference_image'
      )))) return false
  }
  if (value.resolution === 'manual_override' && value.source !== 'manual_override') return false
  if (value.resolution !== undefined
    && value.resolution !== 'manual_override'
    && value.source !== 'agentic_auto') return false
  if (value.resolution === 'storyboard_anchor'
    && (value.storyboardAnchorAssetId === null
      || value.selectedReferences.length !== 1
      || value.selectedReferences[0]?.assetId !== value.storyboardAnchorAssetId
      || value.selectedReferences[0]?.role !== 'first_frame')) return false
  const recommendation = value.recommendation
  if (!exactKeys(recommendation, [
    'version',
    'policy',
    'status',
    'shotId',
    'sceneId',
    'sourceRevisionId',
    'confidence',
    'rationale',
    'characters',
    'references',
  ])
    || recommendation.version !== SHOT_VIDEO_REFERENCE_RECOMMENDATION_VERSION
    || recommendation.policy !== SHOT_VIDEO_REFERENCE_RECOMMENDATION_POLICY
    || !['recommended', 'manual_required', 'not_applicable'].includes(String(recommendation.status))
    || typeof recommendation.shotId !== 'string' || !recommendation.shotId
    || typeof recommendation.sceneId !== 'string' || !recommendation.sceneId
    || typeof recommendation.sourceRevisionId !== 'string' || !recommendation.sourceRevisionId
    || (recommendation.confidence !== null
      && (typeof recommendation.confidence !== 'number'
        || !Number.isFinite(recommendation.confidence)
        || recommendation.confidence < 0
        || recommendation.confidence > 1))
    || typeof recommendation.rationale !== 'string' || !recommendation.rationale
    || !Array.isArray(recommendation.characters)
    || recommendation.characters.length > 64
    || !Array.isArray(recommendation.references)
    || recommendation.references.length > 9) return false
  const characterIds = new Set<string>()
  for (const character of recommendation.characters) {
    if (!isRecord(character)
      || !exactKeys(character, [
        'characterId',
        'characterName',
        'status',
        'view',
        'confidence',
        'rationale',
        'assetId',
        'assetVersion',
        'assetChecksum',
        'assetSourceRevisionId',
        'slotVersion',
        'slotAuditRevisionId',
      ])
      || typeof character.characterId !== 'string' || !character.characterId
      || characterIds.has(character.characterId)
      || typeof character.characterName !== 'string' || !character.characterName
      || (character.status !== 'recommended' && character.status !== 'manual_required')
      || (character.view !== null && !['front', 'side', 'back'].includes(String(character.view)))
      || (character.confidence !== null
        && (typeof character.confidence !== 'number'
          || !Number.isFinite(character.confidence)
          || character.confidence < 0
          || character.confidence > 1))
      || typeof character.rationale !== 'string' || !character.rationale) return false
    characterIds.add(character.characterId)
    const pinned = character.assetId !== null
    if (pinned !== (character.status === 'recommended')
      || (pinned && (typeof character.assetId !== 'string'
        || !character.assetId
        || !Number.isInteger(character.assetVersion)
        || (character.assetVersion as number) < 1
        || typeof character.assetChecksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(character.assetChecksum)
        || typeof character.assetSourceRevisionId !== 'string'
        || character.assetSourceRevisionId !== recommendation.sourceRevisionId
        || !Number.isInteger(character.slotVersion)
        || (character.slotVersion as number) < 1
        || typeof character.slotAuditRevisionId !== 'string'
        || !character.slotAuditRevisionId
        || character.view === null
        || character.confidence === null))
      || (!pinned && (character.assetVersion !== null
        || character.assetChecksum !== null
        || character.assetSourceRevisionId !== null
        || character.slotVersion !== null
        || character.slotAuditRevisionId !== null))) return false
  }
  if (!recommendation.references.every((reference) => isRecord(reference)
    && exactKeys(reference, ['assetId', 'role'])
    && typeof reference.assetId === 'string'
    && Boolean(reference.assetId)
    && reference.role === 'reference_image')) return false
  const pinnedIds = recommendation.characters
    .filter((character) => isRecord(character) && character.status === 'recommended')
    .map((character) => character.assetId)
  const referenceIds = recommendation.references.map((reference) => (reference as Record<string, unknown>).assetId)
  if (recommendation.status === 'recommended') {
    if (recommendation.characters.length < 1
      || recommendation.characters.some((character) => (character as Record<string, unknown>).status !== 'recommended')
      || recommendation.confidence === null
      || pinnedIds.length !== referenceIds.length
      || pinnedIds.some((assetId, index) => assetId !== referenceIds[index])) return false
  } else if (recommendation.references.length !== 0 || recommendation.confidence !== null) {
    return false
  }
  return recommendation.status !== 'not_applicable' || recommendation.characters.length === 0
}

function isManualCharacterSlotPin(value: unknown): value is ShotVideoManualCharacterSlotPin {
  return isRecord(value)
    && exactKeys(value, [
      'characterId',
      'characterName',
      'view',
      'assetId',
      'assetVersion',
      'assetChecksum',
      'assetSourceRevisionId',
      'slotVersion',
      'slotAuditRevisionId',
    ])
    && typeof value.characterId === 'string' && Boolean(value.characterId)
    && typeof value.characterName === 'string' && Boolean(value.characterName)
    && ['front', 'side', 'back'].includes(String(value.view))
    && typeof value.assetId === 'string' && Boolean(value.assetId)
    && Number.isInteger(value.assetVersion) && (value.assetVersion as number) >= 1
    && typeof value.assetChecksum === 'string' && /^[a-f0-9]{64}$/.test(value.assetChecksum)
    && typeof value.assetSourceRevisionId === 'string' && Boolean(value.assetSourceRevisionId)
    && Number.isInteger(value.slotVersion) && (value.slotVersion as number) >= 1
    && typeof value.slotAuditRevisionId === 'string' && Boolean(value.slotAuditRevisionId)
}

/** Strict reusable guard for server-authored character-slot provenance. */
export function isShotVideoReferenceRecommendation(
  value: unknown,
): value is ShotVideoReferenceRecommendation {
  if (!isRecord(value)) return false
  const references = Array.isArray(value.references) ? value.references : []
  const status = value.status
  return isShotVideoReferenceDecision({
    version: 1,
    source: 'agentic_auto',
    resolution: status === 'recommended' ? 'character_views' : 'not_applicable',
    recommendation: value,
    storyboardAnchorAssetId: null,
    selectedReferences: status === 'recommended' ? references : [],
  })
}

interface CharacterReferenceRow {
  characterId: string
  characterName: string
  databaseCharacterId: string
  role: CharacterVisualReferenceView | null
  assetId: string | null
  assetVersion: number | null
  assetChecksum: string | null
  assetSourceRevisionId: string | null
  assetMimeType: string | null
  assetStatus: string | null
  slotVersion: number | null
  slotAuditRevisionId: string | null
}

const FRONT_EXPLICIT = /(?:正脸|正面(?:面向|对着|朝向)?|面向镜头|直视镜头|看向镜头|front[ -]?(?:view|facing)|facing (?:the )?camera)/iu
const SIDE_EXPLICIT = /(?:侧脸|侧面|侧身|侧影|三分之二侧|profile|side[ -]?view|from the side)/iu
const BACK_EXPLICIT = /(?:背影|背对(?:镜头|画面|观众)|后脑|背部视角|rear[ -]?view|back[ -]?view|from behind)/iu
const CLOSE_SHOT = /(?:大特写|特写|近景|肖像|close[ -]?up|extreme close|portrait)/iu
const FACIAL_ACTION = /(?:表情|眼神|眼睛|面部|脸|凝视|含泪|微笑|怒视|facial|expression|eyes?|gaze)/iu
const MEDIUM_SHOT = /(?:中近景|中景|半身|medium[ -]?(?:shot|close)|waist)/iu
const DIALOGUE_ACTION = /(?:说道?|开口|喊|问|回答|对话|交谈|speaks?|says?|asks?|dialogue|conversation)/iu
const LATERAL_ACTION = /(?:横移|横向|侧向|沿.+(?:走|跑)|跑过|走过|奔跑|行走|lateral|sideways|tracking|walks?|runs?|sprints?)/iu
const DISTANT_FRAMING = /(?:超远景|大全景|远景|extreme[ -]wide|very wide|long shot|establishing shot)/iu
const AERIAL_FRAMING = /(?:高空|航拍|鸟瞰|俯瞰|aerial|bird[' -]?s[ -]?eye)/iu
const DISTANT_SUBJECT = /(?:小小(?:的)?(?:身影|人影|剪影|人物|角色)|小人(?:物)?|小剪影|远处(?:的)?(?:小人(?:物)?|剪影)|tiny (?:figure|silhouette|character)|distant silhouette)/iu
const IDENTITY_DETAIL_REQUIRED = /(?:(?:必须|需要|要求|清晰|明确|看清|辨认).{0,12}(?:服饰|服装|衣着|造型|发饰|头饰|徽记|徽章|纹样|武器|身份特征|角色特征)|(?:服饰|服装|衣着|造型|发饰|头饰|徽记|徽章|纹样|武器|身份特征|角色特征).{0,12}(?:必须|需要|要求|清晰|明确|看清|辨认)|(?:clearly|must|recognizable).{0,24}(?:costume|outfit|hairstyle|emblem|insignia|weapon|identity detail))/iu
const INSERT_DETAIL = /(?:手部|手掌|掌心|手指|指尖|手腕|袖口|衣角|脚步|足部|令牌|徽记|剑柄|剑格|道具|物件|物体|insert shot|detail shot|hands?|palm|fingers?|wrist|sleeve|prop|object)/iu
const PERIPHERAL_DISTANT_SUBJECT = /(?:左下角|右下角|左上角|右上角|画面(?:一侧|边缘|角落)|前景(?:一侧|边缘)|只露出|仅露出|衣角|袖口|红绳边缘|lower[- ]?(?:left|right)|edge of (?:the )?frame|corner of (?:the )?frame|partially visible)/iu

function compact(value: string | undefined): string {
  return (value ?? '').replace(/[\t\r\n ]+/g, ' ').trim()
}

function roundedConfidence(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Conservative, inspectable view classifier. Explicit camera-relative words
 * win; contradictory explicit words never get guessed through. Lower-signal
 * framing/action rules are deliberately bounded and explain their inference.
 */
export function recommendCharacterReferenceView(input: {
  shotSize?: string
  cameraMovement?: string
  action?: string
  prompt?: string
  hasDialogueSubject?: boolean
}): CharacterViewDirectionDecision {
  const text = compact([
    input.shotSize,
    input.cameraMovement,
    input.action,
    input.prompt,
  ].filter(Boolean).join(' '))
  const explicit = [
    FRONT_EXPLICIT.test(text) ? 'front' : null,
    SIDE_EXPLICIT.test(text) ? 'side' : null,
    BACK_EXPLICIT.test(text) ? 'back' : null,
  ].filter((view): view is CharacterVisualReferenceView => view !== null)
  if (explicit.length > 1) {
    return {
      status: 'manual_required',
      view: null,
      confidence: null,
      reasonCode: 'conflicting_direction_cues',
      rationale: `镜头文本同时包含${explicit.map((view) => ({ front: '正面', side: '侧面', back: '背面' })[view]).join('、')}视角证据，需人工确认。`,
    }
  }
  if (explicit.length === 1) {
    const view = explicit[0]
    const label = { front: '正面', side: '侧面', back: '背面' }[view]
    return {
      status: 'recommended',
      view,
      confidence: view === 'back' ? 0.98 : 0.96,
      reasonCode: `explicit_${view}` as CharacterViewDirectionDecision['reasonCode'],
      rationale: `镜头文本明确指定${label}视角。`,
    }
  }
  if (CLOSE_SHOT.test(text)
    && INSERT_DETAIL.test(text)
    && !FACIAL_ACTION.test(text)
    && !DIALOGUE_ACTION.test(text)) {
    return {
      status: 'not_required',
      view: null,
      confidence: null,
      reasonCode: 'insert_detail_not_required',
      rationale: 'insert_detail_not_required：镜头聚焦手部或道具细节且不呈现脸部，不强制绑定正/侧/背角色槽位。',
    }
  }
  if ((DISTANT_FRAMING.test(text) || AERIAL_FRAMING.test(text))
    && DISTANT_SUBJECT.test(text)
    && !FACIAL_ACTION.test(text)
    && !DIALOGUE_ACTION.test(text)
    && !IDENTITY_DETAIL_REQUIRED.test(text)
    && input.hasDialogueSubject !== true) {
    return {
      status: 'not_required',
      view: null,
      confidence: null,
      reasonCode: 'distant_character_not_required',
      rationale: 'distant_character_not_required：远景/高空建立镜头中角色只是剪影或远处小人，不需要强制选择正/侧/背槽位。',
    }
  }
  if ((DISTANT_FRAMING.test(text) || AERIAL_FRAMING.test(text))
    && PERIPHERAL_DISTANT_SUBJECT.test(text)
    && !FACIAL_ACTION.test(text)
    && !DIALOGUE_ACTION.test(text)
    && !IDENTITY_DETAIL_REQUIRED.test(text)
    && input.hasDialogueSubject !== true) {
    return {
      status: 'recommended',
      view: 'front',
      confidence: 0.64,
      reasonCode: 'peripheral_distant_identity_anchor',
      rationale: '角色位于大全景边缘且不展示脸部，正面槽位仅作为身份与服饰锚点；最终朝向仍由镜头 Prompt 决定。',
    }
  }
  if (CLOSE_SHOT.test(text) && FACIAL_ACTION.test(text)) {
    return {
      status: 'recommended',
      view: 'front',
      confidence: 0.84,
      reasonCode: 'facial_detail',
      rationale: '近景/特写聚焦面部或眼神，正面设定最能保留可识别特征。',
    }
  }
  if (LATERAL_ACTION.test(text)) {
    return {
      status: 'recommended',
      view: 'side',
      confidence: 0.76,
      reasonCode: 'lateral_action',
      rationale: '动作或运镜呈现明确横向运动，侧面设定更适合固定轮廓。',
    }
  }
  if (input.hasDialogueSubject === true && (CLOSE_SHOT.test(text) || MEDIUM_SHOT.test(text) || DIALOGUE_ACTION.test(text))) {
    return {
      status: 'recommended',
      view: 'front',
      confidence: 0.72,
      reasonCode: 'dialogue_portrait',
      rationale: '当前是中近景对话主体，使用正面设定优先保持脸部身份一致。',
    }
  }
  return {
    status: 'manual_required',
    view: null,
    confidence: null,
    reasonCode: 'insufficient_direction_evidence',
    rationale: '镜头中没有足够的正/侧/背视角证据，不会猜测角色参考图。',
  }
}

function stringValue(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

function nullableNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function characterRows(
  database: ManjuDatabase,
  target: ShotReferenceRecommendationTarget,
): CharacterReferenceRow[] {
  return database.withSql((sql) => sql.all(`
    SELECT
      characters.id AS database_character_id,
      CASE
        WHEN typeof(json_extract(characters.metadata_json, '$.storyId')) = 'text'
          AND length(trim(json_extract(characters.metadata_json, '$.storyId'))) > 0
        THEN json_extract(characters.metadata_json, '$.storyId')
        ELSE characters.id
      END AS public_character_id,
      characters.name AS character_name,
      character_visual_references.role,
      character_visual_references.asset_id,
      character_visual_references.version AS slot_version,
      character_visual_references.audit_revision_id AS slot_audit_revision_id,
      media_assets.version AS asset_version,
      media_assets.checksum AS asset_checksum,
      media_assets.source_revision_id AS asset_source_revision_id,
      media_assets.mime_type AS asset_mime_type,
      media_assets.status AS asset_status
    FROM characters
    LEFT JOIN character_visual_references
      ON character_visual_references.character_id = characters.id
     AND character_visual_references.project_id = characters.project_id
     AND character_visual_references.episode_id = characters.episode_id
    LEFT JOIN media_assets
      ON media_assets.id = character_visual_references.asset_id
     AND media_assets.project_id = characters.project_id
     AND media_assets.episode_id = characters.episode_id
    WHERE characters.project_id = ? AND characters.episode_id = ?
    ORDER BY characters.id,
      CASE character_visual_references.role WHEN 'front' THEN 1 WHEN 'side' THEN 2 WHEN 'back' THEN 3 ELSE 4 END
  `, target.projectId, target.episodeId)).map((row) => ({
    databaseCharacterId: stringValue(row, 'database_character_id'),
    characterId: stringValue(row, 'public_character_id'),
    characterName: stringValue(row, 'character_name'),
    role: ['front', 'side', 'back'].includes(stringValue(row, 'role'))
      ? stringValue(row, 'role') as CharacterVisualReferenceView
      : null,
    assetId: nullableString(row, 'asset_id'),
    assetVersion: nullableNumber(row, 'asset_version'),
    assetChecksum: nullableString(row, 'asset_checksum'),
    assetSourceRevisionId: nullableString(row, 'asset_source_revision_id'),
    assetMimeType: nullableString(row, 'asset_mime_type'),
    assetStatus: nullableString(row, 'asset_status'),
    slotVersion: nullableNumber(row, 'slot_version'),
    slotAuditRevisionId: nullableString(row, 'slot_audit_revision_id'),
  }))
}

function isCurrentImageSlot(row: CharacterReferenceRow, sourceRevisionId: string): boolean {
  return Boolean(row.role
    && row.assetId
    && row.assetStatus === 'ready'
    && row.assetVersion !== null
    && row.assetVersion >= 1
    && row.assetChecksum
    && /^[a-f0-9]{64}$/.test(row.assetChecksum)
    && row.assetSourceRevisionId === sourceRevisionId
    && row.assetMimeType
    && ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(row.assetMimeType.split(';', 1)[0].trim().toLowerCase())
    && row.slotVersion !== null
    && row.slotVersion >= 1
    && row.slotAuditRevisionId)
}

/** Resolve only current Episode role slots; primary locks and arbitrary Assets are never fallback candidates. */
export function resolveShotVideoReferenceRecommendation(
  database: ManjuDatabase,
  target: ShotReferenceRecommendationTarget,
): ShotVideoReferenceRecommendation {
  const rows = characterRows(database, target)
  const groups = new Map<string, CharacterReferenceRow[]>()
  for (const row of rows) {
    const group = groups.get(row.databaseCharacterId) ?? []
    group.push(row)
    groups.set(row.databaseCharacterId, group)
  }
  const namedText = compact([target.action, target.prompt, target.scene].filter(Boolean).join(' ')).toLocaleLowerCase()
  const subjectNames = new Set((target.subjectNames ?? []).map((name) => compact(name).toLocaleLowerCase()))
  const relevant = [...groups.values()].filter((group) => {
    const name = compact(group[0]?.characterName).toLocaleLowerCase()
    return Boolean(name && (subjectNames.has(name) || namedText.includes(name)))
  })
  if (relevant.length === 0) {
    return {
      version: SHOT_VIDEO_REFERENCE_RECOMMENDATION_VERSION,
      policy: SHOT_VIDEO_REFERENCE_RECOMMENDATION_POLICY,
      status: 'not_applicable',
      shotId: target.publicShotId,
      sceneId: target.publicSceneId,
      sourceRevisionId: target.sourceRevisionId,
      confidence: null,
      rationale: '镜头未明确关联当前分集的角色，不自动添加角色参考图。',
      characters: [],
      references: [],
    }
  }
  const direction = recommendCharacterReferenceView({
    shotSize: target.shotSize,
    cameraMovement: target.cameraMovement,
    action: target.action,
    prompt: target.prompt,
    hasDialogueSubject: relevant.some((group) => subjectNames.has(compact(group[0]?.characterName).toLocaleLowerCase())),
  })
  if (direction.status === 'not_required') {
    return {
      version: SHOT_VIDEO_REFERENCE_RECOMMENDATION_VERSION,
      policy: SHOT_VIDEO_REFERENCE_RECOMMENDATION_POLICY,
      status: 'not_applicable',
      shotId: target.publicShotId,
      sceneId: target.publicSceneId,
      sourceRevisionId: target.sourceRevisionId,
      confidence: null,
      rationale: direction.rationale,
      characters: [],
      references: [],
    }
  }
  const characters = relevant.map((group): ShotVideoCharacterReferenceRecommendation => {
    const identity = group[0]
    if (direction.status === 'manual_required' || !direction.view) {
      return {
        characterId: identity.characterId,
        characterName: identity.characterName,
        status: 'manual_required',
        view: null,
        confidence: null,
        rationale: direction.rationale,
        assetId: null,
        assetVersion: null,
        assetChecksum: null,
        assetSourceRevisionId: null,
        slotVersion: null,
        slotAuditRevisionId: null,
      }
    }
    const slot = group.find((row) => row.role === direction.view && isCurrentImageSlot(row, target.sourceRevisionId))
    if (!slot) {
      const viewLabel = { front: '正面', side: '侧面', back: '背面' }[direction.view]
      return {
        characterId: identity.characterId,
        characterName: identity.characterName,
        status: 'manual_required',
        view: direction.view,
        confidence: direction.confidence,
        rationale: `${direction.rationale}但角色当前没有可验证的${viewLabel}槽位 Asset，不会使用其他图片冒充。`,
        assetId: null,
        assetVersion: null,
        assetChecksum: null,
        assetSourceRevisionId: null,
        slotVersion: null,
        slotAuditRevisionId: null,
      }
    }
    return {
      characterId: identity.characterId,
      characterName: identity.characterName,
      status: 'recommended',
      view: direction.view,
      confidence: direction.confidence,
      rationale: direction.rationale,
      assetId: slot.assetId,
      assetVersion: slot.assetVersion,
      assetChecksum: slot.assetChecksum,
      assetSourceRevisionId: slot.assetSourceRevisionId,
      slotVersion: slot.slotVersion,
      slotAuditRevisionId: slot.slotAuditRevisionId,
    }
  })
  const manual = characters.some((character) => character.status === 'manual_required')
    || characters.length > 9
  if (manual) {
    return {
      version: SHOT_VIDEO_REFERENCE_RECOMMENDATION_VERSION,
      policy: SHOT_VIDEO_REFERENCE_RECOMMENDATION_POLICY,
      status: 'manual_required',
      shotId: target.publicShotId,
      sceneId: target.publicSceneId,
      sourceRevisionId: target.sourceRevisionId,
      confidence: null,
      rationale: characters.length > 9
        ? '镜头明确角色超过 Seedance 9 张参考图上限，需人工决定主体优先级。'
        : '至少一个角色的视角或真实三视图槽位无法安全确定，需人工选择。',
      characters,
      references: [],
    }
  }
  const selected = characters.filter((character): character is ShotVideoCharacterReferenceRecommendation & {
    assetId: string
    confidence: number
  } => character.assetId !== null && character.confidence !== null)
  return {
    version: SHOT_VIDEO_REFERENCE_RECOMMENDATION_VERSION,
    policy: SHOT_VIDEO_REFERENCE_RECOMMENDATION_POLICY,
    status: 'recommended',
    shotId: target.publicShotId,
    sceneId: target.publicSceneId,
    sourceRevisionId: target.sourceRevisionId,
    confidence: roundedConfidence(Math.min(...selected.map((character) => character.confidence))),
    rationale: `已按镜头视角为 ${selected.length} 个明确角色选择当前锁定的真实三视图槽位。`,
    characters,
    references: selected.map((character) => ({
      assetId: character.assetId,
      role: 'reference_image',
    })),
  }
}

function slotPin(row: CharacterReferenceRow): ShotVideoManualCharacterSlotPin | null {
  if (!row.role || !row.assetId || row.assetVersion === null || !row.assetChecksum
    || !row.assetSourceRevisionId || row.slotVersion === null || !row.slotAuditRevisionId) return null
  return {
    characterId: row.characterId,
    characterName: row.characterName,
    view: row.role,
    assetId: row.assetId,
    assetVersion: row.assetVersion,
    assetChecksum: row.assetChecksum,
    assetSourceRevisionId: row.assetSourceRevisionId,
    slotVersion: row.slotVersion,
    slotAuditRevisionId: row.slotAuditRevisionId,
  }
}

/**
 * Non-billable manual recovery choices for an otherwise ambiguous shot. Only
 * current front/side/back role slots are exposed; primary turnarounds and
 * arbitrary project Assets are deliberately absent.
 */
export function resolveShotVideoManualReferenceOptions(
  database: ManjuDatabase,
  target: ShotReferenceRecommendationTarget,
  recommendation: ShotVideoReferenceRecommendation = resolveShotVideoReferenceRecommendation(database, target),
): ShotVideoManualReferenceOptions {
  const relevantIds = new Set(recommendation.characters.map((character) => character.characterId))
  const groups = new Map<string, CharacterReferenceRow[]>()
  for (const row of characterRows(database, target)) {
    if (!relevantIds.has(row.characterId)) continue
    const group = groups.get(row.characterId) ?? []
    group.push(row)
    groups.set(row.characterId, group)
  }
  return {
    version: 1,
    shotId: target.publicShotId,
    sceneId: target.publicSceneId,
    sourceRevisionId: target.sourceRevisionId,
    selectionPolicy: {
      maximumReferences: 9,
      slotSelectionAllowed: recommendation.characters.length <= 9,
      reason: recommendation.characters.length > 9
        ? 'related_character_limit_exceeded'
        : 'all_relevant_characters_required',
    },
    characters: recommendation.characters.map((character) => ({
      characterId: character.characterId,
      characterName: character.characterName,
      rationale: character.rationale,
      slots: (groups.get(character.characterId) ?? [])
        .filter((row) => isCurrentImageSlot(row, target.sourceRevisionId))
        .map(slotPin)
        .filter((pin): pin is ShotVideoManualCharacterSlotPin => pin !== null),
    })),
  }
}

/** Resolve provenance pins for IDs selected through the safe slot UI. */
export function resolveManualCharacterSlotPins(
  database: ManjuDatabase,
  target: ShotReferenceRecommendationTarget,
  recommendation: ShotVideoReferenceRecommendation,
  selectedReferences: readonly { assetId: string; role: string }[],
): ShotVideoManualCharacterSlotPin[] {
  const options = resolveShotVideoManualReferenceOptions(database, target, recommendation)
  const candidates = options.characters.flatMap((character) => character.slots)
  return selectedReferences.flatMap((reference) => {
    if (reference.role !== 'reference_image') return []
    const matches = candidates.filter((candidate) => candidate.assetId === reference.assetId)
    return matches.length === 1 ? [matches[0]] : []
  })
}

export function resolveManualCharacterSlotSelectors(
  database: ManjuDatabase,
  target: ShotReferenceRecommendationTarget,
  recommendation: ShotVideoReferenceRecommendation,
  selectors: readonly ShotVideoManualCharacterSlotSelector[],
): ShotVideoManualCharacterSlotPin[] | null {
  const options = resolveShotVideoManualReferenceOptions(database, target, recommendation)
  if (selectors.length !== options.characters.length
    || new Set(selectors.map((selector) => selector.characterId)).size !== selectors.length) return null
  const pins: ShotVideoManualCharacterSlotPin[] = []
  for (const character of options.characters) {
    const selector = selectors.find((candidate) => candidate.characterId === character.characterId)
    if (!selector) return null
    const pin = character.slots.find((candidate) => candidate.view === selector.view)
    if (!pin) return null
    pins.push(pin)
  }
  return pins.length > 0 ? pins : null
}

export function validateCurrentAgenticReferenceDecision(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string
    sourceRevisionId: string
    databaseShotId: string
    decision: ShotVideoReferenceDecision
  },
): boolean {
  if (input.decision.source === 'manual_override') {
    const pins = input.decision.manualCharacterSlotPins
    if (!pins) return true
    return pins.every((pin) => currentCharacterSlotMatches(database, input, pin))
  }
  const recommendation = input.decision.recommendation
  if (recommendation.sourceRevisionId !== input.sourceRevisionId) return false
  const shot = database.withSql((sql) => sql.get(`
    SELECT shots.storyboard_asset_id
    FROM shots
    JOIN scenes ON scenes.id = shots.scene_id
    JOIN episodes ON episodes.id = scenes.episode_id
    WHERE shots.id = ?
      AND episodes.project_id = ?
      AND episodes.id = ?
      AND shots.source_revision_id = ?
  `,
  input.databaseShotId,
  input.projectId,
  input.episodeId,
  input.sourceRevisionId,
  ))
  if (!shot) return false
  const rawStoryboardAssetId = shot.storyboard_asset_id
  if (rawStoryboardAssetId !== null && typeof rawStoryboardAssetId !== 'string') return false
  const currentStoryboardAnchorAssetId = rawStoryboardAssetId === null
    ? null
    : (() => {
        const eligibility = shotVideoReferenceAssetEligibility(database, {
          projectId: input.projectId,
          episodeId: input.episodeId,
          sourceRevisionId: input.sourceRevisionId,
          assetId: rawStoryboardAssetId,
        })
        return eligibility.status === 'eligible' ? eligibility.asset.id : null
      })()
  if (currentStoryboardAnchorAssetId !== input.decision.storyboardAnchorAssetId) return false
  if (input.decision.storyboardAnchorAssetId !== null
    && !input.decision.selectedReferences.some((reference) => (
      reference.assetId === input.decision.storyboardAnchorAssetId
    ))) return false
  return recommendation.characters
    .filter((character) => character.status === 'recommended')
    .every((character) => {
      if (!character.view || !character.assetId || character.slotVersion === null || !character.slotAuditRevisionId) return false
      return currentCharacterSlotMatches(database, input, {
        characterId: character.characterId,
        characterName: character.characterName,
        view: character.view,
        assetId: character.assetId,
        assetVersion: character.assetVersion as number,
        assetChecksum: character.assetChecksum as string,
        assetSourceRevisionId: character.assetSourceRevisionId as string,
        slotVersion: character.slotVersion,
        slotAuditRevisionId: character.slotAuditRevisionId,
      })
    })
}

function currentCharacterSlotMatches(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string
    sourceRevisionId: string
  },
  pin: ShotVideoManualCharacterSlotPin,
): boolean {
  if (pin.assetSourceRevisionId !== input.sourceRevisionId) return false
  const row = database.withSql((sql) => sql.get(`
    SELECT 1 AS valid
    FROM characters
    JOIN character_visual_references
      ON character_visual_references.character_id = characters.id
    JOIN media_assets
      ON media_assets.id = character_visual_references.asset_id
    WHERE characters.project_id = ?
      AND characters.episode_id = ?
      AND CASE
        WHEN typeof(json_extract(characters.metadata_json, '$.storyId')) = 'text'
          AND length(trim(json_extract(characters.metadata_json, '$.storyId'))) > 0
        THEN json_extract(characters.metadata_json, '$.storyId')
        ELSE characters.id
      END = ?
      AND character_visual_references.role = ?
      AND character_visual_references.asset_id = ?
      AND character_visual_references.version = ?
      AND character_visual_references.audit_revision_id = ?
      AND media_assets.version = ?
      AND media_assets.checksum = ?
      AND media_assets.source_revision_id = ?
      AND media_assets.status = 'ready'
  `,
  input.projectId,
  input.episodeId,
  pin.characterId,
  pin.view,
  pin.assetId,
  pin.slotVersion,
  pin.slotAuditRevisionId,
  pin.assetVersion,
  pin.assetChecksum,
  pin.assetSourceRevisionId,
  ))
  return row?.valid === 1
}
