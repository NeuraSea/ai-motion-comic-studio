import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  CANONICAL_TIMELINE_SCHEMA_VERSION,
  createOpenCutCommandEditor,
  createOpenCutElementInteractions,
  createOpenCutTimelineEngine,
  createOpenCutTimelineInteractions,
  getOpenCutTimelineLayout,
  getOpenCutTimelineZoomMin,
  getOpenCutTrackHeight,
  OPEN_CUT_CLASSIC_COMMIT,
  OPEN_CUT_TIMELINE_LAYOUT_METRICS,
  OPEN_CUT_TICKS_PER_SECOND,
  openCutSliderToZoom,
  openCutTimelineTimeToPixels,
  openCutZoomToSlider,
  type EditorElementRef,
  type EditorSceneTracks,
  type EditorTimelineElement,
  type ElementUpdateEntry,
  type OpenCutElementInteractionConfig,
  type OpenCutTimelineInteractionConfig,
  type OpenCutTimelineViewState,
} from '@manju/opencut-editor'
import {
  ChevronDown,
  ChevronUp,
  Cloud,
  Clock3,
  Copy,
  Download,
  Film,
  History,
  Image as ImageIcon,
  Mic2,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  Scissors,
  Sparkles,
  Server,
  Trash2,
  Type,
  Volume2,
} from 'lucide-react'
import {
  ApiError,
  api,
  type TimelineAutoEditPreview,
  type TimelineDocumentHistory,
  type TimelineDocumentRevision,
  type TimelineDocumentSnapshot,
} from '../../lib'
import {
  ManjuStorageAdapter,
  TimelineStorageConflictError,
  TimelineStorageIncompatibleSnapshotError,
  type TimelineConflictRescueSnapshot,
  type TimelineStorageState,
} from './manju-storage-adapter'
import { projectManagedSubtitleCueSetToOpenCut } from './managed-subtitle-projection'
import {
  inspectOpenCutRevisionCompatibility,
  inspectOpenCutSnapshotCompatibility,
  openCutTimelineDocument,
  parseOpenCutTracks,
} from './timeline-codec'
import type { TimelinePersistenceHandle } from './timeline-revision-handoff'
import { resolveTimelineKernelLabel } from './timeline-status'
import { readAppliedShortVideoFillDisplay } from './short-video-fill-display'
import {
  buildVisualOpacityFadeAnimation,
  readVisualOpacityFadeDraft,
  splitFallsInsideVisualOpacityTransition,
  VISUAL_OPACITY_FRAME_RATE,
  VISUAL_OPACITY_FRAME_TICKS,
} from './visual-opacity-fade'
import {
  buildVisualUniformScaleMotionAnimation,
  readVisualUniformScaleMotionDraft,
  VISUAL_UNIFORM_SCALE_STRENGTHS,
  type VisualUniformScaleMotionDraft,
} from './visual-uniform-scale-motion'
import {
  buildVisualShapeMasks,
  readVisualShapeMaskDraft,
  type VisualShapeMaskDraft,
} from './visual-shape-mask'
import {
  buildVisualFitParamPatch,
  readVisualFitDraft,
  type VisualFitDraft,
  type VisualFitMode,
} from './visual-fit'
import {
  planAgenticVisualMotion,
  updatesForAgenticVisualMotion,
  type AgenticVisualMotionPlan,
} from './agentic-visual-motion'
import {
  buildTimelineAutoEditPreviewOverlay,
  createTimelineAutoEditIdempotencyKey,
  readCurrentTimelineAutomaticEdit,
  TimelineAutoEditPreviewValidationError,
  withoutActiveTimelineAutoEditReceipt,
  type TimelineAutomaticEditDisplay,
  type TimelineAutoEditPreviewOverlay,
} from './timeline-automatic-edit-state'
import {
  OpenCutProgramMonitor,
  type OpenCutProgramMonitorHandle,
} from './OpenCutProgramMonitor'

export interface OpenCutTimelineShot {
  id: number
  storyId?: string
  sceneId?: string
  code: string
  duration: string
  dialogue?: string
  imageClass: string
  imageUrl?: string
  assetId?: string
  framing?: string
  movement?: string
}

export interface OpenCutTimelineProps {
  open: boolean
  onToggle: () => void
  activeShot: number
  shots: OpenCutTimelineShot[]
  onSelect: (id: number) => void
  persistence?: {
    projectId: string
    episodeId: string
    sourceRevisionId: string | null
    assetRevisionKey: string
    aspectRatio: string
  }
  persistenceHandleRef?: { current: TimelinePersistenceHandle | null }
  onPersistenceReadyChange?: (ready: boolean) => void
}

type ResizePreview = Map<string, ElementUpdateEntry['patch']>
type AudioMixDraft = {
  key: string
  volume: number
  fadeInSeconds: number
  fadeOutSeconds: number
}

type SourceAudioDraft = {
  key: string
  enabled: boolean
  volume: number
}

type VisualFitControlDraft = VisualFitDraft & {
  key: string
  expectedFit: VisualFitMode
}

type VisualFadeDraft = {
  key: string
  fadeInFrames: number
  fadeOutFrames: number
}

type VisualScaleDraft = VisualUniformScaleMotionDraft & { key: string }

type VisualMaskDraft = VisualShapeMaskDraft & { key: string }

type TimelineAutoEditBusy = 'preview' | 'apply' | 'undo' | null
type TimelineHistoryBusy = 'load' | 'restore' | null
type TimelineConflictBusy = 'copy' | 'adopt' | 'save' | null
type TimelineQuarantineBusy = 'copy' | null

type TimelineCanonicalQuarantine = {
  storage: ManjuStorageAdapter
  snapshot: TimelineDocumentSnapshot
  detectedAt: string
  reasons: string[]
}

type AgenticMotionPreviewBinding = {
  plan: AgenticVisualMotionPlan
  commandEditor: ReturnType<typeof createOpenCutCommandEditor>
  storage: ManjuStorageAdapter | null
  baseRevisionId: string | null
  baseEtag: string | null
}

