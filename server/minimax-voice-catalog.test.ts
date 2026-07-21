import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MiniMaxVoiceCatalogClient,
  MiniMaxVoiceCatalogError,
  miniMaxVoiceCatalogEndpoint,
} from './minimax-voice-catalog.js'
import type { MaterializedProviderExecutionProfile } from './providers/service.js'

function profile(baseUrl = 'https://api.minimax.io'): MaterializedProviderExecutionProfile {
  return {
    providerId: 'minimax-speech',
    configRevision: 7,
    kind: 'speech',
    adapter: 'minimax',
    baseUrl,
    model: 'speech-2.8-hd',
    authMode: 'byok',
    credentialRef: 'keychain://redacted/redacted',
    executionConfig: {},
    createdAt: '2026-07-14T00:00:00.000Z',
    apiKey: 'top-secret-minimax-key',
  }
}

function catalogResponse(): Response {
  return Response.json({
    system_voice: [{
      voice_id: 'Chinese (Mandarin)_Reliable_Executive',
      voice_name: 'Steady Executive',
      description: ['A steady and reliable male executive voice.'],
    }],
    voice_cloning: [{ voice_id: 'account-clone-1', description: [] }],
    voice_generation: [{ voice_id: 'ttv-generated-1', description: ['Warm and restrained.'] }],
    base_resp: { status_code: 0, status_msg: 'success' },
  })
}

test('MiniMax voice endpoint joins both official regional base URLs exactly once', () => {
  assert.equal(
    miniMaxVoiceCatalogEndpoint('https://api.minimax.io'),
    'https://api.minimax.io/v1/get_voice',
  )
  assert.equal(
    miniMaxVoiceCatalogEndpoint('https://api.minimaxi.com/'),
    'https://api.minimaxi.com/v1/get_voice',
  )
  assert.equal(
    miniMaxVoiceCatalogEndpoint('https://api.minimax.io/v1'),
    'https://api.minimax.io/v1/get_voice',
  )
})

test('catalog POST uses bearer auth, bounded official body, and returns only public voice metadata', async () => {
  let request: { url: string; init: RequestInit } | undefined
  const client = new MiniMaxVoiceCatalogClient({
    fetch: async (url, init) => {
      request = { url: String(url), init: init ?? {} }
      return catalogResponse()
    },
    now: () => new Date('2026-07-14T01:02:03.000Z'),
  })

  const result = await client.list(profile())
  assert.equal(request?.url, 'https://api.minimax.io/v1/get_voice')
  assert.equal(new Headers(request?.init.headers).get('authorization'), 'Bearer top-secret-minimax-key')
  assert.deepEqual(JSON.parse(String(request?.init.body)), { voice_type: 'all' })
  assert.equal(result.providerConfigRevision, 7)
  assert.equal(result.observedAt, '2026-07-14T01:02:03.000Z')
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/)
  assert.deepEqual(result.voices, [
    {
      voiceId: 'Chinese (Mandarin)_Reliable_Executive',
      name: 'Steady Executive',
      descriptions: ['A steady and reliable male executive voice.'],
      type: 'system',
    },
    {
      voiceId: 'account-clone-1',
      name: 'account-clone-1',
      descriptions: [],
      type: 'voice_cloning',
    },
    {
      voiceId: 'ttv-generated-1',
      name: 'ttv-generated-1',
      descriptions: ['Warm and restrained.'],
      type: 'voice_generation',
    },
  ])
  assert.equal(JSON.stringify(result).includes('top-secret-minimax-key'), false)
  assert.equal(JSON.stringify(result).includes('authorization'), false)
})

test('catalog errors are bounded, classified, and never echo secrets or raw provider messages', async () => {
  const authClient = new MiniMaxVoiceCatalogClient({
    fetch: async () => Response.json({
      base_resp: {
        status_code: 1004,
        status_msg: 'bad top-secret-minimax-key from Authorization header',
      },
    }),
  })
  await assert.rejects(authClient.list(profile()), (error: unknown) => {
    assert.ok(error instanceof MiniMaxVoiceCatalogError)
    assert.equal(error.code, 'MINIMAX_VOICE_AUTH_FAILED')
    assert.equal(error.message.includes('top-secret-minimax-key'), false)
    assert.equal(error.message.includes('Authorization'), false)
    return true
  })

  const oversized = new MiniMaxVoiceCatalogClient({
    fetch: async () => new Response('{}', {
      headers: { 'content-length': '999999' },
    }),
    maxResponseBytes: 100,
  })
  await assert.rejects(
    oversized.list(profile()),
    (error: unknown) => error instanceof MiniMaxVoiceCatalogError
      && error.code === 'MINIMAX_VOICE_CATALOG_TOO_LARGE',
  )

  const invalid = new MiniMaxVoiceCatalogClient({
    fetch: async () => Response.json({
      system_voice: [{ voice_id: '' }],
      base_resp: { status_code: 0 },
    }),
  })
  await assert.rejects(
    invalid.list(profile()),
    (error: unknown) => error instanceof MiniMaxVoiceCatalogError
      && error.code === 'MINIMAX_VOICE_CATALOG_INVALID',
  )
})

