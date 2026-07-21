import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import type { KeychainCredentialSlot } from './keychain.js'
import {
  SeedanceProviderError,
  type SeedanceCancellationCapability,
  type SeedanceCancellationResult,
  type SeedanceCreateTaskInput,
  type SeedanceTask,
  type SeedanceVideoProviderContract,
} from './providers/seedance.js'
import type { ProviderCredentialStore, ProviderProbe } from './providers/service.js'
import { SEEDANCE_AGENT_PLAN_MODELS } from './providers/catalog.js'
import type { StoryDocument } from './story-schema.js'
import {
  prepareShotVideoBatch,
  shotVideoBatchChildIdempotencyKey,
  type ShotVideoBatchRequest,
} from './shot-video-batch.js'
import {
  createShotVideoJobInput,
  resolvePublicShotVideoTarget,
  SHOT_VIDEO_GENERATION_JOB_TYPE,
} from './shot-video-generation.js'
import type {
  ImageGenerationInput,
  ImageProvider,
  JsonObject,
  ProviderImage,
  ProviderImageReference,
} from './types.js'

const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
  0x69, 0x73, 0x6f, 0x32,
])

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const seedanceVideoProbe = async () => ({
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSeconds: 5,
  streamCount: 1,
  video: { codec: 'h264', width: 1280, height: 720, frameRate: 24 },
  audio: [],
})

class NoopImageProvider implements ImageProvider {
  readonly name = 'fixture-image'
  readonly model = 'fixture-image-model'
  readonly configured = true
  readonly supportsImageReferences = true

  async health() {
    return { status: 'ok' as const, message: 'fixture ready' }
  }

  async generate(
    input: ImageGenerationInput,
    _signal?: AbortSignal,
    _references: readonly ProviderImageReference[] = [],
  ): Promise<ProviderImage[]> {
    return Array.from({ length: input.count }, () => ({
      bytes: ONE_PIXEL_PNG,
      mimeType: 'image/png',
    }))
  }
}

class MemoryCredentialStore implements ProviderCredentialStore {
  readonly values = new Map<string, string>()
  readonly reads: string[] = []

  key(slot: KeychainCredentialSlot): string {
    return `${slot.providerId}:${slot.credentialKind ?? 'api-key'}`
  }

  async get(slot: KeychainCredentialSlot): Promise<string | null> {
    const key = this.key(slot)
    this.reads.push(key)
    return this.values.get(key) ?? null
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

type ProviderMode = 'success' | 'wait' | 'fail-once'

class FixtureSeedanceProvider implements SeedanceVideoProviderContract {
  readonly name = 'fixture-seedance'
  readonly model = SEEDANCE_AGENT_PLAN_MODELS[0]
  readonly configured = true
  cancellationCapability: SeedanceCancellationCapability = 'upstream-delete'
  readonly createInputs: SeedanceCreateTaskInput[] = []
  readonly getTaskIds: string[] = []
  readonly cancelledTaskIds: string[] = []
  cancelError: Error | null = null
  mode: ProviderMode = 'success'
  failuresRemaining = 0
  private taskSequence = 0
  private getStartedResolve!: () => void
  private getStartedPromise = new Promise<void>((resolve) => {
    this.getStartedResolve = resolve
  })

  waitForGet(): Promise<void> {
    return this.getStartedPromise
  }

  async createTask(input: SeedanceCreateTaskInput): Promise<{ id: string }> {
    this.createInputs.push(structuredClone(input))
    this.taskSequence += 1
    return { id: `fixture-video-task-${this.taskSequence}` }
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<SeedanceTask> {
    this.getTaskIds.push(taskId)
    this.getStartedResolve()
    if (this.mode === 'wait') {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new Error('aborted'))
        if (signal?.aborted) {
          abort()
          return
        }
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    if (this.mode === 'fail-once' && this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new SeedanceProviderError(
        'UPSTREAM_UNAVAILABLE',
        'Seedance 测试上游暂时不可用',
        true,
      )
    }
    return {
      id: taskId,
      model: this.model,
      status: 'succeeded',
      createdAt: null,
      updatedAt: null,
      videoUrl: `https://media.example/${taskId}.mp4?temporary=1`,
      durationSeconds: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      completionTokens: 1_234,
      error: null,
    }
  }

  async cancelTask(taskId: string): Promise<SeedanceCancellationResult> {
    if (this.cancelError) throw this.cancelError
    if (this.cancellationCapability === 'local-only') {
      return { capability: 'local-only', outcome: 'unsupported' }
    }
    this.cancelledTaskIds.push(taskId)
    return { capability: 'upstream-delete', outcome: 'requested' }
  }
}

interface RunningFixture {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
  credentials: MemoryCredentialStore
  videoProvider: FixtureSeedanceProvider
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

function insertStoryGraph(runtime: ApplicationRuntime): void {
  const now = '2026-07-14T00:00:00.000Z'
  runtime.database.createProject({
    id: 'video-project',
    title: '视频生成项目',
    createdAt: now,
    updatedAt: now,
  })
  runtime.database.createRevision({
    id: 'video-revision-1',
    projectId: 'video-project',
    summary: '视频测试剧本',
    snapshot: { version: 1 },
    createdAt: now,
  })
  runtime.database.withSql((sql) => {
    sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
        style_preset, status, sort_order, created_at, updated_at, metadata_json,
        source_revision_id
      ) VALUES (
        'video-episode', 'video-project', '第一集', '', 30, '16:9', '', 'draft', 0,
        ?, ?, '{}', 'video-revision-1'
      )
    `, now, now)
    sql.run(`
      INSERT INTO scenes (
        id, episode_id, sequence, title, description, duration_seconds,
        metadata_json, created_at, updated_at
      ) VALUES (
        'database-video-scene', 'video-episode', 0, '断崖', '黄昏断崖', 30,
        '{"storyId":"scene-1"}', ?, ?
      )
    `, now, now)
    sql.run(`
      INSERT INTO shots (
        id, scene_id, sequence, code, title, description, framing, movement,
        transition, duration_seconds, timeline_start_seconds, prompt, status,
        source_revision_id, metadata_json, created_at, updated_at
      ) VALUES (
        'database-video-shot', 'database-video-scene', 0, 'S01', '回望',
        '阿离在断崖回头', '中景', '缓慢推近', 'cut', 5, 0,
        '阿离在断崖回头，镜头缓慢推近。', 'draft', 'video-revision-1',
        '{"storyId":"shot-1"}', ?, ?
      )
    `, now, now)
  })
  runtime.database.updateProject('video-project', {
    currentEpisodeId: 'video-episode',
    currentRevisionId: 'video-revision-1',
  })
}

function addSecondVideoShot(runtime: ApplicationRuntime): void {
  const now = '2026-07-14T00:00:10.000Z'
  runtime.database.withSql((sql) => {
    sql.run(`
      INSERT INTO shots (
        id, scene_id, sequence, code, title, description, framing, movement,
        transition, duration_seconds, timeline_start_seconds, prompt, status,
        source_revision_id, metadata_json, created_at, updated_at
      ) VALUES (
        'database-video-shot-2', 'database-video-scene', 1, 'S02', '拔剑',
        '阿离拔剑迎敌', '近景', '快速横移', 'cut', 5, 5,
        '阿离拔剑迎敌，镜头快速横移。', 'draft', 'video-revision-1',
        '{"storyId":"shot-2"}', ?, ?
      )
    `, now, now)
  })
}

function addVideoDialogueLine(
  runtime: ApplicationRuntime,
  index: number,
  options: { durationSeconds?: number; checksumSeed?: string } = {},
): string | null {
  const now = '2026-07-14T00:00:20.000Z'
  const lineId = `video-line-${index}`
  runtime.database.withSql((sql) => sql.run(`
    INSERT INTO dialogue_lines (
      id, shot_id, sequence, kind, text, metadata_json, created_at, updated_at
    ) VALUES (?, 'database-video-shot', ?, 'dialogue', ?, ?, ?, ?)
  `, lineId, index, `第 ${index + 1} 句台词`, JSON.stringify({ storyId: `line-${index}` }), now, now))
  if (options.durationSeconds === undefined) return null
  const durationSeconds = options.durationSeconds
  const assetId = `video-speech-${index}-${options.checksumSeed ?? 'a'}`
  runtime.database.createMediaAsset({
    id: assetId,
    projectId: 'video-project',
    episodeId: 'video-episode',
    kind: 'speech',
    status: 'ready',
    source: 'fixture',
    filePath: `/fixture/${assetId}.mp3`,
    mimeType: 'audio/mpeg',
    durationSeconds,
    checksum: (options.checksumSeed ?? 'a').repeat(64),
    sourceRevisionId: 'video-revision-1',
  })
  runtime.database.withSql((sql) => sql.run(`
    UPDATE dialogue_lines
       SET speech_asset_id = ?, duration_seconds = ?
     WHERE id = ?
  `, assetId, durationSeconds, lineId))
  return assetId
}

async function fixture(options: {
  mode?: ProviderMode
  failuresRemaining?: number
  maxConsecutivePollErrors?: number
  durableStatusCheckIntervalMs?: number
  autoStartWorker?: boolean
  enforcePaidAigcConfirmation?: boolean
  shotVideoPreflightNow?: () => Date
  /** Exercise the production health gate instead of the deterministic provider override. */
  enforceProviderHealth?: boolean
  providerProbe?: ProviderProbe
  textCompatibleFetch?: typeof fetch
  maxQueueDepth?: number
} = {}): Promise<RunningFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-shot-video-http-test-'))
  const credentials = new MemoryCredentialStore()
  const videoProvider = new FixtureSeedanceProvider()
  videoProvider.mode = options.mode ?? 'success'
  videoProvider.failuresRemaining = options.failuresRemaining ?? 0
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider: new NoopImageProvider(),
    keychain: credentials,
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    ...(options.enforceProviderHealth ? {} : { seedanceProvider: videoProvider }),
    ...(options.providerProbe ? { providerProbe: options.providerProbe } : {}),
    ...(options.textCompatibleFetch ? { textCompatibleFetch: options.textCompatibleFetch } : {}),
    ...(options.maxQueueDepth !== undefined ? { maxQueueDepth: options.maxQueueDepth } : {}),
    ...(options.enforcePaidAigcConfirmation !== undefined
      ? { enforcePaidAigcConfirmation: options.enforcePaidAigcConfirmation }
      : {}),
    seedanceDownloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
    seedanceVideoProbe,
    seedancePollIntervalMs: 0,
    ...(options.autoStartWorker !== undefined ? { autoStartWorker: options.autoStartWorker } : {}),
    ...(options.maxConsecutivePollErrors !== undefined
      ? { seedanceMaxConsecutivePollErrors: options.maxConsecutivePollErrors }
      : {}),
    ...(options.durableStatusCheckIntervalMs !== undefined
      ? { seedanceDurableStatusCheckIntervalMs: options.durableStatusCheckIntervalMs }
      : {}),
    ...(options.shotVideoPreflightNow ? { shotVideoPreflightNow: options.shotVideoPreflightNow } : {}),
  })
  insertStoryGraph(runtime)
  const server = createServer(runtime.app)
  const running = {
    directory,
    runtime,
    server,
    baseUrl: await listen(server),
    credentials,
    videoProvider,
  }
  fixtures.push(running)
  return running
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      item.server.close((error) => error ? reject(error) : resolve())
    })
    await item.runtime.close()
    await rm(item.directory, { recursive: true, force: true })
  }
})

async function json<T>(url: string, init?: RequestInit): Promise<{
  response: Response
  body: T
  text: string
}> {
  const response = await fetch(url, init)
  const text = await response.text()
  return { response, body: JSON.parse(text) as T, text }
}

function videoRequest(durationSeconds = 5): string {
  return JSON.stringify({
    projectId: 'video-project',
    episodeId: 'video-episode',
    sceneId: 'scene-1',
    resolution: '720p',
    durationSeconds,
  })
}

async function addVideoReferenceAsset(
  current: RunningFixture,
  id: string,
): Promise<string> {
  // MediaStore only needs a supported immutable image; the IHDR dimensions
  // are adjusted to Seedance's documented minimum for the execution guard.
  const bytes = Buffer.from(ONE_PIXEL_PNG)
  bytes.writeUInt32BE(300, 16)
  bytes.writeUInt32BE(300, 20)
  const asset = await current.runtime.mediaStore.save({
    id,
    projectId: 'video-project',
    episodeId: 'video-episode',
    kind: 'storyboard',
    bytes,
    mimeType: 'image/png',
    source: 'provider',
    sourceRevisionId: 'video-revision-1',
    width: 300,
    height: 300,
  })
  return asset.id
}

async function addLockedCharacterViews(current: RunningFixture): Promise<Record<'front' | 'side' | 'back', string>> {
  const now = '2026-07-14T00:00:20.000Z'
  current.runtime.database.withSql((sql) => sql.run(`
    INSERT INTO characters (
      id, project_id, episode_id, name, story_description, visual_description,
      version, metadata_json, created_at, updated_at
    ) VALUES (
      'database-character-ali', 'video-project', 'video-episode', '阿离', '', '', 1,
      '{"storyId":"ali"}', ?, ?
    )
  `, now, now))
  const audit = current.runtime.database.createRevision({
    id: 'video-character-views-audit',
    projectId: 'video-project',
    summary: '锁定阿离三视图',
    snapshot: { version: 1, kind: 'character.visual-references.lock' },
    createdAt: now,
  })
  const result = {} as Record<'front' | 'side' | 'back', string>
  for (const role of ['front', 'side', 'back'] as const) {
    result[role] = await addVideoReferenceAsset(current, `video-character-${role}`)
    current.runtime.database.withSql((sql) => sql.run(`
      INSERT INTO character_visual_references (
        character_id, project_id, episode_id, role, asset_id, version,
        audit_revision_id, updated_at
      ) VALUES (
        'database-character-ali', 'video-project', 'video-episode', ?, ?, 1, ?, ?
      )
    `, role, result[role], audit.id, now))
  }
  return result
}

function editableVideoStory(title = '视频测试剧本'): StoryDocument {
  return {
    version: 1,
    title,
    targetDurationSeconds: 30,
    bible: {
      logline: '少女守护长安。',
      theme: '责任',
      tone: '紧张',
      visualStyle: '国风动画，16:9 电影构图',
    },
    characters: [{
      id: 'ali',
      name: '阿离',
      role: '主角',
      storyDescription: '年轻剑客',
      visualDescription: '黑色长发、红绳、青色圆领袍',
    }],
    locations: [{
      id: 'cliff',
      name: '断崖',
      storyDescription: '长安城外',
      visualDescription: '云海与落日，青黑色山石',
    }],
    props: [{
      id: 'token',
      name: '青铜令',
      description: '唤醒龙脉',
      visualDescription: '暗红纹路的六边形青铜令',
    }],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '断崖龙吟',
      locationId: 'cliff',
      timeOfDay: '黄昏',
      description: '龙脉苏醒',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `镜头 ${index + 1}`,
        description: '阿离在风中看向云海。',
        framing: '中景',
        movement: '缓慢推进',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '国风动画，阿离黑发红绳青袍，断崖黄昏云海，电影构图。',
        dialogueLines: [],
      })),
    }],
  }
}

async function configureSeedance(current: RunningFixture): Promise<{
  configRevision: number
}> {
  const result = await json<{
    provider: { configRevision: number; credentialState: string; enabled: boolean }
  }>(`${current.baseUrl}/api/v1/providers/seedance-video/credentials`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'seedance-http-secret', enabled: true }),
  })
  assert.equal(result.response.status, 200, result.text)
  assert.equal(result.body.provider.enabled, true)
  assert.equal(result.body.provider.credentialState, 'present')
  assert.doesNotMatch(result.text, /seedance-http-secret/)
  return { configRevision: result.body.provider.configRevision }
}

async function configureVisionTextProvider(current: RunningFixture): Promise<void> {
  await current.runtime.providerService.save('custom-text', {
    apiKey: 'fixture-vision-text-key',
    baseUrl: 'https://vision-text.example/v1',
    model: 'fixture-vision-model',
    enabled: true,
  })
  await current.runtime.providerService.test('custom-text')
  await current.runtime.providerService.setDefault('custom-text')
}

function successfulVisualTextResponse(shotId: string): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          shots: [{
            shotId,
            strategy: 'first_frame',
            compositionAnchorVisualId: 'I01',
            referenceVisualIds: [],
            characterViews: [],
            confidence: 0.92,
            rationale: '分镜构图清晰，使用当前分镜作为首帧锚点。',
            visualEvidence: ['人物与地平线构图清晰'],
          }],
        }),
      },
    }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function bindVideoStoryboard(
  current: RunningFixture,
  databaseShotId: string,
  assetId: string,
): Promise<string> {
  const savedAssetId = await addVideoReferenceAsset(current, assetId)
  current.runtime.database.withSql((sql) => sql.run(`
    UPDATE shots
       SET storyboard_asset_id = ?, status = 'storyboard_ready'
     WHERE id = ?
  `, savedAssetId, databaseShotId))
  return savedAssetId
}

async function createConfirmedVideoJob(
  current: RunningFixture,
  rootIdempotencyKey: string,
  durationSeconds = 5,
): Promise<{ id: string }> {
  const body = {
    projectId: 'video-project',
    providerId: 'seedance-video',
    resolution: '720p',
    generateAudio: false,
    selections: [{
      shotId: 'shot-1',
      sceneId: 'scene-1',
      durationSeconds,
      references: [],
    }],
  }
  const preflight = await json<{ preflight: { confirmationToken: string } }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-generations/preflight`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': rootIdempotencyKey,
      },
      body: JSON.stringify(body),
    },
  )
  assert.equal(preflight.response.status, 200, preflight.text)
  const created = await json<{ jobs: Array<{ id: string }> }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': rootIdempotencyKey,
      },
      body: JSON.stringify({ ...body, confirmationToken: preflight.body.preflight.confirmationToken }),
    },
  )
  assert.equal(created.response.status, 202, created.text)
  assert.equal(created.body.jobs.length, 1)
  return created.body.jobs[0]
}

