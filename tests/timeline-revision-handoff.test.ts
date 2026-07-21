import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertPinnedTimeline,
  preparePinnedTimeline,
  type TimelineRevisionCoordinatorTransport,
} from '../src/features/editor/timeline-revision-handoff'
import { ApiError } from '../src/lib'
import type { TimelineDocumentSnapshot } from '../src/lib'

const COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'

function snapshot(): TimelineDocumentSnapshot {
  return {
    timelineDocument: {
      id: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      currentRevisionId: 'revision-1',
      schemaVersion: 1,
      upstreamCommit: COMMIT,
      sourceRevisionId: 'story-1',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    },
    revision: {
      id: 'revision-1',
      documentId: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      parentRevisionId: null,
      schemaVersion: 1,
      upstreamCommit: COMMIT,
      sourceRevisionId: 'story-1',
      summary: '固化',
      snapshot: { version: 2 },
      createdAt: '2026-07-14T00:00:00.000Z',
    },
    document: { version: 2 },
    etag: 'W/"revision-1"',
  }
}

test('accepts one explicit revision/ETag handoff for preview and export', () => {
  const pinned = snapshot()
  assert.equal(assertPinnedTimeline(pinned, {
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: 'story-1',
  }), pinned)
})

test('rejects mismatched ETags, ownership, and unreconciled Story revisions', () => {
  const badEtag = snapshot()
  badEtag.etag = 'W/"revision-other"'
  assert.throws(() => assertPinnedTimeline(badEtag, {
    projectId: 'project-1', episodeId: 'episode-1', sourceRevisionId: 'story-1',
  }), /revision\/ETag/)

  assert.throws(() => assertPinnedTimeline(snapshot(), {
    projectId: 'project-other', episodeId: 'episode-1', sourceRevisionId: 'story-1',
  }), /不匹配/)
  assert.throws(() => assertPinnedTimeline(snapshot(), {
    projectId: 'project-1', episodeId: 'episode-1', sourceRevisionId: 'story-2',
  }), /尚未对账/)
})

test('prepares an existing timeline through one caller-owned reconcile', async () => {
  const calls: string[] = []
  const loaded = snapshot()
  const reconciled = snapshot()
  reconciled.revision.id = 'revision-2'
  reconciled.timelineDocument.currentRevisionId = 'revision-2'
  reconciled.etag = 'W/"revision-2"'
  const transport: TimelineRevisionCoordinatorTransport = {
    async get(episodeId) {
      calls.push(`get:${episodeId}`)
      return loaded
    },
    async materialize() {
      throw new Error('materialize must not run')
    },
    async reconcile(episodeId, projectId, etag) {
      calls.push(`reconcile:${episodeId}:${projectId}:${etag}`)
      return { ...reconciled, created: false, report: materializationReport('reconcile') }
    },
  }

  const pinned = await preparePinnedTimeline({
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: 'story-1',
  }, transport)
  assert.equal(pinned.revision.id, 'revision-2')
  assert.deepEqual(calls, [
    'get:episode-1',
    'reconcile:episode-1:project-1:W/"revision-1"',
  ])
})

test('materializes a missing timeline once before pinning it', async () => {
  const calls: string[] = []
  const created = snapshot()
  const transport: TimelineRevisionCoordinatorTransport = {
    async get() {
      calls.push('get')
      throw new ApiError('missing', {
        status: 404,
        code: 'TIMELINE_DOCUMENT_NOT_FOUND',
      })
    },
    async materialize(episodeId, projectId) {
      calls.push(`materialize:${episodeId}:${projectId}`)
      return { ...created, created: true, report: materializationReport('materialize') }
    },
    async reconcile() {
      throw new Error('reconcile must not run after create')
    },
  }

  const pinned = await preparePinnedTimeline({
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: 'story-1',
  }, transport)
  assert.equal(pinned.revision.id, 'revision-1')
  assert.deepEqual(calls, ['get', 'materialize:episode-1:project-1'])
})

function materializationReport(operation: 'materialize' | 'reconcile') {
  return {
    operation,
    sourceRevisionId: 'story-1',
    previousSourceRevisionId: operation === 'reconcile' ? 'story-1' : null,
    changed: operation === 'materialize',
    preservedElementIds: [],
    appendedShots: [],
    orphanedElements: [],
    preservedAbsentShots: [],
    unresolvedShots: [],
  }
}
