import type { GenerationJobRecord, ManjuDatabase } from './database.js'
import { paidAigcActions } from './paid-aigc-confirmation.js'
import {
  readShotVideoUnknownSubmissionResolution,
  ShotVideoManualResolutionError,
} from './shot-video-manual-resolution.js'
import { shotVideoTimingRemediationProvesProviderNotStarted } from './shot-video-timing-remediation.js'

export const JOB_RETRY_DISPOSITIONS = [
  'generic-free-retry',
  'resume-existing-provider-task',
  'paid-reconfirmation-required',
  'manual-resolution',
  'not-retryable',
] as const

export type JobRetryDisposition = typeof JOB_RETRY_DISPOSITIONS[number]

const SHOT_VIDEO_GENERATION_JOB_TYPE = 'shot.video.generate'
const PROVIDER_SUBMISSION_OUTCOME_UNKNOWN = 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Generic retry is fail-closed: only these reviewed, non-billable handlers may
 * create a fresh retry Job. Adding a new handler does not silently grant it a
 * Provider retry path.
 */
const GENERIC_FREE_RETRY_JOB_TYPES: ReadonlySet<string> = new Set([
  'story.generate',
  'character.voice.recommend',
  'dialogue.performance.recommend',
  'shot.video.reference.analyze',
  'asset.image.turnaround.derive',
  'export.render',
  'quality.check',
])

const FREE_LLM_AGENTIC_JOB_TYPES: ReadonlySet<string> = new Set([
  'story.generate',
  'character.voice.recommend',
  'dialogue.performance.recommend',
  'shot.video.reference.analyze',
])

export function isFreeLlmAgenticJobType(type: string): boolean {
  return FREE_LLM_AGENTIC_JOB_TYPES.has(type)
}

/** `image.generate` is the retired compatibility name for paid image work. */
const PAID_FRESH_ATTEMPT_JOB_TYPES: ReadonlySet<string> = new Set([
  ...paidAigcActions,
  'image.generate',
])

const NON_IDEMPOTENT_SUBMISSION_PHASES: ReadonlySet<string> = new Set([
  'submitting',
  'response-received',
])

const VIDEO_UNKNOWN_CHECKPOINT_PHASES: ReadonlySet<string> = new Set([
  'submitting',
  'polling',
  'downloading',
])

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function providerStateTaskId(record: GenerationJobRecord): string | null {
  return nonEmptyString(record.providerState.externalTaskId)
}

function externalTaskId(record: GenerationJobRecord): string | null {
  return nonEmptyString(record.externalTaskId) ?? providerStateTaskId(record)
}

function taskHasProvenTerminalOutcome(record: GenerationJobRecord): boolean {
  if (!externalTaskId(record)) return false
  return record.providerState.lastStatus === 'failed'
    || record.providerState.lastStatus === 'cancelled'
    || record.providerState.lastStatus === 'expired'
}

function verifiedConfirmedNotCreated(
  database: ManjuDatabase,
  record: GenerationJobRecord,
): boolean {
  if (record.type !== SHOT_VIDEO_GENERATION_JOB_TYPE
    || record.error?.code !== 'PROVIDER_SUBMISSION_CONFIRMED_NOT_CREATED') return false
  try {
    return readShotVideoUnknownSubmissionResolution(database, record) !== undefined
  } catch (error) {
    if (error instanceof ShotVideoManualResolutionError) return false
    throw error
  }
}

function hasExplicitProviderRejection(record: GenerationJobRecord): boolean {
  const diagnostic = record.providerState.submissionDiagnostic
  return record.type === SHOT_VIDEO_GENERATION_JOB_TYPE
    && isPlainObject(diagnostic)
    && diagnostic.operation === 'create'
    && ((diagnostic.httpStatus === 403
      && diagnostic.providerCode === 'AccountOverdueError')
      || (diagnostic.httpStatus === 429
        && diagnostic.providerCode === 'QuotaExceeded'))
}

export function jobHasUnknownSubmission(
  database: ManjuDatabase,
  record: GenerationJobRecord,
): boolean {
  // Ark explicitly rejected these requests before allocating a task. Older
  // jobs persisted the conservative unknown-outcome error, but their sanitized
  // 403/429 diagnostic is sufficient to classify them without a console lookup.
  if (hasExplicitProviderRejection(record)) return false
  if (record.error?.code === PROVIDER_SUBMISSION_OUTCOME_UNKNOWN
    || record.error?.code === 'PROVIDER_TASK_CONFLICT') return true
  if (externalTaskId(record)) return false
  if (verifiedConfirmedNotCreated(database, record)) return false
  const operation = record.providerState.operation
  const phase = record.providerState.phase
  if (typeof phase !== 'string') return false
  if (record.type === SHOT_VIDEO_GENERATION_JOB_TYPE
    && operation === SHOT_VIDEO_GENERATION_JOB_TYPE) {
    // The only safe exception to the historical `submitting` ambiguity is a
    // strict timing remediation created synchronously at the final gate before
    // createTask(). Partial/legacy evidence remains fail-closed.
    if (phase === 'submitting'
      && shotVideoTimingRemediationProvesProviderNotStarted(record)) return false
    return VIDEO_UNKNOWN_CHECKPOINT_PHASES.has(phase)
  }
  return operation === record.type
    && NON_IDEMPOTENT_SUBMISSION_PHASES.has(phase)
    && (PAID_FRESH_ATTEMPT_JOB_TYPES.has(record.type)
      || record.providerState.providerSupportsIdempotency !== true)
}

