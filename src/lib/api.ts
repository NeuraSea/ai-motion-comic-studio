import type {
  CreateDialogueSpeechJobInput,
  AssetImageGenerationRequest,
  CreateAssetImageEditInput,
  CreateAssetTurnaroundDerivationInput,
  AdoptHistoricalVisualAssetInput,
  AssetHandle,
  AssetHandleVersion,
  AssetHandleVersionsResponse,
  AssetVersionSwitch,
  AssetVersionSwitchResponse,
  CharacterVoiceProfileMutationResponse,
  CharacterVoicePreviewJob,
  CreateVoicePreviewReviewInput,
  CharacterVoiceRecommendation,
  CharacterVoiceRecommendationJob,
  CreateExportRenderInput,
  CreateExportRenderResponse,
  CreatePipelineRunInput,
  CreateQualityCheckResponse,
  CreateReleaseReviewInput,
  CreateReleaseReviewResponse,
  CreateShotVideoBatchInput,
  CreateShotVideoVisualReferenceAnalysisInput,
  CreateShotVideoGenerationJobInput,
  GenerateImageInput,
  HealthResponse,
  HistoricalVisualAssetAdoption,
  HistoricalVisualAssetCandidate,
  HistoricalVisualAssetCandidatesResponse,
  HistoricalShotVideoCandidate,
  HistoricalShotVideoCandidatesResponse,
  HistoricalShotVideoRestoration,
  ImageJob,
  CreateEpisodeInput,
  CreateStoryShotInput,
  CreateStoryShotResponse,
  DeleteStoryShotInput,
  DeleteStoryShotResponse,
  DialoguePerformanceProfile,
  DialoguePerformanceProfileResponse,
  DialoguePerformanceRecommendation,
  DialoguePerformanceRecommendationJob,
  DialogueSpeechGenerationJob,
  EpisodeSummary,
  ExportRenderGenerationJob,
  ExportRenderRecord,
  ListImageJobsOptions,
  ListPipelineRunsOptions,
  GenerationJob,
  AssetLockResponse,
  CharacterVisualReferenceLockResponse,
  LockAssetInput,
  LockCharacterVisualReferencesInput,
  ListGenerationJobsOptions,
  MediaAsset,
  MiniMaxVoiceCatalog,
  MiniMaxVoiceCatalogEntry,
  PaidAigcAction,
  PublicPaidAigcConfirmation,
  ProjectRevision,
  ProjectKnowledgeSnapshot,
  ProjectSnapshot,
  ProjectSummary,
  ProviderConnection,
  ProductionAssetManifest,
  ProductionAssetManifestBlocker,
  ProductionAssetManifestContext,
  ProductionAssetManifestEntry,
  ProductionAssetManifestProjection,
  ProductionAssetManifestProjectionResponse,
  MaterializeProductionAssetManifestResponse,
  PipelineExportStep,
  PipelineFanoutStep,
  PipelineProviderBinding,
  PipelineQualityStep,
  PipelineRun,
  PipelineRunError,
  PipelineRunPreflight,
  PipelineRunPreflightInput,
  PipelineSpeechTargetBinding,
  PipelineStepId,
  PipelineTimelineStep,
  ProjectNarratorVoiceProfileMutationResponse,
  ProjectNarratorVoiceProfileState,
  ProjectNarratorVoicePreviewJob,
  QualityReport,
  ReleaseReview,
  RequestOptions,
  VoicePreviewReview,
  ResolveShotVideoUnknownSubmissionInput,
  ResolveShotVideoUnknownSubmissionResponse,
  SaveProviderCredentialsInput,
  SaveTimelineDocumentInput,
  SearchStoryEntitiesOptions,
  ShotMediaCandidate,
  ShotMediaDecisionResult,
  ShotMediaReviewDecision,
  ShotMediaReviewRecord,
  ShotMediaReviewSnapshot,
  ShotMediaType,
  ListShotMediaReviewInput,
  DecideShotMediaInput,
  ShotVideoGenerationJob,
  ShotVideoGenerationJobInput,
  ShotVideoGenerationJobOutput,
  ShotVideoGenerationSpec,
  ShotVideoDurationDecision,
  ShotVideoBatchPreflight,
  ShotVideoBatchPreflightInput,
  ShotVideoReferenceSelection,
  ShotVideoReferenceBinding,
  ShotVideoReferenceDecision,
  ShotVideoReferenceRecommendation,
  ShotVideoUnknownSubmissionResolution,
  ShotVideoVisualReferenceAnalysis,
  ShotVideoVisualReferenceAnalysisBatch,
  ShotVideoVisualReferenceAnalysisBatchResponse,
  ShotVideoVisualReferenceAnalysisBinding,
  ShotVideoVisualReferenceAuthority,
  ShotVideoVisualReferenceAnalysisJob,
  ShotVideoVisualReferenceAnalysisJobInput,
  SpeechSubtitleDocument,
  StoryDialogueLine,
  StoryDocument,
  StoryEntitySearchResponse,
  StoryEntitySearchResult,
  StoryCharacter,
  StoryCharacterVoiceDelivery,
  StoryCharacterVoiceProfile,
  StoryMutationResponse,
  StoryRevisionHistory,
  StoryScene,
  StorySceneMutationResponse,
  StoryShot,
  StoryShotMutationResponse,
  StoryStaleResult,
  ReorderStoryShotsInput,
  TimelineDocumentHistory,
  TimelineDocumentRecord,
  TimelineDocumentRevision,
  TimelineAutomaticEditOperation,
  TimelineAutoEditApplyResult,
  TimelineAutoEditDiagnostic,
  TimelineAutoEditPlan,
  TimelineAutoEditPreview,
  TimelineAutoEditUndoResult,
  TimelineEditApplication,
  TimelineEditUndoRecord,
  TimelineMaterializationSnapshot,
  TimelineDocumentSnapshot,
  TimelineRevisionRestoreRecord,
  TimelineRevisionRestoreResult,
  RestoreTimelineRevisionInput,
  ApplyTimelineAutoEditInput,
  PreviewTimelineAutoEditInput,
  UpdateStorySceneInput,
  UpdateStoryShotInput,
  UploadUserAudioOptions,
  UserAudioAsset,
  UserAudioAssetKind,
  UserAudioMimeType,
  PutCharacterVoiceProfileInput,
  PutProjectNarratorVoiceProfileInput,
  VisualAssetTarget,
  VisualAssetTargetsResponse,
} from './api-types'
import { isGenerationJob } from './generation-job-schema'

type ApiErrorPayload = {
  error?: {
    code?: unknown
    message?: unknown
    details?: unknown
  }
}

export interface ApiErrorOptions {
  status?: number
  code?: string
  details?: unknown
  cause?: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = 'ApiError'
    this.status = options.status ?? 0
    this.code = options.code ?? 'UNKNOWN_ERROR'
    this.details = options.details
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (isRecord(error) && error.name === 'AbortError')
}

function responseError(status: number, payload: unknown): ApiError {
  const errorBody = isRecord(payload) ? payload as ApiErrorPayload : undefined
  const serverError = errorBody?.error
  const serverMessage = typeof serverError?.message === 'string'
    ? serverError.message.trim()
    : ''
  const code = typeof serverError?.code === 'string'
    ? serverError.code
    : `HTTP_${status}`

  const fallbackByStatus: Record<number, string> = {
    400: '请求参数有误',
    401: '请先登录后再继续',
    403: '当前账号无权执行此操作',
    404: '请求的资源不存在',
    409: '请求与当前状态冲突',
    412: '内容已被其他操作更新，请刷新后重试',
    413: '提交的内容过大',
    428: '请先读取最新版本再执行操作',
    429: '请求过于频繁，请稍后重试',
    500: '服务暂时不可用',
    502: '上游 AI 服务暂时不可用',
    503: '服务正在忙，请稍后重试',
    504: 'AI 服务响应超时',
  }
  const friendlyMessage = fallbackByStatus[status]
    ?? (status >= 500 ? '服务暂时异常' : '请求未成功')
  const message = serverMessage
    ? `${friendlyMessage}：${serverMessage}`
    : `${friendlyMessage}（HTTP ${status}）`

  return new ApiError(message, {
    status,
    code,
    details: serverError?.details,
  })
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined

  const text = await response.text()
  if (!text) return undefined

  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    if (!response.ok) return text
    throw new ApiError('服务返回了无法识别的数据，请稍后重试。', {
      status: response.status,
      code: 'INVALID_RESPONSE',
      cause,
    })
  }
}

interface ApiResponse<T> {
  payload: T
  response: Response
}

async function requestWithResponse<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  let response: Response

  try {
    response = await fetch(path, { ...init, signal })
  } catch (cause) {
    if (isAbortError(cause, signal)) {
      throw new ApiError('请求已取消。', {
        code: 'REQUEST_ABORTED',
        cause,
      })
    }
    throw new ApiError('无法连接到服务，请确认本地 API 服务已启动后重试。', {
      code: 'NETWORK_ERROR',
      cause,
    })
  }

  const payload = await readBody(response)
  if (!response.ok) throw responseError(response.status, payload)
  return { payload: payload as T, response }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  return (await requestWithResponse<T>(path, init, signal)).payload
}

function expectEnvelope<T>(
  payload: unknown,
  key: string,
  validate: (value: unknown) => boolean,
): T {
  if (!isRecord(payload) || !(key in payload) || !validate(payload[key])) {
    throw new ApiError('服务返回的数据格式不正确，请刷新后重试。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload[key] as T
}

function jsonRequest(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

function jsonRequestWithHeaders(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: unknown,
  headers: Record<string, string>,
): RequestInit {
  return {
    ...jsonRequest(method, body),
    headers: { 'Content-Type': 'application/json', ...headers },
  }
}

function encoded(value: string): string {
  return encodeURIComponent(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isEpisodeSummary(value: unknown): value is EpisodeSummary {
  return isRecord(value)
    && isString(value.id)
    && isString(value.projectId)
    && isString(value.title)
    && isString(value.sourceText)
    && (value.targetDurationSeconds === null || typeof value.targetDurationSeconds === 'number')
    && isString(value.aspectRatio)
    && isString(value.stylePreset)
    && isString(value.status)
    && isNonNegativeInteger(value.sortOrder)
    && isNullableString(value.sourceRevisionId)
    && isString(value.createdAt)
    && isString(value.updatedAt)
}

function isStoryDialogueLine(value: unknown): value is StoryDialogueLine {
  return isRecord(value)
    && isString(value.id)
    && isNonNegativeInteger(value.sequence)
    && (value.kind === 'dialogue' || value.kind === 'narration')
    && isString(value.speaker)
    && isString(value.text)
}

function isStoryShot(value: unknown): value is StoryShot {
  return isRecord(value)
    && isString(value.id)
    && isNonNegativeInteger(value.sequence)
    && isString(value.code)
    && isString(value.title)
    && isString(value.description)
    && isString(value.framing)
    && isString(value.movement)
    && isString(value.transition)
    && typeof value.durationSeconds === 'number'
    && Number.isFinite(value.durationSeconds)
    && isString(value.visualPrompt)
    && Array.isArray(value.dialogueLines)
    && value.dialogueLines.every(isStoryDialogueLine)
}

function isStoryScene(value: unknown): value is StoryScene {
  return isRecord(value)
    && isString(value.id)
    && isNonNegativeInteger(value.sequence)
    && isString(value.title)
    && isString(value.locationId)
    && isString(value.timeOfDay)
    && isString(value.description)
    && Array.isArray(value.shots)
    && value.shots.every(isStoryShot)
}

const storyEntityTypes = new Set([
  'scene',
  'shot',
  'dialogue',
  'character',
  'location',
  'prop',
])

function isStoryEntitySearchResult(value: unknown): value is StoryEntitySearchResult {
  if (!isRecord(value)
    || !hasExactlyKeys(value, [
      'entityId',
      'type',
      'title',
      'snippet',
      'sceneId',
      'shotId',
      'sourceRevisionId',
    ])
    || !isString(value.entityId)
    || !value.entityId
    || !isString(value.type)
    || !storyEntityTypes.has(value.type)
    || !isString(value.title)
    || !value.title
    || !isString(value.snippet)
    || !value.snippet
    || !isNullableString(value.sceneId)
    || !isNullableString(value.shotId)
    || !isString(value.sourceRevisionId)
    || !value.sourceRevisionId) {
    return false
  }

  if (value.type === 'scene') {
    return value.sceneId === value.entityId && value.shotId === null
  }
  if (value.type === 'shot') {
    return value.sceneId !== null && value.shotId === value.entityId
  }
  if (value.type === 'dialogue') {
    return value.sceneId !== null && value.shotId !== null
  }
  return value.sceneId === null && value.shotId === null
}

const characterVoiceEmotions = new Set([
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'calm',
  'fluent',
  'whisper',
])

function isCharacterVoiceDelivery(value: unknown): value is StoryCharacterVoiceDelivery {
  return isRecord(value)
    && typeof value.emotion === 'string'
    && characterVoiceEmotions.has(value.emotion)
    && typeof value.speed === 'number'
    && Number.isFinite(value.speed)
    && value.speed >= 0.5
    && value.speed <= 2
    && typeof value.pitch === 'number'
    && Number.isInteger(value.pitch)
    && value.pitch >= -12
    && value.pitch <= 12
}

function isCharacterVoiceSceneDirection(
  value: unknown,
): value is StoryCharacterVoiceDelivery & { sceneId: string; rationale: string } {
  return isRecord(value)
    && isCharacterVoiceDelivery(value)
    && isString(value.sceneId)
    && value.sceneId.length > 0
    && isString(value.rationale)
}

function isCharacterVoiceProfile(value: unknown): value is StoryCharacterVoiceProfile {
  return isRecord(value)
    && value.version === 1
    && isString(value.voiceId)
    && value.voiceId.length > 0
    && isString(value.providerId)
    && value.providerId.length > 0
    && Number.isSafeInteger(value.providerConfigRevision)
    && (value.providerConfigRevision as number) > 0
    && (value.voiceType === 'system'
      || value.voiceType === 'voice_cloning'
      || value.voiceType === 'voice_generation')
    && isString(value.voiceName)
    && value.voiceName.length > 0
    && Array.isArray(value.descriptions)
    && value.descriptions.every(isString)
    && (value.selectionSource === 'manual' || value.selectionSource === 'agentic')
    && (value.selectionRationale === undefined || isString(value.selectionRationale))
    && (value.profileTags === undefined
      || (Array.isArray(value.profileTags) && value.profileTags.every(isString)))
    && (value.defaultDelivery === undefined || isCharacterVoiceDelivery(value.defaultDelivery))
    && (value.sceneDirections === undefined
      || (Array.isArray(value.sceneDirections) && value.sceneDirections.every(isCharacterVoiceSceneDirection)))
    && (value.recommendationJobId === undefined || isString(value.recommendationJobId))
    && isString(value.catalogFingerprint)
    && /^[0-9a-f]{64}$/.test(value.catalogFingerprint)
    && isString(value.catalogObservedAt)
    && Number.isFinite(Date.parse(value.catalogObservedAt))
    && typeof value.historicalPin === 'boolean'
    && isString(value.updatedAt)
    && Number.isFinite(Date.parse(value.updatedAt))
}

function isProjectNarratorVoiceProject(
  value: unknown,
  expectedProjectId: string,
): value is ProjectNarratorVoiceProfileState['project'] {
  return isRecord(value)
    && hasOnlyKeys(value, ['id', 'title', 'currentRevisionId', 'updatedAt'])
    && isString(value.id)
    && value.id === expectedProjectId
    && isString(value.title)
    && isNullableString(value.currentRevisionId)
    && isString(value.updatedAt)
    && Number.isFinite(Date.parse(value.updatedAt))
}

function isProjectNarratorVoiceStaleResult(
  value: unknown,
): value is ProjectNarratorVoiceProfileMutationResponse['stale'] {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'speechAssets',
      'exportAssets',
      'jobs',
      'narrationLines',
      'exports',
      'qualityReports',
      'pipelineRuns',
    ])
    && Object.values(value).every(isNonNegativeInteger)
}

function parseProjectNarratorVoiceProfileState(
  payload: unknown,
  response: Response,
  projectId: string,
): ProjectNarratorVoiceProfileState {
  if (!isRecord(payload)
    || !hasOnlyKeys(payload, ['project', 'voiceProfile', 'revisionId'])
    || !isProjectNarratorVoiceProject(payload.project, projectId)
    || !(payload.voiceProfile === null || isCharacterVoiceProfile(payload.voiceProfile))
    || !isNullableString(payload.revisionId)
    || ((payload.voiceProfile === null) !== (payload.revisionId === null))) {
    throw new ApiError('服务返回的项目旁白声线档案格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    project: payload.project,
    voiceProfile: payload.voiceProfile,
    revisionId: payload.revisionId,
    etag: requiredOpaqueEtag(response, payload, '服务返回的项目旁白声线 ETag 无效。'),
  }
}

function parseProjectNarratorVoiceProfileMutation(
  payload: unknown,
  response: Response,
  projectId: string,
): ProjectNarratorVoiceProfileMutationResponse {
  if (!isRecord(payload)
    || !hasOnlyKeys(payload, ['project', 'voiceProfile', 'revisionId', 'stale'])
    || !isProjectNarratorVoiceProject(payload.project, projectId)
    || !(payload.voiceProfile === null || isCharacterVoiceProfile(payload.voiceProfile))
    || !isString(payload.revisionId)
    || !payload.revisionId
    || !isProjectNarratorVoiceStaleResult(payload.stale)) {
    throw new ApiError('服务返回的项目旁白声线修订格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    project: payload.project,
    voiceProfile: payload.voiceProfile,
    revisionId: payload.revisionId,
    stale: payload.stale,
    etag: requiredOpaqueEtag(response, payload, '服务返回的项目旁白声线修订 ETag 无效。'),
  }
}

function isMiniMaxVoiceCatalogEntry(value: unknown): value is MiniMaxVoiceCatalogEntry {
  return isRecord(value)
    && hasOnlyKeys(value, ['voiceId', 'name', 'descriptions', 'type'])
    && isString(value.voiceId)
    && value.voiceId.length > 0
    && isString(value.name)
    && value.name.length > 0
    && Array.isArray(value.descriptions)
    && value.descriptions.every(isString)
    && (value.type === 'system' || value.type === 'voice_cloning' || value.type === 'voice_generation')
}

function isMiniMaxVoiceCatalog(value: unknown): value is MiniMaxVoiceCatalog {
  return isRecord(value)
    && hasOnlyKeys(value, ['provider', 'observedAt', 'fingerprint', 'voices'])
    && isRecord(value.provider)
    && hasOnlyKeys(value.provider, ['id', 'configRevision', 'model'])
    && (value.provider.id === 'minimax-speech'
      || value.provider.id === 'indextts-speech'
      || value.provider.id === 'doubao-speech')
    && Number.isSafeInteger(value.provider.configRevision)
    && (value.provider.configRevision as number) > 0
    && isString(value.provider.model)
    && value.provider.model.length > 0
    && isString(value.observedAt)
    && Number.isFinite(Date.parse(value.observedAt))
    && isString(value.fingerprint)
    && /^[0-9a-f]{64}$/.test(value.fingerprint)
    && Array.isArray(value.voices)
    && value.voices.every(isMiniMaxVoiceCatalogEntry)
    && new Set(value.voices.map((voice) => (voice as MiniMaxVoiceCatalogEntry).voiceId)).size === value.voices.length
}

function isCharacterVoiceRecommendation(value: unknown): value is CharacterVoiceRecommendation {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'version',
      'catalogFingerprint',
      'selectedVoiceId',
      'rationale',
      'profileTags',
      'alternatives',
      'defaultDelivery',
      'sceneDirections',
    ])
    || value.version !== 'character-voice-agent-v1'
    || !isString(value.catalogFingerprint)
    || !/^[0-9a-f]{64}$/.test(value.catalogFingerprint)
    || !isString(value.selectedVoiceId)
    || !value.selectedVoiceId
    || !isString(value.rationale)
    || !value.rationale
    || !Array.isArray(value.profileTags)
    || value.profileTags.length < 1
    || value.profileTags.length > 8
    || !value.profileTags.every(isString)
    || !Array.isArray(value.alternatives)
    || value.alternatives.length > 2
    || !value.alternatives.every((alternative) => isRecord(alternative)
      && hasOnlyKeys(alternative, ['voiceId', 'rationale'])
      && isString(alternative.voiceId)
      && Boolean(alternative.voiceId)
      && isString(alternative.rationale)
      && Boolean(alternative.rationale))
    || !isCharacterVoiceDelivery(value.defaultDelivery)
    || !Array.isArray(value.sceneDirections)
    || !value.sceneDirections.every((direction) => isRecord(direction)
      && hasOnlyKeys(direction, ['sceneId', 'emotion', 'speed', 'pitch', 'rationale'])
      && isCharacterVoiceDelivery(direction)
      && isString(direction.sceneId)
      && Boolean(direction.sceneId)
      && isString(direction.rationale)
      && Boolean(direction.rationale))) return false

  const voiceIds = [
    value.selectedVoiceId,
    ...value.alternatives.map((alternative) => (alternative as { voiceId: string }).voiceId),
  ]
  return new Set(voiceIds).size === voiceIds.length
}

function isCharacterVoiceRecommendationJobInput(
  value: unknown,
): value is CharacterVoiceRecommendationJob['input'] {
  return isRecord(value)
    && hasOnlyKeys(value, ['episodeId', 'characterId', 'expectedStoryRevisionId', 'catalog'])
    && isString(value.episodeId)
    && isString(value.characterId)
    && isString(value.expectedStoryRevisionId)
    && isRecord(value.catalog)
    && hasOnlyKeys(value.catalog, ['providerId', 'providerConfigRevision', 'fingerprint', 'voiceCount'])
    && (value.catalog.providerId === 'minimax-speech'
      || value.catalog.providerId === 'indextts-speech'
      || value.catalog.providerId === 'doubao-speech')
    && Number.isSafeInteger(value.catalog.providerConfigRevision)
    && (value.catalog.providerConfigRevision as number) > 0
    && isString(value.catalog.fingerprint)
    && /^[0-9a-f]{64}$/.test(value.catalog.fingerprint)
    && isNonNegativeInteger(value.catalog.voiceCount)
}

function asCharacterVoiceRecommendationJob(value: unknown): CharacterVoiceRecommendationJob {
  if (!isRecord(value)
    || value.type !== 'character.voice.recommend'
    || !isCharacterVoiceRecommendationJobInput(value.input)) {
    throw new ApiError('服务返回的角色声线推荐任务格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: value,
    })
  }
  if (value.status === 'succeeded') {
    if (!isRecord(value.output)
      || !hasOnlyKeys(value.output, ['characterId', 'recommendation'])
      || !isString(value.output.characterId)
      || !isCharacterVoiceRecommendation(value.output.recommendation)
      || value.input.characterId !== value.output.characterId
      || value.input.catalog.fingerprint !== value.output.recommendation.catalogFingerprint) {
      throw new ApiError('服务返回的角色声线推荐结果格式不正确。', {
        code: 'INVALID_RESPONSE',
        details: value,
      })
    }
  }
  return value as unknown as CharacterVoiceRecommendationJob
}

function isCharacterVoicePreviewJobInput(value: unknown): value is CharacterVoicePreviewJob['input'] {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'episodeId',
      'characterId',
      'expectedStoryRevisionId',
      'voiceId',
      'expectedCatalogFingerprint',
      'expectedProviderConfigRevision',
    ])
    && isString(value.episodeId)
    && isString(value.characterId)
    && isString(value.expectedStoryRevisionId)
    && isString(value.voiceId)
    && Boolean(value.voiceId)
    && isString(value.expectedCatalogFingerprint)
    && /^[0-9a-f]{64}$/.test(value.expectedCatalogFingerprint)
    && Number.isSafeInteger(value.expectedProviderConfigRevision)
    && (value.expectedProviderConfigRevision as number) > 0
}

function isCharacterVoicePreviewJobOutput(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'characterId',
      'voiceId',
      'sampleSource',
      'sampleCharacterCount',
      'asset',
      'provider',
    ])
    && isString(value.characterId)
    && isString(value.voiceId)
    && (value.sampleSource === 'dialogue' || value.sampleSource === 'fallback')
    && isNonNegativeInteger(value.sampleCharacterCount)
    && (value.sampleCharacterCount as number) > 0
    && isMediaAsset(value.asset)
    && value.asset.kind === 'character.voice.preview'
    && value.asset.mimeType === 'audio/mpeg'
    && value.asset.source === 'provider'
    && isRecord(value.provider)
    && hasOnlyKeys(value.provider, ['id', 'model', 'configRevision'])
    && (value.provider.id === 'minimax-speech'
      || value.provider.id === 'indextts-speech'
      || value.provider.id === 'doubao-speech')
    && isString(value.provider.model)
    && Boolean(value.provider.model)
    && Number.isSafeInteger(value.provider.configRevision)
    && (value.provider.configRevision as number) > 0
}

function asCharacterVoicePreviewJob(value: unknown): CharacterVoicePreviewJob {
  if (!isRecord(value)
    || value.type !== 'character.voice.preview'
    || !isString(value.id)
    || !isString(value.projectId)
    || !isNullableString(value.episodeId)
    || !generationJobStatuses.has(value.status as string)
    || typeof value.progress !== 'number'
    || !isNonNegativeInteger(value.attempt)
    || !isCharacterVoicePreviewJobInput(value.input)
    || !isString(value.createdAt)
    || !isString(value.updatedAt)
    || (value.output !== undefined
      && value.output !== null
      && !isCharacterVoicePreviewJobOutput(value.output))
    || (value.status === 'succeeded' && !isCharacterVoicePreviewJobOutput(value.output))) {
    throw new ApiError('服务返回的角色声线试听任务格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: value,
    })
  }
  const job = value as unknown as CharacterVoicePreviewJob
  if (job.output && (job.output.characterId !== job.input.characterId
    || job.output.voiceId !== job.input.voiceId
    || job.output.provider.configRevision !== job.input.expectedProviderConfigRevision)) {
    throw new ApiError('服务返回的角色声线试听结果与请求绑定不一致。', {
      code: 'INVALID_RESPONSE',
      details: value,
    })
  }
  return job
}

function isProjectNarratorVoicePreviewJobInput(
  value: unknown,
): value is ProjectNarratorVoicePreviewJob['input'] {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'episodeId',
      'expectedStoryRevisionId',
      'voiceId',
      'expectedCatalogFingerprint',
      'expectedProviderConfigRevision',
    ])
    && isString(value.episodeId)
    && isString(value.expectedStoryRevisionId)
    && isString(value.voiceId)
    && Boolean(value.voiceId)
    && isString(value.expectedCatalogFingerprint)
    && /^[0-9a-f]{64}$/.test(value.expectedCatalogFingerprint)
    && Number.isSafeInteger(value.expectedProviderConfigRevision)
    && (value.expectedProviderConfigRevision as number) > 0
}

function isProjectNarratorVoicePreviewJobOutput(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'episodeId',
      'voiceId',
      'sampleSource',
      'sampleCharacterCount',
      'asset',
      'provider',
    ])
    && isString(value.episodeId)
    && isString(value.voiceId)
    && (value.sampleSource === 'narration' || value.sampleSource === 'fallback')
    && isNonNegativeInteger(value.sampleCharacterCount)
    && (value.sampleCharacterCount as number) > 0
    && isMediaAsset(value.asset)
    && value.asset.kind === 'project.narrator.voice.preview'
    && value.asset.mimeType === 'audio/mpeg'
    && value.asset.source === 'provider'
    && isRecord(value.provider)
    && hasOnlyKeys(value.provider, ['id', 'model', 'configRevision'])
    && (value.provider.id === 'minimax-speech'
      || value.provider.id === 'indextts-speech'
      || value.provider.id === 'doubao-speech')
    && isString(value.provider.model)
    && Boolean(value.provider.model)
    && Number.isSafeInteger(value.provider.configRevision)
    && (value.provider.configRevision as number) > 0
}

function asProjectNarratorVoicePreviewJob(value: unknown): ProjectNarratorVoicePreviewJob {
  if (!isRecord(value)
    || value.type !== 'project.narrator.voice.preview'
    || !isString(value.id)
    || !isString(value.projectId)
    || !isNullableString(value.episodeId)
    || !generationJobStatuses.has(value.status as string)
    || typeof value.progress !== 'number'
    || !isNonNegativeInteger(value.attempt)
    || !isProjectNarratorVoicePreviewJobInput(value.input)
    || !isString(value.createdAt)
    || !isString(value.updatedAt)
    || (value.output !== undefined
      && value.output !== null
      && !isProjectNarratorVoicePreviewJobOutput(value.output))
    || (value.status === 'succeeded' && !isProjectNarratorVoicePreviewJobOutput(value.output))) {
    throw new ApiError('服务返回的项目旁白试听任务格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: value,
    })
  }
  const job = value as unknown as ProjectNarratorVoicePreviewJob
  if (job.episodeId !== job.input.episodeId
    || (job.output && (job.output.episodeId !== job.input.episodeId
      || job.output.voiceId !== job.input.voiceId
      || job.output.provider.configRevision !== job.input.expectedProviderConfigRevision))) {
    throw new ApiError('服务返回的项目旁白试听结果与请求绑定不一致。', {
      code: 'INVALID_RESPONSE',
      details: value,
    })
  }
  return job
}

const voicePreviewReviewInvalidReasons = new Set([
  'SUPERSEDED',
  'STORY_REVISION_CHANGED',
  'PROVIDER_REVISION_CHANGED',
  'PREVIEW_BINDING_CHANGED',
  'PLAYBACK_EVIDENCE_LEGACY',
])

function isVoicePreviewPlaybackEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.version === 'legacy-ended-v1') {
    return hasOnlyKeys(value, ['version'])
  }
  if (!(value.version === 'html-media-played-v1'
    && hasOnlyKeys(value, ['version', 'durationSeconds', 'ranges'])
    && typeof value.durationSeconds === 'number'
    && Number.isFinite(value.durationSeconds)
    && value.durationSeconds > 0
    && Array.isArray(value.ranges)
    && value.ranges.length >= 1
    && value.ranges.length <= 64
    && value.ranges.every((range) => (
      isRecord(range)
      && hasOnlyKeys(range, ['startSeconds', 'endSeconds'])
      && typeof range.startSeconds === 'number'
      && Number.isFinite(range.startSeconds)
      && range.startSeconds >= 0
      && typeof range.endSeconds === 'number'
      && Number.isFinite(range.endSeconds)
      && range.endSeconds > range.startSeconds
      && range.endSeconds <= (value.durationSeconds as number) + 0.2
    )))) return false
  const ranges = value.ranges as Array<{ startSeconds: number; endSeconds: number }>
  if (ranges[0]!.startSeconds > 0.2
    || ranges[ranges.length - 1]!.endSeconds < (value.durationSeconds as number) - 0.2) return false
  return ranges.every((range, index) => {
    const previous = ranges[index - 1]
    return !previous
      || (range.startSeconds >= previous.startSeconds
        && range.startSeconds <= previous.endSeconds + 0.2)
  })
}

function isVoicePreviewReview(value: unknown): value is VoicePreviewReview {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'id',
      'projectId',
      'episodeId',
      'subjectType',
      'subjectId',
      'previewJobId',
      'previewAssetId',
      'previewAssetChecksum',
      'voiceId',
      'providerId',
      'model',
      'providerConfigRevision',
      'catalogFingerprint',
      'storyRevisionId',
      'decision',
      'notes',
      'playbackCompletedAt',
      'playbackEvidence',
      'reviewedAt',
      'isCurrent',
      'invalidReasons',
    ])
    && isString(value.id)
    && isString(value.projectId)
    && isString(value.episodeId)
    && (value.subjectType === 'character' || value.subjectType === 'project_narrator')
    && isString(value.subjectId)
    && isString(value.previewJobId)
    && isString(value.previewAssetId)
    && isString(value.previewAssetChecksum)
    && /^[0-9a-f]{64}$/.test(value.previewAssetChecksum)
    && isString(value.voiceId)
    && isString(value.providerId)
    && isString(value.model)
    && Number.isSafeInteger(value.providerConfigRevision)
    && (value.providerConfigRevision as number) > 0
    && isString(value.catalogFingerprint)
    && /^[0-9a-f]{64}$/.test(value.catalogFingerprint)
    && isString(value.storyRevisionId)
    && (value.decision === 'approve' || value.decision === 'reject')
    && isNullableString(value.notes)
    && isString(value.playbackCompletedAt)
    && isVoicePreviewPlaybackEvidence(value.playbackEvidence)
    && isString(value.reviewedAt)
    && typeof value.isCurrent === 'boolean'
    && Array.isArray(value.invalidReasons)
    && value.invalidReasons.every((reason) => (
      isString(reason) && voicePreviewReviewInvalidReasons.has(reason)
    ))
}

function isStoryCharacter(value: unknown): value is StoryCharacter {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && isString(value.role)
    && isString(value.storyDescription)
    && isString(value.visualDescription)
    && (value.voiceProfile === undefined || isCharacterVoiceProfile(value.voiceProfile))
}

function isStoryDocument(value: unknown): value is StoryDocument {
  return isRecord(value)
    && value.version === 1
    && isString(value.title)
    && typeof value.targetDurationSeconds === 'number'
    && Number.isFinite(value.targetDurationSeconds)
    && isRecord(value.bible)
    && isString(value.bible.logline)
    && isString(value.bible.theme)
    && isString(value.bible.tone)
    && isString(value.bible.visualStyle)
    && Array.isArray(value.characters)
    && value.characters.every(isStoryCharacter)
    && Array.isArray(value.locations)
    && value.locations.every((location) => isRecord(location)
      && isString(location.id)
      && isString(location.name)
      && isString(location.storyDescription)
      && isString(location.visualDescription))
    && Array.isArray(value.props)
    && value.props.every((prop) => isRecord(prop)
      && isString(prop.id)
      && isString(prop.name)
      && isString(prop.description)
      && isString(prop.visualDescription))
    && Array.isArray(value.scenes)
    && value.scenes.every(isStoryScene)
}

function isStoryStaleResult(value: unknown): value is StoryStaleResult {
  return isRecord(value)
    && isNonNegativeInteger(value.assets)
    && isNonNegativeInteger(value.jobs)
    && isNonNegativeInteger(value.exports)
    && isNonNegativeInteger(value.qualityReports)
    && isNonNegativeInteger(value.pipelineRuns)
}

