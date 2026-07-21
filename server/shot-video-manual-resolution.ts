import type {
  GenerationJobRecord,
  ManjuDatabase,
  RevisionRecord,
} from './database.js'
import { SHOT_VIDEO_GENERATION_JOB_TYPE } from './shot-video-generation.js'
import type { JsonObject } from './types.js'

export const SHOT_VIDEO_UNKNOWN_RESOLUTION_KIND = 'shot.video.unknown-submission-resolution'
export const SHOT_VIDEO_UNKNOWN_RESOLUTION_PROGRESS_KEY = 'manualUnknownSubmissionResolution'

const UNKNOWN_ERROR_CODES = new Set([
  'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
  'PROVIDER_TASK_CONFLICT',
])

const RESOLVED_ERROR_CODE = 'PROVIDER_SUBMISSION_CONFIRMED_NOT_CREATED'

type SqlRow = Record<string, unknown>

export interface ShotVideoUnknownSubmissionResolution {
  version: 1
  auditRevisionId: string
  jobId: string
  projectId: string
  episodeId: string
  shotId: string
  expectedSourceRevisionId: string
  resolution: 'confirmed-not-created'
  confirmedProviderConsoleChecked: true
  note: string
  resolvedAt: string
  provider: {
    id: string
    configRevision: number
    model: string
    baseUrl: string | null
  }
}

export interface ShotVideoManualResolutionRequest {
  projectId: string
  resolution: 'confirmed-not-created'
  confirmedProviderConsoleChecked: true
  note: string
}

export class ShotVideoManualResolutionError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'JOB_NOT_FOUND'
      | 'VIDEO_UNKNOWN_SUBMISSION_NOT_RESOLVABLE'
      | 'VIDEO_UNKNOWN_SUBMISSION_RESOLUTION_CORRUPT'
      | 'VIDEO_UNKNOWN_SUBMISSION_RESOLUTION_CONFLICT'
      | 'INVALID_VIDEO_MANUAL_RESOLUTION',
    message: string,
  ) {
    super(message)
    this.name = 'ShotVideoManualResolutionError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key))
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ShotVideoManualResolutionError(
      409,
      'VIDEO_UNKNOWN_SUBMISSION_NOT_RESOLVABLE',
      `${label} 缺失，无法安全解除隔离`,
    )
  }
  return value.trim()
}

function jobErrorCode(job: GenerationJobRecord): string | null {
  return isRecord(job.error) && typeof job.error.code === 'string' ? job.error.code : null
}

function originalUnknownError(job: GenerationJobRecord): JsonObject | null {
  if (!isRecord(job.error)) return null
  const code = typeof job.error.code === 'string' ? job.error.code : null
  if (code && UNKNOWN_ERROR_CODES.has(code)) return job.error as JsonObject
  if (code !== RESOLVED_ERROR_CODE || !isRecord(job.error.originalError)) return null
  const originalCode = typeof job.error.originalError.code === 'string'
    ? job.error.originalError.code
    : null
  return originalCode && UNKNOWN_ERROR_CODES.has(originalCode)
    ? job.error.originalError as JsonObject
    : null
}

function providerStateHasExternalTaskReference(job: GenerationJobRecord): boolean {
  if (!isRecord(job.providerState)) return false
  const value = job.providerState.externalTaskId
  if (value === undefined || value === null) return false
  return typeof value !== 'string' || Boolean(value.trim())
}

function jobBinding(job: GenerationJobRecord): {
  episodeId: string
  shotId: string
  expectedSourceRevisionId: string
} {
  const binding = isRecord(job.input) && isRecord(job.input.binding) ? job.input.binding : null
  if (!binding) {
    throw new ShotVideoManualResolutionError(
      409,
      'VIDEO_UNKNOWN_SUBMISSION_NOT_RESOLVABLE',
      '历史任务缺少不可变镜头绑定，无法安全解除隔离',
    )
  }
  return {
    episodeId: requiredString(binding.episodeId, 'episodeId'),
    shotId: requiredString(binding.shotId, 'shotId'),
    expectedSourceRevisionId: requiredString(binding.expectedRevisionId, 'expectedRevisionId'),
  }
}

