import assert from 'node:assert/strict'
import test from 'node:test'

import {
  listAssetHandleVersions,
  listAssetHandles,
  switchAssetHandleCurrentVersion,
} from '../src/lib/api'

const NOW = '2026-07-15T00:00:00.000Z'
const CHECKSUM = 'a'.repeat(64)
const ETAG = `"asset-handle-v1-${'b'.repeat(64)}"`

function version(id: string, legacyVersion: number) {
  return {
    id,
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'character-turnaround',
    version: legacyVersion,
    status: 'ready',
    mimeType: 'image/png',
    width: 1536,
    height: 1024,
    durationSeconds: null,
    checksum: CHECKSUM,
    source: 'provider',
    providerId: 'image-provider',
    generationJobId: 'job-1',
    sourceRevisionId: 'revision-1',
    parentAssetId: id === 'version-1' ? null : 'version-1',
    url: `/api/v1/assets/${id}/content`,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function handle(current = 'version-2') {
  return {
    assetId: 'version-1',
    projectId: 'project-1',
    kind: 'character-turnaround',
    currentAssetVersionId: current,
    revision: current === 'version-2' ? 2 : 3,
    versionCount: 2,
    businessBinding: {
      domain: 'character',
      groupKey: 'character:c_ali',
      groupLabel: '阿离',
      episodeId: 'episode-1',
      sceneId: null,
      shotId: null,
      lineId: null,
      entityType: 'character',
      entityId: 'c_ali',
      role: null,
    },
    etag: ETAG,
    currentVersion: version(current, 7),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

test('listAssetHandles can resolve a stable handle from an existing MediaAsset version', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  globalThis.fetch = (async (input) => {
    requestUrl = String(input)
    return new Response(JSON.stringify({ assets: [handle()] }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const result = await listAssetHandles('project-1', {
      episodeId: 'episode-1',
      assetVersionId: 'version-2',
      limit: 20,
    })
    assert.equal(result[0]?.assetId, 'version-1')
    assert.equal(result[0]?.currentAssetVersionId, 'version-2')
    assert.equal(requestUrl, '/api/v1/projects/project-1/asset-handles?episodeId=episode-1&assetVersionId=version-2&limit=20')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('listAssetHandleVersions preserves the authoritative membership ordinal and ETag', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    asset: handle(),
    versions: [
      {
        assetId: 'version-1',
        assetVersionId: 'version-2',
        versionNumber: 2,
        checksum: CHECKSUM,
        createdAt: NOW,
        version: version('version-2', 7),
      },
      {
        assetId: 'version-1',
        assetVersionId: 'version-1',
        versionNumber: 1,
        checksum: CHECKSUM,
        createdAt: NOW,
        version: version('version-1', 7),
      },
    ],
  }), {
    headers: { 'content-type': 'application/json', etag: ETAG },
  })) as typeof fetch
  try {
    const result = await listAssetHandleVersions('project-1', 'version-1')
    assert.deepEqual(result.versions.map((item) => ({
      versionNumber: item.versionNumber,
      legacyVersion: item.version.version,
    })), [
      { versionNumber: 2, legacyVersion: 7 },
      { versionNumber: 1, legacyVersion: 7 },
    ])
    assert.equal(result.asset.etag, ETAG)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('switchAssetHandleCurrentVersion pins If-Match/idempotency and never sends a paid confirmation', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({
      asset: handle('version-1'),
      switch: {
        id: 'switch-1',
        assetId: 'version-1',
        previousAssetVersionId: 'version-2',
        selectedAssetVersionId: 'version-1',
        selectedAssetVersionChecksum: CHECKSUM,
        handleRevision: 3,
        changed: true,
        createdAt: NOW,
        idempotent: false,
        providerCallRequired: false,
      },
    }), {
      status: 201,
      headers: { 'content-type': 'application/json', etag: ETAG },
    })
  }) as typeof fetch
  try {
    const result = await switchAssetHandleCurrentVersion(
      'project-1',
      'version-1',
      'version-1',
      ETAG,
      { idempotencyKey: 'switch-key' },
    )
    assert.equal(result.switch.providerCallRequired, false)
    assert.equal(result.switch.selectedAssetVersionId, 'version-1')
    assert.equal(requestUrl, '/api/v1/projects/project-1/asset-handles/version-1/current-version')
    const headers = new Headers(requestInit?.headers)
    assert.equal(headers.get('If-Match'), ETAG)
    assert.equal(headers.get('Idempotency-Key'), 'switch-key')
    assert.equal(headers.get('x-manju-aigc-confirmation'), null)
    assert.deepEqual(JSON.parse(String(requestInit?.body)), { assetVersionId: 'version-1' })
  } finally {
    globalThis.fetch = originalFetch
  }
})
