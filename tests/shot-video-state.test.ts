import assert from 'node:assert/strict'
import test from 'node:test'

import type { GenerationJob } from '../src/lib'
import {
  resolveShotVideoViewState,
  shotVideoCreationBlockReason,
} from '../src/features/video/shot-video-state'

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'job-video-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'shot.video.generate',
    status: 'running',
    retryDisposition: 'not-retryable',
    progress: 42,
    resourceId: 'shot-1',
    attempt: 1,
    input: {
      binding: {
        episodeId: 'episode-1',
        shotId: 'shot-1',
        expectedRevisionId: 'revision-1',
      },
    },
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  }
}

const target = {
  episodeId: 'episode-1',
  shotId: 'shot-1',
  sourceRevisionId: 'revision-1',
}

test('shot video state recovers active and ready durable jobs', () => {
  assert.deepEqual(resolveShotVideoViewState([job()], target), {
    status: 'running',
    jobId: 'job-video-1',
    progress: 42,
    asset: null,
    error: null,
    retryable: false,
    manualReviewRequired: false,
  })

  const ready = resolveShotVideoViewState([job({
    status: 'succeeded',
    progress: 100,
    output: {
      asset: {
        id: 'asset-video-1',
        url: '/api/v1/assets/asset-video-1/content',
        mimeType: 'video/mp4',
        durationSeconds: 5,
      },
    },
  })], target)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.asset?.id, 'asset-video-1')
})

test('shot video state rejects another revision and marks durable stale results', () => {
  assert.equal(resolveShotVideoViewState([job()], {
    ...target,
    sourceRevisionId: 'revision-2',
  }).status, 'idle')

  const stale = resolveShotVideoViewState([job({
    status: 'succeeded',
    progress: 100,
    progressDetail: { stale: true },
    output: {
      asset: {
        id: 'asset-video-old',
        url: '/api/v1/assets/asset-video-old/content',
        mimeType: 'video/webm',
        durationSeconds: 4,
      },
    },
  })], target)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.asset?.id, 'asset-video-old')
})

test('shot video state exposes safe failed-job retryability without losing prior asset', () => {
  const prior = job({
    id: 'job-video-old',
    status: 'succeeded',
    progress: 100,
    output: {
      asset: {
        id: 'asset-video-old',
        url: '/api/v1/assets/asset-video-old/content',
        mimeType: 'video/mp4',
        durationSeconds: 5,
      },
    },
  })
  const failed = job({
    id: 'job-video-new',
    status: 'failed',
    createdAt: '2026-07-14T00:01:00.000Z',
    retryDisposition: 'resume-existing-provider-task',
    error: { code: 'UPSTREAM_TIMEOUT', message: '上游超时', retryable: true },
  })
  const state = resolveShotVideoViewState([prior, failed], target)
  assert.equal(state.status, 'failed')
  assert.equal(state.retryable, true)
  assert.equal(state.asset?.id, 'asset-video-old')
})

test('paid creation UX blocks active and unknown-outcome jobs on the same revision', () => {
  assert.match(shotVideoCreationBlockReason([job()], target) ?? '', /进行中/)
  assert.match(shotVideoCreationBlockReason([job({
    status: 'failed',
    retryDisposition: 'manual-resolution',
    error: {
      code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
      message: '上游提交结果未知',
      retryable: false,
    },
  })], target) ?? '', /重复计费/)
  const unknown = resolveShotVideoViewState([job({
    status: 'failed',
    retryDisposition: 'manual-resolution',
    providerConfigRevision: 2,
    error: {
      code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
      message: '请在方舟控制台核对',
      retryable: false,
    },
  })], target)
  assert.equal(unknown.manualReviewRequired, true)
  assert.match(unknown.error ?? '', /Provider r2/)
  assert.match(unknown.error ?? '', /供应商控制台/)
  assert.doesNotMatch(unknown.error ?? '', /方舟控制台/)
  assert.equal(shotVideoCreationBlockReason([job({ status: 'succeeded' })], target), null)
  assert.equal(shotVideoCreationBlockReason([job()], {
    ...target,
    sourceRevisionId: 'revision-2',
  }), null)
})