async function terminalJob(baseUrl: string, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await json<{ job: Record<string, unknown> }>(`${baseUrl}/api/v1/jobs/${id}`)
    if (['succeeded', 'failed', 'cancelled'].includes(String(result.body.job.status))) {
      return result.body.job
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Job did not finish: ${id}`)
}

async function assertStoryMutationStopsActiveVideo(
  mutation: 'edit' | 'restore',
): Promise<void> {
  const current = await fixture({
    mode: 'wait',
    durableStatusCheckIntervalMs: 5,
  })
  const original = current.runtime.storyRepository.applyStory(
    'video-episode',
    editableVideoStory('原始剧本'),
  )
  const activeRevision = mutation === 'restore'
    ? current.runtime.storyRepository.updateShot(
        'video-episode',
        'shot-1',
        { title: '待恢复的编辑版' },
        { expectedRevisionId: original.revision.id },
      ).revision.id
    : original.revision.id

  await configureSeedance(current)
  const created = await createConfirmedVideoJob(current, `video-story-${mutation}`)
  await current.videoProvider.waitForGet()

  const changed = mutation === 'edit'
    ? current.runtime.storyRepository.updateShot(
        'video-episode',
        'shot-1',
        { title: '生成期间修改的镜头' },
        { expectedRevisionId: activeRevision },
      )
    : current.runtime.storyRepository.restoreStoryRevision(
        'video-episode',
        original.revision.id,
        { expectedRevisionId: activeRevision },
      )
  assert.equal(changed.stale.jobs, 1)
  await current.runtime.worker.waitForIdle()

  const terminal = current.runtime.database.getGenerationJob(created.id)
  assert.equal(terminal?.status, 'cancelled')
  assert.equal(terminal?.error?.code, 'STALE_SOURCE')
  assert.equal(terminal?.externalTaskId, 'fixture-video-task-1')
  assert.equal(current.videoProvider.createInputs.length, 1)
  assert.deepEqual(current.videoProvider.getTaskIds, ['fixture-video-task-1'])
  assert.deepEqual(current.videoProvider.cancelledTaskIds, ['fixture-video-task-1'])
  assert.equal(current.runtime.database.listMediaAssets({
    projectId: 'video-project',
    kind: 'shot.video',
  }).length, 0)
}

test('visual reference analysis HTTP creates one free durable Job and strictly replays its exact scope', async () => {
  const current = await fixture({
    autoStartWorker: false,
    enforcePaidAigcConfirmation: true,
    providerProbe: async () => ({ status: 'ok', message: 'fixture vision ready' }),
  })
  await configureVisionTextProvider(current)
  await bindVideoStoryboard(current, 'database-video-shot', 'visual-http-storyboard-1')
  addSecondVideoShot(current.runtime)
  await bindVideoStoryboard(current, 'database-video-shot-2', 'visual-http-storyboard-2')

  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-reference-analyses`
  const firstBody = {
    projectId: 'video-project',
    textProviderId: 'custom-text',
    selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
  }
  const submit = (body: unknown, key: string) => json<{
    job?: {
      id: string
      projectId: string
      episodeId: string
      type: string
      status: string
      providerId: string
      model: string
      providerConfigRevision: number
      input: {
        expectedStoryRevisionId: string
        inputFingerprint: string
        selectors: Array<{ shotId: string; sceneId?: string }>
        candidateCount: number
      }
    }
    error?: { code: string }
  }>(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  })

  const created = await submit(firstBody, 'visual-http-exact-replay')
  assert.equal(created.response.status, 202, created.text)
  assert.equal(created.body.job?.type, 'shot.video.reference.analyze')
  assert.equal(created.body.job?.status, 'queued')
  assert.equal(created.body.job?.projectId, 'video-project')
  assert.equal(created.body.job?.episodeId, 'video-episode')
  assert.equal(created.body.job?.providerId, 'custom-text')
  assert.equal(created.body.job?.model, 'fixture-vision-model')
  assert.equal(created.body.job?.input.expectedStoryRevisionId, 'video-revision-1')
  assert.deepEqual(created.body.job?.input.selectors, [{ shotId: 'shot-1', sceneId: 'scene-1' }])
  assert.equal(created.body.job?.input.candidateCount, 1)
  assert.match(created.body.job?.input.inputFingerprint ?? '', /^[a-f0-9]{64}$/)
  assert.doesNotMatch(created.text, /confirmationToken|paid confirmation|billableTaskCount/i)
  assert.equal(current.videoProvider.createInputs.length, 0)

  const durable = current.runtime.database.getGenerationJob(created.body.job!.id)
  assert.equal(durable?.type, 'shot.video.reference.analyze')
  assert.equal(durable?.status, 'queued')
  assert.equal(durable?.input.expectedStoryRevisionId, 'video-revision-1')
  assert.equal(Array.isArray(durable?.input.candidates), true)
  assert.equal(typeof (durable?.input.candidates as Array<{ visualId?: unknown }>)[0]?.visualId, 'string')
  assert.equal(JSON.stringify(durable?.input).includes('"token"'), false)

  const replay = await submit(firstBody, 'visual-http-exact-replay')
  assert.equal(replay.response.status, 200, replay.text)
  assert.equal(replay.body.job?.id, created.body.job?.id)

  const conflict = await submit({
    ...firstBody,
    selections: [{ shotId: 'shot-2', sceneId: 'scene-1' }],
  }, 'visual-http-exact-replay')
  assert.equal(conflict.response.status, 409, conflict.text)
  assert.equal(conflict.body.error?.code, 'IDEMPOTENCY_CONFLICT')

  const unknownField = await submit({
    ...firstBody,
    rawVisualPlan: { selectedReferences: [] },
  }, 'visual-http-unknown-field')
  assert.equal(unknownField.response.status, 400, unknownField.text)
  assert.equal(unknownField.body.error?.code, 'INVALID_REQUEST')
  assert.equal(current.runtime.database.listGenerationJobs({
    projectId: 'video-project',
    type: 'shot.video.reference.analyze',
  }).length, 1)
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('visual reference batch admission atomically creates exact single-shot children and is restart-queryable', async () => {
  const current = await fixture({
    autoStartWorker: false,
    providerProbe: async () => ({ status: 'ok', message: 'fixture vision ready' }),
  })
  await configureVisionTextProvider(current)
  await bindVideoStoryboard(current, 'database-video-shot', 'visual-batch-storyboard-1')
  addSecondVideoShot(current.runtime)
  await bindVideoStoryboard(current, 'database-video-shot-2', 'visual-batch-storyboard-2')
  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-reference-analyses`
  const body = {
    projectId: 'video-project',
    textProviderId: 'custom-text',
    selections: [
      { shotId: 'shot-1', sceneId: 'scene-1' },
      { shotId: 'shot-2', sceneId: 'scene-1' },
    ],
  }
  type BatchResponse = {
    batch: {
      id: string
      requestFingerprint: string
      status: string
      progress: number
      counts: { total: number; queued: number }
      selections: Array<{
        shotId: string
        sceneId: string
        jobId: string
        authority: { usable: boolean; reason: string }
      }>
    }
    jobs: Array<{
      id: string
      resourceType: string
      input: {
        selectors: Array<{ shotId: string; sceneId: string }>
        batch: {
          batchId: string
          requestFingerprint: string
          selectionIndex: number
          selectionCount: number
        }
      }
    }>
    error?: { code: string }
  }
  const submit = (requestBody: unknown, key = 'visual-batch-atomic-v1') => json<BatchResponse>(
    endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(requestBody),
    },
  )
  const created = await submit(body)
  assert.equal(created.response.status, 202, created.text)
  assert.equal(created.body.batch.status, 'queued')
  assert.equal(created.body.batch.progress, 0)
  assert.deepEqual(created.body.batch.counts, {
    total: 2, queued: 2, running: 0, succeeded: 0, failed: 0,
  })
  assert.match(created.body.batch.id, /^vrb-[a-f0-9]{32}$/)
  assert.match(created.body.batch.requestFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(created.body.jobs.length, 2)
  assert.equal(new Set(created.body.jobs.map((job) => job.id)).size, 2)
  assert.deepEqual(created.body.jobs.map((job) => job.input.selectors), [
    [{ shotId: 'shot-1', sceneId: 'scene-1' }],
    [{ shotId: 'shot-2', sceneId: 'scene-1' }],
  ])
  assert.deepEqual(created.body.jobs.map((job) => job.resourceType), [
    'provider:text:vision', 'provider:text:vision',
  ])
  assert.deepEqual(created.body.jobs.map((job) => job.input.batch.selectionIndex), [0, 1])
  assert.ok(created.body.jobs.every((job) => (
    job.input.batch.batchId === created.body.batch.id
      && job.input.batch.requestFingerprint === created.body.batch.requestFingerprint
      && job.input.batch.selectionCount === 2
  )))
  for (const job of created.body.jobs) {
    assert.deepEqual(
      current.runtime.database.getGenerationJob(job.id)?.cost?.platformPolicy,
      {
        version: 1,
        costClass: 'free-llm',
        billable: false,
        paidConfirmationRequired: false,
        upstreamProviderBilling: 'outside-platform-policy',
      },
    )
  }

  const replay = await submit(body)
  assert.equal(replay.response.status, 200, replay.text)
  assert.deepEqual(replay.body.jobs.map((job) => job.id), created.body.jobs.map((job) => job.id))

  const conflict = await submit({
    ...body,
    selections: [...body.selections].reverse(),
  })
  assert.equal(conflict.response.status, 409, conflict.text)
  assert.equal(conflict.body.error?.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(current.runtime.database.listGenerationJobs({
    projectId: 'video-project',
    type: 'shot.video.reference.analyze',
  }).length, 2)

  const scope = new URLSearchParams({
    projectId: 'video-project',
    sourceRevisionId: 'video-revision-1',
    textProviderId: 'custom-text',
  })
  const batch = await json<BatchResponse>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-reference-analysis-batches/${created.body.batch.id}?${scope}`,
  )
  assert.equal(batch.response.status, 200, batch.text)
  assert.deepEqual(batch.body.jobs.map((job) => job.id), created.body.jobs.map((job) => job.id))
  // Do not deep-compare the full authority evidence; fingerprints are
  // intentionally server-authored. The important restore decision is exact.
  assert.deepEqual(
    batch.body.batch.selections.map((selection) => [selection.authority.usable, selection.authority.reason]),
    [[false, 'job_not_succeeded'], [false, 'job_not_succeeded']],
  )
  const hydrated = await json<{
    analyses: Array<{ shotId: string; sceneId: string; job: { id: string }; authority: { reason: string } }>
  }>(`${endpoint}?${scope}`)
  assert.equal(hydrated.response.status, 200, hydrated.text)
  assert.deepEqual(hydrated.body.analyses.map((binding) => (
    [binding.sceneId, binding.shotId, binding.job.id, binding.authority.reason]
  )).sort((left, right) => String(left[1]).localeCompare(String(right[1]))), [
    ['scene-1', 'shot-1', created.body.jobs[0]!.id, 'job_not_succeeded'],
    ['scene-1', 'shot-2', created.body.jobs[1]!.id, 'job_not_succeeded'],
  ])

  current.runtime.database.updateGenerationJob(created.body.jobs[0]!.id, {
    status: 'failed',
    error: {
      code: 'UPSTREAM_UNAVAILABLE',
      message: '视觉服务暂时不可用',
      retryable: true,
      category: 'provider',
    },
    completedAt: '2026-07-15T00:00:00.000Z',
  })
  const retried = await json<{ job: { id: string } }>(
    `${current.baseUrl}/api/v1/jobs/${created.body.jobs[0]!.id}/retry`,
    { method: 'POST', headers: { 'idempotency-key': 'visual-batch-child-retry' } },
  )
  assert.equal(retried.response.status, 202, retried.text)
  assert.notEqual(retried.body.job.id, created.body.jobs[0]!.id)
  const afterRetry = await json<BatchResponse>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-reference-analysis-batches/${created.body.batch.id}?${scope}`,
  )
  assert.equal(afterRetry.response.status, 200, afterRetry.text)
  assert.deepEqual(afterRetry.body.jobs.map((job) => job.id), [
    retried.body.job.id,
    created.body.jobs[1]!.id,
  ])
  const replayAfterRetry = await submit(body)
  assert.equal(replayAfterRetry.response.status, 200, replayAfterRetry.text)
  assert.deepEqual(replayAfterRetry.body.jobs.map((job) => job.id), [
    retried.body.job.id,
    created.body.jobs[1]!.id,
  ])
  const hydratedAfterRetry = await json<{
    analyses: Array<{ shotId: string; job: { id: string } }>
  }>(`${endpoint}?${scope}`)
  assert.equal(hydratedAfterRetry.response.status, 200, hydratedAfterRetry.text)
  assert.equal(
    hydratedAfterRetry.body.analyses.find((binding) => binding.shotId === 'shot-1')?.job.id,
    retried.body.job.id,
    'hydration must expose the newest linear retry leaf, never its older ancestor',
  )
  assert.equal(current.runtime.database.listGenerationJobs({
    projectId: 'video-project',
    type: 'shot.video.reference.analyze',
  }).length, 3, 'immutable retry ancestry stays durable but the batch exposes only each leaf')
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('visual reference batch capacity rejection is atomic', async () => {
  const current = await fixture({
    autoStartWorker: false,
    maxQueueDepth: 1,
    providerProbe: async () => ({ status: 'ok', message: 'fixture vision ready' }),
  })
  await configureVisionTextProvider(current)
  await bindVideoStoryboard(current, 'database-video-shot', 'visual-batch-capacity-1')
  addSecondVideoShot(current.runtime)
  await bindVideoStoryboard(current, 'database-video-shot-2', 'visual-batch-capacity-2')
  const rejected = await json<{ error: { code: string } }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-reference-analyses`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'visual-batch-capacity' },
      body: JSON.stringify({
        projectId: 'video-project',
        textProviderId: 'custom-text',
        selections: [
          { shotId: 'shot-1', sceneId: 'scene-1' },
          { shotId: 'shot-2', sceneId: 'scene-1' },
        ],
      }),
    },
  )
  assert.equal(rejected.response.status, 429, rejected.text)
  assert.equal(rejected.body.error.code, 'QUEUE_FULL')
  assert.equal(current.runtime.database.listGenerationJobs({
    projectId: 'video-project',
    type: 'shot.video.reference.analyze',
  }).length, 0)
})

