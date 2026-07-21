import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_VISUAL_ASSET_EDIT_PROMPT_LENGTH,
  buildVisualAssetEditSubmission,
  changeVisualAssetEditMode,
  createVisualAssetEditDraft,
  toggleVisualAssetEditReference,
  validateVisualAssetEditDraft,
  visualAssetEditDefaultSize,
} from '../src/features/assets/visual-asset-edit-state'
import type {
  VisualAssetEditDraft,
  VisualAssetEditProviderCapability,
  VisualAssetEditValidationContext,
} from '../src/features/assets/visual-asset-edit-state'

const capableProvider: VisualAssetEditProviderCapability = {
  label: 'Fixture Image',
  model: 'fixture-image-1',
  edit: true,
  variations: true,
  multiReference: true,
}

const context: VisualAssetEditValidationContext = {
  sourceAssetId: 'asset-source',
  eligibleReferenceAssetIds: new Set(['asset-a', 'asset-b', 'asset-c', 'asset-d', 'asset-e']),
  capability: capableProvider,
}

function validDraft(patch: Partial<VisualAssetEditDraft> = {}): VisualAssetEditDraft {
  return {
    mode: 'edit',
    prompt: '保留人物身份与服饰，将背景调整为夜景',
    size: '1536x1024',
    quality: 'medium',
    referenceAssetIds: [],
    ...patch,
  }
}

test('draft defaults preserve source aspect and choose only an explicitly supported operation', () => {
  assert.equal(visualAssetEditDefaultSize({ width: 1600, height: 900 }), '1536x1024')
  assert.equal(visualAssetEditDefaultSize({ width: 900, height: 1600 }), '1024x1536')
  assert.equal(visualAssetEditDefaultSize({ width: 1024, height: 1000 }), '1024x1024')
  assert.equal(visualAssetEditDefaultSize({ width: null, height: null }), 'auto')

  assert.deepEqual(createVisualAssetEditDraft(
    { width: 900, height: 1600 },
    { edit: false, variations: true },
  ), {
    mode: 'variation',
    prompt: '',
    size: '1024x1536',
    quality: 'medium',
    referenceAssetIds: [],
  })
})

test('switching to the real variations protocol always drops auxiliary references', () => {
  const edit = validDraft({ referenceAssetIds: ['asset-a', 'asset-b'] })
  const variation = changeVisualAssetEditMode(edit, 'variation')
  assert.equal(variation.mode, 'variation')
  assert.deepEqual(variation.referenceAssetIds, [])
  assert.deepEqual(edit.referenceAssetIds, ['asset-a', 'asset-b'], 'mode changes must be immutable')
  assert.deepEqual(changeVisualAssetEditMode(variation, 'edit').referenceAssetIds, [])
})

test('reference toggle keeps the source immutable and enforces eligibility, capability, uniqueness, and the four-item limit', () => {
  let draft = validDraft()
  draft = toggleVisualAssetEditReference(draft, 'asset-source', context)
  draft = toggleVisualAssetEditReference(draft, 'not-eligible', context)
  assert.deepEqual(draft.referenceAssetIds, [])

  for (const assetId of ['asset-a', 'asset-b', 'asset-c', 'asset-d', 'asset-e']) {
    draft = toggleVisualAssetEditReference(draft, assetId, context)
  }
  assert.deepEqual(draft.referenceAssetIds, ['asset-a', 'asset-b', 'asset-c', 'asset-d'])

  const duplicateAttempt = toggleVisualAssetEditReference(draft, 'asset-d', context)
  assert.deepEqual(duplicateAttempt.referenceAssetIds, ['asset-a', 'asset-b', 'asset-c'])

  const unsupportedContext = {
    ...context,
    capability: { ...capableProvider, multiReference: false },
  }
  assert.deepEqual(
    toggleVisualAssetEditReference(validDraft(), 'asset-a', unsupportedContext).referenceAssetIds,
    [],
  )
  assert.deepEqual(
    toggleVisualAssetEditReference(changeVisualAssetEditMode(validDraft(), 'variation'), 'asset-a', context).referenceAssetIds,
    [],
  )
})

test('validation fails closed for prompt, capability, and reference protocol violations', () => {
  assert.ok(validateVisualAssetEditDraft(validDraft({ prompt: '   ' }), context).issues
    .some((issue) => issue.code === 'invalid-prompt'))
  assert.ok(validateVisualAssetEditDraft(validDraft({ prompt: 'x'.repeat(MAX_VISUAL_ASSET_EDIT_PROMPT_LENGTH + 1) }), context).issues
    .some((issue) => issue.code === 'prompt-too-long'))

  const malformedReferences = validateVisualAssetEditDraft(validDraft({
    referenceAssetIds: ['asset-source', 'asset-a', 'asset-a', 'not-eligible'],
  }), context)
  assert.equal(malformedReferences.valid, false)
  assert.ok(malformedReferences.issues.some((issue) => issue.code === 'source-as-reference'))
  assert.ok(malformedReferences.issues.some((issue) => issue.code === 'duplicate-reference'))
  assert.ok(malformedReferences.issues.some((issue) => issue.code === 'ineligible-reference'))

  const variationWithReference = validateVisualAssetEditDraft({
    ...validDraft(),
    mode: 'variation',
    referenceAssetIds: ['asset-a'],
  }, context)
  assert.ok(variationWithReference.issues.some((issue) => issue.code === 'variation-references-forbidden'))

  const missingCapability = validateVisualAssetEditDraft(validDraft(), {
    ...context,
    capability: { ...capableProvider, edit: false },
  })
  assert.ok(missingCapability.issues.some((issue) => issue.code === 'capability-missing'))

  const unsupportedMultiReference = validateVisualAssetEditDraft(validDraft({
    referenceAssetIds: ['asset-a'],
  }), {
    ...context,
    capability: { ...capableProvider, multiReference: false },
  })
  assert.ok(unsupportedMultiReference.issues
    .some((issue) => issue.code === 'multi-reference-unsupported'))

  const tooMany = validateVisualAssetEditDraft(validDraft({
    referenceAssetIds: ['asset-a', 'asset-b', 'asset-c', 'asset-d', 'asset-e'],
  }), context)
  assert.ok(tooMany.issues.some((issue) => issue.code === 'too-many-references'))
})

test('submission contains only the exact normalized paid operation payload', () => {
  const draft = validDraft({
    prompt: '  只改变手中道具，保持人物面部  ',
    size: '1024x1024',
    quality: 'high',
    referenceAssetIds: ['asset-b', 'asset-d'],
  })
  const result = buildVisualAssetEditSubmission(draft, context)
  assert.equal(result.valid, true)
  assert.deepEqual(result.submission, {
    mode: 'edit',
    prompt: '只改变手中道具，保持人物面部',
    size: '1024x1024',
    quality: 'high',
    referenceAssetIds: ['asset-b', 'asset-d'],
  })
  draft.referenceAssetIds.push('asset-a')
  assert.deepEqual(result.submission?.referenceAssetIds, ['asset-b', 'asset-d'])

  const invalid = buildVisualAssetEditSubmission(validDraft({ prompt: '' }), context)
  assert.equal(invalid.submission, null)
})
