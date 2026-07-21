import assert from 'node:assert/strict'
import test from 'node:test'

import {
  confirmationMatchesAssetImageAttempt,
  freezeAssetImageEditAttempt,
  freezeAssetImageGenerationAttempt,
} from '../src/features/paid-aigc/paid-aigc-confirmation-state'

function confirmation(action: 'asset.image.generate' | 'asset.image.edit', expiresAt: string) {
  const expiresAtSeconds = Math.floor(Date.parse(expiresAt) / 1_000)
  return {
    version: 1 as const,
    action,
    label: '图片任务',
    billableTaskCount: 1 as const,
    provider: { providerId: 'image-provider', model: 'gpt-image-2', configRevision: 3 },
    intentFingerprint: 'c'.repeat(64),
    expiresAt,
    confirmationToken: `aigcpf1_${expiresAtSeconds}_${'d'.repeat(64)}`,
    priceEstimate: null,
    priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE' as const,
  }
}

test('frozen image generation attempt isolates later body/reference mutations and retains its key', () => {
  const request = {
    prompt: '角色近景',
    metadata: { referenceAssetIds: ['asset-front'] },
  }
  const attempt = freezeAssetImageGenerationAttempt({
    signature: 'signature-1',
    idempotencyKey: 'idempotency-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    providerId: 'image-provider',
    request,
    purpose: { kind: 'storyboard', shotId: 1, shotCode: 'sh0' },
  })
  request.prompt = '变化后的指令'
  request.metadata.referenceAssetIds.push('asset-side')

  assert.equal(attempt.input.prompt, '角色近景')
  assert.deepEqual(attempt.input.metadata, { referenceAssetIds: ['asset-front'] })
  assert.equal(attempt.idempotencyKey, 'idempotency-1')
  assert.equal(Object.isFrozen(attempt.input.metadata), true)
})

test('confirmation must match the frozen action and remain unexpired', () => {
  const attempt = freezeAssetImageEditAttempt({
    signature: 'signature-edit',
    idempotencyKey: 'idempotency-edit',
    sourceAssetId: 'asset-source',
    sourceEtag: `"asset-v1-${'a'.repeat(64)}"`,
    request: {
      projectId: 'project-1',
      providerId: 'image-provider',
      mode: 'edit',
      prompt: '修正手部',
      size: '1536x1024',
      quality: 'medium',
      referenceAssetIds: [],
    },
    purpose: {
      kind: 'visual-asset-edit',
      targetType: 'character',
      targetId: 'character-1',
      label: '阿离',
      sourceLabel: '阿离候选 v1',
    },
  })
  const now = Date.parse('2026-07-15T00:00:00.000Z')
  assert.equal(
    confirmationMatchesAssetImageAttempt(
      attempt,
      confirmation('asset.image.edit', '2026-07-15T00:01:00.000Z'),
      now,
    ),
    true,
  )
  assert.equal(
    confirmationMatchesAssetImageAttempt(
      attempt,
      confirmation('asset.image.generate', '2026-07-15T00:01:00.000Z'),
      now,
    ),
    false,
  )
  assert.equal(
    confirmationMatchesAssetImageAttempt(
      attempt,
      confirmation('asset.image.edit', '2026-07-14T23:59:59.000Z'),
      now,
    ),
    false,
  )
})
