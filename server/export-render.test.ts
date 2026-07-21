import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { parseCanonicalTimelineDocument } from '../apps/opencut-editor/src/canonical-timeline-codec.js'
import {
  renderSemanticPlanBoundarySignature,
} from '../apps/opencut-editor/src/render-semantic-plan.js'
import { createApplication, type ApplicationRuntime } from './app-v1.js'
import { initializeDatabase, type ManjuDatabase } from './database.js'
import { versionTokenFromEtag } from './episode-version.js'
import {
  createExportRenderJobHandler,
  EXPORT_RENDER_JOB_TYPE,
  ExportRenderError,
  ExportRenderService,
  REVIEW_WATERMARK_TEXT,
  summarizeFfmpegStderr,
  subtitlesAsAss,
} from './export-render.js'
import {
  createFfmpegRenderer,
  FfmpegRenderError,
  resolutionDimensions,
  type FfmpegRenderRequest,
  type FfmpegRenderResult,
  type ProcessRunRequest,
  type ProcessRunResult,
  type RenderProcessRunner,
  type RenderAspectRatio,
} from './ffmpeg-renderer.js'
import { MediaStore } from './media.js'
import {
  currentMediaAuthority,
  mediaAuthorityFingerprint,
  timelineMediaAuthorityReceipt,
} from './media-authority.js'
import { ProjectService } from './projects.js'
import { SQLiteJobRepository } from './repositories.js'
import { StoryRepository } from './story-repository.js'
import { ShotMediaReviewService } from './shot-media-review.js'
import {
  SQLiteTimelineAutoEditRepository,
  TimelineAutoEditError,
  TimelineAutoEditService,
  type TimelineAutoEditPlanner,
} from './timeline-auto-edit.js'
import { TimelineMaterializationService } from './timeline-materialization.js'
import {
  SQLiteTimelineDocumentRepository,
  TimelineDocumentService,
} from './timeline-documents.js'
import type { JsonObject } from './types.js'
import { JobExecutionError, JobWorker } from './worker.js'

const OPEN_CUT_COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'
const SECOND = 120_000
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const MP4 = Buffer.from('0000ftypisom-real-export-test')
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01])
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

function validStory() {
  return {
    version: 1 as const,
    title: '导出测试剧本',
    targetDurationSeconds: 30,
    bible: { logline: '一段测试故事', theme: '测试', tone: '平静', visualStyle: '国风动画' },
    characters: [{
      id: 'hero', name: '主角', role: '主角', storyDescription: '测试人物', visualDescription: '黑发',
    }],
    locations: [{
      id: 'room', name: '房间', storyDescription: '测试地点', visualDescription: '暖色灯光',
    }],
    props: [],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '场景一',
      locationId: 'room',
      timeOfDay: '白天',
      description: '测试场景',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `镜头 ${index + 1}`,
        description: '主角看向窗外',
        framing: '中景',
        movement: '固定',
        transition: '硬切',
        durationSeconds: 5,
        visualPrompt: '国风动画，暖色灯光',
        dialogueLines: index === 0 ? [{
          id: 'line-1', sequence: 0, kind: 'dialogue' as const, speaker: '主角', text: '这是固化剧本中的对白。',
        }] : [],
      })),
    }],
  }
}

function uniformScaleAnimations(
  durationTicks: number,
  fromScale = 1,
  toScale = 1.2,
): Record<string, unknown> {
  const channel = (axis: 'x' | 'y') => ({
    keys: [{
      id: `scale-${axis}-start`,
      time: 0,
      value: fromScale,
      segmentToNext: 'linear',
      tangentMode: 'flat',
    }, {
      id: `scale-${axis}-end`,
      time: durationTicks,
      value: toScale,
      segmentToNext: 'linear',
      tangentMode: 'flat',
    }],
    extrapolation: { before: 'hold', after: 'hold' },
  })
  return {
    'transform.scaleX': channel('x'),
    'transform.scaleY': channel('y'),
  }
}

interface Fixture {
  directory: string
  database: ManjuDatabase
  mediaStore: MediaStore
  timelines: TimelineDocumentService
  exports: ExportRenderService
  projectId: string
  episodeId: string
  timelineRevisionId: string
  storyRevisionId: string
  imageAssetId: string
}

async function fixture(options: {
  storyFallback?: boolean
  audio?: boolean
  aspectRatio?: RenderAspectRatio
} = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-export-test-'))
  const database = initializeDatabase({
    runtimeDirectory: directory,
    legacyStatePath: false,
    backupDirectory: false,
  })
  cleanups.push(async () => {
    database.close()
    await rm(directory, { recursive: true, force: true })
  })
  const projectId = 'export-project'
  const episodeId = 'export-episode'
  database.createProject({ id: projectId, title: '导出项目' })
  const stories = new StoryRepository(database)
  stories.ensureEpisode(projectId, {
    id: episodeId,
    title: '导出分集',
    aspectRatio: options.aspectRatio,
  })
  const applied = stories.applyStory(episodeId, validStory())
  const storyRevisionId = applied.revision.id
  const mediaStore = new MediaStore(database, { runtimeDirectory: directory })
  await mediaStore.init()
  const image = await mediaStore.save({
    id: 'storyboard-image',
    projectId,
    episodeId,
    kind: 'storyboard.image',
    bytes: PNG,
    mimeType: 'image/png',
    source: 'test',
    sourceRevisionId: storyRevisionId,
  })
  if (options.storyFallback) {
    database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = ?
       WHERE scene_id IN (SELECT id FROM scenes WHERE episode_id = ?)
    `, image.id, episodeId))
  }
  let audioAssetId: string | undefined
  if (options.audio) {
    const audio = await mediaStore.save({
      id: 'speech-audio',
      projectId,
      episodeId,
      kind: 'dialogue.speech',
      bytes: Buffer.from('RIFF0000WAVEfmt test'),
      mimeType: 'audio/wav',
      durationSeconds: 5,
      source: 'test',
      sourceRevisionId: storyRevisionId,
    })
    audioAssetId = audio.id
  }
  const timelines = new TimelineDocumentService(new SQLiteTimelineDocumentRepository(database))
  const visualParams: Record<string, string> = options.storyFallback
    ? { storyShotId: 'shot-1', storySceneId: 'scene-1' }
    : {}
  const saved = timelines.saveReconciled({
    projectId,
    episodeId,
    expectedRevisionId: null,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    sourceRevisionId: storyRevisionId,
    document: {
      version: 1,
      editor: 'OpenCut-Classic',
      ticksPerSecond: SECOND,
      tracks: {
        overlay: [
          {
            id: 'visual-main',
            type: 'video',
            elements: [{
              id: 'visual-1',
              type: 'image',
              ...(!options.storyFallback ? { mediaId: image.id } : {}),
              startTime: 0,
              duration: 30 * SECOND,
              params: visualParams,
            }],
          },
          {
            id: 'subtitles',
            type: 'text',
            elements: [{
              id: 'subtitle-1', type: 'text', startTime: 0, duration: 5 * SECOND, params: { text: '真实字幕' },
            }],
          },
        ],
        main: { id: 'main', type: 'video', elements: [] },
        audio: audioAssetId ? [{
          id: 'dialogue',
          type: 'audio',
          elements: [{
            id: 'audio-1',
            type: 'audio',
            sourceType: 'upload',
            mediaId: audioAssetId,
            startTime: 0,
            duration: 5 * SECOND,
            params: {},
          }],
        }] : [],
      },
    },
  })
  const exports = new ExportRenderService(database, timelines)
  return {
    directory,
    database,
    mediaStore,
    timelines,
    exports,
    projectId,
    episodeId,
    timelineRevisionId: saved.revision.id,
    storyRevisionId,
    imageAssetId: image.id,
  }
}

class FakeRenderer {
  readonly calls: FfmpegRenderRequest[] = []
  readonly subtitleDocuments: string[] = []

  async render(request: FfmpegRenderRequest): Promise<FfmpegRenderResult> {
    this.calls.push(request)
    if (request.timeline.subtitles) {
      this.subtitleDocuments.push(await readFile(request.timeline.subtitles.assetPath, 'utf8'))
    }
    request.signal?.throwIfAborted()
    await writeFile(request.outputPath, MP4, { flag: 'wx' })
    const dimensions = resolutionDimensions(request.resolution, request.aspectRatio)
    const frames = request.timeline.visualClips.reduce((sum, clip) => sum + clip.durationFrames, 0)
    return {
      outputPath: request.outputPath,
      timelineRevisionId: request.timeline.revisionId,
      durationSeconds: frames / 24,
      frameCount: frames,
      ...dimensions,
      probe: {
        formatName: 'mp4',
        durationSeconds: frames / 24,
        video: {
          codec: 'h264',
          ...dimensions,
          pixelFormat: 'yuv420p',
          frameRate: 24,
          frames,
        },
        audio: { codec: 'aac', sampleRate: 48_000, channels: 2 },
      },
    }
  }
}

function semanticGoldenProbe(
  width: number,
  height: number,
  frames: number,
): Buffer {
  return Buffer.from(JSON.stringify({
    streams: [{
      codec_type: 'video',
      codec_name: 'h264',
      width,
      height,
      pix_fmt: 'yuv420p',
      r_frame_rate: '24/1',
      avg_frame_rate: '24/1',
      nb_frames: String(frames),
    }, {
      codec_type: 'audio',
      codec_name: 'aac',
      sample_rate: '48000',
      channels: 2,
    }],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: String(frames / 24),
    },
  }))
}

class SemanticGoldenRunner implements RenderProcessRunner {
  readonly calls: ProcessRunRequest[] = []

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    if (request.command === '/semantic-golden/ffmpeg') {
      await writeFile(request.args.at(-1)!, MP4, { flag: 'wx' })
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    if (request.args.includes('format=duration:stream=codec_type')) {
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({
          streams: [{ codec_type: 'video' }],
          format: { duration: '8' },
        })),
        stderr: Buffer.alloc(0),
      }
    }
    return {
      exitCode: 0,
      stdout: semanticGoldenProbe(720, 1280, 240),
      stderr: Buffer.alloc(0),
    }
  }
}

class CapturingRenderer {
  readonly calls: FfmpegRenderRequest[] = []
  readonly subtitleDocuments: string[] = []
  readonly assetChecksums: Array<{ id: string; checksum: string }> = []

  constructor(private readonly delegate: { render(request: FfmpegRenderRequest): Promise<FfmpegRenderResult> }) {}

  async render(request: FfmpegRenderRequest): Promise<FfmpegRenderResult> {
    this.calls.push(request)
    if (request.timeline.subtitles) {
      this.subtitleDocuments.push(await readFile(request.timeline.subtitles.assetPath, 'utf8'))
    }
    for (const clip of [
      ...request.timeline.visualClips,
      ...(request.timeline.audioClips ?? []),
    ]) {
      this.assetChecksums.push({
        id: clip.id,
        checksum: createHash('sha256').update(await readFile(clip.assetPath)).digest('hex'),
      })
    }
    return this.delegate.render(request)
  }
}

test('ASS overlay document uses safe styles, frame timing, and escapes user control syntax', () => {
  const ass = subtitlesAsAss([
    {
      id: 'unsafe-subtitle',
      startFrame: 24,
      durationFrames: 48,
      text: '字幕 {\\p1}{\\pos(0,0)}\n下一行',
    },
  ], {
    introTitle: { startFrame: 0, durationFrames: 72, text: '剧名\n第一集' },
    outroCard: { startFrame: 648, durationFrames: 72, text: '剧名\n本集完' },
    reviewWatermark: { startFrame: 0, durationFrames: 720, text: REVIEW_WATERMARK_TEXT },
  }, '9:16')

  assert.match(ass, /ScriptType: v4\.00\+/)
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/)
  assert.match(ass, /Style: Subtitle,sans-serif,/)
  assert.match(ass, /Style: IntroTitle,sans-serif,/)
  assert.match(ass, /Style: OutroCard,sans-serif,/)
  assert.match(ass, /Style: Watermark,sans-serif,/)
  const subtitleEvent = ass.split('\n').find((line) => line.includes(',Subtitle,'))
  assert.equal(
    subtitleEvent,
    'Dialogue: 0,0:00:01.00,0:00:03.00,Subtitle,,0,0,0,,字幕 ｛＼p1｝｛＼pos(0,0)｝\\N下一行',
  )
  assert.equal(subtitleEvent?.includes('{\\'), false)
  assert.equal(subtitleEvent?.includes('\\p'), false)
  assert.equal(subtitleEvent?.includes('\\pos'), false)
  assert.match(ass, /Dialogue: 10,0:00:00\.00,0:00:03\.00,IntroTitle/)
  assert.match(ass, /Dialogue: 20,0:00:00\.00,0:00:30\.00,Watermark/)
  assert.match(ass, /\{\\fad\(300,300\)\}/)
})

test('FFmpeg stderr diagnostics redact paths and credentials before a UTF-8 byte bound', () => {
  const directory = '/private/tmp/manju/export-render-secret'
  const secret = 'sk-do-not-persist-this-secret'
  const result = summarizeFfmpegStderr([
    `failed to open ${directory}/asset-0.png`,
    `Authorization: Bearer bearer-value api_key=${secret}`,
    `https://user:password@example.invalid/input?token=provider-token`,
    'font=/Users/alice/Library/Fonts/private-font.ttf',
    'probe=C:\\Users\\alice\\private-input.mp4',
    '详情'.repeat(6_000),
  ].join('\n'), [directory])
  assert.equal(result.truncated, true)
  assert.ok(result.text)
  assert.ok(Buffer.byteLength(result.text!, 'utf8') <= 8 * 1_024)
  assert.doesNotMatch(result.text!, /private\/tmp|do-not-persist|bearer-value|password|provider-token|Users[\\/]alice/)
  assert.match(result.text!, /\[render-task\]/)
  assert.match(result.text!, /\[path\]/)
  assert.match(result.text!, /\[redacted/)
})

