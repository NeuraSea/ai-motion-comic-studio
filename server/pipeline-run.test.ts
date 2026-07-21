import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import {
  PipelineRunCoordinator,
  PipelineRunError,
  parsePipelineRunDocument,
  type CreatePipelineRunRequest,
  type PipelineExportRequest,
  type PipelineFanoutSubmission,
  type PipelineQualityAuthorizationRequest,
  type PipelineQualityRequest,
  type PipelineRunPorts,
  type PipelineTimelineRequest,
} from './pipeline-run.js'

const NOW = '2026-07-14T10:00:00.000Z'

interface Fixture {
  database: ManjuDatabase
  request(
    idempotencyKey: string,
    storyboard?: string[],
    speech?: string[],
  ): CreatePipelineRunRequest
}

function fixture(): Fixture {
  let sequence = 0
  const database = initializeDatabase({
    databasePath: ':memory:',
    legacyStatePath: false,
    now: () => NOW,
    idFactory: () => `generated-${++sequence}`,
  })
  database.createProject({ id: 'project-1', title: 'Pipeline test' })
  database.createRevision({
    id: 'story-revision-1',
    projectId: 'project-1',
    summary: 'Story',
    snapshot: {},
  })
  database.withSql((sql) => sql.run(`
    INSERT INTO episodes (
      id, project_id, title, source_text, aspect_ratio, style_preset, status,
      sort_order, source_revision_id, created_at, updated_at
    ) VALUES (?, ?, ?, '', '16:9', '', 'draft', 0, ?, ?, ?)
  `, 'episode-1', 'project-1', 'Episode 1', 'story-revision-1', NOW, NOW))
  database.updateProject('project-1', {
    currentEpisodeId: 'episode-1',
    currentRevisionId: 'story-revision-1',
  })
  database.createProviderConnection({
    id: 'image-provider',
    kind: 'image',
    adapter: 'test',
    displayName: 'Test image',
    defaultModel: 'image-model-v1',
    authMode: 'none',
  })
  database.createProviderConnection({
    id: 'speech-provider',
    kind: 'speech',
    adapter: 'test',
    displayName: 'Test speech',
    defaultModel: 'speech-model-v1',
    authMode: 'none',
  })
  return {
    database,
    request(idempotencyKey, storyboard = [], speech = []) {
      return {
        projectId: 'project-1',
        episodeId: 'episode-1',
        sourceRevisionId: 'story-revision-1',
        idempotencyKey,
        options: {
          speechMode: speech.length > 0 ? 'auto' : 'skip',
          ...(speech.length > 0 ? { defaultVoiceId: 'voice-1' } : {}),
        },
        imageProvider: { providerId: 'image-provider' },
        speechProvider: { providerId: 'speech-provider' },
        targets: { storyboard, speech },
      }
    },
  }
}

interface PortHarness {
  ports: PipelineRunPorts
  setQuality(reportId: string, passed: boolean): void
  calls: {
    storyboard: PipelineFanoutSubmission[]
    speech: PipelineFanoutSubmission[]
    timeline: PipelineTimelineRequest[]
    export: PipelineExportRequest[]
    quality: PipelineQualityRequest[]
    authorizeQuality: PipelineQualityAuthorizationRequest[]
    enqueue: string[]
    cancel: string[]
  }
}

