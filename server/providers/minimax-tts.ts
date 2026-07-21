import { isIP } from 'node:net'

import { isPublicIpAddress } from '../safe-image-download.js'

const DEFAULT_BASE_URL = 'https://api.minimax.io'
const DEFAULT_MODEL = 'speech-2.8-hd'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_AUDIO_BYTES = 30 * 1024 * 1024
const JSON_OVERHEAD_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CODE_POINTS = 9_999

const AUDIO_FORMATS = ['mp3', 'pcm', 'flac', 'wav', 'pcmu_raw', 'pcmu_wav', 'opus'] as const
const SAMPLE_RATES = [8_000, 16_000, 22_050, 24_000, 32_000, 44_100] as const
const BITRATES = [32_000, 64_000, 128_000, 256_000] as const
const EMOTIONS = [
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'calm',
  'fluent',
  'whisper',
] as const
const SUBTITLE_TYPES = ['sentence', 'word'] as const
const LANGUAGE_BOOSTS = [
  'Chinese',
  'Chinese,Yue',
  'English',
  'Arabic',
  'Russian',
  'Spanish',
  'French',
  'Portuguese',
  'German',
  'Turkish',
  'Dutch',
  'Ukrainian',
  'Vietnamese',
  'Indonesian',
  'Japanese',
  'Italian',
  'Korean',
  'Thai',
  'Polish',
  'Romanian',
  'Greek',
  'Czech',
  'Finnish',
  'Hindi',
  'Bulgarian',
  'Danish',
  'Hebrew',
  'Malay',
  'Persian',
  'Slovak',
  'Swedish',
  'Croatian',
  'Filipino',
  'Hungarian',
  'Norwegian',
  'Slovenian',
  'Catalan',
  'Nynorsk',
  'Tamil',
  'Afrikaans',
  'auto',
] as const

export type MiniMaxAudioFormat = (typeof AUDIO_FORMATS)[number]
export type MiniMaxSpeechEmotion = (typeof EMOTIONS)[number]
export type MiniMaxSubtitleType = (typeof SUBTITLE_TYPES)[number]
export type MiniMaxOutputFormat = 'hex' | 'url'
export type MiniMaxLanguageBoost = (typeof LANGUAGE_BOOSTS)[number]

export type SpeechProviderErrorCode =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_BALANCE_EXHAUSTED'
  | 'PROVIDER_USAGE_LIMIT_EXCEEDED'
  | 'PROVIDER_RATE_LIMITED'
  | 'INVALID_INPUT'
  | 'CONTENT_REJECTED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'INVALID_RESPONSE'
  | 'AUDIO_TOO_LARGE'

export type MiniMaxSpeechErrorCode = SpeechProviderErrorCode

/** Adapter-neutral error contract consumed by the durable speech worker. */
export class SpeechProviderError extends Error {
  constructor(
    readonly code: SpeechProviderErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly upstreamStatus?: number,
  ) {
    super(message)
    this.name = 'SpeechProviderError'
  }
}

export class MiniMaxSpeechError extends SpeechProviderError {
  constructor(
    code: MiniMaxSpeechErrorCode,
    message: string,
    retryable: boolean,
    upstreamStatus?: number,
  ) {
    super(code, message, retryable, upstreamStatus)
    this.name = 'MiniMaxSpeechError'
  }
}

export interface MiniMaxSpeechInput {
  text: string
  voiceId: string
  speed?: number
  volume?: number
  pitch?: number
  emotion?: MiniMaxSpeechEmotion
  sampleRate?: (typeof SAMPLE_RATES)[number]
  bitrate?: (typeof BITRATES)[number]
  format?: MiniMaxAudioFormat
  channels?: 1 | 2
  languageBoost?: MiniMaxLanguageBoost
  pronunciationDictionary?: string[]
  subtitleEnable?: boolean
  subtitleType?: MiniMaxSubtitleType
  outputFormat?: MiniMaxOutputFormat
}

export type MiniMaxAudioSource =
  | {
      kind: 'bytes'
      bytes: Uint8Array
      sourceEncoding: 'hex' | 'base64' | 'raw'
    }
  | {
      /** This URL is still ephemeral and must be safely downloaded before persistence. */
      kind: 'url'
      url: string
    }

