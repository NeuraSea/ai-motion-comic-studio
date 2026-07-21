import { isDeepStrictEqual } from 'node:util'

import { probeAudioDuration, type AudioDurationProbe } from './audio-duration.js'
import type { GenerationJobRecord, ManjuDatabase, MediaAssetRecord } from './database.js'
import type {
  MiniMaxVoiceCatalog,
} from './minimax-voice-catalog.js'
import type { IndexTtsVoiceCatalog } from './indextts-voice-catalog.js'
import type { DoubaoVoiceCatalog } from './doubao-voice-catalog.js'
import { MediaStore } from './media.js'
import { IndexTtsSpeechProvider } from './providers/indextts-speech.js'
import { DoubaoSpeechProvider } from './providers/doubao-speech.js'
import {
  MiniMaxSpeechError,
  MiniMaxSpeechProvider,
  SpeechProviderError,
  type MiniMaxSpeechInput,
  type SpeechProvider,
} from './providers/minimax-tts.js'
import {
  ProviderConfigurationError,
  ProviderService,
  type MaterializedProviderExecutionProfile,
} from './providers/service.js'
import type { JsonObject } from './types.js'
import { JobExecutionError, type JobHandler, type JobRecord } from './worker.js'

export const CHARACTER_VOICE_PREVIEW_JOB_TYPE = 'character.voice.preview'
export const CHARACTER_VOICE_PREVIEW_FALLBACK_TEXT = '你好，很高兴与你相遇。'
export const CHARACTER_VOICE_PREVIEW_MAX_CHARACTERS = 72

export interface CharacterVoicePreviewJobInput {
  episodeId: string
  characterId: string
  characterDatabaseId: string
  expectedStoryRevisionId: string
  voiceId: string
  expectedCatalogFingerprint: string
  expectedProviderConfigRevision: number
}

export interface CharacterVoicePreviewTarget {
  projectId: string
  episodeId: string
  characterId: string
  characterDatabaseId: string
  sourceRevisionId: string
  sampleText: string
  sampleSource: 'dialogue' | 'fallback'
}

export class CharacterVoicePreviewError extends Error {
  constructor(
    readonly code:
      | 'EPISODE_NOT_FOUND'
      | 'STORY_NOT_FOUND'
      | 'CHARACTER_NOT_FOUND'
      | 'CHARACTER_PREVIEW_TARGET_CHANGED',
    message: string,
  ) {
    super(message)
    this.name = 'CharacterVoicePreviewError'
  }
}

type SqlRow = Record<string, unknown>

