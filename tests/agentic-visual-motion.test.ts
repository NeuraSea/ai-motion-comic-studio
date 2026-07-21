import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createOpenCutCommandEditor,
  OPEN_CUT_TICKS_PER_SECOND,
  type EditorSceneTracks,
  type EditorTimelineElement,
} from '../apps/opencut-editor/src/index.js'
import {
  AGENTIC_VISUAL_MOTION_STRATEGY,
  planAgenticVisualMotion,
  updatesForAgenticVisualMotion,
  type AgenticVisualMotionShot,
} from '../src/features/editor/agentic-visual-motion.js'
import { buildVisualOpacityFadeAnimation } from '../src/features/editor/visual-opacity-fade.js'
import {
  buildVisualUniformScaleMotionAnimation,
  readVisualUniformScaleMotionDraft,
} from '../src/features/editor/visual-uniform-scale-motion.js'

const FRAME = OPEN_CUT_TICKS_PER_SECOND / 24
const DURATION = 48 * FRAME

function image(
  id: string,
  params: Record<string, number | string | boolean>,
  options: Partial<EditorTimelineElement> = {},
): EditorTimelineElement {
  return {
    id,
    type: 'image',
    mediaId: `asset-${id}`,
    name: id,
    startTime: 0,
    duration: DURATION,
    trimStart: 0,
    trimEnd: 0,
    params,
    ...options,
  }
}

function scene(
  elements: EditorTimelineElement[],
  options: { mainHidden?: boolean; overlays?: EditorSceneTracks['overlay'] } = {},
): EditorSceneTracks {
  return {
    main: {
      id: 'main',
      name: 'main',
      type: 'video',
      hidden: options.mainHidden ?? false,
      muted: false,
      elements,
    },
    overlay: options.overlays ?? [],
    audio: [],
  }
}

test('agentic plan maps only reviewed push/pull language and conservative empty-movement framing', () => {
  const shots: AgenticVisualMotionShot[] = [
    { id: 1, storyId: 'sh-push-slow', code: 'S0-0', movement: '  缓慢推近  ' },
    { id: 2, storyId: 'sh-pull', code: 'S0-1', movement: '镜头拉远' },
    { id: 3, storyId: 'sh-close', code: 'S0-2', movement: '', framing: '特写' },
    { id: 4, storyId: 'sh-wide', code: 'S0-3', framing: 'establishing wide' },
    { id: 5, storyId: 'sh-still', code: 'S0-4', movement: '固定镜头' },
  ]
  const tracks = scene(shots.map((shot) => image(`element-${shot.id}`, {
    storyShotId: shot.storyId!,
    shotId: shot.id,
  })))

  const plan = planAgenticVisualMotion(tracks, shots)
  assert.equal(plan.version, 1)
  assert.equal(plan.strategy, AGENTIC_VISUAL_MOTION_STRATEGY)
  assert.deepEqual(plan.recommendations.map(({ shotCode, motion, strength }) => ({
    shotCode,
    motion,
    strength,
  })), [
    { shotCode: 'S0-0', motion: 'push-in', strength: 4 },
    { shotCode: 'S0-1', motion: 'pull-out', strength: 8 },
    { shotCode: 'S0-2', motion: 'push-in', strength: 4 },
    { shotCode: 'S0-3', motion: 'pull-out', strength: 4 },
  ])
  assert.deepEqual(plan.skipped.map(({ shotCode }) => shotCode), ['S0-4'])
})

