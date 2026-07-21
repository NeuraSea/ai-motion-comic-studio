import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileRenderSemanticVisualOpacityFade,
  createOpenCutCommandEditor,
  OPEN_CUT_TICKS_PER_SECOND,
  type EditorSceneTracks,
} from '../apps/opencut-editor/src/index.js'
import {
  buildVisualOpacityFadeAnimation,
  readVisualOpacityFadeDraft,
  splitFallsInsideVisualOpacityTransition,
} from '../src/features/editor/visual-opacity-fade.js'
import { buildVisualUniformScaleMotionAnimation } from '../src/features/editor/visual-uniform-scale-motion.js'

const FRAME = OPEN_CUT_TICKS_PER_SECOND / 24

function tracks(): EditorSceneTracks {
  return {
    overlay: [],
    main: {
      id: 'main', name: 'main', type: 'video', hidden: false, muted: false,
      elements: [{
        id: 'shot', type: 'image', mediaId: 'asset', name: 'shot',
        startTime: 0, duration: 48 * FRAME, trimStart: 0, trimEnd: 0, params: {},
      }],
    },
    audio: [],
  }
}

test('visual fade control writes one atomic OpenCut animation update and undo restores the element', () => {
  const editor = createOpenCutCommandEditor({ tracks: tracks() })
  const before = editor.getTracks()
  const animations = buildVisualOpacityFadeAnimation({
    durationTicks: 48 * FRAME,
    fadeInFrames: 12,
    fadeOutFrames: 12,
  })
  editor.commitElementPropertyUpdates({
    updates: [{ trackId: 'main', elementId: 'shot', patch: { animations } }],
  })
  const updated = editor.getTracks().main.elements[0]!
  assert.deepEqual(readVisualOpacityFadeDraft(updated), {
    editable: true,
    draft: { fadeInFrames: 12, fadeOutFrames: 12 },
  })
  assert.deepEqual(compileRenderSemanticVisualOpacityFade({
    animations: updated.animations,
    duration: updated.duration,
    ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
  }), {
    version: 1,
    fadeIn: { startFrame: 0, durationFrames: 12 },
    fadeOut: { startFrame: 36, durationFrames: 12 },
  })
  assert.equal(splitFallsInsideVisualOpacityTransition(updated, 6 * FRAME), true)
  assert.equal(splitFallsInsideVisualOpacityTransition(updated, 12 * FRAME), false)
  assert.equal(splitFallsInsideVisualOpacityTransition(updated, 24 * FRAME), false)
  assert.equal(splitFallsInsideVisualOpacityTransition(updated, 42 * FRAME), true)
  editor.undo()
  assert.deepEqual(editor.getTracks(), before)
  editor.redo()
  assert.deepEqual(
    readVisualOpacityFadeDraft(editor.getTracks().main.elements[0]!),
    { editable: true, draft: { fadeInFrames: 12, fadeOutFrames: 12 } },
  )

  const split = editor.splitElements({
    elements: [{ trackId: 'main', elementId: 'shot' }],
    splitTime: 24 * FRAME,
  })
  assert.equal(split.rightSideElements.length, 1)
  const splitElements = editor.getTracks().main.elements
  assert.equal(splitElements.length, 2)
  assert.ok(splitElements.every((element) => readVisualOpacityFadeDraft(element).editable))
})

test('control builder clears safely, validates frame bounds, and refuses unknown or split-fill animation state', () => {
  assert.deepEqual(buildVisualOpacityFadeAnimation({
    durationTicks: 24 * FRAME,
    fadeInFrames: 0,
    fadeOutFrames: 0,
  }), {})
  assert.throws(() => buildVisualOpacityFadeAnimation({
    durationTicks: 24 * FRAME,
    fadeInFrames: 13,
    fadeOutFrames: 12,
  }), RangeError)
  assert.equal(readVisualOpacityFadeDraft({
    duration: 24 * FRAME,
    animations: { 'transform.positionX': { keys: [] } },
  }).editable, false)
  assert.equal(readVisualOpacityFadeDraft({
    duration: 24 * FRAME,
    manju: { shortVideoFill: { future: true } },
  }).editable, false)

  const opaqueNoop = {
    opacity: {
      keys: [
        { id: 'opaque-a', time: 0, value: 1, segmentToNext: 'linear', tangentMode: 'flat' },
        { id: 'opaque-b', time: 24 * FRAME, value: 1, segmentToNext: 'linear', tangentMode: 'flat' },
      ],
    },
  }
  assert.deepEqual(readVisualOpacityFadeDraft({
    duration: 24 * FRAME,
    animations: opaqueNoop,
  }), { editable: true, draft: { fadeInFrames: 0, fadeOutFrames: 0 } })
})

test('opacity replacement preserves audited scale and future channels without making unknown UI editable', () => {
  const scale = buildVisualUniformScaleMotionAnimation({
    durationTicks: 48 * FRAME,
    motion: 'pull-out',
    strength: 8,
  })
  const withOpacity = buildVisualOpacityFadeAnimation({
    animations: scale,
    durationTicks: 48 * FRAME,
    fadeInFrames: 8,
    fadeOutFrames: 0,
  })
  assert.deepEqual(withOpacity['transform.scaleX'], scale['transform.scaleX'])
  assert.deepEqual(withOpacity['transform.scaleY'], scale['transform.scaleY'])
  assert.deepEqual(readVisualOpacityFadeDraft({
    duration: 48 * FRAME,
    animations: withOpacity,
  }), { editable: true, draft: { fadeInFrames: 8, fadeOutFrames: 0 } })

  const cleared = buildVisualOpacityFadeAnimation({
    animations: withOpacity,
    durationTicks: 48 * FRAME,
    fadeInFrames: 0,
    fadeOutFrames: 0,
  })
  assert.equal(cleared.opacity, undefined)
  assert.deepEqual(cleared, scale)

  const futureChannel = { version: 99, opaque: true }
  const future = buildVisualOpacityFadeAnimation({
    animations: { ...scale, 'future.camera': futureChannel },
    durationTicks: 48 * FRAME,
    fadeInFrames: 4,
    fadeOutFrames: 4,
  })
  assert.equal(future['future.camera'], futureChannel)
  const state = readVisualOpacityFadeDraft({ duration: 48 * FRAME, animations: future })
  assert.equal(state.editable, false)
  assert.match(state.editable ? '' : state.reason, /future\.camera/)
})
