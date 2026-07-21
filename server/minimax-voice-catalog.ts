import { characterVoiceCatalogFingerprint } from './character-voice-recommendation.js'
import {
  ProviderConfigurationError,
  ProviderService,
  type MaterializedProviderExecutionProfile,
} from './providers/service.js'

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_VOICES = 5_000
const MAX_DESCRIPTION_COUNT = 16
const MAX_DESCRIPTION_LENGTH = 1_000
const MAX_NAME_LENGTH = 300
const MAX_VOICE_ID_LENGTH = 256

export type MiniMaxVoiceType = 'system' | 'voice_cloning' | 'voice_generation'

export interface MiniMaxVoiceCatalogEntry {
  voiceId: string
  name: string
  descriptions: string[]
  type: MiniMaxVoiceType
}

export interface MiniMaxVoiceCatalog {
  providerId: 'minimax-speech'
  providerConfigRevision: number
  model: string
  observedAt: string
  fingerprint: string
  voices: MiniMaxVoiceCatalogEntry[]
}

export type MiniMaxVoiceCatalogErrorCode =
  | 'MINIMAX_VOICE_AUTH_FAILED'
  | 'MINIMAX_VOICE_CATALOG_INVALID'
  | 'MINIMAX_VOICE_CATALOG_TOO_LARGE'
  | 'MINIMAX_VOICE_CATALOG_UNAVAILABLE'
  | 'MINIMAX_VOICE_CATALOG_TIMEOUT'
  | 'MINIMAX_VOICE_RATE_LIMITED'
  | 'MINIMAX_VOICE_UPSTREAM_ERROR'
  | 'MINIMAX_VOICE_PROVIDER_INVALID'
  | 'MINIMAX_VOICE_PROVIDER_NOT_VERIFIED'

/** User-safe error. It deliberately never retains a raw upstream body/cause. */
export class MiniMaxVoiceCatalogError extends Error {
  constructor(
    readonly code: MiniMaxVoiceCatalogErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'MiniMaxVoiceCatalogError'
  }
}

export interface MiniMaxVoiceCatalogClientOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  now?: () => Date
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new TypeError(`${label} 必须是正整数`)
  return normalized
}

/**
 * Appends the official Get Voice path exactly once for either the overseas
 * (`api.minimax.io`) or mainland (`api.minimaxi.com`) registered endpoint.
 */
export function miniMaxVoiceCatalogEndpoint(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_PROVIDER_INVALID',
      'MiniMax Base URL 无效',
      false,
    )
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_PROVIDER_INVALID',
      'MiniMax Base URL 必须是无凭据的 HTTPS 地址',
      false,
    )
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/v1/get_voice')) url.pathname = path
  else if (path.endsWith('/v1')) url.pathname = `${path}/get_voice`
  else url.pathname = `${path}/v1/get_voice`
  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (Number.isFinite(declared) && declared > maximumBytes) {
      await discardBody(response)
      throw new MiniMaxVoiceCatalogError(
        'MINIMAX_VOICE_CATALOG_TOO_LARGE',
        'MiniMax 音色目录响应超过大小限制',
        false,
      )
    }
  }
  if (!response.body) {
    throw new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_CATALOG_INVALID',
      'MiniMax 返回了空音色目录',
      true,
    )
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let source = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new MiniMaxVoiceCatalogError(
          'MINIMAX_VOICE_CATALOG_TOO_LARGE',
          'MiniMax 音色目录响应超过大小限制',
          false,
        )
      }
      source += decoder.decode(chunk.value, { stream: true })
    }
    source += decoder.decode()
    return JSON.parse(source) as unknown
  } catch (error) {
    if (error instanceof MiniMaxVoiceCatalogError) throw error
    await reader.cancel().catch(() => undefined)
    throw new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_CATALOG_INVALID',
      'MiniMax 返回了无效音色目录',
      true,
    )
  } finally {
    reader.releaseLock()
  }
}

function cleanText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined
  return normalized
}

