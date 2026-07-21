import type { EditorTimelineElement, RenderSemanticFit } from '@manju/opencut-editor'

export type VisualFitMode = RenderSemanticFit

export interface VisualFitDraft {
  fit: VisualFitMode
}

export type VisualFitDraftState =
  | { editable: true; draft: VisualFitDraft }
  | { editable: false; reason: string }

export class VisualFitControlError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED' | 'CONFLICT' | 'INVALID_FIT',
    message: string,
  ) {
    super(message)
    this.name = 'VisualFitControlError'
  }
}

function isPlainParams(
  value: unknown,
): value is Record<string, number | string | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) return false
    const item = descriptor.value
    return typeof item === 'string'
      || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item))
  })
}

function isFit(value: unknown): value is VisualFitMode {
  return value === 'cover' || value === 'contain'
}

function hasShortVideoFill(element: Pick<EditorTimelineElement, 'manju'>): boolean {
  return Boolean(element.manju
    && typeof element.manju === 'object'
    && !Array.isArray(element.manju)
    && Object.hasOwn(element.manju, 'shortVideoFill'))
}

/**
 * Read only the exact renderer-audited OpenCut `params.fit` property. Missing
 * fit is the canonical `cover` default. An explicit unknown value, accessor,
 * malformed params object, non-visual element, or split short-video semantic
 * is blocked instead of being normalized or overwritten.
 */
export function readVisualFitDraft(
  element: Pick<EditorTimelineElement, 'type' | 'params' | 'manju'>,
): VisualFitDraftState {
  if (element.type !== 'image' && element.type !== 'video') {
    return { editable: false, reason: '画面适配仅支持图片或视频片段' }
  }
  if (hasShortVideoFill(element)) {
    return {
      editable: false,
      reason: '短视频静帧补尾包含两个渲染片段，当前不允许改写其适配语义',
    }
  }
  if (element.params === undefined) {
    return { editable: true, draft: { fit: 'cover' } }
  }
  if (!isPlainParams(element.params)) {
    return {
      editable: false,
      reason: 'params 含未知或非标量字段，已保留原数据并禁止覆盖',
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(element.params, 'fit')
  if (!descriptor) return { editable: true, draft: { fit: 'cover' } }
  if (!('value' in descriptor) || !isFit(descriptor.value)) {
    return {
      editable: false,
      reason: 'params.fit 必须严格为 cover 或 contain，未知值不会被猜测',
    }
  }
  return { editable: true, draft: { fit: descriptor.value } }
}

/**
 * Build the narrow params patch for one OpenCut UpdateElementsCommand. The
 * caller supplies the fit observed when the draft was opened; drift fails as
 * a conflict. Peer/future params are deliberately omitted from the patch so
 * OpenCut's canonical params merge preserves them without stale rewrites.
 */
export function buildVisualFitParamPatch({
  element,
  expectedFit,
  fit,
}: {
  element: Pick<EditorTimelineElement, 'type' | 'params' | 'manju'>
  expectedFit: VisualFitMode
  fit: VisualFitMode
}): Record<string, number | string | boolean> {
  if (!isFit(expectedFit) || !isFit(fit)) {
    throw new VisualFitControlError('INVALID_FIT', '画面适配必须为 cover 或 contain')
  }
  const current = readVisualFitDraft(element)
  if (!current.editable) {
    throw new VisualFitControlError('UNSUPPORTED', current.reason)
  }
  if (current.draft.fit !== expectedFit) {
    throw new VisualFitControlError(
      'CONFLICT',
      `画面适配已从 ${expectedFit} 变为 ${current.draft.fit}，请重新选择`,
    )
  }
  return { fit }
}
