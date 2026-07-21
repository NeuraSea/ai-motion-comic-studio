import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  Settings2,
  ShieldCheck,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'

import {
  ApiError,
  api,
  type MediaAsset,
  type ShotVideoBatchPreflight,
  type ShotVideoBatchPreflightInput,
  type ShotVideoAudioPolicy,
  type ShotVideoPromptCompilerVersion,
  type CharacterVisualReferenceView,
  type ShotVideoGenerationJob,
  type ShotVideoReferenceMode,
  type ShotVideoVisualReferenceAuthority,
  type ShotVideoVisualReferenceAnalysisJob,
} from '../../lib'
import {
  completeShotVideoBatchAttempt,
  clearShotVideoBatchAttemptsForTimingRecovery,
  confirmedShotVideoBatchInput,
  initialShotVideoBatchSelection,
  prepareShotVideoBatchAttempt,
  parseShotVideoReferenceCompatibilityIssues,
  referencesFromShotVideoDraft,
  shotVideoBatchPreflightMatches,
  shotVideoVisualAnalysisBlocksPreflight,
  shotVideoVisualAnalysisAuthorityKey,
  shotVideoVisualAnalysisShotKey,
  shotVideoVisualAnalysisTargets,
  summarizeShotVideoBatchAvailability,
  validShotVideoVisualAnalysisJobId,
  wholeTurnaroundCompatibilityRecoveryReferences,
  type ShotVideoBatchAttempt,
  type ShotVideoBatchAvailability,
  type ShotVideoReferenceCompatibilityIssue,
  type ShotVideoTimingRepreflightRecovery,
} from './shot-video-batch-state'
import {
  buildSmartShotVideoReferenceDraft,
  shotVideoReferenceRecommendationDetails,
  type SmartShotVideoReferenceDraft,
} from './shot-video-reference-recommendations'
import {
  missingManualSlotAssetIds,
  parseShotVideoManualReferenceRecoveries,
  selectorsForManualSlotChoices,
  type ShotVideoManualReferenceRecovery,
} from './shot-video-manual-reference'
import './ShotVideoBatchDialog.css'

export interface ShotVideoBatchShot {
  shotId: string
  sceneId: string
  code: string
  title: string
  durationSeconds: number
  assetId: string | null
  imageUrl: string | null
  recommendedReferenceAssetIds?: string[]
  videoState: ShotVideoBatchAvailability
  /** Optional future authoring signal; never inferred from the next shot. */
  sameShotStateChange?: boolean
  /** Separately authored tail keyframe owned by this same shot. */
  dedicatedLastFrameAssetId?: string | null
}

export interface ShotVideoBatchDialogProps {
  open: boolean
  projectId: string
  episodeId: string
  sourceRevisionId: string
  providerId?: string
  providerConfigRevision?: number
  providerModel?: string
  textProviderId?: string
  textProviderConfigRevision?: number
  textProviderModel?: string
  textProviderReady?: boolean
  initialShotId: string | null
  /** Optional acceptance preset; it only initializes controls and never submits. */
  initialPromptCompilerVersion?: ShotVideoPromptCompilerVersion
  initialResolution?: '480p' | '720p' | '1080p'
  initialSelectionMode?: 'default' | 'all-available'
  shots: ShotVideoBatchShot[]
  assets: MediaAsset[]
  blockedShotReasons?: Readonly<Record<string, string>>
  timingRepreflightRecovery?: ShotVideoTimingRepreflightRecovery | null
  onClose: () => void
  onConfigureProvider: () => void
  onConfigureCharacterReferences: () => void
  onRefreshAssets: () => void | Promise<void>
  onSubmitted: (jobs: ShotVideoGenerationJob[]) => void | Promise<void>
  onTimingRepreflightCompleted?: (recovery: ShotVideoTimingRepreflightRecovery) => void
}

type ReferenceDraft = {
  mode: ShotVideoReferenceMode
  firstFrameAssetId: string
  lastFrameAssetId: string
  referenceAssetIds: string[]
  strategy?: SmartShotVideoReferenceDraft['strategy']
}

type ReferenceControlMode = 'smart' | 'manual'

type ReferencePreview = {
  url: string
  name: string
  source: string
  purpose: string
}

type VisualAnalysisBinding = {
  jobId: string | null
  requestAuthorityKey: string
  selectors: Array<{ shotId: string; sceneId: string }>
  starting: boolean
  error: string
  /** Present only for bindings restored through the server authority index. */
  serverAuthority?: ShotVideoVisualReferenceAuthority
}

type VisualAnalysisSubmission = {
  idempotencyKey: string
  jobReceived: boolean
}

const referenceModeOptions: Array<{ value: ShotVideoReferenceMode; label: string; help: string }> = [
  { value: 'text-to-video', label: '纯文生视频', help: '仅使用镜头描述' },
  { value: 'first-frame', label: '首帧引导', help: '锁定起始构图' },
  { value: 'first-last-frame', label: '首尾帧', help: '锁定起止画面' },
  { value: 'multi-reference', label: '多参考图', help: '1–9 张通用道具、场景或同镜参考；不冒充角色三视图审计' },
]

const audioPolicyOptions: Array<{
  value: ShotVideoAudioPolicy
  label: string
  help: string
  icon: typeof Volume2
}> = [
  {
    value: 'sfx_only',
    label: '仅环境音 / 动作音',
    help: '推荐。Prompt 会禁止 BGM、旁白和额外对白，便于 OpenCut 分轨后期。',
    icon: Volume2,
  },
  {
    value: 'silent',
    label: '静音视频',
    help: '不请求模型音频，适合完全由 MiniMax 与素材库完成声音的镜头。',
    icon: VolumeX,
  },
  {
    value: 'provider_audio',
    label: 'Seedance 同步台词试听',
    help: '使用当前剧本的逐字台词生成同步人声；结果先进入候选版本，不会覆盖当前镜头。',
    icon: Sparkles,
  },
]

function clampDuration(value: number): number {
  return Math.max(4, Math.min(15, Math.round(Number.isFinite(value) ? value : 4)))
}

function initialDraft(shot: ShotVideoBatchShot, eligibleIds: ReadonlySet<string>): ReferenceDraft {
  return buildSmartShotVideoReferenceDraft({
    currentStoryboardAssetId: shot.assetId,
    recommendedAssetIds: shot.recommendedReferenceAssetIds ?? [],
    eligibleAssetIds: eligibleIds,
    sameShotStateChange: shot.sameShotStateChange,
    dedicatedLastFrameAssetId: shot.dedicatedLastFrameAssetId,
  })
}

function assetLabel(asset: MediaAsset): string {
  const file = asset.originalFileName?.trim()
  if (file) return file
  const kind = asset.kind === 'storyboard'
    ? '分镜图'
    : asset.kind === 'character-turnaround'
      ? '角色设定'
      : asset.kind === 'location-concept'
        ? '场景设定'
        : asset.kind === 'prop-concept'
          ? '道具设定'
        : '参考图'
  return `${kind} · v${asset.version}`
}

function smartStrategyCopy(strategy: ReferenceDraft['strategy']): { label: string; description: string } {
  if (strategy === 'detail-multi-reference') return {
    label: '细节镜头 · 多参考',
    description: '当前分镜负责镜头内容，已锁定角色、道具和场景负责造型一致性。',
  }
  if (strategy === 'same-shot-transition') return {
    label: '同镜状态变化 · 首尾帧',
    description: '仅因当前镜头明确包含状态变化，且已有专用尾关键帧才使用。',
  }
  if (strategy === 'current-storyboard') return {
    label: '普通镜头 · 当前分镜首帧',
    description: '使用当前分镜固定起始构图，不额外添加无关参考。',
  }
  return {
    label: '暂无可用图片 · 纯文本',
    description: '当前修订没有可验证的分镜图，预检前可在手动高级模式补充。',
  }
}

