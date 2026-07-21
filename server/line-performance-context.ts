import { CharacterVoiceProfileRepository } from './character-voice-profiles.js'
import type { ManjuDatabase } from './database.js'
import {
  compileLinePerformance,
  LINE_PERFORMANCE_RECOMMENDATION_VERSION,
  type LinePerformanceRecommendationContext,
} from './line-performance.js'
import { ProjectNarratorVoiceProfileRepository } from './project-narrator-voice-profiles.js'

type SqlRow = Record<string, unknown>

export class LinePerformanceContextError extends Error {
  constructor(
    readonly code:
      | 'DIALOGUE_LINE_NOT_FOUND'
      | 'AMBIGUOUS_DIALOGUE_LINE_ID'
      | 'STORY_NOT_FOUND'
      | 'VOICE_PROFILE_REQUIRED'
      | 'STORY_GRAPH_INCONSISTENT',
    message: string,
  ) {
    super(message)
    this.name = 'LinePerformanceContextError'
  }
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new LinePerformanceContextError(
      'STORY_GRAPH_INCONSISTENT',
      `逐句表演上下文缺少 ${key}`,
    )
  }
  return value
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function storyId(metadataValue: unknown, fallback: string): string {
  const metadata = parseObject(metadataValue)
  return typeof metadata.storyId === 'string' && metadata.storyId.trim()
    ? metadata.storyId.trim()
    : fallback
}

function speaker(row: SqlRow): string {
  if (typeof row.character_name === 'string' && row.character_name.trim()) return row.character_name.trim()
  const metadata = parseObject(row.line_metadata_json)
  return typeof metadata.speaker === 'string' ? metadata.speaker.trim() : ''
}