test('visual reference hydration revalidates exact Asset and Provider revision authority', async () => {
  const current = await fixture({
    autoStartWorker: false,
    providerProbe: async () => ({ status: 'ok', message: 'fixture vision ready' }),
  })
  await configureVisionTextProvider(current)
  const firstStoryboard = await bindVideoStoryboard(
    current,
    'database-video-shot',
    'visual-authority-storyboard-1',
  )
  addSecondVideoShot(current.runtime)
  await bindVideoStoryboard(current, 'database-video-shot-2', 'visual-authority-storyboard-2')
  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-reference-analyses`
  const created = await json<{ jobs: Array<{ id: string }> }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'visual-authority-batch' },
    body: JSON.stringify({
      projectId: 'video-project',
      textProviderId: 'custom-text',
      selections: [
        { shotId: 'shot-1', sceneId: 'scene-1' },
        { shotId: 'shot-2', sceneId: 'scene-1' },
      ],
    }),
  })
  assert.equal(created.response.status, 202, created.text)
  current.runtime.database.updateMediaAsset(firstStoryboard, { version: 2 })
  const scope = new URLSearchParams({
    projectId: 'video-project',
    sourceRevisionId: 'video-revision-1',
    textProviderId: 'custom-text',
  })
  const assetDrift = await json<{
    analyses: Array<{ shotId: string; authority: { usable: boolean; reason: string } }>
  }>(`${endpoint}?${scope}`)
  assert.equal(assetDrift.response.status, 200, assetDrift.text)
  assert.deepEqual(Object.fromEntries(assetDrift.body.analyses.map((binding) => (
    [binding.shotId, binding.authority.reason]
  ))), {
    'shot-1': 'visual_inputs_changed',
    'shot-2': 'job_not_succeeded',
  })

  await current.runtime.providerService.save('custom-text', {
    apiKey: 'fixture-vision-text-key-revision-2',
    baseUrl: 'https://vision-text.example/v1',
    model: 'fixture-vision-model-v2',
    enabled: true,
  })
  const providerDrift = await json<{
    analyses: Array<{ shotId: string; authority: { usable: boolean; reason: string } }>
  }>(`${endpoint}?${scope}`)
  assert.equal(providerDrift.response.status, 200, providerDrift.text)
  assert.deepEqual(providerDrift.body.analyses.map((binding) => binding.authority.reason), [
    'provider_revision_changed',
    'provider_revision_changed',
  ])
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('visual reference batch children run with bounded parallelism and preserve per-shot results', async () => {
  let releaseProvider!: () => void
  const providerHeld = new Promise<void>((resolve) => { releaseProvider = resolve })
  let bothStartedResolve!: () => void
  const bothStarted = new Promise<void>((resolve) => { bothStartedResolve = resolve })
  let calls = 0
  let active = 0
  let maxActive = 0
  const textCompatibleFetch: typeof fetch = async (_input, init) => {
    calls += 1
    active += 1
    maxActive = Math.max(maxActive, active)
    if (calls === 2) bothStartedResolve()
    const requestBody = JSON.parse(String(init?.body)) as unknown
    const strings: string[] = []
    const visit = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value)
      else if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') Object.values(value).forEach(visit)
    }
    visit(requestBody)
    const shotId = /"shotId":"([^"]+)"/.exec(strings.join('\n'))?.[1]
    assert.ok(shotId === 'shot-1' || shotId === 'shot-2')
    await providerHeld
    active -= 1
    return successfulVisualTextResponse(shotId)
  }
  const current = await fixture({
    textCompatibleFetch,
    providerProbe: async () => ({ status: 'ok', message: 'fixture vision ready' }),
  })
  await configureVisionTextProvider(current)
  await bindVideoStoryboard(current, 'database-video-shot', 'visual-batch-parallel-1')
  addSecondVideoShot(current.runtime)
  await bindVideoStoryboard(current, 'database-video-shot-2', 'visual-batch-parallel-2')
  const created = await json<{
    batch: { id: string }
    jobs: Array<{ id: string }>
  }>(`${current.baseUrl}/api/v1/episodes/video-episode/video-reference-analyses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'visual-batch-parallel' },
    body: JSON.stringify({
      projectId: 'video-project',
      textProviderId: 'custom-text',
      selections: [
        { shotId: 'shot-1', sceneId: 'scene-1' },
        { shotId: 'shot-2', sceneId: 'scene-1' },
      ],
    }),
  })
  assert.equal(created.response.status, 202, created.text)
  await Promise.race([
    bothStarted,
    new Promise<never>((_resolve, reject) => setTimeout(
      () => reject(new Error('visual children did not run concurrently')),
      2_000,
    )),
  ])
  assert.equal(calls, 2)
  assert.equal(maxActive, 2)
  assert.equal(current.runtime.worker.getStats().active, 2)
  releaseProvider()
  await current.runtime.worker.waitForIdle()
  const terminal = created.body.jobs.map((job) => current.runtime.database.getGenerationJob(job.id))
  assert.deepEqual(terminal.map((job) => job?.status), ['succeeded', 'succeeded'])
  assert.deepEqual(terminal.map((job) => (
    (job?.output?.analysis as { plans?: Array<{ shotId?: string }> } | undefined)?.plans?.[0]?.shotId
  )), ['shot-1', 'shot-2'])
  assert.equal(current.videoProvider.createInputs.length, 0, 'visual queue must never call Seedance')

  const scope = new URLSearchParams({
    projectId: 'video-project',
    sourceRevisionId: 'video-revision-1',
    textProviderId: 'custom-text',
  })
  const restored = await json<{
    batch: { status: string; counts: { succeeded: number }; selections: Array<{ authority: { usable: boolean } }> }
  }>(`${current.baseUrl}/api/v1/episodes/video-episode/video-reference-analysis-batches/${created.body.batch.id}?${scope}`)
  assert.equal(restored.response.status, 200, restored.text)
  assert.equal(restored.body.batch.status, 'succeeded')
  assert.equal(restored.body.batch.counts.succeeded, 2)
  assert.deepEqual(restored.body.batch.selections.map((selection) => selection.authority.usable), [true, true])
})