function portHarness(database: ManjuDatabase): PortHarness {
  const qualityResults = new Map<string, boolean>()
  const calls: PortHarness['calls'] = {
    storyboard: [],
    speech: [],
    timeline: [],
    export: [],
    quality: [],
    authorizeQuality: [],
    enqueue: [],
    cancel: [],
  }

  const fanout = (
    type: 'asset.image.generate' | 'dialogue.speech.generate',
    input: PipelineFanoutSubmission,
  ): { jobId: string } => {
    const job = database.createGenerationJob({
      id: randomUUID(),
      projectId: input.projectId,
      episodeId: input.episodeId,
      pipelineRunId: input.pipelineRunId,
      type,
      status: 'queued',
      providerId: input.provider.providerId,
      providerConfigRevision: input.provider.configRevision,
      model: input.provider.model,
      idempotencyKey: input.idempotencyKey,
      input: type === 'asset.image.generate'
        ? {
            storyboardBinding: {
              databaseShotId: input.targetId,
              expectedRevisionId: input.sourceRevisionId,
            },
            episodeBinding: {
              episodeId: input.episodeId,
              expectedRevisionId: input.sourceRevisionId,
            },
          }
        : {
            databaseLineId: input.targetId,
            episodeId: input.episodeId,
            expectedRevisionId: input.sourceRevisionId,
          },
    })
    return { jobId: job.id }
  }

  const ports: PipelineRunPorts = {
    submitStoryboard(input) {
      calls.storyboard.push(structuredClone(input))
      return fanout('asset.image.generate', input)
    },
    submitSpeech(input) {
      calls.speech.push(structuredClone(input))
      return fanout('dialogue.speech.generate', input)
    },
    materializeOrReconcile(input) {
      calls.timeline.push(structuredClone(input))
      const revisionId = `timeline-${input.sourceRevisionId}`
      const documentId = `timeline-document-${input.episodeId}`
      database.transaction(() => {
        database.withSql((sql) => sql.run(`
          INSERT OR IGNORE INTO timeline_documents (
            id, project_id, episode_id, current_revision_id, schema_version,
            upstream_commit, source_revision_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
        `,
        documentId,
        input.projectId,
        input.episodeId,
        revisionId,
        '0'.repeat(40),
        input.sourceRevisionId,
        NOW,
        NOW))
        database.withSql((sql) => sql.run(`
          INSERT OR IGNORE INTO timeline_document_revisions (
            id, document_id, project_id, episode_id, parent_revision_id,
            schema_version, upstream_commit, source_revision_id, summary,
            snapshot_json, created_at
          ) VALUES (?, ?, ?, ?, NULL, 1, ?, ?, 'test materialization', '{}', ?)
        `,
        revisionId,
        documentId,
        input.projectId,
        input.episodeId,
        '0'.repeat(40),
        input.sourceRevisionId,
        NOW))
      })
      return {
        revisionId,
        automaticEdit: {
          strategy: 'managed-dialogue-reflow-v1',
          executor: 'OpenCut-Classic/UpdateElementsCommand',
          planHash: 'a'.repeat(64),
          operationCount: 1,
          changedElementIds: ['dialogue-1'],
          planId: `plan-${input.pipelineRunId}`,
          applicationId: `application-${input.pipelineRunId}`,
        },
      }
    },
    createExport(input) {
      calls.export.push(structuredClone(input))
      const exportId = randomUUID()
      database.withSql((sql) => sql.run(`
        INSERT INTO exports (
          id, project_id, episode_id, status, timeline_snapshot_json,
          output_asset_id, specification_json, error_json, created_at,
          updated_at, completed_at, timeline_document_revision_id
        ) VALUES (?, ?, ?, 'queued', ?, NULL, ?, NULL, ?, ?, NULL, ?)
      `,
      exportId,
      input.projectId,
      input.episodeId,
      JSON.stringify({
        timelineRevisionId: input.timelineRevisionId,
        storyRevisionId: input.sourceRevisionId,
      }),
      JSON.stringify({
        timelineRevisionId: input.timelineRevisionId,
        storyRevisionId: input.sourceRevisionId,
      }),
      NOW,
      NOW,
      input.timelineRevisionId))
      const job = database.createGenerationJob({
        id: randomUUID(),
        projectId: input.projectId,
        episodeId: input.episodeId,
        pipelineRunId: input.pipelineRunId,
        type: 'export.render',
        status: 'queued',
        idempotencyKey: input.idempotencyKey,
        input: { exportId },
      })
      return { exportId, jobId: job.id }
    },
    createQuality(input) {
      calls.quality.push(structuredClone(input))
      const reportId = randomUUID()
      const outputAssetId = `output-${input.exportId}`
      const outputAssetChecksum = 'a'.repeat(64)
      database.withSql((sql) => sql.run(`
        INSERT INTO quality_reports (
          id, project_id, episode_id, export_id, status, checks_json,
          passed, created_at, completed_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, NULL)
      `,
      reportId,
      input.projectId,
      input.episodeId,
      input.exportId,
      JSON.stringify({
        version: 1,
        binding: {
          version: 1,
          exportId: input.exportId,
          outputAssetId,
          outputAssetChecksum,
          timelineRevisionId: `timeline-${input.sourceRevisionId}`,
          storyRevisionId: input.sourceRevisionId,
          exportSpecification: {},
          expected: {},
        },
        policy: {},
        checks: [],
        metrics: {},
        summary: { passed: null, failedChecks: 0, warningChecks: 0 },
      }),
      NOW))
      const job = database.createGenerationJob({
        id: randomUUID(),
        projectId: input.projectId,
        episodeId: input.episodeId,
        pipelineRunId: input.pipelineRunId,
        type: 'quality.check',
        status: 'queued',
        idempotencyKey: input.idempotencyKey,
        resourceType: 'quality.report',
        resourceId: reportId,
        input: {
          qualityReportId: reportId,
          exportId: input.exportId,
          outputAssetId,
          outputAssetChecksum,
        },
      })
      return { reportId, jobId: job.id }
    },
    authorizeQuality(input) {
      calls.authorizeQuality.push(structuredClone(input))
      if (qualityResults.get(input.reportId) !== true) {
        const error = new Error('The latest quality report did not pass') as Error & { code: string }
        error.code = 'QUALITY_CHECK_FAILED'
        throw error
      }
      return { passed: true }
    },
    enqueue(jobId) {
      calls.enqueue.push(jobId)
    },
    cancel(jobId) {
      calls.cancel.push(jobId)
      const job = database.getGenerationJob(jobId)
      if (job && !['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        database.updateGenerationJob(jobId, {
          status: 'cancelled',
          error: { code: 'PIPELINE_CANCELLED', message: 'cancelled' },
          completedAt: NOW,
        })
      }
    },
  }
  return {
    ports,
    calls,
    setQuality(reportId, passed) {
      qualityResults.set(reportId, passed)
    },
  }
}

