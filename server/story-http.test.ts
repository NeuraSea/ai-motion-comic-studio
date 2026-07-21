import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'

import express, {
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from 'express'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import { versionTokenFromEtag } from './episode-version.js'
import {
  createStoryHttpRouter,
  StoryHttpError,
  type StoryProviderSelection,
} from './story-http.js'
import { StoryRepository } from './story-repository.js'
import type { StoryDocument } from './story-schema.js'
import { SQLiteJobRepository } from './repositories.js'
import { TimelineMaterializationService } from './timeline-materialization.js'
import {
  SQLiteTimelineDocumentRepository,
  TimelineDocumentService,
} from './timeline-documents.js'
import { JobWorker } from './worker.js'

interface Fixture {
  database: ManjuDatabase
  stories: StoryRepository
  worker: JobWorker
  server: Server
  baseUrl: string
  providerSelections: StoryProviderSelection[]
  close(): Promise<void>
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  return `http://127.0.0.1:${address.port}`
}

async function fixture(): Promise<Fixture> {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  database.createProject({ id: 'project-a', title: '项目 A' })
  database.createProject({ id: 'project-b', title: '项目 B' })
  const stories = new StoryRepository(database)
  const worker = new JobWorker(new SQLiteJobRepository(database))
  const providerSelections: StoryProviderSelection[] = []
  const app = express()
  app.use(createStoryHttpRouter({
    database,
    stories,
    worker,
    resolveTextProviderBinding(selection) {
      providerSelections.push(selection)
      return {
        providerId: 'codex-tools-text',
        model: 'fixture-structured-text',
        configRevision: database.getProviderConnection('codex-tools-text')?.configRevision ?? 1,
      }
    },
  }))
  app.use('/api', (_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'API 接口不存在' } })
  })
  app.use((error: unknown, _request: Request, response: ExpressResponse, _next: NextFunction) => {
    const safe = error instanceof StoryHttpError
      ? error
      : new StoryHttpError(500, 'STORY_STORAGE_ERROR', '测试服务错误')
    response.status(safe.status).json({
      error: {
        code: safe.code,
        message: safe.message,
        ...(safe.details === undefined ? {} : { details: safe.details }),
      },
    })
  })
  const server = createServer(app)
  const baseUrl = await listen(server)
  return {
    database,
    stories,
    worker,
    server,
    baseUrl,
    providerSelections,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await worker.stop()
      database.close()
    },
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<{
  response: globalThis.Response
  body: T
  text: string
}> {
  const response = await fetch(url, init)
  const text = await response.text()
  return { response, body: JSON.parse(text) as T, text }
}

function episodeBody(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: '龙脉初醒',
    source: '阿离在断崖听见龙吟。',
    durationSeconds: 30,
    aspect: '16:9',
    style: '国风动画',
    ...overrides,
  }
}

async function createEpisode(
  testFixture: Fixture,
  id: string,
  projectId = 'project-a',
): Promise<{ id: string; etag: string; revisionId: string }> {
  const result = await json<{
    episode: { id: string }
    revisionId: string
  }>(`${testFixture.baseUrl}/api/v1/projects/${projectId}/episodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(episodeBody(id)),
  })
  assert.equal(result.response.status, 201, result.text)
  const etag = result.response.headers.get('etag')
  assert.ok(etag)
  return { id: result.body.episode.id, etag, revisionId: result.body.revisionId }
}

async function currentEpisodeEtag(
  testFixture: Fixture,
  episodeId: string,
  projectId = 'project-a',
): Promise<string> {
  const response = await fetch(
    `${testFixture.baseUrl}/api/v1/episodes/${episodeId}?projectId=${projectId}`,
  )
  assert.equal(response.status, 200)
  const etag = response.headers.get('etag')
  assert.ok(etag)
  await response.body?.cancel()
  return etag
}

function validStory(title = '龙脉初醒'): StoryDocument {
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
        dialogueLines: index === 2 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue' as const,
          speaker: '阿离',
          text: '它醒了。',
        }] : [],
      })),
    }],
  }
}

function newShotBody(id: string, durationSeconds = 1): Record<string, unknown> {
  return {
    id,
    code: `NEW-${id}`,
    title: `新增 ${id}`,
    description: '云海掠过一道龙影。',
    framing: '远景',
    movement: '横移',
    transition: '硬切',
    durationSeconds,
    visualPrompt: '国风动画，断崖云海中掠过龙影。',
    dialogueLines: [],
  }
}

test('episode routes validate bounded input, expose stable envelopes, and enforce If-Match/ownership', async () => {
  const current = await fixture()
  try {
    const invalid = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/projects/project-a/episodes`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(episodeBody('invalid-duration', { durationSeconds: 29 })),
      },
    )
    assert.equal(invalid.response.status, 400)
    assert.equal(invalid.body.error.code, 'INVALID_REQUEST')

    const secret = 'SECRET_SOURCE_MUST_NOT_ECHO_62dc'
    const oversized = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/projects/project-a/episodes`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(episodeBody('oversized', { source: `${secret}${'x'.repeat(100_001)}` })),
      },
    )
    assert.equal(oversized.response.status, 400)
    assert.doesNotMatch(oversized.text, new RegExp(secret))

    const created = await createEpisode(current, 'episode-1')
    assert.ok(current.database.getRevision(created.revisionId))

    const fetched = await json<{
      episode: {
        id: string
        projectId: string
        title: string
        sourceText: string
        targetDurationSeconds: number
      }
      revisionId: string
    }>(`${current.baseUrl}/api/v1/episodes/episode-1?projectId=project-a`)
    assert.equal(fetched.response.status, 200)
    assert.deepEqual(
      {
        id: fetched.body.episode.id,
        projectId: fetched.body.episode.projectId,
        title: fetched.body.episode.title,
        sourceText: fetched.body.episode.sourceText,
        targetDurationSeconds: fetched.body.episode.targetDurationSeconds,
      },
      {
        id: 'episode-1',
        projectId: 'project-a',
        title: '龙脉初醒',
        sourceText: '阿离在断崖听见龙吟。',
        targetDurationSeconds: 30,
      },
    )
    assert.equal(fetched.body.revisionId, created.revisionId)
    assert.equal(fetched.response.headers.get('etag'), created.etag)

    const wrongOwner = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/episode-1?projectId=project-b`,
    )
    assert.equal(wrongOwner.response.status, 404)
    assert.equal(wrongOwner.body.error.code, 'EPISODE_NOT_FOUND')

    const missingPrecondition = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/episode-1`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ style: '赛博国风' }),
      },
    )
    assert.equal(missingPrecondition.response.status, 428)

    const stale = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/episode-1`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': 'W/"stale-revision"' },
        body: JSON.stringify({ style: '赛博国风' }),
      },
    )
    assert.equal(stale.response.status, 412)
    assert.equal(stale.body.error.code, 'REVISION_CONFLICT')

    const updated = await json<{
      episode: { stylePreset: string; sourceText: string }
      revisionId: string
    }>(`${current.baseUrl}/api/v1/episodes/episode-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': created.etag },
      body: JSON.stringify({
        projectId: 'project-a',
        style: '赛博国风',
        source: '阿离在霓虹断崖听见龙吟。',
      }),
    })
    assert.equal(updated.response.status, 200, updated.text)
    assert.equal(updated.body.episode.stylePreset, '赛博国风')
    assert.equal(updated.body.episode.sourceText, '阿离在霓虹断崖听见龙吟。')
    assert.notEqual(updated.body.revisionId, created.revisionId)
    assert.notEqual(updated.response.headers.get('etag'), created.etag)

    const duplicateAcrossProjects = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/projects/project-b/episodes`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(episodeBody('episode-1')),
      },
    )
    assert.equal(duplicateAcrossProjects.response.status, 409)
    assert.equal(duplicateAcrossProjects.body.error.code, 'EPISODE_ALREADY_EXISTS')
  } finally {
    await current.close()
  }
})

