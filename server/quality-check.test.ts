import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app-v1.js'
import { initializeDatabase, type ManjuDatabase } from './database.js'
import { ExportRenderService } from './export-render.js'
import type { ProcessRunRequest, ProcessRunResult, RenderProcessRunner } from './ffmpeg-renderer.js'
import { MediaStore } from './media.js'
import {
  analyzeSubtitleQuality,
  createQualityCheckJobHandler,
  DEFAULT_QUALITY_POLICY,
  FfmpegQualityAnalyzer,
  QUALITY_CHECK_JOB_TYPE,
  QualityCheckError,
  QualityCheckService,
  type QualityAnalysisRequest,
  type QualityAnalysisResult,
  type QualityAnalyzerPort,
  type QualityCheckResult,
  type QualityExpectedSpecification,
} from './quality-check.js'
import { SQLiteJobRepository } from './repositories.js'
import { SQLiteTimelineDocumentRepository, TimelineDocumentService } from './timeline-documents.js'
import { JobWorker } from './worker.js'

const MP4 = Buffer.from('0000ftypisom-quality-check-test')
const NOW = '2026-07-14T00:00:00.000Z'
const OPEN_CUT_COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const expected: QualityExpectedSpecification = {
  container: 'mp4',
  durationSeconds: 30,
  frameCount: 720,
  videoCodec: 'h264',
  width: 1280,
  height: 720,
  pixelFormat: 'yuv420p',
  frameRate: 24,
  audioCodec: 'aac',
  audioSampleRate: 48_000,
  audioChannels: 2,
}

function probeJson(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1280,
        height: 720,
        pix_fmt: 'yuv420p',
        avg_frame_rate: '24/1',
        nb_frames: '720',
      },
      {
        codec_type: 'audio',
        codec_name: 'aac',
        sample_rate: '48000',
        channels: 2,
      },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '30.000000', size: '1024' },
    ...overrides,
  }))
}

class FakeRunner implements RenderProcessRunner {
  readonly calls: ProcessRunRequest[] = []

  constructor(
    private readonly blackStderr = '',
    private readonly audioStderr = '[Parsed_volumedetect_0] max_volume: -3.0 dB',
  ) {}

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    if (request.command.endsWith('ffprobe')) {
      return { exitCode: 0, stdout: probeJson(), stderr: Buffer.alloc(0) }
    }
    const isBlack = request.args.some((arg) => arg.includes('blackdetect='))
    return {
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(isBlack ? this.blackStderr : this.audioStderr),
    }
  }
}

async function analyzerInput(): Promise<{ directory: string; path: string }> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'manju-quality-analyzer-')))
  const path = join(directory, 'input.mp4')
  await writeFile(path, MP4)
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return { directory, path }
}

test('real analyzer uses argument arrays and reports conforming ffprobe/black/silence/peak checks', async () => {
  const input = await analyzerInput()
  const runner = new FakeRunner()
  const analyzer = new FfmpegQualityAnalyzer({
    ffmpegPath: '/fake/ffmpeg',
    ffprobePath: '/fake/ffprobe',
    runner,
  })
  const result = await analyzer.analyze({
    inputPath: input.path,
    expected,
    policy: DEFAULT_QUALITY_POLICY,
  })

  assert.equal(result.passed, true)
  assert.deepEqual(result.checks.map((item) => [item.id, item.status]), [
    ['decodable', 'passed'],
    ['ffprobe.specification', 'passed'],
    ['video.black-frames', 'passed'],
    ['audio.silence', 'passed'],
    ['audio.peak', 'passed'],
  ])
  assert.equal(runner.calls.length, 3)
  for (const call of runner.calls) {
    assert.equal(call.cwd, input.directory)
    assert.equal(call.args.includes(input.path), true)
    assert.equal(call.args.some((arg) => arg.includes(';rm ') || arg.includes('$(rm')), false)
  }
  assert.equal(runner.calls[0].args.at(-1), input.path)
})

