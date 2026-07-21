import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  type GenerationJobRecord,
  type ManjuDatabase,
  type PipelineRunRecord,
  type PipelineRunStatus,
  type ProviderKind,
  type UpdatePipelineRunInput,
} from './database.js'
import type { JsonObject, JsonValue } from './types.js'
import {
  parseStoryCharacterVoiceProfile,
  type StoryCharacterVoiceEmotion,
} from './story-schema.js'

export const PIPELINE_RUN_DOCUMENT_VERSION = 1 as const
export const PIPELINE_RUN_MODE = 'dynamic-comic' as const

export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale'

export type PipelineSpeechMode = 'auto' | 'skip'
export type PipelineResolution = '720p' | '1080p'

export interface PipelineProviderSelection {
  providerId: string
  /** Omit to pin the provider's current immutable configuration revision. */
  configRevision?: number
  /** Omit to pin the model stored in that immutable provider revision. */
  model?: string | null
}

export interface PipelineProviderBinding {
  providerId: string
  configRevision: number
  model: string | null
}

/**
 * One immutable, auditable character-voice binding for one missing dialogue
 * line. New production runs use these bindings instead of a global voice ID.
 */
export interface PipelineSpeechTargetBinding {
  targetId: string
  publicLineId: string
  sceneId: string
  characterId: string
  characterDatabaseId: string
  characterName: string
  voiceId: string
  voiceName: string
  voiceProfileRevisionId: string
  catalogFingerprint: string
  provider: PipelineProviderBinding
  speed: number
  pitch: number
  emotion: StoryCharacterVoiceEmotion | null
  sceneDirectionApplied: boolean
}

export interface PipelineRunOptions {
  resolution?: PipelineResolution
  kenBurns?: boolean
  burnSubtitles?: boolean
  introTitle?: boolean
  outroCard?: boolean
  reviewWatermark?: boolean
  speechMode?: PipelineSpeechMode
  defaultVoiceId?: string
}

export interface PinnedPipelineRunOptions {
  resolution: PipelineResolution
  kenBurns: boolean
  burnSubtitles: boolean
  introTitle: boolean
  outroCard: boolean
  reviewWatermark: boolean
  speechMode: PipelineSpeechMode
  defaultVoiceId?: string
}

export interface CreatePipelineRunRequest {
  projectId: string
  episodeId: string
  sourceRevisionId: string
  /** Caller-owned request idempotency, unique within the project. */
  idempotencyKey: string
  /**
   * Stable hash of the caller's original intent, before discovery removes
   * already-ready targets. When omitted, the frozen execution request hash is
   * used, which preserves the stricter low-level coordinator behaviour.
   */
  callerIntentFingerprint?: string
  options?: PipelineRunOptions
  imageProvider?: PipelineProviderSelection
  speechProvider?: PipelineProviderSelection
  /** New per-line casting contract. Omitted only by legacy/internal callers. */
  speechBindings?: PipelineSpeechTargetBinding[]
  targets: {
    storyboard: string[]
    speech?: string[]
  }
}

export interface PipelineErrorDocument {
  code: string
  message: string
  step?: keyof PipelineStepDocuments
  jobId?: string
  childCode?: string
}

export interface PipelineFanoutStepDocument {
  status: PipelineStepStatus
  jobIds: string[]
  completed: number
  total: number
  error?: PipelineErrorDocument
}

export interface PipelineTimelineStepDocument {
  status: PipelineStepStatus
  revisionId?: string
  automaticEdit?: PipelineTimelineAutomaticEditDocument
  error?: PipelineErrorDocument
}

export interface PipelineTimelineAutomaticEditDocument {
  strategy: 'managed-dialogue-reflow-v1'
  executor: 'OpenCut-Classic/UpdateElementsCommand'
  planHash: string
  operationCount: number
  changedElementIds: string[]
  /**
   * Present for the unified v7/v8 audit path. Older PipelineRun documents may
   * omit these fields because they predate persistent auto-edit plans.
   */
  planId?: string
  applicationId?: string
}

export interface PipelineExportStepDocument {
  status: PipelineStepStatus
  exportId?: string
  rootJobId?: string
  error?: PipelineErrorDocument
}

export interface PipelineQualityStepDocument {
  status: PipelineStepStatus
  reportId?: string
  rootJobId?: string
  passed?: boolean
  error?: PipelineErrorDocument
}

export interface PipelineStepDocuments {
  storyboard: PipelineFanoutStepDocument
  speech: PipelineFanoutStepDocument
  timeline: PipelineTimelineStepDocument
  export: PipelineExportStepDocument
  quality: PipelineQualityStepDocument
}

export interface PipelineRunDocument {
  version: typeof PIPELINE_RUN_DOCUMENT_VERSION
  mode: typeof PIPELINE_RUN_MODE
  sourceRevisionId: string
  callerIntentFingerprint: string
  requestFingerprint: string
  options: PinnedPipelineRunOptions
  bindings: {
    imageProvider?: PipelineProviderBinding
    /** Legacy v1 documents only. */
    speechProvider?: PipelineProviderBinding
    /** Per-target bindings used by all newly created production runs. */
    speechTargets?: PipelineSpeechTargetBinding[]
  }
  targets: {
    storyboard: string[]
    speech: string[]
  }
  steps: PipelineStepDocuments
}

export interface PipelineFanoutSubmission {
  pipelineRunId: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  targetId: string
  targetIndex: number
  idempotencyKey: string
  provider: PipelineProviderBinding
  speechBinding?: PipelineSpeechTargetBinding
  options: PinnedPipelineRunOptions
}

export interface PipelineTimelineRequest {
  pipelineRunId: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
}

export interface PipelineExportRequest extends PipelineTimelineRequest {
  timelineRevisionId: string
  idempotencyKey: string
  options: PinnedPipelineRunOptions
}

export interface PipelineQualityRequest extends PipelineTimelineRequest {
  exportId: string
  idempotencyKey: string
}

export interface PipelineQualityAuthorizationRequest extends PipelineTimelineRequest {
  exportId: string
  reportId: string
}

export interface PipelineRunPorts {
  submitStoryboard(input: PipelineFanoutSubmission): Promise<{ jobId: string }> | { jobId: string }
  submitSpeech(input: PipelineFanoutSubmission): Promise<{ jobId: string }> | { jobId: string }
  materializeOrReconcile(input: PipelineTimelineRequest): Promise<{
    revisionId: string
    automaticEdit?: PipelineTimelineAutomaticEditDocument
  }> | {
    revisionId: string
    automaticEdit?: PipelineTimelineAutomaticEditDocument
  }
  createExport(input: PipelineExportRequest): Promise<{ exportId: string; jobId: string }> | {
    exportId: string
    jobId: string
  }
  createQuality(input: PipelineQualityRequest): Promise<{ reportId: string; jobId: string }> | {
    reportId: string
    jobId: string
  }
  /** Reuse the same authoritative binding/checksum gate as export download. */
  authorizeQuality(input: PipelineQualityAuthorizationRequest): Promise<{ passed: true }> | { passed: true }
  /** Enqueue is deliberately separate from durable creation for crash recovery. */
  enqueue(jobId: string): Promise<void> | void
  cancel(jobId: string, message: string): Promise<unknown> | unknown
}

export interface PipelineRunCoordinatorOptions {
  now?: () => string
  onError?: (error: unknown, context: { operation: 'kick' | 'enqueue' | 'cancel'; pipelineRunId: string }) => void
}

export interface PipelineRunCreationResult {
  created: boolean
  run: PipelineRunRecord
}

export class PipelineRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PipelineRunError'
  }
}

interface KickState {
  rerun: boolean
  promise: Promise<PipelineRunRecord | undefined>
}

interface TerminationRequest {
  status: Extract<PipelineRunStatus, 'cancelled' | 'stale'>
  message: string
  promise?: Promise<PipelineRunRecord | undefined>
}

class PipelineRunInterrupted extends Error {
  constructor(readonly pipelineRunId: string) {
    super(`Pipeline run advancement interrupted: ${pipelineRunId}`)
    this.name = 'PipelineRunInterrupted'
  }
}

interface FanoutSnapshot {
  step: PipelineFanoutStepDocument
  jobs: GenerationJobRecord[]
  active: boolean
  failed: boolean
}

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'waiting_provider'])
const TERMINAL_RUN_STATUSES = new Set<PipelineRunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'stale',
])
const STEP_STATUSES = new Set<PipelineStepStatus>([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'stale',
])
const PROGRESS_WEIGHTS = Object.freeze({
  storyboard: 35,
  speech: 15,
  timeline: 10,
  export: 25,
  quality: 15,
})
const MAX_TARGETS = 1_000
const MAX_IDENTIFIER_LENGTH = 500
const MAX_ERROR_TEXT_LENGTH = 1_000

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function storedJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new PipelineRunError('PIPELINE_CHILD_BINDING_CONFLICT', `${label} is not stored JSON`)
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (isObject(parsed)) return parsed
  } catch {
    // Use the same deterministic binding error for malformed durable state.
  }
  throw new PipelineRunError('PIPELINE_CHILD_BINDING_CONFLICT', `${label} is invalid`)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PipelineRunError('INVALID_PIPELINE_REQUEST', `${label} must not be empty`)
  }
  const normalized = value.trim()
  if (normalized.length > MAX_IDENTIFIER_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new PipelineRunError('INVALID_PIPELINE_REQUEST', `${label} is invalid`)
  }
  return normalized
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label)
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label} must be a boolean`)
  }
  return value
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label} must be a positive integer`)
  }
  return value as number
}

function normalizedTargets(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_TARGETS) {
    throw new PipelineRunError('INVALID_PIPELINE_REQUEST', `${label} must be an array of at most ${MAX_TARGETS} IDs`)
  }
  const targets = value.map((target, index) => requiredString(target, `${label}[${index}]`))
  if (new Set(targets).size !== targets.length) {
    throw new PipelineRunError('INVALID_PIPELINE_REQUEST', `${label} contains duplicate IDs`)
  }
  return targets
}

function normalizedOptions(value: PipelineRunOptions | undefined): PinnedPipelineRunOptions {
  const resolution = value?.resolution ?? '1080p'
  if (resolution !== '720p' && resolution !== '1080p') {
    throw new PipelineRunError('INVALID_PIPELINE_REQUEST', 'resolution must be 720p or 1080p')
  }
  const speechMode = value?.speechMode ?? 'auto'
  if (speechMode !== 'auto' && speechMode !== 'skip') {
    throw new PipelineRunError('INVALID_PIPELINE_REQUEST', 'speechMode must be auto or skip')
  }
  const defaultVoiceId = optionalString(value?.defaultVoiceId, 'defaultVoiceId')
  return {
    resolution,
    kenBurns: value?.kenBurns === true,
    burnSubtitles: value?.burnSubtitles !== false,
    introTitle: value?.introTitle !== false,
    outroCard: value?.outroCard !== false,
    reviewWatermark: value?.reviewWatermark === true,
    speechMode,
    ...(defaultVoiceId ? { defaultVoiceId } : {}),
  }
}

