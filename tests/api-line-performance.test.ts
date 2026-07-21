import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  createDialoguePerformanceRecommendation,
  deleteDialoguePerformanceProfile,
  getDialoguePerformanceProfile,
  getDialoguePerformanceRecommendationJob,
  putDialoguePerformanceProfile,
} from '../src/lib/api'

const NOW = '2026-07-14T08:00:00.000Z'

const recommendation = {
  version: 'line-performance-agent-v1' as const,
  lineId: 'line-1',
  emotion: 'fearful' as const,
  speed: 0.86,
  pitch: -1,
  openingSoundTag: '(inhale)',
  pausePlan: [{ afterCharacter: 4, durationSeconds: 0.35 }],
  rationale: '先压低声音，在转折前留出短暂呼吸。',
}

const queuedJob = {
  id: 'performance-job-1',
  projectId: 'project-1',
  episodeId: 'episode-1',
  type: 'dialogue.performance.recommend' as const,
  status: 'queued' as const,
  progress: 0,
  attempt: 1,
  input: {
    episodeId: 'episode-1',
    lineId: 'line-1',
    sourceRevisionId: 'story-revision-1',
    lineKind: 'dialogue' as const,
  },
  output: null,
  createdAt: NOW,
  updatedAt: NOW,
}

const profile = {
  ...recommendation,
  projectId: 'project-1',
  episodeId: 'episode-1',
  databaseLineId: 'line-db-1',
  revisionId: 'performance-revision-1',
  recommendationJobId: 'performance-job-1',
  sourceRevisionId: 'story-revision-1',
  voiceProfileRevisionId: null,
  updatedAt: NOW,
}

const stale = {
  speechAssets: 1,
  narrationLines: 0,
  exports: 1,
  exportAssets: 1,
  qualityReports: 1,
  pipelineRuns: 0,
}

test('line performance profile is read with explicit project and episode scope', async () => {
  const originalFetch = globalThis.fetch
  let captured = ''
  globalThis.fetch = (async (input) => {
    captured = String(input)
    return Response.json({ profile }, {
      headers: { ETag: 'W/"line-performance:line-db-1:performance-revision-1"' },
    })
  }) as typeof fetch
  try {
    const result = await getDialoguePerformanceProfile('line-1', 'project-1', 'episode-1')
    assert.equal(
      captured,
      '/api/v1/dialogue-lines/line-1/performance-profile?projectId=project-1&episodeId=episode-1',
    )
    assert.equal(result.profile?.revisionId, 'performance-revision-1')
    assert.equal(result.profile?.lineId, 'line-1')
    assert.equal(result.etag, 'W/"line-performance:line-db-1:performance-revision-1"')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('AI director directly creates a durable job with the exact body and idempotency key', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    return Response.json({ job: queuedJob }, { status: 202 })
  }) as typeof fetch
  try {
    const input = {
      projectId: 'project-1',
      episodeId: 'episode-1',
      textProviderId: 'openai-text',
    }
    const job = await createDialoguePerformanceRecommendation(
      'line-1',
      input,
      'performance-attempt-1',
    )
    assert.equal(job.id, 'performance-job-1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, '/api/v1/dialogue-lines/line-1/performance-recommendations')
    assert.equal(new Headers(calls[0]?.init.headers).get('Idempotency-Key'), 'performance-attempt-1')
    assert.equal(new Headers(calls[0]?.init.headers).get('x-manju-aigc-confirmation'), null)
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      projectId: 'project-1',
      episodeId: 'episode-1',
      textProviderId: 'openai-text',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('completed recommendation stays inert until confirmation references its durable job', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const succeeded = {
    ...queuedJob,
    status: 'succeeded',
    progress: 100,
    output: { lineId: 'line-1', recommendation },
  }
  const responses = [
    Response.json({ job: succeeded }),
    Response.json({ profile, stale }, {
      headers: { ETag: 'W/"line-performance:line-db-1:performance-revision-1"' },
    }),
    Response.json({ profile: null, revisionId: 'clear-revision-1', stale }, {
      headers: { ETag: 'W/"line-performance:line-db-1:clear-revision-1"' },
    }),
  ]
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    const response = responses.shift()
    assert.ok(response)
    return response
  }) as typeof fetch
  try {
    const job = await getDialoguePerformanceRecommendationJob(
      'performance-job-1',
      'line-1',
    )
    assert.equal(job.output?.recommendation.emotion, 'fearful')

    const confirmed = await putDialoguePerformanceProfile('line-1', {
      projectId: 'project-1',
      episodeId: 'episode-1',
      recommendationJobId: job.id,
      etag: 'W/"line-performance:line-db-1:none"',
    })
    assert.equal(confirmed.profile?.recommendationJobId, job.id)
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
      projectId: 'project-1',
      episodeId: 'episode-1',
      recommendationJobId: 'performance-job-1',
    })
    assert.equal(String(calls[1]?.init.body).includes('emotion'), false)
    assert.equal(String(calls[1]?.init.body).includes('pausePlan'), false)
    assert.equal(
      new Headers(calls[1]?.init.headers).get('If-Match'),
      'W/"line-performance:line-db-1:none"',
    )

    await deleteDialoguePerformanceProfile('line-1', {
      projectId: 'project-1',
      episodeId: 'episode-1',
      etag: confirmed.etag,
    })
    assert.equal(calls[2]?.init.method, 'DELETE')
    assert.equal(new Headers(calls[2]?.init.headers).get('If-Match'), confirmed.etag)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('client rejects a recommendation whose output is rebound to another line', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({
    job: {
      ...queuedJob,
      status: 'succeeded',
      progress: 100,
      output: {
        lineId: 'line-2',
        recommendation: { ...recommendation, lineId: 'line-2' },
      },
    },
  })) as typeof fetch
  try {
    await assert.rejects(
      getDialoguePerformanceRecommendationJob('performance-job-1', 'line-1'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
