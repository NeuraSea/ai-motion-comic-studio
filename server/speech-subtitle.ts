import type { MediaAssetRecord } from './database.js'
import type { JsonObject, JsonValue } from './types.js'

export const SPEECH_SUBTITLE_DOCUMENT_VERSION = 1 as const
export const MAX_SPEECH_SUBTITLE_CUES = 2_000
export const MAX_SPEECH_SUBTITLE_CUE_TEXT = 1_000
export const MAX_SPEECH_SUBTITLE_TOTAL_TEXT = 20_000
export const MAX_SPEECH_SUBTITLE_TIMESTAMP_MS = 60 * 60 * 1_000

export interface SpeechSubtitleCue {
  text: string
  startMs: number
  endMs: number
}

export interface SpeechSubtitleWordDocument {
  version: typeof SPEECH_SUBTITLE_DOCUMENT_VERSION
  lineId: string
  mode: 'word'
  granularity: 'word' | 'sentence'
  cues: SpeechSubtitleCue[]
}

export interface SpeechSubtitleFallbackDocument {
  version: typeof SPEECH_SUBTITLE_DOCUMENT_VERSION
  lineId: string
  mode: 'sentence-fallback'
  reason: string
}

export type SpeechSubtitleDocument =
  | SpeechSubtitleWordDocument
  | SpeechSubtitleFallbackDocument

export interface SpeechSubtitleCueOverride {
  version: typeof SPEECH_SUBTITLE_DOCUMENT_VERSION
  sourceAssetId: string
  dialogueLineId: string
  cues: SpeechSubtitleCue[]
}

export class SpeechSubtitleError extends Error {
  constructor(
    readonly code:
      | 'INVALID_SUBTITLE_CUES'
      | 'SUBTITLE_OVERRIDE_BINDING_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'SpeechSubtitleError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function safeReason(value: unknown): string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 100
    && /^[a-z0-9._-]+$/i.test(value)
    ? value
    : 'timestamps-unavailable'
}

function normalizedCueText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SpeechSubtitleError('INVALID_SUBTITLE_CUES', '字幕 cue 文本无效')
  }
  const text = value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
  if (!text
    || [...text].length > MAX_SPEECH_SUBTITLE_CUE_TEXT
    || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new SpeechSubtitleError('INVALID_SUBTITLE_CUES', '字幕 cue 文本无效')
  }
  return text
}

/**
 * Strict canonical cue parser shared by public projection, editor overrides,
 * and export. Unlike the provider-side compatibility parser, this wire shape
 * is exact and never accepts overlaps or alternate field names.
 */
export function parseCanonicalSpeechSubtitleCues(
  value: unknown,
  options: {
    durationMs?: number
    endToleranceMs?: number
  } = {},
): SpeechSubtitleCue[] {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > MAX_SPEECH_SUBTITLE_CUES) {
    throw new SpeechSubtitleError('INVALID_SUBTITLE_CUES', '字幕 cue 数量无效')
  }
  const durationMs = options.durationMs
  if (durationMs !== undefined
    && (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_SPEECH_SUBTITLE_TIMESTAMP_MS)) {
    throw new SpeechSubtitleError('INVALID_SUBTITLE_CUES', '字幕对应的音频时长无效')
  }
  const maximumEndMs = durationMs === undefined
    ? MAX_SPEECH_SUBTITLE_TIMESTAMP_MS
    : Math.ceil(durationMs) + Math.max(0, options.endToleranceMs ?? 0)
  let previousEndMs = 0
  let totalText = 0
  return value.map((raw): SpeechSubtitleCue => {
    if (!isPlainObject(raw)
      || Object.keys(raw).some((key) => !['text', 'startMs', 'endMs'].includes(key))
      || !Number.isSafeInteger(raw.startMs)
      || !Number.isSafeInteger(raw.endMs)) {
      throw new SpeechSubtitleError('INVALID_SUBTITLE_CUES', '字幕 cue 结构无效')
    }
    const startMs = raw.startMs as number
    const endMs = raw.endMs as number
    const text = normalizedCueText(raw.text)
    if (startMs < previousEndMs
      || startMs < 0
      || endMs <= startMs
      || endMs > maximumEndMs) {
      throw new SpeechSubtitleError('INVALID_SUBTITLE_CUES', '字幕 cue 时间轴无效')
    }
    previousEndMs = endMs
    totalText += [...text].length
    if (totalText > MAX_SPEECH_SUBTITLE_TOTAL_TEXT) {
      throw new SpeechSubtitleError('INVALID_SUBTITLE_CUES', '字幕 cue 文本总量超限')
    }
    return { text, startMs, endMs }
  })
}

/** Return only a bounded, non-secret subtitle view from immutable speech metadata. */
export function publicSpeechSubtitle(asset: MediaAssetRecord): JsonObject | undefined {
  if (asset.kind !== 'speech') return undefined
  const lineId = asset.generationParameters.lineId
  const subtitle = asset.generationParameters.subtitle
  if (!safeIdentifier(lineId) || !isPlainObject(subtitle)) return undefined
  if (subtitle.mode === 'sentence-fallback') {
    return {
      version: SPEECH_SUBTITLE_DOCUMENT_VERSION,
      lineId,
      mode: 'sentence-fallback',
      reason: safeReason(subtitle.reason),
    }
  }
  if (subtitle.mode !== 'word') return undefined
  try {
    const cues = parseCanonicalSpeechSubtitleCues(subtitle.cues, {
      ...(typeof asset.durationSeconds === 'number'
        ? { durationMs: asset.durationSeconds * 1_000, endToleranceMs: 500 }
        : {}),
    })
    return {
      version: SPEECH_SUBTITLE_DOCUMENT_VERSION,
      lineId,
      mode: 'word',
      granularity: subtitle.granularity === 'sentence' ? 'sentence' : 'word',
      cues: cues.map((cue) => ({ ...cue })) as unknown as JsonValue,
    }
  } catch {
    return {
      version: SPEECH_SUBTITLE_DOCUMENT_VERSION,
      lineId,
      mode: 'sentence-fallback',
      reason: 'timestamps-invalid',
    }
  }
}

/** Parse a Manju-namespaced cue override and enforce its immutable bindings. */
export function parseSpeechSubtitleCueOverride(
  value: unknown,
  binding: { sourceAssetId: string; dialogueLineId: string; durationMs: number },
): SpeechSubtitleCueOverride {
  if (!isPlainObject(value)
    || value.version !== SPEECH_SUBTITLE_DOCUMENT_VERSION
    || !safeIdentifier(value.sourceAssetId)
    || !safeIdentifier(value.dialogueLineId)
    || Object.keys(value).some((key) => ![
      'version',
      'sourceAssetId',
      'dialogueLineId',
      'cues',
    ].includes(key))) {
    throw new SpeechSubtitleError('INVALID_SUBTITLE_CUES', '人工字幕覆盖文档无效')
  }
  if (value.sourceAssetId !== binding.sourceAssetId
    || value.dialogueLineId !== binding.dialogueLineId) {
    throw new SpeechSubtitleError(
      'SUBTITLE_OVERRIDE_BINDING_CONFLICT',
      '人工字幕覆盖与当前音频资产或对白绑定不一致',
    )
  }
  return {
    version: SPEECH_SUBTITLE_DOCUMENT_VERSION,
    sourceAssetId: value.sourceAssetId,
    dialogueLineId: value.dialogueLineId,
    cues: parseCanonicalSpeechSubtitleCues(value.cues, { durationMs: binding.durationMs }),
  }
}
