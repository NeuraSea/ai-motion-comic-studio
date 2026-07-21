import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Crop,
  Info,
  LoaderCircle,
  RotateCcw,
  Scissors,
  X,
} from 'lucide-react'
import {
  MIN_TURNAROUND_CROP_EDGE,
  TURNAROUND_ROLES,
  TURNAROUND_ROLE_LABELS,
  cloneTurnaroundCrops,
  createGeometricTurnaroundSuggestion,
  createManualTurnaroundSplit,
  updateTurnaroundCrop,
  validateTurnaroundCrops,
} from './turnaround-split-state'
import type {
  NormalizedCrop,
  TurnaroundCropField,
  TurnaroundCrops,
  TurnaroundRole,
  TurnaroundSplitState,
} from './turnaround-split-state'
import './TurnaroundSplitDialog.css'

export interface TurnaroundSplitDialogProps {
  open: boolean
  sourceImageUrl: string
  sourceLabel?: string
  initialCrops?: TurnaroundCrops
  pending?: boolean
  error?: string
  onClose: () => void
  onSubmit: (crops: TurnaroundCrops) => void | Promise<void>
}

interface ImageDimensions {
  width: number
  height: number
}

const CROP_FIELDS: ReadonlyArray<{
  field: TurnaroundCropField
  label: string
}> = [
  { field: 'x', label: '左' },
  { field: 'y', label: '上' },
  { field: 'width', label: '宽' },
  { field: 'height', label: '高' },
]

function initialState(initialCrops?: TurnaroundCrops): TurnaroundSplitState {
  return initialCrops
    ? createManualTurnaroundSplit(initialCrops)
    : createGeometricTurnaroundSuggestion()
}

function percentage(value: number): number {
  return Math.round(value * 10_000) / 100
}

function rangeBounds(crop: NormalizedCrop, field: TurnaroundCropField): { min: number; max: number } {
  if (field === 'x') return { min: 0, max: Math.max(0, 1 - crop.width) }
  if (field === 'y') return { min: 0, max: Math.max(0, 1 - crop.height) }
  if (field === 'width') return { min: MIN_TURNAROUND_CROP_EDGE, max: Math.max(MIN_TURNAROUND_CROP_EDGE, 1 - crop.x) }
  return { min: MIN_TURNAROUND_CROP_EDGE, max: Math.max(MIN_TURNAROUND_CROP_EDGE, 1 - crop.y) }
}

function safeRangeValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function cropCanRender(crop: NormalizedCrop): boolean {
  return Number.isFinite(crop.x)
    && Number.isFinite(crop.y)
    && Number.isFinite(crop.width)
    && Number.isFinite(crop.height)
    && crop.x >= 0
    && crop.y >= 0
    && crop.width > 0
    && crop.height > 0
    && crop.x + crop.width <= 1
    && crop.y + crop.height <= 1
}

function previewAspectRatio(crop: NormalizedCrop, image: ImageDimensions | null): number {
  if (!cropCanRender(crop)) return 1
  const sourceRatio = image ? image.width / image.height : 1
  return Math.max(0.2, Math.min(5, sourceRatio * crop.width / crop.height))
}

function previewImageStyle(crop: NormalizedCrop): CSSProperties {
  return {
    width: `${100 / crop.width}%`,
    height: `${100 / crop.height}%`,
    transform: `translate(${-crop.x * 100}%, ${-crop.y * 100}%)`,
    objectFit: 'fill',
    objectPosition: '50% 50%',
    clipPath: 'inset(0)',
  }
}

