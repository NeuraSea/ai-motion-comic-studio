import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import { AudioDurationProbeError, type AudioDurationProbe } from './audio-duration.js'
import { resolveBundledFfprobePath } from './ffmpeg-renderer.js'
import type {
  ImageGenerationInput,
  ImageProvider,
  ProviderImage,
} from './types.js'

class UnusedImageProvider implements ImageProvider {
  readonly name = 'unused-image-provider'
  readonly model = 'unused-image-model'
  readonly configured = true

  async health() {
    return { status: 'ok' as const, message: 'fixture ready' }
  }

  async generate(_input: ImageGenerationInput): Promise<ProviderImage[]> {
    throw new Error('Image provider must not be called by media upload tests')
  }
}

interface RunningFixture {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
  probeCalls: Array<{ bytes: Buffer; mimeType: string }>
}

const fixtures: RunningFixture[] = []

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return `http://127.0.0.1:${address.port}`
}

async function fixture(options: {
  probe?: AudioDurationProbe
  productionProbe?: boolean
  maxBytes?: number
} = {}): Promise<RunningFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-media-upload-test-'))
  const probeCalls: RunningFixture['probeCalls'] = []
  const fixtureProbe: AudioDurationProbe = options.probe ?? (async (bytes, mimeType) => {
    probeCalls.push({ bytes: Buffer.from(bytes), mimeType })
    return 2.75
  })
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider: new UnusedImageProvider(),
    autoStartWorker: false,
    ...(options.productionProbe ? {} : { mediaUploadAudioDurationProbe: fixtureProbe }),
    ...(options.maxBytes === undefined ? {} : { mediaUploadMaxAudioBytes: options.maxBytes }),
  })
  runtime.storyRepository.ensureEpisode('default', {
    id: 'episode-upload',
    title: '媒体上传测试',
  })
  runtime.database.createProject({ id: 'other-project', title: '其他项目' })
  runtime.storyRepository.ensureEpisode('other-project', {
    id: 'episode-other',
    title: '其他项目分集',
  })
  const server = createServer(runtime.app)
  const running = {
    directory,
    runtime,
    server,
    baseUrl: await listen(server),
    probeCalls,
  }
  fixtures.push(running)
  return running
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await new Promise<void>((resolve, reject) => item.server.close((error) => error ? reject(error) : resolve()))
    await item.runtime.close()
    await rm(item.directory, { recursive: true, force: true })
  }
})

function pcmWav(durationSeconds = 0.1, sampleRate = 8_000): Buffer {
  const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate))
  const dataBytes = sampleCount * 2
  const output = Buffer.alloc(44 + dataBytes)
  output.write('RIFF', 0, 'ascii')
  output.writeUInt32LE(36 + dataBytes, 4)
  output.write('WAVE', 8, 'ascii')
  output.write('fmt ', 12, 'ascii')
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * 2, 28)
  output.writeUInt16LE(2, 32)
  output.writeUInt16LE(16, 34)
  output.write('data', 36, 'ascii')
  output.writeUInt32LE(dataBytes, 40)
  return output
}

function binaryBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function errorResponse(response: Response): Promise<{ code: string; message: string }> {
  const body = await response.json() as { error: { code: string; message: string } }
  return body.error
}

function uploadUrl(baseUrl: string, overrides: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    projectId: 'default',
    episodeId: 'episode-upload',
    kind: 'bgm',
    name: 'licensed-theme.wav',
    ...overrides,
  })
  return `${baseUrl}/api/v1/assets/uploads/audio?${query}`
}

