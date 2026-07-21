import { createHash } from 'node:crypto'

import {
  applyOpenCutAtomicEdit,
  type OpenCutAtomicTimingOperation,
  type OpenCutElementTimingSnapshot,
} from '../apps/opencut-editor/src/opencut-atomic-edit.js'
import { createOpenCutCommandEditor } from '../apps/opencut-editor/src/opencut-command-editor.js'
import type {
  EditorSceneTracks,
  ReplaceManagedSubtitleCueSetInput,
} from '../apps/opencut-editor/src/contracts.js'
import type { ManjuDatabase } from './database.js'
import {
  CANONICAL_TIMELINE_DOCUMENT_VERSION,
  CANONICAL_TIMELINE_SCHEMA_VERSION,
  canonicalizeOpenCutTimelineDocument,
} from '../apps/opencut-editor/src/canonical-timeline-codec.js'
import {
  RENDER_SEMANTIC_SHORT_VIDEO_FILL_STRATEGY,
  RenderSemanticPlanError,
  shortVideoFillDescriptor,
} from '../apps/opencut-editor/src/render-semantic-plan.js'
import type { CanonicalTimelineElement } from '../apps/opencut-editor/src/canonical-timeline-codec.js'
import {
  PINNED_OPEN_CUT_CLASSIC_COMMIT,
  PINNED_OPEN_CUT_TICKS_PER_SECOND,
} from '../apps/opencut-editor/src/opencut-pinned-provenance.js'
import type { StoryRepository } from './story-repository.js'
import {
  parseStoryDocument,
  type StoryDialogueLine,
  type StoryDocument,
  type StoryShot,
} from './story-schema.js'
import {
  serializeTimelineDocument,
  TimelineDocumentError,
  TimelineDocumentService,
  type TimelineDocumentSnapshot,
} from './timeline-documents.js'
import { validateExportRenderSemantics } from './export-render.js'
import {
  parseCanonicalSpeechSubtitleCues,
  publicSpeechSubtitle,
  type SpeechSubtitleCue,
} from './speech-subtitle.js'
import {
  isShotVideoDurationDecision,
  resolveShotVideoDuration,
  shotVideoDurationDecisionIsCurrent,
  speechAssetBindingBlockReason,
  type SpeechAssetBindingBlockReason,
  type ShotVideoDurationDecision,
} from './shot-video-duration.js'
import type { JsonObject, JsonValue } from './types.js'
import {
  currentMediaAuthority,
  timelineMediaAuthorityReceipt,
  withServerMediaAuthorityFingerprint,
} from './media-authority.js'

export const OPEN_CUT_CLASSIC_COMMIT = PINNED_OPEN_CUT_CLASSIC_COMMIT
export const OPEN_CUT_TICKS_PER_SECOND = PINNED_OPEN_CUT_TICKS_PER_SECOND
export const OPEN_CUT_FRAME_RATE = 24
const TICKS_PER_FRAME = OPEN_CUT_TICKS_PER_SECOND / OPEN_CUT_FRAME_RATE
const MAX_DIALOGUE_AUDIO_SECONDS = 300

export type TimelineMaterializationErrorCode =
  | 'AMBIGUOUS_STORY_SHOT_ID'
  | 'AMBIGUOUS_STORY_DIALOGUE_LINE_ID'
  | 'INVALID_TIMELINE_STRUCTURE'
  | 'STORY_NOT_FOUND'
  | 'STORY_SOURCE_REVISION_NOT_FOUND'
  | 'TIMELINE_MEDIA_RECONCILIATION_REQUIRED'

export class TimelineMaterializationError extends Error {
  constructor(
    readonly code: TimelineMaterializationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TimelineMaterializationError'
  }
}

export interface TimelineStoryShotReference {
  sceneId: string
  shotId: string
}

export interface TimelineAppendedShot extends TimelineStoryShotReference {
  elementId: string
}

export interface TimelineOrphanedElement {
  sceneId: string | null
  shotId: string
  elementId: string
}

export interface TimelineReconciliationReport {
  operation: 'materialize' | 'reconcile'
  sourceRevisionId: string
  previousSourceRevisionId: string | null
  changed: boolean
  preservedElementIds: string[]
  appendedShots: TimelineAppendedShot[]
  orphanedElements: TimelineOrphanedElement[]
  /** Story shots deliberately absent from an edited timeline stay absent. */
  preservedAbsentShots: TimelineStoryShotReference[]
  /** No baseline existed, so these shots were not guessed into the edit. */
  unresolvedShots: TimelineStoryShotReference[]
  preservedAudioElementIds: string[]
  appendedDialogueAudio: TimelineAppendedDialogueAudio[]
  orphanedAudioElements: TimelineOrphanedAudioElement[]
  /** A managed clip deleted by the editor stays deleted until a new asset is generated. */
  preservedAbsentDialogueLines: TimelineDialogueReference[]
  speechConflicts: TimelineSpeechConflict[]
  updatedShotTimings: TimelineUpdatedShotTiming[]
  preservedShotTimings: TimelinePreservedShotTiming[]
  /** Present only when the pinned OpenCut command engine applied a safe edit. */
  automaticEdit: TimelineAutomaticEditReceipt | null
}

export interface TimelineAutomaticEditReceipt {
  version: 1
  strategy: 'managed-dialogue-reflow-v1'
  executor: 'OpenCut-Classic/UpdateElementsCommand'
  upstreamCommit: typeof OPEN_CUT_CLASSIC_COMMIT
  baseRevisionId: string | null
  sourceRevisionId: string
  planHash: string
  risk: 'safe'
  policy: 'auto-applied'
  operationCount: number
  changedElementIds: string[]
  operations: OpenCutAtomicTimingOperation[]
}

export interface TimelineUpdatedShotTiming extends TimelineStoryShotReference {
  elementId: string
  previousDuration: number
  nextDuration: number
  rippledElementIds: string[]
}

export interface TimelinePreservedShotTiming extends TimelineStoryShotReference {
  elementIds: string[]
  reason: 'baseline-unavailable' | 'duration-edited' | 'missing' | 'moved' | 'split' | 'trimmed'
}

export interface TimelineDialogueReference extends TimelineStoryShotReference {
  dialogueLineId: string
}

export interface TimelineAppendedDialogueAudio extends TimelineDialogueReference {
  elementId: string
  assetId: string
  startTime: number
  duration: number
}

export interface TimelineOrphanedAudioElement {
  sceneId: string | null
  shotId: string | null
  dialogueLineId: string
  elementId: string
  reason: 'dialogue-line-deleted' | 'speech-asset-invalid' | 'speech-asset-missing'
}

export type TimelineSpeechConflictCode =
  | 'SHOT_NOT_ON_TIMELINE'
  | 'SPEECH_ASSET_NOT_AUDIO'
  | 'SPEECH_ASSET_NOT_FOUND'
  | 'SPEECH_ASSET_NOT_READY'
  | 'SPEECH_ASSET_PROJECT_MISMATCH'
  | 'SPEECH_ASSET_EPISODE_MISMATCH'
  | 'SPEECH_ASSET_REVISION_MISMATCH'
  | 'SPEECH_ASSET_IDENTITY_MISSING'
  | 'SPEECH_DURATION_MISMATCH'
  | 'SPEECH_DURATION_MISSING'
  | 'SPEECH_DURATION_TOO_LONG'
  | 'SPEECH_OVERFLOWS_SHOT'
  | 'SPEECH_SHIFTED_FOR_TRACK_COLLISION'

export interface TimelineSpeechConflict extends TimelineDialogueReference {
  code: TimelineSpeechConflictCode
  assetId: string | null
  blocking: boolean
  message: string
}

export interface TimelineMaterializationResult extends TimelineDocumentSnapshot {
  created: boolean
  report: TimelineReconciliationReport
}

export interface TimelineMaterializationInput {
  projectId: string
  episodeId: string
  /** `null` corresponds to the create-only `If-Match: *` precondition. */
  expectedRevisionId: string | null
  summary?: string
  /** Pipeline-only: canonicalize managed dialogue in Story order for export. */
  autoLayoutManagedDialogue?: boolean
}

export interface TimelineAutomaticEditPlanInput {
  projectId: string
  episodeId: string
  /** The exact immutable timeline head used to produce this plan. */
  expectedRevisionId: string
}

export interface TimelineAutomaticEditDiagnostics {
  managedDialogueOperations: number
  managedSubtitleOperations: number
  managedVisualTailOperations: number
  managedShortVideoFillOperations: number
  visualEndBefore: number
  visualEndAfter: number
  managedDialogueEndBefore: number
  managedDialogueEndAfter: number
}

/**
 * A side-effect-free candidate. `document` is server-produced and must never
 * be accepted back from an HTTP client. Apply callers recompute it against the
 * same immutable head and compare `receipt.planHash` before persisting.
 */
export interface TimelineAutomaticEditCandidate {
  status: 'noop' | 'repairable'
  base: TimelineDocumentSnapshot
  sourceRevisionId: string
  document: JsonObject
  receipt: TimelineAutomaticEditReceipt | null
  diagnostics: TimelineAutomaticEditDiagnostics
}

interface StoryShotRef extends TimelineStoryShotReference {
  shot: StoryShot
  /** Exact 24fps edit duration selected before any visual generation. */
  timelineDurationSeconds: number
  durationDecision: ShotVideoDurationDecision | null
  assetId: string | null
  assetType: 'image' | 'video'
  sourceDurationSeconds: number | null
  sourceAudioEnabled: boolean
  sourceAudioRole: 'sfx' | null
  /** Same-shot immutable image explicitly locked on shots.storyboard_asset_id. */
  shortVideoFillAssetId: string | null
}

interface StoryDialogueRef extends TimelineDialogueReference {
  sequence: number
  line: StoryDialogueLine
  assetId: string | null
  mimeType: string | null
  durationSeconds: number | null
  mediaDurationSeconds: number | null
  lineDurationSeconds: number | null
  blockingIssue: TimelineSpeechConflictCode | null
  durationMismatch: boolean
}

interface TimelineDialogueManifestItem extends TimelineDialogueReference {
  managedAssetId: string | null
}

interface TimelineSpan {
  startTime: number
  endTime: number
}

interface PreviousStoryTiming {
  startTime: number
  duration: number
}

interface VisualAssociation {
  track: MutableTimelineTrack
  element: MutableTimelineElement
}

interface MutableTimelineElement {
  id: string
  type: string
  startTime: number
  duration: number
  name?: string
  trimStart?: number
  trimEnd?: number
  sourceDuration?: number
  isSourceAudioEnabled?: boolean
  params?: JsonObject
  mediaId?: string
  sourceType?: 'upload' | 'library'
  sourceUrl?: string
  manju?: JsonObject
  hidden?: boolean
}

interface MutableTimelineTrack {
  id: string
  name?: string
  type: string
  elements: MutableTimelineElement[]
  hidden?: boolean
  muted?: boolean
}

interface MutableTimelineTracks {
  overlay: MutableTimelineTrack[]
  main: MutableTimelineTrack
  audio: MutableTimelineTrack[]
}

interface StoryBaseline {
  known: boolean
  keys: Set<string>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function shotKey(sceneId: string, shotId: string): string {
  return JSON.stringify([sceneId, shotId])
}

function publicReference(ref: StoryShotRef): TimelineStoryShotReference {
  return { sceneId: ref.sceneId, shotId: ref.shotId }
}

function storyShotRefs(story: StoryDocument): StoryShotRef[] {
  return story.scenes.flatMap((scene) => scene.shots.map((shot) => ({
    sceneId: scene.id,
    shotId: shot.id,
    shot,
    timelineDurationSeconds: framesForSeconds(shot.durationSeconds) / OPEN_CUT_FRAME_RATE,
    durationDecision: null,
    assetId: null,
    assetType: 'image' as const,
    sourceDurationSeconds: null,
    sourceAudioEnabled: false,
    sourceAudioRole: null,
    shortVideoFillAssetId: null,
  })))
}

function dialogueKey(sceneId: string, shotId: string, dialogueLineId: string): string {
  return JSON.stringify([sceneId, shotId, dialogueLineId])
}

function publicDialogueReference(ref: StoryDialogueRef): TimelineDialogueReference {
  return {
    sceneId: ref.sceneId,
    shotId: ref.shotId,
    dialogueLineId: ref.dialogueLineId,
  }
}

function storyDialogueRefs(story: StoryDocument): StoryDialogueRef[] {
  return story.scenes.flatMap((scene) => scene.shots.flatMap((shot) => (
    shot.dialogueLines.map((line) => ({
      sceneId: scene.id,
      shotId: shot.id,
      dialogueLineId: line.id,
      sequence: line.sequence,
      line,
      assetId: null,
      mimeType: null,
      durationSeconds: null,
      mediaDurationSeconds: null,
      lineDurationSeconds: null,
      blockingIssue: null,
      durationMismatch: false,
    }))
  )))
}

function framesForSeconds(seconds: number): number {
  return Math.max(1, Math.round(seconds * OPEN_CUT_FRAME_RATE))
}

function ticksForSeconds(seconds: number): number {
  return framesForSeconds(seconds) * TICKS_PER_FRAME
}

function audioTicksCoveringSeconds(seconds: number): number {
  return Math.max(1, Math.ceil(seconds * OPEN_CUT_FRAME_RATE)) * TICKS_PER_FRAME
}

function uniqueId(preferred: string, used: Set<string>): string {
  if (!used.has(preferred)) {
    used.add(preferred)
    return preferred
  }
  let suffix = 2
  while (used.has(`${preferred}-${suffix}`)) suffix += 1
  const id = `${preferred}-${suffix}`
  used.add(id)
  return id
}

function unresolvedMediaId(elementId: string): string {
  return `manju:pending:${encodeURIComponent(elementId)}`
}

function isUnresolvedMediaBinding(element: MutableTimelineElement): boolean {
  return element.mediaId === unresolvedMediaId(element.id)
    || element.manju?.mediaBindingState === 'unresolved'
}

function clearUnresolvedMediaState(element: MutableTimelineElement): void {
  if (!element.manju || element.manju.mediaBindingState !== 'unresolved') return
  const next = { ...element.manju }
  delete next.mediaBindingState
  if (Object.keys(next).length === 0) {
    delete element.manju
  } else {
    element.manju = next
  }
}

function bindMedia(element: MutableTimelineElement, assetId: string): void {
  element.mediaId = assetId
  if (element.type === 'audio') {
    element.sourceType = 'upload'
    delete element.sourceUrl
  }
  clearUnresolvedMediaState(element)
}

function markMediaUnresolved(element: MutableTimelineElement): void {
  element.mediaId = unresolvedMediaId(element.id)
  if (element.type === 'audio') {
    element.sourceType = 'upload'
    delete element.sourceUrl
  }
  element.manju = {
    ...(element.manju ?? {}),
    mediaBindingState: 'unresolved',
  }
}

function parseAssetMetadata(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isPlainObject(parsed) || typeof parsed.storyId !== 'string' || !parsed.storyId) return null
    return parsed.storyId
  } catch {
    return null
  }
}

