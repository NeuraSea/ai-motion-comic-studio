import type {
  CreatePipelineRunInput,
  PipelineRun,
  PipelineRunPreflight,
  PipelineRunPreflightInput,
  ProviderConnection,
  ProviderKind,
} from '../../lib/api-types'

const TERMINAL_PIPELINE_STATUSES = new Set<PipelineRun['status']>([
  'succeeded',
  'failed',
  'cancelled',
  'stale',
])

export interface PipelineRunContext {
  projectId: string
  episodeId: string
  sourceRevisionId: string
}

export interface PipelineRunAdoptionScope {
  context: PipelineRunContext
  runId?: string
}

export interface PipelineIdempotencyAttempt {
  cacheKey: string
  idempotencyKey: string
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
  return `{${entries.join(',')}}`
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function compareTimestamp(left: string, right: string): number {
  const leftTime = timestamp(left)
  const rightTime = timestamp(right)
  if (leftTime !== null && rightTime !== null) return leftTime - rightTime
  return left.localeCompare(right)
}

export function pipelineRunMatchesContext(run: PipelineRun, context: PipelineRunContext): boolean {
  return run.projectId === context.projectId
    && run.episodeId === context.episodeId
    && run.sourceRevisionId === context.sourceRevisionId
}

export function pipelineRunContextKey(context: PipelineRunContext): string {
  return `${context.projectId}:${context.episodeId}:${context.sourceRevisionId}`
}

/**
 * Keeps only caller-controlled execution options. Character voice/provider
 * bindings are server-resolved and authenticated by preflight.
 */
export function normalizePipelinePreflightInput(
  input: PipelineRunPreflightInput,
): PipelineRunPreflightInput {
  return {
    projectId: input.projectId,
    resolution: input.resolution,
    kenBurns: input.kenBurns,
    burnSubtitles: input.burnSubtitles,
    introTitle: input.introTitle,
    outroCard: input.outroCard,
    reviewWatermark: input.reviewWatermark,
    speechMode: input.speechMode,
    ...(input.imageProviderId ? { imageProviderId: input.imageProviderId } : {}),
  }
}

export function normalizePipelineCreateInput(input: CreatePipelineRunInput): CreatePipelineRunInput {
  return {
    ...normalizePipelinePreflightInput(input),
    confirmationToken: input.confirmationToken,
  }
}

export function pipelineRequestCacheKey(
  contextKey: string,
  input: PipelineRunPreflightInput | CreatePipelineRunInput,
): string {
  // The confirmation token authenticates mutable discovery state, not caller
  // intent. Excluding it lets an unknown committed create exact-replay with the
  // original Idempotency-Key after a later preflight issues a different token.
  return `${contextKey}\n${canonicalJson(normalizePipelinePreflightInput(input))}`
}

/** Retains every ambiguous caller attempt until its exact durable ack arrives. */
export function getOrCreatePipelineAttempt(
  attempts: Map<string, string>,
  contextKey: string,
  input: PipelineRunPreflightInput | CreatePipelineRunInput,
  createKey: () => string,
): PipelineIdempotencyAttempt {
  const cacheKey = pipelineRequestCacheKey(contextKey, input)
  const existing = attempts.get(cacheKey)
  if (existing) return { cacheKey, idempotencyKey: existing }
  const idempotencyKey = createKey()
  attempts.set(cacheKey, idempotencyKey)
  return { cacheKey, idempotencyKey }
}

export function completePipelineAttempt(
  attempts: Map<string, string>,
  attempt: PipelineIdempotencyAttempt,
): void {
  if (attempts.get(attempt.cacheKey) === attempt.idempotencyKey) {
    attempts.delete(attempt.cacheKey)
  }
}

export function pipelinePreflightRemainingSeconds(
  preflight: Pick<PipelineRunPreflight, 'expiresAt'>,
  nowEpochMs = Date.now(),
): number | null {
  if (preflight.expiresAt === null) return null
  const expiresAtMs = Date.parse(preflight.expiresAt)
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowEpochMs)) return 0
  return Math.max(0, Math.ceil((expiresAtMs - nowEpochMs) / 1_000))
}

export function pipelinePreflightIsExpired(
  preflight: Pick<PipelineRunPreflight, 'expiresAt'>,
  nowEpochMs = Date.now(),
): boolean {
  const remaining = pipelinePreflightRemainingSeconds(preflight, nowEpochMs)
  return remaining !== null && remaining <= 0
}

