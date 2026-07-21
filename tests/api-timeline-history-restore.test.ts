import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  getTimelineDocument,
  listTimelineDocumentRevisions,
  restoreTimelineDocumentRevision,
  saveTimelineDocument,
} from '../src/lib/api'
import type {
  TimelineDocumentRevision,
  TimelineDocumentSnapshot,
} from '../src/lib/api-types'

const originalFetch = globalThis.fetch
const COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'

afterEach(() => {
  globalThis.fetch = originalFetch
})

function snapshot(
  revisionId: string,
  document: Record<string, unknown>,
  parentRevisionId: string | null,
): TimelineDocumentSnapshot {
  const now = '2026-07-15T00:00:00.000Z'
  const revision: TimelineDocumentRevision = {
    id: revisionId,
    documentId: 'timeline-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    parentRevisionId,
    schemaVersion: 1,
    upstreamCommit: COMMIT,
    sourceRevisionId: 'story-1',
    summary: 'Timeline revision',
    snapshot: structuredClone(document),
    createdAt: now,
  }
  return {
    timelineDocument: {
      id: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      currentRevisionId: revisionId,
      schemaVersion: 1,
      upstreamCommit: COMMIT,
      sourceRevisionId: 'story-1',
      createdAt: now,
      updatedAt: now,
    },
    revision,
    document: structuredClone(document),
    etag: `W/"${revisionId}"`,
  }
}

test('timeline history client pins pagination and strictly validates ownership and ETag', async () => {
  const current = snapshot('revision-2', { tracks: ['current'] }, 'revision-1')
  const original = snapshot('revision-1', { tracks: ['original'] }, null)
  let requested = ''
  globalThis.fetch = (async (input) => {
    requested = String(input)
    return new Response(JSON.stringify({
      timelineDocument: current.timelineDocument,
      revisions: [current.revision, original.revision],
      etag: current.etag,
    }), {
      headers: { 'Content-Type': 'application/json', ETag: current.etag },
    })
  }) as typeof fetch

  const history = await listTimelineDocumentRevisions('timeline-1', { limit: 50, offset: 10 })
  assert.equal(requested, '/api/v1/timeline-documents/timeline-1/revisions?limit=50&offset=10')
  assert.equal(history.etag, current.etag)
  assert.deepEqual(history.revisions.map((revision) => revision.id), ['revision-2', 'revision-1'])

  globalThis.fetch = (async () => new Response(JSON.stringify({
    timelineDocument: current.timelineDocument,
    revisions: [{ ...original.revision, documentId: 'other-timeline' }],
    etag: current.etag,
  }), {
    headers: { 'Content-Type': 'application/json', ETag: current.etag },
  })) as typeof fetch
  await assert.rejects(
    listTimelineDocumentRevisions('timeline-1'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_RESPONSE',
  )
})

test('timeline restore client pins body, If-Match and Idempotency-Key and validates lineage', async () => {
  const result = snapshot('revision-3', { tracks: ['restored'] }, 'revision-2')
  let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
  globalThis.fetch = (async (input, init) => {
    captured = { input, init }
    return new Response(JSON.stringify({
      timeline: result,
      operationResultTimeline: result,
      headAdvanced: false,
      restore: {
        id: 'restore-1',
        documentId: 'timeline-1',
        projectId: 'project-1',
        episodeId: 'episode-1',
        baseRevisionId: 'revision-2',
        targetRevisionId: 'revision-1',
        resultRevisionId: 'revision-3',
        createdAt: '2026-07-15T00:00:01.000Z',
      },
      idempotent: false,
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json', ETag: result.etag },
    })
  }) as typeof fetch

  const restored = await restoreTimelineDocumentRevision(
    'episode-1',
    'revision-1',
    { projectId: 'project-1', documentId: 'timeline-1', summary: '恢复初版' },
    'W/"revision-2"',
    'restore-attempt-1',
  )
  assert.equal(restored.restore.resultRevisionId, 'revision-3')
  assert.equal(String(captured?.input), '/api/v1/episodes/episode-1/timeline-document/revisions/revision-1/restore')
  const headers = new Headers(captured?.init?.headers)
  assert.equal(headers.get('If-Match'), 'W/"revision-2"')
  assert.equal(headers.get('Idempotency-Key'), 'restore-attempt-1')
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
    projectId: 'project-1',
    documentId: 'timeline-1',
    summary: '恢复初版',
  })

  globalThis.fetch = (async () => new Response(JSON.stringify({
    timeline: result,
    operationResultTimeline: result,
    headAdvanced: false,
    restore: {
      id: 'restore-forged',
      documentId: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      baseRevisionId: 'different-parent',
      targetRevisionId: 'revision-1',
      resultRevisionId: 'revision-3',
      createdAt: '2026-07-15T00:00:01.000Z',
    },
    idempotent: false,
  }), {
    status: 201,
    headers: { 'Content-Type': 'application/json', ETag: result.etag },
  })) as typeof fetch
  await assert.rejects(
    restoreTimelineDocumentRevision(
      'episode-1',
      'revision-1',
      { projectId: 'project-1', documentId: 'timeline-1' },
      'W/"revision-2"',
      'restore-attempt-2',
    ),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_RESPONSE',
  )
})

