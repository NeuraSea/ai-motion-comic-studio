import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { parseCanonicalTimelineDocument } from '../apps/opencut-editor/src/canonical-timeline-codec.js'
import {
  classifyTimelineAssetScope,
  projectTimelineMediaParticipation,
} from '../apps/opencut-editor/src/timeline-media-policy.js'
import type { GenerationJobRecord, ManjuDatabase, ProviderKind } from './database.js'
import type { CreateExportRenderResult, ExportRenderService } from './export-render.js'
import {
  type CreatePipelineRunRequest,
  type PipelineFanoutSubmission,
  type PipelineProviderBinding,
  type PipelineProviderSelection,
  type PipelineRunOptions,
  type PipelineRunPorts,
  type PipelineSpeechTargetBinding,
  type PipelineTimelineAutomaticEditDocument,
} from './pipeline-run.js'
import type {
  CreateQualityCheckResult,
  QualityCheckService,
  QualityDownloadAuthorization,
} from './quality-check.js'
import { validateCurrentQualityReleasePolicy } from './quality-release-policy.js'
import {
  DIALOGUE_SPEECH_GENERATION_JOB_TYPE,
  resolvePublicDialogueLine,
  sameSpeechSubmission,
  type DialogueSpeechJobInput,
} from './speech-generation.js'
import {
  parseStoryCharacterVoiceProfile,
  type StoryCharacterVoiceProfile,
  type StoryDocument,
  type StoryShot,
} from './story-schema.js'
import type { EpisodeRecord, StoryRepository } from './story-repository.js'
import {
  createStoryboardReferenceDecision,
  createStoryboardImageBinding,
  resolveEpisodeImageBinding,
  resolvePublicStoryboardShot,
  STORYBOARD_IMAGE_KIND,
  type StoryboardImageJobInput,
  type StoryboardShotTarget,
} from './storyboard-image-generation.js'
import { TimelineDocumentError, type TimelineDocumentSnapshot, type TimelineDocumentService } from './timeline-documents.js'
import type {
  TimelineMaterializationResult,
  TimelineMaterializationService,
} from './timeline-materialization.js'
import type { TimelineAutoEditService } from './timeline-auto-edit.js'
import type { ImageSize, JsonObject, JsonValue } from './types.js'
import type { JobRecord, JobRepository } from './worker.js'

const MAX_PROMPT_LENGTH = 8_000
const READY_STORYBOARD_KINDS = new Set([
  'storyboard',
  'shot.storyboard',
  'storyboard.image',
  'keyframe',
])
const READY_SPEECH_KINDS = new Set(['speech', 'dialogue.speech', 'tts', 'voice'])
const SUPPORTED_AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/wav'])
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])

export type PipelineProductionErrorCode =
  | 'AUDIO_REQUIRED'
  | 'DEFAULT_VOICE_REQUIRED'
  | 'CHARACTER_VOICE_BLOCKED'
  | 'EPISODE_NOT_FOUND'
  | 'IMAGE_PROVIDER_REQUIRED'
  | 'INVALID_PIPELINE_TARGET'
  | 'PIPELINE_CHILD_BINDING_CONFLICT'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'QUALITY_BINDING_CONFLICT'
  | 'SOURCE_REVISION_MISSING'
  | 'SPEECH_PROVIDER_REQUIRED'
  | 'STORY_GRAPH_INCONSISTENT'
  | 'STORY_NOT_FOUND'
  | 'INVALID_TIMELINE'
  | 'TIMELINE_BINDING_CONFLICT'

export class PipelineProductionError extends Error {
  constructor(
    readonly code: PipelineProductionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PipelineProductionError'
  }
}

export interface PipelineProductionDiscovery {
  projectId: string
  episodeId: string
  sourceRevisionId: string
  storyboardTargets: string[]
  speechTargets: string[]
  speechBindings: PipelineSpeechTargetBinding[]
  voiceBlockers: PipelineVoiceBlocker[]
  voiceSummary: PipelineVoiceSummary
  readyStoryboardCount: number
  readySpeechCount: number
  hasReadySpeech: boolean
  hasPublishableTimelineAudio: boolean
  hasPublishableAudio: boolean
}

export interface PipelineVoiceBlocker {
  code:
    | 'DIALOGUE_CHARACTER_REQUIRED'
    | 'CHARACTER_VOICE_PROFILE_MISSING'
    | 'CHARACTER_VOICE_PROFILE_INVALID'
    | 'CHARACTER_VOICE_AUDIT_INVALID'
    | 'CHARACTER_VOICE_PROVIDER_UNAVAILABLE'
    | 'CHARACTER_VOICE_PROVIDER_CHANGED'
    | 'CHARACTER_VOICE_HISTORICAL_PIN_UNSUPPORTED'
    | 'CHARACTER_VOICE_CATALOG_CHANGED'
    | 'CHARACTER_VOICE_REMOVED'
  characterId: string | null
  characterName: string
  lineCount: number
  lineIds: string[]
  message: string
}

export interface PipelineVoiceSummaryCharacter {
  characterId: string
  characterName: string
  voiceId: string
  voiceName: string
  providerId: string
  providerConfigRevision: number
  targetCount: number
  sceneDirectedTargetCount: number
}

export interface PipelineVoiceSummary {
  boundCharacterCount: number
  distinctVoiceCount: number
  sceneDirectedTargetCount: number
  characters: PipelineVoiceSummaryCharacter[]
}

export interface PipelineCurrentVoiceCatalog {
  providerId: string
  providerConfigRevision: number
  fingerprint: string
  voices: Array<{ voiceId: string }>
}

export interface PreparedPipelineProduction {
  discovery: PipelineProductionDiscovery
  request: CreatePipelineRunRequest
}

export interface PipelineProductionRequestInput {
  projectId: string
  episodeId: string
  idempotencyKey: string
  callerIntentFingerprint?: string
  options?: PipelineRunOptions
  imageProvider?: PipelineProviderSelection
  speechProvider?: PipelineProviderSelection
}

export interface PipelineProductionDiscoveryDependencies {
  database: ManjuDatabase
  timelines: Pick<TimelineDocumentService, 'get'>
}

interface StoryReadPort {
  getEpisode(episodeId: string): EpisodeRecord | undefined
  getStory(episodeId: string): StoryDocument | undefined
}

interface TimelineMaterializationPort {
  materialize(input: {
    projectId: string
    episodeId: string
    expectedRevisionId: null
    summary?: string
    autoLayoutManagedDialogue?: boolean
  }): TimelineMaterializationResult
  reconcile(input: {
    projectId: string
    episodeId: string
    expectedRevisionId: string
    summary?: string
    autoLayoutManagedDialogue?: boolean
  }): TimelineMaterializationResult
}

interface TimelineAutoEditPort {
  preview: TimelineAutoEditService['preview']
  apply: TimelineAutoEditService['apply']
}

interface ExportCreationPort {
  create(input: Parameters<ExportRenderService['create']>[0]): CreateExportRenderResult
}

interface QualityCreationPort {
  create(input: Parameters<QualityCheckService['create']>[0]): CreateQualityCheckResult
  requireDownloadAuthorization(exportId: string): QualityDownloadAuthorization
}

