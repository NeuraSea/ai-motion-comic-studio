import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  ShieldAlert,
  X,
} from 'lucide-react'
import type { GenerationJob } from '../../lib'
import './ShotVideoManualResolutionDialog.css'

export interface ShotVideoManualResolutionDialogProps {
  job: GenerationJob | null
  pending: boolean
  error: string
  onClose: () => void
  onConfirm: (note: string) => void | Promise<void>
}

function submittedAt(job: GenerationJob): string {
  const value = typeof job.progressDetail?.submittedAt === 'string'
    ? job.progressDetail.submittedAt
    : job.startedAt ?? job.createdAt
  const parsed = Date.parse(value)
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'medium',
        hour12: false,
      }).format(new Date(parsed))
    : value
}

/**
 * Explicit human-in-the-loop recovery for a non-idempotent Provider POST with
 * an unknown outcome. Merely opening or closing this dialog never mutates a job.
 */
export function ShotVideoManualResolutionDialog({
  job,
  pending,
  error,
  onClose,
  onConfirm,
}: ShotVideoManualResolutionDialogProps) {
  const [confirmed, setConfirmed] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    setConfirmed(false)
    setNote('')
  }, [job?.id])

  useEffect(() => {
    if (!job) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [job, onClose, pending])

  if (!job) return null
  const normalizedNote = note.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
  const canSubmit = confirmed && normalizedNote.length >= 10 && normalizedNote.length <= 500 && !pending

  return (
    <div
      className="shot-video-resolution-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose()
      }}
    >
      <section
        className="shot-video-resolution-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shot-video-resolution-title"
        aria-describedby="shot-video-resolution-description"
      >
        <header>
          <span><ShieldAlert size={19} /></span>
          <div>
            <small>安全隔离 · 人工结案</small>
            <h2 id="shot-video-resolution-title">核对供应商后解除锁定</h2>
          </div>
          <button type="button" onClick={onClose} disabled={pending} aria-label="关闭人工核对">
            <X size={17} />
          </button>
        </header>

        <div className="shot-video-resolution-body">
          <p id="shot-video-resolution-description" className="shot-video-resolution-warning">
            上次提交没有返回可接管的任务 ID。只有在历史 Provider 控制台确认未创建任务后才能解除；否则重复生成可能二次计费。
          </p>

          <dl>
            <div><dt>任务</dt><dd>{job.id}</dd></div>
            <div><dt>历史 Provider</dt><dd>{job.providerId ?? '未知'} · r{job.providerConfigRevision ?? '—'}</dd></div>
            <div><dt>模型</dt><dd>{job.model ?? '未知'}</dd></div>
            <div><dt>提交时间</dt><dd>{submittedAt(job)}</dd></div>
          </dl>

          <label className={`shot-video-resolution-check ${confirmed ? 'checked' : ''}`}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={pending}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              <strong>我已核对以上历史 Provider 修订对应的控制台</strong>
              <small>已按提交时间与模型搜索，确认没有正在生成、成功或失败的对应任务。</small>
            </span>
          </label>

          <label className="shot-video-resolution-note">
            <span>核对记录 <small>{normalizedNote.length}/500</small></span>
            <textarea
              value={note}
              disabled={pending}
              maxLength={500}
              rows={4}
              placeholder="例如：已在历史 Provider r2 控制台按 22:59 提交时间核对，未发现对应任务。"
              onChange={(event) => setNote(event.target.value)}
            />
            <small>至少 10 个字符；将写入独立不可变审计记录。</small>
          </label>

          {error && <div className="shot-video-resolution-error" role="alert"><AlertTriangle size={14} /><span>{error}</span></div>}
        </div>

        <footer>
          <button type="button" className="button secondary" onClick={onClose} disabled={pending}>保持隔离</button>
          <button
            type="button"
            className="button primary"
            disabled={!canSubmit}
            onClick={() => void onConfirm(normalizedNote)}
          >
            {pending ? <LoaderCircle size={14} className="spin" /> : <CheckCircle2 size={14} />}
            {pending ? '正在写入审计…' : '确认未创建并解除锁定'}
          </button>
        </footer>
      </section>
    </div>
  )
}
