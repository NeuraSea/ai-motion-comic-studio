import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { KeychainCredentialSlot } from './keychain.js'
import { initializeDatabase, type ManjuDatabase } from './database.js'
import {
  ProviderService,
  type ProviderCredentialStore,
} from './providers/service.js'
import {
  SQLiteJobRepository,
  SQLiteProviderConnectionRepository,
  SQLiteRepositoryError,
  seedProviderCatalogConnections,
} from './repositories.js'
import type { JobErrorInfo } from './worker.js'

const RETRYABLE_ERROR: JobErrorInfo = {
  code: 'PROVIDER_TIMEOUT',
  message: 'provider timeout',
  retryable: true,
  category: 'timeout',
}

const PERMANENT_ERROR: JobErrorInfo = {
  code: 'INVALID_INPUT',
  message: 'invalid input',
  retryable: false,
  category: 'validation',
}

class MemoryVersionedKeychain implements ProviderCredentialStore {
  readonly values = new Map<string, string>()

  private key(slot: KeychainCredentialSlot): string {
    return `${slot.providerId}:${slot.credentialKind ?? 'api-key'}`
  }

  async get(slot: KeychainCredentialSlot): Promise<string | null> {
    return this.values.get(this.key(slot)) ?? null
  }

  async set(slot: KeychainCredentialSlot, secret: string): Promise<void> {
    this.values.set(this.key(slot), secret)
  }

  async delete(slot: KeychainCredentialSlot): Promise<boolean> {
    return this.values.delete(this.key(slot))
  }

  async exists(slot: KeychainCredentialSlot): Promise<boolean> {
    return this.values.has(this.key(slot))
  }
}