test('project episode catalog lists every episode in stable production order without changing the current episode', async () => {
  const current = await fixture()
  try {
    await createEpisode(current, 'episode-catalog-b')
    await createEpisode(current, 'episode-catalog-a')
    current.database.withSql((sql) => {
      sql.run('UPDATE episodes SET sort_order = 20 WHERE id = ?', 'episode-catalog-b')
      sql.run('UPDATE episodes SET sort_order = 10 WHERE id = ?', 'episode-catalog-a')
    })
    const before = current.database.getProject('project-a')?.currentEpisodeId ?? null

    const listed = await json<{
      episodes: Array<{ id: string; projectId: string; sortOrder: number }>
    }>(`${current.baseUrl}/api/v1/projects/project-a/episodes`)

    assert.equal(listed.response.status, 200, listed.text)
    assert.deepEqual(listed.body.episodes.map((episode) => episode.id), [
      'episode-catalog-a',
      'episode-catalog-b',
    ])
    assert.ok(listed.body.episodes.every((episode) => episode.projectId === 'project-a'))
    assert.equal(current.database.getProject('project-a')?.currentEpisodeId ?? null, before)

    const missing = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/projects/project-missing/episodes`,
    )
    assert.equal(missing.response.status, 404)
    assert.equal(missing.body.error.code, 'PROJECT_NOT_FOUND')
  } finally {
    await current.close()
  }
})

test('story generation only replays an exact durable request identity', async () => {
  const current = await fixture()
  try {
    const first = await createEpisode(current, 'episode-generation')

    const missingKey = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${first.id}/story-generations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': first.etag },
        body: '{}',
      },
    )
    assert.equal(missingKey.response.status, 400)
    assert.equal(missingKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED')

    const missingRevision = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${first.id}/story-generations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'story-1' },
        body: '{}',
      },
    )
    assert.equal(missingRevision.response.status, 428)

    const submit = () => json<{
      job: {
        id: string
        type: string
        status: string
        projectId: string
        episodeId: string
        providerId: string
        model: string
        providerConfigRevision: number
      }
    }>(`${current.baseUrl}/api/v1/episodes/${first.id}/story-generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': first.etag,
        'idempotency-key': 'story-1',
      },
      body: JSON.stringify({ projectId: 'project-a', providerId: 'codex-tools-text' }),
    })

    const created = await submit()
    assert.equal(created.response.status, 202, created.text)
    assert.deepEqual(
      {
        type: created.body.job.type,
        status: created.body.job.status,
        projectId: created.body.job.projectId,
        episodeId: created.body.job.episodeId,
        providerId: created.body.job.providerId,
        model: created.body.job.model,
      },
      {
        type: 'story.generate',
        status: 'queued',
        projectId: 'project-a',
        episodeId: first.id,
        providerId: 'codex-tools-text',
        model: 'fixture-structured-text',
      },
    )
    assert.ok(created.body.job.providerConfigRevision > 0)
    assert.deepEqual(current.providerSelections, [
      {
        requestedProviderId: 'codex-tools-text',
        projectId: 'project-a',
        episodeId: first.id,
      },
      {
        requestedProviderId: 'codex-tools-text',
        projectId: 'project-a',
        episodeId: first.id,
      },
    ])
    const durable = current.database.getGenerationJob(created.body.job.id)
    assert.equal(durable?.providerConfigRevision, created.body.job.providerConfigRevision)
    assert.equal(durable?.input.episodeId, first.id)
    assert.equal(durable?.input.expectedRevisionId, first.revisionId)
    assert.equal(durable?.input.sourceText, '阿离在断崖听见龙吟。')
    assert.deepEqual(durable?.input.idempotencyRequest, {
      schemaVersion: 1,
      episodeIfMatchVersion: versionTokenFromEtag(first.etag),
      requestedProviderId: 'codex-tools-text',
      bodyIntent: {
        projectId: 'project-a',
        providerId: 'codex-tools-text',
      },
    })

    const duplicate = await submit()
    assert.equal(duplicate.response.status, 200)
    assert.equal(duplicate.body.job.id, created.body.job.id)
    assert.equal(current.providerSelections.length, 2)

    const bodyIntentDrift = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${first.id}/story-generations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': first.etag,
          'idempotency-key': 'story-1',
        },
        // Omitting projectId is valid, but is not the body intent originally
        // bound to this key.
        body: JSON.stringify({ providerId: 'codex-tools-text' }),
      },
    )
    assert.equal(bodyIntentDrift.response.status, 409)
    assert.equal(bodyIntentDrift.body.error.code, 'IDEMPOTENCY_CONFLICT')
    assert.equal(current.providerSelections.length, 2)

    const updatedEpisode = await json<{ episode: { sourceText: string } }>(
      `${current.baseUrl}/api/v1/episodes/${first.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': first.etag },
        body: JSON.stringify({ source: '阿离在断崖听见两声龙吟。' }),
      },
    )
    assert.equal(updatedEpisode.response.status, 200, updatedEpisode.text)
    const updatedEtag = updatedEpisode.response.headers.get('etag')
    assert.ok(updatedEtag)
    assert.notEqual(updatedEtag, first.etag)

    // An exact replay is tied to the original If-Match and therefore remains
    // replayable even after the episode itself has advanced.
    const replayAfterEpisodeUpdate = await submit()
    assert.equal(replayAfterEpisodeUpdate.response.status, 200, replayAfterEpisodeUpdate.text)
    assert.equal(replayAfterEpisodeUpdate.body.job.id, created.body.job.id)
    assert.equal(replayAfterEpisodeUpdate.response.headers.get('etag'), updatedEtag)
    assert.equal(current.providerSelections.length, 2)

    const ifMatchDrift = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${first.id}/story-generations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': updatedEtag!,
          'idempotency-key': 'story-1',
        },
        body: JSON.stringify({ projectId: 'project-a', providerId: 'codex-tools-text' }),
      },
    )
    assert.equal(ifMatchDrift.response.status, 409)
    assert.equal(ifMatchDrift.body.error.code, 'IDEMPOTENCY_CONFLICT')
    assert.equal(current.providerSelections.length, 2)

    const second = await createEpisode(current, 'episode-generation-2')
    const collision = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${second.id}/story-generations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': second.etag,
          'idempotency-key': 'story-1',
        },
        body: '{}',
      },
    )
    assert.equal(collision.response.status, 409)
    assert.equal(collision.body.error.code, 'IDEMPOTENCY_CONFLICT')

    const defaultProvider = await json<{ job: { id: string } }>(
      `${current.baseUrl}/api/v1/episodes/${second.id}/story-generations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': second.etag,
          'idempotency-key': 'story-default-provider',
        },
        body: '{}',
      },
    )
    assert.equal(defaultProvider.response.status, 202, defaultProvider.text)
    assert.equal(current.providerSelections.at(-1)?.requestedProviderId, undefined)
    const durableDefault = current.database.getGenerationJob(defaultProvider.body.job.id)
    assert.deepEqual(durableDefault?.input.idempotencyRequest, {
      schemaVersion: 1,
      episodeIfMatchVersion: versionTokenFromEtag(second.etag),
      requestedProviderId: '$default',
      bodyIntent: { projectId: null, providerId: null },
    })

    const defaultReplay = await json<{ job: { id: string } }>(
      `${current.baseUrl}/api/v1/episodes/${second.id}/story-generations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': second.etag,
          'idempotency-key': 'story-default-provider',
        },
        body: '{}',
      },
    )
    assert.equal(defaultReplay.response.status, 200, defaultReplay.text)
    assert.equal(defaultReplay.body.job.id, defaultProvider.body.job.id)
    const providerSelectionCount = current.providerSelections.length

    const defaultToExplicitDrift = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${second.id}/story-generations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': second.etag,
          'idempotency-key': 'story-default-provider',
        },
        body: JSON.stringify({ providerId: 'codex-tools-text' }),
      },
    )
    assert.equal(defaultToExplicitDrift.response.status, 409)
    assert.equal(defaultToExplicitDrift.body.error.code, 'IDEMPOTENCY_CONFLICT')
    assert.equal(current.providerSelections.length, providerSelectionCount)

    current.database.createGenerationJob({
      projectId: 'project-a',
      episodeId: second.id,
      type: 'story.generate',
      status: 'queued',
      providerId: durable?.providerId,
      model: durable?.model,
      providerConfigRevision: durable?.providerConfigRevision,
      idempotencyKey: 'story-legacy-without-request-identity',
      input: {
        episodeId: second.id,
        sourceText: '阿离在断崖听见龙吟。',
        title: '龙脉初醒',
        targetDurationSeconds: 30,
        aspectRatio: '16:9',
        stylePreset: '国风动画',
      },
    })
    const legacyCollision = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${second.id}/story-generations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': second.etag,
          'idempotency-key': 'story-legacy-without-request-identity',
        },
        body: '{}',
      },
    )
    assert.equal(legacyCollision.response.status, 409)
    assert.equal(legacyCollision.body.error.code, 'IDEMPOTENCY_CONFLICT')
  } finally {
    await current.close()
  }
})

test('story, scene, and shot routes use story revisions and reject cross-project or stale edits', async () => {
  const current = await fixture()
  try {
    const episode = await createEpisode(current, 'episode-story')
    const applied = current.stories.applyStory(episode.id, validStory())

    const fetched = await json<{
      episodeId: string
      revisionId: string
      story: StoryDocument
    }>(`${current.baseUrl}/api/v1/episodes/${episode.id}/story?projectId=project-a`)
    assert.equal(fetched.response.status, 200, fetched.text)
    assert.equal(fetched.body.episodeId, episode.id)
    assert.equal(fetched.body.revisionId, applied.revision.id)
    assert.equal(fetched.body.story.scenes[0].shots.length, 6)
    const storyEtag = fetched.response.headers.get('etag')
    assert.ok(storyEtag)

    const wrongOwner = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/scenes/scene-1`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': storyEtag! },
        body: JSON.stringify({
          projectId: 'project-b',
          episodeId: episode.id,
          patch: { description: '不应保存' },
        }),
      },
    )
    assert.equal(wrongOwner.response.status, 404)
    assert.equal(wrongOwner.body.error.code, 'EPISODE_NOT_FOUND')

    const sceneUpdate = await json<{
      scene: { id: string; description: string }
      revisionId: string
      stale: Record<string, number>
    }>(`${current.baseUrl}/api/v1/scenes/scene-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': storyEtag! },
      body: JSON.stringify({
        projectId: 'project-a',
        episodeId: episode.id,
        patch: { description: '龙吟震动云海。' },
      }),
    })
    assert.equal(sceneUpdate.response.status, 200, sceneUpdate.text)
    assert.equal(sceneUpdate.body.scene.id, 'scene-1')
    assert.equal(sceneUpdate.body.scene.description, '龙吟震动云海。')
    assert.notEqual(sceneUpdate.body.revisionId, applied.revision.id)
    assert.deepEqual(sceneUpdate.body.stale, {
      assets: 0,
      jobs: 0,
      exports: 0,
      qualityReports: 0,
      pipelineRuns: 0,
    })
    const sceneEtag = sceneUpdate.response.headers.get('etag')
    assert.ok(sceneEtag)

    const staleShot = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/shots/shot-1`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': storyEtag! },
        body: JSON.stringify({ episodeId: episode.id, patch: { title: '旧版本覆盖' } }),
      },
    )
    assert.equal(staleShot.response.status, 412)
    assert.equal(staleShot.body.error.code, 'REVISION_CONFLICT')

    const shotUpdate = await json<{
      shot: { id: string; title: string }
      revisionId: string
    }>(`${current.baseUrl}/api/v1/shots/shot-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': sceneEtag! },
      body: JSON.stringify({
        projectId: 'project-a',
        episodeId: episode.id,
        sceneId: 'scene-1',
        patch: { title: '云海异动' },
      }),
    })
    assert.equal(shotUpdate.response.status, 200, shotUpdate.text)
    assert.equal(shotUpdate.body.shot.id, 'shot-1')
    assert.equal(shotUpdate.body.shot.title, '云海异动')
    assert.notEqual(shotUpdate.body.revisionId, sceneUpdate.body.revisionId)

    const shotEtag = shotUpdate.response.headers.get('etag')
    assert.ok(shotEtag)
    const deleteAtMinimum = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/shots/shot-1`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'if-match': shotEtag! },
        body: JSON.stringify({ episodeId: episode.id, sceneId: 'scene-1' }),
      },
    )
    assert.equal(deleteAtMinimum.response.status, 409)
    assert.equal(deleteAtMinimum.body.error.code, 'INVALID_STORY_EDIT')
  } finally {
    await current.close()
  }
})

