import { createHash, randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'

import type {
  DatabaseSqlAccess,
  ManjuDatabase,
  RevisionRecord,
} from './database.js'
import {
  parseStoryDocument,
  parseStoryCharacterVoiceProfile,
  StoryValidationError,
  type StoryDocument,
  type StoryScene,
  type StoryShot,
} from './story-schema.js'
import type { JsonObject } from './types.js'

export interface EpisodeRecord {
  id: string
  projectId: string
  title: string
  sourceText: string
  targetDurationSeconds: number | null
  aspectRatio: string
  stylePreset: string
  status: string
  sortOrder: number
  metadata: JsonObject
  sourceRevisionId: string | null
  createdAt: string
  updatedAt: string
}

export interface EnsureEpisodeInput {
  id?: string
  title?: string
  sourceText?: string
  targetDurationSeconds?: number | null
  aspectRatio?: string
  stylePreset?: string
  status?: string
  sortOrder?: number
}

export interface StoryStaleResult {
  assets: number
  jobs: number
  exports: number
  qualityReports: number
  pipelineRuns: number
}

export interface RenderSettingsPatch {
  aspectRatio?: string
  stylePreset?: string
}

export interface UpdateRenderSettingsResult {
  episode: EpisodeRecord
  changed: boolean
  stale: StoryStaleResult
}

export interface ApplyStoryResult {
  episode: EpisodeRecord
  story: StoryDocument
  revision: RevisionRecord
  stale: StoryStaleResult
}

export type StoryScenePatch = Partial<Pick<
  StoryScene,
  'title' | 'locationId' | 'timeOfDay' | 'description'
>>

export type StoryShotPatch = Partial<Pick<
  StoryShot,
  | 'code'
  | 'title'
  | 'description'
  | 'framing'
  | 'movement'
  | 'transition'
  | 'durationSeconds'
  | 'visualPrompt'
  | 'dialogueLines'
>>

export interface StoryEditOptions {
  expectedRevisionId?: string | null
  summary?: string
}

export interface StoryShotEditOptions extends StoryEditOptions {
  /** Required only when two scenes intentionally reuse the same external shot ID. */
  sceneId?: string
}

export type StoryShotCreateInput = Omit<StoryShot, 'sequence'>

export interface StoryShotCreateOptions extends StoryEditOptions {
  /** Zero-based insertion point. Omit to append to the scene. */
  index?: number
}

export type StoryRepositoryErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'EPISODE_NOT_FOUND'
  | 'REVISION_NOT_FOUND'
  | 'REVISION_PROJECT_MISMATCH'
  | 'REVISION_EPISODE_MISMATCH'
  | 'REVISION_NOT_STORY'
  | 'REVISION_CONFLICT'
  | 'STORY_NOT_FOUND'
  | 'SCENE_NOT_FOUND'
  | 'SHOT_NOT_FOUND'
  | 'SHOT_ALREADY_EXISTS'
  | 'SHOT_LIMIT_EXCEEDED'
  | 'SHOT_LIMIT_UNDERRUN'
  | 'INVALID_SHOT_ORDER'
  | 'AMBIGUOUS_SHOT_ID'
  | 'CORRUPT_STORY'

export class StoryRepositoryError extends Error {
  constructor(readonly code: StoryRepositoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StoryRepositoryError'
  }
}

const DOWNSTREAM_ASSET_KINDS = [
  'storyboard',
  'shot.storyboard',
  'storyboard.image',
  'keyframe',
  'video',
  'shot.video',
  'speech',
  'dialogue.speech',
  'tts',
  'voice',
  'subtitle',
  'captions',
  'preview',
  'timeline.preview',
  'export',
  'episode.export',
  'final.video',
] as const

const DOWNSTREAM_JOB_TYPES = [
  'shot.storyboard.generate',
  'shot.video.generate',
  'dialogue.speech.generate',
  'timeline.preview.render',
  'export.render',
  'quality.check',
] as const

const RENDER_SETTINGS_ASSET_KINDS = [
  'storyboard',
  'shot.storyboard',
  'storyboard.image',
  'keyframe',
  'video',
  'shot.video',
  'preview',
  'timeline.preview',
  'export',
  'episode.export',
  'final.video',
] as const

const RENDER_SETTINGS_JOB_TYPES = [
  'shot.storyboard.generate',
  'shot.video.generate',
  'video.generate',
  'timeline.preview.render',
  'export.render',
  'quality.check',
] as const

const STORYBOARD_IMAGE_JOB_TYPES = ['asset.image.generate', 'image.generate'] as const

const STORYBOARD_IMAGE_KINDS = [
  'storyboard',
  'shot.storyboard',
  'storyboard.image',
  'keyframe',
] as const

const EMPTY_STALE_RESULT: StoryStaleResult = Object.freeze({
  assets: 0,
  jobs: 0,
  exports: 0,
  qualityReports: 0,
  pipelineRuns: 0,
})

type SqlRow = Record<string, unknown>

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

/** Keep the HTTP episode version strictly monotonic across same-tick writes. */
function nextEpisodeUpdatedAt(previous: string): string {
  const previousMs = Date.parse(previous)
  return new Date(Math.max(
    Date.now(),
    Number.isFinite(previousMs) ? previousMs + 1 : 0,
  )).toISOString()
}

function requiredNumber(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value !== 'number') throw new Error(`Database column ${column} is not numeric`)
  return value
}

function nullableNumber(row: SqlRow, column: string): number | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== 'number') throw new Error(`Database column ${column} is not nullable numeric`)
  return value
}

function parseJsonObject(value: unknown, column: string): JsonObject {
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not JSON text`)
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Database column ${column} is not a JSON object`)
  }
  return parsed as JsonObject
}

function asEpisode(row: SqlRow): EpisodeRecord {
  return {
    id: requiredString(row, 'id'),
    projectId: requiredString(row, 'project_id'),
    title: requiredString(row, 'title'),
    sourceText: requiredString(row, 'source_text'),
    targetDurationSeconds: nullableNumber(row, 'target_duration_seconds'),
    aspectRatio: requiredString(row, 'aspect_ratio'),
    stylePreset: requiredString(row, 'style_preset'),
    status: requiredString(row, 'status'),
    sortOrder: requiredNumber(row, 'sort_order'),
    metadata: parseJsonObject(row.metadata_json, 'metadata_json'),
    sourceRevisionId: nullableString(row, 'source_revision_id'),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
  }
}

function asStoryRevision(row: SqlRow): RevisionRecord {
  return {
    id: requiredString(row, 'id'),
    projectId: requiredString(row, 'project_id'),
    parentRevisionId: nullableString(row, 'parent_revision_id'),
    summary: requiredString(row, 'summary'),
    snapshot: parseJsonObject(row.snapshot_json, 'snapshot_json'),
    createdAt: requiredString(row, 'created_at'),
  }
}

