import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  DialogueSpeechGenerationJob,
  GenerationJob,
} from '../src/lib/index.ts'
import {
  submitDialogueSpeechWithIdempotency,
  type SpeechGenerationIdempotencyRegistry,
} from '../src/features/voices/speech-generation-idempotency.ts'
import { reduceProjectJobs } from '../src/features/jobs/useProjectJobs.ts'

function speechJob(
  id: string,
  status: GenerationJob['status'] = 'queued',
): DialogueSpeechGenerationJob {
  return {
    id,
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'dialogue.speech.generate',
    status,
    progress: status === 'succeeded' ? 100 : 0,
    attempt: 1,
    input: { lineId: 'line-1' },
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: status === 'queued'
      ? '2026-07-15T00:00:00.000Z'
      : '2026-07-15T00:01:00.000Z',
  }
}

test('a failed jobs refresh replays the acknowledged speech POST with the same key and Job', async () => {
  const registry: SpeechGenerationIdempotencyRegistry = new Map()
  const serverJobsByKey = new Map<string, DialogueSpeechGenerationJob>()
  const submittedKeys: string[] = []
  let localJobs = new Map<string, GenerationJob>()
  let generatedKey = 0
  const createJob = async (key: string) => {
    submittedKeys.push(key)
    const existing = serverJobsByKey.get(key)
    if (existing) return existing
    const created = speechJob(`speech-job-${serverJobsByKey.size + 1}`)
    serverJobsByKey.set(key, created)
    return created
  }
  const rememberJob = (job: DialogueSpeechGenerationJob) => {
    localJobs = reduceProjectJobs(localJobs, { type: 'upsert', job })
  }
  const submit = () => submitDialogueSpeechWithIdempotency({
    registry,
    signature: 'episode-1:revision-1:line-1:same-settings',
    currentJobs: [...localJobs.values()],
    createJob,
    rememberJob,
    refreshJobs: async () => { throw new Error('jobs list unavailable') },
    keyFactory: () => `speech-key-${++generatedKey}`,
  })

  const first = await submit()
  const replay = await submit()

  assert.equal(first.refreshSynchronized, false)
  assert.equal(replay.refreshSynchronized, false)
  assert.deepEqual(submittedKeys, ['speech-key-1', 'speech-key-1'])
  assert.equal(serverJobsByKey.size, 1)
  assert.equal(replay.job.id, first.job.id)
  assert.equal(localJobs.size, 1)
  assert.equal(localJobs.get(first.job.id)?.status, 'queued')
})

test('an explicitly visible terminal speech Job allows a new synthesis key', async () => {
  const registry: SpeechGenerationIdempotencyRegistry = new Map()
  let localJobs = new Map<string, GenerationJob>()
  let generatedKey = 0
  const keys: string[] = []
  const rememberJob = (job: DialogueSpeechGenerationJob) => {
    localJobs = reduceProjectJobs(localJobs, { type: 'upsert', job })
  }
  const submit = () => submitDialogueSpeechWithIdempotency({
    registry,
    signature: 'same-terminal-regeneration-intent',
    currentJobs: [...localJobs.values()],
    createJob: async (key) => {
      keys.push(key)
      return speechJob(`speech-job-${keys.length}`)
    },
    rememberJob,
    refreshJobs: async () => [...localJobs.values()],
    keyFactory: () => `speech-key-${++generatedKey}`,
  })

  const first = await submit()
  localJobs = reduceProjectJobs(localJobs, {
    type: 'upsert',
    job: speechJob(first.job.id, 'succeeded'),
  })
  const deliberateRegeneration = await submit()

  assert.deepEqual(keys, ['speech-key-1', 'speech-key-2'])
  assert.notEqual(deliberateRegeneration.job.id, first.job.id)
})

test('a paid preflight lease mismatch is rejected before the speech POST', async () => {
  const registry: SpeechGenerationIdempotencyRegistry = new Map([
    ['speech-intent-1', { key: 'speech-key-original', acknowledgedJobId: null }],
  ])
  let createCalls = 0
  await assert.rejects(
    submitDialogueSpeechWithIdempotency({
      registry,
      signature: 'speech-intent-1',
      currentJobs: [],
      expectedIdempotencyKey: 'speech-key-drifted',
      createJob: async () => {
        createCalls += 1
        return speechJob('must-not-exist')
      },
      rememberJob: () => undefined,
      refreshJobs: async () => [],
    }),
    /幂等键已变化/,
  )
  assert.equal(createCalls, 0)
})
