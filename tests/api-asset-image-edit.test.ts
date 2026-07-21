import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  createAssetImageEdit,
  createAssetTurnaroundDerivation,
  getAsset,
  listAssets,
  lockCharacterVisualReferences,
  preflightAssetImageEdit,
} from '../src/lib/api'

const checksum = 'a'.repeat(64)
const sourceEtag = `"asset-v2-${checksum}"`
const sourceAsset = {
  id: 'asset-source',
  projectId: 'project-1',
  episodeId: 'episode-1',
  kind: 'character-turnaround',
  version: 2,
  status: 'ready',
  mimeType: 'image/png',
  width: 1536,
  height: 1024,
  durationSeconds: null,
  checksum,
  source: 'provider',
  providerId: 'codex-tools-image',
  generationJobId: 'job-source',
  sourceRevisionId: 'revision-1',
  parentAssetId: null,
  etag: sourceEtag,
  url: '/api/v1/assets/asset-source/content',
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
}

const editJob = {
  id: 'job-edit',
  projectId: 'project-1',
  episodeId: 'episode-1',
  type: 'asset.image.edit',
  status: 'queued',
  progress: 0,
  resourceType: null,
  resourceId: 'asset-source',
  providerId: 'codex-tools-image',
  model: 'gpt-image-2',
  providerConfigRevision: 1,
  attempt: 1,
  input: {},
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
}