function assertResolvable(job: GenerationJobRecord, projectId: string): void {
  if (job.projectId !== projectId
    || job.type !== SHOT_VIDEO_GENERATION_JOB_TYPE
    || job.status !== 'failed'
    || job.externalTaskId !== null
    || providerStateHasExternalTaskReference(job)
    || !originalUnknownError(job)
    || !job.providerId
    || job.providerConfigRevision === null
    || !job.model) {
    throw new ShotVideoManualResolutionError(
      409,
      'VIDEO_UNKNOWN_SUBMISSION_NOT_RESOLVABLE',
      '该任务不是可人工结案的 Seedance 未知提交结果',
    )
  }
  const binding = jobBinding(job)
  const providerState = isRecord(job.providerState) ? job.providerState : null
  const spec = isRecord(job.input.spec) ? job.input.spec : null
  if (job.episodeId !== binding.episodeId
    || job.resourceId !== binding.shotId
    || (providerState?.providerId !== undefined && providerState.providerId !== job.providerId)
    || (providerState?.providerConfigRevision !== undefined
      && providerState.providerConfigRevision !== job.providerConfigRevision)
    || (spec?.sourceRevisionId !== undefined
      && spec.sourceRevisionId !== binding.expectedSourceRevisionId)) {
    throw new ShotVideoManualResolutionError(
      409,
      'VIDEO_UNKNOWN_SUBMISSION_NOT_RESOLVABLE',
      '历史任务的镜头归属不一致，无法安全解除隔离',
    )
  }
}

function progressPointer(job: GenerationJobRecord): Record<string, unknown> | null {
  const value = isRecord(job.progressDetail)
    ? job.progressDetail[SHOT_VIDEO_UNKNOWN_RESOLUTION_PROGRESS_KEY]
    : undefined
  return isRecord(value) ? value : null
}

function parseResolutionSnapshot(
  database: ManjuDatabase,
  revision: RevisionRecord,
  job: GenerationJobRecord,
): ShotVideoUnknownSubmissionResolution {
  const snapshot = revision.snapshot
  const binding = jobBinding(job)
  const provider = isRecord(snapshot.provider) ? snapshot.provider : null
  const providerVersion = job.providerId && job.providerConfigRevision !== null
    ? providerVersionRow(database, job.providerId, job.providerConfigRevision)
    : undefined
  const sourceRevision = database.getRevision(binding.expectedSourceRevisionId)
  const expectedBaseUrl = providerVersion && typeof providerVersion.base_url === 'string'
    ? providerVersion.base_url
    : null
  const errorAuditRevisionId = jobErrorCode(job) === RESOLVED_ERROR_CODE && isRecord(job.error)
    ? job.error.auditRevisionId
    : undefined
  if (!hasExactKeys(snapshot, [
    'kind',
    'version',
    'auditRevisionId',
    'jobId',
    'projectId',
    'episodeId',
    'shotId',
    'expectedSourceRevisionId',
    'resolution',
    'confirmedProviderConsoleChecked',
    'note',
    'resolvedAt',
    'provider',
  ])
    || !provider
    || !hasExactKeys(provider, ['id', 'configRevision', 'model', 'baseUrl'])
    || revision.projectId !== job.projectId
    || revision.createdAt !== snapshot.resolvedAt
    || snapshot.version !== 1
    || snapshot.kind !== SHOT_VIDEO_UNKNOWN_RESOLUTION_KIND
    || snapshot.auditRevisionId !== revision.id
    || snapshot.jobId !== job.id
    || snapshot.projectId !== job.projectId
    || snapshot.episodeId !== binding.episodeId
    || snapshot.shotId !== binding.shotId
    || snapshot.expectedSourceRevisionId !== binding.expectedSourceRevisionId
    || snapshot.resolution !== 'confirmed-not-created'
    || snapshot.confirmedProviderConsoleChecked !== true
    || typeof snapshot.note !== 'string'
    || !snapshot.note.trim()
    || snapshot.note !== snapshot.note.trim()
    || snapshot.note.length < 10
    || snapshot.note.length > 500
    || typeof snapshot.resolvedAt !== 'string'
    || !Number.isFinite(Date.parse(snapshot.resolvedAt))
    || provider.id !== job.providerId
    || provider.configRevision !== job.providerConfigRevision
    || provider.model !== job.model
    || !providerVersion
    || providerVersion.model !== job.model
    || provider.baseUrl !== expectedBaseUrl
    || !sourceRevision
    || sourceRevision.projectId !== job.projectId
    || jobErrorCode(job) !== RESOLVED_ERROR_CODE
    || errorAuditRevisionId !== revision.id) {
    throw new ShotVideoManualResolutionError(
      409,
      'VIDEO_UNKNOWN_SUBMISSION_RESOLUTION_CORRUPT',
      'Seedance 人工结案审计与历史任务不一致，仍保持隔离',
    )
  }
  return snapshot as unknown as ShotVideoUnknownSubmissionResolution
}

