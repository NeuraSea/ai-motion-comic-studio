import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { GenerationJob, JobRetryDisposition } from '../src/lib'
import { jobRetryAction } from '../src/features/jobs/job-retry-action'

function failed(retryDisposition: JobRetryDisposition, retryable: boolean): GenerationJob {
  return {
    id: `job-${retryDisposition}`,
    projectId: 'project-1',
    type: 'fixture',
    status: 'failed',
    progress: 20,
    attempt: 1,
    input: {},
    error: { code: 'FIXTURE', message: 'fixture', retryable },
    retryDisposition,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:01.000Z',
  }
}

test('TaskCenter action labels come only from the server retry disposition', () => {
  assert.equal(jobRetryAction(failed('generic-free-retry', false))?.label, '重试')
  assert.equal(jobRetryAction(failed('resume-existing-provider-task', false))?.label, '继续查询')
  assert.equal(jobRetryAction(failed('paid-reconfirmation-required', true))?.label, '重新预检')
  assert.equal(jobRetryAction(failed('manual-resolution', true))?.label, '人工处理')
  assert.equal(jobRetryAction(failed('not-retryable', true)), null)
})

test('non-failed jobs never expose a retry action', () => {
  const running = { ...failed('generic-free-retry', true), status: 'running' as const }
  assert.equal(jobRetryAction(running), null)
})

test('a locally-cancelled Provider task only exposes the safe continue-query action', () => {
  const cancelled = {
    ...failed('resume-existing-provider-task', false),
    status: 'cancelled' as const,
  }
  assert.deepEqual(jobRetryAction(cancelled), {
    action: 'resume-existing-provider-task',
    label: '继续查询',
    title: '只继续查询已记录的 Provider 任务，不重新提交',
  })
  assert.equal(jobRetryAction({
    ...cancelled,
    retryDisposition: 'paid-reconfirmation-required',
  }), null)
})