test('failed export Job persists bounded redacted FFmpeg evidence and removes staged bytes', async () => {
  const value = await fixture({ audio: true })
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '720p',
    idempotencyKey: 'persist-redacted-render-diagnostics',
  })
  const secret = 'sk-render-secret-must-not-survive'
  const renderer = {
    runtimeDiagnosticReceipt: () => ({
      schemaVersion: 1 as const,
      source: 'bundled-audited' as const,
      releaseEligible: true,
      audit: {
        schemaVersion: 1 as const,
        source: 'bundled-audited' as const,
        target: { platform: 'test', arch: 'test' },
        sourceVersion: '8.1.2',
        manifestSha256: '1'.repeat(64),
        verificationReceiptSha256: '2'.repeat(64),
        ffmpegSha256: '3'.repeat(64),
        ffprobeSha256: '4'.repeat(64),
      },
    }),
    async render(request: FfmpegRenderRequest): Promise<FfmpegRenderResult> {
      await writeFile(request.outputPath, Buffer.from('temporary incomplete bytes'), { flag: 'wx' })
      throw new FfmpegRenderError(
        'FFMPEG_FAILED',
        'fixture render failed',
        `input=${request.timeline.visualClips[0]!.assetPath} api_key=${secret}\n${'错误'.repeat(7_000)}`,
      )
    },
  }
  const jobs = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(jobs, {
    onEvent(event) {
      const durable = value.database.getGenerationJob(event.jobId)
      if (durable) value.exports.syncJob(durable)
    },
  })
  worker.register(EXPORT_RENDER_JOB_TYPE, createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  }))
  await worker.start()
  worker.enqueue(created.job.id)
  await worker.waitForIdle()

  const job = value.database.getGenerationJob(created.job.id)
  assert.equal(job?.status, 'failed')
  assert.equal(job?.error?.code, 'FFMPEG_FAILED')
  assert.deepEqual((await jobs.get(created.job.id))?.error, job?.error)
  const diagnostics = job?.error?.diagnostics as JsonObject
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostics), 'utf8') < 32 * 1_024)
  assert.equal(diagnostics.category, 'internal')
  assert.equal(diagnostics.stderrTruncated, true)
  const stderr = String(diagnostics.stderr)
  assert.ok(Buffer.byteLength(stderr, 'utf8') <= 8 * 1_024)
  assert.doesNotMatch(stderr, /render-secret|export-render-|asset-0\.png/)
  assert.match(stderr, /\[render-task\]/)
  const runtimeReceipt = diagnostics.runtimeReceipt as JsonObject
  assert.equal(runtimeReceipt.source, 'bundled-audited')
  const inputPins = diagnostics.inputPins as JsonObject
  assert.equal(inputPins.timelineRevisionId, value.timelineRevisionId)
  assert.equal(inputPins.storyRevisionId, value.storyRevisionId)
  assert.equal(inputPins.assetPinCount, 2)
  assert.equal(Array.isArray(inputPins.assetPins), true)
  assert.deepEqual(value.exports.require(created.export.id).error, job?.error)
  assert.deepEqual(
    (await readdir(value.directory)).filter((name) => name.startsWith('export-render-')),
    [],
  )
  await worker.stop()
})

test('pins immutable timeline/story revisions, aspect ratio, and asset IDs with strict idempotency', async () => {
  const value = await fixture({ audio: true, aspectRatio: '9:16' })
  value.database.withSql((sql) => sql.run(
    'UPDATE episodes SET title = ? WHERE id = ?',
    '导出分集',
    value.episodeId,
  ))
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '1080p',
    kenBurns: true,
    burnSubtitles: true,
    introTitle: true,
    outroCard: true,
    reviewWatermark: true,
    idempotencyKey: 'export-once',
  })
  assert.equal(created.created, true)
  assert.equal(created.job.providerId, null)
  assert.equal(created.job.model, null)
  assert.equal(created.job.providerConfigRevision, null)
  assert.equal(created.job.input.timelineRevisionId, value.timelineRevisionId)
  assert.equal(created.job.input.storyRevisionId, value.storyRevisionId)
  assert.equal(created.export.timelineRevisionId, value.timelineRevisionId)
  assert.equal(created.export.specification.aspectRatio, '9:16')
  assert.equal(created.export.timelineSnapshot.storyRevisionId, value.storyRevisionId)
  assert.equal(created.export.timelineSnapshot.visualClips[0].assetId, value.imageAssetId)
  assert.equal(created.export.timelineSnapshot.audioClips[0].assetId, 'speech-audio')
  assert.equal(created.export.timelineSnapshot.audioClips[0].audioRole, 'dialogue')
  assert.equal('fadeInSeconds' in created.export.timelineSnapshot.audioClips[0], false)
  assert.equal('fadeOutSeconds' in created.export.timelineSnapshot.audioClips[0], false)
  assert.equal(created.export.timelineSnapshot.subtitleCues[0].text, '真实字幕')
  assert.deepEqual(created.export.timelineSnapshot.branding, {
    introTitle: {
      startFrame: 0,
      durationFrames: 72,
      text: '导出测试剧本\n导出分集',
    },
    outroCard: {
      startFrame: 648,
      durationFrames: 72,
      text: '导出测试剧本\n导出分集 · 本集完',
    },
    reviewWatermark: {
      startFrame: 0,
      durationFrames: 720,
      text: REVIEW_WATERMARK_TEXT,
    },
  })
  assert.equal(created.export.specification.introTitle, true)
  assert.equal(created.export.specification.outroCard, true)
  assert.equal(created.export.specification.reviewWatermark, true)
  assert.doesNotMatch(JSON.stringify(created.export.timelineSnapshot), /filePath|assetPath|manju-export-test-/)

  const duplicate = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '1080p',
    kenBurns: true,
    burnSubtitles: true,
    introTitle: true,
    outroCard: true,
    reviewWatermark: true,
    idempotencyKey: 'export-once',
  })
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.export.id, created.export.id)
  assert.equal(duplicate.job.id, created.job.id)

  assert.throws(
    () => value.exports.create({
      projectId: value.projectId,
      episodeId: value.episodeId,
      timelineRevisionId: value.timelineRevisionId,
      resolution: '1080p',
      kenBurns: true,
      burnSubtitles: true,
      introTitle: true,
      outroCard: true,
      reviewWatermark: false,
      idempotencyKey: 'export-once',
    }),
    (error: unknown) => error instanceof ExportRenderError && error.code === 'IDEMPOTENCY_CONFLICT',
  )

  assert.throws(
    () => value.exports.create({
      projectId: value.projectId,
      episodeId: value.episodeId,
      timelineRevisionId: value.timelineRevisionId,
      resolution: '720p',
      idempotencyKey: 'export-once',
    }),
    (error: unknown) => error instanceof ExportRenderError && error.code === 'IDEMPOTENCY_CONFLICT',
  )

  const changedStory = validStory()
  changedStory.title = '后来的剧名'
  value.database.withSql((sql) => sql.run(
    'UPDATE episodes SET title = ? WHERE id = ?',
    '后来的分集名',
    value.episodeId,
  ))
  new StoryRepository(value.database).applyStory(value.episodeId, changedStory)
  const restarted = new ExportRenderService(value.database, value.timelines)
    .require(created.export.id)
  assert.deepEqual(restarted.timelineSnapshot.branding, created.export.timelineSnapshot.branding)
  const staleDuplicate = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '1080p',
    kenBurns: true,
    burnSubtitles: true,
    introTitle: true,
    outroCard: true,
    reviewWatermark: true,
    idempotencyKey: 'export-once',
  })
  assert.equal(staleDuplicate.created, false)
  assert.equal(staleDuplicate.export.status, 'stale')
})

test('binds export child jobs to an exact matching Pipeline Run and fails closed on reuse', async () => {
  const value = await fixture()
  const pipeline = value.database.createPipelineRun({
    id: 'export-pipeline',
    projectId: value.projectId,
    episodeId: value.episodeId,
  })
  const base = {
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '720p' as const,
    idempotencyKey: 'pipeline-export-once',
  }
  const created = value.exports.create({ ...base, pipelineRunId: pipeline.id })
  assert.equal(created.job.pipelineRunId, pipeline.id)
  assert.equal(value.database.getGenerationJob(created.job.id)?.pipelineRunId, pipeline.id)

  const duplicate = value.exports.create({ ...base, pipelineRunId: pipeline.id })
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.job.id, created.job.id)
  assert.throws(
    () => value.exports.create(base),
    (error: unknown) => error instanceof ExportRenderError
      && error.code === 'IDEMPOTENCY_CONFLICT',
  )
  const secondPipeline = value.database.createPipelineRun({
    id: 'export-pipeline-second',
    projectId: value.projectId,
    episodeId: value.episodeId,
  })
  assert.throws(
    () => value.exports.create({ ...base, pipelineRunId: secondPipeline.id }),
    (error: unknown) => error instanceof ExportRenderError
      && error.code === 'IDEMPOTENCY_CONFLICT',
  )

  const otherEpisode = new StoryRepository(value.database).ensureEpisode(value.projectId, {
    id: 'export-other-episode',
    title: '其他分集',
  })
  const mismatched = value.database.createPipelineRun({
    id: 'export-pipeline-wrong-episode',
    projectId: value.projectId,
    episodeId: otherEpisode.id,
  })
  assert.throws(
    () => value.exports.create({
      ...base,
      pipelineRunId: mismatched.id,
      idempotencyKey: 'pipeline-export-wrong-episode',
    }),
    (error: unknown) => error instanceof ExportRenderError
      && error.code === 'PIPELINE_RUN_MISMATCH',
  )
  assert.throws(
    () => value.exports.create({
      ...base,
      pipelineRunId: 'missing-export-pipeline',
      idempotencyKey: 'pipeline-export-missing',
    }),
    (error: unknown) => error instanceof ExportRenderError
      && error.code === 'PIPELINE_RUN_NOT_FOUND',
  )
})

