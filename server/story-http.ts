import { randomUUID } from 'node:crypto'

import express, {
  Router,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express'

import type {
  GenerationJobRecord,
  ManjuDatabase,
} from './database.js'
import {
  episodeEtag,
  episodeVersionMatches,
  versionTokenFromEtag,
} from './episode-version.js'
import { SQLiteRepositoryError } from './repositories.js'
import {
  STORY_GENERATION_JOB_TYPE,
  STORY_GENERATION_LIMITS,
  type StoryGenerationJobInput,
} from './story-generation.js'
import {
  StoryRepository,
  StoryRepositoryError,
  StoryValidationError,
  type ApplyStoryResult,
  type EpisodeRecord,
  type StoryScenePatch,
  type StoryShotCreateInput,
  type StoryShotPatch,
} from './story-repository.js'
import {
  searchCurrentStoryEntities,
  STORY_ENTITY_SEARCH_LIMITS,
} from './story-entity-search.js'
import type { JsonObject, JsonValue } from './types.js'
import type {
  CreateJobRequest,
  JobCreationResult,
  JobRecord,
} from './worker.js'

const MAX_BODY_BYTES = 256 * 1024
const MAX_JSON_DEPTH = 20
const MAX_ID_LENGTH = 200
const MAX_SUMMARY_LENGTH = 500
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const EPISODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const STORY_GENERATION_IDEMPOTENCY_SCHEMA_VERSION = 1
const DEFAULT_STORY_PROVIDER_SENTINEL = '$default'

export type StoryHttpErrorCode =
  | 'BODY_TOO_LARGE'
  | 'CORRUPT_STORY'
  | 'EPISODE_ALREADY_EXISTS'
  | 'EPISODE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INVALID_ETAG'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_JSON'
  | 'INVALID_REQUEST'
  | 'INVALID_SEARCH_QUERY'
  | 'INVALID_STORY_EDIT'
  | 'ACTIVE_GENERATION_CONFLICT'
  | 'PRECONDITION_REQUIRED'
  | 'PROJECT_NOT_FOUND'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'REVISION_NOT_STORY'
  | 'SCENE_NOT_FOUND'
  | 'SHOT_NOT_FOUND'
  | 'STORY_NOT_FOUND'
  | 'STORY_STORAGE_ERROR'

/**
 * A source-safe HTTP error. Route code must never place the source novel or a
 * provider's raw error text in `message`/`details`.
 */
export class StoryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: StoryHttpErrorCode,
    message: string,
    readonly details?: JsonValue,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'StoryHttpError'
  }
}

export interface ImmutableStoryProviderBinding {
  providerId: string
  model: string
  configRevision: number
}

export interface StoryProviderSelection {
  /** Undefined means resolve the current default text provider. */
  requestedProviderId?: string
  projectId: string
  episodeId: string
}

export type ResolveStoryProviderBinding = (
  selection: StoryProviderSelection,
) => ImmutableStoryProviderBinding | Promise<ImmutableStoryProviderBinding>

export interface StoryJobSubmitter {
  submit(
    request: CreateJobRequest<StoryGenerationJobInput>,
  ): Promise<JobCreationResult>
}

interface StoryGenerationRequestIdentity {
  schemaVersion: typeof STORY_GENERATION_IDEMPOTENCY_SCHEMA_VERSION
  episodeIfMatchVersion: string
  requestedProviderId: string
  bodyIntent: {
    projectId: string | null
    providerId: string | null
  }
}

type DurableStoryGenerationJobInput = StoryGenerationJobInput & {
  idempotencyRequest: StoryGenerationRequestIdentity
}

export interface StoryHttpDependencies {
  database: ManjuDatabase
  stories: StoryRepository
  worker: StoryJobSubmitter
  resolveTextProviderBinding: ResolveStoryProviderBinding
  /** Serializes the replay/conflict checks with durable job creation in production. */
  admitJob?: <T>(operation: () => Promise<T>) => Promise<T>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateJson(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new StoryHttpError(400, 'INVALID_JSON', 'JSON 层级过深')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StoryHttpError(400, 'INVALID_JSON', 'JSON 数值无效')
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1)
    return
  }
  if (!isPlainObject(value)) {
    throw new StoryHttpError(400, 'INVALID_JSON', '请求必须是可序列化的 JSON')
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_JSON_KEYS.has(key)) {
      throw new StoryHttpError(400, 'INVALID_JSON', 'JSON 包含不允许的字段')
    }
    validateJson(item, depth + 1)
  }
}

function bodyObject(request: Request, message: string): Record<string, unknown> {
  if (!isPlainObject(request.body)) throw new StoryHttpError(400, 'INVALID_REQUEST', message)
  validateJson(request.body)
  return request.body
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new StoryHttpError(400, 'INVALID_REQUEST', message)
  validateJson(value)
  return value
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', '请求包含不支持的字段')
  }
}

function oneOfAliases(
  value: Record<string, unknown>,
  names: readonly string[],
): { present: boolean; value: unknown } {
  const present = names.filter((name) => Object.hasOwn(value, name))
  if (present.length > 1) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', '同一参数不能重复提供别名字段')
  }
  return present.length === 0
    ? { present: false, value: undefined }
    : { present: true, value: value[present[0]] }
}

function identifier(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') {
    throw new StoryHttpError(400, 'INVALID_REQUEST', `${label} 必须是文本`)
  }
  const normalized = value.trim()
  if (
    !normalized
    || normalized.length > MAX_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', `${label} 无效`)
  }
  return normalized
}

function episodeIdentifier(value: unknown, required = true): string | undefined {
  const normalized = identifier(value, 'episodeId', required)
  if (normalized && !EPISODE_ID_PATTERN.test(normalized)) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', 'episodeId 格式无效')
  }
  return normalized
}

function routeParameter(value: string | string[], label: string): string {
  return identifier(Array.isArray(value) ? value[0] : value, label) ?? ''
}

function requiredText(
  value: unknown,
  label: string,
  maximum: number,
  options: { preserveWhitespace?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    throw new StoryHttpError(400, 'INVALID_REQUEST', `${label} 必须是文本`)
  }
  const normalized = options.preserveWhitespace ? value : value.trim()
  if (!normalized.trim()) throw new StoryHttpError(400, 'INVALID_REQUEST', `${label} 不能为空`)
  if (normalized.length > maximum) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', `${label} 超出长度限制`)
  }
  return normalized
}

function optionalText(
  value: unknown,
  label: string,
  maximum: number,
  options: { preserveWhitespace?: boolean } = {},
): string {
  return requiredText(value, label, maximum, options)
}

function targetDuration(value: unknown): number {
  const { min, max } = STORY_GENERATION_LIMITS.targetDurationSeconds
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', `目标时长必须是 ${min} 到 ${max} 的整数秒`)
  }
  return value as number
}

