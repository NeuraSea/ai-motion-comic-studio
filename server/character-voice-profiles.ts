import type { SQLInputValue } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'

import type { ManjuDatabase, RevisionRecord } from './database.js'
import { episodeEtag, episodeVersionMatches } from './episode-version.js'
import {
  parseStoryCharacterVoiceProfile,
  type StoryCharacterVoiceProfile,
} from './story-schema.js'
import type { JsonObject } from './types.js'

type SqlRow = Record<string, unknown>

export interface CharacterVoiceProfileRecord {
  projectId: string
  episodeId: string
  characterId: string
  characterDatabaseId: string
  characterName: string
  characterVersion: number
  revisionId: string
  profile: StoryCharacterVoiceProfile
  episodeEtag: string
}

export interface CharacterVoiceProfileWrite {
  projectId: string
  episodeId: string
  characterId: string
  expectedEpisodeVersion: string
  profile: StoryCharacterVoiceProfile | null
  summary?: string
}

export interface CharacterVoiceProfileStaleResult {
  speechAssets: number
  exportAssets: number
  jobs: number
  dialogueLines: number
  exports: number
  qualityReports: number
  pipelineRuns: number
  /** Internal cancellation targets; HTTP callers should not expose these IDs. */
  activeJobIds: string[]
}

export interface CharacterVoiceProfileRepairResult {
  repaired: number
  revisionIds: string[]
  activeJobIds: string[]
}

export type CharacterVoiceProfileErrorCode =
  | 'CHARACTER_NOT_FOUND'
  | 'CHARACTER_VOICE_PROFILE_CORRUPT'
  | 'CHARACTER_VOICE_PROFILE_NOT_FOUND'
  | 'EPISODE_NOT_FOUND'
  | 'REVISION_CONFLICT'

export class CharacterVoiceProfileError extends Error {
  constructor(
    readonly code: CharacterVoiceProfileErrorCode,
    message: string,
    readonly currentEtag?: string,
  ) {
    super(message)
    this.name = 'CharacterVoiceProfileError'
  }
}

