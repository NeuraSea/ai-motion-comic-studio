import { isDeepStrictEqual } from 'node:util'

import type { ManjuDatabase, RevisionRecord } from './database.js'
import {
  parseLinePerformanceRecommendation,
  type LinePerformanceRecommendation,
} from './line-performance.js'
import type { JsonObject } from './types.js'

type SqlRow = Record<string, unknown>

const PROFILE_KEY = 'linePerformanceProfile'
const REVISION_KEY = 'linePerformanceRevisionId'

export interface LinePerformanceProfileRecord extends LinePerformanceRecommendation {
  projectId: string
  episodeId: string
  databaseLineId: string
  revisionId: string
  recommendationJobId: string
  sourceRevisionId: string
  /** Immutable voice profile revision used when the direction was adopted. */
  voiceProfileRevisionId: string | null
  updatedAt: string
}

export interface LinePerformanceProfileState {
  profile: LinePerformanceProfileRecord | undefined
  /** The current immutable audit head, including a clear tombstone. */
  revisionId: string | null
  etag: string
}

export interface SaveLinePerformanceProfileInput {
  projectId: string
  episodeId: string
  lineId: string
  databaseLineId: string
  expectedSourceRevisionId: string
  expectedEtag: string
  voiceProfileRevisionId: string
  recommendationJobId: string
  recommendation: LinePerformanceRecommendation
}

export interface ClearLinePerformanceProfileInput {
  projectId: string
  episodeId: string
  lineId: string
  expectedEtag: string
}

export interface LinePerformanceStaleResult {
  speechAssets: number
  narrationLines: number
  exports: number
  exportAssets: number
  qualityReports: number
  pipelineRuns: number
  activeJobIds: string[]
}

