import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Film,
  History,
  Image as ImageIcon,
  LoaderCircle,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react'
import type {
  HistoricalShotVideoCandidate,
  ShotMediaCandidate,
  ShotMediaReviewDecision,
  ShotMediaReviewSnapshot,
  ShotMediaType,
} from '../../lib'
import { availableShotMediaReviewDecisions } from './shot-media-review-state'
import './ShotMediaReviewPanel.css'

type ReviewSnapshots = Partial<Record<ShotMediaType, ShotMediaReviewSnapshot>>

export interface ShotMediaReviewPanelProps {
  reviews: ReviewSnapshots
  loading: boolean
  error: string
  actionKey: string | null
  timelineState: 'clean' | 'required' | 'reconciling' | 'ready' | 'error'
  timelineMessage: string
  historicalVideos: HistoricalShotVideoCandidate[]
  onRefresh: () => void
  onDecision: (
    mediaType: ShotMediaType,
    decision: ShotMediaReviewDecision,
    candidate: ShotMediaCandidate,
    note: string,
  ) => Promise<void>
  onRestoreHistoricalVideo: (candidate: HistoricalShotVideoCandidate) => Promise<void>
}

const mediaLabels: Record<ShotMediaType, string> = {
  storyboard: '分镜图',
  video: '逐镜视频',
}

const decisionLabels: Record<ShotMediaReviewDecision, string> = {
  adopt: '采用',
  reject: '拒绝',
  restore: '恢复',
}

function compactDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function MediaPreview({ candidate }: { candidate: ShotMediaCandidate }) {
  if (candidate.mimeType.startsWith('video/')) {
    return (
      <video controls preload="metadata" src={candidate.url}>
        当前浏览器无法播放此视频。
      </video>
    )
  }
  return <img src={candidate.url} alt={`候选分镜 v${candidate.version}`} />
}

