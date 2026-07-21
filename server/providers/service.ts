import { randomUUID } from 'node:crypto'

import { keychainReference, type KeychainCredentialSlot, type MacOSKeychain } from '../keychain.js'
import {
  PROVIDER_CATALOG,
  getProviderDefinition,
  validateProviderBaseUrl,
  type ProviderDefinition,
  type ProviderHealthState,
  type ProviderKind,
} from './catalog.js'

const MAX_MODEL_LENGTH = 200
const MAX_MINIMAX_PROBE_BODY_BYTES = 64 * 1024
const MAX_MODEL_PROBE_BODY_BYTES = 1024 * 1024
const TEST_TIMEOUT_MS = 8_000

export interface ProviderConnectionRecord {
  providerId: string
  configRevision: number
  enabled: boolean
  baseUrl?: string
  model?: string
  credentialRef?: string
  isDefault: boolean
  lastTestedAt?: string
  lastTestStatus?: ProviderHealthState
  lastTestMessage?: string
  createdAt: string
  updatedAt: string
}

export interface ProviderConnectionVersionRecord {
  providerId: string
  configRevision: number
  kind: ProviderKind
  adapter: string
  baseUrl?: string
  model?: string
  authMode: 'byoa' | 'byok' | 'none'
  credentialRef?: string
  executionConfig: Record<string, unknown>
  createdAt: string
}

export interface ProviderConnectionRepository {
  listProviderConnections(): ProviderConnectionRecord[]
  getProviderConnection(providerId: string): ProviderConnectionRecord | undefined
  getProviderConnectionVersion(
    providerId: string,
    configRevision: number,
  ): ProviderConnectionVersionRecord | undefined
  listProviderConnectionVersions(providerId: string): ProviderConnectionVersionRecord[]
  upsertProviderConnection(
    providerId: string,
    update: Partial<Omit<
      ProviderConnectionRecord,
      'providerId' | 'configRevision' | 'createdAt' | 'updatedAt'
    >>,
  ): ProviderConnectionRecord
  setDefaultProvider(providerId: string, kind: ProviderKind): ProviderConnectionRecord
}

export interface ProviderCredentialStore {
  get(slot: KeychainCredentialSlot): Promise<string | null>
  set(slot: KeychainCredentialSlot, secret: string): Promise<unknown>
  delete(slot: KeychainCredentialSlot): Promise<boolean>
  exists(slot: KeychainCredentialSlot): Promise<boolean>
}

export interface ProviderPublicState {
  id: string
  label: string
  kind: ProviderKind
  adapter: ProviderDefinition['adapter']
  authMode: ProviderDefinition['authMode']
  baseUrl: string
  model: string
  capabilities: string[]
  configurableBaseUrl: boolean
  enabled: boolean
  configRevision: number
  isDefault: boolean
  credentialState: 'external' | 'present' | 'missing'
  health: {
    status: ProviderHealthState
    message: string
    testedAt?: string
  }
}

/** Internal-only materialized profile. Never return this object from an API. */
export interface MaterializedProviderExecutionProfile extends ProviderConnectionVersionRecord {
  apiKey: string
}

export interface SaveProviderInput {
  apiKey?: string
  baseUrl?: string
  model?: string
  enabled?: boolean
}

export interface ProviderProbeResult {
  status: Exclude<ProviderHealthState, 'untested'>
  message: string
}

export type ProviderProbe = (
  provider: ProviderDefinition,
  configuration: { baseUrl: string; model: string; apiKey: string },
  signal: AbortSignal,
) => Promise<ProviderProbeResult>

export class ProviderConfigurationError extends Error {
  constructor(
    readonly code:
      | 'PROVIDER_NOT_FOUND'
      | 'PROVIDER_USES_BYOA'
      | 'PROVIDER_NOT_CONFIGURED'
      | 'PROVIDER_NOT_VERIFIED'
      | 'PROVIDER_VERSION_NOT_FOUND'
      | 'INVALID_PROVIDER_CONFIG',
    message: string,
  ) {
    super(message)
    this.name = 'ProviderConfigurationError'
  }
}

function legacySlot(providerId: string): KeychainCredentialSlot {
  return { providerId, credentialKind: 'api-key' }
}

function revisionSlot(providerId: string, configRevision: number): KeychainCredentialSlot {
  return { providerId, credentialKind: `api-key-r${configRevision}` }
}