test('visual reference batch restart recovers queued children and never repeats an unknown LLM submission', async () => {
  const first = await fixture({
    autoStartWorker: false,
    providerProbe: async () => ({ status: 'ok', message: 'fixture vision ready' }),
  })
  await configureVisionTextProvider(first)
  await bindVideoStoryboard(first, 'database-video-shot', 'visual-batch-restart-1')
  addSecondVideoShot(first.runtime)
  await bindVideoStoryboard(first, 'database-video-shot-2', 'visual-batch-restart-2')
  const created = await json<{
    batch: { id: string }
    jobs: Array<{ id: string }>
  }>(`${first.baseUrl}/api/v1/episodes/video-episode/video-reference-analyses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'visual-batch-restart' },
    body: JSON.stringify({
      projectId: 'video-project',
      textProviderId: 'custom-text',
      selections: [
        { shotId: 'shot-1', sceneId: 'scene-1' },
        { shotId: 'shot-2', sceneId: 'scene-1' },
      ],
    }),
  })
  assert.equal(created.response.status, 202, created.text)
  first.runtime.database.updateGenerationJob(created.body.jobs[0]!.id, {
    status: 'waiting_provider',
    progress: 40,
    providerState: {
      operation: 'shot.video.reference.analyze',
      phase: 'submitting',
      clientRequestId: created.body.jobs[0]!.id,
      providerSupportsIdempotency: false,
      submittedAt: '2026-07-15T00:00:00.000Z',
    },
  })

  await new Promise<void>((resolve, reject) => {
    first.server.close((error) => error ? reject(error) : resolve())
  })
  await first.runtime.close()
  fixtures.splice(fixtures.indexOf(first), 1)

  let textCalls = 0
  const recoveredVideoProvider = new FixtureSeedanceProvider()
  const recoveredRuntime = await createApplication({
    runtimeDirectory: first.directory,
    provider: new NoopImageProvider(),
    keychain: first.credentials,
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    seedanceProvider: recoveredVideoProvider,
    textCompatibleFetch: async () => {
      textCalls += 1
      return successfulVisualTextResponse('shot-2')
    },
    seedanceDownloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
    seedanceVideoProbe,
    seedancePollIntervalMs: 0,
  })
  const recoveredServer = createServer(recoveredRuntime.app)
  const recovered: RunningFixture = {
    directory: first.directory,
    runtime: recoveredRuntime,
    server: recoveredServer,
    baseUrl: await listen(recoveredServer),
    credentials: first.credentials,
    videoProvider: recoveredVideoProvider,
  }
  fixtures.push(recovered)
  await recoveredRuntime.worker.waitForIdle()

  const unknown = recoveredRuntime.database.getGenerationJob(created.body.jobs[0]!.id)
  const completed = recoveredRuntime.database.getGenerationJob(created.body.jobs[1]!.id)
  assert.equal(unknown?.status, 'failed')
  assert.equal(unknown?.error?.code, 'VIDEO_REFERENCE_ANALYSIS_OUTCOME_UNKNOWN')
  assert.equal(completed?.status, 'succeeded')
  assert.equal(textCalls, 1, 'only the queued child may submit after restart')
  assert.equal(recoveredVideoProvider.createInputs.length, 0, 'recovery must never call Seedance')

  const scope = new URLSearchParams({
    projectId: 'video-project',
    sourceRevisionId: 'video-revision-1',
    textProviderId: 'custom-text',
  })
  const status = await json<{
    batch: {
      status: string
      counts: { succeeded: number; failed: number }
      selections: Array<{ status: string; authority: { reason: string } }>
    }
  }>(`${recovered.baseUrl}/api/v1/episodes/video-episode/video-reference-analysis-batches/${created.body.batch.id}?${scope}`)
  assert.equal(status.response.status, 200, status.text)
  assert.equal(status.body.batch.status, 'partial_failed')
  assert.deepEqual(status.body.batch.counts, {
    total: 2, queued: 0, running: 0, succeeded: 1, failed: 1,
  })
  assert.deepEqual(status.body.batch.selections.map((selection) => (
    [selection.status, selection.authority.reason]
  )), [
    ['failed', 'job_not_succeeded'],
    ['succeeded', 'current'],
  ])
})

test('visual reference analysis HTTP requires a verified vision-capable text Provider', async () => {
  const current = await fixture({
    autoStartWorker: false,
    providerProbe: async () => ({ status: 'ok', message: 'fixture vision ready' }),
  })
  await bindVideoStoryboard(current, 'database-video-shot', 'visual-http-provider-gate')
  await current.runtime.providerService.save('custom-text', {
    apiKey: 'fixture-unverified-vision-key',
    baseUrl: 'https://vision-text.example/v1',
    model: 'fixture-vision-model',
    enabled: true,
  })
  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-reference-analyses`
  const request = (key: string) => json<{ error: { code: string } }>(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify({
      projectId: 'video-project',
      textProviderId: 'custom-text',
      selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
    }),
  })

  const unverified = await request('visual-http-unverified-provider')
  assert.equal(unverified.response.status, 409, unverified.text)
  assert.equal(unverified.body.error.code, 'PROVIDER_NOT_VERIFIED')

  await current.runtime.providerService.test('custom-text')
  const originalList = current.runtime.providerService.list.bind(current.runtime.providerService)
  current.runtime.providerService.list = async () => (await originalList()).map((provider) => (
    provider.id === 'custom-text'
      ? { ...provider, capabilities: provider.capabilities.filter((capability) => capability !== 'vision') }
      : provider
  ))
  const withoutVision = await request('visual-http-no-vision-provider')
  assert.equal(withoutVision.response.status, 409, withoutVision.text)
  assert.equal(withoutVision.body.error.code, 'PROVIDER_NOT_VERIFIED')
  assert.equal(current.runtime.database.listGenerationJobs({
    projectId: 'video-project',
    type: 'shot.video.reference.analyze',
  }).length, 0)
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('visual reference analysis admission rejects Provider and Asset drift without creating a Job', async (context) => {
  const body = {
    projectId: 'video-project',
    textProviderId: 'custom-text',
    selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
  }
  const submit = (current: RunningFixture, key: string) => json<{ error: { code: string } }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-reference-analyses`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    },
  )

  await context.test('Provider revision changes inside admission', async () => {
    const current = await fixture({
      autoStartWorker: false,
      providerProbe: async () => ({ status: 'ok', message: 'fixture vision ready' }),
    })
    await configureVisionTextProvider(current)
    await bindVideoStoryboard(current, 'database-video-shot', 'visual-http-provider-drift')
    const originalList = current.runtime.providerService.list.bind(current.runtime.providerService)
    let calls = 0
    current.runtime.providerService.list = async () => {
      const providers = await originalList()
      calls += 1
      return calls === 2
        ? providers.map((provider) => provider.id === 'custom-text'
            ? { ...provider, configRevision: provider.configRevision + 1 }
            : provider)
        : providers
    }
    const drift = await submit(current, 'visual-http-provider-drift')
    assert.equal(drift.response.status, 409, drift.text)
    assert.equal(drift.body.error.code, 'PROVIDER_CONFIGURATION_CHANGED')
    assert.equal(current.runtime.database.listGenerationJobs({ projectId: 'video-project' }).length, 0)
    assert.equal(current.videoProvider.createInputs.length, 0)
  })

  await context.test('bound storyboard changes inside admission', async () => {
    const current = await fixture({
      autoStartWorker: false,
      providerProbe: async () => ({ status: 'ok', message: 'fixture vision ready' }),
    })
    await configureVisionTextProvider(current)
    const storyboardId = await bindVideoStoryboard(
      current,
      'database-video-shot',
      'visual-http-scope-drift',
    )
    const originalList = current.runtime.providerService.list.bind(current.runtime.providerService)
    let calls = 0
    current.runtime.providerService.list = async () => {
      const providers = await originalList()
      calls += 1
      if (calls === 2) current.runtime.database.updateMediaAsset(storyboardId, { version: 2 })
      return providers
    }
    const drift = await submit(current, 'visual-http-scope-drift')
    assert.equal(drift.response.status, 409, drift.text)
    assert.equal(drift.body.error.code, 'STALE_SOURCE')
    assert.equal(current.runtime.database.listGenerationJobs({ projectId: 'video-project' }).length, 0)
    assert.equal(current.videoProvider.createInputs.length, 0)
  })
})

test('legacy single-shot route rejects new paid work and only replays an exact historical key', async () => {
  const current = await fixture()
  const endpoint = `${current.baseUrl}/api/v1/shots/shot-1/video-generations`
  const blocked = await json<{ error: { code: string; message: string } }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'video-http-1' },
    body: videoRequest(),
  })
  assert.equal(blocked.response.status, 428, blocked.text)
  assert.equal(blocked.body.error.code, 'VIDEO_BATCH_PREFLIGHT_REQUIRED')
  assert.equal(current.runtime.database.listGenerationJobs({ projectId: 'video-project' }).length, 0)
  assert.equal(current.videoProvider.createInputs.length, 0)

  const configured = await configureSeedance(current)
  assert.equal(configured.configRevision, 2)
  assert.equal(
    current.credentials.values.get(`seedance-video:api-key-r${configured.configRevision}`),
    'seedance-http-secret',
  )

  const missingKey = await json<{ error: { code: string } }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: videoRequest(),
  })
  assert.equal(missingKey.response.status, 400, missingKey.text)
  assert.equal(missingKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED')

  const target = resolvePublicShotVideoTarget(current.runtime.database, {
    projectId: 'video-project',
    episodeId: 'video-episode',
    sceneId: 'scene-1',
    shotId: 'shot-1',
  })
  const historicalInput = createShotVideoJobInput(target, { resolution: '720p' })
  const historical = current.runtime.database.createGenerationJob({
    projectId: 'video-project',
    episodeId: 'video-episode',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'queued',
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: current.videoProvider.model,
    providerConfigRevision: configured.configRevision,
    idempotencyKey: 'video-http-legacy',
    input: historicalInput as unknown as JsonObject,
  })

  const replayed = await json<{ job: Record<string, unknown> }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'video-http-legacy' },
    body: videoRequest(),
  })
  assert.equal(replayed.response.status, 200, replayed.text)
  assert.equal(replayed.body.job.id, historical.id)
  assert.equal(current.videoProvider.createInputs.length, 0)

  const conflict = await json<{ error: { code: string } }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'video-http-legacy' },
    body: videoRequest(6),
  })
  assert.equal(conflict.response.status, 409, conflict.text)
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT')

  const missingShot = await json<{ error: { code: string } }>(
    `${current.baseUrl}/api/v1/shots/missing-shot/video-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'video-missing-shot' },
      body: videoRequest(),
    },
  )
  assert.equal(missingShot.response.status, 404, missingShot.text)
  assert.equal(missingShot.body.error.code, 'SHOT_NOT_FOUND')
})

