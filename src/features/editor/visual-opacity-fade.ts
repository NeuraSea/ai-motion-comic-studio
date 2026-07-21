import {
  compileRenderSemanticVisualOpacityFade,
  compileRenderSemanticVisualUniformScaleMotion,
  OPEN_CUT_TICKS_PER_SECOND,
  type EditorTimelineElement,
} from '@manju/opencut-editor'

export const VISUAL_OPACITY_FRAME_RATE = 24 as const
export const VISUAL_OPACITY_FRAME_TICKS = OPEN_CUT_TICKS_PER_SECOND / VISUAL_OPACITY_FRAME_RATE

export interface VisualOpacityFadeDraft {
  fadeInFrames: number
  fadeOutFrames: number
}

export type VisualOpacityFadeDraftState =
  | { editable: true; draft: VisualOpacityFadeDraft }
  | { editable: false; reason: string }

function durationFrames(durationTicks: number): number {
  if (!Number.isSafeInteger(durationTicks)
    || durationTicks < VISUAL_OPACITY_FRAME_TICKS
    || durationTicks % VISUAL_OPACITY_FRAME_TICKS !== 0) {
    throw new RangeError('视觉片段必须精确对齐 24fps 帧边界')
  }
  return durationTicks / VISUAL_OPACITY_FRAME_TICKS
}

const AUDITED_VISUAL_ANIMATION_CHANNELS = new Set([
  'opacity',
  'transform.scaleX',
  'transform.scaleY',
])

function animationSubset(
  animations: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!animations) return undefined
  const entries = keys.flatMap((key) => (
    animations[key] === undefined ? [] : [[key, animations[key]] as const]
  ))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function validateAuditedPeerChannels(
  animations: Record<string, unknown> | undefined,
  duration: number,
): void {
  const unknown = Object.keys(animations ?? {})
    .filter((key) => !AUDITED_VISUAL_ANIMATION_CHANNELS.has(key))
  if (unknown.length > 0) {
    throw new RangeError(`包含未审核动画通道 ${unknown.join('、')}`)
  }
  compileRenderSemanticVisualUniformScaleMotion({
    animations: animationSubset(animations, ['transform.scaleX', 'transform.scaleY']),
    duration,
    ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
    path: 'timeline element',
  })
}

/**
 * Read only the renderer-audited channel. A future/unknown animation remains
 * visible in the canonical document but cannot be overwritten by this UI.
 */
export function readVisualOpacityFadeDraft(
  element: Pick<EditorTimelineElement, 'animations' | 'duration' | 'manju'>,
): VisualOpacityFadeDraftState {
  if (element.manju && typeof element.manju === 'object'
    && !Array.isArray(element.manju) && 'shortVideoFill' in element.manju) {
    return {
      editable: false,
      reason: '短视频静帧补尾会拆分为两个渲染片段，当前不允许叠加透明度动画',
    }
  }
  try {
    durationFrames(element.duration)
    validateAuditedPeerChannels(element.animations, element.duration)
    const fade = compileRenderSemanticVisualOpacityFade({
      animations: animationSubset(element.animations, ['opacity']),
      duration: element.duration,
      ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
      path: `timeline element`,
    })
    return {
      editable: true,
      draft: {
        fadeInFrames: fade?.fadeIn?.durationFrames ?? 0,
        fadeOutFrames: fade?.fadeOut?.durationFrames ?? 0,
      },
    }
  } catch (cause) {
    return {
      editable: false,
      reason: cause instanceof Error
        ? cause.message
        : '所选片段含未审核动画，已阻止覆盖',
    }
  }
}

/** Prevent OpenCut split from introducing fractional opacity boundary keys. */
export function splitFallsInsideVisualOpacityTransition(
  element: Pick<EditorTimelineElement, 'animations' | 'duration'>,
  localSplitTicks: number,
): boolean {
  durationFrames(element.duration)
  validateAuditedPeerChannels(element.animations, element.duration)
  const fade = compileRenderSemanticVisualOpacityFade({
    animations: animationSubset(element.animations, ['opacity']),
    duration: element.duration,
    ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
    path: 'timeline element',
  })
  if (!fade || !Number.isSafeInteger(localSplitTicks)
    || localSplitTicks % VISUAL_OPACITY_FRAME_TICKS !== 0) return false
  const frame = localSplitTicks / VISUAL_OPACITY_FRAME_TICKS
  return [fade.fadeIn, fade.fadeOut].some((segment) => segment !== null
    && frame > segment.startFrame
    && frame < segment.startFrame + segment.durationFrames)
}

function scalarKey(id: string, frame: number, value: 0 | 1) {
  return {
    id,
    time: frame * VISUAL_OPACITY_FRAME_TICKS,
    value,
    segmentToNext: 'linear',
    tangentMode: 'flat',
  }
}

/** Build the exact OpenCut ScalarChannel accepted by RenderSemanticPlan. */
export function buildVisualOpacityFadeAnimation({
  animations,
  durationTicks,
  fadeInFrames,
  fadeOutFrames,
}: {
  animations?: Record<string, unknown>
  durationTicks: number
  fadeInFrames: number
  fadeOutFrames: number
}): Record<string, unknown> {
  const frames = durationFrames(durationTicks)
  if (!Number.isSafeInteger(fadeInFrames) || fadeInFrames < 0
    || !Number.isSafeInteger(fadeOutFrames) || fadeOutFrames < 0
    || fadeInFrames + fadeOutFrames > frames) {
    throw new RangeError('画面淡入与淡出必须是不重叠的整帧时长')
  }
  const next = { ...(animations ?? {}) }
  delete next.opacity
  if (fadeInFrames === 0 && fadeOutFrames === 0) return next

  const keys: ReturnType<typeof scalarKey>[] = []
  if (fadeInFrames > 0) {
    keys.push(
      scalarKey('opacity-in-start', 0, 0),
      scalarKey('opacity-in-end', fadeInFrames, 1),
    )
  }
  if (fadeOutFrames > 0) {
    const fadeOutStart = frames - fadeOutFrames
    const last = keys.at(-1)
    if (!last || last.time !== fadeOutStart * VISUAL_OPACITY_FRAME_TICKS) {
      keys.push(scalarKey('opacity-out-start', fadeOutStart, 1))
    }
    keys.push(scalarKey('opacity-out-end', frames, 0))
  }
  return {
    ...next,
    opacity: {
      keys,
      extrapolation: { before: 'hold', after: 'hold' },
    },
  }
}
