import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app-v1.js'
import type { QualityCheckResult } from './quality-check.js'
import { ReleaseReviewError } from './release-review.js'

const NOW = '2026-07-15T00:00:00.000Z'
const OPEN_CUT_COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'
const MP4 = Buffer.from('0000ftypisom-release-review-test')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

function passingChecks(): QualityCheckResult[] {
  return [
    { id: 'decodable', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
    { id: 'ffprobe.specification', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
    { id: 'video.black-frames', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
    { id: 'audio.silence', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
    { id: 'audio.peak', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
    { id: 'subtitle.timing', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
    { id: 'subtitle.safe-area', status: 'passed', severity: 'info', message: 'ok', metrics: {} },
  ]
}

interface SeededRelease {
  projectId: string
  episodeId: string
  storyRevisionId: string
  timelineRevisionId: string
  exportId: string
  assetId: string
  qualityReportId: string
}

async function seedPassedRelease(runtime: ApplicationRuntime): Promise<SeededRelease> {
  const { project } = runtime.projectService.ensureDefaultProject()
  const projectId = project.id
  const episodeId = `release-episode-${randomUUID()}`
  const storyRevisionId = `release-story-${randomUUID()}`
  const exportId = `release-export-${randomUUID()}`
  const assetId = `release-asset-${randomUUID()}`
  runtime.database.createRevision({
    id: storyRevisionId,
    projectId,
    summary: 'release review story',
    snapshot: {},
    createdAt: NOW,
  })
  runtime.database.withSql((sql) => sql.run(`
    INSERT INTO episodes (
      id, project_id, title, source_text, aspect_ratio, style_preset, status,
      sort_order, metadata_json, source_revision_id, created_at, updated_at
    ) VALUES (?, ?, '发行复验', '', '16:9', '', 'draft', 0, '{}', ?, ?, ?)
  `, episodeId, projectId, storyRevisionId, NOW, NOW))
  const timeline = runtime.timelineDocumentService.saveReconciled({
    projectId,
    episodeId,
    expectedRevisionId: null,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    sourceRevisionId: storyRevisionId,
    document: {
      version: 1,
      tracks: {
        overlay: [],
        main: { id: 'main', type: 'video', elements: [] },
        audio: [],
      },
    },
  })
  const timelineRevisionId = timeline.revision.id
  const asset = await runtime.mediaStore.save({
    id: assetId,
    projectId,
    episodeId,
    kind: 'export.video',
    bytes: MP4,
    mimeType: 'video/mp4',
    source: 'renderer',
    sourceRevisionId: storyRevisionId,
    width: 1280,
    height: 720,
    durationSeconds: 1,
    generationParameters: {
      timelineRevisionId,
      storyRevisionId,
      resolution: '720p',
      frameRate: 24,
    },
  })
  runtime.database.withSql((sql) => sql.run(`
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
    timelineDocumentId: timeline.timelineDocument.id,
    timelineRevisionId,
    storyRevisionId,
    ticksPerSecond: 120_000,
    frameRate: 24,
    visualClips: [{
      id: 'release-clip',
      startFrame: 0,
      durationFrames: 24,
      assetId: 'immutable-visual',
      fit: 'cover',
    }],
    audioClips: [],
    subtitleCues: [],
  }),
  asset.id,
  JSON.stringify({
    version: 1,
    resolution: '720p',
    aspectRatio: '16:9',
    kenBurns: false,
    burnSubtitles: true,
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

  const quality = runtime.qualityCheckService.create({
    exportId,
    idempotencyKey: `release-quality-${randomUUID()}`,
  })
  const document = structuredClone(quality.report.document)
  document.checks = passingChecks()
  document.summary = { passed: true, failedChecks: 0, warningChecks: 0 }
  document.metrics = { source: 'release-review-test' }
  runtime.database.withSql((sql) => sql.run(`
    UPDATE quality_reports
       SET status = 'passed', checks_json = ?, passed = 1, completed_at = ?
     WHERE id = ?
  `, JSON.stringify(document), NOW, quality.report.id))

  return {
    projectId,
    episodeId,
    storyRevisionId,
    timelineRevisionId,
    exportId,
    assetId,
    qualityReportId: quality.report.id,
  }
}

async function runtimeFixture(): Promise<{
  directory: string
  runtime: ApplicationRuntime
  seeded: SeededRelease
}> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-release-review-'))
  const runtime = await createApplication({
    runtimeDirectory: directory,
    autoStartWorker: false,
  })
  const seeded = await seedPassedRelease(runtime)
  cleanups.push(async () => {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, runtime, seeded }
}

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

const approvedChecklist = {
  audioVideoSync: true,
  subtitleSyncAndComplete: true,
  characterVisualSemantics: true,
}

test('release review is immutable, idempotent, exact-bound, and invalidated by timeline drift', async () => {
  const { runtime, seeded } = await runtimeFixture()
  const created = runtime.releaseReviewService.create({
    exportId: seeded.exportId,
    idempotencyKey: 'manual-review-once',
    decision: 'approve',
    checklist: approvedChecklist,
  })
  assert.equal(created.created, true)
  assert.equal(created.releaseReview.projectId, seeded.projectId)
  assert.equal(created.releaseReview.outputAssetId, seeded.assetId)
  assert.equal(created.releaseReview.timelineRevisionId, seeded.timelineRevisionId)
  assert.equal(created.releaseReview.storyRevisionId, seeded.storyRevisionId)
  assert.equal(created.releaseReview.qualityReportId, seeded.qualityReportId)
  assert.equal(created.releaseReview.qualityPolicyVersion, 2)
  assert.equal(created.releaseReview.notes, null)
  assert.equal(created.releaseReview.isCurrent, true)
  assert.deepEqual(created.releaseReview.invalidReasons, [])

  const replay = runtime.releaseReviewService.create({
    exportId: seeded.exportId,
    idempotencyKey: 'manual-review-once',
    decision: 'approve',
    checklist: approvedChecklist,
  })
  assert.equal(replay.created, false)
  assert.equal(replay.releaseReview.id, created.releaseReview.id)
  assert.throws(
    () => runtime.releaseReviewService.create({
      exportId: seeded.exportId,
      idempotencyKey: 'manual-review-once',
      decision: 'reject',
      checklist: { ...approvedChecklist, audioVideoSync: false },
    }),
    (error: unknown) => error instanceof ReleaseReviewError
      && error.code === 'IDEMPOTENCY_CONFLICT',
  )

  const stored = runtime.database.withSql((sql) => sql.get(
    'SELECT * FROM release_reviews WHERE id = ?',
    created.releaseReview.id,
  ))
  assert.equal(stored?.quality_report_id, seeded.qualityReportId)
  assert.equal(typeof stored?.idempotency_key_hash, 'string')
  assert.notEqual(stored?.idempotency_key_hash, 'manual-review-once')
  assert.throws(
    () => runtime.database.withSql((sql) => sql.run(
      `UPDATE release_reviews SET notes = 'rewritten' WHERE id = ?`,
      created.releaseReview.id,
    )),
    /release reviews are immutable/,
  )
  assert.throws(
    () => runtime.database.withSql((sql) => sql.run(
      'DELETE FROM release_reviews WHERE id = ?',
      created.releaseReview.id,
    )),
    /release reviews are immutable/,
  )
  assert.equal(
    runtime.releaseReviewService.requireReleaseAuthorization(seeded.exportId).releaseReview.id,
    created.releaseReview.id,
  )

  const timeline = runtime.timelineDocumentService.get(seeded.episodeId)
  const next = runtime.timelineDocumentService.saveReconciled({
    projectId: seeded.projectId,
    episodeId: seeded.episodeId,
    expectedRevisionId: timeline.timelineDocument.currentRevisionId,
    schemaVersion: timeline.revision.schemaVersion,
    upstreamCommit: timeline.revision.upstreamCommit,
    sourceRevisionId: seeded.storyRevisionId,
    document: timeline.document,
  })
  assert.notEqual(next.revision.id, seeded.timelineRevisionId)
  const [stale] = runtime.releaseReviewService.list(seeded.exportId)
  assert.equal(stale.isCurrent, false)
  assert.deepEqual(stale.invalidReasons, ['TIMELINE_REVISION_CHANGED'])
  assert.throws(
    () => runtime.releaseReviewService.requireReleaseAuthorization(seeded.exportId),
    (error: unknown) => error instanceof ReleaseReviewError
      && error.code === 'RELEASE_REVIEW_STALE',
  )
  assert.equal(runtime.database.deleteProject(seeded.projectId), true)
  assert.equal(runtime.database.withSql((sql) => sql.get(
    'SELECT id FROM release_reviews WHERE id = ?',
    created.releaseReview.id,
  )), undefined)
})

test('HTTP keeps technical review download separate from approved release download', async () => {
  const { runtime, seeded } = await runtimeFixture()
  const { server, baseUrl } = await listen(runtime)
  cleanups.push(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  })

  const exportResponse = await fetch(`${baseUrl}/api/v1/exports/${seeded.exportId}`)
  assert.equal(exportResponse.status, 200)
  const exported = await exportResponse.json() as {
    export: { downloadUrl: string; reviewDownloadUrl: string }
  }
  assert.equal(
    exported.export.reviewDownloadUrl,
    `/api/v1/exports/${encodeURIComponent(seeded.exportId)}/review-download`,
  )

  const reviewDownload = await fetch(`${baseUrl}${exported.export.reviewDownloadUrl}`)
  assert.equal(reviewDownload.status, 200)
  assert.deepEqual(Buffer.from(await reviewDownload.arrayBuffer()), MP4)
  assert.match(reviewDownload.headers.get('content-disposition') ?? '', /manju-review-/)
  const reviewHead = await fetch(`${baseUrl}${exported.export.reviewDownloadUrl}`, { method: 'HEAD' })
  assert.equal(reviewHead.status, 200)
  assert.equal(reviewHead.headers.get('content-length'), String(MP4.length))

  const blockedRelease = await fetch(`${baseUrl}${exported.export.downloadUrl}`)
  assert.equal(blockedRelease.status, 423)
  assert.equal(
    (await blockedRelease.json() as { error: { code: string } }).error.code,
    'RELEASE_REVIEW_REQUIRED',
  )
  const genericAsset = await fetch(`${baseUrl}/api/v1/assets/${seeded.assetId}/content`)
  assert.equal(genericAsset.status, 423)
  assert.equal(
    (await genericAsset.json() as { error: { code: string } }).error.code,
    'EXPORT_QC_GATE_REQUIRED',
  )

  const reviewUrl = `${baseUrl}/api/v1/exports/${seeded.exportId}/release-reviews`
  const missingKey = await fetch(reviewUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', checklist: approvedChecklist }),
  })
  assert.equal(missingKey.status, 400)
  assert.equal(
    (await missingKey.json() as { error: { code: string } }).error.code,
    'IDEMPOTENCY_KEY_REQUIRED',
  )

  const invalid = await fetch(reviewUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'invalid-approval' },
    body: JSON.stringify({
      decision: 'approve',
      checklist: { ...approvedChecklist, subtitleSyncAndComplete: false },
    }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(
    (await invalid.json() as { error: { code: string } }).error.code,
    'INVALID_RELEASE_REVIEW',
  )

  const request = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'http-approval-once',
    },
    body: JSON.stringify({ decision: 'approve', checklist: approvedChecklist }),
  } satisfies RequestInit
  const approved = await fetch(reviewUrl, request)
  assert.equal(approved.status, 201)
  const approvedBody = await approved.json() as {
    releaseReview: {
      id: string
      notes: string | null
      isCurrent: boolean
      invalidReasons: string[]
      idempotencyKeyHash?: unknown
    }
  }
  assert.equal(approvedBody.releaseReview.notes, null)
  assert.equal(approvedBody.releaseReview.isCurrent, true)
  assert.deepEqual(approvedBody.releaseReview.invalidReasons, [])
  assert.equal(approvedBody.releaseReview.idempotencyKeyHash, undefined)
  const replay = await fetch(reviewUrl, request)
  assert.equal(replay.status, 200)
  assert.equal(
    (await replay.json() as { releaseReview: { id: string } }).releaseReview.id,
    approvedBody.releaseReview.id,
  )

  const list = await fetch(reviewUrl)
  assert.equal(list.status, 200)
  const listed = await list.json() as { releaseReviews: Array<{ id: string }> }
  assert.deepEqual(listed.releaseReviews.map((item) => item.id), [approvedBody.releaseReview.id])

  const released = await fetch(`${baseUrl}${exported.export.downloadUrl}`, {
    headers: { range: 'bytes=0-3' },
  })
  assert.equal(released.status, 206)
  assert.deepEqual(Buffer.from(await released.arrayBuffer()), MP4.subarray(0, 4))
  assert.match(released.headers.get('content-disposition') ?? '', /manju-release-export-/)

  const rejected = await fetch(reviewUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'http-reject' },
    body: JSON.stringify({
      decision: 'reject',
      checklist: { ...approvedChecklist, characterVisualSemantics: false },
      notes: '角色表情不符合剧本',
    }),
  })
  assert.equal(rejected.status, 201)
  const rejectedRelease = await fetch(`${baseUrl}${exported.export.downloadUrl}`)
  assert.equal(rejectedRelease.status, 423)
  assert.equal(
    (await rejectedRelease.json() as { error: { code: string } }).error.code,
    'RELEASE_REVIEW_REJECTED',
  )
})
