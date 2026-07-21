import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileRenderSemanticVisualUniformScaleMotion,
  createOpenCutCommandEditor,
  OPEN_CUT_TICKS_PER_SECOND,
  type EditorSceneTracks,
} from '../apps/opencut-editor/src/index.js'
import { buildVisualOpacityFadeAnimation } from '../src/features/editor/visual-opacity-fade.js'
import {
  buildVisualUniformScaleMotionAnimation,
  readVisualUniformScaleMotionDraft,
} from '../src/features/editor/visual-uniform-scale-motion.js'

const FRAME = OPEN_CUT_TICKS_PER_SECOND / 24

function tracks(animations?: Record<string, unknown>): EditorSceneTracks {
  return {
    overlay: [],
    main: {
      id: 'main', name: 'main', type: 'video', hidden: false, muted: false,
      elements: [{
        id: 'shot', type: 'image', mediaId: 'asset', name: 'shot',
        startTime: 0, duration: 48 * FRAME, trimStart: 0, trimEnd: 0, params: {},
        ...(animations ? { animations } : {}),
      }],
    },
    audio: [],
  }
}

function compileScale(element: EditorSceneTracks['main']['elements'][number]) {
  return compileRenderSemanticVisualUniformScaleMotion({
    animations: element.animations,
    duration: element.duration,
    ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
  })
}

test('uniform-scale control commits synchronized axes as one undoable OpenCut command', () => {
  const opacity = buildVisualOpacityFadeAnimation({
    durationTicks: 48 * FRAME,
    fadeInFrames: 6,
    fadeOutFrames: 6,
  })
  const editor = createOpenCutCommandEditor({ tracks: tracks(opacity) })
  const before = editor.getTracks()
  const animations = buildVisualUniformScaleMotionAnimation({
    animations: before.main.elements[0]!.animations,
    durationTicks: 48 * FRAME,
    motion: 'push-in',
    strength: 8,
  })

  editor.commitElementPropertyUpdates({
    updates: [{ trackId: 'main', elementId: 'shot', patch: { animations } }],
  })
  const updated = editor.getTracks().main.elements[0]!
  assert.deepEqual(compileScale(updated), {
    version: 1,
    startFrame: 0,
    durationFrames: 48,
    fromScale: 1,
    toScale: 1.08,
    anchorX: 0.5,
    anchorY: 0.5,
  })
  assert.deepEqual(readVisualUniformScaleMotionDraft(updated), {
    editable: true,
    draft: { motion: 'push-in', strength: 8 },
  })
  assert.deepEqual(
    (updated.animations?.['transform.scaleX'] as { keys: unknown[] }).keys,
    [
      { id: 'uniform-scale-x-start', time: 0, value: 1, segmentToNext: 'linear', tangentMode: 'flat' },
      { id: 'uniform-scale-x-end', time: 48 * FRAME, value: 1.08, segmentToNext: 'linear', tangentMode: 'flat' },
    ],
  )
  assert.deepEqual(
    (updated.animations?.['transform.scaleY'] as { keys: unknown[] }).keys.map((key) => {
      const { id: _id, ...rest } = key as Record<string, unknown>
      return rest
    }),
    [
      { time: 0, value: 1, segmentToNext: 'linear', tangentMode: 'flat' },
      { time: 48 * FRAME, value: 1.08, segmentToNext: 'linear', tangentMode: 'flat' },
    ],
  )
  assert.deepEqual(
    (updated.animations?.['transform.scaleX'] as { extrapolation: unknown }).extrapolation,
    { before: 'hold', after: 'hold' },
  )
  assert.deepEqual(updated.animations?.opacity, before.main.elements[0]!.animations?.opacity)

  editor.undo()
  assert.deepEqual(editor.getTracks(), before)
  editor.redo()
  assert.deepEqual(readVisualUniformScaleMotionDraft(editor.getTracks().main.elements[0]!), {
    editable: true,
    draft: { motion: 'push-in', strength: 8 },
  })

  const cleared = buildVisualUniformScaleMotionAnimation({
    animations: editor.getTracks().main.elements[0]!.animations,
    durationTicks: 48 * FRAME,
    motion: 'none',
    strength: 8,
  })
  editor.commitElementPropertyUpdates({
    updates: [{ trackId: 'main', elementId: 'shot', patch: { animations: cleared } }],
  })
  const clearedElement = editor.getTracks().main.elements[0]!
  assert.equal(clearedElement.animations?.['transform.scaleX'], undefined)
  assert.equal(clearedElement.animations?.['transform.scaleY'], undefined)
  assert.deepEqual(clearedElement.animations?.opacity, before.main.elements[0]!.animations?.opacity)
  editor.undo()
  assert.deepEqual(compileScale(editor.getTracks().main.elements[0]!), compileScale(updated))
})

