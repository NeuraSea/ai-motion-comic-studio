import type {
  CharacterVisualReferenceView,
  ShotVideoManualCharacterSlotSelector,
} from '../../lib'

export interface ShotVideoManualSlotOption {
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

export interface ShotVideoManualReferenceRecovery {
  version: 1
  shotId: string
  sceneId: string
  sourceRevisionId: string
  reasonCode:
    | 'VIEW_SELECTION_REQUIRED'
    | 'REFERENCE_IMAGE_LIMIT_EXCEEDED'
    | 'RELATED_CHARACTER_LIMIT_EXCEEDED'
    | 'SLOT_SELECTION_STALE'
  maximumReferenceImages: 9
  slotSelectionAllowed: boolean
  characters: Array<{
    characterId: string
    characterName: string
    rationale: string
    slots: ShotVideoManualSlotOption[]
  }>
}

const RECOVERY_REASONS = [
  'VIEW_SELECTION_REQUIRED',
  'REFERENCE_IMAGE_LIMIT_EXCEEDED',
  'RELATED_CHARACTER_LIMIT_EXCEEDED',
  'SLOT_SELECTION_STALE',
] as const

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}

function slot(value: unknown, sourceRevisionId: string): value is ShotVideoManualSlotOption {
  return record(value)
    && nonEmpty(value.characterId)
    && nonEmpty(value.characterName)
    && ['front', 'side', 'back'].includes(String(value.view))
    && nonEmpty(value.assetId)
    && Number.isInteger(value.assetVersion) && (value.assetVersion as number) >= 1
    && typeof value.assetChecksum === 'string' && /^[a-f0-9]{64}$/.test(value.assetChecksum)
    && value.assetSourceRevisionId === sourceRevisionId
    && Number.isInteger(value.slotVersion) && (value.slotVersion as number) >= 1
    && nonEmpty(value.slotAuditRevisionId)
}

function parseRecoveryCandidate(candidate: unknown): ShotVideoManualReferenceRecovery | null {
  if (!record(candidate) || !record(candidate.manualSelection)) return null
  const value = candidate.manualSelection
  const policy = record(value.selectionPolicy) ? value.selectionPolicy : null
  const maximumReferenceImages = candidate.maximumReferenceImages ?? policy?.maximumReferences ?? 9
  const slotSelectionAllowed = candidate.slotSelectionAllowed ?? policy?.slotSelectionAllowed
    ?? (Array.isArray(value.characters) && value.characters.length <= 9)
  const reasonCode = RECOVERY_REASONS.includes(candidate.reasonCode as typeof RECOVERY_REASONS[number])
    ? candidate.reasonCode as ShotVideoManualReferenceRecovery['reasonCode']
    : 'VIEW_SELECTION_REQUIRED'
  if (value.version !== 1
    || !nonEmpty(value.shotId)
    || !nonEmpty(value.sceneId)
    || !nonEmpty(value.sourceRevisionId)
    || !Array.isArray(value.characters)
    || value.characters.length < 1
    || value.characters.length > 64
    || maximumReferenceImages !== 9
    || typeof slotSelectionAllowed !== 'boolean'
    || (value.characters.length > maximumReferenceImages && slotSelectionAllowed)) return null
  const characters = value.characters.flatMap((character) => {
    if (!record(character)
      || !nonEmpty(character.characterId)
      || !nonEmpty(character.characterName)
      || !nonEmpty(character.rationale)
      || !Array.isArray(character.slots)
      || character.slots.length > 3
      || !character.slots.every((candidate) => slot(candidate, value.sourceRevisionId as string))) return []
    return [{
      characterId: character.characterId,
      characterName: character.characterName,
      rationale: character.rationale,
      slots: character.slots as ShotVideoManualSlotOption[],
    }]
  })
  if (characters.length !== value.characters.length) return null
  return {
    version: 1,
    shotId: value.shotId,
    sceneId: value.sceneId,
    sourceRevisionId: value.sourceRevisionId,
    reasonCode,
    maximumReferenceImages: 9,
    slotSelectionAllowed,
    characters,
  }
}

/** Parses every unresolved shot returned by one aggregate 409 preflight. */
export function parseShotVideoManualReferenceRecoveries(
  details: unknown,
): ShotVideoManualReferenceRecovery[] {
  if (!record(details)) return []
  const candidates = Array.isArray(details.unresolvedShots)
    ? details.version === 1 && details.unresolvedShots.length >= 1 && details.unresolvedShots.length <= 24
      ? details.unresolvedShots
      : []
    : [details]
  const recoveries = candidates.flatMap((candidate) => {
    const recovery = parseRecoveryCandidate(candidate)
    return recovery ? [recovery] : []
  })
  if (recoveries.length !== candidates.length) return []
  const keys = recoveries.map((recovery) => `${recovery.sceneId}\u0000${recovery.shotId}`)
  return new Set(keys).size === keys.length ? recoveries : []
}

/** Backward-compatible first-shot parser for one-shot call sites. */
export function parseShotVideoManualReferenceRecovery(
  details: unknown,
): ShotVideoManualReferenceRecovery | null {
  return parseShotVideoManualReferenceRecoveries(details)[0] ?? null
}

export function missingManualSlotAssetIds(
  recovery: ShotVideoManualReferenceRecovery,
  eligibleAssetIds: ReadonlySet<string>,
): string[] {
  return [...new Set(recovery.characters.flatMap((character) => (
    character.slots
      .filter((slot) => !eligibleAssetIds.has(slot.assetId))
      .map((slot) => slot.assetId)
  )))]
}

/**
 * Produces the existing strict batch DTO from slot cards. Asset IDs never
 * become text input: they originate only in parsed server evidence.
 */
export function selectorsForManualSlotChoices(
  recovery: ShotVideoManualReferenceRecovery,
  choices: Readonly<Record<string, CharacterVisualReferenceView>>,
): ShotVideoManualCharacterSlotSelector[] | null {
  if (!recovery.slotSelectionAllowed) return null
  const selectors: ShotVideoManualCharacterSlotSelector[] = []
  for (const character of recovery.characters) {
    const view = choices[character.characterId]
    const selected = character.slots.find((candidate) => candidate.view === view)
    if (!selected) return null
    selectors.push({ characterId: character.characterId, view: selected.view })
  }
  return selectors.length > 0 ? selectors : null
}
