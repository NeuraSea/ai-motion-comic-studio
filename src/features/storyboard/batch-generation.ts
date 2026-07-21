export type StoryboardBatchShot = Readonly<{
  id: number
  status: '已通过' | '待审核' | '生成中' | '待生成' | '失败'
  assetId?: string
}>

function hasCurrentAsset(shot: StoryboardBatchShot) {
  return typeof shot.assetId === 'string' && shot.assetId.trim().length > 0
}

/**
 * Safe default for batch generation. A failed replacement can still have a
 * usable previous asset, so status alone must never make it a fill target.
 */
export function getMissingStoryboardShotIds(shots: readonly StoryboardBatchShot[]) {
  return shots
    .filter((shot) => shot.status !== '生成中' && !hasCurrentAsset(shot))
    .map((shot) => shot.id)
}

/** Explicit replacement mode. Active jobs are excluded to prevent duplicates. */
export function getRegeneratableStoryboardShotIds(shots: readonly StoryboardBatchShot[]) {
  return shots
    .filter((shot) => shot.status !== '生成中')
    .map((shot) => shot.id)
}

export function getReadyStoryboardShotCount(shots: readonly StoryboardBatchShot[]) {
  return shots.filter(hasCurrentAsset).length
}
