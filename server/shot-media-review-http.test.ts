import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app-v1.js'
import type {
  ImageGenerationInput,
  ImageProvider,
  ProviderImage,
} from './types.js'

class NoopImageProvider implements ImageProvider {
  readonly name = 'noop-image'
  readonly model = 'noop-image'
  readonly configured = true

  async health() {
    return { status: 'ok' as const, message: 'ready' }
  }

  async generate(input: ImageGenerationInput): Promise<ProviderImage[]> {
    return Array.from({ length: input.count }, () => ({
      bytes: Buffer.from('unused'),
      mimeType: 'image/png',
    }))
  }
}

interface Fixture {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
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
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return `http://127.0.0.1:${address.port}`
}

function seed(runtime: ApplicationRuntime): void {
  const { database } = runtime
  const now = '2026-07-15T00:00:00.000Z'
  database.createProject({ id: 'review-http-project', title: 'Review HTTP' })
  database.createRevision({
    id: 'review-http-story',
    projectId: 'review-http-project',
    summary: 'Story',
    snapshot: { version: 1 },
  })
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, aspect_ratio, style_preset, status,
        sort_order, source_revision_id, created_at, updated_at
      ) VALUES (?, ?, 'Episode', '', '16:9', '', 'draft', 0, ?, ?, ?)
    `, 'review-http-episode', 'review-http-project', 'review-http-story', now, now)
    sql.run(`
      INSERT INTO scenes (
        id, episode_id, sequence, title, metadata_json, created_at, updated_at
      ) VALUES (?, ?, 0, 'Scene', ?, ?, ?)
    `, 'review-http-scene-row', 'review-http-episode', JSON.stringify({ storyId: 'scene-1' }), now, now)
    for (const [index, rowId, storyId] of [
      [0, 'review-http-shot-row-1', 'shot-1'],
      [1, 'review-http-shot-row-2', 'shot-2'],
    ] as const) {
      sql.run(`
        INSERT INTO shots (
          id, scene_id, sequence, title, duration_seconds, status,
          source_revision_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 5, 'storyboard_ready', ?, ?, ?, ?)
      `,
      rowId,
      'review-http-scene-row',
      index,
      storyId,
      'review-http-story',
      JSON.stringify({ storyId }),
      now,
      now,
      )
    }
  })
  for (const [index, assetId, shotRowId, shotId] of [
    [0, 'review-http-asset-a', 'review-http-shot-row-1', 'shot-1'],
    [1, 'review-http-asset-b', 'review-http-shot-row-1', 'shot-1'],
    [2, 'review-http-other-shot', 'review-http-shot-row-2', 'shot-2'],
  ] as const) {
    const jobId = `review-http-job-${index}`
    database.createGenerationJob({
      id: jobId,
      projectId: 'review-http-project',
      episodeId: 'review-http-episode',
      type: 'asset.image.generate',
      status: 'succeeded',
      progress: 100,
      input: {
        metadata: { kind: 'storyboard' },
        storyboardBinding: {
          episodeId: 'review-http-episode',
          shotId,
          sceneId: 'scene-1',
          databaseShotId: shotRowId,
          expectedRevisionId: 'review-http-story',
        },
      },
    })
    database.createMediaAsset({
      id: assetId,
      projectId: 'review-http-project',
      episodeId: 'review-http-episode',
      kind: 'storyboard',
      status: 'ready',
      filePath: `media/review-http-project/${assetId}.png`,
      mimeType: 'image/png',
      width: 1280,
      height: 720,
      checksum: String(index + 1).repeat(64),
      source: 'provider',
      generationJobId: jobId,
      generationParameters: {
        shotId,
        sceneId: 'scene-1',
        sourceRevisionId: 'review-http-story',
      },
      sourceRevisionId: 'review-http-story',
      createdAt: `2026-07-15T00:0${index}:00.000Z`,
      updatedAt: `2026-07-15T00:0${index}:00.000Z`,
    })
  }
  database.withSql((sql) => sql.run(`
    UPDATE shots SET storyboard_asset_id = 'review-http-asset-a'
     WHERE id = 'review-http-shot-row-1'
  `))
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-shot-media-review-http-'))
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider: new NoopImageProvider(),
    autoStartWorker: false,
    requestLogSink: false,
  })
  seed(runtime)
  const server = createServer(runtime.app)
  const value = { directory, runtime, server, baseUrl: await listen(server) }
  fixtures.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ directory, runtime, server }) => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }))
})

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>
}

test('shot media review HTTP contract lists candidates and enforces ETag plus exact idempotency', async () => {
  const value = await fixture()
  const url = new URL('/api/v1/shots/shot-1/media-review', value.baseUrl)
  url.searchParams.set('projectId', 'review-http-project')
  url.searchParams.set('episodeId', 'review-http-episode')
  url.searchParams.set('sceneId', 'scene-1')
  url.searchParams.set('mediaType', 'storyboard')

  const listed = await fetch(url)
  assert.equal(listed.status, 200)
  const firstEtag = listed.headers.get('etag')
  assert.ok(firstEtag)
  const listBody = await json(listed)
  assert.equal(listBody.mediaReview.currentSelectionAssetId, 'review-http-asset-a')
  assert.deepEqual(
    listBody.mediaReview.candidates.map((candidate: { id: string }) => candidate.id),
    ['review-http-asset-b', 'review-http-asset-a'],
  )
  assert.deepEqual(listBody.mediaReview.history, [])

  const requestBody = {
    projectId: 'review-http-project',
    episodeId: 'review-http-episode',
    sceneId: 'scene-1',
    mediaType: 'storyboard',
    decision: 'adopt',
    assetId: 'review-http-asset-b',
    note: 'Approved B',
  }
  const missingPrecondition = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'review-http-adopt-b' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(missingPrecondition.status, 428)
  assert.equal((await json(missingPrecondition)).error.code, 'PRECONDITION_REQUIRED')

  const missingKey = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': firstEtag! },
    body: JSON.stringify(requestBody),
  })
  assert.equal(missingKey.status, 400)
  assert.equal((await json(missingKey)).error.code, 'IDEMPOTENCY_KEY_REQUIRED')

  const adopted = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': firstEtag!,
      'idempotency-key': 'review-http-adopt-b',
    },
    body: JSON.stringify(requestBody),
  })
  assert.equal(adopted.status, 201)
  const secondEtag = adopted.headers.get('etag')
  assert.ok(secondEtag)
  assert.notEqual(secondEtag, firstEtag)
  const adoptedBody = await json(adopted)
  assert.equal(adoptedBody.mediaReview.currentSelectionAssetId, 'review-http-asset-b')
  assert.equal(adoptedBody.mediaReview.clearedVideoAssetId, null)
  assert.equal(adoptedBody.mediaReview.review.clearedVideoAssetId, null)
  assert.equal(adoptedBody.mediaReview.review.stale.shotVideoJobs, 0)
  assert.equal(adoptedBody.mediaReview.timelineReconcileRequired, true)
  assert.equal(adoptedBody.mediaReview.idempotent, false)

  const replay = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': firstEtag!,
      'idempotency-key': 'review-http-adopt-b',
    },
    body: JSON.stringify(requestBody),
  })
  assert.equal(replay.status, 200)
  const replayBody = await json(replay)
  assert.equal(replayBody.mediaReview.idempotent, true)
  assert.equal(replayBody.mediaReview.review.id, adoptedBody.mediaReview.review.id)

  const conflict = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': firstEtag!,
      'idempotency-key': 'review-http-adopt-b',
    },
    body: JSON.stringify({ ...requestBody, decision: 'reject', assetId: 'review-http-asset-a' }),
  })
  assert.equal(conflict.status, 409)
  assert.equal((await json(conflict)).error.code, 'IDEMPOTENCY_CONFLICT')

  const stale = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': firstEtag!,
      'idempotency-key': 'review-http-stale',
    },
    body: JSON.stringify({ ...requestBody, decision: 'restore', assetId: 'review-http-asset-a' }),
  })
  assert.equal(stale.status, 412)
  assert.equal((await json(stale)).error.code, 'PRECONDITION_FAILED')

  const crossShot = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': secondEtag!,
      'idempotency-key': 'review-http-cross-shot',
    },
    body: JSON.stringify({ ...requestBody, assetId: 'review-http-other-shot' }),
  })
  assert.equal(crossShot.status, 409)
  assert.equal((await json(crossShot)).error.code, 'INVALID_MEDIA_CANDIDATE')
})
