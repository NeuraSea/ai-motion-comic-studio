export const VISUAL_ASSET_EDIT_MODES = ['edit', 'variation'] as const
export type VisualAssetEditMode = (typeof VISUAL_ASSET_EDIT_MODES)[number]

export const VISUAL_ASSET_EDIT_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const
export type VisualAssetEditSize = (typeof VISUAL_ASSET_EDIT_SIZES)[number]

export const VISUAL_ASSET_EDIT_QUALITIES = ['low', 'medium', 'high', 'auto'] as const
export type VisualAssetEditQuality = (typeof VISUAL_ASSET_EDIT_QUALITIES)[number]

export const MAX_VISUAL_ASSET_EDIT_REFERENCES = 4
export const MAX_VISUAL_ASSET_EDIT_PROMPT_LENGTH = 8_000

export interface VisualAssetEditProviderCapability {
  label: string
  model?: string
  edit: boolean
  variations: boolean
  multiReference: boolean
}

export interface VisualAssetEditDraft {
  mode: VisualAssetEditMode
  prompt: string
  size: VisualAssetEditSize
  quality: VisualAssetEditQuality
  referenceAssetIds: string[]
}

export interface VisualAssetEditSubmission {
  mode: VisualAssetEditMode
  prompt: string
  size: VisualAssetEditSize
  quality: VisualAssetEditQuality
  referenceAssetIds: string[]
}

export type VisualAssetEditIssueCode =
  | 'invalid-prompt'
  | 'prompt-too-long'
  | 'invalid-size'
  | 'invalid-quality'
  | 'capability-missing'
  | 'variation-references-forbidden'
  | 'multi-reference-unsupported'
  | 'too-many-references'
  | 'duplicate-reference'
  | 'source-as-reference'
  | 'ineligible-reference'

export interface VisualAssetEditIssue {
  code: VisualAssetEditIssueCode
  message: string
  assetId?: string
}

export interface VisualAssetEditValidationContext {
  sourceAssetId: string
  eligibleReferenceAssetIds: ReadonlySet<string>
  capability: VisualAssetEditProviderCapability
}

export interface VisualAssetEditValidation {
  valid: boolean
  issues: VisualAssetEditIssue[]
}

export interface VisualAssetEditSubmissionResult extends VisualAssetEditValidation {
  submission: VisualAssetEditSubmission | null
}

export function visualAssetEditDefaultSize(
  source: { width: number | null; height: number | null },
): VisualAssetEditSize {
  const width = source.width
  const height = source.height
  if (!width || !height || width <= 0 || height <= 0) return 'auto'
  const ratio = width / height
  if (ratio > 1.15) return '1536x1024'
  if (ratio < 1 / 1.15) return '1024x1536'
  return '1024x1024'
}

export function createVisualAssetEditDraft(
  source: { width: number | null; height: number | null },
  capability: Pick<VisualAssetEditProviderCapability, 'edit' | 'variations'>,
): VisualAssetEditDraft {
  return {
    mode: capability.edit || !capability.variations ? 'edit' : 'variation',
    prompt: '',
    size: visualAssetEditDefaultSize(source),
    quality: 'medium',
    referenceAssetIds: [],
  }
}

/** A real variations request accepts only its immutable source image. */
export function changeVisualAssetEditMode(
  draft: VisualAssetEditDraft,
  mode: VisualAssetEditMode,
): VisualAssetEditDraft {
  return {
    ...draft,
    mode,
    referenceAssetIds: mode === 'variation' ? [] : [...draft.referenceAssetIds],
  }
}

/**
 * Safe UI toggle. Invalid additions are ignored rather than silently replacing
 * an existing reference; validation remains authoritative at submission time.
 */
