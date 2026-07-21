import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import express, { type NextFunction, type Request, type Response } from 'express'

import { AssetRetentionError, AssetRetentionService } from './asset-retention.js'
import {
  ASSET_IMAGE_EDIT_JOB_TYPE,
  AssetImageEditError,
  assertNoActiveAssetImageEditConflict,
  assertNoActiveVisualAssetGenerationConflict,
  assertAssetImageEditProviderCapability,
  assetImageEditEtag,
  createAssetImageEditHandler,
  prepareAssetImageEdit,
  sameAssetImageEditReplay,
  sameAssetImageEditSubmission,
  type AssetImageEditJobInput,
} from './asset-image-edit.js'
import {
  TURNAROUND_DERIVATION_JOB_TYPE,
  TurnaroundDerivationError,
  FfmpegTurnaroundCropRenderer,
  cleanupIncompleteTurnaroundAssets,
  cleanupTurnaroundJobAssets,
  createTurnaroundDerivationHandler,
  prepareTurnaroundDerivation,
  sameTurnaroundSubmission,
  type NormalizedTurnaroundCrop,
  type TurnaroundCropRenderer,
} from './asset-turnaround-derivation.js'
import { AssetLockError, mountAssetLockRoutes } from './asset-locking.js'
import {
  AssetIdentityError,
  mountAssetIdentityRoutes,
  stableAssetIdForVersion,
} from './asset-identity.js'
import {
  mountProductionAssetManifestRoutes,
  ProductionAssetManifestError,
  type ProductionAssetManifestService,
} from './production-asset-manifest.js'
import type { AudioDurationProbe } from './audio-duration.js'
import {
  CharacterVoiceProfileError,
  CharacterVoiceProfileRepository,
} from './character-voice-profiles.js'
import {
  CHARACTER_VOICE_PREVIEW_JOB_TYPE,
  CharacterVoicePreviewError,
  createCharacterVoicePreviewHandler,
  resolvePublicCharacterVoicePreviewTarget,
  sameCharacterVoicePreviewSubmission,
  type CharacterVoicePreviewJobInput,
} from './character-voice-preview.js'
import {
  CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE,
  createCharacterVoiceRecommendationHandler,
  parseCharacterVoiceRecommendationJobInput,
  type CharacterVoiceRecommendationJobInput,
} from './character-voice-recommendation-job.js'
import {
  characterVoiceCatalogFingerprint,
  characterVoiceRecommendationShortlist,
  CharacterVoiceRecommendationError,
  parseCharacterVoiceRecommendationResult,
  type CharacterVoiceRecommendation,
} from './character-voice-recommendation.js'
import {
  DatabaseIntegrityError,
  initializeDatabase,
  type GenerationJobRecord,
  type JobStatus,
  type ManjuDatabase,
  type MediaAssetRecord,
  type PipelineRunRecord,
} from './database.js'
import { serveStudioEvents, StudioEventHub } from './events.js'
import {
  createExportRenderJobHandler,
  EXPORT_RENDER_JOB_TYPE,
  exportRecordAsJson,
  ExportRenderError,
  ExportRenderService,
} from './export-render.js'
import type { FfmpegRenderer } from './ffmpeg-renderer.js'
import { MacOSKeychain } from './keychain.js'
import { jobRetryDisposition } from './job-retry-policy.js'
import {
  MiniMaxVoiceCatalogClient,
  MiniMaxVoiceCatalogError,
  MiniMaxVoiceCatalogService,
} from './minimax-voice-catalog.js'
import {
  IndexTtsVoiceCatalogClient,
  IndexTtsVoiceCatalogError,
  IndexTtsVoiceCatalogService,
} from './indextts-voice-catalog.js'
import {
  DoubaoVoiceCatalogError,
  DoubaoVoiceCatalogService,
} from './doubao-voice-catalog.js'
import { imageDimensions, MediaStore, MediaStoreError } from './media.js'
import {
  LinePerformanceContextError,
  resolveLinePerformanceRecommendationContext,
} from './line-performance-context.js'
import {
  createLinePerformanceRecommendationHandler,
  LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
  parseLinePerformanceRecommendationJobInput,
  sameLinePerformanceRecommendationSubmission,
} from './line-performance-job.js'
import {
  LinePerformanceProfileError,
  LinePerformanceProfileRepository,
} from './line-performance-profiles.js'
import {
  compileLinePerformance,
  LinePerformanceError,
  parseLinePerformanceRecommendation,
} from './line-performance.js'
import {
  DEFAULT_USER_AUDIO_UPLOAD_MAX_BYTES,
  MediaUploadError,
  normalizeUploadDisplayName,
  normalizeUserAudioMimeType,
  parseUserAudioAssetKind,
  UserMediaUploadService,
} from './media-upload.js'
import type { MiniMaxSubtitleLoader } from './minimax-subtitle.js'
import { publicSpeechSubtitle } from './speech-subtitle.js'
import {
  createQualityCheckJobHandler,
  QUALITY_CHECK_JOB_TYPE,
  QualityCheckError,
  QualityCheckService,
  qualityReportAsJson,
  type QualityAnalyzerPort,
} from './quality-check.js'
import {
  ReleaseReviewError,
  ReleaseReviewService,
  type ReleaseReviewChecklist,
  type ReleaseReviewDecision,
} from './release-review.js'
import {
  summarizeProviderCapabilities,
  unavailableProviderCapabilities,
} from './operational-readiness.js'
import {
  ProjectConflictError,
  ProjectService,
  revisionIdFromEtag,
} from './projects.js'
import {
  ProjectKnowledgeConflictError,
  ProjectKnowledgeService,
  ProjectKnowledgeValidationError,
} from './project-knowledge.js'
import {
  PAID_AIGC_CONFIRMATION_HEADER,
  PaidAigcConfirmationGate,
  type PaidAigcConfirmationIntent,
} from './paid-aigc-confirmation.js'
import {
  ProjectNarratorVoiceProfileError,
  ProjectNarratorVoiceProfileRepository,
} from './project-narrator-voice-profiles.js'
import {
  PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE,
  ProjectNarratorVoicePreviewError,
  createProjectNarratorVoicePreviewHandler,
  resolveProjectNarratorVoicePreviewTarget,
  sameProjectNarratorVoicePreviewSubmission,
  type ProjectNarratorVoicePreviewJobInput,
} from './project-narrator-voice-preview.js'
import {
  VoicePreviewReviewError,
  VoicePreviewReviewService,
  type VoicePreviewReviewDecision,
} from './voice-preview-review.js'
import {
  createPipelineProductionRequestFromDiscovery,
  createPipelineProductionPorts,
  discoverPipelineProduction,
  pipelineProductionCallerIntentFingerprint,
  PipelineProductionError,
  type PipelineProductionDiscovery,
  validatePipelineVoiceCatalog,
} from './pipeline-production.js'
import {
  parsePipelineRunDocument,
  PipelineRunCoordinator,
  PipelineRunError,
  type PipelineProviderSelection,
} from './pipeline-run.js'
import {
  CodexToolsImageProvider,
  createCodexToolsCredentialSource,
  ImageProviderError,
} from './providers/codex-tools.js'
import { ProviderConfigurationError, ProviderService, type ProviderCredentialStore, type ProviderProbe } from './providers/service.js'
import type { SpeechProvider } from './providers/minimax-tts.js'
import { SeedanceVideoProvider, type SeedanceVideoProviderContract } from './providers/seedance.js'
import { OpenAICompatibleTextProvider, TextProviderError } from './providers/text.js'
import {
  seedProviderCatalogConnections,
  SQLiteJobRepository,
  SQLiteProviderConnectionRepository,
  SQLiteRepositoryError,
} from './repositories.js'
import { createSafeRequestLogger, type RequestLogSink } from './request-logging.js'
import {
  SQLiteTimelineDocumentRepository,
  TimelineDocumentError,
  TimelineDocumentService,
} from './timeline-documents.js'
import {
  TimelineRevisionRestoreError,
  TimelineRevisionRestoreService,
} from './timeline-revision-restore.js'
import {
  createTimelineMaterializationAutoEditPlanner,
  SQLiteTimelineAutoEditRepository,
  TimelineAutoEditError,
  TimelineAutoEditService,
} from './timeline-auto-edit.js'
import {
  TimelineMaterializationError,
  TimelineMaterializationService,
} from './timeline-materialization.js'
import { mountStoryHttpRoutes, StoryHttpError } from './story-http.js'
import { episodeEtag, episodeVersionMatches, versionTokenFromEtag } from './episode-version.js'
import {
  createStoryGenerationJobHandler,
  STORY_GENERATION_JOB_TYPE,
} from './story-generation.js'
import { StoryRepository } from './story-repository.js'
import type { StoryCharacterVoiceProfile } from './story-schema.js'
import {
  assertExistingShotVideoBatchChild,
  assertNoConflictingShotVideoAttempts,
  assertShotVideoBatchChild,
  parseShotVideoBatchRequest,
  prepareShotVideoBatch,
  SHOT_VIDEO_BATCH_PREFLIGHT_TTL_SECONDS,
  shotVideoBatchChildIdempotencyKey,
  shotVideoBatchConfirmationToken,
  shotVideoBatchPreflightAsJson,
  ShotVideoBatchError,
  verifyShotVideoBatchConfirmationToken,
  type PreparedShotVideoBatch,
  type ShotVideoProviderBinding,
} from './shot-video-batch.js'
import {
  createShotVideoGenerationHandler,
  createShotVideoJobInput,
  resolvePublicShotVideoTarget,
  SHOT_VIDEO_GENERATION_JOB_TYPE,
  type SafeVideoDownloader,
} from './shot-video-generation.js'
import { readShotVideoTimingRemediation } from './shot-video-timing-remediation.js'
import {
  ShotMediaReviewError,
  ShotMediaReviewService,
  type ShotMediaReviewDecision,
  type ShotMediaType,
} from './shot-media-review.js'
import {
  mountShotVideoHistoryRoutes,
  ShotVideoHistoryError,
} from './shot-video-history.js'
import { resolveShotVideoReferenceRecommendation } from './shot-video-reference-recommendation.js'
import {
  bindShotVideoVisualReferenceBatch,
  createShotVideoVisualReferenceHandler,
  parseShotVideoVisualReferenceJobInput,
  prepareShotVideoVisualReferenceJob,
  resolvePersistedShotVideoVisionAssessment,
  sameShotVideoVisualReferenceAuthority,
  SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
  ShotVideoVisualReferenceJobError,
  type ShotVideoVisualReferenceBatchBinding,
  type ShotVideoVisualReferenceJobInput,
} from './shot-video-visual-reference-job.js'
import {
  confirmShotVideoUnknownSubmissionNotCreated,
  parseShotVideoManualResolutionRequest,
  readShotVideoUnknownSubmissionResolution,
  ShotVideoManualResolutionError,
} from './shot-video-manual-resolution.js'
import {
  assertCurrentStoryboardReferenceDecision,
  assertEpisodeImagePublication,
  createStoryboardReferenceDecision,
  createStoryboardImageBinding,
  linkStoryboardAsset,
  resolveDurableEpisodeImageBinding,
  resolveDurableStoryboardShot,
  resolveEpisodeImageBinding,
  resolvePublicStoryboardShot,
  STORYBOARD_IMAGE_KIND,
  StoryboardImageError,
  storyboardBindingForJob,
  validateDurableReferenceAssetIds,
  type StoryboardImageJobInput,
} from './storyboard-image-generation.js'
import {
  createVisualAssetEntityBinding,
  listVisualAssetTargets,
  resolveDurableVisualAssetEntity,
  VisualAssetGenerationError,
  visualAssetEntityBindingForJob,
  visualAssetEntitySelector,
  type VisualAssetEntityBinding,
} from './visual-asset-generation.js'
import {
  mountVisualAssetHistoryRoutes,
  VisualAssetHistoryError,
} from './visual-asset-history.js'
import {
  createDialogueSpeechGenerationHandler,
  DialogueSpeechError,
  DIALOGUE_SPEECH_GENERATION_JOB_TYPE,
  inheritedDialogueVoiceBinding,
  inheritedNarratorVoiceBinding,
  resolvePublicDialogueLine,
  sameSpeechSubmission,
  SPEECH_BITRATES,
  SPEECH_EMOTIONS,
  SPEECH_FORMATS,
  SPEECH_SAMPLE_RATES,
  type DialogueSpeechJobInput,
  type DialogueSpeechSettings,
} from './speech-generation.js'
import type {
  ImageGenerationInput,
  ImageProvider,
  JsonObject,
  JsonValue,
  ProviderImageReference,
} from './types.js'
import { IMAGE_QUALITIES, IMAGE_SIZES } from './types.js'
import {
  JobExecutionError,
  JobWorker,
  type JobHandlerContext,
  type JobRecord,
} from './worker.js'
import type { VideoMetadataProbe } from './video-metadata.js'

const MAX_QUEUE_DEPTH = 100
const MAX_PROMPT_LENGTH = 8_000
const MAX_METADATA_BYTES = 32 * 1024
const MAX_JSON_DEPTH = 20
const DEFAULT_GENERATION_TIMEOUT_MS = 10 * 60 * 1_000
const MAX_REFERENCE_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_REFERENCE_IMAGES_TOTAL_BYTES = 60 * 1024 * 1024
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'waiting_provider']

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: JsonValue,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateJsonValue(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new HttpError(400, 'INVALID_JSON', 'JSON 层级过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new HttpError(400, 'INVALID_JSON', 'JSON 中不能包含非有限数值')
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJsonValue(item, depth + 1)
    return
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new HttpError(400, 'UNSAFE_JSON_KEY', `不允许的 JSON 字段: ${key}`)
      validateJsonValue(item, depth + 1)
    }
    return
  }
  throw new HttpError(400, 'INVALID_JSON', '请求必须是可序列化的 JSON')
}

function requireObject(value: unknown, message: string): JsonObject {
  if (!isPlainObject(value)) throw new HttpError(400, 'INVALID_REQUEST', message)
  validateJsonValue(value)
  return value as JsonObject
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value
}

function queryString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function queryBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new HttpError(400, 'INVALID_QUERY', `${label} 必须是 true 或 false`)
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  const parsed = value === undefined ? undefined : Number(value)
  if (parsed === undefined) return maximum
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new HttpError(400, 'INVALID_QUERY', `${label} 必须是 1 到 ${maximum} 的整数`)
  }
  return parsed
}

function nonNegativeInteger(value: unknown, label: string, maximum: number): number {
  const parsed = value === undefined ? 0 : Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new HttpError(400, 'INVALID_QUERY', `${label} 必须是 0 到 ${maximum} 的整数`)
  }
  return parsed
}

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next)
  }
}

function parseImageInput(body: unknown): ImageGenerationInput {
  const value = requireObject(body, '图片生成请求必须是 JSON 对象')
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : ''
  if (!prompt) throw new HttpError(400, 'INVALID_PROMPT', '请输入图片提示词')
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new HttpError(400, 'INVALID_PROMPT', `提示词不能超过 ${MAX_PROMPT_LENGTH} 个字符`)
  }

  const count = value.count === undefined ? 1 : value.count
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 4) {
    throw new HttpError(400, 'INVALID_COUNT', '图片数量必须是 1 到 4 的整数')
  }
  const size = value.size === undefined ? '1024x1024' : value.size
  if (typeof size !== 'string' || !IMAGE_SIZES.includes(size as ImageGenerationInput['size'])) {
    throw new HttpError(400, 'INVALID_SIZE', `图片尺寸必须是 ${IMAGE_SIZES.join(', ')} 之一`)
  }
  const quality = value.quality === undefined ? 'medium' : value.quality
  if (typeof quality !== 'string' || !IMAGE_QUALITIES.includes(quality as ImageGenerationInput['quality'])) {
    throw new HttpError(400, 'INVALID_QUALITY', `图片质量必须是 ${IMAGE_QUALITIES.join(', ')} 之一`)
  }

  let metadata: JsonObject | undefined
  if (value.metadata !== undefined) {
    metadata = requireObject(value.metadata, 'metadata 必须是 JSON 对象')
    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
      throw new HttpError(400, 'METADATA_TOO_LARGE', 'metadata 不能超过 32KB')
    }
  }
  return {
    prompt,
    size: size as ImageGenerationInput['size'],
    quality: quality as ImageGenerationInput['quality'],
    count: count as number,
    ...(metadata ? { metadata } : {}),
  }
}

function requestIdentifier(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_REQUEST', `${label} 必须是字符串`)
  const normalized = value.trim()
  if (
    !normalized
    || normalized.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)
  ) {
    throw new HttpError(400, 'INVALID_REQUEST', `${label} 格式无效`)
  }
  return normalized
}

function speechNumber(
  value: JsonValue | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
  integer = false,
): number {
  const resolved = value ?? fallback
  if (
    typeof resolved !== 'number'
    || !Number.isFinite(resolved)
    || resolved < minimum
    || resolved > maximum
    || (integer && !Number.isInteger(resolved))
  ) {
    throw new HttpError(
      400,
      'INVALID_SPEECH_INPUT',
      `${label}必须介于 ${minimum} 和 ${maximum} 之间${integer ? '且为整数' : ''}`,
    )
  }
  return resolved
}

function parseDialogueSpeechSettings(
  body: JsonObject,
  inherited?: Pick<DialogueSpeechSettings, 'voiceId' | 'speed' | 'pitch' | 'emotion'>,
): DialogueSpeechSettings {
  const allowed = new Set([
    'projectId',
    'episodeId',
    'providerId',
    'voiceId',
    'speed',
    'volume',
    'pitch',
    'emotion',
    'format',
    'sampleRate',
    'bitrate',
    'channels',
  ])
  const unknown = Object.keys(body).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new HttpError(400, 'INVALID_REQUEST', `不支持的语音参数: ${unknown.join(', ')}`)
  }
  if (body.voiceId !== undefined && typeof body.voiceId !== 'string') {
    throw new HttpError(400, 'INVALID_SPEECH_INPUT', 'voiceId 必须是字符串')
  }
  const explicitVoiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : undefined
  if (explicitVoiceId !== undefined
    && (!explicitVoiceId || explicitVoiceId.length > 256 || /[\u0000-\u001f\u007f]/.test(explicitVoiceId))) {
    throw new HttpError(400, 'INVALID_SPEECH_INPUT', 'voiceId 格式无效')
  }
  const voiceId = explicitVoiceId ?? inherited?.voiceId.trim() ?? ''
  if (!voiceId) {
    throw new HttpError(400, 'CHARACTER_VOICE_REQUIRED', '请先为角色配置声线，或为本句指定临时 voiceId')
  }
  let emotion: DialogueSpeechSettings['emotion']
  if (body.emotion !== undefined) {
    if (typeof body.emotion !== 'string' || !SPEECH_EMOTIONS.includes(
      body.emotion as (typeof SPEECH_EMOTIONS)[number],
    )) {
      throw new HttpError(400, 'INVALID_SPEECH_INPUT', 'emotion 参数无效')
    }
    emotion = body.emotion as DialogueSpeechSettings['emotion']
  } else if (inherited?.emotion) {
    emotion = inherited.emotion
  }
  const format = body.format ?? 'mp3'
  if (typeof format !== 'string' || !SPEECH_FORMATS.includes(format as DialogueSpeechSettings['format'])) {
    throw new HttpError(400, 'INVALID_SPEECH_INPUT', `format 仅支持 ${SPEECH_FORMATS.join(', ')}`)
  }
  const sampleRate = speechNumber(body.sampleRate, 32_000, 8_000, 44_100, 'sampleRate', true)
  if (!SPEECH_SAMPLE_RATES.includes(sampleRate as DialogueSpeechSettings['sampleRate'])) {
    throw new HttpError(400, 'INVALID_SPEECH_INPUT', 'sampleRate 参数无效')
  }
  const bitrate = speechNumber(body.bitrate, 128_000, 32_000, 256_000, 'bitrate', true)
  if (!SPEECH_BITRATES.includes(bitrate as DialogueSpeechSettings['bitrate'])) {
    throw new HttpError(400, 'INVALID_SPEECH_INPUT', 'bitrate 参数无效')
  }
  const channels = speechNumber(body.channels, 1, 1, 2, 'channels', true)
  return {
    voiceId,
    speed: speechNumber(body.speed, inherited?.speed ?? 1, 0.5, 2, 'speed'),
    volume: speechNumber(body.volume, 1, Number.MIN_VALUE, 10, 'volume'),
    pitch: speechNumber(body.pitch, inherited?.pitch ?? 0, -12, 12, 'pitch', true),
    ...(emotion ? { emotion } : {}),
    format: format as DialogueSpeechSettings['format'],
    sampleRate: sampleRate as DialogueSpeechSettings['sampleRate'],
    bitrate: bitrate as DialogueSpeechSettings['bitrate'],
    channels: channels as 1 | 2,
  }
}

function activeJobCount(database: ManjuDatabase): number {
  return ACTIVE_JOB_STATUSES.reduce(
    (count, status) => count + database.listGenerationJobs({ status, limit: 1_000 }).length,
    0,
  )
}

function publicAsset(asset: MediaAssetRecord): JsonObject {
  const originalFileName = asset.source === 'upload'
    && typeof asset.generationParameters.originalFileName === 'string'
    && asset.generationParameters.originalFileName.length <= 200
    && !/[\u0000-\u001f\u007f/\\]/.test(asset.generationParameters.originalFileName)
    ? asset.generationParameters.originalFileName
    : undefined
  const speechSubtitle = publicSpeechSubtitle(asset)
  const editEtag = assetImageEditEtag(asset)
  return {
    id: asset.id,
    projectId: asset.projectId,
    episodeId: asset.episodeId,
    kind: asset.kind,
    version: asset.version,
    status: asset.status,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.durationSeconds,
    checksum: asset.checksum,
    source: asset.source,
    providerId: asset.providerId,
    generationJobId: asset.generationJobId,
    sourceRevisionId: asset.sourceRevisionId,
    parentAssetId: asset.parentAssetId,
    ...(editEtag ? { etag: editEtag } : {}),
    ...(originalFileName ? { originalFileName } : {}),
    ...(speechSubtitle ? { speechSubtitle } : {}),
    url: `/api/v1/assets/${encodeURIComponent(asset.id)}/content`,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  }
}

function publicShotVideoCancellation(job: GenerationJobRecord): JsonObject | undefined {
  if (job.type !== SHOT_VIDEO_GENERATION_JOB_TYPE || job.status !== 'cancelled') return undefined
  const capability = job.providerState.cancellationCapability
  const outcome = job.providerState.cancellationOutcome
  if (!job.externalTaskId || outcome === 'not-submitted') {
    return {
      localProcessing: 'stopped',
      upstreamCancellation: 'not-submitted',
      providerTaskMayContinue: false,
      chargesMayStillApply: false,
      message: '已停止本地处理；未记录已接受的上游视频任务。',
    }
  }
  if (capability === 'local-only' || outcome === 'unsupported') {
    return {
      localProcessing: 'stopped',
      upstreamCancellation: 'not-supported',
      providerTaskMayContinue: true,
      chargesMayStillApply: true,
      message: '已停止本地处理；当前 NewAPI 网关不支持取消上游任务，生成可能继续并产生费用。',
    }
  }
  if (outcome === 'requested') {
    return {
      localProcessing: 'stopped',
      upstreamCancellation: 'request-sent',
      providerTaskMayContinue: true,
      chargesMayStillApply: true,
      message: '已停止本地处理，并已向火山方舟发送取消请求；上游确认前仍可能产生费用。',
    }
  }
  if (outcome === 'task-not-found') {
    return {
      localProcessing: 'stopped',
      upstreamCancellation: 'not-found',
      providerTaskMayContinue: true,
      chargesMayStillApply: true,
      message: '已停止本地处理；火山方舟未找到该任务，完成与计费状态请到供应商控制台核对。',
    }
  }
  if (outcome === 'request-failed') {
    return {
      localProcessing: 'stopped',
      upstreamCancellation: 'request-failed',
      providerTaskMayContinue: true,
      chargesMayStillApply: true,
      message: '已停止本地处理，但未能向火山方舟发送取消请求；上游可能继续并产生费用。',
    }
  }
  if (capability === 'upstream-delete') {
    return {
      localProcessing: 'stopped',
      upstreamCancellation: 'request-pending',
      providerTaskMayContinue: true,
      chargesMayStillApply: true,
      message: '已停止本地处理；正在尽力向火山方舟发送取消请求，上游确认前仍可能产生费用。',
    }
  }
  return {
    localProcessing: 'stopped',
    upstreamCancellation: 'unknown',
    providerTaskMayContinue: true,
    chargesMayStillApply: true,
    message: '已停止本地处理；无法确认上游取消能力，供应商任务可能继续并产生费用。',
  }
}

function publicProviderDiagnostic(job: GenerationJobRecord): JsonObject | undefined {
  if (job.type !== SHOT_VIDEO_GENERATION_JOB_TYPE) return undefined
  const value = job.providerState.submissionDiagnostic
  if (!isPlainObject(value)
    || value.operation !== 'create'
    || (value.protocol !== 'ark' && value.protocol !== 'newapi')
    || (value.endpointFamily !== 'ark-tasks' && value.endpointFamily !== 'openai-videos')
    || !Number.isInteger(value.httpStatus)
    || (value.httpStatus as number) < 100
    || (value.httpStatus as number) > 599
    || typeof value.observedAt !== 'string'
    || value.observedAt.length > 64
    || (value.providerCode !== undefined
      && (typeof value.providerCode !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.providerCode)))) return undefined
  return {
    operation: value.operation,
    protocol: value.protocol,
    endpointFamily: value.endpointFamily,
    httpStatus: value.httpStatus as number,
    ...(value.providerCode ? { providerCode: value.providerCode } : {}),
    observedAt: value.observedAt,
  }
}

function explicitSeedanceRejectedSubmission(
  job: GenerationJobRecord,
): 'billing' | 'quota' | null {
  const diagnostic = job.providerState.submissionDiagnostic
  if (job.type !== SHOT_VIDEO_GENERATION_JOB_TYPE
    || !isPlainObject(diagnostic)
    || diagnostic.operation !== 'create') return null
  if (diagnostic.httpStatus === 403
    && diagnostic.providerCode === 'AccountOverdueError') return 'billing'
  if (diagnostic.httpStatus === 429
    && diagnostic.providerCode === 'QuotaExceeded') return 'quota'
  return null
}

function publicJob(job: GenerationJobRecord, database: ManjuDatabase): JsonObject {
  let publicInput = job.input
  if (job.type === SHOT_VIDEO_GENERATION_JOB_TYPE
    && typeof job.input.generateAudio !== 'boolean') {
    publicInput = { ...job.input, generateAudio: false }
  } else if (job.type === DIALOGUE_SPEECH_GENERATION_JOB_TYPE
    && typeof job.input.compiledText === 'string') {
    const { compiledText: _compiledText, ...safeInput } = job.input
    publicInput = safeInput
  } else if (job.type === CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE) {
    const catalog = isPlainObject(job.input.catalog) ? job.input.catalog : undefined
    publicInput = {
      ...(typeof job.input.episodeId === 'string' ? { episodeId: job.input.episodeId } : {}),
      ...(typeof job.input.characterId === 'string' ? { characterId: job.input.characterId } : {}),
      ...(typeof job.input.expectedStoryRevisionId === 'string'
        ? { expectedStoryRevisionId: job.input.expectedStoryRevisionId }
        : {}),
      ...(catalog
        ? {
            catalog: {
              ...((catalog.providerId === 'minimax-speech'
                || catalog.providerId === 'indextts-speech'
                || catalog.providerId === 'doubao-speech')
                ? { providerId: catalog.providerId }
                : {}),
              ...(Number.isInteger(catalog.providerConfigRevision)
                ? { providerConfigRevision: catalog.providerConfigRevision as number }
                : {}),
              ...(typeof catalog.fingerprint === 'string' ? { fingerprint: catalog.fingerprint } : {}),
              voiceCount: Array.isArray(catalog.voices) ? catalog.voices.length : 0,
            },
          }
        : {}),
    }
  } else if (job.type === LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE) {
    publicInput = {
      ...(typeof job.input.episodeId === 'string' ? { episodeId: job.input.episodeId } : {}),
      ...(typeof job.input.lineId === 'string' ? { lineId: job.input.lineId } : {}),
      ...(typeof job.input.sourceRevisionId === 'string'
        ? { sourceRevisionId: job.input.sourceRevisionId }
        : {}),
      ...(typeof job.input.lineKind === 'string' ? { lineKind: job.input.lineKind } : {}),
    }
  } else if (job.type === SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE) {
    publicInput = {
      ...(typeof job.input.version === 'number' ? { version: job.input.version } : {}),
      ...(typeof job.input.episodeId === 'string' ? { episodeId: job.input.episodeId } : {}),
      ...(typeof job.input.expectedStoryRevisionId === 'string'
        ? { expectedStoryRevisionId: job.input.expectedStoryRevisionId }
        : {}),
      ...(typeof job.input.inputFingerprint === 'string'
        ? { inputFingerprint: job.input.inputFingerprint }
        : {}),
      ...(Array.isArray(job.input.selectors)
        ? { selectors: structuredClone(job.input.selectors) as unknown as JsonValue }
        : {}),
      ...(isPlainObject(job.input.batch)
        ? { batch: structuredClone(job.input.batch) as unknown as JsonValue }
        : {}),
      candidateCount: Array.isArray(job.input.candidates) ? job.input.candidates.length : 0,
    }
  } else if (job.type === CHARACTER_VOICE_PREVIEW_JOB_TYPE) {
    publicInput = {
      ...(typeof job.input.episodeId === 'string' ? { episodeId: job.input.episodeId } : {}),
      ...(typeof job.input.characterId === 'string' ? { characterId: job.input.characterId } : {}),
      ...(typeof job.input.expectedStoryRevisionId === 'string'
        ? { expectedStoryRevisionId: job.input.expectedStoryRevisionId }
        : {}),
      ...(typeof job.input.voiceId === 'string' ? { voiceId: job.input.voiceId } : {}),
      ...(typeof job.input.expectedCatalogFingerprint === 'string'
        ? { expectedCatalogFingerprint: job.input.expectedCatalogFingerprint }
        : {}),
      ...(Number.isInteger(job.input.expectedProviderConfigRevision)
        ? { expectedProviderConfigRevision: job.input.expectedProviderConfigRevision as number }
        : {}),
    }
  } else if (job.type === PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE) {
    publicInput = {
      ...(typeof job.input.episodeId === 'string' ? { episodeId: job.input.episodeId } : {}),
      ...(typeof job.input.expectedStoryRevisionId === 'string'
        ? { expectedStoryRevisionId: job.input.expectedStoryRevisionId }
        : {}),
      ...(typeof job.input.voiceId === 'string' ? { voiceId: job.input.voiceId } : {}),
      ...(typeof job.input.expectedCatalogFingerprint === 'string'
        ? { expectedCatalogFingerprint: job.input.expectedCatalogFingerprint }
        : {}),
      ...(Number.isInteger(job.input.expectedProviderConfigRevision)
        ? { expectedProviderConfigRevision: job.input.expectedProviderConfigRevision as number }
        : {}),
    }
  }
  const cancellation = publicShotVideoCancellation(job)
  const providerDiagnostic = publicProviderDiagnostic(job)
  const retryDisposition = jobRetryDisposition(database, job)
  // A structurally valid current-node remediation can still belong to a
  // corrupt or unknown retry lineage. In that case the authoritative retry
  // policy is manual isolation; do not project an actionable paid-recovery
  // payload that the client could mistake for permission to create a new task.
  const timingRemediation = retryDisposition === 'paid-reconfirmation-required'
    ? readShotVideoTimingRemediation(job)
    : undefined
  let unknownSubmissionResolution: ReturnType<
    typeof readShotVideoUnknownSubmissionResolution
  >
  const hasManualResolutionPointer = job.type === SHOT_VIDEO_GENERATION_JOB_TYPE
    && isPlainObject(job.progressDetail.manualUnknownSubmissionResolution)
  const hasManualResolutionError = job.type === SHOT_VIDEO_GENERATION_JOB_TYPE
    && job.error?.code === 'PROVIDER_SUBMISSION_CONFIRMED_NOT_CREATED'
  if (hasManualResolutionPointer || hasManualResolutionError) {
    try {
      unknownSubmissionResolution = readShotVideoUnknownSubmissionResolution(database, job)
    } catch (error) {
      if (!(error instanceof ShotVideoManualResolutionError)) throw error
      unknownSubmissionResolution = undefined
    }
  }
  let publicError = job.error
  let publicProgressDetail = job.progressDetail
  if (job.error?.code === 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN') {
    const rejection = explicitSeedanceRejectedSubmission(job)
    if (rejection === 'billing') {
      publicError = {
        code: 'PROVIDER_BILLING_UNAVAILABLE',
        message: 'Seedance 方舟账号欠费或授信不可用，请恢复账户计费状态后重新预检并确认生成。',
        retryable: false,
        category: 'provider',
      }
    } else if (rejection === 'quota') {
      publicError = {
        code: 'PROVIDER_RATE_LIMITED',
        message: 'Seedance Agent Plan 任务配额已受限；本次未创建上游任务。请恢复配额后重新预检并确认生成。',
        retryable: true,
        category: 'rate_limit',
      }
    }
  }
  if (hasManualResolutionError && !unknownSubmissionResolution) {
    const original = isPlainObject(job.error?.originalError)
      ? job.error.originalError
      : undefined
    publicError = {
      ...(original ?? {}),
      code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
      message: typeof original?.message === 'string'
        ? original.message
        : 'Seedance 提交结果未能确认；人工结案审计无效，仍保持隔离。',
      retryable: false,
      category: 'provider',
    }
  }
  if (hasManualResolutionPointer && !unknownSubmissionResolution) {
    const { manualUnknownSubmissionResolution: _invalidPointer, ...safeDetail } = job.progressDetail
    publicProgressDetail = safeDetail
  }
  return {
    id: job.id,
    projectId: job.projectId,
    episodeId: job.episodeId,
    pipelineRunId: job.pipelineRunId,
    type: job.type,
    status: job.status,
    progress: job.progress,
    resourceType: job.resourceType,
    resourceId: job.type === LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE
      && typeof job.input.lineId === 'string'
      ? job.input.lineId
      : job.type === PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE
        ? job.projectId
      : (job.type === CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE
      || job.type === CHARACTER_VOICE_PREVIEW_JOB_TYPE)
      && typeof job.input.characterId === 'string'
      ? job.input.characterId
      : job.resourceId,
    providerId: job.providerId,
    model: job.model,
    providerConfigRevision: job.providerConfigRevision,
    externalTaskId: job.externalTaskId,
    idempotencyKey: job.idempotencyKey,
    retryOf: job.retryOf,
    attempt: job.attempt,
    input: publicInput,
    progressDetail: publicProgressDetail,
    output: job.output,
    error: publicError,
    retryDisposition,
    cost: job.cost,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    ...(cancellation ? { cancellation } : {}),
    ...(providerDiagnostic ? { providerDiagnostic } : {}),
    ...(timingRemediation
      ? { timingRemediation: timingRemediation as unknown as JsonObject }
      : {}),
    ...(unknownSubmissionResolution
      ? { unknownSubmissionResolution: unknownSubmissionResolution as unknown as JsonObject }
      : {}),
  }
}

function pipelineRunAsJson(run: PipelineRunRecord): JsonObject {
  if (!run.episodeId || !run.sourceRevisionId) {
    throw new PipelineRunError(
      'INVALID_PIPELINE_DOCUMENT',
      'Pipeline run is missing its episode or source revision binding',
    )
  }
  const document = parsePipelineRunDocument(run.steps)
  if (document.sourceRevisionId !== run.sourceRevisionId) {
    throw new PipelineRunError(
      'INVALID_PIPELINE_DOCUMENT',
      'Pipeline run source revision does not match its immutable document',
    )
  }
  return {
    id: run.id,
    projectId: run.projectId,
    episodeId: run.episodeId,
    sourceRevisionId: run.sourceRevisionId,
    status: run.status,
    progress: run.progress,
    version: document.version,
    mode: document.mode,
    options: {
      ...document.options,
    },
    bindings: {
      ...(document.bindings.imageProvider
        ? { imageProvider: { ...document.bindings.imageProvider } }
        : {}),
      ...(document.bindings.speechProvider
        ? { speechProvider: { ...document.bindings.speechProvider } }
        : {}),
      ...(document.bindings.speechTargets
        ? { speechTargets: document.bindings.speechTargets.map((binding) => ({
            ...binding,
            provider: { ...binding.provider },
          })) }
        : {}),
    },
    targets: {
      storyboard: [...document.targets.storyboard],
      speech: [...document.targets.speech],
    },
    steps: structuredClone(document.steps) as unknown as JsonObject,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  }
}

interface PipelineHttpCreateInput {
  projectId: string
  resolution: '720p' | '1080p'
  kenBurns: boolean
  burnSubtitles: boolean
  introTitle: boolean
  outroCard: boolean
  reviewWatermark: boolean
  speechMode: 'auto' | 'skip'
  imageProviderId?: string
  confirmationToken?: JsonValue
}

function parsePipelineHttpCreateInput(body: unknown): PipelineHttpCreateInput {
  const value = requireObject(body, '一键生产请求必须是 JSON 对象')
  const allowed = new Set([
    'projectId',
    'resolution',
    'kenBurns',
    'burnSubtitles',
    'introTitle',
    'outroCard',
    'reviewWatermark',
    'speechMode',
    'imageProviderId',
    'confirmationToken',
  ])
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new HttpError(400, 'INVALID_PIPELINE_REQUEST', `不支持的一键生产参数: ${unknown.join(', ')}`)
  }
  const projectId = requestIdentifier(value.projectId, 'projectId')
  if (value.resolution !== '720p' && value.resolution !== '1080p') {
    throw new HttpError(400, 'INVALID_PIPELINE_REQUEST', 'resolution 必须是 720p 或 1080p')
  }
  for (const field of [
    'kenBurns',
    'burnSubtitles',
    'introTitle',
    'outroCard',
    'reviewWatermark',
  ] as const) {
    if (typeof value[field] !== 'boolean') {
      throw new HttpError(400, 'INVALID_PIPELINE_REQUEST', `${field} 必须是布尔值`)
    }
  }
  if (value.speechMode !== 'auto' && value.speechMode !== 'skip') {
    throw new HttpError(400, 'INVALID_PIPELINE_REQUEST', 'speechMode 必须是 auto 或 skip')
  }
  const imageProviderId = value.imageProviderId === undefined
    ? undefined
    : requestIdentifier(value.imageProviderId, 'imageProviderId')
  return {
    projectId,
    resolution: value.resolution,
    kenBurns: value.kenBurns as boolean,
    burnSubtitles: value.burnSubtitles as boolean,
    introTitle: value.introTitle as boolean,
    outroCard: value.outroCard as boolean,
    reviewWatermark: value.reviewWatermark as boolean,
    speechMode: value.speechMode,
    ...(imageProviderId ? { imageProviderId } : {}),
    ...(Object.hasOwn(value, 'confirmationToken')
      ? { confirmationToken: value.confirmationToken as JsonValue }
      : {}),
  }
}

