import { AlertTriangle, Check, CircleDashed, FlaskConical, Play, Settings2, ShieldCheck } from 'lucide-react'
import type { GenerationJob } from '../../lib'
import {
  buildSeedanceGoldenAcceptanceState,
  type SeedanceGoldenShotTarget,
  type SeedanceGoldenProviderIdentity,
} from './seedance-golden-acceptance-state'
import './SeedanceGoldenAcceptanceCard.css'

const STATUS_LABEL = {
  'candidate-missing': '缺 candidate',
  'baseline-missing': '待 baseline',
  'baseline-running': 'baseline 生成中',
  'baseline-failed': 'baseline 失败',
  'pair-ready': 'A/B 就绪',
} as const

export function SeedanceGoldenAcceptanceCard({
  episodeId,
  sourceRevisionId,
  shots,
  jobs,
  configured,
  currentProvider,
  onOpenBaseline,
  onOpenCandidate,
  onConfigure,
}: {
  episodeId: string
  sourceRevisionId: string
  shots: readonly SeedanceGoldenShotTarget[]
  jobs: readonly GenerationJob[]
  configured: boolean
  currentProvider: SeedanceGoldenProviderIdentity | null
  onOpenBaseline: () => void
  onOpenCandidate: () => void
  onConfigure: () => void
}) {
  const state = buildSeedanceGoldenAcceptanceState({
    episodeId,
    sourceRevisionId,
    shots,
    jobs,
    currentProvider,
  })
  const baselinePending = Math.max(0, state.targetCount - state.baselineReady - state.baselineRunning)
  const billingFailure = state.failures.find((failure) => (
    failure.code === 'PROVIDER_BILLING_UNAVAILABLE'
    || failure.providerCode === 'AccountOverdueError'
  ))
  return (
    <section className="seedance-golden-card" aria-label="Seedance Golden 最终验收">
      <header>
        <div className="seedance-golden-title">
          <span><FlaskConical size={16} /></span>
          <div>
            <strong>Seedance Golden 验收</strong>
            <small>同镜 candidate 与长 Prompt baseline；状态来自持久 Job，不用旧修订冒充。</small>
          </div>
        </div>
        <div className={`seedance-golden-gate ${state.pairSetReady ? 'ready' : ''}`}>
          {state.pairSetReady ? <ShieldCheck size={14} /> : <CircleDashed size={14} />}
          <strong>{state.baselineReady}/{state.targetCount}</strong>
          <span>A/B 对</span>
        </div>
      </header>

      <div className="seedance-golden-progress">
        <div><span>当前 Provider compact</span><strong>{state.candidateReady}/{state.targetCount}</strong></div>
        <div><span>独立 verbose baseline</span><strong>{state.baselineReady}/{state.targetCount}</strong></div>
        <div><span>运行中</span><strong>{state.baselineRunning}</strong></div>
        <div className={state.baselineFailed > 0 ? 'failed' : ''}><span>失败</span><strong>{state.baselineFailed}</strong></div>
      </div>

      {state.historicalCandidateReady > 0 && (
        <p className="seedance-golden-history-note">
          另有 {state.historicalCandidateReady} 镜历史 Provider candidate，仅保留审计与版本恢复，不计入当前 Golden。
        </p>
      )}

      <div className="seedance-golden-shots" aria-label="逐镜 A/B 状态">
        {state.items.map((item) => (
          <span key={item.shotId} className={item.status} title={item.baselineError ?? STATUS_LABEL[item.status]}>
            {item.status === 'pair-ready' ? <Check size={11} />
              : item.status === 'baseline-failed' || item.status === 'candidate-missing'
                ? <AlertTriangle size={11} />
                : <CircleDashed size={11} />}
            <b>{item.code}</b> {STATUS_LABEL[item.status]}
          </span>
        ))}
      </div>

      {state.baselineFailed > 0 && (
        <div className="seedance-golden-warning">
          <AlertTriangle size={14} />
          <span>
            {billingFailure
              ? `方舟账户余额或授信不可用：${billingFailure.count} 个任务返回 ${billingFailure.httpStatus ?? 403} ${billingFailure.providerCode ?? billingFailure.code}。恢复账户后重新做免费预检；系统不会自动重提。`
              : `最近 ${state.baselineFailed} 个 baseline 持久任务失败。重新打开只会准备新的免费预检，不会自动重提或计费。`}
          </span>
          <button type="button" onClick={onConfigure}>
            <Settings2 size={12} />检查 Seedance 配置
          </button>
        </div>
      )}

      {!state.pairSetReady && state.providerMismatchReason && (
        <div className="seedance-golden-warning provider-drift">
          <AlertTriangle size={14} />
          <span>{state.providerMismatchReason} 请在当前 Agent Plan 配置下先创建一组新的 compact candidate，再创建 verbose baseline；两步都仍需各自免费预检和明确计费确认。</span>
          <button type="button" onClick={onOpenCandidate} disabled={!configured}>
            <Play size={12} />准备当前 Provider candidate
          </button>
        </div>
      )}

      <footer>
        <p>{state.pairSetReady
          ? 'A/B 媒体已齐；仍须运行权威变量校验并完成六指标随机盲审，不能在这里自动判定通过。'
          : state.candidateReady < state.targetCount
            ? `先补齐 ${state.targetCount - state.candidateReady} 个当前 Story 的 compact candidate。`
            : !state.currentProviderCompatible
              ? '当前 Provider 身份与 candidate 不一致，禁止创建不可通过验证的 baseline。'
            : `还需 ${baselinePending} 个独立 baseline；入口预置全部镜头、1080p、仅环境音/动作音和 verbose compiler。`}</p>
        <button
          type="button"
          className="button secondary"
          onClick={configured ? onOpenBaseline : onConfigure}
          disabled={state.targetCount === 0
            || state.candidateReady < state.targetCount
            || state.baselineRunning > 0
            || (!state.pairSetReady && !state.currentProviderCompatible)}
          title={state.baselineRunning > 0 ? '已有 baseline 持久任务正在运行，请等待状态恢复' : undefined}
        >
          <Play size={13} />
          {!configured ? '配置 Seedance'
            : !state.pairSetReady && !state.currentProviderCompatible ? 'Provider 与 candidate 不一致'
            : state.pairSetReady ? '核对 / 重跑 baseline 预检'
              : '准备 A/B 长 Prompt baseline'}
        </button>
      </footer>
    </section>
  )
}
