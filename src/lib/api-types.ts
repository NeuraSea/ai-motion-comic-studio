export type ProviderStatus = 'ok' | 'degraded' | 'unavailable'

export interface ProviderHealth {
  name: string
  configured: boolean
  model: string
  status?: ProviderStatus
  message?: string
}

export interface QueueHealth {
  running: boolean
  pending: number
}

export interface HealthResponse {
  status: 'ok' | 'degraded'
  service: string
  provider: ProviderHealth
  queue: QueueHealth
  uptimeSeconds: number
  database?: {
    status: 'ok' | 'unavailable'
    schemaVersion?: number
    message?: string
  }
  worker?: {
    started: boolean
    active: number
    pending: number
    concurrency: number
  }
}

export type ImageSize = '1024x1024' | '1536x1024' | '1024x1536' | 'auto'
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto'
export type ImageCount = 1 | 2 | 3 | 4

export interface GenerateImageInput {
  prompt: string
  size?: ImageSize
  quality?: ImageQuality
  count?: ImageCount
  metadata?: Record<string, unknown>
}

/** Exact JSON body shared by image-generation preflight and paid submit. */
export interface AssetImageGenerationRequest {
  projectId: string
  episodeId?: string
  providerId?: string
  input: GenerateImageInput
}

export type JobStatus = 'queued' | 'running' | 'waiting_provider' | 'succeeded' | 'failed' | 'cancelled'
export type ImageJobStatus = JobStatus

/** Server-authoritative action allowed for a terminal durable Job. */
export type JobRetryDisposition =
  | 'generic-free-retry'
  | 'resume-existing-provider-task'
  | 'paid-reconfirmation-required'
  | 'manual-resolution'
  | 'not-retryable'

export interface GeneratedImage {
  id: string
  url: string
  mimeType: string
  width?: number
  height?: number
  revisedPrompt?: string
}

export interface ImageJobOutput {
  images: GeneratedImage[]
}

export interface ImageJobError {
  code: string
  message: string
  retryable: boolean
}

export interface ImageJob {
  id: string
  type: 'image.generate' | 'asset.image.generate'
  status: ImageJobStatus
  progress: number
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  attempt: number
  input: GenerateImageInput
  output?: ImageJobOutput
  error?: ImageJobError
  retryOf?: string
}

export interface GenerationJobCancellation {
  localProcessing: 'stopped'
  upstreamCancellation:
    | 'not-submitted'
    | 'not-supported'
    | 'request-pending'
    | 'request-sent'
    | 'not-found'
    | 'request-failed'
    | 'unknown'
  providerTaskMayContinue: boolean
  chargesMayStillApply: boolean
  message: string
}

export interface GenerationJobProviderDiagnostic {
  operation: 'create'
  protocol: 'ark' | 'newapi'
  endpointFamily: 'ark-tasks' | 'openai-videos'
  httpStatus: number
  providerCode?: string
  observedAt: string
}

/**
 * Server-authored platform policy. It does not promise that a BYOK/BYOA
 * upstream account will not charge for the underlying Provider request.
 */
export interface ProviderPlatformCostPolicy {
  version: 1
  costClass: 'free-llm' | 'billable-media'
  billable: boolean
  paidConfirmationRequired: boolean
  upstreamProviderBilling: 'outside-platform-policy'
}

export type GenerationJobCost = Record<string, unknown> & {
  platformPolicy?: ProviderPlatformCostPolicy
}

export interface GenerationJob<TInput = Record<string, unknown>, TOutput = unknown> {
  id: string
  projectId: string
  episodeId?: string | null
  pipelineRunId?: string | null
  type: string
  status: JobStatus
  progress: number
  resourceType?: string | null
  resourceId?: string | null
  providerId?: string | null
  model?: string | null
  /** Immutable provider connection revision captured when the job is created. */
  providerConfigRevision?: number | null
  externalTaskId?: string | null
  idempotencyKey?: string | null
  retryOf?: string | null
  attempt: number
  input: TInput
  progressDetail?: Record<string, unknown> | null
  output?: TOutput | null
  error?: (ImageJobError & { category?: string }) | null
  /** Provider usage plus a namespaced platform policy; never an authority for retry. */
  cost?: GenerationJobCost | null
  /** Never infer this from error.retryable; paid retry safety is server-owned. */
  retryDisposition: JobRetryDisposition
  /** Safe cancellation audit; currently emitted for locally-stopped Seedance jobs. */
  cancellation?: GenerationJobCancellation
  /** Sanitized Provider response metadata; never includes headers, bodies, URLs, or credentials. */
  providerDiagnostic?: GenerationJobProviderDiagnostic
  /** Present only after the server has revalidated the immutable manual-resolution audit. */
  unknownSubmissionResolution?: ShotVideoUnknownSubmissionResolution
  /**
   * Sanitized, server-authored recovery evidence for an audio timing drift.
   * Its presence never authorizes a Provider retry; the user must return to
   * audio, review the affected lines, and explicitly run a fresh preflight.
   */
  timingRemediation?: ShotVideoTimingRemediation
  createdAt: string
  updatedAt: string
  startedAt?: string | null
  completedAt?: string | null
}

/** Billable AIGC operation authenticated by the shared server confirmation gate. */
export type PaidAigcAction =
  | 'asset.image.generate'
  | 'asset.image.edit'
  | 'dialogue.speech.generate'
  | 'project.narrator.voice.preview'
  | 'character.voice.preview'

/**
 * Public, short-lived projection of one exact server-authored paid intent.
 * Private prompt/source material is authenticated by intentFingerprint and is
 * never returned to the browser.
 */
export interface PublicPaidAigcConfirmation {
  version: 1
  action: PaidAigcAction
  label: string
  billableTaskCount: 1
  provider: {
    providerId: string
    model: string
    configRevision: number
  }
  intentFingerprint: string
  expiresAt: string
  confirmationToken: string
  priceEstimate: null
  priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE'
}

export type ProviderKind = 'text' | 'image' | 'video' | 'speech'
export type ProviderAuthMode = 'byoa' | 'byok'
export type ProviderConnectionState = 'external' | 'present' | 'missing'

export interface ProviderConnection {
  id: string
  label: string
  kind: ProviderKind
  adapter: 'codex-tools' | 'openai-compatible' | 'seedance' | 'minimax' | 'indextts' | 'doubao-speech'
  authMode: ProviderAuthMode
  baseUrl: string
  model: string
  capabilities: string[]
  configurableBaseUrl: boolean
  enabled: boolean
  configRevision: number
  isDefault: boolean
  credentialState: ProviderConnectionState
  health: {
    status: 'untested' | ProviderStatus
    message: string
    testedAt?: string
  }
}

export interface SaveProviderCredentialsInput {
  apiKey?: string
  baseUrl?: string
  model?: string
  enabled?: boolean
}

