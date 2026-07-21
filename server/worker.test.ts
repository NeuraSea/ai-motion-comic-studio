import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import {
  JobExecutionError,
  JobWorker,
  type CreateJobRequest,
  type JobCreationResult,
  type JobErrorInfo,
  type JobRecord,
  type JobRepository,
  type JobStatus,
  type JobWorkerEvent,
  type RetryJobRequest,
} from './worker.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

class MemoryJobRepository implements JobRepository {
  readonly jobs = new Map<string, JobRecord>()
  private readonly idempotency = new Map<string, string>()
  private revision = 0

  seed(job: JobRecord): void {
    this.jobs.set(job.id, clone(job))
    if (job.idempotencyKey) this.idempotency.set(job.idempotencyKey, job.id)
  }

  async create(request: CreateJobRequest): Promise<JobCreationResult> {
    const existingId = this.idempotency.get(request.idempotencyKey)
    if (existingId) return { job: clone(this.jobs.get(existingId)!), created: false }
    const job: JobRecord = {
      id: `job-${++this.revision}`,
      type: request.type,
      status: 'queued',
      progress: 0,
      input: clone(request.input),
      idempotencyKey: request.idempotencyKey,
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.providerId ? { providerId: request.providerId } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.providerConfigRevision !== undefined
        ? { providerConfigRevision: request.providerConfigRevision }
        : {}),
      ...(request.resourceKey ? { resourceKey: request.resourceKey } : {}),
    }
    this.jobs.set(job.id, job)
    this.idempotency.set(request.idempotencyKey, job.id)
    return { job: clone(job), created: true }
  }

  async retry(jobId: string, request: RetryJobRequest = {}): Promise<JobCreationResult> {
    const original = this.jobs.get(jobId)
    if (!original) throw new Error(`missing original: ${jobId}`)
    if (original.status !== 'failed' || !original.error?.retryable) throw new Error('job is not retryable')
    return this.create({
      type: original.type,
      input: original.input,
      idempotencyKey: request.idempotencyKey ?? `retry:${jobId}`,
      resourceKey: request.resourceKey ?? original.resourceKey,
      projectId: original.projectId,
      providerId: original.providerId,
      model: original.model,
      providerConfigRevision: original.providerConfigRevision,
    }).then((result) => {
      if (result.created) this.jobs.get(result.job.id)!.retryOf = jobId
      return { ...result, job: clone(this.jobs.get(result.job.id)!) }
    })
  }

  async get(jobId: string): Promise<JobRecord | undefined> {
    const job = this.jobs.get(jobId)
    return job ? clone(job) : undefined
  }

  async recoverRunnable(): Promise<JobRecord[]> {
    const recovered: JobRecord[] = []
    for (const job of this.jobs.values()) {
      if (job.status === 'running') job.status = 'queued'
      if (job.status === 'queued' || job.status === 'waiting_provider') recovered.push(clone(job))
    }
    return recovered
  }

  async claim(jobId: string): Promise<JobRecord | undefined> {
    const job = this.jobs.get(jobId)
    if (!job || (job.status !== 'queued' && job.status !== 'waiting_provider')) return undefined
    job.status = 'running'
    return clone(job)
  }

  async updateProgress(jobId: string, progress: number): Promise<JobRecord | undefined> {
    const job = this.jobs.get(jobId)
    if (!job || (job.status !== 'running' && job.status !== 'waiting_provider')) return undefined
    job.progress = progress
    return clone(job)
  }

  async markWaitingProvider(jobId: string, providerState?: unknown): Promise<JobRecord | undefined> {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'running') return undefined
    job.status = 'waiting_provider'
    job.providerState = clone(providerState)
    return clone(job)
  }

  async succeed(jobId: string, output: unknown): Promise<JobRecord | undefined> {
    return this.terminal(jobId, 'succeeded', { output: clone(output), progress: 100 })
  }

  async fail(jobId: string, error: JobErrorInfo): Promise<JobRecord | undefined> {
    return this.terminal(jobId, 'failed', { error: clone(error) })
  }

  async cancel(jobId: string, error: JobErrorInfo): Promise<JobRecord | undefined> {
    const job = this.jobs.get(jobId)
    if (!job) return undefined
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return clone(job)
    job.status = 'cancelled'
    job.error = clone(error)
    return clone(job)
  }

  private terminal(
    jobId: string,
    status: Extract<JobStatus, 'succeeded' | 'failed'>,
    update: Partial<JobRecord>,
  ): JobRecord | undefined {
    const job = this.jobs.get(jobId)
    if (!job || (job.status !== 'running' && job.status !== 'waiting_provider')) return undefined
    Object.assign(job, clone(update), { status })
    return clone(job)
  }
}

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  throw lastError
}