export interface MiniMaxSubtitleSource {
  /** MiniMax subtitle URLs are ephemeral; callers must download and validate the JSON. */
  url: string
  granularity: MiniMaxSubtitleType
}

export interface MiniMaxSpeechResult {
  audio: MiniMaxAudioSource
  format: MiniMaxAudioFormat
  mimeType: string
  durationMs?: number
  sampleRate?: number
  bitrate?: number
  channels?: 1 | 2
  audioSizeBytes?: number
  usageCharacters?: number
  wordCount?: number
  subtitle?: MiniMaxSubtitleSource
  traceId?: string
}

export interface MiniMaxSpeechProviderOptions {
  name?: string
  baseUrl?: string
  apiKey?: string | null
  model?: string
  timeoutMs?: number
  maxAudioBytes?: number
  fetch?: typeof fetch
}

export interface SpeechProvider {
  readonly name: string
  readonly model: string
  readonly configured: boolean
  synthesize(input: MiniMaxSpeechInput, signal?: AbortSignal): Promise<MiniMaxSpeechResult>
}

interface NormalizedInput {
  text: string
  voiceId: string
  speed: number
  volume: number
  pitch: number
  emotion?: MiniMaxSpeechEmotion
  sampleRate: (typeof SAMPLE_RATES)[number]
  bitrate: (typeof BITRATES)[number]
  format: MiniMaxAudioFormat
  channels: 1 | 2
  languageBoost?: MiniMaxLanguageBoost
  pronunciationDictionary?: string[]
  subtitleEnable: boolean
  subtitleType: MiniMaxSubtitleType
  outputFormat: MiniMaxOutputFormat
}

function cleanSecret(value: string | null | undefined): string | null {
  const secret = value?.trim()
  return secret || null
}

function t2aEndpoint(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new Error('MiniMax Base URL 格式无效')
  }

  const localHostname = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHostname)) {
    throw new Error('MiniMax Base URL 必须使用 HTTPS（本机测试除外）')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('MiniMax Base URL 不能包含凭据、查询参数或锚点')
  }

  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/v1/t2a_v2')) url.pathname = path
  else if (path.endsWith('/v1')) url.pathname = `${path}/t2a_v2`
  else url.pathname = `${path}/v1/t2a_v2`
  return url.toString()
}

function positiveIntegerOption(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new Error(`${label} 必须为正整数`)
  return normalized
}

function inputError(message: string): never {
  throw new MiniMaxSpeechError('INVALID_INPUT', message, false)
}

function numberInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    inputError(`${label} 必须在 ${minimum} 到 ${maximum} 之间`)
  }
  return value
}

