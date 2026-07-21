import type {
  GenerationJob,
  GenerationJobCancellation,
  GenerationJobProviderDiagnostic,
  JobRetryDisposition,
  JobStatus,
  ShotVideoDurationDecision,
  ShotVideoDurationResolution,
  ShotVideoSpeechDurationBinding,
  ShotVideoTimingBindingIdentity,
  ShotVideoTimingRemediation,
  ShotVideoUnknownSubmissionResolution,
} from './api-types'

const JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  'queued',
  'running',
  'waiting_provider',
  'succeeded',
  'failed',
  'cancelled',
])

const JOB_RETRY_DISPOSITIONS: ReadonlySet<JobRetryDisposition> = new Set([
  'generic-free-retry',
  'resume-existing-provider-task',
  'paid-reconfirmation-required',
  'manual-resolution',
  'not-retryable',
])

const UPSTREAM_CANCELLATION_STATES: ReadonlySet<GenerationJobCancellation['upstreamCancellation']> = new Set([
  'not-submitted',
  'not-supported',
  'request-pending',
  'request-sent',
  'not-found',
  'request-failed',
  'unknown',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isNonEmptyString(value: unknown, maximum = 10_000): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximum
}

function isNullableString(value: unknown, maximum = 10_000): value is string | null {
  return value === null || isNonEmptyString(value, maximum)
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value, 64) && Number.isFinite(Date.parse(value))
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (!isTimestamp(value)) return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value)
}

function isJobError(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.code, 200)
    && isNonEmptyString(value.message, 20_000)
    && typeof value.retryable === 'boolean'
    && (value.category === undefined || isNonEmptyString(value.category, 200))
}

function isCancellation(value: unknown): value is GenerationJobCancellation {
  return isRecord(value)
    && value.localProcessing === 'stopped'
    && UPSTREAM_CANCELLATION_STATES.has(value.upstreamCancellation as GenerationJobCancellation['upstreamCancellation'])
    && typeof value.providerTaskMayContinue === 'boolean'
    && typeof value.chargesMayStillApply === 'boolean'
    && isNonEmptyString(value.message, 2_000)
}

function isProviderDiagnostic(value: unknown): value is GenerationJobProviderDiagnostic {
  return isRecord(value)
    && value.operation === 'create'
    && (value.protocol === 'ark' || value.protocol === 'newapi')
    && (value.endpointFamily === 'ark-tasks' || value.endpointFamily === 'openai-videos')
    && Number.isInteger(value.httpStatus)
    && (value.httpStatus as number) >= 100
    && (value.httpStatus as number) <= 599
    && (value.providerCode === undefined
      || (isNonEmptyString(value.providerCode, 160)
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.providerCode)))
    && isTimestamp(value.observedAt)
}

function isProviderPlatformCostPolicy(value: unknown): boolean {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'version',
      'costClass',
      'billable',
      'paidConfirmationRequired',
      'upstreamProviderBilling',
    ])
    || value.version !== 1
    || (value.costClass !== 'free-llm' && value.costClass !== 'billable-media')
    || typeof value.billable !== 'boolean'
    || typeof value.paidConfirmationRequired !== 'boolean'
    || value.upstreamProviderBilling !== 'outside-platform-policy') return false
  const freeLlm = value.costClass === 'free-llm'
  return value.billable === !freeLlm
    && value.paidConfirmationRequired === !freeLlm
}

function isGenerationJobCost(value: unknown): boolean {
  return value === null
    || (isRecord(value)
      && (value.platformPolicy === undefined
        || isProviderPlatformCostPolicy(value.platformPolicy)))
}

const DURATION_NOTICES = new Set([
  'AUDIO_DRIVEN_TIMELINE',
  'PROVIDER_MINIMUM_SOURCE_WILL_BE_TRIMMED',
  'MANUAL_DURATION_ADDS_SILENT_TAIL',
  'LINE_DURATION_METADATA_DIFFERS_FROM_ASSET',
  'STORY_DURATION_USED_WITHOUT_SPEECH',
])