export function TurnaroundSplitDialog({
  open,
  sourceImageUrl,
  sourceLabel = '角色三视图原图',
  initialCrops,
  pending = false,
  error = '',
  onClose,
  onSubmit,
}: TurnaroundSplitDialogProps) {
  const initialCropKey = initialCrops ? JSON.stringify(initialCrops) : ''
  const [split, setSplit] = useState<TurnaroundSplitState>(() => initialState(initialCrops))
  const [confirmed, setConfirmed] = useState(false)
  const [imageDimensions, setImageDimensions] = useState<ImageDimensions | null>(null)
  const [imageError, setImageError] = useState(false)

  useEffect(() => {
    if (!open) return
    setSplit(initialState(initialCrops))
    setConfirmed(false)
    setImageDimensions(null)
    setImageError(false)
    // The serialized key resets only when crop values change, not when a
    // parent recreates an equivalent object during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceImageUrl, initialCropKey])

  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, pending])

  const validation = useMemo(() => validateTurnaroundCrops(split.crops), [split.crops])
  const issuesByRole = useMemo(() => Object.fromEntries(TURNAROUND_ROLES.map((role) => [
    role,
    validation.issues.filter((issue) => issue.roles.includes(role)),
  ])) as Record<TurnaroundRole, typeof validation.issues>, [validation.issues])
  const sourceReady = Boolean(imageDimensions) && !imageError
  const canSubmit = sourceReady && validation.valid && confirmed && !pending

  if (!open) return null

  const updateField = (role: TurnaroundRole, field: TurnaroundCropField, value: number) => {
    setSplit((current) => updateTurnaroundCrop(current, role, { [field]: value }))
    setConfirmed(false)
  }

  const resetSuggestion = () => {
    setSplit(createGeometricTurnaroundSuggestion())
    setConfirmed(false)
  }

  return (
    <div
      className="turnaround-split-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose()
      }}
    >
      <section
        className="turnaround-split-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="turnaround-split-title"
        aria-describedby="turnaround-split-description"
      >
        <header className="turnaround-split-header">
          <span className="turnaround-split-header-icon"><Scissors size={20} /></span>
          <div>
            <small>本地派生·人工确认</small>
            <h2 id="turnaround-split-title">分割角色正面、侧面与背面参考图</h2>
          </div>
          <button type="button" onClick={onClose} disabled={pending} aria-label="关闭三视图分割">
            <X size={18} />
          </button>
        </header>

        <div className="turnaround-split-body">
          <div id="turnaround-split-description" className="turnaround-split-truth-notice">
            <Info size={16} />
            <div>
              <strong>本地几何裁切，需人工确认，非 AI</strong>
              <span>默认三等分只是几何建议，不会识别人物朝向。此处预览不会创建、替换或锁定任何资产。</span>
            </div>
          </div>

          <div className="turnaround-split-workspace">
            <section className="turnaround-split-source-panel" aria-label="原图裁切框预览">
              <div className="turnaround-split-section-heading">
                <div><Crop size={15} /><strong>原图框选</strong></div>
                <button type="button" onClick={resetSuggestion} disabled={pending}>
                  <RotateCcw size={13} />恢复几何三等分
                </button>
              </div>

              <div className="turnaround-split-source-canvas">
                {!imageError ? (
                  <img
                    src={sourceImageUrl}
                    alt={sourceLabel}
                    onLoad={(event) => {
                      setImageDimensions({
                        width: event.currentTarget.naturalWidth,
                        height: event.currentTarget.naturalHeight,
                      })
                      setImageError(false)
                    }}
                    onError={() => {
                      setImageDimensions(null)
                      setImageError(true)
                    }}
                  />
                ) : (
                  <div className="turnaround-split-image-error" role="alert">
                    <AlertTriangle size={18} />
                    <span>原图加载失败，不能在无可视确认的情况下提交。</span>
                  </div>
                )}
                {sourceReady && TURNAROUND_ROLES.map((role) => {
                  const crop = split.crops[role]
                  if (!cropCanRender(crop)) return null
                  return (
                    <div
                      key={role}
                      className={`turnaround-split-overlay ${role} ${issuesByRole[role].length ? 'invalid' : ''}`}
                      style={{
                        left: `${crop.x * 100}%`,
                        top: `${crop.y * 100}%`,
                        width: `${crop.width * 100}%`,
                        height: `${crop.height * 100}%`,
                      }}
                    >
                      <span>{TURNAROUND_ROLE_LABELS[role]}</span>
                    </div>
                  )
                })}
              </div>

              <div className={`turnaround-split-origin ${split.origin}`}>
                {split.origin === 'geometric-suggestion'
                  ? '当前是未识别内容的几何三等分建议'
                  : '当前框选已人工调整，仍需确认三个朝向标签'}
              </div>
            </section>

            <section className="turnaround-split-controls" aria-label="裁切框数值调整">
              {TURNAROUND_ROLES.map((role) => {
                const crop = split.crops[role]
                const roleIssues = issuesByRole[role]
                return (
                  <fieldset key={role} className={`turnaround-split-control-card ${roleIssues.length ? 'invalid' : ''}`}>
                    <legend><span className={`turnaround-split-dot ${role}`} />{TURNAROUND_ROLE_LABELS[role]}</legend>
                    <div className="turnaround-split-field-grid">
                      {CROP_FIELDS.map(({ field, label }) => {
                        const bounds = rangeBounds(crop, field)
                        return (
                          <label key={field} className="turnaround-split-field">
                            <span>{label}</span>
                            <input
                              type="range"
                              min={bounds.min}
                              max={bounds.max}
                              step={0.005}
                              value={safeRangeValue(crop[field], bounds.min, bounds.max)}
                              disabled={pending}
                              aria-label={`${TURNAROUND_ROLE_LABELS[role]}${label}滑杆`}
                              onChange={(event) => updateField(role, field, event.currentTarget.valueAsNumber)}
                            />
                            <span className="turnaround-split-number-wrap">
                              <input
                                type="number"
                                min={bounds.min * 100}
                                max={bounds.max * 100}
                                step={0.5}
                                value={percentage(crop[field])}
                                disabled={pending}
                                aria-label={`${TURNAROUND_ROLE_LABELS[role]}${label}百分比`}
                                onChange={(event) => {
                                  if (Number.isFinite(event.currentTarget.valueAsNumber)) {
                                    updateField(role, field, event.currentTarget.valueAsNumber / 100)
                                  }
                                }}
                              />
                              <span>%</span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                    {roleIssues.length > 0 && (
                      <ul className="turnaround-split-role-issues">
                        {roleIssues.map((issue) => <li key={`${issue.code}-${issue.roles.join('-')}`}>{issue.message}</li>)}
                      </ul>
                    )}
                  </fieldset>
                )
              })}
            </section>
          </div>

          <section className="turnaround-split-preview-section" aria-label="三张本地裁切预览">
            <div className="turnaround-split-section-heading">
              <div><strong>实时裁切预览</strong><small>仅用于确认，尚非资产</small></div>
            </div>
            <div className="turnaround-split-previews">
              {TURNAROUND_ROLES.map((role) => {
                const crop = split.crops[role]
                const renderable = sourceReady && cropCanRender(crop)
                return (
                  <figure key={role} className={`turnaround-split-preview-card ${role}`}>
                    <div
                      className="turnaround-split-preview-image"
                      style={{ aspectRatio: previewAspectRatio(crop, imageDimensions) }}
                    >
                      {renderable ? (
                        <img src={sourceImageUrl} alt="" aria-hidden="true" style={previewImageStyle(crop)} />
                      ) : (
                        <span>修正边界后预览</span>
                      )}
                    </div>
                    <figcaption>
                      <strong>{TURNAROUND_ROLE_LABELS[role]}</strong>
                      <span>x {percentage(crop.x)}% · y {percentage(crop.y)}% · {percentage(crop.width)} × {percentage(crop.height)}%</span>
                    </figcaption>
                  </figure>
                )
              })}
            </div>
          </section>

          <label className={`turnaround-split-confirm ${confirmed ? 'checked' : ''} ${!validation.valid || !sourceReady ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={pending || !validation.valid || !sourceReady}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              <strong>我已逐张确认正面、侧面、背面标签与框选</strong>
              <small>提交后由服务端创建本地持久派生任务；不会调用图片 Provider，也不会自动锁定角色参考。</small>
            </span>
          </label>

          {error && <div className="turnaround-split-error" role="alert"><AlertTriangle size={15} /><span>{error}</span></div>}
        </div>

        <footer className="turnaround-split-footer">
          <span>{validation.valid ? '三个裁切框校验通过' : `请先修复 ${validation.issues.length} 项框选问题`}</span>
          <div>
            <button type="button" className="button secondary" onClick={onClose} disabled={pending}>取消</button>
            <button
              type="button"
              className="button primary"
              disabled={!canSubmit}
              onClick={() => void onSubmit(cloneTurnaroundCrops(split.crops))}
            >
              {pending ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}
              {pending ? '正在创建本地任务…' : '创建三张持久参考图'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
