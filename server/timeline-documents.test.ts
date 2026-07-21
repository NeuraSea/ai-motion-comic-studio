import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import {
  currentMediaAuthority,
  mediaAuthorityFingerprint,
  timelineMediaAuthorityReceipt,
} from './media-authority.js'
import { StoryRepository } from './story-repository.js'
import {
  MAX_TIMELINE_DOCUMENT_BYTES,
  SQLiteTimelineDocumentRepository,
  TimelineDocumentError,
  TimelineDocumentService,
  type SaveTimelineDocumentInput,
} from './timeline-documents.js'
import type { JsonObject } from './types.js'

const OPEN_CUT_COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-timeline-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function createEpisode(
  database: ManjuDatabase,
  projectId: string,
  episodeId: string,
  sourceRevisionId: string | null = null,
): void {
  new StoryRepository(database).ensureEpisode(projectId, { id: episodeId, title: episodeId })
  if (sourceRevisionId) {
    database.withSql((sql) => sql.run(
      'UPDATE episodes SET source_revision_id = ? WHERE id = ?',
      sourceRevisionId,
      episodeId,
    ))
  }
}

function isTimelineError(code: string) {
  return (error: unknown) => error instanceof TimelineDocumentError && error.code === code
}

test('timeline snapshots append immutably, preserve unknown fields, and survive restart', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const timestamps = [
    '2026-07-14T01:00:00.000Z',
    '2026-07-14T01:00:01.000Z',
  ]
  const ids = ['timeline-document-1', 'timeline-revision-1', 'timeline-revision-2']
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'project-1', title: 'Timeline project' })
  const sourceRevision = database.createRevision({
    id: 'story-revision-1',
    projectId: 'project-1',
    summary: 'Story source',
    snapshot: { shots: [] },
  })
  createEpisode(database, 'project-1', 'episode-1', sourceRevision.id)
  let service = new TimelineDocumentService(new SQLiteTimelineDocumentRepository(database, {
    now: () => timestamps.shift() ?? '2026-07-14T01:00:02.000Z',
    idFactory: () => ids.shift() ?? 'unexpected-id',
  }))

  const originalDocument: JsonObject = {
    tracks: [],
    extensions: {
      futureOpenCutEffect: {
        vendor: 'unknown-field-must-round-trip',
        parameters: [1, true, null],
      },
    },
  }
  const created = service.save({
    projectId: 'project-1',
    episodeId: 'episode-1',
    expectedRevisionId: null,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document: originalDocument,
  })
  assert.equal(created.created, true)
  assert.equal(created.timelineDocument.id, 'timeline-document-1')
  assert.equal(created.revision.id, 'timeline-revision-1')
  assert.equal(created.revision.sourceRevisionId, null)
  assert.equal(created.etag, 'W/"timeline-revision-1"')
  assert.deepEqual(created.document, originalDocument)

  ;(originalDocument.extensions as JsonObject).futureOpenCutEffect = { overwritten: true }
  assert.equal(
    ((service.get('episode-1').document.extensions as JsonObject).futureOpenCutEffect as JsonObject).vendor,
    'unknown-field-must-round-trip',
  )

  const updatedDocument: JsonObject = {
    tracks: [{ id: 'main', elements: [{ id: 'image-1', futureProperty: 'kept' }] }],
    editorState: { zoom: 2 },
  }
  const updated = service.save({
    projectId: 'project-1',
    episodeId: 'episode-1',
    expectedRevisionId: created.revision.id,
    schemaVersion: 2,
    upstreamCommit: OPEN_CUT_COMMIT,
    summary: 'Move image clip',
    document: updatedDocument,
  })
  assert.equal(updated.created, false)
  assert.equal(updated.revision.id, 'timeline-revision-2')
  assert.equal(updated.revision.parentRevisionId, created.revision.id)
  assert.equal(updated.timelineDocument.schemaVersion, 2)
  assert.equal(updated.revision.sourceRevisionId, null)

  const history = service.listRevisions(created.timelineDocument.id)
  assert.deepEqual(history.revisions.map((revision) => revision.id), [
    'timeline-revision-2',
    'timeline-revision-1',
  ])
  assert.deepEqual(history.revisions[0].snapshot, updatedDocument)
  assert.equal(
    ((history.revisions[1].snapshot.extensions as JsonObject).futureOpenCutEffect as JsonObject).vendor,
    'unknown-field-must-round-trip',
  )
  assert.throws(
    () => database.withSql((sql) => sql.run(`
      UPDATE timeline_document_revisions SET summary = 'mutated'
      WHERE id = 'timeline-revision-1'
    `)),
    /timeline document revisions are immutable/,
  )

  database.close()
  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  service = new TimelineDocumentService(new SQLiteTimelineDocumentRepository(database))
  try {
    const restarted = service.get('episode-1')
    assert.equal(restarted.revision.id, 'timeline-revision-2')
    assert.deepEqual(restarted.document, updatedDocument)
    assert.equal(service.listRevisions('timeline-document-1').revisions.length, 2)
  } finally {
    database.close()
  }
})

