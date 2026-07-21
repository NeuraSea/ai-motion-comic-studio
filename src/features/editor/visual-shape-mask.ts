import {
  compileRenderSemanticVisualShapeMask,
  type EditorTimelineElement,
  type RenderSemanticVisualClip,
  type RenderSemanticVisualShapeMaskType,
} from '@manju/opencut-editor'

export const DEFAULT_VISUAL_SHAPE_MASK_ID = 'manju-shape-mask-v1'

/** CSS expression matching OpenCut's normalized, axis-aligned mask geometry. */
export function renderSemanticShapeMaskClipPath(
  clip: Pick<RenderSemanticVisualClip, 'shapeMask'>,
): string | undefined {
  const mask = clip.shapeMask
  if (!mask) return undefined
  if ('inverted' in mask && mask.inverted === true) return undefined
  const centerX = (0.5 + mask.centerX) * 100
  const centerY = (0.5 + mask.centerY) * 100
  const halfWidth = mask.width * 50
  const halfHeight = mask.height * 50
  if (mask.type === 'ellipse') {
    return `ellipse(${halfWidth}% ${halfHeight}% at ${centerX}% ${centerY}%)`
  }
  const left = centerX - halfWidth
  const right = centerX + halfWidth
  const top = centerY - halfHeight
  const bottom = centerY + halfHeight
  return `polygon(${left}% ${top}%, ${right}% ${top}%, ${right}% ${bottom}%, ${left}% ${bottom}%)`
}

function normalizedPathNumber(value: number): string {
  const rounded = Number(value.toFixed(6))
  return (Object.is(rounded, -0) ? 0 : rounded).toString()
}

/**
 * SVG objectBoundingBox path for the audited inverse hard-mask slice. The
 * outer canvas and inner shape are intentionally one even-odd path so DOM
 * preview has the same binary keep/discard rule as Canvas and FFmpeg.
 */
export function renderSemanticInvertedShapeMaskPath(
  clip: Pick<RenderSemanticVisualClip, 'shapeMask'>,
): string | undefined {
  const mask = clip.shapeMask
  if (!mask || !('inverted' in mask) || mask.inverted !== true) return undefined
  const centerX = 0.5 + mask.centerX
  const centerY = 0.5 + mask.centerY
  const halfWidth = mask.width / 2
  const halfHeight = mask.height / 2
  const left = normalizedPathNumber(centerX - halfWidth)
  const right = normalizedPathNumber(centerX + halfWidth)
  const top = normalizedPathNumber(centerY - halfHeight)
  const bottom = normalizedPathNumber(centerY + halfHeight)
  const cy = normalizedPathNumber(centerY)
  const rx = normalizedPathNumber(halfWidth)
  const ry = normalizedPathNumber(halfHeight)
  const outer = 'M0 0H1V1H0Z'
  if (mask.type === 'ellipse') {
    return `${outer} M${left} ${cy}A${rx} ${ry} 0 1 0 ${right} ${cy}A${rx} ${ry} 0 1 0 ${left} ${cy}Z`
  }
  return `${outer} M${left} ${top}H${right}V${bottom}H${left}Z`
}

export interface VisualShapeMaskDraft {
  enabled: boolean
  maskId: string
  type: RenderSemanticVisualShapeMaskType
  inverted: boolean
  centerX: number
  centerY: number
  width: number
  height: number
}

export type VisualShapeMaskDraftState =
  | { editable: true; draft: VisualShapeMaskDraft }
  | { editable: false; reason: string }

function defaultDraft(): VisualShapeMaskDraft {
  return {
    enabled: false,
    maskId: DEFAULT_VISUAL_SHAPE_MASK_ID,
    type: 'rectangle',
    inverted: false,
    centerX: 0,
    centerY: 0,
    width: 0.6,
    height: 0.6,
  }
}

/**
 * Read only the exact renderer-audited OpenCut mask subset. Unknown masks
 * remain in the canonical document and are never overwritten by this UI.
 */
export function readVisualShapeMaskDraft(
  element: Pick<EditorTimelineElement, 'masks' | 'manju'>,
): VisualShapeMaskDraftState {
  if (element.manju && typeof element.manju === 'object'
    && !Array.isArray(element.manju) && 'shortVideoFill' in element.manju) {
    return {
      editable: false,
      reason: '短视频静帧补尾会拆分为两个渲染片段，当前不允许叠加形状遮罩',
    }
  }
  try {
    const mask = compileRenderSemanticVisualShapeMask({
      masks: element.masks,
      path: 'timeline element',
    })
    if (!mask) return { editable: true, draft: defaultDraft() }
    const rawId = element.masks?.[0]?.id
    return {
      editable: true,
      draft: {
        enabled: true,
        maskId: typeof rawId === 'string' ? rawId : DEFAULT_VISUAL_SHAPE_MASK_ID,
        type: mask.type,
        inverted: 'inverted' in mask && mask.inverted === true,
        centerX: mask.centerX,
        centerY: mask.centerY,
        width: mask.width,
        height: mask.height,
      },
    }
  } catch (cause) {
    return {
      editable: false,
      reason: cause instanceof Error ? cause.message : '所选片段含未审核遮罩，已阻止覆盖',
    }
  }
}

/** Build the exact pinned OpenCut RectangleMask/EllipseMask wire shape. */
export function buildVisualShapeMasks(draft: VisualShapeMaskDraft): Record<string, unknown>[] {
  if (!draft.enabled) return []
  const masks: Record<string, unknown>[] = [{
    id: draft.maskId,
    type: draft.type,
    params: {
      feather: 0,
      inverted: draft.inverted,
      strokeColor: '#ffffff',
      strokeWidth: 0,
      strokeAlign: 'center',
      centerX: draft.centerX,
      centerY: draft.centerY,
      width: draft.width,
      height: draft.height,
      rotation: 0,
      scale: 1,
    },
  }]
  // Keep authoring and receipt validation inseparable. This rejects NaN,
  // out-of-range values or future unsupported fields before an atomic command.
  compileRenderSemanticVisualShapeMask({ masks, path: 'timeline element' })
  return masks
}