function requireTracks(document: JsonObject): MutableTimelineTracks {
  try {
    const canonical = canonicalizeOpenCutTimelineDocument(document).document
    for (const key of Object.keys(document)) delete document[key]
    Object.assign(document, canonical as unknown as JsonObject)
    return document.tracks as unknown as MutableTimelineTracks
  } catch (cause) {
    throw new TimelineMaterializationError(
      'INVALID_TIMELINE_STRUCTURE',
      cause instanceof Error
        ? `时间线不符合 pinned OpenCut canonical schema: ${cause.message}`
        : '时间线不符合 pinned OpenCut canonical schema',
      { cause },
    )
  }
}

function allTracks(tracks: MutableTimelineTracks): MutableTimelineTrack[] {
  return [...tracks.overlay, tracks.main, ...tracks.audio]
}

function visualTracks(tracks: MutableTimelineTracks): MutableTimelineTrack[] {
  return [...tracks.overlay.filter((track) => track.type === 'video'), tracks.main]
}

function maximumElementEnd(
  tracks: MutableTimelineTrack[],
  predicate: (element: MutableTimelineElement) => boolean,
): number {
  return tracks.reduce((maximum, track) => {
    if (track.hidden === true || track.muted === true) return maximum
    return track.elements.reduce((trackMaximum, element) => {
      if (!predicate(element)) return trackMaximum
      const end = element.startTime + element.duration
      if (!Number.isSafeInteger(end)) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `元素 ${element.id} 的结束时间超出安全整数范围`,
        )
      }
      return Math.max(trackMaximum, end)
    }, maximum)
  }, 0)
}

function automaticEditTimelineEnds(tracks: MutableTimelineTracks): {
  visualEnd: number
  managedDialogueEnd: number
} {
  return {
    visualEnd: maximumElementEnd(visualTracks(tracks), (element) => (
      element.type === 'image' || element.type === 'video'
    )),
    managedDialogueEnd: maximumElementEnd(tracks.audio, (element) => (
      typeof element.params?.storyManagedAssetId === 'string'
    )),
  }
}

function manifestFromDocument(document: JsonObject): StoryBaseline | null {
  const integration = document.manjuTimeline
  if (!isPlainObject(integration) || !Array.isArray(integration.storyShots)) return null
  const keys = new Set<string>()
  for (const item of integration.storyShots) {
    if (!isPlainObject(item)
      || typeof item.sceneId !== 'string'
      || !item.sceneId
      || typeof item.shotId !== 'string'
      || !item.shotId) return null
    keys.add(shotKey(item.sceneId, item.shotId))
  }
  return { known: true, keys }
}

function manifestFromRevision(database: ManjuDatabase, revisionId: string | null): StoryBaseline {
  if (!revisionId) return { known: false, keys: new Set() }
  const revision = database.getRevision(revisionId)
  if (!revision) return { known: false, keys: new Set() }
  try {
    return {
      known: true,
      keys: new Set(storyShotRefs(parseStoryDocument(revision.snapshot))
        .map((ref) => shotKey(ref.sceneId, ref.shotId))),
    }
  } catch {
    return { known: false, keys: new Set() }
  }
}

function storyTimingFromRevision(
  database: ManjuDatabase,
  revisionId: string | null,
): Map<string, PreviousStoryTiming> | null {
  if (!revisionId) return null
  const revision = database.getRevision(revisionId)
  if (!revision) return null
  try {
    const story = parseStoryDocument(revision.snapshot)
    const timings = new Map<string, PreviousStoryTiming>()
    let cursor = 0
    story.scenes.forEach((scene) => scene.shots.forEach((shot) => {
      const duration = ticksForSeconds(shot.durationSeconds)
      timings.set(shotKey(scene.id, shot.id), { startTime: cursor, duration })
      cursor += duration
    }))
    return timings
  } catch {
    return null
  }
}

function dialogueManifestFromDocument(
  document: JsonObject,
  tracks: MutableTimelineTracks,
): Map<string, TimelineDialogueManifestItem> {
  const result = new Map<string, TimelineDialogueManifestItem>()
  const integration = document.manjuTimeline
  if (isPlainObject(integration) && Array.isArray(integration.dialogueLines)) {
    let valid = true
    for (const item of integration.dialogueLines) {
      if (!isPlainObject(item)
        || typeof item.sceneId !== 'string'
        || !item.sceneId
        || typeof item.shotId !== 'string'
        || !item.shotId
        || typeof item.dialogueLineId !== 'string'
        || !item.dialogueLineId
        || (item.managedAssetId !== null && typeof item.managedAssetId !== 'string')) {
        valid = false
        break
      }
      const manifestItem: TimelineDialogueManifestItem = {
        sceneId: item.sceneId,
        shotId: item.shotId,
        dialogueLineId: item.dialogueLineId,
        managedAssetId: item.managedAssetId,
      }
      result.set(dialogueKey(item.sceneId, item.shotId, item.dialogueLineId), manifestItem)
    }
    if (valid) return result
    result.clear()
  }

  // Compatibility path for timelines written before dialogueLines entered the
  // Manju manifest. Existing explicit audio associations become the baseline;
  // an absent association is treated as not-yet-materialized, not fabricated.
  tracks.audio.forEach((track) => track.elements.forEach((element) => {
    const params = element.params
    const sceneId = typeof params?.storySceneId === 'string' ? params.storySceneId : null
    const shotId = typeof params?.storyShotId === 'string' ? params.storyShotId : null
    const lineId = typeof params?.dialogueLineId === 'string' ? params.dialogueLineId : null
    if (!sceneId || !shotId || !lineId) return
    const safeParams = params ?? {}
    const managedAssetId = typeof safeParams.storyManagedAssetId === 'string'
      ? safeParams.storyManagedAssetId
      : typeof element.mediaId === 'string' && !isUnresolvedMediaBinding(element)
        ? element.mediaId
        : null
    const item: TimelineDialogueManifestItem = {
      sceneId,
      shotId,
      dialogueLineId: lineId,
      managedAssetId,
    }
    result.set(dialogueKey(sceneId, shotId, lineId), item)
  }))
  return result
}

function withManifest(
  document: JsonObject,
  refs: StoryShotRef[],
  sourceRevisionId: string,
  dialogueManifest: Iterable<TimelineDialogueManifestItem>,
): void {
  const current = isPlainObject(document.manjuTimeline) ? document.manjuTimeline : {}
  const timingPayload: JsonObject = {
    version: 1,
    policy: 'speech-assets-first-v1',
    frameRate: OPEN_CUT_FRAME_RATE,
    sourceRevisionId,
    shots: refs.map((ref) => ({
      sceneId: ref.sceneId,
      shotId: ref.shotId,
      timelineDurationSeconds: ref.timelineDurationSeconds,
      ...(ref.durationDecision
        ? { durationDecision: ref.durationDecision as unknown as JsonValue }
        : {}),
    })) as unknown as JsonValue,
  }
  timingPayload.hash = createHash('sha256')
    .update(JSON.stringify(timingPayload))
    .digest('hex')
  document.manjuTimeline = {
    ...current,
    adapterVersion: 1,
    sourceRevisionId,
    storyShots: refs.map(publicReference) as unknown as JsonValue,
    dialogueLines: [...dialogueManifest] as unknown as JsonValue,
    audioDrivenTiming: timingPayload,
  }
  document.sourceRevisionId = sourceRevisionId
}

function withAutomaticEdit(
  document: JsonObject,
  receipt: TimelineAutomaticEditReceipt | null,
): void {
  if (!receipt) return
  const current = isPlainObject(document.manjuTimeline) ? document.manjuTimeline : {}
  document.manjuTimeline = {
    ...current,
    automaticEdit: receipt as unknown as JsonValue,
  }
}

function shortVideoFillMetadata(
  ref: StoryShotRef,
  sourceRevisionId: string,
): JsonObject | null {
  if (ref.assetType !== 'video'
    || ref.sourceDurationSeconds === null
    || ref.shortVideoFillAssetId === null) return null
  const sourceDurationTicks = ticksForSeconds(ref.sourceDurationSeconds)
  const targetDurationTicks = ticksForSeconds(ref.timelineDurationSeconds)
  if (sourceDurationTicks >= targetDurationTicks) return null
  return {
    version: 1,
    strategy: RENDER_SEMANTIC_SHORT_VIDEO_FILL_STRATEGY,
    fallbackAssetId: ref.shortVideoFillAssetId,
    storySceneId: ref.sceneId,
    storyShotId: ref.shotId,
    sourceRevisionId,
    sourceDurationTicks,
    targetDurationTicks,
    appliedByOpenCut: false,
    appliedPlanHash: null,
  }
}

function preserveAppliedShortVideoFill(
  current: unknown,
  pending: JsonObject | null,
): JsonObject | null {
  if (!pending || !isPlainObject(current)) return pending
  const stableKeys = [
    'version',
    'strategy',
    'fallbackAssetId',
    'storySceneId',
    'storyShotId',
    'sourceRevisionId',
    'sourceDurationTicks',
    'targetDurationTicks',
  ] as const
  if (!stableKeys.every((key) => current[key] === pending[key])
    || current.appliedByOpenCut !== true
    || typeof current.appliedPlanHash !== 'string'
    || !/^[0-9a-f]{64}$/i.test(current.appliedPlanHash)) return pending
  return {
    ...pending,
    appliedByOpenCut: true,
    appliedPlanHash: current.appliedPlanHash.toLowerCase(),
  }
}

function setShortVideoFillMetadata(
  element: MutableTimelineElement,
  metadata: JsonObject | null,
): void {
  const current = element.manju ?? {}
  if (metadata) {
    element.manju = { ...current, shortVideoFill: metadata }
    return
  }
  if (!Object.prototype.hasOwnProperty.call(current, 'shortVideoFill')) return
  const next = { ...current }
  delete next.shortVideoFill
  if (Object.keys(next).length > 0) element.manju = next
  else delete element.manju
}

function createElement(
  ref: StoryShotRef,
  startTime: number,
  usedElementIds: Set<string>,
  sourceRevisionId: string,
): MutableTimelineElement {
  const elementId = uniqueId(`story-${ref.sceneId}-${ref.shotId}`, usedElementIds)
  // These primitive story-association keys are the established pinned Classic
  // ParamValues extension. They locate Story entities only; media ownership is
  // always the canonical top-level mediaId/sourceType union.
  const params: JsonObject = {
    storyShotId: ref.shotId,
    storySceneId: ref.sceneId,
    sourceRevisionId,
  }
  if (ref.assetId) {
    params.storyAssetId = ref.assetId
  }
  if (ref.sourceAudioRole) params.audioRole = ref.sourceAudioRole
  const sourceDuration = ref.assetType === 'video' && ref.sourceDurationSeconds !== null
    ? ticksForSeconds(ref.sourceDurationSeconds)
    : undefined
  const fill = shortVideoFillMetadata(ref, sourceRevisionId)
  const targetDuration = ticksForSeconds(ref.timelineDurationSeconds)
  const element: MutableTimelineElement = {
    id: elementId,
    name: ref.shot.code || ref.shot.title,
    type: ref.assetType,
    startTime,
    // A short generated video is first materialized at its immutable source
    // length. Agentic auto-edit may restore the intended edit point only when
    // the explicit same-shot image-hold provenance below remains valid.
    duration: fill && sourceDuration !== undefined ? sourceDuration : targetDuration,
    trimStart: 0,
    trimEnd: 0,
    ...(sourceDuration === undefined ? {} : { sourceDuration }),
    ...(ref.assetType === 'video' ? { isSourceAudioEnabled: ref.sourceAudioEnabled } : {}),
    params,
    ...(fill ? { manju: { shortVideoFill: fill } } : {}),
  }
  if (ref.assetId) bindMedia(element, ref.assetId)
  else markMediaUnresolved(element)
  return element
}

function materializedDocument(refs: StoryShotRef[], sourceRevisionId: string): JsonObject {
  const usedElementIds = new Set<string>()
  let cursor = 0
  const elements = refs.map((ref) => {
    const element = createElement(ref, cursor, usedElementIds, sourceRevisionId)
    // Preserve Story edit points even while a short-video candidate waits for
    // the atomic fill command; the temporary gap makes the missing operation
    // visible to the formal exportability gate.
    cursor += ticksForSeconds(ref.timelineDurationSeconds)
    return element
  })
  const document = {
    version: CANONICAL_TIMELINE_DOCUMENT_VERSION,
    editor: 'OpenCut-Classic',
    upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
    ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
    frameRate: { numerator: OPEN_CUT_FRAME_RATE, denominator: 1 },
    tracks: {
      overlay: [{
        id: 'visual-main',
        name: 'Visuals',
        type: 'video',
        hidden: false,
        muted: false,
        elements,
      }],
      main: {
        id: 'main',
        name: 'Main',
        type: 'video',
        hidden: false,
        muted: false,
        elements: [],
      },
      audio: [],
    },
  } as unknown as JsonObject
  return document
}

function dialogueAssetReady(ref: StoryDialogueRef): ref is StoryDialogueRef & {
  assetId: string
  durationSeconds: number
} {
  return ref.assetId !== null
    && ref.durationSeconds !== null
    && ref.blockingIssue === null
}

function timelineSpeechBindingConflict(
  reason: SpeechAssetBindingBlockReason,
  assetProjectId: unknown,
  expectedProjectId: string,
): TimelineSpeechConflictCode {
  switch (reason) {
    case 'SPEECH_ASSET_MISSING': return 'SPEECH_ASSET_NOT_FOUND'
    case 'SPEECH_ASSET_NOT_READY': return 'SPEECH_ASSET_NOT_READY'
    case 'SPEECH_ASSET_NOT_AUDIO': return 'SPEECH_ASSET_NOT_AUDIO'
    case 'SPEECH_ASSET_SCOPE_MISMATCH': return assetProjectId === expectedProjectId
      ? 'SPEECH_ASSET_EPISODE_MISMATCH'
      : 'SPEECH_ASSET_PROJECT_MISMATCH'
    case 'SPEECH_ASSET_REVISION_MISMATCH': return 'SPEECH_ASSET_REVISION_MISMATCH'
    case 'SPEECH_ASSET_IDENTITY_MISSING': return 'SPEECH_ASSET_IDENTITY_MISSING'
    case 'SPEECH_DURATION_MISSING': return 'SPEECH_DURATION_MISSING'
  }
}