function formatExpiry(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '无效时间'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const activeVisualAnalysisStatuses = new Set(['queued', 'running', 'waiting_provider'])

function visualAnalysisStrategyLabel(strategy: string): string {
  if (strategy === 'first_frame') return '首帧引导'
  if (strategy === 'multi_reference') return '多参考图'
  if (strategy === 'text_only') return '纯文本'
  return '需要人工确认'
}

function missingViewLabel(view: string): string {
  return ({ front: '正面', side: '侧面', back: '背面', uncertain: '视角不确定' })[view] ?? view
}

function visualAnalysisJobError(job: ShotVideoVisualReferenceAnalysisJob): string {
  return job.error?.message?.trim() || '视觉分析任务未完成。'
}

function restoredVisualAnalysisAuthorityIsCurrent(
  authority: ShotVideoVisualReferenceAuthority | undefined,
): boolean {
  if (!authority) return true
  if (authority.usable && authority.reason === 'current') return true
  return authority.reason === 'job_not_succeeded'
    && authority.boundInputFingerprint !== null
    && authority.boundInputFingerprint === authority.currentInputFingerprint
}

export function ShotVideoBatchDialog({
  open,
  projectId,
  episodeId,
  sourceRevisionId,
  providerId,
  providerConfigRevision,
  providerModel,
  textProviderId,
  textProviderConfigRevision,
  textProviderModel,
  textProviderReady = false,
  initialShotId,
  initialPromptCompilerVersion = 'seedance-compact-v1',
  initialResolution = '720p',
  initialSelectionMode = 'default',
  shots,
  assets,
  blockedShotReasons = {},
  timingRepreflightRecovery = null,
  onClose,
  onConfigureProvider,
  onConfigureCharacterReferences,
  onRefreshAssets,
  onSubmitted,
  onTimingRepreflightCompleted,
}: ShotVideoBatchDialogProps) {
  const availableShots = useMemo(() => shots.slice(0, 24), [shots])
  const availabilitySummary = useMemo(
    () => summarizeShotVideoBatchAvailability(availableShots),
    [availableShots],
  )
  const eligibleAssets = useMemo(() => assets.filter((asset) => (
    asset.status === 'ready'
    && asset.episodeId === episodeId
    && asset.sourceRevisionId === sourceRevisionId
    && Boolean(asset.checksum)
    && ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(asset.mimeType ?? '')
  )), [assets, episodeId, sourceRevisionId])
  const eligibleIds = useMemo(() => new Set(eligibleAssets.map((asset) => asset.id)), [eligibleAssets])
  const eligibleAssetById = useMemo(() => new Map(
    eligibleAssets.map((asset) => [asset.id, asset] as const),
  ), [eligibleAssets])
  const [selectedShotIds, setSelectedShotIds] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, ReferenceDraft>>({})
  const [referenceControlMode, setReferenceControlMode] = useState<ReferenceControlMode>('smart')
  const [referencePreview, setReferencePreview] = useState<ReferencePreview | null>(null)
  const [resolution, setResolution] = useState<'480p' | '720p' | '1080p'>('720p')
  const [promptCompilerVersion, setPromptCompilerVersion] = useState<ShotVideoPromptCompilerVersion>('seedance-compact-v1')
  const [audioPolicy, setAudioPolicy] = useState<ShotVideoAudioPolicy>('sfx_only')
  const publicationMode = promptCompilerVersion === 'seedance-verbose-baseline-v1'
    || audioPolicy === 'provider_audio'
    ? 'evaluation_only' as const
    : 'replace_current' as const
  const [preflight, setPreflight] = useState<ShotVideoBatchPreflight | null>(null)
  const [attempt, setAttempt] = useState<ShotVideoBatchAttempt | null>(null)
  const [preflighting, setPreflighting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [refreshingAssetLibrary, setRefreshingAssetLibrary] = useState(false)
  const [submittedCount, setSubmittedCount] = useState<number | null>(null)
  const [preflightAuthorityFingerprint, setPreflightAuthorityFingerprint] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [referenceCompatibilityIssues, setReferenceCompatibilityIssues] = useState<ShotVideoReferenceCompatibilityIssue[]>([])
  const [referenceCompatibilityOverrides, setReferenceCompatibilityOverrides] = useState<Record<string, string>>({})
  const [visualAnalysisJobsById, setVisualAnalysisJobsById] = useState<Record<string, ShotVideoVisualReferenceAnalysisJob>>({})
  const [visualAnalysisBindingByShotKey, setVisualAnalysisBindingByShotKey] = useState<Record<string, VisualAnalysisBinding>>({})
  const [visualAnalysisHydrating, setVisualAnalysisHydrating] = useState(false)
  const [visualAnalysisHydrationError, setVisualAnalysisHydrationError] = useState('')
  const [visualAnalysisHydrationRevision, setVisualAnalysisHydrationRevision] = useState(0)
  const [manualRecoveryByShot, setManualRecoveryByShot] = useState<Record<string, ShotVideoManualReferenceRecovery>>({})
  const [manualSlotChoices, setManualSlotChoices] = useState<Record<string, {
    textOnly: boolean
    views: Record<string, CharacterVisualReferenceView>
  }>>({})
  const attemptsRef = useRef(new Map<string, string>())
  const visualAnalysisSubmissionRef = useRef(new Map<string, VisualAnalysisSubmission>())
  const wasOpenRef = useRef(false)
  const handledTimingRecoveryRef = useRef<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  const busyRef = useRef(false)
  const referencePreviewRef = useRef<ReferencePreview | null>(null)
  closeRef.current = onClose
  referencePreviewRef.current = referencePreview
  const authorityFingerprint = useMemo(() => JSON.stringify({
    providerId: providerId ?? null,
    providerConfigRevision: providerConfigRevision ?? null,
    providerModel: providerModel ?? null,
    sourceRevisionId,
    assets: eligibleAssets.map((asset) => ({
      id: asset.id,
      version: asset.version,
      checksum: asset.checksum,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  }), [eligibleAssets, providerConfigRevision, providerId, providerModel, sourceRevisionId])

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      handledTimingRecoveryRef.current = null
      return
    }
    if (wasOpenRef.current) return
    wasOpenRef.current = true
    const safeDefaultShots = availableShots.filter((shot) => (
      !blockedShotReasons[shot.shotId] && shot.videoState !== 'locked'
    ))
    setSelectedShotIds(initialSelectionMode === 'all-available'
      ? safeDefaultShots.map((shot) => shot.shotId)
      : initialShotVideoBatchSelection(safeDefaultShots, initialShotId))
    setDrafts(Object.fromEntries(availableShots.map((shot) => [shot.shotId, initialDraft(shot, eligibleIds)])))
    setReferenceControlMode('smart')
    setResolution(initialResolution)
    setPromptCompilerVersion(initialPromptCompilerVersion)
    setAudioPolicy('sfx_only')
    setReferencePreview(null)
    setPreflight(null)
    setAttempt(null)
    setPreflighting(false)
    setSubmitting(false)
    setRefreshingAssetLibrary(false)
    setSubmittedCount(null)
    setPreflightAuthorityFingerprint(null)
    setError('')
    setReferenceCompatibilityIssues([])
    setReferenceCompatibilityOverrides({})
    setManualRecoveryByShot({})
    setManualSlotChoices({})
    window.requestAnimationFrame(() => dialogRef.current?.focus())
  }, [
    availableShots,
    blockedShotReasons,
    eligibleIds,
    initialPromptCompilerVersion,
    initialResolution,
    initialSelectionMode,
    initialShotId,
    open,
  ])

  useEffect(() => {
    if (!open || !timingRepreflightRecovery) return
    const recoveryKey = JSON.stringify(timingRepreflightRecovery)
    if (handledTimingRecoveryRef.current === recoveryKey) return
    if (timingRepreflightRecovery.projectId !== projectId
      || timingRepreflightRecovery.episodeId !== episodeId
      || timingRepreflightRecovery.sourceRevisionId !== sourceRevisionId) {
      handledTimingRecoveryRef.current = recoveryKey
      setSelectedShotIds([])
      setPreflight(null)
      setAttempt(null)
      setError('音频恢复请求已不属于当前分集或剧本修订；不会复用旧任务，请从当前音频重新开始。')
      return
    }
    const shot = availableShots.find((candidate) => (
      candidate.shotId === timingRepreflightRecovery.shotId
      && candidate.sceneId === timingRepreflightRecovery.sceneId
    ))
    if (!shot || blockedShotReasons[shot.shotId] || shot.videoState === 'locked') {
      setSelectedShotIds([])
      setPreflight(null)
      setAttempt(null)
      setError('音频恢复请求对应的镜头已不存在或处于安全锁定状态；不会创建新任务。')
      return
    }
    handledTimingRecoveryRef.current = recoveryKey
    clearShotVideoBatchAttemptsForTimingRecovery(attemptsRef.current, timingRepreflightRecovery)
    setSelectedShotIds([shot.shotId])
    setReferenceControlMode('smart')
    setPreflight(null)
    setAttempt(null)
    setSubmittedCount(null)
    setPreflightAuthorityFingerprint(null)
    setManualRecoveryByShot((current) => {
      const next = { ...current }
      delete next[shot.shotId]
      return next
    })
    setManualSlotChoices((current) => {
      const next = { ...current }
      delete next[shot.shotId]
      return next
    })
    // Timing recovery detaches only this shot from its free visual Job. The
    // durable Job may still finish in Task Center; other shot results remain
    // usable and no Provider call is cancelled or repeated.
    const visualShotKey = shotVideoVisualAnalysisShotKey(shot)
    setVisualAnalysisBindingByShotKey((current) => {
      if (!current[visualShotKey]) return current
      const next = { ...current }
      delete next[visualShotKey]
      return next
    })
    setError('')
  }, [
    availableShots,
    blockedShotReasons,
    episodeId,
    open,
    projectId,
    sourceRevisionId,
    timingRepreflightRecovery,
  ])

  useEffect(() => {
    attemptsRef.current.clear()
    visualAnalysisSubmissionRef.current.clear()
    setPreflight(null)
    setAttempt(null)
    setPreflightAuthorityFingerprint(null)
    setManualRecoveryByShot({})
    setManualSlotChoices({})
    setReferenceCompatibilityIssues([])
    setReferenceCompatibilityOverrides({})
    setVisualAnalysisJobsById({})
    setVisualAnalysisBindingByShotKey({})
    setVisualAnalysisHydrating(false)
    setVisualAnalysisHydrationError('')
    setVisualAnalysisHydrationRevision(0)
  }, [episodeId, projectId, sourceRevisionId])

  useEffect(() => {
    if (!open || submittedCount !== null) return
    const blockedSelection = selectedShotIds.some((shotId) => (
      Boolean(blockedShotReasons[shotId])
      || availableShots.find((shot) => shot.shotId === shotId)?.videoState === 'locked'
    ))
    if (!blockedSelection) return
    setSelectedShotIds((current) => current.filter((shotId) => (
      !blockedShotReasons[shotId]
      && availableShots.find((shot) => shot.shotId === shotId)?.videoState !== 'locked'
    )))
    setPreflight(null)
    setAttempt(null)
    setError('镜头任务状态已变更，已移除不可重复建单的镜头')
  }, [availableShots, blockedShotReasons, open, selectedShotIds, submittedCount])

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    const backdrop = backdropRef.current
    const host = backdrop?.parentElement
    if (!dialog || !backdrop || !host) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const siblings = Array.from(host.children).filter((element): element is HTMLElement => (
      element instanceof HTMLElement && element !== backdrop
    ))
    const siblingState = siblings.map((element) => ({
      element,
      inert: element.hasAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden'),
    }))
    for (const { element } of siblingState) {
      element.setAttribute('inert', '')
      element.setAttribute('aria-hidden', 'true')
    }
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && referencePreviewRef.current) {
        event.preventDefault()
        setReferencePreview(null)
        return
      }
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
      if (!focusable.length) {
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
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      for (const state of siblingState) {
        if (!state.inert) state.element.removeAttribute('inert')
        if (state.ariaHidden === null) state.element.removeAttribute('aria-hidden')
        else state.element.setAttribute('aria-hidden', state.ariaHidden)
      }
      previousFocus?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open || !preflight) return
    const timer = window.setInterval(() => {
      if (Date.parse(preflight.expiresAt) <= Date.now()) setPreflight(null)
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [open, preflight])

  const selectedShots = useMemo(() => availableShots.filter((shot) => (
    selectedShotIds.includes(shot.shotId)
    && !blockedShotReasons[shot.shotId]
    && shot.videoState !== 'locked'
  )), [availableShots, blockedShotReasons, selectedShotIds])
  const visualAnalysisTargets = useMemo(() => shotVideoVisualAnalysisTargets(
    selectedShots,
    new Set(Object.keys(manualRecoveryByShot)),
  ), [manualRecoveryByShot, selectedShots])
  const visualAnalysisTargetsAreAmbiguous = visualAnalysisTargets.length > 0
    && visualAnalysisTargets.every((shot) => Boolean(manualRecoveryByShot[shot.shotId]))
  const visualAnalysisAuthorityFor = useMemo(() => (
    selectors: readonly { shotId: string; sceneId?: string }[],
  ): string | null => {
    if (selectors.length < 1 || selectors.some((selector) => !selector.sceneId)) return null
    return shotVideoVisualAnalysisAuthorityKey({
      sourceRevisionId,
      selections: selectors.map((selector) => ({
        shotId: selector.shotId,
        sceneId: selector.sceneId!,
      })),
      assets: eligibleAssets.map((asset) => ({
        id: asset.id,
        version: asset.version,
        checksum: asset.checksum,
      })),
      textProviderId,
      textProviderConfigRevision,
      textProviderModel,
      textProviderReady,
    })
  }, [
    eligibleAssets,
    sourceRevisionId,
    textProviderConfigRevision,
    textProviderId,
    textProviderModel,
    textProviderReady,
  ])

  useEffect(() => {
    if (!open) return
    if (!textProviderReady
      || !textProviderId
      || !textProviderConfigRevision
      || !textProviderModel) {
      setVisualAnalysisHydrating(false)
      setVisualAnalysisHydrationError('')
      return
    }
    const controller = new AbortController()
    let disposed = false
    setVisualAnalysisHydrating(true)
    setVisualAnalysisHydrationError('')
    void api.listShotVideoVisualReferenceAnalyses(episodeId, {
      projectId,
      sourceRevisionId,
      textProviderId,
    }, { signal: controller.signal }).then((analyses) => {
      if (disposed) return
      const availableShotKeys = new Set(availableShots.map(shotVideoVisualAnalysisShotKey))
      const newestByShotKey = new Map<string, typeof analyses[number]>()
      for (const analysis of analyses) {
        const shotKey = shotVideoVisualAnalysisShotKey(analysis)
        if (!availableShotKeys.has(shotKey)
          || analysis.job.input.selectors.length !== 1
          || analysis.job.input.selectors[0]?.shotId !== analysis.shotId
          || analysis.job.input.selectors[0]?.sceneId !== analysis.sceneId
          || analysis.job.providerConfigRevision !== textProviderConfigRevision
          || analysis.job.model !== textProviderModel
          || !restoredVisualAnalysisAuthorityIsCurrent(analysis.authority)) continue
        const previous = newestByShotKey.get(shotKey)
        if (!previous
          || Date.parse(analysis.job.updatedAt) > Date.parse(previous.job.updatedAt)
          || (analysis.job.updatedAt === previous.job.updatedAt
            && analysis.job.id.localeCompare(previous.job.id) > 0)) {
          newestByShotKey.set(shotKey, analysis)
        }
      }
      const restored = [...newestByShotKey.entries()].flatMap(([shotKey, analysis]) => {
        const requestAuthorityKey = visualAnalysisAuthorityFor(analysis.job.input.selectors)
        return requestAuthorityKey ? [{
          shotKey,
          job: analysis.job,
          binding: {
            jobId: analysis.job.id,
            requestAuthorityKey,
            selectors: [{ shotId: analysis.shotId, sceneId: analysis.sceneId }],
            starting: false,
            error: '',
            serverAuthority: analysis.authority,
          } satisfies VisualAnalysisBinding,
        }] : []
      })
      setVisualAnalysisJobsById((current) => {
        const updated = { ...current }
        for (const { job } of restored) {
          const existing = current[job.id]
          if (!existing || Date.parse(job.updatedAt) >= Date.parse(existing.updatedAt)) {
            updated[job.id] = job
          }
        }
        return updated
      })
      setVisualAnalysisBindingByShotKey((current) => {
        // A successful authority snapshot replaces every acknowledged binding
        // in this scope. Preserve only an in-flight/unknown local POST lease;
        // it is the information required for an exact idempotent replay.
        const updated = Object.fromEntries(Object.entries(current).filter(([, binding]) => (
          binding.starting || (!binding.jobId && Boolean(binding.error))
        ))) as Record<string, VisualAnalysisBinding>
        for (const { shotKey, binding } of restored) {
          const existing = current[shotKey]
          if (existing?.starting) continue
          updated[shotKey] = binding
        }
        return updated
      })
    }).catch((reason: unknown) => {
      if (disposed || controller.signal.aborted) return
      setVisualAnalysisHydrationError(
        `${reason instanceof Error ? reason.message : '持久视觉任务恢复失败'}；本次只读恢复未调用模型。`,
      )
    }).finally(() => {
      if (!disposed) setVisualAnalysisHydrating(false)
    })
    return () => {
      disposed = true
      controller.abort()
    }
  }, [
    availableShots,
    episodeId,
    open,
    projectId,
    sourceRevisionId,
    textProviderConfigRevision,
    textProviderId,
    textProviderModel,
    textProviderReady,
    visualAnalysisAuthorityFor,
    visualAnalysisHydrationRevision,
  ])

  const validVisualAnalysisByShotKey = useMemo(() => {
    const valid = new Map<string, {
      jobId: string
      job: ShotVideoVisualReferenceAnalysisJob
      plan: NonNullable<ShotVideoVisualReferenceAnalysisJob['output']>['analysis']['plans'][number]
    }>()
    for (const shot of availableShots) {
      const shotKey = shotVideoVisualAnalysisShotKey(shot)
      const binding = visualAnalysisBindingByShotKey[shotKey]
      const job = binding?.jobId ? visualAnalysisJobsById[binding.jobId] : null
      if (!binding || !job) continue
      const currentAuthorityKey = visualAnalysisAuthorityFor(job.input.selectors)
      const jobId = currentAuthorityKey ? validShotVideoVisualAnalysisJobId({
        jobId: job.id,
        jobStatus: job.status,
        jobAuthorityKey: binding.requestAuthorityKey,
        currentAuthorityKey,
      }) : null
      const plan = job.output?.analysis.plans.find((candidate) => (
        candidate.shotId === shot.shotId && candidate.sceneId === shot.sceneId
      ))
      if (jobId && plan && restoredVisualAnalysisAuthorityIsCurrent(binding.serverAuthority)) {
        valid.set(shotKey, { jobId, job, plan })
      }
    }
    return valid
  }, [availableShots, visualAnalysisAuthorityFor, visualAnalysisBindingByShotKey, visualAnalysisJobsById])

  const activeVisualAnalysisJobIds = useMemo(() => {
    const ids = new Set<string>()
    for (const binding of Object.values(visualAnalysisBindingByShotKey)) {
      if (!binding.jobId) continue
      const job = visualAnalysisJobsById[binding.jobId]
      if (!job || !activeVisualAnalysisStatuses.has(job.status)) continue
      if (visualAnalysisAuthorityFor(job.input.selectors) !== binding.requestAuthorityKey
        || !restoredVisualAnalysisAuthorityIsCurrent(binding.serverAuthority)) continue
      ids.add(job.id)
    }
    return [...ids].sort()
  }, [visualAnalysisAuthorityFor, visualAnalysisBindingByShotKey, visualAnalysisJobsById])

  const selectedVisualAnalysisActive = selectedShots.some((shot) => {
    if (manualSlotChoices[shot.shotId]) return false
    const binding = visualAnalysisBindingByShotKey[shotVideoVisualAnalysisShotKey(shot)]
    if (!binding) return false
    const currentAuthorityKey = visualAnalysisAuthorityFor(
      binding.jobId
        ? visualAnalysisJobsById[binding.jobId]?.input.selectors ?? binding.selectors
        : binding.selectors,
    )
    if (currentAuthorityKey !== binding.requestAuthorityKey
      || !restoredVisualAnalysisAuthorityIsCurrent(binding.serverAuthority)) return false
    if (binding.starting) return true
    const job = binding.jobId ? visualAnalysisJobsById[binding.jobId] : null
    return Boolean(job && activeVisualAnalysisStatuses.has(job.status))
  })
  const visualAnalysisBlocksPreflight = shotVideoVisualAnalysisBlocksPreflight(
    referenceControlMode,
    selectedVisualAnalysisActive || visualAnalysisHydrating || Boolean(visualAnalysisHydrationError),
  )
  const batchVisualAnalysisSummary = useMemo(() => {
    const unknownBatch = Object.values(visualAnalysisBindingByShotKey).find((binding) => (
      !binding.jobId && Boolean(binding.error) && binding.selectors.length > 1
    ))
    if (unknownBatch) {
      const exactReplay = unknownBatch.selectors.flatMap((selector) => {
        const shot = availableShots.find((candidate) => (
          candidate.shotId === selector.shotId && candidate.sceneId === selector.sceneId
        ))
        return shot && !blockedShotReasons[shot.shotId] && shot.videoState !== 'locked' ? [shot] : []
      })
      return {
        retryable: exactReplay.length === unknownBatch.selectors.length ? exactReplay : [],
        running: 0,
        completed: 0,
        total: unknownBatch.selectors.length,
        unknownReplay: true,
      }
    }
    const retryable: ShotVideoBatchShot[] = []
    let running = 0
    let completed = 0
    for (const shot of visualAnalysisTargets) {
      const shotKey = shotVideoVisualAnalysisShotKey(shot)
      if (validVisualAnalysisByShotKey.has(shotKey)) {
        completed += 1
        continue
      }
      const binding = visualAnalysisBindingByShotKey[shotKey]
      const job = binding?.jobId ? visualAnalysisJobsById[binding.jobId] : null
      const currentAuthorityKey = binding ? visualAnalysisAuthorityFor(
        job?.input.selectors ?? binding.selectors,
      ) : null
      if (binding
        && currentAuthorityKey === binding.requestAuthorityKey
        && restoredVisualAnalysisAuthorityIsCurrent(binding.serverAuthority)
        && (binding.starting || (job && activeVisualAnalysisStatuses.has(job.status)))) {
        running += 1
        continue
      }
      retryable.push(shot)
    }
    return {
      retryable,
      running,
      completed,
      total: visualAnalysisTargets.length,
      unknownReplay: false,
    }
  }, [availableShots, blockedShotReasons, validVisualAnalysisByShotKey, visualAnalysisAuthorityFor, visualAnalysisBindingByShotKey, visualAnalysisJobsById, visualAnalysisTargets])

  useEffect(() => {
    if (!open || activeVisualAnalysisJobIds.length < 1) return
    let disposed = false
    const timers = new Map<string, number>()
    const poll = async (jobId: string) => {
      try {
        const next = await api.getShotVideoVisualReferenceAnalysisJob(jobId)
        if (disposed) return
        setVisualAnalysisJobsById((current) => (
          current[jobId]?.id === jobId ? { ...current, [jobId]: next } : current
        ))
        setVisualAnalysisBindingByShotKey((current) => {
          let changed = false
          const updated = { ...current }
          for (const [shotKey, binding] of Object.entries(current)) {
            if (binding.jobId !== jobId || !binding.error) continue
            updated[shotKey] = { ...binding, error: '' }
            changed = true
          }
          return changed ? updated : current
        })
        if (activeVisualAnalysisStatuses.has(next.status)) {
          timers.set(jobId, window.setTimeout(() => void poll(jobId), 1_200))
        }
      } catch (reason) {
        if (disposed) return
        const message = `${reason instanceof Error ? reason.message : '读取视觉分析任务失败'}；仅继续读取持久任务，不会自动重提模型调用。`
        setVisualAnalysisBindingByShotKey((current) => {
          let changed = false
          const updated = { ...current }
          for (const [shotKey, binding] of Object.entries(current)) {
            if (binding.jobId !== jobId || binding.error === message) continue
            updated[shotKey] = { ...binding, error: message }
            changed = true
          }
          return changed ? updated : current
        })
        timers.set(jobId, window.setTimeout(() => void poll(jobId), 2_000))
      }
    }
    for (const jobId of activeVisualAnalysisJobIds) {
      timers.set(jobId, window.setTimeout(() => void poll(jobId), 700))
    }
    return () => {
      disposed = true
      for (const timer of timers.values()) window.clearTimeout(timer)
    }
  }, [activeVisualAnalysisJobIds.join('\u0000'), open])

  const prepared = useMemo(() => {
    const issues: string[] = []
    const selections: ShotVideoBatchPreflightInput['selections'] = []
    if (selectedShots.length < 1) issues.push('至少选择 1 个镜头')
    if (selectedShots.length > 24) issues.push('单次最多生成 24 个镜头')
    for (const shot of selectedShots) {
      if (referenceControlMode === 'smart') {
        const compatibilityOverride = referenceCompatibilityOverrides[shot.shotId]
        if (compatibilityOverride) {
          const references = wholeTurnaroundCompatibilityRecoveryReferences({
            storyboardAssetId: shot.assetId,
            turnaroundAssetId: compatibilityOverride,
          }, eligibleIds)
          if (references.length < 1) {
            issues.push(`${shot.code}：三视图整图替代资产已失效，请重新预检`)
          } else {
            selections.push({
              shotId: shot.shotId,
              sceneId: shot.sceneId,
              references,
            })
          }
          continue
        }
        const visualResult = validVisualAnalysisByShotKey.get(shotVideoVisualAnalysisShotKey(shot))
        const recovery = manualRecoveryByShot[shot.shotId]
        const manualChoice = manualSlotChoices[shot.shotId]
        const visualPlan = visualResult?.plan
        if (recovery && manualChoice) {
          const selectors = manualChoice?.textOnly
            ? null
            : manualChoice
              ? selectorsForManualSlotChoices(recovery, manualChoice.views)
              : null
          if (manualChoice && !manualChoice.textOnly && !selectors) {
            issues.push(`${shot.code}：每个角色都必须选择一个已锁定视角`)
          }
          if (manualChoice && (manualChoice.textOnly || selectors)) {
            selections.push({
              shotId: shot.shotId,
              sceneId: shot.sceneId,
              ...(manualChoice.textOnly
                ? { references: [] }
                : { characterReferenceSelections: selectors ?? [] }),
            })
          }
          continue
        }
        if (visualResult?.jobId && visualPlan?.status === 'recommended') {
          selections.push({
            shotId: shot.shotId,
            sceneId: shot.sceneId,
            referenceAnalysisJobId: visualResult.jobId,
          })
          continue
        }
        if (recovery) {
          issues.push(`${shot.code}：请明确选择角色正/侧/背槽位、选择纯文本，或对歧义镜头运行深度视觉分析`)
          continue
        }
        if (visualResult?.jobId && visualPlan?.status === 'manual_required') {
          issues.push(`${shot.code}：深度视觉分析要求人工确认；请先运行快速预检加载真实角色槽位`)
          continue
        }
        // Omission is an explicit contract: the server resolves this shot's
        // own storyboard anchor plus current locked character-view slots. It
        // never receives a neighbouring shot and signs the final selection in
        // preflight. Any `references` property would instead mean user/manual.
        selections.push({
          shotId: shot.shotId,
          sceneId: shot.sceneId,
        })
        continue
      }
      const draft = drafts[shot.shotId] ?? initialDraft(shot, eligibleIds)
      let result
      if (draft.mode === 'text-to-video') {
        result = referencesFromShotVideoDraft({ mode: 'text-to-video' }, eligibleIds)
      } else if (draft.mode === 'multi-reference') {
        result = referencesFromShotVideoDraft({
          mode: 'multi-reference',
          assetIds: draft.referenceAssetIds,
        }, eligibleIds)
      } else {
        result = referencesFromShotVideoDraft({
          mode: 'frames',
          firstFrameAssetId: draft.firstFrameAssetId || null,
          lastFrameAssetId: draft.mode === 'first-last-frame' ? draft.lastFrameAssetId || null : null,
        }, eligibleIds)
        if (draft.mode === 'first-last-frame' && !draft.lastFrameAssetId) {
          result.issues.push('首尾帧模式必须选择尾帧')
        }
      }
      issues.push(...result.issues.map((issue) => `${shot.code}：${issue}`))
      selections.push({
        shotId: shot.shotId,
        sceneId: shot.sceneId,
        // Presence, including [], is the explicit manual override marker.
        references: result.references,
      })
    }
    const input: ShotVideoBatchPreflightInput = {
      projectId,
      ...(providerId ? { providerId } : {}),
      resolution,
      promptCompilerVersion,
      publicationMode,
      audioPolicy,
      selections,
    }
    return { input, issues }
  }, [audioPolicy, drafts, eligibleIds, manualRecoveryByShot, manualSlotChoices, projectId, promptCompilerVersion, providerId, publicationMode, referenceCompatibilityOverrides, referenceControlMode, resolution, selectedShots, validVisualAnalysisByShotKey])

  const validPreflight = prepared.issues.length === 0
    && preflightAuthorityFingerprint === authorityFingerprint
    && preflight?.provider.configRevision === providerConfigRevision
    && preflight?.provider.model === providerModel
    && shotVideoBatchPreflightMatches(
    preflight,
    episodeId,
    sourceRevisionId,
    prepared.input,
  ) ? preflight : null
  const busy = preflighting || submitting || refreshingAssetLibrary
  const locked = busy || submittedCount !== null
  busyRef.current = busy

  const invalidate = () => {
    setPreflight(null)
    setAttempt(null)
    setSubmittedCount(null)
    setPreflightAuthorityFingerprint(null)
    setError('')
    setReferenceCompatibilityIssues([])
  }

  const toggleShot = (shotId: string) => {
    if (locked
      || blockedShotReasons[shotId]
      || availableShots.find((shot) => shot.shotId === shotId)?.videoState === 'locked') return
    invalidate()
    setSelectedShotIds((current) => current.includes(shotId)
      ? current.filter((id) => id !== shotId)
      : [...current, shotId])
  }

  const updateDraft = (shotId: string, patch: Partial<ReferenceDraft>) => {
    if (locked || blockedShotReasons[shotId]) return
    invalidate()
    const shot = availableShots.find((candidate) => candidate.shotId === shotId)
    if (!shot) return
    setDrafts((current) => ({
      ...current,
      [shotId]: { ...(current[shotId] ?? initialDraft(shot, eligibleIds)), ...patch },
    }))
  }

  const changeReferenceControlMode = (mode: ReferenceControlMode) => {
    if (locked || mode === referenceControlMode) return
    invalidate()
    setReferenceControlMode(mode)
    if (mode === 'smart') {
      setDrafts(Object.fromEntries(availableShots.map((shot) => [shot.shotId, initialDraft(shot, eligibleIds)])))
    }
  }

  const refreshAssetLibrary = async () => {
    if (busy) return
    setRefreshingAssetLibrary(true)
    setError('')
    try {
      await onRefreshAssets()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '素材库刷新失败，请稍后重试')
    } finally {
      setRefreshingAssetLibrary(false)
    }
  }

  const runVisualReferenceAnalysis = async (requestedShots: readonly ShotVideoBatchShot[]) => {
    const targets = [...new Map(requestedShots.map((shot) => (
      [shotVideoVisualAnalysisShotKey(shot), shot] as const
    ))).values()].filter((shot) => (
      !blockedShotReasons[shot.shotId] && shot.videoState !== 'locked'
    ))
    if (busy
      || visualAnalysisHydrating
      || Boolean(visualAnalysisHydrationError)
      || targets.length < 1
      || !textProviderReady
      || !textProviderId
      || !textProviderConfigRevision
      || !textProviderModel) return
    const selectors = targets.map((shot) => ({
      shotId: shot.shotId,
      sceneId: shot.sceneId,
    }))
    const requestedAuthorityKey = visualAnalysisAuthorityFor(selectors)
    if (!requestedAuthorityKey) return
    const currentlyActive = targets.some((shot) => {
      const binding = visualAnalysisBindingByShotKey[shotVideoVisualAnalysisShotKey(shot)]
      if (!binding) return false
      const boundJob = binding.jobId ? visualAnalysisJobsById[binding.jobId] : null
      if (visualAnalysisAuthorityFor(boundJob?.input.selectors ?? binding.selectors)
        !== binding.requestAuthorityKey
        || !restoredVisualAnalysisAuthorityIsCurrent(binding.serverAuthority)) return false
      if (binding.starting) return true
      return Boolean(boundJob && activeVisualAnalysisStatuses.has(boundJob.status))
    })
    if (currentlyActive) return
    const previousSubmission = visualAnalysisSubmissionRef.current.get(requestedAuthorityKey)
    const idempotencyKey = previousSubmission
      && !previousSubmission.jobReceived
      ? previousSubmission.idempotencyKey
      : crypto.randomUUID()
    visualAnalysisSubmissionRef.current.set(requestedAuthorityKey, {
      idempotencyKey,
      jobReceived: false,
    })
    invalidate()
    setVisualAnalysisBindingByShotKey((current) => ({
      ...current,
      ...Object.fromEntries(targets.map((shot) => [
        shotVideoVisualAnalysisShotKey(shot),
        {
          jobId: null,
          requestAuthorityKey: requestedAuthorityKey,
          selectors,
          starting: true,
          error: '',
        } satisfies VisualAnalysisBinding,
      ])),
    }))
    try {
      const request = { projectId, textProviderId, selections: selectors }
      const jobs = targets.length === 1
        ? [await api.createShotVideoVisualReferenceAnalysis(
            episodeId,
            request,
            idempotencyKey,
          )]
        : (await api.createShotVideoVisualReferenceAnalysisBatch(
            episodeId,
            request,
            idempotencyKey,
          )).jobs
      visualAnalysisSubmissionRef.current.set(requestedAuthorityKey, {
        idempotencyKey,
        jobReceived: true,
      })
      setVisualAnalysisJobsById((current) => ({
        ...current,
        ...Object.fromEntries(jobs.map((job) => [job.id, job])),
      }))
      setVisualAnalysisBindingByShotKey((current) => {
        let changed = false
        const updated = { ...current }
        for (const [index, shot] of targets.entries()) {
          const shotKey = shotVideoVisualAnalysisShotKey(shot)
          const binding = current[shotKey]
          const job = jobs[index]
          const childAuthorityKey = job
            ? visualAnalysisAuthorityFor(job.input.selectors)
            : null
          if (!binding
            || binding.requestAuthorityKey !== requestedAuthorityKey
            || !binding.starting
            || !job
            || !childAuthorityKey) continue
          updated[shotKey] = {
            jobId: job.id,
            requestAuthorityKey: childAuthorityKey,
            selectors: job.input.selectors.map((selector) => ({
              shotId: selector.shotId,
              sceneId: selector.sceneId!,
            })),
            starting: false,
            error: '',
          }
          changed = true
        }
        return changed ? updated : current
      })
    } catch (reason) {
      // Keep the exact idempotency key for an explicit user replay after an
      // ambiguous POST. Never start a second task from an effect or timer.
      const message = `${reason instanceof Error ? reason.message : '视觉分析任务创建失败'}；不会自动重提，请核对后主动重试。`
      setVisualAnalysisBindingByShotKey((current) => {
        let changed = false
        const updated = { ...current }
        for (const shot of targets) {
          const shotKey = shotVideoVisualAnalysisShotKey(shot)
          const binding = current[shotKey]
          if (!binding
            || binding.requestAuthorityKey !== requestedAuthorityKey
            || !binding.starting) continue
          updated[shotKey] = { ...binding, starting: false, error: message }
          changed = true
        }
        return changed ? updated : current
      })
    }
  }

  const useFastReferenceRecommendation = (shot: ShotVideoBatchShot) => {
    const shotKey = shotVideoVisualAnalysisShotKey(shot)
    const binding = visualAnalysisBindingByShotKey[shotKey]
    if (binding?.starting) return
    invalidate()
    // Detach only this shot. A shared batch Job and every other completed shot
    // remain bound; the durable task may still finish in Task Center.
    setVisualAnalysisBindingByShotKey((current) => {
      if (!current[shotKey]) return current
      const updated = { ...current }
      delete updated[shotKey]
      return updated
    })
  }

  const runPreflight = async () => {
    if (busy || visualAnalysisBlocksPreflight || prepared.issues.length) return
    const nextAttempt = prepareShotVideoBatchAttempt(
      attemptsRef.current,
      episodeId,
      prepared.input,
      () => crypto.randomUUID(),
    )
    setAttempt(nextAttempt)
    setPreflighting(true)
    setPreflight(null)
    setSubmittedCount(null)
    setError('')
    setReferenceCompatibilityIssues([])
    try {
      const result = await api.preflightShotVideoBatch(
        episodeId,
        prepared.input,
        nextAttempt.idempotencyKey,
      )
      setPreflight(result)
      setReferenceCompatibilityIssues([])
      setPreflightAuthorityFingerprint(authorityFingerprint)
      if (timingRepreflightRecovery
        && result.targets.length === 1
        && result.targets[0]?.shotId === timingRepreflightRecovery.shotId
        && result.targets[0]?.sceneId === timingRepreflightRecovery.sceneId) {
        onTimingRepreflightCompleted?.(timingRepreflightRecovery)
      }
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'VIDEO_REFERENCE_ASSET_INCOMPATIBLE') {
        const issues = parseShotVideoReferenceCompatibilityIssues(reason.details)
          .filter((issue) => availableShots.some((shot) => (
            shot.shotId === issue.shotId
            && (issue.sceneId === null || shot.sceneId === issue.sceneId)
          )))
        if (issues.length > 0) {
          setReferenceCompatibilityIssues(issues)
          setError('')
          return
        }
      }
      if (reason instanceof ApiError && reason.code === 'VIDEO_REFERENCE_SELECTION_REQUIRED') {
        const recoveries = parseShotVideoManualReferenceRecoveries(reason.details)
          .filter((recovery) => recovery.sourceRevisionId === sourceRevisionId)
        if (recoveries.length > 0) {
          setManualRecoveryByShot((current) => ({
            ...current,
            ...Object.fromEntries(recoveries.map((recovery) => [recovery.shotId, recovery])),
          }))
          // This is a recoverable free-preflight result, not a terminal
          // failure. The per-shot cards below are the actionable UI; keeping
          // the raw 409 conflict in the paid-confirmation column made users
          // think the batch was still blocked after recovery had loaded.
          setError('')
          return
        }
      }
      setError(reason instanceof Error ? reason.message : 'Seedance 预检失败')
    } finally {
      setPreflighting(false)
    }
  }

  const submit = async () => {
    if (busy || !validPreflight || !attempt) return
    const confirmed = confirmedShotVideoBatchInput(
      validPreflight,
      episodeId,
      sourceRevisionId,
      prepared.input,
    )
    if (!confirmed) {
      setPreflight(null)
      setError('预检已过期或生成范围已改变，请重新预检')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const jobs = await api.createShotVideoBatch(
        episodeId,
        confirmed,
        attempt.idempotencyKey,
      )
      completeShotVideoBatchAttempt(attemptsRef.current, attempt)
      setSubmittedCount(jobs.length)
      setPreflight(null)
      setAttempt(null)
      setPreflightAuthorityFingerprint(null)
      await onSubmitted(jobs)
    } catch (reason) {
      // Keep the exact root key and confirmation after ambiguous POST results.
      // A rejected stale/expired capability is safe to discard and re-preflight.
      if (reason instanceof ApiError
        && ['VIDEO_BATCH_PREFLIGHT_EXPIRED', 'VIDEO_BATCH_PREFLIGHT_CHANGED'].includes(reason.code)) {
        setPreflight(null)
        setPreflightAuthorityFingerprint(null)
      }
      setError(reason instanceof Error ? reason.message : 'Seedance 批量建单失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div ref={backdropRef} className="shot-video-batch-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="shot-video-batch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shot-video-batch-title"
        aria-describedby="shot-video-batch-description"
        aria-busy={busy}
        tabIndex={-1}
      >
        <header className="shot-video-batch-header">
          <div>
            <span><Film size={18} /></span>
            <div>
              <small>SEEDANCE 2.0 · 付费任务门禁</small>
              <h2 id="shot-video-batch-title">逐镜视频批量生成</h2>
              <p id="shot-video-batch-description">待生成 {availabilitySummary.pending} 镜 · 已生成 {availabilitySummary.generated} 镜 · 安全锁定 {availabilitySummary.locked} 镜；先做不计费预检，再显式确认建单。</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭 Seedance 批量生成">
            <X size={18} />
          </button>
        </header>

        <div className="shot-video-batch-body">
          <section className="shot-video-batch-scope">
            <div className="shot-video-batch-section-title">
              <div><strong>生成范围</strong><small>{selectedShots.length} / {availableShots.length} 镜</small></div>
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  invalidate()
                  const selectable = availableShots.filter((shot) => (
                    !blockedShotReasons[shot.shotId] && shot.videoState !== 'locked'
                  ))
                  setSelectedShotIds(selectedShotIds.length === selectable.length ? [] : selectable.map((shot) => shot.shotId))
                }}
              >
                {selectedShotIds.length === availableShots.filter((shot) => (
                  !blockedShotReasons[shot.shotId] && shot.videoState !== 'locked'
                )).length ? '全部取消' : '全选可生成镜头'}
              </button>
            </div>
            <div className="shot-video-batch-availability" aria-label="逐镜视频状态汇总">
              <span className="pending">待生成 <b>{availabilitySummary.pending}</b></span>
              <span className="generated">已生成 <b>{availabilitySummary.generated}</b></span>
              <span className="locked">安全锁定 <b>{availabilitySummary.locked}</b></span>
              <small>已生成镜头默认不选；勾选后会显式创建新版本。</small>
            </div>
            <div className="shot-video-reference-control" role="group" aria-label="参考图选择方式">
              <button
                type="button"
                className={referenceControlMode === 'smart' ? 'active' : ''}
                aria-pressed={referenceControlMode === 'smart'}
                disabled={locked}
                onClick={() => changeReferenceControlMode('smart')}
              >
                <Sparkles size={14} />
                <span><strong>快速智能推荐（默认）</strong><small>立即做确定性预检；只把歧义镜头交给视觉 Agent</small></span>
              </button>
              <button
                type="button"
                className={referenceControlMode === 'manual' ? 'active' : ''}
                aria-pressed={referenceControlMode === 'manual'}
                disabled={locked}
                onClick={() => changeReferenceControlMode('manual')}
              >
                <Settings2 size={14} />
                <span>
                  <strong>通用素材高级覆盖</strong>
                  <small>道具 / 场景 / 同镜帧 · 不作为角色三视图审计</small>
                </span>
              </button>
            </div>
            <p className="shot-video-smart-policy">
              音频先行：有台词/旁白的镜头会以已落盘语音的实测长度决定剪辑点；短于 4 秒只生成最短源片后裁剪，不变速，超过 15 秒则先要求拆镜。默认快速预检只绑定当前镜分镜及可验证槽位，绝不会读取下一镜当尾帧；只有预检判为歧义的镜头才需要深度视觉分析。
            </p>
            {referenceControlMode === 'smart' && (visualAnalysisHydrating || visualAnalysisHydrationError) && (
              <div className={`shot-video-recovery-summary ${visualAnalysisHydrationError ? 'warning' : ''}`} role="status">
                {visualAnalysisHydrating
                  ? <LoaderCircle size={14} className="spin" />
                  : <AlertTriangle size={14} />}
                <span>{visualAnalysisHydrating
                  ? '正在只读恢复当前修订的持久视觉任务；不会调用模型或 Seedance。'
                  : `${visualAnalysisHydrationError} 为避免重复创建视觉任务，恢复成功前不会分析或预检。`}</span>
                {visualAnalysisHydrationError && <button
                  type="button"
                  onClick={() => setVisualAnalysisHydrationRevision((current) => current + 1)}
                >重试恢复</button>}
              </div>
            )}
            {timingRepreflightRecovery && (
              <div className="shot-video-recovery-summary" role="status">
                <ShieldCheck size={14} />
                <span>
                  音频时长恢复仅定位镜头 {availableShots.find((shot) => (
                    shot.shotId === timingRepreflightRecovery.shotId
                    && shot.sceneId === timingRepreflightRecovery.sceneId
                  ))?.code ?? timingRepreflightRecovery.shotId}；已清除这个单镜范围的旧本地建单键。
                  {timingRepreflightRecovery.providerSubmissionState === 'task-exists'
                    ? ' 原 Provider task 已存在；新视频仍需重新预检并由你明确确认。'
                    : ' 原请求尚未创建 Provider task。'}
                  系统不会自动预检或提交 Seedance。
                </span>
              </div>
            )}
            {referenceControlMode === 'smart'
              && (visualAnalysisTargetsAreAmbiguous || batchVisualAnalysisSummary.unknownReplay) && (
              <section className="shot-video-visual-agent" aria-label="批量分析预检歧义镜头" aria-live="polite">
                <header>
                  <div><Sparkles size={15} /><span><strong>批量处理预检歧义</strong><small>一次显式创建持久视觉任务；每个镜头仍在自己的卡片显示状态与结果</small></span></div>
                  <span className="free">项目规则：LLM / Agentic 免费</span>
                </header>
                <div className="shot-video-visual-agent-status">
                  {!textProviderReady || !textProviderId || !textProviderConfigRevision || !textProviderModel ? (
                    <p className="warning"><AlertTriangle size={13} />请先配置并测试支持视觉输入的文本 Provider；不会降级成文本猜图。</p>
                  ) : (
                    <p><ShieldCheck size={13} />{batchVisualAnalysisSummary.unknownReplay
                      ? `上次 ${batchVisualAnalysisSummary.total} 镜批量提交结果未知；只允许复用原范围和原 Idempotency-Key 核对，不会拆成单镜重提。`
                      : `共 ${batchVisualAnalysisSummary.total} 个歧义镜头：已完成 ${batchVisualAnalysisSummary.completed}，运行中 ${batchVisualAnalysisSummary.running}，待分析 / 可安全重试 ${batchVisualAnalysisSummary.retryable.length}。`}</p>
                  )}
                </div>
                <footer>
                  <div className="shot-video-visual-agent-actions">
                    <button
                      type="button"
                      disabled={busy
                        || visualAnalysisHydrating
                        || Boolean(visualAnalysisHydrationError)
                        || batchVisualAnalysisSummary.retryable.length < 1
                        || !textProviderReady
                        || !textProviderId
                        || !textProviderConfigRevision
                        || !textProviderModel}
                      onClick={() => void runVisualReferenceAnalysis(batchVisualAnalysisSummary.retryable)}
                    >
                      {batchVisualAnalysisSummary.running > 0
                        ? <LoaderCircle size={13} className="spin" />
                        : <Sparkles size={13} />}
                      {batchVisualAnalysisSummary.retryable.length > 0
                        ? batchVisualAnalysisSummary.unknownReplay
                          ? `核对原 ${batchVisualAnalysisSummary.retryable.length} 镜批次`
                          : `批量分析 ${batchVisualAnalysisSummary.retryable.length} 个歧义镜头`
                        : batchVisualAnalysisSummary.running > 0 ? '批量分析运行中' : '歧义镜头已处理'}
                    </button>
                  </div>
                  <small>打开弹窗和快速预检都不会调用视觉模型；只有点击本按钮或卡片内“视觉分析此镜”才调用免费多模态能力。Seedance 仍须另行确认付费。</small>
                </footer>
              </section>
            )}
            {referenceControlMode === 'smart' && selectedShots.filter((shot) => manualRecoveryByShot[shot.shotId]).length > 1 && (
              <div className="shot-video-recovery-summary" role="status">
                <ShieldCheck size={14} />
                <span>已一次汇总 {selectedShots.filter((shot) => manualRecoveryByShot[shot.shotId]).length} 个待确认镜头；可在下方逐镜处理后统一重新预检。</span>
              </div>
            )}
            <div className="shot-video-batch-shot-list">
              {availableShots.map((shot) => {
                const selected = selectedShotIds.includes(shot.shotId)
                const draft = drafts[shot.shotId] ?? initialDraft(shot, eligibleIds)
                const blockedReason = blockedShotReasons[shot.shotId]
                const effectivelyLocked = Boolean(blockedReason) || shot.videoState === 'locked'
                const videoStateLabel = shot.videoState === 'generated'
                  ? '已生成 · 可显式重生成新版本'
                  : shot.videoState === 'locked'
                    ? '安全锁定 · 禁止重复建单'
                    : '待生成'
                const recommendationDetails = shotVideoReferenceRecommendationDetails(
                  shot.recommendedReferenceAssetIds,
                )
                const detailByAssetId = new Map(recommendationDetails.map((detail) => [detail.assetId, detail]))
                const authoritativeTarget = validPreflight?.targets.find((target) => (
                  target.shotId === shot.shotId && target.sceneId === shot.sceneId
                ))
                const visualShotKey = shotVideoVisualAnalysisShotKey(shot)
                const visualBinding = visualAnalysisBindingByShotKey[visualShotKey]
                const visualJob = visualBinding?.jobId
                  ? visualAnalysisJobsById[visualBinding.jobId]
                  : null
                const visualCurrentAuthorityKey = visualBinding ? visualAnalysisAuthorityFor(
                  visualJob?.input.selectors ?? visualBinding.selectors,
                ) : null
                const visualBindingCurrent = Boolean(
                  visualBinding
                  && visualCurrentAuthorityKey === visualBinding.requestAuthorityKey
                  && restoredVisualAnalysisAuthorityIsCurrent(visualBinding.serverAuthority),
                )
                const visualResult = validVisualAnalysisByShotKey.get(visualShotKey)
                const visualPlan = visualResult?.plan
                const visualAnalysisActive = Boolean(
                  visualBindingCurrent
                  && (visualBinding?.starting
                    || (visualJob && activeVisualAnalysisStatuses.has(visualJob.status))),
                )
                const visualAnalysisStale = Boolean(visualBinding && !visualBindingCurrent)
                const visualAnalysisUnknownBatch = Boolean(
                  visualBinding
                  && !visualBinding.jobId
                  && visualBinding.error
                  && visualBinding.selectors.length > 1,
                )
                const visualPurposeByAssetId = new Map(
                  visualPlan?.selectedReferences.map((reference) => [reference.assetId, reference.purpose] as const) ?? [],
                )
                const manualRecovery = manualRecoveryByShot[shot.shotId]
                const compatibilityOverride = referenceCompatibilityOverrides[shot.shotId]
                const manualChoice = manualSlotChoices[shot.shotId]
                const manualRecoveryActive = manualRecovery
                  && (visualPlan?.status !== 'recommended' || Boolean(manualChoice))
                  ? manualRecovery
                  : null
                const manuallySelectedSlotIds = manualRecovery && manualChoice && !manualChoice.textOnly
                  ? manualRecovery.characters.flatMap((character) => {
                      const view = manualChoice.views[character.characterId]
                      const option = character.slots.find((slot) => slot.view === view)
                      return option ? [option.assetId] : []
                    })
                  : []
                const draftReferences: Array<{
                  assetId: string
                  role: 'first_frame' | 'last_frame' | 'reference_image'
                }> = referenceControlMode === 'smart'
                  ? compatibilityOverride
                    ? wholeTurnaroundCompatibilityRecoveryReferences({
                        storyboardAssetId: shot.assetId,
                        turnaroundAssetId: compatibilityOverride,
                      }, eligibleIds)
                  : authoritativeTarget
                    ? authoritativeTarget.references.map(({ assetId, role }) => ({ assetId, role }))
                    : manualRecovery && manualChoice
                      ? manuallySelectedSlotIds.map((assetId) => ({
                          assetId,
                          role: 'reference_image' as const,
                        }))
                    : visualPlan
                      ? visualPlan.selectedReferences.map(({ assetId, role }) => ({ assetId, role }))
                    : shot.assetId && eligibleIds.has(shot.assetId)
                      ? [{ assetId: shot.assetId, role: 'first_frame' as const }]
                      : []
                  : draft.mode === 'multi-reference'
                  ? draft.referenceAssetIds.map((assetId) => ({ assetId, role: 'reference_image' as const }))
                  : draft.mode === 'first-frame'
                    ? draft.firstFrameAssetId
                      ? [{ assetId: draft.firstFrameAssetId, role: 'first_frame' as const }]
                      : []
                    : draft.mode === 'first-last-frame'
                      ? [
                          ...(draft.firstFrameAssetId
                            ? [{ assetId: draft.firstFrameAssetId, role: 'first_frame' as const }]
                            : []),
                          ...(draft.lastFrameAssetId
                            ? [{ assetId: draft.lastFrameAssetId, role: 'last_frame' as const }]
                            : []),
                        ]
                      : []
                const displayedReferences = draftReferences.flatMap(({ assetId, role }) => {
                  const asset = eligibleAssetById.get(assetId)
                  if (!asset) return []
                  const detail = detailByAssetId.get(assetId)
                  const currentStoryboard = assetId === shot.assetId
                  const name = currentStoryboard
                    ? `${shot.code} · ${shot.title}`
                    : detail?.entityName ?? assetLabel(asset)
                  const source = currentStoryboard
                    ? '当前分镜图'
                    : detail?.sourceLabel
                      ?? (asset.source === 'upload' ? '用户上传素材' : asset.providerId ? 'Provider 生成素材' : '项目图片素材')
                  const purpose = role === 'first_frame'
                    ? visualPurposeByAssetId.get(assetId) ?? '首帧构图'
                    : role === 'last_frame'
                      ? '同镜状态变化尾关键帧'
                      : currentStoryboard
                        ? visualPurposeByAssetId.get(assetId) ?? '当前镜头内容锚点'
                        : visualPurposeByAssetId.get(assetId) ?? detail?.purposeLabel ?? '风格与细节参考'
                  return [{
                    asset,
                    name,
                    source,
                    purpose,
                    url: currentStoryboard && shot.imageUrl ? shot.imageUrl : asset.url,
                  }]
                })
                const smartCopy = compatibilityOverride
                  ? {
                      label: shot.assetId && eligibleIds.has(shot.assetId)
                        ? '人工恢复 · 分镜 + 整张三视图'
                        : '人工恢复 · 整张角色三视图',
                      description: shot.assetId && eligibleIds.has(shot.assetId)
                        ? '本镜分镜继续约束内容与构图，同源整张三视图负责角色外观；不会改动其他镜头或角色锁定。'
                        : '当前没有可用的本镜分镜；本镜使用同源整张三视图，不会改动其他镜头或角色锁定。',
                    }
                  : authoritativeTarget
                    ? authoritativeTarget.referenceDecision.resolution === 'storyboard_anchor'
                    ? {
                        label: '服务端已选 · 当前分镜首帧',
                        description: authoritativeTarget.referenceDecision.recommendation.status === 'manual_required'
                          ? '角色视角证据不足，因此未猜测正 / 侧 / 背三视图；仅使用当前镜头自身分镜固定构图。'
                          : '当前镜头无需额外角色三视图，仅使用自身分镜固定构图。',
                      }
                    : {
                        label: `服务端已选 · ${authoritativeTarget.references.length} 张`,
                        description: authoritativeTarget.referenceDecision.recommendation.rationale,
                      }
                    : visualPlan
                    ? {
                        label: visualPlan.status === 'recommended'
                          ? `视觉 Agent 建议 · ${visualAnalysisStrategyLabel(visualPlan.strategy)} · ${Math.round(visualPlan.confidence * 100)}%`
                          : `视觉 Agent 要求人工确认 · ${Math.round(visualPlan.confidence * 100)}%`,
                        description: visualPlan.rationale,
                      }
                    : {
                        label: '确定性安全兜底（非视觉 Agent）',
                        description: '尚未主动运行视觉模型；预检仅依据当前镜分镜、文本方向证据与真实角色槽位做保守绑定。',
                      }
                return (
                  <article
                    key={`${shot.sceneId}:${shot.shotId}`}
                    className={`${selected ? 'selected' : ''} ${effectivelyLocked ? 'blocked' : ''} video-${shot.videoState}`}
                    aria-label={`${shot.code} 逐镜生成配置`}
                  >
                    <div className="shot-video-batch-shot-header">
                      <label className="shot-video-batch-shot-toggle">
                        <input type="checkbox" checked={selected} disabled={locked || effectivelyLocked} onChange={() => toggleShot(shot.shotId)} />
                        <span className="shot-video-batch-thumb">
                          {shot.imageUrl ? <img src={shot.imageUrl} alt="" /> : <ImageIcon size={16} />}
                        </span>
                        <span><strong>{shot.code} · {shot.title}</strong><small>{blockedReason ?? `${videoStateLabel} · ${clampDuration(shot.durationSeconds)} 秒`}</small></span>
                      </label>
                      <button
                        type="button"
                        className="shot-video-analyze-one"
                        aria-label={`分析 ${shot.code} 视觉参考`}
                        title={!textProviderReady || !textProviderId || !textProviderConfigRevision || !textProviderModel
                          ? '请先配置并测试支持视觉输入的文本 Provider'
                          : effectivelyLocked ? '此镜处于安全锁定状态' : undefined}
                        disabled={locked
                          || effectivelyLocked
                          || visualAnalysisHydrating
                          || Boolean(visualAnalysisHydrationError)
                          || visualAnalysisActive
                          || visualAnalysisUnknownBatch
                          || !textProviderReady
                          || !textProviderId
                          || !textProviderConfigRevision
                          || !textProviderModel}
                        onClick={() => void runVisualReferenceAnalysis([shot])}
                      >
                        {visualAnalysisActive
                          ? <LoaderCircle size={12} className="spin" />
                          : <Sparkles size={12} />}
                        {visualAnalysisHydrating
                          ? '正在恢复…'
                          : visualBinding?.starting
                          ? '正在创建…'
                          : visualJob && activeVisualAnalysisStatuses.has(visualJob.status)
                            ? `分析中 ${Math.round(visualJob.progress)}%`
                            : visualResult
                              ? '重新分析此镜'
                              : visualAnalysisUnknownBatch
                                ? '请用上方批量重试'
                                : visualBinding ? '重试分析此镜' : '视觉分析此镜'}
                      </button>
                    </div>
                    {visualBinding && (
                      <div
                        className={`shot-video-card-analysis ${visualAnalysisStale ? 'stale' : ''}`}
                        role="status"
                        aria-label={`${shot.code} 视觉分析状态`}
                        aria-live="polite"
                      >
                        <header>
                          <span>
                            {visualAnalysisStale ? <AlertTriangle size={12} />
                              : visualResult ? <CheckCircle2 size={12} />
                                : visualAnalysisActive ? <LoaderCircle size={12} className="spin" />
                                  : <AlertTriangle size={12} />}
                            {visualAnalysisStale
                              ? '分析结果已失效'
                              : visualBinding.starting
                                ? '正在创建免费持久任务'
                                : visualJob && activeVisualAnalysisStatuses.has(visualJob.status)
                                  ? `持久任务 ${visualJob.id.slice(0, 8)} · ${Math.round(visualJob.progress)}%`
                                  : visualResult
                                    ? `分析完成 · Job ${visualResult.jobId.slice(0, 8)}`
                                    : visualBinding.error
                                      ? '任务结果尚未确认'
                                      : visualJob ? `任务${visualJob.status === 'failed' ? '失败' : '未完成'}` : '等待显式重试'}
                          </span>
                          {!visualBinding.starting && <button
                            type="button"
                            onClick={() => useFastReferenceRecommendation(shot)}
                          >仅此镜改用快速推荐</button>}
                        </header>
                        {visualAnalysisStale && (
                          <p className="warning">剧本修订、候选图片 checksum 或文本 Provider 修订已变化；旧 Job 不会进入付费预检。</p>
                        )}
                        {!visualAnalysisStale && visualBinding.error && (
                          <p className="warning">{visualBinding.error}</p>
                        )}
                        {!visualAnalysisStale && !visualBinding.error && visualJob
                          && !activeVisualAnalysisStatuses.has(visualJob.status)
                          && visualJob.status !== 'succeeded' && (
                          <p className="warning">{visualAnalysisJobError(visualJob)} 不会自动重提模型调用。</p>
                        )}
                        {!visualAnalysisStale && visualResult && (
                          <div className={`shot-video-visual-plan ${visualPlan?.status === 'manual_required' ? 'manual' : ''}`}>
                            <div className="shot-video-visual-plan-meta">
                              <span>{visualAnalysisStrategyLabel(visualResult.plan.strategy)}</span>
                              <span>置信度 {Math.round(visualResult.plan.confidence * 100)}%</span>
                              <span>{visualResult.plan.selectedReferences.length} 张参考图</span>
                            </div>
                            <p>{visualResult.plan.rationale}</p>
                            {visualResult.plan.visualEvidence.length > 0 && (
                              <div className="shot-video-visual-evidence">
                                <strong>视觉证据</strong>
                                {visualResult.plan.visualEvidence.map((evidence, index) => (
                                  <span key={`${visualShotKey}:evidence:${index}`}>{evidence}</span>
                                ))}
                              </div>
                            )}
                            {visualResult.plan.missingCharacterViews.length > 0 && (
                              <div className="shot-video-visual-missing" role="alert">
                                <strong>缺少角色视角槽位</strong>
                                {visualResult.plan.missingCharacterViews.map((missing) => (
                                  <span key={`${missing.characterId}:${missing.view}`}>
                                    {missing.characterName} · {missingViewLabel(missing.view)}：{missing.rationale}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {referenceControlMode === 'manual' && visualResult && (
                          <p>结果已保留，但当前“通用素材高级覆盖”优先，不会自动覆盖你的手动选择。</p>
                        )}
                      </div>
                    )}
                    {selected && (
                      <div className="shot-video-reference-editor">
                        {referenceControlMode === 'smart' ? (
                          <>
                            <div className="shot-video-smart-recommendation">
                              <span><Sparkles size={12} /> {manualRecoveryActive ? '需要你确认角色视角' : smartCopy.label}</span>
                              <p>{manualRecoveryActive
                                ? manualRecoveryActive.slotSelectionAllowed
                                  ? '服务端没有足够证据自动判断正/侧/背；请选择已锁定槽位，不会让你输入 Asset ID。'
                                  : '本镜角色数超过 Provider 参考图上限；系统不会生成一个无法提交的槽位表单。'
                                : smartCopy.description}</p>
                            </div>
                            {manualRecoveryActive && (
                              <div className="shot-video-manual-slot-recovery" aria-label={`${shot.code} 人工角色视角选择`}>
                                {!manualRecoveryActive.slotSelectionAllowed && (
                                  <div className="shot-video-reference-limit-recovery" role="alert">
                                    <strong>本镜关联 {manualRecoveryActive.characters.length} 个角色，超过 {manualRecoveryActive.maximumReferenceImages} 张参考图上限</strong>
                                    <span>系统不会提交不完整或超限的角色槽位。请回剧本拆镜，或在下方明确选择“纯文本”后重新免费预检。</span>
                                  </div>
                                )}
                                {manualRecoveryActive.slotSelectionAllowed
                                  && missingManualSlotAssetIds(manualRecoveryActive, eligibleIds).length > 0 && (
                                  <div className="shot-video-missing-slot-assets" role="alert">
                                    <p>服务端已有锁定槽位证据，但当前素材库缺少 {missingManualSlotAssetIds(manualRecoveryActive, eligibleIds).length} 个缩略图；请先刷新，系统不会把缺图静默当成不可选。</p>
                                    <button
                                      type="button"
                                      disabled={locked}
                                      onClick={() => void refreshAssetLibrary()}
                                    >{refreshingAssetLibrary ? '正在刷新素材库…' : '刷新素材库并恢复选择'}</button>
                                  </div>
                                )}
                                {manualRecoveryActive.characters.map((character) => (
                                  <section key={character.characterId}>
                                    <div><strong>{character.characterName}</strong><small>{character.rationale}</small></div>
                                    <div className="shot-video-manual-slot-grid">
                                      {character.slots.length ? character.slots.map((slot) => {
                                        const asset = eligibleAssetById.get(slot.assetId)
                                        const selectedView = manualChoice?.textOnly === false
                                          && manualChoice.views[character.characterId] === slot.view
                                        const viewLabel = { front: '正面', side: '侧面', back: '背面' }[slot.view]
                                        return (
                                          <article key={`${character.characterId}:${slot.view}`} className={selectedView ? 'selected' : ''}>
                                            <button
                                              type="button"
                                              disabled={locked || !asset || !manualRecoveryActive.slotSelectionAllowed}
                                              title={!manualRecoveryActive.slotSelectionAllowed
                                                ? '相关角色超过 9 个，请拆镜或使用纯文本'
                                                : !asset ? '锁定槽位存在，但素材库尚未同步；请刷新素材库' : undefined}
                                              aria-pressed={selectedView}
                                              onClick={() => {
                                                invalidate()
                                                setManualSlotChoices((current) => ({
                                                  ...current,
                                                  [shot.shotId]: {
                                                    textOnly: false,
                                                    views: {
                                                      ...(current[shot.shotId]?.views ?? {}),
                                                      [character.characterId]: slot.view,
                                                    },
                                                  },
                                                }))
                                              }}
                                            >
                                              {asset ? <img src={asset.url} alt={`${character.characterName}${viewLabel}槽位`} /> : <ImageIcon size={18} />}
                                              <span><strong>{viewLabel}</strong><small>已锁定 · v{slot.slotVersion}</small></span>
                                            </button>
                                            {asset && <button
                                              type="button"
                                              className="preview"
                                              aria-label={`放大预览 ${character.characterName}${viewLabel}`}
                                              onClick={() => setReferencePreview({
                                                url: asset.url,
                                                name: `${character.characterName} · ${viewLabel}`,
                                                source: '当前 Episode 锁定三视图槽位',
                                                purpose: '人工视角选择',
                                              })}
                                            ><Maximize2 size={11} /></button>}
                                          </article>
                                        )
                                      }) : <div className="shot-video-empty-slots">
                                        <p>当前角色三视图 0/3；没有可验证的正/侧/背槽位。</p>
                                        <button type="button" disabled={locked} onClick={onConfigureCharacterReferences}>去项目资产库拆分 / 绑定三视图</button>
                                      </div>}
                                    </div>
                                  </section>
                                ))}
                                <button
                                  type="button"
                                  className={manualChoice?.textOnly ? 'text-only selected' : 'text-only'}
                                  aria-pressed={manualChoice?.textOnly === true}
                                  disabled={locked}
                                  onClick={() => {
                                    invalidate()
                                    setManualSlotChoices((current) => ({
                                      ...current,
                                      [shot.shotId]: { textOnly: true, views: {} },
                                    }))
                                  }}
                                >不使用角色参考 · 纯文本</button>
                                <small>选择后只会重做免费权威预检；仍需你另外确认才会创建付费任务。</small>
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="shot-video-reference-modes" role="group" aria-label={`${shot.code} 参考图模式`}>
                              {referenceModeOptions.map((option) => (
                                <button
                                  key={option.value}
                                  type="button"
                                  className={draft.mode === option.value ? 'active' : ''}
                                  aria-pressed={draft.mode === option.value}
                                  disabled={locked}
                                  title={option.help}
                                  onClick={() => updateDraft(shot.shotId, { mode: option.value, strategy: undefined })}
                                >{option.label}</button>
                              ))}
                            </div>
                            {(draft.mode === 'first-frame' || draft.mode === 'first-last-frame') && (
                              <div className="shot-video-frame-selectors">
                                <label><small>首帧</small><select
                                  value={draft.firstFrameAssetId}
                                  disabled={locked}
                                  onChange={(event) => updateDraft(shot.shotId, { firstFrameAssetId: event.target.value, strategy: undefined })}
                                >
                                  <option value="">请选择当前修订图片…</option>
                                  {eligibleAssets.map((asset) => <option key={asset.id} value={asset.id}>{assetLabel(asset)}</option>)}
                                </select></label>
                                {draft.mode === 'first-last-frame' && <label><small>尾帧（必须是同镜专用关键帧）</small><select
                                  value={draft.lastFrameAssetId}
                                  disabled={locked}
                                  onChange={(event) => updateDraft(shot.shotId, { lastFrameAssetId: event.target.value, strategy: undefined })}
                                >
                                  <option value="">请选择当前修订图片…</option>
                                  {eligibleAssets.map((asset) => <option key={asset.id} value={asset.id}>{assetLabel(asset)}</option>)}
                                </select></label>}
                              </div>
                            )}
                            {draft.mode === 'multi-reference' && (
                              <div className="shot-video-reference-grid">
                                {eligibleAssets.length ? eligibleAssets.map((asset) => {
                                  const checked = draft.referenceAssetIds.includes(asset.id)
                                  const detail = detailByAssetId.get(asset.id)
                                  const currentStoryboard = asset.id === shot.assetId
                                  const name = currentStoryboard ? `${shot.code} · ${shot.title}` : detail?.entityName ?? assetLabel(asset)
                                  const source = currentStoryboard ? '当前分镜图' : detail?.sourceLabel
                                    ?? (asset.source === 'upload' ? '用户上传素材' : asset.providerId ? 'Provider 生成素材' : '项目图片素材')
                                  const purpose = currentStoryboard ? '当前镜头内容锚点' : detail?.purposeLabel ?? '风格与细节参考'
                                  return <div key={asset.id} className={checked ? 'checked' : ''}>
                                    <label>
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={locked || (!checked && draft.referenceAssetIds.length >= 9)}
                                        onChange={() => updateDraft(shot.shotId, {
                                          strategy: undefined,
                                          referenceAssetIds: checked
                                            ? draft.referenceAssetIds.filter((id) => id !== asset.id)
                                            : [...draft.referenceAssetIds, asset.id],
                                        })}
                                      />
                                      <img src={currentStoryboard && shot.imageUrl ? shot.imageUrl : asset.url} alt={name} />
                                      <span><strong>{name}</strong><small>{source}</small></span>
                                    </label>
                                    <button
                                      type="button"
                                      aria-label={`放大预览 ${name}`}
                                      title="放大预览"
                                      onClick={() => setReferencePreview({
                                        url: currentStoryboard && shot.imageUrl ? shot.imageUrl : asset.url,
                                        name,
                                        source,
                                        purpose,
                                      })}
                                    ><Maximize2 size={11} /></button>
                                  </div>
                                }) : <p>当前修订还没有可用图片资产。</p>}
                              </div>
                            )}
                            {draft.mode === 'first-last-frame' && (
                              <small className="shot-video-reference-warning">手动模式也不应把下一镜分镜当作当前镜头尾帧。</small>
                            )}
                          </>
                        )}
                        {displayedReferences.length > 0 ? (
                          <div className="shot-video-selected-references" aria-label={`${shot.code} 将送入预检的图片`}>
                            {displayedReferences.map((reference) => (
                              <article key={`${reference.asset.id}:${reference.purpose}`}>
                                <button
                                  type="button"
                                  className="shot-video-reference-image"
                                  aria-label={`放大预览 ${reference.name}`}
                                  onClick={() => setReferencePreview({
                                    url: reference.url,
                                    name: reference.name,
                                    source: reference.source,
                                    purpose: reference.purpose,
                                  })}
                                >
                                  <img src={reference.url} alt={reference.name} />
                                  <Maximize2 size={12} />
                                </button>
                                <div><strong>{reference.name}</strong><small>{reference.source}</small><span>{reference.purpose}</span></div>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <small className={visualPlan?.status === 'manual_required'
                            ? 'shot-video-reference-warning'
                            : 'shot-video-reference-recommendation'}>
                            {visualPlan?.status === 'manual_required'
                              ? '视觉 Agent 明确要求人工确认；不会静默退化成纯文本或猜测角色视角。'
                              : '本镜暂无可用图片，将使用镜头文本；预检仍会校验当前修订。'}
                          </small>
                        )}
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          </section>

          <aside className="shot-video-batch-confirmation">
            <div className="shot-video-batch-confirmation-scroll">
              <section>
                <div className="shot-video-batch-section-title"><div><strong>输出规格</strong><small>固定进入持久任务</small></div></div>
                <div className="shot-video-resolution" role="group" aria-label="视频分辨率">
                  {(['480p', '720p', '1080p'] as const).map((value) => (
                    <button key={value} type="button" className={resolution === value ? 'active' : ''} aria-pressed={resolution === value} disabled={locked} onClick={() => { invalidate(); setResolution(value) }}>{value}{value === '720p' ? ' · 推荐' : ''}</button>
                  ))}
                </div>
                <div className="shot-video-prompt-strategy" role="radiogroup" aria-label="Prompt 策略">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={promptCompilerVersion === 'seedance-compact-v1'}
                    className={promptCompilerVersion === 'seedance-compact-v1' ? 'active' : ''}
                    disabled={locked}
                    onClick={() => { invalidate(); setPromptCompilerVersion('seedance-compact-v1') }}
                  >
                    <strong>Agentic 精简</strong>
                    <small>生产默认 · seedance-compact-v1</small>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={promptCompilerVersion === 'seedance-verbose-baseline-v1'}
                    className={promptCompilerVersion === 'seedance-verbose-baseline-v1' ? 'active baseline' : ''}
                    disabled={locked}
                    onClick={() => { invalidate(); setPromptCompilerVersion('seedance-verbose-baseline-v1') }}
                  >
                    <strong>A/B 长 Prompt 基线</strong>
                    <small>验收专用 · 只改变 Prompt 策略</small>
                  </button>
                </div>
                {promptCompilerVersion === 'seedance-verbose-baseline-v1' && (
                  <p className="shot-video-prompt-strategy-warning">
                    Baseline 仍是独立计费任务；结果只进入验收素材，不替换当前生产镜头。预检会继续固定模型、Provider revision、参考图顺序、音频 timing、分辨率与声音策略。
                  </p>
                )}
                <div className="shot-video-audio-policies" role="radiogroup" aria-label="Seedance 声音策略">
                  {audioPolicyOptions.map((option) => {
                    const Icon = option.icon
                    const selected = audioPolicy === option.value
                    return <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`shot-video-audio-option ${selected ? 'enabled' : ''}`}
                      disabled={locked}
                      onClick={() => { invalidate(); setAudioPolicy(option.value) }}
                    >
                      <span><Icon size={15} /></span>
                      <div><strong>{option.label}</strong><small>{option.help}</small></div>
                    </button>
                  })}
                </div>
                <p className={`shot-video-publication-mode ${publicationMode === 'evaluation_only' ? 'evaluation' : ''}`}>
                  <ShieldCheck size={14} />
                  <span><strong>{publicationMode === 'evaluation_only' ? '仅保存候选版本' : '生成后更新当前镜头'}</strong>
                    {publicationMode === 'evaluation_only'
                      ? '完成后可在镜头版本中试听、对比并明确采纳；当前时间线不会被自动改写。'
                      : '成功后绑定为当前镜头视频，并保留旧版本供审片恢复。'}</span>
                </p>
              </section>

              {referenceCompatibilityIssues.length > 0 && (
                <section className="shot-video-reference-compatibility" role="alert" aria-label="Seedance 参考图兼容性问题">
                  <header>
                    <AlertTriangle size={15} />
                    <div>
                      <strong>已定位 {referenceCompatibilityIssues.length} 张不合规参考图</strong>
                      <small>发生在免费预检，尚未创建 Seedance 计费任务。尺寸范围 300–6000px，宽高比必须严格位于 0.4–2.5 之间。</small>
                    </div>
                  </header>
                  {referenceCompatibilityIssues.map((issue) => {
                    const shot = availableShots.find((candidate) => (
                      candidate.shotId === issue.shotId
                      && (issue.sceneId === null || candidate.sceneId === issue.sceneId)
                    ))
                    const source = eligibleAssetById.get(issue.assetId)
                    const turnaround = issue.turnaroundSource
                      ? eligibleAssetById.get(issue.turnaroundSource.assetId)
                      : null
                    const view = issue.character?.view === 'front' ? '正面'
                      : issue.character?.view === 'side' ? '侧面'
                        : issue.character?.view === 'back' ? '背面' : '参考'
                    return <article key={`${issue.sceneId ?? ''}:${issue.shotId}:${issue.assetId}`}>
                      <div className="shot-video-reference-compatibility-images">
                        <figure>
                          {source ? <img src={source.url} alt={`${issue.character?.name ?? '角色'}${view}参考图`} /> : <ImageIcon size={22} />}
                          <figcaption><b>{issue.character ? `${issue.character.name} · ${view}槽位` : '参考图'}</b><span>{issue.width ?? '?'}×{issue.height ?? '?'} · 比例 {issue.aspectRatio?.toFixed(3) ?? '未知'}</span></figcaption>
                        </figure>
                        {turnaround && issue.turnaroundSource && <figure className="replacement">
                          <img src={turnaround.url} alt={`${issue.character?.name ?? '角色'}整张三视图`} />
                          <figcaption><b>可用的同源整张三视图</b><span>{issue.turnaroundSource.width}×{issue.turnaroundSource.height} · 比例 {issue.turnaroundSource.aspectRatio.toFixed(3)}</span></figcaption>
                        </figure>}
                      </div>
                      <div className="shot-video-reference-compatibility-copy">
                        <strong>{shot?.code ?? issue.shotId}：{issue.character ? `${issue.character.name}${view}图` : '参考图'}不符合输入包络</strong>
                        <p>原图不会被覆盖。重新拆分会使用本地 FFmpeg 在不裁掉人物的前提下缩放并补白到安全画布；也可以只让本镜显式改用整张三视图。</p>
                        <div>
                          {turnaround && issue.turnaroundSource && <button
                            type="button"
                            onClick={() => {
                              invalidate()
                              setReferenceCompatibilityOverrides((current) => ({
                                ...current,
                                [issue.shotId]: issue.turnaroundSource!.assetId,
                              }))
                              setReferenceCompatibilityIssues((current) => current.filter((candidate) => (
                                candidate.shotId !== issue.shotId || candidate.assetId !== issue.assetId
                              )))
                            }}
                          ><CheckCircle2 size={12} /> 本镜采用分镜 + 整张三视图</button>}
                          <button type="button" className="secondary" onClick={onConfigureCharacterReferences}>
                            本地 FFmpeg 重新拆分
                          </button>
                        </div>
                      </div>
                    </article>
                  })}
                </section>
              )}

              {prepared.issues.length > 0 && (
                <div className="shot-video-batch-error" role="alert">
                  <AlertTriangle size={14} />
                  <span>{prepared.issues.slice(0, 4).join('；')}</span>
                </div>
              )}
              {error && <div className="shot-video-batch-error" role="alert"><AlertTriangle size={14} /><span>{error}</span></div>}
              {submittedCount !== null && (
                <div className="shot-video-batch-success" role="status">
                  <CheckCircle2 size={15} />
                  <span>已原子创建 {submittedCount} 个持久视频任务，可关闭页面后续跑。</span>
                </div>
              )}

              {validPreflight ? (
                <div className="shot-video-preflight-card">
                <header><ShieldCheck size={16} /><div><strong>服务端权威预检已完成</strong><small>{validPreflight.provider.providerId} · r{validPreflight.provider.configRevision}</small></div></header>
                <dl>
                  <div><dt>可计费任务</dt><dd>{validPreflight.billableTaskCount}</dd></div>
                  <div><dt>请求总时长</dt><dd>{validPreflight.totalRequestedSeconds} 秒</dd></div>
                  <div><dt>声音策略</dt><dd>{audioPolicyOptions.find((option) => option.value === validPreflight.audioPolicy)?.label ?? validPreflight.audioPolicy}</dd></div>
                  <div><dt>产出方式</dt><dd>{validPreflight.publicationMode === 'evaluation_only' ? '候选版本（不覆盖）' : '更新当前镜头'}</dd></div>
                  <div><dt>确认有效至</dt><dd>{formatExpiry(validPreflight.expiresAt)}</dd></div>
                </dl>
                <div className="shot-video-preflight-targets" aria-label="本次计费镜头">
                  {validPreflight.targets.map((target) => {
                    const shot = availableShots.find((candidate) => candidate.shotId === target.shotId)
                    const mode = referenceModeOptions.find((option) => option.value === target.referenceMode)?.label ?? target.referenceMode
                    return <span key={`${target.sceneId}:${target.shotId}`}><b>{shot?.code ?? target.shotId.slice(0, 8)}</b>{mode} · 剪辑 {target.timelineDurationSeconds.toFixed(2)}s / 生成 {target.durationSeconds}s</span>
                  })}
                </div>
                <div className="shot-video-prompt-previews">
                  {validPreflight.targets.map((target) => {
                    const shot = availableShots.find((candidate) => candidate.shotId === target.shotId)
                    return <details key={`prompt:${target.sceneId}:${target.shotId}`} open={validPreflight.targets.length === 1}>
                      <summary><span>{shot?.code ?? target.shotId.slice(0, 8)} 实际 Prompt</span><small>{target.promptCompilerVersion}</small></summary>
                      <pre>{target.promptPreview}</pre>
                      {target.promptCompilerNotices.length > 0 && <p>{target.promptCompilerNotices.join('；')}</p>}
                    </details>
                  })}
                </div>
                <p>供应商未提供可验证的版本化价目，因此不伪造货币估价；以上任务数和时长为本次确认范围。</p>
                </div>
              ) : (
                <div className="shot-video-preflight-empty">
                  <ShieldCheck size={23} />
                  <strong>第一步只预检，不创建付费任务</strong>
                  <span>服务端会固定剧本修订、Provider 版本、图片 checksum 与镜头规格。</span>
                </div>
              )}
            </div>

            <footer>
              {!providerId && <button type="button" className="button secondary" onClick={onConfigureProvider}><Settings2 size={14} /> 配置 Seedance</button>}
              {submittedCount !== null ? (
                <button type="button" className="button primary" onClick={onClose}>
                  <CheckCircle2 size={14} /> 完成并关闭
                </button>
              ) : validPreflight ? (
                <button type="button" className="button primary" disabled={busy || !attempt} onClick={() => void submit()}>
                  {submitting ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
                  {submitting ? '正在原子创建…' : `确认 ${validPreflight.billableTaskCount} 个计费任务并开始`}
                </button>
              ) : (
                <button type="button" className="button primary" disabled={busy || visualAnalysisBlocksPreflight || !providerId || prepared.issues.length > 0} onClick={() => void runPreflight()}>
                  {preflighting ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />}
                  {preflighting ? '正在核定…' : visualAnalysisBlocksPreflight ? '等待视觉分析，或改用快速推荐' : '第一步：快速权威预检'}
                </button>
              )}
            </footer>
          </aside>
        </div>
        {referencePreview && (
          <div
            className="shot-video-reference-preview"
            role="dialog"
            aria-label={`参考图放大预览：${referencePreview.name}`}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setReferencePreview(null)
            }}
          >
            <div>
              <header>
                <div><strong>{referencePreview.name}</strong><small>{referencePreview.source} · {referencePreview.purpose}</small></div>
                <button type="button" onClick={() => setReferencePreview(null)} aria-label="关闭参考图预览"><X size={17} /></button>
              </header>
              <img src={referencePreview.url} alt={referencePreview.name} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