function aspectRatio(value: unknown): StoryGenerationJobInput['aspectRatio'] {
  if (
    typeof value !== 'string'
    || !(STORY_GENERATION_LIMITS.aspectRatios as readonly string[]).includes(value)
  ) {
    throw new StoryHttpError(
      400,
      'INVALID_REQUEST',
      `画幅必须是 ${STORY_GENERATION_LIMITS.aspectRatios.join('、')} 之一`,
    )
  }
  return value as StoryGenerationJobInput['aspectRatio']
}

function summary(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return optionalText(value, 'summary', MAX_SUMMARY_LENGTH)
}

function requestedProject(value: Record<string, unknown>, episode: EpisodeRecord): void {
  if (value.projectId === undefined) return
  const projectId = identifier(value.projectId, 'projectId')
  if (projectId !== episode.projectId) {
    // Deliberately indistinguishable from an unknown episode.
    throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
  }
}

interface StoryEntitySearchQuery {
  projectId: string
  query: string
  limit: number
  offset: number
}

function storyEntitySearchQuery(request: Request): StoryEntitySearchQuery {
  const allowed = new Set(['projectId', 'query', 'limit', 'offset'])
  if (Object.keys(request.query).some((key) => !allowed.has(key))) {
    throw new StoryHttpError(400, 'INVALID_SEARCH_QUERY', '搜索请求包含不支持的参数')
  }

  const single = (key: string, required: boolean): string | undefined => {
    const value = request.query[key]
    if (value === undefined && !required) return undefined
    if (typeof value !== 'string') {
      throw new StoryHttpError(400, 'INVALID_SEARCH_QUERY', `${key} 必须且只能提供一次`)
    }
    return value
  }
  const projectId = identifier(single('projectId', true), 'projectId') ?? ''
  const rawQuery = single('query', true) ?? ''
  const query = rawQuery.trim().normalize('NFC')
  const queryLength = Array.from(query).length
  if (
    queryLength < 1
    || queryLength > STORY_ENTITY_SEARCH_LIMITS.queryCodePoints
    || /[\u0000-\u001f\u007f]/u.test(query)
  ) {
    throw new StoryHttpError(
      400,
      'INVALID_SEARCH_QUERY',
      `query 必须是 1 到 ${STORY_ENTITY_SEARCH_LIMITS.queryCodePoints} 个字符的文本`,
    )
  }

  const boundedInteger = (
    key: 'limit' | 'offset',
    fallback: number,
    minimum: number,
    maximum: number,
  ): number => {
    const value = single(key, false)
    if (value === undefined) return fallback
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
      throw new StoryHttpError(400, 'INVALID_SEARCH_QUERY', `${key} 必须是规范的整数`)
    }
    const numberValue = Number(value)
    if (!Number.isSafeInteger(numberValue) || numberValue < minimum || numberValue > maximum) {
      throw new StoryHttpError(
        400,
        'INVALID_SEARCH_QUERY',
        `${key} 必须介于 ${minimum} 和 ${maximum} 之间`,
      )
    }
    return numberValue
  }

  return {
    projectId,
    query,
    limit: boundedInteger(
      'limit',
      STORY_ENTITY_SEARCH_LIMITS.defaultPageSize,
      1,
      STORY_ENTITY_SEARCH_LIMITS.maxPageSize,
    ),
    offset: boundedInteger('offset', 0, 0, STORY_ENTITY_SEARCH_LIMITS.maxOffset),
  }
}

function requiredIfMatch(request: Request): string {
  const raw = request.get('if-match')
  if (!raw) throw new StoryHttpError(428, 'PRECONDITION_REQUIRED', '必须提供 If-Match 分集版本')
  const version = versionTokenFromEtag(raw)
  if (!version) throw new StoryHttpError(400, 'INVALID_ETAG', 'If-Match 分集版本格式无效')
  return version
}

function assertEpisodeVersion(episode: EpisodeRecord, expectedVersion: string): string | null {
  if (!episodeVersionMatches(episode, expectedVersion)) {
    throw new StoryHttpError(412, 'REVISION_CONFLICT', '分集已被其他操作更新，请刷新后重试', {
      currentRevisionId: episode.sourceRevisionId,
      currentEtag: episodeEtag(episode),
    })
  }
  return episode.sourceRevisionId
}

function requiredIdempotencyKey(request: Request): string {
  const key = request.get('idempotency-key')?.trim()
  if (!key) {
    throw new StoryHttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', '必须提供 Idempotency-Key')
  }
  if (key.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new StoryHttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 格式无效')
  }
  return key
}

function publicEpisode(episode: EpisodeRecord): JsonObject {
  return {
    id: episode.id,
    projectId: episode.projectId,
    title: episode.title,
    sourceText: episode.sourceText,
    targetDurationSeconds: episode.targetDurationSeconds,
    aspectRatio: episode.aspectRatio,
    stylePreset: episode.stylePreset,
    status: episode.status,
    sortOrder: episode.sortOrder,
    sourceRevisionId: episode.sourceRevisionId,
    createdAt: episode.createdAt,
    updatedAt: episode.updatedAt,
  }
}

function publicStoryJob(
  job: GenerationJobRecord | JobRecord,
  fallbackEpisodeId?: string,
): JsonObject {
  const durable = job as Partial<GenerationJobRecord>
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: typeof job.progress === 'number' ? job.progress : 0,
    projectId: job.projectId ?? null,
    episodeId: durable.episodeId ?? fallbackEpisodeId ?? null,
    providerId: job.providerId ?? null,
    model: job.model ?? null,
    providerConfigRevision: job.providerConfigRevision ?? null,
    idempotencyKey: job.idempotencyKey ?? null,
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
  }
}

function storyGenerationRequestIdentity(
  body: Record<string, unknown>,
  episodeIfMatchVersion: string,
  requestedProviderId: string | undefined,
  episode: EpisodeRecord,
): StoryGenerationRequestIdentity {
  return {
    schemaVersion: STORY_GENERATION_IDEMPOTENCY_SCHEMA_VERSION,
    episodeIfMatchVersion,
    requestedProviderId: requestedProviderId ?? DEFAULT_STORY_PROVIDER_SENTINEL,
    bodyIntent: {
      projectId: Object.hasOwn(body, 'projectId') ? episode.projectId : null,
      providerId: requestedProviderId ?? null,
    },
  }
}

