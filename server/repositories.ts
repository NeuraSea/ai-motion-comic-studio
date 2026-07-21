import {
  getProviderDefinition,
  PROVIDER_CATALOG,
  type ProviderHealthState,
  type ProviderKind,
} from './providers/catalog.js'
import type {
  ProviderConnectionRecord as ServiceProviderConnectionRecord,
  ProviderConnectionVersionRecord as ServiceProviderConnectionVersionRecord,
  ProviderConnectionRepository,
} from './providers/service.js'
import type { JsonObject, JsonValue } from './types.js'
import type {
  CreateJobRequest,
  JobCreationResult,
  JobErrorCategory,
  JobErrorInfo,
  JobRecord,
  JobRepository,
  JobStatus,
  RetryJobRequest,
} from './worker.js'
import type {
  GenerationJobRecord,
  KeychainReference,
  ManjuDatabase,
  ProviderConnectionRecord as DatabaseProviderConnectionRecord,
  ProviderConnectionVersionRecord as DatabaseProviderConnectionVersionRecord,
} from './database.js'
import {
  genericRetryAllowed,
  isFreeLlmAgenticJobType,
  jobHasUnknownSubmission,
  jobRetryDisposition,
  type JobRetryDisposition,
} from './job-retry-policy.js'

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled'])
const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set(['running', 'waiting_provider'])
const RUNNABLE_STATUSES: readonly JobStatus[] = ['queued', 'waiting_provider']
const PAGE_SIZE = 1_000
const VALUE_ENVELOPE_KEY = '__manju_repository_value__'
const HEALTH_STATES: ReadonlySet<ProviderHealthState> = new Set([
  'untested',
  'ok',
  'degraded',
  'unavailable',
])
const ERROR_CATEGORIES: ReadonlySet<JobErrorCategory> = new Set([
  'authentication',
  'cancelled',
  'content_policy',
  'internal',
  'provider',
  'rate_limit',
  'timeout',
  'validation',
])
const DEFAULT_PROVIDER_IDS = new Set([
  'codex-tools-text',
  'codex-tools-image',
  'seedance-video',
  'minimax-speech',
])
const PROVIDER_SUBMISSION_OUTCOME_UNKNOWN = 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN'
const PAID_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN_MESSAGE =
  'Provider 提交结果未能确认。为避免重复计费，系统不会自动重提；请在供应商控制台核对后人工处理。'
const FREE_LLM_SUBMISSION_OUTCOME_UNKNOWN_MESSAGE =
  'LLM 提交结果未能确认。为避免采用歧义结果或重复生成，系统不会自动重提；请回到原工作台人工处理。'

export type SQLiteRepositoryErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_CREDENTIAL_REFERENCE'
  | 'INVALID_JOB_DATA'
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_RETRYABLE'
  | 'JOB_PAID_RECONFIRMATION_REQUIRED'
  | 'JOB_MANUAL_RESOLUTION_REQUIRED'
  | 'PROJECT_ID_REQUIRED'
  | 'PROVIDER_KIND_MISMATCH'
  | 'PROVIDER_NOT_FOUND'

export class SQLiteRepositoryError extends Error {
  constructor(
    readonly code: SQLiteRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SQLiteRepositoryError'
  }
}