test('pins canonical BGM/SFX roles and infers managed dialogue from immutable assets', async () => {
  const value = await fixture({ audio: true })
  const assets = await Promise.all([
    value.mediaStore.save({
      id: 'uploaded-bgm',
      projectId: value.projectId,
      episodeId: value.episodeId,
      kind: 'bgm',
      bytes: Buffer.from('RIFF0000WAVEfmt bgm'),
      mimeType: 'audio/wav',
      durationSeconds: 30,
      source: 'upload',
      sourceRevisionId: value.storyRevisionId,
    }),
    value.mediaStore.save({
      id: 'uploaded-sfx',
      projectId: value.projectId,
      episodeId: value.episodeId,
      kind: 'sfx',
      bytes: Buffer.from('RIFF0000WAVEfmt sfx'),
      mimeType: 'audio/wav',
      durationSeconds: 1,
      source: 'upload',
      sourceRevisionId: value.storyRevisionId,
    }),
    value.mediaStore.save({
      id: 'historical-dialogue',
      projectId: value.projectId,
      episodeId: value.episodeId,
      kind: 'uploaded.audio',
      bytes: Buffer.from('RIFF0000WAVEfmt historical dialogue'),
      mimeType: 'audio/wav',
      durationSeconds: 1,
      source: 'upload',
      sourceRevisionId: value.storyRevisionId,
    }),
    value.mediaStore.save({
      id: 'legacy-generic-audio',
      projectId: value.projectId,
      episodeId: value.episodeId,
      kind: 'uploaded.audio',
      bytes: Buffer.from('RIFF0000WAVEfmt legacy audio'),
      mimeType: 'audio/wav',
      durationSeconds: 1,
      source: 'upload',
      sourceRevisionId: value.storyRevisionId,
    }),
  ])
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const audioTracks = tracks.audio as Array<Record<string, unknown>>
  const elements = [
    {
      id: 'bgm-1', type: 'audio', sourceType: 'upload', mediaId: assets[0].id,
      startTime: 0, duration: 30 * SECOND, params: { audioRole: 'bgm', volume: 0.65 },
    },
    {
      id: 'sfx-1', type: 'audio', sourceType: 'upload', mediaId: assets[1].id,
      startTime: SECOND, duration: SECOND, params: { audioRole: 'sfx' },
    },
    {
      id: 'old-dialogue-1', type: 'audio', sourceType: 'upload', mediaId: assets[2].id,
      startTime: 5 * SECOND, duration: SECOND, params: { storyDialogueLineId: 'historical-line-1' },
    },
    {
      id: 'legacy-generic-1', type: 'audio', sourceType: 'upload', mediaId: assets[3].id,
      startTime: 6 * SECOND, duration: SECOND, params: { audioRole: 'sfx' },
    },
  ]
  elements.forEach((element, index) => audioTracks.push({
    id: `audio-role-${index + 1}`,
    type: 'audio',
    elements: [element],
  }))
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })

  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: saved.revision.id,
    resolution: '720p',
    idempotencyKey: 'pinned-audio-roles',
  })
  const roles = new Map(created.export.timelineSnapshot.audioClips.map((clip) => (
    [clip.id, clip.audioRole] as const
  )))
  assert.equal(roles.get('audio-1'), 'dialogue')
  assert.equal(roles.get('bgm-1'), 'bgm')
  assert.equal(roles.get('sfx-1'), 'sfx')
  assert.equal(roles.get('old-dialogue-1'), 'dialogue')
  assert.equal(roles.get('legacy-generic-1'), 'sfx')
})

test('shared RenderSemanticPlan is the pinned server export authority for visuals, audio, ducking, and adjacent subtitles', async () => {
  const value = await fixture({ audio: true, aspectRatio: '9:16' })
  const [video, bgm] = await Promise.all([
    value.mediaStore.save({
      id: 'semantic-video',
      projectId: value.projectId,
      episodeId: value.episodeId,
      kind: 'shot.video',
      bytes: WEBM,
      mimeType: 'video/webm',
      durationSeconds: 8,
      source: 'seedance',
      sourceRevisionId: value.storyRevisionId,
    }),
    value.mediaStore.save({
      id: 'semantic-bgm',
      projectId: value.projectId,
      episodeId: value.episodeId,
      kind: 'bgm',
      bytes: Buffer.from('RIFF0000WAVEfmt semantic bgm'),
      mimeType: 'audio/wav',
      durationSeconds: 10,
      source: 'upload',
      sourceRevisionId: value.storyRevisionId,
    }),
  ])
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const overlay = tracks.overlay as Array<Record<string, unknown>>
  const visualTrack = overlay.find((track) => track.type === 'video')!
  visualTrack.elements = [{
    id: 'semantic-image', type: 'image', mediaId: value.imageAssetId,
    startTime: 0, duration: 5 * SECOND, params: { fit: 'cover' },
  }, {
    id: 'semantic-video-clip', type: 'video', mediaId: video.id,
    isSourceAudioEnabled: false,
    startTime: 5 * SECOND, duration: 5 * SECOND,
    trimStart: SECOND, sourceDuration: 8 * SECOND,
    params: { fit: 'contain' },
  }]
  const dialogueTrack = (tracks.audio as Array<Record<string, unknown>>)[0]
  dialogueTrack.elements = [{
    id: 'semantic-dialogue', type: 'audio', sourceType: 'upload', mediaId: 'speech-audio',
    startTime: 2 * SECOND, duration: 2 * SECOND,
    params: { dialogueLineId: 'line-1' },
  }]
  ;(tracks.audio as Array<Record<string, unknown>>).push({
    id: 'semantic-bgm-track', type: 'audio', elements: [{
      id: 'semantic-bgm-clip', type: 'audio', sourceType: 'upload', mediaId: bgm.id,
      startTime: 0, duration: 10 * SECOND,
      params: { audioRole: 'bgm', volume: 0.4, fadeInSeconds: 0.5, fadeOutSeconds: 1 },
    }],
  })
  const subtitleTrack = overlay.find((track) => track.type === 'text')!
  subtitleTrack.elements = [{
    id: 'semantic-subtitle-a', type: 'text', name: '甲',
    startTime: 0, duration: SECOND, params: { text: '甲' },
  }, {
    id: 'semantic-subtitle-b', type: 'text', name: '乙',
    startTime: SECOND, duration: SECOND, params: { text: '乙' },
  }]
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })

  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: saved.revision.id,
    resolution: '720p',
    burnSubtitles: true,
    idempotencyKey: 'semantic-plan-authority',
  })
  const plan = created.export.timelineSnapshot.semanticPlan
  assert.ok(plan)
  const canonicalBoundarySignature = renderSemanticPlanBoundarySignature(plan)
  assert.equal(created.export.timelineSnapshot.version, 3)
  assert.equal(plan.timelineDocumentId, saved.timelineDocument.id)
  assert.equal(plan.timelineRevisionId, saved.revision.id)
  assert.equal(plan.storyRevisionId, value.storyRevisionId)
  assert.equal(plan.aspectRatio, '9:16')
  assert.equal(plan.totalFrames, 240)
  assert.deepEqual(plan.visualClips.map((clip) => ({
    id: clip.id,
    fit: clip.fit,
    sourceTrim: clip.sourceTrim,
  })), [{
    id: 'semantic-image', fit: 'cover', sourceTrim: null,
  }, {
    id: 'semantic-video-clip', fit: 'contain', sourceTrim: {
      startFrame: 24,
      durationFrames: 120,
      endTrimFrames: 48,
      sourceDurationFrames: 192,
    },
  }])
  assert.equal(plan.visualClips[0].asset.version, 1)
  assert.equal(plan.visualClips[0].asset.checksum, value.database.getMediaAsset(value.imageAssetId)?.checksum)
  const plannedBgm = plan.audioClips.find((clip) => clip.id === 'semantic-bgm-clip')!
  assert.equal(plannedBgm.linearGain, 0.4)
  assert.equal(plannedBgm.fadeInSeconds, 0.5)
  assert.equal(plannedBgm.fadeOutSeconds, 1)
  assert.equal(plannedBgm.role, 'bgm')
  assert.deepEqual(plannedBgm.duckingWindows, [{
    triggerAudioClipIds: ['semantic-dialogue'],
    startFrame: 48,
    endFrameExclusive: 96,
    duckedLinearGain: 0.35,
    attackSeconds: 0.12,
    releaseSeconds: 0.12,
  }])
  assert.deepEqual(plan.subtitleCues.map((cue) => ({
    id: cue.id,
    startFrame: cue.startFrame,
    durationFrames: cue.durationFrames,
    endFrameExclusive: cue.endFrameExclusive,
  })), [{
    id: 'semantic-subtitle-a', startFrame: 0, durationFrames: 24, endFrameExclusive: 24,
  }, {
    id: 'semantic-subtitle-b', startFrame: 24, durationFrames: 24, endFrameExclusive: 48,
  }])

  const runner = new SemanticGoldenRunner()
  const renderer = new CapturingRenderer(createFfmpegRenderer({
    ffmpegPath: '/semantic-golden/ffmpeg',
    ffprobePath: '/semantic-golden/ffprobe',
    runner,
  }))
  const handler = createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  })
  await handler({
    id: created.job.id,
    type: EXPORT_RENDER_JOB_TYPE,
    status: 'running',
    projectId: value.projectId,
    input: { exportId: created.export.id },
  }, {
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    waitingForProvider: async () => undefined,
  })
  const renderedBgm = renderer.calls[0].timeline.audioClips?.find((clip) => (
    clip.id === 'semantic-bgm-clip'
  ))
  assert.deepEqual(renderedBgm?.duckingWindows, plannedBgm.duckingWindows)
  assert.equal(renderer.calls[0].timeline.visualClips[0].fit, 'cover')
  assert.equal(renderer.calls[0].timeline.visualClips[1].fit, 'contain')

  assert.equal(
    createHash('sha256').update(canonicalBoundarySignature).digest('hex'),
    'a01213b7f7748e11629f051e86d62d094d6858d21861a9622a5b5cb8f665c071',
  )

  const renderedChecksums = new Map(renderer.assetChecksums.map((entry) => [entry.id, entry.checksum]))
  for (const clip of [...plan.visualClips, ...plan.audioClips]) {
    assert.equal(
      renderedChecksums.get(clip.id),
      clip.asset.checksum,
      `FFmpeg staged bytes for ${clip.id} must match the plan pin`,
    )
  }
  assert.deepEqual(renderer.subtitleDocuments, [
    '1\n00:00:00,000 --> 00:00:01,000\n甲\n\n'
      + '2\n00:00:01,000 --> 00:00:02,000\n乙\n',
  ])

  const ffmpegCall = runner.calls.find((call) => call.command === '/semantic-golden/ffmpeg')
  assert.ok(ffmpegCall)
  const graph = ffmpegCall.args[ffmpegCall.args.indexOf('-filter_complex') + 1]
  assert.match(
    graph,
    /\[0:v\]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280[^;]+trim=end_frame=120/,
  )
  assert.match(
    graph,
    /\[1:v\]trim=start=1:duration=5[^;]+force_original_aspect_ratio=decrease,pad=720:1280[^;]+trim=end_frame=120/,
  )
  assert.match(graph, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[vbase\]/)
  assert.match(graph, /subtitles=filename='subtitles\.srt'/)
  assert.match(graph, /atrim=start=0:duration=10[^;]+afade=t=in:st=0:d=0\.5/)
  assert.match(graph, /afade=t=out:st=9:d=1[^;]+volume=0\.4[^;]+eval=frame/)
  assert.match(graph, /atrim=start=0:duration=2[^;]+volume=1,adelay=96000S:all=1/)
  assert.match(graph, /amix=inputs=2:duration=longest/)
  assert.equal(ffmpegCall.args[ffmpegCall.args.indexOf('-frames:v') + 1], '240')
  assert.equal(ffmpegCall.args[ffmpegCall.args.lastIndexOf('-t') + 1], '10')
})

