import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, test } from 'node:test'

import {
  SeedanceProviderError,
  SeedanceVideoProvider,
} from './seedance.js'

interface RecordedRequest {
  method: string
  url: string
  authorization: string | undefined
  body: unknown
}

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) as unknown : null
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not bind TCP')
  return `http://127.0.0.1:${address.port}/api/v3`
}

test('uses the documented Ark submit, poll, and delete contract against a local fixture server', async () => {
  const requests: RecordedRequest[] = []
  const baseUrl = await fixture(async (request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      authorization: request.headers.authorization,
      body: await requestBody(request),
    })
    if (request.method === 'POST') {
      sendJson(response, 200, { id: 'cgt-fixture-1' })
      return
    }
    if (request.method === 'GET') {
      sendJson(response, 200, {
        id: 'cgt-fixture-1',
        model: 'doubao-seedance-2-0-260128',
        status: 'succeeded',
        created_at: 1_718_049_470,
        updated_at: 1_718_049_590,
        content: { video_url: 'https://media.example/video.mp4?X-Signature=temporary' },
        duration: '6',
        resolution: '720p',
        ratio: '9:16',
        usage: { completion_tokens: 35_800 },
      })
      return
    }
    if (request.method === 'DELETE') {
      sendJson(response, 200, {})
      return
    }
    sendJson(response, 405, { error: { code: 'MethodNotAllowed' } })
  })
  const provider = new SeedanceVideoProvider({
    baseUrl,
    apiKey: 'fixture-secret',
    model: 'doubao-seedance-2-0-260128',
    allowInsecureLocalhost: true,
  })

  const created = await provider.createTask({
    prompt: '阿离在断崖回头，镜头缓慢推近。',
    aspectRatio: '9:16',
    resolution: '720p',
    durationSeconds: 6,
    generateAudio: true,
    referenceImages: [{
      url: 'https://assets.example/character.png?signature=short-lived',
      role: 'reference_image',
    }],
  })
  assert.deepEqual(created, { id: 'cgt-fixture-1' })

  const task = await provider.getTask(created.id)
  assert.deepEqual(task, {
    id: 'cgt-fixture-1',
    model: 'doubao-seedance-2-0-260128',
    status: 'succeeded',
    createdAt: 1_718_049_470,
    updatedAt: 1_718_049_590,
    videoUrl: 'https://media.example/video.mp4?X-Signature=temporary',
    durationSeconds: 6,
    resolution: '720p',
    aspectRatio: '9:16',
    completionTokens: 35_800,
    error: null,
  })
  assert.deepEqual(await provider.cancelTask(created.id), {
    capability: 'upstream-delete',
    outcome: 'requested',
  })

  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: 'POST', url: '/api/v3/contents/generations/tasks' },
    { method: 'GET', url: '/api/v3/contents/generations/tasks/cgt-fixture-1' },
    { method: 'DELETE', url: '/api/v3/contents/generations/tasks/cgt-fixture-1' },
  ])
  assert.ok(requests.every((request) => request.authorization === 'Bearer fixture-secret'))
  assert.deepEqual(requests[0].body, {
    model: 'doubao-seedance-2-0-260128',
    content: [
      {
        type: 'text',
        text: '阿离在断崖回头，镜头缓慢推近。\n--ratio 9:16 --dur 6 --resolution 720p',
      },
      {
        type: 'image_url',
        image_url: { url: 'https://assets.example/character.png?signature=short-lived' },
        role: 'reference_image',
      },
    ],
    generate_audio: true,
    ratio: '9:16',
    duration: 6,
    resolution: '720p',
    watermark: false,
    return_last_frame: false,
  })
})

test('uses the same native Ark task contract on the Agent Plan route', async () => {
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const provider = new SeedanceVideoProvider({
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    apiKey: 'fixture-plan-key',
    model: 'doubao-seedance-2.0',
    fetch: (async (input, init) => {
      requests.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      if (init?.method === 'POST') return Response.json({ id: 'plan-task-1' })
      if (init?.method === 'GET') {
        return Response.json({
          id: 'plan-task-1',
          model: 'doubao-seedance-2.0',
          status: 'queued',
          created_at: 100,
        })
      }
      return Response.json({})
    }) as typeof fetch,
  })

  assert.equal(provider.protocol, 'ark')
  const created = await provider.createTask({
    prompt: '云海中的古风角色转身。',
    aspectRatio: '16:9',
    resolution: '720p',
    durationSeconds: 5,
    generateAudio: false,
  })
  await provider.getTask(created.id)
  await provider.cancelTask(created.id)

  assert.deepEqual(requests.map((request) => ({ method: request.method, url: request.url })), [
    { method: 'POST', url: 'https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks' },
    { method: 'GET', url: 'https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks/plan-task-1' },
    { method: 'DELETE', url: 'https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks/plan-task-1' },
  ])
  assert.equal((requests[0].body as { model: string }).model, 'doubao-seedance-2.0')
})

