import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  getProjectKnowledgeSnapshot,
  importProjectSourceText,
  listProjectKnowledgeRevisions,
  listProjectRevisions,
  listStoryRevisions,
  restoreProjectKnowledgeRevision,
  restoreProjectRevision,
  updateProjectKnowledgeSnapshot,
} from '../src/lib/api'

const revision = {
  id: 'revision-story-1',
  projectId: 'project-1',
  parentRevisionId: null,
  summary: '保存结构化剧本',
  snapshot: {
    version: 1,
    title: '第一集',
    bible: {},
    characters: [],
    locations: [],
    props: [],
    scenes: [],
  },
  createdAt: '2026-07-14T00:00:00.000Z',
}

test('project revision client validates immutable snapshots and owner scope', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  globalThis.fetch = (async (input) => {
    capturedUrl = String(input)
    return new Response(JSON.stringify({ revisions: [revision] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const revisions = await listProjectRevisions('project-1')
    assert.equal(capturedUrl, '/api/v1/projects/project-1/revisions')
    assert.deepEqual(revisions, [revision])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('project revision client rejects cross-project or malformed records', async () => {
  const originalFetch = globalThis.fetch
  const fixtures: unknown[] = [
    { ...revision, projectId: 'project-2' },
    { ...revision, snapshot: [] },
  ]
  globalThis.fetch = (async () => new Response(JSON.stringify({
    revisions: [fixtures.shift()],
  }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch

  try {
    await assert.rejects(
      listProjectRevisions('project-1'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
    await assert.rejects(
      listProjectRevisions('project-1'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('project knowledge restore is If-Match guarded and validates the new immutable head', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return new Response(JSON.stringify({
      project: {
        id: 'project-1',
        title: '项目一',
        currentEpisodeId: null,
        currentRevisionId: 'revision-restored-head',
        settings: {},
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      },
      revision: {
        ...revision,
        id: 'revision-restored-head',
        parentRevisionId: 'revision-current-head',
        summary: '恢复修订 revision-story-1',
      },
      document: { knowledge: { version: 2, sourceText: '恢复后的母本' } },
      etag: 'W/"revision-restored-head"',
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  try {
    const restored = await restoreProjectRevision(
      'project-1',
      'revision-story-1',
      'W/"revision-current-head"',
    )
    assert.equal(capturedUrl, '/api/v1/projects/project-1/revisions/revision-story-1/restore')
    assert.equal(capturedInit?.method, 'POST')
    assert.equal(new Headers(capturedInit?.headers).get('If-Match'), 'W/"revision-current-head"')
    assert.equal(restored.revision.id, 'revision-restored-head')
    assert.equal(restored.etag, 'W/"revision-restored-head"')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('project knowledge restore rejects a cross-project response', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    project: { id: 'project-other' },
    revision: { ...revision, projectId: 'project-other' },
    document: {},
    etag: 'W/"revision-other"',
  }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  try {
    await assert.rejects(
      restoreProjectRevision('project-1', 'revision-story-1', 'W/"revision-current"'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('dedicated knowledge client keeps empty and saved heads separate from generic revisions', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method: string; ifMatch: string | null }> = []
  const project = {
    id: 'project-1',
    title: '项目一',
    currentEpisodeId: null,
    currentRevisionId: 'generic-voice-revision',
    settings: {},
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  }
  const knowledgeRevision = {
    ...revision,
    id: 'knowledge-revision-1',
    summary: '更新项目知识库',
  }
  const document = {
    version: 2,
    sourceText: '母本',
    worldbuilding: '',
    eventLine: '',
    relationshipNotes: '',
    worldEntries: [],
    events: [],
    relationships: [],
  }
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requests.push({
      url,
      method: init?.method ?? 'GET',
      ifMatch: new Headers(init?.headers).get('If-Match'),
    })
    const payload = url.endsWith('/knowledge/revisions')
      ? { revisions: [knowledgeRevision] }
      : url.endsWith('/knowledge') && (init?.method ?? 'GET') === 'GET'
        ? { project, revision: null, document, etag: 'W/"knowledge-empty"' }
        : { project, revision: knowledgeRevision, document, etag: 'W/"knowledge-revision-1"' }
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  try {
    const empty = await getProjectKnowledgeSnapshot('project-1')
    assert.equal(empty.revision, null)
    assert.equal(empty.etag, 'W/"knowledge-empty"')
    const saved = await updateProjectKnowledgeSnapshot(
      'project-1',
      document,
      empty.etag,
      { summary: '更新项目知识库' },
    )
    assert.equal(saved.revision?.id, 'knowledge-revision-1')
    assert.equal((await listProjectKnowledgeRevisions('project-1'))[0]?.id, 'knowledge-revision-1')
    const restored = await restoreProjectKnowledgeRevision(
      'project-1',
      'knowledge-revision-1',
      saved.etag,
    )
    assert.equal(restored.revision?.id, 'knowledge-revision-1')
    const imported = await importProjectSourceText(
      'project-1',
      { fileName: 'story.md', content: '# 新原著' },
      restored.etag,
    )
    assert.equal(imported.revision?.id, 'knowledge-revision-1')
    assert.deepEqual(requests.map((item) => item.url), [
      '/api/v1/projects/project-1/knowledge',
      '/api/v1/projects/project-1/knowledge',
      '/api/v1/projects/project-1/knowledge/revisions',
      '/api/v1/projects/project-1/knowledge/revisions/knowledge-revision-1/restore',
      '/api/v1/projects/project-1/import',
    ])
    assert.equal(requests[1]?.ifMatch, 'W/"knowledge-empty"')
    assert.equal(requests[3]?.ifMatch, 'W/"knowledge-revision-1"')
    assert.equal(requests[4]?.ifMatch, 'W/"knowledge-revision-1"')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('story revision client uses the episode-scoped endpoint and validates owner, head, and ETag', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  globalThis.fetch = (async (input) => {
    capturedUrl = String(input)
    return new Response(JSON.stringify({
      episodeId: 'episode-1',
      revisionId: revision.id,
      revisions: [revision],
    }), {
      headers: {
        'Content-Type': 'application/json',
        ETag: 'W/"episode-version-1"',
      },
    })
  }) as typeof fetch

  try {
    const history = await listStoryRevisions('episode-1', { projectId: 'project-1' })
    assert.equal(capturedUrl, '/api/v1/episodes/episode-1/story/revisions?projectId=project-1')
    assert.equal(history.revisionId, revision.id)
    assert.equal(history.etag, 'W/"episode-version-1"')
    assert.deepEqual(history.revisions, [revision])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('story revision client rejects cross-project and cross-episode envelopes', async () => {
  const originalFetch = globalThis.fetch
  const envelopes = [
    {
      episodeId: 'episode-other',
      revisionId: revision.id,
      revisions: [revision],
    },
    {
      episodeId: 'episode-1',
      revisionId: revision.id,
      revisions: [{ ...revision, projectId: 'project-other' }],
    },
  ]
  globalThis.fetch = (async () => new Response(JSON.stringify(envelopes.shift()), {
    headers: { 'Content-Type': 'application/json', ETag: 'W/"episode-version-1"' },
  })) as typeof fetch

  try {
    await assert.rejects(
      listStoryRevisions('episode-1', { projectId: 'project-1' }),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
    await assert.rejects(
      listStoryRevisions('episode-1', { projectId: 'project-1' }),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
