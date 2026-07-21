import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  CircleDashed,
  Clock3,
  CloudCog,
  Coins,
  LoaderCircle,
  RefreshCcw,
  Sparkles,
  X,
} from 'lucide-react'

import {
  ApiError,
  api,
  type CreatePipelineRunInput,
  type EpisodeSummary,
  type PipelineRun,
  type PipelineRunPreflight,
  type PipelineRunPreflightInput,
  type PipelineStepId,
  type PipelineStepStatus,
  type ProviderConnection,
  type StoryDocument,
} from '../../lib'
import {
  adoptPipelineRun,
  completePipelineAttempt,
  getOrCreatePipelineAttempt,
  isExecutablePipelineProvider,
  normalizePipelineCreateInput,
  normalizePipelinePreflightInput,
  pipelineErrorMessage,
  pipelinePreflightIsExpired,
  pipelinePreflightRemainingSeconds,
  pipelineRequestCacheKey,
  pipelineRunContextKey,
  pipelineRunMatchesContext,
  type PipelineIdempotencyAttempt,
  type PipelineRunContext,
} from './pipeline-client-state'
import './OneClickProductionPanel.css'

const ACTIVE_RUN_STATUSES = new Set<PipelineRun['status']>(['queued', 'running'])

const STEP_LABELS: Record<PipelineStepId, { title: string; detail: string }> = {
  storyboard: { title: '定镜长并补齐分镜', detail: '配音就绪后，按逐镜实测语音时长补齐当前修订缺失的分镜图' },
  speech: { title: '生成并确认配音', detail: '先补齐缺失对白；后续画面任务必须等待真实音频就绪' },
  timeline: { title: '固化时间线（必要时自动剪辑）', detail: '先诊断；仅安全白名单操作会通过 OpenCut 保存新修订' },
  export: { title: '渲染成片', detail: '使用不可变快照执行 FFmpeg 导出' },
  quality: { title: '成片质检', detail: '硬门禁校验后开放播放与下载' },
}

// Execution order is explicit rather than inherited from object insertion
// order: speech is the timing authority for every downstream visual task.
const STEP_IDS: PipelineStepId[] = ['speech', 'storyboard', 'timeline', 'export', 'quality']

const RUN_STATUS_LABELS: Record<PipelineRun['status'], string> = {
  queued: '已入队',
  running: '生产中',
  succeeded: '生产完成',
  failed: '生产失败',
  cancelled: '已取消',
  stale: '源修订已过期',
}

const STEP_STATUS_LABELS: Record<PipelineStepStatus, string> = {
  pending: '等待',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  stale: '已过期',
}

function runIsActive(run: PipelineRun | null): boolean {
  return Boolean(run && ACTIVE_RUN_STATUSES.has(run.status))
}

function pipelineStep(run: PipelineRun, stepId: PipelineStepId) {
  return run.steps[stepId]
}

function shortId(value: string | undefined): string {
  return value ? value.slice(0, 8) : '尚未固化'
}

function preflightCountdown(seconds: number | null): string {
  if (seconds === null) return '无确认能力'
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function stepEvidence(run: PipelineRun, stepId: PipelineStepId): string {
  const step = pipelineStep(run, stepId)
  if (stepId === 'storyboard' || stepId === 'speech') {
    const fanout = run.steps[stepId]
    return `${fanout.completed}/${fanout.total} 个目标 · ${fanout.jobIds.length} 个持久任务`
  }
  if (stepId === 'timeline') {
    const edit = run.steps.timeline.automaticEdit
    return `修订 ${shortId(run.steps.timeline.revisionId)}${edit ? ` · OpenCut 自动剪辑 ${edit.operationCount} 项` : ''}`
  }
  if (stepId === 'export') {
    return `成片 ${shortId(run.steps.export.exportId)} · 任务 ${shortId(run.steps.export.rootJobId)}`
  }
  return `报告 ${shortId(run.steps.quality.reportId)}${run.steps.quality.passed === true ? ' · 已通过' : ''}`
}

function StepStatusIcon({ status }: { status: PipelineStepStatus }) {
  if (status === 'succeeded') return <Check size={12} />
  if (status === 'running') return <LoaderCircle className="pipeline-production-spin" size={12} />
  if (status === 'failed' || status === 'stale') return <AlertTriangle size={12} />
  if (status === 'cancelled') return <Ban size={12} />
  return <CircleDashed size={12} />
}

function latestRun(runs: PipelineRun[], context: PipelineRunContext): PipelineRun | null {
  return runs.filter((candidate) => (
    candidate.projectId === context.projectId
    && candidate.episodeId === context.episodeId
    && candidate.sourceRevisionId === context.sourceRevisionId
  )).sort((left, right) => (
    Date.parse(right.createdAt) - Date.parse(left.createdAt)
  ))[0] ?? null
}

function friendlyPipelineError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return pipelineErrorMessage(error.code, error.message, fallback)
  if (error instanceof Error) return pipelineErrorMessage(undefined, error.message, fallback)
  return fallback
}

export interface OneClickProductionPanelProps {
  episode: EpisodeSummary | null
  story: StoryDocument | null
  missingStoryboardCount: number
  missingSpeechCount: number
}

