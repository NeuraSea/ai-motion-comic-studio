import assert from 'node:assert/strict'
import test from 'node:test'

import type { GenerationJobRecord, ManjuDatabase } from './database.js'
import {
  createLinePerformanceRecommendationHandler,
  LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
  type LinePerformanceRecommendationJobInput,
} from './line-performance-job.js'
import type { MaterializedProviderExecutionProfile, ProviderService } from './providers/service.js'
import { JobExecutionError, type JobHandlerContext, type JobRecord } from './worker.js'

function input(): LinePerformanceRecommendationJobInput {
  return {
    projectId: 'project-1',
    episodeId: 'episode-1',
    databaseLineId: 'line-db-1',
    lineId: 'line-1',
    sourceRevisionId: 'story-r1',
    lineKind: 'dialogue',
    originalText: '不可能……十年了',
    performer: {
      scope: 'character',
      voiceProfileRevisionId: 'voice-r1',
      name: '阿离',
      role: '主角',
      storyDescription: '她寻找失踪十年的师父。',
      voiceDescription: '年轻、克制。',
    },
    scene: {
      id: 'scene-1',
      title: '旧宅重逢',
      timeOfDay: '夜',
      description: '阿离认出眼前的人。',
      shotDescription: '镜头缓慢推近。',
    },
    contextLines: [],
  }
}

function durable(jobInput = input()): GenerationJobRecord {
  return {
    id: 'director-job-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    pipelineRunId: null,
    type: LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
    status: 'running',
    progress: 0,
    resourceType: 'provider:text',
    resourceId: 'line-db-1',
    providerId: 'custom-text',
    model: 'text-model',
    providerConfigRevision: 7,
    externalTaskId: null,
    idempotencyKey: 'director-job-1',
    retryOf: null,
    attempt: 1,
    input: jobInput as unknown as GenerationJobRecord['input'],
    providerState: {},
    progressDetail: {},
    output: null,
    error: null,
    cost: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    startedAt: '2026-07-14T00:00:00.000Z',
    completedAt: null,
  }
}

function fixture(
  fetchImplementation: typeof fetch,
  options: { providerRevision?: number } = {},
) {
  const record = durable()
  let materializeCalls = 0
  const database = {
    getGenerationJob: () => record,
    getProviderConnection: () => ({
      id: 'custom-text',
      enabled: true,
      kind: 'text',
      configRevision: options.providerRevision ?? 7,
    }),
    withSql: (operation: (sql: { get: () => Record<string, unknown> }) => unknown) => operation({
      get: () => ({
        line_id: 'line-db-1',
        kind: 'dialogue',
        text: '不可能……十年了',
        line_metadata_json: JSON.stringify({ storyId: 'line-1' }),
        character_id: 'character-db-1',
        character_metadata_json: JSON.stringify({ voiceProfileRevisionId: 'voice-r1' }),
        source_revision_id: 'story-r1',
      }),
    }),
  } as unknown as ManjuDatabase
  const profile: MaterializedProviderExecutionProfile = {
    providerId: 'custom-text',
    configRevision: 7,
    kind: 'text',
    adapter: 'openai-compatible',
    baseUrl: 'https://text.example',
    model: 'text-model',
    authMode: 'byok',
    credentialRef: 'keychain://fixture',
    executionConfig: {},
    createdAt: '2026-07-14T00:00:00.000Z',
    apiKey: 'secret-never-public',
  }
  const providerService = {
    materializeExecutionProfile: async () => {
      materializeCalls += 1
      return profile
    },
  } as unknown as ProviderService
  return {
    dependencies: {
      database,
      providerService,
      textCompatibleFetch: fetchImplementation,
      resolveContext: () => input(),
    },
    materializeCalls: () => materializeCalls,
  }
}

function context(): JobHandlerContext {
  return {
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    waitingForProvider: async () => undefined,
  }
}

test('durable AI director makes exactly one structured provider request', async () => {
  let fetchCalls = 0
  const prepared = fixture(async (_url, init) => {
    fetchCalls += 1
    assert.equal(JSON.stringify(JSON.parse(String(init?.body))).includes('uniqueItems'), false)
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        lineId: 'line-1',
        emotion: 'surprised',
        speed: 0.82,
        pitch: 1,
        openingSoundTag: '(gasps)',
        pausePlan: [{ afterCharacter: 5, durationSeconds: 0.8 }],
        rationale: '先震惊吸气，再用长停顿表现十年重逢的难以置信。',
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const output = await createLinePerformanceRecommendationHandler(prepared.dependencies)({
    id: 'director-job-1',
    type: LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
    status: 'running',
    projectId: 'project-1',
    input: input(),
  }, context())
  assert.equal(fetchCalls, 1)
  assert.equal(prepared.materializeCalls(), 1)
  assert.equal(output.lineId, 'line-1')
  assert.equal((output.recommendation as Record<string, unknown>).openingSoundTag, '(gasps)')
})

test('provider rotation fails before credential materialization or billing', async () => {
  let fetchCalls = 0
  const prepared = fixture(async () => {
    fetchCalls += 1
    throw new Error('must not fetch')
  }, { providerRevision: 8 })
  await assert.rejects(
    createLinePerformanceRecommendationHandler(prepared.dependencies)({
      id: 'director-job-1',
      type: LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
      status: 'running',
      projectId: 'project-1',
      input: input(),
    }, context()),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === 'LINE_PERFORMANCE_PROVIDER_CHANGED',
  )
  assert.equal(prepared.materializeCalls(), 0)
  assert.equal(fetchCalls, 0)
})

test('cancel/recovery after an ambiguous non-idempotent submission never bills twice', async () => {
  let fetchCalls = 0
  const prepared = fixture(async () => {
    fetchCalls += 1
    throw new Error('must not fetch')
  })
  const recovered: JobRecord<LinePerformanceRecommendationJobInput> = {
    id: 'director-job-1',
    type: LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
    status: 'running',
    projectId: 'project-1',
    input: input(),
    providerState: {
      operation: LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
      phase: 'submitting',
      clientRequestId: 'director-job-1',
      providerSupportsIdempotency: false,
    },
  }
  await assert.rejects(
    createLinePerformanceRecommendationHandler(prepared.dependencies)(recovered, context()),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === 'LINE_PERFORMANCE_SUBMISSION_OUTCOME_UNKNOWN'
      && error.retryable === false,
  )
  assert.equal(prepared.materializeCalls(), 0)
  assert.equal(fetchCalls, 0)
})