function setJob(
  database: ManjuDatabase,
  id: string,
  status: 'running' | 'succeeded' | 'failed',
  progress: number,
): void {
  database.updateGenerationJob(id, {
    status,
    progress,
    ...(status === 'failed'
      ? { error: { code: 'TEST_FAILURE', message: 'child failed' }, completedAt: NOW }
      : status === 'succeeded' ? { completedAt: NOW } : {}),
  })
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

test('caller idempotency key reuses only the same request and different keys create new runs', (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports)

  const first = coordinator.create(value.request('request-a', ['shot-1']))
  const duplicate = coordinator.create(value.request('request-a', ['shot-1']))
  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.run.id, first.run.id)

  assert.throws(
    () => coordinator.create(value.request('request-a', ['shot-2'])),
    (error: unknown) => error instanceof PipelineRunError && error.code === 'IDEMPOTENCY_CONFLICT',
  )
  const independent = coordinator.create(value.request('request-b', ['shot-1']))
  assert.equal(independent.created, true)
  assert.notEqual(independent.run.id, first.run.id)
})

test('caller intent idempotency survives mutable discovery target changes', (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports)
  const firstRequest = value.request('intent-replay', ['shot-missing-before'])
  firstRequest.callerIntentFingerprint = 'stable-http-intent'
  const first = coordinator.create(firstRequest)
  const replay = value.request('intent-replay', [])
  replay.callerIntentFingerprint = 'stable-http-intent'

  const duplicate = coordinator.create(replay)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.run.id, first.run.id)
  assert.deepEqual(
    parsePipelineRunDocument(duplicate.run.steps).targets.storyboard,
    ['shot-missing-before'],
  )
  replay.callerIntentFingerprint = 'different-http-intent'
  assert.throws(
    () => coordinator.create(replay),
    (error: unknown) => error instanceof PipelineRunError && error.code === 'IDEMPOTENCY_CONFLICT',
  )
})

test('create rejects a source revision already stale for its episode', (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  value.database.createRevision({
    id: 'story-revision-2',
    projectId: 'project-1',
    parentRevisionId: 'story-revision-1',
    summary: 'new source',
    snapshot: {},
  })
  value.database.withSql((sql) => sql.run(
    'UPDATE episodes SET source_revision_id = ? WHERE id = ?',
    'story-revision-2',
    'episode-1',
  ))
  const coordinator = new PipelineRunCoordinator(value.database, portHarness(value.database).ports)
  assert.throws(
    () => coordinator.create(value.request('known-stale')),
    (error: unknown) => error instanceof PipelineRunError && error.code === 'STALE_SOURCE_REVISION',
  )
  assert.equal(value.database.listPipelineRuns({ limit: 10 }).length, 0)
})