export function OneClickProductionPanel({
  episode,
  story,
  missingStoryboardCount,
  missingSpeechCount,
}: OneClickProductionPanelProps) {
  const [run, setRun] = useState<PipelineRun | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [cancelArmed, setCancelArmed] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const activeContextRef = useRef('')
  const runRef = useRef<PipelineRun | null>(null)
  const requestControllersRef = useRef(new Set<AbortController>())
  const refreshControllerRef = useRef<AbortController | null>(null)
  const cancelControllerRef = useRef<AbortController | null>(null)
  const idempotencyAttemptsRef = useRef(new Map<string, string>())
  const automaticRepairAvailable = run?.status === 'failed'
    && (run.error?.code === 'INVALID_TIMELINE'
      || run.steps.export.error?.code === 'INVALID_TIMELINE')

  const hasProductionContext = Boolean(
    episode
    && episode.sourceRevisionId
    && story
    && story.scenes.some((scene) => scene.shots.length > 0),
  )
  const runContext: PipelineRunContext | null = episode?.sourceRevisionId
    ? {
        projectId: episode.projectId,
        episodeId: episode.id,
        sourceRevisionId: episode.sourceRevisionId,
      }
    : null
  const contextKey = runContext ? pipelineRunContextKey(runContext) : ''
  // Render-time assignment closes the small window between a context-changing
  // commit and effect cleanup; old async completions are ignored immediately.
  activeContextRef.current = contextKey

  const registerController = (controller: AbortController): (() => void) => {
    requestControllersRef.current.add(controller)
    return () => requestControllersRef.current.delete(controller)
  }

  const adoptForContext = (
    incoming: PipelineRun,
    expectedContext: PipelineRunContext,
    expectedContextKey: string,
    expectedRunId?: string,
  ): boolean => {
    if (activeContextRef.current !== expectedContextKey) return false
    const current = runRef.current
    const next = adoptPipelineRun(current, incoming, {
      context: expectedContext,
      ...(expectedRunId ? { runId: expectedRunId } : {}),
    })
    if (next === current) return false
    runRef.current = next
    setRun(next)
    return true
  }

  useEffect(() => {
    for (const controller of requestControllersRef.current) controller.abort()
    requestControllersRef.current.clear()
    refreshControllerRef.current = null
    cancelControllerRef.current = null
    runRef.current = null
    setRun(null)
    setLoadError('')
    setCancelArmed(false)
    setCancelling(false)
    setRefreshing(false)
    setShowModal(false)
    if (!episode || !runContext) {
      setLoading(false)
      return
    }

    const controller = new AbortController()
    const unregister = registerController(controller)
    const expectedContext = runContext
    const expectedContextKey = contextKey
    setLoading(true)
    void api.listPipelineRuns({
      projectId: episode.projectId,
      episodeId: episode.id,
      limit: 20,
      signal: controller.signal,
    }).then((runs) => {
      if (!controller.signal.aborted && activeContextRef.current === expectedContextKey) {
        const restored = latestRun(runs, expectedContext)
        if (restored) adoptForContext(restored, expectedContext, expectedContextKey)
      }
    }).catch((error) => {
      if (!controller.signal.aborted && activeContextRef.current === expectedContextKey) {
        setLoadError(friendlyPipelineError(error, '无法恢复一键生产状态'))
      }
    }).finally(() => {
      unregister()
      if (activeContextRef.current === expectedContextKey) setLoading(false)
    })
    return () => {
      controller.abort()
      unregister()
    }
  }, [contextKey])

  useEffect(() => () => {
    for (const controller of requestControllersRef.current) controller.abort()
    requestControllersRef.current.clear()
  }, [])

  useEffect(() => {
    if (!run || !runIsActive(run) || !runContext || cancelling) return
    const controller = new AbortController()
    const unregister = registerController(controller)
    const expectedContext = runContext
    const expectedContextKey = contextKey
    const expectedRunId = run.id
    let inFlight = false
    const poll = () => {
      if (inFlight || controller.signal.aborted) return
      inFlight = true
      void api.getPipelineRun(expectedRunId, { signal: controller.signal })
        .then((next) => {
          if (!controller.signal.aborted
            && activeContextRef.current === expectedContextKey
            && next.id === expectedRunId
            && pipelineRunMatchesContext(next, expectedContext)) {
            adoptForContext(next, expectedContext, expectedContextKey, expectedRunId)
            setLoadError('')
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted && activeContextRef.current === expectedContextKey) {
            setLoadError(friendlyPipelineError(error, '生产进度更新失败，将继续重试'))
          }
        })
        .finally(() => { inFlight = false })
    }
    poll()
    const intervalId = window.setInterval(poll, 1_200)
    return () => {
      window.clearInterval(intervalId)
      controller.abort()
      unregister()
    }
  }, [run?.id, run?.status, cancelling, contextKey])

  useEffect(() => {
    setCancelArmed(false)
  }, [run?.id, run?.status])

  const refresh = async () => {
    const currentRun = runRef.current
    if (!currentRun || !runContext || refreshControllerRef.current) return
    const controller = new AbortController()
    const unregister = registerController(controller)
    const expectedContext = runContext
    const expectedContextKey = contextKey
    const expectedRunId = currentRun.id
    refreshControllerRef.current = controller
    setRefreshing(true)
    setLoadError('')
    try {
      const refreshed = await api.getPipelineRun(expectedRunId, { signal: controller.signal })
      if (activeContextRef.current === expectedContextKey
        && refreshed.id === expectedRunId
        && pipelineRunMatchesContext(refreshed, expectedContext)) {
        adoptForContext(refreshed, expectedContext, expectedContextKey, expectedRunId)
        setLoadError('')
      }
    } catch (error) {
      if (!controller.signal.aborted && activeContextRef.current === expectedContextKey) {
        setLoadError(friendlyPipelineError(error, '无法刷新生产任务'))
      }
    } finally {
      unregister()
      if (refreshControllerRef.current === controller) refreshControllerRef.current = null
      if (activeContextRef.current === expectedContextKey) setRefreshing(false)
    }
  }

  const cancel = async () => {
    const currentRun = runRef.current
    if (!runIsActive(currentRun) || !currentRun || !runContext || cancelControllerRef.current) return
    if (!cancelArmed) {
      setCancelArmed(true)
      return
    }
    const controller = new AbortController()
    const unregister = registerController(controller)
    const expectedContext = runContext
    const expectedContextKey = contextKey
    const expectedRunId = currentRun.id
    cancelControllerRef.current = controller
    setCancelling(true)
    setLoadError('')
    try {
      const cancelled = await api.cancelPipelineRun(expectedRunId, { signal: controller.signal })
      if (activeContextRef.current === expectedContextKey
        && cancelled.id === expectedRunId
        && pipelineRunMatchesContext(cancelled, expectedContext)) {
        adoptForContext(cancelled, expectedContext, expectedContextKey, expectedRunId)
        setCancelArmed(false)
      }
    } catch (error) {
      if (!controller.signal.aborted && activeContextRef.current === expectedContextKey) {
        setLoadError(friendlyPipelineError(error, '取消生产任务失败'))
      }
    } finally {
      unregister()
      if (cancelControllerRef.current === controller) cancelControllerRef.current = null
      if (activeContextRef.current === expectedContextKey) setCancelling(false)
    }
  }

  const freezePipelineAttempt = (
    input: PipelineRunPreflightInput,
  ): PipelineIdempotencyAttempt => {
    if (!episode || !runContext || input.projectId !== runContext.projectId) {
      throw new Error('当前分集生产上下文已变更，请重新打开一键生产。')
    }
    return getOrCreatePipelineAttempt(
      idempotencyAttemptsRef.current,
      contextKey,
      normalizePipelinePreflightInput(input),
      () => crypto.randomUUID(),
    )
  }

  const createPipeline = async (
    input: CreatePipelineRunInput,
    frozenAttempt: PipelineIdempotencyAttempt,
  ): Promise<void> => {
    if (!episode || !runContext || input.projectId !== runContext.projectId) {
      throw new Error('当前分集生产上下文已变更，请重新打开一键生产。')
    }
    const normalizedInput = normalizePipelineCreateInput(input)
    const expectedContext = runContext
    const expectedContextKey = contextKey
    const attempt = getOrCreatePipelineAttempt(
      idempotencyAttemptsRef.current,
      expectedContextKey,
      normalizedInput,
      () => crypto.randomUUID(),
    )
    if (attempt.cacheKey !== frozenAttempt.cacheKey
      || attempt.idempotencyKey !== frozenAttempt.idempotencyKey) {
      throw new Error('预检确认与当前配置的幂等尝试不一致，请重新预检。')
    }
    const controller = new AbortController()
    const unregister = registerController(controller)
    try {
      const created = await api.createPipelineRun(
        episode.id,
        normalizedInput,
        attempt.idempotencyKey,
        { signal: controller.signal },
      )
      if (!pipelineRunMatchesContext(created, expectedContext)) {
        throw new ApiError('服务返回的一键生产任务不属于当前剧本修订。', {
          code: 'INVALID_RESPONSE',
          details: created,
        })
      }
      // Only strict API parsing reaches this line, so it is safe to forget the
      // ambiguous attempt even when the user changed context while awaiting it.
      completePipelineAttempt(idempotencyAttemptsRef.current, attempt)
      adoptForContext(created, expectedContext, expectedContextKey)
      if (activeContextRef.current === expectedContextKey
        && runRef.current?.id === created.id) {
        setLoadError('')
        setShowModal(false)
      }
    } catch (error) {
      const details = error instanceof ApiError
        && error.code === 'PIPELINE_RUN_ALREADY_ACTIVE'
        && error.details
        && typeof error.details === 'object'
        && !Array.isArray(error.details)
        ? error.details as Record<string, unknown>
        : null
      const activeRunId = typeof details?.pipelineRunId === 'string'
        ? details.pipelineRunId
        : null
      if (activeRunId) {
        try {
          const activeRun = await api.getPipelineRun(activeRunId, { signal: controller.signal })
          if (pipelineRunMatchesContext(activeRun, expectedContext)) {
            adoptForContext(activeRun, expectedContext, expectedContextKey, activeRunId)
            if (activeContextRef.current === expectedContextKey
              && runRef.current?.id === activeRun.id) {
              setLoadError('')
              setShowModal(false)
              return
            }
          }
        } catch (recoveryError) {
          if (controller.signal.aborted) throw recoveryError
          // Preserve the actionable already-active response rather than
          // replacing it with a secondary refresh failure.
        }
      }
      throw error
    } finally {
      unregister()
    }
  }

  return (
    <section className="pipeline-production-panel" aria-labelledby="pipeline-production-title">
      <header>
        <div className="pipeline-production-heading">
          <span><CloudCog size={15} /></span>
          <div>
            <strong id="pipeline-production-title">一键生产</strong>
            <small>配音 → 音频定镜长 → 分镜 → OpenCut 时间线 → 导出与质检</small>
          </div>
        </div>
        <div className="pipeline-production-actions">
          {run && (
            <button className="button secondary" disabled={refreshing} onClick={() => void refresh()}>
              <RefreshCcw className={refreshing ? 'pipeline-production-spin' : ''} size={13} />
              {refreshing ? '刷新中' : '继续刷新'}
            </button>
          )}
          {runIsActive(run) && (
            <button
              className={`button secondary pipeline-cancel-button ${cancelArmed ? 'armed' : ''}`}
              disabled={cancelling}
              aria-pressed={cancelArmed}
              onClick={() => void cancel()}
            >
              <Ban size={13} /> {cancelling ? '正在取消' : cancelArmed ? '确认取消' : '取消生产'}
            </button>
          )}
          <button
            className="button primary"
            disabled={!hasProductionContext || loading || runIsActive(run)}
            onClick={() => setShowModal(true)}
            title={!hasProductionContext ? '需要当前项目、有效剧本修订和至少一个镜头' : undefined}
          >
            <Sparkles size={14} /> {runIsActive(run)
              ? '正在生产'
              : automaticRepairAvailable
                ? '智能修复并继续'
                : run ? '发起新一轮' : '一键生产'}
          </button>
        </div>
      </header>

      {!hasProductionContext && (
        <div className="pipeline-production-empty">
          <CircleDashed size={14} /> 请先生成并保存包含镜头的有效剧本修订。没有生产上下文时不会发起生产请求或调用 AIGC。
        </div>
      )}

      {loading && !run && (
        <div className="pipeline-production-empty"><LoaderCircle className="pipeline-production-spin" size={14} /> 正在从 SQLite 恢复最近的生产任务…</div>
      )}

      {run && (
        <div className="pipeline-production-run" aria-live="polite">
          <div className="pipeline-production-progress">
            <div>
              <span className={`pipeline-run-state ${run.status}`}>{run.status === 'succeeded' ? <CheckCircle2 size={12} /> : runIsActive(run) ? <LoaderCircle className="pipeline-production-spin" size={12} /> : <CircleDashed size={12} />} {RUN_STATUS_LABELS[run.status]}</span>
              <small>Run {shortId(run.id)} · 源修订 {shortId(run.sourceRevisionId)}</small>
            </div>
            <strong>{Math.round(run.progress)}%</strong>
          </div>
          <div
            className="pipeline-production-progress-track"
            role="progressbar"
            aria-label="一键生产总进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(run.progress)}
          ><i style={{ width: `${run.progress}%` }} /></div>
          <div className="pipeline-production-steps">
            {STEP_IDS.map((stepId, index) => {
              const step = pipelineStep(run, stepId)
              return (
                <div className={`pipeline-production-step ${step.status}`} key={stepId}>
                  <span className="pipeline-production-step-index">{index + 1}</span>
                  <div>
                    <strong>{STEP_LABELS[stepId].title}</strong>
                    <small>{stepEvidence(run, stepId)}</small>
                    {step.error && <em title={step.error.code}>{pipelineErrorMessage(step.error.code, step.error.message, '该步骤执行失败')}</em>}
                  </div>
                  <span className="pipeline-production-step-status"><StepStatusIcon status={step.status} /> {STEP_STATUS_LABELS[step.status]}</span>
                </div>
              )
            })}
          </div>
          {run.steps.timeline.automaticEdit && (
            <div className="pipeline-production-auto-edit">
              <Sparkles size={15} />
              <div>
                <strong>Agentic 自动剪辑已固化到 OpenCut 时间线</strong>
                <span>
                  已安全执行 {run.steps.timeline.automaticEdit.operationCount} 个服务端规划、OpenCut 执行的白名单时间操作；可能包含受控对白/字幕同步、尾画面延长或同镜静帧补尾。不裁词、不移动 BGM/SFX，也不调用 AIGC Provider。
                </span>
                <small>
                  OpenCut UpdateElementsCommand · 计划 {shortId(run.steps.timeline.automaticEdit.planId ?? run.steps.timeline.automaticEdit.planHash)}
                  {run.steps.timeline.automaticEdit.applicationId
                    ? ` · 应用 ${shortId(run.steps.timeline.automaticEdit.applicationId)} · 若该应用仍是当前 head，可在时间线撤销为新修订`
                    : ' · 旧 Run 未记录独立 application'}
                </small>
              </div>
            </div>
          )}
          <footer>
            <span>图片 {run.bindings.imageProvider ? `${run.bindings.imageProvider.providerId}@r${run.bindings.imageProvider.configRevision}` : '未调用'}</span>
            <span>配音 {run.bindings.speechTargets?.length
              ? `${new Set(run.bindings.speechTargets.map((binding) => binding.characterId)).size} 个角色档案 · ${run.bindings.speechTargets.length} 句`
              : run.bindings.speechProvider
                ? `${run.bindings.speechProvider.providerId}@r${run.bindings.speechProvider.configRevision} · 旧任务`
                : run.options.speechMode === 'skip' ? '已跳过' : '未调用'}</span>
            <span>{run.options.resolution.toUpperCase()} · {run.options.burnSubtitles ? '烧录字幕' : '不烧录字幕'}</span>
          </footer>
          {run.error && <div className="pipeline-production-error" role="alert"><AlertTriangle size={13} /><div><strong>{run.error.code}</strong><span>{pipelineErrorMessage(run.error.code, run.error.message, '一键生产任务失败')}</span>{automaticRepairAvailable && <small>这是可诊断的时间线问题。点击“智能修复并继续”后，新 Run 会在导出前通过 OpenCut 原子操作修复；旧失败 Run 与旧时间线修订仍完整保留。</small>}</div></div>}
        </div>
      )}

      {loadError && <div className="pipeline-production-error" role="alert"><AlertTriangle size={13} /><span>{loadError}</span></div>}

      {showModal && episode && runContext && (
        <OneClickProductionModal
          key={contextKey}
          episode={episode}
          story={story}
          missingStoryboardCount={missingStoryboardCount}
          missingSpeechCount={missingSpeechCount}
          automaticRepairMode={Boolean(automaticRepairAvailable)}
          onClose={() => setShowModal(false)}
          onFreezeAttempt={freezePipelineAttempt}
          onSubmit={createPipeline}
        />
      )}
    </section>
  )
}