export function toggleVisualAssetEditReference(
  draft: VisualAssetEditDraft,
  assetId: string,
  context: VisualAssetEditValidationContext,
): VisualAssetEditDraft {
  const normalizedId = assetId.trim()
  const selected = draft.referenceAssetIds.includes(normalizedId)
  if (selected) {
    return {
      ...draft,
      referenceAssetIds: draft.referenceAssetIds.filter((candidate) => candidate !== normalizedId),
    }
  }
  if (!normalizedId
    || draft.mode !== 'edit'
    || !context.capability.edit
    || !context.capability.multiReference
    || normalizedId === context.sourceAssetId
    || !context.eligibleReferenceAssetIds.has(normalizedId)
    || draft.referenceAssetIds.length >= MAX_VISUAL_ASSET_EDIT_REFERENCES) {
    return draft
  }
  return { ...draft, referenceAssetIds: [...draft.referenceAssetIds, normalizedId] }
}

export function validateVisualAssetEditDraft(
  draft: VisualAssetEditDraft,
  context: VisualAssetEditValidationContext,
): VisualAssetEditValidation {
  const issues: VisualAssetEditIssue[] = []
  const prompt = typeof draft.prompt === 'string' ? draft.prompt.trim() : ''
  if (!prompt) {
    issues.push({
      code: 'invalid-prompt',
      message: draft.mode === 'variation'
        ? '请填写本次原生变体的审计备注'
        : '请填写将传给 Provider 的编辑指令',
    })
  } else if (prompt.length > MAX_VISUAL_ASSET_EDIT_PROMPT_LENGTH) {
    issues.push({
      code: 'prompt-too-long',
      message: `文本不能超过 ${MAX_VISUAL_ASSET_EDIT_PROMPT_LENGTH} 个字符`,
    })
  }

  if (!(VISUAL_ASSET_EDIT_SIZES as readonly string[]).includes(draft.size)) {
    issues.push({ code: 'invalid-size', message: '输出尺寸不受支持' })
  }
  if (!(VISUAL_ASSET_EDIT_QUALITIES as readonly string[]).includes(draft.quality)) {
    issues.push({ code: 'invalid-quality', message: '输出质量不受支持' })
  }

  const modeSupported = draft.mode === 'edit' ? context.capability.edit : context.capability.variations
  if (!modeSupported) {
    issues.push({
      code: 'capability-missing',
      message: draft.mode === 'edit'
        ? '当前 Provider 未明确支持 images/edits'
        : '当前 Provider 未明确支持 images/variations',
    })
  }

  if (draft.referenceAssetIds.length > MAX_VISUAL_ASSET_EDIT_REFERENCES) {
    issues.push({
      code: 'too-many-references',
      message: `编辑模式最多可附加 ${MAX_VISUAL_ASSET_EDIT_REFERENCES} 张参考图`,
    })
  }
  const uniqueIds = new Set(draft.referenceAssetIds)
  if (uniqueIds.size !== draft.referenceAssetIds.length) {
    issues.push({ code: 'duplicate-reference', message: '附加参考图不能重复' })
  }
  if (draft.referenceAssetIds.includes(context.sourceAssetId)) {
    issues.push({ code: 'source-as-reference', message: '固定主图不能再次作为附加参考图' })
  }
  for (const assetId of uniqueIds) {
    if (!context.eligibleReferenceAssetIds.has(assetId)) {
      issues.push({
        code: 'ineligible-reference',
        assetId,
        message: '所选参考图已失效或不在当前同实体候选集中',
      })
    }
  }
  if (draft.mode === 'variation' && draft.referenceAssetIds.length > 0) {
    issues.push({
      code: 'variation-references-forbidden',
      message: '原生 variations 协议只接受固定主图，禁止附加参考图',
    })
  } else if (draft.referenceAssetIds.length > 0 && !context.capability.multiReference) {
    issues.push({
      code: 'multi-reference-unsupported',
      message: '当前 Provider 未明确支持附加多参考图',
    })
  }

  return { valid: issues.length === 0, issues }
}

export function buildVisualAssetEditSubmission(
  draft: VisualAssetEditDraft,
  context: VisualAssetEditValidationContext,
): VisualAssetEditSubmissionResult {
  const validation = validateVisualAssetEditDraft(draft, context)
  if (!validation.valid) return { ...validation, submission: null }
  return {
    ...validation,
    submission: {
      mode: draft.mode,
      prompt: draft.prompt.trim(),
      size: draft.size,
      quality: draft.quality,
      referenceAssetIds: [...draft.referenceAssetIds],
    },
  }
}
