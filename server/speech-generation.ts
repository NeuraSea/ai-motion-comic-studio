import { isDeepStrictEqual } from 'node:util'

import { probeAudioDuration, type AudioDurationProbe } from './audio-duration.js'
import { CharacterVoiceProfileRepository } from './character-voice-profiles.js'
import { stableAssetIdForVersion } from './asset-identity.js'
import type { GenerationJobRecord, ManjuDatabase, MediaAssetRecord } from './database.js'
import { MediaStore } from './media.js'
import {
  compileLinePerformance,
  stripLinePerformanceMarkers,
} from './line-performance.js'
import { LinePerformanceProfileRepository } from './line-performance-profiles.js'
import {
  downloadMiniMaxSubtitle,
  type MiniMaxSubtitleLoader,
  type SpeechTimestampCue,
} from './minimax-subtitle.js'
import {
  MiniMaxSpeechError,
  MiniMaxSpeechProvider,
  SpeechProviderError,
  type MiniMaxAudioFormat,
  type MiniMaxLanguageBoost,
  type MiniMaxSpeechEmotion,
  type MiniMaxSpeechInput,
  type SpeechProvider,
} from './providers/minimax-tts.js'
import { OpenAICompatibleSpeechProvider } from './providers/openai-compatible-speech.js'
import { IndexTtsSpeechProvider } from './providers/indextts-speech.js'
import { DoubaoSpeechProvider } from './providers/doubao-speech.js'
import {
  ProjectNarratorVoiceProfileRepository,
  type ProjectNarratorVoiceProfileState,
} from './project-narrator-voice-profiles.js'
import {
  ProviderConfigurationError,
  ProviderService,
  type MaterializedProviderExecutionProfile,
} from './providers/service.js'
import type { JsonObject } from './types.js'
import { JobExecutionError, type JobHandler, type JobRecord } from './worker.js'
import {
  parseStoryCharacterVoiceProfile,
  type StoryCharacterVoiceProfile,
} from './story-schema.js'
import type { MiniMaxVoiceCatalogService } from './minimax-voice-catalog.js'
import type { IndexTtsVoiceCatalogService } from './indextts-voice-catalog.js'
import type { DoubaoVoiceCatalogService } from './doubao-voice-catalog.js'

export const DIALOGUE_SPEECH_GENERATION_JOB_TYPE = 'dialogue.speech.generate'

export const SPEECH_EMOTIONS = [
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'calm',
  'fluent',
  'whisper',
] as const satisfies readonly MiniMaxSpeechEmotion[]

export const SPEECH_SAMPLE_RATES = [8_000, 16_000, 22_050, 24_000, 32_000, 44_100] as const
export const SPEECH_BITRATES = [32_000, 64_000, 128_000, 256_000] as const
export const SPEECH_FORMATS = ['mp3', 'wav'] as const satisfies readonly MiniMaxAudioFormat[]

export interface DialogueSpeechSettings {
  voiceId: string
  speed: number
  volume: number
  pitch: number
  emotion?: MiniMaxSpeechEmotion
  format: (typeof SPEECH_FORMATS)[number]
  sampleRate: (typeof SPEECH_SAMPLE_RATES)[number]
  bitrate: (typeof SPEECH_BITRATES)[number]
  channels: 1 | 2
  languageBoost?: MiniMaxLanguageBoost
}

/** Durable and API-visible job input. Deliberately excludes dialogue text. */
export interface DialogueSpeechJobInput extends DialogueSpeechSettings {
  episodeId: string
  lineId: string
  databaseLineId: string
  expectedRevisionId: string | null
  /** Present only when voice/delivery inherited from an audited character profile. */
  inheritedVoiceProfileRevisionId?: string
  /** Present only when narration inherited from the audited project narrator profile. */
  inheritedNarratorVoiceProfileRevisionId?: string
  /** Confirmed immutable per-line performance binding and its exact compiled TTS text. */
  inheritedPerformanceRevisionId?: string
  compiledText?: string
}

export interface DialogueLineTarget {
  databaseLineId: string
  publicLineId: string
  projectId: string
  episodeId: string
  text: string
  sourceRevisionId: string | null
  kind: 'dialogue' | 'narration'
  sceneId: string
  characterId: string | null
  characterDatabaseId: string | null
  characterVoiceProfileRevisionId: string | null
  characterVoiceProfile: StoryCharacterVoiceProfile | null
  speechAssetId: string | null
}

export class DialogueSpeechError extends Error {
  constructor(
    readonly code:
      | 'DIALOGUE_LINE_NOT_FOUND'
      | 'AMBIGUOUS_DIALOGUE_LINE_ID'
      | 'INVALID_SPEECH_INPUT'
      | 'CHARACTER_VOICE_PROFILE_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'DialogueSpeechError'
  }
}

type SqlRow = Record<string, unknown>

function requiredString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Database column ${key} is not text`)
  return value
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Database column ${key} is not nullable text`)
  return value
}

function publicLineId(row: SqlRow): string {
  const metadataValue = row.line_metadata_json ?? row.metadata_json
  if (typeof metadataValue !== 'string') throw new Error('Database dialogue metadata is not JSON text')
  const metadata = JSON.parse(metadataValue) as unknown
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const storyId = (metadata as Record<string, unknown>).storyId
    if (typeof storyId === 'string' && storyId.trim()) return storyId
  }
  return requiredString(row, 'database_line_id')
}

