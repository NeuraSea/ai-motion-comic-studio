import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { afterEach, test } from 'node:test'

import { OpenAICompatibleTextProvider, TextProviderError } from './text.js'

const servers: Server[] = []

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

test('lists models and performs one deterministic repair after an invalid structured response', async () => {
  let generations = 0
  let repairKey = ''
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-key')
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'story-model' }] }))
      return
    }
    assert.equal(request.url, '/v1/chat/completions')
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ content: string }> }
      generations += 1
      assert.equal(body.messages.length, 2)
      if (generations === 1) {
        assert.equal(request.headers['idempotency-key'], 'story-once')
      } else {
        assert.match(String(request.headers['idempotency-key']), /^llm-repair-v1-[a-f0-9]{64}$/)
        repairKey = String(request.headers['idempotency-key'])
        assert.match(body.messages[0]!.content, /唯一允许的 JSON 修复轮/)
        assert.match(body.messages[1]!.content, /ok 必须为 true/)
        assert.match(body.messages[1]!.content, /\{"ok":false\}/)
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{ message: { content: generations === 1 ? '{"ok":false}' : '{"ok":true}' } }],
      }))
    })
  })
  const baseUrl = await listen(server)
  const provider = new OpenAICompatibleTextProvider({ baseUrl, apiKey: 'fixture-key', model: 'story-model' })
  assert.deepEqual(await provider.listModels(), ['story-model'])

  const output = await provider.generateStructured(
    {
      systemPrompt: '返回 JSON',
      userPrompt: '生成剧本',
      schemaName: 'fixture',
      schema: { type: 'object' },
      idempotencyKey: 'story-once',
    },
    (value) => {
      if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) {
        throw Object.assign(new Error('not ok'), { issues: ['ok 必须为 true'] })
      }
      return value as { ok: true }
    },
    new AbortController().signal,
  )
  assert.deepEqual(output, { ok: true })
  assert.equal(generations, 2)
  assert.match(repairKey, /^llm-repair-v1-[a-f0-9]{64}$/)
})

test('a failed repair stops after exactly two exchanges and reports only local validation', async () => {
  let calls = 0
  const secretEcho = 'sk-never-persist-from-model-output'
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1
    const request = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> }
    if (calls === 2) {
      assert.match(String(init?.headers && (init.headers as Record<string, string>)['idempotency-key']), /^llm-repair-v1-/)
      assert.match(request.messages?.[0]?.content ?? '', /唯一允许的 JSON 修复轮/)
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ok: false, upstream: secretEcho }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const provider = new OpenAICompatibleTextProvider({
    baseUrl: 'https://text-provider.example',
    apiKey: 'fixture-key',
    model: 'story-model',
    fetch: fetcher,
  })

  await assert.rejects(provider.generateStructured(
    {
      systemPrompt: '返回 JSON',
      userPrompt: '生成剧本',
      schemaName: 'fixture',
      schema: { type: 'object' },
      idempotencyKey: 'durable-job-key',
    },
    (value) => {
      if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) {
        throw Object.assign(new Error('invalid'), { issues: ['ok 必须为 true'] })
      }
      return value
    },
    new AbortController().signal,
  ), (error: unknown) => {
    assert.ok(error instanceof TextProviderError)
    assert.equal(error.code, 'INVALID_STRUCTURED_RESPONSE')
    assert.equal(error.retryable, false)
    assert.match(error.message, /一次修复后/)
    assert.equal(error.message.includes(secretEcho), false)
    return true
  })
  assert.equal(calls, 2)
})

