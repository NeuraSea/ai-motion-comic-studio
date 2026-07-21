import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { deflateSync } from 'node:zlib'

import { createApplication, type ApplicationRuntime } from './app.js'
import {
  FfmpegTurnaroundCropRenderer,
  seedanceSafeImageCanvas,
  TurnaroundDerivationError,
  validateTurnaroundCrops,
  type TurnaroundCropRenderer,
  type TurnaroundCropResult,
} from './asset-turnaround-derivation.js'
import type { KeychainCredentialSlot } from './keychain.js'
import type { ProviderCredentialStore } from './providers/service.js'
import type { StoryDocument } from './story-schema.js'
import type { ImageGenerationInput, ImageProvider, JsonObject, ProviderImage } from './types.js'
import { resolveVisualAssetEntity } from './visual-asset-generation.js'

const CROPS = [
  { role: 'front' as const, x: 0, y: 0, width: 1 / 3, height: 1 },
  { role: 'side' as const, x: 1 / 3, y: 0, width: 1 / 3, height: 1 },
  { role: 'back' as const, x: 2 / 3, y: 0, width: 1 / 3, height: 1 },
]

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0)
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.byteLength)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function png(
  width: number,
  height: number,
  color: (x: number, y: number) => readonly [number, number, number],
): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 3 + 1)
    rows[rowOffset] = 0
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = color(x, y)
      const offset = rowOffset + 1 + x * 3
      rows[offset] = red
      rows[offset + 1] = green
      rows[offset + 2] = blue
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const SOURCE_PNG = png(300, 100, (x) => (
  x < 100 ? [230, 20, 20] : x < 200 ? [20, 210, 20] : [20, 20, 230]
))

class MemoryCredentials implements ProviderCredentialStore {
  private readonly values = new Map<string, string>()
  private key(slot: KeychainCredentialSlot): string {
    return `${slot.providerId}:${slot.credentialKind ?? 'api-key'}`
  }
  async get(slot: KeychainCredentialSlot): Promise<string | null> {
    return this.values.get(this.key(slot)) ?? null
  }
  async set(slot: KeychainCredentialSlot, secret: string): Promise<void> {
    this.values.set(this.key(slot), secret)
  }
  async delete(slot: KeychainCredentialSlot): Promise<boolean> {
    return this.values.delete(this.key(slot))
  }
  async exists(slot: KeychainCredentialSlot): Promise<boolean> {
    return this.values.has(this.key(slot))
  }
}

class NoopImageProvider implements ImageProvider {
  readonly name = 'turnaround-noop'
  readonly model = 'unused'
  readonly configured = true
  calls = 0
  async health() {
    return { status: 'ok' as const, message: 'unused' }
  }
  async generate(input: ImageGenerationInput): Promise<ProviderImage[]> {
    this.calls += 1
    return Array.from({ length: input.count }, () => ({ bytes: SOURCE_PNG, mimeType: 'image/png' }))
  }
}

class FixtureRenderer implements TurnaroundCropRenderer {
  calls = 0
  constructor(readonly corruptRole?: 'front' | 'side' | 'back') {}
  async crop(input: Parameters<TurnaroundCropRenderer['crop']>[0]): Promise<TurnaroundCropResult[]> {
    this.calls += 1
    return input.crops.map((crop, index) => {
      const canvas = seedanceSafeImageCanvas(crop.pixels.width, crop.pixels.height)
      return {
      role: crop.role,
      bytes: crop.role === this.corruptRole
        ? Buffer.from('not-an-image')
        : png(canvas.width, canvas.height, () => (
          index === 0 ? [240, 30, 30] : index === 1 ? [30, 220, 30] : [30, 30, 240]
        )),
      mimeType: 'image/png' as const,
      width: canvas.width,
      height: canvas.height,
      }
    })
  }
}

interface Fixture {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
  renderer: FixtureRenderer
  provider: NoopImageProvider
}

const fixtures: Fixture[] = []

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address missing')
  return `http://127.0.0.1:${address.port}`
}

