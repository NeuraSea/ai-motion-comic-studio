import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'

import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import ffmpegStaticPath from 'ffmpeg-static'

import { createApplication, type ApplicationRuntime } from './app-v1.js'
import type { KeychainCredentialSlot } from './keychain.js'
import type { ProviderCredentialStore } from './providers/service.js'
import type { ImageProvider } from './types.js'

const TICKS_PER_SECOND = 120_000
const TEST_DURATION_SECONDS = 3
const FRAME_RATE = 24

const realBinariesAvailable = typeof ffmpegStaticPath === 'string'
  && existsSync(ffmpegStaticPath)
  && existsSync(ffprobeInstaller.path)

class OfflineCredentialStore implements ProviderCredentialStore {
  async get(_slot: KeychainCredentialSlot): Promise<string | null> {
    return null
  }

  async set(_slot: KeychainCredentialSlot, _secret: string): Promise<void> {
    throw new Error('The offline golden path must not persist provider credentials')
  }

  async delete(_slot: KeychainCredentialSlot): Promise<boolean> {
    return false
  }

  async exists(_slot: KeychainCredentialSlot): Promise<boolean> {
    return false
  }
}

const offlineImageProvider: ImageProvider = {
  name: 'offline-golden-path',
  model: 'none',
  configured: false,
  async health() {
    return { status: 'unavailable', message: 'offline test provider' }
  },
  async generate() {
    throw new Error('The offline golden path must not call an image provider')
  },
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0)) >>> 0
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  typeBytes.copy(header, 4)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([header, data, checksum])
}

/** A real, compact, non-black RGB PNG so the production black-frame check can pass. */
function solidPng(width = 32, height = 18): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // true-colour RGB
  const scanlines = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3)
    scanlines[row] = 0 // PNG filter: None
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3
      scanlines[pixel] = 224
      scanlines[pixel + 1] = 88
      scanlines[pixel + 2] = 48
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** A continuous, safely sub-clipping stereo tone used by the production silence/peak checks. */
function toneWav(durationSeconds = TEST_DURATION_SECONDS): Buffer {
  const sampleRate = 48_000
  const channels = 2
  const bytesPerSample = 2
  const frameCount = Math.round(sampleRate * durationSeconds)
  const dataBytes = frameCount * channels * bytesPerSample
  const wav = Buffer.alloc(44 + dataBytes)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + dataBytes, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20) // PCM
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  wav.writeUInt16LE(channels * bytesPerSample, 32)
  wav.writeUInt16LE(bytesPerSample * 8, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(dataBytes, 40)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 6_000)
    const offset = 44 + frame * channels * bytesPerSample
    wav.writeInt16LE(sample, offset)
    wav.writeInt16LE(sample, offset + bytesPerSample)
  }
  return wav
}

function sixShotStory() {
  return {
    version: 1 as const,
    title: '离线黄金路径',
    targetDurationSeconds: 30,
    bible: {
      logline: '主角在黄昏中完成一次选择。',
      theme: '选择',
      tone: '温暖',
      visualStyle: '国风动画',
    },
    characters: [{
      id: 'hero',
      name: '主角',
      role: '主角',
      storyDescription: '正在做出选择的人。',
      visualDescription: '深色短发，暖色外套。',
    }],
    locations: [{
      id: 'courtyard',
      name: '庭院',
      storyDescription: '故事发生的安静庭院。',
      visualDescription: '黄昏暖光，青石地面。',
    }],
    props: [],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '黄昏庭院',
      locationId: 'courtyard',
      timeOfDay: '黄昏',
      description: '主角穿过庭院。',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `镜头 ${index + 1}`,
        description: '主角向前走，暖光落在肩上。',
        framing: '中景',
        movement: '固定',
        transition: '硬切',
        durationSeconds: 5,
        visualPrompt: '国风动画，黄昏庭院，暖色电影光。',
        dialogueLines: index === 0 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue' as const,
          speaker: '主角',
          text: '我已经做出了选择。',
        }] : [],
      })),
    }],
  }
}

function runtimeOptions(runtimeDirectory: string) {
  return {
    runtimeDirectory,
    autoStartWorker: false,
    provider: offlineImageProvider,
    keychain: new OfflineCredentialStore(),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
  }
}

async function listen(runtime: ApplicationRuntime): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(runtime.app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Golden-path server did not bind TCP')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
}

async function json<T>(response: Response): Promise<T> {
  const payload = await response.text()
  assert.notEqual(payload, '', `Expected JSON from ${response.url} (${response.status})`)
  return JSON.parse(payload) as T
}

async function assertStatus(response: Response, expected: number): Promise<void> {
  if (response.status === expected) return
  const payload = await response.text()
  assert.equal(response.status, expected, payload)
}