test('real analyzer persists bounded black/silence/peak evidence as QC failures', async () => {
  const input = await analyzerInput()
  const runner = new FakeRunner(
    '[blackdetect] black_start:0 black_end:4 black_duration:4',
    [
      '[silencedetect] silence_start: 3',
      '[silencedetect] silence_end: 25 | silence_duration: 22',
      '[volumedetect] max_volume: 0.0 dB',
    ].join('\n'),
  )
  const result = await new FfmpegQualityAnalyzer({
    ffmpegPath: '/fake/ffmpeg',
    ffprobePath: '/fake/ffprobe',
    runner,
  }).analyze({ inputPath: input.path, expected, policy: DEFAULT_QUALITY_POLICY })

  assert.equal(result.passed, false)
  assert.equal(result.checks.find((item) => item.id === 'video.black-frames')?.status, 'failed')
  assert.equal(result.checks.find((item) => item.id === 'audio.silence')?.status, 'failed')
  assert.equal(result.checks.find((item) => item.id === 'audio.peak')?.status, 'failed')
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /manju-quality-analyzer|input\.mp4/)
  assert.match(serialized, /"totalSeconds":4/)
  assert.match(serialized, /"totalSeconds":22/)
})

test('ffprobe specification mismatches fail the report even when media decoding succeeds', async () => {
  const input = await analyzerInput()
  let invocation = 0
  const runner: RenderProcessRunner = {
    async run(): Promise<ProcessRunResult> {
      invocation += 1
      if (invocation === 1) {
        const parsed = JSON.parse(probeJson().toString('utf8')) as {
          streams: Array<Record<string, unknown>>
          format: Record<string, unknown>
        }
        parsed.streams[0].width = 1920
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify(parsed)), stderr: Buffer.alloc(0) }
      }
      return {
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(invocation === 3 ? 'max_volume: -6.0 dB' : ''),
      }
    },
  }
  const result = await new FfmpegQualityAnalyzer({
    ffmpegPath: '/fake/ffmpeg',
    ffprobePath: '/fake/ffprobe',
    runner,
  }).analyze({ inputPath: input.path, expected, policy: DEFAULT_QUALITY_POLICY })
  const specification = result.checks.find((item) => item.id === 'ffprobe.specification')
  assert.equal(result.passed, false)
  assert.equal(specification?.status, 'failed')
  assert.deepEqual(specification?.metrics.violations, ['resolution'])
  assert.equal(result.checks.find((item) => item.id === 'decodable')?.status, 'passed')
})

test('subtitle quality skips an empty immutable track and warns only for fast valid timing', () => {
  const empty = analyzeSubtitleQuality([], expected)
  assert.deepEqual(empty.map((item) => [item.id, item.status]), [
    ['subtitle.timing', 'skipped'],
    ['subtitle.safe-area', 'skipped'],
  ])

  const result = analyzeSubtitleQuality([
    { id: 'subtitle-1', startFrame: 0, durationFrames: 48, text: '安全字幕' },
    { id: 'subtitle-2', startFrame: 48, durationFrames: 6, text: 'abcdefghij' },
  ], expected)
  assert.equal(result[0].status, 'warning')
  assert.equal(result[0].metrics.invalidCueCount, 0)
  assert.equal(result[0].metrics.outOfBoundsCueCount, 0)
  assert.equal(result[0].metrics.overlapCueCount, 0)
  assert.equal(result[0].metrics.fastReadingCueCount, 1)
  assert.equal(result[1].status, 'passed')
  assert.equal(result[1].metrics.safeWidthPixels, 1_126)
  assert.equal(result[1].metrics.fontSizePixels, 35)
})

test('subtitle timing fails closed on illegal, out-of-bounds and overlapping cues', () => {
  const [timing, safeArea] = analyzeSubtitleQuality([
    { id: 'subtitle-1', startFrame: 0, durationFrames: 48, text: '第一句' },
    { id: 'subtitle-2', startFrame: 24, durationFrames: 48, text: '重叠句' },
    { id: 'subtitle-3', startFrame: 700, durationFrames: 30, text: '越界句' },
    { id: 'subtitle-4', startFrame: -1, durationFrames: 0, text: '非法句' },
  ], expected)

  assert.equal(timing.status, 'failed')
  assert.equal(timing.metrics.invalidCueCount, 1)
  assert.equal(timing.metrics.outOfBoundsCueCount, 1)
  assert.equal(timing.metrics.overlapCueCount, 1)
  assert.equal(safeArea.status, 'passed')
})

test('subtitle safe-area enforces at most two lines and the renderer-derived width', () => {
  const [timing, safeArea] = analyzeSubtitleQuality([
    { id: 'subtitle-lines', startFrame: 0, durationFrames: 240, text: '第一行\n第二行\n第三行' },
    { id: 'subtitle-wide', startFrame: 240, durationFrames: 240, text: '界'.repeat(40) },
  ], expected)

  assert.equal(timing.status, 'passed')
  assert.equal(safeArea.status, 'failed')
  assert.equal(safeArea.metrics.lineLimitViolationCount, 1)
  assert.equal(safeArea.metrics.widthViolationCount, 1)
  assert.equal(safeArea.metrics.maximumLines, 2)
  assert.ok(Number(safeArea.metrics.maximumEstimatedLineWidthPixels) > Number(safeArea.metrics.safeWidthPixels))
})

