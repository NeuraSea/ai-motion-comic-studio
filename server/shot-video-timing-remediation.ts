import type { GenerationJobRecord, ManjuDatabase } from './database.js'
import {
  isShotVideoDurationDecision,
  resolveShotVideoDuration,
  type ShotVideoDurationDecision,
  type ShotVideoDurationResolution,
  type ShotVideoDurationTarget,
  type ShotVideoSpeechDurationBinding,
} from './shot-video-duration.js'

const SHOT_VIDEO_GENERATION_JOB_TYPE = 'shot.video.generate'
const STALE_AUDIO_TIMING = 'STALE_AUDIO_TIMING'

export const SHOT_VIDEO_TIMING_REMEDIATION_VERSION = 1 as const

export type ShotVideoTimingCheckpoint = 'initial' | 'pre-submit' | 'pre-publish'
export type ShotVideoProviderSubmissionState = 'not-started' | 'task-exists'
export type ShotVideoTimingRecommendedAction =
  | 'repreflight-paid-video'
  | 'regenerate-speech-or-repreflight'
export type ShotVideoTimingLineChange =
  | 'added'
  | 'removed'
  | 'asset_changed'
  | 'duration_changed'

export interface ShotVideoTimingBindingIdentity {
  assetId: string
  version: number
  checksum: string
  durationSeconds: number
  durationFrames: number
}

export interface ShotVideoTimingAffectedLine {
  dialogueLineId: string
  change: ShotVideoTimingLineChange
  previous: ShotVideoTimingBindingIdentity | null
  current: ShotVideoTimingBindingIdentity | null
}

/**
 * Strict, credential-free evidence explaining why a paid video timing contract
 * was rejected. This exact shape is safe to expose from the job API.
 */
export interface ShotVideoTimingRemediation {
  version: typeof SHOT_VIDEO_TIMING_REMEDIATION_VERSION
  kind: 'stale_audio_timing'
  projectId: string
  episodeId: string
  shotId: string
  sceneId: string
  sourceRevisionId: string
  checkpoint: ShotVideoTimingCheckpoint
  providerSubmissionState: ShotVideoProviderSubmissionState
  detectedAt: string
  previousDecision: ShotVideoDurationDecision
  currentResolution: ShotVideoDurationResolution
  affectedLines: ShotVideoTimingAffectedLine[]
  recommendedAction: ShotVideoTimingRecommendedAction
}