function invalidStoryMutation(payload: unknown): never {
  throw new ApiError('服务返回的剧本修订数据格式不正确。', {
    code: 'INVALID_RESPONSE',
    details: payload,
  })
}

function requiredOpaqueEtag(response: Response, payload: unknown, message: string): string {
  const etag = response.headers.get('ETag')?.trim()
  if (!etag || !/^(?:W\/)?"[^"\s]+"$/.test(etag)) {
    throw new ApiError(message, {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return etag
}

function parseStoryMutationResponse(
  payload: unknown,
  response: Response,
): StoryMutationResponse {
  if (
    !isRecord(payload)
    || !isEpisodeSummary(payload.episode)
    || !isStoryDocument(payload.story)
    || !isString(payload.revisionId)
    || !payload.revisionId
    || !isStoryStaleResult(payload.stale)
    || payload.episode.sourceRevisionId !== payload.revisionId
  ) {
    return invalidStoryMutation(payload)
  }

  const etag = requiredOpaqueEtag(response, payload, '服务返回的分集 ETag 无效。')

  return {
    episode: payload.episode,
    story: payload.story,
    revisionId: payload.revisionId,
    stale: payload.stale,
    etag,
  }
}

function isSpeechSubtitleDocument(value: unknown): value is SpeechSubtitleDocument {
  if (!isRecord(value)
    || value.version !== 1
    || !isNonEmptyString(value.lineId)) return false
  if (value.mode === 'sentence-fallback') {
    return hasExactlyKeys(value, ['version', 'lineId', 'mode', 'reason'])
      && isNonEmptyString(value.reason)
      && value.reason.length <= 100
      && /^[a-z0-9._-]+$/i.test(value.reason)
  }
  if (value.mode !== 'word'
    || !hasExactlyKeys(value, ['version', 'lineId', 'mode', 'granularity', 'cues'])
    || (value.granularity !== 'word' && value.granularity !== 'sentence')
    || !Array.isArray(value.cues)
    || value.cues.length < 1
    || value.cues.length > 2_000) return false
  let previousEndMs = 0
  let totalText = 0
  for (const cue of value.cues) {
    if (!isRecord(cue)
      || !hasExactlyKeys(cue, ['text', 'startMs', 'endMs'])
      || typeof cue.text !== 'string'
      || cue.text.trim() !== cue.text
      || cue.text.length < 1
      || [...cue.text].length > 1_000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cue.text)
      || !Number.isSafeInteger(cue.startMs)
      || !Number.isSafeInteger(cue.endMs)
      || (cue.startMs as number) < previousEndMs
      || (cue.endMs as number) <= (cue.startMs as number)
      || (cue.endMs as number) > 60 * 60 * 1_000) return false
    previousEndMs = cue.endMs as number
    totalText += [...cue.text].length
    if (totalText > 20_000) return false
  }
  return true
}

function isMediaAsset(value: unknown): value is MediaAsset {
  return isRecord(value)
    && isString(value.id)
    && isString(value.projectId)
    && isNullableString(value.episodeId)
    && isString(value.kind)
    && isNonNegativeInteger(value.version)
    && isString(value.status)
    && isNullableString(value.mimeType)
    && (value.width === null || typeof value.width === 'number')
    && (value.height === null || typeof value.height === 'number')
    && (value.durationSeconds === null || typeof value.durationSeconds === 'number')
    && isNullableString(value.checksum)
    && isString(value.source)
    && isNullableString(value.providerId)
    && isNullableString(value.generationJobId)
    && isNullableString(value.sourceRevisionId)
    && isNullableString(value.parentAssetId)
    && (value.etag === undefined
      || (isString(value.etag) && /^"asset-v[1-9]\d*-[a-f0-9]{64}"$/.test(value.etag)))
    && (value.speechSubtitle === undefined
      || (value.kind === 'speech' && isSpeechSubtitleDocument(value.speechSubtitle)))
    && isString(value.url)
    && isString(value.createdAt)
    && isString(value.updatedAt)
}

const userAudioMimeAliases: Readonly<Record<string, UserAudioMimeType>> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
}

function normalizeUserAudioMimeType(value: string): UserAudioMimeType {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const mimeType = userAudioMimeAliases[normalized]
  if (!mimeType) {
    throw new ApiError('音频上传仅支持 MP3 或 WAV 文件。', {
      code: 'UNSUPPORTED_AUDIO_TYPE',
      details: { mimeType: value },
    })
  }
  return mimeType
}

function normalizeUploadName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (
    !normalized
    || normalized.length > 200
    || /[\u0000-\u001f\u007f/\\]/.test(normalized)
    || normalized === '.'
    || normalized === '..'
  ) {
    throw new ApiError('上传文件名格式无效。', {
      code: 'INVALID_UPLOAD_NAME',
      details: { name: value },
    })
  }
  return normalized
}

function isUserAudioAsset(
  value: unknown,
  expected: {
    projectId: string
    episodeId: string
    kind: UserAudioAssetKind
    mimeType: UserAudioMimeType
    name?: string
  },
): value is UserAudioAsset {
  if (
    !isMediaAsset(value)
    || !isNonEmptyString(value.id)
    || value.projectId !== expected.projectId
    || value.episodeId !== expected.episodeId
    || value.kind !== expected.kind
    || value.version < 1
    || value.status !== 'ready'
    || value.mimeType !== expected.mimeType
    || value.width !== null
    || value.height !== null
    || typeof value.durationSeconds !== 'number'
    || !Number.isFinite(value.durationSeconds)
    || value.durationSeconds <= 0
    || typeof value.checksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.checksum)
    || value.source !== 'upload'
    || value.providerId !== null
    || value.generationJobId !== null
    || value.sourceRevisionId !== null
    || value.parentAssetId !== null
    || value.url !== `/api/v1/assets/${encodeURIComponent(value.id)}/content`
    || !isNonEmptyString(value.createdAt)
    || !isNonEmptyString(value.updatedAt)
  ) {
    return false
  }
  if (expected.name !== undefined) return value.originalFileName === expected.name
  return value.originalFileName === undefined || isNonEmptyString(value.originalFileName)
}

function isProjectRevision(value: unknown): value is ProjectRevision {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.projectId)
    && isNullableString(value.parentRevisionId)
    && isString(value.summary)
    && (value.snapshot === undefined || isRecord(value.snapshot))
    && isString(value.createdAt)
}

function isVisualAssetTarget(value: unknown): value is VisualAssetTarget {
  const base = isRecord(value)
    && (value.type === 'character' || value.type === 'location' || value.type === 'prop')
    && isString(value.id)
    && isString(value.name)
    && isString(value.description)
    && isString(value.visualDescription)
    && isNullableString(value.role)
    && Number.isInteger(value.version)
    && (value.version as number) >= 1
    && isNullableString(value.lockedAssetId)
  if (!base) return false
  if (value.lockedReferences === undefined) return true
  return value.type === 'character'
    && isRecord(value.lockedReferences)
    && isNullableString(value.lockedReferences.frontAssetId)
    && isNullableString(value.lockedReferences.sideAssetId)
    && isNullableString(value.lockedReferences.backAssetId)
}

const dialogueSpeechEmotions = new Set([
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'calm',
  'fluent',
  'whisper',
])
const dialogueSpeechFormats = new Set(['mp3', 'wav'])
const dialogueSpeechSampleRates = new Set([8_000, 16_000, 22_050, 24_000, 32_000, 44_100])
const dialogueSpeechBitrates = new Set([32_000, 64_000, 128_000, 256_000])
const generationJobStatuses = new Set([
  'queued',
  'running',
  'waiting_provider',
  'succeeded',
  'failed',
  'cancelled',
])

const shotVideoResolutions = new Set(['480p', '720p', '1080p'])
const shotVideoAspectRatios = new Set(['16:9', '9:16', '1:1'])
const shotVideoAudioPolicies = new Set(['sfx_only', 'silent', 'provider_audio'])
const shotVideoPromptCompilerVersions = new Set([
  'seedance-compact-v1',
  'seedance-verbose-baseline-v1',
])
const shotVideoDurationSources = new Set(['speech_assets', 'story_duration', 'manual_override'])
const shotVideoDurationNotices = new Set([
  'AUDIO_DRIVEN_TIMELINE',
  'PROVIDER_MINIMUM_SOURCE_WILL_BE_TRIMMED',
  'MANUAL_DURATION_ADDS_SILENT_TAIL',
  'LINE_DURATION_METADATA_DIFFERS_FROM_ASSET',
  'STORY_DURATION_USED_WITHOUT_SPEECH',
])
const shotMediaTypes = new Set<ShotMediaType>(['storyboard', 'video'])
const shotMediaReviewDecisions = new Set<ShotMediaReviewDecision>(['adopt', 'reject', 'restore'])

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0
}

function isShotVideoGenerationSpec(value: unknown): value is ShotVideoGenerationSpec {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'version',
      'promptCompilerVersion',
      'subjectNames',
      'scene',
      'action',
      'shotSize',
      'cameraMovement',
      'audioPolicy',
      'audioLines',
      'durationSeconds',
      'resolution',
      'aspectRatio',
      'sourceRevisionId',
      'references',
    ])
    && value.version === 1
    && shotVideoPromptCompilerVersions.has(String(value.promptCompilerVersion))
    && Array.isArray(value.subjectNames)
    && value.subjectNames.length <= 8
    && value.subjectNames.every((item) => isNonEmptyString(item) && item.length <= 80)
    && typeof value.scene === 'string'
    && value.scene.length <= 2_000
    && isNonEmptyString(value.action)
    && value.action.length <= 4_000
    && typeof value.shotSize === 'string'
    && value.shotSize.length <= 500
    && typeof value.cameraMovement === 'string'
    && value.cameraMovement.length <= 500
    && shotVideoAudioPolicies.has(String(value.audioPolicy))
    && (value.audioLines === undefined
      || (value.audioPolicy === 'provider_audio'
        && Array.isArray(value.audioLines)
        && value.audioLines.length <= 8
        && value.audioLines.every((line) => isRecord(line)
          && hasOnlyKeys(line, ['kind', 'speaker', 'text'])
          && (line.kind === 'dialogue' || line.kind === 'narration')
          && isNonEmptyString(line.speaker)
          && line.speaker.length <= 80
          && isNonEmptyString(line.text)
          && line.text.length <= 500)))
    && Number.isInteger(value.durationSeconds)
    && (value.durationSeconds as number) >= 4
    && (value.durationSeconds as number) <= 15
    && shotVideoResolutions.has(String(value.resolution))
    && shotVideoAspectRatios.has(String(value.aspectRatio))
    && isNonEmptyString(value.sourceRevisionId)
    && Array.isArray(value.references)
    && value.references.length <= 9
    && value.references.every((reference) => isRecord(reference)
      && hasOnlyKeys(reference, ['assetId', 'role'])
      && isNonEmptyString(reference.assetId)
      && ['first_frame', 'last_frame', 'reference_image'].includes(String(reference.role)))
}

function isShotVideoDurationDecision(value: unknown): value is ShotVideoDurationDecision {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'version',
      'source',
      'frameRate',
      'plannedDurationSeconds',
      'speechDurationSeconds',
      'timelineDurationSeconds',
      'providerDurationSeconds',
      'speechBindings',
      'notices',
    ])
    || value.version !== 1
    || !shotVideoDurationSources.has(String(value.source))
    || value.frameRate !== 24
    || typeof value.plannedDurationSeconds !== 'number'
    || !Number.isFinite(value.plannedDurationSeconds)
    || value.plannedDurationSeconds < 0
    || (value.speechDurationSeconds !== null
      && (typeof value.speechDurationSeconds !== 'number'
        || !Number.isFinite(value.speechDurationSeconds)
        || value.speechDurationSeconds <= 0))
    || typeof value.timelineDurationSeconds !== 'number'
    || !Number.isFinite(value.timelineDurationSeconds)
    || value.timelineDurationSeconds <= 0
    || !Number.isInteger(value.providerDurationSeconds)
    || (value.providerDurationSeconds as number) < 4
    || (value.providerDurationSeconds as number) > 15
    || !Array.isArray(value.speechBindings)
    || !Array.isArray(value.notices)
    || value.notices.some((notice) => !shotVideoDurationNotices.has(String(notice)))) return false
  const bindings = value.speechBindings
  if (!bindings.every((binding) => isRecord(binding)
    && hasOnlyKeys(binding, [
      'dialogueLineId', 'assetId', 'version', 'checksum', 'durationSeconds', 'durationFrames',
    ])
    && isNonEmptyString(binding.dialogueLineId)
    && isNonEmptyString(binding.assetId)
    && Number.isInteger(binding.version)
    && (binding.version as number) >= 1
    && typeof binding.checksum === 'string'
    && /^[a-f0-9]{64}$/.test(binding.checksum)
    && typeof binding.durationSeconds === 'number'
    && Number.isFinite(binding.durationSeconds)
    && binding.durationSeconds > 0
    && Number.isInteger(binding.durationFrames)
    && (binding.durationFrames as number) >= 1
    && binding.durationFrames === Math.max(1, Math.ceil(binding.durationSeconds * 24)))) return false
  if (value.source === 'story_duration') {
    return value.speechDurationSeconds === null
      && bindings.length === 0
      && Math.abs(value.timelineDurationSeconds * 24
        - Math.round(value.timelineDurationSeconds * 24)) < 1e-9
  }
  if (value.speechDurationSeconds === null) {
    return value.source === 'manual_override'
      && bindings.length === 0
      && value.timelineDurationSeconds === value.providerDurationSeconds
  }
  const totalFrames = bindings.reduce((sum, binding) => sum + Number(binding.durationFrames), 0)
  if (totalFrames <= 0 || Math.abs(totalFrames / 24 - value.speechDurationSeconds) >= 1e-9) {
    return false
  }
  if (value.source === 'speech_assets') {
    return value.timelineDurationSeconds === value.speechDurationSeconds
      && value.providerDurationSeconds === Math.max(4, Math.ceil(value.speechDurationSeconds))
  }
  return value.timelineDurationSeconds === value.providerDurationSeconds
    && value.providerDurationSeconds * 24 >= totalFrames
}

function isShotVideoJobInput(value: unknown): value is ShotVideoGenerationJobInput {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'prompt',
      'aspectRatio',
      'resolution',
      'durationSeconds',
      'generateAudio',
      'spec',
      'binding',
      'references',
      'referenceDecision',
      'batch',
      'publicationMode',
      'durationDecision',
    ])
    || !isNonEmptyString(value.prompt)
    || !shotVideoAspectRatios.has(value.aspectRatio as string)
    || !shotVideoResolutions.has(value.resolution as string)
    || !Number.isInteger(value.durationSeconds)
    || (value.durationSeconds as number) < 4
    || (value.durationSeconds as number) > 15
    || typeof value.generateAudio !== 'boolean'
    || !isRecord(value.binding)) {
    return false
  }
  const binding = value.binding
  const validBinding = hasOnlyKeys(binding, [
    'episodeId',
    'shotId',
    'sceneId',
    'databaseShotId',
    'expectedRevisionId',
    'expectedPreviousVideoAssetId',
  ])
    && isNonEmptyString(binding.episodeId)
    && isNonEmptyString(binding.shotId)
    && isNonEmptyString(binding.sceneId)
    && isNonEmptyString(binding.databaseShotId)
    && isNonEmptyString(binding.expectedRevisionId)
    && isNullableString(binding.expectedPreviousVideoAssetId)
  if (!validBinding) return false
  if (value.publicationMode !== undefined
    && (value.publicationMode !== 'evaluation_only'
      || !isShotVideoGenerationSpec(value.spec))) return false
  if (value.spec !== undefined) {
    if (!isShotVideoGenerationSpec(value.spec)
      || value.spec.aspectRatio !== value.aspectRatio
      || value.spec.resolution !== value.resolution
      || value.spec.durationSeconds !== value.durationSeconds
      || value.spec.sourceRevisionId !== binding.expectedRevisionId
      || (value.spec.audioPolicy === 'silent') === value.generateAudio
      || value.spec.references.length !== (Array.isArray(value.references) ? value.references.length : 0)) {
      return false
    }
  }
  if (value.durationDecision !== undefined
    && (!isShotVideoDurationDecision(value.durationDecision)
      || value.durationDecision.providerDurationSeconds !== value.durationSeconds)) return false
  if (value.references !== undefined) {
    if (!Array.isArray(value.references)
      || value.references.length < 1
      || value.references.length > 9
      || !value.references.every((reference) => isShotVideoReferenceBinding(reference)
        && (reference.sourceRevisionId === undefined
          || reference.sourceRevisionId === binding.expectedRevisionId))) return false
    const references = value.references as Array<{ assetId: string; role: string }>
    const firstCount = references.filter((reference) => reference.role === 'first_frame').length
    const lastCount = references.filter((reference) => reference.role === 'last_frame').length
    const referenceCount = references.filter((reference) => reference.role === 'reference_image').length
    const frameMode = firstCount > 0 || lastCount > 0
    if (firstCount > 1 || lastCount > 1 || (lastCount === 1 && firstCount !== 1)
      || (frameMode && referenceCount > 0)
      || (!frameMode && new Set(references.map((reference) => reference.assetId)).size !== references.length)) {
      return false
    }
    if (isShotVideoGenerationSpec(value.spec)
      && value.spec.references.some((reference, index) => (
        reference.assetId !== references[index]?.assetId
        || reference.role !== references[index]?.role
      ))) return false
  }
  const durableReferences = Array.isArray(value.references)
    ? value.references as ShotVideoReferenceBinding[]
    : []
  if (value.referenceDecision !== undefined
    && (!isShotVideoReferenceDecision(value.referenceDecision)
      || value.referenceDecision.recommendation.shotId !== binding.shotId
      || value.referenceDecision.recommendation.sceneId !== binding.sceneId
      || value.referenceDecision.recommendation.sourceRevisionId !== binding.expectedRevisionId
      || value.referenceDecision.selectedReferences.length !== durableReferences.length
      || value.referenceDecision.selectedReferences.some((reference, index) => (
        reference.assetId !== durableReferences[index]?.assetId
        || reference.role !== durableReferences[index]?.role
      )))) return false
  if (value.batch !== undefined) {
    if (!isRecord(value.batch)
      || !hasOnlyKeys(value.batch, ['version', 'requestFingerprint', 'selectionIndex', 'selectionCount'])
      || value.batch.version !== 1
      || typeof value.batch.requestFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.batch.requestFingerprint)
      || !Number.isInteger(value.batch.selectionIndex)
      || !Number.isInteger(value.batch.selectionCount)
      || (value.batch.selectionIndex as number) < 0
      || (value.batch.selectionCount as number) < 1
      || (value.batch.selectionIndex as number) >= (value.batch.selectionCount as number)) return false
  }
  return true
}

function isShotVideoJobOutput(value: unknown): value is ShotVideoGenerationJobOutput {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['asset', 'shotId', 'externalTaskId'])
    || !isNonEmptyString(value.shotId)
    || !isNonEmptyString(value.externalTaskId)
    || !isRecord(value.asset)) {
    return false
  }
  const asset = value.asset
  return hasOnlyKeys(asset, ['id', 'url', 'mimeType', 'width', 'height', 'durationSeconds'])
    && isNonEmptyString(asset.id)
    && asset.url === `/api/v1/assets/${encodeURIComponent(asset.id)}/content`
    && (asset.mimeType === 'video/mp4' || asset.mimeType === 'video/webm')
    && Number.isInteger(asset.width)
    && (asset.width as number) > 0
    && Number.isInteger(asset.height)
    && (asset.height as number) > 0
    && typeof asset.durationSeconds === 'number'
    && Number.isFinite(asset.durationSeconds)
    && asset.durationSeconds > 0
}

function isShotVideoJobError(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.code)
    && isNonEmptyString(value.message)
    && typeof value.retryable === 'boolean'
    && (value.category === undefined || isString(value.category))
}

function isShotVideoGenerationJob(value: unknown): value is ShotVideoGenerationJob {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.episodeId)
    || value.type !== 'shot.video.generate'
    || !generationJobStatuses.has(value.status as string)
    || typeof value.progress !== 'number'
    || !Number.isFinite(value.progress)
    || value.progress < 0
    || value.progress > 100
    || value.resourceType !== 'provider:video'
    || !isNonEmptyString(value.resourceId)
    || !isNonEmptyString(value.providerId)
    || !isNonEmptyString(value.model)
    || !Number.isInteger(value.providerConfigRevision)
    || (value.providerConfigRevision as number) < 1
    || !isNullableString(value.externalTaskId)
    || !isNonEmptyString(value.idempotencyKey)
    || !isNullableString(value.retryOf)
    || !Number.isInteger(value.attempt)
    || (value.attempt as number) < 1
    || !isShotVideoJobInput(value.input)
    || (value.unknownSubmissionResolution !== undefined
      && !isShotVideoUnknownSubmissionResolution(value.unknownSubmissionResolution))
    || (value.output !== null && !isShotVideoJobOutput(value.output))
    || (value.error !== null && !isShotVideoJobError(value.error))
    || !isString(value.createdAt)
    || !isString(value.updatedAt)
    || !isNullableString(value.startedAt)
    || !isNullableString(value.completedAt)) {
    return false
  }
  const input = value.input as unknown as {
    binding: { shotId: string }
  }
  if (value.status === 'succeeded') {
    if (!isShotVideoJobOutput(value.output) || value.error !== null || !isNonEmptyString(value.externalTaskId)) {
      return false
    }
  } else if (value.output !== null) {
    return false
  }
  if (value.status === 'failed' && !isShotVideoJobError(value.error)) return false
  if (isShotVideoJobOutput(value.output)) {
    return value.output.shotId === input.binding.shotId
      && value.output.externalTaskId === value.externalTaskId
  }
  return true
}

function isShotVideoVisualReferenceAnalysis(value: unknown): value is ShotVideoVisualReferenceAnalysis {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'version', 'inputFingerprint', 'projectId', 'episodeId', 'sourceRevisionId', 'plans',
    ])
    || value.version !== 'shot-video-vision-agent-v1'
    || typeof value.inputFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.inputFingerprint)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.episodeId)
    || !isNonEmptyString(value.sourceRevisionId)
    || !Array.isArray(value.plans)
    || value.plans.length < 1
    || value.plans.length > 24) return false
  const shotIds = new Set<string>()
  return value.plans.every((plan) => {
    if (!isRecord(plan)
      || !hasOnlyKeys(plan, [
        'shotId', 'sceneId', 'status', 'strategy', 'confidence', 'rationale',
        'visualEvidence', 'selectedReferences', 'missingCharacterViews',
      ])
      || !isNonEmptyString(plan.shotId)
      || shotIds.has(plan.shotId)
      || !isNonEmptyString(plan.sceneId)
      || (plan.status !== 'recommended' && plan.status !== 'manual_required')
      || !['first_frame', 'multi_reference', 'text_only', 'manual_review'].includes(String(plan.strategy))
      || typeof plan.confidence !== 'number'
      || !Number.isFinite(plan.confidence)
      || plan.confidence < 0
      || plan.confidence > 1
      || !isNonEmptyString(plan.rationale)
      || !Array.isArray(plan.visualEvidence)
      || plan.visualEvidence.length > 8
      || !plan.visualEvidence.every(isNonEmptyString)
      || !Array.isArray(plan.selectedReferences)
      || plan.selectedReferences.length > 9
      || !Array.isArray(plan.missingCharacterViews)
      || plan.missingCharacterViews.length > 16) return false
    shotIds.add(plan.shotId)
    const assetIds = new Set<string>()
    if (!plan.selectedReferences.every((reference) => {
      if (!isRecord(reference)
        || !hasOnlyKeys(reference, ['assetId', 'role', 'purpose'])
        || !isNonEmptyString(reference.assetId)
        || assetIds.has(reference.assetId)
        || (reference.role !== 'first_frame' && reference.role !== 'reference_image')
        || !isNonEmptyString(reference.purpose)) return false
      assetIds.add(reference.assetId)
      return true
    })) return false
    const characterIds = new Set<string>()
    if (!plan.missingCharacterViews.every((missing) => {
      if (!isRecord(missing)
        || !hasOnlyKeys(missing, ['characterId', 'characterName', 'view', 'rationale'])
        || !isNonEmptyString(missing.characterId)
        || characterIds.has(missing.characterId)
        || !isNonEmptyString(missing.characterName)
        || !['front', 'side', 'back', 'uncertain'].includes(String(missing.view))
        || !isNonEmptyString(missing.rationale)) return false
      characterIds.add(missing.characterId)
      return true
    })) return false
    if (plan.status === 'recommended' && plan.missingCharacterViews.length !== 0) return false
    if (plan.status === 'manual_required' && plan.selectedReferences.length !== 0) return false
    if (plan.strategy === 'first_frame') {
      return plan.selectedReferences.length === 1
        && plan.selectedReferences[0]?.role === 'first_frame'
    }
    if (plan.strategy === 'multi_reference') {
      return plan.selectedReferences.length >= 1
        && plan.selectedReferences.every((reference) => isRecord(reference)
          && reference.role === 'reference_image')
    }
    return plan.selectedReferences.length === 0
  })
}

function isShotVideoVisualReferenceAnalysisJobInput(
  value: unknown,
): value is ShotVideoVisualReferenceAnalysisJobInput {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'version', 'episodeId', 'expectedStoryRevisionId', 'inputFingerprint',
      'selectors', 'candidateCount', 'batch',
    ])
    || value.version !== 1
    || !isNonEmptyString(value.episodeId)
    || !isNonEmptyString(value.expectedStoryRevisionId)
    || typeof value.inputFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.inputFingerprint)
    || !Number.isInteger(value.candidateCount)
    || (value.candidateCount as number) < 1
    || (value.candidateCount as number) > 24
    || !Array.isArray(value.selectors)
    || value.selectors.length < 1
    || value.selectors.length > 24
    || (value.batch !== undefined && (
      !isRecord(value.batch)
      || !hasOnlyKeys(value.batch, [
        'version', 'batchId', 'requestFingerprint', 'selectionIndex', 'selectionCount',
      ])
      || value.batch.version !== 1
      || !isNonEmptyString(value.batch.batchId)
      || typeof value.batch.requestFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.batch.requestFingerprint)
      || !Number.isInteger(value.batch.selectionIndex)
      || (value.batch.selectionIndex as number) < 0
      || !Number.isInteger(value.batch.selectionCount)
      || (value.batch.selectionCount as number) < 1
      || (value.batch.selectionCount as number) > 24
      || (value.batch.selectionIndex as number) >= (value.batch.selectionCount as number)
    ))) return false
  const selectorKeys = new Set<string>()
  return value.selectors.every((selector) => {
    if (!isRecord(selector)
      || !hasOnlyKeys(selector, ['shotId', 'sceneId'])
      || !isNonEmptyString(selector.shotId)
      || (selector.sceneId !== undefined && !isNonEmptyString(selector.sceneId))) return false
    const key = `${selector.sceneId ?? ''}\u0000${selector.shotId}`
    if (selectorKeys.has(key)) return false
    selectorKeys.add(key)
    return true
  })
}

const shotVideoVisualAuthorityReasons = new Set([
  'current',
  'job_not_succeeded',
  'source_revision_changed',
  'visual_inputs_changed',
  'provider_revision_changed',
  'invalid_binding',
])

function isShotVideoVisualReferenceAuthority(
  value: unknown,
): value is ShotVideoVisualReferenceAuthority {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'usable', 'reason', 'boundInputFingerprint', 'currentInputFingerprint',
      'expectedStoryRevisionId', 'providerId', 'providerConfigRevision',
    ])
    && typeof value.usable === 'boolean'
    && typeof value.reason === 'string'
    && shotVideoVisualAuthorityReasons.has(value.reason)
    && (value.usable === (value.reason === 'current'))
    && (value.boundInputFingerprint === null
      || (typeof value.boundInputFingerprint === 'string'
        && /^[a-f0-9]{64}$/.test(value.boundInputFingerprint)))
    && (value.currentInputFingerprint === null
      || (typeof value.currentInputFingerprint === 'string'
        && /^[a-f0-9]{64}$/.test(value.currentInputFingerprint)))
    && (value.expectedStoryRevisionId === undefined || isNonEmptyString(value.expectedStoryRevisionId))
    && (value.providerId === undefined || value.providerId === null || isNonEmptyString(value.providerId))
    && (value.providerConfigRevision === undefined || value.providerConfigRevision === null
      || (Number.isInteger(value.providerConfigRevision)
        && (value.providerConfigRevision as number) >= 1))
}

const shotVideoVisualBatchStatuses = new Set([
  'queued', 'running', 'succeeded', 'partial_failed', 'failed', 'incomplete',
])

function isShotVideoVisualReferenceAnalysisBatch(
  value: unknown,
): value is ShotVideoVisualReferenceAnalysisBatch {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'version', 'id', 'projectId', 'episodeId', 'sourceRevisionId', 'providerId',
      'providerConfigRevision', 'model', 'requestFingerprint', 'status', 'progress',
      'counts', 'selections', 'createdAt', 'updatedAt',
    ])
    || value.version !== 1
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.episodeId)
    || !isNonEmptyString(value.sourceRevisionId)
    || !isNonEmptyString(value.providerId)
    || !Number.isInteger(value.providerConfigRevision)
    || (value.providerConfigRevision as number) < 1
    || !isNonEmptyString(value.model)
    || typeof value.requestFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.requestFingerprint)
    || typeof value.status !== 'string'
    || !shotVideoVisualBatchStatuses.has(value.status)
    || typeof value.progress !== 'number'
    || !Number.isFinite(value.progress)
    || value.progress < 0 || value.progress > 100
    || !isRecord(value.counts)
    || !hasOnlyKeys(value.counts, ['total', 'queued', 'running', 'succeeded', 'failed'])
    || !Array.isArray(value.selections)
    || !isString(value.createdAt)
    || !isString(value.updatedAt)) return false
  const counts = value.counts
  if (![counts.total, counts.queued, counts.running, counts.succeeded, counts.failed]
    .every((count) => Number.isInteger(count) && (count as number) >= 0)
    || counts.total !== value.selections.length
    || (counts.queued as number) + (counts.running as number)
      + (counts.succeeded as number) + (counts.failed as number) !== counts.total) return false
  const jobIds = new Set<string>()
  const shotKeys = new Set<string>()
  return value.selections.every((selection, index) => {
    if (!isRecord(selection)
      || !hasOnlyKeys(selection, [
        'selectionIndex', 'shotId', 'sceneId', 'jobId', 'status', 'progress', 'authority',
      ])
      || selection.selectionIndex !== index
      || !isNonEmptyString(selection.shotId)
      || !isNonEmptyString(selection.sceneId)
      || !isNonEmptyString(selection.jobId)
      || jobIds.has(selection.jobId)
      || !generationJobStatuses.has(String(selection.status))
      || typeof selection.progress !== 'number'
      || !Number.isFinite(selection.progress)
      || selection.progress < 0 || selection.progress > 100
      || !isShotVideoVisualReferenceAuthority(selection.authority)) return false
    const shotKey = `${selection.sceneId}\u0000${selection.shotId}`
    if (shotKeys.has(shotKey)) return false
    shotKeys.add(shotKey)
    jobIds.add(selection.jobId)
    return true
  })
}

function isShotVideoVisualReferenceAnalysisJob(
  value: unknown,
): value is ShotVideoVisualReferenceAnalysisJob {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.episodeId)
    || value.type !== 'shot.video.reference.analyze'
    || !generationJobStatuses.has(value.status as string)
    || typeof value.progress !== 'number'
    || !Number.isFinite(value.progress)
    || value.progress < 0
    || value.progress > 100
    || !isNonEmptyString(value.resourceId)
    || !isNonEmptyString(value.providerId)
    || !isNonEmptyString(value.model)
    || !Number.isInteger(value.providerConfigRevision)
    || (value.providerConfigRevision as number) < 1
    || !isNonEmptyString(value.idempotencyKey)
    || !Number.isInteger(value.attempt)
    || (value.attempt as number) < 1
    || !isShotVideoVisualReferenceAnalysisJobInput(value.input)
    || (value.output !== null
      && (!isRecord(value.output)
        || !hasOnlyKeys(value.output, ['analysis'])
        || !isShotVideoVisualReferenceAnalysis(value.output.analysis)))
    || (value.error !== null && !isShotVideoJobError(value.error))
    || !isString(value.createdAt)
    || !isString(value.updatedAt)
    || !isNullableString(value.startedAt)
    || !isNullableString(value.completedAt)) return false
  if (value.resourceId !== value.episodeId
    || value.input.episodeId !== value.episodeId) return false
  if (value.status === 'succeeded') {
    if (!isRecord(value.output)
      || !isShotVideoVisualReferenceAnalysis(value.output.analysis)
      || value.error !== null
      || value.output.analysis.projectId !== value.projectId
      || value.output.analysis.episodeId !== value.episodeId
      || value.output.analysis.sourceRevisionId !== value.input.expectedStoryRevisionId
      || value.output.analysis.inputFingerprint !== value.input.inputFingerprint
      || value.output.analysis.plans.length !== value.input.selectors.length) return false
  }
  return true
}

function isShotVideoVisualReferenceAnalysisBinding(
  value: unknown,
): value is ShotVideoVisualReferenceAnalysisBinding {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['shotId', 'sceneId', 'job', 'authority'])
    || !isNonEmptyString(value.shotId)
    || !isNonEmptyString(value.sceneId)
    || !isShotVideoVisualReferenceAnalysisJob(value.job)
    || !isShotVideoVisualReferenceAuthority(value.authority)) return false
  const selector = value.job.input.selectors[0]
  return value.job.input.selectors.length === 1
    && selector?.shotId === value.shotId
    && selector.sceneId === value.sceneId
    && value.authority.boundInputFingerprint === value.job.input.inputFingerprint
}

function isShotVideoVisualReferenceAnalysisBatchResponse(
  value: unknown,
): value is ShotVideoVisualReferenceAnalysisBatchResponse {
  if (!isRecord(value) || !hasOnlyKeys(value, ['batch', 'jobs'])) return false
  const batch = value.batch
  const jobs = value.jobs
  if (!isShotVideoVisualReferenceAnalysisBatch(batch)
    || !Array.isArray(jobs)
    || jobs.length !== batch.selections.length
    || !jobs.every(isShotVideoVisualReferenceAnalysisJob)) return false
  return jobs.every((job, index) => {
    const selection = batch.selections[index]
    const binding = job.input.batch
    const selector = job.input.selectors[0]
    return selection?.jobId === job.id
      && selection.status === job.status
      && selection.progress === job.progress
      && selector?.shotId === selection.shotId
      && selector.sceneId === selection.sceneId
      && binding?.version === 1
      && binding.batchId === batch.id
      && binding.requestFingerprint === batch.requestFingerprint
      && binding.selectionIndex === index
      && binding.selectionCount === jobs.length
      && job.projectId === batch.projectId
      && job.episodeId === batch.episodeId
      && job.providerId === batch.providerId
      && job.providerConfigRevision === batch.providerConfigRevision
      && job.model === batch.model
      && job.input.expectedStoryRevisionId === batch.sourceRevisionId
  })
}