test('timeline saves reject stale heads, cross-project ownership, and unsafe or oversized JSON', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'project-a', title: 'A' })
    database.createProject({ id: 'project-b', title: 'B' })
    const revisionA = database.createRevision({
      id: 'story-revision-a',
      projectId: 'project-a',
      summary: 'A',
      snapshot: {},
    })
    const revisionB = database.createRevision({
      id: 'story-revision-b',
      projectId: 'project-b',
      summary: 'B',
      snapshot: {},
    })
    createEpisode(database, 'project-a', 'episode-a', revisionA.id)
    createEpisode(database, 'project-b', 'episode-b', revisionB.id)
    const service = new TimelineDocumentService(new SQLiteTimelineDocumentRepository(database))

    assert.throws(() => service.save({
      projectId: 'project-a',
      episodeId: 'episode-b',
      expectedRevisionId: null,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_COMMIT,
      document: {},
    }), isTimelineError('EPISODE_PROJECT_MISMATCH'))

    assert.throws(() => service.saveReconciled({
      projectId: 'project-a',
      episodeId: 'episode-a',
      expectedRevisionId: null,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_COMMIT,
      sourceRevisionId: revisionB.id,
      document: {},
    }), isTimelineError('SOURCE_REVISION_PROJECT_MISMATCH'))

    const created = service.save({
      projectId: 'project-a',
      episodeId: 'episode-a',
      expectedRevisionId: null,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_COMMIT,
      document: { tracks: [] },
    })
    assert.throws(() => service.save({
      projectId: 'project-a',
      episodeId: 'episode-a',
      expectedRevisionId: 'stale-revision',
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_COMMIT,
      document: { tracks: [{ id: 'must-not-win' }] },
    }), (error: unknown) => (
      error instanceof TimelineDocumentError
      && error.code === 'TIMELINE_DOCUMENT_CONFLICT'
      && error.currentRevisionId === created.revision.id
    ))
    assert.equal(service.listRevisions(created.timelineDocument.id).revisions.length, 1)

    const unsafe = JSON.parse('{"nested":{"__proto__":{"polluted":true}}}') as JsonObject
    assert.throws(() => service.save({
      projectId: 'project-a',
      episodeId: 'episode-a',
      expectedRevisionId: created.revision.id,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_COMMIT,
      document: unsafe,
    }), isTimelineError('INVALID_TIMELINE_DOCUMENT'))

    assert.throws(() => service.save({
      projectId: 'project-a',
      episodeId: 'episode-a',
      expectedRevisionId: created.revision.id,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_COMMIT,
      document: { payload: 'x'.repeat(MAX_TIMELINE_DOCUMENT_BYTES) },
    }), isTimelineError('INVALID_TIMELINE_DOCUMENT'))
    assert.equal(service.get('episode-a').revision.id, created.revision.id)
  } finally {
    database.close()
  }
})

test('ordinary timeline save cannot forge a newer Story source revision', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'project-1', title: 'P1' })
    const revisionA = database.createRevision({
      id: 'story-revision-a',
      projectId: 'project-1',
      summary: 'Story A',
      snapshot: { marker: 'A' },
    })
    const revisionB = database.createRevision({
      id: 'story-revision-b',
      projectId: 'project-1',
      summary: 'Story B',
      snapshot: { marker: 'B' },
    })
    createEpisode(database, 'project-1', 'episode-1', revisionA.id)
    const service = new TimelineDocumentService(new SQLiteTimelineDocumentRepository(database))
    const trustedFingerprint = currentMediaAuthority(database, {
      projectId: 'project-1',
      episodeId: 'episode-1',
    }).fingerprint
    const materialized = service.saveReconciled({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_COMMIT,
      sourceRevisionId: revisionA.id,
      mediaAuthorityFingerprint: trustedFingerprint,
      document: {
        version: 2,
        marker: 'materialized-from-a',
        manjuTimeline: { mediaAuthorityFingerprint: '0'.repeat(64) },
      },
    })
    assert.equal(mediaAuthorityFingerprint(materialized.document), trustedFingerprint)
    assert.equal(
      timelineMediaAuthorityReceipt(database, materialized.revision.id)?.fingerprint,
      trustedFingerprint,
    )
    assert.throws(() => database.withSql((sql) => sql.run(`
      DELETE FROM timeline_media_authority_receipts WHERE timeline_revision_id = ?
    `, materialized.revision.id)), /timeline media authority receipts are immutable/)

    database.withSql((sql) => sql.run(
      'UPDATE episodes SET source_revision_id = ? WHERE id = ?',
      revisionB.id,
      'episode-1',
    ))
    const forgedInput = {
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_COMMIT,
      sourceRevisionId: revisionB.id,
      document: {
        version: 2,
        marker: 'still-old-a-content',
        sourceRevisionId: revisionB.id,
        manjuTimeline: { mediaAuthorityFingerprint: 'f'.repeat(64) },
      },
    } as unknown as SaveTimelineDocumentInput

    const saved = service.save(forgedInput)
    assert.equal(saved.timelineDocument.sourceRevisionId, revisionA.id)
    assert.equal(saved.revision.sourceRevisionId, revisionA.id)
    assert.equal(service.get('episode-1').revision.sourceRevisionId, revisionA.id)
    assert.equal(saved.document.sourceRevisionId, revisionB.id)
    assert.equal(mediaAuthorityFingerprint(saved.document), null)
    assert.equal(timelineMediaAuthorityReceipt(database, saved.revision.id), null)
    assert.equal(database.withSql((sql) => sql.run(`
      DELETE FROM episodes WHERE id = 'episode-1'
    `)).changes, 1)
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT id FROM timeline_documents WHERE episode_id = 'episode-1'
    `)), undefined)
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT timeline_revision_id FROM timeline_media_authority_receipts
       WHERE timeline_revision_id = ?
    `, materialized.revision.id)), undefined)
  } finally {
    database.close()
  }
})
