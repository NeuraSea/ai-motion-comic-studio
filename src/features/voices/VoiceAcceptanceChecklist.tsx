import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CircleDashed,
  RefreshCcw,
  ShieldCheck,
  Volume2,
  X,
} from 'lucide-react'

import { ApiError, api } from '../../lib'
import {
  buildVoiceAcceptanceItems,
  type VoiceAcceptanceItem,
  type VoiceAcceptanceTarget,
} from './voice-acceptance-state'
import { VoicePreviewReviewControl } from './VoicePreviewReviewControl'
import {
  createAudioPlaybackEvidence,
  type VoicePreviewPlaybackEvidence,
} from './voice-preview-playback'
import './CharacterVoiceCastingCard.css'

const STATUS_COPY: Record<VoiceAcceptanceItem['status'], string> = {
  'profile-missing': '尚未绑定声线',
  'preview-missing': '缺少当前修订的独立试听',
  'review-pending': '试听已就绪 · 待完整播放验收',
  approved: '当前试听已通过',
  rejected: '当前试听已淘汰 · 请重新选声线',
}

export function VoiceAcceptanceChecklist({
  projectId,
  episodeId,
  sourceRevisionId,
  targets,
  onOpen,
}: {
  projectId: string
  episodeId: string
  sourceRevisionId: string
  targets: readonly VoiceAcceptanceTarget[]
  onOpen: (target: VoiceAcceptanceTarget) => void
}) {
  const [items, setItems] = useState<VoiceAcceptanceItem[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [playbackEvidenceByJobId, setPlaybackEvidenceByJobId] = useState<ReadonlyMap<
    string,
    VoicePreviewPlaybackEvidence
  >>(() => new Map())
  const [incompleteJobId, setIncompleteJobId] = useState<string | null>(null)
  const targetsFingerprint = useMemo(
    () => targets.map((target) => `${target.key}:${target.voiceId ?? '-'}`).join('|'),
    [targets],
  )

  const load = useCallback(async (signal?: AbortSignal) => {
    setState('loading')
    setError('')
    try {
      const [narratorJobs, characterJobs] = await Promise.all([
        api.listProjectNarratorVoicePreviewJobs(projectId, { limit: 100, signal }),
        api.listCharacterVoicePreviewJobs(projectId, { limit: 100, signal }),
      ])
      const relevantJobIds = new Set<string>()
      for (const target of targets) {
        const jobs = target.subjectType === 'project_narrator' ? narratorJobs : characterJobs
        for (const job of jobs) {
          if (job.episodeId !== episodeId
            || job.input.episodeId !== episodeId
            || job.input.expectedStoryRevisionId !== sourceRevisionId
            || job.input.voiceId !== target.voiceId
            || job.status !== 'succeeded'
            || !job.output) continue
          if (target.subjectType === 'character'
            && 'characterId' in job.input
            && job.input.characterId !== target.subjectId) continue
          relevantJobIds.add(job.id)
        }
      }
      const reviewEntries = await Promise.all([...relevantJobIds].map(async (jobId) => (
        [jobId, await api.listVoicePreviewReviews(jobId, projectId, { signal })] as const
      )))
      if (signal?.aborted) return
      setItems(buildVoiceAcceptanceItems({
        episodeId,
        sourceRevisionId,
        targets,
        narratorJobs,
        characterJobs,
        reviewsByJobId: new Map(reviewEntries),
      }))
      setState('ready')
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'REQUEST_ABORTED') return
      setError(cause instanceof Error ? cause.message : '无法读取声线试听验收状态')
      setState('error')
    }
  }, [episodeId, projectId, sourceRevisionId, targetsFingerprint])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const approved = items.filter((item) => item.status === 'approved').length
  return (
    <section className="voice-acceptance-checklist" aria-label="MVP 声线试听验收待办">
      <header>
        <div>
          <ShieldCheck size={17} />
          <span>
            <strong>MVP 声线试听验收</strong>
            <small>只读取持久 Job 与不可变人工决定；打开播放器不会生成或计费。</small>
          </span>
        </div>
        <div className="voice-acceptance-summary">
          <strong>{state === 'ready' ? `${approved}/${items.length}` : '—'}</strong>
          <span>已通过</span>
          <button type="button" onClick={() => void load()} disabled={state === 'loading'}>
            <RefreshCcw size={12} />刷新
          </button>
        </div>
      </header>
      {state === 'loading' ? (
        <div className="voice-acceptance-message"><CircleDashed className="spin" size={14} />正在核对当前 Story/声线/试听绑定…</div>
      ) : state === 'error' ? (
        <div className="voice-acceptance-message error"><AlertTriangle size={14} />{error}</div>
      ) : (
        <div className="voice-acceptance-items">
          {items.map((item) => (
            <article
              key={item.target.key}
              className={`${item.status}${expandedKey === item.target.key ? ' expanded' : ''}`}
            >
              <span className="voice-acceptance-icon">
                {item.status === 'approved' ? <Check size={14} />
                  : item.status === 'rejected' ? <X size={14} />
                    : <Volume2 size={14} />}
              </span>
              <div>
                <strong>{item.target.name}</strong>
                <small>{STATUS_COPY[item.status]}</small>
              </div>
              <button
                type="button"
                aria-expanded={item.previewJobId ? expandedKey === item.target.key : undefined}
                onClick={() => {
                  if (!item.previewJobId) {
                    onOpen(item.target)
                    return
                  }
                  setExpandedKey((current) => current === item.target.key ? null : item.target.key)
                  setIncompleteJobId(null)
                }}
              >
                {item.previewJobId
                  ? expandedKey === item.target.key ? '收起' : item.status === 'review-pending' ? '立即验收' : '查看试听'
                  : '打开配置'}
              </button>
              {expandedKey === item.target.key && item.previewJobId && item.previewAssetUrl && (
                <div className="voice-acceptance-inline-review">
                  <audio
                    key={item.previewJobId}
                    controls
                    preload="metadata"
                    src={item.previewAssetUrl}
                    onEnded={(event) => {
                      const evidence = createAudioPlaybackEvidence(
                        event.currentTarget.played,
                        event.currentTarget.duration,
                      )
                      if (evidence) {
                        setPlaybackEvidenceByJobId((current) => new Map(current).set(item.previewJobId!, evidence))
                        setIncompleteJobId(null)
                      } else {
                        setPlaybackEvidenceByJobId((current) => {
                          const next = new Map(current)
                          next.delete(item.previewJobId!)
                          return next
                        })
                        setIncompleteJobId(item.previewJobId)
                      }
                    }}
                  >
                    当前浏览器不支持音频播放。
                  </audio>
                  {incompleteJobId === item.previewJobId && (
                    <small className="voice-preview-playback-warning">检测到跳播；请从头完整播放后再验收。</small>
                  )}
                  <VoicePreviewReviewControl
                    projectId={projectId}
                    jobId={item.previewJobId}
                    playbackEvidence={playbackEvidenceByJobId.get(item.previewJobId) ?? null}
                    onReviewCreated={() => void load()}
                  />
                  <button type="button" className="voice-acceptance-open-profile" onClick={() => onOpen(item.target)}>
                    打开声线配置与历史
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