test('asset image edit preflight and confirm pin the same body, ETag, and idempotency key', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 60
  const confirmation = {
    version: 1,
    action: 'asset.image.edit',
    label: '图片编辑',
    billableTaskCount: 1,
    provider: { providerId: 'codex-tools-image', model: 'gpt-image-2', configRevision: 2 },
    intentFingerprint: 'b'.repeat(64),
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
    confirmationToken: `aigcpf1_${expiresAtSeconds}_${'c'.repeat(64)}`,
    priceEstimate: null,
    priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE',
  }
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init })
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        error: {
          code: 'PAID_CONFIRMATION_REQUIRED',
          message: '需要确认',
          details: { confirmation },
        },
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ job: editJob }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const body = {
      projectId: 'project-1',
      mode: 'edit',
      prompt: '保持同一角色，修正手部细节。',
      size: '1536x1024',
      quality: 'medium',
      referenceAssetIds: ['asset-reference'],
    } as const
    const prepared = await preflightAssetImageEdit(
      'asset-source',
      body,
      sourceEtag,
      { idempotencyKey: 'asset-edit-key' },
    )
    const job = await createAssetImageEdit('asset-source', body, sourceEtag, {
      idempotencyKey: 'asset-edit-key',
      confirmationToken: prepared.confirmationToken,
    })
    assert.equal(job.id, 'job-edit')
    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.url, '/api/v1/assets/asset-source/edits')
    assert.equal(requests[1]?.url, requests[0]?.url)
    const preflightHeaders = new Headers(requests[0]?.init?.headers)
    const confirmedHeaders = new Headers(requests[1]?.init?.headers)
    assert.equal(preflightHeaders.get('If-Match'), sourceEtag)
    assert.equal(preflightHeaders.get('Idempotency-Key'), 'asset-edit-key')
    assert.equal(preflightHeaders.get('x-manju-aigc-confirmation'), null)
    assert.equal(confirmedHeaders.get('If-Match'), sourceEtag)
    assert.equal(confirmedHeaders.get('Idempotency-Key'), 'asset-edit-key')
    assert.equal(confirmedHeaders.get('x-manju-aigc-confirmation'), confirmation.confirmationToken)
    assert.equal(requests[1]?.init?.body, requests[0]?.init?.body)
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      projectId: 'project-1',
      mode: 'edit',
      prompt: '保持同一角色，修正手部细节。',
      size: '1536x1024',
      quality: 'medium',
      referenceAssetIds: ['asset-reference'],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('turnaround derivation client pins the source and submits exactly three normalized roles', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({
      job: {
        ...editJob,
        id: 'job-turnaround',
        type: 'asset.image.turnaround.derive',
      },
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  const crops = [
    { role: 'front' as const, x: 0, y: 0, width: 0.32, height: 1 },
    { role: 'side' as const, x: 0.34, y: 0, width: 0.32, height: 1 },
    { role: 'back' as const, x: 0.68, y: 0, width: 0.32, height: 1 },
  ]
  try {
    const job = await createAssetTurnaroundDerivation('asset-source', {
      projectId: 'project-1',
      crops,
    }, sourceEtag, { idempotencyKey: 'turnaround-key' })
    assert.equal(job.id, 'job-turnaround')
    assert.equal(requestUrl, '/api/v1/assets/asset-source/derivations/turnaround')
    const headers = new Headers(requestInit?.headers)
    assert.equal(headers.get('If-Match'), sourceEtag)
    assert.equal(headers.get('Idempotency-Key'), 'turnaround-key')
    assert.deepEqual(JSON.parse(String(requestInit?.body)), { projectId: 'project-1', crops })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('turnaround derivation client rejects missing or duplicate roles before network', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    throw new Error('must not call network')
  }) as typeof fetch
  try {
    await assert.rejects(
      createAssetTurnaroundDerivation('asset-source', {
        projectId: 'project-1',
        crops: [
          { role: 'front', x: 0, y: 0, width: 0.33, height: 1 },
          { role: 'front', x: 0.33, y: 0, width: 0.33, height: 1 },
          { role: 'back', x: 0.66, y: 0, width: 0.34, height: 1 },
        ],
      }, sourceEtag),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_CROPS',
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('asset image edit client rejects fake variation references before network', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    throw new Error('must not call network')
  }) as typeof fetch
  try {
    await assert.rejects(
      createAssetImageEdit('asset-source', {
        projectId: 'project-1',
        mode: 'variation',
        prompt: '相似变体',
        size: '1536x1024',
        quality: 'medium',
        referenceAssetIds: ['asset-reference'],
      }, sourceEtag),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_REFERENCE_ASSET',
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('asset list and detail preserve only valid edit ETags and reject header drift', async () => {
  const originalFetch = globalThis.fetch
  let detail = false
  globalThis.fetch = (async () => {
    if (!detail) {
      detail = true
      return new Response(JSON.stringify({ assets: [sourceAsset] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ asset: sourceAsset }), {
      headers: { 'Content-Type': 'application/json', ETag: '"asset-v2-bad"' },
    })
  }) as typeof fetch
  try {
    const assets = await listAssets('project-1')
    assert.equal(assets[0]?.etag, sourceEtag)
    await assert.rejects(
      getAsset('asset-source'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('character turnaround lock pins the Episode ETag and validates all three authoritative assets', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  const assets = Object.fromEntries((['front', 'side', 'back'] as const).map((role) => [role, {
    ...sourceAsset,
    id: `asset-${role}`,
    kind: `character-reference.${role}`,
    version: 1,
    source: 'derived',
    providerId: null,
    generationJobId: 'job-turnaround',
    parentAssetId: sourceAsset.id,
    etag: undefined,
    url: `/api/v1/assets/asset-${role}/content`,
  }]))
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({
      assets,
      target: {
        type: 'character',
        id: 'character-1',
        name: '阿离',
        version: 4,
        lockedAssetId: sourceAsset.id,
        references: {
          frontAssetId: 'asset-front',
          sideAssetId: 'asset-side',
          backAssetId: 'asset-back',
          auditRevisionId: 'reference-lock-revision-1',
        },
      },
      revision: { id: 'reference-lock-revision-1', projectId: 'project-1' },
      sourceRevisionId: 'revision-1',
      stale: { assets: 2, jobs: 1, exports: 1, qualityReports: 0, pipelineRuns: 1 },
      idempotent: false,
      auditRevision: true,
    }), {
      headers: {
        'Content-Type': 'application/json',
        ETag: 'W/"episode-reference-lock-2"',
        'X-Character-Visual-References-Revision': 'reference-lock-revision-1',
      },
    })
  }) as typeof fetch

  try {
    const result = await lockCharacterVisualReferences({
      projectId: 'project-1',
      episodeId: 'episode-1',
      targetId: 'character-1',
      frontAssetId: 'asset-front',
      sideAssetId: 'asset-side',
      backAssetId: 'asset-back',
    }, 'W/"episode-reference-lock-1"')
    assert.equal(result.target.references.sideAssetId, 'asset-side')
    assert.equal(result.auditRevisionId, 'reference-lock-revision-1')
    assert.equal(requestUrl, '/api/v1/character-visual-references/lock')
    assert.equal(new Headers(requestInit?.headers).get('If-Match'), 'W/"episode-reference-lock-1"')
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      projectId: 'project-1',
      episodeId: 'episode-1',
      targetId: 'character-1',
      frontAssetId: 'asset-front',
      sideAssetId: 'asset-side',
      backAssetId: 'asset-back',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
