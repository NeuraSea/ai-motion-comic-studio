import type { JsonObject } from './types.js'

export const JOB_STATUSES = [
  'queued',
  'running',
  'waiting_provider',
  'succeeded',
  'failed',
  'cancelled',
] as const

export type JobStatus = (typeof JOB_STATUSES)[number]

export type JobErrorCategory =
  | 'authentication'
  | 'cancelled'
  | 'content_policy'
  | 'internal'
  | 'provider'
  | 'rate_limit'
  | 'timeout'
  | 'validation'

export interface JobErrorInfo {
  code: string
  message: string
  retryable: boolean
  category: JobErrorCategory
  /** Bounded handler-authored evidence; never raw thrown objects or secrets. */
  diagnostics?: JsonObject
}

/**
 * Deliberately contains only the fields the worker needs. A SQLite repository
 * may return a richer record without coupling the scheduler to its schema.
 */
export interface JobRecord<TInput = unknown, TOutput = unknown> {
  id: string
  type: string
  status: JobStatus
  input: TInput
  projectId?: string
  providerId?: string
  model?: string
  providerConfigRevision?: number
  output?: TOutput
  progress?: number
  resourceKey?: string
  idempotencyKey?: string
  providerState?: unknown
  error?: JobErrorInfo
  retryOf?: string
  attempt?: number
  createdAt?: string
  updatedAt?: string
  startedAt?: string
  completedAt?: string
}

export interface CreateJobRequest<TInput = unknown> {
  type: string
  input: TInput
  /** The repository must atomically return the existing job for duplicates. */
  idempotencyKey: string
  resourceKey?: string
  projectId?: string
  providerId?: string
  model?: string
  providerConfigRevision?: number
  metadata?: unknown
}

export interface RetryJobRequest {
  /** Optional request idempotency. Retry-chain rules remain repository-owned. */
  idempotencyKey?: string
  resourceKey?: string
  metadata?: unknown
}

export interface JobCreationResult {
  job: JobRecord
  /** False means an idempotent create/retry returned an existing record. */
  created: boolean
}

/**
 * All state-changing methods must be atomic and transition only from their
 * documented source states. In particular, succeed/fail must never overwrite
 * a concurrently cancelled terminal job.
 */
export interface JobRepository {
  create(request: CreateJobRequest): Promise<JobCreationResult>
  retry(jobId: string, request?: RetryJobRequest): Promise<JobCreationResult>
  get(jobId: string): Promise<JobRecord | undefined>

  /**
   * Atomically requeue interrupted `running` jobs and return all runnable
   * (`queued` and `waiting_provider`) jobs. A waiting provider job retains its
   * provider state so its handler can resume polling rather than resubmit.
   */
  recoverRunnable(): Promise<JobRecord[]>

  /** Atomically transition queued/waiting_provider -> running. */
  claim(jobId: string): Promise<JobRecord | undefined>
  updateProgress(jobId: string, progress: number, detail?: unknown): Promise<JobRecord | undefined>
  /**
   * Persist an upstream submission/polling checkpoint and transition
   * running -> waiting_provider. Repeated calls while waiting_provider update
   * the checkpoint without changing the state, so handlers can durably record
   * both "submitting" and "response-received" crash boundaries.
   */
  markWaitingProvider(jobId: string, providerState?: unknown): Promise<JobRecord | undefined>
  /** Atomically transition running/waiting_provider -> succeeded. */
  succeed(jobId: string, output: unknown): Promise<JobRecord | undefined>
  /** Atomically transition running/waiting_provider -> failed. */
  fail(jobId: string, error: JobErrorInfo): Promise<JobRecord | undefined>
  /** Atomically transition any non-terminal state -> cancelled. */
  cancel(jobId: string, error: JobErrorInfo): Promise<JobRecord | undefined>
}