function normalizeInput(input: MiniMaxSpeechInput): NormalizedInput {
  if (!input || typeof input !== 'object') inputError('语音合成参数无效')
  if (typeof input.text !== 'string' || !input.text.trim()) inputError('语音文本不能为空')
  if ([...input.text].length > MAX_TEXT_CODE_POINTS) inputError('语音文本必须少于 10000 个字符')
  if (typeof input.voiceId !== 'string' || !input.voiceId.trim()) inputError('voice ID 不能为空')
  const voiceId = input.voiceId.trim()
  if (voiceId.length > 256 || /[\u0000-\u001f\u007f]/.test(voiceId)) inputError('voice ID 格式无效')

  const speed = numberInRange(input.speed ?? 1, 0.5, 2, '语速')
  const volume = input.volume ?? 1
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume <= 0 || volume > 10) {
    inputError('音量必须大于 0 且不超过 10')
  }
  const pitch = numberInRange(input.pitch ?? 0, -12, 12, '音调')
  if (!Number.isInteger(pitch)) inputError('音调必须为整数')

  if (input.emotion !== undefined && !EMOTIONS.includes(input.emotion)) inputError('情绪参数无效')
  const sampleRate = input.sampleRate ?? 32_000
  if (!SAMPLE_RATES.includes(sampleRate)) inputError('采样率参数无效')
  const bitrate = input.bitrate ?? 128_000
  if (!BITRATES.includes(bitrate)) inputError('比特率参数无效')
  const format = input.format ?? 'mp3'
  if (!AUDIO_FORMATS.includes(format)) inputError('音频格式参数无效')
  const channels = input.channels ?? 1
  if (channels !== 1 && channels !== 2) inputError('声道数只能为 1 或 2')
  const subtitleType = input.subtitleType ?? 'word'
  if (!SUBTITLE_TYPES.includes(subtitleType)) inputError('字幕粒度参数无效')
  const outputFormat = input.outputFormat ?? 'hex'
  if (outputFormat !== 'hex' && outputFormat !== 'url') inputError('音频输出形式参数无效')
  if (input.subtitleEnable !== undefined && typeof input.subtitleEnable !== 'boolean') {
    inputError('字幕开关参数无效')
  }

  let languageBoost: MiniMaxLanguageBoost | undefined
  if (input.languageBoost !== undefined) {
    if (!LANGUAGE_BOOSTS.includes(input.languageBoost)) {
      inputError('语言增强参数无效')
    }
    languageBoost = input.languageBoost
  }

  let pronunciationDictionary: string[] | undefined
  if (input.pronunciationDictionary !== undefined) {
    if (!Array.isArray(input.pronunciationDictionary) || input.pronunciationDictionary.length > 100) {
      inputError('发音词典参数无效')
    }
    pronunciationDictionary = input.pronunciationDictionary.map((entry) => {
      if (typeof entry !== 'string' || !entry.trim() || entry.length > 500 || !entry.includes('/')) {
        inputError('发音词典条目必须使用“原文/读音”格式')
      }
      return entry
    })
  }

  return {
    text: input.text,
    voiceId,
    speed,
    volume,
    pitch,
    ...(input.emotion ? { emotion: input.emotion } : {}),
    sampleRate,
    bitrate,
    format,
    channels,
    ...(languageBoost ? { languageBoost } : {}),
    ...(pronunciationDictionary ? { pronunciationDictionary } : {}),
    subtitleEnable: input.subtitleEnable ?? true,
    subtitleType,
    outputFormat,
  }
}

function requestBody(model: string, input: NormalizedInput): Record<string, unknown> {
  return {
    model,
    text: input.text,
    stream: false,
    voice_setting: {
      voice_id: input.voiceId,
      speed: input.speed,
      vol: input.volume,
      pitch: input.pitch,
      ...(input.emotion ? { emotion: input.emotion } : {}),
    },
    audio_setting: {
      sample_rate: input.sampleRate,
      bitrate: input.bitrate,
      format: input.format,
      channel: input.channels,
    },
    ...(input.languageBoost ? { language_boost: input.languageBoost } : {}),
    ...(input.pronunciationDictionary
      ? { pronunciation_dict: { tone: input.pronunciationDictionary } }
      : {}),
    subtitle_enable: input.subtitleEnable,
    subtitle_type: input.subtitleType,
    output_format: input.outputFormat,
  }
}

function httpError(status: number): MiniMaxSpeechError {
  if (status === 401 || status === 403) {
    return new MiniMaxSpeechError('PROVIDER_AUTH_FAILED', 'MiniMax API Key 无效或无权访问', false, status)
  }
  if (status === 408 || status === 504) {
    return new MiniMaxSpeechError('UPSTREAM_TIMEOUT', 'MiniMax 语音服务响应超时', true, status)
  }
  if (status === 429) {
    return new MiniMaxSpeechError('PROVIDER_RATE_LIMITED', 'MiniMax 语音服务请求频率受限', true, status)
  }
  if (status >= 500) {
    return new MiniMaxSpeechError('UPSTREAM_UNAVAILABLE', `MiniMax 语音服务暂时不可用 (${status})`, true, status)
  }
  return new MiniMaxSpeechError('UPSTREAM_ERROR', `MiniMax 语音请求失败 (${status})`, false, status)
}