export interface PipelineProductionWorkerPort {
  enqueue(jobId: string): void
  cancel(jobId: string, message?: string): Promise<JobRecord | undefined>
}

export interface PipelineProductionAdmissionIdentity {
  projectId: string
  idempotencyKey: string
}

export interface PipelineProductionAdmissionPort {
  <T>(identity: PipelineProductionAdmissionIdentity, operation: () => Promise<T> | T): Promise<T>
}

export interface PipelineProductionPortDependencies {
  database: ManjuDatabase
  stories: StoryReadPort | Pick<StoryRepository, 'getEpisode' | 'getStory'>
  timelines: Pick<TimelineDocumentService, 'get'>
  timelineMaterialization: TimelineMaterializationPort | Pick<TimelineMaterializationService, 'materialize' | 'reconcile'>
  timelineAutoEdit: TimelineAutoEditPort | Pick<TimelineAutoEditService, 'preview' | 'apply'>
  exports: ExportCreationPort | Pick<ExportRenderService, 'create'>
  qualityChecks: QualityCreationPort | Pick<QualityCheckService, 'create' | 'requireDownloadAuthorization'>
  durableJobs: Pick<JobRepository, 'create'>
  admitDurableJob: PipelineProductionAdmissionPort
  worker: PipelineProductionWorkerPort
}

type SqlRow = Record<string, unknown>

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PipelineProductionError('INVALID_PIPELINE_TARGET', `${label} must not be empty`)
  }
  return value.trim()
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new PipelineProductionError('STORY_GRAPH_INCONSISTENT', `${label} must be nullable text`)
  }
  return value
}

function storedJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Fall through to the deterministic binding error below.
    }
  }
  throw new PipelineProductionError('QUALITY_BINDING_CONFLICT', `${label} is invalid`)
}

function storyId(metadataText: unknown, fallback: string): string {
  if (typeof metadataText !== 'string') {
    throw new PipelineProductionError('STORY_GRAPH_INCONSISTENT', 'Story metadata is not JSON text')
  }
  let metadata: unknown
  try {
    metadata = JSON.parse(metadataText)
  } catch (cause) {
    throw new PipelineProductionError('STORY_GRAPH_INCONSISTENT', 'Story metadata is invalid JSON', { cause })
  }
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).storyId
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return fallback
}

function requireEpisode(
  database: ManjuDatabase,
  projectId: string,
  episodeId: string,
): { sourceRevisionId: string; aspectRatio: string; stylePreset: string } {
  const row = database.withSql((sql) => sql.get(`
    SELECT project_id, source_revision_id, aspect_ratio, style_preset
      FROM episodes WHERE id = ?
  `, episodeId))
  if (!row || row.project_id !== projectId) {
    throw new PipelineProductionError('EPISODE_NOT_FOUND', 'Episode was not found in this project')
  }
  const sourceRevisionId = nullableString(row.source_revision_id, 'episodes.source_revision_id')
  if (!sourceRevisionId) {
    throw new PipelineProductionError(
      'SOURCE_REVISION_MISSING',
      'Episode has no immutable Story source revision',
    )
  }
  return {
    sourceRevisionId,
    aspectRatio: requiredString(row.aspect_ratio, 'episodes.aspect_ratio'),
    stylePreset: typeof row.style_preset === 'string' ? row.style_preset : '',
  }
}

function readyStoryboard(
  database: ManjuDatabase,
  assetId: string | null,
  scope: { projectId: string; episodeId: string; sourceRevisionId: string },
): boolean {
  if (!assetId) return false
  const asset = database.getMediaAsset(assetId)
  const mimeType = asset?.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return Boolean(asset
    && asset.projectId === scope.projectId
    && asset.episodeId === scope.episodeId
    && asset.sourceRevisionId === scope.sourceRevisionId
    && asset.status === 'ready'
    && Boolean(asset.filePath)
    && READY_STORYBOARD_KINDS.has(asset.kind)
    && SUPPORTED_IMAGE_MIME_TYPES.has(mimeType))
}

