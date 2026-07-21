import { characterVoiceCatalogFingerprint } from './character-voice-recommendation.js'
import type { MiniMaxVoiceCatalogEntry, MiniMaxVoiceType } from './minimax-voice-catalog.js'
import {
  ProviderConfigurationError,
  ProviderService,
  type MaterializedProviderExecutionProfile,
} from './providers/service.js'

const DEFAULT_TIMEOUT_MS = 8_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export interface IndexTtsVoiceCatalog {
  providerId: 'indextts-speech'
  providerConfigRevision: number
  model: string
  observedAt: string
  fingerprint: string
  voices: MiniMaxVoiceCatalogEntry[]
}

export class IndexTtsVoiceCatalogError extends Error {
  constructor(
    readonly code:
      | 'INDEXTTS_VOICE_AUTH_FAILED'
      | 'INDEXTTS_VOICE_CATALOG_INVALID'
      | 'INDEXTTS_VOICE_CATALOG_UNAVAILABLE'
      | 'INDEXTTS_VOICE_CATALOG_TIMEOUT'
      | 'INDEXTTS_VOICE_PROVIDER_INVALID'
      | 'INDEXTTS_VOICE_PROVIDER_NOT_VERIFIED',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'IndexTtsVoiceCatalogError'
  }
}

function endpointFor(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? `${path}/voices` : `${path}/v1/voices`
  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim()
  return cleaned && cleaned.length <= maximum && !/[\u0000-\u001f\u007f]/.test(cleaned)
    ? cleaned
    : undefined
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new IndexTtsVoiceCatalogError(
      'INDEXTTS_VOICE_CATALOG_INVALID',
      'IndexTTS 声线目录响应过大',
      false,
    )
  }
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new IndexTtsVoiceCatalogError(
      'INDEXTTS_VOICE_CATALOG_INVALID',
      'IndexTTS 声线目录响应过大',
      false,
    )
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new IndexTtsVoiceCatalogError(
      'INDEXTTS_VOICE_CATALOG_INVALID',
      'IndexTTS 返回了无效声线目录',
      true,
    )
  }
}

function parseVoices(payload: unknown): MiniMaxVoiceCatalogEntry[] {
  if (!isRecord(payload) || !Array.isArray(payload.voices) || payload.voices.length > 5_000) {
    throw new IndexTtsVoiceCatalogError(
      'INDEXTTS_VOICE_CATALOG_INVALID',
      'IndexTTS 返回了无效声线目录',
      true,
    )
  }
  const seen = new Set<string>()
  return payload.voices.map((item) => {
    if (!isRecord(item)) throw new IndexTtsVoiceCatalogError('INDEXTTS_VOICE_CATALOG_INVALID', 'IndexTTS 声线条目无效', true)
    const voiceId = cleanText(item.voice_id, 256)
    const name = cleanText(item.name, 300)
    const description = cleanText(item.description, 1_000)
    const type: MiniMaxVoiceType = item.type === 'voice_generation'
      ? 'voice_generation'
      : item.type === 'system'
        ? 'system'
        : 'voice_cloning'
    if (!voiceId || !name || seen.has(voiceId)) {
      throw new IndexTtsVoiceCatalogError('INDEXTTS_VOICE_CATALOG_INVALID', 'IndexTTS 声线 ID 无效或重复', true)
    }
    seen.add(voiceId)
    const tags = Array.isArray(item.tags)
      ? item.tags.map((tag) => cleanText(tag, 100)).filter((tag): tag is string => Boolean(tag)).slice(0, 16)
      : []
    return {
      voiceId,
      name,
      descriptions: [...(description ? [description] : []), ...tags],
      type,
    }
  })
}

export class IndexTtsVoiceCatalogClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async list(
    profile: MaterializedProviderExecutionProfile,
    signal?: AbortSignal,
  ): Promise<IndexTtsVoiceCatalog> {
    if (profile.providerId !== 'indextts-speech'
      || profile.kind !== 'speech'
      || profile.adapter !== 'indextts'
      || !profile.baseUrl?.trim()
      || !profile.model?.trim()
      || !profile.apiKey.trim()) {
      throw new IndexTtsVoiceCatalogError(
        'INDEXTTS_VOICE_PROVIDER_INVALID',
        'IndexTTS Provider 配置不完整',
        false,
      )
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('IndexTTS voice catalog timeout')), DEFAULT_TIMEOUT_MS)
    timer.unref()
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    let response: Response
    try {
      response = await this.fetcher(endpointFor(profile.baseUrl), {
        headers: { authorization: `Bearer ${profile.apiKey}`, accept: 'application/json' },
        signal: combined,
      })
    } catch {
      if (signal?.aborted) throw signal.reason
      throw new IndexTtsVoiceCatalogError(
        timeout.signal.aborted ? 'INDEXTTS_VOICE_CATALOG_TIMEOUT' : 'INDEXTTS_VOICE_CATALOG_UNAVAILABLE',
        timeout.signal.aborted ? 'IndexTTS 声线目录请求超时' : '无法连接 IndexTTS 声线目录',
        true,
      )
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new IndexTtsVoiceCatalogError(
        response.status === 401 || response.status === 403
          ? 'INDEXTTS_VOICE_AUTH_FAILED'
          : 'INDEXTTS_VOICE_CATALOG_UNAVAILABLE',
        response.status === 401 || response.status === 403
          ? 'IndexTTS Sidecar Token 无效'
          : `IndexTTS 声线目录暂时不可用 (${response.status})`,
        response.status >= 500,
      )
    }
    const voices = parseVoices(await boundedJson(response))
    const observedAt = new Date().toISOString()
    return {
      providerId: 'indextts-speech',
      providerConfigRevision: profile.configRevision,
      model: profile.model,
      observedAt,
      fingerprint: characterVoiceCatalogFingerprint(voices.map((voice) => ({
        voiceId: voice.voiceId,
        voiceName: voice.name,
        descriptions: voice.descriptions,
        type: voice.type,
      }))),
      voices,
    }
  }
}

export class IndexTtsVoiceCatalogService {
  constructor(
    private readonly providers: ProviderService,
    private readonly client: IndexTtsVoiceCatalogClient,
  ) {}

  async list(signal?: AbortSignal): Promise<IndexTtsVoiceCatalog> {
    let profile: MaterializedProviderExecutionProfile
    try {
      profile = await this.providers.materializeCurrentVerifiedProfile('indextts-speech')
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        throw new IndexTtsVoiceCatalogError(
          error.code === 'PROVIDER_NOT_VERIFIED'
            ? 'INDEXTTS_VOICE_PROVIDER_NOT_VERIFIED'
            : 'INDEXTTS_VOICE_PROVIDER_INVALID',
          error.code === 'PROVIDER_NOT_VERIFIED'
            ? '请先保存并测试 IndexTTS Provider'
            : 'IndexTTS Provider 配置不可用',
          false,
        )
      }
      throw error
    }
    return this.client.list(profile, signal)
  }
}