test('render settings preserve an existing Story revision while mixed input edits still create an input revision', async () => {
  const current = await fixture()
  try {
    const episode = await createEpisode(current, 'episode-render-settings')
    const applied = current.stories.applyStory(episode.id, validStory())
    const storyRevisionId = applied.revision.id
    const storyEtag = await currentEpisodeEtag(current, episode.id)
    const timelines = new TimelineDocumentService(
      new SQLiteTimelineDocumentRepository(current.database),
    )
    const materialization = new TimelineMaterializationService(
      current.database,
      current.stories,
      timelines,
    )
    const materialized = materialization.materialize({
      projectId: 'project-a',
      episodeId: episode.id,
      expectedRevisionId: null,
    })
    const revisionsBeforeSettings = current.database.withSql((sql) => (
      sql.all('SELECT id FROM revisions').length
    ))

    for (const [id, type, status, input] of [
      [
        'render-settings-storyboard-job',
        'asset.image.generate',
        'running',
        { metadata: { kind: 'storyboard' } },
      ],
      [
        'render-settings-video-job',
        'shot.video.generate',
        'waiting_provider',
        { episodeId: episode.id },
      ],
      [
        'render-settings-export-job',
        'export.render',
        'queued',
        { exportId: 'render-settings-export' },
      ],
      [
        'render-settings-quality-job',
        'quality.check',
        'succeeded',
        { qualityReportId: 'render-settings-quality' },
      ],
      [
        'render-settings-reference-job',
        'asset.image.generate',
        'running',
        { metadata: { kind: 'character-turnaround' } },
      ],
      [
        'render-settings-speech-job',
        'dialogue.speech.generate',
        'running',
        { episodeId: episode.id },
      ],
    ] as const) {
      current.database.createGenerationJob({
        id,
        projectId: 'project-a',
        episodeId: episode.id,
        type,
        status,
        progress: status === 'succeeded' ? 100 : 25,
        input,
        ...(status === 'succeeded' ? { output: { completed: true } } : {}),
      })
    }
    current.database.createGenerationJob({
      id: 'render-settings-unrelated-global-job',
      projectId: 'project-a',
      type: 'asset.image.generate',
      status: 'running',
      progress: 25,
      resourceType: 'character',
      resourceId: 'other-character',
      input: { metadata: { kind: 'storyboard' } },
    })

    for (const asset of [
      {
        id: 'render-settings-storyboard',
        episodeId: episode.id,
        kind: 'storyboard.image',
        source: 'provider',
        generationJobId: 'render-settings-storyboard-job',
      },
      {
        id: 'render-settings-linked-video',
        episodeId: null,
        kind: 'legacy-shot-output',
        source: 'provider',
        generationJobId: 'render-settings-video-job',
      },
      {
        id: 'render-settings-final-video',
        episodeId: episode.id,
        kind: 'final.video',
        source: 'renderer',
        generationJobId: 'render-settings-export-job',
      },
      {
        id: 'render-settings-bgm',
        episodeId: episode.id,
        kind: 'bgm',
        source: 'upload',
      },
      {
        id: 'render-settings-sfx',
        episodeId: episode.id,
        kind: 'sfx',
        source: 'upload',
      },
      {
        id: 'render-settings-global-reference',
        episodeId: null,
        kind: 'character.turnaround',
        source: 'provider',
      },
      {
        id: 'render-settings-global-storyboard',
        episodeId: null,
        kind: 'storyboard.image',
        source: 'provider',
        generationJobId: 'render-settings-unrelated-global-job',
      },
    ] as const) {
      current.database.createMediaAsset({
        ...asset,
        projectId: 'project-a',
        status: 'ready',
        sourceRevisionId: storyRevisionId,
      })
    }
    current.database.withSql((sql) => {
      const now = '2026-07-14T00:00:00.000Z'
      sql.run(`
        INSERT INTO pipeline_runs (
          id, project_id, episode_id, status, progress, steps_json, created_at, updated_at
        ) VALUES ('render-settings-pipeline', 'project-a', ?, 'running', 50, '{}', ?, ?)
      `, episode.id, now, now)
      sql.run(`
        INSERT INTO exports (
          id, project_id, episode_id, status, timeline_snapshot_json, output_asset_id,
          specification_json, created_at, updated_at
        ) VALUES (
          'render-settings-export', 'project-a', ?, 'succeeded', '{}',
          'render-settings-final-video', '{}', ?, ?
        )
      `, episode.id, now, now)
      sql.run(`
        INSERT INTO quality_reports (
          id, project_id, episode_id, export_id, status, checks_json, passed, created_at
        ) VALUES (
          'render-settings-quality', 'project-a', ?, 'render-settings-export',
          'passed', '{}', 1, ?
        )
      `, episode.id, now)
      const shot = sql.get(`
        SELECT shots.id
        FROM shots JOIN scenes ON scenes.id = shots.scene_id
        WHERE scenes.episode_id = ?
        ORDER BY scenes.sequence, shots.sequence LIMIT 1
      `, episode.id)
      assert.equal(typeof shot?.id, 'string')
      sql.run(`
        UPDATE shots
        SET storyboard_asset_id = 'render-settings-storyboard',
            video_asset_id = 'render-settings-linked-video'
        WHERE id = ?
      `, String(shot?.id))
    })

    const updated = await json<{
      episode: { aspectRatio: string; stylePreset: string; sourceRevisionId: string }
      revisionId: string
      stale: {
        assets: number
        jobs: number
        exports: number
        qualityReports: number
        pipelineRuns: number
      }
    }>(`${current.baseUrl}/api/v1/episodes/${episode.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': storyEtag },
      body: JSON.stringify({
        projectId: 'project-a',
        summary: '切换竖屏赛博国风',
        aspectRatio: '9:16',
        stylePreset: '赛博国风',
      }),
    })
    assert.equal(updated.response.status, 200, updated.text)
    assert.equal(updated.body.episode.aspectRatio, '9:16')
    assert.equal(updated.body.episode.stylePreset, '赛博国风')
    assert.equal(updated.body.episode.sourceRevisionId, storyRevisionId)
    assert.equal(updated.body.revisionId, storyRevisionId)
    assert.deepEqual(updated.body.stale, {
      assets: 3,
      jobs: 4,
      exports: 1,
      qualityReports: 1,
      pipelineRuns: 1,
    })
    const settingsEtag = updated.response.headers.get('etag')
    assert.ok(settingsEtag)
    assert.notEqual(settingsEtag, storyEtag)
    assert.equal(current.stories.getEpisode(episode.id)?.sourceRevisionId, storyRevisionId)
    assert.equal(current.database.getProject('project-a')?.currentRevisionId, storyRevisionId)
    assert.equal(
      current.database.withSql((sql) => sql.all('SELECT id FROM revisions').length),
      revisionsBeforeSettings,
    )
    for (const id of [
      'render-settings-storyboard',
      'render-settings-linked-video',
      'render-settings-final-video',
    ]) {
      assert.equal(current.database.getMediaAsset(id)?.status, 'stale')
    }
    for (const id of [
      'render-settings-bgm',
      'render-settings-sfx',
      'render-settings-global-reference',
      'render-settings-global-storyboard',
    ]) {
      assert.equal(current.database.getMediaAsset(id)?.status, 'ready')
    }
    for (const id of [
      'render-settings-storyboard-job',
      'render-settings-video-job',
      'render-settings-export-job',
    ]) {
      const job = current.database.getGenerationJob(id)
      assert.equal(job?.status, 'cancelled')
      assert.equal(job?.progressDetail.stale, true)
      assert.equal(job?.progressDetail.staleReason, 'render_settings_changed')
      assert.equal(job?.progressDetail.staleRevisionId, storyRevisionId)
      assert.equal(job?.error?.code, 'STALE_RENDER_SETTINGS')
    }
    assert.equal(current.database.getGenerationJob('render-settings-quality-job')?.status, 'succeeded')
    assert.equal(
      current.database.getGenerationJob('render-settings-quality-job')?.progressDetail.staleReason,
      'render_settings_changed',
    )
    for (const id of [
      'render-settings-reference-job',
      'render-settings-speech-job',
      'render-settings-unrelated-global-job',
    ]) {
      const job = current.database.getGenerationJob(id)
      assert.equal(job?.status, 'running')
      assert.equal(job?.progressDetail.stale, undefined)
    }
    assert.deepEqual(current.database.withSql((sql) => ({
      export: sql.get("SELECT status FROM exports WHERE id = 'render-settings-export'")?.status,
      quality: sql.get("SELECT status FROM quality_reports WHERE id = 'render-settings-quality'")?.status,
      passed: sql.get("SELECT passed FROM quality_reports WHERE id = 'render-settings-quality'")?.passed,
      pipeline: sql.get("SELECT status FROM pipeline_runs WHERE id = 'render-settings-pipeline'")?.status,
    })), {
      export: 'stale',
      quality: 'stale',
      passed: 0,
      pipeline: 'stale',
    })

    const fetchedStory = await json<{
      revisionId: string
      story: StoryDocument
    }>(`${current.baseUrl}/api/v1/episodes/${episode.id}/story?projectId=project-a`)
    assert.equal(fetchedStory.response.status, 200, fetchedStory.text)
    assert.equal(fetchedStory.body.revisionId, storyRevisionId)
    assert.equal(fetchedStory.body.story.title, '龙脉初醒')
    assert.equal(fetchedStory.response.headers.get('etag'), settingsEtag)

    // This is the downstream contract that used to fail after a settings
    // update: the episode head must still identify a parseable Story revision.
    const reconciled = materialization.reconcile({
      projectId: 'project-a',
      episodeId: episode.id,
      expectedRevisionId: materialized.revision.id,
    })
    assert.equal(reconciled.timelineDocument.sourceRevisionId, storyRevisionId)
    assert.equal(reconciled.report.sourceRevisionId, storyRevisionId)

    current.database.createGenerationJob({
      id: 'render-settings-noop-job',
      projectId: 'project-a',
      episodeId: episode.id,
      type: 'asset.image.generate',
      status: 'queued',
      input: { metadata: { kind: 'storyboard' } },
    })
    current.database.createMediaAsset({
      id: 'render-settings-noop-storyboard',
      projectId: 'project-a',
      episodeId: episode.id,
      kind: 'storyboard',
      status: 'ready',
      source: 'provider',
      generationJobId: 'render-settings-noop-job',
      sourceRevisionId: storyRevisionId,
    })
    const unchanged = await json<{
      stale: {
        assets: number
        jobs: number
        exports: number
        qualityReports: number
        pipelineRuns: number
      }
    }>(`${current.baseUrl}/api/v1/episodes/${episode.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': settingsEtag! },
      body: JSON.stringify({ aspectRatio: '9:16', stylePreset: '赛博国风' }),
    })
    assert.equal(unchanged.response.status, 200, unchanged.text)
    assert.equal(unchanged.response.headers.get('etag'), settingsEtag)
    assert.deepEqual(unchanged.body.stale, {
      assets: 0,
      jobs: 0,
      exports: 0,
      qualityReports: 0,
      pipelineRuns: 0,
    })
    assert.equal(current.database.getMediaAsset('render-settings-noop-storyboard')?.status, 'ready')
    assert.equal(current.database.getGenerationJob('render-settings-noop-job')?.status, 'queued')

    current.database.withSql((sql) => sql.run(`
      CREATE TRIGGER reject_render_settings_stale
      BEFORE UPDATE OF status ON media_assets
      WHEN OLD.id = 'render-settings-noop-storyboard' AND NEW.status = 'stale'
      BEGIN
        SELECT RAISE(ABORT, 'blocked render settings stale');
      END
    `))
    const rolledBack = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${episode.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': settingsEtag! },
        body: JSON.stringify({ stylePreset: '不应保存的写实风格' }),
      },
    )
    assert.equal(rolledBack.response.status, 500)
    assert.equal(rolledBack.body.error.code, 'STORY_STORAGE_ERROR')
    assert.equal(current.stories.getEpisode(episode.id)?.stylePreset, '赛博国风')
    assert.equal(current.stories.getEpisode(episode.id)?.sourceRevisionId, storyRevisionId)
    assert.equal(current.database.getProject('project-a')?.currentRevisionId, storyRevisionId)
    assert.equal(current.database.getMediaAsset('render-settings-noop-storyboard')?.status, 'ready')
    assert.equal(current.database.getGenerationJob('render-settings-noop-job')?.status, 'queued')
    current.database.withSql((sql) => sql.run('DROP TRIGGER reject_render_settings_stale'))

    const stale = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${episode.id}`,
      {
        method: 'PATCH',
        // A second tab that read the same full Episode ETag before the first
        // settings update must not overwrite the newer style.
        headers: { 'content-type': 'application/json', 'if-match': storyEtag },
        body: JSON.stringify({ stylePreset: '不应保存' }),
      },
    )
    assert.equal(stale.response.status, 412)
    assert.equal(stale.body.error.code, 'REVISION_CONFLICT')
    assert.equal(current.stories.getEpisode(episode.id)?.stylePreset, '赛博国风')

    const invalidSetting = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${episode.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': settingsEtag! },
        body: JSON.stringify({ aspectRatio: '4:3' }),
      },
    )
    assert.equal(invalidSetting.response.status, 400)
    assert.equal(invalidSetting.body.error.code, 'INVALID_REQUEST')
    assert.equal(current.stories.getEpisode(episode.id)?.aspectRatio, '9:16')

    const mixed = await json<{
      episode: { sourceText: string; stylePreset: string; sourceRevisionId: string }
      revisionId: string
    }>(`${current.baseUrl}/api/v1/episodes/${episode.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': settingsEtag! },
      body: JSON.stringify({
        sourceText: '阿离在霓虹断崖听见新的龙吟。',
        stylePreset: '写实赛博国风',
      }),
    })
    assert.equal(mixed.response.status, 200, mixed.text)
    assert.equal(mixed.body.episode.sourceText, '阿离在霓虹断崖听见新的龙吟。')
    assert.equal(mixed.body.episode.stylePreset, '写实赛博国风')
    assert.notEqual(mixed.body.revisionId, storyRevisionId)
    assert.equal(mixed.body.episode.sourceRevisionId, mixed.body.revisionId)
    assert.equal(
      current.database.getRevision(mixed.body.revisionId)?.snapshot.kind,
      'episode.input',
    )
  } finally {
    await current.close()
  }
})