test('Codex Tools mode uses the Responses JSON schema contract and explicit reasoning effort', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/responses')
    assert.equal(request.headers.authorization, 'Bearer fixture-key')
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        reasoning?: { effort?: string }
        input?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>
        text?: { format?: { type?: string; name?: string; strict?: boolean; schema?: unknown } }
      }
      assert.equal(body.reasoning?.effort, 'medium')
      assert.equal(body.input?.[0]?.role, 'system')
      assert.equal(body.input?.[0]?.content?.[0]?.type, 'input_text')
      assert.equal(body.text?.format?.type, 'json_schema')
      assert.equal(body.text?.format?.name, 'fixture')
      assert.equal(body.text?.format?.strict, true)
      assert.deepEqual(body.text?.format?.schema, { type: 'object' })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      }))
    })
  })
  const provider = new OpenAICompatibleTextProvider({
    baseUrl: await listen(server),
    apiKey: 'fixture-key',
    model: 'gpt-5.5',
    protocol: 'responses',
    reasoningEffort: 'medium',
  })

  const output = await provider.generateStructured(
    {
      systemPrompt: '返回 JSON',
      userPrompt: '生成剧本',
      schemaName: 'fixture',
      schema: { type: 'object' },
    },
    (value) => value as { ok: true },
    new AbortController().signal,
  )
  assert.deepEqual(output, { ok: true })
})

test('visual structured generation sends labelled local images without silently degrading to text', async () => {
  let calls = 0
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/responses')
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      calls += 1
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        input?: Array<{
          role?: string
          content?: Array<{
            type?: string
            text?: string
            image_url?: string
            detail?: string
          }>
        }>
      }
      const content = body.input?.[1]?.content ?? []
      assert.equal(body.input?.[1]?.role, 'user')
      assert.deepEqual(content.map((item) => item.type), [
        'input_text',
        'input_text',
        'input_image',
      ])
      assert.equal(content[1]?.text, 'IMAGE_LABEL: SHOT_sh0_STORYBOARD')
      assert.equal(content[2]?.image_url, dataUrl)
      assert.equal(content[2]?.detail, 'low')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ output_text: '{"shotId":"sh0"}' }))
    })
  })
  const provider = new OpenAICompatibleTextProvider({
    baseUrl: await listen(server),
    apiKey: 'fixture-key',
    model: 'gpt-5.5',
    protocol: 'responses',
  })
  const output = await provider.generateVisualStructured(
    {
      systemPrompt: '只根据图像证据选择',
      userPrompt: '分析 sh0',
      schemaName: 'shot_reference_plan',
      schema: { type: 'object' },
      images: [{ label: 'SHOT_sh0_STORYBOARD', dataUrl }],
    },
    (value) => value as { shotId: string },
    new AbortController().signal,
  )
  assert.deepEqual(output, { shotId: 'sh0' })
  assert.equal(calls, 1)

  await assert.rejects(provider.generateVisualStructured(
    {
      systemPrompt: '只根据图像证据选择',
      userPrompt: '分析 sh0',
      schemaName: 'shot_reference_plan',
      schema: { type: 'object' },
      images: [{ label: 'SHOT_sh0_STORYBOARD', dataUrl: 'https://localhost/private.png' }],
    },
    (value) => value,
    new AbortController().signal,
  ), (error: unknown) => {
    assert.ok(error instanceof TextProviderError)
    assert.equal(error.code, 'INVALID_STRUCTURED_RESPONSE')
    return true
  })
  assert.equal(calls, 1)
})

test('chat-completions visual contract uses labelled image_url content', async () => {
  const dataUrl = 'data:image/jpeg;base64,/9j/2Q=='
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions')
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{
          content?: string | Array<{
            type?: string
            text?: string
            image_url?: { url?: string; detail?: string }
          }>
        }>
      }
      const content = body.messages?.[1]?.content
      assert.ok(Array.isArray(content))
      assert.equal(content[1]?.text, 'IMAGE_LABEL: PROP_TOKEN')
      assert.equal(content[2]?.type, 'image_url')
      assert.equal(content[2]?.image_url?.url, dataUrl)
      assert.equal(content[2]?.image_url?.detail, 'high')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }))
    })
  })
  const provider = new OpenAICompatibleTextProvider({
    baseUrl: await listen(server),
    apiKey: 'fixture-key',
    model: 'vision-model',
  })
  await provider.generateVisualStructured(
    {
      systemPrompt: 'vision',
      userPrompt: 'select',
      schemaName: 'fixture',
      schema: { type: 'object' },
      images: [{ label: 'PROP_TOKEN', dataUrl, detail: 'high' }],
    },
    (value) => value,
    new AbortController().signal,
  )
})