test('subtitle quality rejects oversized or malformed snapshots with bounded metrics', () => {
  const oversized = Array.from({ length: 10_001 }, (_, index) => ({
    id: `subtitle-${index}`,
    startFrame: index,
    durationFrames: 1,
    text: 'x',
  }))
  const checks = analyzeSubtitleQuality(oversized, expected)
  assert.deepEqual(checks.map((item) => item.status), ['failed', 'failed'])
  assert.equal(checks[0].metrics.cueCount, 10_001)
  assert.ok(JSON.stringify(checks).length < 2_000)

  const malformed = analyzeSubtitleQuality(null, expected)
  assert.deepEqual(malformed.map((item) => item.status), ['failed', 'failed'])
  assert.ok(JSON.stringify(malformed).length < 2_000)

  const manyInvalid = analyzeSubtitleQuality(Array.from({ length: 100 }, (_, index) => ({
    id: `invalid-${index}`,
    startFrame: -1,
    durationFrames: 0,
    text: 'x',
  })), expected)
  assert.equal(manyInvalid[0].status, 'failed')
  assert.equal((manyInvalid[0].metrics.violationSample as unknown[]).length, 32)
  assert.equal(manyInvalid[0].metrics.omittedViolationCount, 68)
  assert.ok(JSON.stringify(manyInvalid).length < 8_000)
})

interface Fixture {
  directory: string
  database: ManjuDatabase
  mediaStore: MediaStore
  exports: ExportRenderService
  quality: QualityCheckService
  projectId: string
  episodeId: string
  exportId: string
  assetId: string
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-quality-service-'))
  const database = initializeDatabase({
    runtimeDirectory: directory,
    legacyStatePath: false,
    backupDirectory: false,
  })
  cleanups.push(async () => {
    database.close()
    await rm(directory, { recursive: true, force: true })
  })
  const projectId = 'quality-project'
  const episodeId = 'quality-episode'
  const storyRevisionId = 'quality-story-revision'
  const exportId = 'quality-export'
  database.createProject({ id: projectId, title: '质检项目' })
  database.withSql((sql) => sql.run(`
    INSERT INTO episodes (
      id, project_id, title, source_text, aspect_ratio, style_preset, status,
      sort_order, metadata_json, created_at, updated_at
    ) VALUES (?, ?, '质检分集', '', '16:9', '', 'draft', 0, '{}', ?, ?)
  `, episodeId, projectId, NOW, NOW))
  database.createRevision({
    id: storyRevisionId,
    projectId,
    summary: 'quality source',
    snapshot: {},
    createdAt: NOW,
  })
  const timelines = new TimelineDocumentService(new SQLiteTimelineDocumentRepository(database))
  const timeline = timelines.saveReconciled({
    projectId,
    episodeId,
    expectedRevisionId: null,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    sourceRevisionId: storyRevisionId,
    document: { version: 1, tracks: { overlay: [], main: { id: 'main', type: 'video', elements: [] }, audio: [] } },
  })
  const timelineRevisionId = timeline.revision.id
  const mediaStore = new MediaStore(database, { runtimeDirectory: directory })
  await mediaStore.init()
  const asset = await mediaStore.save({
    id: 'quality-export-asset',
    projectId,
    episodeId,
    kind: 'export.video',
    bytes: MP4,
    mimeType: 'video/mp4',
    source: 'renderer',
    sourceRevisionId: storyRevisionId,
    width: 1280,
    height: 720,
    durationSeconds: 30,
    generationParameters: {
      timelineRevisionId,
      storyRevisionId,
      resolution: '720p',
      frameRate: 24,
    },
  })
  database.withSql((sql) => sql.run(`
    INSERT INTO exports (
      id, project_id, episode_id, status, timeline_snapshot_json,
      output_asset_id, specification_json, error_json, created_at, updated_at,
      completed_at, timeline_document_revision_id
    ) VALUES (?, ?, ?, 'succeeded', ?, ?, ?, NULL, ?, ?, ?, ?)
  `,
  exportId,
  projectId,
  episodeId,
  JSON.stringify({
    version: 1,
    timelineDocumentId: 'quality-timeline',
    timelineRevisionId,
    storyRevisionId,
    ticksPerSecond: 120_000,
    frameRate: 24,
    visualClips: [{
      id: 'clip', startFrame: 0, durationFrames: 720, assetId: 'unused-image', fit: 'cover',
    }],
    audioClips: [],
    subtitleCues: [],
  }),
  asset.id,
  JSON.stringify({
    version: 1,
    resolution: '720p',
    kenBurns: false,
    burnSubtitles: false,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    frameRate: 24,
    audioCodec: 'aac',
    audioSampleRate: 48_000,
    timelineRevisionId,
    storyRevisionId,
  }),
  NOW,
  NOW,
  NOW,
  timelineRevisionId))
  const exports = new ExportRenderService(database, timelines)
  return {
    directory,
    database,
    mediaStore,
    exports,
    quality: new QualityCheckService(database, exports),
    projectId,
    episodeId,
    exportId,
    assetId: asset.id,
  }
}

