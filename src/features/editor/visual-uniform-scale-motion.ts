import {
  compileRenderSemanticVisualOpacityFade,
  compileRenderSemanticVisualUniformScaleMotion,
  OPEN_CUT_TICKS_PER_SECOND,
  type EditorTimelineElement,
} from '@manju/opencut-editor'

export const VISUAL_UNIFORM_SCALE_FRAME_RATE = 24 as const
export const VISUAL_UNIFORM_SCALE_FRAME_TICKS = (
  OPEN_CUT_TICKS_PER_SECOND / VISUAL_UNIFORM_SCALE_FRAME_RATE
)
export const VISUAL_UNIFORM_SCALE_STRENGTHS = [4, 8, 12] as const
export const VISUAL_UNIFORM_SCALE_ANCHOR = { x: 0.5, y: 0.5 } as const

export type VisualUniformScaleMotion = 'none' | 'push-in' | 'pull-out'
export type VisualUniformScaleStrength = typeof VISUAL_UNIFORM_SCALE_STRENGTHS[number]

export interface VisualUniformScaleMotionDraft {
  motion: VisualUniformScaleMotion
  strength: VisualUniformScaleStrength
}

export type VisualUniformScaleMotionDraftState =
  | { editable: true; draft: VisualUniformScaleMotionDraft }
  | { editable: false; reason: string }

const AUDITED_VISUAL_ANIMATION_CHANNELS = new Set([
  'opacity',
  'transform.scaleX',
  'transform.scaleY',
])

function durationFrames(durationTicks: number): number {
  if (!Number.isSafeInteger(durationTicks)
    || durationTicks < VISUAL_UNIFORM_SCALE_FRAME_TICKS
    || durationTicks % VISUAL_UNIFORM_SCALE_FRAME_TICKS !== 0) {
    throw new RangeError('视觉片段必须精确对齐 24fps 帧边界')
  }
  return durationTicks / VISUAL_UNIFORM_SCALE_FRAME_TICKS
}

function hasShortVideoFill(element: Pick<EditorTimelineElement, 'manju'>): boolean {
  return Boolean(element.manju && typeof element.manju === 'object'
    && !Array.isArray(element.manju) && 'shortVideoFill' in element.manju)
}

function unknownAnimationChannels(animations?: Record<string, unknown>): string[] {
  return Object.keys(animations ?? {}).filter((key) => !AUDITED_VISUAL_ANIMATION_CHANNELS.has(key))
}

function opacityAnimationSubset(
  animations?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!animations || animations.opacity === undefined) return undefined
  return { opacity: animations.opacity }
}

function isStrength(value: number): value is VisualUniformScaleStrength {
  return VISUAL_UNIFORM_SCALE_STRENGTHS.some((strength) => strength === value)
}

function sameScale(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9
}

/**
 * Read only the centre-anchored, renderer-audited still-image motion preset.
 * Unknown channels stay in the canonical document, but deliberately make the
 * control read-only so a future OpenCut semantic can never be overwritten.
 */
export function readVisualUniformScaleMotionDraft(
  element: Pick<EditorTimelineElement, 'animations' | 'duration' | 'manju' | 'type'>,
): VisualUniformScaleMotionDraftState {
  if (element.type !== 'image') {
    return {
      editable: false,
      reason: '轻推近 / 轻拉远当前只支持静态分镜图，视频片段不会被改写',
    }
  }
  if (hasShortVideoFill(element)) {
    return {
      editable: false,
      reason: '短视频静帧补尾会拆分为两个渲染片段，当前不允许叠加镜头缩放',
    }
  }
  const unknown = unknownAnimationChannels(element.animations)
  if (unknown.length > 0) {
    return {
      editable: false,
      reason: `包含未审核动画通道 ${unknown.join('、')}，已保留原数据并禁止覆盖`,
    }
  }

  try {
    durationFrames(element.duration)
    // Opacity is an allowed peer channel, but malformed opacity must still
    // fail closed before this control can replace the two scale channels.
    compileRenderSemanticVisualOpacityFade({
      animations: opacityAnimationSubset(element.animations),
      duration: element.duration,
      ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
      path: 'timeline element',
    })
    const scale = compileRenderSemanticVisualUniformScaleMotion({
      animations: element.animations,
      duration: element.duration,
      ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
      path: 'timeline element',
    })
    if (!scale) {
      return { editable: true, draft: { motion: 'none', strength: 8 } }
    }
    if (scale.anchorX !== VISUAL_UNIFORM_SCALE_ANCHOR.x
      || scale.anchorY !== VISUAL_UNIFORM_SCALE_ANCHOR.y) {
      throw new RangeError('镜头缩放必须以画面中心为锚点')
    }

    const strength = Math.round(Math.abs(scale.toScale - scale.fromScale) * 100)
    if (!isStrength(strength)) {
      throw new RangeError('现有缩放不是 4% / 8% / 12% 的可编辑预设')
    }
    const maximum = 1 + strength / 100
    if (sameScale(scale.fromScale, 1) && sameScale(scale.toScale, maximum)) {
      return { editable: true, draft: { motion: 'push-in', strength } }
    }
    if (sameScale(scale.fromScale, maximum) && sameScale(scale.toScale, 1)) {
      return { editable: true, draft: { motion: 'pull-out', strength } }
    }
    throw new RangeError('现有缩放不是以 100% 画面为起点或终点的完整预设')
  } catch (cause) {
    return {
      editable: false,
      reason: cause instanceof Error
        ? cause.message
        : '所选片段含未审核缩放动画，已阻止覆盖',
    }
  }
}

function scalarScaleChannel(axis: 'x' | 'y', durationTicks: number, from: number, to: number) {
  return {
    keys: [
      {
        id: `uniform-scale-${axis}-start`,
        time: 0,
        value: from,
        segmentToNext: 'linear',
        tangentMode: 'flat',
      },
      {
        id: `uniform-scale-${axis}-end`,
        time: durationTicks,
        value: to,
        segmentToNext: 'linear',
        tangentMode: 'flat',
      },
    ],
    extrapolation: { before: 'hold', after: 'hold' },
  }
}

/**
 * Replace only transform.scaleX/Y. Opacity and even unknown future channels
 * are copied byte-for-byte; the UI reader is responsible for disabling edits
 * when those unknown channels are present.
 */
export function buildVisualUniformScaleMotionAnimation({
  animations,
  durationTicks,
  motion,
  strength,
}: {
  animations?: Record<string, unknown>
  durationTicks: number
  motion: VisualUniformScaleMotion
  strength: VisualUniformScaleStrength
}): Record<string, unknown> {
  durationFrames(durationTicks)
  const next = { ...(animations ?? {}) }
  delete next['transform.scaleX']
  delete next['transform.scaleY']
  if (motion === 'none') return next
  if (motion !== 'push-in' && motion !== 'pull-out') {
    throw new RangeError('镜头运动只支持轻推近、轻拉远或无')
  }
  if (!isStrength(strength)) {
    throw new RangeError('镜头运动强度只支持 4% / 8% / 12%')
  }
  const maximum = Number((1 + strength / 100).toFixed(2))
  const from = motion === 'push-in' ? 1 : maximum
  const to = motion === 'push-in' ? maximum : 1
  return {
    ...next,
    'transform.scaleX': scalarScaleChannel('x', durationTicks, from, to),
    'transform.scaleY': scalarScaleChannel('y', durationTicks, from, to),
  }
}
