import { randomUUID } from 'node:crypto'

import type { ManjuDatabase } from './database.js'
import {
  currentMediaAuthority,
  withServerMediaAuthorityFingerprint,
} from './media-authority.js'
import type { JsonObject, JsonValue } from './types.js'

export const MAX_TIMELINE_DOCUMENT_BYTES = 1024 * 1024
export const MAX_TIMELINE_DOCUMENT_DEPTH = 64
export const MAX_TIMELINE_DOCUMENT_NODES = 100_000

const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export interface TimelineDocumentRecord {
  id: string
  projectId: string
  episodeId: string
  currentRevisionId: string
  schemaVersion: number
  upstreamCommit: string
  sourceRevisionId: string | null
  createdAt: string
  updatedAt: string
}

export interface TimelineDocumentRevisionRecord {
  id: string
  documentId: string
  projectId: string
  episodeId: string
  parentRevisionId: string | null
  schemaVersion: number
  upstreamCommit: string
  sourceRevisionId: string | null
  summary: string
  snapshot: JsonObject
  createdAt: string
}

export interface TimelineDocumentSnapshot {
  timelineDocument: TimelineDocumentRecord
  revision: TimelineDocumentRevisionRecord
  document: JsonObject
  etag: string
}

export interface SaveTimelineDocumentInput {
  projectId: string
  episodeId: string
  /** `null` is the explicit create-only precondition used by `If-Match: *`. */
  expectedRevisionId: string | null
  schemaVersion: number
  upstreamCommit: string
  summary?: string
  document: JsonObject
}

/** Trusted Story materialization/reconciliation write; never accepts HTTP body data directly. */
export interface SaveReconciledTimelineDocumentInput extends SaveTimelineDocumentInput {
  sourceRevisionId: string
  /** Exact current DB authority, supplied only by trusted materialize/reconcile. */
  mediaAuthorityFingerprint?: string
}

interface PersistTimelineDocumentInput extends SaveTimelineDocumentInput {
  sourceRevisionId?: string | null
  mediaAuthorityFingerprint?: string
}

export interface SaveTimelineDocumentResult extends TimelineDocumentSnapshot {
  created: boolean
}

export interface TimelineDocumentHistory {
  timelineDocument: TimelineDocumentRecord
  revisions: TimelineDocumentRevisionRecord[]
}

export type TimelineDocumentErrorCode =
  | 'CORRUPT_TIMELINE_DOCUMENT'
  | 'EPISODE_NOT_FOUND'
  | 'EPISODE_PROJECT_MISMATCH'
  | 'INVALID_SCHEMA_VERSION'
  | 'INVALID_TIMELINE_DOCUMENT'
  | 'INVALID_UPSTREAM_COMMIT'
  | 'SOURCE_REVISION_NOT_FOUND'
  | 'SOURCE_REVISION_PROJECT_MISMATCH'
  | 'TIMELINE_DOCUMENT_CONFLICT'
  | 'TIMELINE_DOCUMENT_NOT_FOUND'

export class TimelineDocumentError extends Error {
  constructor(
    readonly code: TimelineDocumentErrorCode,
    message: string,
    readonly currentRevisionId?: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TimelineDocumentError'
  }
}

export interface TimelineDocumentRepository {
  getForEpisode(episodeId: string): TimelineDocumentSnapshot | undefined
  getRevision(revisionId: string): TimelineDocumentSnapshot | undefined
  save(input: PersistTimelineDocumentInput): SaveTimelineDocumentResult
  listRevisions(documentId: string, options?: { limit?: number; offset?: number }): TimelineDocumentHistory
}

type SqlRow = Record<string, unknown>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredString(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not text`)
  return value
}

function nullableString(row: SqlRow, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not nullable text`)
  return value
}

function requiredNumber(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value !== 'number') throw new Error(`Database column ${column} is not numeric`)
  return value
}

function asTimelineDocument(row: SqlRow): TimelineDocumentRecord {
  return {
    id: requiredString(row, 'id'),
    projectId: requiredString(row, 'project_id'),
    episodeId: requiredString(row, 'episode_id'),
    currentRevisionId: requiredString(row, 'current_revision_id'),
    schemaVersion: requiredNumber(row, 'schema_version'),
    upstreamCommit: requiredString(row, 'upstream_commit'),
    sourceRevisionId: nullableString(row, 'source_revision_id'),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
  }
}

