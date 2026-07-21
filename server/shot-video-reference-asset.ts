import type { ManjuDatabase, MediaAssetRecord } from './database.js'

export type EligibleShotVideoReferenceAsset = MediaAssetRecord & {
  checksum: string
  sourceRevisionId: string
}

export type ShotVideoReferenceAssetEligibility =
  | { status: 'eligible'; asset: EligibleShotVideoReferenceAsset }
  | { status: 'unavailable' }
  | { status: 'invalid_dimensions' }

export const SEEDANCE_REFERENCE_IMAGE_CONSTRAINTS = Object.freeze({
  minimumEdgePixels: 300,
  maximumEdgePixels: 6_000,
  minimumAspectRatioExclusive: 0.4,
  maximumAspectRatioExclusive: 2.5,
})

export interface ShotVideoReferenceAssetCompatibilityIssue {
  assetId: string
  role: 'first_frame' | 'last_frame' | 'reference_image'
  kind: string
  width: number | null
  height: number | null
  aspectRatio: number | null
  character: {
    id: string
    name: string
    view: 'front' | 'side' | 'back'
  } | null
  turnaroundSource: {
    assetId: string
    width: number
    height: number
    aspectRatio: number
  } | null
  constraints: typeof SEEDANCE_REFERENCE_IMAGE_CONSTRAINTS
}

/**
 * Public-safe, project-scoped explanation for a rejected Seedance image. The
 * optional parent is exposed only for a real character-view derivative whose
 * complete turnaround sheet is itself eligible in the same immutable scope.
 */
export function shotVideoReferenceAssetCompatibilityIssue(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string
    sourceRevisionId: string
    assetId: string
    role: ShotVideoReferenceAssetCompatibilityIssue['role']
  },
): ShotVideoReferenceAssetCompatibilityIssue | null {
  const asset = database.getMediaAsset(input.assetId)
  if (!asset
    || asset.projectId !== input.projectId
    || asset.episodeId !== input.episodeId
    || asset.sourceRevisionId !== input.sourceRevisionId) return null
  const width = Number.isInteger(asset.width) ? asset.width : null
  const height = Number.isInteger(asset.height) ? asset.height : null
  const aspectRatio = width !== null && height !== null ? width / height : null
  const characterRow = database.withSql((sql) => sql.get(`
    SELECT characters.id, characters.name, character_visual_references.role
    FROM character_visual_references
    JOIN characters ON characters.id = character_visual_references.character_id
    WHERE character_visual_references.project_id = ?
      AND character_visual_references.episode_id = ?
      AND character_visual_references.asset_id = ?
    LIMIT 1
  `, input.projectId, input.episodeId, input.assetId))
  const character = characterRow
    && typeof characterRow.id === 'string'
    && typeof characterRow.name === 'string'
    && ['front', 'side', 'back'].includes(String(characterRow.role))
    ? {
        id: characterRow.id,
        name: characterRow.name,
        view: characterRow.role as 'front' | 'side' | 'back',
      }
    : null
  const isTurnaroundChild = character !== null
    && asset.parentAssetId !== null
    && asset.generationParameters.operation === 'asset.image.turnaround.derive'
    && asset.generationParameters.orientation === character.view
  const parentEligibility = isTurnaroundChild
    ? shotVideoReferenceAssetEligibility(database, {
        projectId: input.projectId,
        episodeId: input.episodeId,
        sourceRevisionId: input.sourceRevisionId,
        assetId: asset.parentAssetId!,
      })
    : null
  const parent = parentEligibility?.status === 'eligible'
    && parentEligibility.asset.kind === 'character-turnaround'
    && parentEligibility.asset.width !== null
    && parentEligibility.asset.height !== null
    ? parentEligibility.asset
    : null
  return {
    assetId: asset.id,
    role: input.role,
    kind: asset.kind,
    width,
    height,
    aspectRatio,
    character,
    turnaroundSource: parent ? {
      assetId: parent.id,
      width: parent.width!,
      height: parent.height!,
      aspectRatio: parent.width! / parent.height!,
    } : null,
    constraints: SEEDANCE_REFERENCE_IMAGE_CONSTRAINTS,
  }
}

