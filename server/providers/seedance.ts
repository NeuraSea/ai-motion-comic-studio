const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3'
const DEFAULT_MODEL = 'doubao-seedance-2.0'
const MAX_JSON_BYTES = 256 * 1024
const MAX_PROMPT_LENGTH = 20_000
const MAX_TASK_ID_LENGTH = 240
const MAX_REFERENCE_IMAGE_DATA_URL_LENGTH = 40 * 1024 * 1024 + 128
const MAX_REFERENCE_IMAGES_ENCODED_LENGTH = 60 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_TIMEOUT_MS = 120_000

export const SEEDANCE_ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const
export const SEEDANCE_RESOLUTIONS = ['480p', '720p', '1080p'] as const
export const SEEDANCE_TASK_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const

export type SeedanceAspectRatio = (typeof SEEDANCE_ASPECT_RATIOS)[number]
export type SeedanceResolution = (typeof SEEDANCE_RESOLUTIONS)[number]
export type SeedanceTaskStatus = (typeof SEEDANCE_TASK_STATUSES)[number]
export type SeedanceImageRole = 'first_frame' | 'last_frame' | 'reference_image'
export type SeedanceProviderProtocol = 'ark' | 'newapi'
export type SeedanceCancellationCapability = 'upstream-delete' | 'local-only'
export type SeedanceCancellationOutcome = 'requested' | 'unsupported' | 'task-not-found'

export interface SeedanceCancellationResult {
  capability: SeedanceCancellationCapability
  outcome: SeedanceCancellationOutcome
}

export interface SeedanceImageReference {
  /** Server-resolved HTTPS or bounded image data URL. Never accept this from an untrusted client. */
  url: string
  role: SeedanceImageRole
}

export interface SeedanceCreateTaskInput {
  prompt: string
  aspectRatio: SeedanceAspectRatio
  resolution: SeedanceResolution
  durationSeconds: number
  /** Keep Seedance audio generation opt-in so it cannot conflict with the separate dialogue mix. */
  generateAudio: boolean
  /** Server-resolved references only. The roles select one of Seedance's mutually exclusive image modes. */
  referenceImages?: readonly SeedanceImageReference[]
}

export interface SeedanceTaskError {
  code: string
  message: string
}

export interface SeedanceTask {
  id: string
  model: string | null
  status: SeedanceTaskStatus
  createdAt: number | null
  updatedAt: number | null
  videoUrl: string | null
  durationSeconds: number | null
  resolution: string | null
  aspectRatio: string | null
  completionTokens: number | null
  error: SeedanceTaskError | null
}

export interface SeedanceCreateTaskResult {
  id: string
}

export interface SeedanceProviderDiagnostic {
  operation: 'create' | 'get' | 'cancel'
  protocol: SeedanceProviderProtocol
  endpointFamily: 'ark-tasks' | 'openai-videos'
  httpStatus: number
  providerCode?: string
}

export class SeedanceProviderError extends Error {
  constructor(
    readonly code:
      | 'CONTENT_REJECTED'
      | 'INVALID_RESPONSE'
      | 'INVALID_VIDEO_REQUEST'
      | 'PROVIDER_AUTH_FAILED'
      | 'PROVIDER_BILLING_UNAVAILABLE'
      | 'PROVIDER_NOT_CONFIGURED'
      | 'PROVIDER_RATE_LIMITED'
      | 'TASK_NOT_FOUND'
      | 'UPSTREAM_ERROR'
      | 'UPSTREAM_TIMEOUT'
      | 'UPSTREAM_UNAVAILABLE',
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
    readonly diagnostic?: SeedanceProviderDiagnostic,
  ) {
    super(message, options)
    this.name = 'SeedanceProviderError'
  }
}