function referenceUri(credentialSlot: KeychainCredentialSlot): string {
  const reference = keychainReference(credentialSlot)
  return `keychain://${encodeURIComponent(reference.service)}/${encodeURIComponent(reference.account)}`
}

function slotFromReference(providerId: string, value: string | undefined): KeychainCredentialSlot | undefined {
  if (!value) return undefined
  const match = /^keychain:\/\/([^/?#]+)\/([^/?#]+)$/.exec(value)
  if (!match) return undefined
  let service: string
  let account: string
  try {
    service = decodeURIComponent(match[1])
    account = decodeURIComponent(match[2])
  } catch {
    return undefined
  }
  const legacy = legacySlot(providerId)
  const legacyReference = keychainReference(legacy)
  if (service !== legacyReference.service) return undefined
  if (account === legacyReference.account) return legacy
  const prefix = legacyReference.account.slice(0, -'api-key'.length)
  if (!account.startsWith(prefix)) return undefined
  const credentialKind = account.slice(prefix.length)
  try {
    const candidate = { providerId, credentialKind }
    const canonical = keychainReference(candidate)
    return canonical.service === service && canonical.account === account ? candidate : undefined
  } catch {
    return undefined
  }
}

function currentCredentialSlot(
  providerId: string,
  record: ProviderConnectionRecord | undefined,
): KeychainCredentialSlot | undefined {
  const referenced = slotFromReference(providerId, record?.credentialRef)
  if (referenced) return referenced
  // v1 records predate versioned references. Once a later head explicitly has
  // no reference (for example after deleteCredential), do not resurrect a
  // legacy slot belonging to historical jobs.
  return !record || record.configRevision === 1 ? legacySlot(providerId) : undefined
}

function requireProvider(id: string): ProviderDefinition {
  const definition = getProviderDefinition(id)
  if (!definition) throw new ProviderConfigurationError('PROVIDER_NOT_FOUND', 'Provider 不存在')
  return definition
}

function cleanModel(value: string | undefined, fallback: string): string {
  const model = value === undefined ? fallback : value.trim()
  if (model.length > MAX_MODEL_LENGTH || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new ProviderConfigurationError('INVALID_PROVIDER_CONFIG', 'Provider 模型名无效')
  }
  return model
}

function requireConfiguredModel(definition: ProviderDefinition, model: string): void {
  if ((definition.adapter === 'openai-compatible' || definition.adapter === 'seedance')
    && !model.trim()) {
    throw new ProviderConfigurationError('PROVIDER_NOT_CONFIGURED', '请先填写 Provider 模型名')
  }
}

function resolvedConfiguration(
  definition: ProviderDefinition,
  record: ProviderConnectionRecord | undefined,
): { baseUrl: string; model: string } {
  return {
    baseUrl: record?.baseUrl || definition.defaultBaseUrl,
    model: record?.model ?? definition.defaultModel,
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'malformed' | 'oversized' }

type BoundedTextResult =
  | { ok: true; value: string }
  | { ok: false; reason: 'malformed' | 'oversized' }

async function readBoundedText(response: Response, maximumBytes: number): Promise<BoundedTextResult> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
      await discardResponseBody(response)
      return { ok: false, reason: 'oversized' }
    }
  }
  if (!response.body) return { ok: false, reason: 'malformed' }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let payload = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, reason: 'oversized' }
      }
      payload += decoder.decode(chunk.value, { stream: true })
    }
    payload += decoder.decode()
    return { ok: true, value: payload }
  } catch {
    await reader.cancel().catch(() => undefined)
    return { ok: false, reason: 'malformed' }
  } finally {
    reader.releaseLock()
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<BoundedJsonResult> {
  const body = await readBoundedText(response, maximumBytes)
  if (!body.ok) return body
  try {
    return { ok: true, value: JSON.parse(body.value) as unknown }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

async function readBoundedJsonLines(response: Response, maximumBytes: number): Promise<BoundedJsonResult> {
  const body = await readBoundedText(response, maximumBytes)
  if (!body.ok) return body
  const records: unknown[] = []
  try {
    for (const line of body.value.split(/\r?\n/)) {
      if (!line.trim()) continue
      records.push(JSON.parse(line) as unknown)
    }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const businessRecords = records.filter(
    (value): value is Record<string, unknown> => isRecord(value) && Number.isInteger(value.code),
  )
  const businessRecord = businessRecords.find((value) => value.code !== 0 && value.code !== 20000000)
    ?? businessRecords[0]
  return businessRecord === undefined
    ? { ok: false, reason: 'malformed' }
    : { ok: true, value: businessRecord }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function minimaxProbeResult(payload: unknown): ProviderProbeResult {
  const baseResponse = isRecord(payload) && isRecord(payload.base_resp) ? payload.base_resp : undefined
  const statusCode = baseResponse?.status_code
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode)) {
    return { status: 'degraded', message: 'MiniMax 返回了无效响应' }
  }
  if (statusCode === 0) return { status: 'ok', message: '连接成功' }
  if (statusCode === 1004 || statusCode === 2049) {
    return { status: 'unavailable', message: 'MiniMax API Key 无效或无权访问' }
  }
  if (statusCode === 1008) {
    return { status: 'unavailable', message: 'MiniMax 账户余额不足或不可用' }
  }
  if (statusCode === 1002) {
    return { status: 'degraded', message: 'MiniMax 请求频率受限 (1002)' }
  }
  return { status: 'degraded', message: `MiniMax 暂时不可用 (${statusCode})` }
}

function seedanceModelProbeResult(payload: unknown, expectedModel: string): ProviderProbeResult {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return { status: 'degraded', message: 'Provider 返回了无效模型列表' }
  }
  const modelIds = payload.data.flatMap((item): string[] => {
    if (typeof item === 'string') return [item]
    return isRecord(item) && typeof item.id === 'string' ? [item.id] : []
  })
  if (!modelIds.includes(expectedModel)) {
    return { status: 'unavailable', message: '连接成功，但当前 Key 不可用指定 Seedance 模型' }
  }
  return { status: 'ok', message: '连接成功，已确认 Seedance 模型可用' }
}

function indexTtsProbeResult(payload: unknown, expectedModel: string): ProviderProbeResult {
  if (!isRecord(payload)
    || typeof payload.status !== 'string'
    || typeof payload.model !== 'string'
    || typeof payload.voice_count !== 'number') {
    return { status: 'degraded', message: 'IndexTTS Sidecar 返回了无效健康状态' }
  }
  if (payload.model !== expectedModel) {
    return { status: 'unavailable', message: 'Sidecar 模型与当前配置不匹配' }
  }
  if (payload.status !== 'ready') {
    const missing = Array.isArray(payload.missing_model_files)
      ? payload.missing_model_files.filter((item): item is string => typeof item === 'string').slice(0, 4)
      : []
    return {
      status: 'unavailable',
      message: missing.length > 0
        ? `IndexTTS 模型文件未就绪：${missing.join('、')}`
        : 'IndexTTS 尚无可用参考声线',
    }
  }
  if (!Number.isInteger(payload.voice_count) || payload.voice_count < 1) {
    return { status: 'unavailable', message: 'IndexTTS 尚无可用参考声线' }
  }
  return { status: 'ok', message: `连接成功，发现 ${payload.voice_count} 条 IndexTTS 声线` }
}

function doubaoSpeechProbeResult(payload: unknown): ProviderProbeResult {
  if (!isRecord(payload) || !Number.isInteger(payload.code)) {
    return { status: 'degraded', message: '豆包语音返回了无效探测响应' }
  }
  const code = payload.code as number
  const message = typeof payload.message === 'string' ? payload.message : ''
  if (/auth|grant|permission|api.?key|access|鉴权|权限|密钥/i.test(message)) {
    return { status: 'unavailable', message: '豆包语音 Agent Plan API Key 无效或无权访问' }
  }
  if (code === 0 || code === 20000000) {
    return { status: 'degraded', message: '豆包语音探测请求意外进入合成流程，请检查 Provider' }
  }
  // The probe deliberately supplies a reserved, nonexistent speaker. A
  // parameter/speaker rejection after authentication proves the dedicated
  // Agent Plan route without producing audio or consuming billable text.
  if (/speaker|voice|parameter|invalid|参数|音色/i.test(message)) {
    return { status: 'ok', message: '连接成功，豆包语音 Agent Plan 鉴权可用（未生成音频）' }
  }
  if (/quota|limit|resource|余额|额度|套餐|资源/i.test(message)) {
    return { status: 'unavailable', message: `豆包语音套餐资源不可用 (${code})` }
  }
  return { status: 'degraded', message: `豆包语音连接受限 (${code})` }
}

export const defaultProviderProbe: ProviderProbe = async (provider, configuration, signal) => {
  const basePath = new URL(configuration.baseUrl).pathname.replace(/\/+$/, '')
  const isSeedance = provider.adapter === 'seedance'
  const isSeedancePlan = isSeedance && basePath.endsWith('/api/plan/v3')
  const isDoubaoSpeech = provider.adapter === 'doubao-speech'
  const modelsPath = (provider.adapter === 'codex-tools'
      && !basePath.endsWith('/v1'))
    || (provider.adapter === 'seedance'
      && !basePath.endsWith('/v1')
      && !basePath.endsWith('/api/v3'))
    ? '/v1/models'
    : '/models'
  const planProbeUrl = new URL(endpoint(
    configuration.baseUrl,
    '/contents/generations/tasks',
  ))
  planProbeUrl.searchParams.set('page_num', '1')
  planProbeUrl.searchParams.set('page_size', '1')
  planProbeUrl.searchParams.set('filter.model', configuration.model)
  const request = provider.adapter === 'indextts'
    ? {
        url: endpoint(configuration.baseUrl, '/health'),
        init: { method: 'GET' } satisfies RequestInit,
      }
    : provider.adapter === 'minimax'
    ? {
        url: endpoint(configuration.baseUrl, '/v1/files/list?purpose=t2a_async_input'),
        init: { method: 'GET' } satisfies RequestInit,
      }
    : isDoubaoSpeech
      ? {
          url: configuration.baseUrl,
          init: {
            method: 'POST',
            headers: {
              'x-api-key': configuration.apiKey,
              'x-api-resource-id': 'seed-tts-2.0',
              'x-api-request-id': randomUUID(),
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({
              req_params: {
                text: '连接测试',
                speaker: '__manju_connection_probe__',
                audio_params: { format: 'mp3', sample_rate: 24_000 },
              },
            }),
          } satisfies RequestInit,
        }
      : isSeedancePlan
      ? {
          // Plan models deliberately do not participate in `/models` or Auto
          // selection. This bounded task-list read proves route access without
          // creating a video task.
          url: planProbeUrl.toString(),
          init: { method: 'GET' } satisfies RequestInit,
        }
      : {
          url: endpoint(configuration.baseUrl, modelsPath),
          init: { method: 'GET' } satisfies RequestInit,
        }

  let response: Response
  try {
    response = await fetch(request.url, {
      ...request.init,
      headers: isDoubaoSpeech
        ? request.init.headers
        : {
            authorization: `Bearer ${configuration.apiKey}`,
            accept: 'application/json',
          },
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    return { status: 'unavailable', message: '无法连接 Provider' }
  }
  if (response.ok && provider.adapter === 'minimax') {
    const body = await readBoundedJson(response, MAX_MINIMAX_PROBE_BODY_BYTES)
    if (!body.ok) {
      return {
        status: 'degraded',
        message: body.reason === 'oversized' ? 'MiniMax 响应过大' : 'MiniMax 返回了无效响应',
      }
    }
    return minimaxProbeResult(body.value)
  }
  if (response.ok && provider.adapter === 'indextts') {
    const body = await readBoundedJson(response, MAX_MINIMAX_PROBE_BODY_BYTES)
    if (!body.ok) {
      return {
        status: 'degraded',
        message: body.reason === 'oversized'
          ? 'IndexTTS 健康响应过大'
          : 'IndexTTS Sidecar 返回了无效健康状态',
      }
    }
    return indexTtsProbeResult(body.value, configuration.model)
  }
  if (isDoubaoSpeech && response.status !== 401 && response.status !== 403) {
    // The HTTP Agent Plan endpoint may return either a single JSON object or
    // newline-delimited streaming records. Probe parsing must support both.
    const body = await readBoundedJsonLines(response, MAX_MINIMAX_PROBE_BODY_BYTES)
    if (!body.ok) {
      return {
        status: 'degraded',
        message: body.reason === 'oversized' ? '豆包语音探测响应过大' : '豆包语音返回了无效探测响应',
      }
    }
    return doubaoSpeechProbeResult(body.value)
  }
  if (response.ok && isSeedancePlan) {
    const body = await readBoundedJson(response, MAX_MODEL_PROBE_BODY_BYTES)
    if (!body.ok || !isRecord(body.value) || !Array.isArray(body.value.items)) {
      return {
        status: 'degraded',
        message: body.ok ? 'Plan 任务列表返回了无效响应' : 'Plan 任务列表响应无效或过大',
      }
    }
    const visibleTaskCount = typeof body.value.total === 'number'
      && Number.isSafeInteger(body.value.total)
      && body.value.total >= 0
      ? body.value.total
      : null
    return {
      status: 'ok',
      message: visibleTaskCount === null
        ? '连接成功，Seedance Plan 路由可用；本次未创建任务，也未验证视频创建额度；模型按手工配置使用'
        : `连接成功，Seedance Plan 路由可用；当前模型可见任务 ${visibleTaskCount} 个；本次未创建任务，也未验证视频创建额度；模型按手工配置使用`,
    }
  }
  if (response.ok && isSeedance) {
    const body = await readBoundedJson(response, MAX_MODEL_PROBE_BODY_BYTES)
    if (!body.ok) {
      return {
        status: 'degraded',
        message: body.reason === 'oversized'
          ? 'Provider 模型列表响应过大'
          : 'Provider 返回了无效模型列表',
      }
    }
    return seedanceModelProbeResult(body.value, configuration.model)
  }
  await discardResponseBody(response)
  if (response.ok) return { status: 'ok', message: '连接成功' }
  if (response.status === 401 || response.status === 403) {
    return { status: 'unavailable', message: 'API Key 无效或无权访问' }
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return { status: 'degraded', message: `Provider 暂时不可用 (${response.status})` }
  }
  return { status: 'degraded', message: `Provider 连接测试失败 (${response.status})` }
}

export interface ProviderServiceOptions {
  repository: ProviderConnectionRepository
  keychain: ProviderCredentialStore | MacOSKeychain
  loadByoaCredential: (providerId: string) => Promise<string | null>
  hasByoaCredential?: (providerId: string) => Promise<boolean>
  probe?: ProviderProbe
  testTimeoutMs?: number
}

export class ProviderService {
  private readonly probe: ProviderProbe
  private readonly timeoutMs: number
  private readonly providerOperationTails = new Map<string, Promise<void>>()

  constructor(private readonly options: ProviderServiceOptions) {
    this.probe = options.probe ?? defaultProviderProbe
    this.timeoutMs = Math.min(Math.max(options.testTimeoutMs ?? TEST_TIMEOUT_MS, 1_000), 30_000)
  }

  async list(): Promise<ProviderPublicState[]> {
    const records = new Map(
      this.options.repository.listProviderConnections().map((record) => [record.providerId, record]),
    )
    const explicitlyDefaultKinds = new Set(
      [...records.values()]
        .filter((record) => record.isDefault)
        .map((record) => getProviderDefinition(record.providerId)?.kind)
        .filter((kind): kind is ProviderKind => kind !== undefined),
    )
    return Promise.all(PROVIDER_CATALOG.map(async (definition) => {
      const record = records.get(definition.id)
      const configuration = resolvedConfiguration(definition, record)
      let credentialPresent = false
      let credentialCheckFailed = false
      try {
        credentialPresent = definition.authMode === 'byoa'
          ? await this.hasExternalCredential(definition.id)
          : currentCredentialSlot(definition.id, record)
            ? await this.options.keychain.exists(currentCredentialSlot(definition.id, record)!)
            : false
      } catch {
        credentialCheckFailed = true
      }
      const credentialState = definition.authMode === 'byoa' && credentialPresent
        ? 'external' as const
        : definition.authMode === 'byok' && credentialPresent
          ? 'present' as const
          : 'missing' as const
      return {
        id: definition.id,
        label: definition.label,
        kind: definition.kind,
        adapter: definition.adapter,
        authMode: definition.authMode,
        baseUrl: configuration.baseUrl,
        model: configuration.model,
        capabilities: [...definition.capabilities],
        configurableBaseUrl: definition.configurableBaseUrl,
        enabled: record?.enabled ?? definition.authMode === 'byoa',
        configRevision: record?.configRevision ?? 1,
        isDefault: record?.isDefault ?? (!explicitlyDefaultKinds.has(definition.kind) && [
          'codex-tools-text',
          'codex-tools-image',
          'seedance-video',
          'minimax-speech',
        ].includes(definition.id)),
        credentialState,
        health: credentialCheckFailed
          ? { status: 'unavailable' as const, message: '无法检查凭据状态' }
          : {
              status: record?.lastTestStatus ?? 'untested',
              message: record?.lastTestMessage ?? '尚未测试连接',
              ...(record?.lastTestedAt ? { testedAt: record.lastTestedAt } : {}),
            },
      }
    }))
  }

  async save(id: string, input: SaveProviderInput): Promise<ProviderPublicState> {
    return this.withProviderOperation(id, () => this.saveUnlocked(id, input))
  }

  private async saveUnlocked(id: string, input: SaveProviderInput): Promise<ProviderPublicState> {
    const definition = requireProvider(id)
    if (definition.authMode === 'byoa' && input.apiKey !== undefined) {
      throw new ProviderConfigurationError('PROVIDER_USES_BYOA', 'Codex Tools 使用已有账号授权，不接收 BYOK 凭据')
    }
    const existing = this.options.repository.getProviderConnection(id)
    const baseUrlCandidate = input.baseUrl ?? existing?.baseUrl ?? definition.defaultBaseUrl
    if (!definition.configurableBaseUrl && input.baseUrl !== undefined
      && input.baseUrl.trim().replace(/\/+$/, '') !== definition.defaultBaseUrl) {
      throw new ProviderConfigurationError('INVALID_PROVIDER_CONFIG', '该 Provider 不允许修改 Base URL')
    }
    let baseUrl: string
    try {
      baseUrl = validateProviderBaseUrl(
        baseUrlCandidate,
        definition.adapter === 'codex-tools' || definition.adapter === 'indextts',
      )
    } catch (error) {
      throw new ProviderConfigurationError(
        'INVALID_PROVIDER_CONFIG',
        error instanceof Error ? error.message : 'Provider Base URL 无效',
      )
    }
    if (definition.allowedBaseUrls && !definition.allowedBaseUrls.includes(baseUrl)) {
      throw new ProviderConfigurationError(
        'INVALID_PROVIDER_CONFIG',
        '该 Provider 只允许选择已注册的官方区域地址',
      )
    }
    const model = cleanModel(input.model, existing?.model ?? definition.defaultModel)
    if (definition.allowedModels && !definition.allowedModels.includes(model)) {
      throw new ProviderConfigurationError(
        'INVALID_PROVIDER_CONFIG',
        '该 Provider 只允许选择已注册的官方模型',
      )
    }
    const previousConfiguration = resolvedConfiguration(definition, existing)
    const previousCredentialSlot = currentCredentialSlot(id, existing)
    const previousApiKey = definition.authMode === 'byok' && input.apiKey !== undefined
      ? previousCredentialSlot ? await this.options.keychain.get(previousCredentialSlot) : null
      : undefined
    const hadCredential = definition.authMode === 'byoa'
      ? await this.hasExternalCredential(id)
      : previousCredentialSlot ? await this.options.keychain.exists(previousCredentialSlot) : false
    const expectedCredential = definition.authMode === 'byok' && input.apiKey !== undefined
      ? true
      : hadCredential
    const enabled = input.enabled ?? existing?.enabled ?? expectedCredential
    if (enabled) requireConfiguredModel(definition, model)
    if (enabled && !expectedCredential) {
      throw new ProviderConfigurationError('PROVIDER_NOT_CONFIGURED', '请先保存 Provider API Key')
    }
    const keyChanged = definition.authMode === 'byok'
      && input.apiKey !== undefined
      && input.apiKey !== previousApiKey
    let activeCredentialSlot = previousCredentialSlot
    let credentialRef = existing?.credentialRef
    let newlyWrittenSlot: KeychainCredentialSlot | undefined
    let legacyMirrorWritten = false
    if (keyChanged) {
      // The service serializes the Keychain write and repository head update,
      // so the next revision is deterministic. Never overwrite a slot
      // referenced by an older immutable profile/job.
      const nextRevision = (existing?.configRevision ?? 0) + 1
      activeCredentialSlot = revisionSlot(id, nextRevision)
      await this.options.keychain.set(activeCredentialSlot, input.apiKey!)
      newlyWrittenSlot = activeCredentialSlot
      credentialRef = referenceUri(activeCredentialSlot)
      if (!hadCredential && previousCredentialSlot?.credentialKind === 'api-key') {
        // One-time compatibility mirror for older local callers. It is never
        // overwritten on rotation and is not referenced by new profiles.
        try {
          await this.options.keychain.set(previousCredentialSlot, input.apiKey!)
          legacyMirrorWritten = true
        } catch {
          // The immutable revision slot is authoritative; mirror failure is
          // non-fatal and does not weaken job execution.
        }
      }
    } else if (definition.authMode === 'byok' && hadCredential && !credentialRef && previousCredentialSlot) {
      // Adopt a legacy unversioned slot into the immutable profile without
      // moving or overwriting its secret.
      credentialRef = referenceUri(previousCredentialSlot)
    }
    const hasCredential = definition.authMode === 'byoa'
      ? hadCredential
      : newlyWrittenSlot
        ? true
        : activeCredentialSlot
          ? await this.options.keychain.exists(activeCredentialSlot)
          : false
    if (enabled && !hasCredential) {
      throw new ProviderConfigurationError('PROVIDER_NOT_CONFIGURED', '请先保存 Provider API Key')
    }
    const configurationChanged = baseUrl !== previousConfiguration.baseUrl
      || model !== previousConfiguration.model
      || keyChanged
      || credentialRef !== existing?.credentialRef
    try {
      this.options.repository.upsertProviderConnection(id, {
        enabled,
        baseUrl,
        model,
        credentialRef: definition.authMode === 'byok' && hasCredential ? credentialRef : undefined,
        ...(configurationChanged ? {
          lastTestedAt: undefined,
          lastTestStatus: 'untested' as const,
          lastTestMessage: '尚未测试连接',
        } : {}),
      })
    } catch (error) {
      if (newlyWrittenSlot) await this.options.keychain.delete(newlyWrittenSlot).catch(() => undefined)
      if (legacyMirrorWritten) await this.options.keychain.delete(legacySlot(id)).catch(() => undefined)
      throw error
    }
    return this.getPublic(id)
  }

  async deleteCredential(id: string): Promise<ProviderPublicState> {
    return this.withProviderOperation(id, () => this.deleteCredentialUnlocked(id))
  }

  private async deleteCredentialUnlocked(id: string): Promise<ProviderPublicState> {
    const definition = requireProvider(id)
    if (definition.authMode === 'byoa') {
      throw new ProviderConfigurationError('PROVIDER_USES_BYOA', 'Codex Tools 授权由 Codex Tools 管理')
    }
    const current = this.options.repository.getProviderConnection(id)
    const versions = this.options.repository.listProviderConnectionVersions(id)
    this.options.repository.upsertProviderConnection(id, {
      enabled: false,
      credentialRef: undefined,
      isDefault: false,
      lastTestStatus: 'untested',
      lastTestMessage: '凭据已删除，尚未测试连接',
      lastTestedAt: undefined,
    })
    // Version-addressed credentials are retained automatically: running and
    // retryable historical jobs may still reference them. A legacy mirror can
    // be removed only when no immutable profile points at it.
    const legacy = legacySlot(id)
    const legacyRef = referenceUri(legacy)
    if (!versions.some((version) => version.credentialRef === legacyRef)) {
      await this.options.keychain.delete(legacy).catch(() => undefined)
    }
    return this.getPublic(id)
  }

  async setDefault(id: string): Promise<ProviderPublicState> {
    return this.withProviderOperation(id, () => this.setDefaultUnlocked(id))
  }

  private async setDefaultUnlocked(id: string): Promise<ProviderPublicState> {
    const definition = requireProvider(id)
    const current = await this.getPublic(id)
    requireConfiguredModel(definition, current.model)
    if (!current.enabled || current.credentialState === 'missing') {
      throw new ProviderConfigurationError('PROVIDER_NOT_CONFIGURED', '只能将已配置且已启用的 Provider 设为默认')
    }
    this.options.repository.setDefaultProvider(id, definition.kind)
    return this.getPublic(id)
  }

  async test(id: string): Promise<ProviderPublicState> {
    return this.withProviderOperation(id, () => this.testUnlocked(id))
  }

  private async testUnlocked(id: string): Promise<ProviderPublicState> {
    const definition = requireProvider(id)
    const record = this.options.repository.getProviderConnection(id)
    const configuration = resolvedConfiguration(definition, record)
    requireConfiguredModel(definition, configuration.model)
    const credentialSlot = currentCredentialSlot(id, record)
    const apiKey = definition.authMode === 'byoa'
      ? await this.options.loadByoaCredential(id)
      : credentialSlot ? await this.options.keychain.get(credentialSlot) : null
    const testedAt = new Date().toISOString()
    if (!apiKey) {
      this.options.repository.upsertProviderConnection(id, {
        lastTestedAt: testedAt,
        lastTestStatus: 'unavailable',
        lastTestMessage: '未配置凭据',
      })
      return this.getPublic(id)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('provider test timeout')), this.timeoutMs)
    timeout.unref()
    let result: ProviderProbeResult
    try {
      result = await this.probe(definition, { ...configuration, apiKey }, controller.signal)
    } catch {
      result = controller.signal.aborted
        ? { status: 'unavailable', message: 'Provider 连接测试超时' }
        : { status: 'unavailable', message: 'Provider 连接测试失败' }
    } finally {
      clearTimeout(timeout)
    }
    this.options.repository.upsertProviderConnection(id, {
      lastTestedAt: testedAt,
      lastTestStatus: result.status,
      lastTestMessage: result.message,
    })
    return this.getPublic(id)
  }

  /** Resolve the exact immutable profile pinned by a durable generation job. */
  async materializeExecutionProfile(
    providerId: string,
    configRevision: number,
  ): Promise<MaterializedProviderExecutionProfile> {
    const definition = requireProvider(providerId)
    const version = this.options.repository.getProviderConnectionVersion(providerId, configRevision)
    if (!version) {
      throw new ProviderConfigurationError(
        'PROVIDER_VERSION_NOT_FOUND',
        `Provider 配置版本 ${configRevision} 不存在`,
      )
    }
    const versionSlot = slotFromReference(providerId, version.credentialRef)
    const apiKey = definition.authMode === 'byoa'
      ? await this.options.loadByoaCredential(providerId)
      : versionSlot
        ? await this.options.keychain.get(versionSlot)
        : null
    if (!apiKey) {
      throw new ProviderConfigurationError(
        'PROVIDER_NOT_CONFIGURED',
        `Provider 配置版本 ${configRevision} 的凭据不可用`,
      )
    }
    return { ...version, apiKey }
  }

  /**
   * Materialize the current immutable head only after its exact configuration
   * revision passed the non-billable Provider test. Rechecking the head after
   * the asynchronous Keychain read closes a configuration-rotation race.
   */
  async materializeCurrentVerifiedProfile(
    providerId: string,
  ): Promise<MaterializedProviderExecutionProfile> {
    const definition = requireProvider(providerId)
    const record = this.options.repository.getProviderConnection(providerId)
    if (!record || !record.enabled) {
      throw new ProviderConfigurationError(
        'PROVIDER_NOT_CONFIGURED',
        'Provider 尚未配置或未启用',
      )
    }
    if (record.lastTestStatus !== 'ok') {
      throw new ProviderConfigurationError(
        'PROVIDER_NOT_VERIFIED',
        'Provider 当前配置尚未通过连接测试',
      )
    }
    const revision = record.configRevision
    const profile = await this.materializeExecutionProfile(providerId, revision)
    const current = this.options.repository.getProviderConnection(providerId)
    if (!current
      || !current.enabled
      || current.configRevision !== revision
      || current.lastTestStatus !== 'ok') {
      throw new ProviderConfigurationError(
        'PROVIDER_NOT_VERIFIED',
        'Provider 配置已变更，请重新测试连接',
      )
    }
    if (profile.kind !== definition.kind || profile.adapter !== definition.adapter) {
      throw new ProviderConfigurationError(
        'INVALID_PROVIDER_CONFIG',
        'Provider 当前配置与注册类型不一致',
      )
    }
    return profile
  }

  private async getPublic(id: string): Promise<ProviderPublicState> {
    const providers = await this.list()
    const provider = providers.find((candidate) => candidate.id === id)
    if (!provider) throw new ProviderConfigurationError('PROVIDER_NOT_FOUND', 'Provider 不存在')
    return provider
  }

  private async hasExternalCredential(providerId: string): Promise<boolean> {
    if (this.options.hasByoaCredential) {
      return this.options.hasByoaCredential(providerId)
    }
    return !!(await this.options.loadByoaCredential(providerId))
  }

  /**
   * Keychain I/O is asynchronous while the repository head update is
   * synchronous. Serialize one Provider's save/delete/test/default operations
   * so two rotations cannot overwrite the same revision slot and a slow test
   * of rN cannot mark a newly-rotated rN+1 as verified.
   */
  private async withProviderOperation<T>(
    providerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.providerOperationTails.get(providerId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    this.providerOperationTails.set(providerId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.providerOperationTails.get(providerId) === tail) {
        this.providerOperationTails.delete(providerId)
      }
    }
  }
}