test('executes a registered handler, persists progress/output, and deduplicates submit', async () => {
  const repository = new MemoryJobRepository()
  const events: string[] = []
  const worker = new JobWorker(repository, { onEvent: (event) => events.push(event.type) })
  worker.register('story.generate', async (job, context) => {
    await context.reportProgress(35)
    return { title: (job.input as { title: string }).title.toUpperCase() }
  })
  await worker.start()

  const request = {
    type: 'story.generate',
    input: { title: '真实剧本' },
    idempotencyKey: 'story:project-1:revision-1',
  }
  const first = await worker.submit(request)
  const duplicate = await worker.submit(request)
  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.job.id, first.job.id)

  await worker.waitForIdle()
  const completed = await repository.get(first.job.id)
  assert.equal(completed?.status, 'succeeded')
  assert.deepEqual(completed?.output, { title: '真实剧本'.toUpperCase() })
  assert.equal(events.filter((event) => event === 'job.created').length, 1)
  assert.ok(events.includes('job.progress'))
  assert.ok(events.includes('job.succeeded'))
})

test('defaults to serial execution and supports resource-key limits with wider concurrency', async () => {
  const serialRepository = new MemoryJobRepository()
  let active = 0
  let maxActive = 0
  const serial = new JobWorker(serialRepository)
  serial.register('render', async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active -= 1
    return null
  })
  await serial.start()
  await Promise.all([
    serial.submit({ type: 'render', input: {}, idempotencyKey: randomUUID() }),
    serial.submit({ type: 'render', input: {}, idempotencyKey: randomUUID() }),
  ])
  await serial.waitForIdle()
  assert.equal(maxActive, 1)

  const keyedRepository = new MemoryJobRepository()
  const activeByKey = new Map<string, number>()
  const maxByKey = new Map<string, number>()
  let totalActive = 0
  let maxTotal = 0
  const keyed = new JobWorker(keyedRepository, {
    concurrency: 3,
    resourceConcurrency: { image: 1, speech: 2 },
  })
  keyed.register('provider.call', async (job) => {
    const key = job.resourceKey!
    totalActive += 1
    maxTotal = Math.max(maxTotal, totalActive)
    const count = (activeByKey.get(key) ?? 0) + 1
    activeByKey.set(key, count)
    maxByKey.set(key, Math.max(maxByKey.get(key) ?? 0, count))
    await new Promise((resolve) => setTimeout(resolve, 25))
    activeByKey.set(key, count - 1)
    totalActive -= 1
    return null
  })
  await keyed.start()
  await Promise.all([
    keyed.submit({ type: 'provider.call', input: {}, idempotencyKey: randomUUID(), resourceKey: 'image' }),
    keyed.submit({ type: 'provider.call', input: {}, idempotencyKey: randomUUID(), resourceKey: 'image' }),
    keyed.submit({ type: 'provider.call', input: {}, idempotencyKey: randomUUID(), resourceKey: 'speech' }),
    keyed.submit({ type: 'provider.call', input: {}, idempotencyKey: randomUUID(), resourceKey: 'speech' }),
  ])
  await keyed.waitForIdle()
  assert.equal(maxByKey.get('image'), 1)
  assert.equal(maxByKey.get('speech'), 2)
  assert.ok(maxTotal >= 2)
})

test('cancels active and queued jobs without allowing late handler success', async () => {
  const repository = new MemoryJobRepository()
  const entered = deferred<void>()
  const release = deferred<void>()
  const worker = new JobWorker(repository)
  worker.register('slow', async (_job, context) => {
    entered.resolve()
    await Promise.race([
      release.promise,
      new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
      }),
    ])
    return { shouldNotPersist: true }
  })
  await worker.start()
  const first = await worker.submit({ type: 'slow', input: {}, idempotencyKey: 'slow:first' })
  const second = await worker.submit({ type: 'slow', input: {}, idempotencyKey: 'slow:second' })
  await entered.promise

  await worker.cancel(first.job.id)
  await worker.cancel(second.job.id)
  release.resolve()
  await worker.waitForIdle()
  assert.equal((await repository.get(first.job.id))?.status, 'cancelled')
  assert.equal((await repository.get(second.job.id))?.status, 'cancelled')
  assert.equal((await repository.get(first.job.id))?.output, undefined)
})

test('startup recovers queued, interrupted, and provider-waiting work', async () => {
  const repository = new MemoryJobRepository()
  repository.seed({ id: 'queued', type: 'resume', status: 'queued', input: { value: 1 } })
  repository.seed({ id: 'interrupted', type: 'resume', status: 'running', input: { value: 2 } })
  repository.seed({
    id: 'provider-waiting',
    type: 'resume',
    status: 'waiting_provider',
    input: { value: 3 },
    providerState: { externalTaskId: 'provider-123' },
  })
  repository.seed({ id: 'done', type: 'resume', status: 'succeeded', input: { value: 4 }, output: 4 })
  const seen = new Map<string, unknown>()
  const recovered: string[] = []
  const worker = new JobWorker(repository, {
    onEvent: (event) => {
      if (event.type === 'job.recovered') recovered.push(event.jobId)
    },
  })
  worker.register('resume', async (job) => {
    seen.set(job.id, job.providerState)
    return (job.input as { value: number }).value
  })

  await worker.start()
  await worker.waitForIdle()
  assert.deepEqual([...recovered].sort(), ['interrupted', 'provider-waiting', 'queued'])
  assert.deepEqual([...seen.keys()].sort(), ['interrupted', 'provider-waiting', 'queued'])
  assert.deepEqual(seen.get('provider-waiting'), { externalTaskId: 'provider-123' })
  assert.equal((await repository.get('done'))?.output, 4)
})

