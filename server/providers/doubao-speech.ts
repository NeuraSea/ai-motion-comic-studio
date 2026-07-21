import { randomUUID } from 'node:crypto'

import { detectMediaMime, MediaStoreError } from '../media.js'
import {
  SpeechProviderError,
  type MiniMaxSpeechEmotion,
  type MiniMaxSpeechInput,
  type MiniMaxSpeechResult,
  type SpeechProvider,
} from './minimax-tts.js'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_AUDIO_BYTES = 30 * 1024 * 1024
const DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional'
const RESOURCE_ID = 'seed-tts-2.0'
const MAX_TEXT_CODE_POINTS = 10_000
const MAX_LINE_BYTES = 2 * 1024 * 1024

const EMOTION_CONTEXT: Partial<Record<MiniMaxSpeechEmotion, string>> = {
  happy: '请用开心、明亮而自然的语气说话。',
  sad: '请用悲伤、克制而有感染力的语气说话。',
  angry: '请用愤怒但吐字清晰的语气说话。',
  fearful: '请用紧张、害怕而自然的语气说话。',
  disgusted: '请用厌恶、疏离的语气说话。',
  surprised: '请用惊讶、有起伏的语气说话。',
  calm: '请用平静、自然且有交流感的语气说话。',
  fluent: '请流畅、自然地说话，不要机械播报。',
  whisper: '请用轻声耳语但保持清晰的语气说话。',
}

export interface DoubaoSpeechProviderOptions {
  name?: string
  baseUrl?: string
  apiKey?: string | null
  model?: string
  timeoutMs?: number
  maxAudioBytes?: number
  fetch?: typeof fetch
}

interface NormalizedInput {
  text: string
  speaker: string
  sampleRate: number
  bitrate: number
  speechRate: number
  loudnessRate: number
  pitch: number
  emotion?: MiniMaxSpeechEmotion
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new TypeError(`${label} 必须为正整数`)
  return normalized
}

function endpointFor(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new TypeError('豆包语音 Base URL 无效')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('豆包语音 Base URL 必须是无凭据 HTTPS 地址')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString()
}

function inputError(message: string): never {
  throw new SpeechProviderError('INVALID_INPUT', message, false)
}

function normalizeInput(input: MiniMaxSpeechInput): NormalizedInput {
  if (!input || typeof input !== 'object') inputError('豆包语音合成参数无效')
  const text = input.text?.trim()
  if (!text || [...text].length > MAX_TEXT_CODE_POINTS) {
    inputError(`豆包语音文本必须为 1–${MAX_TEXT_CODE_POINTS} 个字符`)
  }
  const speaker = input.voiceId?.trim()
  if (!speaker || speaker.length > 256 || /[\u0000-\u001f\u007f]/.test(speaker)) {
    inputError('豆包语音 voice ID 无效')
  }
  const format = input.format ?? 'mp3'
  if (format !== 'mp3') inputError('豆包语音 Agent Plan MVP 仅支持 MP3 输出')
  const sampleRate = input.sampleRate ?? 24_000
  if (![8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000].includes(sampleRate)) {
    inputError('豆包语音采样率无效')
  }
  const bitrate = input.bitrate ?? 128_000
  if (!Number.isInteger(bitrate) || bitrate < 64_000 || bitrate > 160_000) {
    inputError('豆包语音 MP3 比特率必须介于 64000 和 160000')
  }
  const speed = input.speed ?? 1
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) inputError('豆包语音语速必须介于 0.5 和 2')
  const volume = input.volume ?? 1
  if (!Number.isFinite(volume) || volume < 0.5 || volume > 2) inputError('豆包语音音量必须介于 0.5 和 2')
  const pitch = input.pitch ?? 0
  if (!Number.isInteger(pitch) || pitch < -12 || pitch > 12) inputError('豆包语音音高必须是 -12 到 12 的整数')
  if (input.channels !== undefined && input.channels !== 1) inputError('豆包语音当前仅支持单声道输出')
  if (input.pronunciationDictionary !== undefined) inputError('豆包语音暂不支持 MiniMax 发音词典')
  return {
    text,
    speaker,
    sampleRate,
    bitrate,
    speechRate: Math.round((speed - 1) * 100),
    loudnessRate: Math.round((volume - 1) * 100),
    pitch,
    ...(input.emotion ? { emotion: input.emotion } : {}),
  }
}