test('rapid render-settings ABA keeps Episode ETags monotonic and no-op stable', async () => {
  const current = await fixture()
  try {
    const episode = await createEpisode(current, 'episode-render-settings-aba')
    current.stories.applyStory(episode.id, validStory())
    const firstEtag = await currentEpisodeEtag(current, episode.id)

    const toB = await json<{ episode: { aspectRatio: string; stylePreset: string } }>(
      `${current.baseUrl}/api/v1/episodes/${episode.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': firstEtag },
        body: JSON.stringify({ aspectRatio: '9:16', stylePreset: '赛博国风' }),
      },
    )
    assert.equal(toB.response.status, 200, toB.text)
    const secondEtag = toB.response.headers.get('etag')
    assert.ok(secondEtag)
    assert.notEqual(secondEtag, firstEtag)

    const backToA = await json<{ episode: { aspectRatio: string; stylePreset: string } }>(
      `${current.baseUrl}/api/v1/episodes/${episode.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': secondEtag },
        body: JSON.stringify({ aspectRatio: '16:9', stylePreset: '国风动画' }),
      },
    )
    assert.equal(backToA.response.status, 200, backToA.text)
    const thirdEtag = backToA.response.headers.get('etag')
    assert.ok(thirdEtag)
    assert.notEqual(thirdEtag, firstEtag)
    assert.notEqual(thirdEtag, secondEtag)

    for (const staleEtag of [firstEtag, secondEtag]) {
      const stale = await json<{ error: { code: string } }>(
        `${current.baseUrl}/api/v1/episodes/${episode.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'if-match': staleEtag },
          body: JSON.stringify({ stylePreset: '不应覆盖' }),
        },
      )
      assert.equal(stale.response.status, 412)
      assert.equal(stale.body.error.code, 'REVISION_CONFLICT')
    }

    const noOp = await json<{ episode: { aspectRatio: string; stylePreset: string } }>(
      `${current.baseUrl}/api/v1/episodes/${episode.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': thirdEtag },
        body: JSON.stringify({ aspectRatio: '16:9', stylePreset: '国风动画' }),
      },
    )
    assert.equal(noOp.response.status, 200, noOp.text)
    assert.equal(noOp.response.headers.get('etag'), thirdEtag)
  } finally {
    await current.close()
  }
})

test('story revision restore transactionally rebuilds the graph, returns a new ETag, and rejects invalid history', async () => {
  const current = await fixture()
  try {
    const episode = await createEpisode(current, 'episode-restore')
    const original = current.stories.applyStory(episode.id, validStory('原始剧本'))
    const edited = current.stories.updateShot(episode.id, 'shot-1', { title: '修改后的镜头' }, {
      expectedRevisionId: original.revision.id,
    })
    current.database.createMediaAsset({
      id: 'restore-storyboard',
      projectId: 'project-a',
      episodeId: episode.id,
      kind: 'storyboard.image',
      status: 'ready',
      source: 'provider',
      sourceRevisionId: edited.revision.id,
    })
    const editedEtag = await currentEpisodeEtag(current, episode.id)

    const history = await json<{
      episodeId: string
      revisionId: string
      revisions: Array<{ id: string; projectId: string }>
    }>(`${current.baseUrl}/api/v1/episodes/${episode.id}/story/revisions?projectId=project-a`)
    assert.equal(history.response.status, 200, history.text)
    assert.equal(history.body.episodeId, episode.id)
    assert.equal(history.body.revisionId, edited.revision.id)
    assert.deepEqual(history.body.revisions.map((revision) => revision.id), [
      edited.revision.id,
      original.revision.id,
    ])
    assert.equal(history.response.headers.get('etag'), editedEtag)

    const restored = await json<{
      story: StoryDocument
      revisionId: string
      stale: { assets: number }
    }>(`${current.baseUrl}/api/v1/episodes/${episode.id}/story/revisions/${original.revision.id}/restore`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': editedEtag,
      },
      body: JSON.stringify({ projectId: 'project-a', summary: '恢复已审核版本' }),
    })
    assert.equal(restored.response.status, 200, restored.text)
    assert.equal(restored.body.story.title, '原始剧本')
    assert.equal(restored.body.story.scenes[0].shots[0].title, '镜头 1')
    assert.notEqual(restored.body.revisionId, original.revision.id)
    assert.notEqual(restored.body.revisionId, edited.revision.id)
    assert.equal(restored.body.stale.assets, 1)
    assert.equal(current.database.getMediaAsset('restore-storyboard')?.status, 'stale')
    const restoredEtag = restored.response.headers.get('etag')
    assert.ok(restoredEtag)
    assert.notEqual(restoredEtag, editedEtag)

    const stale = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${episode.id}/story/revisions/${original.revision.id}/restore`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': editedEtag,
        },
        body: '{}',
      },
    )
    assert.equal(stale.response.status, 412)
    assert.equal(stale.body.error.code, 'REVISION_CONFLICT')

    const auditRevision = current.database.createRevision({
      projectId: 'project-a',
      parentRevisionId: restored.body.revisionId,
      summary: '资产审核',
      snapshot: { type: 'asset.lock', assetId: 'not-a-story' },
    })
    const invalid = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${episode.id}/story/revisions/${auditRevision.id}/restore`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': restoredEtag! },
        body: '{}',
      },
    )
    assert.equal(invalid.response.status, 409)
    assert.equal(invalid.body.error.code, 'REVISION_NOT_STORY')

    const otherEpisode = await createEpisode(current, 'episode-restore-other')
    const otherStory = current.stories.applyStory(otherEpisode.id, validStory('另一分集'))
    const otherEtag = await currentEpisodeEtag(current, otherEpisode.id)
    const crossEpisode = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/${otherEpisode.id}/story/revisions/${original.revision.id}/restore`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': otherEtag },
        body: JSON.stringify({ projectId: 'project-a' }),
      },
    )
    assert.equal(crossEpisode.response.status, 409)
    assert.equal(crossEpisode.body.error.code, 'REVISION_NOT_STORY')
    assert.equal(current.stories.getEpisode(otherEpisode.id)?.sourceRevisionId, otherStory.revision.id)
  } finally {
    await current.close()
  }
})

test('shot create, same-scene reorder, and delete are CAS-safe, bounded, validated, and reorder-idempotent', async () => {
  const current = await fixture()
  try {
    const episode = await createEpisode(current, 'episode-structure')
    const applied = current.stories.applyStory(episode.id, validStory())
    const originalEtag = await currentEpisodeEtag(current, episode.id)

    const created = await json<{
      shot: { id: string; sequence: number }
      story: StoryDocument
      revisionId: string
    }>(`${current.baseUrl}/api/v1/shots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': originalEtag },
      body: JSON.stringify({
        projectId: 'project-a',
        episodeId: episode.id,
        sceneId: 'scene-1',
        index: 1,
        shot: newShotBody('shot-7'),
      }),
    })
    assert.equal(created.response.status, 201, created.text)
    assert.equal(created.body.shot.id, 'shot-7')
    assert.equal(created.body.shot.sequence, 1)
    assert.deepEqual(created.body.story.scenes[0].shots.map((shot) => shot.sequence), [0, 1, 2, 3, 4, 5, 6])
    const createdEtag = created.response.headers.get('etag')
    assert.ok(createdEtag)

    const stale = await json<{ error: { code: string } }>(`${current.baseUrl}/api/v1/shots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': originalEtag },
      body: JSON.stringify({
        episodeId: episode.id,
        sceneId: 'scene-1',
        shot: newShotBody('stale-shot'),
      }),
    })
    assert.equal(stale.response.status, 412)
    assert.equal(stale.body.error.code, 'REVISION_CONFLICT')
    assert.equal(current.stories.getStory(episode.id)?.scenes[0].shots.length, 7)

    const order = ['shot-7', 'shot-1', 'shot-2', 'shot-3', 'shot-4', 'shot-5', 'shot-6']
    const reordered = await json<{
      scene: { shots: Array<{ id: string; sequence: number }> }
      revisionId: string
    }>(`${current.baseUrl}/api/v1/shots/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': createdEtag! },
      body: JSON.stringify({ episodeId: episode.id, sceneId: 'scene-1', shotIds: order }),
    })
    assert.equal(reordered.response.status, 200, reordered.text)
    assert.deepEqual(reordered.body.scene.shots.map((shot) => shot.id), order)
    assert.deepEqual(reordered.body.scene.shots.map((shot) => shot.sequence), [0, 1, 2, 3, 4, 5, 6])
    const reorderedEtag = reordered.response.headers.get('etag')
    assert.ok(reorderedEtag)

    const revisionCount = current.database.listRevisions('project-a').length
    const identical = await json<{ revisionId: string }>(`${current.baseUrl}/api/v1/shots/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': reorderedEtag! },
      body: JSON.stringify({ episodeId: episode.id, sceneId: 'scene-1', shotIds: order }),
    })
    assert.equal(identical.response.status, 200, identical.text)
    assert.equal(identical.body.revisionId, reordered.body.revisionId)
    assert.equal(identical.response.headers.get('etag'), reorderedEtag)
    assert.equal(current.database.listRevisions('project-a').length, revisionCount)

    const partial = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/shots/reorder`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': reorderedEtag! },
        body: JSON.stringify({ episodeId: episode.id, sceneId: 'scene-1', shotIds: order.slice(1) }),
      },
    )
    assert.equal(partial.response.status, 400)
    assert.equal(partial.body.error.code, 'INVALID_STORY_EDIT')
    assert.equal(current.stories.getEpisode(episode.id)?.sourceRevisionId, reordered.body.revisionId)

    const deleted = await json<{
      deletedShotId: string
      story: StoryDocument
      revisionId: string
    }>(`${current.baseUrl}/api/v1/shots/shot-7`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'if-match': reorderedEtag! },
      body: JSON.stringify({ episodeId: episode.id, sceneId: 'scene-1' }),
    })
    assert.equal(deleted.response.status, 200, deleted.text)
    assert.equal(deleted.body.deletedShotId, 'shot-7')
    assert.equal(deleted.body.story.scenes[0].shots.length, 6)
    assert.deepEqual(deleted.body.story.scenes[0].shots.map((shot) => shot.sequence), [0, 1, 2, 3, 4, 5])
    const deletedEtag = deleted.response.headers.get('etag')
    assert.ok(deletedEtag)

    const repeatedDelete = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/shots/shot-7`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'if-match': deletedEtag! },
        body: JSON.stringify({ episodeId: episode.id, sceneId: 'scene-1' }),
      },
    )
    assert.equal(repeatedDelete.response.status, 404)
    assert.equal(repeatedDelete.body.error.code, 'SHOT_NOT_FOUND')
    assert.equal(current.stories.getEpisode(episode.id)?.sourceRevisionId, deleted.body.revisionId)

    const duplicate = await json<{ error: { code: string } }>(`${current.baseUrl}/api/v1/shots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': deletedEtag! },
      body: JSON.stringify({
        episodeId: episode.id,
        sceneId: 'scene-1',
        shot: newShotBody('shot-1'),
      }),
    })
    assert.equal(duplicate.response.status, 409)
    assert.equal(duplicate.body.error.code, 'INVALID_STORY_EDIT')

    const unsafe = 'SECRET_SHOT_VALUE_17f9'
    const invalid = await json<{ error: { code: string } }>(`${current.baseUrl}/api/v1/shots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': deletedEtag! },
      body: JSON.stringify({
        episodeId: episode.id,
        sceneId: 'scene-1',
        shot: { ...newShotBody(`${unsafe}:invalid`) },
      }),
    })
    assert.equal(invalid.response.status, 400)
    assert.doesNotMatch(invalid.text, new RegExp(unsafe))

    const split = structuredClone(current.stories.getStory(episode.id)!)
    const originalShots = split.scenes[0].shots
    split.scenes = [{
      ...split.scenes[0],
      shots: originalShots.slice(0, 3).map((shot, sequence) => ({ ...shot, sequence })),
    }, {
      ...split.scenes[0],
      id: 'scene-2',
      sequence: 1,
      title: '断崖余波',
      shots: originalShots.slice(3).map((shot, sequence) => ({ ...shot, sequence })),
    }]
    const splitApplied = current.stories.applyStory(episode.id, split)
    const splitEtag = await currentEpisodeEtag(current, episode.id)
    const crossSceneDuplicate = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/shots`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': splitEtag },
        body: JSON.stringify({
          episodeId: episode.id,
          sceneId: 'scene-2',
          shot: newShotBody('shot-1'),
        }),
      },
    )
    assert.equal(crossSceneDuplicate.response.status, 409)
    assert.equal(crossSceneDuplicate.body.error.code, 'INVALID_STORY_EDIT')

    // Imported legacy stories may contain the same public shot ID in two
    // scenes. DELETE follows PATCH semantics: sceneId is then mandatory.
    const legacy = structuredClone(splitApplied.story)
    legacy.scenes[1].shots.push({
      ...legacy.scenes[0].shots[0],
      sequence: legacy.scenes[1].shots.length,
      durationSeconds: 0.5,
    })
    const legacyApplied = current.stories.applyStory(episode.id, legacy)
    const legacyEtag = await currentEpisodeEtag(current, episode.id)
    const ambiguous = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/shots/shot-1`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'if-match': legacyEtag },
        body: JSON.stringify({ episodeId: episode.id }),
      },
    )
    assert.equal(ambiguous.response.status, 409)
    assert.equal(ambiguous.body.error.code, 'SHOT_NOT_FOUND')

    const resolved = await json<{ story: StoryDocument }>(
      `${current.baseUrl}/api/v1/shots/shot-1`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'if-match': legacyEtag },
        body: JSON.stringify({ episodeId: episode.id, sceneId: 'scene-2' }),
      },
    )
    assert.equal(resolved.response.status, 200, resolved.text)
    assert.equal(resolved.body.story.scenes.flatMap((scene) => scene.shots).length, 6)
  } finally {
    await current.close()
  }
})
