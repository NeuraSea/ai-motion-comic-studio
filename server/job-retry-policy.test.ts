import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import { jobHasUnknownSubmission, jobRetryDisposition } from './job-retry-policy.js'
import {
  SQLiteJobRepository,
  SQLiteRepositoryError,
} from './repositories.js'
import type { JobErrorInfo } from './worker.js'

const RETRYABLE_ERROR: JobErrorInfo = {
  code: 'UPSTREAM_TIMEOUT',
  message: '上游超时',
  retryable: true,
  category: 'timeout',
}

const CANCELLED_ERROR: JobErrorInfo = {
  code: 'JOB_CANCELLED',
  message: '本地处理已停止',
  retryable: false,
  category: 'cancelled',
}

function fixture(): { database: ManjuDatabase; jobs: SQLiteJobRepository } {
  let sequence = 0
  const database = initializeDatabase({
    databasePath: ':memory:',
    legacyStatePath: false,
    idFactory: () => `retry-policy-${++sequence}`,
  })
  database.createProject({ id: 'project-retry-policy', title: 'Retry policy' })
  return {
    database,
    jobs: new SQLiteJobRepository(database, { defaultProjectId: 'project-retry-policy' }),
  }
}

async function failedJob(
  jobs: SQLiteJobRepository,
  input: {
    type: string
    key: string
    providerId?: string
    model?: string
    providerConfigRevision?: number
    resourceKey?: string
    resourceId?: string
    error?: JobErrorInfo
  },
) {
  const created = (await jobs.create({
    type: input.type,
    input: {},
    idempotencyKey: input.key,
    providerId: input.providerId,
    model: input.model,
    providerConfigRevision: input.providerConfigRevision,
    resourceKey: input.resourceKey,
    metadata: input.resourceId ? { resourceId: input.resourceId } : undefined,
  })).job
  await jobs.claim(created.id)
  await jobs.fail(created.id, input.error ?? RETRYABLE_ERROR)
  return created
}

test('free LLM work uses generic retry and creates one linear child', async () => {
  const { database, jobs } = fixture()
  try {
    const source = await failedJob(jobs, {
      type: 'story.generate',
      key: 'free-story',
      providerId: 'codex-tools-text',
      model: 'gpt-5.5',
      providerConfigRevision: 1,
      resourceKey: 'provider:text',
    })
    assert.equal(
      jobRetryDisposition(database, database.getGenerationJob(source.id)!),
      'generic-free-retry',
    )
    const first = await jobs.retry(source.id, { idempotencyKey: 'free-story-retry' })
    const replay = await jobs.retry(source.id, { idempotencyKey: 'ignored-second-key' })
    assert.equal(first.created, true)
    assert.equal(replay.created, false)
    assert.equal(replay.job.id, first.job.id)
  } finally {
    database.close()
  }
})

test('image, edit, TTS, and voice previews require a new paid confirmation', async () => {
  const paidTypes = [
    'image.generate',
    'asset.image.generate',
    'asset.image.edit',
    'dialogue.speech.generate',
    'character.voice.preview',
    'project.narrator.voice.preview',
  ] as const
  for (const type of paidTypes) {
    const { database, jobs } = fixture()
    try {
      const image = type.includes('image')
      const source = await failedJob(jobs, {
        type,
        key: `paid-${type}`,
        providerId: image ? 'codex-tools-image' : 'minimax-speech',
        model: image ? 'gpt-image-2' : 'speech-2.8-hd',
        providerConfigRevision: 1,
      })
      assert.equal(
        jobRetryDisposition(database, database.getGenerationJob(source.id)!),
        'paid-reconfirmation-required',
        type,
      )
      await assert.rejects(
        jobs.retry(source.id),
        (error: unknown) => error instanceof SQLiteRepositoryError
          && error.code === 'JOB_PAID_RECONFIRMATION_REQUIRED',
      )
      assert.equal(database.listGenerationJobs({ projectId: 'project-retry-policy' }).length, 1)
    } finally {
      database.close()
    }
  }
})