interface PublicJob {
  id: string
  status: 'queued' | 'running' | 'waiting_provider' | 'succeeded' | 'failed' | 'cancelled'
  error: unknown
}

type PublicPipelineStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale'

interface PublicPipelineRun {
  id: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  version: 1
  mode: 'dynamic-comic'
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale'
  progress: number
  bindings: Record<string, unknown>
  targets: { storyboard: string[]; speech: string[] }
  steps: {
    storyboard: {
      status: PublicPipelineStepStatus
      jobIds: string[]
      completed: number
      total: number
    }
    speech: {
      status: PublicPipelineStepStatus
      jobIds: string[]
      completed: number
      total: number
    }
    timeline: { status: PublicPipelineStepStatus; revisionId?: string }
    export: {
      status: PublicPipelineStepStatus
      exportId?: string
      rootJobId?: string
    }
    quality: {
      status: PublicPipelineStepStatus
      reportId?: string
      rootJobId?: string
      passed?: boolean
    }
  }
  error: unknown
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

interface PublicPipelinePreflight {
  version: 1
  projectId: string
  episodeId: string
  sourceRevisionId: string
  readyStoryboardCount: number
  missingStoryboardCount: number
  readySpeechCount: number
  missingSpeechCount: number
  hasPublishableAudio: boolean
  billableStoryboardCount: number
  billableSpeechCount: number
  billableTargetCount: number
  imageProvider: null | { providerId: string; configRevision: number; model: string | null }
  speechProvider: null | { providerId: string; configRevision: number; model: string | null }
  confirmationToken: string
}

async function waitForTerminalJob(baseUrl: string, jobId: string): Promise<PublicJob> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}`)
    assert.equal(response.status, 200)
    const { job } = await json<{ job: PublicJob }>(response)
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      return job
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for job ${jobId}`)
}

async function waitForTerminalPipelineRun(
  baseUrl: string,
  pipelineRunId: string,
): Promise<PublicPipelineRun> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const response = await fetch(
      `${baseUrl}/api/v1/pipeline-runs/${encodeURIComponent(pipelineRunId)}`,
    )
    assert.equal(response.status, 200)
    const { pipelineRun } = await json<{ pipelineRun: PublicPipelineRun }>(response)
    if (['succeeded', 'failed', 'cancelled', 'stale'].includes(pipelineRun.status)) {
      return pipelineRun
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for pipeline run ${pipelineRunId}`)
}

async function assertQcLocked(
  downloadUrl: string,
  options: { method?: 'GET' | 'HEAD'; range?: string } = {},
): Promise<void> {
  const response = await fetch(downloadUrl, {
    method: options.method ?? 'GET',
    headers: options.range ? { range: options.range } : undefined,
  })
  assert.equal(response.status, 423, `${options.method ?? 'GET'} ${options.range ?? 'full'}`)
  if ((options.method ?? 'GET') !== 'HEAD') {
    const body = await json<{ error: { code: string } }>(response)
    assert.equal(body.error.code, 'QUALITY_CHECK_REQUIRED')
  }
}

async function approveRelease(
  baseUrl: string,
  exportId: string,
  idempotencyKey: string,
): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/v1/exports/${encodeURIComponent(exportId)}/release-reviews`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        decision: 'approve',
        checklist: {
          audioVideoSync: true,
          subtitleSyncAndComplete: true,
          characterVisualSemantics: true,
        },
      }),
    },
  )
  await assertStatus(response, 201)
  const body = await json<{
    releaseReview: { id: string; isCurrent: boolean; invalidReasons: string[] }
  }>(response)
  assert.equal(body.releaseReview.isCurrent, true)
  assert.deepEqual(body.releaseReview.invalidReasons, [])
  return body.releaseReview.id
}

interface TimelineElementJson {
  id: string
  type: string
  startTime: number
  duration: number
}

interface TimelineDocumentJson {
  version: number
  tracks: {
    overlay: Array<{ id: string; type: string; elements: TimelineElementJson[] }>
    main: { id: string; type: string; elements: TimelineElementJson[] }
    audio: Array<{ id: string; type: string; elements: TimelineElementJson[] }>
  }
  [key: string]: unknown
}

interface TimelineHttpResult {
  timelineDocument: {
    id: string
    schemaVersion: number
    upstreamCommit: string
    sourceRevisionId: string
  }
  revision: { id: string; sourceRevisionId: string }
  document: TimelineDocumentJson
  report?: { appendedShots: unknown[]; appendedDialogueAudio: unknown[] }
}