export interface SQLiteJobRepositoryOptions {
  /** Used by the single-project compatibility layer when a request omits projectId. */
  defaultProjectId?: string
  now?: () => string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function retryDispositionError(
  job: Pick<GenerationJobRecord, 'id' | 'type'>,
  disposition: JobRetryDisposition,
): SQLiteRepositoryError {
  if (disposition === 'paid-reconfirmation-required') {
    return new SQLiteRepositoryError(
      'JOB_PAID_RECONFIRMATION_REQUIRED',
      '该任务的新尝试可能计费；请回到对应工作台重新预检并明确确认',
    )
  }
  if (disposition === 'manual-resolution') {
    return new SQLiteRepositoryError(
      'JOB_MANUAL_RESOLUTION_REQUIRED',
      isFreeLlmAgenticJobType(job.type)
        ? '任务的 LLM 提交结果无法确认；为避免采用歧义结果或重复生成，请回原工作台人工处理'
        : '任务的 Provider 提交结果无法确认；为避免重复计费，请先人工核对并结案',
    )
  }
  return new SQLiteRepositoryError('JOB_NOT_RETRYABLE', `Job is not retryable: ${job.id}`)
}

/**
 * generation_jobs stores JSON objects. Keep normal object payloads readable in
 * SQLite, but use a tagged envelope for arrays/primitives/undefined.
 */
function encodeJobValue(value: unknown): JsonObject {
  if (isPlainObject(value) && !Object.hasOwn(value, VALUE_ENVELOPE_KEY)) {
    return value as JsonObject
  }
  if (value === undefined) return { [VALUE_ENVELOPE_KEY]: 'undefined' }
  return {
    [VALUE_ENVELOPE_KEY]: 'value',
    value: value as JsonValue,
  }
}

function decodeJobValue(value: JsonObject): unknown {
  if (value[VALUE_ENVELOPE_KEY] === 'undefined') return undefined
  if (value[VALUE_ENVELOPE_KEY] === 'value' && Object.hasOwn(value, 'value')) return value.value
  return value
}

function optionalMetadataString(metadata: unknown, key: string): string | undefined {
  if (!isPlainObject(metadata)) return undefined
  const value = metadata[key]
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function normalizedOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function requireProjectId(request: CreateJobRequest, fallback: string | undefined): string {
  const projectId = normalizedOptionalString(request.projectId) ?? normalizedOptionalString(fallback)
  if (!projectId) {
    throw new SQLiteRepositoryError(
      'PROJECT_ID_REQUIRED',
      'SQLite job persistence requires projectId or a defaultProjectId',
    )
  }
  return projectId
}

function providerConfigRevision(value: number | undefined): number | null {
  if (value === undefined) return null
  if (!Number.isInteger(value) || value < 1) {
    throw new SQLiteRepositoryError(
      'INVALID_JOB_DATA',
      'providerConfigRevision must be a positive integer',
    )
  }
  return value
}

function asJobError(value: JsonObject | null): JobErrorInfo | undefined {
  if (!value) return undefined
  const category = typeof value.category === 'string' && ERROR_CATEGORIES.has(value.category as JobErrorCategory)
    ? value.category as JobErrorCategory
    : 'internal'
  return {
    code: typeof value.code === 'string' ? value.code : 'JOB_FAILED',
    message: typeof value.message === 'string' ? value.message : '任务失败',
    retryable: value.retryable === true,
    category,
    ...(isPlainObject(value.diagnostics)
      ? { diagnostics: value.diagnostics as JsonObject }
      : {}),
  }
}

function mapJob(record: GenerationJobRecord): JobRecord {
  const providerState = decodeJobValue(record.providerState)
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    input: decodeJobValue(record.input),
    progress: record.progress,
    attempt: record.attempt,
    projectId: record.projectId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.providerId ? { providerId: record.providerId } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.providerConfigRevision !== null
      ? { providerConfigRevision: record.providerConfigRevision }
      : {}),
    ...(record.resourceType ? { resourceKey: record.resourceType } : {}),
    ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
    ...(record.output !== null ? { output: decodeJobValue(record.output) } : {}),
    ...(record.error ? { error: asJobError(record.error) } : {}),
    ...(record.retryOf ? { retryOf: record.retryOf } : {}),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.status === 'waiting_provider' || Object.keys(record.providerState).length > 0
      ? { providerState }
      : {}),
  }
}

/**
 * Materialize catalog providers as FK targets without overwriting any saved
 * user configuration. This is safe to call during every repository startup.
 */
export function seedProviderCatalogConnections(database: ManjuDatabase): DatabaseProviderConnectionRecord[] {
  return database.transaction((transaction) => PROVIDER_CATALOG.map((definition) => {
    const existing = transaction.getProviderConnection(definition.id)
    if (existing) return existing
    return transaction.createProviderConnection({
      id: definition.id,
      kind: definition.kind,
      adapter: definition.adapter,
      displayName: definition.label,
      baseUrl: definition.defaultBaseUrl,
      defaultModel: definition.defaultModel,
      authMode: definition.authMode,
      config: { isDefault: DEFAULT_PROVIDER_IDS.has(definition.id) },
      enabled: definition.authMode === 'byoa',
    })
  }))
}

function listAllJobs(
  database: ManjuDatabase,
  options: { projectId?: string; status?: JobStatus } = {},
): GenerationJobRecord[] {
  const jobs: GenerationJobRecord[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = database.listGenerationJobs({ ...options, limit: PAGE_SIZE, offset })
    jobs.push(...page)
    if (page.length < PAGE_SIZE) return jobs
  }
}

