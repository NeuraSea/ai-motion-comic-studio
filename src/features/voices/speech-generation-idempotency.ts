import type {
  DialogueSpeechGenerationJob,
  GenerationJob,
} from '../../lib'

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

export interface SpeechGenerationIdempotencyLease {
  key: string
  acknowledgedJobId: string | null
}

export type SpeechGenerationIdempotencyRegistry = Map<
  string,
  SpeechGenerationIdempotencyLease
>

function jobIsTerminal(job: GenerationJob): boolean {
  return TERMINAL_JOB_STATUSES.has(job.status)
}

/**
 * Keep one key bound to an exact speech intent until its acknowledged Job is
 * visibly terminal. A missing Job is not evidence that the paid POST failed:
 * list/SSE may be unavailable, so replay must keep using the original key.
 */
export function acquireSpeechGenerationIdempotencyKey(
  registry: SpeechGenerationIdempotencyRegistry,
  signature: string,
  currentJobs: readonly GenerationJob[],
  keyFactory: () => string = () => crypto.randomUUID(),
): string {
  const current = registry.get(signature)
  if (current) {
    const acknowledgedJob = current.acknowledgedJobId
      ? currentJobs.find((job) => job.id === current.acknowledgedJobId)
      : undefined
    if (!acknowledgedJob || !jobIsTerminal(acknowledgedJob)) return current.key
  }

  const key = keyFactory()
  registry.set(signature, { key, acknowledgedJobId: null })
  return key
}

function acknowledgeSpeechGenerationJob(
  registry: SpeechGenerationIdempotencyRegistry,
  signature: string,
  key: string,
  jobId: string,
): void {
  const current = registry.get(signature)
  if (!current || current.key !== key) return
  registry.set(signature, { key, acknowledgedJobId: jobId })
}

export interface SubmitDialogueSpeechWithIdempotencyInput {
  registry: SpeechGenerationIdempotencyRegistry
  signature: string
  currentJobs: readonly GenerationJob[]
  /**
   * When the request was already frozen by a paid preflight, the subsequent
   * POST must use that exact lease rather than selecting a fresh key.
   */
  expectedIdempotencyKey?: string
  createJob: (idempotencyKey: string) => Promise<DialogueSpeechGenerationJob>
  rememberJob: (job: DialogueSpeechGenerationJob) => void
  refreshJobs: () => Promise<GenerationJob[]>
  keyFactory?: () => string
}

export interface SubmitDialogueSpeechWithIdempotencyResult {
  job: DialogueSpeechGenerationJob
  refreshSynchronized: boolean
}

/**
 * A paid POST acknowledgement is merged locally before any fallible list
 * refresh. Refresh failure is deliberately non-fatal and never releases the
 * key, so a replay resolves to the same durable server Job.
 */
export async function submitDialogueSpeechWithIdempotency(
  input: SubmitDialogueSpeechWithIdempotencyInput,
): Promise<SubmitDialogueSpeechWithIdempotencyResult> {
  const expectedKey = input.expectedIdempotencyKey
  const key = acquireSpeechGenerationIdempotencyKey(
    input.registry,
    input.signature,
    input.currentJobs,
    expectedKey
      ? () => expectedKey
      : input.keyFactory,
  )
  if (expectedKey !== undefined && key !== expectedKey) {
    throw new Error('语音计费意图的幂等键已变化，请重新预检。')
  }
  const job = await input.createJob(key)
  acknowledgeSpeechGenerationJob(input.registry, input.signature, key, job.id)
  input.rememberJob(job)

  let refreshSynchronized = false
  try {
    const refreshed = await input.refreshJobs()
    refreshSynchronized = refreshed.some((candidate) => candidate.id === job.id)
  } catch {
    // The POST is already durable. Polling/SSE or a replay with the retained
    // key will recover the same Job without another paid provider operation.
  }
  return { job, refreshSynchronized }
}