function pinProvider(
  database: ManjuDatabase,
  selection: PipelineProviderSelection | undefined,
  expectedKind: Extract<ProviderKind, 'image' | 'speech'>,
  required: boolean,
): PipelineProviderBinding | undefined {
  if (!selection) {
    if (required) {
      throw new PipelineRunError(
        'PIPELINE_PROVIDER_REQUIRED',
        `${expectedKind} provider is required for non-empty targets`,
      )
    }
    return undefined
  }
  const providerId = requiredString(selection.providerId, `${expectedKind}Provider.providerId`)
  const connection = database.getProviderConnection(providerId)
  if (!connection || connection.kind !== expectedKind) {
    throw new PipelineRunError('PIPELINE_PROVIDER_NOT_FOUND', `${expectedKind} provider was not found`)
  }
  if (!connection.enabled) {
    throw new PipelineRunError('PIPELINE_PROVIDER_DISABLED', `${expectedKind} provider is disabled`)
  }
  const configRevision = selection.configRevision ?? connection.configRevision
  if (!Number.isInteger(configRevision) || configRevision < 1) {
    throw new PipelineRunError('INVALID_PIPELINE_REQUEST', `${expectedKind} provider revision is invalid`)
  }
  const version = database.getProviderConnectionVersion(providerId, configRevision)
  if (!version || version.kind !== expectedKind) {
    throw new PipelineRunError('PIPELINE_PROVIDER_REVISION_NOT_FOUND', `${expectedKind} provider revision was not found`)
  }
  const requestedModel = selection.model === undefined ? version.model : selection.model
  const model = requestedModel === null ? null : requiredString(requestedModel, `${expectedKind}Provider.model`)
  return { providerId, configRevision, model }
}

/** JSON canonicalization used only for deterministic request fingerprints. */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function providerAsJson(value: PipelineProviderBinding): JsonObject {
  return {
    providerId: value.providerId,
    configRevision: value.configRevision,
    model: value.model,
  }
}

function speechBindingAsJson(value: PipelineSpeechTargetBinding): JsonObject {
  return {
    targetId: value.targetId,
    publicLineId: value.publicLineId,
    sceneId: value.sceneId,
    characterId: value.characterId,
    characterDatabaseId: value.characterDatabaseId,
    characterName: value.characterName,
    voiceId: value.voiceId,
    voiceName: value.voiceName,
    voiceProfileRevisionId: value.voiceProfileRevisionId,
    catalogFingerprint: value.catalogFingerprint,
    provider: providerAsJson(value.provider),
    speed: value.speed,
    pitch: value.pitch,
    emotion: value.emotion,
    sceneDirectionApplied: value.sceneDirectionApplied,
  }
}

function optionsAsJson(value: PinnedPipelineRunOptions): JsonObject {
  return {
    resolution: value.resolution,
    kenBurns: value.kenBurns,
    burnSubtitles: value.burnSubtitles,
    introTitle: value.introTitle,
    outroCard: value.outroCard,
    reviewWatermark: value.reviewWatermark,
    speechMode: value.speechMode,
    ...(value.defaultVoiceId ? { defaultVoiceId: value.defaultVoiceId } : {}),
  }
}

function errorAsJson(value: PipelineErrorDocument): JsonObject {
  return {
    code: value.code,
    message: value.message,
    ...(value.step ? { step: value.step } : {}),
    ...(value.jobId ? { jobId: value.jobId } : {}),
    ...(value.childCode ? { childCode: value.childCode } : {}),
  }
}

function fanoutAsJson(value: PipelineFanoutStepDocument): JsonObject {
  return {
    status: value.status,
    jobIds: [...value.jobIds],
    completed: value.completed,
    total: value.total,
    ...(value.error ? { error: errorAsJson(value.error) } : {}),
  }
}

function scalarStepAsJson(
  value: PipelineTimelineStepDocument | PipelineExportStepDocument | PipelineQualityStepDocument,
): JsonObject {
  const result: JsonObject = { status: value.status }
  if (value.error) result.error = errorAsJson(value.error)
  if ('revisionId' in value && value.revisionId) result.revisionId = value.revisionId
  if ('automaticEdit' in value && value.automaticEdit) {
    result.automaticEdit = {
      strategy: value.automaticEdit.strategy,
      executor: value.automaticEdit.executor,
      planHash: value.automaticEdit.planHash,
      operationCount: value.automaticEdit.operationCount,
      changedElementIds: [...value.automaticEdit.changedElementIds],
      ...(value.automaticEdit.planId ? { planId: value.automaticEdit.planId } : {}),
      ...(value.automaticEdit.applicationId
        ? { applicationId: value.automaticEdit.applicationId }
        : {}),
    }
  }
  if ('exportId' in value && value.exportId) result.exportId = value.exportId
  if ('reportId' in value && value.reportId) result.reportId = value.reportId
  if ('rootJobId' in value && value.rootJobId) result.rootJobId = value.rootJobId
  if ('passed' in value && value.passed !== undefined) result.passed = value.passed
  return result
}

function documentAsJson(value: PipelineRunDocument): JsonObject {
  return {
    version: value.version,
    mode: value.mode,
    sourceRevisionId: value.sourceRevisionId,
    callerIntentFingerprint: value.callerIntentFingerprint,
    requestFingerprint: value.requestFingerprint,
    options: optionsAsJson(value.options),
    bindings: {
      ...(value.bindings.imageProvider ? { imageProvider: providerAsJson(value.bindings.imageProvider) } : {}),
      ...(value.bindings.speechProvider ? { speechProvider: providerAsJson(value.bindings.speechProvider) } : {}),
      ...(value.bindings.speechTargets
        ? { speechTargets: value.bindings.speechTargets.map(speechBindingAsJson) }
        : {}),
    },
    targets: {
      storyboard: [...value.targets.storyboard],
      speech: [...value.targets.speech],
    },
    steps: {
      storyboard: fanoutAsJson(value.steps.storyboard),
      speech: fanoutAsJson(value.steps.speech),
      timeline: scalarStepAsJson(value.steps.timeline),
      export: scalarStepAsJson(value.steps.export),
      quality: scalarStepAsJson(value.steps.quality),
    },
  }
}

function parseProvider(value: unknown, label: string): PipelineProviderBinding {
  if (!isObject(value)) throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label} is invalid`)
  const modelValue = value.model
  if (modelValue !== null && typeof modelValue !== 'string') {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label}.model is invalid`)
  }
  return {
    providerId: requiredString(value.providerId, `${label}.providerId`),
    configRevision: requiredInteger(value.configRevision, `${label}.configRevision`),
    model: modelValue === null ? null : requiredString(modelValue, `${label}.model`),
  }
}

const SPEECH_BINDING_EMOTIONS = new Set([
  'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper',
])

function parseSpeechBinding(value: unknown, label: string): PipelineSpeechTargetBinding {
  if (!isObject(value)) throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label} is invalid`)
  if (typeof value.speed !== 'number' || !Number.isFinite(value.speed)
    || value.speed < 0.5 || value.speed > 2
    || typeof value.pitch !== 'number' || !Number.isInteger(value.pitch)
    || value.pitch < -12 || value.pitch > 12
    || typeof value.sceneDirectionApplied !== 'boolean'
    || (value.emotion !== null
      && (typeof value.emotion !== 'string' || !SPEECH_BINDING_EMOTIONS.has(value.emotion)))) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label} delivery is invalid`)
  }
  const catalogFingerprint = requiredString(value.catalogFingerprint, `${label}.catalogFingerprint`)
  if (!/^[0-9a-f]{64}$/.test(catalogFingerprint)) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label}.catalogFingerprint is invalid`)
  }
  return {
    targetId: requiredString(value.targetId, `${label}.targetId`),
    publicLineId: requiredString(value.publicLineId, `${label}.publicLineId`),
    sceneId: requiredString(value.sceneId, `${label}.sceneId`),
    characterId: requiredString(value.characterId, `${label}.characterId`),
    characterDatabaseId: requiredString(value.characterDatabaseId, `${label}.characterDatabaseId`),
    characterName: requiredString(value.characterName, `${label}.characterName`),
    voiceId: requiredString(value.voiceId, `${label}.voiceId`),
    voiceName: requiredString(value.voiceName, `${label}.voiceName`),
    voiceProfileRevisionId: requiredString(value.voiceProfileRevisionId, `${label}.voiceProfileRevisionId`),
    catalogFingerprint,
    provider: parseProvider(value.provider, `${label}.provider`),
    speed: value.speed,
    pitch: value.pitch,
    emotion: value.emotion as StoryCharacterVoiceEmotion | null,
    sceneDirectionApplied: value.sceneDirectionApplied,
  }
}

function parseSpeechBindings(value: unknown, label: string): PipelineSpeechTargetBinding[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_TARGETS) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label} must be an array`)
  }
  const bindings = value.map((item, index) => parseSpeechBinding(item, `${label}[${index}]`))
  if (new Set(bindings.map((binding) => binding.targetId)).size !== bindings.length) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label} contains duplicate targets`)
  }
  return bindings
}

function parseError(value: unknown, label: string): PipelineErrorDocument | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label} is invalid`)
  const step = value.step
  if (step !== undefined && !['storyboard', 'speech', 'timeline', 'export', 'quality'].includes(String(step))) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label}.step is invalid`)
  }
  return {
    code: requiredString(value.code, `${label}.code`),
    message: requiredString(value.message, `${label}.message`),
    ...(step ? { step: step as keyof PipelineStepDocuments } : {}),
    ...(value.jobId !== undefined ? { jobId: requiredString(value.jobId, `${label}.jobId`) } : {}),
    ...(value.childCode !== undefined ? { childCode: requiredString(value.childCode, `${label}.childCode`) } : {}),
  }
}

function parseStepStatus(value: unknown, label: string): PipelineStepStatus {
  if (typeof value !== 'string' || !STEP_STATUSES.has(value as PipelineStepStatus)) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label}.status is invalid`)
  }
  return value as PipelineStepStatus
}

function parseFanout(value: unknown, label: string): PipelineFanoutStepDocument {
  if (!isObject(value) || !Array.isArray(value.jobIds)) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label} is invalid`)
  }
  const jobIds = value.jobIds.map((jobId, index) => requiredString(jobId, `${label}.jobIds[${index}]`))
  const completed = value.completed
  const total = value.total
  if (!Number.isInteger(completed) || !Number.isInteger(total)
    || (completed as number) < 0 || (total as number) < 0 || (completed as number) > (total as number)
    || jobIds.length > (total as number)) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label} counters are invalid`)
  }
  return {
    status: parseStepStatus(value.status, label),
    jobIds,
    completed: completed as number,
    total: total as number,
    ...(parseError(value.error, `${label}.error`) ? { error: parseError(value.error, `${label}.error`) } : {}),
  }
}