function parseSnapshot(value: unknown): JsonObject {
  if (typeof value !== 'string') throw new Error('Database column snapshot_json is not JSON text')
  const parsed: unknown = JSON.parse(value)
  if (!isPlainObject(parsed)) throw new Error('Database column snapshot_json is not a JSON object')
  return parsed as JsonObject
}

function asTimelineDocumentRevision(row: SqlRow): TimelineDocumentRevisionRecord {
  return {
    id: requiredString(row, 'id'),
    documentId: requiredString(row, 'document_id'),
    projectId: requiredString(row, 'project_id'),
    episodeId: requiredString(row, 'episode_id'),
    parentRevisionId: nullableString(row, 'parent_revision_id'),
    schemaVersion: requiredNumber(row, 'schema_version'),
    upstreamCommit: requiredString(row, 'upstream_commit'),
    sourceRevisionId: nullableString(row, 'source_revision_id'),
    summary: requiredString(row, 'summary'),
    snapshot: parseSnapshot(row.snapshot_json),
    createdAt: requiredString(row, 'created_at'),
  }
}

function timelineEtag(revisionId: string): string {
  return `W/"${revisionId}"`
}

function normalizeSchemaVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new TimelineDocumentError(
      'INVALID_SCHEMA_VERSION',
      'timeline schemaVersion must be an integer between 1 and 1000000',
    )
  }
  return value
}

function normalizeUpstreamCommit(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new TimelineDocumentError(
      'INVALID_UPSTREAM_COMMIT',
      'timeline upstreamCommit must be a full 40-character Git commit SHA',
    )
  }
  return normalized
}

function normalizeSummary(value: string | undefined, created: boolean): string {
  const normalized = value?.trim()
  return (normalized || (created ? '创建时间线' : '更新时间线')).slice(0, 500)
}

function validateJsonNode(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number; seen: Set<unknown> },
): asserts value is JsonValue {
  state.nodes += 1
  if (state.nodes > MAX_TIMELINE_DOCUMENT_NODES) {
    throw new TimelineDocumentError('INVALID_TIMELINE_DOCUMENT', '时间线文档节点数过多')
  }
  if (depth > MAX_TIMELINE_DOCUMENT_DEPTH) {
    throw new TimelineDocumentError('INVALID_TIMELINE_DOCUMENT', '时间线文档层级过深')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TimelineDocumentError('INVALID_TIMELINE_DOCUMENT', `${path} 包含非有限数值`)
    }
    return
  }
  if (typeof value !== 'object') {
    throw new TimelineDocumentError('INVALID_TIMELINE_DOCUMENT', `${path} 不是可序列化 JSON`)
  }
  if (state.seen.has(value)) {
    throw new TimelineDocumentError('INVALID_TIMELINE_DOCUMENT', `${path} 包含循环引用`)
  }
  state.seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonNode(item, `${path}[${index}]`, depth + 1, state))
  } else {
    if (!isPlainObject(value)) {
      throw new TimelineDocumentError('INVALID_TIMELINE_DOCUMENT', `${path} 必须是普通 JSON 对象`)
    }
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_JSON_KEYS.has(key)) {
        throw new TimelineDocumentError('INVALID_TIMELINE_DOCUMENT', `${path}.${key} 是不安全的 JSON 字段`)
      }
      validateJsonNode(item, `${path}.${key}`, depth + 1, state)
    }
  }
  state.seen.delete(value)
}

/** Validate and canonicalize without projecting onto a schema, preserving unknown OpenCut fields. */
export function serializeTimelineDocument(value: unknown): string {
  if (!isPlainObject(value)) {
    throw new TimelineDocumentError('INVALID_TIMELINE_DOCUMENT', '时间线 document 必须是 JSON 对象')
  }
  validateJsonNode(value, '$', 0, { nodes: 0, seen: new Set() })
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TIMELINE_DOCUMENT_BYTES) {
    throw new TimelineDocumentError(
      'INVALID_TIMELINE_DOCUMENT',
      `时间线文档不能超过 ${MAX_TIMELINE_DOCUMENT_BYTES} 字节`,
    )
  }
  return serialized
}

function normalizePage(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized < (label === 'offset' ? 0 : 1)) {
    throw new RangeError(`${label} is invalid`)
  }
  return label === 'limit' ? Math.min(normalized, 100) : normalized
}

