import { isDeepStrictEqual } from 'node:util'

import type { ManjuDatabase, RevisionRecord } from './database.js'
import {
  projectSettingsEtag,
  projectSettingsVersionMatches,
} from './project-version.js'
import {
  parseStoryCharacterVoiceProfile,
  type StoryCharacterVoiceProfile,
} from './story-schema.js'
import type { JsonObject } from './types.js'

type SqlRow = Record<string, unknown>

const PROFILE_KEY = 'narratorVoiceProfile'
const REVISION_KEY = 'narratorVoiceProfileRevisionId'

export interface ProjectNarratorVoiceProfileState {
  projectId: string
  revisionId: string | null
  profile: StoryCharacterVoiceProfile | null
  projectEtag: string
}

export interface ProjectNarratorVoiceProfileWrite {
  projectId: string
  expectedProjectVersion: string
  profile: StoryCharacterVoiceProfile | null
}

export interface ProjectNarratorVoiceProfileStaleResult {
  speechAssets: number
  exportAssets: number
  jobs: number
  narrationLines: number
  exports: number
  qualityReports: number
  pipelineRuns: number
  /** Internal cancellation targets; HTTP callers must not expose these IDs. */
  activeJobIds: string[]
}

export type ProjectNarratorVoiceProfileErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_NARRATOR_VOICE_PROFILE_CORRUPT'
  | 'PROJECT_NARRATOR_VOICE_PROFILE_NOT_FOUND'
  | 'REVISION_CONFLICT'

export class ProjectNarratorVoiceProfileError extends Error {
  constructor(
    readonly code: ProjectNarratorVoiceProfileErrorCode,
    message: string,
    readonly currentEtag?: string,
  ) {
    super(message)
    this.name = 'ProjectNarratorVoiceProfileError'
  }
}

function requiredString(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not text`)
  return value
}

function nullableString(row: SqlRow, column: string): string | null {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not nullable text`)
  return value
}

function parseSettingsJson(value: unknown): JsonObject {
  if (typeof value !== 'string') throw new Error('Database project settings are not JSON text')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Database project settings are not an object')
  }
  return parsed as JsonObject
}

function profileFromSettings(settings: JsonObject): {
  profile: StoryCharacterVoiceProfile
  revisionId: string
} | undefined {
  if (settings[PROFILE_KEY] === undefined && settings[REVISION_KEY] === undefined) return undefined
  if (settings[PROFILE_KEY] === undefined || typeof settings[REVISION_KEY] !== 'string') {
    throw new ProjectNarratorVoiceProfileError(
      'PROJECT_NARRATOR_VOICE_PROFILE_CORRUPT',
      '项目旁白声线绑定记录不完整',
    )
  }
  try {
    return {
      profile: parseStoryCharacterVoiceProfile(settings[PROFILE_KEY]),
      revisionId: settings[REVISION_KEY],
    }
  } catch {
    throw new ProjectNarratorVoiceProfileError(
      'PROJECT_NARRATOR_VOICE_PROFILE_CORRUPT',
      '项目旁白声线绑定记录无效',
    )
  }
}

function nextUpdatedAt(previous: string): string {
  const previousMs = Date.parse(previous)
  return new Date(Math.max(
    Date.now(),
    Number.isFinite(previousMs) ? previousMs + 1 : 0,
  )).toISOString()
}

function profileSnapshot(
  projectId: string,
  profile: StoryCharacterVoiceProfile | null,
): JsonObject {
  return {
    version: 1,
    kind: 'project.narrator-voice-profile',
    projectId,
    profile: profile as unknown as JsonObject | null,
  }
}

/**
 * Project-level narrator casting is deliberately independent from Story and
 * project document revisions. `projects.settings_json` stores only the current
 * materialized profile plus its immutable audit revision ID; the full history
 * remains in `revisions`.
 */
export class ProjectNarratorVoiceProfileRepository {
  constructor(private readonly database: ManjuDatabase) {}

  private projectRow(projectId: string): SqlRow {
    const row = this.database.withSql((sql) => sql.get(
      'SELECT * FROM projects WHERE id = ?',
      projectId,
    ))
    if (!row) {
      throw new ProjectNarratorVoiceProfileError(
        'PROJECT_NOT_FOUND',
        '项目不存在',
      )
    }
    return row
  }