export interface JobHandlerContext {
  readonly signal: AbortSignal
  reportProgress(progress: number, detail?: unknown): Promise<void>
  waitingForProvider(providerState?: unknown): Promise<void>
}

export type JobHandler<TInput = unknown, TOutput = unknown> = (
  job: JobRecord<TInput>,
  context: JobHandlerContext,
) => Promise<TOutput>

export interface JobHandlerOptions {
  /** Overrides the persisted job resource key for concurrency scheduling. */
  resourceKey?: (job: JobRecord) => string | undefined
}

export type JobWorkerEventType =
  | 'job.cancelled'
  | 'job.created'
  | 'job.enqueued'
  | 'job.failed'
  | 'job.progress'
  | 'job.recovered'
  | 'job.started'
  | 'job.succeeded'
  | 'job.waiting_provider'

export interface JobWorkerEvent {
  type: JobWorkerEventType
  at: string
  jobId: string
  job?: JobRecord
  error?: JobErrorInfo
}

export interface JobWorkerErrorContext {
  operation: 'event' | 'repository' | 'scheduler'
  jobId?: string
}

export interface JobWorkerOptions {
  /** Overall process concurrency. Defaults to one. */
  concurrency?: number
  /** Optional per-resource limits, for example `{ "provider:image": 1 }`. */
  resourceConcurrency?: Readonly<Record<string, number>>
  onEvent?: (event: JobWorkerEvent) => void
  /** Receives infrastructure errors which cannot be represented as job failure. */
  onError?: (error: unknown, context: JobWorkerErrorContext) => void
}

interface HandlerRegistration {
  handler: JobHandler
  resourceKey?: (job: JobRecord) => string | undefined
}

interface ActiveJob {
  controller: AbortController
  resourceKey?: string
  promise: Promise<void>
}

interface IdleWaiter {
  resolve: () => void
  reject: (error: unknown) => void
}

const RUNNABLE_STATUSES: ReadonlySet<JobStatus> = new Set(['queued', 'waiting_provider'])
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled'])

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function objectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

function errorCode(error: unknown): string {
  const value = objectProperty(error, 'code')
  return typeof value === 'string' ? value.toUpperCase() : ''
}

function errorStatus(error: unknown): number | undefined {
  for (const key of ['status', 'statusCode']) {
    const value = objectProperty(error, key)
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function hasAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate))
}

/** An explicit, safe-to-persist handler/provider error. */
export class JobExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly category: JobErrorCategory = 'provider',
    options?: ErrorOptions & { diagnostics?: JsonObject },
  ) {
    super(message, options)
    this.name = 'JobExecutionError'
    this.diagnostics = options?.diagnostics
  }

  readonly diagnostics?: JsonObject
}

export class JobCancelledError extends JobExecutionError {
  constructor(message = '任务已取消', options?: ErrorOptions) {
    super('JOB_CANCELLED', message, false, 'cancelled', options)
    this.name = 'JobCancelledError'
  }
}

/**
 * Converts thrown provider/handler errors into safe durable metadata. Explicit
 * JobExecutionError values win; common HTTP/network failures are classified.
 */
