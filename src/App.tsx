import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ApiError,
  api,
  parsePublicPaidAigcConfirmation,
  type GenerationJob,
  type GenerateImageInput,
  type HealthResponse,
  type HistoricalShotVideoCandidate,
  type HistoricalShotVideoCandidatesResponse,
  type ImageJob,
  type MediaAsset,
  type MiniMaxVoiceCatalogEntry,
  type CreateDialogueSpeechJobInput,
  type CharacterVoiceProfileMutationResponse,
  type DialoguePerformanceProfile,
  type DialogueSpeechEmotion,
  type EpisodeSummary,
  type ExportRenderRecord,
  type ExportRenderResolution,
  type ProviderConnection,
  type PublicPaidAigcConfirmation,
  type ProjectSummary,
  type ProjectRevision,
  type ProjectNarratorVoiceProfileMutationResponse,
  type ProjectNarratorVoiceProfileState,
  type QualityReport,
  type ReleaseReview,
  type ShotMediaCandidate,
  type ShotMediaDecisionResult,
  type ShotMediaReviewDecision,
  type ShotMediaReviewSnapshot,
  type ShotMediaType,
  type ShotVideoTimingRemediation,
  type ShotVideoTimingBindingIdentity,
  type StoryDocument,
  type StoryEntitySearchResult,
  type StoryMutationResponse,
  type StoryScenePatchInput,
  type StoryShotPatchInput,
  type TimelineDocumentSnapshot,
  type TurnaroundReferenceRole,
  type UserAudioAsset,
  type VisualAssetTarget,
} from './lib'
import {
  VisualAssetEditDialog,
} from './features/assets/VisualAssetEditDialog'
import { ProjectAssetVersionLibrary } from './features/assets/ProjectAssetVersionLibrary'
import { ProductionAssetManifestCard } from './features/assets/ProductionAssetManifestCard'
import { CatalogNavigator } from './features/catalog/CatalogNavigator'
import { ProjectEpisodeSwitcher } from './features/catalog/ProjectEpisodeSwitcher'
import { ProjectKnowledgeCenter } from './features/catalog/ProjectKnowledgeCenter'
import {
  PROJECT_SWITCHER_STORAGE_KEY,
  parseProjectSwitcherMemory,
  rememberProductionWorkspace,
  serializeProjectSwitcherMemory,
  workspaceLocationForEpisode,
  type ProjectSwitcherMemory,
} from './features/catalog/project-switcher-state'
import { collectCurrentProductionAssetVersionIds } from './features/assets/project-asset-production-usage'
import type { VisualAssetEditSubmission } from './features/assets/visual-asset-edit-state'
import {
  acknowledgeAssetImageEditIdempotencyLease,
  acquireAssetImageEditIdempotencyLease,
} from './features/assets/image-edit-idempotency'
import {
  visualAssetCandidateProvenance,
  visualAssetJobBinding,
  visualAssetJobProvenance,
} from './features/assets/visual-asset-job-state'
import { TurnaroundSplitDialog } from './features/assets/TurnaroundSplitDialog'
import type { TurnaroundCrops } from './features/assets/turnaround-split-state'
import { PaidAigcConfirmationDialog } from './features/paid-aigc/PaidAigcConfirmationDialog'
import {
  confirmationMatchesAssetImageAttempt,
  freezeAssetImageEditAttempt,
  freezeAssetImageGenerationAttempt,
  type AssetImageGenerationPurpose,
  type FrozenAssetImageGenerationAttempt,
  type FrozenAssetImagePaidAttempt,
} from './features/paid-aigc/paid-aigc-confirmation-state'
import { OpenCutTimeline as Timeline } from './features/editor/OpenCutTimeline'
import {
  DEFAULT_EDITOR_LAYOUT,
  DEFAULT_INSPECTOR_WIDTH_PX,
  DEFAULT_TIMELINE_HEIGHT_PX,
  EDITOR_LAYOUT_STORAGE_KEY,
  clampInspectorWidth,
  clampTimelineHeight,
  parseEditorLayoutPreferences,
  serializeEditorLayoutPreferences,
  type EditorLayoutPreferences,
} from './features/editor/editor-layout-state'
import { OpenCutPreviewModal } from './features/editor/OpenCutPreviewModal'
import { ManagedSubtitleEditor } from './features/editor/ManagedSubtitleEditor'
import {
  assertPinnedTimeline,
  preparePinnedTimeline,
  type ManagedSubtitleCueSetSnapshot,
  type TimelineManagedSubtitleCueSetReadInput,
  type TimelineManagedSubtitleCueSetReplaceInput,
  type TimelinePersistenceHandle,
} from './features/editor/timeline-revision-handoff'
import { TaskCenter } from './features/jobs/TaskCenter'
import { useProjectJobs } from './features/jobs/useProjectJobs'
import {
  completedSpeechLineIdsForCurrentStory,
  exportRecordBelongsToCurrentStory,
  generationJobIsStale,
  jobsForCurrentStoryRevision,
  jobsForEpisode,
  latestExportJobForCurrentStory,
  latestQualityJobForExport,
  qualityReportBelongsToCurrentStory,
} from './features/jobs/episode-job-scope'
import { ShotVideoPanel } from './features/video/ShotVideoPanel'
import { SeedanceGoldenAcceptanceCard } from './features/video/SeedanceGoldenAcceptanceCard'
import { ShotMediaReviewPanel } from './features/video/ShotMediaReviewPanel'
import {
  ShotVideoBatchDialog,
  type ShotVideoBatchShot,
} from './features/video/ShotVideoBatchDialog'
import { ShotVideoManualResolutionDialog } from './features/video/ShotVideoManualResolutionDialog'
import {
  resolveShotVideoViewState,
  shotVideoCreationBlockReason,
} from './features/video/shot-video-state'
import { recommendShotVideoReferenceAssetIds } from './features/video/shot-video-reference-recommendations'
import {
  shotVideoTimingRemediationFocusLineId,
  shotVideoTimingRemediationFocusTarget,
  shotVideoTimingRepreflightRecovery,
  summarizeShotVideoBatchAvailability,
  type ShotVideoTimingRemediationFocusTarget,
  type ShotVideoTimingRepreflightRecovery,
} from './features/video/shot-video-batch-state'
import {
  acknowledgeShotMediaReviewAttempt,
  acquireShotMediaReviewIdempotencyKey,
  availableShotMediaReviewDecisions,
  shotMediaReviewAttemptSignature,
  shotMediaReviewSubmissionOutcomeIsUnknown,
  type ShotMediaReviewIdempotencyRegistry,
} from './features/video/shot-media-review-state'
import {
  getMissingStoryboardShotIds,
  getReadyStoryboardShotCount,
  getRegeneratableStoryboardShotIds,
} from './features/storyboard/batch-generation'
import {
  createStoryRevisionHistoryState,
  storyRevisionHistoryReducer,
  storyRevisionNavigationCommand,
  storyRevisionNavigationTarget,
} from './features/story/story-revision-history'
import {
  acknowledgeStoryGenerationAttempt,
  acquireStoryGenerationIdempotencyKey,
  freezeStoryGenerationAttempt,
  type FrozenStoryGenerationAttempt,
} from './features/story/story-generation-confirmation-state'
import {
  clearOfflineStoryDraft,
  decideOfflineStoryDraftRecovery,
  loadOfflineStoryDraftForEpisode,
  offlineStoryDraftAsText,
  offlineStoryDraftStorageKey,
  saveOfflineStoryDraft,
  type OfflineStoryDialogueLineDraft,
  type OfflineStoryDraft,
  type OfflineStoryDraftChanges,
  type OfflineStoryDraftScope,
  type OfflineStorySceneDraft,
} from './features/story/offline-story-draft'
import {
  EMPTY_OFFLINE_STORY_DRAFT_CHANGES,
  applyOfflineShotDrafts,
  composeOfflineStoryDraftChanges,
  discardOfflineShotDrafts,
  offlineStoryDraftHasChanges,
  offlineStoryDraftTargetError,
  withOfflineDialogueDraft,
  withOfflineSceneDraft,
  withoutOfflineShotDraft,
} from './features/story/offline-story-draft-state'
import {
  hasUncommittedScriptShotDraft,
  scriptStageCommitState,
  scriptShotDraftChanged,
  scriptShotDraftValidationError,
  scriptShotEditablePatch,
  scriptShotReorderConfirmation,
  scriptShotSourcePatch,
  scriptShotStructureAvailability,
} from './features/story/script-shot-editor-state'
import {
  OfflineStoryDraftPersistenceNotice,
  OfflineStoryDraftRecoveryDialog,
} from './features/story/OfflineStoryDraftRecoveryDialog'
import { OneClickProductionPanel } from './features/pipeline/OneClickProductionPanel'
import {
  PRODUCTION_STAGES,
  isCatalogWorkspaceRoute,
  isProductionStageRoute,
  isWorkspaceRoute,
  nextProductionStageRoute,
  productionStageForRoute,
  storyboardProductionGateStatus,
  visibleProductionStageIdForRoute,
} from './features/workflow/production-stage-state'
import {
  CharacterVoiceCastingCard,
  DialogueVoiceOverridePicker,
} from './features/voices/CharacterVoiceCastingCard'
import { ProjectNarratorVoiceCard } from './features/voices/ProjectNarratorVoiceCard'
import { VoiceAcceptanceChecklist } from './features/voices/VoiceAcceptanceChecklist'
import type { VoiceAcceptanceTarget } from './features/voices/voice-acceptance-state'
import { LinePerformanceDirector } from './features/voices/LinePerformanceDirector'
import { applyLinePerformanceProfile } from './features/voices/line-performance-state'
import {
  confirmedDialogueSpeechGenerationRequest,
  freezeDialogueSpeechGenerationAttempt,
  type FrozenDialogueSpeechGenerationAttempt,
} from './features/voices/dialogue-paid-confirmation-state'
import {
  acquireSpeechGenerationIdempotencyKey,
  submitDialogueSpeechWithIdempotency,
  type SpeechGenerationIdempotencyRegistry,
} from './features/voices/speech-generation-idempotency'
import {
  dialogueSpeechErrorMessage,
  dialogueVoiceSubmissionPlan,
  resolveCharacterVoiceDelivery,
  voiceProfileForStoryLine,
  VOICE_EMOTION_LABELS,
  VOICE_TYPE_LABELS,
} from './features/voices/voice-casting-state'
import {
  beginEpisodeRenderSettingsResolution,
  createEpisodeRenderSettingsConflict,
  episodeRenderSettingsFromEpisode,
  isEpisodeRenderSettingsResolutionCurrent,
  loadConsistentEpisodeRenderSettingsAuthority,
  makeEpisodeRenderSettingsConflictReady,
  normalizeEpisodeRenderSettings,
  reapplyEpisodeRenderSettingsAfterRefresh,
  withEpisodeRenderSettingsAuthority,
  withEpisodeRenderSettingsIntent,
  type EpisodeRenderSettings,
  type EpisodeRenderSettingsAuthority,
  type EpisodeRenderSettingsAuthorityBundle,
  type EpisodeRenderSettingsConflict,
  type EpisodeRenderSettingsConflictAction,
  type EpisodeRenderSettingsScope,
} from './features/settings/episode-render-settings-conflict'
import {
  PROVIDER_CATALOG as providerCatalog,
  ProviderSettingsDialog,
  type ProviderCredentialInput,
  type ProviderPublicSettings,
  type ProviderTestResult,
} from './features/providers/ProviderSettingsDialog'
import {
  defaultExecutableProviderForKind,
  defaultProviderForKind,
  isVerifiedSeedanceProvider,
  providerConnectionLabel,
  providerStatusDetail,
  providerSupportsCapability,
  providerUiConnectionState,
  providerVerificationNotice,
  seedanceGenerationBlockReason,
  speechControlPolicy,
} from './features/providers/provider-ui-state'
import {
  AlertTriangle,
  Aperture,
  Bell,
  BookOpenText,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDashed,
  Clapperboard,
  Cloud,
  CloudUpload,
  Download,
  Film,
  Gauge,
  Grid2X2,
  Headphones,
  History,
  Image as ImageIcon,
  Library,
  LockKeyhole,
  Maximize2,
  MessageSquareText,
  Mic2,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCcw,
  RotateCcw,
  Search,
  Settings2,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  SquareStack,
  Trash2,
  Upload,
  Users,
  WandSparkles,
  X,
} from 'lucide-react'

type StageStatus = 'done' | 'active' | 'pending' | 'warning'

type Stage = {
  id: string
  short: string
  name: string
}

type ShotStatus = '已通过' | '待审核' | '生成中' | '待生成' | '失败'

type Shot = {
  id: number
  storyId?: string
  sceneId?: string
  code: string
  title: string
  framing: string
  movement: string
  transition?: string
  duration: string
  copy: string
  visualPrompt: string
  dialogue?: string
  status: ShotStatus
  imageClass: string
  imageUrl?: string
  assetId?: string
  locked?: boolean
  jobId?: string
  generationError?: string
  previousStatus?: Exclude<ShotStatus, '生成中'>
  isDemo?: boolean
}

type EditableShotPatch = Partial<Pick<
  Shot,
  'code' | 'title' | 'copy' | 'framing' | 'movement' | 'transition' | 'duration' | 'visualPrompt'
>>

type VisualAssetState = {
  status: 'idle' | 'generating' | 'ready' | 'failed'
  imageUrl?: string
  assetId?: string
  locked?: boolean
  jobId?: string
  error?: string
}

type ProductionContext = {
  projectId: string
  episode: EpisodeSummary
  episodeEtag: string
}

type StoryOperationScope = {
  projectId: string
  episodeId: string
  runId: number
}

type SaveState = 'loading' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'

type StoryEntityFocus = StoryEntitySearchResult & { focusRequestId: number }

type AssetImageConfirmationState = {
  attempt: FrozenAssetImagePaidAttempt
  confirmation: PublicPaidAigcConfirmation
}

type DialogueSpeechConfirmationState = {
  attempt: FrozenDialogueSpeechGenerationAttempt
  confirmation: PublicPaidAigcConfirmation
}

type StoryboardImageSubmissionBatch = {
  runId: number
  accepted: Array<{ shotId: number; job: ImageJob }>
  failedCount: number
}

type ShotMediaTimelineState = 'clean' | 'required' | 'reconciling' | 'ready' | 'error'

type ShotVideoTimingRemediationState = {
  sourceJobId: string
  remediation: ShotVideoTimingRemediation
}

type FrozenShotMediaReviewAttempt = {
  identity: string
  signature: string
  idempotencyKey: string
  episodeEtag: string
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const editable = target.closest('input, textarea, select, [contenteditable]')
  if (!editable) return false
  return editable instanceof HTMLElement ? editable.isContentEditable || editable.matches('input, textarea, select') : true
}

const stages: Stage[] = PRODUCTION_STAGES.map((stage) => ({ ...stage }))

// A fresh workspace starts empty. Real content is loaded from SQLite or
// generated through the configured text provider; sample shots must never be
// presented as project data.
const baseShots: Shot[] = []
const initialSourceText = ''

const EMPTY_EPISODE_SOURCE = '请在项目原著库输入故事内容。'

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function timingBindingLabel(binding: ShotVideoTimingBindingIdentity | null): string {
  if (!binding) return '无绑定 Asset'
  const shortId = binding.assetId.length > 12
    ? `${binding.assetId.slice(0, 8)}…${binding.assetId.slice(-4)}`
    : binding.assetId
  return `${shortId} · v${binding.version} · ${binding.durationSeconds.toFixed(2)} 秒 / ${binding.durationFrames} 帧`
}

function timingResolutionLabel(remediation: ShotVideoTimingRemediation): string {
  const resolution = remediation.currentResolution
  if (resolution.status === 'ready') {
    return `${resolution.decision.timelineDurationSeconds.toFixed(2)} 秒 / ${Math.round(resolution.decision.timelineDurationSeconds * 24)} 帧，已可重新预检`
  }
  if (resolution.status === 'requires_shot_split') {
    return `${resolution.speechDurationSeconds.toFixed(2)} 秒，超过 ${resolution.maximumProviderDurationSeconds} 秒上限，需先拆镜`
  }
  if (resolution.status === 'manual_duration_too_short') {
    return `${resolution.speechDurationSeconds.toFixed(2)} 秒，长于手工镜长 ${resolution.requestedDurationSeconds} 秒`
  }
  return `尚有 ${resolution.blockedLines.length} 句语音 Asset 未满足时长合同`
}

function browserOfflineStoryDraftStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function emptyOfflineStoryFormDrafts(): Pick<OfflineStoryDraftChanges, 'scenes' | 'dialogueLines'> {
  return { scenes: [], dialogueLines: [] }
}

function offlineStoryDraftPersistenceMessage(
  result: ReturnType<typeof saveOfflineStoryDraft> | ReturnType<typeof clearOfflineStoryDraft>,
): string {
  if (result.status === 'unavailable') return '浏览器拒绝访问本地草稿存储，断网保护暂不可用'
  if (result.status === 'rejected') {
    return result.reason === 'oversized'
      ? '本地剧本草稿超过 256KB，断网保护未写入'
      : '本地剧本草稿包含不受支持的字段，断网保护已拒绝写入'
  }
  return ''
}

function generatedImagesFromJob(job: GenerationJob): Array<{
  id: string
  url: string
  mimeType?: string
}> {
  if (!isRecordValue(job.output) || !Array.isArray(job.output.images)) return []
  return job.output.images.flatMap((value) => (
    isRecordValue(value) && typeof value.id === 'string' && typeof value.url === 'string'
      ? [{
          id: value.id,
          url: value.url,
          ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
        }]
      : []
  ))
}

type CharacterTurnaroundReferenceSet = Record<TurnaroundReferenceRole, MediaAsset>

type ShotReorderRequest = Readonly<{
  shotId: number
  storyShotId: string
  sceneId: string
  sourceRevisionId: string
  expectedShotIds: readonly string[]
  reorderedShotIds: readonly string[]
  decision: ReturnType<typeof scriptShotReorderConfirmation>
}>

const railItems: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'projects', label: '项目 Catalog', icon: BookOpenText },
  { id: 'production', label: '分集制作', icon: Clapperboard },
  { id: 'characters', label: '数字资产 Catalog', icon: SquareStack },
  { id: 'history', label: '版本记录', icon: History },
  { id: 'settings', label: 'Provider 设置', icon: Settings2 },
]

function useDialogFocus(onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog) return

    const getFocusable = () => Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.offsetParent !== null)

    const focusFrame = window.requestAnimationFrame(() => (getFocusable()[0] ?? dialog).focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = getFocusable()
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    dialog.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      dialog.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [])

  return dialogRef
}

function App() {
  const [currentStage, setCurrentStage] = useState(() => {
    const requestedStage = new URLSearchParams(window.location.search).get('stage')
    return isWorkspaceRoute(requestedStage) ? requestedStage : 'catalog-source'
  })
  const [activeRail, setActiveRail] = useState(() => (
    currentStage === 'catalog-source'
      ? 'projects'
      : currentStage === 'catalog-assets'
        ? 'characters'
        : 'production'
  ))
  const [shots, setShots] = useState(baseShots)
  const [sourceText, setSourceText] = useState(initialSourceText)
  const [activeShot, setActiveShot] = useState(1)
  const [isInspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 720)
  const [isTimelineOpen, setTimelineOpen] = useState(true)
  const [editorLayoutPreferences, setEditorLayoutPreferences] = useState<EditorLayoutPreferences>(() => {
    try {
      return parseEditorLayoutPreferences(window.localStorage.getItem(EDITOR_LAYOUT_STORAGE_KEY))
    } catch {
      return { ...DEFAULT_EDITOR_LAYOUT }
    }
  })
  const [activeLayoutResize, setActiveLayoutResize] = useState<'inspector' | 'timeline' | null>(null)
  const [timelineEditorReady, setTimelineEditorReady] = useState(false)
  const [isGenerating, setGenerating] = useState(false)
  const [generationTargets, setGenerationTargets] = useState<number[]>([])
  const [generationProgress, setGenerationProgress] = useState(0)
  const [cancellingShotIds, setCancellingShotIds] = useState<number[]>([])
  const [regenerateShotId, setRegenerateShotId] = useState<number | null>(null)
  const [toast, setToast] = useState('')
  const [showCommand, setShowCommand] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [pinnedTimeline, setPinnedTimeline] = useState<TimelineDocumentSnapshot | null>(null)
  const [showProviders, setShowProviders] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [selectedStyle, setSelectedStyle] = useState('国风动画')
  const [aspect, setAspect] = useState('16:9')
  const [consistencyLocked, setConsistencyLocked] = useState(true)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState('')
  const [productionContext, setProductionContext] = useState<ProductionContext | null>(null)
  const [catalogProjects, setCatalogProjects] = useState<ProjectSummary[]>([])
  const [catalogEpisodesByProject, setCatalogEpisodesByProject] = useState<Record<string, EpisodeSummary[]>>({})
  const [catalogProjectId, setCatalogProjectId] = useState<string | null>(null)
  const [catalogEpisodeId, setCatalogEpisodeId] = useState<string | null>(null)
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [catalogError, setCatalogError] = useState('')
  const [productionSwitchingEpisodeId, setProductionSwitchingEpisodeId] = useState<string | null>(null)
  const [projectSwitcherMemory, setProjectSwitcherMemory] = useState<ProjectSwitcherMemory>(() => {
    try {
      return parseProjectSwitcherMemory(window.localStorage.getItem(PROJECT_SWITCHER_STORAGE_KEY))
    } catch {
      return parseProjectSwitcherMemory(null)
    }
  })
  const [targetDurationSeconds, setTargetDurationSeconds] = useState(45)
  const [storyDocument, setStoryDocument] = useState<StoryDocument | null>(null)
  const [storyGenerationJobId, setStoryGenerationJobId] = useState<string | null>(null)
  const [storyState, setStoryState] = useState<'idle' | 'loading' | 'generating' | 'ready' | 'error'>('loading')
  const [storyError, setStoryError] = useState('')
  const [storyGenerationPreparing, setStoryGenerationPreparing] = useState(false)
  const [storyMutationState, setStoryMutationState] = useState<'idle' | 'saving'>('idle')
  const [shotReorderRequest, setShotReorderRequest] = useState<ShotReorderRequest | null>(null)
  const [storyRevisionHistory, dispatchStoryRevisionHistory] = useReducer(
    storyRevisionHistoryReducer,
    createStoryRevisionHistoryState(),
  )
  const [offlineStoryFormDrafts, setOfflineStoryFormDrafts] = useState<
    Pick<OfflineStoryDraftChanges, 'scenes' | 'dialogueLines'>
  >(emptyOfflineStoryFormDrafts)
  const [offlineStoryDraftBaseRevisionId, setOfflineStoryDraftBaseRevisionId] = useState<string | null>(null)
  const [offlineStoryDraftEditingScope, setOfflineStoryDraftEditingScope] = useState<OfflineStoryDraftScope | null>(null)
  const [offlineStoryDraftResolvedKey, setOfflineStoryDraftResolvedKey] = useState<string | null>(null)
  const [offlineStoryDraftRecovery, setOfflineStoryDraftRecovery] = useState<OfflineStoryDraft | null>(null)
  const [offlineStoryDraftRecoveryError, setOfflineStoryDraftRecoveryError] = useState('')
  const [offlineStoryDraftRecoveryBusy, setOfflineStoryDraftRecoveryBusy] = useState(false)
  const [offlineStoryDraftPersistenceError, setOfflineStoryDraftPersistenceError] = useState('')
  const [voiceCharacterFocusId, setVoiceCharacterFocusId] = useState<string | null>(null)
  const [assetEntityFocus, setAssetEntityFocus] = useState<{
    type: VisualAssetTarget['type']
    id: string
  } | null>(null)
  const [storyEntityFocus, setStoryEntityFocus] = useState<StoryEntityFocus | null>(null)
  const [projectNarratorVoice, setProjectNarratorVoice] = useState<ProjectNarratorVoiceProfileState | null>(null)
  const [projectNarratorVoiceState, setProjectNarratorVoiceState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [projectNarratorVoiceError, setProjectNarratorVoiceError] = useState('')
  const [projectNarratorVoiceReloadIndex, setProjectNarratorVoiceReloadIndex] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('loading')
  const [episodeRenderSettingsConflict, setEpisodeRenderSettingsConflict] = useState<
    EpisodeRenderSettingsConflict | null
  >(null)
  const [aliAsset, setAliAsset] = useState<VisualAssetState>({ status: 'idle' })
  const [assetLocking, setAssetLocking] = useState(false)
  const [visualAssetTargets, setVisualAssetTargets] = useState<VisualAssetTarget[]>([])
  const [visualAssetLibrary, setVisualAssetLibrary] = useState<MediaAsset[]>([])
  const [visualAssetState, setVisualAssetState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [visualAssetError, setVisualAssetError] = useState('')
  const [visualAssetActionKey, setVisualAssetActionKey] = useState<string | null>(null)
  const [visualAssetEditCompletionVersion, setVisualAssetEditCompletionVersion] = useState(0)
  const [assetImageConfirmation, setAssetImageConfirmation] = useState<AssetImageConfirmationState | null>(null)
  const [assetImageConfirmationBusy, setAssetImageConfirmationBusy] = useState(false)
  const [assetImageConfirmationError, setAssetImageConfirmationError] = useState('')
  const [assetImagePreparing, setAssetImagePreparing] = useState(false)
  const [dialogueSpeechConfirmation, setDialogueSpeechConfirmation] = useState<DialogueSpeechConfirmationState | null>(null)
  const [dialogueSpeechConfirmationBusy, setDialogueSpeechConfirmationBusy] = useState(false)
  const [dialogueSpeechConfirmationError, setDialogueSpeechConfirmationError] = useState('')
  const [providers, setProviders] = useState<ProviderConnection[]>([])
  const [shotVideoActionPending, setShotVideoActionPending] = useState(false)
  const [showShotVideoBatch, setShowShotVideoBatch] = useState(false)
  const [shotVideoBatchPreset, setShotVideoBatchPreset] = useState<'golden-candidate' | 'golden-baseline' | null>(null)
  const [shotVideoManualResolutionJobId, setShotVideoManualResolutionJobId] = useState<string | null>(null)
  const [shotVideoManualResolutionPending, setShotVideoManualResolutionPending] = useState(false)
  const [shotVideoManualResolutionError, setShotVideoManualResolutionError] = useState('')
  const [shotVideoTimingRemediation, setShotVideoTimingRemediation] = useState<ShotVideoTimingRemediationState | null>(null)
  const [shotVideoTimingRepreflight, setShotVideoTimingRepreflight] = useState<ShotVideoTimingRepreflightRecovery | null>(null)
  const [shotMediaReviews, setShotMediaReviews] = useState<Partial<Record<ShotMediaType, ShotMediaReviewSnapshot>>>({})
  const [historicalShotVideos, setHistoricalShotVideos] = useState<HistoricalShotVideoCandidatesResponse | null>(null)
  const [shotMediaReviewLoading, setShotMediaReviewLoading] = useState(false)
  const [shotMediaReviewError, setShotMediaReviewError] = useState('')
  const [shotMediaReviewActionKey, setShotMediaReviewActionKey] = useState<string | null>(null)
  const [shotMediaTimelineState, setShotMediaTimelineState] = useState<ShotMediaTimelineState>('clean')
  const [shotMediaTimelineMessage, setShotMediaTimelineMessage] = useState('')
  const jobsState = useProjectJobs(productionContext?.projectId)
  const episodeJobs = useMemo(
    () => jobsForEpisode(jobsState.jobs, productionContext?.episode.id),
    [jobsState.jobs, productionContext?.episode.id],
  )
  const currentStoryJobs = useMemo(() => jobsForCurrentStoryRevision(episodeJobs, {
    episodeId: productionContext?.episode.id ?? '',
    sourceRevisionId: productionContext?.episode.sourceRevisionId ?? null,
  }), [
    episodeJobs,
    productionContext?.episode.id,
    productionContext?.episode.sourceRevisionId,
  ])
  const generationRunRef = useRef(0)
  const aliRunRef = useRef(0)
  const productionBootstrapStartedRef = useRef(false)
  const catalogLoadRunRef = useRef(0)
  const catalogProjectIdRef = useRef<string | null>(null)
  const catalogEpisodeIdRef = useRef<string | null>(null)
  const productionSwitchRunRef = useRef(0)
  const projectSwitcherMemoryRef = useRef(projectSwitcherMemory)
  const handledStoryJobRef = useRef<string | null>(null)
  const storyIdempotencyRef = useRef(new Map<string, string>())
  const cachedStoryGenerationAttemptRef = useRef<FrozenStoryGenerationAttempt | null>(null)
  const storyGenerationPreparingRef = useRef(false)
  const imageIdempotencyRef = useRef(new Map<string, string>())
  const historicalVisualAdoptionBusyRef = useRef(false)
  const assetImageConfirmationBusyRef = useRef(false)
  const assetImagePreparingRef = useRef(false)
  const assetImageQueueRef = useRef<FrozenAssetImageGenerationAttempt[]>([])
  const storyboardImageSubmissionBatchRef = useRef<StoryboardImageSubmissionBatch | null>(null)
  const speechIdempotencyRef = useRef<SpeechGenerationIdempotencyRegistry>(new Map())
  const shotMediaReviewIdempotencyRef = useRef<ShotMediaReviewIdempotencyRegistry>(new Map())
  const frozenShotMediaReviewAttemptsRef = useRef(new Map<string, FrozenShotMediaReviewAttempt>())
  const shotMediaReviewLoadRunRef = useRef(0)
  const shotMediaReviewActionPendingRef = useRef(false)
  const historicalShotVideoRestoreKeysRef = useRef(new Map<string, string>())
  const dialogueSpeechPreparingRef = useRef(false)
  const dialogueSpeechConfirmationBusyRef = useRef(false)
  const shotsRef = useRef(shots)
  const activeShotRef = useRef(activeShot)
  const preferredStoryShotRef = useRef<string | null>(null)
  const timelinePersistenceRef = useRef<TimelinePersistenceHandle | null>(null)
  const workspaceRef = useRef<HTMLElement | null>(null)
  const editorLayoutRef = useRef<HTMLDivElement | null>(null)
  const stopLayoutResizeRef = useRef<() => void>(() => undefined)
  const productionContextRef = useRef<ProductionContext | null>(null)
  const storyScopeRunRef = useRef({ key: '', runId: 0 })
  const storyRevisionHistoryRef = useRef(storyRevisionHistory)
  const storyMutationInFlightRef = useRef(false)
  const selectedStyleRef = useRef(selectedStyle)
  const aspectRef = useRef(aspect)
  const episodeSettingsSaveChainRef = useRef<Promise<void>>(Promise.resolve())
  const episodeInputDraftDirtyRef = useRef(false)
  const episodeRenderSettingsConflictRef = useRef<EpisodeRenderSettingsConflict | null>(null)
  const episodeRenderSettingsConflictIdRef = useRef(0)
  const offlineStoryDraftChangesRef = useRef<OfflineStoryDraftChanges>(EMPTY_OFFLINE_STORY_DRAFT_CHANGES)
  const offlineStoryDraftDetectionRunRef = useRef(0)
  const offlineStoryDraftBaseRevisionIdRef = useRef<string | null>(null)
  const offlineStoryDraftEditingScopeRef = useRef<OfflineStoryDraftScope | null>(null)
  const offlineStoryDraftSessionSnapshotRef = useRef<{
    scope: OfflineStoryDraftScope
    changes: OfflineStoryDraftChanges
  } | null>(null)
  const storyEntityFocusRunRef = useRef(0)

  const updateProjectSwitcherMemory = useCallback((
    update: (current: ProjectSwitcherMemory) => ProjectSwitcherMemory,
  ) => {
    const next = update(projectSwitcherMemoryRef.current)
    projectSwitcherMemoryRef.current = next
    setProjectSwitcherMemory(next)
    try {
      window.localStorage.setItem(PROJECT_SWITCHER_STORAGE_KEY, serializeProjectSwitcherMemory(next))
    } catch {
      // Workspace recency is a local convenience. Durable project, Story and
      // timeline state remain server-owned when browser storage is denied.
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        EDITOR_LAYOUT_STORAGE_KEY,
        serializeEditorLayoutPreferences(editorLayoutPreferences),
      )
    } catch {
      // Layout persistence is a convenience only. Storage denial must not
      // interfere with editing or any durable project data.
    }
  }, [editorLayoutPreferences])

  useEffect(() => () => stopLayoutResizeRef.current(), [])

  const beginLayoutResize = useCallback((
    kind: 'inspector' | 'timeline',
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    stopLayoutResizeRef.current()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    handle.setPointerCapture?.(pointerId)
    const body = document.body
    const previousCursor = body.style.cursor
    const previousUserSelect = body.style.userSelect
    body.style.cursor = kind === 'inspector' ? 'col-resize' : 'row-resize'
    body.style.userSelect = 'none'
    setActiveLayoutResize(kind)

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      if (kind === 'inspector') {
        const editorRect = editorLayoutRef.current?.getBoundingClientRect()
        if (!editorRect) return
        const nextWidth = clampInspectorWidth(editorRect.right - moveEvent.clientX, editorRect.width)
        setEditorLayoutPreferences((current) => ({ ...current, inspectorWidthPx: nextWidth }))
        return
      }
      const workspaceRect = workspaceRef.current?.getBoundingClientRect()
      const editorRect = editorLayoutRef.current?.getBoundingClientRect()
      if (!workspaceRect || !editorRect) return
      const availableHeight = workspaceRect.bottom - editorRect.top
      const nextHeight = clampTimelineHeight(workspaceRect.bottom - moveEvent.clientY, availableHeight)
      setEditorLayoutPreferences((current) => ({ ...current, timelineHeightPx: nextHeight }))
    }

    const stop = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
      body.style.cursor = previousCursor
      body.style.userSelect = previousUserSelect
      setActiveLayoutResize(null)
      stopLayoutResizeRef.current = () => undefined
    }
    stopLayoutResizeRef.current = stop
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }, [])

  const adjustInspectorWidth = useCallback((delta: number) => {
    const availableWidth = editorLayoutRef.current?.getBoundingClientRect().width ?? window.innerWidth
    setEditorLayoutPreferences((current) => ({
      ...current,
      inspectorWidthPx: clampInspectorWidth(current.inspectorWidthPx + delta, availableWidth),
    }))
  }, [])

  const adjustTimelineHeight = useCallback((delta: number) => {
    const workspaceRect = workspaceRef.current?.getBoundingClientRect()
    const editorRect = editorLayoutRef.current?.getBoundingClientRect()
    const availableHeight = workspaceRect && editorRect
      ? workspaceRect.bottom - editorRect.top
      : window.innerHeight
    setEditorLayoutPreferences((current) => ({
      ...current,
      timelineHeightPx: clampTimelineHeight(
        (current.timelineHeightPx ?? DEFAULT_TIMELINE_HEIGHT_PX) + delta,
        availableHeight,
      ),
    }))
  }, [])

  const adoptOfflineStoryDraftEditingScope = (scope: OfflineStoryDraftScope | null) => {
    offlineStoryDraftEditingScopeRef.current = scope
    offlineStoryDraftBaseRevisionIdRef.current = scope?.baseSourceRevisionId ?? null
    setOfflineStoryDraftBaseRevisionId(scope?.baseSourceRevisionId ?? null)
    setOfflineStoryDraftEditingScope(scope)
  }

  const storyScopeFor = (context: ProductionContext): StoryOperationScope => {
    const key = `${context.projectId}\u0000${context.episode.id}`
    if (storyScopeRunRef.current.key !== key) {
      storyScopeRunRef.current = {
        key,
        runId: storyScopeRunRef.current.runId + 1,
      }
    }
    return {
      projectId: context.projectId,
      episodeId: context.episode.id,
      runId: storyScopeRunRef.current.runId,
    }
  }

  const storyScopeIsCurrent = (scope: StoryOperationScope): boolean => {
    const current = productionContextRef.current
    if (!current) return false
    const currentScope = storyScopeFor(current)
    return currentScope.projectId === scope.projectId
      && currentScope.episodeId === scope.episodeId
      && currentScope.runId === scope.runId
  }

  const selectedShot = useMemo(
    () => shots.find((shot) => shot.id === activeShot) ?? shots[0] ?? null,
    [shots, activeShot],
  )
  const dispatchStoryHistory = useCallback((
    action: Parameters<typeof storyRevisionHistoryReducer>[1],
  ) => {
    storyRevisionHistoryRef.current = storyRevisionHistoryReducer(
      storyRevisionHistoryRef.current,
      action,
    )
    dispatchStoryRevisionHistory(action)
  }, [])
  const reportOfflineSceneDraft = useCallback((
    sceneId: string,
    draft: OfflineStorySceneDraft | null,
  ) => {
    setOfflineStoryFormDrafts((current) => withOfflineSceneDraft({
      ...current,
      shots: [],
    }, draft, sceneId))
  }, [])
  const reportOfflineDialogueDraft = useCallback((
    target: Pick<OfflineStoryDialogueLineDraft, 'sceneId' | 'shotId' | 'lineId'>,
    draft: OfflineStoryDialogueLineDraft | null,
  ) => {
    setOfflineStoryFormDrafts((current) => withOfflineDialogueDraft({
      ...current,
      shots: [],
    }, draft, target))
  }, [])
  const offlineStoryDraftChanges = useMemo(() => composeOfflineStoryDraftChanges(
    offlineStoryFormDrafts,
    shots,
    storyDocument,
  ), [offlineStoryFormDrafts, shots, storyDocument])
  offlineStoryDraftChangesRef.current = offlineStoryDraftChanges
  offlineStoryDraftBaseRevisionIdRef.current = offlineStoryDraftBaseRevisionId
  offlineStoryDraftSessionSnapshotRef.current = offlineStoryDraftEditingScopeRef.current
    ? { scope: offlineStoryDraftEditingScopeRef.current, changes: offlineStoryDraftChanges }
    : null
  const hasUncommittedShotDraft = useMemo(() => (
    hasUncommittedScriptShotDraft(shots, storyDocument)
  ), [shots, storyDocument])
  const hasStoryDraft = offlineStoryDraftHasChanges(offlineStoryDraftChanges)
    || hasUncommittedShotDraft
  // This scope is published only after Episode and Story were read from one
  // stable revision/ETag authority bundle. Never derive it from a bootstrap
  // Episode that may still be paired with the previous Story document.
  const offlineStoryDraftScope = offlineStoryDraftEditingScope
  const offlineStoryDraftCurrentKey = offlineStoryDraftScope
    ? offlineStoryDraftStorageKey(offlineStoryDraftScope)
    : null
  const selectedStoryPosition = useMemo(() => {
    if (!selectedShot?.storyId || !selectedShot.sceneId || !storyDocument) return null
    const scene = storyDocument.scenes.find((candidate) => candidate.id === selectedShot.sceneId)
    if (!scene) return null
    const index = scene.shots.findIndex((shot) => shot.id === selectedShot.storyId)
    return index < 0 ? null : { index, count: scene.shots.length }
  }, [selectedShot?.sceneId, selectedShot?.storyId, storyDocument])
  const storyGenerationJob = useMemo(
    () => storyGenerationJobId
      ? episodeJobs.find((job) => job.id === storyGenerationJobId) ?? null
      : null,
    [episodeJobs, storyGenerationJobId],
  )
  const selectedShotVideoState = useMemo(() => {
    if (!productionContext || !selectedShot?.storyId) {
      return resolveShotVideoViewState([], {
        episodeId: productionContext?.episode.id ?? '',
        shotId: selectedShot?.storyId ?? '',
        sourceRevisionId: productionContext?.episode.sourceRevisionId ?? null,
      })
    }
    return resolveShotVideoViewState(currentStoryJobs, {
      episodeId: productionContext.episode.id,
      shotId: selectedShot.storyId,
      sourceRevisionId: productionContext.episode.sourceRevisionId,
    })
  }, [currentStoryJobs, productionContext, selectedShot?.storyId])
  const selectedShotMediaCandidateRevisionKey = useMemo(() => {
    if (!selectedShot?.storyId) return ''
    return currentStoryJobs.filter((job) => {
      if (job.status !== 'succeeded') return false
      if (job.type === 'shot.video.generate') return job.resourceId === selectedShot.storyId
      if (job.type !== 'asset.image.generate' || !isRecordValue(job.input)) return false
      const binding = isRecordValue(job.input.storyboardBinding)
        ? job.input.storyboardBinding
        : null
      return job.resourceId === selectedShot.storyId || binding?.shotId === selectedShot.storyId
    }).map((job) => `${job.id}:${job.updatedAt}`).sort().join('|')
  }, [currentStoryJobs, selectedShot?.storyId])
  const shotVideoManualResolutionJob = useMemo(
    () => shotVideoManualResolutionJobId
      ? episodeJobs.find((job) => job.id === shotVideoManualResolutionJobId) ?? null
      : null,
    [episodeJobs, shotVideoManualResolutionJobId],
  )
  const shotVideoReferenceRecommendations = useMemo(
    () => recommendShotVideoReferenceAssetIds(storyDocument, visualAssetTargets),
    [storyDocument, visualAssetTargets],
  )
  const shotVideoBatchShots = useMemo<ShotVideoBatchShot[]>(() => shots.flatMap((shot) => {
    if (!shot.storyId || !shot.sceneId) return []
    const video = resolveShotVideoViewState(currentStoryJobs, {
      episodeId: productionContext?.episode.id ?? '',
      shotId: shot.storyId,
      sourceRevisionId: productionContext?.episode.sourceRevisionId ?? null,
    })
    const videoState: ShotVideoBatchShot['videoState'] = video.manualReviewRequired
      || video.status === 'queued'
      || video.status === 'running'
      ? 'locked'
      : video.status === 'ready' && video.asset
        ? 'generated'
        : 'pending'
    return [{
      shotId: shot.storyId,
      sceneId: shot.sceneId,
      code: shot.code,
      title: shot.title,
      durationSeconds: Number.parseFloat(shot.duration) || 4,
      assetId: shot.assetId ?? null,
      imageUrl: shot.imageUrl ?? null,
      recommendedReferenceAssetIds: shotVideoReferenceRecommendations[shot.storyId] ?? [],
      videoState,
    }]
  }), [
    currentStoryJobs,
    productionContext?.episode.id,
    productionContext?.episode.sourceRevisionId,
    shotVideoReferenceRecommendations,
    shots,
  ])
  const shotVideoBatchSummary = useMemo(
    () => summarizeShotVideoBatchAvailability(shotVideoBatchShots),
    [shotVideoBatchShots],
  )
  const shotVideoBlockedReasons = useMemo(() => Object.fromEntries(shotVideoBatchShots.flatMap((shot) => {
    const reason = shotVideoCreationBlockReason(currentStoryJobs, {
      episodeId: productionContext?.episode.id ?? '',
      shotId: shot.shotId,
      sourceRevisionId: productionContext?.episode.sourceRevisionId ?? null,
    })
    return reason ? [[shot.shotId, reason]] : []
  })), [
    currentStoryJobs,
    productionContext?.episode.id,
    productionContext?.episode.sourceRevisionId,
    shotVideoBatchShots,
  ])
  const visualAssetJobs = useMemo(() => currentStoryJobs.filter((job) => {
    const binding = visualAssetJobBinding(job)
    return binding !== null
      && job.episodeId === productionContext?.episode.id
      && binding.expectedRevisionId === productionContext?.episode.sourceRevisionId
      && !generationJobIsStale(job)
  }), [currentStoryJobs, productionContext?.episode.id, productionContext?.episode.sourceRevisionId])
  const visualAssetHistoryJobs = useMemo(() => episodeJobs.filter((job) => (
    visualAssetJobBinding(job) !== null
    && job.episodeId === productionContext?.episode.id
  )), [episodeJobs, productionContext?.episode.id])
  const productionPinnedAssetVersionIds = useMemo(() => {
    const references: Array<string | null | undefined> = []
    for (const target of visualAssetTargets) {
      references.push(
        target.lockedAssetId,
        target.lockedReferences?.frontAssetId,
        target.lockedReferences?.sideAssetId,
        target.lockedReferences?.backAssetId,
      )
    }
    for (const shot of shots) {
      references.push(shot.assetId)
    }
    for (const review of Object.values(shotMediaReviews)) {
      references.push(review?.currentSelectionAssetId)
    }
    return collectCurrentProductionAssetVersionIds({
      projectId: productionContext?.projectId ?? '',
      episodeId: productionContext?.episode.id ?? '',
      sourceRevisionId: productionContext?.episode.sourceRevisionId ?? null,
      assets: visualAssetLibrary,
      referencedAssetVersionIds: references,
    })
  }, [
    productionContext?.episode.id,
    productionContext?.episode.sourceRevisionId,
    productionContext?.projectId,
    shotMediaReviews,
    shots,
    visualAssetLibrary,
    visualAssetTargets,
  ])
  const visualAssetSuccessKey = useMemo(() => visualAssetJobs
    .filter((job) => job.status === 'succeeded')
    .map((job) => `${job.id}:${job.updatedAt}`)
    .sort()
    .join('|'), [visualAssetJobs])
  const lockedVisualAssetCount = visualAssetTargets.filter((target) => {
    if (!target.lockedAssetId) return false
    const asset = visualAssetLibrary.find((candidate) => candidate.id === target.lockedAssetId)
    // An Episode binding points at an immutable asset version. A later script
    // revision may invalidate downstream shots, but it must not silently turn
    // an already-confirmed production reference back into "待锁定".
    return asset?.status === 'ready'
  }).length
  const visualAssetStageStatus: StageStatus = visualAssetTargets.length > 0
    && lockedVisualAssetCount === visualAssetTargets.length
    ? 'done'
    : visualAssetJobs.some((job) => job.status === 'failed')
      ? 'warning'
      : 'pending'
  const pipelineStageStatuses = useMemo<Record<string, StageStatus>>(() => {
    const storyStatus: StageStatus = storyDocument
      ? 'done'
      : storyState === 'error'
        ? 'warning'
        : 'pending'
    const audioStatus: StageStatus = (() => {
      const lineIds = new Set(storyDocument?.scenes.flatMap((scene) => scene.shots.flatMap(
        (shot) => shot.dialogueLines.map((line) => line.id),
      )) ?? [])
      if (lineIds.size === 0) return storyDocument ? 'done' : 'pending'
      const succeeded = completedSpeechLineIdsForCurrentStory(currentStoryJobs, {
        episodeId: productionContext?.episode.id ?? '',
        sourceRevisionId: productionContext?.episode.sourceRevisionId ?? null,
      })
      if ([...lineIds].every((lineId) => succeeded.has(lineId))) return 'done'
      return currentStoryJobs.some((job) => job.type === 'dialogue.speech.generate' && job.status === 'failed')
        ? 'warning'
        : 'pending'
    })()
    const scriptAndAudioStatus: StageStatus = storyStatus === 'warning' || audioStatus === 'warning'
      ? 'warning'
      : storyStatus === 'done' && audioStatus === 'done'
        ? 'done'
        : 'pending'
    return {
      source: sourceText.trim() ? 'done' : 'warning',
      assets: visualAssetStageStatus,
      // Stage 3 is complete only when both the immutable script and every
      // required real speech Asset are ready. `audio` is kept for old links.
      script: scriptAndAudioStatus,
      audio: audioStatus,
      storyboard: storyboardProductionGateStatus(shots.map((shot) => ({
        imageReady: Boolean(shot.imageUrl),
        imageFailed: shot.status === '失败',
      }))),
      export: latestExportJobForCurrentStory(currentStoryJobs, {
        episodeId: productionContext?.episode.id ?? '',
        sourceRevisionId: productionContext?.episode.sourceRevisionId ?? null,
      })?.status === 'succeeded'
        ? 'done'
        : currentStoryJobs.some((job) => job.type === 'export.render' && job.status === 'failed')
          ? 'warning'
          : 'pending',
    }
  }, [
    currentStoryJobs,
    productionContext?.episode.id,
    productionContext?.episode.sourceRevisionId,
    shots,
    sourceText,
    storyDocument,
    storyState,
    visualAssetStageStatus,
  ])
  const timelineAssetRevisionKey = useMemo(() => {
    const visual = shots.map((shot) => `${shot.storyId ?? shot.id}:${shot.assetId ?? ''}`)
    const speech = currentStoryJobs.filter((job) => (
      job.type === 'dialogue.speech.generate'
      && job.status === 'succeeded'
      && !generationJobIsStale(job)
    )).map((job) => {
      const output = isRecordValue(job.output) ? job.output : null
      const asset = output && isRecordValue(output.asset) ? output.asset : null
      return `${job.resourceId ?? job.id}:${typeof asset?.id === 'string' ? asset.id : job.updatedAt}`
    })
    const video = currentStoryJobs.filter((job) => (
      job.type === 'shot.video.generate'
      && job.status === 'succeeded'
      && !generationJobIsStale(job)
    )).map((job) => {
      const output = isRecordValue(job.output) ? job.output : null
      const asset = output && isRecordValue(output.asset) ? output.asset : null
      return `${job.resourceId ?? job.id}:${typeof asset?.id === 'string' ? asset.id : job.updatedAt}`
    })
    return [...visual, ...speech, ...video].sort().join('|')
  }, [currentStoryJobs, shots])

  const defaultImageProvider = defaultProviderForKind(providers, 'image')
  const executableImageProvider = defaultExecutableProviderForKind(providers, 'image')
  const executableTextProvider = defaultExecutableProviderForKind(providers, 'text')
  const executableSpeechProvider = defaultExecutableProviderForKind(providers, 'speech')
  const miniMaxSpeechProvider = providers.find((provider) => provider.id === 'minimax-speech') ?? null
  const seedanceProvider = providers.find((provider) => provider.id === 'seedance-video')
  const seedanceConfigured = isVerifiedSeedanceProvider(seedanceProvider)

  const providerSettings = useMemo<ProviderPublicSettings[]>(() => providerCatalog.map((catalog) => {
    const provider = providers.find((candidate) => candidate.id === catalog.id)
    return {
      ...catalog,
      connectionState: providerUiConnectionState(provider),
      connectionLabel: providerConnectionLabel(provider) ?? undefined,
      baseUrl: provider?.baseUrl ?? catalog.defaultBaseUrl,
      model: provider?.model ?? catalog.defaultModel,
      editableBaseUrl: provider?.configurableBaseUrl ?? catalog.editableBaseUrl,
      hasStoredCredential: provider?.credentialState === 'present'
        || provider?.credentialState === 'external',
      isDefault: provider?.isDefault,
      statusDetail: providerStatusDetail(provider),
      verificationNotice: providerVerificationNotice(provider) ?? undefined,
    }
  }), [providers])

  useEffect(() => {
    shotsRef.current = shots
  }, [shots])

  useEffect(() => {
    activeShotRef.current = activeShot
  }, [activeShot])

  useEffect(() => {
    if (!productionContext || !isProductionStageRoute(currentStage)) return
    const selectedStoryShotId = selectedShot?.storyId
      && storyDocument?.scenes.some((scene) => scene.shots.some((shot) => shot.id === selectedShot.storyId))
      ? selectedShot.storyId
      : undefined
    updateProjectSwitcherMemory((current) => rememberProductionWorkspace(current, {
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
      stage: currentStage,
      storyShotId: selectedStoryShotId,
    }))
  }, [
    activeShot,
    currentStage,
    productionContext?.episode.id,
    productionContext?.projectId,
    selectedShot?.storyId,
    storyDocument,
    updateProjectSwitcherMemory,
  ])

  useEffect(() => {
    productionContextRef.current = productionContext
    const nextKey = productionContext
      ? `${productionContext.projectId}\u0000${productionContext.episode.id}`
      : ''
    if (storyScopeRunRef.current.key !== nextKey) {
      storyScopeRunRef.current = {
        key: nextKey,
        runId: storyScopeRunRef.current.runId + 1,
      }
    }
  }, [productionContext])

  useEffect(() => {
    // A confirmation is valid only for the exact story scope frozen during
    // preflight. Navigating to another project/episode/revision closes it
    // before a paid POST can be initiated from stale UI state.
    setDialogueSpeechConfirmation(null)
    setDialogueSpeechConfirmationError('')
    setDialogueSpeechConfirmationBusy(false)
    dialogueSpeechPreparingRef.current = false
    dialogueSpeechConfirmationBusyRef.current = false
    setShotVideoTimingRemediation(null)
    setShotVideoTimingRepreflight(null)
  }, [
    productionContext?.projectId,
    productionContext?.episode.id,
    productionContext?.episode.sourceRevisionId,
  ])

  useEffect(() => {
    storyRevisionHistoryRef.current = storyRevisionHistory
  }, [storyRevisionHistory])

  useEffect(() => {
    selectedStyleRef.current = selectedStyle
  }, [selectedStyle])

  useEffect(() => {
    aspectRef.current = aspect
  }, [aspect])

  const publishEpisodeRenderSettingsConflict = (
    next: EpisodeRenderSettingsConflict | null,
  ) => {
    episodeRenderSettingsConflictRef.current = next
    setEpisodeRenderSettingsConflict(next)
  }

  const refreshProviders = async (signal?: AbortSignal) => {
    try {
      setProviders(await api.listProviders({ signal }))
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
        setToast(error instanceof Error ? error.message : '无法读取 Provider 设置')
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void refreshProviders(controller.signal)
    return () => controller.abort()
  }, [])

  const refreshCatalog = useCallback(async (options: {
    signal?: AbortSignal
    preferredProjectId?: string | null
    preferredEpisodeId?: string | null
  } = {}) => {
    const run = ++catalogLoadRunRef.current
    setCatalogState('loading')
    setCatalogError('')
    try {
      const projects = await api.listProjects({ signal: options.signal })
      const episodePairs = await Promise.all(projects.map(async (project) => [
        project.id,
        await api.listProjectEpisodes(project.id, { signal: options.signal }),
      ] as const))
      if (run !== catalogLoadRunRef.current) return
      const episodesByProject = Object.fromEntries(episodePairs)
      const preferredProject = options.preferredProjectId
        ?? catalogProjectIdRef.current
        ?? productionContextRef.current?.projectId
        ?? projects[0]?.id
        ?? null
      const nextProjectId = preferredProject && projects.some((project) => project.id === preferredProject)
        ? preferredProject
        : projects[0]?.id ?? null
      const episodes = nextProjectId ? episodesByProject[nextProjectId] ?? [] : []
      const preferredEpisode = options.preferredEpisodeId ?? catalogEpisodeIdRef.current
      const nextEpisodeId = preferredEpisode && episodes.some((episode) => episode.id === preferredEpisode)
        ? preferredEpisode
        : null
      setCatalogProjects(projects)
      setCatalogEpisodesByProject(episodesByProject)
      catalogProjectIdRef.current = nextProjectId
      catalogEpisodeIdRef.current = nextEpisodeId
      setCatalogProjectId(nextProjectId)
      setCatalogEpisodeId(nextEpisodeId)
      setCatalogState('ready')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'REQUEST_ABORTED') return
      if (run !== catalogLoadRunRef.current) return
      setCatalogState('error')
      setCatalogError(error instanceof Error ? error.message : '无法读取项目 Catalog')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refreshCatalog({ signal: controller.signal })
    return () => controller.abort()
  }, [refreshCatalog])

  const saveProvider = async (providerId: string, input: ProviderCredentialInput) => {
    const provider = await api.saveProviderCredentials(providerId, {
      ...input,
      enabled: true,
    })
    setProviders((items) => [...items.filter((item) => item.id !== provider.id), provider])
  }

  const testProvider = async (providerId: string): Promise<ProviderTestResult> => {
    const startedAt = performance.now()
    const provider = await api.testProvider(providerId)
    setProviders((items) => [...items.filter((item) => item.id !== provider.id), provider])
    return {
      ok: provider.health.status === 'ok',
      summary: provider.health.message,
      latencyMs: Math.round(performance.now() - startedAt),
    }
  }

  const deleteProvider = async (providerId: string) => {
    const provider = await api.deleteProviderCredentials(providerId)
    setProviders((items) => [...items.filter((item) => item.id !== provider.id), provider])
  }

  const setDefaultProvider = async (providerId: string) => {
    await api.setDefaultProvider(providerId)
    await refreshProviders()
  }

  const retryTask = async (job: GenerationJob) => {
    const cancelledProviderResume = job.status === 'cancelled'
      && job.retryDisposition === 'resume-existing-provider-task'
    if (job.status !== 'failed' && !cancelledProviderResume) return

    const focusBoundShot = (stage: 'audio' | 'storyboard' = 'storyboard'): Shot | null => {
      const binding = isRecordValue(job.input) && isRecordValue(job.input.binding)
        ? job.input.binding
        : null
      const publicShotId = typeof binding?.shotId === 'string'
        ? binding.shotId
        : typeof job.resourceId === 'string'
          ? job.resourceId
          : null
      const publicSceneId = typeof binding?.sceneId === 'string' ? binding.sceneId : null
      const matchingShots = publicShotId
        ? shotsRef.current.filter((candidate) => candidate.storyId === publicShotId)
        : []
      const shot = publicSceneId
        ? matchingShots.find((candidate) => candidate.sceneId === publicSceneId) ?? null
        : matchingShots.length === 1 ? matchingShots[0]! : null
      if (shot) setActiveShot(shot.id)
      setActiveRail('production')
      setCurrentStage(stage)
      return shot
    }

    const routePaidReconfirmation = () => {
      setShowTasks(false)
      if (job.type === 'asset.image.generate' || job.type === 'asset.image.edit' || job.type === 'image.generate') {
        const entityBinding = visualAssetJobBinding(job)
        if (entityBinding) {
          setAssetEntityFocus({ type: entityBinding.entityType, id: entityBinding.entityId })
          if (entityBinding.entityType === 'character') setVoiceCharacterFocusId(entityBinding.entityId)
          setActiveRail('production')
          setCurrentStage('assets')
          setToast('已返回原图片工作台；请重新预检并明确确认，任务中心未创建 Provider Job')
          return
        }
        const storyboardBinding = isRecordValue(job.input)
          && isRecordValue(job.input.storyboardBinding)
          ? job.input.storyboardBinding
          : null
        const shot = typeof storyboardBinding?.shotId === 'string'
          ? shotsRef.current.find((candidate) => candidate.storyId === storyboardBinding.shotId) ?? null
          : null
        if (shot) {
          setActiveShot(shot.id)
          setActiveRail('production')
          setCurrentStage('storyboard')
          setToast('已定位原分镜；请重新预检并确认新的图片任务')
          return
        }
        setActiveRail('production')
        setCurrentStage('assets')
        setToast('无法确定历史图片的当前实体；已返回资产工作台，不会盲目创建付费任务')
        return
      }
      if (job.type === 'dialogue.speech.generate') {
        setActiveRail('production')
        setCurrentStage('audio')
        setToast('已返回原台词的配音工作台；请重新预检后确认新的 TTS 任务')
        return
      }
      if (job.type === 'character.voice.preview') {
        const characterId = isRecordValue(job.input) && typeof job.input.characterId === 'string'
          ? job.input.characterId
          : typeof job.resourceId === 'string' ? job.resourceId : null
        if (characterId) {
          setVoiceCharacterFocusId(characterId)
          setAssetEntityFocus({ type: 'character', id: characterId })
        }
        setActiveRail('production')
        setCurrentStage('assets')
        setToast('已返回角色声线卡；请重新预检并确认试听')
        return
      }
      if (job.type === 'project.narrator.voice.preview') {
        setVoiceCharacterFocusId(null)
        setAssetEntityFocus(null)
        setActiveRail('production')
        setCurrentStage('assets')
        setToast('已返回项目旁白声线卡；请重新预检并确认试听')
        return
      }
      if (job.type === 'shot.video.generate') {
        if (job.error?.code === 'STALE_AUDIO_TIMING' && job.timingRemediation) {
          const remediation = job.timingRemediation
          const focusLineId = shotVideoTimingRemediationFocusLineId(remediation)
          const nextDuration = remediation.currentResolution.status === 'ready'
            ? `${remediation.currentResolution.decision.timelineDurationSeconds.toFixed(2)} 秒`
            : remediation.currentResolution.status === 'requires_shot_split'
              ? `${remediation.currentResolution.speechDurationSeconds.toFixed(2)} 秒（需拆镜）`
              : remediation.currentResolution.status === 'manual_duration_too_short'
                ? `${remediation.currentResolution.speechDurationSeconds.toFixed(2)} 秒（原手工镜长过短）`
                : '待补齐或重新生成语音后核定'
          setShotVideoTimingRemediation({ sourceJobId: job.id, remediation })
          setShotVideoTimingRepreflight(null)
          focusBoundShot('audio')
          setToast(
            `音频时长已变化：旧 ${remediation.previousDecision.timelineDurationSeconds.toFixed(2)} 秒，` +
            `新 ${nextDuration}；${remediation.providerSubmissionState === 'task-exists'
              ? '原 Provider task 已存在，不会自动重提。'
              : '尚未创建 Provider task。'}` +
            `${focusLineId ? ' 已定位首个受影响台词。' : ' 请在「剧本与配音」内页核对当前镜头。'}`,
          )
          return
        }
        focusBoundShot()
        setShowShotVideoBatch(true)
        setToast('已返回原镜头的 Seedance 工作台；请重新预检，本次未提交 Provider')
        return
      }
      setToast('该任务需要回到原工作台重新预检；任务中心不会直接创建可计费 Job')
    }

    if (job.retryDisposition === 'paid-reconfirmation-required') {
      routePaidReconfirmation()
      return
    }

    if (job.retryDisposition === 'manual-resolution') {
      setShowTasks(false)
      if (job.type === 'shot.video.generate') {
        if (job.error?.code === 'STALE_AUDIO_TIMING') {
          setShotVideoTimingRemediation(null)
          setShotVideoTimingRepreflight(null)
          focusBoundShot('audio')
          setToast('这是旧版音频时长失效记录，缺少安全恢复证据；已返回「剧本与配音」内页，请人工核对后从当前镜头重新预检。')
          return
        }
        focusBoundShot()
        setShotVideoManualResolutionError('')
        setShotVideoManualResolutionJobId(job.id)
        return
      }
      if (job.type === 'story.generate') {
        setActiveRail('production')
        setCurrentStage('source')
        setToast('LLM 提交结果不明，不会通用重提；可在原著工作台显式发起新一轮')
        return
      }
      if (job.type === 'character.voice.recommend') {
        const characterId = isRecordValue(job.input) && typeof job.input.characterId === 'string'
          ? job.input.characterId
          : typeof job.resourceId === 'string' ? job.resourceId : null
        if (characterId) {
          setVoiceCharacterFocusId(characterId)
          setAssetEntityFocus({ type: 'character', id: characterId })
        }
        setActiveRail('production')
        setCurrentStage('assets')
        setToast('LLM 声线推荐结果不明，不会通用重提；可在原角色声线卡显式发起新一轮')
        return
      }
      if (job.type === 'dialogue.performance.recommend') {
        setActiveRail('production')
        setCurrentStage('audio')
        setToast('LLM 台词指导结果不明，不会通用重提；可在原配音台词卡显式发起新一轮')
        return
      }
      if (job.type === 'shot.video.reference.analyze') {
        const selectors = isRecordValue(job.input) && Array.isArray(job.input.selectors)
          ? job.input.selectors
          : []
        const selector = selectors.find((candidate) => (
          isRecordValue(candidate) && typeof candidate.shotId === 'string'
        ))
        const shotId = isRecordValue(selector) && typeof selector.shotId === 'string'
          ? selector.shotId
          : null
        const shot = shotId
          ? shotsRef.current.find((candidate) => candidate.storyId === shotId) ?? null
          : null
        if (shot) setActiveShot(shot.id)
        setActiveRail('production')
        setCurrentStage('storyboard')
        setShowShotVideoBatch(true)
        setToast('LLM 视觉选镜结果不明，不会通用重提；可在原 Seedance 工作台显式发起新一轮')
        return
      }
      if (job.type === 'asset.image.generate'
        || job.type === 'asset.image.edit'
        || job.type === 'image.generate'
        || job.type === 'dialogue.speech.generate'
        || job.type === 'character.voice.preview'
        || job.type === 'project.narrator.voice.preview') {
        routePaidReconfirmation()
        setToast('Provider 提交结果不明，已禁止通用重试；请先在供应商控制台核对并人工处理')
        return
      }
      setToast('任务执行结果不明，不会通用重提；请回原工作台显式发起新一轮')
      return
    }

    if (job.retryDisposition !== 'generic-free-retry'
      && job.retryDisposition !== 'resume-existing-provider-task') {
      setToast('该任务不允许通用重试')
      return
    }

    try {
      await api.retryGenerationJob(job.id)
      await jobsState.refresh()
      setToast(job.retryDisposition === 'resume-existing-provider-task'
        ? '已继续查询原 Provider 任务，未发起新的计费提交'
        : '免费任务重试已入队')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '任务重试失败')
    }
  }

  const cancelTask = async (job: GenerationJob) => {
    try {
      const cancelled = await api.cancelGenerationJob(job.id)
      await jobsState.refresh()
      setToast(job.type === 'shot.video.generate'
        ? cancelled.cancellation?.message
          ?? cancelled.error?.message
          ?? '本地视频处理已停止；请到供应商控制台核对上游任务与费用'
        : '任务已取消')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '任务取消失败')
    }
  }

  const generateDialogueSpeech = async (
    lineId: string,
    settings: Omit<CreateDialogueSpeechJobInput, 'projectId' | 'episodeId'>,
  ): Promise<void> => {
    if (!productionContext) throw new Error('真实制作工程尚未初始化')
    if (dialogueSpeechPreparingRef.current
      || dialogueSpeechConfirmationBusyRef.current
      || dialogueSpeechConfirmation !== null) {
      throw new Error('另一条语音计费意图正在核对，请先完成或取消')
    }
    const request: CreateDialogueSpeechJobInput = {
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
      ...settings,
    }
    const signature = JSON.stringify({
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
      revisionId: productionContext.episode.sourceRevisionId,
      lineId,
      request,
    })
    const idempotencyKey = acquireSpeechGenerationIdempotencyKey(
      speechIdempotencyRef.current,
      signature,
      currentStoryJobs,
    )
    const attempt = freezeDialogueSpeechGenerationAttempt({
      signature,
      lineId,
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
      sourceRevisionId: productionContext.episode.sourceRevisionId,
      idempotencyKey,
      request,
    })
    dialogueSpeechPreparingRef.current = true
    setDialogueSpeechConfirmationError('')
    try {
      const confirmation = await api.preflightDialogueSpeechGenerationJob(
        attempt.lineId,
        attempt.input,
        attempt.idempotencyKey,
      )
      const authoritative = productionContextRef.current
      if (!authoritative
        || authoritative.projectId !== attempt.projectId
        || authoritative.episode.id !== attempt.episodeId
        || authoritative.episode.sourceRevisionId !== attempt.sourceRevisionId) {
        throw new Error('剧本范围或修订已变化，本次预检已作废且没有创建任务')
      }
      setDialogueSpeechConfirmation({ attempt, confirmation })
      setToast('语音合成已通过免费预检，请明确确认后创建 1 个任务')
    } finally {
      dialogueSpeechPreparingRef.current = false
    }
  }

  const refreshDialogueSpeechConfirmation = async () => {
    const current = dialogueSpeechConfirmation
    if (!current || dialogueSpeechConfirmationBusyRef.current) return
    dialogueSpeechConfirmationBusyRef.current = true
    setDialogueSpeechConfirmationBusy(true)
    setDialogueSpeechConfirmationError('')
    try {
      const confirmation = await api.preflightDialogueSpeechGenerationJob(
        current.attempt.lineId,
        current.attempt.input,
        current.attempt.idempotencyKey,
      )
      const authoritative = productionContextRef.current
      if (!authoritative
        || authoritative.projectId !== current.attempt.projectId
        || authoritative.episode.id !== current.attempt.episodeId
        || authoritative.episode.sourceRevisionId !== current.attempt.sourceRevisionId) {
        setDialogueSpeechConfirmation(null)
        setToast('剧本范围或修订已变化；旧确认已取消且没有创建语音任务')
        return
      }
      setDialogueSpeechConfirmation({ attempt: current.attempt, confirmation })
    } catch (error) {
      setDialogueSpeechConfirmationError(error instanceof Error ? error.message : '无法刷新语音合成确认')
    } finally {
      dialogueSpeechConfirmationBusyRef.current = false
      setDialogueSpeechConfirmationBusy(false)
    }
  }

  const confirmDialogueSpeech = async () => {
    const current = dialogueSpeechConfirmation
    if (!current || dialogueSpeechConfirmationBusyRef.current) return
    const authoritative = productionContextRef.current
    if (!authoritative
      || authoritative.projectId !== current.attempt.projectId
      || authoritative.episode.id !== current.attempt.episodeId
      || authoritative.episode.sourceRevisionId !== current.attempt.sourceRevisionId) {
      setDialogueSpeechConfirmation(null)
      setDialogueSpeechConfirmationError('')
      setToast('剧本范围或修订已变化；旧确认已取消且没有创建语音任务')
      return
    }
    const confirmed = confirmedDialogueSpeechGenerationRequest(
      current.attempt,
      current.confirmation,
    )
    if (!confirmed) {
      await refreshDialogueSpeechConfirmation()
      return
    }
    dialogueSpeechConfirmationBusyRef.current = true
    setDialogueSpeechConfirmationBusy(true)
    setDialogueSpeechConfirmationError('')
    try {
      const result = await submitDialogueSpeechWithIdempotency({
        registry: speechIdempotencyRef.current,
        signature: current.attempt.signature,
        currentJobs: currentStoryJobs,
        expectedIdempotencyKey: confirmed.idempotencyKey,
        createJob: (idempotencyKey) => api.createDialogueSpeechGenerationJob(
          confirmed.lineId,
          confirmed.input,
          idempotencyKey,
          confirmed.confirmationToken,
        ),
        rememberJob: jobsState.remember,
        refreshJobs: jobsState.refresh,
      })
      setDialogueSpeechConfirmation(null)
      setToast(result.refreshSynchronized
        ? '真实语音合成任务已提交'
        : '语音任务已提交，任务状态将在连接恢复后同步')
    } catch (error) {
      if (error instanceof ApiError
        && error.code === 'PAID_CONFIRMATION_REQUIRED'
        && isRecordValue(error.details)
        && Object.hasOwn(error.details, 'confirmation')) {
        try {
          const confirmation = parsePublicPaidAigcConfirmation(
            error.details.confirmation,
            'dialogue.speech.generate',
          )
          setDialogueSpeechConfirmation({ attempt: current.attempt, confirmation })
          setDialogueSpeechConfirmationError('服务端状态或确认有效期已变化，已刷新确认；本次没有创建任务，请重新确认。')
          return
        } catch {
          // Surface the original safe API error if the challenge is malformed.
        }
      }
      // Retain the exact frozen attempt and lease. A repeated confirm replays
      // the same POST if the first response became ambiguous after commit.
      setDialogueSpeechConfirmationError(error instanceof Error ? error.message : '语音合成任务提交失败')
    } finally {
      dialogueSpeechConfirmationBusyRef.current = false
      setDialogueSpeechConfirmationBusy(false)
    }
  }

  const generateSelectedShotVideo = async () => {
    if (!productionContext || !selectedShot?.storyId || !productionContext.episode.sourceRevisionId) {
      setToast('请先生成并保存结构剧本，再生成逐镜视频')
      return
    }
    if (!seedanceConfigured) {
      setShowProviders(true)
      setToast(seedanceGenerationBlockReason(seedanceProvider)
        ?? '请先验证 Seedance 2.0 Provider')
      return
    }
    setShotVideoActionPending(true)
    try {
      await refreshVisualAssetWorkbench()
    } catch (error) {
      setToast(error instanceof Error ? error.message : '无法刷新 Seedance 参考图资产')
    } finally {
      setShotVideoActionPending(false)
      setShowShotVideoBatch(true)
    }
  }

  const retrySelectedShotVideo = async () => {
    if (!selectedShotVideoState.jobId || !selectedShotVideoState.retryable) return
    const durable = episodeJobs.find((job) => job.id === selectedShotVideoState.jobId)
    if (!durable || durable.retryDisposition !== 'resume-existing-provider-task') {
      setToast('Seedance 任务已不能安全续查，请刷新后重新预检')
      return
    }
    setShotVideoActionPending(true)
    try {
      await api.retryGenerationJob(selectedShotVideoState.jobId)
      await jobsState.refresh()
      setToast('Seedance 已继续查询原上游任务')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PROVIDER_NOT_CONFIGURED') {
        setShowProviders(true)
      }
      setToast(error instanceof Error ? error.message : '逐镜视频任务重试失败')
    } finally {
      setShotVideoActionPending(false)
    }
  }

  const cancelSelectedShotVideo = async () => {
    if (!selectedShotVideoState.jobId) return
    setShotVideoActionPending(true)
    try {
      const cancelled = await api.cancelGenerationJob(selectedShotVideoState.jobId)
      await jobsState.refresh()
      setToast(cancelled.cancellation?.message
        ?? cancelled.error?.message
        ?? '本地视频处理已停止；请到供应商控制台核对上游任务与费用')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '逐镜视频任务取消失败')
    } finally {
      setShotVideoActionPending(false)
    }
  }

  const openSelectedShotVideoManualResolution = () => {
    if (!selectedShotVideoState.manualReviewRequired || !selectedShotVideoState.jobId) return
    setShotVideoManualResolutionError('')
    setShotVideoManualResolutionJobId(selectedShotVideoState.jobId)
  }

  const resolveSelectedShotVideoUnknownSubmission = async (note: string) => {
    if (!productionContext || !shotVideoManualResolutionJob) return
    setShotVideoManualResolutionPending(true)
    setShotVideoManualResolutionError('')
    try {
      const result = await api.resolveShotVideoUnknownSubmission(
        shotVideoManualResolutionJob.id,
        {
          projectId: productionContext.projectId,
          resolution: 'confirmed-not-created',
          confirmedProviderConsoleChecked: true,
          note,
        },
      )
      await jobsState.refresh()
      setShotVideoManualResolutionJobId(null)
      setToast(result.idempotent
        ? '该未知提交已完成过人工结案，可重新预检'
        : '人工核对审计已保存，该镜头已解除隔离')
    } catch (error) {
      setShotVideoManualResolutionError(error instanceof Error ? error.message : '人工解锁失败')
    } finally {
      setShotVideoManualResolutionPending(false)
    }
  }

  const refreshSelectedShotMediaReviews = useCallback(async (
    options: { signal?: AbortSignal } = {},
  ): Promise<Partial<Record<ShotMediaType, ShotMediaReviewSnapshot>> | null> => {
    const context = productionContextRef.current
    const shot = shotsRef.current.find((item) => item.id === activeShotRef.current) ?? null
    const runId = ++shotMediaReviewLoadRunRef.current
    if (!context || !shot?.storyId || !shot.sceneId || !context.episode.sourceRevisionId) {
      setShotMediaReviews({})
      setHistoricalShotVideos(null)
      setShotMediaReviewError('')
      setShotMediaReviewLoading(false)
      return null
    }
    const scope = {
      projectId: context.projectId,
      episodeId: context.episode.id,
      shotId: shot.storyId,
      sceneId: shot.sceneId,
      sourceRevisionId: context.episode.sourceRevisionId,
      localShotId: shot.id,
    }
    setShotMediaReviewLoading(true)
    setShotMediaReviewError('')
    try {
      const [episodeResult, storyboard, video, videoHistory] = await Promise.all([
        api.getEpisode(scope.episodeId, {
          projectId: scope.projectId,
          signal: options.signal,
        }),
        api.getShotMediaReview(scope.shotId, {
          projectId: scope.projectId,
          episodeId: scope.episodeId,
          sceneId: scope.sceneId,
          mediaType: 'storyboard',
          limit: 200,
          offset: 0,
        }, options),
        api.getShotMediaReview(scope.shotId, {
          projectId: scope.projectId,
          episodeId: scope.episodeId,
          sceneId: scope.sceneId,
          mediaType: 'video',
          limit: 200,
          offset: 0,
        }, options),
        api.listHistoricalShotVideoCandidates(
          scope.projectId,
          scope.episodeId,
          scope.shotId,
          scope.sceneId,
          options,
        ),
      ])
      if (episodeResult.etag !== storyboard.episodeEtag
        || episodeResult.etag !== video.episodeEtag
        || episodeResult.etag !== videoHistory.etag
        || episodeResult.episode.projectId !== scope.projectId
        || episodeResult.episode.id !== scope.episodeId
        || episodeResult.episode.sourceRevisionId !== scope.sourceRevisionId
        || storyboard.sourceRevisionId !== scope.sourceRevisionId
        || video.sourceRevisionId !== scope.sourceRevisionId
        || videoHistory.sourceRevisionId !== scope.sourceRevisionId) {
        throw new Error('审片数据在读取期间已变化，请刷新后重试')
      }
      const current = productionContextRef.current
      const currentShot = shotsRef.current.find((item) => item.id === activeShotRef.current) ?? null
      if (runId !== shotMediaReviewLoadRunRef.current
        || !current
        || current.projectId !== scope.projectId
        || current.episode.id !== scope.episodeId
        || currentShot?.id !== scope.localShotId
        || currentShot.storyId !== scope.shotId
        || currentShot.sceneId !== scope.sceneId) return null

      const nextContext: ProductionContext = {
        projectId: scope.projectId,
        episode: episodeResult.episode,
        episodeEtag: episodeResult.etag,
      }
      productionContextRef.current = nextContext
      setProductionContext(nextContext)
      const nextReviews = { storyboard, video }
      setShotMediaReviews(nextReviews)
      setHistoricalShotVideos(videoHistory)

      const selectedStoryboard = storyboard.currentSelection
      setShots((items) => {
        const next = items.map((item): Shot => item.id === scope.localShotId ? {
          ...item,
          ...(selectedStoryboard ? {
            imageUrl: selectedStoryboard.url,
            assetId: selectedStoryboard.id,
            imageClass: 'frame-wide',
            isDemo: false,
          } : {}),
        } : item)
        shotsRef.current = next
        return next
      })
      return nextReviews
    } catch (error) {
      if (runId === shotMediaReviewLoadRunRef.current
        && !(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
        setShotMediaReviewError(error instanceof Error ? error.message : '无法读取镜头审片数据')
      }
      throw error
    } finally {
      if (runId === shotMediaReviewLoadRunRef.current) setShotMediaReviewLoading(false)
    }
  }, [])

  const reconcileReviewedShotMedia = async (
    handle: TimelinePersistenceHandle | null,
    clearedVideoAssetId: string | null,
  ): Promise<void> => {
    setShotMediaTimelineState('reconciling')
    setShotMediaTimelineMessage(clearedVideoAssetId
      ? '分镜已换版，旧逐镜视频已解除当前选中（历史 Asset 保留）；正在重新对账 OpenCut。'
      : '权威选版已变更，正在重新对账 OpenCut 时间线。')
    if (!handle) {
      setShotMediaTimelineState('error')
      setShotMediaTimelineMessage('权威选版已更新，但 OpenCut 尚未就绪；预览和导出已阻断，请刷新审片后重试对账。')
      return
    }
    try {
      await handle.reconcileCurrentMedia()
      setShotMediaTimelineState('ready')
      setShotMediaTimelineMessage(clearedVideoAssetId
        ? '旧逐镜视频已解除当前选中，历史 Asset 仍保留；OpenCut 已换用当前权威素材。'
        : 'OpenCut 已换用当前权威素材，可安全预览或导出。')
    } catch (error) {
      setShotMediaTimelineState('error')
      setShotMediaTimelineMessage(`选版已保存，但 OpenCut 对账失败：${error instanceof Error ? error.message : '未知错误'}。预览和导出已阻断。`)
    }
  }

  const refreshSelectedShotMediaReviewAndTimeline = async () => {
    try {
      const reviews = await refreshSelectedShotMediaReviews()
      if (shotMediaTimelineState !== 'required' && shotMediaTimelineState !== 'error') return
      const context = productionContextRef.current
      const handle = timelinePersistenceRef.current
      const currentHandle = context && handle
        && handle.projectId === context.projectId
        && handle.episodeId === context.episode.id
        ? handle
        : null
      const latestClearedVideo = reviews?.storyboard?.history.find(
        (record) => record.timelineReconcileRequired && record.clearedVideoAssetId,
      )?.clearedVideoAssetId ?? null
      await reconcileReviewedShotMedia(currentHandle, latestClearedVideo)
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
        setShotMediaReviewError(error instanceof Error ? error.message : '刷新审片失败')
      }
    }
  }

  const restoreSelectedHistoricalShotVideo = async (
    candidate: HistoricalShotVideoCandidate,
  ): Promise<void> => {
    const context = productionContextRef.current
    const shot = shotsRef.current.find((item) => item.id === activeShotRef.current) ?? null
    const history = historicalShotVideos
    if (!context || !shot?.storyId || !shot.sceneId || !history
      || history.projectId !== context.projectId
      || history.episodeId !== context.episode.id
      || history.shotId !== shot.storyId
      || history.sceneId !== shot.sceneId
      || candidate.currentSourceRevisionId !== context.episode.sourceRevisionId) {
      throw new Error('历史视频候选已过期，请刷新后重试')
    }
    if (shotMediaReviewActionPendingRef.current || shotMediaReviewActionKey !== null) {
      throw new Error('另一条审片决策正在写入')
    }
    const identity = JSON.stringify({
      projectId: context.projectId,
      episodeId: context.episode.id,
      shotId: shot.storyId,
      sceneId: shot.sceneId,
      sourceAssetId: candidate.asset.id,
      currentSourceRevisionId: candidate.currentSourceRevisionId,
      semanticFingerprint: candidate.semanticFingerprint,
    })
    let idempotencyKey = historicalShotVideoRestoreKeysRef.current.get(identity)
    if (!idempotencyKey) {
      idempotencyKey = `shot-video-history-${crypto.randomUUID()}`
      historicalShotVideoRestoreKeysRef.current.set(identity, idempotencyKey)
    }
    shotMediaReviewActionPendingRef.current = true
    setShotMediaReviewActionKey(`video-history:restore:${candidate.asset.id}`)
    setShotMediaReviewError('')
    try {
      const result = await api.restoreHistoricalShotVideo(candidate.asset.id, {
        projectId: context.projectId,
        episodeId: context.episode.id,
        shotId: shot.storyId,
        sceneId: shot.sceneId,
      }, history.etag, { idempotencyKey })
      historicalShotVideoRestoreKeysRef.current.delete(identity)
      setShotMediaTimelineState('required')
      setShotMediaTimelineMessage('历史逐镜视频已复制为当前修订的新不可变 Asset；正在重新对账 OpenCut。')
      const handle = timelinePersistenceRef.current
      const currentHandle = handle
        && handle.projectId === context.projectId
        && handle.episodeId === context.episode.id
        ? handle
        : null
      await reconcileReviewedShotMedia(currentHandle, null)
      await Promise.allSettled([
        refreshSelectedShotMediaReviews(),
        jobsState.refresh(),
      ])
      setToast(`已恢复旧修订逐镜视频 v${result.sourceAsset.version}；未调用 Provider`)
    } catch (error) {
      await refreshSelectedShotMediaReviews().catch(() => undefined)
      setShotMediaReviewError(shotMediaReviewSubmissionOutcomeIsUnknown(error)
        ? '恢复提交结果未能确认；系统保留相同 Idempotency-Key，不会自动创建第二份。请点击刷新后再明确重试。'
        : error instanceof Error ? error.message : '历史视频恢复失败')
      throw error
    } finally {
      shotMediaReviewActionPendingRef.current = false
      setShotMediaReviewActionKey(null)
    }
  }

  const decideSelectedShotMedia = async (
    mediaType: ShotMediaType,
    decision: ShotMediaReviewDecision,
    candidate: ShotMediaCandidate,
    note: string,
  ): Promise<void> => {
    const context = productionContextRef.current
    const shot = shotsRef.current.find((item) => item.id === activeShotRef.current) ?? null
    const snapshot = shotMediaReviews[mediaType]
    const authoritativeCandidate = snapshot
      ? [snapshot.currentSelection, ...snapshot.candidates].find((item) => item?.id === candidate.id) ?? null
      : null
    if (!context || !shot?.storyId || !shot.sceneId || !snapshot
      || snapshot.projectId !== context.projectId
      || snapshot.episodeId !== context.episode.id
      || snapshot.shotId !== shot.storyId
      || snapshot.sceneId !== shot.sceneId
      || snapshot.sourceRevisionId !== context.episode.sourceRevisionId
      || !authoritativeCandidate
      || authoritativeCandidate.version !== candidate.version
      || authoritativeCandidate.checksum !== candidate.checksum
      || authoritativeCandidate.sourceRevisionId !== candidate.sourceRevisionId
      || authoritativeCandidate.url !== candidate.url) {
      throw new Error('候选素材已过期，请刷新审片后重试')
    }
    if (shotMediaReviewActionPendingRef.current || shotMediaReviewActionKey !== null) {
      throw new Error('另一条审片决策正在写入')
    }

    const normalizedNote = note.trim()
    const publicShotId = shot.storyId
    const identity = JSON.stringify({
      version: 1,
      projectId: context.projectId,
      episodeId: context.episode.id,
      shotId: shot.storyId,
      sceneId: shot.sceneId,
      sourceRevisionId: snapshot.sourceRevisionId,
      mediaType,
      decision,
      assetId: candidate.id,
      note: normalizedNote,
    })
    let frozen = frozenShotMediaReviewAttemptsRef.current.get(identity)
    if (!frozen && !availableShotMediaReviewDecisions(
      authoritativeCandidate,
      snapshot.history,
    ).includes(decision)) {
      throw new Error('该候选的当前审片状态不允许此决策，请刷新后重试')
    }
    if (!frozen) {
      if (snapshot.episodeEtag !== context.episodeEtag) {
        await refreshSelectedShotMediaReviews()
        throw new Error('分集审片版本已更新，请核对刷新后的候选再提交')
      }
      const signature = shotMediaReviewAttemptSignature({
        projectId: context.projectId,
        episodeId: context.episode.id,
        shotId: shot.storyId,
        sceneId: shot.sceneId,
        sourceRevisionId: snapshot.sourceRevisionId,
        mediaType,
        decision,
        assetId: candidate.id,
        note: normalizedNote,
        episodeEtag: context.episodeEtag,
      })
      frozen = {
        identity,
        signature,
        idempotencyKey: acquireShotMediaReviewIdempotencyKey(
          shotMediaReviewIdempotencyRef.current,
          signature,
        ),
        episodeEtag: context.episodeEtag,
      }
      frozenShotMediaReviewAttemptsRef.current.set(identity, frozen)
    }

    const handle = timelinePersistenceRef.current
    const currentHandle = handle
      && handle.projectId === context.projectId
      && handle.episodeId === context.episode.id
      ? handle
      : null
    if (!currentHandle && decision !== 'reject') {
      throw new Error('OpenCut 时间线仍在载入，为保护本地剪辑命令，请稍后再选版')
    }

    const actionKey = `${mediaType}:${decision}:${candidate.id}`
    shotMediaReviewActionPendingRef.current = true
    setShotMediaReviewActionKey(actionKey)
    setShotMediaReviewError('')
    try {
      // Persist local OpenCut commands before the authoritative Shot pointer can
      // change. Never flush the old tracks after a possibly-committed POST.
      if (currentHandle && decision !== 'reject') await currentHandle.flush()
      const decisionInput = {
        projectId: context.projectId,
        episodeId: context.episode.id,
        sceneId: shot.sceneId,
        mediaType,
        decision,
        assetId: candidate.id,
        ...(normalizedNote ? { note: normalizedNote } : {}),
      }
      const submitExactDecision = () => api.decideShotMediaReview(
        publicShotId,
        decisionInput,
        frozen.episodeEtag,
        frozen.idempotencyKey,
      )
      let result: ShotMediaDecisionResult
      try {
        result = await submitExactDecision()
      } catch (error) {
        if (error instanceof ApiError && error.status === 412) {
          acknowledgeShotMediaReviewAttempt(
            shotMediaReviewIdempotencyRef.current,
            frozen.signature,
            frozen.idempotencyKey,
          )
          frozenShotMediaReviewAttemptsRef.current.delete(identity)
          await refreshSelectedShotMediaReviews().catch(() => undefined)
          const message = '分集选版已并发更新；本次未按旧 ETag 写入，请核对新候选后重试'
          setShotMediaReviewError(message)
          throw error
        }
        if (!shotMediaReviewSubmissionOutcomeIsUnknown(error)) {
          acknowledgeShotMediaReviewAttempt(
            shotMediaReviewIdempotencyRef.current,
            frozen.signature,
            frozen.idempotencyKey,
          )
          frozenShotMediaReviewAttemptsRef.current.delete(identity)
          await refreshSelectedShotMediaReviews().catch(() => undefined)
          setShotMediaReviewError(error instanceof Error ? error.message : '审片决策未写入')
          throw error
        }
        try {
          // Exactly one automatic replay is allowed, and every byte of the
          // body plus If-Match/Idempotency-Key remains frozen above.
          result = await submitExactDecision()
        } catch (replayError) {
          await refreshSelectedShotMediaReviews().catch(() => undefined)
          setShotMediaReviewError('审片提交结果仍无法确认；已保留原 If-Match 与 Idempotency-Key。系统不会再自动重提，请保留当前确认区并显式重试。')
          throw replayError
        }
      }
      acknowledgeShotMediaReviewAttempt(
        shotMediaReviewIdempotencyRef.current,
        frozen.signature,
        frozen.idempotencyKey,
      )
      frozenShotMediaReviewAttemptsRef.current.delete(identity)

      if (result.timelineReconcileRequired || result.headAdvanced) {
        setShotMediaTimelineState('required')
        setShotMediaTimelineMessage('权威选版已变更，预览和导出需等待 OpenCut 重新对账。')
        await reconcileReviewedShotMedia(currentHandle, result.clearedVideoAssetId)
      }
      const refreshResults = await Promise.allSettled([
        refreshSelectedShotMediaReviews(),
        jobsState.refresh(),
      ])
      if (refreshResults.some((item) => item.status === 'rejected')) {
        setShotMediaReviewError('选版决策已确认写入，但界面刷新未完成；可点击审片卡刷新，不要重复提交。')
      }
      setToast(result.clearedVideoAssetId
        ? '已采用新分镜；旧逐镜视频已解除当前选中，但历史 Asset 仍保留'
        : `${decision === 'reject' ? '已记录拒绝' : decision === 'restore' ? '已恢复' : '已采用'} ${mediaType === 'video' ? '逐镜视频' : '分镜图'} v${candidate.version}`)
    } finally {
      shotMediaReviewActionPendingRef.current = false
      setShotMediaReviewActionKey(null)
    }
  }

  useEffect(() => {
    frozenShotMediaReviewAttemptsRef.current.clear()
    shotMediaReviewIdempotencyRef.current.clear()
    historicalShotVideoRestoreKeysRef.current.clear()
    shotMediaReviewActionPendingRef.current = false
    setShotMediaReviewActionKey(null)
    setHistoricalShotVideos(null)
    setShotMediaTimelineState('clean')
    setShotMediaTimelineMessage('')
  }, [
    productionContext?.projectId,
    productionContext?.episode.id,
    productionContext?.episode.sourceRevisionId,
  ])

  useEffect(() => {
    if (currentStage !== 'storyboard'
      || !productionContext?.episode.sourceRevisionId
      || !selectedShot?.storyId
      || !selectedShot.sceneId) {
      shotMediaReviewLoadRunRef.current += 1
      setShotMediaReviews({})
      setShotMediaReviewError('')
      setShotMediaReviewLoading(false)
      return
    }
    const controller = new AbortController()
    void refreshSelectedShotMediaReviews({ signal: controller.signal }).catch(() => undefined)
    return () => controller.abort()
  }, [
    currentStage,
    productionContext?.projectId,
    productionContext?.episode.id,
    productionContext?.episode.sourceRevisionId,
    selectedShot?.storyId,
    selectedShot?.sceneId,
    selectedShotMediaCandidateRevisionKey,
    refreshSelectedShotMediaReviews,
  ])

  useEffect(() => {
    const controller = new AbortController()
    const refreshHealth = async () => {
      try {
        setHealth(await api.getHealth({ signal: controller.signal }))
        setHealthError('')
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
          setHealth(null)
          setHealthError(error instanceof Error ? error.message : '图片服务未连接')
        }
      }
    }
    void refreshHealth()
    const timer = window.setInterval(refreshHealth, 15_000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (productionBootstrapStartedRef.current) return
    productionBootstrapStartedRef.current = true
    const controller = new AbortController()
    let retryTimer: number | undefined

    const bootstrapProductionContext = async () => {
      const bootstrapSwitchRun = productionSwitchRunRef.current
      try {
        const projects = await api.listProjects({ signal: controller.signal })
        let project = projects.find((candidate) => candidate.id === 'default') ?? projects[0]
        if (!project) {
          project = (await api.createProject({ title: '未命名漫剧' }, { signal: controller.signal })).project
        }

        const episodeResult = project.currentEpisodeId
          ? await api.getEpisode(project.currentEpisodeId, {
              projectId: project.id,
              signal: controller.signal,
            })
          : await api.createEpisode(project.id, {
              title: '第 1 集',
              sourceText: EMPTY_EPISODE_SOURCE,
              targetDurationSeconds: 45,
              aspectRatio: '16:9',
              stylePreset: '国风动画',
            }, { signal: controller.signal })
        if (bootstrapSwitchRun !== productionSwitchRunRef.current) return
        const loadedEpisode = episodeResult.episode
        const nextContext: ProductionContext = {
          projectId: project.id,
          episode: loadedEpisode,
          episodeEtag: episodeResult.etag,
        }
        const rememberedWorkspace = workspaceLocationForEpisode(
          projectSwitcherMemoryRef.current,
          project.id,
          loadedEpisode.id,
        )
        preferredStoryShotRef.current = rememberedWorkspace?.storyShotId ?? null
        updateProjectSwitcherMemory((current) => rememberProductionWorkspace(current, {
          projectId: project.id,
          episodeId: loadedEpisode.id,
          stage: rememberedWorkspace?.stage
            ?? (isProductionStageRoute(currentStage) ? currentStage : 'source'),
          storyShotId: rememberedWorkspace?.storyShotId,
          markRecent: true,
        }))
        productionContextRef.current = nextContext
        setProductionContext(nextContext)
        setSourceText(loadedEpisode.sourceText === EMPTY_EPISODE_SOURCE ? '' : loadedEpisode.sourceText)
        setSelectedStyle(loadedEpisode.stylePreset || '国风动画')
        setAspect(['16:9', '9:16', '1:1'].includes(loadedEpisode.aspectRatio)
          ? loadedEpisode.aspectRatio
          : '16:9')
        const persistedDuration = loadedEpisode.targetDurationSeconds
        setTargetDurationSeconds(
          typeof persistedDuration === 'number'
          && Number.isInteger(persistedDuration)
          && persistedDuration >= 30
          && persistedDuration <= 60
            ? persistedDuration
            : 45,
        )
        episodeInputDraftDirtyRef.current = false
        setSaveState('saved')
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
          setSaveState('error')
          setToast(error instanceof Error ? error.message : '无法初始化真实制作工程')
          retryTimer = window.setTimeout(() => void bootstrapProductionContext(), 3_000)
        }
      }
    }

    void bootstrapProductionContext()
    return () => {
      controller.abort()
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [])

  useEffect(() => {
    if (!productionContext) return
    const controller = new AbortController()
    setOfflineStoryFormDrafts(emptyOfflineStoryFormDrafts())
    // Do not bind recovery to the bootstrap Episode before the Story resource
    // has been read from the same stable Episode revision/ETag snapshot.
    adoptOfflineStoryDraftEditingScope(null)
    setOfflineStoryDraftResolvedKey(null)
    setOfflineStoryDraftRecovery(null)
    setOfflineStoryDraftRecoveryError('')
    dispatchStoryHistory({
      type: 'reset',
      headRevisionId: productionContext.episode.sourceRevisionId,
    })
    setStoryState('loading')
    const scope = {
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
    }
    void loadConsistentEpisodeRenderSettingsAuthority({
      scope,
      loadEpisode: ({ projectId, episodeId }) => api.getEpisode(episodeId, {
        projectId,
        signal: controller.signal,
      }),
      loadStory: async ({ projectId, episodeId }) => {
        try {
          return await api.getStory(episodeId, { projectId, signal: controller.signal })
        } catch (error) {
          if (error instanceof ApiError && error.code === 'STORY_NOT_FOUND') return null
          throw error
        }
      },
    }).then((authority) => {
      if (controller.signal.aborted) return
      const current = productionContextRef.current
      if (!current
        || current.projectId !== scope.projectId
        || current.episode.id !== scope.episodeId) return
      const nextContext: ProductionContext = {
        projectId: scope.projectId,
        episode: authority.episode,
        episodeEtag: authority.etag,
      }
      productionContextRef.current = nextContext
      setProductionContext(nextContext)
      if (!authority.story || !authority.episode.sourceRevisionId) {
        setStoryDocument(null)
        dispatchStoryHistory({ type: 'reset', headRevisionId: null })
        setStoryState('idle')
        setStoryError('')
        return
      }
      setStoryDocument(authority.story)
      adoptOfflineStoryDraftEditingScope({
        projectId: scope.projectId,
        episodeId: scope.episodeId,
        baseSourceRevisionId: authority.episode.sourceRevisionId,
      })
      dispatchStoryHistory({ type: 'reset', headRevisionId: authority.episode.sourceRevisionId })
      setStoryState('ready')
      setStoryError('')
    }).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
        setStoryState('error')
        setStoryError(error instanceof Error ? error.message : '无法读取结构剧本')
      }
    })
    return () => controller.abort()
  }, [dispatchStoryHistory, productionContext?.episode.id, productionContext?.projectId])

  useEffect(() => {
    const revisionId = productionContext?.episode.sourceRevisionId ?? null
    if (!revisionId || !storyDocument) return
    if (offlineStoryDraftBaseRevisionIdRef.current === revisionId) return
    // An authoritative revision advance never rebases local fields. Any old
    // envelope remains bound to its original revision and will be surfaced by
    // the recovery detector as copy/discard only.
    setOfflineStoryFormDrafts(emptyOfflineStoryFormDrafts())
    adoptOfflineStoryDraftEditingScope({
      projectId: productionContext!.projectId,
      episodeId: productionContext!.episode.id,
      baseSourceRevisionId: revisionId,
    })
  }, [productionContext?.episode.sourceRevisionId, storyDocument])

  useEffect(() => {
    if (!offlineStoryDraftScope || !offlineStoryDraftCurrentKey || !storyDocument) return
    const runId = offlineStoryDraftDetectionRunRef.current + 1
    offlineStoryDraftDetectionRunRef.current = runId
    setOfflineStoryDraftResolvedKey(null)
    setOfflineStoryDraftRecovery(null)
    setOfflineStoryDraftRecoveryError('')

    const storage = browserOfflineStoryDraftStorage()
    if (!storage) {
      setOfflineStoryDraftPersistenceError('浏览器拒绝访问本地草稿存储，断网保护暂不可用')
      return
    }
    const result = loadOfflineStoryDraftForEpisode(storage, offlineStoryDraftScope)
    if (offlineStoryDraftDetectionRunRef.current !== runId) return
    if (result.status === 'loaded') {
      setOfflineStoryDraftRecovery(result.draft)
      return
    }
    if (result.status === 'missing') {
      setOfflineStoryDraftPersistenceError('')
      setOfflineStoryDraftResolvedKey(offlineStoryDraftCurrentKey)
      return
    }
    setOfflineStoryDraftPersistenceError(result.status === 'unavailable'
      ? '浏览器拒绝读取本地剧本草稿，断网保护暂不可用'
      : '检测到损坏或不兼容的本地剧本草稿；系统未读取、未覆盖服务器剧本')
  }, [
    offlineStoryDraftCurrentKey,
    offlineStoryDraftScope,
    Boolean(storyDocument),
  ])

  useEffect(() => {
    if (!offlineStoryDraftScope
      || !offlineStoryDraftCurrentKey
      || offlineStoryDraftResolvedKey !== offlineStoryDraftCurrentKey
      || offlineStoryDraftBaseRevisionId !== offlineStoryDraftScope.baseSourceRevisionId
      || offlineStoryDraftRecovery) return
    const timer = window.setTimeout(() => {
      const storage = browserOfflineStoryDraftStorage()
      if (!storage) {
        setOfflineStoryDraftPersistenceError('浏览器拒绝访问本地草稿存储，断网保护暂不可用')
        return
      }
      const result = offlineStoryDraftHasChanges(offlineStoryDraftChanges)
        ? saveOfflineStoryDraft(storage, offlineStoryDraftScope, offlineStoryDraftChanges)
        : clearOfflineStoryDraft(storage, offlineStoryDraftScope)
      setOfflineStoryDraftPersistenceError(offlineStoryDraftPersistenceMessage(result))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [
    offlineStoryDraftChanges,
    offlineStoryDraftCurrentKey,
    offlineStoryDraftRecovery,
    offlineStoryDraftResolvedKey,
    offlineStoryDraftScope,
    offlineStoryDraftBaseRevisionId,
  ])

  useEffect(() => {
    const flushSessionSnapshot = () => {
      const snapshot = offlineStoryDraftSessionSnapshotRef.current
      const storage = browserOfflineStoryDraftStorage()
      if (!snapshot || !storage) return
      if (offlineStoryDraftHasChanges(snapshot.changes)) {
        saveOfflineStoryDraft(storage, snapshot.scope, snapshot.changes)
      } else {
        clearOfflineStoryDraft(storage, snapshot.scope)
      }
    }
    window.addEventListener('pagehide', flushSessionSnapshot)
    return () => {
      window.removeEventListener('pagehide', flushSessionSnapshot)
      flushSessionSnapshot()
    }
  }, [productionContext?.episode.id, productionContext?.projectId])

  useEffect(() => {
    if (!productionContext) {
      setProjectNarratorVoice(null)
      setProjectNarratorVoiceState('idle')
      setProjectNarratorVoiceError('')
      return
    }
    const controller = new AbortController()
    setProjectNarratorVoiceState('loading')
    setProjectNarratorVoiceError('')
    void api.getProjectNarratorVoiceProfile(productionContext.projectId, {
      signal: controller.signal,
    }).then((result) => {
      setProjectNarratorVoice(result)
      setProjectNarratorVoiceState('ready')
    }).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
        setProjectNarratorVoice(null)
        setProjectNarratorVoiceState('error')
        setProjectNarratorVoiceError(error instanceof Error ? error.message : '无法读取项目旁白声线')
      }
    })
    return () => controller.abort()
  // The project settings ETag also includes the current Story revision. A
  // freshly generated/restored Story therefore invalidates an earlier
  // narrator-profile read even though the project ID is unchanged. Refresh
  // on that authoritative revision boundary so a single-tab stage-2 save does
  // not surface a false "other page updated" conflict.
  }, [
    productionContext?.episode.sourceRevisionId,
    productionContext?.projectId,
    projectNarratorVoiceReloadIndex,
  ])

  useEffect(() => {
    if (!productionContext || !storyDocument || !productionContext.episode.sourceRevisionId) {
      setVisualAssetTargets([])
      setVisualAssetLibrary([])
      setVisualAssetState('idle')
      setVisualAssetError('')
      return
    }
    const controller = new AbortController()
    if (visualAssetTargets.length === 0) setVisualAssetState('loading')
    void Promise.all([
      api.listVisualAssetTargets(
        productionContext.projectId,
        productionContext.episode.id,
        { signal: controller.signal },
      ),
      api.listAssets(productionContext.projectId, {
        episodeId: productionContext.episode.id,
        includeProjectAssets: true,
        signal: controller.signal,
      }),
    ]).then(([targetResult, assets]) => {
      if (targetResult.sourceRevisionId !== productionContext.episode.sourceRevisionId) {
        throw new Error('视觉资产目标与当前剧本修订不一致')
      }
      setVisualAssetTargets(targetResult.targets)
      setVisualAssetLibrary(assets)
      setVisualAssetState('ready')
      setVisualAssetError('')
    }).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
        setVisualAssetState('error')
        setVisualAssetError(error instanceof Error ? error.message : '无法读取视觉资产工作台')
      }
    })
    return () => controller.abort()
  }, [
    productionContext?.episode.id,
    productionContext?.episode.sourceRevisionId,
    productionContext?.projectId,
    storyDocument,
    visualAssetSuccessKey,
  ])

  useEffect(() => {
    const primaryId = storyDocument?.characters[0]?.id
    const primaryTarget = visualAssetTargets.find((target) => (
      target.type === 'character' && target.id === primaryId
    ))
    if (!primaryTarget) {
      setAliAsset({ status: 'idle' })
      return
    }
    const primaryJobs = visualAssetJobs.filter((job) => {
      const binding = visualAssetJobBinding(job)
      return binding?.entityType === 'character' && binding.entityId === primaryTarget.id
    })
    const lockedAsset = primaryTarget.lockedAssetId
      ? visualAssetLibrary.find((asset) => asset.id === primaryTarget.lockedAssetId)
      : null
    const latestReadyJob = primaryJobs.find((job) => job.status === 'succeeded' && generatedImagesFromJob(job).length)
    const latestImage = latestReadyJob ? generatedImagesFromJob(latestReadyJob)[0] : null
    if (lockedAsset
      && lockedAsset.status === 'ready'
      && lockedAsset.sourceRevisionId === productionContext?.episode.sourceRevisionId) {
      setAliAsset({
        status: 'ready',
        assetId: lockedAsset.id,
        imageUrl: lockedAsset.url,
        jobId: lockedAsset.generationJobId ?? undefined,
        locked: true,
      })
    } else if (latestImage) {
      setAliAsset({
        status: 'ready',
        assetId: latestImage.id,
        imageUrl: latestImage.url,
        jobId: latestReadyJob?.id,
        locked: primaryTarget.lockedAssetId === latestImage.id,
      })
    } else {
      const active = primaryJobs.find((job) => ['queued', 'running', 'waiting_provider'].includes(job.status))
      const failed = primaryJobs.find((job) => job.status === 'failed')
      setAliAsset(active
        ? { status: 'generating', jobId: active.id }
        : failed
          ? { status: 'failed', jobId: failed.id, error: failed.error?.message ?? '角色资产生成失败' }
          : { status: 'idle' })
    }
  }, [
    productionContext?.episode.sourceRevisionId,
    storyDocument,
    visualAssetJobs,
    visualAssetLibrary,
    visualAssetTargets,
  ])

  useEffect(() => {
    if (!productionContext) return
    const job = storyGenerationJobId
      ? episodeJobs.find((candidate) => candidate.id === storyGenerationJobId)
      : episodeJobs.find((candidate) => (
          candidate.type === 'story.generate'
          && candidate.episodeId === productionContext.episode.id
          && ['queued', 'running', 'waiting_provider'].includes(candidate.status)
        ))
    if (!job) return
    if (storyGenerationJobId !== job.id) setStoryGenerationJobId(job.id)
    if (['queued', 'running', 'waiting_provider'].includes(job.status)) {
      setStoryState('generating')
      return
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      setStoryState('error')
      setStoryError(job.error?.message ?? (job.status === 'cancelled' ? '剧本生成已取消' : '剧本生成失败'))
      return
    }
    if (job.status !== 'succeeded' || handledStoryJobRef.current === job.id) return
    handledStoryJobRef.current = job.id
    const controller = new AbortController()
    let adopted = false
    void Promise.all([
      api.getStory(productionContext.episode.id, {
        projectId: productionContext.projectId,
        signal: controller.signal,
      }),
      api.getEpisode(productionContext.episode.id, {
        projectId: productionContext.projectId,
        signal: controller.signal,
      }),
    ]).then(([storyResult, episodeResult]) => {
      if (controller.signal.aborted) return
      if (
        storyResult.revisionId !== episodeResult.episode.sourceRevisionId
        || storyResult.etag !== episodeResult.etag
      ) {
        throw new Error('剧本生成结果正在更新，请稍后重试')
      }
      const nextContext: ProductionContext = {
        projectId: productionContext.projectId,
        episode: episodeResult.episode,
        episodeEtag: episodeResult.etag,
      }
      setStoryDocument(storyResult.story)
      productionContextRef.current = nextContext
      setProductionContext(nextContext)
      dispatchStoryHistory({ type: 'reset', headRevisionId: storyResult.revisionId })
      setStoryState('ready')
      setStoryError('')
      setCurrentStage('assets')
      setActiveRail('production')
      setToast(`已生成可编辑制作底稿：${storyResult.story.scenes.length} 场；请在本集「角色与场景准备」中确认引用版本。`)
      adopted = true
    }).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
        handledStoryJobRef.current = null
        setStoryState('error')
        setStoryError(error instanceof Error ? error.message : '无法读取生成后的剧本')
      }
    })
    return () => {
      controller.abort()
      // Job-list snapshots, SSE updates, and Episode ETag refreshes can rerun
      // this effect while the two authoritative reads are in flight. An
      // aborted adoption is not a handled terminal job; allow the next effect
      // instance to retry instead of leaving the UI at "100% running".
      if (!adopted && handledStoryJobRef.current === job.id) {
        handledStoryJobRef.current = null
      }
    }
  }, [dispatchStoryHistory, episodeJobs, productionContext, storyGenerationJobId])

  useEffect(() => {
    if (!storyDocument) return
    const generatedShots = storyDocument.scenes.flatMap((scene) => (
      scene.shots.map((shot) => ({ sceneId: scene.id, shot }))
    ))
    const current = shotsRef.current
    const preserveSameBaseShotDrafts = offlineStoryDraftBaseRevisionIdRef.current !== null
      && offlineStoryDraftBaseRevisionIdRef.current
        === productionContextRef.current?.episode.sourceRevisionId
    const previouslySelectedStoryId = preferredStoryShotRef.current ?? current.find(
      (shot) => shot.id === activeShotRef.current,
    )?.storyId
    preferredStoryShotRef.current = null
    const nextShots = generatedShots.map(({ sceneId, shot: storyShot }, index): Shot => {
      const persisted = current.find((shot) => (
        shot.storyId === storyShot.id || (!shot.storyId && shot.code === storyShot.code)
      ))
      const dialogue = storyShot.dialogueLines
        .map((line) => `${line.kind === 'narration' ? '旁白' : line.speaker}：${line.text}`)
        .join('\n')
      return {
        id: index + 1,
        storyId: storyShot.id,
        sceneId,
        code: preserveSameBaseShotDrafts ? persisted?.code ?? storyShot.code : storyShot.code,
        title: preserveSameBaseShotDrafts ? persisted?.title ?? storyShot.title : storyShot.title,
        framing: preserveSameBaseShotDrafts ? persisted?.framing ?? storyShot.framing : storyShot.framing,
        movement: preserveSameBaseShotDrafts ? persisted?.movement ?? storyShot.movement : storyShot.movement,
        transition: preserveSameBaseShotDrafts ? persisted?.transition ?? storyShot.transition : storyShot.transition,
        duration: preserveSameBaseShotDrafts ? persisted?.duration ?? `${storyShot.durationSeconds.toFixed(1)}s` : `${storyShot.durationSeconds.toFixed(1)}s`,
        copy: preserveSameBaseShotDrafts ? persisted?.copy ?? storyShot.description : storyShot.description,
        visualPrompt: preserveSameBaseShotDrafts ? persisted?.visualPrompt ?? storyShot.visualPrompt : storyShot.visualPrompt,
        ...(dialogue ? { dialogue } : {}),
        status: persisted?.imageUrl ? persisted.status : '待生成',
        imageClass: persisted?.imageUrl ? persisted.imageClass : 'frame-empty',
        ...(persisted?.imageUrl ? { imageUrl: persisted.imageUrl } : {}),
        ...(persisted?.assetId ? { assetId: persisted.assetId } : {}),
        ...(persisted?.jobId ? { jobId: persisted.jobId } : {}),
        ...(persisted?.generationError ? { generationError: persisted.generationError } : {}),
        isDemo: false,
      }
    })
    setShots(nextShots)
    const nextSelected = nextShots.find((shot) => shot.storyId === previouslySelectedStoryId)
    setActiveShot(nextSelected?.id ?? nextShots[0]?.id ?? 1)
  }, [storyDocument])

  const startStoryGeneration = async () => {
    if (!productionContext
      || storyState === 'generating'
      || storyGenerationPreparingRef.current) return
    if (hasStoryDraft) {
      setToast('请先保存或取消当前剧本编辑，再发起新一轮剧本生成')
      return
    }
    if (!sourceText.trim()) {
      setStoryState('error')
      setStoryError('请先输入故事原文')
      return
    }
    const draft = Object.freeze({
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
      sourceText,
      targetDurationSeconds,
      aspect: aspect as '16:9' | '9:16' | '1:1',
      selectedStyle,
      providerId: executableTextProvider?.id ?? null,
    })
    const generationSignature = JSON.stringify(draft)
    storyGenerationPreparingRef.current = true
    setStoryGenerationPreparing(true)
    setStoryError('')
    setSaveState('saving')
    let savedInputs = false
    try {
      let attempt = cachedStoryGenerationAttemptRef.current
      if (attempt?.signature !== generationSignature
        || attempt.episodeId !== draft.episodeId
        || attempt.projectId !== draft.projectId
        || attempt.etag !== productionContext.episodeEtag) {
        const episodeResult = await api.updateEpisode(
          draft.episodeId,
          {
            projectId: draft.projectId,
            title: productionContext.episode.title || '第 1 集',
            sourceText: draft.sourceText,
            targetDurationSeconds: draft.targetDurationSeconds,
            aspectRatio: draft.aspect,
            stylePreset: draft.selectedStyle,
            summary: '提交剧本生成前同步输入',
          },
          productionContext.episodeEtag,
        )
        const nextContext: ProductionContext = {
          projectId: draft.projectId,
          episode: episodeResult.episode,
          episodeEtag: episodeResult.etag,
        }
        productionContextRef.current = nextContext
        setProductionContext(nextContext)
        episodeInputDraftDirtyRef.current = false
        const generationKey = acquireStoryGenerationIdempotencyKey(
          storyIdempotencyRef.current,
          generationSignature,
          () => crypto.randomUUID(),
        )
        attempt = freezeStoryGenerationAttempt({
          signature: generationSignature,
          episodeId: nextContext.episode.id,
          projectId: nextContext.projectId,
          etag: nextContext.episodeEtag,
          idempotencyKey: generationKey,
          body: {
            projectId: nextContext.projectId,
            ...(draft.providerId ? { providerId: draft.providerId } : {}),
          },
        })
        cachedStoryGenerationAttemptRef.current = attempt
      }
      savedInputs = true
      setSaveState('saved')
      const job = await api.generateStory(
        attempt.episodeId,
        attempt.body,
        attempt.etag,
        attempt.idempotencyKey,
      )
      acknowledgeStoryGenerationAttempt(storyIdempotencyRef.current, attempt)
      cachedStoryGenerationAttemptRef.current = null
      handledStoryJobRef.current = null
      setStoryGenerationJobId(job.id)
      setStoryState('generating')
      setStoryError('')
      try {
        await jobsState.refresh()
        setToast('结构剧本生成任务已提交')
      } catch {
        setToast('剧本任务已提交，任务状态将在连接恢复后同步')
      }
    } catch (error) {
      if (!savedInputs) setSaveState('error')
      setStoryState('error')
      setStoryError(error instanceof Error
        ? error.message
        : '剧本生成任务提交失败；再次点击会复用同一幂等请求')
    } finally {
      storyGenerationPreparingRef.current = false
      setStoryGenerationPreparing(false)
    }
  }

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setShowCommand(true)
      }
      if (event.key === 'Escape') {
        setShowCommand(false)
        setShowExport(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const changeStage = (stageId: string) => {
    const route = isProductionStageRoute(stageId) ? stageId : 'source'
    setCurrentStage(route)
    setActiveRail('production')
    const stage = productionStageForRoute(route)
    setToast(route === 'audio'
      ? '已进入「拆剧本与配音」的语音生成与确认'
      : `已切换到「${stage?.name ?? '未知阶段'}」`)
  }

  const selectCatalogProject = (projectId: string) => {
    catalogProjectIdRef.current = projectId
    catalogEpisodeIdRef.current = null
    setCatalogProjectId(projectId)
    setCatalogEpisodeId(null)
  }

  const selectCatalogEpisode = (projectId: string, episodeId: string) => {
    catalogProjectIdRef.current = projectId
    catalogEpisodeIdRef.current = episodeId
    setCatalogProjectId(projectId)
    setCatalogEpisodeId(episodeId)
  }

  const createCatalogProject = async (title: string) => {
    const created = await api.createProject({ title })
    await refreshCatalog({ preferredProjectId: created.project.id })
    setToast(`项目「${created.project.title}」已加入 Catalog`)
  }

  const createCatalogEpisode = async (projectId: string, title: string) => {
    const episodes = catalogEpisodesByProject[projectId] ?? []
    const created = await api.createEpisode(projectId, {
      title,
      sourceText: EMPTY_EPISODE_SOURCE,
      targetDurationSeconds: 45,
      aspectRatio: '16:9',
      stylePreset: '国风动画',
    })
    await refreshCatalog({ preferredProjectId: projectId, preferredEpisodeId: created.episode.id })
    setToast(`剧集「${title}」已加入 Catalog（当前项目已有 ${episodes.length + 1} 集）`)
  }

  const productionSwitchBlockedReason = hasStoryDraft
    ? '当前制作台有未保存的剧本草稿；请先保存或取消，再切换剧集。'
    : episodeInputDraftDirtyRef.current || saveState === 'dirty'
      ? '当前分集的原著或制作设定尚未保存；请等待保存完成后再切换。'
      : saveState === 'saving'
        ? '当前分集正在保存；完成后即可切换。'
        : saveState === 'conflict'
          ? '当前分集存在待处理的版本冲突；解决后才能安全切换。'
          : ''

  const openCatalogEpisodeInProduction = async (projectId: string, episodeId: string): Promise<boolean> => {
    const currentContext = productionContextRef.current
    if (currentContext?.projectId === projectId && currentContext.episode.id === episodeId) return true
    if (productionSwitchBlockedReason) {
      setToast(productionSwitchBlockedReason)
      return false
    }
    const run = ++productionSwitchRunRef.current
    const priorSaveState = saveState
    let targetLoadStarted = false
    setProductionSwitchingEpisodeId(episodeId)
    setSaveState('loading')
    try {
      if (currentContext) {
        const currentSelectedShot = shotsRef.current.find((shot) => shot.id === activeShotRef.current)
        if (isProductionStageRoute(currentStage)) {
          updateProjectSwitcherMemory((current) => rememberProductionWorkspace(current, {
            projectId: currentContext.projectId,
            episodeId: currentContext.episode.id,
            stage: currentStage,
            storyShotId: currentSelectedShot?.storyId,
          }))
        }
        const timelineHandle = timelinePersistenceRef.current
        if (timelineHandle
          && timelineHandle.projectId === currentContext.projectId
          && timelineHandle.episodeId === currentContext.episode.id) {
          await timelineHandle.flush()
        }
      }
      targetLoadStarted = true
      const episodeResult = await api.getEpisode(episodeId, { projectId })
      if (run !== productionSwitchRunRef.current) return false
      const rememberedWorkspace = workspaceLocationForEpisode(
        projectSwitcherMemoryRef.current,
        projectId,
        episodeId,
      )
      const nextContext: ProductionContext = {
        projectId,
        episode: episodeResult.episode,
        episodeEtag: episodeResult.etag,
      }
      preferredStoryShotRef.current = rememberedWorkspace?.storyShotId ?? null
      setStoryDocument(null)
      setShots([])
      setActiveShot(1)
      setPinnedTimeline(null)
      productionContextRef.current = nextContext
      setProductionContext(nextContext)
      setSourceText(episodeResult.episode.sourceText === EMPTY_EPISODE_SOURCE ? '' : episodeResult.episode.sourceText)
      setSelectedStyle(episodeResult.episode.stylePreset || '国风动画')
      setAspect(['16:9', '9:16', '1:1'].includes(episodeResult.episode.aspectRatio)
        ? episodeResult.episode.aspectRatio
        : '16:9')
      const duration = episodeResult.episode.targetDurationSeconds
      setTargetDurationSeconds(typeof duration === 'number' && duration >= 30 && duration <= 60 ? duration : 45)
      episodeInputDraftDirtyRef.current = false
      setSaveState('saved')
      setActiveRail('production')
      setCurrentStage(rememberedWorkspace?.stage ?? 'source')
      selectCatalogEpisode(projectId, episodeId)
      updateProjectSwitcherMemory((current) => rememberProductionWorkspace(current, {
        projectId,
        episodeId,
        stage: rememberedWorkspace?.stage ?? 'source',
        storyShotId: rememberedWorkspace?.storyShotId,
        markRecent: true,
      }))
      setToast(rememberedWorkspace
        ? `已恢复「${episodeResult.episode.title}」上次制作位置`
        : `已进入「${episodeResult.episode.title}」完整制作流程`)
      return true
    } catch (error) {
      if (run !== productionSwitchRunRef.current) return false
      setSaveState(targetLoadStarted ? 'error' : priorSaveState)
      setToast(error instanceof Error ? error.message : '无法打开该剧集的制作台')
      return false
    } finally {
      if (run === productionSwitchRunRef.current) setProductionSwitchingEpisodeId(null)
    }
  }

  const openStoryEntitySearchResult = (result: StoryEntitySearchResult) => {
    const current = productionContextRef.current
    if (!current || result.sourceRevisionId !== current.episode.sourceRevisionId) {
      setToast('搜索结果所属剧本修订已变化，请重新搜索')
      return
    }
    if (result.type === 'scene' || result.type === 'dialogue') {
      storyEntityFocusRunRef.current += 1
      setStoryEntityFocus({ ...result, focusRequestId: storyEntityFocusRunRef.current })
      changeStage('script')
      setToast(`已定位到${result.type === 'scene' ? '场景' : '台词'}「${result.title}」`)
      return
    }
    if (result.type === 'shot') {
      const shot = shotsRef.current.find((candidate) => (
        candidate.storyId === result.shotId
        && (result.sceneId === null || candidate.sceneId === result.sceneId)
      ))
      if (!shot) {
        setToast('镜头已不在当前剧本中，请重新搜索')
        return
      }
      storyEntityFocusRunRef.current += 1
      setStoryEntityFocus({ ...result, focusRequestId: storyEntityFocusRunRef.current })
      setActiveShot(shot.id)
      changeStage('storyboard')
      setToast(`已定位到镜头「${result.title}」`)
      return
    }
    setAssetEntityFocus({ type: result.type, id: result.entityId })
    changeStage('assets')
    setToast(`已定位到${result.type === 'character' ? '角色' : result.type === 'location' ? '场景资产' : '道具'}「${result.title}」`)
  }

  const markEpisodeDraft = () => {
    setSaveState((current) => current === 'loading' ? current : 'dirty')
  }

  const changeSourceText = (value: string) => {
    episodeInputDraftDirtyRef.current = true
    setSourceText(value)
    markEpisodeDraft()
  }

  const changeTargetDuration = (value: number) => {
    episodeInputDraftDirtyRef.current = true
    setTargetDurationSeconds(value)
    markEpisodeDraft()
  }

  const currentEpisodeRenderSettingsIntent = (): EpisodeRenderSettings => (
    normalizeEpisodeRenderSettings({
      stylePreset: selectedStyleRef.current,
      aspectRatio: aspectRef.current,
    })
  )

  const loadCurrentEpisodeRenderSettingsAuthority = (
    scope: EpisodeRenderSettingsScope,
  ): Promise<EpisodeRenderSettingsAuthorityBundle> => (
    loadConsistentEpisodeRenderSettingsAuthority({
      scope,
      loadEpisode: async ({ projectId, episodeId }) => (
        api.getEpisode(episodeId, { projectId })
      ),
      loadStory: async ({ projectId, episodeId }) => {
        try {
          return await api.getStory(episodeId, { projectId })
        } catch (error) {
          if (error instanceof ApiError && error.code === 'STORY_NOT_FOUND') return null
          throw error
        }
      },
    })
  )

  const applyEpisodeRenderSettingsAuthority = (
    scope: EpisodeRenderSettingsScope,
    authority: EpisodeRenderSettingsAuthority,
  ) => {
    const current = productionContextRef.current
    if (
      current
      && (current.projectId !== scope.projectId || current.episode.id !== scope.episodeId)
    ) {
      throw new Error('当前分集已切换，不能应用旧分集的冲突结果')
    }
    const nextContext: ProductionContext = {
      projectId: scope.projectId,
      episode: authority.episode,
      episodeEtag: authority.etag,
    }
    productionContextRef.current = nextContext
    setProductionContext(nextContext)
  }

  const applyEpisodeRenderSettingsAuthorityBundle = (
    scope: EpisodeRenderSettingsScope,
    authority: EpisodeRenderSettingsAuthorityBundle,
  ): boolean => {
    const preservedEpisodeInputDraft = episodeInputDraftDirtyRef.current
    applyEpisodeRenderSettingsAuthority(scope, authority)
    setStoryDocument(authority.story)
    setStoryState(authority.story ? 'ready' : 'idle')
    setStoryError('')
    if (!preservedEpisodeInputDraft) {
      setSourceText(authority.episode.sourceText === EMPTY_EPISODE_SOURCE
        ? ''
        : authority.episode.sourceText)
      const duration = authority.episode.targetDurationSeconds
      setTargetDurationSeconds(
        typeof duration === 'number'
        && Number.isInteger(duration)
        && duration >= 30
        && duration <= 60
          ? duration
          : 45,
      )
    }
    return preservedEpisodeInputDraft
  }

  const markRenderSettingsOutputsStale = () => {
    const invalidated = shotsRef.current.map((shot): Shot => shot.storyId ? {
      ...shot,
      status: '待生成',
      imageUrl: undefined,
      assetId: undefined,
      jobId: undefined,
      generationError: '画面风格或画幅已变更，该分镜需重新生成',
    } : shot)
    shotsRef.current = invalidated
    setShots(invalidated)
  }

  const refreshRenderSettingsDependents = async (): Promise<boolean> => {
    const results = await Promise.allSettled([
      jobsState.refresh(),
      refreshVisualAssetWorkbench(),
    ])
    return results.some((result) => result.status === 'rejected')
  }

  const openEpisodeRenderSettingsConflict = async (
    scope: EpisodeRenderSettingsScope,
    lastKnownAuthority: EpisodeRenderSettingsAuthority,
  ) => {
    const localIntent = currentEpisodeRenderSettingsIntent()
    const existing = episodeRenderSettingsConflictRef.current
    if (
      existing
      && existing.scope.projectId === scope.projectId
      && existing.scope.episodeId === scope.episodeId
    ) {
      publishEpisodeRenderSettingsConflict(withEpisodeRenderSettingsIntent(existing, localIntent))
      setSaveState('conflict')
      return
    }

    const conflict = createEpisodeRenderSettingsConflict({
      conflictId: ++episodeRenderSettingsConflictIdRef.current,
      scope,
      localIntent,
      lastKnownServer: episodeRenderSettingsFromEpisode(lastKnownAuthority.episode),
      lastKnownEtag: lastKnownAuthority.etag,
    })
    publishEpisodeRenderSettingsConflict(conflict)
    setSaveState('conflict')
    setToast('检测到其他标签页或客户端的更新，已暂停自动保存')

    try {
      const authority = await loadCurrentEpisodeRenderSettingsAuthority(scope)
      const active = episodeRenderSettingsConflictRef.current
      if (!active || active.conflictId !== conflict.conflictId) return
      applyEpisodeRenderSettingsAuthorityBundle(scope, authority)
      publishEpisodeRenderSettingsConflict(makeEpisodeRenderSettingsConflictReady(
        withEpisodeRenderSettingsAuthority(active, authority),
      ))
    } catch (error) {
      const active = episodeRenderSettingsConflictRef.current
      if (!active || active.conflictId !== conflict.conflictId) return
      const message = error instanceof Error ? error.message : '无法读取服务器当前画面设置'
      publishEpisodeRenderSettingsConflict(makeEpisodeRenderSettingsConflictReady(active, message))
    }
  }

  const persistEpisodeRenderSettings = (nextStyle: string, nextAspect: string) => {
    const queuedScope = productionContextRef.current
    if (!queuedScope) {
      markEpisodeDraft()
      return
    }
    const immediateConflict = episodeRenderSettingsConflictRef.current
    if (immediateConflict) {
      publishEpisodeRenderSettingsConflict(withEpisodeRenderSettingsIntent(
        immediateConflict,
        normalizeEpisodeRenderSettings({ stylePreset: nextStyle, aspectRatio: nextAspect }),
      ))
      setSaveState('conflict')
      return
    }
    episodeSettingsSaveChainRef.current = episodeSettingsSaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const current = productionContextRef.current
        if (!current
          || current.projectId !== queuedScope.projectId
          || current.episode.id !== queuedScope.episode.id) return
        const queuedConflict = episodeRenderSettingsConflictRef.current
        if (queuedConflict) {
          publishEpisodeRenderSettingsConflict(withEpisodeRenderSettingsIntent(
            queuedConflict,
            currentEpisodeRenderSettingsIntent(),
          ))
          setSaveState('conflict')
          return
        }
        setSaveState('saving')
        try {
          const result = await api.updateEpisode(current.episode.id, {
            projectId: current.projectId,
            stylePreset: nextStyle,
            aspectRatio: nextAspect as '16:9' | '9:16' | '1:1',
            summary: '更新画面风格与导出画幅',
          }, current.episodeEtag)
          applyEpisodeRenderSettingsAuthority({
            projectId: current.projectId,
            episodeId: current.episode.id,
          }, result)
          markRenderSettingsOutputsStale()
          const refreshIncomplete = await refreshRenderSettingsDependents()
          setSaveState('saved')
          setToast(refreshIncomplete
            ? '画面设置已保存；下游状态稍后自动同步'
            : '画面设置已保存，旧分镜与成片已标记过期')
        } catch (error) {
          if (error instanceof ApiError && error.status === 412) {
            await openEpisodeRenderSettingsConflict({
              projectId: current.projectId,
              episodeId: current.episode.id,
            }, {
              episode: current.episode,
              etag: current.episodeEtag,
            })
            return
          }
          setSaveState('error')
          setToast(error instanceof Error ? error.message : '画面风格或画幅保存失败')
        }
      })
      .catch((error: unknown) => {
        setSaveState('error')
        setToast(error instanceof Error ? error.message : '画面设置保存链异常')
      })
  }

  const resolveEpisodeRenderSettingsConflict = async (
    action: EpisodeRenderSettingsConflictAction,
  ) => {
    const conflict = episodeRenderSettingsConflictRef.current
    if (!conflict) return
    const started = beginEpisodeRenderSettingsResolution(conflict, action)
    if (!started.token) return
    const { token } = started
    const localIntent = started.state.localIntent
    publishEpisodeRenderSettingsConflict(started.state)
    setSaveState('conflict')

    try {
      let preservedEpisodeInputDraft = false
      if (action === 'adopt-server') {
        const authority = await loadCurrentEpisodeRenderSettingsAuthority(started.state.scope)
        if (!isEpisodeRenderSettingsResolutionCurrent(
          episodeRenderSettingsConflictRef.current,
          token,
        )) return
        const active = episodeRenderSettingsConflictRef.current!
        publishEpisodeRenderSettingsConflict(withEpisodeRenderSettingsAuthority(active, authority))
        preservedEpisodeInputDraft = applyEpisodeRenderSettingsAuthorityBundle(
          started.state.scope,
          authority,
        )
        const server = episodeRenderSettingsFromEpisode(authority.episode)
        selectedStyleRef.current = server.stylePreset
        aspectRef.current = server.aspectRatio
        setSelectedStyle(server.stylePreset)
        setAspect(server.aspectRatio)
      } else {
        const result = await reapplyEpisodeRenderSettingsAfterRefresh({
          scope: started.state.scope,
          localIntent,
          transport: {
            load: loadCurrentEpisodeRenderSettingsAuthority,
            save: async (scope, intent, authoritativeEtag) => api.updateEpisode(
              scope.episodeId,
              {
                projectId: scope.projectId,
                stylePreset: intent.stylePreset,
                aspectRatio: intent.aspectRatio,
                summary: '基于最新分集版本重新应用画面设置',
              },
              authoritativeEtag,
            ),
          },
        })
        if (!isEpisodeRenderSettingsResolutionCurrent(
          episodeRenderSettingsConflictRef.current,
          token,
        )) return
        if (result.saved.episode.sourceRevisionId !== result.refreshed.revisionId) {
          throw new Error('重新应用后的 Episode 与已读取 Story 修订不一致')
        }
        preservedEpisodeInputDraft = applyEpisodeRenderSettingsAuthorityBundle(
          started.state.scope,
          {
            ...result.saved,
            revisionId: result.refreshed.revisionId,
            story: result.refreshed.story,
          },
        )
        selectedStyleRef.current = localIntent.stylePreset
        aspectRef.current = localIntent.aspectRatio
        setSelectedStyle(localIntent.stylePreset)
        setAspect(localIntent.aspectRatio)
      }

      if (!isEpisodeRenderSettingsResolutionCurrent(
        episodeRenderSettingsConflictRef.current,
        token,
      )) return
      // A 412 proves the opaque Episode version advanced even when visible
      // settings cycled A -> B -> A. The server may already have invalidated
      // assets/jobs, so never infer freshness from equal display values.
      markRenderSettingsOutputsStale()
      const refreshIncomplete = await refreshRenderSettingsDependents()
      if (!isEpisodeRenderSettingsResolutionCurrent(
        episodeRenderSettingsConflictRef.current,
        token,
      )) return
      publishEpisodeRenderSettingsConflict(null)
      setSaveState(preservedEpisodeInputDraft ? 'dirty' : 'saved')
      const resolutionMessage = action === 'adopt-server'
        ? '已采用服务器最新画面设置'
        : refreshIncomplete
          ? '本地画面设置已重新应用；下游状态稍后同步'
          : '本地画面设置已基于最新版本重新应用'
      setToast(preservedEpisodeInputDraft
        ? `${resolutionMessage}；本地原文草稿仍待提交`
        : resolutionMessage)
    } catch (error) {
      if (!isEpisodeRenderSettingsResolutionCurrent(
        episodeRenderSettingsConflictRef.current,
        token,
      )) return
      const operationMessage = error instanceof ApiError && error.status === 412
        ? '确认期间服务器又有新更新，未覆盖任何内容'
        : error instanceof Error ? error.message : '画面设置冲突处理失败'
      let active = episodeRenderSettingsConflictRef.current!
      try {
        const authority = await loadCurrentEpisodeRenderSettingsAuthority(active.scope)
        if (!isEpisodeRenderSettingsResolutionCurrent(
          episodeRenderSettingsConflictRef.current,
          token,
        )) return
        applyEpisodeRenderSettingsAuthorityBundle(active.scope, authority)
        active = withEpisodeRenderSettingsAuthority(
          episodeRenderSettingsConflictRef.current!,
          authority,
        )
      } catch (refreshError) {
        const refreshMessage = refreshError instanceof Error
          ? refreshError.message
          : '无法刷新服务器画面设置'
        active = episodeRenderSettingsConflictRef.current!
        publishEpisodeRenderSettingsConflict(makeEpisodeRenderSettingsConflictReady(
          active,
          `${operationMessage}；${refreshMessage}`,
        ))
        setSaveState('conflict')
        return
      }
      publishEpisodeRenderSettingsConflict(makeEpisodeRenderSettingsConflictReady(
        active,
        operationMessage,
      ))
      setSaveState('conflict')
    }
  }

  const changeSelectedStyle = (value: string) => {
    const normalized = value.trim()
    if (!normalized || normalized === selectedStyleRef.current) return
    selectedStyleRef.current = normalized
    setSelectedStyle(normalized)
    persistEpisodeRenderSettings(normalized, aspectRef.current)
  }

  const changeAspect = (value: string) => {
    if (!['16:9', '9:16', '1:1'].includes(value) || value === aspectRef.current) return
    aspectRef.current = value
    setAspect(value)
    persistEpisodeRenderSettings(selectedStyleRef.current, value)
  }

  const formatGenerationError = (error: unknown) =>
    error instanceof Error ? error.message : '图片生成失败，请稍后重试。'

  const primaryCharacter = storyDocument?.characters[0]
  const primaryCharacterTarget = visualAssetTargets.find((target) => (
    target.type === 'character' && target.id === primaryCharacter?.id
  ))
  const primaryTurnaroundReferenceCount = primaryCharacterTarget?.lockedReferences
    ? Object.values(primaryCharacterTarget.lockedReferences).filter((assetId) => {
        if (assetId === null) return false
        const asset = visualAssetLibrary.find((candidate) => candidate.id === assetId)
        return asset?.status === 'ready'
          && asset.sourceRevisionId === productionContext?.episode.sourceRevisionId
      }).length
    : 0
  const storyboardCharacterReferencesMissing = consistencyLocked
    && primaryCharacter !== undefined
    && primaryTurnaroundReferenceCount < 3
  const openPrimaryCharacterReferenceSetup = () => {
    if (primaryCharacter) {
      setAssetEntityFocus({ type: 'character', id: primaryCharacter.id })
    }
    changeStage('assets')
    setToast('已定位到项目数字资产库；请依次“拆分三视图”并“绑定三视图”。')
  }
  const useTextOnlyStoryboards = () => {
    setConsistencyLocked(false)
    setToast('已明确关闭锁定参考图；后续分镜将使用纯文本提示，已锁定角色资产不会被删除。')
  }
  const buildShotPrompt = (shot: Shot) => [
    `为漫剧《${storyDocument?.title ?? productionContext?.episode.title ?? '未命名漫剧'}》生成一个专业分镜画面。`,
    `镜头：${shot.title}；${shot.framing}；${shot.movement}。`,
    `画面内容：${shot.copy}`,
    `镜头视觉提示：${shot.visualPrompt}`,
    `视觉风格：${selectedStyle || storyDocument?.bible.visualStyle || '国风动画'}，统一角色设计，电影级构图。`,
    consistencyLocked && primaryCharacter
      ? `角色 ${primaryCharacter.name} 必须严格保持：${primaryCharacter.visualDescription}`
      : '',
    '画面清晰，主体明确，无文字、无字幕、无标志、无水印。',
  ].filter(Boolean).join('\n')

  const imageSize = aspect === '9:16' ? '1024x1536' : aspect === '1:1' ? '1024x1024' : '1536x1024'

  const freezeProductionImage = (
    input: GenerateImageInput,
    purpose: AssetImageGenerationPurpose,
  ): FrozenAssetImageGenerationAttempt => {
    if (!productionContext) throw new Error('真实制作工程尚未初始化，请稍后重试')
    if (!executableImageProvider) {
      throw new Error('请先在 Provider 设置中配置并启用可执行的默认图片 Provider')
    }
    const signature = JSON.stringify({
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
      sourceRevisionId: productionContext.episode.sourceRevisionId,
      providerId: executableImageProvider.id,
      providerConfigRevision: executableImageProvider.configRevision,
      input,
    })
    const idempotencyKey = imageIdempotencyRef.current.get(signature) ?? crypto.randomUUID()
    imageIdempotencyRef.current.set(signature, idempotencyKey)
    return freezeAssetImageGenerationAttempt({
      signature,
      idempotencyKey,
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
      providerId: executableImageProvider.id,
      request: input,
      purpose,
    })
  }

  const freezeShotImageAttempt = (shot: Shot) => freezeProductionImage({
      prompt: buildShotPrompt(shot),
      size: imageSize,
      quality: 'medium',
      count: 1,
      metadata: {
        kind: 'storyboard',
        shotId: shot.storyId ?? String(shot.id),
        ...(shot.sceneId ? { sceneId: shot.sceneId } : {}),
        shotCode: shot.code,
        useLockedReferences: consistencyLocked,
      },
    }, { kind: 'storyboard', shotId: shot.id, shotCode: shot.code })

  const freezeAliImageAttempt = () => freezeProductionImage({
      prompt: [
        `为漫剧《${storyDocument?.title ?? productionContext?.episode.title ?? '未命名漫剧'}》制作主角 ${primaryCharacter?.name ?? '主角'} 的专业角色设定三视图。`,
        primaryCharacter?.visualDescription ?? '保持同一角色的脸型、发型、服装、配色与身体比例完全一致。',
        `视觉风格：${selectedStyle || storyDocument?.bible.visualStyle || '国风动画'}，清晰的正面、侧面、背面全身视图，三者造型与比例完全一致。`,
        '中性站姿，干净的深灰工作室背景，角色设计稿排版，无文字、无标志、无水印。',
      ].join('\n'),
      size: '1536x1024',
      quality: 'medium',
      count: 1,
      metadata: {
        kind: 'character-turnaround',
        characterId: primaryCharacter?.id ?? 'primary-character',
      },
    }, { kind: 'primary-character', label: primaryCharacter?.name ?? '主角' })

  const preflightFrozenAssetImage = async (
    attempt: FrozenAssetImagePaidAttempt,
  ): Promise<PublicPaidAigcConfirmation> => {
    if (attempt.action === 'asset.image.generate') {
      return api.preflightAssetImageJob(
        attempt.projectId,
        attempt.episodeId,
        attempt.input,
        {
          providerId: attempt.providerId,
          idempotencyKey: attempt.idempotencyKey,
        },
      )
    }
    return api.preflightAssetImageEdit(
      attempt.sourceAssetId,
      attempt.input,
      attempt.sourceEtag,
      { idempotencyKey: attempt.idempotencyKey },
    )
  }

  const openAssetImageConfirmation = async (
    attempt: FrozenAssetImagePaidAttempt,
  ): Promise<void> => {
    if (assetImagePreparingRef.current || assetImageConfirmationBusyRef.current) {
      throw new Error('另一个图片计费意图正在核对，请先完成或取消')
    }
    assetImagePreparingRef.current = true
    setAssetImagePreparing(true)
    setAssetImageConfirmationError('')
    try {
      const confirmation = await preflightFrozenAssetImage(attempt)
      setAssetImageConfirmation({ attempt, confirmation })
    } finally {
      assetImagePreparingRef.current = false
      setAssetImagePreparing(false)
    }
  }

  const refreshVisualAssetWorkbench = async () => {
    if (!productionContext || !productionContext.episode.sourceRevisionId) return
    const [targetResult, assets] = await Promise.all([
      api.listVisualAssetTargets(productionContext.projectId, productionContext.episode.id),
      api.listAssets(productionContext.projectId, {
        episodeId: productionContext.episode.id,
        includeProjectAssets: true,
      }),
    ])
    if (targetResult.sourceRevisionId !== productionContext.episode.sourceRevisionId) {
      throw new Error('视觉资产目标与当前剧本修订不一致，请刷新剧本后重试')
    }
    setVisualAssetTargets(targetResult.targets)
    setVisualAssetLibrary(assets)
    setVisualAssetState('ready')
    setVisualAssetError('')
  }

  const visualAssetPrompt = (target: VisualAssetTarget) => {
    const common = [
      `项目：《${storyDocument?.title ?? productionContext?.episode.title ?? '未命名漫剧'}》`,
      `视觉风格：${selectedStyle || storyDocument?.bible.visualStyle || '国风动画'}。`,
      `目标：${target.name}。`,
      target.description ? `剧情设定：${target.description}` : '',
      target.visualDescription ? `视觉约束：${target.visualDescription}` : '',
    ]
    if (target.type === 'character') {
      return [
        '制作专业角色设定三视图，清晰呈现同一角色的正面、侧面、背面全身视图。',
        ...common,
        target.role ? `角色定位：${target.role}。` : '',
        '三视图的脸型、发型、服装、配色与身体比例必须一致；中性站姿，干净背景，无文字、标志或水印。',
      ].filter(Boolean).join('\n')
    }
    if (target.type === 'location') {
      return [
        '制作专业漫剧场景设定图，表现空间布局、光线、材质与可用于分镜的环境辨识度。',
        ...common,
        '画面中不出现文字、标志或水印，不加入与设定无关的主体角色。',
      ].filter(Boolean).join('\n')
    }
    return [
      '制作专业关键道具设定图，清晰展示造型、材质、比例与关键细节。',
      ...common,
      '单一主体、干净背景、无文字、标志或水印。',
    ].filter(Boolean).join('\n')
  }

  const generateVisualAsset = async (target: VisualAssetTarget) => {
    if (!productionContext || visualAssetActionKey || assetImageConfirmation) return
    const actionKey = `generate:${target.type}:${target.id}`
    setVisualAssetActionKey(actionKey)
    try {
      const kind = target.type === 'character'
        ? 'character-turnaround'
        : target.type === 'location'
          ? 'location-concept'
          : 'prop-concept'
      const attempt = freezeProductionImage({
        prompt: visualAssetPrompt(target),
        size: target.type === 'character' ? '1536x1024' : imageSize,
        quality: 'medium',
        count: 1,
        metadata: {
          kind,
          entityType: target.type,
          entityId: target.id,
        },
      }, {
        kind: 'visual-asset',
        targetType: target.type,
        targetId: target.id,
        label: target.name,
      })
      assetImageQueueRef.current = []
      await openAssetImageConfirmation(attempt)
      setToast(`「${target.name}」已通过免费预检，请明确确认后建单`)
      return undefined
    } catch (error) {
      setToast(formatGenerationError(error))
      return undefined
    } finally {
      setVisualAssetActionKey(null)
    }
  }

  const editVisualAsset = async (
    target: VisualAssetTarget,
    source: MediaAsset,
    submission: VisualAssetEditSubmission,
  ) => {
    if (!productionContext) throw new Error('真实制作工程尚未初始化，请稍后重试')
    if (visualAssetActionKey) throw new Error('另一项视觉资产操作仍在进行，请等待完成后重试')
    if (!executableImageProvider) {
      const message = '请先在 Provider 设置中配置并启用可执行的默认图片 Provider'
      setToast(message)
      throw new Error(message)
    }

    const scope = storyScopeFor(productionContext)
    const actionKey = `edit:${source.id}`
    setVisualAssetActionKey(actionKey)
    try {
      let authoritativeSource = source
      if (!authoritativeSource.etag) {
        authoritativeSource = await api.getAsset(source.id)
      }
      if (!authoritativeSource.etag) {
        throw new Error('源图缺少强 ETag，请刷新素材后重试')
      }
      const signature = JSON.stringify({
        projectId: productionContext.projectId,
        episodeId: productionContext.episode.id,
        sourceRevisionId: productionContext.episode.sourceRevisionId,
        sourceAssetId: authoritativeSource.id,
        sourceAssetVersion: authoritativeSource.version,
        sourceAssetChecksum: authoritativeSource.checksum,
        providerId: executableImageProvider.id,
        providerConfigRevision: executableImageProvider.configRevision,
        submission,
      })
      const idempotencyLease = await acquireAssetImageEditIdempotencyLease(signature)
      imageIdempotencyRef.current.set(signature, idempotencyLease.key)
      const request = {
        projectId: productionContext.projectId,
        ...submission,
        providerId: executableImageProvider.id,
      }
      const attempt = freezeAssetImageEditAttempt({
        signature,
        idempotencyKey: idempotencyLease.key,
        sourceAssetId: authoritativeSource.id,
        sourceEtag: authoritativeSource.etag,
        request,
        purpose: {
          kind: 'visual-asset-edit',
          targetType: target.type,
          targetId: target.id,
          label: target.name,
          sourceLabel: `${target.name}候选 v${authoritativeSource.version}`,
        },
      })
      assetImageQueueRef.current = []
      await openAssetImageConfirmation(attempt)
      setToast(`「${target.name}」${submission.mode === 'variation' ? '原生变体' : '图片编辑'}已通过免费预检，请明确确认后建单`)
    } catch (cause) {
      const message = formatGenerationError(cause)
      if (cause instanceof ApiError
        && ['PRECONDITION_FAILED', 'STALE_SOURCE', 'INVALID_ASSET_ETAG'].includes(cause.code)
        && storyScopeIsCurrent(scope)) {
        await refreshStoryAfterConflict(scope).catch(() => undefined)
        await refreshVisualAssetWorkbench().catch(() => undefined)
      }
      setToast(message)
      // Retain the idempotency key for cancel, expiry, and ambiguous responses.
      throw cause instanceof Error ? cause : new Error(message)
    } finally {
      setVisualAssetActionKey(null)
    }
  }

  const deriveCharacterTurnaround = async (
    target: VisualAssetTarget,
    source: MediaAsset,
    crops: TurnaroundCrops,
  ) => {
    if (!productionContext) throw new Error('真实制作工程尚未初始化，请稍后重试')
    if (target.type !== 'character') throw new Error('只有角色三视图候选可以拆分朝向参考图')
    if (visualAssetActionKey) throw new Error('另一项视觉资产操作仍在进行，请等待完成后重试')
    const scope = storyScopeFor(productionContext)
    const actionKey = `turnaround:${source.id}`
    setVisualAssetActionKey(actionKey)
    try {
      const authoritativeSource = source.etag ? source : await api.getAsset(source.id)
      if (!authoritativeSource.etag) throw new Error('源图缺少强 ETag，请刷新素材后重试')
      const normalizedCrops = (['front', 'side', 'back'] as const).map((role) => ({
        role,
        ...crops[role],
      }))
      const signature = JSON.stringify({
        operation: 'asset.image.turnaround.derive',
        projectId: productionContext.projectId,
        episodeId: productionContext.episode.id,
        sourceRevisionId: productionContext.episode.sourceRevisionId,
        sourceAssetId: authoritativeSource.id,
        sourceAssetVersion: authoritativeSource.version,
        sourceAssetChecksum: authoritativeSource.checksum,
        crops: normalizedCrops,
      })
      const idempotencyLease = await acquireAssetImageEditIdempotencyLease(signature)
      await api.createAssetTurnaroundDerivation(authoritativeSource.id, {
        projectId: productionContext.projectId,
        crops: normalizedCrops,
      }, authoritativeSource.etag, { idempotencyKey: idempotencyLease.key })
      acknowledgeAssetImageEditIdempotencyLease(idempotencyLease)
      try {
        await jobsState.refresh()
      } catch {
        // The local persistent job is authoritative and will reappear via SSE.
      }
      setToast(`「${target.name}」三视图已进入本地派生队列；不调用图片 Provider`)
    } catch (cause) {
      if (cause instanceof ApiError
        && ['PRECONDITION_FAILED', 'STALE_SOURCE', 'INVALID_ASSET_ETAG'].includes(cause.code)
        && storyScopeIsCurrent(scope)) {
        await refreshStoryAfterConflict(scope).catch(() => undefined)
        await refreshVisualAssetWorkbench().catch(() => undefined)
      }
      const message = cause instanceof Error ? cause.message : '三视图派生任务创建失败'
      setToast(message)
      throw cause instanceof Error ? cause : new Error(message)
    } finally {
      setVisualAssetActionKey(null)
    }
  }

  const lockCharacterTurnaroundReferences = async (
    target: VisualAssetTarget,
    references: CharacterTurnaroundReferenceSet,
  ) => {
    const current = productionContextRef.current
    if (!current || target.type !== 'character' || assetLocking || visualAssetActionKey) return
    const parentIds = new Set(Object.values(references).map((asset) => asset.parentAssetId))
    if (parentIds.size !== 1 || parentIds.has(null)) {
      setToast('三视图不属于同一次派生，请重新拆分后再绑定')
      return
    }
    const sourceAssetId = [...parentIds][0]
    const scope = storyScopeFor(current)
    const actionKey = `turnaround-lock:${target.id}:${sourceAssetId}`
    setAssetLocking(true)
    setVisualAssetActionKey(actionKey)
    try {
      const result = await api.lockCharacterVisualReferences({
        projectId: current.projectId,
        episodeId: current.episode.id,
        targetId: target.id,
        frontAssetId: references.front.id,
        sideAssetId: references.side.id,
        backAssetId: references.back.id,
      }, current.episodeEtag)
      const authoritative = productionContextRef.current
      if (!authoritative
        || !storyScopeIsCurrent(scope)
        || result.sourceRevisionId !== authoritative.episode.sourceRevisionId) return

      const nextContext: ProductionContext = {
        ...authoritative,
        episodeEtag: result.etag,
      }
      productionContextRef.current = nextContext
      setProductionContext(nextContext)
      setVisualAssetTargets((items) => items.map((item) => (
        item.type === 'character' && item.id === target.id
          ? {
              ...item,
              version: result.target.version,
              lockedAssetId: result.target.lockedAssetId,
              lockedReferences: {
                frontAssetId: result.target.references.frontAssetId,
                sideAssetId: result.target.references.sideAssetId,
                backAssetId: result.target.references.backAssetId,
              },
            }
          : item
      )))
      if (result.stale.assets > 0) {
        const invalidated = shotsRef.current.map((shot): Shot => shot.storyId ? {
          ...shot,
          status: '待生成',
          assetId: undefined,
          jobId: undefined,
          generationError: `${target.name}三视图引用已变更，该分镜需重新生成`,
        } : shot)
        shotsRef.current = invalidated
        setShots(invalidated)
      }
      await Promise.all([jobsState.refresh(), refreshVisualAssetWorkbench()])
      setToast(result.idempotent
        ? `「${target.name}」已绑定这组三视图`
        : `已原子绑定「${target.name}」正面、侧面与背面引用`)
    } catch (error) {
      if (error instanceof ApiError && error.status === 412 && storyScopeIsCurrent(scope)) {
        await refreshStoryAfterConflict(scope).catch(() => undefined)
        await refreshVisualAssetWorkbench().catch(() => undefined)
      }
      setToast(error instanceof Error ? error.message : '角色三视图绑定失败')
    } finally {
      setAssetLocking(false)
      setVisualAssetActionKey(null)
    }
  }

  const retryVisualAsset = async (target: VisualAssetTarget, job: GenerationJob) => {
    if (visualAssetActionKey) return
    if (job.type === 'asset.image.edit') {
      setToast('图片编辑/变体重试也可能计费；请从原源图重新预检并明确确认')
      return
    }
    // Do not use the legacy retry endpoint: a retry can call the Provider and
    // therefore must receive a fresh signed challenge and explicit consent.
    await generateVisualAsset(target)
  }

  const lockVisualAsset = async (target: VisualAssetTarget, assetId: string) => {
    if (!productionContext || assetLocking || visualAssetActionKey) return
    const scope = storyScopeFor(productionContext)
    const actionKey = `lock:${target.type}:${target.id}:${assetId}`
    setAssetLocking(true)
    setVisualAssetActionKey(actionKey)
    try {
      const result = await api.lockAsset(assetId, {
        projectId: productionContext.projectId,
        episodeId: productionContext.episode.id,
        targetType: target.type,
        targetId: target.id,
      }, productionContext.episodeEtag)
      if (!storyScopeIsCurrent(scope)
        || result.sourceRevisionId !== productionContextRef.current?.episode.sourceRevisionId) return
      setVisualAssetTargets((items) => items.map((item) => (
        item.type === target.type && item.id === target.id
          ? { ...item, version: result.target.version, lockedAssetId: result.asset.id }
          : item
      )))
      if (result.stale.assets > 0) {
        const invalidated = shotsRef.current.map((shot): Shot => shot.storyId ? {
          ...shot,
          status: '待生成',
          assetId: undefined,
          generationError: `${target.name}参考资产已变更，该分镜需重新生成`,
        } : shot)
        shotsRef.current = invalidated
        setShots(invalidated)
      }
      await Promise.all([jobsState.refresh(), refreshVisualAssetWorkbench()])
      setToast(result.idempotent
        ? `「${target.name}」已锁定该候选`
        : `已锁定「${target.name}」候选，下游分镜将使用新参考`)
    } catch (error) {
      if (error instanceof ApiError && error.status === 412 && storyScopeIsCurrent(scope)) {
        await refreshStoryAfterConflict(scope).catch(() => undefined)
      }
      setToast(error instanceof Error ? error.message : '视觉资产锁定失败')
    } finally {
      setAssetLocking(false)
      setVisualAssetActionKey(null)
    }
  }

  const adoptHistoricalVisualAsset = async (
    target: VisualAssetTarget,
    source: MediaAsset,
  ) => {
    const current = productionContextRef.current
    if (!current || !current.episode.sourceRevisionId) {
      throw new Error('当前分集尚未绑定可追溯的剧本修订')
    }
    if (source.sourceRevisionId === current.episode.sourceRevisionId) return
    if (visualAssetActionKey || historicalVisualAdoptionBusyRef.current) {
      throw new Error('另一项视觉资产操作仍在进行，请等待完成后重试')
    }

    const scope = storyScopeFor(current)
    const actionKey = `history-adopt:${target.type}:${target.id}:${source.id}`
    historicalVisualAdoptionBusyRef.current = true
    setVisualAssetActionKey(actionKey)
    try {
      // Listing is a fresh, read-only authority check. The returned ETag and
      // semantic fingerprint are pinned into the subsequent mutation so an
      // old thumbnail can never be adopted merely because the client shows it.
      const history = await api.listHistoricalVisualAssetCandidates(
        current.projectId,
        current.episode.id,
        target.type,
        target.id,
      )
      const candidate = history.candidates.find((item) => item.assetVersionId === source.id)
      if (!candidate) {
        throw new Error('该历史版本与当前实体、视觉设定、风格或画幅不再完全一致，未创建新版本')
      }
      const signature = JSON.stringify({
        operation: 'asset.image.history.adopt',
        projectId: current.projectId,
        episodeId: current.episode.id,
        sourceRevisionId: history.sourceRevisionId,
        entityType: target.type,
        entityId: target.id,
        assetFamilyId: candidate.assetFamilyId,
        assetVersionId: candidate.assetVersionId,
        semanticFingerprint: candidate.semanticFingerprint,
      })
      const idempotencyKey = imageIdempotencyRef.current.get(signature) ?? crypto.randomUUID()
      imageIdempotencyRef.current.set(signature, idempotencyKey)
      const result = await api.adoptHistoricalVisualAsset(source.id, {
        projectId: current.projectId,
        episodeId: current.episode.id,
        entityType: target.type,
        entityId: target.id,
      }, history.etag, { idempotencyKey })
      const authoritative = productionContextRef.current
      if (!authoritative
        || !storyScopeIsCurrent(scope)
        || result.sourceRevisionId !== authoritative.episode.sourceRevisionId) return
      const nextContext: ProductionContext = {
        ...authoritative,
        episodeEtag: result.etag,
      }
      productionContextRef.current = nextContext
      setProductionContext(nextContext)
      await Promise.all([jobsState.refresh(), refreshVisualAssetWorkbench()])
      setToast(result.idempotent
        ? `「${target.name}」历史版本已在当前修订中恢复`
        : `已零费用继承「${target.name}」；创建了新的不可变版本，未调用图片 Provider`)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 412 && storyScopeIsCurrent(scope)) {
        await refreshStoryAfterConflict(scope).catch(() => undefined)
        await refreshVisualAssetWorkbench().catch(() => undefined)
      }
      const message = cause instanceof Error ? cause.message : '历史素材继承失败'
      setToast(message)
      throw cause instanceof Error ? cause : new Error(message)
    } finally {
      historicalVisualAdoptionBusyRef.current = false
      setVisualAssetActionKey(null)
    }
  }

  const trackImageJobs = async (
    entries: Array<{ shotId: number; job: ImageJob }>,
    runId: number,
    initialFailureCount = 0,
  ) => {
    const pending = new Map(entries.map(({ shotId, job }) => [shotId, job.id]))
    const failures = new Map<number, number>()
    const total = pending.size + initialFailureCount
    let succeededCount = 0
    let failedCount = initialFailureCount
    let cancelledCount = 0

    while (pending.size > 0 && generationRunRef.current === runId) {
      await new Promise((resolve) => window.setTimeout(resolve, 900))
      const snapshot = [...pending.entries()]
      await Promise.all(snapshot.map(async ([shotId, jobId]) => {
        try {
          const job = await api.getImageJob(jobId)
          failures.delete(shotId)
          if (job.status === 'succeeded') {
            const generatedImage = job.output?.images?.[0]
            setShots((items) => items.map((shot) => shot.id === shotId && shot.jobId === jobId ? {
              ...shot,
              status: '待审核',
              imageUrl: generatedImage?.url || shot.imageUrl,
              assetId: generatedImage?.id || shot.assetId,
              generationError: undefined,
              jobId: job.id,
              previousStatus: undefined,
              isDemo: false,
            } : shot))
            pending.delete(shotId)
            succeededCount += 1
          } else if (job.status === 'failed') {
            setShots((items) => items.map((shot) => shot.id === shotId && shot.jobId === jobId ? {
              ...shot,
              status: '失败',
              generationError: job.error?.message || '上游图片服务生成失败',
              jobId: job.id,
            } : shot))
            pending.delete(shotId)
            failedCount += 1
          } else if (job.status === 'cancelled') {
            setShots((items) => items.map((shot) => shot.id === shotId && shot.jobId === jobId ? {
              ...shot,
              status: shot.assetId ? shot.previousStatus ?? '待审核' : '待生成',
              generationError: shot.assetId ? undefined : '图片生成任务已取消',
              jobId: job.id,
              previousStatus: shot.assetId ? shot.previousStatus : undefined,
            } : shot))
            pending.delete(shotId)
            cancelledCount += 1
          }
        } catch (error) {
          const failureCount = (failures.get(shotId) ?? 0) + 1
          failures.set(shotId, failureCount)
          if (failureCount >= 4) {
            setShots((items) => items.map((shot) => shot.id === shotId && shot.jobId === jobId ? {
              ...shot,
              status: '失败',
              generationError: formatGenerationError(error),
            } : shot))
            pending.delete(shotId)
            failedCount += 1
          }
        }
      }))
      setGenerationProgress(Math.max(8, Math.round(((total - pending.size) / total) * 100)))
    }

    if (generationRunRef.current === runId) {
      try {
        const refreshed = await jobsState.refresh()
        const revisionId = productionContext?.episode.sourceRevisionId
        const activeStoryboardJobs = refreshed.filter((job) => {
          if (
            job.type !== 'asset.image.generate'
            || job.episodeId !== productionContext?.episode.id
            || generationJobIsStale(job)
            || !isRecordValue(job.input)
          ) return false
          const binding = isRecordValue(job.input.storyboardBinding)
            ? job.input.storyboardBinding
            : null
          return Boolean(
            binding
            && binding.expectedRevisionId === revisionId
            && ['queued', 'running', 'waiting_provider'].includes(job.status),
          )
        })
        setGenerating(activeStoryboardJobs.length > 0)
        setGenerationTargets([])
        setGenerationProgress(activeStoryboardJobs.length
          ? Math.round(activeStoryboardJobs.reduce((sum, job) => sum + job.progress, 0) / activeStoryboardJobs.length)
          : 100)
      } catch {
        // The per-shot state is already terminal. A later SSE snapshot will
        // reconcile the aggregate state if other image jobs are still active.
        const locallyActive = shotsRef.current.filter((shot) => shot.status === '生成中')
        setGenerating(locallyActive.length > 0)
        setGenerationTargets(locallyActive.map((shot) => shot.id))
        if (locallyActive.length === 0) setGenerationProgress(100)
      }
      const summary = [`已生成 ${succeededCount} 个`]
      if (failedCount > 0) summary.push(`失败 ${failedCount} 个`)
      if (cancelledCount > 0) summary.push(`取消 ${cancelledCount} 个`)
      setToast(summary.join('，'))
    }
  }

  const startGeneration = async (targetIds: number[] = [activeShot]) => {
    if (isGenerating
      || assetImageConfirmation
      || assetImagePreparingRef.current
      || assetImageConfirmationBusyRef.current) return
    if (storyboardCharacterReferencesMissing) {
      setToast(`角色真实三视图仅 ${primaryTurnaroundReferenceCount}/3；请先补齐，或明确改用纯文本分镜。`)
      return
    }
    const targets = shots.filter((shot) => targetIds.includes(shot.id))
    if (targets.length === 0) return
    const runId = generationRunRef.current + 1
    generationRunRef.current = runId
    try {
      const attempts = targets.map(freezeShotImageAttempt)
      storyboardImageSubmissionBatchRef.current = { runId, accepted: [], failedCount: 0 }
      assetImageQueueRef.current = attempts.slice(1)
      setGenerationProgress(0)
      setGenerationTargets([])
      await openAssetImageConfirmation(attempts[0])
      setToast(targets.length === 1
        ? `镜头 ${targets[0].code} 已通过免费预检，请确认后建单`
        : `已预检第 1/${targets.length} 个镜头；每个计费任务都需要你逐一确认`)
    } catch (error) {
      assetImageQueueRef.current = []
      storyboardImageSubmissionBatchRef.current = null
      setToast(formatGenerationError(error))
    }
  }

  const retryShotGeneration = async (shotId: number) => {
    const shot = shotsRef.current.find((item) => item.id === shotId)
    if (!shot || shot.status === '生成中') return
    // Provider retry is also billable. Recreate the exact semantic intent so it
    // must pass through the same signed preflight instead of bypassing consent.
    await startGeneration([shotId])
  }

  const cancelShotGeneration = async (shotId: number) => {
    const shot = shotsRef.current.find((item) => item.id === shotId)
    if (
      !shot
      || shot.status !== '生成中'
      || !shot.jobId
      || cancellingShotIds.includes(shotId)
    ) return

    setCancellingShotIds((ids) => [...new Set([...ids, shotId])])
    setToast(`正在中断镜头 ${shot.code} 的生成任务…`)
    try {
      const job = await api.cancelGenerationJob(shot.jobId)
      if (job.status === 'cancelled') {
        setShots((items) => items.map((item) => item.id === shotId && item.jobId === job.id ? {
          ...item,
          status: item.assetId ? item.previousStatus ?? '待审核' : '待生成',
          generationError: item.assetId ? undefined : '图片生成任务已取消',
          previousStatus: item.assetId ? item.previousStatus : undefined,
        } : item))
        setGenerationTargets((ids) => ids.filter((id) => id !== shotId))
        setToast(shot.assetId
          ? `镜头 ${shot.code} 的新版本生成已取消，原画面保持不变`
          : `镜头 ${shot.code} 的生成任务已取消`)
      } else if (job.status === 'failed') {
        setShots((items) => items.map((item) => item.id === shotId && item.jobId === job.id ? {
          ...item,
          status: '失败',
          generationError: job.error?.message || '任务中断结果无法确认',
        } : item))
        setToast(job.error?.message || '任务中断结果无法确认，请检查任务中心')
      } else if (job.status === 'succeeded') {
        setToast(`镜头 ${shot.code} 已在中断前完成，无法撤回本次结果`)
      }
      await jobsState.refresh().catch(() => undefined)
    } catch (error) {
      setToast(error instanceof Error ? error.message : '中断图片生成任务失败')
    } finally {
      setCancellingShotIds((ids) => ids.filter((id) => id !== shotId))
    }
  }

  const trackAliJob = async (job: ImageJob, runId: number) => {
    let failures = 0
    try {
      while (failures < 4 && aliRunRef.current === runId) {
        await new Promise((resolve) => window.setTimeout(resolve, 900))
        try {
          const latest = await api.getImageJob(job.id)
          failures = 0
          if (latest.status === 'succeeded') {
            const image = latest.output?.images?.[0]
            if (!image?.url) throw new Error('角色资产任务未返回图片')
            setAliAsset({ status: 'ready', jobId: latest.id, imageUrl: image.url, assetId: image.id, locked: false })
            setToast(`${primaryCharacter?.name ?? '主角'}角色三视图已生成`)
            return
          }
          if (latest.status === 'failed') {
            setAliAsset({ status: 'failed', jobId: latest.id, error: latest.error?.message || '角色资产生成失败' })
            setToast(latest.error?.message || '角色资产生成失败')
            return
          }
        } catch {
          failures += 1
        }
      }
      if (aliRunRef.current === runId) throw new Error('无法获取角色资产任务状态')
    } catch (error) {
      if (aliRunRef.current !== runId) return
      setAliAsset((asset) => ({ ...asset, status: 'failed', error: formatGenerationError(error) }))
      setToast(formatGenerationError(error))
    }
  }

  const generateAliAsset = async () => {
    if (aliAsset.status === 'generating'
      || assetImageConfirmation
      || assetImagePreparingRef.current
      || assetImageConfirmationBusyRef.current) return
    try {
      assetImageQueueRef.current = []
      await openAssetImageConfirmation(freezeAliImageAttempt())
      setToast(`${primaryCharacter?.name ?? '主角'}三视图已通过免费预检，请明确确认后建单`)
    } catch (error) {
      setAliAsset((asset) => ({ ...asset, status: 'failed', error: formatGenerationError(error) }))
      setToast(formatGenerationError(error))
    }
  }

  const finishStoryboardImageSubmissionBatch = () => {
    const batch = storyboardImageSubmissionBatchRef.current
    storyboardImageSubmissionBatchRef.current = null
    if (!batch) return
    if (batch.accepted.length === 0) {
      setGenerating(false)
      setGenerationTargets([])
      setGenerationProgress(0)
      return
    }
    setGenerationProgress(8)
    setToast(`${batch.accepted.length} 个真实生成任务已明确确认并进入队列`)
    void trackImageJobs(batch.accepted, batch.runId, batch.failedCount)
  }

  const preflightNextQueuedAssetImage = async () => {
    const next = assetImageQueueRef.current.shift()
    if (!next) {
      finishStoryboardImageSubmissionBatch()
      return
    }
    try {
      await openAssetImageConfirmation(next)
      const batch = storyboardImageSubmissionBatchRef.current
      const completed = batch?.accepted.length ?? 0
      setToast(`已预检第 ${completed + 1} 个镜头；请明确确认这 1 个计费任务`)
    } catch (error) {
      const batch = storyboardImageSubmissionBatchRef.current
      if (batch) batch.failedCount += 1
      assetImageQueueRef.current = []
      setToast(formatGenerationError(error))
      finishStoryboardImageSubmissionBatch()
    }
  }

  const refreshAssetImageConfirmation = async () => {
    const current = assetImageConfirmation
    if (!current || assetImageConfirmationBusyRef.current) return
    assetImageConfirmationBusyRef.current = true
    setAssetImageConfirmationBusy(true)
    setAssetImageConfirmationError('')
    try {
      const confirmation = await preflightFrozenAssetImage(current.attempt)
      setAssetImageConfirmation({ attempt: current.attempt, confirmation })
    } catch (error) {
      setAssetImageConfirmationError(error instanceof Error ? error.message : '无法刷新图片任务确认')
    } finally {
      assetImageConfirmationBusyRef.current = false
      setAssetImageConfirmationBusy(false)
    }
  }

  const cancelAssetImageConfirmation = () => {
    if (assetImageConfirmationBusyRef.current) return
    // Cancellation deliberately retains every exact-intent idempotency lease.
    // No paid call has been made, and a later retry safely re-preflights it.
    setAssetImageConfirmation(null)
    setAssetImageConfirmationError('')
    setVisualAssetActionKey(null)
    assetImageQueueRef.current = []
    finishStoryboardImageSubmissionBatch()
  }

  const confirmAssetImage = async () => {
    const current = assetImageConfirmation
    if (!current || assetImageConfirmationBusyRef.current) return
    if (!confirmationMatchesAssetImageAttempt(current.attempt, current.confirmation)) {
      await refreshAssetImageConfirmation()
      return
    }

    assetImageConfirmationBusyRef.current = true
    setAssetImageConfirmationBusy(true)
    setAssetImageConfirmationError('')
    const purpose = current.attempt.purpose
    setVisualAssetActionKey(current.attempt.action === 'asset.image.edit'
      ? `edit:${current.attempt.sourceAssetId}`
      : purpose.kind === 'visual-asset'
        ? `generate:${purpose.targetType}:${purpose.targetId}`
        : null)
    let accepted = false
    let continueQueue = false
    try {
      if (current.attempt.action === 'asset.image.generate') {
        const attempt = current.attempt
        const job = await api.createAssetImageJob(
          attempt.projectId,
          attempt.episodeId,
          attempt.input,
          {
            providerId: attempt.providerId,
            idempotencyKey: attempt.idempotencyKey,
            confirmationToken: current.confirmation.confirmationToken,
          },
        )
        if (imageIdempotencyRef.current.get(attempt.signature) === attempt.idempotencyKey) {
          imageIdempotencyRef.current.delete(attempt.signature)
        }
        accepted = true
        setAssetImageConfirmation(null)

        if (attempt.purpose.kind === 'storyboard') {
          const storyboardPurpose = attempt.purpose
          const batch = storyboardImageSubmissionBatchRef.current
          if (batch) batch.accepted.push({ shotId: storyboardPurpose.shotId, job })
          setGenerating(true)
          setGenerationProgress(8)
          setGenerationTargets((ids) => [...new Set([...ids, storyboardPurpose.shotId])])
          setShots((items) => items.map((shot) => shot.id === storyboardPurpose.shotId ? {
            ...shot,
            previousStatus: shot.previousStatus
              ?? (shot.status === '生成中' ? undefined : shot.status),
            status: '生成中',
            jobId: job.id,
            generationError: undefined,
            isDemo: false,
          } : shot))
          continueQueue = assetImageQueueRef.current.length > 0
        } else if (attempt.purpose.kind === 'primary-character') {
          const runId = aliRunRef.current + 1
          aliRunRef.current = runId
          setAliAsset({ status: 'generating', jobId: job.id })
          setToast(`${attempt.purpose.label}三视图已进入真实生成队列`)
          void trackAliJob(job, runId)
        } else {
          try {
            await jobsState.refresh()
            setToast(`「${attempt.purpose.label}」候选任务已进入真实生成队列`)
          } catch {
            setToast(`「${attempt.purpose.label}」任务已提交，状态将在连接恢复后同步`)
          }
        }
      } else {
        const attempt = current.attempt
        await api.createAssetImageEdit(
          attempt.sourceAssetId,
          attempt.input,
          attempt.sourceEtag,
          {
            idempotencyKey: attempt.idempotencyKey,
            confirmationToken: current.confirmation.confirmationToken,
          },
        )
        const lease = await acquireAssetImageEditIdempotencyLease(attempt.signature)
        if (lease.key === attempt.idempotencyKey) {
          acknowledgeAssetImageEditIdempotencyLease(lease)
        }
        if (imageIdempotencyRef.current.get(attempt.signature) === attempt.idempotencyKey) {
          imageIdempotencyRef.current.delete(attempt.signature)
        }
        accepted = true
        setAssetImageConfirmation(null)
        setVisualAssetEditCompletionVersion((value) => value + 1)
        try {
          await jobsState.refresh()
        } catch {
          // The durable paid task is authoritative; SSE or refresh reconciles it.
        }
        setToast(`「${attempt.purpose.label}」${attempt.input.mode === 'variation' ? '原生变体' : '图片编辑'}任务已进入真实队列`)
      }
    } catch (error) {
      if (error instanceof ApiError
        && error.code === 'PAID_CONFIRMATION_REQUIRED'
        && isRecordValue(error.details)
        && Object.hasOwn(error.details, 'confirmation')) {
        try {
          const confirmation = parsePublicPaidAigcConfirmation(
            error.details.confirmation,
            current.attempt.action,
          )
          setAssetImageConfirmation({ attempt: current.attempt, confirmation })
          setAssetImageConfirmationError('服务端状态或确认有效期已变化；本次没有创建任务，请核对新确认后再手动确认。')
          return
        } catch {
          // Preserve the original safe failure when the replacement is malformed.
        }
      }
      setAssetImageConfirmationError(error instanceof Error ? error.message : '图片任务提交失败')
    } finally {
      assetImageConfirmationBusyRef.current = false
      setAssetImageConfirmationBusy(false)
      setVisualAssetActionKey(null)
    }

    if (!accepted) return
    if (continueQueue) await preflightNextQueuedAssetImage()
    else finishStoryboardImageSubmissionBatch()
  }

  const lockPrimaryAsset = async () => {
    if (
      !productionContext
      || !primaryCharacter
      || !aliAsset.assetId
      || aliAsset.status !== 'ready'
      || assetLocking
    ) return
    const scope = storyScopeFor(productionContext)
    setAssetLocking(true)
    try {
      const result = await api.lockAsset(aliAsset.assetId, {
        projectId: productionContext.projectId,
        episodeId: productionContext.episode.id,
        targetType: 'character',
        targetId: primaryCharacter.id,
      }, productionContext.episodeEtag)
      if (!storyScopeIsCurrent(scope)
        || result.sourceRevisionId !== productionContextRef.current?.episode.sourceRevisionId) return
      setAliAsset((asset) => asset.assetId === result.asset.id
        ? { ...asset, locked: true }
        : asset)
      if (result.stale.assets > 0) {
        const invalidated = shotsRef.current.map((shot): Shot => shot.storyId ? {
          ...shot,
          status: '待生成',
          assetId: undefined,
          generationError: '角色参考资产已变更，该分镜需重新生成',
        } : shot)
        shotsRef.current = invalidated
        setShots(invalidated)
      }
      await jobsState.refresh()
      setToast(result.idempotent
        ? `「${primaryCharacter.name}」已锁定该视觉资产`
        : `已锁定「${primaryCharacter.name}」视觉资产，下游分镜将按新参考重生成`)
    } catch (error) {
      if (error instanceof ApiError && error.status === 412 && storyScopeIsCurrent(scope)) {
        await refreshStoryAfterConflict(scope).catch(() => undefined)
      }
      setToast(error instanceof Error ? error.message : '视觉资产锁定失败')
    } finally {
      setAssetLocking(false)
    }
  }

  useEffect(() => {
    if (!productionContext || !storyDocument) return
    const revisionId = productionContext.episode.sourceRevisionId
    const storyboardJobs = currentStoryJobs.filter((job) => {
      if (job.type !== 'asset.image.generate'
        || job.episodeId !== productionContext.episode.id
        || generationJobIsStale(job)
        || !isRecordValue(job.input)) return false
      const binding = isRecordValue(job.input.storyboardBinding)
        ? job.input.storyboardBinding
        : null
      return Boolean(
        binding
        && typeof binding.shotId === 'string'
        && binding.expectedRevisionId === revisionId,
      )
    })
    const jobsForShot = (storyId: string) => storyboardJobs.filter((job) => {
      const binding = isRecordValue(job.input) && isRecordValue(job.input.storyboardBinding)
        ? job.input.storyboardBinding
        : null
      return job.resourceId === storyId || binding?.shotId === storyId
    }).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    const authoritativeReview = shotMediaReviews.storyboard
    const authoritativeReviewIsCurrent = Boolean(
      authoritativeReview
      && authoritativeReview.projectId === productionContext.projectId
      && authoritativeReview.episodeId === productionContext.episode.id
      && authoritativeReview.sourceRevisionId === revisionId,
    )

    setShots((items) => items.map((shot): Shot => {
      if (!shot.storyId) return shot
      const candidates = jobsForShot(shot.storyId)
      const latest = candidates[0]
      const latestReady = candidates.find((job) => (
        job.status === 'succeeded' && generatedImagesFromJob(job).length > 0
      ))
      const reviewApplies = authoritativeReviewIsCurrent
        && authoritativeReview?.shotId === shot.storyId
        && authoritativeReview.sceneId === shot.sceneId
      const reviewedImage = reviewApplies ? authoritativeReview.currentSelection : undefined
      // A succeeded generation is a durable review candidate even before the
      // user adopts it. An empty currentSelection must not erase that candidate
      // when the user switches shots and the review snapshot is refreshed.
      const image = reviewedImage ?? (latestReady ? generatedImagesFromJob(latestReady)[0] : null)
      const durableImage = image ? {
        imageUrl: image.url,
        assetId: image.id,
        imageClass: 'frame-wide',
      } : {}
      if (!latest) return { ...shot, ...durableImage }
      if (['queued', 'running', 'waiting_provider'].includes(latest.status)) {
        return {
          ...shot,
          ...durableImage,
          previousStatus: shot.previousStatus
            ?? (shot.status === '生成中' ? undefined : shot.status),
          status: '生成中',
          jobId: latest.id,
          generationError: undefined,
          isDemo: false,
        }
      }
      if (latest.status === 'failed') {
        return {
          ...shot,
          ...durableImage,
          status: '失败',
          jobId: latest.id,
          generationError: latest.error?.message || '上游图片服务生成失败',
          isDemo: false,
        }
      }
      if (latest.status === 'cancelled') {
        return {
          ...shot,
          ...durableImage,
          status: image ? shot.previousStatus ?? '待审核' : '待生成',
          jobId: latest.id,
          generationError: image ? undefined : '图片生成任务已取消',
          previousStatus: image ? shot.previousStatus : undefined,
          isDemo: false,
        }
      }
      return image ? {
        ...shot,
        ...durableImage,
        status: '待审核',
        jobId: latestReady?.id,
        generationError: undefined,
        previousStatus: undefined,
        isDemo: false,
      } : reviewApplies ? {
        ...shot,
        ...durableImage,
        status: '待生成',
        jobId: undefined,
        generationError: undefined,
        previousStatus: undefined,
        isDemo: false,
      } : shot
    }))

    const activeJobs = storyboardJobs.filter((job) => (
      ['queued', 'running', 'waiting_provider'].includes(job.status)
    ))
    const activeIds = new Set(activeJobs.map((job) => job.resourceId).filter((id): id is string => Boolean(id)))
    const activeShotIds = shotsRef.current.filter((shot) => (
      Boolean(shot.storyId && activeIds.has(shot.storyId))
    )).map((shot) => shot.id)
    setGenerating(activeJobs.length > 0)
    setGenerationTargets(activeShotIds)
    setGenerationProgress(activeJobs.length
      ? Math.round(activeJobs.reduce((total, job) => total + job.progress, 0) / activeJobs.length)
      : 100)
  }, [currentStoryJobs, productionContext, shotMediaReviews.storyboard, storyDocument])

  const persistOfflineStoryDraftSnapshot = (
    scope: OfflineStoryDraftScope,
    changes: OfflineStoryDraftChanges,
  ): boolean => {
    const storage = browserOfflineStoryDraftStorage()
    if (!storage) {
      setOfflineStoryDraftPersistenceError('浏览器拒绝访问本地草稿存储，断网保护暂不可用')
      return false
    }
    const result = offlineStoryDraftHasChanges(changes)
      ? saveOfflineStoryDraft(storage, scope, changes)
      : clearOfflineStoryDraft(storage, scope)
    setOfflineStoryDraftPersistenceError(offlineStoryDraftPersistenceMessage(result))
    return result.status === 'saved' || result.status === 'cleared'
  }

  const persistCurrentOfflineStoryDraftNow = () => {
    const current = productionContextRef.current
    const baseSourceRevisionId = offlineStoryDraftBaseRevisionIdRef.current
    const changes = offlineStoryDraftChangesRef.current
    if (!current || !baseSourceRevisionId || !offlineStoryDraftHasChanges(changes)) return
    persistOfflineStoryDraftSnapshot({
      projectId: current.projectId,
      episodeId: current.episode.id,
      baseSourceRevisionId,
    }, changes)
  }

  const applyStoryMutation = (
    result: StoryMutationResponse,
    options: { selectStoryShotId?: string | null; message: string },
    scope: StoryOperationScope,
  ): boolean => {
    const current = productionContextRef.current
    if (!current
      || !storyScopeIsCurrent(scope)
      || result.episode.projectId !== scope.projectId
      || result.episode.id !== scope.episodeId
      || result.episode.sourceRevisionId !== result.revisionId) {
      return false
    }

    const sourceChanged = current.episode.sourceRevisionId !== result.revisionId
    if (sourceChanged) {
      const invalidated = shotsRef.current.map((shot): Shot => shot.storyId ? {
        ...shot,
        status: '待生成',
        assetId: undefined,
        jobId: undefined,
        generationError: '源剧本已修改，该分镜需要重新生成',
      } : shot)
      shotsRef.current = invalidated
      setShots(invalidated)
    }
    const currentSelection = shotsRef.current.find((shot) => shot.id === activeShotRef.current)?.storyId ?? null
    preferredStoryShotRef.current = options.selectStoryShotId === undefined
      ? currentSelection
      : options.selectStoryShotId
    setStoryDocument(result.story)
    const nextContext: ProductionContext = {
      projectId: scope.projectId,
      episode: result.episode,
      episodeEtag: result.etag,
    }
    productionContextRef.current = nextContext
    setProductionContext(nextContext)
    const staleCount = Object.values(result.stale).reduce((total, count) => total + count, 0)
    setToast(staleCount > 0 ? `${options.message}，${staleCount} 项下游产物已标记过期` : options.message)
    if (sourceChanged) void jobsState.refresh()
    return true
  }

  const refreshStoryAfterConflict = async (scope: StoryOperationScope): Promise<string | null> => {
    if (!storyScopeIsCurrent(scope)) throw new Error('当前分集已切换，不能应用旧分集的修订')

    // Story and Episode are read separately. Only publish a pair that proves
    // it represents the same authoritative head, otherwise a concurrent write
    // could leave the client with a Story from A and an ETag from B.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [storyResult, episodeResult] = await Promise.all([
        api.getStory(scope.episodeId, { projectId: scope.projectId }),
        api.getEpisode(scope.episodeId, { projectId: scope.projectId }),
      ])
      if (
        storyResult.revisionId !== episodeResult.episode.sourceRevisionId
        || storyResult.etag !== episodeResult.etag
      ) continue

      const current = productionContextRef.current
      if (!current || !storyScopeIsCurrent(scope)) {
        throw new Error('当前分集已切换，不能应用旧分集的修订')
      }
      if (episodeResult.episode.projectId !== scope.projectId
        || episodeResult.episode.id !== scope.episodeId) {
        throw new Error('服务端返回了其他分集的权威快照')
      }
      const sourceChanged = current.episode.sourceRevisionId !== storyResult.revisionId
      const nextContext: ProductionContext = {
        projectId: scope.projectId,
        episode: episodeResult.episode,
        episodeEtag: episodeResult.etag,
      }
      if (sourceChanged) {
        const invalidated = shotsRef.current.map((shot): Shot => shot.storyId ? {
          ...shot,
          status: '待生成',
          assetId: undefined,
          jobId: undefined,
          generationError: '服务端剧本修订已变化，该分镜需要重新生成',
        } : shot)
        shotsRef.current = invalidated
        setShots(invalidated)
        preferredStoryShotRef.current = invalidated.find(
          (shot) => shot.id === activeShotRef.current,
        )?.storyId ?? null
        setStoryDocument(storyResult.story)
      }
      productionContextRef.current = nextContext
      setProductionContext(nextContext)
      dispatchStoryHistory({
        type: 'authority-refreshed',
        headRevisionId: storyResult.revisionId,
      })
      if (sourceChanged) void jobsState.refresh()
      return storyResult.revisionId
    }
    throw new Error('服务端剧本修订仍在变化，暂时无法取得一致快照')
  }

  const runStoryMutation = async (
    operation: (etag: string) => Promise<StoryMutationResponse>,
    options: {
      selectStoryShotId?: string | null
      selectionBefore?: string | null
      message: string
      offlineDraftAfterCommit?: OfflineStoryDraftChanges
    },
  ): Promise<boolean> => {
    if (storyMutationInFlightRef.current) throw new Error('剧本修订正在保存，请稍候')
    const current = productionContextRef.current
    const beforeRevisionId = current?.episode.sourceRevisionId ?? null
    if (!current || !beforeRevisionId) throw new Error('请先生成真实结构剧本')
    const scope = storyScopeFor(current)
    const selectionBefore = options.selectionBefore === undefined
      ? shotsRef.current.find((shot) => shot.id === activeShotRef.current)?.storyId ?? null
      : options.selectionBefore
    const selectionAfter = options.selectStoryShotId === undefined
      ? selectionBefore
      : options.selectStoryShotId
    const offlineScopeBefore = offlineStoryDraftEditingScopeRef.current

    // Flush the exact old-base envelope before any server mutation can advance
    // authority. Persistence failures remain visible but never block online
    // editing or the authoritative mutation.
    persistCurrentOfflineStoryDraftNow()
    storyMutationInFlightRef.current = true
    setStoryMutationState('saving')
    try {
      const result = await operation(current.episodeEtag)
      if (!applyStoryMutation(result, options, scope)) return false
      if (options.offlineDraftAfterCommit && offlineScopeBefore) {
        const remaining = options.offlineDraftAfterCommit
        const targetError = offlineStoryDraftTargetError(result.story, remaining)
        if (targetError) {
          // The authoritative commit already succeeded. Preserve the old-base
          // envelope for explicit salvage rather than guessing a rebase.
          persistOfflineStoryDraftSnapshot(offlineScopeBefore, remaining)
          setToast(`${options.message}；其余草稿无法安全迁移：${targetError}`)
        } else {
          const nextScope: OfflineStoryDraftScope = {
            projectId: scope.projectId,
            episodeId: scope.episodeId,
            baseSourceRevisionId: result.revisionId,
          }
          // Write the rebased envelope before deleting the old-base rescue
          // copy. A quota/storage failure must never create a data-loss gap.
          const newEnvelopePersisted = persistOfflineStoryDraftSnapshot(nextScope, remaining)
          if (newEnvelopePersisted) {
            persistOfflineStoryDraftSnapshot(offlineScopeBefore, EMPTY_OFFLINE_STORY_DRAFT_CHANGES)
          }
          offlineStoryDraftChangesRef.current = remaining
          adoptOfflineStoryDraftEditingScope(nextScope)
          setOfflineStoryFormDrafts({
            scenes: remaining.scenes,
            dialogueLines: remaining.dialogueLines,
          })
          setShots((currentShots) => applyOfflineShotDrafts(currentShots, remaining.shots))
        }
      }
      dispatchStoryHistory({
        type: 'record-commit',
        beforeRevisionId,
        afterRevisionId: result.revisionId,
        label: options.message,
        selectionBefore,
        selectionAfter,
      })
      return true
    } catch (error) {
      if (!storyScopeIsCurrent(scope)) return false
      if (error instanceof ApiError && error.status === 412) {
        try {
          const refreshedRevisionId = await refreshStoryAfterConflict(scope)
          setToast(refreshedRevisionId === beforeRevisionId
            ? '分集配置已被更新，剧本撤销记录已保留，请再试一次'
            : '剧本已被其他操作更新，已载入最新修订并清空本地撤销记录')
        } catch {
          setToast('剧本修订冲突，且无法读取最新版本')
        }
      } else {
        // A response can be lost after the server commits. Re-read the exact
        // scoped authority before allowing a retry that could duplicate work.
        try {
          const refreshedRevisionId = await refreshStoryAfterConflict(scope)
          if (refreshedRevisionId !== beforeRevisionId) {
            setToast('服务端剧本已变更，已载入权威修订；本次未知结果不会自动重提')
            return false
          }
        } catch {
          // Preserve the original actionable error below.
        }
        setToast(error instanceof Error ? error.message : '剧本修订保存失败')
      }
      throw error
    } finally {
      storyMutationInFlightRef.current = false
      setStoryMutationState('idle')
    }
  }

  const applyCharacterVoiceProfile = (result: CharacterVoiceProfileMutationResponse) => {
    setStoryDocument((current) => current ? {
      ...current,
      characters: current.characters.map((character) => (
        character.id === result.character.id
          ? { ...character, voiceProfile: result.voiceProfile }
          : character
      )),
    } : current)
    const current = productionContextRef.current
    if (current) {
      const nextContext: ProductionContext = {
        projectId: current.projectId,
        episode: { ...current.episode, ...result.episode },
        episodeEtag: result.etag,
      }
      productionContextRef.current = nextContext
      setProductionContext(nextContext)
    }
    const staleCount = Object.values(result.stale).reduce((total, count) => total + count, 0)
    setToast(staleCount > 0
      ? `已保存「${result.character.name}」声线，${staleCount} 项配音/导出产物已标记过期`
      : `已将「${result.character.name}」声线保存到角色档案`)
    void jobsState.refresh()
  }

  const applyProjectNarratorVoiceProfile = (
    result: ProjectNarratorVoiceProfileMutationResponse,
  ) => {
    setProjectNarratorVoice({
      project: result.project,
      voiceProfile: result.voiceProfile,
      revisionId: result.revisionId,
      etag: result.etag,
    })
    setProjectNarratorVoiceState('ready')
    setProjectNarratorVoiceError('')
    const staleCount = Object.values(result.stale).reduce((total, count) => total + count, 0)
    setToast(result.voiceProfile
      ? staleCount > 0
        ? `已保存项目旁白「${result.voiceProfile.voiceName}」，${staleCount} 项旁白/导出产物已标记过期`
        : `已保存项目旁白「${result.voiceProfile.voiceName}」，所有分集将自动继承`
      : staleCount > 0
        ? `已清除项目旁白，${staleCount} 项旁白/导出产物已标记过期`
        : '已清除项目旁白绑定')
    void jobsState.refresh()
  }

  const updateShotDraft = (shotId: number, patch: EditableShotPatch) => {
    setShots((items) => items.map((shot) => shot.id === shotId ? { ...shot, ...patch } : shot))
  }

  const commitSceneEdit = async (sceneId: string, patch: StoryScenePatchInput) => {
    if (!productionContext || !storyDocument) throw new Error('请先生成真实结构剧本')
    const scene = storyDocument.scenes.find((candidate) => candidate.id === sceneId)
    if (!scene) throw new Error('当前剧本修订中不存在该场景')
    const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => (
      typeof value === 'string' && value.trim() && value.trim() !== String(scene[key as keyof typeof scene] ?? '')
    ))) as Partial<StoryScenePatchInput>
    if (Object.keys(changed).length === 0) return
    const remainingDraft = withOfflineSceneDraft(
      offlineStoryDraftChangesRef.current,
      null,
      sceneId,
    )
    await runStoryMutation((etag) => api.updateStoryScene(sceneId, {
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
      patch: changed as StoryScenePatchInput,
      summary: `编辑场景 ${scene.title}`,
    }, etag), {
      message: `场景「${scene.title}」已保存为新修订`,
      offlineDraftAfterCommit: remainingDraft,
    })
  }

  const commitDialogueLine = async (
    sceneId: string,
    shotId: string,
    lineId: string,
    text: string,
  ) => {
    if (!productionContext || !storyDocument) throw new Error('请先生成真实结构剧本')
    const shot = storyDocument.scenes.find((scene) => scene.id === sceneId)
      ?.shots.find((candidate) => candidate.id === shotId)
    if (!shot) throw new Error('当前剧本修订中不存在该镜头')
    const normalized = text.trim()
    if (!normalized) throw new Error('台词不能为空')
    const line = shot.dialogueLines.find((candidate) => candidate.id === lineId)
    if (!line) throw new Error('当前剧本修订中不存在该台词')
    if (line.text === normalized) return
    const remainingDraft = withOfflineDialogueDraft(
      offlineStoryDraftChangesRef.current,
      null,
      { sceneId, shotId, lineId },
    )
    await runStoryMutation((etag) => api.updateStoryShot(shotId, {
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
      sceneId,
      patch: {
        dialogueLines: shot.dialogueLines.map((candidate) => (
          candidate.id === lineId ? { ...candidate, text: normalized } : candidate
        )),
      },
      summary: `编辑镜头 ${shot.code} 台词`,
    }, etag), {
      selectStoryShotId: shotId,
      message: `镜头 ${shot.code} 台词已保存为新修订`,
      offlineDraftAfterCommit: remainingDraft,
    })
  }

  const commitShotEdit = async (shotId: number, editablePatch: EditableShotPatch) => {
    if (!productionContext || !storyDocument) throw new Error('请先生成真实结构剧本')
    const localShot = shotsRef.current.find((shot) => shot.id === shotId)
    if (!localShot?.storyId || !localShot.sceneId) throw new Error('该镜头尚未绑定剧本修订')
    const storyShot = storyDocument.scenes
      .find((scene) => scene.id === localShot.sceneId)
      ?.shots.find((shot) => shot.id === localShot.storyId)
    if (!storyShot) throw new Error('无法在当前剧本修订中定位镜头')

    const patch: Partial<StoryShotPatchInput> = {}
    if (editablePatch.code !== undefined && editablePatch.code.trim() !== storyShot.code) {
      if (!editablePatch.code.trim()) throw new Error('镜头编号不能为空')
      patch.code = editablePatch.code.trim()
    }
    if (editablePatch.title !== undefined && editablePatch.title.trim() !== storyShot.title) {
      if (!editablePatch.title.trim()) throw new Error('镜头标题不能为空')
      patch.title = editablePatch.title.trim()
    }
    if (editablePatch.copy !== undefined && editablePatch.copy.trim() !== storyShot.description) {
      if (!editablePatch.copy.trim()) throw new Error('画面描述不能为空')
      patch.description = editablePatch.copy.trim()
    }
    if (editablePatch.framing !== undefined && editablePatch.framing.trim() !== storyShot.framing) {
      patch.framing = editablePatch.framing.trim()
    }
    if (editablePatch.movement !== undefined && editablePatch.movement.trim() !== storyShot.movement) {
      patch.movement = editablePatch.movement.trim()
    }
    if (editablePatch.transition !== undefined && editablePatch.transition.trim() !== storyShot.transition) {
      patch.transition = editablePatch.transition.trim()
    }
    if (editablePatch.visualPrompt !== undefined
      && editablePatch.visualPrompt.trim() !== storyShot.visualPrompt) {
      if (!editablePatch.visualPrompt.trim()) throw new Error('镜头视觉 Prompt 不能为空')
      patch.visualPrompt = editablePatch.visualPrompt.trim()
    }
    if (editablePatch.duration !== undefined) {
      const durationSeconds = Number.parseFloat(editablePatch.duration)
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0.5 || durationSeconds > 15) {
        throw new Error('镜头时长必须介于 0.5 到 15 秒')
      }
      if (Math.abs(durationSeconds - storyShot.durationSeconds) > 0.0001) {
        patch.durationSeconds = durationSeconds
      }
    }
    if (Object.keys(patch).length === 0) return

    const remainingDraft = withoutOfflineShotDraft(
      offlineStoryDraftChangesRef.current,
      localShot.sceneId,
      localShot.storyId,
    )
    await runStoryMutation((etag) => api.updateStoryShot(
      localShot.storyId!,
      {
        projectId: productionContext.projectId,
        episodeId: productionContext.episode.id,
        sceneId: localShot.sceneId,
        patch: patch as StoryShotPatchInput,
        summary: `编辑镜头 ${storyShot.code}`,
      },
      etag,
    ), {
      selectStoryShotId: localShot.storyId,
      message: `镜头 ${storyShot.code} 已保存为新修订`,
      offlineDraftAfterCommit: remainingDraft,
    })
  }

  const addShot = async () => {
    if (hasStoryDraft) {
      setToast('请先保存或取消当前文本编辑，再新增镜头')
      return
    }
    if (!productionContext || !storyDocument) {
      setToast('请先在剧本阶段生成结构剧本')
      return
    }
    const shotCount = storyDocument.scenes.reduce((total, scene) => total + scene.shots.length, 0)
    if (shotCount >= 12) {
      setToast('MVP 每集最多 12 个镜头')
      return
    }
    const currentStoryShot = selectedShot?.storyId
      ? storyDocument.scenes.flatMap((scene) => scene.shots.map((shot) => ({ scene, shot })))
        .find(({ shot }) => shot.id === selectedShot.storyId)
      : null
    const scene = currentStoryShot?.scene ?? storyDocument.scenes[0]
    if (!scene) return
    const totalDuration = storyDocument.scenes.flatMap((item) => item.shots)
      .reduce((total, shot) => total + shot.durationSeconds, 0)
    const durationSeconds = Math.min(3, 60 - totalDuration)
    if (durationSeconds < 0.5) {
      setToast('当前剧本已达 60 秒上限，请先缩短其他镜头')
      return
    }
    const storyShotId = `shot-${crypto.randomUUID()}`
    const nextNumber = scene.shots.length + 1
    const code = `S${String(scene.sequence + 1).padStart(2, '0')}-${String(nextNumber).padStart(2, '0')}`
    await runStoryMutation((etag) => api.createStoryShot({
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
      sceneId: scene.id,
      index: currentStoryShot ? currentStoryShot.shot.sequence + 1 : undefined,
      summary: `新增镜头 ${code}`,
      shot: {
        id: storyShotId,
        code,
        title: `新镜头 ${nextNumber}`,
        description: '请在右侧属性面板中完善画面、动作与情绪。',
        framing: '中景',
        movement: '静止',
        transition: '硬切',
        durationSeconds,
        visualPrompt: '中景，静止构图，待完善的专业漫剧分镜。',
        dialogueLines: [],
      },
    }, etag), {
      selectStoryShotId: storyShotId,
      message: `已新增真实镜头 ${code}`,
    }).catch(() => undefined)
  }

  const deleteShot = async (shotId: number) => {
    if (hasStoryDraft) {
      setToast('请先保存或取消当前文本编辑，再删除镜头')
      return
    }
    if (!productionContext || !storyDocument) return
    const localShot = shotsRef.current.find((shot) => shot.id === shotId)
    if (!localShot?.storyId || !localShot.sceneId) return
    const allStoryShots = storyDocument.scenes.flatMap((scene) => scene.shots)
    const storyShot = allStoryShots.find((shot) => shot.id === localShot.storyId)
    if (!storyShot) return
    if (allStoryShots.length <= 6) {
      setToast('MVP 剧本至少需要 6 个镜头')
      return
    }
    const remainingDuration = allStoryShots.reduce((total, shot) => total + shot.durationSeconds, 0)
      - storyShot.durationSeconds
    if (remainingDuration < 30) {
      setToast('删除后总时长会低于 30 秒，请先延长其他镜头')
      return
    }
    const scene = storyDocument.scenes.find((candidate) => candidate.id === localShot.sceneId)
    const siblingIds = scene?.shots.map((shot) => shot.id) ?? []
    const currentIndex = siblingIds.indexOf(localShot.storyId)
    const nextSelection = siblingIds[currentIndex + 1] ?? siblingIds[currentIndex - 1]
      ?? storyDocument.scenes.flatMap((candidate) => candidate.shots).find((shot) => shot.id !== localShot.storyId)?.id
    await runStoryMutation((etag) => api.deleteStoryShot(localShot.storyId!, {
      projectId: productionContext.projectId,
      episodeId: productionContext.episode.id,
      sceneId: localShot.sceneId,
      summary: `删除镜头 ${storyShot.code}`,
    }, etag), {
      selectStoryShotId: nextSelection,
      selectionBefore: localShot.storyId,
      message: `已删除镜头 ${storyShot.code}`,
    }).catch(() => undefined)
  }

  const moveShot = (shotId: number, delta: -1 | 1) => {
    if (hasStoryDraft) {
      setToast('请先保存或取消当前文本编辑，再调整镜头顺序')
      return
    }
    if (!productionContext || !storyDocument) return
    const sourceRevisionId = productionContext.episode.sourceRevisionId
    if (!sourceRevisionId) {
      setToast('当前剧本尚未固化修订，无法调整镜头顺序')
      return
    }
    const localShot = shotsRef.current.find((shot) => shot.id === shotId)
    if (!localShot?.storyId || !localShot.sceneId) return
    const scene = storyDocument.scenes.find((candidate) => candidate.id === localShot.sceneId)
    if (!scene) return
    const shotIds = scene.shots.map((shot) => shot.id)
    const index = shotIds.indexOf(localShot.storyId)
    const target = index + delta
    if (index < 0 || target < 0 || target >= shotIds.length) return
    const decision = scriptShotReorderConfirmation({
      code: localShot.code,
      currentIndex: index,
      targetIndex: target,
      sceneShotCount: shotIds.length,
    })
    const reorderedShotIds = [...shotIds]
    ;[reorderedShotIds[index], reorderedShotIds[target]] = [
      reorderedShotIds[target]!,
      reorderedShotIds[index]!,
    ]
    setShotReorderRequest({
      shotId,
      storyShotId: localShot.storyId,
      sceneId: scene.id,
      sourceRevisionId,
      expectedShotIds: Object.freeze([...shotIds]),
      reorderedShotIds: Object.freeze(reorderedShotIds),
      decision,
    })
  }

  const confirmShotReorder = async () => {
    const request = shotReorderRequest
    const context = productionContextRef.current
    const currentStory = storyDocument
    if (!request || !context || !currentStory || storyMutationInFlightRef.current) return
    const currentScene = currentStory.scenes.find((scene) => scene.id === request.sceneId)
    const currentShotIds = currentScene?.shots.map((shot) => shot.id) ?? []
    if (context.episode.sourceRevisionId !== request.sourceRevisionId
      || currentShotIds.length !== request.expectedShotIds.length
      || currentShotIds.some((shotId, index) => shotId !== request.expectedShotIds[index])) {
      setShotReorderRequest(null)
      setToast('剧本修订或镜头顺序已变化，本次排序确认已失效，请重新操作')
      return
    }
    const applied = await runStoryMutation((etag) => api.reorderStoryShots({
      projectId: context.projectId,
      episodeId: context.episode.id,
      sceneId: request.sceneId,
      shotIds: [...request.reorderedShotIds],
      summary: request.decision.summary,
    }, etag), {
      selectStoryShotId: request.storyShotId,
      message: request.decision.message,
    }).catch(() => false)
    if (applied) setShotReorderRequest(null)
  }

  const storyHistoryMatchesHead = Boolean(
    storyDocument
    && productionContext?.episode.sourceRevisionId
    && storyRevisionHistory.headRevisionId === productionContext.episode.sourceRevisionId,
  )
  const storyUndoCommand = storyRevisionNavigationCommand(storyRevisionHistory, 'undo')
  const storyRedoCommand = storyRevisionNavigationCommand(storyRevisionHistory, 'redo')
  const storyNavigationBusy = storyMutationState === 'saving'
    || storyRevisionHistory.pending !== null
    || storyState === 'generating'
  const canUndoStoryRevision = storyHistoryMatchesHead
    && storyUndoCommand !== null
    && !hasStoryDraft
    && !storyNavigationBusy
  const canRedoStoryRevision = storyHistoryMatchesHead
    && storyRedoCommand !== null
    && !hasStoryDraft
    && !storyNavigationBusy

  const storyNavigationTitle = (direction: 'undo' | 'redo'): string => {
    if (!storyDocument) return '请先生成结构剧本'
    if (hasStoryDraft) return '请先保存或取消当前编辑'
    if (storyNavigationBusy) return '剧本修订正在处理'
    if (!storyHistoryMatchesHead) return '剧本已更新，撤销记录需要重新建立'
    const command = direction === 'undo' ? storyUndoCommand : storyRedoCommand
    if (!command) return direction === 'undo'
      ? '本次会话暂无可撤销的剧本修订'
      : '本次会话暂无可重做的剧本修订'
    return `${direction === 'undo' ? '撤销' : '重做'}：${command.label}`
  }

  const navigateStoryRevision = async (direction: 'undo' | 'redo') => {
    if (storyMutationInFlightRef.current || hasStoryDraft) return
    const current = productionContextRef.current
    const history = storyRevisionHistoryRef.current
    const currentRevisionId = current?.episode.sourceRevisionId ?? null
    if (!current || !currentRevisionId || history.headRevisionId !== currentRevisionId) {
      setToast('剧本修订状态已变化，请刷新后再试')
      return
    }
    const scope = storyScopeFor(current)
    const command = storyRevisionNavigationCommand(history, direction)
    if (!command) return
    const targetRevisionId = storyRevisionNavigationTarget(command, direction)
    const targetSelection = direction === 'undo'
      ? command.selectionBefore
      : command.selectionAfter

    storyMutationInFlightRef.current = true
    setStoryMutationState('saving')
    dispatchStoryHistory({ type: 'begin-navigation', direction })
    try {
      const result = await api.restoreStoryRevision(
        current.episode.id,
        targetRevisionId,
        {
          projectId: current.projectId,
          summary: `${direction === 'undo' ? '撤销' : '重做'}：${command.label}`,
        },
        current.episodeEtag,
      )
      if (!applyStoryMutation(result, {
        selectStoryShotId: targetSelection,
        message: `${direction === 'undo' ? '已撤销' : '已重做'}：${command.label}`,
      }, scope)) return
      // Restoring an immutable snapshot always creates another immutable
      // revision. That new revision, never the historical target, is the head.
      dispatchStoryHistory({
        type: 'complete-navigation',
        direction,
        headRevisionId: result.revisionId,
      })
      void jobsState.refresh()
    } catch (error) {
      if (!storyScopeIsCurrent(scope)) return
      if (error instanceof ApiError && error.status === 412) {
        try {
          const refreshedRevisionId = await refreshStoryAfterConflict(scope)
          setToast(refreshedRevisionId === currentRevisionId
            ? '分集配置已被更新，剧本撤销记录已保留，请再试一次'
            : '剧本已被其他操作更新，已载入最新修订并清空本地撤销记录')
        } catch {
          dispatchStoryHistory({ type: 'abort-navigation' })
          setToast('剧本修订冲突，且无法读取最新版本')
        }
      } else {
        // A restore response can be lost after the server committed it. Read
        // authority before offering the command again so we never replay it
        // against an unknown head.
        try {
          const refreshedRevisionId = await refreshStoryAfterConflict(scope)
          setToast(refreshedRevisionId === currentRevisionId
            ? (error instanceof Error ? error.message : '剧本撤销/重做失败')
            : '服务端剧本已变更，已载入权威修订并重置本地撤销记录')
        } catch {
          dispatchStoryHistory({ type: 'abort-navigation' })
          setToast(error instanceof Error ? error.message : '剧本撤销/重做失败')
        }
      }
    } finally {
      storyMutationInFlightRef.current = false
      setStoryMutationState('idle')
    }
  }

  useEffect(() => {
    const handleStoryHistoryShortcut = (event: KeyboardEvent) => {
      if (currentStage !== 'script' && currentStage !== 'storyboard') return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || isEditableKeyboardTarget(event.target)) return
      if (event.target instanceof Element
        && event.target.closest('[role="dialog"], .opencut-controller-timeline')) return
      const key = event.key.toLowerCase()
      const direction = key === 'z'
        ? (event.shiftKey ? 'redo' : 'undo')
        : key === 'y'
          ? 'redo'
          : null
      if (!direction) return
      if (direction === 'undo' ? !canUndoStoryRevision : !canRedoStoryRevision) return
      event.preventDefault()
      void navigateStoryRevision(direction)
    }
    window.addEventListener('keydown', handleStoryHistoryShortcut)
    return () => window.removeEventListener('keydown', handleStoryHistoryShortcut)
  }, [canRedoStoryRevision, canUndoStoryRevision, currentStage, hasStoryDraft, navigateStoryRevision])

  const attachUserAudioToTimeline = async (asset: UserAudioAsset) => {
    if (!productionContext) throw new Error('真实制作工程尚未初始化')
    const handle = timelinePersistenceRef.current
    if (!handle
      || handle.projectId !== productionContext.projectId
      || handle.episodeId !== productionContext.episode.id) {
      throw new Error('OpenCut 时间线仍在载入，请稍后点击“加入时间线”')
    }
    await handle.addUploadedAudio({
      assetId: asset.id,
      kind: asset.kind,
      displayName: asset.originalFileName?.trim()
        || `${asset.kind === 'bgm' ? '背景配乐' : '音效'} ${asset.id.slice(0, 8)}`,
      durationSeconds: asset.durationSeconds,
    })
    setToast(`${asset.kind === 'bgm' ? '背景配乐' : '音效'}已写入 OpenCut 时间线修订`)
  }

  const addSubtitleToTimeline = async (input: {
    attachmentId: string
    text: string
    durationSeconds: number
  }) => {
    if (!productionContext) throw new Error('真实制作工程尚未初始化')
    const handle = timelinePersistenceRef.current
    if (!handle
      || handle.projectId !== productionContext.projectId
      || handle.episodeId !== productionContext.episode.id) {
      throw new Error('OpenCut 时间线仍在载入，请稍后重试')
    }
    await handle.addSubtitle(input)
    setToast('字幕已写入 OpenCut 时间线修订')
  }

  const readManagedSubtitleCueSet = (
    input: TimelineManagedSubtitleCueSetReadInput,
  ): ManagedSubtitleCueSetSnapshot | null => {
    if (!productionContext) throw new Error('真实制作工程尚未初始化')
    const handle = timelinePersistenceRef.current
    if (!handle
      || handle.projectId !== productionContext.projectId
      || handle.episodeId !== productionContext.episode.id) {
      throw new Error('OpenCut 时间线仍在载入，请稍后重试')
    }
    return handle.readManagedSubtitleCueSet(input)
  }

  const replaceManagedSubtitleCueSet = async (
    input: TimelineManagedSubtitleCueSetReplaceInput,
  ): Promise<ManagedSubtitleCueSetSnapshot> => {
    if (!productionContext) throw new Error('真实制作工程尚未初始化')
    const handle = timelinePersistenceRef.current
    if (!handle
      || handle.projectId !== productionContext.projectId
      || handle.episodeId !== productionContext.episode.id) {
      throw new Error('OpenCut 时间线仍在载入，请稍后重试')
    }
    const snapshot = await handle.replaceManagedSubtitleCueSet(input)
    setToast(`${snapshot.cues.length} 条字幕已原子写入 OpenCut 时间线修订`)
    return snapshot
  }

  const openWithPinnedTimeline = async (consumer: 'preview' | 'export') => {
    if (!productionContext) return
    if (shotMediaTimelineState === 'required'
      || shotMediaTimelineState === 'reconciling'
      || shotMediaTimelineState === 'error') {
      setToast('镜头选版尚未安全重新对账 OpenCut；预览和导出已阻断，请在审片卡点击刷新重试')
      return
    }
    try {
      const handle = timelinePersistenceRef.current
      let snapshot: TimelineDocumentSnapshot
      if (handle
        && handle.projectId === productionContext.projectId
        && handle.episodeId === productionContext.episode.id) {
        // First preserve local OpenCut commands, then reconcile authoritative
        // Shot media. Another tab can change media without advancing timeline ETag.
        await handle.flush()
        try {
          snapshot = await handle.reconcileCurrentMedia()
        } catch (error) {
          setShotMediaTimelineState('error')
          setShotMediaTimelineMessage(`预览/导出前权威素材对账失败：${error instanceof Error ? error.message : '未知错误'}。已阻断旧媒体输出。`)
          throw error
        }
      } else {
        snapshot = await preparePinnedTimeline({
            projectId: productionContext.projectId,
            episodeId: productionContext.episode.id,
            sourceRevisionId: productionContext.episode.sourceRevisionId,
          }, {
            get: (episodeId, signal) => api.getTimelineDocument(episodeId, { signal }),
            materialize: (episodeId, projectId, signal) => api.materializeTimelineDocument(
              episodeId,
              { projectId, summary: '预览/导出前创建 OpenCut 时间线' },
              { signal },
            ),
            reconcile: (episodeId, projectId, etag, signal) => api.reconcileTimelineDocument(
              episodeId,
              { projectId, summary: '预览/导出前对账 OpenCut 时间线' },
              etag,
              { signal },
            ),
          })
      }
      const pinned = assertPinnedTimeline(snapshot, {
        projectId: productionContext.projectId,
        episodeId: productionContext.episode.id,
        sourceRevisionId: productionContext.episode.sourceRevisionId,
      })
      setPinnedTimeline(pinned)
      if (consumer === 'preview') setShowPreview(true)
      else setShowExport(true)
    } catch (error) {
      setToast(error instanceof Error ? error.message : '无法固化当前时间线修订')
    }
  }

  const requestShotGeneration = (shotId: number) => {
    const shot = shotsRef.current.find((item) => item.id === shotId)
    if (!shot || shot.status === '生成中') return
    if (shot.status !== '失败' && Boolean(shot.assetId || shot.imageUrl)) {
      setRegenerateShotId(shotId)
      return
    }
    void retryShotGeneration(shotId)
  }

  const offlineStoryDraftRecoveryTargetError = useMemo(() => (
    offlineStoryDraftRecovery && storyDocument
      ? offlineStoryDraftTargetError(storyDocument, offlineStoryDraftRecovery.drafts)
      : null
  ), [offlineStoryDraftRecovery, storyDocument])

  const finishOfflineStoryDraftRecovery = (
    draft: OfflineStoryDraft,
    options: { resetCurrentDraft: boolean; message: string },
  ) => {
    const storage = browserOfflineStoryDraftStorage()
    const result = storage
      ? clearOfflineStoryDraft(storage, draft.scope)
      : { status: 'unavailable' as const, key: offlineStoryDraftStorageKey(draft.scope) }
    setOfflineStoryDraftPersistenceError(offlineStoryDraftPersistenceMessage(result))
    if (options.resetCurrentDraft && storyDocument) {
      setOfflineStoryFormDrafts(emptyOfflineStoryFormDrafts())
      const resetShots = discardOfflineShotDrafts(shotsRef.current, storyDocument)
      shotsRef.current = resetShots
      setShots(resetShots)
    }
    setOfflineStoryDraftRecovery(null)
    setOfflineStoryDraftRecoveryError('')
    setOfflineStoryDraftResolvedKey(offlineStoryDraftCurrentKey)
    setToast(options.message)
  }

  const restoreOfflineStoryDraft = () => {
    if (!offlineStoryDraftRecovery || !storyDocument || !offlineStoryDraftScope) return
    const decision = decideOfflineStoryDraftRecovery(
      offlineStoryDraftRecovery,
      offlineStoryDraftScope.baseSourceRevisionId,
    )
    const targetError = offlineStoryDraftTargetError(storyDocument, offlineStoryDraftRecovery.drafts)
    if (decision.kind !== 'restore-same-base' || targetError) {
      setOfflineStoryDraftRecoveryError(targetError ?? '服务器剧本修订已经变化，不能恢复该草稿')
      return
    }
    setOfflineStoryFormDrafts({
      scenes: decision.draft.drafts.scenes,
      dialogueLines: decision.draft.drafts.dialogueLines,
    })
    const restoredShots = applyOfflineShotDrafts(shotsRef.current, decision.draft.drafts.shots)
    shotsRef.current = restoredShots
    setShots(restoredShots)
    adoptOfflineStoryDraftEditingScope(decision.draft.scope)
    setOfflineStoryDraftRecovery(null)
    setOfflineStoryDraftRecoveryError('')
    setOfflineStoryDraftResolvedKey(offlineStoryDraftCurrentKey)
    setCurrentStage(decision.draft.drafts.scenes.length > 0 || decision.draft.drafts.dialogueLines.length > 0
      ? 'script'
      : 'storyboard')
    setActiveRail('production')
    setToast('本地草稿已恢复到编辑器，尚未提交服务器')
  }

  const discardRecoveredOfflineStoryDraft = () => {
    if (!offlineStoryDraftRecovery || !offlineStoryDraftScope) return
    const sameCurrentScope = offlineStoryDraftRecovery.scope.baseSourceRevisionId
      === offlineStoryDraftScope.baseSourceRevisionId
    finishOfflineStoryDraftRecovery(offlineStoryDraftRecovery, {
      resetCurrentDraft: sameCurrentScope,
      message: sameCurrentScope ? '本地草稿已丢弃，已保留服务器版本' : '旧修订草稿已丢弃',
    })
  }

  const copyRecoveredOfflineStoryDraftAsText = async () => {
    if (!offlineStoryDraftRecovery || !offlineStoryDraftScope) return
    setOfflineStoryDraftRecoveryBusy(true)
    setOfflineStoryDraftRecoveryError('')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不允许写入剪贴板')
      await navigator.clipboard.writeText(offlineStoryDraftAsText(offlineStoryDraftRecovery))
      const sameCurrentScope = offlineStoryDraftRecovery.scope.baseSourceRevisionId
        === offlineStoryDraftScope.baseSourceRevisionId
      finishOfflineStoryDraftRecovery(offlineStoryDraftRecovery, {
        resetCurrentDraft: sameCurrentScope,
        message: '旧草稿已复制为救援文本；编辑器继续使用服务器当前版本',
      })
    } catch (error) {
      setOfflineStoryDraftRecoveryError(error instanceof Error ? error.message : '无法复制救援文本')
    } finally {
      setOfflineStoryDraftRecoveryBusy(false)
    }
  }

  const regenerateShot = regenerateShotId === null
    ? null
    : shots.find((shot) => shot.id === regenerateShotId) ?? null
  const catalogProject = catalogProjects.find((project) => project.id === catalogProjectId) ?? null
  const catalogEpisodes = catalogProjectId ? catalogEpisodesByProject[catalogProjectId] ?? [] : []
  const activeProductionProject = catalogProjects.find((project) => (
    project.id === productionContext?.projectId
  )) ?? null
  const catalogEpisodeLabels = Object.fromEntries(
    catalogEpisodes.map((episode) => [episode.id, episode.title]),
  )
  const globalCatalogRoute = isCatalogWorkspaceRoute(currentStage)

  return (
    <div className="app-shell">
      <Rail
        active={activeRail}
        onSelect={(id, label) => {
          const targetStage = id === 'production'
            ? (isProductionStageRoute(currentStage) ? currentStage : 'source')
            : id === 'projects'
              ? 'catalog-source'
              : id === 'characters' || id === 'library'
                ? 'catalog-assets'
                : null
          if (targetStage) {
            setActiveRail(id)
            setCurrentStage(targetStage)
          } else if (id === 'settings') {
            setActiveRail(id)
            setShowProviders(true)
          }
          else if (id === 'history') {
            if (hasStoryDraft) setToast('请先保存或取消当前剧本编辑，再打开版本记录')
            else {
              setActiveRail(id)
              setShowHistory(true)
            }
          }
          else {
            setActiveRail(id)
            setToast(`${label}模块尚未接入`)
          }
        }}
      />

      <div className="app-main">
        <TopBar
          projectTitle={activeProductionProject?.title ?? storyDocument?.title ?? '未命名项目'}
          episodeTitle={productionContext?.episode.title ?? '正在读取分集'}
          projects={catalogProjects}
          episodesByProject={catalogEpisodesByProject}
          activeProjectId={productionContext?.projectId ?? null}
          activeEpisodeId={productionContext?.episode.id ?? null}
          recentEpisodes={projectSwitcherMemory.recentEpisodes}
          catalogLoading={catalogState === 'loading'}
          catalogError={catalogError}
          switchingEpisodeId={productionSwitchingEpisodeId}
          switchBlockedReason={productionSwitchBlockedReason}
          onSwitchEpisode={openCatalogEpisodeInProduction}
          onOpenCatalog={(projectId) => {
            if (projectId) selectCatalogProject(projectId)
            setActiveRail('projects')
            setCurrentStage('catalog-source')
          }}
          onRefreshCatalog={() => void refreshCatalog({
            preferredProjectId: productionContext?.projectId ?? catalogProjectId,
            preferredEpisodeId: productionContext?.episode.id ?? catalogEpisodeId,
          })}
          health={health}
          healthError={healthError}
          imageProvider={defaultImageProvider}
          imageProviderExecutable={executableImageProvider !== null}
          saveState={saveState}
          activeTaskCount={jobsState.activeCount}
          previewAvailable={productionContext !== null}
          onCommand={() => setShowCommand(true)}
          onProviders={() => setShowProviders(true)}
          onTasks={() => setShowTasks(true)}
          onExport={() => void openWithPinnedTimeline('export')}
          onPreview={() => void openWithPinnedTimeline('preview')}
        />

        <main
          ref={workspaceRef}
          className={`workspace ${activeLayoutResize ? `layout-resizing-${activeLayoutResize}` : ''}`}
        >
          {globalCatalogRoute ? (
            <ProjectLibraryHeader
              kind={currentStage === 'catalog-source' ? 'source' : 'assets'}
              projectTitle={catalogProject?.title ?? '请选择项目'}
              sourceRevisionId={catalogProject?.currentRevisionId ?? null}
              projectCount={catalogProjects.length}
              episodeCount={catalogEpisodes.length}
            />
          ) : (
            <ProjectHeader
              currentStage={currentStage}
              episodeTitle={productionContext?.episode.title ?? '当前分集'}
              stageStatuses={pipelineStageStatuses}
              shots={shots}
              primaryTurnaroundReferenceCount={primaryTurnaroundReferenceCount}
              onStageChange={changeStage}
            />
          )}
          <OfflineStoryDraftPersistenceNotice message={offlineStoryDraftPersistenceError} />
          {hasStoryDraft && !offlineStoryDraftPersistenceError && (
            <div className="offline-story-draft-active" role="status">
              <Cloud size={14} />
              <span>本地草稿保护中 · 仅保存当前项目、分集与剧本基线上的可编辑文本，不包含 Provider 或密钥</span>
            </div>
          )}

          <div
            ref={editorLayoutRef}
            className={`editor-layout ${globalCatalogRoute || !isInspectorOpen ? 'inspector-collapsed' : ''} ${globalCatalogRoute ? 'catalog-editor-layout' : ''}`}
            style={{ '--inspector-width': `${editorLayoutPreferences.inspectorWidthPx}px` } as CSSProperties}
          >
            <section className="editor-canvas">
              {globalCatalogRoute && (
                <div className="global-catalog-workspace">
                  <CatalogNavigator
                    projects={catalogProjects}
                    episodesByProject={catalogEpisodesByProject}
                    selectedProjectId={catalogProjectId}
                    selectedEpisodeId={catalogEpisodeId}
                    mode={currentStage === 'catalog-source' ? 'knowledge' : 'assets'}
                    loading={catalogState === 'loading'}
                    error={catalogError}
                    onSelectProject={selectCatalogProject}
                    onSelectEpisode={selectCatalogEpisode}
                    onOpenProduction={(projectId, episodeId) => void openCatalogEpisodeInProduction(projectId, episodeId)}
                    onCreateProject={createCatalogProject}
                    onCreateEpisode={createCatalogEpisode}
                  />
                  <div className="global-catalog-content">
                    {!catalogProject ? (
                      <div className="catalog-content-empty"><Library size={30} /><strong>请选择或新建项目</strong><span>Catalog 会在这里统一管理项目原著、剧集与数字资产。</span></div>
                    ) : currentStage === 'catalog-source' ? (
                      <ProjectKnowledgeCenter
                        projectId={catalogProject.id}
                        projectTitle={catalogProject.title}
                        onSaved={(snapshot) => {
                          setCatalogProjects((current) => current.map((project) => (
                            project.id === snapshot.project.id ? snapshot.project : project
                          )))
                          setToast('项目知识库已保存为新的不可变修订')
                        }}
                      />
                    ) : (
                      <ProjectAssetVersionLibrary
                        projectId={catalogProject.id}
                        episodeId={catalogEpisodeId}
                        episodeLabelsById={catalogEpisodeLabels}
                        pinnedAssetVersionIds={catalogProject.id === productionContext?.projectId
                          ? productionPinnedAssetVersionIds
                          : []}
                        onChanged={async () => {
                          if (catalogProject.id === productionContext?.projectId) await refreshVisualAssetWorkbench()
                          setToast('素材库默认版本已切换；所有剧集已经固定的版本保持不变')
                        }}
                        onError={setToast}
                      />
                    )}
                  </div>
                </div>
              )}
              {currentStage === 'source' && (
                <SourceStage
                  value={sourceText}
                  onChange={changeSourceText}
                  onNext={() => changeStage(nextProductionStageRoute('source') ?? 'assets')}
                  targetDurationSeconds={targetDurationSeconds}
                  onTargetDurationChange={changeTargetDuration}
                  storyState={storyState}
                  storyProgress={storyGenerationJob?.progress ?? 0}
                  storyError={storyError}
                  generationPreparing={storyGenerationPreparing}
                  hasStory={storyDocument !== null}
                  onGenerate={() => void startStoryGeneration()}
                  onConfigureProvider={() => setShowProviders(true)}
                />
              )}
              {currentStage === 'script' && (
                <ScriptStage
                  story={storyDocument}
                  shots={shots}
                  activeShot={activeShot}
                  state={storyState}
                  error={storyError}
                  generationPreparing={storyGenerationPreparing}
                  onGenerate={() => void startStoryGeneration()}
                  onNext={() => changeStage(nextProductionStageRoute('script') ?? 'audio')}
                  mutationBusy={storyMutationState === 'saving'}
                  hasUncommittedDraft={hasStoryDraft}
                  onSaveScene={commitSceneEdit}
                  onSaveDialogue={commitDialogueLine}
                  onSelectShot={setActiveShot}
                  onUpdateShot={updateShotDraft}
                  onSaveShot={commitShotEdit}
                  onAddShot={() => void addShot()}
                  onDeleteShot={(id) => void deleteShot(id)}
                  onMoveShot={(id, delta) => void moveShot(id, delta)}
                  canUndo={canUndoStoryRevision}
                  canRedo={canRedoStoryRevision}
                  undoTitle={storyNavigationTitle('undo')}
                  redoTitle={storyNavigationTitle('redo')}
                  onUndo={() => void navigateStoryRevision('undo')}
                  onRedo={() => void navigateStoryRevision('redo')}
                  offlineDrafts={offlineStoryFormDrafts}
                  focusedEntity={storyEntityFocus}
                  onSceneDraftChange={reportOfflineSceneDraft}
                  onDialogueDraftChange={reportOfflineDialogueDraft}
                />
              )}
              {currentStage === 'assets' && (
                <div className="project-assets-workspace">
                  <AssetsStage
                    story={storyDocument}
                    targets={visualAssetTargets}
                    assets={visualAssetLibrary}
                    jobs={visualAssetHistoryJobs}
                    sourceRevisionId={productionContext?.episode.sourceRevisionId ?? null}
                    voiceScope={productionContext && productionContext.episode.sourceRevisionId ? {
                      projectId: productionContext.projectId,
                      episodeId: productionContext.episode.id,
                      episodeEtag: productionContext.episodeEtag,
                      sourceRevisionId: productionContext.episode.sourceRevisionId,
                    } : null}
                    focusedCharacterId={voiceCharacterFocusId}
                    focusedTarget={assetEntityFocus}
                    imageProvider={executableImageProvider}
                    miniMaxProvider={executableSpeechProvider}
                    textProvider={executableTextProvider}
                    narratorVoiceProfile={projectNarratorVoice}
                    narratorVoiceState={projectNarratorVoiceState}
                    narratorVoiceError={projectNarratorVoiceError}
                    state={visualAssetState}
                    error={visualAssetError}
                    actionKey={visualAssetActionKey ?? (assetImagePreparing ? 'paid-preflight' : null)}
                    editCompletionVersion={visualAssetEditCompletionVersion}
                    paidConfirmationActive={assetImageConfirmation !== null}
                    onGenerate={(target) => void generateVisualAsset(target)}
                    onEdit={editVisualAsset}
                    onDeriveTurnaround={deriveCharacterTurnaround}
                    onLockTurnaround={lockCharacterTurnaroundReferences}
                    onRetry={(target, job) => void retryVisualAsset(target, job)}
                    onLock={(target, assetId) => void lockVisualAsset(target, assetId)}
                    onAdoptHistorical={(target, asset) => adoptHistoricalVisualAsset(target, asset)}
                    onRefresh={() => void refreshVisualAssetWorkbench()}
                    onConfigureProvider={() => setShowProviders(true)}
                    onVoiceProfileSaved={applyCharacterVoiceProfile}
                    onNarratorVoiceReload={() => setProjectNarratorVoiceReloadIndex((value) => value + 1)}
                    onNarratorVoiceSaved={applyProjectNarratorVoiceProfile}
                    onNext={() => changeStage(nextProductionStageRoute('assets') ?? 'script')}
                  />
                </div>
              )}
              {currentStage === 'storyboard' && (
                <StoryboardStage
                  shots={shots}
                  scene={storyDocument?.scenes[0] ?? null}
                  sceneCount={storyDocument?.scenes.length ?? 0}
                  primaryCharacterName={primaryCharacter?.name ?? null}
                  characterReferencesMissing={storyboardCharacterReferencesMissing}
                  primaryTurnaroundReferenceCount={primaryTurnaroundReferenceCount}
                  onConfigureCharacterReferences={openPrimaryCharacterReferenceSetup}
                  onUseTextOnly={useTextOnlyStoryboards}
                  activeShot={activeShot}
                  focusRequestId={storyEntityFocus?.type === 'shot' ? storyEntityFocus.focusRequestId : 0}
                  onSelectShot={setActiveShot}
                  onAddShot={() => void addShot()}
                  canAddShot={Boolean(storyDocument) && shots.length < 12 && storyMutationState !== 'saving'}
                  onRetryShot={(shotId) => void retryShotGeneration(shotId)}
                  onGenerateShot={requestShotGeneration}
                  onCancelShot={(shotId) => void cancelShotGeneration(shotId)}
                  cancellingShotIds={cancellingShotIds}
                  onGenerateMissing={(targetIds) => void startGeneration(targetIds)}
                  onRegenerateAll={(targetIds) => void startGeneration(targetIds)}
                  canUndo={canUndoStoryRevision}
                  canRedo={canRedoStoryRevision}
                  undoTitle={storyNavigationTitle('undo')}
                  redoTitle={storyNavigationTitle('redo')}
                  onUndo={() => void navigateStoryRevision('undo')}
                  onRedo={() => void navigateStoryRevision('redo')}
                  goldenScope={productionContext?.episode.sourceRevisionId ? {
                    episodeId: productionContext.episode.id,
                    sourceRevisionId: productionContext.episode.sourceRevisionId,
                    jobs: episodeJobs,
                    shots: shotVideoBatchShots,
                    configured: seedanceConfigured,
                    currentProvider: seedanceConfigured && seedanceProvider ? {
                      providerId: seedanceProvider.id,
                      model: seedanceProvider.model,
                      configRevision: seedanceProvider.configRevision,
                    } : null,
                  } : null}
                  onOpenGoldenBaseline={() => {
                    setShotVideoBatchPreset('golden-baseline')
                    setShowShotVideoBatch(true)
                  }}
                  onOpenGoldenCandidate={() => {
                    setShotVideoBatchPreset('golden-candidate')
                    setShowShotVideoBatch(true)
                  }}
                  onConfigureVideoProvider={() => setShowProviders(true)}
                  onNext={() => changeStage(nextProductionStageRoute('storyboard') ?? 'export')}
                />
              )}
              {currentStage === 'audio' && (
                <AudioStage
                  story={storyDocument}
                  jobs={episodeJobs}
                  productionScope={productionContext ? {
                    projectId: productionContext.projectId,
                    episodeId: productionContext.episode.id,
                    sourceRevisionId: productionContext.episode.sourceRevisionId,
                  } : null}
                  timelineReady={timelineEditorReady}
                  onAttachUserAudio={attachUserAudioToTimeline}
                  onAddSubtitle={addSubtitleToTimeline}
                  onReadManagedSubtitleCueSet={readManagedSubtitleCueSet}
                  onReplaceManagedSubtitleCueSet={replaceManagedSubtitleCueSet}
                  onGenerate={generateDialogueSpeech}
                  speechProvider={executableSpeechProvider}
                  miniMaxProvider={executableSpeechProvider}
                  textProvider={executableTextProvider}
                  narratorVoiceProfile={projectNarratorVoice?.voiceProfile ?? null}
                  timingRemediation={shotVideoTimingRemediation}
                  focusTarget={shotVideoTimingRemediation
                    ? shotVideoTimingRemediationFocusTarget(shotVideoTimingRemediation.remediation)
                    : null}
                  onConfigureProvider={() => setShowProviders(true)}
                  onEditCharacterVoice={(characterId) => {
                    setVoiceCharacterFocusId(characterId)
                    setAssetEntityFocus({ type: 'character', id: characterId })
                    changeStage('assets')
                  }}
                  onEditNarratorVoice={() => {
                    setVoiceCharacterFocusId(null)
                    setAssetEntityFocus(null)
                    changeStage('assets')
                  }}
                  onContinueTimingRepreflight={() => {
                    const recovery = shotVideoTimingRemediation
                    const context = productionContextRef.current
                    if (!recovery || !context
                      || recovery.remediation.projectId !== context.projectId
                      || recovery.remediation.episodeId !== context.episode.id
                      || recovery.remediation.sourceRevisionId !== context.episode.sourceRevisionId) {
                      setToast('音频恢复证据已不属于当前剧本修订；不会复用旧建单，请从当前音频重新检查。')
                      return
                    }
                    const shot = shotsRef.current.find((candidate) => (
                      candidate.storyId === recovery.remediation.shotId
                      && candidate.sceneId === recovery.remediation.sceneId
                    ))
                    if (!shot) {
                      setToast('受影响镜头已不存在；不会创建 Seedance 任务。')
                      return
                    }
                    setActiveShot(shot.id)
                    setShotVideoTimingRepreflight(shotVideoTimingRepreflightRecovery(
                      recovery.sourceJobId,
                      recovery.remediation,
                    ))
                    setActiveRail('production')
                    setCurrentStage('storyboard')
                    setShowShotVideoBatch(true)
                    setToast('已定位受影响镜头；请手动点击“快速权威预检”。系统尚未调用 Seedance。')
                  }}
                  onNext={() => changeStage(nextProductionStageRoute('audio') ?? 'storyboard')}
                />
              )}
              {currentStage === 'export' && (
                <ExportStage
                  story={storyDocument}
                  episode={productionContext?.episode ?? null}
                  shots={shots}
                  jobs={episodeJobs}
                  onExport={() => void openWithPinnedTimeline('export')}
                />
              )}
            </section>

            {!globalCatalogRoute && isInspectorOpen && (
              <div
                className="workspace-splitter workspace-splitter-vertical"
                role="separator"
                aria-label="调整主画布与镜头属性栏宽度"
                aria-orientation="vertical"
                aria-valuemin={260}
                aria-valuemax={720}
                aria-valuenow={editorLayoutPreferences.inspectorWidthPx}
                tabIndex={0}
                title="左右拖动调整属性栏；双击恢复默认宽度"
                onPointerDown={(event) => beginLayoutResize('inspector', event)}
                onDoubleClick={() => setEditorLayoutPreferences((current) => ({
                  ...current,
                  inspectorWidthPx: DEFAULT_INSPECTOR_WIDTH_PX,
                }))}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    adjustInspectorWidth(16)
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault()
                    adjustInspectorWidth(-16)
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    setEditorLayoutPreferences((current) => ({
                      ...current,
                      inspectorWidthPx: DEFAULT_INSPECTOR_WIDTH_PX,
                    }))
                  }
                }}
              />
            )}
            {!globalCatalogRoute && isInspectorOpen && (
              <Inspector
                currentStage={currentStage}
                shot={selectedShot}
                isGenerating={selectedShot?.status === '生成中'}
                generationProgress={generationProgress}
                imageGenerationCancelling={Boolean(selectedShot && cancellingShotIds.includes(selectedShot.id))}
                canCancelImageGeneration={Boolean(selectedShot?.jobId)}
                onGenerate={() => { if (selectedShot) requestShotGeneration(selectedShot.id) }}
                onCancelImageGeneration={() => { if (selectedShot) void cancelShotGeneration(selectedShot.id) }}
                onUpdateShot={updateShotDraft}
                onCommitShot={commitShotEdit}
                onDeleteShot={(id) => void deleteShot(id)}
                onMoveShot={(id, delta) => void moveShot(id, delta)}
                mutationBusy={storyMutationState === 'saving'}
                totalShotCount={storyDocument?.scenes.reduce((total, scene) => total + scene.shots.length, 0) ?? 0}
                canMoveUp={Boolean(selectedStoryPosition && selectedStoryPosition.index > 0)}
                canMoveDown={Boolean(selectedStoryPosition && selectedStoryPosition.index < selectedStoryPosition.count - 1)}
                selectedStyle={selectedStyle}
                setSelectedStyle={changeSelectedStyle}
                aspect={aspect}
                setAspect={changeAspect}
                consistencyLocked={consistencyLocked}
                setConsistencyLocked={setConsistencyLocked}
                onClose={() => setInspectorOpen(false)}
                imageProvider={defaultImageProvider}
                imageProviderExecutable={executableImageProvider !== null}
                onConfigureImageProvider={() => setShowProviders(true)}
                primaryCharacterName={primaryCharacter?.name ?? null}
                primaryAssetReady={aliAsset.status === 'ready'}
                primaryAssetLocked={aliAsset.locked === true}
                primaryTurnaroundReferenceCount={primaryTurnaroundReferenceCount}
                onConfigureCharacterReferences={openPrimaryCharacterReferenceSetup}
                shotVideoState={selectedShotVideoState}
                shotVideoBatchSummary={shotVideoBatchSummary}
                shotVideoConfigured={seedanceConfigured}
                shotVideoActionPending={shotVideoActionPending}
                shotMediaReviews={shotMediaReviews}
                historicalShotVideos={historicalShotVideos}
                shotMediaReviewLoading={shotMediaReviewLoading}
                shotMediaReviewError={shotMediaReviewError}
                shotMediaReviewActionKey={shotMediaReviewActionKey}
                shotMediaTimelineState={shotMediaTimelineState}
                shotMediaTimelineMessage={shotMediaTimelineMessage}
                onRefreshShotMediaReview={() => void refreshSelectedShotMediaReviewAndTimeline()}
                onDecideShotMedia={decideSelectedShotMedia}
                onRestoreHistoricalShotVideo={restoreSelectedHistoricalShotVideo}
                onGenerateShotVideo={() => void generateSelectedShotVideo()}
                onRetryShotVideo={() => void retrySelectedShotVideo()}
                onCancelShotVideo={() => void cancelSelectedShotVideo()}
                onResolveShotVideoManualReview={openSelectedShotVideoManualResolution}
                onConfigureVideoProvider={() => {
                  setShowProviders(true)
                  const reason = seedanceGenerationBlockReason(seedanceProvider)
                  if (reason) setToast(reason)
                }}
              />
            )}
            {!isInspectorOpen && (
              <button
                className="open-inspector"
                onClick={() => setInspectorOpen(true)}
                aria-label="打开属性面板"
              >
                <PanelRightOpen size={18} />
              </button>
            )}
          </div>

          {(currentStage === 'storyboard' || currentStage === 'audio') && (
            <>
              {isTimelineOpen && (
                <div
                  className="workspace-splitter workspace-splitter-horizontal"
                  role="separator"
                  aria-label="调整制作区与时间线高度"
                  aria-orientation="horizontal"
                  aria-valuemin={180}
                  aria-valuemax={1200}
                  aria-valuenow={editorLayoutPreferences.timelineHeightPx ?? DEFAULT_TIMELINE_HEIGHT_PX}
                  tabIndex={0}
                  title="上下拖动调整时间线；双击恢复默认高度"
                  onPointerDown={(event) => beginLayoutResize('timeline', event)}
                  onDoubleClick={() => setEditorLayoutPreferences((current) => ({
                    ...current,
                    timelineHeightPx: null,
                  }))}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      adjustTimelineHeight(24)
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      adjustTimelineHeight(-24)
                    } else if (event.key === 'Home') {
                      event.preventDefault()
                      setEditorLayoutPreferences((current) => ({
                        ...current,
                        timelineHeightPx: null,
                      }))
                    }
                  }}
                />
              )}
              <div
                className={`timeline-region ${isTimelineOpen ? 'open' : 'collapsed'}`}
                style={isTimelineOpen && editorLayoutPreferences.timelineHeightPx !== null
                  ? { flexBasis: `${editorLayoutPreferences.timelineHeightPx}px` }
                  : undefined}
              >
                <Timeline
                  open={isTimelineOpen}
                  onToggle={() => setTimelineOpen((value) => !value)}
                  activeShot={activeShot}
                  shots={shots}
                  onSelect={setActiveShot}
                  persistence={productionContext ? {
                    projectId: productionContext.projectId,
                    episodeId: productionContext.episode.id,
                    sourceRevisionId: productionContext.episode.sourceRevisionId,
                    assetRevisionKey: timelineAssetRevisionKey,
                    aspectRatio: productionContext.episode.aspectRatio,
                  } : undefined}
                  persistenceHandleRef={timelinePersistenceRef}
                  onPersistenceReadyChange={setTimelineEditorReady}
                />
              </div>
            </>
          )}
        </main>
      </div>

      {episodeRenderSettingsConflict && (
        <EpisodeRenderSettingsConflictDialog
          conflict={episodeRenderSettingsConflict}
          onAdoptServer={() => void resolveEpisodeRenderSettingsConflict('adopt-server')}
          onReapplyLocal={() => void resolveEpisodeRenderSettingsConflict('reapply-local')}
        />
      )}
      {showCommand && <CommandPalette
        scope={productionContext?.episode.sourceRevisionId ? {
          projectId: productionContext.projectId,
          episodeId: productionContext.episode.id,
          sourceRevisionId: productionContext.episode.sourceRevisionId,
          episodeEtag: productionContext.episodeEtag,
        } : null}
        onClose={() => setShowCommand(false)}
        onStage={changeStage}
        onEntity={openStoryEntitySearchResult}
      />}
      {showHistory && productionContext && (
        <StoryHistoryModal
          scope={storyScopeFor(productionContext)}
          projectId={productionContext.projectId}
          episode={productionContext.episode}
          episodeEtag={productionContext.episodeEtag}
          onClose={() => {
            setShowHistory(false)
            setActiveRail(currentStage === 'source' ? 'projects' : currentStage === 'assets' ? 'characters' : 'production')
          }}
          onRestored={(result, scope) => {
            if (!applyStoryMutation(result, { message: '已恢复历史剧本并创建新审计修订' }, scope)) {
              setToast('当前分集已切换，旧分集的恢复结果未载入当前工作台')
              return false
            }
            dispatchStoryHistory({ type: 'reset', headRevisionId: result.revisionId })
            setOfflineStoryFormDrafts(emptyOfflineStoryFormDrafts())
            adoptOfflineStoryDraftEditingScope({
              projectId: scope.projectId,
              episodeId: scope.episodeId,
              baseSourceRevisionId: result.revisionId,
            })
            setShowHistory(false)
            setActiveRail(currentStage === 'source' ? 'projects' : currentStage === 'assets' ? 'characters' : 'production')
            void jobsState.refresh()
            return true
          }}
          onRestoreUncertain={async (reason, scope) => {
            if (!storyScopeIsCurrent(scope)) return false
            const beforeRevisionId = productionContextRef.current?.episode.sourceRevisionId ?? null
            try {
              const revisionId = await refreshStoryAfterConflict(scope)
              if (revisionId !== beforeRevisionId) {
                setToast('恢复请求结果未能确认；已读取并载入服务端权威剧本修订，不会自动重提')
                setShowHistory(false)
                setActiveRail(currentStage === 'source' ? 'projects' : currentStage === 'assets' ? 'characters' : 'production')
                return true
              }
            } catch {
              // Keep the original restore error visible in the modal.
            }
            setToast(reason instanceof Error ? reason.message : '剧本版本恢复失败')
            return false
          }}
        />
      )}
      {showPreview && productionContext && pinnedTimeline && (
        <OpenCutPreviewModal
          projectId={productionContext.projectId}
          episode={productionContext.episode}
          timelineSnapshot={pinnedTimeline}
          title={storyDocument?.title ?? productionContext.episode.title}
          onClose={() => setShowPreview(false)}
        />
      )}
      {showExport && pinnedTimeline && (
        <ExportModal
          onClose={() => setShowExport(false)}
          onSubmitted={async () => {
            try {
              await jobsState.refresh()
              setToast('真实 FFmpeg 导出任务已提交')
            } catch {
              setToast('导出任务已提交，任务状态将在连接恢复后同步')
            }
            setShowExport(false)
          }}
          story={storyDocument}
          episode={productionContext?.episode ?? null}
          shots={shots}
          timelineSnapshot={pinnedTimeline}
        />
      )}
      {regenerateShot && (
        <StoryboardShotRegenerateDialog
          shot={regenerateShot}
          onClose={() => setRegenerateShotId(null)}
          onConfirm={() => {
            setRegenerateShotId(null)
            void retryShotGeneration(regenerateShot.id)
          }}
        />
      )}
      {productionContext?.episode.sourceRevisionId && (
        <ShotVideoBatchDialog
          open={showShotVideoBatch}
          projectId={productionContext.projectId}
          episodeId={productionContext.episode.id}
          sourceRevisionId={productionContext.episode.sourceRevisionId}
          providerId={seedanceConfigured ? seedanceProvider?.id : undefined}
          providerConfigRevision={seedanceConfigured ? seedanceProvider?.configRevision : undefined}
          providerModel={seedanceConfigured ? seedanceProvider?.model : undefined}
          textProviderId={executableTextProvider?.id}
          textProviderConfigRevision={executableTextProvider?.configRevision}
          textProviderModel={executableTextProvider?.model}
          textProviderReady={Boolean(
            executableTextProvider
            && executableTextProvider.health.status === 'ok'
            && executableTextProvider.capabilities.includes('vision')
          )}
          initialShotId={shotVideoBatchPreset ? null : selectedShot?.storyId ?? null}
          initialPromptCompilerVersion={shotVideoBatchPreset === 'golden-baseline'
            ? 'seedance-verbose-baseline-v1'
            : 'seedance-compact-v1'}
          initialResolution={shotVideoBatchPreset ? '1080p' : '720p'}
          initialSelectionMode={shotVideoBatchPreset ? 'all-available' : 'default'}
          shots={shotVideoBatchShots}
          assets={visualAssetLibrary}
          blockedShotReasons={shotVideoBlockedReasons}
          timingRepreflightRecovery={shotVideoTimingRepreflight}
          onClose={() => {
            setShowShotVideoBatch(false)
            setShotVideoBatchPreset(null)
          }}
          onConfigureProvider={() => {
            setShowShotVideoBatch(false)
            setShowProviders(true)
          }}
          onConfigureCharacterReferences={() => {
            setShowShotVideoBatch(false)
            openPrimaryCharacterReferenceSetup()
          }}
          onRefreshAssets={async () => {
            await refreshVisualAssetWorkbench()
            setToast('视觉素材库已刷新，可继续选择角色三视图')
          }}
          onSubmitted={async (jobs) => {
            try {
              await jobsState.refresh()
              setToast(`Seedance 已原子创建 ${jobs.length} 个持久任务`)
            } catch {
              setToast('Seedance 任务已创建，状态将在连接恢复后同步')
            }
          }}
          onTimingRepreflightCompleted={(recovery) => {
            setShotVideoTimingRepreflight((current) => (
              current?.sourceJobId === recovery.sourceJobId ? null : current
            ))
            setShotVideoTimingRemediation((current) => (
              current?.sourceJobId === recovery.sourceJobId ? null : current
            ))
            setToast('最新音频时长预检已完成；请核对右侧合同后，再明确确认是否创建新视频任务。')
          }}
        />
      )}
      {dialogueSpeechConfirmation && (
        <PaidAigcConfirmationDialog
          confirmation={dialogueSpeechConfirmation.confirmation}
          eyebrow="角色配音 · 付费任务门禁"
          title="确认生成当前台词语音"
          description="免费预检已完成；明确确认后才会创建 1 个语音合成任务。"
          bindingDescription="已冻结当前剧本修订、台词、角色或项目旁白声线继承、表演参数、请求 Body 与幂等键；取消、过期或网络结果未知都不会换键。"
          cancelAriaLabel="取消语音合成确认"
          busy={dialogueSpeechConfirmationBusy}
          error={dialogueSpeechConfirmationError}
          onCancel={() => {
            if (dialogueSpeechConfirmationBusyRef.current) return
            // Cancellation keeps the exact lease for a later safe re-preflight.
            setDialogueSpeechConfirmation(null)
            setDialogueSpeechConfirmationError('')
          }}
          onRefresh={() => void refreshDialogueSpeechConfirmation()}
          onConfirm={() => void confirmDialogueSpeech()}
        />
      )}
      {assetImageConfirmation && (
        <PaidAigcConfirmationDialog
          confirmation={assetImageConfirmation.confirmation}
          eyebrow="图片 AIGC · 付费任务门禁"
          title={assetImageConfirmation.attempt.action === 'asset.image.edit'
            ? `确认${assetImageConfirmation.attempt.input.mode === 'variation' ? '生成原生变体' : '编辑固定源图'}`
            : assetImageConfirmation.attempt.purpose.kind === 'storyboard'
              ? `确认生成镜头 ${assetImageConfirmation.attempt.purpose.shotCode}`
              : `确认生成「${assetImageConfirmation.attempt.purpose.label}」`}
          description="0 任务预检已完成；当前操作只确认服务端签名的 1 个计费任务。"
          bindingDescription={assetImageConfirmation.attempt.action === 'asset.image.edit'
            ? `已冻结 ${assetImageConfirmation.attempt.purpose.sourceLabel} 的强 ETag、指令、参考图、请求 Body 与幂等键；确认时不会读取后续表单状态。`
            : '已冻结当前图片 Prompt、尺寸、质量、参考绑定、Provider 与幂等键；取消、过期或网络结果未知都不会换键。'}
          cancelAriaLabel="取消图片任务确认"
          busy={assetImageConfirmationBusy}
          error={assetImageConfirmationError}
          onCancel={cancelAssetImageConfirmation}
          onRefresh={() => void refreshAssetImageConfirmation()}
          onConfirm={() => void confirmAssetImage()}
        />
      )}
      <ShotVideoManualResolutionDialog
        job={shotVideoManualResolutionJob}
        pending={shotVideoManualResolutionPending}
        error={shotVideoManualResolutionError}
        onClose={() => {
          if (shotVideoManualResolutionPending) return
          setShotVideoManualResolutionError('')
          setShotVideoManualResolutionJobId(null)
        }}
        onConfirm={(note) => void resolveSelectedShotVideoUnknownSubmission(note)}
      />
      {offlineStoryDraftRecovery && offlineStoryDraftScope && (
        <OfflineStoryDraftRecoveryDialog
          draft={offlineStoryDraftRecovery}
          authoritativeSourceRevisionId={offlineStoryDraftScope.baseSourceRevisionId}
          targetError={offlineStoryDraftRecoveryTargetError}
          busy={offlineStoryDraftRecoveryBusy}
          error={offlineStoryDraftRecoveryError}
          onRestore={restoreOfflineStoryDraft}
          onDiscard={discardRecoveredOfflineStoryDraft}
          onCopyAsText={() => void copyRecoveredOfflineStoryDraftAsText()}
        />
      )}
      {shotReorderRequest && (
        <ShotReorderConfirmationDialog
          request={shotReorderRequest}
          busy={storyMutationState === 'saving'}
          onClose={() => {
            if (storyMutationInFlightRef.current) return
            setShotReorderRequest(null)
          }}
          onConfirm={() => void confirmShotReorder()}
        />
      )}
      <ProviderSettingsDialog
        isOpen={showProviders}
        providers={providerSettings}
        onClose={() => setShowProviders(false)}
        onSave={saveProvider}
        onTest={testProvider}
        onDelete={deleteProvider}
        onSetDefault={setDefaultProvider}
      />
      <TaskCenter
        open={showTasks}
        jobs={jobsState.jobs}
        connection={jobsState.connection}
        error={jobsState.error}
        onClose={() => setShowTasks(false)}
        onRetry={retryTask}
        onCancel={cancelTask}
      />
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
    </div>
  )
}

function EpisodeRenderSettingsConflictDialog({
  conflict,
  onAdoptServer,
  onReapplyLocal,
}: {
  conflict: EpisodeRenderSettingsConflict
  onAdoptServer: () => void
  onReapplyLocal: () => void
}) {
  const dialogRef = useDialogFocus(() => undefined)
  const busy = conflict.phase !== 'ready'
  useEffect(() => {
    const dialog = dialogRef.current
    const backdrop = dialog?.parentElement
    const host = backdrop?.parentElement
    if (!dialog || !backdrop || !host) return
    const siblings = Array.from(host.children).filter((element): element is HTMLElement => (
      element instanceof HTMLElement && element !== backdrop
    ))
    const previous = siblings.map((element) => ({
      element,
      inert: element.hasAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden'),
    }))
    for (const { element } of previous) {
      element.setAttribute('inert', '')
      element.setAttribute('aria-hidden', 'true')
    }
    return () => {
      for (const state of previous) {
        if (!state.inert) state.element.removeAttribute('inert')
        if (state.ariaHidden === null) state.element.removeAttribute('aria-hidden')
        else state.element.setAttribute('aria-hidden', state.ariaHidden)
      }
    }
  }, [dialogRef])
  const phaseLabel = conflict.phase === 'refreshing'
    ? '正在读取服务器最新版本…'
    : conflict.phase === 'adopting'
      ? '正在确认服务器最新值…'
      : conflict.phase === 'reapplying'
        ? '正在刷新 ETag 并重新提交…'
        : conflict.serverVerified
          ? '已读取服务器权威版本'
          : '服务器最新值尚未确认，操作时将重新读取'
  const etagLabel = conflict.serverEtag.length > 36
    ? `${conflict.serverEtag.slice(0, 16)}…${conflict.serverEtag.slice(-12)}`
    : conflict.serverEtag

  return (
    <div className="modal-backdrop render-settings-conflict-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="render-settings-conflict-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby="render-settings-conflict-title"
        aria-describedby="render-settings-conflict-description"
        tabIndex={-1}
      >
        <header>
          <span><AlertTriangle size={19} /></span>
          <div>
            <small>并发编辑保护</small>
            <h2 id="render-settings-conflict-title">画面设置发生版本冲突</h2>
          </div>
        </header>
        <p id="render-settings-conflict-description">
          另一个标签页或客户端已先保存。系统没有覆盖对方内容，也保留了你待保存的风格与画幅。
        </p>
        <div className="render-settings-conflict-status" aria-live="polite">
          <RefreshCcw size={13} className={busy ? 'spinning' : ''} />
          <span>{phaseLabel}</span>
        </div>
        <div className="render-settings-conflict-comparison">
          <section>
            <div><strong>服务器当前值</strong><i>{conflict.serverVerified ? '已确认' : '待刷新'}</i></div>
            <dl>
              <div><dt>视觉风格</dt><dd>{conflict.serverSnapshot.stylePreset}</dd></div>
              <div><dt>导出画幅</dt><dd>{conflict.serverSnapshot.aspectRatio}</dd></div>
              <div><dt>版本 ETag</dt><dd title={conflict.serverEtag}>{etagLabel || '待读取'}</dd></div>
            </dl>
          </section>
          <section className="local-intent">
            <div><strong>你的本地意图</strong><i>已保留</i></div>
            <dl>
              <div><dt>视觉风格</dt><dd>{conflict.localIntent.stylePreset}</dd></div>
              <div><dt>导出画幅</dt><dd>{conflict.localIntent.aspectRatio}</dd></div>
              <div><dt>提交策略</dt><dd>刷新后显式重新应用</dd></div>
            </dl>
          </section>
        </div>
        {conflict.error && (
          <div className="render-settings-conflict-error">
            <AlertTriangle size={14} />
            <span>{conflict.error}</span>
          </div>
        )}
        <footer>
          <button className="button secondary" disabled={busy} onClick={onAdoptServer}>
            {conflict.phase === 'adopting' ? '正在读取…' : '采用服务器值'}
          </button>
          <button className="button primary" disabled={busy} onClick={onReapplyLocal}>
            <RefreshCcw size={14} />
            {conflict.phase === 'reapplying' ? '正在重新应用…' : '基于最新版本重新应用'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function Rail({
  active,
  onSelect,
}: {
  active: string
  onSelect: (id: string, label: string) => void
}) {
  return (
    <aside className="rail">
      <div className="brand-mark" aria-label="漫剧工坊">
        <span>漫</span>
      </div>
      <nav className="rail-nav" aria-label="全局导航">
        {railItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`rail-item ${active === id ? 'active' : ''}`}
            onClick={() => onSelect(id, label)}
            aria-label={label}
            data-tooltip={label}
          >
            <Icon size={19} strokeWidth={1.7} />
          </button>
        ))}
      </nav>
      <div className="rail-bottom">
        <div className="avatar" aria-label="本机单用户模式" title="本机单用户模式">本</div>
      </div>
    </aside>
  )
}

function TopBar({
  projectTitle,
  episodeTitle,
  projects,
  episodesByProject,
  activeProjectId,
  activeEpisodeId,
  recentEpisodes,
  catalogLoading,
  catalogError,
  switchingEpisodeId,
  switchBlockedReason,
  onSwitchEpisode,
  onOpenCatalog,
  onRefreshCatalog,
  health,
  healthError,
  imageProvider,
  imageProviderExecutable,
  saveState,
  activeTaskCount,
  previewAvailable,
  onCommand,
  onProviders,
  onTasks,
  onExport,
  onPreview,
}: {
  projectTitle: string
  episodeTitle: string
  projects: readonly ProjectSummary[]
  episodesByProject: Readonly<Record<string, readonly EpisodeSummary[]>>
  activeProjectId: string | null
  activeEpisodeId: string | null
  recentEpisodes: ProjectSwitcherMemory['recentEpisodes']
  catalogLoading: boolean
  catalogError: string
  switchingEpisodeId: string | null
  switchBlockedReason: string
  onSwitchEpisode: (projectId: string, episodeId: string) => Promise<boolean>
  onOpenCatalog: (projectId: string | null) => void
  onRefreshCatalog: () => void
  health: HealthResponse | null
  healthError: string
  imageProvider: ProviderConnection | null
  imageProviderExecutable: boolean
  saveState: SaveState
  activeTaskCount: number
  previewAvailable: boolean
  onCommand: () => void
  onProviders: () => void
  onTasks: () => void
  onExport: () => void
  onPreview: () => void
}) {
  const providerState = providerUiConnectionState(imageProvider ?? undefined)
  const providerOnline = imageProviderExecutable && providerState === 'connected'
  const providerLabel = healthError
    ? '本机服务离线'
    : !health
      ? '读取图片 Provider…'
      : !imageProvider
        ? '未设置默认图片 Provider'
        : !imageProviderExecutable
          ? `${imageProvider.label} 配置不可用`
          : providerState === 'connected'
            ? `${imageProvider.label} · ${imageProvider.model}`
            : providerState === 'untested'
              ? `${imageProvider.label} 待验证`
              : providerState === 'degraded'
                ? `${imageProvider.label} 连接受限`
                : providerState === 'disabled'
                  ? `${imageProvider.label} 已停用`
                  : `${imageProvider.label} 连接异常`
  const providerTitle = healthError
    || (imageProvider
      ? `${imageProvider.label} · ${imageProvider.model || '未配置模型'} · ${providerStatusDetail(imageProvider)}`
      : providerLabel)
  const saveLabel = saveState === 'saving'
    ? '保存中'
    : saveState === 'saved'
      ? '已保存'
      : saveState === 'dirty'
        ? '待提交到分集'
        : saveState === 'conflict'
          ? '等待处理版本冲突'
          : saveState === 'error'
            ? '本地服务未连接'
            : '载入中'

  return (
    <header className="topbar">
      <ProjectEpisodeSwitcher
        projectTitle={projectTitle}
        episodeTitle={episodeTitle}
        projects={projects}
        episodesByProject={episodesByProject}
        activeProjectId={activeProjectId}
        activeEpisodeId={activeEpisodeId}
        recentEpisodes={recentEpisodes}
        loading={catalogLoading}
        error={catalogError}
        switchingEpisodeId={switchingEpisodeId}
        switchBlockedReason={switchBlockedReason}
        onSwitchEpisode={onSwitchEpisode}
        onOpenCatalog={onOpenCatalog}
        onRefresh={onRefreshCatalog}
      />
      <button className="command-trigger" onClick={onCommand}>
        <Search size={15} />
        <span>搜索镜头、台词、角色、场景或道具</span>
        <kbd>⌘ K</kbd>
      </button>
      <div className="topbar-actions">
        <button className={`cloud-state ${providerOnline ? 'online' : 'offline'}`} title={providerTitle} onClick={onProviders}>
          {providerOnline ? <Cloud size={14} /> : <AlertTriangle size={14} />}
          <span>{providerLabel}</span>
        </button>
        <div className={`save-state save-${saveState}`} title="项目自动持久化状态">
          {saveState === 'error' || saveState === 'conflict'
            ? <AlertTriangle size={13} />
            : saveState === 'dirty'
              ? <CircleDashed size={13} />
              : <CheckCircle2 size={13} />}
          <span>{saveLabel}</span>
        </div>
        <button className="icon-button notification" aria-label={`任务中心，${activeTaskCount} 个进行中任务`} onClick={onTasks}>
          <Bell size={17} />
          {activeTaskCount > 0 && <span>{activeTaskCount > 9 ? '9+' : activeTaskCount}</span>}
        </button>
        <button
          className="button secondary preview-button"
          onClick={onPreview}
          disabled={!previewAvailable}
          title={previewAvailable ? '使用 OpenCut 播放时钟预览当前时间线' : '正在初始化真实分集'}
        >
          <Play size={14} fill="currentColor" />
          预览
        </button>
        <button className="button primary" onClick={onExport}>
          <Download size={15} />
          导出配置
        </button>
      </div>
    </header>
  )
}

function ProjectLibraryHeader({
  kind,
  projectTitle,
  sourceRevisionId,
  projectCount,
  episodeCount,
}: {
  kind: 'source' | 'assets'
  projectTitle: string
  sourceRevisionId: string | null
  projectCount: number
  episodeCount: number
}) {
  const sourceMode = kind === 'source'
  const Icon = sourceMode ? BookOpenText : SquareStack
  return (
    <header className="project-header project-library-header">
      <div className="project-title-row">
        <div>
          <div className="eyebrow">
            <span>{sourceMode ? '全局项目 Catalog' : '全局数字资产 Catalog'}</span>
            <ChevronRight size={12} />
            <span>{projectTitle}</span>
          </div>
          <h1><Icon size={20} /> {sourceMode ? '原著、世界观与事件设定' : '素材与不可变版本'}</h1>
          <p>{sourceMode
            ? '按项目与剧集层级维护原著、世界观、事件线与人物关系。这里不等于当前制作单集；进入制作时才固定选择具体内容修订。'
            : '按项目与剧集层级浏览图片、音频、视频、脚本和台词版本。Catalog 只管理版本；本集引用与锁定必须在对应剧集制作阶段确认。'}</p>
        </div>
        <div className="production-summary">
          <div><span>当前内容修订</span><strong>{sourceRevisionId?.slice(0, 8) ?? '未建立'}</strong></div>
          <div><span>Catalog 项目</span><strong>{projectCount}</strong></div>
          <div><span>当前项目剧集</span><strong>{episodeCount}</strong></div>
          <div><span>当前范围</span><strong>{sourceMode ? '项目级知识' : '跨集素材'}</strong></div>
        </div>
      </div>
    </header>
  )
}

function ProjectHeader({
  currentStage,
  episodeTitle,
  stageStatuses,
  shots,
  primaryTurnaroundReferenceCount,
  onStageChange,
}: {
  currentStage: string
  episodeTitle: string
  stageStatuses: Record<string, StageStatus>
  shots: Shot[]
  primaryTurnaroundReferenceCount: number
  onStageChange: (id: string) => void
}) {
  const stage = productionStageForRoute(currentStage) ?? stages[0]!
  const visibleCurrentStageId = visibleProductionStageIdForRoute(currentStage) ?? 'source'
  const readyImages = shots.filter((shot) => Boolean(shot.imageUrl)).length
  const runningImages = shots.filter((shot) => shot.status === '生成中').length
  return (
    <header className="project-header">
      <div className="project-title-row">
        <div>
          <div className="eyebrow">
            <span>{episodeTitle}</span>
            <ChevronRight size={12} />
            <span>{stage.name}</span>
          </div>
          <h1>{stage.name}</h1>
        </div>
        <div className="production-summary">
          <div><span>镜头数</span><strong>{shots.length}</strong></div>
          <div><span>图片就绪</span><strong>{readyImages}/{shots.length}</strong></div>
          <div><span>生成队列</span><strong className={runningImages > 0 ? 'good' : ''}>{runningImages}</strong></div>
          <div className="collaborators">
            <span>主角三视图</span>
            <strong className={primaryTurnaroundReferenceCount === 3 ? 'good' : ''}>{primaryTurnaroundReferenceCount}/3 已锁定</strong>
          </div>
        </div>
      </div>

      <nav className="pipeline" aria-label="生产流程">
        {stages.map((item, index) => {
          const isActive = item.id === visibleCurrentStageId
          const status = stageStatuses[item.id] ?? 'pending'
          return (
            <button
              key={item.id}
              className={`pipeline-step ${isActive ? 'active' : ''} status-${status}`}
              onClick={() => onStageChange(item.id)}
            >
              <span className="step-index">
                {status === 'done' && !isActive ? <Check size={12} /> : String(index + 1).padStart(2, '0')}
              </span>
              <span className="step-copy">
                <small>{item.short}</small>
                <strong>{item.name}</strong>
              </span>
              {index < stages.length - 1 && <span className="step-line" />}
            </button>
          )
        })}
      </nav>
    </header>
  )
}

function StoryRevisionControls({
  canUndo,
  canRedo,
  undoTitle,
  redoTitle,
  onUndo,
  onRedo,
}: {
  canUndo: boolean
  canRedo: boolean
  undoTitle: string
  redoTitle: string
  onUndo: () => void
  onRedo: () => void
}) {
  return (
    <div className="story-revision-controls" role="group" aria-label="剧本修订撤销与重做">
      <button
        className="icon-button"
        aria-label="撤销剧本修订"
        disabled={!canUndo}
        title={undoTitle}
        onClick={onUndo}
      >
        <RotateCcw size={15} />
      </button>
      <button
        className="icon-button"
        aria-label="重做剧本修订"
        disabled={!canRedo}
        title={redoTitle}
        onClick={onRedo}
      >
        <Redo2 size={15} />
      </button>
    </div>
  )
}

function StoryboardStage({
  shots,
  scene,
  sceneCount,
  primaryCharacterName,
  characterReferencesMissing,
  primaryTurnaroundReferenceCount,
  onConfigureCharacterReferences,
  onUseTextOnly,
  activeShot,
  focusRequestId,
  onSelectShot,
  onAddShot,
  canAddShot,
  onRetryShot,
  onGenerateShot,
  onCancelShot,
  cancellingShotIds,
  onGenerateMissing,
  onRegenerateAll,
  canUndo,
  canRedo,
  undoTitle,
  redoTitle,
  onUndo,
  onRedo,
  goldenScope,
  onOpenGoldenBaseline,
  onOpenGoldenCandidate,
  onConfigureVideoProvider,
  onNext,
}: {
  shots: Shot[]
  scene: StoryDocument['scenes'][number] | null
  sceneCount: number
  primaryCharacterName: string | null
  characterReferencesMissing: boolean
  primaryTurnaroundReferenceCount: number
  onConfigureCharacterReferences: () => void
  onUseTextOnly: () => void
  activeShot: number
  focusRequestId: number
  onSelectShot: (id: number) => void
  onAddShot: () => void
  canAddShot: boolean
  onRetryShot: (id: number) => void
  onGenerateShot: (id: number) => void
  onCancelShot: (id: number) => void
  cancellingShotIds: number[]
  onGenerateMissing: (targetIds: number[]) => void
  onRegenerateAll: (targetIds: number[]) => void
  canUndo: boolean
  canRedo: boolean
  undoTitle: string
  redoTitle: string
  onUndo: () => void
  onRedo: () => void
  goldenScope: {
    episodeId: string
    sourceRevisionId: string
    jobs: GenerationJob[]
    shots: ShotVideoBatchShot[]
    configured: boolean
    currentProvider: {
      providerId: string
      model: string
      configRevision: number
    } | null
  } | null
  onOpenGoldenBaseline: () => void
  onOpenGoldenCandidate: () => void
  onConfigureVideoProvider: () => void
  onNext: () => void
}) {
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false)
  useEffect(() => {
    if (focusRequestId <= 0) return
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-storyboard-shot-id="${activeShot}"]`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
      target?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeShot, focusRequestId])
  const totalDurationSeconds = shots.reduce((total, shot) => {
    const duration = Number.parseFloat(shot.duration)
    return total + (Number.isFinite(duration) ? duration : 0)
  }, 0)
  const missingShotIds = getMissingStoryboardShotIds(shots)
  const regeneratableShotIds = getRegeneratableStoryboardShotIds(shots)
  const readyShotCount = getReadyStoryboardShotCount(shots)
  const generationBusy = shots.some((shot) => shot.status === '生成中')
  const generatingShotCount = shots.filter((shot) => shot.status === '生成中').length
  const fillButtonLabel = generationBusy
    ? '生成进行中'
    : shots.length === 0
      ? '暂无分镜'
      : missingShotIds.length === 0
        ? '分镜已齐'
        : '补齐缺失'
  const fillButtonCount = generationBusy ? generatingShotCount : missingShotIds.length

  return (
    <div className="stage-panel storyboard-stage">
      <div className="canvas-toolbar">
        <div className="toolbar-left">
          <div className="scene-select" title={scene ? '按剧本顺序展示全剧镜头' : '请先生成结构剧本'}>
            {sceneCount > 1
              ? `全剧 · ${sceneCount} 场`
              : `场 01 · ${scene?.title ?? '尚未生成场次'}`}
          </div>
          <span className="shot-count">
            {shots.length} 个镜头 · {Number.isInteger(totalDurationSeconds)
              ? totalDurationSeconds
              : totalDurationSeconds.toFixed(1)} 秒
          </span>
        </div>
        <div className="toolbar-actions">
          <StoryRevisionControls
            canUndo={canUndo}
            canRedo={canRedo}
            undoTitle={undoTitle}
            redoTitle={redoTitle}
            onUndo={onUndo}
            onRedo={onRedo}
          />
          <span className="toolbar-divider" />
          <span className="view-mode-label"><Grid2X2 size={13} /> 网格</span>
          <button
            className="button secondary regenerate-all"
            onClick={() => setShowRegenerateConfirm(true)}
            disabled={generationBusy || readyShotCount === 0 || characterReferencesMissing}
            title={characterReferencesMissing
              ? `角色真实三视图仅 ${primaryTurnaroundReferenceCount}/3；请先补齐或明确使用纯文本`
              : generationBusy
              ? '当前有分镜正在生成'
              : readyShotCount === 0
                ? '暂无已有画面，请使用“补齐缺失”'
                : '为全部镜头创建新版本，确认后才会提交'}
          >
            <RefreshCcw size={13} /> 全部重生成
          </button>
          <button
            className="button primary generate-all"
            onClick={() => onGenerateMissing(missingShotIds)}
            disabled={generationBusy || missingShotIds.length === 0 || characterReferencesMissing}
            title={characterReferencesMissing
              ? `角色真实三视图仅 ${primaryTurnaroundReferenceCount}/3；请先补齐或明确使用纯文本`
              : generationBusy
              ? '当前有分镜正在生成'
              : shots.length === 0
                ? '请先生成结构剧本'
                : missingShotIds.length === 0
                  ? '所有分镜都有当前可用画面'
                  : '只生成缺失或已过期的分镜，不替换已有画面'}
          >
            <Sparkles size={14} /> {fillButtonLabel} <span>· {fillButtonCount} 镜</span>
          </button>
        </div>
      </div>

      {characterReferencesMissing && (
        <section className="storyboard-reference-recovery stage-recovery" role="alert" aria-label="分镜角色参考图恢复">
          <div className="storyboard-reference-recovery-heading">
            <AlertTriangle size={16} />
            <span>
              <strong>角色真实三视图未就绪 · {primaryTurnaroundReferenceCount}/3</strong>
              <small>当前锁定主图不能替代正面、侧面、背面三个真实槽位；AI 也不会猜测不存在的 Asset。</small>
            </span>
          </div>
          <p>继续保持角色一致性：前往项目数字资产库，在角色候选图上依次点击“拆分三视图”与“绑定三视图”。若本轮不需要角色参考，则明确改用纯文本分镜。</p>
          <div className="storyboard-reference-recovery-actions">
            <button type="button" onClick={onConfigureCharacterReferences}><Users size={13} />去项目资产库补齐三视图</button>
            <button type="button" className="secondary" onClick={onUseTextOnly}>明确改用纯文本</button>
          </div>
        </section>
      )}

      {goldenScope && goldenScope.shots.length >= 6 && (
        <SeedanceGoldenAcceptanceCard
          episodeId={goldenScope.episodeId}
          sourceRevisionId={goldenScope.sourceRevisionId}
          shots={goldenScope.shots}
          jobs={goldenScope.jobs}
          configured={goldenScope.configured}
          currentProvider={goldenScope.currentProvider}
          onOpenBaseline={onOpenGoldenBaseline}
          onOpenCandidate={onOpenGoldenCandidate}
          onConfigure={onConfigureVideoProvider}
        />
      )}

      <div className="scene-note">
        <div className="scene-number">{sceneCount > 1 ? 'ALL' : '01'}</div>
        <div>
          <strong>{sceneCount > 1 ? `${sceneCount} 个场次的全部镜头` : scene?.title ?? '尚未生成场次'}</strong>
          <p>{sceneCount > 1
            ? '按结构剧本的场次与镜头顺序排列。'
            : scene ? `${scene.timeOfDay} · ${scene.description}` : '请先在剧本阶段生成真实场次与镜头。'}</p>
        </div>
      </div>

      <div className="shot-grid">
        {shots.map((shot) => (
          <ShotCard
            key={shot.id}
            shot={shot}
            primaryCharacterName={primaryCharacterName}
            active={activeShot === shot.id}
            onClick={() => onSelectShot(shot.id)}
            onRetry={() => onRetryShot(shot.id)}
            onGenerate={() => onGenerateShot(shot.id)}
            onCancel={() => onCancelShot(shot.id)}
            cancelling={cancellingShotIds.includes(shot.id)}
            generationBlocked={characterReferencesMissing}
            generationBlockedReason={`角色真实三视图仅 ${primaryTurnaroundReferenceCount}/3；请先补齐或明确使用纯文本`}
          />
        ))}
        <button
          className="add-shot-card"
          onClick={onAddShot}
          disabled={!canAddShot}
          title={!scene ? '请先生成结构剧本' : shots.length >= 12 ? 'MVP 最多 12 个镜头' : undefined}
        >
          <span><Plus size={19} /></span>
          <strong>添加镜头</strong>
          <small>{!scene ? '先生成剧本' : shots.length >= 12 ? '已达 12 镜上限' : '写入剧本修订并同步时间线'}</small>
        </button>
      </div>
      <div className="stage-footer">
        <span><CircleDashed size={14} /> 全部分镜图就绪即可进入本地动态漫剪辑；Seedance 逐镜视频是可选增强，继续导航不会自动调用 Provider</span>
        <button className="button primary" onClick={onNext}>进入剪辑与成片 <ChevronRight size={14} /></button>
      </div>
      {showRegenerateConfirm && (
        <StoryboardRegenerateDialog
          totalCount={regeneratableShotIds.length}
          readyCount={readyShotCount}
          onClose={() => setShowRegenerateConfirm(false)}
          onConfirm={() => {
            setShowRegenerateConfirm(false)
            onRegenerateAll(regeneratableShotIds)
          }}
        />
      )}
    </div>
  )
}

function StoryboardRegenerateDialog({
  totalCount,
  readyCount,
  onClose,
  onConfirm,
}: {
  totalCount: number
  readyCount: number
  onClose: () => void
  onConfirm: () => void
}) {
  const dialogRef = useDialogFocus(onClose)
  const missingCount = Math.max(0, totalCount - readyCount)

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="storyboard-regenerate-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storyboard-regenerate-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div><small>高成本操作 · 二次确认</small><h2 id="storyboard-regenerate-title">重新生成全部分镜？</h2></div>
          <button onClick={onClose} aria-label="关闭重新生成确认"><X size={18} /></button>
        </header>
        <div className="storyboard-regenerate-body">
          <div className="storyboard-regenerate-warning">
            <AlertTriangle size={18} />
            <div>
              <strong>将提交 {totalCount} 个真实图片生成任务</strong>
              <span>任务提交后可能立即产生 API 费用，请确认确实需要整批换版。</span>
            </div>
          </div>
          <div className="storyboard-regenerate-summary">
            <div><span>已有画面</span><strong>{readyCount} 镜</strong></div>
            <div><span>缺失画面</span><strong>{missingCount} 镜</strong></div>
          </div>
          <p><strong>{readyCount} 个已有画面不会被删除。</strong>新任务生成期间继续显示原画面；成功后切换到新版本，原资产仍保留在版本链中。</p>
          <p>如果只是补齐空白或过期镜头，请取消并使用“补齐缺失”。</p>
        </div>
        <footer>
          <button className="button secondary" onClick={onClose}>取消</button>
          <button className="button primary" onClick={onConfirm} disabled={totalCount === 0}>
            <RefreshCcw size={14} /> 确认重生成 {totalCount} 镜
          </button>
        </footer>
      </div>
    </div>
  )
}

function ShotReorderConfirmationDialog({
  request,
  busy,
  onClose,
  onConfirm,
}: {
  request: ShotReorderRequest
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const dialogRef = useDialogFocus(onClose)
  const [summary, consequence = ''] = request.decision.confirmation.split('\n\n', 2)

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <div
        ref={dialogRef}
        className="storyboard-regenerate-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shot-reorder-confirmation-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div><small>剧本结构变更</small><h2 id="shot-reorder-confirmation-title">确认调整镜头顺序？</h2></div>
          <button onClick={onClose} disabled={busy} aria-label="关闭镜头排序确认"><X size={18} /></button>
        </header>
        <div className="storyboard-regenerate-body">
          <div className="storyboard-regenerate-warning">
            <AlertTriangle size={18} />
            <div><strong>{summary}</strong><span>{consequence}</span></div>
          </div>
          <p>确认时会重新核对当前 Story revision 和场内镜头顺序；若其他操作已修改剧本，本次确认将直接失效，不会覆盖新修订。</p>
        </div>
        <footer>
          <button className="button secondary" onClick={onClose} disabled={busy}>取消</button>
          <button className="button primary" onClick={onConfirm} disabled={busy}>
            {busy ? <CircleDashed size={14} /> : <Check size={14} />}
            {busy ? '正在创建排序修订…' : '确认排序并创建修订'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function StoryboardShotRegenerateDialog({
  shot,
  onClose,
  onConfirm,
}: {
  shot: Shot
  onClose: () => void
  onConfirm: () => void
}) {
  const dialogRef = useDialogFocus(onClose)

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="storyboard-regenerate-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storyboard-shot-regenerate-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div><small>付费任务 · 二次确认</small><h2 id="storyboard-shot-regenerate-title">重新生成「{shot.title}」？</h2></div>
          <button onClick={onClose} aria-label="关闭单镜重生成确认"><X size={18} /></button>
        </header>
        <div className="storyboard-regenerate-body">
          <div className="storyboard-regenerate-warning">
            <AlertTriangle size={18} />
            <div>
              <strong>将提交 1 个新的真实图片任务</strong>
              <span>新任务可能立即产生 API 费用；原画面不会被删除。</span>
            </div>
          </div>
          <p>生成期间继续显示当前画面；成功后切换到新版本，原资产仍保留在版本链中。</p>
          <p>提交后可以点击镜头上的“中断任务”。中断是尽力而为，若 Provider 已接收请求，仍可能产生费用。</p>
        </div>
        <footer>
          <button className="button secondary" onClick={onClose}>保留当前画面</button>
          <button className="button primary" onClick={onConfirm}>
            <RefreshCcw size={14} /> 确认生成新版本
          </button>
        </footer>
      </div>
    </div>
  )
}

function ShotCard({
  shot,
  primaryCharacterName,
  active,
  onClick,
  onRetry,
  onGenerate,
  onCancel,
  cancelling,
  generationBlocked = false,
  generationBlockedReason = '',
}: {
  shot: Shot
  primaryCharacterName: string | null
  active: boolean
  onClick: () => void
  onRetry: () => void
  onGenerate: () => void
  onCancel: () => void
  cancelling: boolean
  generationBlocked?: boolean
  generationBlockedReason?: string
}) {
  const hasExistingImage = Boolean(shot.imageUrl)
  const statusClass = {
    已通过: 'approved',
    待审核: 'review',
    生成中: 'generating',
    待生成: 'pending',
    失败: 'failed',
  }[shot.status]

  return (
    <article
      className={`shot-card ${active ? 'active' : ''} ${statusClass}`}
      data-storyboard-shot-id={shot.id}
      onClick={onClick}
      tabIndex={0}
      onKeyDown={(event) => event.key === 'Enter' && onClick()}
    >
      <div
        className={`shot-image ${shot.imageClass}`}
        style={shot.imageUrl ? { backgroundImage: `url(${JSON.stringify(shot.imageUrl)})`, backgroundPosition: 'center', backgroundSize: 'cover' } : undefined}
      >
        <div className="image-topline">
          <span className="shot-code">镜头 {shot.code}</span>
          <span className={`status-badge ${statusClass}`}>
            {shot.status === '生成中' && <span className="pulse-dot" />}
            {shot.status}
          </span>
        </div>
        {shot.status === '生成中' && (
          <div className={`generating-overlay ${hasExistingImage ? 'has-existing' : ''}`}>
            <WandSparkles size={20} />
            <span>{hasExistingImage ? '新版本生成中' : '云端生成中'}</span>
            {hasExistingImage && <small>原画面已保留</small>}
            <div><i /></div>
            <button
              className="cancel-image-generation"
              disabled={cancelling || !shot.jobId}
              title={shot.jobId
                ? '尽力中断本地及上游请求；Provider 已接收的任务仍可能产生费用'
                : '正在创建持久化任务，获取任务编号后即可中断'}
              onClick={(event) => {
                event.stopPropagation()
                onCancel()
              }}
            >
              {cancelling || !shot.jobId ? <CircleDashed size={12} /> : <X size={12} />}
              {cancelling ? '正在中断…' : shot.jobId ? '中断任务' : '正在提交…'}
            </button>
          </div>
        )}
        {shot.status === '待生成' && (
          <div className={`empty-frame-copy ${hasExistingImage ? 'has-existing' : ''}`}>
            <ImageIcon size={22} />
            <span>{hasExistingImage ? '画面需要更新' : '尚未生成画面'}</span>
            {hasExistingImage && <small>原画面已保留</small>}
          </div>
        )}
        {shot.status === '失败' && (
          <div className={`failed-frame-copy ${hasExistingImage ? 'has-existing' : ''}`}>
            <AlertTriangle size={20} />
            <strong>{hasExistingImage ? '新版本生成失败' : '生成失败'}</strong>
            <span>{shot.generationError || '图片服务暂时不可用'}</span>
            {hasExistingImage && <small>原画面仍可用</small>}
            <button
              disabled={generationBlocked}
              title={generationBlocked ? generationBlockedReason : undefined}
              onClick={(event) => { event.stopPropagation(); onRetry() }}
            ><RefreshCcw size={12} /> 重试</button>
          </div>
        )}
        <div className="image-actions">
          <button
            aria-label={shot.imageUrl ? '重新生成当前镜头' : '生成当前镜头'}
            disabled={shot.status === '生成中' || generationBlocked}
            title={generationBlocked
              ? generationBlockedReason
              : shot.imageUrl ? '生成新版本；原资产会保留在版本链中' : '生成真实分镜图'}
            onClick={(event) => { event.stopPropagation(); onGenerate() }}
          ><RefreshCcw size={14} /></button>
        </div>
        <span className="shot-duration">{shot.duration}</span>
      </div>
      <div className="shot-body">
        <div className="shot-title-line">
          <div>
            <h3>{shot.title}</h3>
            <div className="shot-meta"><span>{shot.framing}</span><i /> <span>{shot.movement}</span></div>
          </div>
        </div>
        <p>{shot.copy}</p>
        {shot.dialogue && <div className="dialogue"><Mic2 size={12} />{shot.dialogue}</div>}
        <footer>
          {primaryCharacterName ? (
            <div className="character-chip">
              <span className="mini-avatar">{[...primaryCharacterName][0]}</span>{primaryCharacterName}
            </div>
          ) : <div className="character-chip">未绑定角色</div>}
          <div className="shot-fact">{shot.assetId ? '当前修订已绑定真实 Asset' : '尚未绑定画面 Asset'}</div>
        </footer>
      </div>
    </article>
  )
}

function Inspector({
  currentStage,
  shot,
  isGenerating,
  generationProgress,
  imageGenerationCancelling,
  canCancelImageGeneration,
  onGenerate,
  onCancelImageGeneration,
  onUpdateShot,
  onCommitShot,
  onDeleteShot,
  onMoveShot,
  mutationBusy,
  totalShotCount,
  canMoveUp,
  canMoveDown,
  selectedStyle,
  setSelectedStyle,
  aspect,
  setAspect,
  consistencyLocked,
  setConsistencyLocked,
  onClose,
  imageProvider,
  imageProviderExecutable,
  onConfigureImageProvider,
  primaryCharacterName,
  primaryAssetReady,
  primaryAssetLocked,
  primaryTurnaroundReferenceCount,
  onConfigureCharacterReferences,
  shotVideoState,
  shotVideoBatchSummary,
  shotVideoConfigured,
  shotVideoActionPending,
  shotMediaReviews,
  historicalShotVideos,
  shotMediaReviewLoading,
  shotMediaReviewError,
  shotMediaReviewActionKey,
  shotMediaTimelineState,
  shotMediaTimelineMessage,
  onRefreshShotMediaReview,
  onDecideShotMedia,
  onRestoreHistoricalShotVideo,
  onGenerateShotVideo,
  onRetryShotVideo,
  onCancelShotVideo,
  onResolveShotVideoManualReview,
  onConfigureVideoProvider,
}: {
  currentStage: string
  shot: Shot | null
  isGenerating: boolean
  generationProgress: number
  imageGenerationCancelling: boolean
  canCancelImageGeneration: boolean
  onGenerate: () => void
  onCancelImageGeneration: () => void
  onUpdateShot: (id: number, patch: EditableShotPatch) => void
  onCommitShot: (id: number, patch: EditableShotPatch) => Promise<void>
  onDeleteShot: (id: number) => void
  onMoveShot: (id: number, delta: -1 | 1) => void
  mutationBusy: boolean
  totalShotCount: number
  canMoveUp: boolean
  canMoveDown: boolean
  selectedStyle: string
  setSelectedStyle: (value: string) => void
  aspect: string
  setAspect: (value: string) => void
  consistencyLocked: boolean
  setConsistencyLocked: (value: boolean) => void
  onClose: () => void
  imageProvider: ProviderConnection | null
  imageProviderExecutable: boolean
  onConfigureImageProvider: () => void
  primaryCharacterName: string | null
  primaryAssetReady: boolean
  primaryAssetLocked: boolean
  primaryTurnaroundReferenceCount: number
  onConfigureCharacterReferences: () => void
  shotVideoState: ReturnType<typeof resolveShotVideoViewState>
  shotVideoBatchSummary: ReturnType<typeof summarizeShotVideoBatchAvailability>
  shotVideoConfigured: boolean
  shotVideoActionPending: boolean
  shotMediaReviews: Partial<Record<ShotMediaType, ShotMediaReviewSnapshot>>
  historicalShotVideos: HistoricalShotVideoCandidatesResponse | null
  shotMediaReviewLoading: boolean
  shotMediaReviewError: string
  shotMediaReviewActionKey: string | null
  shotMediaTimelineState: ShotMediaTimelineState
  shotMediaTimelineMessage: string
  onRefreshShotMediaReview: () => void
  onDecideShotMedia: (
    mediaType: ShotMediaType,
    decision: ShotMediaReviewDecision,
    candidate: ShotMediaCandidate,
    note: string,
  ) => Promise<void>
  onRestoreHistoricalShotVideo: (candidate: HistoricalShotVideoCandidate) => Promise<void>
  onGenerateShotVideo: () => void
  onRetryShotVideo: () => void
  onCancelShotVideo: () => void
  onResolveShotVideoManualReview: () => void
  onConfigureVideoProvider: () => void
}) {
  const [editError, setEditError] = useState('')
  const stylePresets = ['国风动画', '东方水墨', '日漫赛璐璐', '3D 写实']
  const [customStyleDraft, setCustomStyleDraft] = useState(
    stylePresets.includes(selectedStyle) ? '' : selectedStyle,
  )
  const imageProviderHealth = imageProvider?.health.status ?? 'untested'
  const needsReferenceEditing = consistencyLocked && primaryAssetLocked
  const missingCharacterReferenceSlots = needsReferenceEditing
    && primaryTurnaroundReferenceCount < 3
  const imageProviderSupportsReferences = providerSupportsCapability(imageProvider, 'edit')
  const imageGenerationAvailable = imageProviderExecutable
    && !missingCharacterReferenceSlots
    && (!needsReferenceEditing || imageProviderSupportsReferences)
  const imageProviderLabel = imageProviderExecutable && imageProvider
    ? `${imageProvider.label} · ${imageProvider.model}`
    : '暂无可执行的默认图片 Provider'
  const imageProviderTitle = !imageProviderExecutable
    ? '请先配置并启用默认图片 Provider'
    : missingCharacterReferenceSlots
      ? `角色真实三视图仅 ${primaryTurnaroundReferenceCount}/3；请先补齐，或明确关闭锁定参考图`
    : needsReferenceEditing && !imageProviderSupportsReferences
      ? '当前默认图片 Provider 未声明 edit 能力，无法使用已锁定参考图'
      : imageProvider
        ? `${imageProvider.label} · ${imageProvider.model} · ${providerStatusDetail(imageProvider)}`
        : imageProviderLabel

  useEffect(() => {
    setEditError('')
  }, [shot?.storyId])

  useEffect(() => {
    setCustomStyleDraft(stylePresets.includes(selectedStyle) ? '' : selectedStyle)
  }, [selectedStyle])

  const saveShot = async () => {
    if (!shot || mutationBusy) return
    setEditError('')
    try {
      await onCommitShot(shot.id, {
        code: shot.code,
        title: shot.title,
        copy: shot.copy,
        framing: shot.framing,
        movement: shot.movement,
        transition: shot.transition ?? '硬切',
        duration: shot.duration,
        visualPrompt: shot.visualPrompt,
      })
    } catch (error) {
      setEditError(error instanceof Error ? error.message : '镜头保存失败')
    }
  }

  if (currentStage !== 'storyboard') {
    const stageName = currentStage === 'source'
      ? '原著选集与制作设定'
      : currentStage === 'assets'
        ? '角色与场景准备'
        : productionStageForRoute(currentStage)?.name ?? '当前阶段'
    return (
      <aside className="inspector contextual-inspector">
        <div className="inspector-heading">
          <strong>阶段信息</strong>
          <button onClick={onClose}><PanelRightClose size={17} /></button>
        </div>
        <div className="assistant-orb"><Clapperboard size={23} /></div>
        <h3>{stageName}</h3>
        <p>{currentStage === 'source'
          ? '这是当前剧集的制作入口：选择 Catalog 中的原著/内容修订，并设置该集时长、画幅和风格。它不会修改项目原著。'
          : currentStage === 'assets'
            ? '这是当前剧集的角色、场景和道具引用阶段；在这里明确选择并固定本集使用的素材版本，Catalog 默认不会自动覆盖。'
            : currentStage === 'script'
          ? '镜头结构属性、新增、删除与同场排序都在中间的剧本卡片内完成；下一制作阶段负责画面生成与逐镜视频。'
          : '当前面板仅显示已接通的真实项目数据。剧本结构请在「剧本与配音」编辑，画面生成请进入「分镜与逐镜视频」。'}</p>
        <div className="assistant-checks">
          <span><CheckCircle2 size={14} /> SQLite 项目修订</span>
          <span><CheckCircle2 size={14} /> 可恢复生成任务</span>
          <span><CheckCircle2 size={14} /> Provider 凭据隔离</span>
        </div>
      </aside>
    )
  }

  if (!shot) {
    return (
      <aside className="inspector contextual-inspector">
        <div className="inspector-heading">
          <strong>镜头属性</strong>
          <button onClick={onClose}><PanelRightClose size={17} /></button>
        </div>
        <div className="assistant-orb"><Clapperboard size={23} /></div>
        <h3>尚未有可编辑镜头</h3>
        <p>请先生成真实结构剧本，再在分镜台中新增、编辑和排序镜头。</p>
      </aside>
    )
  }

  return (
    <aside className="inspector">
      <div className="inspector-tabs">
        <span className="inspector-tab-label">镜头属性</span>
        <button className="close-inspector" onClick={onClose} aria-label="收起属性面板"><PanelRightClose size={17} /></button>
      </div>

      <div className="properties-panel">
          <div className="selected-shot-title">
            <div><span>镜头 {shot.code}</span><strong>{shot.title}</strong></div>
            <span className="shot-structure-stage-hint">排序与删除请到「剧本与配音」</span>
          </div>

          <section className="property-section">
            <div className="section-title"><span>镜头标识</span></div>
            <div className="property-grid">
              <label><small>镜头编号</small><input disabled={mutationBusy} value={shot.code} maxLength={2000} onChange={(event) => onUpdateShot(shot.id, { code: event.target.value })} /></label>
              <label><small>镜头标题</small><input disabled={mutationBusy} value={shot.title} maxLength={2000} onChange={(event) => onUpdateShot(shot.id, { title: event.target.value })} /></label>
            </div>
          </section>

          <section className="property-section">
            <div className="section-title"><span>画面描述</span><small>{shot.copy.length} / 2000</small></div>
            <textarea
              disabled={mutationBusy}
              value={shot.copy}
              maxLength={2000}
              onChange={(event) => onUpdateShot(shot.id, { copy: event.target.value })}
              aria-label={`镜头 ${shot.code} 画面描述`}
            />
          </section>

          <section className="property-section">
            <div className="section-title"><span>镜头视觉 Prompt</span><small>{shot.visualPrompt.length} / 4000</small></div>
            <textarea
              disabled={mutationBusy}
              value={shot.visualPrompt}
              maxLength={4000}
              onChange={(event) => onUpdateShot(shot.id, { visualPrompt: event.target.value })}
              aria-label={`镜头 ${shot.code} 视觉 Prompt`}
            />
          </section>

          <section className="property-section">
            <div className="section-title"><span>镜头语言</span></div>
            <div className="property-grid">
              <label><small><Aperture size={12} /> 景别</small><input disabled={mutationBusy} value={shot.framing} maxLength={100} onChange={(event) => onUpdateShot(shot.id, { framing: event.target.value })} /></label>
              <label><small><SlidersHorizontal size={12} /> 运镜</small><input disabled={mutationBusy} value={shot.movement} maxLength={100} onChange={(event) => onUpdateShot(shot.id, { movement: event.target.value })} /></label>
              <label title="当前正式导出仅支持硬切"><small><Scissors size={12} /> 转场（当前导出）</small><span className="property-static-value">硬切</span></label>
              <label><small><SquareStack size={12} /> 时长（秒）</small><input disabled={mutationBusy} type="number" min="0.5" max="15" step="0.1" value={Number.parseFloat(shot.duration)} onChange={(event) => onUpdateShot(shot.id, { duration: `${event.target.value}s` })} /></label>
            </div>
          </section>

          {editError && <div className="source-generation-error"><AlertTriangle size={14} /><span>{editError}</span></div>}
          <button className="button secondary full-width save-shot-revision" onClick={() => void saveShot()} disabled={mutationBusy}>
            {mutationBusy ? '正在写入剧本修订…' : '保存镜头修订'}
          </button>

          <section className="property-section">
            <div className="section-title"><span>视觉风格</span><small>应用于新生成</small></div>
            <div className="style-options">
              {stylePresets.map((style) => (
                <button key={style} className={selectedStyle === style ? 'active' : ''} onClick={() => setSelectedStyle(style)}>
                  <span className={`style-thumb style-${style === '国风动画' ? 'donghua' : style === '东方水墨' ? 'ink' : style === '日漫赛璐璐' ? 'anime' : 'real'}`} />
                  {style}
                </button>
              ))}
            </div>
            <label className="custom-style-input"><small>自定义风格</small><input
              value={customStyleDraft}
              maxLength={200}
              placeholder="例如：复古港漫，高对比网点纸"
              onChange={(event) => setCustomStyleDraft(event.target.value)}
              onBlur={() => {
                const value = customStyleDraft.trim()
                if (value) setSelectedStyle(value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const value = customStyleDraft.trim()
                  if (value) setSelectedStyle(value)
                }
              }}
            /></label>
          </section>

          <section className="property-section compact-section">
            <div className="section-title"><span>画幅</span></div>
            <div className="segmented-control">
              {['16:9', '9:16', '1:1'].map((item) => <button key={item} onClick={() => setAspect(item)} className={aspect === item ? 'active' : ''}>{item}</button>)}
            </div>
          </section>

          <section className="property-section consistency-section">
            <div>
              <span className="consistency-icon"><LockKeyhole size={14} /></span>
              <div><strong>角色一致性约束</strong><small>{primaryAssetLocked
                ? !imageProviderSupportsReferences
                  ? `「${primaryCharacterName ?? '主角'}」参考图已锁定；当前 Provider 不支持 edit，请先切换`
                  : `「${primaryCharacterName ?? '主角'}」参考图已锁定；生成时使用参考图编辑协议`
                : primaryAssetReady
                  ? '候选参考图尚未锁定；当前仍仅使用剧本视觉描述'
                  : '当前仅使用剧本中的视觉描述'}</small></div>
            </div>
            <button className={`switch ${consistencyLocked ? 'on' : ''}`} onClick={() => setConsistencyLocked(!consistencyLocked)}><i /></button>
          </section>

          {missingCharacterReferenceSlots && (
            <section className="storyboard-reference-recovery" role="alert" aria-label="分镜角色参考图恢复">
              <div className="storyboard-reference-recovery-heading">
                <AlertTriangle size={14} />
                <span>
                  <strong>角色真实三视图未就绪 · {primaryTurnaroundReferenceCount}/3</strong>
                  <small>锁定的角色主图不是正/侧/背槽位，系统不会把它冒充三视图或让模型猜 Asset。</small>
                </span>
              </div>
              <p>保持角色一致性时，请先在项目数字资产库绑定真实正面、侧面和背面；若本镜允许不使用角色参考，可明确切换为纯文本分镜。</p>
              <div className="storyboard-reference-recovery-actions">
                <button type="button" onClick={onConfigureCharacterReferences}><Users size={12} />去项目资产库补齐三视图</button>
                <button type="button" className="secondary" onClick={() => setConsistencyLocked(false)}>明确改用纯文本</button>
              </div>
            </section>
          )}

          <div className="model-row">
            <span>生成 Provider <i className={`provider-dot provider-${imageProviderHealth}`} /></span>
            <button type="button" title={imageProviderTitle} onClick={onConfigureImageProvider}>{imageProviderLabel}</button>
          </div>
          <button
            className={`generate-button ${isGenerating ? 'working cancelable' : ''}`}
            onClick={isGenerating
              ? onCancelImageGeneration
              : missingCharacterReferenceSlots
                ? onConfigureCharacterReferences
              : imageGenerationAvailable
                ? onGenerate
                : onConfigureImageProvider}
            disabled={imageGenerationCancelling || (isGenerating && !canCancelImageGeneration)}
            title={isGenerating
              ? '尽力中断本地及上游请求；Provider 已接收的任务仍可能产生费用'
              : imageGenerationAvailable ? undefined : imageProviderTitle}
          >
            {isGenerating ? (
              <>
                {imageGenerationCancelling || !canCancelImageGeneration ? <CircleDashed size={14} /> : <X size={14} />}
                <span>{imageGenerationCancelling
                  ? '正在中断当前镜头…'
                  : canCancelImageGeneration
                    ? `中断当前镜头 · ${generationProgress}%`
                    : '正在创建可中断任务…'}</span>
                <i style={{ width: `${generationProgress}%` }} />
              </>
            ) : (
              <><Sparkles size={15} /> {missingCharacterReferenceSlots
                ? '先补齐角色三视图'
                : imageGenerationAvailable
                  ? shot.status === '失败' ? '重新生成镜头' : '生成当前镜头'
                  : '配置可用图片 Provider'} <span>· {imageGenerationAvailable ? '实时任务' : '未建单'}</span></>
            )}
          </button>
          <ShotMediaReviewPanel
            reviews={shotMediaReviews}
            historicalVideos={historicalShotVideos?.candidates ?? []}
            loading={shotMediaReviewLoading}
            error={shotMediaReviewError}
            actionKey={shotMediaReviewActionKey}
            timelineState={shotMediaTimelineState}
            timelineMessage={shotMediaTimelineMessage}
            onRefresh={onRefreshShotMediaReview}
            onDecision={onDecideShotMedia}
            onRestoreHistoricalVideo={onRestoreHistoricalShotVideo}
          />
          <ShotVideoPanel
            state={shotVideoState}
            batchSummary={shotVideoBatchSummary}
            configured={shotVideoConfigured}
            actionPending={shotVideoActionPending}
            authoritativeAsset={shotMediaReviews.video === undefined
              ? undefined
              : shotMediaReviews.video.currentSelection}
            onGenerate={onGenerateShotVideo}
            onRetry={onRetryShotVideo}
            onCancel={onCancelShotVideo}
            onResolveManualReview={onResolveShotVideoManualReview}
            onConfigure={onConfigureVideoProvider}
          />
      </div>
    </aside>
  )
}

function SourceStage({
  value,
  onChange,
  onNext,
  targetDurationSeconds,
  onTargetDurationChange,
  storyState,
  storyProgress,
  storyError,
  generationPreparing,
  hasStory,
  onGenerate,
  onConfigureProvider,
}: {
  value: string
  onChange: (value: string) => void
  onNext: () => void
  targetDurationSeconds: number
  onTargetDurationChange: (duration: number) => void
  storyState: 'idle' | 'loading' | 'generating' | 'ready' | 'error'
  storyProgress: number
  storyError: string
  generationPreparing: boolean
  hasStory: boolean
  onGenerate: () => void
  onConfigureProvider: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState('')

  const importSourceFile = async (file: File | undefined) => {
    if (!file) return
    const supportedExtension = /\.(?:txt|md)$/i.test(file.name)
    const supportedMime = !file.type || file.type === 'text/plain' || file.type === 'text/markdown'
    if (!supportedExtension || !supportedMime) {
      setImportError('仅支持 UTF-8 编码的 .txt 或 .md 文件')
      return
    }
    if (file.size > 512 * 1024) {
      setImportError('原著文件不能超过 512KB')
      return
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      if (!text.trim()) throw new Error('原著文件为空')
      if ([...text].length > 100_000) throw new Error('原著内容不能超过 100,000 个字符')
      if (text.includes('\0')) throw new Error('原著文件包含不支持的二进制内容')
      onChange(text)
      setImportError('')
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '无法读取原著文件')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="stage-panel source-stage">
      <div className="stage-toolbar">
        <div><h2>故事原文</h2><span>分集输入 · 由真实文本 Provider 生成结构剧本</span></div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            hidden
            onChange={(event) => void importSourceFile(event.target.files?.[0])}
          />
          <button className="compact-button" onClick={() => fileInputRef.current?.click()}><Upload size={14} /> 导入 TXT / MD</button>
        </div>
      </div>
      <div className="source-layout">
        <div className="source-editor">
          <div className="editor-chapter"><span>当前分集</span><strong>原著正文</strong></div>
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <footer><span>约 {value.length.toLocaleString()} 字</span><span>点击生成时以 ETag 提交到当前分集</span></footer>
          {importError && <div className="source-generation-error"><AlertTriangle size={14} /><span>{importError}</span></div>}
        </div>
        <aside className="source-config">
          <div className="config-title"><Sparkles size={16} /><strong>真实剧本生成</strong></div>
          <label>内容形态<span className="config-static-value">动态漫剧</span></label>
          <label>单集时长<div className="segmented-control">{[30, 45, 60].map((duration) => (
            <button
              className={targetDurationSeconds === duration ? 'active' : ''}
              onClick={() => onTargetDurationChange(duration)}
              key={duration}
            >{duration} 秒</button>
          ))}</div></label>
          <div className="estimate-card"><span>本次生成约束</span><strong>1–2 场 · 6–12 镜</strong><small>{value.length.toLocaleString()} 字原文 · 输出经本地 Schema 校验</small></div>
          {storyError && (
            <div className="source-generation-error">
              <AlertTriangle size={14} /><span>{storyError}</span>
              <button onClick={onConfigureProvider}>检查 Provider</button>
            </div>
          )}
          <button
            className="button primary stage-next"
            onClick={onGenerate}
            disabled={generationPreparing || storyState === 'loading' || storyState === 'generating' || !value.trim()}
          >
            {generationPreparing
              ? <><CircleDashed size={15} /> 正在保存并提交…</>
              : storyState === 'generating'
              ? <><CircleDashed size={15} /> 生成中 {storyProgress}%</>
              : <><Sparkles size={15} /> {hasStory ? '重新生成结构剧本' : '生成结构剧本'}</>}
          </button>
          <small className="source-llm-policy">
            LLM 文本生成免费；仅在你点击后创建持久幂等任务，不会触发图片、语音或视频计费。
          </small>
          {hasStory && <button className="button stage-next" onClick={onNext}>进入角色与场景准备 <ChevronRight size={15} /></button>}
        </aside>
      </div>
    </div>
  )
}

function ScriptStage({
  story,
  shots,
  activeShot,
  state,
  error,
  generationPreparing,
  onGenerate,
  onNext,
  mutationBusy,
  hasUncommittedDraft,
  onSaveScene,
  onSaveDialogue,
  onSelectShot,
  onUpdateShot,
  onSaveShot,
  onAddShot,
  onDeleteShot,
  onMoveShot,
  canUndo,
  canRedo,
  undoTitle,
  redoTitle,
  onUndo,
  onRedo,
  offlineDrafts,
  focusedEntity,
  onSceneDraftChange,
  onDialogueDraftChange,
}: {
  story: StoryDocument | null
  shots: Shot[]
  activeShot: number
  state: 'idle' | 'loading' | 'generating' | 'ready' | 'error'
  error: string
  generationPreparing: boolean
  onGenerate: () => void
  onNext: () => void
  mutationBusy: boolean
  hasUncommittedDraft: boolean
  onSaveScene: (sceneId: string, patch: StoryScenePatchInput) => Promise<void>
  onSaveDialogue: (sceneId: string, shotId: string, lineId: string, text: string) => Promise<void>
  onSelectShot: (id: number) => void
  onUpdateShot: (id: number, patch: EditableShotPatch) => void
  onSaveShot: (id: number, patch: EditableShotPatch) => Promise<void>
  onAddShot: () => void
  onDeleteShot: (id: number) => void
  onMoveShot: (id: number, delta: -1 | 1) => void
  canUndo: boolean
  canRedo: boolean
  undoTitle: string
  redoTitle: string
  onUndo: () => void
  onRedo: () => void
  offlineDrafts: Pick<OfflineStoryDraftChanges, 'scenes' | 'dialogueLines'>
  focusedEntity: StoryEntityFocus | null
  onSceneDraftChange: (sceneId: string, draft: OfflineStorySceneDraft | null) => void
  onDialogueDraftChange: (
    target: Pick<OfflineStoryDialogueLineDraft, 'sceneId' | 'shotId' | 'lineId'>,
    draft: OfflineStoryDialogueLineDraft | null,
  ) => void
}) {
  const focusKey = focusedEntity
    ? `${focusedEntity.focusRequestId}:${focusedEntity.type}:${focusedEntity.sceneId ?? ''}:${focusedEntity.shotId ?? ''}:${focusedEntity.entityId}`
    : ''

  useEffect(() => {
    if (!focusKey) return
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>('[data-story-search-focus="true"]')
      target?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      target?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusKey])

  if (!story) {
    return (
      <div className="stage-panel script-stage script-empty-state">
        <CircleDashed size={28} />
        <h2>{state === 'generating' ? '结构剧本正在生成' : '尚未生成结构剧本'}</h2>
        <p>{error || (state === 'generating'
          ? '任务可在任务中心持续查看，刷新页面不会丢失。'
          : '先使用真实文本 Provider，把原著转换为 1–2 场、6–12 镜的可编辑剧本。')}</p>
        <button className="button primary" onClick={onGenerate} disabled={generationPreparing || state === 'generating' || state === 'loading'}>
          {generationPreparing
            ? <><CircleDashed size={14} /> 正在保存并提交</>
            : <><Sparkles size={14} /> {state === 'generating' ? '生成中' : '生成结构剧本'}</>}
        </button>
      </div>
    )
  }
  const shotCount = story.scenes.reduce((total, scene) => total + scene.shots.length, 0)
  const addAvailability = scriptShotStructureAvailability({
    sceneIndex: 0,
    sceneShotCount: 1,
    totalShotCount: shotCount,
    mutationBusy,
    hasUncommittedDraft,
  })
  const commitState = scriptStageCommitState({ mutationBusy, hasUncommittedDraft })
  return (
    <div className="stage-panel script-stage">
      <div className="stage-toolbar">
        <div><h2>{story.title} · 结构剧本</h2><span>真实 Provider 输出 · 已通过本地结构与时长校验</span></div>
        <div className="score-row">
          <span>{story.scenes.length} 场</span><span>{shotCount} 镜</span><span>{story.targetDurationSeconds} 秒</span>
          <StoryRevisionControls
            canUndo={canUndo}
            canRedo={canRedo}
            undoTitle={undoTitle}
            redoTitle={redoTitle}
            onUndo={onUndo}
            onRedo={onRedo}
          />
          <button
            className="button secondary script-add-shot"
            data-script-action="add-shot"
            onClick={onAddShot}
            disabled={!addAvailability.canAdd}
            title={hasUncommittedDraft
              ? '请先保存或取消当前文本编辑'
              : shotCount >= 12
                ? 'MVP 每集最多 12 个镜头'
                : '在当前选中镜头后新增；未选择时添加到第一场'}
          >
            <Plus size={13} /> 新增镜头
          </button>
        </div>
      </div>
      <div className="script-content">
        {story.scenes.map((scene, index) => (
          <ScriptSceneEditor
            key={scene.id}
            scene={scene}
            index={index}
            mutationBusy={mutationBusy}
            hasUncommittedDraft={hasUncommittedDraft}
            localShots={shots}
            activeShot={activeShot}
            totalShotCount={shotCount}
            onSaveScene={onSaveScene}
            onSaveDialogue={onSaveDialogue}
            onSelectShot={onSelectShot}
            onUpdateShot={onUpdateShot}
            onSaveShot={onSaveShot}
            onDeleteShot={onDeleteShot}
            onMoveShot={onMoveShot}
            focusedEntity={focusedEntity}
            offlineSceneDraft={offlineDrafts.scenes.find((draft) => draft.sceneId === scene.id) ?? null}
            offlineDialogueDrafts={offlineDrafts.dialogueLines}
            onSceneDraftChange={onSceneDraftChange}
            onDialogueDraftChange={onDialogueDraftChange}
          />
        ))}
      </div>
      <div className={`stage-footer script-stage-footer ${commitState.status}`}>
        <span role="status" aria-live="polite">
          {commitState.status === 'saved'
            ? <CheckCircle2 size={14} />
            : commitState.status === 'saving'
              ? <CircleDashed size={14} />
              : <AlertTriangle size={14} />}
          {commitState.message}
        </span>
        <button
          className="button primary"
          onClick={onNext}
          disabled={!commitState.canContinue}
          title={commitState.continueTitle}
        >继续生成与确认语音 <ChevronRight size={14} /></button>
      </div>
    </div>
  )
}

function ScriptSceneEditor({
  scene,
  index,
  mutationBusy,
  hasUncommittedDraft,
  localShots,
  activeShot,
  totalShotCount,
  onSaveScene,
  onSaveDialogue,
  onSelectShot,
  onUpdateShot,
  onSaveShot,
  onDeleteShot,
  onMoveShot,
  focusedEntity,
  offlineSceneDraft,
  offlineDialogueDrafts,
  onSceneDraftChange,
  onDialogueDraftChange,
}: {
  scene: StoryDocument['scenes'][number]
  index: number
  mutationBusy: boolean
  hasUncommittedDraft: boolean
  localShots: Shot[]
  activeShot: number
  totalShotCount: number
  onSaveScene: (sceneId: string, patch: StoryScenePatchInput) => Promise<void>
  onSaveDialogue: (sceneId: string, shotId: string, lineId: string, text: string) => Promise<void>
  onSelectShot: (id: number) => void
  onUpdateShot: (id: number, patch: EditableShotPatch) => void
  onSaveShot: (id: number, patch: EditableShotPatch) => Promise<void>
  onDeleteShot: (id: number) => void
  onMoveShot: (id: number, delta: -1 | 1) => void
  focusedEntity: StoryEntityFocus | null
  offlineSceneDraft: OfflineStorySceneDraft | null
  offlineDialogueDrafts: OfflineStoryDialogueLineDraft[]
  onSceneDraftChange: (sceneId: string, draft: OfflineStorySceneDraft | null) => void
  onDialogueDraftChange: (
    target: Pick<OfflineStoryDialogueLineDraft, 'sceneId' | 'shotId' | 'lineId'>,
    draft: OfflineStoryDialogueLineDraft | null,
  ) => void
}) {
  const [editing, setEditing] = useState(() => offlineSceneDraft !== null)
  const [error, setError] = useState('')
  const title = offlineSceneDraft?.patch.title ?? scene.title
  const locationId = offlineSceneDraft?.patch.locationId ?? scene.locationId
  const timeOfDay = offlineSceneDraft?.patch.timeOfDay ?? scene.timeOfDay
  const description = offlineSceneDraft?.patch.description ?? scene.description

  useEffect(() => {
    if (offlineSceneDraft) setEditing(true)
    setError('')
  }, [offlineSceneDraft, scene.id])

  const updateDraft = (next: {
    title: string
    locationId: string
    timeOfDay: string
    description: string
  }) => {
    const patch: OfflineStorySceneDraft['patch'] = {}
    if (next.title !== scene.title) patch.title = next.title
    if (next.locationId !== scene.locationId) patch.locationId = next.locationId
    if (next.timeOfDay !== scene.timeOfDay) patch.timeOfDay = next.timeOfDay
    if (next.description !== scene.description) patch.description = next.description
    onSceneDraftChange(scene.id, Object.keys(patch).length > 0 ? { sceneId: scene.id, patch } : null)
  }

  const save = async () => {
    setError('')
    try {
      await onSaveScene(scene.id, { title, locationId, timeOfDay, description })
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '场景保存失败')
    }
  }

  return (
    <article
      className={`script-scene ${focusedEntity?.type === 'scene' && focusedEntity.entityId === scene.id ? 'story-search-focused' : ''}`}
      data-story-search-focus={focusedEntity?.type === 'scene' && focusedEntity.entityId === scene.id ? 'true' : undefined}
      tabIndex={focusedEntity?.type === 'scene' && focusedEntity.entityId === scene.id ? -1 : undefined}
    >
      <div className="scene-handle"><span /><span /><span /></div>
      <div className="scene-index"><small>场景</small><strong>{String(index + 1).padStart(2, '0')}</strong></div>
      <div className="scene-script-copy">
        {editing ? (
          <div className="scene-edit-form">
            <div><label>场景名<input disabled={mutationBusy} value={title} maxLength={200} onChange={(event) => updateDraft({ title: event.target.value, locationId, timeOfDay, description })} /></label><label>时间<input disabled={mutationBusy} value={timeOfDay} maxLength={100} onChange={(event) => updateDraft({ title, locationId, timeOfDay: event.target.value, description })} /></label></div>
            <label>地点 ID<input disabled={mutationBusy} value={locationId} maxLength={2000} onChange={(event) => updateDraft({ title, locationId: event.target.value, timeOfDay, description })} /></label>
            <label>场景描述<textarea disabled={mutationBusy} value={description} maxLength={2000} onChange={(event) => updateDraft({ title, locationId, timeOfDay, description: event.target.value })} /></label>
            {error && <div className="source-generation-error"><AlertTriangle size={13} /><span>{error}</span></div>}
            <footer><button onClick={() => { onSceneDraftChange(scene.id, null); setEditing(false); setError('') }} disabled={mutationBusy}>取消</button><button className="fix-button" onClick={() => void save()} disabled={mutationBusy || !title.trim() || !locationId.trim() || !timeOfDay.trim() || !description.trim()}>{mutationBusy ? '保存中…' : '保存场景修订'}</button></footer>
          </div>
        ) : (
          <>
            <header><strong>{scene.title} · {scene.timeOfDay}</strong><span>{scene.shots.length} 镜</span><time>{scene.shots.reduce((total, shot) => total + shot.durationSeconds, 0).toFixed(1)}s</time><button className="scene-edit-trigger" onClick={() => setEditing(true)} disabled={mutationBusy}>编辑场景</button></header>
            <p>{scene.description}</p>
          </>
        )}
        <div className="script-shot-list">
          {scene.shots.map((storyShot, shotIndex) => {
            const localShot = localShots.find((shot) => (
              shot.storyId === storyShot.id && shot.sceneId === scene.id
            )) ?? null
            return (
              <ScriptShotEditor
                key={storyShot.id}
                sceneId={scene.id}
                storyShot={storyShot}
                shot={localShot}
                shotIndex={shotIndex}
                sceneShotCount={scene.shots.length}
                totalShotCount={totalShotCount}
                active={localShot?.id === activeShot}
                mutationBusy={mutationBusy}
                hasUncommittedDraft={hasUncommittedDraft}
                focused={focusedEntity?.type === 'shot' && focusedEntity.entityId === storyShot.id}
                offlineDialogueDrafts={offlineDialogueDrafts}
                focusedEntity={focusedEntity}
                onSelect={onSelectShot}
                onUpdate={onUpdateShot}
                onSave={onSaveShot}
                onDelete={onDeleteShot}
                onMove={onMoveShot}
                onSaveDialogue={onSaveDialogue}
                onDialogueDraftChange={onDialogueDraftChange}
              />
            )
          })}
        </div>
      </div>
    </article>
  )
}

function ScriptShotEditor({
  sceneId,
  storyShot,
  shot,
  shotIndex,
  sceneShotCount,
  totalShotCount,
  active,
  mutationBusy,
  hasUncommittedDraft,
  focused,
  offlineDialogueDrafts,
  focusedEntity,
  onSelect,
  onUpdate,
  onSave,
  onDelete,
  onMove,
  onSaveDialogue,
  onDialogueDraftChange,
}: {
  sceneId: string
  storyShot: StoryDocument['scenes'][number]['shots'][number]
  shot: Shot | null
  shotIndex: number
  sceneShotCount: number
  totalShotCount: number
  active: boolean
  mutationBusy: boolean
  hasUncommittedDraft: boolean
  focused: boolean
  offlineDialogueDrafts: OfflineStoryDialogueLineDraft[]
  focusedEntity: StoryEntityFocus | null
  onSelect: (id: number) => void
  onUpdate: (id: number, patch: EditableShotPatch) => void
  onSave: (id: number, patch: EditableShotPatch) => Promise<void>
  onDelete: (id: number) => void
  onMove: (id: number, delta: -1 | 1) => void
  onSaveDialogue: (sceneId: string, shotId: string, lineId: string, text: string) => Promise<void>
  onDialogueDraftChange: (
    target: Pick<OfflineStoryDialogueLineDraft, 'sceneId' | 'shotId' | 'lineId'>,
    draft: OfflineStoryDialogueLineDraft | null,
  ) => void
}) {
  const [editing, setEditing] = useState(() => (
    shot ? scriptShotDraftChanged(shot, storyShot) : false
  ))
  const [error, setError] = useState('')

  useEffect(() => {
    setError('')
    if (shot && scriptShotDraftChanged(shot, storyShot)) setEditing(true)
  }, [shot?.storyId, storyShot])

  const structure = scriptShotStructureAvailability({
    sceneIndex: shotIndex,
    sceneShotCount,
    totalShotCount,
    mutationBusy,
    hasUncommittedDraft,
  })
  const validationError = shot ? scriptShotDraftValidationError(shot) : '镜头正在同步'

  const select = () => {
    if (shot) onSelect(shot.id)
  }

  const beginEditing = () => {
    select()
    setError('')
    setEditing(true)
  }

  const cancelEditing = () => {
    if (!shot) return
    onUpdate(shot.id, scriptShotSourcePatch(storyShot))
    setError('')
    setEditing(false)
  }

  const save = async () => {
    if (!shot || mutationBusy) return
    const nextError = scriptShotDraftValidationError(shot)
    if (nextError) {
      setError(nextError)
      return
    }
    setError('')
    try {
      await onSave(shot.id, scriptShotEditablePatch(shot))
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '镜头保存失败')
    }
  }

  return (
    <article
      className={`script-shot-editor ${active ? 'active' : ''} ${focused ? 'story-search-focused' : ''}`}
      data-script-shot-id={storyShot.id}
      data-story-search-focus={focused ? 'true' : undefined}
      tabIndex={focused ? -1 : undefined}
    >
      <header className="script-shot-heading" onClick={select}>
        <div>
          <strong>{shot?.code ?? storyShot.code} · {shot?.title ?? storyShot.title}</strong>
          <span>{shot?.framing ?? storyShot.framing} / {shot?.movement ?? storyShot.movement} / {shot?.duration ?? `${storyShot.durationSeconds.toFixed(1)}s`}</span>
        </div>
        <div className="script-shot-actions">
          <button
            type="button"
            data-script-shot-action="move-up"
            aria-label={`镜头 ${storyShot.code} 在当前场景中前移`}
            title={hasUncommittedDraft ? '请先保存或取消当前编辑' : '在当前场景中前移'}
            disabled={!shot || !structure.canMoveUp}
            onClick={(event) => { event.stopPropagation(); if (shot) onMove(shot.id, -1) }}
          ><ChevronUp size={14} /></button>
          <button
            type="button"
            data-script-shot-action="move-down"
            aria-label={`镜头 ${storyShot.code} 在当前场景中后移`}
            title={hasUncommittedDraft ? '请先保存或取消当前编辑' : '在当前场景中后移'}
            disabled={!shot || !structure.canMoveDown}
            onClick={(event) => { event.stopPropagation(); if (shot) onMove(shot.id, 1) }}
          ><ChevronDown size={14} /></button>
          <button
            type="button"
            className="script-shot-delete"
            data-script-shot-action="delete"
            aria-label={`删除镜头 ${storyShot.code}`}
            title={totalShotCount <= 6 ? '剧本至少保留 6 个镜头' : hasUncommittedDraft ? '请先保存或取消当前编辑' : '删除当前镜头'}
            disabled={!shot || !structure.canDelete}
            onClick={(event) => { event.stopPropagation(); if (shot) onDelete(shot.id) }}
          ><Trash2 size={13} /></button>
          {!editing && (
            <button
              type="button"
              className="script-shot-edit-trigger"
              data-script-shot-action="edit"
              onClick={(event) => { event.stopPropagation(); beginEditing() }}
              disabled={!shot || mutationBusy}
            >编辑镜头</button>
          )}
        </div>
      </header>

      {editing && shot ? (
        <div className="script-shot-edit-form" data-script-shot-editor={storyShot.id}>
          <div className="script-shot-identity-fields">
            <label>镜头编号<input
              aria-label={`镜头 ${storyShot.code} 编号`}
              disabled={mutationBusy}
              value={shot.code}
              maxLength={2000}
              onChange={(event) => onUpdate(shot.id, { code: event.target.value })}
            /></label>
            <label>镜头标题<input
              aria-label={`镜头 ${storyShot.code} 标题`}
              disabled={mutationBusy}
              value={shot.title}
              maxLength={2000}
              onChange={(event) => onUpdate(shot.id, { title: event.target.value })}
            /></label>
          </div>
          <label>画面描述<textarea
            aria-label={`镜头 ${storyShot.code} 画面描述`}
            disabled={mutationBusy}
            value={shot.copy}
            maxLength={2000}
            onChange={(event) => onUpdate(shot.id, { copy: event.target.value })}
          /></label>
          <div className="script-shot-language-fields">
            <label>景别<input
              aria-label={`镜头 ${storyShot.code} 景别`}
              disabled={mutationBusy}
              value={shot.framing}
              maxLength={100}
              onChange={(event) => onUpdate(shot.id, { framing: event.target.value })}
            /></label>
            <label>运镜<input
              aria-label={`镜头 ${storyShot.code} 运镜`}
              disabled={mutationBusy}
              value={shot.movement}
              maxLength={100}
              onChange={(event) => onUpdate(shot.id, { movement: event.target.value })}
            /></label>
            <label title="仅作为剧本建议保存；当前 OpenCut 时间线与正式导出固定使用硬切">转场建议（成片只硬切）<input
              aria-label={`镜头 ${storyShot.code} 转场建议，不影响当前成片`}
              disabled={mutationBusy}
              value={shot.transition ?? ''}
              maxLength={100}
              placeholder="剧本元数据；当前导出固定硬切"
              onChange={(event) => onUpdate(shot.id, { transition: event.target.value })}
            /></label>
            <label>时长（秒）<input
              aria-label={`镜头 ${storyShot.code} 时长`}
              disabled={mutationBusy}
              type="number"
              min="0.5"
              max="15"
              step="0.1"
              value={Number.isFinite(Number.parseFloat(shot.duration)) ? Number.parseFloat(shot.duration) : ''}
              onChange={(event) => onUpdate(shot.id, { duration: `${event.target.value}s` })}
            /></label>
          </div>
          <label>镜头视觉 Prompt<textarea
            aria-label={`镜头 ${storyShot.code} 视觉 Prompt`}
            disabled={mutationBusy}
            value={shot.visualPrompt}
            maxLength={4000}
            onChange={(event) => onUpdate(shot.id, { visualPrompt: event.target.value })}
          /></label>
          {error && <div className="source-generation-error"><AlertTriangle size={13} /><span>{error}</span></div>}
          <footer>
            <span>{scriptShotDraftChanged(shot, storyShot) ? '本地草稿，尚未写入剧本修订' : '当前字段与已保存修订一致'}</span>
            <button type="button" onClick={cancelEditing} disabled={mutationBusy}>取消</button>
            <button
              type="button"
              className="fix-button"
              data-script-shot-action="save"
              onClick={() => void save()}
              disabled={mutationBusy || Boolean(validationError)}
              title={validationError ?? '保存为不可变剧本修订'}
            >{mutationBusy ? '保存中…' : '保存镜头修订'}</button>
          </footer>
        </div>
      ) : (
        <p>{shot?.copy ?? storyShot.description}</p>
      )}

      {storyShot.dialogueLines.map((line) => (
        <ScriptDialogueEditor
          key={line.id}
          sceneId={sceneId}
          shotId={storyShot.id}
          line={line}
          mutationBusy={mutationBusy}
          onSave={onSaveDialogue}
          focused={focusedEntity?.type === 'dialogue'
            && focusedEntity.sceneId === sceneId
            && focusedEntity.shotId === storyShot.id
            && focusedEntity.entityId === line.id}
          offlineDraft={offlineDialogueDrafts.find((draft) => (
            draft.sceneId === sceneId
            && draft.shotId === storyShot.id
            && draft.lineId === line.id
          )) ?? null}
          onDraftChange={onDialogueDraftChange}
        />
      ))}
    </article>
  )
}

function ScriptDialogueEditor({
  sceneId,
  shotId,
  line,
  mutationBusy,
  onSave,
  focused,
  offlineDraft,
  onDraftChange,
}: {
  sceneId: string
  shotId: string
  line: StoryDocument['scenes'][number]['shots'][number]['dialogueLines'][number]
  mutationBusy: boolean
  onSave: (sceneId: string, shotId: string, lineId: string, text: string) => Promise<void>
  focused: boolean
  offlineDraft: OfflineStoryDialogueLineDraft | null
  onDraftChange: (
    target: Pick<OfflineStoryDialogueLineDraft, 'sceneId' | 'shotId' | 'lineId'>,
    draft: OfflineStoryDialogueLineDraft | null,
  ) => void
}) {
  const [editing, setEditing] = useState(() => offlineDraft !== null)
  const [error, setError] = useState('')
  const text = offlineDraft?.text ?? line.text
  useEffect(() => {
    if (offlineDraft) setEditing(true)
    setError('')
  }, [line.id, offlineDraft])
  const target = { sceneId, shotId, lineId: line.id }
  const updateDraft = (nextText: string) => {
    onDraftChange(target, nextText !== line.text ? { ...target, text: nextText } : null)
  }
  const save = async () => {
    setError('')
    try {
      await onSave(sceneId, shotId, line.id, text)
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '台词保存失败')
    }
  }
  return (
    <div
      className={`script-dialogue editable ${focused ? 'story-search-focused' : ''}`}
      data-script-dialogue-line-id={line.id}
      data-story-search-focus={focused ? 'true' : undefined}
      tabIndex={focused ? -1 : undefined}
    >
      <Mic2 size={13} />
      <strong>{line.kind === 'narration' ? '旁白' : line.speaker}：</strong>
      {editing ? <input disabled={mutationBusy} value={text} maxLength={1000} onChange={(event) => updateDraft(event.target.value)} autoFocus /> : <span>{line.text}</span>}
      {editing ? (
        <><button onClick={() => { onDraftChange(target, null); setEditing(false) }} disabled={mutationBusy}>取消</button><button data-script-dialogue-action="save" onClick={() => void save()} disabled={mutationBusy || !text.trim()}>保存</button></>
      ) : <button data-script-dialogue-action="edit" onClick={() => setEditing(true)} disabled={mutationBusy}>编辑</button>}
      {error && <small>{error}</small>}
    </div>
  )
}

function AssetsStage({
  story,
  targets,
  assets,
  jobs,
  sourceRevisionId,
  voiceScope,
  focusedCharacterId,
  focusedTarget,
  imageProvider,
  miniMaxProvider,
  textProvider,
  narratorVoiceProfile,
  narratorVoiceState,
  narratorVoiceError,
  state,
  error,
  actionKey,
  editCompletionVersion,
  paidConfirmationActive,
  onGenerate,
  onEdit,
  onDeriveTurnaround,
  onLockTurnaround,
  onRetry,
  onLock,
  onAdoptHistorical,
  onRefresh,
  onConfigureProvider,
  onVoiceProfileSaved,
  onNarratorVoiceReload,
  onNarratorVoiceSaved,
  onNext,
}: {
  story: StoryDocument | null
  targets: VisualAssetTarget[]
  assets: MediaAsset[]
  jobs: GenerationJob[]
  sourceRevisionId: string | null
  voiceScope: {
    projectId: string
    episodeId: string
    episodeEtag: string
    sourceRevisionId: string
  } | null
  focusedCharacterId: string | null
  focusedTarget: { type: VisualAssetTarget['type']; id: string } | null
  imageProvider: ProviderConnection | null
  miniMaxProvider: ProviderConnection | null
  textProvider: ProviderConnection | null
  narratorVoiceProfile: ProjectNarratorVoiceProfileState | null
  narratorVoiceState: 'idle' | 'loading' | 'ready' | 'error'
  narratorVoiceError: string
  state: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  actionKey: string | null
  editCompletionVersion: number
  paidConfirmationActive: boolean
  onGenerate: (target: VisualAssetTarget) => void
  onEdit: (
    target: VisualAssetTarget,
    source: MediaAsset,
    submission: VisualAssetEditSubmission,
  ) => Promise<void>
  onDeriveTurnaround: (
    target: VisualAssetTarget,
    source: MediaAsset,
    crops: TurnaroundCrops,
  ) => Promise<void>
  onLockTurnaround: (
    target: VisualAssetTarget,
    references: CharacterTurnaroundReferenceSet,
  ) => Promise<void>
  onRetry: (target: VisualAssetTarget, job: GenerationJob) => void
  onLock: (target: VisualAssetTarget, assetId: string) => void
  onAdoptHistorical: (target: VisualAssetTarget, asset: MediaAsset) => Promise<void>
  onRefresh: () => void
  onConfigureProvider: () => void
  onVoiceProfileSaved: (result: CharacterVoiceProfileMutationResponse) => void
  onNarratorVoiceReload: () => void
  onNarratorVoiceSaved: (result: ProjectNarratorVoiceProfileMutationResponse) => void
  onNext: () => void
}) {
  const [tab, setTab] = useState<VisualAssetTarget['type']>('character')
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ url: string; name: string; version: number } | null>(null)
  const [editSource, setEditSource] = useState<MediaAsset | null>(null)
  const [editError, setEditError] = useState('')
  const [turnaroundSource, setTurnaroundSource] = useState<MediaAsset | null>(null)
  const [turnaroundError, setTurnaroundError] = useState('')
  const [voiceAcceptanceRequest, setVoiceAcceptanceRequest] = useState<{
    key: string
    sequence: number
  } | null>(null)
  useEffect(() => {
    if (!editSource) return
    setEditSource(null)
    setEditError('')
  }, [editCompletionVersion])
  const tabLabels: Record<VisualAssetTarget['type'], string> = {
    character: '角色',
    location: '场景',
    prop: '道具',
  }
  const visibleTargets = targets.filter((target) => target.type === tab)
  const selectedTarget = visibleTargets.find((target) => target.id === selectedTargetId)
    ?? visibleTargets[0]
    ?? null
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))
  const jobsForTarget = (target: VisualAssetTarget) => jobs.filter((job) => {
    const binding = visualAssetJobBinding(job)
    return binding?.entityType === target.type
      && binding.entityId === target.id
  })
  const selectedJobs = selectedTarget ? jobsForTarget(selectedTarget) : []
  const selectedCurrentJobs = selectedJobs.filter((job) => (
    visualAssetJobBinding(job)?.expectedRevisionId === sourceRevisionId
    && !generationJobIsStale(job)
  ))
  const selectedCandidateJobs = selectedJobs.filter((job) => (
    job.type === 'asset.image.generate'
    || job.type === 'asset.image.edit'
    || job.type === 'asset.image.history.adopt'
  ))
  const selectedTurnaroundJobs = selectedJobs.filter((job) => job.type === 'asset.image.turnaround.derive')
  const selectedCandidates = selectedCandidateJobs.flatMap((job) => (
    job.status === 'succeeded'
      ? generatedImagesFromJob(job).flatMap((image) => {
          const asset = assetById.get(image.id)
          // Job output is only a pointer. Candidate display and locking use the
          // persisted Asset as the authoritative URL/version/checksum source.
          if (!asset
            || asset.status !== 'ready'
            || !asset.mimeType?.startsWith('image/')
            || !asset.checksum
            || asset.generationJobId !== job.id
            || asset.projectId !== job.projectId
            || asset.episodeId !== job.episodeId) return []
          const provenance = visualAssetCandidateProvenance(asset, job)
          if (job.type === 'asset.image.edit'
            && (!provenance.sourceAssetId || asset.parentAssetId !== provenance.sourceAssetId)) return []
          return [{
            image: { ...image, url: asset.url },
            asset,
            job,
            isCurrentRevision: asset.sourceRevisionId === sourceRevisionId
              && visualAssetJobBinding(job)?.expectedRevisionId === sourceRevisionId,
          }]
        })
      : []
  ))
  const selectedCurrentCandidates = selectedCandidates.filter((candidate) => candidate.isCurrentRevision)
  const selectedHistoricalCandidates = selectedCandidates.filter((candidate) => !candidate.isCurrentRevision)
  const activeJob = selectedCurrentJobs.find((job) => ['queued', 'running', 'waiting_provider'].includes(job.status))
  const activeTurnaroundJob = selectedCurrentJobs.find((job) => (
    job.type === 'asset.image.turnaround.derive'
    && ['queued', 'running', 'waiting_provider'].includes(job.status)
  ))
  const failedJobs = selectedCurrentJobs.filter((job) => (
    (job.type === 'asset.image.generate' || job.type === 'asset.image.edit')
    && job.status === 'failed'
  ))
  const failedTurnaroundJobs = selectedCurrentJobs.filter((job) => (
    job.type === 'asset.image.turnaround.derive'
    && job.status === 'failed'
  ))
  const selectedGenerating = selectedTarget
    ? actionKey === `generate:${selectedTarget.type}:${selectedTarget.id}`
    : false
  const lockedCount = targets.filter((target) => {
    const asset = target.lockedAssetId ? assetById.get(target.lockedAssetId) : null
    return asset?.status === 'ready'
  }).length
  const unresolvedBindingNames = targets.flatMap((target) => {
    const asset = target.lockedAssetId ? assetById.get(target.lockedAssetId) : null
    return asset?.status === 'ready'
      ? []
      : [target.name]
  })
  const imageEditCapability = {
    label: imageProvider?.label ?? '未配置图片 Provider',
    model: imageProvider?.model,
    edit: imageProvider?.capabilities.includes('edit') ?? false,
    variations: imageProvider?.capabilities.includes('variations') ?? false,
    multiReference: imageProvider?.capabilities.includes('multi-reference') ?? false,
  }
  const manifestRefreshKey = [
    sourceRevisionId ?? 'no-source',
    ...targets.map((target) => [
      target.type,
      target.id,
      target.lockedAssetId ?? '-',
      target.lockedReferences?.frontAssetId ?? '-',
      target.lockedReferences?.sideAssetId ?? '-',
      target.lockedReferences?.backAssetId ?? '-',
    ].join(':')),
    ...assets.map((asset) => `${asset.id}:${asset.status}:${asset.checksum ?? '-'}`),
  ].join('|')
  const voicedCharacterNames = new Set(story?.scenes.flatMap((scene) => (
    scene.shots.flatMap((shot) => shot.dialogueLines.flatMap((line) => (
      line.kind === 'dialogue' ? [line.speaker] : []
    )))
  )) ?? [])
  const voiceAcceptanceTargets: VoiceAcceptanceTarget[] = voiceScope && story
    ? [
        {
          key: 'project_narrator',
          subjectType: 'project_narrator',
          subjectId: voiceScope.projectId,
          name: '项目旁白',
          voiceId: narratorVoiceProfile?.voiceProfile?.voiceId ?? null,
        },
        ...story.characters.filter((character) => voicedCharacterNames.has(character.name)).map((character) => ({
          key: `character:${character.id}`,
          subjectType: 'character' as const,
          subjectId: character.id,
          name: `角色 · ${character.name}`,
          voiceId: character.voiceProfile?.voiceId ?? null,
        })),
      ]
    : []

  const openVoiceAcceptanceTarget = (target: VoiceAcceptanceTarget) => {
    const sequence = (voiceAcceptanceRequest?.sequence ?? 0) + 1
    if (target.subjectType === 'character') {
      setTab('character')
      setSelectedTargetId(target.subjectId)
    }
    setVoiceAcceptanceRequest({ key: target.key, sequence })
  }

  useEffect(() => {
    if (!visibleTargets.some((target) => target.id === selectedTargetId)) {
      setSelectedTargetId(visibleTargets[0]?.id ?? null)
    }
  }, [selectedTargetId, tab, targets])

  useEffect(() => {
    if (!editSource) return
    if (!selectedCandidates.some(({ asset }) => asset.id === editSource.id)) {
      setEditSource(null)
      setEditError('')
    }
  }, [editSource, selectedCandidates])

  useEffect(() => {
    if (!turnaroundSource) return
    if (!selectedCandidates.some(({ asset }) => asset.id === turnaroundSource.id)) {
      setTurnaroundSource(null)
      setTurnaroundError('')
    }
  }, [selectedCandidates, turnaroundSource])

  useEffect(() => {
    const requested = focusedTarget ?? (focusedCharacterId
      ? { type: 'character' as const, id: focusedCharacterId }
      : null)
    if (!requested) return
    const focused = targets.find((target) => (
      target.type === requested.type && target.id === requested.id
    ))
    if (!focused) return
    setTab(focused.type)
    setSelectedTargetId(focused.id)
  }, [focusedCharacterId, focusedTarget, targets])

  useEffect(() => {
    if (!focusedTarget
      || focusedTarget.type !== tab
      || focusedTarget.id !== selectedTargetId) return
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-visual-target-type="${focusedTarget.type}"][data-visual-target-id="${focusedTarget.id}"]`,
      )
      target?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      target?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusedTarget, selectedTargetId, tab])

  return (
    <div className="stage-panel assets-stage">
      <div className="stage-toolbar">
        <div>
          <h2>本集角色与场景引用</h2>
          <span>{lockedCount}/{targets.length} 个实体已设为本集引用 · Catalog 素材不会在这里被删除或改写</span>
        </div>
        <div className="assets-tabs">{(Object.keys(tabLabels) as VisualAssetTarget['type'][]).map((item) => (
          <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>
            {tabLabels[item]} <small>{targets.filter((target) => target.type === item).length}</small>
          </button>
        ))}</div>
        <div className="asset-toolbar-actions">
          <button className="button secondary" onClick={onRefresh} disabled={state === 'loading'}>
            <RefreshCcw size={14} /> 刷新
          </button>
          <button
            className="button primary"
            onClick={() => selectedTarget && onGenerate(selectedTarget)}
            disabled={!selectedTarget || Boolean(activeJob) || Boolean(actionKey)}
          >
            <Sparkles size={14} /> {selectedGenerating || activeJob
              ? '生成中…'
              : selectedCurrentCandidates.length
                ? '再生成一版'
                : selectedHistoricalCandidates.length
                  ? '生成当前修订候选'
                  : '生成候选'}
          </button>
        </div>
      </div>
      {voiceScope && (
        <>
          {voiceAcceptanceTargets.length > 0 && (
            <VoiceAcceptanceChecklist
              projectId={voiceScope.projectId}
              episodeId={voiceScope.episodeId}
              sourceRevisionId={voiceScope.sourceRevisionId}
              targets={voiceAcceptanceTargets}
              onOpen={openVoiceAcceptanceTarget}
            />
          )}
          <ProjectNarratorVoiceCard
            projectId={voiceScope.projectId}
            episodeId={voiceScope.episodeId}
            episodeEtag={voiceScope.episodeEtag}
            sourceRevisionId={voiceScope.sourceRevisionId}
            profileState={narratorVoiceProfile}
            state={narratorVoiceState}
            error={narratorVoiceError}
            miniMaxProvider={miniMaxProvider}
            onConfigureProvider={onConfigureProvider}
            onReload={onNarratorVoiceReload}
            onSaved={onNarratorVoiceSaved}
            attentionRequest={voiceAcceptanceRequest?.key === 'project_narrator'
              ? voiceAcceptanceRequest.sequence
              : 0}
          />
        </>
      )}
      <div className="visual-asset-workbench">
        <aside className="visual-entity-list">
          {visibleTargets.map((target) => {
            const targetJobs = jobsForTarget(target)
            const currentTargetJobs = targetJobs.filter((job) => (
              visualAssetJobBinding(job)?.expectedRevisionId === sourceRevisionId
              && !generationJobIsStale(job)
            ))
            const generatedAssets = targetJobs.flatMap((job) => (
              job.status === 'succeeded'
                ? generatedImagesFromJob(job).flatMap((image) => {
                    const asset = assetById.get(image.id)
                    return asset
                      && asset.status === 'ready'
                      && asset.mimeType?.startsWith('image/')
                      && asset.checksum
                      && asset.generationJobId === job.id
                      && asset.projectId === job.projectId
                      && asset.episodeId === job.episodeId
                      && (job.type !== 'asset.image.edit'
                        || asset.parentAssetId === visualAssetCandidateProvenance(asset, job).sourceAssetId)
                      ? [asset]
                      : []
                  })
                : []
            ))
            const generatedAsset = generatedAssets.find((asset) => asset.sourceRevisionId === sourceRevisionId)
              ?? generatedAssets[0]
            const lockedAsset = target.lockedAssetId ? assetById.get(target.lockedAssetId) : undefined
            const currentLockedAsset = lockedAsset?.status === 'ready' ? lockedAsset : undefined
            const latestAsset = currentLockedAsset ?? generatedAsset ?? lockedAsset
            const historicalOnly = Boolean(latestAsset && latestAsset.sourceRevisionId !== sourceRevisionId)
            const running = currentTargetJobs.some((job) => ['queued', 'running', 'waiting_provider'].includes(job.status))
            const failed = currentTargetJobs.some((job) => job.status === 'failed')
            return (
              <button
                className={target.id === selectedTarget?.id ? 'active' : ''}
                key={`${target.type}:${target.id}`}
                data-visual-target-type={target.type}
                data-visual-target-id={target.id}
                onClick={() => setSelectedTargetId(target.id)}
              >
                <span className={`visual-entity-thumb ${latestAsset ? '' : 'empty'}`}>
                  {latestAsset ? <img src={latestAsset.url} alt="" /> : [...target.name][0]}
                </span>
                <span className="visual-entity-copy">
                  <strong>{target.name}</strong>
                  <small>{target.role ?? target.visualDescription}</small>
                </span>
                <span className={`visual-entity-status ${currentLockedAsset ? 'locked' : running ? 'running' : failed ? 'failed' : historicalOnly ? 'historical' : ''}`}>
                  {currentLockedAsset
                    ? '本集已引用'
                    : running
                      ? '生成中'
                      : historicalOnly
                          ? '历史候选'
                        : latestAsset
                          ? '待选择'
                          : failed ? '失败' : '未生成'}
                </span>
              </button>
            )
          })}
          {state === 'loading' && <div className="visual-workbench-message"><CircleDashed size={18} /> 正在同步实体与候选…</div>}
          {state === 'error' && (
            <div className="visual-workbench-message error">
              <AlertTriangle size={18} /><span>{error}</span><button onClick={onRefresh}>重试</button>
            </div>
          )}
          {state !== 'loading' && visibleTargets.length === 0 && (
            <div className="visual-workbench-message"><Library size={18} /> {story ? `结构剧本中没有${tabLabels[tab]}` : '请先生成结构剧本'}</div>
          )}
        </aside>

        <section className="visual-candidate-panel">
          {selectedTarget ? (
            <>
              <header className="visual-target-header">
                <div>
                  <small>{tabLabels[selectedTarget.type]}实体 · 设定修订 r{selectedTarget.version}</small>
                  <h2>{selectedTarget.name}</h2>
                  <p>{selectedTarget.description || '暂无剧情描述'}</p>
                </div>
                <span className={selectedTarget.lockedAssetId
                  && assetById.get(selectedTarget.lockedAssetId)?.status === 'ready'
                  ? 'locked' : ''}>
                  <LockKeyhole size={13} /> {selectedTarget.lockedAssetId
                    && assetById.get(selectedTarget.lockedAssetId)?.status === 'ready'
                    ? assetById.get(selectedTarget.lockedAssetId)?.sourceRevisionId === sourceRevisionId
                      ? '本集已引用视觉版本'
                      : '本集已引用 · 源自旧剧本修订'
                    : selectedHistoricalCandidates.length
                      ? '有历史版本可恢复'
                      : '尚未选择本集版本'}
                </span>
              </header>
              {selectedTarget.type === 'character' && story && voiceScope && (() => {
                const character = story.characters.find((candidate) => candidate.id === selectedTarget.id)
                return character ? (
                  <CharacterVoiceCastingCard
                    character={character}
                    story={story}
                    projectId={voiceScope.projectId}
                    episodeId={voiceScope.episodeId}
                    episodeEtag={voiceScope.episodeEtag}
                    sourceRevisionId={voiceScope.sourceRevisionId}
                    miniMaxProvider={miniMaxProvider}
                    textProvider={textProvider}
                    onConfigureProvider={onConfigureProvider}
                    onSaved={onVoiceProfileSaved}
                    attentionRequest={voiceAcceptanceRequest?.key === `character:${character.id}`
                      ? voiceAcceptanceRequest.sequence
                      : 0}
                  />
                ) : null
              })()}
              <div className="visual-constraints">
                <strong>服务端固化的视觉约束</strong>
                <p>{selectedTarget.visualDescription || '结构剧本尚未提供视觉描述'}</p>
                <small>支持持久化指令编辑、原生变体与最多 4 张同实体参考图；Catalog 版本长期保留，本集使用哪一版只在此制作阶段确认。</small>
              </div>
              {selectedHistoricalCandidates.length > 0 && (
                <div className="visual-history-notice" role="status">
                  <History size={15} />
                  <div>
                    <strong>{selectedHistoricalCandidates.length} 个历史版本仍在项目资产库</strong>
                    <span>它们没有丢失。旧版本保持不可变；只有“零费用继承”会在服务端完成语义核验，并为当前修订创建新版本，不调用 Provider。</span>
                  </div>
                </div>
              )}
              <div className="visual-candidate-grid">
                {activeJob && (
                  <article className="visual-job-card running">
                    <div><WandSparkles size={23} /><strong>{activeJob.type === 'asset.image.turnaround.derive' ? '本地三视图派生中' : '真实任务执行中'}</strong><span>{activeJob.progress}% · {activeJob.type === 'asset.image.turnaround.derive' ? '本地 FFmpeg，不调用 Provider' : activeJob.status === 'waiting_provider' ? '等待 Provider' : '生成队列'}</span></div>
                    <footer><span>Job {activeJob.id.slice(0, 8)}</span><span>{activeJob.type === 'asset.image.turnaround.derive' ? 'renderer:ffmpeg' : activeJob.model ?? activeJob.providerId ?? '图片 Provider'}</span></footer>
                  </article>
                )}
                {selectedCandidates.map(({ image, asset, job, isCurrentRevision }) => {
                  const locked = selectedTarget.lockedAssetId === image.id
                  const historicallyLocked = locked && !isCurrentRevision
                  const version = asset.version
                  const locking = actionKey === `lock:${selectedTarget.type}:${selectedTarget.id}:${image.id}`
                  const editing = actionKey === `edit:${image.id}`
                  const adopting = actionKey === `history-adopt:${selectedTarget.type}:${selectedTarget.id}:${image.id}`
                  const provenance = visualAssetCandidateProvenance(asset, job)
                  const sourceAsset = provenance.sourceAssetId
                    ? assetById.get(provenance.sourceAssetId) ?? null
                    : null
                  const operationLabel = provenance.operation === 'history-adopt'
                    ? '历史继承'
                    : provenance.operation === 'edit'
                    ? '指令编辑'
                    : provenance.operation === 'variation'
                      ? '原生变体'
                      : '文本生成'
                  const provenanceLabel = provenance.operation === 'history-adopt'
                    ? sourceAsset
                      ? `零 Provider 继承自不可变版本 v${sourceAsset.version}`
                      : '由服务端完成语义核验并继承的历史版本'
                    : provenance.operation === 'edit'
                    ? sourceAsset
                      ? `编辑自候选 v${sourceAsset.version} · ${provenance.referenceAssetIds.length} 张附加参考`
                      : '编辑自已固化源图（源候选当前不可见）'
                    : provenance.operation === 'variation'
                      ? sourceAsset
                        ? `原生变体自候选 v${sourceAsset.version}`
                        : '原生变体自已固化源图（源候选当前不可见）'
                      : asset.parentAssetId
                        ? '同设定重新生成；前序候选未作为图片输入'
                        : '首个不可变候选版本'
                  const turnaroundSet = selectedTarget.type === 'character'
                    ? [...selectedTurnaroundJobs]
                        .filter((candidate) => candidate.status === 'succeeded')
                        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                        .flatMap((turnaroundJob) => {
                          const byRole = Object.fromEntries((['front', 'side', 'back'] as const).map((role) => [
                            role,
                            assets.find((candidate) => (
                              candidate.generationJobId === turnaroundJob.id
                              && candidate.parentAssetId === asset.id
                              && candidate.kind === `character-reference.${role}`
                              && candidate.status === 'ready'
                              && candidate.sourceRevisionId === asset.sourceRevisionId
                              && candidate.mimeType?.startsWith('image/')
                              && candidate.checksum
                            )),
                          ])) as Partial<CharacterTurnaroundReferenceSet>
                          return byRole.front && byRole.side && byRole.back
                            ? [byRole as CharacterTurnaroundReferenceSet]
                            : []
                        })[0] ?? null
                    : null
                  const turnaroundViews = turnaroundSet
                    ? (['front', 'side', 'back'] as const).map((role) => ({
                        role,
                        asset: turnaroundSet[role],
                      }))
                    : []
                  const turnaroundReferencesLocked = Boolean(
                    isCurrentRevision
                    && turnaroundSet
                    && selectedTarget.lockedReferences?.frontAssetId === turnaroundSet.front.id
                    && selectedTarget.lockedReferences?.sideAssetId === turnaroundSet.side.id
                    && selectedTarget.lockedReferences?.backAssetId === turnaroundSet.back.id,
                  )
                  const turnaroundLocking = Boolean(
                    turnaroundSet
                    && actionKey === `turnaround-lock:${selectedTarget.id}:${asset.id}`,
                  )
                  return (
                    <article className={`visual-candidate-card ${locked ? 'locked' : ''} ${isCurrentRevision ? '' : 'historical'}`} key={image.id}>
                      <button
                        className="visual-candidate-image"
                        onClick={() => setPreview({ url: image.url, name: selectedTarget.name, version })}
                        aria-label={`预览${selectedTarget.name}候选 v${version}`}
                      >
                        <img src={image.url} alt={`${selectedTarget.name}候选 v${version}`} />
                        <span><Maximize2 size={13} /> 预览</span>
                        {locked && !historicallyLocked && <em><LockKeyhole size={11} /> 本集引用</em>}
                        {historicallyLocked && <em className="historical"><History size={11} /> 本集引用 · 旧源修订</em>}
                        {!isCurrentRevision && !historicallyLocked && <em className="historical"><History size={11} /> 历史版本</em>}
                      </button>
                      <div className="visual-candidate-meta">
                        <div><strong>候选 v{version} · {operationLabel}</strong><small>{isCurrentRevision ? '当前修订' : `历史修订 ${asset.sourceRevisionId?.slice(0, 8) ?? 'unknown'}`} · {new Date(job.createdAt).toLocaleString('zh-CN')}</small></div>
                        <p>{provenanceLabel}</p>
                        {turnaroundViews.length > 0 && (
                          <div className={`visual-turnaround-views ${turnaroundReferencesLocked ? 'locked' : ''}`} aria-label={turnaroundReferencesLocked ? '已绑定的角色三视图' : '已持久化三视图裁切'}>
                            {turnaroundViews.map(({ role, asset: viewAsset }) => (
                              <button
                                type="button"
                                key={role}
                                onClick={() => setPreview({
                                  url: viewAsset.url,
                                  name: `${selectedTarget.name}·${role === 'front' ? '正面' : role === 'side' ? '侧面' : '背面'}`,
                                  version: viewAsset.version,
                                })}
                              >
                                <img src={viewAsset.url} alt={`${selectedTarget.name}${role === 'front' ? '正面' : role === 'side' ? '侧面' : '背面'}参考图`} />
                                <span>{role === 'front' ? '正' : role === 'side' ? '侧' : '背'}</span>
                              </button>
                            ))}
                            {turnaroundReferencesLocked && <em><LockKeyhole size={10} /> 角色引用</em>}
                          </div>
                        )}
                        <footer>
                          <span>{provenance.operation === 'history-adopt'
                            ? '本地版本继承 · 零 Provider'
                            : job.model ?? job.providerId ?? '图片 Provider'}</span>
                          <div className="visual-candidate-actions">
                            {!isCurrentRevision && (
                              <button
                                className="history-adopt"
                                onClick={() => void onAdoptHistorical(selectedTarget, asset).catch(() => undefined)}
                                disabled={Boolean(actionKey) || Boolean(activeJob)}
                                title="服务端先核验实体语义、风格、画幅与校验和；通过后复制为当前修订的新不可变版本，不调用 Provider"
                              >
                                <History size={12} /> {adopting ? '继承中…' : '零费用继承'}
                              </button>
                            )}
                            {selectedTarget.type === 'character' && (
                              <button
                                onClick={() => {
                                  setTurnaroundError('')
                                  setTurnaroundSource(asset)
                                }}
                                disabled={!isCurrentRevision || Boolean(actionKey) || Boolean(activeJob)}
                                title={!isCurrentRevision
                                  ? '历史版本需先零费用继承到当前修订，才能继续拆分'
                                  : '人工确认裁切框后，由本地 FFmpeg 派生三张持久参考图'}
                              >
                                <Scissors size={12} /> {turnaroundViews.length === 3 ? '重新拆分' : '拆分三视图'}
                              </button>
                            )}
                            {selectedTarget.type === 'character' && turnaroundSet && (
                              <button
                                className={turnaroundReferencesLocked ? 'locked' : ''}
                                onClick={() => void onLockTurnaround(selectedTarget, turnaroundSet)}
                                disabled={!isCurrentRevision || turnaroundReferencesLocked || Boolean(actionKey) || Boolean(activeJob)}
                                title="一次事务绑定正面、侧面、背面；不会替换角色主视觉候选"
                              >
                                <LockKeyhole size={12} /> {turnaroundLocking ? '绑定中…' : turnaroundReferencesLocked ? '三视图已绑定' : '绑定三视图'}
                              </button>
                            )}
                            <button
                              onClick={() => {
                                setEditError('')
                                setEditSource(asset)
                              }}
                              disabled={Boolean(actionKey)
                                || Boolean(activeJob)
                                || !isCurrentRevision
                                || (!imageEditCapability.edit && !imageEditCapability.variations)}
                              title={!isCurrentRevision
                                ? '历史版本需先零费用继承到当前修订，才能作为编辑源'
                                : !imageEditCapability.edit && !imageEditCapability.variations
                                ? '当前图片 Provider 未声明 edit 或 variations 能力'
                                : '以此不可变候选为源图创建新版本'}
                            >
                              <WandSparkles size={12} /> {editing ? '提交中…' : '编辑 / 变体'}
                            </button>
                            <button
                              className={locked ? 'locked' : ''}
                              onClick={() => onLock(selectedTarget, image.id)}
                              disabled={!isCurrentRevision || locked || Boolean(actionKey)}
                            >
                              <LockKeyhole size={12} /> {locked
                                ? '本集已引用'
                                : isCurrentRevision
                                  ? locking ? '设置中…' : '设为本集引用'
                                  : '等待语义核验继承'}
                            </button>
                          </div>
                        </footer>
                      </div>
                    </article>
                  )
                })}
                {failedJobs.map((job) => (
                  (() => {
                    const provenance = job.type === 'asset.image.edit'
                      ? visualAssetJobProvenance(job)
                      : null
                    const failedEditSource = provenance?.sourceAssetId
                      ? assetById.get(provenance.sourceAssetId) ?? null
                      : null
                    const failedOperation = provenance?.operation === 'variation'
                      ? '原生变体'
                      : provenance?.operation === 'edit'
                        ? '图片编辑'
                        : '候选生成'
                    return (
                      <article className="visual-job-card failed" key={job.id}>
                        <div><AlertTriangle size={23} /><strong>{failedOperation}失败</strong><span>{job.error?.message ?? '图片 Provider 未返回可用结果'}</span></div>
                        <footer>
                          <span>Job {job.id.slice(0, 8)}</span>
                          {job.type === 'asset.image.edit' ? (
                            <button
                              onClick={() => {
                                if (!failedEditSource) return
                                setEditError('上次任务未成功；请重新核对指令与参考图，先做免费预检，再明确确认新任务。')
                                setEditSource(failedEditSource)
                              }}
                              disabled={Boolean(actionKey) || !failedEditSource}
                            >
                              <WandSparkles size={12} /> 重新预检编辑
                            </button>
                          ) : (
                            <button onClick={() => onRetry(selectedTarget, job)} disabled={Boolean(actionKey)}>
                              <RefreshCcw size={12} /> {job.error?.retryable ? '重新预检生成' : '新建候选'}
                            </button>
                          )}
                        </footer>
                      </article>
                    )
                  })()
                ))}
                {failedTurnaroundJobs.map((job) => (
                  <article className="visual-job-card failed" key={job.id}>
                    <div><AlertTriangle size={23} /><strong>三视图本地派生失败</strong><span>{job.error?.message ?? 'FFmpeg 未返回完整的三张参考图'}</span></div>
                    <footer><span>Job {job.id.slice(0, 8)} · 零 Provider 调用</span></footer>
                  </article>
                ))}
                {!activeJob && selectedCandidates.length === 0 && failedJobs.length === 0 && failedTurnaroundJobs.length === 0 && (
                  <div className="visual-candidate-empty">
                    <ImageIcon size={28} />
                    <strong>暂无真实候选</strong>
                    <span>点击“生成候选”提交持久化图片任务，完成后可预览并设为本集引用。</span>
                    <button className="button primary" onClick={() => onGenerate(selectedTarget)} disabled={Boolean(actionKey)}><Sparkles size={13} /> 生成候选</button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="visual-candidate-empty"><Library size={28} /><strong>尚无可制作的实体底稿</strong><span>当前后端仍需先从原著生成结构草稿，才能提取角色、地点与道具；本页不会伪造占位资产。</span></div>
          )}
        </section>
      </div>
      {voiceScope && (
        <ProductionAssetManifestCard
          projectId={voiceScope.projectId}
          episodeId={voiceScope.episodeId}
          refreshKey={manifestRefreshKey}
        />
      )}
      <div className="stage-footer">
        <span><CircleDashed size={14} /> {targets.length
          ? unresolvedBindingNames.length
            ? `${lockedCount}/${targets.length} 本集引用已确认；仍需处理：${unresolvedBindingNames.join('、')}`
            : `${lockedCount}/${targets.length} 本集引用已确认；任何变更都会真实标记下游分镜为过期`
          : '等待结构剧本实体'}</span>
        <button className="button primary" onClick={onNext}>进入拆剧本与配音 <ChevronRight size={14} /></button>
      </div>
      {selectedTarget && editSource && (
        <VisualAssetEditDialog
          source={editSource}
          sourceLabel={`${selectedTarget.name}候选 v${editSource.version}`}
          referenceCandidates={selectedCurrentCandidates.map(({ asset }) => asset)}
          providerCapability={imageEditCapability}
          busy={Boolean(actionKey)}
          suspended={paidConfirmationActive}
          error={editError}
          onClose={() => {
            setEditSource(null)
            setEditError('')
          }}
          onSubmit={async (submission) => {
            setEditError('')
            try {
              await onEdit(selectedTarget, editSource, submission)
            } catch (cause) {
              setEditError(cause instanceof Error ? cause.message : '图片任务创建失败，请核对后重试')
            }
          }}
        />
      )}
      {selectedTarget?.type === 'character' && turnaroundSource && (
        <TurnaroundSplitDialog
          open
          sourceImageUrl={turnaroundSource.url}
          sourceLabel={`${selectedTarget.name}候选 v${turnaroundSource.version}`}
          pending={Boolean(actionKey) || Boolean(activeTurnaroundJob)}
          error={turnaroundError}
          onClose={() => {
            setTurnaroundSource(null)
            setTurnaroundError('')
          }}
          onSubmit={async (crops) => {
            setTurnaroundError('')
            try {
              await onDeriveTurnaround(selectedTarget, turnaroundSource, crops)
              setTurnaroundSource(null)
            } catch (cause) {
              setTurnaroundError(cause instanceof Error ? cause.message : '三视图派生任务创建失败')
            }
          }}
        />
      )}
      {preview && <VisualAssetPreview preview={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

function VisualAssetPreview({
  preview,
  onClose,
}: {
  preview: { url: string; name: string; version: number }
  onClose: () => void
}) {
  const dialogRef = useDialogFocus(onClose)
  return (
    <div className="modal-backdrop visual-preview-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div ref={dialogRef} className="visual-preview-dialog" role="dialog" aria-modal="true" aria-label={`${preview.name}候选预览`} tabIndex={-1}>
        <header><div><small>不可变视觉候选 · v{preview.version}</small><strong>{preview.name}</strong></div><button className="icon-button" onClick={onClose} aria-label="关闭预览"><X size={17} /></button></header>
        <div><img src={preview.url} alt={`${preview.name}候选 v${preview.version}`} /></div>
      </div>
    </div>
  )
}

function AudioStage({
  story,
  jobs,
  productionScope,
  timelineReady,
  onAttachUserAudio,
  onAddSubtitle,
  onReadManagedSubtitleCueSet,
  onReplaceManagedSubtitleCueSet,
  onGenerate,
  speechProvider,
  miniMaxProvider,
  textProvider,
  narratorVoiceProfile,
  timingRemediation,
  focusTarget,
  onConfigureProvider,
  onEditCharacterVoice,
  onEditNarratorVoice,
  onContinueTimingRepreflight,
  onNext,
}: {
  story: StoryDocument | null
  jobs: GenerationJob[]
  productionScope: { projectId: string; episodeId: string; sourceRevisionId: string | null } | null
  timelineReady: boolean
  onAttachUserAudio: (asset: UserAudioAsset) => Promise<void>
  onAddSubtitle: (input: {
    attachmentId: string
    text: string
    durationSeconds: number
  }) => Promise<void>
  onReadManagedSubtitleCueSet: (
    input: TimelineManagedSubtitleCueSetReadInput,
  ) => ManagedSubtitleCueSetSnapshot | null
  onReplaceManagedSubtitleCueSet: (
    input: TimelineManagedSubtitleCueSetReplaceInput,
  ) => Promise<ManagedSubtitleCueSetSnapshot>
  onGenerate: (
    lineId: string,
    settings: Omit<CreateDialogueSpeechJobInput, 'projectId' | 'episodeId'>,
  ) => Promise<void>
  speechProvider: ProviderConnection | null
  miniMaxProvider: ProviderConnection | null
  textProvider: ProviderConnection | null
  narratorVoiceProfile: ProjectNarratorVoiceProfileState['voiceProfile']
  timingRemediation: ShotVideoTimingRemediationState | null
  focusTarget: ShotVideoTimingRemediationFocusTarget | null
  onConfigureProvider: () => void
  onEditCharacterVoice: (characterId: string) => void
  onEditNarratorVoice: () => void
  onContinueTimingRepreflight: () => void
  onNext: () => void
}) {
  const dialogueEntries = useMemo(() => story?.scenes.flatMap((scene) => (
    scene.shots.flatMap((shot) => shot.dialogueLines.map((line) => ({
      line,
      sceneId: scene.id,
      shotId: shot.id,
      sceneTitle: scene.title,
      shotCode: shot.code,
    })))
  )) ?? [], [story])
  const [selectedLineKey, setSelectedLineKey] = useState<string | null>(null)
  const [singleLineOverride, setSingleLineOverride] = useState(false)
  const [overrideVoice, setOverrideVoice] = useState<MiniMaxVoiceCatalogEntry | null>(null)
  const [speed, setSpeed] = useState(1)
  const [volume, setVolume] = useState(1)
  const [pitch, setPitch] = useState(0)
  const [emotion, setEmotion] = useState<DialogueSpeechEmotion>('calm')
  const [linePerformanceProfile, setLinePerformanceProfile] = useState<DialoguePerformanceProfile | null>(null)
  const [deliveryAdjusted, setDeliveryAdjusted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submissionError, setSubmissionError] = useState('')
  const [audioKind, setAudioKind] = useState<'bgm' | 'sfx'>('bgm')
  const [audioAssets, setAudioAssets] = useState<UserAudioAsset[]>([])
  const [audioLibraryLoading, setAudioLibraryLoading] = useState(false)
  const [audioActionId, setAudioActionId] = useState<string | null>(null)
  const [audioError, setAudioError] = useState('')
  const [attachedAudioIds, setAttachedAudioIds] = useState<Set<string>>(() => new Set())
  const [subtitleDraft, setSubtitleDraft] = useState('')
  const [subtitleDuration, setSubtitleDuration] = useState(2)
  const [subtitleSubmitting, setSubtitleSubmitting] = useState(false)
  const [subtitleError, setSubtitleError] = useState('')
  const [selectedSpeechAsset, setSelectedSpeechAsset] = useState<MediaAsset | null>(null)
  const [selectedSpeechAssetLoading, setSelectedSpeechAssetLoading] = useState(false)
  const [selectedSpeechAssetError, setSelectedSpeechAssetError] = useState('')
  const subtitleAttemptRef = useRef<{ signature: string; attachmentId: string } | null>(null)
  const audioFileInputRef = useRef<HTMLInputElement>(null)
  const dialogueLineButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const handledFocusRequestRef = useRef<string | null>(null)
  const defaultSpeechProviderLabel = speechProvider
    ? `${speechProvider.label} · ${speechProvider.model}`
    : '未配置可执行的默认语音 Provider'
  const dialogueEntryKey = (entry: Pick<typeof dialogueEntries[number], 'sceneId' | 'shotId' | 'line'>) => (
    `${entry.sceneId}\u0000${entry.shotId}\u0000${entry.line.id}`
  )
  const selectedEntry = dialogueEntries.find((entry) => dialogueEntryKey(entry) === selectedLineKey) ?? null
  const lineVoiceResolution = voiceProfileForStoryLine({
    story,
    line: selectedEntry?.line,
    narratorVoiceProfile,
  })
  const selectedCharacter = lineVoiceResolution.character
  const isNarration = lineVoiceResolution.scope === 'project-narrator'
  const inheritedProfile = lineVoiceResolution.profile
  const narratorOverrideAllowed = !isNarration || Boolean(inheritedProfile)
  const voiceSubmission = dialogueVoiceSubmissionPlan({
    profile: inheritedProfile,
    overrideVoice,
    overrideProviderId: miniMaxProvider?.id === 'indextts-speech'
      ? 'indextts-speech'
      : miniMaxProvider?.id === 'doubao-speech'
        ? 'doubao-speech'
        : 'minimax-speech',
    overrideEnabled: singleLineOverride && narratorOverrideAllowed,
  })
  const effectiveSpeechProvider = voiceSubmission.mode === 'inherit'
    ? inheritedProfile?.providerId === miniMaxProvider?.id ? miniMaxProvider : null
    : voiceSubmission.mode === 'override'
      ? miniMaxProvider
      : miniMaxProvider ?? speechProvider
  const speechControls = speechControlPolicy(effectiveSpeechProvider)
  const speechProviderState = providerUiConnectionState(effectiveSpeechProvider ?? undefined)
  const effectiveSpeechProviderLabel = effectiveSpeechProvider
    ? `${effectiveSpeechProvider.label} · ${effectiveSpeechProvider.model}`
    : inheritedProfile
      ? `${isNarration ? '项目旁白' : '角色'}绑定的 ${inheritedProfile.providerId} 当前不可用`
      : defaultSpeechProviderLabel
  const resolvedDelivery = resolveCharacterVoiceDelivery(
    inheritedProfile,
    selectedEntry?.sceneId,
  )
  const profileNeedsReselection = Boolean(inheritedProfile
    && effectiveSpeechProvider
    && inheritedProfile.providerConfigRevision !== effectiveSpeechProvider.configRevision
    && !inheritedProfile.historicalPin)
  const speechProviderReady = speechProviderState === 'connected' && !profileNeedsReselection

  useEffect(() => {
    if (!dialogueEntries.some((entry) => dialogueEntryKey(entry) === selectedLineKey)) {
      setSelectedLineKey(dialogueEntries[0] ? dialogueEntryKey(dialogueEntries[0]) : null)
    }
  }, [dialogueEntries, selectedLineKey])

  useEffect(() => {
    if (!focusTarget || !timingRemediation) {
      handledFocusRequestRef.current = null
      return
    }
    const focusKey = `${focusTarget.sceneId}\u0000${focusTarget.shotId}\u0000${focusTarget.dialogueLineId}`
    const requestKey = `${timingRemediation.sourceJobId}\u0000${focusKey}`
    if (handledFocusRequestRef.current === requestKey
      || !dialogueEntries.some((entry) => dialogueEntryKey(entry) === focusKey)) return
    handledFocusRequestRef.current = requestKey
    setSelectedLineKey(focusKey)
    const frame = window.requestAnimationFrame(() => {
      const button = dialogueLineButtonRefs.current.get(focusKey)
      button?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      button?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [dialogueEntries, focusTarget, timingRemediation])

  useEffect(() => {
    const next = resolveCharacterVoiceDelivery(
      inheritedProfile,
      selectedEntry?.sceneId,
    ).delivery
    setEmotion(next.emotion)
    setSpeed(next.speed)
    setPitch(next.pitch)
    setLinePerformanceProfile(null)
    setDeliveryAdjusted(false)
    setSingleLineOverride(false)
    setOverrideVoice(null)
    setSubmissionError('')
  }, [
    selectedEntry?.line.id,
    selectedEntry?.sceneId,
    inheritedProfile?.updatedAt,
  ])

  useEffect(() => {
    if (speechControls.supportsEmotion && speechControls.supportsVolume) return
    // OpenAI-compatible Speech does not accept MiniMax-only controls. Reset
    // stale values before the next submit rather than relying on server errors.
    setEmotion('calm')
    setVolume(1)
  }, [speechControls.supportsEmotion, speechControls.supportsVolume, effectiveSpeechProvider?.id])

  const applyConfirmedLinePerformance = (profile: DialoguePerformanceProfile | null) => {
    const delivery = applyLinePerformanceProfile(profile, resolvedDelivery.delivery)
    setLinePerformanceProfile(profile)
    setEmotion(delivery.emotion)
    setSpeed(delivery.speed)
    setPitch(delivery.pitch)
    setDeliveryAdjusted(false)
  }

  const resetManualLinePerformance = () => {
    const delivery = applyLinePerformanceProfile(
      linePerformanceProfile,
      resolvedDelivery.delivery,
    )
    setEmotion(delivery.emotion)
    setSpeed(delivery.speed)
    setPitch(delivery.pitch)
    setDeliveryAdjusted(false)
  }

  useEffect(() => {
    setAudioAssets([])
    setAttachedAudioIds(new Set())
    setAudioError('')
    if (!productionScope) return
    const controller = new AbortController()
    setAudioLibraryLoading(true)
    void Promise.all([
      api.listAssets(productionScope.projectId, {
        episodeId: productionScope.episodeId,
        kind: 'bgm',
        signal: controller.signal,
      }),
      api.listAssets(productionScope.projectId, {
        episodeId: productionScope.episodeId,
        kind: 'sfx',
        signal: controller.signal,
      }),
    ]).then((groups) => {
      const assets = groups.flat().filter((asset): asset is UserAudioAsset => (
        asset.episodeId === productionScope.episodeId
        && (asset.kind === 'bgm' || asset.kind === 'sfx')
        && asset.status === 'ready'
        && (asset.mimeType === 'audio/mpeg' || asset.mimeType === 'audio/wav')
        && typeof asset.durationSeconds === 'number'
        && asset.durationSeconds > 0
        && typeof asset.checksum === 'string'
        && asset.source === 'upload'
      ))
      setAudioAssets(assets.sort((left, right) => (
        Date.parse(right.createdAt) - Date.parse(left.createdAt)
      )))
    }).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
        setAudioError(error instanceof Error ? error.message : '无法读取用户音频资产')
      }
    }).finally(() => {
      if (!controller.signal.aborted) setAudioLibraryLoading(false)
    })
    return () => controller.abort()
  }, [productionScope?.episodeId, productionScope?.projectId])

  const speechJobs = (productionScope ? jobsForCurrentStoryRevision(jobs, productionScope) : [])
    .filter((job) => job.type === 'dialogue.speech.generate')
    .slice()
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  const jobsByLineId = new Map<string, GenerationJob>()
  for (const job of speechJobs) {
    const lineId = isRecordValue(job.input) && typeof job.input.lineId === 'string'
      ? job.input.lineId
      : null
    if (lineId && !jobsByLineId.has(lineId)) jobsByLineId.set(lineId, job)
  }
  const selectedJob = selectedEntry ? jobsByLineId.get(selectedEntry.line.id) ?? null : null
  const selectedJobStale = selectedJob ? generationJobIsStale(selectedJob) : false
  const selectedOutput = selectedJob && isRecordValue(selectedJob.output) ? selectedJob.output : null
  const selectedAssetId = !selectedJobStale && selectedOutput && isRecordValue(selectedOutput.asset)
    && typeof selectedOutput.asset.id === 'string'
    ? selectedOutput.asset.id
    : null
  const selectedAssetUrl = !selectedJobStale && selectedOutput && isRecordValue(selectedOutput.asset)
    && typeof selectedOutput.asset.url === 'string'
    ? selectedOutput.asset.url
    : null
  const selectedJobActive = selectedJob
    ? ['queued', 'running', 'waiting_provider'].includes(selectedJob.status)
    : false
  const selectedSpeechError = dialogueSpeechErrorMessage({
    submissionError,
    jobStale: selectedJobStale,
    jobStatus: selectedJob?.status,
    jobErrorMessage: selectedJob?.error?.message,
  })
  const completedLineIds = productionScope
    ? completedSpeechLineIdsForCurrentStory(speechJobs, productionScope)
    : new Set<string>()

  useEffect(() => {
    setSelectedSpeechAsset(null)
    setSelectedSpeechAssetError('')
    if (!productionScope || !selectedAssetId || selectedJobStale) {
      setSelectedSpeechAssetLoading(false)
      return
    }
    const controller = new AbortController()
    setSelectedSpeechAssetLoading(true)
    void api.listAssets(productionScope.projectId, {
      episodeId: productionScope.episodeId,
      kind: 'speech',
      signal: controller.signal,
    }).then((assets) => {
      const asset = assets.find((candidate) => (
        candidate.id === selectedAssetId
        && candidate.episodeId === productionScope.episodeId
        && candidate.sourceRevisionId === productionScope.sourceRevisionId
        && candidate.generationJobId === selectedJob?.id
      )) ?? null
      if (!asset) throw new Error('配音任务已完成，但对应语音 Asset 不在当前分集资产库中')
      setSelectedSpeechAsset(asset)
    }).catch((cause: unknown) => {
      if (!(cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) {
        setSelectedSpeechAssetError(cause instanceof Error ? cause.message : '无法读取语音 Asset')
      }
    }).finally(() => {
      if (!controller.signal.aborted) setSelectedSpeechAssetLoading(false)
    })
    return () => controller.abort()
  }, [
    productionScope?.episodeId,
    productionScope?.projectId,
    productionScope?.sourceRevisionId,
    selectedAssetId,
    selectedJob?.id,
    selectedJobStale,
  ])

  const submitSelected = async () => {
    if (!effectiveSpeechProvider
      || !speechProviderReady
      || !selectedEntry
      || voiceSubmission.mode === 'missing'
      || submitting
      || selectedJobActive) return
    setSubmitting(true)
    setSubmissionError('')
    try {
      await onGenerate(selectedEntry.line.id, {
        ...voiceSubmission.request,
        volume: speechControls.supportsVolume ? volume : 1,
        ...(voiceSubmission.mode !== 'inherit' || deliveryAdjusted ? {
          speed,
          ...((effectiveSpeechProvider.adapter === 'minimax'
            || effectiveSpeechProvider.adapter === 'doubao-speech') ? { pitch } : {}),
          emotion: speechControls.supportsEmotion ? emotion : 'calm',
        } : {}),
        format: 'mp3',
        sampleRate: 32_000,
        bitrate: 128_000,
        channels: 1,
      })
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : '语音合成任务提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const attachAudio = async (asset: UserAudioAsset): Promise<boolean> => {
    if (!timelineReady || audioActionId) return false
    setAudioActionId(asset.id)
    setAudioError('')
    try {
      await onAttachUserAudio(asset)
      setAttachedAudioIds((current) => new Set(current).add(asset.id))
      return true
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : '音频已保存，但加入时间线失败')
      return false
    } finally {
      setAudioActionId(null)
    }
  }

  const uploadAudio = async (file: File | undefined) => {
    if (!file || !productionScope || audioActionId) return
    setAudioActionId('upload')
    setAudioError('')
    try {
      const asset = await api.uploadUserAudio(
        productionScope.projectId,
        productionScope.episodeId,
        audioKind,
        file,
      )
      setAudioAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)])
      setAudioActionId(null)
      if (timelineReady) await attachAudio(asset)
      else setAudioError('音频资产已安全上传；OpenCut 时间线载入后可点击“加入时间线”。')
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : '音频上传失败')
    } finally {
      setAudioActionId(null)
      if (audioFileInputRef.current) audioFileInputRef.current.value = ''
    }
  }

  const submitSubtitle = async () => {
    const text = subtitleDraft.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
    if (!text || !timelineReady || subtitleSubmitting) return
    const signature = `${subtitleDuration}\u0000${text}`
    const prior = subtitleAttemptRef.current
    const attachmentId = prior?.signature === signature
      ? prior.attachmentId
      : crypto.randomUUID()
    subtitleAttemptRef.current = { signature, attachmentId }
    setSubtitleSubmitting(true)
    setSubtitleError('')
    try {
      await onAddSubtitle({ attachmentId, text, durationSeconds: subtitleDuration })
      subtitleAttemptRef.current = null
      setSubtitleDraft('')
    } catch (error) {
      setSubtitleError(error instanceof Error ? error.message : '字幕加入时间线失败')
    } finally {
      setSubtitleSubmitting(false)
    }
  }

  return (
    <div className="stage-panel audio-stage">
      <div className="stage-toolbar">
        <div><h2>语音生成与确认</h2><span>「剧本与配音」内部页 · {defaultSpeechProviderLabel} · 真实音频先持久化，再为分镜与逐镜视频提供镜长依据</span></div>
        <button className="button secondary" onClick={onConfigureProvider}><Settings2 size={14} /> 语音 Provider</button>
      </div>
      {timingRemediation && (
        <section className="scene-delivery-card source-character-scene" role="status" aria-label="音频时长恢复">
          <header>
            <span><AlertTriangle size={14} /> 视频预检使用的音频时长已失效</span>
            <strong>{timingRemediation.remediation.providerSubmissionState === 'task-exists'
              ? '原 Provider task 已存在'
              : '尚未创建 Provider task'}</strong>
          </header>
          <p>
            镜头 {timingRemediation.remediation.shotId} 的旧剪辑点为 {timingRemediation.remediation.previousDecision.timelineDurationSeconds.toFixed(2)} 秒；
            当前状态：{timingResolutionLabel(timingRemediation.remediation)}。系统没有自动生成语音，也不会自动重提 Seedance。
          </p>
          {timingRemediation.remediation.affectedLines.length > 0 ? (
            <div className="user-audio-list" aria-label="受影响台词的音频绑定变化">
              {timingRemediation.remediation.affectedLines.map((line) => (
                <article key={line.dialogueLineId}>
                  <div className="audio-kind-mark sfx">{({
                    added: '新增',
                    removed: '移除',
                    asset_changed: '换档',
                    duration_changed: '时长',
                  } as const)[line.change]}</div>
                  <div className="audio-asset-copy">
                    <strong>台词 {line.dialogueLineId}</strong>
                    <small>旧：{timingBindingLabel(line.previous)}</small>
                    <small>新：{timingBindingLabel(line.current)}</small>
                  </div>
                </article>
              ))}
            </div>
          ) : timingRemediation.remediation.currentResolution.status === 'audio_required' ? (
            <p>
              待处理台词：{timingRemediation.remediation.currentResolution.blockedLines
                .map((line) => line.dialogueLineId)
                .join('、')}。这些台词尚无可显示的新 Asset 身份，请在下方生成或核对语音。
            </p>
          ) : null}
          <footer>
            <small>先试听、核对或重新生成受影响语音；只有你点击下方按钮后才会进入分镜与逐镜视频，而且仍需再次手动预检与确认。</small>
            <button type="button" className="button secondary" onClick={onContinueTimingRepreflight}>
              我已核对 / 修复语音，进入分镜与逐镜视频
            </button>
          </footer>
        </section>
      )}
      <div className="audio-workbench real-speech-workbench">
        <section className="dialogue-production-list">
          <header><strong>剧本台词</strong><span>{completedLineIds.size}/{dialogueEntries.length} 已生成</span></header>
          <div>
            {dialogueEntries.map((entry) => {
              const { line, sceneTitle, shotCode } = entry
              const entryKey = dialogueEntryKey(entry)
              const job = jobsByLineId.get(line.id)
              return (
                <button
                  key={entryKey}
                  ref={(node) => {
                    if (node) dialogueLineButtonRefs.current.set(entryKey, node)
                    else dialogueLineButtonRefs.current.delete(entryKey)
                  }}
                  data-dialogue-line-id={line.id}
                  data-dialogue-line-scope={entryKey}
                  className={entryKey === selectedLineKey ? 'active' : ''}
                  onClick={() => { setSelectedLineKey(entryKey); setSubmissionError('') }}
                >
                  <small>{sceneTitle} · {shotCode}</small>
                  <strong>{line.kind === 'narration' ? '旁白' : line.speaker || '未知角色'}</strong>
                  <span>{line.text}</span>
                  <i className={`speech-status status-${job?.status ?? 'idle'}`}>
                    {job && generationJobIsStale(job) ? '已过期'
                      : job?.status === 'succeeded' ? '已生成'
                      : job?.status === 'failed' ? '失败'
                        : job && ['queued', 'running', 'waiting_provider'].includes(job.status) ? `${job.progress}%`
                          : '待生成'}
                  </i>
                </button>
              )
            })}
            {!dialogueEntries.length && <div className="command-empty">真实剧本中没有可合成的台词</div>}
          </div>
        </section>
        <aside className="voice-panel real-voice-panel">
          <h3>单句配音 <i className={`provider-dot provider-${effectiveSpeechProvider?.health.status ?? 'untested'}`} /></h3>
          <small className="speech-provider-context">{effectiveSpeechProvider
            ? `${effectiveSpeechProviderLabel} · ${speechProviderState === 'connected' ? '已验证' : providerStatusDetail(effectiveSpeechProvider)}`
            : inheritedProfile
              ? `${effectiveSpeechProviderLabel}，请在 Provider 设置中恢复该${isNarration ? '项目旁白' : '角色'}绑定的服务。`
              : isNarration
                ? '请先在资产阶段配置项目级旁白；未绑定前不会提交语音合成。'
                : '请先为角色绑定声线，或明确开启单句临时覆盖。'}</small>
          <div className="voice-character">
            <span className="character-portrait placeholder">{selectedEntry ? [...(selectedEntry.line.speaker || '旁')][0] : '—'}</span>
            <div><strong>{selectedEntry?.line.kind === 'narration' ? '旁白' : selectedEntry?.line.speaker || '未选择台词'}</strong><small>{selectedEntry?.shotCode ?? '请从左侧选择'}</small></div>
          </div>
          <label>当前台词<textarea value={selectedEntry?.line.text ?? ''} readOnly /></label>
          <div className={`inherited-voice-card ${inheritedProfile ? 'ready' : 'missing'}`}>
            {inheritedProfile ? (
              <>
                <header>
                  <div><small>{isNarration ? '继承项目旁白' : '继承角色档案'}</small><strong>{inheritedProfile.voiceName}</strong></div>
                  <span>{VOICE_TYPE_LABELS[inheritedProfile.voiceType]} · r{inheritedProfile.providerConfigRevision}</span>
                </header>
                {inheritedProfile.descriptions[0] && <p>{inheritedProfile.descriptions[0]}</p>}
                <footer>
                  <span>{isNarration ? '项目级 · 各分集继承' : inheritedProfile.selectionSource === 'agentic' ? 'AI 选角' : '手动选择'}</span>
                  {isNarration
                    ? <button type="button" onClick={onEditNarratorVoice}>编辑项目旁白</button>
                    : selectedCharacter && <button type="button" onClick={() => onEditCharacterVoice(selectedCharacter.id)}>编辑角色声线</button>}
                </footer>
              </>
            ) : isNarration ? (
              <>
                <div><AlertTriangle size={14} /><span><strong>项目尚未绑定旁白声线</strong><small>请从真实 MiniMax 目录为项目选择旁白；所有分集继承同一档案，未绑定时禁止生成。</small></span></div>
                <button type="button" onClick={onEditNarratorVoice}>去配置项目旁白</button>
              </>
            ) : selectedCharacter ? (
              <>
                <div><AlertTriangle size={14} /><span><strong>{selectedCharacter.name} 尚未绑定声线</strong><small>请先在角色档案中从真实 MiniMax 目录选择，后续台词会自动继承。</small></span></div>
                <button type="button" onClick={() => onEditCharacterVoice(selectedCharacter.id)}>去角色页配置</button>
              </>
            ) : (
              <div><AlertTriangle size={14} /><span><strong>无法安全匹配角色</strong><small>不会猜测声线；可在下方明确开启单句临时覆盖。</small></span></div>
            )}
          </div>
          {inheritedProfile && (
            <div className={`scene-delivery-card source-${resolvedDelivery.source}`}>
              <header><span>场景表演指令</span><strong>{VOICE_EMOTION_LABELS[resolvedDelivery.delivery.emotion]} · {resolvedDelivery.delivery.speed.toFixed(2)}× · {resolvedDelivery.delivery.pitch > 0 ? '+' : ''}{resolvedDelivery.delivery.pitch} 半音</strong></header>
              <p>{resolvedDelivery.rationale ?? (resolvedDelivery.source === 'character-default' ? `使用${isNarration ? '项目旁白' : '角色'}默认表演方式。` : `${isNarration ? '项目旁白' : '角色档案'}未指定表演方式，使用平台中性默认值。`)}</p>
              <small>只改变表演，不更换{isNarration ? '项目旁白' : '角色'}基础音色；提交时自动应用。</small>
            </div>
          )}
          {profileNeedsReselection && (
            <div className="source-generation-error"><AlertTriangle size={14} /><span>语音 Provider 已从 r{inheritedProfile?.providerConfigRevision} 变更为 r{effectiveSpeechProvider?.configRevision}。为避免{isNarration ? '旁白' : '角色'}静默变声，请回{isNarration ? '项目旁白设置' : '角色页'}重新确认。</span></div>
          )}
          {productionScope && selectedEntry && (
            <LinePerformanceDirector
              key={`${productionScope.episodeId}:${productionScope.sourceRevisionId ?? 'no-source-revision'}:${inheritedProfile?.updatedAt ?? 'no-voice-profile'}:${selectedEntry.line.id}`}
              projectId={productionScope.projectId}
              episodeId={productionScope.episodeId}
              sourceRevisionId={productionScope.sourceRevisionId}
              voiceProfileRevision={inheritedProfile?.updatedAt ?? null}
              lineId={selectedEntry.line.id}
              inheritedLabel={isNarration ? '项目旁白场景指令' : '角色场景指令'}
              textProvider={textProvider}
              onConfigureProvider={onConfigureProvider}
              onProfileChange={applyConfirmedLinePerformance}
            >
              <label className="single-line-override-toggle">
                <span><strong>临时更换基础音色</strong><small>{isNarration && !inheritedProfile ? '请先建立项目旁白档案' : `仅影响这一句，不修改${isNarration ? '项目旁白' : '角色'}档案`}</small></span>
                <input
                  type="checkbox"
                  checked={singleLineOverride}
                  disabled={isNarration && !inheritedProfile}
                  onChange={(event) => {
                    setSingleLineOverride(event.target.checked)
                    if (!event.target.checked) setOverrideVoice(null)
                  }}
                />
              </label>
              {singleLineOverride && narratorOverrideAllowed && (
                <DialogueVoiceOverridePicker
                  provider={miniMaxProvider}
                  value={overrideVoice}
                  onChange={setOverrideVoice}
                  onConfigureProvider={onConfigureProvider}
                />
              )}
              <label className={!speechControls.supportsEmotion ? 'unsupported-provider-control' : undefined}>情绪{!speechControls.supportsEmotion && <small>当前 Provider 不支持</small>}<select value={emotion} disabled={!speechControls.supportsEmotion} onChange={(event) => { setEmotion(event.target.value as DialogueSpeechEmotion); setDeliveryAdjusted(true) }}>
                <option value="calm">平静</option><option value="happy">开心</option><option value="sad">悲伤</option>
                <option value="angry">愤怒</option><option value="fearful">恐惧</option><option value="disgusted">厌恶</option><option value="surprised">惊讶</option>
                <option value="fluent">流畅</option><option value="whisper">耳语</option>
              </select></label>
              <label>语速 <span>{speed.toFixed(2)}×</span><input type="range" min="0.5" max="2" step="0.05" value={speed} onChange={(event) => { setSpeed(Number(event.target.value)); setDeliveryAdjusted(true) }} /></label>
              <label className={effectiveSpeechProvider?.adapter !== 'minimax' && effectiveSpeechProvider?.adapter !== 'doubao-speech' ? 'unsupported-provider-control' : undefined}>音高 <span>{effectiveSpeechProvider?.adapter === 'minimax' || effectiveSpeechProvider?.adapter === 'doubao-speech' ? `${pitch > 0 ? '+' : ''}${pitch} 半音` : '当前 Provider 不支持'}</span><input type="range" min="-12" max="12" step="1" value={pitch} disabled={effectiveSpeechProvider?.adapter !== 'minimax' && effectiveSpeechProvider?.adapter !== 'doubao-speech'} onChange={(event) => { setPitch(Number(event.target.value)); setDeliveryAdjusted(true) }} /></label>
              {inheritedProfile && <div className="delivery-inheritance-state"><span>{deliveryAdjusted ? '本次合成将手动覆盖已确认的 AI / 场景表演' : linePerformanceProfile ? '提交时由服务端原子继承已确认的逐句 AI 表演' : `提交时由服务端按${isNarration ? '项目旁白' : '角色场景'}档案原子解析`}</span>{deliveryAdjusted && <button type="button" onClick={resetManualLinePerformance}>恢复{linePerformanceProfile ? ' AI 表演' : isNarration ? '旁白指令' : '角色指令'}</button>}</div>}
              <label className={!speechControls.supportsVolume ? 'unsupported-provider-control' : undefined}>音量 <span>{speechControls.supportsVolume ? `${volume.toFixed(1)}×` : '请在时间线调整'}</span><input type="range" min="0.1" max="2" step="0.1" value={volume} disabled={!speechControls.supportsVolume} onChange={(event) => setVolume(Number(event.target.value))} /></label>
            </LinePerformanceDirector>
          )}
          {selectedAssetUrl && <audio controls preload="metadata" src={selectedAssetUrl} aria-label="已生成台词音频" />}
          {selectedSpeechError && <div className="source-generation-error"><AlertTriangle size={14} /><span>{selectedSpeechError}</span></div>}
          <button
            className="button primary full-width"
            onClick={profileNeedsReselection
              ? isNarration
                ? onEditNarratorVoice
                : selectedCharacter
                  ? () => onEditCharacterVoice(selectedCharacter.id)
                  : onConfigureProvider
              : !speechProviderReady
              ? onConfigureProvider
              : isNarration && !inheritedProfile
                ? onEditNarratorVoice
              : selectedCharacter?.voiceProfile && !inheritedProfile && !singleLineOverride
                ? onConfigureProvider
              : selectedCharacter && !inheritedProfile && !singleLineOverride
                ? () => onEditCharacterVoice(selectedCharacter.id)
                : () => void submitSelected()}
            disabled={speechProviderReady && (
              !selectedEntry
              || submitting
              || selectedJobActive
              || (isNarration && !inheritedProfile)
              || (singleLineOverride && !overrideVoice)
              || (!inheritedProfile && !singleLineOverride && !selectedCharacter)
            )}
          >
            <Mic2 size={14} /> {profileNeedsReselection
              ? `重新确认${isNarration ? '项目旁白' : '角色声线'}`
              : !speechProviderReady
              ? speechProviderState === 'untested' ? '测试语音 Provider 后继续' : '配置语音 Provider'
              : isNarration && !inheritedProfile
                ? '先配置项目旁白'
              : selectedCharacter?.voiceProfile && !inheritedProfile && !singleLineOverride
                ? '切换到角色绑定的 Provider'
              : selectedCharacter && !inheritedProfile && !singleLineOverride
                ? '先配置角色声线'
              : submitting || selectedJobActive
                ? '真实合成中'
                : selectedAssetUrl ? '重新合成当前台词' : '生成当前台词'}
          </button>
          <small className="speech-disclaimer">{speechControls.supportsWordTimestamps
            ? `MiniMax 词级时码会随 Asset 固化并优先用于导出字幕；${isNarration ? '旁白来自项目级档案并由所有分集继承' : '对白默认声线来自角色档案'}，临时覆盖不会改写档案。`
            : '当前 Provider 未声明词级时码能力；字幕使用经校验的整句时段，不会伪造逐词时间戳。'}</small>
        </aside>
      </div>
      <div className="audio-timeline-tools">
        <section className="user-audio-library">
          <header>
            <div><Headphones size={15} /><div><strong>背景配乐与音效</strong><small>真实 MP3/WAV Asset · 使用 OpenCut 插入与撤销语义</small></div></div>
            <div className={`timeline-ready-indicator ${timelineReady ? 'ready' : ''}`}>
              {timelineReady ? <CheckCircle2 size={12} /> : <CircleDashed size={12} />}
              {timelineReady ? '时间线可写' : '时间线载入中'}
            </div>
          </header>
          <div className="audio-upload-row">
            <select value={audioKind} onChange={(event) => setAudioKind(event.target.value as 'bgm' | 'sfx')}>
              <option value="bgm">背景配乐 BGM</option>
              <option value="sfx">环境/动作音效 SFX</option>
            </select>
            <input
              ref={audioFileInputRef}
              type="file"
              accept=".mp3,.wav,audio/mpeg,audio/wav"
              hidden
              onChange={(event) => void uploadAudio(event.target.files?.[0])}
            />
            <button
              className="button secondary"
              disabled={!productionScope || audioActionId !== null}
              onClick={() => audioFileInputRef.current?.click()}
            >
              <Upload size={13} /> {audioActionId === 'upload' ? '校验上传中' : '上传 MP3 / WAV'}
            </button>
          </div>
          <div className="user-audio-list">
            {audioAssets.map((asset) => {
              const attached = attachedAudioIds.has(asset.id)
              return (
                <article key={asset.id}>
                  <div className={`audio-kind-mark ${asset.kind}`}>{asset.kind.toUpperCase()}</div>
                  <div className="audio-asset-copy">
                    <strong>{asset.originalFileName || `${asset.kind === 'bgm' ? '背景配乐' : '音效'} ${asset.id.slice(0, 8)}`}</strong>
                    <small>{asset.mimeType === 'audio/wav' ? 'WAV' : 'MP3'} · {asset.durationSeconds.toFixed(2)} 秒 · ffprobe 已验证</small>
                    <audio controls preload="metadata" src={asset.url} aria-label={asset.originalFileName || asset.id} />
                  </div>
                  <button
                    className="button secondary"
                    disabled={!timelineReady || audioActionId !== null || attached}
                    onClick={() => void attachAudio(asset)}
                  >
                    {audioActionId === asset.id ? '写入中' : attached ? '已加入' : asset.kind === 'bgm' ? '从 00:00 加入' : '加入播放头'}
                  </button>
                </article>
              )
            })}
            {!audioAssets.length && !audioLibraryLoading && <div className="command-empty">尚无用户音频资产，上传后会先经魔数与 ffprobe 校验。</div>}
            {audioLibraryLoading && <div className="command-empty">正在读取音频资产…</div>}
          </div>
          {audioError && <div className="source-generation-error"><AlertTriangle size={14} /><span>{audioError}</span></div>}
        </section>
        <section className="subtitle-composer">
          <header><MessageSquareText size={15} /><div><strong>手工字幕</strong><small>写入 OpenCut text 轨 · 正式导出优先烧录该轨</small></div></header>
          <textarea
            value={subtitleDraft}
            maxLength={10_000}
            placeholder="输入要在当前播放头出现的字幕…"
            onChange={(event) => {
              setSubtitleDraft(event.target.value)
              setSubtitleError('')
            }}
          />
          <label>持续时间 <span>{subtitleDuration.toFixed(1)} 秒</span><input type="range" min="0.5" max="10" step="0.5" value={subtitleDuration} onChange={(event) => setSubtitleDuration(Number(event.target.value))} /></label>
          <button className="button primary full-width" disabled={!timelineReady || !subtitleDraft.trim() || subtitleSubmitting} onClick={() => void submitSubtitle()}>
            <Plus size={14} /> {subtitleSubmitting ? '写入时间线中' : '在播放头添加字幕'}
          </button>
          <small className="speech-disclaimer">自由文本是额外叠加层，不会再全局屏蔽其他对白的自动字幕。选中时间线片段后可删除、裁切、拖移和撤销。</small>
          {subtitleError && <div className="source-generation-error"><AlertTriangle size={14} /><span>{subtitleError}</span></div>}
        </section>
        <ManagedSubtitleEditor
          binding={selectedEntry ? {
            dialogueLineId: selectedEntry.line.id,
            storySceneId: selectedEntry.sceneId,
            storyShotId: selectedEntry.shotId,
            lineText: selectedEntry.line.text,
          } : null}
          speechAsset={selectedSpeechAsset}
          assetLoading={selectedSpeechAssetLoading}
          timelineReady={timelineReady}
          onRead={onReadManagedSubtitleCueSet}
          onReplace={onReplaceManagedSubtitleCueSet}
        />
        {selectedSpeechAssetError && <div className="source-generation-error"><AlertTriangle size={14} /><span>{selectedSpeechAssetError}</span></div>}
      </div>
      <div className="stage-footer"><span><CircleDashed size={14} /> {completedLineIds.size} 句真实音频已持久化；分镜与视频将读取实测时长</span><button className="button primary" onClick={onNext}>进入分镜与逐镜视频 <ChevronRight size={14} /></button></div>
    </div>
  )
}

function ExportStage({
  story,
  episode,
  shots,
  jobs,
  onExport,
}: {
  story: StoryDocument | null
  episode: EpisodeSummary | null
  shots: Shot[]
  jobs: GenerationJob[]
  onExport: () => void
}) {
  const [exportRecord, setExportRecord] = useState<ExportRenderRecord | null>(null)
  const [qualityReport, setQualityReport] = useState<QualityReport | null>(null)
  const [releaseReviews, setReleaseReviews] = useState<ReleaseReview[]>([])
  const [releaseReviewChecklist, setReleaseReviewChecklist] = useState({
    audioVideoSync: false,
    subtitleSyncAndComplete: false,
    characterVisualSemantics: false,
  })
  const [releaseReviewNotes, setReleaseReviewNotes] = useState('')
  const [releaseReviewAcknowledged, setReleaseReviewAcknowledged] = useState(false)
  const [releaseReviewSubmitting, setReleaseReviewSubmitting] = useState<'approve' | 'reject' | null>(null)
  const [releaseReviewError, setReleaseReviewError] = useState('')
  const [qualitySubmitting, setQualitySubmitting] = useState(false)
  const [qualityError, setQualityError] = useState('')
  const qualityAttemptRef = useRef<{ exportId: string; key: string } | null>(null)
  const releaseReviewAttemptRef = useRef<{
    signature: string
    key: string
  } | null>(null)
  const exportScopeSignatureRef = useRef('')
  const totalDuration = shots.reduce((total, shot) => {
    const seconds = Number.parseFloat(shot.duration)
    return total + (Number.isFinite(seconds) ? seconds : 0)
  }, 0)
  const speechLineCount = story?.scenes.reduce((total, scene) => total + scene.shots.reduce(
    (shotTotal, shot) => shotTotal + shot.dialogueLines.length,
    0,
  ), 0) ?? 0
  const storyScope = {
    episodeId: episode?.id ?? '',
    sourceRevisionId: episode?.sourceRevisionId ?? null,
  }
  const readySpeechIds = completedSpeechLineIdsForCurrentStory(jobs, storyScope)
  const latestExport = latestExportJobForCurrentStory(jobs, storyScope)
  const latestExportInput = latestExport && isRecordValue(latestExport.input) ? latestExport.input : null
  const latestExportId = typeof latestExportInput?.exportId === 'string'
    ? latestExportInput.exportId
    : typeof latestExport?.resourceId === 'string'
      ? latestExport.resourceId
      : null
  const latestQualityJob = latestQualityJobForExport(jobs, storyScope.episodeId, latestExportId)
  const latestQualityInput = latestQualityJob && isRecordValue(latestQualityJob.input)
    ? latestQualityJob.input
    : null
  const latestQualityReportId = typeof latestQualityInput?.qualityReportId === 'string'
    ? latestQualityInput.qualityReportId
    : typeof latestQualityJob?.resourceId === 'string'
      ? latestQualityJob.resourceId
      : null
  const exportScopeSignature = `${storyScope.episodeId}:${storyScope.sourceRevisionId ?? ''}:${latestExportId ?? ''}`
  exportScopeSignatureRef.current = exportScopeSignature
  const scopedExportRecord = exportRecord
    && exportRecordBelongsToCurrentStory(exportRecord, storyScope, latestExportId)
    ? exportRecord
    : null
  const scopedQualityReport = qualityReport && latestExportId
    && qualityReportBelongsToCurrentStory(qualityReport, storyScope, latestExportId)
    ? qualityReport
    : null
  const currentReleaseReview = releaseReviews.find((review) => (
    review.exportId === latestExportId && review.isCurrent
  )) ?? null

  useEffect(() => {
    setExportRecord(null)
    setQualityError('')
    if (!latestExportId || !latestExport || generationJobIsStale(latestExport)) return
    const controller = new AbortController()
    void api.getExportRender(latestExportId, { signal: controller.signal })
      .then((record) => {
        if (!exportRecordBelongsToCurrentStory(record, storyScope, latestExportId)) {
          throw new Error('导出记录不属于当前分集的当前剧本修订')
        }
        setExportRecord(record)
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setQualityError(error instanceof Error ? error.message : '无法读取导出记录')
        }
      })
    return () => controller.abort()
  }, [
    episode?.id,
    episode?.sourceRevisionId,
    latestExportId,
    latestExport?.updatedAt,
    latestExport?.status,
  ])

  useEffect(() => {
    setQualityReport(null)
    if (!latestQualityReportId || !latestExportId) return
    const controller = new AbortController()
    void api.getQualityReport(latestQualityReportId, { signal: controller.signal })
      .then((report) => {
        if (!qualityReportBelongsToCurrentStory(report, storyScope, latestExportId)) {
          throw new Error('质检报告不属于当前分集的当前剧本修订')
        }
        setQualityReport(report)
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setQualityError(error instanceof Error ? error.message : '无法读取质检报告')
        }
      })
    return () => controller.abort()
  }, [
    episode?.id,
    episode?.sourceRevisionId,
    latestExportId,
    latestQualityReportId,
    latestQualityJob?.updatedAt,
    latestQualityJob?.status,
  ])

  useEffect(() => {
    setReleaseReviews([])
    setReleaseReviewChecklist({
      audioVideoSync: false,
      subtitleSyncAndComplete: false,
      characterVisualSemantics: false,
    })
    setReleaseReviewNotes('')
    setReleaseReviewAcknowledged(false)
    setReleaseReviewError('')
    releaseReviewAttemptRef.current = null
    if (!latestExportId || !latestExport || generationJobIsStale(latestExport)) return
    const controller = new AbortController()
    void api.listReleaseReviews(latestExportId, { signal: controller.signal })
      .then((reviews) => {
        if (exportScopeSignatureRef.current !== exportScopeSignature) return
        setReleaseReviews(reviews)
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setReleaseReviewError(error instanceof Error ? error.message : '无法读取发行复验记录')
        }
      })
    return () => controller.abort()
  }, [
    episode?.id,
    episode?.sourceRevisionId,
    exportScopeSignature,
    latestExport?.status,
  ])

  useEffect(() => {
    if (!scopedQualityReport || !['queued', 'running'].includes(scopedQualityReport.status)) return
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      void api.getQualityReport(scopedQualityReport.id, { signal: controller.signal })
        .then((report) => {
          if (!latestExportId || !qualityReportBelongsToCurrentStory(report, storyScope, latestExportId)) {
            throw new Error('质检状态已不属于当前分集的当前剧本修订')
          }
          setQualityReport(report)
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setQualityError(error instanceof Error ? error.message : '质检状态更新失败')
          }
        })
    }, 800)
    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [episode?.id, episode?.sourceRevisionId, latestExportId, scopedQualityReport])

  const submitQualityCheck = async () => {
    if (!latestExportId || scopedExportRecord?.status !== 'succeeded' || qualitySubmitting) return
    setQualitySubmitting(true)
    setQualityError('')
    const previous = qualityAttemptRef.current
    const idempotencyKey = previous?.exportId === latestExportId
      ? previous.key
      : crypto.randomUUID()
    qualityAttemptRef.current = { exportId: latestExportId, key: idempotencyKey }
    try {
      const result = await api.createQualityCheck(latestExportId, idempotencyKey)
      if (exportScopeSignatureRef.current !== exportScopeSignature
        || !qualityReportBelongsToCurrentStory(result.qualityReport, storyScope, latestExportId)) {
        throw new Error('质检请求已完成，但当前分集或剧本修订已切换，结果未被采用')
      }
      setQualityReport(result.qualityReport)
      qualityAttemptRef.current = null
    } catch (error) {
      // Keep the key until the durable QC request is positively acknowledged;
      // malformed 2xx responses are also ambiguous commits.
      setQualityError(error instanceof Error ? error.message : '无法创建真实质检任务')
    } finally {
      setQualitySubmitting(false)
    }
  }

  const submitReleaseReview = async (decision: 'approve' | 'reject') => {
    if (!latestExportId
      || !scopedExportRecord?.outputAsset
      || !scopedQualityReport
      || scopedQualityReport.status !== 'passed'
      || scopedQualityReport.passed !== true
      || releaseReviewSubmitting
      || !releaseReviewAcknowledged) return
    const checklist = { ...releaseReviewChecklist }
    const allPassed = checklist.audioVideoSync
      && checklist.subtitleSyncAndComplete
      && checklist.characterVisualSemantics
    const notes = releaseReviewNotes.trim()
    if (decision === 'approve' && !allPassed) {
      setReleaseReviewError('批准发行前必须逐项确认音画、字幕与角色语义')
      return
    }
    if (decision === 'reject' && allPassed) {
      setReleaseReviewError('驳回时至少需有一项人工复验未通过')
      return
    }
    if (decision === 'reject' && !notes) {
      setReleaseReviewError('驳回时请填写可执行的修改说明')
      return
    }
    const input = {
      decision,
      checklist,
      ...(notes ? { notes } : {}),
    }
    const signature = JSON.stringify({ exportId: latestExportId, input })
    const previous = releaseReviewAttemptRef.current
    const idempotencyKey = previous?.signature === signature
      ? previous.key
      : crypto.randomUUID()
    releaseReviewAttemptRef.current = { signature, key: idempotencyKey }
    setReleaseReviewSubmitting(decision)
    setReleaseReviewError('')
    try {
      const result = await api.createReleaseReview(latestExportId, input, idempotencyKey)
      const review = result.releaseReview
      const outputAsset = scopedExportRecord.outputAsset
      if (exportScopeSignatureRef.current !== exportScopeSignature
        || review.projectId !== scopedExportRecord.projectId
        || review.episodeId !== scopedExportRecord.episodeId
        || review.timelineRevisionId !== scopedExportRecord.timelineRevisionId
        || review.storyRevisionId !== scopedExportRecord.storyRevisionId
        || review.outputAssetId !== outputAsset.id
        || review.outputAssetChecksum !== outputAsset.checksum
        || review.qualityReportId !== scopedQualityReport.id) {
        throw new Error('发行复验已写入，但返回绑定与当前成片事实源不一致')
      }
      setReleaseReviews((current) => [
        review,
        ...current
          .filter((candidate) => candidate.id !== review.id)
          .map((candidate) => ({ ...candidate, isCurrent: false })),
      ])
      releaseReviewAttemptRef.current = null
      setReleaseReviewAcknowledged(false)
    } catch (error) {
      // Preserve the exact key for an ambiguous response; a retry of the same
      // review must recover the durable record rather than create a second one.
      setReleaseReviewError(error instanceof Error ? error.message : '无法保存发行复验记录')
    } finally {
      setReleaseReviewSubmitting(null)
    }
  }

  const exportOutput = latestExport && isRecordValue(latestExport.output) ? latestExport.output : null
  const exportAsset = exportOutput && isRecordValue(exportOutput.asset) ? exportOutput.asset : null
  const exportReady = scopedExportRecord?.status === 'succeeded' && scopedExportRecord.outputAsset !== null
    || Boolean(latestExport?.status === 'succeeded'
      && !generationJobIsStale(latestExport)
      && typeof exportAsset?.url === 'string')
  const qualityPassed = scopedQualityReport?.status === 'passed' && scopedQualityReport.passed === true
  const releaseApproved = currentReleaseReview?.decision === 'approve'
    && currentReleaseReview.isCurrent
    && currentReleaseReview.invalidReasons.length === 0
  const reviewUrl = qualityPassed && scopedExportRecord?.status === 'succeeded'
    ? scopedExportRecord.reviewDownloadUrl
    : null
  // The in-browser player intentionally uses the QC-gated review route. The
  // release route remains locked until an immutable human approval exists.
  const exportUrl = reviewUrl
  const visualReady = shots.length > 0 && shots.every((shot) => Boolean(shot.assetId))
  const audioReady = speechLineCount === 0 || readySpeechIds.size >= speechLineCount
  const preflightChecks: Array<[string, string, 'pass' | 'warn']> = [
    ['分镜图资产', visualReady ? `${shots.length} 镜均已持久化` : `${shots.filter((shot) => shot.assetId).length}/${shots.length} 镜就绪`, visualReady ? 'pass' : 'warn'],
    ['对白音轨', audioReady ? `${readySpeechIds.size} 句真实音频` : `${readySpeechIds.size}/${speechLineCount} 句就绪`, audioReady ? 'pass' : 'warn'],
    ['时间线快照', latestExport ? '已在任务中固定不可变修订' : '提交导出时校验', latestExport ? 'pass' : 'warn'],
    ['视频规格', exportReady ? 'ffprobe 已验证 H.264 / AAC' : '导出后由 ffprobe 强制验收', exportReady ? 'pass' : 'warn'],
    ['字幕', '有经校验的词级时码时优先使用；否则明确回退整句时段', audioReady ? 'pass' : 'warn'],
  ]
  const qualityStatusLabel = scopedQualityReport?.status === 'passed'
    ? '真实质检通过'
    : scopedQualityReport?.status === 'failed'
      ? '真实质检未通过'
      : scopedQualityReport?.status === 'stale'
        ? '质检结果已过期'
        : scopedQualityReport && ['queued', 'running'].includes(scopedQualityReport.status)
          ? '正在执行 FFmpeg 质检'
          : '尚未运行成片质检'
  const downloadUrl = qualityPassed && releaseApproved && scopedExportRecord?.status === 'succeeded'
    ? scopedExportRecord.downloadUrl
    : null
  const releaseReviewStatusLabel = !qualityPassed
    ? '先通过真实技术质检'
    : releaseApproved
      ? '人工发行复验已批准'
      : currentReleaseReview?.decision === 'reject'
        ? '当前成片已驳回，可修改后再次复验'
        : '待人工音画、字幕与角色语义复验'
  const allReleaseChecksPassed = releaseReviewChecklist.audioVideoSync
    && releaseReviewChecklist.subtitleSyncAndComplete
    && releaseReviewChecklist.characterVisualSemantics
  const hasReleaseCheckFailure = !releaseReviewChecklist.audioVideoSync
    || !releaseReviewChecklist.subtitleSyncAndComplete
    || !releaseReviewChecklist.characterVisualSemantics
  const releaseReviewReady = qualityPassed
    && scopedExportRecord?.status === 'succeeded'
    && Boolean(scopedExportRecord.outputAsset)
  const timeLabel = `${Math.floor(totalDuration / 60)}:${String(Math.round(totalDuration % 60)).padStart(2, '0')}`
  const exportStatus = latestExport && generationJobIsStale(latestExport)
    ? '上次成片已因剧本修改过期'
    : latestExport?.status === 'succeeded'
    ? '真实成片已就绪'
    : latestExport && ['queued', 'running', 'waiting_provider'].includes(latestExport.status)
      ? `FFmpeg 渲染中 ${latestExport.progress}%`
      : latestExport?.status === 'failed'
        ? '上次导出失败'
        : '等待提交导出'
  return (
    <div className="stage-panel export-stage">
      <div className="stage-toolbar"><div><h2>剪辑与成片</h2><span>同一 OpenCut 时间线快照 · 镜长、语音与字幕同源固化 · 本地 FFmpeg 正式渲染</span></div><div className={`ready-badge ${exportReady ? '' : 'pending'}`}>{exportReady ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />} {exportStatus}</div></div>
      <OneClickProductionPanel
        episode={episode}
        story={story}
        missingStoryboardCount={Math.max(0, shots.length - shots.filter((shot) => Boolean(shot.assetId)).length)}
        missingSpeechCount={Math.max(0, speechLineCount - readySpeechIds.size)}
      />
      <div className="export-workbench">
        <section className="final-preview">
          {exportUrl ? (
            <video className="final-video" controls preload="metadata" src={exportUrl} aria-label="已导出成片" />
          ) : (
            <div
              className="final-frame frame-wide"
              style={shots[0]?.imageUrl ? { backgroundImage: `url(${JSON.stringify(shots[0].imageUrl)})`, backgroundPosition: 'center', backgroundSize: 'cover' } : undefined}
            >
              <div className="cinema-bars" />
              <div className="export-empty-copy"><Film size={24} /><strong>{story?.title ?? episode?.title ?? '未命名漫剧'}</strong><span>{shots.length ? exportReady ? '成片已生成，通过真实质检后开放播放与下载' : '点击下方按钮创建真实成片' : '请先完成分镜与时间线'}</span></div>
            </div>
          )}
          <div className="preview-meta"><span>{timeLabel}</span><span>{episode?.aspectRatio ?? '16:9'}</span><span>24 FPS</span><span>H.264 / AAC 48kHz</span></div>
        </section>
        <aside className="quality-panel">
          <h3>导出前置检查</h3>
          <div className="qc-list">{preflightChecks.map(([name, detail, status]) => <div key={name}><span className={status}>{status === 'pass' ? <Check size={12} /> : <AlertTriangle size={12} />}</span><div><strong>{name}</strong><small>{detail}</small></div></div>)}</div>
          <div className="quality-divider" />
          <div className="quality-heading"><div><h3>成片真实质检</h3><small>{qualityStatusLabel}</small></div><button className="button secondary" onClick={() => void submitQualityCheck()} disabled={!latestExportId || scopedExportRecord?.status !== 'succeeded' || qualitySubmitting || Boolean(scopedQualityReport && ['queued', 'running'].includes(scopedQualityReport.status))}><Gauge size={13} /> {qualitySubmitting || scopedQualityReport && ['queued', 'running'].includes(scopedQualityReport.status) ? '质检中' : scopedQualityReport ? '重新质检' : '运行质检'}</button></div>
          {scopedQualityReport?.checks.length ? <div className="qc-list real-qc-list">{scopedQualityReport.checks.map((check) => {
            const status = check.status === 'passed' ? 'pass' : check.status === 'warning' ? 'warn' : 'fail'
            return <div key={check.id}><span className={status}>{status === 'pass' ? <Check size={12} /> : <AlertTriangle size={12} />}</span><div><strong>{check.id}</strong><small>{check.message}</small></div></div>
          })}</div> : <div className="quality-empty"><CircleDashed size={14} /><span>导出完成后执行解码、规格、黑帧、静音、峰值、字幕时序与安全区 7 项检测</span></div>}
          {qualityError && <div className="source-generation-error"><AlertTriangle size={14} /><span>{qualityError}</span></div>}
          <div className="quality-divider" />
          <section className={`release-review-panel ${releaseApproved ? 'approved' : currentReleaseReview?.decision === 'reject' ? 'rejected' : ''}`} aria-label="人工发行复验">
            <div className="quality-heading">
              <div>
                <h3>人工发行复验</h3>
                <small>{releaseReviewStatusLabel}</small>
              </div>
              <span className={`release-review-state ${releaseApproved ? 'approved' : currentReleaseReview?.decision === 'reject' ? 'rejected' : ''}`}>
                {releaseApproved ? <CheckCircle2 size={12} /> : currentReleaseReview?.decision === 'reject' ? <AlertTriangle size={12} /> : <CircleDashed size={12} />}
                {releaseApproved ? '已批准' : currentReleaseReview?.decision === 'reject' ? '已驳回' : '待复验'}
              </span>
            </div>
            <p className="release-review-help">先完整播放审片版，再将人工判断写入不可变审计记录。技术质检本身不代表可发行。</p>
            <div className="release-review-checklist">
              <label>
                <input
                  type="checkbox"
                  checked={releaseReviewChecklist.audioVideoSync}
                  disabled={!releaseReviewReady || releaseReviewSubmitting !== null}
                  onChange={(event) => setReleaseReviewChecklist((current) => ({ ...current, audioVideoSync: event.target.checked }))}
                />
                <span><strong>音画匹配</strong><small>旁白与台词不跨镜，重要动作点一致</small></span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={releaseReviewChecklist.subtitleSyncAndComplete}
                  disabled={!releaseReviewReady || releaseReviewSubmitting !== null}
                  onChange={(event) => setReleaseReviewChecklist((current) => ({ ...current, subtitleSyncAndComplete: event.target.checked }))}
                />
                <span><strong>字幕同步且完整</strong><small>文本、时码和画面安全区均无问题</small></span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={releaseReviewChecklist.characterVisualSemantics}
                  disabled={!releaseReviewReady || releaseReviewSubmitting !== null}
                  onChange={(event) => setReleaseReviewChecklist((current) => ({ ...current, characterVisualSemantics: event.target.checked }))}
                />
                <span><strong>角色与画面语义一致</strong><small>人物、场景和关键道具符合当前剧情</small></span>
              </label>
            </div>
            <label className="release-review-notes">
              <span>审片备注 {hasReleaseCheckFailure ? '· 驳回时必填' : '· 可选'}</span>
              <textarea
                value={releaseReviewNotes}
                disabled={!releaseReviewReady || releaseReviewSubmitting !== null}
                maxLength={2_000}
                placeholder="记录需重做的镜头、台词或字幕问题…"
                onChange={(event) => {
                  setReleaseReviewNotes(event.target.value)
                  setReleaseReviewError('')
                }}
              />
            </label>
            <label className="release-review-acknowledgement">
              <input
                type="checkbox"
                checked={releaseReviewAcknowledged}
                disabled={!releaseReviewReady || releaseReviewSubmitting !== null}
                onChange={(event) => setReleaseReviewAcknowledged(event.target.checked)}
              />
              <span>我已在网页或系统播放器中完整审看当前成片</span>
            </label>
            {currentReleaseReview && (
              <div className="release-review-record">
                <strong>{currentReleaseReview.decision === 'approve' ? '最新记录：批准' : '最新记录：驳回'}</strong>
                <small>{new Date(currentReleaseReview.reviewedAt).toLocaleString('zh-CN')}{currentReleaseReview.notes ? ` · ${currentReleaseReview.notes}` : ''}</small>
                {currentReleaseReview.invalidReasons.length > 0 && <small>已失效：{currentReleaseReview.invalidReasons.join('、')}</small>}
              </div>
            )}
            {releaseReviewError && <div className="source-generation-error"><AlertTriangle size={14} /><span>{releaseReviewError}</span></div>}
            <div className="release-review-actions">
              <button
                className="button secondary danger"
                disabled={!releaseReviewReady || !releaseReviewAcknowledged || !hasReleaseCheckFailure || !releaseReviewNotes.trim() || releaseReviewSubmitting !== null}
                onClick={() => void submitReleaseReview('reject')}
              >
                <AlertTriangle size={13} /> {releaseReviewSubmitting === 'reject' ? '正在驳回' : '驳回并记录问题'}
              </button>
              <button
                className="button primary"
                disabled={!releaseReviewReady || !releaseReviewAcknowledged || !allReleaseChecksPassed || releaseReviewSubmitting !== null}
                onClick={() => void submitReleaseReview('approve')}
              >
                <Check size={13} /> {releaseReviewSubmitting === 'approve' ? '正在批准' : '批准发行'}
              </button>
            </div>
          </section>
        </aside>
      </div>
      <div className="stage-footer export-actions"><span><Cloud size={14} /> {latestExport?.status === 'failed' ? latestExport.error?.message ?? '上次渲染失败' : downloadUrl ? '技术质检与人工复验均通过，可下载发布版' : reviewUrl ? '技术质检已通过，请完成人工发行复验' : exportReady ? '成片已生成，先运行技术质检' : '不配置 Seedance 也可完成动态漫 MP4 闭环'}</span><div><button className="button secondary" onClick={onExport}><RefreshCcw size={14} /> {exportReady ? '重新导出' : '导出 MP4'}</button>{reviewUrl && <a className="button secondary" href={reviewUrl} download><Download size={14} /> 下载审片版</a>}{downloadUrl ? <a className="button primary export-cta" href={downloadUrl} download><Download size={14} /> 下载发布版</a> : <button className="button primary export-cta" disabled><Download size={14} /> {reviewUrl ? '等待人工批准' : exportReady ? '等待质检通过' : '尚无可下载成片'}</button>}</div></div>
    </div>
  )
}

function isStoryRevisionSnapshot(value: unknown): value is StoryDocument {
  if (!isRecordValue(value)
    || value.version !== 1
    || typeof value.title !== 'string'
    || !isRecordValue(value.bible)
    || !Array.isArray(value.characters)
    || !Array.isArray(value.locations)
    || !Array.isArray(value.props)
    || !Array.isArray(value.scenes)) return false
  return value.scenes.every((scene) => (
    isRecordValue(scene)
    && typeof scene.id === 'string'
    && typeof scene.title === 'string'
    && Array.isArray(scene.shots)
    && scene.shots.every((shot) => isRecordValue(shot) && typeof shot.id === 'string')
  ))
}

function StoryHistoryModal({
  scope,
  projectId,
  episode,
  episodeEtag,
  onClose,
  onRestored,
  onRestoreUncertain,
}: {
  scope: StoryOperationScope
  projectId: string
  episode: EpisodeSummary
  episodeEtag: string
  onClose: () => void
  onRestored: (result: StoryMutationResponse, scope: StoryOperationScope) => boolean
  onRestoreUncertain: (reason: unknown, scope: StoryOperationScope) => Promise<boolean>
}) {
  const [revisions, setRevisions] = useState<ProjectRevision[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'restoring' | 'error'>('loading')
  const [error, setError] = useState('')
  const dialogRef = useDialogFocus(() => {
    if (state !== 'restoring') onClose()
  })

  useEffect(() => {
    const controller = new AbortController()
    setState('loading')
    setError('')
    setRevisions([])
    setSelectedId(null)
    void api.listStoryRevisions(episode.id, { projectId, signal: controller.signal })
      .then((history) => {
        if (
          history.revisionId !== episode.sourceRevisionId
          || history.etag !== episodeEtag
        ) {
          setState('error')
          setError('剧本修订在打开历史记录后已变化，请关闭后重新打开')
          return
        }
        const storyRevisions = history.revisions.filter((revision) => isStoryRevisionSnapshot(revision.snapshot))
        setRevisions(storyRevisions)
        setSelectedId(storyRevisions.find((revision) => revision.id !== episode.sourceRevisionId)?.id
          ?? storyRevisions[0]?.id
          ?? null)
        setState('ready')
      })
      .catch((reason) => {
        if (controller.signal.aborted) return
        setState('error')
        setError(reason instanceof Error ? reason.message : '无法读取剧本版本')
      })
    return () => controller.abort()
  }, [episode.id, episode.sourceRevisionId, episodeEtag, projectId])

  const selected = revisions.find((revision) => revision.id === selectedId) ?? null
  const selectedStory = selected && isStoryRevisionSnapshot(selected.snapshot)
    ? selected.snapshot
    : null
  const restore = async () => {
    if (!selected || selected.id === episode.sourceRevisionId || state !== 'ready') return
    setState('restoring')
    setError('')
    try {
      const result = await api.restoreStoryRevision(
        episode.id,
        selected.id,
        { projectId, summary: `恢复剧本版本 ${selected.id}` },
        episodeEtag,
      )
      if (result.episode.projectId !== scope.projectId
        || result.episode.id !== scope.episodeId
        || result.episode.sourceRevisionId !== result.revisionId) {
        throw new Error('服务端返回的恢复结果不属于当前分集')
      }
      if (!onRestored(result, scope)) {
        setState('error')
        setError('当前分集已切换，旧分集恢复结果未载入')
      }
    } catch (reason) {
      if (await onRestoreUncertain(reason, scope)) return
      setState('error')
      setError(reason instanceof Error ? reason.message : '剧本版本恢复失败')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => { if (state !== 'restoring') onClose() }}>
      <div
        ref={dialogRef}
        className="history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header><div><small>不可变审计记录</small><h2 id="history-dialog-title">剧本版本记录</h2></div><button onClick={onClose} disabled={state === 'restoring'} aria-label="关闭版本记录"><X size={18} /></button></header>
        <div className="history-body">
          <div className="history-list">
            {revisions.map((revision) => {
              const snapshot = isStoryRevisionSnapshot(revision.snapshot) ? revision.snapshot : null
              const isCurrent = revision.id === episode.sourceRevisionId
              return <button key={revision.id} className={selectedId === revision.id ? 'active' : ''} onClick={() => setSelectedId(revision.id)}>
                <span className={isCurrent ? 'current' : ''}>{isCurrent ? <Check size={12} /> : <History size={12} />}</span>
                <div><strong>{revision.summary || '剧本修订'}</strong><small>{new Date(revision.createdAt).toLocaleString('zh-CN', { hour12: false })} · {snapshot?.scenes.length ?? 0} 场</small></div>
              </button>
            })}
            {state === 'loading' && <div className="history-empty"><CircleDashed size={16} />正在读取版本…</div>}
            {state !== 'loading' && revisions.length === 0 && <div className="history-empty"><History size={16} />尚无可恢复的结构化剧本版本</div>}
          </div>
          <section className="history-detail">
            {selected && selectedStory ? <>
              <small>REVISION {selected.id.slice(0, 12)}</small>
              <h3>{selectedStory.title}</h3>
              <p>{selected.summary}</p>
              <div><span>场次</span><strong>{selectedStory.scenes.length}</strong></div>
              <div><span>镜头</span><strong>{selectedStory.scenes.reduce((total, scene) => total + scene.shots.length, 0)}</strong></div>
              <div><span>目标时长</span><strong>{selectedStory.targetDurationSeconds}s</strong></div>
              <div className="history-warning"><AlertTriangle size={14} /><span>恢复会创建一个新的审计修订，并将当前下游资产、任务、导出与 QC 标记为过期；历史版本不会被覆盖。</span></div>
            </> : <div className="history-empty">请选择一个剧本版本</div>}
          </section>
        </div>
        {error && <div className="source-generation-error history-error"><AlertTriangle size={14} /><span>{error}</span></div>}
        <footer><button className="button secondary" onClick={onClose} disabled={state === 'restoring'}>取消</button><button className="button primary" disabled={!selected || selected.id === episode.sourceRevisionId || state !== 'ready'} onClick={() => void restore()}><RotateCcw size={14} /> {state === 'restoring' ? '正在创建恢复修订…' : selected?.id === episode.sourceRevisionId ? '当前已是该版本' : '恢复为新版本'}</button></footer>
      </div>
    </div>
  )
}

function CommandPalette({
  scope,
  onClose,
  onStage,
  onEntity,
}: {
  scope: {
    projectId: string
    episodeId: string
    sourceRevisionId: string
    episodeEtag: string
  } | null
  onClose: () => void
  onStage: (stage: string) => void
  onEntity: (result: StoryEntitySearchResult) => void
}) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [results, setResults] = useState<StoryEntitySearchResult[]>([])
  const [searchTotal, setSearchTotal] = useState(0)
  const [searchHasMore, setSearchHasMore] = useState(false)
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [searchError, setSearchError] = useState('')
  const dialogRef = useDialogFocus(onClose)
  const normalizedQuery = query.trim()
  const filteredStages = stages.filter((stage) =>
    `${stage.name} ${stage.short}`.toLowerCase().includes(normalizedQuery.toLowerCase()),
  )
  const optionCount = filteredStages.length + results.length
  const activeOptionId = selectedIndex < filteredStages.length
    ? `command-stage-${filteredStages[selectedIndex]?.id}`
    : results[selectedIndex - filteredStages.length]
      ? storyEntityOptionId(results[selectedIndex - filteredStages.length]!)
      : undefined

  function storyEntityOptionId(result: StoryEntitySearchResult): string {
    return `command-entity-${result.type}-${result.sceneId ?? 'root'}-${result.shotId ?? 'root'}-${result.entityId}`
  }

  useEffect(() => {
    if (!normalizedQuery) {
      setResults([])
      setSearchTotal(0)
      setSearchHasMore(false)
      setSearchState('idle')
      setSearchError('')
      return
    }
    if (!scope) {
      setResults([])
      setSearchTotal(0)
      setSearchHasMore(false)
      setSearchState('ready')
      setSearchError('当前还没有可搜索的分集剧本')
      return
    }
    const controller = new AbortController()
    setResults([])
    setSearchTotal(0)
    setSearchHasMore(false)
    setSearchState('loading')
    setSearchError('')
    const timer = window.setTimeout(() => {
      void api.searchStoryEntities(scope.episodeId, {
        projectId: scope.projectId,
        query: normalizedQuery,
        limit: 100,
        signal: controller.signal,
      }).then((response) => {
        if (controller.signal.aborted) return
        if (response.sourceRevisionId !== scope.sourceRevisionId || response.etag !== scope.episodeEtag) {
          setResults([])
          setSearchTotal(0)
          setSearchHasMore(false)
          setSearchState('error')
          setSearchError('搜索期间剧本修订已变化，请关闭后重新打开搜索')
          return
        }
        setResults(response.results)
        setSearchTotal(response.total)
        setSearchHasMore(response.hasMore)
        setSearchState('ready')
      }).catch((reason) => {
        if (controller.signal.aborted) return
        setResults([])
        setSearchTotal(0)
        setSearchHasMore(false)
        setSearchState('error')
        setSearchError(reason instanceof Error ? reason.message : '当前分集实体搜索失败')
      })
    }, 200)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [
    normalizedQuery,
    scope?.episodeEtag,
    scope?.episodeId,
    scope?.projectId,
    scope?.sourceRevisionId,
  ])

  useEffect(() => setSelectedIndex(0), [normalizedQuery])

  useEffect(() => {
    setSelectedIndex((index) => optionCount === 0 ? 0 : Math.min(index, optionCount - 1))
  }, [optionCount])

  const openStage = (stageId: string) => {
    onStage(stageId)
    onClose()
  }

  const openEntity = (result: StoryEntitySearchResult) => {
    onEntity(result)
    onClose()
  }

  const openSelected = () => {
    if (selectedIndex < filteredStages.length) {
      const stage = filteredStages[selectedIndex]
      if (stage) openStage(stage.id)
      return
    }
    const result = results[selectedIndex - filteredStages.length]
    if (result) openEntity(result)
  }

  const entityTypeLabel: Record<StoryEntitySearchResult['type'], string> = {
    scene: '场景',
    shot: '镜头',
    dialogue: '台词',
    character: '角色',
    location: '场景资产',
    prop: '道具',
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="快速命令"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-input">
          <Search size={17} />
          <input
            value={query}
            maxLength={100}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelectedIndex((index) => optionCount ? (index + 1) % optionCount : 0)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelectedIndex((index) => optionCount ? (index - 1 + optionCount) % optionCount : 0)
              } else if (event.key === 'Enter' && optionCount > 0) {
                event.preventDefault()
                openSelected()
              }
            }}
            placeholder="搜索镜头、台词、角色、场景或道具…"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={activeOptionId}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="command-section" id="command-results" role="listbox">
          {filteredStages.length > 0 && <small>制作阶段</small>}
          {filteredStages.map((stage, index) => (
            <button
              id={`command-stage-${stage.id}`}
              key={stage.id}
              className={selectedIndex === index ? 'selected' : ''}
              role="option"
              aria-selected={selectedIndex === index}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => openStage(stage.id)}
            >
              <span>{String(stages.findIndex((item) => item.id === stage.id) + 1).padStart(2, '0')}</span>
              <strong>{stage.name}</strong>
              <ChevronRight size={14} />
            </button>
          ))}
          {normalizedQuery && <small>当前分集实体 · SQLite</small>}
          {results.map((result, resultIndex) => {
            const index = filteredStages.length + resultIndex
            return (
              <button
                id={storyEntityOptionId(result)}
                key={`${result.type}:${result.sceneId ?? ''}:${result.shotId ?? ''}:${result.entityId}`}
                className={`command-entity-result ${selectedIndex === index ? 'selected' : ''}`}
                role="option"
                aria-selected={selectedIndex === index}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => openEntity(result)}
              >
                <span>{entityTypeLabel[result.type]}</span>
                <div><strong>{result.title}</strong><small>{result.snippet}</small></div>
                <ChevronRight size={14} />
              </button>
            )
          })}
          {normalizedQuery && searchState === 'loading' && (
            <div className="command-empty"><CircleDashed size={14} /> 正在查询当前剧本…</div>
          )}
          {normalizedQuery && searchState !== 'loading' && searchError && (
            <div className={`command-empty ${searchState === 'error' ? 'error' : ''}`}><AlertTriangle size={14} /> {searchError}</div>
          )}
          {normalizedQuery && searchState === 'ready' && !searchError && optionCount === 0 && (
            <div className="command-empty">当前剧本没有匹配的实体</div>
          )}
          {normalizedQuery && searchState === 'ready' && searchHasMore && (
            <div className="command-search-truncated">已显示前 {results.length} / {searchTotal} 条，请继续缩小关键词以定位其余结果。</div>
          )}
        </div>
        <div className="command-footer"><span>↑↓ 选择</span><span>↵ 定位</span><span>仅搜索当前不可变剧本修订</span></div>
      </div>
    </div>
  )
}

function ExportModal({
  onClose,
  onSubmitted,
  story,
  episode,
  shots,
  timelineSnapshot,
}: {
  onClose: () => void
  onSubmitted: () => Promise<void>
  story: StoryDocument | null
  episode: EpisodeSummary | null
  shots: Shot[]
  timelineSnapshot: TimelineDocumentSnapshot
}) {
  const [resolution, setResolution] = useState<ExportRenderResolution>('1080p')
  // Managed subtitles are generated from the same speech timing source as
  // dialogue audio. Keep them enabled by default; users may still opt out.
  const [burnSubtitles, setBurnSubtitles] = useState(true)
  const [introTitle, setIntroTitle] = useState(true)
  const [outroCard, setOutroCard] = useState(true)
  const [reviewWatermark, setReviewWatermark] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submissionError, setSubmissionError] = useState('')
  const idempotencyAttemptRef = useRef<{ signature: string; key: string } | null>(null)
  const dialogRef = useDialogFocus(() => {
    if (!submitting) onClose()
  })
  const totalDuration = shots.reduce((total, shot) => {
    const seconds = Number.parseFloat(shot.duration)
    return total + (Number.isFinite(seconds) ? seconds : 0)
  }, 0)
  const readyShots = shots.filter((shot) => Boolean(shot.assetId)).length
  const canExport = Boolean(
    story
    && episode?.sourceRevisionId
    && shots.length > 0
    && readyShots === shots.length,
  )

  const submitExport = async () => {
    if (!canExport || !episode || submitting) return
    setSubmitting(true)
    setSubmissionError('')
    try {
      const timeline = assertPinnedTimeline(timelineSnapshot, {
        projectId: episode.projectId,
        episodeId: episode.id,
        sourceRevisionId: episode.sourceRevisionId,
      })

      const request = {
        projectId: episode.projectId,
        timelineRevisionId: timeline.revision.id,
        resolution,
        // RSP v4 compiles per-image scale motion from the pinned OpenCut
        // timeline. The legacy export-wide effect must never be layered over it.
        kenBurns: false,
        burnSubtitles,
        introTitle,
        outroCard,
        reviewWatermark,
      }
      const signature = JSON.stringify(request)
      const priorAttempt = idempotencyAttemptRef.current
      const idempotencyKey = priorAttempt?.signature === signature
        ? priorAttempt.key
        : crypto.randomUUID()
      idempotencyAttemptRef.current = { signature, key: idempotencyKey }

      try {
        await api.createExportRender(
          episode.id,
          request,
          timeline.etag,
          idempotencyKey,
        )
      } catch (error) {
        // Preserve the key for every response that did not positively
        // acknowledge the durable export, including malformed 2xx payloads.
        throw error
      }
      idempotencyAttemptRef.current = null
      await onSubmitted()
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : '无法提交真实导出任务')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => { if (!submitting) onClose() }}>
      <div
        ref={dialogRef}
        className="export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header><div><small>本地正式渲染</small><h2 id="export-dialog-title">导出「{story?.title ?? episode?.title ?? '未命名漫剧'}」</h2></div><button onClick={onClose} disabled={submitting} aria-label="关闭导出设置"><X size={18} /></button></header>
        <div className="export-summary"><div className="export-thumbnail frame-wide" style={shots[0]?.imageUrl ? { backgroundImage: `url(${JSON.stringify(shots[0].imageUrl)})`, backgroundPosition: 'center', backgroundSize: 'cover' } : undefined}><span>{episode?.title ?? 'EP.01'}</span></div><div><strong>{story?.title ?? '当前项目'} · {episode?.title ?? '当前分集'}</strong><span>时长 {Math.round(totalDuration)} 秒 · {readyShots}/{shots.length} 镜素材就绪</span><small><Film size={12} /> 固化修订 {timelineSnapshot.revision.id.slice(0, 8)} · 预览/导出共享</small></div></div>
        <section><label>分辨率</label><div className="preset-options">{(['720p', '1080p'] as const).map((item) => <button className={resolution === item ? 'active' : ''} onClick={() => setResolution(item)} disabled={submitting} key={item}>{item.toUpperCase()}</button>)}</div></section>
        <div className="export-options">
          <div className="export-option-timeline-motion">
            <Film size={13} />
            <span><strong>镜头运动来自 OpenCut 时间线</strong><small>新建导出不再叠加旧的全局推拉效果。</small></span>
          </div>
          <label><input type="checkbox" checked={burnSubtitles} disabled={submitting} onChange={(event) => setBurnSubtitles(event.target.checked)} /> 烧录整句字幕</label>
          <label title="只在时间线开头画面上叠加标题，不新增时长"><input type="checkbox" checked={introTitle} disabled={submitting} onChange={(event) => setIntroTitle(event.target.checked)} /> 片头标题落版</label>
          <label title="只在时间线结尾画面上叠加落版，不新增时长"><input type="checkbox" checked={outroCard} disabled={submitting} onChange={(event) => setOutroCard(event.target.checked)} /> 片尾结束落版</label>
          <label title="烧录固定的审片版本标记"><input type="checkbox" checked={reviewWatermark} disabled={submitting} onChange={(event) => setReviewWatermark(event.target.checked)} /> 审片水印</label>
        </div>
        <small className="speech-disclaimer">“片头标题落版 / 片尾结束落版”只叠加在现有开头/结尾画面，不新增时长，不代表完整片头动画。字幕优先使用时间线字幕轨；无可用对白时不会伪造字幕。</small>
        {!canExport && <div className="export-cost"><span>导出前置条件</span><strong><AlertTriangle size={13} /> {!story ? '请先生成剧本' : !episode?.sourceRevisionId ? '请先保存有效剧本修订' : !shots.length ? '剧本中尚无镜头' : `还有 ${shots.length - readyShots} 镜未生成画面`}</strong></div>}
        {submissionError && <div className="source-generation-error"><AlertTriangle size={14} /><span>{submissionError}</span></div>}
        <footer><button className="button secondary" onClick={onClose} disabled={submitting}>取消</button><button className="button primary" disabled={!canExport || submitting} onClick={() => void submitExport()}><CloudUpload size={15} /> {submitting ? '正在提交固化修订…' : canExport ? '创建 FFmpeg 导出任务' : '素材未就绪'}</button></footer>
      </div>
    </div>
  )
}

export default App
