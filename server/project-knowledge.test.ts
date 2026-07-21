import assert from 'node:assert/strict'
import test from 'node:test'

import { initializeDatabase } from './database.js'
import {
  ProjectKnowledgeConflictError,
  ProjectKnowledgeService,
  ProjectKnowledgeValidationError,
} from './project-knowledge.js'

function knowledge(sourceText: string, suffix = '1') {
  return {
    version: 2,
    sourceText,
    worldbuilding: '龙脉决定灵力规则。',
    eventLine: '十年前龙脉苏醒。',
    relationshipNotes: '阿离与守山人为师徒。',
    worldEntries: [{ id: `world-${suffix}`, category: 'rule', title: '龙脉', detail: '不可逆。' }],
    events: [{ id: `event-${suffix}`, timeLabel: '十年前', title: '龙醒', summary: '龙脉苏醒。', participants: ['阿离'] }],
    relationships: [{ id: `relation-${suffix}`, source: '阿离', target: '守山人', label: '师徒', direction: 'mutual', detail: '' }],
  }
}

test('project knowledge has an independent head that does not follow generic project audits', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    const project = database.createProject({ id: 'project-1', title: '长安' })
    const generic = database.createRevision({
      id: 'generic-revision-1',
      projectId: project.id,
      summary: '设置角色声线',
      snapshot: { voiceProfile: { voiceId: 'voice-1' } },
    })
    database.updateProject(project.id, { currentRevisionId: generic.id })
    const service = new ProjectKnowledgeService(database)

    const empty = service.get(project.id)
    assert.equal(empty.revision, null)
    assert.equal(empty.etag, 'W/"knowledge-empty"')
    assert.equal(empty.document.version, 2)

    const first = service.replace(project.id, knowledge('项目母本 A'), {
      expectedRevisionId: 'knowledge-empty',
    })
    assert.equal(first.document.sourceText, '项目母本 A')
    assert.ok(first.revision)
    assert.equal(database.getProject(project.id)?.currentRevisionId, generic.id)
    assert.deepEqual(service.list(project.id).map((revision) => revision.id), [first.revision?.id])

    const laterGeneric = database.createRevision({
      id: 'generic-revision-2',
      projectId: project.id,
      parentRevisionId: generic.id,
      summary: '锁定角色视觉资产',
      snapshot: { assetLock: true },
    })
    database.updateProject(project.id, { currentRevisionId: laterGeneric.id })
    assert.equal(service.get(project.id).revision?.id, first.revision?.id)
    assert.equal(service.get(project.id).document.sourceText, '项目母本 A')
  } finally {
    database.close()
  }
})

test('knowledge save is optimistic, immutable, strictly validated, and restore creates a new head', () => {
  let sequence = 0
  const database = initializeDatabase({
    databasePath: ':memory:',
    legacyStatePath: false,
    idFactory: () => `revision-${++sequence}`,
    now: () => `2026-07-15T00:00:0${sequence}.000Z`,
  })
  try {
    database.createProject({ id: 'project-1', title: '长安' })
    const service = new ProjectKnowledgeService(database)
    const first = service.replace('project-1', knowledge('A', 'a'), {
      expectedRevisionId: 'knowledge-empty',
      summary: '知识 A',
    })
    const second = service.replace('project-1', knowledge('B', 'b'), {
      expectedRevisionId: first.revision!.id,
      summary: '知识 B',
    })

    assert.throws(
      () => service.replace('project-1', knowledge('冲突', 'c'), {
        expectedRevisionId: first.revision!.id,
      }),
      ProjectKnowledgeConflictError,
    )
    assert.throws(
      () => service.replace('project-1', { ...knowledge('坏数据'), version: 1 }, {
        expectedRevisionId: second.revision!.id,
      }),
      ProjectKnowledgeValidationError,
    )

    const restored = service.restore('project-1', first.revision!.id, second.revision!.id)
    assert.notEqual(restored.revision?.id, first.revision?.id)
    assert.equal(restored.revision?.parentRevisionId, second.revision?.id)
    assert.equal(restored.document.sourceText, 'A')
    assert.equal(service.list('project-1').length, 3)

    assert.throws(() => database.withSql((sql) => sql.run(
      "UPDATE revisions SET summary = 'rewritten' WHERE id = ?",
      first.revision!.id,
    )), /project knowledge snapshots are immutable/)
    assert.throws(() => database.withSql((sql) => sql.run(
      'DELETE FROM project_knowledge_revisions WHERE revision_id = ?',
      first.revision!.id,
    )), /project knowledge revisions are immutable/)
  } finally {
    database.close()
  }
})

test('project source import creates an immutable knowledge revision and preserves structured knowledge', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'project-import', title: '导入原著' })
    const service = new ProjectKnowledgeService(database)
    const first = service.replace('project-import', knowledge('旧原著', 'import'), {
      expectedRevisionId: 'knowledge-empty',
    })
    const imported = service.importSource('project-import', {
      fileName: '龙醒.md',
      content: '\ufeff# 新原著\n\n龙脉苏醒。',
    }, {
      expectedRevisionId: first.revision!.id,
    })

    assert.equal(imported.document.sourceText, '# 新原著\n\n龙脉苏醒。')
    assert.deepEqual(imported.document.worldEntries, first.document.worldEntries)
    assert.deepEqual(imported.document.events, first.document.events)
    assert.deepEqual(imported.document.relationships, first.document.relationships)
    assert.equal(imported.revision?.summary, '导入项目原著：龙醒.md')
    assert.equal(imported.revision?.parentRevisionId, first.revision?.id)
    assert.equal(service.list('project-import').length, 2)

    assert.throws(() => service.importSource('project-import', {
      fileName: '../secret.txt',
      content: 'bad',
    }, { expectedRevisionId: imported.revision!.id }), ProjectKnowledgeValidationError)
    assert.throws(() => service.importSource('project-import', {
      fileName: 'story.pdf',
      content: 'bad',
    }, { expectedRevisionId: imported.revision!.id }), ProjectKnowledgeValidationError)
    assert.throws(() => service.importSource('project-import', {
      fileName: 'story.txt',
      content: 'stale',
    }, { expectedRevisionId: first.revision!.id }), ProjectKnowledgeConflictError)
  } finally {
    database.close()
  }
})
