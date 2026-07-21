import assert from 'node:assert/strict'
import test from 'node:test'

import {
  adoptHistoricalVisualAsset,
  ApiError,
  listHistoricalVisualAssetCandidates,
} from '../src/lib/api'

const NOW = '2026-07-15T00:00:00.000Z'
const OLD_REVISION = 'revision-old'
const CURRENT_REVISION = 'revision-current'
const CHECKSUM = 'a'.repeat(64)
const ETAG = 'W/"episode.fixture"'

function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-old',
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'character-turnaround',
    version: 1,
    status: 'ready',
    mimeType: 'image/png',
    width: 1536,
    height: 1024,
    durationSeconds: null,
    checksum: CHECKSUM,
    source: 'provider',
    providerId: 'image-provider',
    generationJobId: 'job-old',
    sourceRevisionId: OLD_REVISION,
    parentAssetId: null,
    etag: `"asset-v1-${CHECKSUM}"`,
    url: '/api/v1/assets/asset-old/content',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function adoptionJob(assetId: string) {
  return {
    id: 'job-adopt',
    projectId: 'project-1',
    episodeId: 'episode-1',
    pipelineRunId: null,
    type: 'asset.image.history.adopt',
    status: 'succeeded',
    progress: 100,
    resourceType: 'asset.image.family',
    resourceId: 'character:ali',
    providerId: null,
    model: null,
    providerConfigRevision: null,
    externalTaskId: null,
    idempotencyKey: 'adopt-key',
    retryOf: null,
    attempt: 1,
    input: {},
    progressDetail: { stage: 'completed' },
    output: { assetVersionId: assetId },
    error: null,
    cost: null,
    retryDisposition: 'not-retryable',
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
  }
}

test('historical visual candidate list is read-only and preserves the Episode ETag', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({
      episodeId: 'episode-1',
      sourceRevisionId: CURRENT_REVISION,
      entityType: 'character',
      entityId: 'ali',
      candidates: [{
        asset: asset(),
        assetFamilyId: 'asset-old',
        assetVersionId: 'asset-old',
        assetVersion: 1,
        priorSourceRevisionId: OLD_REVISION,
        currentSourceRevisionId: CURRENT_REVISION,
        semanticFingerprint: 'b'.repeat(64),
        compatibility: {
          entityIdentity: 'exact',
          visualSemantics: 'exact',
          stylePreset: 'exact',
          aspectRatio: 'exact',
          providerCallRequired: false,
        },
      }],
    }), {
      headers: { 'content-type': 'application/json', etag: ETAG },
    })
  }) as typeof fetch
  try {
    const result = await listHistoricalVisualAssetCandidates(
      'project-1',
      'episode-1',
      'character',
      'ali',
    )
    assert.equal(result.etag, ETAG)
    assert.equal(result.candidates[0]?.asset.id, 'asset-old')
    assert.equal(result.candidates[0]?.compatibility.providerCallRequired, false)
    assert.equal(requestInit?.method, undefined)
    assert.equal(
      requestUrl,
      '/api/v1/episodes/episode-1/visual-asset-history?projectId=project-1&entityType=character&entityId=ali',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('historical visual adoption pins If-Match/idempotency and exposes a new immutable version', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  const adopted = asset({
    id: 'asset-current',
    version: 2,
    source: 'history-adoption',
    generationJobId: 'job-adopt',
    sourceRevisionId: CURRENT_REVISION,
    parentAssetId: 'asset-old',
    etag: `"asset-v2-${CHECKSUM}"`,
    url: '/api/v1/assets/asset-current/content',
  })
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({
      adoption: {
        asset: adopted,
        sourceAsset: asset(),
        job: adoptionJob('asset-current'),
        revision: {
          id: 'audit-revision',
          projectId: 'project-1',
          parentRevisionId: CURRENT_REVISION,
          summary: '收养历史角色视觉素材',
          createdAt: NOW,
        },
        assetFamilyId: 'asset-old',
        assetVersionId: 'asset-current',
        previousAssetVersionId: 'asset-old',
        sourceRevisionId: CURRENT_REVISION,
        priorSourceRevisionId: OLD_REVISION,
        semanticFingerprint: 'b'.repeat(64),
        idempotent: false,
        providerCallRequired: false,
      },
    }), {
      status: 201,
      headers: { 'content-type': 'application/json', etag: ETAG },
    })
  }) as typeof fetch
  try {
    const result = await adoptHistoricalVisualAsset('asset-old', {
      projectId: 'project-1',
      episodeId: 'episode-1',
      entityType: 'character',
      entityId: 'ali',
    }, ETAG, { idempotencyKey: 'adopt-key' })
    assert.equal(result.asset.id, 'asset-current')
    assert.equal(result.asset.parentAssetId, 'asset-old')
    assert.equal(result.providerCallRequired, false)
    assert.equal(result.etag, ETAG)
    assert.equal(requestUrl, '/api/v1/assets/asset-old/adopt-current-visual-revision')
    const headers = new Headers(requestInit?.headers)
    assert.equal(headers.get('If-Match'), ETAG)
    assert.equal(headers.get('Idempotency-Key'), 'adopt-key')
    assert.equal(headers.get('x-manju-aigc-confirmation'), null)
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      projectId: 'project-1',
      episodeId: 'episode-1',
      entityType: 'character',
      entityId: 'ali',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('client rejects a candidate that falsely claims a Provider-free compatibility proof', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    episodeId: 'episode-1',
    sourceRevisionId: CURRENT_REVISION,
    entityType: 'character',
    entityId: 'ali',
    candidates: [{
      asset: asset(),
      assetFamilyId: 'asset-old',
      assetVersionId: 'asset-old',
      assetVersion: 1,
      priorSourceRevisionId: OLD_REVISION,
      currentSourceRevisionId: CURRENT_REVISION,
      semanticFingerprint: 'b'.repeat(64),
      compatibility: {
        entityIdentity: 'exact',
        visualSemantics: 'exact',
        stylePreset: 'exact',
        aspectRatio: 'exact',
        providerCallRequired: true,
      },
    }],
  }), {
    headers: { 'content-type': 'application/json', etag: ETAG },
  })) as typeof fetch
  try {
    await assert.rejects(
      listHistoricalVisualAssetCandidates('project-1', 'episode-1', 'character', 'ali'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
