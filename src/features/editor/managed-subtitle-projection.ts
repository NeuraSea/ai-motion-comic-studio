import {
  OPEN_CUT_TICKS_PER_SECOND,
  type EditorSceneTracks,
  type EditorTimelineElement,
  type ReplaceManagedSubtitleCueSetInput,
} from '@manju/opencut-editor'
import type {
  TimelineManagedSubtitleCueSetReplaceInput,
  TimelineManagedSubtitleSourceCue,
} from './timeline-revision-handoff'

const FIXED_FRAME_RATE = 24
const FRAME_TICKS = OPEN_CUT_TICKS_PER_SECOND / FIXED_FRAME_RATE
const MAX_IDENTIFIER_LENGTH = 200
const MAX_CUES = 2_000
const MAX_CUE_TEXT_CODE_POINTS = 1_000
const MAX_TOTAL_TEXT_CODE_POINTS = 20_000

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== 'string'
    || !value
    || value.trim() !== value
    || value.length > MAX_IDENTIFIER_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} 格式无效`)
  }
}

function normalizedCueText(value: string, index: number): string {
  if (typeof value !== 'string') throw new Error(`字幕 cue ${index + 1} 文本无效`)
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (!text
    || [...text].length > MAX_CUE_TEXT_CODE_POINTS
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(`字幕 cue ${index + 1} 文本无效`)
  }
  return text
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`)
}

function audioMatchesBinding(
  element: EditorTimelineElement,
  input: TimelineManagedSubtitleCueSetReplaceInput,
): boolean {
  return element.type === 'audio'
    && element.hidden !== true
    && element.mediaId === input.speechAssetId
    && element.params?.dialogueLineId === input.dialogueLineId
    && element.params?.storySceneId === input.storySceneId
    && element.params?.storyShotId === input.storyShotId
}

function resolveSourceAudio(
  tracks: EditorSceneTracks,
  input: TimelineManagedSubtitleCueSetReplaceInput,
): EditorTimelineElement {
  const matches = tracks.audio.flatMap((track) => (
    track.muted === true
      ? []
      : track.elements.filter((element) => audioMatchesBinding(element, input))
  ))
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? '当前时间线找不到与语音资产及剧本绑定一致的可听对白音频'
      : '当前时间线存在多个与语音资产及剧本绑定一致的可听对白音频')
  }
  return matches[0]!
}

function validateAudioRange(audio: EditorTimelineElement): {
  sourceAudioStartTime: number
  sourceAudioTrimStart: number
  sourceAudioDuration: number
  durationFrames: number
} {
  const sourceAudioStartTime = audio.startTime
  const sourceAudioTrimStart = audio.trimStart ?? 0
  const sourceAudioDuration = audio.duration
  assertSafeNonNegativeInteger(sourceAudioStartTime, '对白音频开始时间')
  assertSafeNonNegativeInteger(sourceAudioTrimStart, '对白音频裁剪起点')
  if (!Number.isSafeInteger(sourceAudioDuration) || sourceAudioDuration <= 0) {
    throw new Error('对白音频时长无效')
  }
  if (sourceAudioStartTime % FRAME_TICKS !== 0
    || sourceAudioDuration % FRAME_TICKS !== 0) {
    throw new Error('对白音频没有对齐 24fps 帧边界')
  }
  if (!Number.isSafeInteger(sourceAudioStartTime + sourceAudioDuration)
    || !Number.isSafeInteger(sourceAudioTrimStart + sourceAudioDuration)) {
    throw new Error('对白音频时间范围超出安全整数边界')
  }
  if (audio.sourceDuration !== undefined) {
    if (!Number.isSafeInteger(audio.sourceDuration)
      || audio.sourceDuration <= 0
      || sourceAudioTrimStart + sourceAudioDuration > audio.sourceDuration) {
      throw new Error('对白音频裁剪范围超出源音频时长')
    }
  }
  return {
    sourceAudioStartTime,
    sourceAudioTrimStart,
    sourceAudioDuration,
    durationFrames: sourceAudioDuration / FRAME_TICKS,
  }
}

