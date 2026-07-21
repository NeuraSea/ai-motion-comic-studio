import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import { MediaStore, type SaveMediaInput, type SaveMediaOptions } from './media.js'
import { jobHasUnknownSubmission, jobRetryDisposition } from './job-retry-policy.js'
import {
  SeedanceVideoProvider,
  type SeedanceCancellationResult,
  type SeedanceTask,
  type SeedanceVideoProviderContract,
} from './providers/seedance.js'
import { SQLiteJobRepository, SQLiteRepositoryError } from './repositories.js'
import {
  createShotVideoGenerationHandler,
  createShotVideoJobInput,
  createShotVideoReferenceBindings,
  resolvePublicShotVideoTarget,
  SHOT_VIDEO_GENERATION_JOB_TYPE,
  type DownloadedVideo,
} from './shot-video-generation.js'
import { resolveShotVideoDuration } from './shot-video-duration.js'
import { readShotVideoTimingRemediation } from './shot-video-timing-remediation.js'
import type { JsonObject } from './types.js'
import type { VideoMetadataProbe, VideoMetadataProbeResult } from './video-metadata.js'
import { JobWorker } from './worker.js'

const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
  0x69, 0x73, 0x6f, 0x32,
])

interface TestRuntime {
  directory: string
  database: ManjuDatabase
  mediaStore: MediaStore
}

const runtimes: TestRuntime[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
  for (const runtime of runtimes.splice(0)) {
    runtime.database.close()
    await rm(runtime.directory, { recursive: true, force: true })
  }
})

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function listen(
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
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind')
  return `http://127.0.0.1:${address.port}/api/v3`
}