test('offline HTTP golden path gates manual MP4 and completes confirmed one-click Pipeline across restart', {
  skip: realBinariesAvailable ? false : 'bundled FFmpeg/ffprobe are unavailable on this platform',
  timeout: 180_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-mvp-golden-path-'))
  let runtime: ApplicationRuntime | undefined
  let server: Server | undefined
  try {
    runtime = await createApplication(runtimeOptions(directory))
    const { project } = runtime.projectService.ensureDefaultProject()
    const episode = runtime.storyRepository.ensureEpisode(project.id, {
      id: 'mvp-golden-episode',
      title: '离线黄金路径',
      aspectRatio: '16:9',
    })
    const applied = runtime.storyRepository.applyStory(episode.id, sixShotStory())
    const image = await runtime.mediaStore.save({
      id: 'mvp-golden-storyboard',
      projectId: project.id,
      episodeId: episode.id,
      kind: 'storyboard.image',
      bytes: solidPng(),
      mimeType: 'image/png',
      width: 32,
      height: 18,
      source: 'offline-test',
      sourceRevisionId: applied.revision.id,
    })
    const speech = await runtime.mediaStore.save({
      id: 'mvp-golden-speech',
      projectId: project.id,
      episodeId: episode.id,
      kind: 'dialogue.speech',
      bytes: toneWav(),
      mimeType: 'audio/wav',
      durationSeconds: TEST_DURATION_SECONDS,
      source: 'offline-test',
      sourceRevisionId: applied.revision.id,
    })
    runtime.database.withSql((sql) => {
      assert.equal(sql.run(`
        UPDATE shots SET storyboard_asset_id = ?
         WHERE scene_id IN (SELECT id FROM scenes WHERE episode_id = ?)
      `, image.id, episode.id).changes, 6)
      assert.equal(sql.run(`
        UPDATE dialogue_lines
           SET speech_asset_id = ?, duration_seconds = ?
         WHERE shot_id IN (
           SELECT shots.id FROM shots
           JOIN scenes ON scenes.id = shots.scene_id
           WHERE scenes.episode_id = ?
         )
      `, speech.id, TEST_DURATION_SECONDS, episode.id).changes, 1)
    })

    await runtime.worker.start()
    const listening = await listen(runtime)
    server = listening.server
    let baseUrl = listening.baseUrl

    const materializeResponse = await fetch(
      `${baseUrl}/api/v1/episodes/${episode.id}/timeline-document/materialize`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': '*' },
        body: JSON.stringify({ projectId: project.id, summary: 'MVP HTTP materialize' }),
      },
    )
    await assertStatus(materializeResponse, 201)
    const materializeEtag = materializeResponse.headers.get('etag')
    assert.ok(materializeEtag)
    const materialized = await json<TimelineHttpResult>(materializeResponse)
    assert.equal(materialized.timelineDocument.sourceRevisionId, applied.revision.id)
    assert.equal(materialized.revision.sourceRevisionId, applied.revision.id)
    assert.equal(materialized.report?.appendedShots.length, 6)
    assert.equal(materialized.report?.appendedDialogueAudio.length, 1)
    const visualTrack = materialized.document.tracks.overlay.find((track) => track.id === 'visual-main')
    assert.ok(visualTrack)
    assert.equal(visualTrack.elements.length, 6)
    assert.deepEqual(visualTrack.elements.map((element) => element.duration), [
      TEST_DURATION_SECONDS * TICKS_PER_SECOND,
      ...Array(5).fill(5 * TICKS_PER_SECOND),
    ])
    assert.equal(materialized.document.tracks.audio.length, 1)
    assert.equal(materialized.document.tracks.audio[0].elements[0].duration, TEST_DURATION_SECONDS * TICKS_PER_SECOND)

    // Story validation intentionally requires a 30-60 second script. The real
    // editing path is allowed to trim that materialized timeline, so do the
    // short test edit through the public HTTP CAS endpoint rather than mutating
    // SQLite or calling TimelineDocumentService directly.
    const shortClipTicks = TICKS_PER_SECOND / 2
    visualTrack.elements.forEach((element, index) => {
      element.startTime = index * shortClipTicks
      element.duration = shortClipTicks
    })
    const saveResponse = await fetch(
      `${baseUrl}/api/v1/episodes/${episode.id}/timeline-document`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': materializeEtag },
        body: JSON.stringify({
          projectId: project.id,
          schemaVersion: materialized.timelineDocument.schemaVersion,
          upstreamCommit: materialized.timelineDocument.upstreamCommit,
          summary: 'Trim golden path to three seconds',
          document: materialized.document,
        }),
      },
    )
    await assertStatus(saveResponse, 200)
    const savedEtag = saveResponse.headers.get('etag')
    assert.ok(savedEtag)
    const saved = await json<TimelineHttpResult>(saveResponse)
    assert.deepEqual(
      saved.document.tracks.overlay.find((track) => track.id === 'visual-main')?.elements
        .map((element) => [element.startTime, element.duration]),
      Array.from({ length: 6 }, (_, index) => [index * shortClipTicks, shortClipTicks]),
    )

    const exportResponse = await fetch(`${baseUrl}/api/v1/episodes/${episode.id}/exports`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'mvp-golden-export-v1',
        'if-match': savedEtag,
      },
      body: JSON.stringify({
        projectId: project.id,
        resolution: '720p',
        kenBurns: false,
        burnSubtitles: false,
      }),
    })
    await assertStatus(exportResponse, 202)
    const exportSubmission = await json<{
      export: { id: string }
      job: { id: string }
    }>(exportResponse)
    const exportJob = await waitForTerminalJob(baseUrl, exportSubmission.job.id)
    assert.equal(exportJob.status, 'succeeded', JSON.stringify(exportJob.error))

    const exportedResponse = await fetch(
      `${baseUrl}/api/v1/exports/${encodeURIComponent(exportSubmission.export.id)}`,
    )
    assert.equal(exportedResponse.status, 200)
    const exported = await json<{
      export: {
        id: string
        status: string
        timelineRevisionId: string
        storyRevisionId: string
        downloadUrl: string
        outputAsset: {
          id: string
          kind: string
          mimeType: string
          width: number
          height: number
          durationSeconds: number
          checksum: string
        }
      }
    }>(exportedResponse)
    assert.equal(exported.export.status, 'succeeded')
    assert.equal(exported.export.timelineRevisionId, saved.revision.id)
    assert.equal(exported.export.storyRevisionId, applied.revision.id)
    assert.deepEqual({
      kind: exported.export.outputAsset.kind,
      mimeType: exported.export.outputAsset.mimeType,
      width: exported.export.outputAsset.width,
      height: exported.export.outputAsset.height,
      durationSeconds: exported.export.outputAsset.durationSeconds,
    }, {
      kind: 'export.video',
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationSeconds: TEST_DURATION_SECONDS,
    })
    assert.match(exported.export.outputAsset.checksum, /^[0-9a-f]{64}$/)
    const downloadUrl = `${baseUrl}${exported.export.downloadUrl}`

    await assertQcLocked(downloadUrl)
    await assertQcLocked(downloadUrl, { method: 'HEAD' })
    await assertQcLocked(downloadUrl, { range: 'bytes=0-15' })

    const qualityResponse = await fetch(
      `${baseUrl}/api/v1/exports/${encodeURIComponent(exported.export.id)}/quality-checks`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'mvp-golden-quality-v1',
        },
        body: '{}',
      },
    )
    await assertStatus(qualityResponse, 202)
    const qualitySubmission = await json<{
      qualityReport: { id: string }
      job: { id: string }
    }>(qualityResponse)
    const qualityJob = await waitForTerminalJob(baseUrl, qualitySubmission.job.id)
    assert.equal(qualityJob.status, 'succeeded', JSON.stringify(qualityJob.error))

    const reportResponse = await fetch(
      `${baseUrl}/api/v1/quality-reports/${encodeURIComponent(qualitySubmission.qualityReport.id)}`,
    )
    assert.equal(reportResponse.status, 200)
    const { qualityReport } = await json<{
      qualityReport: {
        id: string
        status: string
        passed: boolean
        outputAssetId: string
        timelineRevisionId: string
        storyRevisionId: string
        expected: { durationSeconds: number; frameCount: number }
        checks: Array<{ id: string; status: string }>
        metrics: {
          analyzedDurationSeconds: number
          mediaCheckCount: number
          subtitleCheckCount: number
          checkCount: number
        }
      }
    }>(reportResponse)
    assert.equal(qualityReport.status, 'passed')
    assert.equal(qualityReport.passed, true)
    assert.equal(qualityReport.outputAssetId, exported.export.outputAsset.id)
    assert.equal(qualityReport.timelineRevisionId, saved.revision.id)
    assert.equal(qualityReport.storyRevisionId, applied.revision.id)
    assert.equal(qualityReport.expected.durationSeconds, TEST_DURATION_SECONDS)
    assert.equal(qualityReport.expected.frameCount, TEST_DURATION_SECONDS * FRAME_RATE)
    assert.deepEqual(qualityReport.checks.map((check) => check.id), [
      'decodable',
      'ffprobe.specification',
      'video.black-frames',
      'audio.silence',
      'audio.peak',
      'subtitle.timing',
      'subtitle.safe-area',
    ])
    assert.equal(qualityReport.checks.some((check) => check.status === 'failed'), false)
    assert.deepEqual(qualityReport.metrics, {
      analyzedDurationSeconds: TEST_DURATION_SECONDS,
      mediaCheckCount: 5,
      subtitleCheckCount: 2,
      checkCount: 7,
    })

    const pendingManualReview = await fetch(downloadUrl)
    assert.equal(pendingManualReview.status, 423)
    assert.equal(
      (await json<{ error: { code: string } }>(pendingManualReview)).error.code,
      'RELEASE_REVIEW_REQUIRED',
    )
    await approveRelease(baseUrl, exported.export.id, 'mvp-golden-release-review-v1')

    const fullResponse = await fetch(downloadUrl)
    assert.equal(fullResponse.status, 200)
    assert.equal(fullResponse.headers.get('content-type'), 'video/mp4')
    assert.match(
      fullResponse.headers.get('content-disposition') ?? '',
      /^attachment; filename="manju-.+\.mp4"$/,
    )
    const fullBytes = Buffer.from(await fullResponse.arrayBuffer())
    assert.ok(fullBytes.length > 16)
    assert.equal(fullBytes.subarray(4, 8).toString('ascii'), 'ftyp')
    assert.equal(fullResponse.headers.get('content-length'), String(fullBytes.length))

    const headResponse = await fetch(downloadUrl, { method: 'HEAD' })
    assert.equal(headResponse.status, 200)
    assert.equal(headResponse.headers.get('content-length'), String(fullBytes.length))
    assert.equal((await headResponse.arrayBuffer()).byteLength, 0)

    const rangeResponse = await fetch(downloadUrl, { headers: { range: 'bytes=0-15' } })
    assert.equal(rangeResponse.status, 206)
    assert.equal(rangeResponse.headers.get('content-range'), `bytes 0-15/${fullBytes.length}`)
    assert.equal(rangeResponse.headers.get('content-length'), '16')
    assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), fullBytes.subarray(0, 16))

    const genericBypass = await fetch(
      `${baseUrl}/api/v1/assets/${encodeURIComponent(exported.export.outputAsset.id)}/content`,
      { headers: { range: 'bytes=0-15' } },
    )
    assert.equal(genericBypass.status, 423)

    // Close both the HTTP listener and SQLite runtime, then prove that all
    // immutable bindings and the byte-release authorization survive a fresh
    // createApplication() against the same runtime directory.
    await closeServer(server)
    server = undefined
    await runtime.close()
    runtime = undefined

    runtime = await createApplication(runtimeOptions(directory))
    await runtime.worker.start()
    const restarted = await listen(runtime)
    server = restarted.server
    baseUrl = restarted.baseUrl

    const restoredTimelineResponse = await fetch(
      `${baseUrl}/api/v1/episodes/${episode.id}/timeline-document`,
    )
    assert.equal(restoredTimelineResponse.status, 200)
    const restoredTimeline = await json<TimelineHttpResult>(restoredTimelineResponse)
    assert.equal(restoredTimeline.revision.id, saved.revision.id)
    assert.equal(restoredTimeline.timelineDocument.sourceRevisionId, applied.revision.id)

    const restoredExportResponse = await fetch(
      `${baseUrl}/api/v1/exports/${encodeURIComponent(exported.export.id)}`,
    )
    assert.equal(restoredExportResponse.status, 200)
    const restoredExport = await json<{
      export: { status: string; downloadUrl: string; outputAsset: { checksum: string } }
    }>(restoredExportResponse)
    assert.equal(restoredExport.export.status, 'succeeded')
    assert.equal(restoredExport.export.outputAsset.checksum, exported.export.outputAsset.checksum)

    const restoredReportResponse = await fetch(
      `${baseUrl}/api/v1/quality-reports/${encodeURIComponent(qualityReport.id)}`,
    )
    assert.equal(restoredReportResponse.status, 200)
    const restoredReport = await json<{ qualityReport: { status: string; passed: boolean } }>(
      restoredReportResponse,
    )
    assert.equal(restoredReport.qualityReport.status, 'passed')
    assert.equal(restoredReport.qualityReport.passed, true)

    const restoredDownloadUrl = `${baseUrl}${restoredExport.export.downloadUrl}`
    const restoredHead = await fetch(restoredDownloadUrl, { method: 'HEAD' })
    assert.equal(restoredHead.status, 200)
    assert.equal(restoredHead.headers.get('content-length'), String(fullBytes.length))
    const restoredRange = await fetch(restoredDownloadUrl, { headers: { range: 'bytes=0-15' } })
    assert.equal(restoredRange.status, 206)
    assert.deepEqual(Buffer.from(await restoredRange.arrayBuffer()), fullBytes.subarray(0, 16))
    const restoredFull = await fetch(restoredDownloadUrl)
    assert.equal(restoredFull.status, 200)
    assert.deepEqual(Buffer.from(await restoredFull.arrayBuffer()), fullBytes)

    // Run the same ready six-shot episode through the public one-click
    // production contract. All visual and dialogue assets are already ready,
    // so authoritative preflight must report zero billable targets and no
    // Provider binding. A provider call would hit offlineImageProvider.generate
    // and fail this test; export and QC deliberately remain the real binaries.
    const pipelineRequest = {
      projectId: project.id,
      resolution: '720p',
      kenBurns: false,
      burnSubtitles: false,
      introTitle: false,
      outroCard: false,
      reviewWatermark: false,
      speechMode: 'skip',
    } as const
    const pipelinePreflightResponse = await fetch(
      `${baseUrl}/api/v1/episodes/${episode.id}/pipeline-runs/preflight`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'mvp-golden-pipeline-v1',
        },
        body: JSON.stringify(pipelineRequest),
      },
    )
    await assertStatus(pipelinePreflightResponse, 200)
    const { preflight } = await json<{ preflight: PublicPipelinePreflight }>(
      pipelinePreflightResponse,
    )
    assert.deepEqual({
      version: preflight.version,
      projectId: preflight.projectId,
      episodeId: preflight.episodeId,
      sourceRevisionId: preflight.sourceRevisionId,
      readyStoryboardCount: preflight.readyStoryboardCount,
      missingStoryboardCount: preflight.missingStoryboardCount,
      readySpeechCount: preflight.readySpeechCount,
      missingSpeechCount: preflight.missingSpeechCount,
      hasPublishableAudio: preflight.hasPublishableAudio,
      billableStoryboardCount: preflight.billableStoryboardCount,
      billableSpeechCount: preflight.billableSpeechCount,
      billableTargetCount: preflight.billableTargetCount,
      imageProvider: preflight.imageProvider,
      speechProvider: preflight.speechProvider,
    }, {
      version: 1,
      projectId: project.id,
      episodeId: episode.id,
      sourceRevisionId: applied.revision.id,
      readyStoryboardCount: 6,
      missingStoryboardCount: 0,
      readySpeechCount: 1,
      missingSpeechCount: 0,
      hasPublishableAudio: true,
      billableStoryboardCount: 0,
      billableSpeechCount: 0,
      billableTargetCount: 0,
      imageProvider: null,
      speechProvider: null,
    })
    assert.match(preflight.confirmationToken, /^pfr1_[1-9][0-9]{9,12}_[a-f0-9]{64}$/)

    const pipelineCreateResponse = await fetch(
      `${baseUrl}/api/v1/episodes/${episode.id}/pipeline-runs`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'mvp-golden-pipeline-v1',
        },
        body: JSON.stringify({
          ...pipelineRequest,
          confirmationToken: preflight.confirmationToken,
        }),
      },
    )
    await assertStatus(pipelineCreateResponse, 202)
    const { pipelineRun: createdPipeline } = await json<{ pipelineRun: PublicPipelineRun }>(
      pipelineCreateResponse,
    )
    assert.equal(createdPipeline.projectId, project.id)
    assert.equal(createdPipeline.episodeId, episode.id)
    assert.equal(createdPipeline.sourceRevisionId, applied.revision.id)
    assert.equal(createdPipeline.version, 1)
    assert.equal(createdPipeline.mode, 'dynamic-comic')
    assert.equal(createdPipeline.status, 'queued')
    assert.deepEqual(createdPipeline.bindings, {})
    assert.deepEqual(createdPipeline.targets, { storyboard: [], speech: [] })

    const completedPipeline = await waitForTerminalPipelineRun(baseUrl, createdPipeline.id)
    assert.equal(
      completedPipeline.status,
      'succeeded',
      JSON.stringify(completedPipeline.error),
    )
    assert.equal(completedPipeline.progress, 100)
    assert.equal(completedPipeline.error, null)
    assert.ok(completedPipeline.completedAt)
    assert.deepEqual(Object.keys(completedPipeline.steps).sort(), [
      'export',
      'quality',
      'speech',
      'storyboard',
      'timeline',
    ])
    assert.deepEqual(completedPipeline.steps.storyboard, {
      status: 'succeeded',
      jobIds: [],
      completed: 0,
      total: 0,
    })
    assert.deepEqual(completedPipeline.steps.speech, {
      status: 'succeeded',
      jobIds: [],
      completed: 0,
      total: 0,
    })
    assert.deepEqual(
      Object.values(completedPipeline.steps).map((step) => step.status),
      Array(5).fill('succeeded'),
    )
    assert.ok(completedPipeline.steps.timeline.revisionId)
    assert.ok(completedPipeline.steps.export.exportId)
    assert.ok(completedPipeline.steps.export.rootJobId)
    assert.ok(completedPipeline.steps.quality.reportId)
    assert.ok(completedPipeline.steps.quality.rootJobId)
    assert.equal(completedPipeline.steps.quality.passed, true)

    const pipelineJobs = runtime.database.listGenerationJobs({
      pipelineRunId: completedPipeline.id,
    })
    assert.deepEqual(
      pipelineJobs.map((job) => job.type).sort(),
      ['export.render', 'quality.check'],
    )
    assert.equal(pipelineJobs.every((job) => job.status === 'succeeded'), true)
    assert.equal(pipelineJobs.every((job) => job.providerId === null), true)

    const pipelineExportResponse = await fetch(
      `${baseUrl}/api/v1/exports/${encodeURIComponent(completedPipeline.steps.export.exportId!)}`,
    )
    assert.equal(pipelineExportResponse.status, 200)
    const { export: pipelineExport } = await json<{
      export: {
        id: string
        projectId: string
        episodeId: string
        status: string
        timelineRevisionId: string
        storyRevisionId: string
        jobId: string
        downloadUrl: string
        outputAsset: {
          id: string
          kind: string
          mimeType: string
          width: number
          height: number
          durationSeconds: number
          checksum: string
        }
      }
    }>(pipelineExportResponse)
    assert.equal(pipelineExport.id, completedPipeline.steps.export.exportId)
    assert.equal(pipelineExport.projectId, project.id)
    assert.equal(pipelineExport.episodeId, episode.id)
    assert.equal(pipelineExport.status, 'succeeded')
    assert.equal(
      pipelineExport.timelineRevisionId,
      completedPipeline.steps.timeline.revisionId,
    )
    assert.equal(pipelineExport.storyRevisionId, applied.revision.id)
    assert.equal(pipelineExport.jobId, completedPipeline.steps.export.rootJobId)
    assert.deepEqual({
      kind: pipelineExport.outputAsset.kind,
      mimeType: pipelineExport.outputAsset.mimeType,
      width: pipelineExport.outputAsset.width,
      height: pipelineExport.outputAsset.height,
      durationSeconds: pipelineExport.outputAsset.durationSeconds,
    }, {
      kind: 'export.video',
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationSeconds: TEST_DURATION_SECONDS,
    })
    assert.match(pipelineExport.outputAsset.checksum, /^[0-9a-f]{64}$/)

    const pipelineReportResponse = await fetch(
      `${baseUrl}/api/v1/quality-reports/${encodeURIComponent(completedPipeline.steps.quality.reportId!)}`,
    )
    assert.equal(pipelineReportResponse.status, 200)
    const { qualityReport: pipelineReport } = await json<{
      qualityReport: {
        id: string
        projectId: string
        episodeId: string
        exportId: string
        outputAssetId: string
        timelineRevisionId: string
        storyRevisionId: string
        status: string
        passed: boolean
        jobId: string
        jobStatus: string
        checks: Array<{ id: string; status: string }>
      }
    }>(pipelineReportResponse)
    assert.equal(pipelineReport.id, completedPipeline.steps.quality.reportId)
    assert.equal(pipelineReport.projectId, project.id)
    assert.equal(pipelineReport.episodeId, episode.id)
    assert.equal(pipelineReport.exportId, pipelineExport.id)
    assert.equal(pipelineReport.outputAssetId, pipelineExport.outputAsset.id)
    assert.equal(pipelineReport.timelineRevisionId, pipelineExport.timelineRevisionId)
    assert.equal(pipelineReport.storyRevisionId, applied.revision.id)
    assert.equal(pipelineReport.status, 'passed')
    assert.equal(pipelineReport.passed, true)
    assert.equal(pipelineReport.jobId, completedPipeline.steps.quality.rootJobId)
    assert.equal(pipelineReport.jobStatus, 'succeeded')
    assert.deepEqual(pipelineReport.checks.map((check) => check.id), [
      'decodable',
      'ffprobe.specification',
      'video.black-frames',
      'audio.silence',
      'audio.peak',
      'subtitle.timing',
      'subtitle.safe-area',
    ])
    assert.equal(pipelineReport.checks.some((check) => check.status === 'failed'), false)

    await approveRelease(baseUrl, pipelineExport.id, 'mvp-golden-pipeline-release-review-v1')

    const pipelineDownloadUrl = `${baseUrl}${pipelineExport.downloadUrl}`
    const pipelineDownload = await fetch(pipelineDownloadUrl)
    assert.equal(pipelineDownload.status, 200)
    assert.equal(pipelineDownload.headers.get('content-type'), 'video/mp4')
    const pipelineBytes = Buffer.from(await pipelineDownload.arrayBuffer())
    assert.ok(pipelineBytes.length > 16)
    assert.equal(pipelineBytes.subarray(4, 8).toString('ascii'), 'ftyp')
    assert.equal(pipelineDownload.headers.get('content-length'), String(pipelineBytes.length))
    const pipelineHead = await fetch(pipelineDownloadUrl, { method: 'HEAD' })
    assert.equal(pipelineHead.status, 200)
    assert.equal(pipelineHead.headers.get('content-length'), String(pipelineBytes.length))
    const pipelineRange = await fetch(pipelineDownloadUrl, {
      headers: { range: 'bytes=0-15' },
    })
    assert.equal(pipelineRange.status, 206)
    assert.deepEqual(
      Buffer.from(await pipelineRange.arrayBuffer()),
      pipelineBytes.subarray(0, 16),
    )

    // A second application restart must recover the completed parent, its
    // immutable child bindings, the authoritative passing report, and the
    // QC-authorized bytes without running the worker or either Provider.
    await closeServer(server)
    server = undefined
    await runtime.close()
    runtime = undefined

    runtime = await createApplication(runtimeOptions(directory))
    const pipelineRestarted = await listen(runtime)
    server = pipelineRestarted.server
    baseUrl = pipelineRestarted.baseUrl

    const recoveredPipelineResponse = await fetch(
      `${baseUrl}/api/v1/pipeline-runs/${encodeURIComponent(completedPipeline.id)}`,
    )
    assert.equal(recoveredPipelineResponse.status, 200)
    const { pipelineRun: recoveredPipeline } = await json<{
      pipelineRun: PublicPipelineRun
    }>(recoveredPipelineResponse)
    assert.equal(recoveredPipeline.status, 'succeeded')
    assert.equal(recoveredPipeline.progress, 100)
    assert.equal(recoveredPipeline.sourceRevisionId, applied.revision.id)
    assert.deepEqual(recoveredPipeline.steps, completedPipeline.steps)

    const recoveredPipelineExportResponse = await fetch(
      `${baseUrl}/api/v1/exports/${encodeURIComponent(pipelineExport.id)}`,
    )
    assert.equal(recoveredPipelineExportResponse.status, 200)
    const recoveredPipelineExport = await json<{
      export: {
        id: string
        status: string
        timelineRevisionId: string
        jobId: string
        downloadUrl: string
        outputAsset: { id: string; checksum: string }
      }
    }>(recoveredPipelineExportResponse)
    assert.equal(recoveredPipelineExport.export.status, 'succeeded')
    assert.equal(
      recoveredPipelineExport.export.timelineRevisionId,
      recoveredPipeline.steps.timeline.revisionId,
    )
    assert.equal(
      recoveredPipelineExport.export.jobId,
      recoveredPipeline.steps.export.rootJobId,
    )
    assert.equal(
      recoveredPipelineExport.export.outputAsset.checksum,
      pipelineExport.outputAsset.checksum,
    )

    const recoveredPipelineReportResponse = await fetch(
      `${baseUrl}/api/v1/quality-reports/${encodeURIComponent(pipelineReport.id)}`,
    )
    assert.equal(recoveredPipelineReportResponse.status, 200)
    const recoveredPipelineReport = await json<{
      qualityReport: {
        id: string
        exportId: string
        outputAssetId: string
        status: string
        passed: boolean
        jobId: string
      }
    }>(recoveredPipelineReportResponse)
    assert.equal(recoveredPipelineReport.qualityReport.status, 'passed')
    assert.equal(recoveredPipelineReport.qualityReport.passed, true)
    assert.equal(recoveredPipelineReport.qualityReport.exportId, pipelineExport.id)
    assert.equal(
      recoveredPipelineReport.qualityReport.outputAssetId,
      pipelineExport.outputAsset.id,
    )
    assert.equal(
      recoveredPipelineReport.qualityReport.jobId,
      recoveredPipeline.steps.quality.rootJobId,
    )

    const recoveredPipelineDownload = await fetch(
      `${baseUrl}${recoveredPipelineExport.export.downloadUrl}`,
    )
    assert.equal(recoveredPipelineDownload.status, 200)
    assert.deepEqual(
      Buffer.from(await recoveredPipelineDownload.arrayBuffer()),
      pipelineBytes,
    )
  } finally {
    if (server) await closeServer(server).catch(() => undefined)
    if (runtime) await runtime.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