function validateSourceCues(
  cues: readonly TimelineManagedSubtitleSourceCue[],
): Array<TimelineManagedSubtitleSourceCue & { text: string }> {
  if (!Array.isArray(cues) || cues.length < 1 || cues.length > MAX_CUES) {
    throw new Error(`托管字幕必须包含 1–${MAX_CUES} 条 cue`)
  }
  let previousEndMs = 0
  let totalTextCodePoints = 0
  return cues.map((cue, index) => {
    const text = normalizedCueText(cue.text, index)
    assertSafeNonNegativeInteger(cue.startMs, `字幕 cue ${index + 1} 开始时间`)
    if (!Number.isSafeInteger(cue.endMs) || cue.endMs <= cue.startMs) {
      throw new Error(`字幕 cue ${index + 1} 结束时间无效`)
    }
    if (cue.startMs < previousEndMs) {
      throw new Error(`字幕 cue ${index + 1} 与上一条 cue 重叠或逆序`)
    }
    previousEndMs = cue.endMs
    totalTextCodePoints += [...text].length
    if (totalTextCodePoints > MAX_TOTAL_TEXT_CODE_POINTS) {
      throw new Error(`托管字幕文本总量不能超过 ${MAX_TOTAL_TEXT_CODE_POINTS} 字`)
    }
    return { text, startMs: cue.startMs, endMs: cue.endMs }
  })
}

/**
 * Resolves one current audible dialogue element and projects immutable source
 * millisecond cues onto its visible, trimmed 24fps timeline interval.
 */
export function projectManagedSubtitleCueSetToOpenCut(
  tracks: EditorSceneTracks,
  input: TimelineManagedSubtitleCueSetReplaceInput,
): ReplaceManagedSubtitleCueSetInput {
  assertIdentifier(input.cueSetId, 'cueSetId')
  assertIdentifier(input.dialogueLineId, 'dialogueLineId')
  assertIdentifier(input.storySceneId, 'storySceneId')
  assertIdentifier(input.storyShotId, 'storyShotId')
  assertIdentifier(input.speechAssetId, 'speechAssetId')
  const sourceCues = validateSourceCues(input.cues)
  const audio = resolveSourceAudio(tracks, input)
  const range = validateAudioRange(audio)

  // Source boundaries can land between frames after an OpenCut trim. Integer
  // cue timestamps are clamped inward so provenance never claims invisible
  // source audio; their timeline placement uses the renderer's 24fps rounding.
  const trimStartMs = (range.sourceAudioTrimStart * 1_000) / OPEN_CUT_TICKS_PER_SECOND
  const visibleDurationMs = (range.sourceAudioDuration * 1_000) / OPEN_CUT_TICKS_PER_SECOND
  const visibleSourceStartMs = Math.ceil(trimStartMs)
  const visibleSourceEndMs = Math.floor(trimStartMs + visibleDurationMs)
  let previousEndTime = range.sourceAudioStartTime
  const cues = sourceCues.map((cue, index) => {
    const sourceStartMs = Math.max(cue.startMs, visibleSourceStartMs)
    const sourceEndMs = Math.min(cue.endMs, visibleSourceEndMs)
    if (sourceEndMs <= sourceStartMs) {
      throw new Error(`字幕 cue ${index + 1} 在当前音频裁剪后为空`)
    }

    const relativeStartMs = Math.max(0, sourceStartMs - trimStartMs)
    const relativeEndMs = Math.min(visibleDurationMs, sourceEndMs - trimStartMs)
    const startFrame = Math.max(
      0,
      Math.min(range.durationFrames, Math.round((relativeStartMs * FIXED_FRAME_RATE) / 1_000)),
    )
    let endFrame = Math.max(
      0,
      Math.min(range.durationFrames, Math.round((relativeEndMs * FIXED_FRAME_RATE) / 1_000)),
    )
    if (endFrame <= startFrame && startFrame < range.durationFrames) endFrame = startFrame + 1
    if (endFrame <= startFrame) {
      throw new Error(`字幕 cue ${index + 1} 投影到 24fps 后为空`)
    }
    const startTime = range.sourceAudioStartTime + startFrame * FRAME_TICKS
    const duration = (endFrame - startFrame) * FRAME_TICKS
    if (startTime < previousEndTime) {
      throw new Error(`字幕 cue ${index + 1} 投影到 24fps 后与上一条重叠`)
    }
    previousEndTime = startTime + duration
    return {
      text: cue.text,
      startTime,
      duration,
      sourceStartMs,
      sourceEndMs,
    }
  })

  return {
    cueSetId: input.cueSetId,
    dialogueLineId: input.dialogueLineId,
    storySceneId: input.storySceneId,
    storyShotId: input.storyShotId,
    speechAssetId: input.speechAssetId,
    sourceAudioElementId: audio.id,
    sourceAudioStartTime: range.sourceAudioStartTime,
    sourceAudioTrimStart: range.sourceAudioTrimStart,
    sourceAudioDuration: range.sourceAudioDuration,
    cues,
  }
}