test('timeline restore replay keeps its historical operation result after the authoritative head advances', async () => {
  const operationResult = snapshot('revision-3', { tracks: ['restored'] }, 'revision-2')
  const authoritative = snapshot('revision-4', { tracks: ['new story'] }, 'revision-3')
  authoritative.timelineDocument.sourceRevisionId = 'story-2'
  authoritative.revision.sourceRevisionId = 'story-2'

  globalThis.fetch = (async () => new Response(JSON.stringify({
    timeline: authoritative,
    operationResultTimeline: operationResult,
    headAdvanced: true,
    restore: {
      id: 'restore-1',
      documentId: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      baseRevisionId: 'revision-2',
      targetRevisionId: 'revision-1',
      resultRevisionId: 'revision-3',
      createdAt: '2026-07-15T00:00:01.000Z',
    },
    idempotent: true,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ETag: authoritative.etag },
  })) as typeof fetch

  const replay = await restoreTimelineDocumentRevision(
    'episode-1',
    'revision-1',
    { projectId: 'project-1', documentId: 'timeline-1' },
    'W/"revision-2"',
    'restore-attempt-1',
  )
  assert.equal(replay.headAdvanced, true)
  assert.equal(replay.timeline.revision.id, 'revision-4')
  assert.equal(replay.operationResultTimeline.revision.id, 'revision-3')
  assert.equal(replay.operationResultTimeline.timelineDocument.sourceRevisionId, 'story-1')
  assert.equal(replay.timeline.timelineDocument.sourceRevisionId, 'story-2')
})

test('timeline snapshot client rejects body/header ETag drift', async () => {
  const current = snapshot('revision-2', { tracks: [] }, 'revision-1')
  globalThis.fetch = (async () => new Response(JSON.stringify(current), {
    headers: { 'Content-Type': 'application/json', ETag: 'W/"forged"' },
  })) as typeof fetch
  await assert.rejects(
    getTimelineDocument('episode-1'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_RESPONSE',
  )
})

test('ordinary timeline save accepts only the server removal of media authority trust', async () => {
  const submittedDocument = {
    tracks: ['current'],
    manjuTimeline: {
      manifestVersion: 2,
      mediaAuthorityFingerprint: 'a'.repeat(64),
    },
  }
  const savedDocument = {
    tracks: ['current'],
    manjuTimeline: { manifestVersion: 2 },
  }
  const saved = snapshot('revision-3', savedDocument, 'revision-2')
  let body: unknown
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as unknown
    return new Response(JSON.stringify(saved), {
      headers: { 'Content-Type': 'application/json', ETag: saved.etag },
    })
  }) as typeof fetch

  const result = await saveTimelineDocument('episode-1', {
    projectId: 'project-1',
    schemaVersion: 1,
    upstreamCommit: COMMIT,
    document: submittedDocument,
  }, 'W/"revision-2"')
  assert.deepEqual(body, {
    projectId: 'project-1',
    schemaVersion: 1,
    upstreamCommit: COMMIT,
    document: submittedDocument,
  })
  assert.deepEqual(result.document, savedDocument)

  const forged = snapshot('revision-4', {
    ...savedDocument,
    unrelatedServerMutation: true,
  }, 'revision-3')
  globalThis.fetch = (async () => new Response(JSON.stringify(forged), {
    headers: { 'Content-Type': 'application/json', ETag: forged.etag },
  })) as typeof fetch
  await assert.rejects(
    saveTimelineDocument('episode-1', {
      projectId: 'project-1',
      schemaVersion: 1,
      upstreamCommit: COMMIT,
      document: submittedDocument,
    }, 'W/"revision-3"'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_RESPONSE',
  )
})
