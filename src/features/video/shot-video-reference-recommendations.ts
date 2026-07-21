import type { StoryDocument, VisualAssetTarget } from '../../lib'

export type ShotVideoReferenceRecommendations = Record<string, string[]>

export interface ShotVideoReferenceRecommendationDetail {
  assetId: string
  entityType: VisualAssetTarget['type']
  entityId: string
  entityName: string
  sourceLabel: string
  purposeLabel: string
}

export interface SmartShotVideoReferenceInput {
  currentStoryboardAssetId: string | null
  recommendedAssetIds: readonly string[]
  eligibleAssetIds: ReadonlySet<string>
  /** Must describe a visible state transition within this same shot. */
  sameShotStateChange?: boolean
  /** A separately authored keyframe for this shot, never the next storyboard. */
  dedicatedLastFrameAssetId?: string | null
}

export interface SmartShotVideoReferenceDraft {
  mode: 'text-to-video' | 'first-frame' | 'first-last-frame' | 'multi-reference'
  firstFrameAssetId: string
  lastFrameAssetId: string
  referenceAssetIds: string[]
  strategy: 'text-only' | 'current-storyboard' | 'detail-multi-reference' | 'same-shot-transition'
}

const detailsByRecommendation = new WeakMap<readonly string[], readonly ShotVideoReferenceRecommendationDetail[]>()

function pushUnique(
  target: string[],
  details: ShotVideoReferenceRecommendationDetail[],
  visualTarget: VisualAssetTarget | undefined,
): void {
  if (!visualTarget?.lockedAssetId || target.includes(visualTarget.lockedAssetId) || target.length >= 9) return
  target.push(visualTarget.lockedAssetId)
  const sourceLabel = visualTarget.type === 'character'
    ? '已锁定角色设定'
    : visualTarget.type === 'prop'
      ? '已锁定道具设定'
      : '已锁定场景设定'
  const purposeLabel = visualTarget.type === 'character'
    ? '角色外观一致性'
    : visualTarget.type === 'prop'
      ? '道具造型与细节'
      : '场景空间与风格一致性'
  details.push({
    assetId: visualTarget.lockedAssetId,
    entityType: visualTarget.type,
    entityId: visualTarget.id,
    entityName: visualTarget.name,
    sourceLabel,
    purposeLabel,
  })
}

function normalizedShotText(shot: StoryDocument['scenes'][number]['shots'][number]): string {
  return [shot.title, shot.description, shot.framing, shot.visualPrompt]
    .join('\n')
    .toLocaleLowerCase()
}

function isDetailShot(shot: StoryDocument['scenes'][number]['shots'][number], explicitPropCount: number): boolean {
  const value = normalizedShotText(shot)
  return explicitPropCount > 0
    || /(?:特写|大特写|近景|局部|细节|眼神|表情|手部|面部|道具镜头|close[ -]?up|macro|detail)/i.test(value)
}

/**
 * Returns metadata for the exact recommendation array produced below. The
 * array itself remains `string[]`, keeping the existing App handoff backward
 * compatible without smuggling display metadata into the paid API DTO.
 */
export function shotVideoReferenceRecommendationDetails(
  assetIds: readonly string[] | undefined,
): readonly ShotVideoReferenceRecommendationDetail[] {
  return assetIds ? detailsByRecommendation.get(assetIds) ?? [] : []
}

/**
 * Uses only explicit Story entities and immutable visual locks. Ordinary shots
 * intentionally return no auxiliary locks: the dialog will use the current
 * storyboard as a first frame. Locked entities are added only for an explicit
 * character/prop detail shot, where multi-reference materially improves
 * identity and detail consistency.
 */
export function recommendShotVideoReferenceAssetIds(
  story: StoryDocument | null,
  targets: readonly VisualAssetTarget[],
): ShotVideoReferenceRecommendations {
  if (!story) return {}
  const targetByEntity = new Map(targets.map((target) => [`${target.type}:${target.id}`, target]))
  const charactersByName = new Map(story.characters.map((character) => [character.name, character.id]))
  return Object.fromEntries(story.scenes.flatMap((scene) => scene.shots.map((shot) => {
    const references: string[] = []
    const details: ShotVideoReferenceRecommendationDetail[] = []
    const shotText = normalizedShotText(shot)
    const explicitProps = story.props.filter((prop) => shotText.includes(prop.name.toLocaleLowerCase()))
    if (isDetailShot(shot, explicitProps.length)) {
      const speakers = shot.dialogueLines
        .filter((line) => line.kind === 'dialogue')
        .map((line) => charactersByName.get(line.speaker))
        .filter((id): id is string => Boolean(id))
      const namedCharacters = story.characters
        .filter((character) => shotText.includes(character.name.toLocaleLowerCase()))
        .map((character) => character.id)
      for (const characterId of new Set([...speakers, ...namedCharacters])) {
        pushUnique(references, details, targetByEntity.get(`character:${characterId}`))
      }
      for (const prop of explicitProps) {
        pushUnique(references, details, targetByEntity.get(`prop:${prop.id}`))
      }
      pushUnique(references, details, targetByEntity.get(`location:${scene.locationId}`))
    }
    detailsByRecommendation.set(references, details)
    return [shot.id, references] as const
  })))
}

/**
 * Pure local recommendation policy. It has no Provider dependency and never
 * receives a neighbouring shot, making "next storyboard as tail frame"
 * impossible by construction.
 */
export function buildSmartShotVideoReferenceDraft(
  input: SmartShotVideoReferenceInput,
): SmartShotVideoReferenceDraft {
  const firstFrameAssetId = input.currentStoryboardAssetId
    && input.eligibleAssetIds.has(input.currentStoryboardAssetId)
    ? input.currentStoryboardAssetId
    : ''
  const dedicatedLastFrameAssetId = input.dedicatedLastFrameAssetId
    && input.eligibleAssetIds.has(input.dedicatedLastFrameAssetId)
    && input.dedicatedLastFrameAssetId !== firstFrameAssetId
    ? input.dedicatedLastFrameAssetId
    : ''
  if (input.sameShotStateChange === true && firstFrameAssetId && dedicatedLastFrameAssetId) {
    return {
      mode: 'first-last-frame',
      firstFrameAssetId,
      lastFrameAssetId: dedicatedLastFrameAssetId,
      referenceAssetIds: [],
      strategy: 'same-shot-transition',
    }
  }
  const lockedReferences = [...new Set(input.recommendedAssetIds)]
    .filter((assetId) => input.eligibleAssetIds.has(assetId) && assetId !== firstFrameAssetId)
  if (lockedReferences.length > 0) {
    return {
      mode: 'multi-reference',
      firstFrameAssetId,
      lastFrameAssetId: '',
      referenceAssetIds: [
        ...(firstFrameAssetId ? [firstFrameAssetId] : []),
        ...lockedReferences,
      ].slice(0, 9),
      strategy: 'detail-multi-reference',
    }
  }
  if (firstFrameAssetId) {
    return {
      mode: 'first-frame',
      firstFrameAssetId,
      lastFrameAssetId: '',
      referenceAssetIds: [],
      strategy: 'current-storyboard',
    }
  }
  return {
    mode: 'text-to-video',
    firstFrameAssetId: '',
    lastFrameAssetId: '',
    referenceAssetIds: [],
    strategy: 'text-only',
  }
}