export function classifyJobError(error: unknown, signal?: AbortSignal): JobErrorInfo {
  if (error instanceof JobExecutionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      category: error.category,
      ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
    }
  }

  const name = objectProperty(error, 'name')
  if (signal?.aborted || name === 'AbortError') {
    return { code: 'JOB_CANCELLED', message: '任务已取消', retryable: false, category: 'cancelled' }
  }

  const status = errorStatus(error)
  const code = errorCode(error)
  if (status === 429 || hasAny(code, ['RATE_LIMIT', 'TOO_MANY_REQUESTS'])) {
    return { code: 'PROVIDER_RATE_LIMITED', message: '服务请求过于频繁，请稍后重试', retryable: true, category: 'rate_limit' }
  }
  if (
    status === 408 || status === 504 || name === 'TimeoutError' ||
    hasAny(code, ['ETIMEDOUT', 'TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'])
  ) {
    return { code: 'PROVIDER_TIMEOUT', message: '服务响应超时，请稍后重试', retryable: true, category: 'timeout' }
  }
  if (status === 401 || status === 403 || hasAny(code, ['UNAUTHORIZED', 'AUTHENTICATION', 'INVALID_API_KEY'])) {
    return { code: 'PROVIDER_AUTHENTICATION_FAILED', message: '服务鉴权失败，请检查连接设置', retryable: false, category: 'authentication' }
  }
  if (hasAny(code, ['CONTENT_POLICY', 'CONTENT_FILTER', 'MODERATION', 'SAFETY'])) {
    return { code: 'PROVIDER_CONTENT_REJECTED', message: '内容被服务安全策略拒绝', retryable: false, category: 'content_policy' }
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { code: 'PROVIDER_INVALID_REQUEST', message: '服务拒绝了任务参数', retryable: false, category: 'validation' }
  }
  if (status !== undefined && status >= 500) {
    return { code: 'PROVIDER_UNAVAILABLE', message: '服务暂时不可用，请稍后重试', retryable: true, category: 'provider' }
  }
  if (hasAny(code, ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT'])) {
    return { code: 'PROVIDER_NETWORK_ERROR', message: '无法连接服务，请稍后重试', retryable: true, category: 'provider' }
  }
  return { code: 'UNEXPECTED_JOB_ERROR', message: '任务执行失败，请查看服务日志', retryable: true, category: 'internal' }
}

function cancellationInfo(message = '任务已取消'): JobErrorInfo {
  return { code: 'JOB_CANCELLED', message, retryable: false, category: 'cancelled' }
}

export class JobWorker {
  private readonly handlers = new Map<string, HandlerRegistration>()
  private readonly pending: string[] = []
  private readonly enqueued = new Set<string>()
  private readonly active = new Map<string, ActiveJob>()
  private readonly activeByResource = new Map<string, number>()
  private readonly terminalEvents = new Set<string>()
  private readonly idleWaiters: IdleWaiter[] = []
  private readonly backgroundErrors: unknown[] = []
  private readonly concurrency: number
  private readonly resourceConcurrency: Readonly<Record<string, number>>
  private readonly onEvent?: (event: JobWorkerEvent) => void
  private readonly onError?: (error: unknown, context: JobWorkerErrorContext) => void
  private started = false
  private lifecycleGeneration = 0
  private startPromise?: Promise<void>
  private stopPromise?: Promise<void>
  private drainPromise?: Promise<void>
  private drainAgain = false

  constructor(
    private readonly repository: JobRepository,
    options: JobWorkerOptions = {},
  ) {
    this.concurrency = positiveInteger(options.concurrency ?? 1, 'concurrency')
    const limits = { ...(options.resourceConcurrency ?? {}) }
    for (const [key, value] of Object.entries(limits)) {
      positiveInteger(value, `resourceConcurrency[${JSON.stringify(key)}]`)
    }
    this.resourceConcurrency = Object.freeze(limits)
    this.onEvent = options.onEvent
    this.onError = options.onError
  }

  register<TInput = unknown, TOutput = unknown>(
    type: string,
    handler: JobHandler<TInput, TOutput>,
    options: JobHandlerOptions = {},
  ): this {
    const normalized = type.trim()
    if (!normalized) throw new Error('job handler type must not be empty')
    if (this.handlers.has(normalized)) throw new Error(`job handler already registered: ${normalized}`)
    // The type string is the runtime discriminator; callers keep a typed
    // handler while the heterogeneous registry stores the erased form.
    this.handlers.set(normalized, { handler: handler as JobHandler, ...options })
    return this
  }

  unregister(type: string): boolean {
    return this.handlers.delete(type)
  }