function isShotVideoUnknownSubmissionResolution(
  value: unknown,
): value is ShotVideoUnknownSubmissionResolution {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
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
    || value.version !== 1
    || !isNonEmptyString(value.auditRevisionId)
    || !isNonEmptyString(value.jobId)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.episodeId)
    || !isNonEmptyString(value.shotId)
    || !isNonEmptyString(value.expectedSourceRevisionId)
    || value.resolution !== 'confirmed-not-created'
    || value.confirmedProviderConsoleChecked !== true
    || !isNonEmptyString(value.note)
    || !isNonEmptyString(value.resolvedAt)
    || !Number.isFinite(Date.parse(value.resolvedAt))
    || !isRecord(value.provider)
    || !hasOnlyKeys(value.provider, ['id', 'configRevision', 'model', 'baseUrl'])
    || !isNonEmptyString(value.provider.id)
    || !Number.isInteger(value.provider.configRevision)
    || (value.provider.configRevision as number) < 1
    || !isNonEmptyString(value.provider.model)
    || (value.provider.baseUrl !== null && typeof value.provider.baseUrl !== 'string')) {
    return false
  }
  return true
}

function invalidShotVideoResponse(payload: unknown): never {
  throw new ApiError('服务返回的视频生成任务绑定不一致。', {
    code: 'INVALID_RESPONSE',
    details: payload,
  })
}

function invalidShotMediaReviewResponse(payload: unknown): never {
  throw new ApiError('服务返回的镜头审片数据格式不正确。', {
    code: 'INVALID_RESPONSE',
    details: payload,
  })
}

function isOpaqueEtag(value: unknown): value is string {
  return typeof value === 'string' && /^(?:W\/)?"[^"\s]+"$/.test(value)
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) > 0)
}

function isNullablePositiveNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value))
}

function isShotMediaCandidate(
  value: unknown,
  scope: {
    projectId: string
    episodeId: string
    sourceRevisionId: string
    mediaType: ShotMediaType
  },
): value is ShotMediaCandidate {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'id',
      'projectId',
      'episodeId',
      'kind',
      'version',
      'status',
      'mimeType',
      'width',
      'height',
      'durationSeconds',
      'checksum',
      'sourceRevisionId',
      'parentAssetId',
      'generationJobId',
      'url',
      'createdAt',
      'selected',
      'eligible',
      'eligibilityError',
      'lastDecision',
    ])
    || !isNonEmptyString(value.id)
    || value.projectId !== scope.projectId
    || value.episodeId !== scope.episodeId
    || value.sourceRevisionId !== scope.sourceRevisionId
    || value.kind !== (scope.mediaType === 'storyboard' ? 'storyboard' : 'shot.video')
    || !Number.isInteger(value.version)
    || (value.version as number) < 1
    || !isNonEmptyString(value.status)
    || !isNonEmptyString(value.mimeType)
    || !isNullablePositiveInteger(value.width)
    || !isNullablePositiveInteger(value.height)
    || !isNullablePositiveNumber(value.durationSeconds)
    || typeof value.checksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.checksum)
    || !isNullableString(value.parentAssetId)
    || !isNonEmptyString(value.generationJobId)
    || value.url !== `/api/v1/assets/${encodeURIComponent(value.id)}/content`
    || !isIsoTimestamp(value.createdAt)
    || typeof value.selected !== 'boolean'
    || typeof value.eligible !== 'boolean'
    || !isNullableString(value.eligibilityError)
    || (value.lastDecision !== null
      && !shotMediaReviewDecisions.has(String(value.lastDecision) as ShotMediaReviewDecision))) {
    return false
  }
  if (scope.mediaType === 'storyboard') {
    if (!['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(value.mimeType)) return false
  } else if (!['video/mp4', 'video/webm'].includes(value.mimeType)) return false
  return value.eligible ? value.eligibilityError === null : isNonEmptyString(value.eligibilityError)
}

function isShotMediaReviewRecord(
  value: unknown,
  scope: {
    projectId: string
    episodeId: string
    shotId: string
    sceneId?: string
    sourceRevisionId?: string
    mediaType: ShotMediaType
  },
): value is ShotMediaReviewRecord {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'id',
      'projectId',
      'episodeId',
      'databaseShotId',
      'shotId',
      'sceneId',
      'sourceRevisionId',
      'mediaType',
      'decision',
      'assetId',
      'previousAssetId',
      'selectedAssetId',
      'clearedVideoAssetId',
      'note',
      'timelineReconcileRequired',
      'stale',
      'createdAt',
    ])
    || !isNonEmptyString(value.id)
    || value.projectId !== scope.projectId
    || value.episodeId !== scope.episodeId
    || !isNonEmptyString(value.databaseShotId)
    || value.shotId !== scope.shotId
    || !isNonEmptyString(value.sceneId)
    || (scope.sceneId !== undefined && value.sceneId !== scope.sceneId)
    || !isNonEmptyString(value.sourceRevisionId)
    || (scope.sourceRevisionId !== undefined && value.sourceRevisionId !== scope.sourceRevisionId)
    || value.mediaType !== scope.mediaType
    || !shotMediaReviewDecisions.has(String(value.decision) as ShotMediaReviewDecision)
    || !isNonEmptyString(value.assetId)
    || !isNullableString(value.previousAssetId)
    || !isNullableString(value.selectedAssetId)
    || !isNullableString(value.clearedVideoAssetId)
    || !isNullableString(value.note)
    || (typeof value.note === 'string' && value.note.length > 1000)
    || typeof value.timelineReconcileRequired !== 'boolean'
    || !isRecord(value.stale)
    || !hasOnlyKeys(value.stale, [
      'generationJobs',
      'shotVideoJobs',
      'exports',
      'qualityReports',
      'pipelineRuns',
    ])
    || !isNonNegativeInteger(value.stale.generationJobs)
    || !isNonNegativeInteger(value.stale.shotVideoJobs)
    || !isNonNegativeInteger(value.stale.exports)
    || !isNonNegativeInteger(value.stale.qualityReports)
    || !isNonNegativeInteger(value.stale.pipelineRuns)
    || !isIsoTimestamp(value.createdAt)) return false

  if ((value.decision === 'adopt' || value.decision === 'restore')
    && value.selectedAssetId !== value.assetId) return false
  if (value.decision === 'reject' && value.selectedAssetId !== value.previousAssetId) return false
  return true
}

function parseShotMediaReviewSnapshot(
  payload: unknown,
  response: Response,
  shotId: string,
  input: ListShotMediaReviewInput,
): ShotMediaReviewSnapshot {
  if (!isRecord(payload)
    || !hasOnlyKeys(payload, ['mediaReview'])
    || !isRecord(payload.mediaReview)) return invalidShotMediaReviewResponse(payload)
  const review = payload.mediaReview
  if (!hasOnlyKeys(review, [
    'projectId',
    'episodeId',
    'databaseShotId',
    'shotId',
    'sceneId',
    'sourceRevisionId',
    'mediaType',
    'episodeEtag',
    'currentSelection',
    'currentSelectionAssetId',
    'candidates',
    'history',
    'pagination',
  ])
    || review.projectId !== input.projectId
    || review.episodeId !== input.episodeId
    || !isNonEmptyString(review.databaseShotId)
    || review.shotId !== shotId
    || !isNonEmptyString(review.sceneId)
    || (input.sceneId !== undefined && review.sceneId !== input.sceneId)
    || !isNonEmptyString(review.sourceRevisionId)
    || review.mediaType !== input.mediaType
    || !isOpaqueEtag(review.episodeEtag)
    || !isNullableString(review.currentSelectionAssetId)
    || !Array.isArray(review.candidates)
    || !Array.isArray(review.history)
    || !isRecord(review.pagination)
    || !hasOnlyKeys(review.pagination, ['limit', 'offset'])
    || !Number.isInteger(review.pagination.limit)
    || (review.pagination.limit as number) < 1
    || (review.pagination.limit as number) > 200
    || !isNonNegativeInteger(review.pagination.offset)
    || (review.pagination.offset as number) > 100_000
    || (input.limit !== undefined && review.pagination.limit !== input.limit)
    || (input.offset !== undefined && review.pagination.offset !== input.offset)) {
    return invalidShotMediaReviewResponse(payload)
  }
  const scope = {
    projectId: input.projectId,
    episodeId: input.episodeId,
    shotId,
    sceneId: review.sceneId as string,
    sourceRevisionId: review.sourceRevisionId as string,
    mediaType: input.mediaType,
  }
  if (!review.candidates.every((candidate) => isShotMediaCandidate(candidate, scope))
    || !review.history.every((record) => isShotMediaReviewRecord(record, scope))
    || review.candidates.length > (review.pagination.limit as number)
    || review.history.length > (review.pagination.limit as number)
    || new Set(review.candidates.map((candidate) => candidate.id)).size !== review.candidates.length
    || new Set(review.history.map((record) => record.id)).size !== review.history.length) {
    return invalidShotMediaReviewResponse(payload)
  }
  if (review.currentSelection === null) {
    if (review.currentSelectionAssetId !== null) return invalidShotMediaReviewResponse(payload)
  } else if (!isShotMediaCandidate(review.currentSelection, scope)
    || review.currentSelectionAssetId !== review.currentSelection.id
    || review.currentSelection.selected !== true) {
    return invalidShotMediaReviewResponse(payload)
  }
  if (review.candidates.some((candidate) => (
    candidate.selected !== (candidate.id === review.currentSelectionAssetId)
  ))) return invalidShotMediaReviewResponse(payload)

  const etag = requiredOpaqueEtag(response, payload, '服务返回的审片分集 ETag 无效。')
  if (etag !== review.episodeEtag) return invalidShotMediaReviewResponse(payload)
  return review as unknown as ShotMediaReviewSnapshot
}

function parseShotMediaDecisionResult(
  payload: unknown,
  response: Response,
  shotId: string,
  input: DecideShotMediaInput,
): ShotMediaDecisionResult {
  if (!isRecord(payload)
    || !hasOnlyKeys(payload, ['mediaReview'])
    || !isRecord(payload.mediaReview)) return invalidShotMediaReviewResponse(payload)
  const result = payload.mediaReview
  if (!hasOnlyKeys(result, [
    'review',
    'episodeEtag',
    'currentSelectionAssetId',
    'clearedVideoAssetId',
    'timelineReconcileRequired',
    'idempotent',
    'headAdvanced',
  ])
    || !isOpaqueEtag(result.episodeEtag)
    || !isNullableString(result.currentSelectionAssetId)
    || !isNullableString(result.clearedVideoAssetId)
    || typeof result.timelineReconcileRequired !== 'boolean'
    || typeof result.idempotent !== 'boolean'
    || typeof result.headAdvanced !== 'boolean'
    || !isShotMediaReviewRecord(result.review, {
      projectId: input.projectId,
      episodeId: input.episodeId,
      shotId,
      sceneId: input.sceneId,
      mediaType: input.mediaType,
    })
    || result.review.decision !== input.decision
    || result.review.assetId !== input.assetId
    || result.clearedVideoAssetId !== result.review.clearedVideoAssetId
    || result.timelineReconcileRequired !== result.review.timelineReconcileRequired
    || (!result.headAdvanced && result.currentSelectionAssetId !== result.review.selectedAssetId)) {
    return invalidShotMediaReviewResponse(payload)
  }
  const etag = requiredOpaqueEtag(response, payload, '服务返回的审片决策 ETag 无效。')
  if (etag !== result.episodeEtag) return invalidShotMediaReviewResponse(payload)
  return result as unknown as ShotMediaDecisionResult
}

function requestedShotVideoAudioPolicy(
  input: Pick<ShotVideoBatchPreflightInput, 'audioPolicy' | 'generateAudio'>,
): 'sfx_only' | 'silent' | 'provider_audio' {
  return input.audioPolicy ?? (input.generateAudio === true ? 'provider_audio' : 'silent')
}

function requestedShotVideoGenerateAudio(
  input: Pick<ShotVideoBatchPreflightInput, 'audioPolicy' | 'generateAudio'>,
): boolean {
  return requestedShotVideoAudioPolicy(input) !== 'silent'
}

function requestedShotVideoPublicationMode(
  input: Pick<ShotVideoBatchPreflightInput, 'promptCompilerVersion' | 'publicationMode'>,
): 'replace_current' | 'evaluation_only' {
  return input.publicationMode
    ?? (input.promptCompilerVersion === 'seedance-verbose-baseline-v1'
      ? 'evaluation_only'
      : 'replace_current')
}

function assertShotVideoBatchReferenceAnalysisInput(
  input: ShotVideoBatchPreflightInput,
): void {
  const hasPerSelectionAnalysis = input.selections.some(
    (selection) => selection.referenceAnalysisJobId !== undefined,
  )
  if (input.referenceAnalysisJobId !== undefined && hasPerSelectionAnalysis) {
    throw new ApiError('不能同时提交批次级与分镜级 referenceAnalysisJobId。', {
      status: 400,
      code: 'INVALID_VIDEO_BATCH_REQUEST',
    })
  }
  if (input.selections.some((selection) => selection.referenceAnalysisJobId !== undefined
    && (selection.references !== undefined
      || selection.characterReferenceSelections !== undefined))) {
    throw new ApiError('分镜级 referenceAnalysisJobId 仅适用于自动参考图选择。', {
      status: 400,
      code: 'INVALID_VIDEO_BATCH_REQUEST',
    })
  }
}

const shotVideoReferenceRoles = new Set(['first_frame', 'last_frame', 'reference_image'])
const shotVideoReferenceModes = new Set([
  'text-to-video',
  'first-frame',
  'first-last-frame',
  'multi-reference',
])
const shotVideoBatchConfirmationPattern = /^svpf1_[1-9][0-9]{9,12}_[a-f0-9]{64}$/

function isShotVideoReferenceSelection(value: unknown): value is ShotVideoReferenceSelection {
  return isRecord(value)
    && hasOnlyKeys(value, ['assetId', 'role'])
    && isNonEmptyString(value.assetId)
    && shotVideoReferenceRoles.has(value.role as string)
}

function isShotVideoReferenceBinding(value: unknown): value is ShotVideoReferenceBinding {
  return isRecord(value)
    && hasOnlyKeys(value, ['assetId', 'role', 'version', 'checksum', 'sourceRevisionId'])
    && isNonEmptyString(value.assetId)
    && shotVideoReferenceRoles.has(value.role as string)
    && Number.isInteger(value.version)
    && (value.version as number) >= 1
    && typeof value.checksum === 'string'
    && /^[a-f0-9]{64}$/.test(value.checksum)
    && (value.sourceRevisionId === undefined || isNonEmptyString(value.sourceRevisionId))
}

function isShotVideoReferenceRecommendation(value: unknown): value is ShotVideoReferenceRecommendation {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'version', 'policy', 'status', 'shotId', 'sceneId', 'sourceRevisionId',
      'confidence', 'rationale', 'characters', 'references',
    ])
    || value.version !== 1
    || value.policy !== 'deterministic-character-view-v1'
    || !['recommended', 'manual_required', 'not_applicable'].includes(String(value.status))
    || !isNonEmptyString(value.shotId)
    || !isNonEmptyString(value.sceneId)
    || !isNonEmptyString(value.sourceRevisionId)
    || (value.confidence !== null
      && (typeof value.confidence !== 'number'
        || !Number.isFinite(value.confidence)
        || value.confidence < 0
        || value.confidence > 1))
    || !isNonEmptyString(value.rationale)
    || !Array.isArray(value.characters)
    || value.characters.length > 64
    || !Array.isArray(value.references)
    || value.references.length > 9
    || !value.references.every((reference) => isRecord(reference)
      && hasOnlyKeys(reference, ['assetId', 'role'])
      && isNonEmptyString(reference.assetId)
      && reference.role === 'reference_image')) return false
  return value.characters.every((character) => {
    if (!isRecord(character)
      || !hasOnlyKeys(character, [
        'characterId', 'characterName', 'status', 'view', 'confidence', 'rationale',
        'assetId', 'assetVersion', 'assetChecksum', 'assetSourceRevisionId',
        'slotVersion', 'slotAuditRevisionId',
      ])
      || !isNonEmptyString(character.characterId)
      || !isNonEmptyString(character.characterName)
      || !['recommended', 'manual_required'].includes(String(character.status))
      || (character.view !== null && !['front', 'side', 'back'].includes(String(character.view)))
      || (character.confidence !== null
        && (typeof character.confidence !== 'number'
          || !Number.isFinite(character.confidence)
          || character.confidence < 0
          || character.confidence > 1))
      || !isNonEmptyString(character.rationale)) return false
    if (character.status === 'recommended') {
      return isNonEmptyString(character.assetId)
        && Number.isInteger(character.assetVersion)
        && (character.assetVersion as number) >= 1
        && typeof character.assetChecksum === 'string'
        && /^[a-f0-9]{64}$/.test(character.assetChecksum)
        && character.assetSourceRevisionId === value.sourceRevisionId
        && Number.isInteger(character.slotVersion)
        && (character.slotVersion as number) >= 1
        && isNonEmptyString(character.slotAuditRevisionId)
        && character.view !== null
        && character.confidence !== null
    }
    return character.assetId === null
      && character.assetVersion === null
      && character.assetChecksum === null
      && character.assetSourceRevisionId === null
      && character.slotVersion === null
      && character.slotAuditRevisionId === null
  })
}

function isShotVideoReferenceDecision(value: unknown): value is ShotVideoReferenceDecision {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'version', 'source', 'resolution', 'recommendation', 'storyboardAnchorAssetId', 'selectedReferences',
      'automaticPolicy', 'visionAnalysisJobId', 'manualCharacterSlotPins',
    ])
    || value.version !== 1
    || (value.source !== 'agentic_auto' && value.source !== 'manual_override')
    || (value.automaticPolicy !== undefined
      && value.automaticPolicy !== 'deterministic_safety'
      && value.automaticPolicy !== 'persisted_vision')
    || (value.visionAnalysisJobId !== undefined && !isNonEmptyString(value.visionAnalysisJobId))
    || (value.resolution !== undefined
      && !['character_views', 'storyboard_anchor', 'not_applicable', 'manual_override'].includes(String(value.resolution)))
    || !isNullableString(value.storyboardAnchorAssetId)
    || !Array.isArray(value.selectedReferences)
    || value.selectedReferences.length > 9
    || !value.selectedReferences.every(isShotVideoReferenceSelection)
    || !isShotVideoReferenceRecommendation(value.recommendation)) return false
  if (value.source === 'manual_override'
    && (value.automaticPolicy !== undefined || value.visionAnalysisJobId !== undefined)) return false
  if (value.automaticPolicy === 'persisted_vision' && value.visionAnalysisJobId === undefined) return false
  if (value.visionAnalysisJobId !== undefined && value.automaticPolicy !== 'persisted_vision') return false
  const recommendation = value.recommendation as ShotVideoReferenceRecommendation
  if (value.manualCharacterSlotPins !== undefined
    && (value.source !== 'manual_override'
      || !Array.isArray(value.manualCharacterSlotPins)
      || value.manualCharacterSlotPins.length < 1
      || value.manualCharacterSlotPins.length > 9
      || !value.manualCharacterSlotPins.every((pin) => isRecord(pin)
        && hasOnlyKeys(pin, [
          'characterId', 'characterName', 'view', 'assetId', 'assetVersion',
          'assetChecksum', 'assetSourceRevisionId', 'slotVersion', 'slotAuditRevisionId',
        ])
        && isNonEmptyString(pin.characterId)
        && isNonEmptyString(pin.characterName)
        && ['front', 'side', 'back'].includes(String(pin.view))
        && isNonEmptyString(pin.assetId)
        && Number.isInteger(pin.assetVersion) && (pin.assetVersion as number) >= 1
        && typeof pin.assetChecksum === 'string' && /^[a-f0-9]{64}$/.test(pin.assetChecksum)
        && pin.assetSourceRevisionId === recommendation.sourceRevisionId
        && Number.isInteger(pin.slotVersion) && (pin.slotVersion as number) >= 1
        && isNonEmptyString(pin.slotAuditRevisionId)))) return false
  if (value.resolution === 'manual_override') return value.source === 'manual_override'
  if (value.resolution !== undefined && value.source !== 'agentic_auto') return false
  if (value.resolution === 'storyboard_anchor') {
    return isNonEmptyString(value.storyboardAnchorAssetId)
      && value.selectedReferences.length === 1
      && value.selectedReferences[0]?.assetId === value.storyboardAnchorAssetId
      && value.selectedReferences[0]?.role === 'first_frame'
  }
  return true
}

function isShotVideoBatchPreflight(value: unknown): value is ShotVideoBatchPreflight {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'version',
      'projectId',
      'episodeId',
      'sourceRevisionId',
      'resolution',
      'publicationMode',
      'audioPolicy',
      'generateAudio',
      'provider',
      'billableTaskCount',
      'totalRequestedSeconds',
      'priceEstimate',
      'priceEstimateReason',
      'targets',
      'expiresAt',
      'confirmationToken',
    ])
    || value.version !== 1
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.episodeId)
    || !isNonEmptyString(value.sourceRevisionId)
    || !shotVideoResolutions.has(value.resolution as string)
    || (value.publicationMode !== 'replace_current' && value.publicationMode !== 'evaluation_only')
    || !shotVideoAudioPolicies.has(String(value.audioPolicy))
    || typeof value.generateAudio !== 'boolean'
    || (value.audioPolicy === 'silent') === value.generateAudio
    || !isRecord(value.provider)
    || !hasOnlyKeys(value.provider, ['providerId', 'configRevision', 'model'])
    || !isNonEmptyString(value.provider.providerId)
    || !Number.isInteger(value.provider.configRevision)
    || (value.provider.configRevision as number) < 1
    || !isNonEmptyString(value.provider.model)
    || !Number.isInteger(value.billableTaskCount)
    || (value.billableTaskCount as number) < 1
    || !Number.isInteger(value.totalRequestedSeconds)
    || (value.totalRequestedSeconds as number) < 4
    || value.priceEstimate !== null
    || value.priceEstimateReason !== 'PROVIDER_PRICING_UNAVAILABLE'
    || !Array.isArray(value.targets)
    || value.targets.length !== value.billableTaskCount
    || value.targets.length > 24
    || !isNonEmptyString(value.expiresAt)
    || !Number.isFinite(Date.parse(value.expiresAt))
    || !shotVideoBatchConfirmationPattern.test(String(value.confirmationToken))) return false
  const tokenExpiry = /^svpf1_([1-9][0-9]{9,12})_/.exec(String(value.confirmationToken))
  if (!tokenExpiry || Math.floor(Date.parse(value.expiresAt as string) / 1_000) !== Number(tokenExpiry[1])) return false
  let totalSeconds = 0
  const targetKeys = new Set<string>()
  for (const target of value.targets) {
    if (!isRecord(target)
      || !hasOnlyKeys(target, [
        'shotId',
        'sceneId',
        'durationSeconds',
        'timelineDurationSeconds',
        'durationDecision',
        'referenceMode',
        'references',
        'referenceDecision',
        'promptPreview',
        'promptCompilerVersion',
        'promptCompilerNotices',
      ])
      || !isNonEmptyString(target.shotId)
      || !isNonEmptyString(target.sceneId)
      || !Number.isInteger(target.durationSeconds)
      || (target.durationSeconds as number) < 4
      || (target.durationSeconds as number) > 15
      || typeof target.timelineDurationSeconds !== 'number'
      || !Number.isFinite(target.timelineDurationSeconds)
      || target.timelineDurationSeconds <= 0
      || !isShotVideoDurationDecision(target.durationDecision)
      || target.durationDecision.providerDurationSeconds !== target.durationSeconds
      || target.durationDecision.timelineDurationSeconds !== target.timelineDurationSeconds
      || !shotVideoReferenceModes.has(target.referenceMode as string)
      || !Array.isArray(target.references)
      || target.references.length > 9
      || !target.references.every(isShotVideoReferenceBinding)
      || !isShotVideoReferenceDecision(target.referenceDecision)
      || !isNonEmptyString(target.promptPreview)
      || !shotVideoPromptCompilerVersions.has(String(target.promptCompilerVersion))
      || !Array.isArray(target.promptCompilerNotices)
      || target.promptCompilerNotices.some((notice) => typeof notice !== 'string')) return false
    const key = `${target.sceneId}\u0000${target.shotId}`
    if (targetKeys.has(key)) return false
    targetKeys.add(key)
    const pinnedReferences = target.references as ShotVideoReferenceBinding[]
    const roles = pinnedReferences.map((reference) => reference.role)
    const firstCount = roles.filter((role) => role === 'first_frame').length
    const lastCount = roles.filter((role) => role === 'last_frame').length
    const referenceCount = roles.filter((role) => role === 'reference_image').length
    const frameMode = firstCount > 0 || lastCount > 0
    if (firstCount > 1 || lastCount > 1 || (lastCount === 1 && firstCount !== 1)
      || (frameMode && referenceCount > 0)
      || (!frameMode
        && new Set(pinnedReferences.map((reference) => reference.assetId)).size !== pinnedReferences.length)) {
      return false
    }
    const derivedMode = roles.length === 0
      ? 'text-to-video'
      : roles.every((role) => role === 'reference_image')
        ? 'multi-reference'
        : roles.includes('last_frame')
          ? 'first-last-frame'
          : 'first-frame'
    if (target.referenceMode !== derivedMode
      || pinnedReferences.some((reference) => reference.sourceRevisionId !== value.sourceRevisionId)
      || target.referenceDecision.recommendation.shotId !== target.shotId
      || target.referenceDecision.recommendation.sceneId !== target.sceneId
      || target.referenceDecision.recommendation.sourceRevisionId !== value.sourceRevisionId
      || target.referenceDecision.selectedReferences.length !== pinnedReferences.length
      || target.referenceDecision.selectedReferences.some((reference, index) => (
        reference.assetId !== pinnedReferences[index]?.assetId
        || reference.role !== pinnedReferences[index]?.role
      ))) return false
    totalSeconds += target.durationSeconds as number
  }
  return totalSeconds === value.totalRequestedSeconds
}

function shotVideoIdempotencyKey(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ApiError('视频生成的 Idempotency-Key 格式无效。', {
      status: 400,
      code: 'INVALID_IDEMPOTENCY_KEY',
    })
  }
  return normalized
}

function isDialogueSpeechJobInput(value: unknown): boolean {
  return isRecord(value)
    && isString(value.episodeId)
    && isString(value.lineId)
    && isString(value.databaseLineId)
    && isNullableString(value.expectedRevisionId)
    && isString(value.voiceId)
    && (value.inheritedVoiceProfileRevisionId === undefined
      || isString(value.inheritedVoiceProfileRevisionId))
    && typeof value.speed === 'number'
    && typeof value.volume === 'number'
    && typeof value.pitch === 'number'
    && (value.emotion === undefined || dialogueSpeechEmotions.has(value.emotion as string))
    && dialogueSpeechFormats.has(value.format as string)
    && dialogueSpeechSampleRates.has(value.sampleRate as number)
    && dialogueSpeechBitrates.has(value.bitrate as number)
    && (value.channels === 1 || value.channels === 2)
}

function isDialogueSpeechJobOutput(value: unknown): boolean {
  return isRecord(value)
    && isString(value.dialogueLineId)
    && isMediaAsset(value.asset)
    && value.asset.kind === 'speech'
    && isRecord(value.provider)
    && isString(value.provider.id)
    && isString(value.provider.model)
    && isNonNegativeInteger(value.provider.configRevision)
}

function isDialogueSpeechGenerationJob(value: unknown): value is DialogueSpeechGenerationJob {
  if (
    !isRecord(value)
    || !isString(value.id)
    || !isString(value.projectId)
    || !isNullableString(value.episodeId)
    || value.type !== 'dialogue.speech.generate'
    || !generationJobStatuses.has(value.status as string)
    || typeof value.progress !== 'number'
    || !isNonNegativeInteger(value.attempt)
    || !isDialogueSpeechJobInput(value.input)
    || !isString(value.createdAt)
    || !isString(value.updatedAt)
  ) {
    return false
  }
  if (value.output !== undefined && value.output !== null && !isDialogueSpeechJobOutput(value.output)) {
    return false
  }
  return value.status !== 'succeeded' || isDialogueSpeechJobOutput(value.output)
}

const linePerformanceEmotions = new Set([
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'calm',
])

const linePerformanceOpeningSoundTags = new Set([
  '(laughs)',
  '(chuckle)',
  '(coughs)',
  '(clear-throat)',
  '(groans)',
  '(breath)',
  '(pant)',
  '(inhale)',
  '(exhale)',
  '(gasps)',
  '(sniffs)',
  '(sighs)',
  '(snorts)',
  '(burps)',
  '(lip-smacking)',
  '(humming)',
  '(hissing)',
  '(emm)',
  '(sneezes)',
])

function isDialoguePerformanceRecommendation(
  value: unknown,
  expectedLineId?: string,
): value is DialoguePerformanceRecommendation {
  if (!isRecord(value)
    || !hasExactlyKeys(value, [
      'version',
      'lineId',
      'emotion',
      'speed',
      'pitch',
      'pausePlan',
      'rationale',
    ], ['openingSoundTag'])
    || value.version !== 'line-performance-agent-v1'
    || !isNonEmptyString(value.lineId)
    || (expectedLineId !== undefined && value.lineId !== expectedLineId)
    || !linePerformanceEmotions.has(value.emotion as string)
    || typeof value.speed !== 'number'
    || !Number.isFinite(value.speed)
    || value.speed < 0.5
    || value.speed > 2
    || typeof value.pitch !== 'number'
    || !Number.isInteger(value.pitch)
    || value.pitch < -12
    || value.pitch > 12
    || (value.openingSoundTag !== undefined
      && !linePerformanceOpeningSoundTags.has(value.openingSoundTag as string))
    || !Array.isArray(value.pausePlan)
    || value.pausePlan.length > 6
    || !value.pausePlan.every((pause) => isRecord(pause)
      && hasOnlyKeys(pause, ['afterCharacter', 'durationSeconds'])
      && isNonNegativeInteger(pause.afterCharacter)
      && (pause.afterCharacter as number) >= 1
      && typeof pause.durationSeconds === 'number'
      && Number.isFinite(pause.durationSeconds)
      && pause.durationSeconds >= 0.01
      && pause.durationSeconds <= 2
      && Math.abs(pause.durationSeconds * 100 - Math.round(pause.durationSeconds * 100)) < 1e-8)
    || !isNonEmptyString(value.rationale)) return false

  const pausePositions = value.pausePlan.map((pause) => (
    (pause as { afterCharacter: number }).afterCharacter
  ))
  return pausePositions.every((position, index) => (
    index === 0 || position > (pausePositions[index - 1] ?? 0)
  ))
}

function isDialoguePerformanceProfile(
  value: unknown,
  expectedLineId: string,
  expectedProjectId: string,
  expectedEpisodeId: string,
): value is DialoguePerformanceProfile {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'version',
      'lineId',
      'emotion',
      'speed',
      'pitch',
      'pausePlan',
      'rationale',
      'projectId',
      'episodeId',
      'databaseLineId',
      'revisionId',
      'recommendationJobId',
      'sourceRevisionId',
      'voiceProfileRevisionId',
      'updatedAt',
    ], ['openingSoundTag'])
    && isDialoguePerformanceRecommendation({
      version: value.version,
      lineId: value.lineId,
      emotion: value.emotion,
      speed: value.speed,
      pitch: value.pitch,
      pausePlan: value.pausePlan,
      rationale: value.rationale,
      ...(value.openingSoundTag === undefined
        ? {}
        : { openingSoundTag: value.openingSoundTag }),
    }, expectedLineId)
    && value.projectId === expectedProjectId
    && value.episodeId === expectedEpisodeId
    && isNonEmptyString(value.databaseLineId)
    && isNonEmptyString(value.revisionId)
    && isNonEmptyString(value.recommendationJobId)
    && isNonEmptyString(value.sourceRevisionId)
    && (value.voiceProfileRevisionId === null || isNonEmptyString(value.voiceProfileRevisionId))
    && isString(value.updatedAt)
    && Number.isFinite(Date.parse(value.updatedAt))
}

function isDialoguePerformanceStaleResult(value: unknown): boolean {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'speechAssets',
      'narrationLines',
      'exports',
      'exportAssets',
      'qualityReports',
      'pipelineRuns',
    ])
    && Object.values(value).every(isNonNegativeInteger)
}

function parseDialoguePerformanceProfileResponse(
  value: unknown,
  expectedLineId: string,
  expectedProjectId: string,
  expectedEpisodeId: string,
  etag: string,
): DialoguePerformanceProfileResponse {
  if (!isRecord(value)
    || !hasExactlyKeys(value, ['profile'], ['revisionId', 'stale'])
    || !(value.profile === null
      || isDialoguePerformanceProfile(
        value.profile,
        expectedLineId,
        expectedProjectId,
        expectedEpisodeId,
      ))
    || (value.revisionId !== undefined && !isNonEmptyString(value.revisionId))
    || (value.stale !== undefined && !isDialoguePerformanceStaleResult(value.stale))) {
    throw new ApiError('服务返回的逐句表演档案格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: value,
    })
  }
  return {
    ...(value as Omit<DialoguePerformanceProfileResponse, 'etag'>),
    etag,
  }
}