test('automatic speech with targets requires a frozen default voice', (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports)
  const request = value.request('voice-required', [], ['line-1'])
  delete request.options?.defaultVoiceId

  assert.throws(
    () => coordinator.create(request),
    (error: unknown) => error instanceof PipelineRunError && error.code === 'DEFAULT_VOICE_REQUIRED',
  )
})

test('idempotent event kicks derive progress from child jobs and finish only after passing QC', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })
  const created = coordinator.create(value.request(
    'full-run',
    ['shot-1', 'shot-2'],
    ['line-1'],
  ))

  const firstKick = coordinator.kick(created.run.id)
  const duplicateKick = coordinator.kick(created.run.id)
  assert.equal(duplicateKick, firstKick)
  await firstKick
  await coordinator.kick(created.run.id)
  assert.equal(harness.calls.storyboard.length, 0)
  assert.equal(harness.calls.speech.length, 1)

  let document = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  const [speech] = document.steps.speech.jobIds
  setJob(value.database, speech, 'running', 20)
  const progressRun = await coordinator.kick(created.run.id)
  assert.ok(progressRun && progressRun.progress > 0 && progressRun.progress < 50)
  assert.equal(harness.calls.storyboard.length, 0)

  setJob(value.database, speech, 'succeeded', 100)
  await coordinator.kick(created.run.id)
  document = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  const [storyboardOne, storyboardTwo] = document.steps.storyboard.jobIds
  assert.equal(harness.calls.storyboard.length, 2)
  setJob(value.database, storyboardOne, 'succeeded', 100)
  setJob(value.database, storyboardTwo, 'running', 40)
  await coordinator.kick(created.run.id)

  setJob(value.database, storyboardTwo, 'succeeded', 100)
  await coordinator.kick(created.run.id)
  document = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  assert.equal(document.steps.timeline.status, 'succeeded')
  assert.equal(document.steps.timeline.automaticEdit?.planId, `plan-${created.run.id}`)
  assert.equal(
    document.steps.timeline.automaticEdit?.applicationId,
    `application-${created.run.id}`,
  )
  assert.equal(document.steps.export.status, 'running')
  assert.equal(harness.calls.timeline.length, 1)
  assert.equal(harness.calls.export.length, 1)

  setJob(value.database, document.steps.export.rootJobId!, 'succeeded', 100)
  await coordinator.notifyJobChanged(document.steps.export.rootJobId!)
  document = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  assert.equal(document.steps.quality.status, 'running')
  assert.equal(harness.calls.quality.length, 1)

  setJob(value.database, document.steps.quality.rootJobId!, 'succeeded', 100)
  harness.setQuality(document.steps.quality.reportId!, true)
  const completed = await coordinator.notifyJobChanged(document.steps.quality.rootJobId!)
  assert.equal(completed?.status, 'succeeded')
  assert.equal(completed?.progress, 100)
  assert.equal(parsePipelineRunDocument(completed!.steps).steps.quality.passed, true)
})

test('restart recovery resumes a partially persisted fanout without duplicating its first child', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const firstHarness = portHarness(value.database)
  const originalSubmit = firstHarness.ports.submitStoryboard
  firstHarness.ports.submitStoryboard = (input) => {
    if (input.targetIndex === 1) throw new Error('simulated process interruption')
    return originalSubmit(input)
  }
  const firstCoordinator = new PipelineRunCoordinator(value.database, firstHarness.ports)
  const created = firstCoordinator.create(value.request('recover-fanout', ['shot-1', 'shot-2']))
  await assert.rejects(() => firstCoordinator.kick(created.run.id), /simulated process interruption/)

  let document = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  assert.equal(document.steps.storyboard.jobIds.length, 1)
  const firstJobId = document.steps.storyboard.jobIds[0]

  const restartedHarness = portHarness(value.database)
  const restarted = new PipelineRunCoordinator(value.database, restartedHarness.ports)
  await restarted.recover()
  document = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  assert.deepEqual(document.steps.storyboard.jobIds.slice(0, 1), [firstJobId])
  assert.equal(document.steps.storyboard.jobIds.length, 2)
  assert.equal(restartedHarness.calls.storyboard.length, 1)
  assert.equal(restartedHarness.calls.storyboard[0].targetId, 'shot-2')
  assert.ok(restartedHarness.calls.enqueue.includes(firstJobId))
})