interface EpisodeOwner {
  projectId: string
  sourceRevisionId: string | null
}

export interface SQLiteTimelineDocumentRepositoryOptions {
  now?: () => string
  idFactory?: () => string
}

export class SQLiteTimelineDocumentRepository implements TimelineDocumentRepository {
  private readonly now: () => string
  private readonly idFactory: () => string

  constructor(
    private readonly database: ManjuDatabase,
    options: SQLiteTimelineDocumentRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
  }

  getForEpisode(episodeId: string): TimelineDocumentSnapshot | undefined {
    const timelineDocument = this.database.withSql((sql) => {
      const row = sql.get('SELECT * FROM timeline_documents WHERE episode_id = ?', episodeId)
      return row ? asTimelineDocument(row) : undefined
    })
    if (!timelineDocument) return undefined
    const revision = this.requireRevision(timelineDocument.currentRevisionId)
    if (revision.documentId !== timelineDocument.id) {
      throw new TimelineDocumentError(
        'CORRUPT_TIMELINE_DOCUMENT',
        `Timeline document ${timelineDocument.id} points to another document's revision`,
      )
    }
    return {
      timelineDocument,
      revision,
      document: structuredClone(revision.snapshot),
      etag: timelineEtag(revision.id),
    }
  }

  /**
   * Return the immutable snapshot as it looked when this revision was the
   * document head. This is used for exact idempotent response replay and for
   * undo-as-a-new-revision; it never moves the mutable document pointer.
   */
  getRevision(revisionId: string): TimelineDocumentSnapshot | undefined {
    const revision = this.database.withSql((sql) => {
      const row = sql.get('SELECT * FROM timeline_document_revisions WHERE id = ?', revisionId)
      return row ? asTimelineDocumentRevision(row) : undefined
    })
    if (!revision) return undefined
    const timelineDocument = this.database.withSql((sql) => {
      const row = sql.get('SELECT * FROM timeline_documents WHERE id = ?', revision.documentId)
      return row ? asTimelineDocument(row) : undefined
    })
    if (!timelineDocument) {
      throw new TimelineDocumentError(
        'CORRUPT_TIMELINE_DOCUMENT',
        `Timeline revision ${revisionId} has no owning document`,
      )
    }
    const historicalDocument: TimelineDocumentRecord = {
      ...timelineDocument,
      currentRevisionId: revision.id,
      schemaVersion: revision.schemaVersion,
      upstreamCommit: revision.upstreamCommit,
      sourceRevisionId: revision.sourceRevisionId,
      updatedAt: revision.createdAt,
    }
    return {
      timelineDocument: historicalDocument,
      revision,
      document: structuredClone(revision.snapshot),
      etag: timelineEtag(revision.id),
    }
  }

