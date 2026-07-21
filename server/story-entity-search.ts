import type { ManjuDatabase } from './database.js'

export const STORY_ENTITY_SEARCH_LIMITS = Object.freeze({
  queryCodePoints: 100,
  defaultPageSize: 20,
  maxPageSize: 100,
  maxOffset: 10_000,
})

export type StoryEntityType =
  | 'scene'
  | 'shot'
  | 'dialogue'
  | 'character'
  | 'location'
  | 'prop'

export interface StoryEntitySearchResult {
  entityId: string
  type: StoryEntityType
  title: string
  snippet: string
  sceneId: string | null
  shotId: string | null
  sourceRevisionId: string
}

export interface StoryEntitySearchPage {
  episodeId: string
  projectId: string
  sourceRevisionId: string
  query: string
  limit: number
  offset: number
  total: number
  hasMore: boolean
  results: StoryEntitySearchResult[]
}

export interface StoryEntitySearchScope {
  episodeId: string
  projectId: string
  sourceRevisionId: string
}

export interface StoryEntitySearchInput {
  query: string
  limit: number
  offset: number
}

type SqlRow = Record<string, unknown>

const ENTITY_TYPES = new Set<StoryEntityType>([
  'scene',
  'shot',
  'dialogue',
  'character',
  'location',
  'prop',
])

/*
 * The normalized Story tables are the current Episode projection. `scope`
 * additionally pins every query to the Episode's current immutable Story
 * revision, while the shot/dialogue branches assert that same revision on the
 * persisted shot row. No historical revision snapshot participates here.
 */
