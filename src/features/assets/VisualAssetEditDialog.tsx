import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BadgeDollarSign,
  CheckCircle2,
  ImageIcon,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  WandSparkles,
  X,
} from 'lucide-react'
import type { MediaAsset } from '../../lib'
import {
  MAX_VISUAL_ASSET_EDIT_PROMPT_LENGTH,
  MAX_VISUAL_ASSET_EDIT_REFERENCES,
  VISUAL_ASSET_EDIT_QUALITIES,
  VISUAL_ASSET_EDIT_SIZES,
  buildVisualAssetEditSubmission,
  changeVisualAssetEditMode,
  createVisualAssetEditDraft,
  toggleVisualAssetEditReference,
} from './visual-asset-edit-state'
import type {
  VisualAssetEditDraft,
  VisualAssetEditMode,
  VisualAssetEditProviderCapability,
  VisualAssetEditSubmission,
  VisualAssetEditValidationContext,
} from './visual-asset-edit-state'
import './VisualAssetEditDialog.css'

export interface VisualAssetEditDialogProps {
  source: MediaAsset | null
  sourceLabel?: string
  referenceCandidates: readonly MediaAsset[]
  providerCapability: VisualAssetEditProviderCapability
  busy: boolean
  /** A server-signed confirmation modal temporarily owns the modal focus. */
  suspended?: boolean
  error: string
  onClose: () => void
  onSubmit: (submission: VisualAssetEditSubmission) => void | Promise<void>
}

const SIZE_LABELS: Record<(typeof VISUAL_ASSET_EDIT_SIZES)[number], string> = {
  '1024x1024': '1:1 · 1024',
  '1536x1024': '3:2 · 横图',
  '1024x1536': '2:3 · 竖图',
  auto: '自动',
}

const QUALITY_LABELS: Record<(typeof VISUAL_ASSET_EDIT_QUALITIES)[number], string> = {
  low: '快速',
  medium: '标准',
  high: '高质量',
  auto: '自动',
}

function isImageAsset(asset: MediaAsset): boolean {
  return asset.mimeType?.split(';', 1)[0].trim().toLowerCase().startsWith('image/') === true
}

function referenceUnavailableReason(source: MediaAsset, asset: MediaAsset): string | null {
  if (asset.id === source.id) return '固定主图无需重复选择'
  if (asset.projectId !== source.projectId
    || asset.episodeId !== source.episodeId
    || asset.sourceRevisionId !== source.sourceRevisionId) return '不属于主图的当前修订'
  if (asset.status !== 'ready') return '候选图尚未就绪'
  if (!isImageAsset(asset)) return '候选资产不是图片'
  if (!asset.checksum) return '候选图尚未固化校验和'
  return null
}

function assetTitle(asset: MediaAsset, fallback: string): string {
  return asset.originalFileName?.trim() || fallback
}

function assetOrigin(asset: MediaAsset): string {
  if (asset.source === 'upload') return '用户上传'
  if (asset.providerId) return 'Provider 生成'
  if (asset.source === 'derived') return '本地派生'
  return '项目图片'
}

function dimensions(asset: MediaAsset): string {
  return asset.width && asset.height ? `${asset.width} × ${asset.height}` : '尺寸待探测'
}

function sourceIsSubmittable(source: MediaAsset): boolean {
  return source.status === 'ready' && isImageAsset(source) && Boolean(source.checksum)
}

function uniqueAssets(assets: readonly MediaAsset[]): MediaAsset[] {
  const seen = new Set<string>()
  return assets.filter((asset) => {
    if (seen.has(asset.id)) return false
    seen.add(asset.id)
    return true
  })
}

const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function visibleFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR))
    .filter((element) => (
      element.getAttribute('aria-hidden') !== 'true'
      && element.offsetParent !== null
    ))
}

/**
 * Keeps keyboard focus inside this paid-operation modal and restores the
 * invoking control when it closes. Escape is deliberately consumed while a
 * task is being created so it cannot close this or a background dialog.
 */