function storyEntityId(metadataValue: unknown, fallback: string): string {
  if (typeof metadataValue !== 'string') return fallback
  const metadata = JSON.parse(metadataValue) as unknown
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).storyId
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return fallback
}

function characterVoice(row: SqlRow): {
  revisionId: string | null
  profile: StoryCharacterVoiceProfile | null
} {
  if (row.character_database_id === null || row.character_database_id === undefined) {
    return { revisionId: null, profile: null }
  }
  if (typeof row.character_metadata_json !== 'string') {
    throw new DialogueSpeechError(
      'CHARACTER_VOICE_PROFILE_INVALID',
      '角色声线绑定记录无效，请重新配置角色声线',
    )
  }
  let metadata: unknown
  try {
    metadata = JSON.parse(row.character_metadata_json)
  } catch {
    throw new DialogueSpeechError(
      'CHARACTER_VOICE_PROFILE_INVALID',
      '角色声线绑定记录无效，请重新配置角色声线',
    )
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new DialogueSpeechError(
      'CHARACTER_VOICE_PROFILE_INVALID',
      '角色声线绑定记录无效，请重新配置角色声线',
    )
  }
  const source = metadata as Record<string, unknown>
  if (source.voiceProfile === undefined && source.voiceProfileRevisionId === undefined) {
    return { revisionId: null, profile: null }
  }
  if (typeof source.voiceProfileRevisionId !== 'string') {
    throw new DialogueSpeechError(
      'CHARACTER_VOICE_PROFILE_INVALID',
      '角色声线绑定缺少审计版本，请重新配置角色声线',
    )
  }
  try {
    return {
      revisionId: source.voiceProfileRevisionId,
      profile: parseStoryCharacterVoiceProfile(source.voiceProfile),
    }
  } catch {
    throw new DialogueSpeechError(
      'CHARACTER_VOICE_PROFILE_INVALID',
      '角色声线绑定记录无效，请重新配置角色声线',
    )
  }
}

function targetFromRow(row: SqlRow): DialogueLineTarget {
  const voice = characterVoice(row)
  const kind = requiredString(row, 'line_kind')
  if (kind !== 'dialogue' && kind !== 'narration') {
    throw new DialogueSpeechError('INVALID_SPEECH_INPUT', '台词类型不支持语音生成')
  }
  const characterDatabaseId = nullableString(row, 'character_database_id')
  return {
    databaseLineId: requiredString(row, 'database_line_id'),
    publicLineId: publicLineId(row),
    projectId: requiredString(row, 'project_id'),
    episodeId: requiredString(row, 'episode_id'),
    text: requiredString(row, 'text'),
    sourceRevisionId: nullableString(row, 'source_revision_id'),
    kind,
    sceneId: storyEntityId(row.scene_metadata_json, requiredString(row, 'scene_database_id')),
    characterId: characterDatabaseId
      ? storyEntityId(row.character_metadata_json, characterDatabaseId)
      : null,
    characterDatabaseId,
    characterVoiceProfileRevisionId: voice.revisionId,
    characterVoiceProfile: voice.profile,
    speechAssetId: nullableString(row, 'speech_asset_id'),
  }
}

const TARGET_SELECT = `
  SELECT
    dialogue_lines.id AS database_line_id,
    dialogue_lines.text,
    dialogue_lines.kind AS line_kind,
    dialogue_lines.speech_asset_id,
    dialogue_lines.metadata_json AS line_metadata_json,
    dialogue_lines.character_id AS character_database_id,
    characters.metadata_json AS character_metadata_json,
    scenes.id AS scene_database_id,
    scenes.metadata_json AS scene_metadata_json,
    episodes.id AS episode_id,
    episodes.project_id,
    episodes.source_revision_id
  FROM dialogue_lines
  JOIN shots ON shots.id = dialogue_lines.shot_id
  JOIN scenes ON scenes.id = shots.scene_id
  JOIN episodes ON episodes.id = scenes.episode_id
  LEFT JOIN characters ON characters.id = dialogue_lines.character_id
`

export interface InheritedDialogueVoiceBinding {
  providerId: string
  providerConfigRevision: number
  voiceProfileRevisionId: string
  historicalPin: boolean
  settings: Pick<DialogueSpeechSettings, 'voiceId' | 'speed' | 'pitch' | 'emotion'>
}

/** Resolve a stable timbre plus optional per-scene performance direction. */
export function inheritedDialogueVoiceBinding(
  target: DialogueLineTarget,
): InheritedDialogueVoiceBinding | undefined {
  const profile = target.characterVoiceProfile
  const voiceProfileRevisionId = target.characterVoiceProfileRevisionId
  if (!profile || !voiceProfileRevisionId) return undefined
  const delivery = profile.sceneDirections?.find((direction) => direction.sceneId === target.sceneId)
    ?? profile.defaultDelivery
  return {
    providerId: profile.providerId,
    providerConfigRevision: profile.providerConfigRevision,
    voiceProfileRevisionId,
    historicalPin: profile.historicalPin,
    settings: {
      voiceId: profile.voiceId,
      speed: delivery?.speed ?? 1,
      pitch: delivery?.pitch ?? 0,
      ...(delivery?.emotion ? { emotion: delivery.emotion } : {}),
    },
  }
}