test('v1 recovery preserves an existing storyboard child but gates new storyboard spend on speech', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const legacyHarness = portHarness(value.database)
  const creator = new PipelineRunCoordinator(value.database, legacyHarness.ports, { now: () => NOW })
  const created = creator.create(value.request(
    'recover-legacy-storyboard-first',
    ['shot-1', 'shot-2'],
    ['line-1'],
  ))
  const legacyDocument = parsePipelineRunDocument(created.run.steps)
  const imageProvider = legacyDocument.bindings.imageProvider!
  const targetId = legacyDocument.targets.storyboard[0]
  const legacyStoryboardKey = `pipeline:${created.run.id}:storyboard:0:${createHash('sha256')
    .update(targetId)
    .digest('hex')
    .slice(0, 20)}`
  const legacyStoryboard = await legacyHarness.ports.submitStoryboard({
    pipelineRunId: created.run.id,
    projectId: created.run.projectId,
    episodeId: created.run.episodeId!,
    sourceRevisionId: legacyDocument.sourceRevisionId,
    targetId,
    targetIndex: 0,
    idempotencyKey: legacyStoryboardKey,
    provider: imageProvider,
    options: legacyDocument.options,
  })
  legacyDocument.steps.storyboard = {
    status: 'running',
    jobIds: [legacyStoryboard.jobId],
    completed: 0,
    total: legacyDocument.targets.storyboard.length,
  }
  value.database.withSql((sql) => sql.run(
    `UPDATE pipeline_runs
        SET status = 'running', steps_json = ?
      WHERE id = ?`,
    JSON.stringify(legacyDocument),
    created.run.id,
  ))

  const restartedHarness = portHarness(value.database)
  const restarted = new PipelineRunCoordinator(value.database, restartedHarness.ports, { now: () => NOW })
  await restarted.recover()

  let recovered = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  assert.deepEqual(recovered.steps.storyboard.jobIds, [legacyStoryboard.jobId])
  assert.equal(restartedHarness.calls.storyboard.length, 0)
  assert.equal(restartedHarness.calls.speech.length, 1)
  assert.ok(restartedHarness.calls.enqueue.includes(legacyStoryboard.jobId))

  const speechJobId = recovered.steps.speech.jobIds[0]
  setJob(value.database, speechJobId, 'succeeded', 100)
  await restarted.kick(created.run.id)

  recovered = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  assert.equal(restartedHarness.calls.storyboard.length, 1)
  assert.equal(restartedHarness.calls.storyboard[0].targetId, 'shot-2')
  assert.deepEqual(recovered.steps.storyboard.jobIds.slice(0, 1), [legacyStoryboard.jobId])
  assert.equal(recovered.steps.storyboard.jobIds.length, 2)
})

test('cancel wins while timeline materialization is in flight and prevents export creation', { timeout: 2_000 }, async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const originalMaterialize = harness.ports.materializeOrReconcile
  const entered = deferred()
  const release = deferred()
  harness.ports.materializeOrReconcile = async (input) => {
    entered.resolve()
    await release.promise
    return originalMaterialize(input)
  }
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })
  const created = coordinator.create(value.request('cancel-during-timeline'))

  const kick = coordinator.kick(created.run.id)
  await entered.promise
  const cancellation = coordinator.cancel(created.run.id, 'user cancelled during timeline')
  release.resolve()
  await Promise.all([kick, cancellation])

  const run = value.database.getPipelineRun(created.run.id)!
  assert.equal(run.status, 'cancelled')
  assert.equal(harness.calls.export.length, 0)
  assert.equal(parsePipelineRunDocument(run.steps).steps.timeline.status, 'cancelled')
})

