import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  createAssetImageJob,
  preflightAssetImageJob,
} from '../src/lib/api'

function challenge(action: 'asset.image.generate' | 'asset.image.edit' = 'asset.image.generate') {
  const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 60
  return {
    version: 1,
    action,
    label: action === 'asset.image.generate' ? '分镜生图' : '图片编辑',
    billableTaskCount: 1,
    provider: { providerId: 'image-provider', model: 'gpt-image-2', configRevision: 7 },
    intentFingerprint: 'a'.repeat(64),
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
    confirmationToken: `aigcpf1_${expiresAtSeconds}_${'b'.repeat(64)}`,
    priceEstimate: null,
    priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE',
  }
}

test('asset image generation preflight and confirmed POST are byte-identical except confirmation header', async () => {
  const originalFetch = globalThis.fetch
  const confirmation = challenge()
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init })
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        error: {
          code: 'PAID_CONFIRMATION_REQUIRED',
          message: '需要确认',
          details: { confirmation },
        },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      job: {
        id: 'image-job-1',
        type: 'asset.image.generate',
        status: 'queued',
        progress: 0,
        attempt: 1,
        input: {},
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      },
    }), { status: 202, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  const input = {
    prompt: '保持角色一致的近景',
    size: '1536x1024' as const,
    quality: 'medium' as const,
    count: 1 as const,
    metadata: { kind: 'storyboard', shotId: 'sh0', referenceAssetIds: ['asset-1'] },
  }
  try {
    const prepared = await preflightAssetImageJob('project-1', 'episode-1', input, {
      providerId: 'image-provider',
      idempotencyKey: 'stable-image-key',
    })
    const job = await createAssetImageJob('project-1', 'episode-1', input, {
      providerId: 'image-provider',
      idempotencyKey: 'stable-image-key',
      confirmationToken: prepared.confirmationToken,
    })

    assert.equal(job.id, 'image-job-1')
    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.url, '/api/v1/assets/image-generations')
    assert.equal(requests[1]?.url, requests[0]?.url)
    assert.equal(requests[1]?.init?.body, requests[0]?.init?.body)
    const preflightHeaders = new Headers(requests[0]?.init?.headers)
    const confirmedHeaders = new Headers(requests[1]?.init?.headers)
    assert.equal(preflightHeaders.get('Idempotency-Key'), 'stable-image-key')
    assert.equal(preflightHeaders.get('x-manju-aigc-confirmation'), null)
    assert.equal(confirmedHeaders.get('Idempotency-Key'), 'stable-image-key')
    assert.equal(confirmedHeaders.get('x-manju-aigc-confirmation'), confirmation.confirmationToken)
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      projectId: 'project-1',
      episodeId: 'episode-1',
      providerId: 'image-provider',
      input,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('asset image preflight strictly rejects a success response or wrong-action challenge', async () => {
  const originalFetch = globalThis.fetch
  let responseMode: 'success' | 'wrong-action' = 'success'
  globalThis.fetch = (async () => {
    if (responseMode === 'success') {
      return new Response(JSON.stringify({ job: { id: 'must-not-exist' } }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      error: {
        code: 'PAID_CONFIRMATION_REQUIRED',
        message: '需要确认',
        details: { confirmation: challenge('asset.image.edit') },
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  try {
    const args = ['project-1', 'episode-1', { prompt: '分镜' }, {
      providerId: 'image-provider',
      idempotencyKey: 'stable-image-key',
    }] as const
    await assert.rejects(
      preflightAssetImageJob(...args),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
    responseMode = 'wrong-action'
    await assert.rejects(
      preflightAssetImageJob(...args),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('confirmed image generation rejects an invalid token before network', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    throw new Error('must not call network')
  }) as typeof fetch
  try {
    await assert.rejects(
      createAssetImageJob('project-1', 'episode-1', { prompt: '分镜' }, {
        providerId: 'image-provider',
        idempotencyKey: 'stable-image-key',
        confirmationToken: 'invalid-token',
      }),
      (error: unknown) => error instanceof ApiError && error.code === 'PAID_CONFIRMATION_REQUIRED',
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