export interface ProjectSummary {
  id: string
  title: string
  currentEpisodeId: string | null
  currentRevisionId: string | null
  settings: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ProjectRevision {
  id: string
  projectId: string
  parentRevisionId: string | null
  summary: string
  snapshot?: Record<string, unknown>
  createdAt: string
}

/** Episode-scoped Story history; unlike project revisions it is safe to restore. */
export interface StoryRevisionHistory {
  episodeId: string
  revisionId: string | null
  revisions: ProjectRevision[]
  etag: string
}

export interface ProjectSnapshot {
  project: ProjectSummary
  revision: ProjectRevision
  document: Record<string, unknown>
  etag: string
}

/** Independent project-global knowledge head; never follows Story/voice/asset audit revisions. */
export interface ProjectKnowledgeSnapshot {
  project: ProjectSummary
  revision: ProjectRevision | null
  document: Record<string, unknown>
  etag: string
}

export interface EpisodeSummary {
  id: string
  projectId: string
  title: string
  sourceText: string
  targetDurationSeconds: number | null
  aspectRatio: string
  stylePreset: string
  status: string
  sortOrder: number
  sourceRevisionId: string | null
  createdAt: string
  updatedAt: string
}

export type DialogueKind = 'dialogue' | 'narration'

export interface StoryDialogueLine {
  id: string
  sequence: number
  kind: DialogueKind
  speaker: string
  text: string
}

export interface StoryShot {
  id: string
  sequence: number
  code: string
  title: string
  description: string
  framing: string
  movement: string
  transition: string
  durationSeconds: number
  visualPrompt: string
  dialogueLines: StoryDialogueLine[]
}

export interface StoryScene {
  id: string
  sequence: number
  title: string
  locationId: string
  timeOfDay: string
  description: string
  shots: StoryShot[]
}

export type StoryCharacterVoiceSelectionSource = 'manual' | 'agentic'
export type StoryCharacterVoiceType = 'system' | 'voice_cloning' | 'voice_generation'
export type StoryCharacterVoiceEmotion = DialogueSpeechEmotion

export interface StoryCharacterVoiceDelivery {
  emotion: StoryCharacterVoiceEmotion
  speed: number
  pitch: number
}

/**
 * Auditable character-level casting snapshot. The credential itself stays in
 * Keychain; providerConfigRevision identifies the immutable configuration
 * against which this voice was selected.
 */
export interface StoryCharacterVoiceProfile {
  version: 1
  voiceId: string
  providerId: string
  providerConfigRevision: number
  voiceType: StoryCharacterVoiceType
  voiceName: string
  descriptions: string[]
  selectionSource: StoryCharacterVoiceSelectionSource
  selectionRationale?: string
  profileTags?: string[]
  defaultDelivery?: StoryCharacterVoiceDelivery
  sceneDirections?: Array<StoryCharacterVoiceDelivery & {
    sceneId: string
    rationale: string
  }>
  recommendationJobId?: string
  catalogFingerprint: string
  catalogObservedAt: string
  historicalPin: boolean
  updatedAt: string
}

export interface StoryCharacter {
  id: string
  name: string
  role: string
  storyDescription: string
  visualDescription: string
  voiceProfile?: StoryCharacterVoiceProfile
}

export interface MiniMaxVoiceCatalogEntry {
  voiceId: string
  name: string
  descriptions: string[]
  type: StoryCharacterVoiceType
}

export interface MiniMaxVoiceCatalog {
  provider: {
    id: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
    configRevision: number
    model: string
  }
  observedAt: string
  fingerprint: string
  voices: MiniMaxVoiceCatalogEntry[]
}

export interface CharacterVoiceRecommendation {
  version: 'character-voice-agent-v1'
  catalogFingerprint: string
  selectedVoiceId: string
  rationale: string
  profileTags: string[]
  alternatives: Array<{
    voiceId: string
    rationale: string
  }>
  defaultDelivery: StoryCharacterVoiceDelivery
  sceneDirections: Array<StoryCharacterVoiceDelivery & {
    sceneId: string
    rationale: string
  }>
}

export interface CharacterVoiceRecommendationJobInput {
  episodeId: string
  characterId: string
  expectedStoryRevisionId: string
  catalog: {
    providerId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
    providerConfigRevision: number
    fingerprint: string
    voiceCount: number
  }
}

export interface CharacterVoiceRecommendationJobOutput {
  characterId: string
  recommendation: CharacterVoiceRecommendation
}

export type CharacterVoiceRecommendationJob = GenerationJob<
  CharacterVoiceRecommendationJobInput,
  CharacterVoiceRecommendationJobOutput
> & { type: 'character.voice.recommend' }

/** Public, redacted durable input. Preview text is always selected server-side. */
export interface CharacterVoicePreviewJobInput {
  episodeId: string
  characterId: string
  expectedStoryRevisionId: string
  voiceId: string
  expectedCatalogFingerprint: string
  expectedProviderConfigRevision: number
}

export interface CharacterVoicePreviewJobOutput {
  characterId: string
  voiceId: string
  sampleSource: 'dialogue' | 'fallback'
  sampleCharacterCount: number
  asset: MediaAsset & {
    episodeId: string
    kind: 'character.voice.preview'
    mimeType: 'audio/mpeg'
    source: 'provider'
  }
  provider: {
    id: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
    model: string
    configRevision: number
  }
}

export type CharacterVoicePreviewJob = GenerationJob<
  CharacterVoicePreviewJobInput,
  CharacterVoicePreviewJobOutput
> & { type: 'character.voice.preview' }

/** Public, redacted durable input. Preview text is always selected server-side. */
export interface ProjectNarratorVoicePreviewJobInput {
  episodeId: string
  expectedStoryRevisionId: string
  voiceId: string
  expectedCatalogFingerprint: string
  expectedProviderConfigRevision: number
}

export interface ProjectNarratorVoicePreviewJobOutput {
  episodeId: string
  voiceId: string
  sampleSource: 'narration' | 'fallback'
  sampleCharacterCount: number
  asset: MediaAsset & {
    episodeId: string
    kind: 'project.narrator.voice.preview'
    mimeType: 'audio/mpeg'
    source: 'provider'
  }
  provider: {
    id: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
    model: string
    configRevision: number
  }
}

export type ProjectNarratorVoicePreviewJob = GenerationJob<
  ProjectNarratorVoicePreviewJobInput,
  ProjectNarratorVoicePreviewJobOutput
> & { type: 'project.narrator.voice.preview' }

export type VoicePreviewReviewDecision = 'approve' | 'reject'
export type VoicePreviewReviewInvalidReason =
  | 'SUPERSEDED'
  | 'STORY_REVISION_CHANGED'
  | 'PROVIDER_REVISION_CHANGED'
  | 'PREVIEW_BINDING_CHANGED'
  | 'PLAYBACK_EVIDENCE_LEGACY'

export interface VoicePreviewReview {
  id: string
  projectId: string
  episodeId: string
  subjectType: 'character' | 'project_narrator'
  subjectId: string
  previewJobId: string
  previewAssetId: string
  previewAssetChecksum: string
  voiceId: string
  providerId: string
  model: string
  providerConfigRevision: number
  catalogFingerprint: string
  storyRevisionId: string
  decision: VoicePreviewReviewDecision
  notes: string | null
  playbackCompletedAt: string
  playbackEvidence: {
    version: 'legacy-ended-v1' | 'html-media-played-v1'
    durationSeconds?: number
    ranges?: Array<{ startSeconds: number; endSeconds: number }>
  }
  reviewedAt: string
  isCurrent: boolean
  invalidReasons: VoicePreviewReviewInvalidReason[]
}

export interface CreateVoicePreviewReviewInput {
  projectId: string
  decision: VoicePreviewReviewDecision
  playbackCompleted: true
  playbackEvidence: {
    version: 'html-media-played-v1'
    durationSeconds: number
    ranges: Array<{ startSeconds: number; endSeconds: number }>
  }
  notes?: string | null
}

export interface PutCharacterVoiceProfileInput {
  projectId: string
  providerId?: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
  voiceId: string
  selectionSource: StoryCharacterVoiceSelectionSource
  selectionRationale?: string
  recommendationJobId?: string
  allowHistoricalPin?: boolean
  expectedProviderConfigRevision?: number
}

export interface CharacterVoiceProfileMutationResponse {
  episode: Pick<EpisodeSummary, 'id' | 'projectId' | 'sourceRevisionId' | 'updatedAt'>
  character: Pick<StoryCharacter, 'id' | 'name' | 'role'>
  voiceProfile: StoryCharacterVoiceProfile
  revisionId: string
  stale: {
    speechAssets: number
    exportAssets: number
    jobs: number
    dialogueLines: number
    exports: number
    qualityReports: number
    pipelineRuns: number
  }
  etag: string
}

/**
 * Project-wide narrator casting is versioned independently from the project
 * document and every episode Story. `etag` is the opaque project-settings
 * version returned by the dedicated narrator endpoint.
 */
export interface ProjectNarratorVoiceProfileState {
  project: {
    id: string
    title: string
    currentRevisionId: string | null
    updatedAt: string
  }
  voiceProfile: StoryCharacterVoiceProfile | null
  revisionId: string | null
  etag: string
}

export interface PutProjectNarratorVoiceProfileInput {
  providerId?: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
  voiceId: string
  expectedCatalogFingerprint: string
  expectedProviderConfigRevision: number
}

export interface ProjectNarratorVoiceProfileStaleResult {
  speechAssets: number
  exportAssets: number
  jobs: number
  narrationLines: number
  exports: number
  qualityReports: number
  pipelineRuns: number
}

export interface ProjectNarratorVoiceProfileMutationResponse
  extends ProjectNarratorVoiceProfileState {
  revisionId: string
  stale: ProjectNarratorVoiceProfileStaleResult
}

export interface StoryLocation {
  id: string
  name: string
  storyDescription: string
  visualDescription: string
}

export interface StoryProp {
  id: string
  name: string
  description: string
  visualDescription: string
}

export interface StoryDocument {
  version: 1
  title: string
  targetDurationSeconds: number
  bible: {
    logline: string
    theme: string
    tone: string
    visualStyle: string
  }
  characters: StoryCharacter[]
  locations: StoryLocation[]
  props: StoryProp[]
  scenes: StoryScene[]
}

export type StoryEntityType =
  | 'scene'
  | 'shot'
  | 'dialogue'
  | 'character'
  | 'location'
  | 'prop'

/** One result from the current Episode Story's SQLite projection. */
export interface StoryEntitySearchResult {
  entityId: string
  type: StoryEntityType
  title: string
  snippet: string
  sceneId: string | null
  shotId: string | null
  /** Every hit is pinned to the current immutable Episode Story revision. */
  sourceRevisionId: string
}

export interface StoryEntitySearchPage {
  episodeId: string
  projectId: string
  sourceRevisionId: string
  /** NFC-normalized, trimmed query actually executed by the server. */
  query: string
  limit: number
  offset: number
  total: number
  hasMore: boolean
  results: StoryEntitySearchResult[]
}

export interface StoryEntitySearchResponse extends StoryEntitySearchPage {
  /** Opaque current Episode ETag observed with this search page. */
  etag: string
}

type RequireAtLeastOne<T, Keys extends keyof T = keyof T> =
  Keys extends keyof T
    ? Required<Pick<T, Keys>> & Partial<Omit<T, Keys>>
    : never

export interface StoryStaleResult {
  assets: number
  jobs: number
  exports: number
  qualityReports: number
  pipelineRuns: number
}

/** Common body returned by every persisted scene/shot mutation. */
export interface StoryMutationResponse {
  episode: EpisodeSummary
  story: StoryDocument
  revisionId: string
  stale: StoryStaleResult
  /** The authoritative response ETag; pass it to the next mutation's If-Match. */
  etag: string
}

export type StoryScenePatchInput = RequireAtLeastOne<Pick<
  StoryScene,
  'title' | 'locationId' | 'timeOfDay' | 'description'
>>

export type StoryShotPatchInput = RequireAtLeastOne<Pick<
  StoryShot,
  | 'code'
  | 'title'
  | 'description'
  | 'framing'
  | 'movement'
  | 'transition'
  | 'durationSeconds'
  | 'visualPrompt'
  | 'dialogueLines'
>>

export interface UpdateStorySceneInput {
  episodeId: string
  projectId?: string
  patch: StoryScenePatchInput
  summary?: string
}

export interface UpdateStoryShotInput {
  episodeId: string
  projectId?: string
  /** Disambiguates a shot ID that is reused in more than one scene. */
  sceneId?: string
  patch: StoryShotPatchInput
  summary?: string
}

export interface CreateStoryShotInput {
  episodeId: string
  projectId?: string
  sceneId: string
  shot: Omit<StoryShot, 'sequence'>
  /** Zero-based insertion point. Omit to append. */
  index?: number
  summary?: string
}

export interface ReorderStoryShotsInput {
  episodeId: string
  projectId?: string
  sceneId: string
  /** Must contain every shot in the scene exactly once. */
  shotIds: string[]
  summary?: string
}

export interface DeleteStoryShotInput {
  episodeId: string
  projectId?: string
  /** Disambiguates a shot ID that is reused in more than one scene. */
  sceneId?: string
  summary?: string
}

export interface StorySceneMutationResponse extends StoryMutationResponse {
  scene: StoryScene
}

export interface StoryShotMutationResponse extends StoryMutationResponse {
  shot: StoryShot
}

export interface CreateStoryShotResponse extends StoryMutationResponse {
  scene: StoryScene
  shot: StoryShot
}

export interface DeleteStoryShotResponse extends StoryMutationResponse {
  deletedShotId: string
  /** Present when sceneId was supplied in the delete request. */
  scene?: StoryScene
}

export interface TimelineDocumentRecord {
  id: string
  projectId: string
  episodeId: string
  currentRevisionId: string
  schemaVersion: number
  upstreamCommit: string
  sourceRevisionId: string | null
  createdAt: string
  updatedAt: string
}

export interface TimelineDocumentRevision {
  id: string
  documentId: string
  projectId: string
  episodeId: string
  parentRevisionId: string | null
  schemaVersion: number
  upstreamCommit: string
  sourceRevisionId: string | null
  summary: string
  snapshot: Record<string, unknown>
  createdAt: string
}

export interface TimelineDocumentSnapshot {
  timelineDocument: TimelineDocumentRecord
  revision: TimelineDocumentRevision
  document: Record<string, unknown>
  etag: string
}

export interface TimelineDocumentHistory {
  timelineDocument: TimelineDocumentRecord
  revisions: TimelineDocumentRevision[]
  /** Authoritative head ETag observed while this immutable history page was read. */
  etag: string
}

export interface TimelineRevisionRestoreRecord {
  id: string
  documentId: string
  projectId: string
  episodeId: string
  baseRevisionId: string
  targetRevisionId: string
  resultRevisionId: string
  createdAt: string
}

export interface RestoreTimelineRevisionInput {
  projectId: string
  documentId: string
  summary?: string
}

export interface TimelineRevisionRestoreResult {
  /** Current authoritative head at response time. */
  timeline: TimelineDocumentSnapshot
  /** Immutable revision created by the original restore operation. */
  operationResultTimeline: TimelineDocumentSnapshot
  /** True only when an idempotent replay observes that the head advanced later. */
  headAdvanced: boolean
  restore: TimelineRevisionRestoreRecord
  idempotent: boolean
}

export interface TimelineStoryShotReference {
  sceneId: string
  shotId: string
}

export interface TimelineReconciliationReport {
  operation: 'materialize' | 'reconcile'
  sourceRevisionId: string
  previousSourceRevisionId: string | null
  changed: boolean
  preservedElementIds: string[]
  appendedShots: Array<TimelineStoryShotReference & { elementId: string }>
  orphanedElements: Array<{
    sceneId: string | null
    shotId: string
    elementId: string
  }>
  preservedAbsentShots: TimelineStoryShotReference[]
  unresolvedShots: TimelineStoryShotReference[]
  automaticEdit?: TimelineAutomaticEditReceipt | null
}

export interface OpenCutElementTimingSnapshot {
  startTime: number
  duration: number
  trimStart: number
  trimEnd: number
}

export interface TimelineAutomaticEditOperation {
  kind: 'update-element-timing'
  trackId: string
  elementId: string
  reason: string
  before: OpenCutElementTimingSnapshot
  after: OpenCutElementTimingSnapshot
}

export interface TimelineAutomaticEditReceipt {
  version: 1
  strategy: 'managed-dialogue-reflow-v1'
  executor: 'OpenCut-Classic/UpdateElementsCommand'
  upstreamCommit: string
  baseRevisionId: string | null
  sourceRevisionId: string
  planHash: string
  risk: 'safe'
  policy: 'auto-applied'
  operationCount: number
  changedElementIds: string[]
  operations: TimelineAutomaticEditOperation[]
  /** Present for an explicitly applied plan and used for persistent undo. */
  applicationId?: string
  planId?: string
}

export type TimelineAutoEditGoal = 'exportable'
export type TimelineAutoEditPolicy = 'safe'
export type TimelineAutoEditRisk = 'safe' | 'blocked'

export interface TimelineAutoEditDiagnostic {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
  elementIds: string[]
}

/**
 * Immutable, server-authored plan. The client may display this data, but must
 * never send the operations or preview document back to the server.
 */
export interface TimelineAutoEditPlan {
  id: string
  projectId: string
  episodeId: string
  documentId: string
  baseRevisionId: string
  sourceRevisionId: string | null
  goal: TimelineAutoEditGoal
  policy: TimelineAutoEditPolicy
  strategy: 'managed-dialogue-reflow-v1'
  executor: 'OpenCut-Classic/UpdateElementsCommand'
  upstreamCommit: string
  schemaVersion: number
  planHash: string
  risk: TimelineAutoEditRisk
  diagnostics: TimelineAutoEditDiagnostic[]
  operations: TimelineAutomaticEditOperation[]
  changedElementIds: string[]
  confirmationToken: string
  createdAt: string
}

export interface PreviewTimelineAutoEditInput {
  goal: TimelineAutoEditGoal
  policy: TimelineAutoEditPolicy
}

export interface TimelineAutoEditPreview {
  timeline: TimelineDocumentSnapshot
  plan: TimelineAutoEditPlan
  previewDocument: Record<string, unknown>
  diagnostics: TimelineAutoEditDiagnostic[]
  operations: TimelineAutomaticEditOperation[]
  risk: TimelineAutoEditRisk
  changedElementIds: string[]
}

export interface ApplyTimelineAutoEditInput {
  planId: string
  confirmationToken: string
}

export interface TimelineEditApplication {
  id: string
  planId: string
  documentId: string
  projectId: string
  episodeId: string
  baseRevisionId: string
  resultRevisionId: string
  createdAt: string
}

export interface TimelineAutoEditApplyResult {
  /** Current authoritative timeline head; response ETag always matches this snapshot. */
  timeline: TimelineDocumentSnapshot
  /** Immutable revision originally produced by the apply operation. */
  operationResultTimeline: TimelineDocumentSnapshot
  /** Whether current head has advanced beyond operationResultTimeline. */
  headAdvanced: boolean
  application: TimelineEditApplication
  plan: Omit<TimelineAutoEditPlan, 'confirmationToken'>
  diagnostics: TimelineAutoEditDiagnostic[]
  operations: TimelineAutomaticEditOperation[]
  risk: 'safe'
  changedElementIds: string[]
  idempotent: boolean
}

export interface TimelineEditUndoRecord {
  id: string
  applicationId: string
  documentId: string
  projectId: string
  episodeId: string
  baseRevisionId: string
  resultRevisionId: string
  createdAt: string
}

export interface TimelineAutoEditUndoResult {
  /** Current authoritative timeline head; response ETag always matches this snapshot. */
  timeline: TimelineDocumentSnapshot
  /** Immutable revision originally produced by the undo operation. */
  operationResultTimeline: TimelineDocumentSnapshot
  /** Whether current head has advanced beyond operationResultTimeline. */
  headAdvanced: boolean
  application: TimelineEditApplication
  undo: TimelineEditUndoRecord
  idempotent: boolean
}

export interface TimelineMaterializationSnapshot extends TimelineDocumentSnapshot {
  created: boolean
  report: TimelineReconciliationReport
}

export interface CreateEpisodeInput {
  id?: string
  title: string
  sourceText: string
  targetDurationSeconds: number
  aspectRatio: '16:9' | '9:16' | '1:1'
  stylePreset: string
}

export interface SaveTimelineDocumentInput {
  projectId: string
  schemaVersion: number
  upstreamCommit: string
  summary?: string
  document: Record<string, unknown>
}

export interface SpeechSubtitleCue {
  text: string
  startMs: number
  endMs: number
}

export type SpeechSubtitleDocument = {
  version: 1
  lineId: string
  mode: 'word'
  granularity: 'word' | 'sentence'
  cues: SpeechSubtitleCue[]
} | {
  version: 1
  lineId: string
  mode: 'sentence-fallback'
  reason: string
}

export interface MediaAsset {
  id: string
  projectId: string
  episodeId: string | null
  kind: string
  version: number
  status: string
  mimeType: string | null
  width: number | null
  height: number | null
  durationSeconds: number | null
  checksum: string | null
  source: string
  providerId: string | null
  generationJobId: string | null
  sourceRevisionId: string | null
  parentAssetId: string | null
  /** Strong metadata ETag required by immutable image edit/variation requests. */
  etag?: string
  originalFileName?: string
  /** Sanitized speech timing metadata; never exposes generation parameters or credentials. */
  speechSubtitle?: SpeechSubtitleDocument
  url: string
  createdAt: string
  updatedAt: string
}

/** Stable project-level material identity. currentVersion is mutable; every
 * MediaAsset version and every production pin remains immutable. */
export interface AssetBusinessBinding {
  domain: 'character' | 'location' | 'prop' | 'shot' | 'dialogue' | 'audio' | 'export' | 'document' | 'other' | 'archive'
  groupKey: string
  groupLabel: string
  episodeId: string | null
  sceneId: string | null
  shotId: string | null
  lineId: string | null
  entityType: 'character' | 'location' | 'prop' | null
  entityId: string | null
  role: string | null
}

export interface AssetHandle {
  assetId: string
  projectId: string
  kind: string
  currentAssetVersionId: string | null
  revision: number
  versionCount: number
  /** Sanitized business owner used by the project Catalog hierarchy. */
  businessBinding: AssetBusinessBinding
  etag: string
  currentVersion: MediaAsset | null
  createdAt: string
  updatedAt: string
}

/** Membership ordinal is authoritative inside one stable Asset handle. Do not
 * infer ordering or uniqueness from the legacy MediaAsset.version field. */
export interface AssetHandleVersion {
  assetId: string
  assetVersionId: string
  versionNumber: number
  checksum: string | null
  createdAt: string
  version: MediaAsset
}

export interface AssetHandleVersionsResponse {
  asset: AssetHandle
  versions: AssetHandleVersion[]
}

export interface ProductionAssetManifestContext {
  schemaVersion: 1
  projectId: string
  episodeId: string
  sourceRevisionId: string | null
  projectRevisionId: string | null
  timelineRevisionId: string | null
  narratorVoiceProfileRevisionId: string | null
  characterVoiceProfileRevisions: Record<string, string>
}

export interface ProductionAssetManifestEntry {
  slotKey: string
  role: string
  assetId: string
  assetVersionId: string
  versionNumber: number
  checksum: string
  kind: string
  mimeType: string | null
  sourceRevisionId: string | null
  providerId: string | null
  providerModel: string | null
  providerConfigRevision: number | null
  metadata: Record<string, unknown>
}

export interface ProductionAssetManifestBlocker {
  code: string
  slotKey: string | null
  assetVersionId: string | null
  message: string
}

export interface ProductionAssetManifest {
  id: string
  projectId: string
  episodeId: string
  revisionNumber: number
  parentManifestId: string | null
  sourceRevisionId: string
  projectRevisionId: string | null
  timelineRevisionId: string | null
  fingerprint: string
  entryCount: number
  context: ProductionAssetManifestContext
  summary: string
  idempotencyKey: string
  entries: ProductionAssetManifestEntry[]
  createdAt: string
}

export interface ProductionAssetManifestProjection {
  status: 'missing' | 'current' | 'changed' | 'blocked'
  fingerprint: string
  context: ProductionAssetManifestContext
  entries: ProductionAssetManifestEntry[]
  blockers: ProductionAssetManifestBlocker[]
  latestManifest: ProductionAssetManifest | null
}

export interface ProductionAssetManifestProjectionResponse {
  projection: ProductionAssetManifestProjection
  episodeEtag: string
}

export interface MaterializeProductionAssetManifestResponse {
  manifest: ProductionAssetManifest
  idempotent: boolean
  providerCallRequired: false
}

export interface AssetVersionSwitch {
  id: string
  assetId: string
  previousAssetVersionId: string | null
  selectedAssetVersionId: string
  selectedAssetVersionChecksum: string | null
  handleRevision: number
  changed: boolean
  createdAt: string
  idempotent: boolean
  providerCallRequired: false
}

export interface AssetVersionSwitchResponse {
  asset: AssetHandle
  switch: AssetVersionSwitch
}

export type AssetImageEditMode = 'edit' | 'variation'

export interface CreateAssetImageEditInput {
  projectId: string
  mode: AssetImageEditMode
  prompt: string
  size: ImageSize
  quality: ImageQuality
  /** Additional controlled references. Native variation forbids these. */
  referenceAssetIds: string[]
  providerId?: string
}

export type TurnaroundReferenceRole = 'front' | 'side' | 'back'

export interface NormalizedTurnaroundCropInput {
  role: TurnaroundReferenceRole
  x: number
  y: number
  width: number
  height: number
}

export interface CreateAssetTurnaroundDerivationInput {
  projectId: string
  crops: NormalizedTurnaroundCropInput[]
}

export type UserAudioAssetKind = 'bgm' | 'sfx'
export type UserAudioMimeType = 'audio/mpeg' | 'audio/wav'

/** A server-validated, immutable audio upload owned by one project episode. */
export interface UserAudioAsset extends MediaAsset {
  episodeId: string
  kind: UserAudioAssetKind
  status: 'ready'
  mimeType: UserAudioMimeType
  width: null
  height: null
  durationSeconds: number
  checksum: string
  source: 'upload'
  providerId: null
  generationJobId: null
  sourceRevisionId: null
  parentAssetId: null
}

export type VisualAssetTargetType = 'character' | 'location' | 'prop'

/** Normalized story entity and its current immutable visual lock. */
export interface VisualAssetTarget {
  type: VisualAssetTargetType
  id: string
  name: string
  description: string
  visualDescription: string
  role: string | null
  version: number
  lockedAssetId: string | null
  lockedReferences?: {
    frontAssetId: string | null
    sideAssetId: string | null
    backAssetId: string | null
  }
}

export interface VisualAssetTargetsResponse {
  episodeId: string
  sourceRevisionId: string
  targets: VisualAssetTarget[]
}

export interface HistoricalVisualAssetCompatibility {
  entityIdentity: 'exact'
  visualSemantics: 'exact'
  stylePreset: 'exact'
  aspectRatio: 'exact'
  providerCallRequired: false
}

/**
 * A prior immutable Asset version that the server proved is semantically
 * identical to the current normalized visual target. Listing never mutates
 * state or calls a Provider.
 */
export interface HistoricalVisualAssetCandidate {
  asset: MediaAsset
  /** Stable family handle for this compatibility slice. */
  assetFamilyId: string
  /** Exact immutable historical version currently being previewed. */
  assetVersionId: string
  assetVersion: number
  priorSourceRevisionId: string
  currentSourceRevisionId: string
  semanticFingerprint: string
  compatibility: HistoricalVisualAssetCompatibility
}

export interface HistoricalVisualAssetCandidatesResponse {
  episodeId: string
  sourceRevisionId: string
  entityType: VisualAssetTargetType
  entityId: string
  candidates: HistoricalVisualAssetCandidate[]
  etag: string
}

export interface AdoptHistoricalVisualAssetInput {
  projectId: string
  episodeId: string
  entityType: VisualAssetTargetType
  entityId: string
}

export interface HistoricalVisualAssetAdoption {
  asset: MediaAsset
  sourceAsset: MediaAsset
  job: GenerationJob
  revision: ProjectRevision
  assetFamilyId: string
  assetVersionId: string
  previousAssetVersionId: string
  sourceRevisionId: string
  priorSourceRevisionId: string
  semanticFingerprint: string
  idempotent: boolean
  providerCallRequired: false
  etag: string
}

/** A prior-revision shot video whose complete Story snapshot and shot identity match the current revision. */
export interface HistoricalShotVideoCandidate {
  asset: MediaAsset
  priorSourceRevisionId: string
  currentSourceRevisionId: string
  semanticFingerprint: string
  compatibility: {
    storySnapshot: 'exact'
    shotIdentity: 'exact'
    providerCallRequired: false
  }
}

export interface HistoricalShotVideoCandidatesResponse {
  projectId: string
  episodeId: string
  shotId: string
  sceneId: string
  sourceRevisionId: string
  candidates: HistoricalShotVideoCandidate[]
  etag: string
}

export interface HistoricalShotVideoRestoration {
  asset: MediaAsset
  sourceAsset: MediaAsset
  job: GenerationJob
  mediaReview: ShotMediaDecisionResult
  priorSourceRevisionId: string
  currentSourceRevisionId: string
  semanticFingerprint: string
  providerCallRequired: false
  idempotent: boolean
  etag: string
}

export type ExportRenderResolution = '720p' | '1080p'
export type ExportRenderStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale'

export interface ExportRenderSpecification {
  version: 1
  resolution: ExportRenderResolution
  /** Server-pinned Episode aspect ratio used by the immutable render. */
  aspectRatio: '16:9' | '9:16' | '1:1'
  kenBurns: boolean
  burnSubtitles: boolean
  /** Export-only title overlay on existing opening frames; adds no duration. */
  introTitle: boolean
  /** Export-only end-card overlay on existing closing frames; adds no duration. */
  outroCard: boolean
  /** Fixed review-copy watermark burned over the existing render. */
  reviewWatermark: boolean
  videoCodec: 'h264'
  pixelFormat: 'yuv420p'
  frameRate: 24
  audioCodec: 'aac'
  audioSampleRate: 48_000
  timelineRevisionId: string
  storyRevisionId: string
}

export interface ExportRenderRecord {
  id: string
  projectId: string
  episodeId: string
  status: ExportRenderStatus
  timelineRevisionId: string
  storyRevisionId: string
  specification: ExportRenderSpecification
  outputAsset: MediaAsset | null
  /** QC-gated review copy; does not imply a human release approval. */
  reviewDownloadUrl: string | null
  /** QC + current immutable human approval gated release copy. */
  downloadUrl: string | null
  jobId: string | null
  error: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

/** Body accepted by POST /api/v1/episodes/:episodeId/exports. */
export interface CreateExportRenderInput {
  projectId: string
  /** Immutable timeline revision; the same revision must also be sent in If-Match. */
  timelineRevisionId: string
  resolution: ExportRenderResolution
  kenBurns?: boolean
  burnSubtitles?: boolean
  introTitle?: boolean
  outroCard?: boolean
  reviewWatermark?: boolean
}

export interface ExportRenderJobInput {
  exportId: string
  /** Absent only on legacy persisted jobs created before revision-bound inputs. */
  timelineRevisionId?: string
  storyRevisionId?: string
}

export interface ExportRenderJobOutput {
  exportId: string
  timelineRevisionId: string
  storyRevisionId: string
  asset: MediaAsset
}

export type ExportRenderGenerationJob = GenerationJob<
  ExportRenderJobInput,
  ExportRenderJobOutput
> & { type: 'export.render' }

export interface CreateExportRenderResponse {
  export: ExportRenderRecord
  job: ExportRenderGenerationJob
}

export type QualityReportStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'stale'
export type QualityCheckStatus = 'passed' | 'failed' | 'warning' | 'skipped'

export interface QualityCheckResult {
  id:
    | 'decodable'
    | 'ffprobe.specification'
    | 'video.black-frames'
    | 'audio.silence'
    | 'audio.peak'
    | 'subtitle.timing'
    | 'subtitle.safe-area'
  status: QualityCheckStatus
  severity: 'error' | 'warning' | 'info'
  message: string
  metrics: Record<string, unknown>
}

export interface QualityReport {
  id: string
  projectId: string
  episodeId: string
  exportId: string
  outputAssetId: string
  outputAssetChecksum: string
  timelineRevisionId: string
  storyRevisionId: string
  status: QualityReportStatus
  passed: boolean | null
  policy: Record<string, unknown>
  expected: Record<string, unknown>
  checks: QualityCheckResult[]
  metrics: Record<string, unknown>
  summary: {
    passed: boolean | null
    failedChecks: number
    warningChecks: number
  }
  jobId: string | null
  jobStatus: JobStatus | null
  error: Record<string, unknown> | null
  createdAt: string
  completedAt: string | null
}

export interface CreateQualityCheckResponse {
  qualityReport: QualityReport
  job: GenerationJob<{ qualityReportId: string }, Record<string, unknown>>
}

export type ReleaseReviewDecision = 'approve' | 'reject'

export interface ReleaseReviewChecklist {
  audioVideoSync: boolean
  subtitleSyncAndComplete: boolean
  characterVisualSemantics: boolean
}

export interface ReleaseReview {
  id: string
  projectId: string
  episodeId: string
  exportId: string
  outputAssetId: string
  outputAssetChecksum: string
  timelineRevisionId: string
  storyRevisionId: string
  qualityReportId: string
  qualityPolicyVersion: number
  decision: ReleaseReviewDecision
  checklist: ReleaseReviewChecklist
  notes: string | null
  reviewedAt: string
  isCurrent: boolean
  invalidReasons: string[]
}

export interface CreateReleaseReviewInput {
  decision: ReleaseReviewDecision
  checklist: ReleaseReviewChecklist
  notes?: string
}

export interface CreateReleaseReviewResponse {
  releaseReview: ReleaseReview
}

export type PipelineRunMode = 'dynamic-comic'
export type PipelineRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale'

export type PipelineStepId = 'storyboard' | 'speech' | 'timeline' | 'export' | 'quality'
export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale'

export type PipelineSpeechMode = 'auto' | 'skip'

export interface PipelineRunError {
  code: string
  message: string
  step?: PipelineStepId
  jobId?: string
  childCode?: string
}

/** Immutable provider revision pinned when a one-click production run is created. */
export interface PipelineProviderBinding {
  providerId: string
  configRevision: number
  model: string | null
}

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

export interface PipelineVoiceBlocker {
  code: string
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

export interface PipelineRunOptions {
  resolution: ExportRenderResolution
  kenBurns: boolean
  burnSubtitles: boolean
  introTitle: boolean
  outroCard: boolean
  reviewWatermark: boolean
  speechMode: PipelineSpeechMode
  defaultVoiceId?: string
}

export interface PipelineFanoutStep {
  status: PipelineStepStatus
  jobIds: string[]
  completed: number
  total: number
  error?: PipelineRunError
}

export interface PipelineTimelineStep {
  status: PipelineStepStatus
  revisionId?: string
  automaticEdit?: PipelineTimelineAutomaticEdit
  error?: PipelineRunError
}

export interface PipelineTimelineAutomaticEdit {
  strategy: 'managed-dialogue-reflow-v1'
  executor: 'OpenCut-Classic/UpdateElementsCommand'
  planHash: string
  operationCount: number
  changedElementIds: string[]
  planId?: string
  applicationId?: string
}

export interface PipelineExportStep {
  status: PipelineStepStatus
  exportId?: string
  rootJobId?: string
  error?: PipelineRunError
}

export interface PipelineQualityStep {
  status: PipelineStepStatus
  reportId?: string
  rootJobId?: string
  passed?: boolean
  error?: PipelineRunError
}

export interface PipelineRun {
  id: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  status: PipelineRunStatus
  progress: number
  version: 1
  mode: PipelineRunMode
  options: PipelineRunOptions
  bindings: {
    imageProvider?: PipelineProviderBinding
    /** Present only on legacy runs created before per-character casting. */
    speechProvider?: PipelineProviderBinding
    speechTargets?: PipelineSpeechTargetBinding[]
  }
  targets: {
    storyboard: string[]
    speech: string[]
  }
  steps: {
    storyboard: PipelineFanoutStep
    speech: PipelineFanoutStep
    timeline: PipelineTimelineStep
    export: PipelineExportStep
    quality: PipelineQualityStep
  }
  error: PipelineRunError | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

/** Caller-owned configuration accepted by the paid Pipeline preflight. */
export interface PipelineRunPreflightInput {
  projectId: string
  resolution: ExportRenderResolution
  kenBurns: boolean
  burnSubtitles: boolean
  introTitle: boolean
  outroCard: boolean
  reviewWatermark: boolean
  speechMode: PipelineSpeechMode
  imageProviderId?: string
}

/** Body accepted by POST /api/v1/episodes/:episodeId/pipeline-runs. */
export interface CreatePipelineRunInput extends PipelineRunPreflightInput {
  /** Opaque server-authenticated snapshot returned by the immediately prior preflight. */
  confirmationToken: string
}

export interface PipelineRunPreflight {
  version: 1
  projectId: string
  episodeId: string
  sourceRevisionId: string
  readyStoryboardCount: number
  missingStoryboardCount: number
  readySpeechCount: number
  missingSpeechCount: number
  hasPublishableAudio: boolean
  billableStoryboardCount: number
  billableSpeechCount: number
  billableTargetCount: number
  imageProvider: PipelineProviderBinding | null
  speechProvider: PipelineProviderBinding | null
  speechProviders: PipelineProviderBinding[]
  voiceSummary: PipelineVoiceSummary
  blockers: PipelineVoiceBlocker[]
  canCreate: boolean
  confirmationToken: string | null
  /** Exact public expiry authenticated inside confirmationToken; null when blocked. */
  expiresAt: string | null
}

export type AssetLockTargetType = 'character' | 'location' | 'prop'

export interface LockAssetInput {
  projectId: string
  episodeId: string
  targetType: AssetLockTargetType
  targetId: string
}

export interface AssetLockResponse {
  asset: MediaAsset
  target: {
    type: AssetLockTargetType
    id: string
    name: string
    version: number
    lockedAssetId: string | null
  }
  revision: ProjectRevision
  sourceRevisionId: string
  stale: StoryStaleResult
  idempotent: boolean
  auditRevision: boolean
  etag: string
  auditRevisionId: string
}

export interface LockCharacterVisualReferencesInput {
  projectId: string
  episodeId: string
  targetId: string
  frontAssetId: string
  sideAssetId: string
  backAssetId: string
}

export interface CharacterVisualReferenceLockResponse {
  assets: Record<TurnaroundReferenceRole, MediaAsset>
  target: {
    type: 'character'
    id: string
    name: string
    version: number
    lockedAssetId: string | null
    references: {
      frontAssetId: string
      sideAssetId: string
      backAssetId: string
      auditRevisionId: string
    }
  }
  revision: ProjectRevision
  sourceRevisionId: string
  stale: StoryStaleResult
  idempotent: boolean
  auditRevision: true
  etag: string
  auditRevisionId: string
}

export type ShotVideoResolution = '480p' | '720p' | '1080p'
export type ShotVideoAspectRatio = '16:9' | '9:16' | '1:1'
export type ShotVideoReferenceRole = 'first_frame' | 'last_frame' | 'reference_image'
export type ShotVideoReferenceMode = 'text-to-video' | 'first-frame' | 'first-last-frame' | 'multi-reference'
export type ShotVideoAudioPolicy = 'sfx_only' | 'silent' | 'provider_audio'
export type ShotVideoPublicationMode = 'replace_current' | 'evaluation_only'
export type ShotVideoPromptCompilerVersion =
  | 'seedance-compact-v1'
  | 'seedance-verbose-baseline-v1'

export type ShotMediaType = 'storyboard' | 'video'
export type ShotMediaReviewDecision = 'adopt' | 'reject' | 'restore'

export interface ListShotMediaReviewInput {
  projectId: string
  episodeId: string
  sceneId?: string
  mediaType: ShotMediaType
  limit?: number
  offset?: number
}

export interface DecideShotMediaInput {
  projectId: string
  episodeId: string
  sceneId?: string
  mediaType: ShotMediaType
  decision: ShotMediaReviewDecision
  assetId: string
  note?: string
}

export interface ShotMediaCandidate {
  id: string
  projectId: string
  episodeId: string
  kind: string
  version: number
  status: string
  mimeType: string
  width: number | null
  height: number | null
  durationSeconds: number | null
  checksum: string
  sourceRevisionId: string
  parentAssetId: string | null
  generationJobId: string
  url: string
  createdAt: string
  selected: boolean
  eligible: boolean
  eligibilityError: string | null
  lastDecision: ShotMediaReviewDecision | null
}

export interface ShotMediaReviewRecord {
  id: string
  projectId: string
  episodeId: string
  databaseShotId: string
  shotId: string
  sceneId: string
  sourceRevisionId: string
  mediaType: ShotMediaType
  decision: ShotMediaReviewDecision
  assetId: string
  previousAssetId: string | null
  selectedAssetId: string | null
  /** A storyboard change cleared this dependent current video pointer; the Asset remains in history. */
  clearedVideoAssetId: string | null
  note: string | null
  timelineReconcileRequired: boolean
  stale: {
    generationJobs: number
    shotVideoJobs: number
    exports: number
    qualityReports: number
    pipelineRuns: number
  }
  createdAt: string
}

export interface ShotMediaReviewSnapshot {
  projectId: string
  episodeId: string
  databaseShotId: string
  shotId: string
  sceneId: string
  sourceRevisionId: string
  mediaType: ShotMediaType
  episodeEtag: string
  currentSelection: ShotMediaCandidate | null
  currentSelectionAssetId: string | null
  candidates: ShotMediaCandidate[]
  history: ShotMediaReviewRecord[]
  pagination: {
    limit: number
    offset: number
  }
}

export interface ShotMediaDecisionResult {
  review: ShotMediaReviewRecord
  episodeEtag: string
  currentSelectionAssetId: string | null
  clearedVideoAssetId: string | null
  timelineReconcileRequired: boolean
  idempotent: boolean
  headAdvanced: boolean
}

/** Public body accepted by POST /api/v1/shots/:shotId/video-generations. */
export interface CreateShotVideoGenerationJobInput {
  projectId: string
  episodeId: string
  sceneId?: string
  providerId?: string
  resolution?: ShotVideoResolution
  /** Seedance 2.0 accepts an integer duration from 4 through 15 seconds. */
  durationSeconds?: number
  audioPolicy?: ShotVideoAudioPolicy
  /** @deprecated Prefer audioPolicy; retained for exact replay of older clients. */
  generateAudio?: boolean
}

/** Server-pinned target used to prevent a generated clip from overwriting newer work. */
export interface ShotVideoGenerationBinding {
  episodeId: string
  shotId: string
  sceneId: string
  databaseShotId: string
  expectedRevisionId: string
  expectedPreviousVideoAssetId: string | null
}

export interface ShotVideoReferenceBinding {
  assetId: string
  role: ShotVideoReferenceRole
  version: number
  checksum: string
  sourceRevisionId: string
}

export type CharacterVisualReferenceView = 'front' | 'side' | 'back'
export type ShotVideoReferenceRecommendationStatus = 'recommended' | 'manual_required' | 'not_applicable'

export interface ShotVideoCharacterReferenceRecommendation {
  characterId: string
  characterName: string
  status: 'recommended' | 'manual_required'
  view: CharacterVisualReferenceView | null
  confidence: number | null
  rationale: string
  assetId: string | null
  assetVersion: number | null
  assetChecksum: string | null
  assetSourceRevisionId: string | null
  slotVersion: number | null
  slotAuditRevisionId: string | null
}

export interface ShotVideoReferenceRecommendation {
  version: 1
  policy: 'deterministic-character-view-v1'
  status: ShotVideoReferenceRecommendationStatus
  shotId: string
  sceneId: string
  sourceRevisionId: string
  confidence: number | null
  rationale: string
  characters: ShotVideoCharacterReferenceRecommendation[]
  references: Array<{ assetId: string; role: 'reference_image' }>
}

export interface ShotVideoReferenceDecision {
  version: 1
  /** Legacy value means server-authored; automaticPolicy identifies true visual analysis. */
  source: 'agentic_auto' | 'manual_override'
  automaticPolicy?: 'deterministic_safety' | 'persisted_vision'
  visionAnalysisJobId?: string
  resolution?: 'character_views' | 'storyboard_anchor' | 'not_applicable' | 'manual_override'
  recommendation: ShotVideoReferenceRecommendation
  storyboardAnchorAssetId: string | null
  selectedReferences: ShotVideoReferenceSelection[]
  manualCharacterSlotPins?: ShotVideoManualCharacterSlotPin[]
}

export interface ShotVideoManualCharacterSlotPin {
  characterId: string
  characterName: string
  view: CharacterVisualReferenceView
  assetId: string
  assetVersion: number
  assetChecksum: string
  assetSourceRevisionId: string
  slotVersion: number
  slotAuditRevisionId: string
}

export interface ShotVideoBatchBinding {
  version: 1
  requestFingerprint: string
  selectionIndex: number
  selectionCount: number
}

export type ShotVideoDurationSource = 'speech_assets' | 'story_duration' | 'manual_override'

export type ShotVideoDurationNotice =
  | 'AUDIO_DRIVEN_TIMELINE'
  | 'PROVIDER_MINIMUM_SOURCE_WILL_BE_TRIMMED'
  | 'MANUAL_DURATION_ADDS_SILENT_TAIL'
  | 'LINE_DURATION_METADATA_DIFFERS_FROM_ASSET'
  | 'STORY_DURATION_USED_WITHOUT_SPEECH'

export interface ShotVideoSpeechDurationBinding {
  dialogueLineId: string
  assetId: string
  version: number
  checksum: string
  durationSeconds: number
  durationFrames: number
}

/** Shared immutable timing manifest for Seedance and OpenCut. */
export interface ShotVideoDurationDecision {
  version: 1
  source: ShotVideoDurationSource
  frameRate: 24
  plannedDurationSeconds: number
  speechDurationSeconds: number | null
  timelineDurationSeconds: number
  providerDurationSeconds: number
  speechBindings: ShotVideoSpeechDurationBinding[]
  notices: ShotVideoDurationNotice[]
}

export type ShotVideoDurationBlockReason =
  | 'SPEECH_ASSET_MISSING'
  | 'SPEECH_ASSET_NOT_READY'
  | 'SPEECH_ASSET_NOT_AUDIO'
  | 'SPEECH_ASSET_SCOPE_MISMATCH'
  | 'SPEECH_ASSET_REVISION_MISMATCH'
  | 'SPEECH_ASSET_IDENTITY_MISSING'
  | 'SPEECH_DURATION_MISSING'
  | 'DUPLICATE_DIALOGUE_LINE_ID'

export interface ShotVideoDurationBlockedLine {
  dialogueLineId: string
  reason: ShotVideoDurationBlockReason
}

/** Exact public projection of the server's current audio timing authority. */
export type ShotVideoDurationResolution =
  | { status: 'ready'; decision: ShotVideoDurationDecision }
  | {
      status: 'audio_required'
      shotId: string
      blockedLines: ShotVideoDurationBlockedLine[]
    }
  | {
      status: 'requires_shot_split'
      shotId: string
      speechDurationSeconds: number
      maximumProviderDurationSeconds: number
      speechBindings: ShotVideoSpeechDurationBinding[]
    }
  | {
      status: 'manual_duration_too_short'
      shotId: string
      requestedDurationSeconds: number
      speechDurationSeconds: number
    }

export interface ShotVideoTimingBindingIdentity {
  assetId: string
  version: number
  checksum: string
  durationSeconds: number
  durationFrames: number
}

export type ShotVideoTimingBindingChange =
  | 'added'
  | 'removed'
  | 'asset_changed'
  | 'duration_changed'

export interface ShotVideoTimingAffectedLine {
  dialogueLineId: string
  change: ShotVideoTimingBindingChange
  previous: ShotVideoTimingBindingIdentity | null
  current: ShotVideoTimingBindingIdentity | null
}

/**
 * Fail-closed recovery payload attached only to a failed
 * `shot.video.generate` Job with `STALE_AUDIO_TIMING`.
 */
export interface ShotVideoTimingRemediation {
  version: 1
  kind: 'stale_audio_timing'
  projectId: string
  episodeId: string
  shotId: string
  sceneId: string
  sourceRevisionId: string
  checkpoint: 'initial' | 'pre-submit' | 'pre-publish'
  providerSubmissionState: 'not-started' | 'task-exists'
  detectedAt: string
  previousDecision: ShotVideoDurationDecision
  currentResolution: ShotVideoDurationResolution
  affectedLines: ShotVideoTimingAffectedLine[]
  recommendedAction: 'regenerate-speech-or-repreflight' | 'repreflight-paid-video'
}

export interface ShotVideoGenerationReferenceSpec {
  assetId: string
  role: ShotVideoReferenceRole
}

export interface ShotVideoGenerationAudioLineSpec {
  kind: 'dialogue' | 'narration'
  speaker: string
  text: string
}

/** Server-derived creative direction fixed before a billable request exists. */
export interface ShotVideoGenerationSpec {
  version: 1
  promptCompilerVersion: ShotVideoPromptCompilerVersion
  subjectNames: string[]
  scene: string
  action: string
  shotSize: string
  cameraMovement: string
  audioPolicy: ShotVideoAudioPolicy
  /** Exact Story-authored lines requested when Seedance is responsible for speech. */
  audioLines?: ShotVideoGenerationAudioLineSpec[]
  durationSeconds: number
  resolution: ShotVideoResolution
  aspectRatio: ShotVideoAspectRatio
  sourceRevisionId: string
  references: ShotVideoGenerationReferenceSpec[]
}

/** Durable paid request returned by the job API. It never contains client-supplied URLs. */
export interface ShotVideoGenerationJobInput {
  prompt: string
  aspectRatio: ShotVideoAspectRatio
  resolution: ShotVideoResolution
  durationSeconds: number
  generateAudio: boolean
  /** Missing only on durable jobs created before the compact compiler rollout. */
  spec?: ShotVideoGenerationSpec
  binding: ShotVideoGenerationBinding
  references?: ShotVideoReferenceBinding[]
  referenceDecision?: ShotVideoReferenceDecision
  batch?: ShotVideoBatchBinding
  /** Evaluation runs persist an Asset but never replace the production Shot pointer. */
  publicationMode?: 'evaluation_only'
  /** Missing only on jobs created before audio-driven video timing. */
  durationDecision?: ShotVideoDurationDecision
}

export interface GeneratedShotVideo {
  id: string
  url: string
  mimeType: 'video/mp4' | 'video/webm'
  width: number
  height: number
  durationSeconds: number
}

export interface ShotVideoGenerationJobOutput {
  asset: GeneratedShotVideo
  shotId: string
  externalTaskId: string
}

export type ShotVideoGenerationJob = GenerationJob<
  ShotVideoGenerationJobInput,
  ShotVideoGenerationJobOutput
> & {
  type: 'shot.video.generate'
  episodeId: string
  resourceType: 'provider:video'
  resourceId: string
  providerId: string
  model: string
  providerConfigRevision: number
}

export interface ResolveShotVideoUnknownSubmissionInput {
  projectId: string
  resolution: 'confirmed-not-created'
  confirmedProviderConsoleChecked: true
  note: string
}

/** Immutable audit returned after a user explicitly closes an unknown paid-submit outcome. */
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

export interface ResolveShotVideoUnknownSubmissionResponse {
  resolution: ShotVideoUnknownSubmissionResolution
  idempotent: boolean
  job: ShotVideoGenerationJob
}

export interface ShotVideoReferenceSelection {
  assetId: string
  role: ShotVideoReferenceRole
}

export interface ShotVideoBatchSelectionInput {
  shotId: string
  sceneId?: string
  /** Omit for Agentic speech-Asset timing; present is an advanced manual override. */
  durationSeconds?: number
  /** Succeeded server-side multimodal analysis for this automatic selection. */
  referenceAnalysisJobId?: string
  references?: ShotVideoReferenceSelection[]
  characterReferenceSelections?: ShotVideoManualCharacterSlotSelector[]
}

export interface ShotVideoManualCharacterSlotSelector {
  characterId: string
  view: CharacterVisualReferenceView
}

export interface ShotVideoBatchPreflightInput {
  projectId: string
  providerId?: string
  /** Compact is the production default; verbose exists only for controlled A/B acceptance. */
  promptCompilerVersion?: ShotVideoPromptCompilerVersion
  /** Defaults to production replacement, except verbose baselines which are always evaluation-only. */
  publicationMode?: ShotVideoPublicationMode
  /** Succeeded server-side multimodal analysis; clients never submit its raw Asset plan. */
  referenceAnalysisJobId?: string
  resolution?: ShotVideoResolution
  /** UI default is SFX-only; silent remains available for dialogue-heavy shots. */
  audioPolicy?: ShotVideoAudioPolicy
  /** @deprecated Prefer audioPolicy; retained for older callers. */
  generateAudio?: boolean
  selections: ShotVideoBatchSelectionInput[]
}

export interface CreateShotVideoVisualReferenceAnalysisInput {
  projectId: string
  textProviderId?: string
  selections: Array<{ shotId: string; sceneId?: string }>
}

export interface ShotVideoVisualReferenceAnalysisPlan {
  shotId: string
  sceneId: string
  status: 'recommended' | 'manual_required'
  strategy: 'first_frame' | 'multi_reference' | 'text_only' | 'manual_review'
  confidence: number
  rationale: string
  visualEvidence: string[]
  selectedReferences: Array<{
    assetId: string
    role: 'first_frame' | 'reference_image'
    purpose: string
  }>
  missingCharacterViews: Array<{
    characterId: string
    characterName: string
    view: 'front' | 'side' | 'back' | 'uncertain'
    rationale: string
  }>
}

export interface ShotVideoVisualReferenceAnalysis {
  version: 'shot-video-vision-agent-v1'
  inputFingerprint: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  plans: ShotVideoVisualReferenceAnalysisPlan[]
}

export interface ShotVideoVisualReferenceAnalysisJobInput {
  version: 1
  episodeId: string
  expectedStoryRevisionId: string
  inputFingerprint: string
  selectors: Array<{ shotId: string; sceneId?: string }>
  batch?: {
    version: 1
    batchId: string
    requestFingerprint: string
    selectionIndex: number
    selectionCount: number
  }
  candidateCount: number
}

export interface ShotVideoVisualReferenceAnalysisJobOutput {
  analysis: ShotVideoVisualReferenceAnalysis
}

export type ShotVideoVisualReferenceAnalysisJob = GenerationJob<
  ShotVideoVisualReferenceAnalysisJobInput,
  ShotVideoVisualReferenceAnalysisJobOutput
> & {
  type: 'shot.video.reference.analyze'
  episodeId: string
  resourceId: string
  providerId: string
  model: string
  providerConfigRevision: number
}

export type ShotVideoVisualReferenceAuthorityReason =
  | 'current'
  | 'job_not_succeeded'
  | 'source_revision_changed'
  | 'visual_inputs_changed'
  | 'provider_revision_changed'
  | 'invalid_binding'

export interface ShotVideoVisualReferenceAuthority {
  usable: boolean
  reason: ShotVideoVisualReferenceAuthorityReason
  boundInputFingerprint: string | null
  currentInputFingerprint: string | null
  expectedStoryRevisionId?: string
  providerId?: string | null
  providerConfigRevision?: number | null
}

export interface ShotVideoVisualReferenceAnalysisBinding {
  shotId: string
  sceneId: string
  job: ShotVideoVisualReferenceAnalysisJob
  authority: ShotVideoVisualReferenceAuthority
}

export type ShotVideoVisualReferenceAnalysisBatchStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial_failed'
  | 'failed'
  | 'incomplete'

export interface ShotVideoVisualReferenceAnalysisBatch {
  version: 1
  id: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  providerId: string
  providerConfigRevision: number
  model: string
  requestFingerprint: string
  status: ShotVideoVisualReferenceAnalysisBatchStatus
  progress: number
  counts: {
    total: number
    queued: number
    running: number
    succeeded: number
    failed: number
  }
  selections: Array<{
    selectionIndex: number
    shotId: string
    sceneId: string
    jobId: string
    status: JobStatus
    progress: number
    authority: ShotVideoVisualReferenceAuthority
  }>
  createdAt: string
  updatedAt: string
}

export interface ShotVideoVisualReferenceAnalysisBatchResponse {
  batch: ShotVideoVisualReferenceAnalysisBatch
  jobs: ShotVideoVisualReferenceAnalysisJob[]
}

export interface CreateShotVideoBatchInput extends ShotVideoBatchPreflightInput {
  confirmationToken: string
}

export interface ShotVideoBatchPreflightTarget {
  shotId: string
  sceneId: string
  durationSeconds: number
  /** Exact frame-aligned OpenCut cut point; may be shorter than Provider source. */
  timelineDurationSeconds: number
  durationDecision: ShotVideoDurationDecision
  referenceMode: ShotVideoReferenceMode
  /** Immutable Asset identity fixed by the server before the paid confirmation. */
  references: Array<ShotVideoReferenceBinding & { sourceRevisionId: string }>
  referenceDecision: ShotVideoReferenceDecision
  promptPreview: string
  promptCompilerVersion: ShotVideoPromptCompilerVersion
  promptCompilerNotices: string[]
}

export interface ShotVideoBatchPreflight {
  version: 1
  projectId: string
  episodeId: string
  sourceRevisionId: string
  resolution: ShotVideoResolution
  publicationMode: ShotVideoPublicationMode
  audioPolicy: ShotVideoAudioPolicy
  generateAudio: boolean
  provider: {
    providerId: string
    configRevision: number
    model: string
  }
  billableTaskCount: number
  totalRequestedSeconds: number
  /** Currency pricing is deliberately absent until a versioned Provider tariff is configured. */
  priceEstimate: null
  priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE'
  targets: ShotVideoBatchPreflightTarget[]
  expiresAt: string
  confirmationToken: string
}

export type DialogueSpeechEmotion =
  | 'happy'
  | 'sad'
  | 'angry'
  | 'fearful'
  | 'disgusted'
  | 'surprised'
  | 'calm'
  | 'fluent'
  | 'whisper'

export type DialogueSpeechFormat = 'mp3' | 'wav'
export type DialogueSpeechSampleRate = 8_000 | 16_000 | 22_050 | 24_000 | 32_000 | 44_100
export type DialogueSpeechBitrate = 32_000 | 64_000 | 128_000 | 256_000

export type DialogueLinePerformanceEmotion = Exclude<
  DialogueSpeechEmotion,
  'fluent' | 'whisper'
>

export interface DialoguePerformancePause {
  afterCharacter: number
  durationSeconds: number
}

export type DialoguePerformanceOpeningSoundTag =
  | '(laughs)'
  | '(chuckle)'
  | '(coughs)'
  | '(clear-throat)'
  | '(groans)'
  | '(breath)'
  | '(pant)'
  | '(inhale)'
  | '(exhale)'
  | '(gasps)'
  | '(sniffs)'
  | '(sighs)'
  | '(snorts)'
  | '(burps)'
  | '(lip-smacking)'
  | '(humming)'
  | '(hissing)'
  | '(emm)'
  | '(sneezes)'

export interface DialoguePerformanceRecommendation {
  version: 'line-performance-agent-v1'
  lineId: string
  emotion: DialogueLinePerformanceEmotion
  speed: number
  pitch: number
  openingSoundTag?: DialoguePerformanceOpeningSoundTag
  pausePlan: DialoguePerformancePause[]
  rationale: string
}

/**
 * A confirmed, line-scoped performance direction. The recommendation remains
 * inert until the user explicitly adopts its durable job; clients never send
 * model-authored delivery values back as confirmation input.
 */
export interface DialoguePerformanceProfile extends DialoguePerformanceRecommendation {
  version: 'line-performance-agent-v1'
  projectId: string
  episodeId: string
  databaseLineId: string
  revisionId: string
  recommendationJobId: string
  sourceRevisionId: string
  voiceProfileRevisionId: string | null
  updatedAt: string
}

export interface DialoguePerformanceStaleResult {
  speechAssets: number
  narrationLines: number
  exports: number
  exportAssets: number
  qualityReports: number
  pipelineRuns: number
}

export interface DialoguePerformanceProfileResponse {
  profile: DialoguePerformanceProfile | null
  /** Strong/weak opaque concurrency token returned in the HTTP ETag header. */
  etag: string
  revisionId?: string
  stale?: DialoguePerformanceStaleResult
}

export interface DialoguePerformanceRecommendationJobInput {
  episodeId: string
  lineId: string
  sourceRevisionId: string
  lineKind: DialogueKind
}

export interface DialoguePerformanceRecommendationJobOutput {
  lineId: string
  recommendation: DialoguePerformanceRecommendation
}

export type DialoguePerformanceRecommendationJob = GenerationJob<
  DialoguePerformanceRecommendationJobInput,
  DialoguePerformanceRecommendationJobOutput
> & { type: 'dialogue.performance.recommend' }

/** Public request body accepted by the dialogue-line speech endpoint. */
export interface CreateDialogueSpeechJobInput {
  projectId: string
  episodeId: string
  /** Omit to inherit the speaking character's persisted voice profile. */
  voiceId?: string
  providerId?: string
  speed?: number
  volume?: number
  pitch?: number
  emotion?: DialogueSpeechEmotion
  format?: DialogueSpeechFormat
  sampleRate?: DialogueSpeechSampleRate
  bitrate?: DialogueSpeechBitrate
  channels?: 1 | 2
}

/** Durable normalized job input returned by the API; dialogue text is never included. */
export interface DialogueSpeechJobInput {
  episodeId: string
  lineId: string
  databaseLineId: string
  expectedRevisionId: string | null
  voiceId: string
  /** Present when voiceId was resolved from the character profile server-side. */
  inheritedVoiceProfileRevisionId?: string
  speed: number
  volume: number
  pitch: number
  emotion?: DialogueSpeechEmotion
  format: DialogueSpeechFormat
  sampleRate: DialogueSpeechSampleRate
  bitrate: DialogueSpeechBitrate
  channels: 1 | 2
}

export interface DialogueSpeechJobOutput {
  dialogueLineId: string
  asset: MediaAsset
  provider: {
    id: string
    model: string
    configRevision: number
  }
}

export type DialogueSpeechGenerationJob = GenerationJob<
  DialogueSpeechJobInput,
  DialogueSpeechJobOutput
> & { type: 'dialogue.speech.generate' }

export interface StudioEvent<TData = unknown> {
  id: string
  type: 'job.created' | 'job.updated' | 'pipeline.updated' | 'project.updated' | 'provider.updated' | 'asset.created' | 'stream.resync'
  createdAt: string
  projectId?: string
  data: TData
}

export interface RequestOptions {
  signal?: AbortSignal
}

export interface SearchStoryEntitiesOptions extends RequestOptions {
  projectId: string
  query: string
  limit?: number
  offset?: number
}

export interface UploadUserAudioOptions extends RequestOptions {
  /** Display-only file name. File.name is used when this is omitted. */
  name?: string
}

export interface ListImageJobsOptions extends RequestOptions {
  limit?: number
  status?: ImageJobStatus
}

export interface ListGenerationJobsOptions extends RequestOptions {
  projectId?: string
  limit?: number
  status?: JobStatus
  type?: string
}

export interface ListPipelineRunsOptions extends RequestOptions {
  projectId: string
  episodeId: string
  limit?: number
}