test('classifies handler failures without exposing their raw cause in public events', async () => {
  const repository = new MemoryJobRepository()
  const failureEvents: JobWorkerEvent[] = []
  const worker = new JobWorker(repository, {
    onEvent: (event) => {
      if (event.type === 'job.failed') failureEvents.push(event)
    },
  })
  const providerFailure = Object.assign(
    new JobExecutionError('PROVIDER_503', '上游暂时不可用', true, 'provider'),
    { apiKey: 'must-never-reach-an-event' },
  )
  worker.register('fails', async () => { throw providerFailure })
  await worker.start()
  const created = await worker.submit({ type: 'fails', input: {}, idempotencyKey: 'failure:one' })
  await worker.waitForIdle()

  const failed = await repository.get(created.job.id)
  assert.equal(failed?.status, 'failed')
  assert.deepEqual(failed?.error, {
    code: 'PROVIDER_503',
    message: '上游暂时不可用',
    retryable: true,
    category: 'provider',
  })
  assert.equal(failureEvents.length, 1)
  assert.deepEqual(failureEvents[0].error, failed?.error)
  assert.equal(Object.hasOwn(failureEvents[0], 'cause'), false)
  assert.equal(JSON.stringify(failureEvents[0]).includes(providerFailure.apiKey), false)

  const retried = await worker.retry(created.job.id, { idempotencyKey: 'retry-request:one' })
  assert.equal(retried.created, true)
  assert.equal(retried.job.retryOf, created.job.id)
  await worker.waitForIdle()
})

test('surfaces detached repository failures through onError and waitForIdle', async () => {
  const repository = new MemoryJobRepository()
  const infrastructureFailure = new Error('database write failed')
  repository.fail = async () => { throw infrastructureFailure }
  const reported: unknown[] = []
  const worker = new JobWorker(repository, { onError: (error) => reported.push(error) })
  worker.register('fails-hard', async () => { throw new Error('handler exploded') })
  await worker.start()
  await worker.submit({ type: 'fails-hard', input: {}, idempotencyKey: 'infra:one' })

  await assert.rejects(worker.waitForIdle(), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    return true
  })
  assert.equal(reported.length, 1)
  assert.ok(reported[0] instanceof AggregateError)
  await eventually(() => assert.equal(worker.getStats().active, 0))
})

test('stop waits for an in-flight scheduler read and never starts work afterwards', async () => {
  const repository = new MemoryJobRepository()
  const enteredGet = deferred<void>()
  const releaseGet = deferred<void>()
  const originalGet = repository.get.bind(repository)
  let delayNextGet = true
  repository.get = async (jobId) => {
    if (delayNextGet) {
      delayNextGet = false
      enteredGet.resolve()
      await releaseGet.promise
    }
    return originalGet(jobId)
  }
  let ran = false
  const worker = new JobWorker(repository)
  worker.register('must-not-run', async () => {
    ran = true
    return null
  })
  await worker.start()
  const submitted = await worker.submit({
    type: 'must-not-run',
    input: {},
    idempotencyKey: 'stop-race',
  })
  await enteredGet.promise
  const stopping = worker.stop()
  releaseGet.resolve()
  await stopping
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(ran, false)
  assert.equal((await repository.get(submitted.job.id))?.status, 'queued')
})

test('stop invalidates a delayed start recovery and a later explicit start still works', async () => {
  const repository = new MemoryJobRepository()
  repository.seed({ id: 'recovered-late', type: 'resume-late', status: 'queued', input: {} })
  const enteredRecovery = deferred<void>()
  const releaseRecovery = deferred<void>()
  const originalRecovery = repository.recoverRunnable.bind(repository)
  let delayFirstRecovery = true
  repository.recoverRunnable = async () => {
    if (delayFirstRecovery) {
      delayFirstRecovery = false
      enteredRecovery.resolve()
      await releaseRecovery.promise
    }
    return originalRecovery()
  }

  let executions = 0
  const worker = new JobWorker(repository)
  worker.register('resume-late', async () => {
    executions += 1
    return null
  })

  const starting = worker.start()
  await enteredRecovery.promise
  const stopping = worker.stop()
  releaseRecovery.resolve()
  await Promise.all([starting, stopping])
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(worker.getStats().started, false)
  assert.equal(executions, 0)
  assert.equal((await repository.get('recovered-late'))?.status, 'queued')

  await worker.start()
  await worker.waitForIdle()
  assert.equal(executions, 1)
  assert.equal((await repository.get('recovered-late'))?.status, 'succeeded')
})
