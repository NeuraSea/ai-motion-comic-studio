import {
  CharacterVoiceRecommendationError,
  recommendCharacterVoice,
  type CharacterVoiceCandidate,
  type CharacterVoiceRecommendation,
  type CharacterVoiceSceneContext,
} from './character-voice-recommendation.js'
import type { ManjuDatabase } from './database.js'
import { ProviderConfigurationError, ProviderService } from './providers/service.js'
import { OpenAICompatibleTextProvider, TextProviderError, type TextProvider } from './providers/text.js'
import type { JsonObject } from './types.js'
import { JobExecutionError, type JobHandler } from './worker.js'

export const CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE = 'character.voice.recommend'

export interface CharacterVoiceRecommendationJobInput {
  episodeId: string
  characterId: string
  characterDatabaseId: string
  expectedStoryRevisionId: string
  character: {
    id: string
    name: string
    role: string
    storyDescription: string
    visualDescription: string
  }
  scenes: CharacterVoiceSceneContext[]
  catalog: {
    providerId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
    providerConfigRevision: number
    model: string
    observedAt: string
    fingerprint: string
    candidateFingerprint: string
    voices: CharacterVoiceCandidate[]
  }
}

export interface CharacterVoiceRecommendationJobOutput {
  characterId: string
  recommendation: CharacterVoiceRecommendation
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseCharacterVoiceRecommendationJobInput(
  value: unknown,
): CharacterVoiceRecommendationJobInput {
  if (!isRecord(value)
    || typeof value.episodeId !== 'string'
    || typeof value.characterId !== 'string'
    || typeof value.characterDatabaseId !== 'string'
    || typeof value.expectedStoryRevisionId !== 'string'
    || !isRecord(value.character)
    || !Array.isArray(value.scenes)
    || !isRecord(value.catalog)
    || (value.catalog.providerId !== 'minimax-speech'
      && value.catalog.providerId !== 'indextts-speech'
      && value.catalog.providerId !== 'doubao-speech')
    || !Number.isInteger(value.catalog.providerConfigRevision)
    || typeof value.catalog.model !== 'string'
    || typeof value.catalog.observedAt !== 'string'
    || typeof value.catalog.fingerprint !== 'string'
    || typeof value.catalog.candidateFingerprint !== 'string'
    || !Array.isArray(value.catalog.voices)) {
    throw new JobExecutionError(
      'VOICE_RECOMMENDATION_INPUT_INVALID',
      '声线推荐任务参数无效',
      false,
      'validation',
    )
  }
  return value as unknown as CharacterVoiceRecommendationJobInput
}

function textProvider(
  profile: Awaited<ReturnType<ProviderService['materializeExecutionProfile']>>,
  compatibleFetch?: typeof fetch,
): TextProvider {
  if (profile.kind !== 'text'
    || (profile.adapter !== 'codex-tools' && profile.adapter !== 'openai-compatible')
    || !profile.baseUrl?.trim()
    || !profile.model?.trim()) {
    throw new JobExecutionError(
      'VOICE_RECOMMENDATION_PROVIDER_INVALID',
      '声线推荐绑定的文本 Provider 配置不可用',
      false,
      'validation',
    )
  }
  return new OpenAICompatibleTextProvider({
    name: profile.providerId,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    ...(compatibleFetch ? { fetch: compatibleFetch } : {}),
    ...(profile.adapter === 'codex-tools'
      ? { protocol: 'responses' as const, reasoningEffort: 'medium' as const }
      : {}),
  })
}

function providerError(error: unknown): JobExecutionError {
  if (error instanceof CharacterVoiceRecommendationError) {
    return new JobExecutionError(error.code, error.message, false, 'validation')
  }
  if (error instanceof TextProviderError) {
    const category = error.code === 'PROVIDER_AUTH_FAILED'
      ? 'authentication'
      : error.code === 'UPSTREAM_UNAVAILABLE'
        ? 'provider'
        : 'validation'
    return new JobExecutionError(error.code, error.message, error.retryable, category)
  }
  return new JobExecutionError(
    'VOICE_RECOMMENDATION_FAILED',
    '声线推荐失败，请稍后重试',
    true,
    'provider',
  )
}

export interface CharacterVoiceRecommendationHandlerDependencies {
  database: ManjuDatabase
  providerService: ProviderService
  textCompatibleFetch?: typeof fetch
}

export function createCharacterVoiceRecommendationHandler(
  dependencies: CharacterVoiceRecommendationHandlerDependencies,
): JobHandler<CharacterVoiceRecommendationJobInput, JsonObject> {
  return async (job, context) => {
    const priorState = isRecord(job.providerState) ? job.providerState : undefined
    if (priorState?.operation === CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE
      && (priorState.phase === 'submitting' || priorState.phase === 'response-received')
      && priorState.providerSupportsIdempotency !== true) {
      throw new JobExecutionError(
        'VOICE_RECOMMENDATION_SUBMISSION_OUTCOME_UNKNOWN',
        '上次声线推荐请求在服务中断前已提交，结果无法确认。为避免重复生成，系统没有自动重提；请核对 Provider 后手动重试。',
        false,
        'provider',
      )
    }
    const input = parseCharacterVoiceRecommendationJobInput(job.input)
    const durable = dependencies.database.getGenerationJob(job.id)
    if (!durable || !durable.providerId || durable.providerConfigRevision === null || !durable.model) {
      throw new JobExecutionError(
        'VOICE_RECOMMENDATION_PROVIDER_INVALID',
        '声线推荐任务缺少文本 Provider 绑定',
        false,
        'validation',
      )
    }
    const current = dependencies.database.withSql((sql) => sql.get(`
      SELECT episodes.source_revision_id, characters.id AS character_database_id,
             json_extract(characters.metadata_json, '$.storyId') AS character_id
        FROM episodes
        JOIN characters ON characters.episode_id = episodes.id
       WHERE episodes.id = ?
         AND episodes.project_id = ?
         AND characters.id = ?
    `, input.episodeId, durable.projectId, input.characterDatabaseId))
    if (!current
      || current.source_revision_id !== input.expectedStoryRevisionId
      || current.character_database_id !== input.characterDatabaseId
      || current.character_id !== input.characterId) {
      throw new JobExecutionError(
        'STALE_SOURCE',
        '角色或剧本已修改，请基于最新版本重新推荐声线',
        false,
        'validation',
      )
    }
    let profile
    try {
      profile = await dependencies.providerService.materializeExecutionProfile(
        durable.providerId,
        durable.providerConfigRevision,
      )
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        throw new JobExecutionError(error.code, '声线推荐文本 Provider 配置不可用', false, 'validation')
      }
      throw error
    }
    if (profile.model !== durable.model) {
      throw new JobExecutionError(
        'VOICE_RECOMMENDATION_PROVIDER_INVALID',
        '声线推荐文本 Provider 模型绑定不一致',
        false,
        'validation',
      )
    }
    const provider = textProvider(profile, dependencies.textCompatibleFetch)
    await context.reportProgress(5, { stage: 'voice-casting' })
    await context.waitingForProvider({
      operation: CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE,
      phase: 'submitting',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: profile.providerId,
      providerConfigRevision: profile.configRevision,
      catalogFingerprint: input.catalog.fingerprint,
      submittedAt: new Date().toISOString(),
    })
    let recommendation: CharacterVoiceRecommendation
    try {
      recommendation = await recommendCharacterVoice(provider, {
        character: input.character,
        scenes: input.scenes,
        voices: input.catalog.voices,
        catalogFingerprint: input.catalog.fingerprint,
        candidateFingerprint: input.catalog.candidateFingerprint,
        idempotencyKey: job.id,
      }, context.signal)
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason
      throw providerError(error)
    }
    await context.waitingForProvider({
      operation: CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE,
      phase: 'response-received',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: profile.providerId,
      providerConfigRevision: profile.configRevision,
      catalogFingerprint: input.catalog.fingerprint,
      receivedAt: new Date().toISOString(),
    })
    await context.reportProgress(95, { stage: 'recommendation-validated' })
    return {
      characterId: input.characterId,
      recommendation: recommendation as unknown as JsonObject,
    }
  }
}
