import type {
  EditorSceneTracks,
  EditorTimelineElement,
  ElementUpdateEntry,
} from '@manju/opencut-editor'
import type { TimelineAutoEditPreview } from '../../lib/api-types'
import { parseOpenCutTracks } from './timeline-codec'

export interface TimelineAutoEditPreviewOverlay {
  timingByElement: Map<string, ElementUpdateEntry['patch']>
  changedElementIds: Set<string>
}

export class TimelineAutoEditPreviewValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimelineAutoEditPreviewValidationError'
  }
}

function key(trackId: string, elementId: string): string {
  return `${trackId}\u0000${elementId}`
}

function orderedTracks(tracks: EditorSceneTracks) {
  return [...tracks.overlay, tracks.main, ...tracks.audio]
}

function elementMap(tracks: EditorSceneTracks): Map<string, EditorTimelineElement> {
  return new Map(orderedTracks(tracks).flatMap((track) => (
    track.elements.map((element) => [key(track.id, element.id), element] as const)
  )))
}

function timing(element: EditorTimelineElement) {
  return {
    startTime: element.startTime,
    duration: element.duration,
    trimStart: element.trimStart,
    trimEnd: element.trimEnd,
  }
}

function withoutTiming(element: EditorTimelineElement): Record<string, unknown> {
  const {
    startTime: _startTime,
    duration: _duration,
    trimStart: _trimStart,
    trimEnd: _trimEnd,
    ...rest
  } = element
  return rest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface TimelineAutomaticEditDisplay {
  planHash: string
  operationCount: number
  changedElementIds: Set<string>
  applicationId: string | null
}

/** Only the current auto-edit head may expose persistent undo controls. */
export function readCurrentTimelineAutomaticEdit(
  document: Record<string, unknown>,
  parentRevisionId: string | null,
): TimelineAutomaticEditDisplay | null {
  const integration = isRecord(document.manjuTimeline) ? document.manjuTimeline : null
  const value = integration && isRecord(integration.automaticEdit)
    ? integration.automaticEdit
    : null
  if (!value
    || value.version !== 1
    || value.strategy !== 'managed-dialogue-reflow-v1'
    || value.executor !== 'OpenCut-Classic/UpdateElementsCommand'
    || value.policy !== 'auto-applied'
    || value.risk !== 'safe'
    || value.baseRevisionId !== parentRevisionId
    || typeof value.planHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.planHash)
    || !Number.isSafeInteger(value.operationCount)
    || (value.operationCount as number) < 1
    || !Array.isArray(value.changedElementIds)
    || value.changedElementIds.length !== value.operationCount
    || value.changedElementIds.some((id) => typeof id !== 'string' || !id)
    || (value.applicationId !== undefined
      && (typeof value.applicationId !== 'string' || !value.applicationId.trim()))) return null
  const changedElementIds = new Set(value.changedElementIds as string[])
  if (changedElementIds.size !== value.changedElementIds.length) return null
  return {
    planHash: value.planHash,
    operationCount: value.operationCount as number,
    changedElementIds,
    applicationId: typeof value.applicationId === 'string' ? value.applicationId : null,
  }
}

function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => same(value, right[index]))
  }
  if (typeof left !== 'object' || left === null
    || typeof right !== 'object' || right === null) return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && same(leftRecord[key], rightRecord[key])
    ))
}

const SUBTITLE_SOURCE_TIMING_KEYS = [
  'sourceAudioStartTime',
  'sourceAudioTrimStart',
  'sourceAudioDuration',
] as const

function validManagedSubtitleCue(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.cueSetId !== 'string' || !value.cueSetId
    || typeof value.dialogueLineId !== 'string' || !value.dialogueLineId
    || typeof value.storySceneId !== 'string' || !value.storySceneId
    || typeof value.storyShotId !== 'string' || !value.storyShotId
    || typeof value.speechAssetId !== 'string' || !value.speechAssetId
    || typeof value.sourceAudioElementId !== 'string' || !value.sourceAudioElementId
    || !Number.isSafeInteger(value.sourceCueIndex) || (value.sourceCueIndex as number) < 0
    || !Number.isSafeInteger(value.sourceStartMs) || (value.sourceStartMs as number) < 0
    || !Number.isSafeInteger(value.sourceEndMs)
    || (value.sourceEndMs as number) <= (value.sourceStartMs as number)) return false
  return SUBTITLE_SOURCE_TIMING_KEYS.every((field) => (
    Number.isSafeInteger(value[field]) && (value[field] as number) >= 0
  )) && (value.sourceAudioDuration as number) > 0
}

