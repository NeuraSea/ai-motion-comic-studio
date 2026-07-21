import React, { useEffect, useRef } from 'react'
import { AlertTriangle, ClipboardCopy, RotateCcw, Trash2 } from 'lucide-react'

import type { OfflineStoryDraft } from './offline-story-draft'

export interface OfflineStoryDraftRecoveryDialogProps {
  draft: OfflineStoryDraft
  authoritativeSourceRevisionId: string
  targetError?: string | null
  busy?: boolean
  error?: string
  onRestore: () => void
  onDiscard: () => void
  onCopyAsText: () => void
}

function revisionLabel(revisionId: string): string {
  return revisionId.length > 18
    ? `${revisionId.slice(0, 9)}…${revisionId.slice(-6)}`
    : revisionId
}

export function OfflineStoryDraftRecoveryDialog({
  draft,
  authoritativeSourceRevisionId,
  targetError = null,
  busy = false,
  error = '',
  onRestore,
  onDiscard,
  onCopyAsText,
}: OfflineStoryDraftRecoveryDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const sameBase = draft.scope.baseSourceRevisionId === authoritativeSourceRevisionId
    && targetError === null

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Default focus must be the non-destructive action. Focusing “discard”
    // first would let a stray Enter permanently remove the only local copy.
    const frame = window.requestAnimationFrame(() => (
      dialog.querySelector<HTMLElement>('[data-offline-draft-safe-default="true"]') ?? dialog
    ).focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled])'))
      if (controls.length === 0) {
        event.preventDefault()
        dialog.focus()
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
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      dialog.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [])

  return (
    <div className="modal-backdrop offline-story-draft-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="offline-story-draft-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby="offline-story-draft-title"
        aria-describedby="offline-story-draft-description"
        tabIndex={-1}
      >
        <header>
          <span><RotateCcw size={20} /></span>
          <div>
            <small>本地断网保护</small>
            <h2 id="offline-story-draft-title">
              {sameBase ? '发现尚未保存的剧本草稿' : '发现旧修订上的本地草稿'}
            </h2>
          </div>
        </header>
        <p id="offline-story-draft-description">
          {sameBase
            ? '草稿与服务器当前剧本来自同一基线。是否恢复到编辑器？恢复只填入可编辑字段，不会立即提交。'
            : '服务器剧本已经变化。为避免覆盖新结构，系统禁止恢复或自动合并；你只能复制救援文本，或丢弃旧草稿。'}
        </p>
        <dl className="offline-story-draft-metadata">
          <div><dt>草稿基线</dt><dd title={draft.scope.baseSourceRevisionId}>{revisionLabel(draft.scope.baseSourceRevisionId)}</dd></div>
          <div><dt>服务器版本</dt><dd title={authoritativeSourceRevisionId}>{revisionLabel(authoritativeSourceRevisionId)}</dd></div>
          <div><dt>本地保存时间</dt><dd>{new Date(draft.savedAt).toLocaleString('zh-CN')}</dd></div>
          <div><dt>草稿内容</dt><dd>{draft.drafts.scenes.length} 场 · {draft.drafts.shots.length} 镜 · {draft.drafts.dialogueLines.length} 句</dd></div>
        </dl>
        {!sameBase && (
          <div className="offline-story-draft-safety">
            <AlertTriangle size={14} />
            <span>{targetError ?? '跨修订草稿不会写入当前服务器剧本，也不会覆盖当前编辑器结构。'}</span>
          </div>
        )}
        {error && <div className="offline-story-draft-error" role="alert"><AlertTriangle size={14} /><span>{error}</span></div>}
        <footer>
          <button className="button secondary" disabled={busy} onClick={onDiscard}>
            <Trash2 size={14} /> 丢弃本地草稿
          </button>
          {sameBase ? (
            <button data-offline-draft-safe-default="true" className="button primary" disabled={busy} onClick={onRestore}>
              <RotateCcw size={14} /> 恢复到编辑器
            </button>
          ) : (
            <button data-offline-draft-safe-default="true" className="button primary" disabled={busy} onClick={onCopyAsText}>
              <ClipboardCopy size={14} /> 复制救援文本并继续
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

export function OfflineStoryDraftPersistenceNotice({ message }: { message: string }) {
  if (!message) return null
  return (
    <div className="offline-story-draft-notice" role="status">
      <AlertTriangle size={14} />
      <span>{message}。正常在线编辑不受影响。</span>
    </div>
  )
}
