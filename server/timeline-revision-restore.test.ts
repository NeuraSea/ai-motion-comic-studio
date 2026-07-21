import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import { StoryRepository } from './story-repository.js'
import {
  SQLiteTimelineDocumentRepository,
  TimelineDocumentService,
} from './timeline-documents.js'
import {
  TimelineRevisionRestoreError,
  TimelineRevisionRestoreService,
} from './timeline-revision-restore.js'

const OPEN_CUT_COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'

function fixture(options: { firstSchemaVersion?: number; secondSchemaVersion?: number } = {}) {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  database.createProject({ id: 'project-1', title: 'Timeline restore' })
  new StoryRepository(database).ensureEpisode('project-1', { id: 'episode-1', title: 'Episode' })
  const revisionIds = ['timeline-document-1', 'timeline-revision-1', 'timeline-revision-2', 'timeline-revision-3', 'timeline-revision-4']
  const timelines = new TimelineDocumentService(new SQLiteTimelineDocumentRepository(database, {
    idFactory: () => revisionIds.shift() ?? 'unexpected-timeline-id',
    now: (() => {
      let tick = 0
      return () => `2026-07-15T00:00:0${tick++}.000Z`
    })(),
  }))
  const first = timelines.save({
    projectId: 'project-1',
    episodeId: 'episode-1',
    expectedRevisionId: null,
    schemaVersion: options.firstSchemaVersion ?? 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    summary: 'Original cut',
    document: { version: 1, tracks: [{ id: 'original' }] },
  })
  const second = timelines.save({
    projectId: 'project-1',
    episodeId: 'episode-1',
    expectedRevisionId: first.revision.id,
    schemaVersion: options.secondSchemaVersion ?? 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    summary: 'Current cut',
    document: { version: 1, tracks: [{ id: 'current' }] },
  })
  const restoreIds = ['restore-1', 'restore-2']
  const restores = new TimelineRevisionRestoreService(database, timelines, {
    idFactory: () => restoreIds.shift() ?? 'unexpected-restore-id',
    now: () => '2026-07-15T00:00:10.000Z',
  })
  return { database, timelines, restores, first, second }
}