export function readShotVideoUnknownSubmissionResolution(
  database: ManjuDatabase,
  job: GenerationJobRecord,
): ShotVideoUnknownSubmissionResolution | undefined {
  assertResolvable(job, job.projectId)
  const pointer = progressPointer(job)
  if (!pointer) return undefined
  if (!hasExactKeys(pointer, ['version', 'auditRevisionId', 'resolution', 'resolvedAt'])
    || pointer.version !== 1
    || pointer.resolution !== 'confirmed-not-created'
    || typeof pointer.auditRevisionId !== 'string'
    || !pointer.auditRevisionId) {
    throw new ShotVideoManualResolutionError(
      409,
      'VIDEO_UNKNOWN_SUBMISSION_RESOLUTION_CORRUPT',
      'Seedance 人工结案指针无效，仍保持隔离',
    )
  }
  const revision = database.getRevision(pointer.auditRevisionId)
  if (!revision) {
    throw new ShotVideoManualResolutionError(
      409,
      'VIDEO_UNKNOWN_SUBMISSION_RESOLUTION_CORRUPT',
      'Seedance 人工结案审计不存在，仍保持隔离',
    )
  }
  const resolution = parseResolutionSnapshot(database, revision, job)
  if (pointer.resolvedAt !== resolution.resolvedAt) {
    throw new ShotVideoManualResolutionError(
      409,
      'VIDEO_UNKNOWN_SUBMISSION_RESOLUTION_CORRUPT',
      'Seedance 人工结案时间戳不一致，仍保持隔离',
    )
  }
  return resolution
}

function safeNote(value: string): string {
  const note = value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
  if (note.length < 10 || note.length > 500) {
    throw new ShotVideoManualResolutionError(
      400,
      'INVALID_VIDEO_MANUAL_RESOLUTION',
      '人工核对备注必须为 10 到 500 个字符',
    )
  }
  return note
}

function publicIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ShotVideoManualResolutionError(
      400,
      'INVALID_VIDEO_MANUAL_RESOLUTION',
      `${label} 必须是字符串`,
    )
  }
  const normalized = value.trim()
  if (!normalized
    || normalized.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)) {
    throw new ShotVideoManualResolutionError(
      400,
      'INVALID_VIDEO_MANUAL_RESOLUTION',
      `${label} 格式无效`,
    )
  }
  return normalized
}

export function parseShotVideoManualResolutionRequest(
  value: unknown,
): ShotVideoManualResolutionRequest {
  if (!isRecord(value)) {
    throw new ShotVideoManualResolutionError(
      400,
      'INVALID_VIDEO_MANUAL_RESOLUTION',
      'Seedance 人工结案请求必须是严格 JSON 对象',
    )
  }
  const expectedKeys = new Set([
    'projectId',
    'resolution',
    'confirmedProviderConsoleChecked',
    'note',
  ])
  if (Object.keys(value).length !== expectedKeys.size
    || Object.keys(value).some((key) => !expectedKeys.has(key))) {
    throw new ShotVideoManualResolutionError(
      400,
      'INVALID_VIDEO_MANUAL_RESOLUTION',
      'Seedance 人工结案请求包含缺失或未知字段',
    )
  }
  if (value.resolution !== 'confirmed-not-created') {
    throw new ShotVideoManualResolutionError(
      400,
      'INVALID_VIDEO_MANUAL_RESOLUTION',
      'resolution 当前仅支持 confirmed-not-created',
    )
  }
  if (value.confirmedProviderConsoleChecked !== true) {
    throw new ShotVideoManualResolutionError(
      400,
      'INVALID_VIDEO_MANUAL_RESOLUTION',
      '必须明确确认已核对该历史任务绑定的供应商控制台',
    )
  }
  return {
    projectId: publicIdentifier(value.projectId, 'projectId'),
    resolution: 'confirmed-not-created',
    confirmedProviderConsoleChecked: true,
    note: safeNote(typeof value.note === 'string' ? value.note : ''),
  }
}

function providerVersionRow(
  database: ManjuDatabase,
  providerId: string,
  configRevision: number,
): SqlRow | undefined {
  return database.withSql((sql) => sql.get(`
    SELECT base_url, model
      FROM provider_connection_versions
     WHERE provider_id = ? AND config_revision = ?
  `, providerId, configRevision))
}