function readySpeech(
  database: ManjuDatabase,
  assetId: string | null,
  scope: { projectId: string; episodeId: string; sourceRevisionId: string },
): boolean {
  if (!assetId) return false
  const asset = database.getMediaAsset(assetId)
  const mimeType = asset?.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return Boolean(asset
    && asset.projectId === scope.projectId
    && asset.episodeId === scope.episodeId
    && asset.sourceRevisionId === scope.sourceRevisionId
    && asset.status === 'ready'
    && Boolean(asset.filePath)
    && READY_SPEECH_KINDS.has(asset.kind)
    && SUPPORTED_AUDIO_MIME_TYPES.has(mimeType)
    && typeof asset.durationSeconds === 'number'
    && Number.isFinite(asset.durationSeconds)
    && asset.durationSeconds > 0)
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function publicStoryId(metadata: unknown, fallback: string): string {
  const parsed = parseJsonObject(metadata)
  return typeof parsed?.storyId === 'string' && parsed.storyId.trim()
    ? parsed.storyId.trim()
    : fallback
}

interface SpeechRowResolution {
  binding?: PipelineSpeechTargetBinding
  blocker?: Omit<PipelineVoiceBlocker, 'lineCount' | 'lineIds'>
}

function resolveSpeechRowBinding(
  database: ManjuDatabase,
  scope: { projectId: string; episodeId: string; sourceRevisionId: string },
  row: SqlRow,
): SpeechRowResolution {
  const lineDatabaseId = requiredString(row.line_id, 'dialogue_lines.id')
  const publicLineId = publicStoryId(row.line_metadata_json, lineDatabaseId)
  const characterDatabaseId = nullableString(row.character_id, 'dialogue_lines.character_id')
  if (!characterDatabaseId) {
    return { blocker: {
      code: 'DIALOGUE_CHARACTER_REQUIRED',
      characterId: null,
      characterName: '旁白 / 未匹配角色',
      message: '存在未绑定角色的对白；MVP 不会使用全局默认音色，请先把台词绑定到角色并配置声线',
    } }
  }
  const characterName = typeof row.character_name === 'string' && row.character_name.trim()
    ? row.character_name.trim()
    : '未知角色'
  const characterMetadata = parseJsonObject(row.character_metadata_json)
  const characterId = publicStoryId(row.character_metadata_json, characterDatabaseId)
  const baseBlocker = { characterId, characterName }
  if (!characterMetadata
    || (characterMetadata.voiceProfile === undefined
      && characterMetadata.voiceProfileRevisionId === undefined)) {
    return { blocker: {
      ...baseBlocker,
      code: 'CHARACTER_VOICE_PROFILE_MISSING',
      message: `角色「${characterName}」尚未配置声线`,
    } }
  }
  if (typeof characterMetadata.voiceProfileRevisionId !== 'string') {
    return { blocker: {
      ...baseBlocker,
      code: 'CHARACTER_VOICE_PROFILE_INVALID',
      message: `角色「${characterName}」声线缺少不可变审计版本，请重新绑定`,
    } }
  }
  let profile: StoryCharacterVoiceProfile
  try {
    profile = parseStoryCharacterVoiceProfile(characterMetadata.voiceProfile)
  } catch {
    return { blocker: {
      ...baseBlocker,
      code: 'CHARACTER_VOICE_PROFILE_INVALID',
      message: `角色「${characterName}」声线记录损坏，请重新绑定`,
    } }
  }
  const audit = database.getRevision(characterMetadata.voiceProfileRevisionId)
  let audited: StoryCharacterVoiceProfile | undefined
  try {
    audited = audit?.snapshot.kind === 'character.voice-profile'
      && audit.snapshot.projectId === scope.projectId
      && audit.snapshot.episodeId === scope.episodeId
      && audit.snapshot.characterId === characterId
      ? parseStoryCharacterVoiceProfile(audit.snapshot.profile)
      : undefined
  } catch {
    audited = undefined
  }
  if (!audit || audit.projectId !== scope.projectId || !audited
    || !isDeepStrictEqual(profile, audited)) {
    return { blocker: {
      ...baseBlocker,
      code: 'CHARACTER_VOICE_AUDIT_INVALID',
      message: `角色「${characterName}」声线审计记录不一致，请重新绑定`,
    } }
  }
  if (profile.historicalPin) {
    return { blocker: {
      ...baseBlocker,
      code: 'CHARACTER_VOICE_HISTORICAL_PIN_UNSUPPORTED',
      message: `角色「${characterName}」绑定了历史 Provider 修订；一键生产要求先用当前目录重新确认`,
    } }
  }
  const connection = database.getProviderConnection(profile.providerId)
  if (!connection || connection.kind !== 'speech' || !connection.enabled) {
    return { blocker: {
      ...baseBlocker,
      code: 'CHARACTER_VOICE_PROVIDER_UNAVAILABLE',
      message: `角色「${characterName}」的语音 Provider 已禁用或不存在`,
    } }
  }
  if (connection.configRevision !== profile.providerConfigRevision) {
    return { blocker: {
      ...baseBlocker,
      code: 'CHARACTER_VOICE_PROVIDER_CHANGED',
      message: `角色「${characterName}」的 Provider 已从 r${profile.providerConfigRevision} 更新到 r${connection.configRevision}，请重新确认声线`,
    } }
  }
  const version = database.getProviderConnectionVersion(profile.providerId, profile.providerConfigRevision)
  if (!version || version.kind !== 'speech' || !version.model?.trim() || !version.baseUrl?.trim()
    || (version.adapter !== 'minimax'
      && version.adapter !== 'openai-compatible'
      && version.adapter !== 'indextts')
    || (version.authMode === 'byok' && !version.credentialReference)) {
    return { blocker: {
      ...baseBlocker,
      code: 'CHARACTER_VOICE_PROVIDER_UNAVAILABLE',
      message: `角色「${characterName}」的语音 Provider 修订不可执行`,
    } }
  }
  const sceneDatabaseId = requiredString(row.scene_id, 'scenes.id')
  const sceneId = publicStoryId(row.scene_metadata_json, sceneDatabaseId)
  const direction = profile.sceneDirections?.find((item) => item.sceneId === sceneId)
  const delivery = direction ?? profile.defaultDelivery
  return { binding: {
    targetId: lineDatabaseId,
    publicLineId,
    sceneId,
    characterId,
    characterDatabaseId,
    characterName,
    voiceId: profile.voiceId,
    voiceName: profile.voiceName,
    voiceProfileRevisionId: characterMetadata.voiceProfileRevisionId,
    catalogFingerprint: profile.catalogFingerprint,
    provider: {
      providerId: profile.providerId,
      configRevision: profile.providerConfigRevision,
      model: version.model,
    },
    speed: delivery?.speed ?? 1,
    pitch: delivery?.pitch ?? 0,
    emotion: delivery?.emotion ?? null,
    sceneDirectionApplied: Boolean(direction),
  } }
}

function aggregateVoiceDiscovery(
  bindings: readonly PipelineSpeechTargetBinding[],
  blockerRows: Array<{ blocker: Omit<PipelineVoiceBlocker, 'lineCount' | 'lineIds'>; lineId: string }>,
): { blockers: PipelineVoiceBlocker[]; summary: PipelineVoiceSummary } {
  const blockers = new Map<string, PipelineVoiceBlocker>()
  for (const { blocker, lineId } of blockerRows) {
    const key = `${blocker.code}:${blocker.characterId ?? 'unmatched'}`
    const existing = blockers.get(key)
    if (existing) {
      existing.lineCount += 1
      existing.lineIds.push(lineId)
    } else {
      blockers.set(key, { ...blocker, lineCount: 1, lineIds: [lineId] })
    }
  }
  const characters = new Map<string, PipelineVoiceSummaryCharacter>()
  for (const binding of bindings) {
    const existing = characters.get(binding.characterId)
    if (existing) {
      existing.targetCount += 1
      if (binding.sceneDirectionApplied) existing.sceneDirectedTargetCount += 1
    } else {
      characters.set(binding.characterId, {
        characterId: binding.characterId,
        characterName: binding.characterName,
        voiceId: binding.voiceId,
        voiceName: binding.voiceName,
        providerId: binding.provider.providerId,
        providerConfigRevision: binding.provider.configRevision,
        targetCount: 1,
        sceneDirectedTargetCount: binding.sceneDirectionApplied ? 1 : 0,
      })
    }
  }
  const values = [...characters.values()]
  return {
    blockers: [...blockers.values()],
    summary: {
      boundCharacterCount: values.length,
      distinctVoiceCount: new Set(values.map((value) => `${value.providerId}:${value.voiceId}`)).size,
      sceneDirectedTargetCount: values.reduce((sum, value) => sum + value.sceneDirectedTargetCount, 0),
      characters: values,
    },
  }
}

/**
 * Non-billable catalog gate used by HTTP preflight/create. A saved profile is
 * only a snapshot; MiniMax may remove a voice without rotating Provider config.
 */
export function validatePipelineVoiceCatalog(
  discovery: PipelineProductionDiscovery,
  catalogOrCatalogs: PipelineCurrentVoiceCatalog | readonly PipelineCurrentVoiceCatalog[],
): PipelineProductionDiscovery {
  if (discovery.speechBindings.length === 0) return discovery
  const catalogs: readonly PipelineCurrentVoiceCatalog[] = Array.isArray(catalogOrCatalogs)
    ? catalogOrCatalogs as readonly PipelineCurrentVoiceCatalog[]
    : [catalogOrCatalogs as PipelineCurrentVoiceCatalog]
  const catalogByProvider = new Map(catalogs.map((catalog) => [catalog.providerId, catalog]))
  const extraRows: Array<{
    blocker: Omit<PipelineVoiceBlocker, 'lineCount' | 'lineIds'>
    lineId: string
  }> = []
  for (const binding of discovery.speechBindings) {
    const catalog = catalogByProvider.get(binding.provider.providerId)
    const available = new Set(catalog?.voices.map((voice) => voice.voiceId) ?? [])
    const identityMatches = catalog !== undefined
      && binding.provider.providerId === catalog.providerId
      && binding.provider.configRevision === catalog.providerConfigRevision
      && binding.catalogFingerprint === catalog.fingerprint
    if (!identityMatches) {
      extraRows.push({
        lineId: binding.targetId,
        blocker: {
          code: 'CHARACTER_VOICE_CATALOG_CHANGED',
          characterId: binding.characterId,
          characterName: binding.characterName,
          message: `角色「${binding.characterName}」保存后的音色目录已变化，请重新确认角色声线`,
        },
      })
    } else if (!available.has(binding.voiceId)) {
      extraRows.push({
        lineId: binding.targetId,
        blocker: {
          code: 'CHARACTER_VOICE_REMOVED',
          characterId: binding.characterId,
          characterName: binding.characterName,
          message: `角色「${binding.characterName}」绑定的音色已不在真实账号目录中，请重新选择`,
        },
      })
    }
  }
  if (extraRows.length === 0) return discovery
  const additions = aggregateVoiceDiscovery([], extraRows).blockers
  const merged = new Map<string, PipelineVoiceBlocker>(discovery.voiceBlockers.map((blocker) => (
    [`${blocker.code}:${blocker.characterId ?? 'unmatched'}`, structuredClone(blocker)] as const
  )))
  for (const blocker of additions) {
    const key = `${blocker.code}:${blocker.characterId ?? 'unmatched'}`
    const existing = merged.get(key)
    if (existing) {
      existing.lineCount += blocker.lineCount
      existing.lineIds.push(...blocker.lineIds)
    } else {
      merged.set(key, blocker)
    }
  }
  return { ...discovery, voiceBlockers: [...merged.values()] }
}

function currentTimeline(
  timelines: Pick<TimelineDocumentService, 'get'>,
  episodeId: string,
): TimelineDocumentSnapshot | undefined {
  try {
    return timelines.get(episodeId)
  } catch (error) {
    if (error instanceof TimelineDocumentError && error.code === 'TIMELINE_DOCUMENT_NOT_FOUND') return undefined
    if (error && typeof error === 'object'
      && (error as Record<string, unknown>).code === 'TIMELINE_DOCUMENT_NOT_FOUND') return undefined
    throw error
  }
}

function pipelineAutomaticEditReceiptFromDocument(
  document: JsonObject,
): PipelineTimelineAutomaticEditDocument | undefined {
  const integration = document.manjuTimeline
  if (!integration || typeof integration !== 'object' || Array.isArray(integration)) return undefined
  const value = (integration as JsonObject).automaticEdit
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const receipt = value as JsonObject
  if (receipt.strategy !== 'managed-dialogue-reflow-v1'
    || receipt.executor !== 'OpenCut-Classic/UpdateElementsCommand'
    || typeof receipt.planHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(receipt.planHash)
    || !Number.isSafeInteger(receipt.operationCount)
    || (receipt.operationCount as number) < 1
    || !Array.isArray(receipt.changedElementIds)) return undefined
  const changedElementIds = receipt.changedElementIds.filter((id): id is string => (
    typeof id === 'string' && Boolean(id.trim())
  ))
  if (changedElementIds.length !== receipt.operationCount
    || new Set(changedElementIds).size !== changedElementIds.length) return undefined
  const planId = typeof receipt.planId === 'string' && receipt.planId.trim()
    ? receipt.planId.trim()
    : undefined
  const applicationId = typeof receipt.applicationId === 'string' && receipt.applicationId.trim()
    ? receipt.applicationId.trim()
    : undefined
  return {
    strategy: receipt.strategy,
    executor: receipt.executor,
    planHash: receipt.planHash,
    operationCount: receipt.operationCount as number,
    changedElementIds,
    ...(planId ? { planId } : {}),
    ...(applicationId ? { applicationId } : {}),
  }
}

function hasPublishableTimelineAudio(
  database: ManjuDatabase,
  timelines: Pick<TimelineDocumentService, 'get'>,
  projectId: string,
  episodeId: string,
): boolean {
  const snapshot = currentTimeline(timelines, episodeId)
  if (!snapshot) return false
  const document = parseCanonicalTimelineDocument(snapshot.document)
  const usable = (assetId: string | undefined, expected: 'audio' | 'video'): boolean => {
    if (!assetId) return false
    const asset = database.getMediaAsset(assetId)
    if (!asset
      || classifyTimelineAssetScope(asset, { projectId, episodeId }) !== 'allowed'
      || asset.status !== 'ready'
      || !asset.filePath) return false
    if (expected === 'audio') return SUPPORTED_AUDIO_MIME_TYPES.has(asset.mimeType ?? '')
    return asset.mimeType === 'video/mp4' || asset.mimeType === 'video/webm'
  }
  for (const track of document.tracks.audio) {
    for (const element of track.elements) {
      if (projectTimelineMediaParticipation(track, element).timelineAudio
        && element.type === 'audio'
        && element.sourceType === 'upload'
        && usable(element.mediaId, 'audio')) return true
    }
  }
  for (const track of [...document.tracks.overlay, document.tracks.main]) {
    if (track.type !== 'video') continue
    for (const element of track.elements) {
      if (projectTimelineMediaParticipation(track, element).sourceAudio
        && element.type === 'video'
        && usable(element.mediaId, 'video')) return true
    }
  }
  return false
}

export function discoverPipelineProduction(
  dependencies: PipelineProductionDiscoveryDependencies,
  input: { projectId: string; episodeId: string },
): PipelineProductionDiscovery {
  const projectId = requiredString(input.projectId, 'projectId')
  const episodeId = requiredString(input.episodeId, 'episodeId')
  const episode = requireEpisode(dependencies.database, projectId, episodeId)
  const scope = { projectId, episodeId, sourceRevisionId: episode.sourceRevisionId }

  const shotRows = dependencies.database.withSql((sql) => sql.all(`
    SELECT shots.id, shots.source_revision_id, shots.storyboard_asset_id
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
     WHERE scenes.episode_id = ?
     ORDER BY scenes.sequence, shots.sequence, shots.id
  `, episodeId))
  const storyboardTargets: string[] = []
  let readyStoryboardCount = 0
  for (const row of shotRows) {
    const shotId = requiredString(row.id, 'shots.id')
    if (nullableString(row.source_revision_id, 'shots.source_revision_id') !== episode.sourceRevisionId) {
      throw new PipelineProductionError(
        'STORY_GRAPH_INCONSISTENT',
        `Shot ${shotId} is not bound to the episode source revision`,
      )
    }
    const assetId = nullableString(row.storyboard_asset_id, 'shots.storyboard_asset_id')
    if (readyStoryboard(dependencies.database, assetId, scope)) readyStoryboardCount += 1
    else storyboardTargets.push(shotId)
  }

  const speechRows = dependencies.database.withSql((sql) => sql.all(`
    SELECT dialogue_lines.id AS line_id, dialogue_lines.text,
           dialogue_lines.metadata_json AS line_metadata_json,
           dialogue_lines.speech_asset_id, dialogue_lines.character_id,
           characters.name AS character_name,
           characters.metadata_json AS character_metadata_json,
           scenes.id AS scene_id, scenes.metadata_json AS scene_metadata_json,
           shots.source_revision_id
      FROM dialogue_lines
      JOIN shots ON shots.id = dialogue_lines.shot_id
      JOIN scenes ON scenes.id = shots.scene_id
      LEFT JOIN characters ON characters.id = dialogue_lines.character_id
     WHERE scenes.episode_id = ?
     ORDER BY scenes.sequence, shots.sequence, dialogue_lines.sequence, dialogue_lines.id
  `, episodeId))
  const speechTargets: string[] = []
  const speechBindings: PipelineSpeechTargetBinding[] = []
  const voiceBlockerRows: Array<{
    blocker: Omit<PipelineVoiceBlocker, 'lineCount' | 'lineIds'>
    lineId: string
  }> = []
  let readySpeechCount = 0
  for (const row of speechRows) {
    const lineId = requiredString(row.line_id, 'dialogue_lines.id')
    if (!requiredString(row.text, `dialogue_lines.${lineId}.text`)) {
      throw new PipelineProductionError('STORY_GRAPH_INCONSISTENT', `Dialogue ${lineId} is empty`)
    }
    if (nullableString(row.source_revision_id, 'shots.source_revision_id') !== episode.sourceRevisionId) {
      throw new PipelineProductionError(
        'STORY_GRAPH_INCONSISTENT',
        `Dialogue ${lineId} belongs to a stale shot`,
      )
    }
    const assetId = nullableString(row.speech_asset_id, 'dialogue_lines.speech_asset_id')
    if (readySpeech(dependencies.database, assetId, scope)) {
      readySpeechCount += 1
    } else {
      speechTargets.push(lineId)
      const resolution = resolveSpeechRowBinding(dependencies.database, scope, row)
      if (resolution.binding) speechBindings.push(resolution.binding)
      if (resolution.blocker) {
        voiceBlockerRows.push({ blocker: resolution.blocker, lineId })
      }
    }
  }

  const voiceDiscovery = aggregateVoiceDiscovery(speechBindings, voiceBlockerRows)

  const timelineAudio = hasPublishableTimelineAudio(
    dependencies.database,
    dependencies.timelines,
    projectId,
    episodeId,
  )
  return {
    projectId,
    episodeId,
    sourceRevisionId: episode.sourceRevisionId,
    storyboardTargets,
    speechTargets,
    speechBindings,
    voiceBlockers: voiceDiscovery.blockers,
    voiceSummary: voiceDiscovery.summary,
    readyStoryboardCount,
    readySpeechCount,
    hasReadySpeech: readySpeechCount > 0,
    hasPublishableTimelineAudio: timelineAudio,
    hasPublishableAudio: readySpeechCount > 0 || timelineAudio,
  }
}

function configuredProvider(
  database: ManjuDatabase,
  selection: PipelineProviderSelection | undefined,
  kind: Extract<ProviderKind, 'image' | 'speech'>,
): boolean {
  if (!selection?.providerId.trim()) return false
  const connection = database.getProviderConnection(selection.providerId.trim())
  if (!connection || connection.kind !== kind || !connection.enabled) return false
  const revision = selection.configRevision ?? connection.configRevision
  const version = database.getProviderConnectionVersion(connection.id, revision)
  const model = selection.model === undefined ? version?.model : selection.model
  if (!version || version.kind !== kind || !version.baseUrl?.trim() || !model?.trim()) return false
  if (version.authMode === 'byok' && !version.credentialReference) return false
  if (kind === 'speech'
    && version.adapter !== 'minimax'
    && version.adapter !== 'openai-compatible'
    && version.adapter !== 'indextts') return false
  if (kind === 'image' && version.adapter !== 'codex-tools' && version.adapter !== 'openai-compatible') return false
  return true
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`
}

function providerIntent(value: PipelineProviderSelection | undefined): JsonObject | null {
  if (!value) return null
  return {
    providerId: requiredString(value.providerId, 'providerId'),
  }
}

/**
 * Stable caller intent before mutable readiness discovery changes targets.
 * Provider revision/model are deliberately excluded because they are resolved
 * server state. HTTP integrations that resolve an omitted default provider
 * must pass an override computed from the raw request before resolution, so
 * "provider omitted" remains distinct from an explicit provider ID.
 */
export function pipelineProductionCallerIntentFingerprint(
  input: PipelineProductionRequestInput,
): string {
  const options = input.options
  const intent: JsonObject = {
    version: 1,
    projectId: requiredString(input.projectId, 'projectId'),
    episodeId: requiredString(input.episodeId, 'episodeId'),
    options: {
      resolution: options?.resolution ?? '1080p',
      kenBurns: options?.kenBurns === true,
      burnSubtitles: options?.burnSubtitles !== false,
      introTitle: options?.introTitle !== false,
      outroCard: options?.outroCard !== false,
      reviewWatermark: options?.reviewWatermark === true,
      speechMode: options?.speechMode ?? 'auto',
      ...(options?.defaultVoiceId?.trim()
        ? { defaultVoiceId: options.defaultVoiceId.trim() }
        : {}),
    },
    imageProvider: providerIntent(input.imageProvider),
    speechProvider: providerIntent(input.speechProvider),
  }
  return createHash('sha256').update(canonicalJson(intent)).digest('hex')
}

export function createPipelineProductionRequest(
  dependencies: PipelineProductionDiscoveryDependencies,
  input: PipelineProductionRequestInput,
): CreatePipelineRunRequest {
  const discovery = discoverPipelineProduction(dependencies, input)
  return createPipelineProductionRequestFromDiscovery(dependencies, input, discovery)
}

export function createPipelineProductionRequestFromDiscovery(
  dependencies: PipelineProductionDiscoveryDependencies,
  input: PipelineProductionRequestInput,
  discovery: PipelineProductionDiscovery,
): CreatePipelineRunRequest {
  if (discovery.projectId !== requiredString(input.projectId, 'projectId')
    || discovery.episodeId !== requiredString(input.episodeId, 'episodeId')) {
    throw new PipelineProductionError(
      'INVALID_PIPELINE_TARGET',
      'Production discovery does not belong to the requested project and episode',
    )
  }
  const speechMode = input.options?.speechMode ?? 'auto'
  const speechTargets = speechMode === 'skip' ? [] : discovery.speechTargets
  const legacySpeech = Boolean(input.options?.defaultVoiceId?.trim())
  if (discovery.storyboardTargets.length > 0
    && !configuredProvider(dependencies.database, input.imageProvider, 'image')) {
    throw new PipelineProductionError(
      input.imageProvider ? 'PROVIDER_NOT_CONFIGURED' : 'IMAGE_PROVIDER_REQUIRED',
      'A configured image provider is required for missing storyboards',
    )
  }
  if (speechMode === 'auto' && speechTargets.length > 0) {
    if (legacySpeech) {
      if (!configuredProvider(dependencies.database, input.speechProvider, 'speech')) {
        throw new PipelineProductionError(
          input.speechProvider ? 'PROVIDER_NOT_CONFIGURED' : 'SPEECH_PROVIDER_REQUIRED',
          'A configured speech provider is required for legacy automatic dialogue speech',
        )
      }
    } else {
      if (discovery.voiceBlockers.length > 0
        || discovery.speechBindings.length !== speechTargets.length) {
        throw new PipelineProductionError(
          'CHARACTER_VOICE_BLOCKED',
          discovery.voiceBlockers.map((blocker) => blocker.message).join('；')
            || 'Missing dialogue speech does not have complete character voice bindings',
        )
      }
    }
  }
  // A production run must have either durable audio already available or a
  // concrete speech fanout that will create it. Never synthesize fake/silent
  // placeholder audio merely to satisfy export/QC.
  if (!discovery.hasPublishableAudio && speechTargets.length === 0) {
    throw new PipelineProductionError(
      'AUDIO_REQUIRED',
      'Add publishable BGM/SFX, keep ready dialogue speech, or enable speech generation',
    )
  }
  return {
    projectId: discovery.projectId,
    episodeId: discovery.episodeId,
    sourceRevisionId: discovery.sourceRevisionId,
    idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey'),
    callerIntentFingerprint: input.callerIntentFingerprint === undefined
      ? pipelineProductionCallerIntentFingerprint(input)
      : requiredString(input.callerIntentFingerprint, 'callerIntentFingerprint'),
    options: {
      ...(input.options ?? {}),
      speechMode,
    },
    ...(input.imageProvider ? { imageProvider: { ...input.imageProvider } } : {}),
    ...(input.speechProvider ? { speechProvider: { ...input.speechProvider } } : {}),
    ...(!legacySpeech && speechMode === 'auto' && speechTargets.length > 0
      ? { speechBindings: discovery.speechBindings.map((binding) => structuredClone(binding)) }
      : {}),
    targets: {
      storyboard: discovery.storyboardTargets,
      speech: speechTargets,
    },
  }
}

/** One authoritative discovery snapshot for preflight, quota and creation. */
export function preparePipelineProduction(
  dependencies: PipelineProductionDiscoveryDependencies,
  input: PipelineProductionRequestInput,
): PreparedPipelineProduction {
  const discovery = discoverPipelineProduction(dependencies, input)
  return {
    discovery,
    request: createPipelineProductionRequestFromDiscovery(dependencies, input, discovery),
  }
}

function requireProviderBinding(
  database: ManjuDatabase,
  binding: PipelineProviderBinding,
  kind: Extract<ProviderKind, 'image' | 'speech'>,
): void {
  const version = database.getProviderConnectionVersion(binding.providerId, binding.configRevision)
  if (!version
    || version.kind !== kind
    || !binding.model
    || version.model !== binding.model
    || !version.baseUrl?.trim()) {
    throw new PipelineProductionError(
      'PROVIDER_NOT_CONFIGURED',
      `Frozen ${kind} provider binding is not executable`,
    )
  }
  if (version.authMode === 'byok' && !version.credentialReference) {
    throw new PipelineProductionError('PROVIDER_NOT_CONFIGURED', `Frozen ${kind} provider has no credential binding`)
  }
  if (kind === 'speech'
    && version.adapter !== 'minimax'
    && version.adapter !== 'openai-compatible'
    && version.adapter !== 'indextts') {
    throw new PipelineProductionError('PROVIDER_NOT_CONFIGURED', 'Speech provider adapter is not implemented')
  }
  if (kind === 'image' && version.adapter !== 'codex-tools' && version.adapter !== 'openai-compatible') {
    throw new PipelineProductionError('PROVIDER_NOT_CONFIGURED', 'Image provider adapter is not implemented')
  }
}

function storyboardTargetByDatabaseId(
  database: ManjuDatabase,
  input: PipelineFanoutSubmission,
): StoryboardShotTarget {
  const row = database.withSql((sql) => sql.get(`
    SELECT shots.id AS shot_id, shots.metadata_json AS shot_metadata,
           scenes.id AS scene_id, scenes.metadata_json AS scene_metadata
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
      JOIN episodes ON episodes.id = scenes.episode_id
     WHERE shots.id = ? AND episodes.id = ? AND episodes.project_id = ?
  `, input.targetId, input.episodeId, input.projectId))
  if (!row) {
    throw new PipelineProductionError('INVALID_PIPELINE_TARGET', 'Storyboard target no longer exists')
  }
  const publicShotId = storyId(row.shot_metadata, requiredString(row.shot_id, 'shots.id'))
  const publicSceneId = storyId(row.scene_metadata, requiredString(row.scene_id, 'scenes.id'))
  const target = resolvePublicStoryboardShot(database, {
    projectId: input.projectId,
    episodeId: input.episodeId,
    shotId: publicShotId,
    sceneId: publicSceneId,
  })
  if (target.databaseShotId !== input.targetId || target.sourceRevisionId !== input.sourceRevisionId) {
    throw new PipelineProductionError('INVALID_PIPELINE_TARGET', 'Storyboard target source binding changed')
  }
  return target
}

function storyShot(
  stories: StoryReadPort,
  episodeId: string,
  target: StoryboardShotTarget,
): { story: StoryDocument; shot: StoryShot } {
  const story = stories.getStory(episodeId)
  if (!story) throw new PipelineProductionError('STORY_NOT_FOUND', 'Structured Story is missing')
  const candidates = story.scenes.flatMap((scene) => scene.shots
    .filter((shot) => shot.id === target.publicShotId && scene.id === target.publicSceneId))
  if (candidates.length !== 1) {
    throw new PipelineProductionError('STORY_GRAPH_INCONSISTENT', 'Storyboard target is not unique in Story')
  }
  return { story, shot: candidates[0] }
}

function storyboardPrompt(
  story: StoryDocument,
  shot: StoryShot,
  episode: EpisodeRecord,
): string {
  const primaryCharacter = story.characters[0]
  const base = [
    `为漫剧《${story.title}》生成一个专业分镜画面。`,
    `镜头：${shot.title}；${shot.framing}；${shot.movement}。`,
    `画面内容：${shot.description}`,
    `视觉提示：${shot.visualPrompt}`,
    `视觉风格：${episode.stylePreset || story.bible.visualStyle || '国风动画'}，统一角色设计，电影级构图。`,
    primaryCharacter
      ? `角色 ${primaryCharacter.name} 必须严格保持：${primaryCharacter.visualDescription}`
      : '',
    '画面清晰，主体明确，无文字、无字幕、无标志、无水印。',
  ].filter(Boolean)
  let prompt = base.join('\n')
  if (prompt.length > MAX_PROMPT_LENGTH && primaryCharacter) {
    base.splice(base.length - 2, 1)
    prompt = base.join('\n')
  }
  if (!prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
    throw new PipelineProductionError('STORY_GRAPH_INCONSISTENT', 'Storyboard prompt exceeds the safe limit')
  }
  return prompt
}

function imageSize(aspectRatio: string): ImageSize {
  if (aspectRatio === '9:16') return '1024x1536'
  if (aspectRatio === '1:1') return '1024x1024'
  if (aspectRatio === '16:9') return '1536x1024'
  throw new PipelineProductionError('STORY_GRAPH_INCONSISTENT', 'Episode aspect ratio is unsupported')
}

function requireSubmittedJob(
  database: ManjuDatabase,
  jobId: string,
  input: PipelineFanoutSubmission,
  expectedType: string,
  expectedInput: unknown,
): GenerationJobRecord {
  const job = database.getGenerationJob(jobId)
  if (!job
    || job.projectId !== input.projectId
    || job.episodeId !== input.episodeId
    || job.pipelineRunId !== input.pipelineRunId
    || job.type !== expectedType
    || job.idempotencyKey !== input.idempotencyKey
    || job.providerId !== input.provider.providerId
    || job.providerConfigRevision !== input.provider.configRevision
    || job.model !== input.provider.model
    || !isDeepStrictEqual(job.input, expectedInput)) {
    throw new PipelineProductionError(
      'PIPELINE_CHILD_BINDING_CONFLICT',
      'Submitted child job does not match the frozen pipeline target',
    )
  }
  return job
}

export function createPipelineProductionPorts(
  dependencies: PipelineProductionPortDependencies,
): PipelineRunPorts {
  return {
    async submitStoryboard(input) {
      requireProviderBinding(dependencies.database, input.provider, 'image')
      const target = storyboardTargetByDatabaseId(dependencies.database, input)
      const episode = dependencies.stories.getEpisode(input.episodeId)
      if (!episode || episode.projectId !== input.projectId
        || episode.sourceRevisionId !== input.sourceRevisionId) {
        throw new PipelineProductionError('INVALID_PIPELINE_TARGET', 'Storyboard episode source changed')
      }
      const value = storyShot(dependencies.stories, input.episodeId, target)
      const episodeBinding = resolveEpisodeImageBinding(dependencies.database, {
        projectId: input.projectId,
        episodeId: input.episodeId,
      })
      if (episodeBinding.expectedRevisionId !== input.sourceRevisionId) {
        throw new PipelineProductionError('INVALID_PIPELINE_TARGET', 'Storyboard source revision changed')
      }
      const storyboardReferenceDecision = createStoryboardReferenceDecision(
        dependencies.database,
        target,
        { useLockedReferences: true },
      )
      const jobInput: StoryboardImageJobInput = {
        prompt: storyboardPrompt(value.story, value.shot, episode),
        size: imageSize(episode.aspectRatio),
        quality: 'medium',
        count: 1,
        metadata: {
          kind: STORYBOARD_IMAGE_KIND,
          shotId: target.publicShotId,
          sceneId: target.publicSceneId,
          shotCode: value.shot.code,
          useLockedReferences: true,
        },
        storyboardBinding: createStoryboardImageBinding(target),
        episodeBinding,
        storyboardReferenceDecision,
        referenceAssetIds: storyboardReferenceDecision.referenceAssetIds,
      }
      const result = await dependencies.admitDurableJob(
        { projectId: input.projectId, idempotencyKey: input.idempotencyKey },
        () => dependencies.durableJobs.create({
          type: 'asset.image.generate',
          input: jobInput,
          idempotencyKey: input.idempotencyKey,
          resourceKey: 'provider:image',
          projectId: input.projectId,
          providerId: input.provider.providerId,
          model: input.provider.model ?? undefined,
          providerConfigRevision: input.provider.configRevision,
          metadata: {
            episodeId: input.episodeId,
            pipelineRunId: input.pipelineRunId,
            resourceId: target.publicShotId,
          },
        }),
      )
      const job = requireSubmittedJob(
        dependencies.database,
        result.job.id,
        input,
        'asset.image.generate',
        jobInput,
      )
      return { jobId: job.id }
    },

    async submitSpeech(input) {
      requireProviderBinding(dependencies.database, input.provider, 'speech')
      const row = dependencies.database.withSql((sql) => sql.get(`
        SELECT dialogue_lines.id AS line_id, dialogue_lines.text,
               dialogue_lines.metadata_json AS line_metadata_json,
               dialogue_lines.speech_asset_id, dialogue_lines.character_id,
               characters.name AS character_name,
               characters.metadata_json AS character_metadata_json,
               scenes.id AS scene_id, scenes.metadata_json AS scene_metadata_json,
               shots.source_revision_id
          FROM dialogue_lines
          JOIN shots ON shots.id = dialogue_lines.shot_id
          JOIN scenes ON scenes.id = shots.scene_id
          JOIN episodes ON episodes.id = scenes.episode_id
          LEFT JOIN characters ON characters.id = dialogue_lines.character_id
         WHERE dialogue_lines.id = ? AND episodes.id = ? AND episodes.project_id = ?
      `, input.targetId, input.episodeId, input.projectId))
      if (!row) throw new PipelineProductionError('INVALID_PIPELINE_TARGET', 'Speech target no longer exists')
      const publicLineId = publicStoryId(row.line_metadata_json, requiredString(row.line_id, 'dialogue_lines.id'))
      const target = resolvePublicDialogueLine(dependencies.database, {
        projectId: input.projectId,
        episodeId: input.episodeId,
        lineId: publicLineId,
      })
      if (target.databaseLineId !== input.targetId
        || target.sourceRevisionId !== input.sourceRevisionId) {
        throw new PipelineProductionError('INVALID_PIPELINE_TARGET', 'Speech target source binding changed')
      }
      const currentCasting = input.speechBinding
        ? resolveSpeechRowBinding(dependencies.database, {
            projectId: input.projectId,
            episodeId: input.episodeId,
            sourceRevisionId: input.sourceRevisionId,
          }, row)
        : undefined
      if (input.speechBinding && (!currentCasting?.binding
        || !isDeepStrictEqual(currentCasting.binding, input.speechBinding))) {
        throw new PipelineProductionError(
          'CHARACTER_VOICE_BLOCKED',
          currentCasting?.blocker?.message
            ?? 'Character voice binding changed after pipeline creation; no paid child was created',
        )
      }
      const voiceId = input.speechBinding?.voiceId ?? input.options.defaultVoiceId?.trim()
      if (!voiceId) throw new PipelineProductionError('DEFAULT_VOICE_REQUIRED', 'Speech target has no frozen voice')
      const jobInput: DialogueSpeechJobInput = {
        episodeId: input.episodeId,
        lineId: target.publicLineId,
        databaseLineId: target.databaseLineId,
        expectedRevisionId: target.sourceRevisionId,
        ...(input.speechBinding
          ? { inheritedVoiceProfileRevisionId: input.speechBinding.voiceProfileRevisionId }
          : {}),
        voiceId,
        speed: input.speechBinding?.speed ?? 1,
        volume: 1,
        pitch: input.speechBinding?.pitch ?? 0,
        ...(input.speechBinding?.emotion
          ? { emotion: input.speechBinding.emotion }
          : {}),
        format: 'mp3',
        sampleRate: 32_000,
        bitrate: 128_000,
        channels: 1,
      }
      const result = await dependencies.admitDurableJob(
        { projectId: input.projectId, idempotencyKey: input.idempotencyKey },
        () => dependencies.durableJobs.create({
          type: DIALOGUE_SPEECH_GENERATION_JOB_TYPE,
          input: jobInput,
          idempotencyKey: input.idempotencyKey,
          resourceKey: 'provider:speech',
          projectId: input.projectId,
          providerId: input.provider.providerId,
          model: input.provider.model ?? undefined,
          providerConfigRevision: input.provider.configRevision,
          metadata: {
            episodeId: input.episodeId,
            pipelineRunId: input.pipelineRunId,
            resourceId: target.databaseLineId,
          },
        }),
      )
      const job = requireSubmittedJob(
        dependencies.database,
        result.job.id,
        input,
        DIALOGUE_SPEECH_GENERATION_JOB_TYPE,
        jobInput,
      )
      if (!sameSpeechSubmission(job, jobInput)) {
        throw new PipelineProductionError('PIPELINE_CHILD_BINDING_CONFLICT', 'Speech submission is not reproducible')
      }
      return { jobId: job.id }
    },

    materializeOrReconcile(input) {
      // Materialization, the server-owned preview and the OpenCut application
      // are one local SQLite unit. A blocked semantic candidate therefore
      // cannot leave either a half-reconciled head or an orphan application.
      return dependencies.database.transaction(() => {
        const current = currentTimeline(dependencies.timelines, input.episodeId)
        const result = current
          ? dependencies.timelineMaterialization.reconcile({
            projectId: input.projectId,
            episodeId: input.episodeId,
            expectedRevisionId: current.revision.id,
            summary: `Pipeline ${input.pipelineRunId} reconcile`,
            autoLayoutManagedDialogue: false,
          })
          : dependencies.timelineMaterialization.materialize({
            projectId: input.projectId,
            episodeId: input.episodeId,
            expectedRevisionId: null,
            summary: `Pipeline ${input.pipelineRunId} materialize`,
            autoLayoutManagedDialogue: false,
          })
        if (result.timelineDocument.projectId !== input.projectId
          || result.timelineDocument.episodeId !== input.episodeId
          || result.revision.sourceRevisionId !== input.sourceRevisionId) {
          throw new PipelineProductionError(
            'TIMELINE_BINDING_CONFLICT',
            'Timeline materialization did not preserve the pipeline source binding',
          )
        }

        const preview = dependencies.timelineAutoEdit.preview({
          projectId: input.projectId,
          episodeId: input.episodeId,
          expectedRevisionId: result.revision.id,
          goal: 'exportable',
          policy: 'safe',
        })
        if (preview.risk !== 'safe'
          || preview.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          const reason = preview.diagnostics
            .filter((diagnostic) => diagnostic.severity === 'error')
            .map((diagnostic) => diagnostic.message)
            .join('；')
          throw new PipelineProductionError(
            'INVALID_TIMELINE',
            reason || '时间线无法通过安全自动剪辑修复，请在时间线工作台人工处理',
          )
        }

        if (preview.operations.length === 0) {
          // Recovery after a crash between the atomic timeline commit and the
          // PipelineRun document commit reuses the immutable application
          // receipt instead of applying a second edit or losing audit links.
          const recovered = result.created
            ? undefined
            : pipelineAutomaticEditReceiptFromDocument(result.document)
          return {
            revisionId: result.revision.id,
            ...(recovered ? { automaticEdit: recovered } : {}),
          }
        }

        const applied = dependencies.timelineAutoEdit.apply({
          projectId: input.projectId,
          episodeId: input.episodeId,
          expectedRevisionId: result.revision.id,
          idempotencyKey: `pipeline:${input.pipelineRunId}:timeline-auto-edit:v1`,
          planId: preview.plan.id,
          confirmationToken: preview.plan.confirmationToken,
        })
        if (applied.timeline.timelineDocument.projectId !== input.projectId
          || applied.timeline.timelineDocument.episodeId !== input.episodeId
          || applied.timeline.revision.sourceRevisionId !== input.sourceRevisionId
          || applied.application.planId !== applied.plan.id
          || applied.plan.strategy !== 'managed-dialogue-reflow-v1'
          || applied.plan.executor !== 'OpenCut-Classic/UpdateElementsCommand') {
          throw new PipelineProductionError(
            'TIMELINE_BINDING_CONFLICT',
            'Automatic edit application did not preserve the pipeline source binding',
          )
        }
        return {
          revisionId: applied.timeline.revision.id,
          automaticEdit: {
            strategy: 'managed-dialogue-reflow-v1',
            executor: 'OpenCut-Classic/UpdateElementsCommand',
            planHash: applied.plan.planHash,
            operationCount: applied.operations.length,
            changedElementIds: [...applied.changedElementIds],
            planId: applied.plan.id,
            applicationId: applied.application.id,
          },
        }
      })
    },

    async createExport(input) {
      const result = await dependencies.admitDurableJob(
        { projectId: input.projectId, idempotencyKey: input.idempotencyKey },
        () => dependencies.exports.create({
          projectId: input.projectId,
          episodeId: input.episodeId,
          timelineRevisionId: input.timelineRevisionId,
          resolution: input.options.resolution,
          kenBurns: input.options.kenBurns,
          burnSubtitles: input.options.burnSubtitles,
          introTitle: input.options.introTitle,
          outroCard: input.options.outroCard,
          reviewWatermark: input.options.reviewWatermark,
          pipelineRunId: input.pipelineRunId,
          idempotencyKey: input.idempotencyKey,
        }),
      )
      return { exportId: result.export.id, jobId: result.job.id }
    },

    async createQuality(input) {
      const result = await dependencies.admitDurableJob(
        { projectId: input.projectId, idempotencyKey: input.idempotencyKey },
        () => dependencies.qualityChecks.create({
          exportId: input.exportId,
          pipelineRunId: input.pipelineRunId,
          idempotencyKey: input.idempotencyKey,
        }),
      )
      return { reportId: result.report.id, jobId: result.job.id }
    },

    authorizeQuality(input) {
      const authorization = dependencies.qualityChecks.requireDownloadAuthorization(input.exportId)
      const { export: exported, report } = authorization
      const releasePolicy = validateCurrentQualityReleasePolicy(report)
      if (!releasePolicy.ok) {
        throw new PipelineProductionError(
          'QUALITY_BINDING_CONFLICT',
          `Authoritative quality result does not satisfy the current release policy: ${releasePolicy.reason}`,
        )
      }
      const timelineRevisionId = report.document.binding.timelineRevisionId
      const rootJob = dependencies.database.withSql((sql) => sql.get(`
        SELECT pipeline_run_id, project_id, episode_id, input_json
          FROM generation_jobs
         WHERE type = 'quality.check' AND resource_id = ?
         ORDER BY attempt DESC, created_at DESC, id DESC LIMIT 1
      `, report.id))
      const rootInput = rootJob
        ? storedJsonObject(rootJob.input_json, 'quality job input')
        : null
      if (report.id !== input.reportId
        || report.exportId !== input.exportId
        || report.projectId !== input.projectId
        || report.episodeId !== input.episodeId
        || exported.id !== input.exportId
        || exported.projectId !== input.projectId
        || exported.episodeId !== input.episodeId
        || exported.timelineSnapshot.storyRevisionId !== input.sourceRevisionId
        || report.document.binding.storyRevisionId !== input.sourceRevisionId
        || timelineRevisionId !== exported.timelineRevisionId
        || !rootJob
        || rootJob.pipeline_run_id !== input.pipelineRunId
        || rootJob.project_id !== input.projectId
        || rootJob.episode_id !== input.episodeId
        || !rootInput
        || rootInput.qualityReportId !== input.reportId
        || rootInput.exportId !== input.exportId) {
        throw new PipelineProductionError(
          'QUALITY_BINDING_CONFLICT',
          'Authoritative quality result does not belong to this pipeline export',
        )
      }
      return { passed: true }
    },

    enqueue(jobId) {
      dependencies.worker.enqueue(jobId)
    },

    cancel(jobId, message) {
      return dependencies.worker.cancel(jobId, message)
    },
  }
}
