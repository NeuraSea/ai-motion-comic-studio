import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import type { StoryDocument } from './story-schema.js'
import type { ImageGenerationInput, ImageProvider, JsonObject, ProviderImage } from './types.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

class NeverCalledImageProvider implements ImageProvider {
  readonly name = 'never-called'
  readonly model = 'never-called'
  readonly configured = true
  readonly supportsImageReferences = false
  calls = 0

  async health() {
    return { status: 'ok' as const, message: 'fixture' }
  }

  async generate(input: ImageGenerationInput): Promise<ProviderImage[]> {
    this.calls += 1
    return [{ bytes: ONE_PIXEL_PNG, mimeType: 'image/png', revisedPrompt: input.prompt }]
  }
}

interface Fixture {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
  provider: NeverCalledImageProvider
}

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await new Promise<void>((resolve, reject) => item.server.close((error) => (
      error ? reject(error) : resolve()
    )))
    await item.runtime.close()
    await rm(item.directory, { recursive: true, force: true })
  }
})

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-auto-edit-http-'))
  const provider = new NeverCalledImageProvider()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider,
    autoStartWorker: false,
    requestLogSink: false,
  })
  const server = createServer(runtime.app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  const result = {
    directory,
    runtime,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    provider,
  }
  fixtures.push(result)
  return result
}

function overflowStory(): StoryDocument {
  return {
    version: 1,
    title: '对白溢出测试',
    targetDurationSeconds: 30,
    bible: {
      logline: '一句对白超出画面。',
      theme: '时间',
      tone: '克制',
      visualStyle: '国风动画',
    },
    characters: [{
      id: 'character-1',
      name: '阿离',
      role: '主角',
      storyDescription: '守望者',
      visualDescription: '黑发红衣',
    }],
    locations: [{
      id: 'location-1',
      name: '断崖',
      storyDescription: '云海之上',
      visualDescription: '落日云海',
    }],
    props: [],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '断崖',
      locationId: 'location-1',
      timeOfDay: '黄昏',
      description: '阿离看向云海。',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `S0-${index}`,
        title: `守望 ${index + 1}`,
        description: '中景守望',
        framing: '中景',
        movement: '固定',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '断崖上的少女',
        dialogueLines: index === 5 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue' as const,
          speaker: '阿离',
          text: '这是一句长对白。',
        }] : [],
      })),
    }],
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init)
  return { response, body: await response.json() as T }
}

