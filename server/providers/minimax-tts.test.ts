import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { afterEach, test } from 'node:test'

import {
  MiniMaxSpeechError,
  MiniMaxSpeechProvider,
  type MiniMaxSpeechErrorCode,
} from './minimax-tts.js'

const servers: Server[] = []
const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0x2a])

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server address')
  return `http://127.0.0.1:${address.port}`
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

async function expectSpeechError(
  operation: Promise<unknown>,
  code: MiniMaxSpeechErrorCode,
  retryable: boolean,
  upstreamStatus?: number,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof MiniMaxSpeechError)
    assert.equal(error.code, code)
    assert.equal(error.retryable, retryable)
    assert.equal(error.upstreamStatus, upstreamStatus)
    return true
  })
}

test('uses the official non-streaming T2A v2 contract and decodes hex audio', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/t2a_v2')
    assert.equal(request.headers.authorization, 'Bearer fixture-key')
    assert.equal(request.headers.accept, 'application/json')
    assert.match(request.headers['content-type'] ?? '', /^application\/json/)

    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      assert.deepEqual(body, {
        model: 'speech-2.8-hd',
        text: '阿离：我们出发。',
        stream: false,
        voice_setting: {
          voice_id: 'female-fixture',
          speed: 1.1,
          vol: 1.25,
          pitch: 2,
          emotion: 'happy',
        },
        audio_setting: {
          sample_rate: 32_000,
          bitrate: 128_000,
          format: 'mp3',
          channel: 1,
        },
        language_boost: 'Chinese',
        pronunciation_dict: { tone: ['阿离/(a1)(li2)'] },
        subtitle_enable: true,
        subtitle_type: 'word',
        output_format: 'hex',
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        data: {
          audio: MP3_BYTES.toString('hex'),
          subtitle_file: 'https://cdn.minimax.io/subtitles/fixture.json?token=signed',
          status: 2,
        },
        extra_info: {
          audio_length: 1_250,
          audio_sample_rate: 32_000,
          audio_size: MP3_BYTES.byteLength,
          bitrate: 128_000,
          word_count: 7,
          usage_characters: 9,
          audio_format: 'mp3',
          audio_channel: 1,
        },
        trace_id: 'trace-fixture',
        base_resp: { status_code: 0, status_msg: 'success' },
      }))
    })
  })

  const provider = new MiniMaxSpeechProvider({
    baseUrl: await listen(server),
    apiKey: 'fixture-key',
    model: 'speech-2.8-hd',
  })
  const result = await provider.synthesize({
    text: '阿离：我们出发。',
    voiceId: 'female-fixture',
    speed: 1.1,
    volume: 1.25,
    pitch: 2,
    emotion: 'happy',
    languageBoost: 'Chinese',
    pronunciationDictionary: ['阿离/(a1)(li2)'],
  })

  assert.equal(provider.configured, true)
  assert.equal(result.audio.kind, 'bytes')
  if (result.audio.kind !== 'bytes') assert.fail('expected inline audio')
  assert.equal(result.audio.sourceEncoding, 'hex')
  assert.deepEqual(Buffer.from(result.audio.bytes), MP3_BYTES)
  assert.equal(result.mimeType, 'audio/mpeg')
  assert.equal(result.durationMs, 1_250)
  assert.equal(result.audioSizeBytes, MP3_BYTES.byteLength)
  assert.equal(result.usageCharacters, 9)
  assert.deepEqual(result.subtitle, {
    url: 'https://cdn.minimax.io/subtitles/fixture.json?token=signed',
    granularity: 'word',
  })
  assert.equal(result.traceId, 'trace-fixture')
})

test('strictly decodes explicit JSON base64 audio from compatible gateways', async () => {
  const provider = new MiniMaxSpeechProvider({
    apiKey: 'fixture-key',
    maxAudioBytes: 1_024,
    fetch: (async () => jsonResponse({
      data: {
        audio: `data:audio/mpeg;base64,${MP3_BYTES.toString('base64')}`,
        status: 2,
      },
      extra_info: { audio_format: 'mp3', audio_size: MP3_BYTES.byteLength },
      base_resp: { status_code: 0, status_msg: 'success' },
    })) as typeof fetch,
  })

  const result = await provider.synthesize({ text: 'base64 fixture', voiceId: 'fixture' })
  assert.equal(result.audio.kind, 'bytes')
  if (result.audio.kind !== 'bytes') assert.fail('expected inline audio')
  assert.equal(result.audio.sourceEncoding, 'base64')
  assert.deepEqual(Buffer.from(result.audio.bytes), MP3_BYTES)
})