test('uses the NewAPI OpenAI-video contract for a configurable gateway without paid fallback', async () => {
  const requests: RecordedRequest[] = []
  const arkShapedFixtureUrl = await fixture(async (request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      authorization: request.headers.authorization,
      body: await requestBody(request),
    })
    if (request.method === 'POST' && request.url === '/v1/videos') {
      sendJson(response, 200, {
        id: 'task_public_1',
        task_id: 'task_public_1',
        object: 'video',
        model: 'doubao-seedance-2-0-260128',
        status: 'queued',
        progress: 0,
        created_at: 100,
      })
      return
    }
    if (request.method === 'GET' && request.url === '/v1/videos/task_public_1') {
      sendJson(response, 200, {
        id: 'task_public_1',
        object: 'video',
        model: 'doubao-seedance-2-0-260128',
        status: 'completed',
        progress: 100,
        created_at: 100,
        completed_at: 120,
        seconds: '4',
        size: '854x480',
        metadata: {
          url: 'https://media.example/newapi-video.mp4?signature=temporary',
          ratio: '16:9',
        },
      })
      return
    }
    sendJson(response, 500, { error: { code: 'unexpected_request' } })
  })
  const baseUrl = arkShapedFixtureUrl.replace(/\/api\/v3$/, '')
  const provider = new SeedanceVideoProvider({
    baseUrl,
    apiKey: 'fixture-newapi-secret',
    model: 'doubao-seedance-2-0-260128',
    allowInsecureLocalhost: true,
  })
  assert.equal(provider.protocol, 'newapi')

  const created = await provider.createTask({
    prompt: '国风漫剧镜头，云海缓慢流动。',
    aspectRatio: '16:9',
    resolution: '480p',
    durationSeconds: 4,
    generateAudio: false,
  })
  assert.deepEqual(created, { id: 'task_public_1' })
  assert.deepEqual(await provider.getTask(created.id), {
    id: 'task_public_1',
    model: 'doubao-seedance-2-0-260128',
    status: 'succeeded',
    createdAt: 100,
    updatedAt: 120,
    videoUrl: 'https://media.example/newapi-video.mp4?signature=temporary',
    durationSeconds: 4,
    resolution: '854x480',
    aspectRatio: '16:9',
    completionTokens: null,
    error: null,
  })
  assert.deepEqual(await provider.cancelTask(created.id), {
    capability: 'local-only',
    outcome: 'unsupported',
  })

  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: 'POST', url: '/v1/videos' },
    { method: 'GET', url: '/v1/videos/task_public_1' },
  ])
  assert.ok(requests.every((request) => request.authorization === 'Bearer fixture-newapi-secret'))
  assert.deepEqual(requests[0].body, {
    model: 'doubao-seedance-2-0-260128',
    prompt: '国风漫剧镜头，云海缓慢流动。',
    duration: 4,
    seconds: '4',
    metadata: {
      content: [],
      duration: 4,
      resolution: '480p',
      ratio: '16:9',
      generate_audio: false,
      watermark: false,
      return_last_frame: false,
    },
  })
})