function asDialoguePerformanceRecommendationJob(
  value: unknown,
  expectedLineId?: string,
): DialoguePerformanceRecommendationJob {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.projectId)
    || !isNullableString(value.episodeId)
    || value.type !== 'dialogue.performance.recommend'
    || !generationJobStatuses.has(value.status as string)
    || typeof value.progress !== 'number'
    || !isNonNegativeInteger(value.attempt)
    || !isRecord(value.input)
    || !isNonEmptyString(value.input.episodeId)
    || !isNonEmptyString(value.input.lineId)
    || !isNonEmptyString(value.input.sourceRevisionId)
    || (value.input.lineKind !== 'dialogue' && value.input.lineKind !== 'narration')
    || (expectedLineId !== undefined && value.input.lineId !== expectedLineId)
    || !isString(value.createdAt)
    || !isString(value.updatedAt)) {
    throw new ApiError('服务返回的逐句 AI 表演任务格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: value,
    })
  }
  if (value.output !== undefined && value.output !== null) {
    if (!isRecord(value.output)
      || !hasOnlyKeys(value.output, ['lineId', 'recommendation'])
      || value.output.lineId !== value.input.lineId
      || !isDialoguePerformanceRecommendation(value.output.recommendation, value.input.lineId)) {
      throw new ApiError('服务返回的逐句 AI 表演建议格式不正确。', {
        code: 'INVALID_RESPONSE',
        details: value,
      })
    }
  } else if (value.status === 'succeeded') {
    throw new ApiError('逐句 AI 表演任务已完成，但没有返回建议。', {
      code: 'INVALID_RESPONSE',
      details: value,
    })
  }
  return value as unknown as DialoguePerformanceRecommendationJob
}

const exportRenderStatuses = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'stale',
])

function isExportRenderRecord(value: unknown): value is ExportRenderRecord {
  if (
    !isRecord(value)
    || !isString(value.id)
    || !isString(value.projectId)
    || !isString(value.episodeId)
    || !exportRenderStatuses.has(value.status as string)
    || !isString(value.timelineRevisionId)
    || !isString(value.storyRevisionId)
    || !isRecord(value.specification)
    || value.specification.version !== 1
    || (value.specification.resolution !== '720p' && value.specification.resolution !== '1080p')
    || !['16:9', '9:16', '1:1'].includes(String(value.specification.aspectRatio))
    || typeof value.specification.kenBurns !== 'boolean'
    || typeof value.specification.burnSubtitles !== 'boolean'
    || typeof value.specification.introTitle !== 'boolean'
    || typeof value.specification.outroCard !== 'boolean'
    || typeof value.specification.reviewWatermark !== 'boolean'
    || value.specification.videoCodec !== 'h264'
    || value.specification.pixelFormat !== 'yuv420p'
    || value.specification.frameRate !== 24
    || value.specification.audioCodec !== 'aac'
    || value.specification.audioSampleRate !== 48_000
    || value.specification.timelineRevisionId !== value.timelineRevisionId
    || value.specification.storyRevisionId !== value.storyRevisionId
    || (value.outputAsset !== null && !isMediaAsset(value.outputAsset))
    || !isNullableString(value.reviewDownloadUrl)
    || !isNullableString(value.downloadUrl)
    || !isNullableString(value.jobId)
    || (value.error !== null && !isRecord(value.error))
    || !isString(value.createdAt)
    || !isString(value.updatedAt)
    || !isNullableString(value.completedAt)
  ) {
    return false
  }
  if (value.outputAsset === null) {
    return value.reviewDownloadUrl === null && value.downloadUrl === null
  }
  const gatedReviewDownloadUrl = `/api/v1/exports/${encodeURIComponent(value.id)}/review-download`
  const gatedDownloadUrl = `/api/v1/exports/${encodeURIComponent(value.id)}/download`
  return value.outputAsset.projectId === value.projectId
    && value.outputAsset.episodeId === value.episodeId
    && (value.status !== 'succeeded'
      ? value.reviewDownloadUrl === null && value.downloadUrl === null
      : value.reviewDownloadUrl === gatedReviewDownloadUrl
        && value.downloadUrl === gatedDownloadUrl
        && value.outputAsset.url === gatedDownloadUrl)
}

function isExportRenderJobOutput(value: unknown): boolean {
  return isRecord(value)
    && isString(value.exportId)
    && isString(value.timelineRevisionId)
    && isString(value.storyRevisionId)
    && isMediaAsset(value.asset)
    && value.asset.url === `/api/v1/exports/${encodeURIComponent(value.exportId)}/download`
}

function isExportRenderGenerationJob(value: unknown): value is ExportRenderGenerationJob {
  if (
    !isRecord(value)
    || !isString(value.id)
    || !isString(value.projectId)
    || !isNullableString(value.episodeId)
    || value.type !== 'export.render'
    || !generationJobStatuses.has(value.status as string)
    || typeof value.progress !== 'number'
    || !Number.isFinite(value.progress)
    || value.progress < 0
    || value.progress > 100
    || !isString(value.resourceId)
    || !isNonNegativeInteger(value.attempt)
    || !isRecord(value.input)
    || !isString(value.input.exportId)
    || (value.input.timelineRevisionId !== undefined && !isString(value.input.timelineRevisionId))
    || (value.input.storyRevisionId !== undefined && !isString(value.input.storyRevisionId))
    || !isString(value.createdAt)
    || !isString(value.updatedAt)
    || (value.output !== undefined && value.output !== null && !isExportRenderJobOutput(value.output))
    || (value.error !== undefined && value.error !== null && !isRecord(value.error))
  ) {
    return false
  }
  return value.status !== 'succeeded' || isExportRenderJobOutput(value.output)
}

function invalidExportResponse(payload: unknown): never {
  throw new ApiError('服务返回的导出任务数据格式不正确。', {
    code: 'INVALID_RESPONSE',
    details: payload,
  })
}

const qualityReportStatuses = new Set(['queued', 'running', 'passed', 'failed', 'cancelled', 'stale'])
const qualityCheckStatuses = new Set(['passed', 'failed', 'warning', 'skipped'])
const qualityCheckIds = new Set([
  'decodable',
  'ffprobe.specification',
  'video.black-frames',
  'audio.silence',
  'audio.peak',
  'subtitle.timing',
  'subtitle.safe-area',
])

function isQualityReport(value: unknown): value is QualityReport {
  if (!isRecord(value)
    || !isString(value.id)
    || !isString(value.projectId)
    || !isString(value.episodeId)
    || !isString(value.exportId)
    || !isString(value.outputAssetId)
    || !isString(value.outputAssetChecksum)
    || !isString(value.timelineRevisionId)
    || !isString(value.storyRevisionId)
    || !qualityReportStatuses.has(value.status as string)
    || (value.passed !== null && typeof value.passed !== 'boolean')
    || !isRecord(value.policy)
    || !isRecord(value.expected)
    || !Array.isArray(value.checks)
    || !value.checks.every((check) => isRecord(check)
      && qualityCheckIds.has(check.id as string)
      && qualityCheckStatuses.has(check.status as string)
      && ['error', 'warning', 'info'].includes(String(check.severity))
      && isString(check.message)
      && isRecord(check.metrics))
    || !isRecord(value.metrics)
    || !isRecord(value.summary)
    || (value.summary.passed !== null && typeof value.summary.passed !== 'boolean')
    || !isNonNegativeInteger(value.summary.failedChecks)
    || !isNonNegativeInteger(value.summary.warningChecks)
    || !isNullableString(value.jobId)
    || (value.jobStatus !== null && !generationJobStatuses.has(value.jobStatus as string))
    || (value.error !== null && !isRecord(value.error))
    || !isString(value.createdAt)
    || !isNullableString(value.completedAt)) {
    return false
  }
  return value.passed === value.summary.passed
}

function isReleaseReview(value: unknown): value is ReleaseReview {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'id',
      'projectId',
      'episodeId',
      'exportId',
      'outputAssetId',
      'outputAssetChecksum',
      'timelineRevisionId',
      'storyRevisionId',
      'qualityReportId',
      'qualityPolicyVersion',
      'decision',
      'checklist',
      'notes',
      'reviewedAt',
      'isCurrent',
      'invalidReasons',
    ])
    && isString(value.id)
    && isString(value.projectId)
    && isString(value.episodeId)
    && isString(value.exportId)
    && isString(value.outputAssetId)
    && isString(value.outputAssetChecksum)
    && /^[0-9a-f]{64}$/i.test(value.outputAssetChecksum)
    && isString(value.timelineRevisionId)
    && isString(value.storyRevisionId)
    && isString(value.qualityReportId)
    && isNonNegativeInteger(value.qualityPolicyVersion)
    && value.qualityPolicyVersion > 0
    && (value.decision === 'approve' || value.decision === 'reject')
    && isRecord(value.checklist)
    && hasExactlyKeys(value.checklist, [
      'audioVideoSync',
      'subtitleSyncAndComplete',
      'characterVisualSemantics',
    ])
    && typeof value.checklist.audioVideoSync === 'boolean'
    && typeof value.checklist.subtitleSyncAndComplete === 'boolean'
    && typeof value.checklist.characterVisualSemantics === 'boolean'
    && isNullableString(value.notes)
    && isString(value.reviewedAt)
    && Number.isFinite(Date.parse(value.reviewedAt))
    && typeof value.isCurrent === 'boolean'
    && Array.isArray(value.invalidReasons)
    && value.invalidReasons.every(isString)
    && (value.decision !== 'approve'
      || (value.checklist.audioVideoSync
        && value.checklist.subtitleSyncAndComplete
        && value.checklist.characterVisualSemantics))
    && (value.decision !== 'reject'
      || (!value.checklist.audioVideoSync
        || !value.checklist.subtitleSyncAndComplete
        || !value.checklist.characterVisualSemantics))
}

function isQualityGenerationJob(value: unknown, report: QualityReport): boolean {
  return isRecord(value)
    && isString(value.id)
    && value.id === report.jobId
    && value.type === 'quality.check'
    && value.projectId === report.projectId
    && value.episodeId === report.episodeId
    && generationJobStatuses.has(value.status as string)
    && typeof value.progress === 'number'
    && Number.isFinite(value.progress)
    && value.progress >= 0
    && value.progress <= 100
    && isNonNegativeInteger(value.attempt)
    && isRecord(value.input)
    && value.input.qualityReportId === report.id
    && isString(value.createdAt)
    && isString(value.updatedAt)
}

const pipelineRunStatuses = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'stale'])
const pipelineStepStatuses = new Set(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'stale'])
const pipelineStepIds = new Set<PipelineStepId>(['storyboard', 'speech', 'timeline', 'export', 'quality'])

function hasExactlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => key in value)
    && Object.keys(value).every((key) => allowed.has(key))
}

const paidAigcActions = new Set<PaidAigcAction>([
  'asset.image.generate',
  'asset.image.edit',
  'dialogue.speech.generate',
  'project.narrator.voice.preview',
  'character.voice.preview',
])
const paidAigcConfirmationTokenPattern = /^aigcpf1_([1-9][0-9]{9,12})_[a-f0-9]{64}$/

function isPaidAigcText(value: unknown, maximum: number): value is string {
  return isString(value)
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function invalidPaidAigcConfirmation(value: unknown): never {
  throw new ApiError('服务返回的 AIGC 计费确认格式不正确。', {
    code: 'INVALID_RESPONSE',
    details: value,
  })
}

/** Strictly parse the public half of a server-authenticated paid intent. */
export function parsePublicPaidAigcConfirmation(
  value: unknown,
  expectedAction?: PaidAigcAction,
): PublicPaidAigcConfirmation {
  if (!isRecord(value)
    || !hasExactlyKeys(value, [
      'version',
      'action',
      'label',
      'billableTaskCount',
      'provider',
      'intentFingerprint',
      'expiresAt',
      'confirmationToken',
      'priceEstimate',
      'priceEstimateReason',
    ])
    || value.version !== 1
    || !isString(value.action)
    || !paidAigcActions.has(value.action as PaidAigcAction)
    || (expectedAction !== undefined && value.action !== expectedAction)
    || !isPaidAigcText(value.label, 200)
    || value.billableTaskCount !== 1
    || !isRecord(value.provider)
    || !hasExactlyKeys(value.provider, ['providerId', 'model', 'configRevision'])
    || !isPaidAigcText(value.provider.providerId, 256)
    || !isPaidAigcText(value.provider.model, 512)
    || !Number.isSafeInteger(value.provider.configRevision)
    || (value.provider.configRevision as number) < 1
    || !isString(value.intentFingerprint)
    || !/^[a-f0-9]{64}$/.test(value.intentFingerprint)
    || !isString(value.expiresAt)
    || !isString(value.confirmationToken)
    || value.priceEstimate !== null
    || value.priceEstimateReason !== 'PROVIDER_PRICING_UNAVAILABLE') {
    return invalidPaidAigcConfirmation(value)
  }
  const expiresAtMs = Date.parse(value.expiresAt)
  const tokenMatch = paidAigcConfirmationTokenPattern.exec(value.confirmationToken)
  if (!Number.isFinite(expiresAtMs)
    || new Date(expiresAtMs).toISOString() !== value.expiresAt
    || !tokenMatch
    || Math.floor(expiresAtMs / 1_000) !== Number(tokenMatch[1])) {
    return invalidPaidAigcConfirmation(value)
  }
  return value as unknown as PublicPaidAigcConfirmation
}

/**
 * Strictly extract a paid challenge from the only response shape that is safe
 * to present as an explicit confirmation. Non-challenge errors are rethrown so
 * callers cannot accidentally turn catalog/provider conflicts into consent.
 */
export function parsePaidAigcConfirmationRequiredError(
  error: unknown,
  expectedAction: PaidAigcAction,
): PublicPaidAigcConfirmation {
  if (!(error instanceof ApiError)
    || error.status !== 409
    || error.code !== 'PAID_CONFIRMATION_REQUIRED') {
    throw error
  }
  if (!isRecord(error.details)
    || !hasExactlyKeys(error.details, ['confirmation'])) {
    return invalidPaidAigcConfirmation(error.details)
  }
  return parsePublicPaidAigcConfirmation(error.details.confirmation, expectedAction)
}

function paidAigcConfirmationToken(confirmationToken: string): string {
  if (!paidAigcConfirmationTokenPattern.test(confirmationToken)) {
    throw new ApiError('计费确认令牌格式无效，请重新预检。', {
      code: 'PAID_CONFIRMATION_REQUIRED',
    })
  }
  return confirmationToken
}

function isPipelineString(value: unknown): value is string {
  return isString(value) && value.trim() === value && value.length > 0
}

function isUniqueIdList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(isPipelineString)
    && new Set(value).size === value.length
}

function isPipelineRunError(value: unknown, expectedStep?: PipelineStepId): value is PipelineRunError {
  if (!isRecord(value)
    || !hasExactlyKeys(value, ['code', 'message'], ['step', 'jobId', 'childCode'])
    || !isPipelineString(value.code)
    || !isPipelineString(value.message)
    || (value.step !== undefined && (!isString(value.step) || !pipelineStepIds.has(value.step as PipelineStepId)))
    || (expectedStep !== undefined && value.step !== undefined && value.step !== expectedStep)
    || (value.jobId !== undefined && !isPipelineString(value.jobId))
    || (value.childCode !== undefined && !isPipelineString(value.childCode))) {
    return false
  }
  return true
}

function isPipelineProviderBinding(value: unknown): value is PipelineProviderBinding {
  return isRecord(value)
    && hasExactlyKeys(value, ['providerId', 'configRevision', 'model'])
    && isPipelineString(value.providerId)
    && Number.isInteger(value.configRevision)
    && (value.configRevision as number) >= 1
    && (value.model === null || isPipelineString(value.model))
}

function isPipelineSpeechTargetBinding(value: unknown): value is PipelineSpeechTargetBinding {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'targetId', 'publicLineId', 'sceneId', 'characterId', 'characterDatabaseId',
      'characterName', 'voiceId', 'voiceName', 'voiceProfileRevisionId',
      'catalogFingerprint', 'provider', 'speed', 'pitch', 'emotion',
      'sceneDirectionApplied',
    ])
    && isPipelineString(value.targetId)
    && isPipelineString(value.publicLineId)
    && isPipelineString(value.sceneId)
    && isPipelineString(value.characterId)
    && isPipelineString(value.characterDatabaseId)
    && isPipelineString(value.characterName)
    && isPipelineString(value.voiceId)
    && isPipelineString(value.voiceName)
    && isPipelineString(value.voiceProfileRevisionId)
    && typeof value.catalogFingerprint === 'string'
    && /^[0-9a-f]{64}$/.test(value.catalogFingerprint)
    && isPipelineProviderBinding(value.provider)
    && typeof value.speed === 'number' && Number.isFinite(value.speed)
    && value.speed >= 0.5 && value.speed <= 2
    && typeof value.pitch === 'number' && Number.isInteger(value.pitch)
    && value.pitch >= -12 && value.pitch <= 12
    && (value.emotion === null || dialogueSpeechEmotions.has(value.emotion as string))
    && typeof value.sceneDirectionApplied === 'boolean'
}

function isPipelineVoiceBlocker(value: unknown): boolean {
  return isRecord(value)
    && hasExactlyKeys(value, ['code', 'characterId', 'characterName', 'lineCount', 'lineIds', 'message'])
    && isPipelineString(value.code)
    && (value.characterId === null || isPipelineString(value.characterId))
    && isPipelineString(value.characterName)
    && Number.isInteger(value.lineCount) && (value.lineCount as number) > 0
    && isUniqueIdList(value.lineIds)
    && value.lineIds.length === value.lineCount
    && isPipelineString(value.message)
}

function isPipelineVoiceSummary(value: unknown): boolean {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'boundCharacterCount', 'distinctVoiceCount', 'sceneDirectedTargetCount', 'characters',
    ])
    && isNonNegativeInteger(value.boundCharacterCount)
    && isNonNegativeInteger(value.distinctVoiceCount)
    && isNonNegativeInteger(value.sceneDirectedTargetCount)
    && Array.isArray(value.characters)
    && value.characters.length === value.boundCharacterCount
    && value.characters.every((character) => isRecord(character)
      && hasExactlyKeys(character, [
        'characterId', 'characterName', 'voiceId', 'voiceName', 'providerId',
        'providerConfigRevision', 'targetCount', 'sceneDirectedTargetCount',
      ])
      && isPipelineString(character.characterId)
      && isPipelineString(character.characterName)
      && isPipelineString(character.voiceId)
      && isPipelineString(character.voiceName)
      && isPipelineString(character.providerId)
      && Number.isInteger(character.providerConfigRevision)
      && (character.providerConfigRevision as number) >= 1
      && Number.isInteger(character.targetCount) && (character.targetCount as number) > 0
      && isNonNegativeInteger(character.sceneDirectedTargetCount)
      && (character.sceneDirectedTargetCount as number) <= (character.targetCount as number))
}

const pipelineConfirmationTokenPattern = /^pfr1_([1-9][0-9]{9,12})_[a-f0-9]{64}$/

function isPipelineRunPreflight(value: unknown): value is PipelineRunPreflight {
  if (!isRecord(value)
    || !hasExactlyKeys(value, [
      'version',
      'projectId',
      'episodeId',
      'sourceRevisionId',
      'readyStoryboardCount',
      'missingStoryboardCount',
      'readySpeechCount',
      'missingSpeechCount',
      'hasPublishableAudio',
      'billableStoryboardCount',
      'billableSpeechCount',
      'billableTargetCount',
      'imageProvider',
      'speechProvider',
      'speechProviders',
      'voiceSummary',
      'blockers',
      'canCreate',
      'confirmationToken',
      'expiresAt',
    ])
    || value.version !== 1
    || !isPipelineString(value.projectId)
    || !isPipelineString(value.episodeId)
    || !isPipelineString(value.sourceRevisionId)
    || !isNonNegativeInteger(value.readyStoryboardCount)
    || !isNonNegativeInteger(value.missingStoryboardCount)
    || !isNonNegativeInteger(value.readySpeechCount)
    || !isNonNegativeInteger(value.missingSpeechCount)
    || typeof value.hasPublishableAudio !== 'boolean'
    || !isNonNegativeInteger(value.billableStoryboardCount)
    || !isNonNegativeInteger(value.billableSpeechCount)
    || !isNonNegativeInteger(value.billableTargetCount)
    || (value.imageProvider !== null && !isPipelineProviderBinding(value.imageProvider))
    || (value.speechProvider !== null && !isPipelineProviderBinding(value.speechProvider))
    || !Array.isArray(value.speechProviders)
    || !value.speechProviders.every(isPipelineProviderBinding)
    || !isPipelineVoiceSummary(value.voiceSummary)
    || !Array.isArray(value.blockers)
    || !value.blockers.every(isPipelineVoiceBlocker)
    || typeof value.canCreate !== 'boolean'
    || (value.expiresAt !== null && typeof value.expiresAt !== 'string')
    || (value.confirmationToken !== null
      && (typeof value.confirmationToken !== 'string'
        || !pipelineConfirmationTokenPattern.test(value.confirmationToken)))) {
    return false
  }
  if (value.billableStoryboardCount !== value.missingStoryboardCount
    || value.billableSpeechCount > value.missingSpeechCount
    || value.billableTargetCount !== value.billableStoryboardCount + value.billableSpeechCount
    || (value.billableStoryboardCount > 0 && value.imageProvider === null)
    || (value.canCreate !== (value.blockers.length === 0))
    || (value.canCreate !== (value.confirmationToken !== null))
    || ((value.confirmationToken === null) !== (value.expiresAt === null))
    || (value.canCreate && value.billableSpeechCount > 0 && value.speechProviders.length === 0)) {
    return false
  }
  if (value.confirmationToken !== null && value.expiresAt !== null) {
    const token = pipelineConfirmationTokenPattern.exec(value.confirmationToken)
    const expiresAtMs = Date.parse(value.expiresAt)
    if (!token
      || !Number.isFinite(expiresAtMs)
      || new Date(expiresAtMs).toISOString() !== value.expiresAt
      || Math.floor(expiresAtMs / 1_000) !== Number(token[1])) {
      return false
    }
  }
  return true
}

function isPipelineFanoutStep(
  value: unknown,
  stepId: Extract<PipelineStepId, 'storyboard' | 'speech'>,
  expectedTotal: number,
): value is PipelineFanoutStep {
  if (!isRecord(value)
    || !hasExactlyKeys(value, ['status', 'jobIds', 'completed', 'total'], ['error'])
    || !pipelineStepStatuses.has(value.status as string)
    || !isUniqueIdList(value.jobIds)
    || !isNonNegativeInteger(value.completed)
    || !isNonNegativeInteger(value.total)
    || value.total !== expectedTotal
    || value.completed > value.total
    || value.jobIds.length > value.total
    || value.completed > value.jobIds.length
    || (value.error !== undefined && !isPipelineRunError(value.error, stepId))) {
    return false
  }
  if (value.status === 'succeeded' && value.completed !== value.total) return false
  if (value.total === 0 && value.status !== 'succeeded') return false
  return true
}

function isPipelineTimelineStep(value: unknown): value is PipelineTimelineStep {
  return isRecord(value)
    && hasExactlyKeys(value, ['status'], ['revisionId', 'automaticEdit', 'error'])
    && pipelineStepStatuses.has(value.status as string)
    && (value.revisionId === undefined || isPipelineString(value.revisionId))
    && (value.status !== 'succeeded' || isPipelineString(value.revisionId))
    && (value.automaticEdit === undefined || isPipelineTimelineAutomaticEdit(value.automaticEdit))
    && (value.error === undefined || isPipelineRunError(value.error, 'timeline'))
}

function isPipelineTimelineAutomaticEdit(value: unknown): boolean {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'strategy',
      'executor',
      'planHash',
      'operationCount',
      'changedElementIds',
    ], ['planId', 'applicationId'])
    && value.strategy === 'managed-dialogue-reflow-v1'
    && value.executor === 'OpenCut-Classic/UpdateElementsCommand'
    && typeof value.planHash === 'string'
    && /^[0-9a-f]{64}$/.test(value.planHash)
    && Number.isSafeInteger(value.operationCount)
    && (value.operationCount as number) > 0
    && isUniqueIdList(value.changedElementIds)
    && value.changedElementIds.length === value.operationCount
    && (value.planId === undefined || isPipelineString(value.planId))
    && (value.applicationId === undefined || isPipelineString(value.applicationId))
    && ((value.planId === undefined) === (value.applicationId === undefined))
}

function isPipelineExportStep(value: unknown): value is PipelineExportStep {
  return isRecord(value)
    && hasExactlyKeys(value, ['status'], ['exportId', 'rootJobId', 'error'])
    && pipelineStepStatuses.has(value.status as string)
    && (value.exportId === undefined || isPipelineString(value.exportId))
    && (value.rootJobId === undefined || isPipelineString(value.rootJobId))
    && (value.status !== 'succeeded'
      || (isPipelineString(value.exportId) && isPipelineString(value.rootJobId)))
    && (value.error === undefined || isPipelineRunError(value.error, 'export'))
}

function isPipelineQualityStep(value: unknown): value is PipelineQualityStep {
  return isRecord(value)
    && hasExactlyKeys(value, ['status'], ['reportId', 'rootJobId', 'passed', 'error'])
    && pipelineStepStatuses.has(value.status as string)
    && (value.reportId === undefined || isPipelineString(value.reportId))
    && (value.rootJobId === undefined || isPipelineString(value.rootJobId))
    && (value.passed === undefined || typeof value.passed === 'boolean')
    && (value.status !== 'succeeded'
      || (isPipelineString(value.reportId) && isPipelineString(value.rootJobId) && value.passed === true))
    && (value.error === undefined || isPipelineRunError(value.error, 'quality'))
}

function isPipelineRun(value: unknown): value is PipelineRun {
  if (!isRecord(value)
    || !hasExactlyKeys(value, [
      'id',
      'projectId',
      'episodeId',
      'sourceRevisionId',
      'status',
      'progress',
      'version',
      'mode',
      'options',
      'bindings',
      'targets',
      'steps',
      'error',
      'createdAt',
      'updatedAt',
      'completedAt',
    ])
    || !isPipelineString(value.id)
    || !isPipelineString(value.projectId)
    || !isPipelineString(value.episodeId)
    || !isPipelineString(value.sourceRevisionId)
    || !pipelineRunStatuses.has(value.status as string)
    || typeof value.progress !== 'number'
    || !Number.isFinite(value.progress)
    || value.progress < 0
    || value.progress > 100
    || value.version !== 1
    || value.mode !== 'dynamic-comic'
    || !isRecord(value.options)
    || !hasExactlyKeys(value.options, [
      'resolution',
      'kenBurns',
      'burnSubtitles',
      'introTitle',
      'outroCard',
      'reviewWatermark',
      'speechMode',
    ], ['defaultVoiceId'])
    || (value.options.resolution !== '720p' && value.options.resolution !== '1080p')
    || typeof value.options.kenBurns !== 'boolean'
    || typeof value.options.burnSubtitles !== 'boolean'
    || typeof value.options.introTitle !== 'boolean'
    || typeof value.options.outroCard !== 'boolean'
    || typeof value.options.reviewWatermark !== 'boolean'
    || (value.options.speechMode !== 'auto' && value.options.speechMode !== 'skip')
    || (value.options.defaultVoiceId !== undefined && !isPipelineString(value.options.defaultVoiceId))
    || !isRecord(value.bindings)
    || !hasExactlyKeys(value.bindings, [], ['imageProvider', 'speechProvider', 'speechTargets'])
    || (value.bindings.imageProvider !== undefined && !isPipelineProviderBinding(value.bindings.imageProvider))
    || (value.bindings.speechProvider !== undefined && !isPipelineProviderBinding(value.bindings.speechProvider))
    || (value.bindings.speechTargets !== undefined
      && (!Array.isArray(value.bindings.speechTargets)
        || !value.bindings.speechTargets.every(isPipelineSpeechTargetBinding)))
    || !isRecord(value.targets)
    || !hasExactlyKeys(value.targets, ['storyboard', 'speech'])
    || !isUniqueIdList(value.targets.storyboard)
    || !isUniqueIdList(value.targets.speech)
    || !isRecord(value.steps)
    || !hasExactlyKeys(value.steps, ['storyboard', 'speech', 'timeline', 'export', 'quality'])
    || !isPipelineFanoutStep(value.steps.storyboard, 'storyboard', value.targets.storyboard.length)
    || !isPipelineFanoutStep(value.steps.speech, 'speech', value.targets.speech.length)
    || !isPipelineTimelineStep(value.steps.timeline)
    || !isPipelineExportStep(value.steps.export)
    || !isPipelineQualityStep(value.steps.quality)
    || (value.error !== null && !isPipelineRunError(value.error))
    || !isPipelineString(value.createdAt)
    || !isPipelineString(value.updatedAt)
    || (value.completedAt !== null && !isPipelineString(value.completedAt))) {
    return false
  }

  if (value.targets.storyboard.length > 0 && !value.bindings.imageProvider) return false
  if (value.options.speechMode === 'skip' && value.targets.speech.length > 0) return false
  if (value.options.speechMode === 'auto' && value.targets.speech.length > 0) {
    const perTarget = Array.isArray(value.bindings.speechTargets)
      && value.bindings.speechTargets.length === value.targets.speech.length
      && value.bindings.speechTargets.every((binding, index) => (
        isPipelineSpeechTargetBinding(binding)
          && binding.targetId === (value.targets as { speech: string[] }).speech[index]
      ))
    const legacy = Boolean(value.bindings.speechProvider && value.options.defaultVoiceId)
    if (!perTarget && !legacy) return false
  }
  const jobIds = [
    ...value.steps.storyboard.jobIds,
    ...value.steps.speech.jobIds,
    ...(value.steps.export.rootJobId ? [value.steps.export.rootJobId] : []),
    ...(value.steps.quality.rootJobId ? [value.steps.quality.rootJobId] : []),
  ]
  if (new Set(jobIds).size !== jobIds.length) return false
  const stepJobIds: Record<PipelineStepId, string[]> = {
    storyboard: value.steps.storyboard.jobIds,
    speech: value.steps.speech.jobIds,
    timeline: [],
    export: value.steps.export.rootJobId ? [value.steps.export.rootJobId] : [],
    quality: value.steps.quality.rootJobId ? [value.steps.quality.rootJobId] : [],
  }
  const parsedSteps = value.steps as unknown as PipelineRun['steps']
  for (const stepId of pipelineStepIds) {
    const step = parsedSteps[stepId]
    if (step.error?.jobId && !stepJobIds[stepId].includes(step.error.jobId)) return false
  }
  if (value.error?.jobId && !jobIds.includes(value.error.jobId)) return false

  const terminal = ['succeeded', 'failed', 'cancelled', 'stale'].includes(value.status as string)
  if (terminal !== (value.completedAt !== null)) return false
  if (!terminal && value.error !== null) return false
  if (value.status === 'succeeded') {
    if (value.progress !== 100 || value.error !== null) return false
    if (!Object.values(value.steps).every((step) => isRecord(step) && step.status === 'succeeded')) return false
  }
  return true
}

export function parsePipelineRun(value: unknown): PipelineRun {
  if (!isPipelineRun(value)) {
    throw new ApiError('服务返回的一键生产任务数据格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: value,
    })
  }
  return value
}

function pipelineRunFromEnvelope(payload: unknown): PipelineRun {
  if (!isRecord(payload) || !hasExactlyKeys(payload, ['pipelineRun'])) {
    throw new ApiError('服务返回的一键生产响应封装格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return parsePipelineRun(payload.pipelineRun)
}

export async function getHealth(options: RequestOptions = {}): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health', {}, options.signal)
}

export async function createAssetImageJob(
  projectId: string,
  episodeId: string | null,
  input: GenerateImageInput,
  options: RequestOptions & {
    providerId?: string
    idempotencyKey: string
    confirmationToken: string
  },
): Promise<ImageJob> {
  const body = assetImageGenerationRequest(projectId, episodeId, input, options.providerId)
  const payload = await request<unknown>(
    '/api/v1/assets/image-generations',
    jsonRequestWithHeaders('POST', body, {
      'Idempotency-Key': options.idempotencyKey,
      'x-manju-aigc-confirmation': paidAigcConfirmationToken(options.confirmationToken),
    }),
    options.signal,
  )
  return expectEnvelope<ImageJob>(payload, 'job', isRecord)
}

function assetImageGenerationRequest(
  projectId: string,
  episodeId: string | null,
  input: GenerateImageInput,
  providerId?: string,
): AssetImageGenerationRequest {
  return {
    projectId,
    ...(episodeId ? { episodeId } : {}),
    ...(providerId ? { providerId } : {}),
    input,
  }
}

export async function preflightAssetImageJob(
  projectId: string,
  episodeId: string | null,
  input: GenerateImageInput,
  options: RequestOptions & { providerId?: string; idempotencyKey: string },
): Promise<PublicPaidAigcConfirmation> {
  const body = assetImageGenerationRequest(projectId, episodeId, input, options.providerId)
  try {
    await request<unknown>(
      '/api/v1/assets/image-generations',
      jsonRequestWithHeaders('POST', body, {
        'Idempotency-Key': options.idempotencyKey,
      }),
      options.signal,
    )
  } catch (error) {
    if (!(error instanceof ApiError)
      || error.status !== 409
      || error.code !== 'PAID_CONFIRMATION_REQUIRED') {
      throw error
    }
    if (!isRecord(error.details)
      || !hasExactlyKeys(error.details, ['confirmation'])) {
      return invalidPaidAigcConfirmation(error.details)
    }
    return parsePublicPaidAigcConfirmation(error.details.confirmation, 'asset.image.generate')
  }
  throw new ApiError('图片生成预检未返回必要的计费确认。', {
    code: 'INVALID_RESPONSE',
  })
}

export async function listImageJobs(
  options: ListImageJobsOptions = {},
): Promise<ImageJob[]> {
  const params = new URLSearchParams()
  params.set('type', 'asset.image.generate')
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.status !== undefined) params.set('status', options.status)
  const query = params.size > 0 ? `?${params.toString()}` : ''
  const payload = await request<unknown>(`/api/v1/jobs${query}`, {}, options.signal)
  return expectEnvelope<ImageJob[]>(payload, 'jobs', Array.isArray)
}

export async function getImageJob(
  id: string,
  options: RequestOptions = {},
): Promise<ImageJob> {
  const payload = await request<unknown>(
    `/api/v1/jobs/${encodeURIComponent(id)}`,
    {},
    options.signal,
  )
  return expectEnvelope<ImageJob>(payload, 'job', (value) => isRecord(value))
}

export async function retryImageJob(
  id: string,
  options: RequestOptions = {},
): Promise<ImageJob> {
  const payload = await request<unknown>(
    `/api/v1/jobs/${encodeURIComponent(id)}/retry`,
    jsonRequest('POST'),
    options.signal,
  )
  return expectEnvelope<ImageJob>(payload, 'job', (value) => isRecord(value))
}