function fixture(): { database: ManjuDatabase; jobs: SQLiteJobRepository } {
  let sequence = 0
  let tick = 0
  const database = initializeDatabase({
    databasePath: ':memory:',
    legacyStatePath: false,
    idFactory: () => `generated-${++sequence}`,
    now: () => `2026-07-14T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  })
  database.createProject({ id: 'project-1', title: 'Repository Test' })
  const jobs = new SQLiteJobRepository(database, {
    defaultProjectId: 'project-1',
    now: () => `2026-07-14T01:00:${String(tick++).padStart(2, '0')}.000Z`,
  })
  return { database, jobs }
}

test('SQLiteJobRepository creates idempotently and maps scheduling metadata', async () => {
  const { database, jobs } = fixture()
  try {
    const first = await jobs.create({
      type: 'asset.image.generate',
      input: { prompt: 'mountain gate' },
      idempotencyKey: 'shot-1:image:v1',
      resourceKey: 'provider:image',
      providerId: 'codex-tools-image',
      model: 'gpt-image-2',
      providerConfigRevision: 1,
      metadata: { resourceId: 'shot-1' },
    })
    const duplicate = await jobs.create({
      type: 'asset.image.generate',
      input: { prompt: 'must not replace the original' },
      idempotencyKey: 'shot-1:image:v1',
    })

    assert.equal(first.created, true)
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.job.id, first.job.id)
    assert.deepEqual(duplicate.job.input, { prompt: 'mountain gate' })
    assert.equal(first.job.projectId, 'project-1')
    assert.equal(first.job.providerId, 'codex-tools-image')
    assert.equal(first.job.model, 'gpt-image-2')
    assert.equal(first.job.providerConfigRevision, 1)
    assert.equal(first.job.resourceKey, 'provider:image')
    assert.equal(database.getGenerationJob(first.job.id)?.resourceId, 'shot-1')
    assert.equal(database.getGenerationJob(first.job.id)?.providerConfigRevision, 1)
    assert.equal(database.listGenerationJobs({ projectId: 'project-1' }).length, 1)
  } finally {
    database.close()
  }
})

test('SQLiteJobRepository keeps retries linear, idempotent, and retryable-only', async () => {
  const { database, jobs } = fixture()
  try {
    const original = (await jobs.create({
      type: 'story.generate',
      input: { shotId: 'shot-1' },
      idempotencyKey: 'story:shot-1:v1',
      providerId: 'codex-tools-text',
      model: 'gpt-5.5',
      providerConfigRevision: 1,
    })).job
    await jobs.claim(original.id)
    await jobs.fail(original.id, RETRYABLE_ERROR)

    const retry = await jobs.retry(original.id, { idempotencyKey: 'retry-request-1' })
    const duplicateRetry = await jobs.retry(original.id, { idempotencyKey: 'another-request-id' })
    assert.equal(retry.created, true)
    assert.equal(duplicateRetry.created, false)
    assert.equal(duplicateRetry.job.id, retry.job.id)
    assert.equal(retry.job.retryOf, original.id)
    assert.equal(retry.job.attempt, 2)
    assert.equal(retry.job.projectId, original.projectId)
    assert.equal(retry.job.providerId, original.providerId)
    assert.equal(retry.job.model, original.model)
    assert.equal(retry.job.providerConfigRevision, original.providerConfigRevision)

    await jobs.claim(retry.job.id)
    await jobs.fail(retry.job.id, RETRYABLE_ERROR)
    const thirdAttempt = await jobs.retry(retry.job.id)
    assert.equal(thirdAttempt.job.retryOf, retry.job.id)
    assert.equal(thirdAttempt.job.attempt, 3)

    const permanent = (await jobs.create({
      type: 'story.generate',
      input: {},
      idempotencyKey: 'story:permanent',
    })).job
    await jobs.claim(permanent.id)
    await jobs.fail(permanent.id, PERMANENT_ERROR)
    await assert.rejects(
      jobs.retry(permanent.id),
      (error: unknown) => error instanceof SQLiteRepositoryError && error.code === 'JOB_NOT_RETRYABLE',
    )
  } finally {
    database.close()
  }
})

test('SQLiteJobRepository never creates generic retry children for paid non-video tasks', async () => {
  for (const type of ['dialogue.speech.generate', 'character.voice.preview', 'project.narrator.voice.preview']) {
    const { database, jobs } = fixture()
    try {
      const original = (await jobs.create({
        type,
        input: {},
        idempotencyKey: `${type}:original`,
        providerId: 'minimax-speech',
        model: 'speech-2.8-hd',
        providerConfigRevision: 1,
      })).job
      await jobs.claim(original.id)
      await jobs.fail(original.id, RETRYABLE_ERROR)
      const countBefore = database.listGenerationJobs({ projectId: 'project-1' }).length

      await assert.rejects(
        jobs.retry(original.id),
        (error: unknown) => error instanceof SQLiteRepositoryError
          && error.code === 'JOB_PAID_RECONFIRMATION_REQUIRED',
      )
      assert.equal(database.listGenerationJobs({ projectId: 'project-1' }).length, countBefore)
      assert.equal(database.listGenerationJobs({ projectId: 'project-1' })
        .some((job) => job.retryOf === original.id), false)
    } finally {
      database.close()
    }
  }
})

test('free LLM unknown-submission cancellation and retry errors never claim billing risk', async () => {
  const { database, jobs } = fixture()
  try {
    const original = (await jobs.create({
      type: 'story.generate',
      input: {},
      idempotencyKey: 'story:unknown-submission',
      providerId: 'codex-tools-text',
      model: 'gpt-5.5',
      providerConfigRevision: 1,
    })).job
    await jobs.claim(original.id)
    await jobs.markWaitingProvider(original.id, {
      operation: 'story.generate',
      phase: 'submitting',
      clientRequestId: original.id,
      providerSupportsIdempotency: false,
    })
    const cancelled = await jobs.cancel(original.id, {
      code: 'JOB_CANCELLED',
      message: '取消',
      retryable: false,
      category: 'cancelled',
    })
    assert.equal(cancelled?.status, 'failed')
    assert.equal(cancelled?.error?.code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
    assert.match(cancelled?.error?.message ?? '', /歧义结果|重复生成/)
    assert.doesNotMatch(cancelled?.error?.message ?? '', /计费|扣费|费用/)

    await assert.rejects(
      jobs.retry(original.id),
      (error: unknown) => error instanceof SQLiteRepositoryError
        && error.code === 'JOB_MANUAL_RESOLUTION_REQUIRED'
        && /歧义结果|重复生成/.test(error.message)
        && !/计费|扣费|费用/.test(error.message),
    )
  } finally {
    database.close()
  }
})

test('SQLiteJobRepository recovers interrupted work without resubmitting provider tasks', async () => {
  const { database, jobs } = fixture()
  try {
    const queued = (await jobs.create({
      type: 'story.generate',
      input: {},
      idempotencyKey: 'queued',
    })).job
    const interrupted = (await jobs.create({
      type: 'asset.image.generate',
      input: {},
      idempotencyKey: 'interrupted',
    })).job
    const providerWaiting = (await jobs.create({
      type: 'shot.video.generate',
      input: {},
      idempotencyKey: 'provider-waiting',
    })).job
    await jobs.claim(interrupted.id)
    await jobs.claim(providerWaiting.id)
    await jobs.markWaitingProvider(providerWaiting.id, {
      externalTaskId: 'seedance-task-123',
      pollAttempt: 4,
    })

    const recovered = await jobs.recoverRunnable()
    assert.deepEqual(new Set(recovered.map((job) => job.id)), new Set([
      queued.id,
      interrupted.id,
      providerWaiting.id,
    ]))
    assert.equal((await jobs.get(interrupted.id))?.status, 'queued')
    const waiting = await jobs.get(providerWaiting.id)
    assert.equal(waiting?.status, 'waiting_provider')
    assert.deepEqual(waiting?.providerState, {
      externalTaskId: 'seedance-task-123',
      pollAttempt: 4,
    })
  } finally {
    database.close()
  }
})

test('SQLiteJobRepository applies transitions atomically without terminal overwrites', async () => {
  const { database, jobs } = fixture()
  try {
    const cancelled = (await jobs.create({
      type: 'dialogue.speech.generate',
      input: ['line one', 'line two'],
      idempotencyKey: 'speech:cancelled',
    })).job
    await jobs.claim(cancelled.id)
    await jobs.updateProgress(cancelled.id, 40, { stage: 'synthesizing' })
    await jobs.cancel(cancelled.id, {
      code: 'JOB_CANCELLED',
      message: 'cancelled by user',
      retryable: false,
      category: 'cancelled',
    })
    assert.equal(await jobs.succeed(cancelled.id, { file: 'late.mp3' }), undefined)
    assert.equal((await jobs.get(cancelled.id))?.status, 'cancelled')

    const succeeded = (await jobs.create({
      type: 'timeline.preview.render',
      input: null,
      idempotencyKey: 'preview:succeeded',
    })).job
    await jobs.claim(succeeded.id)
    await jobs.succeed(succeeded.id, ['preview.mp4'])
    const cancelAfterSuccess = await jobs.cancel(succeeded.id, {
      code: 'JOB_CANCELLED',
      message: 'too late',
      retryable: false,
      category: 'cancelled',
    })
    assert.equal(cancelAfterSuccess?.status, 'succeeded')
    assert.deepEqual(cancelAfterSuccess?.output, ['preview.mp4'])
  } finally {
    database.close()
  }
})

test('SQLiteProviderConnectionRepository persists defaults, health, and Keychain references only', () => {
  const { database } = fixture()
  try {
    const providers = new SQLiteProviderConnectionRepository(database)
    providers.upsertProviderConnection('codex-tools-text', {
      enabled: true,
      isDefault: true,
    })
    providers.upsertProviderConnection('custom-text', {
      enabled: true,
      baseUrl: 'https://llm.example.test/v1',
      model: 'example-model',
      credentialRef: 'keychain://com.manju.test/custom-text%3Aapi-key',
      lastTestedAt: '2026-07-14T02:00:00.000Z',
      lastTestStatus: 'ok',
      lastTestMessage: 'connection succeeded',
    })
    const configuredRevision = database.getProviderConnection('custom-text')?.configRevision
    assert.equal(configuredRevision, 2)

    const selected = providers.setDefaultProvider('custom-text', 'text')
    assert.equal(selected.isDefault, true)
    assert.equal(providers.getProviderConnection('codex-tools-text')?.isDefault, false)
    assert.equal(selected.lastTestStatus, 'ok')
    assert.equal(selected.credentialRef, 'keychain://com.manju.test/custom-text%3Aapi-key')
    assert.deepEqual(database.getProviderConnection('custom-text')?.credentialReference, {
      service: 'com.manju.test',
      account: 'custom-text:api-key',
    })
    assert.deepEqual(database.getProviderConnection('custom-text')?.config, {
      isDefault: true,
      lastTestedAt: '2026-07-14T02:00:00.000Z',
      lastTestStatus: 'ok',
      lastTestMessage: 'connection succeeded',
    })
    assert.equal(database.getProviderConnection('custom-text')?.configRevision, configuredRevision)
    providers.upsertProviderConnection('custom-text', {
      lastTestedAt: '2026-07-14T03:00:00.000Z',
      lastTestStatus: 'degraded',
      lastTestMessage: 'rate limited',
    })
    assert.equal(database.getProviderConnection('custom-text')?.configRevision, configuredRevision)
    providers.upsertProviderConnection('custom-text', { model: 'example-model-v2' })
    assert.equal(database.getProviderConnection('custom-text')?.configRevision, configuredRevision! + 1)

    const customSpeechBefore = database.getProviderConnection('custom-speech')
    assert.throws(
      () => providers.upsertProviderConnection('custom-speech', {
        credentialRef: 'plaintext-provider-secret',
      }),
      (error: unknown) => error instanceof SQLiteRepositoryError
        && error.code === 'INVALID_CREDENTIAL_REFERENCE',
    )
    assert.deepEqual(database.getProviderConnection('custom-speech'), customSpeechBefore)
  } finally {
    database.close()
  }
})

test('catalog seeding is idempotent and a fresh database accepts the default Codex image provider FK', async () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'fresh-project', title: 'Fresh project' })
    const firstSeed = seedProviderCatalogConnections(database)
    assert.ok(firstSeed.some((provider) => provider.id === 'codex-tools-image'))
    assert.equal(database.getProviderConnection('codex-tools-image')?.config.isDefault, true)
    const firstCount = database.listProviderConnections().length

    database.updateProviderConnection('codex-tools-image', { defaultModel: 'user-selected-image-model' })
    const selectedRevision = database.getProviderConnection('codex-tools-image')?.configRevision
    seedProviderCatalogConnections(database)
    assert.equal(database.listProviderConnections().length, firstCount)
    assert.equal(database.getProviderConnection('codex-tools-image')?.defaultModel, 'user-selected-image-model')
    assert.equal(database.getProviderConnection('codex-tools-image')?.configRevision, selectedRevision)

    const jobs = new SQLiteJobRepository(database, { defaultProjectId: 'fresh-project' })
    const created = await jobs.create({
      type: 'asset.image.generate',
      input: { prompt: 'fresh image' },
      idempotencyKey: 'fresh:codex-image',
      providerId: 'codex-tools-image',
      model: 'user-selected-image-model',
      providerConfigRevision: selectedRevision,
    })
    assert.equal(created.created, true)
    assert.equal(created.job.providerId, 'codex-tools-image')
    assert.equal(created.job.providerConfigRevision, selectedRevision)
  } finally {
    database.close()
  }
})

test('jobs and retries keep an immutable Provider profile and Keychain slot across key rotation', async () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  const keychain = new MemoryVersionedKeychain()
  const oldSecret = 'old-provider-secret-never-in-sqlite'
  const newSecret = 'new-provider-secret-never-in-sqlite'
  try {
    database.createProject({ id: 'profile-project', title: 'Profile project' })
    const providers = new SQLiteProviderConnectionRepository(database)
    const service = new ProviderService({
      repository: providers,
      keychain,
      hasByoaCredential: async () => false,
      loadByoaCredential: async () => null,
    })
    const jobs = new SQLiteJobRepository(database, { defaultProjectId: 'profile-project' })

    const saved = await service.save('custom-text', {
      apiKey: oldSecret,
      baseUrl: 'https://text-v1.example.test/v1',
      model: 'text-model-v1',
      enabled: true,
    })
    assert.equal(saved.configRevision, 2)
    assert.equal(keychain.values.get('custom-text:api-key-r2'), oldSecret)
    const original = (await jobs.create({
      type: 'story.generate',
      input: { sourceText: 'immutable profile' },
      idempotencyKey: 'profile:original',
      providerId: 'custom-text',
      model: 'text-model-v1',
      providerConfigRevision: saved.configRevision,
    })).job
    await jobs.claim(original.id)
    await jobs.fail(original.id, RETRYABLE_ERROR)

    const rotated = await service.save('custom-text', {
      apiKey: newSecret,
      baseUrl: 'https://text-v2.example.test/v1',
      model: 'text-model-v2',
    })
    assert.equal(rotated.configRevision, 3)
    assert.equal(keychain.values.get('custom-text:api-key-r2'), oldSecret)
    assert.equal(keychain.values.get('custom-text:api-key-r3'), newSecret)

    const oldVersion = providers.getProviderConnectionVersion('custom-text', saved.configRevision)
    const newVersion = providers.getProviderConnectionVersion('custom-text', rotated.configRevision)
    assert.equal(oldVersion?.baseUrl, 'https://text-v1.example.test/v1')
    assert.equal(oldVersion?.model, 'text-model-v1')
    assert.match(oldVersion?.credentialRef ?? '', /api-key-r2/)
    assert.equal(newVersion?.baseUrl, 'https://text-v2.example.test/v1')
    assert.equal(newVersion?.model, 'text-model-v2')
    assert.match(newVersion?.credentialRef ?? '', /api-key-r3/)

    const oldExecution = await service.materializeExecutionProfile('custom-text', saved.configRevision)
    assert.equal(oldExecution.apiKey, oldSecret)
    assert.equal(oldExecution.baseUrl, oldVersion?.baseUrl)
    const retry = await jobs.retry(original.id, { idempotencyKey: 'profile:retry' })
    assert.equal(retry.job.providerId, 'custom-text')
    assert.equal(retry.job.model, 'text-model-v1')
    assert.equal(retry.job.providerConfigRevision, saved.configRevision)

    const deleted = await service.deleteCredential('custom-text')
    assert.equal(deleted.configRevision, 4)
    assert.equal(deleted.credentialState, 'missing')
    assert.equal(keychain.values.get('custom-text:api-key-r3'), newSecret)
    assert.equal(keychain.values.get('custom-text:api-key-r2'), oldSecret)
    assert.equal(
      (await service.materializeExecutionProfile('custom-text', saved.configRevision)).apiKey,
      oldSecret,
    )

    const safeDatabaseState = database.withSql((sql) => ({
      connection: sql.get(`SELECT * FROM provider_connections WHERE id = 'custom-text'`),
      versions: sql.all(`SELECT * FROM provider_connection_versions WHERE provider_id = 'custom-text'`),
      jobs: sql.all(`SELECT * FROM generation_jobs WHERE project_id = 'profile-project'`),
    }))
    for (const secret of [oldSecret, newSecret]) {
      assert.equal(JSON.stringify(safeDatabaseState).includes(secret), false)
      assert.equal(JSON.stringify([saved, rotated, deleted, oldVersion, newVersion]).includes(secret), false)
    }
  } finally {
    database.close()
  }
})
