import assert from 'node:assert/strict'
import test from 'node:test'

import {
  projectKnowledgeFromDocument,
  projectKnowledgeIsMeaningful,
  projectRelationshipGraph,
  sameProjectKnowledge,
  serializeProjectKnowledge,
} from '../src/features/catalog/project-knowledge-document'

test('legacy project knowledge migrates without losing any prose', () => {
  const parsed = projectKnowledgeFromDocument({
    knowledge: {
      sourceText: '原著正文',
      worldbuilding: '灵力来自龙脉。',
      eventLine: '十年前龙脉苏醒。',
      relationshipNotes: '阿离与守山人为师徒。',
    },
    unrelatedProjectSetting: true,
  })

  assert.equal(parsed.version, 2)
  assert.equal(parsed.sourceText, '原著正文')
  assert.equal(parsed.worldbuilding, '灵力来自龙脉。')
  assert.equal(parsed.eventLine, '十年前龙脉苏醒。')
  assert.equal(parsed.relationshipNotes, '阿离与守山人为师徒。')
  assert.deepEqual(parsed.worldEntries, [])
  assert.deepEqual(parsed.events, [])
  assert.deepEqual(parsed.relationships, [])
  assert.equal(projectKnowledgeIsMeaningful(parsed), true)
})

test('structured project knowledge round-trips stable identities and filters corrupt duplicates', () => {
  const parsed = projectKnowledgeFromDocument({
    knowledge: {
      version: 2,
      sourceText: '母本',
      worldbuilding: '',
      eventLine: '',
      relationshipNotes: '',
      worldEntries: [
        { id: 'world-1', category: 'rule', title: '龙脉', detail: '不可逆。' },
        { id: 'world-1', category: 'place', title: '重复身份', detail: '必须过滤。' },
        { id: 'world-bad', category: 'not-real', title: '无效', detail: '无效' },
      ],
      events: [
        {
          id: 'event-1',
          timeLabel: '十年前',
          title: '龙醒',
          summary: '龙脉首次苏醒。',
          participants: ['阿离', '阿离', '', '守山人'],
        },
      ],
      relationships: [
        { id: 'relation-1', source: '阿离', target: '守山人', label: '师徒', direction: 'mutual', detail: '互相信任' },
      ],
    },
  })

  assert.equal(parsed.worldEntries.length, 1)
  assert.deepEqual(parsed.events[0]?.participants, ['阿离', '守山人'])
  assert.equal(parsed.relationships[0]?.direction, 'mutual')

  const serialized = serializeProjectKnowledge(parsed)
  const roundTrip = projectKnowledgeFromDocument({ knowledge: serialized })
  assert.equal(sameProjectKnowledge(parsed, roundTrip), true)
  assert.notEqual(serialized, parsed)
  assert.notEqual((serialized.events as object[])[0], parsed.events[0])
})

test('relationship graph is deterministic, ignores incomplete edges, and keeps mutual direction', () => {
  const relationships = [
    { id: 'r1', source: '阿离', target: '守山人', label: '师徒', direction: 'mutual' as const, detail: '' },
    { id: 'r2', source: '守山人', target: '反派', label: '宿敌', direction: 'directed' as const, detail: '' },
    { id: 'r3', source: '', target: '反派', label: '无效', direction: 'directed' as const, detail: '' },
    { id: 'r4', source: '阿离', target: '阿离', label: '自环', direction: 'directed' as const, detail: '' },
  ]

  const first = projectRelationshipGraph(relationships)
  const second = projectRelationshipGraph(relationships)
  assert.deepEqual(first, second)
  assert.deepEqual(first.nodes.map((node) => node.label), ['阿离', '守山人', '反派'])
  assert.deepEqual(first.edges.map((edge) => edge.id), ['r1', 'r2'])
  assert.equal(first.edges[0]?.direction, 'mutual')
})