function useVisualAssetEditDialogFocus(
  active: boolean,
  focusKey: string,
  busy: boolean,
  onClose: () => void,
) {
  const dialogRef = useRef<HTMLElement>(null)
  const busyRef = useRef(busy)
  const onCloseRef = useRef(onClose)
  // Event listeners are installed once per source. Keep their volatile values
  // current during render so an Escape arriving before passive effects flush
  // cannot observe the previous busy state.
  busyRef.current = busy
  onCloseRef.current = onClose

  useEffect(() => {
    if (!active) return undefined
    const dialog = dialogRef.current
    if (!dialog) return undefined
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    let lastFocusedWithin: HTMLElement = dialog

    const focusDialog = () => {
      dialog.focus({ preventScroll: true })
      lastFocusedWithin = dialog
    }
    const focusFrame = window.requestAnimationFrame(focusDialog)
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && dialog.contains(target)) {
        lastFocusedWithin = target
        return
      }
      if (lastFocusedWithin.isConnected
        && dialog.contains(lastFocusedWithin)
        && (lastFocusedWithin === dialog
          || visibleFocusableElements(dialog).includes(lastFocusedWithin))) {
        lastFocusedWithin.focus({ preventScroll: true })
      } else {
        focusDialog()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!busyRef.current) onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = visibleFocusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        focusDialog()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const current = document.activeElement
      const currentIndex = current instanceof HTMLElement ? focusable.indexOf(current) : -1
      if (!dialog.contains(current) || (current !== dialog && currentIndex === -1)) {
        event.preventDefault()
        const boundary = event.shiftKey ? last : first
        boundary.focus({ preventScroll: true })
      } else if (event.shiftKey && (current === first || current === dialog)) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (current === last || current === dialog)) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }

    document.addEventListener('focusin', handleFocusIn, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('focusin', handleFocusIn, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [active, focusKey])

  return dialogRef
}