test('persists supported scale motion, opacity fade, and inverted shape mask through the worker', async () => {
  const value = await fixture()
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const visualTrack = (tracks.overlay as Array<Record<string, unknown>>)
    .find((track) => track.type === 'video')!
  const visual = (visualTrack.elements as Array<Record<string, unknown>>)[0]
  visual.animations = {
    ...uniformScaleAnimations(30 * SECOND),
    opacity: {
      keys: [{
        id: 'opacity-fade-start',
        time: 0,
        value: 0,
        segmentToNext: 'linear',
        tangentMode: 'flat',
      }, {
        id: 'opacity-fade-end',
        time: 12 * (SECOND / 24),
        value: 1,
        segmentToNext: 'linear',
        tangentMode: 'flat',
      }],
      extrapolation: { before: 'hold', after: 'hold' },
    },
  }
  visual.masks = [{
    id: 'ellipse-mask',
    type: 'ellipse',
    params: {
      feather: 0,
      inverted: true,
      strokeColor: '#ffffff',
      strokeWidth: 0,
      strokeAlign: 'center',
      centerX: 0.125,
      centerY: -0.25,
      width: 0.5,
      height: 0.75,
      rotation: 0,
      scale: 1,
    },
  }]
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })

  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: saved.revision.id,
    resolution: '720p',
    idempotencyKey: 'supported-visual-composition-worker',
  })
  const expectedOpacityFade = {
    version: 1 as const,
    fadeIn: { startFrame: 0, durationFrames: 12 },
    fadeOut: null,
  }
  const expectedShapeMask = {
    version: 2 as const,
    type: 'ellipse' as const,
    inverted: true,
    centerX: 0.125,
    centerY: -0.25,
    width: 0.5,
    height: 0.75,
  }
  const expectedUniformScaleMotion = {
    version: 1 as const,
    startFrame: 0 as const,
    durationFrames: 720,
    fromScale: 1,
    toScale: 1.2,
    anchorX: 0.5 as const,
    anchorY: 0.5 as const,
  }
  const persisted = value.exports.require(created.export.id)
  assert.equal(persisted.timelineSnapshot.semanticPlan?.version, 5)
  assert.deepEqual(persisted.timelineSnapshot.semanticPlan?.visualClips[0].opacityFade, expectedOpacityFade)
  assert.deepEqual(persisted.timelineSnapshot.semanticPlan?.visualClips[0].shapeMask, expectedShapeMask)
  assert.deepEqual(
    persisted.timelineSnapshot.semanticPlan?.visualClips[0].uniformScaleMotion,
    expectedUniformScaleMotion,
  )

  const renderer = new FakeRenderer()
  const jobs = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(jobs, {
    concurrency: 1,
    resourceConcurrency: { 'renderer:ffmpeg': 1 },
    onEvent(event) {
      const durable = value.database.getGenerationJob(event.jobId)
      if (durable) value.exports.syncJob(durable)
    },
  })
  worker.register(EXPORT_RENDER_JOB_TYPE, createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  }), { resourceKey: () => 'renderer:ffmpeg' })
  await worker.start()
  worker.enqueue(created.job.id)
  await worker.waitForIdle()

  assert.equal(value.database.getGenerationJob(created.job.id)?.status, 'succeeded')
  assert.equal(value.exports.require(created.export.id).status, 'succeeded')
  assert.equal(renderer.calls.length, 1)
  assert.deepEqual(renderer.calls[0].timeline.visualClips[0].opacityFade, expectedOpacityFade)
  assert.deepEqual(renderer.calls[0].timeline.visualClips[0].shapeMask, expectedShapeMask)
  assert.deepEqual(
    renderer.calls[0].timeline.visualClips[0].uniformScaleMotion,
    expectedUniformScaleMotion,
  )
  await worker.stop()
})

test('ExportService rejects legacy kenBurns when the timeline already owns uniform scale motion', async () => {
  const value = await fixture()
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const visualTrack = (tracks.overlay as Array<Record<string, unknown>>)
    .find((track) => track.type === 'video')!
  const visual = (visualTrack.elements as Array<Record<string, unknown>>)[0]
  visual.animations = uniformScaleAnimations(30 * SECOND)
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })
  const exportsBefore = value.database.withSql((sql) => Number(sql.get(
    'SELECT COUNT(*) AS total FROM exports WHERE project_id = ?',
    value.projectId,
  )?.total ?? 0))
  const jobsBefore = value.database.listGenerationJobs({ projectId: value.projectId }).length

  assert.throws(() => value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: saved.revision.id,
    resolution: '720p',
    kenBurns: true,
    idempotencyKey: 'reject-double-scale-motion',
  }), (error: unknown) => error instanceof ExportRenderError
    && error.code === 'UNSUPPORTED_TIMELINE'
    && /Ken Burns/.test(error.message))

  assert.equal(value.database.withSql((sql) => Number(sql.get(
    'SELECT COUNT(*) AS total FROM exports WHERE project_id = ?',
    value.projectId,
  )?.total ?? 0)), exportsBefore)
  assert.equal(
    value.database.listGenerationJobs({ projectId: value.projectId }).length,
    jobsBefore,
  )
})

test('worker rejects forged v1-v3 semantic plans carrying v4 uniform scale motion', async () => {
  const value = await fixture()
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '720p',
    idempotencyKey: 'forged-v3-scale-motion',
  })
  const snapshot = structuredClone(created.export.timelineSnapshot) as unknown as {
    semanticPlan: {
      version: number
      visualClips: Array<Record<string, unknown>>
    }
  }
  snapshot.semanticPlan.visualClips[0].uniformScaleMotion = {
    version: 1,
    startFrame: 0,
    durationFrames: 720,
    fromScale: 1,
    toScale: 1.2,
    anchorX: 0.5,
    anchorY: 0.5,
  }
  const renderer = new FakeRenderer()
  const handler = createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  })

  for (const version of [1, 2, 3]) {
    snapshot.semanticPlan.version = version
    value.database.withSql((sql) => sql.run(
      'UPDATE exports SET timeline_snapshot_json = ? WHERE id = ?',
      JSON.stringify(snapshot),
      created.export.id,
    ))
    await assert.rejects(() => handler({
      id: created.job.id,
      type: EXPORT_RENDER_JOB_TYPE,
      status: 'running',
      projectId: value.projectId,
      input: { exportId: created.export.id },
    }, {
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
      waitingForProvider: async () => undefined,
    }), (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'INVALID_TIMELINE'
      && 'message' in error
      && typeof error.message === 'string'
      && new RegExp(`v${version}`).test(error.message)
    ), `RSP v${version}`)
  }
  assert.equal(renderer.calls.length, 0)
})

test('worker rejects shape-mask polarity receipts that do not match the RSP version', async () => {
  const value = await fixture()
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '720p',
    idempotencyKey: 'forged-shape-mask-polarity-version',
  })
  const original = structuredClone(created.export.timelineSnapshot) as unknown as {
    semanticPlan: {
      version: number
      visualClips: Array<Record<string, unknown>>
    }
  }
  const renderer = new FakeRenderer()
  const handler = createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  })
  const cases = [{
    name: 'v4-with-v2-mask',
    version: 4,
    shapeMask: {
      version: 2, type: 'rectangle', inverted: true,
      centerX: 0, centerY: 0, width: 0.5, height: 0.5,
    },
    message: /v4.*反向形状遮罩/,
  }, {
    name: 'v5-with-v1-mask',
    version: 5,
    shapeMask: {
      version: 1, type: 'rectangle',
      centerX: 0, centerY: 0, width: 0.5, height: 0.5,
    },
    message: /v5.*v2 极性/,
  }, {
    name: 'v5-with-missing-polarity',
    version: 5,
    shapeMask: {
      version: 2, type: 'rectangle',
      centerX: 0, centerY: 0, width: 0.5, height: 0.5,
    },
    message: /v5.*v2 极性/,
  }]

  for (const invalid of cases) {
    const snapshot = structuredClone(original)
    snapshot.semanticPlan.version = invalid.version
    snapshot.semanticPlan.visualClips[0]!.shapeMask = invalid.shapeMask
    value.database.withSql((sql) => sql.run(
      'UPDATE exports SET timeline_snapshot_json = ? WHERE id = ?',
      JSON.stringify(snapshot),
      created.export.id,
    ))
    await assert.rejects(() => handler({
      id: created.job.id,
      type: EXPORT_RENDER_JOB_TYPE,
      status: 'running',
      projectId: value.projectId,
      input: { exportId: created.export.id },
    }, {
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
      waitingForProvider: async () => undefined,
    }), (error: unknown) => error instanceof JobExecutionError
      && error.code === 'INVALID_TIMELINE'
      && invalid.message.test(error.message), invalid.name)
  }
  assert.equal(renderer.calls.length, 0)
})

test('worker replays a persisted RSP v3 with legacy Ken Burns when no timeline motion exists', async () => {
  const value = await fixture()
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '720p',
    kenBurns: true,
    idempotencyKey: 'persisted-v3-legacy-ken-burns',
  })
  const snapshot = structuredClone(created.export.timelineSnapshot) as unknown as {
    semanticPlan: { version: number }
  }
  snapshot.semanticPlan.version = 3
  value.database.withSql((sql) => sql.run(
    'UPDATE exports SET timeline_snapshot_json = ? WHERE id = ?',
    JSON.stringify(snapshot),
    created.export.id,
  ))
  const renderer = new FakeRenderer()
  const handler = createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  })

  await handler({
    id: created.job.id,
    type: EXPORT_RENDER_JOB_TYPE,
    status: 'running',
    projectId: value.projectId,
    input: { exportId: created.export.id },
  }, {
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    waitingForProvider: async () => undefined,
  })

  assert.equal(renderer.calls.length, 1)
  assert.equal(renderer.calls[0].timeline.visualClips[0].kenBurns, true)
  assert.equal(renderer.calls[0].timeline.visualClips[0].uniformScaleMotion, undefined)
})

test('unknown visual animations and masks fail closed before durable export creation', async () => {
  const cases: Array<{
    name: string
    mutate(visual: Record<string, unknown>): void
    message: RegExp
  }> = [{
    name: 'unknown-animation',
    mutate(visual) {
      visual.animations = { position: { keys: [] } }
    },
    message: /animations/,
  }, {
    name: 'unknown-mask',
    mutate(visual) {
      visual.masks = [{ id: 'polygon-mask', type: 'polygon', params: {} }]
    },
    message: /masks/,
  }]

  for (const invalid of cases) {
    const value = await fixture()
    const current = value.timelines.get(value.episodeId)
    const document = structuredClone(current.document)
    const tracks = document.tracks as Record<string, unknown>
    const visualTrack = (tracks.overlay as Array<Record<string, unknown>>)
      .find((track) => track.type === 'video')!
    invalid.mutate((visualTrack.elements as Array<Record<string, unknown>>)[0])
    const saved = value.timelines.save({
      projectId: value.projectId,
      episodeId: value.episodeId,
      expectedRevisionId: current.revision.id,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_COMMIT,
      document,
    })
    const exportsBefore = value.database.withSql((sql) => Number(sql.get(
      'SELECT COUNT(*) AS total FROM exports WHERE project_id = ?',
      value.projectId,
    )?.total ?? 0))
    const jobsBefore = value.database.listGenerationJobs({ projectId: value.projectId }).length

    assert.throws(() => value.exports.create({
      projectId: value.projectId,
      episodeId: value.episodeId,
      timelineRevisionId: saved.revision.id,
      resolution: '720p',
      idempotencyKey: `unsupported-visual-${invalid.name}`,
    }), (error: unknown) => error instanceof ExportRenderError
      && error.code === 'UNSUPPORTED_TIMELINE'
      && invalid.message.test(error.message), invalid.name)

    assert.equal(value.database.withSql((sql) => Number(sql.get(
      'SELECT COUNT(*) AS total FROM exports WHERE project_id = ?',
      value.projectId,
    )?.total ?? 0)), exportsBefore, `${invalid.name} must not create an export row`)
    assert.equal(
      value.database.listGenerationJobs({ projectId: value.projectId }).length,
      jobsBefore,
      `${invalid.name} must not create a generation job`,
    )
  }
})

test('worker fails closed when a staged asset no longer matches the semantic plan version pin', async () => {
  const value = await fixture()
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '720p',
    idempotencyKey: 'semantic-asset-pin-drift',
  })
  value.database.withSql((sql) => sql.run(
    'UPDATE media_assets SET version = version + 1 WHERE id = ?',
    value.imageAssetId,
  ))
  const renderer = new FakeRenderer()
  const handler = createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  })
  await assert.rejects(() => handler({
    id: created.job.id,
    type: EXPORT_RENDER_JOB_TYPE,
    status: 'running',
    projectId: value.projectId,
    input: { exportId: created.export.id },
  }, {
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    waitingForProvider: async () => undefined,
  }), (error: unknown) => (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ASSET_NOT_READY'
  ))
  assert.equal(renderer.calls.length, 0)
})

test('shared semantic compiler rejects visual params that formal export cannot render', async () => {
  const value = await fixture()
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const visualTrack = (tracks.overlay as Array<Record<string, unknown>>)
    .find((track) => track.type === 'video')!
  const visual = (visualTrack.elements as Array<Record<string, unknown>>)[0]
  visual.params = { fit: 'cover', providerUrl: 'https://untrusted.invalid/media.png' }
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })
  assert.throws(() => value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: saved.revision.id,
    resolution: '720p',
    idempotencyKey: 'semantic-unsupported-param',
  }), (error: unknown) => error instanceof ExportRenderError
    && error.code === 'UNSUPPORTED_TIMELINE'
    && /providerUrl/.test(error.message))
})