test('planner preserves opacity and manual motion while video, short-fill, pan and unknown channels fail closed', () => {
  const opacity = buildVisualOpacityFadeAnimation({
    durationTicks: DURATION,
    fadeInFrames: 4,
    fadeOutFrames: 4,
  })
  const manualScale = buildVisualUniformScaleMotionAnimation({
    durationTicks: DURATION,
    motion: 'push-in',
    strength: 8,
  })
  const tracks = scene([
    image('opacity', { storyShotId: 'sh-opacity' }, { animations: opacity }),
    image('manual', { storyShotId: 'sh-manual' }, { animations: manualScale }),
    {
      ...image('video', { storyShotId: 'sh-video' }),
      type: 'video',
    },
    image('short-fill', { storyShotId: 'sh-fill' }, {
      manju: { shortVideoFill: { version: 1 } },
    }),
    image('pan-copy', { storyShotId: 'sh-pan' }),
    image('compound-pan', { storyShotId: 'sh-compound-pan' }),
    image('compound-directions', { storyShotId: 'sh-compound-directions' }),
    image('manual-pan', { storyShotId: 'sh-manual-pan' }, {
      animations: { 'transform.positionX': { future: true } },
    }),
  ])
  const shots: AgenticVisualMotionShot[] = [
    { id: 1, storyId: 'sh-opacity', code: 'S0-0', movement: '推近' },
    { id: 2, storyId: 'sh-manual', code: 'S0-1', movement: '拉远' },
    { id: 3, storyId: 'sh-video', code: 'S0-2', movement: '推近' },
    { id: 4, storyId: 'sh-fill', code: 'S0-3', movement: '推近' },
    { id: 5, storyId: 'sh-pan', code: 'S0-4', movement: '横移摇镜' },
    { id: 6, storyId: 'sh-compound-pan', code: 'S0-5', movement: '横移并缓慢推进' },
    { id: 7, storyId: 'sh-compound-directions', code: 'S0-6', movement: '先推近再拉远' },
    { id: 8, storyId: 'sh-manual-pan', code: 'S0-7', movement: '推近' },
  ]

  const plan = planAgenticVisualMotion(tracks, shots)
  assert.equal(plan.recommendations.length, 1)
  assert.equal(plan.recommendations[0]?.elementId, 'opacity')
  assert.deepEqual(plan.recommendations[0]?.animations.opacity, opacity.opacity)
  assert.equal(plan.skipped.some((entry) => entry.elementId === 'manual' && /Agent 不覆盖/.test(entry.reason)), true)
  assert.equal(plan.skipped.some((entry) => entry.elementId === 'short-fill' && /短视频/.test(entry.reason)), true)
  assert.equal(plan.skipped.some((entry) => entry.elementId === 'pan-copy' && /不属于/.test(entry.reason)), true)
  assert.equal(plan.skipped.some((entry) => entry.elementId === 'compound-pan' && /不属于/.test(entry.reason)), true)
  assert.equal(plan.skipped.some((entry) => entry.elementId === 'compound-directions' && /不属于/.test(entry.reason)), true)
  assert.equal(plan.skipped.some((entry) => entry.elementId === 'manual-pan' && /positionX/.test(entry.reason)), true)
  assert.equal(plan.recommendations.some((entry) => entry.elementId === 'video'), false)
})

test('shot binding is unique, exact, and consistent across both identifiers', () => {
  const shots: AgenticVisualMotionShot[] = [
    { id: 0, storyId: 'sh-zero', code: 'zero', movement: '推近' },
    { id: 1, storyId: 'sh-one', code: 'one', movement: '推近' },
    { id: 2, storyId: 'sh-two', code: 'two', movement: '拉远' },
    { id: 3, storyId: 'duplicate', code: 'dup-a', movement: '推近' },
    { id: 4, storyId: 'duplicate', code: 'dup-b', movement: '拉远' },
  ]
  const tracks = scene([
    image('blank-number', { shotId: '' }),
    image('conflict', { storyShotId: 'sh-one', shotId: 2 }),
    image('duplicate-story', { storyShotId: 'duplicate' }),
    image('consistent', { storyShotId: 'sh-one', shotId: '1' }),
  ])

  const plan = planAgenticVisualMotion(tracks, shots)
  assert.deepEqual(plan.recommendations.map(({ elementId, shotCode }) => ({ elementId, shotCode })), [
    { elementId: 'consistent', shotCode: 'one' },
  ])
  assert.deepEqual(plan.skipped.map(({ elementId }) => elementId), [
    'blank-number',
    'conflict',
    'duplicate-story',
  ])
})

