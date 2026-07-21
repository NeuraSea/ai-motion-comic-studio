import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SpeechProviderError,
  type MiniMaxSpeechInput,
} from './minimax-tts.js'
import { OpenAICompatibleSpeechProvider } from './openai-compatible-speech.js'

const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

function input(overrides: Partial<MiniMaxSpeechInput> = {}): MiniMaxSpeechInput {
  return {
    text: '它醒了。',
    voiceId: 'alloy',
    speed: 1.1,
    volume: 1,
    pitch: 0,
    emotion: 'calm',
    format: 'mp3',
    ...overrides,
  }
}

test('calls the strict OpenAI-compatible audio/speech contract and returns bounded raw audio', async () => {
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  const provider = new OpenAICompatibleSpeechProvider({
    name: 'custom-speech',
    baseUrl: 'https://speech.example/v1/',
    apiKey: 'fixture-secret',
    model: 'tts-model',
    fetch: async (url, init) => {
      requestUrl = String(url)
      requestInit = init
      return new Response(MP3_BYTES, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(MP3_BYTES.byteLength) },
      })
    },
  })

  const result = await provider.synthesize(input())
  assert.equal(requestUrl, 'https://speech.example/v1/audio/speech')
  assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer fixture-secret')
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    model: 'tts-model',
    input: '它醒了。',
    voice: 'alloy',
    response_format: 'mp3',
    speed: 1.1,
  })
  assert.equal(result.audio.kind, 'bytes')
  if (result.audio.kind === 'bytes') {
    assert.equal(result.audio.sourceEncoding, 'raw')
    assert.deepEqual(Buffer.from(result.audio.bytes), MP3_BYTES)
  }
  assert.equal(result.mimeType, 'audio/mpeg')
  assert.equal(result.durationMs, undefined)
})

test('rejects unsupported MiniMax controls before contacting a compatible Provider', async () => {
  let calls = 0
  const provider = new OpenAICompatibleSpeechProvider({
    baseUrl: 'https://speech.example/v1',
    apiKey: 'fixture-secret',
    model: 'tts-model',
    fetch: async () => {
      calls += 1
      return new Response(MP3_BYTES, { headers: { 'content-type': 'audio/mpeg' } })
    },
  })
  for (const invalid of [
    input({ volume: 1.2 }),
    input({ pitch: 1 }),
    input({ emotion: 'angry' }),
    input({ languageBoost: 'Chinese' }),
  ]) {
    await assert.rejects(() => provider.synthesize(invalid), (error: unknown) => (
      error instanceof SpeechProviderError && error.code === 'INVALID_INPUT' && !error.retryable
    ))
  }
  assert.equal(calls, 0)
})

test('classifies HTTP failures without exposing credentials or upstream bodies', async () => {
  for (const [status, code, retryable] of [
    [401, 'PROVIDER_AUTH_FAILED', false],
    [429, 'PROVIDER_RATE_LIMITED', true],
    [503, 'UPSTREAM_UNAVAILABLE', true],
    [400, 'INVALID_INPUT', false],
  ] as const) {
    const provider = new OpenAICompatibleSpeechProvider({
      baseUrl: 'https://speech.example/v1',
      apiKey: 'never-leak-secret',
      model: 'tts-model',
      fetch: async () => new Response('upstream-secret-detail', { status }),
    })
    await assert.rejects(() => provider.synthesize(input()), (error: unknown) => (
      error instanceof SpeechProviderError
      && error.code === code
      && error.retryable === retryable
      && !error.message.includes('never-leak-secret')
      && !error.message.includes('upstream-secret-detail')
    ))
  }
})

test('rejects oversized, mislabeled, and wrong-format success bodies', async () => {
  const responses = [
    new Response(MP3_BYTES, {
      headers: { 'content-type': 'audio/mpeg', 'content-length': '1024' },
    }),
    new Response('<html>not audio</html>', { headers: { 'content-type': 'text/html' } }),
    new Response(MP3_BYTES, { headers: { 'content-type': 'audio/wav' } }),
  ]
  const expectedCodes = ['AUDIO_TOO_LARGE', 'INVALID_RESPONSE', 'INVALID_RESPONSE']
  for (let index = 0; index < responses.length; index += 1) {
    const provider = new OpenAICompatibleSpeechProvider({
      baseUrl: 'https://speech.example/v1',
      apiKey: 'fixture-secret',
      model: 'tts-model',
      maxAudioBytes: 32,
      fetch: async () => responses[index],
    })
    await assert.rejects(() => provider.synthesize(input()), (error: unknown) => (
      error instanceof SpeechProviderError && error.code === expectedCodes[index]
    ))
  }
})

test('enforces its own timeout and preserves caller cancellation', async () => {
  const hangingFetch: typeof fetch = async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  })
  const timed = new OpenAICompatibleSpeechProvider({
    baseUrl: 'https://speech.example/v1',
    apiKey: 'fixture-secret',
    model: 'tts-model',
    timeoutMs: 5,
    fetch: hangingFetch,
  })
  await assert.rejects(() => timed.synthesize(input()), (error: unknown) => (
    error instanceof SpeechProviderError && error.code === 'UPSTREAM_TIMEOUT' && error.retryable
  ))

  const controller = new AbortController()
  const cancelled = new OpenAICompatibleSpeechProvider({
    baseUrl: 'https://speech.example/v1',
    apiKey: 'fixture-secret',
    model: 'tts-model',
    fetch: hangingFetch,
  })
  const pending = cancelled.synthesize(input(), controller.signal)
  controller.abort(new Error('caller cancelled'))
  await assert.rejects(pending, /caller cancelled/)
})