function isExactStoryGenerationReplay(
  job: GenerationJobRecord,
  episode: EpisodeRecord,
  requestIdentity: StoryGenerationRequestIdentity,
): boolean {
  if (
    job.type !== STORY_GENERATION_JOB_TYPE
    || job.projectId !== episode.projectId
    || job.episodeId !== episode.id
    || job.input.episodeId !== episode.id
  ) {
    return false
  }

  const stored = job.input.idempotencyRequest
  if (!isPlainObject(stored) || !isPlainObject(stored.bodyIntent)) return false

  return (
    stored.schemaVersion === STORY_GENERATION_IDEMPOTENCY_SCHEMA_VERSION
    && stored.episodeIfMatchVersion === requestIdentity.episodeIfMatchVersion
    && stored.requestedProviderId === requestIdentity.requestedProviderId
    && stored.bodyIntent.projectId === requestIdentity.bodyIntent.projectId
    && stored.bodyIntent.providerId === requestIdentity.bodyIntent.providerId
    && (
      requestIdentity.requestedProviderId === DEFAULT_STORY_PROVIDER_SENTINEL
      || job.providerId === requestIdentity.requestedProviderId
    )
  )
}

function assertExactStoryGenerationReplay(
  job: GenerationJobRecord | undefined,
  episode: EpisodeRecord,
  requestIdentity: StoryGenerationRequestIdentity,
): asserts job is GenerationJobRecord {
  if (!job || !isExactStoryGenerationReplay(job, episode, requestIdentity)) {
    // Missing versioned request metadata includes legacy jobs. Failing closed
    // prevents a historical collision from being mistaken for an exact replay.
    throw new StoryHttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
  }
}

function episodeInputSnapshot(episode: EpisodeRecord): JsonObject {
  return {
    version: 1,
    kind: 'episode.input',
    episode: {
      id: episode.id,
      projectId: episode.projectId,
      title: episode.title,
      sourceText: episode.sourceText,
      targetDurationSeconds: episode.targetDurationSeconds,
      aspectRatio: episode.aspectRatio,
      stylePreset: episode.stylePreset,
    },
  }
}

/**
 * Give episode inputs a real immutable revision. In particular, a queued story
 * job bound to revision A must fail its generation-service CAS if the source is
 * edited to revision B before the provider response arrives.
 */
function recordEpisodeInputRevision(
  dependencies: StoryHttpDependencies,
  episode: EpisodeRecord,
  previousRevisionId: string | null,
  revisionSummary: string,
): EpisodeRecord {
  const project = dependencies.database.getProject(episode.projectId)
  if (!project) throw new StoryHttpError(404, 'PROJECT_NOT_FOUND', '项目不存在')
  const revision = dependencies.database.createRevision({
    projectId: episode.projectId,
    parentRevisionId: previousRevisionId ?? project.currentRevisionId,
    summary: revisionSummary.slice(0, MAX_SUMMARY_LENGTH),
    snapshot: episodeInputSnapshot(episode),
  })
  const updatedAt = new Date().toISOString()
  const changed = dependencies.database.withSql((sql) => sql.run(`
    UPDATE episodes
    SET source_revision_id = ?, updated_at = ?
    WHERE id = ? AND source_revision_id IS ?
  `, revision.id, updatedAt, episode.id, previousRevisionId)).changes
  if (changed !== 1) {
    throw new StoryHttpError(412, 'REVISION_CONFLICT', '分集已被其他操作更新，请刷新后重试')
  }
  const updated = dependencies.stories.getEpisode(episode.id)
  if (!updated) throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
  return updated
}

interface EpisodeInput {
  id?: string
  title: string
  sourceText: string
  targetDurationSeconds: number
  aspectRatio: StoryGenerationJobInput['aspectRatio']
  stylePreset: string
}

function parseEpisodeCreate(value: Record<string, unknown>): EpisodeInput {
  assertAllowedKeys(value, [
    'id',
    'title',
    'source',
    'sourceText',
    'durationSeconds',
    'targetDurationSeconds',
    'aspect',
    'aspectRatio',
    'style',
    'stylePreset',
  ])
  const source = oneOfAliases(value, ['sourceText', 'source'])
  const duration = oneOfAliases(value, ['targetDurationSeconds', 'durationSeconds'])
  const aspect = oneOfAliases(value, ['aspectRatio', 'aspect'])
  const style = oneOfAliases(value, ['stylePreset', 'style'])
  if (!source.present || !duration.present || !aspect.present || !style.present) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', '必须提供原文、标题、目标时长、画幅和风格')
  }
  return {
    ...(value.id === undefined ? {} : { id: episodeIdentifier(value.id) }),
    title: requiredText(value.title, '标题', STORY_GENERATION_LIMITS.titleCharacters),
    sourceText: requiredText(
      source.value,
      '原文',
      STORY_GENERATION_LIMITS.sourceTextCharacters,
      { preserveWhitespace: true },
    ),
    targetDurationSeconds: targetDuration(duration.value),
    aspectRatio: aspectRatio(aspect.value),
    stylePreset: requiredText(
      style.value,
      '画面风格',
      STORY_GENERATION_LIMITS.stylePresetCharacters,
    ),
  }
}

type EpisodePatch = Partial<Omit<EpisodeInput, 'id'>> & { summary?: string }

function isRenderSettingsOnlyPatch(patch: EpisodePatch): boolean {
  return (
    (patch.aspectRatio !== undefined || patch.stylePreset !== undefined)
    && patch.title === undefined
    && patch.sourceText === undefined
    && patch.targetDurationSeconds === undefined
  )
}

function parseEpisodePatch(value: Record<string, unknown>): EpisodePatch {
  assertAllowedKeys(value, [
    'projectId',
    'title',
    'source',
    'sourceText',
    'durationSeconds',
    'targetDurationSeconds',
    'aspect',
    'aspectRatio',
    'style',
    'stylePreset',
    'summary',
  ])
  const source = oneOfAliases(value, ['sourceText', 'source'])
  const duration = oneOfAliases(value, ['targetDurationSeconds', 'durationSeconds'])
  const aspect = oneOfAliases(value, ['aspectRatio', 'aspect'])
  const style = oneOfAliases(value, ['stylePreset', 'style'])
  const patch: EpisodePatch = {
    ...(value.title === undefined
      ? {}
      : { title: optionalText(value.title, '标题', STORY_GENERATION_LIMITS.titleCharacters) }),
    ...(source.present
      ? {
          sourceText: optionalText(
            source.value,
            '原文',
            STORY_GENERATION_LIMITS.sourceTextCharacters,
            { preserveWhitespace: true },
          ),
        }
      : {}),
    ...(duration.present ? { targetDurationSeconds: targetDuration(duration.value) } : {}),
    ...(aspect.present ? { aspectRatio: aspectRatio(aspect.value) } : {}),
    ...(style.present
      ? {
          stylePreset: optionalText(
            style.value,
            '画面风格',
            STORY_GENERATION_LIMITS.stylePresetCharacters,
          ),
        }
      : {}),
    ...(value.summary === undefined ? {} : { summary: summary(value.summary) }),
  }
  if (Object.keys(patch).every((key) => key === 'summary')) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', '至少提供一个可更新字段')
  }
  return patch
}