/**
 * Adopts only an authoritative response for the active immutable context.
 * Same-run terminal state is irreversible and older responses cannot regress
 * progress. For different runs, creation time decides which run is newer.
 */
export function adoptPipelineRun(
  current: PipelineRun | null,
  incoming: PipelineRun,
  scope: PipelineRunAdoptionScope,
): PipelineRun | null {
  if (!pipelineRunMatchesContext(incoming, scope.context)) return current
  if (scope.runId !== undefined && incoming.id !== scope.runId) return current
  if (!current || !pipelineRunMatchesContext(current, scope.context)) return incoming

  if (current.id !== incoming.id) {
    const creationOrder = compareTimestamp(incoming.createdAt, current.createdAt)
    if (creationOrder < 0) return current
    if (creationOrder === 0 && incoming.id <= current.id) return current
    return incoming
  }

  const currentTerminal = TERMINAL_PIPELINE_STATUSES.has(current.status)
  const incomingTerminal = TERMINAL_PIPELINE_STATUSES.has(incoming.status)
  if (currentTerminal) return current

  const updateOrder = compareTimestamp(incoming.updatedAt, current.updatedAt)
  if (updateOrder < 0) return current
  if (updateOrder === 0) {
    if (!incomingTerminal && incoming.progress < current.progress) return current
    if (!incomingTerminal && incoming.status === 'queued' && current.status === 'running') return current
  }
  return incoming
}

export function isExecutablePipelineProvider(
  provider: ProviderConnection,
  kind: Extract<ProviderKind, 'image' | 'speech'>,
): boolean {
  const supportedAdapter = kind === 'image'
    ? provider.adapter === 'codex-tools' || provider.adapter === 'openai-compatible'
    : provider.adapter === 'minimax'
      || provider.adapter === 'openai-compatible'
      || provider.adapter === 'indextts'
      || provider.adapter === 'doubao-speech'
  return provider.kind === kind
    && provider.enabled
    && provider.credentialState !== 'missing'
    && Boolean(provider.baseUrl.trim())
    && Boolean(provider.model.trim())
    && supportedAdapter
}

const PIPELINE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  AUDIO_REQUIRED: '请先添加可发布的对白、BGM 或音效；跳过配音时不会用静音占位。',
  DEFAULT_VOICE_REQUIRED: '当前还有缺失配音，请填写 MiniMax 或自定义 voice_id。',
  IMAGE_PROVIDER_REQUIRED: '还有缺失分镜，请先配置并启用可用的图片 Provider。',
  SPEECH_PROVIDER_REQUIRED: '还有缺失配音，请先配置并启用可用的 Speech Provider。',
  PROVIDER_NOT_CONFIGURED: '所选 Provider 未启用、缺少凭据，或模型配置不完整。',
  PIPELINE_PREFLIGHT_EXPIRED: '一键生产预检已过期，请重新核对计费目标。',
  PIPELINE_PROVIDER_NOT_FOUND: '所选 Provider 不存在，请刷新 Provider 配置后重试。',
  PIPELINE_PROVIDER_DISABLED: '所选 Provider 已停用，请换用可用连接。',
  PIPELINE_PROVIDER_REVISION_NOT_FOUND: 'Provider 配置修订已不可用，请发起新一轮生产。',
  PIPELINE_PROVIDER_KIND_MISMATCH: '所选 Provider 类型与当前生成步骤不匹配。',
  PIPELINE_PREFLIGHT_REQUIRED: '请先运行权威预检，再确认本次可计费生成任务。',
  PIPELINE_PREFLIGHT_CHANGED: '素材就绪状态或 Provider 修订已变更，本次未建单；请重新预检并确认。',
  INVALID_PIPELINE_PREFLIGHT_REQUEST: '预检请求无效，请刷新页面后重试。',
  PIPELINE_RUN_ALREADY_ACTIVE: '当前分集已有同配置生产任务在运行，本次未重复建单；正在恢复现有任务状态。',
  IDEMPOTENCY_CONFLICT: '该幂等请求已绑定另一组生产配置，请先刷新最近任务。',
  QUEUE_FULL: '生成队列已满，本次未建单；请稍后使用同一配置重试。',
  STALE_SOURCE_REVISION: '源剧本修订已变更，请基于最新剧本发起新一轮生产。',
  PIPELINE_CANCELLED: '一键生产任务已取消。',
})

export function pipelineErrorMessage(
  code: string | undefined,
  message: string | undefined,
  fallback: string,
): string {
  return (code && PIPELINE_ERROR_MESSAGES[code]) || message?.trim() || fallback
}
