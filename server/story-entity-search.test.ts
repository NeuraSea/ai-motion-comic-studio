import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'

import express, {
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from 'express'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import { createStoryHttpRouter, StoryHttpError } from './story-http.js'
import { StoryRepository } from './story-repository.js'
import type { StoryDocument } from './story-schema.js'
import { SQLiteJobRepository } from './repositories.js'
import { JobWorker } from './worker.js'

interface SearchResult {
  entityId: string
  type: 'scene' | 'shot' | 'dialogue' | 'character' | 'location' | 'prop'
  title: string
  snippet: string
  sceneId: string | null
  shotId: string | null
  sourceRevisionId: string
}

interface SearchPage {
  episodeId: string
  projectId: string
  sourceRevisionId: string
  query: string
  limit: number
  offset: number
  total: number
  hasMore: boolean
  results: SearchResult[]
}

interface Fixture {
  database: ManjuDatabase
  stories: StoryRepository
  worker: JobWorker
  server: Server
  baseUrl: string
  close(): Promise<void>
}

function story(marker: string, specialSceneTitle = '断崖龙吟'): StoryDocument {
  return {
    version: 1,
    title: '龙脉初醒',
    targetDurationSeconds: 30,
    bible: {
      logline: '少女守护长安。',
      theme: '责任',
      tone: '紧张',
      visualStyle: '国风动画',
    },
    characters: [{
      id: 'ali',
      name: '阿离',
      role: '主角',
      storyDescription: `${marker}守护者`,
      visualDescription: '黑色长发、红绳、青色圆领袍',
    }],
    locations: [{
      id: 'cliff',
      name: `${marker}祭坛`,
      storyDescription: '长安城外',
      visualDescription: '云海与落日',
    }],
    props: [{
      id: 'token',
      name: '青铜令',
      description: `${marker}钥匙`,
      visualDescription: '暗红纹路的六边形青铜令',
    }],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: specialSceneTitle,
      locationId: 'cliff',
      timeOfDay: '黄昏',
      description: `${marker}在石壁间回响`,
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `镜头 ${index + 1}`,
        description: index === 0 ? `${marker}从掌心爆发` : '阿离在风中看向云海。',
        framing: '中景',
        movement: '缓慢推进',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '国风动画，断崖黄昏云海，电影构图。',
        dialogueLines: index === 0 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue' as const,
          speaker: '阿离',
          text: `${marker}醒了。`,
        }] : [],
      })),
    }],
  }
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
  const app = express()
  app.use(createStoryHttpRouter({
    database,
    stories,
    worker,
    resolveTextProviderBinding() {
      return { providerId: 'text', model: 'fixture', configRevision: 1 }
    },
  }))
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
  return {
    database,
    stories,
    worker,
    server,
    baseUrl: await listen(server),
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await worker.stop()
      database.close()
    },
  }
}

async function json<T>(url: string): Promise<{
  response: Response
  body: T
  text: string
}> {
  const response = await fetch(url)
  const text = await response.text()
  return { response, body: JSON.parse(text) as T, text }
}

function searchUrl(
  current: Fixture,
  episodeId: string,
  query: string,
  suffix = '',
): string {
  return `${current.baseUrl}/api/v1/episodes/${episodeId}/story/entities/search?projectId=project-a&query=${encodeURIComponent(query)}${suffix}`
}

test('entity search covers the six current Story entity types with stable Episode locators', async () => {
  const current = await fixture()
  try {
    current.stories.ensureEpisode('project-a', { id: 'episode-main', title: '主分集' })
    const old = current.stories.applyStory('episode-main', story('绝版旧词'))
    const applied = current.stories.applyStory('episode-main', story('灵火', '100% 风暴'))
    assert.notEqual(applied.revision.id, old.revision.id)

    const found = await json<SearchPage>(searchUrl(current, 'episode-main', '  灵火  '))
    assert.equal(found.response.status, 200, found.text)
    assert.match(found.response.headers.get('etag') ?? '', /^W\/".+"$/)
    assert.equal(found.response.headers.get('cache-control'), 'no-store')
    assert.equal(found.body.episodeId, 'episode-main')
    assert.equal(found.body.projectId, 'project-a')
    assert.equal(found.body.sourceRevisionId, applied.revision.id)
    assert.equal(found.body.query, '灵火')
    assert.equal(found.body.limit, 20)
    assert.equal(found.body.offset, 0)
    assert.equal(found.body.total, 6)
    assert.equal(found.body.hasMore, false)
    assert.deepEqual(
      new Set(found.body.results.map((result) => result.type)),
      new Set(['scene', 'shot', 'dialogue', 'character', 'location', 'prop']),
    )
    assert.ok(found.body.results.every((result) => (
      result.sourceRevisionId === applied.revision.id
      && result.entityId.length > 0
      && result.title.length > 0
      && result.snippet.length > 0
    )))
    assert.deepEqual(
      found.body.results.find((result) => result.type === 'scene'),
      {
        entityId: 'scene-1',
        type: 'scene',
        title: '100% 风暴',
        snippet: '灵火在石壁间回响 · 黄昏 · 灵火祭坛',
        sceneId: 'scene-1',
        shotId: null,
        sourceRevisionId: applied.revision.id,
      },
    )
    assert.deepEqual(
      found.body.results.find((result) => result.type === 'dialogue'),
      {
        entityId: 'line-1',
        type: 'dialogue',
        title: '阿离',
        snippet: '灵火醒了。',
        sceneId: 'scene-1',
        shotId: 'shot-1',
        sourceRevisionId: applied.revision.id,
      },
    )

    const historical = await json<SearchPage>(searchUrl(current, 'episode-main', '绝版旧词'))
    assert.equal(historical.response.status, 200, historical.text)
    assert.equal(historical.body.total, 0)
    assert.deepEqual(historical.body.results, [])

    // LIKE metacharacters are literals, not a way to turn the endpoint into
    // an unbounded match-all scan.
    const literalPercent = await json<SearchPage>(searchUrl(current, 'episode-main', '%'))
    assert.equal(literalPercent.response.status, 200, literalPercent.text)
    assert.equal(literalPercent.body.total, 1)
    assert.equal(literalPercent.body.results[0]?.type, 'scene')
    assert.equal(literalPercent.body.results[0]?.entityId, 'scene-1')
  } finally {
    await current.close()
  }
})