function pipelineCallerIntentFingerprint(
  episodeId: string,
  input: PipelineHttpCreateInput,
  rootIdempotencyKey: string,
): string {
  const requestFingerprint = pipelineProductionCallerIntentFingerprint({
    projectId: input.projectId,
    episodeId,
    idempotencyKey: 'caller-intent-only',
    options: {
      resolution: input.resolution,
      kenBurns: input.kenBurns,
      burnSubtitles: input.burnSubtitles,
      introTitle: input.introTitle,
      outroCard: input.outroCard,
      reviewWatermark: input.reviewWatermark,
      speechMode: input.speechMode,
    },
    ...(input.imageProviderId
      ? { imageProvider: { providerId: input.imageProviderId } }
      : {}),
  })
  const keyBinding = createHash('sha256').update(JSON.stringify({
    version: 2,
    requestFingerprint,
    rootIdempotencyKey,
  })).digest('hex')
  // Preserve the key-independent intent hash for active-run dedupe while the
  // complete durable fingerprint is cryptographically bound to the root key.
  return `pif2_${requestFingerprint}_${keyBinding}`
}

const PIPELINE_PREFLIGHT_TTL_SECONDS = 3 * 60
const PIPELINE_CALLER_FINGERPRINT_PATTERN = /^pif2_([a-f0-9]{64})_[a-f0-9]{64}$/
const PIPELINE_PREFLIGHT_TOKEN_PATTERN = /^pfr1_([1-9][0-9]{9,12})_([a-f0-9]{64})$/

function pipelineCallerConfigurationFingerprint(fingerprint: string): string {
  return PIPELINE_CALLER_FINGERPRINT_PATTERN.exec(fingerprint)?.[1] ?? fingerprint
}

interface PipelinePreflightConfirmationContext {
  rootIdempotencyKey: string
  expiresAtEpochSeconds: number
}

function pipelinePreflightAuthenticatedPayload(
  callerIntentFingerprint: string,
  discovery: PipelineProductionDiscovery,
  speechMode: 'auto' | 'skip',
  providers: {
    image?: PipelineProviderSelection
    speech?: PipelineProviderSelection
  },
  context: PipelinePreflightConfirmationContext,
) {
  if (!context.rootIdempotencyKey.trim()) {
    throw new TypeError('rootIdempotencyKey must not be empty')
  }
  if (!Number.isSafeInteger(context.expiresAtEpochSeconds)
    || context.expiresAtEpochSeconds <= 0) {
    throw new TypeError('expiresAtEpochSeconds must be a positive safe integer')
  }
  const providerBinding = (provider: PipelineProviderSelection | undefined) => provider
    ? {
        providerId: provider.providerId,
        configRevision: provider.configRevision ?? null,
        model: provider.model ?? null,
      }
    : null
  return {
    version: 1,
    callerIntentFingerprint,
    rootIdempotencyKey: context.rootIdempotencyKey,
    expiresAtEpochSeconds: context.expiresAtEpochSeconds,
    projectId: discovery.projectId,
    episodeId: discovery.episodeId,
    sourceRevisionId: discovery.sourceRevisionId,
    storyboardTargets: discovery.storyboardTargets,
    speechTargets: discovery.speechTargets,
    readyStoryboardCount: discovery.readyStoryboardCount,
    readySpeechCount: discovery.readySpeechCount,
    hasReadySpeech: discovery.hasReadySpeech,
    hasPublishableTimelineAudio: discovery.hasPublishableTimelineAudio,
    hasPublishableAudio: discovery.hasPublishableAudio,
    billableStoryboardCount: discovery.storyboardTargets.length,
    billableSpeechCount: speechMode === 'auto' ? discovery.speechTargets.length : 0,
    imageProvider: providerBinding(providers.image),
    speechProvider: providerBinding(providers.speech),
    speechBindings: speechMode === 'auto'
      ? discovery.speechBindings.map((binding) => ({
          targetId: binding.targetId,
          publicLineId: binding.publicLineId,
          sceneId: binding.sceneId,
          characterId: binding.characterId,
          characterDatabaseId: binding.characterDatabaseId,
          voiceId: binding.voiceId,
          voiceProfileRevisionId: binding.voiceProfileRevisionId,
          catalogFingerprint: binding.catalogFingerprint,
          provider: providerBinding(binding.provider),
          speed: binding.speed,
          pitch: binding.pitch,
          emotion: binding.emotion,
          sceneDirectionApplied: binding.sceneDirectionApplied,
        }))
      : [],
  }
}

function pipelinePreflightToken(
  secret: Buffer,
  callerIntentFingerprint: string,
  discovery: PipelineProductionDiscovery,
  speechMode: 'auto' | 'skip',
  providers: {
    image?: PipelineProviderSelection
    speech?: PipelineProviderSelection
  },
  context: PipelinePreflightConfirmationContext,
): string {
  const authenticated = pipelinePreflightAuthenticatedPayload(
    callerIntentFingerprint,
    discovery,
    speechMode,
    providers,
    context,
  )
  return `pfr1_${context.expiresAtEpochSeconds}_${createHmac('sha256', secret)
    .update(JSON.stringify(authenticated))
    .digest('hex')}`
}

type PipelinePreflightConfirmationVerification = 'valid' | 'expired' | 'invalid'

function verifyPipelinePreflightToken(
  secret: Buffer,
  callerIntentFingerprint: string,
  discovery: PipelineProductionDiscovery,
  speechMode: 'auto' | 'skip',
  providers: {
    image?: PipelineProviderSelection
    speech?: PipelineProviderSelection
  },
  token: string,
  rootIdempotencyKey: string,
  nowEpochSeconds: number,
): PipelinePreflightConfirmationVerification {
  const match = PIPELINE_PREFLIGHT_TOKEN_PATTERN.exec(token)
  if (!match || !Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 0) return 'invalid'
  const expiresAtEpochSeconds = Number(match[1])
  if (!Number.isSafeInteger(expiresAtEpochSeconds)) return 'invalid'
  const authenticated = pipelinePreflightAuthenticatedPayload(
    callerIntentFingerprint,
    discovery,
    speechMode,
    providers,
    { rootIdempotencyKey, expiresAtEpochSeconds },
  )
  const actualMac = Buffer.from(match[2], 'hex')
  const expectedMac = createHmac('sha256', secret)
    .update(JSON.stringify(authenticated))
    .digest()
  if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
    return 'invalid'
  }
  return nowEpochSeconds >= expiresAtEpochSeconds ? 'expired' : 'valid'
}

function requirePipelineConfirmationToken(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !PIPELINE_PREFLIGHT_TOKEN_PATTERN.test(value)) {
    throw new HttpError(
      428,
      'PIPELINE_PREFLIGHT_REQUIRED',
      '请先完成一键生产预检并确认本次可计费任务',
    )
  }
  return value
}

function pipelinePreflightAsJson(
  discovery: PipelineProductionDiscovery,
  speechMode: 'auto' | 'skip',
  confirmationToken: string | null,
  expiresAt: string | null,
  providers: {
    image?: PipelineProviderSelection
    speech?: PipelineProviderSelection
  },
): JsonObject {
  const providerSummary = (provider: PipelineProviderSelection | undefined): JsonValue => provider
    ? {
        providerId: provider.providerId,
        configRevision: provider.configRevision ?? null,
        model: provider.model ?? null,
      }
    : null
  const speechProviders = [...new Map(discovery.speechBindings.map((binding) => [
    `${binding.provider.providerId}:${binding.provider.configRevision}:${binding.provider.model ?? ''}`,
    binding.provider,
  ])).values()]
  return {
    version: 1,
    projectId: discovery.projectId,
    episodeId: discovery.episodeId,
    sourceRevisionId: discovery.sourceRevisionId,
    readyStoryboardCount: discovery.readyStoryboardCount,
    missingStoryboardCount: discovery.storyboardTargets.length,
    readySpeechCount: discovery.readySpeechCount,
    missingSpeechCount: discovery.speechTargets.length,
    hasPublishableAudio: discovery.hasPublishableAudio,
    billableStoryboardCount: discovery.storyboardTargets.length,
    billableSpeechCount: speechMode === 'auto' ? discovery.speechTargets.length : 0,
    billableTargetCount: discovery.storyboardTargets.length
      + (speechMode === 'auto' ? discovery.speechTargets.length : 0),
    imageProvider: providerSummary(providers.image),
    // Legacy convenience field for clients that only display one provider.
    speechProvider: speechProviders.length === 1 ? providerSummary(speechProviders[0]) : null,
    speechProviders: speechProviders.map((provider) => providerSummary(provider)) as JsonValue,
    voiceSummary: {
      boundCharacterCount: discovery.voiceSummary.boundCharacterCount,
      distinctVoiceCount: discovery.voiceSummary.distinctVoiceCount,
      sceneDirectedTargetCount: discovery.voiceSummary.sceneDirectedTargetCount,
      characters: discovery.voiceSummary.characters.map((character) => ({ ...character })),
    },
    blockers: discovery.voiceBlockers.map((blocker) => ({
      ...blocker,
      lineIds: [...blocker.lineIds],
    })),
    canCreate: discovery.voiceBlockers.length === 0,
    confirmationToken,
    expiresAt,
  }
}

function sameShotVideoSubmission(left: JsonObject, right: unknown): boolean {
  const requestIdentity = (value: unknown): unknown => {
    if (!isPlainObject(value) || !isPlainObject(value.binding)) return value
    // This field is a server-derived compare-and-swap cursor, not a client
    // request parameter. A successful job changes it by linking its own asset,
    // so including it in request identity would make a legitimate replay fail.
    const { expectedPreviousVideoAssetId: _cursor, ...binding } = value.binding
    return {
      ...value,
      generateAudio: value.generateAudio ?? false,
      binding,
    }
  }
  return isDeepStrictEqual(requestIdentity(left), requestIdentity(right))
}

function legacyJob(job: GenerationJobRecord): JsonObject {
  const safeError = job.error
    ? {
        code: typeof job.error.code === 'string' ? job.error.code : 'JOB_FAILED',
        message: typeof job.error.message === 'string' ? job.error.message : '任务执行失败',
        retryable: job.error.retryable === true,
      }
    : null
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    attempt: job.attempt,
    input: job.input,
    output: job.output,
    error: safeError,
    retryOf: job.retryOf,
  }
}

function requiredIfMatch(request: Request): string {
  const raw = request.get('if-match')
  if (!raw) throw new HttpError(428, 'PRECONDITION_REQUIRED', '必须提供 If-Match 项目版本')
  const revisionId = revisionIdFromEtag(raw)
  if (!revisionId) throw new HttpError(400, 'INVALID_ETAG', 'If-Match 项目版本格式无效')
  return revisionId
}

function requiredEpisodeIfMatch(request: Request): string {
  const raw = request.get('if-match')
  if (!raw) throw new HttpError(428, 'PRECONDITION_REQUIRED', '必须提供 If-Match 分集版本')
  const version = versionTokenFromEtag(raw)
  if (!version) throw new HttpError(400, 'INVALID_ETAG', 'If-Match 分集版本格式无效')
  return version
}

function requiredLinePerformanceIfMatch(request: Request): string {
  const raw = request.get('if-match')?.trim()
  if (!raw) {
    throw new HttpError(428, 'PRECONDITION_REQUIRED', '必须先读取最新逐句表演档案并提供 If-Match')
  }
  if (!/^(?:W\/)?"[^"\s]+"$/.test(raw)) {
    throw new HttpError(400, 'INVALID_ETAG', '逐句表演 If-Match 格式无效')
  }
  return raw
}

/** `*` is the explicit create-only sentinel for a timeline that has no head yet. */
function requiredTimelineIfMatch(request: Request): string | null {
  const raw = request.get('if-match')?.trim()
  if (!raw) throw new HttpError(428, 'PRECONDITION_REQUIRED', '必须提供 If-Match 时间线版本')
  if (raw === '*') return null
  const revisionId = revisionIdFromEtag(raw)
  if (!revisionId) throw new HttpError(400, 'INVALID_ETAG', 'If-Match 时间线版本格式无效')
  return revisionId
}

function requiredExistingTimelineIfMatch(request: Request): string {
  const revisionId = requiredTimelineIfMatch(request)
  if (revisionId === null) {
    throw new HttpError(
      400,
      'INVALID_ETAG',
      'Agentic 自动剪辑 If-Match 必须指向已持久化的时间线修订',
    )
  }
  return revisionId
}

function optionalTimelineIfMatch(request: Request): string | undefined {
  const raw = request.get('if-match')?.trim()
  if (!raw) return undefined
  if (raw === '*') {
    throw new HttpError(400, 'INVALID_ETAG', '导出 If-Match 必须指向一个已持久化的时间线修订')
  }
  const revisionId = revisionIdFromEtag(raw)
  if (!revisionId) throw new HttpError(400, 'INVALID_ETAG', 'If-Match 时间线版本格式无效')
  return revisionId
}

function providerExecutionError(error: ImageProviderError): JobExecutionError {
  const upper = error.code.toUpperCase()
  const category = upper.includes('AUTH') || upper.includes('API_KEY')
    ? 'authentication'
    : upper.includes('CONTENT') || upper.includes('SAFETY')
      ? 'content_policy'
      : upper.includes('INVALID') || upper.includes('UNSAFE') || upper.includes('TOO_LARGE')
        ? 'validation'
        : 'provider'
  return new JobExecutionError(error.code, error.message, error.retryable, category)
}

async function loadReferenceImages(
  mediaStore: MediaStore,
  referenceAssetIds: readonly string[],
  signal: AbortSignal,
): Promise<ProviderImageReference[]> {
  const references: ProviderImageReference[] = []
  let totalBytes = 0
  for (const assetId of referenceAssetIds) {
    signal.throwIfAborted()
    let opened
    try {
      opened = await mediaStore.openAsset(assetId)
    } catch (error) {
      if (error instanceof MediaStoreError) {
        throw new JobExecutionError(
          'REFERENCE_ASSET_UNAVAILABLE',
          '锁定参考图文件不可用，未发起图片生成计费请求',
          false,
          'validation',
        )
      }
      throw error
    }
    try {
      if (opened.size > MAX_REFERENCE_IMAGE_BYTES
        || totalBytes + opened.size > MAX_REFERENCE_IMAGES_TOTAL_BYTES) {
        throw new JobExecutionError(
          'REFERENCE_ASSET_TOO_LARGE',
          '锁定参考图超过上传大小限制，未发起图片生成计费请求',
          false,
          'validation',
        )
      }
      const bytes = await opened.file.readFile()
      signal.throwIfAborted()
      if (bytes.byteLength !== opened.size) {
        throw new JobExecutionError(
          'REFERENCE_ASSET_UNAVAILABLE',
          '锁定参考图读取不完整，未发起图片生成计费请求',
          false,
          'validation',
        )
      }
      totalBytes += bytes.byteLength
      references.push({ bytes, mimeType: opened.mimeType })
    } finally {
      await opened.file.close().catch(() => undefined)
    }
  }
  return references
}

function idempotencyKey(request: Request, required: boolean): string {
  const value = request.get('idempotency-key')?.trim()
  if (value) {
    if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 格式无效')
    }
    return value
  }
  if (required) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', '必须提供 Idempotency-Key')
  return randomUUID()
}

function rangeFor(size: number, header: string | undefined): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) throw new HttpError(416, 'INVALID_RANGE', 'Range 请求无效')
  let start: number
  let end: number
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new HttpError(416, 'INVALID_RANGE', 'Range 请求无效')
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    throw new HttpError(416, 'INVALID_RANGE', 'Range 超出媒体文件范围')
  }
  return { start, end: Math.min(end, size - 1) }
}