test('OpenCut split and resize preserve synchronized whole-frame scale semantics', () => {
  const animations = buildVisualUniformScaleMotionAnimation({
    durationTicks: 48 * FRAME,
    motion: 'push-in',
    strength: 8,
  })

  const splitEditor = createOpenCutCommandEditor({ tracks: tracks(animations) })
  const beforeSplit = splitEditor.getTracks()
  splitEditor.splitElements({
    elements: [{ trackId: 'main', elementId: 'shot' }],
    splitTime: 24 * FRAME,
  })
  const splitElements = splitEditor.getTracks().main.elements
  assert.equal(splitElements.length, 2)
  assert.deepEqual(splitElements.map((element) => compileScale(element)), [
    {
      version: 1, startFrame: 0, durationFrames: 24,
      fromScale: 1, toScale: 1.04, anchorX: 0.5, anchorY: 0.5,
    },
    {
      version: 1, startFrame: 0, durationFrames: 24,
      fromScale: 1.04, toScale: 1.08, anchorX: 0.5, anchorY: 0.5,
    },
  ])
  splitEditor.undo()
  assert.deepEqual(splitEditor.getTracks(), beforeSplit)
  splitEditor.redo()
  assert.equal(splitEditor.getTracks().main.elements.length, 2)

  const resizeEditor = createOpenCutCommandEditor({ tracks: tracks(animations) })
  const beforeResize = resizeEditor.getTracks()
  const resized = resizeEditor.resizeElements({
    elements: [{ trackId: 'main', elementId: 'shot' }],
    side: 'right',
    deltaTime: -24 * FRAME,
    fps: { numerator: 24, denominator: 1 },
  })
  assert.equal(resized?.applied, true)
  const resizedElement = resizeEditor.getTracks().main.elements[0]!
  assert.equal(resizedElement.duration, 24 * FRAME)
  assert.deepEqual(compileScale(resizedElement), {
    version: 1, startFrame: 0, durationFrames: 24,
    fromScale: 1, toScale: 1.04, anchorX: 0.5, anchorY: 0.5,
  })
  resizeEditor.undo()
  assert.deepEqual(resizeEditor.getTracks(), beforeResize)
  resizeEditor.redo()
  assert.deepEqual(compileScale(resizeEditor.getTracks().main.elements[0]!), compileScale(resizedElement))
})

test('control fails closed for video, fill, unknown, half-scale, and non-preset channels', () => {
  assert.equal(readVisualUniformScaleMotionDraft({
    type: 'video', duration: 24 * FRAME,
  }).editable, false)
  assert.equal(readVisualUniformScaleMotionDraft({
    type: 'image', duration: 24 * FRAME,
    manju: { shortVideoFill: { future: true } },
  }).editable, false)
  const unknown = { 'transform.positionX': { future: true } }
  const unknownState = readVisualUniformScaleMotionDraft({
    type: 'image', duration: 24 * FRAME, animations: unknown,
  })
  assert.equal(unknownState.editable, false)
  assert.match(unknownState.editable ? '' : unknownState.reason, /transform\.positionX/)
  assert.deepEqual(buildVisualUniformScaleMotionAnimation({
    animations: unknown,
    durationTicks: 24 * FRAME,
    motion: 'none',
    strength: 8,
  }), unknown)

  const valid = buildVisualUniformScaleMotionAnimation({
    durationTicks: 24 * FRAME,
    motion: 'pull-out',
    strength: 12,
  })
  const { ['transform.scaleY']: _scaleY, ...halfScale } = valid
  assert.equal(readVisualUniformScaleMotionDraft({
    type: 'image', duration: 24 * FRAME, animations: halfScale,
  }).editable, false)

  const sixPercent = buildVisualUniformScaleMotionAnimation({
    durationTicks: 24 * FRAME,
    motion: 'push-in',
    strength: 8,
  })
  const scaleX = sixPercent['transform.scaleX'] as { keys: Array<Record<string, unknown>> }
  const scaleY = sixPercent['transform.scaleY'] as { keys: Array<Record<string, unknown>> }
  scaleX.keys[1]!.value = 1.06
  scaleY.keys[1]!.value = 1.06
  assert.equal(readVisualUniformScaleMotionDraft({
    type: 'image', duration: 24 * FRAME, animations: sixPercent,
  }).editable, false)
  assert.throws(() => buildVisualUniformScaleMotionAnimation({
    durationTicks: 24 * FRAME,
    motion: 'push-in',
    strength: 6 as 8,
  }), RangeError)
})