test('only a server-verified manual audit unlocks an unknown Seedance submission', () => {
  const wrappedError = {
    code: 'PROVIDER_SUBMISSION_CONFIRMED_NOT_CREATED',
    message: '已人工结案',
    retryable: false,
    originalError: {
      code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
      message: '提交结果未知',
      retryable: false,
    },
  } as GenerationJob['error']
  const unresolved = job({
    status: 'failed',
    retryDisposition: 'manual-resolution',
    providerId: 'seedance-video',
    providerConfigRevision: 2,
    model: 'doubao-seedance-2-0-260128',
    error: wrappedError,
  })
  assert.match(shotVideoCreationBlockReason([unresolved], target) ?? '', /重复计费/)
  assert.equal(resolveShotVideoViewState([unresolved], target).manualReviewRequired, true)

  const resolved = job({
    ...unresolved,
    retryDisposition: 'paid-reconfirmation-required',
    unknownSubmissionResolution: {
      version: 1,
      auditRevisionId: 'audit-1',
      jobId: 'job-video-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      expectedSourceRevisionId: 'revision-1',
      resolution: 'confirmed-not-created',
      confirmedProviderConsoleChecked: true,
      note: '已核对历史 Provider 控制台，确认没有对应任务。',
      resolvedAt: '2026-07-14T00:02:00.000Z',
      provider: {
        id: 'seedance-video',
        configRevision: 2,
        model: 'doubao-seedance-2-0-260128',
        baseUrl: 'https://ai.example.test',
      },
    },
  })
  assert.equal(shotVideoCreationBlockReason([resolved], target), null)
  const state = resolveShotVideoViewState([resolved], target)
  assert.equal(state.manualReviewRequired, false)
  assert.match(state.error ?? '', /可重新进行权威预检/)
})

test('cancelled NewAPI jobs say local processing stopped and preserve the billing warning', () => {
  const message = '已停止本地处理；当前 NewAPI 网关不支持取消上游任务，生成可能继续并产生费用。'
  const state = resolveShotVideoViewState([job({
    status: 'cancelled',
    retryDisposition: 'resume-existing-provider-task',
    error: {
      code: 'JOB_CANCELLED',
      message: '本地视频处理已停止',
      retryable: false,
    },
    cancellation: {
      localProcessing: 'stopped',
      upstreamCancellation: 'not-supported',
      providerTaskMayContinue: true,
      chargesMayStillApply: true,
      message,
    },
  })], target)

  assert.equal(state.status, 'cancelled')
  assert.equal(state.error, message)
  assert.equal(state.retryable, true)
  assert.doesNotMatch(state.error ?? '', /上游.*已取消/)
  assert.match(shotVideoCreationBlockReason([job({
    status: 'cancelled',
    retryDisposition: 'resume-existing-provider-task',
  })], target) ?? '', /继续查询|不能重复付费/)
})

test('a terminal retry leaf releases its cancelled ancestor in the creation guard', () => {
  const cancelled = job({
    id: 'cancelled-lineage-root',
    status: 'cancelled',
    retryDisposition: 'resume-existing-provider-task',
  })
  const succeeded = job({
    id: 'cancelled-lineage-child',
    retryOf: cancelled.id,
    status: 'succeeded',
    retryDisposition: 'not-retryable',
    createdAt: '2026-07-14T00:01:00.000Z',
    progress: 100,
    output: {
      asset: {
        id: 'recovered-video',
        url: '/api/v1/assets/recovered-video/content',
        mimeType: 'video/mp4',
        durationSeconds: 5,
      },
    },
  })

  assert.equal(shotVideoCreationBlockReason([cancelled, succeeded], target), null)
  assert.equal(resolveShotVideoViewState([cancelled, succeeded], target).status, 'ready')
})
