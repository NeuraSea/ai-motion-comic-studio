import type {
  GenerationJob,
  MediaAsset,
  VisualAssetTargetType,
} from '../../lib/api-types'
import { visualAssetJobBinding } from './visual-asset-job-state'

export type VisualAssetRevisionState = 'current' | 'historical' | 'unversioned'

export interface VisualAssetDisplayCandidate {
  asset: MediaAsset
  job: GenerationJob
  revisionState: VisualAssetRevisionState
  /** Historical/unversioned assets remain visible, but must never be submitted as current references. */
  usableAsCurrentReference: boolean
}

export type CharacterVisualReferenceRole = 'front' | 'side' | 'back'

export interface CharacterVisualReferenceSlotSummary {
  slots: Record<CharacterVisualReferenceRole, {
    assetId: string | null
    state: 'current' | 'historical' | 'missing' | 'invalid'
  }>
  currentCount: number
  historicalCount: number
  missingCount: number
  invalidCount: number
}

const CHARACTER_VISUAL_REFERENCE_ROLES = ['front', 'side', 'back'] as const

function isReadyImage(asset: MediaAsset): boolean {
  return asset.status === 'ready'
    && Boolean(asset.mimeType?.split(';', 1)[0]?.trim().toLowerCase().startsWith('image/'))
    && typeof asset.checksum === 'string'
    && /^[a-f0-9]{64}$/i.test(asset.checksum)
}

export function visualAssetRevisionState(
  asset: Pick<MediaAsset, 'sourceRevisionId'>,
  currentSourceRevisionId: string | null,
): VisualAssetRevisionState {
  if (!asset.sourceRevisionId || !currentSourceRevisionId) return 'unversioned'
  return asset.sourceRevisionId === currentSourceRevisionId ? 'current' : 'historical'
}

/**
 * Builds an honest workbench candidate without erasing paid historical output.
 *
 * The immutable Job binding still has to prove ownership by the selected
 * entity. Revision drift changes the action policy, not whether the thumbnail
 * is allowed to exist in the user's asset history.
 */
export function visualAssetDisplayCandidate(input: {
  asset: MediaAsset
  job: GenerationJob
  projectId: string
  episodeId: string
  targetType: VisualAssetTargetType
  targetId: string
  currentSourceRevisionId: string | null
}): VisualAssetDisplayCandidate | null {
  const { asset, job } = input
  const binding = visualAssetJobBinding(job)
  if (!binding
    || (job.type !== 'asset.image.generate' && job.type !== 'asset.image.edit')
    || job.status !== 'succeeded'
    || binding.entityType !== input.targetType
    || binding.entityId !== input.targetId
    || asset.projectId !== input.projectId
    || asset.episodeId !== input.episodeId
    || job.projectId !== input.projectId
    || job.episodeId !== input.episodeId
    || asset.generationJobId !== job.id
    || !isReadyImage(asset)) return null

  const revisionState = visualAssetRevisionState(asset, input.currentSourceRevisionId)
  return {
    asset,
    job,
    revisionState,
    usableAsCurrentReference: revisionState === 'current'
      && binding.expectedRevisionId === input.currentSourceRevisionId,
  }
}

/**
 * A persisted entity lock remains visible after a Story edit, but only a
 * current-revision ready image is eligible for new generation work.
 */
export function lockedVisualAssetRevisionState(input: {
  lockedAssetId: string | null
  assets: readonly MediaAsset[]
  projectId: string
  episodeId: string
  currentSourceRevisionId: string | null
}): {
  asset: MediaAsset | null
  state: 'current' | 'historical' | 'missing' | 'invalid'
  usableAsCurrentReference: boolean
} {
  if (!input.lockedAssetId) {
    return { asset: null, state: 'missing', usableAsCurrentReference: false }
  }
  const asset = input.assets.find((candidate) => candidate.id === input.lockedAssetId) ?? null
  if (!asset
    || asset.projectId !== input.projectId
    || asset.episodeId !== input.episodeId
    || !isReadyImage(asset)) {
    return { asset, state: 'invalid', usableAsCurrentReference: false }
  }
  const state = visualAssetRevisionState(asset, input.currentSourceRevisionId)
  return {
    asset,
    state: state === 'current' ? 'current' : 'historical',
    usableAsCurrentReference: state === 'current',
  }
}

/**
 * Non-null slot IDs are not enough for Storyboard/Seedance readiness. Each
 * front/side/back Asset must still be current, ready, owned and checksummed.
 */
export function summarizeCharacterVisualReferenceSlots(input: {
  references: {
    frontAssetId: string | null
    sideAssetId: string | null
    backAssetId: string | null
  } | undefined
  assets: readonly MediaAsset[]
  projectId: string
  episodeId: string
  currentSourceRevisionId: string | null
}): CharacterVisualReferenceSlotSummary {
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]))
  const slots = Object.fromEntries(CHARACTER_VISUAL_REFERENCE_ROLES.map((role) => {
    const assetId = input.references?.[`${role}AssetId`] ?? null
    if (!assetId) return [role, { assetId: null, state: 'missing' as const }]
    const asset = assetsById.get(assetId)
    if (!asset
      || asset.projectId !== input.projectId
      || asset.episodeId !== input.episodeId
      || asset.kind !== `character-reference.${role}`
      || !isReadyImage(asset)) {
      return [role, { assetId, state: 'invalid' as const }]
    }
    return [role, {
      assetId,
      state: visualAssetRevisionState(asset, input.currentSourceRevisionId) === 'current'
        ? 'current' as const
        : 'historical' as const,
    }]
  })) as CharacterVisualReferenceSlotSummary['slots']

  const states = Object.values(slots).map((slot) => slot.state)
  return {
    slots,
    currentCount: states.filter((state) => state === 'current').length,
    historicalCount: states.filter((state) => state === 'historical').length,
    missingCount: states.filter((state) => state === 'missing').length,
    invalidCount: states.filter((state) => state === 'invalid').length,
  }
}