test('parses HTTPS audio and subtitle URLs without pretending they are persistent assets', async () => {
  const provider = new MiniMaxSpeechProvider({
    apiKey: 'fixture-key',
    fetch: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { output_format?: unknown; subtitle_type?: unknown }
      assert.equal(body.output_format, 'url')
      assert.equal(body.subtitle_type, 'sentence')
      return jsonResponse({
        data: {
          audio: 'https://cdn.minimax.io/audio/fixture.mp3?expires=123&signature=abc',
          subtitle_file: 'https://cdn.minimax.io/subtitles/fixture.json?expires=123',
          status: 2,
        },
        extra_info: { audio_format: 'mp3', audio_size: 12_345 },
        base_resp: { status_code: 0, status_msg: 'success' },
      })
    }) as typeof fetch,
  })

  const result = await provider.synthesize({
    text: 'URL fixture',
    voiceId: 'fixture',
    outputFormat: 'url',
    subtitleType: 'sentence',
  })
  assert.deepEqual(result.audio, {
    kind: 'url',
    url: 'https://cdn.minimax.io/audio/fixture.mp3?expires=123&signature=abc',
  })
  assert.deepEqual(result.subtitle, {
    url: 'https://cdn.minimax.io/subtitles/fixture.json?expires=123',
    granularity: 'sentence',
  })
})

test('classifies HTTP and MiniMax base_resp errors including HTTP 200 failures', async () => {
  const cases: Array<{
    response: Response
    code: MiniMaxSpeechErrorCode
    retryable: boolean
    upstreamStatus: number
  }> = [
    { response: new Response(null, { status: 401 }), code: 'PROVIDER_AUTH_FAILED', retryable: false, upstreamStatus: 401 },
    { response: new Response(null, { status: 429 }), code: 'PROVIDER_RATE_LIMITED', retryable: true, upstreamStatus: 429 },
    { response: new Response(null, { status: 503 }), code: 'UPSTREAM_UNAVAILABLE', retryable: true, upstreamStatus: 503 },
    { response: jsonResponse({ base_resp: { status_code: 1004, status_msg: 'auth' } }), code: 'PROVIDER_AUTH_FAILED', retryable: false, upstreamStatus: 1004 },
    { response: jsonResponse({ base_resp: { status_code: 1008, status_msg: 'balance' } }), code: 'PROVIDER_BALANCE_EXHAUSTED', retryable: false, upstreamStatus: 1008 },
    { response: jsonResponse({ base_resp: { status_code: 1002, status_msg: 'limited' } }), code: 'PROVIDER_RATE_LIMITED', retryable: true, upstreamStatus: 1002 },
    { response: jsonResponse({ base_resp: { status_code: 2056, status_msg: 'usage limit exceeded' } }), code: 'PROVIDER_USAGE_LIMIT_EXCEEDED', retryable: false, upstreamStatus: 2056 },
    { response: jsonResponse({ base_resp: { status_code: 1026, status_msg: 'sensitive' } }), code: 'CONTENT_REJECTED', retryable: false, upstreamStatus: 1026 },
    { response: jsonResponse({ base_resp: { status_code: 2013, status_msg: 'bad parameter' } }), code: 'INVALID_INPUT', retryable: false, upstreamStatus: 2013 },
    { response: jsonResponse({ base_resp: { status_code: 987_654, status_msg: 'new code' } }), code: 'UPSTREAM_ERROR', retryable: false, upstreamStatus: 987_654 },
  ]

  for (const fixture of cases) {
    const provider = new MiniMaxSpeechProvider({
      apiKey: 'fixture-key',
      fetch: (async () => fixture.response) as typeof fetch,
    })
    await expectSpeechError(
      provider.synthesize({ text: 'error fixture', voiceId: 'fixture' }),
      fixture.code,
      fixture.retryable,
      fixture.upstreamStatus,
    )
  }
})