function requireEpisode(dependencies: StoryHttpDependencies, episodeId: string): EpisodeRecord {
  const episode = dependencies.stories.getEpisode(episodeId)
  if (!episode) throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
  return episode
}

function validateProviderBinding(
  binding: ImmutableStoryProviderBinding,
  requestedProviderId: string | undefined,
): ImmutableStoryProviderBinding {
  const providerId = identifier(binding?.providerId, 'providerId')
  const model = identifier(binding?.model, 'model')
  if (
    !providerId
    || !model
    || !Number.isInteger(binding?.configRevision)
    || binding.configRevision < 1
    || (requestedProviderId !== undefined && providerId !== requestedProviderId)
  ) {
    throw new StoryHttpError(409, 'PROVIDER_NOT_CONFIGURED', '文本 Provider 配置不完整')
  }
  return { providerId, model, configRevision: binding.configRevision }
}

function providerResolverError(error: unknown): StoryHttpError {
  if (error instanceof StoryHttpError) return error
  const code = isPlainObject(error) && typeof error.code === 'string' ? error.code : undefined
  if (code === 'PROVIDER_NOT_FOUND') {
    return new StoryHttpError(404, 'PROVIDER_NOT_FOUND', '文本 Provider 不存在', undefined, { cause: error })
  }
  return new StoryHttpError(
    409,
    'PROVIDER_NOT_CONFIGURED',
    '请先配置并启用文本 Provider',
    undefined,
    { cause: error },
  )
}

function storyPatchBody(
  value: Record<string, unknown>,
  fields: readonly string[],
): { episodeId: string; projectId?: string; sceneId?: string; patch: Record<string, unknown>; summary?: string } {
  assertAllowedKeys(value, ['episodeId', 'projectId', 'sceneId', 'patch', 'summary', ...fields])
  const episodeId = episodeIdentifier(value.episodeId) ?? ''
  const projectId = value.projectId === undefined ? undefined : identifier(value.projectId, 'projectId')
  const sceneId = value.sceneId === undefined ? undefined : identifier(value.sceneId, 'sceneId')
  const direct = Object.fromEntries(fields
    .filter((field) => Object.hasOwn(value, field))
    .map((field) => [field, value[field]]))
  if (value.patch !== undefined && Object.keys(direct).length > 0) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', 'patch 与直接编辑字段不能同时提供')
  }
  const patch = value.patch === undefined
    ? direct
    : objectValue(value.patch, 'patch 必须是 JSON 对象')
  assertAllowedKeys(patch, fields)
  if (Object.keys(patch).length === 0) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', '至少提供一个可更新字段')
  }
  return {
    episodeId,
    ...(projectId ? { projectId } : {}),
    ...(sceneId ? { sceneId } : {}),
    patch,
    ...(value.summary === undefined ? {} : { summary: summary(value.summary) }),
  }
}

function scenePatch(value: Record<string, unknown>): StoryScenePatch {
  const patch: StoryScenePatch = {}
  for (const field of ['title', 'locationId', 'timeOfDay', 'description'] as const) {
    if (value[field] !== undefined) {
      patch[field] = optionalText(value[field], field, field === 'title' ? 200 : 2_000)
    }
  }
  return patch
}

function shotPatch(value: Record<string, unknown>): StoryShotPatch {
  const patch: StoryShotPatch = {}
  for (const field of [
    'code',
    'title',
    'description',
    'framing',
    'movement',
    'transition',
    'visualPrompt',
  ] as const) {
    if (value[field] !== undefined) {
      patch[field] = optionalText(value[field], field, field === 'visualPrompt' ? 4_000 : 2_000)
    }
  }
  if (value.durationSeconds !== undefined) {
    if (
      typeof value.durationSeconds !== 'number'
      || !Number.isFinite(value.durationSeconds)
      || value.durationSeconds < 0.5
      || value.durationSeconds > 15
    ) {
      throw new StoryHttpError(400, 'INVALID_REQUEST', '镜头时长必须是 0.5 到 15 秒')
    }
    patch.durationSeconds = value.durationSeconds
  }
  if (value.dialogueLines !== undefined) {
    if (!Array.isArray(value.dialogueLines)) {
      throw new StoryHttpError(400, 'INVALID_REQUEST', 'dialogueLines 必须是数组')
    }
    patch.dialogueLines = value.dialogueLines as StoryShotPatch['dialogueLines']
  }
  return patch
}

function dialogueLines(value: unknown): StoryShotCreateInput['dialogueLines'] {
  if (!Array.isArray(value)) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', 'dialogueLines 必须是数组')
  }
  return value.map((item, index) => {
    const line = objectValue(item, `dialogueLines[${index}] 必须是 JSON 对象`)
    assertAllowedKeys(line, ['id', 'sequence', 'kind', 'speaker', 'text'])
    const kind = line.kind
    if (kind !== 'dialogue' && kind !== 'narration') {
      throw new StoryHttpError(400, 'INVALID_REQUEST', '对白类型必须是 dialogue 或 narration')
    }
    if (!Number.isInteger(line.sequence) || (line.sequence as number) < 0 || (line.sequence as number) > 100) {
      throw new StoryHttpError(400, 'INVALID_REQUEST', '对白 sequence 必须是 0 到 100 的整数')
    }
    if (typeof line.speaker !== 'string' || line.speaker.trim().length > 100) {
      throw new StoryHttpError(400, 'INVALID_REQUEST', '对白 speaker 无效')
    }
    const speaker = line.speaker.trim()
    if (kind === 'dialogue' && !speaker) {
      throw new StoryHttpError(400, 'INVALID_REQUEST', '对白 speaker 不能为空')
    }
    return {
      id: identifier(line.id, `dialogueLines[${index}].id`) ?? '',
      sequence: line.sequence as number,
      kind,
      speaker,
      text: requiredText(line.text, `dialogueLines[${index}].text`, 1_000),
    }
  })
}

function createShotInput(value: unknown): StoryShotCreateInput {
  const shot = objectValue(value, 'shot 必须是 JSON 对象')
  assertAllowedKeys(shot, [
    'id',
    'code',
    'title',
    'description',
    'framing',
    'movement',
    'transition',
    'durationSeconds',
    'visualPrompt',
    'dialogueLines',
  ])
  if (
    typeof shot.durationSeconds !== 'number'
    || !Number.isFinite(shot.durationSeconds)
    || shot.durationSeconds < 0.5
    || shot.durationSeconds > 15
  ) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', '镜头时长必须是 0.5 到 15 秒')
  }
  return {
    id: identifier(shot.id, 'shot.id') ?? '',
    code: requiredText(shot.code, 'shot.code', 40),
    title: requiredText(shot.title, 'shot.title', 200),
    description: requiredText(shot.description, 'shot.description', 2_000),
    framing: requiredText(shot.framing, 'shot.framing', 100),
    movement: requiredText(shot.movement, 'shot.movement', 100),
    transition: requiredText(shot.transition, 'shot.transition', 100),
    durationSeconds: shot.durationSeconds,
    visualPrompt: requiredText(shot.visualPrompt, 'shot.visualPrompt', 4_000),
    dialogueLines: dialogueLines(shot.dialogueLines),
  }
}

