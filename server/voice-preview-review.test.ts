import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app-v1.js'
import { VoicePreviewReviewError } from './voice-preview-review.js'
import type { JsonObject } from './types.js'

const cleanups: Array<() => Promise<void>> = []
const playbackEvidence = {
  version: 'html-media-played-v1' as const,
  durationSeconds: 2,
  ranges: [{ startSeconds: 0, endSeconds: 2 }],
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function fixture(type: 'character.voice.preview' | 'project.narrator.voice.preview' = 'character.voice.preview') {
  const directory = await mkdtemp(join(tmpdir(), 'manju-voice-preview-review-'))
  const runtime = await createApplication({ runtimeDirectory: directory, autoStartWorker: false })
  cleanups.push(async () => {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })
  const projectId = 'default'
  const episodeId = `voice-review-episode-${randomUUID()}`
  const storyRevisionId = `voice-review-story-${randomUUID()}`
  runtime.database.createRevision({
    id: storyRevisionId,
    projectId,
    summary: 'voice preview review story',
    snapshot: {},
  })
  runtime.database.withSql((sql) => sql.run(`
    INSERT INTO episodes (
      id, project_id, title, source_text, aspect_ratio, style_preset, status,
      sort_order, metadata_json, source_revision_id, created_at, updated_at
    ) VALUES (?, ?, '试听验收', '', '16:9', '', 'draft', 100, '{}', ?, ?, ?)
  `, episodeId, projectId, storyRevisionId, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'))
  const provider = runtime.database.getProviderConnection('minimax-speech')!
  const job = runtime.database.createGenerationJob({
    projectId,
    episodeId,
    type,
    status: 'queued',
    resourceType: type === 'character.voice.preview' ? 'character' : 'project',
    resourceId: type === 'character.voice.preview' ? 'character-db-ali' : projectId,
    providerId: provider.id,
    providerConfigRevision: provider.configRevision,
    model: provider.defaultModel,
    input: {
      episodeId,
      ...(type === 'character.voice.preview'
        ? { characterId: 'ali', characterDatabaseId: 'character-db-ali' }
        : {}),
      expectedStoryRevisionId: storyRevisionId,
      voiceId: 'female-shaonv-jingpin',
      expectedCatalogFingerprint: 'a'.repeat(64),
      expectedProviderConfigRevision: provider.configRevision,
    } as JsonObject,
  })
  const asset = await runtime.mediaStore.save({
    projectId,
    episodeId,
    kind: type,
    bytes: Buffer.from('ID3voice-preview-review'),
    mimeType: 'audio/mpeg',
    source: 'provider',
    providerId: provider.id,
    generationJobId: job.id,
    sourceRevisionId: storyRevisionId,
    durationSeconds: 2,
  })
  runtime.database.updateGenerationJob(job.id, {
    status: 'succeeded',
    progress: 100,
    output: { asset: { id: asset.id } },
    completedAt: '2026-07-15T00:01:00.000Z',
  })
  return { runtime, projectId, episodeId, storyRevisionId, provider, job, asset }
}

test('records a playback-complete decision without creating a Provider job and restores it', async () => {
  const value = await fixture()
  const jobsBefore = value.runtime.database.listGenerationJobs({ projectId: value.projectId }).length
  const created = value.runtime.voicePreviewReviewService.create({
    projectId: value.projectId,
    previewJobId: value.job.id,
    idempotencyKey: 'approve-once',
    decision: 'approve',
    playbackCompleted: true,
    playbackEvidence,
  })
  assert.equal(created.created, true)
  assert.equal(created.review.subjectType, 'character')
  assert.equal(created.review.subjectId, 'ali')
  assert.equal(created.review.previewAssetId, value.asset.id)
  assert.equal(created.review.previewAssetChecksum, value.asset.checksum)
  assert.equal(created.review.decision, 'approve')
  assert.deepEqual(created.review.playbackEvidence, playbackEvidence)
  assert.equal(created.review.isCurrent, true)
  assert.equal(value.runtime.database.listGenerationJobs({ projectId: value.projectId }).length, jobsBefore)

  const restored = value.runtime.voicePreviewReviewService.list(value.projectId, value.job.id)
  assert.equal(restored.length, 1)
  assert.equal(restored[0]?.id, created.review.id)
  assert.throws(
    () => value.runtime.database.withSql((sql) => sql.run(
      "UPDATE voice_preview_reviews SET decision = 'reject' WHERE id = ?",
      created.review.id,
    )),
    /immutable/,
  )
  assert.throws(
    () => value.runtime.database.withSql((sql) => sql.run(
      'DELETE FROM voice_preview_reviews WHERE id = ?',
      created.review.id,
    )),
    /immutable/,
  )
})

test('rejects decisions without full playback and requires a rejection reason', async () => {
  const value = await fixture('project.narrator.voice.preview')
  assert.throws(
    () => value.runtime.voicePreviewReviewService.create({
      projectId: value.projectId,
      previewJobId: value.job.id,
      idempotencyKey: 'not-played',
      decision: 'approve',
      playbackCompleted: false,
      playbackEvidence,
    }),
    (error: unknown) => error instanceof VoicePreviewReviewError
      && error.code === 'INVALID_VOICE_PREVIEW_REVIEW'
      && /完整播放/.test(error.message),
  )
  assert.throws(
    () => value.runtime.voicePreviewReviewService.create({
      projectId: value.projectId,
      previewJobId: value.job.id,
      idempotencyKey: 'reject-no-note',
      decision: 'reject',
      playbackCompleted: true,
      playbackEvidence,
    }),
    (error: unknown) => error instanceof VoicePreviewReviewError
      && error.code === 'INVALID_VOICE_PREVIEW_REVIEW'
      && /原因/.test(error.message),
  )
  assert.throws(
    () => value.runtime.voicePreviewReviewService.create({
      projectId: value.projectId,
      previewJobId: value.job.id,
      idempotencyKey: 'played-with-gap',
      decision: 'approve',
      playbackCompleted: true,
      playbackEvidence: {
        version: 'html-media-played-v1',
        durationSeconds: 2,
        ranges: [
          { startSeconds: 0, endSeconds: 0.5 },
          { startSeconds: 1.5, endSeconds: 2 },
        ],
      },
    }),
    (error: unknown) => error instanceof VoicePreviewReviewError
      && error.code === 'INVALID_VOICE_PREVIEW_REVIEW'
      && /跳播/.test(error.message),
  )
  assert.throws(
    () => value.runtime.voicePreviewReviewService.create({
      projectId: value.projectId,
      previewJobId: value.job.id,
      idempotencyKey: 'wrong-media-duration',
      decision: 'approve',
      playbackCompleted: true,
      playbackEvidence: {
        version: 'html-media-played-v1',
        durationSeconds: 3,
        ranges: [{ startSeconds: 0, endSeconds: 3 }],
      },
    }),
    (error: unknown) => error instanceof VoicePreviewReviewError
      && error.code === 'INVALID_VOICE_PREVIEW_REVIEW'
      && /Asset/.test(error.message),
  )
})

test('idempotent replay returns the same audit row and conflicting reuse is rejected', async () => {
  const value = await fixture()
  const input = {
    projectId: value.projectId,
    previewJobId: value.job.id,
    idempotencyKey: 'same-review-key',
    decision: 'approve' as const,
    playbackCompleted: true,
    playbackEvidence,
    notes: '音色清晰，符合角色年龄。',
  }
  const created = value.runtime.voicePreviewReviewService.create(input)
  const replay = value.runtime.voicePreviewReviewService.create(input)
  assert.equal(replay.created, false)
  assert.equal(replay.review.id, created.review.id)
  assert.throws(
    () => value.runtime.voicePreviewReviewService.create({
      ...input,
      decision: 'reject',
      notes: '情绪太平。',
    }),
    (error: unknown) => error instanceof VoicePreviewReviewError
      && error.code === 'IDEMPOTENCY_CONFLICT',
  )
})

test('superseding decisions remain immutable history and Story drift invalidates acceptance', async () => {
  const value = await fixture()
  const approved = value.runtime.voicePreviewReviewService.create({
    projectId: value.projectId,
    previewJobId: value.job.id,
    idempotencyKey: 'first-review',
    decision: 'approve',
    playbackCompleted: true,
    playbackEvidence,
  })
  const rejected = value.runtime.voicePreviewReviewService.create({
    projectId: value.projectId,
    previewJobId: value.job.id,
    idempotencyKey: 'second-review',
    decision: 'reject',
    notes: '完整复听后发现情绪不匹配。',
    playbackCompleted: true,
    playbackEvidence,
  })
  assert.equal(rejected.review.isCurrent, true)
  assert.ok(Date.parse(rejected.review.reviewedAt) > Date.parse(approved.review.reviewedAt))
  const history = value.runtime.voicePreviewReviewService.list(value.projectId, value.job.id)
  assert.deepEqual(history.map((item) => item.decision), ['reject', 'approve'])
  assert.deepEqual(history[1]?.invalidReasons, ['SUPERSEDED'])

  const nextRevision = value.runtime.database.createRevision({
    projectId: value.projectId,
    summary: 'next story',
    snapshot: {},
  })
  value.runtime.database.withSql((sql) => sql.run(
    'UPDATE episodes SET source_revision_id = ? WHERE id = ?',
    nextRevision.id,
    value.episodeId,
  ))
  const drifted = value.runtime.voicePreviewReviewService.list(value.projectId, value.job.id)
  assert.ok(drifted[0]?.invalidReasons.includes('STORY_REVISION_CHANGED'))
  assert.equal(drifted[0]?.isCurrent, false)
  assert.notEqual(approved.review.id, rejected.review.id)
})

test('HTTP review endpoints persist and restore the exact successful preview without paid confirmation', async () => {
  const value = await fixture()
  const server = createServer(value.runtime.app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const root = `http://127.0.0.1:${address.port}`
    const posted = await fetch(`${root}/api/v1/jobs/${value.job.id}/voice-preview-reviews`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-voice-review',
      },
      body: JSON.stringify({
        projectId: value.projectId,
        decision: 'approve',
        playbackCompleted: true,
        playbackEvidence,
      }),
    })
    assert.equal(posted.status, 201)
    const postedBody = await posted.json() as {
      review: { previewJobId: string; previewAssetId: string; playbackEvidence: unknown }
    }
    assert.equal(postedBody.review.previewJobId, value.job.id)
    assert.equal(postedBody.review.previewAssetId, value.asset.id)
    assert.deepEqual(postedBody.review.playbackEvidence, playbackEvidence)

    const restored = await fetch(
      `${root}/api/v1/jobs/${value.job.id}/voice-preview-reviews?projectId=${value.projectId}`,
    )
    assert.equal(restored.status, 200)
    const restoredBody = await restored.json() as { reviews: Array<{ id: string }> }
    assert.equal(restoredBody.reviews.length, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )))
  }
})