  /** Recover durable work and begin scheduling. Safe to call more than once. */
  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise
    if (this.started) return
    if (this.startPromise) return this.startPromise
    const generation = ++this.lifecycleGeneration
    this.startPromise = (async () => {
      const recovered = await this.repository.recoverRunnable()
      // stop() invalidates the generation before waiting for this promise, so
      // a delayed recovery can never resurrect a worker after stop resolves.
      if (generation !== this.lifecycleGeneration) return
      this.started = true
      for (const job of recovered) {
        if (!RUNNABLE_STATUSES.has(job.status)) continue
        this.emit({ type: 'job.recovered', jobId: job.id, job })
        this.enqueue(job.id)
      }
      this.kick()
    })()
    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  /**
   * Stop accepting work in this process and wait for current handlers. Pending
   * jobs remain durable and will be discovered by the next start/restart.
   */
  async stop(options: { cancelRunning?: boolean } = {}): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    ++this.lifecycleGeneration
    this.started = false
    const stopping = (async () => {
      // Invalidate and await a start that may be suspended in durable recovery.
      // Without this, start() could set started=true after stop() returned.
      if (this.startPromise) {
        await this.startPromise.catch((error) => {
          this.recordBackgroundError(error, { operation: 'repository' })
        })
      }
      // A scheduler may be suspended inside repository.get(). Wait for it to
      // observe started=false before taking the active-job snapshot.
      if (this.drainPromise) {
        await this.drainPromise.catch((error) => {
          this.recordBackgroundError(error, { operation: 'scheduler' })
        })
      }
      if (options.cancelRunning) {
        await Promise.all([...this.active.keys()].map((jobId) => this.cancel(jobId, 'Worker 已停止')))
      }
      await Promise.all([...this.active.values()].map((entry) => entry.promise))
    })()
    this.stopPromise = stopping
    try {
      await stopping
    } finally {
      if (this.stopPromise === stopping) this.stopPromise = undefined
    }
  }

  async submit(request: CreateJobRequest): Promise<JobCreationResult> {
    if (!request.idempotencyKey.trim()) throw new Error('idempotencyKey must not be empty')
    const result = await this.repository.create(request)
    if (result.created) this.emit({ type: 'job.created', jobId: result.job.id, job: result.job })
    if (RUNNABLE_STATUSES.has(result.job.status)) this.enqueue(result.job.id)
    return result
  }

  async retry(jobId: string, request: RetryJobRequest = {}): Promise<JobCreationResult> {
    if (request.idempotencyKey !== undefined && !request.idempotencyKey.trim()) {
      throw new Error('idempotencyKey must not be empty')
    }
    const result = await this.repository.retry(jobId, request)
    if (result.created) this.emit({ type: 'job.created', jobId: result.job.id, job: result.job })
    if (RUNNABLE_STATUSES.has(result.job.status)) this.enqueue(result.job.id)
    return result
  }

  enqueue(jobId: string): void {
    if (this.enqueued.has(jobId) || this.active.has(jobId)) return
    this.enqueued.add(jobId)
    this.pending.push(jobId)
    this.emit({ type: 'job.enqueued', jobId })
    this.kick()
  }

  async cancel(jobId: string, message = '任务已取消'): Promise<JobRecord | undefined> {
    const active = this.active.get(jobId)
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(new JobCancelledError(message))
    }
    this.removePending(jobId)
    const job = await this.repository.cancel(jobId, cancellationInfo(message))
    if (job?.status === 'cancelled') this.emitTerminal({ type: 'job.cancelled', jobId, job, error: job.error })
    if (job?.status === 'failed') this.emitTerminal({ type: 'job.failed', jobId, job, error: job.error })
    this.kick()
    this.settleIdleWaiters()
    return job
  }

  getStats(): { started: boolean; active: number; pending: number; concurrency: number } {
    return {
      started: this.started,
      active: this.active.size,
      pending: this.pending.length,
      concurrency: this.concurrency,
    }
  }

  /**
   * Resolves once all queued work is terminal. Infrastructure errors reject as
   * AggregateError rather than disappearing in a detached scheduler promise.
   */
  waitForIdle(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.idleWaiters.push({ resolve, reject })
      this.settleIdleWaiters()
    })
  }

  private kick(): void {
    if (!this.started) return
    if (this.drainPromise) {
      this.drainAgain = true
      return
    }
    const draining = this.drain()
    this.drainPromise = draining
    void draining
      .catch((error) => this.recordBackgroundError(error, { operation: 'scheduler' }))
      .finally(() => {
        this.drainPromise = undefined
        const runAgain = this.drainAgain || (this.pending.length > 0 && this.active.size === 0)
        this.drainAgain = false
        if (runAgain) this.kick()
        this.settleIdleWaiters()
      })
  }

  private async drain(): Promise<void> {
    while (this.started && this.active.size < this.concurrency && this.pending.length > 0) {
      const candidate = await this.nextSchedulable()
      if (!candidate) return
      const { jobId, resourceKey } = candidate
      const controller = new AbortController()
      const entry: ActiveJob = { controller, resourceKey, promise: Promise.resolve() }
      this.active.set(jobId, entry)
      this.incrementResource(resourceKey)

      const execution = this.run(jobId, controller)
      entry.promise = execution
      void execution
        .catch((error) => this.recordBackgroundError(error, { operation: 'repository', jobId }))
        .finally(() => {
          this.active.delete(jobId)
          this.decrementResource(resourceKey)
          this.kick()
          this.settleIdleWaiters()
        })
    }
  }

  private async nextSchedulable(): Promise<{ jobId: string; resourceKey?: string } | undefined> {
    for (let index = 0; index < this.pending.length;) {
      const jobId = this.pending[index]
      const job = await this.repository.get(jobId)
      // stop() may have run while the repository read was pending. Leave the
      // id queued and durable instead of starting a handler after stop returns.
      if (!this.started) return undefined
      if (!job || !RUNNABLE_STATUSES.has(job.status)) {
        this.pending.splice(index, 1)
        this.enqueued.delete(jobId)
        continue
      }
      const resourceKey = this.resolveResourceKey(job)
      if (!this.hasResourceCapacity(resourceKey)) {
        index += 1
        continue
      }
      this.pending.splice(index, 1)
      this.enqueued.delete(jobId)
      return { jobId, ...(resourceKey ? { resourceKey } : {}) }
    }
    return undefined
  }

  private async run(jobId: string, controller: AbortController): Promise<void> {
    const job = await this.repository.claim(jobId)
    if (!job) return
    this.emit({ type: 'job.started', jobId, job })

    const registration = this.handlers.get(job.type)
    const context: JobHandlerContext = {
      signal: controller.signal,
      reportProgress: async (progress, detail) => {
        controller.signal.throwIfAborted()
        if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
          throw new JobExecutionError('INVALID_JOB_PROGRESS', '任务进度必须介于 0 和 100 之间', false, 'validation')
        }
        const updated = await this.repository.updateProgress(jobId, progress, detail)
        if (updated) this.emit({ type: 'job.progress', jobId, job: updated })
      },
      waitingForProvider: async (providerState) => {
        controller.signal.throwIfAborted()
        const updated = await this.repository.markWaitingProvider(jobId, providerState)
        if (updated) this.emit({ type: 'job.waiting_provider', jobId, job: updated })
      },
    }

    try {
      if (!registration) {
        throw new JobExecutionError(
          'JOB_HANDLER_NOT_REGISTERED',
          `没有为任务类型 ${job.type} 注册处理器`,
          false,
          'validation',
        )
      }
      const output = await registration.handler(job, context)
      controller.signal.throwIfAborted()
      const succeeded = await this.repository.succeed(jobId, output)
      if (succeeded?.status === 'succeeded') {
        this.emitTerminal({ type: 'job.succeeded', jobId, job: succeeded })
      }
    } catch (error) {
      const classified = classifyJobError(error, controller.signal)
      try {
        if (classified.category === 'cancelled') {
          const terminal = await this.repository.cancel(jobId, classified)
          if (terminal?.status === 'cancelled') {
            this.emitTerminal({ type: 'job.cancelled', jobId, job: terminal, error: classified })
          } else if (terminal?.status === 'failed') {
            this.emitTerminal({ type: 'job.failed', jobId, job: terminal, error: terminal.error })
          }
        } else {
          const failed = await this.repository.fail(jobId, classified)
          if (failed?.status === 'failed') {
            this.emitTerminal({ type: 'job.failed', jobId, job: failed, error: classified })
          }
        }
      } catch (persistenceError) {
        throw new AggregateError(
          [error, persistenceError],
          `Failed to persist terminal state for job ${jobId}`,
        )
      }
    }
  }

  private resolveResourceKey(job: JobRecord): string | undefined {
    const registration = this.handlers.get(job.type)
    try {
      const raw = registration?.resourceKey?.(job) ?? job.resourceKey
      const normalized = raw?.trim()
      return normalized || undefined
    } catch (error) {
      this.recordBackgroundError(error, { operation: 'scheduler', jobId: job.id })
      return job.resourceKey?.trim() || undefined
    }
  }

  private hasResourceCapacity(resourceKey: string | undefined): boolean {
    if (!resourceKey) return true
    const limit = this.resourceConcurrency[resourceKey] ?? this.concurrency
    return (this.activeByResource.get(resourceKey) ?? 0) < limit
  }

  private incrementResource(resourceKey: string | undefined): void {
    if (!resourceKey) return
    this.activeByResource.set(resourceKey, (this.activeByResource.get(resourceKey) ?? 0) + 1)
  }

  private decrementResource(resourceKey: string | undefined): void {
    if (!resourceKey) return
    const next = (this.activeByResource.get(resourceKey) ?? 1) - 1
    if (next > 0) this.activeByResource.set(resourceKey, next)
    else this.activeByResource.delete(resourceKey)
  }

  private removePending(jobId: string): void {
    this.enqueued.delete(jobId)
    let index = this.pending.indexOf(jobId)
    while (index >= 0) {
      this.pending.splice(index, 1)
      index = this.pending.indexOf(jobId)
    }
  }

  private emit(event: Omit<JobWorkerEvent, 'at'>): void {
    if (!this.onEvent) return
    try {
      this.onEvent({ ...event, at: new Date().toISOString() })
    } catch (error) {
      this.recordBackgroundError(error, { operation: 'event', jobId: event.jobId })
    }
  }

  private emitTerminal(event: Omit<JobWorkerEvent, 'at'>): void {
    const key = `${event.type}:${event.jobId}`
    if (this.terminalEvents.has(key)) return
    this.terminalEvents.add(key)
    this.emit(event)
  }

  private recordBackgroundError(error: unknown, context: JobWorkerErrorContext): void {
    this.backgroundErrors.push(error)
    if (this.onError) {
      try {
        this.onError(error, context)
      } catch (callbackError) {
        this.backgroundErrors.push(callbackError)
        console.error('JobWorker onError callback failed', callbackError)
      }
    } else {
      console.error('JobWorker background error', context, error)
    }
  }

  private settleIdleWaiters(): void {
    if (this.pending.length > 0 || this.active.size > 0 || this.drainPromise) return
    const waiters = this.idleWaiters.splice(0)
    if (!waiters.length) return
    const errors = this.backgroundErrors.splice(0)
    if (errors.length) {
      const aggregate = new AggregateError(errors, 'JobWorker encountered background errors')
      for (const waiter of waiters) waiter.reject(aggregate)
    } else {
      for (const waiter of waiters) waiter.resolve()
    }
  }
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}