function voiceList(
  value: unknown,
  type: MiniMaxVoiceType,
  remaining: number,
): MiniMaxVoiceCatalogEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_CATALOG_INVALID',
      'MiniMax 返回了无效音色目录',
      true,
    )
  }
  if (value.length > remaining) {
    throw new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_CATALOG_TOO_LARGE',
      'MiniMax 音色目录条目超过数量限制',
      false,
    )
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new MiniMaxVoiceCatalogError(
        'MINIMAX_VOICE_CATALOG_INVALID',
        'MiniMax 返回了无效音色目录',
        true,
      )
    }
    const voiceId = cleanText(item.voice_id, MAX_VOICE_ID_LENGTH)
    if (!voiceId) {
      throw new MiniMaxVoiceCatalogError(
        'MINIMAX_VOICE_CATALOG_INVALID',
        'MiniMax 音色目录包含无效 voice_id',
        true,
      )
    }
    const name = cleanText(item.voice_name, MAX_NAME_LENGTH) ?? voiceId
    if (item.description !== undefined && !Array.isArray(item.description)) {
      throw new MiniMaxVoiceCatalogError(
        'MINIMAX_VOICE_CATALOG_INVALID',
        'MiniMax 音色目录包含无效描述',
        true,
      )
    }
    const descriptions = (item.description as unknown[] | undefined ?? [])
      .slice(0, MAX_DESCRIPTION_COUNT)
      .map((description) => cleanText(description, MAX_DESCRIPTION_LENGTH))
      .filter((description): description is string => description !== undefined)
    return { voiceId, name, descriptions, type }
  })
}

function providerStatusError(statusCode: number): MiniMaxVoiceCatalogError {
  if (statusCode === 1004 || statusCode === 2049) {
    return new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_AUTH_FAILED',
      'MiniMax API Key 无效或无权读取音色目录',
      false,
    )
  }
  if (statusCode === 1002 || statusCode === 1039 || statusCode === 1041) {
    return new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_RATE_LIMITED',
      'MiniMax 音色目录请求频率受限',
      true,
    )
  }
  return new MiniMaxVoiceCatalogError(
    'MINIMAX_VOICE_UPSTREAM_ERROR',
    `MiniMax 音色目录暂时不可用 (${statusCode})`,
    statusCode === 1000 || statusCode === 1001 || statusCode === 1024,
  )
}

function parseCatalog(payload: unknown): MiniMaxVoiceCatalogEntry[] {
  if (!isRecord(payload) || !isRecord(payload.base_resp)) {
    throw new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_CATALOG_INVALID',
      'MiniMax 返回了无效音色目录',
      true,
    )
  }
  const statusCode = payload.base_resp.status_code
  if (!Number.isInteger(statusCode)) {
    throw new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_CATALOG_INVALID',
      'MiniMax 返回了无效音色目录',
      true,
    )
  }
  if (statusCode !== 0) throw providerStatusError(statusCode as number)

  const voices: MiniMaxVoiceCatalogEntry[] = []
  voices.push(...voiceList(payload.system_voice, 'system', MAX_VOICES - voices.length))
  voices.push(...voiceList(payload.voice_cloning, 'voice_cloning', MAX_VOICES - voices.length))
  voices.push(...voiceList(payload.voice_generation, 'voice_generation', MAX_VOICES - voices.length))

  // voice_id is the only selector accepted by T2A. Resolve accidental category
  // duplicates deterministically instead of exposing an ambiguous picker.
  const unique = new Map<string, MiniMaxVoiceCatalogEntry>()
  for (const voice of voices) if (!unique.has(voice.voiceId)) unique.set(voice.voiceId, voice)
  return [...unique.values()]
}

function httpError(status: number): MiniMaxVoiceCatalogError {
  if (status === 401 || status === 403) {
    return new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_AUTH_FAILED',
      'MiniMax API Key 无效或无权读取音色目录',
      false,
      status,
    )
  }
  if (status === 408 || status === 504) {
    return new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_CATALOG_TIMEOUT',
      'MiniMax 音色目录请求超时',
      true,
      status,
    )
  }
  if (status === 429) {
    return new MiniMaxVoiceCatalogError(
      'MINIMAX_VOICE_RATE_LIMITED',
      'MiniMax 音色目录请求频率受限',
      true,
      status,
    )
  }
  return new MiniMaxVoiceCatalogError(
    status >= 500 ? 'MINIMAX_VOICE_CATALOG_UNAVAILABLE' : 'MINIMAX_VOICE_UPSTREAM_ERROR',
    `MiniMax 音色目录请求失败 (${status})`,
    status >= 500,
    status,
  )
}