function sameRetryLineage(
  source: GenerationJobRecord,
  ancestor: GenerationJobRecord,
): boolean {
  return ancestor.projectId === source.projectId
    && ancestor.episodeId === source.episodeId
    && ancestor.type === source.type
    && ancestor.resourceType === source.resourceType
    && ancestor.resourceId === source.resourceId
    && ancestor.providerId === source.providerId
    && ancestor.model === source.model
    && ancestor.providerConfigRevision === source.providerConfigRevision
}

interface RetryLineageState {
  recoverableProviderTask: boolean
  terminalProviderTask: boolean
  unknownSubmission: boolean
  corrupt: boolean
}

/**
 * Inspect newest-to-oldest. A newer ambiguous POST wins over any older task id;
 * otherwise a same-scope Seedance task id is sufficient only for polling, never
 * for another create call.
 */
function retryLineageState(
  database: ManjuDatabase,
  source: GenerationJobRecord,
): RetryLineageState {
  const visited = new Set<string>()
  let observedTaskId: string | null = null
  let observedTaskState: 'recoverable' | 'terminal' | null = null
  let current: GenerationJobRecord | undefined = source
  while (current) {
    if (visited.has(current.id)) {
      return {
        recoverableProviderTask: false,
        terminalProviderTask: false,
        unknownSubmission: false,
        corrupt: true,
      }
    }
    visited.add(current.id)
    if (jobHasUnknownSubmission(database, current)) {
      return {
        recoverableProviderTask: false,
        terminalProviderTask: false,
        unknownSubmission: true,
        corrupt: false,
      }
    }
    const currentTaskId = externalTaskId(current)
    if (currentTaskId) {
      const currentTaskState = taskHasProvenTerminalOutcome(current)
        ? 'terminal'
        : 'recoverable'
      if (observedTaskId && observedTaskId !== currentTaskId) {
        return {
          recoverableProviderTask: false,
          terminalProviderTask: false,
          unknownSubmission: false,
          corrupt: true,
        }
      }
      if (!observedTaskId) {
        // Newest checkpoint wins, but keep walking to prove that every older
        // retry node refers to this exact task id and the lineage is intact.
        observedTaskId = currentTaskId
        observedTaskState = currentTaskState
      } else if (observedTaskState === 'recoverable' && currentTaskState === 'terminal') {
        // A terminal Provider task cannot legitimately be resurrected by a
        // newer retry node. Treat contradictory audit state as corruption.
        return {
          recoverableProviderTask: false,
          terminalProviderTask: false,
          unknownSubmission: false,
          corrupt: true,
        }
      }
    }
    if (!current.retryOf) break
    const ancestor = database.getGenerationJob(current.retryOf)
    if (!ancestor || !sameRetryLineage(source, ancestor)) {
      return {
        recoverableProviderTask: false,
        terminalProviderTask: false,
        unknownSubmission: false,
        corrupt: true,
      }
    }
    current = ancestor
  }
  return {
    recoverableProviderTask: observedTaskState === 'recoverable',
    terminalProviderTask: observedTaskState === 'terminal',
    unknownSubmission: false,
    corrupt: false,
  }
}

/**
 * Authoritative, public-safe retry decision. It never projects Provider state,
 * task ids, prompts, credentials, or error diagnostics.
 */
export function jobRetryDisposition(
  database: ManjuDatabase,
  job: GenerationJobRecord,
): JobRetryDisposition {
  const cancelledShotVideo = job.status === 'cancelled'
    && job.type === SHOT_VIDEO_GENERATION_JOB_TYPE
  if (job.status !== 'failed' && !cancelledShotVideo) return 'not-retryable'

  const lineage = retryLineageState(database, job)
  if (lineage.corrupt || lineage.unknownSubmission) return 'manual-resolution'

  if (job.type === SHOT_VIDEO_GENERATION_JOB_TYPE) {
    // A task generated against an obsolete audio timeline cannot be reused even
    // when an exact upstream task id exists. Crucially, the lineage check above
    // still keeps legacy/forged `submitting` rows without strict not-started
    // evidence in manual isolation.
    if (job.error?.code === 'STALE_AUDIO_TIMING') return 'paid-reconfirmation-required'
    if (cancelledShotVideo) {
      // `not-submitted` plus a durable task id is contradictory audit data.
      // Fail closed instead of either polling blindly or permitting a second
      // paid create call.
      if (externalTaskId(job) && job.providerState.cancellationOutcome === 'not-submitted') {
        return 'manual-resolution'
      }
      // A local cancellation (including NewAPI unsupported cancellation and
      // an Ark cancellation request that has not reached a proven terminal
      // task state) does not end the accepted Provider task. The only safe
      // action is a linear child which resumes polling that exact task id.
      if (lineage.recoverableProviderTask) return 'resume-existing-provider-task'
      return 'not-retryable'
    }
    // Once an exact Provider task exists, the retryable bit only describes
    // the latest local/polling failure; it must never authorize a second paid
    // create call. Continuing the same task id is safe even when that poll or
    // download failure was labelled non-retryable (for example TASK_NOT_FOUND
    // before the cancellation state is conclusively terminal).
    if (lineage.recoverableProviderTask) return 'resume-existing-provider-task'
    return 'paid-reconfirmation-required'
  }

  if (PAID_FRESH_ATTEMPT_JOB_TYPES.has(job.type)) {
    return 'paid-reconfirmation-required'
  }

  if (GENERIC_FREE_RETRY_JOB_TYPES.has(job.type) && job.error?.retryable === true) {
    return 'generic-free-retry'
  }

  return 'not-retryable'
}

export function genericRetryAllowed(disposition: JobRetryDisposition): boolean {
  return disposition === 'generic-free-retry'
    || disposition === 'resume-existing-provider-task'
}
