import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  CodexToolsImageProvider,
  createCodexToolsCredentialSource,
  ImageProviderError,
} from './codex-tools.js'
import type { ProviderImageReference } from '../types.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('Codex Tools credential source observes create, rotate, and delete without a restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-codex-tools-credential-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const keyPath = join(directory, 'api-proxy.key')
  const env = { CODEX_TOOLS_API_KEY_FILE: keyPath } as NodeJS.ProcessEnv
  const source = createCodexToolsCredentialSource(env)

  assert.equal(await source.exists(), false)
  assert.equal(await source.load(), null)

  await writeFile(keyPath, 'proxy-key-v1\n', { mode: 0o600 })
  assert.equal(await source.exists(), true)
  assert.equal(await source.load(), 'proxy-key-v1')

  await writeFile(keyPath, 'proxy-key-v2\n', { mode: 0o600 })
  assert.equal(await source.load(), 'proxy-key-v2')

  env.CODEX_TOOLS_API_KEY = 'environment-key-v3'
  assert.equal(await source.load(), 'environment-key-v3')
  delete env.CODEX_TOOLS_API_KEY
  assert.equal(await source.load(), 'proxy-key-v2')

  await unlink(keyPath)
  assert.equal(await source.exists(), false)
  assert.equal(await source.load(), null)
  assert.equal(JSON.stringify(source).includes('proxy-key'), false)
  assert.equal(JSON.stringify(source).includes('environment-key'), false)
})

