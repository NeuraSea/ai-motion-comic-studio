import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationJob } from '../src/lib/index.js'
import { buildSeedanceGoldenAcceptanceState } from '../src/features/video/seedance-golden-acceptance-state.js'

function videoJob(input: {
  id: string
  shotId: string
  strategy: 'candidate' | 'baseline'
  status: GenerationJob['status']
  revision?: string
  errorCode?: string
}): GenerationJob {
  const revision = input.revision ?? 'story-r1'
  return {
    id: input.id,
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'shot.video.generate',
    status: input.status,
    progress: input.status === 'succeeded' ? 100 : 0,
    resourceId: input.shotId,
    providerId: 'seedance-video',
    model: 'seedance',
    providerConfigRevision: 1,
    externalTaskId: input.status === 'succeeded' ? `task-${input.id}` : null,
    attempt: 1,
    retryDisposition: 'fresh_preflight_required',
    input: {
      binding: { episodeId: 'episode-1', shotId: input.shotId, expectedRevisionId: revision },
      spec: {
        sourceRevisionId: revision,
        promptCompilerVersion: input.strategy === 'candidate'
          ? 'seedance-compact-v1'
          : 'seedance-verbose-baseline-v1',
      },
      ...(input.strategy === 'baseline' ? { publicationMode: 'evaluation_only' } : {}),
    },
    output: input.status === 'succeeded'
      ? { asset: { id: `asset-${input.id}` } }
      : null,
    error: input.errorCode ? {
      code: input.errorCode,
      message: 'failed',
      retryable: false,
      httpStatus: 403,
      providerCode: 'AccountOverdueError',
    } : null,
    createdAt: `2026-07-16T00:00:${input.id.endsWith('2') ? '02' : '01'}.000Z`,
    updatedAt: '2026-07-16T00:00:03.000Z',
  }
}

test('Golden acceptance exposes durable candidate, baseline, running and billing-failure state', () => {
  const state = buildSeedanceGoldenAcceptanceState({
    episodeId: 'episode-1',
    sourceRevisionId: 'story-r1',
    shots: [
      { shotId: 'sh0', code: 'S0-0' },
      { shotId: 'sh1', code: 'S0-1' },
      { shotId: 'sh2', code: 'S0-2' },
      { shotId: 'sh3', code: 'S0-3' },
    ],
    jobs: [
      videoJob({ id: 'candidate-1', shotId: 'sh0', strategy: 'candidate', status: 'succeeded' }),
      videoJob({ id: 'baseline-1', shotId: 'sh0', strategy: 'baseline', status: 'succeeded' }),
      videoJob({ id: 'candidate-2', shotId: 'sh1', strategy: 'candidate', status: 'succeeded' }),
      videoJob({ id: 'baseline-2', shotId: 'sh1', strategy: 'baseline', status: 'running' }),
      videoJob({ id: 'candidate-3', shotId: 'sh2', strategy: 'candidate', status: 'succeeded' }),
      videoJob({ id: 'baseline-3', shotId: 'sh2', strategy: 'baseline', status: 'failed', errorCode: 'PROVIDER_BILLING_UNAVAILABLE' }),
    ],
    currentProvider: { providerId: 'seedance-video', model: 'seedance', configRevision: 1 },
  })
  assert.equal(state.candidateReady, 3)
  assert.equal(state.historicalCandidateReady, 0)
  assert.equal(state.baselineReady, 1)
  assert.equal(state.baselineRunning, 1)
  assert.equal(state.baselineFailed, 1)
  assert.deepEqual(state.failures, [{
    code: 'PROVIDER_BILLING_UNAVAILABLE',
    providerCode: 'AccountOverdueError',
    httpStatus: 403,
    count: 1,
  }])
  assert.equal(state.pairSetReady, false)
  assert.equal(state.currentProviderCompatible, true)
  assert.deepEqual(state.items.map((item) => item.status), [
    'pair-ready',
    'baseline-running',
    'baseline-failed',
    'candidate-missing',
  ])
  assert.match(state.items[2]!.baselineError ?? '', /AccountOverdueError/)
})

