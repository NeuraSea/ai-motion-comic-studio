import { useEffect, useId, useRef, useState } from 'react'
import {
  AlertTriangle,
  CircleDashed,
  Clock3,
  Server,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'

import type { PublicPaidAigcConfirmation } from '../../lib'
import { paidAigcConfirmationExpired } from './paid-aigc-confirmation-state'
import './PaidAigcConfirmationDialog.css'

export interface PaidAigcConfirmationDialogProps {
  confirmation: PublicPaidAigcConfirmation
  eyebrow: string
  title: string
  description: string
  bindingDescription: string
  cancelAriaLabel: string
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void | Promise<void>
  onRefresh: () => void | Promise<void>
}

function formattedExpiry(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '无效时间'
}

export function PaidAigcConfirmationDialog({
  confirmation,
  eyebrow,
  title,
  description,
  bindingDescription,
  cancelAriaLabel,
  busy,
  error,
  onCancel,
  onConfirm,
  onRefresh,
}: PaidAigcConfirmationDialogProps) {
  const [nowEpochMs, setNowEpochMs] = useState(() => Date.now())
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const busyRef = useRef(busy)
  const cancelRef = useRef(onCancel)
  const id = useId()
  busyRef.current = busy
  cancelRef.current = onCancel
  const expired = paidAigcConfirmationExpired(confirmation, nowEpochMs)

  useEffect(() => {
    setNowEpochMs(Date.now())
    const timer = window.setInterval(() => setNowEpochMs(Date.now()), 1_000)
    window.requestAnimationFrame(() => dialogRef.current?.focus())
    return () => window.clearInterval(timer)
  }, [confirmation.confirmationToken])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault()
        cancelRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )]
      if (controls.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
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
      previousFocus?.focus()
    }
  }, [])

  return (
    <div
      className="paid-aigc-confirmation-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        className="paid-aigc-confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        aria-busy={busy}
        tabIndex={-1}
      >
        <header>
          <span><ShieldCheck size={19} /></span>
          <div>
            <small>{eyebrow}</small>
            <h2 id={`${id}-title`}>{title}</h2>
            <p id={`${id}-description`}>{description}</p>
          </div>
          <button type="button" disabled={busy} onClick={onCancel} aria-label={cancelAriaLabel}><X size={18} /></button>
        </header>

        <main>
          <section className="paid-aigc-confirmation-provider">
            <Server size={17} />
            <div><small>Provider</small><strong>{confirmation.provider.providerId}</strong></div>
            <div><small>模型</small><strong>{confirmation.provider.model}</strong></div>
            <div><small>配置修订</small><strong>r{confirmation.provider.configRevision}</strong></div>
          </section>

          <dl>
            <div><dt>计费任务</dt><dd>{confirmation.billableTaskCount} 个</dd></div>
            <div><dt>确认范围</dt><dd>{confirmation.label}</dd></div>
            <div><dt>确认有效至</dt><dd><Clock3 size={13} /> {formattedExpiry(confirmation.expiresAt)}</dd></div>
            <div><dt>价格估算</dt><dd>Provider 暂无可验证报价</dd></div>
          </dl>

          <div className="paid-aigc-confirmation-binding">
            <ShieldCheck size={15} />
            <span>{bindingDescription}</span>
          </div>

          {expired && (
            <div className="paid-aigc-confirmation-warning" role="alert">
              <AlertTriangle size={15} />
              <span>本次确认已过期。刷新只会获取新确认，不会创建任务。</span>
            </div>
          )}
          {error && (
            <div className="paid-aigc-confirmation-error" role="alert">
              <AlertTriangle size={15} />
              <span>{error}</span>
            </div>
          )}
        </main>

        <footer>
          <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>取消</button>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void (expired ? onRefresh() : onConfirm())}
          >
            {busy
              ? <><CircleDashed size={15} /> 正在核对…</>
              : expired
                ? <><ShieldCheck size={15} /> 重新预检（不建单）</>
                : <><Sparkles size={15} /> 明确确认并创建 1 个任务</>}
          </button>
        </footer>
      </div>
    </div>
  )
}