function setExportSubtitleCues(
  value: Fixture,
  cues: Array<{ id: string; startFrame: number; durationFrames: number; text: string }>,
): void {
  const row = value.database.withSql((sql) => sql.get(
    'SELECT timeline_snapshot_json FROM exports WHERE id = ?',
    value.exportId,
  ))
  assert.equal(typeof row?.timeline_snapshot_json, 'string')
  const snapshot = JSON.parse(String(row!.timeline_snapshot_json)) as Record<string, unknown>
  snapshot.subtitleCues = cues
  value.database.withSql((sql) => sql.run(
    'UPDATE exports SET timeline_snapshot_json = ? WHERE id = ?',
    JSON.stringify(snapshot),
    value.exportId,
  ))
}

function passingChecks(): QualityCheckResult[] {
  return [
    { id: 'decodable', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
    { id: 'ffprobe.specification', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
    { id: 'video.black-frames', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
    { id: 'audio.silence', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
    { id: 'audio.peak', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
  ]
}

class PassingAnalyzer implements QualityAnalyzerPort {
  readonly calls: QualityAnalysisRequest[] = []

  async analyze(request: QualityAnalysisRequest): Promise<QualityAnalysisResult> {
    this.calls.push(request)
    assert.equal(request.inputPath.endsWith('/input.mp4'), true)
    assert.equal(request.inputPath.includes('quality-check-'), true)
    return { passed: true, checks: passingChecks(), metrics: { analyzer: 'test' } }
  }
}

test('binds QC child jobs to an exact matching Pipeline Run and fails closed on reuse', async () => {
  const value = await fixture()
  const pipeline = value.database.createPipelineRun({
    id: 'quality-pipeline',
    projectId: value.projectId,
    episodeId: value.episodeId,
  })
  const base = {
    exportId: value.exportId,
    idempotencyKey: 'pipeline-quality-once',
  }
  const created = value.quality.create({ ...base, pipelineRunId: pipeline.id })
  assert.equal(created.job.pipelineRunId, pipeline.id)
  assert.equal(value.database.getGenerationJob(created.job.id)?.pipelineRunId, pipeline.id)

  const duplicate = value.quality.create({ ...base, pipelineRunId: pipeline.id })
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.job.id, created.job.id)
  assert.throws(
    () => value.quality.create(base),
    (error: unknown) => error instanceof QualityCheckError
      && error.code === 'IDEMPOTENCY_CONFLICT',
  )
  const secondPipeline = value.database.createPipelineRun({
    id: 'quality-pipeline-second',
    projectId: value.projectId,
    episodeId: value.episodeId,
  })
  assert.throws(
    () => value.quality.create({ ...base, pipelineRunId: secondPipeline.id }),
    (error: unknown) => error instanceof QualityCheckError
      && error.code === 'IDEMPOTENCY_CONFLICT',
  )

  value.database.withSql((sql) => sql.run(`
    INSERT INTO episodes (
      id, project_id, title, source_text, aspect_ratio, style_preset, status,
      sort_order, metadata_json, created_at, updated_at
    ) VALUES ('quality-other-episode', ?, '其他分集', '', '16:9', '', 'draft', 1, '{}', ?, ?)
  `, value.projectId, NOW, NOW))
  const mismatched = value.database.createPipelineRun({
    id: 'quality-pipeline-wrong-episode',
    projectId: value.projectId,
    episodeId: 'quality-other-episode',
  })
  assert.throws(
    () => value.quality.create({
      ...base,
      pipelineRunId: mismatched.id,
      idempotencyKey: 'pipeline-quality-wrong-episode',
    }),
    (error: unknown) => error instanceof QualityCheckError
      && error.code === 'PIPELINE_RUN_MISMATCH',
  )
  assert.throws(
    () => value.quality.create({
      ...base,
      pipelineRunId: 'missing-quality-pipeline',
      idempotencyKey: 'pipeline-quality-missing',
    }),
    (error: unknown) => error instanceof QualityCheckError
      && error.code === 'PIPELINE_RUN_NOT_FOUND',
  )
})

test('durable service pins export/asset/checksum and worker persists an immutable resumable report', async () => {
  const value = await fixture()
  const created = value.quality.create({ exportId: value.exportId, idempotencyKey: 'quality-once' })
  assert.equal(created.created, true)
  assert.equal(created.report.document.binding.outputAssetId, value.assetId)
  assert.match(created.report.document.binding.outputAssetChecksum, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(created.report), /filePath|quality-service-/)

  const duplicate = value.quality.create({ exportId: value.exportId, idempotencyKey: 'quality-once' })
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.report.id, created.report.id)
  assert.equal(duplicate.job.id, created.job.id)

  const analyzer = new PassingAnalyzer()
  const worker = new JobWorker(new SQLiteJobRepository(value.database), {
    concurrency: 1,
    onEvent(event) {
      const job = value.database.getGenerationJob(event.jobId)
      if (job) value.quality.syncJob(job)
    },
  })
  worker.register(QUALITY_CHECK_JOB_TYPE, createQualityCheckJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    qualityChecks: value.quality,
    runtimeDirectory: value.directory,
    analyzer,
  }))
  await worker.start()
  worker.enqueue(created.job.id)
  await worker.waitForIdle()

  const report = value.quality.require(created.report.id)
  const completedJob = value.database.getGenerationJob(created.job.id)
  assert.equal(completedJob?.status, 'succeeded', JSON.stringify(completedJob?.error))
  assert.equal(report.status, 'passed', JSON.stringify(completedJob?.error))
  assert.equal(report.passed, true)
  assert.equal(report.document.summary.failedChecks, 0)
  assert.deepEqual(report.document.checks.slice(-2).map((item) => [item.id, item.status]), [
    ['subtitle.timing', 'skipped'],
    ['subtitle.safe-area', 'skipped'],
  ])
  assert.equal(report.document.checks.length, 7)
  assert.equal(analyzer.calls.length, 1)
  assert.equal(analyzer.calls[0].expected.frameCount, 720)

  assert.throws(() => value.database.withSql((sql) => sql.run(`
    UPDATE quality_reports
       SET checks_json = json_set(checks_json, '$.binding.outputAssetId', 'attacker-asset')
     WHERE id = ?
  `, report.id)), /quality report binding is immutable/)

  // A recovered handler returns the already-persisted terminal report rather
  // than repeating an expensive decode pass after a crash window.
  const handler = createQualityCheckJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    qualityChecks: value.quality,
    runtimeDirectory: value.directory,
    analyzer,
  })
  const resumed = await handler({
    id: created.job.id,
    type: QUALITY_CHECK_JOB_TYPE,
    status: 'running',
    projectId: value.projectId,
    input: created.job.input as never,
  }, {
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    waitingForProvider: async () => undefined,
  })
  assert.equal(resumed.passed, true)
  assert.equal(analyzer.calls.length, 1)
  await worker.stop()
})