export async function listProviders(options: RequestOptions = {}): Promise<ProviderConnection[]> {
  const payload = await request<unknown>('/api/v1/providers', {}, options.signal)
  return expectEnvelope<ProviderConnection[]>(payload, 'providers', Array.isArray)
}

export async function saveProviderCredentials(
  id: string,
  input: SaveProviderCredentialsInput,
  options: RequestOptions = {},
): Promise<ProviderConnection> {
  const payload = await request<unknown>(
    `/api/v1/providers/${encoded(id)}/credentials`,
    jsonRequest('PUT', input),
    options.signal,
  )
  return expectEnvelope<ProviderConnection>(payload, 'provider', isRecord)
}

export async function deleteProviderCredentials(
  id: string,
  options: RequestOptions = {},
): Promise<ProviderConnection> {
  const payload = await request<unknown>(
    `/api/v1/providers/${encoded(id)}/credentials`,
    jsonRequest('DELETE'),
    options.signal,
  )
  return expectEnvelope<ProviderConnection>(payload, 'provider', isRecord)
}

export async function testProvider(
  id: string,
  options: RequestOptions = {},
): Promise<ProviderConnection> {
  const payload = await request<unknown>(
    `/api/v1/providers/${encoded(id)}/test`,
    jsonRequest('POST'),
    options.signal,
  )
  return expectEnvelope<ProviderConnection>(payload, 'provider', isRecord)
}

export async function setDefaultProvider(
  id: string,
  options: RequestOptions = {},
): Promise<ProviderConnection> {
  const payload = await request<unknown>(
    `/api/v1/providers/${encoded(id)}`,
    jsonRequest('PATCH', { isDefault: true }),
    options.signal,
  )
  return expectEnvelope<ProviderConnection>(payload, 'provider', isRecord)
}

export async function startProviderAuth(
  id: string,
  options: RequestOptions = {},
): Promise<{ providerId: string; status: string; message: string }> {
  const payload = await request<unknown>(
    `/api/v1/providers/${encoded(id)}/auth/start`,
    jsonRequest('POST'),
    options.signal,
  )
  return expectEnvelope(payload, 'auth', isRecord)
}

/** Reads only voices currently returned by the verified MiniMax account. */
export async function listMiniMaxVoices(
  options: RequestOptions = {},
): Promise<MiniMaxVoiceCatalog> {
  const payload = await request<unknown>(
    '/api/v1/providers/minimax-speech/voices',
    {},
    options.signal,
  )
  if (!isMiniMaxVoiceCatalog(payload)) {
    throw new ApiError('服务返回的 MiniMax 音色目录格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload
}

/** Reads voices from a verified speech Provider without accepting arbitrary IDs. */
export async function listSpeechVoices(
  providerId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech',
  options: RequestOptions = {},
): Promise<MiniMaxVoiceCatalog> {
  const payload = await request<unknown>(
    `/api/v1/providers/${encoded(providerId)}/voices`,
    {},
    options.signal,
  )
  if (!isMiniMaxVoiceCatalog(payload) || payload.provider.id !== providerId) {
    throw new ApiError('服务返回的声线目录格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload
}

/** Reads the independently versioned, project-wide narrator casting. */
export async function getProjectNarratorVoiceProfile(
  projectId: string,
  options: RequestOptions = {},
): Promise<ProjectNarratorVoiceProfileState> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/projects/${encoded(projectId)}/narrator-voice-profile`,
    {},
    options.signal,
  )
  return parseProjectNarratorVoiceProfileState(payload, response, projectId)
}

/**
 * Confirms one voice from the observed account catalog. This never submits a
 * TTS request; the server revalidates both provider revision and fingerprint
 * before creating the immutable project-level audit revision.
 */
export async function putProjectNarratorVoiceProfile(
  projectId: string,
  input: PutProjectNarratorVoiceProfileInput,
  projectEtag: string,
  options: RequestOptions = {},
): Promise<ProjectNarratorVoiceProfileMutationResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/projects/${encoded(projectId)}/narrator-voice-profile`,
    jsonRequestWithHeaders('PUT', input, { 'If-Match': projectEtag }),
    options.signal,
  )
  return parseProjectNarratorVoiceProfileMutation(payload, response, projectId)
}

/** Clearing also creates an immutable deletion audit revision. */
export async function deleteProjectNarratorVoiceProfile(
  projectId: string,
  projectEtag: string,
  options: RequestOptions = {},
): Promise<ProjectNarratorVoiceProfileMutationResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/projects/${encoded(projectId)}/narrator-voice-profile`,
    jsonRequestWithHeaders('DELETE', undefined, { 'If-Match': projectEtag }),
    options.signal,
  )
  return parseProjectNarratorVoiceProfileMutation(payload, response, projectId)
}

export async function createProjectNarratorVoicePreview(
  episodeId: string,
  input: {
    projectId: string
    providerId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
    voiceId: string
    expectedCatalogFingerprint: string
  },
  episodeEtag: string,
  idempotencyKey: string,
  confirmationToken: string,
  options: RequestOptions = {},
): Promise<ProjectNarratorVoicePreviewJob> {
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/narrator-voice-previews`,
    jsonRequestWithHeaders('POST', input, {
      'If-Match': episodeEtag,
      'Idempotency-Key': idempotencyKey,
      'x-manju-aigc-confirmation': paidAigcConfirmationToken(confirmationToken),
    }),
    options.signal,
  )
  return asProjectNarratorVoicePreviewJob(expectEnvelope(payload, 'job', isRecord))
}

export async function preflightProjectNarratorVoicePreview(
  episodeId: string,
  input: {
    projectId: string
    providerId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
    voiceId: string
    expectedCatalogFingerprint: string
  },
  episodeEtag: string,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<PublicPaidAigcConfirmation> {
  try {
    await request<unknown>(
      `/api/v1/episodes/${encoded(episodeId)}/narrator-voice-previews`,
      jsonRequestWithHeaders('POST', input, {
        'If-Match': episodeEtag,
        'Idempotency-Key': idempotencyKey,
      }),
      options.signal,
    )
  } catch (error) {
    return parsePaidAigcConfirmationRequiredError(error, 'project.narrator.voice.preview')
  }
  throw new ApiError('项目旁白试听预检未返回必要的计费确认。', {
    code: 'INVALID_RESPONSE',
  })
}

export async function getProjectNarratorVoicePreviewJob(
  jobId: string,
  options: RequestOptions = {},
): Promise<ProjectNarratorVoicePreviewJob> {
  const payload = await request<unknown>(
    `/api/v1/jobs/${encoded(jobId)}`,
    {},
    options.signal,
  )
  return asProjectNarratorVoicePreviewJob(expectEnvelope(payload, 'job', isRecord))
}

/** Restore persisted narrator previews after refresh; no Provider call is made. */
export async function listProjectNarratorVoicePreviewJobs(
  projectId: string,
  options: RequestOptions & { limit?: number } = {},
): Promise<ProjectNarratorVoicePreviewJob[]> {
  const params = new URLSearchParams({
    projectId,
    type: 'project.narrator.voice.preview',
    limit: String(options.limit ?? 100),
  })
  const payload = await request<unknown>(
    `/api/v1/jobs?${params.toString()}`,
    {},
    options.signal,
  )
  const jobs = expectEnvelope<unknown[]>(payload, 'jobs', Array.isArray)
  return jobs.map(asProjectNarratorVoicePreviewJob)
}

export async function createCharacterVoiceRecommendation(
  episodeId: string,
  characterId: string,
  input: {
    projectId: string
    speechProviderId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
    textProviderId?: string
    expectedCatalogFingerprint: string
  },
  episodeEtag: string,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<CharacterVoiceRecommendationJob> {
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/characters/${encoded(characterId)}/voice-recommendations`,
    jsonRequestWithHeaders('POST', input, {
      'If-Match': episodeEtag,
      'Idempotency-Key': idempotencyKey,
    }),
    options.signal,
  )
  return asCharacterVoiceRecommendationJob(expectEnvelope(payload, 'job', isRecord))
}

export async function getCharacterVoiceRecommendationJob(
  jobId: string,
  options: RequestOptions = {},
): Promise<CharacterVoiceRecommendationJob> {
  const payload = await request<unknown>(
    `/api/v1/jobs/${encoded(jobId)}`,
    {},
    options.signal,
  )
  return asCharacterVoiceRecommendationJob(expectEnvelope(payload, 'job', isRecord))
}

export async function createCharacterVoicePreview(
  episodeId: string,
  characterId: string,
  input: {
    projectId: string
    providerId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
    voiceId: string
    expectedCatalogFingerprint: string
  },
  episodeEtag: string,
  idempotencyKey: string,
  confirmationToken: string,
  options: RequestOptions = {},
): Promise<CharacterVoicePreviewJob> {
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/characters/${encoded(characterId)}/voice-previews`,
    jsonRequestWithHeaders('POST', input, {
      'If-Match': episodeEtag,
      'Idempotency-Key': idempotencyKey,
      'x-manju-aigc-confirmation': paidAigcConfirmationToken(confirmationToken),
    }),
    options.signal,
  )
  return asCharacterVoicePreviewJob(expectEnvelope(payload, 'job', isRecord))
}

export async function preflightCharacterVoicePreview(
  episodeId: string,
  characterId: string,
  input: {
    projectId: string
    providerId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
    voiceId: string
    expectedCatalogFingerprint: string
  },
  episodeEtag: string,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<PublicPaidAigcConfirmation> {
  try {
    await request<unknown>(
      `/api/v1/episodes/${encoded(episodeId)}/characters/${encoded(characterId)}/voice-previews`,
      jsonRequestWithHeaders('POST', input, {
        'If-Match': episodeEtag,
        'Idempotency-Key': idempotencyKey,
      }),
      options.signal,
    )
  } catch (error) {
    return parsePaidAigcConfirmationRequiredError(error, 'character.voice.preview')
  }
  throw new ApiError('角色声线试听预检未返回必要的计费确认。', {
    code: 'INVALID_RESPONSE',
  })
}

export async function getCharacterVoicePreviewJob(
  jobId: string,
  options: RequestOptions = {},
): Promise<CharacterVoicePreviewJob> {
  const payload = await request<unknown>(
    `/api/v1/jobs/${encoded(jobId)}`,
    {},
    options.signal,
  )
  return asCharacterVoicePreviewJob(expectEnvelope(payload, 'job', isRecord))
}

/** Restore persisted previews after a page refresh; no Provider call is made. */
export async function listCharacterVoicePreviewJobs(
  projectId: string,
  options: RequestOptions & { limit?: number } = {},
): Promise<CharacterVoicePreviewJob[]> {
  const params = new URLSearchParams({
    projectId,
    type: 'character.voice.preview',
    limit: String(options.limit ?? 100),
  })
  const payload = await request<unknown>(
    `/api/v1/jobs?${params.toString()}`,
    {},
    options.signal,
  )
  const jobs = expectEnvelope<unknown[]>(payload, 'jobs', Array.isArray)
  return jobs.map(asCharacterVoicePreviewJob)
}

/** Records a zero-Provider decision only after the browser played this asset to completion. */
export async function createVoicePreviewReview(
  jobId: string,
  input: CreateVoicePreviewReviewInput,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<VoicePreviewReview> {
  const payload = await request<unknown>(
    `/api/v1/jobs/${encoded(jobId)}/voice-preview-reviews`,
    jsonRequestWithHeaders('POST', input, { 'Idempotency-Key': idempotencyKey }),
    options.signal,
  )
  const review = expectEnvelope(payload, 'review', isRecord)
  if (!isVoicePreviewReview(review)) {
    throw new ApiError('服务返回的声线试听验收记录格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: review,
    })
  }
  return review
}

/** Restores immutable audition decisions after refresh; no Provider call is made. */
export async function listVoicePreviewReviews(
  jobId: string,
  projectId: string,
  options: RequestOptions = {},
): Promise<VoicePreviewReview[]> {
  const params = new URLSearchParams({ projectId })
  const payload = await request<unknown>(
    `/api/v1/jobs/${encoded(jobId)}/voice-preview-reviews?${params.toString()}`,
    {},
    options.signal,
  )
  const reviews = expectEnvelope<unknown[]>(payload, 'reviews', Array.isArray)
  if (!reviews.every(isVoicePreviewReview)) {
    throw new ApiError('服务返回的声线试听验收历史格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: reviews,
    })
  }
  return reviews
}

export async function putCharacterVoiceProfile(
  episodeId: string,
  characterId: string,
  input: PutCharacterVoiceProfileInput,
  episodeEtag: string,
  options: RequestOptions = {},
): Promise<CharacterVoiceProfileMutationResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/characters/${encoded(characterId)}/voice-profile`,
    jsonRequestWithHeaders('PUT', input, { 'If-Match': episodeEtag }),
    options.signal,
  )
  const isVoiceProfileStale = (value: unknown): value is CharacterVoiceProfileMutationResponse['stale'] => (
    isRecord(value)
    && hasOnlyKeys(value, [
      'speechAssets',
      'exportAssets',
      'jobs',
      'dialogueLines',
      'exports',
      'qualityReports',
      'pipelineRuns',
    ])
    && Object.values(value).every(isNonNegativeInteger)
  )
  if (!isRecord(payload)
    || !hasOnlyKeys(payload, ['episode', 'character', 'voiceProfile', 'revisionId', 'stale'])
    || !isRecord(payload.episode)
    || !hasOnlyKeys(payload.episode, ['id', 'projectId', 'sourceRevisionId', 'updatedAt'])
    || !isString(payload.episode.id)
    || payload.episode.id !== episodeId
    || !isString(payload.episode.projectId)
    || payload.episode.projectId !== input.projectId
    || !isNullableString(payload.episode.sourceRevisionId)
    || !isString(payload.episode.updatedAt)
    || !Number.isFinite(Date.parse(payload.episode.updatedAt))
    || !isRecord(payload.character)
    || !hasOnlyKeys(payload.character, ['id', 'name', 'role'])
    || !isString(payload.character.id)
    || payload.character.id !== characterId
    || !isString(payload.character.name)
    || !isString(payload.character.role)
    || !isCharacterVoiceProfile(payload.voiceProfile)
    || !isString(payload.revisionId)
    || !payload.revisionId
    || !isVoiceProfileStale(payload.stale)) {
    throw new ApiError('服务返回的角色声线修订格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    episode: payload.episode as unknown as CharacterVoiceProfileMutationResponse['episode'],
    character: payload.character as unknown as CharacterVoiceProfileMutationResponse['character'],
    voiceProfile: payload.voiceProfile,
    revisionId: payload.revisionId,
    stale: payload.stale,
    etag: requiredOpaqueEtag(response, payload, '服务返回的角色声线修订 ETag 无效。'),
  }
}

export async function listGenerationJobs(
  options: ListGenerationJobsOptions = {},
): Promise<GenerationJob[]> {
  const params = new URLSearchParams()
  if (options.projectId) params.set('projectId', options.projectId)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.status) params.set('status', options.status)
  if (options.type) params.set('type', options.type)
  const query = params.size ? `?${params.toString()}` : ''
  const payload = await request<unknown>(`/api/v1/jobs${query}`, {}, options.signal)
  return expectEnvelope<GenerationJob[]>(
    payload,
    'jobs',
    (value): value is GenerationJob[] => Array.isArray(value) && value.every(isGenerationJob),
  )
}

export async function getGenerationJob(id: string, options: RequestOptions = {}): Promise<GenerationJob> {
  const payload = await request<unknown>(`/api/v1/jobs/${encoded(id)}`, {}, options.signal)
  return expectEnvelope<GenerationJob>(payload, 'job', isGenerationJob)
}

export async function retryGenerationJob(id: string, options: RequestOptions = {}): Promise<GenerationJob> {
  const payload = await request<unknown>(
    `/api/v1/jobs/${encoded(id)}/retry`,
    jsonRequest('POST'),
    options.signal,
  )
  return expectEnvelope<GenerationJob>(payload, 'job', isGenerationJob)
}

export async function cancelGenerationJob(id: string, options: RequestOptions = {}): Promise<GenerationJob> {
  const payload = await request<unknown>(
    `/api/v1/jobs/${encoded(id)}/cancel`,
    jsonRequest('POST'),
    options.signal,
  )
  return expectEnvelope<GenerationJob>(payload, 'job', isGenerationJob)
}

export async function listProjects(options: RequestOptions = {}): Promise<ProjectSummary[]> {
  const payload = await request<unknown>('/api/v1/projects', {}, options.signal)
  return expectEnvelope<ProjectSummary[]>(payload, 'projects', Array.isArray)
}

export async function createProject(
  input: { title: string; document?: Record<string, unknown> },
  options: RequestOptions = {},
): Promise<ProjectSnapshot> {
  const payload = await request<unknown>(
    '/api/v1/projects',
    jsonRequest('POST', input),
    options.signal,
  )
  if (!isRecord(payload) || !isRecord(payload.project) || !isRecord(payload.revision)
    || !isRecord(payload.document) || typeof payload.revision.id !== 'string') {
    throw new ApiError('服务返回的项目数据格式不正确。', { code: 'INVALID_RESPONSE', details: payload })
  }
  return {
    project: payload.project as unknown as ProjectSummary,
    revision: payload.revision as unknown as ProjectRevision,
    document: payload.document,
    etag: `W/"${payload.revision.id}"`,
  }
}

export async function getProjectSnapshot(
  projectId: string,
  options: RequestOptions = {},
): Promise<ProjectSnapshot> {
  const payload = await request<unknown>(`/api/v1/projects/${encoded(projectId)}`, {}, options.signal)
  if (!isRecord(payload) || !isRecord(payload.project) || !isRecord(payload.revision)
    || !isRecord(payload.document) || typeof payload.etag !== 'string') {
    throw new ApiError('服务返回的项目数据格式不正确。', { code: 'INVALID_RESPONSE', details: payload })
  }
  return payload as unknown as ProjectSnapshot
}

export async function updateProjectSnapshot(
  projectId: string,
  document: Record<string, unknown>,
  expectedEtag: string,
  options: RequestOptions & { summary?: string } = {},
): Promise<ProjectSnapshot> {
  const payload = await request<unknown>(
    `/api/v1/projects/${encoded(projectId)}`,
    jsonRequestWithHeaders('PATCH', {
      document,
      ...(options.summary ? { summary: options.summary } : {}),
    }, { 'If-Match': expectedEtag }),
    options.signal,
  )
  if (!isRecord(payload) || !isRecord(payload.project) || !isRecord(payload.revision)
    || !isRecord(payload.document) || typeof payload.etag !== 'string') {
    throw new ApiError('服务返回的项目知识库数据格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as ProjectSnapshot
}

export async function getProjectKnowledgeSnapshot(
  projectId: string,
  options: RequestOptions = {},
): Promise<ProjectKnowledgeSnapshot> {
  const payload = await request<unknown>(
    `/api/v1/projects/${encoded(projectId)}/knowledge`,
    {},
    options.signal,
  )
  if (!isRecord(payload)
    || !isRecord(payload.project)
    || (payload.revision !== null && !isRecord(payload.revision))
    || !isRecord(payload.document)
    || typeof payload.etag !== 'string'
    || payload.project.id !== projectId
    || (isRecord(payload.revision) && payload.revision.projectId !== projectId)) {
    throw new ApiError('服务返回的独立项目知识库数据格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as ProjectKnowledgeSnapshot
}

export async function updateProjectKnowledgeSnapshot(
  projectId: string,
  document: Record<string, unknown>,
  expectedEtag: string,
  options: RequestOptions & { summary?: string } = {},
): Promise<ProjectKnowledgeSnapshot> {
  const payload = await request<unknown>(
    `/api/v1/projects/${encoded(projectId)}/knowledge`,
    jsonRequestWithHeaders('PATCH', {
      document,
      ...(options.summary ? { summary: options.summary } : {}),
    }, { 'If-Match': expectedEtag }),
    options.signal,
  )
  if (!isRecord(payload)
    || !isRecord(payload.project)
    || !isRecord(payload.revision)
    || !isRecord(payload.document)
    || typeof payload.etag !== 'string'
    || payload.project.id !== projectId
    || payload.revision.projectId !== projectId) {
    throw new ApiError('服务返回的项目知识库保存结果不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as ProjectKnowledgeSnapshot
}

export async function importProjectSourceText(
  projectId: string,
  input: { fileName: string; content: string },
  expectedEtag: string,
  options: RequestOptions = {},
): Promise<ProjectKnowledgeSnapshot> {
  const payload = await request<unknown>(
    `/api/v1/projects/${encoded(projectId)}/import`,
    jsonRequestWithHeaders('POST', input, { 'If-Match': expectedEtag }),
    options.signal,
  )
  if (!isRecord(payload)
    || !isRecord(payload.project)
    || !isRecord(payload.revision)
    || !isRecord(payload.document)
    || typeof payload.etag !== 'string'
    || payload.project.id !== projectId
    || payload.revision.projectId !== projectId) {
    throw new ApiError('服务返回的项目原著导入结果不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as ProjectKnowledgeSnapshot
}

export async function listProjectKnowledgeRevisions(
  projectId: string,
  options: RequestOptions = {},
): Promise<ProjectRevision[]> {
  const payload = await request<unknown>(
    `/api/v1/projects/${encoded(projectId)}/knowledge/revisions`,
    {},
    options.signal,
  )
  const revisions = expectEnvelope<ProjectRevision[]>(
    payload,
    'revisions',
    (value): value is ProjectRevision[] => Array.isArray(value) && value.every(isProjectRevision),
  )
  if (revisions.some((revision) => revision.projectId !== projectId)) {
    throw new ApiError('服务返回的项目知识修订归属不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return revisions
}

export async function restoreProjectKnowledgeRevision(
  projectId: string,
  revisionId: string,
  expectedEtag: string,
  options: RequestOptions = {},
): Promise<ProjectKnowledgeSnapshot> {
  const payload = await request<unknown>(
    `/api/v1/projects/${encoded(projectId)}/knowledge/revisions/${encoded(revisionId)}/restore`,
    jsonRequestWithHeaders('POST', {}, { 'If-Match': expectedEtag }),
    options.signal,
  )
  if (!isRecord(payload)
    || !isRecord(payload.project)
    || !isRecord(payload.revision)
    || !isRecord(payload.document)
    || typeof payload.etag !== 'string'
    || payload.project.id !== projectId
    || payload.revision.projectId !== projectId) {
    throw new ApiError('服务返回的项目知识修订恢复结果不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as ProjectKnowledgeSnapshot
}

export async function listProjectEpisodes(
  projectId: string,
  options: RequestOptions = {},
): Promise<EpisodeSummary[]> {
  const payload = await request<unknown>(
    `/api/v1/projects/${encoded(projectId)}/episodes`,
    {},
    options.signal,
  )
  const episodes = expectEnvelope<EpisodeSummary[]>(payload, 'episodes', (value) => (
    Array.isArray(value) && value.every((episode) => (
      isRecord(episode)
      && typeof episode.id === 'string'
      && episode.projectId === projectId
      && typeof episode.title === 'string'
      && Number.isInteger(episode.sortOrder)
    ))
  ))
  return episodes
}

export async function createEpisode(
  projectId: string,
  input: CreateEpisodeInput,
  options: RequestOptions = {},
): Promise<{ episode: EpisodeSummary; revisionId: string | null; etag: string }> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/projects/${encoded(projectId)}/episodes`,
    jsonRequest('POST', input),
    options.signal,
  )
  if (!isRecord(payload) || !isRecord(payload.episode)
    || (payload.revisionId !== null && typeof payload.revisionId !== 'string')) {
    throw new ApiError('服务返回的分集数据格式不正确。', { code: 'INVALID_RESPONSE', details: payload })
  }
  return {
    episode: payload.episode as unknown as EpisodeSummary,
    revisionId: payload.revisionId as string | null,
    etag: requiredOpaqueEtag(response, payload, '服务返回的分集 ETag 无效。'),
  }
}

export async function getEpisode(
  episodeId: string,
  options: RequestOptions & { projectId?: string } = {},
): Promise<{ episode: EpisodeSummary; revisionId: string | null; etag: string }> {
  const params = new URLSearchParams()
  if (options.projectId) params.set('projectId', options.projectId)
  const query = params.size ? `?${params}` : ''
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}${query}`,
    {},
    options.signal,
  )
  if (!isRecord(payload) || !isRecord(payload.episode)
    || (payload.revisionId !== null && typeof payload.revisionId !== 'string')) {
    throw new ApiError('服务返回的分集数据格式不正确。', { code: 'INVALID_RESPONSE', details: payload })
  }
  return {
    episode: payload.episode as unknown as EpisodeSummary,
    revisionId: payload.revisionId as string | null,
    etag: requiredOpaqueEtag(response, payload, '服务返回的分集 ETag 无效。'),
  }
}

export async function updateEpisode(
  episodeId: string,
  input: Partial<Omit<CreateEpisodeInput, 'id'>> & { projectId?: string; summary?: string },
  etag: string,
  options: RequestOptions = {},
): Promise<{ episode: EpisodeSummary; revisionId: string | null; etag: string }> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}`,
    jsonRequestWithHeaders('PATCH', input, { 'If-Match': etag }),
    options.signal,
  )
  if (!isRecord(payload) || !isRecord(payload.episode)
    || (payload.revisionId !== null && typeof payload.revisionId !== 'string')) {
    throw new ApiError('服务返回的分集数据格式不正确。', { code: 'INVALID_RESPONSE', details: payload })
  }
  return {
    episode: payload.episode as unknown as EpisodeSummary,
    revisionId: payload.revisionId as string | null,
    etag: requiredOpaqueEtag(response, payload, '服务返回的分集 ETag 无效。'),
  }
}

export async function getStory(
  episodeId: string,
  options: RequestOptions & { projectId?: string } = {},
): Promise<{ episodeId: string; revisionId: string | null; story: StoryDocument; etag: string }> {
  const params = new URLSearchParams()
  if (options.projectId) params.set('projectId', options.projectId)
  const query = params.size ? `?${params}` : ''
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/story${query}`,
    {},
    options.signal,
  )
  if (!isRecord(payload) || typeof payload.episodeId !== 'string' || !isRecord(payload.story)
    || (payload.revisionId !== null && typeof payload.revisionId !== 'string')) {
    throw new ApiError('服务返回的剧本数据格式不正确。', { code: 'INVALID_RESPONSE', details: payload })
  }
  return {
    episodeId: payload.episodeId,
    revisionId: payload.revisionId as string | null,
    story: payload.story as unknown as StoryDocument,
    etag: requiredOpaqueEtag(response, payload, '服务返回的分集 ETag 无效。'),
  }
}

/** Search the current Episode Story projection; historical revisions are never queried. */
export async function searchStoryEntities(
  episodeId: string,
  options: SearchStoryEntitiesOptions,
): Promise<StoryEntitySearchResponse> {
  const params = new URLSearchParams({
    projectId: options.projectId,
    query: options.query,
  })
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/story/entities/search?${params}`,
    {},
    options.signal,
  )
  const normalizedQuery = options.query.trim().normalize('NFC')
  if (!isRecord(payload)
    || !hasExactlyKeys(payload, [
      'episodeId',
      'projectId',
      'sourceRevisionId',
      'query',
      'limit',
      'offset',
      'total',
      'hasMore',
      'results',
    ])
    || payload.episodeId !== episodeId
    || payload.projectId !== options.projectId
    || !isString(payload.sourceRevisionId)
    || !payload.sourceRevisionId
    || payload.query !== normalizedQuery
    || !Number.isInteger(payload.limit)
    || (payload.limit as number) < 1
    || !isNonNegativeInteger(payload.offset)
    || !isNonNegativeInteger(payload.total)
    || typeof payload.hasMore !== 'boolean'
    || !Array.isArray(payload.results)
    || !payload.results.every(isStoryEntitySearchResult)) {
    throw new ApiError('服务返回的剧本实体搜索结果格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }

  const limit = payload.limit as number
  const offset = payload.offset as number
  const total = payload.total as number
  const results = payload.results as StoryEntitySearchResult[]
  const expectedLimit = options.limit ?? 20
  const expectedOffset = options.offset ?? 0
  const locatorKeys = results.map((result) => (
    `${result.type}\u0000${result.sceneId ?? ''}\u0000${result.shotId ?? ''}\u0000${result.entityId}`
  ))
  if (
    limit !== expectedLimit
    || offset !== expectedOffset
    || limit > 100
    || offset > 10_000
    || results.length > limit
    || results.length > total
    || (results.length > 0 && offset + results.length > total)
    || results.some((result) => result.sourceRevisionId !== payload.sourceRevisionId)
    || new Set(locatorKeys).size !== locatorKeys.length
    || payload.hasMore !== (offset + results.length < total)
  ) {
    throw new ApiError('服务返回的剧本实体搜索结果与当前分集不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }

  return {
    episodeId,
    projectId: options.projectId,
    sourceRevisionId: payload.sourceRevisionId,
    query: normalizedQuery,
    limit,
    offset,
    total,
    hasMore: payload.hasMore,
    results,
    etag: requiredOpaqueEtag(response, payload, '服务返回的分集 ETag 无效。'),
  }
}

export async function generateStory(
  episodeId: string,
  input: { projectId: string; providerId?: string },
  etag: string,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<GenerationJob> {
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/story-generations`,
    jsonRequestWithHeaders('POST', input, {
      'If-Match': etag,
      'Idempotency-Key': idempotencyKey,
    }),
    options.signal,
  )
  return expectEnvelope<GenerationJob>(payload, 'job', isRecord)
}

export async function restoreStoryRevision(
  episodeId: string,
  revisionId: string,
  input: { projectId?: string; summary?: string },
  etag: string,
  options: RequestOptions = {},
): Promise<StoryMutationResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/story/revisions/${encoded(revisionId)}/restore`,
    jsonRequestWithHeaders('POST', input, { 'If-Match': etag }),
    options.signal,
  )
  const result = parseStoryMutationResponse(payload, response)
  if (result.episode.id !== episodeId) return invalidStoryMutation(payload)
  return result
}

export async function updateStoryScene(
  sceneId: string,
  input: UpdateStorySceneInput,
  etag: string,
  options: RequestOptions = {},
): Promise<StorySceneMutationResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/scenes/${encoded(sceneId)}`,
    jsonRequestWithHeaders('PATCH', input, { 'If-Match': etag }),
    options.signal,
  )
  const base = parseStoryMutationResponse(payload, response)
  if (!isRecord(payload) || !isStoryScene(payload.scene) || payload.scene.id !== sceneId) {
    return invalidStoryMutation(payload)
  }
  return { ...base, scene: payload.scene }
}

export async function createStoryShot(
  input: CreateStoryShotInput,
  etag: string,
  options: RequestOptions = {},
): Promise<CreateStoryShotResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    '/api/v1/shots',
    jsonRequestWithHeaders('POST', input, { 'If-Match': etag }),
    options.signal,
  )
  const base = parseStoryMutationResponse(payload, response)
  if (
    !isRecord(payload)
    || !isStoryScene(payload.scene)
    || payload.scene.id !== input.sceneId
    || !isStoryShot(payload.shot)
    || payload.shot.id !== input.shot.id
  ) {
    return invalidStoryMutation(payload)
  }
  return { ...base, scene: payload.scene, shot: payload.shot }
}

/** Reorders the complete shot list within one scene; cross-scene moves are unsupported. */
export async function reorderStoryShots(
  input: ReorderStoryShotsInput,
  etag: string,
  options: RequestOptions = {},
): Promise<StorySceneMutationResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    '/api/v1/shots/reorder',
    jsonRequestWithHeaders('POST', input, { 'If-Match': etag }),
    options.signal,
  )
  const base = parseStoryMutationResponse(payload, response)
  if (!isRecord(payload) || !isStoryScene(payload.scene) || payload.scene.id !== input.sceneId) {
    return invalidStoryMutation(payload)
  }
  return { ...base, scene: payload.scene }
}

export async function updateStoryShot(
  shotId: string,
  input: UpdateStoryShotInput,
  etag: string,
  options: RequestOptions = {},
): Promise<StoryShotMutationResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/shots/${encoded(shotId)}`,
    jsonRequestWithHeaders('PATCH', input, { 'If-Match': etag }),
    options.signal,
  )
  const base = parseStoryMutationResponse(payload, response)
  if (!isRecord(payload) || !isStoryShot(payload.shot) || payload.shot.id !== shotId) {
    return invalidStoryMutation(payload)
  }
  return { ...base, shot: payload.shot }
}

export async function deleteStoryShot(
  shotId: string,
  input: DeleteStoryShotInput,
  etag: string,
  options: RequestOptions = {},
): Promise<DeleteStoryShotResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/shots/${encoded(shotId)}`,
    jsonRequestWithHeaders('DELETE', input, { 'If-Match': etag }),
    options.signal,
  )
  const base = parseStoryMutationResponse(payload, response)
  if (
    !isRecord(payload)
    || payload.deletedShotId !== shotId
    || (payload.scene !== undefined && !isStoryScene(payload.scene))
    || (input.sceneId !== undefined && (!isStoryScene(payload.scene) || payload.scene.id !== input.sceneId))
  ) {
    return invalidStoryMutation(payload)
  }
  return {
    ...base,
    deletedShotId: shotId,
    ...(isStoryScene(payload.scene) ? { scene: payload.scene } : {}),
  }
}

/** Reads the immutable candidates, current adopted Asset and audit history for one shot. */
export async function getShotMediaReview(
  shotId: string,
  input: ListShotMediaReviewInput,
  options: RequestOptions = {},
): Promise<ShotMediaReviewSnapshot> {
  const params = new URLSearchParams({
    projectId: input.projectId,
    episodeId: input.episodeId,
    mediaType: input.mediaType,
  })
  if (input.sceneId !== undefined) params.set('sceneId', input.sceneId)
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  if (input.offset !== undefined) params.set('offset', String(input.offset))
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/shots/${encoded(shotId)}/media-review?${params}`,
    {},
    options.signal,
  )
  return parseShotMediaReviewSnapshot(payload, response, shotId, input)
}

/**
 * Persists one authoritative local selection plus its immutable human audit.
 * It never invokes an AIGC Provider and deliberately has no paid-confirmation header.
 */