/** Resolve project-level narrator casting without ever borrowing a character voice. */
export function inheritedNarratorVoiceBinding(
  target: DialogueLineTarget,
  state: Pick<ProjectNarratorVoiceProfileState, 'revisionId' | 'profile'>,
): InheritedDialogueVoiceBinding | undefined {
  if (target.kind !== 'narration' || !state.profile || !state.revisionId) return undefined
  const direction = state.profile.sceneDirections?.find((item) => item.sceneId === target.sceneId)
  const delivery = direction ?? state.profile.defaultDelivery
  return {
    providerId: state.profile.providerId,
    providerConfigRevision: state.profile.providerConfigRevision,
    voiceProfileRevisionId: state.revisionId,
    historicalPin: state.profile.historicalPin,
    settings: {
      voiceId: state.profile.voiceId,
      speed: delivery?.speed ?? 1,
      pitch: delivery?.pitch ?? 0,
      ...(delivery?.emotion ? { emotion: delivery.emotion } : {}),
    },
  }
}

/** Resolve the external StoryDocument line ID only inside the requested owner scope. */
export function resolvePublicDialogueLine(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string; lineId: string },
): DialogueLineTarget {
  const rows = database.withSql((sql) => sql.all(`
    ${TARGET_SELECT}
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
    throw new DialogueSpeechError('DIALOGUE_LINE_NOT_FOUND', '台词不存在或不属于指定项目与分集')
  }
  if (rows.length > 1) {
    throw new DialogueSpeechError('AMBIGUOUS_DIALOGUE_LINE_ID', '该台词 ID 在分集中不唯一，无法安全生成语音')
  }
  return targetFromRow(rows[0])
}

function resolveDurableDialogueLine(
  database: ManjuDatabase,
  projectId: string,
  input: DialogueSpeechJobInput,
): DialogueLineTarget {
  const row = database.withSql((sql) => sql.get(`
    ${TARGET_SELECT}
    WHERE dialogue_lines.id = ?
      AND episodes.project_id = ?
      AND episodes.id = ?
  `, input.databaseLineId, projectId, input.episodeId))
  if (!row) {
    throw new JobExecutionError('DIALOGUE_LINE_NOT_FOUND', '待合成台词已不存在', false, 'validation')
  }
  const target = targetFromRow(row)
  if (target.publicLineId !== input.lineId) {
    throw new JobExecutionError('DIALOGUE_LINE_CHANGED', '待合成台词标识已改变', false, 'validation')
  }
  if (target.sourceRevisionId !== input.expectedRevisionId) {
    throw new JobExecutionError('STALE_SOURCE', '源剧本已修改，请基于最新台词重新生成语音', false, 'validation')
  }
  if (input.inheritedVoiceProfileRevisionId !== undefined
    && target.characterVoiceProfileRevisionId !== input.inheritedVoiceProfileRevisionId) {
    throw new JobExecutionError(
      'STALE_CHARACTER_VOICE',
      '角色声线已修改，请基于最新角色声线重新生成语音',
      false,
      'validation',
    )
  }
  if (input.inheritedVoiceProfileRevisionId !== undefined && target.kind !== 'dialogue') {
    throw new JobExecutionError(
      'VOICE_SCOPE_MISMATCH',
      '旁白不能继承角色声线',
      false,
      'validation',
    )
  }
  if (input.inheritedNarratorVoiceProfileRevisionId !== undefined && target.kind !== 'narration') {
    throw new JobExecutionError(
      'VOICE_SCOPE_MISMATCH',
      '角色对白不能继承项目旁白声线',
      false,
      'validation',
    )
  }
  if (!target.text.trim()) {
    throw new JobExecutionError('INVALID_SPEECH_INPUT', '待合成台词为空', false, 'validation')
  }
  return target
}

function speechExecutionError(error: SpeechProviderError): JobExecutionError {
  const category = error.code === 'PROVIDER_AUTH_FAILED'
    ? 'authentication'
    : error.code === 'CONTENT_REJECTED'
      ? 'content_policy'
      : error.code === 'PROVIDER_RATE_LIMITED'
        ? 'rate_limit'
        : error.code === 'UPSTREAM_TIMEOUT'
          ? 'timeout'
          : error.code === 'INVALID_INPUT' || error.code === 'AUDIO_TOO_LARGE'
            ? 'validation'
            : 'provider'
  return new JobExecutionError(error.code, error.message, error.retryable, category)
}

function validateJobInput(value: unknown): DialogueSpeechJobInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobExecutionError('INVALID_SPEECH_INPUT', '语音任务参数无效', false, 'validation')
  }
  const input = value as Partial<DialogueSpeechJobInput>
  if (
    typeof input.episodeId !== 'string'
    || typeof input.lineId !== 'string'
    || typeof input.databaseLineId !== 'string'
    || (input.expectedRevisionId !== null && typeof input.expectedRevisionId !== 'string')
    || (input.inheritedVoiceProfileRevisionId !== undefined
      && typeof input.inheritedVoiceProfileRevisionId !== 'string')
    || (input.inheritedNarratorVoiceProfileRevisionId !== undefined
      && typeof input.inheritedNarratorVoiceProfileRevisionId !== 'string')
    || (input.inheritedVoiceProfileRevisionId !== undefined
      && input.inheritedNarratorVoiceProfileRevisionId !== undefined)
    || (input.inheritedPerformanceRevisionId !== undefined
      && typeof input.inheritedPerformanceRevisionId !== 'string')
    || (input.compiledText !== undefined && typeof input.compiledText !== 'string')
    || ((input.inheritedPerformanceRevisionId === undefined) !== (input.compiledText === undefined))
    || typeof input.voiceId !== 'string'
    || !input.voiceId.trim()
    || typeof input.speed !== 'number' || !Number.isFinite(input.speed)
    || input.speed < 0.5 || input.speed > 2
    || typeof input.volume !== 'number' || !Number.isFinite(input.volume)
    || input.volume <= 0 || input.volume > 10
    || typeof input.pitch !== 'number' || !Number.isInteger(input.pitch)
    || input.pitch < -12 || input.pitch > 12
    || !SPEECH_FORMATS.includes(input.format as DialogueSpeechSettings['format'])
    || !SPEECH_SAMPLE_RATES.includes(input.sampleRate as DialogueSpeechSettings['sampleRate'])
    || !SPEECH_BITRATES.includes(input.bitrate as DialogueSpeechSettings['bitrate'])
    || (input.channels !== 1 && input.channels !== 2)
  ) {
    throw new JobExecutionError('INVALID_SPEECH_INPUT', '语音任务参数无效', false, 'validation')
  }
  return input as DialogueSpeechJobInput
}

function checkpointBlocksResubmission(job: JobRecord): boolean {
  if (!job.providerState || typeof job.providerState !== 'object' || Array.isArray(job.providerState)) return false
  const state = job.providerState as Record<string, unknown>
  return state.operation === 'dialogue.speech.generate'
    && (state.phase === 'submitting' || state.phase === 'response-received')
    && state.providerSupportsIdempotency !== true
}

function executionProvider(
  profile: MaterializedProviderExecutionProfile,
  injected?: SpeechProvider,
  compatibleFetch?: typeof fetch,
): SpeechProvider {
  if (profile.adapter === 'minimax') {
    if (injected) return injected
    return new MiniMaxSpeechProvider({
      name: profile.providerId,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      model: profile.model,
    })
  }
  if (profile.adapter === 'openai-compatible') {
    return new OpenAICompatibleSpeechProvider({
      name: profile.providerId,
      baseUrl: profile.baseUrl ?? '',
      apiKey: profile.apiKey,
      model: profile.model ?? '',
      ...(compatibleFetch ? { fetch: compatibleFetch } : {}),
    })
  }
  if (profile.adapter === 'indextts') {
    return new IndexTtsSpeechProvider({
      name: profile.providerId,
      baseUrl: profile.baseUrl ?? '',
      apiKey: profile.apiKey,
      model: profile.model ?? '',
      ...(compatibleFetch ? { fetch: compatibleFetch } : {}),
    })
  }
  if (profile.adapter === 'doubao-speech') {
    return new DoubaoSpeechProvider({
      name: profile.providerId,
      baseUrl: profile.baseUrl ?? '',
      apiKey: profile.apiKey,
      model: profile.model ?? '',
      ...(compatibleFetch ? { fetch: compatibleFetch } : {}),
    })
  }
  throw new JobExecutionError(
    'PROVIDER_ADAPTER_NOT_IMPLEMENTED',
    '该语音 Provider Adapter 尚未接入，未发起计费请求',
    false,
    'validation',
  )
}

export interface DialogueSpeechHandlerDependencies {
  database: ManjuDatabase
  mediaStore: MediaStore
  providerService: ProviderService
  characterVoiceProfiles?: Pick<CharacterVoiceProfileRepository, 'get'>
  narratorVoiceProfiles?: Pick<ProjectNarratorVoiceProfileRepository, 'get'>
  voiceCatalogService?: Pick<MiniMaxVoiceCatalogService, 'list'>
  indexTtsVoiceCatalogService?: Pick<IndexTtsVoiceCatalogService, 'list'>
  doubaoVoiceCatalogService?: Pick<DoubaoVoiceCatalogService, 'list'>
  linePerformanceProfiles?: Pick<LinePerformanceProfileRepository, 'get'>
  injectedProvider?: SpeechProvider
  openAICompatibleFetch?: typeof fetch
  audioDurationProbe?: AudioDurationProbe
  miniMaxSubtitleLoader?: MiniMaxSubtitleLoader
  publicAsset: (asset: MediaAssetRecord) => JsonObject
  publishAsset: (asset: MediaAssetRecord) => void
}

export function createDialogueSpeechGenerationHandler(
  dependencies: DialogueSpeechHandlerDependencies,
): JobHandler<DialogueSpeechJobInput, JsonObject> {
  return async (job, context) => {
    const input = validateJobInput(job.input)
    const durable = dependencies.database.getGenerationJob(job.id)
    if (!durable) throw new JobExecutionError('JOB_NOT_FOUND', '语音任务不存在', false, 'validation')
    const projectId = durable.projectId
    if (!durable.providerId || durable.providerConfigRevision === null || !durable.model) {
      throw new JobExecutionError('PROVIDER_NOT_CONFIGURED', '任务绑定的语音 Provider 不存在', false, 'validation')
    }
    if (checkpointBlocksResubmission(job)) {
      throw new JobExecutionError(
        'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
        '上次语音请求在服务中断前已提交，结果无法确认。为避免重复计费，系统没有自动重提；请核对 Provider 后手动重试。',
        false,
        'provider',
      )
    }

    const target = resolveDurableDialogueLine(dependencies.database, projectId, input)
    let inheritedProfile: StoryCharacterVoiceProfile | undefined
    let inheritedBinding: InheritedDialogueVoiceBinding | undefined
    if (input.inheritedVoiceProfileRevisionId !== undefined) {
      if (!target.characterId) {
        throw new JobExecutionError('STALE_CHARACTER_VOICE', '角色声线绑定已移除', false, 'validation')
      }
      let record
      try {
        record = (dependencies.characterVoiceProfiles
          ?? new CharacterVoiceProfileRepository(dependencies.database))
          .get(projectId, input.episodeId, target.characterId)
      } catch {
        throw new JobExecutionError('STALE_CHARACTER_VOICE', '角色声线审计记录不可用', false, 'validation')
      }
      if (!record || record.revisionId !== input.inheritedVoiceProfileRevisionId) {
        throw new JobExecutionError('STALE_CHARACTER_VOICE', '角色声线已修改', false, 'validation')
      }
      inheritedProfile = record.profile
      inheritedBinding = inheritedDialogueVoiceBinding(target)
    } else if (input.inheritedNarratorVoiceProfileRevisionId !== undefined) {
      let state
      try {
        state = (dependencies.narratorVoiceProfiles
          ?? new ProjectNarratorVoiceProfileRepository(dependencies.database)).get(projectId)
      } catch {
        throw new JobExecutionError('STALE_NARRATOR_VOICE', '项目旁白声线审计记录不可用', false, 'validation')
      }
      if (!state.profile || state.revisionId !== input.inheritedNarratorVoiceProfileRevisionId) {
        throw new JobExecutionError('STALE_NARRATOR_VOICE', '项目旁白声线已修改', false, 'validation')
      }
      inheritedProfile = state.profile
      inheritedBinding = inheritedNarratorVoiceBinding(target, state)
    }
    if (inheritedProfile && (!inheritedBinding
      || inheritedBinding.settings.voiceId !== input.voiceId
      || inheritedProfile.providerId !== durable.providerId
      || inheritedProfile.providerConfigRevision !== durable.providerConfigRevision)) {
      throw new JobExecutionError(
        'VOICE_BINDING_CONFLICT',
        '任务中的声线、Provider 或审计版本与当前继承配置不一致',
        false,
        'validation',
      )
    }
    let performanceProfile: ReturnType<LinePerformanceProfileRepository['get']>
    if (input.inheritedPerformanceRevisionId !== undefined) {
      try {
        performanceProfile = (dependencies.linePerformanceProfiles
          ?? new LinePerformanceProfileRepository(dependencies.database))
          .get(projectId, input.episodeId, input.lineId)
      } catch {
        throw new JobExecutionError(
          'STALE_LINE_PERFORMANCE',
          '逐句表演档案或其审计版本不可用',
          false,
          'validation',
        )
      }
      if (!performanceProfile
        || performanceProfile.revisionId !== input.inheritedPerformanceRevisionId
        || performanceProfile.databaseLineId !== input.databaseLineId
        || performanceProfile.sourceRevisionId !== input.expectedRevisionId) {
        throw new JobExecutionError(
          'STALE_LINE_PERFORMANCE',
          '逐句表演指令已修改，请基于最新建议重新生成语音',
          false,
          'validation',
        )
      }
      let compiled: string
      try {
        compiled = compileLinePerformance(target.text, performanceProfile)
      } catch {
        throw new JobExecutionError(
          'LINE_PERFORMANCE_MARKUP_INVALID',
          '逐句表演标记无法安全还原原台词，未发起语音合成',
          false,
          'validation',
        )
      }
      if (compiled !== input.compiledText
        || stripLinePerformanceMarkers(compiled) !== target.text
        || input.speed !== performanceProfile.speed
        || input.pitch !== performanceProfile.pitch
        || (input.emotion ?? null) !== performanceProfile.emotion) {
        throw new JobExecutionError(
          'LINE_PERFORMANCE_BINDING_CONFLICT',
          '语音任务中的表演参数或编译文本与确认版本不一致',
          false,
          'validation',
        )
      }
    }
    let profile: MaterializedProviderExecutionProfile
    try {
      profile = await dependencies.providerService.materializeExecutionProfile(
        durable.providerId,
        durable.providerConfigRevision,
      )
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        throw new JobExecutionError(error.code, '语音任务绑定的 Provider 配置不可用', false, 'validation')
      }
      throw error
    }
    if (profile.kind !== 'speech') {
      throw new JobExecutionError('PROVIDER_KIND_MISMATCH', '任务绑定的 Provider 不是语音服务', false, 'validation')
    }
    if (profile.adapter !== 'minimax'
      && profile.adapter !== 'openai-compatible'
      && profile.adapter !== 'indextts'
      && profile.adapter !== 'doubao-speech') {
      throw new JobExecutionError(
        'PROVIDER_ADAPTER_NOT_IMPLEMENTED',
        '该语音 Provider Adapter 尚未接入，未发起计费请求',
        false,
        'validation',
      )
    }
    if (!profile.baseUrl?.trim() || !profile.model?.trim() || profile.model !== durable.model) {
      throw new JobExecutionError('PROVIDER_NOT_CONFIGURED', '任务绑定的语音 Provider 配置不完整', false, 'validation')
    }
    if (performanceProfile?.openingSoundTag
      && profile.adapter === 'minimax'
      && profile.model !== 'speech-2.8-hd'
      && profile.model !== 'speech-2.8-turbo') {
      throw new JobExecutionError(
        'LINE_PERFORMANCE_MODEL_UNSUPPORTED',
        '确认的声音标签仅支持 MiniMax Speech 2.8，未发起语音合成',
        false,
        'validation',
      )
    }
    if (inheritedProfile
      && input.inheritedNarratorVoiceProfileRevisionId !== undefined
      && (profile.adapter === 'minimax'
        || profile.adapter === 'indextts'
        || profile.adapter === 'doubao-speech')) {
      const catalogService = profile.adapter === 'indextts'
        ? dependencies.indexTtsVoiceCatalogService
        : profile.adapter === 'doubao-speech'
          ? dependencies.doubaoVoiceCatalogService
          : dependencies.voiceCatalogService
      if (!catalogService) {
        throw new JobExecutionError(
          'VOICE_CATALOG_UNAVAILABLE',
          '无法在付费前复核当前音色目录',
          true,
          'provider',
        )
      }
      let catalog
      try {
        catalog = await catalogService.list()
      } catch {
        throw new JobExecutionError(
          'VOICE_CATALOG_UNAVAILABLE',
          '当前音色目录不可用，未发起语音合成',
          true,
          'provider',
        )
      }
      if (catalog.providerId !== inheritedProfile.providerId
        || catalog.providerConfigRevision !== inheritedProfile.providerConfigRevision
        || catalog.fingerprint !== inheritedProfile.catalogFingerprint
        || !catalog.voices.some((voice) => voice.voiceId === inheritedProfile.voiceId)) {
        throw new JobExecutionError(
          'VOICE_CATALOG_CHANGED',
          '音色目录或 Provider 已变化，请重新确认声线；未发起语音合成',
          false,
          'validation',
        )
      }
    }
    if (profile.adapter === 'openai-compatible') {
      if (input.volume !== 1 || input.pitch !== 0 || (input.emotion !== undefined && input.emotion !== 'calm')) {
        throw new JobExecutionError(
          'UNSUPPORTED_SPEECH_CONTROLS',
          '自定义 OpenAI-compatible Speech 仅支持 voice、speed 与 format；请在时间线中调整音量',
          false,
          'validation',
        )
      }
    }
    if (profile.adapter === 'indextts' && (input.volume !== 1 || input.pitch !== 0)) {
      throw new JobExecutionError(
        'UNSUPPORTED_SPEECH_CONTROLS',
        'IndexTTS 支持情绪与语速；音量请在时间线调整，音高暂不支持',
        false,
        'validation',
      )
    }
    const provider = executionProvider(
      profile,
      dependencies.injectedProvider,
      dependencies.openAICompatibleFetch,
    )
    if (!provider.configured || provider.model !== durable.model) {
      throw new JobExecutionError('PROVIDER_NOT_CONFIGURED', '语音 Provider 执行配置不匹配', false, 'validation')
    }

    await context.reportProgress(5, { stage: 'provider-request' })
    await context.waitingForProvider({
      operation: 'dialogue.speech.generate',
      phase: 'submitting',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: profile.providerId,
      providerConfigRevision: profile.configRevision,
      submittedAt: new Date().toISOString(),
    })
    const providerInput: MiniMaxSpeechInput = {
      text: profile.adapter === 'minimax'
        ? (input.compiledText ?? target.text)
        : stripLinePerformanceMarkers(input.compiledText ?? target.text),
      voiceId: input.voiceId,
      speed: input.speed,
      volume: input.volume,
      pitch: input.pitch,
      ...(input.emotion ? { emotion: input.emotion } : {}),
      format: input.format,
      sampleRate: input.sampleRate,
      bitrate: input.bitrate,
      channels: input.channels,
      ...(input.languageBoost ? { languageBoost: input.languageBoost } : {}),
      subtitleEnable: profile.adapter === 'minimax',
      subtitleType: 'word',
      outputFormat: 'hex',
    }
    let result
    try {
      result = await provider.synthesize(providerInput, context.signal)
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason
      if (error instanceof SpeechProviderError || error instanceof MiniMaxSpeechError) {
        // A concrete non-timeout HTTP or MiniMax business status proves that
        // the Provider returned a terminal rejection. Gateway/request timeout
        // responses remain ambiguous because the upstream task may exist.
        if (error.upstreamStatus !== undefined && error.code !== 'UPSTREAM_TIMEOUT') {
          await context.waitingForProvider({
            operation: DIALOGUE_SPEECH_GENERATION_JOB_TYPE,
            phase: 'failed',
            clientRequestId: job.id,
            providerSupportsIdempotency: false,
            providerId: profile.providerId,
            providerConfigRevision: profile.configRevision,
            providerFailureConfirmed: true,
            providerErrorCode: error.code,
            providerStatus: error.upstreamStatus,
            failedAt: new Date().toISOString(),
          })
        }
        throw speechExecutionError(error)
      }
      throw error
    }
    if (result.audio.kind !== 'bytes') {
      throw new JobExecutionError(
        'INVALID_RESPONSE',
        '语音 Provider 未返回可持久化的内联音频',
        true,
        'provider',
      )
    }
    await context.waitingForProvider({
      operation: 'dialogue.speech.generate',
      phase: 'response-received',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: profile.providerId,
      providerConfigRevision: profile.configRevision,
      receivedAt: new Date().toISOString(),
      format: result.format,
      audioSizeBytes: result.audio.bytes.byteLength,
    })
    context.signal.throwIfAborted()

    if (result.usageCharacters !== undefined) {
      dependencies.database.updateGenerationJob(durable.id, {
        cost: {
          providerId: durable.providerId,
          model: durable.model,
          unit: 'characters',
          usageCharacters: result.usageCharacters,
          currency: null,
          amount: null,
        },
      })
    }

    let durationSeconds = result.durationMs === undefined ? undefined : result.durationMs / 1_000
    if (durationSeconds === undefined) {
      await context.reportProgress(75, { stage: 'probing-audio-duration' })
      try {
        durationSeconds = await (dependencies.audioDurationProbe ?? probeAudioDuration)(
          result.audio.bytes,
          result.mimeType,
          context.signal,
        )
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason
        throw new JobExecutionError(
          'INVALID_AUDIO_DURATION',
          '语音 Provider 已返回音频，但无法校验其真实时长',
          true,
          'provider',
        )
      }
    }
    let subtitleCues: SpeechTimestampCue[] | undefined
    let subtitleFallbackReason: string | undefined
    if (profile.adapter === 'minimax') {
      if (input.inheritedPerformanceRevisionId !== undefined) {
        // Provider word cues may contain/offset controlled sound and pause
        // markers. Preserve subtitles from the immutable original line.
        subtitleFallbackReason = 'line-performance-original-text'
      } else if (result.subtitle) {
        await context.reportProgress(82, { stage: 'downloading-word-timestamps' })
        try {
          const loaded = await (dependencies.miniMaxSubtitleLoader ?? downloadMiniMaxSubtitle)(
            result.subtitle,
            context.signal,
          )
          const durationMs = Math.round(durationSeconds * 1_000)
          if (loaded.some((cue) => cue.endMs > durationMs + 500)) {
            subtitleFallbackReason = 'timestamps-outside-audio'
          } else {
            subtitleCues = loaded
          }
        } catch (error) {
          if (context.signal.aborted) throw context.signal.reason
          // Preserve the already-paid audio and fall back to a sentence cue;
          // a transient/invalid ephemeral sidecar must not force another TTS charge.
          subtitleFallbackReason = 'subtitle-sidecar-unavailable'
        }
      } else {
        subtitleFallbackReason = 'provider-returned-no-sidecar'
      }
    }
    const generationParameters: JsonObject = {
      lineId: input.lineId,
      ...(target.speechAssetId ? {
        assetFamilyId: stableAssetIdForVersion(
          dependencies.database,
          projectId,
          target.speechAssetId,
        ) ?? target.speechAssetId,
      } : {}),
      voiceId: input.voiceId,
      speed: input.speed,
      format: input.format,
      adapter: profile.adapter,
      ...(input.inheritedVoiceProfileRevisionId
        ? { inheritedVoiceProfileRevisionId: input.inheritedVoiceProfileRevisionId }
        : {}),
      ...(input.inheritedNarratorVoiceProfileRevisionId
        ? { inheritedNarratorVoiceProfileRevisionId: input.inheritedNarratorVoiceProfileRevisionId }
        : {}),
      ...(input.inheritedPerformanceRevisionId
        ? {
            inheritedPerformanceRevisionId: input.inheritedPerformanceRevisionId,
            annotatedText: input.compiledText!,
          }
        : {}),
      ...((profile.adapter === 'minimax'
        || profile.adapter === 'indextts'
        || profile.adapter === 'doubao-speech') ? {
        volume: input.volume,
        pitch: input.pitch,
        ...(input.emotion ? { emotion: input.emotion } : {}),
        ...(profile.adapter === 'indextts' ? { emotionAlpha: 0.65 } : {}),
        ...(profile.adapter === 'minimax' ? {
        sampleRate: input.sampleRate,
        bitrate: input.bitrate,
        channels: input.channels,
        ...(input.languageBoost ? { languageBoost: input.languageBoost } : {}),
        usageCharacters: result.usageCharacters ?? null,
        subtitle: subtitleCues
          ? {
              mode: 'word',
              granularity: result.subtitle?.granularity ?? 'word',
              cues: subtitleCues.map((cue) => ({ ...cue })) as unknown as JsonObject[],
            }
          : {
              mode: 'sentence-fallback',
              reason: subtitleFallbackReason ?? 'timestamps-unavailable',
            },
        } : {}),
      } : {}),
    }
    let inheritedBindingChangedDuringGeneration: 'character' | 'narrator' | 'performance' | undefined
    const asset = await dependencies.mediaStore.save({
      projectId,
      episodeId: input.episodeId,
      kind: 'speech',
      bytes: result.audio.bytes,
      mimeType: result.mimeType,
      source: 'provider',
      providerId: durable.providerId,
      generationJobId: durable.id,
      generationParameters,
      sourceRevisionId: input.expectedRevisionId,
      durationSeconds,
    }, {
      afterCreate(asset, database) {
        context.signal.throwIfAborted()
        const bindingState = database.withSql((sql) => sql.get(`
          SELECT
            episodes.source_revision_id,
            json_extract(characters.metadata_json, '$.voiceProfileRevisionId')
              AS voice_profile_revision_id,
            json_extract(dialogue_lines.metadata_json, '$.linePerformanceRevisionId')
              AS performance_revision_id
          FROM dialogue_lines
          JOIN shots ON shots.id = dialogue_lines.shot_id
          JOIN scenes ON scenes.id = shots.scene_id
          JOIN episodes ON episodes.id = scenes.episode_id
          LEFT JOIN characters ON characters.id = dialogue_lines.character_id
          WHERE dialogue_lines.id = ?
            AND episodes.id = ?
            AND episodes.project_id = ?
        `, input.databaseLineId, input.episodeId, projectId))
        if (!bindingState || nullableString(bindingState, 'source_revision_id') !== input.expectedRevisionId) {
          throw new JobExecutionError(
            'STALE_SOURCE',
            '源剧本已修改，语音资产未绑定；请基于最新台词重新生成',
            false,
            'validation',
          )
        }
        if (input.inheritedVoiceProfileRevisionId !== undefined
          && nullableString(bindingState, 'voice_profile_revision_id')
            !== input.inheritedVoiceProfileRevisionId) {
          // The provider request may already have incurred cost. Preserve the
          // returned bytes as an auditable stale asset, but never bind the old
          // timbre back onto a character whose casting changed concurrently.
          database.withSql((sql) => sql.run(`
            UPDATE media_assets SET status = 'stale', updated_at = ? WHERE id = ?
          `, new Date().toISOString(), asset.id))
          inheritedBindingChangedDuringGeneration = 'character'
          return
        }
        if (input.inheritedNarratorVoiceProfileRevisionId !== undefined) {
          let narratorRevisionId: string | null = null
          try {
            narratorRevisionId = new ProjectNarratorVoiceProfileRepository(database)
              .get(projectId).revisionId
          } catch {
            narratorRevisionId = null
          }
          if (narratorRevisionId !== input.inheritedNarratorVoiceProfileRevisionId) {
            database.withSql((sql) => sql.run(`
              UPDATE media_assets SET status = 'stale', updated_at = ? WHERE id = ?
            `, new Date().toISOString(), asset.id))
            inheritedBindingChangedDuringGeneration = 'narrator'
            return
          }
        }
        if (input.inheritedPerformanceRevisionId !== undefined
          && nullableString(bindingState, 'performance_revision_id')
            !== input.inheritedPerformanceRevisionId) {
          database.withSql((sql) => sql.run(`
            UPDATE media_assets SET status = 'stale', updated_at = ? WHERE id = ?
          `, new Date().toISOString(), asset.id))
          inheritedBindingChangedDuringGeneration = 'performance'
          return
        }
        const changed = database.withSql((sql) => sql.run(`
          UPDATE dialogue_lines
          SET speech_asset_id = ?, voice_id = ?, duration_seconds = ?, updated_at = ?
          WHERE dialogue_lines.id = ?
            AND EXISTS (
              SELECT 1
              FROM shots
              JOIN scenes ON scenes.id = shots.scene_id
              JOIN episodes ON episodes.id = scenes.episode_id
              WHERE shots.id = dialogue_lines.shot_id
                AND episodes.id = ?
                AND episodes.project_id = ?
                AND episodes.source_revision_id IS ?
            )
        `,
        asset.id,
        input.voiceId,
        durationSeconds ?? null,
        new Date().toISOString(),
        input.databaseLineId,
        input.episodeId,
        projectId,
        input.expectedRevisionId,
        )).changes
        if (changed !== 1) {
          throw new JobExecutionError(
            'STALE_SOURCE',
            '源剧本已修改，语音资产未绑定；请基于最新台词重新生成',
            false,
            'validation',
          )
        }
      },
    })
    if (inheritedBindingChangedDuringGeneration) {
      throw new JobExecutionError(
        inheritedBindingChangedDuringGeneration === 'character'
          ? 'STALE_CHARACTER_VOICE'
          : inheritedBindingChangedDuringGeneration === 'narrator'
            ? 'STALE_NARRATOR_VOICE'
            : 'STALE_LINE_PERFORMANCE',
        inheritedBindingChangedDuringGeneration === 'character'
          ? '角色声线在合成期间已修改；旧音色音频已留存为过期资产但未绑定'
          : inheritedBindingChangedDuringGeneration === 'narrator'
            ? '项目旁白声线在合成期间已修改；旧音色音频已留存为过期资产但未绑定'
            : '逐句表演指令在合成期间已修改；旧音频已留存为过期资产但未绑定',
        false,
        'validation',
      )
    }
    dependencies.publishAsset(asset)
    await context.reportProgress(95, { stage: 'asset-saved', assetId: asset.id })
    return {
      dialogueLineId: input.lineId,
      asset: dependencies.publicAsset(asset),
      provider: {
        id: durable.providerId,
        model: durable.model,
        configRevision: durable.providerConfigRevision,
      },
    }
  }
}

export function sameSpeechSubmission(existing: GenerationJobRecord, input: DialogueSpeechJobInput): boolean {
  return existing.type === DIALOGUE_SPEECH_GENERATION_JOB_TYPE
    && existing.episodeId === input.episodeId
    && existing.resourceId === input.databaseLineId
    && isDeepStrictEqual(existing.input, input)
}