test('quality handler appends subtitle checks and fails publication when safe-area fails', async () => {
  const value = await fixture()
  setExportSubtitleCues(value, [{
    id: 'unsafe-three-lines',
    startFrame: 0,
    durationFrames: 240,
    text: '第一行\n第二行\n第三行',
  }])
  const created = value.quality.create({
    exportId: value.exportId,
    idempotencyKey: 'quality-subtitle-safe-area',
  })
  const analyzer = new PassingAnalyzer()
  const worker = new JobWorker(new SQLiteJobRepository(value.database), { concurrency: 1 })
  worker.register(QUALITY_CHECK_JOB_TYPE, createQualityCheckJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    qualityChecks: value.quality,
    runtimeDirectory: value.directory,
    analyzer,
  }))
  await worker.start()
  try {
    worker.enqueue(created.job.id)
    await worker.waitForIdle()
    const report = value.quality.require(created.report.id)
    const completedJob = value.database.getGenerationJob(created.job.id)
    assert.equal(completedJob?.status, 'succeeded', JSON.stringify(completedJob?.error))
    assert.equal(report.status, 'failed')
    assert.equal(report.passed, false)
    assert.equal(report.document.checks.length, 7)
    assert.deepEqual(report.document.checks.slice(-2).map((item) => [item.id, item.status]), [
      ['subtitle.timing', 'passed'],
      ['subtitle.safe-area', 'failed'],
    ])
    assert.equal(report.document.summary.failedChecks, 1)
    assert.equal(report.document.metrics.mediaCheckCount, 5)
    assert.equal(report.document.metrics.subtitleCheckCount, 2)
    assert.equal(report.document.metrics.checkCount, 7)
  } finally {
    await worker.stop()
  }
})

