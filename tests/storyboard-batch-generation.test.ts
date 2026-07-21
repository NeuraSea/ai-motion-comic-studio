import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getMissingStoryboardShotIds,
  getReadyStoryboardShotCount,
  getRegeneratableStoryboardShotIds,
  type StoryboardBatchShot,
} from '../src/features/storyboard/batch-generation'

const shots: StoryboardBatchShot[] = [
  { id: 1, status: '已通过', assetId: 'asset-approved' },
  { id: 2, status: '待审核', assetId: 'asset-review' },
  { id: 3, status: '失败', assetId: 'asset-previous-version' },
  { id: 4, status: '待生成' },
  { id: 5, status: '失败' },
  { id: 6, status: '生成中' },
]

test('safe fill only targets shots without a current asset', () => {
  assert.deepEqual(getMissingStoryboardShotIds(shots), [4, 5])
})

test('safe fill preserves an older usable asset after a failed replacement', () => {
  assert.equal(getMissingStoryboardShotIds(shots).includes(3), false)
  assert.equal(getReadyStoryboardShotCount(shots), 3)
})

test('explicit regeneration targets every non-running shot', () => {
  assert.deepEqual(getRegeneratableStoryboardShotIds(shots), [1, 2, 3, 4, 5])
})
