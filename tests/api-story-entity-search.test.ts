import assert from 'node:assert/strict'
import test from 'node:test'

import {
  api,
  ApiError,
  searchStoryEntities,
} from '../src/lib/api'

const REVISION = 'story-revision-current'

function result(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    entityId: 'scene-1',
    type: 'scene',
    title: '灵火祭坛',
    snippet: '灵火在石壁间回响',
    sceneId: 'scene-1',
    shotId: null,
    sourceRevisionId: REVISION,
    ...overrides,
  }
}

function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    episodeId: 'episode-1',
    projectId: 'project-1',
    sourceRevisionId: REVISION,
    query: '灵火',
    limit: 2,
    offset: 0,
    total: 3,
    hasMore: true,
    results: [
      result(),
      result({
        entityId: 'line-1',
        type: 'dialogue',
        title: '阿离',
        snippet: '灵火醒了。',
        sceneId: 'scene-1',
        shotId: 'shot-1',
      }),
    ],
    ...overrides,
  }
}

function response(body: unknown, etag = 'W/"episode-version-7"'): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ETag: etag,
    },
  })
}

test('searchStoryEntities sends strict Episode scope and returns the authoritative ETag', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  let captured: { url: string; init: RequestInit } | undefined
  globalThis.fetch = (async (input, init = {}) => {
    captured = { url: String(input), init }
    return response(page())
  }) as typeof fetch

  try {
    const found = await searchStoryEntities('episode-1', {
      projectId: 'project-1',
      query: '  灵火  ',
      limit: 2,
      offset: 0,
      signal: controller.signal,
    })

    assert.ok(captured)
    const requested = new URL(captured.url, 'http://manju.local')
    assert.equal(requested.pathname, '/api/v1/episodes/episode-1/story/entities/search')
    assert.deepEqual([...requested.searchParams.entries()], [
      ['projectId', 'project-1'],
      ['query', '  灵火  '],
      ['limit', '2'],
      ['offset', '0'],
    ])
    assert.equal(captured.init.signal, controller.signal)
    assert.equal(found.etag, 'W/"episode-version-7"')
    assert.equal(found.query, '灵火')
    assert.equal(found.sourceRevisionId, REVISION)
    assert.deepEqual(found.results.map((item) => [item.type, item.entityId]), [
      ['scene', 'scene-1'],
      ['dialogue', 'line-1'],
    ])
    assert.equal(api.searchStoryEntities, searchStoryEntities)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('searchStoryEntities applies documented default pagination', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  globalThis.fetch = (async (input) => {
    capturedUrl = String(input)
    return response(page({ limit: 20, total: 2, hasMore: false }))
  }) as typeof fetch

  try {
    const found = await searchStoryEntities('episode-1', {
      projectId: 'project-1',
      query: '灵火',
    })
    const requested = new URL(capturedUrl, 'http://manju.local')
    assert.equal(requested.searchParams.has('limit'), false)
    assert.equal(requested.searchParams.has('offset'), false)
    assert.equal(found.limit, 20)
    assert.equal(found.offset, 0)
    assert.equal(found.hasMore, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('searchStoryEntities rejects cross-scope, stale-revision, malformed locator, and pagination responses', async () => {
  const originalFetch = globalThis.fetch
  const invalidPages = [
    page({ projectId: 'project-foreign' }),
    page({ results: [result({ sourceRevisionId: 'story-revision-old' })], total: 1, hasMore: false }),
    page({ results: [result({ type: 'shot', shotId: 'shot-other' })], total: 1, hasMore: false }),
    page({ hasMore: false }),
    page({ total: 1 }),
    page({ limit: 101 }),
  ]
  let index = 0
  globalThis.fetch = (async () => response(invalidPages[index++])) as typeof fetch

  try {
    for (const _invalid of invalidPages) {
      await assert.rejects(
        searchStoryEntities('episode-1', {
          projectId: 'project-1',
          query: '灵火',
          limit: 2,
          offset: 0,
        }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError)
          assert.equal(error.code, 'INVALID_RESPONSE')
          return true
        },
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