interface CreateShotVideoTimingRemediationInput {
  target: ShotVideoDurationTarget
  sceneId: string
  previousDecision: ShotVideoDurationDecision
  checkpoint: ShotVideoTimingCheckpoint
  providerSubmissionState: ShotVideoProviderSubmissionState
  detectedAt: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).length === allowed.size
    && Object.keys(value).every((key) => allowed.has(key))
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function safeDetectedAt(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function isBindingIdentity(value: unknown): value is ShotVideoTimingBindingIdentity {
  if (!isPlainObject(value)
    || !exactKeys(value, ['assetId', 'version', 'checksum', 'durationSeconds', 'durationFrames'])) return false
  return safeIdentifier(value.assetId)
    && Number.isInteger(value.version)
    && (value.version as number) >= 1
    && typeof value.checksum === 'string'
    && /^[a-f0-9]{64}$/.test(value.checksum)
    && typeof value.durationSeconds === 'number'
    && Number.isFinite(value.durationSeconds)
    && value.durationSeconds > 0
    && value.durationSeconds <= 3_600
    && Number.isInteger(value.durationFrames)
    && (value.durationFrames as number) >= 1
    && value.durationFrames === Math.max(1, Math.ceil(value.durationSeconds * 24))
}

function bindingIdentity(binding: ShotVideoSpeechDurationBinding): ShotVideoTimingBindingIdentity {
  return {
    assetId: binding.assetId,
    version: binding.version,
    checksum: binding.checksum,
    durationSeconds: binding.durationSeconds,
    durationFrames: binding.durationFrames,
  }
}

function resolutionBindings(resolution: ShotVideoDurationResolution): ShotVideoSpeechDurationBinding[] {
  if (resolution.status === 'ready') return resolution.decision.speechBindings
  if (resolution.status === 'requires_shot_split') return resolution.speechBindings
  return []
}

function lineChange(
  previous: ShotVideoTimingBindingIdentity | null,
  current: ShotVideoTimingBindingIdentity | null,
): ShotVideoTimingLineChange | null {
  if (!previous && current) return 'added'
  if (previous && !current) return 'removed'
  if (!previous || !current) return null
  if (previous.assetId !== current.assetId
    || previous.version !== current.version
    || previous.checksum !== current.checksum) return 'asset_changed'
  if (previous.durationSeconds !== current.durationSeconds
    || previous.durationFrames !== current.durationFrames) return 'duration_changed'
  return null
}

function affectedLines(
  previousDecision: ShotVideoDurationDecision,
  currentResolution: ShotVideoDurationResolution,
): ShotVideoTimingAffectedLine[] {
  const previous = new Map(previousDecision.speechBindings.map((binding) => (
    [binding.dialogueLineId, bindingIdentity(binding)]
  )))
  const current = new Map(resolutionBindings(currentResolution).map((binding) => (
    [binding.dialogueLineId, bindingIdentity(binding)]
  )))
  // An audio_required result intentionally does not expose valid bindings for
  // the unaffected lines. Only report blocked lines that actually had an old
  // immutable binding; blocked newly-added lines remain visible in
  // currentResolution.blockedLines without being falsely described as removed.
  const lineIds = currentResolution.status === 'audio_required'
    ? currentResolution.blockedLines
        .map((line) => line.dialogueLineId)
        .filter((lineId) => previous.has(lineId))
        .sort()
    : currentResolution.status === 'manual_duration_too_short'
      ? []
      : [...new Set([...previous.keys(), ...current.keys()])].sort()
  return lineIds.flatMap((dialogueLineId) => {
    const previousBinding = previous.get(dialogueLineId) ?? null
    const currentBinding = current.get(dialogueLineId) ?? null
    const change = lineChange(previousBinding, currentBinding)
    return change ? [{
      dialogueLineId,
      change,
      previous: previousBinding,
      current: currentBinding,
    }] : []
  })
}

function isSpeechBinding(value: unknown): value is ShotVideoSpeechDurationBinding {
  if (!isPlainObject(value)
    || !exactKeys(value, [
      'dialogueLineId', 'assetId', 'version', 'checksum', 'durationSeconds', 'durationFrames',
    ])) return false
  return safeIdentifier(value.dialogueLineId) && isBindingIdentity({
    assetId: value.assetId,
    version: value.version,
    checksum: value.checksum,
    durationSeconds: value.durationSeconds,
    durationFrames: value.durationFrames,
  })
}

function isCurrentResolution(value: unknown): value is ShotVideoDurationResolution {
  if (!isPlainObject(value) || typeof value.status !== 'string') return false
  if (value.status === 'ready') {
    return exactKeys(value, ['status', 'decision']) && isShotVideoDurationDecision(value.decision)
  }
  if (value.status === 'audio_required') {
    if (!exactKeys(value, ['status', 'shotId', 'blockedLines'])
      || !safeIdentifier(value.shotId)
      || !Array.isArray(value.blockedLines)
      || value.blockedLines.length < 1
      || value.blockedLines.length > 1_000) return false
    return value.blockedLines.every((line) => {
      if (!isPlainObject(line)
        || !exactKeys(line, ['dialogueLineId', 'reason'])
        || !safeIdentifier(line.dialogueLineId)
        || ![
          'SPEECH_ASSET_MISSING',
          'SPEECH_ASSET_NOT_READY',
          'SPEECH_ASSET_NOT_AUDIO',
          'SPEECH_ASSET_SCOPE_MISMATCH',
          'SPEECH_ASSET_REVISION_MISMATCH',
          'SPEECH_ASSET_IDENTITY_MISSING',
          'SPEECH_DURATION_MISSING',
          'DUPLICATE_DIALOGUE_LINE_ID',
        ].includes(String(line.reason))) return false
      return true
    })
  }
  if (value.status === 'requires_shot_split') {
    if (!(exactKeys(value, [
      'status',
      'shotId',
      'speechDurationSeconds',
      'maximumProviderDurationSeconds',
      'speechBindings',
    ])
      && safeIdentifier(value.shotId)
      && typeof value.speechDurationSeconds === 'number'
      && Number.isFinite(value.speechDurationSeconds)
      && value.speechDurationSeconds > 15
      && value.maximumProviderDurationSeconds === 15
      && Array.isArray(value.speechBindings)
      && value.speechBindings.length > 0
      && value.speechBindings.length <= 1_000
      && value.speechBindings.every(isSpeechBinding))) return false
    const bindings = value.speechBindings as ShotVideoSpeechDurationBinding[]
    return new Set(bindings.map((binding) => binding.dialogueLineId)).size === bindings.length
      && bindings.reduce((sum, binding) => sum + binding.durationFrames, 0) / 24
        === value.speechDurationSeconds
  }
  if (value.status === 'manual_duration_too_short') {
    return exactKeys(value, [
      'status', 'shotId', 'requestedDurationSeconds', 'speechDurationSeconds',
    ])
      && safeIdentifier(value.shotId)
      && Number.isInteger(value.requestedDurationSeconds)
      && (value.requestedDurationSeconds as number) >= 4
      && (value.requestedDurationSeconds as number) <= 15
      && typeof value.speechDurationSeconds === 'number'
      && Number.isFinite(value.speechDurationSeconds)
      && value.speechDurationSeconds > (value.requestedDurationSeconds as number)
  }
  return false
}

function isAffectedLine(value: unknown): value is ShotVideoTimingAffectedLine {
  if (!isPlainObject(value)
    || !exactKeys(value, ['dialogueLineId', 'change', 'previous', 'current'])
    || !safeIdentifier(value.dialogueLineId)
    || !['added', 'removed', 'asset_changed', 'duration_changed'].includes(String(value.change))
    || (value.previous !== null && !isBindingIdentity(value.previous))
    || (value.current !== null && !isBindingIdentity(value.current))) return false
  return lineChange(value.previous, value.current) === value.change
}

export function createShotVideoTimingRemediation(
  database: ManjuDatabase,
  input: CreateShotVideoTimingRemediationInput,
): ShotVideoTimingRemediation {
  const currentResolution = resolveShotVideoDuration(database, input.target, {
    ...(input.previousDecision.source === 'manual_override'
      ? { manualProviderDurationSeconds: input.previousDecision.providerDurationSeconds }
      : {}),
  })
  const remediation: ShotVideoTimingRemediation = {
    version: SHOT_VIDEO_TIMING_REMEDIATION_VERSION,
    kind: 'stale_audio_timing',
    projectId: input.target.projectId,
    episodeId: input.target.episodeId,
    shotId: input.target.publicShotId,
    sceneId: input.sceneId,
    sourceRevisionId: input.target.sourceRevisionId,
    checkpoint: input.checkpoint,
    providerSubmissionState: input.providerSubmissionState,
    detectedAt: input.detectedAt,
    previousDecision: structuredClone(input.previousDecision),
    currentResolution: structuredClone(currentResolution),
    affectedLines: affectedLines(input.previousDecision, currentResolution),
    recommendedAction: currentResolution.status === 'ready'
      ? 'repreflight-paid-video'
      : 'regenerate-speech-or-repreflight',
  }
  if (!isShotVideoTimingRemediation(remediation)) {
    throw new TypeError('Shot video timing remediation is not safe for durable public projection')
  }
  return remediation
}

export function isShotVideoTimingRemediation(value: unknown): value is ShotVideoTimingRemediation {
  if (!isPlainObject(value)
    || !exactKeys(value, [
      'version',
      'kind',
      'projectId',
      'episodeId',
      'shotId',
      'sceneId',
      'sourceRevisionId',
      'checkpoint',
      'providerSubmissionState',
      'detectedAt',
      'previousDecision',
      'currentResolution',
      'affectedLines',
      'recommendedAction',
    ])
    || value.version !== SHOT_VIDEO_TIMING_REMEDIATION_VERSION
    || value.kind !== 'stale_audio_timing'
    || !safeIdentifier(value.projectId)
    || !safeIdentifier(value.episodeId)
    || !safeIdentifier(value.shotId)
    || !safeIdentifier(value.sceneId)
    || !safeIdentifier(value.sourceRevisionId)
    || !['initial', 'pre-submit', 'pre-publish'].includes(String(value.checkpoint))
    || !['not-started', 'task-exists'].includes(String(value.providerSubmissionState))
    || !safeDetectedAt(value.detectedAt)
    || !isShotVideoDurationDecision(value.previousDecision)
    || !isCurrentResolution(value.currentResolution)
    || !Array.isArray(value.affectedLines)
    || value.affectedLines.length > 1_000
    || !value.affectedLines.every(isAffectedLine)) return false
  const expectedAction = value.currentResolution.status === 'ready'
    ? 'repreflight-paid-video'
    : 'regenerate-speech-or-repreflight'
  if (value.recommendedAction !== expectedAction) return false
  if (value.currentResolution.status !== 'ready'
    && value.currentResolution.shotId !== value.shotId) return false
  const expectedAffectedLines = affectedLines(value.previousDecision, value.currentResolution)
  return JSON.stringify(value.affectedLines) === JSON.stringify(expectedAffectedLines)
}

function durableTaskIds(record: GenerationJobRecord): {
  column: string | null
  checkpoint: string | null
} {
  return {
    column: typeof record.externalTaskId === 'string' && record.externalTaskId
      ? record.externalTaskId
      : null,
    checkpoint: typeof record.providerState.externalTaskId === 'string'
      && record.providerState.externalTaskId
      ? record.providerState.externalTaskId
      : null,
  }
}

/**
 * Parse only evidence cryptographically unnecessary but structurally bound to
 * the immutable job scope/input. Forged or legacy partial records return no
 * public projection and never weaken duplicate-billing isolation.
 */
export function readShotVideoTimingRemediation(
  record: GenerationJobRecord,
): ShotVideoTimingRemediation | undefined {
  if (record.type !== SHOT_VIDEO_GENERATION_JOB_TYPE
    || record.error?.code !== STALE_AUDIO_TIMING
    || !isShotVideoTimingRemediation(record.providerState.timingRemediation)) return undefined
  const value = record.providerState.timingRemediation
  const binding = isPlainObject(record.input.binding) ? record.input.binding : null
  if (!binding
    || value.projectId !== record.projectId
    || value.episodeId !== record.episodeId
    || value.shotId !== record.resourceId
    || value.episodeId !== binding.episodeId
    || value.shotId !== binding.shotId
    || value.sceneId !== binding.sceneId
    || value.sourceRevisionId !== binding.expectedRevisionId
    || !isShotVideoDurationDecision(record.input.durationDecision)
    || JSON.stringify(value.previousDecision) !== JSON.stringify(record.input.durationDecision)) return undefined
  const externalTaskIds = durableTaskIds(record)
  if ((externalTaskIds.column && externalTaskIds.checkpoint
      && externalTaskIds.column !== externalTaskIds.checkpoint)
    || (value.providerSubmissionState === 'not-started'
      ? externalTaskIds.column !== null || externalTaskIds.checkpoint !== null
      : externalTaskIds.column === null)) {
    return undefined
  }
  if (value.checkpoint === 'pre-submit' && value.providerSubmissionState !== 'not-started') return undefined
  if (value.checkpoint === 'pre-publish' && value.providerSubmissionState !== 'task-exists') return undefined
  return structuredClone(value)
}

export function shotVideoTimingRemediationProvesProviderNotStarted(
  record: GenerationJobRecord,
): boolean {
  const remediation = readShotVideoTimingRemediation(record)
  return remediation?.checkpoint === 'pre-submit'
    && remediation.providerSubmissionState === 'not-started'
}