test('Seedance retry only resumes a proven existing task and never creates a fresh POST attempt', async () => {
  const { database, jobs } = fixture()
  try {
    const withoutTask = await failedJob(jobs, {
      type: 'shot.video.generate',
      key: 'video-without-task',
      providerId: 'seedance-video',
      model: 'doubao-seedance-2-0-260128',
      providerConfigRevision: 1,
      resourceKey: 'provider:video',
      resourceId: 'shot-no-task',
    })
    assert.equal(
      jobRetryDisposition(database, database.getGenerationJob(withoutTask.id)!),
      'paid-reconfirmation-required',
    )
    await assert.rejects(
      jobs.retry(withoutTask.id),
      (error: unknown) => error instanceof SQLiteRepositoryError
        && error.code === 'JOB_PAID_RECONFIRMATION_REQUIRED',
    )

    const withTask = (await jobs.create({
      type: 'shot.video.generate',
      input: {},
      idempotencyKey: 'video-with-task',
      providerId: 'seedance-video',
      model: 'doubao-seedance-2-0-260128',
      providerConfigRevision: 1,
      resourceKey: 'provider:video',
      metadata: { resourceId: 'shot-with-task' },
    })).job
    await jobs.claim(withTask.id)
    await jobs.markWaitingProvider(withTask.id, {
      operation: 'shot.video.generate',
      phase: 'polling',
      externalTaskId: 'seedance-existing-task',
      lastStatus: 'running',
    })
    database.updateGenerationJob(withTask.id, { externalTaskId: 'seedance-existing-task' })
    await jobs.fail(withTask.id, RETRYABLE_ERROR)
    assert.equal(
      jobRetryDisposition(database, database.getGenerationJob(withTask.id)!),
      'resume-existing-provider-task',
    )
    const resumed = await jobs.retry(withTask.id)
    assert.equal(resumed.created, true)
    assert.equal(resumed.job.retryOf, withTask.id)

    const nonRetryablePoll = await failedJob(jobs, {
      type: 'shot.video.generate',
      key: 'video-non-retryable-poll',
      providerId: 'seedance-video',
      model: 'doubao-seedance-2-0-260128',
      providerConfigRevision: 1,
      resourceKey: 'provider:video',
      resourceId: 'shot-non-retryable-poll',
      error: {
        code: 'TASK_NOT_FOUND',
        message: '本次查询未找到任务，但 Provider 尚未证明终态',
        retryable: false,
        category: 'provider',
      },
    })
    database.updateGenerationJob(nonRetryablePoll.id, {
      externalTaskId: 'seedance-task-not-found-yet',
      providerState: {
        operation: 'shot.video.generate',
        phase: 'polling',
        externalTaskId: 'seedance-task-not-found-yet',
      },
    })
    assert.equal(
      jobRetryDisposition(database, database.getGenerationJob(nonRetryablePoll.id)!),
      'resume-existing-provider-task',
    )
    assert.equal((await jobs.retry(nonRetryablePoll.id)).created, true)
  } finally {
    database.close()
  }
})

test('cancelled Seedance work with a non-terminal accepted task only creates one polling child', async () => {
  for (const cancellationOutcome of [
    'unsupported',
    'requested',
    'task-not-found',
    'request-failed',
  ] as const) {
    const { database, jobs } = fixture()
    try {
      const source = (await jobs.create({
        type: 'shot.video.generate',
        input: {},
        idempotencyKey: `cancelled-video-${cancellationOutcome}`,
        providerId: 'seedance-video',
        model: 'doubao-seedance-2-0-260128',
        providerConfigRevision: 1,
        resourceKey: 'provider:video',
        metadata: { resourceId: `shot-cancelled-${cancellationOutcome}` },
      })).job
      await jobs.claim(source.id)
      await jobs.markWaitingProvider(source.id, {
        operation: 'shot.video.generate',
        phase: 'polling',
        externalTaskId: `provider-task-${cancellationOutcome}`,
        lastStatus: 'running',
      })
      database.updateGenerationJob(source.id, {
        externalTaskId: `provider-task-${cancellationOutcome}`,
      })
      await jobs.cancel(source.id, CANCELLED_ERROR)
      const cancelled = database.getGenerationJob(source.id)!
      database.updateGenerationJob(source.id, {
        providerState: {
          ...cancelled.providerState,
          cancellationCapability: cancellationOutcome === 'unsupported'
            ? 'local-only'
            : 'upstream-delete',
          cancellationOutcome,
        },
      })

      assert.equal(
        jobRetryDisposition(database, database.getGenerationJob(source.id)!),
        'resume-existing-provider-task',
        cancellationOutcome,
      )
      const first = await jobs.retry(source.id, {
        idempotencyKey: `resume-cancelled-${cancellationOutcome}`,
      })
      const replay = await jobs.retry(source.id, {
        idempotencyKey: `ignored-resume-${cancellationOutcome}`,
      })
      assert.equal(first.created, true)
      assert.equal(first.job.retryOf, source.id)
      assert.equal(replay.created, false)
      assert.equal(replay.job.id, first.job.id)
    } finally {
      database.close()
    }
  }
})

