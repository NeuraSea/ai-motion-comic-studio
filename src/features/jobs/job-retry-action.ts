import type { GenerationJob, JobRetryDisposition } from '../../lib'

export type JobRetryAction = Exclude<JobRetryDisposition, 'not-retryable'>

export interface JobRetryActionPresentation {
  action: JobRetryAction
  label: '重试' | '继续查询' | '重新预检' | '人工处理'
  title: string
}

/**
 * Presentation only. The API repeats the same admission decision; this helper
 * deliberately never consults the less-specific legacy retryable flag.
 */
export function jobRetryAction(
  job: Pick<GenerationJob, 'status' | 'retryDisposition'>,
): JobRetryActionPresentation | null {
  const cancelledProviderResume = job.status === 'cancelled'
    && job.retryDisposition === 'resume-existing-provider-task'
  if (job.status !== 'failed' && !cancelledProviderResume) return null
  switch (job.retryDisposition) {
    case 'generic-free-retry':
      return { action: job.retryDisposition, label: '重试', title: '重试免费或本地任务' }
    case 'resume-existing-provider-task':
      return {
        action: job.retryDisposition,
        label: '继续查询',
        title: '只继续查询已记录的 Provider 任务，不重新提交',
      }
    case 'paid-reconfirmation-required':
      return {
        action: job.retryDisposition,
        label: '重新预检',
        title: '回到对应工作台重新预检；不会在任务中心直接计费',
      }
    case 'manual-resolution':
      return {
        action: job.retryDisposition,
        label: '人工处理',
        title: '提交结果不明，必须先人工核对，禁止自动重提',
      }
    case 'not-retryable':
      return null
    default:
      return null
  }
}