test('a cross-process stale write cannot be resurrected by a returning timeline port', { timeout: 2_000 }, async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const originalMaterialize = harness.ports.materializeOrReconcile
  const entered = deferred()
  const release = deferred()
  harness.ports.materializeOrReconcile = async (input) => {
    entered.resolve()
    await release.promise
    return originalMaterialize(input)
  }
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })
  const created = coordinator.create(value.request('external-stale-during-timeline'))
  const kick = coordinator.kick(created.run.id)
  await entered.promise
  value.database.updatePipelineRun(created.run.id, {
    status: 'stale',
    error: { code: 'STALE_SOURCE_REVISION', message: 'external writer marked stale' },
    completedAt: NOW,
  })
  release.resolve()
  await kick

  assert.equal(value.database.getPipelineRun(created.run.id)?.status, 'stale')
  assert.equal(harness.calls.export.length, 0)
})

test('termination cancels every durable child including an orphan absent from steps JSON', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })
  const created = coordinator.create(value.request('cancel-orphan'))
  const orphan = value.database.createGenerationJob({
    projectId: 'project-1',
    episodeId: 'episode-1',
    pipelineRunId: created.run.id,
    type: 'orphan.test',
    status: 'queued',
    idempotencyKey: 'orphan-child',
    input: {},
  })

  await coordinator.cancel(created.run.id)
  assert.ok(harness.calls.cancel.includes(orphan.id))
  assert.equal(value.database.getGenerationJob(orphan.id)?.status, 'cancelled')
})

test('recovery sweeps active children of a parent already made terminal by SQL invalidation', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })
  const created = coordinator.create(value.request('stale-before-restart'))
  const child = value.database.createGenerationJob({
    projectId: 'project-1',
    episodeId: 'episode-1',
    pipelineRunId: created.run.id,
    type: 'asset.image.generate',
    status: 'queued',
    idempotencyKey: 'stale-orphan',
    input: {},
  })
  value.database.updatePipelineRun(created.run.id, {
    status: 'stale',
    error: { code: 'STALE_SOURCE_REVISION', message: 'story changed' },
    completedAt: NOW,
  })

  await coordinator.recover()
  assert.equal(value.database.getGenerationJob(child.id)?.status, 'cancelled')
  assert.ok(harness.calls.cancel.includes(child.id))
  assert.ok(!harness.calls.enqueue.includes(child.id))
})

test('a synchronously failed speech child prevents creating the storyboard branch', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const original = harness.ports.submitSpeech
  harness.ports.submitSpeech = async (input) => {
    const result = await original(input)
    setJob(value.database, result.jobId, 'failed', 5)
    return result
  }
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })
  const created = coordinator.create(value.request(
    'stop-cross-fanout',
    ['shot-1', 'shot-2'],
    ['line-1'],
  ))

  const run = await coordinator.kick(created.run.id)
  assert.equal(run?.status, 'failed')
  assert.equal(harness.calls.speech.length, 1)
  assert.equal(harness.calls.storyboard.length, 0)
  assert.equal(parsePipelineRunDocument(run!.steps).steps.storyboard.status, 'cancelled')
})

test('cancel and stale requests win over a deferred child creation before enqueue', async (t) => {
  for (const terminal of ['cancelled', 'stale'] as const) {
    await t.test(terminal, { timeout: 2_000 }, async (subtest) => {
      const value = fixture()
      subtest.after(() => value.database.close())
      const harness = portHarness(value.database)
      const original = harness.ports.submitStoryboard
      const entered = deferred()
      const release = deferred()
      let createdJobId: string | undefined
      harness.ports.submitStoryboard = async (input) => {
        entered.resolve()
        await release.promise
        const result = await original(input)
        createdJobId = result.jobId
        return result
      }
      const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })
      const created = coordinator.create(value.request(`deferred-${terminal}`, ['shot-1']))
      const kick = coordinator.kick(created.run.id)
      await entered.promise
      const terminate = terminal === 'cancelled'
        ? coordinator.cancel(created.run.id)
        : coordinator.markStale(created.run.id)
      release.resolve()
      await Promise.all([kick, terminate])

      assert.ok(createdJobId)
      assert.equal(value.database.getPipelineRun(created.run.id)?.status, terminal)
      assert.equal(value.database.getGenerationJob(createdJobId)?.status, 'cancelled')
      assert.ok(harness.calls.cancel.includes(createdJobId))
      assert.ok(!harness.calls.enqueue.includes(createdJobId))
    })
  }
})