export async function decideShotMediaReview(
  shotId: string,
  input: DecideShotMediaInput,
  episodeEtag: string,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<ShotMediaDecisionResult> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/shots/${encoded(shotId)}/media-review`,
    jsonRequestWithHeaders('POST', input, {
      'If-Match': episodeEtag,
      'Idempotency-Key': idempotencyKey,
    }),
    options.signal,
  )
  return parseShotMediaDecisionResult(payload, response, shotId, input)
}

/**
 * Creates or idempotently replays a server-pinned Seedance shot job. The route
 * intentionally has no If-Match header: its durable binding captures the
 * exact Story revision and previous video asset used for compare-and-swap.
 */
export async function createShotVideoGenerationJob(
  shotId: string,
  input: CreateShotVideoGenerationJobInput,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<ShotVideoGenerationJob> {
  const audioPolicy = requestedShotVideoAudioPolicy(input)
  const submissionKey = shotVideoIdempotencyKey(idempotencyKey)
  const payload = await request<unknown>(
    `/api/v1/shots/${encoded(shotId)}/video-generations`,
    jsonRequestWithHeaders('POST', input, { 'Idempotency-Key': submissionKey }),
    options.signal,
  )
  const job = expectEnvelope<ShotVideoGenerationJob>(
    payload,
    'job',
    isShotVideoGenerationJob,
  )
  if (
    job.projectId !== input.projectId
    || job.episodeId !== input.episodeId
    || job.resourceId !== shotId
    || job.idempotencyKey !== submissionKey
    || job.input.binding.episodeId !== input.episodeId
    || job.input.binding.shotId !== shotId
    || (input.sceneId !== undefined && job.input.binding.sceneId !== input.sceneId)
    || job.input.resolution !== (input.resolution ?? '720p')
    || (input.durationSeconds !== undefined
      && job.input.durationSeconds !== input.durationSeconds)
    || job.input.generateAudio !== requestedShotVideoGenerateAudio(input)
    || (job.input.spec !== undefined && job.input.spec.audioPolicy !== audioPolicy)
    || (input.providerId !== undefined && job.providerId !== input.providerId)
  ) {
    return invalidShotVideoResponse(payload)
  }
  return job
}

/**
 * Closes an unknown, non-idempotent Seedance submission only after an explicit
 * provider-console check. This writes audit state; it never calls the video
 * provider and never creates a billable task.
 */
export async function resolveShotVideoUnknownSubmission(
  jobId: string,
  input: ResolveShotVideoUnknownSubmissionInput,
  options: RequestOptions = {},
): Promise<ResolveShotVideoUnknownSubmissionResponse> {
  const payload = await request<unknown>(
    `/api/v1/jobs/${encoded(jobId)}/shot-video-unknown-submission-resolution`,
    jsonRequest('POST', input),
    options.signal,
  )
  if (!isRecord(payload)
    || !hasOnlyKeys(payload, ['resolution', 'idempotent', 'job'])
    || !isShotVideoUnknownSubmissionResolution(payload.resolution)
    || typeof payload.idempotent !== 'boolean'
    || !isShotVideoGenerationJob(payload.job)
    || payload.resolution.jobId !== jobId
    || payload.resolution.projectId !== input.projectId
    || payload.resolution.resolution !== input.resolution
    || payload.resolution.confirmedProviderConsoleChecked
      !== input.confirmedProviderConsoleChecked
    || payload.resolution.note !== input.note.trim()
    || payload.job.id !== jobId
    || payload.job.projectId !== input.projectId) {
    return invalidShotVideoResponse(payload)
  }
  return payload as unknown as ResolveShotVideoUnknownSubmissionResponse
}

/**
 * Starts one explicitly requested, non-billable multimodal reference analysis.
 * The returned durable Job is the only value a later Seedance preflight may
 * name; raw model-authored reference lists are never sent back by the client.
 */
export async function createShotVideoVisualReferenceAnalysis(
  episodeId: string,
  input: CreateShotVideoVisualReferenceAnalysisInput,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<ShotVideoVisualReferenceAnalysisJob> {
  if (input.selections.length !== 1) {
    throw new ApiError('单镜视觉分析只能选择一个镜头；多镜请使用批量分析队列。', {
      code: 'INVALID_VISUAL_ANALYSIS_SCOPE',
    })
  }
  const submissionKey = shotVideoIdempotencyKey(idempotencyKey)
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/video-reference-analyses`,
    jsonRequestWithHeaders('POST', input, { 'Idempotency-Key': submissionKey }),
    options.signal,
  )
  const job = expectEnvelope<ShotVideoVisualReferenceAnalysisJob>(
    payload,
    'job',
    isShotVideoVisualReferenceAnalysisJob,
  )
  if (job.projectId !== input.projectId
    || job.episodeId !== episodeId
    || job.resourceId !== episodeId
    || job.idempotencyKey !== submissionKey
    || job.input.episodeId !== episodeId
    || job.input.selectors.length !== input.selections.length
    || job.input.selectors.some((selector, index) => (
      selector.shotId !== input.selections[index]?.shotId
      || selector.sceneId !== input.selections[index]?.sceneId
    ))
    || (input.textProviderId !== undefined && job.providerId !== input.textProviderId)) {
    return invalidShotVideoResponse(payload)
  }
  return job
}

/**
 * Atomically admits a multi-shot batch as independent durable child Jobs.
 * Each child performs exactly one multimodal request and can recover/fail
 * without erasing the results of neighboring shots.
 */
export async function createShotVideoVisualReferenceAnalysisBatch(
  episodeId: string,
  input: CreateShotVideoVisualReferenceAnalysisInput,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<ShotVideoVisualReferenceAnalysisBatchResponse> {
  if (input.selections.length < 2 || input.selections.length > 24) {
    throw new ApiError('批量视觉分析必须选择 2–24 个镜头。', {
      code: 'INVALID_VISUAL_ANALYSIS_SCOPE',
    })
  }
  if (input.selections.some((selection) => !selection.sceneId)) {
    throw new ApiError('批量视觉分析必须使用 sceneId + shotId 的精确镜头范围。', {
      code: 'INVALID_VISUAL_ANALYSIS_SCOPE',
    })
  }
  const submissionKey = shotVideoIdempotencyKey(idempotencyKey)
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/video-reference-analyses`,
    jsonRequestWithHeaders('POST', input, { 'Idempotency-Key': submissionKey }),
    options.signal,
  )
  if (!isShotVideoVisualReferenceAnalysisBatchResponse(payload)) {
    return invalidShotVideoResponse(payload)
  }
  if (payload.batch.projectId !== input.projectId
    || payload.batch.episodeId !== episodeId
    || payload.jobs.length !== input.selections.length
    || payload.jobs.some((job, index) => {
      const selector = job.input.selectors[0]
      return selector?.shotId !== input.selections[index]?.shotId
        || selector.sceneId !== input.selections[index]?.sceneId
        || (input.textProviderId !== undefined && job.providerId !== input.textProviderId)
    })) {
    return invalidShotVideoResponse(payload)
  }
  return payload
}

export interface ShotVideoVisualReferenceAnalysisHydrationScope {
  projectId: string
  sourceRevisionId: string
  textProviderId: string
}

/** Rehydrates exact per-shot Jobs with server-revalidated current authority. */
export async function listShotVideoVisualReferenceAnalyses(
  episodeId: string,
  scope: ShotVideoVisualReferenceAnalysisHydrationScope,
  options: RequestOptions = {},
): Promise<ShotVideoVisualReferenceAnalysisBinding[]> {
  const query = new URLSearchParams({
    projectId: scope.projectId,
    sourceRevisionId: scope.sourceRevisionId,
    textProviderId: scope.textProviderId,
  })
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/video-reference-analyses?${query.toString()}`,
    {},
    options.signal,
  )
  if (!isRecord(payload)
    || !hasOnlyKeys(payload, ['analyses'])
    || !Array.isArray(payload.analyses)
    || !payload.analyses.every(isShotVideoVisualReferenceAnalysisBinding)) {
    return invalidShotVideoResponse(payload)
  }
  const bindings = payload.analyses as ShotVideoVisualReferenceAnalysisBinding[]
  if (bindings.some((binding) => (
    binding.job.projectId !== scope.projectId
    || binding.job.episodeId !== episodeId
    || binding.job.providerId !== scope.textProviderId
    || binding.job.input.expectedStoryRevisionId !== scope.sourceRevisionId
  ))) return invalidShotVideoResponse(payload)
  return bindings
}

/** Reads a restart-safe aggregate derived entirely from its durable children. */
export async function getShotVideoVisualReferenceAnalysisBatch(
  episodeId: string,
  batchId: string,
  scope: ShotVideoVisualReferenceAnalysisHydrationScope,
  options: RequestOptions = {},
): Promise<ShotVideoVisualReferenceAnalysisBatchResponse> {
  const query = new URLSearchParams({
    projectId: scope.projectId,
    sourceRevisionId: scope.sourceRevisionId,
    textProviderId: scope.textProviderId,
  })
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/video-reference-analysis-batches/${encoded(batchId)}?${query.toString()}`,
    {},
    options.signal,
  )
  if (!isShotVideoVisualReferenceAnalysisBatchResponse(payload)
    || payload.batch.id !== batchId
    || payload.batch.projectId !== scope.projectId
    || payload.batch.episodeId !== episodeId
    || payload.batch.sourceRevisionId !== scope.sourceRevisionId
    || payload.batch.providerId !== scope.textProviderId) {
    return invalidShotVideoResponse(payload)
  }
  return payload
}

/** Strictly reads the persisted multimodal result; generic Job JSON is not trusted by this UI path. */
export async function getShotVideoVisualReferenceAnalysisJob(
  jobId: string,
  options: RequestOptions = {},
): Promise<ShotVideoVisualReferenceAnalysisJob> {
  const payload = await request<unknown>(`/api/v1/jobs/${encoded(jobId)}`, {}, options.signal)
  const job = expectEnvelope<ShotVideoVisualReferenceAnalysisJob>(
    payload,
    'job',
    isShotVideoVisualReferenceAnalysisJob,
  )
  if (job.id !== jobId) return invalidShotVideoResponse(payload)
  return job
}

/** Reads the server-authoritative, non-billable three-view decision for one shot. */
export async function getShotVideoReferenceRecommendation(
  shotId: string,
  input: { projectId: string; episodeId: string; sceneId?: string },
  options: RequestOptions = {},
): Promise<ShotVideoReferenceRecommendation> {
  const params = new URLSearchParams({
    projectId: input.projectId,
    episodeId: input.episodeId,
  })
  if (input.sceneId) params.set('sceneId', input.sceneId)
  const payload = await request<unknown>(
    `/api/v1/shots/${encoded(shotId)}/video-reference-recommendation?${params.toString()}`,
    {},
    options.signal,
  )
  if (!isRecord(payload)
    || !hasOnlyKeys(payload, ['recommendation'])
    || !isShotVideoReferenceRecommendation(payload.recommendation)
    || payload.recommendation.shotId !== shotId
    || payload.recommendation.sourceRevisionId.length === 0
    || (input.sceneId !== undefined && payload.recommendation.sceneId !== input.sceneId)) {
    return invalidShotVideoResponse(payload)
  }
  return payload.recommendation
}

/** Reads an authoritative, non-billable Seedance batch scope. */
export async function preflightShotVideoBatch(
  episodeId: string,
  input: ShotVideoBatchPreflightInput,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<ShotVideoBatchPreflight> {
  assertShotVideoBatchReferenceAnalysisInput(input)
  const rootKey = shotVideoIdempotencyKey(idempotencyKey)
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/video-generations/preflight`,
    jsonRequestWithHeaders('POST', input, { 'Idempotency-Key': rootKey }),
    options.signal,
  )
  if (!isRecord(payload)
    || !hasOnlyKeys(payload, ['preflight'])
    || !isShotVideoBatchPreflight(payload.preflight)) {
    return invalidShotVideoResponse(payload)
  }
  const preflight = payload.preflight
  const resolution = input.resolution ?? '720p'
  const promptCompilerVersion = input.promptCompilerVersion ?? 'seedance-compact-v1'
  const audioPolicy = requestedShotVideoAudioPolicy(input)
  const publicationMode = requestedShotVideoPublicationMode(input)
  if (preflight.projectId !== input.projectId
    || preflight.episodeId !== episodeId
    || preflight.resolution !== resolution
    || preflight.publicationMode !== publicationMode
    || preflight.audioPolicy !== audioPolicy
    || preflight.generateAudio !== requestedShotVideoGenerateAudio(input)
    || preflight.billableTaskCount !== input.selections.length
    || preflight.targets.some((target) => target.promptCompilerVersion !== promptCompilerVersion)
    || (input.providerId !== undefined && preflight.provider.providerId !== input.providerId)) {
    return invalidShotVideoResponse(payload)
  }
  for (const [index, selection] of input.selections.entries()) {
    const target = preflight.targets[index]
    if (!target
      || target.shotId !== selection.shotId
      || (selection.sceneId !== undefined && target.sceneId !== selection.sceneId)
      || (selection.durationSeconds !== undefined && target.durationSeconds !== selection.durationSeconds)) {
      return invalidShotVideoResponse(payload)
    }
    if (selection.characterReferenceSelections) {
      const pins = target.referenceDecision.manualCharacterSlotPins
      if (target.referenceDecision.source !== 'manual_override'
        || pins?.length !== selection.characterReferenceSelections.length
        || selection.characterReferenceSelections.some((selector, selectorIndex) => (
          pins[selectorIndex]?.characterId !== selector.characterId
          || pins[selectorIndex]?.view !== selector.view
        ))) return invalidShotVideoResponse(payload)
    } else if (selection.references === undefined) {
      if (target.referenceDecision.source !== 'agentic_auto') return invalidShotVideoResponse(payload)
      const expectedReferenceAnalysisJobId = selection.referenceAnalysisJobId
        ?? input.referenceAnalysisJobId
      if (expectedReferenceAnalysisJobId !== undefined
        && (target.referenceDecision.automaticPolicy !== 'persisted_vision'
          || target.referenceDecision.visionAnalysisJobId !== expectedReferenceAnalysisJobId)) {
        return invalidShotVideoResponse(payload)
      }
      if (expectedReferenceAnalysisJobId === undefined
        && target.referenceDecision.visionAnalysisJobId !== undefined) {
        return invalidShotVideoResponse(payload)
      }
    } else if (target.referenceDecision.source !== 'manual_override'
      || target.references.length !== selection.references.length
      || target.references.some((reference, referenceIndex) => (
        reference.assetId !== selection.references?.[referenceIndex]?.assetId
        || reference.role !== selection.references?.[referenceIndex]?.role
      ))) return invalidShotVideoResponse(payload)
  }
  return preflight
}

/**
 * Creates an idempotent set of durable shot jobs only after a matching signed
 * preflight. Each returned child keeps the ordinary cancel/retry contract.
 */
export async function createShotVideoBatch(
  episodeId: string,
  input: CreateShotVideoBatchInput,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<ShotVideoGenerationJob[]> {
  assertShotVideoBatchReferenceAnalysisInput(input)
  const audioPolicy = requestedShotVideoAudioPolicy(input)
  const publicationMode = requestedShotVideoPublicationMode(input)
  const promptCompilerVersion = input.promptCompilerVersion ?? 'seedance-compact-v1'
  const rootKey = shotVideoIdempotencyKey(idempotencyKey)
  if (!shotVideoBatchConfirmationPattern.test(input.confirmationToken)) {
    throw new ApiError('Seedance 批量确认令牌格式无效。', {
      status: 400,
      code: 'INVALID_VIDEO_BATCH_CONFIRMATION',
    })
  }
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/video-generations`,
    jsonRequestWithHeaders('POST', input, { 'Idempotency-Key': rootKey }),
    options.signal,
  )
  if (!isRecord(payload)
    || !hasOnlyKeys(payload, ['jobs'])
    || !Array.isArray(payload.jobs)
    || payload.jobs.length !== input.selections.length
    || !payload.jobs.every(isShotVideoGenerationJob)) {
    return invalidShotVideoResponse(payload)
  }
  const jobs = payload.jobs as ShotVideoGenerationJob[]
  const fingerprints = new Set<string>()
  for (const [index, job] of jobs.entries()) {
    const selection = input.selections[index]
    if (!selection
      || job.projectId !== input.projectId
      || job.episodeId !== episodeId
      || job.resourceId !== selection.shotId
      || job.input.binding.shotId !== selection.shotId
      || (selection.sceneId !== undefined && job.input.binding.sceneId !== selection.sceneId)
      || job.input.resolution !== (input.resolution ?? '720p')
      || (selection.durationSeconds !== undefined
        && job.input.durationSeconds !== selection.durationSeconds)
      || job.input.generateAudio !== requestedShotVideoGenerateAudio(input)
      || (job.input.spec !== undefined && job.input.spec.audioPolicy !== audioPolicy)
      || (job.input.spec !== undefined
        && job.input.spec.promptCompilerVersion !== promptCompilerVersion)
      || (publicationMode === 'evaluation_only'
        ? job.input.publicationMode !== 'evaluation_only'
        : job.input.publicationMode !== undefined)
      || (input.providerId !== undefined && job.providerId !== input.providerId)
      || !job.input.batch
      || job.input.batch.version !== 1
      || job.input.batch.selectionIndex !== index
      || job.input.batch.selectionCount !== jobs.length) {
      return invalidShotVideoResponse(payload)
    }
    if (selection.characterReferenceSelections) {
      const pins = job.input.referenceDecision?.manualCharacterSlotPins
      if (job.input.referenceDecision?.source !== 'manual_override'
        || pins?.length !== selection.characterReferenceSelections.length
        || selection.characterReferenceSelections.some((selector, selectorIndex) => (
          pins[selectorIndex]?.characterId !== selector.characterId
          || pins[selectorIndex]?.view !== selector.view
        ))) return invalidShotVideoResponse(payload)
    } else if (selection.references === undefined) {
      if (job.input.referenceDecision?.source !== 'agentic_auto') return invalidShotVideoResponse(payload)
      const expectedReferenceAnalysisJobId = selection.referenceAnalysisJobId
        ?? input.referenceAnalysisJobId
      if (expectedReferenceAnalysisJobId !== undefined
        && (job.input.referenceDecision.automaticPolicy !== 'persisted_vision'
          || job.input.referenceDecision.visionAnalysisJobId !== expectedReferenceAnalysisJobId)) {
        return invalidShotVideoResponse(payload)
      }
      if (expectedReferenceAnalysisJobId === undefined
        && job.input.referenceDecision.visionAnalysisJobId !== undefined) {
        return invalidShotVideoResponse(payload)
      }
    } else if (job.input.referenceDecision?.source !== 'manual_override'
      || (job.input.references ?? []).length !== selection.references.length
      || (job.input.references ?? []).some((reference, referenceIndex) => (
        reference.assetId !== selection.references?.[referenceIndex]?.assetId
        || reference.role !== selection.references?.[referenceIndex]?.role
      ))) return invalidShotVideoResponse(payload)
    fingerprints.add(job.input.batch.requestFingerprint)
  }
  if (fingerprints.size !== 1) return invalidShotVideoResponse(payload)
  return jobs
}

export async function getDialoguePerformanceProfile(
  lineId: string,
  projectId: string,
  episodeId: string,
  options: RequestOptions = {},
): Promise<DialoguePerformanceProfileResponse> {
  const params = new URLSearchParams({ projectId, episodeId })
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/dialogue-lines/${encoded(lineId)}/performance-profile?${params.toString()}`,
    {},
    options.signal,
  )
  const etag = requiredOpaqueEtag(response, payload, '服务返回的逐句表演 ETag 无效。')
  return parseDialoguePerformanceProfileResponse(
    payload,
    lineId,
    projectId,
    episodeId,
    etag,
  )
}

export async function createDialoguePerformanceRecommendation(
  lineId: string,
  input: { projectId: string; episodeId: string; textProviderId?: string },
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<DialoguePerformanceRecommendationJob> {
  const payload = await request<unknown>(
    `/api/v1/dialogue-lines/${encoded(lineId)}/performance-recommendations`,
    jsonRequestWithHeaders('POST', input, {
      'Idempotency-Key': idempotencyKey,
    }),
    options.signal,
  )
  const job = asDialoguePerformanceRecommendationJob(
    expectEnvelope(payload, 'job', isRecord),
    lineId,
  )
  if (job.projectId !== input.projectId || job.episodeId !== input.episodeId) {
    throw new ApiError('服务返回的逐句 AI 表演任务与请求范围不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return job
}

export async function getDialoguePerformanceRecommendationJob(
  jobId: string,
  lineId: string,
  options: RequestOptions = {},
): Promise<DialoguePerformanceRecommendationJob> {
  const payload = await request<unknown>(
    `/api/v1/jobs/${encoded(jobId)}`,
    {},
    options.signal,
  )
  return asDialoguePerformanceRecommendationJob(
    expectEnvelope(payload, 'job', isRecord),
    lineId,
  )
}

export async function putDialoguePerformanceProfile(
  lineId: string,
  input: { projectId: string; episodeId: string; recommendationJobId: string; etag: string },
  options: RequestOptions = {},
): Promise<DialoguePerformanceProfileResponse> {
  const { etag: expectedEtag, ...body } = input
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/dialogue-lines/${encoded(lineId)}/performance-profile`,
    jsonRequestWithHeaders('PUT', body, { 'If-Match': expectedEtag }),
    options.signal,
  )
  const etag = requiredOpaqueEtag(response, payload, '服务返回的逐句表演 ETag 无效。')
  const parsed = parseDialoguePerformanceProfileResponse(
    payload,
    lineId,
    input.projectId,
    input.episodeId,
    etag,
  )
  const profile = parsed.profile
  if (!profile || profile.recommendationJobId !== input.recommendationJobId) {
    throw new ApiError('服务未返回本次确认的逐句表演档案。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return parsed
}

export async function deleteDialoguePerformanceProfile(
  lineId: string,
  input: { projectId: string; episodeId: string; etag: string },
  options: RequestOptions = {},
): Promise<DialoguePerformanceProfileResponse> {
  const { etag: expectedEtag, ...body } = input
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/dialogue-lines/${encoded(lineId)}/performance-profile`,
    jsonRequestWithHeaders('DELETE', body, { 'If-Match': expectedEtag }),
    options.signal,
  )
  const etag = requiredOpaqueEtag(response, payload, '服务返回的逐句表演 ETag 无效。')
  const parsed = parseDialoguePerformanceProfileResponse(
    payload,
    lineId,
    input.projectId,
    input.episodeId,
    etag,
  )
  const profile = parsed.profile
  if (profile !== null) {
    throw new ApiError('服务未撤销逐句表演档案。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return parsed
}

export async function preflightDialogueSpeechGenerationJob(
  lineId: string,
  input: CreateDialogueSpeechJobInput,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<PublicPaidAigcConfirmation> {
  try {
    await request<unknown>(
      `/api/v1/dialogue-lines/${encoded(lineId)}/speech-generations`,
      jsonRequestWithHeaders('POST', input, { 'Idempotency-Key': idempotencyKey }),
      options.signal,
    )
  } catch (error) {
    if (!(error instanceof ApiError)
      || error.status !== 409
      || error.code !== 'PAID_CONFIRMATION_REQUIRED') {
      throw error
    }
    if (!isRecord(error.details)
      || !hasExactlyKeys(error.details, ['confirmation'])) {
      return invalidPaidAigcConfirmation(error.details)
    }
    return parsePublicPaidAigcConfirmation(
      error.details.confirmation,
      'dialogue.speech.generate',
    )
  }
  throw new ApiError('语音合成预检未返回必要的计费确认。', {
    code: 'INVALID_RESPONSE',
  })
}

export async function createDialogueSpeechGenerationJob(
  lineId: string,
  input: CreateDialogueSpeechJobInput,
  idempotencyKey: string,
  confirmationToken: string,
  options: RequestOptions = {},
): Promise<DialogueSpeechGenerationJob> {
  const payload = await request<unknown>(
    `/api/v1/dialogue-lines/${encoded(lineId)}/speech-generations`,
    jsonRequestWithHeaders('POST', input, {
      'Idempotency-Key': idempotencyKey,
      'x-manju-aigc-confirmation': paidAigcConfirmationToken(confirmationToken),
    }),
    options.signal,
  )
  const job = expectEnvelope<DialogueSpeechGenerationJob>(
    payload,
    'job',
    isDialogueSpeechGenerationJob,
  )
  if (
    job.projectId !== input.projectId
    || job.episodeId !== input.episodeId
    || job.input.lineId !== lineId
    || (job.output && job.output.dialogueLineId !== lineId)
  ) {
    throw new ApiError('服务返回的语音任务与请求目标不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return job
}

function isTimelineDocumentRecord(value: unknown): value is TimelineDocumentRecord {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'id', 'projectId', 'episodeId', 'currentRevisionId', 'schemaVersion',
      'upstreamCommit', 'sourceRevisionId', 'createdAt', 'updatedAt',
    ])
    && isPipelineString(value.id)
    && isPipelineString(value.projectId)
    && isPipelineString(value.episodeId)
    && isPipelineString(value.currentRevisionId)
    && Number.isSafeInteger(value.schemaVersion)
    && (value.schemaVersion as number) > 0
    && isString(value.upstreamCommit)
    && /^[0-9a-f]{40}$/i.test(value.upstreamCommit)
    && isNullableString(value.sourceRevisionId)
    && isString(value.createdAt)
    && isString(value.updatedAt)
    && Number.isFinite(Date.parse(value.createdAt))
    && Number.isFinite(Date.parse(value.updatedAt))
}

function isTimelineDocumentRevision(value: unknown): value is TimelineDocumentRevision {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'id', 'documentId', 'projectId', 'episodeId', 'parentRevisionId',
      'schemaVersion', 'upstreamCommit', 'sourceRevisionId', 'summary',
      'snapshot', 'createdAt',
    ])
    && isPipelineString(value.id)
    && isPipelineString(value.documentId)
    && isPipelineString(value.projectId)
    && isPipelineString(value.episodeId)
    && isNullableString(value.parentRevisionId)
    && Number.isSafeInteger(value.schemaVersion)
    && (value.schemaVersion as number) > 0
    && isString(value.upstreamCommit)
    && /^[0-9a-f]{40}$/i.test(value.upstreamCommit)
    && isNullableString(value.sourceRevisionId)
    && isString(value.summary)
    && value.summary.length <= 500
    && isRecord(value.snapshot)
    && isString(value.createdAt)
    && Number.isFinite(Date.parse(value.createdAt))
}

function timelineSnapshotFromResponse(
  value: unknown,
  response: Response,
  payload: unknown,
  options: { authoritative?: boolean; episodeId?: string } = {},
): TimelineDocumentSnapshot | null {
  if (!isRecord(value)
    || !hasExactlyKeys(
      value,
      ['timelineDocument', 'revision', 'document', 'etag'],
      ['created', 'report'],
    )
    || !isTimelineDocumentRecord(value.timelineDocument)
    || !isTimelineDocumentRevision(value.revision)
    || !isRecord(value.document)
    || !isString(value.etag)) return null
  const timelineDocument = value.timelineDocument
  const revision = value.revision
  const expectedEtag = `W/"${revision.id}"`
  if (timelineDocument.currentRevisionId !== revision.id
    || revision.documentId !== timelineDocument.id
    || revision.projectId !== timelineDocument.projectId
    || revision.episodeId !== timelineDocument.episodeId
    || revision.schemaVersion !== timelineDocument.schemaVersion
    || revision.upstreamCommit !== timelineDocument.upstreamCommit
    || revision.sourceRevisionId !== timelineDocument.sourceRevisionId
    || value.etag !== expectedEtag
    || JSON.stringify(revision.snapshot) !== JSON.stringify(value.document)
    || (options.episodeId !== undefined && timelineDocument.episodeId !== options.episodeId)) {
    return null
  }
  if (options.authoritative !== false) {
    const headerEtag = response.headers.get('ETag')?.trim()
    if (headerEtag !== expectedEtag) return null
  }
  return value as unknown as TimelineDocumentSnapshot
}

function invalidTimelineResponse(payload: unknown): never {
  throw new ApiError('服务返回的时间线数据无法安全验证。', {
    code: 'INVALID_RESPONSE',
    details: payload,
  })
}

/**
 * Ordinary timeline writes cannot carry server authority. Mirror the one
 * intentional response-side normalization so strict equality still detects
 * every unrelated mutation while accepting removal of the reserved receipt
 * projection.
 */
function ordinaryTimelineDocumentProjection(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const expected = structuredClone(document)
  if (!isRecord(expected.manjuTimeline)) return expected
  const integration = { ...expected.manjuTimeline }
  delete integration.mediaAuthorityFingerprint
  if (Object.keys(integration).length > 0) expected.manjuTimeline = integration
  else delete expected.manjuTimeline
  return expected
}

export async function getTimelineDocument(
  episodeId: string,
  options: RequestOptions = {},
): Promise<TimelineDocumentSnapshot> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/timeline-document`,
    {},
    options.signal,
  )
  return timelineSnapshotFromResponse(payload, response, payload, { episodeId })
    ?? invalidTimelineResponse(payload)
}

export async function saveTimelineDocument(
  episodeId: string,
  input: SaveTimelineDocumentInput,
  etag: string | '*',
  options: RequestOptions = {},
): Promise<TimelineDocumentSnapshot> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/timeline-document`,
    jsonRequestWithHeaders('PUT', input, { 'If-Match': etag }),
    options.signal,
  )
  const snapshot = timelineSnapshotFromResponse(payload, response, payload, { episodeId })
  if (!snapshot
    || snapshot.timelineDocument.projectId !== input.projectId
    || snapshot.timelineDocument.schemaVersion !== input.schemaVersion
    || snapshot.timelineDocument.upstreamCommit !== input.upstreamCommit.toLowerCase()
    || JSON.stringify(snapshot.document)
      !== JSON.stringify(ordinaryTimelineDocumentProjection(input.document))) {
    return invalidTimelineResponse(payload)
  }
  return snapshot
}

function isOpenCutTimingSnapshot(value: unknown): boolean {
  return isRecord(value)
    && ['startTime', 'duration', 'trimStart', 'trimEnd'].every((key) => (
      Number.isSafeInteger(value[key]) && (value[key] as number) >= 0
    ))
    && (value.duration as number) > 0
}

function isTimelineAutoEditOperation(value: unknown): boolean {
  return isRecord(value)
    && value.kind === 'update-element-timing'
    && isPipelineString(value.trackId)
    && isPipelineString(value.elementId)
    && isPipelineString(value.reason)
    && isOpenCutTimingSnapshot(value.before)
    && isOpenCutTimingSnapshot(value.after)
}

function isTimelineAutoEditDiagnostic(value: unknown): value is TimelineAutoEditDiagnostic {
  return isRecord(value)
    && isPipelineString(value.code)
    && (value.severity === 'info' || value.severity === 'warning' || value.severity === 'error')
    && isPipelineString(value.message)
    && isUniqueIdList(value.elementIds)
}

function isTimelineAutoEditRisk(value: unknown): value is 'safe' | 'blocked' {
  return value === 'safe' || value === 'blocked'
}

function isTimelineAutoEditPlan(
  value: unknown,
  requireConfirmationToken: boolean,
): value is TimelineAutoEditPlan {
  return isRecord(value)
    && isPipelineString(value.id)
    && isPipelineString(value.projectId)
    && isPipelineString(value.episodeId)
    && isPipelineString(value.documentId)
    && isPipelineString(value.baseRevisionId)
    && (value.sourceRevisionId === null || isPipelineString(value.sourceRevisionId))
    && value.goal === 'exportable'
    && value.policy === 'safe'
    && value.strategy === 'managed-dialogue-reflow-v1'
    && value.executor === 'OpenCut-Classic/UpdateElementsCommand'
    && isString(value.upstreamCommit)
    && /^[0-9a-f]{40}$/i.test(value.upstreamCommit)
    && Number.isSafeInteger(value.schemaVersion)
    && (value.schemaVersion as number) > 0
    && isString(value.planHash)
    && /^[0-9a-f]{64}$/.test(value.planHash)
    && isTimelineAutoEditRisk(value.risk)
    && Array.isArray(value.diagnostics)
    && value.diagnostics.every(isTimelineAutoEditDiagnostic)
    && ((value.risk === 'blocked') === value.diagnostics.some((diagnostic) => (
      diagnostic.severity === 'error'
    )))
    && validateAutoEditOperations(value.operations, value.changedElementIds)
    && isString(value.createdAt)
    && (!requireConfirmationToken || isPipelineString(value.confirmationToken))
    && (requireConfirmationToken || value.confirmationToken === undefined)
}

function isTimelineEditApplication(value: unknown): value is TimelineEditApplication {
  return isRecord(value)
    && isPipelineString(value.id)
    && isPipelineString(value.planId)
    && isPipelineString(value.documentId)
    && isPipelineString(value.projectId)
    && isPipelineString(value.episodeId)
    && isPipelineString(value.baseRevisionId)
    && isPipelineString(value.resultRevisionId)
    && isString(value.createdAt)
}

function isTimelineEditUndoRecord(value: unknown): value is TimelineEditUndoRecord {
  return isRecord(value)
    && isPipelineString(value.id)
    && isPipelineString(value.applicationId)
    && isPipelineString(value.documentId)
    && isPipelineString(value.projectId)
    && isPipelineString(value.episodeId)
    && isPipelineString(value.baseRevisionId)
    && isPipelineString(value.resultRevisionId)
    && isString(value.createdAt)
}

function parseAutoEditTimelineSnapshot(
  value: unknown,
  response: Response,
  payload: unknown,
  authoritative = true,
): TimelineDocumentSnapshot | null {
  if (!isRecord(value)
    || !isRecord(value.timelineDocument)
    || !isRecord(value.revision)
    || !isRecord(value.document)
    || !isString(value.etag)
    || !isPipelineString(value.timelineDocument.id)
    || !isPipelineString(value.timelineDocument.projectId)
    || !isPipelineString(value.timelineDocument.episodeId)
    || !isPipelineString(value.timelineDocument.currentRevisionId)
    || !isPipelineString(value.revision.id)
    || !isPipelineString(value.revision.documentId)
    || value.revision.id !== value.timelineDocument.currentRevisionId
    || value.revision.documentId !== value.timelineDocument.id
    || value.revision.projectId !== value.timelineDocument.projectId
    || value.revision.episodeId !== value.timelineDocument.episodeId
    || value.revision.schemaVersion !== value.timelineDocument.schemaVersion
    || value.revision.upstreamCommit !== value.timelineDocument.upstreamCommit
    || value.revision.sourceRevisionId !== value.timelineDocument.sourceRevisionId) return null

  const snapshotEtag = `W/"${String(value.revision.id)}"`
  if (value.etag !== snapshotEtag) return null
  if (authoritative) {
    const headerEtag = requiredOpaqueEtag(
      response,
      payload,
      '服务返回的自动剪辑时间线 ETag 无效。',
    )
    const revisionMatch = /^(?:W\/)?"([^"\s]+)"$/.exec(headerEtag)
    if (value.etag !== headerEtag || revisionMatch?.[1] !== value.revision.id) return null
  }
  return value as unknown as TimelineDocumentSnapshot
}