async function fixture(options: { autoStartWorker?: boolean; corruptRole?: 'front' | 'side' | 'back' } = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-turnaround-derive-'))
  const renderer = new FixtureRenderer(options.corruptRole)
  const provider = new NoopImageProvider()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider,
    keychain: new MemoryCredentials(),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    turnaroundCropRenderer: renderer,
    autoStartWorker: options.autoStartWorker,
  })
  const server = createServer(runtime.app)
  const value = { directory, runtime, server, baseUrl: await listen(server), renderer, provider }
  fixtures.push(value)
  return value
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await new Promise<void>((resolve) => item.server.close(() => resolve()))
    await item.runtime.close()
    await rm(item.directory, { recursive: true, force: true })
  }
})

async function json<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init)
  return { response, body: await response.json() as T }
}

async function terminalJob(baseUrl: string, jobId: string): Promise<Record<string, unknown>> {
  for (let index = 0; index < 300; index += 1) {
    const result = await json<{ job: Record<string, unknown> }>(`${baseUrl}/api/v1/jobs/${jobId}`)
    if (['succeeded', 'failed', 'cancelled'].includes(String(result.body.job.status))) return result.body.job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`job did not finish: ${jobId}`)
}

function story(): StoryDocument {
  return {
    version: 1,
    title: '三视图测试',
    targetDurationSeconds: 30,
    bible: { logline: '测试', theme: '一致性', tone: '平静', visualStyle: '国风动画' },
    characters: [{
      id: 'ali',
      name: '阿离',
      role: '主角',
      storyDescription: '年轻剑客',
      visualDescription: '黑发红绳青袍',
    }],
    locations: [{
      id: 'cliff',
      name: '断崖',
      storyDescription: '城外',
      visualDescription: '云海',
    }],
    props: [],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '断崖',
      locationId: 'cliff',
      timeOfDay: '黄昏',
      description: '角色站立',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `角色近景 ${index + 1}`,
        description: '角色看向远方',
        framing: '近景',
        movement: '固定',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '阿离在断崖',
        dialogueLines: [],
      })),
    }],
  }
}

function persistStory(runtime: ApplicationRuntime, episodeId: string): string {
  const document = story()
  runtime.storyRepository.ensureEpisode('default', { id: episodeId, title: document.title })
  const project = runtime.database.getProject('default')!
  const revision = runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: project.currentRevisionId,
    summary: '三视图测试剧本',
    snapshot: structuredClone(document) as unknown as JsonObject,
  })
  runtime.storyRepository.applyStory(episodeId, document, revision.id)
  return revision.id
}

async function authenticSource(runtime: ApplicationRuntime, episodeId: string, revisionId: string) {
  const character = resolveVisualAssetEntity(runtime.database, {
    projectId: 'default',
    episodeId,
    entityType: 'character',
    entityId: 'ali',
  })
  const binding = {
    episodeId,
    entityType: 'character' as const,
    entityId: 'ali',
    databaseEntityId: character.databaseId,
    expectedRevisionId: revisionId,
    parentAssetId: null,
    nextVersion: 1,
  }
  const generationJob = runtime.database.createGenerationJob({
    projectId: 'default',
    episodeId,
    type: 'asset.image.generate',
    status: 'succeeded',
    progress: 100,
    input: {
      metadata: { kind: 'character-turnaround', entityType: 'character', entityId: 'ali' },
      assetEntityBinding: binding,
    },
    output: { images: [] },
  })
  return runtime.mediaStore.save({
    projectId: 'default',
    episodeId,
    kind: 'character-turnaround',
    version: 1,
    bytes: SOURCE_PNG,
    mimeType: 'image/png',
    source: 'provider',
    providerId: null,
    generationJobId: generationJob.id,
    generationParameters: { entityType: 'character', entityId: 'ali' },
    sourceRevisionId: revisionId,
    width: 300,
    height: 100,
  })
}

async function assetEtag(baseUrl: string, assetId: string): Promise<string> {
  const result = await json<{ asset: { etag: string } }>(`${baseUrl}/api/v1/assets/${assetId}`)
  assert.equal(result.response.status, 200)
  assert.equal(result.body.asset.etag, result.response.headers.get('etag'))
  return result.body.asset.etag
}

