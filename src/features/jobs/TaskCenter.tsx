import { AlertTriangle, CheckCircle2, CircleDashed, RotateCcw, Square, X } from 'lucide-react'

import type { GenerationJob } from '../../lib'
import { jobRetryAction } from './job-retry-action'
import type { JobConnectionState } from './useProjectJobs'
import './task-center.css'

export interface TaskCenterProps {
  open: boolean
  jobs: GenerationJob[]
  connection: JobConnectionState
  error?: string
  onClose: () => void
  onRetry: (job: GenerationJob) => Promise<void> | void
  onCancel: (job: GenerationJob) => Promise<void> | void
}

const labels: Record<GenerationJob['status'], string> = {
  queued: '排队中',
  running: '执行中',
  waiting_provider: '等待 Provider',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

function typeLabel(type: string): string {
  const known: Record<string, string> = {
    'asset.image.generate': '图片生成',
    'image.generate': '图片生成',
    'story.generate': '剧本生成',
    'shot.storyboard.generate': '分镜生成',
    'shot.video.generate': '视频生成',
    'dialogue.speech.generate': '语音合成',
    'timeline.preview.render': '预览渲染',
    'export.render': '成片导出',
    'quality.check': '成片质检',
  }
  return known[type] ?? type
}

function StatusIcon({ job }: { job: GenerationJob }) {
  if (job.status === 'succeeded') return <CheckCircle2 size={16} />
  if (job.status === 'failed') return <AlertTriangle size={16} />
  return <CircleDashed size={16} />
}

export function TaskCenter({
  open,
  jobs,
  connection,
  error,
  onClose,
  onRetry,
  onCancel,
}: TaskCenterProps) {
  if (!open) return null
  const retriedJobIds = new Set(jobs.flatMap((job) => job.retryOf ? [job.retryOf] : []))
  return (
    <div className="task-center-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <aside className="task-center" role="dialog" aria-modal="true" aria-labelledby="task-center-title">
        <header>
          <div>
            <span className={`task-connection ${connection}`} />
            <div><h2 id="task-center-title">任务中心</h2><small>{connection === 'live' ? '实时状态已连接' : '使用快照状态'} · 本项目全部分集</small></div>
          </div>
          <button onClick={onClose} aria-label="关闭任务中心"><X size={18} /></button>
        </header>
        {error && <div className="task-center-warning"><AlertTriangle size={14} />{error}</div>}
        <div className="task-list">
          {jobs.length === 0 && <div className="task-empty"><CircleDashed size={24} /><span>暂无生成任务</span></div>}
          {jobs.map((job) => {
            const active = ['queued', 'running', 'waiting_provider'].includes(job.status)
            // Only the leaf of a linear retry lineage is actionable. Once a
            // child exists, continuing the cancelled/failed ancestor would
            // merely replay that child and present stale status to the user.
            const retryAction = retriedJobIds.has(job.id) ? null : jobRetryAction(job)
            return (
              <article className={`task-item status-${job.status}`} key={job.id}>
                <StatusIcon job={job} />
                <div className="task-copy">
                  <div><strong>{typeLabel(job.type)}</strong><span>{job.type === 'shot.video.generate' && job.status === 'cancelled' ? '本地已停止' : labels[job.status]}</span></div>
                  <div className="task-progress"><i style={{ width: `${Math.max(0, Math.min(job.progress, 100))}%` }} /></div>
                  {job.error?.message && <small>{job.error.message}</small>}
                  <time title={job.episodeId ?? '项目级任务'}>
                    {job.episodeId ? `分集 ${job.episodeId.slice(0, 8)} · ` : '项目级 · '}
                    {new Date(job.updatedAt).toLocaleString('zh-CN')}
                  </time>
                </div>
                <div className="task-actions">
                  {retryAction && (
                    <button
                      className={`task-retry-action ${retryAction.action}`}
                      onClick={() => void onRetry(job)}
                      title={retryAction.title}
                    >
                      {retryAction.action === 'manual-resolution'
                        ? <AlertTriangle size={14} />
                        : <RotateCcw size={14} />}
                      <span>{retryAction.label}</span>
                    </button>
                  )}
                  {active && <button onClick={() => void onCancel(job)} title={job.type === 'shot.video.generate' ? '停止本地处理' : '取消'}><Square size={13} /></button>}
                </div>
              </article>
            )
          })}
        </div>
      </aside>
    </div>
  )
}
