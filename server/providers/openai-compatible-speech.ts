import { detectMediaMime, MediaStoreError } from '../media.js'
import {
  SpeechProviderError,
  type MiniMaxSpeechInput,
  type MiniMaxSpeechResult,
  type SpeechProvider,
} from './minimax-tts.js'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_AUDIO_BYTES = 30 * 1024 * 1024
const MAX_TEXT_CODE_POINTS = 4_096
const MAX_VOICE_LENGTH = 200

export interface OpenAICompatibleSpeechProviderOptions {
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
    throw new TypeError('OpenAI-compatible Speech Base URL is invalid')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('OpenAI-compatible Speech Base URL must be a credential-free HTTPS URL')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/audio/speech`
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
    return new SpeechProviderError('PROVIDER_AUTH_FAILED', '自定义语音 Provider 的 API Key 无效或无权访问', false, status)
  }
  if (status === 408 || status === 504) {
    return new SpeechProviderError('UPSTREAM_TIMEOUT', '自定义语音 Provider 响应超时', true, status)
  }
  if (status === 413) {
    return new SpeechProviderError('AUDIO_TOO_LARGE', '自定义语音 Provider 返回的音频超过大小限制', false, status)
  }
  if (status === 429) {
    return new SpeechProviderError('PROVIDER_RATE_LIMITED', '自定义语音 Provider 请求频率受限', true, status)
  }
  if (status >= 500) {
    return new SpeechProviderError('UPSTREAM_UNAVAILABLE', `自定义语音 Provider 暂时不可用 (${status})`, true, status)
  }
  return new SpeechProviderError('INVALID_INPUT', `自定义语音 Provider 拒绝了请求 (${status})`, false, status)
}

async function readBoundedAudio(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await discardBody(response)
    throw new SpeechProviderError('AUDIO_TOO_LARGE', '自定义语音 Provider 返回的音频超过大小限制', false)
  }
  if (!response.body) {
    throw new SpeechProviderError('INVALID_RESPONSE', '自定义语音 Provider 返回了空响应', true)
  }
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
        throw new SpeechProviderError('AUDIO_TOO_LARGE', '自定义语音 Provider 返回的音频超过大小限制', false)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new SpeechProviderError('INVALID_RESPONSE', '自定义语音 Provider 返回了空音频', true)
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

function validateControls(input: MiniMaxSpeechInput): void {
  if (input.volume !== undefined && input.volume !== 1) {
    throw new SpeechProviderError('INVALID_INPUT', 'OpenAI-compatible Speech 不支持音量参数，请在时间线中调整音量', false)
  }
  if (input.pitch !== undefined && input.pitch !== 0) {
    throw new SpeechProviderError('INVALID_INPUT', 'OpenAI-compatible Speech 不支持音高参数', false)
  }
  if (input.emotion !== undefined && input.emotion !== 'calm') {
    throw new SpeechProviderError('INVALID_INPUT', '当前 OpenAI-compatible Speech 契约不支持 MiniMax 情绪参数', false)
  }
  if (input.languageBoost !== undefined || input.pronunciationDictionary !== undefined) {
    throw new SpeechProviderError('INVALID_INPUT', '当前 OpenAI-compatible Speech 契约不支持 MiniMax 专属参数', false)
  }
}

/** Strict implementation of POST {baseUrl}/audio/speech returning raw audio bytes. */
export class OpenAICompatibleSpeechProvider implements SpeechProvider {
  readonly name: string
  readonly model: string
  readonly configured: boolean
  readonly #apiKey: string | null
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly maxAudioBytes: number
  private readonly fetcher: typeof fetch

  constructor(options: OpenAICompatibleSpeechProviderOptions) {
    this.name = options.name?.trim() || 'openai-compatible-speech'
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
      throw new SpeechProviderError('PROVIDER_NOT_CONFIGURED', '自定义语音 Provider 未配置 API Key 或模型', false)
    }
    if (signal?.aborted) throw abortReason(signal)
    const text = input.text.trim()
    const voice = input.voiceId.trim()
    const format = input.format ?? 'mp3'
    const speed = input.speed ?? 1
    if (!text || [...text].length > MAX_TEXT_CODE_POINTS) {
      throw new SpeechProviderError('INVALID_INPUT', `语音文本必须为 1–${MAX_TEXT_CODE_POINTS} 个字符`, false)
    }
    if (!voice || voice.length > MAX_VOICE_LENGTH || /[\u0000-\u001f\u007f]/.test(voice)) {
      throw new SpeechProviderError('INVALID_INPUT', '自定义语音 voice 无效', false)
    }
    if (format !== 'mp3' && format !== 'wav') {
      throw new SpeechProviderError('INVALID_INPUT', '当前自定义语音只支持 mp3 或 wav 输出', false)
    }
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
      throw new SpeechProviderError('INVALID_INPUT', '自定义语音 speed 必须介于 0.25 和 4 之间', false)
    }
    validateControls(input)

    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('speech provider timeout')), this.timeoutMs)
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
        }),
        signal: requestSignal,
      })
    } catch (error) {
      clearTimeout(timer)
      if (signal?.aborted) throw abortReason(signal)
      if (timeout.signal.aborted) {
        throw new SpeechProviderError('UPSTREAM_TIMEOUT', '自定义语音 Provider 响应超时', true)
      }
      throw new SpeechProviderError('UPSTREAM_UNAVAILABLE', '无法连接自定义语音 Provider', true)
    }
    try {
      if (!response.ok) {
        await discardBody(response)
        throw httpError(response.status)
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      const allowedContentTypes = new Set([
        expectedMime(format),
        ...(format === 'wav' ? ['audio/x-wav'] : []),
        'application/octet-stream',
      ])
      if (!contentType || !allowedContentTypes.has(contentType)) {
        await discardBody(response)
        throw new SpeechProviderError('INVALID_RESPONSE', '自定义语音 Provider 返回了非音频响应', true)
      }
      const bytes = await readBoundedAudio(response, this.maxAudioBytes)
      let detectedMime: string
      try {
        detectedMime = detectMediaMime(bytes)
      } catch (error) {
        if (error instanceof MediaStoreError) {
          throw new SpeechProviderError('INVALID_RESPONSE', '自定义语音 Provider 返回了无法识别的音频', true)
        }
        throw error
      }
      if (detectedMime !== expectedMime(format)) {
        throw new SpeechProviderError('INVALID_RESPONSE', '自定义语音 Provider 返回的音频格式与请求不一致', true)
      }
      return {
        audio: { kind: 'bytes', bytes, sourceEncoding: 'raw' },
        format,
        mimeType: detectedMime,
        audioSizeBytes: bytes.byteLength,
      }
    } catch (error) {
      if (error instanceof SpeechProviderError) throw error
      if (signal?.aborted) throw abortReason(signal)
      if (timeout.signal.aborted) {
        throw new SpeechProviderError('UPSTREAM_TIMEOUT', '自定义语音 Provider 响应超时', true)
      }
      throw new SpeechProviderError('INVALID_RESPONSE', '自定义语音 Provider 音频响应读取失败', true)
    } finally {
      clearTimeout(timer)
    }
  }
}
