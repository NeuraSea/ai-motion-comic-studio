import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, CircleDashed, X } from 'lucide-react'

import { ApiError, api, type VoicePreviewReview } from '../../lib'
import type { VoicePreviewPlaybackEvidence } from './voice-preview-playback'

export function voicePreviewReviewInvalidationMessage(
  review: Pick<VoicePreviewReview, 'isCurrent' | 'invalidReasons'>,
): string | null {
  if (review.isCurrent) return null
  if (review.invalidReasons.includes('PLAYBACK_EVIDENCE_LEGACY')) {
    return '旧播放证据，需重新完整试听'
  }
  return '绑定条件已变化，需重新试听当前版本'
}

export function VoicePreviewReviewControl({
  projectId,
  jobId,
  playbackEvidence,
  onReviewCreated,
}: {
  projectId: string
  jobId: string
  playbackEvidence: VoicePreviewPlaybackEvidence | null
  onReviewCreated?: (review: VoicePreviewReview) => void
}) {
  const [reviews, setReviews] = useState<VoicePreviewReview[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const attempt = useRef<{ signature: string; idempotencyKey: string } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setReviews([])
    attempt.current = null
    void api.listVoicePreviewReviews(jobId, projectId, { signal: controller.signal })
      .then(setReviews)
      .catch((cause: unknown) => {
        if (!(cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) {
          setError(cause instanceof Error ? cause.message : '无法恢复试听验收记录')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [jobId, projectId])

  const submit = async (decision: 'approve' | 'reject') => {
    if (!playbackEvidence || submitting) return
    const normalizedNotes = notes.trim()
    if (decision === 'reject' && !normalizedNotes) {
      setError('淘汰试听时请填写听感原因，便于后续重新选角。')
      return
    }
    const signature = JSON.stringify({
      projectId,
      jobId,
      decision,
      notes: normalizedNotes || null,
      playbackEvidence,
    })
    const currentAttempt = attempt.current?.signature === signature
      ? attempt.current
      : { signature, idempotencyKey: crypto.randomUUID() }
    attempt.current = currentAttempt
    setSubmitting(true)
    setError('')
    try {
      const review = await api.createVoicePreviewReview(jobId, {
        projectId,
        decision,
        playbackCompleted: true,
        playbackEvidence,
        notes: normalizedNotes || null,
      }, currentAttempt.idempotencyKey)
      setReviews((current) => [review, ...current.filter((candidate) => candidate.id !== review.id)])
      setNotes('')
      attempt.current = null
      onReviewCreated?.(review)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法保存试听验收决定')
    } finally {
      setSubmitting(false)
    }
  }

  const latest = reviews[0]
  const invalidationMessage = latest ? voicePreviewReviewInvalidationMessage(latest) : null
  return (
    <div className="voice-preview-review" aria-label="声线试听验收">
      <div className="voice-preview-review-status">
        {loading ? (
          <><CircleDashed className="spin" size={13} /><span>正在恢复试听验收记录…</span></>
        ) : latest ? (
          <>
            {!latest.isCurrent
              ? <AlertTriangle size={13} />
              : latest.decision === 'approve'
                ? <Check size={13} />
                : <X size={13} />}
            <span>
              {latest.isCurrent ? '当前决定' : '历史决定'}：
              {latest.decision === 'approve' ? '通过试听' : '淘汰该音色'}
              {invalidationMessage ? ` · ${invalidationMessage}` : ''}
            </span>
          </>
        ) : (
          <span>{playbackEvidence ? '已完整播放，可记录试听决定。' : '请把当前音频完整播放到结尾后再验收。'}</span>
        )}
      </div>
      <textarea
        value={notes}
        onChange={(event) => {
          setNotes(event.target.value)
          attempt.current = null
        }}
        maxLength={2_000}
        placeholder="听感备注（淘汰时必填）"
        aria-label="声线试听听感备注"
      />
      {error && <div className="voice-preview-error"><AlertTriangle size={13} /><span>{error}</span></div>}
      <div className="voice-preview-review-actions">
        <button
          type="button"
          className="button secondary"
          disabled={!playbackEvidence || loading || submitting}
          onClick={() => void submit('reject')}
        >
          <X size={13} />淘汰
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={!playbackEvidence || loading || submitting}
          onClick={() => void submit('approve')}
        >
          <Check size={13} />确认通过试听
        </button>
      </div>
      <small>验收只写入不可变审计记录，不调用语音 Provider，也不会自动绑定角色或项目旁白。</small>
    </div>
  )
}