export function resolveLinePerformanceRecommendationContext(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string; lineId: string },
): LinePerformanceRecommendationContext {
  const rows = database.withSql((sql) => sql.all(`
    SELECT dialogue_lines.id AS line_id,
           dialogue_lines.kind,
           dialogue_lines.text,
           dialogue_lines.metadata_json AS line_metadata_json,
           dialogue_lines.character_id,
           characters.name AS character_name,
           json_extract(characters.metadata_json, '$.role') AS character_role,
           characters.story_description AS character_story_description,
           characters.metadata_json AS character_metadata_json,
           shots.id AS shot_id,
           shots.description AS shot_description,
           scenes.id AS scene_id,
           scenes.title AS scene_title,
           scenes.description AS scene_description,
           scenes.metadata_json AS scene_metadata_json,
           episodes.source_revision_id
      FROM dialogue_lines
      JOIN shots ON shots.id = dialogue_lines.shot_id
      JOIN scenes ON scenes.id = shots.scene_id
      JOIN episodes ON episodes.id = scenes.episode_id
      LEFT JOIN characters ON characters.id = dialogue_lines.character_id
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
  if (rows.length === 0) {
    throw new LinePerformanceContextError('DIALOGUE_LINE_NOT_FOUND', '台词不存在或不属于指定分集')
  }
  if (rows.length > 1) {
    throw new LinePerformanceContextError('AMBIGUOUS_DIALOGUE_LINE_ID', '台词标识在分集中不唯一')
  }
  const row = rows[0]
  const sourceRevisionId = requiredString(row, 'source_revision_id')
  if (!sourceRevisionId.trim()) {
    throw new LinePerformanceContextError('STORY_NOT_FOUND', '分集尚未生成结构化剧本')
  }
  const kind = row.kind
  if (kind !== 'dialogue' && kind !== 'narration') {
    throw new LinePerformanceContextError('STORY_GRAPH_INCONSISTENT', '台词类型无效')
  }
  const databaseLineId = requiredString(row, 'line_id')
  const originalText = requiredString(row, 'text')
  // Reject reserved markup before the free LLM request rather than letting a
  // valid recommendation fail only during final compilation.
  compileLinePerformance(originalText, {
    version: LINE_PERFORMANCE_RECOMMENDATION_VERSION,
    lineId: input.lineId,
    emotion: 'calm',
    speed: 1,
    pitch: 0,
    pausePlan: [],
    rationale: '保持原句节奏。',
  })

  let performer: LinePerformanceRecommendationContext['performer']
  if (kind === 'dialogue') {
    const characterDatabaseId = requiredString(row, 'character_id')
    const characterId = storyId(row.character_metadata_json, characterDatabaseId)
    const record = new CharacterVoiceProfileRepository(database).get(
      input.projectId,
      input.episodeId,
      characterId,
    )
    if (!record) {
      throw new LinePerformanceContextError(
        'VOICE_PROFILE_REQUIRED',
        '请先为角色配置声线，再使用 AI 导演',
      )
    }
    performer = {
      scope: 'character',
      voiceProfileRevisionId: record.revisionId,
      name: record.characterName,
      role: requiredString(row, 'character_role'),
      storyDescription: requiredString(row, 'character_story_description'),
      voiceDescription: [
        record.profile.voiceName,
        ...record.profile.descriptions,
        ...(record.profile.profileTags ?? []),
      ].join('；'),
    }
  } else {
    const state = new ProjectNarratorVoiceProfileRepository(database).get(input.projectId)
    if (!state.profile || !state.revisionId) {
      throw new LinePerformanceContextError(
        'VOICE_PROFILE_REQUIRED',
        '请先配置项目旁白声线，再使用 AI 导演',
      )
    }
    performer = {
      scope: 'narrator',
      voiceProfileRevisionId: state.revisionId,
      name: '项目旁白',
      role: '旁白',
      storyDescription: '负责串联场景、节奏与叙事信息。',
      voiceDescription: [
        state.profile.voiceName,
        ...state.profile.descriptions,
        ...(state.profile.profileTags ?? []),
      ].join('；'),
    }
  }

  const sceneDatabaseId = requiredString(row, 'scene_id')
  const sceneMetadata = parseObject(row.scene_metadata_json)
  const allLines = database.withSql((sql) => sql.all(`
    SELECT dialogue_lines.id AS line_id,
           dialogue_lines.kind,
           dialogue_lines.text,
           dialogue_lines.metadata_json AS line_metadata_json,
           characters.name AS character_name
      FROM dialogue_lines
      JOIN shots ON shots.id = dialogue_lines.shot_id
      JOIN scenes ON scenes.id = shots.scene_id
      LEFT JOIN characters ON characters.id = dialogue_lines.character_id
     WHERE scenes.episode_id = ?
     ORDER BY scenes.sequence, shots.sequence, dialogue_lines.sequence, dialogue_lines.id
  `, input.episodeId))
  const index = allLines.findIndex((candidate) => candidate.line_id === databaseLineId)
  if (index < 0) {
    throw new LinePerformanceContextError('STORY_GRAPH_INCONSISTENT', '无法定位台词上下文')
  }
  const contextLines: LinePerformanceRecommendationContext['contextLines'] = []
  for (let offset = Math.max(0, index - 3); offset <= Math.min(allLines.length - 1, index + 3); offset += 1) {
    if (offset === index) continue
    const candidate = allLines[offset]
    if ((candidate.kind !== 'dialogue' && candidate.kind !== 'narration')
      || typeof candidate.text !== 'string') continue
    contextLines.push({
      relation: offset < index ? 'previous' : 'next',
      kind: candidate.kind,
      speaker: speaker(candidate),
      text: candidate.text,
    })
  }
  return {
    projectId: input.projectId,
    episodeId: input.episodeId,
    databaseLineId,
    lineId: input.lineId,
    sourceRevisionId,
    lineKind: kind,
    originalText,
    performer,
    scene: {
      id: storyId(row.scene_metadata_json, sceneDatabaseId),
      title: requiredString(row, 'scene_title'),
      timeOfDay: typeof sceneMetadata.timeOfDay === 'string' ? sceneMetadata.timeOfDay : '',
      description: requiredString(row, 'scene_description'),
      shotDescription: requiredString(row, 'shot_description'),
    },
    contextLines,
  }
}