test('a newer terminal Provider checkpoint never revives an ancestor running checkpoint', async () => {
  for (const lastStatus of ['failed', 'cancelled', 'expired'] as const) {
    const { database, jobs } = fixture()
    try {
      const source = (await jobs.create({
        type: 'shot.video.generate',
        input: {},
        idempotencyKey: `terminal-source-${lastStatus}`,
        providerId: 'seedance-video',
        model: 'doubao-seedance-2-0-260128',
        providerConfigRevision: 1,
        resourceKey: 'provider:video',
        metadata: { resourceId: `terminal-shot-${lastStatus}` },
      })).job
      await jobs.claim(source.id)
      await jobs.markWaitingProvider(source.id, {
        operation: 'shot.video.generate',
        phase: 'polling',
        externalTaskId: `terminal-task-${lastStatus}`,
        lastStatus: 'running',
      })
      database.updateGenerationJob(source.id, { externalTaskId: `terminal-task-${lastStatus}` })
      await jobs.cancel(source.id, CANCELLED_ERROR)
      const child = await jobs.retry(source.id)
      await jobs.claim(child.job.id)
      await jobs.markWaitingProvider(child.job.id, {
        operation: 'shot.video.generate',
        phase: 'polling',
        externalTaskId: `terminal-task-${lastStatus}`,
        lastStatus,
      })
      database.updateGenerationJob(child.job.id, { externalTaskId: `terminal-task-${lastStatus}` })
      if (lastStatus === 'cancelled') await jobs.cancel(child.job.id, CANCELLED_ERROR)
      else await jobs.fail(child.job.id, RETRYABLE_ERROR)

      assert.notEqual(
        jobRetryDisposition(database, database.getGenerationJob(child.job.id)!),
        'resume-existing-provider-task',
        lastStatus,
      )
    } finally {
      database.close()
    }
  }
})

test('a retry child bound to a different Provider task id is corrupt, not terminal proof', async () => {
  const { database, jobs } = fixture()
  try {
    const source = (await jobs.create({
      type: 'shot.video.generate',
      input: {},
      idempotencyKey: 'task-id-mismatch-source',
      providerId: 'seedance-video',
      model: 'doubao-seedance-2-0-260128',
      providerConfigRevision: 1,
      resourceKey: 'provider:video',
      metadata: { resourceId: 'task-id-mismatch-shot' },
    })).job
    await jobs.claim(source.id)
    await jobs.markWaitingProvider(source.id, {
      operation: 'shot.video.generate',
      phase: 'polling',
      externalTaskId: 'original-provider-task',
      lastStatus: 'running',
    })
    database.updateGenerationJob(source.id, { externalTaskId: 'original-provider-task' })
    await jobs.cancel(source.id, CANCELLED_ERROR)
    const child = await jobs.retry(source.id)
    database.updateGenerationJob(child.job.id, {
      status: 'failed',
      externalTaskId: 'different-provider-task',
      providerState: {
        operation: 'shot.video.generate',
        phase: 'polling',
        externalTaskId: 'different-provider-task',
        lastStatus: 'failed',
      },
      error: {
        code: 'SEEDANCE_TASK_FAILED',
        message: '另一任务失败',
        retryable: true,
        category: 'provider',
      },
    })

    assert.equal(
      jobRetryDisposition(database, database.getGenerationJob(child.job.id)!),
      'manual-resolution',
    )
  } finally {
    database.close()
  }
})