function validateAutoEditOperations(
  operations: unknown,
  changedElementIds: unknown,
): operations is TimelineAutomaticEditOperation[] {
  if (!Array.isArray(operations)
    || !operations.every(isTimelineAutoEditOperation)
    || !isUniqueIdList(changedElementIds)) return false
  const operationIds = operations.map((operation) => operation.elementId)
  return new Set(operationIds).size === operationIds.length
    && operationIds.length === changedElementIds.length
    && operationIds.every((id) => changedElementIds.includes(id))
}

function sameTimingSnapshot(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false
  return left.startTime === right.startTime
    && left.duration === right.duration
    && left.trimStart === right.trimStart
    && left.trimEnd === right.trimEnd
}

function autoEditPlanMatchesResponse(
  plan: Omit<TimelineAutoEditPlan, 'confirmationToken'>,
  diagnostics: TimelineAutoEditDiagnostic[],
  operations: TimelineAutomaticEditOperation[],
  changedElementIds: string[],
): boolean {
  return plan.changedElementIds.length === changedElementIds.length
    && plan.changedElementIds.every((id, index) => id === changedElementIds[index])
    && plan.diagnostics.length === diagnostics.length
    && plan.diagnostics.every((diagnostic, index) => {
      const other = diagnostics[index]
      return other !== undefined
        && diagnostic.code === other.code
        && diagnostic.severity === other.severity
        && diagnostic.message === other.message
        && diagnostic.elementIds.length === other.elementIds.length
        && diagnostic.elementIds.every((id, elementIndex) => id === other.elementIds[elementIndex])
    })
    && plan.operations.length === operations.length
    && plan.operations.every((operation, index) => {
      const other = operations[index]
      return other !== undefined
        && operation.kind === other.kind
        && operation.trackId === other.trackId
        && operation.elementId === other.elementId
        && operation.reason === other.reason
        && sameTimingSnapshot(operation.before, other.before)
        && sameTimingSnapshot(operation.after, other.after)
    })
}

export async function previewTimelineAutomaticEdit(
  episodeId: string,
  input: PreviewTimelineAutoEditInput,
  timelineEtag: string,
  options: RequestOptions = {},
): Promise<TimelineAutoEditPreview> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/timeline-document/auto-edit/preview`,
    jsonRequestWithHeaders('POST', {
      goal: input.goal,
      policy: input.policy,
    }, { 'If-Match': timelineEtag }),
    options.signal,
  )
  const timeline = isRecord(payload)
    ? parseAutoEditTimelineSnapshot(payload.timeline, response, payload)
    : null
  if (!isRecord(payload)
    || !timeline
    || !isTimelineAutoEditPlan(payload.plan, true)
    || !isRecord(payload.previewDocument)
    || !Array.isArray(payload.diagnostics)
    || !payload.diagnostics.every(isTimelineAutoEditDiagnostic)
    || !validateAutoEditOperations(payload.operations, payload.changedElementIds)
    || !isTimelineAutoEditRisk(payload.risk)
    || payload.plan.risk !== payload.risk
    || !autoEditPlanMatchesResponse(
      payload.plan,
      payload.diagnostics,
      payload.operations,
      payload.changedElementIds as string[],
    )
    || payload.plan.episodeId !== episodeId
    || payload.plan.projectId !== timeline.timelineDocument.projectId
    || payload.plan.documentId !== timeline.timelineDocument.id
    || payload.plan.baseRevisionId !== timeline.revision.id
    || payload.plan.sourceRevisionId !== timeline.timelineDocument.sourceRevisionId
    || payload.plan.schemaVersion !== timeline.timelineDocument.schemaVersion
    || payload.plan.upstreamCommit !== timeline.timelineDocument.upstreamCommit
    || timeline.etag !== timelineEtag) {
    throw new ApiError('服务返回的自动剪辑预览无法安全验证。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    timeline,
    plan: payload.plan,
    previewDocument: payload.previewDocument,
    diagnostics: payload.diagnostics,
    operations: payload.operations,
    risk: payload.risk,
    changedElementIds: payload.changedElementIds as string[],
  }
}

export async function applyTimelineAutomaticEdit(
  episodeId: string,
  input: ApplyTimelineAutoEditInput,
  timelineEtag: string,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<TimelineAutoEditApplyResult> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/timeline-document/auto-edit/apply`,
    jsonRequestWithHeaders('POST', {
      planId: input.planId,
      confirmationToken: input.confirmationToken,
    }, {
      'If-Match': timelineEtag,
      'Idempotency-Key': idempotencyKey,
    }),
    options.signal,
  )
  const timeline = isRecord(payload)
    ? parseAutoEditTimelineSnapshot(payload.timeline, response, payload)
    : null
  const operationResultTimeline = isRecord(payload)
    ? parseAutoEditTimelineSnapshot(payload.operationResultTimeline, response, payload, false)
    : null
  if (!isRecord(payload)
    || !timeline
    || !operationResultTimeline
    || !isTimelineEditApplication(payload.application)
    || !isTimelineAutoEditPlan(payload.plan, false)
    || !Array.isArray(payload.diagnostics)
    || !payload.diagnostics.every(isTimelineAutoEditDiagnostic)
    || !validateAutoEditOperations(payload.operations, payload.changedElementIds)
    || payload.risk !== 'safe'
    || payload.plan.risk !== 'safe'
    || !autoEditPlanMatchesResponse(
      payload.plan,
      payload.diagnostics,
      payload.operations,
      payload.changedElementIds as string[],
    )
    || typeof payload.idempotent !== 'boolean'
    || typeof payload.headAdvanced !== 'boolean'
    || payload.headAdvanced
      !== (timeline.revision.id !== operationResultTimeline.revision.id)
    || payload.plan.id !== input.planId
    || payload.plan.episodeId !== episodeId
    || payload.plan.projectId !== operationResultTimeline.timelineDocument.projectId
    || payload.plan.documentId !== operationResultTimeline.timelineDocument.id
    || payload.plan.sourceRevisionId !== operationResultTimeline.timelineDocument.sourceRevisionId
    || payload.plan.schemaVersion !== operationResultTimeline.timelineDocument.schemaVersion
    || payload.plan.upstreamCommit !== operationResultTimeline.timelineDocument.upstreamCommit
    || payload.application.planId !== payload.plan.id
    || payload.application.documentId !== operationResultTimeline.timelineDocument.id
    || payload.application.projectId !== operationResultTimeline.timelineDocument.projectId
    || payload.application.episodeId !== episodeId
    || payload.application.baseRevisionId !== payload.plan.baseRevisionId
    || payload.application.resultRevisionId !== operationResultTimeline.revision.id
    || operationResultTimeline.revision.parentRevisionId !== payload.application.baseRevisionId
    || timeline.timelineDocument.id !== operationResultTimeline.timelineDocument.id
    || timeline.timelineDocument.projectId !== operationResultTimeline.timelineDocument.projectId
    || timeline.timelineDocument.episodeId !== operationResultTimeline.timelineDocument.episodeId) {
    throw new ApiError('服务返回的自动剪辑应用结果无法安全验证。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    timeline,
    operationResultTimeline,
    headAdvanced: payload.headAdvanced,
    application: payload.application,
    plan: payload.plan,
    diagnostics: payload.diagnostics,
    operations: payload.operations,
    risk: 'safe',
    changedElementIds: payload.changedElementIds as string[],
    idempotent: payload.idempotent,
  }
}

export async function undoTimelineAutomaticEdit(
  applicationId: string,
  timelineEtag: string,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<TimelineAutoEditUndoResult> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/timeline-edit-applications/${encoded(applicationId)}/undo`,
    jsonRequestWithHeaders('POST', {}, {
      'If-Match': timelineEtag,
      'Idempotency-Key': idempotencyKey,
    }),
    options.signal,
  )
  const timeline = isRecord(payload)
    ? parseAutoEditTimelineSnapshot(payload.timeline, response, payload)
    : null
  const operationResultTimeline = isRecord(payload)
    ? parseAutoEditTimelineSnapshot(payload.operationResultTimeline, response, payload, false)
    : null
  if (!isRecord(payload)
    || !timeline
    || !operationResultTimeline
    || !isTimelineEditApplication(payload.application)
    || !isTimelineEditUndoRecord(payload.undo)
    || typeof payload.idempotent !== 'boolean'
    || typeof payload.headAdvanced !== 'boolean'
    || payload.headAdvanced
      !== (timeline.revision.id !== operationResultTimeline.revision.id)
    || payload.application.id !== applicationId
    || payload.application.documentId !== operationResultTimeline.timelineDocument.id
    || payload.application.projectId !== operationResultTimeline.timelineDocument.projectId
    || payload.application.episodeId !== operationResultTimeline.timelineDocument.episodeId
    || payload.undo.applicationId !== applicationId
    || payload.undo.documentId !== payload.application.documentId
    || payload.undo.projectId !== payload.application.projectId
    || payload.undo.episodeId !== payload.application.episodeId
    || payload.undo.baseRevisionId !== payload.application.resultRevisionId
    || payload.undo.resultRevisionId !== operationResultTimeline.revision.id
    || operationResultTimeline.revision.parentRevisionId !== payload.application.resultRevisionId
    || timeline.timelineDocument.id !== operationResultTimeline.timelineDocument.id
    || timeline.timelineDocument.projectId !== operationResultTimeline.timelineDocument.projectId
    || timeline.timelineDocument.episodeId !== operationResultTimeline.timelineDocument.episodeId) {
    throw new ApiError('服务返回的自动剪辑撤销结果无法安全验证。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    timeline,
    operationResultTimeline,
    headAdvanced: payload.headAdvanced,
    application: payload.application,
    undo: payload.undo,
    idempotent: payload.idempotent,
  }
}

function parseTimelineMaterializationSnapshot(
  payload: unknown,
  response: Response,
  expectedOperation: 'materialize' | 'reconcile',
): TimelineMaterializationSnapshot {
  if (
    !isRecord(payload)
    || !isRecord(payload.timelineDocument)
    || !isRecord(payload.revision)
    || !isRecord(payload.document)
    || typeof payload.created !== 'boolean'
    || !isRecord(payload.report)
    || payload.report.operation !== expectedOperation
    || typeof payload.report.sourceRevisionId !== 'string'
    || typeof payload.report.changed !== 'boolean'
    || !Array.isArray(payload.report.preservedElementIds)
    || !Array.isArray(payload.report.appendedShots)
    || !Array.isArray(payload.report.orphanedElements)
    || !Array.isArray(payload.report.preservedAbsentShots)
    || !Array.isArray(payload.report.unresolvedShots)
    || typeof payload.revision.id !== 'string'
  ) {
    throw new ApiError('服务返回的时间线对账数据格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const etag = response.headers.get('ETag')?.trim()
  const etagMatch = etag ? /^(?:W\/)?"([^"]+)"$/.exec(etag) : null
  if (!etag || !etagMatch || etagMatch[1] !== payload.revision.id) {
    throw new ApiError('服务返回的时间线 ETag 无效。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    ...(payload as unknown as TimelineMaterializationSnapshot),
    etag,
  }
}

export async function materializeTimelineDocument(
  episodeId: string,
  input: { projectId: string; summary?: string },
  options: RequestOptions = {},
): Promise<TimelineMaterializationSnapshot> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/timeline-document/materialize`,
    jsonRequestWithHeaders('POST', input, { 'If-Match': '*' }),
    options.signal,
  )
  return parseTimelineMaterializationSnapshot(payload, response, 'materialize')
}

export async function reconcileTimelineDocument(
  episodeId: string,
  input: { projectId: string; summary?: string },
  etag: string,
  options: RequestOptions = {},
): Promise<TimelineMaterializationSnapshot> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/timeline-document/reconcile`,
    jsonRequestWithHeaders('POST', input, { 'If-Match': etag }),
    options.signal,
  )
  return parseTimelineMaterializationSnapshot(payload, response, 'reconcile')
}

/**
 * Creates (or idempotently recovers) a durable FFmpeg render job. The body and
 * If-Match deliberately pin the same immutable timeline revision.
 */
export async function createExportRender(
  episodeId: string,
  input: CreateExportRenderInput,
  timelineEtag: string,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<CreateExportRenderResponse> {
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/exports`,
    jsonRequestWithHeaders('POST', input, {
      'If-Match': timelineEtag,
      'Idempotency-Key': idempotencyKey,
    }),
    options.signal,
  )
  if (
    !isRecord(payload)
    || !isExportRenderRecord(payload.export)
    || !isExportRenderGenerationJob(payload.job)
    || payload.export.projectId !== input.projectId
    || payload.export.episodeId !== episodeId
    || payload.export.timelineRevisionId !== input.timelineRevisionId
    || payload.export.specification.resolution !== input.resolution
    || payload.export.specification.kenBurns !== (input.kenBurns === true)
    || payload.export.specification.burnSubtitles !== (input.burnSubtitles === true)
    || payload.export.specification.introTitle !== (input.introTitle === true)
    || payload.export.specification.outroCard !== (input.outroCard === true)
    || payload.export.specification.reviewWatermark !== (input.reviewWatermark === true)
    || payload.export.jobId !== payload.job.id
    || payload.job.projectId !== input.projectId
    || payload.job.episodeId !== episodeId
    || payload.job.resourceId !== payload.export.id
    || payload.job.input.exportId !== payload.export.id
  ) {
    return invalidExportResponse(payload)
  }
  if (payload.job.output && (
    payload.job.output.exportId !== payload.export.id
    || payload.job.output.timelineRevisionId !== payload.export.timelineRevisionId
    || payload.job.output.storyRevisionId !== payload.export.storyRevisionId
    || payload.export.outputAsset?.id !== payload.job.output.asset.id
  )) {
    return invalidExportResponse(payload)
  }
  return {
    export: payload.export,
    job: payload.job,
  }
}

export async function getExportRender(
  exportId: string,
  options: RequestOptions = {},
): Promise<ExportRenderRecord> {
  const payload = await request<unknown>(
    `/api/v1/exports/${encoded(exportId)}`,
    {},
    options.signal,
  )
  const exported = expectEnvelope<ExportRenderRecord>(
    payload,
    'export',
    isExportRenderRecord,
  )
  if (exported.id !== exportId) return invalidExportResponse(payload)
  return exported
}

