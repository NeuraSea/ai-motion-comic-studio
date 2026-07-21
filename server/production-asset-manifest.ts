import { createHash, randomUUID } from 'node:crypto'

import type { Express, NextFunction, Request, Response } from 'express'

import { parseCanonicalTimelineDocument } from '../apps/opencut-editor/src/canonical-timeline-codec.js'
import type { ManjuDatabase } from './database.js'
import { episodeEtag, episodeVersionMatches, versionTokenFromEtag } from './episode-version.js'
import {
  TimelineDocumentError,
  type TimelineDocumentSnapshot,
} from './timeline-documents.js'
import type { JsonObject, JsonValue } from './types.js'

export type ProductionAssetManifestErrorCode =
  | 'EPISODE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_REQUEST'
  | 'MANIFEST_BLOCKED'
  | 'MANIFEST_NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'PRECONDITION_REQUIRED'

export class ProductionAssetManifestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProductionAssetManifestErrorCode,
    message: string,
    readonly details?: JsonObject,
  ) {
    super(message)
    this.name = 'ProductionAssetManifestError'
  }
}

export interface ProductionAssetManifestContext extends JsonObject {
  schemaVersion: 1
  projectId: string
  episodeId: string
  sourceRevisionId: string | null
  projectRevisionId: string | null
  timelineRevisionId: string | null
  narratorVoiceProfileRevisionId: string | null
  characterVoiceProfileRevisions: JsonObject
}

export interface ProductionAssetManifestEntry {
  slotKey: string
  role: string
  assetId: string
  assetVersionId: string
  versionNumber: number
  checksum: string
  kind: string
  mimeType: string | null
  sourceRevisionId: string | null
  providerId: string | null
  providerModel: string | null
  providerConfigRevision: number | null
  metadata: JsonObject
}

export interface ProductionAssetManifestBlocker {
  code: string
  slotKey: string | null
  assetVersionId: string | null
  message: string
}

export interface ProductionAssetManifestRecord {
  id: string
  projectId: string
  episodeId: string
  revisionNumber: number
  parentManifestId: string | null
  sourceRevisionId: string
  projectRevisionId: string | null
  timelineRevisionId: string | null
  fingerprint: string
  entryCount: number
  context: ProductionAssetManifestContext
  summary: string
  idempotencyKey: string
  entries: ProductionAssetManifestEntry[]
  createdAt: string
}

export interface ProductionAssetManifestProjection {
  status: 'missing' | 'current' | 'changed' | 'blocked'
  fingerprint: string
  context: ProductionAssetManifestContext
  entries: ProductionAssetManifestEntry[]
  blockers: ProductionAssetManifestBlocker[]
  latestManifest: ProductionAssetManifestRecord | null
}

interface ProductionAssetManifestDependencies {
  database: ManjuDatabase
  timelines: TimelineReader
  now?: () => string
  idFactory?: () => string
}

interface TimelineReader {
  get(episodeId: string): TimelineDocumentSnapshot | undefined
}

interface AssetCandidate {
  slotKey: string
  role: string
  assetVersionId: string
  metadata: JsonObject
}