async function submit(
  value: Fixture,
  assetId: string,
  key: string,
  crops: unknown = CROPS,
  ifMatch?: string,
) {
  return json<{ job: Record<string, unknown>; error?: { code: string } }>(
    `${value.baseUrl}/api/v1/assets/${assetId}/derivations/turnaround`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        ...(ifMatch === '' ? {} : { 'if-match': ifMatch ?? await assetEtag(value.baseUrl, assetId) }),
      },
      body: JSON.stringify({ projectId: 'default', crops }),
    },
  )
}

test('turnaround crop validation requires complete bounded non-overlapping human-confirmed roles', () => {
  const valid = validateTurnaroundCrops(CROPS, 300, 100)
  assert.deepEqual(valid.map((crop) => ({ role: crop.role, ...crop.pixels })), [
    { role: 'front', x: 0, y: 0, width: 100, height: 100 },
    { role: 'side', x: 100, y: 0, width: 100, height: 100 },
    { role: 'back', x: 200, y: 0, width: 100, height: 100 },
  ])
  for (const invalid of [
    CROPS.slice(0, 2),
    [CROPS[0], CROPS[0], CROPS[2]],
    [{ ...CROPS[0], x: -0.01 }, CROPS[1], CROPS[2]],
    [{ ...CROPS[0], width: 0.1 }, CROPS[1], CROPS[2]],
    [CROPS[0], { ...CROPS[1], x: 0.2 }, CROPS[2]],
  ]) {
    assert.throws(
      () => validateTurnaroundCrops(invalid, 300, 100),
      (error: unknown) => error instanceof TurnaroundDerivationError && error.code === 'INVALID_CROPS',
    )
  }
})

test('Seedance-safe canvas preserves the crop and adds only the required open-interval padding', () => {
  assert.deepEqual(seedanceSafeImageCanvas(408, 1_024), {
    width: 410,
    height: 1_024,
    contentWidth: 408,
    contentHeight: 1_024,
  })
  const tiny = seedanceSafeImageCanvas(100, 100)
  assert.deepEqual(tiny, { width: 300, height: 300, contentWidth: 300, contentHeight: 300 })
  assert.ok(410 / 1_024 > 0.4)
})

test('turnaround endpoint creates three persistent local child Assets with no Provider or implicit lock', async () => {
  const value = await fixture()
  const episodeId = 'turnaround-success'
  const revisionId = persistStory(value.runtime, episodeId)
  const source = await authenticSource(value.runtime, episodeId, revisionId)
  const etag = await assetEtag(value.baseUrl, source.id)
  const created = await submit(value, source.id, 'turnaround-success-v1', CROPS, etag)
  assert.equal(created.response.status, 202, JSON.stringify(created.body))
  assert.equal(created.body.job.providerId, null)
  assert.equal(created.body.job.providerConfigRevision, null)
  assert.equal(created.body.job.model, null)
  const done = await terminalJob(value.baseUrl, String(created.body.job.id))
  assert.equal(done.status, 'succeeded', JSON.stringify(done))
  assert.equal(value.renderer.calls, 1)
  assert.equal(value.provider.calls, 0)
  const outputs = (done.output as { assets: Array<{ role: string; asset: { id: string } }> }).assets
  assert.deepEqual(outputs.map((output) => output.role), ['front', 'side', 'back'])
  for (const output of outputs) {
    const asset = value.runtime.database.getMediaAsset(output.asset.id)!
    assert.equal(asset.kind, `character-reference.${output.role}`)
    assert.equal(asset.parentAssetId, source.id)
    assert.equal(asset.source, 'derived')
    assert.equal(asset.providerId, null)
    assert.equal(asset.sourceRevisionId, revisionId)
    assert.equal(asset.version, 1)
    assert.equal(asset.generationParameters.algorithm, 'ffmpeg-crop-seedance-safe-v2')
    assert.equal(asset.generationParameters.orientation, output.role)
    assert.equal(asset.generationParameters.entityId, 'ali')
    assert.equal((asset.generationParameters.source as JsonObject).checksum, source.checksum)
    const opened = await value.runtime.mediaStore.openAsset(asset.id)
    try {
      const bytes = await opened.file.readFile()
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      assert.equal(bytes.byteLength, opened.size)
    } finally {
      await opened.file.close()
    }
  }
  const character = value.runtime.database.withSql((sql) => sql.get(`
    SELECT locked_asset_id FROM characters
    WHERE project_id = 'default' AND episode_id = ?
  `, episodeId))
  assert.equal(character?.locked_asset_id, null)
  assert.equal(value.runtime.database.withSql((sql) => sql.get(`
    SELECT COUNT(*) AS count FROM character_visual_references WHERE episode_id = ?
  `, episodeId))?.count, 0)

  const replay = await submit(value, source.id, 'turnaround-success-v1', CROPS, etag)
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.job.id, created.body.job.id)
  assert.equal(value.renderer.calls, 1)
  const conflict = await submit(value, source.id, 'turnaround-success-v1', [
    { ...CROPS[0], width: 0.32 }, CROPS[1], CROPS[2],
  ], etag)
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.error?.code, 'IDEMPOTENCY_CONFLICT')
})

