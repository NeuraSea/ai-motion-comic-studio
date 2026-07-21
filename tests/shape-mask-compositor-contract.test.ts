import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalTimelineDocumentFromTracks,
  compileRenderSemanticPlan,
} from '../apps/opencut-editor/src/index.js'
import { renderTimelineFromSemanticPlan } from '../server/export-render.js'
import {
  browserQuickExportBaseSupport,
  clipCanvasToRenderSemanticShapeMask,
} from '../src/features/editor/browser-quick-export.js'
import {
  renderSemanticInvertedShapeMaskPath,
  renderSemanticShapeMaskClipPath,
} from '../src/features/editor/visual-shape-mask.js'

const capabilities = {
  document: true,
  fetch: true,
  crypto: true,
  createImageBitmap: true,
  videoEncoder: true,
  videoDecoder: true,
  audioEncoder: true,
  audioDecoder: true,
  offlineAudioContext: true,
}

function planWithMask(
  type: 'rectangle' | 'ellipse' = 'ellipse',
  inverted = false,
) {
  const document = canonicalTimelineDocumentFromTracks({
    overlay: [],
    main: {
      id: 'main',
      type: 'video',
      elements: [{
        id: 'shot', type: 'image', mediaId: 'asset', name: 'shot',
        startTime: 0, duration: 120_000, trimStart: 0, trimEnd: 0,
        params: { fit: 'contain' },
        masks: [{
          id: 'shape',
          type,
          params: {
            feather: 0, inverted, strokeColor: '#ffffff',
            strokeWidth: 0, strokeAlign: 'center',
            centerX: 0.1, centerY: -0.2, width: 0.5, height: 0.4,
            rotation: 0, scale: 1,
          },
        }],
      }],
    },
    audio: [],
  }, { frameRate: { numerator: 24, denominator: 1 } })
  return compileRenderSemanticPlan({
    timelineDocument: document,
    timelineDocumentId: 'timeline', timelineRevisionId: 'revision', storyRevisionId: 'story',
    aspectRatio: '16:9',
    assets: [{ assetId: 'asset', version: 1, checksum: 'b'.repeat(64), mediaType: 'image' }],
  })
}

test('preview CSS, Canvas quick export and formal adapter consume the same shape-mask receipt', () => {
  const plan = planWithMask()
  const clip = plan.visualClips[0]!
  assert.equal(renderSemanticShapeMaskClipPath(clip), 'ellipse(25% 20% at 60% 30%)')

  const calls: unknown[][] = []
  const context = {
    canvas: { width: 1_280, height: 720 },
    beginPath: () => calls.push(['beginPath']),
    ellipse: (...args: unknown[]) => calls.push(['ellipse', ...args]),
    rect: (...args: unknown[]) => calls.push(['rect', ...args]),
    clip: () => calls.push(['clip']),
  } as unknown as CanvasRenderingContext2D
  clipCanvasToRenderSemanticShapeMask(context, clip)
  assert.deepEqual(calls, [
    ['beginPath'],
    ['ellipse', 768, 216, 320, 144, 0, 0, Math.PI * 2],
    ['clip'],
  ])

  const formal = renderTimelineFromSemanticPlan({
    plan,
    assetPath: (assetId) => assetId === 'asset' ? '/trusted/asset.png' : undefined,
    kenBurns: false,
  })
  assert.deepEqual(formal.visualClips[0]?.shapeMask, clip.shapeMask)
  assert.deepEqual(browserQuickExportBaseSupport(plan, capabilities), {
    supported: true,
    reason: null,
  })
})

test('rectangle CSS/Canvas geometry and legacy RSP version gates fail closed', () => {
  const plan = planWithMask('rectangle')
  const clip = plan.visualClips[0]!
  assert.equal(
    renderSemanticShapeMaskClipPath(clip),
    'polygon(35% 10%, 85% 10%, 85% 50%, 35% 50%)',
  )
  assert.deepEqual(browserQuickExportBaseSupport({ ...plan, version: 2 }, capabilities), {
    supported: false,
    reason: 'RenderSemanticPlan v2 不能携带形状遮罩语义',
  })
  assert.deepEqual(browserQuickExportBaseSupport({ ...plan, version: 1 }, capabilities), {
    supported: false,
    reason: 'RenderSemanticPlan v1 不能携带形状遮罩语义',
  })
  assert.throws(() => renderTimelineFromSemanticPlan({
    plan: { ...plan, version: 2 },
    assetPath: () => '/trusted/asset.png',
    kenBurns: false,
  }), /v2 不能携带形状遮罩/)
})

test('inverse mask uses one even-odd DOM/Canvas receipt and requires RSP v5', () => {
  const plan = planWithMask('ellipse', true)
  const clip = plan.visualClips[0]!
  assert.equal(clip.shapeMask?.version, 2)
  assert.equal(clip.shapeMask?.inverted, true)
  assert.equal(renderSemanticShapeMaskClipPath(clip), undefined)
  assert.equal(
    renderSemanticInvertedShapeMaskPath(clip),
    'M0 0H1V1H0Z M0.35 0.3A0.25 0.2 0 1 0 0.85 0.3A0.25 0.2 0 1 0 0.35 0.3Z',
  )

  const calls: unknown[][] = []
  const context = {
    canvas: { width: 1_280, height: 720 },
    beginPath: () => calls.push(['beginPath']),
    ellipse: (...args: unknown[]) => calls.push(['ellipse', ...args]),
    rect: (...args: unknown[]) => calls.push(['rect', ...args]),
    clip: (...args: unknown[]) => calls.push(['clip', ...args]),
  } as unknown as CanvasRenderingContext2D
  clipCanvasToRenderSemanticShapeMask(context, clip)
  assert.deepEqual(calls, [
    ['beginPath'],
    ['rect', 0, 0, 1_280, 720],
    ['ellipse', 768, 216, 320, 144, 0, 0, Math.PI * 2],
    ['clip', 'evenodd'],
  ])

  assert.deepEqual(browserQuickExportBaseSupport({ ...plan, version: 4 }, capabilities), {
    supported: false,
    reason: 'RenderSemanticPlan v4 不能携带形状遮罩 v2 语义',
  })
  assert.deepEqual(browserQuickExportBaseSupport(plan, capabilities), {
    supported: true,
    reason: null,
  })
})