test('Codex Tools sends controlled references to images/edits as OpenAI-compatible multipart', async () => {
  let calls = 0
  globalThis.fetch = async (input, init) => {
    calls += 1
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    assert.equal(url, 'https://image-provider.example/v1/images/edits')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer test-image-key')
    assert.equal(headers.get('content-type'), null, 'fetch must add the multipart boundary')
    assert.ok(init?.body instanceof FormData)
    const form = init.body
    assert.equal(form.get('model'), 'gpt-image-2')
    assert.equal(form.get('prompt'), '保持角色一致')
    assert.equal(form.get('n'), '1')
    assert.equal(form.get('size'), '1536x1024')
    assert.equal(form.get('quality'), 'high')
    assert.equal(form.get('response_format'), 'b64_json')
    assert.equal(form.get('output_format'), 'png')
    const images = form.getAll('image')
    assert.equal(images.length, 2)
    for (const [index, image] of images.entries()) {
      assert.ok(image instanceof Blob)
      assert.equal(image.type, index === 0 ? 'image/png' : 'image/jpeg')
      assert.equal((image as File).name, index === 0 ? 'reference-1.png' : 'reference-2.jpg')
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), ONE_PIXEL_PNG)
      assert.equal((image as File).name.includes('asset-id'), false)
      assert.equal((image as File).name.includes('/'), false)
    }
    return new Response(JSON.stringify({
      data: [{ b64_json: ONE_PIXEL_PNG.toString('base64') }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const provider = new CodexToolsImageProvider({
    baseUrl: 'https://image-provider.example/v1',
    apiKey: 'test-image-key',
  })
  const references: ProviderImageReference[] = [
    { bytes: ONE_PIXEL_PNG, mimeType: 'image/png' },
    { bytes: ONE_PIXEL_PNG, mimeType: 'image/jpeg' },
  ]
  const result = await provider.generate({
    prompt: '保持角色一致',
    count: 1,
    size: '1536x1024',
    quality: 'high',
  }, new AbortController().signal, references)
  assert.equal(calls, 1)
  assert.deepEqual(Buffer.from(result[0].bytes), ONE_PIXEL_PNG)
})

test('reference protocol rejection is explicit and never falls back to text-only generations', async () => {
  const urls: string[] = []
  globalThis.fetch = async (input) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    return new Response(JSON.stringify({
      error: { message: 'unsupported /private/provider/path test-image-key' },
    }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  const provider = new CodexToolsImageProvider({
    baseUrl: 'https://custom-image.example/v1',
    apiKey: 'test-image-key',
    model: 'custom-image-model',
  })
  await assert.rejects(
    provider.generate({
      prompt: '不能降级',
      count: 1,
      size: '1024x1024',
      quality: 'medium',
    }, new AbortController().signal, [{ bytes: ONE_PIXEL_PNG, mimeType: 'image/png' }]),
    (error: unknown) => {
      assert.ok(error instanceof ImageProviderError)
      assert.equal(error.code, 'REFERENCE_IMAGES_UNSUPPORTED')
      assert.equal(error.retryable, false)
      assert.equal(error.message.includes('test-image-key'), false)
      assert.equal(error.message.includes('/private/'), false)
      return true
    },
  )
  assert.deepEqual(urls, ['https://custom-image.example/v1/images/edits'])
})

test('generation without references keeps the JSON images/generations contract', async () => {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    assert.equal(url, 'https://image-provider.example/v1/images/generations')
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    assert.deepEqual(body, {
      model: 'legacy-model',
      prompt: '旧生成路径',
      n: 1,
      size: '1024x1024',
      quality: 'medium',
      response_format: 'b64_json',
      output_format: 'png',
    })
    return new Response(JSON.stringify({
      data: [{ b64_json: ONE_PIXEL_PNG.toString('base64') }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const provider = new CodexToolsImageProvider({
    baseUrl: 'https://image-provider.example',
    apiKey: 'test-image-key',
    model: 'legacy-model',
  })
  const result = await provider.generate({
    prompt: '旧生成路径',
    count: 1,
    size: '1024x1024',
    quality: 'medium',
  }, new AbortController().signal)
  assert.deepEqual(Buffer.from(result[0].bytes), ONE_PIXEL_PNG)
})

test('native variation uses images/variations and never masquerades as an edit', async () => {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    assert.equal(url, 'https://image-provider.example/v1/images/variations')
    assert.ok(init?.body instanceof FormData)
    const form = init.body
    assert.equal(form.get('model'), 'variation-model')
    assert.equal(form.get('n'), '1')
    assert.equal(form.get('size'), '1024x1024')
    assert.equal(form.get('response_format'), 'b64_json')
    assert.equal(form.get('prompt'), null, 'native variations do not accept an edit prompt')
    assert.equal(form.get('quality'), null)
    const images = form.getAll('image')
    assert.equal(images.length, 1)
    assert.ok(images[0] instanceof Blob)
    assert.equal((images[0] as File).name, 'source.png')
    assert.deepEqual(Buffer.from(await (images[0] as Blob).arrayBuffer()), ONE_PIXEL_PNG)
    return new Response(JSON.stringify({
      data: [{ b64_json: ONE_PIXEL_PNG.toString('base64') }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const provider = new CodexToolsImageProvider({
    baseUrl: 'https://image-provider.example/v1',
    apiKey: 'test-image-key',
    model: 'variation-model',
  })
  const result = await provider.edit!(
    { prompt: '该提示词只做审计绑定', count: 1, size: '1024x1024', quality: 'medium' },
    new AbortController().signal,
    { bytes: ONE_PIXEL_PNG, mimeType: 'image/png' },
    [],
    'variation',
  )
  assert.deepEqual(Buffer.from(result[0].bytes), ONE_PIXEL_PNG)
})

test('native variation refuses additional references instead of falling back to edits', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('must not call')
  }
  const provider = new CodexToolsImageProvider({
    baseUrl: 'https://image-provider.example/v1',
    apiKey: 'test-image-key',
  })
  await assert.rejects(provider.edit!(
    { prompt: '不能偷偷走 edits', count: 1, size: '1024x1024', quality: 'medium' },
    new AbortController().signal,
    { bytes: ONE_PIXEL_PNG, mimeType: 'image/png' },
    [{ bytes: ONE_PIXEL_PNG, mimeType: 'image/png' }],
    'variation',
  ), (error: unknown) => {
    assert.ok(error instanceof ImageProviderError)
    assert.equal(error.code, 'INVALID_VARIATION_REFERENCES')
    return true
  })
  assert.equal(calls, 0)
})

test('upstream image errors redact credentials and filesystem paths', async () => {
  const secret = 'provider-secret-must-not-leak'
  const sourcePrompt = '未公开角色设定：银发少年佩戴龙纹玉佩'
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: `Bearer ${secret} failed at /Users/provider/private/input.png and echoed ${sourcePrompt}`,
    },
  }), { status: 500, headers: { 'content-type': 'application/json' } })
  const provider = new CodexToolsImageProvider({
    baseUrl: 'https://image-provider.example/v1',
    apiKey: secret,
  })
  await assert.rejects(
    provider.generate({
      prompt: sourcePrompt,
      count: 1,
      size: '1024x1024',
      quality: 'medium',
    }, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof ImageProviderError)
      assert.equal(error.message.includes(secret), false)
      assert.equal(error.message.includes('/Users/'), false)
      assert.equal(error.message.includes(sourcePrompt), false)
      assert.equal(error.stack?.includes(secret), false)
      assert.equal(error.stack?.includes(sourcePrompt), false)
      assert.equal(error.message, '图片服务请求失败 (500)')
      return true
    },
  )
})

test('image adapter rejects a declared oversized JSON body before reading it', async () => {
  let cancelled = false
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(1_024))
    },
    cancel() {
      cancelled = true
    },
  }), {
    status: 200,
    headers: { 'content-length': String(200 * 1024 * 1024) },
  })
  const provider = new CodexToolsImageProvider({
    baseUrl: 'https://image-provider.example/v1',
    apiKey: 'test-image-key',
  })

  await assert.rejects(provider.generate({
    prompt: 'bounded response',
    count: 1,
    size: '1024x1024',
    quality: 'medium',
  }, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof ImageProviderError)
    assert.equal(error.code, 'IMAGE_TOO_LARGE')
    assert.equal(error.retryable, false)
    assert.match(error.message, /响应超过大小限制/)
    return true
  })
  assert.equal(cancelled, true)
})