test('turnaround endpoint rejects weak/missing preconditions, unsafe crops, and unauthenticated sources', async () => {
  const value = await fixture()
  const episodeId = 'turnaround-security'
  const revisionId = persistStory(value.runtime, episodeId)
  const source = await authenticSource(value.runtime, episodeId, revisionId)
  const missing = await submit(value, source.id, 'turnaround-missing-etag', CROPS, '')
  assert.equal(missing.response.status, 428)
  const weak = await submit(value, source.id, 'turnaround-weak-etag', CROPS, `W/${await assetEtag(value.baseUrl, source.id)}`)
  assert.equal(weak.response.status, 400)
  assert.equal(weak.body.error?.code, 'INVALID_ASSET_ETAG')
  const stale = await submit(value, source.id, 'turnaround-stale-etag', CROPS, '"asset-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
  assert.equal(stale.response.status, 412)
  assert.equal(stale.body.error?.code, 'PRECONDITION_FAILED')
  const overlap = await submit(value, source.id, 'turnaround-overlap', [
    CROPS[0], { ...CROPS[1], x: 0.2 }, CROPS[2],
  ])
  assert.equal(overlap.response.status, 400)
  assert.equal(overlap.body.error?.code, 'INVALID_CROPS')

  const unbound = await value.runtime.mediaStore.save({
    projectId: 'default',
    episodeId,
    kind: 'character-turnaround',
    bytes: SOURCE_PNG,
    mimeType: 'image/png',
    source: 'upload',
    generationParameters: { entityType: 'character', entityId: 'ali' },
    sourceRevisionId: revisionId,
    width: 300,
    height: 100,
  })
  const rejected = await submit(value, unbound.id, 'turnaround-unbound')
  assert.equal(rejected.response.status, 400)
  assert.equal(rejected.body.error?.code, 'INVALID_SOURCE_ASSET')
  assert.equal(value.renderer.calls, 0)
  assert.equal(value.provider.calls, 0)
})

test('turnaround queued source drift fails before rendering and a partial invalid output is fully rolled back', async () => {
  const stale = await fixture({ autoStartWorker: false })
  const staleEpisodeId = 'turnaround-source-drift'
  const staleRevision = persistStory(stale.runtime, staleEpisodeId)
  const staleSource = await authenticSource(stale.runtime, staleEpisodeId, staleRevision)
  const queued = await submit(stale, staleSource.id, 'turnaround-source-drift-v1')
  assert.equal(queued.response.status, 202)
  const nextRevision = stale.runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: staleRevision,
    summary: '排队期修订漂移',
    snapshot: { kind: 'test' },
  })
  stale.runtime.database.withSql((sql) => sql.run(
    'UPDATE episodes SET source_revision_id = ? WHERE id = ?',
    nextRevision.id,
    staleEpisodeId,
  ))
  await stale.runtime.worker.start()
  const staleDone = await terminalJob(stale.baseUrl, String(queued.body.job.id))
  assert.equal(staleDone.status, 'failed')
  assert.equal((staleDone.error as JsonObject).code, 'STALE_SOURCE')
  assert.equal(stale.renderer.calls, 0)

  const rollback = await fixture({ corruptRole: 'side' })
  const rollbackEpisodeId = 'turnaround-rollback'
  const rollbackRevision = persistStory(rollback.runtime, rollbackEpisodeId)
  const rollbackSource = await authenticSource(rollback.runtime, rollbackEpisodeId, rollbackRevision)
  const submitted = await submit(rollback, rollbackSource.id, 'turnaround-rollback-v1')
  const failed = await terminalJob(rollback.baseUrl, String(submitted.body.job.id))
  assert.equal(failed.status, 'failed')
  assert.equal(rollback.renderer.calls, 1)
  const jobAssets = rollback.runtime.database.withSql((sql) => sql.all(`
    SELECT id FROM media_assets WHERE generation_job_id = ?
  `, String(submitted.body.job.id)))
  assert.deepEqual(jobAssets, [])
  assert.deepEqual(
    rollback.runtime.database.listMediaAssets({ projectId: 'default', episodeId: rollbackEpisodeId }).map((asset) => asset.id),
    [rollbackSource.id],
  )
})