test('Golden acceptance rejects old Story jobs and requires at least six complete pairs', () => {
  const shots = Array.from({ length: 6 }, (_, index) => ({ shotId: `sh${index}`, code: `S0-${index}` }))
  const jobs = shots.flatMap((shot, index) => [
    videoJob({ id: `candidate-${index}`, shotId: shot.shotId, strategy: 'candidate', status: 'succeeded' }),
    videoJob({ id: `baseline-${index}`, shotId: shot.shotId, strategy: 'baseline', status: 'succeeded' }),
    videoJob({ id: `old-${index}`, shotId: shot.shotId, strategy: 'baseline', status: 'succeeded', revision: 'story-old' }),
  ])
  const state = buildSeedanceGoldenAcceptanceState({
    episodeId: 'episode-1',
    sourceRevisionId: 'story-r1',
    shots,
    jobs,
    currentProvider: { providerId: 'seedance-video', model: 'seedance', configRevision: 1 },
  })
  assert.equal(state.candidateReady, 6)
  assert.equal(state.historicalCandidateReady, 0)
  assert.equal(state.baselineReady, 6)
  assert.equal(state.pairSetReady, true)
  assert.deepEqual(state.failures, [])
  assert.ok(state.items.every((item) => !item.baselineJobId?.startsWith('old-')))
})

test('Golden acceptance blocks a baseline after the executable Provider model or revision changes', () => {
  const shots = Array.from({ length: 6 }, (_, index) => ({ shotId: `sh${index}`, code: `S0-${index}` }))
  const jobs = shots.map((shot, index) => (
    videoJob({ id: `candidate-${index}`, shotId: shot.shotId, strategy: 'candidate', status: 'succeeded' })
  ))
  const state = buildSeedanceGoldenAcceptanceState({
    episodeId: 'episode-1',
    sourceRevisionId: 'story-r1',
    shots,
    jobs,
    currentProvider: { providerId: 'seedance-video', model: 'doubao-seedance-2.0', configRevision: 4 },
  })
  assert.equal(state.candidateReady, 0)
  assert.equal(state.historicalCandidateReady, 6)
  assert.equal(state.currentProviderCompatible, false)
  assert.match(state.providerMismatchReason ?? '', /Provider r4.*历史 Provider/)
})

test('Golden acceptance counts only current Provider candidates in a mixed migration set', () => {
  const shots = Array.from({ length: 6 }, (_, index) => ({ shotId: `sh${index}`, code: `S0-${index}` }))
  const jobs = shots.map((shot, index) => {
    const job = videoJob({
      id: `candidate-${index}`,
      shotId: shot.shotId,
      strategy: 'candidate',
      status: 'succeeded',
    })
    if (index < 2) {
      job.model = 'doubao-seedance-2.0'
      job.providerConfigRevision = 4
    }
    return job
  })
  const state = buildSeedanceGoldenAcceptanceState({
    episodeId: 'episode-1',
    sourceRevisionId: 'story-r1',
    shots,
    jobs,
    currentProvider: { providerId: 'seedance-video', model: 'doubao-seedance-2.0', configRevision: 4 },
  })
  assert.equal(state.candidateReady, 2)
  assert.equal(state.historicalCandidateReady, 4)
  assert.deepEqual(state.items.map((item) => item.status), [
    'baseline-missing',
    'baseline-missing',
    'candidate-missing',
    'candidate-missing',
    'candidate-missing',
    'candidate-missing',
  ])
  assert.match(state.providerMismatchReason ?? '', /只有 2\/6.*另有 4 镜/)
})

test('Golden acceptance does not double-count historical candidates on current-covered shots', () => {
  const shots = Array.from({ length: 6 }, (_, index) => ({ shotId: `sh${index}`, code: `S0-${index}` }))
  const historical = shots.map((shot, index) => (
    videoJob({
      id: `historical-${index}`,
      shotId: shot.shotId,
      strategy: 'candidate',
      status: 'succeeded',
    })
  ))
  const current = shots.slice(0, 2).map((shot, index) => {
    const job = videoJob({
      id: `current-${index}`,
      shotId: shot.shotId,
      strategy: 'candidate',
      status: 'succeeded',
    })
    job.model = 'doubao-seedance-2.0'
    job.providerConfigRevision = 4
    return job
  })
  const state = buildSeedanceGoldenAcceptanceState({
    episodeId: 'episode-1',
    sourceRevisionId: 'story-r1',
    shots,
    jobs: [...historical, ...current],
    currentProvider: { providerId: 'seedance-video', model: 'doubao-seedance-2.0', configRevision: 4 },
  })

  assert.equal(state.candidateReady, 2)
  assert.equal(state.historicalCandidateReady, 4)
  assert.ok(state.items.slice(0, 2).every((item) => item.historicalCandidateJobId !== null))
  assert.match(state.providerMismatchReason ?? '', /只有 2\/6.*另有 4 镜/)
})
