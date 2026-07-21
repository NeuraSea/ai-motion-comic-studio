import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import { StoryRepository } from './story-repository.js'
import {
  SQLiteTimelineAutoEditRepository,
  TimelineAutoEditError,
  TimelineAutoEditService,
  type TimelineAutoEditPlanner,
  type TimelineAutoEditProposal,
} from './timeline-auto-edit.js'
import {
  SQLiteTimelineDocumentRepository,
  TimelineDocumentService,
} from './timeline-documents.js'

const OPEN_CUT_COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'

function fixture(existingDatabase?: ManjuDatabase) {
  const database = existingDatabase
    ?? initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  database.createProject({ id: 'project-1', title: 'Agentic edit' })
  const storyRevision = database.createRevision({
    id: 'story-revision-1',
    projectId: 'project-1',
    summary: 'Story',
    snapshot: {},
  })
  new StoryRepository(database).ensureEpisode('project-1', {
    id: 'episode-1',
    title: 'Episode 1',
  })
  database.withSql((sql) => sql.run(
    'UPDATE episodes SET source_revision_id = ? WHERE id = ?',
    storyRevision.id,
    'episode-1',
  ))
  const timelines = new TimelineDocumentService(new SQLiteTimelineDocumentRepository(database))
  const base = timelines.saveReconciled({
    projectId: 'project-1',
    episodeId: 'episode-1',
    expectedRevisionId: null,
    schemaVersion: 2,
    upstreamCommit: OPEN_CUT_COMMIT,
    sourceRevisionId: storyRevision.id,
    summary: 'Base timeline',
    document: {
      version: 2,
      editor: 'OpenCut-Classic',
      upstreamCommit: OPEN_CUT_COMMIT,
      ticksPerSecond: 120_000,
      frameRate: { numerator: 24, denominator: 1 },
      marker: 'base',
      manjuTimeline: {},
      tracks: {
        overlay: [{
          id: 'visual-main',
          name: 'Visual',
          type: 'video',
          hidden: false,
          muted: false,
          elements: [{
            id: 'visual-1',
            name: 'Visual 1',
            type: 'image',
            mediaId: 'storyboard-1',
            startTime: 0,
            duration: 1_000_000,
            trimStart: 0,
            trimEnd: 0,
            params: { storyShotId: 'shot-1' },
          }],
        }],
        main: {
          id: 'main',
          name: 'Main',
          type: 'video',
          hidden: false,
          muted: false,
          elements: [],
        },
        audio: [],
      },
    },
  })
  return { database, timelines, base, storyRevision }
}

function proposal(
  base: Parameters<TimelineAutoEditPlanner['preview']>[0]['base'],
  planHash = 'a'.repeat(64),
): TimelineAutoEditProposal {
  const document = structuredClone(base.document)
  const tracks = document.tracks as unknown as {
    overlay: Array<{ elements: Array<{ id: string; duration: number }> }>
  }
  const visual = tracks.overlay.flatMap((track) => track.elements)
    .find((element) => element.id === 'visual-1')
  assert.ok(visual)
  visual.duration = 1_500_000
  document.manjuTimeline = {
    automaticEdit: {
      version: 1,
      strategy: 'managed-dialogue-reflow-v1',
      executor: 'OpenCut-Classic/UpdateElementsCommand',
      planHash,
      baseRevisionId: base.revision.id,
      sourceRevisionId: base.revision.sourceRevisionId,
      risk: 'safe',
      policy: 'auto-applied',
      operationCount: 1,
      changedElementIds: ['visual-1'],
    },
  }
  return {
    sourceRevisionId: base.revision.sourceRevisionId,
    schemaVersion: base.revision.schemaVersion,
    upstreamCommit: base.revision.upstreamCommit,
    strategy: 'managed-dialogue-reflow-v1',
    executor: 'OpenCut-Classic/UpdateElementsCommand',
    planHash,
    risk: 'safe',
    diagnostics: [{
      code: 'DIALOGUE_OVERFLOW',
      severity: 'warning',
      message: '对白超出视频尾部，可安全延长尾帧',
      elementIds: ['dialogue-1', 'visual-1'],
    }],
    operations: [{
      kind: 'update-element-timing',
      trackId: 'visual-main',
      elementId: 'visual-1',
      reason: 'extend-managed-visual-tail',
      before: { startTime: 0, duration: 1_000_000, trimStart: 0, trimEnd: 0 },
      after: { startTime: 0, duration: 1_500_000, trimStart: 0, trimEnd: 0 },
    }],
    changedElementIds: ['visual-1'],
    document,
  }
}