test('paid Seedance preflight requires a successful non-billable model probe in production', async () => {
  let probeResult: Awaited<ReturnType<ProviderProbe>> = {
    status: 'unavailable',
    message: '连接成功，但当前 Key 不可用指定 Seedance 模型',
  }
  const current = await fixture({
    autoStartWorker: false,
    enforceProviderHealth: true,
    providerProbe: async () => probeResult,
  })
  await configureSeedance(current)
  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-generations/preflight`
  const body = {
    projectId: 'video-project',
    providerId: 'seedance-video',
    resolution: '480p',
    audioPolicy: 'silent',
    generateAudio: false,
    selections: [{
      shotId: 'shot-1',
      sceneId: 'scene-1',
      durationSeconds: 4,
      references: [],
    }],
  }
  const requestPreflight = (idempotencyKey: string) => json<{
    error?: { code: string; message: string }
    preflight?: { billableTaskCount: number }
  }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  })

  const untested = await requestPreflight('provider-health-untested')
  assert.equal(untested.response.status, 409, untested.text)
  assert.equal(untested.body.error?.code, 'PROVIDER_NOT_VERIFIED')
  assert.match(untested.body.error?.message ?? '', /连接测试/)

  const failedTest = await json<{ provider: { health: { status: string } } }>(
    `${current.baseUrl}/api/v1/providers/seedance-video/test`,
    { method: 'POST' },
  )
  assert.equal(failedTest.response.status, 200, failedTest.text)
  assert.equal(failedTest.body.provider.health.status, 'unavailable')
  const unavailable = await requestPreflight('provider-health-unavailable')
  assert.equal(unavailable.response.status, 409, unavailable.text)
  assert.equal(unavailable.body.error?.code, 'PROVIDER_NOT_VERIFIED')
  assert.match(unavailable.body.error?.message ?? '', /不可用指定 Seedance 模型/)

  probeResult = { status: 'ok', message: '连接成功，已确认 Seedance 模型可用' }
  const passedTest = await json<{ provider: { health: { status: string } } }>(
    `${current.baseUrl}/api/v1/providers/seedance-video/test`,
    { method: 'POST' },
  )
  assert.equal(passedTest.response.status, 200, passedTest.text)
  assert.equal(passedTest.body.provider.health.status, 'ok')
  const admitted = await requestPreflight('provider-health-ok')
  assert.equal(admitted.response.status, 200, admitted.text)
  assert.equal(admitted.body.preflight?.billableTaskCount, 1)
  assert.equal(current.runtime.database.listGenerationJobs({ projectId: 'video-project' }).length, 0)
})

test('Seedance batch preflight signs exact references and creates durable children without calling Provider', async () => {
  const current = await fixture({ autoStartWorker: false })
  await configureSeedance(current)
  const referenceAssetId = await addVideoReferenceAsset(current, 'video-reference-first')
  const preflightBody = {
    projectId: 'video-project',
    providerId: 'seedance-video',
    resolution: '720p',
    audioPolicy: 'sfx_only',
    selections: [{
      shotId: 'shot-1',
      sceneId: 'scene-1',
      durationSeconds: 5,
      references: [{ assetId: referenceAssetId, role: 'first_frame' }],
    }],
  }
  const verbosePreflight = await json<{ preflight: {
    publicationMode: string
    targets: Array<{ promptPreview: string; promptCompilerVersion: string }>
  } }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-generations/preflight`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'video-batch-http-verbose-baseline-1',
      },
      body: JSON.stringify({
        ...preflightBody,
        promptCompilerVersion: 'seedance-verbose-baseline-v1',
      }),
    },
  )
  assert.equal(verbosePreflight.response.status, 200, verbosePreflight.text)
  assert.equal(verbosePreflight.body.preflight.publicationMode, 'evaluation_only')
  assert.equal(verbosePreflight.body.preflight.targets[0]?.promptCompilerVersion, 'seedance-verbose-baseline-v1')
  assert.match(verbosePreflight.body.preflight.targets[0]?.promptPreview ?? '', /连续性要求/)
  assert.match(verbosePreflight.body.preflight.targets[0]?.promptPreview ?? '', /5 秒、16:9、720p/)
  assert.equal(current.videoProvider.createInputs.length, 0, 'verbose preflight is also non-billable')

  const preflight = await json<{ preflight: Record<string, unknown> }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-generations/preflight`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'video-batch-http-1',
      },
      body: JSON.stringify(preflightBody),
    },
  )
  assert.equal(preflight.response.status, 200, preflight.text)
  assert.equal(preflight.body.preflight.billableTaskCount, 1)
  assert.equal(preflight.body.preflight.totalRequestedSeconds, 5)
  assert.equal(preflight.body.preflight.priceEstimate, null)
  assert.equal(preflight.body.preflight.priceEstimateReason, 'PROVIDER_PRICING_UNAVAILABLE')
  assert.equal(preflight.body.preflight.audioPolicy, 'sfx_only')
  assert.equal(preflight.body.preflight.publicationMode, 'replace_current')
  assert.equal(preflight.body.preflight.generateAudio, true)
  assert.match(String(preflight.body.preflight.expiresAt), /^\d{4}-\d{2}-\d{2}T/)
  assert.match(String(preflight.body.preflight.confirmationToken), /^svpf1_[1-9][0-9]{9,12}_[a-f0-9]{64}$/)
  const pinnedReference = current.runtime.database.getMediaAsset(referenceAssetId)
  assert.ok(pinnedReference?.checksum)
  assert.deepEqual(preflight.body.preflight.targets, [{
    shotId: 'shot-1',
    sceneId: 'scene-1',
    durationSeconds: 5,
    timelineDurationSeconds: 5,
    durationDecision: {
      version: 1,
      source: 'manual_override',
      frameRate: 24,
      plannedDurationSeconds: 5,
      speechDurationSeconds: null,
      timelineDurationSeconds: 5,
      providerDurationSeconds: 5,
      speechBindings: [],
      notices: [],
    },
    referenceMode: 'first-frame',
    references: [{
      assetId: referenceAssetId,
      role: 'first_frame',
      version: pinnedReference.version,
      checksum: pinnedReference.checksum,
      sourceRevisionId: 'video-revision-1',
    }],
    referenceDecision: {
      version: 1,
      source: 'manual_override',
      resolution: 'manual_override',
      storyboardAnchorAssetId: null,
      selectedReferences: [{ assetId: referenceAssetId, role: 'first_frame' }],
      recommendation: {
        version: 1,
        policy: 'deterministic-character-view-v1',
        status: 'not_applicable',
        shotId: 'shot-1',
        sceneId: 'scene-1',
        sourceRevisionId: 'video-revision-1',
        confidence: null,
        rationale: '镜头未明确关联当前分集的角色，不自动添加角色参考图。',
        characters: [],
        references: [],
      },
    },
    promptPreview: '主体：使用已选择的参考图保持主体与构图一致。\n场景：断崖。\n镜头：中景，缓慢推近。阿离在断崖回头。\n声音：仅生成与画面同步的环境音和动作音，不生成背景音乐，不生成旁白或额外对白。',
    promptCompilerVersion: 'seedance-compact-v1',
    promptCompilerNotices: [],
  }])
  assert.equal(current.videoProvider.createInputs.length, 0, 'preflight is non-billable')

  const audioDrift = await json<{ error: { code: string } }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'video-batch-http-1',
      },
      body: JSON.stringify({
        ...preflightBody,
        audioPolicy: 'silent',
        confirmationToken: preflight.body.preflight.confirmationToken,
      }),
    },
  )
  assert.equal(audioDrift.response.status, 409, audioDrift.text)
  assert.equal(audioDrift.body.error.code, 'VIDEO_BATCH_PREFLIGHT_CHANGED')
  assert.equal(current.runtime.database.listGenerationJobs({ projectId: 'video-project' }).length, 0)

  const promptStrategyDrift = await json<{ error: { code: string } }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'video-batch-http-1',
      },
      body: JSON.stringify({
        ...preflightBody,
        promptCompilerVersion: 'seedance-verbose-baseline-v1',
        confirmationToken: preflight.body.preflight.confirmationToken,
      }),
    },
  )
  assert.equal(promptStrategyDrift.response.status, 409, promptStrategyDrift.text)
  assert.equal(promptStrategyDrift.body.error.code, 'VIDEO_BATCH_PREFLIGHT_CHANGED')
  assert.equal(current.runtime.database.listGenerationJobs({ projectId: 'video-project' }).length, 0)

  const publicationModeDrift = await json<{ error: { code: string } }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'video-batch-http-1',
      },
      body: JSON.stringify({
        ...preflightBody,
        publicationMode: 'evaluation_only',
        confirmationToken: preflight.body.preflight.confirmationToken,
      }),
    },
  )
  assert.equal(publicationModeDrift.response.status, 409, publicationModeDrift.text)
  assert.equal(publicationModeDrift.body.error.code, 'VIDEO_BATCH_PREFLIGHT_CHANGED')
  assert.equal(current.runtime.database.listGenerationJobs({ projectId: 'video-project' }).length, 0)

  const created = await json<{ jobs: Array<Record<string, unknown>> }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'video-batch-http-1',
      },
      body: JSON.stringify({
        ...preflightBody,
        confirmationToken: preflight.body.preflight.confirmationToken,
      }),
    },
  )
  assert.equal(created.response.status, 202, created.text)
  assert.equal(created.body.jobs.length, 1)
  assert.equal(created.body.jobs[0].status, 'queued')
  assert.equal(created.body.jobs[0].resourceId, 'shot-1')
  const jobInput = created.body.jobs[0].input as Record<string, unknown>
  assert.equal(jobInput.generateAudio, true)
  assert.equal((jobInput.spec as Record<string, unknown>).audioPolicy, 'sfx_only')
  assert.equal((jobInput.spec as Record<string, unknown>).promptCompilerVersion, 'seedance-compact-v1')
  assert.deepEqual(jobInput.references, [{
    assetId: referenceAssetId,
    role: 'first_frame',
    version: 1,
    checksum: current.runtime.database.getMediaAsset(referenceAssetId)?.checksum,
    sourceRevisionId: 'video-revision-1',
  }])
  assert.equal((jobInput.referenceDecision as Record<string, unknown>).source, 'manual_override')
  assert.deepEqual(jobInput.batch, {
    version: 1,
    requestFingerprint: (jobInput.batch as Record<string, unknown>).requestFingerprint,
    selectionIndex: 0,
    selectionCount: 1,
  })
  assert.match(String((jobInput.batch as Record<string, unknown>).requestFingerprint), /^[a-f0-9]{64}$/)
  assert.equal(current.videoProvider.createInputs.length, 0, 'durable admission does not fake Provider success')

  // Exact root replay bypasses boot/provider drift and returns the same child.
  await current.runtime.providerService.save('seedance-video', { enabled: false })
  const replay = await json<{ jobs: Array<Record<string, unknown>> }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'video-batch-http-1',
      },
      body: JSON.stringify({
        ...preflightBody,
        confirmationToken: preflight.body.preflight.confirmationToken,
      }),
    },
  )
  assert.equal(replay.response.status, 200, replay.text)
  assert.equal(replay.body.jobs[0].id, created.body.jobs[0].id)
  assert.equal(current.runtime.database.listGenerationJobs({
    projectId: 'video-project',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
  }).length, 1)
})

test('Seedance preflight derives Provider and OpenCut durations from pinned speech Assets', async () => {
  const current = await fixture({ autoStartWorker: false })
  await configureSeedance(current)
  const firstAssetId = addVideoDialogueLine(current.runtime, 0, {
    durationSeconds: 1.01,
    checksumSeed: 'a',
  })
  const secondAssetId = addVideoDialogueLine(current.runtime, 1, {
    durationSeconds: 2.51,
    checksumSeed: 'b',
  })
  assert.ok(firstAssetId)
  assert.ok(secondAssetId)
  const body = {
    projectId: 'video-project',
    providerId: 'seedance-video',
    resolution: '720p',
    audioPolicy: 'sfx_only',
    selections: [{ shotId: 'shot-1', sceneId: 'scene-1', references: [] }],
  }
  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`
  const preflight = await json<{ preflight: {
    confirmationToken: string
    totalRequestedSeconds: number
    targets: Array<{
      durationSeconds: number
      timelineDurationSeconds: number
      durationDecision: Record<string, unknown>
    }>
  } }>(`${endpoint}/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'audio-duration-preflight' },
    body: JSON.stringify(body),
  })
  assert.equal(preflight.response.status, 200, preflight.text)
  assert.equal(preflight.body.preflight.totalRequestedSeconds, 4)
  assert.equal(preflight.body.preflight.targets[0].durationSeconds, 4)
  assert.equal(preflight.body.preflight.targets[0].timelineDurationSeconds, 86 / 24)
  assert.deepEqual(preflight.body.preflight.targets[0].durationDecision, {
    version: 1,
    source: 'speech_assets',
    frameRate: 24,
    plannedDurationSeconds: 5,
    speechDurationSeconds: 86 / 24,
    timelineDurationSeconds: 86 / 24,
    providerDurationSeconds: 4,
    speechBindings: [
      {
        dialogueLineId: 'line-0',
        assetId: firstAssetId,
        version: 1,
        checksum: 'a'.repeat(64),
        durationSeconds: 1.01,
        durationFrames: 25,
      },
      {
        dialogueLineId: 'line-1',
        assetId: secondAssetId,
        version: 1,
        checksum: 'b'.repeat(64),
        durationSeconds: 2.51,
        durationFrames: 61,
      },
    ],
    notices: ['AUDIO_DRIVEN_TIMELINE', 'PROVIDER_MINIMUM_SOURCE_WILL_BE_TRIMMED'],
  })
  const created = await json<{ jobs: Array<{
    input: { durationSeconds: number; durationDecision: Record<string, unknown> }
  }> }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'audio-duration-preflight' },
    body: JSON.stringify({
      ...body,
      confirmationToken: preflight.body.preflight.confirmationToken,
    }),
  })
  assert.equal(created.response.status, 202, created.text)
  assert.equal(created.body.jobs[0].input.durationSeconds, 4)
  assert.deepEqual(
    created.body.jobs[0].input.durationDecision,
    preflight.body.preflight.targets[0].durationDecision,
  )
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('Seedance preflight enforces audio-first and rejects unsafe long or short timing', async () => {
  const missing = await fixture({ autoStartWorker: false })
  await configureSeedance(missing)
  addVideoDialogueLine(missing.runtime, 0)
  const endpoint = `${missing.baseUrl}/api/v1/episodes/video-episode/video-generations/preflight`
  const baseBody = {
    projectId: 'video-project',
    providerId: 'seedance-video',
    resolution: '720p',
    generateAudio: false,
    selections: [{ shotId: 'shot-1', sceneId: 'scene-1', references: [] }],
  }
  const blocked = await json<{ error: { code: string; details: Record<string, unknown> } }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'audio-required' },
    body: JSON.stringify(baseBody),
  })
  assert.equal(blocked.response.status, 409, blocked.text)
  assert.equal(blocked.body.error.code, 'VIDEO_AUDIO_PREREQUISITE_REQUIRED')
  assert.deepEqual(blocked.body.error.details.blockedLines, [
    { dialogueLineId: 'line-0', reason: 'SPEECH_ASSET_MISSING' },
  ])
  assert.equal(missing.videoProvider.createInputs.length, 0)

  const long = await fixture({ autoStartWorker: false })
  await configureSeedance(long)
  addVideoDialogueLine(long.runtime, 0, { durationSeconds: 15.1 })
  const longResult = await json<{ error: { code: string } }>(
    `${long.baseUrl}/api/v1/episodes/video-episode/video-generations/preflight`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'audio-requires-split' },
      body: JSON.stringify(baseBody),
    },
  )
  assert.equal(longResult.response.status, 409, longResult.text)
  assert.equal(longResult.body.error.code, 'VIDEO_AUDIO_DURATION_REQUIRES_SHOT_SPLIT')
  assert.equal(long.videoProvider.createInputs.length, 0)

  const tooShort = await fixture({ autoStartWorker: false })
  await configureSeedance(tooShort)
  addVideoDialogueLine(tooShort.runtime, 0, { durationSeconds: 4.6 })
  const tooShortResult = await json<{ error: { code: string } }>(
    `${tooShort.baseUrl}/api/v1/episodes/video-episode/video-generations/preflight`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'manual-too-short' },
      body: JSON.stringify({
        ...baseBody,
        selections: [{ ...baseBody.selections[0], durationSeconds: 4 }],
      }),
    },
  )
  assert.equal(tooShortResult.response.status, 409, tooShortResult.text)
  assert.equal(tooShortResult.body.error.code, 'VIDEO_DURATION_SHORTER_THAN_AUDIO')
  assert.equal(tooShort.videoProvider.createInputs.length, 0)
})

test('server recommendation API and omitted batch references consume the current locked character view', async () => {
  const current = await fixture({ autoStartWorker: false })
  await configureSeedance(current)
  const views = await addLockedCharacterViews(current)
  const currentStoryboard = await addVideoReferenceAsset(current, 'video-current-storyboard')
  current.runtime.database.withSql((sql) => sql.run(`
    UPDATE shots
    SET description = '阿离侧身回望', prompt = '阿离侧脸站在断崖', storyboard_asset_id = ?
    WHERE id = 'database-video-shot'
  `, currentStoryboard))

  const recommendation = await json<{ recommendation: {
    status: string
    confidence: number
    references: Array<{ assetId: string; role: string }>
    characters: Array<{ view: string; assetVersion: number; assetSourceRevisionId: string }>
  } }>(`${current.baseUrl}/api/v1/shots/shot-1/video-reference-recommendation?projectId=video-project&episodeId=video-episode&sceneId=scene-1`)
  assert.equal(recommendation.response.status, 200, recommendation.text)
  assert.equal(recommendation.body.recommendation.status, 'recommended')
  assert.equal(recommendation.body.recommendation.confidence, 0.96)
  assert.deepEqual(recommendation.body.recommendation.references, [{
    assetId: views.side,
    role: 'reference_image',
  }])
  assert.equal(recommendation.body.recommendation.characters[0].view, 'side')
  assert.equal(recommendation.body.recommendation.characters[0].assetSourceRevisionId, 'video-revision-1')

  const preflight = await json<{ preflight: {
    targets: Array<{
      references: Array<Record<string, unknown>>
      referenceDecision: { source: string }
    }>
  } }>(`${current.baseUrl}/api/v1/episodes/video-episode/video-generations/preflight`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'auto-character-view-preflight',
    },
    body: JSON.stringify({
      projectId: 'video-project',
      providerId: 'seedance-video',
      resolution: '720p',
      audioPolicy: 'silent',
      selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
    }),
  })
  assert.equal(preflight.response.status, 200, preflight.text)
  assert.equal(preflight.body.preflight.targets[0].referenceDecision.source, 'agentic_auto')
  assert.deepEqual(preflight.body.preflight.targets[0].references, [{
    assetId: currentStoryboard,
    role: 'reference_image',
    version: 1,
    checksum: current.runtime.database.getMediaAsset(currentStoryboard)?.checksum,
    sourceRevisionId: 'video-revision-1',
  }, {
    assetId: views.side,
    role: 'reference_image',
    version: 1,
    checksum: current.runtime.database.getMediaAsset(views.side)?.checksum,
    sourceRevisionId: 'video-revision-1',
  }])
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('a fresh batch fails closed around an unresolved paid submission outcome, including the post-preflight race', async () => {
  const current = await fixture({ autoStartWorker: false })
  const configured = await configureSeedance(current)
  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`
  const body = {
    projectId: 'video-project',
    providerId: 'seedance-video',
    resolution: '720p',
    generateAudio: false,
    selections: [{
      shotId: 'shot-1',
      sceneId: 'scene-1',
      durationSeconds: 5,
      references: [],
    }],
  }
  const preflight = await json<{ preflight: { confirmationToken: string } }>(`${endpoint}/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'unknown-race-root' },
    body: JSON.stringify(body),
  })
  assert.equal(preflight.response.status, 200, preflight.text)

  const target = resolvePublicShotVideoTarget(current.runtime.database, {
    projectId: 'video-project',
    episodeId: 'video-episode',
    sceneId: 'scene-1',
    shotId: 'shot-1',
  })
  current.runtime.database.createGenerationJob({
    id: 'unknown-paid-submission',
    projectId: 'video-project',
    episodeId: 'video-episode',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'failed',
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: current.videoProvider.model,
    providerConfigRevision: configured.configRevision,
    idempotencyKey: 'unknown-paid-submission',
    input: createShotVideoJobInput(target, { resolution: '720p' }) as unknown as JsonObject,
    providerState: {
      operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
      phase: 'submitting',
      providerSupportsIdempotency: false,
    },
    error: {
      code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
      message: '提交结果未确认',
      retryable: false,
      category: 'provider',
    },
  })

  const racedCreate = await json<{ error: { code: string; message: string } }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'unknown-race-root' },
    body: JSON.stringify({ ...body, confirmationToken: preflight.body.preflight.confirmationToken }),
  })
  assert.equal(racedCreate.response.status, 409, racedCreate.text)
  assert.equal(racedCreate.body.error.code, 'VIDEO_SUBMISSION_OUTCOME_UNKNOWN')
  assert.match(racedCreate.body.error.message, /人工核对/)

  const blockedPreflight = await json<{ error: { code: string } }>(`${endpoint}/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'unknown-new-root' },
    body: JSON.stringify(body),
  })
  assert.equal(blockedPreflight.response.status, 409, blockedPreflight.text)
  assert.equal(blockedPreflight.body.error.code, 'VIDEO_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(current.runtime.database.listGenerationJobs({
    projectId: 'video-project',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
  }).length, 1)
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('manual confirmed-not-created resolution is strict, audited, idempotent, and unlocks preflight without Provider calls', async () => {
  const current = await fixture({ autoStartWorker: false })
  const configured = await configureSeedance(current)
  const target = resolvePublicShotVideoTarget(current.runtime.database, {
    projectId: 'video-project',
    episodeId: 'video-episode',
    sceneId: 'scene-1',
    shotId: 'shot-1',
  })
  const job = current.runtime.database.createGenerationJob({
    id: 'manual-resolution-http-job',
    projectId: 'video-project',
    episodeId: 'video-episode',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'failed',
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: current.videoProvider.model,
    providerConfigRevision: configured.configRevision,
    input: createShotVideoJobInput(target, { resolution: '720p' }) as unknown as JsonObject,
    providerState: {
      operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
      phase: 'submitting',
      providerSupportsIdempotency: false,
    },
    error: {
      code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
      message: '提交结果未确认',
      retryable: false,
      category: 'provider',
    },
  })
  const endpoint = `${current.baseUrl}/api/v1/jobs/${job.id}/shot-video-unknown-submission-resolution`
  const note = '已核对该任务绑定的历史供应商控制台，确认没有可接管的视频任务。'

  const unconfirmed = await json<{ error: { code: string } }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'video-project',
      resolution: 'confirmed-not-created',
      confirmedProviderConsoleChecked: false,
      note,
    }),
  })
  assert.equal(unconfirmed.response.status, 400, unconfirmed.text)
  assert.equal(unconfirmed.body.error.code, 'INVALID_VIDEO_MANUAL_RESOLUTION')

  const crossProject = await json<{ error: { code: string } }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'other-project',
      resolution: 'confirmed-not-created',
      confirmedProviderConsoleChecked: true,
      note,
    }),
  })
  assert.equal(crossProject.response.status, 404, crossProject.text)
  assert.equal(crossProject.body.error.code, 'JOB_NOT_FOUND')

  const requestBody = {
    projectId: 'video-project',
    resolution: 'confirmed-not-created',
    confirmedProviderConsoleChecked: true,
    note,
  }
  const first = await json<{
    resolution: { auditRevisionId: string; resolution: string }
    idempotent: boolean
    job: {
      id: string
      status: string
      retryDisposition: string
      error: { code: string; auditRevisionId: string }
      unknownSubmissionResolution?: { auditRevisionId: string }
    }
  }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(first.response.status, 201, first.text)
  assert.equal(first.body.idempotent, false)
  assert.equal(first.body.resolution.resolution, 'confirmed-not-created')
  assert.equal(first.body.job.id, job.id)
  assert.equal(first.body.job.status, 'failed')
  assert.equal(first.body.job.retryDisposition, 'paid-reconfirmation-required')
  assert.equal(first.body.job.error.code, 'PROVIDER_SUBMISSION_CONFIRMED_NOT_CREATED')
  assert.equal(first.body.job.error.auditRevisionId, first.body.resolution.auditRevisionId)
  assert.equal(
    first.body.job.unknownSubmissionResolution?.auditRevisionId,
    first.body.resolution.auditRevisionId,
  )
  assert.equal(current.videoProvider.createInputs.length, 0)

  const genericRetry = await json<{ error: { code: string } }>(
    `${current.baseUrl}/api/v1/jobs/${job.id}/retry`,
    { method: 'POST' },
  )
  assert.equal(genericRetry.response.status, 409, genericRetry.text)
  assert.equal(genericRetry.body.error.code, 'JOB_PAID_RECONFIRMATION_REQUIRED')
  assert.equal(current.videoProvider.createInputs.length, 0)

  const repeated = await json<{
    resolution: { auditRevisionId: string }
    idempotent: boolean
    job: { id: string }
  }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(repeated.response.status, 200, repeated.text)
  assert.equal(repeated.body.idempotent, true)
  assert.equal(repeated.body.resolution.auditRevisionId, first.body.resolution.auditRevisionId)
  assert.equal(repeated.body.job.id, job.id)

  const preflight = await json<{ preflight?: { billableTaskCount: number }; error?: { code: string } }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-generations/preflight`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'manual-resolution-unlocked-preflight',
      },
      body: JSON.stringify({
        projectId: 'video-project',
        providerId: 'seedance-video',
        resolution: '720p',
        generateAudio: false,
        selections: [{
          shotId: 'shot-1',
          sceneId: 'scene-1',
          durationSeconds: 5,
          references: [],
        }],
      }),
    },
  )
  assert.equal(preflight.response.status, 200, preflight.text)
  assert.equal(preflight.body.preflight?.billableTaskCount, 1)
  assert.equal(current.videoProvider.createInputs.length, 0, 'resolution and preflight must not call Seedance')

  const durable = current.runtime.database.getGenerationJob(job.id)!
  current.runtime.database.updateGenerationJob(job.id, {
    progressDetail: {
      ...durable.progressDetail,
      manualUnknownSubmissionResolution: {
        version: 1,
        auditRevisionId: 'video-revision-1',
        resolution: 'confirmed-not-created',
        resolvedAt: first.body.resolution.auditRevisionId,
      },
    },
  })
  const corruptedProjection = await json<{
    job: {
      error: { code: string }
      progressDetail: Record<string, unknown>
      unknownSubmissionResolution?: unknown
    }
  }>(`${current.baseUrl}/api/v1/jobs/${job.id}`)
  assert.equal(corruptedProjection.response.status, 200, corruptedProjection.text)
  assert.equal(corruptedProjection.body.job.error.code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(corruptedProjection.body.job.unknownSubmissionResolution, undefined)
  assert.equal(
    corruptedProjection.body.job.progressDetail.manualUnknownSubmissionResolution,
    undefined,
  )
})

test('a queued shot revision blocks a fresh batch root but exact root/child replay remains idempotent', async () => {
  const current = await fixture({ autoStartWorker: false })
  await configureSeedance(current)
  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`
  const body = {
    projectId: 'video-project',
    providerId: 'seedance-video',
    resolution: '720p',
    generateAudio: false,
    selections: [{
      shotId: 'shot-1',
      sceneId: 'scene-1',
      durationSeconds: 5,
      references: [],
    }],
  }
  const preflight = await json<{ preflight: { confirmationToken: string } }>(`${endpoint}/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'active-root' },
    body: JSON.stringify(body),
  })
  assert.equal(preflight.response.status, 200, preflight.text)
  const created = await json<{ jobs: Array<{ id: string }> }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'active-root' },
    body: JSON.stringify({ ...body, confirmationToken: preflight.body.preflight.confirmationToken }),
  })
  assert.equal(created.response.status, 202, created.text)

  const blocked = await json<{ error: { code: string } }>(`${endpoint}/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'active-other-root' },
    body: JSON.stringify(body),
  })
  assert.equal(blocked.response.status, 409, blocked.text)
  assert.equal(blocked.body.error.code, 'VIDEO_GENERATION_ALREADY_ACTIVE')

  const replayed = await json<{ jobs: Array<{ id: string }> }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'active-root' },
    body: JSON.stringify({ ...body, confirmationToken: preflight.body.preflight.confirmationToken }),
  })
  assert.equal(replayed.response.status, 200, replayed.text)
  assert.equal(replayed.body.jobs[0].id, created.body.jobs[0].id)
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('Seedance batch rejects mixed reference modes and stale paid confirmations before job creation', async () => {
  const current = await fixture({ autoStartWorker: false })
  await configureSeedance(current)
  const first = await addVideoReferenceAsset(current, 'video-reference-a')
  const second = await addVideoReferenceAsset(current, 'video-reference-b')
  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-generations/preflight`
  const mixed = await json<{ error: { code: string } }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'video-batch-mixed' },
    body: JSON.stringify({
      projectId: 'video-project',
      selections: [{
        shotId: 'shot-1',
        sceneId: 'scene-1',
        references: [
          { assetId: first, role: 'first_frame' },
          { assetId: second, role: 'reference_image' },
        ],
      }],
    }),
  })
  assert.equal(mixed.response.status, 400, mixed.text)
  assert.equal(mixed.body.error.code, 'INVALID_VIDEO_REFERENCE_INPUT')

  const body = {
    projectId: 'video-project',
    selections: [{ shotId: 'shot-1', sceneId: 'scene-1', references: [] }],
  }
  const preflight = await json<{ preflight: { confirmationToken: string } }>(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'video-batch-stale-confirmation',
    },
    body: JSON.stringify(body),
  })
  assert.equal(preflight.response.status, 200, preflight.text)
  await current.runtime.providerService.save('seedance-video', {
    apiKey: 'rotated-seedance-http-secret',
    enabled: true,
  })
  const stale = await json<{ error: { code: string } }>(
    `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'video-batch-stale-confirmation',
      },
      body: JSON.stringify({ ...body, confirmationToken: preflight.body.preflight.confirmationToken }),
    },
  )
  assert.equal(stale.response.status, 409, stale.text)
  assert.equal(stale.body.error.code, 'VIDEO_BATCH_PREFLIGHT_CHANGED')
  assert.equal(current.runtime.database.listGenerationJobs({ projectId: 'video-project' }).length, 0)
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('Seedance preflight capability is short-lived and bound to its root Idempotency-Key', async () => {
  let nowMs = Date.parse('2026-07-14T00:00:00.000Z')
  const current = await fixture({
    autoStartWorker: false,
    shotVideoPreflightNow: () => new Date(nowMs),
  })
  await configureSeedance(current)
  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`
  const body = {
    projectId: 'video-project',
    providerId: 'seedance-video',
    resolution: '720p',
    generateAudio: false,
    selections: [{
      shotId: 'shot-1',
      sceneId: 'scene-1',
      durationSeconds: 5,
      references: [],
    }],
  }
  const missingRootKey = await json<{ error: { code: string } }>(`${endpoint}/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(missingRootKey.response.status, 400, missingRootKey.text)
  assert.equal(missingRootKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED')

  const preflight = await json<{
    preflight: { confirmationToken: string; expiresAt: string }
  }>(`${endpoint}/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'root-key-a' },
    body: JSON.stringify(body),
  })
  assert.equal(preflight.response.status, 200, preflight.text)
  assert.equal(preflight.body.preflight.expiresAt, '2026-07-14T00:05:00.000Z')

  const crossKeyReplay = await json<{ error: { code: string } }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'root-key-b' },
    body: JSON.stringify({ ...body, confirmationToken: preflight.body.preflight.confirmationToken }),
  })
  assert.equal(crossKeyReplay.response.status, 409, crossKeyReplay.text)
  assert.equal(crossKeyReplay.body.error.code, 'VIDEO_BATCH_PREFLIGHT_CHANGED')
  assert.equal(current.runtime.database.listGenerationJobs({ projectId: 'video-project' }).length, 0)

  nowMs += 5 * 60 * 1_000
  const expired = await json<{ error: { code: string } }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'root-key-a' },
    body: JSON.stringify({ ...body, confirmationToken: preflight.body.preflight.confirmationToken }),
  })
  assert.equal(expired.response.status, 409, expired.text)
  assert.equal(expired.body.error.code, 'VIDEO_BATCH_PREFLIGHT_EXPIRED')
  assert.equal(current.runtime.database.listGenerationJobs({ projectId: 'video-project' }).length, 0)
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('Seedance batch admission rolls back every child when any SQLite insert fails', async () => {
  const current = await fixture({ autoStartWorker: false })
  addSecondVideoShot(current.runtime)
  await configureSeedance(current)
  const rootKey = 'video-batch-atomic-rollback'
  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`
  const body = {
    projectId: 'video-project',
    providerId: 'seedance-video',
    resolution: '720p',
    generateAudio: false,
    selections: [
      { shotId: 'shot-1', sceneId: 'scene-1', durationSeconds: 5, references: [] },
      { shotId: 'shot-2', sceneId: 'scene-1', durationSeconds: 5, references: [] },
    ],
  }
  const preflight = await json<{ preflight: { confirmationToken: string } }>(`${endpoint}/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': rootKey },
    body: JSON.stringify(body),
  })
  assert.equal(preflight.response.status, 200, preflight.text)

  const database = current.runtime.database
  const originalCreate = database.createGenerationJob.bind(database)
  let inserts = 0
  database.createGenerationJob = ((input) => {
    inserts += 1
    if (inserts === 2) throw new Error('injected second child insert failure')
    return originalCreate(input)
  }) as typeof database.createGenerationJob
  try {
    const failed = await json<{ error: { code: string } }>(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': rootKey },
      body: JSON.stringify({ ...body, confirmationToken: preflight.body.preflight.confirmationToken }),
    })
    assert.equal(failed.response.status, 500, failed.text)
  } finally {
    database.createGenerationJob = originalCreate
  }
  assert.equal(inserts, 2)
  assert.equal(database.listGenerationJobs({ projectId: 'video-project' }).length, 0)
  assert.equal(current.runtime.worker.getStats().pending, 0)
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('a legacy partial batch replay returns each child once and atomically fills only the missing row', async () => {
  const current = await fixture({ autoStartWorker: false })
  addSecondVideoShot(current.runtime)
  const configured = await configureSeedance(current)
  const rootKey = 'video-batch-partial-recovery'
  const endpoint = `${current.baseUrl}/api/v1/episodes/video-episode/video-generations`
  const body = {
    projectId: 'video-project',
    providerId: 'seedance-video',
    resolution: '720p' as const,
    generateAudio: false,
    selections: [
      { shotId: 'shot-1', sceneId: 'scene-1', durationSeconds: 5, references: [] },
      { shotId: 'shot-2', sceneId: 'scene-1', durationSeconds: 5, references: [] },
    ],
  }
  const preflight = await json<{ preflight: { confirmationToken: string } }>(`${endpoint}/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': rootKey },
    body: JSON.stringify(body),
  })
  assert.equal(preflight.response.status, 200, preflight.text)

  const prepared = prepareShotVideoBatch(
    current.runtime.database,
    { ...body, episodeId: 'video-episode' } satisfies ShotVideoBatchRequest,
    {
      providerId: 'seedance-video',
      configRevision: configured.configRevision,
      model: current.videoProvider.model,
    },
  )
  const first = current.runtime.database.createGenerationJob({
    projectId: 'video-project',
    episodeId: 'video-episode',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'queued',
    progress: 0,
    resourceType: 'provider:video',
    resourceId: prepared.targets[0].shotId,
    providerId: 'seedance-video',
    model: current.videoProvider.model,
    providerConfigRevision: configured.configRevision,
    idempotencyKey: shotVideoBatchChildIdempotencyKey('video-project', rootKey, 0),
    input: prepared.targets[0].input as unknown as JsonObject,
  })

  const recovered = await json<{ jobs: Array<{ id: string; resourceId: string }> }>(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': rootKey },
    body: JSON.stringify({ ...body, confirmationToken: preflight.body.preflight.confirmationToken }),
  })
  assert.equal(recovered.response.status, 202, recovered.text)
  assert.equal(recovered.body.jobs.length, 2)
  assert.equal(new Set(recovered.body.jobs.map((job) => job.id)).size, 2)
  assert.equal(recovered.body.jobs[0].id, first.id)
  assert.deepEqual(recovered.body.jobs.map((job) => job.resourceId), ['shot-1', 'shot-2'])
  assert.equal(current.runtime.database.listGenerationJobs({
    projectId: 'video-project',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
  }).length, 2)
  assert.equal(current.videoProvider.createInputs.length, 0)
})