function requiredString(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not text`)
  return value
}

function requiredNumber(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value !== 'number') throw new Error(`Database column ${column} is not numeric`)
  return value
}

function parseMetadata(row: SqlRow): JsonObject {
  const value = row.metadata_json
  if (typeof value !== 'string') throw new Error('Database character metadata is not JSON text')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Database character metadata is not an object')
  }
  return parsed as JsonObject
}

function nextUpdatedAt(previous: string): string {
  const previousMs = Date.parse(previous)
  return new Date(Math.max(
    Date.now(),
    Number.isFinite(previousMs) ? previousMs + 1 : 0,
  )).toISOString()
}

function profileFromRow(row: SqlRow): {
  profile: StoryCharacterVoiceProfile
  revisionId: string
} | undefined {
  const metadata = parseMetadata(row)
  if (metadata.voiceProfile === undefined && metadata.voiceProfileRevisionId === undefined) return undefined
  if (metadata.voiceProfile === undefined || typeof metadata.voiceProfileRevisionId !== 'string') {
    throw new CharacterVoiceProfileError(
      'CHARACTER_VOICE_PROFILE_CORRUPT',
      '角色声线绑定记录不完整',
    )
  }
  try {
    return {
      profile: parseStoryCharacterVoiceProfile(metadata.voiceProfile),
      revisionId: metadata.voiceProfileRevisionId,
    }
  } catch {
    throw new CharacterVoiceProfileError(
      'CHARACTER_VOICE_PROFILE_CORRUPT',
      '角色声线绑定记录无效',
    )
  }
}

function storyId(row: SqlRow): string {
  const metadata = parseMetadata(row)
  return typeof metadata.storyId === 'string' && metadata.storyId.trim()
    ? metadata.storyId.trim()
    : requiredString(row, 'id')
}

function profileSnapshot(
  input: CharacterVoiceProfileWrite,
  characterName: string,
  profile: StoryCharacterVoiceProfile | null,
): JsonObject {
  return {
    version: 1,
    kind: 'character.voice-profile',
    projectId: input.projectId,
    episodeId: input.episodeId,
    characterId: input.characterId,
    characterName,
    profile: profile as unknown as JsonObject | null,
  }
}

function repairLegacyFractionalPitch(profile: unknown): unknown | undefined {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return undefined
  const repaired = structuredClone(profile) as Record<string, unknown>
  let changed = false
  const repairDelivery = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const delivery = value as Record<string, unknown>
    if (typeof delivery.pitch !== 'number'
      || !Number.isFinite(delivery.pitch)
      || delivery.pitch < -12
      || delivery.pitch > 12
      || Number.isInteger(delivery.pitch)) return
    delivery.pitch = Math.round(delivery.pitch)
    changed = true
  }
  repairDelivery(repaired.defaultDelivery)
  if (Array.isArray(repaired.sceneDirections)) {
    repaired.sceneDirections.forEach(repairDelivery)
  }
  return changed ? repaired : undefined
}

export class CharacterVoiceProfileRepository {
  constructor(private readonly database: ManjuDatabase) {}

  /**
   * Repairs profiles written by the short-lived pre-MVP recommendation schema
   * that incorrectly allowed fractional MiniMax pitch values. The original
   * audit revision remains immutable; the normalized profile is recorded as a
   * child revision before any speech worker can resume.
   */
  repairLegacyFractionalPitches(): CharacterVoiceProfileRepairResult {
    return this.database.transaction(() => {
      const revisionIds: string[] = []
      const activeJobIds = new Set<string>()
      const rows = this.database.withSql((sql) => sql.all(`
        SELECT characters.*, episodes.updated_at AS episode_updated_at
          FROM characters
          JOIN episodes ON episodes.id = characters.episode_id
         WHERE json_type(characters.metadata_json, '$.voiceProfile') = 'object'
         ORDER BY characters.id
      `))
      for (const row of rows) {
        const metadata = parseMetadata(row)
        const repairedValue = repairLegacyFractionalPitch(metadata.voiceProfile)
        if (repairedValue === undefined) continue
        const priorRevisionId = metadata.voiceProfileRevisionId
        if (typeof priorRevisionId !== 'string') continue
        const priorRevision = this.database.getRevision(priorRevisionId)
        if (!priorRevision
          || priorRevision.projectId !== requiredString(row, 'project_id')
          || priorRevision.snapshot.kind !== 'character.voice-profile'
          || !isDeepStrictEqual(priorRevision.snapshot.profile, metadata.voiceProfile)) {
          // Do not disguise unrelated audit corruption as a compatibility fix.
          continue
        }
        let profile: StoryCharacterVoiceProfile
        try {
          profile = parseStoryCharacterVoiceProfile(repairedValue)
        } catch {
          // Only the known fractional-pitch defect is repairable here.
          continue
        }
        const projectId = requiredString(row, 'project_id')
        const episodeId = requiredString(row, 'episode_id')
        const characterId = storyId(row)
        const characterName = requiredString(row, 'name')
        const revision = this.database.createRevision({
          projectId,
          parentRevisionId: priorRevisionId,
          summary: `兼容修复角色 ${characterName} 声线音高为整数半音`,
          snapshot: profileSnapshot({
            projectId,
            episodeId,
            characterId,
            expectedEpisodeVersion: '',
            profile,
          }, characterName, profile),
        })
        metadata.voiceProfile = profile as unknown as JsonObject
        metadata.voiceProfileRevisionId = revision.id
        const updatedAt = nextUpdatedAt(requiredString(row, 'episode_updated_at'))
        const changes = this.database.withSql((sql) => sql.run(`
          UPDATE characters
             SET metadata_json = ?, updated_at = ?
           WHERE id = ? AND metadata_json = ?
        `,
        JSON.stringify(metadata),
        updatedAt,
        requiredString(row, 'id'),
        requiredString(row, 'metadata_json'),
        )).changes
        if (changes !== 1) throw new Error('角色声线兼容修复遇到并发修改')
        this.database.withSql((sql) => sql.run(`
          UPDATE episodes SET updated_at = ? WHERE id = ? AND project_id = ?
        `, updatedAt, episodeId, projectId))
        const stale = this.markDownstreamStale(
          requiredString(row, 'id'),
          episodeId,
          revision.id,
          updatedAt,
        )
        stale.activeJobIds.forEach((jobId) => activeJobIds.add(jobId))
        revisionIds.push(revision.id)
      }
      return {
        repaired: revisionIds.length,
        revisionIds,
        activeJobIds: [...activeJobIds].sort(),
      }
    })
  }

  private resolveCharacter(
    projectId: string,
    episodeId: string,
    characterId: string,
  ): SqlRow {
    const rows = this.database.withSql((sql) => sql.all(`
      SELECT characters.*
        FROM characters
        JOIN episodes ON episodes.id = characters.episode_id
       WHERE episodes.project_id = ?
         AND episodes.id = ?
         AND CASE
           WHEN typeof(json_extract(characters.metadata_json, '$.storyId')) = 'text'
             AND length(trim(json_extract(characters.metadata_json, '$.storyId'))) > 0
           THEN json_extract(characters.metadata_json, '$.storyId')
           ELSE characters.id
         END = ?
       ORDER BY characters.id
       LIMIT 2
    `, projectId, episodeId, characterId))
    if (rows.length !== 1) {
      throw new CharacterVoiceProfileError(
        'CHARACTER_NOT_FOUND',
        rows.length === 0 ? '角色不存在或不属于指定分集' : '角色标识在分集中不唯一',
      )
    }
    return rows[0]
  }

  get(
    projectId: string,
    episodeId: string,
    characterId: string,
  ): CharacterVoiceProfileRecord | undefined {
    const episode = this.database.withSql((sql) => sql.get(
      'SELECT source_revision_id, updated_at FROM episodes WHERE id = ? AND project_id = ?',
      episodeId,
      projectId,
    ))
    if (!episode) {
      throw new CharacterVoiceProfileError('EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
    }
    const row = this.resolveCharacter(projectId, episodeId, characterId)
    const current = profileFromRow(row)
    if (!current) return undefined
    const revision = this.database.getRevision(current.revisionId)
    let auditProfile: StoryCharacterVoiceProfile | undefined
    try {
      auditProfile = revision?.snapshot.kind === 'character.voice-profile'
        && revision.snapshot.projectId === projectId
        && revision.snapshot.episodeId === episodeId
        && revision.snapshot.characterId === characterId
        ? parseStoryCharacterVoiceProfile(revision.snapshot.profile)
        : undefined
    } catch {
      auditProfile = undefined
    }
    if (!revision
      || revision.projectId !== projectId
      || !auditProfile
      || !isDeepStrictEqual(auditProfile, current.profile)) {
      throw new CharacterVoiceProfileError(
        'CHARACTER_VOICE_PROFILE_CORRUPT',
        '角色声线审计版本不存在',
      )
    }
    const sourceRevisionId = episode.source_revision_id === null
      ? null
      : requiredString(episode, 'source_revision_id')
    return {
      projectId,
      episodeId,
      characterId: storyId(row),
      characterDatabaseId: requiredString(row, 'id'),
      characterName: requiredString(row, 'name'),
      characterVersion: requiredNumber(row, 'version'),
      revisionId: current.revisionId,
      profile: current.profile,
      episodeEtag: episodeEtag({
        sourceRevisionId,
        updatedAt: requiredString(episode, 'updated_at'),
      }),
    }
  }

  save(input: CharacterVoiceProfileWrite): {
    record?: CharacterVoiceProfileRecord
    revision: RevisionRecord
    episodeEtag: string
    stale: CharacterVoiceProfileStaleResult
  } {
    return this.database.transaction(() => {
      const episode = this.database.withSql((sql) => sql.get(
        'SELECT source_revision_id, updated_at FROM episodes WHERE id = ? AND project_id = ?',
        input.episodeId,
        input.projectId,
      ))
      if (!episode) {
        throw new CharacterVoiceProfileError('EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
      }
      const sourceRevisionId = episode.source_revision_id === null
        ? null
        : requiredString(episode, 'source_revision_id')
      const currentEpisode = {
        sourceRevisionId,
        updatedAt: requiredString(episode, 'updated_at'),
      }
      if (!episodeVersionMatches(currentEpisode, input.expectedEpisodeVersion)) {
        throw new CharacterVoiceProfileError(
          'REVISION_CONFLICT',
          '分集已被其他操作更新，请刷新后重试',
          episodeEtag(currentEpisode),
        )
      }

      const row = this.resolveCharacter(input.projectId, input.episodeId, input.characterId)
      const current = profileFromRow(row)
      const normalizedProfile = input.profile === null
        ? null
        : parseStoryCharacterVoiceProfile(input.profile)
      const revision = this.database.createRevision({
        projectId: input.projectId,
        parentRevisionId: current?.revisionId ?? null,
        summary: input.summary?.trim().slice(0, 500)
          || (normalizedProfile ? `设置角色 ${requiredString(row, 'name')} 声线` : `清除角色 ${requiredString(row, 'name')} 声线`),
        snapshot: profileSnapshot(input, requiredString(row, 'name'), normalizedProfile),
      })

      const metadata = parseMetadata(row)
      if (normalizedProfile) {
        metadata.voiceProfile = normalizedProfile as unknown as JsonObject
        metadata.voiceProfileRevisionId = revision.id
      } else {
        delete metadata.voiceProfile
        delete metadata.voiceProfileRevisionId
      }
      const updatedAt = nextUpdatedAt(currentEpisode.updatedAt)
      const bindings: SQLInputValue[] = [JSON.stringify(metadata), updatedAt, requiredString(row, 'id')]
      const characterChanges = this.database.withSql((sql) => sql.run(`
        UPDATE characters
           SET metadata_json = ?, updated_at = ?
         WHERE id = ?
      `, ...bindings)).changes
      if (characterChanges !== 1) {
        throw new CharacterVoiceProfileError('CHARACTER_NOT_FOUND', '角色已被其他操作删除')
      }
      const stale = this.markDownstreamStale(
        requiredString(row, 'id'),
        input.episodeId,
        revision.id,
        updatedAt,
      )
      const episodeChanges = this.database.withSql((sql) => sql.run(`
        UPDATE episodes SET updated_at = ? WHERE id = ? AND project_id = ?
      `, updatedAt, input.episodeId, input.projectId)).changes
      if (episodeChanges !== 1) {
        throw new CharacterVoiceProfileError('EPISODE_NOT_FOUND', '分集已被其他操作删除')
      }
      const newEtag = episodeEtag({ sourceRevisionId, updatedAt })
      return {
        ...(normalizedProfile
          ? { record: this.get(input.projectId, input.episodeId, input.characterId) }
          : {}),
        revision,
        episodeEtag: newEtag,
        stale,
      }
    })
  }

  /**
   * Casting changes invalidate only that character's speech chain plus outputs
   * that consumed episode audio. Storyboards and shot video remain reusable.
   * Immutable timeline revisions are not rewritten; their referenced speech
   * assets become stale, so the next reconcile must replace them explicitly.
   */
  private markDownstreamStale(
    characterDatabaseId: string,
    episodeId: string,
    voiceProfileRevisionId: string,
    now: string,
  ): CharacterVoiceProfileStaleResult {
    return this.database.withSql((sql) => {
      const activeJobIds = sql.all(`
        SELECT id FROM generation_jobs
        WHERE status IN ('queued', 'running', 'waiting_provider')
          AND (
            (
              type = 'dialogue.speech.generate'
              AND resource_id IN (
                SELECT dialogue_lines.id FROM dialogue_lines
                 WHERE dialogue_lines.character_id = ?
                UNION
                SELECT json_extract(dialogue_lines.metadata_json, '$.storyId')
                  FROM dialogue_lines
                 WHERE dialogue_lines.character_id = ?
              )
            )
            OR (
              episode_id = ?
              AND type IN ('timeline.preview.render', 'export.render', 'quality.check')
            )
          )
        ORDER BY id
      `, characterDatabaseId, characterDatabaseId, episodeId)
        .map((row) => requiredString(row, 'id'))
      const speechAssets = sql.run(`
        UPDATE media_assets SET status = 'stale', updated_at = ?
         WHERE status <> 'stale'
           AND id IN (
             SELECT dialogue_lines.speech_asset_id
               FROM dialogue_lines
              WHERE dialogue_lines.character_id = ?
                AND dialogue_lines.speech_asset_id IS NOT NULL
           )
      `, now, characterDatabaseId).changes
      const exportAssets = sql.run(`
        UPDATE media_assets SET status = 'stale', updated_at = ?
         WHERE status <> 'stale'
           AND id IN (
             SELECT output_asset_id FROM exports
              WHERE episode_id = ? AND output_asset_id IS NOT NULL
           )
      `, now, episodeId).changes
      const jobs = sql.run(`
        UPDATE generation_jobs SET
          progress_detail_json = json_set(
            progress_detail_json,
            '$.stale', json('true'),
            '$.staleReason', 'character_voice_profile_changed',
            '$.voiceProfileRevisionId', ?
          ),
          updated_at = ?
        WHERE (
          (
            type = 'dialogue.speech.generate'
            AND resource_id IN (
              SELECT dialogue_lines.id FROM dialogue_lines
               WHERE dialogue_lines.character_id = ?
              UNION
              SELECT json_extract(dialogue_lines.metadata_json, '$.storyId')
                FROM dialogue_lines
               WHERE dialogue_lines.character_id = ?
            )
          )
          OR (
            episode_id = ?
            AND type IN ('timeline.preview.render', 'export.render', 'quality.check')
          )
        )
        AND (
          status IN ('queued', 'running', 'waiting_provider')
          OR COALESCE(json_extract(progress_detail_json, '$.stale'), 0) <> 1
        )
      `,
      voiceProfileRevisionId,
      now,
      characterDatabaseId,
      characterDatabaseId,
      episodeId,
      ).changes
      const dialogueLines = sql.run(`
        UPDATE dialogue_lines SET
          speech_asset_id = NULL,
          voice_id = NULL,
          duration_seconds = NULL,
          updated_at = ?
         WHERE character_id = ?
           AND (speech_asset_id IS NOT NULL OR voice_id IS NOT NULL OR duration_seconds IS NOT NULL)
      `, now, characterDatabaseId).changes
      const exports = sql.run(`
        UPDATE exports SET status = 'stale', updated_at = ?
         WHERE episode_id = ? AND status <> 'stale'
      `, now, episodeId).changes
      const qualityReports = sql.run(`
        UPDATE quality_reports SET status = 'stale', passed = 0
         WHERE episode_id = ? AND status <> 'stale'
      `, episodeId).changes
      const pipelineRuns = sql.run(`
        UPDATE pipeline_runs SET status = 'stale', updated_at = ?, completed_at = ?
         WHERE episode_id = ? AND status <> 'stale'
      `, now, now, episodeId).changes
      return {
        speechAssets,
        exportAssets,
        jobs,
        dialogueLines,
        exports,
        qualityReports,
        pipelineRuns,
        activeJobIds,
      }
    })
  }
}