export interface SeedanceVideoProviderOptions {
  baseUrl?: string
  apiKey?: string | null
  model?: string
  fetch?: typeof fetch
  /**
   * `auto` keeps the official metered `/api/v3` and subscription
   * `/api/plan/v3` URLs on Ark's native contract, and treats any other
   * configured base as a NewAPI/OpenAI-compatible gateway.
   */
  protocol?: SeedanceProviderProtocol | 'auto'
  /** Bounds each complete Provider HTTP exchange, including its response body. */
  requestTimeoutMs?: number
  /** Tests only. Production Provider profiles must remain HTTPS. */
  allowInsecureLocalhost?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

function normalizeBaseUrl(value: string, allowInsecureLocalhost: boolean): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new SeedanceProviderError(
      'PROVIDER_NOT_CONFIGURED',
      'Seedance Provider 地址无效',
      false,
    )
  }
  const allowedHttp = allowInsecureLocalhost && url.protocol === 'http:' && isLocalHostname(url.hostname)
  if (url.protocol !== 'https:' && !allowedHttp) {
    throw new SeedanceProviderError(
      'PROVIDER_NOT_CONFIGURED',
      'Seedance Provider 必须使用 HTTPS',
      false,
    )
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SeedanceProviderError(
      'PROVIDER_NOT_CONFIGURED',
      'Seedance Provider 地址不能包含凭据、查询参数或片段',
      false,
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

function arkEndpoint(baseUrl: URL, taskId?: string): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname}/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ''}`
  return url.toString()
}

function inferredProtocol(baseUrl: URL): SeedanceProviderProtocol {
  return /\/api\/(?:plan\/)?v3\/?$/.test(baseUrl.pathname) ? 'ark' : 'newapi'
}

function newApiEndpoint(baseUrl: URL, taskId?: string): string {
  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/+$/, '')
  const v1Path = /\/v1$/.test(basePath) ? basePath : `${basePath}/v1`
  url.pathname = `${v1Path}/videos${taskId ? `/${encodeURIComponent(taskId)}` : ''}`
  return url.toString()
}

function providerEndpoint(
  baseUrl: URL,
  protocol: SeedanceProviderProtocol,
  taskId?: string,
): string {
  return protocol === 'ark'
    ? arkEndpoint(baseUrl, taskId)
    : newApiEndpoint(baseUrl, taskId)
}

function cleanModel(value: string): string {
  const model = value.trim()
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new SeedanceProviderError(
      'PROVIDER_NOT_CONFIGURED',
      'Seedance 模型名无效',
      false,
    )
  }
  return model
}

function validTaskId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_TASK_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
}

function validateReferenceUrl(value: string): string {
  if (typeof value !== 'string') {
    throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance 参考图 URL 无效', false)
  }
  if (value.length <= MAX_REFERENCE_IMAGE_DATA_URL_LENGTH
    && /^data:image\/(?:gif|jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return value
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance 参考图 URL 无效', false)
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new SeedanceProviderError(
      'INVALID_VIDEO_REQUEST',
      'Seedance 参考图必须使用无凭据的 HTTPS URL',
      false,
    )
  }
  return url.toString()
}

function validateReferenceImages(value: readonly SeedanceImageReference[]): SeedanceImageReference[] {
  if (value.length > 9) {
    throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance 2.0 最多接受 9 张参考图', false)
  }
  const references = value.map((reference) => {
    if (!reference || typeof reference !== 'object'
      || !['first_frame', 'last_frame', 'reference_image'].includes(reference.role)) {
      throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance 参考图角色无效', false)
    }
    return { url: validateReferenceUrl(reference.url), role: reference.role }
  })
  if (references.reduce((total, reference) => total + reference.url.length, 0)
    > MAX_REFERENCE_IMAGES_ENCODED_LENGTH) {
    throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance 参考图请求体超过安全大小限制', false)
  }
  const firstFrames = references.filter((reference) => reference.role === 'first_frame')
  const lastFrames = references.filter((reference) => reference.role === 'last_frame')
  const referenceImages = references.filter((reference) => reference.role === 'reference_image')
  const frameMode = firstFrames.length > 0 || lastFrames.length > 0
  if (firstFrames.length > 1
    || lastFrames.length > 1
    || (lastFrames.length === 1 && firstFrames.length !== 1)
    || (frameMode && referenceImages.length > 0)) {
    throw new SeedanceProviderError(
      'INVALID_VIDEO_REQUEST',
      'Seedance 首尾帧模式与多参考图模式不能混用，尾帧必须与首帧同时提供',
      false,
    )
  }
  return references
}

function validateCreateInput(input: SeedanceCreateTaskInput): SeedanceCreateTaskInput {
  const prompt = input.prompt.trim()
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH || prompt.includes('\u0000')) {
    throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance 视频提示词无效', false)
  }
  if (!SEEDANCE_ASPECT_RATIOS.includes(input.aspectRatio)) {
    throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance 视频宽高比无效', false)
  }
  if (!SEEDANCE_RESOLUTIONS.includes(input.resolution)) {
    throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance 视频分辨率无效', false)
  }
  if (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 4 || input.durationSeconds > 15) {
    throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance 2.0 时长必须为 4 到 15 秒', false)
  }
  if (typeof input.generateAudio !== 'boolean') {
    throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance generateAudio 必须是布尔值', false)
  }
  const references = validateReferenceImages(input.referenceImages ?? [])
  return {
    ...input,
    prompt,
    referenceImages: references,
  }
}

function providerPrompt(input: SeedanceCreateTaskInput): string {
  // Ark's documented video-generation contract carries generation controls in
  // the text content. Keep the server-selected values last so the durable job
  // binding, not a mutable UI default, determines the billed request.
  return `${input.prompt}\n--ratio ${input.aspectRatio} --dur ${input.durationSeconds} --resolution ${input.resolution}`
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > MAX_JSON_BYTES) {
      await discardBody(response)
      throw new SeedanceProviderError('INVALID_RESPONSE', 'Seedance 返回内容过大', true)
    }
  }
  if (!response.body) {
    throw new SeedanceProviderError('INVALID_RESPONSE', 'Seedance 返回了空响应', true)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new SeedanceProviderError('INVALID_RESPONSE', 'Seedance 返回内容过大', true)
      }
      chunks.push(decoder.decode(result.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return JSON.parse(chunks.join('')) as unknown
  } catch (error) {
    if (error instanceof SeedanceProviderError) throw error
    await reader.cancel().catch(() => undefined)
    throw new SeedanceProviderError('INVALID_RESPONSE', 'Seedance 返回了无效 JSON', true)
  } finally {
    reader.releaseLock()
  }
}

function upstreamErrorCode(body: unknown): string {
  if (!isRecord(body)) return ''
  const direct = body.code
  const nested = isRecord(body.error) ? body.error.code : undefined
  const value = typeof nested === 'string' || typeof nested === 'number'
    ? String(nested)
    : typeof direct === 'string' || typeof direct === 'number'
      ? String(direct)
      : ''
  const normalized = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized) ? normalized : ''
}

function isContentRejection(code: string): boolean {
  const normalized = code.toLowerCase()
  return normalized.includes('sensitive')
    || normalized.includes('contentpolicy')
    || normalized.includes('content_policy')
}

function isBillingUnavailable(code: string): boolean {
  const normalized = code.toLowerCase()
  return normalized === 'accountoverdueerror'
    || normalized.includes('account_overdue')
    || normalized.includes('billing')
}

function responseError(
  response: Response,
  body: unknown,
  operation: 'create' | 'get' | 'cancel',
  protocol: SeedanceProviderProtocol,
): SeedanceProviderError {
  const code = upstreamErrorCode(body)
  const diagnostic: SeedanceProviderDiagnostic = {
    operation,
    protocol,
    endpointFamily: protocol === 'ark' ? 'ark-tasks' : 'openai-videos',
    httpStatus: response.status,
    ...(code ? { providerCode: code } : {}),
  }
  const providerError = (
    errorCode: SeedanceProviderError['code'],
    message: string,
    retryable: boolean,
  ) => new SeedanceProviderError(errorCode, message, retryable, undefined, diagnostic)
  if (isContentRejection(code)) {
    return providerError('CONTENT_REJECTED', 'Seedance 拒绝了不符合内容规范的输入或输出', false)
  }
  if (isBillingUnavailable(code)) {
    return providerError(
      'PROVIDER_BILLING_UNAVAILABLE',
      'Seedance 方舟账号欠费或授信不可用，请恢复账户计费状态后重新预检并确认生成',
      false,
    )
  }
  if (response.status === 401 || response.status === 403) {
    return providerError('PROVIDER_AUTH_FAILED', 'Seedance API Key 无效或无权访问模型', false)
  }
  if (operation !== 'create'
    && (response.status === 404 || code.toLowerCase() === 'task_not_exist')) {
    return providerError('TASK_NOT_FOUND', 'Seedance 视频任务不存在或已过期', false)
  }
  if (response.status === 408 || response.status === 504) {
    return providerError('UPSTREAM_TIMEOUT', 'Seedance 服务响应超时，请稍后重试', true)
  }
  if (response.status === 429) {
    return providerError('PROVIDER_RATE_LIMITED', 'Seedance 任务配额或请求频率受限', true)
  }
  if (response.status >= 500) {
    return providerError('UPSTREAM_UNAVAILABLE', 'Seedance 服务暂时不可用', true)
  }
  return providerError(
    'UPSTREAM_ERROR',
    `Seedance ${operation === 'create' ? '创建' : operation === 'get' ? '查询' : '取消'}任务失败 (${response.status})`,
    false,
  )
}

function nullableInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function nullableNumber(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  return Number.isFinite(number) && number >= 0 ? number : null
}

function nullableText(value: unknown, maxLength = 200): string | null {
  return typeof value === 'string' && value.length <= maxLength ? value : null
}

function taskPayload(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null
  // The OpenAI-compatible route returns the video object directly. Older
  // NewAPI task routes wrap the same public task object in `{code, data}`.
  return isRecord(body.data) && (body.code === 'success' || body.id === undefined)
    ? body.data
    : body
}

function taskIdFromBody(body: unknown): string | null {
  const payload = taskPayload(body)
  if (!payload) return null
  if (validTaskId(payload.id) && validTaskId(payload.task_id) && payload.id !== payload.task_id) {
    return null
  }
  if (validTaskId(payload.id)) return payload.id
  if (validTaskId(payload.task_id)) return payload.task_id
  return null
}

function normalizedTaskStatus(value: unknown): SeedanceTaskStatus | null {
  if (typeof value !== 'string') return null
  switch (value.trim().toLowerCase()) {
    case 'pending':
    case 'submitted':
    case 'queued':
      return 'queued'
    case 'processing':
    case 'in_progress':
    case 'running':
      return 'running'
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'succeeded'
    case 'failure':
    case 'failed':
      return 'failed'
    case 'canceled':
    case 'cancelled':
      return 'cancelled'
    case 'expired':
      return 'expired'
    default:
      return null
  }
}

function safeVideoUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 8_192) {
    throw new SeedanceProviderError('INVALID_RESPONSE', 'Seedance 返回了无效视频 URL', true)
  }
  try {
    const parsed = new URL(value)
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
      throw new Error('unsafe URL')
    }
    return parsed.toString()
  } catch {
    throw new SeedanceProviderError('INVALID_RESPONSE', 'Seedance 返回了无效视频 URL', true)
  }
}

function taskFromBody(body: unknown, expectedId: string): SeedanceTask {
  const payload = taskPayload(body)
  const responseId = taskIdFromBody(body)
  const status = normalizedTaskStatus(payload?.status)
  if (!payload || responseId !== expectedId || !status) {
    throw new SeedanceProviderError('INVALID_RESPONSE', 'Seedance 返回了无效任务状态', true)
  }
  const content = isRecord(payload.content) ? payload.content : null
  const metadata = isRecord(payload.metadata) ? payload.metadata : null
  const error = isRecord(payload.error) ? payload.error : null
  const usage = isRecord(payload.usage) ? payload.usage : null
  const videoUrl = safeVideoUrl(
    content?.video_url
      ?? metadata?.url
      ?? payload.url
      ?? payload.result_url,
  )
  if (status === 'succeeded' && !videoUrl) {
    throw new SeedanceProviderError('INVALID_RESPONSE', 'Seedance 成功任务未返回视频 URL', true)
  }
  const rawErrorCode = nullableText(error?.code, 160)
    ?? (status === 'failed' ? nullableText(payload.fail_reason, 160) : null)
    ?? (status === 'failed' ? 'SEEDANCE_TASK_FAILED' : null)
  const taskError = status === 'failed' && rawErrorCode
    ? {
        code: rawErrorCode,
        message: isContentRejection(rawErrorCode)
          ? 'Seedance 内容安全检查未通过'
          : 'Seedance 视频生成失败',
      }
    : null
  return {
    id: expectedId,
    model: nullableText(payload.model),
    status,
    createdAt: nullableInteger(payload.created_at),
    updatedAt: nullableInteger(payload.updated_at)
      ?? nullableInteger(payload.completed_at),
    videoUrl,
    durationSeconds: nullableNumber(payload.duration)
      ?? nullableNumber(payload.seconds)
      ?? nullableNumber(metadata?.duration),
    resolution: nullableText(payload.resolution, 40)
      ?? nullableText(payload.size, 40)
      ?? nullableText(metadata?.resolution, 40),
    aspectRatio: nullableText(payload.ratio, 40)
      ?? nullableText(metadata?.ratio, 40),
    completionTokens: nullableInteger(usage?.completion_tokens),
    error: taskError,
  }
}

export interface SeedanceVideoProviderContract {
  readonly name: string
  readonly model: string
  readonly configured: boolean
  readonly cancellationCapability: SeedanceCancellationCapability
  createTask(input: SeedanceCreateTaskInput, signal?: AbortSignal): Promise<SeedanceCreateTaskResult>
  getTask(taskId: string, signal?: AbortSignal): Promise<SeedanceTask>
  cancelTask(taskId: string, signal?: AbortSignal): Promise<SeedanceCancellationResult>
}

export class SeedanceVideoProvider implements SeedanceVideoProviderContract {
  readonly name = 'seedance'
  readonly model: string
  readonly configured: boolean
  readonly protocol: SeedanceProviderProtocol
  readonly cancellationCapability: SeedanceCancellationCapability
  private readonly apiKey: string | null
  private readonly baseUrl: URL
  private readonly tasksEndpoint: string
  private readonly fetchImplementation: typeof fetch
  private readonly requestTimeoutMs: number

  constructor(options: SeedanceVideoProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || null
    this.configured = this.apiKey !== null
    this.model = cleanModel(options.model ?? DEFAULT_MODEL)
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? DEFAULT_BASE_URL,
      options.allowInsecureLocalhost === true,
    )
    this.protocol = options.protocol && options.protocol !== 'auto'
      ? options.protocol
      : inferredProtocol(this.baseUrl)
    this.cancellationCapability = this.protocol === 'ark' ? 'upstream-delete' : 'local-only'
    this.tasksEndpoint = providerEndpoint(this.baseUrl, this.protocol)
    this.fetchImplementation = options.fetch ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    if (!Number.isInteger(this.requestTimeoutMs)
      || this.requestTimeoutMs < 1
      || this.requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new RangeError(`requestTimeoutMs must be between 1 and ${MAX_REQUEST_TIMEOUT_MS}`)
    }
  }

  async createTask(
    rawInput: SeedanceCreateTaskInput,
    signal?: AbortSignal,
  ): Promise<SeedanceCreateTaskResult> {
    const apiKey = this.requireApiKey()
    const input = validateCreateInput(rawInput)
    const references: Array<Record<string, unknown>> = []
    for (const reference of input.referenceImages ?? []) {
      references.push({
        type: 'image_url',
        image_url: { url: reference.url },
        role: reference.role,
      })
    }
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: providerPrompt(input) },
      ...references,
    ]
    const requestBody = this.protocol === 'ark'
      ? {
          model: this.model,
          content,
          generate_audio: input.generateAudio,
          ratio: input.aspectRatio,
          duration: input.durationSeconds,
          resolution: input.resolution,
          watermark: false,
          return_last_frame: false,
        }
      : {
          // Neurasea/NewAPI's OpenAI-compatible video route accepts the
          // generic fields and forwards Seedance-specific controls through
          // metadata. Send both duration forms because deployed NewAPI forks
          // differ on whether they normalize `duration` or `seconds` first.
          model: this.model,
          prompt: input.prompt,
          duration: input.durationSeconds,
          seconds: String(input.durationSeconds),
          metadata: {
            content: references,
            duration: input.durationSeconds,
            resolution: input.resolution,
            ratio: input.aspectRatio,
            generate_audio: input.generateAudio,
            watermark: false,
            return_last_frame: false,
          },
        }
    const { response, body } = await this.requestJson(this.tasksEndpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
    }, signal)
    if (!response.ok) throw responseError(response, body, 'create', this.protocol)
    const taskId = taskIdFromBody(body)
    if (!taskId) {
      throw new SeedanceProviderError('INVALID_RESPONSE', 'Seedance 未返回有效任务 ID', true)
    }
    return { id: taskId }
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<SeedanceTask> {
    const apiKey = this.requireApiKey()
    if (!validTaskId(taskId)) {
      throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance 任务 ID 无效', false)
    }
    const { response, body } = await this.requestJson(
      providerEndpoint(this.baseUrl, this.protocol, taskId),
      {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      },
      signal,
    )
    if (!response.ok) throw responseError(response, body, 'get', this.protocol)
    return taskFromBody(body, taskId)
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<SeedanceCancellationResult> {
    if (!validTaskId(taskId)) {
      throw new SeedanceProviderError('INVALID_VIDEO_REQUEST', 'Seedance 任务 ID 无效', false)
    }
    // NewAPI's public video contract has no upstream cancellation route. Do
    // not send a knowingly unsupported DELETE and do not present a 404/405 as
    // a successful cancellation. The durable worker will stop polling locally
    // and surface that the Provider task may continue and remain billable.
    if (this.cancellationCapability === 'local-only') {
      return { capability: this.cancellationCapability, outcome: 'unsupported' }
    }
    const apiKey = this.requireApiKey()
    const { response, body } = await this.requestWithTimeout(signal, async (requestSignal) => {
      const response = await this.fetchImplementation(
        providerEndpoint(this.baseUrl, this.protocol, taskId),
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
          signal: requestSignal,
        },
      )
      if (response.ok) {
        await discardBody(response)
        return { response, body: null }
      }
      return { response, body: await this.responseBody(response) }
    })
    if (response.ok) {
      return { capability: this.cancellationCapability, outcome: 'requested' }
    }
    // An Ark 404 is idempotent from the local stop perspective, but it does
    // not prove the task was cancelled rather than completed or expired.
    if (response.status === 404) {
      return { capability: this.cancellationCapability, outcome: 'task-not-found' }
    }
    throw responseError(response, body, 'cancel', this.protocol)
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new SeedanceProviderError(
        'PROVIDER_NOT_CONFIGURED',
        '未配置 Seedance API Key',
        false,
      )
    }
    return this.apiKey
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ response: Response; body: unknown }> {
    return this.requestWithTimeout(signal, async (requestSignal) => {
      const response = await this.fetchImplementation(url, { ...init, signal: requestSignal })
      return { response, body: await this.responseBody(response) }
    })
  }

  private async requestWithTimeout<T>(
    callerSignal: AbortSignal | undefined,
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs)
    const requestSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal
    try {
      return await request(requestSignal)
    } catch (error) {
      // A worker cancellation or the handler-wide deadline owns its own
      // classification. Do not disguise it as a per-request timeout.
      if (callerSignal?.aborted) throw callerSignal.reason ?? error
      if (timeoutSignal.aborted) {
        throw new SeedanceProviderError(
          'UPSTREAM_TIMEOUT',
          'Seedance 单次请求超时，请稍后重试',
          true,
          { cause: error },
        )
      }
      if (error instanceof SeedanceProviderError) throw error
      throw new SeedanceProviderError(
        'UPSTREAM_UNAVAILABLE',
        '无法连接 Seedance 服务',
        true,
        { cause: error },
      )
    }
  }

  private async responseBody(response: Response): Promise<unknown> {
    try {
      return await readBoundedJson(response)
    } catch (error) {
      if (error instanceof SeedanceProviderError) throw error
      throw new SeedanceProviderError(
        'INVALID_RESPONSE',
        'Seedance 返回了无效响应',
        true,
        { cause: error },
      )
    }
  }
}