export class LinePerformanceProfileError extends Error {
  constructor(
    readonly code:
      | 'DIALOGUE_LINE_NOT_FOUND'
      | 'AMBIGUOUS_DIALOGUE_LINE_ID'
      | 'LINE_PERFORMANCE_PROFILE_CORRUPT'
      | 'PRECONDITION_FAILED'
      | 'STALE_SOURCE',
    message: string,
  ) {
    super(message)
    this.name = 'LinePerformanceProfileError'
  }
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Database column ${key} is not text`)
  return value
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('Database metadata is not JSON text')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Database metadata is not an object')
  }
  return parsed as Record<string, unknown>
}

function publicLineId(row: SqlRow): string {
  const metadata = parseObject(row.metadata_json)
  return typeof metadata.storyId === 'string' && metadata.storyId.trim()
    ? metadata.storyId.trim()
    : requiredString(row, 'database_line_id')
}

function targetRows(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string; lineId: string },
): SqlRow[] {
  return database.withSql((sql) => sql.all(`
    SELECT dialogue_lines.id AS database_line_id,
           dialogue_lines.text,
           dialogue_lines.metadata_json,
           dialogue_lines.speech_asset_id,
           dialogue_lines.updated_at,
           episodes.source_revision_id,
           episodes.project_id,
           episodes.id AS episode_id
      FROM dialogue_lines
      JOIN shots ON shots.id = dialogue_lines.shot_id
      JOIN scenes ON scenes.id = shots.scene_id
      JOIN episodes ON episodes.id = scenes.episode_id
     WHERE episodes.project_id = ?
       AND episodes.id = ?
       AND CASE
         WHEN typeof(json_extract(dialogue_lines.metadata_json, '$.storyId')) = 'text'
           AND length(trim(json_extract(dialogue_lines.metadata_json, '$.storyId'))) > 0
         THEN json_extract(dialogue_lines.metadata_json, '$.storyId')
         ELSE dialogue_lines.id
       END = ?
     ORDER BY dialogue_lines.id
     LIMIT 2
  `, input.projectId, input.episodeId, input.lineId))
}

function requireTarget(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string; lineId: string },
): SqlRow {
  const rows = targetRows(database, input)
  if (rows.length === 0) {
    throw new LinePerformanceProfileError('DIALOGUE_LINE_NOT_FOUND', '台词不存在或不属于指定分集')
  }
  if (rows.length > 1) {
    throw new LinePerformanceProfileError('AMBIGUOUS_DIALOGUE_LINE_ID', '台词标识在分集中不唯一')
  }
  return rows[0]
}

interface StoredProfile {
  version: 1 | 2
  recommendationJobId: string
  sourceRevisionId: string
  /** Missing only on legacy v1 profiles, which may be read but never applied. */
  voiceProfileRevisionId: string | null
  updatedAt: string
  recommendation: LinePerformanceRecommendation
}

function parseStoredProfile(value: unknown, lineId: string, text: string): StoredProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('profile is not an object')
  }
  const source = value as Record<string, unknown>
  const keys = Object.keys(source).sort()
  const expected = source.version === 2
    ? ['recommendation', 'recommendationJobId', 'sourceRevisionId', 'updatedAt', 'version', 'voiceProfileRevisionId']
    : ['recommendation', 'recommendationJobId', 'sourceRevisionId', 'updatedAt', 'version']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected.sort()[index])) {
    throw new Error('profile fields are invalid')
  }
  if ((source.version !== 1 && source.version !== 2)
    || typeof source.recommendationJobId !== 'string'
    || !source.recommendationJobId
    || typeof source.sourceRevisionId !== 'string'
    || !source.sourceRevisionId
    || (source.version === 2 && (typeof source.voiceProfileRevisionId !== 'string'
      || !source.voiceProfileRevisionId))
    || typeof source.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(source.updatedAt))) {
    throw new Error('profile binding is invalid')
  }
  return {
    version: source.version,
    recommendationJobId: source.recommendationJobId,
    sourceRevisionId: source.sourceRevisionId,
    voiceProfileRevisionId: source.version === 2 ? source.voiceProfileRevisionId as string : null,
    updatedAt: source.updatedAt,
    recommendation: parseLinePerformanceRecommendation(source.recommendation, lineId, text),
  }
}

function nextTimestamp(previous: string): string {
  const prior = Date.parse(previous)
  return new Date(Math.max(Date.now(), Number.isFinite(prior) ? prior + 1 : 0)).toISOString()
}

function profileEtag(databaseLineId: string, revisionId: string | null): string {
  // The audit revision is a monotonic head, including clear tombstones. The
  // database line id scopes the initial no-profile sentinel to one resource.
  return `W/"line-performance:${databaseLineId}:${revisionId ?? 'none'}"`
}

function snapshot(
  input: SaveLinePerformanceProfileInput,
  profile: StoredProfile,
): JsonObject {
  return {
    version: 2,
    kind: 'dialogue.line-performance',
    projectId: input.projectId,
    episodeId: input.episodeId,
    lineId: input.lineId,
    databaseLineId: input.databaseLineId,
    sourceRevisionId: input.expectedSourceRevisionId,
    profile: profile as unknown as JsonObject,
  }
}

function recommendationFromRecord(record: LinePerformanceProfileRecord): LinePerformanceRecommendation {
  return {
    version: record.version,
    lineId: record.lineId,
    emotion: record.emotion,
    speed: record.speed,
    pitch: record.pitch,
    ...(record.openingSoundTag ? { openingSoundTag: record.openingSoundTag } : {}),
    pausePlan: record.pausePlan.map((pause) => ({ ...pause })),
    rationale: record.rationale,
  }
}

function emptyStale(): LinePerformanceStaleResult {
  return {
    speechAssets: 0,
    narrationLines: 0,
    exports: 0,
    exportAssets: 0,
    qualityReports: 0,
    pipelineRuns: 0,
    activeJobIds: [],
  }
}

export class LinePerformanceProfileRepository {
  constructor(private readonly database: ManjuDatabase) {}

  getState(
    projectId: string,
    episodeId: string,
    lineId: string,
  ): LinePerformanceProfileState {
    const row = requireTarget(this.database, { projectId, episodeId, lineId })
    const databaseLineId = requiredString(row, 'database_line_id')
    const metadata = parseObject(row.metadata_json)
    if (metadata[PROFILE_KEY] === undefined && metadata[REVISION_KEY] === undefined) {
      return {
        profile: undefined,
        revisionId: null,
        etag: profileEtag(databaseLineId, null),
      }
    }
    if (typeof metadata[REVISION_KEY] !== 'string' || metadata[PROFILE_KEY] === undefined) {
      throw new LinePerformanceProfileError(
        'LINE_PERFORMANCE_PROFILE_CORRUPT',
        '逐句表演档案缺少不可变审计版本',
      )
    }
    const revisionId = metadata[REVISION_KEY]
    const revision = this.database.getRevision(revisionId)
    const commonRevisionValid = Boolean(revision
      && revision.projectId === projectId
      && revision.snapshot.kind === 'dialogue.line-performance'
      && revision.snapshot.projectId === projectId
      && revision.snapshot.episodeId === episodeId
      && revision.snapshot.lineId === publicLineId(row)
      && revision.snapshot.databaseLineId === row.database_line_id)
    if (metadata[PROFILE_KEY] === null) {
      if (!commonRevisionValid || revision?.snapshot.profile !== null) {
        throw new LinePerformanceProfileError(
          'LINE_PERFORMANCE_PROFILE_CORRUPT',
          '逐句表演清除记录与审计版本不一致',
        )
      }
      return {
        profile: undefined,
        revisionId,
        etag: profileEtag(databaseLineId, revisionId),
      }
    }
    let profile: StoredProfile
    try {
      profile = parseStoredProfile(
        metadata[PROFILE_KEY],
        publicLineId(row),
        requiredString(row, 'text'),
      )
    } catch {
      throw new LinePerformanceProfileError(
        'LINE_PERFORMANCE_PROFILE_CORRUPT',
        '逐句表演档案无效',
      )
    }
    if (!commonRevisionValid
      || !isDeepStrictEqual(revision!.snapshot.profile, profile)) {
      throw new LinePerformanceProfileError(
        'LINE_PERFORMANCE_PROFILE_CORRUPT',
        '逐句表演档案与审计版本不一致',
      )
    }
    return {
      revisionId,
      etag: profileEtag(databaseLineId, revisionId),
      profile: {
        projectId,
        episodeId,
        databaseLineId,
        revisionId,
        recommendationJobId: profile.recommendationJobId,
        sourceRevisionId: profile.sourceRevisionId,
        voiceProfileRevisionId: profile.voiceProfileRevisionId,
        updatedAt: profile.updatedAt,
        ...profile.recommendation,
      },
    }
  }

  get(
    projectId: string,
    episodeId: string,
    lineId: string,
  ): LinePerformanceProfileRecord | undefined {
    return this.getState(projectId, episodeId, lineId).profile
  }

  save(input: SaveLinePerformanceProfileInput): {
    profile: LinePerformanceProfileRecord
    revision: RevisionRecord
    etag: string
    stale: LinePerformanceStaleResult
  } {
    return this.database.transaction(() => {
      const row = requireTarget(this.database, input)
      if (row.database_line_id !== input.databaseLineId
        || row.source_revision_id !== input.expectedSourceRevisionId
        || publicLineId(row) !== input.lineId) {
        throw new LinePerformanceProfileError(
          'STALE_SOURCE',
          '台词或剧本已修改，请重新生成表演建议',
        )
      }
      const text = requiredString(row, 'text')
      const recommendation = parseLinePerformanceRecommendation(
        input.recommendation,
        input.lineId,
        text,
      )
      const currentState = this.getState(input.projectId, input.episodeId, input.lineId)
      const existing = currentState.profile
      if (existing
        && existing.recommendationJobId === input.recommendationJobId
        && existing.sourceRevisionId === input.expectedSourceRevisionId
        && existing.voiceProfileRevisionId === input.voiceProfileRevisionId
        && isDeepStrictEqual(recommendationFromRecord(existing), recommendation)) {
        const revision = this.database.getRevision(existing.revisionId)
        if (!revision) throw new Error('Current line performance revision disappeared')
        return { profile: existing, revision, etag: currentState.etag, stale: emptyStale() }
      }
      if (input.expectedEtag !== currentState.etag) {
        throw new LinePerformanceProfileError(
          'PRECONDITION_FAILED',
          '逐句表演档案已在其他窗口修改，请刷新后重试',
        )
      }
      const priorMetadataJson = requiredString(row, 'metadata_json')
      const metadata = parseObject(priorMetadataJson)
      const parentRevisionId = currentState.revisionId
      const updatedAt = nextTimestamp(requiredString(row, 'updated_at'))
      const stored: StoredProfile = {
        version: 2,
        recommendationJobId: input.recommendationJobId,
        sourceRevisionId: input.expectedSourceRevisionId,
        voiceProfileRevisionId: input.voiceProfileRevisionId,
        updatedAt,
        recommendation,
      }
      const revision = this.database.createRevision({
        projectId: input.projectId,
        parentRevisionId,
        summary: `采用台词 ${input.lineId} 的 AI 表演建议`,
        snapshot: snapshot(input, stored),
      })
      metadata[PROFILE_KEY] = stored as unknown as JsonObject
      metadata[REVISION_KEY] = revision.id
      const changed = this.database.withSql((sql) => sql.run(`
        UPDATE dialogue_lines
           SET metadata_json = ?, updated_at = ?
         WHERE id = ?
           AND text = ?
           AND metadata_json = ?
           AND EXISTS (
             SELECT 1
               FROM shots
               JOIN scenes ON scenes.id = shots.scene_id
               JOIN episodes ON episodes.id = scenes.episode_id
              WHERE shots.id = dialogue_lines.shot_id
                AND episodes.id = ?
                AND episodes.project_id = ?
                AND episodes.source_revision_id = ?
           )
      `,
      JSON.stringify(metadata),
      updatedAt,
      input.databaseLineId,
      text,
      priorMetadataJson,
      input.episodeId,
      input.projectId,
      input.expectedSourceRevisionId,
      )).changes
      if (changed !== 1) {
        throw new LinePerformanceProfileError(
          'STALE_SOURCE',
          '台词表演档案发生并发修改，请刷新后重试',
        )
      }
      const stale = this.markDownstreamStale(input, revision.id, updatedAt)
      const profile = this.get(input.projectId, input.episodeId, input.lineId)
      if (!profile) throw new Error('Saved line performance profile disappeared')
      return {
        profile,
        revision,
        etag: profileEtag(input.databaseLineId, revision.id),
        stale,
      }
    })
  }

  clear(input: ClearLinePerformanceProfileInput): {
    profile: null
    revision?: RevisionRecord
    etag: string
    stale: LinePerformanceStaleResult
  } {
    return this.database.transaction(() => {
      const row = requireTarget(this.database, input)
      const currentState = this.getState(input.projectId, input.episodeId, input.lineId)
      const current = currentState.profile
      if (!current) {
        if (currentState.revisionId === null && input.expectedEtag !== currentState.etag) {
          throw new LinePerformanceProfileError(
            'PRECONDITION_FAILED',
            '逐句表演档案已在其他窗口修改，请刷新后重试',
          )
        }
        // A repeated DELETE after a lost response is safe even with the old
        // If-Match: the requested null state and tombstone already exist.
        return { profile: null, etag: currentState.etag, stale: emptyStale() }
      }
      if (input.expectedEtag !== currentState.etag) {
        throw new LinePerformanceProfileError(
          'PRECONDITION_FAILED',
          '逐句表演档案已在其他窗口修改，请刷新后重试',
        )
      }
      const priorMetadataJson = requiredString(row, 'metadata_json')
      const metadata = parseObject(priorMetadataJson)
      const now = nextTimestamp(requiredString(row, 'updated_at'))
      const revision = this.database.createRevision({
        projectId: input.projectId,
        parentRevisionId: current.revisionId,
        summary: `清除台词 ${input.lineId} 的 AI 表演建议`,
        snapshot: {
          version: 2,
          kind: 'dialogue.line-performance',
          projectId: input.projectId,
          episodeId: input.episodeId,
          lineId: input.lineId,
          databaseLineId: current.databaseLineId,
          sourceRevisionId: current.sourceRevisionId,
          profile: null,
        },
      })
      // Keep both the null-state marker and its immutable audit head. A later
      // save must parent from this tombstone rather than starting a new chain.
      metadata[PROFILE_KEY] = null
      metadata[REVISION_KEY] = revision.id
      const changed = this.database.withSql((sql) => sql.run(`
        UPDATE dialogue_lines SET metadata_json = ?, updated_at = ?
         WHERE id = ? AND metadata_json = ?
      `, JSON.stringify(metadata), now, current.databaseLineId, priorMetadataJson)).changes
      if (changed !== 1) {
        throw new LinePerformanceProfileError(
          'STALE_SOURCE',
          '逐句表演档案发生并发修改，请刷新后重试',
        )
      }
      return {
        profile: null,
        revision,
        etag: profileEtag(current.databaseLineId, revision.id),
        stale: this.markDownstreamStale({
          projectId: input.projectId,
          episodeId: input.episodeId,
          databaseLineId: current.databaseLineId,
        }, revision.id, now),
      }
    })
  }

  private markDownstreamStale(
    input: Pick<SaveLinePerformanceProfileInput, 'projectId' | 'episodeId' | 'databaseLineId'>,
    revisionId: string,
    now: string,
  ): LinePerformanceStaleResult {
    return this.database.withSql((sql) => {
      const activeJobIds = sql.all(`
        SELECT id FROM generation_jobs
         WHERE project_id = ?
           AND type = 'dialogue.speech.generate'
           AND resource_id = ?
           AND status IN ('queued', 'running', 'waiting_provider')
         ORDER BY id
      `, input.projectId, input.databaseLineId).flatMap((row) => (
        typeof row.id === 'string' ? [row.id] : []
      ))
      const speechAssets = sql.run(`
        UPDATE media_assets SET status = 'stale', updated_at = ?
         WHERE id = (SELECT speech_asset_id FROM dialogue_lines WHERE id = ?)
           AND status <> 'stale'
      `, now, input.databaseLineId).changes
      const narrationLines = sql.run(`
        UPDATE dialogue_lines
           SET speech_asset_id = NULL, voice_id = NULL,
               duration_seconds = NULL, updated_at = ?
         WHERE id = ?
           AND (speech_asset_id IS NOT NULL OR voice_id IS NOT NULL OR duration_seconds IS NOT NULL)
      `, now, input.databaseLineId).changes
      const exportAssets = sql.run(`
        UPDATE media_assets SET status = 'stale', updated_at = ?
         WHERE id IN (
           SELECT output_asset_id FROM exports
            WHERE project_id = ? AND episode_id = ? AND output_asset_id IS NOT NULL
         ) AND status <> 'stale'
      `, now, input.projectId, input.episodeId).changes
      const exports = sql.run(`
        UPDATE exports SET status = 'stale', updated_at = ?
         WHERE project_id = ? AND episode_id = ? AND status <> 'stale'
      `, now, input.projectId, input.episodeId).changes
      const qualityReports = sql.run(`
        UPDATE quality_reports SET status = 'stale', passed = 0
         WHERE project_id = ? AND episode_id = ? AND status <> 'stale'
      `, input.projectId, input.episodeId).changes
      const pipelineRuns = sql.run(`
        UPDATE pipeline_runs SET status = 'stale', updated_at = ?, completed_at = ?
         WHERE project_id = ? AND episode_id = ? AND status <> 'stale'
      `, now, now, input.projectId, input.episodeId).changes
      sql.run(`
        UPDATE generation_jobs
           SET progress_detail_json = json_set(
             progress_detail_json,
             '$.stale', json('true'),
             '$.staleReason', 'line_performance_changed',
             '$.linePerformanceRevisionId', ?
           ), updated_at = ?
         WHERE project_id = ?
           AND type = 'dialogue.speech.generate'
           AND resource_id = ?
      `, revisionId, now, input.projectId, input.databaseLineId)
      return {
        speechAssets,
        narrationLines,
        exports,
        exportAssets,
        qualityReports,
        pipelineRuns,
        activeJobIds,
      }
    })
  }
}