async function listen(runtime: ApplicationRuntime): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(runtime.app)
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind TCP')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

test('HTTP API requires idempotency, queues real quality.check, and exposes persisted evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-quality-http-'))
  const analyzer = new PassingAnalyzer()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    autoStartWorker: false,
    qualityAnalyzer: analyzer,
  })
  // Add an export in the application database using the same immutable shape
  // as the service fixture (the default seeded project is not otherwise used).
  const { project } = runtime.projectService.ensureDefaultProject()
  const episodeId = 'quality-http-episode'
  const storyRevisionId = 'quality-http-story'
  runtime.database.withSql((sql) => sql.run(`
    INSERT INTO episodes (
      id, project_id, title, source_text, aspect_ratio, style_preset, status,
      sort_order, metadata_json, created_at, updated_at
    ) VALUES (?, ?, 'HTTP 质检', '', '16:9', '', 'draft', 0, '{}', ?, ?)
  `, episodeId, project.id, NOW, NOW))
  runtime.database.createRevision({
    id: storyRevisionId,
    projectId: project.id,
    summary: 'http quality source',
    snapshot: {},
    createdAt: NOW,
  })
  const timeline = runtime.timelineDocumentService.saveReconciled({
    projectId: project.id,
    episodeId,
    expectedRevisionId: null,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    sourceRevisionId: storyRevisionId,
    document: { version: 1, tracks: { overlay: [], main: { id: 'main', type: 'video', elements: [] }, audio: [] } },
  })
  const timelineRevisionId = timeline.revision.id
  const asset = await runtime.mediaStore.save({
    id: 'quality-http-asset',
    projectId: project.id,
    episodeId,
    kind: 'export.video',
    bytes: MP4,
    mimeType: 'video/mp4',
    source: 'renderer',
    sourceRevisionId: storyRevisionId,
    generationParameters: { timelineRevisionId, storyRevisionId },
  })
  runtime.database.withSql((sql) => sql.run(`
    INSERT INTO exports (
      id, project_id, episode_id, status, timeline_snapshot_json,
      output_asset_id, specification_json, created_at, updated_at, completed_at,
      timeline_document_revision_id
    ) VALUES ('quality-http-export', ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?)
  `,
  project.id,
  episodeId,
  JSON.stringify({
    version: 1,
    timelineDocumentId: 'document',
    timelineRevisionId,
    storyRevisionId,
    ticksPerSecond: 120_000,
    frameRate: 24,
    visualClips: [{ id: 'clip', startFrame: 0, durationFrames: 720, assetId: 'image', fit: 'cover' }],
    audioClips: [],
    subtitleCues: [],
  }),
  asset.id,
  JSON.stringify({
    version: 1,
    resolution: '720p',
    kenBurns: false,
    burnSubtitles: false,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    frameRate: 24,
    audioCodec: 'aac',
    audioSampleRate: 48_000,
    timelineRevisionId,
    storyRevisionId,
  }),
  NOW,
  NOW,
  NOW,
  timelineRevisionId))

  await runtime.worker.start()
  const { server, baseUrl } = await listen(runtime)
  cleanups.push(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })

  // This suite exercises the technical QC gate. Human release approval has a
  // separate append-only audit and is covered by release-review.test.ts.
  const downloadUrl = `${baseUrl}/api/v1/exports/quality-http-export/review-download`
  const bypass = await fetch(downloadUrl)
  assert.equal(bypass.status, 423)
  assert.equal(
    (await bypass.json() as { error: { code: string } }).error.code,
    'QUALITY_CHECK_REQUIRED',
  )
  const bypassHead = await fetch(downloadUrl, { method: 'HEAD' })
  assert.equal(bypassHead.status, 423)
  const genericAssetBypass = await fetch(
    `${baseUrl}/api/v1/assets/${asset.id}/content`,
  )
  assert.equal(genericAssetBypass.status, 423)
  assert.equal(
    (await genericAssetBypass.json() as { error: { code: string } }).error.code,
    'EXPORT_QC_GATE_REQUIRED',
  )

  const missingKey = await fetch(`${baseUrl}/api/v1/exports/quality-http-export/quality-checks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(missingKey.status, 400)
  assert.equal((await missingKey.json() as { error: { code: string } }).error.code, 'IDEMPOTENCY_KEY_REQUIRED')

  const submitted = await fetch(`${baseUrl}/api/v1/exports/quality-http-export/quality-checks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'quality-http-once' },
    body: '{}',
  })
  assert.equal(submitted.status, 202)
  const body = await submitted.json() as { qualityReport: { id: string }; job: { id: string } }
  const durableQualityJob = runtime.database.getGenerationJob(body.job.id)
  assert.equal(durableQualityJob?.input.timelineRevisionId, timelineRevisionId)
  assert.equal(durableQualityJob?.input.storyRevisionId, storyRevisionId)
  await runtime.worker.waitForIdle()

  const fetched = await fetch(`${baseUrl}/api/v1/quality-reports/${body.qualityReport.id}`)
  assert.equal(fetched.status, 200)
  const result = await fetched.json() as {
    qualityReport: {
      status: string
      passed: boolean
      outputAssetId: string
      checks: QualityCheckResult[]
      jobStatus: string
    }
  }
  assert.equal(result.qualityReport.status, 'passed')
  assert.equal(result.qualityReport.passed, true)
  assert.equal(result.qualityReport.outputAssetId, asset.id)
  assert.equal(result.qualityReport.checks.length, 7)
  assert.deepEqual(result.qualityReport.checks.slice(-2).map((item) => [item.id, item.status]), [
    ['subtitle.timing', 'skipped'],
    ['subtitle.safe-area', 'skipped'],
  ])
  assert.equal(result.qualityReport.jobStatus, 'succeeded')

  const download = await fetch(downloadUrl)
  assert.equal(download.status, 200)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), MP4)
  const head = await fetch(downloadUrl, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(MP4.length))
  const ranged = await fetch(downloadUrl, { headers: { range: 'bytes=0-3' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), `bytes 0-3/${MP4.length}`)
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), MP4.subarray(0, 4))
  // The generic asset route remains unavailable even after QC, otherwise an
  // asset shared by multiple exports could inherit another export's report.
  const genericAssetAfterQc = await fetch(
    `${baseUrl}/api/v1/assets/${asset.id}/content`,
  )
  assert.equal(genericAssetAfterQc.status, 423)

  // The gate recomputes the binding from authoritative export/asset state;
  // changing any pinned identity invalidates the previously passing report.
  const originalChecksum = asset.checksum!
  runtime.database.withSql((sql) => sql.run(
    'UPDATE media_assets SET checksum = ? WHERE id = ?',
    '0'.repeat(64),
    asset.id,
  ))
  const wrongChecksum = await fetch(downloadUrl)
  assert.equal(wrongChecksum.status, 409)
  assert.equal(
    (await wrongChecksum.json() as { error: { code: string } }).error.code,
    'ASSET_BINDING_CONFLICT',
  )
  runtime.database.withSql((sql) => sql.run(
    'UPDATE media_assets SET checksum = ? WHERE id = ?',
    originalChecksum,
    asset.id,
  ))

  const nextTimeline = runtime.timelineDocumentService.saveReconciled({
    projectId: project.id,
    episodeId,
    expectedRevisionId: timeline.revision.id,
    schemaVersion: timeline.revision.schemaVersion,
    upstreamCommit: timeline.revision.upstreamCommit,
    sourceRevisionId: storyRevisionId,
    document: timeline.document,
  })
  runtime.database.withSql((sql) => sql.run(
    'UPDATE exports SET timeline_document_revision_id = ? WHERE id = ?',
    nextTimeline.revision.id,
    'quality-http-export',
  ))
  const wrongTimelineRevision = await fetch(downloadUrl)
  assert.equal(wrongTimelineRevision.status, 409)
  assert.equal(
    (await wrongTimelineRevision.json() as { error: { code: string } }).error.code,
    'ASSET_BINDING_CONFLICT',
  )
  runtime.database.withSql((sql) => sql.run(
    'UPDATE exports SET timeline_document_revision_id = ? WHERE id = ?',
    timelineRevisionId,
    'quality-http-export',
  ))

  runtime.database.createRevision({
    id: 'quality-http-new-story',
    projectId: project.id,
    summary: 'new story revision',
    snapshot: {},
    createdAt: NOW,
  })
  runtime.database.withSql((sql) => sql.run(`
    UPDATE exports
       SET timeline_snapshot_json = json_set(
         timeline_snapshot_json,
         '$.storyRevisionId',
         'quality-http-new-story'
       )
     WHERE id = 'quality-http-export'
  `))
  const wrongStoryRevision = await fetch(downloadUrl)
  assert.equal(wrongStoryRevision.status, 409)
  assert.equal(
    (await wrongStoryRevision.json() as { error: { code: string } }).error.code,
    'ASSET_BINDING_CONFLICT',
  )
  runtime.database.withSql((sql) => sql.run(`
    UPDATE exports
       SET timeline_snapshot_json = json_set(timeline_snapshot_json, '$.storyRevisionId', ?)
     WHERE id = 'quality-http-export'
  `, storyRevisionId))

  runtime.database.withSql((sql) => sql.run(`
    UPDATE quality_reports SET status = 'stale', passed = 0 WHERE id = ?
  `, body.qualityReport.id))
  const stale = await fetch(downloadUrl)
  assert.equal(stale.status, 409)
  assert.equal(
    (await stale.json() as { error: { code: string } }).error.code,
    'QUALITY_REPORT_STALE',
  )
  runtime.database.withSql((sql) => sql.run(`
    UPDATE quality_reports SET status = 'failed', passed = 0 WHERE id = ?
  `, body.qualityReport.id))
  const failed = await fetch(downloadUrl)
  assert.equal(failed.status, 423)
  assert.equal(
    (await failed.json() as { error: { code: string } }).error.code,
    'QUALITY_CHECK_FAILED',
  )
  runtime.database.withSql((sql) => sql.run(`
    UPDATE quality_reports SET status = 'passed', passed = 0 WHERE id = ?
  `, body.qualityReport.id))
  const inconsistentPass = await fetch(downloadUrl)
  assert.equal(inconsistentPass.status, 409)
  assert.equal(
    (await inconsistentPass.json() as { error: { code: string } }).error.code,
    'QUALITY_STATE_CONFLICT',
  )
  runtime.database.withSql((sql) => sql.run(`
    UPDATE quality_reports SET status = 'passed', passed = 1 WHERE id = ?
  `, body.qualityReport.id))

  // A newer queued report supersedes an older passing one. Only the newest
  // report may release the file.
  const latest = runtime.qualityCheckService.create({
    exportId: 'quality-http-export',
    idempotencyKey: 'quality-http-latest',
  })
  const latestPending = await fetch(downloadUrl)
  assert.equal(latestPending.status, 423)
  assert.equal(
    (await latestPending.json() as { error: { code: string } }).error.code,
    'QUALITY_CHECK_PENDING',
  )
  runtime.worker.enqueue(latest.job.id)
  await runtime.worker.waitForIdle()
  const latestPassed = await fetch(downloadUrl)
  assert.equal(latestPassed.status, 200)
  assert.deepEqual(Buffer.from(await latestPassed.arrayBuffer()), MP4)

  // A new export has its own gate. An older report for another export is
  // never reused, even when the immutable revisions happen to be the same.
  const replacementAsset = await runtime.mediaStore.save({
    id: 'quality-http-reexport-asset',
    projectId: project.id,
    episodeId,
    kind: 'export.video',
    bytes: Buffer.from('0000ftypisom-quality-check-reexport'),
    mimeType: 'video/mp4',
    source: 'renderer',
    sourceRevisionId: storyRevisionId,
    generationParameters: { timelineRevisionId, storyRevisionId },
  })
  runtime.database.withSql((sql) => sql.run(`
    INSERT INTO exports (
      id, project_id, episode_id, status, timeline_snapshot_json,
      output_asset_id, specification_json, created_at, updated_at, completed_at,
      timeline_document_revision_id
    )
    SELECT 'quality-http-reexport', project_id, episode_id, 'succeeded',
           timeline_snapshot_json, ?, specification_json, ?, ?, ?,
           timeline_document_revision_id
      FROM exports WHERE id = 'quality-http-export'
  `, replacementAsset.id, NOW, NOW, NOW))
  const reexportWithoutQc = await fetch(
    `${baseUrl}/api/v1/exports/quality-http-reexport/download`,
  )
  assert.equal(reexportWithoutQc.status, 423)
  assert.equal(
    (await reexportWithoutQc.json() as { error: { code: string } }).error.code,
    'QUALITY_CHECK_REQUIRED',
  )

  const duplicate = await fetch(`${baseUrl}/api/v1/exports/quality-http-export/quality-checks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'quality-http-once' },
    body: '{}',
  })
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json() as { qualityReport: { id: string } }).qualityReport.id, body.qualityReport.id)
})