function upstreamCodeError(status: number): MiniMaxSpeechError {
  if (status === 1004 || status === 2049) {
    return new MiniMaxSpeechError('PROVIDER_AUTH_FAILED', 'MiniMax API Key 无效或无权访问', false, status)
  }
  if (status === 1008) {
    return new MiniMaxSpeechError('PROVIDER_BALANCE_EXHAUSTED', 'MiniMax 账户余额不足', false, status)
  }
  if (status === 2056) {
    return new MiniMaxSpeechError(
      'PROVIDER_USAGE_LIMIT_EXCEEDED',
      'MiniMax Token Plan 资源额度已用尽 (2056)，请等待下一个 5 小时资源窗口释放后再新建合成任务',
      false,
      status,
    )
  }
  if (status === 1001) {
    return new MiniMaxSpeechError('UPSTREAM_TIMEOUT', 'MiniMax 语音服务响应超时', true, status)
  }
  if ([1002, 1039, 1041, 2045].includes(status)) {
    return new MiniMaxSpeechError('PROVIDER_RATE_LIMITED', `MiniMax 语音服务受到资源限制 (${status})`, true, status)
  }
  if ([1000, 1024, 1033].includes(status)) {
    return new MiniMaxSpeechError('UPSTREAM_UNAVAILABLE', `MiniMax 语音服务暂时不可用 (${status})`, true, status)
  }
  if ([1026, 1027, 1042].includes(status)) {
    return new MiniMaxSpeechError('CONTENT_REJECTED', `MiniMax 拒绝了语音内容 (${status})`, false, status)
  }
  if ([2013, 20132, 2037, 2038, 2039, 2042, 2048].includes(status)) {
    return new MiniMaxSpeechError('INVALID_INPUT', `MiniMax 语音参数无效或无权使用该音色 (${status})`, false, status)
  }
  return new MiniMaxSpeechError('UPSTREAM_ERROR', `MiniMax 语音请求失败 (${status})`, false, status)
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    await response.body?.cancel().catch(() => undefined)
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 返回了非 JSON 响应', true)
  }

  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new MiniMaxSpeechError('AUDIO_TOO_LARGE', 'MiniMax 响应超过大小限制', false)
  }

  if (!response.body) throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 返回了空响应', true)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new MiniMaxSpeechError('AUDIO_TOO_LARGE', 'MiniMax 响应超过大小限制', false)
    }
    chunks.push(value)
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 返回了无效 UTF-8 JSON', true)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 返回了无效 JSON', true)
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', `MiniMax 响应缺少有效的 ${label}`, true)
  }
  return value as Record<string, unknown>
}

function optionalInteger(
  object: Record<string, unknown>,
  field: string,
  minimum = 0,
): number | undefined {
  const value = object[field]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', `MiniMax 响应中的 ${field} 无效`, true)
  }
  return value as number
}

function strictBase64(value: string, maxBytes: number): Uint8Array {
  const compact = value.trim()
  if (!compact || compact.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 返回了无效 base64 音频', true)
  }
  if (compact.length > Math.ceil(maxBytes / 3) * 4) {
    throw new MiniMaxSpeechError('AUDIO_TOO_LARGE', 'MiniMax 音频超过大小限制', false)
  }
  const bytes = Buffer.from(compact, 'base64')
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== compact) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 返回了无效 base64 音频', true)
  }
  return bytes
}

function strictHex(value: string, maxBytes: number): Uint8Array {
  const compact = value.trim()
  if (!compact || compact.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(compact)) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 返回了无效 hex 音频', true)
  }
  if (compact.length / 2 > maxBytes) {
    throw new MiniMaxSpeechError('AUDIO_TOO_LARGE', 'MiniMax 音频超过大小限制', false)
  }
  return Buffer.from(compact, 'hex')
}

function blockedHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return value === 'localhost' ||
    value === 'metadata.google.internal' ||
    value.endsWith('.localhost') ||
    value.endsWith('.local') ||
    value.endsWith('.internal') ||
    value.endsWith('.lan') ||
    value.endsWith('.home')
}

function strictEphemeralUrl(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', `MiniMax 返回了无效的${label} URL`, true)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || blockedHostname(url.hostname)) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', `MiniMax 返回了不安全的${label} URL`, false)
  }
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(literal) && !isPublicIpAddress(literal)) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', `MiniMax 返回了不安全的${label} URL`, false)
  }
  return url.toString()
}

function mimeType(format: MiniMaxAudioFormat): string {
  if (format === 'mp3') return 'audio/mpeg'
  if (format === 'wav' || format === 'pcmu_wav') return 'audio/wav'
  if (format === 'flac') return 'audio/flac'
  if (format === 'opus') return 'audio/ogg'
  if (format === 'pcmu_raw') return 'audio/basic'
  return 'application/octet-stream'
}