function OneClickProductionModal({
  episode,
  story,
  missingStoryboardCount,
  missingSpeechCount,
  automaticRepairMode,
  onClose,
  onFreezeAttempt,
  onSubmit,
}: {
  episode: EpisodeSummary
  story: StoryDocument | null
  missingStoryboardCount: number
  missingSpeechCount: number
  automaticRepairMode: boolean
  onClose: () => void
  onFreezeAttempt: (input: PipelineRunPreflightInput) => PipelineIdempotencyAttempt
  onSubmit: (
    input: CreatePipelineRunInput,
    attempt: PipelineIdempotencyAttempt,
  ) => Promise<void>
}) {
  const [resolution, setResolution] = useState<CreatePipelineRunInput['resolution']>('1080p')
  const [burnSubtitles, setBurnSubtitles] = useState(true)
  const [introTitle, setIntroTitle] = useState(true)
  const [outroCard, setOutroCard] = useState(true)
  const [reviewWatermark, setReviewWatermark] = useState(false)
  const [speechMode, setSpeechMode] = useState<CreatePipelineRunInput['speechMode']>('auto')
  const [imageProviderId, setImageProviderId] = useState('')
  const [providers, setProviders] = useState<ProviderConnection[]>([])
  const [providerError, setProviderError] = useState('')
  const [preflight, setPreflight] = useState<PipelineRunPreflight | null>(null)
  const [preflightConfigurationSignature, setPreflightConfigurationSignature] = useState('')
  const [attempt, setAttempt] = useState<PipelineIdempotencyAttempt | null>(null)
  const [clockNowMs, setClockNowMs] = useState(() => Date.now())
  const [preflighting, setPreflighting] = useState(false)
  const [preflightError, setPreflightError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submissionError, setSubmissionError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const submitLockRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const preflightControllerRef = useRef<AbortController | null>(null)

  const imageProviders = useMemo(() => providers.filter((provider) => (
    provider.kind === 'image'
  )), [providers])
  const selectedImageProvider = imageProviderId
    ? imageProviders.find((provider) => provider.id === imageProviderId)
    : undefined
  const imageProviderUnavailable = Boolean(
    selectedImageProvider && !isExecutablePipelineProvider(selectedImageProvider, 'image'),
  )
  const voiceRequired = speechMode === 'auto' && missingSpeechCount > 0
  const configurationReady = !imageProviderUnavailable
  const busy = submitting || preflighting
  const canPreflight = !busy && configurationReady
  const configuration = useMemo<PipelineRunPreflightInput>(() => normalizePipelinePreflightInput({
    projectId: episode.projectId,
    resolution,
    // Per-shot scale motion is already pinned in the OpenCut timeline and
    // compiled by RSP v4. Never add the retired export-wide Ken Burns layer.
    kenBurns: false,
    burnSubtitles,
    introTitle,
    outroCard,
    reviewWatermark,
    speechMode,
    ...(imageProviderId ? { imageProviderId } : {}),
  }), [
    burnSubtitles,
    episode.projectId,
    imageProviderId,
    introTitle,
    outroCard,
    resolution,
    reviewWatermark,
    speechMode,
  ])
  const configurationSignature = pipelineRequestCacheKey('preflight-form', configuration)
  const preflightMatchesConfiguration = preflightConfigurationSignature === configurationSignature
  const preflightExpired = preflight ? pipelinePreflightIsExpired(preflight, clockNowMs) : false
  const preflightRemainingSeconds = preflight
    ? pipelinePreflightRemainingSeconds(preflight, clockNowMs)
    : null
  const canSubmit = !busy && configurationReady && preflight?.canCreate === true
    && preflight.confirmationToken !== null && attempt !== null && !preflightExpired
    && preflightMatchesConfiguration

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    // A confirmation authenticates exactly one caller configuration. Any edit
    // returns the dialog to phase one before a paid create can be submitted.
    setPreflight(null)
    setPreflightConfigurationSignature('')
    setAttempt(null)
    setPreflightError('')
    setSubmissionError('')
  }, [configurationSignature])

  useEffect(() => {
    if (!preflight?.expiresAt) return
    setClockNowMs(Date.now())
    const intervalId = window.setInterval(() => setClockNowMs(Date.now()), 1_000)
    return () => window.clearInterval(intervalId)
  }, [preflight?.expiresAt])

  useEffect(() => () => {
    preflightControllerRef.current?.abort()
    preflightControllerRef.current = null
  }, [])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const dialog = dialogRef.current
    dialog?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitLockRef.current) {
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute('hidden'))
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
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void api.listProviders({ signal: controller.signal })
      .then(setProviders)
      .catch((error) => {
        if (!controller.signal.aborted) {
          setProviderError(friendlyPipelineError(error, '无法读取 Provider 配置'))
        }
      })
    return () => controller.abort()
  }, [])

  const runPreflight = async () => {
    if (!canPreflight || submitLockRef.current || preflightControllerRef.current) return
    const controller = new AbortController()
    preflightControllerRef.current = controller
    submitLockRef.current = true
    setPreflighting(true)
    setPreflight(null)
    setPreflightConfigurationSignature('')
    setPreflightError('')
    setSubmissionError('')
    try {
      const frozenAttempt = onFreezeAttempt(configuration)
      setAttempt(frozenAttempt)
      const prepared = await api.preflightPipelineRun(
        episode.id,
        configuration,
        frozenAttempt.idempotencyKey,
        { signal: controller.signal },
      )
      if (!episode.sourceRevisionId || prepared.sourceRevisionId !== episode.sourceRevisionId) {
        throw new ApiError('预检结果不属于当前剧本修订。', {
          code: 'INVALID_RESPONSE',
          details: prepared,
        })
      }
      setClockNowMs(Date.now())
      setPreflightConfigurationSignature(configurationSignature)
      setPreflight(prepared)
    } catch (error) {
      if (!controller.signal.aborted) {
        setPreflightError(friendlyPipelineError(error, '无法完成一键生产预检'))
      }
    } finally {
      if (preflightControllerRef.current === controller) preflightControllerRef.current = null
      submitLockRef.current = false
      setPreflighting(false)
    }
  }

  const submit = async () => {
    if (!canSubmit || !preflight?.confirmationToken || !attempt || submitLockRef.current) return
    submitLockRef.current = true
    setSubmitting(true)
    setSubmissionError('')
    setPreflightError('')
    const request = normalizePipelineCreateInput({
      ...configuration,
      confirmationToken: preflight.confirmationToken,
    })

    try {
      await onSubmit(request, attempt)
    } catch (error) {
      if (error instanceof ApiError
        && (error.code === 'PIPELINE_PREFLIGHT_CHANGED'
          || error.code === 'PIPELINE_PREFLIGHT_EXPIRED'
          || error.code === 'PIPELINE_PREFLIGHT_REQUIRED')) {
        setPreflight(null)
        setPreflightConfigurationSignature('')
        setPreflightError(friendlyPipelineError(error, '预检已失效，请重新确认'))
      } else {
        setSubmissionError(friendlyPipelineError(error, '无法创建一键生产任务'))
      }
    } finally {
      submitLockRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop pipeline-production-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
      <div
        ref={dialogRef}
        className="pipeline-production-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pipeline-production-dialog-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div><small>真实 AIGC 生产线</small><h2 id="pipeline-production-dialog-title">一键生产「{story?.title ?? episode.title}」</h2></div>
          <button aria-label="关闭一键生产设置" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>

        <div className="pipeline-production-billing-warning">
          <Coins size={17} />
          <div>
            <strong>{preflight
              ? preflight.canCreate ? '服务端权威付费媒体预检已完成' : '预检已阻断，当前不会计费'
              : '第一步只做图片 / TTS 计费与素材预检，不会创建付费任务'}</strong>
            <span>{preflight
              ? preflight.canCreate
                ? preflight.billableTargetCount === 0
                  ? `现有素材已齐全：本轮新增付费媒体任务 0；将复用 ${preflight.readyStoryboardCount} 个分镜与 ${preflight.readySpeechCount} 条音频，并进入时间线诊断、必要时安全自动剪辑、渲染与质检。`
                  : `本次将先新增 ${preflight.billableSpeechCount} 句语音合成；语音全部就绪后，才会新增 ${preflight.billableStoryboardCount} 个分镜生图，共 ${preflight.billableTargetCount} 个可计费图片 / TTS 任务。最终确认后才会建单。`
                : `发现 ${preflight.blockers.length} 个角色声线阻断。目录校验本身不计费，且当前没有创建任何生图或 TTS 任务。`
              : automaticRepairMode
                ? '本步骤尚不验证时间线。确认创建 Run 后，缺失素材任务可能先执行并计费；随后时间线步骤才会诊断，且只有通过正式导出语义校验的白名单操作会自动应用，否则 Run 明确失败。'
                : `页面当前估算缺失 ${missingStoryboardCount} 个分镜、${missingSpeechCount} 句配音；下一步将由服务端按实际文件、MIME、源修订和 Provider 版本重新核定。`}</span>
          </div>
        </div>

        <div className="pipeline-production-modal-grid">
          <section>
            <label id="pipeline-resolution-label">导出分辨率</label>
            <div className="preset-options" role="group" aria-labelledby="pipeline-resolution-label">{(['720p', '1080p'] as const).map((value) => <button aria-pressed={resolution === value} className={resolution === value ? 'active' : ''} disabled={busy} key={value} onClick={() => setResolution(value)}>{value.toUpperCase()}</button>)}</div>
          </section>
          <section>
            <label htmlFor="pipeline-image-provider">缺失分镜的图片 Provider</label>
            <select id="pipeline-image-provider" disabled={busy} value={imageProviderId} onChange={(event) => setImageProviderId(event.target.value)}>
              <option value="">使用后端默认图片 Provider</option>
              {imageProviders.map((provider) => {
                const executable = isExecutablePipelineProvider(provider, 'image')
                return <option disabled={!executable} value={provider.id} key={provider.id}>{provider.label}{provider.isDefault ? ' · 默认' : ''} · r{provider.configRevision}{executable ? '' : ' · 不可用'}</option>
              })}
            </select>
          </section>
          <section>
            <label id="pipeline-speech-mode-label">配音模式</label>
            <div className="preset-options" role="group" aria-labelledby="pipeline-speech-mode-label">
              <button aria-pressed={speechMode === 'auto'} className={speechMode === 'auto' ? 'active' : ''} disabled={busy} onClick={() => setSpeechMode('auto')}>自动补齐</button>
              <button aria-pressed={speechMode === 'skip'} className={speechMode === 'skip' ? 'active' : ''} disabled={busy} onClick={() => setSpeechMode('skip')}>跳过配音</button>
            </div>
          </section>
          <section className="pipeline-production-wide-field pipeline-production-voice-inheritance">
            <label>缺失配音：按角色声线档案继承</label>
            <p>{speechMode === 'auto'
              ? '服务端会逐句固化角色音色、Provider 修订与当前场景的情绪 / 语速 / 音高；不会接受手填 voice_id，也不会用一个默认音色覆盖所有角色。'
              : '已选择跳过配音；不会创建静音或假音频。'}</p>
          </section>
        </div>

        <div className="pipeline-production-options">
          <div className="pipeline-production-timeline-motion">
            <Sparkles size={13} />
            <span><strong>镜头运动来自 OpenCut 时间线</strong><small>新建生产不会再叠加旧的全局推拉效果。</small></span>
          </div>
          <label><input type="checkbox" checked={burnSubtitles} disabled={busy} onChange={(event) => setBurnSubtitles(event.target.checked)} /> 烧录字幕</label>
          <label><input type="checkbox" checked={introTitle} disabled={busy} onChange={(event) => setIntroTitle(event.target.checked)} /> 片头标题落版</label>
          <label><input type="checkbox" checked={outroCard} disabled={busy} onChange={(event) => setOutroCard(event.target.checked)} /> 片尾结束落版</label>
          <label><input type="checkbox" checked={reviewWatermark} disabled={busy} onChange={(event) => setReviewWatermark(event.target.checked)} /> 审片水印</label>
        </div>

        <div className="pipeline-production-route">
          {STEP_IDS.map((stepId, index) => <span key={stepId}><i>{index + 1}</i>{STEP_LABELS[stepId].title}</span>)}
        </div>

        {preflight && (
          <div className="pipeline-production-preflight" aria-live="polite">
            <header>
              <div>{preflight.canCreate ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}<strong>{preflight.canCreate ? preflight.billableTargetCount === 0 ? '素材已齐全，可直接进入成片流程' : '新增任务与角色声线已固定' : '预检发现角色声线阻断'}</strong></div>
              <small>
                源修订 {shortId(preflight.sourceRevisionId)}
                {preflight.expiresAt && (
                  <> · <Clock3 size={12} /> {preflightExpired
                    ? '确认已过期'
                    : `确认剩余 ${preflightCountdown(preflightRemainingSeconds)}`}</>
                )}
              </small>
            </header>
            <div className="pipeline-production-preflight-stats">
              <span><small>新增付费媒体任务</small><strong>{preflight.billableTargetCount}</strong><em>{preflight.billableTargetCount === 0 ? '无需新增调用' : `${preflight.billableStoryboardCount} 图 · ${preflight.billableSpeechCount} 音频`}</em></span>
              <span><small>复用分镜</small><strong>{preflight.readyStoryboardCount}</strong><em>{preflight.missingStoryboardCount ? `${preflight.missingStoryboardCount} 待补齐` : '全部已就绪'}</em></span>
              <span><small>复用音频</small><strong>{preflight.readySpeechCount}</strong><em>{preflight.hasPublishableAudio ? '已有可发布音频' : '本轮将补齐'}</em></span>
            </div>
            {speechMode === 'auto' && preflight.billableSpeechCount > 0 && (
              <div className="pipeline-production-voice-summary">
                <strong>{preflight.voiceSummary.boundCharacterCount} 个已绑定角色 · {preflight.voiceSummary.distinctVoiceCount} 个真实音色 · {preflight.voiceSummary.sceneDirectedTargetCount} 句使用场景指令</strong>
                {preflight.voiceSummary.characters.map((character) => (
                  <span key={character.characterId}>
                    <b>{character.characterName}</b>
                    <em>{character.voiceName} · {character.targetCount} 句{character.sceneDirectedTargetCount ? ` · ${character.sceneDirectedTargetCount} 句场景演绎` : ''}</em>
                  </span>
                ))}
              </div>
            )}
            {speechMode === 'auto' && preflight.billableSpeechCount === 0 && (
              <div className="pipeline-production-voice-summary">
                <strong>本轮不新增 TTS；直接复用 {preflight.readySpeechCount} 条已就绪音频，不需要重新核定角色声线。</strong>
              </div>
            )}
            <footer>
              <span>图片 {preflight.imageProvider ? `${preflight.imageProvider.providerId}@r${preflight.imageProvider.configRevision}` : '不调用'}</span>
              <span>配音 {preflight.speechProviders.length
                ? preflight.speechProviders.map((provider) => `${provider.providerId}@r${provider.configRevision}`).join('、')
                : '不调用'}</span>
            </footer>
          </div>
        )}

        {providerError && <div className="pipeline-production-inline-warning"><AlertTriangle size={13} /> {providerError}；仍可由后端解析默认 Provider。</div>}
        {imageProviderUnavailable && <div className="pipeline-production-inline-warning"><AlertTriangle size={13} /> 所选图片 Provider 缺少凭据或必要配置，请换用可用连接。</div>}
        {voiceRequired && !preflight && <div className="pipeline-production-inline-warning"><AlertTriangle size={13} /> 缺失配音将从角色档案继承；若角色未绑定、目录已变化或 Provider 修订漂移，预检会在零 TTS 调用时明确阻断。</div>}
        {preflight?.blockers.map((blocker) => <div className="pipeline-production-error" role="alert" key={`${blocker.code}:${blocker.characterId ?? 'unmatched'}`}><AlertTriangle size={13} /><span><strong>{blocker.characterName} · {blocker.lineCount} 句</strong>{blocker.message}<small>{blocker.code} · 未创建任何付费任务</small></span></div>)}
        {preflightExpired && <div className="pipeline-production-error" role="alert"><AlertTriangle size={13} /><span>本次权威预检已过期，确认按钮已禁用。<small>请重新预检以固定当前素材、声线与 Provider 版本。</small></span></div>}
        {speechMode === 'skip' && <div className="pipeline-production-inline-warning"><AlertTriangle size={13} /> 跳过配音不会伪造静音占位；若时间线没有可发布的配音、BGM 或音效，服务端会明确拒绝生产。</div>}
        {preflightError && <div className="pipeline-production-error" role="alert"><AlertTriangle size={13} /><span>{preflightError}<small>预检失效时不会创建付费任务。</small></span></div>}
        {submissionError && <div className="pipeline-production-error" role="alert"><AlertTriangle size={13} /><span>{submissionError}<small>关闭弹窗或切换配置也会保留每组未知结果的幂等键，严格确认后才清除。</small></span></div>}

        <footer>
          <small>{preflightExpired
            ? '预检确认已过期；必须重新读取权威素材与 Provider 状态后才能建单。'
            : preflight
            ? preflight.canCreate
              ? preflight.billableTargetCount === 0
                ? '确认后不会新增图片、TTS 或视频生成调用；系统只复用现有素材并继续时间线、渲染和质检。'
                : '确认会使用上方逐句固化的角色声线、场景指令与 Provider 修订；创建后可关闭页面。'
              : '请先到角色资产中修复声线配置，然后重新预检；当前没有确认能力。'
            : '预检只读取权威素材、真实音色目录与 Provider 状态，不会发起 TTS 或生图。'}</small>
          <div>
            <button className="button secondary" disabled={busy} onClick={onClose}>取消</button>
            {preflight && !preflightExpired ? (
              <button className="button primary" disabled={!canSubmit} onClick={() => void submit()}><CloudCog size={14} /> {submitting ? '正在创建持久任务…' : preflight.billableTargetCount === 0 ? '复用现有素材并开始成片' : `确认 ${preflight.billableTargetCount} 项新增任务并开始生产`}</button>
            ) : (
              <button className="button primary" disabled={!canPreflight} onClick={() => void runPreflight()}><CloudCog size={14} /> {preflighting ? '正在核定图片 / TTS 计费目标…' : preflightExpired ? '预检已过期，重新预检' : '第一步：权威预检'}</button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