const DURATION_BLOCK_REASONS = new Set([
  'SPEECH_ASSET_MISSING',
  'SPEECH_ASSET_NOT_READY',
  'SPEECH_ASSET_NOT_AUDIO',
  'SPEECH_ASSET_SCOPE_MISMATCH',
  'SPEECH_ASSET_REVISION_MISMATCH',
  'SPEECH_ASSET_IDENTITY_MISSING',
  'SPEECH_DURATION_MISSING',
  'DUPLICATE_DIALOGUE_LINE_ID',
])

function isPositiveFiniteNumber(value: unknown, maximum = Number.POSITIVE_INFINITY): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= maximum
}

function isDurationFramesForSeconds(frames: unknown, seconds: number): frames is number {
  return Number.isInteger(frames)
    && (frames as number) >= 1
    && frames === Math.max(1, Math.ceil(seconds * 24))
}

function isSpeechDurationBinding(value: unknown): value is ShotVideoSpeechDurationBinding {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'dialogueLineId',
      'assetId',
      'version',
      'checksum',
      'durationSeconds',
      'durationFrames',
    ])
    || !isNonEmptyString(value.dialogueLineId, 200)
    || !isNonEmptyString(value.assetId, 200)
    || !Number.isInteger(value.version)
    || (value.version as number) < 1
    || typeof value.checksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.checksum)
    || !isPositiveFiniteNumber(value.durationSeconds, 3_600)) return false
  return isDurationFramesForSeconds(value.durationFrames, value.durationSeconds)
}

function isTimingBindingIdentity(value: unknown): value is ShotVideoTimingBindingIdentity {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'assetId',
      'version',
      'checksum',
      'durationSeconds',
      'durationFrames',
    ])
    || !isNonEmptyString(value.assetId, 200)
    || !Number.isInteger(value.version)
    || (value.version as number) < 1
    || typeof value.checksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.checksum)
    || !isPositiveFiniteNumber(value.durationSeconds, 3_600)) return false
  return isDurationFramesForSeconds(value.durationFrames, value.durationSeconds)
}

function isDurationDecision(value: unknown): value is ShotVideoDurationDecision {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'version',
      'source',
      'frameRate',
      'plannedDurationSeconds',
      'speechDurationSeconds',
      'timelineDurationSeconds',
      'providerDurationSeconds',
      'speechBindings',
      'notices',
    ])
    || value.version !== 1
    || !['speech_assets', 'story_duration', 'manual_override'].includes(String(value.source))
    || value.frameRate !== 24
    || typeof value.plannedDurationSeconds !== 'number'
    || !Number.isFinite(value.plannedDurationSeconds)
    || value.plannedDurationSeconds < 0
    || !(value.speechDurationSeconds === null
      || isPositiveFiniteNumber(value.speechDurationSeconds, 3_600))
    || !isPositiveFiniteNumber(value.timelineDurationSeconds, 3_600)
    || !Number.isInteger(value.providerDurationSeconds)
    || (value.providerDurationSeconds as number) < 4
    || (value.providerDurationSeconds as number) > 15
    || !Array.isArray(value.speechBindings)
    || !value.speechBindings.every(isSpeechDurationBinding)
    || !Array.isArray(value.notices)
    || !value.notices.every((notice) => typeof notice === 'string' && DURATION_NOTICES.has(notice))) {
    return false
  }

  const bindings = value.speechBindings as ShotVideoSpeechDurationBinding[]
  if (new Set(bindings.map((binding) => binding.dialogueLineId)).size !== bindings.length) return false
  if (value.source === 'story_duration') {
    return value.speechDurationSeconds === null
      && bindings.length === 0
      && Math.abs(value.timelineDurationSeconds * 24 - Math.round(value.timelineDurationSeconds * 24)) < 1e-9
  }
  if (value.speechDurationSeconds === null) {
    return value.source === 'manual_override'
      && bindings.length === 0
      && value.timelineDurationSeconds === value.providerDurationSeconds
  }
  const totalFrames = bindings.reduce((sum, binding) => sum + binding.durationFrames, 0)
  if (totalFrames <= 0 || Math.abs(totalFrames / 24 - value.speechDurationSeconds) >= 1e-9) return false
  if (value.source === 'speech_assets') {
    return value.timelineDurationSeconds === value.speechDurationSeconds
      && value.providerDurationSeconds === Math.max(4, Math.ceil(value.speechDurationSeconds))
  }
  return value.timelineDurationSeconds === value.providerDurationSeconds
    && value.providerDurationSeconds * 24 >= totalFrames
}

