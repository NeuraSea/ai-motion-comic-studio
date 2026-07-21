import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalTimelineDocumentFromTracks,
  compileRenderSemanticPlan,
} from '../apps/opencut-editor/src/index.js'
import { renderTimelineFromSemanticPlan } from '../server/export-render.js'
import {
  browserQuickExportBaseSupport,
  browserQuickExportBoundarySignature,
} from '../src/features/editor/browser-quick-export.js'

const FRAME_TICKS = 5_000

function planWithOpacityFade() {
  const key = (id: string, frame: number, value: 0 | 1) => ({
    id,
    time: frame * FRAME_TICKS,
    value,
    segmentToNext: 'linear',
    tangentMode: 'flat',
  })
  const document = canonicalTimelineDocumentFromTracks({
    overlay: [],
    main: {
      id: 'main',
      type: 'video',
      elements: [{
        id: 'shot',
        type: 'image',
        mediaId: 'asset',
        name: 'shot',
        startTime: 0,
        duration: 48 * FRAME_TICKS,
        trimStart: 0,
        trimEnd: 0,
        params: { fit: 'contain' },
        animations: {
          opacity: {
            keys: [
              key('in-0', 0, 0),
              key('in-1', 12, 1),
              key('out-1', 36, 1),
              key('out-0', 48, 0),
            ],
          },
        },
      }],
    },
    audio: [],
  }, { frameRate: { numerator: 24, denominator: 1 } })
  return compileRenderSemanticPlan({
    timelineDocument: document,
    timelineDocumentId: 'timeline',
    timelineRevisionId: 'revision',
    storyRevisionId: 'story',
    aspectRatio: '16:9',
    assets: [{
      assetId: 'asset',
      version: 2,
      checksum: 'b'.repeat(64),
      mediaType: 'image',
    }],
  })
}

test('browser boundary compositor and formal FFmpeg adapter consume the same opacity fade receipt', () => {
  const plan = planWithOpacityFade()
  const samples = JSON.parse(browserQuickExportBoundarySignature(plan)) as Array<{
    frame: number
    visual: Array<{ opacity?: number }>
  }>
  assert.equal(samples.find((sample) => sample.frame === 0)?.visual[0]?.opacity, 0)
  assert.equal(samples.find((sample) => sample.frame === 11)?.visual[0]?.opacity, 0.916667)
  assert.equal(samples.find((sample) => sample.frame === 12)?.visual[0]?.opacity, 1)
  assert.equal(samples.find((sample) => sample.frame === 37)?.visual[0]?.opacity, 0.916667)
  assert.equal(samples.find((sample) => sample.frame === 47)?.visual[0]?.opacity, 0.083333)

  const formal = renderTimelineFromSemanticPlan({
    plan,
    assetPath: (assetId) => assetId === 'asset' ? '/trusted/asset.png' : undefined,
    kenBurns: false,
  })
  assert.deepEqual(formal.visualClips[0]?.opacityFade, plan.visualClips[0]?.opacityFade)

  const legacyWithNewSemantics = { ...plan, version: 1 as const }
  assert.deepEqual(browserQuickExportBaseSupport(legacyWithNewSemantics, {
    document: true,
    fetch: true,
    crypto: true,
    createImageBitmap: true,
    videoEncoder: true,
    videoDecoder: true,
    audioEncoder: true,
    audioDecoder: true,
    offlineAudioContext: true,
  }), {
    supported: false,
    reason: 'RenderSemanticPlan v1 不能携带透明度组合语义',
  })
})