function withoutSubtitleSourceTiming(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(metadata)
  const cue = isRecord(clone.subtitleCue) ? clone.subtitleCue : null
  if (cue) SUBTITLE_SOURCE_TIMING_KEYS.forEach((field) => { delete cue[field] })
  return clone
}

function isDeclaredManagedSubtitleProvenanceSync(input: {
  baseElement: EditorTimelineElement
  plannedElement: EditorTimelineElement
  operationReason: string | undefined
  plannedElements: Map<string, EditorTimelineElement>
}): boolean {
  const { baseElement, plannedElement, operationReason, plannedElements } = input
  if (operationReason !== 'synchronize-managed-subtitle'
    || baseElement.type !== 'text'
    || plannedElement.type !== 'text') return false

  const baseWithoutManju = { ...withoutTiming(baseElement), manju: undefined }
  const plannedWithoutManju = { ...withoutTiming(plannedElement), manju: undefined }
  if (!same(baseWithoutManju, plannedWithoutManju)) return false

  const baseManju = isRecord(baseElement.manju) ? baseElement.manju : null
  const plannedManju = isRecord(plannedElement.manju) ? plannedElement.manju : null
  const baseCue = baseManju && validManagedSubtitleCue(baseManju.subtitleCue)
    ? baseManju.subtitleCue
    : null
  const plannedCue = plannedManju && validManagedSubtitleCue(plannedManju.subtitleCue)
    ? plannedManju.subtitleCue
    : null
  if (!baseManju || !plannedManju || !baseCue || !plannedCue
    || !same(withoutSubtitleSourceTiming(baseManju), withoutSubtitleSourceTiming(plannedManju))) {
    return false
  }

  const sourceAudio = [...plannedElements.values()].find((element) => (
    element.id === plannedCue.sourceAudioElementId
  ))
  return sourceAudio?.type === 'audio'
    && sourceAudio.mediaId === plannedCue.speechAssetId
    && plannedCue.sourceAudioStartTime === sourceAudio.startTime
    && plannedCue.sourceAudioTrimStart === sourceAudio.trimStart
    && plannedCue.sourceAudioDuration === sourceAudio.duration
}

const SHORT_VIDEO_FILL_STABLE_KEYS = [
  'version',
  'strategy',
  'fallbackAssetId',
  'storySceneId',
  'storyShotId',
  'sourceRevisionId',
  'sourceDurationTicks',
  'targetDurationTicks',
] as const

function withoutShortVideoFillAuditState(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(metadata)
  const fill = isRecord(clone.shortVideoFill) ? clone.shortVideoFill : null
  if (fill) {
    delete fill.appliedByOpenCut
    delete fill.appliedPlanHash
  }
  return clone
}

function isDeclaredShortVideoFillAudit(input: {
  baseElement: EditorTimelineElement
  plannedElement: EditorTimelineElement
  operationReason: string | undefined
}): boolean {
  const { baseElement, plannedElement, operationReason } = input
  if (operationReason !== 'fill-short-managed-video-with-same-shot-image'
    || baseElement.type !== 'video'
    || plannedElement.type !== 'video') return false
  const baseWithoutManju = { ...withoutTiming(baseElement), manju: undefined }
  const plannedWithoutManju = { ...withoutTiming(plannedElement), manju: undefined }
  if (!same(baseWithoutManju, plannedWithoutManju)) return false
  const baseManju = isRecord(baseElement.manju) ? baseElement.manju : null
  const plannedManju = isRecord(plannedElement.manju) ? plannedElement.manju : null
  const baseFill = baseManju && isRecord(baseManju.shortVideoFill)
    ? baseManju.shortVideoFill
    : null
  const plannedFill = plannedManju && isRecord(plannedManju.shortVideoFill)
    ? plannedManju.shortVideoFill
    : null
  if (!baseManju || !plannedManju || !baseFill || !plannedFill
    || baseFill.appliedByOpenCut !== false
    || baseFill.appliedPlanHash !== null
    || plannedFill.appliedByOpenCut !== true
    || typeof plannedFill.appliedPlanHash !== 'string'
    || !/^[0-9a-f]{64}$/i.test(plannedFill.appliedPlanHash)
    || !SHORT_VIDEO_FILL_STABLE_KEYS.every((key) => baseFill[key] === plannedFill[key])) {
    return false
  }
  return same(
    withoutShortVideoFillAuditState(baseManju),
    withoutShortVideoFillAuditState(plannedManju),
  )
}