function insertDownstream(database: ManjuDatabase): void {
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO pipeline_runs (
        id, project_id, episode_id, status, progress, steps_json,
        created_at, updated_at
      ) VALUES ('pipeline-1', 'project-1', 'episode-1', 'running', 50, '{}', ?, ?)
    `, '2026-07-15T00:00:03.000Z', '2026-07-15T00:00:03.000Z')
    sql.run(`
      INSERT INTO generation_jobs (
        id, project_id, episode_id, pipeline_run_id, type, status, progress,
        input_json, created_at, updated_at
      ) VALUES (
        'job-1', 'project-1', 'episode-1', 'pipeline-1', 'export.render',
        'running', 20, '{}', ?, ?
      )
    `, '2026-07-15T00:00:03.000Z', '2026-07-15T00:00:03.000Z')
    sql.run(`
      INSERT INTO exports (
        id, project_id, episode_id, status, timeline_snapshot_json,
        specification_json, created_at, updated_at
      ) VALUES ('export-1', 'project-1', 'episode-1', 'succeeded', '{}', '{}', ?, ?)
    `, '2026-07-15T00:00:03.000Z', '2026-07-15T00:00:03.000Z')
    sql.run(`
      INSERT INTO quality_reports (
        id, project_id, episode_id, export_id, status, checks_json,
        passed, created_at
      ) VALUES (
        'quality-1', 'project-1', 'episode-1', 'export-1', 'passed', '{}', 1, ?
      )
    `, '2026-07-15T00:00:03.000Z')
  })
}

test('timeline restore appends a new revision and atomically stales downstream work', (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  insertDownstream(value.database)

  const restored = value.restores.restore({
    projectId: 'project-1',
    episodeId: 'episode-1',
    documentId: value.first.timelineDocument.id,
    targetRevisionId: value.first.revision.id,
    expectedRevisionId: value.second.revision.id,
    idempotencyKey: 'timeline-restore-key-1',
    summary: 'Restore original cut',
  })

  assert.equal(restored.idempotent, false)
  assert.equal(restored.headAdvanced, false)
  assert.equal(restored.restore.id, 'restore-1')
  assert.equal(restored.restore.baseRevisionId, value.second.revision.id)
  assert.equal(restored.restore.targetRevisionId, value.first.revision.id)
  assert.equal(restored.restore.resultRevisionId, 'timeline-revision-3')
  assert.equal(restored.timeline.revision.parentRevisionId, value.second.revision.id)
  assert.deepEqual(restored.timeline.document, value.first.document)
  assert.deepEqual(restored.stale, {
    exports: 1,
    qualityReports: 1,
    pipelineRuns: 1,
    generationJobs: 1,
  })
  assert.equal(value.timelines.listRevisions(value.first.timelineDocument.id).revisions.length, 3)
  assert.deepEqual(value.timelines.getRevision(value.first.revision.id).document, value.first.document)
  assert.equal(value.database.getPipelineRun('pipeline-1')?.status, 'stale')
  assert.equal(value.database.getGenerationJob('job-1')?.status, 'cancelled')
  const exportRow = value.database.withSql((sql) => sql.get(
    `SELECT status FROM exports WHERE id = 'export-1'`,
  ))
  const qualityRow = value.database.withSql((sql) => sql.get(
    `SELECT status, passed FROM quality_reports WHERE id = 'quality-1'`,
  ))
  assert.equal(exportRow?.status, 'stale')
  assert.equal(qualityRow?.status, 'stale')
  assert.equal(qualityRow?.passed, 0)

  const audit = value.database.withSql((sql) => sql.get(`
    SELECT idempotency_key_hash, request_hash FROM timeline_revision_restores
    WHERE id = 'restore-1'
  `))
  assert.equal(typeof audit?.idempotency_key_hash, 'string')
  assert.notEqual(audit?.idempotency_key_hash, 'timeline-restore-key-1')
  assert.equal(String(audit?.idempotency_key_hash).length, 64)
  assert.equal(String(audit?.request_hash).length, 64)
  assert.throws(() => value.database.withSql((sql) => sql.run(`
    UPDATE timeline_revision_restores SET created_at = created_at WHERE id = 'restore-1'
  `)), /timeline revision restores are immutable/)
})

test('timeline restore replays durably and reports a later authoritative head', (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const request = {
    projectId: 'project-1',
    episodeId: 'episode-1',
    documentId: value.first.timelineDocument.id,
    targetRevisionId: value.first.revision.id,
    expectedRevisionId: value.second.revision.id,
    idempotencyKey: 'timeline-restore-key-2',
  }
  const original = value.restores.restore(request)
  const replay = value.restores.restore(request)
  assert.equal(replay.idempotent, true)
  assert.equal(replay.timeline.revision.id, original.restore.resultRevisionId)
  assert.equal(replay.operationResultTimeline.revision.id, original.restore.resultRevisionId)
  assert.equal(replay.headAdvanced, false)
  assert.equal(value.timelines.listRevisions(value.first.timelineDocument.id).revisions.length, 3)

  const later = value.timelines.save({
    projectId: 'project-1',
    episodeId: 'episode-1',
    expectedRevisionId: original.restore.resultRevisionId,
    schemaVersion: 1,
    upstreamCommit: OPEN_CUT_COMMIT,
    document: { version: 1, tracks: [{ id: 'later' }] },
  })
  const advancedReplay = value.restores.restore(request)
  assert.equal(advancedReplay.idempotent, true)
  assert.equal(advancedReplay.headAdvanced, true)
  assert.equal(advancedReplay.timeline.revision.id, later.revision.id)
  assert.equal(advancedReplay.operationResultTimeline.revision.id, original.restore.resultRevisionId)

  assert.throws(() => value.restores.restore({
    ...request,
    targetRevisionId: value.second.revision.id,
  }), (error: unknown) => error instanceof TimelineRevisionRestoreError
    && error.code === 'TIMELINE_RESTORE_IDEMPOTENCY_CONFLICT')
})

test('timeline restore rejects stale heads and incompatible historical schema', (t) => {
  const stale = fixture()
  const incompatible = fixture({ firstSchemaVersion: 1, secondSchemaVersion: 2 })
  t.after(() => {
    stale.database.close()
    incompatible.database.close()
  })

  assert.throws(() => stale.restores.restore({
    projectId: 'project-1',
    episodeId: 'episode-1',
    documentId: stale.first.timelineDocument.id,
    targetRevisionId: stale.first.revision.id,
    expectedRevisionId: stale.first.revision.id,
    idempotencyKey: 'timeline-restore-stale',
  }), (error: unknown) => error instanceof Error
    && 'code' in error && error.code === 'TIMELINE_DOCUMENT_CONFLICT')

  assert.throws(() => incompatible.restores.restore({
    projectId: 'project-1',
    episodeId: 'episode-1',
    documentId: incompatible.first.timelineDocument.id,
    targetRevisionId: incompatible.first.revision.id,
    expectedRevisionId: incompatible.second.revision.id,
    idempotencyKey: 'timeline-restore-incompatible',
  }), (error: unknown) => error instanceof TimelineRevisionRestoreError
    && error.code === 'TIMELINE_RESTORE_INCOMPATIBLE')
  assert.equal(
    incompatible.timelines.listRevisions(incompatible.first.timelineDocument.id).revisions.length,
    2,
  )
})