  save(input: PersistTimelineDocumentInput): SaveTimelineDocumentResult {
    const projectId = input.projectId.trim()
    const episodeId = input.episodeId.trim()
    if (!projectId || !episodeId) {
      throw new TimelineDocumentError('EPISODE_NOT_FOUND', 'projectId and episodeId are required')
    }
    const schemaVersion = normalizeSchemaVersion(input.schemaVersion)
    const upstreamCommit = normalizeUpstreamCommit(input.upstreamCommit)

    return this.database.transaction(() => {
      const owner = this.requireEpisodeOwner(episodeId)
      if (owner.projectId !== projectId) {
        throw new TimelineDocumentError(
          'EPISODE_PROJECT_MISMATCH',
          `Episode ${episodeId} does not belong to project ${projectId}`,
        )
      }
      const current = this.getForEpisode(episodeId)
      const sourceRevisionId = input.sourceRevisionId === undefined
        // An ordinary autosave must not falsely claim that an unreconciled
        // timeline already represents a newer story revision. New ordinary
        // documents start unbound; later saves retain the existing binding.
        // Only saveReconciled() supplies an explicit trusted source revision.
        ? current?.timelineDocument.sourceRevisionId ?? null
        : input.sourceRevisionId
      this.assertSourceRevision(projectId, sourceRevisionId)
      const trustedFingerprint = input.sourceRevisionId === undefined
        ? null
        : input.mediaAuthorityFingerprint ?? null
      if (trustedFingerprint !== null) {
        const authority = currentMediaAuthority(this.database, { projectId, episodeId })
        if (authority.sourceRevisionId !== sourceRevisionId
          || authority.fingerprint !== trustedFingerprint) {
          throw new TimelineDocumentError(
            'INVALID_TIMELINE_DOCUMENT',
            '时间线媒体权威回执与当前数据库事实不一致',
          )
        }
      }
      // Snapshot JSON is never a source of authority. Ordinary writes remove
      // even a correctly precomputed value and receive no durable receipt.
      const document = withServerMediaAuthorityFingerprint(
        input.document,
        trustedFingerprint,
      )
      const snapshotJson = serializeTimelineDocument(document)

      if (current) {
        if (input.expectedRevisionId === null
          || input.expectedRevisionId !== current.timelineDocument.currentRevisionId) {
          throw new TimelineDocumentError(
            'TIMELINE_DOCUMENT_CONFLICT',
            '时间线已在其他编辑会话中更新，请刷新后重试',
            current.timelineDocument.currentRevisionId,
          )
        }
        const revisionId = this.idFactory()
        const now = this.now()
        const summary = normalizeSummary(input.summary, false)
        this.database.withSql((sql) => {
          sql.run(`
            INSERT INTO timeline_document_revisions (
              id, document_id, project_id, episode_id, parent_revision_id,
              schema_version, upstream_commit, source_revision_id, summary,
              snapshot_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          revisionId,
          current.timelineDocument.id,
          projectId,
          episodeId,
          current.revision.id,
          schemaVersion,
          upstreamCommit,
          sourceRevisionId,
          summary,
          snapshotJson,
          now)
          sql.run(`
            UPDATE timeline_documents SET
              current_revision_id = ?, schema_version = ?, upstream_commit = ?,
              source_revision_id = ?, updated_at = ?
            WHERE id = ?
          `,
          revisionId,
          schemaVersion,
          upstreamCommit,
          sourceRevisionId,
          now,
          current.timelineDocument.id)
          if (trustedFingerprint && sourceRevisionId) {
            sql.run(`
              INSERT INTO timeline_media_authority_receipts (
                timeline_revision_id, document_id, project_id, episode_id,
                source_revision_id, fingerprint, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            revisionId,
            current.timelineDocument.id,
            projectId,
            episodeId,
            sourceRevisionId,
            trustedFingerprint,
            now)
          }
        })
        return { ...this.requireSnapshot(episodeId), created: false }
      }

      if (input.expectedRevisionId !== null) {
        throw new TimelineDocumentError(
          'TIMELINE_DOCUMENT_CONFLICT',
          '时间线不存在，不能使用旧修订创建',
          null,
        )
      }
      const documentId = this.idFactory()
      const revisionId = this.idFactory()
      const now = this.now()
      const summary = normalizeSummary(input.summary, true)
      this.database.withSql((sql) => {
        sql.run(`
          INSERT INTO timeline_documents (
            id, project_id, episode_id, current_revision_id, schema_version,
            upstream_commit, source_revision_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        documentId,
        projectId,
        episodeId,
        revisionId,
        schemaVersion,
        upstreamCommit,
        sourceRevisionId,
        now,
        now)
        sql.run(`
          INSERT INTO timeline_document_revisions (
            id, document_id, project_id, episode_id, parent_revision_id,
            schema_version, upstream_commit, source_revision_id, summary,
            snapshot_json, created_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
        `,
        revisionId,
        documentId,
        projectId,
        episodeId,
        schemaVersion,
        upstreamCommit,
        sourceRevisionId,
        summary,
        snapshotJson,
        now)
        if (trustedFingerprint && sourceRevisionId) {
          sql.run(`
            INSERT INTO timeline_media_authority_receipts (
              timeline_revision_id, document_id, project_id, episode_id,
              source_revision_id, fingerprint, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          revisionId,
          documentId,
          projectId,
          episodeId,
          sourceRevisionId,
          trustedFingerprint,
          now)
        }
      })
      return { ...this.requireSnapshot(episodeId), created: true }
    })
  }

  listRevisions(
    documentId: string,
    options: { limit?: number; offset?: number } = {},
  ): TimelineDocumentHistory {
    const timelineDocument = this.database.withSql((sql) => {
      const row = sql.get('SELECT * FROM timeline_documents WHERE id = ?', documentId)
      return row ? asTimelineDocument(row) : undefined
    })
    if (!timelineDocument) {
      throw new TimelineDocumentError(
        'TIMELINE_DOCUMENT_NOT_FOUND',
        `Timeline document not found: ${documentId}`,
      )
    }
    const limit = normalizePage(options.limit, 20, 'limit')
    const offset = normalizePage(options.offset, 0, 'offset')
    const revisions = this.database.withSql((sql) => sql.all(`
      SELECT * FROM timeline_document_revisions WHERE document_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `, documentId, limit, offset).map(asTimelineDocumentRevision))
    return { timelineDocument, revisions }
  }

  private requireEpisodeOwner(episodeId: string): EpisodeOwner {
    const row = this.database.withSql((sql) => sql.get(`
      SELECT project_id, source_revision_id FROM episodes WHERE id = ?
    `, episodeId))
    if (!row) throw new TimelineDocumentError('EPISODE_NOT_FOUND', `Episode not found: ${episodeId}`)
    return {
      projectId: requiredString(row, 'project_id'),
      sourceRevisionId: nullableString(row, 'source_revision_id'),
    }
  }

  private assertSourceRevision(projectId: string, revisionId: string | null): void {
    if (revisionId === null) return
    const row = this.database.withSql((sql) => sql.get(
      'SELECT project_id FROM revisions WHERE id = ?',
      revisionId,
    ))
    if (!row) {
      throw new TimelineDocumentError(
        'SOURCE_REVISION_NOT_FOUND',
        `Source revision not found: ${revisionId}`,
      )
    }
    if (requiredString(row, 'project_id') !== projectId) {
      throw new TimelineDocumentError(
        'SOURCE_REVISION_PROJECT_MISMATCH',
        `Source revision ${revisionId} does not belong to project ${projectId}`,
      )
    }
  }

  private requireRevision(revisionId: string): TimelineDocumentRevisionRecord {
    const row = this.database.withSql((sql) => sql.get(
      'SELECT * FROM timeline_document_revisions WHERE id = ?',
      revisionId,
    ))
    if (!row) {
      throw new TimelineDocumentError(
        'CORRUPT_TIMELINE_DOCUMENT',
        `Timeline revision not found: ${revisionId}`,
      )
    }
    return asTimelineDocumentRevision(row)
  }

  private requireSnapshot(episodeId: string): TimelineDocumentSnapshot {
    const snapshot = this.getForEpisode(episodeId)
    if (!snapshot) {
      throw new TimelineDocumentError(
        'CORRUPT_TIMELINE_DOCUMENT',
        `Timeline document disappeared for episode ${episodeId}`,
      )
    }
    return snapshot
  }
}

/** Domain-facing wrapper kept separate from SQLite so ManjuStorageAdapter is not database-aware. */
export class TimelineDocumentService {
  constructor(private readonly repository: TimelineDocumentRepository) {}