/**
 * A manual OpenCut command creates a new semantic head. The old application
 * remains auditable in its immutable revision, but must not be advertised as
 * undoable from the new head.
 */
export function withoutActiveTimelineAutoEditReceipt(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(document)
  if (!isRecord(next.manjuTimeline) || !Object.hasOwn(next.manjuTimeline, 'automaticEdit')) {
    return next
  }
  delete next.manjuTimeline.automaticEdit
  return next
}

/**
 * Builds a purely visual OpenCut overlay from a server-authored preview.
 *
 * The preview is rejected unless its operation list exactly explains every
 * changed element timing. This keeps the browser from displaying an unsafe or
 * stale plan and, importantly, never mutates the command editor while the user
 * is deciding whether to apply the new immutable revision.
 */
export function buildTimelineAutoEditPreviewOverlay(
  liveTracks: EditorSceneTracks,
  preview: TimelineAutoEditPreview,
): TimelineAutoEditPreviewOverlay {
  const baseTracks = parseOpenCutTracks(preview.timeline.document)
  const previewTracks = parseOpenCutTracks(preview.previewDocument)
  if (!baseTracks || !previewTracks) {
    throw new TimelineAutoEditPreviewValidationError(
      '自动剪辑预览不符合 pinned OpenCut canonical schema',
    )
  }

  const live = elementMap(liveTracks)
  const base = elementMap(baseTracks)
  const planned = elementMap(previewTracks)
  const operationsByElement = new Map(preview.operations.map((operation) => [
    key(operation.trackId, operation.elementId),
    operation,
  ]))
  if (live.size !== base.size || base.size !== planned.size) {
    throw new TimelineAutoEditPreviewValidationError('安全预览不允许添加或删除时间线元素')
  }

  for (const [elementKey, baseElement] of base) {
    const liveElement = live.get(elementKey)
    const plannedElement = planned.get(elementKey)
    if (!liveElement || !plannedElement) {
      throw new TimelineAutoEditPreviewValidationError('预览与当前 OpenCut 轨道拓扑不一致')
    }
    if (!same(timing(liveElement), timing(baseElement))) {
      throw new TimelineAutoEditPreviewValidationError('当前时间线已变更，请重新诊断')
    }
    const operation = operationsByElement.get(elementKey)
    if (!same(withoutTiming(baseElement), withoutTiming(plannedElement))
      && !isDeclaredManagedSubtitleProvenanceSync({
        baseElement,
        plannedElement,
        operationReason: operation?.reason,
        plannedElements: planned,
      })
      && !isDeclaredShortVideoFillAudit({
        baseElement,
        plannedElement,
        operationReason: operation?.reason,
      })) {
      throw new TimelineAutoEditPreviewValidationError('安全策略拒绝修改片段内容或媒体绑定')
    }
  }

  const timingByElement = new Map<string, ElementUpdateEntry['patch']>()
  const changedElementIds = new Set<string>()
  for (const operation of preview.operations) {
    const elementKey = key(operation.trackId, operation.elementId)
    const baseElement = base.get(elementKey)
    const plannedElement = planned.get(elementKey)
    if (!baseElement || !plannedElement
      || !same(timing(baseElement), operation.before)
      || !same(timing(plannedElement), operation.after)) {
      throw new TimelineAutoEditPreviewValidationError('预览操作无法与 OpenCut 片段前后状态对齐')
    }
    timingByElement.set(elementKey, { ...operation.after })
    changedElementIds.add(operation.elementId)
  }

  for (const [elementKey, baseElement] of base) {
    const plannedElement = planned.get(elementKey)!
    const changed = !same(timing(baseElement), timing(plannedElement))
    if (changed !== timingByElement.has(elementKey)) {
      throw new TimelineAutoEditPreviewValidationError('预览文档含有未在计划中声明的时间变更')
    }
  }

  return { timingByElement, changedElementIds }
}

export function createTimelineAutoEditIdempotencyKey(kind: 'apply' | 'undo'): string {
  return `timeline-auto-edit-${kind}-${crypto.randomUUID()}`
}