test('recovery rejects a semantically corrupted child before enqueue without blocking another run', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const initialHarness = portHarness(value.database)
  const initial = new PipelineRunCoordinator(value.database, initialHarness.ports)
  const corrupt = initial.create(value.request('recover-corrupt', ['shot-1']))
  const healthy = initial.create(value.request('recover-healthy', ['shot-2']))
  await initial.kick(corrupt.run.id)
  await initial.kick(healthy.run.id)
  const corruptJobId = parsePipelineRunDocument(
    value.database.getPipelineRun(corrupt.run.id)!.steps,
  ).steps.storyboard.jobIds[0]
  const healthyJobId = parsePipelineRunDocument(
    value.database.getPipelineRun(healthy.run.id)!.steps,
  ).steps.storyboard.jobIds[0]
  value.database.withSql((sql) => sql.run(
    'UPDATE generation_jobs SET type = ? WHERE id = ?',
    'dialogue.speech.generate',
    corruptJobId,
  ))

  const restartedHarness = portHarness(value.database)
  const restarted = new PipelineRunCoordinator(value.database, restartedHarness.ports)
  await restarted.recover()

  assert.equal(value.database.getPipelineRun(corrupt.run.id)?.status, 'failed')
  assert.ok(!restartedHarness.calls.enqueue.includes(corruptJobId))
  assert.ok(restartedHarness.calls.cancel.includes(corruptJobId))
  assert.ok(restartedHarness.calls.enqueue.includes(healthyJobId))
  assert.equal(value.database.getPipelineRun(healthy.run.id)?.status, 'running')
})

test('a failed fanout cancels active siblings before failing the run', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })
  const created = coordinator.create(value.request('fanout-failure', ['shot-1', 'shot-2']))
  await coordinator.kick(created.run.id)
  let document = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  const [failed, sibling] = document.steps.storyboard.jobIds
  setJob(value.database, failed, 'failed', 30)
  setJob(value.database, sibling, 'running', 40)

  const completed = await coordinator.kick(created.run.id)
  document = parsePipelineRunDocument(completed!.steps)
  assert.equal(completed?.status, 'failed')
  assert.equal(document.steps.storyboard.status, 'failed')
  assert.ok(harness.calls.cancel.includes(sibling))
  assert.equal(value.database.getGenerationJob(sibling)?.status, 'cancelled')
  assert.equal(harness.calls.timeline.length, 0)
})

test('a succeeded QC job cannot succeed the pipeline when its report failed', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })
  const created = coordinator.create(value.request('qc-failure'))
  await coordinator.kick(created.run.id)
  let document = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  setJob(value.database, document.steps.export.rootJobId!, 'succeeded', 100)
  await coordinator.kick(created.run.id)
  document = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  setJob(value.database, document.steps.quality.rootJobId!, 'succeeded', 100)
  harness.setQuality(document.steps.quality.reportId!, false)

  const completed = await coordinator.kick(created.run.id)
  document = parsePipelineRunDocument(completed!.steps)
  assert.equal(completed?.status, 'failed')
  assert.equal(document.steps.quality.status, 'failed')
  assert.equal(document.steps.quality.passed, false)
  assert.equal(document.steps.quality.error?.code, 'QUALITY_CHECK_FAILED')
})

test('a tampered export immutable binding fails before its render job is enqueued', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const original = harness.ports.createExport
  let exportJobId: string | undefined
  harness.ports.createExport = async (input) => {
    const result = await original(input)
    exportJobId = result.jobId
    value.database.withSql((sql) => sql.run(
      'UPDATE exports SET specification_json = ? WHERE id = ?',
      JSON.stringify({
        timelineRevisionId: 'wrong-timeline',
        storyRevisionId: input.sourceRevisionId,
      }),
      result.exportId,
    ))
    return result
  }
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })
  const created = coordinator.create(value.request('tampered-export'))

  const run = await coordinator.kick(created.run.id)
  assert.equal(run?.status, 'failed')
  assert.ok(exportJobId)
  assert.ok(!harness.calls.enqueue.includes(exportJobId))
  assert.equal(run?.error?.code, 'PIPELINE_CHILD_BINDING_CONFLICT')
})

