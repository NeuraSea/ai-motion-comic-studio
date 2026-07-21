import { isDeepStrictEqual } from 'node:util'

import type { GenerationJobRecord, ManjuDatabase } from './database.js'
import { resolveLinePerformanceRecommendationContext } from './line-performance-context.js'
import {
  LinePerformanceError,
  recommendLinePerformance,
  type LinePerformanceRecommendationContext,
} from './line-performance.js'
import { ProjectNarratorVoiceProfileRepository } from './project-narrator-voice-profiles.js'
import { ProviderConfigurationError, ProviderService } from './providers/service.js'
import { OpenAICompatibleTextProvider, TextProviderError, type TextProvider } from './providers/text.js'
import type { JsonObject } from './types.js'
import { JobExecutionError, type JobHandler, type JobRecord } from './worker.js'

export const LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE = 'dialogue.performance.recommend'

export type LinePerformanceRecommendationJobInput = LinePerformanceRecommendationContext

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseLinePerformanceRecommendationJobInput(
  value: unknown,
): LinePerformanceRecommendationJobInput {
  if (!isRecord(value)
    || typeof value.projectId !== 'string'
    || typeof value.episodeId !== 'string'
    || typeof value.databaseLineId !== 'string'
    || typeof value.lineId !== 'string'
    || typeof value.sourceRevisionId !== 'string'
    || (value.lineKind !== 'dialogue' && value.lineKind !== 'narration')
    || typeof value.originalText !== 'string'
    || !isRecord(value.performer)
    || (value.performer.scope !== 'character' && value.performer.scope !== 'narrator')
    || typeof value.performer.voiceProfileRevisionId !== 'string'
    || typeof value.performer.name !== 'string'
    || typeof value.performer.role !== 'string'
    || typeof value.performer.storyDescription !== 'string'
    || typeof value.performer.voiceDescription !== 'string'
    || !isRecord(value.scene)
    || typeof value.scene.id !== 'string'
    || typeof value.scene.title !== 'string'
    || typeof value.scene.timeOfDay !== 'string'
    || typeof value.scene.description !== 'string'
    || typeof value.scene.shotDescription !== 'string'
    || !Array.isArray(value.contextLines)) {
    throw new JobExecutionError(
      'LINE_PERFORMANCE_INPUT_INVALID',
      '逐句表演推荐任务参数无效',
      false,
      'validation',
    )
  }
  return value as unknown as LinePerformanceRecommendationJobInput
}

function publicStoryId(metadataValue: unknown, fallback: string): string {
  if (typeof metadataValue !== 'string') return fallback
  try {
    const metadata: unknown = JSON.parse(metadataValue)
    if (isRecord(metadata) && typeof metadata.storyId === 'string' && metadata.storyId.trim()) {
      return metadata.storyId.trim()
    }
  } catch {
    // Reported as stale binding below.
  }
  return fallback
}

function requireCurrentContext(
  database: ManjuDatabase,
  input: LinePerformanceRecommendationJobInput,
  resolver: typeof resolveLinePerformanceRecommendationContext,
): void {
  let resolved: LinePerformanceRecommendationJobInput
  try {
    resolved = resolver(database, {
      projectId: input.projectId,
      episodeId: input.episodeId,
      lineId: input.lineId,
    })
  } catch {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '台词、场景、上下文或声线已修改，请重新导演',
      false,
      'validation',
    )
  }
  if (!isDeepStrictEqual(resolved, input)) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      'AI 导演任务上下文与服务端当前解析结果不一致',
      false,
      'validation',
    )
  }
  const row = database.withSql((sql) => sql.get(`
    SELECT dialogue_lines.id AS line_id,
           dialogue_lines.kind,
           dialogue_lines.text,
           dialogue_lines.metadata_json AS line_metadata_json,
           dialogue_lines.character_id,
           characters.metadata_json AS character_metadata_json,
           episodes.source_revision_id
      FROM dialogue_lines
      JOIN shots ON shots.id = dialogue_lines.shot_id
      JOIN scenes ON scenes.id = shots.scene_id
      JOIN episodes ON episodes.id = scenes.episode_id
      LEFT JOIN characters ON characters.id = dialogue_lines.character_id
     WHERE dialogue_lines.id = ?
       AND episodes.id = ?
       AND episodes.project_id = ?
  `, input.databaseLineId, input.episodeId, input.projectId))
  if (!row
    || row.line_id !== input.databaseLineId
    || row.kind !== input.lineKind
    || row.text !== input.originalText
    || row.source_revision_id !== input.sourceRevisionId
    || publicStoryId(row.line_metadata_json, input.databaseLineId) !== input.lineId) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '台词、场景或剧本已修改，请重新导演',
      false,
      'validation',
    )
  }
  if (input.performer.scope === 'character') {
    let metadata: unknown
    try {
      metadata = typeof row.character_metadata_json === 'string'
        ? JSON.parse(row.character_metadata_json)
        : undefined
    } catch {
      metadata = undefined
    }
    if (input.lineKind !== 'dialogue'
      || !isRecord(metadata)
      || metadata.voiceProfileRevisionId !== input.performer.voiceProfileRevisionId) {
      throw new JobExecutionError(
        'STALE_CHARACTER_VOICE',
        '角色声线已修改，请基于最新角色设定重新导演',
        false,
        'validation',
      )
    }
  } else {
    let revisionId: string | null = null
    try {
      revisionId = new ProjectNarratorVoiceProfileRepository(database).get(input.projectId).revisionId
    } catch {
      revisionId = null
    }
    if (input.lineKind !== 'narration'
      || revisionId !== input.performer.voiceProfileRevisionId) {
      throw new JobExecutionError(
        'STALE_NARRATOR_VOICE',
        '项目旁白声线已修改，请基于最新旁白设定重新导演',
        false,
        'validation',
      )
    }
  }
}