export function ShotMediaReviewPanel({
  reviews,
  loading,
  error,
  actionKey,
  timelineState,
  timelineMessage,
  historicalVideos,
  onRefresh,
  onDecision,
  onRestoreHistoricalVideo,
}: ShotMediaReviewPanelProps) {
  const [activeType, setActiveType] = useState<ShotMediaType>('video')
  const review = reviews[activeType] ?? null
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null)
  const [pendingDecision, setPendingDecision] = useState<{
    assetId: string
    decision: ShotMediaReviewDecision
  } | null>(null)
  const [note, setNote] = useState('')

  const candidates = useMemo(() => {
    if (!review) return []
    const values = review.currentSelection
      && !review.candidates.some((candidate) => candidate.id === review.currentSelection?.id)
      ? [review.currentSelection, ...review.candidates]
      : review.candidates
    return values
  }, [review])
  const focused = candidates.find((candidate) => candidate.id === focusedAssetId)
    ?? review?.currentSelection
    ?? candidates[0]
    ?? null
  const decisions = focused && review
    ? availableShotMediaReviewDecisions(focused, review.history)
    : []

  useEffect(() => {
    setFocusedAssetId(null)
    setPendingDecision(null)
    setNote('')
  }, [activeType, review?.shotId, review?.sourceRevisionId])

  const startDecision = (decision: ShotMediaReviewDecision) => {
    if (!focused) return
    setPendingDecision({ assetId: focused.id, decision })
    setNote('')
  }

  const submitDecision = async () => {
    if (!focused || !pendingDecision || pendingDecision.assetId !== focused.id) return
    try {
      await onDecision(activeType, pendingDecision.decision, focused, note.trim())
    } catch {
      // The parent surfaces the authoritative API error and preserves this confirmation for retry.
      return
    }
    setPendingDecision(null)
    setNote('')
  }

  return (
    <section className="shot-media-review" aria-label="镜头素材审片">
      <header>
        <div>
          <ShieldCheck size={14} />
          <span><strong>真实素材选版</strong><small>本地 Asset · 不可变审计</small></span>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading || actionKey !== null} title="刷新候选与历史">
          <RefreshCcw size={12} className={loading ? 'spin' : ''} />
        </button>
      </header>

      <div className="shot-media-review-tabs" role="tablist" aria-label="审片素材类型">
        {(['storyboard', 'video'] as const).map((mediaType) => (
          <button
            key={mediaType}
            type="button"
            role="tab"
            aria-selected={activeType === mediaType}
            className={activeType === mediaType ? 'active' : ''}
            onClick={() => setActiveType(mediaType)}
          >
            {mediaType === 'storyboard' ? <ImageIcon size={12} /> : <Film size={12} />}
            {mediaLabels[mediaType]}
            <b>{reviews[mediaType]?.candidates.length ?? 0}</b>
            {mediaType === 'video' && historicalVideos.length > 0 && (
              <em>+{historicalVideos.length} 可恢复</em>
            )}
          </button>
        ))}
      </div>

      {timelineState !== 'clean' && (
        <div className={`shot-media-timeline-notice state-${timelineState}`}>
          {timelineState === 'reconciling' ? <LoaderCircle size={13} className="spin" />
            : timelineState === 'ready' ? <CheckCircle2 size={13} />
              : <AlertTriangle size={13} />}
          <span>{timelineMessage || (timelineState === 'required'
            ? '采用版本已变更，OpenCut 时间线需重新对账后才能预览或导出。'
            : '正在同步 OpenCut 时间线。')}</span>
        </div>
      )}

      {error && <div className="shot-media-review-error"><AlertTriangle size={13} /><span>{error}</span></div>}

      {loading && !review ? (
        <div className="shot-media-review-empty"><LoaderCircle size={18} className="spin" />正在读取权威选版…</div>
      ) : !review ? (
        <div className="shot-media-review-empty">尚未读取到{mediaLabels[activeType]}审片数据。</div>
      ) : (
        <>
          <div className="shot-media-current">
            <span>当前权威版本</span>
            <strong>{review.currentSelection ? `v${review.currentSelection.version}` : '未采用'}</strong>
            <small>{review.currentSelection
              ? `${review.currentSelection.id.slice(0, 14)}… · ${review.currentSelection.checksum.slice(0, 8)}`
              : '候选素材不会自动被采用'}</small>
          </div>

          {focused ? (
            <>
              <div className="shot-media-review-preview">
                <MediaPreview candidate={focused} />
                <span className={focused.selected ? 'selected' : ''}>
                  {focused.selected ? '当前采用' : `候选 v${focused.version}`}
                </span>
              </div>
              <div className="shot-media-review-meta">
                <span>v{focused.version}</span>
                <span>{focused.width && focused.height ? `${focused.width}×${focused.height}` : '尺寸未知'}</span>
                {focused.durationSeconds !== null && <span>{focused.durationSeconds.toFixed(1)}s</span>}
                <span>{compactDate(focused.createdAt)}</span>
              </div>
              {!focused.eligible && focused.eligibilityError && (
                <div className="shot-media-candidate-warning">
                  <AlertTriangle size={12} />
                  <span>{focused.eligibilityError}。该历史素材仅供查看，不能采用。</span>
                </div>
              )}
            </>
          ) : (
            <div className="shot-media-review-empty">当前镜头尚无可审阅的{mediaLabels[activeType]}。</div>
          )}

          {candidates.length > 0 && (
            <div className="shot-media-candidates">
              <div className="shot-media-subheading"><strong>候选版本</strong><small>{candidates.length} 个本地受控 Asset</small></div>
              <div className="shot-media-candidate-list">
                {candidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`${focused?.id === candidate.id ? 'active' : ''} ${candidate.selected ? 'selected' : ''} ${candidate.eligible ? '' : 'ineligible'}`}
                    title={candidate.eligibilityError ?? undefined}
                    onClick={() => {
                      setFocusedAssetId(candidate.id)
                      setPendingDecision(null)
                      setNote('')
                    }}
                  >
                    <span className="candidate-thumb">{candidate.mimeType.startsWith('video/')
                      ? <video src={candidate.url} preload="metadata" muted playsInline />
                      : <img src={candidate.url} alt="" />}</span>
                    <div>
                      <strong>v{candidate.version}</strong>
                      <small>{candidate.eligibilityError ?? `${candidate.id.slice(0, 16)}…`}</small>
                    </div>
                    {candidate.selected ? <CheckCircle2 size={13} /> : candidate.lastDecision === 'reject' ? <X size={13} /> : null}
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeType === 'video' && historicalVideos.length > 0 && (
            <div className="shot-media-restorable-history" aria-label="可恢复的旧修订逐镜视频">
              <div className="shot-media-subheading">
                <strong><RotateCcw size={12} /> 可恢复历史</strong>
                <small>{historicalVideos.length} 个语义完全一致的旧修订 Asset</small>
              </div>
              <p>恢复会复制为当前修订的新不可变版本并写入选版审计；不会修改旧文件，也不会调用 Provider。</p>
              <div className="shot-media-restorable-list">
                {historicalVideos.map((candidate) => {
                  const busy = actionKey === `video-history:restore:${candidate.asset.id}`
                  return (
                    <article key={candidate.asset.id}>
                      <video
                        controls
                        preload="metadata"
                        src={`/api/v1/assets/${encodeURIComponent(candidate.asset.id)}/content`}
                      >当前浏览器无法播放此历史视频。</video>
                      <div>
                        <strong>历史 v{candidate.asset.version}</strong>
                        <small>
                          旧修订 {candidate.priorSourceRevisionId.slice(0, 8)} · 当前 {candidate.currentSourceRevisionId.slice(0, 8)}
                        </small>
                        <small>{candidate.asset.durationSeconds !== null
                          ? `${candidate.asset.durationSeconds.toFixed(1)}s · `
                          : ''}快照与镜头身份已精确校验</small>
                      </div>
                      <button
                        type="button"
                        className="decision-restore"
                        disabled={actionKey !== null}
                        onClick={() => void onRestoreHistoricalVideo(candidate).catch(() => undefined)}
                      >
                        {busy ? <LoaderCircle size={12} className="spin" /> : <RotateCcw size={12} />}
                        {busy ? '恢复中…' : '恢复到当前修订'}
                      </button>
                    </article>
                  )
                })}
              </div>
            </div>
          )}

          {focused && (decisions.length > 0 || pendingDecision?.assetId === focused.id) && (
            <div className="shot-media-decision-zone">
              {!pendingDecision ? (
                <div className="shot-media-decision-buttons">
                  {decisions.map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      className={`decision-${decision}`}
                      disabled={actionKey !== null}
                      onClick={() => startDecision(decision)}
                    >
                      {decision === 'restore' ? <RotateCcw size={12} /> : decision === 'reject' ? <X size={12} /> : <Check size={12} />}
                      {decisionLabels[decision]} v{focused.version}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="shot-media-decision-confirm">
                  <strong>确认{decisionLabels[pendingDecision.decision]} v{focused.version}</strong>
                  <textarea
                    value={note}
                    maxLength={1000}
                    placeholder="选版备注（可选，将写入不可变审计）"
                    onChange={(event) => setNote(event.target.value)}
                  />
                  <div>
                    <small>{note.length}/1000 · 不会调用 Provider 或创建计费任务</small>
                    <button type="button" onClick={() => setPendingDecision(null)} disabled={actionKey !== null}>取消</button>
                    <button type="button" className="primary" onClick={() => void submitDecision()} disabled={actionKey !== null}>
                      {actionKey !== null && <LoaderCircle size={12} className="spin" />}
                      写入决策
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="shot-media-history">
            <div className="shot-media-subheading"><strong><History size={12} /> 不可变历史</strong><small>{review.history.length} 条</small></div>
            {review.history.length === 0 ? (
              <p>尚无人工审片决策。</p>
            ) : (
              <ol>
                {review.history.map((record) => (
                  <li key={record.id}>
                    <span className={`decision-${record.decision}`}>{decisionLabels[record.decision]}</span>
                    <div>
                      <strong>{record.assetId.slice(0, 16)}…</strong>
                      <small>{compactDate(record.createdAt)}{record.timelineReconcileRequired ? ' · 需重建时间线' : ' · 无需重建'}</small>
                      {record.clearedVideoAssetId && (
                        <p className="cleared-video">旧逐镜视频已解除当前选中，历史 Asset 仍完整保留。</p>
                      )}
                      {record.note && <p>{record.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </section>
  )
}