function parseScalarStep(
  value: unknown,
  label: string,
): PipelineTimelineStepDocument | PipelineExportStepDocument | PipelineQualityStepDocument {
  if (!isObject(value)) throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label} is invalid`)
  let automaticEdit: PipelineTimelineAutomaticEditDocument | undefined
  if (value.automaticEdit !== undefined) {
    const edit = value.automaticEdit
    if (!isObject(edit)
      || edit.strategy !== 'managed-dialogue-reflow-v1'
      || edit.executor !== 'OpenCut-Classic/UpdateElementsCommand'
      || typeof edit.planHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(edit.planHash)
      || !Number.isSafeInteger(edit.operationCount)
      || (edit.operationCount as number) < 1
      || !Array.isArray(edit.changedElementIds)
      || edit.changedElementIds.length !== edit.operationCount) {
      throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label}.automaticEdit is invalid`)
    }
    const changedElementIds = edit.changedElementIds.map((id, index) => (
      requiredString(id, `${label}.automaticEdit.changedElementIds[${index}]`)
    ))
    if (new Set(changedElementIds).size !== changedElementIds.length) {
      throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${label}.automaticEdit has duplicate elements`)
    }
    if ((edit.planId === undefined) !== (edit.applicationId === undefined)) {
      throw new PipelineRunError(
        'INVALID_PIPELINE_DOCUMENT',
        `${label}.automaticEdit audit identifiers must be present together`,
      )
    }
    automaticEdit = {
      strategy: edit.strategy,
      executor: edit.executor,
      planHash: edit.planHash,
      operationCount: edit.operationCount as number,
      changedElementIds,
      ...(edit.planId !== undefined
        ? { planId: requiredString(edit.planId, `${label}.automaticEdit.planId`) }
        : {}),
      ...(edit.applicationId !== undefined
        ? {
            applicationId: requiredString(
              edit.applicationId,
              `${label}.automaticEdit.applicationId`,
            ),
          }
        : {}),
    }
  }
  return {
    status: parseStepStatus(value.status, label),
    ...(value.revisionId !== undefined ? { revisionId: requiredString(value.revisionId, `${label}.revisionId`) } : {}),
    ...(automaticEdit ? { automaticEdit } : {}),
    ...(value.exportId !== undefined ? { exportId: requiredString(value.exportId, `${label}.exportId`) } : {}),
    ...(value.reportId !== undefined ? { reportId: requiredString(value.reportId, `${label}.reportId`) } : {}),
    ...(value.rootJobId !== undefined ? { rootJobId: requiredString(value.rootJobId, `${label}.rootJobId`) } : {}),
    ...(value.passed !== undefined ? { passed: requiredBoolean(value.passed, `${label}.passed`) } : {}),
    ...(parseError(value.error, `${label}.error`) ? { error: parseError(value.error, `${label}.error`) } : {}),
  }
}

export function parsePipelineRunDocument(value: JsonObject): PipelineRunDocument {
  if (value.version !== PIPELINE_RUN_DOCUMENT_VERSION || value.mode !== PIPELINE_RUN_MODE
    || !isObject(value.options) || !isObject(value.bindings)
    || !isObject(value.targets) || !isObject(value.steps)) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', 'Pipeline run document is invalid')
  }
  const resolution = value.options.resolution
  const speechMode = value.options.speechMode
  if ((resolution !== '720p' && resolution !== '1080p')
    || (speechMode !== 'auto' && speechMode !== 'skip')) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', 'Pipeline options are invalid')
  }
  const imageProvider = value.bindings.imageProvider === undefined
    ? undefined
    : parseProvider(value.bindings.imageProvider, 'bindings.imageProvider')
  const speechProvider = value.bindings.speechProvider === undefined
    ? undefined
    : parseProvider(value.bindings.speechProvider, 'bindings.speechProvider')
  const speechTargets = parseSpeechBindings(value.bindings.speechTargets, 'bindings.speechTargets')
  const storyboard = normalizedTargets(value.targets.storyboard, 'targets.storyboard')
  const speech = normalizedTargets(value.targets.speech, 'targets.speech')
  const options: PinnedPipelineRunOptions = {
    resolution,
    kenBurns: requiredBoolean(value.options.kenBurns, 'options.kenBurns'),
    burnSubtitles: requiredBoolean(value.options.burnSubtitles, 'options.burnSubtitles'),
    introTitle: requiredBoolean(value.options.introTitle, 'options.introTitle'),
    outroCard: requiredBoolean(value.options.outroCard, 'options.outroCard'),
    reviewWatermark: requiredBoolean(value.options.reviewWatermark, 'options.reviewWatermark'),
    speechMode,
    ...(value.options.defaultVoiceId !== undefined
      ? { defaultVoiceId: requiredString(value.options.defaultVoiceId, 'options.defaultVoiceId') }
      : {}),
  }
  if (storyboard.length > 0 && !imageProvider) {
    throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', 'Image provider binding is missing')
  }
  if (speechMode === 'auto' && speech.length > 0) {
    const perTarget = speechTargets
      && speechTargets.length === speech.length
      && speechTargets.every((binding, index) => binding.targetId === speech[index])
    const legacy = Boolean(speechProvider && options.defaultVoiceId)
    if (!perTarget && !legacy) {
      throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', 'Speech target bindings are missing')
    }
  }
  const timeline = parseScalarStep(value.steps.timeline, 'steps.timeline') as PipelineTimelineStepDocument
  const exportStep = parseScalarStep(value.steps.export, 'steps.export') as PipelineExportStepDocument
  const quality = parseScalarStep(value.steps.quality, 'steps.quality') as PipelineQualityStepDocument
  const requestFingerprint = requiredString(value.requestFingerprint, 'requestFingerprint')
  return {
    version: PIPELINE_RUN_DOCUMENT_VERSION,
    mode: PIPELINE_RUN_MODE,
    sourceRevisionId: requiredString(value.sourceRevisionId, 'sourceRevisionId'),
    // Backward compatibility for runs created before intent/execution hashes
    // were split. Their stricter execution hash is also their caller intent.
    callerIntentFingerprint: value.callerIntentFingerprint === undefined
      ? requestFingerprint
      : requiredString(value.callerIntentFingerprint, 'callerIntentFingerprint'),
    requestFingerprint,
    options,
    bindings: {
      ...(imageProvider ? { imageProvider } : {}),
      ...(speechProvider ? { speechProvider } : {}),
      ...(speechTargets ? { speechTargets } : {}),
    },
    targets: { storyboard, speech },
    steps: {
      storyboard: parseFanout(value.steps.storyboard, 'steps.storyboard'),
      speech: parseFanout(value.steps.speech, 'steps.speech'),
      timeline,
      export: exportStep,
      quality,
    },
  }
}

function initialFanout(total: number, skipped = false): PipelineFanoutStepDocument {
  return {
    status: skipped || total === 0 ? 'succeeded' : 'pending',
    jobIds: [],
    completed: skipped || total === 0 ? total : 0,
    total,
  }
}

function initialDocument(input: {
  sourceRevisionId: string
  callerIntentFingerprint: string
  fingerprint: string
  options: PinnedPipelineRunOptions
  imageProvider?: PipelineProviderBinding
  speechProvider?: PipelineProviderBinding
  speechBindings?: PipelineSpeechTargetBinding[]
  storyboardTargets: string[]
  speechTargets: string[]
}): PipelineRunDocument {
  const speechSkipped = input.options.speechMode === 'skip'
  return {
    version: PIPELINE_RUN_DOCUMENT_VERSION,
    mode: PIPELINE_RUN_MODE,
    sourceRevisionId: input.sourceRevisionId,
    callerIntentFingerprint: input.callerIntentFingerprint,
    requestFingerprint: input.fingerprint,
    options: input.options,
    bindings: {
      ...(input.imageProvider ? { imageProvider: input.imageProvider } : {}),
      ...(input.speechProvider ? { speechProvider: input.speechProvider } : {}),
      ...(input.speechBindings ? { speechTargets: input.speechBindings } : {}),
    },
    targets: {
      storyboard: [...input.storyboardTargets],
      speech: speechSkipped ? [] : [...input.speechTargets],
    },
    steps: {
      storyboard: initialFanout(input.storyboardTargets.length),
      speech: initialFanout(speechSkipped ? 0 : input.speechTargets.length, speechSkipped),
      timeline: { status: 'pending' },
      export: { status: 'pending' },
      quality: { status: 'pending' },
    },
  }
}

function childIdempotencyKey(
  runId: string,
  step: 'storyboard' | 'speech',
  targetId: string,
  index: number,
): string {
  return `pipeline:${runId}:${step}:${index}:${sha256(targetId).slice(0, 20)}`
}

function rootIdempotencyKey(runId: string, step: 'export' | 'quality'): string {
  return `pipeline:${runId}:${step}:v1`
}

function terminalJob(job: GenerationJobRecord): boolean {
  return job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled'
}

function childError(
  step: keyof PipelineStepDocuments,
  job: GenerationJobRecord,
): PipelineErrorDocument {
  const childCode = typeof job.error?.code === 'string' ? job.error.code : undefined
  const childMessage = typeof job.error?.message === 'string' ? job.error.message : undefined
  return {
    code: job.status === 'cancelled' ? 'PIPELINE_CHILD_CANCELLED' : 'PIPELINE_CHILD_FAILED',
    message: (childMessage || `${step} child job ${job.status}`).slice(0, MAX_ERROR_TEXT_LENGTH),
    step,
    jobId: job.id,
    ...(childCode ? { childCode: childCode.slice(0, MAX_IDENTIFIER_LENGTH) } : {}),
  }
}

function thrownError(step: keyof PipelineStepDocuments, error: unknown): PipelineErrorDocument {
  const code = isObject(error) && typeof error.code === 'string'
    ? error.code.slice(0, MAX_IDENTIFIER_LENGTH)
    : 'PIPELINE_STEP_FAILED'
  const message = error instanceof Error && error.message.trim()
    ? error.message
    : `Pipeline ${step} step failed`
  return { code, message: message.slice(0, MAX_ERROR_TEXT_LENGTH), step }
}

function isDeterministicPipelineError(error: unknown): boolean {
  const code = isObject(error) && typeof error.code === 'string'
    ? error.code.trim().toUpperCase()
    : ''
  // Admission pressure is infrastructure state, not a permanent failure of
  // the frozen production request. Keep the run recoverable for a later kick.
  if (code === 'QUEUE_FULL' || code === 'PIPELINE_CAPACITY_DEFERRED') return false
  return error instanceof PipelineRunError
    || Boolean(code)
}

function firstIncompleteStep(document: PipelineRunDocument): keyof PipelineStepDocuments {
  for (const step of ['storyboard', 'speech', 'timeline', 'export', 'quality'] as const) {
    if (document.steps[step].status !== 'succeeded') return step
  }
  return 'quality'
}

function stepFraction(status: PipelineStepStatus, progress = 0): number {
  if (status === 'succeeded') return 1
  if (status === 'pending') return 0
  return Math.min(Math.max(progress / 100, 0), 1)
}

function fanoutProgress(step: PipelineFanoutStepDocument, jobs: GenerationJobRecord[]): number {
  if (step.total === 0) return 100
  const jobProgress = jobs.reduce((total, job) => total + (job.status === 'succeeded' ? 100 : job.progress), 0)
  return Math.min(100, jobProgress / step.total)
}

function pipelineProgress(
  document: PipelineRunDocument,
  jobsById: ReadonlyMap<string, GenerationJobRecord>,
): number {
  const storyboardJobs = document.steps.storyboard.jobIds
    .map((id) => jobsById.get(id))
    .filter((job): job is GenerationJobRecord => Boolean(job))
  const speechJobs = document.steps.speech.jobIds
    .map((id) => jobsById.get(id))
    .filter((job): job is GenerationJobRecord => Boolean(job))
  const exportJob = document.steps.export.rootJobId
    ? jobsById.get(document.steps.export.rootJobId)
    : undefined
  const qualityJob = document.steps.quality.rootJobId
    ? jobsById.get(document.steps.quality.rootJobId)
    : undefined
  const value =
    PROGRESS_WEIGHTS.storyboard * stepFraction(
      document.steps.storyboard.status,
      fanoutProgress(document.steps.storyboard, storyboardJobs),
    )
    + PROGRESS_WEIGHTS.speech * stepFraction(
      document.steps.speech.status,
      fanoutProgress(document.steps.speech, speechJobs),
    )
    + PROGRESS_WEIGHTS.timeline * stepFraction(document.steps.timeline.status)
    + PROGRESS_WEIGHTS.export * stepFraction(document.steps.export.status, exportJob?.progress ?? 0)
    + PROGRESS_WEIGHTS.quality * stepFraction(document.steps.quality.status, qualityJob?.progress ?? 0)
  return Math.round(value * 100) / 100
}

function allDocumentJobIds(document: PipelineRunDocument): string[] {
  return [
    ...document.steps.storyboard.jobIds,
    ...document.steps.speech.jobIds,
    ...(document.steps.export.rootJobId ? [document.steps.export.rootJobId] : []),
    ...(document.steps.quality.rootJobId ? [document.steps.quality.rootJobId] : []),
  ]
}

function fanoutProvider(
  document: PipelineRunDocument,
  kind: 'storyboard' | 'speech',
  index: number,
): PipelineProviderBinding | undefined {
  if (kind === 'storyboard') return document.bindings.imageProvider
  return document.bindings.speechTargets?.[index]?.provider
    ?? document.bindings.speechProvider
}

function storyEntityId(metadataJson: unknown, fallback: string): string {
  if (typeof metadataJson !== 'string') return fallback
  try {
    const metadata: unknown = JSON.parse(metadataJson)
    if (isObject(metadata) && typeof metadata.storyId === 'string' && metadata.storyId.trim()) {
      return metadata.storyId.trim()
    }
  } catch {
    // The exact immutable-binding error is raised by the caller.
  }
  return fallback
}

/**
 * Final no-cost CAS inside run creation. This closes the window between HTTP
 * preflight discovery and committing the durable parent, before any child can
 * be enqueued to a paid provider.
 */
function requireCurrentSpeechBindings(
  database: ManjuDatabase,
  projectId: string,
  episodeId: string,
  sourceRevisionId: string,
  bindings: readonly PipelineSpeechTargetBinding[],
): void {
  for (const binding of bindings) {
    const row = database.withSql((sql) => sql.get(`
      SELECT dialogue_lines.id AS line_id,
             dialogue_lines.metadata_json AS line_metadata_json,
             dialogue_lines.character_id,
             characters.name AS character_name,
             characters.metadata_json AS character_metadata_json,
             scenes.id AS scene_id,
             scenes.metadata_json AS scene_metadata_json,
             episodes.source_revision_id
        FROM dialogue_lines
        JOIN shots ON shots.id = dialogue_lines.shot_id
        JOIN scenes ON scenes.id = shots.scene_id
        JOIN episodes ON episodes.id = scenes.episode_id
        LEFT JOIN characters ON characters.id = dialogue_lines.character_id
       WHERE dialogue_lines.id = ? AND episodes.id = ? AND episodes.project_id = ?
    `, binding.targetId, episodeId, projectId))
    if (!row
      || row.source_revision_id !== sourceRevisionId
      || row.character_id !== binding.characterDatabaseId
      || row.character_name !== binding.characterName
      || storyEntityId(row.line_metadata_json, binding.targetId) !== binding.publicLineId
      || storyEntityId(row.scene_metadata_json, String(row.scene_id ?? '')) !== binding.sceneId
      || typeof row.character_metadata_json !== 'string') {
      throw new PipelineRunError(
        'PIPELINE_PREFLIGHT_CHANGED',
        `Dialogue or character binding changed before creation: ${binding.publicLineId}`,
      )
    }
    let metadata: unknown
    try {
      metadata = JSON.parse(row.character_metadata_json)
    } catch {
      metadata = null
    }
    if (!isObject(metadata)
      || metadata.voiceProfileRevisionId !== binding.voiceProfileRevisionId) {
      throw new PipelineRunError(
        'PIPELINE_PREFLIGHT_CHANGED',
        `Character voice profile changed before creation: ${binding.characterName}`,
      )
    }
    let profile
    try {
      profile = parseStoryCharacterVoiceProfile(metadata.voiceProfile)
    } catch {
      throw new PipelineRunError(
        'PIPELINE_PREFLIGHT_CHANGED',
        `Character voice profile became invalid before creation: ${binding.characterName}`,
      )
    }
    const direction = profile.sceneDirections?.find((item) => item.sceneId === binding.sceneId)
    const delivery = direction ?? profile.defaultDelivery
    if (profile.voiceId !== binding.voiceId
      || profile.voiceName !== binding.voiceName
      || profile.providerId !== binding.provider.providerId
      || profile.providerConfigRevision !== binding.provider.configRevision
      || profile.catalogFingerprint !== binding.catalogFingerprint
      || (delivery?.speed ?? 1) !== binding.speed
      || (delivery?.pitch ?? 0) !== binding.pitch
      || (delivery?.emotion ?? null) !== binding.emotion
      || Boolean(direction) !== binding.sceneDirectionApplied) {
      throw new PipelineRunError(
        'PIPELINE_PREFLIGHT_CHANGED',
        `Character voice delivery changed before creation: ${binding.characterName}`,
      )
    }
    const audit = database.getRevision(binding.voiceProfileRevisionId)
    let auditedProfile
    try {
      auditedProfile = audit?.snapshot.kind === 'character.voice-profile'
        && audit.snapshot.projectId === projectId
        && audit.snapshot.episodeId === episodeId
        && audit.snapshot.characterId === binding.characterId
        ? parseStoryCharacterVoiceProfile(audit.snapshot.profile)
        : undefined
    } catch {
      auditedProfile = undefined
    }
    if (!audit || audit.projectId !== projectId || !auditedProfile
      || !isDeepStrictEqual(auditedProfile, profile)) {
      throw new PipelineRunError(
        'PIPELINE_PREFLIGHT_CHANGED',
        `Character voice audit changed before creation: ${binding.characterName}`,
      )
    }
    const connection = database.getProviderConnection(binding.provider.providerId)
    const version = database.getProviderConnectionVersion(
      binding.provider.providerId,
      binding.provider.configRevision,
    )
    if (!connection || !connection.enabled || connection.kind !== 'speech'
      || connection.configRevision !== binding.provider.configRevision
      || !version || version.kind !== 'speech'
      || version.model !== binding.provider.model
      || !version.baseUrl?.trim()
      || (version.authMode === 'byok' && !version.credentialReference)) {
      throw new PipelineRunError(
        'PIPELINE_PREFLIGHT_CHANGED',
        `Character voice provider changed before creation: ${binding.characterName}`,
      )
    }
  }
}

export class PipelineRunCoordinator {
  private readonly now: () => string
  private readonly onError?: PipelineRunCoordinatorOptions['onError']
  private readonly kicks = new Map<string, KickState>()
  private readonly operationTails = new Map<string, Promise<unknown>>()
  private readonly terminationRequests = new Map<string, TerminationRequest>()

  constructor(
    private readonly database: ManjuDatabase,
    private readonly ports: PipelineRunPorts,
    options: PipelineRunCoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.onError = options.onError
  }

  create(request: CreatePipelineRunRequest): PipelineRunCreationResult {
    const projectId = requiredString(request.projectId, 'projectId')
    const episodeId = requiredString(request.episodeId, 'episodeId')
    const sourceRevisionId = requiredString(request.sourceRevisionId, 'sourceRevisionId')
    const idempotencyKey = requiredString(request.idempotencyKey, 'idempotencyKey')
    const project = this.database.getProject(projectId)
    if (!project) throw new PipelineRunError('PROJECT_NOT_FOUND', 'Project was not found')
    const revision = this.database.getRevision(sourceRevisionId)
    if (!revision || revision.projectId !== projectId) {
      throw new PipelineRunError('SOURCE_REVISION_NOT_FOUND', 'Source revision was not found in this project')
    }
    const episode = this.database.withSql((sql) => sql.get(
      'SELECT project_id, source_revision_id FROM episodes WHERE id = ?',
      episodeId,
    ))
    if (!episode || episode.project_id !== projectId) {
      throw new PipelineRunError('EPISODE_NOT_FOUND', 'Episode was not found in this project')
    }
    if (episode.source_revision_id !== sourceRevisionId) {
      throw new PipelineRunError(
        'STALE_SOURCE_REVISION',
        'Episode source revision changed before the pipeline run was created',
      )
    }

    const options = normalizedOptions(request.options)
    const storyboardTargets = normalizedTargets(request.targets.storyboard, 'targets.storyboard')
    const requestedSpeechTargets = normalizedTargets(request.targets.speech ?? [], 'targets.speech')
    const speechTargets = options.speechMode === 'skip' ? [] : requestedSpeechTargets
    const speechBindings = request.speechBindings === undefined
      ? undefined
      : request.speechBindings.map((binding, index) => (
          parseSpeechBinding(speechBindingAsJson(binding), `speechBindings[${index}]`)
        ))
    if (speechBindings && (speechBindings.length !== speechTargets.length
      || speechBindings.some((binding, index) => binding.targetId !== speechTargets[index]))) {
      throw new PipelineRunError(
        'INVALID_PIPELINE_REQUEST',
        'speechBindings must match speech targets in order',
      )
    }
    if (speechBindings && (request.speechProvider || options.defaultVoiceId)) {
      throw new PipelineRunError(
        'INVALID_PIPELINE_REQUEST',
        'Per-target speech bindings cannot be combined with legacy global speech settings',
      )
    }
    if (options.speechMode === 'auto' && speechTargets.length > 0
      && !speechBindings && !options.defaultVoiceId) {
      throw new PipelineRunError(
        'DEFAULT_VOICE_REQUIRED',
        'defaultVoiceId is required when automatic speech targets are non-empty',
      )
    }
    const imageProvider = pinProvider(this.database, request.imageProvider, 'image', storyboardTargets.length > 0)
    const speechProvider = pinProvider(
      this.database,
      request.speechProvider,
      'speech',
      options.speechMode === 'auto' && speechTargets.length > 0 && !speechBindings,
    )
    const requestDocument: JsonObject = {
      version: PIPELINE_RUN_DOCUMENT_VERSION,
      mode: PIPELINE_RUN_MODE,
      projectId,
      episodeId,
      sourceRevisionId,
      options: optionsAsJson(options),
      bindings: {
        ...(imageProvider ? { imageProvider: providerAsJson(imageProvider) } : {}),
        ...(speechProvider ? { speechProvider: providerAsJson(speechProvider) } : {}),
        ...(speechBindings
          ? { speechTargets: speechBindings.map(speechBindingAsJson) }
          : {}),
      },
      targets: { storyboard: storyboardTargets, speech: speechTargets },
    }
    const fingerprint = sha256(canonicalJson(requestDocument))
    const callerIntentFingerprint = request.callerIntentFingerprint === undefined
      ? fingerprint
      : requiredString(request.callerIntentFingerprint, 'callerIntentFingerprint')
    const existing = this.database.findPipelineRunByIdempotencyKey(projectId, idempotencyKey)
    if (existing) {
      const document = parsePipelineRunDocument(existing.steps)
      if (document.callerIntentFingerprint !== callerIntentFingerprint
        || existing.episodeId !== episodeId
        || existing.sourceRevisionId !== sourceRevisionId) {
        throw new PipelineRunError('IDEMPOTENCY_CONFLICT', 'Pipeline idempotency key belongs to another request')
      }
      return { created: false, run: existing }
    }

    const document = initialDocument({
      sourceRevisionId,
      callerIntentFingerprint,
      fingerprint,
      options,
      imageProvider,
      speechProvider,
      speechBindings,
      storyboardTargets,
      speechTargets,
    })
    try {
      const transactionResult = this.database.transaction(() => {
        const currentEpisode = this.database.withSql((sql) => sql.get(`
          SELECT project_id, source_revision_id FROM episodes WHERE id = ?
        `, episodeId))
        if (!currentEpisode || currentEpisode.project_id !== projectId) {
          throw new PipelineRunError('EPISODE_NOT_FOUND', 'Episode was not found in this project')
        }
        if (currentEpisode.source_revision_id !== sourceRevisionId) {
          throw new PipelineRunError(
            'STALE_SOURCE_REVISION',
            'Episode source revision changed before the pipeline run was created',
          )
        }
        if (speechBindings) {
          requireCurrentSpeechBindings(
            this.database,
            projectId,
            episodeId,
            sourceRevisionId,
            speechBindings,
          )
        }
        const raced = this.database.findPipelineRunByIdempotencyKey(projectId, idempotencyKey)
        if (raced) return { run: raced, created: false }
        return { run: this.database.createPipelineRun({
          projectId,
          episodeId,
          sourceRevisionId,
          idempotencyKey,
          status: 'queued',
          progress: 0,
          steps: documentAsJson(document),
        }), created: true }
      })
      const { run, created } = transactionResult
      if (parsePipelineRunDocument(run.steps).callerIntentFingerprint !== callerIntentFingerprint
        || run.episodeId !== episodeId
        || run.sourceRevisionId !== sourceRevisionId) {
        throw new PipelineRunError('IDEMPOTENCY_CONFLICT', 'Pipeline idempotency key belongs to another request')
      }
      return { created, run }
    } catch (error) {
      // A second process may have won the unique-key race. Return only the
      // exact same frozen request; never convert an unrelated constraint into
      // a successful idempotent response.
      const concurrent = this.database.findPipelineRunByIdempotencyKey(projectId, idempotencyKey)
      if (concurrent) {
        const concurrentDocument = parsePipelineRunDocument(concurrent.steps)
        if (concurrentDocument.callerIntentFingerprint === callerIntentFingerprint
          && concurrent.episodeId === episodeId
          && concurrent.sourceRevisionId === sourceRevisionId) {
          return { created: false, run: concurrent }
        }
      }
      throw error
    }
  }

  /**
   * Serialize short-lived advancement for one run. Repeated event kicks are
   * coalesced, but no promise waits for provider or renderer completion.
   */
  kick(pipelineRunIdValue: string): Promise<PipelineRunRecord | undefined> {
    const pipelineRunId = requiredString(pipelineRunIdValue, 'pipelineRunId')
    const active = this.kicks.get(pipelineRunId)
    if (active) {
      active.rerun = true
      return active.promise
    }
    const state: KickState = { rerun: false, promise: Promise.resolve(undefined) }
    state.promise = this.runExclusive(pipelineRunId, async () => {
        let result: PipelineRunRecord | undefined
        do {
          state.rerun = false
          result = await this.advance(pipelineRunId)
        } while (state.rerun)
        return result
      })
      .catch((error) => {
        this.onError?.(error, { operation: 'kick', pipelineRunId })
        throw error
      })
      .finally(() => {
        if (this.kicks.get(pipelineRunId) === state) this.kicks.delete(pipelineRunId)
      })
    this.kicks.set(pipelineRunId, state)
    return state.promise
  }

  /** Re-enqueue durable children and advance queued/running runs after restart. */
  async recover(): Promise<PipelineRunRecord[]> {
    // Story/source invalidation can transition a parent directly in SQL while
    // leaving a just-created child queued. Sweep terminal parents before the
    // worker recovers runnable jobs so stale paid work can never start.
    const activePipelineJobs: GenerationJobRecord[] = []
    for (const status of ['queued', 'running', 'waiting_provider'] as const) {
      for (let offset = 0; ; offset += 1_000) {
        const page = this.database.listGenerationJobs({ status, limit: 1_000, offset })
        activePipelineJobs.push(...page.filter((job) => Boolean(job.pipelineRunId)))
        if (page.length < 1_000) break
      }
    }
    for (const job of activePipelineJobs) {
      const parent = job.pipelineRunId
        ? this.database.getPipelineRun(job.pipelineRunId)
        : undefined
      if (!parent || TERMINAL_RUN_STATUSES.has(parent.status)) {
        await this.cancelJobBestEffort(
          job.pipelineRunId ?? 'missing-pipeline-parent',
          job.id,
          parent
            ? `Pipeline parent is already ${parent.status} during recovery`
            : 'Pipeline parent is missing during recovery',
        )
      }
    }
    const recoverable: PipelineRunRecord[] = []
    for (const status of ['queued', 'running'] as const) {
      for (let offset = 0; ; offset += 1_000) {
        const page = this.database.listPipelineRuns({ status, limit: 1_000, offset })
        recoverable.push(...page)
        if (page.length < 1_000) break
      }
    }
    const validated: PipelineRunRecord[] = []
    for (const run of recoverable) {
      let document: PipelineRunDocument
      try {
        document = parsePipelineRunDocument(run.steps)
      } catch (error) {
        await this.failCorruptRun(run, error)
        continue
      }
      if (document.sourceRevisionId !== run.sourceRevisionId || !run.episodeId) {
        this.failRun(run, document, {
          code: 'PIPELINE_SOURCE_BINDING_CONFLICT',
          message: 'Pipeline recovery source binding is invalid',
        })
        continue
      }
      const episode = this.database.withSql((sql) => sql.get(`
        SELECT project_id, source_revision_id FROM episodes WHERE id = ?
      `, run.episodeId))
      if (!episode || episode.project_id !== run.projectId) {
        this.failRun(run, document, {
          code: 'PIPELINE_EPISODE_BINDING_CONFLICT',
          message: 'Pipeline recovery episode binding is invalid',
        })
        continue
      }
      if (episode.source_revision_id !== run.sourceRevisionId) {
        await this.markStale(run.id, 'Pipeline episode source revision changed before recovery')
        continue
      }
      const jobs = this.listPipelineJobs(run.id)
      try {
        const boundRun = run as PipelineRunRecord & { episodeId: string }
        for (const job of jobs) this.requireRecoverableJob(boundRun, document, job)
      } catch (error) {
        const failure = thrownError(firstIncompleteStep(document), error)
        this.failRun(run, document, failure, jobs)
        await this.cancelActivePipelineJobs(run.id, failure.message)
        continue
      }
      validated.push(run)
      for (const job of jobs) {
        if (!ACTIVE_JOB_STATUSES.has(job.status)) continue
        try {
          await this.enqueue(run.id, job.id)
        } catch {
          // One broken local enqueue must not prevent other jobs/runs from
          // being recovered. enqueue already reports adapter errors, and the
          // queued row remains durable for another kick.
        }
      }
    }
    const results = await Promise.all(validated.map(async (run) => {
      try {
        return await this.kick(run.id)
      } catch (error) {
        this.onError?.(error, { operation: 'kick', pipelineRunId: run.id })
        return this.database.getPipelineRun(run.id)
      }
    }))
    return results.filter((run): run is PipelineRunRecord => Boolean(run))
  }

  /** Worker event bridge: durable job lookup supplies the pipeline identity. */
  async notifyJobChanged(jobIdValue: string): Promise<PipelineRunRecord | undefined> {
    const jobId = requiredString(jobIdValue, 'jobId')
    const job = this.database.getGenerationJob(jobId)
    return job?.pipelineRunId ? this.kick(job.pipelineRunId) : undefined
  }

  async cancel(pipelineRunIdValue: string, message = 'Pipeline run cancelled'): Promise<PipelineRunRecord | undefined> {
    return this.terminate(pipelineRunIdValue, 'cancelled', message)
  }

  async markStale(pipelineRunIdValue: string, message = 'Pipeline source revision is stale'): Promise<PipelineRunRecord | undefined> {
    return this.terminate(pipelineRunIdValue, 'stale', message)
  }

  private async terminate(
    pipelineRunIdValue: string,
    status: Extract<PipelineRunStatus, 'cancelled' | 'stale'>,
    message: string,
  ): Promise<PipelineRunRecord | undefined> {
    const pipelineRunId = requiredString(pipelineRunIdValue, 'pipelineRunId')
    const existing = this.terminationRequests.get(pipelineRunId)
    if (existing?.promise) return existing.promise
    const request: TerminationRequest = {
      status,
      message: message.slice(0, MAX_ERROR_TEXT_LENGTH),
    }
    this.terminationRequests.set(pipelineRunId, request)
    const activeKick = this.kicks.get(pipelineRunId)
    if (activeKick) activeKick.rerun = true
    request.promise = this.runExclusive(
      pipelineRunId,
      () => this.performTerminate(pipelineRunId, request),
    ).finally(() => {
      if (this.terminationRequests.get(pipelineRunId) === request) {
        this.terminationRequests.delete(pipelineRunId)
      }
    })
    return request.promise
  }

  private async performTerminate(
    pipelineRunId: string,
    request: TerminationRequest,
  ): Promise<PipelineRunRecord | undefined> {
    const current = this.database.getPipelineRun(pipelineRunId)
    if (!current) return undefined
    let document: PipelineRunDocument
    try {
      document = parsePipelineRunDocument(current.steps)
    } catch (error) {
      const failure: PipelineErrorDocument = {
        code: request.status === 'stale' ? 'STALE_SOURCE_REVISION' : 'PIPELINE_CANCELLED',
        message: request.message,
      }
      this.conditionalRunUpdate(current.id, {
        status: request.status,
        error: errorAsJson(failure),
        completedAt: this.now(),
      })
      await this.cancelActivePipelineJobs(current.id, request.message)
      return this.database.getPipelineRun(current.id)
    }
    for (const step of Object.values(document.steps)) {
      if (step.status === 'pending' || step.status === 'running') step.status = request.status
    }
    const error: PipelineErrorDocument = {
      code: request.status === 'stale' ? 'STALE_SOURCE_REVISION' : 'PIPELINE_CANCELLED',
      message: request.message,
    }
    const updated = this.conditionalRunUpdate(pipelineRunId, {
      status: request.status,
      progress: Math.max(current.progress, this.computeProgress(document)),
      steps: documentAsJson(document),
      error: errorAsJson(error),
      completedAt: this.now(),
    })
    // Query by the durable parent FK rather than trusting steps_json. This
    // also catches a child committed just before a crash but not yet appended.
    await this.cancelActivePipelineJobs(pipelineRunId, request.message)
    return updated ?? this.database.getPipelineRun(pipelineRunId)
  }

  private async advance(pipelineRunId: string): Promise<PipelineRunRecord | undefined> {
    try {
      return await this.advanceUnsafe(pipelineRunId)
    } catch (error) {
      if (error instanceof PipelineRunInterrupted) {
        return this.database.getPipelineRun(pipelineRunId)
      }
      const run = this.database.getPipelineRun(pipelineRunId)
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return run
      if (!isDeterministicPipelineError(error)) throw error
      let document: PipelineRunDocument
      try {
        document = parsePipelineRunDocument(run.steps)
      } catch (parseError) {
        return this.failCorruptRun(run, parseError)
      }
      const failure = thrownError(firstIncompleteStep(document), error)
      const step = document.steps[failure.step ?? 'storyboard']
      if (step.status === 'pending' || step.status === 'running') {
        step.status = 'failed'
        step.error = failure
      }
      const failed = this.failRun(run, document, failure)
      await this.cancelActivePipelineJobs(run.id, failure.message)
      return failed
    }
  }

  private async advanceUnsafe(pipelineRunId: string): Promise<PipelineRunRecord | undefined> {
    this.assertMayAdvance(pipelineRunId)
    let run = this.database.getPipelineRun(pipelineRunId)
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return run
    let document: PipelineRunDocument
    try {
      document = parsePipelineRunDocument(run.steps)
    } catch (error) {
      return this.failCorruptRun(run, error)
    }
    if (document.sourceRevisionId !== run.sourceRevisionId) {
      return this.failRun(run, document, {
        code: 'PIPELINE_SOURCE_BINDING_CONFLICT',
        message: 'Pipeline source revision does not match its frozen document',
      })
    }
    if (!run.episodeId) {
      return this.failRun(run, document, {
        code: 'PIPELINE_EPISODE_BINDING_MISSING',
        message: 'Pipeline run has no episode binding',
      })
    }
    const episodeId = run.episodeId
    const project = this.database.getProject(run.projectId)
    const episode = this.database.withSql((sql) => sql.get(`
      SELECT project_id, source_revision_id FROM episodes WHERE id = ?
    `, episodeId))
    if (!project || !episode || episode.project_id !== run.projectId) {
      return this.failRun(run, document, {
        code: 'PIPELINE_EPISODE_BINDING_CONFLICT',
        message: 'Pipeline episode no longer belongs to its project',
      })
    }
    // Project.current_revision_id is a workspace head and can move when a
    // different episode is edited. Only the bound episode's source revision
    // determines whether this run is stale.
    if (episode.source_revision_id !== run.sourceRevisionId) {
      // advance already owns this run's operation lock, so calling the public
      // markStale method here would queue behind ourselves. Terminate inline.
      return this.performTerminate(run.id, {
        status: 'stale',
        message: 'Pipeline episode source revision is no longer current',
      })
    }
    if (run.status === 'queued') {
      run = this.conditionalRunUpdate(run.id, { status: 'running' }) ?? run
    }
    // Updating the run status cannot change its episode binding, but the
    // reassignment above intentionally crosses a database boundary and loses
    // TypeScript's earlier null narrowing.
    const boundRun = run as PipelineRunRecord & { episodeId: string }

    let storyboard: FanoutSnapshot
    let speech: FanoutSnapshot
    try {
      // Speech is the paid ordering gate for every newly created storyboard
      // child. Real speech duration is required by downstream audio-driven
      // timing, and a failed voice branch must not spend image quota first.
      //
      // A v1 run created by an older process may already contain storyboard
      // children. Refresh (and later recover/enqueue) those durable jobs, but
      // do not create any missing storyboard children until speech is fully
      // successful. This preserves old-run recovery without weakening the new
      // admission order.
      speech = await this.advanceFanout(boundRun, document, 'speech')
      storyboard = speech.failed || speech.active
        ? this.refreshFanout(boundRun, document, 'storyboard')
        : await this.advanceFanout(boundRun, document, 'storyboard')
    } catch (error) {
      // A durable child may already exist even when an adapter crashed before
      // returning. Keep the run recoverable so the next deterministic kick can
      // discover that job by idempotency key.
      await this.persist(run, document)
      throw error
    }
    const fanoutJobs = [...storyboard.jobs, ...speech.jobs]
    const fanoutActive = storyboard.active || speech.active
    const fanoutFailed = storyboard.failed || speech.failed
    if (fanoutFailed) {
      // Stop further paid fanout as soon as one child fails, then wait until
      // every already-created sibling is durably terminal before failing the
      // parent. Successful assets remain reusable on a later run.
      if (fanoutActive) {
        for (const job of fanoutJobs) {
          if (ACTIVE_JOB_STATUSES.has(job.status)) {
            await this.cancelJobBestEffort(run.id, job.id, 'Pipeline sibling failed')
          }
        }
      }
      const refreshedStoryboard = this.refreshFanout(boundRun, document, 'storyboard')
      const refreshedSpeech = this.refreshFanout(boundRun, document, 'speech')
      for (const [kind, snapshot] of [
        ['storyboard', refreshedStoryboard],
        ['speech', refreshedSpeech],
      ] as const) {
        if (document.steps[kind].jobIds.length < document.steps[kind].total) {
          document.steps[kind].status = 'cancelled'
          document.steps[kind].error ??= {
            code: 'PIPELINE_FANOUT_ABORTED',
            message: 'Fanout stopped because a sibling failed',
            step: kind,
          }
        }
      }
      const refreshedJobs = [...refreshedStoryboard.jobs, ...refreshedSpeech.jobs]
      this.persist(run, document, refreshedJobs)
      if (refreshedStoryboard.active || refreshedSpeech.active) {
        return this.database.getPipelineRun(run.id)
      }
      const error = document.steps.storyboard.error
        ?? document.steps.speech.error
        ?? { code: 'PIPELINE_FANOUT_FAILED', message: 'Pipeline fanout failed' }
      return this.failRun(run, document, error, refreshedJobs)
    }
    if (fanoutActive) {
      return this.persist(run, document, fanoutJobs)
    }

    if (document.steps.timeline.status !== 'succeeded') {
      document.steps.timeline = { status: 'running' }
      this.persist(run, document, fanoutJobs)
      try {
        this.assertMayAdvance(run.id)
        const result = await this.ports.materializeOrReconcile({
          pipelineRunId: run.id,
          projectId: run.projectId,
          episodeId: boundRun.episodeId,
          sourceRevisionId: document.sourceRevisionId,
        })
        this.assertMayAdvance(run.id)
        document.steps.timeline = {
          status: 'succeeded',
          revisionId: requiredString(result.revisionId, 'timeline revisionId'),
          ...(result.automaticEdit ? { automaticEdit: result.automaticEdit } : {}),
        }
        // Freeze the immutable timeline revision before any export record/job
        // can be committed. Recovery can then validate a crash-orphan export.
        const persisted = this.persist(run, document, fanoutJobs)
        if (!persisted || TERMINAL_RUN_STATUSES.has(persisted.status)) {
          throw new PipelineRunInterrupted(run.id)
        }
      } catch (error) {
        if (error instanceof PipelineRunInterrupted) throw error
        const failure = thrownError('timeline', error)
        document.steps.timeline = { status: 'failed', error: failure }
        return this.failRun(run, document, failure, fanoutJobs)
      }
    }

    const exportSnapshot = await this.advanceExport(boundRun, document)
    const knownJobs = [...fanoutJobs, ...(exportSnapshot ? [exportSnapshot] : [])]
    if (document.steps.export.status === 'failed') {
      return this.failRun(run, document, document.steps.export.error!, knownJobs)
    }
    if (document.steps.export.status !== 'succeeded') {
      return this.persist(run, document, knownJobs)
    }

    const qualitySnapshot = await this.advanceQuality(boundRun, document)
    if (qualitySnapshot) knownJobs.push(qualitySnapshot)
    if (document.steps.quality.status === 'failed') {
      return this.failRun(run, document, document.steps.quality.error!, knownJobs)
    }
    if (document.steps.quality.status !== 'succeeded' || document.steps.quality.passed !== true) {
      return this.persist(run, document, knownJobs)
    }
    this.assertMayAdvance(run.id)
    return this.conditionalRunUpdate(run.id, {
      status: 'succeeded',
      progress: 100,
      steps: documentAsJson(document),
      error: null,
      completedAt: this.now(),
    })
  }

  private async advanceFanout(
    run: PipelineRunRecord & { episodeId: string },
    document: PipelineRunDocument,
    kind: 'storyboard' | 'speech',
  ): Promise<FanoutSnapshot> {
    const step = document.steps[kind]
    const targets = document.targets[kind]
    if (step.total !== targets.length) {
      throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${kind} target count changed`)
    }
    if (targets.length === 0) {
      step.status = 'succeeded'
      step.completed = 0
      return { step, jobs: [], active: false, failed: false }
    }
    const observed = this.refreshFanout(run, document, kind)
    if (observed.failed) return observed

    while (step.jobIds.length < targets.length) {
      this.assertMayAdvance(run.id)
      const index = step.jobIds.length
      const targetId = targets[index]
      const provider = fanoutProvider(document, kind, index)
      if (!provider) throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${kind} provider is missing`)
      const idempotencyKey = childIdempotencyKey(run.id, kind, targetId, index)
      const existing = this.database.findGenerationJobByIdempotencyKey(run.projectId, idempotencyKey)
      let result: { jobId: string }
      if (existing) {
        result = { jobId: existing.id }
      } else {
        this.assertMayAdvance(run.id)
        result = await (kind === 'storyboard' ? this.ports.submitStoryboard : this.ports.submitSpeech)({
            pipelineRunId: run.id,
            projectId: run.projectId,
            episodeId: run.episodeId,
            sourceRevisionId: document.sourceRevisionId,
            targetId,
            targetIndex: index,
            idempotencyKey,
            provider,
            ...(kind === 'speech' && document.bindings.speechTargets?.[index]
              ? { speechBinding: document.bindings.speechTargets[index] }
              : {}),
            options: document.options,
          })
      }
      const jobId = requiredString(result.jobId, `${kind} jobId`)
      if (!this.mayAdvance(run.id)) {
        await this.cancelJobBestEffort(run.id, jobId, 'Pipeline run ended during child creation')
        throw new PipelineRunInterrupted(run.id)
      }
      const job = this.requireFanoutJob(
        run,
        jobId,
        idempotencyKey,
        provider,
        kind,
        targetId,
        document.sourceRevisionId,
        kind === 'speech' ? document.bindings.speechTargets?.[index] : undefined,
      )
      step.jobIds.push(job.id)
      step.status = 'running'
      const persisted = this.persist(run, document)
      if (!persisted || TERMINAL_RUN_STATUSES.has(persisted.status)) {
        await this.cancelJobBestEffort(run.id, job.id, 'Pipeline run ended before child enqueue')
        throw new PipelineRunInterrupted(run.id)
      }
      if (ACTIVE_JOB_STATUSES.has(job.status)) await this.enqueue(run.id, job.id)
      const submitted = this.refreshFanout(run, document, kind)
      if (submitted.failed) return submitted
    }

    return this.refreshFanout(run, document, kind)
  }

  private async advanceExport(
    run: PipelineRunRecord & { episodeId: string },
    document: PipelineRunDocument,
  ): Promise<GenerationJobRecord | undefined> {
    const step = document.steps.export
    const timelineRevisionId = document.steps.timeline.revisionId
    if (!timelineRevisionId) {
      const error = { code: 'PIPELINE_TIMELINE_REVISION_MISSING', message: 'Timeline revision is missing', step: 'export' as const }
      document.steps.export = { status: 'failed', error }
      return undefined
    }
    const idempotencyKey = rootIdempotencyKey(run.id, 'export')
    if (!step.rootJobId) {
      const existing = this.database.findGenerationJobByIdempotencyKey(run.projectId, idempotencyKey)
      let result: { exportId: string; jobId: string }
      if (existing) {
        const exportId = typeof existing.input.exportId === 'string' ? existing.input.exportId : ''
        result = { exportId, jobId: existing.id }
      } else {
        try {
          this.assertMayAdvance(run.id)
          result = await this.ports.createExport({
            pipelineRunId: run.id,
            projectId: run.projectId,
            episodeId: run.episodeId,
            sourceRevisionId: document.sourceRevisionId,
            timelineRevisionId,
            idempotencyKey,
            options: document.options,
          })
        } catch (error) {
          if (error instanceof PipelineRunInterrupted) throw error
          const failure = thrownError('export', error)
          document.steps.export = { status: 'failed', error: failure }
          return undefined
        }
      }
      const exportId = requiredString(result.exportId, 'exportId')
      const jobId = requiredString(result.jobId, 'export jobId')
      if (!this.mayAdvance(run.id)) {
        await this.cancelJobBestEffort(run.id, jobId, 'Pipeline run ended during export creation')
        throw new PipelineRunInterrupted(run.id)
      }
      const job = this.requireBoundJob(run, jobId, idempotencyKey, undefined, 'export.render', {
        exportId,
      })
      this.requireExportRecordBinding(run, document, exportId)
      document.steps.export = { status: 'running', exportId, rootJobId: job.id }
      const persisted = this.persist(run, document)
      if (!persisted || TERMINAL_RUN_STATUSES.has(persisted.status)) {
        await this.cancelJobBestEffort(run.id, job.id, 'Pipeline run ended before export enqueue')
        throw new PipelineRunInterrupted(run.id)
      }
      if (ACTIVE_JOB_STATUSES.has(job.status)) await this.enqueue(run.id, job.id)
    }
    const current = document.steps.export
    const job = this.requireBoundJob(
      run,
      current.rootJobId!,
      idempotencyKey,
      undefined,
      'export.render',
      { exportId: current.exportId! },
    )
    this.requireExportRecordBinding(run, document, current.exportId!)
    if (job.status === 'succeeded') {
      current.status = 'succeeded'
      delete current.error
    } else if (job.status === 'failed' || job.status === 'cancelled') {
      current.status = 'failed'
      current.error = childError('export', job)
    } else {
      current.status = 'running'
    }
    return job
  }

  private async advanceQuality(
    run: PipelineRunRecord & { episodeId: string },
    document: PipelineRunDocument,
  ): Promise<GenerationJobRecord | undefined> {
    const exportId = document.steps.export.exportId
    if (!exportId) {
      const error = { code: 'PIPELINE_EXPORT_ID_MISSING', message: 'Export ID is missing', step: 'quality' as const }
      document.steps.quality = { status: 'failed', error }
      return undefined
    }
    this.requireExportRecordBinding(run, document, exportId)
    const idempotencyKey = rootIdempotencyKey(run.id, 'quality')
    if (!document.steps.quality.rootJobId) {
      const existing = this.database.findGenerationJobByIdempotencyKey(run.projectId, idempotencyKey)
      let result: { reportId: string; jobId: string }
      if (existing) {
        const reportId = typeof existing.input.qualityReportId === 'string' ? existing.input.qualityReportId : ''
        result = { reportId, jobId: existing.id }
      } else {
        try {
          this.assertMayAdvance(run.id)
          result = await this.ports.createQuality({
            pipelineRunId: run.id,
            projectId: run.projectId,
            episodeId: run.episodeId,
            sourceRevisionId: document.sourceRevisionId,
            exportId,
            idempotencyKey,
          })
        } catch (error) {
          if (error instanceof PipelineRunInterrupted) throw error
          const failure = thrownError('quality', error)
          document.steps.quality = { status: 'failed', error: failure }
          return undefined
        }
      }
      const reportId = requiredString(result.reportId, 'quality reportId')
      const jobId = requiredString(result.jobId, 'quality jobId')
      if (!this.mayAdvance(run.id)) {
        await this.cancelJobBestEffort(run.id, jobId, 'Pipeline run ended during quality creation')
        throw new PipelineRunInterrupted(run.id)
      }
      const job = this.requireBoundJob(run, jobId, idempotencyKey, undefined, 'quality.check', {
        qualityReportId: reportId,
        exportId,
      })
      try {
        this.requireQualityRecordBinding(run, document, reportId, exportId, job)
      } catch (error) {
        await this.cancelJobBestEffort(run.id, job.id, 'Quality child binding is invalid')
        const failure = thrownError('quality', error)
        document.steps.quality = {
          status: 'failed',
          reportId,
          rootJobId: job.id,
          passed: false,
          error: failure,
        }
        return job
      }
      document.steps.quality = { status: 'running', reportId, rootJobId: job.id }
      const persisted = this.persist(run, document)
      if (!persisted || TERMINAL_RUN_STATUSES.has(persisted.status)) {
        await this.cancelJobBestEffort(run.id, job.id, 'Pipeline run ended before quality enqueue')
        throw new PipelineRunInterrupted(run.id)
      }
      if (ACTIVE_JOB_STATUSES.has(job.status)) await this.enqueue(run.id, job.id)
    }
    const current = document.steps.quality
    const job = this.requireBoundJob(
      run,
      current.rootJobId!,
      idempotencyKey,
      undefined,
      'quality.check',
      { qualityReportId: current.reportId!, exportId },
    )
    try {
      this.requireQualityRecordBinding(run, document, current.reportId!, exportId, job)
    } catch (error) {
      await this.cancelJobBestEffort(run.id, job.id, 'Quality child binding is invalid')
      current.status = 'failed'
      current.passed = false
      current.error = thrownError('quality', error)
      return job
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      current.status = 'failed'
      current.passed = false
      current.error = childError('quality', job)
      return job
    }
    if (job.status !== 'succeeded') {
      current.status = 'running'
      return job
    }

    try {
      this.assertMayAdvance(run.id)
      const authorization = await this.ports.authorizeQuality({
        pipelineRunId: run.id,
        projectId: run.projectId,
        episodeId: run.episodeId,
        sourceRevisionId: document.sourceRevisionId,
        exportId,
        reportId: current.reportId!,
      })
      this.assertMayAdvance(run.id)
      if (authorization.passed !== true) {
        throw new PipelineRunError(
          'PIPELINE_QUALITY_STATE_CONFLICT',
          'Quality authorization did not return an authoritative pass',
        )
      }
      current.status = 'succeeded'
      current.passed = true
      delete current.error
      return job
    } catch (error) {
      if (error instanceof PipelineRunInterrupted) throw error
      current.status = 'failed'
      current.passed = false
      current.error = {
        code: isObject(error) && typeof error.code === 'string'
          ? error.code
          : 'PIPELINE_QUALITY_FAILED',
        message: error instanceof Error
          ? error.message.slice(0, MAX_ERROR_TEXT_LENGTH)
          : 'The export did not pass authoritative quality control',
        step: 'quality',
        jobId: job.id,
      }
      return job
    }
  }

  private requireBoundJob(
    run: PipelineRunRecord & { episodeId: string },
    jobId: string,
    expectedIdempotencyKey?: string,
    provider?: PipelineProviderBinding,
    expectedType?: string,
    expectedInput?: Readonly<Record<string, string>>,
  ): GenerationJobRecord {
    const job = this.database.getGenerationJob(jobId)
    if (!job) throw new PipelineRunError('PIPELINE_CHILD_JOB_MISSING', `Pipeline child job is missing: ${jobId}`)
    if (job.projectId !== run.projectId || job.episodeId !== run.episodeId || job.pipelineRunId !== run.id) {
      throw new PipelineRunError('PIPELINE_CHILD_BINDING_CONFLICT', `Pipeline child job is bound to another run: ${jobId}`)
    }
    if (expectedIdempotencyKey && job.idempotencyKey !== expectedIdempotencyKey) {
      throw new PipelineRunError('PIPELINE_CHILD_BINDING_CONFLICT', `Pipeline child idempotency key is invalid: ${jobId}`)
    }
    if (provider && (job.providerId !== provider.providerId
      || job.providerConfigRevision !== provider.configRevision
      || job.model !== provider.model)) {
      throw new PipelineRunError('PIPELINE_PROVIDER_BINDING_CONFLICT', `Pipeline child provider binding is invalid: ${jobId}`)
    }
    if (expectedType && job.type !== expectedType) {
      throw new PipelineRunError('PIPELINE_CHILD_BINDING_CONFLICT', `Pipeline child type is invalid: ${jobId}`)
    }
    if (expectedInput && Object.entries(expectedInput).some(([key, value]) => job.input[key] !== value)) {
      throw new PipelineRunError('PIPELINE_CHILD_BINDING_CONFLICT', `Pipeline child input binding is invalid: ${jobId}`)
    }
    return job
  }

  private requireExportRecordBinding(
    run: PipelineRunRecord & { episodeId: string },
    document: PipelineRunDocument,
    exportId: string,
  ): void {
    const row = this.database.withSql((sql) => sql.get(`
      SELECT project_id, episode_id, status, timeline_snapshot_json,
             specification_json, timeline_document_revision_id
        FROM exports WHERE id = ?
    `, exportId))
    if (!row || row.project_id !== run.projectId || row.episode_id !== run.episodeId) {
      throw new PipelineRunError(
        'PIPELINE_CHILD_BINDING_CONFLICT',
        `Export record is not bound to this pipeline: ${exportId}`,
      )
    }
    const snapshot = storedJsonObject(row.timeline_snapshot_json, 'exports.timeline_snapshot_json')
    const specification = storedJsonObject(row.specification_json, 'exports.specification_json')
    const timelineRevisionId = document.steps.timeline.revisionId
    if (!timelineRevisionId
      || row.timeline_document_revision_id !== timelineRevisionId
      || snapshot.timelineRevisionId !== timelineRevisionId
      || specification.timelineRevisionId !== timelineRevisionId
      || snapshot.storyRevisionId !== document.sourceRevisionId
      || specification.storyRevisionId !== document.sourceRevisionId
      || row.status === 'stale') {
      throw new PipelineRunError(
        'PIPELINE_CHILD_BINDING_CONFLICT',
        `Export immutable revision binding is invalid: ${exportId}`,
      )
    }
  }

  private requireQualityRecordBinding(
    run: PipelineRunRecord & { episodeId: string },
    document: PipelineRunDocument,
    reportId: string,
    exportId: string,
    job: GenerationJobRecord,
  ): void {
    const row = this.database.withSql((sql) => sql.get(`
      SELECT project_id, episode_id, export_id, status, checks_json
        FROM quality_reports WHERE id = ?
    `, reportId))
    if (!row
      || row.project_id !== run.projectId
      || row.episode_id !== run.episodeId
      || row.export_id !== exportId
      || row.status === 'stale') {
      throw new PipelineRunError(
        'PIPELINE_CHILD_BINDING_CONFLICT',
        `Quality report is not bound to this pipeline export: ${reportId}`,
      )
    }
    const report = storedJsonObject(row.checks_json, 'quality_reports.checks_json')
    const binding = isObject(report.binding) ? report.binding : null
    if (!binding
      || binding.exportId !== exportId
      || binding.timelineRevisionId !== document.steps.timeline.revisionId
      || binding.storyRevisionId !== document.sourceRevisionId
      || typeof binding.outputAssetId !== 'string'
      || typeof binding.outputAssetChecksum !== 'string'
      || job.input.outputAssetId !== binding.outputAssetId
      || job.input.outputAssetChecksum !== binding.outputAssetChecksum) {
      throw new PipelineRunError(
        'PIPELINE_CHILD_BINDING_CONFLICT',
        `Quality immutable revision binding is invalid: ${reportId}`,
      )
    }
  }

  private requireFanoutJob(
    run: PipelineRunRecord & { episodeId: string },
    jobId: string,
    idempotencyKey: string,
    provider: PipelineProviderBinding,
    kind: 'storyboard' | 'speech',
    targetId: string,
    sourceRevisionId: string,
    speechBinding?: PipelineSpeechTargetBinding,
  ): GenerationJobRecord {
    const expectedType = kind === 'storyboard'
      ? 'asset.image.generate'
      : 'dialogue.speech.generate'
    const job = this.requireBoundJob(run, jobId, idempotencyKey, provider, expectedType)
    if (kind === 'storyboard') {
      const binding = isObject(job.input.storyboardBinding) ? job.input.storyboardBinding : null
      const episodeBinding = isObject(job.input.episodeBinding) ? job.input.episodeBinding : null
      if (binding?.databaseShotId !== targetId
        || binding.expectedRevisionId !== sourceRevisionId
        || episodeBinding?.episodeId !== run.episodeId
        || episodeBinding.expectedRevisionId !== sourceRevisionId) {
        throw new PipelineRunError(
          'PIPELINE_CHILD_BINDING_CONFLICT',
          `Storyboard child input binding is invalid: ${jobId}`,
        )
      }
    } else {
      const invalidBase = job.input.databaseLineId !== targetId
        || job.input.episodeId !== run.episodeId
        || job.input.expectedRevisionId !== sourceRevisionId
      const invalidCasting = speechBinding && (
        job.input.lineId !== speechBinding.publicLineId
        || job.input.inheritedVoiceProfileRevisionId !== speechBinding.voiceProfileRevisionId
        || job.input.voiceId !== speechBinding.voiceId
        || job.input.speed !== speechBinding.speed
        || job.input.pitch !== speechBinding.pitch
        || (job.input.emotion ?? null) !== speechBinding.emotion
      )
      if (invalidBase || invalidCasting) {
        throw new PipelineRunError(
          'PIPELINE_CHILD_BINDING_CONFLICT',
          `Speech child input binding is invalid: ${jobId}`,
        )
      }
    }
    return job
  }

  private requireRecoverableJob(
    run: PipelineRunRecord & { episodeId: string },
    document: PipelineRunDocument,
    job: GenerationJobRecord,
  ): void {
    for (const kind of ['storyboard', 'speech'] as const) {
      for (let index = 0; index < document.targets[kind].length; index += 1) {
        const targetId = document.targets[kind][index]
        const idempotencyKey = childIdempotencyKey(run.id, kind, targetId, index)
        if (job.idempotencyKey !== idempotencyKey) continue
        const provider = fanoutProvider(document, kind, index)
        if (!provider) {
          throw new PipelineRunError(
            'PIPELINE_CHILD_BINDING_CONFLICT',
            `Recovered ${kind} child has no frozen provider: ${job.id}`,
          )
        }
        this.requireFanoutJob(
          run,
          job.id,
          idempotencyKey,
          provider,
          kind,
          targetId,
          document.sourceRevisionId,
          kind === 'speech' ? document.bindings.speechTargets?.[index] : undefined,
        )
        return
      }
    }

    if (job.idempotencyKey === rootIdempotencyKey(run.id, 'export')) {
      const exportId = typeof job.input.exportId === 'string' ? job.input.exportId : ''
      this.requireBoundJob(
        run,
        job.id,
        rootIdempotencyKey(run.id, 'export'),
        undefined,
        'export.render',
        { exportId },
      )
      if (!exportId) {
        throw new PipelineRunError('PIPELINE_CHILD_BINDING_CONFLICT', `Recovered export has no ID: ${job.id}`)
      }
      this.requireExportRecordBinding(run, document, exportId)
      return
    }

    if (job.idempotencyKey === rootIdempotencyKey(run.id, 'quality')) {
      const reportId = typeof job.input.qualityReportId === 'string' ? job.input.qualityReportId : ''
      const exportId = typeof job.input.exportId === 'string' ? job.input.exportId : ''
      this.requireBoundJob(
        run,
        job.id,
        rootIdempotencyKey(run.id, 'quality'),
        undefined,
        'quality.check',
        { qualityReportId: reportId, exportId },
      )
      if (!reportId || !exportId || document.steps.export.exportId !== exportId) {
        throw new PipelineRunError('PIPELINE_CHILD_BINDING_CONFLICT', `Recovered quality IDs are invalid: ${job.id}`)
      }
      this.requireExportRecordBinding(run, document, exportId)
      this.requireQualityRecordBinding(run, document, reportId, exportId, job)
      return
    }

    throw new PipelineRunError(
      'PIPELINE_CHILD_BINDING_CONFLICT',
      `Pipeline recovery found an unknown child: ${job.id}`,
    )
  }

  private refreshFanout(
    run: PipelineRunRecord & { episodeId: string },
    document: PipelineRunDocument,
    kind: 'storyboard' | 'speech',
  ): FanoutSnapshot {
    const step = document.steps[kind]
    const targets = document.targets[kind]
    const jobs = step.jobIds.map((jobId, index) => {
      const provider = fanoutProvider(document, kind, index)
      if (!provider) throw new PipelineRunError('INVALID_PIPELINE_DOCUMENT', `${kind} provider is missing`)
      return this.requireFanoutJob(
        run,
        jobId,
        childIdempotencyKey(run.id, kind, targets[index], index),
        provider,
        kind,
        targets[index],
        document.sourceRevisionId,
        kind === 'speech' ? document.bindings.speechTargets?.[index] : undefined,
      )
    })
    const failures = jobs.filter((job) => job.status === 'failed' || job.status === 'cancelled')
    const active = jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status))
    step.completed = jobs.filter(terminalJob).length
    if (failures.length > 0) {
      step.error = childError(kind, failures[0])
      step.status = active ? 'running' : 'failed'
    } else if (jobs.length === step.total && jobs.every((job) => job.status === 'succeeded')) {
      step.status = 'succeeded'
      delete step.error
    } else if (jobs.length > 0) {
      step.status = 'running'
    }
    return { step, jobs, active, failed: failures.length > 0 }
  }

  private async enqueue(pipelineRunId: string, jobId: string): Promise<void> {
    this.assertMayAdvance(pipelineRunId)
    try {
      await this.ports.enqueue(jobId)
    } catch (error) {
      this.onError?.(error, { operation: 'enqueue', pipelineRunId })
      throw error
    }
    if (!this.mayAdvance(pipelineRunId)) {
      await this.cancelJobBestEffort(
        pipelineRunId,
        jobId,
        'Pipeline run ended while child was being enqueued',
      )
      throw new PipelineRunInterrupted(pipelineRunId)
    }
  }

  private computeProgress(document: PipelineRunDocument, extraJobs: GenerationJobRecord[] = []): number {
    const jobs = new Map<string, GenerationJobRecord>()
    for (const jobId of allDocumentJobIds(document)) {
      const job = this.database.getGenerationJob(jobId)
      if (job) jobs.set(job.id, job)
    }
    for (const job of extraJobs) jobs.set(job.id, job)
    return pipelineProgress(document, jobs)
  }

  private persist(
    run: PipelineRunRecord,
    document: PipelineRunDocument,
    extraJobs: GenerationJobRecord[] = [],
  ): PipelineRunRecord | undefined {
    const current = this.database.getPipelineRun(run.id)
    if (!current || TERMINAL_RUN_STATUSES.has(current.status)
      || this.terminationRequests.has(run.id)) return current
    return this.conditionalRunUpdate(run.id, {
      status: 'running',
      progress: Math.max(current.progress, this.computeProgress(document, extraJobs)),
      steps: documentAsJson(document),
      error: null,
      completedAt: null,
    })
  }

  private failRun(
    run: PipelineRunRecord,
    document: PipelineRunDocument,
    error: PipelineErrorDocument,
    extraJobs: GenerationJobRecord[] = [],
  ): PipelineRunRecord | undefined {
    const current = this.database.getPipelineRun(run.id)
    if (!current || TERMINAL_RUN_STATUSES.has(current.status)
      || this.terminationRequests.has(run.id)) return current
    return this.conditionalRunUpdate(run.id, {
      status: 'failed',
      progress: Math.max(current.progress, this.computeProgress(document, extraJobs)),
      steps: documentAsJson(document),
      error: errorAsJson(error),
      completedAt: this.now(),
    })
  }

  private failCorruptRun(run: PipelineRunRecord, error: unknown): PipelineRunRecord | undefined {
    const failure: PipelineErrorDocument = {
      code: 'INVALID_PIPELINE_DOCUMENT',
      message: (error instanceof Error ? error.message : 'Pipeline run document is invalid')
        .slice(0, MAX_ERROR_TEXT_LENGTH),
    }
    const current = this.database.getPipelineRun(run.id)
    if (!current || TERMINAL_RUN_STATUSES.has(current.status)
      || this.terminationRequests.has(run.id)) return current
    return this.conditionalRunUpdate(run.id, {
      status: 'failed',
      error: errorAsJson(failure),
      completedAt: this.now(),
    })
  }

  /** SQLite compare-and-set: terminal PipelineRun states are irreversible. */
  private conditionalRunUpdate(
    pipelineRunId: string,
    input: UpdatePipelineRunInput,
  ): PipelineRunRecord | undefined {
    const fields: string[] = []
    const values: Array<string | number | null> = []
    if (input.status !== undefined) {
      fields.push('status = ?')
      values.push(input.status)
    }
    if (input.progress !== undefined) {
      fields.push('progress = ?')
      values.push(input.progress)
    }
    if (input.steps !== undefined) {
      fields.push('steps_json = ?')
      values.push(JSON.stringify(input.steps))
    }
    if (input.error !== undefined) {
      fields.push('error_json = ?')
      values.push(input.error === null ? null : JSON.stringify(input.error))
    }
    if (input.completedAt !== undefined) {
      fields.push('completed_at = ?')
      values.push(input.completedAt)
    }
    if (fields.length === 0) return this.database.getPipelineRun(pipelineRunId)
    fields.push('updated_at = ?')
    values.push(this.now(), pipelineRunId)
    this.database.withSql((sql) => sql.run(`
      UPDATE pipeline_runs
         SET ${fields.join(', ')}
       WHERE id = ? AND status IN ('queued', 'running')
    `, ...values))
    return this.database.getPipelineRun(pipelineRunId)
  }

  private mayAdvance(pipelineRunId: string): boolean {
    if (this.terminationRequests.has(pipelineRunId)) return false
    const run = this.database.getPipelineRun(pipelineRunId)
    return Boolean(run && !TERMINAL_RUN_STATUSES.has(run.status))
  }

  private assertMayAdvance(pipelineRunId: string): void {
    if (!this.mayAdvance(pipelineRunId)) throw new PipelineRunInterrupted(pipelineRunId)
  }

  private listPipelineJobs(pipelineRunId: string): GenerationJobRecord[] {
    const jobs: GenerationJobRecord[] = []
    for (let offset = 0; ; offset += 1_000) {
      const page = this.database.listGenerationJobs({ pipelineRunId, limit: 1_000, offset })
      jobs.push(...page)
      if (page.length < 1_000) return jobs
    }
  }

  private async cancelJobBestEffort(
    pipelineRunId: string,
    jobId: string,
    message: string,
  ): Promise<void> {
    const job = this.database.getGenerationJob(jobId)
    if (!job || terminalJob(job)) return
    try {
      await this.ports.cancel(jobId, message)
    } catch (error) {
      this.onError?.(error, { operation: 'cancel', pipelineRunId })
    }
  }

  private async cancelActivePipelineJobs(pipelineRunId: string, message: string): Promise<void> {
    const active = this.listPipelineJobs(pipelineRunId)
      .filter((job) => ACTIVE_JOB_STATUSES.has(job.status))
    await Promise.all(active.map((job) => this.cancelJobBestEffort(
      pipelineRunId,
      job.id,
      message,
    )))
  }

  private runExclusive<T>(pipelineRunId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.operationTails.get(pipelineRunId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.operationTails.set(pipelineRunId, current)
    void current.then(
      () => {
        if (this.operationTails.get(pipelineRunId) === current) {
          this.operationTails.delete(pipelineRunId)
        }
      },
      () => {
        if (this.operationTails.get(pipelineRunId) === current) {
          this.operationTails.delete(pipelineRunId)
        }
      },
    )
    return current
  }
}