test('generic v1 cancellation aborts polling and reuses the persisted external task id', async () => {
  const current = await fixture({ mode: 'wait' })
  await configureSeedance(current)
  const created = await createConfirmedVideoJob(current, 'video-cancel-1')
  await current.videoProvider.waitForGet()

  const cancelled = await json<{ job: Record<string, unknown> }>(
    `${current.baseUrl}/api/v1/jobs/${created.id}/cancel`,
    { method: 'POST' },
  )
  assert.equal(cancelled.response.status, 200, cancelled.text)
  assert.equal(cancelled.body.job.status, 'cancelled')
  await current.runtime.worker.waitForIdle()
  const terminal = await terminalJob(current.baseUrl, created.id)
  assert.equal(terminal.status, 'cancelled')
  assert.deepEqual(terminal.cancellation, {
    localProcessing: 'stopped',
    upstreamCancellation: 'request-sent',
    providerTaskMayContinue: true,
    chargesMayStillApply: true,
    message: '已停止本地处理，并已向火山方舟发送取消请求；上游确认前仍可能产生费用。',
  })
  assert.equal(current.videoProvider.createInputs.length, 1)
  assert.deepEqual(current.videoProvider.cancelledTaskIds, ['fixture-video-task-1'])
  assert.equal(current.runtime.database.listMediaAssets({ projectId: 'video-project' }).length, 0)

  assert.equal(terminal.retryDisposition, 'resume-existing-provider-task')
  current.videoProvider.mode = 'success'
  const resumed = await json<{ job: Record<string, unknown> }>(
    `${current.baseUrl}/api/v1/jobs/${created.id}/retry`,
    { method: 'POST', headers: { 'idempotency-key': 'video-cancel-ark-resume' } },
  )
  assert.equal(resumed.response.status, 202, resumed.text)
  const replay = await json<{ job: Record<string, unknown> }>(
    `${current.baseUrl}/api/v1/jobs/${created.id}/retry`,
    { method: 'POST', headers: { 'idempotency-key': 'video-cancel-ark-resume-replay' } },
  )
  assert.equal(replay.response.status, 200, replay.text)
  assert.equal(replay.body.job.id, resumed.body.job.id)
  const completed = await terminalJob(current.baseUrl, String(resumed.body.job.id))
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.externalTaskId, 'fixture-video-task-1')
  assert.equal(current.videoProvider.createInputs.length, 1, 'resume must never create a second task')
})

