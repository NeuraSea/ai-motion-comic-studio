import assert from 'node:assert/strict'
import test from 'node:test'

import { DoubaoSpeechProvider } from './doubao-speech.js'
import { SpeechProviderError } from './minimax-tts.js'

const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

test('DoubaoSpeechProvider calls Agent Plan HTTP TTS with dedicated key and aggregates NDJSON audio', async () => {
  let request: Request | undefined
  const provider = new DoubaoSpeechProvider({
    apiKey: 'secret-plan-key',
    fetch: async (input, init) => {
      request = new Request(input, init)
      const first = JSON.stringify({ code: 0, message: '', data: MP3.subarray(0, 4).toString('base64') })
      const second = JSON.stringify({ code: 0, message: '', data: MP3.subarray(4).toString('base64') })
      const done = JSON.stringify({ code: 20000000, message: 'OK', data: null, usage: { text_words: 2 } })
      return new Response(`${first}\n${second}\n${done}\n`, {
        headers: { 'content-type': 'application/json', 'x-tt-logid': 'log-1' },
      })
    },
  })

  const result = await provider.synthesize({
    text: '你好',
    voiceId: 'zh_female_vv_uranus_bigtts',
    speed: 1.25,
    volume: 0.8,
    pitch: 2,
    emotion: 'happy',
    format: 'mp3',
    sampleRate: 24_000,
    bitrate: 128_000,
    channels: 1,
  })

  assert.equal(request?.url, 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional')
  assert.equal(request?.headers.get('x-api-key'), 'secret-plan-key')
  assert.equal(request?.headers.get('x-api-resource-id'), 'seed-tts-2.0')
  const body = JSON.parse(await request!.text())
  assert.equal(body.req_params.audio_params.speech_rate, 25)
  assert.equal(body.req_params.audio_params.loudness_rate, -20)
  assert.equal(JSON.parse(body.req_params.additions).post_process.pitch, 2)
  assert.deepEqual(Buffer.from(result.audio.kind === 'bytes' ? result.audio.bytes : []), MP3)
  assert.equal(result.usageCharacters, 2)
  assert.equal(result.traceId, 'log-1')
})

test('DoubaoSpeechProvider maps business authentication errors without exposing upstream text', async () => {
  const provider = new DoubaoSpeechProvider({
    apiKey: 'bad-key',
    fetch: async () => new Response(`${JSON.stringify({ code: 45000000, message: 'load grant: requested grant not found secret-value' })}\n`),
  })
  await assert.rejects(
    provider.synthesize({ text: '测试', voiceId: 'voice', format: 'mp3' }),
    (error: unknown) => error instanceof SpeechProviderError
      && error.code === 'PROVIDER_AUTH_FAILED'
      && !error.message.includes('secret-value'),
  )
})

test('DoubaoSpeechProvider refuses unsupported WAV before sending a billable request', async () => {
  let called = false
  const provider = new DoubaoSpeechProvider({
    apiKey: 'key',
    fetch: async () => {
      called = true
      throw new Error('must not call')
    },
  })
  await assert.rejects(
    provider.synthesize({ text: '测试', voiceId: 'voice', format: 'wav' }),
    (error: unknown) => error instanceof SpeechProviderError && error.code === 'INVALID_INPUT',
  )
  assert.equal(called, false)
})
