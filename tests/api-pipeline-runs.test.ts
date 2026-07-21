import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  cancelPipelineRun,
  createPipelineRun,
  getPipelineRun,
  listPipelineRuns,
  parsePipelineRun,
  preflightPipelineRun,
} from '../src/lib/api'

const NOW = '2026-07-14T00:00:00.000Z'
const PREFLIGHT_EXPIRES_AT = '2030-01-01T00:03:00.000Z'
const PREFLIGHT_EXPIRES_AT_EPOCH = Math.floor(Date.parse(PREFLIGHT_EXPIRES_AT) / 1_000)
const CONFIRMATION_TOKEN = `pfr1_${PREFLIGHT_EXPIRES_AT_EPOCH}_${'a'.repeat(64)}`

function pipelinePreflight() {
  return {
    version: 1,
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: 'story-revision-1',
    readyStoryboardCount: 2,
    missingStoryboardCount: 1,
    readySpeechCount: 3,
    missingSpeechCount: 1,
    hasPublishableAudio: true,
    billableStoryboardCount: 1,
    billableSpeechCount: 1,
    billableTargetCount: 2,
    imageProvider: {
      providerId: 'image-provider-1',
      configRevision: 3,
      model: 'gpt-image-1',
    },
    speechProvider: {
      providerId: 'minimax-speech',
      configRevision: 4,
      model: 'speech-2.6-hd',
    },
    speechProviders: [{
      providerId: 'minimax-speech',
      configRevision: 4,
      model: 'speech-2.6-hd',
    }],
    voiceSummary: {
      boundCharacterCount: 1,
      distinctVoiceCount: 1,
      sceneDirectedTargetCount: 1,
      characters: [{
        characterId: 'character-1',
        characterName: '阿离',
        voiceId: 'male-qn-qingse',
        voiceName: '青涩青年',
        providerId: 'minimax-speech',
        providerConfigRevision: 4,
        targetCount: 1,
        sceneDirectedTargetCount: 1,
      }],
    },
    blockers: [],
    canCreate: true,
    confirmationToken: CONFIRMATION_TOKEN,
    expiresAt: PREFLIGHT_EXPIRES_AT,
  }
}

function queuedPipelineRun(kenBurns = true) {
  return {
    id: 'pipeline-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: 'story-revision-1',
    status: 'queued',
    progress: 0,
    version: 1,
    mode: 'dynamic-comic',
    options: {
      resolution: '1080p',
      kenBurns,
      burnSubtitles: true,
      introTitle: true,
      outroCard: true,
      reviewWatermark: false,
      speechMode: 'auto',
    },
    bindings: {
      imageProvider: { providerId: 'image-provider-1', configRevision: 3, model: 'gpt-image-1' },
      speechTargets: [{
        targetId: 'line-1',
        publicLineId: 'story-line-1',
        sceneId: 'scene-1',
        characterId: 'character-1',
        characterDatabaseId: 'database-character-1',
        characterName: '阿离',
        voiceId: 'male-qn-qingse',
        voiceName: '青涩青年',
        voiceProfileRevisionId: 'voice-revision-1',
        catalogFingerprint: 'a'.repeat(64),
        provider: { providerId: 'minimax-speech', configRevision: 4, model: 'speech-2.6-hd' },
        speed: 0.95,
        pitch: 0,
        emotion: 'calm',
        sceneDirectionApplied: true,
      }],
    },
    targets: {
      storyboard: ['shot-1'],
      speech: ['line-1'],
    },
    steps: {
      storyboard: { status: 'pending', jobIds: [], completed: 0, total: 1 },
      speech: { status: 'pending', jobIds: [], completed: 0, total: 1 },
      timeline: { status: 'pending' },
      export: { status: 'pending' },
      quality: { status: 'pending' },
    },
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  }
}

