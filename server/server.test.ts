import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import { CodexToolsImageProvider, ImageProviderError } from './providers/codex-tools.js'
import { downloadPublicImage, isPublicIpAddress } from './safe-image-download.js'
import type { ImageGenerationInput, ImageJob, ImageProvider, ProviderImage } from './types.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(url, init)
  return { status: response.status, body: await response.json() as T }
}

async function waitForTerminalJob(baseUrl: string, id: string): Promise<ImageJob> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await jsonRequest<{ job: ImageJob }>(`${baseUrl}/api/jobs/${id}`)
    if (result.body.job.status === 'succeeded' || result.body.job.status === 'failed') return result.body.job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for job ${id}`)
}

class TestImageProvider implements ImageProvider {
  readonly name = 'test-image-provider'
  readonly model = 'test-image-model'
  readonly configured = true
  active = 0
  maxConcurrent = 0
  private readonly calls = new Map<string, number>()
  private readonly barriers = new Map<string, {
    entered: () => void
    released: Promise<void>
  }>()

  hold(prompt: string): { started: Promise<void>; release: () => void } {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const released = new Promise<void>((resolve) => { release = resolve })
    this.barriers.set(prompt, { entered, released })
    return {
      started,
      release: () => {
        release()
        this.barriers.delete(prompt)
      },
    }
  }

  async health() {
    return { status: 'ok' as const, message: '测试图片服务可用' }
  }

  async generate(input: ImageGenerationInput): Promise<ProviderImage[]> {
    this.active += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active)
    try {
      const call = (this.calls.get(input.prompt) ?? 0) + 1
      this.calls.set(input.prompt, call)
      const barrier = this.barriers.get(input.prompt)
      if (barrier) {
        barrier.entered()
        await barrier.released
      }
      if (input.prompt.includes('permanent')) {
        throw new ImageProviderError('PERMANENT_FAILURE', '永久失败', false)
      }
      if (input.prompt.includes('retry-slow') && call === 1) {
        throw new ImageProviderError('TEST_FAILURE', '首次生成失败', true)
      }
      if (input.prompt.includes('slow')) await new Promise((resolve) => setTimeout(resolve, 40))
      if (input.prompt.includes('fail')) {
        throw new ImageProviderError('TEST_FAILURE', '测试生成失败', true)
      }
      return Array.from({ length: input.count }, () => ({
        bytes: ONE_PIXEL_PNG,
        mimeType: 'image/png',
        revisedPrompt: input.prompt,
      }))
    } finally {
      this.active -= 1
    }
  }
}

let runtimeDirectory = ''
let apiServer: Server
let apiBaseUrl = ''
let apiRuntime: ApplicationRuntime
const testProvider = new TestImageProvider()

before(async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'manju-api-test-'))
  apiRuntime = await createApplication({
    runtimeDirectory,
    provider: testProvider,
    enforcePaidAigcConfirmation: false,
  })
  apiServer = createServer(apiRuntime.app)
  apiBaseUrl = await listen(apiServer)
})

after(async () => {
  if (apiServer) await close(apiServer)
  if (apiRuntime) await apiRuntime.close()
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true })
})

test('health is available and the unsafe unversioned project snapshot is retired', async () => {
  const health = await jsonRequest<{
    status: string
    provider: { name: string; configured: boolean; model: string; status: string; message: string }
  }>(`${apiBaseUrl}/api/health`)
  assert.equal(health.status, 200)
  assert.equal(health.body.status, 'ok')
  assert.deepEqual(health.body.provider, {
    name: 'test-image-provider',
    configured: true,
    model: 'test-image-model',
    status: 'ok',
    message: '测试图片服务可用',
  })

  const currentRevisionId = apiRuntime.projectService.getSnapshot('default').revision.id
  const retired = await jsonRequest<{ error: { code: string } }>(
    `${apiBaseUrl}/api/project`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '真实 MVP', shots: [{ id: 'shot-1' }] }),
    },
  )
  assert.equal(retired.status, 410)
  assert.equal(retired.body.error.code, 'LEGACY_API_REMOVED')
  assert.equal(apiRuntime.projectService.getSnapshot('default').revision.id, currentRevisionId)
})

test('image endpoint validates input, runs the queue, and serves generated files', async () => {
  const invalid = await jsonRequest<{ error: { code: string } }>(`${apiBaseUrl}/api/images/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '', count: 10 }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'INVALID_PROMPT')

  const created = await jsonRequest<{ job: ImageJob }>(`${apiBaseUrl}/api/images/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: '一座晨雾中的古风山门',
      size: '1536x1024',
      quality: 'high',
      count: 2,
      metadata: { shotId: 'shot-1' },
    }),
  })
  assert.equal(created.status, 202)
  assert.ok(
    ['queued', 'running', 'waiting_provider'].includes(created.body.job.status),
    `newly accepted job returned unexpected state ${created.body.job.status}`,
  )

  const completed = await waitForTerminalJob(apiBaseUrl, created.body.job.id)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.output?.images.length, 2)
  assert.equal(completed.output?.images[0].width, 1)
  assert.equal(completed.output?.images[0].height, 1)

  const image = await fetch(`${apiBaseUrl}${completed.output?.images[0].url}`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), ONE_PIXEL_PNG)

  const list = await jsonRequest<{ jobs: ImageJob[] }>(`${apiBaseUrl}/api/jobs?status=succeeded&limit=10`)
  assert.equal(list.status, 200)
  assert.ok(list.body.jobs.some((job) => job.id === completed.id))
})

test('failed image jobs expose safe errors but generic retry requires paid reconfirmation', async () => {
  const created = await jsonRequest<{ job: ImageJob }>(`${apiBaseUrl}/api/images/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'please fail' }),
  })
  const failed = await waitForTerminalJob(apiBaseUrl, created.body.job.id)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.error, { code: 'TEST_FAILURE', message: '测试生成失败', retryable: true })

  const countBefore = apiRuntime.database.listGenerationJobs({ projectId: 'default' }).length
  const retried = await jsonRequest<{ error: { code: string } }>(`${apiBaseUrl}/api/jobs/${failed.id}/retry`, {
    method: 'POST',
  })
  assert.equal(retried.status, 409)
  assert.equal(retried.body.error.code, 'JOB_PAID_RECONFIRMATION_REQUIRED')
  assert.equal(apiRuntime.database.listGenerationJobs({ projectId: 'default' }).length, countBefore)
})