test('never exposes the API key through provider errors', async () => {
  const secret = ['never', 'print', 'this'].join('-')
  const provider = new MiniMaxSpeechProvider({
    apiKey: secret,
    fetch: (async () => jsonResponse({
      base_resp: { status_code: 1004, status_msg: `invalid ${secret}` },
    })) as typeof fetch,
  })
  assert.equal(JSON.stringify(provider).includes(secret), false)

  await assert.rejects(
    provider.synthesize({ text: 'secret fixture', voiceId: 'fixture' }),
    (error: unknown) => {
      assert.ok(error instanceof MiniMaxSpeechError)
      assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`.includes(secret), false)
      return true
    },
  )
})

test('enforces an internal timeout and preserves caller cancellation', async () => {
  const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) return
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })) as typeof fetch

  const timeoutProvider = new MiniMaxSpeechProvider({
    apiKey: 'fixture-key',
    timeoutMs: 15,
    fetch: hangingFetch,
  })
  await expectSpeechError(
    timeoutProvider.synthesize({ text: 'timeout fixture', voiceId: 'fixture' }),
    'UPSTREAM_TIMEOUT',
    true,
  )

  const cancelProvider = new MiniMaxSpeechProvider({
    apiKey: 'fixture-key',
    timeoutMs: 1_000,
    fetch: hangingFetch,
  })
  const controller = new AbortController()
  const reason = new Error('caller cancelled fixture')
  const operation = cancelProvider.synthesize({ text: 'cancel fixture', voiceId: 'fixture' }, controller.signal)
  controller.abort(reason)
  await assert.rejects(operation, (error: unknown) => error === reason)
})

test('rejects malformed, incomplete, oversized, and unsafe success responses', async () => {
  const fixtures: Array<{
    response: Response
    outputFormat?: 'url'
    code?: MiniMaxSpeechErrorCode
    retryable?: boolean
  }> = [
    {
      response: new Response('{not-json', { headers: { 'content-type': 'application/json' } }),
    },
    {
      response: jsonResponse({ data: { audio: MP3_BYTES.toString('hex'), status: 2 } }),
    },
    {
      response: jsonResponse({
        data: { audio: MP3_BYTES.toString('hex'), status: 1 },
        base_resp: { status_code: 0 },
      }),
    },
    {
      response: jsonResponse({
        data: { audio_base64: 'not canonical base64!', status: 2 },
        base_resp: { status_code: 0 },
      }),
    },
    {
      response: jsonResponse({
        data: { audio: MP3_BYTES.toString('hex'), status: 2 },
        extra_info: { audio_format: 'mp3', audio_size: MP3_BYTES.byteLength + 1 },
        base_resp: { status_code: 0 },
      }),
    },
    {
      response: jsonResponse({
        data: { audio: 'https://127.0.0.1/private.mp3', status: 2 },
        base_resp: { status_code: 0 },
      }),
      outputFormat: 'url',
      retryable: false,
    },
    {
      response: new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'content-length': String(10 * 1024 * 1024),
        },
      }),
      code: 'AUDIO_TOO_LARGE',
      retryable: false,
    },
  ]

  for (const fixture of fixtures) {
    const provider = new MiniMaxSpeechProvider({
      apiKey: 'fixture-key',
      maxAudioBytes: 64,
      fetch: (async () => fixture.response) as typeof fetch,
    })
    await expectSpeechError(
      provider.synthesize({
        text: 'invalid response fixture',
        voiceId: 'fixture',
        ...(fixture.outputFormat ? { outputFormat: fixture.outputFormat } : {}),
      }),
      fixture.code ?? 'INVALID_RESPONSE',
      fixture.retryable ?? true,
    )
  }
})

test('validates configuration and request bounds before contacting MiniMax', async () => {
  const missing = new MiniMaxSpeechProvider({ apiKey: '  ' })
  assert.equal(missing.configured, false)
  await expectSpeechError(
    missing.synthesize({ text: 'fixture', voiceId: 'fixture' }),
    'PROVIDER_NOT_CONFIGURED',
    false,
  )

  let calls = 0
  const provider = new MiniMaxSpeechProvider({
    apiKey: 'fixture-key',
    fetch: (async () => {
      calls += 1
      return jsonResponse({})
    }) as typeof fetch,
  })
  const invalidInputs = [
    { text: '', voiceId: 'fixture' },
    { text: 'x'.repeat(10_000), voiceId: 'fixture' },
    { text: 'fixture', voiceId: '' },
    { text: 'fixture', voiceId: 'fixture', speed: 2.1 },
    { text: 'fixture', voiceId: 'fixture', volume: 0 },
    { text: 'fixture', voiceId: 'fixture', pitch: 0.5 },
    { text: 'fixture', voiceId: 'fixture', languageBoost: 'Klingon' },
    { text: 'fixture', voiceId: 'fixture', subtitleEnable: 'yes' },
  ]
  for (const input of invalidInputs) {
    await expectSpeechError(
      provider.synthesize(input as Parameters<MiniMaxSpeechProvider['synthesize']>[0]),
      'INVALID_INPUT',
      false,
    )
  }
  assert.equal(calls, 0)

  assert.throws(
    () => new MiniMaxSpeechProvider({ baseUrl: 'http://api.minimaxi.com', apiKey: 'fixture' }),
    /必须使用 HTTPS/,
  )
  assert.throws(
    () => new MiniMaxSpeechProvider({ baseUrl: 'https://secret@example.com', apiKey: 'fixture' }),
    /不能包含凭据/,
  )
})