test('rejects unknown or conflicting canonical audioRole before creating an export', async () => {
  const invalidRoles: Array<{ name: string; audioRole: unknown }> = [
    { name: 'unknown', audioRole: 'music' },
    { name: 'wrong-type', audioRole: 1 },
    { name: 'dialogue-conflict', audioRole: 'bgm' },
  ]
  for (const invalid of invalidRoles) {
    const value = await fixture({ audio: true })
    const current = value.timelines.get(value.episodeId)
    const document = structuredClone(current.document)
    const tracks = document.tracks as Record<string, unknown>
    const audioTracks = tracks.audio as Array<Record<string, unknown>>
    const audioElements = audioTracks[0].elements as Array<Record<string, unknown>>
    audioElements[0].params = { audioRole: invalid.audioRole }
    const saved = value.timelines.save({
      projectId: value.projectId,
      episodeId: value.episodeId,
      expectedRevisionId: current.revision.id,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_COMMIT,
      document,
    })
    assert.throws(
      () => value.exports.create({
        projectId: value.projectId,
        episodeId: value.episodeId,
        timelineRevisionId: saved.revision.id,
        resolution: '720p',
        idempotencyKey: `invalid-audio-role-${invalid.name}`,
      }),
      (error: unknown) => error instanceof ExportRenderError
        && error.code === 'INVALID_TIMELINE'
        && /audioRole/.test(error.message),
      invalid.name,
    )
  }
})

test('projects hidden and muted OpenCut content before resolving export assets', async () => {
  const value = await fixture({ audio: true })
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const overlay = tracks.overlay as Array<Record<string, unknown>>
  const hiddenTrack = overlay[0]
  hiddenTrack.hidden = true
  hiddenTrack.muted = false
  ;(hiddenTrack.elements as Array<Record<string, unknown>>)[0].mediaId = 'missing-hidden-track'

  const main = tracks.main as Record<string, unknown>
  main.hidden = false
  main.muted = false
  main.elements = [
    {
      id: 'hidden-main-element',
      type: 'image',
      mediaId: 'missing-hidden-element',
      hidden: true,
      startTime: 0,
      duration: 30 * SECOND,
      params: {},
    },
    {
      id: 'visible-main-element',
      type: 'image',
      mediaId: value.imageAssetId,
      startTime: 0,
      duration: 30 * SECOND,
      params: {},
    },
  ]
  const audio = tracks.audio as Array<Record<string, unknown>>
  audio[0].muted = true
  ;(audio[0].elements as Array<Record<string, unknown>>)[0].mediaId = 'missing-muted-audio'

  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: saved.revision.id,
    resolution: '720p',
    idempotencyKey: 'hidden-muted-projection',
  })

  assert.deepEqual(created.export.timelineSnapshot.visualClips.map((clip) => clip.id), [
    'visible-main-element',
  ])
  assert.deepEqual(created.export.timelineSnapshot.audioClips, [])
})

test('pins explicitly enabled video source audio and allows canonical project-global media', async () => {
  const value = await fixture()
  const video = await value.mediaStore.save({
    id: 'global-video-with-source-audio',
    projectId: value.projectId,
    kind: 'shot.video',
    bytes: WEBM,
    mimeType: 'video/webm',
    source: 'test',
    sourceRevisionId: value.storyRevisionId,
    durationSeconds: 40,
  })
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const overlay = tracks.overlay as Array<Record<string, unknown>>
  const visualTrack = overlay[0]
  visualTrack.hidden = false
  visualTrack.muted = false
  visualTrack.elements = [{
    id: 'source-video',
    type: 'video',
    mediaId: video.id,
    isSourceAudioEnabled: true,
    startTime: 0,
    duration: 30 * SECOND,
    trimStart: 2 * SECOND,
    trimEnd: 0,
    params: { volume: 0.75, audioRole: 'sfx' },
  }]
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })
  const audible = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: saved.revision.id,
    resolution: '720p',
    idempotencyKey: 'source-video-audio',
  })
  assert.equal(audible.export.timelineSnapshot.visualClips[0].assetId, video.id)
  assert.deepEqual(audible.export.timelineSnapshot.audioClips, [{
    id: 'source-video:source-audio',
    startFrame: 0,
    durationFrames: 720,
    assetId: video.id,
    sourceStartSeconds: 2,
    volume: 0.75,
    audioRole: 'sfx',
  }])

  visualTrack.muted = true
  ;(visualTrack.elements as Array<Record<string, unknown>>)[0].params = {}
  const muted = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: saved.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })
  const mutedExport = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: muted.revision.id,
    resolution: '720p',
    idempotencyKey: 'muted-source-video-audio',
  })
  assert.deepEqual(mutedExport.export.timelineSnapshot.audioClips, [])
})

test('fails closed for visible composition features and audio retime', async () => {
  const visual = await fixture()
  const visualCurrent = visual.timelines.get(visual.episodeId)
  const visualDocument = structuredClone(visualCurrent.document)
  const visualTracks = visualDocument.tracks as Record<string, unknown>
  const visualOverlay = visualTracks.overlay as Array<Record<string, unknown>>
  const visualElements = visualOverlay[0].elements as Array<Record<string, unknown>>
  visualElements[0].effects = [{ type: 'unsupported-effect' }]
  const visualSaved = visual.timelines.save({
    projectId: visual.projectId,
    episodeId: visual.episodeId,
    expectedRevisionId: visualCurrent.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document: visualDocument,
  })
  assert.throws(() => visual.exports.create({
    projectId: visual.projectId,
    episodeId: visual.episodeId,
    timelineRevisionId: visualSaved.revision.id,
    resolution: '720p',
    idempotencyKey: 'unsupported-visible-effect',
  }), (error: unknown) => error instanceof ExportRenderError
    && error.code === 'UNSUPPORTED_TIMELINE')

  const audio = await fixture({ audio: true })
  const audioCurrent = audio.timelines.get(audio.episodeId)
  const audioDocument = structuredClone(audioCurrent.document)
  const audioTracks = audioDocument.tracks as Record<string, unknown>
  const timelineAudio = audioTracks.audio as Array<Record<string, unknown>>
  const audioElements = timelineAudio[0].elements as Array<Record<string, unknown>>
  audioElements[0].retime = { rate: 1.25 }
  const audioSaved = audio.timelines.save({
    projectId: audio.projectId,
    episodeId: audio.episodeId,
    expectedRevisionId: audioCurrent.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document: audioDocument,
  })
  assert.throws(() => audio.exports.create({
    projectId: audio.projectId,
    episodeId: audio.episodeId,
    timelineRevisionId: audioSaved.revision.id,
    resolution: '720p',
    idempotencyKey: 'unsupported-audio-retime',
  }), (error: unknown) => error instanceof ExportRenderError
    && error.code === 'UNSUPPORTED_TIMELINE')
})

test('rejects malformed or overlapping canonical audio fades before creating an export', async () => {
  const invalidParams: Array<{ name: string; params: Record<string, unknown> }> = [
    { name: 'negative', params: { fadeInSeconds: -0.1 } },
    { name: 'wrong-type', params: { fadeOutSeconds: '0.5' } },
    { name: 'longer-than-clip', params: { fadeOutSeconds: 5.001 } },
    { name: 'overlapping', params: { fadeInSeconds: 2.5, fadeOutSeconds: 2.501 } },
  ]

  for (const invalid of invalidParams) {
    const value = await fixture({ audio: true })
    const current = value.timelines.get(value.episodeId)
    const document = structuredClone(current.document)
    const tracks = document.tracks as Record<string, unknown>
    const audioTracks = tracks.audio as Array<Record<string, unknown>>
    const audioElements = audioTracks[0].elements as Array<Record<string, unknown>>
    audioElements[0].params = invalid.params
    const saved = value.timelines.save({
      projectId: value.projectId,
      episodeId: value.episodeId,
      expectedRevisionId: current.revision.id,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_COMMIT,
      document,
    })

    assert.throws(
      () => value.exports.create({
        projectId: value.projectId,
        episodeId: value.episodeId,
        timelineRevisionId: saved.revision.id,
        resolution: '720p',
        idempotencyKey: `invalid-audio-fade-${invalid.name}`,
      }),
      (error: unknown) => error instanceof ExportRenderError
        && error.code === 'INVALID_TIMELINE',
      invalid.name,
    )
  }
})

test('allows an explicit historical immutable revision but rejects a stale If-Match head', async () => {
  const value = await fixture()
  const current = value.timelines.get(value.episodeId)
  const accepted = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedTimelineRevisionId: current.revision.id,
    resolution: '720p',
    idempotencyKey: 'accepted-before-head-moved',
  })
  const updated = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document: { ...current.document, futureField: '保留' },
  })
  assert.notEqual(updated.revision.id, value.timelineRevisionId)

  const retried = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedTimelineRevisionId: current.revision.id,
    resolution: '720p',
    idempotencyKey: 'accepted-before-head-moved',
  })
  assert.equal(retried.created, false)
  assert.equal(retried.export.id, accepted.export.id)

  const historical = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '720p',
    idempotencyKey: 'historical',
  })
  assert.equal(historical.export.timelineRevisionId, value.timelineRevisionId)

  assert.throws(
    () => value.exports.create({
      projectId: value.projectId,
      episodeId: value.episodeId,
      expectedTimelineRevisionId: value.timelineRevisionId,
      resolution: '720p',
      idempotencyKey: 'stale-head',
    }),
    (error: unknown) => error instanceof ExportRenderError
      && error.code === 'TIMELINE_REVISION_CONFLICT',
  )
})