function storyId(metadata: JsonObject, fallback: string): string {
  return typeof metadata.storyId === 'string' && metadata.storyId ? metadata.storyId : fallback
}

function metadataString(metadata: JsonObject, key: string, fallback = ''): string {
  const value = metadata[key]
  return typeof value === 'string' ? value : fallback
}

function domainId(kind: string, ...parts: string[]): string {
  const hash = createHash('sha256').update([kind, ...parts].join('\0')).digest('hex').slice(0, 40)
  return `story-${kind}-${hash}`
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function deleteMissing(
  sql: DatabaseSqlAccess,
  table: 'characters' | 'locations' | 'props',
  episodeId: string,
  ids: readonly string[],
): void {
  if (ids.length === 0) {
    sql.run(`DELETE FROM ${table} WHERE episode_id = ?`, episodeId)
    return
  }
  sql.run(
    `DELETE FROM ${table} WHERE episode_id = ? AND id NOT IN (${placeholders(ids)})`,
    episodeId,
    ...ids,
  )
}

function cleanPatch<T extends object>(patch: T): T {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as T
}

function storySnapshot(story: StoryDocument): JsonObject {
  return structuredClone(story) as unknown as JsonObject
}

/**
 * Persists the validated story as normalized relational entities. External
 * StoryDocument IDs stay stable in metadata while database IDs are namespaced,
 * so two episodes can safely use conventional IDs such as `scene-1`/`shot-1`.
 */
export class StoryRepository {
  constructor(private readonly database: ManjuDatabase) {}

  /**
   * Returns only revisions explicitly scoped to this episode. Project-wide
   * revision history also contains voice, provider, asset, and other episodes'
   * snapshots and must never be used as a Story restore picker.
   */
  listStoryRevisions(episodeId: string, limit = 100): RevisionRecord[] {
    const episode = this.requireEpisode(episodeId)
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500)
    return this.database.withSql((sql) => sql.all(`
      SELECT revisions.*
      FROM story_revision_scopes
      JOIN revisions ON revisions.id = story_revision_scopes.revision_id
      WHERE story_revision_scopes.episode_id = ?
        AND story_revision_scopes.project_id = ?
      ORDER BY story_revision_scopes.created_at DESC,
               story_revision_scopes.revision_id DESC
      LIMIT ?
    `, episode.id, episode.projectId, safeLimit).map(asStoryRevision))
  }

  private storyRevisionScope(revisionId: string): {
    projectId: string
    episodeId: string
  } | null {
    return this.database.withSql((sql) => {
      const row = sql.get(`
        SELECT project_id, episode_id
        FROM story_revision_scopes
        WHERE revision_id = ?
      `, revisionId)
      return row ? {
        projectId: requiredString(row, 'project_id'),
        episodeId: requiredString(row, 'episode_id'),
      } : null
    })
  }

  private bindStoryRevision(episode: EpisodeRecord, revision: RevisionRecord): void {
    const existing = this.storyRevisionScope(revision.id)
    if (existing) {
      if (existing.projectId !== episode.projectId || existing.episodeId !== episode.id) {
        throw new StoryRepositoryError(
          'REVISION_EPISODE_MISMATCH',
          `Story revision ${revision.id} belongs to episode ${existing.episodeId}`,
        )
      }
      return
    }
    this.database.withSql((sql) => sql.run(`
      INSERT INTO story_revision_scopes (
        revision_id, project_id, episode_id, created_at
      ) VALUES (?, ?, ?, ?)
    `, revision.id, episode.projectId, episode.id, revision.createdAt))
  }

  ensureEpisode(projectId: string, input: EnsureEpisodeInput = {}): EpisodeRecord {
    return this.database.transaction(() => {
      const project = this.database.getProject(projectId)
      if (!project) {
        throw new StoryRepositoryError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`)
      }

      const existing = this.database.withSql((sql) => {
        if (input.id) return sql.get('SELECT * FROM episodes WHERE id = ?', input.id)
        if (project.currentEpisodeId) {
          const current = sql.get('SELECT * FROM episodes WHERE id = ?', project.currentEpisodeId)
          if (current) return current
        }
        return sql.get(`
          SELECT * FROM episodes WHERE project_id = ? ORDER BY sort_order, id LIMIT 1
        `, projectId)
      })
      if (existing) {
        const episode = asEpisode(existing)
        if (episode.projectId !== projectId) {
          throw new StoryRepositoryError(
            'EPISODE_NOT_FOUND',
            `Episode ${episode.id} does not belong to project ${projectId}`,
          )
        }
        const fields: string[] = []
        const bindings: SQLInputValue[] = []
        const set = (column: string, value: SQLInputValue | undefined): void => {
          if (value === undefined) return
          fields.push(`${column} = ?`)
          bindings.push(value)
        }
        set('title', input.title?.trim())
        set('source_text', input.sourceText)
        set('target_duration_seconds', input.targetDurationSeconds)
        set('aspect_ratio', input.aspectRatio)
        set('style_preset', input.stylePreset)
        set('status', input.status)
        set('sort_order', input.sortOrder)
        if (fields.length > 0) {
          fields.push('updated_at = ?')
          bindings.push(nextEpisodeUpdatedAt(episode.updatedAt), episode.id)
          this.database.withSql((sql) => sql.run(
            `UPDATE episodes SET ${fields.join(', ')} WHERE id = ?`,
            ...bindings,
          ))
        }
        if (project.currentEpisodeId !== episode.id) {
          this.database.updateProject(projectId, { currentEpisodeId: episode.id })
        }
        return this.requireEpisode(episode.id)
      }

      const now = new Date().toISOString()
      const id = input.id ?? randomUUID()
      const sortOrder = input.sortOrder ?? this.database.withSql((sql) => {
        const row = sql.get(`
          SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
          FROM episodes WHERE project_id = ?
        `, projectId)
        return row ? requiredNumber(row, 'next_sort_order') : 0
      })
      this.database.withSql((sql) => sql.run(`
        INSERT INTO episodes (
          id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
          style_preset, status, sort_order, metadata_json, source_revision_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', NULL, ?, ?)
      `,
      id,
      projectId,
      input.title?.trim() || `第 ${sortOrder + 1} 集`,
      input.sourceText ?? '',
      input.targetDurationSeconds ?? null,
      input.aspectRatio ?? '16:9',
      input.stylePreset ?? '',
      input.status ?? 'draft',
      sortOrder,
      now,
      now,
      ))
      this.database.updateProject(projectId, { currentEpisodeId: id })
      return this.requireEpisode(id)
    })
  }

  /**
   * Updates render-only episode settings without creating or moving an
   * immutable Story revision. A real value change invalidates only the visual
   * and render chain that consumed those settings; uploaded audio and locked
   * character/location/prop references remain reusable.
   */
  updateRenderSettings(
    episodeId: string,
    patch: RenderSettingsPatch,
  ): UpdateRenderSettingsResult {
    return this.database.transaction(() => {
      const current = this.requireEpisode(episodeId)
      const aspectChanged = patch.aspectRatio !== undefined
        && patch.aspectRatio !== current.aspectRatio
      const styleChanged = patch.stylePreset !== undefined
        && patch.stylePreset !== current.stylePreset
      if (!aspectChanged && !styleChanged) {
        return {
          episode: current,
          changed: false,
          stale: { ...EMPTY_STALE_RESULT },
        }
      }

      const fields: string[] = []
      const bindings: SQLInputValue[] = []
      if (aspectChanged) {
        fields.push('aspect_ratio = ?')
        bindings.push(patch.aspectRatio!)
      }
      if (styleChanged) {
        fields.push('style_preset = ?')
        bindings.push(patch.stylePreset!)
      }
      const now = nextEpisodeUpdatedAt(current.updatedAt)
      fields.push('updated_at = ?')
      bindings.push(now, current.id)
      const changed = this.database.withSql((sql) => sql.run(
        `UPDATE episodes SET ${fields.join(', ')} WHERE id = ?`,
        ...bindings,
      )).changes
      if (changed !== 1) {
        throw new StoryRepositoryError('EPISODE_NOT_FOUND', `Episode not found: ${episodeId}`)
      }

      return {
        episode: this.requireEpisode(episodeId),
        changed: true,
        stale: this.markRenderSettingsDownstreamStale(
          episodeId,
          current.sourceRevisionId,
          now,
        ),
      }
    })
  }

  getEpisode(episodeId: string): EpisodeRecord | undefined {
    const row = this.database.withSql((sql) => sql.get('SELECT * FROM episodes WHERE id = ?', episodeId))
    return row ? asEpisode(row) : undefined
  }

  /**
   * Catalog read for one project. This deliberately does not mutate
   * projects.current_episode_id: browsing the global project/episode tree is
   * independent from the Episode currently opened in the production console.
   */
  listEpisodes(projectId: string): EpisodeRecord[] {
    if (!this.database.getProject(projectId)) {
      throw new StoryRepositoryError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`)
    }
    return this.database.withSql((sql) => sql.all(`
      SELECT * FROM episodes
      WHERE project_id = ?
      ORDER BY sort_order ASC, created_at ASC, id ASC
    `, projectId)).map(asEpisode)
  }

  getStory(episodeId: string): StoryDocument | undefined {
    const episode = this.getEpisode(episodeId)
    if (!episode) return undefined
    if (episode.metadata.storyVersion !== 1) return undefined

    try {
      return this.database.withSql((sql) => {
        const characters = sql.all(`
          SELECT * FROM characters WHERE episode_id = ?
          ORDER BY CAST(json_extract(metadata_json, '$.sequence') AS INTEGER), created_at, id
        `, episodeId).map((row) => {
          const metadata = parseJsonObject(row.metadata_json, 'characters.metadata_json')
          return {
            id: storyId(metadata, requiredString(row, 'id')),
            name: requiredString(row, 'name'),
            role: metadataString(metadata, 'role'),
            storyDescription: requiredString(row, 'story_description'),
            visualDescription: requiredString(row, 'visual_description'),
            ...(metadata.voiceProfile === undefined
              ? {}
              : { voiceProfile: parseStoryCharacterVoiceProfile(metadata.voiceProfile) }),
          }
        })
        const locations = sql.all(`
          SELECT * FROM locations WHERE episode_id = ?
          ORDER BY CAST(json_extract(metadata_json, '$.sequence') AS INTEGER), created_at, id
        `, episodeId).map((row) => {
          const metadata = parseJsonObject(row.metadata_json, 'locations.metadata_json')
          return {
            id: storyId(metadata, requiredString(row, 'id')),
            name: requiredString(row, 'name'),
            storyDescription: requiredString(row, 'story_description'),
            visualDescription: requiredString(row, 'visual_description'),
          }
        })
        const props = sql.all(`
          SELECT * FROM props WHERE episode_id = ?
          ORDER BY CAST(json_extract(metadata_json, '$.sequence') AS INTEGER), created_at, id
        `, episodeId).map((row) => {
          const metadata = parseJsonObject(row.metadata_json, 'props.metadata_json')
          return {
            id: storyId(metadata, requiredString(row, 'id')),
            name: requiredString(row, 'name'),
            description: requiredString(row, 'story_description'),
            visualDescription: requiredString(row, 'visual_description'),
          }
        })

        const scenes = sql.all(`
          SELECT * FROM scenes WHERE episode_id = ? ORDER BY sequence, id
        `, episodeId).map((sceneRow) => {
          const sceneMetadata = parseJsonObject(sceneRow.metadata_json, 'scenes.metadata_json')
          const sceneDatabaseId = requiredString(sceneRow, 'id')
          const shots = sql.all(`
            SELECT * FROM shots WHERE scene_id = ? ORDER BY sequence, id
          `, sceneDatabaseId).map((shotRow) => {
            const shotMetadata = parseJsonObject(shotRow.metadata_json, 'shots.metadata_json')
            const shotDatabaseId = requiredString(shotRow, 'id')
            const dialogueLines = sql.all(`
              SELECT dialogue_lines.*, characters.name AS character_name
              FROM dialogue_lines
              LEFT JOIN characters ON characters.id = dialogue_lines.character_id
              WHERE dialogue_lines.shot_id = ?
              ORDER BY dialogue_lines.sequence, dialogue_lines.id
            `, shotDatabaseId).map((lineRow) => {
              const metadata = parseJsonObject(lineRow.metadata_json, 'dialogue_lines.metadata_json')
              return {
                id: storyId(metadata, requiredString(lineRow, 'id')),
                sequence: requiredNumber(lineRow, 'sequence'),
                kind: requiredString(lineRow, 'kind'),
                speaker: metadataString(
                  metadata,
                  'speaker',
                  nullableString(lineRow, 'character_name') ?? '',
                ),
                text: requiredString(lineRow, 'text'),
              }
            })
            return {
              id: storyId(shotMetadata, shotDatabaseId),
              sequence: requiredNumber(shotRow, 'sequence'),
              code: requiredString(shotRow, 'code'),
              title: requiredString(shotRow, 'title'),
              description: requiredString(shotRow, 'description'),
              framing: requiredString(shotRow, 'framing'),
              movement: requiredString(shotRow, 'movement'),
              transition: requiredString(shotRow, 'transition'),
              durationSeconds: requiredNumber(shotRow, 'duration_seconds'),
              visualPrompt: requiredString(shotRow, 'prompt'),
              dialogueLines,
            }
          })
          return {
            id: storyId(sceneMetadata, sceneDatabaseId),
            sequence: requiredNumber(sceneRow, 'sequence'),
            title: requiredString(sceneRow, 'title'),
            locationId: metadataString(sceneMetadata, 'locationId'),
            timeOfDay: metadataString(sceneMetadata, 'timeOfDay'),
            description: requiredString(sceneRow, 'description'),
            shots,
          }
        })

        const bibleValue = episode.metadata.bible
        const bible = bibleValue && typeof bibleValue === 'object' && !Array.isArray(bibleValue)
          ? bibleValue
          : {}
        return parseStoryDocument({
          version: 1,
          title: episode.title,
          targetDurationSeconds: episode.targetDurationSeconds,
          bible,
          characters,
          locations,
          props,
          scenes,
        })
      })
    } catch (error) {
      if (error instanceof StoryRepositoryError) throw error
      throw new StoryRepositoryError(
        'CORRUPT_STORY',
        `Persisted story for episode ${episodeId} is inconsistent`,
        { cause: error },
      )
    }
  }

  applyStory(
    episodeId: string,
    storyValue: StoryDocument,
    sourceRevisionId?: string | null,
  ): ApplyStoryResult {
    const story = parseStoryDocument(storyValue)
    return this.database.transaction(() => {
      const currentEpisode = this.requireEpisode(episodeId)
      const project = this.database.getProject(currentEpisode.projectId)
      if (!project) {
        throw new StoryRepositoryError('PROJECT_NOT_FOUND', `Project not found: ${currentEpisode.projectId}`)
      }

      let revision: RevisionRecord
      if (sourceRevisionId) {
        const sourceRevision = this.database.getRevision(sourceRevisionId)
        if (!sourceRevision) {
          throw new StoryRepositoryError('REVISION_NOT_FOUND', `Revision not found: ${sourceRevisionId}`)
        }
        if (sourceRevision.projectId !== currentEpisode.projectId) {
          throw new StoryRepositoryError(
            'REVISION_PROJECT_MISMATCH',
            `Revision ${sourceRevisionId} does not belong to project ${currentEpisode.projectId}`,
          )
        }

        let sourceStory: StoryDocument
        try {
          sourceStory = parseStoryDocument(sourceRevision.snapshot)
        } catch (error) {
          throw new StoryRepositoryError(
            'REVISION_NOT_STORY',
            `Revision ${sourceRevisionId} does not contain a valid StoryDocument`,
            { cause: error },
          )
        }
        if (!isDeepStrictEqual(sourceStory, story)) {
          throw new StoryRepositoryError(
            'REVISION_NOT_STORY',
            `Revision ${sourceRevisionId} snapshot does not match the StoryDocument being applied`,
          )
        }
        revision = sourceRevision
      } else {
        revision = this.database.createRevision({
          projectId: currentEpisode.projectId,
          parentRevisionId: project.currentRevisionId,
          summary: '保存结构化剧本',
          snapshot: storySnapshot(story),
        })
      }

      // The revision is now proven to contain this validated StoryDocument.
      // Scope it before mutating the normalized graph; the surrounding
      // transaction rolls the binding back with every other side effect.
      this.bindStoryRevision(currentEpisode, revision)

      const stale = this.markDownstreamStale(episodeId, revision.id)
      this.persistStoryGraph(currentEpisode, story, revision.id)
      const updatedProject = this.database.updateProject(currentEpisode.projectId, {
        title: story.title,
        currentEpisodeId: episodeId,
        currentRevisionId: revision.id,
      })
      if (!updatedProject) {
        throw new StoryRepositoryError('PROJECT_NOT_FOUND', `Project not found: ${currentEpisode.projectId}`)
      }
      return {
        episode: this.requireEpisode(episodeId),
        story: this.requireStory(episodeId),
        revision,
        stale,
      }
    })
  }

  /**
   * Restores an immutable StoryDocument revision into the normalized episode
   * graph. The selected historical revision is never made mutable or reused as
   * the head: restoration creates a new auditable revision and invalidates all
   * downstream media exactly like a normal story edit.
   */
  restoreStoryRevision(
    episodeId: string,
    revisionId: string,
    options: StoryEditOptions = {},
  ): ApplyStoryResult {
    const episode = this.requireEpisode(episodeId)
    const revision = this.database.getRevision(revisionId)
    if (!revision) {
      throw new StoryRepositoryError('REVISION_NOT_FOUND', `Revision not found: ${revisionId}`)
    }
    if (revision.projectId !== episode.projectId) {
      throw new StoryRepositoryError(
        'REVISION_PROJECT_MISMATCH',
        `Revision ${revisionId} does not belong to project ${episode.projectId}`,
      )
    }
    let story: StoryDocument
    try {
      story = parseStoryDocument(revision.snapshot)
    } catch (error) {
      throw new StoryRepositoryError(
        'REVISION_NOT_STORY',
        `Revision ${revisionId} is not a structured story revision`,
        { cause: error },
      )
    }
    const scope = this.storyRevisionScope(revisionId)
    if (!scope || scope.episodeId !== episode.id || scope.projectId !== episode.projectId) {
      throw new StoryRepositoryError(
        'REVISION_EPISODE_MISMATCH',
        `Story revision ${revisionId} is not scoped to episode ${episode.id}`,
      )
    }
    return this.commitEdit(episodeId, story, {
      expectedRevisionId: options.expectedRevisionId,
      summary: options.summary?.trim().slice(0, 500) || `恢复剧本版本 ${revisionId}`,
    })
  }

  updateScene(
    episodeId: string,
    sceneId: string,
    patch: StoryScenePatch,
    options: StoryEditOptions = {},
  ): ApplyStoryResult {
    const observedRevisionId = this.requireEpisode(episodeId).sourceRevisionId
    const story = structuredClone(this.requireStory(episodeId))
    const scene = story.scenes.find((candidate) => candidate.id === sceneId)
    if (!scene) throw new StoryRepositoryError('SCENE_NOT_FOUND', `Scene not found: ${sceneId}`)
    Object.assign(scene, cleanPatch(patch))
    scene.id = sceneId
    return this.commitEdit(episodeId, story, {
      ...options,
      expectedRevisionId: options.expectedRevisionId === undefined
        ? observedRevisionId
        : options.expectedRevisionId,
      summary: options.summary ?? `编辑场景 ${scene.title}`,
    })
  }

  updateShot(
    episodeId: string,
    shotId: string,
    patch: StoryShotPatch,
    options: StoryShotEditOptions = {},
  ): ApplyStoryResult {
    const observedRevisionId = this.requireEpisode(episodeId).sourceRevisionId
    const story = structuredClone(this.requireStory(episodeId))
    const matches = story.scenes.flatMap((scene) => scene.shots
      .filter((shot) => shot.id === shotId && (!options.sceneId || scene.id === options.sceneId))
      .map((shot) => ({ scene, shot })))
    if (matches.length === 0) throw new StoryRepositoryError('SHOT_NOT_FOUND', `Shot not found: ${shotId}`)
    if (matches.length > 1) {
      throw new StoryRepositoryError(
        'AMBIGUOUS_SHOT_ID',
        `Shot ID ${shotId} is used in more than one scene; provide sceneId`,
      )
    }
    const { shot } = matches[0]
    Object.assign(shot, cleanPatch(patch))
    shot.id = shotId
    return this.commitEdit(episodeId, story, {
      ...options,
      expectedRevisionId: options.expectedRevisionId === undefined
        ? observedRevisionId
        : options.expectedRevisionId,
      summary: options.summary ?? `编辑镜头 ${shot.code || shot.title}`,
    })
  }

  createShot(
    episodeId: string,
    sceneId: string,
    input: StoryShotCreateInput,
    options: StoryShotCreateOptions = {},
  ): ApplyStoryResult {
    const observedRevisionId = this.requireEpisode(episodeId).sourceRevisionId
    const story = structuredClone(this.requireStory(episodeId))
    const scene = story.scenes.find((candidate) => candidate.id === sceneId)
    if (!scene) throw new StoryRepositoryError('SCENE_NOT_FOUND', `Scene not found: ${sceneId}`)
    const shotCount = story.scenes.reduce((total, candidate) => total + candidate.shots.length, 0)
    if (shotCount >= 12) {
      throw new StoryRepositoryError('SHOT_LIMIT_EXCEEDED', 'A story cannot contain more than 12 shots')
    }
    if (story.scenes.some((candidate) => candidate.shots.some((shot) => shot.id === input.id))) {
      throw new StoryRepositoryError(
        'SHOT_ALREADY_EXISTS',
        `Shot ID already exists in this story: ${input.id}`,
      )
    }
    const index = options.index ?? scene.shots.length
    if (!Number.isInteger(index) || index < 0 || index > scene.shots.length) {
      throw new StoryRepositoryError(
        'INVALID_SHOT_ORDER',
        `Shot insertion index must be between 0 and ${scene.shots.length}`,
      )
    }
    scene.shots.splice(index, 0, { ...structuredClone(input), sequence: index })
    scene.shots.forEach((shot, sequence) => {
      shot.sequence = sequence
    })
    return this.commitEdit(episodeId, story, {
      ...options,
      expectedRevisionId: options.expectedRevisionId === undefined
        ? observedRevisionId
        : options.expectedRevisionId,
      summary: options.summary ?? `新增镜头 ${input.code || input.title}`,
    })
  }

  deleteShot(
    episodeId: string,
    shotId: string,
    options: StoryShotEditOptions = {},
  ): ApplyStoryResult {
    const observedRevisionId = this.requireEpisode(episodeId).sourceRevisionId
    const story = structuredClone(this.requireStory(episodeId))
    const matches = story.scenes.flatMap((scene) => scene.shots
      .map((shot, index) => ({ scene, shot, index }))
      .filter(({ shot }) => shot.id === shotId && (!options.sceneId || scene.id === options.sceneId)))
    if (matches.length === 0) throw new StoryRepositoryError('SHOT_NOT_FOUND', `Shot not found: ${shotId}`)
    if (matches.length > 1) {
      throw new StoryRepositoryError(
        'AMBIGUOUS_SHOT_ID',
        `Shot ID ${shotId} is used in more than one scene; provide sceneId`,
      )
    }
    const shotCount = story.scenes.reduce((total, candidate) => total + candidate.shots.length, 0)
    if (shotCount <= 6) {
      throw new StoryRepositoryError('SHOT_LIMIT_UNDERRUN', 'A story must retain at least 6 shots')
    }
    const { scene, shot, index } = matches[0]
    scene.shots.splice(index, 1)
    scene.shots.forEach((candidate, sequence) => {
      candidate.sequence = sequence
    })
    return this.commitEdit(episodeId, story, {
      ...options,
      expectedRevisionId: options.expectedRevisionId === undefined
        ? observedRevisionId
        : options.expectedRevisionId,
      summary: options.summary ?? `删除镜头 ${shot.code || shot.title}`,
    })
  }

  /**
   * Reorders every shot in one scene. Cross-scene moves are deliberately not
   * part of the MVP: `shotIds` must be an exact permutation of that scene.
   */
  reorderShots(
    episodeId: string,
    sceneId: string,
    shotIds: readonly string[],
    options: StoryEditOptions = {},
  ): ApplyStoryResult {
    const observedRevisionId = this.requireEpisode(episodeId).sourceRevisionId
    const story = structuredClone(this.requireStory(episodeId))
    const scene = story.scenes.find((candidate) => candidate.id === sceneId)
    if (!scene) throw new StoryRepositoryError('SCENE_NOT_FOUND', `Scene not found: ${sceneId}`)
    const existingIds = scene.shots.map((shot) => shot.id)
    const suppliedIds = [...shotIds]
    if (
      suppliedIds.length !== existingIds.length
      || new Set(suppliedIds).size !== suppliedIds.length
      || suppliedIds.some((shotId) => !existingIds.includes(shotId))
    ) {
      throw new StoryRepositoryError(
        'INVALID_SHOT_ORDER',
        'Shot order must contain every shot in the selected scene exactly once',
      )
    }
    const expectedRevisionId = options.expectedRevisionId === undefined
      ? observedRevisionId
      : options.expectedRevisionId
    if (suppliedIds.every((shotId, index) => shotId === existingIds[index])) {
      return this.currentStoryResult(episodeId, expectedRevisionId)
    }
    const shotsById = new Map(scene.shots.map((shot) => [shot.id, shot]))
    scene.shots = suppliedIds.map((shotId, sequence) => ({
      ...shotsById.get(shotId)!,
      sequence,
    }))
    return this.commitEdit(episodeId, story, {
      ...options,
      expectedRevisionId,
      summary: options.summary ?? `调整场景 ${scene.title} 的镜头顺序`,
    })
  }

  private currentStoryResult(
    episodeId: string,
    expectedRevisionId: string | null,
  ): ApplyStoryResult {
    const episode = this.requireEpisode(episodeId)
    if (episode.sourceRevisionId !== expectedRevisionId) {
      throw new StoryRepositoryError(
        'REVISION_CONFLICT',
        `Story changed from revision ${expectedRevisionId ?? 'none'} to ${episode.sourceRevisionId ?? 'none'}`,
      )
    }
    if (!episode.sourceRevisionId) {
      throw new StoryRepositoryError('CORRUPT_STORY', `Story revision is missing for episode ${episodeId}`)
    }
    const revision = this.database.getRevision(episode.sourceRevisionId)
    if (!revision) {
      throw new StoryRepositoryError(
        'CORRUPT_STORY',
        `Story revision ${episode.sourceRevisionId} is missing`,
      )
    }
    return {
      episode,
      story: this.requireStory(episodeId),
      revision,
      stale: { assets: 0, jobs: 0, exports: 0, qualityReports: 0, pipelineRuns: 0 },
    }
  }

  private commitEdit(
    episodeId: string,
    storyValue: StoryDocument,
    options: StoryEditOptions,
  ): ApplyStoryResult {
    const story = parseStoryDocument(storyValue)
    const expectedRevisionId = options.expectedRevisionId === undefined
      ? this.requireEpisode(episodeId).sourceRevisionId
      : options.expectedRevisionId
    return this.database.transaction(() => {
      const currentEpisode = this.requireEpisode(episodeId)
      if (currentEpisode.sourceRevisionId !== expectedRevisionId) {
        throw new StoryRepositoryError(
          'REVISION_CONFLICT',
          `Story changed from revision ${expectedRevisionId ?? 'none'} to ${currentEpisode.sourceRevisionId ?? 'none'}`,
        )
      }
      const project = this.database.getProject(currentEpisode.projectId)
      if (!project) {
        throw new StoryRepositoryError('PROJECT_NOT_FOUND', `Project not found: ${currentEpisode.projectId}`)
      }
      const revision = this.database.createRevision({
        projectId: currentEpisode.projectId,
        parentRevisionId: project.currentRevisionId,
        summary: options.summary?.trim().slice(0, 500) || '编辑剧本',
        snapshot: storySnapshot(story),
      })
      return this.applyStory(episodeId, story, revision.id)
    })
  }

  private persistStoryGraph(
    episode: EpisodeRecord,
    story: StoryDocument,
    sourceRevisionId: string,
  ): void {
    const now = nextEpisodeUpdatedAt(episode.updatedAt)
    this.database.withSql((sql) => {
      const episodeMetadata: JsonObject = {
        ...episode.metadata,
        storyVersion: 1,
        bible: structuredClone(story.bible) as unknown as JsonObject,
      }
      sql.run(`
        UPDATE episodes SET
          title = ?, target_duration_seconds = ?, metadata_json = ?, source_revision_id = ?,
          status = 'draft', updated_at = ?
        WHERE id = ?
      `, story.title, story.targetDurationSeconds, JSON.stringify(episodeMetadata), sourceRevisionId, now, episode.id)

      // Scene deletion cascades through shots and dialogue. Generated media are
      // retained separately and were marked stale before this replacement.
      sql.run('DELETE FROM scenes WHERE episode_id = ?', episode.id)

      const characterIds = story.characters.map((character) => domainId('character', episode.id, character.id))
      story.characters.forEach((character, sequence) => {
        const id = characterIds[sequence]
        const existingRow = sql.get('SELECT metadata_json FROM characters WHERE id = ?', id)
        const existingMetadata = existingRow
          ? parseJsonObject(existingRow.metadata_json, 'characters.metadata_json')
          : undefined
        // Voice casting has its own immutable audit revision and optimistic
        // Episode write. Preserve that profile across story regeneration and
        // restore rather than allowing generated Story JSON to overwrite it.
        const voiceProfile = existingMetadata?.voiceProfile === undefined
          ? undefined
          : parseStoryCharacterVoiceProfile(existingMetadata.voiceProfile)
        const voiceProfileRevisionId = typeof existingMetadata?.voiceProfileRevisionId === 'string'
          ? existingMetadata.voiceProfileRevisionId
          : undefined
        const metadata = JSON.stringify({
          storyId: character.id,
          sequence,
          role: character.role,
          ...(voiceProfile && voiceProfileRevisionId
            ? { voiceProfile, voiceProfileRevisionId }
            : {}),
        })
        sql.run(`
          INSERT INTO characters (
            id, project_id, episode_id, name, story_description, visual_description,
            version, metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            episode_id = excluded.episode_id,
            name = excluded.name,
            story_description = excluded.story_description,
            visual_description = excluded.visual_description,
            version = CASE WHEN
              characters.name <> excluded.name OR
              characters.story_description <> excluded.story_description OR
              characters.visual_description <> excluded.visual_description OR
              characters.metadata_json <> excluded.metadata_json
            THEN characters.version + 1 ELSE characters.version END,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `,
        id,
        episode.projectId,
        episode.id,
        character.name,
        character.storyDescription,
        character.visualDescription,
        metadata,
        now,
        now,
        )
      })
      deleteMissing(sql, 'characters', episode.id, characterIds)

      const locationIds = story.locations.map((location) => domainId('location', episode.id, location.id))
      story.locations.forEach((location, sequence) => {
        const id = locationIds[sequence]
        const metadata = JSON.stringify({ storyId: location.id, sequence })
        sql.run(`
          INSERT INTO locations (
            id, project_id, episode_id, name, story_description, visual_description,
            version, metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            episode_id = excluded.episode_id,
            name = excluded.name,
            story_description = excluded.story_description,
            visual_description = excluded.visual_description,
            version = CASE WHEN
              locations.name <> excluded.name OR
              locations.story_description <> excluded.story_description OR
              locations.visual_description <> excluded.visual_description OR
              locations.metadata_json <> excluded.metadata_json
            THEN locations.version + 1 ELSE locations.version END,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `,
        id,
        episode.projectId,
        episode.id,
        location.name,
        location.storyDescription,
        location.visualDescription,
        metadata,
        now,
        now,
        )
      })
      deleteMissing(sql, 'locations', episode.id, locationIds)

      const propIds = story.props.map((prop) => domainId('prop', episode.id, prop.id))
      story.props.forEach((prop, sequence) => {
        const id = propIds[sequence]
        const metadata = JSON.stringify({ storyId: prop.id, sequence })
        sql.run(`
          INSERT INTO props (
            id, project_id, episode_id, name, story_description, visual_description,
            version, metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            episode_id = excluded.episode_id,
            name = excluded.name,
            story_description = excluded.story_description,
            visual_description = excluded.visual_description,
            version = CASE WHEN
              props.name <> excluded.name OR
              props.story_description <> excluded.story_description OR
              props.visual_description <> excluded.visual_description OR
              props.metadata_json <> excluded.metadata_json
            THEN props.version + 1 ELSE props.version END,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `,
        id,
        episode.projectId,
        episode.id,
        prop.name,
        prop.description,
        prop.visualDescription,
        metadata,
        now,
        now,
        )
      })
      deleteMissing(sql, 'props', episode.id, propIds)

      const characterIdsByName = new Map<string, string[]>()
      story.characters.forEach((character, index) => {
        const ids = characterIdsByName.get(character.name) ?? []
        ids.push(characterIds[index])
        characterIdsByName.set(character.name, ids)
      })

      let timelineStart = 0
      for (const scene of story.scenes) {
        const sceneDatabaseId = domainId('scene', episode.id, scene.id)
        const sceneDuration = scene.shots.reduce((total, shot) => total + shot.durationSeconds, 0)
        sql.run(`
          INSERT INTO scenes (
            id, episode_id, sequence, title, description, duration_seconds,
            metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        sceneDatabaseId,
        episode.id,
        scene.sequence,
        scene.title,
        scene.description,
        sceneDuration,
        JSON.stringify({ storyId: scene.id, locationId: scene.locationId, timeOfDay: scene.timeOfDay }),
        now,
        now,
        )
        for (const shot of scene.shots) {
          const shotDatabaseId = domainId('shot', episode.id, scene.id, shot.id)
          sql.run(`
            INSERT INTO shots (
              id, scene_id, sequence, code, title, description, framing, movement,
              transition, duration_seconds, timeline_start_seconds, prompt, status,
              source_revision_id, metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
          `,
          shotDatabaseId,
          sceneDatabaseId,
          shot.sequence,
          shot.code,
          shot.title,
          shot.description,
          shot.framing,
          shot.movement,
          shot.transition,
          shot.durationSeconds,
          timelineStart,
          shot.visualPrompt,
          sourceRevisionId,
          JSON.stringify({ storyId: shot.id }),
          now,
          now,
          )
          timelineStart += shot.durationSeconds
          for (const line of shot.dialogueLines) {
            const lineDatabaseId = domainId('dialogue', episode.id, scene.id, shot.id, line.id)
            const matchingCharacterIds = characterIdsByName.get(line.speaker) ?? []
            const characterId = line.kind === 'dialogue' && matchingCharacterIds.length === 1
              ? matchingCharacterIds[0]
              : null
            sql.run(`
              INSERT INTO dialogue_lines (
                id, shot_id, character_id, sequence, kind, text, metadata_json,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            lineDatabaseId,
            shotDatabaseId,
            characterId,
            line.sequence,
            line.kind,
            line.text,
            JSON.stringify({ storyId: line.id, speaker: line.speaker }),
            now,
            now,
            )
          }
        }
      }
    })
  }

  private markRenderSettingsDownstreamStale(
    episodeId: string,
    sourceRevisionId: string | null,
    now: string,
  ): StoryStaleResult {
    return this.database.withSql((sql) => {
      const assets = sql.run(`
        UPDATE media_assets
        SET status = 'stale', updated_at = ?
        WHERE status <> 'stale'
          AND (
            (
              episode_id = ?
              AND lower(kind) IN (${placeholders(RENDER_SETTINGS_ASSET_KINDS)})
            )
            OR id IN (
              SELECT shots.storyboard_asset_id
              FROM shots
              JOIN scenes ON scenes.id = shots.scene_id
              WHERE scenes.episode_id = ? AND shots.storyboard_asset_id IS NOT NULL
              UNION
              SELECT shots.video_asset_id
              FROM shots
              JOIN scenes ON scenes.id = shots.scene_id
              WHERE scenes.episode_id = ? AND shots.video_asset_id IS NOT NULL
              UNION
              SELECT exports.output_asset_id
              FROM exports
              WHERE exports.episode_id = ? AND exports.output_asset_id IS NOT NULL
            )
            OR generation_job_id IN (
              SELECT generation_jobs.id
              FROM generation_jobs
              WHERE (
                  generation_jobs.episode_id = ?
                  OR (
                    generation_jobs.resource_type IN ('episode', 'episodes')
                    AND generation_jobs.resource_id = ?
                  )
                  OR generation_jobs.pipeline_run_id IN (
                    SELECT pipeline_runs.id FROM pipeline_runs
                    WHERE pipeline_runs.episode_id = ?
                  )
                  OR generation_jobs.resource_id IN (
                    SELECT scenes.id FROM scenes WHERE scenes.episode_id = ?
                    UNION
                    SELECT json_extract(scenes.metadata_json, '$.storyId')
                    FROM scenes WHERE scenes.episode_id = ?
                    UNION
                    SELECT shots.id
                    FROM shots JOIN scenes ON scenes.id = shots.scene_id
                    WHERE scenes.episode_id = ?
                    UNION
                    SELECT json_extract(shots.metadata_json, '$.storyId')
                    FROM shots JOIN scenes ON scenes.id = shots.scene_id
                    WHERE scenes.episode_id = ?
                    UNION
                    SELECT exports.id FROM exports WHERE exports.episode_id = ?
                    UNION
                    SELECT quality_reports.id FROM quality_reports
                    WHERE quality_reports.episode_id = ?
                  )
                )
                AND (
                  generation_jobs.type IN (${placeholders(RENDER_SETTINGS_JOB_TYPES)})
                  OR (
                    generation_jobs.type IN (${placeholders(STORYBOARD_IMAGE_JOB_TYPES)})
                    AND lower(json_extract(generation_jobs.input_json, '$.metadata.kind'))
                      IN (${placeholders(STORYBOARD_IMAGE_KINDS)})
                  )
                )
            )
          )
      `,
      now,
      episodeId,
      ...RENDER_SETTINGS_ASSET_KINDS,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      ...RENDER_SETTINGS_JOB_TYPES,
      ...STORYBOARD_IMAGE_JOB_TYPES,
      ...STORYBOARD_IMAGE_KINDS,
      ).changes

      const jobs = sql.run(`
        UPDATE generation_jobs
        SET
          status = CASE
            WHEN status IN ('queued', 'running', 'waiting_provider') THEN 'cancelled'
            ELSE status
          END,
          progress_detail_json = json_set(
            progress_detail_json,
            '$.stale', json('true'),
            '$.staleReason', 'render_settings_changed',
            '$.staleRevisionId', ?
          ),
          error_json = CASE
            WHEN status IN ('queued', 'running', 'waiting_provider') THEN json_object(
              'code', 'STALE_RENDER_SETTINGS',
              'message', '画面风格或画幅已修改，任务结果已过期',
              'retryable', json('false'),
              'category', 'cancelled'
            )
            ELSE error_json
          END,
          completed_at = CASE
            WHEN status IN ('queued', 'running', 'waiting_provider') THEN ?
            ELSE completed_at
          END,
          updated_at = ?
        WHERE (
            episode_id = ?
            OR (resource_type IN ('episode', 'episodes') AND resource_id = ?)
            OR pipeline_run_id IN (
              SELECT pipeline_runs.id FROM pipeline_runs WHERE pipeline_runs.episode_id = ?
            )
            OR resource_id IN (
              SELECT scenes.id FROM scenes WHERE scenes.episode_id = ?
              UNION
              SELECT json_extract(scenes.metadata_json, '$.storyId')
              FROM scenes WHERE scenes.episode_id = ?
              UNION
              SELECT shots.id
              FROM shots JOIN scenes ON scenes.id = shots.scene_id
              WHERE scenes.episode_id = ?
              UNION
              SELECT json_extract(shots.metadata_json, '$.storyId')
              FROM shots JOIN scenes ON scenes.id = shots.scene_id
              WHERE scenes.episode_id = ?
              UNION
              SELECT exports.id FROM exports WHERE exports.episode_id = ?
              UNION
              SELECT quality_reports.id FROM quality_reports
              WHERE quality_reports.episode_id = ?
            )
          )
          AND (
            type IN (${placeholders(RENDER_SETTINGS_JOB_TYPES)})
            OR (
              type IN (${placeholders(STORYBOARD_IMAGE_JOB_TYPES)})
              AND lower(json_extract(input_json, '$.metadata.kind'))
                IN (${placeholders(STORYBOARD_IMAGE_KINDS)})
            )
          )
          AND (
            status IN ('queued', 'running', 'waiting_provider')
            OR COALESCE(json_extract(progress_detail_json, '$.stale'), 0) <> 1
          )
      `,
      sourceRevisionId,
      now,
      now,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      ...RENDER_SETTINGS_JOB_TYPES,
      ...STORYBOARD_IMAGE_JOB_TYPES,
      ...STORYBOARD_IMAGE_KINDS,
      ).changes

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
      return { assets, jobs, exports, qualityReports, pipelineRuns }
    })
  }

  private markDownstreamStale(episodeId: string, sourceRevisionId: string): StoryStaleResult {
    const now = new Date().toISOString()
    return this.database.withSql((sql) => {
      const assetsByKind = sql.run(`
        UPDATE media_assets SET status = 'stale', updated_at = ?
        WHERE episode_id = ?
          AND lower(kind) IN (${placeholders(DOWNSTREAM_ASSET_KINDS)})
          AND status <> 'stale'
      `, now, episodeId, ...DOWNSTREAM_ASSET_KINDS).changes
      const linkedAssets = sql.run(`
        UPDATE media_assets SET status = 'stale', updated_at = ?
        WHERE id IN (
          SELECT shots.storyboard_asset_id
          FROM shots JOIN scenes ON scenes.id = shots.scene_id
          WHERE scenes.episode_id = ? AND shots.storyboard_asset_id IS NOT NULL
          UNION
          SELECT shots.video_asset_id
          FROM shots JOIN scenes ON scenes.id = shots.scene_id
          WHERE scenes.episode_id = ? AND shots.video_asset_id IS NOT NULL
          UNION
          SELECT dialogue_lines.speech_asset_id
          FROM dialogue_lines
          JOIN shots ON shots.id = dialogue_lines.shot_id
          JOIN scenes ON scenes.id = shots.scene_id
          WHERE scenes.episode_id = ? AND dialogue_lines.speech_asset_id IS NOT NULL
        ) AND status <> 'stale'
      `, now, episodeId, episodeId, episodeId).changes
      const exportAssets = sql.run(`
        UPDATE media_assets SET status = 'stale', updated_at = ?
        WHERE id IN (
          SELECT output_asset_id FROM exports
          WHERE episode_id = ? AND output_asset_id IS NOT NULL
        ) AND status <> 'stale'
      `, now, episodeId).changes
      const jobs = sql.run(`
        UPDATE generation_jobs SET
          status = CASE
            WHEN status IN ('queued', 'running', 'waiting_provider') THEN 'cancelled'
            ELSE status
          END,
          progress_detail_json = json_set(
            progress_detail_json,
            '$.stale', json('true'),
            '$.staleReason', 'source_revision_changed',
            '$.staleRevisionId', ?
          ),
          error_json = CASE
            WHEN status IN ('queued', 'running', 'waiting_provider') THEN json_object(
              'code', 'STALE_SOURCE',
              'message', '源剧本已修改，任务结果已过期',
              'retryable', json('false'),
              'category', 'cancelled'
            )
            ELSE error_json
          END,
          completed_at = CASE
            WHEN status IN ('queued', 'running', 'waiting_provider') THEN ?
            ELSE completed_at
          END,
          updated_at = ?
        WHERE (
            episode_id = ?
            OR (resource_type IN ('episode', 'episodes') AND resource_id = ?)
            OR resource_id IN (
              SELECT scenes.id FROM scenes WHERE scenes.episode_id = ?
              UNION
              SELECT json_extract(scenes.metadata_json, '$.storyId')
              FROM scenes WHERE scenes.episode_id = ?
              UNION
              SELECT shots.id
              FROM shots JOIN scenes ON scenes.id = shots.scene_id
              WHERE scenes.episode_id = ?
              UNION
              SELECT json_extract(shots.metadata_json, '$.storyId')
              FROM shots JOIN scenes ON scenes.id = shots.scene_id
              WHERE scenes.episode_id = ?
              UNION
              SELECT dialogue_lines.id
              FROM dialogue_lines
              JOIN shots ON shots.id = dialogue_lines.shot_id
              JOIN scenes ON scenes.id = shots.scene_id
              WHERE scenes.episode_id = ?
              UNION
              SELECT json_extract(dialogue_lines.metadata_json, '$.storyId')
              FROM dialogue_lines
              JOIN shots ON shots.id = dialogue_lines.shot_id
              JOIN scenes ON scenes.id = shots.scene_id
              WHERE scenes.episode_id = ?
            )
          )
          AND type IN (${placeholders(DOWNSTREAM_JOB_TYPES)})
          AND COALESCE(json_extract(progress_detail_json, '$.stale'), 0) <> 1
      `,
      sourceRevisionId,
      now,
      now,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      episodeId,
      ...DOWNSTREAM_JOB_TYPES,
      ).changes
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
        assets: assetsByKind + linkedAssets + exportAssets,
        jobs,
        exports,
        qualityReports,
        pipelineRuns,
      }
    })
  }

  private requireEpisode(episodeId: string): EpisodeRecord {
    const episode = this.getEpisode(episodeId)
    if (!episode) {
      throw new StoryRepositoryError('EPISODE_NOT_FOUND', `Episode not found: ${episodeId}`)
    }
    return episode
  }

  private requireStory(episodeId: string): StoryDocument {
    const story = this.getStory(episodeId)
    if (!story) {
      throw new StoryRepositoryError('STORY_NOT_FOUND', `Story not found for episode: ${episodeId}`)
    }
    return story
  }
}

export { StoryRepository as SQLiteStoryRepository }
export { StoryValidationError }