test('an unknown submission outcome remains manual and cannot enter generic retry', async () => {
  const { database, jobs } = fixture()
  try {
    const source = (await jobs.create({
      type: 'shot.video.generate',
      input: {},
      idempotencyKey: 'video-unknown',
      providerId: 'seedance-video',
      model: 'doubao-seedance-2-0-260128',
      providerConfigRevision: 1,
      resourceKey: 'provider:video',
      metadata: { resourceId: 'shot-unknown' },
    })).job
    await jobs.claim(source.id)
    await jobs.markWaitingProvider(source.id, {
      operation: 'shot.video.generate',
      phase: 'submitting',
      clientRequestId: source.id,
    })
    await jobs.fail(source.id, {
      code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
      message: '提交结果不明',
      retryable: false,
      category: 'provider',
    })
    assert.equal(
      jobRetryDisposition(database, database.getGenerationJob(source.id)!),
      'manual-resolution',
    )
    await assert.rejects(
      jobs.retry(source.id),
      (error: unknown) => error instanceof SQLiteRepositoryError
        && error.code === 'JOB_MANUAL_RESOLUTION_REQUIRED',
    )

    const conflict = await failedJob(jobs, {
      type: 'shot.video.generate',
      key: 'video-task-conflict',
      providerId: 'seedance-video',
      model: 'doubao-seedance-2-0-260128',
      providerConfigRevision: 1,
      resourceKey: 'provider:video',
      resourceId: 'shot-conflict',
      error: {
        code: 'PROVIDER_TASK_CONFLICT',
        message: '上游任务归属冲突',
        retryable: true,
        category: 'provider',
      },
    })
    database.updateGenerationJob(conflict.id, {
      externalTaskId: 'conflicting-existing-task',
      providerState: {
        operation: 'shot.video.generate',
        phase: 'polling',
        externalTaskId: 'conflicting-existing-task',
        lastStatus: 'running',
      },
    })
    assert.equal(
      jobRetryDisposition(database, database.getGenerationJob(conflict.id)!),
      'manual-resolution',
    )
    await assert.rejects(
      jobs.retry(conflict.id),
      (error: unknown) => error instanceof SQLiteRepositoryError
        && error.code === 'JOB_MANUAL_RESOLUTION_REQUIRED',
    )
  } finally {
    database.close()
  }
})

test('legacy submitting STALE_AUDIO_TIMING without strict not-started evidence remains isolated', async () => {
  const { database, jobs } = fixture()
  try {
    const source = (await jobs.create({
      type: 'shot.video.generate',
      input: {},
      idempotencyKey: 'legacy-stale-audio-submitting',
      providerId: 'seedance-video',
      model: 'doubao-seedance-2-0-260128',
      providerConfigRevision: 1,
      resourceKey: 'provider:video',
      metadata: { resourceId: 'legacy-stale-shot' },
    })).job
    await jobs.claim(source.id)
    await jobs.markWaitingProvider(source.id, {
      operation: 'shot.video.generate',
      phase: 'submitting',
      providerSupportsIdempotency: false,
      clientRequestId: source.id,
    })
    await jobs.fail(source.id, {
      code: 'STALE_AUDIO_TIMING',
      message: '历史任务缺少 createTask 前的可验证证据',
      retryable: false,
      category: 'validation',
    })
    const terminal = database.getGenerationJob(source.id)!
    assert.equal(jobHasUnknownSubmission(database, terminal), true)
    assert.equal(jobRetryDisposition(database, terminal), 'manual-resolution')
    await assert.rejects(
      jobs.retry(source.id),
      (error: unknown) => error instanceof SQLiteRepositoryError
        && error.code === 'JOB_MANUAL_RESOLUTION_REQUIRED',
    )
  } finally {
    database.close()
  }
})

test('unreviewed and non-retryable free job types fail closed', async () => {
  const { database, jobs } = fixture()
  try {
    const unknown = await failedJob(jobs, { type: 'future.provider.generate', key: 'future' })
    const permanent = await failedJob(jobs, {
      type: 'story.generate',
      key: 'permanent-story',
      error: {
        code: 'INVALID_INPUT',
        message: '输入无效',
        retryable: false,
        category: 'validation',
      },
    })
    for (const job of [unknown, permanent]) {
      assert.equal(jobRetryDisposition(database, database.getGenerationJob(job.id)!), 'not-retryable')
      await assert.rejects(
        jobs.retry(job.id),
        (error: unknown) => error instanceof SQLiteRepositoryError
          && error.code === 'JOB_NOT_RETRYABLE',
      )
    }
  } finally {
    database.close()
  }
})
