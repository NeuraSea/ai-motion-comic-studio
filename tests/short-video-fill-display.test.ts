import assert from 'node:assert/strict'
import test from 'node:test'

import type { EditorTimelineElement } from '@manju/opencut-editor'
import { readAppliedShortVideoFillDisplay } from '../src/features/editor/short-video-fill-display'

const SOURCE_DURATION = 72_000
const TARGET_DURATION = 120_000
const PLAN_HASH = 'a'.repeat(64)

function appliedVideo(): EditorTimelineElement {
  return {
    id: 'short-video-1',
    type: 'video',
    name: '短视频',
    startTime: 0,
    duration: TARGET_DURATION,
    trimStart: 0,
    trimEnd: 0,
    sourceDuration: SOURCE_DURATION,
    mediaId: 'short-video-asset',
    params: {
      storySceneId: 'scene-1',
      storyShotId: 'shot-1',
      sourceRevisionId: 'story-revision-1',
    },
    manju: {
      shortVideoFill: {
        version: 1,
        strategy: 'same-shot-locked-image-hold-v1',
        fallbackAssetId: 'storyboard-asset-1',
        storySceneId: 'scene-1',
        storyShotId: 'shot-1',
        sourceRevisionId: 'story-revision-1',
        sourceDurationTicks: SOURCE_DURATION,
        targetDurationTicks: TARGET_DURATION,
        appliedByOpenCut: true,
        appliedPlanHash: PLAN_HASH,
      },
    },
  }
}

test('exposes the visible tail only for an applied current OpenCut fill', () => {
  assert.deepEqual(readAppliedShortVideoFillDisplay(appliedVideo()), {
    fallbackAssetId: 'storyboard-asset-1',
    sourceDurationTicks: SOURCE_DURATION,
    targetDurationTicks: TARGET_DURATION,
    holdDurationTicks: 48_000,
    holdStartPercent: 60,
    holdWidthPercent: 40,
    appliedPlanHash: PLAN_HASH,
  })
})

test('does not advertise a pending fill as applied', () => {
  const element = appliedVideo()
  const fill = element.manju?.shortVideoFill as Record<string, unknown>
  fill.appliedByOpenCut = false
  fill.appliedPlanHash = null
  element.duration = SOURCE_DURATION

  assert.equal(readAppliedShortVideoFillDisplay(element), null)
})

test('hides stale applied metadata after timing, source or trim changes', () => {
  const changedDuration = appliedVideo()
  changedDuration.duration -= 1
  assert.equal(readAppliedShortVideoFillDisplay(changedDuration), null)

  const changedSource = appliedVideo()
  changedSource.sourceDuration = SOURCE_DURATION + 1
  assert.equal(readAppliedShortVideoFillDisplay(changedSource), null)

  const trimmed = appliedVideo()
  trimmed.trimStart = 1
  assert.equal(readAppliedShortVideoFillDisplay(trimmed), null)
})

test('hides metadata that belongs to a different Story entity or revision', () => {
  for (const key of ['storySceneId', 'storyShotId', 'sourceRevisionId'] as const) {
    const element = appliedVideo()
    element.params = { ...element.params, [key]: 'different' }
    assert.equal(readAppliedShortVideoFillDisplay(element), null, key)
  }
})

test('malformed or unsupported short-video metadata never escapes into React rendering', () => {
  const malformed = appliedVideo()
  malformed.manju = {
    shortVideoFill: {
      version: 1,
      appliedByOpenCut: true,
    },
  }
  assert.doesNotThrow(() => readAppliedShortVideoFillDisplay(malformed))
  assert.equal(readAppliedShortVideoFillDisplay(malformed), null)

  const image = appliedVideo() as EditorTimelineElement
  Object.assign(image, { type: 'image' })
  assert.equal(readAppliedShortVideoFillDisplay(image), null)
})