test('uploads immutable episode-owned audio after probing duration and serves byte ranges', async () => {
  const value = await fixture()
  const bytes = pcmWav()
  const created = await fetch(uploadUrl(value.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: binaryBody(bytes),
  })
  assert.equal(created.status, 201)
  assert.equal(created.headers.get('location')?.startsWith('/api/v1/assets/'), true)
  const payload = await created.json() as { asset: Record<string, unknown> }
  const asset = payload.asset
  assert.equal(asset.projectId, 'default')
  assert.equal(asset.episodeId, 'episode-upload')
  assert.equal(asset.kind, 'bgm')
  assert.equal(asset.source, 'upload')
  assert.equal(asset.mimeType, 'audio/wav')
  assert.equal(asset.durationSeconds, 2.75)
  assert.equal(asset.originalFileName, 'licensed-theme.wav')
  assert.match(String(asset.checksum), /^[a-f0-9]{64}$/)
  assert.match(String(asset.url), /^\/api\/v1\/assets\/[A-Za-z0-9._-]+\/content$/)

  assert.equal(value.probeCalls.length, 1)
  assert.equal(value.probeCalls[0].mimeType, 'audio/wav')
  assert.deepEqual(value.probeCalls[0].bytes, bytes)
  const persisted = value.runtime.database.getMediaAsset(String(asset.id))
  assert.ok(persisted)
  assert.equal(persisted.durationSeconds, 2.75)
  assert.equal(persisted.generationParameters.originalFileName, 'licensed-theme.wav')
  assert.match(persisted.filePath ?? '', /^media\//)
  assert.equal((persisted.filePath ?? '').includes('licensed-theme'), false)
  assert.equal((await stat(join(value.directory, persisted.filePath!))).isFile(), true)

  const contentUrl = `${value.baseUrl}${String(asset.url)}`
  const full = await fetch(contentUrl)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('accept-ranges'), 'bytes')
  assert.equal(full.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes)

  const range = await fetch(contentUrl, { headers: { range: 'bytes=4-11' } })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), `bytes 4-11/${bytes.length}`)
  assert.equal(range.headers.get('content-length'), '8')
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(4, 12))

  const suffix = await fetch(contentUrl, { headers: { range: 'bytes=-5' } })
  assert.equal(suffix.status, 206)
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-5))

  const head = await fetch(contentUrl, { method: 'HEAD', headers: { range: 'bytes=0-3' } })
  assert.equal(head.status, 206)
  assert.equal(head.headers.get('content-range'), `bytes 0-3/${bytes.length}`)
  assert.equal((await head.arrayBuffer()).byteLength, 0)

  const invalidRange = await fetch(contentUrl, { headers: { range: 'bytes=0-1,4-5' } })
  assert.equal(invalidRange.status, 416)
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${bytes.length}`)
  assert.equal((await errorResponse(invalidRange)).code, 'INVALID_RANGE')

  const listed = await fetch(
    `${value.baseUrl}/api/v1/assets?projectId=default&episodeId=episode-upload&kind=bgm`,
  )
  assert.equal(listed.status, 200)
  const listBody = await listed.json() as { assets: Array<Record<string, unknown>> }
  assert.equal(listBody.assets.length, 1)
  assert.equal(listBody.assets[0].id, asset.id)
  assert.equal(listBody.assets[0].originalFileName, 'licensed-theme.wav')
})

test('closes a verified asset handle when the client disconnects before streaming begins', async () => {
  const value = await fixture()
  const bytes = pcmWav()
  const created = await fetch(uploadUrl(value.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: binaryBody(bytes),
  })
  assert.equal(created.status, 201)
  const asset = (await created.json() as { asset: { url: string } }).asset

  const originalOpenAsset = value.runtime.mediaStore.openAsset.bind(value.runtime.mediaStore)
  const capture: {
    opened?: Awaited<ReturnType<typeof originalOpenAsset>>
    releaseOpen?: () => void
  } = {}
  value.runtime.mediaStore.openAsset = async (assetId: string) => {
    capture.opened = await originalOpenAsset(assetId)
    await new Promise<void>((resolve) => { capture.releaseOpen = resolve })
    return capture.opened
  }

  const controller = new AbortController()
  const pending = fetch(`${value.baseUrl}${asset.url}`, { signal: controller.signal })
  const deadline = Date.now() + 2_000
  while (!capture.opened && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const opened = capture.opened
  assert.ok(opened, 'server should verify and open the asset before the test disconnects')
  controller.abort()
  await assert.rejects(pending, (error: unknown) => (
    error instanceof Error && error.name === 'AbortError'
  ))
  const releaseOpen = capture.releaseOpen
  assert.ok(releaseOpen)
  releaseOpen()

  const closeDeadline = Date.now() + 2_000
  while (opened.file.fd !== -1 && Date.now() < closeDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(opened.file.fd, -1)
})

test('rejects cross-project ownership, MIME spoofing, paths, URLs, and malformed media before persistence', async () => {
  const value = await fixture()
  const bytes = pcmWav()
  const attempts: Array<{ response: Response; status: number; code: string }> = []

  attempts.push({
    response: await fetch(uploadUrl(value.baseUrl, { projectId: 'missing-project' }), {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: binaryBody(bytes),
    }),
    status: 404,
    code: 'PROJECT_NOT_FOUND',
  })
  attempts.push({
    response: await fetch(uploadUrl(value.baseUrl, { episodeId: 'episode-other' }), {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: binaryBody(bytes),
    }),
    status: 404,
    code: 'EPISODE_NOT_FOUND',
  })
  attempts.push({
    response: await fetch(uploadUrl(value.baseUrl, { kind: 'speech' }), {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: binaryBody(bytes),
    }),
    status: 400,
    code: 'INVALID_AUDIO_KIND',
  })
  attempts.push({
    response: await fetch(uploadUrl(value.baseUrl), {
      method: 'POST', headers: { 'content-type': 'audio/mpeg' }, body: binaryBody(bytes),
    }),
    status: 422,
    code: 'INVALID_AUDIO',
  })
  attempts.push({
    response: await fetch(uploadUrl(value.baseUrl), {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: binaryBody(bytes),
    }),
    status: 415,
    code: 'UNSUPPORTED_AUDIO_TYPE',
  })
  attempts.push({
    response: await fetch(`${uploadUrl(value.baseUrl)}&filePath=../../outside.wav`, {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: binaryBody(bytes),
    }),
    status: 400,
    code: 'UNSAFE_UPLOAD_INPUT',
  })
  attempts.push({
    response: await fetch(uploadUrl(value.baseUrl, { name: '../outside.wav' }), {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: binaryBody(bytes),
    }),
    status: 400,
    code: 'INVALID_UPLOAD_NAME',
  })
  attempts.push({
    response: await fetch(uploadUrl(value.baseUrl), {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: binaryBody(Buffer.from('not audio')),
    }),
    status: 422,
    code: 'INVALID_AUDIO',
  })

  for (const attempt of attempts) {
    assert.equal(attempt.response.status, attempt.status)
    assert.equal((await errorResponse(attempt.response)).code, attempt.code)
  }
  assert.equal(value.probeCalls.length, 0)
  assert.deepEqual(value.runtime.database.listMediaAssets({ projectId: 'default' }), [])
  assert.deepEqual(await readdir(join(value.directory, 'media')), [])
})

test('enforces the raw upload limit before ffprobe and leaves no Asset or file', async () => {
  const value = await fixture({ maxBytes: 32 })
  const response = await fetch(uploadUrl(value.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: binaryBody(pcmWav()),
  })
  assert.equal(response.status, 413)
  assert.equal((await errorResponse(response)).code, 'PAYLOAD_TOO_LARGE')
  assert.equal(value.probeCalls.length, 0)
  assert.deepEqual(value.runtime.database.listMediaAssets({ projectId: 'default' }), [])
  assert.deepEqual(await readdir(join(value.directory, 'media')), [])
})

test('a failed ffprobe validation does not publish a partial Asset or media file', async () => {
  const probe: AudioDurationProbe = async () => {
    throw new AudioDurationProbeError('INVALID_AUDIO', 'fixture decode failure')
  }
  const value = await fixture({ probe })
  const response = await fetch(uploadUrl(value.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: binaryBody(pcmWav()),
  })
  assert.equal(response.status, 422)
  assert.equal((await errorResponse(response)).code, 'INVALID_AUDIO')
  assert.deepEqual(value.runtime.database.listMediaAssets({ projectId: 'default' }), [])
  assert.deepEqual(await readdir(join(value.directory, 'media')), [])
})

const bundledFfprobe = resolveBundledFfprobePath()
const hasBundledFfprobe = Boolean(bundledFfprobe && existsSync(bundledFfprobe))

test('production upload path measures a real WAV through the pinned ffprobe binary', {
  skip: hasBundledFfprobe ? false : 'bundled ffprobe is unavailable on this platform',
}, async () => {
  const value = await fixture({ productionProbe: true })
  const bytes = pcmWav(0.25)
  const response = await fetch(uploadUrl(value.baseUrl, { kind: 'sfx', name: 'hit.wav' }), {
    method: 'POST',
    headers: { 'content-type': 'audio/x-wav' },
    body: binaryBody(bytes),
  })
  assert.equal(response.status, 201)
  const body = await response.json() as { asset: { durationSeconds: number; mimeType: string; kind: string } }
  assert.equal(body.asset.mimeType, 'audio/wav')
  assert.equal(body.asset.kind, 'sfx')
  assert.ok(Math.abs(body.asset.durationSeconds - 0.25) < 0.02)
})