test('auth failures are non-retryable and do not expose the key', async () => {
  const secret = ['do', 'not', 'leak'].join('-')
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: '无效凭据' } }))
  })
  const provider = new OpenAICompatibleTextProvider({
    baseUrl: await listen(server),
    apiKey: secret,
    model: 'story-model',
  })
  await assert.rejects(provider.listModels(), (error: unknown) => {
    assert.ok(error instanceof TextProviderError)
    assert.equal(error.code, 'PROVIDER_AUTH_FAILED')
    assert.equal(error.retryable, false)
    assert.equal(JSON.stringify(error).includes(secret), false)
    return true
  })
})

test('rejects an oversized chunked response before buffering the complete body', async () => {
  const chunkBytes = 64 * 1024
  let pulls = 0
  let cancelled = false
  const fetcher = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20))
      if (pulls >= 40) controller.close()
    },
    cancel() {
      cancelled = true
    },
  }), { status: 200 })) as typeof fetch
  const provider = new OpenAICompatibleTextProvider({
    baseUrl: 'https://text-provider.example',
    apiKey: 'fixture-key',
    model: 'story-model',
    fetch: fetcher,
  })

  await assert.rejects(provider.listModels(), (error: unknown) => {
    assert.ok(error instanceof TextProviderError)
    assert.equal(error.code, 'UPSTREAM_ERROR')
    assert.equal(error.retryable, false)
    assert.match(error.message, /响应过大/)
    return true
  })
  assert.equal(cancelled, true)
  assert.ok(pulls < 40, 'reader must stop pulling after the byte cap is crossed')
})

test('enforces a complete adapter deadline while the response body is stalled', async () => {
  let requestSignal: AbortSignal | undefined
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined
    return new Response(new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined)
      },
    }), { status: 200 })
  }) as typeof fetch
  const provider = new OpenAICompatibleTextProvider({
    baseUrl: 'https://text-provider.example',
    apiKey: 'fixture-key',
    model: 'story-model',
    requestTimeoutMs: 15,
    fetch: fetcher,
  })
  const caller = new AbortController()

  await assert.rejects(provider.listModels(caller.signal), (error: unknown) => {
    assert.ok(error instanceof TextProviderError)
    assert.equal(error.code, 'UPSTREAM_UNAVAILABLE')
    assert.equal(error.retryable, true)
    assert.match(error.message, /响应超时/)
    return true
  })
  assert.equal(caller.signal.aborted, false)
  assert.equal(requestSignal?.aborted, true)
})

test('never persists an upstream error body that echoes credentials, paths, or source text', async () => {
  const secret = 'sk-provider-secret-must-not-persist'
  const systemPrompt = '系统规则：不得泄漏原文'
  const sourceText = '未公开小说正文：月落乌啼，角色转身。'
  let calls = 0
  const fetcher = (async () => {
    calls += 1
    return new Response(JSON.stringify({
      error: {
        message: `Bearer ${secret} failed at file:///Users/author/private/story.txt\n${systemPrompt}\n${sourceText}`,
      },
    }), { status: 500, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const provider = new OpenAICompatibleTextProvider({
    baseUrl: 'https://text-provider.example',
    apiKey: secret,
    model: 'story-model',
    fetch: fetcher,
  })

  await assert.rejects(provider.generateStructured(
    {
      systemPrompt,
      userPrompt: sourceText,
      schemaName: 'fixture',
      schema: { type: 'object' },
    },
    (value) => value,
    new AbortController().signal,
  ), (error: unknown) => {
    assert.ok(error instanceof TextProviderError)
    const persistedProjection = JSON.stringify({
      code: error.code,
      message: error.message,
      stack: error.stack,
    })
    assert.equal(persistedProjection.includes(secret), false)
    assert.equal(persistedProjection.includes('/Users/author/private/story.txt'), false)
    assert.equal(persistedProjection.includes(systemPrompt), false)
    assert.equal(persistedProjection.includes(sourceText), false)
    assert.equal(error.message, '文本 Provider 请求失败 (500)')
    return true
  })
  assert.equal(calls, 1, 'HTTP/provider failures must never trigger schema repair')
})