function validateAudioSignature(bytes: Uint8Array, format: MiniMaxAudioFormat): void {
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('ascii')
  let valid = true
  if (format === 'mp3') {
    valid = ascii(0, 3) === 'ID3' || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  } else if (format === 'wav' || format === 'pcmu_wav') {
    valid = bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'
  } else if (format === 'flac') {
    valid = ascii(0, 4) === 'fLaC'
  } else if (format === 'opus') {
    valid = ascii(0, 4) === 'OggS'
  } else {
    valid = bytes.length > 0
  }
  if (!valid) throw new MiniMaxSpeechError('INVALID_RESPONSE', `MiniMax 返回的音频不是有效的 ${format} 文件`, true)
}

function parseInlineAudio(
  data: Record<string, unknown>,
  format: MiniMaxAudioFormat,
  maxAudioBytes: number,
): MiniMaxAudioSource & { kind: 'bytes' } {
  const audio = data.audio
  const explicitBase64 = data.audio_base64
  if (audio !== undefined && explicitBase64 !== undefined) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 响应同时包含多个音频字段', true)
  }

  let bytes: Uint8Array
  let sourceEncoding: 'hex' | 'base64'
  if (typeof explicitBase64 === 'string') {
    bytes = strictBase64(explicitBase64, maxAudioBytes)
    sourceEncoding = 'base64'
  } else if (typeof audio === 'string') {
    const dataUrl = /^data:(audio\/[a-z0-9.+-]+|application\/octet-stream);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(audio.trim())
    if (dataUrl) {
      bytes = strictBase64(dataUrl[2], maxAudioBytes)
      sourceEncoding = 'base64'
    } else if (audio.trim().length % 2 === 0 && /^[0-9a-f]+$/i.test(audio.trim())) {
      bytes = strictHex(audio, maxAudioBytes)
      sourceEncoding = 'hex'
    } else {
      // Some MiniMax-compatible gateways expose a raw base64 field while the
      // official endpoint returns hex. Hex wins when the value is ambiguous.
      bytes = strictBase64(audio, maxAudioBytes)
      sourceEncoding = 'base64'
    }
  } else {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 响应不包含音频', true)
  }
  validateAudioSignature(bytes, format)
  return { kind: 'bytes', bytes, sourceEncoding }
}