export function confirmShotVideoUnknownSubmissionNotCreated(
  database: ManjuDatabase,
  input: {
    jobId: string
    projectId: string
    resolution: 'confirmed-not-created'
    confirmedProviderConsoleChecked: true
    note: string
  },
): { resolution: ShotVideoUnknownSubmissionResolution; idempotent: boolean } {
  if (input.resolution !== 'confirmed-not-created') {
    throw new ShotVideoManualResolutionError(
      400,
      'INVALID_VIDEO_MANUAL_RESOLUTION',
      'resolution 当前仅支持 confirmed-not-created',
    )
  }
  if (input.confirmedProviderConsoleChecked !== true) {
    throw new ShotVideoManualResolutionError(
      400,
      'INVALID_VIDEO_MANUAL_RESOLUTION',
      '必须明确确认已核对该历史任务绑定的供应商控制台',
    )
  }
  const note = safeNote(typeof input.note === 'string' ? input.note : '')
  return database.transaction(() => {
    const job = database.getGenerationJob(input.jobId)
    if (!job || job.projectId !== input.projectId) {
      throw new ShotVideoManualResolutionError(404, 'JOB_NOT_FOUND', '视频任务不存在')
    }
    assertResolvable(job, input.projectId)
    const existing = readShotVideoUnknownSubmissionResolution(database, job)
    if (existing) {
      if (existing.note !== note) {
        throw new ShotVideoManualResolutionError(
          409,
          'VIDEO_UNKNOWN_SUBMISSION_RESOLUTION_CONFLICT',
          '该未知提交结果已经使用另一份核对记录结案',
        )
      }
      return { resolution: existing, idempotent: true }
    }
    const binding = jobBinding(job)
    const version = providerVersionRow(database, job.providerId!, job.providerConfigRevision!)
    if (!version || version.model !== job.model) {
      throw new ShotVideoManualResolutionError(
        409,
        'VIDEO_UNKNOWN_SUBMISSION_NOT_RESOLVABLE',
        '历史 Provider 版本不可用，无法生成可信人工结案审计',
      )
    }
    const resolvedAt = new Date().toISOString()
    const revisionId = crypto.randomUUID()
    const resolution: ShotVideoUnknownSubmissionResolution = {
      version: 1,
      auditRevisionId: revisionId,
      jobId: job.id,
      projectId: job.projectId,
      episodeId: binding.episodeId,
      shotId: binding.shotId,
      expectedSourceRevisionId: binding.expectedSourceRevisionId,
      resolution: 'confirmed-not-created',
      confirmedProviderConsoleChecked: true,
      note,
      resolvedAt,
      provider: {
        id: job.providerId!,
        configRevision: job.providerConfigRevision!,
        model: job.model!,
        baseUrl: typeof version.base_url === 'string' ? version.base_url : null,
      },
    }
    database.createRevision({
      id: revisionId,
      projectId: job.projectId,
      summary: `人工结案 Seedance 未知提交 ${binding.shotId}`,
      snapshot: {
        kind: SHOT_VIDEO_UNKNOWN_RESOLUTION_KIND,
        ...(resolution as unknown as JsonObject),
      },
      createdAt: resolvedAt,
    })
    const latest = database.getGenerationJob(job.id)
    if (!latest
      || latest.status !== 'failed'
      || latest.externalTaskId !== null
      || providerStateHasExternalTaskReference(latest)
      || readShotVideoUnknownSubmissionResolution(database, latest)) {
      throw new ShotVideoManualResolutionError(
        409,
        'VIDEO_UNKNOWN_SUBMISSION_RESOLUTION_CONFLICT',
        '任务状态已变化，未解除隔离',
      )
    }
    const updated = database.updateGenerationJob(job.id, {
      progressDetail: {
        ...latest.progressDetail,
        [SHOT_VIDEO_UNKNOWN_RESOLUTION_PROGRESS_KEY]: {
          version: 1,
          auditRevisionId: revisionId,
          resolution: 'confirmed-not-created',
          resolvedAt,
        },
      },
      error: {
        code: RESOLVED_ERROR_CODE,
        message: '已由用户确认核对历史供应商控制台，未发现可接管任务；该镜头可重新预检。',
        retryable: false,
        category: 'manual_resolution',
        auditRevisionId: revisionId,
        originalError: originalUnknownError(latest)!,
      },
    })
    if (!updated) throw new Error('Resolved Seedance job disappeared')
    const persisted = readShotVideoUnknownSubmissionResolution(database, updated)
    if (!persisted) throw new Error('Seedance manual resolution disappeared')
    return { resolution: persisted, idempotent: false }
  })
}