  get(projectId: string): ProjectNarratorVoiceProfileState {
    const row = this.projectRow(projectId)
    const settings = parseSettingsJson(row.settings_json)
    const current = profileFromSettings(settings)
    if (current) {
      const revision = this.database.getRevision(current.revisionId)
      let auditProfile: StoryCharacterVoiceProfile | undefined
      try {
        auditProfile = revision?.snapshot.kind === 'project.narrator-voice-profile'
          && revision.snapshot.projectId === projectId
          ? parseStoryCharacterVoiceProfile(revision.snapshot.profile)
          : undefined
      } catch {
        auditProfile = undefined
      }
      if (!revision
        || revision.projectId !== projectId
        || !auditProfile
        || !isDeepStrictEqual(auditProfile, current.profile)) {
        throw new ProjectNarratorVoiceProfileError(
          'PROJECT_NARRATOR_VOICE_PROFILE_CORRUPT',
          '项目旁白声线审计版本不存在或不匹配',
        )
      }
    }
    const versionSource = {
      currentRevisionId: nullableString(row, 'current_revision_id'),
      updatedAt: requiredString(row, 'updated_at'),
    }
    return {
      projectId,
      revisionId: current?.revisionId ?? null,
      profile: current?.profile ?? null,
      projectEtag: projectSettingsEtag(versionSource),
    }
  }

  save(input: ProjectNarratorVoiceProfileWrite): {
    state: ProjectNarratorVoiceProfileState
    revision: RevisionRecord
    stale: ProjectNarratorVoiceProfileStaleResult
  } {
    return this.database.transaction(() => {
      const row = this.projectRow(input.projectId)
      const currentRevisionId = nullableString(row, 'current_revision_id')
      const previousUpdatedAt = requiredString(row, 'updated_at')
      const versionSource = { currentRevisionId, updatedAt: previousUpdatedAt }
      if (!projectSettingsVersionMatches(versionSource, input.expectedProjectVersion)) {
        throw new ProjectNarratorVoiceProfileError(
          'REVISION_CONFLICT',
          '项目已被其他操作更新，请刷新后重试',
          projectSettingsEtag(versionSource),
        )
      }
      const priorSettingsJson = requiredString(row, 'settings_json')
      const settings = parseSettingsJson(priorSettingsJson)
      const current = profileFromSettings(settings)
      // Validate the materialized profile against its audit row before using
      // that row as the immutable parent of the next revision.
      if (current) this.get(input.projectId)
      const profile = input.profile === null
        ? null
        : parseStoryCharacterVoiceProfile(input.profile)
      const revision = this.database.createRevision({
        projectId: input.projectId,
        parentRevisionId: current?.revisionId ?? null,
        summary: profile ? '设置项目旁白声线' : '清除项目旁白声线',
        snapshot: profileSnapshot(input.projectId, profile),
      })
      if (profile) {
        settings[PROFILE_KEY] = profile as unknown as JsonObject
        settings[REVISION_KEY] = revision.id
      } else {
        delete settings[PROFILE_KEY]
        delete settings[REVISION_KEY]
      }
      const updatedAt = nextUpdatedAt(previousUpdatedAt)
      const changes = this.database.withSql((sql) => sql.run(`
        UPDATE projects
           SET settings_json = ?, updated_at = ?
         WHERE id = ?
           AND current_revision_id IS ?
           AND updated_at = ?
           AND settings_json = ?
      `,
      JSON.stringify(settings),
      updatedAt,
      input.projectId,
      currentRevisionId,
      previousUpdatedAt,
      priorSettingsJson,
      )).changes
      if (changes !== 1) {
        const latest = this.projectRow(input.projectId)
        throw new ProjectNarratorVoiceProfileError(
          'REVISION_CONFLICT',
          '项目已被其他操作更新，请刷新后重试',
          projectSettingsEtag({
            currentRevisionId: nullableString(latest, 'current_revision_id'),
            updatedAt: requiredString(latest, 'updated_at'),
          }),
        )
      }
      const stale = this.markDownstreamStale(input.projectId, revision.id, updatedAt)
      return {
        state: this.get(input.projectId),
        revision,
        stale,
      }
    })
  }