function insertStoryGraph(database: ManjuDatabase): void {
  const now = '2026-07-14T00:00:00.000Z'
  database.createProject({ id: 'project-1', title: '漫剧项目', createdAt: now, updatedAt: now })
  database.createRevision({
    id: 'revision-1',
    projectId: 'project-1',
    summary: '初始剧本',
    snapshot: { version: 1 },
    createdAt: now,
  })
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
        style_preset, status, sort_order, created_at, updated_at, metadata_json,
        source_revision_id
      ) VALUES (
        'episode-1', 'project-1', '第一集', '', 30, '16:9', '', 'draft', 0,
        ?, ?, '{}', 'revision-1'
      )
    `, now, now)
    sql.run(`
      INSERT INTO scenes (
        id, episode_id, sequence, title, description, duration_seconds,
        metadata_json, created_at, updated_at
      ) VALUES (
        'database-scene-1', 'episode-1', 0, '断崖', '黄昏断崖', 30,
        '{"storyId":"scene-1"}', ?, ?
      )
    `, now, now)
    sql.run(`
      INSERT INTO shots (
        id, scene_id, sequence, code, title, description, framing, movement,
        transition, duration_seconds, timeline_start_seconds, prompt, status,
        source_revision_id, metadata_json, created_at, updated_at
      ) VALUES (
        'database-shot-1', 'database-scene-1', 0, 'S01', '回望', '阿离在断崖回头',
        '中景', '缓慢推近', 'cut', 5, 0, '阿离在断崖回头，镜头缓慢推近。',
        'draft', 'revision-1', '{"storyId":"shot-1"}', ?, ?
      )
    `, now, now)
  })
  database.updateProject('project-1', {
    currentEpisodeId: 'episode-1',
    currentRevisionId: 'revision-1',
  })
}

async function runtime(mediaStoreFactory?: (database: ManjuDatabase, directory: string) => MediaStore): Promise<TestRuntime> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-seedance-handler-test-'))
  const database = initializeDatabase({ runtimeDirectory: directory, legacyStatePath: false })
  insertStoryGraph(database)
  const mediaStore = mediaStoreFactory?.(database, directory) ?? new MediaStore(database, { runtimeDirectory: directory })
  await mediaStore.init()
  const value = { directory, database, mediaStore }
  runtimes.push(value)
  return value
}

function boundInput(database: ManjuDatabase) {
  return createShotVideoJobInput(resolvePublicShotVideoTarget(database, {
    projectId: 'project-1',
    episodeId: 'episode-1',
    shotId: 'shot-1',
    sceneId: 'scene-1',
  }), { resolution: '720p' })
}

function audioDrivenInput(database: ManjuDatabase, durationSeconds: number) {
  const now = '2026-07-14T00:00:10.000Z'
  database.withSql((sql) => sql.run(`
    INSERT INTO dialogue_lines (
      id, shot_id, sequence, kind, text, metadata_json, created_at, updated_at
    ) VALUES (
      'database-line-1', 'database-shot-1', 0, 'dialogue', '真实台词',
      '{"storyId":"line-1"}', ?, ?
    )
  `, now, now))
  database.createMediaAsset({
    id: 'speech-asset-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'speech',
    status: 'ready',
    source: 'fixture',
    filePath: '/fixture/speech-asset-1.mp3',
    mimeType: 'audio/mpeg',
    durationSeconds,
    checksum: 'a'.repeat(64),
    sourceRevisionId: 'revision-1',
  })
  database.withSql((sql) => sql.run(`
    UPDATE dialogue_lines
       SET speech_asset_id = 'speech-asset-1', duration_seconds = ?
     WHERE id = 'database-line-1'
  `, durationSeconds))
  const target = resolvePublicShotVideoTarget(database, {
    projectId: 'project-1',
    episodeId: 'episode-1',
    shotId: 'shot-1',
    sceneId: 'scene-1',
  })
  const duration = resolveShotVideoDuration(database, target)
  if (duration.status !== 'ready') throw new Error(`unexpected duration status ${duration.status}`)
  return createShotVideoJobInput(target, {
    resolution: '720p',
    durationDecision: duration.decision,
  })
}

function provider(baseUrl: string): SeedanceVideoProvider {
  return new SeedanceVideoProvider({
    baseUrl,
    apiKey: 'fixture-seedance-key',
    model: 'doubao-seedance-2-0-260128',
    allowInsecureLocalhost: true,
  })
}

function videoProbeResult(overrides: Partial<VideoMetadataProbeResult> = {}): VideoMetadataProbeResult {
  return {
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationSeconds: 5,
    streamCount: 1,
    video: { codec: 'h264', width: 1280, height: 720, frameRate: 24 },
    audio: [],
    ...overrides,
  }
}

test('verbose baseline is persisted as an auditable strategy without changing media controls', async () => {
  const value = await runtime()
  const target = resolvePublicShotVideoTarget(value.database, {
    projectId: 'project-1',
    episodeId: 'episode-1',
    shotId: 'shot-1',
    sceneId: 'scene-1',
  })
  const compact = createShotVideoJobInput(target, {
    resolution: '720p',
    audioPolicy: 'sfx_only',
  })
  const baseline = createShotVideoJobInput(target, {
    resolution: '720p',
    audioPolicy: 'sfx_only',
    promptCompilerVersion: 'seedance-verbose-baseline-v1',
    publicationMode: 'evaluation_only',
  })
  assert.equal(compact.spec?.promptCompilerVersion, 'seedance-compact-v1')
  assert.equal(baseline.spec?.promptCompilerVersion, 'seedance-verbose-baseline-v1')
  assert.equal(compact.publicationMode, undefined)
  assert.equal(baseline.publicationMode, 'evaluation_only')
  assert.notEqual(baseline.prompt, compact.prompt)
  assert.deepEqual(
    { ...baseline.spec, promptCompilerVersion: compact.spec?.promptCompilerVersion },
    compact.spec,
  )
  assert.deepEqual({
    aspectRatio: baseline.aspectRatio,
    resolution: baseline.resolution,
    durationSeconds: baseline.durationSeconds,
    generateAudio: baseline.generateAudio,
  }, {
    aspectRatio: compact.aspectRatio,
    resolution: compact.resolution,
    durationSeconds: compact.durationSeconds,
    generateAudio: compact.generateAudio,
  })
})

test('evaluation-only verbose baseline publishes recoverable bytes without replacing the production Shot', async () => {
  let postCalls = 0
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      postCalls += 1
      sendJson(response, 200, { id: 'cgt-evaluation-only' })
      return
    }
    sendJson(response, 200, {
      id: 'cgt-evaluation-only',
      status: 'succeeded',
      content: { video_url: 'https://media.example/evaluation-only.mp4' },
    })
  })
  const value = await runtime()
  const input = createShotVideoJobInput(resolvePublicShotVideoTarget(value.database, {
    projectId: 'project-1',
    episodeId: 'episode-1',
    shotId: 'shot-1',
    sceneId: 'scene-1',
  }), {
    resolution: '720p',
    audioPolicy: 'silent',
    promptCompilerVersion: 'seedance-verbose-baseline-v1',
    publicationMode: 'evaluation_only',
  })
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl, {
    downloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
    probeVideo: async () => videoProbeResult(),
  })
  await worker.start()
  const created = await submit(worker, value.database, input)
  await worker.waitForIdle()

  const job = value.database.getGenerationJob(created.job.id)
  assert.equal(job?.status, 'succeeded', JSON.stringify(job?.error))
  assert.equal(job?.input.publicationMode, 'evaluation_only')
  assert.equal(postCalls, 1)
  const assets = value.database.listMediaAssets({ projectId: 'project-1', kind: 'shot.video' })
  assert.equal(assets.length, 1)
  assert.equal(assets[0]?.generationJobId, job?.id)
  assert.equal(assets[0]?.generationParameters.publicationMode, 'evaluation_only')
  assert.equal(value.database.withSql((sql) => sql.get(`
    SELECT video_asset_id FROM shots WHERE id = 'database-shot-1'
  `))?.video_asset_id, null)

  // Re-running the durable handler recovers the already-published Asset and
  // never resubmits the paid Provider request even though no Shot link exists.
  value.database.updateGenerationJob(job!.id, { status: 'queued', output: null, completedAt: null })
  worker.enqueue(job!.id)
  await worker.waitForIdle()
  assert.equal(value.database.getGenerationJob(job!.id)?.status, 'succeeded')
  assert.equal(postCalls, 1)
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1', kind: 'shot.video' }).length, 1)
})

test('evaluation-only compact audition publishes a review candidate without replacing the production Shot', async () => {
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      sendJson(response, 200, { id: 'cgt-compact-audition' })
      return
    }
    sendJson(response, 200, {
      id: 'cgt-compact-audition',
      status: 'succeeded',
      content: { video_url: 'https://media.example/compact-audition.mp4' },
    })
  })
  const value = await runtime()
  const input = createShotVideoJobInput(resolvePublicShotVideoTarget(value.database, {
    projectId: 'project-1',
    episodeId: 'episode-1',
    shotId: 'shot-1',
    sceneId: 'scene-1',
  }), {
    resolution: '720p',
    audioPolicy: 'provider_audio',
    promptCompilerVersion: 'seedance-compact-v1',
    publicationMode: 'evaluation_only',
  })
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl, {
    downloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
    probeVideo: async () => videoProbeResult({
      audio: [{ codec: 'aac', sampleRate: 48_000, channels: 2 }],
    }),
  })
  await worker.start()
  const created = await submit(worker, value.database, input)
  await worker.waitForIdle()

  const job = value.database.getGenerationJob(created.job.id)
  assert.equal(job?.status, 'succeeded', JSON.stringify(job?.error))
  assert.equal(input.spec?.promptCompilerVersion, 'seedance-compact-v1')
  assert.equal(input.spec?.audioPolicy, 'provider_audio')
  assert.equal(job?.input.publicationMode, 'evaluation_only')
  const assets = value.database.listMediaAssets({ projectId: 'project-1', kind: 'shot.video' })
  assert.equal(assets.length, 1)
  assert.equal(assets[0]?.generationParameters.publicationMode, 'evaluation_only')
  assert.equal(value.database.withSql((sql) => sql.get(`
    SELECT video_asset_id FROM shots WHERE id = 'database-shot-1'
  `))?.video_asset_id, null)
})

function register(
  worker: JobWorker,
  value: TestRuntime,
  baseUrl: string,
  options: {
    downloadVideo?: (url: string, signal: AbortSignal) => Promise<DownloadedVideo>
    probeVideo?: VideoMetadataProbe
  } = {},
): void {
  worker.register(SHOT_VIDEO_GENERATION_JOB_TYPE, createShotVideoGenerationHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    resolveProvider: async () => provider(baseUrl),
    ...(options.downloadVideo ? { downloadVideo: options.downloadVideo } : {}),
    probeVideo: options.probeVideo ?? (async () => videoProbeResult()),
    pollIntervalMs: 0,
    delay: async (_milliseconds, signal) => signal.throwIfAborted(),
  }), { resourceKey: () => 'provider:video' })
}

async function submit(
  worker: JobWorker,
  database: ManjuDatabase,
  input = boundInput(database),
) {
  return worker.submit({
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    input,
    idempotencyKey: 'video:shot-1:revision-1',
    resourceKey: 'provider:video',
    projectId: 'project-1',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    metadata: { episodeId: 'episode-1', resourceId: 'shot-1' },
  })
}

async function assertAmbiguousSubmissionRequiresManualHandling(
  mode: 'lost-response' | 'invalid-2xx',
): Promise<void> {
  let postCalls = 0
  let getCalls = 0
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      postCalls += 1
      if (mode === 'invalid-2xx') {
        sendJson(response, 200, { accepted: true })
        return
      }
      // The provider has received the complete paid request, but the client
      // never receives headers/a task id. Retrying this POST would double bill.
      request.resume()
      request.once('end', () => response.destroy())
      return
    }
    getCalls += 1
    sendJson(response, 500, { error: { code: 'MustNotPollWithoutTaskId' } })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  const source = value.database.getGenerationJob(created.job.id)
  assert.ok(source)
  assert.equal(postCalls, 1)
  assert.equal(getCalls, 0)
  assert.equal(source.status, 'failed')
  assert.equal(source.externalTaskId, null)
  assert.equal(source.providerState.phase, 'submitting')
  assert.equal(source.error?.code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(source.error?.retryable, false)
  await assert.rejects(
    repository.retry(source.id),
    (error: unknown) => error instanceof SQLiteRepositoryError && error.code === 'JOB_MANUAL_RESOLUTION_REQUIRED',
  )

  // Simulate a historical/manual retry node whose own generic error was
  // marked retryable. Both the repository and the handler must inspect its
  // ancestry rather than treating the empty child as safe to POST.
  const intermediate = value.database.createGenerationJob({
    id: `manual-${mode}-retry-2`,
    projectId: source.projectId,
    episodeId: source.episodeId,
    pipelineRunId: source.pipelineRunId,
    type: source.type,
    status: 'failed',
    progress: source.progress,
    resourceType: source.resourceType,
    resourceId: source.resourceId,
    providerId: source.providerId,
    model: source.model,
    providerConfigRevision: source.providerConfigRevision,
    idempotencyKey: `manual-${mode}-retry-2`,
    retryOf: source.id,
    attempt: 2,
    input: source.input,
    error: {
      code: 'UPSTREAM_UNAVAILABLE',
      message: '历史子任务的可重试错误',
      retryable: true,
      category: 'provider',
    },
  })
  await assert.rejects(
    repository.retry(intermediate.id),
    (error: unknown) => error instanceof SQLiteRepositoryError && error.code === 'JOB_MANUAL_RESOLUTION_REQUIRED',
  )

  const descendant = value.database.createGenerationJob({
    id: `manual-${mode}-retry-3`,
    projectId: intermediate.projectId,
    episodeId: intermediate.episodeId,
    pipelineRunId: intermediate.pipelineRunId,
    type: intermediate.type,
    status: 'queued',
    progress: 0,
    resourceType: intermediate.resourceType,
    resourceId: intermediate.resourceId,
    providerId: intermediate.providerId,
    model: intermediate.model,
    providerConfigRevision: intermediate.providerConfigRevision,
    idempotencyKey: `manual-${mode}-retry-3`,
    retryOf: intermediate.id,
    attempt: 3,
    input: intermediate.input,
  })
  worker.enqueue(descendant.id)
  await worker.waitForIdle()

  const terminalDescendant = value.database.getGenerationJob(descendant.id)
  assert.equal(terminalDescendant?.status, 'failed')
  assert.equal(terminalDescendant?.error?.code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(terminalDescendant?.error?.retryable, false)
  assert.equal(postCalls, 1, 'retry ancestry must never issue a second paid POST')
  assert.equal(getCalls, 0)
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1' }).length, 0)
}

test('polls through queued/429/5xx/running, downloads the temporary URL, and atomically links the shot asset', async () => {
  let postCalls = 0
  let getCalls = 0
  const signedUrl = 'https://media.example/output.mp4?X-Signature=temporary-only'
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      postCalls += 1
      sendJson(response, 200, { id: 'cgt-success' })
      return
    }
    getCalls += 1
    if (getCalls === 1) {
      sendJson(response, 200, { id: 'cgt-success', status: 'queued' })
    } else if (getCalls === 2) {
      sendJson(response, 429, { error: { code: 'QuotaExceeded', message: 'do not persist' } })
    } else if (getCalls === 3) {
      sendJson(response, 503, { error: { code: 'ServiceUnavailable', message: 'do not persist' } })
    } else if (getCalls === 4) {
      sendJson(response, 200, { id: 'cgt-success', status: 'running' })
    } else {
      sendJson(response, 200, {
        id: 'cgt-success',
        model: 'doubao-seedance-2-0-260128',
        status: 'succeeded',
        content: { video_url: signedUrl },
        // Deliberately inaccurate Provider metadata. Persisted media fields
        // must come from ffprobe instead.
        duration: '9',
        resolution: '720p',
        ratio: '16:9',
        usage: { completion_tokens: 12_345 },
      })
    }
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  let downloadedUrl = ''
  register(worker, value, baseUrl, {
    downloadVideo: async (url) => {
      downloadedUrl = url
      return { bytes: MP4_BYTES, mimeType: 'video/mp4' }
    },
    probeVideo: async () => videoProbeResult({
      durationSeconds: 5.2,
      streamCount: 2,
      video: { codec: 'h264', width: 1260, height: 708, frameRate: 24 },
      audio: [{ codec: 'aac', sampleRate: 48_000, channels: 2 }],
    }),
  })
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  assert.equal(postCalls, 1)
  assert.equal(getCalls, 5)
  assert.equal(downloadedUrl, signedUrl)
  const job = value.database.getGenerationJob(created.job.id)
  assert.equal(job?.status, 'succeeded')
  assert.equal(job?.externalTaskId, 'cgt-success')
  assert.doesNotMatch(JSON.stringify(job?.providerState), /X-Signature|temporary-only/)
  assert.doesNotMatch(JSON.stringify(job?.output), /X-Signature|temporary-only/)
  const assets = value.database.listMediaAssets({ projectId: 'project-1', kind: 'shot.video' })
  assert.equal(assets.length, 1)
  assert.equal(assets[0].status, 'ready')
  assert.equal(assets[0].mimeType, 'video/mp4')
  assert.equal(assets[0].width, 1260)
  assert.equal(assets[0].height, 708)
  assert.equal(assets[0].durationSeconds, 5.2)
  assert.equal(assets[0].sourceRevisionId, 'revision-1')
  assert.equal(assets[0].generationParameters.externalTaskId, 'cgt-success')
  assert.deepEqual(assets[0].generationParameters.mediaProbe, {
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationSeconds: 5.2,
    streamCount: 2,
    video: { codec: 'h264', width: 1260, height: 708, frameRate: 24 },
    audio: [{ codec: 'aac', sampleRate: 48_000, channels: 2 }],
  })
  assert.doesNotMatch(JSON.stringify(assets[0].generationParameters), /X-Signature|temporary-only/)
  const shot = value.database.withSql((sql) => sql.get(`
    SELECT video_asset_id, status FROM shots WHERE id = 'database-shot-1'
  `))
  assert.deepEqual(shot ? { ...shot } : null, {
    video_asset_id: assets[0].id,
    status: 'video_ready',
  })
})

test('persists the shared audio-driven timing manifest on the durable video Asset', async () => {
  let createBody: Record<string, unknown> | null = null
  const baseUrl = await listen(async (request, response) => {
    if (request.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      createBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      sendJson(response, 200, { id: 'cgt-audio-timing' })
      return
    }
    sendJson(response, 200, {
      id: 'cgt-audio-timing',
      status: 'succeeded',
      content: { video_url: 'https://media.example/audio-timing.mp4' },
      duration: '4',
      resolution: '720p',
      ratio: '16:9',
    })
  })
  const value = await runtime()
  const input = audioDrivenInput(value.database, 3.5)
  assert.equal(input.durationSeconds, 4)
  assert.equal(input.durationDecision?.timelineDurationSeconds, 3.5)
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl, {
    downloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
    probeVideo: async () => videoProbeResult({ durationSeconds: 4 }),
  })
  await worker.start()
  const created = await submit(worker, value.database, input)
  await worker.waitForIdle()
  assert.equal(value.database.getGenerationJob(created.job.id)?.status, 'succeeded')
  assert.equal((createBody as unknown as Record<string, unknown>).duration, 4)
  const [asset] = value.database.listMediaAssets({ projectId: 'project-1', kind: 'shot.video' })
  assert.ok(asset)
  assert.equal(asset.generationParameters.timelineDurationSeconds, 3.5)
  assert.deepEqual(asset.generationParameters.durationDecision, input.durationDecision)
})

test('audio timing drift fails before a paid Seedance POST', async () => {
  let postCalls = 0
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') postCalls += 1
    sendJson(response, 500, { error: { message: 'must not be called' } })
  })
  const value = await runtime()
  const input = audioDrivenInput(value.database, 3.5)
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  const created = await submit(worker, value.database, input)
  value.database.createMediaAsset({
    id: 'speech-asset-2',
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'speech',
    status: 'ready',
    source: 'fixture',
    filePath: '/fixture/speech-asset-2.mp3',
    mimeType: 'audio/mpeg',
    durationSeconds: 3.25,
    checksum: 'b'.repeat(64),
    sourceRevisionId: 'revision-1',
  })
  value.database.withSql((sql) => sql.run(`
    UPDATE dialogue_lines
       SET speech_asset_id = 'speech-asset-2', duration_seconds = 3.25
     WHERE id = 'database-line-1'
  `))
  await worker.start()
  await worker.waitForIdle()
  const terminal = value.database.getGenerationJob(created.job.id)
  assert.equal(terminal?.status, 'failed')
  assert.equal(terminal?.error?.code, 'STALE_AUDIO_TIMING')
  assert.ok(terminal)
  const remediation = readShotVideoTimingRemediation(terminal)
  assert.ok(remediation)
  assert.equal(remediation.kind, 'stale_audio_timing')
  assert.equal(remediation.checkpoint, 'initial')
  assert.equal(remediation.providerSubmissionState, 'not-started')
  assert.equal(remediation.projectId, 'project-1')
  assert.equal(remediation.episodeId, 'episode-1')
  assert.equal(remediation.shotId, 'shot-1')
  assert.equal(remediation.sceneId, 'scene-1')
  assert.equal(remediation.sourceRevisionId, 'revision-1')
  assert.deepEqual(remediation.previousDecision, input.durationDecision)
  assert.equal(remediation.currentResolution.status, 'ready')
  assert.deepEqual(remediation.affectedLines, [{
    dialogueLineId: 'line-1',
    change: 'asset_changed',
    previous: {
      assetId: 'speech-asset-1',
      version: 1,
      checksum: 'a'.repeat(64),
      durationSeconds: 3.5,
      durationFrames: 84,
    },
    current: {
      assetId: 'speech-asset-2',
      version: 1,
      checksum: 'b'.repeat(64),
      durationSeconds: 3.25,
      durationFrames: 78,
    },
  }])
  assert.equal(remediation.recommendedAction, 'repreflight-paid-video')
  assert.equal(jobRetryDisposition(value.database, terminal), 'paid-reconfirmation-required')
  assert.equal(postCalls, 0)
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1', kind: 'shot.video' }).length, 0)
})

test('audio timing drift at the submitting checkpoint fails before a paid Seedance POST', async () => {
  let postCalls = 0
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') postCalls += 1
    sendJson(response, 500, { error: { message: 'must not be called' } })
  })
  const value = await runtime()
  const input = audioDrivenInput(value.database, 3.5)
  class AudioDriftAfterSubmittingRepository extends SQLiteJobRepository {
    private mutated = false

    override async markWaitingProvider(jobId: string, providerState?: unknown) {
      const transitioned = await super.markWaitingProvider(jobId, providerState)
      if (!this.mutated
        && (providerState as { phase?: unknown } | undefined)?.phase === 'submitting') {
        this.mutated = true
        value.database.createMediaAsset({
          id: 'speech-asset-2',
          projectId: 'project-1',
          episodeId: 'episode-1',
          kind: 'speech',
          status: 'ready',
          source: 'fixture',
          filePath: '/fixture/speech-asset-2.mp3',
          mimeType: 'audio/mpeg',
          durationSeconds: 3.25,
          checksum: 'b'.repeat(64),
          sourceRevisionId: 'revision-1',
        })
        value.database.withSql((sql) => sql.run(`
          UPDATE dialogue_lines
             SET speech_asset_id = 'speech-asset-2', duration_seconds = 3.25
           WHERE id = 'database-line-1'
        `))
      }
      return transitioned
    }
  }
  const repository = new AudioDriftAfterSubmittingRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  const created = await submit(worker, value.database, input)
  await worker.waitForIdle()

  const terminal = value.database.getGenerationJob(created.job.id)
  assert.equal(terminal?.status, 'failed')
  assert.equal(terminal?.error?.code, 'STALE_AUDIO_TIMING')
  assert.notEqual(terminal?.error?.code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(terminal?.externalTaskId, null)
  assert.ok(terminal)
  const remediation = readShotVideoTimingRemediation(terminal)
  assert.ok(remediation)
  assert.equal(remediation.checkpoint, 'pre-submit')
  assert.equal(remediation.providerSubmissionState, 'not-started')
  assert.equal(jobHasUnknownSubmission(value.database, terminal), false)
  assert.equal(jobRetryDisposition(value.database, terminal), 'paid-reconfirmation-required')
  assert.equal(postCalls, 0)
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1', kind: 'shot.video' }).length, 0)
})

test('fails closed when ffprobe proves the downloaded video severely violates requested specs', async () => {
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      sendJson(response, 200, { id: 'cgt-spec-mismatch' })
      return
    }
    sendJson(response, 200, {
      id: 'cgt-spec-mismatch',
      status: 'succeeded',
      content: { video_url: 'https://media.example/spec-mismatch.mp4' },
      duration: '5',
    })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl, {
    downloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
    probeVideo: async () => videoProbeResult({
      durationSeconds: 2,
      video: { codec: 'h264', width: 640, height: 360, frameRate: 24 },
    }),
  })
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  const job = value.database.getGenerationJob(created.job.id)
  assert.equal(job?.status, 'failed')
  assert.equal(job?.error?.code, 'VIDEO_SPEC_MISMATCH')
  assert.equal(job?.error?.retryable, false)
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1' }).length, 0)
  assert.equal(value.database.withSql((sql) => sql.get(`
    SELECT video_asset_id FROM shots WHERE id = 'database-shot-1'
  `))?.video_asset_id, null)
})

test('a lost Seedance create response is manual-only and retry ancestry never submits again', async () => {
  await assertAmbiguousSubmissionRequiresManualHandling('lost-response')
})

test('an invalid Seedance 2xx create response is manual-only and retry ancestry never submits again', async () => {
  await assertAmbiguousSubmissionRequiresManualHandling('invalid-2xx')
})

test('a rejected NewAPI submit persists sanitized HTTP diagnostics while remaining duplicate-safe', async () => {
  const rawProviderMessage = 'raw gateway detail must not be persisted'
  const baseUrl = (await listen((_request, response) => {
    sendJson(response, 404, {
      error: { code: 'route_not_found', message: rawProviderMessage },
    })
  })).replace(/\/api\/v3$/, '')
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  const terminal = value.database.getGenerationJob(created.job.id)
  assert.equal(terminal?.status, 'failed')
  assert.equal(terminal?.error?.code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.deepEqual(terminal?.providerState.submissionDiagnostic, {
    operation: 'create',
    protocol: 'newapi',
    endpointFamily: 'openai-videos',
    httpStatus: 404,
    providerCode: 'route_not_found',
    observedAt: terminal?.providerState.submissionDiagnostic
      && (terminal.providerState.submissionDiagnostic as Record<string, unknown>).observedAt,
  })
  assert.match(
    String((terminal?.providerState.submissionDiagnostic as Record<string, unknown>)?.observedAt),
    /^\d{4}-\d{2}-\d{2}T/,
  )
  assert.equal(JSON.stringify(terminal).includes(rawProviderMessage), false)
  await assert.rejects(
    repository.retry(created.job.id),
    (error: unknown) => error instanceof SQLiteRepositoryError && error.code === 'JOB_MANUAL_RESOLUTION_REQUIRED',
  )
})

test('an explicit Ark account-overdue rejection is actionable and never marked outcome-unknown', async () => {
  const baseUrl = await listen((_request, response) => {
    sendJson(response, 403, {
      error: { code: 'AccountOverdueError', message: 'private account detail' },
    })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  const terminal = value.database.getGenerationJob(created.job.id)
  assert.equal(terminal?.status, 'failed')
  assert.equal(terminal?.error?.code, 'PROVIDER_BILLING_UNAVAILABLE')
  assert.equal(terminal?.error?.retryable, false)
  assert.equal(jobHasUnknownSubmission(value.database, terminal!), false)
  assert.equal(jobRetryDisposition(value.database, terminal!), 'paid-reconfirmation-required')
  assert.deepEqual(terminal?.providerState.submissionDiagnostic, {
    operation: 'create',
    protocol: 'ark',
    endpointFamily: 'ark-tasks',
    httpStatus: 403,
    providerCode: 'AccountOverdueError',
    observedAt: terminal?.providerState.submissionDiagnostic
      && (terminal.providerState.submissionDiagnostic as Record<string, unknown>).observedAt,
  })
  assert.equal(JSON.stringify(terminal).includes('private account detail'), false)
})

test('an explicit Ark quota rejection is actionable and never marked outcome-unknown', async () => {
  const baseUrl = await listen((_request, response) => {
    sendJson(response, 429, {
      error: { code: 'QuotaExceeded', message: 'private quota detail' },
    })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  const terminal = value.database.getGenerationJob(created.job.id)
  assert.equal(terminal?.status, 'failed')
  assert.equal(terminal?.error?.code, 'PROVIDER_RATE_LIMITED')
  assert.equal(terminal?.error?.retryable, true)
  assert.equal(jobHasUnknownSubmission(value.database, terminal!), false)
  assert.equal(jobRetryDisposition(value.database, terminal!), 'paid-reconfirmation-required')
  assert.deepEqual(terminal?.providerState.submissionDiagnostic, {
    operation: 'create',
    protocol: 'ark',
    endpointFamily: 'ark-tasks',
    httpStatus: 429,
    providerCode: 'QuotaExceeded',
    observedAt: terminal?.providerState.submissionDiagnostic
      && (terminal.providerState.submissionDiagnostic as Record<string, unknown>).observedAt,
  })
  assert.equal(JSON.stringify(terminal).includes('private quota detail'), false)
})

test('cancelling an in-flight Seedance create remains a manual unknown outcome, not an ordinary cancellation', async () => {
  let postStarted!: () => void
  const observedPost = new Promise<void>((resolve) => { postStarted = resolve })
  let postCalls = 0
  let getCalls = 0
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      postCalls += 1
      postStarted()
      // Keep the create response open until cancellation aborts the socket.
      request.once('close', () => response.destroy())
      return
    }
    getCalls += 1
    sendJson(response, 500, { error: { code: 'MustNotPollWithoutTaskId' } })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  const created = await submit(worker, value.database)
  await observedPost

  const cancelled = await worker.cancel(created.job.id)
  await worker.waitForIdle()

  assert.equal(postCalls, 1)
  assert.equal(getCalls, 0)
  assert.equal(cancelled?.status, 'failed')
  assert.equal(cancelled?.error?.code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(cancelled?.error?.retryable, false)
  const terminal = value.database.getGenerationJob(created.job.id)
  assert.equal(terminal?.status, 'failed')
  assert.equal(terminal?.providerState.phase, 'submitting')
  assert.equal(terminal?.externalTaskId, null)
  assert.equal(terminal?.error?.code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(terminal?.error?.retryable, false)
  await assert.rejects(
    repository.retry(created.job.id),
    (error: unknown) => error instanceof SQLiteRepositoryError && error.code === 'JOB_MANUAL_RESOLUTION_REQUIRED',
  )
})

test('a Story terminal-state race after submitting checkpoint fails closed before paid createTask', async () => {
  let providerCalls = 0
  const baseUrl = await listen((_request, response) => {
    providerCalls += 1
    sendJson(response, 500, { error: { code: 'MustNotCallPaidProvider' } })
  })
  const value = await runtime()
  class StaleAfterSubmittingRepository extends SQLiteJobRepository {
    override async markWaitingProvider(jobId: string, providerState?: unknown) {
      const transitioned = await super.markWaitingProvider(jobId, providerState)
      if ((providerState as { phase?: unknown } | undefined)?.phase === 'submitting') {
        const changedAt = '2026-07-14T00:01:00.000Z'
        value.database.transaction((transaction) => {
          transaction.createRevision({
            id: 'revision-paid-gate-race',
            projectId: 'project-1',
            parentRevisionId: 'revision-1',
            summary: '付费提交门前修改 Story',
            snapshot: { version: 2 },
            createdAt: changedAt,
          })
          transaction.withSql((sql) => {
            sql.run(`UPDATE episodes SET source_revision_id = ?, updated_at = ? WHERE id = ?`,
              'revision-paid-gate-race', changedAt, 'episode-1')
            sql.run(`UPDATE shots SET source_revision_id = ?, updated_at = ? WHERE id = ?`,
              'revision-paid-gate-race', changedAt, 'database-shot-1')
          })
          transaction.updateProject('project-1', { currentRevisionId: 'revision-paid-gate-race' })
          transaction.updateGenerationJob(jobId, {
            status: 'cancelled',
            error: {
              code: 'STALE_SOURCE',
              message: '源剧本已修改，任务结果已过期',
              retryable: false,
              category: 'cancelled',
            },
            completedAt: changedAt,
          })
        })
      }
      return transitioned
    }
  }
  const repository = new StaleAfterSubmittingRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  const terminal = value.database.getGenerationJob(created.job.id)
  assert.equal(terminal?.status, 'cancelled')
  assert.equal(terminal?.error?.code, 'STALE_SOURCE')
  assert.equal(terminal?.externalTaskId, null)
  assert.equal(providerCalls, 0, 'terminal transition must be authoritative before any paid POST')
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1' }).length, 0)
})

test('generic retry cannot turn a pre-submission Seedance failure into an unconfirmed paid POST', async () => {
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const failed = value.database.createGenerationJob({
    id: 'unconfirmed-video-retry-source',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'failed',
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    idempotencyKey: 'unconfirmed-video-retry-source',
    input: boundInput(value.database) as unknown as JsonObject,
    error: {
      code: 'UPSTREAM_UNAVAILABLE',
      message: '尚未提交 Provider 的可重试错误',
      retryable: true,
      category: 'provider',
    },
  })
  await assert.rejects(
    repository.retry(failed.id, { idempotencyKey: 'must-reconfirm-preflight' }),
    (error: unknown) => error instanceof SQLiteRepositoryError && error.code === 'JOB_PAID_RECONFIRMATION_REQUIRED',
  )
  assert.equal(value.database.listGenerationJobs({ projectId: 'project-1' }).length, 1)
})

test('recovers a waiting provider task after restart without submitting or double billing', async () => {
  let postCalls = 0
  let getCalls = 0
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      postCalls += 1
      sendJson(response, 500, { error: { code: 'MustNotSubmit' } })
      return
    }
    getCalls += 1
    sendJson(response, 200, {
      id: 'cgt-recovered',
      status: 'succeeded',
      content: { video_url: 'https://media.example/recovered.mp4?expires=soon' },
      duration: '5',
    })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const input = boundInput(value.database)
  value.database.createGenerationJob({
    id: 'job-recovered',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'waiting_provider',
    progress: 35,
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    externalTaskId: 'cgt-recovered',
    idempotencyKey: 'video:recovered',
    input: input as unknown as JsonObject,
    providerState: {
      operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
      phase: 'polling',
      externalTaskId: 'cgt-recovered',
      pollCount: 3,
    },
  })
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl, {
    downloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
  })
  await worker.start()
  await worker.waitForIdle()

  assert.equal(postCalls, 0)
  assert.equal(getCalls, 1)
  assert.equal(value.database.getGenerationJob('job-recovered')?.status, 'succeeded')
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1', kind: 'shot.video' }).length, 1)
})

test('cancellation aborts polling, records local cancellation, and issues best-effort upstream DELETE', async () => {
  let getStarted!: () => void
  const observedGet = new Promise<void>((resolve) => { getStarted = resolve })
  let deleteCalls = 0
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      sendJson(response, 200, { id: 'cgt-cancel' })
      return
    }
    if (request.method === 'DELETE') {
      deleteCalls += 1
      sendJson(response, 200, {})
      return
    }
    getStarted()
    // Keep the provider poll open until JobWorker aborts its fetch.
    request.once('close', () => response.destroy())
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl, {
    downloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
  })
  await worker.start()
  const created = await submit(worker, value.database)
  await observedGet
  const cancelled = await worker.cancel(created.job.id)
  await worker.waitForIdle()

  assert.equal(cancelled?.status, 'cancelled')
  assert.equal(value.database.getGenerationJob(created.job.id)?.status, 'cancelled')
  assert.equal(value.database.getGenerationJob(created.job.id)?.externalTaskId, 'cgt-cancel')
  assert.equal(
    value.database.getGenerationJob(created.job.id)?.providerState.cancellationCapability,
    'upstream-delete',
  )
  assert.equal(
    value.database.getGenerationJob(created.job.id)?.providerState.cancellationOutcome,
    'requested',
  )
  assert.equal(deleteCalls, 1)
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1' }).length, 0)
})

test('provider failed state becomes a safe terminal error without publishing an asset', async () => {
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      sendJson(response, 200, { id: 'cgt-failed' })
      return
    }
    sendJson(response, 200, {
      id: 'cgt-failed',
      status: 'failed',
      error: {
        code: 'OutputVideoSensitiveContentDetected',
        message: 'raw moderation detail',
      },
    })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  const job = value.database.getGenerationJob(created.job.id)
  assert.equal(job?.status, 'failed')
  assert.equal(job?.error?.code, 'CONTENT_REJECTED')
  assert.equal(job?.error?.retryable, false)
  assert.doesNotMatch(JSON.stringify(job?.error), /raw moderation detail/)
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1' }).length, 0)
})

test('provider expired state is terminal, explicit, non-retryable, and never polled again', async () => {
  let getCalls = 0
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      sendJson(response, 200, { id: 'cgt-expired' })
      return
    }
    getCalls += 1
    sendJson(response, 200, { id: 'cgt-expired', status: 'expired' })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  const job = value.database.getGenerationJob(created.job.id)
  assert.equal(getCalls, 1)
  assert.equal(job?.status, 'failed')
  assert.equal(job?.providerState.lastStatus, 'expired')
  assert.deepEqual(job?.error, {
    code: 'SEEDANCE_TASK_EXPIRED',
    message: 'Seedance 上游任务已过期，无法继续轮询或下载成片',
    retryable: false,
    category: 'provider',
  })
  await assert.rejects(
    repository.retry(created.job.id),
    (error: unknown) => error instanceof SQLiteRepositoryError && error.code === 'JOB_PAID_RECONFIRMATION_REQUIRED',
  )
})

test('fails closed when another non-retry-lineage job owns the same external task id', async () => {
  let getCalls = 0
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      sendJson(response, 200, { id: 'cgt-collision' })
      return
    }
    getCalls += 1
    sendJson(response, 500, { error: { code: 'MustNotPollCollision' } })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  value.database.createGenerationJob({
    id: 'independent-collision-owner',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'failed',
    resourceType: 'provider:video',
    resourceId: 'other-shot',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    externalTaskId: 'cgt-collision',
    idempotencyKey: 'independent-collision-owner',
    input: boundInput(value.database) as unknown as JsonObject,
    providerState: {
      operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
      phase: 'polling',
      externalTaskId: 'cgt-collision',
    },
    error: {
      code: 'HISTORICAL_FAILURE',
      message: '历史任务',
      retryable: false,
      category: 'provider',
    },
  })
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  const job = value.database.getGenerationJob(created.job.id)
  assert.equal(getCalls, 0)
  assert.equal(job?.status, 'failed')
  assert.equal(job?.externalTaskId, null)
  assert.equal(job?.error?.code, 'PROVIDER_TASK_CONFLICT')
  assert.equal(job?.error?.retryable, false)
})

test('allows the same external task id to be recovered only inside its linear retry lineage', async () => {
  let postCalls = 0
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      postCalls += 1
      sendJson(response, 500, { error: { code: 'MustNotResubmit' } })
      return
    }
    sendJson(response, 200, {
      id: 'cgt-lineage',
      status: 'succeeded',
      content: { video_url: 'https://media.example/lineage.mp4' },
    })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const source = value.database.createGenerationJob({
    id: 'lineage-source',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'failed',
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    externalTaskId: 'cgt-lineage',
    idempotencyKey: 'lineage-source',
    input: boundInput(value.database) as unknown as JsonObject,
    providerState: {
      operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
      phase: 'polling',
      externalTaskId: 'cgt-lineage',
      lastStatus: 'running',
    },
    error: {
      code: 'SEEDANCE_EXECUTION_TIMEOUT',
      message: '上一次轮询超时',
      retryable: true,
      category: 'timeout',
    },
  })
  const retried = await repository.retry(source.id)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl, {
    downloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
  })
  await worker.start()
  await worker.waitForIdle()

  assert.equal(postCalls, 0)
  assert.equal(value.database.getGenerationJob(retried.job.id)?.status, 'succeeded')
  assert.equal(value.database.getGenerationJob(retried.job.id)?.externalTaskId, 'cgt-lineage')
})

test('a queued descendant cannot create a new task after a newer lineage checkpoint proves terminal', async () => {
  let postCalls = 0
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') postCalls += 1
    sendJson(response, 500, { error: { code: 'MustNotReachProvider' } })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const input = boundInput(value.database) as unknown as JsonObject
  const root = value.database.createGenerationJob({
    id: 'terminal-lineage-root',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'cancelled',
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    externalTaskId: 'cgt-terminal-lineage',
    idempotencyKey: 'terminal-lineage-root',
    input,
    providerState: {
      operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
      phase: 'polling',
      externalTaskId: 'cgt-terminal-lineage',
      lastStatus: 'running',
    },
    error: {
      code: 'JOB_CANCELLED',
      message: '本地停止',
      retryable: false,
      category: 'cancelled',
    },
  })
  const terminal = value.database.createGenerationJob({
    id: 'terminal-lineage-proof',
    projectId: root.projectId,
    episodeId: root.episodeId,
    type: root.type,
    status: 'failed',
    resourceType: root.resourceType,
    resourceId: root.resourceId,
    providerId: root.providerId,
    model: root.model,
    providerConfigRevision: root.providerConfigRevision,
    externalTaskId: 'cgt-terminal-lineage',
    idempotencyKey: 'terminal-lineage-proof',
    retryOf: root.id,
    attempt: 2,
    input,
    providerState: {
      operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
      phase: 'polling',
      externalTaskId: 'cgt-terminal-lineage',
      lastStatus: 'expired',
    },
    error: {
      code: 'SEEDANCE_TASK_EXPIRED',
      message: 'Provider 已证明过期',
      retryable: false,
      category: 'provider',
    },
  })
  const queued = value.database.createGenerationJob({
    id: 'terminal-lineage-illegal-descendant',
    projectId: root.projectId,
    episodeId: root.episodeId,
    type: root.type,
    status: 'queued',
    resourceType: root.resourceType,
    resourceId: root.resourceId,
    providerId: root.providerId,
    model: root.model,
    providerConfigRevision: root.providerConfigRevision,
    idempotencyKey: 'terminal-lineage-illegal-descendant',
    retryOf: terminal.id,
    attempt: 3,
    input,
  })

  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  await worker.waitForIdle()

  assert.equal(postCalls, 0)
  assert.equal(value.database.getGenerationJob(queued.id)?.status, 'failed')
  assert.equal(
    value.database.getGenerationJob(queued.id)?.error?.code,
    'PROVIDER_TASK_ALREADY_TERMINAL',
  )
})

test('a total handler deadline classifies timeout and releases the provider:video slot', async () => {
  let getCalls = 0
  let cancelCalls = 0
  let followupRan = false
  const deadlineProvider: SeedanceVideoProviderContract = {
    name: 'seedance',
    model: 'doubao-seedance-2-0-260128',
    configured: true,
    cancellationCapability: 'upstream-delete',
    async createTask() {
      return { id: 'cgt-deadline' }
    },
    async getTask(_taskId, signal): Promise<SeedanceTask> {
      getCalls += 1
      return new Promise<SeedanceTask>((_resolve, reject) => {
        if (!signal) throw new Error('fixture expected an execution signal')
        const abort = () => reject(signal.reason)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    },
    async cancelTask(): Promise<SeedanceCancellationResult> {
      cancelCalls += 1
      return { capability: 'upstream-delete', outcome: 'requested' }
    },
  }
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository, {
    concurrency: 2,
    resourceConcurrency: { 'provider:video': 1 },
  })
  worker.register(SHOT_VIDEO_GENERATION_JOB_TYPE, createShotVideoGenerationHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    resolveProvider: async () => deadlineProvider,
    probeVideo: async () => videoProbeResult(),
    pollIntervalMs: 0,
    totalDeadlineMs: 100,
  }), { resourceKey: () => 'provider:video' })
  worker.register('fixture.video.followup', async () => {
    followupRan = true
    return { ok: true }
  }, { resourceKey: () => 'provider:video' })
  await worker.start()
  const created = await submit(worker, value.database)
  const followup = await worker.submit({
    type: 'fixture.video.followup',
    input: {},
    idempotencyKey: 'video-deadline-followup',
    resourceKey: 'provider:video',
    projectId: 'project-1',
  })
  await worker.waitForIdle()

  const terminal = value.database.getGenerationJob(created.job.id)
  assert.equal(getCalls, 1)
  assert.equal(cancelCalls, 1)
  assert.equal(terminal?.status, 'failed')
  assert.equal(terminal?.externalTaskId, 'cgt-deadline')
  assert.deepEqual(terminal?.error, {
    code: 'SEEDANCE_EXECUTION_TIMEOUT',
    message: 'Seedance 视频任务超过本次执行时限，已释放视频 Provider 槽位',
    retryable: true,
    category: 'timeout',
  })
  assert.equal(followupRan, true)
  assert.equal(value.database.getGenerationJob(followup.job.id)?.status, 'succeeded')
  assert.equal(worker.getStats().active, 0)
})

test('default output downloader rejects a localhost/HTTP result URL as SSRF', async () => {
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      sendJson(response, 200, { id: 'cgt-ssrf' })
      return
    }
    sendJson(response, 200, {
      id: 'cgt-ssrf',
      status: 'succeeded',
      content: { video_url: 'http://127.0.0.1:9/latest/meta-data.mp4' },
    })
  })
  const value = await runtime()
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl)
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  const job = value.database.getGenerationJob(created.job.id)
  assert.equal(job?.status, 'failed')
  assert.equal(job?.error?.code, 'UNSAFE_RESOURCE_URL')
  assert.equal(job?.error?.retryable, false)
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1' }).length, 0)
})

class BeforeSaveRaceMediaStore extends MediaStore {
  private raced = false

  constructor(
    database: ManjuDatabase,
    directory: string,
    private readonly beforeFirstSave: () => void,
  ) {
    super(database, { runtimeDirectory: directory })
  }

  override async save(input: SaveMediaInput, options: SaveMediaOptions = {}) {
    if (!this.raced) {
      this.raced = true
      this.beforeFirstSave()
    }
    return super.save(input, options)
  }
}

test('known Provider task with final audio drift rolls back publication and requires paid reconfirmation', async () => {
  let postCalls = 0
  let databaseRef!: ManjuDatabase
  const value = await runtime((database, directory) => {
    databaseRef = database
    return new BeforeSaveRaceMediaStore(database, directory, () => {
      database.createMediaAsset({
        id: 'speech-asset-final-drift',
        projectId: 'project-1',
        episodeId: 'episode-1',
        kind: 'speech',
        status: 'ready',
        source: 'fixture',
        filePath: '/fixture/speech-asset-final-drift.mp3',
        mimeType: 'audio/mpeg',
        durationSeconds: 3.75,
        checksum: 'c'.repeat(64),
        sourceRevisionId: 'revision-1',
      })
      database.withSql((sql) => sql.run(`
        UPDATE dialogue_lines
           SET speech_asset_id = 'speech-asset-final-drift', duration_seconds = 3.75
         WHERE id = 'database-line-1'
      `))
    })
  })
  assert.equal(databaseRef, value.database)
  const input = audioDrivenInput(value.database, 3.5)
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      postCalls += 1
      sendJson(response, 200, { id: 'cgt-final-audio-drift' })
      return
    }
    sendJson(response, 200, {
      id: 'cgt-final-audio-drift',
      status: 'succeeded',
      content: { video_url: 'https://media.example/final-audio-drift.mp4' },
      duration: '4',
      resolution: '720p',
      ratio: '16:9',
    })
  })
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl, {
    downloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
    probeVideo: async () => videoProbeResult({ durationSeconds: 4 }),
  })
  await worker.start()
  const created = await submit(worker, value.database, input)
  await worker.waitForIdle()

  const terminal = value.database.getGenerationJob(created.job.id)
  assert.ok(terminal)
  assert.equal(postCalls, 1)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error?.code, 'STALE_AUDIO_TIMING')
  assert.equal(terminal.externalTaskId, 'cgt-final-audio-drift')
  const remediation = readShotVideoTimingRemediation(terminal)
  assert.ok(remediation)
  assert.equal(remediation.checkpoint, 'pre-publish')
  assert.equal(remediation.providerSubmissionState, 'task-exists')
  assert.equal(remediation.currentResolution.status, 'ready')
  assert.equal(remediation.affectedLines[0]?.change, 'asset_changed')
  assert.equal(remediation.affectedLines[0]?.current?.assetId, 'speech-asset-final-drift')
  assert.equal(jobRetryDisposition(value.database, terminal), 'paid-reconfirmation-required')
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1', kind: 'shot.video' }).length, 0)
  assert.equal(value.database.withSql((sql) => sql.get(`
    SELECT video_asset_id FROM shots WHERE id = 'database-shot-1'
  `))?.video_asset_id, null)
})

async function mediaFileCount(directory: string): Promise<number> {
  const root = join(directory, 'media')
  const projects = await readdir(root, { withFileTypes: true })
  let count = 0
  for (const project of projects) {
    if (!project.isDirectory()) continue
    count += (await readdir(join(root, project.name), { withFileTypes: true }))
      .filter((entry) => entry.isFile()).length
  }
  return count
}

test('a source revision race during publish rolls back both the media row and the already-written file', async () => {
  let databaseRef!: ManjuDatabase
  const value = await runtime((database, directory) => {
    databaseRef = database
    return new BeforeSaveRaceMediaStore(database, directory, () => {
      const now = '2026-07-14T00:01:00.000Z'
      database.createRevision({
        id: 'revision-2',
        projectId: 'project-1',
        parentRevisionId: 'revision-1',
        summary: '生成期间编辑',
        snapshot: { version: 2 },
        createdAt: now,
      })
      database.withSql((sql) => {
        sql.run(`UPDATE episodes SET source_revision_id = 'revision-2', updated_at = ? WHERE id = 'episode-1'`, now)
        sql.run(`UPDATE shots SET source_revision_id = 'revision-2', updated_at = ? WHERE id = 'database-shot-1'`, now)
      })
      database.updateProject('project-1', { currentRevisionId: 'revision-2' })
    })
  })
  assert.equal(databaseRef, value.database)
  const baseUrl = await listen((request, response) => {
    if (request.method === 'POST') {
      sendJson(response, 200, { id: 'cgt-stale' })
      return
    }
    sendJson(response, 200, {
      id: 'cgt-stale',
      status: 'succeeded',
      content: { video_url: 'https://media.example/stale.mp4?temporary=yes' },
      duration: '5',
    })
  })
  const repository = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(repository)
  register(worker, value, baseUrl, {
    downloadVideo: async () => ({ bytes: MP4_BYTES, mimeType: 'video/mp4' }),
  })
  await worker.start()
  const created = await submit(worker, value.database)
  await worker.waitForIdle()

  const job = value.database.getGenerationJob(created.job.id)
  assert.equal(job?.status, 'failed')
  assert.equal(job?.error?.code, 'STALE_SOURCE')
  assert.equal(value.database.listMediaAssets({ projectId: 'project-1' }).length, 0)
  assert.equal(await mediaFileCount(value.directory), 0)
  assert.equal(value.database.withSql((sql) => sql.get(`
    SELECT video_asset_id FROM shots WHERE id = 'database-shot-1'
  `))?.video_asset_id, null)
  assert.equal(value.database.withSql((sql) => sql.get(`
    SELECT source_revision_id FROM episodes WHERE id = 'episode-1'
  `))?.source_revision_id, 'revision-2')
})