test('reviewed media requires a durable trusted reconcile receipt before any new export job', async () => {
  const value = await fixture({ storyFallback: true })
  const shot = value.database.withSql((sql) => sql.get(`
    SELECT shots.id
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
     WHERE scenes.episode_id = ?
       AND json_extract(shots.metadata_json, '$.storyId') = 'shot-1'
  `, value.episodeId))
  assert.equal(typeof shot?.id, 'string')
  const databaseShotId = shot!.id as string
  const saveCandidate = async (suffix: 'a' | 'b') => {
    const jobId = `authority-storyboard-job-${suffix}`
    const assetId = `authority-storyboard-${suffix}`
    value.database.createGenerationJob({
      id: jobId,
      projectId: value.projectId,
      episodeId: value.episodeId,
      type: 'asset.image.generate',
      status: 'succeeded',
      progress: 100,
      input: {
        count: 1,
        metadata: { kind: 'storyboard' },
        storyboardBinding: {
          episodeId: value.episodeId,
          shotId: 'shot-1',
          sceneId: 'scene-1',
          databaseShotId,
          expectedRevisionId: value.storyRevisionId,
        },
      },
      completedAt: `2026-07-15T0${suffix === 'a' ? '1' : '2'}:00:00.000Z`,
    })
    return value.mediaStore.save({
      id: assetId,
      projectId: value.projectId,
      episodeId: value.episodeId,
      kind: 'storyboard',
      bytes: PNG,
      mimeType: 'image/png',
      source: 'provider',
      generationJobId: jobId,
      sourceRevisionId: value.storyRevisionId,
      generationParameters: {
        shotId: 'shot-1',
        sceneId: 'scene-1',
        sourceRevisionId: value.storyRevisionId,
      },
    })
  }
  const storyboardA = await saveCandidate('a')
  const storyboardB = await saveCandidate('b')
  value.database.withSql((sql) => sql.run(`
    UPDATE shots SET storyboard_asset_id = ? WHERE id = ?
  `, storyboardA.id, databaseShotId))

  // Precompute and inject the exact hash that will become current after the
  // future review. A JSON-only trust boundary would incorrectly bless it.
  value.database.withSql((sql) => sql.run(`
    UPDATE shots SET storyboard_asset_id = ? WHERE id = ?
  `, storyboardB.id, databaseShotId))
  const futureFingerprint = currentMediaAuthority(value.database, {
    projectId: value.projectId,
    episodeId: value.episodeId,
  }).fingerprint
  value.database.withSql((sql) => sql.run(`
    UPDATE shots SET storyboard_asset_id = ? WHERE id = ?
  `, storyboardA.id, databaseShotId))

  const initial = value.timelines.get(value.episodeId)
  const forgedDocument = structuredClone(initial.document)
  forgedDocument.manjuTimeline = {
    mediaAuthorityFingerprint: futureFingerprint,
  }
  const forgedBeforeSelection = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: initial.revision.id,
    schemaVersion: initial.revision.schemaVersion,
    upstreamCommit: initial.revision.upstreamCommit,
    document: forgedDocument,
  })
  assert.equal(mediaAuthorityFingerprint(forgedBeforeSelection.document), null)
  assert.equal(
    timelineMediaAuthorityReceipt(value.database, forgedBeforeSelection.revision.id),
    null,
  )

  const reviews = new ShotMediaReviewService(value.database)
  const listed = reviews.list({
    projectId: value.projectId,
    episodeId: value.episodeId,
    shotId: 'shot-1',
    sceneId: 'scene-1',
    mediaType: 'storyboard',
  })
  reviews.decide({
    projectId: value.projectId,
    episodeId: value.episodeId,
    shotId: 'shot-1',
    sceneId: 'scene-1',
    mediaType: 'storyboard',
    decision: 'adopt',
    assetId: storyboardB.id,
    expectedEpisodeVersion: versionTokenFromEtag(listed.episodeEtag)!,
    idempotencyKey: 'authority-adopt-b',
  })
  const injectedAgain = structuredClone(forgedBeforeSelection.document)
  injectedAgain.manjuTimeline = { mediaAuthorityFingerprint: futureFingerprint }
  const afterSelectionAutosave = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: forgedBeforeSelection.revision.id,
    schemaVersion: forgedBeforeSelection.revision.schemaVersion,
    upstreamCommit: forgedBeforeSelection.revision.upstreamCommit,
    document: injectedAgain,
  })
  const exportJobsBefore = value.database.withSql((sql) => sql.all(`
    SELECT id FROM generation_jobs WHERE type = 'export.render'
  `)).length
  assert.throws(() => value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: afterSelectionAutosave.revision.id,
    resolution: '720p',
    idempotencyKey: 'authority-before-reconcile',
  }), (error: unknown) => error instanceof ExportRenderError
    && error.code === 'TIMELINE_MEDIA_RECONCILIATION_REQUIRED')
  assert.equal(value.database.withSql((sql) => sql.all(`
    SELECT id FROM generation_jobs WHERE type = 'export.render'
  `)).length, exportJobsBefore)

  const materialization = new TimelineMaterializationService(
    value.database,
    new StoryRepository(value.database),
    value.timelines,
  )
  const reconciled = materialization.reconcile({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: afterSelectionAutosave.revision.id,
  })
  assert.equal(mediaAuthorityFingerprint(reconciled.document), futureFingerprint)
  assert.equal(
    timelineMediaAuthorityReceipt(value.database, reconciled.revision.id)?.fingerprint,
    futureFingerprint,
  )
  const autoPlanner: TimelineAutoEditPlanner = {
    preview({ base }) {
      const document = structuredClone(base.document)
      return {
        sourceRevisionId: base.revision.sourceRevisionId,
        schemaVersion: base.revision.schemaVersion,
        upstreamCommit: base.revision.upstreamCommit,
        strategy: 'managed-dialogue-reflow-v1',
        executor: 'OpenCut-Classic/UpdateElementsCommand',
        planHash: 'a'.repeat(64),
        risk: 'safe',
        diagnostics: [{
          code: 'SAFE_TIMING_ONLY',
          severity: 'warning',
          message: '仅应用服务端验证的时间调整',
          elementIds: ['story-scene-1-shot-1'],
        }],
        operations: [{
          kind: 'update-element-timing',
          trackId: 'visual-main',
          elementId: 'story-scene-1-shot-1',
          reason: 'extend-managed-visual-tail',
          before: { startTime: 0, duration: 600_000, trimStart: 0, trimEnd: 0 },
          after: { startTime: 0, duration: 600_000, trimStart: 0, trimEnd: 0 },
        }],
        changedElementIds: ['story-scene-1-shot-1'],
        document,
      }
    },
  }
  const autoIds = ['authority-plan-1', 'authority-application-1', 'authority-plan-2']
  let autoTick = 0
  const autoEdits = new TimelineAutoEditService(
    value.database,
    value.timelines,
    new SQLiteTimelineAutoEditRepository(value.database),
    autoPlanner,
    {
      idFactory: () => autoIds.shift() ?? 'unexpected-authority-auto-edit-id',
      tokenFactory: () => `taec_${'r'.repeat(40)}`,
      now: () => `2026-07-15T05:00:0${autoTick++}.000Z`,
    },
  )
  const autoPreview = autoEdits.preview({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: reconciled.revision.id,
    goal: 'exportable',
    policy: 'safe',
  })
  const autoApplied = autoEdits.apply({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: reconciled.revision.id,
    idempotencyKey: 'authority-auto-apply',
    planId: autoPreview.plan.id,
    confirmationToken: autoPreview.plan.confirmationToken,
  })
  assert.equal(
    timelineMediaAuthorityReceipt(value.database, autoApplied.timeline.revision.id)?.fingerprint,
    futureFingerprint,
  )
  const accepted = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: autoApplied.timeline.revision.id,
    resolution: '720p',
    idempotencyKey: 'authority-after-reconcile',
  })
  assert.equal(accepted.created, true)

  // Even a benign ordinary autosave is not allowed to copy authority. The
  // mounted client must flush and then perform another trusted reconcile.
  const ordinaryAfterReconcile = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: autoApplied.timeline.revision.id,
    schemaVersion: autoApplied.timeline.revision.schemaVersion,
    upstreamCommit: autoApplied.timeline.revision.upstreamCommit,
    document: { ...autoApplied.timeline.document, editorState: { zoom: 1.25 } },
  })
  assert.equal(mediaAuthorityFingerprint(ordinaryAfterReconcile.document), null)
  assert.throws(() => value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: ordinaryAfterReconcile.revision.id,
    resolution: '720p',
    idempotencyKey: 'authority-after-ordinary-save',
  }), (error: unknown) => error instanceof ExportRenderError
    && error.code === 'TIMELINE_MEDIA_RECONCILIATION_REQUIRED')
  const reconciledAgain = materialization.reconcile({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: ordinaryAfterReconcile.revision.id,
  })
  assert.ok(timelineMediaAuthorityReceipt(value.database, reconciledAgain.revision.id))
  const acceptedAgain = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: reconciledAgain.revision.id,
    resolution: '720p',
    idempotencyKey: 'authority-after-second-reconcile',
  })
  assert.equal(acceptedAgain.created, true)

  const driftPreview = autoEdits.preview({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: reconciledAgain.revision.id,
    goal: 'exportable',
    policy: 'safe',
  })
  const storyboardReview = reviews.list({
    projectId: value.projectId,
    episodeId: value.episodeId,
    shotId: 'shot-1',
    sceneId: 'scene-1',
    mediaType: 'storyboard',
  })
  reviews.decide({
    projectId: value.projectId,
    episodeId: value.episodeId,
    shotId: 'shot-1',
    sceneId: 'scene-1',
    mediaType: 'storyboard',
    decision: 'restore',
    assetId: storyboardA.id,
    expectedEpisodeVersion: versionTokenFromEtag(storyboardReview.episodeEtag)!,
    idempotencyKey: 'authority-restore-a-after-preview',
  })
  const acceptedReplayAfterSelectionDrift = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: reconciledAgain.revision.id,
    resolution: '720p',
    idempotencyKey: 'authority-after-second-reconcile',
  })
  assert.equal(acceptedReplayAfterSelectionDrift.created, false)
  assert.equal(acceptedReplayAfterSelectionDrift.export.id, acceptedAgain.export.id)
  assert.throws(() => value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: reconciledAgain.revision.id,
    resolution: '720p',
    idempotencyKey: 'authority-new-export-after-selection-drift',
  }), (error: unknown) => error instanceof ExportRenderError
    && error.code === 'TIMELINE_MEDIA_RECONCILIATION_REQUIRED')
  assert.throws(() => autoEdits.apply({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: reconciledAgain.revision.id,
    idempotencyKey: 'authority-apply-after-selection-drift',
    planId: driftPreview.plan.id,
    confirmationToken: driftPreview.plan.confirmationToken,
  }), (error: unknown) => error instanceof TimelineAutoEditError
    && error.code === 'TIMELINE_MEDIA_RECONCILIATION_REQUIRED')
  assert.equal(value.timelines.get(value.episodeId).revision.id, reconciledAgain.revision.id)
})

test('fails clearly for missing or incompatible visual assets instead of accepting paths or silently dropping clips', async () => {
  const value = await fixture()
  const current = value.timelines.get(value.episodeId)
  const invalidDocument = structuredClone(current.document)
  const tracks = invalidDocument.tracks as Record<string, unknown>
  const overlay = tracks.overlay as Array<Record<string, unknown>>
  const elements = overlay[0].elements as Array<Record<string, unknown>>
  elements[0].mediaId = 'missing-image'
  elements[0].params = { assetId: value.imageAssetId, assetPath: '/tmp/client-controlled.png' }
  const invalid = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document: invalidDocument,
  })
  assert.throws(
    () => value.exports.create({
      projectId: value.projectId,
      episodeId: value.episodeId,
      timelineRevisionId: invalid.revision.id,
      resolution: '720p',
      idempotencyKey: 'missing-asset',
    }),
    (error: unknown) => error instanceof ExportRenderError && error.code === 'ASSET_NOT_FOUND',
  )

  const audio = await value.mediaStore.save({
    id: 'not-an-image',
    projectId: value.projectId,
    episodeId: value.episodeId,
    kind: 'dialogue.speech',
    bytes: Buffer.from('RIFF0000WAVEfmt test'),
    mimeType: 'audio/wav',
    durationSeconds: 5,
    source: 'test',
    sourceRevisionId: value.storyRevisionId,
  })
  elements[0].mediaId = audio.id
  const invalidType = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: invalid.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document: invalidDocument,
  })
  assert.throws(
    () => value.exports.create({
      projectId: value.projectId,
      episodeId: value.episodeId,
      timelineRevisionId: invalidType.revision.id,
      resolution: '720p',
      idempotencyKey: 'wrong-asset-type',
    }),
    (error: unknown) => error instanceof ExportRenderError
      && error.code === 'UNSUPPORTED_VISUAL_ASSET',
  )
})

test('rejects an incomplete immutable snapshot instead of consulting the current shots relation', async () => {
  const value = await fixture({ storyFallback: true })
  assert.throws(
    () => value.exports.create({
      projectId: value.projectId,
      episodeId: value.episodeId,
      timelineRevisionId: value.timelineRevisionId,
      resolution: '720p',
      idempotencyKey: 'incomplete-snapshot',
    }),
    (error: unknown) => error instanceof ExportRenderError
      && error.code === 'ASSET_NOT_FOUND'
      && /mediaId/.test(error.message),
  )
})

test('rejects conflicting library/upload audio fields through the shared canonical parser', async () => {
  const value = await fixture({ audio: true })
  const current = value.timelines.get(value.episodeId)
  const document = parseCanonicalTimelineDocument(current.document) as unknown as JsonObject
  const tracks = document.tracks as Record<string, unknown>
  const audioTracks = tracks.audio as Array<Record<string, unknown>>
  const elements = audioTracks[0].elements as Array<Record<string, unknown>>
  elements[0].sourceType = 'library'
  elements[0].sourceUrl = 'https://library.invalid/audio.mp3'
  // The migrated upload mediaId deliberately remains to prove the union is
  // rejected rather than resolved with mediaId precedence.
  const conflicting = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 2,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })

  assert.throws(
    () => value.exports.create({
      projectId: value.projectId,
      episodeId: value.episodeId,
      timelineRevisionId: conflicting.revision.id,
      resolution: '720p',
      idempotencyKey: 'conflicting-audio-source',
    }),
    (error: unknown) => error instanceof ExportRenderError
      && error.code === 'INVALID_TIMELINE'
      && /mediaId.*absent.*library audio/.test(error.message),
  )
})

test('burnSubtitles does not invent Story dialogue cues absent from the shared timeline plan', async () => {
  const value = await fixture({ audio: true })
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const overlay = tracks.overlay as Array<Record<string, unknown>>
  tracks.overlay = overlay.filter((track) => track.type !== 'text') as never
  const audioTracks = tracks.audio as Array<Record<string, unknown>>
  const audioElements = audioTracks[0].elements as Array<Record<string, unknown>>
  audioElements[0].mediaId = 'speech-audio'
  audioElements[0].params = { dialogueLineId: 'line-1' }
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: saved.revision.id,
    resolution: '720p',
    burnSubtitles: true,
    idempotencyKey: 'story-subtitles',
  })
  assert.deepEqual(created.export.timelineSnapshot.subtitleCues, [])
  assert.deepEqual(created.export.timelineSnapshot.semanticPlan?.subtitleCues, [])
})