test('queued turnaround derivation recovers after restart with immutable bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-turnaround-restart-'))
  const credentials = new MemoryCredentials()
  let first: ApplicationRuntime | undefined
  let second: ApplicationRuntime | undefined
  let firstServer: Server | undefined
  let secondServer: Server | undefined
  try {
    const firstRenderer = new FixtureRenderer()
    first = await createApplication({
      runtimeDirectory: directory,
      provider: new NoopImageProvider(),
      keychain: credentials,
      loadByoaCredential: async () => null,
      hasByoaCredential: async () => false,
      turnaroundCropRenderer: firstRenderer,
      autoStartWorker: false,
    })
    firstServer = createServer(first.app)
    const firstBaseUrl = await listen(firstServer)
    const episodeId = 'turnaround-restart'
    const revisionId = persistStory(first, episodeId)
    const source = await authenticSource(first, episodeId, revisionId)
    const submitted = await json<{ job: { id: string } }>(
      `${firstBaseUrl}/api/v1/assets/${source.id}/derivations/turnaround`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'turnaround-restart-v1',
          'if-match': await assetEtag(firstBaseUrl, source.id),
        },
        body: JSON.stringify({ projectId: 'default', crops: CROPS }),
      },
    )
    assert.equal(submitted.response.status, 202)
    await new Promise<void>((resolve) => firstServer!.close(() => resolve()))
    firstServer = undefined
    await first.close()
    first = undefined

    const recoveredRenderer = new FixtureRenderer()
    second = await createApplication({
      runtimeDirectory: directory,
      provider: new NoopImageProvider(),
      keychain: credentials,
      loadByoaCredential: async () => null,
      hasByoaCredential: async () => false,
      turnaroundCropRenderer: recoveredRenderer,
    })
    secondServer = createServer(second.app)
    const secondBaseUrl = await listen(secondServer)
    const completed = await terminalJob(secondBaseUrl, submitted.body.job.id)
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed))
    assert.equal(recoveredRenderer.calls, 1)
    assert.equal((completed.output as { assets: unknown[] }).assets.length, 3)
  } finally {
    if (firstServer) await new Promise<void>((resolve) => firstServer!.close(() => resolve()))
    if (secondServer) await new Promise<void>((resolve) => secondServer!.close(() => resolve()))
    await first?.close()
    await second?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('bundled FFmpeg emits three real PNG crops with the frozen pixel geometry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-turnaround-ffmpeg-'))
  try {
    const renderer = new FfmpegTurnaroundCropRenderer({ workingDirectory: directory })
    const outputs = await renderer.crop({
      sourceBytes: SOURCE_PNG,
      sourceMimeType: 'image/png',
      crops: validateTurnaroundCrops(CROPS, 300, 100),
      signal: new AbortController().signal,
    })
    assert.deepEqual(outputs.map(({ role, width, height }) => ({ role, width, height })), [
      { role: 'front', width: 300, height: 300 },
      { role: 'side', width: 300, height: 300 },
      { role: 'back', width: 300, height: 300 },
    ])
    assert.ok(outputs.every((output) => Buffer.from(output.bytes).subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )))
    assert.notDeepEqual(Buffer.from(outputs[0].bytes), Buffer.from(outputs[1].bytes))
    assert.notDeepEqual(Buffer.from(outputs[1].bytes), Buffer.from(outputs[2].bytes))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