function speechConflictMessage(code: TimelineSpeechConflictCode): string {
  switch (code) {
    case 'SHOT_NOT_ON_TIMELINE': return '所属镜头不在当前视觉时间线中，未猜测音频起点'
    case 'SPEECH_ASSET_NOT_AUDIO': return '语音资产不是受支持的 MP3/WAV'
    case 'SPEECH_ASSET_NOT_FOUND': return '语音关联指向不存在的媒体资产'
    case 'SPEECH_ASSET_NOT_READY': return '语音资产尚未处于 ready 状态'
    case 'SPEECH_ASSET_PROJECT_MISMATCH': return '语音资产不属于当前项目'
    case 'SPEECH_ASSET_EPISODE_MISMATCH': return '语音资产不属于当前分集'
    case 'SPEECH_ASSET_REVISION_MISMATCH': return '语音资产不属于当前 Story 修订'
    case 'SPEECH_ASSET_IDENTITY_MISSING': return '语音资产缺少不可变版本或 SHA-256 身份'
    case 'SPEECH_DURATION_MISMATCH': return '媒体时长与台词记录时长不一致，已优先使用媒体时长'
    case 'SPEECH_DURATION_MISSING': return '语音资产缺少可信时长，未创建伪造片段'
    case 'SPEECH_DURATION_TOO_LONG': return `语音资产超过 ${MAX_DIALOGUE_AUDIO_SECONDS} 秒安全上限`
    case 'SPEECH_OVERFLOWS_SHOT': return '语音实际时长超出所属镜头范围，保留完整音频并报告冲突'
    case 'SPEECH_SHIFTED_FOR_TRACK_COLLISION': return '目标位置与 dialogue-main 现有音频冲突，已向后安全顺延'
  }
}

function addSpeechConflict(
  report: TimelineReconciliationReport,
  ref: StoryDialogueRef,
  code: TimelineSpeechConflictCode,
  blocking: boolean,
): void {
  if (report.speechConflicts.some((conflict) => (
    conflict.code === code
    && conflict.sceneId === ref.sceneId
    && conflict.shotId === ref.shotId
    && conflict.dialogueLineId === ref.dialogueLineId
  ))) return
  report.speechConflicts.push({
    ...publicDialogueReference(ref),
    code,
    assetId: ref.assetId,
    blocking,
    message: speechConflictMessage(code),
  })
}

function visualShotSpans(tracks: MutableTimelineTracks): Map<string, TimelineSpan> {
  const spans = new Map<string, TimelineSpan>()
  visualTracks(tracks).forEach((track) => track.elements.forEach((element) => {
    if (element.type !== 'image' && element.type !== 'video') return
    const sceneId = typeof element.params?.storySceneId === 'string'
      ? element.params.storySceneId
      : null
    const shotId = typeof element.params?.storyShotId === 'string'
      ? element.params.storyShotId
      : null
    if (!sceneId || !shotId) return
    const key = shotKey(sceneId, shotId)
    const existing = spans.get(key)
    const endTime = element.startTime + element.duration
    spans.set(key, existing
      ? {
          startTime: Math.min(existing.startTime, element.startTime),
          endTime: Math.max(existing.endTime, endTime),
        }
      : { startTime: element.startTime, endTime })
  }))
  return spans
}

/**
 * A durable media-authority receipt is stronger than Story metadata: every
 * visible Story-associated visual that will render must actually consume the
 * current Shot pointer. Missing/deleted Story shots and unrelated editor media
 * are allowed, but a hand-replaced managed clip must remain untrusted until a
 * future explicit override audit exists.
 */
function mediaAuthorityConsumptionError(
  tracks: MutableTimelineTracks,
  refs: StoryShotRef[],
  sourceRevisionId: string,
): string | null {
  const refsByKey = new Map(refs.map((ref) => [shotKey(ref.sceneId, ref.shotId), ref]))
  const refsByShotId = new Map<string, StoryShotRef[]>()
  refs.forEach((ref) => {
    refsByShotId.set(ref.shotId, [...(refsByShotId.get(ref.shotId) ?? []), ref])
  })

  for (const track of visualTracks(tracks)) {
    if (track.hidden === true) continue
    for (const element of track.elements) {
      if (element.hidden === true || (element.type !== 'image' && element.type !== 'video')) continue
      const params = element.params
      const shotId = typeof params?.storyShotId === 'string' && params.storyShotId
        ? params.storyShotId
        : null
      if (!shotId) continue
      const sceneId = typeof params?.storySceneId === 'string' && params.storySceneId
        ? params.storySceneId
        : null
      const candidates = refsByShotId.get(shotId) ?? []
      const ref = sceneId
        ? refsByKey.get(shotKey(sceneId, shotId))
        : candidates.length === 1 ? candidates[0] : undefined
      // A preserved orphan is not governed by a current Shot pointer.
      if (!ref) continue

      if (params?.sourceRevisionId !== sourceRevisionId) {
        return `镜头 ${ref.shotId} 的时间线素材未绑定当前剧本修订`
      }
      if (ref.assetId === null) {
        if (!isUnresolvedMediaBinding(element)
          || typeof params?.storyAssetId === 'string') {
          return `镜头 ${ref.shotId} 尚无权威素材，但时间线仍在使用手工替换画面`
        }
        continue
      }
      if (isUnresolvedMediaBinding(element)
        || element.mediaId !== ref.assetId
        || element.type !== ref.assetType
        || params?.storyAssetId !== ref.assetId) {
        return `镜头 ${ref.shotId} 的时间线画面与当前审片选中素材不一致`
      }

      let fill
      try {
        fill = shortVideoFillDescriptor(
          element as unknown as CanonicalTimelineElement,
          `timeline element ${element.id}`,
        )
      } catch {
        return `镜头 ${ref.shotId} 的同镜静帧补尾绑定无效`
      }
      const expectedFill = shortVideoFillMetadata(ref, sourceRevisionId)
      if (Boolean(fill) !== Boolean(expectedFill)) {
        return `镜头 ${ref.shotId} 的同镜静帧补尾缺失或不应存在`
      }
      if (fill && expectedFill && (ref.assetType !== 'video'
        || ref.shortVideoFillAssetId !== fill.fallbackAssetId
        || fill.storySceneId !== ref.sceneId
        || fill.storyShotId !== ref.shotId
        || fill.sourceRevisionId !== sourceRevisionId
        || fill.sourceDurationTicks !== expectedFill.sourceDurationTicks
        || fill.targetDurationTicks !== expectedFill.targetDurationTicks)) {
        return `镜头 ${ref.shotId} 的同镜静帧补尾已与当前选版不一致`
      }
    }
  }
  return null
}

function createDialogueElement(
  ref: StoryDialogueRef & { assetId: string; durationSeconds: number },
  startTime: number,
  usedElementIds: Set<string>,
  sourceRevisionId: string,
): MutableTimelineElement {
  const element: MutableTimelineElement = {
    id: uniqueId(
      `dialogue-${ref.sceneId}-${ref.shotId}-${ref.dialogueLineId}`,
      usedElementIds,
    ),
    name: ref.dialogueLineId,
    type: 'audio',
    startTime,
    duration: audioTicksCoveringSeconds(ref.durationSeconds),
    trimStart: 0,
    trimEnd: 0,
    params: {
      dialogueLineId: ref.dialogueLineId,
      storyShotId: ref.shotId,
      storySceneId: ref.sceneId,
      storyManagedAssetId: ref.assetId,
      sourceRevisionId,
    },
  }
  bindMedia(element, ref.assetId)
  return element
}

function automaticSubtitleCueSetId(
  ref: StoryDialogueRef & { assetId: string },
  cues: readonly SpeechSubtitleCue[],
): string {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    version: 1,
    sceneId: ref.sceneId,
    shotId: ref.shotId,
    dialogueLineId: ref.dialogueLineId,
    speechAssetId: ref.assetId,
    cues,
  })).digest('hex')
  return `auto-speech-${fingerprint.slice(0, 40)}`
}

function isManagedSubtitleElement(element: MutableTimelineElement): boolean {
  return element.type === 'text'
    && (element.params?.manjuRole === 'speech-subtitle'
      || isPlainObject(element.manju?.subtitleCue))
}

/**
 * A text element explicitly bound to the same Story line but not carrying the
 * managed-subtitle namespace is editor-owned. Automatic materialization must
 * not add another visible cue on top of it or reinterpret its timing.
 */
function hasExplicitManualSubtitle(
  tracks: MutableTimelineTracks,
  ref: StoryDialogueRef,
): boolean {
  return allTracks(tracks).some((track) => track.elements.some((element) => (
    element.type === 'text'
    && !isManagedSubtitleElement(element)
    && element.params?.dialogueLineId === ref.dialogueLineId
    && element.params?.storySceneId === ref.sceneId
    && element.params?.storyShotId === ref.shotId
  )))
}

/**
 * Project immutable source-asset millisecond timestamps onto one complete,
 * untrimmed 24fps OpenCut audio element. The source timestamps remain relative
 * to the speech Asset; only startTime is translated into absolute timeline
 * ticks. This mirrors the interactive projection, but runs before persistence.
 */
