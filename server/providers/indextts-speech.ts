import { detectMediaMime, MediaStoreError } from '../media.js'
import {
  SpeechProviderError,
  type MiniMaxSpeechInput,
  type MiniMaxSpeechResult,
  type SpeechProvider,
} from './minimax-tts.js'

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_AUDIO_BYTES = 30 * 1024 * 1024
const MAX_TEXT_CODE_POINTS = 4_096
const MAX_VOICE_LENGTH = 200

export interface IndexTtsSpeechProviderOptions {
  name?: string
  baseUrl: string
  apiKey?: string | null
  model: string
  timeoutMs?: number
  maxAudioBytes?: number
  fetch?: typeof fetch
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`)
  return value
}

function endpointFor(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new TypeError('IndexTTS Base URL 无效')
  }
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username || url.password || url.search || url.hash) {
    throw new TypeError('IndexTTS Base URL 必须是无凭据 HTTPS URL（本机可使用 HTTP）')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? `${path}/audio/speech` : `${path}/v1/audio/speech`
  return url.toString()
}

function expectedMime(format: 'mp3' | 'wav'): string {
  return format === 'wav' ? 'audio/wav' : 'audio/mpeg'
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

function httpError(status: number): SpeechProviderError {
  if (status === 401 || status === 403) {
    return new SpeechProviderError('PROVIDER_AUTH_FAILED', 'IndexTTS Sidecar Token 无效', false, status)
  }
  if (status === 404 || status === 422) {
    return new SpeechProviderError('INVALID_INPUT', 'IndexTTS 模型、声线或请求参数无效', false, status)
  }
  if (status === 408 || status === 504) {
    return new SpeechProviderError('UPSTREAM_TIMEOUT', 'IndexTTS 推理超时', true, status)
  }
  if (status === 429) {
    return new SpeechProviderError('PROVIDER_RATE_LIMITED', 'IndexTTS 推理队列已满', true, status)
  }
  if (status >= 500) {
    return new SpeechProviderError('UPSTREAM_UNAVAILABLE', `IndexTTS Sidecar 暂时不可用 (${status})`, true, status)
  }
  return new SpeechProviderError('INVALID_INPUT', `IndexTTS Sidecar 拒绝了请求 (${status})`, false, status)
}

async function readBoundedAudio(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await discardBody(response)
    throw new SpeechProviderError('AUDIO_TOO_LARGE', 'IndexTTS 返回的音频超过大小限制', false)
  }
  if (!response.body) throw new SpeechProviderError('INVALID_RESPONSE', 'IndexTTS 返回了空响应', true)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new SpeechProviderError('AUDIO_TOO_LARGE', 'IndexTTS 返回的音频超过大小限制', false)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new SpeechProviderError('INVALID_RESPONSE', 'IndexTTS 返回了空音频', true)
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

export class IndexTtsSpeechProvider implements SpeechProvider {
  readonly name: string
  readonly model: string
  readonly configured: boolean
  readonly #apiKey: string | null
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly maxAudioBytes: number
  private readonly fetcher: typeof fetch

  constructor(options: IndexTtsSpeechProviderOptions) {
    this.name = options.name?.trim() || 'indextts-speech'
    this.model = options.model.trim()
    this.#apiKey = options.apiKey?.trim() || null
    this.configured = Boolean(this.model && this.#apiKey)
    this.endpoint = endpointFor(options.baseUrl)
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.maxAudioBytes = positiveInteger(options.maxAudioBytes, DEFAULT_MAX_AUDIO_BYTES, 'maxAudioBytes')
    this.fetcher = options.fetch ?? fetch
  }

  async synthesize(input: MiniMaxSpeechInput, signal?: AbortSignal): Promise<MiniMaxSpeechResult> {
    if (!this.configured || !this.#apiKey) {
      throw new SpeechProviderError('PROVIDER_NOT_CONFIGURED', 'IndexTTS Provider 未配置 Token 或模型', false)
    }
    if (signal?.aborted) throw abortReason(signal)
    const text = input.text.trim()
    const voice = input.voiceId.trim()
    const format = input.format ?? 'wav'
    const speed = input.speed ?? 1
    const emotion = input.emotion ?? 'calm'
    if (!text || [...text].length > MAX_TEXT_CODE_POINTS) {
      throw new SpeechProviderError('INVALID_INPUT', `语音文本必须为 1–${MAX_TEXT_CODE_POINTS} 个字符`, false)
    }
    if (!voice || voice.length > MAX_VOICE_LENGTH || /[\u0000-\u001f\u007f]/.test(voice)) {
      throw new SpeechProviderError('INVALID_INPUT', 'IndexTTS 声线 ID 无效', false)
    }
    if (format !== 'mp3' && format !== 'wav') {
      throw new SpeechProviderError('INVALID_INPUT', 'IndexTTS 只支持 mp3 或 wav 输出', false)
    }
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
      throw new SpeechProviderError('INVALID_INPUT', 'IndexTTS speed 必须介于 0.5 和 2 之间', false)
    }
    if (input.volume !== undefined && input.volume !== 1) {
      throw new SpeechProviderError('INVALID_INPUT', 'IndexTTS 不支持合成阶段音量控制，请在时间线调整', false)
    }
    if (input.pitch !== undefined && input.pitch !== 0) {
      throw new SpeechProviderError('INVALID_INPUT', 'IndexTTS 不支持音高控制', false)
    }
    if (input.pronunciationDictionary !== undefined) {
      throw new SpeechProviderError('INVALID_INPUT', 'IndexTTS 暂不支持 MiniMax 发音词典', false)
    }

    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('IndexTTS timeout')), this.timeoutMs)
    timer.unref()
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    let response: Response
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          accept: expectedMime(format),
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          voice,
          response_format: format,
          speed,
          emotion,
          emotion_alpha: 0.65,
        }),
        signal: requestSignal,
      })
    } catch {
      clearTimeout(timer)
      if (signal?.aborted) throw abortReason(signal)
      if (timeout.signal.aborted) throw new SpeechProviderError('UPSTREAM_TIMEOUT', 'IndexTTS 推理超时', true)
      throw new SpeechProviderError('UPSTREAM_UNAVAILABLE', '无法连接 IndexTTS Sidecar', true)
    }
    try {
      if (!response.ok) {
        await discardBody(response)
        throw httpError(response.status)
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      const allowed = new Set([expectedMime(format), ...(format === 'wav' ? ['audio/x-wav'] : [])])
      if (!contentType || !allowed.has(contentType)) {
        await discardBody(response)
        throw new SpeechProviderError('INVALID_RESPONSE', 'IndexTTS 返回了非音频响应', true)
      }
      const bytes = await readBoundedAudio(response, this.maxAudioBytes)
      let detectedMime: string
      try {
        detectedMime = detectMediaMime(bytes)
      } catch (error) {
        if (error instanceof MediaStoreError) {
          throw new SpeechProviderError('INVALID_RESPONSE', 'IndexTTS 返回了无法识别的音频', true)
        }
        throw error
      }
      if (detectedMime !== expectedMime(format)) {
        throw new SpeechProviderError('INVALID_RESPONSE', 'IndexTTS 音频格式与请求不一致', true)
      }
      return {
        audio: { kind: 'bytes', bytes, sourceEncoding: 'raw' },
        format,
        mimeType: detectedMime,
        audioSizeBytes: bytes.byteLength,
        usageCharacters: [...text].length,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