function service(
  database: ManjuDatabase,
  timelines: TimelineDocumentService,
  planner: TimelineAutoEditPlanner,
  ids: string[],
  token = `taec_${'t'.repeat(40)}`,
) {
  let tick = 0
  return new TimelineAutoEditService(
    database,
    timelines,
    new SQLiteTimelineAutoEditRepository(database),
    planner,
    {
      idFactory: () => ids.shift() ?? `unexpected-${tick}`,
      tokenFactory: () => token,
      now: () => `2026-07-14T01:00:0${tick++}.000Z`,
    },
  )
}

function isAutoEditError(code: string) {
  return (error: unknown) => error instanceof TimelineAutoEditError && error.code === code
}

test('preview persists an immutable server-authored plan but never stores the confirmation token', () => {
  const { database, timelines, base } = fixture()
  try {
    let calls = 0
    const planner: TimelineAutoEditPlanner = {
      preview(input) {
        calls += 1
        return proposal(input.base)
      },
    }
    const token = `taec_${'secret-capability'.repeat(3)}`
    const edits = service(database, timelines, planner, ['plan-1'], token)
    const result = edits.preview({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      goal: 'exportable',
      policy: 'safe',
    })

    assert.equal(calls, 1)
    assert.equal(result.timeline.revision.id, base.revision.id)
    assert.equal(result.plan.id, 'plan-1')
    assert.equal(result.plan.confirmationToken, token)
    assert.equal(result.plan.planHash, 'a'.repeat(64))
    assert.equal(result.previewDocument.marker, 'base')
    assert.equal(timelines.get('episode-1').revision.id, base.revision.id)

    const stored = database.withSql((sql) => sql.get(`
      SELECT confirmation_token_hash, preview_snapshot_json
        FROM timeline_auto_edit_plans WHERE id = 'plan-1'
    `))
    assert.equal(typeof stored?.confirmation_token_hash, 'string')
    assert.notEqual(stored?.confirmation_token_hash, token)
    assert.equal(String(stored?.preview_snapshot_json).includes(token), false)
    assert.throws(() => database.withSql((sql) => sql.run(`
      UPDATE timeline_auto_edit_plans SET strategy = 'tampered' WHERE id = 'plan-1'
    `)), /timeline auto edit plans are immutable/)
    assert.throws(() => database.withSql((sql) => sql.run(`
      DELETE FROM timeline_auto_edit_plans WHERE id = 'plan-1'
    `)), /timeline auto edit plans are immutable/)
  } finally {
    database.close()
  }
})