type SqlRow = Record<string, unknown>

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'string') throw new Error(`${label} is not JSON text`)
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`)
  }
  return parsed as JsonObject
}

function identifier(value: unknown, label: string): string {
  const normalized = text(value)
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ProductionAssetManifestError(400, 'INVALID_REQUEST', `${label} 格式无效`)
  }
  return normalized
}

function validChecksum(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function canonicalFingerprint(
  context: ProductionAssetManifestContext,
  entries: ProductionAssetManifestEntry[],
): string {
  return createHash('sha256').update(JSON.stringify({ context, entries })).digest('hex')
}

function currentTimeline(timelines: TimelineReader, episodeId: string): TimelineDocumentSnapshot | undefined {
  try {
    return timelines.get(episodeId)
  } catch (error) {
    if (error instanceof TimelineDocumentError && error.code === 'TIMELINE_DOCUMENT_NOT_FOUND') {
      return undefined
    }
    throw error
  }
}

function contextFromDatabase(
  database: ManjuDatabase,
  timelines: TimelineReader,
  projectId: string,
  episodeId: string,
): { context: ProductionAssetManifestContext; blockers: ProductionAssetManifestBlocker[] } {
  const project = database.getProject(projectId)
  const episode = database.withSql((sql) => sql.get(`
    SELECT project_id, source_revision_id FROM episodes WHERE id = ?
  `, episodeId))
  if (!project || !episode || episode.project_id !== projectId) {
    throw new ProductionAssetManifestError(404, 'EPISODE_NOT_FOUND', '项目或剧集不存在')
  }

  const blockers: ProductionAssetManifestBlocker[] = []
  const sourceRevisionId = text(episode.source_revision_id)
  if (!sourceRevisionId) {
    blockers.push({
      code: 'SOURCE_REVISION_MISSING',
      slotKey: null,
      assetVersionId: null,
      message: '剧集尚未固化原著/剧本修订',
    })
  }

  const timeline = currentTimeline(timelines, episodeId)
  if (timeline && timeline.timelineDocument.projectId !== projectId) {
    throw new Error(`Timeline scope is corrupt: ${timeline.timelineDocument.id}`)
  }
  if (timeline && timeline.timelineDocument.sourceRevisionId !== sourceRevisionId) {
    blockers.push({
      code: 'STALE_TIMELINE_SOURCE',
      slotKey: null,
      assetVersionId: null,
      message: '当前 OpenCut 时间线并非由本剧集最新源修订固化，请先重新固化时间线',
    })
  }

  const characterRows = database.withSql((sql) => sql.all(`
    SELECT DISTINCT characters.id, characters.metadata_json
      FROM dialogue_lines
      JOIN shots ON shots.id = dialogue_lines.shot_id
      JOIN scenes ON scenes.id = shots.scene_id
      JOIN characters ON characters.id = dialogue_lines.character_id
     WHERE scenes.episode_id = ?
     ORDER BY characters.id
  `, episodeId))
  const characterVoiceProfileRevisions: JsonObject = {}
  for (const row of characterRows) {
    const characterId = text(row.id)
    if (!characterId) throw new Error('Character identity is corrupt')
    const metadata = jsonObject(row.metadata_json, 'characters.metadata_json')
    const revisionId = text(metadata.voiceProfileRevisionId)
    if (revisionId) characterVoiceProfileRevisions[characterId] = revisionId
  }

  return {
    context: {
      schemaVersion: 1,
      projectId,
      episodeId,
      sourceRevisionId,
      projectRevisionId: project.currentRevisionId,
      timelineRevisionId: timeline?.revision.id ?? null,
      narratorVoiceProfileRevisionId: text(project.settings.narratorVoiceProfileRevisionId),
      characterVoiceProfileRevisions,
    },
    blockers,
  }
}

function relationalCandidates(
  database: ManjuDatabase,
  projectId: string,
  episodeId: string,
): AssetCandidate[] {
  const rows = database.withSql((sql) => sql.all(`
    SELECT slot_key, role, asset_version_id, owner_id, owner_name
      FROM (
        SELECT 'character:' || id || ':primary' AS slot_key,
               'character.primary' AS role, locked_asset_id AS asset_version_id,
               id AS owner_id, name AS owner_name
          FROM characters
         WHERE project_id = ? AND episode_id = ? AND locked_asset_id IS NOT NULL
        UNION ALL
        SELECT 'character:' || refs.character_id || ':' || refs.role,
               'character.' || refs.role, refs.asset_id, refs.character_id, characters.name
          FROM character_visual_references AS refs
          JOIN characters ON characters.id = refs.character_id
         WHERE refs.project_id = ? AND refs.episode_id = ? AND refs.asset_id IS NOT NULL
        UNION ALL
        SELECT 'location:' || id || ':primary', 'location.primary', locked_asset_id, id, name
          FROM locations
         WHERE project_id = ? AND episode_id = ? AND locked_asset_id IS NOT NULL
        UNION ALL
        SELECT 'prop:' || id || ':primary', 'prop.primary', locked_asset_id, id, name
          FROM props
         WHERE project_id = ? AND episode_id = ? AND locked_asset_id IS NOT NULL
        UNION ALL
        SELECT 'shot:' || shots.id || ':storyboard', 'shot.storyboard', shots.storyboard_asset_id,
               shots.id, COALESCE(NULLIF(shots.title, ''), shots.code)
          FROM shots JOIN scenes ON scenes.id = shots.scene_id
         WHERE scenes.episode_id = ? AND shots.storyboard_asset_id IS NOT NULL
        UNION ALL
        SELECT 'shot:' || shots.id || ':video', 'shot.video', shots.video_asset_id,
               shots.id, COALESCE(NULLIF(shots.title, ''), shots.code)
          FROM shots JOIN scenes ON scenes.id = shots.scene_id
         WHERE scenes.episode_id = ? AND shots.video_asset_id IS NOT NULL
        UNION ALL
        SELECT 'dialogue:' || dialogue_lines.id || ':speech', 'dialogue.speech',
               dialogue_lines.speech_asset_id, dialogue_lines.id, dialogue_lines.text
          FROM dialogue_lines
          JOIN shots ON shots.id = dialogue_lines.shot_id
          JOIN scenes ON scenes.id = shots.scene_id
         WHERE scenes.episode_id = ? AND dialogue_lines.speech_asset_id IS NOT NULL
      )
     ORDER BY slot_key
  `,
  projectId, episodeId,
  projectId, episodeId,
  projectId, episodeId,
  projectId, episodeId,
  episodeId,
  episodeId,
  episodeId))

  return rows.map((row) => {
    const slotKey = text(row.slot_key)
    const role = text(row.role)
    const assetVersionId = text(row.asset_version_id)
    const ownerId = text(row.owner_id)
    if (!slotKey || !role || !assetVersionId || !ownerId) {
      throw new Error('Production Asset candidate is corrupt')
    }
    return {
      slotKey,
      role,
      assetVersionId,
      metadata: {
        ownerId,
        ...(text(row.owner_name) ? { ownerName: text(row.owner_name) as string } : {}),
      },
    }
  })
}

function timelineCandidates(
  timelines: TimelineReader,
  episodeId: string,
): AssetCandidate[] {
  const snapshot = currentTimeline(timelines, episodeId)
  if (!snapshot) return []
  const document = parseCanonicalTimelineDocument(snapshot.document)
  const candidates: AssetCandidate[] = []
  const add = (bucket: string, trackId: string, element: {
    id: string
    type: string
    mediaId?: string
    sourceType?: string
  }) => {
    // The canonical codec uses a namespaced sentinel while a managed slot has
    // not produced an Asset yet. It is workflow state, never an Asset ID.
    if (!element.mediaId
      || element.mediaId.startsWith('manju:pending:')
      || (element.type === 'audio' && element.sourceType !== 'upload')) return
    candidates.push({
      slotKey: `timeline:${bucket}:${trackId}:${element.id}`,
      role: `timeline.${element.type}`,
      assetVersionId: element.mediaId,
      metadata: { bucket, trackId, elementId: element.id },
    })
  }
  for (const track of document.tracks.overlay) {
    for (const element of track.elements) add('overlay', track.id, element)
  }
  for (const element of document.tracks.main.elements) add('main', document.tracks.main.id, element)
  for (const track of document.tracks.audio) {
    for (const element of track.elements) add('audio', track.id, element)
  }
  return candidates
}

function resolveCandidate(
  database: ManjuDatabase,
  projectId: string,
  episodeId: string,
  candidate: AssetCandidate,
): { entry?: ProductionAssetManifestEntry; blocker?: ProductionAssetManifestBlocker } {
  const row = database.withSql((sql) => sql.get(`
    SELECT media_assets.id AS asset_version_id,
           media_assets.project_id, media_assets.episode_id, media_assets.kind,
           media_assets.status, media_assets.mime_type,
           media_assets.checksum AS media_checksum,
           media_assets.source_revision_id,
           asset_handle_versions.asset_id,
           asset_handle_versions.version_number,
           asset_handle_versions.checksum AS identity_checksum,
           COALESCE(media_assets.provider_id, generation_jobs.provider_id) AS provider_id,
           generation_jobs.model AS provider_model,
           generation_jobs.provider_config_revision
      FROM media_assets
      LEFT JOIN asset_handle_versions
        ON asset_handle_versions.asset_version_id = media_assets.id
       AND asset_handle_versions.project_id = media_assets.project_id
      LEFT JOIN generation_jobs ON generation_jobs.id = media_assets.generation_job_id
     WHERE media_assets.id = ?
  `, candidate.assetVersionId))
  const blocked = (code: string, message: string): { blocker: ProductionAssetManifestBlocker } => ({
    blocker: {
      code,
      slotKey: candidate.slotKey,
      assetVersionId: candidate.assetVersionId,
      message,
    },
  })
  if (!row) return blocked('ASSET_NOT_FOUND', '引用的素材版本不存在')
  if (row.project_id !== projectId
    || (row.episode_id !== null && row.episode_id !== episodeId)) {
    return blocked('ASSET_SCOPE_MISMATCH', '引用的素材不属于当前项目或剧集')
  }
  if (row.status !== 'ready') return blocked('ASSET_NOT_READY', '引用的素材尚未就绪')
  if (!validChecksum(row.media_checksum) || !validChecksum(row.identity_checksum)
    || row.media_checksum !== row.identity_checksum) {
    return blocked('ASSET_CHECKSUM_UNSEALED', '引用的素材版本尚未通过 checksum 固化')
  }
  const assetId = text(row.asset_id)
  const versionNumber = integer(row.version_number)
  const kind = text(row.kind)
  if (!assetId || !versionNumber || !kind) {
    return blocked('ASSET_IDENTITY_MISSING', '引用的素材版本尚未加入稳定素材族')
  }
  const providerConfigRevision = row.provider_config_revision === null
    ? null
    : integer(row.provider_config_revision)
  if (row.provider_config_revision !== null && providerConfigRevision === null) {
    throw new Error(`Provider revision is corrupt for Asset ${candidate.assetVersionId}`)
  }
  return {
    entry: {
      slotKey: candidate.slotKey,
      role: candidate.role,
      assetId,
      assetVersionId: candidate.assetVersionId,
      versionNumber,
      checksum: row.media_checksum,
      kind,
      mimeType: text(row.mime_type),
      sourceRevisionId: text(row.source_revision_id),
      providerId: text(row.provider_id),
      providerModel: text(row.provider_model),
      providerConfigRevision,
      metadata: candidate.metadata,
    },
  }
}

function entryFromRow(row: SqlRow): ProductionAssetManifestEntry {
  const versionNumber = integer(row.version_number)
  const checksum = text(row.checksum)
  if (!versionNumber || !checksum) throw new Error('Production Asset Manifest entry is corrupt')
  return {
    slotKey: text(row.slot_key) as string,
    role: text(row.role) as string,
    assetId: text(row.asset_id) as string,
    assetVersionId: text(row.asset_version_id) as string,
    versionNumber,
    checksum,
    kind: text(row.kind) as string,
    mimeType: text(row.mime_type),
    sourceRevisionId: text(row.source_revision_id),
    providerId: text(row.provider_id),
    providerModel: text(row.provider_model),
    providerConfigRevision: row.provider_config_revision === null
      ? null
      : integer(row.provider_config_revision),
    metadata: jsonObject(row.metadata_json, 'production_asset_manifest_entries.metadata_json'),
  }
}

function manifestFromRow(database: ManjuDatabase, row: SqlRow): ProductionAssetManifestRecord {
  const id = text(row.id)
  const revisionNumber = integer(row.revision_number)
  const entryCount = integer(row.entry_count)
  if (!id || !revisionNumber || !entryCount) throw new Error('Production Asset Manifest is corrupt')
  const entries = database.withSql((sql) => sql.all(`
    SELECT * FROM production_asset_manifest_entries
     WHERE manifest_id = ? ORDER BY position
  `, id)).map(entryFromRow)
  if (entries.length !== entryCount) throw new Error(`Production Asset Manifest ${id} entry count drifted`)
  return {
    id,
    projectId: text(row.project_id) as string,
    episodeId: text(row.episode_id) as string,
    revisionNumber,
    parentManifestId: text(row.parent_manifest_id),
    sourceRevisionId: text(row.source_revision_id) as string,
    projectRevisionId: text(row.project_revision_id),
    timelineRevisionId: text(row.timeline_revision_id),
    fingerprint: text(row.fingerprint) as string,
    entryCount,
    context: jsonObject(row.context_json, 'production_asset_manifests.context_json') as ProductionAssetManifestContext,
    summary: text(row.summary) as string,
    idempotencyKey: text(row.idempotency_key) as string,
    entries,
    createdAt: text(row.created_at) as string,
  }
}

export class ProductionAssetManifestService {
  private readonly now: () => string
  private readonly idFactory: () => string

  constructor(private readonly dependencies: ProductionAssetManifestDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString())
    this.idFactory = dependencies.idFactory ?? randomUUID
  }

  latest(projectId: string, episodeId: string): ProductionAssetManifestRecord | null {
    const row = this.dependencies.database.withSql((sql) => sql.get(`
      SELECT * FROM production_asset_manifests
       WHERE project_id = ? AND episode_id = ?
       ORDER BY revision_number DESC LIMIT 1
    `, projectId, episodeId))
    return row ? manifestFromRow(this.dependencies.database, row) : null
  }

  history(projectId: string, episodeId: string, limit = 50): ProductionAssetManifestRecord[] {
    const safeLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50
    return this.dependencies.database.withSql((sql) => sql.all(`
      SELECT * FROM production_asset_manifests
       WHERE project_id = ? AND episode_id = ?
       ORDER BY revision_number DESC LIMIT ?
    `, projectId, episodeId, safeLimit)).map((row) => manifestFromRow(this.dependencies.database, row))
  }

  projection(projectId: string, episodeId: string): ProductionAssetManifestProjection {
    const scoped = contextFromDatabase(
      this.dependencies.database,
      this.dependencies.timelines,
      projectId,
      episodeId,
    )
    const candidates = [
      ...relationalCandidates(this.dependencies.database, projectId, episodeId),
      ...timelineCandidates(this.dependencies.timelines, episodeId),
    ].sort((left, right) => left.slotKey.localeCompare(right.slotKey))
    const duplicate = candidates.find((candidate, index) => (
      index > 0 && candidates[index - 1]?.slotKey === candidate.slotKey
    ))
    if (duplicate) throw new Error(`Duplicate Production Asset slot: ${duplicate.slotKey}`)

    const entries: ProductionAssetManifestEntry[] = []
    const blockers = [...scoped.blockers]
    for (const candidate of candidates) {
      const resolved = resolveCandidate(
        this.dependencies.database,
        projectId,
        episodeId,
        candidate,
      )
      if (resolved.entry) entries.push(resolved.entry)
      if (resolved.blocker) blockers.push(resolved.blocker)
    }
    if (candidates.length === 0) {
      blockers.push({
        code: 'NO_ASSET_REFERENCES',
        slotKey: null,
        assetVersionId: null,
        message: '当前剧集没有可固化的制作素材引用',
      })
    }
    const fingerprint = canonicalFingerprint(scoped.context, entries)
    const latestManifest = this.latest(projectId, episodeId)
    return {
      status: blockers.length > 0
        ? 'blocked'
        : !latestManifest
          ? 'missing'
          : latestManifest.fingerprint === fingerprint
            ? 'current'
            : 'changed',
      fingerprint,
      context: scoped.context,
      entries,
      blockers,
      latestManifest,
    }
  }

  materialize(input: {
    projectId: string
    episodeId: string
    ifMatch: string
    idempotencyKey: string
    summary?: string
  }): { manifest: ProductionAssetManifestRecord; idempotent: boolean } {
    return this.dependencies.database.transaction(() => {
      const episode = this.dependencies.database.withSql((sql) => sql.get(`
        SELECT source_revision_id, updated_at FROM episodes
         WHERE id = ? AND project_id = ?
      `, input.episodeId, input.projectId))
      if (!episode) throw new ProductionAssetManifestError(404, 'EPISODE_NOT_FOUND', '项目或剧集不存在')
      const sourceRevisionId = text(episode.source_revision_id)
      const updatedAt = text(episode.updated_at)
      const expectedVersion = versionTokenFromEtag(input.ifMatch)
      if (!updatedAt || !expectedVersion
        || !episodeVersionMatches({ sourceRevisionId, updatedAt }, expectedVersion)) {
        throw new ProductionAssetManifestError(
          412,
          'PRECONDITION_FAILED',
          '剧集已变化，请刷新制作资产清单后重试',
        )
      }

      const projection = this.projection(input.projectId, input.episodeId)
      const replayRow = this.dependencies.database.withSql((sql) => sql.get(`
        SELECT * FROM production_asset_manifests
         WHERE project_id = ? AND episode_id = ? AND idempotency_key = ?
      `, input.projectId, input.episodeId, input.idempotencyKey))
      if (replayRow) {
        const replay = manifestFromRow(this.dependencies.database, replayRow)
        if (replay.fingerprint !== projection.fingerprint) {
          throw new ProductionAssetManifestError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key 已用于不同的制作素材清单',
          )
        }
        return { manifest: replay, idempotent: true }
      }
      if (projection.blockers.length > 0 || !projection.context.sourceRevisionId) {
        throw new ProductionAssetManifestError(
          409,
          'MANIFEST_BLOCKED',
          '制作素材清单存在未解决的引用，尚不能固化',
          { blockers: projection.blockers as unknown as JsonValue[] },
        )
      }

      const parent = projection.latestManifest
      const manifestId = this.idFactory()
      const createdAt = this.now()
      const summary = (input.summary?.trim() || '固化本集制作素材引用').slice(0, 500)
      this.dependencies.database.withSql((sql) => {
        sql.run(`
          INSERT INTO production_asset_manifests (
            id, project_id, episode_id, revision_number, parent_manifest_id,
            source_revision_id, project_revision_id, timeline_revision_id,
            fingerprint, entry_count, context_json, summary, idempotency_key, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        manifestId,
        input.projectId,
        input.episodeId,
        (parent?.revisionNumber ?? 0) + 1,
        parent?.id ?? null,
        projection.context.sourceRevisionId,
        projection.context.projectRevisionId,
        projection.context.timelineRevisionId,
        projection.fingerprint,
        projection.entries.length,
        JSON.stringify(projection.context),
        summary,
        input.idempotencyKey,
        createdAt)
        projection.entries.forEach((entry, position) => sql.run(`
          INSERT INTO production_asset_manifest_entries (
            manifest_id, position, slot_key, role, asset_id, asset_version_id,
            version_number, checksum, kind, mime_type, source_revision_id,
            provider_id, provider_model, provider_config_revision, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        manifestId,
        position,
        entry.slotKey,
        entry.role,
        entry.assetId,
        entry.assetVersionId,
        entry.versionNumber,
        entry.checksum,
        entry.kind,
        entry.mimeType,
        entry.sourceRevisionId,
        entry.providerId,
        entry.providerModel,
        entry.providerConfigRevision,
        JSON.stringify(entry.metadata)))
      })
      const row = this.dependencies.database.withSql((sql) => sql.get(`
        SELECT * FROM production_asset_manifests WHERE id = ?
      `, manifestId))
      if (!row) throw new Error(`Production Asset Manifest was not found after write: ${manifestId}`)
      return { manifest: manifestFromRow(this.dependencies.database, row), idempotent: false }
    })
  }
}

function requestIfMatch(request: Request): string {
  const value = request.get('if-match')?.trim()
  if (!value) {
    throw new ProductionAssetManifestError(428, 'PRECONDITION_REQUIRED', '必须提供 If-Match 剧集版本')
  }
  if (value.length > 500 || value.includes(',')) {
    throw new ProductionAssetManifestError(400, 'INVALID_REQUEST', 'If-Match 格式无效')
  }
  return value
}

function requestIdempotencyKey(request: Request): string {
  const value = request.get('idempotency-key')?.trim()
  if (!value) {
    throw new ProductionAssetManifestError(400, 'IDEMPOTENCY_KEY_REQUIRED', '必须提供 Idempotency-Key')
  }
  if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProductionAssetManifestError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 格式无效')
  }
  return value
}

function requestBody(request: Request): { summary?: string } {
  const value: unknown = request.body ?? {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductionAssetManifestError(400, 'INVALID_REQUEST', '请求体必须是 JSON 对象')
  }
  const body = value as Record<string, unknown>
  const unknown = Object.keys(body).filter((key) => key !== 'summary')
  if (unknown.length > 0 || (body.summary !== undefined && typeof body.summary !== 'string')) {
    throw new ProductionAssetManifestError(400, 'INVALID_REQUEST', '制作素材清单请求参数无效')
  }
  return typeof body.summary === 'string' ? { summary: body.summary } : {}
}

export function mountProductionAssetManifestRoutes(
  app: Express,
  dependencies: ProductionAssetManifestDependencies,
): ProductionAssetManifestService {
  const service = new ProductionAssetManifestService(dependencies)
  const route = '/api/v1/projects/:projectId/episodes/:episodeId/production-asset-manifest'
  app.get(route, (request: Request, response: Response, next: NextFunction) => {
    try {
      const projectId = identifier(request.params.projectId, 'projectId')
      const episodeId = identifier(request.params.episodeId, 'episodeId')
      const episode = dependencies.database.withSql((sql) => sql.get(`
        SELECT source_revision_id, updated_at FROM episodes
         WHERE id = ? AND project_id = ?
      `, episodeId, projectId))
      if (!episode) throw new ProductionAssetManifestError(404, 'EPISODE_NOT_FOUND', '项目或剧集不存在')
      const version = episodeEtag({
        sourceRevisionId: text(episode.source_revision_id),
        updatedAt: text(episode.updated_at) as string,
      })
      const projection = service.projection(projectId, episodeId)
      // HTTP cache identity follows the live projection. The optimistic Episode
      // write token is deliberately separate so a stable Episode cannot make a
      // changed timeline/Asset projection return a stale 304.
      const responseFingerprint = createHash('sha256')
        .update(JSON.stringify(projection))
        .digest('hex')
      response.setHeader('ETag', `"production-asset-manifest-v1-${responseFingerprint}"`)
      response.setHeader('X-Episode-Version', version)
      response.json({ projection })
    } catch (error) {
      next(error)
    }
  })
  app.get(`${route}/revisions`, (request: Request, response: Response, next: NextFunction) => {
    try {
      const projectId = identifier(request.params.projectId, 'projectId')
      const episodeId = identifier(request.params.episodeId, 'episodeId')
      // projection performs the authoritative scope check.
      service.projection(projectId, episodeId)
      const rawLimit = typeof request.query.limit === 'string' ? Number(request.query.limit) : 50
      response.json({ manifests: service.history(projectId, episodeId, rawLimit) })
    } catch (error) {
      next(error)
    }
  })
  app.post(`${route}/materialize`, (request: Request, response: Response, next: NextFunction) => {
    try {
      const body = requestBody(request)
      const result = service.materialize({
        projectId: identifier(request.params.projectId, 'projectId'),
        episodeId: identifier(request.params.episodeId, 'episodeId'),
        ifMatch: requestIfMatch(request),
        idempotencyKey: requestIdempotencyKey(request),
        ...body,
      })
      response.status(result.idempotent ? 200 : 201).json({
        manifest: result.manifest,
        idempotent: result.idempotent,
        providerCallRequired: false,
      })
    } catch (error) {
      next(error)
    }
  })
  return service
}