  get(episodeId: string): TimelineDocumentSnapshot {
    const snapshot = this.repository.getForEpisode(episodeId)
    if (!snapshot) {
      throw new TimelineDocumentError(
        'TIMELINE_DOCUMENT_NOT_FOUND',
        `Timeline document not found for episode ${episodeId}`,
      )
    }
    return snapshot
  }

  getRevision(revisionId: string): TimelineDocumentSnapshot {
    const snapshot = this.repository.getRevision(revisionId)
    if (!snapshot) {
      throw new TimelineDocumentError(
        'TIMELINE_DOCUMENT_NOT_FOUND',
        `Timeline revision not found: ${revisionId}`,
      )
    }
    return snapshot
  }

  save(input: SaveTimelineDocumentInput): SaveTimelineDocumentResult {
    // Whitelist every field instead of forwarding the object. This prevents a
    // JavaScript caller or cast value from smuggling sourceRevisionId through
    // the ordinary save path despite the static type boundary.
    return this.repository.save({
      projectId: input.projectId,
      episodeId: input.episodeId,
      expectedRevisionId: input.expectedRevisionId,
      schemaVersion: input.schemaVersion,
      upstreamCommit: input.upstreamCommit,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      document: input.document,
    })
  }

  saveReconciled(
    input: SaveReconciledTimelineDocumentInput,
  ): SaveTimelineDocumentResult {
    return this.repository.save(input)
  }

  listRevisions(
    documentId: string,
    options?: { limit?: number; offset?: number },
  ): TimelineDocumentHistory {
    return this.repository.listRevisions(documentId, options)
  }
}