test('entity search pagination is deterministic and never crosses Episode or project scope', async () => {
  const current = await fixture()
  try {
    current.stories.ensureEpisode('project-a', { id: 'episode-main', title: '主分集' })
    const applied = current.stories.applyStory('episode-main', story('共通词'))
    current.stories.ensureEpisode('project-a', { id: 'episode-other', title: '其他分集' })
    current.stories.applyStory('episode-other', story('跨集秘密'))
    current.stories.ensureEpisode('project-b', { id: 'episode-b', title: '其他项目' })
    current.stories.applyStory('episode-b', story('跨项目秘密'))

    const first = await json<SearchPage>(searchUrl(current, 'episode-main', '共通词', '&limit=2&offset=0'))
    const replay = await json<SearchPage>(searchUrl(current, 'episode-main', '共通词', '&limit=2&offset=0'))
    const second = await json<SearchPage>(searchUrl(current, 'episode-main', '共通词', '&limit=2&offset=2'))
    const beyond = await json<SearchPage>(searchUrl(current, 'episode-main', '共通词', '&limit=2&offset=99'))
    assert.equal(first.response.status, 200, first.text)
    assert.deepEqual(replay.body, first.body)
    assert.equal(first.body.total, 6)
    assert.equal(first.body.hasMore, true)
    assert.equal(second.body.total, 6)
    assert.equal(second.body.hasMore, true)
    assert.equal(beyond.body.total, 6)
    assert.equal(beyond.body.hasMore, false)
    assert.deepEqual(beyond.body.results, [])
    const firstKeys = first.body.results.map((result) => `${result.type}:${result.entityId}`)
    const secondKeys = second.body.results.map((result) => `${result.type}:${result.entityId}`)
    assert.equal(new Set([...firstKeys, ...secondKeys]).size, 4)
    assert.ok([...first.body.results, ...second.body.results].every((result) => (
      result.sourceRevisionId === applied.revision.id
    )))

    const crossEpisode = await json<SearchPage>(searchUrl(current, 'episode-main', '跨集秘密'))
    assert.equal(crossEpisode.response.status, 200, crossEpisode.text)
    assert.equal(crossEpisode.body.total, 0)

    const wrongProject = await json<{ error: { code: string } }>(
      `${current.baseUrl}/api/v1/episodes/episode-main/story/entities/search?projectId=project-b&query=${encodeURIComponent('共通词')}`,
    )
    assert.equal(wrongProject.response.status, 404)
    assert.equal(wrongProject.body.error.code, 'EPISODE_NOT_FOUND')
  } finally {
    await current.close()
  }
})

test('entity search strictly rejects malformed query and pagination parameters', async () => {
  const current = await fixture()
  try {
    current.stories.ensureEpisode('project-a', { id: 'episode-main', title: '主分集' })
    current.stories.applyStory('episode-main', story('灵火'))
    current.stories.ensureEpisode('project-a', { id: 'episode-empty', title: '空分集' })

    const invalidUrls = [
      `${current.baseUrl}/api/v1/episodes/episode-main/story/entities/search?query=x`,
      searchUrl(current, 'episode-main', '   '),
      searchUrl(current, 'episode-main', '字'.repeat(101)),
      searchUrl(current, 'episode-main', '灵火', '&limit=0'),
      searchUrl(current, 'episode-main', '灵火', '&limit=101'),
      searchUrl(current, 'episode-main', '灵火', '&limit=01'),
      searchUrl(current, 'episode-main', '灵火', '&offset=10001'),
      searchUrl(current, 'episode-main', '灵火', '&query=重复'),
      searchUrl(current, 'episode-main', '灵火', '&unexpected=true'),
    ]
    for (const url of invalidUrls) {
      const invalid = await json<{ error: { code: string } }>(url)
      assert.equal(invalid.response.status, 400, `${url}: ${invalid.text}`)
      assert.equal(invalid.body.error.code, 'INVALID_SEARCH_QUERY')
    }

    const noStory = await json<{ error: { code: string } }>(
      searchUrl(current, 'episode-empty', '灵火'),
    )
    assert.equal(noStory.response.status, 404)
    assert.equal(noStory.body.error.code, 'STORY_NOT_FOUND')
  } finally {
    await current.close()
  }
})