/**
 * Single non-billable eligibility predicate for every Seedance image-reference
 * path. Unknown dimensions are allowed and will be verified when bytes are
 * opened; known dimensions must already satisfy the Provider envelope.
 */
export function shotVideoReferenceAssetEligibility(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string
    sourceRevisionId: string
    assetId: string
  },
): ShotVideoReferenceAssetEligibility {
  const asset = database.getMediaAsset(input.assetId)
  const mimeType = asset?.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!asset
    || asset.projectId !== input.projectId
    || asset.episodeId !== input.episodeId
    || asset.status !== 'ready'
    || !['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(mimeType)
    || asset.sourceRevisionId !== input.sourceRevisionId
    || !Number.isInteger(asset.version)
    || asset.version < 1
    || typeof asset.checksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(asset.checksum)) {
    return { status: 'unavailable' }
  }
  if ((asset.width !== null && (!Number.isInteger(asset.width)
      || asset.width < SEEDANCE_REFERENCE_IMAGE_CONSTRAINTS.minimumEdgePixels
      || asset.width > SEEDANCE_REFERENCE_IMAGE_CONSTRAINTS.maximumEdgePixels))
    || (asset.height !== null && (!Number.isInteger(asset.height)
      || asset.height < SEEDANCE_REFERENCE_IMAGE_CONSTRAINTS.minimumEdgePixels
      || asset.height > SEEDANCE_REFERENCE_IMAGE_CONSTRAINTS.maximumEdgePixels))
    || (asset.width !== null && asset.height !== null
      && (asset.width / asset.height <= SEEDANCE_REFERENCE_IMAGE_CONSTRAINTS.minimumAspectRatioExclusive
        || asset.width / asset.height >= SEEDANCE_REFERENCE_IMAGE_CONSTRAINTS.maximumAspectRatioExclusive))) {
    return { status: 'invalid_dimensions' }
  }
  return { status: 'eligible', asset: asset as EligibleShotVideoReferenceAsset }
}

/**
 * Resolve a locked, locally-derived front/side/back slot back to the complete
 * turnaround sheet used to derive it. The slot remains the authoritative
 * camera-view decision and audit pin, but the complete sheet is the safer
 * Seedance identity reference: sending a crop can make the Provider treat the
 * crop as composition rather than as a multi-angle character definition.
 *
 * This deliberately fails closed. Arbitrary parentAssetId relationships are
 * not enough: the child must be the current role slot, carry the local
 * turnaround derivation provenance, and the parent must be an eligible
 * character-turnaround in the same immutable episode/revision scope.
 */
export function shotVideoWholeTurnaroundReferenceAsset(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string
    sourceRevisionId: string
    characterViewAssetId: string
  },
): EligibleShotVideoReferenceAsset | null {
  const child = database.getMediaAsset(input.characterViewAssetId)
  const orientation = String(child?.generationParameters.orientation ?? '')
  if (!child
    || child.projectId !== input.projectId
    || child.episodeId !== input.episodeId
    || child.sourceRevisionId !== input.sourceRevisionId
    || child.status !== 'ready'
    || child.parentAssetId === null
    || child.generationParameters.operation !== 'asset.image.turnaround.derive'
    || !['front', 'side', 'back'].includes(orientation)) return null

  const currentSlot = database.withSql((sql) => sql.get(`
    SELECT 1 AS valid
    FROM character_visual_references
    JOIN characters ON characters.id = character_visual_references.character_id
    WHERE character_visual_references.project_id = ?
      AND character_visual_references.episode_id = ?
      AND character_visual_references.asset_id = ?
      AND character_visual_references.role = ?
      AND characters.project_id = ?
      AND characters.episode_id = ?
    LIMIT 1
  `,
  input.projectId,
  input.episodeId,
  input.characterViewAssetId,
  orientation,
  input.projectId,
  input.episodeId,
  ))
  if (currentSlot?.valid !== 1) return null

  const parent = shotVideoReferenceAssetEligibility(database, {
    projectId: input.projectId,
    episodeId: input.episodeId,
    sourceRevisionId: input.sourceRevisionId,
    assetId: child.parentAssetId,
  })
  return parent.status === 'eligible' && parent.asset.kind === 'character-turnaround'
    ? parent.asset
    : null
}