function isDurationResolution(value: unknown): value is ShotVideoDurationResolution {
  if (!isRecord(value) || typeof value.status !== 'string') return false
  if (value.status === 'ready') {
    return hasExactKeys(value, ['status', 'decision']) && isDurationDecision(value.decision)
  }
  if (value.status === 'audio_required') {
    if (!hasExactKeys(value, ['status', 'shotId', 'blockedLines'])
      || !isNonEmptyString(value.shotId, 200)
      || !Array.isArray(value.blockedLines)
      || value.blockedLines.length < 1) return false
    const lineIds = new Set<string>()
    return value.blockedLines.every((line) => {
      if (!isRecord(line)
        || !hasExactKeys(line, ['dialogueLineId', 'reason'])
        || !isNonEmptyString(line.dialogueLineId, 200)
        || typeof line.reason !== 'string'
        || !DURATION_BLOCK_REASONS.has(line.reason)
        || lineIds.has(line.dialogueLineId)) return false
      lineIds.add(line.dialogueLineId)
      return true
    })
  }
  if (value.status === 'requires_shot_split') {
    if (!(hasExactKeys(value, [
      'status',
      'shotId',
      'speechDurationSeconds',
      'maximumProviderDurationSeconds',
      'speechBindings',
    ])
      && isNonEmptyString(value.shotId, 200)
      && isPositiveFiniteNumber(value.speechDurationSeconds, 3_600)
      && (value.speechDurationSeconds as number) > 15
      && value.maximumProviderDurationSeconds === 15
      && Array.isArray(value.speechBindings)
      && value.speechBindings.length > 0
      && value.speechBindings.length <= 1_000
      && value.speechBindings.every(isSpeechDurationBinding))) return false
    const bindings = value.speechBindings as ShotVideoSpeechDurationBinding[]
    return new Set(bindings.map((binding) => binding.dialogueLineId)).size === bindings.length
      && bindings.reduce((sum, binding) => sum + binding.durationFrames, 0) / 24
        === value.speechDurationSeconds
  }
  if (value.status === 'manual_duration_too_short') {
    return hasExactKeys(value, [
      'status',
      'shotId',
      'requestedDurationSeconds',
      'speechDurationSeconds',
    ])
      && isNonEmptyString(value.shotId, 200)
      && Number.isInteger(value.requestedDurationSeconds)
      && (value.requestedDurationSeconds as number) >= 4
      && (value.requestedDurationSeconds as number) <= 15
      && isPositiveFiniteNumber(value.speechDurationSeconds, 3_600)
      && (value.speechDurationSeconds as number) > (value.requestedDurationSeconds as number)
  }
  return false
}

function timingLineChange(
  previous: ShotVideoTimingBindingIdentity | null,
  current: ShotVideoTimingBindingIdentity | null,
): 'added' | 'removed' | 'asset_changed' | 'duration_changed' | null {
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

function timingIdentityFromSpeechBinding(
  binding: ShotVideoSpeechDurationBinding,
): ShotVideoTimingBindingIdentity {
  return {
    assetId: binding.assetId,
    version: binding.version,
    checksum: binding.checksum,
    durationSeconds: binding.durationSeconds,
    durationFrames: binding.durationFrames,
  }
}

function expectedTimingAffectedLines(
  previousDecision: ShotVideoDurationDecision,
  currentResolution: ShotVideoDurationResolution,
): Array<{
  dialogueLineId: string
  change: 'added' | 'removed' | 'asset_changed' | 'duration_changed'
  previous: ShotVideoTimingBindingIdentity | null
  current: ShotVideoTimingBindingIdentity | null
}> {
  const previous = new Map(previousDecision.speechBindings.map((binding) => (
    [binding.dialogueLineId, timingIdentityFromSpeechBinding(binding)] as const
  )))
  const currentBindings = currentResolution.status === 'ready'
    ? currentResolution.decision.speechBindings
    : currentResolution.status === 'requires_shot_split'
      ? currentResolution.speechBindings
      : []
  const current = new Map(currentBindings.map((binding) => (
    [binding.dialogueLineId, timingIdentityFromSpeechBinding(binding)] as const
  )))
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
    const change = timingLineChange(previousBinding, currentBinding)
    return change ? [{
      dialogueLineId,
      change,
      previous: previousBinding,
      current: currentBinding,
    }] : []
  })
}

