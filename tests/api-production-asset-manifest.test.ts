import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getProductionAssetManifest,
  materializeProductionAssetManifest,
} from '../src/lib/api'

const NOW = '2026-07-15T00:00:00.000Z'
const CHECKSUM = 'a'.repeat(64)
const FINGERPRINT = 'b'.repeat(64)
const EPISODE_ETAG = 'W/"episode.fixture"'

const context = {
  schemaVersion: 1,
  projectId: 'project-1',
  episodeId: 'episode-1',
  sourceRevisionId: 'source-r1',
  projectRevisionId: 'project-r1',
  timelineRevisionId: null,
  narratorVoiceProfileRevisionId: null,
  characterVoiceProfileRevisions: {},
}

const entry = {
  slotKey: 'character:character-1:primary',
  role: 'character.primary',
  assetId: 'character-family',
  assetVersionId: 'character-v2',
  versionNumber: 2,
  checksum: CHECKSUM,
  kind: 'character.turnaround',
  mimeType: 'image/png',
  sourceRevisionId: 'source-r1',
  providerId: 'image-provider',
  providerModel: 'image-model',
  providerConfigRevision: 3,
  metadata: { ownerId: 'character-1' },
}

const manifest = {
  id: 'manifest-1',
  projectId: 'project-1',
  episodeId: 'episode-1',
  revisionNumber: 1,
  parentManifestId: null,
  sourceRevisionId: 'source-r1',
  projectRevisionId: 'project-r1',
  timelineRevisionId: null,
  fingerprint: FINGERPRINT,
  entryCount: 1,
  context,
  summary: '固化本集制作素材引用',
  idempotencyKey: 'manifest-key',
  entries: [entry],
  createdAt: NOW,
}

test('getProductionAssetManifest preserves stable and exact IDs plus Episode ETag', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    projection: {
      status: 'current',
      fingerprint: FINGERPRINT,
      context,
      entries: [entry],
      blockers: [],
      latestManifest: manifest,
    },
  }), {
    headers: {
      'content-type': 'application/json',
      etag: `"production-asset-manifest-v1-${FINGERPRINT}"`,
      'x-episode-version': EPISODE_ETAG,
    },
  })) as typeof fetch
  try {
    const result = await getProductionAssetManifest('project-1', 'episode-1')
    assert.equal(result.episodeEtag, EPISODE_ETAG)
    assert.equal(result.projection.entries[0]?.assetId, 'character-family')
    assert.equal(result.projection.entries[0]?.assetVersionId, 'character-v2')
    assert.equal(result.projection.latestManifest?.revisionNumber, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('materializeProductionAssetManifest sends optimistic and idempotent headers without Provider confirmation', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({
      manifest,
      idempotent: false,
      providerCallRequired: false,
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const result = await materializeProductionAssetManifest(
      'project-1',
      'episode-1',
      EPISODE_ETAG,
      { idempotencyKey: 'manifest-key', summary: '阶段确认' },
    )
    assert.equal(result.providerCallRequired, false)
    assert.equal(requestUrl, '/api/v1/projects/project-1/episodes/episode-1/production-asset-manifest/materialize')
    const headers = new Headers(requestInit?.headers)
    assert.equal(headers.get('If-Match'), EPISODE_ETAG)
    assert.equal(headers.get('Idempotency-Key'), 'manifest-key')
    assert.equal(headers.get('x-manju-aigc-confirmation'), null)
    assert.deepEqual(JSON.parse(String(requestInit?.body)), { summary: '阶段确认' })
  } finally {
    globalThis.fetch = originalFetch
  }
})