export function VisualAssetEditDialog({
  source,
  sourceLabel,
  referenceCandidates,
  providerCapability,
  busy,
  suspended = false,
  error,
  onClose,
  onSubmit,
}: VisualAssetEditDialogProps) {
  const [draft, setDraft] = useState<VisualAssetEditDraft>(() => createVisualAssetEditDraft(
    source ?? { width: null, height: null },
    providerCapability,
  ))
  const [loadedSourceKey, setLoadedSourceKey] = useState('')
  const [failedSourceKey, setFailedSourceKey] = useState('')
  const [failedReferenceImages, setFailedReferenceImages] = useState<Set<string>>(() => new Set())

  const sourceKey = source
    ? `${source.id}:${source.version}:${source.checksum ?? 'no-checksum'}`
    : ''
  const referenceImageKey = referenceCandidates
    .map((asset) => `${asset.id}:${asset.version}:${asset.checksum ?? 'no-checksum'}:${asset.url}`)
    .join('|')
  const dialogRef = useVisualAssetEditDialogFocus(Boolean(source) && !suspended, sourceKey, busy, onClose)
  useEffect(() => {
    setDraft(createVisualAssetEditDraft(source ?? { width: null, height: null }, providerCapability))
  }, [sourceKey, providerCapability.edit, providerCapability.variations, providerCapability.multiReference])

  useEffect(() => {
    setFailedReferenceImages(new Set())
  }, [referenceImageKey, sourceKey])

  const candidates = useMemo(
    () => uniqueAssets(referenceCandidates).filter((asset) => asset.id !== source?.id),
    [referenceCandidates, source?.id],
  )
  const eligibleReferenceAssetIds = useMemo(() => new Set(candidates
    .filter((asset) => source
      && !failedReferenceImages.has(asset.id)
      && referenceUnavailableReason(source, asset) === null)
    .map((asset) => asset.id)), [candidates, failedReferenceImages, source])
  const validationContext = useMemo<VisualAssetEditValidationContext>(() => ({
    sourceAssetId: source?.id ?? '',
    eligibleReferenceAssetIds,
    capability: providerCapability,
  }), [eligibleReferenceAssetIds, providerCapability, source?.id])
  const submissionResult = useMemo(
    () => buildVisualAssetEditSubmission(draft, validationContext),
    [draft, validationContext],
  )

  if (!source) return null

  const sourceImageReady = loadedSourceKey === sourceKey
  const sourceImageError = failedSourceKey === sourceKey
  const sourceReadyForSubmission = sourceIsSubmittable(source) && sourceImageReady && !sourceImageError
  const canSubmit = sourceReadyForSubmission
    && submissionResult.valid
    && !busy

  const updateDraft = (next: VisualAssetEditDraft) => {
    setDraft(next)
  }

  const selectMode = (mode: VisualAssetEditMode) => {
    updateDraft(changeVisualAssetEditMode(draft, mode))
  }

  const submit = () => {
    const result = buildVisualAssetEditSubmission(draft, validationContext)
    if (!sourceReadyForSubmission || !result.submission || busy) return
    void onSubmit(result.submission)
  }

  const operationLabel = draft.mode === 'edit' ? '指令编辑' : '原生变体'

  return (
    <div
      className="visual-asset-edit-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        if (!busy) onClose()
        else dialogRef.current?.focus({ preventScroll: true })
      }}
    >
      <section
        ref={dialogRef}
        className="visual-asset-edit-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-busy={busy}
        aria-hidden={suspended || undefined}
        aria-labelledby="visual-asset-edit-title"
        aria-describedby="visual-asset-edit-description"
      >
        <header className="visual-asset-edit-header">
          <span><WandSparkles size={20} /></span>
          <div>
            <small>不可变源图 · 持久付费任务</small>
            <h2 id="visual-asset-edit-title">编辑或生成图片变体</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭图片编辑">
            <X size={18} />
          </button>
        </header>

        <div className="visual-asset-edit-body">
          <div id="visual-asset-edit-description" className="visual-asset-edit-billing-notice">
            <BadgeDollarSign size={17} />
            <div>
              <strong>下一步只做服务端权威预检，不创建 {operationLabel} 任务</strong>
              <span>服务端会签发绑定当前主图、参考图、Provider 修订与幂等键的短期确认；只有随后明确确认才会建单。</span>
            </div>
          </div>

          <section className="visual-asset-edit-provider" aria-label="Provider 能力">
            <div>
              <small>当前图片 Provider</small>
              <strong>{providerCapability.label || '未命名图片 Provider'}</strong>
              {providerCapability.model && <span>{providerCapability.model}</span>}
            </div>
            <ul>
              <li className={providerCapability.edit ? 'yes' : 'no'}>Edits {providerCapability.edit ? '可用' : '不可用'}</li>
              <li className={providerCapability.variations ? 'yes' : 'no'}>Variations {providerCapability.variations ? '可用' : '不可用'}</li>
              <li className={providerCapability.multiReference ? 'yes' : 'no'}>附加参考图 {providerCapability.multiReference ? '可用' : '不可用'}</li>
            </ul>
          </section>

          <div className="visual-asset-edit-operation" role="group" aria-label="图片操作">
            <button
              type="button"
              className={draft.mode === 'edit' ? 'active' : ''}
              aria-pressed={draft.mode === 'edit'}
              disabled={busy || !providerCapability.edit}
              onClick={() => selectMode('edit')}
            >
              <WandSparkles size={15} />
              <span><strong>指令编辑</strong><small>images/edits · 可传指令与附加参考</small></span>
            </button>
            <button
              type="button"
              className={draft.mode === 'variation' ? 'active' : ''}
              aria-pressed={draft.mode === 'variation'}
              disabled={busy || !providerCapability.variations}
              onClick={() => selectMode('variation')}
            >
              <Layers3 size={15} />
              <span><strong>原生变体</strong><small>images/variations · 仅主图，不传编辑指令</small></span>
            </button>
          </div>

          <div className="visual-asset-edit-grid">
            <section className="visual-asset-edit-source" aria-label="固定主图">
              <div className="visual-asset-edit-section-title">
                <div><LockKeyhole size={14} /><strong>固定主图</strong></div>
                <span>不可取消</span>
              </div>
              <div className={`visual-asset-edit-source-image ${sourceImageError ? 'failed' : ''}`}>
                {!sourceImageError ? (
                  <img
                    key={sourceKey}
                    src={source.url}
                    alt={sourceLabel ?? assetTitle(source, `当前候选 v${source.version}`)}
                    onLoad={() => {
                      setLoadedSourceKey(sourceKey)
                      setFailedSourceKey('')
                    }}
                    onError={() => {
                      setLoadedSourceKey('')
                      setFailedSourceKey(sourceKey)
                    }}
                  />
                ) : (
                  <div role="alert"><ImageIcon size={22} /><span>主图加载失败，禁止无预览提交</span></div>
                )}
                <span><LockKeyhole size={12} />源图</span>
              </div>
              <div className="visual-asset-edit-source-meta">
                <strong>{sourceLabel ?? assetTitle(source, `当前候选 v${source.version}`)}</strong>
                <span>v{source.version} · {dimensions(source)} · {assetOrigin(source)}</span>
              </div>
              {!sourceIsSubmittable(source) && (
                <p className="visual-asset-edit-inline-error"><AlertTriangle size={13} />主图必须是 ready 状态且已固化校验和的图片</p>
              )}
            </section>

            <section className="visual-asset-edit-form" aria-label={`${operationLabel}参数`}>
              <label className="visual-asset-edit-prompt">
                <span>
                  <strong>{draft.mode === 'edit' ? '编辑指令' : '变体审计备注'}</strong>
                  <small>{draft.prompt.trim().length}/{MAX_VISUAL_ASSET_EDIT_PROMPT_LENGTH}</small>
                </span>
                <textarea
                  rows={5}
                  maxLength={MAX_VISUAL_ASSET_EDIT_PROMPT_LENGTH}
                  value={draft.prompt}
                  disabled={busy}
                  placeholder={draft.mode === 'edit'
                    ? '例：保留角色面部、发型与服饰，只将手中道具替换为青铜剑。'
                    : '例：探索同一角色的构图变体（仅作任务审计备注）。'}
                  onChange={(event) => updateDraft({ ...draft, prompt: event.target.value })}
                />
                <small>{draft.mode === 'edit'
                  ? '该指令会传入 images/edits Provider。'
                  : '真实 images/variations 协议不接收 prompt；此文本只用于本地持久任务审计，不会控制上游结果。'}</small>
              </label>

              <div className="visual-asset-edit-output-options">
                <label>
                  <span>输出尺寸</span>
                  <select
                    value={draft.size}
                    disabled={busy}
                    onChange={(event) => updateDraft({
                      ...draft,
                      size: event.target.value as VisualAssetEditDraft['size'],
                    })}
                  >
                    {VISUAL_ASSET_EDIT_SIZES.map((size) => <option key={size} value={size}>{SIZE_LABELS[size]}</option>)}
                  </select>
                </label>
                <label>
                  <span>输出质量</span>
                  <select
                    value={draft.quality}
                    disabled={busy || draft.mode === 'variation'}
                    onChange={(event) => updateDraft({
                      ...draft,
                      quality: event.target.value as VisualAssetEditDraft['quality'],
                    })}
                  >
                    {VISUAL_ASSET_EDIT_QUALITIES.map((quality) => <option key={quality} value={quality}>{QUALITY_LABELS[quality]}</option>)}
                  </select>
                </label>
              </div>
              {draft.mode === 'variation' && (
                <p className="visual-asset-edit-protocol-note">原生 variations 只向上游发送主图与尺寸；质量值仅随本地任务记录固化。</p>
              )}
            </section>
          </div>

          <section className={`visual-asset-edit-references ${draft.mode}`} aria-label="附加参考图">
            <div className="visual-asset-edit-section-title">
              <div><Layers3 size={14} /><strong>同实体附加参考图</strong></div>
              <span>{draft.referenceAssetIds.length}/{MAX_VISUAL_ASSET_EDIT_REFERENCES}</span>
            </div>

            {draft.mode === 'variation' ? (
              <div className="visual-asset-edit-variation-policy">
                <LockKeyhole size={15} />
                <span><strong>原生变体禁止附加参考图</strong><small>这不是前端限制：images/variations 真实协议只接收一张固定主图。</small></span>
              </div>
            ) : !providerCapability.multiReference ? (
              <div className="visual-asset-edit-variation-policy unavailable">
                <AlertTriangle size={15} />
                <span><strong>当前 Provider 未声明附加参考图能力</strong><small>仍可仅使用固定主图进行指令编辑。</small></span>
              </div>
            ) : candidates.length === 0 ? (
              <p className="visual-asset-edit-empty">当前实体没有其他可选图片；可仅用固定主图编辑。</p>
            ) : (
              <div className="visual-asset-edit-reference-grid">
                {candidates.map((asset, index) => {
                  const unavailableReason = failedReferenceImages.has(asset.id)
                    ? '缩略图加载失败，无法可视确认'
                    : referenceUnavailableReason(source, asset)
                  const checked = draft.referenceAssetIds.includes(asset.id)
                  const atLimit = !checked && draft.referenceAssetIds.length >= MAX_VISUAL_ASSET_EDIT_REFERENCES
                  const disabled = busy || (!checked && (Boolean(unavailableReason) || atLimit))
                  const label = assetTitle(asset, `同实体候选 ${index + 1}`)
                  return (
                    <label
                      key={asset.id}
                      className={`visual-asset-edit-reference ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}`}
                      title={unavailableReason ?? (atLimit ? `最多选择 ${MAX_VISUAL_ASSET_EDIT_REFERENCES} 张` : label)}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => updateDraft(toggleVisualAssetEditReference(draft, asset.id, validationContext))}
                      />
                      <span className="visual-asset-edit-reference-image">
                        {failedReferenceImages.has(asset.id) ? (
                          <span className="visual-asset-edit-reference-image-error"><ImageIcon size={18} />预览不可用</span>
                        ) : (
                          <img
                            src={asset.url}
                            alt={label}
                            onError={() => setFailedReferenceImages((current) => {
                              const next = new Set(current)
                              next.add(asset.id)
                              return next
                            })}
                          />
                        )}
                        {checked && <CheckCircle2 size={16} />}
                      </span>
                      <span className="visual-asset-edit-reference-meta">
                        <strong>{label}</strong>
                        <small>v{asset.version} · {dimensions(asset)}</small>
                        <small>{unavailableReason ?? assetOrigin(asset)}</small>
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            <small className="visual-asset-edit-reference-scope">候选集由父级按同实体给出；前端只允许当前修订的 ready 图片，服务端仍必须复核实体与校验和。</small>
          </section>

          {submissionResult.issues.length > 0 && (
            <div className="visual-asset-edit-validation" role="alert">
              <AlertTriangle size={15} />
              <ul>{submissionResult.issues.map((issue) => <li key={`${issue.code}:${issue.assetId ?? ''}`}>{issue.message}</li>)}</ul>
            </div>
          )}

          {error && <div className="visual-asset-edit-error" role="alert"><AlertTriangle size={15} /><span>{error}</span></div>}
        </div>

        <footer className="visual-asset-edit-footer">
          <span>{draft.mode === 'edit'
            ? `固定主图 + ${draft.referenceAssetIds.length} 张附加参考`
            : '原生 variations · 仅固定主图'}</span>
          <div>
            <button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button>
            <button type="button" className="button primary" disabled={!canSubmit} onClick={submit}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <BadgeDollarSign size={15} />}
              {busy ? '正在获取签名确认…' : `预检 1 个${operationLabel}任务（不建单）`}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
