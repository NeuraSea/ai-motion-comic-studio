import type { SpeechSubtitleCue, SpeechSubtitleDocument } from '../../lib'

export const MAX_EDITABLE_SUBTITLE_CUES = 2_000
export const MAX_SUBTITLE_CUE_TEXT_CODE_POINTS = 1_000
export const MAX_SUBTITLE_TOTAL_TEXT_CODE_POINTS = 20_000

export interface SubtitleCueDraft {
  key: string
  text: string
  startSeconds: string
  endSeconds: string
}

export interface SubtitleCueValidation {
  cues: SpeechSubtitleCue[] | null
  errors: string[]
  rowErrors: Record<string, string[]>
}

function secondsText(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3).replace(/\.?0+$/, '') || '0'
}

export function subtitleCueDraftsFromCues(
  cues: readonly SpeechSubtitleCue[],
): SubtitleCueDraft[] {
  return cues.map((cue, index) => ({
    key: `cue-${index + 1}`,
    text: cue.text,
    startSeconds: secondsText(cue.startMs),
    endSeconds: secondsText(cue.endMs),
  }))
}

export function providerSubtitleCueDrafts(
  document: SpeechSubtitleDocument | null | undefined,
): SubtitleCueDraft[] {
  return document?.mode === 'word'
    ? subtitleCueDraftsFromCues(document.cues)
    : []
}

export function emptySubtitleCueDraft(
  key: string,
  startMs: number,
  endMs: number,
): SubtitleCueDraft {
  return {
    key,
    text: '',
    startSeconds: secondsText(Math.max(0, Math.round(startMs))),
    endSeconds: secondsText(Math.max(0, Math.round(endMs))),
  }
}

function timestampMs(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null
  const seconds = Number(normalized)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  const milliseconds = Math.round(seconds * 1_000)
  return Number.isSafeInteger(milliseconds) ? milliseconds : null
}

function normalizedText(value: string): string | null {
  const text = value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
  if (!text
    || [...text].length > MAX_SUBTITLE_CUE_TEXT_CODE_POINTS
    || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null
  return text
}

export function validateSubtitleCueDrafts(
  drafts: readonly SubtitleCueDraft[],
  durationSeconds: number,
): SubtitleCueValidation {
  const errors: string[] = []
  const rowErrors: Record<string, string[]> = {}
  const addRowError = (key: string, message: string) => {
    rowErrors[key] = [...(rowErrors[key] ?? []), message]
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3_600) {
    errors.push('语音资产缺少可信时长，暂时不能保存词级字幕')
  }
  if (drafts.length < 1 || drafts.length > MAX_EDITABLE_SUBTITLE_CUES) {
    errors.push(`字幕必须包含 1–${MAX_EDITABLE_SUBTITLE_CUES} 条 cue`)
  }
  if (new Set(drafts.map((draft) => draft.key)).size !== drafts.length) {
    errors.push('字幕编辑行标识重复，请重新载入')
  }

  const durationMs = Math.ceil(durationSeconds * 1_000)
  let previousEndMs = 0
  let totalTextCodePoints = 0
  const cues: SpeechSubtitleCue[] = []
  drafts.forEach((draft) => {
    const text = normalizedText(draft.text)
    const startMs = timestampMs(draft.startSeconds)
    const endMs = timestampMs(draft.endSeconds)
    if (text === null) addRowError(draft.key, '文本不能为空，且单条不能超过 1000 字')
    if (startMs === null || endMs === null) {
      addRowError(draft.key, '时间必须是最多 3 位小数的非负秒数')
    } else {
      if (endMs <= startMs) addRowError(draft.key, '结束时间必须晚于开始时间')
      if (startMs < previousEndMs) addRowError(draft.key, '不能与上一条 cue 重叠或逆序')
      if (endMs > durationMs) addRowError(draft.key, '结束时间不能超过当前语音时长')
      previousEndMs = Math.max(previousEndMs, endMs)
    }
    if (text !== null) totalTextCodePoints += [...text].length
    if (text !== null && startMs !== null && endMs !== null) {
      cues.push({ text, startMs, endMs })
    }
  })
  if (totalTextCodePoints > MAX_SUBTITLE_TOTAL_TEXT_CODE_POINTS) {
    errors.push('字幕文本总量不能超过 20000 字')
  }
  if (Object.keys(rowErrors).length > 0) errors.push('请先修正标红的字幕行')
  return {
    cues: errors.length === 0 ? cues : null,
    errors,
    rowErrors,
  }
}
