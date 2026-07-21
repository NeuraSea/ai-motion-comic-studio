import type { MediaAsset } from '../../lib/api-types'

function sealedChecksum(value: string | null): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

/**
 * Resolves current-workbench references to exact immutable Asset versions.
 *
 * Historical locks remain visible elsewhere, but must not receive a
 * "本制作使用" badge. In the absence of a unified production Asset Manifest,
 * this helper deliberately fails closed unless the referenced version is
 * locally known, ready, and checksummed. Episode-owned versions must belong to
 * the current Episode and immutable Story revision. Project-level versions
 * (`episodeId === null`) are eligible only when their exact ID is explicitly
 * referenced and their revision is either project-global (`null`) or current.
 */
export function collectCurrentProductionAssetVersionIds(input: {
  projectId: string
  episodeId: string
  sourceRevisionId: string | null
  assets: readonly MediaAsset[]
  referencedAssetVersionIds: readonly (string | null | undefined)[]
}): string[] {
  if (!input.projectId || !input.episodeId || !input.sourceRevisionId) return []

  const eligible = new Set(input.assets.flatMap((asset) => {
    if (asset.projectId !== input.projectId
      || asset.status !== 'ready'
      || !sealedChecksum(asset.checksum)) return []

    const currentEpisodeVersion = asset.episodeId === input.episodeId
      && asset.sourceRevisionId === input.sourceRevisionId
    const explicitProjectVersion = asset.episodeId === null
      && (asset.sourceRevisionId === null || asset.sourceRevisionId === input.sourceRevisionId)
    return currentEpisodeVersion || explicitProjectVersion ? [asset.id] : []
  }))
  const result = new Set<string>()
  for (const assetVersionId of input.referencedAssetVersionIds) {
    if (assetVersionId && eligible.has(assetVersionId)) result.add(assetVersionId)
  }
  return [...result]
}
