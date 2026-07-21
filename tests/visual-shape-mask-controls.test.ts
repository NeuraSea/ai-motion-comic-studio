import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileRenderSemanticVisualShapeMask,
  createOpenCutCommandEditor,
  type EditorSceneTracks,
} from '../apps/opencut-editor/src/index.js'
import {
  buildVisualShapeMasks,
  DEFAULT_VISUAL_SHAPE_MASK_ID,
  readVisualShapeMaskDraft,
} from '../src/features/editor/visual-shape-mask.js'

function tracks(): EditorSceneTracks {
  return {
    overlay: [],
    main: {
      id: 'main', name: 'main', type: 'video', hidden: false, muted: false,
      elements: [{
        id: 'shot', type: 'image', mediaId: 'asset', name: 'shot',
        startTime: 0, duration: 240_000, trimStart: 0, trimEnd: 0, params: {},
      }],
    },
    audio: [],
  }
}

const draft = {
  enabled: true,
  maskId: DEFAULT_VISUAL_SHAPE_MASK_ID,
  type: 'ellipse' as const,
  inverted: false,
  centerX: 0.12,
  centerY: -0.08,
  width: 0.52,
  height: 0.64,
}

test('shape-mask control writes one atomic OpenCut masks update and undo/redo restores it', () => {
  const editor = createOpenCutCommandEditor({ tracks: tracks() })
  const before = editor.getTracks()
  const masks = buildVisualShapeMasks(draft)
  editor.commitElementPropertyUpdates({
    updates: [{ trackId: 'main', elementId: 'shot', patch: { masks } }],
  })
  const updated = editor.getTracks().main.elements[0]!
  assert.deepEqual(updated.masks, masks)
  assert.deepEqual(compileRenderSemanticVisualShapeMask({ masks: updated.masks }), {
    version: 2,
    type: 'ellipse',
    inverted: false,
    centerX: 0.12,
    centerY: -0.08,
    width: 0.52,
    height: 0.64,
  })
  assert.deepEqual(readVisualShapeMaskDraft(updated), {
    editable: true,
    draft,
  })

  editor.undo()
  assert.deepEqual(editor.getTracks(), before)
  editor.redo()
  assert.deepEqual(readVisualShapeMaskDraft(editor.getTracks().main.elements[0]!), {
    editable: true,
    draft,
  })

  editor.commitElementPropertyUpdates({
    updates: [{ trackId: 'main', elementId: 'shot', patch: { masks: [] } }],
  })
  assert.equal(readVisualShapeMaskDraft(editor.getTracks().main.elements[0]!).editable, true)
  assert.equal(editor.getTracks().main.elements[0]!.masks?.length, 0)
})

test('shape-mask control persists the audited inverse flag without changing geometry', () => {
  const masks = buildVisualShapeMasks({ ...draft, inverted: true })
  assert.deepEqual(compileRenderSemanticVisualShapeMask({ masks }), {
    version: 2,
    type: 'ellipse',
    inverted: true,
    centerX: 0.12,
    centerY: -0.08,
    width: 0.52,
    height: 0.64,
  })
  assert.deepEqual(readVisualShapeMaskDraft({ masks }), {
    editable: true,
    draft: { ...draft, inverted: true },
  })
})

test('control refuses unknown masks and short-video fill instead of overwriting them', () => {
  assert.equal(readVisualShapeMaskDraft({
    masks: [{ id: 'future', type: 'heart', params: {} }],
  }).editable, false)
  assert.equal(readVisualShapeMaskDraft({
    manju: { shortVideoFill: { future: true } },
  }).editable, false)
  assert.throws(() => buildVisualShapeMasks({ ...draft, width: Number.NaN }))
  assert.throws(() => buildVisualShapeMasks({ ...draft, centerX: 2 }))
})