function catalogFingerprint(voices: readonly MiniMaxVoiceCatalogEntry[]): string {
  return characterVoiceCatalogFingerprint(voices.map((voice) => ({
    voiceId: voice.voiceId,
    voiceName: voice.name,
    descriptions: [...voice.descriptions],
    type: voice.type,
  })))
}

export class MiniMaxVoiceCatalogClient {
  private readonly fetchImplementation: typeof fetch
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly now: () => Date

  constructor(options: MiniMaxVoiceCatalogClientOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    )
    this.now = options.now ?? (() => new Date())
  }

  async list(
    profile: MaterializedProviderExecutionProfile,
    signal?: AbortSignal,
  ): Promise<MiniMaxVoiceCatalog> {
    if (profile.providerId !== 'minimax-speech'
      || profile.kind !== 'speech'
      || profile.adapter !== 'minimax'
      || !profile.baseUrl?.trim()
      || !profile.model?.trim()
      || !profile.apiKey.trim()) {
      throw new MiniMaxVoiceCatalogError(
        'MINIMAX_VOICE_PROVIDER_INVALID',
        'MiniMax 语音 Provider 配置不完整',
        false,
      )
    }
    const timeoutController = new AbortController()
    const timeout = setTimeout(
      () => timeoutController.abort(new Error('MiniMax voice catalog timeout')),
      this.timeoutMs,
    )
    timeout.unref()
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
    let response: Response
    try {
      response = await this.fetchImplementation(miniMaxVoiceCatalogEndpoint(profile.baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${profile.apiKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ voice_type: 'all' }),
        signal: combinedSignal,
      })
    } catch {
      if (signal?.aborted) throw signal.reason
      if (timeoutController.signal.aborted) {
        throw new MiniMaxVoiceCatalogError(
          'MINIMAX_VOICE_CATALOG_TIMEOUT',
          'MiniMax 音色目录请求超时',
          true,
        )
      }
      throw new MiniMaxVoiceCatalogError(
        'MINIMAX_VOICE_CATALOG_UNAVAILABLE',
        '无法连接 MiniMax 音色目录',
        true,
      )
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      await discardBody(response)
      throw httpError(response.status)
    }
    const voices = parseCatalog(await boundedJson(response, this.maxResponseBytes))
    const observed = this.now()
    if (!Number.isFinite(observed.getTime())) throw new TypeError('now() 返回了无效时间')
    return {
      providerId: 'minimax-speech',
      providerConfigRevision: profile.configRevision,
      model: profile.model,
      observedAt: observed.toISOString(),
      fingerprint: catalogFingerprint(voices),
      voices,
    }
  }
}

export class MiniMaxVoiceCatalogService {
  constructor(
    private readonly providers: ProviderService,
    private readonly client: MiniMaxVoiceCatalogClient,
  ) {}

  async list(signal?: AbortSignal): Promise<MiniMaxVoiceCatalog> {
    let profile: MaterializedProviderExecutionProfile
    try {
      profile = await this.providers.materializeCurrentVerifiedProfile('minimax-speech')
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        throw new MiniMaxVoiceCatalogError(
          error.code === 'PROVIDER_NOT_VERIFIED'
            ? 'MINIMAX_VOICE_PROVIDER_NOT_VERIFIED'
            : 'MINIMAX_VOICE_PROVIDER_INVALID',
          error.code === 'PROVIDER_NOT_VERIFIED'
            ? '请先保存并测试 MiniMax 语音 Provider，确认当前连接可用'
            : 'MiniMax 语音 Provider 配置不可用',
          false,
        )
      }
      throw error
    }
    return this.client.list(profile, signal)
  }
}