test('burnSubtitles does not bypass the shared plan with provider word metadata', async () => {
  const value = await fixture({ audio: true })
  value.database.withSql((sql) => sql.run(`
    UPDATE media_assets
       SET generation_parameters_json = ?
     WHERE id = 'speech-audio'
  `, JSON.stringify({
    lineId: 'line-1',
    subtitle: {
      mode: 'word',
      granularity: 'word',
      cues: [
        { text: '这是', startMs: 500, endMs: 1_000 },
        { text: '固化', startMs: 1_000, endMs: 1_500 },
        { text: '裁掉', startMs: 2_500, endMs: 3_000 },
      ],
    },
  })))
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  tracks.overlay = (tracks.overlay as Array<Record<string, unknown>>)
    .filter((track) => track.type !== 'text') as never
  const audioTrack = (tracks.audio as Array<Record<string, unknown>>)[0]
  const audioElement = (audioTrack.elements as Array<Record<string, unknown>>)[0]
  audioElement.mediaId = 'speech-audio'
  audioElement.startTime = 2 * SECOND
  audioElement.duration = 2 * SECOND
  audioElement.trimStart = SECOND / 2
  audioElement.params = {
    dialogueLineId: 'line-1',
    storySceneId: 'scene-1',
    storyShotId: 'shot-1',
  }
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })

  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: saved.revision.id,
    resolution: '720p',
    burnSubtitles: true,
    idempotencyKey: 'word-subtitles',
  })
  assert.deepEqual(created.export.timelineSnapshot.subtitleCues, [])
})

test('managed and free text cues render exactly as compiled without implicit dialogue overlays', async () => {
  const value = await fixture({ audio: true })
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const audioTrack = (tracks.audio as Array<Record<string, unknown>>)[0]
  const audioElements = audioTrack.elements as Array<Record<string, unknown>>
  audioElements[0].params = {
    dialogueLineId: 'line-1',
    storySceneId: 'scene-1',
    storyShotId: 'shot-1',
  }
  audioElements.push({
    ...structuredClone(audioElements[0]),
    id: 'audio-2',
    startTime: 5 * SECOND,
  })

  const subtitleTrack = (tracks.overlay as Array<Record<string, unknown>>)
    .find((track) => track.type === 'text')!
  subtitleTrack.elements = [{
    id: 'managed-cue-1',
    type: 'text',
    name: '人工校订',
    startTime: 0,
    duration: SECOND,
    params: {
      content: '人工校订',
      text: '人工校订',
      manjuRole: 'speech-subtitle',
      dialogueLineId: 'line-1',
      storySceneId: 'scene-1',
      storyShotId: 'shot-1',
      speechAssetId: 'speech-audio',
      sourceAudioElementId: 'audio-1',
      subtitleCueSetId: 'cue-set-1',
      sourceCueIndex: 0,
    },
    manju: {
      subtitleCue: {
        version: 1,
        cueSetId: 'cue-set-1',
        dialogueLineId: 'line-1',
        storySceneId: 'scene-1',
        storyShotId: 'shot-1',
        speechAssetId: 'speech-audio',
        sourceAudioElementId: 'audio-1',
        sourceCueIndex: 0,
        sourceStartMs: 0,
        sourceEndMs: 1_000,
        sourceAudioStartTime: 0,
        sourceAudioTrimStart: 0,
        sourceAudioDuration: 5 * SECOND,
      },
    },
  }, {
    id: 'free-title',
    type: 'text',
    name: '自由文本',
    startTime: 10 * SECOND,
    duration: SECOND,
    params: { text: '自由文本' },
  }]
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })

  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: saved.revision.id,
    resolution: '720p',
    burnSubtitles: true,
    idempotencyKey: 'managed-subtitles-merge',
  })
  assert.deepEqual(created.export.timelineSnapshot.subtitleCues, [{
    id: 'managed-cue-1',
    startFrame: 0,
    durationFrames: 24,
    text: '人工校订',
  }, {
    id: 'free-title',
    startFrame: 240,
    durationFrames: 24,
    text: '自由文本',
  }])
})

test('managed subtitle provenance fails closed after the bound speech asset is regenerated', async () => {
  const value = await fixture({ audio: true })
  const replacement = await value.mediaStore.save({
    id: 'replacement-speech',
    projectId: value.projectId,
    episodeId: value.episodeId,
    kind: 'speech',
    bytes: Buffer.from('RIFF0000WAVEfmt replacement'),
    mimeType: 'audio/wav',
    durationSeconds: 5,
    source: 'test',
    sourceRevisionId: value.storyRevisionId,
  })
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const audioElement = (((tracks.audio as Array<Record<string, unknown>>)[0]
    .elements as Array<Record<string, unknown>>)[0])
  audioElement.mediaId = replacement.id
  audioElement.params = {
    dialogueLineId: 'line-1', storySceneId: 'scene-1', storyShotId: 'shot-1',
  }
  const subtitleTrack = (tracks.overlay as Array<Record<string, unknown>>)
    .find((track) => track.type === 'text')!
  subtitleTrack.elements = [{
    id: 'stale-managed-cue', type: 'text', name: '旧字幕', startTime: 0, duration: SECOND,
    params: {
      content: '旧字幕', text: '旧字幕', manjuRole: 'speech-subtitle',
      dialogueLineId: 'line-1', storySceneId: 'scene-1', storyShotId: 'shot-1',
      speechAssetId: 'speech-audio', sourceAudioElementId: 'audio-1',
      subtitleCueSetId: 'stale-set', sourceCueIndex: 0,
    },
    manju: { subtitleCue: {
      version: 1, cueSetId: 'stale-set', dialogueLineId: 'line-1',
      storySceneId: 'scene-1', storyShotId: 'shot-1', speechAssetId: 'speech-audio',
      sourceAudioElementId: 'audio-1', sourceCueIndex: 0, sourceStartMs: 0,
      sourceEndMs: 1_000, sourceAudioStartTime: 0, sourceAudioTrimStart: 0,
      sourceAudioDuration: 5 * SECOND,
    } },
  }]
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })
  assert.throws(
    () => value.exports.create({
      projectId: value.projectId,
      episodeId: value.episodeId,
      timelineRevisionId: saved.revision.id,
      resolution: '720p',
      burnSubtitles: true,
      idempotencyKey: 'stale-managed-speech',
    }),
    (error: unknown) => error instanceof ExportRenderError
      && error.code === 'INVALID_TIMELINE'
      && /语音资产已变化/.test(error.message),
  )
})

test('managed subtitle provenance fails closed after its audio clip is moved', async () => {
  const value = await fixture({ audio: true })
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const audioElement = (((tracks.audio as Array<Record<string, unknown>>)[0]
    .elements as Array<Record<string, unknown>>)[0])
  audioElement.startTime = SECOND
  audioElement.params = {
    dialogueLineId: 'line-1', storySceneId: 'scene-1', storyShotId: 'shot-1',
  }
  const subtitleTrack = (tracks.overlay as Array<Record<string, unknown>>)
    .find((track) => track.type === 'text')!
  subtitleTrack.elements = [{
    id: 'moved-managed-cue', type: 'text', name: '旧位置', startTime: 0, duration: SECOND,
    params: {
      content: '旧位置', text: '旧位置', manjuRole: 'speech-subtitle',
      dialogueLineId: 'line-1', storySceneId: 'scene-1', storyShotId: 'shot-1',
      speechAssetId: 'speech-audio', sourceAudioElementId: 'audio-1',
      subtitleCueSetId: 'moved-set', sourceCueIndex: 0,
    },
    manju: { subtitleCue: {
      version: 1, cueSetId: 'moved-set', dialogueLineId: 'line-1',
      storySceneId: 'scene-1', storyShotId: 'shot-1', speechAssetId: 'speech-audio',
      sourceAudioElementId: 'audio-1', sourceCueIndex: 0, sourceStartMs: 0,
      sourceEndMs: 1_000, sourceAudioStartTime: 0, sourceAudioTrimStart: 0,
      sourceAudioDuration: 5 * SECOND,
    } },
  }]
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })
  assert.throws(
    () => value.exports.create({
      projectId: value.projectId,
      episodeId: value.episodeId,
      timelineRevisionId: saved.revision.id,
      resolution: '720p',
      burnSubtitles: true,
      idempotencyKey: 'moved-managed-audio',
    }),
    (error: unknown) => error instanceof ExportRenderError
      && error.code === 'INVALID_TIMELINE'
      && /已移动或裁剪/.test(error.message),
  )
})

test('worker stages persisted assets, preserves aspect, publishes export.video, and resumes from the output link', async () => {
  const value = await fixture({ audio: true, aspectRatio: '9:16' })
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const audioTracks = tracks.audio as Array<Record<string, unknown>>
  const audioElements = audioTracks[0].elements as Array<Record<string, unknown>>
  audioElements[0].params = { fadeInSeconds: 0.25, fadeOutSeconds: 0.5 }
  const faded = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })
  const renderer = new FakeRenderer()
  const jobs = new SQLiteJobRepository(value.database)
  const worker = new JobWorker(jobs, {
    concurrency: 1,
    resourceConcurrency: { 'renderer:ffmpeg': 1 },
    onEvent(event) {
      const durable = value.database.getGenerationJob(event.jobId)
      if (durable) value.exports.syncJob(durable)
    },
  })
  worker.register(EXPORT_RENDER_JOB_TYPE, createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  }), { resourceKey: () => 'renderer:ffmpeg' })
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: faded.revision.id,
    resolution: '720p',
    kenBurns: true,
    burnSubtitles: true,
    idempotencyKey: 'render-worker',
  })
  assert.equal(created.export.timelineSnapshot.audioClips[0].fadeInSeconds, 0.25)
  assert.equal(created.export.timelineSnapshot.audioClips[0].fadeOutSeconds, 0.5)
  assert.equal(created.export.timelineSnapshot.audioClips[0].audioRole, 'dialogue')
  // The queued worker must consume only the role pinned above. Mutating the
  // asset row after export creation must not turn this dialogue into BGM.
  value.database.withSql((sql) => sql.run(
    `UPDATE media_assets SET kind = 'bgm' WHERE id = 'speech-audio'`,
  ))
  await worker.start()
  worker.enqueue(created.job.id)
  await worker.waitForIdle()

  const job = value.database.getGenerationJob(created.job.id)
  const exported = value.exports.require(created.export.id)
  assert.equal(job?.status, 'succeeded')
  assert.equal(exported.status, 'succeeded')
  assert.ok(exported.outputAssetId)
  const asset = value.database.getMediaAsset(exported.outputAssetId!)
  assert.equal(asset?.kind, 'export.video')
  assert.equal(asset?.mimeType, 'video/mp4')
  assert.equal(asset?.sourceRevisionId, value.storyRevisionId)
  assert.equal(asset?.generationJobId, created.job.id)
  assert.equal(asset?.width, 720)
  assert.equal(asset?.height, 1280)
  assert.equal(asset?.generationParameters.aspectRatio, '9:16')
  assert.equal(renderer.calls.length, 1)
  assert.equal(renderer.calls[0].aspectRatio, '9:16')
  assert.equal(renderer.calls[0].timeline.visualClips[0].kenBurns, true)
  assert.equal(renderer.calls[0].timeline.audioClips?.length, 1)
  assert.equal(renderer.calls[0].timeline.audioClips?.[0].audioRole, 'dialogue')
  assert.equal(renderer.calls[0].timeline.audioClips?.[0].fadeInSeconds, 0.25)
  assert.equal(renderer.calls[0].timeline.audioClips?.[0].fadeOutSeconds, 0.5)
  assert.equal(renderer.calls[0].timeline.subtitles?.format, 'srt')
  assert.notEqual(renderer.calls[0].timeline.visualClips[0].assetPath, value.database.getMediaAsset(value.imageAssetId)?.filePath)

  const opened = await value.mediaStore.openAsset(exported.outputAssetId!)
  try {
    assert.deepEqual(await opened.file.readFile(), MP4)
  } finally {
    await opened.file.close()
  }

  // Simulate the small crash window after MediaStore/exports commit but before
  // JobWorker.succeed: the handler returns the linked asset without rendering.
  const resumeHandler = createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  })
  const resumed = await resumeHandler(
    { id: 'resume-job', type: EXPORT_RENDER_JOB_TYPE, status: 'running', projectId: value.projectId, input: { exportId: exported.id } },
    {
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
      waitingForProvider: async () => undefined,
    },
  )
  assert.equal(resumed.asset.id, exported.outputAssetId)
  assert.equal(renderer.calls.length, 1)
  await worker.stop()
})