test('preview rejects a timing planner that mutates unrelated media bindings', () => {
  const { database, timelines, base } = fixture()
  try {
    const planner: TimelineAutoEditPlanner = {
      preview(input) {
        const result = proposal(input.base)
        const tracks = result.document.tracks as unknown as {
          audio: Array<Record<string, unknown>>
        }
        tracks.audio.push({
          id: 'injected-audio',
          name: 'Injected audio',
          type: 'audio',
          muted: false,
          elements: [{
            id: 'injected-bgm',
            name: 'Injected BGM',
            type: 'audio',
            sourceType: 'upload',
            mediaId: 'other-media',
            startTime: 0,
            duration: 120_000,
            trimStart: 0,
            trimEnd: 0,
            params: {},
          }],
        })
        return result
      },
    }
    const edits = service(database, timelines, planner, ['must-not-persist'])
    assert.throws(() => edits.preview({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      goal: 'exportable',
      policy: 'safe',
    }), isAutoEditError('AUTO_EDIT_PLAN_CORRUPT'))
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT COUNT(*) AS count FROM timeline_auto_edit_plans
    `))?.count, 0)
    assert.equal(timelines.get('episode-1').revision.id, base.revision.id)
  } finally {
    database.close()
  }
})

test('apply replans, creates one immutable revision, persists application receipt, and replays exactly', () => {
  const { database, timelines, base } = fixture()
  try {
    let calls = 0
    const planner: TimelineAutoEditPlanner = {
      preview(input) {
        calls += 1
        return proposal(input.base)
      },
    }
    const token = `taec_${'p'.repeat(40)}`
    const edits = service(database, timelines, planner, ['plan-1', 'application-1'], token)
    const preview = edits.preview({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      goal: 'exportable',
      policy: 'safe',
    })
    assert.throws(() => edits.apply({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      idempotencyKey: 'apply-1-wrong-token',
      planId: preview.plan.id,
      confirmationToken: 'wrong-token',
    }), isAutoEditError('AUTO_EDIT_CONFIRMATION_INVALID'))

    const applied = edits.apply({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      idempotencyKey: 'apply-1',
      planId: preview.plan.id,
      confirmationToken: preview.plan.confirmationToken,
    })
    assert.equal(calls, 2, 'preview and apply must each invoke the server planner')
    assert.equal(applied.idempotent, false)
    assert.equal(applied.application.id, 'application-1')
    assert.notEqual(applied.timeline.revision.id, base.revision.id)
    assert.equal(applied.timeline.revision.parentRevisionId, base.revision.id)
    assert.equal(applied.timeline.document.marker, 'base')
    assert.equal(applied.operationResultTimeline.revision.id, applied.timeline.revision.id)
    assert.equal(applied.headAdvanced, false)
    const receipt = (applied.timeline.document.manjuTimeline as Record<string, unknown>)
      .automaticEdit as Record<string, unknown>
    assert.equal(receipt.applicationId, 'application-1')
    assert.equal(receipt.planId, 'plan-1')

    const replay = edits.apply({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      idempotencyKey: 'apply-1',
      planId: preview.plan.id,
      confirmationToken: 'replay-does-not-require-the-secret-again',
    })
    assert.equal(replay.idempotent, true)
    assert.equal(replay.timeline.revision.id, applied.timeline.revision.id)
    assert.equal(replay.operationResultTimeline.revision.id, applied.timeline.revision.id)
    assert.equal(replay.headAdvanced, false)
    assert.equal(calls, 2)
    assert.equal(timelines.listRevisions(base.timelineDocument.id).revisions.length, 2)
    assert.throws(() => database.withSql((sql) => sql.run(`
      UPDATE timeline_edit_applications SET request_hash = '${'f'.repeat(64)}'
       WHERE id = 'application-1'
    `)), /timeline edit applications are immutable/)
    assert.throws(() => database.withSql((sql) => sql.run(`
      DELETE FROM timeline_edit_applications WHERE id = 'application-1'
    `)), /timeline edit applications are immutable/)
  } finally {
    database.close()
  }
})

test('apply rejects a changed replan atomically without creating an application or revision', () => {
  const { database, timelines, base } = fixture()
  try {
    let calls = 0
    const planner: TimelineAutoEditPlanner = {
      preview(input) {
        calls += 1
        return proposal(input.base, (calls === 1 ? 'a' : 'b').repeat(64))
      },
    }
    const edits = service(
      database,
      timelines,
      planner,
      ['plan-1'],
      `taec_${'q'.repeat(40)}`,
    )
    const preview = edits.preview({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      goal: 'exportable',
      policy: 'safe',
    })
    assert.throws(() => edits.apply({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      idempotencyKey: 'apply-changed',
      planId: preview.plan.id,
      confirmationToken: preview.plan.confirmationToken,
    }), isAutoEditError('AUTO_EDIT_REVISION_CONFLICT'))
    assert.equal(timelines.get('episode-1').revision.id, base.revision.id)
    assert.equal(database.withSql((sql) => sql.all(
      'SELECT id FROM timeline_edit_applications',
    )).length, 0)
  } finally {
    database.close()
  }
})

test('lost apply response replay returns the immutable result and never moves the current head backwards', () => {
  const { database, timelines, base } = fixture()
  try {
    const edits = service(
      database,
      timelines,
      { preview: (input) => proposal(input.base) },
      ['plan-1', 'application-1'],
      `taec_${'h'.repeat(40)}`,
    )
    const preview = edits.preview({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      goal: 'exportable',
      policy: 'safe',
    })
    // Treat this successful result as lost by the caller.
    const applied = edits.apply({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      idempotencyKey: 'lost-apply-response',
      planId: preview.plan.id,
      confirmationToken: preview.plan.confirmationToken,
    })
    const laterHead = timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: applied.timeline.revision.id,
      schemaVersion: applied.timeline.revision.schemaVersion,
      upstreamCommit: applied.timeline.revision.upstreamCommit,
      summary: 'Another tab edit',
      document: { ...structuredClone(applied.timeline.document), otherTab: true },
    })

    const replay = edits.apply({
      projectId: 'project-1',
      episodeId: 'episode-1',
      // Exact replay intentionally retains the original, now stale CAS token.
      expectedRevisionId: base.revision.id,
      idempotencyKey: 'lost-apply-response',
      planId: preview.plan.id,
      confirmationToken: 'plaintext-capability-is-not-needed-for-replay',
    })

    assert.equal(replay.idempotent, true)
    assert.equal(replay.headAdvanced, true)
    assert.equal(replay.operationResultTimeline.revision.id, applied.timeline.revision.id)
    assert.equal(replay.application.resultRevisionId, applied.timeline.revision.id)
    assert.equal(replay.timeline.revision.id, laterHead.revision.id)
    assert.equal(replay.timeline.document.otherTab, true)
    assert.equal(timelines.get('episode-1').revision.id, laterHead.revision.id)
  } finally {
    database.close()
  }
})

test('undo restores the exact base as a new revision and is durable and idempotent', () => {
  const { database, timelines, base } = fixture()
  try {
    const planner: TimelineAutoEditPlanner = { preview: (input) => proposal(input.base) }
    const edits = service(
      database,
      timelines,
      planner,
      ['plan-1', 'application-1', 'undo-1'],
      `taec_${'u'.repeat(40)}`,
    )
    const preview = edits.preview({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      goal: 'exportable',
      policy: 'safe',
    })
    const applied = edits.apply({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      idempotencyKey: 'apply-1',
      planId: preview.plan.id,
      confirmationToken: preview.plan.confirmationToken,
    })
    const undone = edits.undo({
      applicationId: applied.application.id,
      expectedRevisionId: applied.timeline.revision.id,
      idempotencyKey: 'undo-1',
    })
    assert.equal(undone.idempotent, false)
    assert.equal(undone.undo.id, 'undo-1')
    assert.equal(undone.timeline.revision.parentRevisionId, applied.timeline.revision.id)
    assert.deepEqual(undone.timeline.document, base.document)
    assert.equal(undone.operationResultTimeline.revision.id, undone.timeline.revision.id)
    assert.equal(undone.headAdvanced, false)
    assert.equal(
      (undone.timeline.document.manjuTimeline as Record<string, unknown> | undefined)
        ?.automaticEdit,
      undefined,
    )

    const replay = edits.undo({
      applicationId: applied.application.id,
      expectedRevisionId: applied.timeline.revision.id,
      idempotencyKey: 'undo-1',
    })
    assert.equal(replay.idempotent, true)
    assert.equal(replay.timeline.revision.id, undone.timeline.revision.id)
    assert.equal(replay.operationResultTimeline.revision.id, undone.timeline.revision.id)
    assert.equal(replay.headAdvanced, false)
    assert.equal(timelines.listRevisions(base.timelineDocument.id).revisions.length, 3)

    const laterHead = timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: undone.timeline.revision.id,
      schemaVersion: undone.timeline.revision.schemaVersion,
      upstreamCommit: undone.timeline.revision.upstreamCommit,
      summary: 'Another tab after undo',
      document: { ...structuredClone(undone.timeline.document), otherTab: true },
    })
    const replayAfterLaterRevision = edits.undo({
      applicationId: applied.application.id,
      expectedRevisionId: applied.timeline.revision.id,
      idempotencyKey: 'undo-1',
    })
    assert.equal(replayAfterLaterRevision.idempotent, true)
    assert.equal(replayAfterLaterRevision.headAdvanced, true)
    assert.equal(
      replayAfterLaterRevision.operationResultTimeline.revision.id,
      undone.timeline.revision.id,
    )
    assert.equal(replayAfterLaterRevision.timeline.revision.id, laterHead.revision.id)
    assert.equal(timelines.get('episode-1').revision.id, laterHead.revision.id)
    assert.throws(() => database.withSql((sql) => sql.run(`
      UPDATE timeline_edit_undos SET request_hash = '${'f'.repeat(64)}' WHERE id = 'undo-1'
    `)), /timeline edit undos are immutable/)
    assert.throws(() => database.withSql((sql) => sql.run(`
      DELETE FROM timeline_edit_undos WHERE id = 'undo-1'
    `)), /timeline edit undos are immutable/)
  } finally {
    database.close()
  }
})

test('undo refuses to overwrite later manual timeline edits', () => {
  const { database, timelines, base } = fixture()
  try {
    const planner: TimelineAutoEditPlanner = { preview: (input) => proposal(input.base) }
    const edits = service(
      database,
      timelines,
      planner,
      ['plan-1', 'application-1'],
      `taec_${'v'.repeat(40)}`,
    )
    const preview = edits.preview({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      goal: 'exportable',
      policy: 'safe',
    })
    const applied = edits.apply({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: base.revision.id,
      idempotencyKey: 'apply-1',
      planId: preview.plan.id,
      confirmationToken: preview.plan.confirmationToken,
    })
    const manual = timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: applied.timeline.revision.id,
      schemaVersion: applied.timeline.revision.schemaVersion,
      upstreamCommit: applied.timeline.revision.upstreamCommit,
      summary: 'Manual edit',
      document: { ...applied.timeline.document, manual: true },
    })
    assert.throws(() => edits.undo({
      applicationId: applied.application.id,
      expectedRevisionId: manual.revision.id,
      idempotencyKey: 'undo-after-manual',
    }), isAutoEditError('AUTO_EDIT_REVISION_CONFLICT'))
    assert.equal(timelines.get('episode-1').revision.id, manual.revision.id)
  } finally {
    database.close()
  }
})

test('a preview capability survives server restart without storing its plaintext token', () => {
  const directory = mkdtempSync(join(tmpdir(), 'manju-auto-edit-restart-'))
  let database = initializeDatabase({ runtimeDirectory: directory, legacyStatePath: false })
  let timelines: TimelineDocumentService
  try {
    const initial = fixture(database)
    timelines = initial.timelines
    const token = `taec_${'restart-capability'.repeat(3)}`
    const first = service(
      database,
      timelines,
      { preview: (input) => proposal(input.base) },
      ['plan-before-restart'],
      token,
    )
    const preview = first.preview({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: initial.base.revision.id,
      goal: 'exportable',
      policy: 'safe',
    })
    database.close()

    database = initializeDatabase({ runtimeDirectory: directory, legacyStatePath: false })
    timelines = new TimelineDocumentService(new SQLiteTimelineDocumentRepository(database))
    const restarted = service(
      database,
      timelines,
      { preview: (input) => proposal(input.base) },
      ['application-after-restart'],
      'unused-new-token',
    )
    const applied = restarted.apply({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: initial.base.revision.id,
      idempotencyKey: 'apply-after-restart',
      planId: preview.plan.id,
      confirmationToken: token,
    })
    assert.equal(applied.application.id, 'application-after-restart')
    assert.equal(applied.timeline.revision.parentRevisionId, initial.base.revision.id)
    const row = database.withSql((sql) => sql.get(`
      SELECT confirmation_token_hash FROM timeline_auto_edit_plans
       WHERE id = 'plan-before-restart'
    `))
    assert.notEqual(row?.confirmation_token_hash, token)
  } finally {
    try {
      database.close()
    } catch {
      // Already closed before the restart branch.
    }
    rmSync(directory, { recursive: true, force: true })
  }
})