test('NewAPI cancellation stops local polling without claiming or attempting upstream DELETE', async () => {
  const current = await fixture({ mode: 'wait' })
  current.videoProvider.cancellationCapability = 'local-only'
  await configureSeedance(current)
  const created = await createConfirmedVideoJob(current, 'video-cancel-newapi-1')
  await current.videoProvider.waitForGet()

  const cancelled = await json<{ job: Record<string, unknown> }>(
    `${current.baseUrl}/api/v1/jobs/${created.id}/cancel`,
    { method: 'POST' },
  )
  assert.equal(cancelled.response.status, 200, cancelled.text)
  assert.equal(cancelled.body.job.status, 'cancelled')
  assert.match(String((cancelled.body.job.cancellation as Record<string, unknown>).message), /可能继续并产生费用/)
  await current.runtime.worker.waitForIdle()

  const terminal = await terminalJob(current.baseUrl, created.id)
  assert.deepEqual(terminal.cancellation, {
    localProcessing: 'stopped',
    upstreamCancellation: 'not-supported',
    providerTaskMayContinue: true,
    chargesMayStillApply: true,
    message: '已停止本地处理；当前 NewAPI 网关不支持取消上游任务，生成可能继续并产生费用。',
  })
  assert.deepEqual(current.videoProvider.cancelledTaskIds, [])
  assert.equal(
    current.runtime.database.getGenerationJob(created.id)?.providerState.cancellationOutcome,
    'unsupported',
  )
  assert.equal(current.runtime.database.listMediaAssets({ projectId: 'video-project' }).length, 0)

  assert.equal(terminal.retryDisposition, 'resume-existing-provider-task')
  current.videoProvider.mode = 'success'
  const resumed = await json<{ job: Record<string, unknown> }>(
    `${current.baseUrl}/api/v1/jobs/${created.id}/retry`,
    { method: 'POST', headers: { 'idempotency-key': 'video-cancel-newapi-resume' } },
  )
  assert.equal(resumed.response.status, 202, resumed.text)
  const completed = await terminalJob(current.baseUrl, String(resumed.body.job.id))
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.externalTaskId, 'fixture-video-task-1')
  assert.equal(current.videoProvider.createInputs.length, 1, 'resume must only poll the accepted task')
})