test('worker merges subtitles and immutable export branding into one ASS track', async () => {
  const value = await fixture({ aspectRatio: '1:1' })
  value.database.withSql((sql) => sql.run(
    'UPDATE episodes SET title = ? WHERE id = ?',
    '导出分集',
    value.episodeId,
  ))
  const renderer = new FakeRenderer()
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '720p',
    burnSubtitles: true,
    introTitle: true,
    outroCard: true,
    reviewWatermark: true,
    idempotencyKey: 'branding-worker',
  })
  const handler = createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  })
  await handler({
    id: created.job.id,
    type: EXPORT_RENDER_JOB_TYPE,
    status: 'running',
    projectId: value.projectId,
    input: { exportId: created.export.id },
  }, {
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    waitingForProvider: async () => undefined,
  })

  assert.equal(renderer.calls.length, 1)
  assert.equal(renderer.calls[0].timeline.subtitles?.format, 'ass')
  assert.equal(renderer.subtitleDocuments.length, 1)
  assert.match(renderer.subtitleDocuments[0], /PlayResX: 1080\nPlayResY: 1080/)
  assert.match(renderer.subtitleDocuments[0], /,Subtitle,,0,0,0,,真实字幕/)
  assert.match(renderer.subtitleDocuments[0], /,IntroTitle,,0,0,0,,\{\\fad\(300,300\)\}导出测试剧本\\N导出分集/)
  assert.match(renderer.subtitleDocuments[0], /,OutroCard,,0,0,0,,/)
  assert.match(renderer.subtitleDocuments[0], /,Watermark,,0,0,0,,/)
  const output = value.database.getMediaAsset(value.exports.require(created.export.id).outputAssetId!)
  assert.equal(output?.generationParameters.introTitle, true)
  assert.equal(output?.generationParameters.outroCard, true)
  assert.equal(output?.generationParameters.reviewWatermark, true)
})

test('pins a user/Seedance WebM trim by asset ID and stages it as a video render clip', async () => {
  const value = await fixture()
  const video = await value.mediaStore.save({
    id: 'user-video',
    projectId: value.projectId,
    episodeId: value.episodeId,
    kind: 'shot.video',
    bytes: WEBM,
    mimeType: 'video/webm',
    source: 'seedance',
    sourceRevisionId: value.storyRevisionId,
    durationSeconds: 40,
  })
  const current = value.timelines.get(value.episodeId)
  const document = structuredClone(current.document)
  const tracks = document.tracks as Record<string, unknown>
  const overlay = tracks.overlay as Array<Record<string, unknown>>
  const elements = overlay[0].elements as Array<Record<string, unknown>>
  elements[0] = {
    ...elements[0],
    type: 'video',
    mediaId: video.id,
    trimStart: SECOND,
    sourceDuration: 40 * SECOND,
    params: { fit: 'contain' },
  }
  const saved = value.timelines.save({
    projectId: value.projectId,
    episodeId: value.episodeId,
    expectedRevisionId: current.revision.id,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document,
  })
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: saved.revision.id,
    resolution: '720p',
    kenBurns: true,
    idempotencyKey: 'video-export',
  })
  assert.deepEqual(created.export.timelineSnapshot.visualClips, [{
    type: 'video',
    id: 'visual-1',
    startFrame: 0,
    durationFrames: 720,
    assetId: video.id,
    fit: 'contain',
    sourceStartSeconds: 1,
    sourceDurationSeconds: 40,
  }])
  assert.doesNotMatch(
    JSON.stringify(created.export.timelineSnapshot),
    /client-controlled|provider\.invalid|filePath|assetPath/,
  )

  const renderer = new FakeRenderer()
  const handler = createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  })
  await handler({
    id: created.job.id,
    type: EXPORT_RENDER_JOB_TYPE,
    status: 'running',
    projectId: value.projectId,
    input: { exportId: created.export.id },
  }, {
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    waitingForProvider: async () => undefined,
  })

  assert.equal(renderer.calls.length, 1)
  const stagedClip = renderer.calls[0].timeline.visualClips[0]
  assert.equal(stagedClip.mediaType, 'video')
  if (stagedClip.mediaType !== 'video') assert.fail('expected video render clip')
  assert.equal(stagedClip.sourceStartSeconds, 1)
  assert.equal(stagedClip.sourceDurationSeconds, 40)
  assert.equal(stagedClip.kenBurns, undefined)
  assert.match(stagedClip.assetPath, /asset-0\.webm$/)
  assert.notEqual(stagedClip.assetPath, value.database.getMediaAsset(video.id)?.filePath)
})

test('cancelling an in-flight export aborts rendering and never publishes a late asset', async () => {
  const value = await fixture()
  let entered!: () => void
  const rendering = new Promise<void>((resolve) => { entered = resolve })
  const renderer = {
    async render(request: FfmpegRenderRequest): Promise<FfmpegRenderResult> {
      entered()
      return await new Promise<never>((_resolve, reject) => {
        const fail = () => reject(request.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        if (request.signal?.aborted) fail()
        else request.signal?.addEventListener('abort', fail, { once: true })
      })
    },
  }
  const worker = new JobWorker(new SQLiteJobRepository(value.database), {
    concurrency: 1,
    onEvent(event) {
      const durable = value.database.getGenerationJob(event.jobId)
      if (durable) value.exports.syncJob(durable)
    },
  })
  worker.register(EXPORT_RENDER_JOB_TYPE, createExportRenderJobHandler({
    database: value.database,
    mediaStore: value.mediaStore,
    exports: value.exports,
    runtimeDirectory: value.directory,
    renderer,
  }))
  const created = value.exports.create({
    projectId: value.projectId,
    episodeId: value.episodeId,
    timelineRevisionId: value.timelineRevisionId,
    resolution: '720p',
    idempotencyKey: 'cancel-export',
  })
  await worker.start()
  worker.enqueue(created.job.id)
  await rendering
  await worker.cancel(created.job.id)
  await worker.waitForIdle()
  const exported = value.exports.require(created.export.id)
  assert.equal(value.database.getGenerationJob(created.job.id)?.status, 'cancelled')
  assert.equal(exported.status, 'cancelled')
  assert.equal(exported.outputAssetId, null)
  assert.equal(value.database.listMediaAssets({
    projectId: value.projectId,
    episodeId: value.episodeId,
    kind: 'export.video',
  }).length, 0)
  await worker.stop()
})

async function listen(runtime: ApplicationRuntime): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(runtime.app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind TCP')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

test('HTTP API requires idempotency and an immutable revision, then exposes the real downloadable asset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-export-http-test-'))
  const renderer = new FakeRenderer()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    autoStartWorker: false,
    exportRenderer: renderer,
    qualityAnalyzer: {
      async analyze() {
        return {
          passed: true,
          checks: [
            { id: 'decodable', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
            { id: 'ffprobe.specification', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
            { id: 'video.black-frames', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
            { id: 'audio.silence', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
            { id: 'audio.peak', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
          ],
          metrics: { analyzer: 'export-http-test' },
        }
      },
    },
  })
  const { project } = new ProjectService(runtime.database).ensureDefaultProject()
  const stories = runtime.storyRepository
  const episode = stories.ensureEpisode(project.id, { id: 'http-export-episode', title: 'HTTP 导出' })
  const applied = stories.applyStory(episode.id, validStory())
  const image = await runtime.mediaStore.save({
    id: 'http-storyboard',
    projectId: project.id,
    episodeId: episode.id,
    kind: 'storyboard.image',
    bytes: PNG,
    mimeType: 'image/png',
    source: 'test',
    sourceRevisionId: applied.revision.id,
  })
  const timeline = runtime.timelineDocumentService.saveReconciled({
    projectId: project.id,
    episodeId: episode.id,
    expectedRevisionId: null,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    sourceRevisionId: applied.revision.id,
    document: {
      ticksPerSecond: SECOND,
      tracks: {
        overlay: [{
          id: 'visual-main', type: 'video', elements: [{
            id: 'clip', type: 'image', mediaId: image.id, startTime: 0, duration: 30 * SECOND, params: {},
          }],
        }],
        main: { id: 'main', type: 'video', elements: [] },
        audio: [],
      },
    },
  })
  await runtime.worker.start()
  const { server, baseUrl } = await listen(runtime)
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })

  const body = JSON.stringify({ projectId: project.id, resolution: '720p' })
  const invalidBranding = await fetch(`${baseUrl}/api/v1/episodes/${episode.id}/exports`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'http-export-invalid-branding',
      'if-match': timeline.etag,
    },
    body: JSON.stringify({
      projectId: project.id,
      resolution: '720p',
      introTitle: 'yes',
    }),
  })
  assert.equal(invalidBranding.status, 400)
  assert.equal(
    (await invalidBranding.json() as { error: { code: string } }).error.code,
    'INVALID_EXPORT_REQUEST',
  )
  const unknownBranding = await fetch(`${baseUrl}/api/v1/episodes/${episode.id}/exports`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'http-export-unknown-branding',
      'if-match': timeline.etag,
    },
    body: JSON.stringify({
      projectId: project.id,
      resolution: '720p',
      fullIntroAnimation: true,
    }),
  })
  assert.equal(unknownBranding.status, 400)
  assert.equal(
    (await unknownBranding.json() as { error: { code: string } }).error.code,
    'INVALID_EXPORT_REQUEST',
  )
  const missingKey = await fetch(`${baseUrl}/api/v1/episodes/${episode.id}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': timeline.etag },
    body,
  })
  assert.equal(missingKey.status, 400)
  assert.equal((await missingKey.json() as { error: { code: string } }).error.code, 'IDEMPOTENCY_KEY_REQUIRED')

  const missingRevision = await fetch(`${baseUrl}/api/v1/episodes/${episode.id}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'http-export' },
    body,
  })
  assert.equal(missingRevision.status, 428)

  const submitted = await fetch(`${baseUrl}/api/v1/episodes/${episode.id}/exports`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'http-export',
      'if-match': timeline.etag,
    },
    body,
  })
  assert.equal(submitted.status, 202)
  const submission = await submitted.json() as { export: { id: string }; job: { id: string } }
  await runtime.worker.waitForIdle()

  const fetched = await fetch(`${baseUrl}/api/v1/exports/${submission.export.id}`)
  assert.equal(fetched.status, 200)
  const result = await fetched.json() as {
    export: {
      id: string
      status: string
      timelineRevisionId: string
      outputAsset: { id: string; url: string; mimeType: string }
      downloadUrl: string
      reviewDownloadUrl: string
    }
  }
  assert.equal(result.export.status, 'succeeded')
  assert.equal(result.export.timelineRevisionId, timeline.revision.id)
  assert.equal(result.export.outputAsset.mimeType, 'video/mp4')
  assert.equal(result.export.downloadUrl, `/api/v1/exports/${result.export.id}/download`)
  assert.equal(
    result.export.reviewDownloadUrl,
    `/api/v1/exports/${result.export.id}/review-download`,
  )
  assert.equal(result.export.outputAsset.url, result.export.downloadUrl)
  const blockedDownload = await fetch(`${baseUrl}${result.export.downloadUrl}`)
  assert.equal(blockedDownload.status, 423)
  assert.equal(
    (await blockedDownload.json() as { error: { code: string } }).error.code,
    'QUALITY_CHECK_REQUIRED',
  )
  const blockedAssetBypass = await fetch(
    `${baseUrl}/api/v1/assets/${result.export.outputAsset.id}/content`,
  )
  assert.equal(blockedAssetBypass.status, 423)
  assert.equal(
    (await blockedAssetBypass.json() as { error: { code: string } }).error.code,
    'EXPORT_QC_GATE_REQUIRED',
  )
  const submittedQuality = await fetch(
    `${baseUrl}/api/v1/exports/${result.export.id}/quality-checks`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'http-export-quality',
      },
      body: '{}',
    },
  )
  assert.equal(submittedQuality.status, 202)
  await runtime.worker.waitForIdle()
  const releaseStillBlocked = await fetch(`${baseUrl}${result.export.downloadUrl}`)
  assert.equal(releaseStillBlocked.status, 423)
  assert.equal(
    (await releaseStillBlocked.json() as { error: { code: string } }).error.code,
    'RELEASE_REVIEW_REQUIRED',
  )
  const download = await fetch(`${baseUrl}${result.export.reviewDownloadUrl}`)
  assert.equal(download.status, 200)
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="manju-review-.+\.mp4"$/)
  assert.equal(download.headers.get('content-type'), 'video/mp4')
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), MP4)

  const duplicate = await fetch(`${baseUrl}/api/v1/episodes/${episode.id}/exports`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'http-export',
      'if-match': timeline.etag,
    },
    body,
  })
  assert.equal(duplicate.status, 200)
  const duplicateBody = await duplicate.json() as { export: { id: string } }
  assert.equal(duplicateBody.export.id, submission.export.id)
  assert.equal(renderer.calls.length, 1)
})