const CANDIDATES_SQL = `
WITH scope AS (
  SELECT id AS episode_id, project_id, source_revision_id
  FROM episodes
  WHERE id = ? AND project_id = ? AND source_revision_id = ?
), candidates AS (
  SELECT
    COALESCE(NULLIF(json_extract(scenes.metadata_json, '$.storyId'), ''), scenes.id) AS entity_id,
    'scene' AS entity_type,
    scenes.title AS title,
    trim(
      scenes.description || ' · '
      || COALESCE(json_extract(scenes.metadata_json, '$.timeOfDay'), '') || ' · '
      || COALESCE(locations.name, '')
    ) AS snippet_source,
    scenes.title || ' ' || scenes.description || ' '
      || COALESCE(json_extract(scenes.metadata_json, '$.timeOfDay'), '') || ' '
      || COALESCE(locations.name, '') AS search_text,
    COALESCE(NULLIF(json_extract(scenes.metadata_json, '$.storyId'), ''), scenes.id) AS scene_id,
    NULL AS shot_id,
    scenes.sequence AS scene_sequence,
    -1 AS shot_sequence,
    -1 AS line_sequence,
    3 AS type_order
  FROM scope
  JOIN scenes ON scenes.episode_id = scope.episode_id
  LEFT JOIN locations
    ON locations.episode_id = scope.episode_id
   AND locations.project_id = scope.project_id
   AND json_extract(locations.metadata_json, '$.storyId')
       = json_extract(scenes.metadata_json, '$.locationId')

  UNION ALL

  SELECT
    COALESCE(NULLIF(json_extract(shots.metadata_json, '$.storyId'), ''), shots.id),
    'shot',
    CASE WHEN length(trim(shots.title)) > 0 THEN shots.title ELSE shots.code END,
    trim(
      shots.code || ' · ' || shots.description || ' · ' || shots.framing || ' · '
      || shots.movement || ' · ' || shots.transition || ' · ' || shots.prompt
    ),
    shots.code || ' ' || shots.title || ' ' || shots.description || ' '
      || shots.framing || ' ' || shots.movement || ' ' || shots.transition || ' '
      || shots.prompt,
    COALESCE(NULLIF(json_extract(scenes.metadata_json, '$.storyId'), ''), scenes.id),
    COALESCE(NULLIF(json_extract(shots.metadata_json, '$.storyId'), ''), shots.id),
    scenes.sequence,
    shots.sequence,
    -1,
    4
  FROM scope
  JOIN scenes ON scenes.episode_id = scope.episode_id
  JOIN shots
    ON shots.scene_id = scenes.id
   AND shots.source_revision_id = scope.source_revision_id

  UNION ALL

  SELECT
    COALESCE(NULLIF(json_extract(dialogue_lines.metadata_json, '$.storyId'), ''), dialogue_lines.id),
    'dialogue',
    COALESCE(
      NULLIF(trim(json_extract(dialogue_lines.metadata_json, '$.speaker')), ''),
      NULLIF(trim(characters.name), ''),
      '旁白'
    ),
    dialogue_lines.text,
    COALESCE(json_extract(dialogue_lines.metadata_json, '$.speaker'), '') || ' '
      || COALESCE(characters.name, '') || ' ' || dialogue_lines.text,
    COALESCE(NULLIF(json_extract(scenes.metadata_json, '$.storyId'), ''), scenes.id),
    COALESCE(NULLIF(json_extract(shots.metadata_json, '$.storyId'), ''), shots.id),
    scenes.sequence,
    shots.sequence,
    dialogue_lines.sequence,
    5
  FROM scope
  JOIN scenes ON scenes.episode_id = scope.episode_id
  JOIN shots
    ON shots.scene_id = scenes.id
   AND shots.source_revision_id = scope.source_revision_id
  JOIN dialogue_lines ON dialogue_lines.shot_id = shots.id
  LEFT JOIN characters
    ON characters.id = dialogue_lines.character_id
   AND characters.episode_id = scope.episode_id
   AND characters.project_id = scope.project_id

  UNION ALL

  SELECT
    COALESCE(NULLIF(json_extract(characters.metadata_json, '$.storyId'), ''), characters.id),
    'character',
    characters.name,
    trim(
      COALESCE(json_extract(characters.metadata_json, '$.role'), '') || ' · '
      || characters.story_description || ' · ' || characters.visual_description
    ),
    characters.name || ' ' || COALESCE(json_extract(characters.metadata_json, '$.role'), '')
      || ' ' || characters.story_description || ' ' || characters.visual_description,
    NULL,
    NULL,
    2147483647,
    CAST(COALESCE(json_extract(characters.metadata_json, '$.sequence'), 0) AS INTEGER),
    -1,
    0
  FROM scope
  JOIN characters
    ON characters.episode_id = scope.episode_id
   AND characters.project_id = scope.project_id

  UNION ALL

  SELECT
    COALESCE(NULLIF(json_extract(locations.metadata_json, '$.storyId'), ''), locations.id),
    'location',
    locations.name,
    trim(locations.story_description || ' · ' || locations.visual_description),
    locations.name || ' ' || locations.story_description || ' ' || locations.visual_description,
    NULL,
    NULL,
    2147483647,
    CAST(COALESCE(json_extract(locations.metadata_json, '$.sequence'), 0) AS INTEGER),
    -1,
    1
  FROM scope
  JOIN locations
    ON locations.episode_id = scope.episode_id
   AND locations.project_id = scope.project_id

  UNION ALL

  SELECT
    COALESCE(NULLIF(json_extract(props.metadata_json, '$.storyId'), ''), props.id),
    'prop',
    props.name,
    trim(props.story_description || ' · ' || props.visual_description),
    props.name || ' ' || props.story_description || ' ' || props.visual_description,
    NULL,
    NULL,
    2147483647,
    CAST(COALESCE(json_extract(props.metadata_json, '$.sequence'), 0) AS INTEGER),
    -1,
    2
  FROM scope
  JOIN props
    ON props.episode_id = scope.episode_id
   AND props.project_id = scope.project_id
)
`

function requiredString(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string' || !value) {
    throw new Error(`Story entity search column ${column} is not non-empty text`)
  }
  return value
}