test('failed Ark cancellation remains resumable and never creates another Seedance task', async () => {
  const current = await fixture({ mode: 'wait' })
  current.videoProvider.cancelError = new Error('fixture Ark cancellation unavailable')
  await configureSeedance(current)
  const created = await createConfirmedVideoJob(current, 'video-cancel-request-failed')
  await current.videoProvider.waitForGet()

  const cancelled = await json<{ job: Record<string, unknown> }>(
    `${current.baseUrl}/api/v1/jobs/${created.id}/cancel`,
    { method: 'POST' },
  )
  assert.equal(cancelled.response.status, 200, cancelled.text)
  await current.runtime.worker.waitForIdle()
  const terminal = await terminalJob(current.baseUrl, created.id)
  assert.equal(terminal.status, 'cancelled')
  assert.equal(terminal.retryDisposition, 'resume-existing-provider-task')
  assert.deepEqual(terminal.cancellation, {
    localProcessing: 'stopped',
    upstreamCancellation: 'request-failed',
    providerTaskMayContinue: true,
    chargesMayStillApply: true,
    message: '已停止本地处理，但未能向火山方舟发送取消请求；上游可能继续并产生费用。',
  })

  current.videoProvider.cancelError = null
  current.videoProvider.mode = 'success'
  const resumed = await json<{ job: Record<string, unknown> }>(
    `${current.baseUrl}/api/v1/jobs/${created.id}/retry`,
    { method: 'POST', headers: { 'idempotency-key': 'video-cancel-request-failed-resume' } },
  )
  assert.equal(resumed.response.status, 202, resumed.text)
  const completed = await terminalJob(current.baseUrl, String(resumed.body.job.id))
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.externalTaskId, 'fixture-video-task-1')
  assert.equal(current.videoProvider.createInputs.length, 1, 'resume must never call createTask again')
})

test('a mid-poll Story edit aborts Seedance, cancels the accepted task, and publishes no asset', async () => {
  await assertStoryMutationStopsActiveVideo('edit')
})

test('a mid-poll Story restore aborts Seedance, cancels the accepted task, and publishes no asset', async () => {
  await assertStoryMutationStopsActiveVideo('restore')
})

test('generic v1 retry resumes the accepted Seedance task without a second paid submission', async () => {
  const current = await fixture({
    mode: 'fail-once',
    failuresRemaining: 1,
    maxConsecutivePollErrors: 0,
  })
  const configured = await configureSeedance(current)
  const created = await createConfirmedVideoJob(current, 'video-retry-source')
  const failed = await terminalJob(current.baseUrl, created.id)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.error, {
    code: 'UPSTREAM_UNAVAILABLE',
    message: 'Seedance 测试上游暂时不可用',
    retryable: true,
    category: 'provider',
  })
  assert.equal(failed.externalTaskId, 'fixture-video-task-1')
  assert.equal(current.videoProvider.createInputs.length, 1)

  const retried = await json<{ job: Record<string, unknown> }>(
    `${current.baseUrl}/api/v1/jobs/${created.id}/retry`,
    {
      method: 'POST',
      headers: { 'idempotency-key': 'video-retry-child' },
    },
  )
  assert.equal(retried.response.status, 202, retried.text)
  assert.equal(retried.body.job.retryOf, created.id)
  assert.equal(retried.body.job.providerConfigRevision, configured.configRevision)
  const terminal = await terminalJob(current.baseUrl, String(retried.body.job.id))
  assert.equal(terminal.status, 'succeeded')
  assert.equal(terminal.externalTaskId, 'fixture-video-task-1')
  assert.equal(current.videoProvider.createInputs.length, 1, 'retry must not submit a second paid task')
  assert.deepEqual(current.videoProvider.getTaskIds, [
    'fixture-video-task-1',
    'fixture-video-task-1',
  ])
  assert.equal(current.runtime.database.listMediaAssets({
    projectId: 'video-project',
    kind: 'shot.video',
  }).length, 1)
})

test('application restart recovers a v1 waiting-provider job without another Seedance submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-shot-video-recovery-http-test-'))
  const credentials = new MemoryCredentialStore()
  const imageProvider = new NoopImageProvider()
  const firstProvider = new FixtureSeedanceProvider()
  const first = await createApplication({
    runtimeDirectory: directory,
    provider: imageProvider,
    keychain: credentials,
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    seedanceProvider: firstProvider,
    seedanceDownloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
    seedanceVideoProbe,
    seedancePollIntervalMs: 0,
    autoStartWorker: false,
  })
  insertStoryGraph(first)
  const providerState = await first.providerService.save('seedance-video', {
    apiKey: 'seedance-recovery-secret',
    enabled: true,
  })
  const input = createShotVideoJobInput(resolvePublicShotVideoTarget(first.database, {
    projectId: 'video-project',
    episodeId: 'video-episode',
    sceneId: 'scene-1',
    shotId: 'shot-1',
  }), { resolution: '720p' })
  first.database.createGenerationJob({
    id: 'video-recovery-job',
    projectId: 'video-project',
    episodeId: 'video-episode',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'waiting_provider',
    progress: 35,
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: firstProvider.model,
    providerConfigRevision: providerState.configRevision,
    externalTaskId: 'fixture-video-task-recovered',
    idempotencyKey: 'video-recovery-idempotency',
    input: input as unknown as JsonObject,
    providerState: {
      operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
      phase: 'polling',
      externalTaskId: 'fixture-video-task-recovered',
      pollCount: 4,
    },
  })
  await first.close()

  const recoveredProvider = new FixtureSeedanceProvider()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider: imageProvider,
    keychain: credentials,
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    seedanceProvider: recoveredProvider,
    seedanceDownloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
    seedanceVideoProbe,
    seedancePollIntervalMs: 0,
  })
  const server = createServer(runtime.app)
  const current = {
    directory,
    runtime,
    server,
    baseUrl: await listen(server),
    credentials,
    videoProvider: recoveredProvider,
  }
  fixtures.push(current)

  const terminal = await terminalJob(current.baseUrl, 'video-recovery-job')
  assert.equal(terminal.status, 'succeeded')
  assert.equal(terminal.externalTaskId, 'fixture-video-task-recovered')
  assert.equal(recoveredProvider.createInputs.length, 0)
  assert.deepEqual(recoveredProvider.getTaskIds, ['fixture-video-task-recovered'])
  assert.equal(runtime.database.listMediaAssets({
    projectId: 'video-project',
    kind: 'shot.video',
  }).length, 1)
})
