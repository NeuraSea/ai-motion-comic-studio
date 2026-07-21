import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Film,
  LoaderCircle,
  RefreshCcw,
  Settings2,
  ShieldAlert,
  Square,
  WandSparkles,
} from 'lucide-react'
import type { ShotMediaCandidate } from '../../lib'
import type { ShotVideoViewState } from './shot-video-state'
import type { ShotVideoBatchAvailabilitySummary } from './shot-video-batch-state'
import './ShotVideoPanel.css'

export interface ShotVideoPanelProps {
  state: ShotVideoViewState
  batchSummary: ShotVideoBatchAvailabilitySummary
  configured: boolean
  actionPending: boolean
  /** Undefined while review authority is loading; null means no current adopted video. */
  authoritativeAsset?: ShotMediaCandidate | null
  onGenerate: () => void
  onRetry: () => void
  onCancel: () => void
  onResolveManualReview: () => void
  onConfigure: () => void
}

const statusCopy: Record<ShotVideoViewState['status'], string> = {
  idle: '尚未生成逐镜视频',
  queued: '已进入持久任务队列',
  running: 'Seedance 正在生成',
  ready: '逐镜视频已落盘',
  failed: '本次生成失败',
  cancelled: '本地处理已停止',
  stale: '视频属于旧剧本修订',
}

/**
 * Presentation-only panel for the durable Seedance workflow.
 *
 * The parent owns all API calls; this component never invents progress or
 * caches paid-task state in the browser.
 */
export function ShotVideoPanel({
  state,
  batchSummary,
  configured,
  actionPending,
  authoritativeAsset,
  onGenerate,
  onRetry,
  onCancel,
  onResolveManualReview,
  onConfigure,
}: ShotVideoPanelProps) {
  const active = state.status === 'queued' || state.status === 'running'
  const canRetry = state.status === 'failed' && state.retryable
  const previewAsset = authoritativeAsset === undefined ? state.asset : authoritativeAsset
  const authoritativeSelectionMissing = authoritativeAsset === null && state.asset !== null
  const ready = state.status === 'ready' && previewAsset !== null
  const hasDurableAsset = previewAsset !== null
  const manualReview = state.manualReviewRequired

  return (
    <section className={`shot-video-panel status-${state.status}`} aria-label="逐镜 AI 视频">
      <div className="shot-video-heading">
        <div>
          <span className="shot-video-icon"><Film size={14} /></span>
          <div><strong>逐镜 AI 视频</strong><small>Seedance 2.0 · 批量 / 首尾帧 / 多参考</small></div>
        </div>
        <span className="shot-video-status">
          {active ? <LoaderCircle size={12} className="spin" />
            : ready ? <CheckCircle2 size={12} />
              : state.status === 'failed' || state.status === 'stale'
                ? <AlertTriangle size={12} />
                : <CircleDashed size={12} />}
          {authoritativeSelectionMissing ? '已有候选，当前未选中' : statusCopy[state.status]}{active ? ` ${Math.max(0, Math.min(100, Math.round(state.progress)))}%` : ''}
        </span>
      </div>

      {hasDurableAsset && previewAsset ? (
        <video
          className="shot-video-preview"
          controls
          preload="metadata"
          src={previewAsset.url}
        >
          当前浏览器无法播放此视频。
        </video>
      ) : (
        <div className="shot-video-placeholder">
          {active ? <LoaderCircle size={21} className="spin" /> : <WandSparkles size={21} />}
          <span>{active ? `真实任务进度 ${Math.max(0, Math.min(100, Math.round(state.progress)))}%`
            : authoritativeSelectionMissing
              ? '候选视频仍保留在审片历史；需明确恢复或重新生成'
              : configured ? '生成后会下载为本地受控 Asset，并自动进入时间线'
              : '先配置 Seedance API Key；未配置时不会发起计费请求'}</span>
          {active && <i><b style={{ width: `${Math.max(0, Math.min(100, state.progress))}%` }} /></i>}
        </div>
      )}

      {state.error && (
        <div className="shot-video-error"><AlertTriangle size={13} /><span>{state.error}</span></div>
      )}

      <div className="shot-video-batch-summary" aria-label="本集逐镜视频状态">
        <span className="pending">待生成 <b>{batchSummary.pending}</b></span>
        <span className="generated">已生成 <b>{batchSummary.generated}</b></span>
        <span className="locked">安全锁定 <b>{batchSummary.locked}</b></span>
      </div>

      <div className="shot-video-actions">
        {!configured ? (
          <button type="button" className="button secondary" onClick={onConfigure}>
            <Settings2 size={13} /> 配置 Seedance
          </button>
        ) : active ? (
          <button type="button" className="button secondary" onClick={onCancel} disabled={actionPending}>
            <Square size={11} fill="currentColor" /> 停止本地处理
          </button>
        ) : manualReview ? (
          <button type="button" className="button secondary" onClick={onResolveManualReview} disabled={actionPending} title="核对历史 Provider 控制台并写入不可变审计后解除隔离">
            <ShieldAlert size={13} /> 人工核对并解锁
          </button>
        ) : canRetry ? (
          <button type="button" className="button secondary" onClick={onRetry} disabled={actionPending}>
            <RefreshCcw size={13} /> 继续查询原任务
          </button>
        ) : (
          <button type="button" className="button secondary" onClick={onGenerate} disabled={actionPending}>
            {hasDurableAsset ? <RefreshCcw size={13} /> : <WandSparkles size={13} />}
            {batchSummary.pending > 0
              ? `打开批量工作台 · ${batchSummary.pending} 镜待生成`
              : hasDurableAsset ? '配置重生成新版本' : '配置镜头并预检'}
          </button>
        )}
        {configured && batchSummary.pending > 0 && (active || manualReview || canRetry) && (
          <button type="button" className="button secondary batch-entry" onClick={onGenerate} disabled={actionPending}>
            <WandSparkles size={12} /> 其他待生成 {batchSummary.pending}
          </button>
        )}
        <small>{manualReview
          ? '不会自动重提；确认历史任务不存在后才可解锁'
          : active
            ? '支持时会尽力请求上游取消；任务仍可能继续并产生费用'
            : '新任务必须两阶段确认 · 无 Key 仍可本地导出'}</small>
      </div>
    </section>
  )
}
