import type { ImageJob } from '../../lib'

export type ImageJobRetryAction = 'create' | 'track'

/**
 * Image generation is billable. A failed durable Job always returns to a new
 * exact preflight/confirmation; it must never use the generic retry route,
 * regardless of the lower-level Provider error's retryable flag.
 */
export function getImageJobRetryAction(
  job: Pick<ImageJob, 'status' | 'error'> | null,
): ImageJobRetryAction {
  if (!job) return 'create'
  if (job.status === 'failed') return 'create'
  if (job.status === 'succeeded' || job.status === 'cancelled') return 'create'
  return 'track'
}