test('captures only sanitized NewAPI HTTP diagnostics without retaining the response body', async () => {
  let requestedUrl = ''
  const rawProviderMessage = 'internal route detail with credential-like material'
  const provider = new SeedanceVideoProvider({
    baseUrl: 'https://gateway.example',
    apiKey: 'fixture-secret',
    fetch: (async (input) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({
        error: { code: 'route_not_found', message: rawProviderMessage },
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  })

  await assert.rejects(
    provider.createTask({
      prompt: '离线诊断夹具',
      aspectRatio: '16:9',
      resolution: '720p',
      durationSeconds: 5,
      generateAudio: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SeedanceProviderError)
      assert.deepEqual(error.diagnostic, {
        operation: 'create',
        protocol: 'newapi',
        endpointFamily: 'openai-videos',
        httpStatus: 404,
        providerCode: 'route_not_found',
      })
      assert.equal(JSON.stringify(error).includes(rawProviderMessage), false)
      return true
    },
  )
  assert.equal(requestedUrl, 'https://gateway.example/v1/videos')
})

test('maps content rejection, authentication, 429, and 5xx to safe retry metadata', async (t) => {
  const cases = [
    {
      name: 'content rejection',
      status: 400,
      body: { error: { code: 'InputTextSensitiveContentDetected', message: 'unsafe secret detail' } },
      code: 'CONTENT_REJECTED',
      retryable: false,
    },
    {
      name: 'authentication',
      status: 403,
      body: { error: { code: 'PermissionDenied', message: 'fixture-secret leaked' } },
      code: 'PROVIDER_AUTH_FAILED',
      retryable: false,
    },
    {
      name: 'billing unavailable',
      status: 403,
      body: { error: { code: 'AccountOverdueError', message: 'private billing detail' } },
      code: 'PROVIDER_BILLING_UNAVAILABLE',
      retryable: false,
    },
    {
      name: 'rate limit',
      status: 429,
      body: { error: { code: 'QuotaExceeded', message: 'queue is full' } },
      code: 'PROVIDER_RATE_LIMITED',
      retryable: true,
    },
    {
      name: 'upstream unavailable',
      status: 503,
      body: { error: { code: 'ServiceUnavailable', message: '/private/provider/path' } },
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
    },
  ] as const

  for (const item of cases) {
    await t.test(item.name, async () => {
      const baseUrl = await fixture((_request, response) => sendJson(response, item.status, item.body))
      const provider = new SeedanceVideoProvider({
        baseUrl,
        apiKey: 'fixture-secret',
        allowInsecureLocalhost: true,
      })
      await assert.rejects(
        provider.createTask({
          prompt: '合法提示词',
          aspectRatio: '16:9',
          resolution: '720p',
          durationSeconds: 5,
          generateAudio: false,
        }),
        (error) => {
          assert.ok(error instanceof SeedanceProviderError)
          assert.equal(error.code, item.code)
          assert.equal(error.retryable, item.retryable)
          assert.doesNotMatch(error.message, /fixture-secret|private\/provider|unsafe secret detail/)
          return true
        },
      )
    })
  }
})

test('rejects malformed/oversized payloads and invalid requests before unsafe use', async () => {
  let calls = 0
  const baseUrl = await fixture((_request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{not-json')
  })
  const provider = new SeedanceVideoProvider({
    baseUrl,
    apiKey: 'fixture-secret',
    allowInsecureLocalhost: true,
  })
  await assert.rejects(
    provider.createTask({
      prompt: '合法提示词',
      aspectRatio: '16:9',
      resolution: '720p',
      durationSeconds: 5,
      generateAudio: false,
    }),
    (error) => error instanceof SeedanceProviderError && error.code === 'INVALID_RESPONSE',
  )
  assert.equal(calls, 1)

  await assert.rejects(
    provider.createTask({
      prompt: '时长无效',
      aspectRatio: '16:9',
      resolution: '720p',
      durationSeconds: 3,
      generateAudio: false,
    }),
    (error) => error instanceof SeedanceProviderError && error.code === 'INVALID_VIDEO_REQUEST',
  )
  await assert.rejects(
    provider.createTask({
      prompt: '私有参考 URL 不应交给 Provider',
      aspectRatio: '16:9',
      resolution: '720p',
      durationSeconds: 5,
      generateAudio: false,
      referenceImages: [{ url: 'http://127.0.0.1/internal.png', role: 'reference_image' }],
    }),
    (error) => error instanceof SeedanceProviderError && error.code === 'INVALID_VIDEO_REQUEST',
  )
  await assert.rejects(
    provider.createTask({
      prompt: '互斥图片模式',
      aspectRatio: '16:9',
      resolution: '720p',
      durationSeconds: 5,
      generateAudio: false,
      referenceImages: [
        { url: 'https://assets.example/first.png', role: 'first_frame' },
        { url: 'https://assets.example/reference.png', role: 'reference_image' },
      ],
    }),
    (error) => error instanceof SeedanceProviderError && error.code === 'INVALID_VIDEO_REQUEST',
  )
  await assert.rejects(
    provider.createTask({
      prompt: '尾帧不能单独使用',
      aspectRatio: '16:9',
      resolution: '720p',
      durationSeconds: 5,
      generateAudio: false,
      referenceImages: [{ url: 'https://assets.example/last.png', role: 'last_frame' }],
    }),
    (error) => error instanceof SeedanceProviderError && error.code === 'INVALID_VIDEO_REQUEST',
  )
  assert.equal(calls, 1)
})

test('accepts failed task state without persisting raw upstream messages and treats DELETE 404 as idempotent', async () => {
  const baseUrl = await fixture((request, response) => {
    if (request.method === 'DELETE') {
      sendJson(response, 404, { error: { code: 'NotFound', message: 'gone' } })
      return
    }
    sendJson(response, 200, {
      id: 'cgt-failed',
      model: 'doubao-seedance-2-0-260128',
      status: 'failed',
      error: {
        code: 'OutputVideoSensitiveContentDetected',
        message: 'raw provider detail that must not escape',
      },
      created_at: 1,
      updated_at: 2,
    })
  })
  const provider = new SeedanceVideoProvider({
    baseUrl,
    apiKey: 'fixture-secret',
    allowInsecureLocalhost: true,
  })
  const task = await provider.getTask('cgt-failed')
  assert.equal(task.status, 'failed')
  assert.deepEqual(task.error, {
    code: 'OutputVideoSensitiveContentDetected',
    message: 'Seedance 内容安全检查未通过',
  })
  assert.deepEqual(await provider.cancelTask('cgt-failed'), {
    capability: 'upstream-delete',
    outcome: 'task-not-found',
  })
})

test('maps NewAPI task_not_exist and rejects conflicting public task ids', async () => {
  const missingBaseUrl = (await fixture((_request, response) => sendJson(response, 400, {
    error: { code: 'task_not_exist', message: 'internal detail' },
  }))).replace(/\/api\/v3$/, '')
  const missingProvider = new SeedanceVideoProvider({
    baseUrl: missingBaseUrl,
    apiKey: 'fixture-secret',
    allowInsecureLocalhost: true,
  })
  await assert.rejects(
    missingProvider.getTask('task_missing'),
    (error) => error instanceof SeedanceProviderError
      && error.code === 'TASK_NOT_FOUND'
      && !error.retryable,
  )

  const conflictingBaseUrl = (await fixture((_request, response) => sendJson(response, 200, {
    id: 'task_one',
    task_id: 'task_two',
    status: 'queued',
  }))).replace(/\/api\/v3$/, '')
  const conflictingProvider = new SeedanceVideoProvider({
    baseUrl: conflictingBaseUrl,
    apiKey: 'fixture-secret',
    allowInsecureLocalhost: true,
  })
  await assert.rejects(
    conflictingProvider.createTask({
      prompt: '合法提示词',
      aspectRatio: '16:9',
      resolution: '480p',
      durationSeconds: 4,
      generateAudio: false,
    }),
    (error) => error instanceof SeedanceProviderError && error.code === 'INVALID_RESPONSE',
  )
})

test('parses the official expired terminal state without treating it as a malformed poll response', async () => {
  const baseUrl = await fixture((_request, response) => sendJson(response, 200, {
    id: 'cgt-expired',
    model: 'doubao-seedance-2-0-260128',
    status: 'expired',
    created_at: 1,
    updated_at: 2,
  }))
  const provider = new SeedanceVideoProvider({
    baseUrl,
    apiKey: 'fixture-secret',
    allowInsecureLocalhost: true,
  })

  const task = await provider.getTask('cgt-expired')
  assert.equal(task.status, 'expired')
  assert.equal(task.videoUrl, null)
  assert.equal(task.error, null)
})

test('bounds create, get, and cancel HTTP exchanges with a configurable single-request timeout', async () => {
  const methods: string[] = []
  const stalledFetch = ((_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET')
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) throw new Error('fixture expected a request signal')
      const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }) as typeof fetch
  const provider = new SeedanceVideoProvider({
    apiKey: 'fixture-secret',
    fetch: stalledFetch,
    requestTimeoutMs: 10,
  })
  const expectTimeout = (promise: Promise<unknown>) => assert.rejects(
    promise,
    (error) => error instanceof SeedanceProviderError
      && error.code === 'UPSTREAM_TIMEOUT'
      && error.retryable,
  )

  await expectTimeout(provider.createTask({
    prompt: '合法提示词',
    aspectRatio: '16:9',
    resolution: '720p',
    durationSeconds: 5,
    generateAudio: false,
  }))
  await expectTimeout(provider.getTask('cgt-timeout'))
  await expectTimeout(provider.cancelTask('cgt-timeout'))
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE'])

  assert.throws(
    () => new SeedanceVideoProvider({ apiKey: 'fixture-secret', requestTimeoutMs: 120_001 }),
    /requestTimeoutMs must be between/,
  )
})

test('preserves a caller abort instead of misclassifying it as the provider request timeout', async () => {
  const stalledFetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>(
    (_resolve, reject) => {
      const signal = init?.signal
      if (!signal) throw new Error('fixture expected a request signal')
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    },
  )) as typeof fetch
  const provider = new SeedanceVideoProvider({
    apiKey: 'fixture-secret',
    fetch: stalledFetch,
    requestTimeoutMs: 1_000,
  })
  const controller = new AbortController()
  const reason = new Error('worker cancelled fixture')
  const pending = provider.getTask('cgt-caller-abort', controller.signal)
  controller.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
})