function retryChild(database: ManjuDatabase, source: GenerationJobRecord): GenerationJobRecord | undefined {
  return listAllJobs(database, { projectId: source.projectId })
    .find((candidate) => candidate.retryOf === source.id)
}

export class SQLiteJobRepository implements JobRepository {
  private readonly defaultProjectId?: string
  private readonly now: () => string

  constructor(
    private readonly database: ManjuDatabase,
    options: SQLiteJobRepositoryOptions = {},
  ) {
    seedProviderCatalogConnections(database)
    this.defaultProjectId = options.defaultProjectId
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async create(request: CreateJobRequest): Promise<JobCreationResult> {
    return this.database.transaction((database) => {
      const projectId = requireProjectId(request, this.defaultProjectId)
      const idempotencyKey = request.idempotencyKey.trim()
      if (!idempotencyKey) {
        throw new SQLiteRepositoryError('INVALID_JOB_DATA', 'idempotencyKey must not be empty')
      }
      const existing = database.findGenerationJobByIdempotencyKey(projectId, idempotencyKey)
      if (existing) return { job: mapJob(existing), created: false }

      const type = request.type.trim()
      if (!type) throw new SQLiteRepositoryError('INVALID_JOB_DATA', 'job type must not be empty')
      const resourceKey = normalizedOptionalString(request.resourceKey)
      const created = database.createGenerationJob({
        projectId,
        episodeId: optionalMetadataString(request.metadata, 'episodeId') ?? null,
        pipelineRunId: optionalMetadataString(request.metadata, 'pipelineRunId') ?? null,
        type,
        status: 'queued',
        progress: 0,
        resourceType: resourceKey ?? null,
        resourceId: optionalMetadataString(request.metadata, 'resourceId') ?? null,
        providerId: normalizedOptionalString(request.providerId) ?? null,
        model: normalizedOptionalString(request.model) ?? null,
        providerConfigRevision: providerConfigRevision(request.providerConfigRevision),
        idempotencyKey,
        attempt: 1,
        input: encodeJobValue(request.input),
      })
      return { job: mapJob(created), created: true }
    })
  }

  /**
   * Synchronous admission hint used by HTTP routes before queue-capacity
   * accounting. `retry()` repeats the same check transactionally.
   */
  retryDisposition(jobId: string): JobRetryDisposition {
    const source = this.database.getGenerationJob(jobId)
    if (!source) throw new SQLiteRepositoryError('JOB_NOT_FOUND', `Job not found: ${jobId}`)
    return jobRetryDisposition(this.database, source)
  }

  assertGenericRetryAllowed(jobId: string): JobRetryDisposition {
    const source = this.database.getGenerationJob(jobId)
    if (!source) throw new SQLiteRepositoryError('JOB_NOT_FOUND', `Job not found: ${jobId}`)
    const disposition = jobRetryDisposition(this.database, source)
    if (!genericRetryAllowed(disposition)) throw retryDispositionError(source, disposition)
    return disposition
  }

  /**
   * Capacity admission must not reject an exact replay merely because the
   * already-created retry child itself occupies the final queue slot.
   * `retry()` still repeats the authoritative disposition and lineage checks
   * transactionally before returning that child.
   */
  hasRetryChild(jobId: string): boolean {
    const source = this.database.getGenerationJob(jobId)
    if (!source) throw new SQLiteRepositoryError('JOB_NOT_FOUND', `Job not found: ${jobId}`)
    return retryChild(this.database, source) !== undefined
  }

  async retry(jobId: string, request: RetryJobRequest = {}): Promise<JobCreationResult> {
    return this.database.transaction((database) => {
      const source = database.getGenerationJob(jobId)
      if (!source) throw new SQLiteRepositoryError('JOB_NOT_FOUND', `Job not found: ${jobId}`)
      const disposition = jobRetryDisposition(database, source)
      if (!genericRetryAllowed(disposition)) throw retryDispositionError(source, disposition)

      // A failed node has at most one child. Further attempts retry that child,
      // producing a linear audit chain and preventing duplicate provider charges.
      const existingChild = retryChild(database, source)
      if (existingChild) return { job: mapJob(existingChild), created: false }

      const idempotencyKey = request.idempotencyKey?.trim() || `retry:${source.id}`
      const idempotencyCollision = database.findGenerationJobByIdempotencyKey(source.projectId, idempotencyKey)
      if (idempotencyCollision) {
        if (idempotencyCollision.retryOf === source.id) {
          return { job: mapJob(idempotencyCollision), created: false }
        }
        throw new SQLiteRepositoryError(
          'IDEMPOTENCY_CONFLICT',
          `Idempotency key already belongs to another job: ${idempotencyKey}`,
        )
      }

      const resourceKey = normalizedOptionalString(request.resourceKey)
      const created = database.createGenerationJob({
        projectId: source.projectId,
        episodeId: optionalMetadataString(request.metadata, 'episodeId') ?? source.episodeId,
        pipelineRunId: optionalMetadataString(request.metadata, 'pipelineRunId') ?? source.pipelineRunId,
        type: source.type,
        status: 'queued',
        progress: 0,
        resourceType: resourceKey ?? source.resourceType,
        resourceId: optionalMetadataString(request.metadata, 'resourceId') ?? source.resourceId,
        providerId: source.providerId,
        model: source.model,
        providerConfigRevision: source.providerConfigRevision,
        idempotencyKey,
        retryOf: source.id,
        attempt: source.attempt + 1,
        input: source.input,
      })
      return { job: mapJob(created), created: true }
    })
  }

  async get(jobId: string): Promise<JobRecord | undefined> {
    const record = this.database.getGenerationJob(jobId)
    return record ? mapJob(record) : undefined
  }

  async recoverRunnable(): Promise<JobRecord[]> {
    return this.database.transaction((database) => {
      for (const interrupted of listAllJobs(database, { status: 'running' })) {
        database.updateGenerationJob(interrupted.id, { status: 'queued', startedAt: null })
      }

      const runnable = RUNNABLE_STATUSES.flatMap((status) => listAllJobs(database, { status }))
      runnable.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      return runnable.map(mapJob)
    })
  }

  async claim(jobId: string): Promise<JobRecord | undefined> {
    return this.database.transaction((database) => {
      const current = database.getGenerationJob(jobId)
      if (!current || (current.status !== 'queued' && current.status !== 'waiting_provider')) return undefined
      const updated = database.updateGenerationJob(jobId, {
        status: 'running',
        startedAt: current.startedAt ?? this.now(),
      })
      return updated ? mapJob(updated) : undefined
    })
  }

  async updateProgress(jobId: string, progress: number, detail?: unknown): Promise<JobRecord | undefined> {
    return this.database.transaction((database) => {
      const current = database.getGenerationJob(jobId)
      if (!current || !ACTIVE_STATUSES.has(current.status)) return undefined
      const updated = database.updateGenerationJob(jobId, {
        progress,
        ...(detail !== undefined ? { progressDetail: encodeJobValue(detail) } : {}),
      })
      return updated ? mapJob(updated) : undefined
    })
  }

  async markWaitingProvider(jobId: string, providerState?: unknown): Promise<JobRecord | undefined> {
    return this.database.transaction((database) => {
      const current = database.getGenerationJob(jobId)
      if (!current || (current.status !== 'running' && current.status !== 'waiting_provider')) return undefined
      const updated = database.updateGenerationJob(jobId, {
        status: 'waiting_provider',
        providerState: encodeJobValue(providerState),
      })
      return updated ? mapJob(updated) : undefined
    })
  }

  async succeed(jobId: string, output: unknown): Promise<JobRecord | undefined> {
    return this.database.transaction((database) => {
      const current = database.getGenerationJob(jobId)
      if (!current || !ACTIVE_STATUSES.has(current.status)) return undefined
      const updated = database.updateGenerationJob(jobId, {
        status: 'succeeded',
        progress: 100,
        output: encodeJobValue(output),
        error: null,
        completedAt: this.now(),
      })
      return updated ? mapJob(updated) : undefined
    })
  }

  async fail(jobId: string, error: JobErrorInfo): Promise<JobRecord | undefined> {
    return this.database.transaction((database) => {
      const current = database.getGenerationJob(jobId)
      if (!current || !ACTIVE_STATUSES.has(current.status)) return undefined
      const updated = database.updateGenerationJob(jobId, {
        status: 'failed',
        error: { ...error },
        completedAt: this.now(),
      })
      return updated ? mapJob(updated) : undefined
    })
  }

  async cancel(jobId: string, error: JobErrorInfo): Promise<JobRecord | undefined> {
    return this.database.transaction((database) => {
      const current = database.getGenerationJob(jobId)
      if (!current) return undefined
      if (TERMINAL_STATUSES.has(current.status)) return mapJob(current)
      if (jobHasUnknownSubmission(database, current)) {
        const failed = database.updateGenerationJob(jobId, {
          status: 'failed',
          error: {
            code: PROVIDER_SUBMISSION_OUTCOME_UNKNOWN,
            message: isFreeLlmAgenticJobType(current.type)
              ? FREE_LLM_SUBMISSION_OUTCOME_UNKNOWN_MESSAGE
              : PAID_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN_MESSAGE,
            retryable: false,
            category: 'provider',
          },
          completedAt: this.now(),
        })
        return failed ? mapJob(failed) : undefined
      }
      const updated = database.updateGenerationJob(jobId, {
        status: 'cancelled',
        error: { ...error },
        completedAt: this.now(),
      })
      return updated ? mapJob(updated) : undefined
    })
  }
}

function configBoolean(config: JsonObject, key: string, fallback = false): boolean {
  return typeof config[key] === 'boolean' ? config[key] : fallback
}

function configString(config: JsonObject, key: string): string | undefined {
  return typeof config[key] === 'string' ? config[key] : undefined
}

function credentialReferenceUri(reference: KeychainReference | null): string | undefined {
  if (!reference) return undefined
  return `keychain://${encodeURIComponent(reference.service)}/${encodeURIComponent(reference.account)}`
}

function parseCredentialReference(value: string | undefined): KeychainReference | null {
  if (value === undefined) return null
  const match = /^keychain:\/\/([^/?#]+)\/([^/?#]+)$/.exec(value)
  if (!match) {
    throw new SQLiteRepositoryError(
      'INVALID_CREDENTIAL_REFERENCE',
      'credentialRef must be an opaque keychain:// service/account reference',
    )
  }
  let service: string
  let account: string
  try {
    service = decodeURIComponent(match[1])
    account = decodeURIComponent(match[2])
  } catch (error) {
    throw new SQLiteRepositoryError(
      'INVALID_CREDENTIAL_REFERENCE',
      'credentialRef contains invalid percent encoding',
      { cause: error },
    )
  }
  if (!service || !account || service.length > 500 || account.length > 500
    || /[\u0000-\u001f\u007f]/.test(service) || /[\u0000-\u001f\u007f]/.test(account)) {
    throw new SQLiteRepositoryError(
      'INVALID_CREDENTIAL_REFERENCE',
      'credentialRef service/account is invalid',
    )
  }
  return { service, account }
}

function mapProvider(record: DatabaseProviderConnectionRecord): ServiceProviderConnectionRecord {
  const status = configString(record.config, 'lastTestStatus')
  return {
    providerId: record.id,
    configRevision: record.configRevision,
    enabled: record.enabled,
    isDefault: configBoolean(record.config, 'isDefault'),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
    ...(record.defaultModel !== null ? { model: record.defaultModel } : {}),
    ...(record.credentialReference
      ? { credentialRef: credentialReferenceUri(record.credentialReference) }
      : {}),
    ...(configString(record.config, 'lastTestedAt')
      ? { lastTestedAt: configString(record.config, 'lastTestedAt') }
      : {}),
    ...(status && HEALTH_STATES.has(status as ProviderHealthState)
      ? { lastTestStatus: status as ProviderHealthState }
      : {}),
    ...(configString(record.config, 'lastTestMessage')
      ? { lastTestMessage: configString(record.config, 'lastTestMessage') }
      : {}),
  }
}

function mapProviderVersion(
  record: DatabaseProviderConnectionVersionRecord,
): ServiceProviderConnectionVersionRecord {
  return {
    providerId: record.providerId,
    configRevision: record.configRevision,
    kind: record.kind,
    adapter: record.adapter,
    authMode: record.authMode,
    executionConfig: structuredClone(record.executionConfig),
    createdAt: record.createdAt,
    ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
    ...(record.model !== null ? { model: record.model } : {}),
    ...(record.credentialReference
      ? { credentialRef: credentialReferenceUri(record.credentialReference) }
      : {}),
  }
}

function applyProviderConfigUpdate(
  config: JsonObject,
  update: Partial<Omit<
    ServiceProviderConnectionRecord,
    'providerId' | 'configRevision' | 'createdAt' | 'updatedAt'
  >>,
): JsonObject {
  const next = { ...config }
  if (Object.hasOwn(update, 'isDefault')) next.isDefault = update.isDefault === true

  for (const key of ['lastTestedAt', 'lastTestStatus', 'lastTestMessage'] as const) {
    if (!Object.hasOwn(update, key)) continue
    const value = update[key]
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  if (typeof next.lastTestStatus === 'string'
    && !HEALTH_STATES.has(next.lastTestStatus as ProviderHealthState)) {
    throw new TypeError(`Unsupported Provider health state: ${next.lastTestStatus}`)
  }
  return next
}

function requireProvider(providerId: string) {
  const definition = getProviderDefinition(providerId)
  if (!definition) {
    throw new SQLiteRepositoryError('PROVIDER_NOT_FOUND', `Unknown Provider: ${providerId}`)
  }
  return definition
}

export class SQLiteProviderConnectionRepository implements ProviderConnectionRepository {
  constructor(private readonly database: ManjuDatabase) {
    seedProviderCatalogConnections(database)
  }

  listProviderConnections(): ServiceProviderConnectionRecord[] {
    return this.database.listProviderConnections().map(mapProvider)
  }

  getProviderConnection(providerId: string): ServiceProviderConnectionRecord | undefined {
    const record = this.database.getProviderConnection(providerId)
    return record ? mapProvider(record) : undefined
  }

  getProviderConnectionVersion(
    providerId: string,
    configRevision: number,
  ): ServiceProviderConnectionVersionRecord | undefined {
    const record = this.database.getProviderConnectionVersion(providerId, configRevision)
    return record ? mapProviderVersion(record) : undefined
  }

  listProviderConnectionVersions(providerId: string): ServiceProviderConnectionVersionRecord[] {
    return this.database.listProviderConnectionVersions(providerId).map(mapProviderVersion)
  }

  upsertProviderConnection(
    providerId: string,
    update: Partial<Omit<
      ServiceProviderConnectionRecord,
      'providerId' | 'configRevision' | 'createdAt' | 'updatedAt'
    >>,
  ): ServiceProviderConnectionRecord {
    return this.database.transaction((database) => {
      const definition = requireProvider(providerId)
      const current = database.getProviderConnection(providerId)
      const config = applyProviderConfigUpdate(current?.config ?? { isDefault: false }, update)
      const credentialReference = Object.hasOwn(update, 'credentialRef')
        ? parseCredentialReference(update.credentialRef)
        : undefined

      const record = current
        ? database.updateProviderConnection(providerId, {
            ...(update.baseUrl !== undefined ? { baseUrl: update.baseUrl } : {}),
            ...(update.model !== undefined ? { defaultModel: update.model } : {}),
            ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
            ...(credentialReference !== undefined ? { credentialReference } : {}),
            config,
          })
        : database.createProviderConnection({
            id: providerId,
            kind: definition.kind,
            adapter: definition.adapter,
            displayName: definition.label,
            baseUrl: update.baseUrl ?? definition.defaultBaseUrl,
            defaultModel: update.model ?? definition.defaultModel,
            authMode: definition.authMode,
            credentialReference: credentialReference ?? null,
            config,
            enabled: update.enabled ?? definition.authMode === 'byoa',
          })
      if (!record) throw new Error(`Provider disappeared during upsert: ${providerId}`)
      return mapProvider(record)
    })
  }

  setDefaultProvider(providerId: string, kind: ProviderKind): ServiceProviderConnectionRecord {
    return this.database.transaction((database) => {
      const definition = requireProvider(providerId)
      if (definition.kind !== kind) {
        throw new SQLiteRepositoryError(
          'PROVIDER_KIND_MISMATCH',
          `Provider ${providerId} is ${definition.kind}, not ${kind}`,
        )
      }

      if (!database.getProviderConnection(providerId)) {
        this.upsertProviderConnection(providerId, { isDefault: true })
      }
      for (const record of database.listProviderConnections(kind)) {
        const config = { ...record.config, isDefault: record.id === providerId }
        database.updateProviderConnection(record.id, { config })
      }
      const selected = database.getProviderConnection(providerId)
      if (!selected) throw new Error(`Provider disappeared while becoming default: ${providerId}`)
      return mapProvider(selected)
    })
  }
}
