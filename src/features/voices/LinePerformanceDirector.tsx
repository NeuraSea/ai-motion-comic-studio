import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  CircleDashed,
  RefreshCcw,
  SlidersHorizontal,
  Sparkles,
  Undo2,
} from 'lucide-react'

import {
  ApiError,
  api,
  type DialoguePerformanceProfile,
  type DialoguePerformanceRecommendationJob,
  type ProviderConnection,
} from '../../lib'
import {
  providerStatusDetail,
  providerUiConnectionState,
} from '../providers/provider-ui-state'
import {
  freezeDialoguePerformanceRecommendationAttempt,
  type FrozenDialoguePerformanceRecommendationAttempt,
} from './dialogue-paid-confirmation-state'
import { linePerformanceSummary, recommendationCanBeAdopted } from './line-performance-state'
import './LinePerformanceDirector.css'

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'waiting_provider'])

export function LinePerformanceDirector({
  projectId,
  episodeId,
  sourceRevisionId,
  voiceProfileRevision,
  lineId,
  inheritedLabel,
  textProvider,
  onConfigureProvider,
  onProfileChange,
  children,
}: {
  projectId: string
  episodeId: string
  sourceRevisionId: string | null
  voiceProfileRevision: string | null
  lineId: string
  inheritedLabel: string
  textProvider: ProviderConnection | null
  onConfigureProvider: () => void
  onProfileChange: (profile: DialoguePerformanceProfile | null) => void
  children: ReactNode
}) {
  const [profile, setProfile] = useState<DialoguePerformanceProfile | null>(null)
  const [profileEtag, setProfileEtag] = useState('')
  const [job, setJob] = useState<DialoguePerformanceRecommendationJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [pollTick, setPollTick] = useState(0)
  const [action, setAction] = useState<'idle' | 'confirming' | 'deleting'>('idle')
  const [error, setError] = useState('')
  const [preparing, setPreparing] = useState(false)
  const preparingRef = useRef(false)
  const attempt = useRef<FrozenDialoguePerformanceRecommendationAttempt | null>(null)
  const currentIntentSignature = textProvider
    ? [
        projectId,
        episodeId,
        sourceRevisionId ?? 'no-source-revision',
        voiceProfileRevision ?? 'no-voice-profile',
        lineId,
        textProvider.id,
        textProvider.configRevision,
      ].join(':')
    : ''
  const onProfileChangeRef = useRef(onProfileChange)
  onProfileChangeRef.current = onProfileChange

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setProfile(null)
    setProfileEtag('')
    setJob(null)
    setError('')
    setAction('idle')
    setPreparing(false)
    preparingRef.current = false
    attempt.current = null
    void api.getDialoguePerformanceProfile(
      lineId,
      projectId,
      episodeId,
      { signal: controller.signal },
    ).then((state) => {
      setProfile(state.profile)
      setProfileEtag(state.etag)
      onProfileChangeRef.current(state.profile)
    }).catch((cause: unknown) => {
      if (!(cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) {
        setError(cause instanceof Error ? cause.message : '无法读取逐句表演档案')
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [episodeId, lineId, projectId, sourceRevisionId, voiceProfileRevision])

  useEffect(() => {
    if (!attempt.current || attempt.current.signature === currentIntentSignature) return
    // Provider revision drift invalidates the frozen direct-submission intent.
    attempt.current = null
    setError('文本 Provider 配置已变化，请重新点击 AI 导演')
  }, [currentIntentSignature])

  useEffect(() => {
    if (!job || !ACTIVE_JOB_STATUSES.has(job.status)) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void api.getDialoguePerformanceRecommendationJob(job.id, lineId, {
        signal: controller.signal,
      }).then((updated) => {
        setJob(updated)
        if (updated.status === 'succeeded') {
          setError('')
          attempt.current = null
        } else if (updated.status === 'failed' || updated.status === 'cancelled') {
          attempt.current = null
          setError(updated.error?.message ?? '逐句 AI 导演任务未完成')
        }
      }).catch((cause: unknown) => {
        if (!(cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) {
          setError(cause instanceof Error ? cause.message : '无法刷新逐句 AI 导演任务')
        }
      }).finally(() => {
        if (!controller.signal.aborted) setPollTick((value) => value + 1)
      })
    }, 800)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [job, lineId, pollTick])

  const providerState = providerUiConnectionState(textProvider ?? undefined)
  const providerReady = providerState === 'connected'
  const providerBlockReason = !textProvider
    ? '尚未配置默认文本 Provider。'
    : providerState === 'untested'
      ? '文本 Provider 已保存但尚未测试连接。'
      : providerState === 'connected'
        ? null
        : providerStatusDetail(textProvider)
  const active = Boolean(job && ACTIVE_JOB_STATUSES.has(job.status))
  const canAdopt = recommendationCanBeAdopted(job, lineId)
  const recommendation = canAdopt ? job.output.recommendation : null

  const startRecommendation = async () => {
    if (!providerReady
      || !textProvider
      || active
      || action !== 'idle'
      || preparingRef.current) return
    const signature = currentIntentSignature
    const currentAttempt = attempt.current?.signature === signature
      ? attempt.current
      : freezeDialoguePerformanceRecommendationAttempt({
          signature,
          lineId,
          idempotencyKey: crypto.randomUUID(),
          request: {
            projectId,
            episodeId,
            textProviderId: textProvider.id,
          },
        })
    attempt.current = currentAttempt
    preparingRef.current = true
    setPreparing(true)
    setError('')
    setJob(null)
    try {
      const created = await api.createDialoguePerformanceRecommendation(
        currentAttempt.lineId,
        currentAttempt.input,
        currentAttempt.idempotencyKey,
      )
      setJob(created)
      if (created.status === 'succeeded') attempt.current = null
      if (created.status === 'failed' || created.status === 'cancelled') {
        attempt.current = null
        setError(created.error?.message ?? '逐句 AI 导演任务未完成')
      }
    } catch (cause) {
      const ambiguous = !(cause instanceof ApiError)
        || cause.status === 0
        || cause.status >= 500
      if (!ambiguous && attempt.current === currentAttempt) attempt.current = null
      const message = cause instanceof Error ? cause.message : '无法创建逐句 AI 导演任务'
      setError(ambiguous
        ? `${message}；结果可能未知，再次点击会复用同一 Idempotency-Key`
        : message)
    } finally {
      preparingRef.current = false
      setPreparing(false)
    }
  }

  const adoptRecommendation = async () => {
    if (!recommendation || !job || !profileEtag || action !== 'idle') return
    setAction('confirming')
    setError('')
    try {
      const confirmed = await api.putDialoguePerformanceProfile(lineId, {
        projectId,
        episodeId,
        recommendationJobId: job.id,
        etag: profileEtag,
      })
      setProfile(confirmed.profile)
      setProfileEtag(confirmed.etag)
      setJob(null)
      onProfileChangeRef.current(confirmed.profile)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法采用逐句 AI 表演建议')
    } finally {
      setAction('idle')
    }
  }

  const deleteProfile = async () => {
    if (!profile || !profileEtag || active || action !== 'idle') return
    setAction('deleting')
    setError('')
    try {
      const cleared = await api.deleteDialoguePerformanceProfile(lineId, {
        projectId,
        episodeId,
        etag: profileEtag,
      })
      setProfile(null)
      setProfileEtag(cleared.etag)
      onProfileChangeRef.current(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法撤销逐句 AI 表演')
    } finally {
      setAction('idle')
    }
  }

  return (
    <>
      <section className="line-performance-director" aria-label="逐句 AI 表演">
      <header>
        <span className="line-performance-icon"><Bot size={15} /></span>
        <div>
          <small>逐句导演</small>
          <strong>{linePerformanceSummary(profile, inheritedLabel)}</strong>
        </div>
        {profile && <em><Check size={11} />已采用</em>}
      </header>

      {loading ? (
        <div className="line-performance-status"><CircleDashed size={13} />正在读取已确认的逐句表演…</div>
      ) : profile ? (
        <div className="line-performance-current">
          <p>{profile.rationale}</p>
          <small>{profile.pausePlan.length ? `已规划 ${profile.pausePlan.length} 处节奏停顿` : '使用连续表达'}{profile.openingSoundTag ? ' · 已含安全开场语气' : ''}</small>
        </div>
      ) : (
        <p className="line-performance-empty">未单独导演这一句；合成时继续使用{inheritedLabel}。</p>
      )}

      {active && (
        <div className="line-performance-status active" aria-live="polite">
          <CircleDashed size={13} />
          <span>当前文本模型正在导演 · {job?.progress ?? 0}%</span>
        </div>
      )}

      {recommendation && (
        <div className="line-performance-suggestion">
          <header><Sparkles size={13} /><span><small>待确认建议 · 尚未影响配音</small><strong>{linePerformanceSummary(recommendation, inheritedLabel)}</strong></span></header>
          <p>{recommendation.rationale}</p>
          <small>{recommendation.pausePlan.length ? `建议 ${recommendation.pausePlan.length} 处节奏停顿` : '建议连续表达'}{recommendation.openingSoundTag ? ' · 包含开场语气' : ''}</small>
          <footer>
            <button type="button" className="button secondary" disabled={action !== 'idle'} onClick={() => setJob(null)}>放弃建议</button>
            <button type="button" className="button primary" disabled={action !== 'idle'} onClick={() => void adoptRecommendation()}>
              <Check size={12} />{action === 'confirming' ? '采用中…' : '采用这次表演'}
            </button>
          </footer>
        </div>
      )}

      {error && <div className="line-performance-error"><AlertTriangle size={13} /><span>{error}</span>{active && <button type="button" onClick={() => setPollTick((value) => value + 1)}><RefreshCcw size={11} />刷新</button>}</div>}

      {!recommendation && (
        <div className="line-performance-agent-actions">
          <div className="line-performance-billing-note"><Bot size={12} /><span>AI 导演属于平台内免费的文本理解；只生成建议，不会自动采用或提交 TTS。</span></div>
          {providerBlockReason && (
            <div className="line-performance-provider-block">
              <span>{providerBlockReason}</span>
              <button type="button" onClick={onConfigureProvider}>设置</button>
            </div>
          )}
          <div className="line-performance-buttons">
            {profile && (
              <button type="button" className="button secondary" disabled={active || action !== 'idle'} onClick={() => void deleteProfile()}>
                <Undo2 size={12} />{action === 'deleting' ? '撤销中…' : '撤销逐句表演'}
              </button>
            )}
            <button type="button" className="button secondary line-performance-agent-button" disabled={!providerReady || active || action !== 'idle' || preparing} onClick={() => void startRecommendation()}>
              <Bot size={13} />{preparing ? '提交中…' : active ? `AI 导演中 ${job?.progress ?? 0}%` : profile ? '重新导演' : 'AI 导演'}
            </button>
          </div>
        </div>
      )}

      <details className="line-performance-advanced">
        <summary><span><SlidersHorizontal size={13} />高级手动微调</span><small>仅覆盖本次单句合成</small><ChevronDown size={13} /></summary>
        <div>{children}</div>
      </details>
      </section>
    </>
  )
}