function elementKey(trackId: string, elementId: string): string {
  return `${trackId}\u0000${elementId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createTimelineRestoreIdempotencyKey(): string {
  return `timeline-restore-${crypto.randomUUID()}`
}

function timelineRevisionStats(revision: TimelineDocumentRevision): {
  tracks: number
  elements: number
  durationTicks: number
} {
  const parsed = parseOpenCutTracks(revision.snapshot)
  if (!parsed) return { tracks: 0, elements: 0, durationTicks: 0 }
  const tracks = [...parsed.overlay, parsed.main, ...parsed.audio]
  return {
    tracks: tracks.length,
    elements: tracks.reduce((count, track) => count + track.elements.length, 0),
    durationTicks: tracks.reduce((end, track) => Math.max(
      end,
      ...track.elements.map((element) => element.startTime + element.duration),
    ), 0),
  }
}

function conflictRescuePayload(
  persistence: NonNullable<OpenCutTimelineProps['persistence']>,
  rescue: TimelineConflictRescueSnapshot,
): Record<string, unknown> {
  return {
    version: 1,
    kind: 'manju.timeline-conflict-rescue',
    projectId: persistence.projectId,
    episodeId: persistence.episodeId,
    sourceRevisionId: persistence.sourceRevisionId,
    capturedAt: rescue.capturedAt,
    expectedEtag: rescue.expectedEtag,
    conflictedWithRevisionId: rescue.currentRevisionId,
    document: rescue.document,
  }
}

function authoritativeQuarantinePayload(
  snapshot: TimelineDocumentSnapshot,
  detectedAt: string,
): Record<string, unknown> {
  return {
    version: 1,
    kind: 'manju.timeline-authoritative-canonical-quarantine',
    detectedAt,
    scope: {
      documentId: snapshot.timelineDocument.id,
      projectId: snapshot.timelineDocument.projectId,
      episodeId: snapshot.timelineDocument.episodeId,
      sourceRevisionId: snapshot.timelineDocument.sourceRevisionId,
    },
    revision: {
      id: snapshot.revision.id,
      parentRevisionId: snapshot.revision.parentRevisionId,
      schemaVersion: snapshot.revision.schemaVersion,
      upstreamCommit: snapshot.revision.upstreamCommit,
      sourceRevisionId: snapshot.revision.sourceRevisionId,
      summary: snapshot.revision.summary,
      createdAt: snapshot.revision.createdAt,
      etag: snapshot.etag,
    },
    document: snapshot.document,
  }
}

function readViewState(document: Record<string, unknown>): OpenCutTimelineViewState | null {
  const manju = isRecord(document.manju) ? document.manju : null
  const value = manju && isRecord(manju.timelineViewState) ? manju.timelineViewState : null
  if (!value
    || typeof value.zoomLevel !== 'number' || !Number.isFinite(value.zoomLevel) || value.zoomLevel <= 0
    || typeof value.scrollLeft !== 'number' || !Number.isFinite(value.scrollLeft) || value.scrollLeft < 0
    || !Number.isSafeInteger(value.playheadTime) || (value.playheadTime as number) < 0) return null
  return {
    zoomLevel: value.zoomLevel,
    scrollLeft: value.scrollLeft,
    playheadTime: value.playheadTime as number,
  }
}

function withViewState(
  document: Record<string, unknown>,
  viewState: OpenCutTimelineViewState,
): Record<string, unknown> {
  return {
    ...document,
    manju: {
      ...(isRecord(document.manju) ? document.manju : {}),
      timelineViewState: { ...viewState },
    },
  }
}

function shotForElement(
  shots: readonly OpenCutTimelineShot[],
  element: EditorTimelineElement,
): OpenCutTimelineShot | null {
  const numericShotId = Number(element.params?.shotId)
  const storyShotId = typeof element.params?.storyShotId === 'string'
    ? element.params.storyShotId
    : null
  return shots.find((shot) => shot.id === numericShotId
    || (storyShotId !== null && shot.storyId === storyShotId)) ?? null
}

function initialSceneTracks(
  shots: readonly OpenCutTimelineShot[],
  sourceRevisionId: string | null | undefined,
): EditorSceneTracks {
  let cursor = 0
  const elements = shots.map((shot): EditorTimelineElement => {
    const parsed = Number.parseFloat(shot.duration)
    const duration = Math.max(
      Math.round((Number.isFinite(parsed) ? parsed : 2) * OPEN_CUT_TICKS_PER_SECOND),
      Math.round(OPEN_CUT_TICKS_PER_SECOND / 24),
    )
    const unresolved = !shot.assetId
    const element: EditorTimelineElement = {
      id: `shot-${shot.id}`,
      name: shot.code,
      type: 'image',
      startTime: cursor,
      duration,
      trimStart: 0,
      trimEnd: 0,
      mediaId: shot.assetId ?? `manju:pending:${encodeURIComponent(`shot-${shot.id}`)}`,
      params: {
        shotId: String(shot.id),
        ...(shot.storyId ? { storyShotId: shot.storyId } : {}),
        ...(shot.sceneId ? { storySceneId: shot.sceneId } : {}),
        ...(sourceRevisionId ? { sourceRevisionId } : {}),
      },
      ...(unresolved ? { manju: { mediaBindingState: 'unresolved' } } : {}),
    }
    cursor += duration
    return element
  })
  return {
    overlay: [{
      id: 'visual-main',
      name: '画面',
      type: 'video',
      hidden: false,
      muted: false,
      elements,
    }],
    main: {
      id: 'main',
      name: '主轨',
      type: 'video',
      hidden: false,
      muted: false,
      elements: [],
    },
    audio: [],
  }
}

function timecode(ticks: number): string {
  const seconds = Math.max(0, ticks) / OPEN_CUT_TICKS_PER_SECOND
  const whole = Math.floor(seconds)
  const frames = Math.floor((seconds - whole) * 24)
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}

function trackLabel(track: { id: string; name?: string; type: string }): string {
  if (track.name?.trim()) return track.name.trim()
  if (track.id === 'visual-main') return '画面'
  if (track.id === 'dialogue-main') return '对白'
  return track.type === 'audio' ? '音频' : track.type === 'video' ? '画面' : '图层'
}

export function OpenCutTimeline({
  open,
  onToggle,
  activeShot,
  shots,
  onSelect,
  persistence,
  persistenceHandleRef,
  onPersistenceReadyChange,
}: OpenCutTimelineProps) {
  const engine = useMemo(() => createOpenCutTimelineEngine(), [])
  const editorSeed = shots.map((shot) => `${shot.id}:${shot.duration}`).join('|')
  const shotSelectionSeed = shots.map((shot) => `${shot.id}:${shot.storyId ?? ''}`).join('|')
  const initialTracks = useMemo(
    () => initialSceneTracks(shots, persistence?.sourceRevisionId),
    // Media changes arrive through server reconcile and must not destroy the
    // current OpenCut command history before the new revision is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorSeed],
  )
  const storage = useMemo(() => persistence ? new ManjuStorageAdapter({
    projectId: persistence.projectId,
    episodeId: persistence.episodeId,
    schemaVersion: CANONICAL_TIMELINE_SCHEMA_VERSION,
    upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
    sourceRevisionId: persistence.sourceRevisionId,
    validateDocument: (document) => parseOpenCutTracks(document) !== null,
  }) : null, [
    persistence?.assetRevisionKey,
    persistence?.episodeId,
    persistence?.projectId,
    persistence?.sourceRevisionId,
  ])
  const [hydratedTimeline, setHydratedTimeline] = useState<{
    storage: ManjuStorageAdapter
    tracks: EditorSceneTracks
    automaticEdit: TimelineAutomaticEditDisplay | null
  } | null>(null)
  const [authoritativeTimeline, setAuthoritativeTimeline] = useState<TimelineDocumentSnapshot | null>(null)
  const hydratedTracks = hydratedTimeline?.storage === storage
    ? hydratedTimeline.tracks
    : null
  const automaticEdit = hydratedTimeline?.storage === storage
    ? hydratedTimeline.automaticEdit
    : null
  const commandEditor = useMemo(
    () => createOpenCutCommandEditor({ tracks: hydratedTracks ?? initialTracks }),
    [hydratedTracks, initialTracks],
  )
  const [tracks, setTracks] = useState<EditorSceneTracks>(() => commandEditor.getTracks())
  const [playbackState, setPlaybackState] = useState(() => commandEditor.playback.getSnapshot())
  const [playheadTicks, setPlayheadTicks] = useState(0)
  const [programMonitorExpanded, setProgramMonitorExpanded] = useState(true)
  const [programMonitorReady, setProgramMonitorReady] = useState(false)
  const [programPlaybackEnabled, setProgramPlaybackEnabled] = useState(false)
  const [selectedElements, setSelectedElements] = useState<EditorElementRef[]>([])
  const [audioMixDraft, setAudioMixDraft] = useState<AudioMixDraft | null>(null)
  const [sourceAudioDraft, setSourceAudioDraft] = useState<SourceAudioDraft | null>(null)
  const [visualFitDraft, setVisualFitDraft] = useState<VisualFitControlDraft | null>(null)
  const [visualFitBlocked, setVisualFitBlocked] = useState('')
  const [visualFadeDraft, setVisualFadeDraft] = useState<VisualFadeDraft | null>(null)
  const [visualFadeBlocked, setVisualFadeBlocked] = useState('')
  const [visualScaleDraft, setVisualScaleDraft] = useState<VisualScaleDraft | null>(null)
  const [visualScaleBlocked, setVisualScaleBlocked] = useState('')
  const [visualMaskDraft, setVisualMaskDraft] = useState<VisualMaskDraft | null>(null)
  const [visualMaskBlocked, setVisualMaskBlocked] = useState('')
  const [resizePreview, setResizePreview] = useState<ResizePreview>(() => new Map())
  const [automaticEditPreview, setAutomaticEditPreview] = useState<TimelineAutoEditPreview | null>(null)
  const [automaticEditPreviewOverlay, setAutomaticEditPreviewOverlay] = useState<TimelineAutoEditPreviewOverlay | null>(null)
  const [automaticEditBusy, setAutomaticEditBusy] = useState<TimelineAutoEditBusy>(null)
  const [automaticEditError, setAutomaticEditError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [timelineHistory, setTimelineHistory] = useState<TimelineDocumentHistory | null>(null)
  const [selectedHistoryRevisionId, setSelectedHistoryRevisionId] = useState<string | null>(null)
  const [timelineHistoryBusy, setTimelineHistoryBusy] = useState<TimelineHistoryBusy>(null)
  const [timelineHistoryError, setTimelineHistoryError] = useState('')
  const [timelineConflictRescue, setTimelineConflictRescue] = useState<TimelineConflictRescueSnapshot | null>(null)
  const [timelineConflictBusy, setTimelineConflictBusy] = useState<TimelineConflictBusy>(null)
  const [timelineConflictMessage, setTimelineConflictMessage] = useState('')
  const [timelineCanonicalQuarantine, setTimelineCanonicalQuarantine] = useState<TimelineCanonicalQuarantine | null>(null)
  const [timelineQuarantineBusy, setTimelineQuarantineBusy] = useState<TimelineQuarantineBusy>(null)
  const [timelineQuarantineMessage, setTimelineQuarantineMessage] = useState('')
  const [agenticMotionPlan, setAgenticMotionPlan] = useState<AgenticVisualMotionPlan | null>(null)
  const [snapLabel, setSnapLabel] = useState('OpenCut controllers 已启用')
  const [storageState, setStorageState] = useState<TimelineStorageState>({
    phase: 'idle', dirty: false, etag: null, currentRevisionId: null, lastSavedAt: null,
  })
  const [viewportWidth, setViewportWidth] = useState(0)
  const timelineDocumentBaseRef = useRef<Record<string, unknown>>({})
  const viewStateRef = useRef<OpenCutTimelineViewState | null>(null)
  const timelineDrivenShotSelectionRef = useRef<number | null>(null)
  const shiftHeldRef = useRef(false)
  const timelineContainerRef = useRef<HTMLDivElement>(null)
  const trackLabelsRef = useRef<HTMLDivElement>(null)
  const trackLabelRowsRef = useRef<HTMLDivElement>(null)
  const rulerScrollRef = useRef<HTMLDivElement>(null)
  const tracksScrollRef = useRef<HTMLDivElement>(null)
  const tracksContainerRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const programMonitorRef = useRef<OpenCutProgramMonitorHandle>(null)
  const automaticEditAttemptsRef = useRef(new Map<string, string>())
  const historyRestoreAttemptsRef = useRef(new Map<string, string>())
  const storageRef = useRef(storage)
  const agenticMotionPreviewRef = useRef<AgenticMotionPreviewBinding | null>(null)
  const agenticMotionApplyRef = useRef(false)
  storageRef.current = storage

  const clearAgenticMotionPreview = () => {
    agenticMotionPreviewRef.current = null
    setAgenticMotionPlan(null)
  }

  const orderedTracks = useMemo(
    () => [...tracks.overlay, tracks.main, ...tracks.audio],
    [tracks],
  )
  const selectedAudioBinding = selectedElements.length === 1
    ? orderedTracks.flatMap((track) => (
        track.elements.map((element) => ({ track, element }))
      )).find(({ track, element }) => (
        track.id === selectedElements[0].trackId
        && element.id === selectedElements[0].elementId
        && element.type === 'audio'
      )) ?? null
    : null
  const selectedSourceAudioBinding = selectedElements.length === 1
    ? orderedTracks.flatMap((track) => (
        track.elements.map((element) => ({ track, element }))
      )).find(({ track, element }) => (
        track.id === selectedElements[0].trackId
        && element.id === selectedElements[0].elementId
        && track.type === 'video'
        && element.type === 'video'
        && element.isSourceAudioEnabled !== undefined
      )) ?? null
    : null
  const selectedVisualBinding = selectedElements.length === 1
    ? orderedTracks.flatMap((track) => (
        track.elements.map((element) => ({ track, element }))
      )).find(({ track, element }) => (
        track.id === selectedElements[0].trackId
        && element.id === selectedElements[0].elementId
        && track.type === 'video'
        && (element.type === 'image' || element.type === 'video')
      )) ?? null
    : null
  const previewEndTicks = automaticEditPreview?.operations.reduce((maximum, operation) => (
    Math.max(maximum, operation.after.startTime + operation.after.duration)
  ), 0) ?? 0
  const totalTicks = Math.max(
    commandEditor.playback.getSnapshot().duration,
    previewEndTicks,
    OPEN_CUT_TICKS_PER_SECOND,
  )
  const minZoom = getOpenCutTimelineZoomMin({
    duration: totalTicks,
    containerWidth: viewportWidth || undefined,
  })

  const persistViewState = (viewState: OpenCutTimelineViewState) => {
    viewStateRef.current = viewState
    timelineDocumentBaseRef.current = withViewState(
      timelineDocumentBaseRef.current,
      viewState,
    )
  }

  const timelineInteractionConfig: OpenCutTimelineInteractionConfig = {
    minZoom,
    duration: totalTicks,
    isSelecting: false,
    getContainerEl: () => timelineContainerRef.current,
    getPlayheadEl: () => playheadRef.current,
    getTrackLabelsEl: () => trackLabelsRef.current,
    getRulerScrollEl: () => rulerScrollRef.current,
    getTracksScrollEl: () => tracksScrollRef.current,
    getActiveProjectFps: () => ({ numerator: 24, denominator: 1 }),
    getCurrentPlayheadTime: () => commandEditor.playback.getSnapshot().currentTime,
    clearSelectedElements: () => {
      commandEditor.setSelectedElements([])
      setSelectedElements([])
    },
    seek: (time) => commandEditor.playback.seek(time),
    setTimelineViewState: persistViewState,
  }
  const timelineInteractionConfigRef = useRef(timelineInteractionConfig)
  timelineInteractionConfigRef.current = timelineInteractionConfig
  const timelineInteractions = useMemo(() => createOpenCutTimelineInteractions({
    getConfig: () => timelineInteractionConfigRef.current,
    initialZoom: viewStateRef.current?.zoomLevel,
  }), [commandEditor])
  const zoomLevel = useSyncExternalStore(
    timelineInteractions.subscribeZoom,
    () => timelineInteractions.zoomLevel,
    () => timelineInteractions.zoomLevel,
  )
  const layout = getOpenCutTimelineLayout({
    duration: totalTicks,
    containerWidth: Math.max(1, viewportWidth),
    zoomLevel,
  })

  useEffect(() => {
    if (!selectedAudioBinding) {
      setAudioMixDraft(null)
      return
    }
    const params = selectedAudioBinding.element.params ?? {}
    setAudioMixDraft({
      key: elementKey(selectedAudioBinding.track.id, selectedAudioBinding.element.id),
      volume: typeof params.volume === 'number' ? params.volume : 1,
      fadeInSeconds: typeof params.fadeInSeconds === 'number' ? params.fadeInSeconds : 0,
      fadeOutSeconds: typeof params.fadeOutSeconds === 'number' ? params.fadeOutSeconds : 0,
    })
  }, [selectedAudioBinding?.element.id, selectedAudioBinding?.track.id, tracks])

  useEffect(() => {
    if (!selectedSourceAudioBinding) {
      setSourceAudioDraft(null)
      return
    }
    const params = selectedSourceAudioBinding.element.params ?? {}
    setSourceAudioDraft({
      key: elementKey(selectedSourceAudioBinding.track.id, selectedSourceAudioBinding.element.id),
      enabled: selectedSourceAudioBinding.element.isSourceAudioEnabled === true,
      volume: typeof params.volume === 'number' ? params.volume : 1,
    })
  }, [selectedSourceAudioBinding?.element.id, selectedSourceAudioBinding?.track.id, tracks])

  useEffect(() => {
    if (!selectedVisualBinding) {
      setVisualFitDraft(null)
      setVisualFitBlocked('')
      return
    }
    const state = readVisualFitDraft(selectedVisualBinding.element)
    if (!state.editable) {
      setVisualFitDraft(null)
      setVisualFitBlocked(state.reason)
      return
    }
    setVisualFitBlocked('')
    setVisualFitDraft({
      key: elementKey(selectedVisualBinding.track.id, selectedVisualBinding.element.id),
      expectedFit: state.draft.fit,
      ...state.draft,
    })
  }, [selectedVisualBinding?.element.id, selectedVisualBinding?.track.id, tracks])

  useEffect(() => {
    if (!selectedVisualBinding) {
      setVisualFadeDraft(null)
      setVisualFadeBlocked('')
      return
    }
    const state = readVisualOpacityFadeDraft(selectedVisualBinding.element)
    if (!state.editable) {
      setVisualFadeDraft(null)
      setVisualFadeBlocked(state.reason)
      return
    }
    setVisualFadeBlocked('')
    setVisualFadeDraft({
      key: elementKey(selectedVisualBinding.track.id, selectedVisualBinding.element.id),
      ...state.draft,
    })
  }, [selectedVisualBinding?.element.id, selectedVisualBinding?.track.id, tracks])

  useEffect(() => {
    if (!selectedVisualBinding) {
      setVisualScaleDraft(null)
      setVisualScaleBlocked('')
      return
    }
    const state = readVisualUniformScaleMotionDraft(selectedVisualBinding.element)
    if (!state.editable) {
      setVisualScaleDraft(null)
      setVisualScaleBlocked(state.reason)
      return
    }
    setVisualScaleBlocked('')
    setVisualScaleDraft({
      key: elementKey(selectedVisualBinding.track.id, selectedVisualBinding.element.id),
      ...state.draft,
    })
  }, [selectedVisualBinding?.element.id, selectedVisualBinding?.track.id, tracks])

  useEffect(() => {
    if (!selectedVisualBinding) {
      setVisualMaskDraft(null)
      setVisualMaskBlocked('')
      return
    }
    const state = readVisualShapeMaskDraft(selectedVisualBinding.element)
    if (!state.editable) {
      setVisualMaskDraft(null)
      setVisualMaskBlocked(state.reason)
      return
    }
    setVisualMaskBlocked('')
    setVisualMaskDraft({
      key: elementKey(selectedVisualBinding.track.id, selectedVisualBinding.element.id),
      ...state.draft,
    })
  }, [selectedVisualBinding?.element.id, selectedVisualBinding?.track.id, tracks])
  const quarantinedTimeline = timelineCanonicalQuarantine?.storage === storage
    ? timelineCanonicalQuarantine
    : null
  const timelineHeadIncompatible = quarantinedTimeline !== null

  // A fallback projection is useful only during an ordinary load. Once an
  // authoritative head fails the pinned codec, the fallback is hidden rather
  // than presented as a plausible editor: otherwise an unknown or future
  // OpenCut element could be mistaken for editable data and later erased.
  const timelineIsAuthoritative = storage === null || (
    !timelineHeadIncompatible
    &&
    hydratedTimeline?.storage === storage
    && storageState.phase === 'ready'
  )
  const canMutateTimeline = timelineIsAuthoritative
    && automaticEditBusy === null
    && automaticEditPreview === null
  const rejectUnhydratedMutation = () => {
    setSnapLabel('时间线尚未安全载入 · 已阻止覆盖服务端修订')
  }

  useEffect(() => {
    if (!storage) {
      setTimelineConflictRescue(null)
      return
    }
    if (storageState.phase === 'conflict') {
      const rescue = storage.getConflictRescue()
      if (rescue) setTimelineConflictRescue(rescue)
    } else if (storageState.phase === 'ready') {
      setTimelineConflictRescue(null)
      setTimelineConflictMessage('')
    }
  }, [storage, storageState.phase, storageState.currentRevisionId])

  useEffect(() => {
    clearAgenticMotionPreview()
  }, [commandEditor])

  useEffect(() => {
    const preview = agenticMotionPreviewRef.current
    if (!preview) return
    const liveStorage = storage?.getState() ?? null
    if (preview.storage !== storage
      || (storage !== null && (
        liveStorage?.phase !== 'ready'
        || liveStorage.dirty
        || liveStorage.currentRevisionId !== preview.baseRevisionId
        || liveStorage.etag !== preview.baseEtag
      ))) {
      clearAgenticMotionPreview()
      setSnapLabel('智能运镜预览已失效 · OpenCut 修订已变化，请重新分析')
    }
  }, [
    storage,
    storageState.phase,
    storageState.dirty,
    storageState.currentRevisionId,
    storageState.etag,
  ])

  const selectElement = (ref: EditorElementRef) => {
    const selected = commandEditor.setSelectedElements([ref]).selectedElements
    setSelectedElements(selected)
    const track = orderedTracks.find((candidate) => candidate.id === ref.trackId)
    const element = track?.elements.find((candidate) => candidate.id === ref.elementId)
    const shot = element ? shotForElement(shots, element) : null
    if (element) commandEditor.playback.seek(element.startTime)
    if (shot && shot.id !== activeShot) {
      timelineDrivenShotSelectionRef.current = shot.id
      onSelect(shot.id)
    }
  }
  const manualTimelineDocument = (nextTracks: EditorSceneTracks) => (
    withoutActiveTimelineAutoEditReceipt(
      openCutTimelineDocument(nextTracks, timelineDocumentBaseRef.current),
    )
  )
  const adoptManualTimelineSave = (
    snapshot: TimelineDocumentSnapshot,
    ownerStorage: ManjuStorageAdapter | null = storage,
  ): boolean => {
    if (storageRef.current !== ownerStorage) return false
    timelineDocumentBaseRef.current = structuredClone(snapshot.document)
    setAuthoritativeTimeline(snapshot)
    setTimelineCanonicalQuarantine(null)
    setTimelineQuarantineMessage('')
    setHydratedTimeline((current) => current?.storage === storage
      ? { ...current, automaticEdit: null }
      : current)
    return true
  }
  const inspectAuthoritativeSnapshot = (
    snapshot: TimelineDocumentSnapshot,
    allowStaleSourceRevision = false,
  ) => inspectOpenCutSnapshotCompatibility(snapshot, {
    projectId: persistence?.projectId ?? snapshot.timelineDocument.projectId,
    episodeId: persistence?.episodeId ?? snapshot.timelineDocument.episodeId,
    schemaVersion: CANONICAL_TIMELINE_SCHEMA_VERSION,
    upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
    sourceRevisionId: persistence
      ? persistence.sourceRevisionId
      : snapshot.timelineDocument.sourceRevisionId,
  }, { allowStaleSourceRevision })
  const quarantineAuthoritativeSnapshot = (
    snapshot: TimelineDocumentSnapshot,
    reasons: readonly string[],
    message = '当前服务端 head 未通过 pinned OpenCut 兼容性校验',
  ) => {
    if (!storage) return
    clearAgenticMotionPreview()
    commandEditor.playback.pause()
    timelineDocumentBaseRef.current = {}
    viewStateRef.current = null
    setAuthoritativeTimeline(snapshot)
    setHydratedTimeline(null)
    setSelectedElements([])
    setResizePreview(new Map())
    setAutomaticEditPreview(null)
    setAutomaticEditPreviewOverlay(null)
    setAutomaticEditError('')
    setTimelineCanonicalQuarantine({
      storage,
      snapshot,
      detectedAt: new Date().toISOString(),
      reasons: [...reasons],
    })
    setTimelineQuarantineMessage('')
    setSnapLabel(message)
  }
  const replaceEditorWithAuthoritativeSnapshot = (
    snapshot: TimelineDocumentSnapshot,
    message: string,
  ): TimelineDocumentSnapshot => {
    if (!storage) throw new Error('当前分集没有可持久化的 OpenCut 时间线')
    const compatibility = inspectAuthoritativeSnapshot(snapshot)
    if (!compatibility.compatible) {
      quarantineAuthoritativeSnapshot(snapshot, compatibility.reasons)
      throw new Error(`服务端修订未通过 pinned OpenCut 兼容性校验：${compatibility.reasons.join('；')}`)
    }
    const loadedTracks = parseOpenCutTracks(snapshot.document)
    if (!loadedTracks) {
      throw new Error('服务端修订不符合 pinned OpenCut canonical schema')
    }
    clearAgenticMotionPreview()
    const adopted = storage.adoptServerMutation(snapshot)
    timelineDocumentBaseRef.current = structuredClone(adopted.document)
    viewStateRef.current = readViewState(adopted.document)
    setAuthoritativeTimeline(adopted)
    setTimelineCanonicalQuarantine(null)
    setTimelineQuarantineMessage('')
    setSelectedElements([])
    setResizePreview(new Map())
    setAutomaticEditPreview(null)
    setAutomaticEditPreviewOverlay(null)
    setAutomaticEditError('')
    setHydratedTimeline({
      storage,
      tracks: loadedTracks,
      automaticEdit: readCurrentTimelineAutomaticEdit(
        adopted.document,
        adopted.revision.parentRevisionId,
      ),
    })
    setSnapLabel(message)
    return adopted
  }
  const refreshCommandState = (message: string, summary?: string) => {
    clearAgenticMotionPreview()
    const nextTracks = commandEditor.getTracks()
    setTracks(nextTracks)
    setResizePreview(new Map())
    setSnapLabel(message)
    setSelectedElements(commandEditor.getSelection().selectedElements)
    if (!storage || !summary) return
    if (!canMutateTimeline) {
      rejectUnhydratedMutation()
      return
    }
    const document = manualTimelineDocument(nextTracks)
    const ownerStorage = storage
    void ownerStorage.save(document, { summary }).then((snapshot) => {
      adoptManualTimelineSave(snapshot, ownerStorage)
    }).catch((error: unknown) => {
      if (error instanceof TimelineStorageIncompatibleSnapshotError
        && storageRef.current === ownerStorage) {
        const compatibility = inspectAuthoritativeSnapshot(error.snapshot)
        quarantineAuthoritativeSnapshot(
          error.snapshot,
          compatibility.reasons.length > 0
            ? compatibility.reasons
            : ['服务端返回的 authoritative head 未通过安全采用校验'],
        )
        return
      }
      if (error instanceof TimelineStorageConflictError) {
        setTimelineConflictRescue(ownerStorage.getConflictRescue() ?? {
          document: structuredClone(error.localDocument),
          currentRevisionId: error.currentRevisionId,
          expectedEtag: error.expectedEtag,
          capturedAt: new Date().toISOString(),
        })
      }
      setSnapLabel(error instanceof TimelineStorageConflictError
        ? '保存冲突 · 本地命令未覆盖远端'
        : '时间线保存失败 · 本地命令仍保留')
    })
  }

  const elementInteractionConfig: OpenCutElementInteractionConfig = {
    getZoomLevel: () => timelineInteractions.zoomLevel,
    getTracksScrollEl: () => tracksScrollRef.current,
    getTracksContainerEl: () => tracksContainerRef.current,
    // Our scroll viewport begins below the ruler, so there is no header inside
    // the coordinate space that OpenCut should subtract.
    getHeaderEl: () => null,
    getTracks: () => commandEditor.getTracks(),
    getActiveProjectFps: () => ({ numerator: 24, denominator: 1 }),
    isShiftHeld: () => shiftHeldRef.current,
    getSelectedElements: () => selectedElements,
    isElementSelected: (ref) => selectedElements.some((candidate) => (
      candidate.trackId === ref.trackId && candidate.elementId === ref.elementId
    )),
    selectElement,
    handleElementClick: ({ trackId, elementId, isMultiKey }) => {
      const ref = { trackId, elementId }
      if (!isMultiKey) {
        selectElement(ref)
        return
      }
      setSelectedElements((current) => current.some((candidate) => (
        candidate.trackId === trackId && candidate.elementId === elementId
      ))
        ? commandEditor.setSelectedElements(current.filter((candidate) => (
            candidate.trackId !== trackId || candidate.elementId !== elementId
          ))).selectedElements
        : commandEditor.setSelectedElements([...current, ref]).selectedElements)
    },
    clearKeyframeSelection: () => undefined,
    getCurrentPlayheadTime: () => commandEditor.playback.getSnapshot().currentTime,
    isSnappingEnabled: () => true,
    onSnapPointChange: (point) => {
      if (point) setSnapLabel(`OpenCut 吸附 · ${point.type}`)
    },
    commitElementMoves: (commit) => {
      if (!canMutateTimeline) {
        setResizePreview(new Map())
        rejectUnhydratedMutation()
        return
      }
      commandEditor.commitElementMoves(commit)
      commandEditor.setSelectedElements(commandEditor.getSelection().selectedElements.map((ref) => {
        const move = commit.moves.find((candidate) => candidate.elementId === ref.elementId)
        return move ? { trackId: move.targetTrackId, elementId: ref.elementId } : ref
      }))
      refreshCommandState('OpenCut controller 拖移完成', '拖移时间线片段')
    },
    discardResizePreview: () => setResizePreview(new Map()),
    previewResizeElements: (updates) => setResizePreview(new Map(
      updates.map((update) => [elementKey(update.trackId, update.elementId), update.patch]),
    )),
    commitResizeElements: (updates) => {
      if (!canMutateTimeline) {
        setResizePreview(new Map())
        rejectUnhydratedMutation()
        return
      }
      commandEditor.commitElementUpdates({ updates })
      refreshCommandState('OpenCut controller 裁切完成', '裁切时间线片段')
    },
  }
  const elementInteractionConfigRef = useRef(elementInteractionConfig)
  elementInteractionConfigRef.current = elementInteractionConfig
  const elementInteractions = useMemo(() => createOpenCutElementInteractions({
    getConfig: () => elementInteractionConfigRef.current,
  }), [commandEditor])
  const elementInteraction = useSyncExternalStore(
    elementInteractions.subscribe,
    elementInteractions.getSnapshot,
    elementInteractions.getSnapshot,
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Shift') shiftHeldRef.current = true }
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === 'Shift') shiftHeldRef.current = false }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useEffect(() => {
    const node = tracksScrollRef.current
    if (!node || !open) return
    const update = () => setViewportWidth(node.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [open])

  useLayoutEffect(() => {
    timelineInteractions.reconcileInitialAndMinZoom({
      minZoom: layout.minZoom,
      initialZoom: viewStateRef.current?.zoomLevel,
    })
    timelineInteractions.applyZoomLayout()
  }, [layout.minZoom, timelineInteractions, zoomLevel])

  useEffect(() => {
    const unbind = timelineInteractions.bindPreventBrowserZoom()
    return () => {
      unbind()
      timelineInteractions.destroy()
    }
  }, [timelineInteractions])

  useEffect(() => {
    if (!open) return
    const view = viewStateRef.current
    const cleanup = timelineInteractions.restoreInitialScrollIfNeeded(view?.scrollLeft)
    timelineInteractions.restoreInitialPlayheadIfNeeded(view?.playheadTime)
    return cleanup
  }, [open, timelineInteractions])

  useEffect(() => () => elementInteractions.destroy(), [elementInteractions])

  useEffect(() => {
    if (!storage || !persistence || !persistenceHandleRef
      || storageState.phase !== 'ready'
      || hydratedTimeline?.storage !== storage) return
    const handle: TimelinePersistenceHandle = {
      projectId: persistence.projectId,
      episodeId: persistence.episodeId,
      flush: async (signal) => {
        const document = openCutTimelineDocument(
          commandEditor.getTracks(),
          timelineDocumentBaseRef.current,
        )
        const snapshot = await storage.flush(document, {
          summary: '固化预览与导出共享时间线修订',
          signal,
        })
        timelineDocumentBaseRef.current = structuredClone(snapshot.document)
        return snapshot
      },
      reconcileCurrentMedia: async (signal) => {
        signal?.throwIfAborted()
        const snapshot = await storage.reconcile(signal)
        return replaceEditorWithAuthoritativeSnapshot(
          snapshot,
          snapshot.report.changed
            ? 'OpenCut 已对账当前镜头选版'
            : 'OpenCut 已确认当前镜头选版',
        )
      },
      addUploadedAudio: async (input, signal) => {
        signal?.throwIfAborted()
        const assetId = input.assetId.trim()
        const displayName = input.displayName.trim()
        if (!assetId || !displayName || displayName.length > 200
          || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
          throw new Error('上传音频的时间线参数无效')
        }
        const currentTracks = commandEditor.getTracks()
        const existing = currentTracks.audio.flatMap((track) => (
          track.elements.map((element) => ({ track, element }))
        )).find(({ element }) => (
          element.type === 'audio'
          && element.mediaId === assetId
          && element.params?.audioRole === input.kind
        ))
        if (existing) {
          const selection = commandEditor.setSelectedElements([{
            trackId: existing.track.id,
            elementId: existing.element.id,
          }]).selectedElements
          setSelectedElements(selection)
          setSnapLabel(`${input.kind === 'bgm' ? '配乐' : '音效'}已在 OpenCut 时间线中`)
          return storage.flush(undefined, { signal })
        }

        const frameTicks = OPEN_CUT_TICKS_PER_SECOND / 24
        const sourceDuration = Math.max(
          frameTicks,
          Math.ceil(input.durationSeconds * 24) * frameTicks,
        )
        const timelineDuration = commandEditor.playback.getSnapshot().duration
        if (timelineDuration < frameTicks) throw new Error('时间线没有可放置音频的有效时长')
        const requestedStart = input.kind === 'bgm'
          ? 0
          : Math.min(
              commandEditor.playback.getSnapshot().currentTime,
              timelineDuration - frameTicks,
            )
        const duration = Math.min(sourceDuration, timelineDuration - requestedStart)
        const inserted = commandEditor.addElement({
          element: {
            type: 'audio',
            sourceType: 'upload',
            mediaId: assetId,
            name: displayName,
            startTime: requestedStart,
            duration,
            trimStart: 0,
            trimEnd: Math.max(0, sourceDuration - duration),
            sourceDuration,
            params: {
              audioRole: input.kind,
              volume: input.kind === 'bgm' ? 0.65 : 1,
            },
          },
          placement: { mode: 'auto', trackType: 'audio' },
        })
        if (!inserted) throw new Error('OpenCut 无法为该音频找到安全轨道')
        const nextTracks = commandEditor.getTracks()
        setTracks(nextTracks)
        setSelectedElements(commandEditor.getSelection().selectedElements)
        setSnapLabel(`${input.kind === 'bgm' ? '配乐' : '音效'}已加入 OpenCut 时间线`)
        const snapshot = await storage.flush(
          manualTimelineDocument(nextTracks),
          { summary: `添加${input.kind === 'bgm' ? '背景配乐' : '音效'} ${displayName}`, signal },
        )
        adoptManualTimelineSave(snapshot)
        return snapshot
      },
      addSubtitle: async (input, signal) => {
        signal?.throwIfAborted()
        const attachmentId = input.attachmentId.trim()
        const text = input.text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
        if (!attachmentId || !text || text.length > 10_000) {
          throw new Error('字幕文本或提交标识无效')
        }
        const currentTracks = commandEditor.getTracks()
        const existing = currentTracks.overlay.flatMap((track) => (
          track.elements.map((element) => ({ track, element }))
        )).find(({ element }) => (
          element.type === 'text' && element.params?.attachmentId === attachmentId
        ))
        if (existing) {
          setSelectedElements(commandEditor.setSelectedElements([{
            trackId: existing.track.id,
            elementId: existing.element.id,
          }]).selectedElements)
          setSnapLabel('字幕已在 OpenCut 时间线中')
          return storage.flush(undefined, { signal })
        }

        const frameTicks = OPEN_CUT_TICKS_PER_SECOND / 24
        const timelineDuration = commandEditor.playback.getSnapshot().duration
        if (timelineDuration < frameTicks) throw new Error('时间线没有可放置字幕的有效时长')
        const requestedDuration = Math.max(
          frameTicks,
          Math.round((input.durationSeconds ?? 2) * 24) * frameTicks,
        )
        const startTime = Math.min(
          commandEditor.playback.getSnapshot().currentTime,
          timelineDuration - frameTicks,
        )
        const inserted = commandEditor.addElement({
          element: {
            type: 'text',
            name: text,
            startTime,
            duration: Math.min(requestedDuration, timelineDuration - startTime),
            trimStart: 0,
            trimEnd: 0,
            params: {
              content: text,
              text,
              attachmentId,
              manjuRole: 'subtitle',
            },
          },
          placement: { mode: 'auto', trackType: 'text' },
        })
        if (!inserted) throw new Error('OpenCut 无法为该字幕找到安全轨道')
        const nextTracks = commandEditor.getTracks()
        setTracks(nextTracks)
        setSelectedElements(commandEditor.getSelection().selectedElements)
        setSnapLabel('字幕已加入 OpenCut 时间线')
        const snapshot = await storage.flush(
          manualTimelineDocument(nextTracks),
          { summary: '添加时间线字幕', signal },
        )
        adoptManualTimelineSave(snapshot)
        return snapshot
      },
      readManagedSubtitleCueSet: (input) => commandEditor.readManagedSubtitleCueSet(
        input.dialogueLineId,
        input.speechAssetId,
      ),
      replaceManagedSubtitleCueSet: async (input, signal) => {
        signal?.throwIfAborted()
        const projected = projectManagedSubtitleCueSetToOpenCut(
          commandEditor.getTracks(),
          input,
        )
        const cueSet = commandEditor.replaceManagedSubtitleCueSet(projected)
        const nextTracks = commandEditor.getTracks()
        setTracks(nextTracks)
        setSelectedElements(commandEditor.getSelection().selectedElements)
        const snapshot = await storage.flush(
          manualTimelineDocument(nextTracks),
          {
            summary: `更新对白 ${input.dialogueLineId} 的托管字幕`,
            signal,
          },
        )
        adoptManualTimelineSave(snapshot)
        setSnapLabel(`词级字幕已保存到 OpenCut 时间线 · ${cueSet.cues.length} 条`)
        return cueSet
      },
    }
    persistenceHandleRef.current = handle
    onPersistenceReadyChange?.(true)
    return () => {
      if (persistenceHandleRef.current === handle) {
        persistenceHandleRef.current = null
        onPersistenceReadyChange?.(false)
      }
    }
  }, [commandEditor, hydratedTimeline, onPersistenceReadyChange, persistence, persistenceHandleRef, storage, storageState.phase])

  useEffect(() => {
    setHydratedTimeline(null)
    setAuthoritativeTimeline(null)
    setTimelineHistory(null)
    setSelectedHistoryRevisionId(null)
    setHistoryOpen(false)
    setTimelineHistoryError('')
    setTimelineConflictRescue(null)
    setTimelineConflictMessage('')
    setTimelineCanonicalQuarantine(null)
    setTimelineQuarantineBusy(null)
    setTimelineQuarantineMessage('')
    setAutomaticEditPreview(null)
    setAutomaticEditPreviewOverlay(null)
    setAutomaticEditBusy(null)
    setAutomaticEditError('')
    automaticEditAttemptsRef.current.clear()
    timelineDocumentBaseRef.current = {}
    viewStateRef.current = null
    if (!storage) {
      setStorageState({
        phase: 'idle', dirty: false, etag: null, currentRevisionId: null, lastSavedAt: null,
      })
      return
    }
    let disposed = false
    const controller = new AbortController()
    const unsubscribe = storage.subscribe((state) => { if (!disposed) setStorageState(state) })
    void storage.load(controller.signal).then(async (loaded) => {
      if (disposed) return
      let snapshot = loaded
      if (!snapshot) {
        if (!persistence?.sourceRevisionId) {
          setSnapLabel('等待真实剧本后创建 OpenCut 时间线')
          return
        }
        const materialized = await storage.materialize(controller.signal)
        snapshot = materialized
        setSnapLabel(`OpenCut 时间线已创建 · ${materialized.report.appendedShots.length} 镜`)
      } else {
        // A timeline may legitimately trail the current Story immediately
        // before reconcile, but every other piece of authoritative metadata
        // and both canonical document copies must already be compatible. The
        // exact loaded head is quarantined before any server-side mutation.
        const loadedCompatibility = inspectAuthoritativeSnapshot(snapshot, true)
        if (!loadedCompatibility.compatible) {
          quarantineAuthoritativeSnapshot(snapshot, loadedCompatibility.reasons)
          return
        }
        if (persistence?.sourceRevisionId) {
          const reconciled = await storage.reconcile(controller.signal)
          snapshot = reconciled
          setSnapLabel(reconciled.report.changed ? 'OpenCut 已对账最新剧本/媒体' : 'OpenCut 服务端修订已载入')
        }
      }
      if (disposed) return
      const compatibility = inspectAuthoritativeSnapshot(snapshot)
      if (!compatibility.compatible) {
        quarantineAuthoritativeSnapshot(snapshot, compatibility.reasons)
        return
      }
      const loadedTracks = parseOpenCutTracks(snapshot.document)
      if (!loadedTracks) {
        quarantineAuthoritativeSnapshot(snapshot, [
          '快照未通过 pinned OpenCut canonical 校验',
        ])
        return
      }
      timelineDocumentBaseRef.current = structuredClone(snapshot.document)
      viewStateRef.current = readViewState(snapshot.document)
      setAuthoritativeTimeline(snapshot)
      setTimelineCanonicalQuarantine(null)
      setTimelineQuarantineMessage('')
      setHydratedTimeline({
        storage,
        tracks: loadedTracks,
        automaticEdit: readCurrentTimelineAutomaticEdit(
          snapshot.document,
          snapshot.revision.parentRevisionId,
        ),
      })
    }).catch((error: unknown) => {
      if (!disposed && error instanceof TimelineStorageIncompatibleSnapshotError) {
        const compatibility = inspectAuthoritativeSnapshot(error.snapshot)
        quarantineAuthoritativeSnapshot(
          error.snapshot,
          compatibility.reasons.length > 0
            ? compatibility.reasons
            : ['服务端返回的 authoritative head 未通过安全采用校验'],
        )
        return
      }
      if (!disposed && !(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
        setSnapLabel(error instanceof Error ? error.message : '时间线加载失败 · 本地命令未上传')
      }
    })
    return () => {
      disposed = true
      controller.abort()
      unsubscribe()
    }
  }, [storage])

  useEffect(() => {
    const nextTracks = commandEditor.getTracks()
    setTracks(nextTracks)
    const timelineDriven = timelineDrivenShotSelectionRef.current === activeShot
    timelineDrivenShotSelectionRef.current = null
    if (timelineDriven) return
    const match = [...nextTracks.overlay, nextTracks.main]
      .flatMap((track) => track.elements.map((element) => ({ track, element })))
      .find(({ element }) => shotForElement(shots, element)?.id === activeShot)
    if (match) {
      setSelectedElements(commandEditor.setSelectedElements([{
        trackId: match.track.id,
        elementId: match.element.id,
      }]).selectedElements)
      commandEditor.playback.seek(match.element.startTime)
    } else {
      commandEditor.setSelectedElements([])
      setSelectedElements([])
    }
    // Image/status updates replace the shots array frequently. Only identity
    // changes should re-run this external-selection bridge and move playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShot, commandEditor, shotSelectionSeed])

  useEffect(() => {
    const playback = commandEditor.playback
    const sync = (time: number) => {
      setPlayheadTicks(time)
      const active = [...commandEditor.getTracks().overlay, commandEditor.getTracks().main]
        .flatMap((track) => track.elements)
        .find((element) => time >= element.startTime && time < element.startTime + element.duration)
      const shot = active ? shotForElement(shots, active) : null
      if (shot && shot.id !== activeShot) {
        timelineDrivenShotSelectionRef.current = shot.id
        onSelect(shot.id)
      }
    }
    const unsubscribeState = playback.subscribe((snapshot) => {
      setPlaybackState(snapshot)
      sync(snapshot.currentTime)
    })
    const unsubscribeUpdate = playback.onUpdate(sync)
    const unsubscribeSeek = playback.onSeek(sync)
    return () => {
      unsubscribeState()
      unsubscribeUpdate()
      unsubscribeSeek()
      playback.pause()
    }
  }, [activeShot, commandEditor, onSelect, shots])

  const toggleProgramPlayback = () => {
    void programMonitorRef.current?.toggleProgramPlayback().then((started) => {
      if (!started) setSnapLabel('节目监看器尚未就绪 · 已阻止无画面/无声音播放')
    })
  }

  const togglePlayheadOnly = () => {
    if (playbackState.isPlaying && programPlaybackEnabled) {
      setProgramPlaybackEnabled(false)
      setSnapLabel('已切换为仅运行播放头 · 节目画面与声音暂停')
      return
    }
    if (!playbackState.isPlaying) setProgramPlaybackEnabled(false)
    commandEditor.playback.toggle()
  }

  const layoutValid = orderedTracks.every((track) => track.elements.every((element) => engine.canPlace({
    track: { elements: track.elements },
    timeSpans: [{
      startTime: element.startTime,
      duration: element.duration,
      excludeElementId: element.id,
    }],
  })))
  const tracksHeight = orderedTracks.reduce<number>((total, track, index) => (
    total + getOpenCutTrackHeight({ trackType: track.type })
      + (index ? OPEN_CUT_TIMELINE_LAYOUT_METRICS.trackGapPx : 0)
  ), OPEN_CUT_TIMELINE_LAYOUT_METRICS.contentTopPaddingPx)
  const bodyHeight = Math.min(268, Math.max(146,
    tracksHeight + OPEN_CUT_TIMELINE_LAYOUT_METRICS.rulerHeightPx
      + OPEN_CUT_TIMELINE_LAYOUT_METRICS.scrollbarSizePx,
  ))
  const storageLabel: Record<TimelineStorageState['phase'], string> = {
    idle: '等待真实分集', loading: '读取时间线',
    ready: storageState.dirty ? '等待保存' : 'SQLite 修订已保存',
    saving: '保存修订中', missing: '首次编辑时创建', conflict: '修订冲突', error: '保存异常',
  }
  const displayedKernelLabel = resolveTimelineKernelLabel(
    snapLabel,
    storageState.phase,
    storage !== null,
  )
  const selectedHistoryRevision = timelineHistory?.revisions.find(
    (revision) => revision.id === selectedHistoryRevisionId,
  ) ?? null
  const selectedHistoryStats = selectedHistoryRevision
    ? timelineRevisionStats(selectedHistoryRevision)
    : null
  const timelineHistoryCompatibility = useMemo(() => new Map(
    timelineHistory && authoritativeTimeline
      ? timelineHistory.revisions.map((revision) => [
          revision.id,
          inspectOpenCutRevisionCompatibility(revision, authoritativeTimeline, {
            projectId: persistence?.projectId ?? authoritativeTimeline.timelineDocument.projectId,
            episodeId: persistence?.episodeId ?? authoritativeTimeline.timelineDocument.episodeId,
            schemaVersion: CANONICAL_TIMELINE_SCHEMA_VERSION,
            upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
            sourceRevisionId: persistence
              ? persistence.sourceRevisionId
              : authoritativeTimeline.timelineDocument.sourceRevisionId,
          }),
        ] as const)
      : [],
  ), [authoritativeTimeline, persistence, timelineHistory])
  const selectedHistoryCompatibility = selectedHistoryRevision
    ? timelineHistoryCompatibility.get(selectedHistoryRevision.id) ?? null
    : null
  const selectedHistoryCompatible = selectedHistoryCompatibility?.compatible === true

  const loadTimelineHistory = async (): Promise<void> => {
    if (!storage || !persistence || !authoritativeTimeline) return
    setTimelineHistoryBusy('load')
    setTimelineHistoryError('')
    try {
      const history = await api.listTimelineDocumentRevisions(
        authoritativeTimeline.timelineDocument.id,
        { limit: 100 },
      )
      if (history.timelineDocument.projectId !== persistence.projectId
        || history.timelineDocument.episodeId !== persistence.episodeId
        || history.timelineDocument.id !== authoritativeTimeline.timelineDocument.id
        || history.timelineDocument.schemaVersion !== authoritativeTimeline.timelineDocument.schemaVersion
        || history.timelineDocument.upstreamCommit !== authoritativeTimeline.timelineDocument.upstreamCommit
        || history.timelineDocument.sourceRevisionId !== authoritativeTimeline.timelineDocument.sourceRevisionId
        || history.etag !== storage.getState().etag) {
        throw new Error('修订历史返回前时间线 head 已变化，请重新打开')
      }
      setTimelineHistory(history)
      setSelectedHistoryRevisionId((current) => (
        current && history.revisions.some((revision) => revision.id === current)
          ? current
          : history.timelineDocument.currentRevisionId
      ))
    } catch (error) {
      setTimelineHistoryError(error instanceof Error ? error.message : '时间线修订历史读取失败')
    } finally {
      setTimelineHistoryBusy(null)
    }
  }

  const toggleTimelineHistory = () => {
    const next = !historyOpen
    setHistoryOpen(next)
    if (next) void loadTimelineHistory()
  }

  const restoreSelectedHistoryRevision = async () => {
    if (!storage || !persistence || !authoritativeTimeline || !selectedHistoryRevision
      || !selectedHistoryCompatible || !storageState.etag || storageState.dirty
      || timelineHistoryBusy !== null
      || selectedHistoryRevision.id === authoritativeTimeline.revision.id) return
    const signature = [
      authoritativeTimeline.timelineDocument.id,
      selectedHistoryRevision.id,
      storageState.etag,
    ].join(':')
    const idempotencyKey = historyRestoreAttemptsRef.current.get(signature)
      ?? createTimelineRestoreIdempotencyKey()
    historyRestoreAttemptsRef.current.set(signature, idempotencyKey)
    setTimelineHistoryBusy('restore')
    setTimelineHistoryError('')
    try {
      const result = await api.restoreTimelineDocumentRevision(
        persistence.episodeId,
        selectedHistoryRevision.id,
        {
          projectId: persistence.projectId,
          documentId: authoritativeTimeline.timelineDocument.id,
          summary: `人工恢复时间线：${selectedHistoryRevision.summary}`,
        },
        storageState.etag,
        idempotencyKey,
      )
      replaceEditorWithAuthoritativeSnapshot(
        result.timeline,
        result.headAdvanced
          ? `恢复修订已创建，当前 head 又已推进至 ${result.timeline.revision.id.slice(0, 8)}`
          : `历史副本已恢复为新修订 · ${result.restore.resultRevisionId.slice(0, 8)}`,
      )
      historyRestoreAttemptsRef.current.delete(signature)
      const refreshed = await api.listTimelineDocumentRevisions(
        result.timeline.timelineDocument.id,
        { limit: 100 },
      )
      if (refreshed.etag !== result.timeline.etag) {
        throw new Error('恢复后 head 又已更新，请刷新修订历史')
      }
      setTimelineHistory(refreshed)
      setSelectedHistoryRevisionId(result.restore.resultRevisionId)
    } catch (error) {
      if (!(error instanceof ApiError)
        || (error.code !== 'NETWORK_ERROR' && error.code !== 'INVALID_RESPONSE')) {
        historyRestoreAttemptsRef.current.delete(signature)
      }
      setTimelineHistoryError(error instanceof Error ? error.message : '时间线恢复失败')
    } finally {
      setTimelineHistoryBusy(null)
    }
  }

  const copyQuarantinedAuthoritativeJson = async () => {
    if (!quarantinedTimeline || timelineQuarantineBusy) return
    setTimelineQuarantineBusy('copy')
    setTimelineQuarantineMessage('')
    try {
      await navigator.clipboard.writeText(JSON.stringify(
        authoritativeQuarantinePayload(
          quarantinedTimeline.snapshot,
          quarantinedTimeline.detectedAt,
        ),
        null,
        2,
      ))
      setTimelineQuarantineMessage('当前 authoritative raw JSON 已复制；服务端 head 未变更')
    } catch (error) {
      setTimelineQuarantineMessage(error instanceof Error ? error.message : '无法复制 authoritative raw JSON')
    } finally {
      setTimelineQuarantineBusy(null)
    }
  }

  const downloadQuarantinedAuthoritativeJson = () => {
    if (!quarantinedTimeline) return
    const { snapshot, detectedAt } = quarantinedTimeline
    const blob = new Blob([JSON.stringify(
      authoritativeQuarantinePayload(snapshot, detectedAt),
      null,
      2,
    )], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `timeline-authoritative-quarantine-${snapshot.timelineDocument.episodeId}-${snapshot.revision.id.slice(0, 8)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setTimelineQuarantineMessage('当前 authoritative raw JSON 已下载；服务端 head 未变更')
  }

  const copyTimelineConflictRescue = async () => {
    if (!timelineConflictRescue || !persistence || timelineConflictBusy) return
    setTimelineConflictBusy('copy')
    setTimelineConflictMessage('')
    try {
      await navigator.clipboard.writeText(JSON.stringify(
        conflictRescuePayload(persistence, timelineConflictRescue),
        null,
        2,
      ))
      setTimelineConflictMessage('本地救援 JSON 已复制，远端时间线未变更')
    } catch (error) {
      setTimelineConflictMessage(error instanceof Error ? error.message : '无法复制救援 JSON')
    } finally {
      setTimelineConflictBusy(null)
    }
  }

  const downloadTimelineConflictRescue = () => {
    if (!timelineConflictRescue || !persistence) return
    const blob = new Blob([JSON.stringify(
      conflictRescuePayload(persistence, timelineConflictRescue),
      null,
      2,
    )], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `timeline-conflict-${persistence.episodeId}-${timelineConflictRescue.capturedAt.replace(/[^0-9]/g, '').slice(0, 14)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setTimelineConflictMessage('本地救援 JSON 已下载，远端时间线未变更')
  }

  const adoptConflictServerHead = async () => {
    if (!storage || !timelineConflictRescue || timelineConflictBusy) return
    setTimelineConflictBusy('adopt')
    setTimelineConflictMessage('')
    try {
      const snapshot = await storage.adoptAuthoritativeHead()
      replaceEditorWithAuthoritativeSnapshot(
        snapshot,
        `已采用服务端修订 · ${snapshot.revision.id.slice(0, 8)}`,
      )
      setTimelineHistory(null)
      setTimelineConflictRescue(null)
    } catch (error) {
      if (error instanceof TimelineStorageIncompatibleSnapshotError) {
        const compatibility = inspectAuthoritativeSnapshot(error.snapshot)
        quarantineAuthoritativeSnapshot(
          error.snapshot,
          compatibility.reasons.length > 0
            ? compatibility.reasons
            : ['服务端返回的 authoritative head 未通过安全采用校验'],
        )
      }
      setTimelineConflictMessage(error instanceof Error ? error.message : '无法采用服务端修订')
    } finally {
      setTimelineConflictBusy(null)
    }
  }

  const saveConflictLocalAsNewRevision = async () => {
    if (!storage || !timelineConflictRescue || timelineConflictBusy) return
    if (!parseOpenCutTracks(timelineConflictRescue.document)) {
      setTimelineConflictMessage('本地副本未通过 pinned OpenCut canonical 校验；请先下载 JSON，本次禁止覆盖')
      return
    }
    setTimelineConflictBusy('save')
    setTimelineConflictMessage('')
    try {
      const snapshot = await storage.saveConflictAsNewRevision(
        timelineConflictRescue.document,
        { summary: '冲突救援：人工确认本地 OpenCut 副本' },
      )
      replaceEditorWithAuthoritativeSnapshot(
        snapshot,
        `本地副本已另存为新修订 · ${snapshot.revision.id.slice(0, 8)}`,
      )
      setTimelineHistory(null)
      setTimelineConflictRescue(null)
    } catch (error) {
      if (error instanceof TimelineStorageConflictError) {
        setTimelineConflictRescue(storage.getConflictRescue() ?? {
          document: structuredClone(error.localDocument),
          currentRevisionId: error.currentRevisionId,
          expectedEtag: error.expectedEtag,
          capturedAt: new Date().toISOString(),
        })
      }
      setTimelineConflictMessage(error instanceof Error ? error.message : '本地副本另存失败')
    } finally {
      setTimelineConflictBusy(null)
    }
  }

  const splitSelected = () => {
    if (!canMutateTimeline) return rejectUnhydratedMutation()
    const selected = selectedElements[0]
    if (!selected) return setSnapLabel('请先选择一个片段')
    const track = orderedTracks.find((candidate) => candidate.id === selected.trackId)
    const element = track?.elements.find((candidate) => candidate.id === selected.elementId)
    if (!element || playheadTicks <= element.startTime
      || playheadTicks >= element.startTime + element.duration) {
      setSnapLabel('请把播放头放在所选片段内部')
      return
    }
    if (element.type === 'image' || element.type === 'video') {
      try {
        if (splitFallsInsideVisualOpacityTransition(element, playheadTicks - element.startTime)) {
          setSnapLabel('播放头位于透明度淡化内部 · 请移到淡化边界外再分割')
          return
        }
      } catch {
        setSnapLabel('所选片段含未审核动画 · 已阻止破坏性分割')
        return
      }
    }
    const result = commandEditor.splitElements({ elements: [selected], splitTime: playheadTicks })
    setSelectedElements(result.rightSideElements.slice(0, 1))
    refreshCommandState('OpenCut 分割完成', '分割时间线片段')
  }
  const undo = () => {
    if (!canMutateTimeline) return rejectUnhydratedMutation()
    if (!commandEditor.canUndo()) return
    commandEditor.undo()
    refreshCommandState('已撤销 OpenCut 命令', '撤销时间线操作')
  }
  const redo = () => {
    if (!canMutateTimeline) return rejectUnhydratedMutation()
    if (!commandEditor.canRedo()) return
    commandEditor.redo()
    refreshCommandState('已重做 OpenCut 命令', '重做时间线操作')
  }
  const deleteSelected = () => {
    if (!canMutateTimeline) return rejectUnhydratedMutation()
    if (selectedElements.length === 0) return setSnapLabel('请先选择要删除的片段')
    commandEditor.setSelectedElements(selectedElements)
    commandEditor.deleteElements({ elements: selectedElements })
    refreshCommandState('已按 OpenCut 语义删除片段', '删除时间线片段')
  }
  const applyAudioMix = () => {
    if (!canMutateTimeline) return rejectUnhydratedMutation()
    if (!selectedAudioBinding || !audioMixDraft) return
    const clipSeconds = selectedAudioBinding.element.duration / OPEN_CUT_TICKS_PER_SECOND
    if (!Number.isFinite(audioMixDraft.volume)
      || audioMixDraft.volume < 0 || audioMixDraft.volume > 4
      || !Number.isFinite(audioMixDraft.fadeInSeconds)
      || !Number.isFinite(audioMixDraft.fadeOutSeconds)
      || audioMixDraft.fadeInSeconds < 0
      || audioMixDraft.fadeOutSeconds < 0
      || audioMixDraft.fadeInSeconds + audioMixDraft.fadeOutSeconds > clipSeconds) {
      setSnapLabel('音频淡入与淡出总时长不能超过片段时长')
      return
    }
    commandEditor.commitElementPropertyUpdates({
      updates: [{
        trackId: selectedAudioBinding.track.id,
        elementId: selectedAudioBinding.element.id,
        patch: {
          params: {
            ...(selectedAudioBinding.element.params ?? {}),
            volume: audioMixDraft.volume,
            fadeInSeconds: audioMixDraft.fadeInSeconds,
            fadeOutSeconds: audioMixDraft.fadeOutSeconds,
          },
        },
      }],
    })
    refreshCommandState('OpenCut 音频混音参数已更新', '调整音频音量与淡入淡出')
  }
  const applySourceAudioMix = () => {
    if (!canMutateTimeline) return rejectUnhydratedMutation()
    if (!selectedSourceAudioBinding || !sourceAudioDraft) return
    if (!Number.isFinite(sourceAudioDraft.volume)
      || sourceAudioDraft.volume < 0
      || sourceAudioDraft.volume > 4) {
      setSnapLabel('视频环境声音量必须介于 0% 和 400% 之间')
      return
    }
    commandEditor.commitElementPropertyUpdates({
      updates: [{
        trackId: selectedSourceAudioBinding.track.id,
        elementId: selectedSourceAudioBinding.element.id,
        patch: {
          isSourceAudioEnabled: sourceAudioDraft.enabled,
          params: {
            ...(selectedSourceAudioBinding.element.params ?? {}),
            volume: sourceAudioDraft.volume,
          },
        },
      }],
    })
    refreshCommandState(
      sourceAudioDraft.enabled ? 'Seedance 环境音已启用' : 'Seedance 环境音已静音',
      '调整视频源音频',
    )
  }
  const applyVisualFit = () => {
    if (!canMutateTimeline) return rejectUnhydratedMutation()
    if (!selectedVisualBinding || !visualFitDraft) return
    const currentKey = elementKey(selectedVisualBinding.track.id, selectedVisualBinding.element.id)
    if (visualFitDraft.key !== currentKey) {
      setSnapLabel('画面适配选择已变更，请重新选择片段')
      return
    }
    let params: Record<string, number | string | boolean>
    try {
      params = buildVisualFitParamPatch({
        element: selectedVisualBinding.element,
        expectedFit: visualFitDraft.expectedFit,
        fit: visualFitDraft.fit,
      })
    } catch (cause) {
      setSnapLabel(cause instanceof Error ? cause.message : '画面适配参数无效')
      return
    }
    commandEditor.commitElementPropertyUpdates({
      updates: [{
        trackId: selectedVisualBinding.track.id,
        elementId: selectedVisualBinding.element.id,
        patch: { params },
      }],
    })
    refreshCommandState(
      visualFitDraft.fit === 'cover'
        ? 'OpenCut 画面已设为填满裁切'
        : 'OpenCut 画面已设为完整显示',
      '调整画面适配方式',
    )
  }
  const applyVisualFade = () => {
    if (!canMutateTimeline) return rejectUnhydratedMutation()
    if (!selectedVisualBinding || !visualFadeDraft) return
    let animations: Record<string, unknown>
    try {
      animations = buildVisualOpacityFadeAnimation({
        animations: selectedVisualBinding.element.animations,
        durationTicks: selectedVisualBinding.element.duration,
        fadeInFrames: visualFadeDraft.fadeInFrames,
        fadeOutFrames: visualFadeDraft.fadeOutFrames,
      })
    } catch (cause) {
      setSnapLabel(cause instanceof Error ? cause.message : '画面淡化参数无效')
      return
    }
    commandEditor.commitElementPropertyUpdates({
      updates: [{
        trackId: selectedVisualBinding.track.id,
        elementId: selectedVisualBinding.element.id,
        patch: { animations },
      }],
    })
    const enabled = visualFadeDraft.fadeInFrames > 0 || visualFadeDraft.fadeOutFrames > 0
    refreshCommandState(
      enabled ? 'OpenCut 画面淡入淡出已更新' : 'OpenCut 画面淡化已清除',
      enabled ? '调整画面透明度动画' : '清除画面透明度动画',
    )
  }
  const applyVisualScaleMotion = () => {
    if (!canMutateTimeline) return rejectUnhydratedMutation()
    if (!selectedVisualBinding || !visualScaleDraft) return
    let animations: Record<string, unknown>
    try {
      animations = buildVisualUniformScaleMotionAnimation({
        animations: selectedVisualBinding.element.animations,
        durationTicks: selectedVisualBinding.element.duration,
        motion: visualScaleDraft.motion,
        strength: visualScaleDraft.strength,
      })
    } catch (cause) {
      setSnapLabel(cause instanceof Error ? cause.message : '镜头缩放参数无效')
      return
    }
    // One OpenCut UpdateElementsCommand owns both axes. They can therefore
    // never persist or enter history as a non-uniform half-update.
    commandEditor.commitElementPropertyUpdates({
      updates: [{
        trackId: selectedVisualBinding.track.id,
        elementId: selectedVisualBinding.element.id,
        patch: { animations },
      }],
    })
    const enabled = visualScaleDraft.motion !== 'none'
    refreshCommandState(
      enabled ? 'OpenCut 中心镜头运动已更新' : 'OpenCut 镜头运动已清除',
      enabled ? '调整画面均匀缩放' : '清除画面均匀缩放',
    )
  }
  const applyVisualMask = () => {
    if (!canMutateTimeline) return rejectUnhydratedMutation()
    if (!selectedVisualBinding || !visualMaskDraft) return
    let masks: Record<string, unknown>[]
    try {
      masks = buildVisualShapeMasks(visualMaskDraft)
    } catch (cause) {
      setSnapLabel(cause instanceof Error ? cause.message : '形状遮罩参数无效')
      return
    }
    commandEditor.commitElementPropertyUpdates({
      updates: [{
        trackId: selectedVisualBinding.track.id,
        elementId: selectedVisualBinding.element.id,
        patch: { masks },
      }],
    })
    refreshCommandState(
      visualMaskDraft.enabled ? 'OpenCut 形状遮罩已更新' : 'OpenCut 形状遮罩已清除',
      visualMaskDraft.enabled ? '调整画面形状遮罩' : '清除画面形状遮罩',
    )
  }

  const requestAgenticMotionPreview = () => {
    if (!canMutateTimeline) return rejectUnhydratedMutation()
    const plan = planAgenticVisualMotion(commandEditor.getTracks(), shots)
    if (plan.recommendations.length === 0) {
      const firstReason = plan.skipped[0]?.reason
      setSnapLabel(firstReason
        ? `智能运镜无可安全应用镜头 · ${firstReason}`
        : '智能运镜无可安全应用的静态分镜')
      return
    }
    agenticMotionPreviewRef.current = {
      plan,
      commandEditor,
      storage,
      baseRevisionId: storage?.getState().currentRevisionId ?? null,
      baseEtag: storage?.getState().etag ?? null,
    }
    setAgenticMotionPlan(plan)
    setSnapLabel(`智能运镜已生成 ${plan.recommendations.length} 项本地预览 · 尚未修改时间线`)
  }

  const applyAgenticMotionPlan = () => {
    if (agenticMotionApplyRef.current) return
    const preview = agenticMotionPreviewRef.current
    if (!preview || preview.plan !== agenticMotionPlan) return
    if (!timelineIsAuthoritative || automaticEditBusy !== null || automaticEditPreview !== null) {
      return rejectUnhydratedMutation()
    }
    const liveStorage = storage?.getState() ?? null
    if (preview.commandEditor !== commandEditor
      || preview.storage !== storage
      || (storage !== null && (
        liveStorage?.phase !== 'ready'
        || liveStorage.dirty
        || liveStorage.currentRevisionId !== preview.baseRevisionId
        || liveStorage.etag !== preview.baseEtag
      ))) {
      clearAgenticMotionPreview()
      setSnapLabel('智能运镜预览已过期 · SQLite 修订发生变化，请重新分析')
      return
    }
    const updates = updatesForAgenticVisualMotion(commandEditor.getTracks(), preview.plan)
    if (!updates || updates.length !== preview.plan.recommendations.length) {
      clearAgenticMotionPreview()
      setSnapLabel('智能运镜预览已过期 · 时间线发生变化，请重新分析')
      return
    }
    agenticMotionApplyRef.current = true
    // Invalidate the clickable preview before the one atomic command. This
    // makes a queued double click inert even before React commits state.
    clearAgenticMotionPreview()
    try {
      commandEditor.commitElementPropertyUpdates({ updates })
      const count = updates.length
      refreshCommandState(
        `OpenCut 已原子应用 ${count} 项智能镜头运动`,
        `Agentic 应用 ${count} 项中心镜头运动`,
      )
    } finally {
      agenticMotionApplyRef.current = false
    }
  }

  const dragView = elementInteraction.dragView
  const adoptAutomaticEditSnapshot = (
    snapshot: TimelineDocumentSnapshot,
    message: string,
  ) => {
    clearAgenticMotionPreview()
    try {
      replaceEditorWithAuthoritativeSnapshot(snapshot, message)
    } catch (error) {
      throw new TimelineAutoEditPreviewValidationError(
        error instanceof Error ? error.message : '服务端修订无法安全载入',
      )
    }
  }

  const requestAutomaticEditPreview = async () => {
    if (!storage || !persistence || !timelineIsAuthoritative
      || !storageState.etag || storageState.dirty || automaticEditBusy) {
      setAutomaticEditError('请等当前 OpenCut 修订完成 SQLite 服务端固化后再诊断')
      return
    }
    const baseEtag = storageState.etag
    setAutomaticEditBusy('preview')
    setAutomaticEditError('')
    setAutomaticEditPreview(null)
    setAutomaticEditPreviewOverlay(null)
    try {
      const preview = await api.previewTimelineAutomaticEdit(
        persistence.episodeId,
        { goal: 'exportable', policy: 'safe' },
        baseEtag,
      )
      if (storage.getState().etag !== baseEtag) {
        throw new TimelineAutoEditPreviewValidationError(
          '预览返回前时间线已产生新修订，请重新诊断',
        )
      }
      const overlay = buildTimelineAutoEditPreviewOverlay(
        commandEditor.getTracks(),
        preview,
      )
      setAutomaticEditPreview(preview)
      setAutomaticEditPreviewOverlay(overlay)
      setSnapLabel(preview.risk === 'blocked'
        ? '诊断发现正式导出阻断项，安全策略未自动修改'
        : preview.operations.length > 0
        ? `Agentic 安全预览已就绪 · ${preview.operations.length} 项 OpenCut 操作`
        : '当前时间线无需自动修复')
    } catch (error) {
      setAutomaticEditError(error instanceof Error ? error.message : '自动剪辑诊断失败')
    } finally {
      setAutomaticEditBusy(null)
    }
  }

  const discardAutomaticEditPreview = () => {
    setAutomaticEditPreview(null)
    setAutomaticEditPreviewOverlay(null)
    setAutomaticEditError('')
    setSnapLabel('已放弃自动剪辑预览 · 时间线未变更')
  }

  const applyAutomaticEditPreview = async () => {
    if (!storage || !persistence || !automaticEditPreview
      || !automaticEditPreviewOverlay || !storageState.etag || automaticEditBusy) return
    if (automaticEditPreview.risk !== 'safe'
      || automaticEditPreview.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      setAutomaticEditError('预览仍含有阻断问题，已禁止应用')
      return
    }
    if (storageState.etag !== automaticEditPreview.timeline.etag) {
      setAutomaticEditPreview(null)
      setAutomaticEditPreviewOverlay(null)
      setAutomaticEditError('时间线修订已变更，旧计划已失效，请重新诊断')
      return
    }
    const attemptKey = `apply:${automaticEditPreview.plan.id}`
    const idempotencyKey = automaticEditAttemptsRef.current.get(attemptKey)
      ?? createTimelineAutoEditIdempotencyKey('apply')
    automaticEditAttemptsRef.current.set(attemptKey, idempotencyKey)
    setAutomaticEditBusy('apply')
    setAutomaticEditError('')
    try {
      const applied = await api.applyTimelineAutomaticEdit(
        persistence.episodeId,
        {
          planId: automaticEditPreview.plan.id,
          confirmationToken: automaticEditPreview.plan.confirmationToken,
        },
        automaticEditPreview.timeline.etag,
        idempotencyKey,
      )
      adoptAutomaticEditSnapshot(
        applied.timeline,
        applied.headAdvanced
          ? `Agentic 剪辑早已完成 · 已同步其他会话的最新修订 ${applied.timeline.revision.id.slice(0, 8)}`
          : `Agentic 剪辑已固化为新修订 · ${applied.timeline.revision.id.slice(0, 8)}`,
      )
      automaticEditAttemptsRef.current.delete(attemptKey)
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        setAutomaticEditPreview(null)
        setAutomaticEditPreviewOverlay(null)
      }
      setAutomaticEditError(error instanceof Error ? error.message : '应用自动剪辑计划失败')
    } finally {
      setAutomaticEditBusy(null)
    }
  }

  const undoAutomaticEditApplication = async () => {
    const applicationId = automaticEdit?.applicationId
    if (!applicationId || !storage || !storageState.etag || automaticEditBusy) return
    const attemptKey = `undo:${applicationId}`
    const idempotencyKey = automaticEditAttemptsRef.current.get(attemptKey)
      ?? createTimelineAutoEditIdempotencyKey('undo')
    automaticEditAttemptsRef.current.set(attemptKey, idempotencyKey)
    setAutomaticEditBusy('undo')
    setAutomaticEditError('')
    try {
      const undone = await api.undoTimelineAutomaticEdit(
        applicationId,
        storageState.etag,
        idempotencyKey,
      )
      adoptAutomaticEditSnapshot(
        undone.timeline,
        undone.headAdvanced
          ? `自动剪辑早已撤销 · 已同步其他会话的最新修订 ${undone.timeline.revision.id.slice(0, 8)}`
          : `自动剪辑已持久撤销 · 新修订 ${undone.timeline.revision.id.slice(0, 8)}`,
      )
      automaticEditAttemptsRef.current.delete(attemptKey)
    } catch (error) {
      setAutomaticEditError(error instanceof Error ? error.message : '撤销自动剪辑失败')
    } finally {
      setAutomaticEditBusy(null)
    }
  }

  const seekAndReveal = (ticks: number) => {
    commandEditor.playback.seek(ticks)
    const tracksViewport = tracksScrollRef.current
    if (!tracksViewport) return
    const target = openCutTimelineTimeToPixels({ time: ticks, zoomLevel })
    const nextScrollLeft = Math.max(
      0,
      Math.min(
        target - tracksViewport.clientWidth * 0.35,
        tracksViewport.scrollWidth - tracksViewport.clientWidth,
      ),
    )
    tracksViewport.scrollLeft = nextScrollLeft
    if (rulerScrollRef.current) rulerScrollRef.current.scrollLeft = nextScrollLeft
    timelineInteractions.saveScrollPosition()
  }

  const focusFirstAutomaticEdit = () => {
    if (!automaticEdit) return
    const match = orderedTracks.flatMap((track) => (
      track.elements.map((element) => ({ track, element }))
    )).find(({ element }) => automaticEdit.changedElementIds.has(element.id))
    if (!match) return
    const selection = commandEditor.setSelectedElements([{
      trackId: match.track.id,
      elementId: match.element.id,
    }]).selectedElements
    setSelectedElements(selection)
    seekAndReveal(match.element.startTime)
    setSnapLabel(`已定位自动剪辑片段 · ${match.element.name || match.element.id}`)
  }
  const focusFirstAutomaticEditPreview = () => {
    if (!automaticEditPreviewOverlay) return
    const match = orderedTracks.flatMap((track) => (
      track.elements.map((element) => ({ track, element }))
    )).find(({ element }) => automaticEditPreviewOverlay.changedElementIds.has(element.id))
    if (!match) return
    const selection = commandEditor.setSelectedElements([{
      trackId: match.track.id,
      elementId: match.element.id,
    }]).selectedElements
    setSelectedElements(selection)
    const plannedTiming = automaticEditPreviewOverlay.timingByElement.get(
      elementKey(match.track.id, match.element.id),
    )
    seekAndReveal(plannedTiming?.startTime ?? match.element.startTime)
    setSnapLabel(`已定位预览变更 · ${match.element.name || match.element.id}`)
  }
  const renderElement = (trackId: string, element: EditorTimelineElement) => {
    const automaticPreview = automaticEditPreviewOverlay?.timingByElement.get(
      elementKey(trackId, element.id),
    )
    const preview = resizePreview.get(elementKey(trackId, element.id)) ?? automaticPreview
    const dragOffset = dragView.kind === 'dragging'
      ? dragView.memberTimeOffsets.get(element.id)
      : undefined
    const dragging = dragView.kind === 'dragging' && dragOffset !== undefined
    const startTime = dragging
      ? dragView.currentTime + dragOffset
      : preview?.startTime ?? element.startTime
    const duration = preview?.duration ?? element.duration
    const left = openCutTimelineTimeToPixels({ time: startTime, zoomLevel })
    const width = openCutTimelineTimeToPixels({ time: duration, zoomLevel })
    const selected = selectedElements.some((candidate) => (
      candidate.trackId === trackId && candidate.elementId === element.id
    ))
    const shot = shotForElement(shots, element)
    const visual = element.type === 'image' || element.type === 'video'
    const label = shot?.code ?? element.name ?? element.id
    const shortVideoFill = readAppliedShortVideoFillDisplay(element)
    const visibleShortVideoFill = shortVideoFill?.targetDurationTicks === duration
      ? shortVideoFill
      : null
    return (
      <button
        key={element.id}
        type="button"
        className={`timeline-element element-${element.type} ${selected ? 'active' : ''} ${dragging ? 'dragging' : ''} ${automaticEdit?.changedElementIds.has(element.id) ? 'automatic-edit-changed' : ''} ${automaticEditPreviewOverlay?.changedElementIds.has(element.id) ? 'automatic-edit-preview-changed' : ''}`}
        title={visibleShortVideoFill
          ? `OpenCut 已应用同镜静帧补尾 ${timecode(visibleShortVideoFill.holdDurationTicks)} · 计划 ${visibleShortVideoFill.appliedPlanHash.slice(0, 8)}`
          : undefined}
        style={{
          left,
          width: Math.max(3, width),
          transform: dragging ? `translate3d(0, ${dragView.currentMouseY - dragView.startMouseY}px, 0)` : undefined,
        }}
        onMouseDown={(event) => {
          if (!canMutateTimeline) {
            selectElement({ trackId, elementId: element.id })
            rejectUnhydratedMutation()
            return
          }
          elementInteractions.onElementMouseDown({ event, trackId, elementId: element.id })
        }}
        onClick={(event) => elementInteractions.onElementClick({ event, trackId, elementId: element.id })}
      >
        <i
          className="clip-resize-handle left"
          onMouseDown={(event) => {
            if (!canMutateTimeline) return rejectUnhydratedMutation()
            elementInteractions.onResizeStart({ event, trackId, elementId: element.id, side: 'left' })
          }}
          onClick={(event) => event.stopPropagation()}
        />
        {visual ? (
          <span
            className={`clip-thumb ${shot?.imageClass ?? ''}`}
            style={shot?.imageUrl ? {
              backgroundImage: `url(${JSON.stringify(shot.imageUrl)})`,
              backgroundPosition: 'center',
              backgroundSize: 'cover',
            } : undefined}
          >{element.type === 'video' ? <Film size={11} /> : !shot?.imageUrl ? <ImageIcon size={11} /> : null}</span>
        ) : element.type === 'audio' ? <Mic2 size={12} /> : <Type size={12} />}
        <strong>{label}</strong>
        <small>{timecode(duration)}</small>
        {visibleShortVideoFill && (
          <span
            className="timeline-short-video-fill-tail"
            style={{
              left: `${visibleShortVideoFill.holdStartPercent}%`,
              width: `${visibleShortVideoFill.holdWidthPercent}%`,
            }}
            data-fallback-asset-id={visibleShortVideoFill.fallbackAssetId}
            data-applied-plan-hash={visibleShortVideoFill.appliedPlanHash}
            title={`OpenCut 已应用同镜静帧补尾 ${timecode(visibleShortVideoFill.holdDurationTicks)} · 计划 ${visibleShortVideoFill.appliedPlanHash.slice(0, 8)}`}
          >
            <b>同镜静帧补尾</b>
          </span>
        )}
        <i
          className="clip-resize-handle right"
          onMouseDown={(event) => {
            if (!canMutateTimeline) return rejectUnhydratedMutation()
            elementInteractions.onResizeStart({ event, trackId, elementId: element.id, side: 'right' })
          }}
          onClick={(event) => event.stopPropagation()}
        />
      </button>
    )
  }

  return (
    <section className={`timeline opencut-controller-timeline ${open ? 'open' : ''} ${timelineHeadIncompatible ? 'timeline-canonical-quarantine-active' : ''}`}>
      <div className="timeline-head">
        <div className="timeline-title">
          <Film size={14} /><strong>时间线</strong><span>{timelineHeadIncompatible ? '隔离' : timecode(totalTicks)}</span>
          <em className={layoutValid ? 'timeline-kernel' : 'timeline-kernel invalid'}>{displayedKernelLabel}</em>
          <em className={`timeline-storage ${storageState.phase}`}><Cloud size={9} />{storageLabel[storageState.phase]}</em>
        </div>
        <div className="timeline-controls">
          {storage && (
            <button
              className={`timeline-auto-edit-trigger timeline-history-trigger ${historyOpen ? 'active' : ''}`}
              onClick={toggleTimelineHistory}
              disabled={!authoritativeTimeline || storageState.phase === 'loading' || storageState.phase === 'saving'}
              aria-label="查看时间线修订历史"
              aria-expanded={historyOpen}
              title="查看不可变修订；恢复会创建新 head，不删除旧版"
            >
              <History size={13} />修订
            </button>
          )}
          {storage && (
            <button
              className="timeline-auto-edit-trigger"
              onClick={() => void requestAutomaticEditPreview()}
              disabled={!timelineIsAuthoritative || storageState.dirty || automaticEditBusy !== null || automaticEditPreview !== null || agenticMotionPlan !== null}
              aria-label="Agentic 自动剪辑预览"
              title="只诊断并预览 OpenCut 原子操作，不调用 AIGC Provider"
            >
              <Sparkles size={13} />智能剪辑
            </button>
          )}
          <button
            className="timeline-auto-edit-trigger timeline-agentic-motion-trigger"
            onClick={requestAgenticMotionPreview}
            disabled={!canMutateTimeline || agenticMotionPlan !== null}
            aria-label="Agentic 智能运镜预览"
            title="按剧本运镜生成静态分镜的 OpenCut 中心缩放预览；不调用 AIGC Provider"
          >
            <Film size={13} />智能运镜
          </button>
          <button onClick={undo} disabled={!canMutateTimeline || !commandEditor.canUndo()} aria-label="撤销时间线操作"><RotateCcw size={13} /></button>
          <button onClick={redo} disabled={!canMutateTimeline || !commandEditor.canRedo()} aria-label="重做时间线操作"><Redo2 size={13} /></button>
          <button onClick={splitSelected} disabled={!canMutateTimeline} aria-label="在播放头处分割"><Scissors size={13} /></button>
          <button onClick={deleteSelected} disabled={!canMutateTimeline || selectedElements.length === 0} aria-label="删除所选时间线片段"><Trash2 size={13} /></button>
          <button
            className="timeline-program-play"
            onClick={toggleProgramPlayback}
            disabled={timelineHeadIncompatible || !programMonitorReady}
            aria-label={playbackState.isPlaying && programPlaybackEnabled ? '暂停节目' : '播放节目'}
            title="驱动节目监看器画面、对白、原视频音效和字幕"
          >
            {playbackState.isPlaying && programPlaybackEnabled ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
            <b>节目</b>
          </button>
          <button
            className={`timeline-playhead-only ${playbackState.isPlaying && !programPlaybackEnabled ? 'active' : ''}`}
            onClick={togglePlayheadOnly}
            disabled={timelineHeadIncompatible}
            aria-label={playbackState.isPlaying && !programPlaybackEnabled ? '暂停播放头' : '仅运行播放头'}
            title="仅运行动画时钟和播放头，不输出节目画面与声音"
          >
            <Clock3 size={13} /><b>播放头</b>
          </button>
          <span className="timecode">{timecode(playheadTicks)}</span>
          <button className="timeline-zoom" onClick={() => timelineInteractions.setZoomLevel((value) => value / 1.2)} disabled={timelineHeadIncompatible} aria-label="缩小时间线">−</button>
          <input
            aria-label="时间线缩放"
            type="range"
            min="0"
            max="1"
            step="0.001"
            disabled={timelineHeadIncompatible}
            value={openCutZoomToSlider({
              zoomLevel,
              minZoom: layout.minZoom,
              maxZoom: OPEN_CUT_TIMELINE_LAYOUT_METRICS.zoomMax,
            })}
            onChange={(event) => timelineInteractions.setZoomLevel(openCutSliderToZoom({
              sliderPosition: Number(event.target.value),
              minZoom: layout.minZoom,
              maxZoom: OPEN_CUT_TIMELINE_LAYOUT_METRICS.zoomMax,
            }))}
          />
          <span className="timeline-zoom-value">{Math.round(zoomLevel * 100)}%</span>
          <button className="timeline-zoom" onClick={() => timelineInteractions.setZoomLevel((value) => value * 1.2)} disabled={timelineHeadIncompatible} aria-label="放大时间线">+</button>
          <button onClick={onToggle} aria-label={open ? '收起时间线' : '展开时间线'}>{open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
        </div>
      </div>
      {open && !timelineHeadIncompatible && (
        <OpenCutProgramMonitor
          ref={programMonitorRef}
          expanded={programMonitorExpanded}
          onToggleExpanded={() => setProgramMonitorExpanded((value) => !value)}
          editor={commandEditor}
          tracks={tracks}
          playback={playbackState}
          programEnabled={programPlaybackEnabled}
          onProgramEnabledChange={setProgramPlaybackEnabled}
          onReadyChange={setProgramMonitorReady}
          scope={persistence && authoritativeTimeline && timelineIsAuthoritative ? {
            projectId: persistence.projectId,
            episodeId: persistence.episodeId,
            sourceRevisionId: persistence.sourceRevisionId,
            aspectRatio: persistence.aspectRatio,
            assetRevisionKey: persistence.assetRevisionKey,
            timelineDocumentId: authoritativeTimeline.timelineDocument.id,
            timelineRevisionId: authoritativeTimeline.revision.id,
            baseDocument: timelineDocumentBaseRef.current,
          } : null}
        />
      )}
      {open && quarantinedTimeline && (
        <div className="timeline-canonical-quarantine" role="alert" aria-label="authoritative 时间线兼容性隔离">
          <Server size={16} />
          <div className="timeline-canonical-quarantine-copy">
            <strong>当前 authoritative head 已持久隔离</strong>
            <span>
              修订 {quarantinedTimeline.snapshot.revision.id.slice(0, 8)} 与此 pinned OpenCut 客户端的作用域、来源或 canonical 协议不兼容。系统没有用分镜 fallback 伪装成可编辑时间线，也不会自动覆盖原始 JSON。
            </span>
            <small>隔离原因：{quarantinedTimeline.reasons.join('；')}</small>
            <small>
              Schema v{quarantinedTimeline.snapshot.revision.schemaVersion} · Commit {quarantinedTimeline.snapshot.revision.upstreamCommit.slice(0, 8)} · Story {quarantinedTimeline.snapshot.revision.sourceRevisionId?.slice(0, 8) ?? '未绑定'} · ETag {quarantinedTimeline.snapshot.etag}
            </small>
            <small>请先备份 raw JSON，再打开“修订”选择一个通过 canonical 与作用域校验的不可变历史，恢复会创建新的 head。</small>
            {timelineQuarantineMessage && <em role="status">{timelineQuarantineMessage}</em>}
          </div>
          <div className="timeline-canonical-quarantine-actions">
            <button className="button secondary" onClick={() => void copyQuarantinedAuthoritativeJson()} disabled={timelineQuarantineBusy !== null}>
              <Copy size={12} />{timelineQuarantineBusy === 'copy' ? '复制中…' : '复制当前 raw JSON'}
            </button>
            <button className="button secondary" onClick={downloadQuarantinedAuthoritativeJson} disabled={timelineQuarantineBusy !== null}>
              <Download size={12} />下载当前 raw JSON
            </button>
            <button className="button primary" onClick={() => {
              if (!historyOpen) toggleTimelineHistory()
            }} disabled={timelineHistoryBusy !== null}>
              <History size={12} />选择兼容历史
            </button>
          </div>
        </div>
      )}
      {open && timelineConflictRescue && persistence && (
        <div className="timeline-conflict-rescue" role="alert" aria-label="时间线冲突救援">
          <Server size={15} />
          <div className="timeline-conflict-rescue-copy">
            <strong>服务端已有新 head，本地命令副本已隔离</strong>
            <span>系统没有覆盖任何一方。先复制/下载救援 JSON；然后人工选择采用服务端，或将通过 canonical 校验的本地副本追加为新修订。</span>
            <small>
              本地基线 {timelineConflictRescue.expectedEtag ?? '未知'} · 远端 {timelineConflictRescue.currentRevisionId?.slice(0, 8) ?? '未知'} · {new Date(timelineConflictRescue.capturedAt).toLocaleString('zh-CN')}
            </small>
            {timelineConflictMessage && <em role="status">{timelineConflictMessage}</em>}
          </div>
          <div className="timeline-conflict-rescue-actions">
            <button className="button secondary" onClick={() => void copyTimelineConflictRescue()} disabled={timelineConflictBusy !== null}>
              <Copy size={12} />{timelineConflictBusy === 'copy' ? '复制中…' : '复制 JSON'}
            </button>
            <button className="button secondary" onClick={downloadTimelineConflictRescue} disabled={timelineConflictBusy !== null}>
              <Download size={12} />下载 JSON
            </button>
            <button className="button secondary" onClick={() => void adoptConflictServerHead()} disabled={timelineConflictBusy !== null}>
              <Server size={12} />{timelineConflictBusy === 'adopt' ? '读取中…' : '采用服务端'}
            </button>
            <button className="button primary" onClick={() => void saveConflictLocalAsNewRevision()} disabled={timelineConflictBusy !== null}>
              {timelineConflictBusy === 'save' ? '另存中…' : '本地副本另存新修订'}
            </button>
          </div>
        </div>
      )}
      {open && historyOpen && storage && (
        <div className="timeline-history-panel" role="region" aria-label="时间线修订历史">
          <div className="timeline-history-list">
            <div className="timeline-history-heading">
              <strong>不可变修订</strong>
              <button className="button secondary" onClick={() => void loadTimelineHistory()} disabled={timelineHistoryBusy !== null}>
                {timelineHistoryBusy === 'load' ? '刷新中…' : '刷新'}
              </button>
            </div>
            {timelineHistory?.revisions.map((revision) => (
              <button
                key={revision.id}
                type="button"
                className={selectedHistoryRevisionId === revision.id ? 'selected' : ''}
                onClick={() => setSelectedHistoryRevisionId(revision.id)}
                data-restorable={timelineHistoryCompatibility.get(revision.id)?.compatible === true}
              >
                <span>
                  <b>{revision.summary}</b>
                  {revision.id === timelineHistory.timelineDocument.currentRevisionId && <em>当前 head</em>}
                  {timelineHistoryCompatibility.get(revision.id)?.compatible === false
                    && <em className="incompatible">不可恢复</em>}
                </span>
                <small>{new Date(revision.createdAt).toLocaleString('zh-CN')} · {revision.id.slice(0, 8)}</small>
              </button>
            ))}
            {!timelineHistory && timelineHistoryBusy === 'load' && <span className="timeline-history-empty">正在读取修订…</span>}
            {timelineHistory && timelineHistory.revisions.length === 0 && <span className="timeline-history-empty">暂无修订</span>}
          </div>
          <div className="timeline-history-preview">
            {selectedHistoryRevision && selectedHistoryStats ? (
              <>
                <div>
                  <strong>{selectedHistoryRevision.summary}</strong>
                  <span>{selectedHistoryRevision.id}</span>
                </div>
                <dl>
                  <div><dt>轨道 / 元素</dt><dd>{selectedHistoryStats.tracks} / {selectedHistoryStats.elements}</dd></div>
                  <div><dt>时长</dt><dd>{timecode(selectedHistoryStats.durationTicks)}</dd></div>
                  <div><dt>Story 源</dt><dd>{selectedHistoryRevision.sourceRevisionId?.slice(0, 8) ?? '未绑定'}</dd></div>
                  <div><dt>Schema / Commit</dt><dd>v{selectedHistoryRevision.schemaVersion} / {selectedHistoryRevision.upstreamCommit.slice(0, 8)}</dd></div>
                  <div><dt>父修订</dt><dd>{selectedHistoryRevision.parentRevisionId?.slice(0, 8) ?? '根修订'}</dd></div>
                </dl>
                {!selectedHistoryCompatible && (
                  <p role="alert">
                    该修订已禁止恢复：{selectedHistoryCompatibility?.reasons.join('；') ?? '无法验证修订兼容性'}。
                  </p>
                )}
                <button
                  className="button primary"
                  onClick={() => void restoreSelectedHistoryRevision()}
                  disabled={
                    !selectedHistoryCompatible
                    || selectedHistoryRevision.id === authoritativeTimeline?.revision.id
                    || storageState.dirty
                    || timelineHistoryBusy !== null
                  }
                >
                  {selectedHistoryRevision.id === authoritativeTimeline?.revision.id
                    ? '已是当前 head'
                    : timelineHistoryBusy === 'restore'
                      ? '创建新修订中…'
                      : '恢复为新修订'}
                </button>
                <small>不会移动或删除旧 head；恢复后导出、质检与生产任务会进入 stale。不调用 AIGC Provider。</small>
              </>
            ) : <span>选择一个修订查看元数据</span>}
            {timelineHistoryError && <p role="alert">{timelineHistoryError}</p>}
          </div>
        </div>
      )}
      {open && !timelineHeadIncompatible && automaticEditBusy === 'preview' && !automaticEditPreview && (
        <div className="timeline-automatic-edit-preview loading" role="status">
          <Sparkles size={14} />
          <div>
            <strong>Agentic 正在诊断可导出性</strong>
            <span>只生成受限 OpenCut 时间操作，不会修改时间线修订或调用 Provider；服务端会保存不可变审计计划。</span>
          </div>
        </div>
      )}
      {open && !timelineHeadIncompatible && automaticEditPreview && automaticEditPreviewOverlay && (
        <div className="timeline-automatic-edit-preview" role="region" aria-label="Agentic 自动剪辑预览">
          <Sparkles size={14} />
          <div className="timeline-automatic-edit-preview-copy">
            <strong>{automaticEditPreview.risk === 'blocked' ? '自动剪辑诊断 · 需要人工处理' : '自动剪辑预览 · 尚未保存'}</strong>
            <span>{automaticEditPreview.risk === 'blocked'
              ? '候选结果未通过与正式导出相同的语义校验；安全策略不会擅自截断、移动或改写非托管素材。'
              : `黄色虚线是 ${automaticEditPreview.operations.length} 项 OpenCut 时间调整；应用后才会创建新的不可变修订。`}</span>
            <small>
              安全策略 · 不截断对白 · 不移动 BGM/SFX · 不调用 AIGC Provider · 计划 {automaticEditPreview.plan.planHash.slice(0, 8)}
            </small>
            {automaticEditPreview.diagnostics.length > 0 && (
              <div className="timeline-auto-edit-diagnostics">
                {automaticEditPreview.diagnostics.slice(0, 3).map((diagnostic) => (
                  <span key={`${diagnostic.code}:${diagnostic.message}`} className={diagnostic.severity}>
                    {diagnostic.message}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="timeline-automatic-edit-actions">
            <button className="button secondary" onClick={focusFirstAutomaticEditPreview} disabled={automaticEditPreview.operations.length === 0}>定位变更</button>
            <button className="button secondary" onClick={discardAutomaticEditPreview} disabled={automaticEditBusy !== null}>放弃预览</button>
            <button
              className="button primary"
              onClick={() => void applyAutomaticEditPreview()}
              disabled={automaticEditBusy !== null
                || automaticEditPreview.risk !== 'safe'
                || automaticEditPreview.operations.length === 0
                || automaticEditPreview.diagnostics.some((diagnostic) => diagnostic.severity === 'error')}
            >
              {automaticEditBusy === 'apply' ? '正在创建修订…' : '应用为新修订'}
            </button>
          </div>
        </div>
      )}
      {open && !timelineHeadIncompatible && agenticMotionPlan && (
        <div className="timeline-automatic-edit-preview timeline-agentic-motion-preview" role="region" aria-label="Agentic 智能运镜预览">
          <Film size={14} />
          <div className="timeline-automatic-edit-preview-copy">
            <strong>智能运镜预览 · 尚未保存</strong>
            <span>
              将为 {agenticMotionPlan.recommendations.length} 个静态分镜应用中心轻推近 / 轻拉远；视频、人工运镜和横移 / 摇镜均不会被覆盖。
            </span>
            <small>OpenCut 单一原子命令 · 全片线性缩放 · 不调用 AIGC Provider</small>
            <div className="timeline-agentic-motion-items" aria-label="智能运镜建议">
              {agenticMotionPlan.recommendations.slice(0, 6).map((recommendation) => (
                <span key={`${recommendation.trackId}:${recommendation.elementId}`}>
                  <b>{recommendation.shotCode}</b>
                  {recommendation.motion === 'push-in' ? '轻推近' : '轻拉远'} {recommendation.strength}%
                </span>
              ))}
              {agenticMotionPlan.recommendations.length > 6 && (
                <span>另 {agenticMotionPlan.recommendations.length - 6} 镜</span>
              )}
            </div>
          </div>
          <div className="timeline-automatic-edit-actions">
            <button className="button secondary" onClick={clearAgenticMotionPreview}>放弃预览</button>
            <button className="button primary" onClick={applyAgenticMotionPlan}>应用为 OpenCut 修订</button>
          </div>
        </div>
      )}
      {open && !timelineHeadIncompatible && !automaticEditPreview && automaticEdit && (
        <div className="timeline-automatic-edit-banner">
          <Sparkles size={14} />
          <div>
            <strong>Agentic 自动剪辑修订</strong>
            <span>已通过 OpenCut 原子命令安全调整 {automaticEdit.operationCount} 个片段；绿色描边即本次变更。</span>
            <small>不裁剪对白 · 不移动 BGM/SFX · 计划 {automaticEdit.planHash.slice(0, 8)}{automaticEdit.applicationId ? ' · 当前仍为应用 head 时可持久撤销' : ''}</small>
          </div>
          <button className="button secondary" onClick={focusFirstAutomaticEdit}>定位首个变更</button>
          {automaticEdit.applicationId && (
            <button
              className="button secondary timeline-auto-edit-undo"
              onClick={() => void undoAutomaticEditApplication()}
              disabled={automaticEditBusy !== null || !timelineIsAuthoritative}
            >
              {automaticEditBusy === 'undo' ? '正在撤销…' : '撤销为新修订'}
            </button>
          )}
        </div>
      )}
      {open && !timelineHeadIncompatible && automaticEditError && (
        <div className="timeline-automatic-edit-error" role="alert">
          {automaticEditError}
          {!automaticEditPreview && automaticEditBusy === null && storage && (
            <button className="button secondary" onClick={() => void requestAutomaticEditPreview()}>重新诊断</button>
          )}
        </div>
      )}
      {open && !timelineHeadIncompatible && selectedAudioBinding && audioMixDraft && (
        <div className="timeline-audio-mixbar">
          <span><Volume2 size={12} /><strong>{selectedAudioBinding.element.name || '所选音频'}</strong></span>
          <label>音量 <b>{Math.round(audioMixDraft.volume * 100)}%</b><input type="range" min="0" max="2" step="0.05" value={audioMixDraft.volume} onChange={(event) => setAudioMixDraft((current) => current ? { ...current, volume: Number(event.target.value) } : current)} /></label>
          <label>淡入 <b>{audioMixDraft.fadeInSeconds.toFixed(1)}s</b><input type="range" min="0" max={Math.min(10, selectedAudioBinding.element.duration / OPEN_CUT_TICKS_PER_SECOND)} step="0.1" value={audioMixDraft.fadeInSeconds} onChange={(event) => setAudioMixDraft((current) => current ? { ...current, fadeInSeconds: Number(event.target.value) } : current)} /></label>
          <label>淡出 <b>{audioMixDraft.fadeOutSeconds.toFixed(1)}s</b><input type="range" min="0" max={Math.min(10, selectedAudioBinding.element.duration / OPEN_CUT_TICKS_PER_SECOND)} step="0.1" value={audioMixDraft.fadeOutSeconds} onChange={(event) => setAudioMixDraft((current) => current ? { ...current, fadeOutSeconds: Number(event.target.value) } : current)} /></label>
          <button className="button secondary" onClick={applyAudioMix} disabled={!canMutateTimeline}>应用混音</button>
        </div>
      )}
      {open && !timelineHeadIncompatible && selectedVisualBinding && visualFitDraft && (
        <div className="timeline-audio-mixbar timeline-visual-fitbar">
          <span><Film size={12} /><strong>{selectedVisualBinding.element.name || '所选画面'} · 画面适配</strong></span>
          <fieldset className="timeline-visual-scale-options">
            <legend>适配方式</legend>
            {([
              ['cover', '填满画布（裁切）'],
              ['contain', '完整显示（留边）'],
            ] as const).map(([fit, label]) => (
              <button
                key={fit}
                type="button"
                className={visualFitDraft.fit === fit ? 'active' : ''}
                aria-pressed={visualFitDraft.fit === fit}
                onClick={() => setVisualFitDraft((current) => current
                  ? { ...current, fit }
                  : current)}
              >{label}</button>
            ))}
          </fieldset>
          <small>cover 会填满画布并裁切边缘；contain 保留完整画面。</small>
          <button
            className="button secondary"
            onClick={applyVisualFit}
            disabled={!canMutateTimeline || visualFitDraft.fit === visualFitDraft.expectedFit}
          >应用画面适配</button>
        </div>
      )}
      {open && !timelineHeadIncompatible && selectedVisualBinding && visualFitBlocked && (
        <div className="timeline-visual-fade-blocked" role="status">
          画面适配已禁用：{visualFitBlocked}
        </div>
      )}
      {open && !timelineHeadIncompatible && selectedVisualBinding && visualFadeDraft && (
        <div className="timeline-audio-mixbar timeline-visual-fadebar">
          <span><Film size={12} /><strong>{selectedVisualBinding.element.name || '所选画面'} · 透明度</strong></span>
          <label>淡入 <b>{(visualFadeDraft.fadeInFrames / VISUAL_OPACITY_FRAME_RATE).toFixed(2)}s</b><input
            type="range"
            min="0"
            max={Math.max(0, selectedVisualBinding.element.duration / VISUAL_OPACITY_FRAME_TICKS - visualFadeDraft.fadeOutFrames)}
            step="1"
            value={visualFadeDraft.fadeInFrames}
            onChange={(event) => setVisualFadeDraft((current) => current
              ? { ...current, fadeInFrames: Number(event.target.value) }
              : current)}
          /></label>
          <label>淡出 <b>{(visualFadeDraft.fadeOutFrames / VISUAL_OPACITY_FRAME_RATE).toFixed(2)}s</b><input
            type="range"
            min="0"
            max={Math.max(0, selectedVisualBinding.element.duration / VISUAL_OPACITY_FRAME_TICKS - visualFadeDraft.fadeInFrames)}
            step="1"
            value={visualFadeDraft.fadeOutFrames}
            onChange={(event) => setVisualFadeDraft((current) => current
              ? { ...current, fadeOutFrames: Number(event.target.value) }
              : current)}
          /></label>
          <button className="button secondary" onClick={applyVisualFade} disabled={!canMutateTimeline}>
            {visualFadeDraft.fadeInFrames === 0 && visualFadeDraft.fadeOutFrames === 0
              ? '清除淡化'
              : '应用画面淡化'}
          </button>
        </div>
      )}
      {open && !timelineHeadIncompatible && selectedVisualBinding && visualFadeBlocked && (
        <div className="timeline-visual-fade-blocked" role="status">
          所选画面含未审核组合语义，已保留原数据并禁止覆盖：{visualFadeBlocked}
        </div>
      )}
      {open && !timelineHeadIncompatible && selectedVisualBinding && visualScaleDraft && (
        <div className="timeline-audio-mixbar timeline-visual-scalebar">
          <span><Film size={12} /><strong>{selectedVisualBinding.element.name || '所选画面'} · 镜头运动</strong></span>
          <fieldset className="timeline-visual-scale-options">
            <legend>镜头运动</legend>
            {([
              ['none', '无'],
              ['push-in', '轻推近'],
              ['pull-out', '轻拉远'],
            ] as const).map(([motion, label]) => (
              <button
                key={motion}
                type="button"
                className={visualScaleDraft.motion === motion ? 'active' : ''}
                aria-pressed={visualScaleDraft.motion === motion}
                onClick={() => setVisualScaleDraft((current) => current
                  ? { ...current, motion }
                  : current)}
              >{label}</button>
            ))}
          </fieldset>
          <fieldset className="timeline-visual-scale-options">
            <legend>强度</legend>
            {VISUAL_UNIFORM_SCALE_STRENGTHS.map((strength) => (
              <button
                key={strength}
                type="button"
                className={visualScaleDraft.strength === strength ? 'active' : ''}
                aria-pressed={visualScaleDraft.strength === strength}
                disabled={visualScaleDraft.motion === 'none'}
                onClick={() => setVisualScaleDraft((current) => current
                  ? { ...current, strength }
                  : current)}
              >{strength}%</button>
            ))}
          </fieldset>
          <small>中心锚点 · 全片线性运动</small>
          <button className="button secondary" onClick={applyVisualScaleMotion} disabled={!canMutateTimeline}>
            {visualScaleDraft.motion === 'none' ? '清除镜头运动' : '应用镜头运动'}
          </button>
        </div>
      )}
      {open && !timelineHeadIncompatible && selectedVisualBinding && visualScaleBlocked && (
        <div className="timeline-visual-fade-blocked" role="status">
          镜头运动已禁用：{visualScaleBlocked}
        </div>
      )}
      {open && !timelineHeadIncompatible && selectedVisualBinding && visualMaskDraft && (
        <div className="timeline-audio-mixbar timeline-visual-maskbar">
          <span><Film size={12} /><strong>{selectedVisualBinding.element.name || '所选画面'} · 遮罩</strong></span>
          <label className="timeline-visual-mask-toggle"><input
            type="checkbox"
            checked={visualMaskDraft.enabled}
            onChange={(event) => setVisualMaskDraft((current) => current
              ? { ...current, enabled: event.target.checked }
              : current)}
          />启用</label>
          <label>形状 <select
            value={visualMaskDraft.type}
            disabled={!visualMaskDraft.enabled}
            onChange={(event) => setVisualMaskDraft((current) => current
              ? { ...current, type: event.target.value === 'ellipse' ? 'ellipse' : 'rectangle' }
              : current)}
          ><option value="rectangle">矩形</option><option value="ellipse">椭圆</option></select></label>
          <label className="timeline-visual-mask-toggle"><input
            type="checkbox"
            checked={visualMaskDraft.inverted}
            disabled={!visualMaskDraft.enabled}
            onChange={(event) => setVisualMaskDraft((current) => current
              ? { ...current, inverted: event.target.checked }
              : current)}
          />反向（保留外部）</label>
          <label>X <b>{Math.round(visualMaskDraft.centerX * 100)}%</b><input
            type="range" min="-1" max="1" step="0.01"
            disabled={!visualMaskDraft.enabled}
            value={visualMaskDraft.centerX}
            onChange={(event) => setVisualMaskDraft((current) => current
              ? { ...current, centerX: Number(event.target.value) }
              : current)}
          /></label>
          <label>Y <b>{Math.round(visualMaskDraft.centerY * 100)}%</b><input
            type="range" min="-1" max="1" step="0.01"
            disabled={!visualMaskDraft.enabled}
            value={visualMaskDraft.centerY}
            onChange={(event) => setVisualMaskDraft((current) => current
              ? { ...current, centerY: Number(event.target.value) }
              : current)}
          /></label>
          <label>宽 <b>{Math.round(visualMaskDraft.width * 100)}%</b><input
            type="range" min="0.01" max="2" step="0.01"
            disabled={!visualMaskDraft.enabled}
            value={visualMaskDraft.width}
            onChange={(event) => setVisualMaskDraft((current) => current
              ? { ...current, width: Number(event.target.value) }
              : current)}
          /></label>
          <label>高 <b>{Math.round(visualMaskDraft.height * 100)}%</b><input
            type="range" min="0.01" max="2" step="0.01"
            disabled={!visualMaskDraft.enabled}
            value={visualMaskDraft.height}
            onChange={(event) => setVisualMaskDraft((current) => current
              ? { ...current, height: Number(event.target.value) }
              : current)}
          /></label>
          <button className="button secondary" onClick={applyVisualMask} disabled={!canMutateTimeline}>
            {visualMaskDraft.enabled ? '应用遮罩' : '清除遮罩'}
          </button>
        </div>
      )}
      {open && !timelineHeadIncompatible && selectedVisualBinding && visualMaskBlocked && (
        <div className="timeline-visual-fade-blocked" role="status">
          所选画面含未审核遮罩，已保留原数据并禁止覆盖：{visualMaskBlocked}
        </div>
      )}
      {open && !timelineHeadIncompatible && selectedSourceAudioBinding && sourceAudioDraft && (
        <div className="timeline-audio-mixbar timeline-source-audio-mixbar">
          <span><Volume2 size={12} /><strong>{selectedSourceAudioBinding.element.name || '所选视频'} · 环境音</strong></span>
          <label className="timeline-source-audio-toggle"><input type="checkbox" checked={sourceAudioDraft.enabled} onChange={(event) => setSourceAudioDraft((current) => current ? { ...current, enabled: event.target.checked } : current)} /> 使用源音频</label>
          <label>音量 <b>{Math.round(sourceAudioDraft.volume * 100)}%</b><input type="range" min="0" max="2" step="0.05" value={sourceAudioDraft.volume} onChange={(event) => setSourceAudioDraft((current) => current ? { ...current, volume: Number(event.target.value) } : current)} /></label>
          <button className="button secondary" onClick={applySourceAudioMix} disabled={!canMutateTimeline}>应用环境音</button>
        </div>
      )}
      {open && !timelineHeadIncompatible && (
        <div
          ref={timelineContainerRef}
          className="timeline-body opencut-timeline-body"
          style={{
            height: bodyHeight,
            gridTemplateColumns: `${OPEN_CUT_TIMELINE_LAYOUT_METRICS.trackLabelsColumnWidthPx}px minmax(0, 1fr)`,
          }}
        >
          <div ref={trackLabelsRef} className="track-labels opencut-track-labels">
            <i style={{ height: OPEN_CUT_TIMELINE_LAYOUT_METRICS.rulerHeightPx }} />
            <div ref={trackLabelRowsRef} style={{ gap: OPEN_CUT_TIMELINE_LAYOUT_METRICS.trackGapPx }}>
              {orderedTracks.map((track) => (
                <span key={track.id} style={{ height: getOpenCutTrackHeight({ trackType: track.type }) }}>
                  {trackLabel(track)}
                </span>
              ))}
            </div>
          </div>
          <div className="timeline-scroll-stack">
            <div
              ref={rulerScrollRef}
              className="timeline-ruler-scroll"
              onMouseDown={(event) => timelineInteractions.onRulerMouseDown(event)}
              onClick={(event) => timelineInteractions.onRulerClick(event)}
              onWheel={(event) => timelineInteractions.onWheel(event)}
            >
              <div className="ruler" style={{ width: layout.dynamicTimelineWidth }}>
                {[0, .25, .5, .75, 1].map((ratio) => {
                  const tick = Math.round(totalTicks * ratio)
                  return (
                    <span
                      key={ratio}
                      style={{ left: openCutTimelineTimeToPixels({ time: tick, zoomLevel }) }}
                    >{timecode(tick).slice(0, 5)}</span>
                  )
                })}
              </div>
            </div>
            <div
              ref={tracksScrollRef}
              className="tracks opencut-tracks-scroll"
              onMouseDown={(event) => timelineInteractions.onTracksMouseDown(event)}
              onClick={(event) => timelineInteractions.onTracksClick(event)}
              onWheel={(event) => timelineInteractions.onWheel(event)}
              onScroll={(event) => {
                if (rulerScrollRef.current) rulerScrollRef.current.scrollLeft = event.currentTarget.scrollLeft
                if (trackLabelRowsRef.current) {
                  trackLabelRowsRef.current.style.transform = `translateY(${-event.currentTarget.scrollTop}px)`
                }
                timelineInteractions.saveScrollPosition()
              }}
            >
              <div
                ref={tracksContainerRef}
                className="opencut-tracks-container"
                style={{
                  width: layout.dynamicTimelineWidth,
                  minHeight: tracksHeight,
                  gap: OPEN_CUT_TIMELINE_LAYOUT_METRICS.trackGapPx,
                  paddingTop: OPEN_CUT_TIMELINE_LAYOUT_METRICS.contentTopPaddingPx,
                }}
              >
                {orderedTracks.map((track) => (
                  <div
                    key={track.id}
                    className={`track timeline-track-row track-${track.type}`}
                    style={{ height: getOpenCutTrackHeight({ trackType: track.type }) }}
                  >
                    {track.elements.map((element) => renderElement(track.id, element))}
                    {track.elements.length === 0 && <span className="timeline-empty-track">空轨道</span>}
                  </div>
                ))}
                <div
                  ref={playheadRef}
                  className="playhead"
                  style={{ left: openCutTimelineTimeToPixels({ time: playheadTicks, zoomLevel }) }}
                ><i /></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