interface ShotCreateBody {
  episodeId: string
  projectId?: string
  sceneId: string
  shot: StoryShotCreateInput
  index?: number
  summary?: string
}

function shotCreateBody(value: Record<string, unknown>): ShotCreateBody {
  assertAllowedKeys(value, ['episodeId', 'projectId', 'sceneId', 'shot', 'index', 'summary'])
  if (
    value.index !== undefined
    && (!Number.isInteger(value.index) || (value.index as number) < 0 || (value.index as number) > 100)
  ) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', 'index 必须是非负整数')
  }
  return {
    episodeId: episodeIdentifier(value.episodeId) ?? '',
    ...(value.projectId === undefined ? {} : { projectId: identifier(value.projectId, 'projectId') }),
    sceneId: identifier(value.sceneId, 'sceneId') ?? '',
    shot: createShotInput(value.shot),
    ...(value.index === undefined ? {} : { index: value.index as number }),
    ...(value.summary === undefined ? {} : { summary: summary(value.summary) }),
  }
}

interface ShotDeleteBody {
  episodeId: string
  projectId?: string
  sceneId?: string
  summary?: string
}

function shotDeleteBody(value: Record<string, unknown>): ShotDeleteBody {
  assertAllowedKeys(value, ['episodeId', 'projectId', 'sceneId', 'summary'])
  return {
    episodeId: episodeIdentifier(value.episodeId) ?? '',
    ...(value.projectId === undefined ? {} : { projectId: identifier(value.projectId, 'projectId') }),
    ...(value.sceneId === undefined ? {} : { sceneId: identifier(value.sceneId, 'sceneId') }),
    ...(value.summary === undefined ? {} : { summary: summary(value.summary) }),
  }
}

interface ShotReorderBody {
  episodeId: string
  projectId?: string
  sceneId: string
  shotIds: string[]
  summary?: string
}

function shotReorderBody(value: Record<string, unknown>): ShotReorderBody {
  assertAllowedKeys(value, ['episodeId', 'projectId', 'sceneId', 'shotIds', 'summary'])
  if (!Array.isArray(value.shotIds)) {
    throw new StoryHttpError(400, 'INVALID_REQUEST', 'shotIds 必须是数组')
  }
  return {
    episodeId: episodeIdentifier(value.episodeId) ?? '',
    ...(value.projectId === undefined ? {} : { projectId: identifier(value.projectId, 'projectId') }),
    sceneId: identifier(value.sceneId, 'sceneId') ?? '',
    shotIds: value.shotIds.map((shotId, index) => identifier(shotId, `shotIds[${index}]`) ?? ''),
    ...(value.summary === undefined ? {} : { summary: summary(value.summary) }),
  }
}

function mutationResponse(
  result: ApplyStoryResult,
  focused: { sceneId?: string; shotId?: string; sceneIdForShot?: string } = {},
): JsonObject {
  const scene = focused.sceneId
    ? result.story.scenes.find((candidate) => candidate.id === focused.sceneId)
    : undefined
  const shot = focused.shotId
    ? result.story.scenes
        .filter((candidate) => !focused.sceneIdForShot || candidate.id === focused.sceneIdForShot)
        .flatMap((candidate) => candidate.shots)
        .find((candidate) => candidate.id === focused.shotId)
    : undefined
  return {
    episode: publicEpisode(result.episode),
    story: result.story as unknown as JsonValue,
    revisionId: result.revision.id,
    stale: result.stale as unknown as JsonValue,
    ...(scene ? { scene: scene as unknown as JsonValue } : {}),
    ...(shot ? { shot: shot as unknown as JsonValue } : {}),
  }
}

function mapStoryError(error: unknown): StoryHttpError {
  if (error instanceof StoryHttpError) return error
  if (error instanceof StoryValidationError) {
    return new StoryHttpError(
      400,
      'INVALID_STORY_EDIT',
      '编辑后的剧本未通过结构校验',
      undefined,
      { cause: error },
    )
  }
  if (error instanceof StoryRepositoryError) {
    switch (error.code) {
      case 'PROJECT_NOT_FOUND':
        return new StoryHttpError(404, 'PROJECT_NOT_FOUND', '项目不存在', undefined, { cause: error })
      case 'EPISODE_NOT_FOUND':
        return new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在', undefined, { cause: error })
      case 'STORY_NOT_FOUND':
        return new StoryHttpError(404, 'STORY_NOT_FOUND', '分集尚未生成结构化剧本', undefined, { cause: error })
      case 'SCENE_NOT_FOUND':
        return new StoryHttpError(404, 'SCENE_NOT_FOUND', '场景不存在', undefined, { cause: error })
      case 'SHOT_NOT_FOUND':
        return new StoryHttpError(404, 'SHOT_NOT_FOUND', '镜头不存在', undefined, { cause: error })
      case 'SHOT_ALREADY_EXISTS':
        return new StoryHttpError(409, 'INVALID_STORY_EDIT', '镜头标识已存在', undefined, { cause: error })
      case 'SHOT_LIMIT_EXCEEDED':
        return new StoryHttpError(409, 'INVALID_STORY_EDIT', '剧本最多只能包含 12 个镜头', undefined, { cause: error })
      case 'SHOT_LIMIT_UNDERRUN':
        return new StoryHttpError(409, 'INVALID_STORY_EDIT', '剧本至少需要保留 6 个镜头', undefined, { cause: error })
      case 'INVALID_SHOT_ORDER':
        return new StoryHttpError(400, 'INVALID_STORY_EDIT', '镜头排序必须是所选场景全部镜头的同场排列', undefined, { cause: error })
      case 'AMBIGUOUS_SHOT_ID':
        return new StoryHttpError(409, 'SHOT_NOT_FOUND', '镜头标识不唯一，请同时提供 sceneId', undefined, { cause: error })
      case 'REVISION_CONFLICT':
        return new StoryHttpError(412, 'REVISION_CONFLICT', '剧本已被其他操作更新，请刷新后重试', undefined, { cause: error })
      case 'REVISION_NOT_FOUND':
      case 'REVISION_PROJECT_MISMATCH':
        return new StoryHttpError(409, 'REVISION_CONFLICT', '剧本版本无效', undefined, { cause: error })
      case 'REVISION_EPISODE_MISMATCH':
        return new StoryHttpError(409, 'REVISION_NOT_STORY', '所选版本不属于当前分集', undefined, { cause: error })
      case 'REVISION_NOT_STORY':
        return new StoryHttpError(409, 'REVISION_NOT_STORY', '所选版本不是结构化剧本版本', undefined, { cause: error })
      case 'CORRUPT_STORY':
        return new StoryHttpError(500, 'CORRUPT_STORY', '已保存的剧本数据不一致', undefined, { cause: error })
    }
  }
  if (error instanceof SQLiteRepositoryError) {
    if (error.code === 'IDEMPOTENCY_CONFLICT') {
      return new StoryHttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求', undefined, { cause: error })
    }
    return new StoryHttpError(400, 'INVALID_REQUEST', '任务提交参数无效', undefined, { cause: error })
  }
  if (isPlainObject(error) && (error.status === 413 || error.type === 'entity.too.large')) {
    return new StoryHttpError(413, 'BODY_TOO_LARGE', '请求体不能超过 256KB', undefined, { cause: error })
  }
  if (error instanceof SyntaxError) {
    return new StoryHttpError(400, 'INVALID_JSON', '请求体不是合法 JSON', undefined, { cause: error })
  }
  return new StoryHttpError(
    500,
    'STORY_STORAGE_ERROR',
    '剧本操作未能安全完成',
    undefined,
    { cause: error },
  )
}

