import type { ManjuDatabase, ProjectRecord, RevisionRecord } from './database.js'
import type { JsonObject } from './types.js'

export class ProjectConflictError extends Error {
  constructor(readonly currentRevisionId: string | null) {
    super('项目已在其他页面中更新，请刷新后重试')
    this.name = 'ProjectConflictError'
  }
}

export interface ProjectSnapshot {
  project: ProjectRecord
  revision: RevisionRecord
  document: JsonObject
  etag: string
}

function defaultDocument(now: string): JsonObject {
  return {
    version: 1,
    sourceText: '',
    shots: [],
    settings: {
      style: '国风动画',
      aspect: '16:9',
      consistencyLocked: true,
    },
    visualAssets: {},
    createdAt: now,
    updatedAt: now,
  }
}

function etag(revisionId: string): string {
  return `W/"${revisionId}"`
}

function projectTitle(document: JsonObject, fallback: string): string {
  const value = document.title
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : fallback
}

function projectSettings(document: JsonObject, fallback: JsonObject): JsonObject {
  const value = document.settings
  const next = value && typeof value === 'object' && !Array.isArray(value)
    ? structuredClone(value as JsonObject)
    : structuredClone(fallback)
  // Narrator casting is an independently audited settings record. Project
  // document replacement must neither inject it nor erase it with a stale
  // document snapshot; only the dedicated narrator profile repository writes
  // these two reserved keys.
  delete next.narratorVoiceProfile
  delete next.narratorVoiceProfileRevisionId
  if (fallback.narratorVoiceProfile !== undefined) {
    next.narratorVoiceProfile = structuredClone(fallback.narratorVoiceProfile)
  }
  if (fallback.narratorVoiceProfileRevisionId !== undefined) {
    next.narratorVoiceProfileRevisionId = fallback.narratorVoiceProfileRevisionId
  }
  return next
}

export class ProjectService {
  constructor(private readonly database: ManjuDatabase) {}

  ensureDefaultProject(): ProjectSnapshot {
    const existing = this.database.listProjects({ limit: 1 })[0]
    if (existing) return this.getSnapshot(existing.id)
    return this.database.transaction(() => {
      const raced = this.database.listProjects({ limit: 1 })[0]
      if (raced) return this.getSnapshot(raced.id)
      const now = new Date().toISOString()
      const document = defaultDocument(now)
      const project = this.database.createProject({
        id: 'default',
        title: '未命名漫剧',
        settings: document.settings as JsonObject,
        createdAt: now,
        updatedAt: now,
      })
      const revision = this.database.createRevision({
        projectId: project.id,
        summary: '创建项目',
        snapshot: document,
        createdAt: now,
      })
      const updated = this.database.updateProject(project.id, { currentRevisionId: revision.id })
      if (!updated) throw new Error('Failed to initialize project')
      return { project: updated, revision, document, etag: etag(revision.id) }
    })
  }

  listProjects(): ProjectRecord[] {
    return this.database.listProjects({ limit: 200 })
  }

  getSnapshot(projectId: string): ProjectSnapshot {
    const project = this.database.getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    let revision = project.currentRevisionId
      ? this.database.getRevision(project.currentRevisionId)
      : undefined
    if (!revision) {
      revision = this.database.listRevisions(project.id, { limit: 1 })[0]
    }
    if (!revision) {
      return this.database.transaction(() => {
        const now = new Date().toISOString()
        const document = defaultDocument(now)
        const created = this.database.createRevision({
          projectId,
          summary: '补齐项目初始版本',
          snapshot: document,
        })
        const updated = this.database.updateProject(projectId, { currentRevisionId: created.id })
        if (!updated) throw new Error(`Project disappeared: ${projectId}`)
        return { project: updated, revision: created, document, etag: etag(created.id) }
      })
    }
    return {
      project,
      revision,
      document: structuredClone(revision.snapshot),
      etag: etag(revision.id),
    }
  }

  replaceSnapshot(
    projectId: string,
    document: JsonObject,
    options: { expectedRevisionId?: string; summary?: string } = {},
  ): ProjectSnapshot {
    return this.database.transaction(() => {
      const current = this.database.getProject(projectId)
      if (!current) throw new Error(`Project not found: ${projectId}`)
      if (options.expectedRevisionId !== undefined && current.currentRevisionId !== options.expectedRevisionId) {
        throw new ProjectConflictError(current.currentRevisionId)
      }
      const now = new Date().toISOString()
      const nextDocument = structuredClone({ ...document, updatedAt: now })
      const revision = this.database.createRevision({
        projectId,
        parentRevisionId: current.currentRevisionId,
        summary: options.summary?.trim().slice(0, 500) || '更新项目',
        snapshot: nextDocument,
      })
      const updated = this.database.updateProject(projectId, {
        title: projectTitle(nextDocument, current.title),
        settings: projectSettings(nextDocument, current.settings),
        currentRevisionId: revision.id,
      })
      if (!updated) throw new Error(`Project disappeared: ${projectId}`)
      return { project: updated, revision, document: nextDocument, etag: etag(revision.id) }
    })
  }

  listRevisions(projectId: string): RevisionRecord[] {
    if (!this.database.getProject(projectId)) throw new Error(`Project not found: ${projectId}`)
    return this.database.listRevisions(projectId, { limit: 200 })
  }

  restoreRevision(projectId: string, revisionId: string, expectedRevisionId?: string): ProjectSnapshot {
    const revision = this.database.getRevision(revisionId)
    if (!revision || revision.projectId !== projectId) throw new Error(`Revision not found: ${revisionId}`)
    return this.replaceSnapshot(projectId, revision.snapshot, {
      expectedRevisionId,
      summary: `恢复版本 ${revisionId}`,
    })
  }
}

export function revisionIdFromEtag(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /^(?:W\/)?"([^"\s]+)"$/.exec(value.trim())
  return match?.[1]
}