function nullableString(row: SqlRow, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !value) {
    throw new Error(`Story entity search column ${column} is not nullable text`)
  }
  return value
}

function nonNegativeInteger(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Story entity search column ${column} is not a non-negative integer`)
  }
  return value
}

function entityType(value: unknown): StoryEntityType {
  if (typeof value !== 'string' || !ENTITY_TYPES.has(value as StoryEntityType)) {
    throw new Error('Story entity search returned an unsupported entity type')
  }
  return value as StoryEntityType
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function compactText(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(/(?:\s*·\s*)+/gu, ' · ').replace(/(?: · )+$/u, '').trim()
}

function snippet(source: string, fallback: string, query: string, maximum = 220): string {
  const compact = compactText(source) || fallback
  const characters = Array.from(compact)
  if (characters.length <= maximum) return compact

  const matchIndex = compact.toLocaleLowerCase('zh-CN')
    .indexOf(query.toLocaleLowerCase('zh-CN'))
  const matchCharacterIndex = matchIndex < 0
    ? 0
    : Array.from(compact.slice(0, matchIndex)).length
  const start = Math.max(0, matchCharacterIndex - 60)
  const end = Math.min(characters.length, start + maximum)
  return `${start > 0 ? '…' : ''}${characters.slice(start, end).join('')}${end < characters.length ? '…' : ''}`
}

/**
 * Search only the current, relational SQLite projection of one Episode Story.
 * The caller supplies a scope captured from the same database transaction.
 */
export function searchCurrentStoryEntities(
  database: ManjuDatabase,
  scope: StoryEntitySearchScope,
  input: StoryEntitySearchInput,
): StoryEntitySearchPage {
  const escaped = escapeLike(input.query)
  const contains = `%${escaped}%`
  const prefix = `${escaped}%`
  const scopeBindings = [scope.episodeId, scope.projectId, scope.sourceRevisionId] as const

  return database.withSql((sql) => {
    const countRow = sql.get(`
      ${CANDIDATES_SQL}
      SELECT COUNT(*) AS total
      FROM candidates
      WHERE search_text LIKE ? ESCAPE '\\'
    `, ...scopeBindings, contains)
    const total = countRow ? nonNegativeInteger(countRow, 'total') : 0

    const rows = sql.all(`
      ${CANDIDATES_SQL}
      SELECT entity_id, entity_type, title, snippet_source, scene_id, shot_id
      FROM candidates
      WHERE search_text LIKE ? ESCAPE '\\'
      ORDER BY
        CASE
          WHEN title = ? COLLATE NOCASE THEN 0
          WHEN title LIKE ? ESCAPE '\\' THEN 1
          WHEN title LIKE ? ESCAPE '\\' THEN 2
          ELSE 3
        END,
        scene_sequence,
        shot_sequence,
        line_sequence,
        type_order,
        entity_id
      LIMIT ? OFFSET ?
    `,
    ...scopeBindings,
    contains,
    input.query,
    prefix,
    contains,
    input.limit,
    input.offset,
    )

    const results = rows.map((row): StoryEntitySearchResult => {
      const title = requiredString(row, 'title')
      const source = typeof row.snippet_source === 'string' ? row.snippet_source : ''
      return {
        entityId: requiredString(row, 'entity_id'),
        type: entityType(row.entity_type),
        title,
        snippet: snippet(source, title, input.query),
        sceneId: nullableString(row, 'scene_id'),
        shotId: nullableString(row, 'shot_id'),
        sourceRevisionId: scope.sourceRevisionId,
      }
    })

    return {
      episodeId: scope.episodeId,
      projectId: scope.projectId,
      sourceRevisionId: scope.sourceRevisionId,
      query: input.query,
      limit: input.limit,
      offset: input.offset,
      total,
      hasMore: input.offset + results.length < total,
      results,
    }
  })
}
