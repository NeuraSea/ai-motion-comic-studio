import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import {
  assertNoConflictingShotVideoAttempts,
  ShotVideoBatchError,
} from './shot-video-batch.js'
import { SHOT_VIDEO_GENERATION_JOB_TYPE } from './shot-video-generation.js'
import {
  confirmShotVideoUnknownSubmissionNotCreated,
  parseShotVideoManualResolutionRequest,
  readShotVideoUnknownSubmissionResolution,
  ShotVideoManualResolutionError,
} from './shot-video-manual-resolution.js'
import type { JsonObject } from './types.js'

const databases: ManjuDatabase[] = []
const NOW = '2026-07-14T00:00:00.000Z'
const NOTE = '已核对绑定的 Neurasea Provider 历史控制台，确认没有可接管的视频任务。'

function fixture(): { database: ManjuDatabase; providerRevision: number } {
  const database = initializeDatabase({
    databasePath: ':memory:',
    legacyStatePath: false,
    backupDirectory: false,
    now: () => NOW,
  })
  databases.push(database)
  database.createProject({ id: 'project-a', title: '项目 A', createdAt: NOW, updatedAt: NOW })
  database.createProject({ id: 'project-b', title: '项目 B', createdAt: NOW, updatedAt: NOW })
  database.createRevision({
    id: 'source-revision-1',
    projectId: 'project-a',
    summary: '源剧本',
    snapshot: { version: 1 },
    createdAt: NOW,
  })
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
        style_preset, status, sort_order, created_at, updated_at, metadata_json,
        source_revision_id
      ) VALUES (
        'episode-1', 'project-a', '第一集', '', 30, '16:9', '', 'draft', 0,
        ?, ?, '{}', 'source-revision-1'
      )
    `, NOW, NOW)
  })
  const provider = database.createProviderConnection({
    id: 'seedance-video',
    kind: 'video',
    adapter: 'seedance',
    displayName: 'Seedance',
    baseUrl: 'https://ai.example.test',
    defaultModel: 'doubao-seedance-2-0-260128',
    authMode: 'byok',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  })
  return { database, providerRevision: provider.configRevision }
}

function createFailedJob(
  database: ManjuDatabase,
  providerRevision: number,
  options: { id?: string; errorCode?: string } = {},
) {
  return database.createGenerationJob({
    id: options.id ?? 'unknown-job',
    projectId: 'project-a',
    episodeId: 'episode-1',
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'failed',
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    providerConfigRevision: providerRevision,
    model: 'doubao-seedance-2-0-260128',
    input: {
      binding: {
        episodeId: 'episode-1',
        shotId: 'shot-1',
        sceneId: 'scene-1',
        databaseShotId: 'database-shot-1',
        expectedRevisionId: 'source-revision-1',
        expectedPreviousVideoAssetId: null,
      },
    },
    providerState: {
      operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
      phase: 'submitting',
      providerSupportsIdempotency: false,
    },
    error: {
      code: options.errorCode ?? 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
      message: '提交结果未知',
      retryable: false,
      category: 'provider',
    },
  })
}

function batch(shotId = 'shot-1') {
  return {
    projectId: 'project-a',
    episodeId: 'episode-1',
    sourceRevisionId: 'source-revision-1',
    targets: [{ shotId }],
  } as unknown as Parameters<typeof assertNoConflictingShotVideoAttempts>[1]
}

function isError(code: string) {
  return (error: unknown) => error instanceof ShotVideoManualResolutionError && error.code === code
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

test('confirmed-not-created creates one immutable audit, wraps the original error, and idempotently unlocks preflight', () => {
  const { database, providerRevision } = fixture()
  const job = createFailedJob(database, providerRevision)
  assert.throws(
    () => assertNoConflictingShotVideoAttempts(database, batch()),
    (error: unknown) => error instanceof ShotVideoBatchError
      && error.code === 'VIDEO_SUBMISSION_OUTCOME_UNKNOWN',
  )

  const first = confirmShotVideoUnknownSubmissionNotCreated(database, {
    jobId: job.id,
    projectId: 'project-a',
    resolution: 'confirmed-not-created',
    confirmedProviderConsoleChecked: true,
    note: NOTE,
  })
  assert.equal(first.idempotent, false)
  assert.equal(first.resolution.jobId, job.id)
  assert.equal(first.resolution.provider.baseUrl, 'https://ai.example.test')
  const durable = database.getGenerationJob(job.id)
  assert.equal(durable?.status, 'failed')
  assert.equal(durable?.error?.code, 'PROVIDER_SUBMISSION_CONFIRMED_NOT_CREATED')
  assert.equal((durable?.error?.originalError as JsonObject | undefined)?.code,
    'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(durable?.error?.auditRevisionId, first.resolution.auditRevisionId)
  assert.deepEqual(readShotVideoUnknownSubmissionResolution(database, durable!), first.resolution)
  assert.doesNotThrow(() => assertNoConflictingShotVideoAttempts(database, batch()))

  const revisionCount = database.listRevisions('project-a').length
  const repeated = confirmShotVideoUnknownSubmissionNotCreated(database, {
    jobId: job.id,
    projectId: 'project-a',
    resolution: 'confirmed-not-created',
    confirmedProviderConsoleChecked: true,
    note: NOTE,
  })
  assert.equal(repeated.idempotent, true)
  assert.equal(repeated.resolution.auditRevisionId, first.resolution.auditRevisionId)
  assert.equal(database.listRevisions('project-a').length, revisionCount)
  assert.throws(
    () => confirmShotVideoUnknownSubmissionNotCreated(database, {
      jobId: job.id,
      projectId: 'project-a',
      resolution: 'confirmed-not-created',
      confirmedProviderConsoleChecked: true,
      note: `${NOTE} 另一份备注。`,
    }),
    isError('VIDEO_UNKNOWN_SUBMISSION_RESOLUTION_CONFLICT'),
  )
})

test('cancelled accepted tasks stay isolated until the newest retry proves a Provider terminal state', () => {
  for (const lastStatus of ['failed', 'cancelled', 'expired', 'succeeded'] as const) {
    const { database, providerRevision } = fixture()
    const taskId = `accepted-task-${lastStatus}`
    const source = database.createGenerationJob({
      id: `cancelled-source-${lastStatus}`,
      projectId: 'project-a',
      episodeId: 'episode-1',
      type: SHOT_VIDEO_GENERATION_JOB_TYPE,
      status: 'cancelled',
      resourceType: 'provider:video',
      resourceId: 'shot-1',
      providerId: 'seedance-video',
      providerConfigRevision: providerRevision,
      model: 'doubao-seedance-2-0-260128',
      externalTaskId: taskId,
      input: {
        binding: {
          episodeId: 'episode-1',
          shotId: 'shot-1',
          sceneId: 'scene-1',
          databaseShotId: 'database-shot-1',
          expectedRevisionId: 'source-revision-1',
          expectedPreviousVideoAssetId: null,
        },
      },
      providerState: {
        operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
        phase: 'polling',
        externalTaskId: taskId,
        lastStatus: 'running',
        cancellationCapability: 'local-only',
        cancellationOutcome: 'unsupported',
      },
      error: {
        code: 'JOB_CANCELLED',
        message: '本地处理已停止',
        retryable: false,
        category: 'cancelled',
      },
    })

    assert.throws(
      () => assertNoConflictingShotVideoAttempts(database, batch()),
      (error: unknown) => error instanceof ShotVideoBatchError
        && error.code === 'VIDEO_GENERATION_ALREADY_ACTIVE',
      `cancelled ${lastStatus}`,
    )

    database.createGenerationJob({
      id: `terminal-child-${lastStatus}`,
      projectId: source.projectId,
      episodeId: source.episodeId,
      type: source.type,
      status: lastStatus === 'succeeded'
        ? 'succeeded'
        : lastStatus === 'cancelled' ? 'cancelled' : 'failed',
      resourceType: source.resourceType,
      resourceId: source.resourceId,
      providerId: source.providerId,
      providerConfigRevision: source.providerConfigRevision,
      model: source.model,
      externalTaskId: taskId,
      retryOf: source.id,
      attempt: 2,
      input: source.input,
      providerState: {
        operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
        phase: lastStatus === 'succeeded' ? 'completed' : 'polling',
        externalTaskId: taskId,
        lastStatus,
      },
      ...(lastStatus === 'succeeded'
        ? { output: { externalTaskId: taskId } }
        : {
            error: {
              code: lastStatus === 'cancelled' ? 'JOB_CANCELLED' : 'SEEDANCE_TASK_TERMINAL',
              message: 'Provider 已证明任务终止',
              retryable: lastStatus !== 'cancelled',
              category: lastStatus === 'cancelled' ? 'cancelled' : 'provider',
            },
          }),
    })

    assert.doesNotThrow(
      () => assertNoConflictingShotVideoAttempts(database, batch()),
      `terminal ${lastStatus}`,
    )
  }
})

test('manual resolution rejects cross-project, non-unknown, unconfirmed, and non-strict requests', () => {
  const { database, providerRevision } = fixture()
  const unknown = createFailedJob(database, providerRevision)
  const ordinary = createFailedJob(database, providerRevision, {
    id: 'ordinary-failure',
    errorCode: 'UPSTREAM_UNAVAILABLE',
  })

  assert.throws(
    () => confirmShotVideoUnknownSubmissionNotCreated(database, {
      jobId: unknown.id,
      projectId: 'project-b',
      resolution: 'confirmed-not-created',
      confirmedProviderConsoleChecked: true,
      note: NOTE,
    }),
    isError('JOB_NOT_FOUND'),
  )
  assert.throws(
    () => confirmShotVideoUnknownSubmissionNotCreated(database, {
      jobId: ordinary.id,
      projectId: 'project-a',
      resolution: 'confirmed-not-created',
      confirmedProviderConsoleChecked: true,
      note: NOTE,
    }),
    isError('VIDEO_UNKNOWN_SUBMISSION_NOT_RESOLVABLE'),
  )
  assert.throws(
    () => parseShotVideoManualResolutionRequest({
      projectId: 'project-a',
      resolution: 'confirmed-not-created',
      confirmedProviderConsoleChecked: false,
      note: NOTE,
    }),
    isError('INVALID_VIDEO_MANUAL_RESOLUTION'),
  )
  assert.throws(
    () => parseShotVideoManualResolutionRequest({
      projectId: 'project-a',
      resolution: 'confirmed-not-created',
      confirmedProviderConsoleChecked: true,
      note: NOTE,
      unexpected: true,
    }),
    isError('INVALID_VIDEO_MANUAL_RESOLUTION'),
  )
  assert.equal(readShotVideoUnknownSubmissionResolution(database, unknown), undefined)
})

test('a dangling or mismatched audit pointer keeps the unknown paid attempt locked', () => {
  const { database, providerRevision } = fixture()
  const job = createFailedJob(database, providerRevision)
  const confirmed = confirmShotVideoUnknownSubmissionNotCreated(database, {
    jobId: job.id,
    projectId: 'project-a',
    resolution: 'confirmed-not-created',
    confirmedProviderConsoleChecked: true,
    note: NOTE,
  })
  const resolvedJob = database.getGenerationJob(job.id)!

  const audit = database.getRevision(confirmed.resolution.auditRevisionId)!
  database.updateRevision(audit.id, {
    snapshot: { ...audit.snapshot, shotId: 'another-shot' },
  })
  assert.throws(
    () => assertNoConflictingShotVideoAttempts(database, batch()),
    (error: unknown) => error instanceof ShotVideoBatchError
      && error.code === 'VIDEO_SUBMISSION_OUTCOME_UNKNOWN',
  )
  database.updateRevision(audit.id, { snapshot: audit.snapshot })

  database.updateGenerationJob(job.id, {
    progressDetail: {
      ...resolvedJob.progressDetail,
      manualUnknownSubmissionResolution: {
        version: 1,
        auditRevisionId: 'source-revision-1',
        resolution: 'confirmed-not-created',
        resolvedAt: confirmed.resolution.resolvedAt,
      },
    },
  })
  assert.throws(
    () => assertNoConflictingShotVideoAttempts(database, batch()),
    (error: unknown) => error instanceof ShotVideoBatchError
      && error.code === 'VIDEO_SUBMISSION_OUTCOME_UNKNOWN',
  )

  database.updateGenerationJob(job.id, {
    progressDetail: {
      ...resolvedJob.progressDetail,
      manualUnknownSubmissionResolution: {
        version: 1,
        auditRevisionId: 'missing-audit-revision',
        resolution: 'confirmed-not-created',
        resolvedAt: confirmed.resolution.resolvedAt,
      },
    },
  })
  assert.throws(
    () => assertNoConflictingShotVideoAttempts(database, batch()),
    (error: unknown) => error instanceof ShotVideoBatchError
      && error.code === 'VIDEO_SUBMISSION_OUTCOME_UNKNOWN',
  )
})