function httpError(status: number): SpeechProviderError {
  if (status === 401 || status === 403) {
    return new SpeechProviderError('PROVIDER_AUTH_FAILED', '豆包语音 Agent Plan API Key 无效或无权访问', false, status)
  }
  if (status === 408 || status === 504) {
    return new SpeechProviderError('UPSTREAM_TIMEOUT', '豆包语音服务响应超时', true, status)
  }
  if (status === 429) {
    return new SpeechProviderError('PROVIDER_RATE_LIMITED', '豆包语音服务请求频率受限', true, status)
  }
  if (status >= 500) {
    return new SpeechProviderError('UPSTREAM_UNAVAILABLE', `豆包语音服务暂时不可用 (${status})`, true, status)
  }
  return new SpeechProviderError('UPSTREAM_ERROR', `豆包语音请求失败 (${status})`, false, status)
}

function businessError(code: number, message: string): SpeechProviderError {
  const safeMessage = message.trim().slice(0, 160)
  if (/auth|grant|permission|api.?key|access|鉴权|权限|密钥/i.test(safeMessage)) {
    return new SpeechProviderError('PROVIDER_AUTH_FAILED', '豆包语音 Agent Plan API Key 无效或无权访问', false, code)
  }
  if (/quota|limit|resource|余额|额度|套餐|资源/i.test(safeMessage)) {
    return new SpeechProviderError('PROVIDER_USAGE_LIMIT_EXCEEDED', `豆包语音套餐资源不可用 (${code})`, false, code)
  }
  if (/rate|frequency|qps|频率|并发/i.test(safeMessage)) {
    return new SpeechProviderError('PROVIDER_RATE_LIMITED', `豆包语音请求频率受限 (${code})`, true, code)
  }
  if (/speaker|voice|text|parameter|invalid|参数|音色|文本/i.test(safeMessage)) {
    return new SpeechProviderError('INVALID_INPUT', `豆包语音请求参数无效 (${code})`, false, code)
  }
  return new SpeechProviderError('UPSTREAM_ERROR', `豆包语音合成失败 (${code})`, false, code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeAudioChunk(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_LINE_BYTES * 4 / 3) + 8
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new SpeechProviderError('INVALID_RESPONSE', '豆包语音返回了无效音频分片', true)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength === 0) {
    throw new SpeechProviderError('INVALID_RESPONSE', '豆包语音返回了空音频分片', true)
  }
  return bytes
}

export class DoubaoSpeechProvider implements SpeechProvider {
  readonly name: string
  readonly model: string
  readonly configured: boolean
  readonly #apiKey: string | null
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly maxAudioBytes: number
  private readonly fetcher: typeof fetch

