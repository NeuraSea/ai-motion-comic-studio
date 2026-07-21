import {
  downloadPublicResource,
  SafePublicDownloadError,
  type DownloadedPublicResource,
} from './safe-image-download.js'
import type { MiniMaxSubtitleSource } from './providers/minimax-tts.js'

const MAX_SUBTITLE_BYTES = 256 * 1024
const MAX_CUES = 2_000
const MAX_CUE_TEXT = 1_000
const MAX_TOTAL_TEXT = 20_000
const MAX_TIMESTAMP_MS = 60 * 60 * 1_000

export interface SpeechTimestampCue {
  text: string
  startMs: number
  endMs: number
}

export class MiniMaxSubtitleError extends Error {
  constructor(
    readonly code:
      | 'SUBTITLE_DOWNLOAD_FAILED'
      | 'INVALID_SUBTITLE_RESPONSE'
      | 'SUBTITLE_TOO_LARGE',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'MiniMaxSubtitleError'
  }
}

export type MiniMaxSubtitleLoader = (
  source: MiniMaxSubtitleSource,
  signal: AbortSignal,
) => Promise<SpeechTimestampCue[]>

type SubtitleDownloader = (
  url: string,
  signal: AbortSignal,
  options: { maxBytes: number; accept: string; httpsOnly: boolean },
) => Promise<DownloadedPublicResource>

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cueArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isObject(value)) throw new MiniMaxSubtitleError(
    'INVALID_SUBTITLE_RESPONSE',
    'MiniMax 字幕不是 JSON 对象或数组',
    false,
  )
  for (const key of ['subtitles', 'subtitle', 'words', 'sentences', 'data']) {
    if (Array.isArray(value[key])) return value[key]
  }
  throw new MiniMaxSubtitleError(
    'INVALID_SUBTITLE_RESPONSE',
    'MiniMax 字幕缺少时间戳数组',
    false,
  )
}

function stringField(value: Record<string, unknown>): string {
  const candidate = value.text ?? value.word ?? value.content
  if (typeof candidate !== 'string') {
    throw new MiniMaxSubtitleError('INVALID_SUBTITLE_RESPONSE', 'MiniMax 字幕文本无效', false)
  }
  const text = candidate.trim()
  if (!text || [...text].length > MAX_CUE_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new MiniMaxSubtitleError('INVALID_SUBTITLE_RESPONSE', 'MiniMax 字幕文本无效', false)
  }
  return text
}

function timestampField(value: Record<string, unknown>, keys: readonly string[], label: string): number {
  const candidate = keys.map((key) => value[key]).find((item) => item !== undefined)
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0 || (candidate as number) > MAX_TIMESTAMP_MS) {
    throw new MiniMaxSubtitleError('INVALID_SUBTITLE_RESPONSE', `MiniMax 字幕${label}无效`, false)
  }
  return candidate as number
}

/** Parse MiniMax's downloaded JSON/.titles sidecar. All supported fields are millisecond based. */
export function parseMiniMaxSubtitle(value: unknown): SpeechTimestampCue[] {
  const entries = cueArray(value)
  if (entries.length < 1 || entries.length > MAX_CUES) {
    throw new MiniMaxSubtitleError('INVALID_SUBTITLE_RESPONSE', 'MiniMax 字幕条目数量无效', false)
  }
  let previousEnd = 0
  let totalText = 0
  return entries.map((entry) => {
    if (!isObject(entry)) {
      throw new MiniMaxSubtitleError('INVALID_SUBTITLE_RESPONSE', 'MiniMax 字幕条目无效', false)
    }
    const text = stringField(entry)
    const startMs = timestampField(
      entry,
      ['start_time', 'startTime', 'start_ms', 'startMs', 'begin_time', 'beginTime'],
      '开始时间',
    )
    const endMs = timestampField(
      entry,
      ['end_time', 'endTime', 'end_ms', 'endMs'],
      '结束时间',
    )
    if (endMs <= startMs || startMs < previousEnd) {
      throw new MiniMaxSubtitleError('INVALID_SUBTITLE_RESPONSE', 'MiniMax 字幕时间轴顺序无效', false)
    }
    previousEnd = endMs
    totalText += [...text].length
    if (totalText > MAX_TOTAL_TEXT) {
      throw new MiniMaxSubtitleError('INVALID_SUBTITLE_RESPONSE', 'MiniMax 字幕文本总量超限', false)
    }
    return { text, startMs, endMs }
  })
}

function parseContentType(value: string | null): string | null {
  return value?.split(';', 1)[0].trim().toLowerCase() || null
}

export async function downloadMiniMaxSubtitle(
  source: MiniMaxSubtitleSource,
  signal: AbortSignal,
  downloader: SubtitleDownloader = downloadPublicResource,
): Promise<SpeechTimestampCue[]> {
  let resource: DownloadedPublicResource
  try {
    resource = await downloader(source.url, signal, {
      maxBytes: MAX_SUBTITLE_BYTES,
      accept: 'application/json,text/json,text/plain;q=0.9,application/octet-stream;q=0.5',
      httpsOnly: true,
    })
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof SafePublicDownloadError) {
      throw new MiniMaxSubtitleError(
        error.code === 'RESOURCE_TOO_LARGE' ? 'SUBTITLE_TOO_LARGE' : 'SUBTITLE_DOWNLOAD_FAILED',
        error.code === 'RESOURCE_TOO_LARGE' ? 'MiniMax 字幕文件超过大小限制' : 'MiniMax 字幕文件下载失败',
        error.retryable,
      )
    }
    throw new MiniMaxSubtitleError('SUBTITLE_DOWNLOAD_FAILED', 'MiniMax 字幕文件下载失败', true)
  }
  const contentType = parseContentType(resource.contentType)
  if (contentType && ![
    'application/json',
    'text/json',
    'text/plain',
    'application/octet-stream',
  ].includes(contentType)) {
    throw new MiniMaxSubtitleError('INVALID_SUBTITLE_RESPONSE', 'MiniMax 字幕文件类型无效', false)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes)
  } catch {
    throw new MiniMaxSubtitleError('INVALID_SUBTITLE_RESPONSE', 'MiniMax 字幕不是 UTF-8 文本', false)
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new MiniMaxSubtitleError('INVALID_SUBTITLE_RESPONSE', 'MiniMax 字幕不是合法 JSON', false)
  }
  return parseMiniMaxSubtitle(payload)
}
