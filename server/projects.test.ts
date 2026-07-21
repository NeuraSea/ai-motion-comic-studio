import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initializeDatabase } from './database.js'
import { ProjectConflictError, ProjectService, revisionIdFromEtag } from './projects.js'

test('project snapshots create immutable revisions and enforce optimistic locking', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    const projects = new ProjectService(database)
    const initial = projects.ensureDefaultProject()
    assert.equal(initial.document.sourceText, '')
    assert.equal(revisionIdFromEtag(initial.etag), initial.revision.id)

    const updated = projects.replaceSnapshot(initial.project.id, {
      ...initial.document,
      sourceText: '真实项目内容',
    }, { expectedRevisionId: initial.revision.id })
    assert.notEqual(updated.revision.id, initial.revision.id)
    assert.equal(updated.revision.parentRevisionId, initial.revision.id)
    assert.equal(updated.document.sourceText, '真实项目内容')
    assert.equal(projects.listRevisions(initial.project.id).length, 2)

    assert.throws(
      () => projects.replaceSnapshot(initial.project.id, initial.document, {
        expectedRevisionId: initial.revision.id,
      }),
      (error: unknown) => error instanceof ProjectConflictError
        && error.currentRevisionId === updated.revision.id,
    )
  } finally {
    database.close()
  }
})

test('restoring a revision creates a new auditable head instead of rewinding history', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    const projects = new ProjectService(database)
    const initial = projects.ensureDefaultProject()
    const changed = projects.replaceSnapshot(initial.project.id, { value: 'changed' })
    const restored = projects.restoreRevision(initial.project.id, initial.revision.id, changed.revision.id)
    assert.deepEqual(restored.document.sourceText, '')
    assert.equal(restored.revision.parentRevisionId, changed.revision.id)
    assert.equal(projects.listRevisions(initial.project.id).length, 3)
  } finally {
    database.close()
  }
})