function parseResponse(
  payload: unknown,
  input: NormalizedInput,
  maxAudioBytes: number,
): MiniMaxSpeechResult {
  const root = objectValue(payload, 'JSON 对象')
  const baseResponse = objectValue(root.base_resp, 'base_resp')
  const upstreamStatus = baseResponse.status_code
  if (!Number.isSafeInteger(upstreamStatus)) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 响应缺少有效的 status_code', true)
  }
  if (upstreamStatus !== 0) throw upstreamCodeError(upstreamStatus as number)

  const data = objectValue(root.data, 'data')
  if (data.status !== 2) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 非流式语音响应尚未完成', true)
  }
  const extra = root.extra_info === undefined ? {} : objectValue(root.extra_info, 'extra_info')

  let format = input.format
  if (extra.audio_format !== undefined) {
    if (typeof extra.audio_format !== 'string' || !AUDIO_FORMATS.includes(extra.audio_format as MiniMaxAudioFormat)) {
      throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 响应中的 audio_format 无效', true)
    }
    format = extra.audio_format as MiniMaxAudioFormat
    if (format !== input.format) {
      throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 返回的音频格式与请求不一致', true)
    }
  }

  let audio: MiniMaxAudioSource
  if (input.outputFormat === 'url') {
    if (typeof data.audio !== 'string' || data.audio_base64 !== undefined) {
      throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 响应不包含音频 URL', true)
    }
    audio = { kind: 'url', url: strictEphemeralUrl(data.audio, '音频') }
  } else {
    audio = parseInlineAudio(data, format, maxAudioBytes)
  }

  const durationMs = optionalInteger(extra, 'audio_length', 1)
  const sampleRate = optionalInteger(extra, 'audio_sample_rate', 1)
  const bitrate = optionalInteger(extra, 'bitrate', 1)
  const audioSizeBytes = optionalInteger(extra, 'audio_size', 1)
  const usageCharacters = optionalInteger(extra, 'usage_characters')
  const wordCount = optionalInteger(extra, 'word_count')
  const channels = optionalInteger(extra, 'audio_channel', 1)
  if (channels !== undefined && channels !== 1 && channels !== 2) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 响应中的 audio_channel 无效', true)
  }
  if (audio.kind === 'bytes' && audioSizeBytes !== undefined && audioSizeBytes !== audio.bytes.byteLength) {
    throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 返回的音频大小与元数据不一致', true)
  }

  let subtitle: MiniMaxSubtitleSource | undefined
  if (data.subtitle_file !== undefined) {
    if (typeof data.subtitle_file !== 'string') {
      throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 响应中的字幕 URL 无效', true)
    }
    subtitle = {
      url: strictEphemeralUrl(data.subtitle_file, '字幕'),
      granularity: input.subtitleType,
    }
  }

  let traceId: string | undefined
  if (root.trace_id !== undefined) {
    if (typeof root.trace_id !== 'string' || !root.trace_id.trim() || root.trace_id.length > 256) {
      throw new MiniMaxSpeechError('INVALID_RESPONSE', 'MiniMax 响应中的 trace_id 无效', true)
    }
    traceId = root.trace_id
  }

  return {
    audio,
    format,
    mimeType: mimeType(format),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(bitrate !== undefined ? { bitrate } : {}),
    ...(channels !== undefined ? { channels: channels as 1 | 2 } : {}),
    ...(audioSizeBytes !== undefined ? { audioSizeBytes } : {}),
    ...(usageCharacters !== undefined ? { usageCharacters } : {}),
    ...(wordCount !== undefined ? { wordCount } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(traceId ? { traceId } : {}),
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

export class MiniMaxSpeechProvider implements SpeechProvider {
  readonly name: string
  readonly model: string
  readonly configured: boolean
  readonly #apiKey: string | null
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly maxAudioBytes: number
  private readonly maxResponseBytes: number
  private readonly fetcher: typeof fetch

  constructor(options: MiniMaxSpeechProviderOptions = {}) {
    this.name = options.name?.trim() || 'minimax-speech'
    this.model = options.model?.trim() || DEFAULT_MODEL
    this.#apiKey = cleanSecret(options.apiKey)
    this.configured = !!this.#apiKey && !!this.model
    this.endpoint = t2aEndpoint(options.baseUrl?.trim() || DEFAULT_BASE_URL)
    this.timeoutMs = positiveIntegerOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'MiniMax timeoutMs')
    this.maxAudioBytes = positiveIntegerOption(
      options.maxAudioBytes,
      DEFAULT_MAX_AUDIO_BYTES,
      'MiniMax maxAudioBytes',
    )
    this.maxResponseBytes = this.maxAudioBytes * 2 + JSON_OVERHEAD_BYTES
    this.fetcher = options.fetch ?? fetch
  }

  async synthesize(input: MiniMaxSpeechInput, signal?: AbortSignal): Promise<MiniMaxSpeechResult> {
    if (!this.configured || !this.#apiKey) {
      throw new MiniMaxSpeechError('PROVIDER_NOT_CONFIGURED', 'MiniMax 语音 Provider 未配置 API Key 或模型', false)
    }
    if (signal?.aborted) throw abortReason(signal)
    const normalized = normalizeInput(input)

    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('MiniMax request timed out', 'TimeoutError'))
    }, this.timeoutMs)
    const cancel = () => controller.abort(signal ? abortReason(signal) : undefined)
    signal?.addEventListener('abort', cancel, { once: true })

    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(requestBody(this.model, normalized)),
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw httpError(response.status)
      }
      const payload = await readBoundedJson(response, this.maxResponseBytes)
      return parseResponse(payload, normalized, this.maxAudioBytes)
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal)
      if (timedOut) throw new MiniMaxSpeechError('UPSTREAM_TIMEOUT', 'MiniMax 语音服务响应超时', true)
      if (error instanceof MiniMaxSpeechError) throw error
      throw new MiniMaxSpeechError('UPSTREAM_UNAVAILABLE', '无法连接 MiniMax 语音服务', true)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
    }
  }
}
