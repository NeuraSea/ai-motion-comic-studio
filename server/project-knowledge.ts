import type {
  ManjuDatabase,
  ProjectRecord,
  RevisionRecord,
} from './database.js'
import type { JsonObject, JsonValue } from './types.js'

const EMPTY_HEAD = 'knowledge-empty'
const CATEGORIES = new Set(['rule', 'faction', 'place', 'culture', 'visual'])
const PROJECT_SOURCE_IMPORT_MAX_CHARACTERS = 2_000_000
const PROJECT_SOURCE_FILE = /^[^/\\\u0000-\u001f\u007f]{1,255}\.(?:txt|md)$/iu

export interface ProjectKnowledgeSnapshot {
  project: ProjectRecord
  revision: RevisionRecord | null
  document: JsonObject
  etag: string
}

export class ProjectKnowledgeConflictError extends Error {
  constructor(readonly currentRevisionId: string | null) {
    super('项目知识库已在其他页面中更新，请保留本地草稿并重新读取')
    this.name = 'ProjectKnowledgeConflictError'
  }
}

export class ProjectKnowledgeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectKnowledgeValidationError'
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectKnowledgeValidationError(`${label} 必须是 JSON 对象`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !expected.includes(key))
  if (unknown.length > 0) {
    throw new ProjectKnowledgeValidationError(`${label} 包含未知字段: ${unknown.join(', ')}`)
  }
  const missing = expected.filter((key) => !(key in value))
  if (missing.length > 0) {
    throw new ProjectKnowledgeValidationError(`${label} 缺少字段: ${missing.join(', ')}`)
  }
}

function limitedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new ProjectKnowledgeValidationError(`${label} 必须是字符串`)
  if (value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new ProjectKnowledgeValidationError(`${label} 格式无效或超过 ${maximum} 字符`)
  }
  return value
}

function identifier(value: unknown, label: string): string {
  const result = limitedText(value, label, 200).trim()
  if (!result) throw new ProjectKnowledgeValidationError(`${label} 不能为空`)
  return result
}

function uniqueIds(values: JsonObject[], label: string): void {
  const ids = new Set<string>()
  for (const value of values) {
    const id = value.id as string
    if (ids.has(id)) throw new ProjectKnowledgeValidationError(`${label} 包含重复 ID: ${id}`)
    ids.add(id)
  }
}