function isTimingRemediation(value: unknown): value is ShotVideoTimingRemediation {
  if (!isRecord(value)
    || !hasExactKeys(value, [
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
    || value.version !== 1
    || value.kind !== 'stale_audio_timing'
    || !isNonEmptyString(value.projectId, 200)
    || !isNonEmptyString(value.episodeId, 200)
    || !isNonEmptyString(value.shotId, 200)
    || !isNonEmptyString(value.sceneId, 200)
    || !isNonEmptyString(value.sourceRevisionId, 200)
    || !['initial', 'pre-submit', 'pre-publish'].includes(String(value.checkpoint))
    || !['not-started', 'task-exists'].includes(String(value.providerSubmissionState))
    || !isCanonicalTimestamp(value.detectedAt)
    || !isDurationDecision(value.previousDecision)
    || !isDurationResolution(value.currentResolution)
    || !Array.isArray(value.affectedLines)
    || value.affectedLines.length > 1_000
    || !['regenerate-speech-or-repreflight', 'repreflight-paid-video'].includes(String(value.recommendedAction))) {
    return false
  }

  if (value.checkpoint === 'pre-submit' && value.providerSubmissionState !== 'not-started') return false
  if (value.checkpoint === 'pre-publish' && value.providerSubmissionState !== 'task-exists') return false
  if (value.currentResolution.status !== 'ready'
    && value.currentResolution.shotId !== value.shotId) return false
  if ((value.currentResolution.status === 'ready')
    !== (value.recommendedAction === 'repreflight-paid-video')) return false

  const lineIds = new Set<string>()
  const affectedLinesAreValid = value.affectedLines.every((line) => {
    if (!isRecord(line)
      || !hasExactKeys(line, ['dialogueLineId', 'change', 'previous', 'current'])
      || !isNonEmptyString(line.dialogueLineId, 200)
      || !['added', 'removed', 'asset_changed', 'duration_changed'].includes(String(line.change))
      || !(line.previous === null || isTimingBindingIdentity(line.previous))
      || !(line.current === null || isTimingBindingIdentity(line.current))
      || lineIds.has(line.dialogueLineId)) return false
    lineIds.add(line.dialogueLineId)
    const previous = line.previous as ShotVideoTimingBindingIdentity | null
    const current = line.current as ShotVideoTimingBindingIdentity | null
    return timingLineChange(previous, current) === line.change
  })
  if (!affectedLinesAreValid) return false
  return JSON.stringify(value.affectedLines)
    === JSON.stringify(expectedTimingAffectedLines(value.previousDecision, value.currentResolution))
}

function isUnknownSubmissionResolution(
  value: unknown,
): value is ShotVideoUnknownSubmissionResolution {
  if (!isRecord(value)
    || value.version !== 1
    || !isNonEmptyString(value.auditRevisionId, 200)
    || !isNonEmptyString(value.jobId, 200)
    || !isNonEmptyString(value.projectId, 200)
    || !isNonEmptyString(value.episodeId, 200)
    || !isNonEmptyString(value.shotId, 200)
    || !isNonEmptyString(value.expectedSourceRevisionId, 200)
    || value.resolution !== 'confirmed-not-created'
    || value.confirmedProviderConsoleChecked !== true
    || typeof value.note !== 'string'
    || value.note.length > 2_000
    || !isTimestamp(value.resolvedAt)
    || !isRecord(value.provider)
    || !isNonEmptyString(value.provider.id, 200)
    || !Number.isInteger(value.provider.configRevision)
    || (value.provider.configRevision as number) < 1
    || !isNonEmptyString(value.provider.model, 500)
    || !(value.provider.baseUrl === null || isNonEmptyString(value.provider.baseUrl, 2_000))) {
    return false
  }
  return true
}

/**
 * Strict public Job projection shared by REST snapshots and SSE events.
 *
 * Retry UI must never infer authority from a loosely-cast object. In
 * particular, an unknown retryDisposition is rejected and the durable REST
 * snapshot remains the only recovery source after a malformed SSE event.
 */
export function isGenerationJob(value: unknown): value is GenerationJob {
  if (!isRecord(value)
    || !isNonEmptyString(value.id, 200)
    || !isNonEmptyString(value.projectId, 200)
    || !isNullableString(value.episodeId, 200)
    || !isNullableString(value.pipelineRunId, 200)
    || !isNonEmptyString(value.type, 200)
    || !JOB_STATUSES.has(value.status as JobStatus)
    || typeof value.progress !== 'number'
    || !Number.isFinite(value.progress)
    || value.progress < 0
    || value.progress > 100
    || !isNullableString(value.resourceType, 200)
    || !isNullableString(value.resourceId, 200)
    || !isNullableString(value.providerId, 200)
    || !isNullableString(value.model, 500)
    || !(value.providerConfigRevision === null
      || (Number.isInteger(value.providerConfigRevision)
        && (value.providerConfigRevision as number) >= 1))
    || !isNullableString(value.externalTaskId, 500)
    || !isNullableString(value.idempotencyKey, 500)
    || !isNullableString(value.retryOf, 200)
    || !Number.isInteger(value.attempt)
    || (value.attempt as number) < 1
    || !isRecord(value.input)
    || !isRecord(value.progressDetail)
    || !(value.output === null || isRecord(value.output))
    || !(value.error === null || isJobError(value.error))
    || !isGenerationJobCost(value.cost)
    || !JOB_RETRY_DISPOSITIONS.has(value.retryDisposition as JobRetryDisposition)
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.updatedAt)
    || !isNullableTimestamp(value.startedAt)
    || !isNullableTimestamp(value.completedAt)) {
    return false
  }

  if (value.cancellation !== undefined
    && (value.type !== 'shot.video.generate'
      || value.status !== 'cancelled'
      || !isCancellation(value.cancellation))) return false

  if (value.providerDiagnostic !== undefined
    && (value.type !== 'shot.video.generate'
      || !isProviderDiagnostic(value.providerDiagnostic))) return false

  if (value.unknownSubmissionResolution !== undefined
    && (value.type !== 'shot.video.generate'
      || !isUnknownSubmissionResolution(value.unknownSubmissionResolution)
      || value.unknownSubmissionResolution.jobId !== value.id
      || value.unknownSubmissionResolution.projectId !== value.projectId
      || value.unknownSubmissionResolution.episodeId !== value.episodeId)) return false

  if (value.timingRemediation !== undefined) {
    const binding = isRecord(value.input.binding) ? value.input.binding : null
    if (value.type !== 'shot.video.generate'
      || value.status !== 'failed'
      || !isRecord(value.error)
      || value.error.code !== 'STALE_AUDIO_TIMING'
      || value.retryDisposition !== 'paid-reconfirmation-required'
      || !isTimingRemediation(value.timingRemediation)
      || value.timingRemediation.projectId !== value.projectId
      || value.timingRemediation.episodeId !== value.episodeId
      || value.timingRemediation.shotId !== value.resourceId
      || value.timingRemediation.shotId !== binding?.shotId
      || value.timingRemediation.sceneId !== binding?.sceneId
      || value.timingRemediation.sourceRevisionId !== binding?.expectedRevisionId
      || !isDurationDecision(value.input.durationDecision)
      || JSON.stringify(value.timingRemediation.previousDecision)
        !== JSON.stringify(value.input.durationDecision)
      || (value.timingRemediation.providerSubmissionState === 'task-exists') !== Boolean(value.externalTaskId)) {
      return false
    }
  }

  if (isRecord(value.error)
    && value.error.code === 'STALE_AUDIO_TIMING'
    && value.timingRemediation === undefined
    && value.retryDisposition !== 'manual-resolution') return false

  if ((value.status === 'failed' || value.status === 'cancelled') && value.completedAt === null) return false
  if (value.status === 'succeeded' && (value.output === null || value.error !== null || value.completedAt === null)) {
    return false
  }
  if (value.status === 'failed' && value.error === null) return false

  return true
}

/** Extract only a fully validated public Job from an SSE event data value. */
export function generationJobFromEventData(value: unknown): GenerationJob | null {
  if (!isRecord(value)) return null
  const candidate = isRecord(value.job) ? value.job : value
  return isGenerationJob(candidate) ? candidate : null
}