test('a quality report bound to another export fails before QC enqueue or authorization', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })
  const created = coordinator.create(value.request('tampered-quality'))
  await coordinator.kick(created.run.id)
  let document = parsePipelineRunDocument(value.database.getPipelineRun(created.run.id)!.steps)
  setJob(value.database, document.steps.export.rootJobId!, 'succeeded', 100)
  let qualityJobId: string | undefined
  harness.ports.createQuality = (input) => {
    const reportId = randomUUID()
    const outputAssetId = `output-${input.exportId}`
    const outputAssetChecksum = 'b'.repeat(64)
    value.database.withSql((sql) => sql.run(`
      INSERT INTO quality_reports (
        id, project_id, episode_id, export_id, status, checks_json,
        passed, created_at, completed_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, NULL)
    `,
    reportId,
    input.projectId,
    input.episodeId,
    input.exportId,
    JSON.stringify({
      version: 1,
      binding: {
        version: 1,
        exportId: 'wrong-export',
        outputAssetId,
        outputAssetChecksum,
        timelineRevisionId: `timeline-${input.sourceRevisionId}`,
        storyRevisionId: input.sourceRevisionId,
        exportSpecification: {},
        expected: {},
      },
      policy: {},
      checks: [],
      metrics: {},
      summary: { passed: null, failedChecks: 0, warningChecks: 0 },
    }),
    NOW))
    const job = value.database.createGenerationJob({
      projectId: input.projectId,
      episodeId: input.episodeId,
      pipelineRunId: input.pipelineRunId,
      type: 'quality.check',
      status: 'queued',
      resourceType: 'quality.report',
      resourceId: reportId,
      idempotencyKey: input.idempotencyKey,
      input: {
        qualityReportId: reportId,
        exportId: input.exportId,
        outputAssetId,
        outputAssetChecksum,
      },
    })
    qualityJobId = job.id
    return { reportId, jobId: job.id }
  }

  const run = await coordinator.kick(created.run.id)
  document = parsePipelineRunDocument(run!.steps)
  assert.equal(run?.status, 'failed')
  assert.equal(document.steps.quality.status, 'failed')
  assert.ok(qualityJobId)
  assert.ok(!harness.calls.enqueue.includes(qualityJobId))
  assert.equal(harness.calls.authorizeQuality.length, 0)
  assert.equal(run?.error?.code, 'PIPELINE_CHILD_BINDING_CONFLICT')
})

test('terminal stale and cancelled runs never invoke production ports', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const harness = portHarness(value.database)
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports)
  const stale = coordinator.create(value.request('stale-terminal'))
  const cancelled = coordinator.create(value.request('cancelled-terminal'))
  value.database.updatePipelineRun(stale.run.id, { status: 'stale', completedAt: NOW })
  value.database.updatePipelineRun(cancelled.run.id, { status: 'cancelled', completedAt: NOW })

  await coordinator.kick(stale.run.id)
  await coordinator.kick(cancelled.run.id)
  assert.deepEqual(harness.calls, {
    storyboard: [],
    speech: [],
    timeline: [],
    export: [],
    quality: [],
    authorizeQuality: [],
    enqueue: [],
    cancel: [],
  })
})

test('episode source revision, not the movable project head, controls staleness', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  value.database.createRevision({
    id: 'story-revision-2',
    projectId: 'project-1',
    parentRevisionId: 'story-revision-1',
    summary: 'Another episode changed the workspace head',
    snapshot: {},
  })
  value.database.updateProject('project-1', { currentRevisionId: 'story-revision-2' })
  const harness = portHarness(value.database)
  const coordinator = new PipelineRunCoordinator(value.database, harness.ports, { now: () => NOW })

  const unaffected = coordinator.create(value.request('episode-still-current'))
  const futureStale = coordinator.create(value.request('episode-will-change'))
  const advanced = await coordinator.kick(unaffected.run.id)
  assert.equal(advanced?.status, 'running')
  assert.equal(harness.calls.timeline.length, 1)

  value.database.withSql((sql) => sql.run(`
    UPDATE episodes SET source_revision_id = ? WHERE id = ?
  `, 'story-revision-2', 'episode-1'))
  const stale = await coordinator.kick(futureStale.run.id)
  assert.equal(stale?.status, 'stale')
  assert.equal(harness.calls.timeline.length, 1)
  assert.equal(parsePipelineRunDocument(stale!.steps).steps.timeline.status, 'stale')
})