function knowledgeDocument(value: unknown): JsonObject {
  const input = record(value, '项目知识文档')
  const keys = [
    'version',
    'sourceText',
    'worldbuilding',
    'eventLine',
    'relationshipNotes',
    'worldEntries',
    'events',
    'relationships',
  ] as const
  exactKeys(input, keys, '项目知识文档')
  if (input.version !== 2) throw new ProjectKnowledgeValidationError('项目知识文档 version 必须是 2')
  if (!Array.isArray(input.worldEntries) || input.worldEntries.length > 500) {
    throw new ProjectKnowledgeValidationError('worldEntries 必须是不超过 500 项的数组')
  }
  if (!Array.isArray(input.events) || input.events.length > 1_000) {
    throw new ProjectKnowledgeValidationError('events 必须是不超过 1000 项的数组')
  }
  if (!Array.isArray(input.relationships) || input.relationships.length > 2_000) {
    throw new ProjectKnowledgeValidationError('relationships 必须是不超过 2000 项的数组')
  }

  const worldEntries = input.worldEntries.map((raw, index): JsonObject => {
    const item = record(raw, `worldEntries[${index}]`)
    exactKeys(item, ['id', 'category', 'title', 'detail'], `worldEntries[${index}]`)
    const category = limitedText(item.category, `worldEntries[${index}].category`, 20)
    if (!CATEGORIES.has(category)) throw new ProjectKnowledgeValidationError(`worldEntries[${index}].category 无效`)
    return {
      id: identifier(item.id, `worldEntries[${index}].id`),
      category,
      title: limitedText(item.title, `worldEntries[${index}].title`, 120),
      detail: limitedText(item.detail, `worldEntries[${index}].detail`, 4_000),
    }
  })
  uniqueIds(worldEntries, 'worldEntries')

  const events = input.events.map((raw, index): JsonObject => {
    const item = record(raw, `events[${index}]`)
    exactKeys(item, ['id', 'timeLabel', 'title', 'summary', 'participants'], `events[${index}]`)
    if (!Array.isArray(item.participants) || item.participants.length > 200) {
      throw new ProjectKnowledgeValidationError(`events[${index}].participants 必须是不超过 200 项的数组`)
    }
    const participants = item.participants.map((participant, participantIndex) => (
      limitedText(participant, `events[${index}].participants[${participantIndex}]`, 100).trim()
    )).filter(Boolean)
    if (new Set(participants).size !== participants.length) {
      throw new ProjectKnowledgeValidationError(`events[${index}].participants 包含重复人物`)
    }
    return {
      id: identifier(item.id, `events[${index}].id`),
      timeLabel: limitedText(item.timeLabel, `events[${index}].timeLabel`, 80),
      title: limitedText(item.title, `events[${index}].title`, 120),
      summary: limitedText(item.summary, `events[${index}].summary`, 4_000),
      participants,
    }
  })
  uniqueIds(events, 'events')

  const relationships = input.relationships.map((raw, index): JsonObject => {
    const item = record(raw, `relationships[${index}]`)
    exactKeys(item, ['id', 'source', 'target', 'label', 'direction', 'detail'], `relationships[${index}]`)
    const direction = limitedText(item.direction, `relationships[${index}].direction`, 20)
    if (direction !== 'directed' && direction !== 'mutual') {
      throw new ProjectKnowledgeValidationError(`relationships[${index}].direction 无效`)
    }
    return {
      id: identifier(item.id, `relationships[${index}].id`),
      source: limitedText(item.source, `relationships[${index}].source`, 100),
      target: limitedText(item.target, `relationships[${index}].target`, 100),
      label: limitedText(item.label, `relationships[${index}].label`, 100),
      direction,
      detail: limitedText(item.detail, `relationships[${index}].detail`, 2_000),
    }
  })
  uniqueIds(relationships, 'relationships')

  return {
    version: 2,
    sourceText: limitedText(input.sourceText, 'sourceText', 2_000_000),
    worldbuilding: limitedText(input.worldbuilding, 'worldbuilding', 100_000),
    eventLine: limitedText(input.eventLine, 'eventLine', 100_000),
    relationshipNotes: limitedText(input.relationshipNotes, 'relationshipNotes', 100_000),
    worldEntries,
    events,
    relationships,
  }
}

function emptyKnowledge(): JsonObject {
  return {
    version: 2,
    sourceText: '',
    worldbuilding: '',
    eventLine: '',
    relationshipNotes: '',
    worldEntries: [],
    events: [],
    relationships: [],
  }
}

function etag(revisionId: string | null): string {
  return `W/"${revisionId ?? EMPTY_HEAD}"`
}

function revisionIdFromExpected(expected: string): string | null {
  return expected === EMPTY_HEAD ? null : expected
}

function knowledgeFromRevision(revision: RevisionRecord): JsonObject {
  if (revision.snapshot.kind !== 'project.knowledge'
    || revision.snapshot.version !== 2
    || !revision.snapshot.knowledge) {
    throw new Error(`Project knowledge revision is corrupt: ${revision.id}`)
  }
  return knowledgeDocument(revision.snapshot.knowledge)
}

export class ProjectKnowledgeService {
  constructor(private readonly database: ManjuDatabase) {}

  get(projectId: string): ProjectKnowledgeSnapshot {
    const project = this.database.getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    const head = this.database.withSql((sql) => sql.get(
      'SELECT current_revision_id FROM project_knowledge_heads WHERE project_id = ?',
      projectId,
    ))
    const revisionId = typeof head?.current_revision_id === 'string'
      ? head.current_revision_id
      : null
    const revision = revisionId ? this.database.getRevision(revisionId) ?? null : null
    if (revisionId && !revision) throw new Error(`Project knowledge head is corrupt: ${projectId}`)
    return {
      project,
      revision,
      document: revision ? knowledgeFromRevision(revision) : emptyKnowledge(),
      etag: etag(revision?.id ?? null),
    }
  }

