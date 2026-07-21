import assert from 'node:assert/strict'
import { test } from 'node:test'

import { IndexTtsVoiceCatalogClient, IndexTtsVoiceCatalogError } from './indextts-voice-catalog.js'
import type { MaterializedProviderExecutionProfile } from './providers/service.js'

function profile(): MaterializedProviderExecutionProfile {
  return {
    providerId: 'indextts-speech',
    configRevision: 3,
    kind: 'speech',
    adapter: 'indextts',
    baseUrl: 'http://127.0.0.1:7861',
    model: 'IndexTTS-2',
    authMode: 'byok',
    credentialRef: 'keychain://fixture/token',
    executionConfig: {},
    createdAt: '2026-07-16T00:00:00.000Z',
    apiKey: 'fixture-token',
  }
}

test('IndexTTS voice catalog exposes only stable sidecar voice metadata', async () => {
  let authorization = ''
  const client = new IndexTtsVoiceCatalogClient((async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:7861/v1/voices')
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    return Response.json({
      voices: [{
        voice_id: 'ali-main',
        name: '阿离主声线',
        description: '清冷克制',
        tags: ['女声', '青年'],
        type: 'voice_cloning',
        reference_audio: '/secret/reference.wav',
      }],
    })
  }) as typeof fetch)

  const catalog = await client.list(profile())
  assert.equal(authorization, 'Bearer fixture-token')
  assert.equal(catalog.providerId, 'indextts-speech')
  assert.equal(catalog.providerConfigRevision, 3)
  assert.deepEqual(catalog.voices, [{
    voiceId: 'ali-main',
    name: '阿离主声线',
    descriptions: ['清冷克制', '女声', '青年'],
    type: 'voice_cloning',
  }])
  assert.match(catalog.fingerprint, /^[0-9a-f]{64}$/)
  assert.doesNotMatch(JSON.stringify(catalog), /secret|reference\.wav|fixture-token/)
})

test('IndexTTS voice catalog rejects duplicate voice IDs', async () => {
  const client = new IndexTtsVoiceCatalogClient((async () => Response.json({
    voices: [
      { voice_id: 'duplicate', name: 'A', description: '', tags: [] },
      { voice_id: 'duplicate', name: 'B', description: '', tags: [] },
    ],
  })) as typeof fetch)
  await assert.rejects(
    client.list(profile()),
    (error: unknown) => error instanceof IndexTtsVoiceCatalogError
      && error.code === 'INDEXTTS_VOICE_CATALOG_INVALID',
  )
})