function succeededPipelineRun() {
  return {
    ...queuedPipelineRun(),
    status: 'succeeded',
    progress: 100,
    steps: {
      storyboard: { status: 'succeeded', jobIds: ['image-job-1'], completed: 1, total: 1 },
      speech: { status: 'succeeded', jobIds: ['speech-job-1'], completed: 1, total: 1 },
      timeline: {
        status: 'succeeded',
        revisionId: 'timeline-revision-1',
        automaticEdit: {
          strategy: 'managed-dialogue-reflow-v1',
          executor: 'OpenCut-Classic/UpdateElementsCommand',
          planHash: 'b'.repeat(64),
          operationCount: 1,
          changedElementIds: ['dialogue-1'],
          planId: 'timeline-plan-1',
          applicationId: 'timeline-application-1',
        },
      },
      export: { status: 'succeeded', exportId: 'export-1', rootJobId: 'export-job-1' },
      quality: {
        status: 'succeeded',
        reportId: 'quality-1',
        rootJobId: 'quality-job-1',
        passed: true,
      },
    },
    completedAt: NOW,
  }
}

test('pipeline client binds preflight to the root idempotency key and validates its expiry', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ preflight: pipelinePreflight() }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const body = {
    projectId: 'project-1',
    resolution: '1080p' as const,
    kenBurns: false,
    burnSubtitles: true,
    introTitle: true,
    outroCard: true,
    reviewWatermark: false,
    speechMode: 'auto' as const,
    imageProviderId: 'image-provider-1',
  }

  try {
    const prepared = await preflightPipelineRun('episode-1', body, 'pipeline-attempt-1')
    assert.equal(prepared.confirmationToken, CONFIRMATION_TOKEN)
    assert.equal(prepared.expiresAt, PREFLIGHT_EXPIRES_AT)
    assert.equal(prepared.billableTargetCount, 2)
    assert.deepEqual(calls.map((call) => call.url), [
      '/api/v1/episodes/episode-1/pipeline-runs/preflight',
    ])
    const headers = new Headers(calls[0].init.headers)
    assert.equal(headers.get('Idempotency-Key'), 'pipeline-attempt-1')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), body)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pipeline client rejects a preflight whose public expiry does not match its signed token', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({
      preflight: {
        ...pipelinePreflight(),
        expiresAt: '2030-01-01T00:03:01.000Z',
      },
    }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    await assert.rejects(
      preflightPipelineRun('episode-1', {
        projectId: 'project-1',
        resolution: '1080p',
        kenBurns: true,
        burnSubtitles: true,
        introTitle: true,
        outroCard: true,
        reviewWatermark: false,
        speechMode: 'auto',
        imageProviderId: 'image-provider-1',
      }, 'pipeline-expiry-mismatch'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pipeline client creates once with confirmation and caller idempotency', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ pipelineRun: queuedPipelineRun(false) }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const body = {
    projectId: 'project-1',
    resolution: '1080p' as const,
    kenBurns: false,
    burnSubtitles: true,
    introTitle: true,
    outroCard: true,
    reviewWatermark: false,
    speechMode: 'auto' as const,
    imageProviderId: 'image-provider-1',
    confirmationToken: CONFIRMATION_TOKEN,
  }

  try {
    const run = await createPipelineRun('episode-1', body, 'pipeline-attempt-1')
    assert.equal(run.id, 'pipeline-1')
    assert.equal(run.options.kenBurns, false)
    assert.equal(run.bindings.imageProvider?.configRevision, 3)
    assert.deepEqual(calls.map((call) => call.url), [
      '/api/v1/episodes/episode-1/pipeline-runs',
    ])
    const headers = new Headers(calls[0].init.headers)
    assert.equal(headers.get('Idempotency-Key'), 'pipeline-attempt-1')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), body)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pipeline client rejects invalid preflight snapshots and missing confirmation locally', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({
      preflight: { ...pipelinePreflight(), billableTargetCount: 999 },
    }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const configuration = {
    projectId: 'project-1',
    resolution: '1080p' as const,
    kenBurns: true,
    burnSubtitles: true,
    introTitle: true,
    outroCard: true,
    reviewWatermark: false,
    speechMode: 'auto' as const,
    imageProviderId: 'image-provider-1',
  }

  try {
    await assert.rejects(
      preflightPipelineRun('episode-1', configuration, '   '),
      (error: unknown) => error instanceof ApiError
        && error.code === 'INVALID_IDEMPOTENCY_KEY',
    )
    await assert.rejects(
      preflightPipelineRun('episode-1', configuration, 'pipeline-attempt-invalid'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
    await assert.rejects(
      createPipelineRun('episode-1', {
        ...configuration,
        confirmationToken: '',
      }, 'pipeline-attempt-invalid'),
      (error: unknown) => error instanceof ApiError
        && error.code === 'PIPELINE_PREFLIGHT_REQUIRED',
    )
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pipeline client restores, polls, and cancels the same durable run', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const cancelled = {
    ...queuedPipelineRun(),
    status: 'cancelled',
    steps: {
      storyboard: { status: 'cancelled', jobIds: [], completed: 0, total: 1 },
      speech: { status: 'cancelled', jobIds: [], completed: 0, total: 1 },
      timeline: { status: 'cancelled' },
      export: { status: 'cancelled' },
      quality: { status: 'cancelled' },
    },
    error: { code: 'PIPELINE_CANCELLED', message: 'Pipeline run cancelled' },
    completedAt: NOW,
  }
  const responses = [
    { pipelineRuns: [queuedPipelineRun()] },
    { pipelineRun: succeededPipelineRun() },
    { pipelineRun: cancelled },
  ]
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(responses.shift()), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const restored = await listPipelineRuns({
      projectId: 'project-1',
      episodeId: 'episode-1',
      limit: 10,
    })
    assert.equal(restored[0]?.status, 'queued')
    assert.equal((await getPipelineRun('pipeline-1')).status, 'succeeded')
    assert.equal((await cancelPipelineRun('pipeline-1')).status, 'cancelled')
    assert.deepEqual(calls.map((call) => call.url), [
      '/api/v1/pipeline-runs?projectId=project-1&episodeId=episode-1&limit=10',
      '/api/v1/pipeline-runs/pipeline-1',
      '/api/v1/pipeline-runs/pipeline-1/cancel',
    ])
    assert.equal(calls[2].init.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[2].init.body)), {})
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pipeline parser rejects malformed version, five-step, provider, job, and terminal bindings', () => {
  const invalidValues = [
    { ...queuedPipelineRun(), version: 2 },
    {
      ...queuedPipelineRun(),
      steps: { ...queuedPipelineRun().steps, quality: undefined },
    },
    {
      ...queuedPipelineRun(),
      bindings: {},
    },
    {
      ...succeededPipelineRun(),
      steps: {
        ...succeededPipelineRun().steps,
        quality: {
          ...succeededPipelineRun().steps.quality,
          rootJobId: 'export-job-1',
        },
      },
    },
    {
      ...succeededPipelineRun(),
      sourceRevisionId: '',
    },
    {
      ...queuedPipelineRun(),
      steps: {
        ...queuedPipelineRun().steps,
        storyboard: {
          ...queuedPipelineRun().steps.storyboard,
          status: 'failed',
          error: {
            code: 'PIPELINE_CHILD_FAILED',
            message: 'child failed',
            step: 'storyboard',
            jobId: 'unbound-job',
          },
        },
      },
    },
    {
      ...succeededPipelineRun(),
      progress: 99,
    },
    {
      ...succeededPipelineRun(),
      steps: {
        ...succeededPipelineRun().steps,
        timeline: {
          ...succeededPipelineRun().steps.timeline,
          automaticEdit: {
            ...succeededPipelineRun().steps.timeline.automaticEdit,
            applicationId: undefined,
          },
        },
      },
    },
    {
      ...queuedPipelineRun(),
      completedAt: NOW,
    },
  ]

  for (const value of invalidValues) {
    assert.throws(
      () => parsePipelineRun(value),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  }
})

test('pipeline parser restores a stale DB run whose legacy invalidation path has no error payload', () => {
  const stale = {
    ...queuedPipelineRun(),
    status: 'stale',
    error: null,
    completedAt: NOW,
  }
  const parsed = parsePipelineRun(stale)
  assert.equal(parsed.status, 'stale')
  assert.equal(parsed.error, null)
  assert.equal(parsed.steps.storyboard.status, 'pending')
})

test('pipeline list rejects cross-episode records instead of adopting them into current UI state', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    pipelineRuns: [{ ...queuedPipelineRun(), episodeId: 'other-episode' }],
  }), { headers: { 'content-type': 'application/json' } })) as typeof fetch

  try {
    await assert.rejects(
      listPipelineRuns({ projectId: 'project-1', episodeId: 'episode-1' }),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pipeline client rejects an unwrapped run even when its inner fields look valid', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify(queuedPipelineRun()), {
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch

  try {
    await assert.rejects(
      getPipelineRun('pipeline-1'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