  replace(
    projectId: string,
    value: unknown,
    options: { expectedRevisionId: string; summary?: string },
  ): ProjectKnowledgeSnapshot {
    const document = knowledgeDocument(value)
    return this.database.transaction(() => {
      const current = this.get(projectId)
      const expected = revisionIdFromExpected(options.expectedRevisionId)
      if ((current.revision?.id ?? null) !== expected) {
        throw new ProjectKnowledgeConflictError(current.revision?.id ?? null)
      }
      const now = new Date().toISOString()
      const revision = this.database.createRevision({
        projectId,
        parentRevisionId: current.revision?.id ?? null,
        summary: options.summary?.trim().slice(0, 500) || '更新项目知识库',
        snapshot: {
          kind: 'project.knowledge',
          version: 2,
          knowledge: document,
        },
        createdAt: now,
      })
      this.database.withSql((sql) => {
        sql.run(`
          INSERT INTO project_knowledge_revisions(project_id, revision_id, created_at)
          VALUES (?, ?, ?)
        `, projectId, revision.id, now)
        sql.run(`
          UPDATE project_knowledge_heads
             SET current_revision_id = ?, updated_at = ?
           WHERE project_id = ?
        `, revision.id, now, projectId)
      })
      return this.get(projectId)
    })
  }

  importSource(
    projectId: string,
    input: { fileName: unknown; content: unknown },
    options: { expectedRevisionId: string },
  ): ProjectKnowledgeSnapshot {
    const fileName = limitedText(input.fileName, 'fileName', 255).trim()
    if (!PROJECT_SOURCE_FILE.test(fileName)) {
      throw new ProjectKnowledgeValidationError('只支持不含路径的 .txt 或 .md 原著文件名')
    }
    const raw = limitedText(input.content, 'content', PROJECT_SOURCE_IMPORT_MAX_CHARACTERS)
    const content = raw.startsWith('\ufeff') ? raw.slice(1) : raw
    const current = this.get(projectId)
    return this.replace(projectId, {
      ...current.document,
      sourceText: content,
    }, {
      expectedRevisionId: options.expectedRevisionId,
      summary: `导入项目原著：${fileName}`,
    })
  }

  list(projectId: string): RevisionRecord[] {
    if (!this.database.getProject(projectId)) throw new Error(`Project not found: ${projectId}`)
    const rows = this.database.withSql((sql) => sql.all(`
      SELECT revision_id FROM project_knowledge_revisions
       WHERE project_id = ?
       ORDER BY created_at DESC, revision_id DESC
       LIMIT 200
    `, projectId))
    return rows.map((row) => {
      const id = row.revision_id
      if (typeof id !== 'string') throw new Error('Project knowledge revision index is corrupt')
      const revision = this.database.getRevision(id)
      if (!revision) throw new Error(`Project knowledge revision disappeared: ${id}`)
      return revision
    })
  }

  restore(
    projectId: string,
    targetRevisionId: string,
    expectedRevisionId: string,
  ): ProjectKnowledgeSnapshot {
    const belongs = this.database.withSql((sql) => sql.get(`
      SELECT revision_id FROM project_knowledge_revisions
       WHERE project_id = ? AND revision_id = ?
    `, projectId, targetRevisionId))
    if (!belongs) throw new Error(`Project knowledge revision not found: ${targetRevisionId}`)
    const target = this.database.getRevision(targetRevisionId)
    if (!target) throw new Error(`Project knowledge revision disappeared: ${targetRevisionId}`)
    return this.replace(projectId, knowledgeFromRevision(target), {
      expectedRevisionId,
      summary: `恢复项目知识修订 ${targetRevisionId}`,
    })
  }
}

export function projectKnowledgeRevisionIdFromEtag(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /^(?:W\/)?"([^"\s]+)"$/.exec(value.trim())
  return match?.[1]
}

export function projectKnowledgeAsJson(snapshot: ProjectKnowledgeSnapshot): JsonValue {
  return {
    project: snapshot.project as unknown as JsonValue,
    revision: snapshot.revision as unknown as JsonValue,
    document: snapshot.document,
    etag: snapshot.etag,
  }
}