export async function createQualityCheck(
  exportId: string,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<CreateQualityCheckResponse> {
  const payload = await request<unknown>(
    `/api/v1/exports/${encoded(exportId)}/quality-checks`,
    jsonRequestWithHeaders('POST', {}, { 'Idempotency-Key': idempotencyKey }),
    options.signal,
  )
  if (!isRecord(payload) || !isQualityReport(payload.qualityReport)) {
    throw new ApiError('服务返回的质检报告格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  if (payload.qualityReport.exportId !== exportId
    || !isQualityGenerationJob(payload.job, payload.qualityReport)) {
    throw new ApiError('服务返回的质检任务绑定不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as CreateQualityCheckResponse
}

export async function getQualityReport(
  reportId: string,
  options: RequestOptions = {},
): Promise<QualityReport> {
  const payload = await request<unknown>(
    `/api/v1/quality-reports/${encoded(reportId)}`,
    {},
    options.signal,
  )
  const report = expectEnvelope<QualityReport>(payload, 'qualityReport', isQualityReport)
  if (report.id !== reportId) {
    throw new ApiError('服务返回了错误的质检报告。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return report
}

export async function createReleaseReview(
  exportId: string,
  input: CreateReleaseReviewInput,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<CreateReleaseReviewResponse> {
  const payload = await request<unknown>(
    `/api/v1/exports/${encoded(exportId)}/release-reviews`,
    jsonRequestWithHeaders('POST', input, { 'Idempotency-Key': idempotencyKey }),
    options.signal,
  )
  if (!isRecord(payload) || !isReleaseReview(payload.releaseReview)) {
    throw new ApiError('服务返回的发行复验记录格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const review = payload.releaseReview
  if (review.exportId !== exportId
    || review.decision !== input.decision
    || review.checklist.audioVideoSync !== input.checklist.audioVideoSync
    || review.checklist.subtitleSyncAndComplete !== input.checklist.subtitleSyncAndComplete
    || review.checklist.characterVisualSemantics !== input.checklist.characterVisualSemantics
    || !review.isCurrent
    || review.invalidReasons.length > 0) {
    throw new ApiError('服务返回的发行复验绑定与本次提交不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return { releaseReview: review }
}

export async function listReleaseReviews(
  exportId: string,
  options: RequestOptions = {},
): Promise<ReleaseReview[]> {
  const payload = await request<unknown>(
    `/api/v1/exports/${encoded(exportId)}/release-reviews`,
    {},
    options.signal,
  )
  if (!isRecord(payload)
    || !Array.isArray(payload.releaseReviews)
    || !payload.releaseReviews.every(isReleaseReview)
    || payload.releaseReviews.some((review) => review.exportId !== exportId)) {
    throw new ApiError('服务返回的发行复验历史格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload.releaseReviews
}

function pipelineIdempotencyKey(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ApiError('一键生产的 Idempotency-Key 格式无效。', {
      status: 400,
      code: 'INVALID_IDEMPOTENCY_KEY',
    })
  }
  return normalized
}

/** Resolves the authoritative paid target/provider snapshot before creation. */
export async function preflightPipelineRun(
  episodeId: string,
  input: PipelineRunPreflightInput,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<PipelineRunPreflight> {
  const rootKey = pipelineIdempotencyKey(idempotencyKey)
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/pipeline-runs/preflight`,
    jsonRequestWithHeaders('POST', input, { 'Idempotency-Key': rootKey }),
    options.signal,
  )
  if (!isRecord(payload)
    || !hasExactlyKeys(payload, ['preflight'])
    || !isPipelineRunPreflight(payload.preflight)) {
    throw new ApiError('服务返回的一键生产预检数据格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const preflight = payload.preflight
  if (preflight.projectId !== input.projectId
    || preflight.episodeId !== episodeId
    || (input.speechMode === 'skip' && preflight.billableSpeechCount !== 0)
    || (input.imageProviderId !== undefined
      && preflight.imageProvider?.providerId !== input.imageProviderId)) {
    throw new ApiError('服务返回的一键生产预检与当前配置不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return preflight
}

/** Creates (or idempotently recovers) a preflight-confirmed durable five-step production run. */
export async function createPipelineRun(
  episodeId: string,
  input: CreatePipelineRunInput,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<PipelineRun> {
  const rootKey = pipelineIdempotencyKey(idempotencyKey)
  if (!pipelineConfirmationTokenPattern.test(input.confirmationToken)) {
    throw new ApiError('请先完成一键生产预检并确认可计费任务。', {
      code: 'PIPELINE_PREFLIGHT_REQUIRED',
    })
  }
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/pipeline-runs`,
    jsonRequestWithHeaders('POST', input, { 'Idempotency-Key': rootKey }),
    options.signal,
  )
  const run = pipelineRunFromEnvelope(payload)
  if (run.projectId !== input.projectId
    || run.episodeId !== episodeId
    || run.options.resolution !== input.resolution
    || run.options.kenBurns !== input.kenBurns
    || run.options.burnSubtitles !== input.burnSubtitles
    || run.options.introTitle !== input.introTitle
    || run.options.outroCard !== input.outroCard
    || run.options.reviewWatermark !== input.reviewWatermark
    || run.options.speechMode !== input.speechMode
    || (input.imageProviderId !== undefined
      && run.bindings.imageProvider?.providerId !== input.imageProviderId)) {
    throw new ApiError('服务返回的一键生产任务与提交配置不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return run
}

export async function getPipelineRun(
  pipelineRunId: string,
  options: RequestOptions = {},
): Promise<PipelineRun> {
  const payload = await request<unknown>(
    `/api/v1/pipeline-runs/${encoded(pipelineRunId)}`,
    {},
    options.signal,
  )
  const run = pipelineRunFromEnvelope(payload)
  if (run.id !== pipelineRunId) {
    throw new ApiError('服务返回了错误的一键生产任务。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return run
}

export async function listPipelineRuns(
  options: ListPipelineRunsOptions,
): Promise<PipelineRun[]> {
  const params = new URLSearchParams({
    projectId: options.projectId,
    episodeId: options.episodeId,
  })
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  const payload = await request<unknown>(
    `/api/v1/pipeline-runs?${params}`,
    {},
    options.signal,
  )
  if (!isRecord(payload)
    || !hasExactlyKeys(payload, ['pipelineRuns'])
    || !Array.isArray(payload.pipelineRuns)) {
    throw new ApiError('服务返回的一键生产任务列表格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const runs = payload.pipelineRuns.map(parsePipelineRun)
  if (runs.some((run) => run.projectId !== options.projectId || run.episodeId !== options.episodeId)
    || new Set(runs.map((run) => run.id)).size !== runs.length) {
    throw new ApiError('一键生产任务列表包含不属于当前分集的记录。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return runs
}

export async function cancelPipelineRun(
  pipelineRunId: string,
  options: RequestOptions = {},
): Promise<PipelineRun> {
  const payload = await request<unknown>(
    `/api/v1/pipeline-runs/${encoded(pipelineRunId)}/cancel`,
    jsonRequest('POST', {}),
    options.signal,
  )
  const run = pipelineRunFromEnvelope(payload)
  if (run.id !== pipelineRunId || !['cancelled', 'succeeded', 'failed', 'stale'].includes(run.status)) {
    throw new ApiError('服务未确认一键生产任务已停止。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return run
}

export async function listTimelineDocumentRevisions(
  documentId: string,
  options: RequestOptions & { limit?: number; offset?: number } = {},
): Promise<TimelineDocumentHistory> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  const query = params.size ? `?${params}` : ''
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/timeline-documents/${encoded(documentId)}/revisions${query}`,
    {},
    options.signal,
  )
  const etag = response.headers.get('ETag')?.trim()
  if (!isRecord(payload)
    || !hasExactlyKeys(payload, ['timelineDocument', 'revisions', 'etag'])
    || !isTimelineDocumentRecord(payload.timelineDocument)
    || !Array.isArray(payload.revisions)
    || !payload.revisions.every(isTimelineDocumentRevision)) {
    throw new ApiError('服务返回的时间线修订无法安全验证。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const timelineDocument = payload.timelineDocument
  const revisions = payload.revisions as TimelineDocumentRevision[]
  if (timelineDocument.id !== documentId
    || new Set(revisions.map((revision) => revision.id)).size !== revisions.length
    || revisions.some((revision) => (
      revision.documentId !== documentId
      || revision.projectId !== timelineDocument.projectId
      || revision.episodeId !== timelineDocument.episodeId
    ))
    || !isString(payload.etag)
    || payload.etag !== `W/"${timelineDocument.currentRevisionId}"`
    || etag !== payload.etag) {
    throw new ApiError('服务返回的时间线修订无法安全验证。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as TimelineDocumentHistory
}

function isTimelineRevisionRestoreRecord(value: unknown): value is TimelineRevisionRestoreRecord {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'id', 'documentId', 'projectId', 'episodeId', 'baseRevisionId',
      'targetRevisionId', 'resultRevisionId', 'createdAt',
    ])
    && [
      value.id,
      value.documentId,
      value.projectId,
      value.episodeId,
      value.baseRevisionId,
      value.targetRevisionId,
      value.resultRevisionId,
    ].every(isPipelineString)
    && isString(value.createdAt)
    && Number.isFinite(Date.parse(value.createdAt))
}

export async function restoreTimelineDocumentRevision(
  episodeId: string,
  revisionId: string,
  input: RestoreTimelineRevisionInput,
  timelineEtag: string,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<TimelineRevisionRestoreResult> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/timeline-document/revisions/${encoded(revisionId)}/restore`,
    jsonRequestWithHeaders('POST', input, {
      'If-Match': timelineEtag,
      'Idempotency-Key': idempotencyKey,
    }),
    options.signal,
  )
  const timeline = isRecord(payload)
    ? timelineSnapshotFromResponse(payload.timeline, response, payload, { episodeId })
    : null
  const operationResultTimeline = isRecord(payload)
    ? timelineSnapshotFromResponse(
        payload.operationResultTimeline,
        response,
        payload,
        { authoritative: false, episodeId },
      )
    : null
  if (!isRecord(payload)
    || !hasExactlyKeys(payload, [
      'timeline', 'operationResultTimeline', 'headAdvanced', 'restore', 'idempotent',
    ])
    || !timeline
    || !operationResultTimeline
    || !isTimelineRevisionRestoreRecord(payload.restore)
    || typeof payload.headAdvanced !== 'boolean'
    || typeof payload.idempotent !== 'boolean'
    || payload.headAdvanced !== (timeline.revision.id !== operationResultTimeline.revision.id)
    || payload.restore.projectId !== input.projectId
    || payload.restore.episodeId !== episodeId
    || payload.restore.documentId !== input.documentId
    || payload.restore.targetRevisionId !== revisionId
    || payload.restore.resultRevisionId !== operationResultTimeline.revision.id
    || operationResultTimeline.revision.parentRevisionId !== payload.restore.baseRevisionId
    || (payload.headAdvanced && !payload.idempotent)
    || timeline.timelineDocument.id !== input.documentId
    || timeline.timelineDocument.projectId !== input.projectId
    || operationResultTimeline.timelineDocument.id !== input.documentId
    || operationResultTimeline.timelineDocument.projectId !== input.projectId
    || (!payload.headAdvanced && (
      operationResultTimeline.timelineDocument.schemaVersion !== timeline.timelineDocument.schemaVersion
      || operationResultTimeline.timelineDocument.upstreamCommit !== timeline.timelineDocument.upstreamCommit
      || operationResultTimeline.timelineDocument.sourceRevisionId !== timeline.timelineDocument.sourceRevisionId
    ))) {
    throw new ApiError('服务返回的时间线恢复结果无法安全验证。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    timeline,
    operationResultTimeline,
    headAdvanced: payload.headAdvanced,
    restore: payload.restore,
    idempotent: payload.idempotent,
  }
}

export async function listProjectRevisions(
  projectId: string,
  options: RequestOptions = {},
): Promise<ProjectRevision[]> {
  const payload = await request<unknown>(
    `/api/v1/projects/${encoded(projectId)}/revisions`,
    {},
    options.signal,
  )
  const revisions = expectEnvelope<ProjectRevision[]>(
    payload,
    'revisions',
    (value): value is ProjectRevision[] => Array.isArray(value) && value.every(isProjectRevision),
  )
  if (revisions.some((revision) => revision.projectId !== projectId)) {
    throw new ApiError('服务返回的项目修订归属不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return revisions
}

export async function restoreProjectRevision(
  projectId: string,
  revisionId: string,
  expectedEtag: string,
  options: RequestOptions = {},
): Promise<ProjectSnapshot> {
  const payload = await request<unknown>(
    `/api/v1/projects/${encoded(projectId)}/revisions/${encoded(revisionId)}/restore`,
    jsonRequestWithHeaders('POST', {}, { 'If-Match': expectedEtag }),
    options.signal,
  )
  if (!isRecord(payload)
    || !isRecord(payload.project)
    || !isRecord(payload.revision)
    || !isRecord(payload.document)
    || typeof payload.etag !== 'string'
    || payload.project.id !== projectId
    || payload.revision.projectId !== projectId
    || typeof payload.revision.id !== 'string') {
    throw new ApiError('服务返回的项目知识修订恢复结果不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as ProjectSnapshot
}

export async function listStoryRevisions(
  episodeId: string,
  options: RequestOptions & { projectId?: string } = {},
): Promise<StoryRevisionHistory> {
  const params = new URLSearchParams()
  if (options.projectId) params.set('projectId', options.projectId)
  const query = params.size ? `?${params}` : ''
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/story/revisions${query}`,
    {},
    options.signal,
  )
  if (!isRecord(payload)
    || !hasExactlyKeys(payload, ['episodeId', 'revisionId', 'revisions'])
    || payload.episodeId !== episodeId
    || !isNullableString(payload.revisionId)
    || !Array.isArray(payload.revisions)
    || !payload.revisions.every(isProjectRevision)) {
    throw new ApiError('服务返回的分集剧本修订格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const revisions = payload.revisions as ProjectRevision[]
  if (revisions.some((revision) => (
    options.projectId !== undefined && revision.projectId !== options.projectId
  ))) {
    throw new ApiError('服务返回的剧本修订归属不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    episodeId,
    revisionId: payload.revisionId as string | null,
    revisions,
    etag: requiredOpaqueEtag(response, payload, '服务返回的分集 ETag 无效。'),
  }
}

export async function uploadUserAudio(
  projectId: string,
  episodeId: string,
  kind: UserAudioAssetKind,
  audio: Blob | File,
  options: UploadUserAudioOptions = {},
): Promise<UserAudioAsset> {
  if (kind !== 'bgm' && kind !== 'sfx') {
    throw new ApiError('音频资产类型仅支持 bgm 或 sfx。', {
      code: 'INVALID_AUDIO_KIND',
      details: { kind },
    })
  }
  if (!(audio instanceof Blob)) {
    throw new ApiError('请选择有效的音频文件。', {
      code: 'INVALID_UPLOAD_BODY',
    })
  }

  const mimeType = normalizeUserAudioMimeType(audio.type)
  const inferredName = 'name' in audio && typeof audio.name === 'string'
    ? audio.name
    : undefined
  const name = normalizeUploadName(options.name ?? inferredName)
  const params = new URLSearchParams({ projectId, episodeId, kind })
  if (name !== undefined) params.set('name', name)

  const payload = await request<unknown>(
    `/api/v1/assets/uploads/audio?${params.toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': mimeType },
      body: audio,
    },
    options.signal,
  )
  return expectEnvelope<UserAudioAsset>(
    payload,
    'asset',
    (value) => isUserAudioAsset(value, {
      projectId,
      episodeId,
      kind,
      mimeType,
      ...(name !== undefined ? { name } : {}),
    }),
  )
}

export async function listAssets(
  projectId: string,
  options: RequestOptions & {
    kind?: string
    episodeId?: string
    includeProjectAssets?: boolean
  } = {},
): Promise<MediaAsset[]> {
  const params = new URLSearchParams({ projectId })
  if (options.kind) params.set('kind', options.kind)
  if (options.episodeId) params.set('episodeId', options.episodeId)
  if (options.includeProjectAssets !== undefined) {
    params.set('includeProjectAssets', String(options.includeProjectAssets))
  }
  const payload = await request<unknown>(`/api/v1/assets?${params}`, {}, options.signal)
  return expectEnvelope<MediaAsset[]>(payload, 'assets', (value) => (
    Array.isArray(value) && value.every(isMediaAsset)
  ))
}

export async function getAsset(
  assetId: string,
  options: RequestOptions = {},
): Promise<MediaAsset> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/assets/${encoded(assetId)}`,
    {},
    options.signal,
  )
  if (!isRecord(payload) || !isMediaAsset(payload.asset) || payload.asset.id !== assetId) {
    throw new ApiError('服务返回的资产数据格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const headerEtag = response.headers.get('ETag')?.trim()
  if (payload.asset.etag !== undefined && payload.asset.etag !== headerEtag) {
    throw new ApiError('服务返回的资产 ETag 不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload.asset
}

const assetHandleEtagPattern = /^"asset-handle-v1-[a-f0-9]{64}"$/

function isAssetBusinessBinding(value: unknown): boolean {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'domain',
      'groupKey',
      'groupLabel',
      'episodeId',
      'sceneId',
      'shotId',
      'lineId',
      'entityType',
      'entityId',
      'role',
    ])
    && ['character', 'location', 'prop', 'shot', 'dialogue', 'audio', 'export', 'document', 'other', 'archive'].includes(String(value.domain))
    && isNonEmptyString(value.groupKey)
    && isNonEmptyString(value.groupLabel)
    && isNullableString(value.episodeId)
    && isNullableString(value.sceneId)
    && isNullableString(value.shotId)
    && isNullableString(value.lineId)
    && (value.entityType === null || ['character', 'location', 'prop'].includes(String(value.entityType)))
    && isNullableString(value.entityId)
    && isNullableString(value.role)
}

function isAssetHandle(value: unknown): value is AssetHandle {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'assetId',
      'projectId',
      'kind',
      'currentAssetVersionId',
      'revision',
      'versionCount',
      'businessBinding',
      'etag',
      'currentVersion',
      'createdAt',
      'updatedAt',
    ])
    && isNonEmptyString(value.assetId)
    && isNonEmptyString(value.projectId)
    && isNonEmptyString(value.kind)
    && isNullableString(value.currentAssetVersionId)
    && Number.isInteger(value.revision)
    && (value.revision as number) >= 1
    && isNonNegativeInteger(value.versionCount)
    && isAssetBusinessBinding(value.businessBinding)
    && isString(value.etag)
    && assetHandleEtagPattern.test(value.etag)
    && (value.currentVersion === null || isMediaAsset(value.currentVersion))
    && (value.currentVersion === null
      ? value.currentAssetVersionId === null
      : value.currentVersion.id === value.currentAssetVersionId
        && value.currentVersion.projectId === value.projectId
        && value.currentVersion.kind === value.kind)
    && isString(value.createdAt)
    && isString(value.updatedAt)
}

function isAssetHandleVersion(value: unknown): value is AssetHandleVersion {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'assetId',
      'assetVersionId',
      'versionNumber',
      'checksum',
      'createdAt',
      'version',
    ])
    && isNonEmptyString(value.assetId)
    && isNonEmptyString(value.assetVersionId)
    && Number.isInteger(value.versionNumber)
    && (value.versionNumber as number) >= 1
    && isNullableString(value.checksum)
    && isString(value.createdAt)
    && isMediaAsset(value.version)
    && value.version.id === value.assetVersionId
    && value.version.checksum === value.checksum
}

function isAssetVersionSwitch(value: unknown): value is AssetVersionSwitch {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'id',
      'assetId',
      'previousAssetVersionId',
      'selectedAssetVersionId',
      'selectedAssetVersionChecksum',
      'handleRevision',
      'changed',
      'createdAt',
      'idempotent',
      'providerCallRequired',
    ])
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.assetId)
    && isNullableString(value.previousAssetVersionId)
    && isNonEmptyString(value.selectedAssetVersionId)
    && isNullableString(value.selectedAssetVersionChecksum)
    && Number.isInteger(value.handleRevision)
    && (value.handleRevision as number) >= 1
    && typeof value.changed === 'boolean'
    && isString(value.createdAt)
    && typeof value.idempotent === 'boolean'
    && value.providerCallRequired === false
}

export async function listAssetHandles(
  projectId: string,
  options: RequestOptions & {
    episodeId?: string
    kind?: string
    /** Resolve the stable handle for one existing flat MediaAsset ID. */
    assetVersionId?: string
    limit?: number
  } = {},
): Promise<AssetHandle[]> {
  const params = new URLSearchParams()
  if (options.episodeId) params.set('episodeId', options.episodeId)
  if (options.kind) params.set('kind', options.kind)
  if (options.assetVersionId) params.set('assetVersionId', options.assetVersionId)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  const payload = await request<unknown>(
    `/api/v1/projects/${encoded(projectId)}/asset-handles?${params}`,
    {},
    options.signal,
  )
  const assets = expectEnvelope<AssetHandle[]>(payload, 'assets', (value) => (
    Array.isArray(value) && value.every(isAssetHandle)
  ))
  if (assets.some((asset) => asset.projectId !== projectId)) {
    throw new ApiError('服务返回的稳定素材归属不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return assets
}

export async function listAssetHandleVersions(
  projectId: string,
  assetId: string,
  options: RequestOptions = {},
): Promise<AssetHandleVersionsResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/projects/${encoded(projectId)}/asset-handles/${encoded(assetId)}/versions`,
    {},
    options.signal,
  )
  if (!isRecord(payload)
    || !hasExactlyKeys(payload, ['asset', 'versions'])
    || !isAssetHandle(payload.asset)
    || payload.asset.assetId !== assetId
    || payload.asset.projectId !== projectId
    || !Array.isArray(payload.versions)
    || !payload.versions.every(isAssetHandleVersion)
    || payload.versions.some((version) => (
      version.assetId !== assetId
      || version.version.projectId !== projectId
      || version.version.kind !== (payload.asset as AssetHandle).kind
    ))) {
    throw new ApiError('服务返回的素材版本列表格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const etag = requiredOpaqueEtag(response, payload, '服务返回的素材 ETag 无效。')
  if (etag !== payload.asset.etag) {
    throw new ApiError('服务返回的素材 ETag 不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as AssetHandleVersionsResponse
}

export async function switchAssetHandleCurrentVersion(
  projectId: string,
  assetId: string,
  assetVersionId: string,
  assetEtag: string,
  options: RequestOptions & { idempotencyKey?: string } = {},
): Promise<AssetVersionSwitchResponse> {
  if (!assetHandleEtagPattern.test(assetEtag)) {
    throw new ApiError('素材 ETag 格式无效，请刷新版本列表后重试。', {
      code: 'INVALID_ASSET_HANDLE_ETAG',
    })
  }
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/projects/${encoded(projectId)}/asset-handles/${encoded(assetId)}/current-version`,
    jsonRequestWithHeaders('POST', { assetVersionId }, {
      'If-Match': assetEtag,
      'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID(),
    }),
    options.signal,
  )
  if (!isRecord(payload)
    || !hasExactlyKeys(payload, ['asset', 'switch'])
    || !isAssetHandle(payload.asset)
    || !isAssetVersionSwitch(payload.switch)
    || payload.asset.assetId !== assetId
    || payload.asset.projectId !== projectId
    || payload.switch.assetId !== assetId
    || payload.switch.selectedAssetVersionId !== assetVersionId
    || payload.switch.handleRevision > payload.asset.revision) {
    throw new ApiError('服务返回的素材版本切换记录格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const etag = requiredOpaqueEtag(response, payload, '服务返回的素材 ETag 无效。')
  if (etag !== payload.asset.etag) {
    throw new ApiError('服务返回的素材 ETag 不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as AssetVersionSwitchResponse
}

function isProductionAssetManifestContext(value: unknown): value is ProductionAssetManifestContext {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'schemaVersion',
      'projectId',
      'episodeId',
      'sourceRevisionId',
      'projectRevisionId',
      'timelineRevisionId',
      'narratorVoiceProfileRevisionId',
      'characterVoiceProfileRevisions',
    ])
    && value.schemaVersion === 1
    && isNonEmptyString(value.projectId)
    && isNonEmptyString(value.episodeId)
    && isNullableString(value.sourceRevisionId)
    && isNullableString(value.projectRevisionId)
    && isNullableString(value.timelineRevisionId)
    && isNullableString(value.narratorVoiceProfileRevisionId)
    && isRecord(value.characterVoiceProfileRevisions)
    && Object.values(value.characterVoiceProfileRevisions).every(isNonEmptyString)
}

function isProductionAssetManifestEntry(value: unknown): value is ProductionAssetManifestEntry {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'slotKey',
      'role',
      'assetId',
      'assetVersionId',
      'versionNumber',
      'checksum',
      'kind',
      'mimeType',
      'sourceRevisionId',
      'providerId',
      'providerModel',
      'providerConfigRevision',
      'metadata',
    ])
    && isNonEmptyString(value.slotKey)
    && isNonEmptyString(value.role)
    && isNonEmptyString(value.assetId)
    && isNonEmptyString(value.assetVersionId)
    && Number.isInteger(value.versionNumber)
    && (value.versionNumber as number) >= 1
    && typeof value.checksum === 'string'
    && /^[a-f0-9]{64}$/.test(value.checksum)
    && isNonEmptyString(value.kind)
    && isNullableString(value.mimeType)
    && isNullableString(value.sourceRevisionId)
    && isNullableString(value.providerId)
    && isNullableString(value.providerModel)
    && (value.providerConfigRevision === null
      || (Number.isInteger(value.providerConfigRevision)
        && (value.providerConfigRevision as number) >= 1))
    && isRecord(value.metadata)
}

function isProductionAssetManifestBlocker(value: unknown): value is ProductionAssetManifestBlocker {
  return isRecord(value)
    && hasExactlyKeys(value, ['code', 'slotKey', 'assetVersionId', 'message'])
    && isNonEmptyString(value.code)
    && isNullableString(value.slotKey)
    && isNullableString(value.assetVersionId)
    && isNonEmptyString(value.message)
}

function isProductionAssetManifest(value: unknown): value is ProductionAssetManifest {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'id',
      'projectId',
      'episodeId',
      'revisionNumber',
      'parentManifestId',
      'sourceRevisionId',
      'projectRevisionId',
      'timelineRevisionId',
      'fingerprint',
      'entryCount',
      'context',
      'summary',
      'idempotencyKey',
      'entries',
      'createdAt',
    ])
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.projectId)
    && isNonEmptyString(value.episodeId)
    && Number.isInteger(value.revisionNumber)
    && (value.revisionNumber as number) >= 1
    && isNullableString(value.parentManifestId)
    && isNonEmptyString(value.sourceRevisionId)
    && isNullableString(value.projectRevisionId)
    && isNullableString(value.timelineRevisionId)
    && typeof value.fingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && Number.isInteger(value.entryCount)
    && (value.entryCount as number) >= 1
    && isProductionAssetManifestContext(value.context)
    && isNonEmptyString(value.summary)
    && isNonEmptyString(value.idempotencyKey)
    && Array.isArray(value.entries)
    && value.entries.every(isProductionAssetManifestEntry)
    && value.entries.length === value.entryCount
    && isNonEmptyString(value.createdAt)
}

function isProductionAssetManifestProjection(value: unknown): value is ProductionAssetManifestProjection {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'status',
      'fingerprint',
      'context',
      'entries',
      'blockers',
      'latestManifest',
    ])
    && ['missing', 'current', 'changed', 'blocked'].includes(String(value.status))
    && typeof value.fingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && isProductionAssetManifestContext(value.context)
    && Array.isArray(value.entries)
    && value.entries.every(isProductionAssetManifestEntry)
    && Array.isArray(value.blockers)
    && value.blockers.every(isProductionAssetManifestBlocker)
    && (value.latestManifest === null || isProductionAssetManifest(value.latestManifest))
}

export async function getProductionAssetManifest(
  projectId: string,
  episodeId: string,
  options: RequestOptions = {},
): Promise<ProductionAssetManifestProjectionResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/projects/${encoded(projectId)}/episodes/${encoded(episodeId)}/production-asset-manifest`,
    {},
    options.signal,
  )
  if (!isRecord(payload)
    || !hasExactlyKeys(payload, ['projection'])
    || !isProductionAssetManifestProjection(payload.projection)
    || payload.projection.context.projectId !== projectId
    || payload.projection.context.episodeId !== episodeId) {
    throw new ApiError('服务返回的制作素材清单格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const episodeEtag = response.headers.get('x-episode-version')?.trim()
  if (!episodeEtag || episodeEtag.length > 500) {
    throw new ApiError('服务返回的剧集 ETag 无效。', { code: 'INVALID_RESPONSE' })
  }
  return { projection: payload.projection, episodeEtag }
}

export async function materializeProductionAssetManifest(
  projectId: string,
  episodeId: string,
  episodeEtag: string,
  options: RequestOptions & { idempotencyKey?: string; summary?: string } = {},
): Promise<MaterializeProductionAssetManifestResponse> {
  const payload = await request<unknown>(
    `/api/v1/projects/${encoded(projectId)}/episodes/${encoded(episodeId)}/production-asset-manifest/materialize`,
    jsonRequestWithHeaders('POST', options.summary ? { summary: options.summary } : {}, {
      'If-Match': episodeEtag,
      'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID(),
    }),
    options.signal,
  )
  if (!isRecord(payload)
    || !hasExactlyKeys(payload, ['manifest', 'idempotent', 'providerCallRequired'])
    || !isProductionAssetManifest(payload.manifest)
    || typeof payload.idempotent !== 'boolean'
    || payload.providerCallRequired !== false
    || payload.manifest.projectId !== projectId
    || payload.manifest.episodeId !== episodeId) {
    throw new ApiError('服务返回的制作素材清单固化记录格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as MaterializeProductionAssetManifestResponse
}

function validateAssetImageEditRequest(
  sourceAssetId: string,
  input: CreateAssetImageEditInput,
  sourceEtag: string,
): void {
  if (!/^"asset-v[1-9]\d*-[a-f0-9]{64}"$/.test(sourceEtag)) {
    throw new ApiError('源资产 ETag 格式无效，请刷新素材后重试。', {
      code: 'INVALID_ASSET_ETAG',
    })
  }
  if (input.mode === 'variation' && input.referenceAssetIds.length > 0) {
    throw new ApiError('原生 variation 不接受附加参考图，请改用图片编辑。', {
      code: 'INVALID_REFERENCE_ASSET',
    })
  }
  if (new Set(input.referenceAssetIds).size !== input.referenceAssetIds.length
    || input.referenceAssetIds.includes(sourceAssetId)) {
    throw new ApiError('参考图不能重复或与源图相同。', {
      code: 'INVALID_REFERENCE_ASSET',
    })
  }
}

export async function preflightAssetImageEdit(
  sourceAssetId: string,
  input: CreateAssetImageEditInput,
  sourceEtag: string,
  options: RequestOptions & { idempotencyKey: string },
): Promise<PublicPaidAigcConfirmation> {
  validateAssetImageEditRequest(sourceAssetId, input, sourceEtag)
  try {
    await request<unknown>(
      `/api/v1/assets/${encoded(sourceAssetId)}/edits`,
      jsonRequestWithHeaders('POST', input, {
        'If-Match': sourceEtag,
        'Idempotency-Key': options.idempotencyKey,
      }),
      options.signal,
    )
  } catch (error) {
    if (!(error instanceof ApiError)
      || error.status !== 409
      || error.code !== 'PAID_CONFIRMATION_REQUIRED') {
      throw error
    }
    if (!isRecord(error.details)
      || !hasExactlyKeys(error.details, ['confirmation'])) {
      return invalidPaidAigcConfirmation(error.details)
    }
    return parsePublicPaidAigcConfirmation(error.details.confirmation, 'asset.image.edit')
  }
  throw new ApiError('图片编辑预检未返回必要的计费确认。', {
    code: 'INVALID_RESPONSE',
  })
}

export async function createAssetImageEdit(
  sourceAssetId: string,
  input: CreateAssetImageEditInput,
  sourceEtag: string,
  options: RequestOptions & { idempotencyKey: string; confirmationToken: string },
): Promise<GenerationJob> {
  validateAssetImageEditRequest(sourceAssetId, input, sourceEtag)
  const payload = await request<unknown>(
    `/api/v1/assets/${encoded(sourceAssetId)}/edits`,
    jsonRequestWithHeaders('POST', input, {
      'If-Match': sourceEtag,
      'Idempotency-Key': options.idempotencyKey,
      'x-manju-aigc-confirmation': paidAigcConfirmationToken(options.confirmationToken),
    }),
    options.signal,
  )
  const job = expectEnvelope<GenerationJob>(payload, 'job', isRecord)
  if (job.type !== 'asset.image.edit'
    || job.projectId !== input.projectId
    || job.resourceId !== sourceAssetId) {
    throw new ApiError('服务未返回匹配的图片编辑任务。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return job
}

export async function createAssetTurnaroundDerivation(
  sourceAssetId: string,
  input: CreateAssetTurnaroundDerivationInput,
  sourceEtag: string,
  options: RequestOptions & { idempotencyKey?: string } = {},
): Promise<GenerationJob> {
  if (!/^"asset-v[1-9]\d*-[a-f0-9]{64}"$/.test(sourceEtag)) {
    throw new ApiError('源资产 ETag 格式无效，请刷新素材后重试。', {
      code: 'INVALID_ASSET_ETAG',
    })
  }
  const roles = input.crops.map((crop) => crop.role)
  if (input.crops.length !== 3
    || new Set(roles).size !== 3
    || !['front', 'side', 'back'].every((role) => roles.includes(role as typeof roles[number]))
    || input.crops.some((crop) => (
      ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
      || crop.x < 0
      || crop.y < 0
      || crop.width <= 0
      || crop.height <= 0
      || crop.x + crop.width > 1
      || crop.y + crop.height > 1
    ))) {
    throw new ApiError('三视图裁切框必须完整包含有效的正面、侧面与背面。', {
      code: 'INVALID_CROPS',
    })
  }
  const payload = await request<unknown>(
    `/api/v1/assets/${encoded(sourceAssetId)}/derivations/turnaround`,
    jsonRequestWithHeaders('POST', input, {
      'If-Match': sourceEtag,
      'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID(),
    }),
    options.signal,
  )
  const job = expectEnvelope<GenerationJob>(payload, 'job', isRecord)
  if (job.type !== 'asset.image.turnaround.derive'
    || job.projectId !== input.projectId
    || job.resourceId !== sourceAssetId) {
    throw new ApiError('服务未返回匹配的三视图派生任务。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return job
}

export async function listVisualAssetTargets(
  projectId: string,
  episodeId: string,
  options: RequestOptions = {},
): Promise<VisualAssetTargetsResponse> {
  const params = new URLSearchParams({ projectId })
  const payload = await request<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/visual-asset-targets?${params}`,
    {},
    options.signal,
  )
  if (
    !isRecord(payload)
    || payload.episodeId !== episodeId
    || !isString(payload.sourceRevisionId)
    || !Array.isArray(payload.targets)
    || !payload.targets.every(isVisualAssetTarget)
  ) {
    throw new ApiError('服务返回的视觉资产目标格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return payload as unknown as VisualAssetTargetsResponse
}

function isHistoricalVisualAssetCandidate(value: unknown): value is HistoricalVisualAssetCandidate {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'asset',
      'assetFamilyId',
      'assetVersionId',
      'assetVersion',
      'priorSourceRevisionId',
      'currentSourceRevisionId',
      'semanticFingerprint',
      'compatibility',
    ])
    && isMediaAsset(value.asset)
    && isNonEmptyString(value.assetFamilyId)
    && isNonEmptyString(value.assetVersionId)
    && value.asset.id === value.assetVersionId
    && Number.isInteger(value.assetVersion)
    && (value.assetVersion as number) >= 1
    && value.asset.version === value.assetVersion
    && isNonEmptyString(value.priorSourceRevisionId)
    && isNonEmptyString(value.currentSourceRevisionId)
    && isString(value.semanticFingerprint)
    && /^[a-f0-9]{64}$/.test(value.semanticFingerprint)
    && isRecord(value.compatibility)
    && hasExactlyKeys(value.compatibility, [
      'entityIdentity',
      'visualSemantics',
      'stylePreset',
      'aspectRatio',
      'providerCallRequired',
    ])
    && value.compatibility.entityIdentity === 'exact'
    && value.compatibility.visualSemantics === 'exact'
    && value.compatibility.stylePreset === 'exact'
    && value.compatibility.aspectRatio === 'exact'
    && value.compatibility.providerCallRequired === false
}

export async function listHistoricalVisualAssetCandidates(
  projectId: string,
  episodeId: string,
  targetType: VisualAssetTarget['type'],
  targetId: string,
  options: RequestOptions = {},
): Promise<HistoricalVisualAssetCandidatesResponse> {
  const params = new URLSearchParams({
    projectId,
    entityType: targetType,
    entityId: targetId,
  })
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/episodes/${encoded(episodeId)}/visual-asset-history?${params}`,
    {},
    options.signal,
  )
  if (!isRecord(payload)
    || !hasExactlyKeys(payload, [
      'episodeId',
      'sourceRevisionId',
      'entityType',
      'entityId',
      'candidates',
    ])
    || payload.episodeId !== episodeId
    || !isNonEmptyString(payload.sourceRevisionId)
    || payload.entityType !== targetType
    || payload.entityId !== targetId
    || !Array.isArray(payload.candidates)
    || !payload.candidates.every(isHistoricalVisualAssetCandidate)
    || payload.candidates.some((candidate) => (
      candidate.asset.projectId !== projectId
      || candidate.asset.episodeId !== episodeId
      || candidate.currentSourceRevisionId !== payload.sourceRevisionId
    ))) {
    throw new ApiError('服务返回的历史视觉素材候选格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    episodeId,
    sourceRevisionId: payload.sourceRevisionId,
    entityType: targetType,
    entityId: targetId,
    candidates: payload.candidates,
    etag: requiredOpaqueEtag(response, payload, '服务返回的历史素材分集 ETag 无效。'),
  }
}

export async function adoptHistoricalVisualAsset(
  sourceAssetId: string,
  input: AdoptHistoricalVisualAssetInput,
  episodeEtag: string,
  options: RequestOptions & { idempotencyKey?: string } = {},
): Promise<HistoricalVisualAssetAdoption> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/assets/${encoded(sourceAssetId)}/adopt-current-visual-revision`,
    jsonRequestWithHeaders('POST', input, {
      'If-Match': episodeEtag,
      'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID(),
    }),
    options.signal,
  )
  const adoption = isRecord(payload) && hasExactlyKeys(payload, ['adoption'])
    ? payload.adoption
    : null
  if (!isRecord(adoption)
    || !hasExactlyKeys(adoption, [
      'asset',
      'sourceAsset',
      'job',
      'revision',
      'assetFamilyId',
      'assetVersionId',
      'previousAssetVersionId',
      'sourceRevisionId',
      'priorSourceRevisionId',
      'semanticFingerprint',
      'idempotent',
      'providerCallRequired',
    ])
    || !isMediaAsset(adoption.asset)
    || !isMediaAsset(adoption.sourceAsset)
    || !isGenerationJob(adoption.job)
    || !isProjectRevision(adoption.revision)
    || adoption.asset.id !== adoption.assetVersionId
    || adoption.sourceAsset.id !== sourceAssetId
    || adoption.sourceAsset.id !== adoption.previousAssetVersionId
    || adoption.asset.parentAssetId !== sourceAssetId
    || adoption.asset.projectId !== input.projectId
    || adoption.asset.episodeId !== input.episodeId
    || adoption.asset.sourceRevisionId !== adoption.sourceRevisionId
    || adoption.job.type !== 'asset.image.history.adopt'
    || adoption.job.status !== 'succeeded'
    || adoption.job.projectId !== input.projectId
    || adoption.job.episodeId !== input.episodeId
    || !isNonEmptyString(adoption.assetFamilyId)
    || !isNonEmptyString(adoption.sourceRevisionId)
    || !isNonEmptyString(adoption.priorSourceRevisionId)
    || !isString(adoption.semanticFingerprint)
    || !/^[a-f0-9]{64}$/.test(adoption.semanticFingerprint)
    || typeof adoption.idempotent !== 'boolean'
    || adoption.providerCallRequired !== false) {
    throw new ApiError('服务返回的历史视觉素材收养记录格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    ...adoption,
    etag: requiredOpaqueEtag(response, payload, '服务返回的历史素材分集 ETag 无效。'),
  } as HistoricalVisualAssetAdoption
}

function isHistoricalShotVideoCandidate(value: unknown): value is HistoricalShotVideoCandidate {
  return isRecord(value)
    && hasExactlyKeys(value, [
      'asset',
      'priorSourceRevisionId',
      'currentSourceRevisionId',
      'semanticFingerprint',
      'compatibility',
    ])
    && isMediaAsset(value.asset)
    && isNonEmptyString(value.priorSourceRevisionId)
    && isNonEmptyString(value.currentSourceRevisionId)
    && value.priorSourceRevisionId !== value.currentSourceRevisionId
    && isString(value.semanticFingerprint)
    && /^[a-f0-9]{64}$/.test(value.semanticFingerprint)
    && isRecord(value.compatibility)
    && hasExactlyKeys(value.compatibility, [
      'storySnapshot',
      'shotIdentity',
      'providerCallRequired',
    ])
    && value.compatibility.storySnapshot === 'exact'
    && value.compatibility.shotIdentity === 'exact'
    && value.compatibility.providerCallRequired === false
}

export async function listHistoricalShotVideoCandidates(
  projectId: string,
  episodeId: string,
  shotId: string,
  sceneId: string,
  options: RequestOptions = {},
): Promise<HistoricalShotVideoCandidatesResponse> {
  const params = new URLSearchParams({ projectId, episodeId, sceneId })
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/shots/${encoded(shotId)}/video-history?${params}`,
    {},
    options.signal,
  )
  const history = isRecord(payload) && hasExactlyKeys(payload, ['videoHistory'])
    ? payload.videoHistory
    : null
  if (!isRecord(history)
    || !hasExactlyKeys(history, [
      'projectId',
      'episodeId',
      'shotId',
      'sceneId',
      'sourceRevisionId',
      'episodeEtag',
      'candidates',
    ])
    || history.projectId !== projectId
    || history.episodeId !== episodeId
    || history.shotId !== shotId
    || history.sceneId !== sceneId
    || !isNonEmptyString(history.sourceRevisionId)
    || !isOpaqueEtag(history.episodeEtag)
    || !Array.isArray(history.candidates)
    || !history.candidates.every(isHistoricalShotVideoCandidate)
    || history.candidates.some((candidate) => (
      candidate.asset.projectId !== projectId
      || candidate.asset.episodeId !== episodeId
      || candidate.currentSourceRevisionId !== history.sourceRevisionId
    ))) {
    throw new ApiError('服务返回的逐镜视频恢复历史格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const etag = requiredOpaqueEtag(response, payload, '服务返回的历史视频分集 ETag 无效。')
  if (etag !== history.episodeEtag) {
    throw new ApiError('历史视频响应头与正文 ETag 不一致。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    projectId,
    episodeId,
    shotId,
    sceneId,
    sourceRevisionId: history.sourceRevisionId,
    candidates: history.candidates,
    etag,
  }
}

export async function restoreHistoricalShotVideo(
  sourceAssetId: string,
  input: { projectId: string; episodeId: string; shotId: string; sceneId: string },
  episodeEtag: string,
  options: RequestOptions & { idempotencyKey?: string } = {},
): Promise<HistoricalShotVideoRestoration> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/shots/${encoded(input.shotId)}/video-history/${encoded(sourceAssetId)}/restore`,
    jsonRequestWithHeaders('POST', {
      projectId: input.projectId,
      episodeId: input.episodeId,
      sceneId: input.sceneId,
    }, {
      'If-Match': episodeEtag,
      'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID(),
    }),
    options.signal,
  )
  const restoration = isRecord(payload) && hasExactlyKeys(payload, ['restoration'])
    ? payload.restoration
    : null
  if (!isRecord(restoration)
    || !hasExactlyKeys(restoration, [
      'asset',
      'sourceAsset',
      'job',
      'mediaReview',
      'priorSourceRevisionId',
      'currentSourceRevisionId',
      'semanticFingerprint',
      'providerCallRequired',
      'idempotent',
    ])
    || !isMediaAsset(restoration.asset)
    || !isMediaAsset(restoration.sourceAsset)
    || !isGenerationJob(restoration.job)
    || !isRecord(restoration.mediaReview)
    || !isNonEmptyString(restoration.priorSourceRevisionId)
    || !isNonEmptyString(restoration.currentSourceRevisionId)
    || !isString(restoration.semanticFingerprint)
    || !/^[a-f0-9]{64}$/.test(restoration.semanticFingerprint)
    || restoration.providerCallRequired !== false
    || typeof restoration.idempotent !== 'boolean'
    || restoration.sourceAsset.id !== sourceAssetId
    || restoration.asset.parentAssetId !== sourceAssetId
    || restoration.asset.projectId !== input.projectId
    || restoration.asset.episodeId !== input.episodeId
    || restoration.currentSourceRevisionId !== restoration.asset.sourceRevisionId) {
    throw new ApiError('服务返回的逐镜视频恢复结果格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    asset: restoration.asset,
    sourceAsset: restoration.sourceAsset,
    job: restoration.job,
    mediaReview: restoration.mediaReview as unknown as ShotMediaDecisionResult,
    priorSourceRevisionId: restoration.priorSourceRevisionId,
    currentSourceRevisionId: restoration.currentSourceRevisionId,
    semanticFingerprint: restoration.semanticFingerprint,
    providerCallRequired: false,
    idempotent: restoration.idempotent,
    etag: requiredOpaqueEtag(response, payload, '服务返回的恢复后分集 ETag 无效。'),
  }
}

export async function lockAsset(
  assetId: string,
  input: LockAssetInput,
  episodeEtag: string,
  options: RequestOptions = {},
): Promise<AssetLockResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    `/api/v1/assets/${encoded(assetId)}/lock`,
    jsonRequestWithHeaders('POST', input, { 'If-Match': episodeEtag }),
    options.signal,
  )
  if (
    !isRecord(payload)
    || !isMediaAsset(payload.asset)
    || payload.asset.id !== assetId
    || !isRecord(payload.target)
    || payload.target.type !== input.targetType
    || payload.target.id !== input.targetId
    || payload.target.lockedAssetId !== assetId
    || !isRecord(payload.revision)
    || typeof payload.revision.id !== 'string'
    || typeof payload.sourceRevisionId !== 'string'
    || !isStoryStaleResult(payload.stale)
    || typeof payload.idempotent !== 'boolean'
    || typeof payload.auditRevision !== 'boolean'
  ) {
    throw new ApiError('服务返回的资产锁定数据格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const etag = requiredOpaqueEtag(response, payload, '服务返回的资产锁定分集 ETag 无效。')
  const auditRevisionId = response.headers.get('X-Asset-Lock-Revision')?.trim()
  if (
    !auditRevisionId
    || auditRevisionId !== payload.revision.id
  ) {
    throw new ApiError('服务返回的资产锁定修订标识无效。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    ...(payload as unknown as Omit<AssetLockResponse, 'etag' | 'auditRevisionId'>),
    etag,
    auditRevisionId,
  }
}

export async function lockCharacterVisualReferences(
  input: LockCharacterVisualReferencesInput,
  episodeEtag: string,
  options: RequestOptions = {},
): Promise<CharacterVisualReferenceLockResponse> {
  const { payload, response } = await requestWithResponse<unknown>(
    '/api/v1/character-visual-references/lock',
    jsonRequestWithHeaders('POST', input, { 'If-Match': episodeEtag }),
    options.signal,
  )
  const expectedIds = {
    front: input.frontAssetId,
    side: input.sideAssetId,
    back: input.backAssetId,
  } as const
  const assets = isRecord(payload) && isRecord(payload.assets)
    ? payload.assets
    : null
  if (!isRecord(payload)
    || !assets
    || !(['front', 'side', 'back'] as const).every((role) => (
      isMediaAsset(assets[role])
      && assets[role].id === expectedIds[role]
      && assets[role].projectId === input.projectId
      && assets[role].episodeId === input.episodeId
    ))
    || !isRecord(payload.target)
    || payload.target.type !== 'character'
    || payload.target.id !== input.targetId
    || !isString(payload.target.name)
    || !Number.isInteger(payload.target.version)
    || !isNullableString(payload.target.lockedAssetId)
    || !isRecord(payload.target.references)
    || payload.target.references.frontAssetId !== input.frontAssetId
    || payload.target.references.sideAssetId !== input.sideAssetId
    || payload.target.references.backAssetId !== input.backAssetId
    || !isString(payload.target.references.auditRevisionId)
    || !isRecord(payload.revision)
    || payload.revision.projectId !== input.projectId
    || !isString(payload.revision.id)
    || !isString(payload.sourceRevisionId)
    || !isStoryStaleResult(payload.stale)
    || typeof payload.idempotent !== 'boolean'
    || payload.auditRevision !== true) {
    throw new ApiError('服务返回的角色三视图绑定数据格式不正确。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  const etag = requiredOpaqueEtag(response, payload, '服务返回的角色三视图分集 ETag 无效。')
  const auditRevisionId = response.headers.get('X-Character-Visual-References-Revision')?.trim()
  if (!auditRevisionId
    || auditRevisionId !== payload.revision.id
    || auditRevisionId !== payload.target.references.auditRevisionId) {
    throw new ApiError('服务返回的角色三视图审计修订标识无效。', {
      code: 'INVALID_RESPONSE',
      details: payload,
    })
  }
  return {
    assets: payload.assets as unknown as CharacterVisualReferenceLockResponse['assets'],
    target: payload.target as unknown as CharacterVisualReferenceLockResponse['target'],
    revision: payload.revision as unknown as ProjectRevision,
    sourceRevisionId: payload.sourceRevisionId,
    stale: payload.stale,
    idempotent: payload.idempotent,
    auditRevision: true,
    etag,
    auditRevisionId,
  }
}

export function openStudioEventStream(projectId?: string): EventSource {
  const params = new URLSearchParams()
  if (projectId) params.set('projectId', projectId)
  return new EventSource(`/api/v1/events${params.size ? `?${params}` : ''}`)
}

export const api = {
  getHealth,
  parsePaidAigcConfirmationRequiredError,
  preflightAssetImageJob,
  createAssetImageJob,
  listImageJobs,
  getImageJob,
  retryImageJob,
  listProviders,
  saveProviderCredentials,
  deleteProviderCredentials,
  testProvider,
  setDefaultProvider,
  startProviderAuth,
  listMiniMaxVoices,
  listSpeechVoices,
  getProjectNarratorVoiceProfile,
  putProjectNarratorVoiceProfile,
  deleteProjectNarratorVoiceProfile,
  preflightProjectNarratorVoicePreview,
  createProjectNarratorVoicePreview,
  getProjectNarratorVoicePreviewJob,
  listProjectNarratorVoicePreviewJobs,
  createCharacterVoiceRecommendation,
  getCharacterVoiceRecommendationJob,
  preflightCharacterVoicePreview,
  createCharacterVoicePreview,
  getCharacterVoicePreviewJob,
  listCharacterVoicePreviewJobs,
  createVoicePreviewReview,
  listVoicePreviewReviews,
  putCharacterVoiceProfile,
  listGenerationJobs,
  getGenerationJob,
  retryGenerationJob,
  cancelGenerationJob,
  listProjects,
  createProject,
  getProjectSnapshot,
  updateProjectSnapshot,
  getProjectKnowledgeSnapshot,
  updateProjectKnowledgeSnapshot,
  importProjectSourceText,
  listProjectKnowledgeRevisions,
  restoreProjectKnowledgeRevision,
  listProjectEpisodes,
  createEpisode,
  getEpisode,
  updateEpisode,
  getStory,
  searchStoryEntities,
  generateStory,
  restoreStoryRevision,
  updateStoryScene,
  createStoryShot,
  reorderStoryShots,
  updateStoryShot,
  deleteStoryShot,
  getShotMediaReview,
  decideShotMediaReview,
  createShotVideoGenerationJob,
  resolveShotVideoUnknownSubmission,
  createShotVideoVisualReferenceAnalysis,
  createShotVideoVisualReferenceAnalysisBatch,
  listShotVideoVisualReferenceAnalyses,
  getShotVideoVisualReferenceAnalysisBatch,
  getShotVideoVisualReferenceAnalysisJob,
  getShotVideoReferenceRecommendation,
  preflightShotVideoBatch,
  createShotVideoBatch,
  getDialoguePerformanceProfile,
  createDialoguePerformanceRecommendation,
  getDialoguePerformanceRecommendationJob,
  putDialoguePerformanceProfile,
  deleteDialoguePerformanceProfile,
  preflightDialogueSpeechGenerationJob,
  createDialogueSpeechGenerationJob,
  getTimelineDocument,
  saveTimelineDocument,
  materializeTimelineDocument,
  reconcileTimelineDocument,
  previewTimelineAutomaticEdit,
  applyTimelineAutomaticEdit,
  undoTimelineAutomaticEdit,
  createExportRender,
  getExportRender,
  createQualityCheck,
  getQualityReport,
  createReleaseReview,
  listReleaseReviews,
  preflightPipelineRun,
  createPipelineRun,
  getPipelineRun,
  listPipelineRuns,
  cancelPipelineRun,
  listTimelineDocumentRevisions,
  restoreTimelineDocumentRevision,
  listProjectRevisions,
  restoreProjectRevision,
  listStoryRevisions,
  uploadUserAudio,
  listAssets,
  getAsset,
  listAssetHandles,
  listAssetHandleVersions,
  switchAssetHandleCurrentVersion,
  getProductionAssetManifest,
  materializeProductionAssetManifest,
  preflightAssetImageEdit,
  createAssetImageEdit,
  createAssetTurnaroundDerivation,
  listVisualAssetTargets,
  listHistoricalVisualAssetCandidates,
  adoptHistoricalVisualAsset,
  listHistoricalShotVideoCandidates,
  restoreHistoricalShotVideo,
  lockAsset,
  lockCharacterVisualReferences,
  openStudioEventStream,
}