function projectDocumentForCreate(body: JsonObject): { title: string; document: JsonObject } {
  const title = typeof body.title === 'string' && body.title.trim()
    ? body.title.trim().slice(0, 200)
    : '未命名漫剧'
  const document = body.document === undefined
    ? {
        version: 1,
        title,
        sourceText: '',
        shots: [],
        settings: { style: '国风动画', aspect: '16:9', consistencyLocked: true },
        visualAssets: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as JsonObject
    : requireObject(body.document, 'document 必须是 JSON 对象')
  return { title, document }
}

export interface ApplicationOptions {
  runtimeDirectory?: string
  provider?: ImageProvider
  /** Test/internal fetch override for OpenAI-compatible text generation. */
  textCompatibleFetch?: typeof fetch
  /** Test/internal override; production materializes and constructs MiniMaxSpeechProvider. */
  speechProvider?: SpeechProvider
  /** Test/internal fetch override for OpenAI-compatible Speech. */
  speechCompatibleFetch?: typeof fetch
  /** Test/internal duration probe override; production uses pinned ffprobe. */
  speechAudioDurationProbe?: AudioDurationProbe
  /** Test/internal upload probe override; production uses pinned ffprobe. */
  mediaUploadAudioDurationProbe?: AudioDurationProbe
  /** Raw request and service-layer limit for user BGM/SFX uploads. */
  mediaUploadMaxAudioBytes?: number
  /** Test/internal MiniMax subtitle sidecar loader override. */
  speechSubtitleLoader?: MiniMaxSubtitleLoader
  /** Test/internal fetch override for the non-billable MiniMax voice directory. */
  miniMaxVoiceCatalogFetch?: typeof fetch
  miniMaxVoiceCatalogTimeoutMs?: number
  /** Test/internal fetch override for the IndexTTS Sidecar voice directory. */
  indexTtsVoiceCatalogFetch?: typeof fetch
  /** Test/internal Seedance provider override; BYOK profile materialization still runs first. */
  seedanceProvider?: SeedanceVideoProviderContract
  /** Test/internal fetch override for the Ark Seedance adapter. */
  seedanceFetch?: typeof fetch
  /** Test/internal output downloader override; production uses the SSRF-safe downloader. */
  seedanceDownloadVideo?: SafeVideoDownloader
  /** Test/internal media probe override; production uses the pinned ffprobe binary. */
  seedanceVideoProbe?: VideoMetadataProbe
  /** Test/internal polling controls. */
  seedancePollIntervalMs?: number
  seedanceMaxConsecutivePollErrors?: number
  seedanceDurableStatusCheckIntervalMs?: number
  seedanceRequestTimeoutMs?: number
  seedanceTotalDeadlineMs?: number
  /** Test/internal clock for short-lived paid one-click production preflights. */
  pipelinePreflightNow?: () => Date
  /** Test/internal clock for the generic paid AIGC confirmation gate. */
  paidAigcConfirmationNow?: () => Date
  /**
   * Test/internal compatibility switch. Production callers must omit this;
   * the default always requires a signed preflight before a billable Job.
   */
  enforcePaidAigcConfirmation?: boolean
  /** Test/internal clock for short-lived paid Seedance preflight capabilities. */
  shotVideoPreflightNow?: () => Date
  /** Test/internal override for the real FFmpeg export renderer. */
  exportRenderer?: Pick<FfmpegRenderer, 'render'>
  /** Test/internal override for the real FFmpeg/ffprobe quality analyzer. */
  qualityAnalyzer?: QualityAnalyzerPort
  keychain?: ProviderCredentialStore
  providerProbe?: ProviderProbe
  loadByoaCredential?: (providerId: string) => Promise<string | null>
  hasByoaCredential?: (providerId: string) => Promise<boolean>
  generationTimeoutMs?: number
  /** Test/internal override; production uses the bundled FFmpeg crop renderer. */
  turnaroundCropRenderer?: TurnaroundCropRenderer
  maxQueueDepth?: number
  autoStartWorker?: boolean
  /** Set false only for embedded/test callers that provide their own HTTP logging. */
  requestLogSink?: RequestLogSink | false
}

export interface ApplicationRuntime {
  app: express.Express
  database: ManjuDatabase
  worker: JobWorker
  provider: ImageProvider
  mediaStore: MediaStore
  eventHub: StudioEventHub
  projectService: ProjectService
  projectKnowledgeService: ProjectKnowledgeService
  storyRepository: StoryRepository
  providerService: ProviderService
  miniMaxVoiceCatalogService: MiniMaxVoiceCatalogService
  indexTtsVoiceCatalogService: IndexTtsVoiceCatalogService
  doubaoVoiceCatalogService: DoubaoVoiceCatalogService
  characterVoiceProfiles: CharacterVoiceProfileRepository
  projectNarratorVoiceProfiles: ProjectNarratorVoiceProfileRepository
  voicePreviewReviewService: VoicePreviewReviewService
  linePerformanceProfiles: LinePerformanceProfileRepository
  timelineDocumentService: TimelineDocumentService
  timelineMaterializationService: TimelineMaterializationService
  timelineAutoEditService: TimelineAutoEditService
  timelineRevisionRestoreService: TimelineRevisionRestoreService
  productionAssetManifestService: ProductionAssetManifestService
  shotMediaReviewService: ShotMediaReviewService
  exportRenderService: ExportRenderService
  qualityCheckService: QualityCheckService
  releaseReviewService: ReleaseReviewService
  assetRetentionService: AssetRetentionService
  pipelineRunCoordinator: PipelineRunCoordinator
  generatedDirectory: string
  /** Compatibility shim for callers of the v0 AtomicStateStore runtime. */
  store: { flush(): Promise<void> }
  /** Compatibility alias; new code should use worker. */
  queue: JobWorker
  close(): Promise<void>
}

export async function createApplication(options: ApplicationOptions = {}): Promise<ApplicationRuntime> {
  const runtimeDirectory = resolve(options.runtimeDirectory ?? process.env.MANJU_RUNTIME_DIR ?? 'runtime')
  const generatedDirectory = resolve(runtimeDirectory, 'generated')
  // Boot-scoped confirmation capability. A restart deliberately invalidates
  // unconsumed paid preflights, while exact idempotent replays bypass it.
  const pipelinePreflightSecret = randomBytes(32)
  const shotVideoPreflightSecret = randomBytes(32)
  const paidAigcConfirmationGate = options.enforcePaidAigcConfirmation === false
    ? null
    : new PaidAigcConfirmationGate({
        secret: randomBytes(32),
        ...(options.paidAigcConfirmationNow ? { now: options.paidAigcConfirmationNow } : {}),
      })
  const requirePaidAigcConfirmation = (
    request: Request,
    intent: PaidAigcConfirmationIntent,
    label: string,
  ): void => {
    if (!paidAigcConfirmationGate) return
    const token = request.get(PAID_AIGC_CONFIRMATION_HEADER)?.trim() ?? ''
    const verification = token
      ? paidAigcConfirmationGate.verify(intent, token)
      : 'invalid'
    if (verification === 'valid') return
    const confirmation = paidAigcConfirmationGate.issue(intent, label)
    throw new HttpError(
      409,
      'PAID_CONFIRMATION_REQUIRED',
      verification === 'expired'
        ? '计费确认已过期；服务端已重新核定当前任务与 Provider，请再次确认'
        : '请先确认服务端核定的 AIGC 任务；当前未创建任务或调用 Provider',
      { confirmation: confirmation as unknown as JsonValue },
    )
  }
  const pipelinePreflightNow = options.pipelinePreflightNow ?? (() => new Date())
  const shotVideoPreflightNow = options.shotVideoPreflightNow ?? (() => new Date())
  await mkdir(runtimeDirectory, { recursive: true })
  await mkdir(generatedDirectory, { recursive: true })

  const database = initializeDatabase({ runtimeDirectory })
  seedProviderCatalogConnections(database)
  const projectService = new ProjectService(database)
  const defaultSnapshot = projectService.ensureDefaultProject()
  const projectKnowledgeService = new ProjectKnowledgeService(database)
  const storyRepository = new StoryRepository(database)
  const characterVoiceProfiles = new CharacterVoiceProfileRepository(database)
  const projectNarratorVoiceProfiles = new ProjectNarratorVoiceProfileRepository(database)
  const voicePreviewReviewService = new VoicePreviewReviewService(database)
  const linePerformanceProfiles = new LinePerformanceProfileRepository(database)
  const legacyVoiceProfileRepairs = characterVoiceProfiles.repairLegacyFractionalPitches()
  if (legacyVoiceProfileRepairs.repaired > 0) {
    console.warn('已创建兼容审计版本并修复旧角色声线的小数音高', {
      repaired: legacyVoiceProfileRepairs.repaired,
    })
  }
  const timelineDocumentService = new TimelineDocumentService(
    new SQLiteTimelineDocumentRepository(database),
  )
  const timelineMaterializationService = new TimelineMaterializationService(
    database,
    storyRepository,
    timelineDocumentService,
  )
  const timelineAutoEditService = new TimelineAutoEditService(
    database,
    timelineDocumentService,
    new SQLiteTimelineAutoEditRepository(database),
    createTimelineMaterializationAutoEditPlanner(timelineMaterializationService, database),
  )
  const timelineRevisionRestoreService = new TimelineRevisionRestoreService(
    database,
    timelineDocumentService,
  )
  const shotMediaReviewService = new ShotMediaReviewService(database)
  const exportRenderService = new ExportRenderService(database, timelineDocumentService)
  const qualityCheckService = new QualityCheckService(database, exportRenderService)
  const releaseReviewService = new ReleaseReviewService(database, qualityCheckService)
  const mediaStore = new MediaStore(database, { runtimeDirectory })
  await mediaStore.init()
  const turnaroundCropRenderer = options.turnaroundCropRenderer
    ?? new FfmpegTurnaroundCropRenderer({ workingDirectory: generatedDirectory })
  await cleanupIncompleteTurnaroundAssets(database, mediaStore)
  const assetRetentionService = new AssetRetentionService(database, { runtimeDirectory })
  await assetRetentionService.recover()
  const mediaUploadMaxAudioBytes = options.mediaUploadMaxAudioBytes
    ?? DEFAULT_USER_AUDIO_UPLOAD_MAX_BYTES
  const mediaUploadService = new UserMediaUploadService(database, mediaStore, {
    maxAudioBytes: mediaUploadMaxAudioBytes,
    ...(options.mediaUploadAudioDurationProbe
      ? { audioDurationProbe: options.mediaUploadAudioDurationProbe }
      : {}),
  })

  const codexToolsCredentials = createCodexToolsCredentialSource()
  const loadByoaCredential = options.loadByoaCredential ?? (async (providerId: string) => (
    providerId.startsWith('codex-tools') ? codexToolsCredentials.load() : null
  ))
  const hasByoaCredential = options.hasByoaCredential ?? (options.loadByoaCredential
    ? async (providerId: string) => (await loadByoaCredential(providerId)) !== null
    : async (providerId: string) => (
        providerId.startsWith('codex-tools') && await codexToolsCredentials.exists()
      ))
  // ApplicationRuntime.provider is a legacy compatibility surface. Generation
  // jobs never use this boot snapshot: they materialize their immutable
  // Provider revision and its live credential immediately before execution.
  const initialCodexToolsApiKey = options.provider
    ? null
    : await loadByoaCredential('codex-tools-image')
  const provider = options.provider ?? new CodexToolsImageProvider({
    baseUrl: process.env.CODEX_TOOLS_BASE_URL,
    apiKey: initialCodexToolsApiKey,
    model: process.env.CODEX_TOOLS_IMAGE_MODEL,
  })
  const keychain = options.keychain ?? new MacOSKeychain()
  const providerRepository = new SQLiteProviderConnectionRepository(database)
  const providerService = new ProviderService({
    repository: providerRepository,
    keychain,
    loadByoaCredential,
    hasByoaCredential,
    probe: options.providerProbe,
  })
  const miniMaxVoiceCatalogService = new MiniMaxVoiceCatalogService(
    providerService,
    new MiniMaxVoiceCatalogClient({
      ...(options.miniMaxVoiceCatalogFetch ? { fetch: options.miniMaxVoiceCatalogFetch } : {}),
      ...(options.miniMaxVoiceCatalogTimeoutMs
        ? { timeoutMs: options.miniMaxVoiceCatalogTimeoutMs }
        : {}),
    }),
  )
  const indexTtsVoiceCatalogService = new IndexTtsVoiceCatalogService(
    providerService,
    new IndexTtsVoiceCatalogClient(options.indexTtsVoiceCatalogFetch),
  )
  const doubaoVoiceCatalogService = new DoubaoVoiceCatalogService(providerService)
  const speechVoiceCatalog = async (providerId: string, signal?: AbortSignal) => {
    if (providerId === 'minimax-speech') return miniMaxVoiceCatalogService.list(signal)
    if (providerId === 'indextts-speech') return indexTtsVoiceCatalogService.list(signal)
    if (providerId === 'doubao-speech') return doubaoVoiceCatalogService.list()
    throw new HttpError(400, 'INVALID_REQUEST', '当前 Provider 不提供可验证的声线目录')
  }

  const configuredQueueDepth = Number(process.env.MAX_QUEUE_DEPTH)
  const queueDepthCandidate = options.maxQueueDepth
    ?? (Number.isFinite(configuredQueueDepth) ? configuredQueueDepth : MAX_QUEUE_DEPTH)
  const maxQueueDepth = Number.isInteger(queueDepthCandidate) && queueDepthCandidate > 0
    ? Math.min(queueDepthCandidate, 1_000)
    : MAX_QUEUE_DEPTH
  // HTTP requests can reach the capacity check concurrently. Serialize only
  // the short durable admission section so two requests cannot both observe
  // the same final slot and overfill the queue.
  let admissionTail: Promise<void> = Promise.resolve()
  const withJobAdmission = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = admissionTail
    let release!: () => void
    admissionTail = new Promise<void>((resolveAdmission) => { release = resolveAdmission })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
  const configuredTimeout = Number(process.env.IMAGE_GENERATION_TIMEOUT_MS)
  const generationTimeoutMs = options.generationTimeoutMs
    ?? (Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_GENERATION_TIMEOUT_MS)

  const eventHub = new StudioEventHub()
  const jobs = new SQLiteJobRepository(database, { defaultProjectId: defaultSnapshot.project.id })
  let pipelineRunCoordinator: PipelineRunCoordinator | undefined
  let pipelineRecoveryWakeScheduled = false
  const pipelineTasks = new Set<Promise<void>>()
  const publishPipelineRun = (run: PipelineRunRecord): void => {
    try {
      eventHub.publish('pipeline.updated', {
        pipelineRun: pipelineRunAsJson(run),
      }, { projectId: run.projectId })
    } catch (error) {
      // Schema-v5 allowed incomplete placeholder rows. They remain durable for
      // audit/migration but must not poison SSE or expose malformed documents.
      const name = error instanceof Error ? error.name : typeof error
      console.warn('Skipped unreadable legacy pipeline event', { pipelineRunId: run.id, name })
    }
  }
  const trackPipelineTask = (promise: Promise<unknown>, operation: string): void => {
    let tracked: Promise<void>
    tracked = promise
      .then(() => undefined)
      .catch((error: unknown) => {
        if (error instanceof HttpError && error.code === 'QUEUE_FULL') return
        const name = error instanceof Error ? error.name : typeof error
        console.error('Pipeline runtime failure', { operation, name })
      })
      .finally(() => pipelineTasks.delete(tracked))
    pipelineTasks.add(tracked)
  }
  const schedulePipelineRecoveryWake = (): void => {
    if (!pipelineRunCoordinator || pipelineRecoveryWakeScheduled) return
    pipelineRecoveryWakeScheduled = true
    queueMicrotask(() => {
      pipelineRecoveryWakeScheduled = false
      if (!pipelineRunCoordinator) return
      trackPipelineTask(
        pipelineRunCoordinator.recover().then((runs) => {
          for (const run of runs) publishPipelineRun(run)
        }),
        'capacity-released',
      )
    })
  }
  const worker = new JobWorker(jobs, {
    concurrency: 4,
    resourceConcurrency: {
      'provider:image': 1,
      'provider:text': 1,
      // Visual-reference batches are split into independent single-shot Jobs.
      // Two can progress concurrently without allowing an unbounded burst at
      // a BYOK/BYOA multimodal endpoint.
      'provider:text:vision': 2,
      'provider:speech': 2,
      'provider:video': 1,
      'renderer:ffmpeg': 1,
      'analyzer:ffmpeg': 1,
    },
    onEvent(event) {
      const durable = database.getGenerationJob(event.jobId)
      if (!durable) return
      exportRenderService.syncJob(durable)
      qualityCheckService.syncJob(durable)
      const type = event.type === 'job.created' ? 'job.created' : 'job.updated'
      eventHub.publish(type, {
        eventType: event.type,
        job: publicJob(durable, database),
      }, { projectId: durable.projectId })
      if (durable.type === TURNAROUND_DERIVATION_JOB_TYPE
        && (event.type === 'job.failed' || event.type === 'job.cancelled')) {
        trackPipelineTask(
          cleanupTurnaroundJobAssets(database, mediaStore, durable.id),
          'turnaround-terminal-cleanup',
        )
      }
      // Worker callbacks must remain synchronous and non-blocking. The
      // coordinator rereads the durable child row before advancing its parent.
      if (durable.pipelineRunId && pipelineRunCoordinator) {
        trackPipelineTask(
          pipelineRunCoordinator.notifyJobChanged(durable.id).then((run) => {
            if (run) publishPipelineRun(run)
          }),
          'worker-event',
        )
      }
      if (!durable.pipelineRunId && (event.type === 'job.succeeded'
        || event.type === 'job.failed'
        || event.type === 'job.cancelled')) {
        // A run that previously hit QUEUE_FULL may have no active child and
        // therefore receives no parent-specific event. Any released slot is a
        // deterministic opportunity to retry all durable active parents.
        schedulePipelineRecoveryWake()
      }
    },
    onError(error, context) {
      const name = error instanceof Error ? error.name : typeof error
      console.error('JobWorker internal failure', { ...context, name })
    },
  })
  await Promise.all(legacyVoiceProfileRepairs.activeJobIds.map((jobId) => worker.cancel(
    jobId,
    '角色声线旧版小数音高已修复，已停止旧任务；若上游请求已提交，仍可能继续执行或产生费用',
  )))

  const imageHandler = async (
    job: JobRecord<StoryboardImageJobInput>,
    context: JobHandlerContext,
  ): Promise<JsonObject> => {
    const projectId = job.projectId ?? defaultSnapshot.project.id
    const durable = database.getGenerationJob(job.id)
    if (!durable) throw new JobExecutionError('JOB_NOT_FOUND', '图片任务不存在', false, 'validation')
    if (!durable.providerId || durable.providerConfigRevision === null) {
      throw new JobExecutionError('PROVIDER_NOT_CONFIGURED', '任务绑定的图片 Provider 不存在', false, 'validation')
    }
    const priorProviderState = isPlainObject(job.providerState) ? job.providerState : undefined
    const priorPhase = priorProviderState?.phase
    if (
      (priorProviderState?.operation === 'image.generate' || priorProviderState?.operation === 'image.edit')
      && (priorPhase === 'submitting' || priorPhase === 'response-received')
      && priorProviderState.providerSupportsIdempotency !== true
    ) {
      throw new JobExecutionError(
        'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
        '上次图片请求在服务中断前已提交，结果无法确认。为避免重复计费，系统没有自动重提；请核对 Provider 后手动重试。',
        false,
        'provider',
      )
    }

    // v1 storyboard jobs carry a server-created immutable binding. Resolve
    // the public Story IDs again before the first paid Provider call so a
    // queued job can never drift to a replacement shot or story revision.
    const storyboardBinding = storyboardBindingForJob(job.type, job.input)
    if (storyboardBinding && durable.episodeId !== storyboardBinding.episodeId) {
      throw new JobExecutionError(
        'INVALID_STORYBOARD_BINDING',
        '分镜任务与所属分集不一致，未发起图片生成计费请求',
        false,
        'validation',
      )
    }
    const storyboardTarget = storyboardBinding
      ? resolveDurableStoryboardShot(database, projectId, storyboardBinding)
      : null
    const assetEntityBinding = visualAssetEntityBindingForJob(job.type, job.input)
    if (assetEntityBinding && durable.episodeId !== assetEntityBinding.episodeId) {
      throw new JobExecutionError(
        'INVALID_VISUAL_ASSET_BINDING',
        '视觉资产任务与所属分集不一致，未发起图片生成计费请求',
        false,
        'validation',
      )
    }
    const assetEntityTarget = assetEntityBinding
      ? resolveDurableVisualAssetEntity(database, projectId, assetEntityBinding)
      : null
    const episodeBinding = resolveDurableEpisodeImageBinding(
      database,
      projectId,
      job.input.episodeBinding,
    )
    if ((storyboardBinding || assetEntityBinding) && !episodeBinding) {
      throw new JobExecutionError(
        'INVALID_EPISODE_BINDING',
        '图片任务缺少固化的分集画面设置，未发起图片生成计费请求',
        false,
        'validation',
      )
    }
    if (episodeBinding && durable.episodeId !== episodeBinding.episodeId) {
      throw new JobExecutionError(
        'INVALID_EPISODE_BINDING',
        '图片任务与所属分集不一致，未发起图片生成计费请求',
        false,
        'validation',
      )
    }
    if (episodeBinding) {
      assertEpisodeImagePublication(database, {
        projectId,
        jobId: job.id,
        binding: episodeBinding,
      })
    }
    const referenceAssetIds = validateDurableReferenceAssetIds(database, {
      projectId,
      episodeBinding,
      referenceAssetIds: job.input.referenceAssetIds,
    })
    if (storyboardTarget) {
      assertCurrentStoryboardReferenceDecision(database, {
        target: storyboardTarget,
        decision: job.input.storyboardReferenceDecision,
        referenceAssetIds,
      })
    }

    let executionProfile
    try {
      executionProfile = await providerService.materializeExecutionProfile(
        durable.providerId,
        durable.providerConfigRevision,
      )
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        throw new JobExecutionError(error.code, error.message, false, 'validation')
      }
      throw error
    }
    if (executionProfile.kind !== 'image') {
      throw new JobExecutionError('PROVIDER_KIND_MISMATCH', '任务绑定的 Provider 不是图片服务', false, 'validation')
    }
    if (executionProfile.adapter !== 'codex-tools' && executionProfile.adapter !== 'openai-compatible') {
      throw new JobExecutionError(
        'PROVIDER_ADAPTER_NOT_IMPLEMENTED',
        '该图片 Provider 的生成 Adapter 尚未接入，未发起计费请求',
        false,
        'validation',
      )
    }
    if (!executionProfile.baseUrl || !executionProfile.model) {
      throw new JobExecutionError('PROVIDER_NOT_CONFIGURED', '任务绑定的图片 Provider 配置不完整', false, 'validation')
    }
    const executionProvider = options.provider && durable.providerId === 'codex-tools-image'
      ? options.provider
      : new CodexToolsImageProvider({
          baseUrl: executionProfile.baseUrl,
          apiKey: executionProfile.apiKey,
          model: executionProfile.model,
        })

    if (referenceAssetIds.length > 0 && executionProvider.supportsImageReferences !== true) {
      throw new JobExecutionError(
        'REFERENCE_IMAGES_UNSUPPORTED',
        '当前图片 Provider 未声明支持参考图生成，系统不会默默降级为纯文本生图',
        false,
        'validation',
      )
    }
    const referenceImages = await loadReferenceImages(mediaStore, referenceAssetIds, context.signal)
    const providerOperation = referenceImages.length > 0 ? 'image.edit' : 'image.generate'

    await context.reportProgress(5, {
      stage: 'provider-request',
      referenceAssetIds,
      referenceImageCount: referenceAssetIds.length,
    })
    await context.waitingForProvider({
      operation: providerOperation,
      phase: 'submitting',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: executionProfile.providerId,
      providerConfigRevision: executionProfile.configRevision,
      referenceAssetIds,
      submittedAt: new Date().toISOString(),
    })
    // `waitingForProvider` is the last awaited checkpoint before the paid
    // request. Re-resolve synchronously after it, then invoke Provider without
    // another awaitable gap so a queued slot/location mutation cannot charge
    // against stale reference evidence.
    if (storyboardBinding) {
      const finalTarget = resolveDurableStoryboardShot(database, projectId, storyboardBinding)
      const finalReferenceAssetIds = validateDurableReferenceAssetIds(database, {
        projectId,
        episodeBinding,
        referenceAssetIds: job.input.referenceAssetIds,
      })
      assertCurrentStoryboardReferenceDecision(database, {
        target: finalTarget,
        decision: job.input.storyboardReferenceDecision,
        referenceAssetIds: finalReferenceAssetIds,
      })
    }
    context.signal.throwIfAborted()
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(new Error('image generation timeout')), generationTimeoutMs)
    timer.unref()
    const signal = AbortSignal.any([context.signal, timeoutController.signal])
    let images
    try {
      images = await executionProvider.generate(job.input, signal, referenceImages)
    } catch (error) {
      if (context.signal.aborted) throw error
      if (timeoutController.signal.aborted) {
        throw new JobExecutionError('PROVIDER_TIMEOUT', '图片生成超时，请稍后重试', true, 'timeout')
      }
      if (error instanceof ImageProviderError) {
        // A structured provider rejection proves that this request reached a
        // terminal failure response, so an explicit user retry is safe. A
        // transport failure (`UPSTREAM_UNAVAILABLE`) is different: the paid
        // POST outcome is unknown and must keep the `submitting` checkpoint so
        // the generic retry guard refuses an accidental duplicate charge.
        if (error.code !== 'UPSTREAM_UNAVAILABLE') {
          await context.waitingForProvider({
            operation: providerOperation,
            phase: 'failed',
            clientRequestId: job.id,
            providerSupportsIdempotency: false,
            providerId: executionProfile.providerId,
            providerConfigRevision: executionProfile.configRevision,
            referenceAssetIds,
            providerFailureConfirmed: true,
            providerErrorCode: error.code,
            failedAt: new Date().toISOString(),
          })
        }
        throw providerExecutionError(error)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (images.length !== job.input.count) {
      throw new JobExecutionError('INVALID_IMAGE_RESPONSE', '图片服务返回数量与请求不一致', true, 'provider')
    }
    await context.waitingForProvider({
      operation: providerOperation,
      phase: 'response-received',
      clientRequestId: job.id,
      providerSupportsIdempotency: false,
      providerId: executionProfile.providerId,
      providerConfigRevision: executionProfile.configRevision,
      referenceAssetIds,
      receivedAt: new Date().toISOString(),
      imageCount: images.length,
    })

    const outputImages: JsonObject[] = []
    for (let index = 0; index < images.length; index += 1) {
      context.signal.throwIfAborted()
      const image = images[index]
      const dimensions = imageDimensions(image.bytes, image.mimeType)
      const kind = typeof job.input.metadata?.kind === 'string'
        ? job.input.metadata.kind.slice(0, 100)
        : 'generated.image'
      // Only explicit version-producing workflows inherit a stable Asset
      // family. parent_asset_id alone is not sufficient because derived
      // three-view crops also use it for provenance rather than versioning.
      const versionFamilySourceId = storyboardTarget?.storyboardAssetId
        ?? assetEntityBinding?.parentAssetId
        ?? null
      const assetFamilyId = versionFamilySourceId
        ? stableAssetIdForVersion(database, projectId, versionFamilySourceId)
        : null
      const generationParameters: JsonObject = {
        prompt: job.input.prompt,
        size: job.input.size,
        quality: job.input.quality,
        index,
        referenceAssetIds,
        ...(assetFamilyId ? { assetFamilyId } : {}),
        ...(episodeBinding ? {
          stylePreset: episodeBinding.stylePreset,
          aspectRatio: episodeBinding.aspectRatio,
        } : {}),
        ...(assetEntityBinding && assetEntityTarget ? {
          entityType: assetEntityBinding.entityType,
          entityId: assetEntityBinding.entityId,
          entityName: assetEntityTarget.name,
          sourceRevisionId: assetEntityBinding.expectedRevisionId,
        } : {}),
        ...(storyboardBinding ? {
          episodeId: storyboardBinding.episodeId,
          shotId: storyboardBinding.shotId,
          ...(storyboardBinding.sceneId ? { sceneId: storyboardBinding.sceneId } : {}),
          sourceRevisionId: storyboardBinding.expectedRevisionId,
        } : {}),
      }
      const asset = await mediaStore.save({
        projectId,
        episodeId: episodeBinding?.episodeId ?? durable.episodeId,
        kind,
        ...(assetEntityBinding ? { version: assetEntityBinding.nextVersion } : {}),
        bytes: image.bytes,
        mimeType: image.mimeType,
        source: 'provider',
        providerId: durable.providerId,
        generationJobId: job.id,
        generationParameters,
        sourceRevisionId: episodeBinding?.expectedRevisionId
          ?? database.getProject(projectId)?.currentRevisionId,
        ...(storyboardTarget?.storyboardAssetId
          ? { parentAssetId: storyboardTarget.storyboardAssetId }
          : assetEntityBinding?.parentAssetId
            ? { parentAssetId: assetEntityBinding.parentAssetId }
            : {}),
        width: dimensions.width,
        height: dimensions.height,
      }, episodeBinding || (storyboardBinding && storyboardTarget) ? {
        afterCreate(asset, transaction) {
          if (episodeBinding) {
            assertEpisodeImagePublication(transaction, {
              projectId,
              jobId: job.id,
              binding: episodeBinding,
            })
          }
          if (storyboardBinding && storyboardTarget) {
            linkStoryboardAsset(transaction, asset, {
              binding: storyboardBinding,
              expectedPreviousAssetId: storyboardTarget.storyboardAssetId,
              signal: context.signal,
            })
          }
        },
      } : undefined)
      const item: JsonObject = {
        id: asset.id,
        url: `/api/v1/assets/${encodeURIComponent(asset.id)}/content`,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
      }
      outputImages.push(item)
      eventHub.publish('asset.created', { asset: publicAsset(asset) }, { projectId })
      await context.reportProgress(20 + Math.round(((index + 1) / images.length) * 75), {
        stage: 'saving-assets',
        completed: index + 1,
        total: images.length,
        referenceAssetIds,
      })
    }
    return { images: outputImages, referenceAssetIds }
  }
  worker.register('image.generate', imageHandler, { resourceKey: () => 'provider:image' })
  worker.register('asset.image.generate', imageHandler, { resourceKey: () => 'provider:image' })
  worker.register(
    ASSET_IMAGE_EDIT_JOB_TYPE,
    createAssetImageEditHandler({
      database,
      mediaStore,
      providerService,
      injectedProvider: options.provider,
      generationTimeoutMs,
      publicAsset,
      publishAsset(asset) {
        eventHub.publish('asset.created', { asset: publicAsset(asset) }, { projectId: asset.projectId })
      },
    }),
    { resourceKey: () => 'provider:image' },
  )
  worker.register(
    TURNAROUND_DERIVATION_JOB_TYPE,
    createTurnaroundDerivationHandler({
      database,
      mediaStore,
      renderer: turnaroundCropRenderer,
      publicAsset,
      publishAsset(asset) {
        eventHub.publish('asset.created', { asset: publicAsset(asset) }, { projectId: asset.projectId })
      },
    }),
    { resourceKey: () => 'renderer:ffmpeg' },
  )
  worker.register(
    DIALOGUE_SPEECH_GENERATION_JOB_TYPE,
    createDialogueSpeechGenerationHandler({
      database,
      mediaStore,
      providerService,
      characterVoiceProfiles,
      narratorVoiceProfiles: projectNarratorVoiceProfiles,
      voiceCatalogService: miniMaxVoiceCatalogService,
      indexTtsVoiceCatalogService,
      doubaoVoiceCatalogService,
      linePerformanceProfiles,
      ...(options.speechProvider ? { injectedProvider: options.speechProvider } : {}),
      ...(options.speechCompatibleFetch ? { openAICompatibleFetch: options.speechCompatibleFetch } : {}),
      ...(options.speechAudioDurationProbe ? { audioDurationProbe: options.speechAudioDurationProbe } : {}),
      ...(options.speechSubtitleLoader ? { miniMaxSubtitleLoader: options.speechSubtitleLoader } : {}),
      publicAsset,
      publishAsset(asset) {
        eventHub.publish('asset.created', { asset: publicAsset(asset) }, { projectId: asset.projectId })
      },
    }),
    { resourceKey: () => 'provider:speech' },
  )
  worker.register(
    CHARACTER_VOICE_PREVIEW_JOB_TYPE,
    createCharacterVoicePreviewHandler({
      database,
      mediaStore,
      providerService,
      voiceCatalogService: { list: speechVoiceCatalog },
      ...(options.speechProvider ? { injectedProvider: options.speechProvider } : {}),
      ...(options.speechAudioDurationProbe ? { audioDurationProbe: options.speechAudioDurationProbe } : {}),
      publicAsset,
      publishAsset(asset) {
        eventHub.publish('asset.created', { asset: publicAsset(asset) }, { projectId: asset.projectId })
      },
    }),
    { resourceKey: () => 'provider:speech' },
  )
  worker.register(
    PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE,
    createProjectNarratorVoicePreviewHandler({
      database,
      mediaStore,
      providerService,
      voiceCatalogService: { list: speechVoiceCatalog },
      ...(options.speechProvider ? { injectedProvider: options.speechProvider } : {}),
      ...(options.speechAudioDurationProbe ? { audioDurationProbe: options.speechAudioDurationProbe } : {}),
      publicAsset,
      publishAsset(asset) {
        eventHub.publish('asset.created', { asset: publicAsset(asset) }, { projectId: asset.projectId })
      },
    }),
    { resourceKey: () => 'provider:speech' },
  )
  worker.register(
    SHOT_VIDEO_GENERATION_JOB_TYPE,
    createShotVideoGenerationHandler({
      database,
      mediaStore,
      async resolveProvider(job) {
        if (!job.providerId || job.providerConfigRevision === null || !job.model) {
          throw new JobExecutionError(
            'PROVIDER_NOT_CONFIGURED',
            '视频任务未绑定有效的 Seedance Provider 版本',
            false,
            'validation',
          )
        }
        let executionProfile
        try {
          executionProfile = await providerService.materializeExecutionProfile(
            job.providerId,
            job.providerConfigRevision,
          )
        } catch (error) {
          if (error instanceof ProviderConfigurationError) {
            throw new JobExecutionError(
              error.code,
              '视频任务绑定的 Seedance Provider 配置或历史凭据不可用',
              false,
              'validation',
            )
          }
          throw error
        }
        if (executionProfile.kind !== 'video') {
          throw new JobExecutionError(
            'PROVIDER_KIND_MISMATCH',
            '视频任务绑定的 Provider 不是视频服务',
            false,
            'validation',
          )
        }
        if (executionProfile.adapter !== 'seedance') {
          throw new JobExecutionError(
            'PROVIDER_ADAPTER_NOT_IMPLEMENTED',
            '该视频 Provider Adapter 尚未接入，未发起计费请求',
            false,
            'validation',
          )
        }
        if (!executionProfile.baseUrl?.trim()
          || !executionProfile.model?.trim()
          || executionProfile.model !== job.model) {
          throw new JobExecutionError(
            'PROVIDER_NOT_CONFIGURED',
            '视频任务绑定的 Seedance Provider 配置不完整',
            false,
            'validation',
          )
        }
        if (options.seedanceProvider) return options.seedanceProvider
        return new SeedanceVideoProvider({
          baseUrl: executionProfile.baseUrl,
          apiKey: executionProfile.apiKey,
          model: executionProfile.model,
          ...(options.seedanceFetch ? { fetch: options.seedanceFetch } : {}),
          ...(options.seedanceRequestTimeoutMs !== undefined
            ? { requestTimeoutMs: options.seedanceRequestTimeoutMs }
            : {}),
        })
      },
      ...(options.seedanceDownloadVideo ? { downloadVideo: options.seedanceDownloadVideo } : {}),
      ...(options.seedanceVideoProbe ? { probeVideo: options.seedanceVideoProbe } : {}),
      ...(options.seedancePollIntervalMs !== undefined
        ? { pollIntervalMs: options.seedancePollIntervalMs }
        : {}),
      ...(options.seedanceMaxConsecutivePollErrors !== undefined
        ? { maxConsecutivePollErrors: options.seedanceMaxConsecutivePollErrors }
        : {}),
      ...(options.seedanceDurableStatusCheckIntervalMs !== undefined
        ? { durableStatusCheckIntervalMs: options.seedanceDurableStatusCheckIntervalMs }
        : {}),
      ...(options.seedanceTotalDeadlineMs !== undefined
        ? { totalDeadlineMs: options.seedanceTotalDeadlineMs }
        : {}),
      publishAsset(asset) {
        eventHub.publish('asset.created', { asset: publicAsset(asset) }, { projectId: asset.projectId })
      },
    }),
    { resourceKey: () => 'provider:video' },
  )
  worker.register(
    STORY_GENERATION_JOB_TYPE,
    createStoryGenerationJobHandler({
      stories: storyRepository,
      resolveProvider: async (job) => {
        const providerId = job.providerId?.trim()
        const configRevision = job.providerConfigRevision
        if (
          !providerId
          || typeof configRevision !== 'number'
          || !Number.isInteger(configRevision)
          || configRevision < 1
        ) {
          throw new TextProviderError(
            'PROVIDER_NOT_CONFIGURED',
            '剧本任务未绑定有效的文本 Provider 版本',
            false,
          )
        }

        let executionProfile
        try {
          executionProfile = await providerService.materializeExecutionProfile(
            providerId,
            configRevision,
          )
        } catch (error) {
          if (error instanceof ProviderConfigurationError) {
            throw new TextProviderError(
              'PROVIDER_NOT_CONFIGURED',
              '剧本任务绑定的文本 Provider 配置不可用',
              false,
            )
          }
          throw error
        }
        if (executionProfile.kind !== 'text') {
          throw new TextProviderError(
            'PROVIDER_NOT_CONFIGURED',
            '剧本任务绑定的 Provider 不是文本服务',
            false,
          )
        }
        if (
          executionProfile.adapter !== 'codex-tools'
          && executionProfile.adapter !== 'openai-compatible'
        ) {
          throw new TextProviderError(
            'PROVIDER_NOT_CONFIGURED',
            '该文本 Provider Adapter 尚未接入',
            false,
          )
        }
        if (
          !executionProfile.baseUrl?.trim()
          || !executionProfile.model?.trim()
          || job.model !== executionProfile.model
        ) {
          throw new TextProviderError(
            'PROVIDER_NOT_CONFIGURED',
            '剧本任务绑定的文本 Provider 配置不完整',
            false,
          )
        }
        return new OpenAICompatibleTextProvider({
          name: executionProfile.providerId,
          baseUrl: executionProfile.baseUrl,
          apiKey: executionProfile.apiKey,
          model: executionProfile.model,
          ...(options.textCompatibleFetch ? { fetch: options.textCompatibleFetch } : {}),
          ...(executionProfile.adapter === 'codex-tools'
            ? { protocol: 'responses' as const, reasoningEffort: 'medium' as const }
            : {}),
        })
      },
    }),
    { resourceKey: () => 'provider:text' },
  )
  worker.register<ShotVideoVisualReferenceJobInput, JsonObject>(
    SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
    createShotVideoVisualReferenceHandler({
      database,
      mediaStore,
      providerService,
      ...(options.textCompatibleFetch ? { textCompatibleFetch: options.textCompatibleFetch } : {}),
    }),
    { resourceKey: () => 'provider:text:vision' },
  )
  const characterVoiceRecommendationHandler = createCharacterVoiceRecommendationHandler({
    database,
    providerService,
    ...(options.textCompatibleFetch ? { textCompatibleFetch: options.textCompatibleFetch } : {}),
  })
  worker.register<CharacterVoiceRecommendationJobInput, JsonObject>(
    CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE,
    async (job, context) => {
      const input = parseCharacterVoiceRecommendationJobInput(job.input)
      const durable = database.getGenerationJob(job.id)
      if (!durable || !durable.providerId || durable.providerConfigRevision === null || !durable.model) {
        throw new JobExecutionError(
          'VOICE_RECOMMENDATION_PROVIDER_INVALID',
          '声线推荐任务缺少持久 Provider 绑定',
          false,
          'validation',
        )
      }
      const [catalog, providers] = await Promise.all([
        speechVoiceCatalog(input.catalog.providerId, context.signal),
        providerService.list(),
      ])
      const currentCandidates = characterVoiceRecommendationShortlist(catalog.voices.map((voice) => ({
        voiceId: voice.voiceId,
        voiceName: voice.name,
        descriptions: [...voice.descriptions],
        type: voice.type,
      })))
      const currentCandidateFingerprint = characterVoiceCatalogFingerprint(currentCandidates)
      if (catalog.providerId !== input.catalog.providerId
        || catalog.providerConfigRevision !== input.catalog.providerConfigRevision
        || catalog.model !== input.catalog.model
        || catalog.fingerprint !== input.catalog.fingerprint
        || currentCandidateFingerprint !== input.catalog.candidateFingerprint
        || !isDeepStrictEqual(currentCandidates, input.catalog.voices)) {
        throw new JobExecutionError(
          'VOICE_RECOMMENDATION_CATALOG_CHANGED',
          '音色目录或候选短名单已变化，未发起推荐；请刷新后重试',
          false,
          'validation',
        )
      }
      const currentProvider = providers.find((candidate) => candidate.id === durable.providerId)
      if (!currentProvider
        || !currentProvider.enabled
        || currentProvider.credentialState === 'missing'
        || currentProvider.health.status !== 'ok'
        || currentProvider.configRevision !== durable.providerConfigRevision
        || currentProvider.model !== durable.model) {
        throw new JobExecutionError(
          'VOICE_RECOMMENDATION_PROVIDER_CHANGED',
          '声线推荐文本 Provider 已变化，未发起推荐；请重新点击 AI 选角',
          false,
          'validation',
        )
      }
      return characterVoiceRecommendationHandler(job, context)
    },
    { resourceKey: () => 'provider:text' },
  )
  worker.register(
    LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
    createLinePerformanceRecommendationHandler({
      database,
      providerService,
      ...(options.textCompatibleFetch ? { textCompatibleFetch: options.textCompatibleFetch } : {}),
    }),
    { resourceKey: () => 'provider:text' },
  )
  worker.register(
    EXPORT_RENDER_JOB_TYPE,
    createExportRenderJobHandler({
      database,
      mediaStore,
      exports: exportRenderService,
      runtimeDirectory,
      ...(options.exportRenderer ? { renderer: options.exportRenderer } : {}),
      publishAsset(asset) {
        eventHub.publish('asset.created', { asset: publicAsset(asset) }, { projectId: asset.projectId })
      },
    }),
    { resourceKey: () => 'renderer:ffmpeg' },
  )
  worker.register(
    QUALITY_CHECK_JOB_TYPE,
    createQualityCheckJobHandler({
      database,
      mediaStore,
      qualityChecks: qualityCheckService,
      runtimeDirectory,
      ...(options.qualityAnalyzer ? { analyzer: options.qualityAnalyzer } : {}),
    }),
    { resourceKey: () => 'analyzer:ffmpeg' },
  )

  const coordinator = new PipelineRunCoordinator(
    database,
    createPipelineProductionPorts({
      database,
      stories: storyRepository,
      timelines: timelineDocumentService,
      timelineMaterialization: timelineMaterializationService,
      timelineAutoEdit: timelineAutoEditService,
      exports: exportRenderService,
      qualityChecks: qualityCheckService,
      durableJobs: jobs,
      worker,
      admitDurableJob(identity, operation) {
        return withJobAdmission(async () => {
          const existing = database.findGenerationJobByIdempotencyKey(
            identity.projectId,
            identity.idempotencyKey,
          )
          if (!existing && activeJobCount(database) >= maxQueueDepth) {
            throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，一键生产将在容量释放后继续')
          }
          return operation()
        })
      },
    }),
    {
      onError(error, context) {
        if (error instanceof HttpError && error.code === 'QUEUE_FULL') return
        const name = error instanceof Error ? error.name : typeof error
        console.error('Pipeline coordinator failure', { ...context, name })
      },
    },
  )
  pipelineRunCoordinator = coordinator

  const resolvePipelineProvider = async (
    kind: 'image' | 'speech',
    requestedProviderId?: string,
  ): Promise<PipelineProviderSelection | undefined> => {
    const providers = await providerService.list()
    const requested = requestedProviderId
      ? providers.find((candidate) => candidate.id === requestedProviderId)
      : undefined
    if (requestedProviderId && !requested) {
      throw new HttpError(404, 'PIPELINE_PROVIDER_NOT_FOUND', `Provider 不存在: ${requestedProviderId}`)
    }
    if (requested && requested.kind !== kind) {
      throw new HttpError(
        400,
        'PIPELINE_PROVIDER_KIND_MISMATCH',
        `${requestedProviderId} 不是${kind === 'image' ? '图片' : '语音'} Provider`,
      )
    }
    const executable = (candidate: (typeof providers)[number]): boolean => (
      candidate.kind === kind
      && candidate.enabled
      && candidate.credentialState !== 'missing'
      && Boolean(candidate.baseUrl.trim())
      && Boolean(candidate.model.trim())
    )
    const selected = requested ?? providers
      .filter(executable)
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))[0]
    if (!selected) return undefined
    if (!executable(selected)) {
      throw new HttpError(
        409,
        'PROVIDER_NOT_CONFIGURED',
        `${selected.label} 未启用或缺少可用凭据`,
      )
    }
    return {
      providerId: selected.id,
      configRevision: selected.configRevision,
      model: selected.model,
    }
  }

  const resolveShotVideoProvider = async (
    requestedProviderId?: string,
  ): Promise<ShotVideoProviderBinding> => {
    const providers = (await providerService.list()).filter((candidate) => candidate.kind === 'video')
    const selected = requestedProviderId
      ? providers.find((candidate) => candidate.id === requestedProviderId)
      : providers.find((candidate) => candidate.isDefault)
    if (!selected) throw new HttpError(404, 'PROVIDER_NOT_FOUND', '视频 Provider 不存在')
    if (selected.adapter !== 'seedance') {
      throw new HttpError(
        501,
        'PROVIDER_ADAPTER_NOT_IMPLEMENTED',
        '该视频 Provider Adapter 尚未接入，未创建任务或发起计费请求',
      )
    }
    if (!selected.enabled || selected.credentialState === 'missing' || !selected.model.trim()) {
      throw new HttpError(
        409,
        'PROVIDER_NOT_CONFIGURED',
        '请先在 Provider 设置中填写 Seedance 2.0 API Key，并启用视频 Provider',
      )
    }
    // A stored credential only proves that a Keychain reference exists. It
    // does not prove that the token can see the configured model (the
    // Neurasea incident reached the paid boundary with a chat-only model
    // list). Production must therefore fail before issuing a billable
    // confirmation capability unless the current immutable provider revision
    // has passed its non-billable connection/model probe. A deliberately
    // injected test provider is already the executable capability under test
    // and must not trigger an external probe.
    if (!options.seedanceProvider && selected.health.status !== 'ok') {
      const message = selected.health.status === 'untested'
        ? '请先在 Provider 设置中运行连接测试，确认当前 Key 可访问指定 Seedance 模型'
        : `Seedance Provider 连接测试未通过：${selected.health.message}`
      throw new HttpError(409, 'PROVIDER_NOT_VERIFIED', message)
    }
    return {
      providerId: selected.id,
      configRevision: selected.configRevision,
      model: selected.model,
    }
  }

  const prepareHttpPipeline = async (
    episodeId: string,
    input: PipelineHttpCreateInput,
    callerIntentFingerprint: string,
    idempotencyKeyValue: string,
  ) => {
    let discovery = discoverPipelineProduction(
      { database, timelines: timelineDocumentService },
      { projectId: input.projectId, episodeId },
    )
    if (input.speechMode === 'skip') {
      discovery = { ...discovery, voiceBlockers: [] }
    }
    const speechProviderIds = [...new Set(discovery.speechBindings.map((binding) => (
      binding.provider.providerId
    )))]
    const [imageProvider, voiceCatalogs] = await Promise.all([
      discovery.storyboardTargets.length > 0 || input.imageProviderId
        ? resolvePipelineProvider('image', input.imageProviderId)
        : Promise.resolve(undefined),
      input.speechMode === 'auto' && speechProviderIds.length > 0
        ? Promise.all(speechProviderIds.map((providerId) => speechVoiceCatalog(providerId)))
        : Promise.resolve(undefined),
    ])
    if (voiceCatalogs) discovery = validatePipelineVoiceCatalog(discovery, voiceCatalogs)
    const request = discovery.voiceBlockers.length === 0
      ? createPipelineProductionRequestFromDiscovery(
          { database, timelines: timelineDocumentService },
          {
            projectId: input.projectId,
            episodeId,
            idempotencyKey: idempotencyKeyValue,
            callerIntentFingerprint,
            options: {
              resolution: input.resolution,
              kenBurns: input.kenBurns,
              burnSubtitles: input.burnSubtitles,
              introTitle: input.introTitle,
              outroCard: input.outroCard,
              reviewWatermark: input.reviewWatermark,
              speechMode: input.speechMode,
            },
            ...(imageProvider ? { imageProvider } : {}),
          },
          discovery,
        )
      : undefined
    return { discovery, imageProvider, request }
  }

  const stalePipelinesForExternalTimelineChange = async (
    projectId: string,
    episodeId: string,
    message: string,
  ): Promise<void> => {
    const active: PipelineRunRecord[] = []
    for (const status of ['queued', 'running'] as const) {
      for (let offset = 0; ; offset += 1_000) {
        const page = database.listPipelineRuns({ projectId, episodeId, status, limit: 1_000, offset })
        active.push(...page)
        if (page.length < 1_000) break
      }
    }
    const results = await Promise.all(active.map((run) => coordinator.markStale(run.id, message)))
    for (const run of results) {
      if (run) publishPipelineRun(run)
    }
  }

  const schedulePipelineKick = (pipelineRunId: string, operation: string): void => {
    trackPipelineTask(
      coordinator.kick(pipelineRunId).then((run) => {
        if (run) publishPipelineRun(run)
      }),
      operation,
    )
  }

  const app = express()
  app.disable('x-powered-by')
  app.use(createSafeRequestLogger(
    options.requestLogSink === false ? () => undefined : options.requestLogSink,
  ))
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-site')
    next()
  })

  // This binary route must be mounted before the global JSON parser. It only
  // accepts raw bytes and server-owned identifiers; paths, URLs and caller
  // supplied Asset IDs are deliberately outside the contract.
  const audioUploadRawBody = express.raw({
    inflate: false,
    limit: mediaUploadMaxAudioBytes,
    type: () => true,
  })
  app.post(
    '/api/v1/assets/uploads/audio',
    (request, _response, next) => {
      try {
        normalizeUserAudioMimeType(request.get('content-type'))
        next()
      } catch (error) {
        next(error)
      }
    },
    audioUploadRawBody,
    asyncRoute(async (request, response) => {
      const acceptedQueryFields = new Set(['projectId', 'episodeId', 'kind', 'name'])
      for (const field of Object.keys(request.query)) {
        if (!acceptedQueryFields.has(field)) {
          throw new HttpError(
            400,
            'UNSAFE_UPLOAD_INPUT',
            '上传接口不接受客户端 Asset ID、文件路径或 URL',
          )
        }
      }
      if (!Buffer.isBuffer(request.body)) {
        throw new HttpError(400, 'INVALID_UPLOAD_BODY', '必须提供原始音频字节')
      }
      const projectId = requestIdentifier(queryString(request.query.projectId), 'projectId')
      const episodeId = requestIdentifier(queryString(request.query.episodeId), 'episodeId')
      const kind = parseUserAudioAssetKind(queryString(request.query.kind) ?? '')
      const originalFileName = normalizeUploadDisplayName(queryString(request.query.name))
      const mimeType = normalizeUserAudioMimeType(request.get('content-type'))
      const asset = await mediaUploadService.uploadAudio({
        projectId,
        episodeId,
        kind,
        bytes: request.body,
        mimeType,
        ...(originalFileName ? { originalFileName } : {}),
      })
      eventHub.publish('asset.created', { asset: publicAsset(asset) }, { projectId })
      response
        .status(201)
        .setHeader('Location', `/api/v1/assets/${encodeURIComponent(asset.id)}`)
        .json({ asset: publicAsset(asset) })
    }),
  )
  app.use(express.json({ limit: '2mb', strict: true, type: 'application/json' }))

  mountAssetLockRoutes(app, {
    database,
    onLocked(result) {
      eventHub.publish('project.updated', {
        eventType: 'asset.locked',
        assetId: result.asset.id,
        episodeId: result.asset.episodeId,
        targetType: result.target.type,
        targetId: result.target.id,
        revisionId: result.revision.id,
        idempotent: result.idempotent,
      }, { projectId: result.asset.projectId })
    },
    onCharacterReferencesLocked(result) {
      eventHub.publish('project.updated', {
        eventType: 'character.visual-references.locked',
        episodeId: result.assets.front.episodeId,
        targetType: 'character',
        targetId: result.target.id,
        revisionId: result.revision.id,
        references: { ...result.target.references },
        idempotent: result.idempotent,
      }, { projectId: result.assets.front.projectId })
    },
  })

  mountVisualAssetHistoryRoutes(app, {
    database,
    mediaStore,
    admit: withJobAdmission,
    publicAsset,
    publicJob: (job) => publicJob(job, database),
    onAdopted(result) {
      eventHub.publish('asset.created', {
        asset: publicAsset(result.asset),
      }, { projectId: result.asset.projectId })
      eventHub.publish('project.updated', {
        eventType: 'visual.asset.history.adopted',
        episodeId: result.asset.episodeId,
        targetType: result.job.input.assetEntityBinding
          && typeof result.job.input.assetEntityBinding === 'object'
          ? (result.job.input.assetEntityBinding as JsonObject).entityType ?? null
          : null,
        assetFamilyId: result.assetFamilyId,
        assetVersionId: result.assetVersionId,
        previousAssetVersionId: result.previousAssetVersionId,
        revisionId: result.revision.id,
        idempotent: result.idempotent,
      }, { projectId: result.asset.projectId })
    },
  })

  mountShotVideoHistoryRoutes(app, {
    database,
    mediaStore,
    shotMediaReviewService,
    admit: withJobAdmission,
    publicAsset,
    publicJob: (job) => publicJob(job, database),
  })

  mountAssetIdentityRoutes(app, {
    database,
    publicAsset,
    onCurrentVersionChanged(result) {
      eventHub.publish('project.updated', {
        eventType: 'asset.version.current.changed',
        assetId: result.handle.id,
        previousAssetVersionId: result.audit.previousAssetVersionId,
        assetVersionId: result.audit.selectedAssetVersionId,
        handleRevision: result.audit.handleRevision,
        changed: result.audit.changed,
        auditId: result.audit.id,
        providerCallRequired: false,
      }, { projectId: result.handle.projectId })
    },
  })

  const productionAssetManifestService = mountProductionAssetManifestRoutes(app, {
    database,
    timelines: timelineDocumentService,
  })

  app.get('/health/live', (_request, response) => {
    response.json({ status: 'ok', service: 'manju-studio-api' })
  })

  app.get('/health/ready', asyncRoute(async (_request, response) => {
    const health = database.health()
    const stats = worker.getStats()
    const [media, providerCapabilities] = await Promise.all([
      mediaStore.health(),
      providerService.list()
        .then(summarizeProviderCapabilities)
        .catch(() => unavailableProviderCapabilities()),
    ])
    const databaseReady = health.quickCheck === 'ok' && health.foreignKeys
    const workerReady = stats.started
    const ready = databaseReady && media.status === 'ok' && workerReady
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'unavailable',
      database: {
        status: databaseReady ? 'ok' : 'unavailable',
        ...health,
      },
      media,
      worker: {
        status: workerReady ? 'ok' : 'unavailable',
        ...stats,
      },
      providerCapabilities,
    })
  }))

  app.post('/api/v1/maintenance/assets/retention', asyncRoute(async (request, response) => {
      const body = request.body === undefined
        ? {}
        : requireObject(request.body, '资产保留计划请求必须是 JSON 对象')
      const unknown = Object.keys(body).filter((key) => ![
        'dryRun',
        'planFingerprint',
        'confirmationToken',
      ].includes(key))
      if (unknown.length > 0) {
        throw new HttpError(
          400,
          'INVALID_RETENTION_REQUEST',
          '资产保留计划只接受 dryRun、planFingerprint 与 confirmationToken',
        )
      }
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
        throw new HttpError(400, 'INVALID_RETENTION_REQUEST', 'dryRun 必须是布尔值')
      }
      if (body.dryRun === false) {
        if (typeof body.planFingerprint !== 'string' || typeof body.confirmationToken !== 'string') {
          throw new HttpError(
            400,
            'INVALID_RETENTION_REQUEST',
            '执行清理必须显式提交 dry-run 返回的 planFingerprint 与 confirmationToken',
          )
        }
        response.json({ result: await assetRetentionService.apply({
          planFingerprint: body.planFingerprint,
          confirmationToken: body.confirmationToken,
        }) })
        return
      }
      if (body.planFingerprint !== undefined || body.confirmationToken !== undefined) {
        throw new HttpError(
          400,
          'INVALID_RETENTION_REQUEST',
          'dry-run 不接受确认信息；请先获取新的保留计划',
        )
      }
      response.json({ plan: assetRetentionService.plan() })
  }))

  app.get('/api/health', asyncRoute(async (_request, response) => {
    // Do not use the legacy boot snapshot here. Health/model probing must see
    // a proxy login, key rotation, or logout without restarting this server.
    const healthProvider = options.provider ?? new CodexToolsImageProvider({
      baseUrl: process.env.CODEX_TOOLS_BASE_URL,
      apiKey: await loadByoaCredential('codex-tools-image'),
      model: process.env.CODEX_TOOLS_IMAGE_MODEL,
    })
    const providerHealth = await healthProvider.health()
    const workerStats = worker.getStats()
    const databaseHealth = database.health()
    response.json({
      status: databaseHealth.quickCheck === 'ok' && workerStats.started ? 'ok' : 'degraded',
      service: 'manju-studio-api',
      provider: {
        name: healthProvider.name,
        configured: healthProvider.configured,
        model: healthProvider.model,
        ...providerHealth,
      },
      queue: {
        running: workerStats.active > 0,
        pending: workerStats.pending,
      },
      database: {
        status: databaseHealth.quickCheck === 'ok' ? 'ok' : 'unavailable',
        schemaVersion: databaseHealth.schemaVersion,
      },
      worker: workerStats,
      uptimeSeconds: Math.floor(process.uptime()),
    })
  }))

  app.post('/api/v1/episodes/:episodeId/pipeline-runs/preflight', asyncRoute(async (request, response) => {
    const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
    const input = parsePipelineHttpCreateInput(request.body)
    if (Object.hasOwn(input, 'confirmationToken')) {
      throw new HttpError(
        400,
        'INVALID_PIPELINE_PREFLIGHT_REQUEST',
        '预检请求不接受 confirmationToken',
      )
    }
    const rootIdempotencyKey = idempotencyKey(request, true)
    const callerIntentFingerprint = pipelineCallerIntentFingerprint(
      episodeId,
      input,
      rootIdempotencyKey,
    )
    const prepared = await prepareHttpPipeline(
      episodeId,
      input,
      callerIntentFingerprint,
      rootIdempotencyKey,
    )
    const providers = {
      ...(prepared.imageProvider ? { image: prepared.imageProvider } : {}),
    }
    let confirmationToken: string | null = null
    let expiresAt: string | null = null
    if (prepared.discovery.voiceBlockers.length === 0) {
      const issuedAt = pipelinePreflightNow()
      if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.getTime())) {
        throw new Error('pipelinePreflightNow returned an invalid Date')
      }
      const expiresAtEpochSeconds = Math.floor(issuedAt.getTime() / 1_000)
        + PIPELINE_PREFLIGHT_TTL_SECONDS
      expiresAt = new Date(expiresAtEpochSeconds * 1_000).toISOString()
      confirmationToken = pipelinePreflightToken(
        pipelinePreflightSecret,
        callerIntentFingerprint,
        prepared.discovery,
        input.speechMode,
        providers,
        { rootIdempotencyKey, expiresAtEpochSeconds },
      )
    }
    response.json({
      preflight: pipelinePreflightAsJson(
        prepared.discovery,
        input.speechMode,
        confirmationToken,
        expiresAt,
        providers,
      ),
    })
  }))

  app.post('/api/v1/episodes/:episodeId/pipeline-runs', asyncRoute(async (request, response) => {
    const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
    const key = idempotencyKey(request, true)
    const input = parsePipelineHttpCreateInput(request.body)
    const callerIntentFingerprint = pipelineCallerIntentFingerprint(episodeId, input, key)
    const existing = database.findPipelineRunByIdempotencyKey(input.projectId, key)
    if (existing) {
      const document = parsePipelineRunDocument(existing.steps)
      if (existing.episodeId !== episodeId
        || document.callerIntentFingerprint !== callerIntentFingerprint) {
        throw new PipelineRunError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key 已用于另一个一键生产请求',
        )
      }
      publishPipelineRun(existing)
      schedulePipelineKick(existing.id, 'idempotent-replay')
      response
        .status(200)
        .setHeader('Location', `/api/v1/pipeline-runs/${encodeURIComponent(existing.id)}`)
        .json({ pipelineRun: pipelineRunAsJson(existing) })
      return
    }
    const prepared = await prepareHttpPipeline(
      episodeId,
      input,
      callerIntentFingerprint,
      key,
    )
    const providers = {
      ...(prepared.imageProvider ? { image: prepared.imageProvider } : {}),
    }
    if (prepared.discovery.voiceBlockers.length > 0 || !prepared.request) {
      throw new HttpError(
        409,
        'CHARACTER_VOICE_BLOCKED',
        '角色声线档案、真实账号音色目录或 Provider 状态已变化；未创建任何付费任务',
        { blockers: prepared.discovery.voiceBlockers } as unknown as JsonValue,
      )
    }
    const productionRequest = prepared.request
    const confirmationToken = requirePipelineConfirmationToken(input.confirmationToken)
    const confirmationNow = pipelinePreflightNow()
    if (!(confirmationNow instanceof Date) || !Number.isFinite(confirmationNow.getTime())) {
      throw new Error('pipelinePreflightNow returned an invalid Date')
    }
    const confirmation = verifyPipelinePreflightToken(
      pipelinePreflightSecret,
      callerIntentFingerprint,
      prepared.discovery,
      input.speechMode,
      providers,
      confirmationToken,
      key,
      Math.floor(confirmationNow.getTime() / 1_000),
    )
    if (confirmation === 'expired') {
      throw new HttpError(
        409,
        'PIPELINE_PREFLIGHT_EXPIRED',
        '一键生产预检已过期，请重新核对任务范围与计费配置',
      )
    }
    if (confirmation !== 'valid') {
      throw new HttpError(
        409,
        'PIPELINE_PREFLIGHT_CHANGED',
        '可计费任务、素材就绪状态或 Provider 版本已变更，请重新预检确认',
      )
    }
    const result = await withJobAdmission(async () => {
      const raced = database.findPipelineRunByIdempotencyKey(input.projectId, key)
      const activeRuns: PipelineRunRecord[] = []
      for (const status of ['queued', 'running'] as const) {
        for (let offset = 0; ; offset += 1_000) {
          const page = database.listPipelineRuns({
            projectId: input.projectId,
            episodeId,
            status,
            limit: 1_000,
            offset,
          })
          activeRuns.push(...page)
          if (page.length < 1_000) break
        }
      }
      const duplicateActive = activeRuns.find((run) => {
        if (run.idempotencyKey === key
          || run.sourceRevisionId !== productionRequest.sourceRevisionId) return false
        try {
          return pipelineCallerConfigurationFingerprint(
            parsePipelineRunDocument(run.steps).callerIntentFingerprint,
          ) === pipelineCallerConfigurationFingerprint(callerIntentFingerprint)
        } catch {
          return false
        }
      })
      if (duplicateActive) {
        throw new HttpError(
          409,
          'PIPELINE_RUN_ALREADY_ACTIVE',
          '相同配置的一键生产任务正在运行，请直接查看已有任务',
          { pipelineRunId: duplicateActive.id },
        )
      }
      if (!raced && activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return coordinator.create(productionRequest)
    })
    publishPipelineRun(result.run)
    schedulePipelineKick(result.run.id, result.created ? 'create' : 'idempotent-replay')
    response
      .status(result.created ? 202 : 200)
      .setHeader('Location', `/api/v1/pipeline-runs/${encodeURIComponent(result.run.id)}`)
      .json({ pipelineRun: pipelineRunAsJson(result.run) })
  }))

  app.get('/api/v1/pipeline-runs/:id', (request, response, next) => {
    try {
      const id = requestIdentifier(routeParam(request.params.id), 'pipelineRunId')
      const run = database.getPipelineRun(id)
      if (!run) throw new HttpError(404, 'PIPELINE_RUN_NOT_FOUND', '一键生产任务不存在')
      try {
        response.json({ pipelineRun: pipelineRunAsJson(run) })
      } catch (error) {
        if (error instanceof PipelineRunError) {
          throw new HttpError(
            410,
            'PIPELINE_RUN_LEGACY_UNREADABLE',
            '该任务来自旧版本且缺少可恢复的固化生产文档',
          )
        }
        throw error
      }
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/v1/pipeline-runs', (request, response, next) => {
    try {
      const allowed = new Set(['projectId', 'episodeId', 'limit'])
      const unknown = Object.keys(request.query).filter((key) => !allowed.has(key))
      if (unknown.length > 0) {
        throw new HttpError(400, 'INVALID_PIPELINE_QUERY', `不支持的查询参数: ${unknown.join(', ')}`)
      }
      const projectId = requestIdentifier(queryString(request.query.projectId), 'projectId')
      const episodeId = requestIdentifier(queryString(request.query.episodeId), 'episodeId')
      const episode = storyRepository.getEpisode(episodeId)
      if (!episode || episode.projectId !== projectId) {
        throw new HttpError(404, 'EPISODE_NOT_FOUND', '分集不存在或不属于当前项目')
      }
      const runs = database.listPipelineRuns({
        projectId,
        episodeId,
        limit: positiveInteger(request.query.limit, 'limit', 50),
      })
      const readable: JsonObject[] = []
      for (const run of runs) {
        try {
          readable.push(pipelineRunAsJson(run))
        } catch (error) {
          const name = error instanceof Error ? error.name : typeof error
          console.warn('Skipped unreadable legacy pipeline list row', { pipelineRunId: run.id, name })
        }
      }
      response.json({ pipelineRuns: readable })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/v1/pipeline-runs/:id/cancel', asyncRoute(async (request, response) => {
    const id = requestIdentifier(routeParam(request.params.id), 'pipelineRunId')
    const body = requireObject(request.body, '取消请求必须是 JSON 对象')
    if (Object.keys(body).length > 0) {
      throw new HttpError(400, 'INVALID_PIPELINE_REQUEST', '取消请求不接受额外参数')
    }
    const run = await coordinator.cancel(id, '用户取消了一键生产任务')
    if (!run) throw new HttpError(404, 'PIPELINE_RUN_NOT_FOUND', '一键生产任务不存在')
    publishPipelineRun(run)
    response.json({ pipelineRun: pipelineRunAsJson(run) })
  }))

  // The unversioned project snapshot was a temporary UI migration bridge. It
  // cannot safely coexist with story/timeline optimistic locking because a
  // write could replace the project's current revision without If-Match.
  app.all('/api/project', (_request, response) => {
    response.status(410).json({
      error: {
        code: 'LEGACY_API_REMOVED',
        message: '旧项目快照接口已移除，请使用 /api/v1/projects、episodes 与 timeline-document',
      },
    })
  })

  const submitImage = async (
    request: Request,
    response: Response,
    optionsForRoute: { type: 'image.generate' | 'asset.image.generate'; requireIdempotency: boolean },
  ) => {
    const body = requireObject(request.body, '图片生成请求必须是 JSON 对象')
    const projectId = optionsForRoute.type === 'asset.image.generate'
      ? (typeof body.projectId === 'string' ? body.projectId.trim() : '')
      : defaultSnapshot.project.id
    if (!projectId || !database.getProject(projectId)) {
      throw new HttpError(404, 'PROJECT_NOT_FOUND', '项目不存在')
    }
    const inputBody = body.input === undefined ? body : requireObject(body.input, 'input 必须是 JSON 对象')
    const clientReservedReferenceFields = [
      'assetId',
      'assetEntityBinding',
      'file',
      'filePath',
      'image',
      'mask',
      'path',
      'reference',
      'referenceAssetIds',
      'referenceImage',
      'referenceImages',
      'referencePath',
      'referenceUrls',
      'referencePaths',
      'referenceUrl',
      'url',
      'episodeBinding',
      'storyboardBinding',
      'storyboardReferenceDecision',
    ]
    if (clientReservedReferenceFields.some((field) => inputBody[field] !== undefined)) {
      throw new HttpError(
        400,
        'INVALID_REFERENCE_INPUT',
        '参考图必须由服务端从当前剧本锁定资产中解析，不接受客户端资产 ID、路径或 URL',
      )
    }
    const input = parseImageInput(inputBody)
    if (clientReservedReferenceFields.some((field) => input.metadata?.[field] !== undefined)) {
      throw new HttpError(
        400,
        'INVALID_REFERENCE_INPUT',
        '参考图必须由服务端从当前剧本锁定资产中解析，不接受客户端资产 ID、路径或 URL',
      )
    }
    if (input.metadata?.useLockedReferences !== undefined
      && typeof input.metadata.useLockedReferences !== 'boolean') {
      throw new HttpError(400, 'INVALID_REFERENCE_INPUT', 'metadata.useLockedReferences 必须是布尔值')
    }
    let durableInput: StoryboardImageJobInput = input
    let visualEntityBindingForAdmission: VisualAssetEntityBinding | null = null
    let episodeId = optionsForRoute.type === 'asset.image.generate' && body.episodeId !== undefined
      ? requestIdentifier(body.episodeId, 'episodeId')
      : undefined
    const requestedProviderId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
    const submissionKey = idempotencyKey(request, optionsForRoute.requireIdempotency)
    const imageIdempotencyRequest = {
      schemaVersion: 1 as const,
      episodeId: episodeId ?? null,
      requestedProviderId: requestedProviderId || null,
      input,
    }
    if (optionsForRoute.type === 'asset.image.generate') {
      const existing = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
      if (existing) {
        if (existing.type !== optionsForRoute.type
          || existing.projectId !== projectId
          || !isPlainObject(existing.input.idempotencyRequest)
          || !isDeepStrictEqual(existing.input.idempotencyRequest, imageIdempotencyRequest)) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
        }
        response.status(200).json({ job: publicJob(existing, database) })
        return
      }
    }
    if (episodeId) {
      durableInput = {
        ...durableInput,
        episodeBinding: resolveEpisodeImageBinding(database, { projectId, episodeId }),
      }
    }
    let resourceId = typeof input.metadata?.shotId === 'string'
      ? input.metadata.shotId
      : typeof input.metadata?.shotId === 'number'
        ? String(input.metadata.shotId)
        : undefined
    const assetEntitySelector = optionsForRoute.type === 'asset.image.generate'
      ? visualAssetEntitySelector(input.metadata)
      : null
    if (assetEntitySelector) {
      if (input.count !== 1) {
        throw new HttpError(400, 'INVALID_VISUAL_ASSET_COUNT', '角色、场景或道具候选一次只能生成一张')
      }
      episodeId = requestIdentifier(body.episodeId, 'episodeId')
      const assetEntityBinding = createVisualAssetEntityBinding(database, {
        projectId,
        episodeId,
        ...assetEntitySelector,
      })
      visualEntityBindingForAdmission = assetEntityBinding
      durableInput = {
        ...input,
        metadata: {
          ...input.metadata,
          entityType: assetEntityBinding.entityType,
          entityId: assetEntityBinding.entityId,
        },
        assetEntityBinding,
        episodeBinding: resolveEpisodeImageBinding(database, { projectId, episodeId }),
      }
      resourceId = `${assetEntityBinding.entityType}:${assetEntityBinding.entityId}`
    }
    if (optionsForRoute.type === 'asset.image.generate'
      && input.metadata?.kind === STORYBOARD_IMAGE_KIND) {
      if (input.count !== 1) {
        throw new HttpError(400, 'INVALID_STORYBOARD_COUNT', '分镜图片一次只能生成一张')
      }
      episodeId = requestIdentifier(body.episodeId, 'episodeId')
      const shotId = requestIdentifier(input.metadata.shotId, 'metadata.shotId')
      const sceneId = input.metadata.sceneId === undefined
        ? undefined
        : requestIdentifier(input.metadata.sceneId, 'metadata.sceneId')
      const target = resolvePublicStoryboardShot(database, {
        projectId,
        episodeId,
        shotId,
        ...(sceneId ? { sceneId } : {}),
      })
      const storyboardReferenceDecision = createStoryboardReferenceDecision(database, target, {
        useLockedReferences: input.metadata?.useLockedReferences !== false,
      })
      durableInput = {
        ...input,
        storyboardBinding: createStoryboardImageBinding(target),
        episodeBinding: resolveEpisodeImageBinding(database, { projectId, episodeId }),
        storyboardReferenceDecision,
        referenceAssetIds: storyboardReferenceDecision.referenceAssetIds,
      }
      // Keep the API-visible job resource on the public Story ID. The
      // separately persisted server binding carries the database row ID used
      // for the transactional link.
      resourceId = target.publicShotId
    }
    if (optionsForRoute.type === 'asset.image.generate') {
      durableInput = {
        ...durableInput,
        idempotencyRequest: imageIdempotencyRequest,
      }
    }
    const imageProviders = (await providerService.list()).filter((candidate) => candidate.kind === 'image')
    const selectedProvider = requestedProviderId
      ? imageProviders.find((candidate) => candidate.id === requestedProviderId)
      : imageProviders.find((candidate) => candidate.isDefault)
    if (!selectedProvider) throw new HttpError(404, 'PROVIDER_NOT_FOUND', '图片 Provider 不存在')
    if (!selectedProvider.enabled || selectedProvider.credentialState === 'missing' || !selectedProvider.model) {
      throw new HttpError(409, 'PROVIDER_NOT_CONFIGURED', '请先在 Provider 设置中配置并启用图片 Provider')
    }
    if (optionsForRoute.type === 'asset.image.generate') {
      requirePaidAigcConfirmation(request, {
        action: 'asset.image.generate',
        projectId,
        episodeId: episodeId ?? null,
        resourceId: resourceId ?? episodeId ?? projectId,
        idempotencyKey: submissionKey,
        provider: {
          providerId: selectedProvider.id,
          model: selectedProvider.model,
          configRevision: selectedProvider.configRevision,
        },
        input: durableInput as unknown as JsonValue,
      }, input.metadata?.kind === STORYBOARD_IMAGE_KIND ? '生成当前分镜图' : '生成视觉资产图片')
    }
    const result = await withJobAdmission(async () => {
      const existing = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
      if (existing) {
        if (optionsForRoute.type === 'asset.image.generate'
          && (existing.type !== optionsForRoute.type
            || !isPlainObject(existing.input.idempotencyRequest)
            || !isDeepStrictEqual(existing.input.idempotencyRequest, imageIdempotencyRequest))) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
        }
        return { job: existing, created: false }
      }
      const currentProviders = (await providerService.list()).filter((candidate) => candidate.kind === 'image')
      const currentProvider = requestedProviderId
        ? currentProviders.find((candidate) => candidate.id === requestedProviderId)
        : currentProviders.find((candidate) => candidate.isDefault)
      if (!currentProvider
        || !currentProvider.enabled
        || currentProvider.credentialState === 'missing'
        || !currentProvider.model) {
        throw new HttpError(409, 'PROVIDER_CONFIGURATION_CHANGED', '图片 Provider 已变化或不可用，未创建任务；请重新预检')
      }
      if (currentProvider.id !== selectedProvider.id
        || currentProvider.model !== selectedProvider.model
        || currentProvider.configRevision !== selectedProvider.configRevision) {
        requirePaidAigcConfirmation(request, {
          action: 'asset.image.generate',
          projectId,
          episodeId: episodeId ?? null,
          resourceId: resourceId ?? episodeId ?? projectId,
          idempotencyKey: submissionKey,
          provider: {
            providerId: currentProvider.id,
            model: currentProvider.model,
            configRevision: currentProvider.configRevision,
          },
          input: durableInput as unknown as JsonValue,
        }, input.metadata?.kind === STORYBOARD_IMAGE_KIND ? '生成当前分镜图' : '生成视觉资产图片')
        throw new HttpError(409, 'PROVIDER_CONFIGURATION_CHANGED', '图片 Provider 已变化，未创建任务')
      }
      const requireCurrentImageConfirmation = (currentInput: StoryboardImageJobInput): void => {
        requirePaidAigcConfirmation(request, {
          action: 'asset.image.generate',
          projectId,
          episodeId: episodeId ?? null,
          resourceId: resourceId ?? episodeId ?? projectId,
          idempotencyKey: submissionKey,
          provider: {
            providerId: currentProvider.id,
            model: currentProvider.model,
            configRevision: currentProvider.configRevision,
          },
          input: currentInput as unknown as JsonValue,
        }, input.metadata?.kind === STORYBOARD_IMAGE_KIND ? '生成当前分镜图' : '生成视觉资产图片')
      }
      if (episodeId && durableInput.episodeBinding) {
        const currentEpisodeBinding = resolveEpisodeImageBinding(database, { projectId, episodeId })
        if (!isDeepStrictEqual(currentEpisodeBinding, durableInput.episodeBinding)) {
          requireCurrentImageConfirmation({
            ...durableInput,
            episodeBinding: currentEpisodeBinding,
          })
          throw new HttpError(409, 'STALE_SOURCE', '分集剧本、风格或画幅已变化，未创建图片任务')
        }
      }
      if (visualEntityBindingForAdmission) {
        const currentEntityBinding = createVisualAssetEntityBinding(database, {
          projectId,
          episodeId: visualEntityBindingForAdmission.episodeId,
          entityType: visualEntityBindingForAdmission.entityType,
          entityId: visualEntityBindingForAdmission.entityId,
        })
        if (!isDeepStrictEqual(currentEntityBinding, visualEntityBindingForAdmission)) {
          requireCurrentImageConfirmation({
            ...durableInput,
            assetEntityBinding: currentEntityBinding,
          })
          throw new HttpError(409, 'STALE_SOURCE', '角色、场景或道具已变化，未创建图片任务')
        }
        assertNoActiveVisualAssetGenerationConflict(
          database,
          projectId,
          visualEntityBindingForAdmission,
        )
      }
      if (durableInput.storyboardBinding) {
        const currentTarget = resolvePublicStoryboardShot(database, {
          projectId,
          episodeId: durableInput.storyboardBinding.episodeId,
          shotId: durableInput.storyboardBinding.shotId,
          ...(durableInput.storyboardBinding.sceneId
            ? { sceneId: durableInput.storyboardBinding.sceneId }
            : {}),
        })
        const currentBinding = createStoryboardImageBinding(currentTarget)
        const currentDecision = createStoryboardReferenceDecision(database, currentTarget, {
          useLockedReferences: input.metadata?.useLockedReferences !== false,
        })
        if (!isDeepStrictEqual(currentBinding, durableInput.storyboardBinding)
          || !isDeepStrictEqual(currentDecision, durableInput.storyboardReferenceDecision)
          || !isDeepStrictEqual(currentDecision.referenceAssetIds, durableInput.referenceAssetIds)) {
          requireCurrentImageConfirmation({
            ...durableInput,
            storyboardBinding: currentBinding,
            storyboardReferenceDecision: currentDecision,
            referenceAssetIds: currentDecision.referenceAssetIds,
          })
          throw new HttpError(409, 'STALE_SOURCE', '镜头或参考图已变化，未创建图片任务')
        }
      }
      if (activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return worker.submit({
        type: optionsForRoute.type,
        input: durableInput,
        idempotencyKey: submissionKey,
        resourceKey: 'provider:image',
        projectId,
        providerId: selectedProvider.id,
        model: selectedProvider.model,
        providerConfigRevision: selectedProvider.configRevision,
        metadata: {
          episodeId,
          resourceId,
        },
      })
    })
    const durable = database.getGenerationJob(result.job.id)
    if (!durable) throw new Error('Created image job disappeared')
    response.status(result.created ? 202 : 200).json({
      job: optionsForRoute.type === 'image.generate' ? legacyJob(durable) : publicJob(durable, database),
    })
  }
  app.post('/api/images/generate', asyncRoute(async (request, response) => {
    if (paidAigcConfirmationGate) {
      response.status(410).json({
        error: {
          code: 'LEGACY_API_REMOVED',
          message: '旧图片生成接口不具备计费确认契约；请使用 /api/v1/assets/image-generations',
        },
      })
      return
    }
    await submitImage(request, response, { type: 'image.generate', requireIdempotency: false })
  }))
  app.post('/api/v1/assets/image-generations', asyncRoute(async (request, response) => {
    await submitImage(request, response, { type: 'asset.image.generate', requireIdempotency: true })
  }))
  app.post('/api/v1/assets/:assetId/edits', asyncRoute(async (request, response) => {
    const body = requireObject(request.body, '图片编辑请求必须是 JSON 对象')
    const allowed = new Set([
      'projectId',
      'mode',
      'prompt',
      'providerId',
      'referenceAssetIds',
      'size',
      'quality',
    ])
    const unknown = Object.keys(body).filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_ASSET_EDIT_REQUEST', `不支持的图片编辑参数: ${unknown.join(', ')}`)
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const sourceAssetId = requestIdentifier(routeParam(request.params.assetId), 'assetId')
    const mode = body.mode
    if (mode !== 'edit' && mode !== 'variation') {
      throw new HttpError(400, 'INVALID_ASSET_EDIT_MODE', 'mode 必须是 edit 或 variation')
    }
    const imageInput = parseImageInput({
      prompt: body.prompt,
      count: 1,
      ...(body.size !== undefined ? { size: body.size } : {}),
      ...(body.quality !== undefined ? { quality: body.quality } : {}),
    })
    const rawReferenceIds = body.referenceAssetIds ?? []
    if (!Array.isArray(rawReferenceIds)) {
      throw new HttpError(400, 'INVALID_REFERENCE_ASSET', 'referenceAssetIds 必须是资产 ID 数组')
    }
    const referenceAssetIds = rawReferenceIds.map((value, index) => (
      requestIdentifier(value, `referenceAssetIds[${index}]`)
    ))
    const requestedProviderId = body.providerId === undefined
      ? undefined
      : requestIdentifier(body.providerId, 'providerId')
    const sourceIfMatch = request.get('if-match')?.trim()
    if (!sourceIfMatch) {
      throw new HttpError(428, 'PRECONDITION_REQUIRED', '必须提供源资产 If-Match')
    }
    if (!/^"asset-v[1-9]\d*-[a-f0-9]{64}"$/.test(sourceIfMatch)) {
      throw new HttpError(400, 'INVALID_ASSET_ETAG', '源资产 If-Match 格式无效')
    }
    const submissionKey = idempotencyKey(request, true)
    const replayRequest = {
      projectId,
      sourceAssetId,
      sourceIfMatch,
      mode,
      prompt: imageInput.prompt,
      size: imageInput.size,
      quality: imageInput.quality,
      referenceAssetIds,
      ...(requestedProviderId ? { requestedProviderId } : {}),
    } as const
    const prior = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
    if (prior) {
      if (!sameAssetImageEditReplay(prior, replayRequest)) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
      }
      response.status(200).json({ job: publicJob(prior, database) })
      return
    }

    const binding = prepareAssetImageEdit(database, {
      projectId,
      sourceAssetId,
      sourceIfMatch,
      mode,
      referenceAssetIds,
    })
    const imageProviders = (await providerService.list()).filter((candidate) => candidate.kind === 'image')
    const selected = assertAssetImageEditProviderCapability(
      requestedProviderId
        ? imageProviders.find((candidate) => candidate.id === requestedProviderId)
        : imageProviders.find((candidate) => candidate.isDefault),
      mode,
    )
    const durableInput: AssetImageEditJobInput = {
      ...imageInput,
      operation: ASSET_IMAGE_EDIT_JOB_TYPE,
      sourceAssetId,
      metadata: {
        kind: binding.source.kind,
        ...(binding.assetEntityBinding ? {
          entityType: binding.assetEntityBinding.entityType,
          entityId: binding.assetEntityBinding.entityId,
        } : {}),
      },
      editBinding: binding,
      ...(binding.assetEntityBinding ? { assetEntityBinding: binding.assetEntityBinding } : {}),
    }
    const providerBinding = {
      providerId: selected.id,
      model: selected.model,
      configRevision: selected.configRevision,
    }
    requirePaidAigcConfirmation(request, {
      action: 'asset.image.edit',
      projectId,
      episodeId: binding.source.episodeId ?? null,
      resourceId: sourceAssetId,
      idempotencyKey: submissionKey,
      provider: providerBinding,
      input: {
        request: replayRequest as unknown as JsonValue,
        durableInput: durableInput as unknown as JsonValue,
      },
    }, mode === 'variation' ? '生成当前图片变体' : '编辑当前图片')
    const result = await withJobAdmission(async () => {
      const raced = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
      if (raced) {
        if (!sameAssetImageEditSubmission(raced, durableInput, providerBinding)) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
        }
        return { job: raced, created: false }
      }
      const currentImageProviders = (await providerService.list())
        .filter((candidate) => candidate.kind === 'image')
      const currentSelected = assertAssetImageEditProviderCapability(
        requestedProviderId
          ? currentImageProviders.find((candidate) => candidate.id === requestedProviderId)
          : currentImageProviders.find((candidate) => candidate.isDefault),
        mode,
      )
      const currentBinding = prepareAssetImageEdit(database, {
        projectId,
        sourceAssetId,
        sourceIfMatch,
        mode,
        referenceAssetIds,
      })
      if (currentSelected.id !== providerBinding.providerId
        || currentSelected.model !== providerBinding.model
        || currentSelected.configRevision !== providerBinding.configRevision
        || !isDeepStrictEqual(currentBinding, binding)) {
        const currentDurableInput: AssetImageEditJobInput = {
          ...durableInput,
          editBinding: currentBinding,
          ...(currentBinding.assetEntityBinding
            ? { assetEntityBinding: currentBinding.assetEntityBinding }
            : {}),
        }
        requirePaidAigcConfirmation(request, {
          action: 'asset.image.edit',
          projectId,
          episodeId: currentBinding.source.episodeId ?? null,
          resourceId: sourceAssetId,
          idempotencyKey: submissionKey,
          provider: {
            providerId: currentSelected.id,
            model: currentSelected.model,
            configRevision: currentSelected.configRevision,
          },
          input: {
            request: replayRequest as unknown as JsonValue,
            durableInput: currentDurableInput as unknown as JsonValue,
          },
        }, mode === 'variation' ? '生成当前图片变体' : '编辑当前图片')
        throw new HttpError(409, 'STALE_SOURCE', '源图片、参考图或 Provider 已变化，未创建任务')
      }
      assertNoActiveAssetImageEditConflict(database, binding)
      if (activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return worker.submit({
        type: ASSET_IMAGE_EDIT_JOB_TYPE,
        input: durableInput,
        idempotencyKey: submissionKey,
        resourceKey: 'provider:image',
        projectId,
        providerId: selected.id,
        model: selected.model,
        providerConfigRevision: selected.configRevision,
        metadata: {
          episodeId: binding.source.episodeId ?? undefined,
          resourceId: sourceAssetId,
        },
      })
    })
    const durable = database.getGenerationJob(result.job.id)
    if (!durable) throw new Error('Created image edit job disappeared')
    response.status(result.created ? 202 : 200).json({ job: publicJob(durable, database) })
  }))
  app.post('/api/v1/assets/:sourceAssetId/derivations/turnaround', asyncRoute(async (request, response) => {
    const body = requireObject(request.body, '三视图派生请求必须是 JSON 对象')
    const unknown = Object.keys(body).filter((key) => key !== 'projectId' && key !== 'crops')
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_TURNAROUND_REQUEST', `不支持的三视图派生参数: ${unknown.join(', ')}`)
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const sourceAssetId = requestIdentifier(routeParam(request.params.sourceAssetId), 'sourceAssetId')
    const sourceIfMatch = request.get('if-match')?.trim()
    if (!sourceIfMatch) {
      throw new HttpError(428, 'PRECONDITION_REQUIRED', '必须提供源资产 If-Match')
    }
    if (!/^"asset-v[1-9]\d*-[a-f0-9]{64}"$/.test(sourceIfMatch)) {
      throw new HttpError(400, 'INVALID_ASSET_ETAG', '源资产 If-Match 格式无效')
    }
    const prepared = prepareTurnaroundDerivation(database, {
      projectId,
      sourceAssetId,
      sourceIfMatch,
      crops: body.crops as unknown as readonly NormalizedTurnaroundCrop[],
    })
    const submissionKey = idempotencyKey(request, true)
    const result = await withJobAdmission(async () => {
      const existing = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
      if (existing) {
        if (!sameTurnaroundSubmission(existing, prepared.input)) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
        }
        return { job: existing, created: false }
      }
      if (activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return worker.submit({
        type: TURNAROUND_DERIVATION_JOB_TYPE,
        input: prepared.input,
        idempotencyKey: submissionKey,
        resourceKey: 'renderer:ffmpeg',
        projectId,
        metadata: {
          episodeId: prepared.input.source.episodeId,
          resourceId: sourceAssetId,
        },
      })
    })
    const durable = database.getGenerationJob(result.job.id)
    if (!durable) throw new Error('Created turnaround derivation job disappeared')
    response.status(result.created ? 202 : 200).json({ job: publicJob(durable, database) })
  }))

  app.get('/api/v1/dialogue-lines/:lineId/performance-profile', asyncRoute(async (request, response) => {
    const lineId = requestIdentifier(routeParam(request.params.lineId), 'lineId')
    const unknown = Object.keys(request.query).filter((key) => key !== 'projectId' && key !== 'episodeId')
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `不支持的逐句表演查询参数: ${unknown.join(', ')}`)
    }
    const projectId = requestIdentifier(queryString(request.query.projectId), 'projectId')
    const episodeId = requestIdentifier(queryString(request.query.episodeId), 'episodeId')
    const state = linePerformanceProfiles.getState(projectId, episodeId, lineId)
    response.setHeader('ETag', state.etag)
    response.json({ profile: state.profile ? { ...state.profile } : null })
  }))

  app.post('/api/v1/dialogue-lines/:lineId/performance-recommendations', asyncRoute(async (request, response) => {
    const lineId = requestIdentifier(routeParam(request.params.lineId), 'lineId')
    const body = requireObject(request.body, 'AI 导演请求必须是 JSON 对象')
    const unknown = Object.keys(body).filter((key) => (
      key !== 'projectId' && key !== 'episodeId' && key !== 'textProviderId'
    ))
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `不支持的 AI 导演参数: ${unknown.join(', ')}`)
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const episodeId = requestIdentifier(body.episodeId, 'episodeId')
    const requestedTextProviderId = body.textProviderId === undefined
      ? undefined
      : requestIdentifier(body.textProviderId, 'textProviderId')
    // All prompt material is resolved here. The client cannot submit text,
    // roles, scenes, delivery values or executable Speech 2.8 markup.
    const input = resolveLinePerformanceRecommendationContext(
      database,
      { projectId, episodeId, lineId },
    )
    const submissionKey = idempotencyKey(request, true)
    const existing = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
    if (existing) {
      if (!sameLinePerformanceRecommendationSubmission(existing, input)
        || (requestedTextProviderId !== undefined && existing.providerId !== requestedTextProviderId)) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
      }
      response.status(200).json({ job: publicJob(existing, database) })
      return
    }
    const textProviders = (await providerService.list()).filter((candidate) => candidate.kind === 'text')
    const selected = requestedTextProviderId
      ? textProviders.find((candidate) => candidate.id === requestedTextProviderId)
      : textProviders.find((candidate) => candidate.isDefault)
    if (!selected) throw new HttpError(404, 'PROVIDER_NOT_FOUND', '文本 Provider 不存在')
    if (!selected.enabled
      || selected.credentialState === 'missing'
      || !selected.model.trim()
      || selected.health.status !== 'ok') {
      throw new HttpError(
        409,
        'PROVIDER_NOT_VERIFIED',
        '请先配置并测试默认文本 Provider，再使用 AI 导演',
      )
    }
    const result = await withJobAdmission(async () => {
      const raced = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
      if (raced) {
        if (!sameLinePerformanceRecommendationSubmission(raced, input)
          || (requestedTextProviderId !== undefined && raced.providerId !== requestedTextProviderId)) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
        }
        return { job: raced, created: false }
      }
      const current = resolveLinePerformanceRecommendationContext(
        database,
        { projectId, episodeId, lineId },
      )
      if (!isDeepStrictEqual(current, input)) {
        throw new HttpError(409, 'STALE_SOURCE', '台词、场景或声线已变化，未创建推荐任务')
      }
      const currentProvider = (await providerService.list()).find((candidate) => (
        candidate.kind === 'text' && candidate.id === selected.id
      ))
      if (!currentProvider
        || !currentProvider.enabled
        || currentProvider.credentialState === 'missing'
        || currentProvider.health.status !== 'ok'
        || currentProvider.model !== selected.model
        || currentProvider.configRevision !== selected.configRevision) {
        throw new HttpError(
          409,
          'PROVIDER_NOT_VERIFIED',
          '文本 Provider 已变化，未创建推荐任务；请重新点击 AI 导演',
        )
      }
      const activeDuplicate = ACTIVE_JOB_STATUSES.some((status) => (
        database.listGenerationJobs({
          projectId,
          episodeId,
          type: LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
          status,
          limit: 1_000,
        }).some((job) => job.resourceId === input.databaseLineId)
      ))
      if (activeDuplicate) {
        throw new HttpError(
          409,
          'ACTIVE_GENERATION_CONFLICT',
          '该台词已有进行中的 AI 导演任务，请等待完成或取消后再试',
        )
      }
      if (activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return worker.submit({
        type: LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE,
        input,
        idempotencyKey: submissionKey,
        resourceKey: 'provider:text',
        projectId,
        providerId: selected.id,
        model: selected.model,
        providerConfigRevision: selected.configRevision,
        metadata: { episodeId, resourceId: input.databaseLineId },
      })
    })
    const durable = database.getGenerationJob(result.job.id)
    if (!durable) throw new Error('Created AI director job disappeared')
    response.status(result.created ? 202 : 200).json({ job: publicJob(durable, database) })
  }))

  app.put('/api/v1/dialogue-lines/:lineId/performance-profile', asyncRoute(async (request, response) => {
    const lineId = requestIdentifier(routeParam(request.params.lineId), 'lineId')
    const body = requireObject(request.body, '采用 AI 表演建议请求必须是 JSON 对象')
    const allowed = new Set(['projectId', 'episodeId', 'recommendationJobId'])
    const unknown = Object.keys(body).filter((key) => !allowed.has(key))
    if (unknown.length > 0 || Object.keys(body).length !== allowed.size) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        '确认接口只接受 projectId、episodeId 与 recommendationJobId，不接受客户端表演参数',
      )
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const episodeId = requestIdentifier(body.episodeId, 'episodeId')
    const recommendationJobId = requestIdentifier(body.recommendationJobId, 'recommendationJobId')
    const expectedEtag = requiredLinePerformanceIfMatch(request)
    const job = database.getGenerationJob(recommendationJobId)
    if (!job
      || job.type !== LINE_PERFORMANCE_RECOMMENDATION_JOB_TYPE
      || job.projectId !== projectId
      || job.episodeId !== episodeId
      || job.status !== 'succeeded') {
      throw new HttpError(
        409,
        'LINE_PERFORMANCE_RECOMMENDATION_NOT_ADOPTABLE',
        'AI 表演建议不存在、未完成、已取消或不属于当前项目',
      )
    }
    const jobInput = parseLinePerformanceRecommendationJobInput(job.input)
    if (jobInput.lineId !== lineId
      || job.resourceId !== jobInput.databaseLineId
      || !isPlainObject(job.output)
      || job.output.lineId !== lineId
      || !isPlainObject(job.output.recommendation)) {
      throw new HttpError(
        409,
        'LINE_PERFORMANCE_RECOMMENDATION_NOT_ADOPTABLE',
        'AI 表演建议与当前台词绑定不一致',
      )
    }
    const current = resolveLinePerformanceRecommendationContext(
      database,
      { projectId, episodeId, lineId },
    )
    if (!isDeepStrictEqual(current, jobInput)) {
      throw new HttpError(409, 'STALE_SOURCE', '台词、上下文或声线已变化，请重新导演')
    }
    const recommendation = parseLinePerformanceRecommendation(
      job.output.recommendation,
      lineId,
      current.originalText,
    )
    const saved = linePerformanceProfiles.save({
      projectId,
      episodeId,
      lineId,
      databaseLineId: current.databaseLineId,
      expectedSourceRevisionId: current.sourceRevisionId,
      expectedEtag,
      voiceProfileRevisionId: current.performer.voiceProfileRevisionId,
      recommendationJobId,
      recommendation,
    })
    await Promise.all(saved.stale.activeJobIds.map((jobId) => worker.cancel(
      jobId,
      '逐句表演指令已修改，已停止旧语音任务；若上游请求已提交，仍可能产生费用',
    )))
    const { activeJobIds: _activeJobIds, ...publicStale } = saved.stale
    response.setHeader('ETag', saved.etag)
    response.json({ profile: { ...saved.profile }, stale: publicStale })
  }))

  app.delete('/api/v1/dialogue-lines/:lineId/performance-profile', asyncRoute(async (request, response) => {
    const lineId = requestIdentifier(routeParam(request.params.lineId), 'lineId')
    const body = requireObject(request.body, '清除逐句表演请求必须是 JSON 对象')
    const allowed = new Set(['projectId', 'episodeId'])
    const unknown = Object.keys(body).filter((key) => !allowed.has(key))
    if (unknown.length > 0 || Object.keys(body).length !== allowed.size) {
      throw new HttpError(400, 'INVALID_REQUEST', '清除接口只接受 projectId 与 episodeId')
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const episodeId = requestIdentifier(body.episodeId, 'episodeId')
    const expectedEtag = requiredLinePerformanceIfMatch(request)
    const cleared = linePerformanceProfiles.clear({ projectId, episodeId, lineId, expectedEtag })
    await Promise.all(cleared.stale.activeJobIds.map((jobId) => worker.cancel(
      jobId,
      '逐句表演指令已清除，已停止旧语音任务；若上游请求已提交，仍可能产生费用',
    )))
    const { activeJobIds: _activeJobIds, ...publicStale } = cleared.stale
    response.setHeader('ETag', cleared.etag)
    response.json({
      profile: null,
      ...(cleared.revision ? { revisionId: cleared.revision.id } : {}),
      stale: publicStale,
    })
  }))

  app.post('/api/v1/dialogue-lines/:lineId/speech-generations', asyncRoute(async (request, response) => {
    const lineId = requestIdentifier(routeParam(request.params.lineId), 'lineId')
    const body = requireObject(request.body, '语音生成请求必须是 JSON 对象')
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const episodeId = requestIdentifier(body.episodeId, 'episodeId')
    const target = resolvePublicDialogueLine(database, { projectId, episodeId, lineId })
    const usesInheritedVoice = body.voiceId === undefined
    const narratorState = target.kind === 'narration'
      ? projectNarratorVoiceProfiles.get(projectId)
      : undefined
    const inherited = target.kind === 'narration'
      ? inheritedNarratorVoiceBinding(target, narratorState!)
      : inheritedDialogueVoiceBinding(target)
    if (usesInheritedVoice && target.kind === 'narration' && !inherited) {
      throw new HttpError(
        409,
        'PROJECT_NARRATOR_VOICE_REQUIRED',
        '请先在项目设置中配置旁白声线；系统不会借用角色或全局默认音色',
      )
    }
    const requestedProviderId = body.providerId === undefined
      ? undefined
      : requestIdentifier(body.providerId, 'providerId')
    if (usesInheritedVoice && requestedProviderId && requestedProviderId !== inherited?.providerId) {
      throw new HttpError(
        400,
        'INCOMPLETE_SPEECH_OVERRIDE',
        '临时切换 Provider 时必须同时指定本句 voiceId；否则将继承当前声线绑定',
      )
    }
    const performanceProfile = linePerformanceProfiles.get(projectId, episodeId, lineId)
    const usesConfirmedPerformance = Boolean(performanceProfile)
      && usesInheritedVoice
      && body.speed === undefined
      && body.pitch === undefined
      && body.emotion === undefined
    const inheritedSettings = inherited
      ? {
          ...inherited.settings,
          ...(usesConfirmedPerformance && performanceProfile
            ? {
                speed: performanceProfile.speed,
                pitch: performanceProfile.pitch,
                emotion: performanceProfile.emotion,
              }
            : {}),
        }
      : undefined
    const settings = parseDialogueSpeechSettings(body, inheritedSettings)
    const compiledText = usesConfirmedPerformance && performanceProfile
      ? compileLinePerformance(target.text, performanceProfile)
      : undefined
    const submissionKey = idempotencyKey(request, true)
    const input: DialogueSpeechJobInput = {
      episodeId,
      lineId,
      databaseLineId: target.databaseLineId,
      expectedRevisionId: target.sourceRevisionId,
      ...(usesInheritedVoice && inherited
        ? target.kind === 'narration'
          ? { inheritedNarratorVoiceProfileRevisionId: inherited.voiceProfileRevisionId }
          : { inheritedVoiceProfileRevisionId: inherited.voiceProfileRevisionId }
        : {}),
      ...(usesConfirmedPerformance && performanceProfile && compiledText
        ? {
            inheritedPerformanceRevisionId: performanceProfile.revisionId,
            compiledText,
          }
        : {}),
      ...settings,
    }
    const assertIdempotentMatch = (existing: GenerationJobRecord) => {
      if (
        !sameSpeechSubmission(existing, input)
        || (requestedProviderId !== undefined && existing.providerId !== requestedProviderId)
      ) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
      }
    }
    const existing = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
    if (existing) {
      assertIdempotentMatch(existing)
      response.status(200).json({ job: publicJob(existing, database) })
      return
    }

    let selectedProvider: {
      id: string
      adapter: 'minimax' | 'openai-compatible' | 'indextts' | 'doubao-speech'
      model: string
      configRevision: number
    }
    if (usesInheritedVoice && inherited) {
      const current = (await providerService.list()).find((candidate) => candidate.id === inherited.providerId)
      if (!current || !current.enabled || current.credentialState === 'missing') {
        throw new HttpError(
          409,
          'CHARACTER_VOICE_PROVIDER_DISABLED',
          '语音 Provider 已禁用或凭据不可用；未创建付费任务',
        )
      }
      if (current.configRevision !== inherited.providerConfigRevision && !inherited.historicalPin) {
        throw new HttpError(
          409,
          'CHARACTER_VOICE_RESELECTION_REQUIRED',
          '语音 Provider 配置已变化，请刷新音色目录并重新确认声线',
        )
      }
      const version = database.getProviderConnectionVersion(
        inherited.providerId,
        inherited.providerConfigRevision,
      )
      if (!version
        || version.kind !== 'speech'
        || (version.adapter !== 'minimax'
          && version.adapter !== 'indextts'
          && version.adapter !== 'doubao-speech')
        || !version.baseUrl?.trim()
        || !version.model?.trim()
        || (version.authMode === 'byok' && !version.credentialReference)) {
        throw new HttpError(
          409,
          'CHARACTER_VOICE_PROVIDER_UNAVAILABLE',
          '声线绑定的历史语音 Provider 配置不可用，请重新选择声线',
        )
      }
      selectedProvider = {
        id: inherited.providerId,
        adapter: version.adapter,
        model: version.model,
        configRevision: inherited.providerConfigRevision,
      }
      const inheritedProfile = target.kind === 'narration'
        ? narratorState?.profile
        : target.characterVoiceProfile
      const catalog = await speechVoiceCatalog(inherited.providerId)
      if (!inheritedProfile
        || catalog.providerId !== inheritedProfile.providerId
        || catalog.providerConfigRevision !== inheritedProfile.providerConfigRevision
        || catalog.fingerprint !== inheritedProfile.catalogFingerprint
        || !catalog.voices.some((voice) => voice.voiceId === inheritedProfile.voiceId)) {
        throw new HttpError(
          409,
          'VOICE_CATALOG_CHANGED',
          '当前音色目录或 Provider 已变化，请重新确认声线；未创建付费任务',
        )
      }
    } else {
      const speechProviders = (await providerService.list()).filter((candidate) => candidate.kind === 'speech')
      const current = requestedProviderId
        ? speechProviders.find((candidate) => candidate.id === requestedProviderId)
        : speechProviders.find((candidate) => candidate.isDefault)
      if (!current) throw new HttpError(404, 'PROVIDER_NOT_FOUND', '语音 Provider 不存在')
      if (current.adapter !== 'minimax'
        && current.adapter !== 'openai-compatible'
        && current.adapter !== 'indextts'
        && current.adapter !== 'doubao-speech') {
        throw new HttpError(
          501,
          'PROVIDER_ADAPTER_NOT_IMPLEMENTED',
          '该语音 Provider Adapter 尚未接入，未创建任务或发起计费请求',
        )
      }
      if (!current.enabled || current.credentialState === 'missing' || !current.model.trim()) {
        throw new HttpError(409, 'PROVIDER_NOT_CONFIGURED', '请先配置并启用语音 Provider')
      }
      selectedProvider = {
        id: current.id,
        adapter: current.adapter,
        model: current.model,
        configRevision: current.configRevision,
      }
    }
    if (selectedProvider.adapter === 'openai-compatible'
      && (settings.volume !== 1
        || settings.pitch !== 0
        || (settings.emotion !== undefined && settings.emotion !== 'calm'))) {
      throw new HttpError(
        400,
        'UNSUPPORTED_SPEECH_CONTROLS',
        '自定义 OpenAI-compatible Speech 仅支持 voice、speed 与 format；请在时间线中调整音量',
      )
    }
    if (selectedProvider.adapter === 'indextts'
      && (settings.volume !== 1 || settings.pitch !== 0)) {
      throw new HttpError(
        400,
        'UNSUPPORTED_SPEECH_CONTROLS',
        'IndexTTS 支持情绪与语速；音量请在时间线调整，音高暂不支持',
      )
    }
    requirePaidAigcConfirmation(request, {
      action: 'dialogue.speech.generate',
      projectId,
      episodeId,
      resourceId: target.databaseLineId,
      idempotencyKey: submissionKey,
      provider: {
        providerId: selectedProvider.id,
        model: selectedProvider.model,
        configRevision: selectedProvider.configRevision,
      },
      input: input as unknown as JsonValue,
    }, '生成逐句配音')

    const result = await withJobAdmission(async () => {
      const raced = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
      if (raced) {
        assertIdempotentMatch(raced)
        return { job: raced, created: false }
      }
      const currentTarget = resolvePublicDialogueLine(database, { projectId, episodeId, lineId })
      const currentNarratorState = currentTarget.kind === 'narration'
        ? projectNarratorVoiceProfiles.get(projectId)
        : undefined
      const currentInherited = currentTarget.kind === 'narration'
        ? inheritedNarratorVoiceBinding(currentTarget, currentNarratorState!)
        : inheritedDialogueVoiceBinding(currentTarget)
      const currentPerformanceProfile = linePerformanceProfiles.get(projectId, episodeId, lineId)
      const currentUsesConfirmedPerformance = Boolean(currentPerformanceProfile)
        && usesInheritedVoice
        && body.speed === undefined
        && body.pitch === undefined
        && body.emotion === undefined
      const currentInheritedSettings = currentInherited
        ? {
            ...currentInherited.settings,
            ...(currentUsesConfirmedPerformance && currentPerformanceProfile
              ? {
                  speed: currentPerformanceProfile.speed,
                  pitch: currentPerformanceProfile.pitch,
                  emotion: currentPerformanceProfile.emotion,
                }
              : {}),
          }
        : undefined
      const currentSettings = parseDialogueSpeechSettings(body, currentInheritedSettings)
      const currentCompiledText = currentUsesConfirmedPerformance && currentPerformanceProfile
        ? compileLinePerformance(currentTarget.text, currentPerformanceProfile)
        : undefined
      const currentInput: DialogueSpeechJobInput = {
        episodeId,
        lineId,
        databaseLineId: currentTarget.databaseLineId,
        expectedRevisionId: currentTarget.sourceRevisionId,
        ...(usesInheritedVoice && currentInherited
          ? currentTarget.kind === 'narration'
            ? { inheritedNarratorVoiceProfileRevisionId: currentInherited.voiceProfileRevisionId }
            : { inheritedVoiceProfileRevisionId: currentInherited.voiceProfileRevisionId }
          : {}),
        ...(currentUsesConfirmedPerformance && currentPerformanceProfile && currentCompiledText
          ? {
              inheritedPerformanceRevisionId: currentPerformanceProfile.revisionId,
              compiledText: currentCompiledText,
            }
          : {}),
        ...currentSettings,
      }
      if (!isDeepStrictEqual(currentInput, input)) {
        throw new HttpError(
          409,
          'STALE_SOURCE',
          '台词、声线或逐句表演档案在确认后已变化，未创建付费任务',
        )
      }
      const currentProvider = (await providerService.list()).find((candidate) => (
        candidate.kind === 'speech' && candidate.id === selectedProvider.id
      ))
      if (!currentProvider
        || !currentProvider.enabled
        || currentProvider.credentialState === 'missing'
        || currentProvider.adapter !== selectedProvider.adapter
        || ((!usesInheritedVoice || !currentInherited?.historicalPin)
          && (currentProvider.model !== selectedProvider.model
            || currentProvider.configRevision !== selectedProvider.configRevision))) {
        throw new HttpError(
          409,
          'PROVIDER_NOT_CONFIGURED',
          '语音 Provider 在确认后已变化，未创建付费任务；请重新预检',
        )
      }
      if (usesInheritedVoice && currentInherited) {
        const version = database.getProviderConnectionVersion(
          currentInherited.providerId,
          currentInherited.providerConfigRevision,
        )
        if (!version
          || version.kind !== 'speech'
          || (version.adapter !== 'minimax'
            && version.adapter !== 'indextts'
            && version.adapter !== 'doubao-speech')
          || version.model !== selectedProvider.model
          || version.configRevision !== selectedProvider.configRevision) {
          throw new HttpError(
            409,
            'CHARACTER_VOICE_PROVIDER_UNAVAILABLE',
            '声线绑定的语音 Provider 版本在确认后已变化，未创建付费任务',
          )
        }
        const currentInheritedProfile = currentTarget.kind === 'narration'
          ? currentNarratorState?.profile
          : currentTarget.characterVoiceProfile
        const currentCatalog = await speechVoiceCatalog(currentInherited.providerId)
        if (!currentInheritedProfile
          || currentCatalog.providerId !== currentInheritedProfile.providerId
          || currentCatalog.providerConfigRevision !== currentInheritedProfile.providerConfigRevision
          || currentCatalog.fingerprint !== currentInheritedProfile.catalogFingerprint
          || !currentCatalog.voices.some((voice) => voice.voiceId === currentInheritedProfile.voiceId)) {
          throw new HttpError(
            409,
            'VOICE_CATALOG_CHANGED',
            '音色目录在确认后已变化，未创建付费任务；请重新确认声线',
          )
        }
      }
      const finalTarget = resolvePublicDialogueLine(database, { projectId, episodeId, lineId })
      const finalPerformanceProfile = input.inheritedPerformanceRevisionId === undefined
        ? undefined
        : linePerformanceProfiles.get(projectId, episodeId, lineId)
      const finalNarratorRevisionId = input.inheritedNarratorVoiceProfileRevisionId === undefined
        ? undefined
        : projectNarratorVoiceProfiles.get(projectId).revisionId
      if (finalTarget.databaseLineId !== input.databaseLineId
        || finalTarget.sourceRevisionId !== input.expectedRevisionId
        || (input.inheritedVoiceProfileRevisionId !== undefined
          && finalTarget.characterVoiceProfileRevisionId !== input.inheritedVoiceProfileRevisionId)
        || (input.inheritedNarratorVoiceProfileRevisionId !== undefined
          && finalNarratorRevisionId !== input.inheritedNarratorVoiceProfileRevisionId)
        || (input.inheritedPerformanceRevisionId !== undefined
          && finalPerformanceProfile?.revisionId !== input.inheritedPerformanceRevisionId)) {
        throw new HttpError(
          409,
          'STALE_SOURCE',
          '台词、声线或逐句表演档案在最终入队前已变化，未创建付费任务',
        )
      }
      const activeDuplicate = ACTIVE_JOB_STATUSES.some((status) => (
        database.listGenerationJobs({
          projectId,
          episodeId,
          type: DIALOGUE_SPEECH_GENERATION_JOB_TYPE,
          status,
          limit: 1_000,
        }).some((job) => job.resourceId === target.databaseLineId)
      ))
      if (activeDuplicate) {
        throw new HttpError(
          409,
          'ACTIVE_GENERATION_CONFLICT',
          '该台词已有进行中的配音任务，请等待完成或取消后再试',
        )
      }
      if (activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return worker.submit({
        type: DIALOGUE_SPEECH_GENERATION_JOB_TYPE,
        input,
        idempotencyKey: submissionKey,
        resourceKey: 'provider:speech',
        projectId,
        providerId: selectedProvider.id,
        model: selectedProvider.model,
        providerConfigRevision: selectedProvider.configRevision,
        metadata: { episodeId, resourceId: target.databaseLineId },
      })
    })
    const durable = database.getGenerationJob(result.job.id)
    if (!durable) throw new Error('Created speech job disappeared')
    response.status(result.created ? 202 : 200).json({ job: publicJob(durable, database) })
  }))

  app.post('/api/v1/jobs/:id/shot-video-unknown-submission-resolution', asyncRoute(async (request, response) => {
    const body = requireObject(request.body, 'Seedance 人工结案请求必须是 JSON 对象')
    const input = parseShotVideoManualResolutionRequest(body)
    const jobId = requestIdentifier(routeParam(request.params.id), 'jobId')
    const result = confirmShotVideoUnknownSubmissionNotCreated(database, {
      jobId,
      ...input,
    })
    const durable = database.getGenerationJob(jobId)
    if (!durable) throw new Error('Resolved Seedance job disappeared')
    response.status(result.idempotent ? 200 : 201).json({
      resolution: result.resolution,
      idempotent: result.idempotent,
      job: publicJob(durable, database),
    })
  }))

  app.get('/api/v1/shots/:shotId/media-review', asyncRoute(async (request, response) => {
    const allowed = new Set(['projectId', 'episodeId', 'sceneId', 'mediaType', 'limit', 'offset'])
    const unknown = Object.keys(request.query).filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      throw new HttpError(
        400,
        'INVALID_MEDIA_REVIEW_REQUEST',
        `不支持的逐镜审片查询参数: ${unknown.join(', ')}`,
      )
    }
    const mediaType = queryString(request.query.mediaType)
    if (mediaType !== 'storyboard' && mediaType !== 'video') {
      throw new HttpError(
        400,
        'INVALID_MEDIA_REVIEW_REQUEST',
        'mediaType 必须是 storyboard 或 video',
      )
    }
    const limit = request.query.limit === undefined
      ? 100
      : positiveInteger(request.query.limit, 'limit', 200)
    const offset = nonNegativeInteger(request.query.offset, 'offset', 100_000)
    const snapshot = shotMediaReviewService.list({
      projectId: requestIdentifier(queryString(request.query.projectId), 'projectId'),
      episodeId: requestIdentifier(queryString(request.query.episodeId), 'episodeId'),
      shotId: requestIdentifier(routeParam(request.params.shotId), 'shotId'),
      ...(request.query.sceneId === undefined
        ? {}
        : { sceneId: requestIdentifier(queryString(request.query.sceneId), 'sceneId') }),
      mediaType,
      limit,
      offset,
    })
    response.setHeader('ETag', snapshot.episodeEtag)
    response.json({ mediaReview: snapshot })
  }))

  app.post('/api/v1/shots/:shotId/media-review', asyncRoute(async (request, response) => {
    const body = requireObject(request.body, '逐镜审片决策必须是 JSON 对象')
    const allowed = new Set([
      'projectId',
      'episodeId',
      'sceneId',
      'mediaType',
      'decision',
      'assetId',
      'note',
    ])
    const unknown = Object.keys(body).filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      throw new HttpError(
        400,
        'INVALID_MEDIA_REVIEW_REQUEST',
        `不支持的逐镜审片字段: ${unknown.join(', ')}`,
      )
    }
    if (body.mediaType !== 'storyboard' && body.mediaType !== 'video') {
      throw new HttpError(
        400,
        'INVALID_MEDIA_REVIEW_REQUEST',
        'mediaType 必须是 storyboard 或 video',
      )
    }
    if (body.decision !== 'adopt' && body.decision !== 'reject' && body.decision !== 'restore') {
      throw new HttpError(
        400,
        'INVALID_MEDIA_REVIEW_REQUEST',
        'decision 必须是 adopt、reject 或 restore',
      )
    }
    if (body.note !== undefined
      && (typeof body.note !== 'string' || body.note.trim().length > 1000)) {
      throw new HttpError(
        400,
        'INVALID_MEDIA_REVIEW_REQUEST',
        'note 必须是不超过 1000 字符的文本',
      )
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const episodeId = requestIdentifier(body.episodeId, 'episodeId')
    const result = shotMediaReviewService.decide({
      projectId,
      episodeId,
      shotId: requestIdentifier(routeParam(request.params.shotId), 'shotId'),
      ...(body.sceneId === undefined
        ? {}
        : { sceneId: requestIdentifier(body.sceneId, 'sceneId') }),
      mediaType: body.mediaType as ShotMediaType,
      decision: body.decision as ShotMediaReviewDecision,
      assetId: requestIdentifier(body.assetId, 'assetId'),
      ...(typeof body.note === 'string' && body.note.trim()
        ? { note: body.note.trim() }
        : {}),
      expectedEpisodeVersion: requiredEpisodeIfMatch(request),
      idempotencyKey: idempotencyKey(request, true),
    })
    if (!result.idempotent) {
      eventHub.publish('project.updated', {
        eventType: result.review.decision === 'reject'
          ? 'shot.media.reviewed'
          : 'shot.media.selected',
        episodeId,
        shotId: result.review.shotId,
        sceneId: result.review.sceneId,
        mediaType: result.review.mediaType,
        assetId: result.review.assetId,
        reviewId: result.review.id,
        clearedVideoAssetId: result.clearedVideoAssetId,
        timelineReconcileRequired: result.timelineReconcileRequired,
      }, { projectId })
    }
    if (result.episodeEtag) response.setHeader('ETag', result.episodeEtag)
    response.status(result.idempotent ? 200 : 201).json({ mediaReview: result })
  }))

  app.get('/api/v1/shots/:shotId/video-reference-recommendation', asyncRoute(async (request, response) => {
    const unknown = Object.keys(request.query).filter((key) => (
      key !== 'projectId' && key !== 'episodeId' && key !== 'sceneId'
    ))
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_VIDEO_REQUEST', `不支持的参考图推荐参数: ${unknown.join(', ')}`)
    }
    const target = resolvePublicShotVideoTarget(database, {
      projectId: requestIdentifier(queryString(request.query.projectId), 'projectId'),
      episodeId: requestIdentifier(queryString(request.query.episodeId), 'episodeId'),
      shotId: requestIdentifier(routeParam(request.params.shotId), 'shotId'),
      ...(request.query.sceneId === undefined
        ? {}
        : { sceneId: requestIdentifier(queryString(request.query.sceneId), 'sceneId') }),
    })
    response.json({ recommendation: resolveShotVideoReferenceRecommendation(database, target) })
  }))

  type VisualReferenceAuthorityReason =
    | 'current'
    | 'job_not_succeeded'
    | 'source_revision_changed'
    | 'visual_inputs_changed'
    | 'provider_revision_changed'
    | 'invalid_binding'

  const visualReferenceBatchRequestFingerprint = (input: {
    batchId: string
    projectId: string
    episodeId: string
    sourceRevisionId: string
    providerId: string
    providerConfigRevision: number
    model: string
    children: ShotVideoVisualReferenceJobInput[]
  }): string => createHash('sha256').update(JSON.stringify({
    version: 1,
    batchId: input.batchId,
    projectId: input.projectId,
    episodeId: input.episodeId,
    sourceRevisionId: input.sourceRevisionId,
    providerId: input.providerId,
    providerConfigRevision: input.providerConfigRevision,
    model: input.model,
    children: input.children.map((prepared) => ({
      selectors: prepared.selectors,
      inputFingerprint: prepared.inputFingerprint,
    })),
  })).digest('hex')

  const visualReferenceAuthority = (
    job: GenerationJobRecord,
    scope: {
      projectId: string
      episodeId: string
      sourceRevisionId: string
      textProviderId: string
    },
    currentProvider: Awaited<ReturnType<ProviderService['list']>>[number] | undefined,
  ): JsonObject => {
    let bound: ShotVideoVisualReferenceJobInput
    try {
      bound = parseShotVideoVisualReferenceJobInput(job.input)
    } catch {
      return {
        usable: false,
        reason: 'invalid_binding' satisfies VisualReferenceAuthorityReason,
        boundInputFingerprint: null,
        currentInputFingerprint: null,
      }
    }
    const selector = bound.selectors.length === 1 ? bound.selectors[0] : undefined
    const shot = bound.shots.length === 1 ? bound.shots[0] : undefined
    const base = {
      boundInputFingerprint: bound.inputFingerprint,
      expectedStoryRevisionId: bound.expectedStoryRevisionId,
      providerId: job.providerId,
      providerConfigRevision: job.providerConfigRevision,
    }
    if (!selector || !shot || selector.shotId !== shot.shotId
      || (selector.sceneId !== undefined && selector.sceneId !== shot.sceneId)
      || job.projectId !== scope.projectId || job.episodeId !== scope.episodeId) {
      return {
        ...base,
        usable: false,
        reason: 'invalid_binding' satisfies VisualReferenceAuthorityReason,
        currentInputFingerprint: null,
      }
    }
    if (bound.expectedStoryRevisionId !== scope.sourceRevisionId) {
      return {
        ...base,
        usable: false,
        reason: 'source_revision_changed' satisfies VisualReferenceAuthorityReason,
        currentInputFingerprint: null,
      }
    }
    if (!currentProvider
      || currentProvider.id !== scope.textProviderId
      || job.providerId !== currentProvider.id
      || job.providerConfigRevision !== currentProvider.configRevision
      || job.model !== currentProvider.model) {
      return {
        ...base,
        usable: false,
        reason: 'provider_revision_changed' satisfies VisualReferenceAuthorityReason,
        currentInputFingerprint: null,
      }
    }
    let current: ShotVideoVisualReferenceJobInput
    try {
      current = prepareShotVideoVisualReferenceJob(database, {
        projectId: scope.projectId,
        episodeId: scope.episodeId,
        selectors: [{ shotId: selector.shotId, sceneId: shot.sceneId }],
      })
    } catch {
      return {
        ...base,
        usable: false,
        reason: 'visual_inputs_changed' satisfies VisualReferenceAuthorityReason,
        currentInputFingerprint: null,
      }
    }
    if (!sameShotVideoVisualReferenceAuthority(bound, current)) {
      return {
        ...base,
        usable: false,
        reason: 'visual_inputs_changed' satisfies VisualReferenceAuthorityReason,
        currentInputFingerprint: current.inputFingerprint,
      }
    }
    if (job.status !== 'succeeded') {
      return {
        ...base,
        usable: false,
        reason: 'job_not_succeeded' satisfies VisualReferenceAuthorityReason,
        currentInputFingerprint: current.inputFingerprint,
      }
    }
    try {
      resolvePersistedShotVideoVisionAssessment(database, {
        jobId: job.id,
        projectId: scope.projectId,
        episodeId: scope.episodeId,
        sourceRevisionId: scope.sourceRevisionId,
        shotId: selector.shotId,
        sceneId: shot.sceneId,
      })
    } catch {
      return {
        ...base,
        usable: false,
        reason: 'invalid_binding' satisfies VisualReferenceAuthorityReason,
        currentInputFingerprint: current.inputFingerprint,
      }
    }
    return {
      ...base,
      usable: true,
      reason: 'current' satisfies VisualReferenceAuthorityReason,
      currentInputFingerprint: current.inputFingerprint,
    }
  }

  const canonicalVisualReferenceBatchJobs = (
    batchId: string,
    durableJobs: GenerationJobRecord[],
  ): Array<{ job: GenerationJobRecord; input: ShotVideoVisualReferenceJobInput; batch: ShotVideoVisualReferenceBatchBinding }> => {
    if (durableJobs.length === 0) {
      throw new HttpError(404, 'VIDEO_REFERENCE_ANALYSIS_BATCH_NOT_FOUND', '视觉分析批次不存在')
    }
    const parsed = durableJobs.map((job) => {
      let input: ShotVideoVisualReferenceJobInput
      try {
        input = parseShotVideoVisualReferenceJobInput(job.input)
      } catch {
        throw new HttpError(409, 'VIDEO_REFERENCE_ANALYSIS_BATCH_INVALID', '视觉分析批次绑定已损坏')
      }
      if (input.batch?.batchId !== batchId || input.selectors.length !== 1 || input.shots.length !== 1) {
        throw new HttpError(409, 'VIDEO_REFERENCE_ANALYSIS_BATCH_INVALID', '视觉分析批次镜头绑定无效')
      }
      return { job, input, batch: input.batch }
    })
    const first = parsed[0]!
    if (parsed.some((entry) => (
      entry.batch.requestFingerprint !== first.batch.requestFingerprint
      || entry.batch.selectionCount !== first.batch.selectionCount
      || entry.job.projectId !== first.job.projectId
      || entry.job.episodeId !== first.job.episodeId
      || entry.job.providerId !== first.job.providerId
      || entry.job.providerConfigRevision !== first.job.providerConfigRevision
      || entry.job.model !== first.job.model
      || entry.input.expectedStoryRevisionId !== first.input.expectedStoryRevisionId
    ))) {
      throw new HttpError(409, 'VIDEO_REFERENCE_ANALYSIS_BATCH_INVALID', '视觉分析批次权威绑定不一致')
    }
    const byIndex = new Map<number, typeof parsed>()
    for (const entry of parsed) {
      const group = byIndex.get(entry.batch.selectionIndex) ?? []
      group.push(entry)
      byIndex.set(entry.batch.selectionIndex, group)
    }
    if (byIndex.size !== first.batch.selectionCount
      || [...byIndex.keys()].some((index) => index < 0 || index >= first.batch.selectionCount)) {
      throw new HttpError(409, 'VIDEO_REFERENCE_ANALYSIS_BATCH_INCOMPLETE', '视觉分析批次缺少持久子任务')
    }
    const canonical = Array.from({ length: first.batch.selectionCount }, (_, selectionIndex) => {
      const group = byIndex.get(selectionIndex)!
      const referencedParents = new Set(group.flatMap((entry) => entry.job.retryOf ? [entry.job.retryOf] : []))
      const leaves = group.filter((entry) => !referencedParents.has(entry.job.id))
      if (leaves.length !== 1) {
        throw new HttpError(409, 'VIDEO_REFERENCE_ANALYSIS_BATCH_INVALID', '视觉分析子任务重试链不唯一')
      }
      const byId = new Map(group.map((entry) => [entry.job.id, entry]))
      const visited = new Set<string>()
      let cursor: (typeof group)[number] | undefined = leaves[0]
      let reachedRoot = false
      while (cursor) {
        if (visited.has(cursor.job.id)) {
          throw new HttpError(409, 'VIDEO_REFERENCE_ANALYSIS_BATCH_INVALID', '视觉分析子任务重试链形成循环')
        }
        visited.add(cursor.job.id)
        if (!isDeepStrictEqual(cursor.input, first.input)
          && !isDeepStrictEqual(cursor.input, group[0]!.input)) {
          throw new HttpError(409, 'VIDEO_REFERENCE_ANALYSIS_BATCH_INVALID', '视觉分析子任务重试改变了输入绑定')
        }
        if (!cursor.job.retryOf) {
          reachedRoot = true
          cursor = undefined
          continue
        }
        const childAttempt = cursor.job.attempt
        const parent = byId.get(cursor.job.retryOf)
        if (!parent || parent.job.attempt + 1 !== childAttempt) {
          throw new HttpError(409, 'VIDEO_REFERENCE_ANALYSIS_BATCH_INVALID', '视觉分析子任务重试血缘无效')
        }
        cursor = parent
      }
      if (!reachedRoot || visited.size !== group.length) {
        throw new HttpError(409, 'VIDEO_REFERENCE_ANALYSIS_BATCH_INVALID', '视觉分析子任务存在分叉重试链')
      }
      return leaves[0]!
    })
    const expectedRequestFingerprint = visualReferenceBatchRequestFingerprint({
      batchId,
      projectId: first.job.projectId,
      episodeId: first.input.episodeId,
      sourceRevisionId: first.input.expectedStoryRevisionId,
      providerId: first.job.providerId ?? '',
      providerConfigRevision: first.job.providerConfigRevision ?? 0,
      model: first.job.model ?? '',
      children: canonical.map((entry) => entry.input),
    })
    if (first.batch.requestFingerprint !== expectedRequestFingerprint) {
      throw new HttpError(409, 'VIDEO_REFERENCE_ANALYSIS_BATCH_INVALID', '视觉分析批次请求指纹不匹配')
    }
    return canonical
  }

  const visualReferenceBatchPayload = (
    batchId: string,
    durableJobs: GenerationJobRecord[],
    scope: {
      projectId: string
      episodeId: string
      sourceRevisionId: string
      textProviderId: string
    },
    currentProvider: Awaited<ReturnType<ProviderService['list']>>[number] | undefined,
  ): JsonObject => {
    const parsed = canonicalVisualReferenceBatchJobs(batchId, durableJobs)
    const first = parsed[0]!
    const integrityValid = parsed.every((entry, index) => (
        entry.batch.requestFingerprint === first.batch.requestFingerprint
        && entry.batch.selectionCount === first.batch.selectionCount
        && entry.batch.selectionIndex === index
        && entry.job.projectId === scope.projectId
        && entry.job.episodeId === scope.episodeId
        && entry.job.providerId === first.job.providerId
        && entry.job.providerConfigRevision === first.job.providerConfigRevision
        && entry.job.model === first.job.model
        && entry.input.expectedStoryRevisionId === first.input.expectedStoryRevisionId
        && entry.input.selectors.length === 1))
    const statuses = parsed.map((entry) => entry.job.status)
    const active = statuses.some((status) => ['queued', 'running', 'waiting_provider'].includes(status))
    const succeeded = statuses.filter((status) => status === 'succeeded').length
    const failed = statuses.filter((status) => status === 'failed' || status === 'cancelled').length
    const status = !integrityValid ? 'incomplete'
      : succeeded === statuses.length ? 'succeeded'
        : active ? (statuses.every((candidate) => candidate === 'queued') ? 'queued' : 'running')
          : succeeded > 0 && failed > 0 ? 'partial_failed'
            : 'failed'
    const progress = parsed.length === 0
      ? 0
      : Math.round(parsed.reduce((sum, entry) => sum + entry.job.progress, 0) / parsed.length)
    return {
      version: 1,
      id: batchId,
      projectId: scope.projectId,
      episodeId: scope.episodeId,
      sourceRevisionId: first.input.expectedStoryRevisionId,
      providerId: first.job.providerId,
      providerConfigRevision: first.job.providerConfigRevision,
      model: first.job.model,
      requestFingerprint: first.batch.requestFingerprint,
      status,
      progress,
      counts: {
        total: first.batch.selectionCount,
        queued: statuses.filter((candidate) => candidate === 'queued').length,
        running: statuses.filter((candidate) => candidate === 'running'
          || candidate === 'waiting_provider').length,
        succeeded,
        failed,
      },
      selections: parsed.map(({ job, input, batch }) => ({
        selectionIndex: batch.selectionIndex,
        shotId: input.shots[0]!.shotId,
        sceneId: input.shots[0]!.sceneId,
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        authority: visualReferenceAuthority(job, scope, currentProvider),
      })),
      createdAt: durableJobs.map((job) => job.createdAt).sort()[0]!,
      updatedAt: durableJobs.map((job) => job.updatedAt).sort().at(-1)!,
    }
  }

  app.get('/api/v1/episodes/:episodeId/video-reference-analyses', asyncRoute(async (request, response) => {
    const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
    const projectId = requestIdentifier(queryString(request.query.projectId), 'projectId')
    const sourceRevisionId = requestIdentifier(
      queryString(request.query.sourceRevisionId),
      'sourceRevisionId',
    )
    const textProviderId = requestIdentifier(
      queryString(request.query.textProviderId),
      'textProviderId',
    )
    const currentProvider = (await providerService.list()).find((candidate) => (
      candidate.kind === 'text' && candidate.id === textProviderId
    ))
    const scope = { projectId, episodeId, sourceRevisionId, textProviderId }
    const seenShotKeys = new Set<string>()
    const analyses = database.listGenerationJobs({
      projectId,
      episodeId,
      type: SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
      limit: 500,
    }).flatMap((job) => {
      let input: ShotVideoVisualReferenceJobInput
      try {
        input = parseShotVideoVisualReferenceJobInput(job.input)
      } catch {
        return []
      }
      if (input.selectors.length !== 1 || input.shots.length !== 1
        || input.expectedStoryRevisionId !== sourceRevisionId
        || job.providerId !== textProviderId) return []
      const shotKey = `${input.shots[0]!.sceneId}\u0000${input.shots[0]!.shotId}`
      // listGenerationJobs is newest-first. Returning one authoritative row
      // per exact shot prevents an older result later in the payload from
      // overwriting the newest explicit attempt during client hydration.
      if (seenShotKeys.has(shotKey)) return []
      seenShotKeys.add(shotKey)
      return [{
        shotId: input.shots[0]!.shotId,
        sceneId: input.shots[0]!.sceneId,
        job: publicJob(job, database),
        authority: visualReferenceAuthority(job, scope, currentProvider),
      }]
    })
    response.json({ analyses })
  }))

  app.get(
    '/api/v1/episodes/:episodeId/video-reference-analysis-batches/:batchId',
    asyncRoute(async (request, response) => {
      const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
      const batchId = requestIdentifier(routeParam(request.params.batchId), 'batchId')
      const projectId = requestIdentifier(queryString(request.query.projectId), 'projectId')
      const sourceRevisionId = requestIdentifier(
        queryString(request.query.sourceRevisionId),
        'sourceRevisionId',
      )
      const textProviderId = requestIdentifier(
        queryString(request.query.textProviderId),
        'textProviderId',
      )
      const currentProvider = (await providerService.list()).find((candidate) => (
        candidate.kind === 'text' && candidate.id === textProviderId
      ))
      const durableJobs = database.listGenerationJobs({
        projectId,
        episodeId,
        type: SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
        limit: 500,
      }).filter((job) => isPlainObject(job.input.batch) && job.input.batch.batchId === batchId)
      const scope = { projectId, episodeId, sourceRevisionId, textProviderId }
      const orderedJobs = canonicalVisualReferenceBatchJobs(batchId, durableJobs)
        .map((entry) => entry.job)
      response.json({
        batch: visualReferenceBatchPayload(batchId, durableJobs, scope, currentProvider),
        jobs: orderedJobs.map((job) => publicJob(job, database)),
      })
    }),
  )

  app.post('/api/v1/episodes/:episodeId/video-reference-analyses', asyncRoute(async (request, response) => {
    const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
    const body = requireObject(request.body, '视觉选镜请求必须是 JSON 对象')
    const unknown = Object.keys(body).filter((key) => (
      key !== 'projectId' && key !== 'selections' && key !== 'textProviderId'
    ))
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `不支持的视觉选镜参数: ${unknown.join(', ')}`)
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const requestedTextProviderId = body.textProviderId === undefined
      ? undefined
      : requestIdentifier(body.textProviderId, 'textProviderId')
    if (!Array.isArray(body.selections)
      || body.selections.length < 1
      || body.selections.length > 24) {
      throw new HttpError(400, 'INVALID_REQUEST', '视觉选镜每次必须选择 1–24 个镜头')
    }
    const selectors = body.selections.map((value, index) => {
      if (!isPlainObject(value)
        || Object.keys(value).some((key) => key !== 'shotId' && key !== 'sceneId')) {
        throw new HttpError(400, 'INVALID_REQUEST', `镜头选择 ${index + 1} 无效`)
      }
      return {
        shotId: requestIdentifier(value.shotId, `selections[${index}].shotId`),
        ...(value.sceneId === undefined
          ? {}
          : { sceneId: requestIdentifier(value.sceneId, `selections[${index}].sceneId`) }),
      }
    })
    if (new Set(selectors.map((selector) => (
      `${selector.sceneId ?? ''}\u0000${selector.shotId}`
    ))).size !== selectors.length) {
      throw new HttpError(400, 'INVALID_REQUEST', '视觉选镜批次不能重复选择同一镜头')
    }
    if (selectors.length > 1 && selectors.some((selector) => selector.sceneId === undefined)) {
      throw new HttpError(400, 'INVALID_REQUEST', '批量视觉分析必须同时提供每个镜头的 sceneId 与 shotId')
    }
    const preparedChildren = selectors.map((selector) => prepareShotVideoVisualReferenceJob(database, {
      projectId,
      episodeId,
      selectors: [selector],
    }))
    const sourceRevisionIds = new Set(preparedChildren.map((prepared) => (
      prepared.expectedStoryRevisionId
    )))
    if (sourceRevisionIds.size !== 1) {
      throw new HttpError(409, 'STALE_SOURCE', '所选镜头不属于同一剧本修订，请刷新后重新分析')
    }
    if (new Set(preparedChildren.map((prepared) => (
      `${prepared.shots[0]!.sceneId}\u0000${prepared.shots[0]!.shotId}`
    ))).size !== preparedChildren.length) {
      throw new HttpError(400, 'INVALID_REQUEST', '批量视觉分析解析到了重复的镜头范围')
    }
    const submissionKey = idempotencyKey(request, true)
    const textProviders = (await providerService.list()).filter((candidate) => candidate.kind === 'text')
    const selected = requestedTextProviderId
      ? textProviders.find((candidate) => candidate.id === requestedTextProviderId)
      : textProviders.find((candidate) => candidate.isDefault)
    if (!selected) throw new HttpError(404, 'PROVIDER_NOT_FOUND', '文本 Provider 不存在')
    if (!selected.enabled
      || selected.credentialState === 'missing'
      || !selected.model.trim()
      || selected.health.status !== 'ok'
      || !selected.capabilities.includes('vision')) {
      throw new HttpError(
        409,
        'PROVIDER_NOT_VERIFIED',
        '请先配置并测试支持多模态的文本 Provider，再使用 AI 视觉选镜',
      )
    }
    const exactReplay = (job: GenerationJobRecord, prepared: ShotVideoVisualReferenceJobInput): boolean => (
      job.type === SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE
      && job.projectId === projectId
      && job.episodeId === episodeId
      && job.providerId === selected.id
      && job.providerConfigRevision === selected.configRevision
      && job.model === selected.model
      && isDeepStrictEqual(job.input, prepared)
    )
    if (preparedChildren.length > 1) {
      const batchId = `vrb-${createHash('sha256').update([
        projectId,
        episodeId,
        submissionKey,
      ].join('\u0000')).digest('hex').slice(0, 32)}`
      const requestFingerprint = visualReferenceBatchRequestFingerprint({
        batchId,
        projectId,
        episodeId,
        sourceRevisionId: preparedChildren[0]!.expectedStoryRevisionId,
        providerId: selected.id,
        providerConfigRevision: selected.configRevision,
        model: selected.model,
        children: preparedChildren,
      })
      const childInputs = preparedChildren.map((prepared, selectionIndex) => {
        const batch: ShotVideoVisualReferenceBatchBinding = {
          version: 1,
          batchId,
          requestFingerprint,
          selectionIndex,
          selectionCount: preparedChildren.length,
        }
        return bindShotVideoVisualReferenceBatch(prepared, batch)
      })
      const childKeys = childInputs.map((input) => `visual-batch-child-${createHash('sha256')
        .update(`${submissionKey}\u0000${input.batch!.selectionIndex}\u0000${input.inputFingerprint}`)
        .digest('hex')}`)
      const admitted = await withJobAdmission(async () => {
        // A key previously used by a single Job or another operation cannot be
        // silently reinterpreted as a derived batch namespace.
        if (database.findGenerationJobByIdempotencyKey(projectId, submissionKey)) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
        }
        const priorBatchJobs = database.listGenerationJobs({
          projectId,
          episodeId,
          type: SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
          limit: 500,
        }).filter((job) => isPlainObject(job.input.batch) && job.input.batch.batchId === batchId)
        let priorReplayJobs: GenerationJobRecord[] | undefined
        if (priorBatchJobs.length > 0) {
          let canonicalPrior: ReturnType<typeof canonicalVisualReferenceBatchJobs>
          try {
            canonicalPrior = canonicalVisualReferenceBatchJobs(batchId, priorBatchJobs)
          } catch {
            throw new HttpError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'Idempotency-Key 已用于不同的视觉分析批次',
            )
          }
          if (canonicalPrior.length !== childInputs.length
            || canonicalPrior.some((entry, index) => (
              entry.batch.requestFingerprint !== requestFingerprint
              || !exactReplay(entry.job, childInputs[index]!)
            ))) {
            throw new HttpError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'Idempotency-Key 已用于不同的视觉分析批次',
            )
          }
          priorReplayJobs = canonicalPrior.map((entry) => entry.job)
        }
        const currentProvider = (await providerService.list()).find((candidate) => (
          candidate.kind === 'text' && candidate.id === selected.id
        ))
        if (!currentProvider
          || !currentProvider.enabled
          || currentProvider.credentialState === 'missing'
          || currentProvider.health.status !== 'ok'
          || currentProvider.model !== selected.model
          || currentProvider.configRevision !== selected.configRevision
          || !currentProvider.capabilities.includes('vision')) {
          throw new HttpError(
            409,
            'PROVIDER_CONFIGURATION_CHANGED',
            '视觉选镜 Provider 已变化，未创建批量任务',
          )
        }
        const currentChildren = selectors.map((selector) => prepareShotVideoVisualReferenceJob(database, {
          projectId,
          episodeId,
          selectors: [selector],
        }))
        if (currentChildren.some((current, index) => (
          !sameShotVideoVisualReferenceAuthority(current, childInputs[index]!)
        ))) {
          throw new HttpError(409, 'STALE_SOURCE', '分镜或视觉资产已变化，请刷新后重新分析')
        }

        const existingByIndex = priorReplayJobs ?? childKeys.map((key) => (
          database.findGenerationJobByIdempotencyKey(projectId, key)
        ))
        for (const [index, existing] of existingByIndex.entries()) {
          if (existing && !exactReplay(existing, childInputs[index]!)) {
            throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他视觉分析批次')
          }
        }
        const existingIds = new Set(existingByIndex.flatMap((job) => job ? [job.id] : []))
        const activeConflict = database.listGenerationJobs({
          projectId,
          episodeId,
          type: SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
          limit: maxQueueDepth,
        }).find((job) => (
          !existingIds.has(job.id)
          && ['queued', 'running', 'waiting_provider'].includes(job.status)
          && childInputs.some((input) => job.input.inputFingerprint === input.inputFingerprint)
        ))
        if (activeConflict) {
          throw new HttpError(
            409,
            'VIDEO_REFERENCE_ANALYSIS_ALREADY_ACTIVE',
            '批次中至少一个镜头已有视觉分析任务在运行',
            { existingJobId: activeConflict.id },
          )
        }
        const missingCount = existingByIndex.filter((job) => !job).length
        if (activeJobCount(database) + missingCount > maxQueueDepth) {
          throw new HttpError(429, 'QUEUE_FULL', '生成队列容量不足，未创建本批任务')
        }
        return database.transaction((transaction) => {
          const durableJobs = childInputs.map((input, index) => {
            const existing = existingByIndex[index]
            if (existing) return existing
            return transaction.createGenerationJob({
              projectId,
              episodeId,
              type: SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
              status: 'queued',
              progress: 0,
              resourceType: 'provider:text:vision',
              resourceId: episodeId,
              providerId: selected.id,
              model: selected.model,
              providerConfigRevision: selected.configRevision,
              idempotencyKey: childKeys[index]!,
              input: input as unknown as JsonObject,
            })
          })
          return { durableJobs, createdCount: missingCount }
        })
      })
      // Creation is one SQLite transaction. Enqueue only after commit so a
      // worker can never observe a partial batch; startup recovery covers a
      // process exit between commit and these in-memory notifications.
      for (const durable of admitted.durableJobs) {
        if (['queued', 'waiting_provider'].includes(durable.status)) worker.enqueue(durable.id)
      }
      const currentProvider = (await providerService.list()).find((candidate) => (
        candidate.kind === 'text' && candidate.id === selected.id
      ))
      const scope = {
        projectId,
        episodeId,
        sourceRevisionId: preparedChildren[0]!.expectedStoryRevisionId,
        textProviderId: selected.id,
      }
      const durableBatchHistory = database.listGenerationJobs({
        projectId,
        episodeId,
        type: SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
        limit: 500,
      }).filter((job) => isPlainObject(job.input.batch) && job.input.batch.batchId === batchId)
      const responseJobs = canonicalVisualReferenceBatchJobs(batchId, durableBatchHistory)
        .map((entry) => entry.job)
      response.status(admitted.createdCount > 0 ? 202 : 200).json({
        batch: visualReferenceBatchPayload(batchId, durableBatchHistory, scope, currentProvider),
        jobs: responseJobs.map((job) => publicJob(job, database)),
      })
      return
    }

    const prepared = preparedChildren[0]!
    const result = await withJobAdmission(async () => {
      const existing = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
      if (existing) {
        if (!exactReplay(existing, prepared)) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
        }
        return { job: existing, created: false }
      }
      const currentProvider = (await providerService.list()).find((candidate) => (
        candidate.kind === 'text' && candidate.id === selected.id
      ))
      if (!currentProvider
        || !currentProvider.enabled
        || currentProvider.credentialState === 'missing'
        || currentProvider.health.status !== 'ok'
        || currentProvider.model !== selected.model
        || currentProvider.configRevision !== selected.configRevision
        || !currentProvider.capabilities.includes('vision')) {
        throw new HttpError(409, 'PROVIDER_CONFIGURATION_CHANGED', '视觉选镜 Provider 已变化，未创建任务')
      }
      const currentPrepared = prepareShotVideoVisualReferenceJob(database, {
        projectId,
        episodeId,
        selectors,
      })
      if (!isDeepStrictEqual(currentPrepared, prepared)) {
        throw new HttpError(409, 'STALE_SOURCE', '分镜或视觉资产已变化，请刷新后重新分析')
      }
      const active = database.listGenerationJobs({
        projectId,
        episodeId,
        type: SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
        limit: maxQueueDepth,
      }).find((job) => (
        ['queued', 'running', 'waiting_provider'].includes(job.status)
        && job.input.inputFingerprint === prepared.inputFingerprint
      ))
      if (active) {
        throw new HttpError(
          409,
          'VIDEO_REFERENCE_ANALYSIS_ALREADY_ACTIVE',
          '同一分镜修订已有视觉选镜任务在运行',
          { existingJobId: active.id },
        )
      }
      if (activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return worker.submit({
        type: SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
        input: prepared,
        idempotencyKey: submissionKey,
        resourceKey: 'provider:text:vision',
        projectId,
        providerId: selected.id,
        model: selected.model,
        providerConfigRevision: selected.configRevision,
        metadata: { episodeId, resourceId: episodeId },
      })
    })
    const durable = database.getGenerationJob(result.job.id)
    if (!durable) throw new Error('Created visual reference analysis job disappeared')
    response.status(result.created ? 202 : 200).json({ job: publicJob(durable, database) })
  }))

  app.post('/api/v1/episodes/:episodeId/video-generations/preflight', asyncRoute(async (request, response) => {
    const body = requireObject(request.body, 'Seedance 批量预检请求必须是 JSON 对象')
    const input = parseShotVideoBatchRequest(
      body,
      routeParam(request.params.episodeId),
      { confirmation: 'forbidden' },
    )
    const rootIdempotencyKey = idempotencyKey(request, true)
    const provider = await resolveShotVideoProvider(input.providerId)
    const prepared = prepareShotVideoBatch(database, input, provider)
    assertNoConflictingShotVideoAttempts(database, prepared)
    const issuedAt = shotVideoPreflightNow()
    if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.getTime())) {
      throw new Error('shotVideoPreflightNow returned an invalid Date')
    }
    const expiresAtEpochSeconds = Math.floor(issuedAt.getTime() / 1_000)
      + SHOT_VIDEO_BATCH_PREFLIGHT_TTL_SECONDS
    const expiresAt = new Date(expiresAtEpochSeconds * 1_000).toISOString()
    const confirmationToken = shotVideoBatchConfirmationToken(
      shotVideoPreflightSecret,
      prepared,
      { rootIdempotencyKey, expiresAtEpochSeconds },
    )
    response.json({
      preflight: shotVideoBatchPreflightAsJson(prepared, confirmationToken, expiresAt),
    })
  }))

  app.post('/api/v1/episodes/:episodeId/video-generations', asyncRoute(async (request, response) => {
    const body = requireObject(request.body, 'Seedance 批量创建请求必须是 JSON 对象')
    const input = parseShotVideoBatchRequest(
      body,
      routeParam(request.params.episodeId),
      { confirmation: 'required' },
    )
    const rootIdempotencyKey = idempotencyKey(request, true)
    const childKeys = input.selections.map((_selection, index) => (
      shotVideoBatchChildIdempotencyKey(input.projectId, rootIdempotencyKey, index)
    ))
    const initialExisting = childKeys.map((key) => (
      database.findGenerationJobByIdempotencyKey(input.projectId, key)
    ))
    initialExisting.forEach((job, index) => {
      if (job) assertExistingShotVideoBatchChild(job, input, index)
    })
    if (initialExisting.every((job) => job !== undefined)) {
      response.status(200).json({ jobs: initialExisting.map((job) => publicJob(job!, database)) })
      return
    }

    let provider: ShotVideoProviderBinding
    const firstExisting = initialExisting.find((job) => job !== undefined)
    if (firstExisting) {
      if (!firstExisting.providerId
        || firstExisting.providerConfigRevision === null
        || !firstExisting.model) {
        throw new ShotVideoBatchError(
          409,
          'VIDEO_BATCH_IDEMPOTENCY_CONFLICT',
          '已有批量子任务缺少不可变 Provider 绑定',
        )
      }
      provider = {
        providerId: firstExisting.providerId,
        configRevision: firstExisting.providerConfigRevision,
        model: firstExisting.model,
      }
      if (input.providerId && input.providerId !== provider.providerId) {
        throw new ShotVideoBatchError(
          409,
          'VIDEO_BATCH_IDEMPOTENCY_CONFLICT',
          'Idempotency-Key 已绑定另一个视频 Provider',
        )
      }
    } else {
      provider = await resolveShotVideoProvider(input.providerId)
    }

    const prepared = prepareShotVideoBatch(database, input, provider)
    for (const [index, existing] of initialExisting.entries()) {
      if (!existing) continue
      if (existing.providerId !== provider.providerId
        || existing.providerConfigRevision !== provider.configRevision
        || existing.model !== provider.model) {
        throw new ShotVideoBatchError(
          409,
          'VIDEO_BATCH_IDEMPOTENCY_CONFLICT',
          '已有批量子任务的 Provider 绑定不一致',
        )
      }
      const existingInput = existing.input as unknown as PreparedShotVideoBatch['targets'][number]['input']
      if (existingInput.binding?.expectedRevisionId !== prepared.sourceRevisionId) {
        throw new ShotVideoBatchError(
          409,
          'VIDEO_BATCH_PREFLIGHT_CHANGED',
          '源剧本已变更，请重新进行 Seedance 批量预检',
        )
      }
      // A completed child changes only its own video compare-and-swap cursor.
      // Reuse its signed original input so a retry can finish a rare partial
      // admission without weakening the root batch idempotency identity.
      prepared.targets[index] = {
        ...prepared.targets[index],
        durationSeconds: existingInput.durationSeconds,
        timelineDurationSeconds: existingInput.durationDecision?.timelineDurationSeconds
          ?? existingInput.durationSeconds,
        ...(existingInput.durationDecision
          ? { durationDecision: existingInput.durationDecision }
          : {}),
        input: existingInput,
      }
      assertShotVideoBatchChild(existing, prepared, index)
    }

    const confirmationNow = shotVideoPreflightNow()
    if (!(confirmationNow instanceof Date) || !Number.isFinite(confirmationNow.getTime())) {
      throw new Error('shotVideoPreflightNow returned an invalid Date')
    }
    const confirmation = verifyShotVideoBatchConfirmationToken(
      shotVideoPreflightSecret,
      prepared,
      input.confirmationToken!,
      rootIdempotencyKey,
      Math.floor(confirmationNow.getTime() / 1_000),
    )
    if (confirmation === 'expired') {
      throw new ShotVideoBatchError(
        409,
        'VIDEO_BATCH_PREFLIGHT_EXPIRED',
        'Seedance 批量预检已过期，请重新核对任务范围与计费规格',
      )
    }
    if (confirmation !== 'valid') {
      throw new ShotVideoBatchError(
        409,
        'VIDEO_BATCH_PREFLIGHT_CHANGED',
        '镜头、参考图、计费规格或 Provider 版本已变更，请重新预检确认',
      )
    }

    const result = await withJobAdmission(async () => {
      const committed = database.transaction((transaction) => {
        const raced = childKeys.map((key) => (
          transaction.findGenerationJobByIdempotencyKey(input.projectId, key)
        ))
        raced.forEach((job, index) => {
          if (job) assertShotVideoBatchChild(job, prepared, index)
        })
        assertNoConflictingShotVideoAttempts(
          transaction,
          prepared,
          new Set(raced.flatMap((job) => job ? [job.id] : [])),
        )
        const missingCount = raced.filter((job) => !job).length
        if (activeJobCount(transaction) + missingCount > maxQueueDepth) {
          throw new HttpError(
            429,
            'QUEUE_FULL',
            '生成队列无法容纳本次完整 Seedance 批次，未创建新的子任务',
          )
        }
        const jobs: GenerationJobRecord[] = []
        const createdJobIds: string[] = []
        for (const [index, target] of prepared.targets.entries()) {
          const existing = raced[index]
          if (existing) {
            jobs.push(existing)
            continue
          }
          const durable = transaction.createGenerationJob({
            projectId: input.projectId,
            episodeId: input.episodeId,
            type: SHOT_VIDEO_GENERATION_JOB_TYPE,
            status: 'queued',
            progress: 0,
            resourceType: 'provider:video',
            resourceId: target.shotId,
            providerId: provider.providerId,
            model: provider.model,
            providerConfigRevision: provider.configRevision,
            idempotencyKey: childKeys[index],
            attempt: 1,
            input: target.input as unknown as JsonObject,
          })
          assertShotVideoBatchChild(durable, prepared, index)
          createdJobIds.push(durable.id)
          jobs.push(durable)
        }
        return { jobs, createdJobIds }
      })
      // The commit is already durable. A crash before these wakeups is safe:
      // JobWorker.start() recovers every queued row on the next boot.
      for (const jobId of committed.createdJobIds) worker.enqueue(jobId)
      return { jobs: committed.jobs, created: committed.createdJobIds.length > 0 }
    })
    response.status(result.created ? 202 : 200).json({
      jobs: result.jobs.map((job) => publicJob(job, database)),
    })
  }))

  app.post('/api/v1/shots/:shotId/video-generations', asyncRoute(async (request, response) => {
    const shotId = requestIdentifier(routeParam(request.params.shotId), 'shotId')
    const body = requireObject(request.body, '视频生成请求必须是 JSON 对象')
    const allowed = new Set([
      'projectId',
      'episodeId',
      'sceneId',
      'providerId',
      'resolution',
      'durationSeconds',
      'generateAudio',
    ])
    const unknown = Object.keys(body).filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_VIDEO_REQUEST', `不支持的视频生成参数: ${unknown.join(', ')}`)
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const episodeId = requestIdentifier(body.episodeId, 'episodeId')
    const sceneId = body.sceneId === undefined
      ? undefined
      : requestIdentifier(body.sceneId, 'sceneId')
    const requestedProviderId = body.providerId === undefined
      ? undefined
      : requestIdentifier(body.providerId, 'providerId')
    const resolution = body.resolution ?? '720p'
    if (resolution !== '480p' && resolution !== '720p' && resolution !== '1080p') {
      throw new HttpError(
        400,
        'INVALID_VIDEO_REQUEST',
        'resolution 必须是 480p、720p 或 1080p',
      )
    }
    let durationSeconds: number | undefined
    if (body.durationSeconds !== undefined) {
      if (typeof body.durationSeconds !== 'number'
        || !Number.isInteger(body.durationSeconds)
        || body.durationSeconds < 4
        || body.durationSeconds > 15) {
        throw new HttpError(
          400,
          'INVALID_VIDEO_REQUEST',
          'Seedance 2.0 durationSeconds 必须是 4 到 15 的整数',
        )
      }
      durationSeconds = body.durationSeconds
    }
    const generateAudio = body.generateAudio ?? false
    if (typeof generateAudio !== 'boolean') {
      throw new HttpError(400, 'INVALID_VIDEO_REQUEST', 'generateAudio 必须是布尔值')
    }
    const target = resolvePublicShotVideoTarget(database, {
      projectId,
      episodeId,
      shotId,
      ...(sceneId ? { sceneId } : {}),
    })
    const input = createShotVideoJobInput(target, {
      resolution,
      generateAudio,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    })
    const submissionKey = idempotencyKey(request, true)
    const assertIdempotentMatch = (existing: GenerationJobRecord) => {
      if (existing.type !== SHOT_VIDEO_GENERATION_JOB_TYPE
        || !sameShotVideoSubmission(existing.input, input)
        || (requestedProviderId !== undefined && existing.providerId !== requestedProviderId)) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
      }
    }
    const existing = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
    if (existing) {
      assertIdempotentMatch(existing)
      response.status(200).json({ job: publicJob(existing, database) })
      return
    }
    throw new HttpError(
      428,
      'VIDEO_BATCH_PREFLIGHT_REQUIRED',
      '新建 Seedance 视频任务必须先通过分集批量预检；该旧接口仅保留历史 Idempotency-Key 精确重放',
    )
  }))

  app.get('/api/jobs', (request, response, next) => {
    try {
      const limit = positiveInteger(request.query.limit, 'limit', 200)
      const status = queryString(request.query.status) as JobStatus | undefined
      if (status && !ACTIVE_JOB_STATUSES.includes(status) && !['succeeded', 'failed', 'cancelled'].includes(status)) {
        throw new HttpError(400, 'INVALID_STATUS', 'status 参数无效')
      }
      const jobs = database.listGenerationJobs({ limit, status }).map(legacyJob)
      response.json({ jobs })
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/jobs/:id', (request, response, next) => {
    try {
      const job = database.getGenerationJob(routeParam(request.params.id))
      if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', '生成任务不存在')
      response.json({ job: legacyJob(job) })
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/jobs/:id/retry', asyncRoute(async (request, response) => {
    const jobId = routeParam(request.params.id)
    jobs.assertGenericRetryAllowed(jobId)
    const result = await withJobAdmission(async () => {
      if (!jobs.hasRetryChild(jobId) && activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return worker.retry(jobId)
    })
    if (!result.created) throw new HttpError(409, 'ACTIVE_RETRY_EXISTS', '该任务已有重试任务')
    const durable = database.getGenerationJob(result.job.id)
    if (!durable) throw new Error('Retried job disappeared')
    response.status(202).json({ job: legacyJob(durable) })
  }))

  app.get('/api/v1/projects', (_request, response) => {
    response.json({ projects: projectService.listProjects() })
  })
  app.post('/api/v1/projects', (request, response, next) => {
    try {
      const body = requireObject(request.body, '项目请求必须是 JSON 对象')
      const { title, document } = projectDocumentForCreate(body)
      const created = database.transaction(() => {
        const project = database.createProject({ title })
        const revision = database.createRevision({
          projectId: project.id,
          summary: '创建项目',
          snapshot: document,
        })
        const updated = database.updateProject(project.id, { currentRevisionId: revision.id })
        if (!updated) throw new Error('Created project disappeared')
        return { project: updated, revision }
      })
      response.status(201).setHeader('ETag', `W/"${created.revision.id}"`)
      response.json({ ...created, document })
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/v1/projects/:projectId', (request, response, next) => {
    try {
      const snapshot = projectService.getSnapshot(routeParam(request.params.projectId))
      response.setHeader('ETag', snapshot.etag)
      response.json(snapshot)
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/v1/projects/:projectId/knowledge', (request, response, next) => {
    try {
      const snapshot = projectKnowledgeService.get(routeParam(request.params.projectId))
      response.setHeader('ETag', snapshot.etag)
      response.json(snapshot)
    } catch (error) {
      next(error)
    }
  })
  app.patch('/api/v1/projects/:projectId/knowledge', (request, response, next) => {
    try {
      const projectId = routeParam(request.params.projectId)
      const body = requireObject(request.body, '项目知识更新必须是 JSON 对象')
      const document = requireObject(body.document, 'document 必须是 JSON 对象')
      const snapshot = projectKnowledgeService.replace(projectId, document, {
        expectedRevisionId: requiredIfMatch(request),
        summary: typeof body.summary === 'string' ? body.summary : undefined,
      })
      eventHub.publish('project.updated', {
        project: snapshot.project as unknown as JsonValue,
        knowledgeRevisionId: snapshot.revision?.id ?? null,
      }, { projectId })
      response.setHeader('ETag', snapshot.etag)
      response.json(snapshot)
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/v1/projects/:projectId/import', (request, response, next) => {
    try {
      const projectId = routeParam(request.params.projectId)
      const body = requireObject(request.body, '项目原著导入必须是 JSON 对象')
      const unknown = Object.keys(body).filter((key) => key !== 'fileName' && key !== 'content')
      if (unknown.length > 0 || !Object.hasOwn(body, 'fileName') || !Object.hasOwn(body, 'content')) {
        throw new HttpError(400, 'INVALID_PROJECT_IMPORT', '导入请求只接受 fileName 与 content')
      }
      const snapshot = projectKnowledgeService.importSource(projectId, {
        fileName: body.fileName,
        content: body.content,
      }, {
        expectedRevisionId: requiredIfMatch(request),
      })
      eventHub.publish('project.updated', {
        project: snapshot.project as unknown as JsonValue,
        knowledgeRevisionId: snapshot.revision?.id ?? null,
      }, { projectId })
      response.status(201).setHeader('ETag', snapshot.etag)
      response.json(snapshot)
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/v1/projects/:projectId/knowledge/revisions', (request, response, next) => {
    try {
      response.json({
        revisions: projectKnowledgeService.list(routeParam(request.params.projectId)),
      })
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/v1/projects/:projectId/knowledge/revisions/:revisionId/restore', (request, response, next) => {
    try {
      const projectId = routeParam(request.params.projectId)
      const snapshot = projectKnowledgeService.restore(
        projectId,
        routeParam(request.params.revisionId),
        requiredIfMatch(request),
      )
      eventHub.publish('project.updated', {
        project: snapshot.project as unknown as JsonValue,
        knowledgeRevisionId: snapshot.revision?.id ?? null,
      }, { projectId })
      response.setHeader('ETag', snapshot.etag)
      response.json(snapshot)
    } catch (error) {
      next(error)
    }
  })
  app.patch('/api/v1/projects/:projectId', (request, response, next) => {
    try {
      const projectId = routeParam(request.params.projectId)
      const expectedRevisionId = requiredIfMatch(request)
      const body = requireObject(request.body, '项目更新必须是 JSON 对象')
      const current = projectService.getSnapshot(projectId)
      const document = body.document !== undefined
        ? requireObject(body.document, 'document 必须是 JSON 对象')
        : body.patch !== undefined
          ? { ...current.document, ...requireObject(body.patch, 'patch 必须是 JSON 对象') }
          : (() => { throw new HttpError(400, 'INVALID_REQUEST', '必须提供 document 或 patch') })()
      const snapshot = projectService.replaceSnapshot(projectId, document, {
        expectedRevisionId,
        summary: typeof body.summary === 'string' ? body.summary : undefined,
      })
      eventHub.publish('project.updated', {
        project: snapshot.project as unknown as JsonValue,
        revisionId: snapshot.revision.id,
      }, { projectId })
      response.setHeader('ETag', snapshot.etag)
      response.json(snapshot)
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/v1/projects/:projectId/revisions', (request, response, next) => {
    try {
      response.json({ revisions: projectService.listRevisions(routeParam(request.params.projectId)) })
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/v1/projects/:projectId/revisions/:revisionId/restore', (request, response, next) => {
    try {
      const projectId = routeParam(request.params.projectId)
      const snapshot = projectService.restoreRevision(
        projectId,
        routeParam(request.params.revisionId),
        requiredIfMatch(request),
      )
      eventHub.publish('project.updated', {
        project: snapshot.project as unknown as JsonValue,
        revisionId: snapshot.revision.id,
      }, { projectId })
      response.setHeader('ETag', snapshot.etag)
      response.json(snapshot)
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/v1/episodes/:episodeId/timeline-document', (request, response, next) => {
    try {
      const snapshot = timelineDocumentService.get(routeParam(request.params.episodeId))
      response.setHeader('ETag', snapshot.etag)
      response.json(snapshot)
    } catch (error) {
      next(error)
    }
  })
  app.put('/api/v1/episodes/:episodeId/timeline-document', asyncRoute(async (request, response, next) => {
    try {
      const episodeId = routeParam(request.params.episodeId)
      const expectedRevisionId = requiredTimelineIfMatch(request)
      const body = requireObject(request.body, '时间线保存请求必须是 JSON 对象')
      const owner = database.withSql((sql) => sql.get(
        'SELECT project_id FROM episodes WHERE id = ?',
        episodeId,
      ))
      if (!owner || typeof owner.project_id !== 'string') {
        throw new TimelineDocumentError('EPISODE_NOT_FOUND', `Episode not found: ${episodeId}`)
      }
      if (body.projectId !== undefined && typeof body.projectId !== 'string') {
        throw new HttpError(400, 'INVALID_REQUEST', 'projectId 必须是字符串')
      }
      if (typeof body.schemaVersion !== 'number') {
        throw new HttpError(400, 'INVALID_SCHEMA_VERSION', 'schemaVersion 必须是正整数')
      }
      if (typeof body.upstreamCommit !== 'string') {
        throw new HttpError(400, 'INVALID_UPSTREAM_COMMIT', 'upstreamCommit 必须是完整 Git commit SHA')
      }
      if (Object.prototype.hasOwnProperty.call(body, 'sourceRevisionId')) {
        throw new HttpError(
          400,
          'INVALID_REQUEST',
          '普通时间线保存不能推进 sourceRevisionId，请使用 materialize/reconcile',
        )
      }
      if (body.summary !== undefined && typeof body.summary !== 'string') {
        throw new HttpError(400, 'INVALID_REQUEST', 'summary 必须是字符串')
      }
      const result = timelineDocumentService.save({
        projectId: typeof body.projectId === 'string' ? body.projectId : owner.project_id,
        episodeId,
        expectedRevisionId,
        schemaVersion: body.schemaVersion,
        upstreamCommit: body.upstreamCommit,
        ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
        document: requireObject(body.document, 'document 必须是 JSON 对象'),
      })
      await stalePipelinesForExternalTimelineChange(
        result.timelineDocument.projectId,
        episodeId,
        '时间线被外部编辑会话修改',
      )
      eventHub.publish('project.updated', {
        eventType: 'timeline.updated',
        episodeId,
        documentId: result.timelineDocument.id,
        revisionId: result.revision.id,
      }, { projectId: result.timelineDocument.projectId })
      response.status(result.created ? 201 : 200)
      response.setHeader('ETag', result.etag)
      response.json(result)
    } catch (error) {
      next(error)
    }
  }))
  for (const operation of ['materialize', 'reconcile'] as const) {
    app.post(`/api/v1/episodes/:episodeId/timeline-document/${operation}`, asyncRoute(async (request, response, next) => {
      try {
        const episodeId = routeParam(request.params.episodeId)
        const expectedRevisionId = requiredTimelineIfMatch(request)
        const body = request.body === undefined
          ? {} as JsonObject
          : requireObject(request.body, '时间线生成请求必须是 JSON 对象')
        const episode = storyRepository.getEpisode(episodeId)
        if (!episode) {
          throw new TimelineDocumentError('EPISODE_NOT_FOUND', `Episode not found: ${episodeId}`)
        }
        if (body.projectId !== undefined && typeof body.projectId !== 'string') {
          throw new HttpError(400, 'INVALID_REQUEST', 'projectId 必须是字符串')
        }
        if (body.summary !== undefined && typeof body.summary !== 'string') {
          throw new HttpError(400, 'INVALID_REQUEST', 'summary 必须是字符串')
        }
        const result = timelineMaterializationService[operation]({
          projectId: typeof body.projectId === 'string' ? body.projectId : episode.projectId,
          episodeId,
          expectedRevisionId,
          ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
        })
        await stalePipelinesForExternalTimelineChange(
          result.timelineDocument.projectId,
          episodeId,
          `时间线被外部 ${operation} 操作修改`,
        )
        eventHub.publish('project.updated', {
          eventType: operation === 'materialize'
            ? 'timeline.materialized'
            : 'timeline.reconciled',
          episodeId,
          documentId: result.timelineDocument.id,
          revisionId: result.revision.id,
          report: result.report as unknown as JsonValue,
        }, { projectId: result.timelineDocument.projectId })
        response.status(operation === 'materialize' ? 201 : 200)
        response.setHeader('ETag', result.etag)
        response.json(result)
      } catch (error) {
        next(error)
      }
    }))
  }
  app.post(
    '/api/v1/episodes/:episodeId/timeline-document/auto-edit/preview',
    asyncRoute(async (request, response) => {
      const episodeId = routeParam(request.params.episodeId)
      const expectedRevisionId = requiredExistingTimelineIfMatch(request)
      const body = requireObject(request.body, '自动剪辑预览请求必须是 JSON 对象')
      const unknown = Object.keys(body).filter((key) => key !== 'goal' && key !== 'policy')
      if (unknown.length > 0) {
        throw new HttpError(
          400,
          'INVALID_AUTO_EDIT_REQUEST',
          `预览不接受客户端剪辑内容: ${unknown.join(', ')}`,
        )
      }
      if (body.goal !== 'exportable' || body.policy !== 'safe') {
        throw new HttpError(
          400,
          'INVALID_AUTO_EDIT_REQUEST',
          "自动剪辑预览仅支持 goal='exportable' 与 policy='safe'",
        )
      }
      const current = timelineDocumentService.get(episodeId)
      const result = timelineAutoEditService.preview({
        projectId: current.timelineDocument.projectId,
        episodeId,
        expectedRevisionId,
        goal: body.goal,
        policy: body.policy,
      })
      response.setHeader('ETag', result.timeline.etag)
      response.json(result)
    }),
  )
  app.post(
    '/api/v1/episodes/:episodeId/timeline-document/auto-edit/apply',
    asyncRoute(async (request, response) => {
      const episodeId = routeParam(request.params.episodeId)
      const expectedRevisionId = requiredExistingTimelineIfMatch(request)
      const key = idempotencyKey(request, true)
      const body = requireObject(request.body, '自动剪辑应用请求必须是 JSON 对象')
      const unknown = Object.keys(body).filter((field) => (
        field !== 'planId' && field !== 'confirmationToken'
      ))
      if (unknown.length > 0) {
        throw new HttpError(
          400,
          'INVALID_AUTO_EDIT_REQUEST',
          `应用不接受客户端剪辑内容: ${unknown.join(', ')}`,
        )
      }
      if (typeof body.planId !== 'string' || typeof body.confirmationToken !== 'string') {
        throw new HttpError(
          400,
          'INVALID_AUTO_EDIT_REQUEST',
          '必须提供 planId 与 confirmationToken',
        )
      }
      const current = timelineDocumentService.get(episodeId)
      const result = timelineAutoEditService.apply({
        projectId: current.timelineDocument.projectId,
        episodeId,
        expectedRevisionId,
        idempotencyKey: key,
        planId: requestIdentifier(body.planId, 'planId'),
        confirmationToken: body.confirmationToken,
      })
      if (!result.idempotent) {
        await stalePipelinesForExternalTimelineChange(
          result.timeline.timelineDocument.projectId,
          episodeId,
          'Agentic 自动剪辑已应用新时间线修订',
        )
        eventHub.publish('project.updated', {
          eventType: 'timeline.auto-edit.applied',
          episodeId,
          documentId: result.timeline.timelineDocument.id,
          revisionId: result.timeline.revision.id,
          applicationId: result.application.id,
          planId: result.plan.id,
        }, { projectId: result.timeline.timelineDocument.projectId })
      }
      response.status(result.idempotent ? 200 : 201)
      response.setHeader('ETag', result.timeline.etag)
      response.json(result)
    }),
  )
  app.post(
    '/api/v1/timeline-edit-applications/:applicationId/undo',
    asyncRoute(async (request, response) => {
      const applicationId = requestIdentifier(
        routeParam(request.params.applicationId),
        'applicationId',
      )
      const expectedRevisionId = requiredExistingTimelineIfMatch(request)
      const key = idempotencyKey(request, true)
      const body = request.body === undefined
        ? {} as JsonObject
        : requireObject(request.body, '自动剪辑撤销请求必须是 JSON 对象')
      if (Object.keys(body).length > 0) {
        throw new HttpError(400, 'INVALID_AUTO_EDIT_REQUEST', '撤销请求不接受客户端剪辑内容')
      }
      const result = timelineAutoEditService.undo({
        applicationId,
        expectedRevisionId,
        idempotencyKey: key,
      })
      if (!result.idempotent) {
        await stalePipelinesForExternalTimelineChange(
          result.timeline.timelineDocument.projectId,
          result.application.episodeId,
          'Agentic 自动剪辑已撤销为新时间线修订',
        )
        eventHub.publish('project.updated', {
          eventType: 'timeline.auto-edit.undone',
          episodeId: result.application.episodeId,
          documentId: result.timeline.timelineDocument.id,
          revisionId: result.timeline.revision.id,
          applicationId: result.application.id,
          undoId: result.undo.id,
        }, { projectId: result.timeline.timelineDocument.projectId })
      }
      response.status(result.idempotent ? 200 : 201)
      response.setHeader('ETag', result.timeline.etag)
      response.json(result)
    }),
  )
  app.get('/api/v1/timeline-documents/:documentId/revisions', (request, response, next) => {
    try {
      const history = timelineDocumentService.listRevisions(
        routeParam(request.params.documentId),
        {
          limit: positiveInteger(request.query.limit, 'limit', 100),
          offset: nonNegativeInteger(request.query.offset, 'offset', 1_000_000),
        },
      )
      const etag = `W/"${history.timelineDocument.currentRevisionId}"`
      response.setHeader('ETag', etag)
      response.json({ ...history, etag })
    } catch (error) {
      next(error)
    }
  })
  app.post(
    '/api/v1/episodes/:episodeId/timeline-document/revisions/:revisionId/restore',
    asyncRoute(async (request, response) => {
      const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
      const targetRevisionId = requestIdentifier(
        routeParam(request.params.revisionId),
        'revisionId',
      )
      const expectedRevisionId = requiredExistingTimelineIfMatch(request)
      const key = idempotencyKey(request, true)
      const body = requireObject(request.body, '时间线恢复请求必须是 JSON 对象')
      const unknown = Object.keys(body).filter((field) => (
        field !== 'projectId' && field !== 'documentId' && field !== 'summary'
      ))
      if (unknown.length > 0) {
        throw new HttpError(
          400,
          'INVALID_TIMELINE_RESTORE_REQUEST',
          `恢复请求包含不支持的字段: ${unknown.join(', ')}`,
        )
      }
      if (typeof body.projectId !== 'string' || typeof body.documentId !== 'string') {
        throw new HttpError(
          400,
          'INVALID_TIMELINE_RESTORE_REQUEST',
          '必须提供 projectId 与 documentId',
        )
      }
      if (body.summary !== undefined && typeof body.summary !== 'string') {
        throw new HttpError(400, 'INVALID_TIMELINE_RESTORE_REQUEST', 'summary 必须是字符串')
      }
      const result = timelineRevisionRestoreService.restore({
        projectId: requestIdentifier(body.projectId, 'projectId'),
        episodeId,
        documentId: requestIdentifier(body.documentId, 'documentId'),
        targetRevisionId,
        expectedRevisionId,
        idempotencyKey: key,
        ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
      })
      if (!result.idempotent) {
        eventHub.publish('project.updated', {
          eventType: 'timeline.revision.restored',
          episodeId,
          documentId: result.restore.documentId,
          baseRevisionId: result.restore.baseRevisionId,
          targetRevisionId: result.restore.targetRevisionId,
          revisionId: result.restore.resultRevisionId,
          stale: result.stale as unknown as JsonValue,
        }, { projectId: result.restore.projectId })
      }
      response.status(result.idempotent ? 200 : 201)
      response.setHeader('ETag', result.timeline.etag)
      response.json({
        timeline: result.timeline,
        operationResultTimeline: result.operationResultTimeline,
        headAdvanced: result.headAdvanced,
        restore: result.restore,
        idempotent: result.idempotent,
      })
    }),
  )

  app.post('/api/v1/episodes/:episodeId/exports', asyncRoute(async (request, response) => {
    const episodeId = routeParam(request.params.episodeId)
    const body = requireObject(request.body, '导出请求必须是 JSON 对象')
    const allowed = new Set([
      'projectId',
      'timelineRevisionId',
      'resolution',
      'kenBurns',
      'burnSubtitles',
      'introTitle',
      'outroCard',
      'reviewWatermark',
    ])
    const unknown = Object.keys(body).filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_EXPORT_REQUEST', `不支持的导出参数: ${unknown.join(', ')}`)
    }
    if (typeof body.projectId !== 'string') {
      throw new HttpError(400, 'INVALID_EXPORT_REQUEST', 'projectId 必须是字符串')
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const resolution = body.resolution
    if (resolution !== '720p' && resolution !== '1080p') {
      throw new HttpError(400, 'INVALID_EXPORT_REQUEST', 'resolution 必须是 720p 或 1080p')
    }
    if (body.timelineRevisionId !== undefined && typeof body.timelineRevisionId !== 'string') {
      throw new HttpError(400, 'INVALID_EXPORT_REQUEST', 'timelineRevisionId 必须是字符串')
    }
    if (body.kenBurns !== undefined && typeof body.kenBurns !== 'boolean') {
      throw new HttpError(400, 'INVALID_EXPORT_REQUEST', 'kenBurns 必须是布尔值')
    }
    if (body.burnSubtitles !== undefined && typeof body.burnSubtitles !== 'boolean') {
      throw new HttpError(400, 'INVALID_EXPORT_REQUEST', 'burnSubtitles 必须是布尔值')
    }
    if (body.introTitle !== undefined && typeof body.introTitle !== 'boolean') {
      throw new HttpError(400, 'INVALID_EXPORT_REQUEST', 'introTitle 必须是布尔值')
    }
    if (body.outroCard !== undefined && typeof body.outroCard !== 'boolean') {
      throw new HttpError(400, 'INVALID_EXPORT_REQUEST', 'outroCard 必须是布尔值')
    }
    if (body.reviewWatermark !== undefined && typeof body.reviewWatermark !== 'boolean') {
      throw new HttpError(400, 'INVALID_EXPORT_REQUEST', 'reviewWatermark 必须是布尔值')
    }
    const expectedTimelineRevisionId = optionalTimelineIfMatch(request)
    const timelineRevisionId = typeof body.timelineRevisionId === 'string'
      ? requestIdentifier(body.timelineRevisionId, 'timelineRevisionId')
      : undefined
    if (!timelineRevisionId && !expectedTimelineRevisionId) {
      throw new HttpError(
        428,
        'PRECONDITION_REQUIRED',
        '必须提供 timelineRevisionId 或 If-Match 以固化时间线修订',
      )
    }
    const key = idempotencyKey(request, true)
    const result = await withJobAdmission(async () => {
      const existing = database.findGenerationJobByIdempotencyKey(projectId, key)
      if (!existing && activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return exportRenderService.create({
        projectId,
        episodeId,
        resolution,
        idempotencyKey: key,
        ...(timelineRevisionId ? { timelineRevisionId } : {}),
        ...(expectedTimelineRevisionId ? { expectedTimelineRevisionId } : {}),
        ...(typeof body.kenBurns === 'boolean' ? { kenBurns: body.kenBurns } : {}),
        ...(typeof body.burnSubtitles === 'boolean' ? { burnSubtitles: body.burnSubtitles } : {}),
        ...(typeof body.introTitle === 'boolean' ? { introTitle: body.introTitle } : {}),
        ...(typeof body.outroCard === 'boolean' ? { outroCard: body.outroCard } : {}),
        ...(typeof body.reviewWatermark === 'boolean'
          ? { reviewWatermark: body.reviewWatermark }
          : {}),
      })
    })
    const outputAsset = result.export.outputAssetId
      ? database.getMediaAsset(result.export.outputAssetId)
      : undefined
    const exported = exportRecordAsJson(result.export, result.job, outputAsset)
    if (result.created) {
      eventHub.publish('job.created', {
        eventType: 'export.created',
        export: exported as unknown as JsonValue,
        job: publicJob(result.job, database),
      }, { projectId: result.export.projectId })
    }
    if (result.job.status === 'queued' || result.job.status === 'waiting_provider') {
      worker.enqueue(result.job.id)
    }
    response.status(result.created ? 202 : 200).json({
      export: exported,
      job: publicJob(result.job, database),
    })
  }))
  app.get('/api/v1/exports/:id', (request, response, next) => {
    try {
      const record = exportRenderService.require(routeParam(request.params.id))
      const job = exportRenderService.jobForExport(record.id)
      const outputAsset = record.outputAssetId
        ? database.getMediaAsset(record.outputAssetId)
        : undefined
      response.json({ export: exportRecordAsJson(record, job, outputAsset) })
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/v1/exports/:id/quality-checks', asyncRoute(async (request, response) => {
    const exportId = routeParam(request.params.id)
    const body = request.body === undefined
      ? {}
      : requireObject(request.body, '质检请求必须是 JSON 对象')
    const unknown = Object.keys(body)
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_QUALITY_REQUEST', `不支持的质检参数: ${unknown.join(', ')}`)
    }
    const key = idempotencyKey(request, true)
    const result = await withJobAdmission(async () => {
      const exported = exportRenderService.require(exportId)
      const existing = database.findGenerationJobByIdempotencyKey(exported.projectId, key)
      if (!existing && activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return qualityCheckService.create({ exportId, idempotencyKey: key })
    })
    const report = qualityReportAsJson(result.report, result.job)
    if (result.created) {
      eventHub.publish('job.created', {
        eventType: 'quality-check.created',
        qualityReport: report as unknown as JsonValue,
        job: publicJob(result.job, database),
      }, { projectId: result.report.projectId })
    }
    if (result.job.status === 'queued' || result.job.status === 'waiting_provider') {
      worker.enqueue(result.job.id)
    }
    response.status(result.created ? 202 : 200).json({
      qualityReport: report,
      job: publicJob(result.job, database),
    })
  }))
  app.get('/api/v1/quality-reports/:id', (request, response, next) => {
    try {
      const report = qualityCheckService.require(routeParam(request.params.id))
      const job = qualityCheckService.jobForReport(report.id)
      response.json({ qualityReport: qualityReportAsJson(report, job) })
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/v1/exports/:id/release-reviews', (request, response, next) => {
    try {
      const releaseReviews = releaseReviewService.list(routeParam(request.params.id))
      response.json({ releaseReviews })
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/v1/exports/:id/release-reviews', (request, response, next) => {
    try {
      const body = requireObject(request.body, '发行复验请求必须是 JSON 对象')
      const unknown = Object.keys(body).filter((key) => ![
        'decision',
        'checklist',
        'notes',
      ].includes(key))
      if (unknown.length > 0) {
        throw new ReleaseReviewError(
          'INVALID_RELEASE_REVIEW',
          `不支持的发行复验参数: ${unknown.join(', ')}`,
        )
      }
      const result = releaseReviewService.create({
        exportId: routeParam(request.params.id),
        idempotencyKey: idempotencyKey(request, true),
        decision: body.decision as ReleaseReviewDecision,
        checklist: body.checklist as unknown as ReleaseReviewChecklist,
        notes: body.notes as string | null | undefined,
      })
      response.status(result.created ? 201 : 200).json({
        releaseReview: result.releaseReview,
      })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/v1/jobs/:id/voice-preview-reviews', (request, response, next) => {
    try {
      const projectId = requestIdentifier(queryString(request.query.projectId), 'projectId')
      const reviews = voicePreviewReviewService.list(projectId, routeParam(request.params.id))
      response.json({ reviews })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/v1/jobs/:id/voice-preview-reviews', (request, response, next) => {
    try {
      const body = requireObject(request.body, '声线试听验收请求必须是 JSON 对象')
      const unknown = Object.keys(body).filter((key) => ![
        'projectId',
        'decision',
        'playbackCompleted',
        'playbackEvidence',
        'notes',
      ].includes(key))
      if (unknown.length > 0) {
        throw new VoicePreviewReviewError(
          'INVALID_VOICE_PREVIEW_REVIEW',
          `不支持的声线试听验收参数: ${unknown.join(', ')}`,
        )
      }
      const result = voicePreviewReviewService.create({
        projectId: body.projectId as string,
        previewJobId: routeParam(request.params.id),
        idempotencyKey: idempotencyKey(request, true),
        decision: body.decision as VoicePreviewReviewDecision,
        playbackCompleted: body.playbackCompleted as boolean,
        playbackEvidence: body.playbackEvidence,
        notes: body.notes as string | null | undefined,
      })
      response.status(result.created ? 201 : 200).json({ review: result.review })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/v1/jobs', (request, response, next) => {
    try {
      const limit = positiveInteger(request.query.limit, 'limit', 200)
      const status = queryString(request.query.status) as JobStatus | undefined
      if (status && ![...ACTIVE_JOB_STATUSES, 'succeeded', 'failed', 'cancelled'].includes(status)) {
        throw new HttpError(400, 'INVALID_STATUS', 'status 参数无效')
      }
      const jobs = database.listGenerationJobs({
        projectId: queryString(request.query.projectId),
        type: queryString(request.query.type),
        status,
        limit,
      }).map((job) => publicJob(job, database))
      response.json({ jobs })
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/v1/jobs/:id', (request, response, next) => {
    try {
      const job = database.getGenerationJob(routeParam(request.params.id))
      if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', '任务不存在')
      response.json({ job: publicJob(job, database) })
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/v1/jobs/:id/retry', asyncRoute(async (request, response) => {
    const jobId = routeParam(request.params.id)
    jobs.assertGenericRetryAllowed(jobId)
    const result = await withJobAdmission(async () => {
      if (!jobs.hasRetryChild(jobId) && activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return worker.retry(jobId, {
        idempotencyKey: request.get('idempotency-key')?.trim() || undefined,
      })
    })
    const durable = database.getGenerationJob(result.job.id)
    if (!durable) throw new Error('Retried job disappeared')
    response.status(result.created ? 202 : 200).json({ job: publicJob(durable, database) })
  }))
  app.post('/api/v1/jobs/:id/cancel', asyncRoute(async (request, response) => {
    const jobId = routeParam(request.params.id)
    const current = database.getGenerationJob(jobId)
    const job = await worker.cancel(
      jobId,
      current?.type === SHOT_VIDEO_GENERATION_JOB_TYPE
        ? '本地视频处理已停止；供应商任务仍可能继续运行或产生费用，请查看取消详情'
        : '任务已取消',
    )
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', '任务不存在')
    const durable = database.getGenerationJob(job.id)
    if (!durable) throw new Error('Cancelled job disappeared')
    response.json({ job: publicJob(durable, database) })
  }))

  app.get('/api/v1/episodes/:episodeId/visual-asset-targets', (request, response, next) => {
    try {
      const projectId = queryString(request.query.projectId)
      if (!projectId) throw new HttpError(400, 'PROJECT_ID_REQUIRED', '必须提供 projectId')
      const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
      const episode = database.withSql((sql) => sql.get(`
        SELECT source_revision_id FROM episodes WHERE id = ? AND project_id = ?
      `, episodeId, projectId))
      if (!episode) {
        throw new HttpError(404, 'EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
      }
      response.json({
        episodeId,
        sourceRevisionId: typeof episode.source_revision_id === 'string'
          ? episode.source_revision_id
          : null,
        targets: listVisualAssetTargets(database, { projectId, episodeId }),
      })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/v1/assets', (request, response, next) => {
    try {
      const projectId = queryString(request.query.projectId)
      if (!projectId) throw new HttpError(400, 'PROJECT_ID_REQUIRED', '必须提供 projectId')
      if (!database.getProject(projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', '项目不存在')
      const assets = database.listMediaAssets({
        projectId,
        episodeId: queryString(request.query.episodeId),
        includeProjectAssets: queryBoolean(request.query.includeProjectAssets, 'includeProjectAssets'),
        kind: queryString(request.query.kind),
        limit: positiveInteger(request.query.limit, 'limit', 200),
      }).map(publicAsset)
      response.json({ assets })
    } catch (error) {
      next(error)
    }
  })
  app.get('/api/v1/assets/:id', (request, response, next) => {
    try {
      const asset = database.getMediaAsset(routeParam(request.params.id))
      if (!asset) throw new HttpError(404, 'ASSET_NOT_FOUND', '资产不存在')
      const etag = assetImageEditEtag(asset)
      if (etag) response.setHeader('ETag', etag)
      response.json({ asset: publicAsset(asset) })
    } catch (error) {
      next(error)
    }
  })
  const serveAsset = async (
    request: Request,
    response: Response,
    assetId?: string,
    options: { allowExportVideo?: boolean } = {},
  ) => {
    const opened = await mediaStore.openAsset(assetId ?? routeParam(request.params.id))
    // The client may disconnect while openAsset performs its realpath/stat/
    // MIME verification. In that race the response `close` event has already
    // fired before a stream listener can be attached, so piping would leave
    // the verified FileHandle unreachable until GC. Close it explicitly.
    if (request.destroyed || response.destroyed) {
      await opened.file.close().catch(() => undefined)
      return
    }
    if (opened.asset.kind === 'export.video' && !options.allowExportVideo) {
      await opened.file.close()
      throw new HttpError(
        423,
        'EXPORT_QC_GATE_REQUIRED',
        '导出成片不能通过通用资产地址访问，请使用通过质检门禁的导出下载地址',
      )
    }
    const etag = opened.asset.checksum ? `"${opened.asset.checksum}"` : undefined
    response.setHeader('Content-Type', opened.mimeType)
    response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    if (etag) response.setHeader('ETag', etag)
    if (etag && request.get('if-none-match') === etag) {
      await opened.file.close()
      response.status(304).end()
      return
    }
    let range
    try {
      range = rangeFor(opened.size, request.get('range'))
    } catch (error) {
      await opened.file.close()
      response.setHeader('Content-Range', `bytes */${opened.size}`)
      throw error
    }
    const start = range?.start ?? 0
    const end = range?.end ?? opened.size - 1
    if (range) {
      response.status(206)
      response.setHeader('Content-Range', `bytes ${start}-${end}/${opened.size}`)
    }
    response.setHeader('Content-Length', String(end - start + 1))
    if (request.method === 'HEAD') {
      await opened.file.close()
      response.end()
      return
    }
    const stream = opened.file.createReadStream({ start, end, autoClose: true })
    const destroyStream = () => stream.destroy()
    const closeVerifiedHandle = () => {
      response.off('close', destroyStream)
      void opened.file.close().catch(() => undefined)
    }
    stream.once('close', closeVerifiedHandle)
    stream.once('error', () => {
      if (!response.headersSent) response.status(500)
      response.end()
    })
    response.once('close', destroyStream)
    if (response.destroyed) destroyStream()
    stream.pipe(response)
  }
  app.get('/api/v1/assets/:id/content', asyncRoute(async (request, response) => serveAsset(request, response)))
  app.head('/api/v1/assets/:id/content', asyncRoute(async (request, response) => serveAsset(request, response)))
  const reviewDownload = async (request: Request, response: Response) => {
    const authorized = releaseReviewService.requireTechnicalAuthorization(
      routeParam(request.params.id),
    )
    const safeId = authorized.export.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
      || 'episode'
    response.setHeader('Content-Disposition', `attachment; filename="manju-review-${safeId}.mp4"`)
    await serveAsset(request, response, authorized.asset.id, { allowExportVideo: true })
  }
  app.get('/api/v1/exports/:id/review-download', asyncRoute(reviewDownload))
  app.head('/api/v1/exports/:id/review-download', asyncRoute(reviewDownload))
  const downloadExport = async (request: Request, response: Response) => {
    const authorized = releaseReviewService.requireReleaseAuthorization(
      routeParam(request.params.id),
    )
    const safeId = authorized.export.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
      || 'episode'
    response.setHeader('Content-Disposition', `attachment; filename="manju-${safeId}.mp4"`)
    await serveAsset(request, response, authorized.asset.id, { allowExportVideo: true })
  }
  app.get('/api/v1/exports/:id/download', asyncRoute(downloadExport))
  app.head('/api/v1/exports/:id/download', asyncRoute(downloadExport))

  app.get('/api/v1/providers/minimax-speech/voices', asyncRoute(async (request, response) => {
    const unknown = Object.keys(request.query).filter((key) => key !== 'q')
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `不支持的音色目录查询参数: ${unknown.join(', ')}`)
    }
    const query = queryString(request.query.q)?.trim().toLocaleLowerCase() ?? ''
    if (query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) {
      throw new HttpError(400, 'INVALID_REQUEST', '音色搜索词无效')
    }
    const catalog = await miniMaxVoiceCatalogService.list()
    const voices = query
      ? catalog.voices.filter((voice) => [voice.voiceId, voice.name, ...voice.descriptions]
          .some((value) => value.toLocaleLowerCase().includes(query)))
      : catalog.voices
    response.json({
      provider: {
        id: catalog.providerId,
        configRevision: catalog.providerConfigRevision,
        model: catalog.model,
      },
      observedAt: catalog.observedAt,
      fingerprint: catalog.fingerprint,
      voices,
    })
  }))

  app.get('/api/v1/providers/indextts-speech/voices', asyncRoute(async (request, response) => {
    const unknown = Object.keys(request.query).filter((key) => key !== 'q')
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `不支持的声线目录查询参数: ${unknown.join(', ')}`)
    }
    const query = queryString(request.query.q)?.trim().toLocaleLowerCase() ?? ''
    if (query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) {
      throw new HttpError(400, 'INVALID_REQUEST', '声线搜索词无效')
    }
    const catalog = await indexTtsVoiceCatalogService.list()
    const voices = query
      ? catalog.voices.filter((voice) => [voice.voiceId, voice.name, ...voice.descriptions]
          .some((value) => value.toLocaleLowerCase().includes(query)))
      : catalog.voices
    response.json({
      provider: {
        id: catalog.providerId,
        configRevision: catalog.providerConfigRevision,
        model: catalog.model,
      },
      observedAt: catalog.observedAt,
      fingerprint: catalog.fingerprint,
      voices,
    })
  }))

  app.get('/api/v1/providers/doubao-speech/voices', asyncRoute(async (request, response) => {
    const unknown = Object.keys(request.query).filter((key) => key !== 'q')
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `不支持的声线目录查询参数: ${unknown.join(', ')}`)
    }
    const query = queryString(request.query.q)?.trim().toLocaleLowerCase() ?? ''
    if (query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) {
      throw new HttpError(400, 'INVALID_REQUEST', '声线搜索词无效')
    }
    const catalog = await doubaoVoiceCatalogService.list()
    const voices = query
      ? catalog.voices.filter((voice) => [voice.voiceId, voice.name, ...voice.descriptions]
          .some((value) => value.toLocaleLowerCase().includes(query)))
      : catalog.voices
    response.json({
      provider: {
        id: catalog.providerId,
        configRevision: catalog.providerConfigRevision,
        model: catalog.model,
      },
      observedAt: catalog.observedAt,
      fingerprint: catalog.fingerprint,
      voices,
    })
  }))

  app.get('/api/v1/projects/:projectId/narrator-voice-profile', asyncRoute(async (request, response) => {
    const projectId = requestIdentifier(routeParam(request.params.projectId), 'projectId')
    if (Object.keys(request.query).length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', '项目旁白声线查询不支持额外参数')
    }
    const state = projectNarratorVoiceProfiles.get(projectId)
    const project = database.getProject(projectId)
    if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', '项目不存在')
    response.setHeader('ETag', state.projectEtag)
    response.json({
      project: {
        id: project.id,
        title: project.title,
        currentRevisionId: project.currentRevisionId,
        updatedAt: project.updatedAt,
      },
      voiceProfile: state.profile,
      revisionId: state.revisionId,
    })
  }))

  app.put('/api/v1/projects/:projectId/narrator-voice-profile', asyncRoute(async (request, response) => {
    const projectId = requestIdentifier(routeParam(request.params.projectId), 'projectId')
    const body = requireObject(request.body, '项目旁白声线设置必须是 JSON 对象')
    const allowed = new Set([
      'providerId',
      'voiceId',
      'expectedCatalogFingerprint',
      'expectedProviderConfigRevision',
    ])
    const unknown = Object.keys(body).filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `不支持的项目旁白声线参数: ${unknown.join(', ')}`)
    }
    const voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : ''
    const providerId = body.providerId === undefined
      ? 'minimax-speech'
      : requestIdentifier(body.providerId, 'providerId')
    if (!voiceId || voiceId.length > 256 || /[\u0000-\u001f\u007f]/.test(voiceId)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'voiceId 格式无效')
    }
    if (typeof body.expectedCatalogFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(body.expectedCatalogFingerprint)) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'expectedCatalogFingerprint 必须是当前音色目录 fingerprint',
      )
    }
    if (!Number.isInteger(body.expectedProviderConfigRevision)
      || (body.expectedProviderConfigRevision as number) < 1) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'expectedProviderConfigRevision 必须是当前 Provider 正整数版本',
      )
    }
    const expectedProjectVersion = requiredIfMatch(request)
    const catalog = await speechVoiceCatalog(providerId)
    if (catalog.providerConfigRevision !== body.expectedProviderConfigRevision) {
      throw new HttpError(
        409,
        'VOICE_CATALOG_REVISION_CHANGED',
        '语音 Provider 配置已变化，请刷新声线目录后重新选择',
      )
    }
    if (catalog.fingerprint !== body.expectedCatalogFingerprint) {
      throw new HttpError(
        409,
        'VOICE_CATALOG_CHANGED',
        '音色目录已变化，请刷新后重新选择',
      )
    }
    const voice = catalog.voices.find((candidate) => candidate.voiceId === voiceId)
    if (!voice) {
      throw new HttpError(
        409,
        'VOICE_NOT_AVAILABLE',
        '所选 voiceId 不在当前 Provider 的真实声线目录中',
      )
    }
    const saved = projectNarratorVoiceProfiles.save({
      projectId,
      expectedProjectVersion,
      profile: {
        version: 1,
        voiceId: voice.voiceId,
        providerId: catalog.providerId,
        providerConfigRevision: catalog.providerConfigRevision,
        voiceType: voice.type,
        voiceName: voice.name,
        descriptions: [...voice.descriptions],
        selectionSource: 'manual',
        catalogFingerprint: catalog.fingerprint,
        catalogObservedAt: catalog.observedAt,
        historicalPin: false,
        updatedAt: new Date().toISOString(),
      },
    })
    await Promise.all(saved.stale.activeJobIds.map((jobId) => worker.cancel(
      jobId,
      '项目旁白声线已修改，已停止本地处理；若上游请求已提交，仍可能继续执行或产生费用',
    )))
    const { activeJobIds: _activeJobIds, ...publicStale } = saved.stale
    const project = database.getProject(projectId)
    if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', '项目已被删除')
    response.setHeader('ETag', saved.state.projectEtag)
    response.json({
      project: {
        id: project.id,
        title: project.title,
        currentRevisionId: project.currentRevisionId,
        updatedAt: project.updatedAt,
      },
      voiceProfile: saved.state.profile,
      revisionId: saved.revision.id,
      stale: publicStale,
    })
  }))

  app.delete('/api/v1/projects/:projectId/narrator-voice-profile', asyncRoute(async (request, response) => {
    const projectId = requestIdentifier(routeParam(request.params.projectId), 'projectId')
    if (Object.keys(request.query).length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', '项目旁白声线删除不支持额外参数')
    }
    const current = projectNarratorVoiceProfiles.get(projectId)
    if (!current.profile) {
      throw new ProjectNarratorVoiceProfileError(
        'PROJECT_NARRATOR_VOICE_PROFILE_NOT_FOUND',
        '项目尚未绑定旁白声线',
      )
    }
    const saved = projectNarratorVoiceProfiles.save({
      projectId,
      expectedProjectVersion: requiredIfMatch(request),
      profile: null,
    })
    await Promise.all(saved.stale.activeJobIds.map((jobId) => worker.cancel(
      jobId,
      '项目旁白声线已清除，已停止本地处理；若上游请求已提交，仍可能继续执行或产生费用',
    )))
    const { activeJobIds: _activeJobIds, ...publicStale } = saved.stale
    const project = database.getProject(projectId)
    if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', '项目已被删除')
    response.setHeader('ETag', saved.state.projectEtag)
    response.json({
      project: {
        id: project.id,
        title: project.title,
        currentRevisionId: project.currentRevisionId,
        updatedAt: project.updatedAt,
      },
      voiceProfile: null,
      revisionId: saved.revision.id,
      stale: publicStale,
    })
  }))

  app.post('/api/v1/episodes/:episodeId/narrator-voice-previews', asyncRoute(async (request, response) => {
    const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
    const body = requireObject(request.body, '项目旁白试听请求必须是 JSON 对象')
    const unknown = Object.keys(body).filter((key) => (
      key !== 'projectId'
      && key !== 'providerId'
      && key !== 'voiceId'
      && key !== 'expectedCatalogFingerprint'
    ))
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `不支持的项目旁白试听参数: ${unknown.join(', ')}`)
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const providerId = body.providerId === undefined
      ? 'minimax-speech'
      : requestIdentifier(body.providerId, 'providerId')
    if (providerId !== 'minimax-speech'
      && providerId !== 'indextts-speech'
      && providerId !== 'doubao-speech') {
      throw new HttpError(400, 'INVALID_REQUEST', 'providerId 不支持声线试听')
    }
    const voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : ''
    if (!voiceId || voiceId.length > 256 || /[\u0000-\u001f\u007f]/.test(voiceId)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'voiceId 格式无效')
    }
    if (typeof body.expectedCatalogFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(body.expectedCatalogFingerprint)) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'expectedCatalogFingerprint 必须是当前音色目录 fingerprint',
      )
    }
    const expectedCatalogFingerprint = body.expectedCatalogFingerprint
    const submissionKey = idempotencyKey(request, true)
    const expectedEpisodeVersion = requiredEpisodeIfMatch(request)
    const assertReplayMatches = (existing: GenerationJobRecord) => {
      if (existing.type !== PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE
        || existing.projectId !== projectId
        || existing.episodeId !== episodeId
        || existing.resourceId !== projectId
        || existing.providerId !== providerId
        || existing.providerConfigRevision !== existing.input.expectedProviderConfigRevision
        || typeof existing.model !== 'string'
        || !existing.model
        || existing.input.voiceId !== voiceId
        || existing.input.expectedCatalogFingerprint !== expectedCatalogFingerprint
        || existing.input.expectedEpisodeVersion !== expectedEpisodeVersion) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
      }
    }
    const existing = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
    if (existing) {
      assertReplayMatches(existing)
      response.status(200).json({ job: publicJob(existing, database) })
      return
    }

    const episode = storyRepository.getEpisode(episodeId)
    if (!episode || episode.projectId !== projectId) {
      throw new HttpError(404, 'EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
    }
    if (!episodeVersionMatches(episode, expectedEpisodeVersion)) {
      throw new HttpError(412, 'REVISION_CONFLICT', '分集已被其他操作更新，请刷新后重试', {
        currentEtag: episodeEtag(episode),
      })
    }
    const target = resolveProjectNarratorVoicePreviewTarget(database, { projectId, episodeId })
    const catalog = await speechVoiceCatalog(providerId)
    if (catalog.fingerprint !== expectedCatalogFingerprint) {
      throw new HttpError(
        409,
        'VOICE_CATALOG_CHANGED',
        '音色目录已变化，未发起试听计费请求；请刷新目录后重试',
      )
    }
    if (!catalog.voices.some((voice) => voice.voiceId === voiceId)) {
      throw new HttpError(
        409,
        'VOICE_NOT_AVAILABLE',
        '所选音色已不在当前语音 Provider 目录中，未发起试听请求',
      )
    }
    const input: ProjectNarratorVoicePreviewJobInput & { expectedEpisodeVersion: string } = {
      episodeId,
      expectedStoryRevisionId: target.sourceRevisionId,
      voiceId,
      expectedCatalogFingerprint,
      expectedProviderConfigRevision: catalog.providerConfigRevision,
      expectedEpisodeVersion,
    }
    requirePaidAigcConfirmation(request, {
      action: 'project.narrator.voice.preview',
      projectId,
      episodeId,
      resourceId: projectId,
      idempotencyKey: submissionKey,
      provider: {
        providerId: catalog.providerId,
        model: catalog.model,
        configRevision: catalog.providerConfigRevision,
      },
      input: input as unknown as JsonValue,
    }, '项目旁白声线试听')
    const result = await withJobAdmission(async () => {
      const raced = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
      if (raced) {
        assertReplayMatches(raced)
        if (!sameProjectNarratorVoicePreviewSubmission(raced, input)) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
        }
        return { job: raced, created: false }
      }
      const activePreview = database.listGenerationJobs({
        projectId,
        episodeId,
        type: PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE,
        limit: maxQueueDepth,
      }).find((job) => ['queued', 'running', 'waiting_provider'].includes(job.status))
      if (activePreview) {
        throw new HttpError(
          409,
          'VOICE_PREVIEW_ALREADY_ACTIVE',
          '本集已有项目旁白试听正在处理；请等待当前试听完成或先停止，再选择其他音色',
          { existingJobId: activePreview.id },
        )
      }
      if (activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return worker.submit({
        type: PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE,
        input,
        idempotencyKey: submissionKey,
        resourceKey: 'provider:speech',
        projectId,
        providerId: catalog.providerId,
        model: catalog.model,
        providerConfigRevision: catalog.providerConfigRevision,
        metadata: { episodeId, resourceId: projectId },
      })
    })
    const durable = database.getGenerationJob(result.job.id)
    if (!durable) throw new Error('Created project narrator voice preview job disappeared')
    response.status(result.created ? 202 : 200).setHeader('ETag', episodeEtag(episode))
    response.json({ job: publicJob(durable, database) })
  }))

  const characterVoiceTarget = (episodeId: string, characterId: string, projectId: string) => {
    const episode = storyRepository.getEpisode(episodeId)
    if (!episode || episode.projectId !== projectId) {
      throw new HttpError(404, 'EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
    }
    const story = storyRepository.getStory(episodeId)
    const character = story?.characters.find((candidate) => candidate.id === characterId)
    if (!character) throw new HttpError(404, 'CHARACTER_NOT_FOUND', '角色不存在或不属于指定分集')
    return { episode, character }
  }

  app.get('/api/v1/episodes/:episodeId/characters/:characterId/voice-profile', asyncRoute(async (request, response) => {
    const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
    const characterId = requestIdentifier(routeParam(request.params.characterId), 'characterId')
    const projectId = requestIdentifier(queryString(request.query.projectId), 'projectId')
    const { episode, character } = characterVoiceTarget(episodeId, characterId, projectId)
    const record = characterVoiceProfiles.get(projectId, episodeId, characterId)
    response.setHeader('ETag', episodeEtag(episode))
    response.json({
      episode: {
        id: episode.id,
        projectId: episode.projectId,
        sourceRevisionId: episode.sourceRevisionId,
        updatedAt: episode.updatedAt,
      },
      character: { id: character.id, name: character.name, role: character.role },
      voiceProfile: record?.profile ?? null,
      revisionId: record?.revisionId ?? null,
    })
  }))

  app.post('/api/v1/episodes/:episodeId/characters/:characterId/voice-previews', asyncRoute(async (request, response) => {
    const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
    const characterId = requestIdentifier(routeParam(request.params.characterId), 'characterId')
    const body = requireObject(request.body, '角色声线试听请求必须是 JSON 对象')
    const unknown = Object.keys(body).filter((key) => (
      key !== 'projectId'
      && key !== 'providerId'
      && key !== 'voiceId'
      && key !== 'expectedCatalogFingerprint'
    ))
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `不支持的声线试听参数: ${unknown.join(', ')}`)
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const providerId = body.providerId === undefined
      ? 'minimax-speech'
      : requestIdentifier(body.providerId, 'providerId')
    if (providerId !== 'minimax-speech'
      && providerId !== 'indextts-speech'
      && providerId !== 'doubao-speech') {
      throw new HttpError(400, 'INVALID_REQUEST', 'providerId 不支持声线试听')
    }
    const voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : ''
    if (!voiceId || voiceId.length > 256 || /[\u0000-\u001f\u007f]/.test(voiceId)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'voiceId 格式无效')
    }
    if (typeof body.expectedCatalogFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(body.expectedCatalogFingerprint)) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'expectedCatalogFingerprint 必须是当前音色目录 fingerprint',
      )
    }
    const expectedCatalogFingerprint = body.expectedCatalogFingerprint
    const submissionKey = idempotencyKey(request, true)
    const expectedEpisodeVersion = requiredEpisodeIfMatch(request)
    const assertReplayMatches = (existing: GenerationJobRecord) => {
      if (existing.type !== CHARACTER_VOICE_PREVIEW_JOB_TYPE
        || existing.projectId !== projectId
        || existing.episodeId !== episodeId
        || existing.resourceId !== existing.input.characterDatabaseId
        || existing.providerId !== providerId
        || existing.providerConfigRevision !== existing.input.expectedProviderConfigRevision
        || typeof existing.model !== 'string'
        || !existing.model
        || existing.input.characterId !== characterId
        || existing.input.voiceId !== voiceId
        || existing.input.expectedCatalogFingerprint !== expectedCatalogFingerprint
        || existing.input.expectedEpisodeVersion !== expectedEpisodeVersion) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
      }
    }
    const existing = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
    if (existing) {
      assertReplayMatches(existing)
      response.status(200).json({ job: publicJob(existing, database) })
      return
    }

    const { episode } = characterVoiceTarget(episodeId, characterId, projectId)
    if (!episodeVersionMatches(episode, expectedEpisodeVersion)) {
      throw new HttpError(412, 'REVISION_CONFLICT', '分集已被其他操作更新，请刷新后重试', {
        currentEtag: episodeEtag(episode),
      })
    }
    const target = resolvePublicCharacterVoicePreviewTarget(database, {
      projectId,
      episodeId,
      characterId,
    })
    const catalog = await speechVoiceCatalog(providerId)
    if (catalog.fingerprint !== expectedCatalogFingerprint) {
      throw new HttpError(
        409,
        'VOICE_CATALOG_CHANGED',
        '音色目录已变化，未发起试听计费请求；请刷新目录后重试',
      )
    }
    if (!catalog.voices.some((voice) => voice.voiceId === voiceId)) {
      throw new HttpError(
        409,
        'VOICE_NOT_AVAILABLE',
        '所选音色已不在当前语音 Provider 目录中，未发起试听请求',
      )
    }
    const input: CharacterVoicePreviewJobInput & { expectedEpisodeVersion: string } = {
      episodeId,
      characterId,
      characterDatabaseId: target.characterDatabaseId,
      expectedStoryRevisionId: target.sourceRevisionId,
      voiceId,
      expectedCatalogFingerprint,
      expectedProviderConfigRevision: catalog.providerConfigRevision,
      expectedEpisodeVersion,
    }
    requirePaidAigcConfirmation(request, {
      action: 'character.voice.preview',
      projectId,
      episodeId,
      resourceId: target.characterDatabaseId,
      idempotencyKey: submissionKey,
      provider: {
        providerId: catalog.providerId,
        model: catalog.model,
        configRevision: catalog.providerConfigRevision,
      },
      input: input as unknown as JsonValue,
    }, '角色声线试听')
    const result = await withJobAdmission(async () => {
      const raced = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
      if (raced) {
        assertReplayMatches(raced)
        if (!sameCharacterVoicePreviewSubmission(raced, input)) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
        }
        return { job: raced, created: false }
      }
      const activePreview = database.listGenerationJobs({
        projectId,
        episodeId,
        type: CHARACTER_VOICE_PREVIEW_JOB_TYPE,
        limit: maxQueueDepth,
      }).find((job) => (
        ['queued', 'running', 'waiting_provider'].includes(job.status)
        && job.input.characterId === characterId
      ))
      if (activePreview) {
        throw new HttpError(
          409,
          'VOICE_PREVIEW_ALREADY_ACTIVE',
          '该角色已有声线试听正在处理；请等待当前试听完成或先停止，再选择其他音色',
          { existingJobId: activePreview.id },
        )
      }
      if (activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return worker.submit({
        type: CHARACTER_VOICE_PREVIEW_JOB_TYPE,
        input,
        idempotencyKey: submissionKey,
        resourceKey: 'provider:speech',
        projectId,
        providerId: catalog.providerId,
        model: catalog.model,
        providerConfigRevision: catalog.providerConfigRevision,
        metadata: { episodeId, resourceId: target.characterDatabaseId },
      })
    })
    const durable = database.getGenerationJob(result.job.id)
    if (!durable) throw new Error('Created character voice preview job disappeared')
    response.status(result.created ? 202 : 200).setHeader('ETag', episodeEtag(episode))
    response.json({ job: publicJob(durable, database) })
  }))

  app.post('/api/v1/episodes/:episodeId/characters/:characterId/voice-recommendations', asyncRoute(async (request, response) => {
    const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
    const characterId = requestIdentifier(routeParam(request.params.characterId), 'characterId')
    const body = requireObject(request.body, '角色声线推荐请求必须是 JSON 对象')
    const unknown = Object.keys(body).filter((key) => (
      key !== 'projectId'
      && key !== 'speechProviderId'
      && key !== 'textProviderId'
      && key !== 'expectedCatalogFingerprint'
    ))
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `不支持的声线推荐参数: ${unknown.join(', ')}`)
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const speechProviderId = body.speechProviderId === undefined
      ? 'minimax-speech'
      : requestIdentifier(body.speechProviderId, 'speechProviderId')
    if (speechProviderId !== 'minimax-speech'
      && speechProviderId !== 'indextts-speech'
      && speechProviderId !== 'doubao-speech') {
      throw new HttpError(400, 'INVALID_REQUEST', 'speechProviderId 不支持声线目录')
    }
    const requestedTextProviderId = body.textProviderId === undefined
      ? undefined
      : requestIdentifier(body.textProviderId, 'textProviderId')
    if (typeof body.expectedCatalogFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(body.expectedCatalogFingerprint)) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'expectedCatalogFingerprint 必须是当前音色目录 fingerprint',
      )
    }
    const expectedCatalogFingerprint = body.expectedCatalogFingerprint
    const submissionKey = idempotencyKey(request, true)
    const expectedEpisodeVersion = requiredEpisodeIfMatch(request)
    const requestedProviderBinding = requestedTextProviderId ?? null
    const existing = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
    if (existing) {
      if (existing.type !== CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE
        || existing.projectId !== projectId
        || existing.episodeId !== episodeId
        || existing.input.characterId !== characterId
        || existing.input.expectedEpisodeVersion !== expectedEpisodeVersion
        || existing.input.requestedTextProviderId !== requestedProviderBinding
        || !isPlainObject(existing.input.catalog)
        || existing.input.catalog.providerId !== speechProviderId
        || existing.input.catalog.fingerprint !== expectedCatalogFingerprint
        || existing.resourceId !== existing.input.characterDatabaseId
        || typeof existing.providerId !== 'string'
        || !existing.providerId
        || existing.providerConfigRevision === null
        || typeof existing.model !== 'string'
        || !existing.model) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
      }
      response.status(200).setHeader('ETag', `W/"${expectedEpisodeVersion}"`)
      response.json({ job: publicJob(existing, database) })
      return
    }

    const { episode, character } = characterVoiceTarget(episodeId, characterId, projectId)
    const characterRow = database.withSql((sql) => sql.get(`
      SELECT id FROM characters
       WHERE project_id = ? AND episode_id = ?
         AND json_extract(metadata_json, '$.storyId') = ?
    `, projectId, episodeId, characterId))
    if (!characterRow || typeof characterRow.id !== 'string') {
      throw new HttpError(404, 'CHARACTER_NOT_FOUND', '角色不存在或不属于指定分集')
    }
    const characterDatabaseId = characterRow.id
    if (!episodeVersionMatches(episode, expectedEpisodeVersion)) {
      throw new HttpError(412, 'REVISION_CONFLICT', '分集已被其他操作更新，请刷新后重试', {
        currentEtag: episodeEtag(episode),
      })
    }
    if (!episode.sourceRevisionId) {
      throw new HttpError(409, 'STORY_NOT_FOUND', '分集尚未生成结构化剧本')
    }
    const catalog = await speechVoiceCatalog(speechProviderId)
    if (catalog.fingerprint !== expectedCatalogFingerprint) {
      throw new HttpError(
        409,
        'VOICE_CATALOG_CHANGED',
        '音色目录已变化，未发起推荐；请刷新目录后重试',
      )
    }
    if (catalog.voices.length === 0) {
      throw new HttpError(409, 'VOICE_CATALOG_EMPTY', '当前语音 Provider 没有可推荐的音色')
    }
    const sceneRows = database.withSql((sql) => sql.all(`
      SELECT
        scenes.id AS scene_database_id,
        scenes.title,
        scenes.description,
        scenes.metadata_json AS scene_metadata_json,
        dialogue_lines.kind,
        dialogue_lines.text
      FROM scenes
      JOIN shots ON shots.scene_id = scenes.id
      JOIN dialogue_lines ON dialogue_lines.shot_id = shots.id
      WHERE scenes.episode_id = ? AND dialogue_lines.character_id = ?
      ORDER BY scenes.sequence, shots.sequence, dialogue_lines.sequence
    `, episodeId, characterDatabaseId))
    const scenesById = new Map<string, CharacterVoiceRecommendationJobInput['scenes'][number]>()
    for (const row of sceneRows) {
      if (typeof row.scene_database_id !== 'string'
        || typeof row.title !== 'string'
        || typeof row.description !== 'string'
        || typeof row.scene_metadata_json !== 'string'
        || (row.kind !== 'dialogue' && row.kind !== 'narration')
        || typeof row.text !== 'string') {
        throw new HttpError(500, 'STORY_GRAPH_INCONSISTENT', '角色台词场景数据不完整')
      }
      const metadata = JSON.parse(row.scene_metadata_json) as unknown
      if (!isPlainObject(metadata)) {
        throw new HttpError(500, 'STORY_GRAPH_INCONSISTENT', '角色台词场景元数据无效')
      }
      const publicSceneId = typeof metadata.storyId === 'string' && metadata.storyId.trim()
        ? metadata.storyId.trim()
        : row.scene_database_id
      const current = scenesById.get(publicSceneId) ?? {
        sceneId: publicSceneId,
        title: row.title,
        timeOfDay: typeof metadata.timeOfDay === 'string' ? metadata.timeOfDay : '',
        description: row.description,
        lines: [],
      }
      current.lines.push({ kind: row.kind, text: row.text })
      scenesById.set(publicSceneId, current)
    }
    const textProviders = (await providerService.list()).filter((candidate) => candidate.kind === 'text')
    const textProvider = requestedTextProviderId
      ? textProviders.find((candidate) => candidate.id === requestedTextProviderId)
      : textProviders.find((candidate) => candidate.isDefault)
    if (!textProvider) throw new HttpError(404, 'PROVIDER_NOT_FOUND', '文本 Provider 不存在')
    if (!textProvider.enabled
      || textProvider.credentialState === 'missing'
      || !textProvider.model.trim()
      || textProvider.health.status !== 'ok') {
      throw new HttpError(
        409,
        'PROVIDER_NOT_VERIFIED',
        '请先配置并测试默认文本 Provider，再使用 Agentic 声线推荐',
      )
    }
    const allCandidates = catalog.voices.map((voice) => ({
      voiceId: voice.voiceId,
      voiceName: voice.name,
      descriptions: [...voice.descriptions],
      type: voice.type,
    }))
    const candidateVoices = characterVoiceRecommendationShortlist(allCandidates)
    const input: CharacterVoiceRecommendationJobInput & {
      expectedEpisodeVersion: string
      requestedTextProviderId: string | null
    } = {
      episodeId,
      characterId,
      characterDatabaseId,
      expectedStoryRevisionId: episode.sourceRevisionId,
      expectedEpisodeVersion,
      requestedTextProviderId: requestedProviderBinding,
      character: {
        id: character.id,
        name: character.name,
        role: character.role,
        storyDescription: character.storyDescription,
        visualDescription: character.visualDescription,
      },
      scenes: [...scenesById.values()],
      catalog: {
        providerId: catalog.providerId,
        providerConfigRevision: catalog.providerConfigRevision,
        model: catalog.model,
        observedAt: catalog.observedAt,
        fingerprint: catalog.fingerprint,
        candidateFingerprint: characterVoiceCatalogFingerprint(candidateVoices),
        voices: candidateVoices,
      },
    }
    const result = await withJobAdmission(async () => {
      const raced = database.findGenerationJobByIdempotencyKey(projectId, submissionKey)
      if (raced) {
        if (raced.type !== CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE
          || raced.episodeId !== episodeId
          || raced.resourceId !== characterDatabaseId
          || raced.providerId !== textProvider.id
          || raced.providerConfigRevision !== textProvider.configRevision
          || raced.model !== textProvider.model
          || !isDeepStrictEqual(raced.input, input)) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
        }
        return { job: raced, created: false }
      }
      const latestEpisode = storyRepository.getEpisode(episodeId)
      if (!latestEpisode
        || latestEpisode.projectId !== projectId
        || !episodeVersionMatches(latestEpisode, expectedEpisodeVersion)
        || latestEpisode.sourceRevisionId !== input.expectedStoryRevisionId) {
        throw new HttpError(412, 'REVISION_CONFLICT', '分集已被其他操作更新，未创建推荐任务', {
          ...(latestEpisode ? { currentEtag: episodeEtag(latestEpisode) } : {}),
        })
      }
      const currentTextProvider = (await providerService.list()).find((candidate) => (
        candidate.kind === 'text' && candidate.id === textProvider.id
      ))
      if (!currentTextProvider
        || !currentTextProvider.enabled
        || currentTextProvider.credentialState === 'missing'
        || currentTextProvider.health.status !== 'ok'
        || currentTextProvider.model !== textProvider.model
        || currentTextProvider.configRevision !== textProvider.configRevision) {
        throw new HttpError(
          409,
          'PROVIDER_NOT_VERIFIED',
          '文本 Provider 已变化，未创建推荐任务；请重新点击 AI 选角',
        )
      }
      const activeDuplicate = ACTIVE_JOB_STATUSES.some((status) => (
        database.listGenerationJobs({
          projectId,
          episodeId,
          type: CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE,
          status,
          limit: 1_000,
        }).some((job) => job.resourceId === characterDatabaseId)
      ))
      if (activeDuplicate) {
        throw new HttpError(
          409,
          'ACTIVE_GENERATION_CONFLICT',
          '该角色已有进行中的声线推荐任务，请等待完成或取消后再试',
        )
      }
      if (activeJobCount(database) >= maxQueueDepth) {
        throw new HttpError(429, 'QUEUE_FULL', '生成队列已满，请稍后重试')
      }
      return worker.submit({
        type: CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE,
        input,
        idempotencyKey: submissionKey,
        resourceKey: 'provider:text',
        projectId,
        providerId: textProvider.id,
        model: textProvider.model,
        providerConfigRevision: textProvider.configRevision,
        metadata: { episodeId, resourceId: characterDatabaseId },
      })
    })
    const durable = database.getGenerationJob(result.job.id)
    if (!durable) throw new Error('Created character voice recommendation job disappeared')
    response.status(result.created ? 202 : 200).setHeader('ETag', episodeEtag(episode))
    response.json({ job: publicJob(durable, database) })
  }))

  app.put('/api/v1/episodes/:episodeId/characters/:characterId/voice-profile', asyncRoute(async (request, response) => {
    const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
    const characterId = requestIdentifier(routeParam(request.params.characterId), 'characterId')
    const body = requireObject(request.body, '角色声线设置必须是 JSON 对象')
    const allowed = new Set([
      'projectId',
      'providerId',
      'voiceId',
      'selectionSource',
      'selectionRationale',
      'recommendationJobId',
      'allowHistoricalPin',
      'expectedProviderConfigRevision',
      'summary',
    ])
    const unknown = Object.keys(body).filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `不支持的角色声线参数: ${unknown.join(', ')}`)
    }
    const projectId = requestIdentifier(body.projectId, 'projectId')
    const requestedProviderId = body.providerId === undefined
      ? 'minimax-speech'
      : requestIdentifier(body.providerId, 'providerId')
    const { episode, character } = characterVoiceTarget(episodeId, characterId, projectId)
    const expectedEpisodeVersion = requiredEpisodeIfMatch(request)
    if (!episodeVersionMatches(episode, expectedEpisodeVersion)) {
      throw new HttpError(412, 'REVISION_CONFLICT', '分集已被其他操作更新，请刷新后重试', {
        currentEtag: episodeEtag(episode),
      })
    }
    if (body.selectionSource !== 'manual' && body.selectionSource !== 'agentic') {
      throw new HttpError(400, 'INVALID_REQUEST', 'selectionSource 必须是 manual 或 agentic')
    }
    const recommendationJobId = body.recommendationJobId === undefined
      ? undefined
      : requestIdentifier(body.recommendationJobId, 'recommendationJobId')
    if (body.selectionSource === 'agentic' && recommendationJobId === undefined) {
      throw new HttpError(400, 'RECOMMENDATION_REQUIRED', 'Agentic 声线绑定必须引用已完成的推荐任务')
    }
    if (body.selectionSource === 'manual' && recommendationJobId !== undefined) {
      throw new HttpError(400, 'INVALID_REQUEST', '手动声线绑定不能引用 recommendationJobId')
    }
    if (body.voiceId !== undefined && typeof body.voiceId !== 'string') {
      throw new HttpError(400, 'INVALID_REQUEST', 'voiceId 必须是文本')
    }
    const requestedVoiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : undefined
    if (requestedVoiceId !== undefined
      && (!requestedVoiceId || requestedVoiceId.length > 256 || /[\u0000-\u001f\u007f]/.test(requestedVoiceId))) {
      throw new HttpError(400, 'INVALID_REQUEST', 'voiceId 格式无效')
    }
    if (body.selectionSource === 'manual' && requestedVoiceId === undefined) {
      throw new HttpError(400, 'INVALID_REQUEST', '手动声线绑定必须提供 voiceId')
    }
    const selectionRationale = body.selectionRationale === undefined
      ? undefined
      : typeof body.selectionRationale === 'string'
        && body.selectionRationale.trim()
        && body.selectionRationale.length <= 1_000
        ? body.selectionRationale.trim()
        : (() => { throw new HttpError(400, 'INVALID_REQUEST', 'selectionRationale 格式无效') })()
    if (body.allowHistoricalPin !== undefined && typeof body.allowHistoricalPin !== 'boolean') {
      throw new HttpError(400, 'INVALID_REQUEST', 'allowHistoricalPin 必须是布尔值')
    }
    if (body.expectedProviderConfigRevision !== undefined
      && (!Number.isInteger(body.expectedProviderConfigRevision)
        || (body.expectedProviderConfigRevision as number) < 1)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'expectedProviderConfigRevision 必须是正整数')
    }
    if (body.summary !== undefined && (typeof body.summary !== 'string' || body.summary.length > 500)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'summary 格式无效')
    }

    const existing = characterVoiceProfiles.get(projectId, episodeId, characterId)
    const updatedAt = new Date().toISOString()
    let profile: StoryCharacterVoiceProfile
    if (body.selectionSource === 'agentic') {
      if (body.allowHistoricalPin === true) {
        throw new HttpError(400, 'INVALID_REQUEST', 'Agentic 推荐只能确认当前音色目录，不能盲目固化历史版本')
      }
      const recommendationJob = database.getGenerationJob(recommendationJobId!)
      const characterRow = database.withSql((sql) => sql.get(`
        SELECT id FROM characters
         WHERE project_id = ? AND episode_id = ?
           AND json_extract(metadata_json, '$.storyId') = ?
      `, projectId, episodeId, characterId))
      if (!characterRow || typeof characterRow.id !== 'string') {
        throw new HttpError(404, 'CHARACTER_NOT_FOUND', '角色不存在或不属于指定分集')
      }
      if (!recommendationJob
        || recommendationJob.type !== CHARACTER_VOICE_RECOMMENDATION_JOB_TYPE
        || recommendationJob.status !== 'succeeded'
        || recommendationJob.projectId !== projectId
        || recommendationJob.episodeId !== episodeId
        || recommendationJob.resourceId !== characterRow.id) {
        throw new HttpError(
          409,
          'VOICE_RECOMMENDATION_NOT_CONFIRMABLE',
          '声线推荐任务未成功完成，或不属于当前角色',
        )
      }
      let recommendationInput: CharacterVoiceRecommendationJobInput
      let recommendation: CharacterVoiceRecommendation
      try {
        recommendationInput = parseCharacterVoiceRecommendationJobInput(recommendationJob.input)
        if (!isPlainObject(recommendationJob.output)
          || recommendationJob.output.characterId !== characterId
          || !isPlainObject(recommendationJob.output.recommendation)) {
          throw new Error('推荐任务输出不完整')
        }
        recommendation = parseCharacterVoiceRecommendationResult(
          recommendationJob.output.recommendation,
          recommendationInput.catalog.voices,
          recommendationInput.scenes,
          recommendationInput.catalog.fingerprint,
        )
      } catch (error) {
        throw new HttpError(
          409,
          'VOICE_RECOMMENDATION_INVALID',
          error instanceof CharacterVoiceRecommendationError
            ? error.message
            : '声线推荐任务结果无效，请重新推荐',
        )
      }
      if (recommendationInput.episodeId !== episodeId
        || recommendationInput.characterId !== characterId
        || recommendationInput.characterDatabaseId !== characterRow.id
        || recommendationInput.expectedStoryRevisionId !== episode.sourceRevisionId) {
        throw new HttpError(
          409,
          'STALE_VOICE_RECOMMENDATION',
          '角色或剧本已修改，请基于最新版本重新推荐',
        )
      }
      const allowedRecommendedVoices = new Set([
        recommendation.selectedVoiceId,
        ...recommendation.alternatives.map((alternative) => alternative.voiceId),
      ])
      const voiceId = requestedVoiceId ?? recommendation.selectedVoiceId
      if (!allowedRecommendedVoices.has(voiceId)) {
        throw new HttpError(
          400,
          'VOICE_NOT_RECOMMENDED',
          'Agentic 确认只能选择主推或备选音色',
        )
      }
      if (requestedProviderId !== recommendationInput.catalog.providerId) {
        throw new HttpError(400, 'VOICE_RECOMMENDATION_PROVIDER_MISMATCH', 'AI 推荐与当前语音 Provider 不一致')
      }
      const catalog = await speechVoiceCatalog(requestedProviderId)
      if (body.expectedProviderConfigRevision !== undefined
        && body.expectedProviderConfigRevision !== catalog.providerConfigRevision) {
        throw new HttpError(
          409,
          'VOICE_CATALOG_REVISION_CHANGED',
          '语音 Provider 配置已变化，请重新推荐',
        )
      }
      if (catalog.providerConfigRevision !== recommendationInput.catalog.providerConfigRevision
        || catalog.fingerprint !== recommendationInput.catalog.fingerprint) {
        throw new HttpError(
          409,
          'VOICE_CATALOG_CHANGED',
          '声线推荐所用目录已变化，请重新推荐',
        )
      }
      const voice = catalog.voices.find((candidate) => candidate.voiceId === voiceId)
      if (!voice) {
        throw new HttpError(409, 'VOICE_NOT_AVAILABLE', '所选推荐音色已不在当前语音 Provider 目录中')
      }
      const recommendedRationale = voiceId === recommendation.selectedVoiceId
        ? recommendation.rationale
        : recommendation.alternatives.find((alternative) => alternative.voiceId === voiceId)?.rationale
      profile = {
        version: 1 as const,
        voiceId: voice.voiceId,
        providerId: catalog.providerId,
        providerConfigRevision: catalog.providerConfigRevision,
        voiceType: voice.type,
        voiceName: voice.name,
        descriptions: [...voice.descriptions],
        selectionSource: 'agentic',
        selectionRationale: selectionRationale ?? recommendedRationale ?? recommendation.rationale,
        profileTags: [...recommendation.profileTags],
        defaultDelivery: { ...recommendation.defaultDelivery },
        sceneDirections: recommendation.sceneDirections.map((direction) => ({ ...direction })),
        recommendationJobId: recommendationJob.id,
        catalogFingerprint: catalog.fingerprint,
        catalogObservedAt: catalog.observedAt,
        historicalPin: false,
        updatedAt,
      }
    } else if (body.allowHistoricalPin === true
      && existing !== undefined
      && existing.profile.voiceId === requestedVoiceId
      && (body.expectedProviderConfigRevision === undefined
        || body.expectedProviderConfigRevision === existing.profile.providerConfigRevision)) {
      profile = {
        ...existing.profile,
        selectionSource: 'manual',
        ...(selectionRationale ? { selectionRationale } : {}),
        historicalPin: true,
        updatedAt,
      }
    } else {
      const catalog = await speechVoiceCatalog(requestedProviderId)
      if (body.expectedProviderConfigRevision !== undefined
        && body.expectedProviderConfigRevision !== catalog.providerConfigRevision) {
        throw new HttpError(
          409,
          'VOICE_CATALOG_REVISION_CHANGED',
          '语音 Provider 配置已变化，请刷新声线目录后重新选择',
        )
      }
      const voice = catalog.voices.find((candidate) => candidate.voiceId === requestedVoiceId)
      if (!voice) {
        throw new HttpError(
          409,
          'VOICE_NOT_AVAILABLE',
          '所选 voiceId 不在当前 Provider 的真实声线目录中',
        )
      }
      profile = {
        version: 1 as const,
        voiceId: voice.voiceId,
        providerId: catalog.providerId,
        providerConfigRevision: catalog.providerConfigRevision,
        voiceType: voice.type,
        voiceName: voice.name,
        descriptions: [...voice.descriptions],
        selectionSource: 'manual',
        ...(selectionRationale ? { selectionRationale } : {}),
        catalogFingerprint: catalog.fingerprint,
        catalogObservedAt: catalog.observedAt,
        historicalPin: false,
        updatedAt,
      }
    }
    const saved = characterVoiceProfiles.save({
      projectId,
      episodeId,
      characterId,
      expectedEpisodeVersion,
      profile,
      summary: typeof body.summary === 'string' ? body.summary : `设置角色 ${character.name} 声线`,
    })
    await Promise.all(saved.stale.activeJobIds.map((jobId) => worker.cancel(
      jobId,
      '角色声线已修改，已停止本地处理；若上游请求已提交，仍可能继续执行或产生费用',
    )))
    const { activeJobIds: _activeJobIds, ...publicStale } = saved.stale
    const refreshed = storyRepository.getEpisode(episodeId)
    if (!refreshed) throw new HttpError(404, 'EPISODE_NOT_FOUND', '分集已被删除')
    response.setHeader('ETag', saved.episodeEtag)
    response.json({
      episode: {
        id: refreshed.id,
        projectId: refreshed.projectId,
        sourceRevisionId: refreshed.sourceRevisionId,
        updatedAt: refreshed.updatedAt,
      },
      character: { id: character.id, name: character.name, role: character.role },
      voiceProfile: saved.record?.profile ?? null,
      revisionId: saved.revision.id,
      stale: publicStale,
    })
  }))

  app.delete('/api/v1/episodes/:episodeId/characters/:characterId/voice-profile', asyncRoute(async (request, response) => {
    const episodeId = requestIdentifier(routeParam(request.params.episodeId), 'episodeId')
    const characterId = requestIdentifier(routeParam(request.params.characterId), 'characterId')
    const projectId = requestIdentifier(queryString(request.query.projectId), 'projectId')
    const { character } = characterVoiceTarget(episodeId, characterId, projectId)
    const saved = characterVoiceProfiles.save({
      projectId,
      episodeId,
      characterId,
      expectedEpisodeVersion: requiredEpisodeIfMatch(request),
      profile: null,
      summary: `清除角色 ${character.name} 声线`,
    })
    await Promise.all(saved.stale.activeJobIds.map((jobId) => worker.cancel(
      jobId,
      '角色声线已清除，已停止本地处理；若上游请求已提交，仍可能继续执行或产生费用',
    )))
    const { activeJobIds: _activeJobIds, ...publicStale } = saved.stale
    const refreshed = storyRepository.getEpisode(episodeId)
    if (!refreshed) throw new HttpError(404, 'EPISODE_NOT_FOUND', '分集已被删除')
    response.setHeader('ETag', saved.episodeEtag)
    response.json({
      episode: {
        id: refreshed.id,
        projectId: refreshed.projectId,
        sourceRevisionId: refreshed.sourceRevisionId,
        updatedAt: refreshed.updatedAt,
      },
      character: { id: character.id, name: character.name, role: character.role },
      voiceProfile: null,
      revisionId: saved.revision.id,
      stale: publicStale,
    })
  }))

  app.get('/api/v1/providers', asyncRoute(async (_request, response) => {
    response.json({ providers: await providerService.list() })
  }))
  app.put('/api/v1/providers/:id/credentials', asyncRoute(async (request, response) => {
    const providerState = await providerService.save(
      routeParam(request.params.id),
      requireObject(request.body, 'Provider 设置必须是 JSON 对象'),
    )
    eventHub.publish('provider.updated', { provider: providerState as unknown as JsonValue })
    response.json({ provider: providerState })
  }))
  app.delete('/api/v1/providers/:id/credentials', asyncRoute(async (request, response) => {
    const providerState = await providerService.deleteCredential(routeParam(request.params.id))
    eventHub.publish('provider.updated', { provider: providerState as unknown as JsonValue })
    response.json({ provider: providerState })
  }))
  app.post('/api/v1/providers/:id/test', asyncRoute(async (request, response) => {
    const providerState = await providerService.test(routeParam(request.params.id))
    eventHub.publish('provider.updated', { provider: providerState as unknown as JsonValue })
    response.json({ provider: providerState })
  }))
  app.patch('/api/v1/providers/:id', asyncRoute(async (request, response) => {
    const body = requireObject(request.body, 'Provider 更新必须是 JSON 对象')
    if (body.isDefault !== true) throw new HttpError(400, 'INVALID_REQUEST', '仅支持设置默认 Provider')
    const providerState = await providerService.setDefault(routeParam(request.params.id))
    eventHub.publish('provider.updated', { provider: providerState as unknown as JsonValue })
    response.json({ provider: providerState })
  }))
  app.post('/api/v1/providers/:id/auth/start', asyncRoute(async (request, response) => {
    const providerId = routeParam(request.params.id)
    const providerState = (await providerService.list()).find((item) => item.id === providerId)
    if (!providerState) throw new HttpError(404, 'PROVIDER_NOT_FOUND', 'Provider 不存在')
    if (providerState.authMode !== 'byoa') {
      throw new HttpError(400, 'PROVIDER_USES_BYOK', '该 Provider 使用 API Key，不支持账号授权')
    }
    response.json({
      auth: {
        providerId,
        status: providerState.credentialState === 'external' ? 'connected' : 'missing',
        message: providerState.credentialState === 'external'
          ? '已检测到 Codex Tools 本地账号授权'
          : '请先启动并登录 Codex Tools API Proxy',
      },
    })
  }))

  app.get('/api/v1/events', (request, response) => {
    serveStudioEvents(request, response, eventHub)
  })

  mountStoryHttpRoutes(app, {
    database,
    stories: storyRepository,
    worker,
    admitJob: withJobAdmission,
    async resolveTextProviderBinding(selection) {
      const textProviders = (await providerService.list())
        .filter((candidate) => candidate.kind === 'text')
      const selected = selection.requestedProviderId
        ? textProviders.find((candidate) => candidate.id === selection.requestedProviderId)
        : textProviders.find((candidate) => candidate.isDefault)
      if (!selected) {
        throw new StoryHttpError(404, 'PROVIDER_NOT_FOUND', '文本 Provider 不存在')
      }
      if (
        !selected.enabled
        || selected.credentialState === 'missing'
        || !selected.model.trim()
      ) {
        throw new StoryHttpError(
          409,
          'PROVIDER_NOT_CONFIGURED',
          '请先配置并启用文本 Provider',
        )
      }
      return {
        providerId: selected.id,
        model: selected.model,
        configRevision: selected.configRevision,
      }
    },
  })

  // Legacy generated files are retained read-only after migration. New media
  // always goes through the controlled Asset API above.
  app.use('/generated', express.static(generatedDirectory, {
    dotfiles: 'deny',
    fallthrough: false,
    immutable: true,
    maxAge: '1y',
    setHeaders(response) {
      response.setHeader('X-Content-Type-Options', 'nosniff')
    },
  }))

  app.use('/api', (_request, _response, next) => {
    next(new HttpError(404, 'NOT_FOUND', 'API 接口不存在'))
  })

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    let mapped = error
    if (error instanceof AssetRetentionError) {
      const status = error.code === 'RETENTION_CONFIRMATION_INVALID'
        ? 403
        : error.code === 'RETENTION_RECOVERY_REQUIRED'
          ? 503
          : 409
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof AssetLockError) {
      mapped = new HttpError(error.status, error.code, error.message, error.details)
    } else if (error instanceof AssetIdentityError) {
      mapped = new HttpError(error.status, error.code, error.message, error.details)
    } else if (error instanceof ProductionAssetManifestError) {
      mapped = new HttpError(error.status, error.code, error.message, error.details)
    } else if (error instanceof VisualAssetHistoryError) {
      mapped = new HttpError(error.status, error.code, error.message, error.details)
    } else if (error instanceof ShotVideoHistoryError) {
      mapped = new HttpError(error.status, error.code, error.message)
    } else if (error instanceof AssetImageEditError) {
      const status = error.code === 'ASSET_NOT_FOUND'
        || error.code === 'PROJECT_NOT_FOUND'
        || error.code === 'PROVIDER_NOT_FOUND'
        ? 404
        : error.code === 'PRECONDITION_FAILED'
          ? 412
          : error.code === 'ASSET_VERSION_FAMILY_BUSY'
            || error.code === 'IDEMPOTENCY_CONFLICT'
            || error.code === 'PROVIDER_CAPABILITY_MISSING'
            || error.code === 'PROVIDER_NOT_CONFIGURED'
            || error.code === 'SOURCE_REVISION_MISSING'
            || error.code === 'STALE_SOURCE'
            ? 409
            : 400
      mapped = new HttpError(status, error.code, error.message, error.details)
    } else if (error instanceof TurnaroundDerivationError) {
      const status = error.code === 'ASSET_NOT_FOUND' || error.code === 'PROJECT_NOT_FOUND'
        ? 404
        : error.code === 'PRECONDITION_FAILED'
          ? 412
          : error.code === 'IDEMPOTENCY_CONFLICT'
            || error.code === 'SOURCE_REVISION_MISSING'
            || error.code === 'STALE_SOURCE'
            ? 409
            : 400
      mapped = new HttpError(status, error.code, error.message, error.details)
    } else if (error instanceof StoryHttpError) {
      mapped = new HttpError(error.status, error.code, error.message, error.details)
    } else if (error instanceof PipelineProductionError) {
      const status = error.code === 'EPISODE_NOT_FOUND' || error.code === 'STORY_NOT_FOUND'
        ? 404
        : error.code === 'AUDIO_REQUIRED' || error.code === 'STORY_GRAPH_INCONSISTENT'
          ? 422
          : error.code === 'INVALID_PIPELINE_TARGET'
            ? 400
            : 409
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof PipelineRunError) {
      const status = error.code === 'PROJECT_NOT_FOUND'
        || error.code === 'EPISODE_NOT_FOUND'
        || error.code === 'SOURCE_REVISION_NOT_FOUND'
        || error.code === 'PIPELINE_PROVIDER_NOT_FOUND'
        || error.code === 'PIPELINE_PROVIDER_REVISION_NOT_FOUND'
        ? 404
        : error.code === 'IDEMPOTENCY_CONFLICT'
          || error.code === 'PIPELINE_PROVIDER_DISABLED'
          || error.code.endsWith('_CONFLICT')
          ? 409
          : 400
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof ProjectConflictError) {
      mapped = new HttpError(412, 'REVISION_CONFLICT', error.message, {
        currentRevisionId: error.currentRevisionId,
      })
    } else if (error instanceof ProjectKnowledgeConflictError) {
      mapped = new HttpError(412, 'KNOWLEDGE_REVISION_CONFLICT', error.message, {
        currentRevisionId: error.currentRevisionId,
      })
    } else if (error instanceof ProjectKnowledgeValidationError) {
      mapped = new HttpError(400, 'INVALID_PROJECT_KNOWLEDGE', error.message)
    } else if (error instanceof ProviderConfigurationError) {
      const status = error.code === 'PROVIDER_NOT_FOUND' ? 404
        : error.code === 'PROVIDER_NOT_CONFIGURED' ? 409
          : error.code === 'PROVIDER_NOT_VERIFIED' ? 409
          : 400
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof MiniMaxVoiceCatalogError) {
      const status = error.code === 'MINIMAX_VOICE_AUTH_FAILED'
        || error.code === 'MINIMAX_VOICE_PROVIDER_INVALID'
        || error.code === 'MINIMAX_VOICE_PROVIDER_NOT_VERIFIED'
        ? 409
        : error.code === 'MINIMAX_VOICE_RATE_LIMITED'
          ? 429
          : error.code === 'MINIMAX_VOICE_CATALOG_TOO_LARGE'
            || error.code === 'MINIMAX_VOICE_CATALOG_INVALID'
            ? 502
            : error.code === 'MINIMAX_VOICE_CATALOG_TIMEOUT'
              ? 504
              : 503
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof IndexTtsVoiceCatalogError) {
      const status = error.code === 'INDEXTTS_VOICE_AUTH_FAILED'
        || error.code === 'INDEXTTS_VOICE_PROVIDER_INVALID'
        || error.code === 'INDEXTTS_VOICE_PROVIDER_NOT_VERIFIED'
        ? 409
        : error.code === 'INDEXTTS_VOICE_CATALOG_INVALID'
          ? 502
          : error.code === 'INDEXTTS_VOICE_CATALOG_TIMEOUT'
            ? 504
            : 503
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof DoubaoVoiceCatalogError) {
      mapped = new HttpError(409, error.code, error.message)
    } else if (error instanceof ProjectNarratorVoiceProfileError) {
      const status = error.code === 'PROJECT_NOT_FOUND'
        || error.code === 'PROJECT_NARRATOR_VOICE_PROFILE_NOT_FOUND'
        ? 404
        : error.code === 'REVISION_CONFLICT'
          ? 412
          : 500
      mapped = new HttpError(
        status,
        error.code,
        error.message,
        error.currentEtag ? { currentEtag: error.currentEtag } : undefined,
      )
    } else if (error instanceof CharacterVoiceProfileError) {
      const status = error.code === 'EPISODE_NOT_FOUND' || error.code === 'CHARACTER_NOT_FOUND'
        ? 404
        : error.code === 'CHARACTER_VOICE_PROFILE_NOT_FOUND'
          ? 404
          : error.code === 'REVISION_CONFLICT'
            ? 412
            : 500
      mapped = new HttpError(
        status,
        error.code,
        error.message,
        error.currentEtag ? { currentEtag: error.currentEtag } : undefined,
      )
    } else if (error instanceof CharacterVoicePreviewError) {
      const status = error.code === 'EPISODE_NOT_FOUND'
        || error.code === 'STORY_NOT_FOUND'
        || error.code === 'CHARACTER_NOT_FOUND'
        ? 404
        : 409
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof ProjectNarratorVoicePreviewError) {
      const status = error.code === 'EPISODE_NOT_FOUND' || error.code === 'STORY_NOT_FOUND'
        ? 404
        : 409
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof SQLiteRepositoryError) {
      const status = error.code === 'JOB_NOT_FOUND' || error.code === 'PROVIDER_NOT_FOUND' ? 404
        : error.code === 'JOB_NOT_RETRYABLE'
          || error.code === 'JOB_PAID_RECONFIRMATION_REQUIRED'
          || error.code === 'JOB_MANUAL_RESOLUTION_REQUIRED'
          || error.code === 'IDEMPOTENCY_CONFLICT' ? 409
          : 400
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof TimelineDocumentError) {
      const status = error.code === 'EPISODE_NOT_FOUND'
        || error.code === 'SOURCE_REVISION_NOT_FOUND'
        || error.code === 'TIMELINE_DOCUMENT_NOT_FOUND'
        ? 404
        : error.code === 'TIMELINE_DOCUMENT_CONFLICT'
          ? 412
          : error.code === 'EPISODE_PROJECT_MISMATCH'
            || error.code === 'SOURCE_REVISION_PROJECT_MISMATCH'
            ? 409
            : 400
      mapped = new HttpError(
        status,
        error.code,
        error.message,
        error.code === 'TIMELINE_DOCUMENT_CONFLICT'
          ? { currentRevisionId: error.currentRevisionId ?? null }
          : undefined,
      )
    } else if (error instanceof TimelineRevisionRestoreError) {
      const status = error.code === 'TIMELINE_RESTORE_IDEMPOTENCY_CONFLICT'
        || error.code === 'TIMELINE_RESTORE_SCOPE_MISMATCH'
        || error.code === 'TIMELINE_RESTORE_INCOMPATIBLE'
        ? 409
        : error.code === 'CORRUPT_TIMELINE_RESTORE'
          ? 500
          : 400
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof TimelineMaterializationError) {
      const status = error.code === 'STORY_NOT_FOUND'
        || error.code === 'STORY_SOURCE_REVISION_NOT_FOUND'
        ? 404
        : error.code === 'AMBIGUOUS_STORY_SHOT_ID'
          || error.code === 'AMBIGUOUS_STORY_DIALOGUE_LINE_ID'
          || error.code === 'TIMELINE_MEDIA_RECONCILIATION_REQUIRED'
          ? 409
          : 422
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof TimelineAutoEditError) {
      const status = error.code === 'AUTO_EDIT_PLAN_NOT_FOUND'
        || error.code === 'AUTO_EDIT_APPLICATION_NOT_FOUND'
        ? 404
        : error.code === 'AUTO_EDIT_REVISION_CONFLICT'
          ? 412
          : error.code === 'AUTO_EDIT_PLAN_CORRUPT'
            ? 500
            : 409
      mapped = new HttpError(
        status,
        error.code,
        error.message,
        error.code === 'AUTO_EDIT_REVISION_CONFLICT'
          ? { currentRevisionId: error.currentRevisionId ?? null }
          : undefined,
      )
    } else if (error instanceof DatabaseIntegrityError) {
      mapped = new HttpError(409, error.code, '资源不属于同一个项目')
    } else if (error instanceof MediaStoreError) {
      const status = error.code === 'ASSET_NOT_FOUND' || error.code === 'ASSET_FILE_MISSING' ? 404
        : error.code === 'ASSET_EXISTS' ? 409
          : error.code === 'MEDIA_TOO_LARGE' ? 413
            : 400
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof MediaUploadError) {
      const status = error.code === 'PROJECT_NOT_FOUND' || error.code === 'EPISODE_NOT_FOUND'
        ? 404
        : error.code === 'UNSUPPORTED_AUDIO_TYPE'
          ? 415
          : error.code === 'AUDIO_PROBE_UNAVAILABLE'
            ? 503
            : error.code === 'INVALID_AUDIO'
              ? 422
              : 400
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof DialogueSpeechError) {
      const status = error.code === 'DIALOGUE_LINE_NOT_FOUND'
        ? 404
        : error.code === 'AMBIGUOUS_DIALOGUE_LINE_ID'
          ? 409
          : 400
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof LinePerformanceContextError) {
      const status = error.code === 'DIALOGUE_LINE_NOT_FOUND' || error.code === 'STORY_NOT_FOUND'
        ? 404
        : error.code === 'AMBIGUOUS_DIALOGUE_LINE_ID'
          ? 409
          : error.code === 'VOICE_PROFILE_REQUIRED'
            ? 409
            : 422
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof LinePerformanceProfileError) {
      const status = error.code === 'DIALOGUE_LINE_NOT_FOUND'
        ? 404
        : error.code === 'PRECONDITION_FAILED'
          ? 412
        : error.code === 'AMBIGUOUS_DIALOGUE_LINE_ID' || error.code === 'STALE_SOURCE'
          ? 409
          : 500
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof LinePerformanceError) {
      mapped = new HttpError(422, error.code, error.message)
    } else if (error instanceof VisualAssetGenerationError) {
      const status = error.code === 'EPISODE_NOT_FOUND'
        || error.code === 'VISUAL_ASSET_TARGET_NOT_FOUND'
        ? 404
        : error.code === 'INVALID_VISUAL_ASSET_TARGET'
          ? 400
          : 409
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof StoryboardImageError) {
      const status = error.code === 'STORYBOARD_SHOT_NOT_FOUND' || error.code === 'EPISODE_NOT_FOUND'
        ? 404
        : error.code === 'AMBIGUOUS_STORYBOARD_SHOT_ID'
          ? 409
          : 409
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof ShotVideoBatchError) {
      mapped = new HttpError(error.status, error.code, error.message, error.details)
    } else if (error instanceof ShotVideoVisualReferenceJobError) {
      const status = error.code === 'SHOT_NOT_FOUND'
        ? 404
        : error.code === 'REFERENCE_SCOPE_TOO_LARGE'
          ? 413
          : error.code === 'STORYBOARD_REQUIRED'
            || error.code === 'REFERENCE_ASSET_INVALID'
            ? 409
            : 400
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof ShotVideoManualResolutionError) {
      mapped = new HttpError(error.status, error.code, error.message)
    } else if (error instanceof ShotMediaReviewError) {
      const status = error.code === 'PROJECT_NOT_FOUND'
        || error.code === 'EPISODE_NOT_FOUND'
        || error.code === 'SHOT_NOT_FOUND'
        || error.code === 'ASSET_NOT_FOUND'
        ? 404
        : error.code === 'PRECONDITION_FAILED'
          ? 412
          : error.code === 'CORRUPT_MEDIA_REVIEW'
            ? 500
            : 409
      mapped = new HttpError(status, error.code, error.message, error.details)
    } else if (error instanceof JobExecutionError) {
      const status = error.code === 'SHOT_NOT_FOUND'
        ? 404
        : error.code === 'AMBIGUOUS_SHOT_ID'
          || error.code === 'STALE_SOURCE'
          || error.code === 'SHOT_VIDEO_LINK_CONFLICT'
          ? 409
          : error.code === 'UNSUPPORTED_VIDEO_ASPECT_RATIO'
            || error.code === 'INVALID_VIDEO_PROMPT'
            || error.code === 'STORY_GRAPH_INCONSISTENT'
            || error.code === 'INVALID_VIDEO_REFERENCE_ASSET'
            ? 422
            : 400
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof ExportRenderError) {
      const status = error.code === 'EXPORT_NOT_FOUND'
        || error.code === 'EPISODE_NOT_FOUND'
        || error.code === 'TIMELINE_DOCUMENT_NOT_FOUND'
        || error.code === 'TIMELINE_REVISION_NOT_FOUND'
        || error.code === 'STORY_REVISION_NOT_FOUND'
        || error.code === 'ASSET_NOT_FOUND'
        ? 404
        : error.code === 'TIMELINE_REVISION_CONFLICT'
          ? 412
          : error.code === 'EPISODE_PROJECT_MISMATCH'
            || error.code === 'ASSET_PROJECT_MISMATCH'
            || error.code === 'IDEMPOTENCY_CONFLICT'
            || error.code === 'EXPORT_STATE_CONFLICT'
            || error.code === 'TIMELINE_MEDIA_RECONCILIATION_REQUIRED'
            ? 409
            : error.code === 'UNSUPPORTED_TIMELINE'
              || error.code === 'UNSUPPORTED_VISUAL_ASSET'
              || error.code === 'UNSUPPORTED_AUDIO_ASSET'
              ? 422
              : 400
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof QualityCheckError) {
      const status = error.code === 'QUALITY_REPORT_NOT_FOUND'
        ? 404
        : error.code === 'QUALITY_CHECK_REQUIRED'
          || error.code === 'QUALITY_CHECK_PENDING'
          || error.code === 'QUALITY_CHECK_FAILED'
          ? 423
          : error.code === 'EXPORT_NOT_READY'
            || error.code === 'ASSET_NOT_READY'
            || error.code === 'IDEMPOTENCY_CONFLICT'
            || error.code === 'ASSET_PROJECT_MISMATCH'
            || error.code === 'ASSET_BINDING_CONFLICT'
            || error.code === 'QUALITY_REPORT_STALE'
            || error.code === 'QUALITY_STATE_CONFLICT'
            ? 409
            : 400
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof ReleaseReviewError) {
      const status = error.code === 'EXPORT_NOT_FOUND'
        ? 404
        : error.code === 'INVALID_RELEASE_REVIEW'
          ? 400
          : error.code === 'IDEMPOTENCY_CONFLICT'
            ? 409
            : 423
      mapped = new HttpError(status, error.code, error.message)
    } else if (error instanceof VoicePreviewReviewError) {
      const status = error.code === 'PREVIEW_JOB_NOT_FOUND'
        ? 404
        : error.code === 'INVALID_VOICE_PREVIEW_REVIEW'
          ? 400
          : 409
      mapped = new HttpError(status, error.code, error.message)
    }

    if (mapped instanceof HttpError) {
      response.status(mapped.status).json({
        error: {
          code: mapped.code,
          message: mapped.message,
          ...(mapped.details !== undefined ? { details: mapped.details } : {}),
        },
      })
      return
    }
    if (error instanceof SyntaxError && 'status' in error) {
      response.status(400).json({ error: { code: 'INVALID_JSON', message: '请求 JSON 格式无效' } })
      return
    }
    const status = typeof error === 'object' && error && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 500
    if (status >= 500) {
      const name = error instanceof Error ? error.name : typeof error
      console.error('API request failed', { name, status })
    }
    const code = status === 413 ? 'PAYLOAD_TOO_LARGE'
      : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE'
        : status === 404 ? 'NOT_FOUND'
          : 'INTERNAL_ERROR'
    const message = status === 413 ? '请求内容过大'
      : status === 415 ? '不支持的媒体类型或内容编码'
        : status === 404 ? '资源不存在'
          : '服务器内部错误'
    response.status(status).json({
      error: {
        code,
        message,
      },
    })
  })

  if (options.autoStartWorker !== false) {
    // Validate/stale durable pipeline parents before JobWorker.start() performs
    // its broad recovery scan. coordinator.enqueue() is safe while stopped and
    // the worker will deduplicate those IDs when it begins scheduling.
    try {
      const recovered = await coordinator.recover()
      for (const run of recovered) publishPipelineRun(run)
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error
      console.error('Pipeline recovery failed', { name })
    }
    await worker.start()
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await worker.stop()
    while (pipelineTasks.size > 0) {
      await Promise.allSettled([...pipelineTasks])
    }
    database.close()
  }
  return {
    app,
    database,
    worker,
    provider,
    mediaStore,
    eventHub,
    projectService,
    projectKnowledgeService,
    storyRepository,
    providerService,
    miniMaxVoiceCatalogService,
    indexTtsVoiceCatalogService,
    doubaoVoiceCatalogService,
    characterVoiceProfiles,
    projectNarratorVoiceProfiles,
    voicePreviewReviewService,
    linePerformanceProfiles,
    timelineDocumentService,
    timelineMaterializationService,
    timelineAutoEditService,
    timelineRevisionRestoreService,
    productionAssetManifestService,
    shotMediaReviewService,
    exportRenderService,
    qualityCheckService,
    releaseReviewService,
    assetRetentionService,
    pipelineRunCoordinator: coordinator,
    generatedDirectory,
    store: { flush: async () => undefined },
    queue: worker,
    close,
  }
}
