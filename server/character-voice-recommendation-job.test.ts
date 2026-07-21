import assert from 'node:assert/strict'
import test from 'node:test'

import {
  characterVoiceCatalogFingerprint,
  type CharacterVoiceCandidate,
} from './character-voice-recommendation.js'
import {
  CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE,
  createCharacterVoiceRecommendationHandler,
  type CharacterVoiceRecommendationJobInput,
} from './character-voice-recommendation-job.js'
import type { GenerationJobRecord, ManjuDatabase } from './database.js'
import type {
  MaterializedProviderExecutionProfile,
  ProviderService,
} from './providers/service.js'
import { JobExecutionError, type JobHandlerContext, type JobRecord } from './worker.js'

const voices: CharacterVoiceCandidate[] = [{
  voiceId: 'account-clone',
  voiceName: 'Account clone',
  descriptions: ['清晰、克制'],
  type: 'voice_cloning',
}]

function input(): CharacterVoiceRecommendationJobInput {
  const fingerprint = characterVoiceCatalogFingerprint(voices)
  return {
    episodeId: 'episode-1',
    characterId: 'ali',
    characterDatabaseId: 'character-db-1',
    expectedStoryRevisionId: 'story-revision-1',
    character: {
      id: 'ali',
      name: '阿离',
      role: '主角',
      storyDescription: '年轻剑客',
      visualDescription: '黑发红绳',
    },
    scenes: [{
      sceneId: 'scene-1',
      title: '断崖',
      timeOfDay: '黄昏',
      description: '龙吟响起',
      lines: [{ kind: 'dialogue', text: '它醒了。' }],
    }],
    catalog: {
      providerId: 'minimax-speech',
      providerConfigRevision: 3,
      model: 'speech-2.8-hd',
      observedAt: '2026-07-14T00:00:00.000Z',
      fingerprint,
      candidateFingerprint: fingerprint,
      voices,
    },
  }
}

function jobRecord(jobInput = input()): GenerationJobRecord {
  return {
    id: 'voice-recommend-job-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    pipelineRunId: null,
    type: CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE,
    status: 'running',
    progress: 0,
    resourceType: 'provider:text',
    resourceId: 'character-db-1',
    providerId: 'custom-text',
    model: 'text-model',
    providerConfigRevision: 7,
    externalTaskId: null,
    idempotencyKey: 'voice-recommend-job-1',
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

function dependencies(fetchImplementation: typeof fetch, calls: { materialize: number }) {
  const durable = jobRecord()
  const database = {
    getGenerationJob: () => durable,
    withSql: (operation: (sql: { get: () => Record<string, unknown> }) => unknown) => operation({
      get: () => ({
        source_revision_id: 'story-revision-1',
        character_database_id: 'character-db-1',
        character_id: 'ali',
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
      calls.materialize += 1
      return profile
    },
  } as unknown as ProviderService
  return { database, providerService, textCompatibleFetch: fetchImplementation }
}

test('recommendation checkpoints non-idempotent submission boundaries and returns the public output contract', async () => {
  let fetchCalls = 0
  const calls = { materialize: 0 }
  const fetchImplementation: typeof fetch = async () => {
    fetchCalls += 1
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        selectedVoiceId: 'account-clone',
        rationale: '符合角色克制气质。',
        profileTags: ['克制'],
        alternatives: [],
        defaultDelivery: { emotion: 'calm', speed: 1, pitch: 0 },
        sceneDirections: [],
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const checkpoints: Array<Record<string, unknown>> = []
  const context: JobHandlerContext = {
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    waitingForProvider: async (state) => {
      assert.ok(state && typeof state === 'object' && !Array.isArray(state))
      checkpoints.push(state as Record<string, unknown>)
    },
  }
  const handler = createCharacterVoiceRecommendationHandler(
    dependencies(fetchImplementation, calls),
  )
  const output = await handler({
    id: 'voice-recommend-job-1',
    type: CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE,
    status: 'running',
    projectId: 'project-1',
    input: input(),
  }, context)

  assert.equal(fetchCalls, 1)
  assert.equal(calls.materialize, 1)
  assert.deepEqual(checkpoints.map((checkpoint) => ({
    phase: checkpoint.phase,
    providerSupportsIdempotency: checkpoint.providerSupportsIdempotency,
    clientRequestId: checkpoint.clientRequestId,
  })), [
    { phase: 'submitting', providerSupportsIdempotency: false, clientRequestId: 'voice-recommend-job-1' },
    { phase: 'response-received', providerSupportsIdempotency: false, clientRequestId: 'voice-recommend-job-1' },
  ])
  assert.equal(output.characterId, 'ali')
  assert.equal((output.recommendation as Record<string, unknown>).selectedVoiceId, 'account-clone')
  assert.equal(JSON.stringify(output).includes('secret-never-public'), false)
})

test('a recovered ambiguous recommendation is failed closed before credential or Provider access', async () => {
  let fetchCalls = 0
  const calls = { materialize: 0 }
  const handler = createCharacterVoiceRecommendationHandler(dependencies(async () => {
    fetchCalls += 1
    throw new Error('must not fetch')
  }, calls))
  const recovered: JobRecord<CharacterVoiceRecommendationJobInput> = {
    id: 'voice-recommend-job-1',
    type: CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE,
    status: 'running',
    projectId: 'project-1',
    input: input(),
    providerState: {
      operation: CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE,
      phase: 'submitting',
      clientRequestId: 'voice-recommend-job-1',
      providerSupportsIdempotency: false,
    },
  }
  const context: JobHandlerContext = {
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    waitingForProvider: async () => undefined,
  }
  await assert.rejects(handler(recovered, context), (error: unknown) => (
    error instanceof JobExecutionError
    && error.code === 'VOICE_RECOMMENDATION_SUBMISSION_OUTCOME_UNKNOWN'
    && error.retryable === false
  ))
  assert.equal(calls.materialize, 0)
  assert.equal(fetchCalls, 0)
})