function requiredText(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Database column ${key} is not text`)
  return value
}

function publicCharacterId(metadataJson: string, fallback: string): string {
  const metadata: unknown = JSON.parse(metadataJson)
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const storyId = (metadata as Record<string, unknown>).storyId
    if (typeof storyId === 'string' && storyId.trim()) return storyId.trim()
  }
  return fallback
}

/** Normalize and bound provider-billable preview text selected by the server. */
export function characterVoicePreviewText(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (!normalized) return CHARACTER_VOICE_PREVIEW_FALLBACK_TEXT
  const characters = Array.from(normalized)
  if (characters.length <= CHARACTER_VOICE_PREVIEW_MAX_CHARACTERS) return normalized
  return `${characters.slice(0, CHARACTER_VOICE_PREVIEW_MAX_CHARACTERS - 1).join('')}…`
}

function dialogueSample(
  database: ManjuDatabase,
  episodeId: string,
  characterDatabaseId: string,
): { sampleText: string; sampleSource: 'dialogue' | 'fallback' } {
  const row = database.withSql((sql) => sql.get(`
    SELECT dialogue_lines.text
    FROM dialogue_lines
    JOIN shots ON shots.id = dialogue_lines.shot_id
    JOIN scenes ON scenes.id = shots.scene_id
    WHERE scenes.episode_id = ?
      AND dialogue_lines.character_id = ?
      AND length(trim(dialogue_lines.text)) > 0
    ORDER BY scenes.sequence, shots.sequence, dialogue_lines.sequence, dialogue_lines.id
    LIMIT 1
  `, episodeId, characterDatabaseId))
  if (!row || typeof row.text !== 'string' || !row.text.trim()) {
    return { sampleText: CHARACTER_VOICE_PREVIEW_FALLBACK_TEXT, sampleSource: 'fallback' }
  }
  return { sampleText: characterVoicePreviewText(row.text), sampleSource: 'dialogue' }
}

/** Resolve a public character against the current normalized Story graph. */
export function resolvePublicCharacterVoicePreviewTarget(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string; characterId: string },
): CharacterVoicePreviewTarget {
  const episode = database.withSql((sql) => sql.get(`
    SELECT id, project_id, source_revision_id
    FROM episodes
    WHERE id = ? AND project_id = ?
  `, input.episodeId, input.projectId))
  if (!episode) {
    throw new CharacterVoicePreviewError('EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
  }
  if (typeof episode.source_revision_id !== 'string' || !episode.source_revision_id) {
    throw new CharacterVoicePreviewError('STORY_NOT_FOUND', '分集尚未生成结构化剧本')
  }
  const rows = database.withSql((sql) => sql.all(`
    SELECT id, metadata_json
    FROM characters
    WHERE project_id = ?
      AND episode_id = ?
      AND CASE
        WHEN typeof(json_extract(metadata_json, '$.storyId')) = 'text'
          AND length(trim(json_extract(metadata_json, '$.storyId'))) > 0
        THEN json_extract(metadata_json, '$.storyId')
        ELSE id
      END = ?
    ORDER BY id
    LIMIT 2
  `, input.projectId, input.episodeId, input.characterId))
  if (rows.length !== 1) {
    throw new CharacterVoicePreviewError('CHARACTER_NOT_FOUND', '角色不存在或不属于指定分集')
  }
  const characterDatabaseId = requiredText(rows[0], 'id')
  return {
    projectId: input.projectId,
    episodeId: input.episodeId,
    characterId: input.characterId,
    characterDatabaseId,
    sourceRevisionId: episode.source_revision_id,
    ...dialogueSample(database, input.episodeId, characterDatabaseId),
  }
}

function resolveDurableTarget(
  database: ManjuDatabase,
  projectId: string,
  input: CharacterVoicePreviewJobInput,
): CharacterVoicePreviewTarget {
  const row = database.withSql((sql) => sql.get(`
    SELECT
      characters.id AS character_database_id,
      characters.metadata_json AS character_metadata_json,
      episodes.source_revision_id
    FROM characters
    JOIN episodes ON episodes.id = characters.episode_id
    WHERE characters.id = ?
      AND characters.episode_id = ?
      AND characters.project_id = ?
      AND episodes.project_id = ?
  `, input.characterDatabaseId, input.episodeId, projectId, projectId))
  if (!row) {
    throw new JobExecutionError(
      'CHARACTER_NOT_FOUND',
      '待试听角色已不存在，未发起语音合成请求',
      false,
      'validation',
    )
  }
  const databaseId = requiredText(row, 'character_database_id')
  const metadata = requiredText(row, 'character_metadata_json')
  const sourceRevisionId = requiredText(row, 'source_revision_id')
  if (publicCharacterId(metadata, databaseId) !== input.characterId
    || sourceRevisionId !== input.expectedStoryRevisionId) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '角色或剧本已修改，未发起语音合成请求',
      false,
      'validation',
    )
  }
  return {
    projectId,
    episodeId: input.episodeId,
    characterId: input.characterId,
    characterDatabaseId: databaseId,
    sourceRevisionId,
    ...dialogueSample(database, input.episodeId, databaseId),
  }
}

function parseInput(value: unknown): CharacterVoicePreviewJobInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobExecutionError('INVALID_VOICE_PREVIEW_INPUT', '声线试听任务参数无效', false, 'validation')
  }
  const input = value as Partial<CharacterVoicePreviewJobInput>
  if (typeof input.episodeId !== 'string'
    || typeof input.characterId !== 'string'
    || typeof input.characterDatabaseId !== 'string'
    || typeof input.expectedStoryRevisionId !== 'string'
    || typeof input.voiceId !== 'string'
    || !input.voiceId.trim()
    || input.voiceId.length > 256
    || /[\u0000-\u001f\u007f]/.test(input.voiceId)
    || typeof input.expectedCatalogFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(input.expectedCatalogFingerprint)
    || !Number.isInteger(input.expectedProviderConfigRevision)
    || (input.expectedProviderConfigRevision ?? 0) < 1) {
    throw new JobExecutionError('INVALID_VOICE_PREVIEW_INPUT', '声线试听任务参数无效', false, 'validation')
  }
  return input as CharacterVoicePreviewJobInput
}

function checkpointBlocksResubmission(job: JobRecord): boolean {
  if (!job.providerState || typeof job.providerState !== 'object' || Array.isArray(job.providerState)) return false
  const state = job.providerState as Record<string, unknown>
  return state.operation === CHARACTER_VOICE_PREVIEW_JOB_TYPE
    && (state.phase === 'submitting' || state.phase === 'response-received')
    && state.providerSupportsIdempotency !== true
}

function checkpointPhase(job: JobRecord): string | undefined {
  if (!job.providerState || typeof job.providerState !== 'object' || Array.isArray(job.providerState)) return undefined
  const state = job.providerState as Record<string, unknown>
  return state.operation === CHARACTER_VOICE_PREVIEW_JOB_TYPE && typeof state.phase === 'string'
    ? state.phase
    : undefined
}

function providerError(error: SpeechProviderError): JobExecutionError {
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

type SpeechVoiceCatalog = MiniMaxVoiceCatalog | IndexTtsVoiceCatalog | DoubaoVoiceCatalog
type SpeechVoiceProviderId = SpeechVoiceCatalog['providerId']

function speechProvider(
  profile: MaterializedProviderExecutionProfile,
  injected?: SpeechProvider,
): SpeechProvider {
  if (injected) return injected
  if (!profile.baseUrl?.trim() || !profile.model?.trim()) {
    throw new JobExecutionError('PROVIDER_NOT_CONFIGURED', '语音 Provider 配置不完整', false, 'validation')
  }
  if (profile.adapter === 'indextts') {
    return new IndexTtsSpeechProvider({
      name: profile.providerId,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      model: profile.model,
    })
  }
  if (profile.adapter === 'doubao-speech') {
    return new DoubaoSpeechProvider({
      name: profile.providerId,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      model: profile.model,
    })
  }
  return new MiniMaxSpeechProvider({
    name: profile.providerId,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
  })
}

function assertCurrentCatalog(
  catalog: SpeechVoiceCatalog,
  providerId: SpeechVoiceProviderId,
  input: CharacterVoicePreviewJobInput,
): void {
  if (catalog.providerId !== providerId
    || catalog.providerConfigRevision !== input.expectedProviderConfigRevision
    || catalog.fingerprint !== input.expectedCatalogFingerprint) {
    throw new JobExecutionError(
      'VOICE_CATALOG_CHANGED',
      '语音 Provider 的音色目录或配置已变化，未发起试听请求；请刷新目录后重试',
      false,
      'validation',
    )
  }
  if (!catalog.voices.some((voice) => voice.voiceId === input.voiceId)) {
    throw new JobExecutionError(
      'VOICE_NOT_AVAILABLE',
      '所选音色已不在当前语音 Provider 目录中，未发起试听请求',
      false,
      'validation',
    )
  }
}

export interface CharacterVoicePreviewHandlerDependencies {
  database: ManjuDatabase
  mediaStore: MediaStore
  providerService: ProviderService
  voiceCatalogService: {
    list: (providerId: SpeechVoiceProviderId, signal?: AbortSignal) => Promise<SpeechVoiceCatalog>
  }
  injectedProvider?: SpeechProvider
  audioDurationProbe?: AudioDurationProbe
  publicAsset: (asset: MediaAssetRecord) => JsonObject
  publishAsset: (asset: MediaAssetRecord) => void
}

/**
 * Paid, explicit short TTS preview. The resulting asset is intentionally not
 * linked to a dialogue line or character profile; confirmation is a separate
 * user action.
 */
export function createCharacterVoicePreviewHandler(
  dependencies: CharacterVoicePreviewHandlerDependencies,
): JobHandler<CharacterVoicePreviewJobInput, JsonObject> {
  return async (job, context) => {
    const input = parseInput(job.input)
    const durable = dependencies.database.getGenerationJob(job.id)
    if (!durable) throw new JobExecutionError('JOB_NOT_FOUND', '声线试听任务不存在', false, 'validation')
    if ((durable.providerId !== 'minimax-speech'
      && durable.providerId !== 'indextts-speech'
      && durable.providerId !== 'doubao-speech')
      || durable.providerConfigRevision === null
      || !durable.model) {
      throw new JobExecutionError('PROVIDER_NOT_CONFIGURED', '声线试听未绑定有效的语音 Provider 配置', false, 'validation')
    }
    if (durable.providerConfigRevision !== input.expectedProviderConfigRevision) {
      throw new JobExecutionError('INVALID_PROVIDER_BINDING', '声线试听 Provider 修订绑定无效', false, 'validation')
    }
    if (checkpointBlocksResubmission(job)) {
      if (checkpointPhase(job) === 'response-received') {
        const rows = dependencies.database.withSql((sql) => sql.all(`
          SELECT id FROM media_assets
          WHERE generation_job_id = ?
            AND project_id = ?
            AND episode_id = ?
            AND kind = 'character.voice.preview'
          ORDER BY created_at, id
          LIMIT 2
        `, durable.id, durable.projectId, input.episodeId))
        if (rows.length === 1 && typeof rows[0].id === 'string') {
          const recovered = dependencies.database.getMediaAsset(rows[0].id)
          const parameters = recovered?.generationParameters
          if (recovered
            && parameters
            && recovered.providerId === durable.providerId
            && recovered.sourceRevisionId === input.expectedStoryRevisionId
            && parameters.characterId === input.characterId
            && parameters.voiceId === input.voiceId
            && parameters.catalogFingerprint === input.expectedCatalogFingerprint
            && (parameters.sampleSource === 'dialogue' || parameters.sampleSource === 'fallback')
            && Number.isInteger(parameters.sampleCharacterCount)
            && (parameters.sampleCharacterCount as number) > 0) {
            // The process may have stopped after the immutable file/index was
            // committed but before the job terminal row was written. Reuse
            // that exact local asset; never resubmit the paid TTS request.
            dependencies.publishAsset(recovered)
            return {
              characterId: input.characterId,
              voiceId: input.voiceId,
              sampleSource: parameters.sampleSource,
              sampleCharacterCount: parameters.sampleCharacterCount,
              asset: dependencies.publicAsset(recovered),
              provider: {
                id: durable.providerId,
                model: durable.model,
                configRevision: durable.providerConfigRevision,
              },
            }
          }
        }
      }
      throw new JobExecutionError(
        'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
        '上次声线试听在服务中断前已提交，结果无法确认。为避免重复生成，系统没有自动重提；请核对语音 Provider 后手动创建新的试听。',
        false,
        'provider',
      )
    }

    const target = resolveDurableTarget(dependencies.database, durable.projectId, input)

    // Get Voice is non-billable. Re-read it immediately before TTS so a stale
    // UI selection never silently becomes a paid request against another
    // catalog/provider revision.
    let catalog: SpeechVoiceCatalog
    try {
      catalog = await dependencies.voiceCatalogService.list(durable.providerId, context.signal)
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason
      throw error
    }
    assertCurrentCatalog(catalog, durable.providerId, input)

    let profile: MaterializedProviderExecutionProfile
    try {
      // Do not use a historical credential merely because it remains in the
      // Keychain for audit/recovery. A preview is an interactive new charge:
      // the exact current head must still be enabled, credentialed, tested,
      // and equal to the revision captured at submission time.
      profile = await dependencies.providerService.materializeCurrentVerifiedProfile(
        durable.providerId,
      )
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        throw new JobExecutionError(error.code, '声线试听绑定的语音 Provider 配置不可用', false, 'validation')
      }
      throw error
    }
    if (profile.configRevision !== durable.providerConfigRevision
      || profile.configRevision !== input.expectedProviderConfigRevision) {
      throw new JobExecutionError(
        'VOICE_PROVIDER_CHANGED',
        '语音 Provider 配置已变化，未发起试听请求；请刷新目录后重试',
        false,
        'validation',
      )
    }
    if (profile.kind !== 'speech'
      || (profile.adapter !== 'minimax'
        && profile.adapter !== 'indextts'
        && profile.adapter !== 'doubao-speech')
      || !profile.baseUrl?.trim()
      || !profile.model?.trim()
      || profile.model !== durable.model) {
      throw new JobExecutionError(
        'PROVIDER_NOT_CONFIGURED',
        '声线试听绑定的语音 Provider 配置不完整',
        false,
        'validation',
      )
    }
    const provider = speechProvider(profile, dependencies.injectedProvider)
    if (!provider.configured || provider.model !== durable.model) {
      throw new JobExecutionError('PROVIDER_NOT_CONFIGURED', '语音试听执行配置不匹配', false, 'validation')
    }

    await context.reportProgress(10, { stage: 'provider-request' })
    await context.waitingForProvider({
      operation: CHARACTER_VOICE_PREVIEW_JOB_TYPE,
      phase: 'submitting',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: profile.providerId,
      providerConfigRevision: profile.configRevision,
      submittedAt: new Date().toISOString(),
    })
    const providerInput: MiniMaxSpeechInput = {
      text: target.sampleText,
      voiceId: input.voiceId,
      speed: 1,
      volume: 1,
      pitch: 0,
      emotion: 'calm',
      format: 'mp3',
      sampleRate: 32_000,
      bitrate: 128_000,
      channels: 1,
      subtitleEnable: false,
      outputFormat: 'hex',
    }
    let result
    try {
      result = await provider.synthesize(providerInput, context.signal)
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason
      if (error instanceof SpeechProviderError || error instanceof MiniMaxSpeechError) {
        if (error.upstreamStatus !== undefined && error.code !== 'UPSTREAM_TIMEOUT') {
          await context.waitingForProvider({
            operation: CHARACTER_VOICE_PREVIEW_JOB_TYPE,
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
        throw providerError(error)
      }
      throw error
    }
    if (result.audio.kind !== 'bytes') {
      throw new JobExecutionError('INVALID_RESPONSE', '语音 Provider 未返回可持久化的试听音频', true, 'provider')
    }
    await context.waitingForProvider({
      operation: CHARACTER_VOICE_PREVIEW_JOB_TYPE,
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
      try {
        durationSeconds = await (dependencies.audioDurationProbe ?? probeAudioDuration)(
          result.audio.bytes,
          result.mimeType,
          context.signal,
        )
      } catch {
        if (context.signal.aborted) throw context.signal.reason
        throw new JobExecutionError(
          'INVALID_AUDIO_DURATION',
          '语音 Provider 已返回试听音频，但无法校验其真实时长',
          true,
          'provider',
        )
      }
    }
    const asset = await dependencies.mediaStore.save({
      projectId: durable.projectId,
      episodeId: input.episodeId,
      kind: 'character.voice.preview',
      bytes: result.audio.bytes,
      mimeType: result.mimeType,
      source: 'provider',
      providerId: durable.providerId,
      generationJobId: durable.id,
      generationParameters: {
        characterId: input.characterId,
        voiceId: input.voiceId,
        catalogFingerprint: input.expectedCatalogFingerprint,
        sampleSource: target.sampleSource,
        sampleCharacterCount: Array.from(target.sampleText).length,
        speed: 1,
        emotion: 'calm',
        format: 'mp3',
        usageCharacters: result.usageCharacters ?? null,
      },
      sourceRevisionId: input.expectedStoryRevisionId,
      durationSeconds,
    })
    dependencies.publishAsset(asset)
    await context.reportProgress(95, { stage: 'asset-saved', assetId: asset.id })
    return {
      characterId: input.characterId,
      voiceId: input.voiceId,
      sampleSource: target.sampleSource,
      sampleCharacterCount: Array.from(target.sampleText).length,
      asset: dependencies.publicAsset(asset),
      provider: {
        id: durable.providerId,
        model: durable.model,
        configRevision: durable.providerConfigRevision,
      },
    }
  }
}

export function sameCharacterVoicePreviewSubmission(
  existing: GenerationJobRecord,
  input: CharacterVoicePreviewJobInput,
): boolean {
  return existing.type === CHARACTER_VOICE_PREVIEW_JOB_TYPE
    && existing.episodeId === input.episodeId
    && existing.resourceId === input.characterDatabaseId
    && (existing.providerId === 'minimax-speech'
      || existing.providerId === 'indextts-speech'
      || existing.providerId === 'doubao-speech')
    && existing.providerConfigRevision === input.expectedProviderConfigRevision
    && isDeepStrictEqual(existing.input, input)
}