function asyncStoryRoute(
  handler: (request: Request, response: Response) => void | Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void Promise.resolve()
      .then(() => handler(request, response))
      .catch((error) => next(mapStoryError(error)))
  }
}

export function createStoryHttpRouter(dependencies: StoryHttpDependencies): Router {
  const router = Router()
  router.use((request, _response, next) => {
    const contentLength = Number(request.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      next(new StoryHttpError(413, 'BODY_TOO_LARGE', '请求体不能超过 256KB'))
      return
    }
    next()
  })
  router.use(express.json({ limit: MAX_BODY_BYTES, strict: true, type: 'application/json' }))

  router.post('/api/v1/projects/:projectId/episodes', asyncStoryRoute((request, response) => {
    const projectId = routeParameter(request.params.projectId, 'projectId')
    if (!dependencies.database.getProject(projectId)) {
      throw new StoryHttpError(404, 'PROJECT_NOT_FOUND', '项目不存在')
    }
    const input = parseEpisodeCreate(bodyObject(request, '分集创建请求必须是 JSON 对象'))
    const episodeId = input.id ?? randomUUID()
    if (dependencies.stories.getEpisode(episodeId)) {
      throw new StoryHttpError(409, 'EPISODE_ALREADY_EXISTS', '分集标识已存在')
    }
    const episode = dependencies.database.transaction(() => {
      const created = dependencies.stories.ensureEpisode(projectId, {
        id: episodeId,
        title: input.title,
        sourceText: input.sourceText,
        targetDurationSeconds: input.targetDurationSeconds,
        aspectRatio: input.aspectRatio,
        stylePreset: input.stylePreset,
      })
      return recordEpisodeInputRevision(dependencies, created, null, '创建分集输入')
    })
    response.status(201).setHeader('ETag', episodeEtag(episode))
    response.json({ episode: publicEpisode(episode), revisionId: episode.sourceRevisionId })
  }))

  router.get('/api/v1/projects/:projectId/episodes', asyncStoryRoute((request, response) => {
    const projectId = routeParameter(request.params.projectId, 'projectId')
    const episodes = dependencies.stories.listEpisodes(projectId)
    response.json({ episodes: episodes.map(publicEpisode) })
  }))

  router.get('/api/v1/episodes/:episodeId', asyncStoryRoute((request, response) => {
    const episode = requireEpisode(
      dependencies,
      routeParameter(request.params.episodeId, 'episodeId'),
    )
    if (request.query.projectId !== undefined) {
      const projectId = identifier(request.query.projectId, 'projectId')
      if (projectId !== episode.projectId) {
        throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
      }
    }
    response.setHeader('ETag', episodeEtag(episode))
    response.json({ episode: publicEpisode(episode), revisionId: episode.sourceRevisionId })
  }))

  router.patch('/api/v1/episodes/:episodeId', asyncStoryRoute((request, response) => {
    const episodeId = routeParameter(request.params.episodeId, 'episodeId')
    const expectedEpisodeVersion = requiredIfMatch(request)
    const body = bodyObject(request, '分集更新请求必须是 JSON 对象')
    const patch = parseEpisodePatch(body)
    const result = dependencies.database.transaction(() => {
      const current = requireEpisode(dependencies, episodeId)
      requestedProject(body, current)
      assertEpisodeVersion(current, expectedEpisodeVersion)
      const existingStory = dependencies.stories.getStory(episodeId)
      if (
        existingStory
        && patch.targetDurationSeconds !== undefined
        && patch.targetDurationSeconds !== existingStory.targetDurationSeconds
      ) {
        throw new StoryHttpError(
          409,
          'INVALID_STORY_EDIT',
          '已有剧本的目标时长不能单独修改，请重新生成剧本',
        )
      }
      // Once a structured story exists, sourceRevisionId is the immutable
      // Story revision used by timeline reconciliation and export. Render-only
      // settings stay on the episode row and atomically stale only the visual
      // render chain; they must not replace the Story revision or project head.
      if (existingStory && isRenderSettingsOnlyPatch(patch)) {
        const settings = dependencies.stories.updateRenderSettings(episodeId, {
          aspectRatio: patch.aspectRatio,
          stylePreset: patch.stylePreset,
        })
        return { episode: settings.episode, stale: settings.stale }
      }
      const saved = dependencies.stories.ensureEpisode(current.projectId, {
        id: current.id,
        title: patch.title,
        sourceText: patch.sourceText,
        targetDurationSeconds: patch.targetDurationSeconds,
        aspectRatio: patch.aspectRatio,
        stylePreset: patch.stylePreset,
      })
      return {
        episode: recordEpisodeInputRevision(
          dependencies,
          saved,
          current.sourceRevisionId,
          patch.summary ?? '更新分集输入',
        ),
      }
    })
    response.setHeader('ETag', episodeEtag(result.episode))
    response.json({
      episode: publicEpisode(result.episode),
      revisionId: result.episode.sourceRevisionId,
      ...('stale' in result ? { stale: result.stale as unknown as JsonValue } : {}),
    })
  }))

  router.get('/api/v1/episodes/:episodeId/story', asyncStoryRoute((request, response) => {
    const episode = requireEpisode(
      dependencies,
      routeParameter(request.params.episodeId, 'episodeId'),
    )
    if (request.query.projectId !== undefined) {
      const projectId = identifier(request.query.projectId, 'projectId')
      if (projectId !== episode.projectId) {
        throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
      }
    }
    const story = dependencies.stories.getStory(episode.id)
    if (!story) throw new StoryHttpError(404, 'STORY_NOT_FOUND', '分集尚未生成结构化剧本')
    response.setHeader('ETag', episodeEtag(episode))
    response.json({ episodeId: episode.id, revisionId: episode.sourceRevisionId, story })
  }))

  router.get('/api/v1/episodes/:episodeId/story/entities/search', asyncStoryRoute((request, response) => {
    const episodeId = routeParameter(request.params.episodeId, 'episodeId')
    const input = storyEntitySearchQuery(request)
    const value = dependencies.database.transaction(() => {
      const episode = requireEpisode(dependencies, episodeId)
      if (episode.projectId !== input.projectId) {
        // Do not reveal whether this Episode exists in another project.
        throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
      }
      if (!episode.sourceRevisionId || !dependencies.stories.getStory(episode.id)) {
        throw new StoryHttpError(404, 'STORY_NOT_FOUND', '分集尚未生成结构化剧本')
      }
      return {
        episode,
        page: searchCurrentStoryEntities(
          dependencies.database,
          {
            episodeId: episode.id,
            projectId: episode.projectId,
            sourceRevisionId: episode.sourceRevisionId,
          },
          { query: input.query, limit: input.limit, offset: input.offset },
        ),
      }
    })
    response.setHeader('ETag', episodeEtag(value.episode))
    response.setHeader('Cache-Control', 'no-store')
    response.json(value.page)
  }))

  router.get('/api/v1/episodes/:episodeId/story/revisions', asyncStoryRoute((request, response) => {
    const episode = requireEpisode(
      dependencies,
      routeParameter(request.params.episodeId, 'episodeId'),
    )
    if (request.query.projectId !== undefined) {
      const projectId = identifier(request.query.projectId, 'projectId')
      if (projectId !== episode.projectId) {
        throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
      }
    }
    response.setHeader('ETag', episodeEtag(episode))
    response.json({
      episodeId: episode.id,
      revisionId: episode.sourceRevisionId,
      revisions: dependencies.stories.listStoryRevisions(episode.id) as unknown as JsonValue,
    })
  }))

  router.post('/api/v1/episodes/:episodeId/story/revisions/:revisionId/restore', asyncStoryRoute((request, response) => {
    const episodeId = routeParameter(request.params.episodeId, 'episodeId')
    const revisionId = routeParameter(request.params.revisionId, 'revisionId')
    const expectedEpisodeVersion = requiredIfMatch(request)
    const body = bodyObject(request, '剧本版本恢复请求必须是 JSON 对象')
    assertAllowedKeys(body, ['projectId', 'summary'])
    const episode = requireEpisode(dependencies, episodeId)
    requestedProject(body, episode)
    const expectedRevisionId = assertEpisodeVersion(episode, expectedEpisodeVersion)
    const result = dependencies.stories.restoreStoryRevision(
      episode.id,
      revisionId,
      {
        expectedRevisionId,
        summary: body.summary === undefined ? undefined : summary(body.summary),
      },
    )
    response.setHeader('ETag', episodeEtag(result.episode))
    response.json(mutationResponse(result))
  }))

  router.post('/api/v1/episodes/:episodeId/story-generations', asyncStoryRoute(async (request, response) => {
    const episodeId = routeParameter(request.params.episodeId, 'episodeId')
    const expectedEpisodeVersion = requiredIfMatch(request)
    const submissionKey = requiredIdempotencyKey(request)
    const body = bodyObject(request, '剧本生成请求必须是 JSON 对象')
    assertAllowedKeys(body, ['projectId', 'providerId'])
    const requestedProviderId = body.providerId === undefined
      ? undefined
      : identifier(body.providerId, 'providerId')
    const episode = requireEpisode(dependencies, episodeId)
    requestedProject(body, episode)
    const requestIdentity = storyGenerationRequestIdentity(
      body,
      expectedEpisodeVersion,
      requestedProviderId,
      episode,
    )

    const existing = dependencies.database.findGenerationJobByIdempotencyKey(
      episode.projectId,
      submissionKey,
    )
    if (existing) {
      assertExactStoryGenerationReplay(existing, episode, requestIdentity)
      response.status(200).setHeader('ETag', episodeEtag(episode))
      response.json({ job: publicStoryJob(existing, episode.id) })
      return
    }
    assertEpisodeVersion(episode, expectedEpisodeVersion)
    if (episode.targetDurationSeconds === null) {
      throw new StoryHttpError(409, 'INVALID_REQUEST', '分集尚未配置目标时长')
    }
    let binding: ImmutableStoryProviderBinding
    try {
      binding = validateProviderBinding(await dependencies.resolveTextProviderBinding({
        ...(requestedProviderId ? { requestedProviderId } : {}),
        projectId: episode.projectId,
        episodeId: episode.id,
      }), requestedProviderId)
    } catch (error) {
      throw providerResolverError(error)
    }
    const jobInput: DurableStoryGenerationJobInput = {
      episodeId: episode.id,
      sourceText: episode.sourceText,
      title: episode.title,
      targetDurationSeconds: episode.targetDurationSeconds,
      aspectRatio: aspectRatio(episode.aspectRatio),
      stylePreset: requiredText(
        episode.stylePreset,
        '画面风格',
        STORY_GENERATION_LIMITS.stylePresetCharacters,
      ),
      expectedRevisionId: episode.sourceRevisionId,
      idempotencyRequest: requestIdentity,
    }
    const admitJob = dependencies.admitJob ?? (async <T>(operation: () => Promise<T>) => operation())
    const result = await admitJob(async () => {
      const raced = dependencies.database.findGenerationJobByIdempotencyKey(
        episode.projectId,
        submissionKey,
      )
      if (raced) {
        assertExactStoryGenerationReplay(raced, episode, requestIdentity)
        return { job: raced, created: false }
      }
      const latestEpisode = requireEpisode(dependencies, episode.id)
      assertEpisodeVersion(latestEpisode, expectedEpisodeVersion)
      let currentBinding: ImmutableStoryProviderBinding
      try {
        currentBinding = validateProviderBinding(await dependencies.resolveTextProviderBinding({
          ...(requestedProviderId ? { requestedProviderId } : {}),
          projectId: latestEpisode.projectId,
          episodeId: latestEpisode.id,
        }), requestedProviderId)
      } catch (error) {
        throw providerResolverError(error)
      }
      if (currentBinding.providerId !== binding.providerId
        || currentBinding.model !== binding.model
        || currentBinding.configRevision !== binding.configRevision) {
        throw new StoryHttpError(
          409,
          'PROVIDER_NOT_CONFIGURED',
          '文本 Provider 已变化，未创建剧本生成任务；请重新点击生成',
        )
      }
      const activeDuplicate = (['queued', 'running', 'waiting_provider'] as const).some((status) => (
        dependencies.database.listGenerationJobs({
          projectId: episode.projectId,
          episodeId: episode.id,
          type: STORY_GENERATION_JOB_TYPE,
          status,
          limit: 1_000,
        }).some((job) => job.resourceId === episode.id)
      ))
      if (activeDuplicate) {
        throw new StoryHttpError(
          409,
          'ACTIVE_GENERATION_CONFLICT',
          '本集已有进行中的剧本生成任务，请等待完成或取消后再试',
        )
      }
      return dependencies.worker.submit({
        type: STORY_GENERATION_JOB_TYPE,
        input: jobInput,
        idempotencyKey: submissionKey,
        resourceKey: 'provider:text',
        projectId: episode.projectId,
        providerId: binding.providerId,
        model: binding.model,
        providerConfigRevision: binding.configRevision,
        metadata: { episodeId: episode.id, resourceId: episode.id },
      })
    })
    const durable = dependencies.database.getGenerationJob(result.job.id)
    if (!result.created) {
      assertExactStoryGenerationReplay(durable, episode, requestIdentity)
    }
    response.status(result.created ? 202 : 200).setHeader('ETag', episodeEtag(episode))
    response.json({ job: publicStoryJob(durable ?? result.job, episode.id) })
  }))

  router.patch('/api/v1/scenes/:sceneId', asyncStoryRoute((request, response) => {
    const sceneId = routeParameter(request.params.sceneId, 'sceneId')
    const expectedEpisodeVersion = requiredIfMatch(request)
    const parsed = storyPatchBody(
      bodyObject(request, '场景更新请求必须是 JSON 对象'),
      ['title', 'locationId', 'timeOfDay', 'description'],
    )
    const episode = requireEpisode(dependencies, parsed.episodeId)
    if (parsed.projectId && parsed.projectId !== episode.projectId) {
      throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
    }
    const expectedRevisionId = assertEpisodeVersion(episode, expectedEpisodeVersion)
    const result = dependencies.stories.updateScene(
      episode.id,
      sceneId,
      scenePatch(parsed.patch),
      { expectedRevisionId, summary: parsed.summary },
    )
    response.setHeader('ETag', episodeEtag(result.episode))
    response.json(mutationResponse(result, { sceneId }))
  }))

  router.post('/api/v1/shots', asyncStoryRoute((request, response) => {
    const expectedEpisodeVersion = requiredIfMatch(request)
    const parsed = shotCreateBody(bodyObject(request, '镜头创建请求必须是 JSON 对象'))
    const episode = requireEpisode(dependencies, parsed.episodeId)
    if (parsed.projectId && parsed.projectId !== episode.projectId) {
      throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
    }
    const expectedRevisionId = assertEpisodeVersion(episode, expectedEpisodeVersion)
    const result = dependencies.stories.createShot(
      episode.id,
      parsed.sceneId,
      parsed.shot,
      {
        expectedRevisionId,
        ...(parsed.index === undefined ? {} : { index: parsed.index }),
        summary: parsed.summary,
      },
    )
    response.status(201).setHeader('ETag', episodeEtag(result.episode))
    response.json(mutationResponse(result, {
      sceneId: parsed.sceneId,
      shotId: parsed.shot.id,
      sceneIdForShot: parsed.sceneId,
    }))
  }))

  // MVP scope is intentionally same-scene only: shotIds must be the complete
  // existing set for sceneId, not a partial list and not a cross-scene move.
  router.post('/api/v1/shots/reorder', asyncStoryRoute((request, response) => {
    const expectedEpisodeVersion = requiredIfMatch(request)
    const parsed = shotReorderBody(bodyObject(request, '镜头排序请求必须是 JSON 对象'))
    const episode = requireEpisode(dependencies, parsed.episodeId)
    if (parsed.projectId && parsed.projectId !== episode.projectId) {
      throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
    }
    const expectedRevisionId = assertEpisodeVersion(episode, expectedEpisodeVersion)
    const result = dependencies.stories.reorderShots(
      episode.id,
      parsed.sceneId,
      parsed.shotIds,
      { expectedRevisionId, summary: parsed.summary },
    )
    response.setHeader('ETag', episodeEtag(result.episode))
    response.json(mutationResponse(result, { sceneId: parsed.sceneId }))
  }))

  router.patch('/api/v1/shots/:shotId', asyncStoryRoute((request, response) => {
    const shotId = routeParameter(request.params.shotId, 'shotId')
    const expectedEpisodeVersion = requiredIfMatch(request)
    const parsed = storyPatchBody(
      bodyObject(request, '镜头更新请求必须是 JSON 对象'),
      [
        'code',
        'title',
        'description',
        'framing',
        'movement',
        'transition',
        'durationSeconds',
        'visualPrompt',
        'dialogueLines',
      ],
    )
    const episode = requireEpisode(dependencies, parsed.episodeId)
    if (parsed.projectId && parsed.projectId !== episode.projectId) {
      throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
    }
    const expectedRevisionId = assertEpisodeVersion(episode, expectedEpisodeVersion)
    const result = dependencies.stories.updateShot(
      episode.id,
      shotId,
      shotPatch(parsed.patch),
      {
        expectedRevisionId,
        ...(parsed.sceneId ? { sceneId: parsed.sceneId } : {}),
        summary: parsed.summary,
      },
    )
    response.setHeader('ETag', episodeEtag(result.episode))
    response.json(mutationResponse(result, {
      shotId,
      ...(parsed.sceneId ? { sceneIdForShot: parsed.sceneId } : {}),
    }))
  }))

  router.delete('/api/v1/shots/:shotId', asyncStoryRoute((request, response) => {
    const shotId = routeParameter(request.params.shotId, 'shotId')
    const expectedEpisodeVersion = requiredIfMatch(request)
    const parsed = shotDeleteBody(bodyObject(request, '镜头删除请求必须是 JSON 对象'))
    const episode = requireEpisode(dependencies, parsed.episodeId)
    if (parsed.projectId && parsed.projectId !== episode.projectId) {
      throw new StoryHttpError(404, 'EPISODE_NOT_FOUND', '分集不存在')
    }
    const expectedRevisionId = assertEpisodeVersion(episode, expectedEpisodeVersion)
    const result = dependencies.stories.deleteShot(episode.id, shotId, {
      expectedRevisionId,
      ...(parsed.sceneId ? { sceneId: parsed.sceneId } : {}),
      summary: parsed.summary,
    })
    response.setHeader('ETag', episodeEtag(result.episode))
    response.json({
      ...mutationResponse(result, parsed.sceneId ? { sceneId: parsed.sceneId } : {}),
      deletedShotId: shotId,
    })
  }))

  router.use((error: unknown, _request: Request, _response: Response, next: NextFunction) => {
    next(mapStoryError(error))
  })
  return router
}

/** Mount after registering `story.generate` on the supplied JobWorker. */
export function mountStoryHttpRoutes(
  app: Pick<Express, 'use'>,
  dependencies: StoryHttpDependencies,
): Router {
  const router = createStoryHttpRouter(dependencies)
  app.use(router)
  return router
}