function executionProvider(
  profile: Awaited<ReturnType<ProviderService['materializeExecutionProfile']>>,
  compatibleFetch?: typeof fetch,
): TextProvider {
  if (profile.kind !== 'text'
    || (profile.adapter !== 'codex-tools' && profile.adapter !== 'openai-compatible')
    || !profile.baseUrl?.trim()
    || !profile.model?.trim()) {
    throw new JobExecutionError(
      'LINE_PERFORMANCE_PROVIDER_INVALID',
      'AI 导演绑定的文本 Provider 配置不可用',
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

function asExecutionError(error: unknown): JobExecutionError {
  if (error instanceof LinePerformanceError) {
    return new JobExecutionError(error.code, error.message, false, 'validation')
  }
  if (error instanceof TextProviderError) {
    const category = error.code === 'PROVIDER_AUTH_FAILED'
      ? 'authentication'
      : error.code === 'PROVIDER_NOT_CONFIGURED'
        || error.code === 'INVALID_STRUCTURED_RESPONSE'
        ? 'validation'
        : 'provider'
    return new JobExecutionError(
      error.code,
      error.message,
      error.retryable,
      category,
    )
  }
  return new JobExecutionError(
    'LINE_PERFORMANCE_RECOMMENDATION_FAILED',
    'AI 导演失败，请稍后重试',
    true,
    'provider',
  )
}

function checkpointBlocksResubmission(job: JobRecord): boolean {
  if (!isRecord(job.providerState)) return false
  return job.providerState.operation === LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE
    && (job.providerState.phase === 'submitting' || job.providerState.phase === 'response-received')
    && job.providerState.providerSupportsIdempotency !== true
}

export interface LinePerformanceRecommendationHandlerDependencies {
  database: ManjuDatabase
  providerService: ProviderService
  textCompatibleFetch?: typeof fetch
  /** Test-only seam; production always uses the server-owned SQL resolver. */
  resolveContext?: typeof resolveLinePerformanceRecommendationContext
}

export function createLinePerformanceRecommendationHandler(
  dependencies: LinePerformanceRecommendationHandlerDependencies,
): JobHandler<LinePerformanceRecommendationJobInput, JsonObject> {
  return async (job, context) => {
    if (checkpointBlocksResubmission(job)) {
      throw new JobExecutionError(
        'LINE_PERFORMANCE_SUBMISSION_OUTCOME_UNKNOWN',
        '上次 AI 导演请求已提交但结果未知。为避免重复生成，系统没有自动重提。',
        false,
        'provider',
      )
    }
    const input = parseLinePerformanceRecommendationJobInput(job.input)
    const durable = dependencies.database.getGenerationJob(job.id)
    if (!durable
      || durable.projectId !== input.projectId
      || durable.episodeId !== input.episodeId
      || durable.resourceId !== input.databaseLineId
      || !durable.providerId
      || durable.providerConfigRevision === null
      || !durable.model) {
      throw new JobExecutionError(
        'LINE_PERFORMANCE_PROVIDER_INVALID',
        'AI 导演任务缺少不可变 Provider 或台词绑定',
        false,
        'validation',
      )
    }
    requireCurrentContext(
      dependencies.database,
      input,
      dependencies.resolveContext ?? resolveLinePerformanceRecommendationContext,
    )
    const connection = dependencies.database.getProviderConnection(durable.providerId)
    if (!connection
      || !connection.enabled
      || connection.kind !== 'text'
      || connection.configRevision !== durable.providerConfigRevision) {
      throw new JobExecutionError(
        'LINE_PERFORMANCE_PROVIDER_CHANGED',
        '文本 Provider 已更新或禁用，请重新点击 AI 导演；未发起推荐请求',
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
        throw new JobExecutionError(error.code, 'AI 导演文本 Provider 配置不可用', false, 'validation')
      }
      throw error
    }
    if (profile.model !== durable.model) {
      throw new JobExecutionError(
        'LINE_PERFORMANCE_PROVIDER_CHANGED',
        'AI 导演文本模型绑定已变化，请重新导演',
        false,
        'validation',
      )
    }
    const provider = executionProvider(profile, dependencies.textCompatibleFetch)
    await context.reportProgress(5, { stage: 'directing-line' })
    await context.waitingForProvider({
      operation: LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
      phase: 'submitting',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: profile.providerId,
      providerConfigRevision: profile.configRevision,
      submittedAt: new Date().toISOString(),
    })
    let recommendation
    try {
      recommendation = await recommendLinePerformance(provider, input, context.signal, job.id)
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason
      throw asExecutionError(error)
    }
    await context.waitingForProvider({
      operation: LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
      phase: 'response-received',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: profile.providerId,
      providerConfigRevision: profile.configRevision,
      receivedAt: new Date().toISOString(),
    })
    // The free LLM request may already have completed at the Provider, but a
    // response based on stale dialogue or casting must never become adoptable.
    requireCurrentContext(
      dependencies.database,
      input,
      dependencies.resolveContext ?? resolveLinePerformanceRecommendationContext,
    )
    await context.reportProgress(95, { stage: 'performance-validated' })
    return {
      lineId: input.lineId,
      recommendation: recommendation as unknown as JsonObject,
    }
  }
}

export function sameLinePerformanceRecommendationSubmission(
  existing: GenerationJobRecord,
  input: LinePerformanceRecommendationJobInput,
): boolean {
  return existing.type === LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE
    && existing.episodeId === input.episodeId
    && existing.resourceId === input.databaseLineId
    && isDeepStrictEqual(existing.input, input)
}