test('any batch drift or forged animation invalidates every update before OpenCut commit', () => {
  const shots: AgenticVisualMotionShot[] = [
    { id: 1, storyId: 'sh-one', code: 'S0-0', movement: '推近' },
    { id: 2, storyId: 'sh-two', code: 'S0-1', movement: '拉远' },
  ]
  const base = scene([
    image('one', { storyShotId: 'sh-one' }),
    image('two', { storyShotId: 'sh-two' }),
  ])
  const plan = planAgenticVisualMotion(base, shots)
  assert.equal(plan.recommendations.length, 2)

  const durationDrift = structuredClone(base)
  durationDrift.main.elements[1]!.duration += FRAME
  assert.equal(updatesForAgenticVisualMotion(durationDrift, plan), null)

  const animationDrift = structuredClone(base)
  animationDrift.main.elements[1]!.animations = { opacity: { future: true } }
  assert.equal(updatesForAgenticVisualMotion(animationDrift, plan), null)

  const hiddenTrackDrift = structuredClone(base)
  hiddenTrackDrift.main.hidden = true
  assert.equal(updatesForAgenticVisualMotion(hiddenTrackDrift, plan), null)

  const duplicateTrackDrift = structuredClone(base)
  duplicateTrackDrift.overlay.push({
    id: 'main',
    name: 'ambiguous-main',
    type: 'video',
    hidden: false,
    muted: false,
    elements: [],
  })
  assert.equal(updatesForAgenticVisualMotion(duplicateTrackDrift, plan), null)

  const duplicateElementDrift = structuredClone(base)
  duplicateElementDrift.main.elements.push(structuredClone(duplicateElementDrift.main.elements[0]!))
  assert.equal(updatesForAgenticVisualMotion(duplicateElementDrift, plan), null)

  const shortFillDrift = structuredClone(base)
  shortFillDrift.main.elements[1]!.manju = { shortVideoFill: { version: 1 } }
  assert.equal(updatesForAgenticVisualMotion(shortFillDrift, plan), null)

  const forgedPlan = structuredClone(plan)
  forgedPlan.recommendations[0]!.animations['transform.positionX'] = { future: true }
  assert.equal(updatesForAgenticVisualMotion(base, forgedPlan), null)

  const editor = createOpenCutCommandEditor({ tracks: durationDrift })
  const before = editor.getTracks()
  const updates = updatesForAgenticVisualMotion(editor.getTracks(), plan)
  if (updates) editor.commitElementPropertyUpdates({ updates })
  assert.deepEqual(editor.getTracks(), before)
  assert.equal(editor.canUndo(), false)
})

test('one OpenCut property command applies the whole safe batch and one undo restores it', () => {
  const opacity = buildVisualOpacityFadeAnimation({
    durationTicks: DURATION,
    fadeInFrames: 4,
    fadeOutFrames: 4,
  })
  const tracks = scene([
    image('one', { storyShotId: 'sh-one' }, { animations: opacity }),
    image('two', { storyShotId: 'sh-two' }),
  ])
  const shots: AgenticVisualMotionShot[] = [
    { id: 1, storyId: 'sh-one', code: 'S0-0', movement: '推近' },
    { id: 2, storyId: 'sh-two', code: 'S0-1', movement: '拉远' },
  ]
  const plan = planAgenticVisualMotion(tracks, shots)
  const updates = updatesForAgenticVisualMotion(tracks, plan)
  assert.ok(updates)
  assert.equal(updates.length, 2)

  const editor = createOpenCutCommandEditor({ tracks })
  const before = editor.getTracks()
  editor.commitElementPropertyUpdates({ updates })
  assert.deepEqual(readVisualUniformScaleMotionDraft(editor.getTracks().main.elements[0]!), {
    editable: true,
    draft: { motion: 'push-in', strength: 8 },
  })
  assert.deepEqual(readVisualUniformScaleMotionDraft(editor.getTracks().main.elements[1]!), {
    editable: true,
    draft: { motion: 'pull-out', strength: 8 },
  })
  assert.deepEqual(
    editor.getTracks().main.elements[0]!.animations?.opacity,
    before.main.elements[0]!.animations?.opacity,
  )
  assert.equal(editor.canUndo(), true)

  editor.undo()
  assert.deepEqual(editor.getTracks(), before)
  assert.equal(editor.canUndo(), false)
  editor.redo()
  assert.deepEqual(readVisualUniformScaleMotionDraft(editor.getTracks().main.elements[1]!), {
    editable: true,
    draft: { motion: 'pull-out', strength: 8 },
  })
})
