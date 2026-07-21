import assert from 'node:assert/strict'
import test from 'node:test'

import { getImageJobRetryAction } from '../src/features/storyboard/image-job-actions'

test('retryable image failures still require a new paid preflight', () => {
  assert.equal(getImageJobRetryAction({
    status: 'failed',
    error: { code: 'UPSTREAM_TIMEOUT', message: '超时', retryable: true },
  }), 'create')
})

test('an ambiguous non-retryable submission requires an explicit new attempt', () => {
  assert.equal(getImageJobRetryAction({
    status: 'failed',
    error: {
      code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
      message: '结果无法确认',
      retryable: false,
    },
  }), 'create')
})

test('active jobs are tracked while terminal jobs create a new version', () => {
  assert.equal(getImageJobRetryAction({ status: 'waiting_provider' }), 'track')
  assert.equal(getImageJobRetryAction({ status: 'succeeded' }), 'create')
  assert.equal(getImageJobRetryAction({ status: 'cancelled' }), 'create')
  assert.equal(getImageJobRetryAction(null), 'create')
})