test('HTTP preview/apply/undo is server-planned, immutable, idempotent, and makes no Provider calls', async () => {
  const { runtime, baseUrl, provider } = await fixture()
  const story = overflowStory()
  runtime.storyRepository.ensureEpisode('default', { id: 'auto-edit-episode', title: story.title })
  const project = runtime.database.getProject('default')
  assert.ok(project)
  const storyRevision = runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: project.currentRevisionId,
    summary: 'Auto edit HTTP story',
    snapshot: structuredClone(story) as unknown as JsonObject,
  })
  runtime.storyRepository.applyStory('auto-edit-episode', story, storyRevision.id)
  runtime.database.createMediaAsset({
    id: 'speech-overflow',
    projectId: 'default',
    episodeId: 'auto-edit-episode',
    kind: 'speech',
    status: 'ready',
    source: 'fixture',
    sourceRevisionId: storyRevision.id,
    mimeType: 'audio/mpeg',
    durationSeconds: 6,
    filePath: '/fixture/speech-overflow.mp3',
    checksum: 'a'.repeat(64),
  })
  runtime.database.createMediaAsset({
    id: 'storyboard-ready',
    projectId: 'default',
    episodeId: 'auto-edit-episode',
    kind: 'shot.storyboard',
    status: 'ready',
    source: 'fixture',
    sourceRevisionId: storyRevision.id,
    mimeType: 'image/png',
    filePath: '/fixture/storyboard-ready.png',
    checksum: 'b'.repeat(64),
  })
  runtime.database.withSql((sql) => sql.run(`
    UPDATE dialogue_lines
       SET speech_asset_id = 'speech-overflow', duration_seconds = 6
     WHERE json_extract(metadata_json, '$.storyId') = 'line-1'
  `))
  runtime.database.withSql((sql) => sql.run(`
    UPDATE shots SET storyboard_asset_id = 'storyboard-ready'
     WHERE scene_id IN (SELECT id FROM scenes WHERE episode_id = 'auto-edit-episode')
  `))
  const aligned = runtime.timelineMaterializationService.materialize({
    projectId: 'default',
    episodeId: 'auto-edit-episode',
    expectedRevisionId: null,
  })
  // New materialization is audio-first and already gives the final shot the
  // real six-second speech envelope. Persist a legacy five-second visual head
  // so this HTTP test continues to exercise preview/apply/undo migration.
  const legacyDocument = structuredClone(aligned.document)
  const legacyTracks = legacyDocument.tracks as unknown as {
    overlay: Array<{ id: string; elements: Array<{ duration: number }> }>
  }
  const legacyVisual = legacyTracks.overlay.find((track) => track.id === 'visual-main')
  assert.ok(legacyVisual)
  legacyVisual.elements.at(-1)!.duration = 600_000
  const base = runtime.timelineDocumentService.saveReconciled({
    projectId: 'default',
    episodeId: 'auto-edit-episode',
    expectedRevisionId: aligned.revision.id,
    schemaVersion: aligned.revision.schemaVersion,
    upstreamCommit: aligned.revision.upstreamCommit,
    sourceRevisionId: aligned.revision.sourceRevisionId!,
    summary: 'Legacy pre-audio-first visual timing',
    document: legacyDocument,
  })
  const endpoint = `${baseUrl}/api/v1/episodes/auto-edit-episode/timeline-document/auto-edit`

  const missingPrecondition = await json<{ error: { code: string } }>(`${endpoint}/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal: 'exportable', policy: 'safe' }),
  })
  assert.equal(missingPrecondition.response.status, 428)

  const injected = await json<{ error: { code: string } }>(`${endpoint}/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': base.etag },
    body: JSON.stringify({
      goal: 'exportable',
      policy: 'safe',
      operations: [{ kind: 'client-must-not-control-this' }],
    }),
  })
  assert.equal(injected.response.status, 400)
  assert.equal(injected.body.error.code, 'INVALID_AUTO_EDIT_REQUEST')

  const preview = await json<{
    timeline: { revision: { id: string } }
    plan: { id: string; confirmationToken: string; planHash: string }
    risk: string
    diagnostics: Array<{ code: string; severity: string }>
    operations: unknown[]
    changedElementIds: string[]
  }>(`${endpoint}/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': base.etag },
    body: JSON.stringify({ goal: 'exportable', policy: 'safe' }),
  })
  assert.equal(preview.response.status, 200)
  assert.equal(preview.response.headers.get('etag'), base.etag)
  assert.equal(preview.body.timeline.revision.id, base.revision.id)
  assert.ok(preview.body.plan.confirmationToken.startsWith('taec_'))
  assert.match(preview.body.plan.planHash, /^[0-9a-f]{64}$/)
  assert.equal(preview.body.risk, 'safe')
  assert.equal(preview.body.diagnostics.some((item) => item.severity === 'error'), false)
  assert.ok(preview.body.operations.length > 0)
  assert.ok(preview.body.changedElementIds.length > 0)
  assert.equal(runtime.timelineDocumentService.get('auto-edit-episode').revision.id, base.revision.id)
  assert.equal(provider.calls, 0)

  const wrongToken = await json<{ error: { code: string } }>(`${endpoint}/apply`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': base.etag,
      'idempotency-key': 'apply-wrong-token',
    },
    body: JSON.stringify({ planId: preview.body.plan.id, confirmationToken: 'wrong' }),
  })
  assert.equal(wrongToken.response.status, 409)
  assert.equal(wrongToken.body.error.code, 'AUTO_EDIT_CONFIRMATION_INVALID')

  // Asset metadata is outside the timeline CAS token. Apply must therefore
  // rerun the same semantic validator and reject a preview whose immutable
  // asset pins changed after the user saw it.
  runtime.database.withSql((sql) => sql.run(`
    UPDATE media_assets SET checksum = ? WHERE id = 'storyboard-ready'
  `, 'd'.repeat(64)))
  const changedSemanticPins = await json<{ error: { code: string } }>(`${endpoint}/apply`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': base.etag,
      'idempotency-key': 'apply-changed-semantic-pins',
    },
    body: JSON.stringify({
      planId: preview.body.plan.id,
      confirmationToken: preview.body.plan.confirmationToken,
    }),
  })
  assert.equal(changedSemanticPins.response.status, 412)
  assert.equal(changedSemanticPins.body.error.code, 'AUTO_EDIT_REVISION_CONFLICT')
  assert.equal(runtime.timelineDocumentService.get('auto-edit-episode').revision.id, base.revision.id)
  runtime.database.withSql((sql) => sql.run(`
    UPDATE media_assets SET checksum = ? WHERE id = 'storyboard-ready'
  `, 'b'.repeat(64)))

  const apply = await json<{
    timeline: { revision: { id: string; parentRevisionId: string }; document: JsonObject; etag: string }
    operationResultTimeline: { revision: { id: string }; etag: string }
    headAdvanced: boolean
    application: { id: string; planId: string; idempotencyKey?: unknown; idempotencyKeyHash?: unknown }
    idempotent: boolean
  }>(`${endpoint}/apply`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': base.etag,
      'idempotency-key': 'apply-http-1',
    },
    body: JSON.stringify({
      planId: preview.body.plan.id,
      confirmationToken: preview.body.plan.confirmationToken,
    }),
  })
  assert.equal(apply.response.status, 201)
  assert.equal(apply.body.idempotent, false)
  assert.equal(apply.body.headAdvanced, false)
  assert.equal(apply.body.operationResultTimeline.revision.id, apply.body.timeline.revision.id)
  assert.equal(apply.body.timeline.revision.parentRevisionId, base.revision.id)
  assert.equal(apply.body.application.planId, preview.body.plan.id)
  assert.equal(apply.body.application.idempotencyKey, undefined)
  assert.equal(apply.body.application.idempotencyKeyHash, undefined)
  const receipt = ((apply.body.timeline.document.manjuTimeline as JsonObject)
    .automaticEdit as JsonObject)
  assert.equal(receipt.applicationId, apply.body.application.id)
  assert.equal(receipt.policy, 'auto-applied')
  assert.equal(apply.response.headers.get('etag'), apply.body.timeline.etag)
  assert.equal(provider.calls, 0)

  const replay = await json<{
    timeline: { revision: { id: string } }
    operationResultTimeline: { revision: { id: string } }
    headAdvanced: boolean
    idempotent: boolean
  }>(
    `${endpoint}/apply`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': base.etag,
        'idempotency-key': 'apply-http-1',
      },
      body: JSON.stringify({
        planId: preview.body.plan.id,
        confirmationToken: 'not-needed-for-exact-replay',
      }),
    },
  )
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.idempotent, true)
  assert.equal(replay.body.headAdvanced, false)
  assert.equal(replay.body.timeline.revision.id, apply.body.timeline.revision.id)
  assert.equal(replay.body.operationResultTimeline.revision.id, apply.body.timeline.revision.id)

  const noOp = await json<{
    risk: string
    plan: { confirmationToken: string }
    diagnostics: Array<{ code: string; severity: string }>
    operations: unknown[]
    changedElementIds: string[]
  }>(`${endpoint}/preview`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': apply.body.timeline.etag,
    },
    body: JSON.stringify({ goal: 'exportable', policy: 'safe' }),
  })
  assert.equal(noOp.response.status, 200)
  assert.equal(noOp.body.risk, 'safe')
  assert.deepEqual(noOp.body.operations, [])
  assert.deepEqual(noOp.body.changedElementIds, [])
  assert.ok(noOp.body.diagnostics.some((item) => (
    item.code === 'TIMELINE_ALREADY_EXPORTABLE' && item.severity === 'info'
  )))

  const undoEndpoint = `${baseUrl}/api/v1/timeline-edit-applications/${apply.body.application.id}/undo`
  const undone = await json<{
    timeline: { revision: { id: string; parentRevisionId: string }; document: JsonObject; etag: string }
    operationResultTimeline: { revision: { id: string }; etag: string }
    headAdvanced: boolean
    undo: { id: string; idempotencyKey?: unknown; idempotencyKeyHash?: unknown }
    idempotent: boolean
  }>(undoEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': apply.body.timeline.etag,
      'idempotency-key': 'undo-http-1',
    },
    body: '{}',
  })
  assert.equal(undone.response.status, 201)
  assert.equal(undone.body.idempotent, false)
  assert.equal(undone.body.headAdvanced, false)
  assert.equal(undone.body.operationResultTimeline.revision.id, undone.body.timeline.revision.id)
  assert.equal(undone.body.timeline.revision.parentRevisionId, apply.body.timeline.revision.id)
  assert.deepEqual(undone.body.timeline.document, base.document)
  assert.equal(undone.body.undo.idempotencyKey, undefined)
  assert.equal(undone.body.undo.idempotencyKeyHash, undefined)
  assert.equal(provider.calls, 0)

  // The first apply response could have been lost. Retrying its exact
  // idempotency key after undo must preserve the immutable application result
  // while returning the undo revision as the authoritative head/ETag.
  const applyReplayAfterLaterRevision = await json<{
    timeline: { revision: { id: string }; etag: string }
    operationResultTimeline: { revision: { id: string } }
    headAdvanced: boolean
    idempotent: boolean
  }>(`${endpoint}/apply`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': base.etag,
      'idempotency-key': 'apply-http-1',
    },
    body: JSON.stringify({
      planId: preview.body.plan.id,
      confirmationToken: 'not-needed-after-another-tab-advanced-the-head',
    }),
  })
  assert.equal(applyReplayAfterLaterRevision.response.status, 200)
  assert.equal(applyReplayAfterLaterRevision.body.idempotent, true)
  assert.equal(applyReplayAfterLaterRevision.body.headAdvanced, true)
  assert.equal(
    applyReplayAfterLaterRevision.body.operationResultTimeline.revision.id,
    apply.body.timeline.revision.id,
  )
  assert.equal(
    applyReplayAfterLaterRevision.body.timeline.revision.id,
    undone.body.timeline.revision.id,
  )
  assert.equal(
    applyReplayAfterLaterRevision.response.headers.get('etag'),
    undone.body.timeline.etag,
  )

  const laterHead = runtime.timelineDocumentService.save({
    projectId: 'default',
    episodeId: 'auto-edit-episode',
    expectedRevisionId: undone.body.timeline.revision.id,
    schemaVersion: base.revision.schemaVersion,
    upstreamCommit: base.revision.upstreamCommit,
    summary: 'Other tab after undo response was lost',
    document: { ...structuredClone(undone.body.timeline.document), otherTab: true },
  })

  const undoReplay = await json<{
    timeline: { revision: { id: string }; etag: string }
    operationResultTimeline: { revision: { id: string } }
    headAdvanced: boolean
    idempotent: boolean
  }>(
    undoEndpoint,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': apply.body.timeline.etag,
        'idempotency-key': 'undo-http-1',
      },
      body: '{}',
    },
  )
  assert.equal(undoReplay.response.status, 200)
  assert.equal(undoReplay.body.idempotent, true)
  assert.equal(undoReplay.body.headAdvanced, true)
  assert.equal(undoReplay.body.timeline.revision.id, laterHead.revision.id)
  assert.equal(undoReplay.response.headers.get('etag'), laterHead.etag)
  assert.equal(
    undoReplay.body.operationResultTimeline.revision.id,
    undone.body.timeline.revision.id,
  )
})

test('HTTP preview reports a visual gap as blocked instead of claiming a noop is exportable', async () => {
  const { runtime, baseUrl, provider } = await fixture()
  const story = overflowStory()
  story.scenes[0]!.shots[5]!.dialogueLines = []
  const episodeId = 'blocked-gap-episode'
  runtime.storyRepository.ensureEpisode('default', { id: episodeId, title: story.title })
  const project = runtime.database.getProject('default')
  assert.ok(project)
  const storyRevision = runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: project.currentRevisionId,
    summary: 'Blocked gap story',
    snapshot: structuredClone(story) as unknown as JsonObject,
  })
  runtime.storyRepository.applyStory(episodeId, story, storyRevision.id)
  runtime.database.createMediaAsset({
    id: 'blocked-gap-storyboard',
    projectId: 'default',
    episodeId,
    kind: 'shot.storyboard',
    status: 'ready',
    source: 'fixture',
    sourceRevisionId: storyRevision.id,
    mimeType: 'image/png',
    filePath: '/fixture/blocked-gap-storyboard.png',
    checksum: 'c'.repeat(64),
  })
  runtime.database.withSql((sql) => sql.run(`
    UPDATE shots SET storyboard_asset_id = 'blocked-gap-storyboard'
     WHERE scene_id IN (SELECT id FROM scenes WHERE episode_id = ?)
  `, episodeId))
  const base = runtime.timelineMaterializationService.materialize({
    projectId: 'default',
    episodeId,
    expectedRevisionId: null,
  })
  const document = structuredClone(base.document)
  const tracks = document.tracks as unknown as {
    overlay: Array<{ type: string; elements: Array<{ startTime: number }> }>
  }
  const visualTrack = tracks.overlay.find((track) => track.type === 'video')
  assert.ok(visualTrack)
  // Shift the tail by one second. This is a valid OpenCut edit, but formal
  // export cannot render the resulting visual gap and safe auto-edit must not
  // guess whether to close it or fill it.
  visualTrack.elements.slice(1).forEach((element) => { element.startTime += 120_000 })
  const gapped = runtime.timelineDocumentService.saveReconciled({
    projectId: 'default',
    episodeId,
    expectedRevisionId: base.revision.id,
    schemaVersion: base.revision.schemaVersion,
    upstreamCommit: base.revision.upstreamCommit,
    sourceRevisionId: storyRevision.id,
    summary: 'Manual visual gap',
    document,
  })
  const endpoint = `${baseUrl}/api/v1/episodes/${episodeId}/timeline-document/auto-edit`
  const preview = await json<{
    risk: string
    plan: { id: string; confirmationToken: string; risk: string }
    diagnostics: Array<{ code: string; severity: string; message: string }>
    operations: unknown[]
    changedElementIds: string[]
  }>(`${endpoint}/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': gapped.etag },
    body: JSON.stringify({ goal: 'exportable', policy: 'safe' }),
  })
  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.risk, 'blocked')
  assert.equal(preview.body.plan.risk, 'blocked')
  assert.deepEqual(preview.body.operations, [])
  assert.deepEqual(preview.body.changedElementIds, [])
  assert.equal(preview.body.diagnostics.some((item) => (
    item.code === 'TIMELINE_ALREADY_EXPORTABLE'
  )), false)
  assert.ok(preview.body.diagnostics.some((item) => (
    item.code === 'UNSAFE_VISUAL_GAP_OR_OVERLAP'
      && item.severity === 'error'
      && item.message.includes('空隙或重叠')
  )))

  const blockedApply = await json<{ error: { code: string } }>(`${endpoint}/apply`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': gapped.etag,
      'idempotency-key': 'blocked-gap-apply',
    },
    body: JSON.stringify({
      planId: preview.body.plan.id,
      confirmationToken: preview.body.plan.confirmationToken,
    }),
  })
  assert.equal(blockedApply.response.status, 409)
  assert.equal(blockedApply.body.error.code, 'AUTO_EDIT_BLOCKED')
  assert.equal(runtime.timelineDocumentService.get(episodeId).revision.id, gapped.revision.id)
  assert.equal(provider.calls, 0)
})