test('permanent image failures also return to the paid preflight workspace', async () => {
  const created = await jsonRequest<{ job: ImageJob }>(`${apiBaseUrl}/api/images/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'permanent provider rejection' }),
  })
  const failed = await waitForTerminalJob(apiBaseUrl, created.body.job.id)
  assert.equal(failed.error?.retryable, false)

  const retry = await jsonRequest<{ error: { code: string } }>(`${apiBaseUrl}/api/jobs/${failed.id}/retry`, {
    method: 'POST',
  })
  assert.equal(retry.status, 409)
  assert.equal(retry.body.error.code, 'JOB_PAID_RECONFIRMATION_REQUIRED')
})

test('an original free failure can have only one linear retry child', async () => {
  const source = apiRuntime.database.createGenerationJob({
    id: 'legacy-free-retry-source',
    projectId: 'default',
    type: 'story.generate',
    status: 'failed',
    resourceType: 'provider:text',
    providerId: 'codex-tools-text',
    model: 'gpt-5.5',
    providerConfigRevision: 1,
    idempotencyKey: 'legacy-free-retry-source',
    input: {},
    error: {
      code: 'UPSTREAM_TIMEOUT',
      message: '上游超时',
      retryable: true,
      category: 'timeout',
    },
  })

  const retry = () => jsonRequest<{ job?: ImageJob; error?: { code: string } }>(
    `${apiBaseUrl}/api/jobs/${source.id}/retry`,
    { method: 'POST' },
  )
  const results = await Promise.all([retry(), retry()])
  assert.deepEqual(results.map((result) => result.status).sort(), [202, 409])
  const conflict = results.find((result) => result.status === 409)
  assert.equal(conflict?.body.error?.code, 'ACTIVE_RETRY_EXISTS')
  const accepted = results.find((result) => result.status === 202)?.body.job
  assert.ok(accepted)
  await waitForTerminalJob(apiBaseUrl, accepted.id)
})

test('image jobs execute with strict provider concurrency of one', async () => {
  const create = (prompt: string) => jsonRequest<{ job: ImageJob }>(`${apiBaseUrl}/api/images/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  const [first, second] = await Promise.all([create('slow serial one'), create('slow serial two')])
  await Promise.all([
    waitForTerminalJob(apiBaseUrl, first.body.job.id),
    waitForTerminalJob(apiBaseUrl, second.body.job.id),
  ])
  assert.equal(testProvider.maxConcurrent, 1)
})

test('generate and retry share an atomic queue capacity limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-capacity-test-'))
  const provider = new TestImageProvider()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider,
    maxQueueDepth: 1,
    enforcePaidAigcConfirmation: false,
  })
  const server = createServer(runtime.app)
  const baseUrl = await listen(server)
  const create = (prompt: string) => jsonRequest<{ job?: ImageJob; error?: { code: string } }>(
    `${baseUrl}/api/images/generate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    },
  )

  try {
    const firstBarrier = provider.hold('capacity one')
    const accepted = await create('capacity one')
    assert.equal(accepted.status, 202)
    assert.ok(accepted.body.job)
    await firstBarrier.started
    try {
      const rejected = await create('capacity two')
      assert.equal(rejected.status, 429)
      assert.equal(rejected.body.error?.code, 'QUEUE_FULL')
    } finally {
      firstBarrier.release()
    }
    await waitForTerminalJob(baseUrl, accepted.body.job.id)

    const failed = runtime.database.createGenerationJob({
      id: 'capacity-free-retry-source',
      projectId: 'default',
      type: 'story.generate',
      status: 'failed',
      resourceType: 'provider:text',
      providerId: 'codex-tools-text',
      model: 'gpt-5.5',
      providerConfigRevision: 1,
      idempotencyKey: 'capacity-free-retry-source',
      input: {},
      error: {
        code: 'UPSTREAM_TIMEOUT',
        message: '上游超时',
        retryable: true,
        category: 'timeout',
      },
    })
    const retryBarrier = provider.hold('capacity retry occupant')
    const occupied = await create('capacity retry occupant')
    assert.equal(occupied.status, 202)
    await retryBarrier.started
    try {
      const retry = await jsonRequest<{ error: { code: string } }>(`${baseUrl}/api/jobs/${failed.id}/retry`, {
        method: 'POST',
      })
      assert.equal(retry.status, 429)
      assert.equal(retry.body.error.code, 'QUEUE_FULL')
    } finally {
      retryBarrier.release()
    }
    await waitForTerminalJob(baseUrl, occupied.body.job!.id)
  } finally {
    await close(server)
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Codex Tools provider keeps b64_json support and blocks unsafe URL responses', async () => {
  let upstreamBaseUrl = ''
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/v1/images/generations')
    assert.equal(request.headers.authorization, 'Bearer test-only-key')
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { prompt: string; model: string }
      assert.equal(payload.model, 'gpt-image-2')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        data: payload.prompt === 'return-local-url'
          ? [{ url: `${upstreamBaseUrl}/asset.png` }]
          : payload.prompt === 'return-metadata-url'
            ? [{ url: 'http://169.254.169.254/latest/meta-data/' }]
            : payload.prompt === 'return-ipv6-loopback'
              ? [{ url: 'http://[::1]/asset.png' }]
              : [{ b64_json: ONE_PIXEL_PNG.toString('base64') }],
      }))
    })
  })
  upstreamBaseUrl = await listen(upstream)

  try {
    const provider = new CodexToolsImageProvider({ baseUrl: upstreamBaseUrl, apiKey: 'test-only-key' })
    const common = { size: '1024x1024', quality: 'medium', count: 1 } as const
    const base64Result = await provider.generate({ prompt: 'return-base64', ...common }, new AbortController().signal)
    assert.deepEqual(Buffer.from(base64Result[0].bytes), ONE_PIXEL_PNG)
    for (const prompt of ['return-local-url', 'return-metadata-url', 'return-ipv6-loopback']) {
      await assert.rejects(
        provider.generate({ prompt, ...common }, new AbortController().signal),
        (error: unknown) => error instanceof ImageProviderError &&
          error.code === 'UNSAFE_IMAGE_URL' && error.retryable === false,
      )
    }
  } finally {
    await close(upstream)
  }
})

test('SSRF address policy rejects loopback, private, link-local and metadata ranges', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicIpAddress(address), true, `${address} should be public`)
  }
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.100.100.200', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '198.18.0.1', '::', '::1', '::ffff:127.0.0.1',
    'fc00::1', 'fd00:ec2::254', 'fe80::1', '2001:db8::1',
  ]) {
    assert.equal(isPublicIpAddress(address), false, `${address} should be blocked`)
  }
})

test('every redirect target is revalidated before another request', async () => {
  let requests = 0
  await assert.rejects(
    downloadPublicImage(
      'https://public-images.example/start',
      new AbortController().signal,
      1024,
      {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: async (_url, address) => {
          requests += 1
          assert.equal(address.address, '93.184.216.34')
          return { kind: 'redirect' as const, location: 'http://127.0.0.1/admin' }
        },
      },
    ),
    (error: unknown) => error instanceof Error &&
      'code' in error && error.code === 'UNSAFE_IMAGE_URL',
  )
  assert.equal(requests, 1, 'private redirect target must be blocked before a second socket request')
})
