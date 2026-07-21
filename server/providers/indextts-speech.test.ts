import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SpeechProviderError } from './minimax-tts.js'
import { IndexTtsSpeechProvider } from './indextts-speech.js'

const WAV_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
  0x00, 0x00, 0x00, 0x00,
])

test('IndexTTS adapter sends the stable sidecar contract and returns WAV bytes', async () => {
  let requestUrl = ''
  let authorization = ''
  let body: Record<string, unknown> = {}
  const provider = new IndexTtsSpeechProvider({
    baseUrl: 'http://127.0.0.1:7861',
    apiKey: 'fixture-token',
    model: 'IndexTTS-2',
    fetch: (async (input, init) => {
      requestUrl = String(input)
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(WAV_BYTES, { status: 200, headers: { 'content-type': 'audio/wav' } })
    }) as typeof fetch,
  })

  const result = await provider.synthesize({
    text: '快躲起来！他来了！',
    voiceId: 'ali-main',
    emotion: 'fearful',
    speed: 1.1,
    pitch: 0,
    volume: 1,
    format: 'wav',
  })

  assert.equal(requestUrl, 'http://127.0.0.1:7861/v1/audio/speech')
  assert.equal(authorization, 'Bearer fixture-token')
  assert.deepEqual(body, {
    model: 'IndexTTS-2',
    input: '快躲起来！他来了！',
    voice: 'ali-main',
    response_format: 'wav',
    speed: 1.1,
    emotion: 'fearful',
    emotion_alpha: 0.65,
  })
  assert.equal(result.mimeType, 'audio/wav')
  assert.equal(result.format, 'wav')
  assert.equal(result.audio.kind, 'bytes')
  assert.equal(result.usageCharacters, 9)
})

test('IndexTTS adapter rejects unsupported pitch before inference', async () => {
  let calls = 0
  const provider = new IndexTtsSpeechProvider({
    baseUrl: 'https://tts.example.test',
    apiKey: 'fixture-token',
    model: 'IndexTTS-2',
    fetch: (async () => {
      calls += 1
      return new Response(WAV_BYTES, { headers: { 'content-type': 'audio/wav' } })
    }) as typeof fetch,
  })

  await assert.rejects(
    provider.synthesize({ text: '测试', voiceId: 'voice', pitch: 1, format: 'wav' }),
    (error: unknown) => error instanceof SpeechProviderError
      && error.code === 'INVALID_INPUT'
      && !error.retryable,
  )
  assert.equal(calls, 0)
})

test('IndexTTS adapter maps auth and availability errors', async () => {
  for (const [status, code, retryable] of [
    [401, 'PROVIDER_AUTH_FAILED', false],
    [429, 'PROVIDER_RATE_LIMITED', true],
    [502, 'UPSTREAM_UNAVAILABLE', true],
  ] as const) {
    const provider = new IndexTtsSpeechProvider({
      baseUrl: 'https://tts.example.test/v1',
      apiKey: 'fixture-token',
      model: 'IndexTTS-2',
      fetch: (async () => new Response(null, { status })) as typeof fetch,
    })
    await assert.rejects(
      provider.synthesize({ text: '测试', voiceId: 'voice', format: 'wav' }),
      (error: unknown) => error instanceof SpeechProviderError
        && error.code === code
        && error.retryable === retryable,
    )
  }
})