  constructor(options: DoubaoSpeechProviderOptions = {}) {
    this.name = options.name?.trim() || 'doubao-speech'
    this.model = options.model?.trim() || 'doubao-seed-tts-2.0'
    this.#apiKey = options.apiKey?.trim() || null
    this.configured = Boolean(this.#apiKey && this.model === 'doubao-seed-tts-2.0')
    this.endpoint = endpointFor(options.baseUrl ?? DEFAULT_ENDPOINT)
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.maxAudioBytes = positiveInteger(options.maxAudioBytes, DEFAULT_MAX_AUDIO_BYTES, 'maxAudioBytes')
    this.fetcher = options.fetch ?? fetch
  }

  async synthesize(input: MiniMaxSpeechInput, signal?: AbortSignal): Promise<MiniMaxSpeechResult> {
    if (!this.configured || !this.#apiKey) {
      throw new SpeechProviderError('PROVIDER_NOT_CONFIGURED', '豆包语音 Provider 未配置 Agent Plan API Key', false)
    }
    if (signal?.aborted) throw signal.reason
    const normalized = normalizeInput(input)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('Doubao speech timeout')), this.timeoutMs)
    timer.unref()
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    let response: Response
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': this.#apiKey,
          'x-api-resource-id': RESOURCE_ID,
          'x-api-request-id': randomUUID(),
          'x-control-require-usage-tokens-return': '*',
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          user: { uid: randomUUID() },
          req_params: {
            text: normalized.text,
            speaker: normalized.speaker,
            audio_params: {
              format: 'mp3',
              sample_rate: normalized.sampleRate,
              bit_rate: normalized.bitrate,
              speech_rate: normalized.speechRate,
              loudness_rate: normalized.loudnessRate,
              ...(normalized.emotion ? { emotion: normalized.emotion, emotion_scale: 4 } : {}),
            },
            additions: JSON.stringify({
              post_process: { pitch: normalized.pitch },
              disable_markdown_filter: true,
              ...(normalized.emotion ? { context_texts: [EMOTION_CONTEXT[normalized.emotion]] } : {}),
            }),
          },
        }),
        signal: requestSignal,
      })
    } catch {
      clearTimeout(timer)
      if (signal?.aborted) throw signal.reason
      if (timeout.signal.aborted) throw new SpeechProviderError('UPSTREAM_TIMEOUT', '豆包语音服务响应超时', true)
      throw new SpeechProviderError('UPSTREAM_UNAVAILABLE', '无法连接豆包语音服务', true)
    }

    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw httpError(response.status)
      }
      if (!response.body) throw new SpeechProviderError('INVALID_RESPONSE', '豆包语音返回了空响应', true)
      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const audioChunks: Uint8Array[] = []
      let buffered = ''
      let totalAudioBytes = 0
      let terminalSeen = false
      let usageCharacters: number | undefined

      const consumeLine = (rawLine: string) => {
        const line = rawLine.trim()
        if (!line) return
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          throw new SpeechProviderError('INVALID_RESPONSE', '豆包语音响应分片过大', false)
        }
        let payload: unknown
        try {
          payload = JSON.parse(line)
        } catch {
          throw new SpeechProviderError('INVALID_RESPONSE', '豆包语音返回了无效 JSON 分片', true)
        }
        if (!isRecord(payload) || !Number.isInteger(payload.code)) {
          throw new SpeechProviderError('INVALID_RESPONSE', '豆包语音返回了无效响应结构', true)
        }
        const code = payload.code as number
        if (code === 20000000) {
          terminalSeen = true
          if (isRecord(payload.usage) && Number.isInteger(payload.usage.text_words)) {
            usageCharacters = payload.usage.text_words as number
          }
          return
        }
        if (code > 0) throw businessError(code, typeof payload.message === 'string' ? payload.message : '')
        if (payload.data !== null && payload.data !== undefined) {
          const audio = decodeAudioChunk(payload.data)
          totalAudioBytes += audio.byteLength
          if (totalAudioBytes > this.maxAudioBytes) {
            throw new SpeechProviderError('AUDIO_TOO_LARGE', '豆包语音返回的音频超过大小限制', false)
          }
          audioChunks.push(audio)
        }
      }

      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffered += decoder.decode(chunk.value, { stream: true })
          if (Buffer.byteLength(buffered) > MAX_LINE_BYTES * 2) {
            throw new SpeechProviderError('INVALID_RESPONSE', '豆包语音响应分片过大', false)
          }
          const lines = buffered.split(/\r?\n/)
          buffered = lines.pop() ?? ''
          for (const line of lines) consumeLine(line)
        }
        buffered += decoder.decode()
        consumeLine(buffered)
      } catch (error) {
        await reader.cancel().catch(() => undefined)
        if (error instanceof SpeechProviderError) throw error
        throw new SpeechProviderError('INVALID_RESPONSE', '豆包语音响应无法解析', true)
      } finally {
        reader.releaseLock()
      }
      if (!terminalSeen || totalAudioBytes === 0) {
        throw new SpeechProviderError('INVALID_RESPONSE', '豆包语音响应未完整结束或未包含音频', true)
      }
      const bytes = Buffer.concat(audioChunks.map((chunk) => Buffer.from(chunk)), totalAudioBytes)
      let mimeType: string
      try {
        mimeType = detectMediaMime(bytes)
      } catch (error) {
        if (error instanceof MediaStoreError) {
          throw new SpeechProviderError('INVALID_RESPONSE', '豆包语音返回了无法识别的音频', true)
        }
        throw error
      }
      if (mimeType !== 'audio/mpeg') {
        throw new SpeechProviderError('INVALID_RESPONSE', '豆包语音返回的音频格式与 MP3 请求不一致', true)
      }
      return {
        audio: { kind: 'bytes', bytes, sourceEncoding: 'raw' },
        format: 'mp3',
        mimeType,
        sampleRate: normalized.sampleRate,
        bitrate: normalized.bitrate,
        channels: 1,
        audioSizeBytes: bytes.byteLength,
        usageCharacters: usageCharacters ?? [...normalized.text].length,
        traceId: response.headers.get('x-tt-logid') ?? undefined,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