  /**
   * Invalidate only narration audio and outputs that consumed episode audio.
   * Character dialogue, storyboard images, and shot video remain reusable.
   */
  private markDownstreamStale(
    projectId: string,
    narratorVoiceProfileRevisionId: string,
    now: string,
  ): ProjectNarratorVoiceProfileStaleResult {
    return this.database.withSql((sql) => {
      const activeJobIds = sql.all(`
        SELECT id FROM generation_jobs
         WHERE status IN ('queued', 'running', 'waiting_provider')
           AND project_id = ?
           AND (
             (
               type = 'dialogue.speech.generate'
               AND resource_id IN (
                 SELECT dialogue_lines.id
                   FROM dialogue_lines
                   JOIN shots ON shots.id = dialogue_lines.shot_id
                   JOIN scenes ON scenes.id = shots.scene_id
                   JOIN episodes ON episodes.id = scenes.episode_id
                  WHERE episodes.project_id = ? AND dialogue_lines.kind = 'narration'
                 UNION
                 SELECT json_extract(dialogue_lines.metadata_json, '$.storyId')
                   FROM dialogue_lines
                   JOIN shots ON shots.id = dialogue_lines.shot_id
                   JOIN scenes ON scenes.id = shots.scene_id
                   JOIN episodes ON episodes.id = scenes.episode_id
                  WHERE episodes.project_id = ? AND dialogue_lines.kind = 'narration'
               )
             )
             OR (
               episode_id IN (SELECT id FROM episodes WHERE project_id = ?)
               AND type IN ('timeline.preview.render', 'export.render', 'quality.check')
             )
           )
         ORDER BY id
      `, projectId, projectId, projectId, projectId)
        .map((candidate) => requiredString(candidate, 'id'))
      const speechAssets = sql.run(`
        UPDATE media_assets SET status = 'stale', updated_at = ?
         WHERE status <> 'stale'
           AND id IN (
             SELECT dialogue_lines.speech_asset_id
               FROM dialogue_lines
               JOIN shots ON shots.id = dialogue_lines.shot_id
               JOIN scenes ON scenes.id = shots.scene_id
               JOIN episodes ON episodes.id = scenes.episode_id
              WHERE episodes.project_id = ?
                AND dialogue_lines.kind = 'narration'
                AND dialogue_lines.speech_asset_id IS NOT NULL
           )
      `, now, projectId).changes
      const exportAssets = sql.run(`
        UPDATE media_assets SET status = 'stale', updated_at = ?
         WHERE status <> 'stale'
           AND id IN (
             SELECT exports.output_asset_id
               FROM exports
              WHERE exports.project_id = ? AND exports.output_asset_id IS NOT NULL
           )
      `, now, projectId).changes
      const jobs = sql.run(`
        UPDATE generation_jobs SET
          progress_detail_json = json_set(
            progress_detail_json,
            '$.stale', json('true'),
            '$.staleReason', 'project_narrator_voice_profile_changed',
            '$.narratorVoiceProfileRevisionId', ?
          ),
          updated_at = ?
         WHERE project_id = ?
           AND (
             (
               type = 'dialogue.speech.generate'
               AND resource_id IN (
                 SELECT dialogue_lines.id
                   FROM dialogue_lines
                   JOIN shots ON shots.id = dialogue_lines.shot_id
                   JOIN scenes ON scenes.id = shots.scene_id
                   JOIN episodes ON episodes.id = scenes.episode_id
                  WHERE episodes.project_id = ? AND dialogue_lines.kind = 'narration'
                 UNION
                 SELECT json_extract(dialogue_lines.metadata_json, '$.storyId')
                   FROM dialogue_lines
                   JOIN shots ON shots.id = dialogue_lines.shot_id
                   JOIN scenes ON scenes.id = shots.scene_id
                   JOIN episodes ON episodes.id = scenes.episode_id
                  WHERE episodes.project_id = ? AND dialogue_lines.kind = 'narration'
               )
             )
             OR (
               episode_id IN (SELECT id FROM episodes WHERE project_id = ?)
               AND type IN ('timeline.preview.render', 'export.render', 'quality.check')
             )
           )
           AND (
             status IN ('queued', 'running', 'waiting_provider')
             OR COALESCE(json_extract(progress_detail_json, '$.stale'), 0) <> 1
           )
      `,
      narratorVoiceProfileRevisionId,
      now,
      projectId,
      projectId,
      projectId,
      projectId,
      ).changes
      const narrationLines = sql.run(`
        UPDATE dialogue_lines SET
          speech_asset_id = NULL,
          voice_id = NULL,
          duration_seconds = NULL,
          updated_at = ?
         WHERE kind = 'narration'
           AND id IN (
             SELECT dialogue_lines.id
               FROM dialogue_lines
               JOIN shots ON shots.id = dialogue_lines.shot_id
               JOIN scenes ON scenes.id = shots.scene_id
               JOIN episodes ON episodes.id = scenes.episode_id
              WHERE episodes.project_id = ?
           )
           AND (speech_asset_id IS NOT NULL OR voice_id IS NOT NULL OR duration_seconds IS NOT NULL)
      `, now, projectId).changes
      const exports = sql.run(`
        UPDATE exports SET status = 'stale', updated_at = ?
         WHERE project_id = ? AND status <> 'stale'
      `, now, projectId).changes
      const qualityReports = sql.run(`
        UPDATE quality_reports SET status = 'stale', passed = 0
         WHERE project_id = ? AND status <> 'stale'
      `, projectId).changes
      const pipelineRuns = sql.run(`
        UPDATE pipeline_runs SET status = 'stale', updated_at = ?, completed_at = ?
         WHERE project_id = ? AND status <> 'stale'
      `, now, now, projectId).changes
      return {
        speechAssets,
        exportAssets,
        jobs,
        narrationLines,
        exports,
        qualityReports,
        pipelineRuns,
        activeJobIds,
      }
    })
  }
}