function projectAutomaticSubtitleCueSet(
  ref: StoryDialogueRef & { assetId: string; durationSeconds: number },
  audio: MutableTimelineElement,
  sourceCues: readonly SpeechSubtitleCue[],
): ReplaceManagedSubtitleCueSetInput {
  if (audio.type !== 'audio'
    || audio.mediaId !== ref.assetId
    || audio.params?.dialogueLineId !== ref.dialogueLineId
    || audio.params?.storySceneId !== ref.sceneId
    || audio.params?.storyShotId !== ref.shotId
    || audio.hidden === true) {
    throw new TimelineMaterializationError(
      'INVALID_TIMELINE_STRUCTURE',
      `台词 ${ref.dialogueLineId} 的自动字幕与语音片段绑定不一致`,
    )
  }
  const sourceAudioStartTime = audio.startTime
  const sourceAudioTrimStart = audio.trimStart ?? 0
  const sourceAudioDuration = audio.duration
  if (!Number.isSafeInteger(sourceAudioStartTime)
    || sourceAudioStartTime < 0
    || sourceAudioStartTime % TICKS_PER_FRAME !== 0
    || sourceAudioTrimStart !== 0
    || !Number.isSafeInteger(sourceAudioDuration)
    || sourceAudioDuration <= 0
    || sourceAudioDuration % TICKS_PER_FRAME !== 0
    || sourceAudioDuration !== audioTicksCoveringSeconds(ref.durationSeconds)) {
    throw new TimelineMaterializationError(
      'INVALID_TIMELINE_STRUCTURE',
      `台词 ${ref.dialogueLineId} 的语音已被裁切或改变时长，不会猜测自动字幕时码`,
    )
  }

  const durationFrames = sourceAudioDuration / TICKS_PER_FRAME
  const visibleDurationMs = (sourceAudioDuration * 1_000) / OPEN_CUT_TICKS_PER_SECOND
  let previousEndTime = sourceAudioStartTime
  const cues = sourceCues.map((cue, index) => {
    const sourceStartMs = Math.max(0, cue.startMs)
    const sourceEndMs = Math.min(cue.endMs, Math.floor(visibleDurationMs))
    if (!Number.isSafeInteger(sourceStartMs)
      || !Number.isSafeInteger(sourceEndMs)
      || sourceEndMs <= sourceStartMs) {
      throw new TimelineMaterializationError(
        'INVALID_TIMELINE_STRUCTURE',
        `台词 ${ref.dialogueLineId} 的第 ${index + 1} 条字幕不在可见语音范围内`,
      )
    }
    const startFrame = Math.max(
      0,
      Math.min(durationFrames, Math.round((sourceStartMs * OPEN_CUT_FRAME_RATE) / 1_000)),
    )
    let endFrame = Math.max(
      0,
      Math.min(durationFrames, Math.round((sourceEndMs * OPEN_CUT_FRAME_RATE) / 1_000)),
    )
    if (endFrame <= startFrame && startFrame < durationFrames) endFrame = startFrame + 1
    const startTime = sourceAudioStartTime + startFrame * TICKS_PER_FRAME
    const duration = (endFrame - startFrame) * TICKS_PER_FRAME
    if (duration <= 0 || startTime < previousEndTime) {
      throw new TimelineMaterializationError(
        'INVALID_TIMELINE_STRUCTURE',
        `台词 ${ref.dialogueLineId} 的第 ${index + 1} 条字幕无法投影到 24fps 时间线`,
      )
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
    cueSetId: automaticSubtitleCueSetId(ref, sourceCues),
    dialogueLineId: ref.dialogueLineId,
    storySceneId: ref.sceneId,
    storyShotId: ref.shotId,
    speechAssetId: ref.assetId,
    sourceAudioElementId: audio.id,
    sourceAudioStartTime,
    sourceAudioTrimStart,
    sourceAudioDuration,
    cues,
  }
}

function availableAudioStart(
  track: MutableTimelineTrack,
  desiredStart: number,
  duration: number,
): number {
  let candidate = desiredStart
  const intervals = track.elements
    .map((element) => ({
      startTime: element.startTime,
      endTime: element.startTime + element.duration,
    }))
    .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime)
  for (const interval of intervals) {
    if (candidate + duration <= interval.startTime) break
    if (candidate < interval.endTime && candidate + duration > interval.startTime) {
      candidate = interval.endTime
    }
  }
  return candidate
}

function emptyReport(
  operation: TimelineReconciliationReport['operation'],
  sourceRevisionId: string,
  previousSourceRevisionId: string | null,
): TimelineReconciliationReport {
  return {
    operation,
    sourceRevisionId,
    previousSourceRevisionId,
    changed: true,
    preservedElementIds: [],
    appendedShots: [],
    orphanedElements: [],
    preservedAbsentShots: [],
    unresolvedShots: [],
    preservedAudioElementIds: [],
    appendedDialogueAudio: [],
    orphanedAudioElements: [],
    preservedAbsentDialogueLines: [],
    speechConflicts: [],
    updatedShotTimings: [],
    preservedShotTimings: [],
    automaticEdit: null,
  }
}

function assertTimelineHead(current: TimelineDocumentSnapshot, expectedRevisionId: string | null): void {
  if (expectedRevisionId === null || current.revision.id !== expectedRevisionId) {
    throw new TimelineDocumentError(
      'TIMELINE_DOCUMENT_CONFLICT',
      '时间线已在其他编辑会话中更新，请刷新后重试',
      current.revision.id,
    )
  }
}

export class TimelineMaterializationService {
  constructor(
    private readonly database: ManjuDatabase,
    private readonly stories: StoryRepository,
    private readonly timelines: TimelineDocumentService,
  ) {}

  /**
   * Pipeline auto-layout is allowed to persist only a candidate that the
   * formal exporter can consume. Keep this check before TimelineDocumentService
   * creates the immutable revision so a repairable managed-dialogue issue plus
   * an unrelated unsafe edit cannot leave a misleading half-repaired head.
   *
   * The identifiers are provenance-only inputs to the renderer-neutral plan;
   * asset identity, duration and checksum are still resolved from SQLite.
   */
  private assertAutomaticEditExportable(input: {
    projectId: string
    episodeId: string
    timelineDocumentId: string
    timelineRevisionId: string
    sourceRevisionId: string
    document: JsonObject
    automaticEdit: TimelineAutomaticEditReceipt | null
  }): void {
    if (!input.automaticEdit) return
    validateExportRenderSemantics(this.database, {
      projectId: input.projectId,
      episodeId: input.episodeId,
      timelineDocumentId: input.timelineDocumentId,
      timelineRevisionId: input.timelineRevisionId,
      storyRevisionId: input.sourceRevisionId,
      document: input.document,
    })
  }

  /**
   * Build an exact, server-owned automatic-edit candidate without persisting
   * a timeline revision. This is the only planner entry point exposed to the
   * HTTP preview/apply layer; callers may select the safe policy but may not
   * provide arbitrary OpenCut operations or a replacement document.
   */
  planAutomaticEdit(
    input: TimelineAutomaticEditPlanInput,
  ): TimelineAutomaticEditCandidate {
    const current = this.timelines.get(input.episodeId)
    assertTimelineHead(current, input.expectedRevisionId)
    if (current.timelineDocument.projectId !== input.projectId) {
      throw new TimelineDocumentError(
        'EPISODE_PROJECT_MISMATCH',
        `Episode ${input.episodeId} does not belong to project ${input.projectId}`,
      )
    }
    const { sourceRevisionId, refs, dialogueRefs } = this.currentStory(
      input.projectId,
      input.episodeId,
    )
    if (current.timelineDocument.sourceRevisionId !== sourceRevisionId) {
      throw new TimelineMaterializationError(
        'INVALID_TIMELINE_STRUCTURE',
        '当前时间线尚未对账到最新剧本修订，请先执行 reconcile 再预览自动剪辑',
      )
    }

    const document = structuredClone(current.document)
    const tracks = requireTracks(document)
    const before = automaticEditTimelineEnds(tracks)
    const receipt = this.autoLayoutManagedDialogue(
      tracks,
      refs,
      dialogueRefs,
      current.revision.id,
      sourceRevisionId,
    )
    const after = automaticEditTimelineEnds(tracks)
    if (receipt) withAutomaticEdit(document, receipt)
    // Re-run both the canonical parser and the bounded JSON serializer before
    // a candidate can cross the service boundary. This catches any planner or
    // pinned-command regression during preview rather than during persistence.
    requireTracks(document)
    serializeTimelineDocument(document)
    const operations = receipt?.operations ?? []
    return {
      status: receipt ? 'repairable' : 'noop',
      base: current,
      sourceRevisionId,
      document,
      receipt,
      diagnostics: {
        managedDialogueOperations: operations.filter((operation) => (
          operation.reason === 'reflow-managed-dialogue-in-story-order'
        )).length,
        managedSubtitleOperations: operations.filter((operation) => (
          operation.reason === 'synchronize-managed-subtitle'
        )).length,
        managedVisualTailOperations: operations.filter((operation) => (
          operation.reason === 'extend-managed-visual-tail'
        )).length,
        managedShortVideoFillOperations: operations.filter((operation) => (
          operation.reason === 'fill-short-managed-video-with-same-shot-image'
        )).length,
        visualEndBefore: before.visualEnd,
        visualEndAfter: after.visualEnd,
        managedDialogueEndBefore: before.managedDialogueEnd,
        managedDialogueEndAfter: after.managedDialogueEnd,
      },
    }
  }

  materialize(input: TimelineMaterializationInput): TimelineMaterializationResult {
    return this.database.transaction(() => {
      try {
        const current = this.timelines.get(input.episodeId)
        throw new TimelineDocumentError(
          'TIMELINE_DOCUMENT_CONFLICT',
          '时间线已经存在，请使用 reconcile 保留现有剪辑后对账',
          current.revision.id,
        )
      } catch (error) {
        if (!(error instanceof TimelineDocumentError)
          || error.code !== 'TIMELINE_DOCUMENT_NOT_FOUND') throw error
      }
      const { sourceRevisionId, refs, dialogueRefs } = this.currentStory(
        input.projectId,
        input.episodeId,
      )
      const document = materializedDocument(refs, sourceRevisionId)
      const tracks = requireTracks(document)
      const report = emptyReport('materialize', sourceRevisionId, null)
      const dialogueManifest = this.reconcileDialogueAudio({
        tracks,
        dialogueRefs,
        sourceRevisionId,
        report,
        baseline: new Map(),
      })
      if (input.autoLayoutManagedDialogue) {
        report.automaticEdit = this.autoLayoutManagedDialogue(
          tracks,
          refs,
          dialogueRefs,
          null,
          sourceRevisionId,
        )
      }
      this.materializeManagedSubtitles(tracks, dialogueRefs)
      withManifest(document, refs, sourceRevisionId, dialogueManifest.values())
      const mediaAuthority = currentMediaAuthority(this.database, {
        projectId: input.projectId,
        episodeId: input.episodeId,
      })
      if (mediaAuthority.sourceRevisionId !== sourceRevisionId) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          '媒体权威与当前剧本修订不一致，未固化时间线',
        )
      }
      withAutomaticEdit(document, report.automaticEdit)
      const untrustedDocument = withServerMediaAuthorityFingerprint(document, null)
      const finalizedTracks = requireTracks(untrustedDocument)
      const consumptionError = mediaAuthorityConsumptionError(
        finalizedTracks,
        refs,
        sourceRevisionId,
      )
      if (consumptionError && mediaAuthority.receiptRequired) {
        throw new TimelineMaterializationError(
          'TIMELINE_MEDIA_RECONCILIATION_REQUIRED',
          `${consumptionError}，未创建可信时间线；请先恢复审片选中素材或明确处理手工替换画面`,
        )
      }
      const trustedFingerprint = consumptionError
        ? null
        : mediaAuthority.fingerprint
      const finalizedDocument = withServerMediaAuthorityFingerprint(
        untrustedDocument,
        trustedFingerprint,
      )
      requireTracks(finalizedDocument)
      this.assertAutomaticEditExportable({
        projectId: input.projectId,
        episodeId: input.episodeId,
        timelineDocumentId: `unpersisted:${input.episodeId}`,
        timelineRevisionId: `unpersisted:${input.episodeId}:revision`,
        sourceRevisionId,
        document: finalizedDocument,
        automaticEdit: report.automaticEdit,
      })
      const saved = this.timelines.saveReconciled({
        projectId: input.projectId,
        episodeId: input.episodeId,
        expectedRevisionId: input.expectedRevisionId,
        schemaVersion: CANONICAL_TIMELINE_SCHEMA_VERSION,
        upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
        sourceRevisionId,
        ...(trustedFingerprint
          ? { mediaAuthorityFingerprint: trustedFingerprint }
          : {}),
        summary: input.summary?.trim() || '从剧本创建 OpenCut 时间线',
        document: finalizedDocument,
      })
      const elements = finalizedTracks.overlay[0].elements
      report.appendedShots = refs.map((ref, index) => ({
        ...publicReference(ref),
        elementId: elements[index].id,
      }))
      return { ...saved, report }
    })
  }

  reconcile(input: TimelineMaterializationInput): TimelineMaterializationResult {
    return this.database.transaction(() => {
      const current = this.timelines.get(input.episodeId)
      assertTimelineHead(current, input.expectedRevisionId)
      if (current.timelineDocument.projectId !== input.projectId) {
        throw new TimelineDocumentError(
          'EPISODE_PROJECT_MISMATCH',
          `Episode ${input.episodeId} does not belong to project ${input.projectId}`,
        )
      }
      const { sourceRevisionId, refs, dialogueRefs } = this.currentStory(
        input.projectId,
        input.episodeId,
      )
      const document = structuredClone(current.document)
      const tracks = requireTracks(document)
      const report = emptyReport(
        'reconcile',
        sourceRevisionId,
        current.timelineDocument.sourceRevisionId,
      )
      const dialogueBaseline = dialogueManifestFromDocument(current.document, tracks)
      const refsByShotId = new Map<string, StoryShotRef[]>()
      const refsByKey = new Map<string, StoryShotRef>()
      const visualAssociations = new Map<string, VisualAssociation[]>()
      refs.forEach((ref) => {
        const key = shotKey(ref.sceneId, ref.shotId)
        if (refsByKey.has(key)) {
          throw new TimelineMaterializationError(
            'AMBIGUOUS_STORY_SHOT_ID',
            `场景 ${ref.sceneId} 中镜头 ID ${ref.shotId} 重复`,
          )
        }
        refsByKey.set(key, ref)
        refsByShotId.set(ref.shotId, [...(refsByShotId.get(ref.shotId) ?? []), ref])
      })

      const matchedKeys = new Set<string>()
      const usedElementIds = new Set(allTracks(tracks).flatMap((track) => (
        track.elements.map((element) => element.id)
      )))
      allTracks(tracks).forEach((track) => {
        if (track.type === 'audio') return
        track.elements.forEach((element) => {
          // Text overlays can carry the same Story IDs for managed subtitle
          // provenance; they are not visual shot associations and must never
          // receive visual sourceRevision/storyAsset mutations.
          if (element.type !== 'image' && element.type !== 'video') return
          const params = element.params
          const storyShotId = typeof params?.storyShotId === 'string' && params.storyShotId
            ? params.storyShotId
            : null
          if (!storyShotId) return
          const storySceneId = typeof params?.storySceneId === 'string' && params.storySceneId
            ? params.storySceneId
            : null
          const candidates = refsByShotId.get(storyShotId) ?? []
          let ref: StoryShotRef | undefined
          if (storySceneId) {
            ref = refsByKey.get(shotKey(storySceneId, storyShotId))
          } else if (candidates.length === 1) {
            ref = candidates[0]
          }
          if (!ref && candidates.length > 1) {
            throw new TimelineMaterializationError(
              'AMBIGUOUS_STORY_SHOT_ID',
              `镜头 ID ${storyShotId} 在多个场景中重复，元素 ${element.id} 缺少可用的 storySceneId`,
            )
          }

          if (!ref) {
            const previousManagedAsset = typeof params?.storyAssetId === 'string'
              ? params.storyAssetId
              : null
            const nextParams: JsonObject = {
              ...params,
              storyOrphaned: true,
              orphanedAtSourceRevisionId: sourceRevisionId,
            }
            if (previousManagedAsset && element.mediaId === previousManagedAsset) {
              markMediaUnresolved(element)
            }
            delete nextParams.storyAssetId
            element.params = nextParams
            report.orphanedElements.push({
              sceneId: storySceneId,
              shotId: storyShotId,
              elementId: element.id,
            })
            return
          }

          const nextParams: JsonObject = {
            ...params,
            storyShotId: ref.shotId,
            storySceneId: ref.sceneId,
            sourceRevisionId,
          }
          delete nextParams.storyOrphaned
          delete nextParams.orphanedAtSourceRevisionId
          if (ref.assetId) {
            const previousManagedAsset = typeof nextParams.storyAssetId === 'string'
              ? nextParams.storyAssetId
              : null
            const usesManagedAsset = isUnresolvedMediaBinding(element)
              || element.mediaId === previousManagedAsset
            if (usesManagedAsset) {
              const managedSourceChanged = element.mediaId !== ref.assetId
                || element.type !== ref.assetType
              const pendingFill = shortVideoFillMetadata(ref, sourceRevisionId)
              const fill = preserveAppliedShortVideoFill(
                element.manju?.shortVideoFill,
                pendingFill,
              )
              const fillRequiresAtomicApply = Boolean(fill)
                && (managedSourceChanged || fill?.appliedByOpenCut !== true)
              const targetDuration = ticksForSeconds(ref.timelineDurationSeconds)
              const storyDuration = ticksForSeconds(ref.shot.durationSeconds)
              const sourceDuration = ref.sourceDurationSeconds === null
                ? null
                : ticksForSeconds(ref.sourceDurationSeconds)
              const canAdmitShortVideo = !fill
                || !fillRequiresAtomicApply
                || ((element.trimStart ?? 0) === 0
                  && (element.trimEnd ?? 0) === 0
                  && (element.duration === targetDuration
                    || element.duration === storyDuration
                    || element.duration === sourceDuration))
              // A hand-trimmed or hand-resized clip is not silently replaced
              // by a shorter generated video. Keep the prior visual binding;
              // the user can explicitly restore the Story timing first.
              if (canAdmitShortVideo) {
                bindMedia(element, ref.assetId)
                element.type = ref.assetType
              }
              if (canAdmitShortVideo
                && ref.assetType === 'video'
                && ref.sourceDurationSeconds !== null) {
                element.sourceDuration = ticksForSeconds(ref.sourceDurationSeconds)
                if (fill && fillRequiresAtomicApply) {
                  element.duration = fill.sourceDurationTicks as number
                  element.trimStart = 0
                  element.trimEnd = 0
                }
                setShortVideoFillMetadata(element, fill)
                if (managedSourceChanged || element.isSourceAudioEnabled === undefined) {
                  element.isSourceAudioEnabled = ref.sourceAudioEnabled
                  if (ref.sourceAudioRole) nextParams.audioRole = ref.sourceAudioRole
                  else delete nextParams.audioRole
                }
              } else if (canAdmitShortVideo) {
                delete element.sourceDuration
                delete element.isSourceAudioEnabled
                delete nextParams.audioRole
                setShortVideoFillMetadata(element, null)
              }
              if (canAdmitShortVideo) nextParams.storyAssetId = ref.assetId
              else if (previousManagedAsset) nextParams.storyAssetId = previousManagedAsset
              else delete nextParams.storyAssetId
            } else {
              nextParams.storyAssetId = ref.assetId
            }
          } else {
            const previousManagedAsset = typeof nextParams.storyAssetId === 'string'
              ? nextParams.storyAssetId
              : null
            if (previousManagedAsset && element.mediaId === previousManagedAsset) {
              markMediaUnresolved(element)
              element.type = 'image'
              delete element.sourceDuration
              delete element.isSourceAudioEnabled
              delete nextParams.audioRole
              setShortVideoFillMetadata(element, null)
            }
            delete nextParams.storyAssetId
          }
          element.params = nextParams
          const key = shotKey(ref.sceneId, ref.shotId)
          matchedKeys.add(key)
          if (element.type === 'image' || element.type === 'video') {
            visualAssociations.set(key, [
              ...(visualAssociations.get(key) ?? []),
              { track, element },
            ])
          }
          report.preservedElementIds.push(element.id)
        })
      })

      const baseline = manifestFromDocument(current.document)
        ?? manifestFromRevision(this.database, current.timelineDocument.sourceRevisionId)
      const targetTrack = this.targetVisualTrack(tracks)
      this.reconcileStoryDurations({
        refs,
        associations: visualAssociations,
        previousTimings: storyTimingFromRevision(
          this.database,
          current.timelineDocument.sourceRevisionId,
        ),
        sourceChanged: current.timelineDocument.sourceRevisionId !== sourceRevisionId,
        managedTrack: targetTrack,
        report,
      })
      let cursor = visualTracks(tracks).flatMap((track) => track.elements)
        .reduce((maximum, element) => {
          const end = element.startTime + element.duration
          if (!Number.isSafeInteger(end)) {
            throw new TimelineMaterializationError(
              'INVALID_TIMELINE_STRUCTURE',
              `元素 ${element.id} 的结束时间超出安全整数范围`,
            )
          }
          return Math.max(maximum, end)
        }, 0)

      refs.forEach((ref) => {
        const key = shotKey(ref.sceneId, ref.shotId)
        if (matchedKeys.has(key)) return
        if (baseline.known && baseline.keys.has(key)) {
          report.preservedAbsentShots.push(publicReference(ref))
          return
        }
        if (!baseline.known) {
          report.unresolvedShots.push(publicReference(ref))
          return
        }
        const element = createElement(ref, cursor, usedElementIds, sourceRevisionId)
        targetTrack.elements.push(element)
        cursor += element.duration
        report.appendedShots.push({ ...publicReference(ref), elementId: element.id })
      })

      const dialogueManifest = this.reconcileDialogueAudio({
        tracks,
        dialogueRefs,
        sourceRevisionId,
        report,
        baseline: dialogueBaseline,
        usedElementIds,
      })
      if (input.autoLayoutManagedDialogue) {
        report.automaticEdit = this.autoLayoutManagedDialogue(
          tracks,
          refs,
          dialogueRefs,
          current.revision.id,
          sourceRevisionId,
        )
      }
      this.materializeManagedSubtitles(tracks, dialogueRefs)
      withManifest(document, refs, sourceRevisionId, dialogueManifest.values())
      const mediaAuthority = currentMediaAuthority(this.database, {
        projectId: input.projectId,
        episodeId: input.episodeId,
      })
      if (mediaAuthority.sourceRevisionId !== sourceRevisionId) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          '媒体权威与当前剧本修订不一致，未固化时间线',
        )
      }
      withAutomaticEdit(document, report.automaticEdit)
      const untrustedDocument = withServerMediaAuthorityFingerprint(document, null)
      const finalizedTracks = requireTracks(untrustedDocument)
      const consumptionError = mediaAuthorityConsumptionError(
        finalizedTracks,
        refs,
        sourceRevisionId,
      )
      if (consumptionError && mediaAuthority.receiptRequired) {
        throw new TimelineMaterializationError(
          'TIMELINE_MEDIA_RECONCILIATION_REQUIRED',
          `${consumptionError}，无法签发可信对账回执；请先恢复审片选中素材或明确处理手工替换画面`,
        )
      }
      const trustedFingerprint = consumptionError
        ? null
        : mediaAuthority.fingerprint
      const finalizedDocument = withServerMediaAuthorityFingerprint(
        untrustedDocument,
        trustedFingerprint,
      )
      requireTracks(finalizedDocument)
      this.assertAutomaticEditExportable({
        projectId: input.projectId,
        episodeId: input.episodeId,
        timelineDocumentId: current.timelineDocument.id,
        timelineRevisionId: current.revision.id,
        sourceRevisionId,
        document: finalizedDocument,
        automaticEdit: report.automaticEdit,
      })
      const durableReceipt = timelineMediaAuthorityReceipt(this.database, current.revision.id)
      const receiptMatches = trustedFingerprint
        ? durableReceipt?.timelineRevisionId === current.revision.id
          && durableReceipt.documentId === current.timelineDocument.id
          && durableReceipt.projectId === input.projectId
          && durableReceipt.episodeId === input.episodeId
          && durableReceipt.sourceRevisionId === sourceRevisionId
          && durableReceipt.fingerprint === trustedFingerprint
        : durableReceipt === null
      const changed = serializeTimelineDocument(finalizedDocument)
          !== serializeTimelineDocument(current.document)
        || current.timelineDocument.schemaVersion !== CANONICAL_TIMELINE_SCHEMA_VERSION
        || current.timelineDocument.upstreamCommit !== OPEN_CUT_CLASSIC_COMMIT
        || current.timelineDocument.sourceRevisionId !== sourceRevisionId
        || !receiptMatches
      report.changed = changed
      if (!changed) return { ...current, created: false, report }

      const saved = this.timelines.saveReconciled({
        projectId: input.projectId,
        episodeId: input.episodeId,
        expectedRevisionId: current.revision.id,
        schemaVersion: CANONICAL_TIMELINE_SCHEMA_VERSION,
        upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
        sourceRevisionId,
        ...(trustedFingerprint
          ? { mediaAuthorityFingerprint: trustedFingerprint }
          : {}),
        summary: input.summary?.trim() || '对账剧本与 OpenCut 时间线',
        document: finalizedDocument,
      })
      return { ...saved, report }
    })
  }

  private reconcileStoryDurations(input: {
    refs: StoryShotRef[]
    associations: Map<string, VisualAssociation[]>
    previousTimings: Map<string, PreviousStoryTiming> | null
    sourceChanged: boolean
    managedTrack: MutableTimelineTrack
    report: TimelineReconciliationReport
  }): void {
    const {
      refs,
      associations,
      previousTimings,
      sourceChanged,
      managedTrack,
      report,
    } = input
    if (!previousTimings) {
      if (sourceChanged) {
        refs.forEach((ref) => {
          const elements = associations.get(shotKey(ref.sceneId, ref.shotId)) ?? []
          if (elements.length > 0) {
            report.preservedShotTimings.push({
              ...publicReference(ref),
              elementIds: elements.map(({ element }) => element.id),
              reason: 'baseline-unavailable',
            })
          }
        })
      }
      return
    }

    const currentStoryKeys = new Set(refs.map((ref) => shotKey(ref.sceneId, ref.shotId)))
    const eligible: Array<{
      ref: StoryShotRef
      association: VisualAssociation
      previous: PreviousStoryTiming
      nextDuration: number
    }> = []
    refs.forEach((ref) => {
      const key = shotKey(ref.sceneId, ref.shotId)
      const previous = previousTimings.get(key)
      if (!previous) return
      const nextDuration = ticksForSeconds(ref.shot.durationSeconds)
      if (nextDuration === previous.duration) return
      const elements = associations.get(key) ?? []
      let reason: TimelinePreservedShotTiming['reason'] | null = null
      if (elements.length === 0) {
        reason = 'missing'
      } else if (elements.length > 1) {
        reason = 'split'
      } else {
        const { track, element } = elements[0]
        if ((element.trimStart ?? 0) !== 0 || (element.trimEnd ?? 0) !== 0) {
          reason = 'trimmed'
        } else if (element.duration !== previous.duration) {
          reason = 'duration-edited'
        } else if (element.startTime !== previous.startTime || track.id !== managedTrack.id) {
          reason = 'moved'
        }
      }
      if (reason) {
        report.preservedShotTimings.push({
          ...publicReference(ref),
          elementIds: elements.map(({ element }) => element.id),
          reason,
        })
        return
      }
      eligible.push({ ref, association: elements[0], previous, nextDuration })
    })

    eligible.forEach(({ ref, association, previous, nextDuration }) => {
      const { track, element } = association
      const delta = nextDuration - previous.duration
      const oldEnd = element.startTime + element.duration
      element.duration = nextDuration
      const rippledElementIds: string[] = []
      let nextStart = oldEnd
      while (true) {
        const candidates = track.elements.filter((candidate) => (
          candidate !== element
          && (candidate.type === 'image' || candidate.type === 'video')
          && candidate.startTime === nextStart
          && candidate.params?.storyOrphaned !== true
          && typeof candidate.params?.storyShotId === 'string'
          && typeof candidate.params?.storySceneId === 'string'
          && currentStoryKeys.has(shotKey(
            candidate.params.storySceneId,
            candidate.params.storyShotId,
          ))
        ))
        if (candidates.length !== 1) break
        const candidate = candidates[0]
        const candidateOldEnd = candidate.startTime + candidate.duration
        candidate.startTime += delta
        rippledElementIds.push(candidate.id)
        nextStart = candidateOldEnd
      }
      report.updatedShotTimings.push({
        ...publicReference(ref),
        elementId: element.id,
        previousDuration: previous.duration,
        nextDuration,
        rippledElementIds,
      })
    })
  }

  /**
   * Resolve subtitle text and source-relative timestamps only from the exact
   * speech Asset bound to this line. MiniMax/provider cues win when valid. If
   * no trustworthy timestamp sidecar exists, the immutable Story sentence is
   * bound to [0, real media duration], which is a measured interval rather
   * than an estimated reading speed.
   */
  private automaticSubtitleSourceCues(
    ref: StoryDialogueRef & { assetId: string; durationSeconds: number },
  ): SpeechSubtitleCue[] | null {
    if (ref.mediaDurationSeconds === null || ref.mediaDurationSeconds <= 0) return null
    const asset = this.database.getMediaAsset(ref.assetId)
    if (!asset
      || asset.status !== 'ready'
      || !asset.mimeType?.toLowerCase().startsWith('audio/')) return null
    const generationLineId = asset.generationParameters.lineId
    if (typeof generationLineId === 'string' && generationLineId !== ref.dialogueLineId) {
      return null
    }
    const durationMs = Math.max(1, Math.round(ref.mediaDurationSeconds * 1_000))
    const subtitle = publicSpeechSubtitle(asset)
    if (subtitle?.mode === 'word'
      && subtitle.lineId === ref.dialogueLineId) {
      try {
        return parseCanonicalSpeechSubtitleCues(subtitle.cues, {
          durationMs,
          endToleranceMs: 500,
        })
      } catch {
        // The public projection is already fail-closed. A malformed or stale
        // sidecar must never fabricate word timing; use the exact full asset
        // interval below instead.
      }
    }
    return [{ text: ref.line.text, startMs: 0, endMs: durationMs }]
  }

  /**
   * Materialize missing/stale generated subtitles with OpenCut's atomic
   * ReplaceManagedSubtitleCueSetCommand. Valid cue sets (including user edits)
   * are immutable here, and explicitly line-bound manual text suppresses
   * automation so the viewer never sees duplicate captions.
   */
  private materializeManagedSubtitles(
    tracks: MutableTimelineTracks,
    dialogueRefs: StoryDialogueRef[],
  ): void {
    const editor = createOpenCutCommandEditor({
      tracks: tracks as unknown as EditorSceneTracks,
      frameRate: { numerator: OPEN_CUT_FRAME_RATE, denominator: 1 },
    })
    let changed = false

    // Automatic subtitles are projections of one exact immutable speech
    // binding. Once that binding disappears, becomes stale, or is replaced,
    // keeping its old cues visible would export text for audio that is no
    // longer authoritative. Remove only our auto-speech namespace; reviewed
    // or manual cue sets remain editor-owned and are never guessed away.
    const refsByKey = new Map(dialogueRefs.map((ref) => [
      dialogueKey(ref.sceneId, ref.shotId, ref.dialogueLineId),
      ref,
    ]))
    const staleAutomaticCues = allTracks(
      editor.getTracks() as unknown as MutableTimelineTracks,
    ).flatMap((track) => track.elements.flatMap((element) => {
      if (element.type !== 'text') return []
      const raw = element.manju?.subtitleCue
      if (!isPlainObject(raw)
        || typeof raw.cueSetId !== 'string'
        || !raw.cueSetId.startsWith('auto-speech-')
        || typeof raw.storySceneId !== 'string'
        || typeof raw.storyShotId !== 'string'
        || typeof raw.dialogueLineId !== 'string') return []
      const ref = refsByKey.get(dialogueKey(
        raw.storySceneId,
        raw.storyShotId,
        raw.dialogueLineId,
      ))
      if (ref
        && dialogueAssetReady(ref)
        && raw.speechAssetId === ref.assetId) return []
      return [{ trackId: track.id, elementId: element.id }]
    }))
    if (staleAutomaticCues.length > 0) {
      editor.deleteElements({ elements: staleAutomaticCues })
      changed = true
    }

    dialogueRefs.forEach((ref) => {
      if (!dialogueAssetReady(ref)) return
      const currentTracks = editor.getTracks() as unknown as MutableTimelineTracks
      const matchingAudio = currentTracks.audio.flatMap((track) => (
        track.muted === true
          ? []
          : track.elements.filter((element) => (
              element.type === 'audio'
              && element.hidden !== true
              && element.mediaId === ref.assetId
              && element.params?.storyManagedAssetId === ref.assetId
              && element.params?.dialogueLineId === ref.dialogueLineId
              && element.params?.storySceneId === ref.sceneId
              && element.params?.storyShotId === ref.shotId
            ))
      ))
      // Split/duplicate audio or incomplete editor timing is not a safe target
      // for an automatic cue set. The editor can still bind it explicitly.
      if (matchingAudio.length !== 1) return
      const audio = matchingAudio[0]!
      if ((audio.trimStart ?? 0) !== 0
        || audio.duration !== audioTicksCoveringSeconds(ref.durationSeconds)) return

      const existing = editor.readManagedSubtitleCueSet(ref.dialogueLineId, ref.assetId)
      if (existing && !existing.stale) return
      // A non-automatic cueSetId is an explicit editor/user decision. Even if
      // its source has become stale, surface that state to the editor rather
      // than silently replacing reviewed text or timing during reconcile.
      if (existing && !existing.provenance.cueSetId.startsWith('auto-speech-')) return
      if (hasExplicitManualSubtitle(currentTracks, ref)) return
      const sourceCues = this.automaticSubtitleSourceCues(ref)
      if (!sourceCues) return

      let projected: ReplaceManagedSubtitleCueSetInput
      try {
        projected = projectAutomaticSubtitleCueSet(ref, audio, sourceCues)
      } catch (cause) {
        // Adjacent provider word boundaries can collapse onto the same 24fps
        // frame. Do not invent per-word offsets: replace only with the exact
        // sentence/full-real-audio interval when that projection is valid.
        const fallback = [{
          text: ref.line.text,
          startMs: 0,
          endMs: Math.max(1, Math.round(ref.mediaDurationSeconds! * 1_000)),
        }]
        try {
          projected = projectAutomaticSubtitleCueSet(ref, audio, fallback)
        } catch {
          throw cause
        }
      }
      try {
        editor.replaceManagedSubtitleCueSet(projected)
        changed = true
      } catch (cause) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `OpenCut 无法原子物化台词 ${ref.dialogueLineId} 的托管字幕`,
          { cause },
        )
      }
    })
    if (!changed) return
    const next = editor.getTracks() as unknown as MutableTimelineTracks
    tracks.overlay = next.overlay
    tracks.main = next.main
    tracks.audio = next.audio
  }

  /**
   * A normal editor reconcile preserves hand-authored positions. A one-click
   * production run has a different contract: provider jobs may finish out of
   * order, so previously appended managed dialogue cannot be allowed to keep
   * completion-order positions. Repack only the canonical managed clips in
   * Story order, keep all non-managed audio as collision obstacles, restore
   * each clip to its complete provider duration, and never truncate speech.
   */
  private autoLayoutManagedDialogue(
    tracks: MutableTimelineTracks,
    refs: StoryShotRef[],
    dialogueRefs: StoryDialogueRef[],
    baseRevisionId: string | null,
    sourceRevisionId: string,
  ): TimelineAutomaticEditReceipt | null {
    const before = structuredClone(tracks)
    const planned = structuredClone(tracks)
    this.planManagedDialogueLayout(planned, refs, dialogueRefs)
    const operations = this.timingOperations(before, planned)
    if (operations.length === 0) return null
    const applied = applyOpenCutAtomicEdit({
      tracks: before as unknown as EditorSceneTracks,
      operations,
      frameRate: { numerator: OPEN_CUT_FRAME_RATE, denominator: 1 },
    })
    // The command DTO intentionally exposes optional fields as `undefined`.
    // Persist only the four authoritative timing values back onto the already
    // canonical document so unknown OpenCut extensions remain byte-stable.
    const resultTracks = applied.tracks as unknown as MutableTimelineTracks
    const resultByTrack = new Map(allTracks(resultTracks).map((track) => [track.id, track]))
    const targetByTrack = new Map(allTracks(tracks).map((track) => [track.id, track]))
    const plannedByTrack = new Map(allTracks(planned).map((track) => [track.id, track]))
    operations.forEach((operation) => {
      const result = resultByTrack.get(operation.trackId)?.elements
        .find((element) => element.id === operation.elementId)
      const target = targetByTrack.get(operation.trackId)?.elements
        .find((element) => element.id === operation.elementId)
      const plannedElement = plannedByTrack.get(operation.trackId)?.elements
        .find((element) => element.id === operation.elementId)
      if (!result || !target || !plannedElement) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `OpenCut 原子剪辑结果缺少片段 ${operation.elementId}`,
        )
      }
      target.startTime = result.startTime
      target.duration = result.duration
      target.trimStart = result.trimStart ?? 0
      target.trimEnd = result.trimEnd ?? 0
      // Provenance is not an editable OpenCut timing field. Keep it in the
      // same outer SQLite transaction, derived solely from the already
      // verified managed subtitle operation.
      if (operation.reason === 'synchronize-managed-subtitle') {
        target.manju = structuredClone(plannedElement.manju)
      }
    })
    const planHash = createHash('sha256').update(JSON.stringify({
      version: 1,
      strategy: 'managed-dialogue-reflow-v1',
      baseRevisionId,
      sourceRevisionId,
      operations,
    })).digest('hex')
    operations.forEach((operation) => {
      if (operation.reason !== 'fill-short-managed-video-with-same-shot-image') return
      const target = targetByTrack.get(operation.trackId)?.elements
        .find((element) => element.id === operation.elementId)
      const raw = target?.manju?.shortVideoFill
      if (!target || !isPlainObject(raw)
        || raw.appliedByOpenCut !== false
        || raw.appliedPlanHash !== null) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `短视频片段 ${operation.elementId} 缺少待应用的审计来源`,
        )
      }
      target.manju = {
        ...(target.manju ?? {}),
        shortVideoFill: {
          ...raw,
          appliedByOpenCut: true,
          appliedPlanHash: planHash,
        },
      }
    })
    return {
      version: 1,
      strategy: 'managed-dialogue-reflow-v1',
      executor: 'OpenCut-Classic/UpdateElementsCommand',
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      baseRevisionId,
      sourceRevisionId,
      planHash,
      risk: 'safe',
      policy: 'auto-applied',
      operationCount: operations.length,
      changedElementIds: applied.changedElementIds,
      operations,
    }
  }

  private timingOperations(
    before: MutableTimelineTracks,
    after: MutableTimelineTracks,
  ): OpenCutAtomicTimingOperation[] {
    const afterTracks = new Map(allTracks(after).map((track) => [track.id, track]))
    const operations: OpenCutAtomicTimingOperation[] = []
    allTracks(before).forEach((track) => {
      const nextTrack = afterTracks.get(track.id)
      if (!nextTrack) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `自动剪辑计划意外删除轨道 ${track.id}`,
        )
      }
      const nextElements = new Map(nextTrack.elements.map((element) => [element.id, element]))
      track.elements.forEach((element) => {
        const next = nextElements.get(element.id)
        if (!next) {
          throw new TimelineMaterializationError(
            'INVALID_TIMELINE_STRUCTURE',
            `自动剪辑计划意外删除片段 ${element.id}`,
          )
        }
        const currentTiming = this.elementTiming(element)
        const nextTiming = this.elementTiming(next)
        if (JSON.stringify(currentTiming) === JSON.stringify(nextTiming)) return
        const subtitleCue = isPlainObject(next.manju?.subtitleCue)
        const managedDialogue = track.type === 'audio'
          && typeof next.params?.storyManagedAssetId === 'string'
        const managedVisual = (next.type === 'image' || next.type === 'video')
          && typeof next.params?.storyShotId === 'string'
          && typeof next.params?.storySceneId === 'string'
        const shortVideoFill = isPlainObject(next.manju?.shortVideoFill)
        const reason = subtitleCue
          ? 'synchronize-managed-subtitle'
          : managedDialogue
            ? 'reflow-managed-dialogue-in-story-order'
            : managedVisual && shortVideoFill
              ? 'fill-short-managed-video-with-same-shot-image'
              : managedVisual
              ? 'extend-managed-visual-tail'
              : null
        if (!reason) {
          throw new TimelineMaterializationError(
            'INVALID_TIMELINE_STRUCTURE',
            `自动剪辑计划试图修改非受控片段 ${element.id}`,
          )
        }
        operations.push({
          kind: 'update-element-timing',
          trackId: track.id,
          elementId: element.id,
          reason,
          before: currentTiming,
          after: nextTiming,
        })
      })
      const previousIds = new Set(track.elements.map((element) => element.id))
      const unexpected = nextTrack.elements.find((element) => !previousIds.has(element.id))
      if (unexpected) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `自动剪辑计划意外新增片段 ${unexpected.id}`,
        )
      }
    })
    return operations
  }

  private elementTiming(element: MutableTimelineElement): OpenCutElementTimingSnapshot {
    return {
      startTime: element.startTime,
      duration: element.duration,
      trimStart: element.trimStart ?? 0,
      trimEnd: element.trimEnd ?? 0,
    }
  }

  /**
   * Conform the canonical visual sequence to the per-shot speech envelope.
   * This is deliberately narrower than a general ripple edit: every Story
   * shot must still be represented by one untrimmed element on visual-main,
   * and the current sequence must match the Story layout or an already
   * applied audio-driven layout. Mere contiguity is not authority: a user can
   * deliberately trim every visual clip while keeping the sequence gapless.
   * Those edits must remain untouched.
   */
  private planAudioDrivenVisualLayout(
    tracks: MutableTimelineTracks,
    refs: StoryShotRef[],
  ): boolean {
    if (refs.length === 0) return true
    const managedTrack = this.targetVisualTrack(tracks)
    const associations = new Map<string, Array<{
      track: MutableTimelineTrack
      element: MutableTimelineElement
    }>>()
    visualTracks(tracks).forEach((track) => track.elements.forEach((element) => {
      if (element.hidden === true || (element.type !== 'image' && element.type !== 'video')) return
      const sceneId = typeof element.params?.storySceneId === 'string'
        ? element.params.storySceneId
        : null
      const shotId = typeof element.params?.storyShotId === 'string'
        ? element.params.storyShotId
        : null
      if (!sceneId || !shotId || element.params?.storyOrphaned === true) return
      const key = shotKey(sceneId, shotId)
      associations.set(key, [...(associations.get(key) ?? []), { track, element }])
    }))

    const sequence = refs.map((ref) => {
      const candidates = associations.get(shotKey(ref.sceneId, ref.shotId)) ?? []
      if (candidates.length !== 1 || candidates[0]!.track.id !== managedTrack.id) {
        return null
      }
      const element = candidates[0]!.element
      if ((element.trimStart ?? 0) !== 0 || (element.trimEnd ?? 0) !== 0) {
        return null
      }
      return { ref, element }
    })
    if (sequence.some((item) => item === null)) return false
    const safeSequence = sequence as Array<{
      ref: StoryShotRef
      element: MutableTimelineElement
    }>

    let storyCursor = 0
    let targetCursor = 0
    let matchesStoryLayout = true
    let matchesAudioLayout = true
    safeSequence.forEach(({ ref, element }) => {
      const storyDuration = ticksForSeconds(ref.shot.durationSeconds)
      const targetDuration = ticksForSeconds(ref.timelineDurationSeconds)
      const sourceDuration = element.type === 'video'
        && typeof element.sourceDuration === 'number'
        ? element.sourceDuration
        : null
      const storyDurations = new Set([storyDuration, ...(sourceDuration ? [sourceDuration] : [])])
      const targetDurations = new Set([targetDuration, ...(sourceDuration ? [sourceDuration] : [])])
      matchesStoryLayout &&= element.startTime === storyCursor
        && storyDurations.has(element.duration)
      matchesAudioLayout &&= element.startTime === targetCursor
        && targetDurations.has(element.duration)
      storyCursor += storyDuration
      targetCursor += targetDuration
    })
    if (!matchesStoryLayout && !matchesAudioLayout) {
      return false
    }

    targetCursor = 0
    safeSequence.forEach(({ ref, element }) => {
      const targetDuration = ticksForSeconds(ref.timelineDurationSeconds)
      const rawFill = element.manju?.shortVideoFill
      const pendingSameShotFill = element.type === 'video'
        && typeof element.sourceDuration === 'number'
        && element.sourceDuration < targetDuration
        && isPlainObject(rawFill)
        && rawFill.appliedByOpenCut !== true
        && rawFill.sourceDurationTicks === element.sourceDuration
        && rawFill.targetDurationTicks === targetDuration
        && rawFill.storySceneId === ref.sceneId
        && rawFill.storyShotId === ref.shotId
      element.startTime = targetCursor
      element.duration = pendingSameShotFill ? element.sourceDuration! : targetDuration
      element.trimStart = 0
      element.trimEnd = 0
      targetCursor += targetDuration
    })
    return true
  }

  private planManagedDialogueLayout(
    tracks: MutableTimelineTracks,
    refs: StoryShotRef[],
    dialogueRefs: StoryDialogueRef[],
  ): void {
    if (!this.planAudioDrivenVisualLayout(tracks, refs)) return
    this.planShortVideoFills(tracks, refs)
    const track = tracks.audio.find((candidate) => candidate.id === 'dialogue-main')
    if (!track) return
    const spans = visualShotSpans(tracks)
    const byKey = new Map<string, MutableTimelineElement[]>()
    track.elements.forEach((element) => {
      const params = element.params
      const sceneId = typeof params?.storySceneId === 'string' ? params.storySceneId : null
      const shotId = typeof params?.storyShotId === 'string' ? params.storyShotId : null
      const lineId = typeof params?.dialogueLineId === 'string' ? params.dialogueLineId : null
      if (!sceneId || !shotId || !lineId || typeof params?.storyManagedAssetId !== 'string') return
      const key = dialogueKey(sceneId, shotId, lineId)
      byKey.set(key, [...(byKey.get(key) ?? []), element])
    })

    const placements: Array<{
      ref: StoryDialogueRef & { assetId: string; durationSeconds: number }
      element: MutableTimelineElement
    }> = []
    dialogueRefs.forEach((ref) => {
      if (!dialogueAssetReady(ref)) return
      const key = dialogueKey(ref.sceneId, ref.shotId, ref.dialogueLineId)
      const candidates = (byKey.get(key) ?? []).filter((element) => (
        element.mediaId === ref.assetId
        && element.params?.storyManagedAssetId === ref.assetId
      ))
      // An editor-deleted managed line remains intentionally absent. Split or
      // duplicate managed lines are ambiguous and must not be flattened.
      if (candidates.length === 0) return
      if (candidates.length !== 1) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `台词 ${ref.dialogueLineId} 存在多个受控音频片段，无法安全自动排版`,
        )
      }
      placements.push({ ref, element: candidates[0] })
    })
    if (placements.length === 0) return

    const managed = new Set(placements.map(({ element }) => element))
    const layoutTrack: MutableTimelineTrack = {
      ...track,
      elements: track.elements.filter((element) => !managed.has(element)),
    }
    const shotCursors = new Map<string, number>()
    placements.forEach(({ ref, element }) => {
      const associationKey = shotKey(ref.sceneId, ref.shotId)
      const span = spans.get(associationKey)
      if (!span) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `台词 ${ref.dialogueLineId} 所属镜头不在视觉时间线中`,
        )
      }
      // Use the same outward 24fps quantization as materialization and export.
      // The final frame may contain silence, but the paid Asset is never cut.
      const duration = audioTicksCoveringSeconds(ref.durationSeconds)
      const desiredStart = shotCursors.get(associationKey) ?? span.startTime
      const startTime = availableAudioStart(layoutTrack, desiredStart, duration)
      if (startTime + duration > span.endTime) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `台词 ${ref.dialogueLineId} 无法完整放入所属镜头；请先清理该镜的手工音频占位`,
        )
      }
      element.startTime = startTime
      element.duration = duration
      element.trimStart = 0
      element.trimEnd = 0
      shotCursors.set(associationKey, startTime + duration)
      layoutTrack.elements.push(element)
      this.synchronizeManagedSubtitleCues(tracks, element)
    })
  }

  /**
   * Restore only a server-authored Story edit point. The visible duration is
   * changed through the pinned OpenCut timing command later; RenderSemanticPlan
   * interprets the excess interval as a same-shot locked image hold.
   */
  private planShortVideoFills(
    tracks: MutableTimelineTracks,
    refs: StoryShotRef[],
  ): void {
    const refsByKey = new Map(refs.map((ref) => [shotKey(ref.sceneId, ref.shotId), ref]))
    visualTracks(tracks).forEach((track) => {
      if (track.hidden === true) return
      track.elements.forEach((element) => {
        if (element.hidden === true || element.type !== 'video') return
        let fill
        try {
          fill = shortVideoFillDescriptor(
            element as unknown as CanonicalTimelineElement,
            `timeline element ${element.id}`,
          )
        } catch (cause) {
          if (!(cause instanceof RenderSemanticPlanError)) throw cause
          throw new TimelineMaterializationError(
            'INVALID_TIMELINE_STRUCTURE',
            `短视频片段 ${element.id} 的显式填充来源无效`,
            { cause },
          )
        }
        if (!fill) return
        const ref = refsByKey.get(shotKey(fill.storySceneId, fill.storyShotId))
        if (!ref
          || ref.assetType !== 'video'
          || ref.assetId !== element.mediaId
          || ref.shortVideoFillAssetId !== fill.fallbackAssetId
          || ref.sourceDurationSeconds === null
          || ticksForSeconds(ref.sourceDurationSeconds) !== fill.sourceDurationTicks
          || ticksForSeconds(ref.timelineDurationSeconds) !== fill.targetDurationTicks) {
          throw new TimelineMaterializationError(
            'INVALID_TIMELINE_STRUCTURE',
            `短视频片段 ${element.id} 的填充来源已与当前 Story/资产锁不一致`,
          )
        }
        if (element.sourceDuration !== fill.sourceDurationTicks
          || (element.trimStart ?? 0) !== 0
          || (element.trimEnd ?? 0) !== 0) {
          throw new TimelineMaterializationError(
            'INVALID_TIMELINE_STRUCTURE',
            `短视频片段 ${element.id} 已被手工裁切，不能自动应用同镜静帧填充`,
          )
        }
        if (element.duration === fill.targetDurationTicks) return
        if (fill.appliedByOpenCut) {
          throw new TimelineMaterializationError(
            'INVALID_TIMELINE_STRUCTURE',
            `短视频片段 ${element.id} 在已审计填充后又被手工改变，不会自动覆盖`,
          )
        }
        if (element.duration !== fill.sourceDurationTicks) {
          throw new TimelineMaterializationError(
            'INVALID_TIMELINE_STRUCTURE',
            `短视频片段 ${element.id} 已偏离固化的源时长与目标剪辑点`,
          )
        }
        const targetEnd = element.startTime + fill.targetDurationTicks
        const overlaps = track.elements.some((candidate) => (
          candidate !== element
          && candidate.hidden !== true
          && (candidate.type === 'image' || candidate.type === 'video')
          && candidate.startTime < targetEnd
          && candidate.startTime + candidate.duration > element.startTime
        ))
        if (overlaps) {
          throw new TimelineMaterializationError(
            'INVALID_TIMELINE_STRUCTURE',
            `短视频片段 ${element.id} 的目标剪辑点与其他画面重叠，安全策略不会覆盖`,
          )
        }
        element.duration = fill.targetDurationTicks
      })
    })
  }

  private synchronizeManagedSubtitleCues(
    tracks: MutableTimelineTracks,
    audio: MutableTimelineElement,
  ): void {
    allTracks(tracks).forEach((track) => track.elements.forEach((element) => {
      if (element === audio) return
      const raw = element.manju?.subtitleCue
      const referencesAudio = (isPlainObject(raw) && raw.sourceAudioElementId === audio.id)
        || element.params?.sourceAudioElementId === audio.id
      if (!referencesAudio) return
      if (track.type !== 'text' || element.type !== 'text') return
      if (!isPlainObject(raw)
        || raw.version !== 1
        || raw.sourceAudioElementId !== audio.id
        || raw.speechAssetId !== audio.mediaId
        || !Number.isSafeInteger(raw.sourceStartMs)
        || !Number.isSafeInteger(raw.sourceEndMs)
        || (raw.sourceStartMs as number) < 0
        || (raw.sourceEndMs as number) <= (raw.sourceStartMs as number)) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `托管字幕 ${element.id} 的音频来源信息无效，无法安全同步自动排版`,
        )
      }
      const sourceStartMs = raw.sourceStartMs as number
      const sourceEndMs = raw.sourceEndMs as number
      const visibleDurationMs = (audio.duration * 1_000) / OPEN_CUT_TICKS_PER_SECOND
      if (sourceStartMs >= visibleDurationMs) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `托管字幕 ${element.id} 超出当前语音真实时长，请重新应用字幕后生产`,
        )
      }
      const durationFrames = audio.duration / TICKS_PER_FRAME
      const startFrame = Math.max(
        0,
        Math.min(durationFrames, Math.round((sourceStartMs * OPEN_CUT_FRAME_RATE) / 1_000)),
      )
      let endFrame = Math.max(
        0,
        Math.min(
          durationFrames,
          Math.round((Math.min(sourceEndMs, visibleDurationMs) * OPEN_CUT_FRAME_RATE) / 1_000),
        ),
      )
      if (endFrame <= startFrame && startFrame < durationFrames) endFrame = startFrame + 1
      if (endFrame <= startFrame) {
        throw new TimelineMaterializationError(
          'INVALID_TIMELINE_STRUCTURE',
          `托管字幕 ${element.id} 在 24fps 自动排版后为空`,
        )
      }
      element.startTime = audio.startTime + startFrame * TICKS_PER_FRAME
      element.duration = (endFrame - startFrame) * TICKS_PER_FRAME
      element.manju = {
        ...(element.manju ?? {}),
        subtitleCue: {
          ...raw,
          sourceAudioStartTime: audio.startTime,
          sourceAudioTrimStart: audio.trimStart ?? 0,
          sourceAudioDuration: audio.duration,
        },
      }
    }))
  }

  private reconcileDialogueAudio(input: {
    tracks: MutableTimelineTracks
    dialogueRefs: StoryDialogueRef[]
    sourceRevisionId: string
    report: TimelineReconciliationReport
    baseline: Map<string, TimelineDialogueManifestItem>
    usedElementIds?: Set<string>
  }): Map<string, TimelineDialogueManifestItem> {
    const {
      tracks,
      dialogueRefs,
      sourceRevisionId,
      report,
      baseline,
    } = input
    const nextManifest = new Map(baseline)
    const refsByKey = new Map<string, StoryDialogueRef>()
    const refsByLineId = new Map<string, StoryDialogueRef[]>()
    dialogueRefs.forEach((ref) => {
      refsByKey.set(dialogueKey(ref.sceneId, ref.shotId, ref.dialogueLineId), ref)
      refsByLineId.set(ref.dialogueLineId, [
        ...(refsByLineId.get(ref.dialogueLineId) ?? []),
        ref,
      ])
      if (ref.blockingIssue) addSpeechConflict(report, ref, ref.blockingIssue, true)
      if (ref.durationMismatch) {
        addSpeechConflict(report, ref, 'SPEECH_DURATION_MISMATCH', false)
      }
    })

    const existingByKey = new Map<string, MutableTimelineElement[]>()
    tracks.audio.forEach((track) => track.elements.forEach((element) => {
      const params = element.params
      const dialogueLineId = typeof params?.dialogueLineId === 'string' && params.dialogueLineId
        ? params.dialogueLineId
        : null
      if (!dialogueLineId) return
      const storySceneId = typeof params?.storySceneId === 'string' && params.storySceneId
        ? params.storySceneId
        : null
      const storyShotId = typeof params?.storyShotId === 'string' && params.storyShotId
        ? params.storyShotId
        : null
      const candidates = refsByLineId.get(dialogueLineId) ?? []
      const exact = storySceneId && storyShotId
        ? refsByKey.get(dialogueKey(storySceneId, storyShotId, dialogueLineId))
        : undefined
      const ref = exact ?? (!storySceneId && !storyShotId && candidates.length === 1
        ? candidates[0]
        : undefined)
      if (!ref && candidates.length > 1 && (!storySceneId || !storyShotId)) {
        throw new TimelineMaterializationError(
          'AMBIGUOUS_STORY_DIALOGUE_LINE_ID',
          `台词 ID ${dialogueLineId} 在多个镜头中重复，元素 ${element.id} 缺少场景与镜头关联`,
        )
      }

      if (!ref) {
        const deletedKey = storySceneId && storyShotId
          ? dialogueKey(storySceneId, storyShotId, dialogueLineId)
          : null
        const previousManagedAsset = typeof params?.storyManagedAssetId === 'string'
          ? params.storyManagedAssetId
          : typeof element.mediaId === 'string' && !isUnresolvedMediaBinding(element)
            ? element.mediaId
            : deletedKey
              ? baseline.get(deletedKey)?.managedAssetId ?? null
              : null
        const nextParams: JsonObject = {
          ...params,
          dialogueOrphaned: true,
          dialogueOrphanReason: 'dialogue-line-deleted',
          orphanedAtSourceRevisionId: sourceRevisionId,
        }
        if (previousManagedAsset && element.mediaId === previousManagedAsset) {
          markMediaUnresolved(element)
        }
        delete nextParams.storyManagedAssetId
        element.params = nextParams
        report.orphanedAudioElements.push({
          sceneId: storySceneId,
          shotId: storyShotId,
          dialogueLineId,
          elementId: element.id,
          reason: 'dialogue-line-deleted',
        })
        if (storySceneId && storyShotId && deletedKey) {
          nextManifest.set(deletedKey, {
            sceneId: storySceneId,
            shotId: storyShotId,
            dialogueLineId,
            managedAssetId: previousManagedAsset,
          })
        }
        return
      }

      const key = dialogueKey(ref.sceneId, ref.shotId, ref.dialogueLineId)
      existingByKey.set(key, [...(existingByKey.get(key) ?? []), element])
      if (!dialogueAssetReady(ref)) {
        const reason = ref.assetId === null
          ? 'speech-asset-missing' as const
          : 'speech-asset-invalid' as const
        const nextParams: JsonObject = {
          ...params,
          dialogueLineId: ref.dialogueLineId,
          storyShotId: ref.shotId,
          storySceneId: ref.sceneId,
          dialogueOrphaned: true,
          dialogueOrphanReason: reason,
          orphanedAtSourceRevisionId: sourceRevisionId,
        }
        const previousManagedAsset = typeof params?.storyManagedAssetId === 'string'
          ? params.storyManagedAssetId
          : baseline.get(key)?.managedAssetId ?? null
        if (previousManagedAsset && element.mediaId === previousManagedAsset) {
          markMediaUnresolved(element)
        }
        delete nextParams.storyManagedAssetId
        element.params = nextParams
        report.orphanedAudioElements.push({
          ...publicDialogueReference(ref),
          elementId: element.id,
          reason,
        })
        nextManifest.set(key, {
          ...publicDialogueReference(ref),
          managedAssetId: previousManagedAsset,
        })
        return
      }

      const nextParams: JsonObject = {
        ...params,
        dialogueLineId: ref.dialogueLineId,
        storyShotId: ref.shotId,
        storySceneId: ref.sceneId,
        sourceRevisionId,
      }
      const previousManagedAsset = typeof nextParams.storyManagedAssetId === 'string'
        ? nextParams.storyManagedAssetId
        : baseline.get(key)?.managedAssetId ?? null
      if (isUnresolvedMediaBinding(element) || element.mediaId === previousManagedAsset) {
        bindMedia(element, ref.assetId)
      }
      nextParams.storyManagedAssetId = ref.assetId
      delete nextParams.dialogueOrphaned
      delete nextParams.dialogueOrphanReason
      delete nextParams.orphanedAtSourceRevisionId
      element.params = nextParams

      // Legacy materialization and earlier automatic edits could stretch a
      // managed dialogue element to the Shot duration even though OpenCut has
      // no audio-retime semantic. Such a clip is intrinsically unrenderable:
      // trimStart + duration exceeds the immutable, probed Asset duration.
      // Repair only the server-managed binding and only by shrinking its
      // impossible tail. Valid user trims and shorter edits remain untouched.
      if (element.mediaId === ref.assetId && ref.durationSeconds !== null) {
        const sourceDuration = audioTicksCoveringSeconds(ref.durationSeconds)
        const trimStart = element.trimStart ?? 0
        if (Number.isSafeInteger(trimStart)
          && trimStart >= 0
          && trimStart % TICKS_PER_FRAME === 0
          && trimStart < sourceDuration
          && trimStart + element.duration > sourceDuration) {
          element.duration = sourceDuration - trimStart
          element.trimEnd = 0
          element.sourceDuration = sourceDuration
          this.synchronizeManagedSubtitleCues(tracks, element)
        }
      }
      report.preservedAudioElementIds.push(element.id)
      nextManifest.set(key, {
        ...publicDialogueReference(ref),
        managedAssetId: ref.assetId,
      })
    }))

    const shotSpans = visualShotSpans(tracks)
    const shotCursors = new Map<string, number>()
    const usedElementIds = input.usedElementIds ?? new Set(allTracks(tracks).flatMap((track) => (
      track.elements.map((element) => element.id)
    )))
    let dialogueTrack = tracks.audio.find((track) => track.id === 'dialogue-main')
    const ensureDialogueTrack = (): MutableTimelineTrack => {
      if (dialogueTrack) return dialogueTrack
      const usedTrackIds = new Set(allTracks(tracks).map((track) => track.id))
      dialogueTrack = {
        id: uniqueId('dialogue-main', usedTrackIds),
        name: 'Dialogue',
        type: 'audio',
        muted: false,
        elements: [],
      }
      tracks.audio.push(dialogueTrack)
      return dialogueTrack
    }

    dialogueRefs.forEach((ref) => {
      const key = dialogueKey(ref.sceneId, ref.shotId, ref.dialogueLineId)
      const shotAssociationKey = shotKey(ref.sceneId, ref.shotId)
      const span = shotSpans.get(shotAssociationKey)
      const existingElements = existingByKey.get(key) ?? []
      if (existingElements.length > 0) {
        if (span) {
          const existingEnd = existingElements.reduce((maximum, element) => (
            Math.max(maximum, element.startTime + element.duration)
          ), span.startTime)
          shotCursors.set(
            shotAssociationKey,
            Math.max(shotCursors.get(shotAssociationKey) ?? span.startTime, existingEnd),
          )
        }
        return
      }

      const previous = baseline.get(key)
      if (!dialogueAssetReady(ref)) {
        if (!nextManifest.has(key)) {
          nextManifest.set(key, {
            ...publicDialogueReference(ref),
            managedAssetId: previous?.managedAssetId ?? null,
          })
        }
        return
      }
      if (previous?.managedAssetId === ref.assetId) {
        report.preservedAbsentDialogueLines.push(publicDialogueReference(ref))
        nextManifest.set(key, {
          ...publicDialogueReference(ref),
          managedAssetId: ref.assetId,
        })
        return
      }
      if (!span) {
        addSpeechConflict(report, ref, 'SHOT_NOT_ON_TIMELINE', true)
        return
      }

      const track = ensureDialogueTrack()
      const desiredStart = shotCursors.get(shotAssociationKey) ?? span.startTime
      const duration = audioTicksCoveringSeconds(ref.durationSeconds)
      const startTime = availableAudioStart(track, desiredStart, duration)
      if (startTime !== desiredStart) {
        addSpeechConflict(report, ref, 'SPEECH_SHIFTED_FOR_TRACK_COLLISION', false)
      }
      const element = createDialogueElement(ref, startTime, usedElementIds, sourceRevisionId)
      track.elements.push(element)
      existingByKey.set(key, [element])
      shotCursors.set(shotAssociationKey, startTime + element.duration)
      report.appendedDialogueAudio.push({
        ...publicDialogueReference(ref),
        elementId: element.id,
        assetId: ref.assetId,
        startTime,
        duration: element.duration,
      })
      if (startTime + element.duration > span.endTime) {
        addSpeechConflict(report, ref, 'SPEECH_OVERFLOWS_SHOT', false)
      }
      nextManifest.set(key, {
        ...publicDialogueReference(ref),
        managedAssetId: ref.assetId,
      })
    })
    return nextManifest
  }

  private currentStory(
    projectId: string,
    episodeId: string,
  ): {
      sourceRevisionId: string
      refs: StoryShotRef[]
      dialogueRefs: StoryDialogueRef[]
    } {
    const episode = this.stories.getEpisode(episodeId)
    if (!episode) {
      throw new TimelineDocumentError('EPISODE_NOT_FOUND', `Episode not found: ${episodeId}`)
    }
    if (episode.projectId !== projectId) {
      throw new TimelineDocumentError(
        'EPISODE_PROJECT_MISMATCH',
        `Episode ${episodeId} does not belong to project ${projectId}`,
      )
    }
    const story = this.stories.getStory(episodeId)
    if (!story) {
      throw new TimelineMaterializationError(
        'STORY_NOT_FOUND',
        `Episode ${episodeId} does not have a structured story`,
      )
    }
    if (!episode.sourceRevisionId) {
      throw new TimelineMaterializationError(
        'STORY_SOURCE_REVISION_NOT_FOUND',
        `Episode ${episodeId} does not have a source story revision`,
      )
    }
    const refs = storyShotRefs(story)
    const dialogueRefs = storyDialogueRefs(story)
    this.applyAudioDrivenShotDurations(
      episodeId,
      projectId,
      episode.sourceRevisionId,
      refs,
    )
    this.applyAssets(episodeId, projectId, episode.sourceRevisionId, refs)
    this.applyDialogueAssets(episodeId, projectId, episode.sourceRevisionId, dialogueRefs)
    return { sourceRevisionId: episode.sourceRevisionId, refs, dialogueRefs }
  }

  /**
   * Reuse the same immutable duration decision that guards Seedance billing.
   * A complete set of ready speech Assets becomes the timing authority; an
   * incomplete set leaves the Story duration untouched until speech finishes.
   */
  private applyAudioDrivenShotDurations(
    episodeId: string,
    projectId: string,
    sourceRevisionId: string,
    refs: StoryShotRef[],
  ): void {
    const rows = this.database.withSql((sql) => sql.all(`
      SELECT
        shots.id AS database_shot_id,
        scenes.metadata_json AS scene_metadata_json,
        shots.metadata_json AS shot_metadata_json
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
      JOIN episodes ON episodes.id = scenes.episode_id
      WHERE scenes.episode_id = ?
        AND episodes.project_id = ?
        AND episodes.source_revision_id = ?
    `, episodeId, projectId, sourceRevisionId))
    const refsByKey = new Map(refs.map((ref) => [shotKey(ref.sceneId, ref.shotId), ref]))
    rows.forEach((row) => {
      const sceneId = parseAssetMetadata(row.scene_metadata_json)
      const shotId = parseAssetMetadata(row.shot_metadata_json)
      const databaseShotId = typeof row.database_shot_id === 'string'
        ? row.database_shot_id
        : null
      if (!sceneId || !shotId || !databaseShotId) return
      const ref = refsByKey.get(shotKey(sceneId, shotId))
      if (!ref) return
      const resolution = resolveShotVideoDuration(this.database, {
        databaseShotId,
        publicShotId: ref.shotId,
        projectId,
        episodeId,
        sourceRevisionId,
        durationSeconds: ref.shot.durationSeconds,
      })
      if (resolution.status === 'ready') {
        ref.timelineDurationSeconds = resolution.decision.timelineDurationSeconds
        ref.durationDecision = resolution.decision
        return
      }
      // Seedance itself must split at 15 seconds, but a still-image timeline
      // can remain semantically correct and keep the full measured speech
      // envelope visible while the UI asks the user to split the shot.
      if (resolution.status === 'requires_shot_split') {
        ref.timelineDurationSeconds = resolution.speechDurationSeconds
      }
    })
  }

  private applyAssets(
    episodeId: string,
    projectId: string,
    sourceRevisionId: string,
    refs: StoryShotRef[],
  ): void {
    const assets = this.database.withSql((sql) => sql.all(`
      SELECT
        shots.id AS database_shot_id,
        scenes.metadata_json AS scene_metadata_json,
        shots.metadata_json AS shot_metadata_json,
        shots.storyboard_asset_id,
        shots.video_asset_id,
        storyboard.project_id AS storyboard_project_id,
        storyboard.episode_id AS storyboard_episode_id,
        storyboard.status AS storyboard_status,
        storyboard.mime_type AS storyboard_mime_type,
        storyboard.file_path AS storyboard_file_path,
        storyboard.checksum AS storyboard_checksum,
        storyboard.source_revision_id AS storyboard_source_revision_id,
        video.project_id AS video_project_id,
        video.status AS video_status,
        video.mime_type AS video_mime_type,
        video.duration_seconds AS video_duration_seconds,
        json_extract(video.generation_parameters_json, '$.audioPolicy') AS video_audio_policy,
        json_extract(video.generation_parameters_json, '$.generateAudio') AS video_generate_audio
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
      LEFT JOIN media_assets AS storyboard ON storyboard.id = shots.storyboard_asset_id
      LEFT JOIN media_assets AS video ON video.id = shots.video_asset_id
      WHERE scenes.episode_id = ?
    `, episodeId))
    const refsByKey = new Map(refs.map((ref) => [shotKey(ref.sceneId, ref.shotId), ref]))
    assets.forEach((row) => {
      const sceneId = parseAssetMetadata(row.scene_metadata_json)
      const shotId = parseAssetMetadata(row.shot_metadata_json)
      if (!sceneId || !shotId) return
      const ref = refsByKey.get(shotKey(sceneId, shotId))
      if (!ref) return
      const videoReady = typeof row.video_asset_id === 'string'
        && row.video_project_id === projectId
        && row.video_status === 'ready'
        && (row.video_mime_type === 'video/mp4' || row.video_mime_type === 'video/webm')
        && typeof row.video_duration_seconds === 'number'
        && Number.isFinite(row.video_duration_seconds)
        && row.video_duration_seconds > 0
        && row.video_duration_seconds <= 86_400
      if (videoReady && typeof row.database_shot_id === 'string') {
        const videoAsset = this.database.getMediaAsset(row.video_asset_id as string)
        const durationDecision = videoAsset?.generationParameters.durationDecision
        if (isShotVideoDurationDecision(durationDecision)
          && shotVideoDurationDecisionIsCurrent(this.database, {
            databaseShotId: row.database_shot_id,
            publicShotId: ref.shotId,
            projectId,
            episodeId,
            sourceRevisionId,
            durationSeconds: ref.shot.durationSeconds,
          }, durationDecision)) {
          ref.timelineDurationSeconds = durationDecision.timelineDurationSeconds
          ref.durationDecision = durationDecision
        }
      }
      const sourceFrames = videoReady
        ? framesForSeconds(row.video_duration_seconds as number)
        : 0
      const targetFrames = framesForSeconds(ref.timelineDurationSeconds)
      const shortVideo = videoReady && sourceFrames < targetFrames
      const safeSameShotFill = shortVideo
        && typeof row.storyboard_asset_id === 'string'
        && row.storyboard_project_id === projectId
        && (row.storyboard_episode_id === episodeId || row.storyboard_episode_id === null)
        && row.storyboard_status === 'ready'
        && typeof row.storyboard_mime_type === 'string'
        && row.storyboard_mime_type.startsWith('image/')
        && typeof row.storyboard_file_path === 'string'
        && row.storyboard_file_path.length > 0
        && typeof row.storyboard_checksum === 'string'
        && /^[0-9a-f]{64}$/i.test(row.storyboard_checksum)
        && row.storyboard_source_revision_id === sourceRevisionId
      if (videoReady && (!shortVideo || safeSameShotFill)) {
        ref.assetId = row.video_asset_id as string
        ref.assetType = 'video'
        ref.sourceDurationSeconds = row.video_duration_seconds as number
        ref.sourceAudioEnabled = row.video_audio_policy === 'sfx_only'
          || row.video_audio_policy === 'provider_audio'
          || (row.video_audio_policy === null && row.video_generate_audio === 1)
        ref.sourceAudioRole = row.video_audio_policy === 'sfx_only' ? 'sfx' : null
        ref.shortVideoFillAssetId = safeSameShotFill ? row.storyboard_asset_id as string : null
      } else if (typeof row.storyboard_asset_id === 'string'
        && row.storyboard_project_id === projectId
        && row.storyboard_status === 'ready') {
        ref.assetId = row.storyboard_asset_id
        ref.assetType = 'image'
        ref.sourceDurationSeconds = null
        ref.sourceAudioEnabled = false
        ref.sourceAudioRole = null
        ref.shortVideoFillAssetId = null
      }
    })
  }

  private applyDialogueAssets(
    episodeId: string,
    projectId: string,
    sourceRevisionId: string,
    refs: StoryDialogueRef[],
  ): void {
    const rows = this.database.withSql((sql) => sql.all(`
      SELECT
        scenes.metadata_json AS scene_metadata_json,
        shots.metadata_json AS shot_metadata_json,
        dialogue_lines.metadata_json AS line_metadata_json,
        dialogue_lines.speech_asset_id,
        dialogue_lines.duration_seconds AS line_duration_seconds,
        speech.id AS media_asset_id,
        speech.project_id AS media_project_id,
        speech.episode_id AS media_episode_id,
        speech.version AS media_version,
        speech.status AS media_status,
        speech.mime_type AS media_mime_type,
        speech.duration_seconds AS media_duration_seconds,
        speech.checksum AS media_checksum,
        speech.source_revision_id AS media_source_revision_id
      FROM dialogue_lines
      JOIN shots ON shots.id = dialogue_lines.shot_id
      JOIN scenes ON scenes.id = shots.scene_id
      LEFT JOIN media_assets AS speech ON speech.id = dialogue_lines.speech_asset_id
      WHERE scenes.episode_id = ?
      ORDER BY scenes.sequence, shots.sequence, dialogue_lines.sequence
    `, episodeId))
    const refsByKey = new Map(refs.map((ref) => [
      dialogueKey(ref.sceneId, ref.shotId, ref.dialogueLineId),
      ref,
    ]))
    rows.forEach((row) => {
      const sceneId = parseAssetMetadata(row.scene_metadata_json)
      const shotId = parseAssetMetadata(row.shot_metadata_json)
      const dialogueLineId = parseAssetMetadata(row.line_metadata_json)
      if (!sceneId || !shotId || !dialogueLineId) return
      const ref = refsByKey.get(dialogueKey(sceneId, shotId, dialogueLineId))
      if (!ref) return
      ref.lineDurationSeconds = typeof row.line_duration_seconds === 'number'
        ? row.line_duration_seconds
        : null
      if (typeof row.speech_asset_id !== 'string') return
      ref.assetId = row.speech_asset_id
      const bindingIssue = speechAssetBindingBlockReason({
        referencedAssetId: row.speech_asset_id,
        assetId: row.media_asset_id,
        projectId: row.media_project_id,
        episodeId: row.media_episode_id,
        version: row.media_version,
        status: row.media_status,
        mimeType: row.media_mime_type,
        durationSeconds: row.media_duration_seconds,
        checksum: row.media_checksum,
        sourceRevisionId: row.media_source_revision_id,
      }, { projectId, episodeId, sourceRevisionId })
      if (bindingIssue) {
        ref.blockingIssue = timelineSpeechBindingConflict(
          bindingIssue,
          row.media_project_id,
          projectId,
        )
        return
      }
      ref.mimeType = typeof row.media_mime_type === 'string' ? row.media_mime_type : null
      ref.mediaDurationSeconds = typeof row.media_duration_seconds === 'number'
        ? row.media_duration_seconds
        : null
      const mediaDuration = ref.mediaDurationSeconds !== null && ref.mediaDurationSeconds > 0
        ? ref.mediaDurationSeconds
        : null
      const lineDuration = ref.lineDurationSeconds !== null && ref.lineDurationSeconds > 0
        ? ref.lineDurationSeconds
        : null
      ref.durationSeconds = mediaDuration ?? lineDuration
      if (ref.durationSeconds === null) {
        ref.blockingIssue = 'SPEECH_DURATION_MISSING'
        return
      }
      if (ref.durationSeconds > MAX_DIALOGUE_AUDIO_SECONDS) {
        ref.blockingIssue = 'SPEECH_DURATION_TOO_LONG'
        return
      }
      ref.durationMismatch = mediaDuration !== null
        && lineDuration !== null
        && Math.abs(mediaDuration - lineDuration) > 1 / OPEN_CUT_FRAME_RATE
    })
  }

  private targetVisualTrack(tracks: MutableTimelineTracks): MutableTimelineTrack {
    const preferred = tracks.overlay.find((track) => (
      track.id === 'visual-main' && track.type === 'video'
    )) ?? tracks.overlay.find((track) => track.type === 'video')
    return preferred ?? tracks.main
  }
}
