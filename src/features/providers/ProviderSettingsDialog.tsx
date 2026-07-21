import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Eye,
  EyeOff,
  Film,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  Mic2,
  PlugZap,
  RefreshCcw,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import {
  PROVIDER_CATALOG,
  catalogAllowsBaseUrl,
  catalogAllowsModel,
} from './provider-settings-catalog'
import type {
  ProviderAuthMode,
  ProviderCatalogItem,
  ProviderCategory,
} from './provider-settings-catalog'
import type { ProviderUiConnectionState } from './provider-ui-state'
import './ProviderSettingsDialog.css'

export { PROVIDER_CATALOG } from './provider-settings-catalog'
export type {
  ProviderAuthMode,
  ProviderCatalogItem,
  ProviderCategory,
} from './provider-settings-catalog'

export type ProviderConnectionState = ProviderUiConnectionState

/**
 * Public provider data that is safe to persist or return to the browser.
 * Credential values deliberately have no representation in this type.
 */
export interface ProviderPublicSettings extends ProviderCatalogItem {
  connectionState: ProviderConnectionState
  /** Optional capability-specific label such as Agent Plan's read-only list probe. */
  connectionLabel?: string
  baseUrl?: string
  model?: string
  hasStoredCredential?: boolean
  isDefault?: boolean
  /** Must be a credential-free, user-facing summary from the server. */
  statusDetail?: string
  /** Explains what a successful non-billable probe did not verify. */
  verificationNotice?: string
}

/**
 * Ephemeral BYOK form payload. Consumers must send it directly to the local API
 * and must never put `apiKey` in browser storage, project data, URLs, or logs.
 */
export interface ProviderCredentialInput {
  baseUrl: string
  model: string
  apiKey?: string
}

export interface ProviderTestResult {
  ok: boolean
  summary?: string
  latencyMs?: number
}

export interface ProviderSettingsDialogProps {
  isOpen: boolean
  providers: readonly ProviderPublicSettings[]
  onClose: () => void
  onSave: (
    providerId: string,
    input: ProviderCredentialInput,
  ) => void | Promise<void>
  onTest: (providerId: string) => ProviderTestResult | Promise<ProviderTestResult>
  onDelete: (providerId: string) => void | Promise<void>
  onSetDefault: (providerId: string) => void | Promise<void>
}

const categoryMeta: Record<ProviderCategory, {
  label: string
  description: string
  icon: LucideIcon
}> = {
  text: { label: '文本模型', description: '文字生成、理解、视觉与 Agentic 编排', icon: MessageSquareText },
  image: { label: '图片模型', description: '角色、场景与分镜', icon: ImageIcon },
  video: { label: '视频模型', description: '逐镜 AI 视频生成', icon: Film },
  speech: { label: '语音模型', description: '对白、旁白与字幕', icon: Mic2 },
}

const categoryOrder: readonly ProviderCategory[] = ['text', 'image', 'video', 'speech']

const statusMeta: Record<ProviderConnectionState, {
  label: string
  icon: LucideIcon
}> = {
  unconfigured: { label: '未配置', icon: CircleDashed },
  disabled: { label: '已停用', icon: CircleDashed },
  untested: { label: '待验证', icon: CircleDashed },
  connected: { label: '已连接', icon: CheckCircle2 },
  degraded: { label: '连接受限', icon: AlertCircle },
  unavailable: { label: '连接异常', icon: AlertCircle },
}

type PendingAction = 'save' | 'test' | 'delete' | 'default'

interface PendingState {
  providerId: string
  action: PendingAction
}

interface InlineFeedback {
  kind: 'success' | 'error'
  message: string
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactSensitiveText(value: string | undefined, activeSecret = '') {
  if (!value) return ''
  let redacted = value
    .replace(/\bbearer\s+[a-z0-9._~+/=-]{8,}/gi, 'Bearer [已隐藏]')
    .replace(/\b(authorization|api[-_ ]?key|access[-_ ]?token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1: [已隐藏]')
  if (activeSecret.length >= 4) {
    redacted = redacted.replace(new RegExp(escapeRegExp(activeSecret), 'g'), '[已隐藏]')
  }
  return redacted.slice(0, 240)
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>([
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))).filter((element) => (
    element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0
  ))
}

function validateBaseUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) {
      return 'Base URL 不能包含凭据、查询参数或锚点。'
    }
    const isLoopback = url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '[::1]'
      || url.hostname === '::1'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
      return 'Base URL 必须使用 HTTPS（localhost 本机服务可使用 HTTP）。'
    }
    return null
  } catch {
    return '请输入有效的 HTTP(S) Base URL。'
  }
}

function inferConfigurationMode(
  provider: ProviderPublicSettings | undefined,
  baseUrlValue: string,
): string {
  const modes = provider?.configurationModes
  if (!modes?.length) return ''
  const normalized = baseUrlValue.trim().replace(/\/+$/, '')
  return modes.find((mode) => mode.baseUrl?.replace(/\/+$/, '') === normalized)?.id
    ?? modes.find((mode) => mode.id === 'custom')?.id
    ?? modes[0].id
}

export function ProviderSettingsDialog({
  isOpen,
  providers,
  onClose,
  onSave,
  onTest,
  onDelete,
  onSetDefault,
}: ProviderSettingsDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const editorId = useId()
  const baseUrlId = useId()
  const modelId = useId()
  const apiKeyId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [selectedId, setSelectedId] = useState(() => providers[0]?.id ?? '')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [configurationModeId, setConfigurationModeId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [pending, setPending] = useState<PendingState | null>(null)
  const [feedback, setFeedback] = useState<InlineFeedback | null>(null)
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null)

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedId) ?? providers[0],
    [providers, selectedId],
  )

  const groupedProviders = useMemo(() => (
    categoryOrder.map((category) => ({
      category,
      providers: providers.filter((provider) => provider.category === category),
    })).filter((group) => group.providers.length > 0)
  ), [providers])

  const clearSecret = () => {
    setApiKey('')
    setShowApiKey(false)
  }

  const closeDialog = () => {
    clearSecret()
    setFeedback(null)
    setDeleteConfirmationId(null)
    onClose()
  }

  useEffect(() => {
    if (selectedProvider) return
    setSelectedId(providers[0]?.id ?? '')
  }, [providers, selectedProvider])

  useEffect(() => {
    if (!selectedProvider) {
      setBaseUrl('')
      setModel('')
      setConfigurationModeId('')
      clearSecret()
      return
    }
    const nextBaseUrl = selectedProvider.baseUrl ?? selectedProvider.defaultBaseUrl ?? ''
    setBaseUrl(nextBaseUrl)
    setModel(selectedProvider.model ?? selectedProvider.defaultModel ?? '')
    setConfigurationModeId(inferConfigurationMode(selectedProvider, nextBaseUrl))
    clearSecret()
    setFeedback(null)
    setDeleteConfirmationId(null)
  }, [
    selectedProvider?.id,
    selectedProvider?.baseUrl,
    selectedProvider?.defaultBaseUrl,
    selectedProvider?.model,
    selectedProvider?.defaultModel,
  ])

  useEffect(() => {
    if (isOpen) return
    clearSecret()
    setFeedback(null)
    setDeleteConfirmationId(null)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const dialog = dialogRef.current
    if (!dialog) return

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusFrame = window.requestAnimationFrame(() => {
      const initialFocus = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      ;(initialFocus ?? getFocusableElements(dialog)[0] ?? dialog).focus()
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDialog()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = getFocusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown, true)
      document.body.style.overflow = priorOverflow
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
    // The dialog owns one global focus trap for the duration of an open cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const selectProvider = (providerId: string) => {
    if (providerId === selectedId) return
    clearSecret()
    setSelectedId(providerId)
  }

  const selectConfigurationMode = (modeId: string) => {
    if (!selectedProvider?.configurationModes) return
    const mode = selectedProvider.configurationModes.find((candidate) => candidate.id === modeId)
    if (!mode) return
    setConfigurationModeId(mode.id)
    if (mode.baseUrl) setBaseUrl(mode.baseUrl)
    if (mode.defaultModel) setModel(mode.defaultModel)
    setFeedback(null)
  }

  const withPending = async (
    providerId: string,
    action: PendingAction,
    operation: () => void | Promise<void>,
  ) => {
    setPending({ providerId, action })
    setFeedback(null)
    try {
      await operation()
      return true
    } catch {
      setFeedback({
        kind: 'error',
        message: action === 'save'
          ? '保存失败。请检查配置后重试，密钥内容不会在此显示。'
          : action === 'delete'
            ? '删除失败，请稍后重试。'
            : action === 'default'
              ? '设为默认失败，请稍后重试。'
              : '连接测试失败，请检查 Provider 配置。',
      })
      return false
    } finally {
      setPending(null)
    }
  }

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedProvider || selectedProvider.authMode !== 'byok') return

    const trimmedBaseUrl = baseUrl.trim()
    const trimmedModel = model.trim()
    const baseUrlError = validateBaseUrl(trimmedBaseUrl)
    if (baseUrlError) {
      setFeedback({ kind: 'error', message: baseUrlError })
      return
    }
    if (!catalogAllowsBaseUrl(selectedProvider, trimmedBaseUrl)) {
      setFeedback({ kind: 'error', message: '请选择 Provider 注册表中的受信任官方区域。' })
      return
    }
    if (!trimmedModel) {
      setFeedback({ kind: 'error', message: '模型名不能为空。' })
      return
    }
    if (!catalogAllowsModel(selectedProvider, trimmedModel)) {
      setFeedback({ kind: 'error', message: '请选择当前 Provider 已支持的模型。' })
      return
    }
    if (!selectedProvider.hasStoredCredential && !apiKey.trim()) {
      setFeedback({ kind: 'error', message: '首次配置时必须输入 API Key。' })
      return
    }

    const secretForRequest = apiKey.trim()
    const payload: ProviderCredentialInput = {
      baseUrl: trimmedBaseUrl,
      model: trimmedModel,
      ...(secretForRequest ? { apiKey: secretForRequest } : {}),
    }

    const succeeded = await withPending(
      selectedProvider.id,
      'save',
      () => onSave(selectedProvider.id, payload),
    )
    // Drop every reference held by the component after a save attempt. The
    // callback is responsible for forwarding the payload without retaining it.
    clearSecret()
    payload.apiKey = undefined
    if (succeeded) {
      setFeedback({
        kind: 'success',
        message: '配置已安全保存；请运行“测试连接”，通过后才会标记为已连接。',
      })
    }
  }

  const handleTest = async (provider: ProviderPublicSettings) => {
    setPending({ providerId: provider.id, action: 'test' })
    setFeedback(null)
    try {
      const result = await onTest(provider.id)
      const timing = typeof result.latencyMs === 'number' && Number.isFinite(result.latencyMs)
        ? ` · ${Math.max(0, Math.round(result.latencyMs))} ms`
        : ''
      const fallback = provider.authMode === 'byoa'
        ? (result.ok ? '已检测到可用的本机账号授权。' : '未检测到可用的本机账号授权。')
        : (result.ok ? 'Provider 连接测试通过。' : 'Provider 连接测试未通过。')
      setFeedback({
        kind: result.ok ? 'success' : 'error',
        message: `${redactSensitiveText(result.summary) || fallback}${timing}`,
      })
    } catch {
      setFeedback({
        kind: 'error',
        message: provider.authMode === 'byoa'
          ? '授权检测失败，请确认 Codex Tools 本机服务正在运行。'
          : '连接测试失败，请检查 Provider 配置。',
      })
    } finally {
      setPending(null)
    }
  }

  const handleDelete = async (provider: ProviderPublicSettings) => {
    if (deleteConfirmationId !== provider.id) {
      setDeleteConfirmationId(provider.id)
      setFeedback({
        kind: 'error',
        message: '再次点击“确认删除”以停用当前凭据；仍被历史或可恢复任务引用的版本会按审计策略保留。',
      })
      return
    }
    const succeeded = await withPending(provider.id, 'delete', () => onDelete(provider.id))
    clearSecret()
    setDeleteConfirmationId(null)
    if (succeeded) {
      setFeedback({
        kind: 'success',
        message: '当前 Provider 凭据已停用并解除绑定；仅仍被历史或可恢复任务引用的版本化凭据会保留。',
      })
    }
  }

  const handleSetDefault = async (provider: ProviderPublicSettings) => {
    const succeeded = await withPending(
      provider.id,
      'default',
      () => onSetDefault(provider.id),
    )
    if (succeeded) {
      setFeedback({
        kind: 'success',
        message: `已将 ${provider.name} 设为${categoryMeta[provider.category].label}默认 Provider。`,
      })
    }
  }

  const handleBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) closeDialog()
  }

  if (!isOpen || typeof document === 'undefined') return null

  return createPortal(
    <div className="provider-dialog-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        ref={dialogRef}
        className="provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className="provider-dialog-header">
          <div>
            <span className="provider-dialog-eyebrow"><PlugZap size={13} /> AIGC PROVIDERS</span>
            <h2 id={titleId}>Provider 设置中心</h2>
            <p id={descriptionId}>管理文本、图片、视频和语音生成服务。项目中不保存任何密钥。</p>
          </div>
          <button
            type="button"
            className="provider-dialog-close"
            onClick={closeDialog}
            aria-label="关闭 Provider 设置"
            data-dialog-initial-focus
          >
            <X size={18} />
          </button>
        </header>

        <div className="provider-security-note">
          <ShieldCheck size={15} aria-hidden="true" />
          <span><strong>凭据隔离</strong> · BYOK 密钥只发送给本机服务并写入 macOS 钥匙串；BYOA 只检测现有 Codex Tools 授权。</span>
        </div>

        <div className="provider-security-note">
          <MessageSquareText size={15} aria-hidden="true" />
          <span><strong>LLM / Agentic 免费</strong> · 平台内文字生成、文本理解、视觉判断与 Agentic 编排都不进入计费确认；仍只在你点击后创建持久幂等任务。BYOK / BYOA 上游账户是否收费仍以对应 Provider 账单为准。</span>
        </div>

        <div className="provider-dialog-content">
          <div className="provider-catalog" aria-label="Provider 列表">
            {groupedProviders.map(({ category, providers: categoryProviders }) => {
              const meta = categoryMeta[category]
              const CategoryIcon = meta.icon
              const headingId = `${titleId}-${category}`
              return (
                <section key={category} className="provider-category" aria-labelledby={headingId}>
                  <header>
                    <span className={`provider-category-icon ${category}`}><CategoryIcon size={14} /></span>
                    <div>
                      <h3 id={headingId}>{meta.label}</h3>
                      <p>{meta.description}</p>
                    </div>
                  </header>
                  <div className="provider-card-grid">
                    {categoryProviders.map((provider) => {
                      const status = statusMeta[provider.connectionState]
                      const StatusIcon = status.icon
                      const selected = provider.id === selectedProvider?.id
                      return (
                        <article
                          key={provider.id}
                          className={`provider-card ${selected ? 'selected' : ''}`}
                          data-state={provider.connectionState}
                        >
                          <button
                            type="button"
                            className="provider-card-select"
                            onClick={() => selectProvider(provider.id)}
                            aria-pressed={selected}
                            aria-controls={editorId}
                          >
                            <span className="provider-card-title-row">
                              <strong>{provider.name}</strong>
                              {provider.badge && <small>{provider.badge}</small>}
                            </span>
                            <span className="provider-card-description">{provider.description}</span>
                            <span className="provider-card-meta">
                              <span className={`provider-status ${provider.connectionState}`}>
                                <StatusIcon size={12} />{provider.connectionLabel ?? status.label}
                              </span>
                              <span className="provider-auth-mode">{provider.authMode.toUpperCase()}</span>
                              {provider.isDefault && <span className="provider-default"><Star size={10} fill="currentColor" />默认</span>}
                            </span>
                            <ChevronRight size={15} className="provider-card-arrow" aria-hidden="true" />
                          </button>
                        </article>
                      )
                    })}
                  </div>
                </section>
              )
            })}
            {providers.length === 0 && (
              <div className="provider-empty-state">
                <PlugZap size={22} />
                <strong>暂无可配置的 Provider</strong>
                <span>请确认本地 Provider 注册表已加载。</span>
              </div>
            )}
          </div>

          <aside id={editorId} className="provider-editor" aria-live="polite">
            {selectedProvider ? (
              <>
                <header className="provider-editor-header">
                  <div>
                    <span>{categoryMeta[selectedProvider.category].label}</span>
                    <h3>{selectedProvider.name}</h3>
                  </div>
                  <span className={`provider-state-pill ${selectedProvider.connectionState}`}>
                    {(() => {
                      const StatusIcon = statusMeta[selectedProvider.connectionState].icon
                      return <StatusIcon size={12} />
                    })()}
                    {selectedProvider.connectionLabel ?? statusMeta[selectedProvider.connectionState].label}
                  </span>
                </header>

                {selectedProvider.statusDetail && (
                  <p className="provider-status-detail">
                    {redactSensitiveText(selectedProvider.statusDetail)}
                  </p>
                )}

                {selectedProvider.verificationNotice && (
                  <p className="provider-verification-notice" role="note">
                    <AlertCircle size={13} aria-hidden="true" />
                    <span>{selectedProvider.verificationNotice}</span>
                  </p>
                )}

                {selectedProvider.authMode === 'byoa' ? (
                  <div className="provider-byoa-panel">
                    <div className="provider-auth-illustration"><ShieldCheck size={23} /></div>
                    <h4>本机账号授权</h4>
                    <p>漫剧 Studio 只检测 Codex Tools 的本地授权状态，不会读取、复制或伪造 OAuth 凭据。</p>
                    <dl className="provider-readonly-config">
                      <div><dt>Base URL</dt><dd>{selectedProvider.baseUrl ?? selectedProvider.defaultBaseUrl ?? '由本机服务提供'}</dd></div>
                      <div><dt>模型</dt><dd>{selectedProvider.model ?? selectedProvider.defaultModel ?? '自动检测'}</dd></div>
                    </dl>
                    <button
                      type="button"
                      className="provider-action primary"
                      onClick={() => handleTest(selectedProvider)}
                      disabled={pending !== null}
                    >
                      {pending?.providerId === selectedProvider.id && pending.action === 'test'
                        ? <LoaderCircle size={14} className="spin" />
                        : <RefreshCcw size={14} />}
                      检测本机授权
                    </button>
                  </div>
                ) : (
                  <form className="provider-byok-form" onSubmit={handleSave}>
                    {selectedProvider.configurationModes && (
                      <div className="provider-form-field">
                        <label htmlFor={`${baseUrlId}-mode`}>接入方式</label>
                        <select
                          id={`${baseUrlId}-mode`}
                          value={configurationModeId}
                          onChange={(event) => selectConfigurationMode(event.target.value)}
                          disabled={pending !== null}
                          required
                        >
                          {selectedProvider.configurationModes.map((mode) => (
                            <option key={mode.id} value={mode.id}>{mode.label}</option>
                          ))}
                        </select>
                        <small>{selectedProvider.configurationModes.find((mode) => mode.id === configurationModeId)?.description}</small>
                      </div>
                    )}
                    <div className="provider-form-field">
                      <label htmlFor={baseUrlId}>Base URL</label>
                      {selectedProvider.baseUrlPresets ? (
                        <select
                          id={baseUrlId}
                          value={baseUrl.replace(/\/+$/, '')}
                          onChange={(event) => setBaseUrl(event.target.value)}
                          disabled={!selectedProvider.editableBaseUrl || pending !== null}
                          required
                        >
                          {selectedProvider.baseUrlPresets.map((preset) => (
                            <option key={preset.value} value={preset.value}>{preset.label}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={baseUrlId}
                          type="url"
                          inputMode="url"
                          value={baseUrl}
                          onChange={(event) => setBaseUrl(event.target.value)}
                          disabled={!(selectedProvider.configurationModes
                            ? selectedProvider.configurationModes.find((mode) => mode.id === configurationModeId)?.editableBaseUrl
                            : selectedProvider.editableBaseUrl) || pending !== null}
                          placeholder="https://api.example.com/v1"
                          autoComplete="off"
                          spellCheck={false}
                          required
                        />
                      )}
                      {selectedProvider.baseUrlHelp && <small>{selectedProvider.baseUrlHelp}</small>}
                      {selectedProvider.baseUrlPresets && !selectedProvider.baseUrlHelp && <small>仅允许 Provider 注册表中的官方 API 地址</small>}
                      {!selectedProvider.editableBaseUrl && !selectedProvider.baseUrlHelp && <small>Provider 注册表锁定的官方地址</small>}
                    </div>

                    <div className="provider-form-field">
                      <label htmlFor={modelId}>模型</label>
                      {(selectedProvider.configurationModes
                        ? selectedProvider.configurationModes.find((mode) => mode.id === configurationModeId)?.modelOptions
                        : selectedProvider.modelOptions) ? (
                        <select
                          id={modelId}
                          value={model}
                          onChange={(event) => setModel(event.target.value)}
                          disabled={pending !== null}
                          required
                        >
                          {(selectedProvider.configurationModes
                            ? selectedProvider.configurationModes.find((mode) => mode.id === configurationModeId)?.modelOptions
                            : selectedProvider.modelOptions)!.map((option) => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={modelId}
                          type="text"
                          value={model}
                          onChange={(event) => setModel(event.target.value)}
                          disabled={!(selectedProvider.configurationModes
                            ? selectedProvider.configurationModes.find((mode) => mode.id === configurationModeId)?.editableModel
                            : selectedProvider.editableModel) || pending !== null}
                          placeholder="model-name"
                          autoComplete="off"
                          spellCheck={false}
                          required
                        />
                      )}
                      {selectedProvider.modelHelp && <small>{selectedProvider.modelHelp}</small>}
                      {selectedProvider.modelOptions && !selectedProvider.modelHelp && <small>仅列出当前 Provider Adapter 支持的模型</small>}
                      {!selectedProvider.editableModel && <small>已锁定 MVP 验收模型</small>}
                    </div>

                    <div className="provider-form-field">
                      <label htmlFor={apiKeyId}>API Key</label>
                      <div className="provider-secret-input">
                        <KeyRound size={14} aria-hidden="true" />
                        <input
                          id={apiKeyId}
                          type={showApiKey ? 'text' : 'password'}
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                          disabled={pending !== null}
                          placeholder={selectedProvider.hasStoredCredential ? '已安全保存 · 留空保持不变' : '输入 Provider API Key'}
                          autoComplete="new-password"
                          autoCapitalize="none"
                          spellCheck={false}
                          required={!selectedProvider.hasStoredCredential}
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey((visible) => !visible)}
                          disabled={!apiKey || pending !== null}
                          aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                        >
                          {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                      <small><ShieldCheck size={11} /> 仅写入 macOS 钥匙串，项目、浏览器存储和日志均不保留</small>
                    </div>

                    <div className="provider-form-actions">
                      <button
                        type="submit"
                        className="provider-action primary"
                        disabled={pending !== null}
                      >
                        {pending?.providerId === selectedProvider.id && pending.action === 'save'
                          ? <LoaderCircle size={14} className="spin" />
                          : <ShieldCheck size={14} />}
                        保存到钥匙串
                      </button>
                      <button
                        type="button"
                        className="provider-action secondary"
                        onClick={() => handleTest(selectedProvider)}
                        disabled={pending !== null || !selectedProvider.hasStoredCredential}
                        title={selectedProvider.hasStoredCredential ? undefined : '请先保存凭据'}
                      >
                        {pending?.providerId === selectedProvider.id && pending.action === 'test'
                          ? <LoaderCircle size={14} className="spin" />
                          : <PlugZap size={14} />}
                        测试连接
                      </button>
                    </div>
                  </form>
                )}

                {feedback && (
                  <div className={`provider-feedback ${feedback.kind}`} role="status">
                    {feedback.kind === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                    <span>{redactSensitiveText(feedback.message, apiKey)}</span>
                  </div>
                )}

                <footer className="provider-editor-footer">
                  <button
                    type="button"
                    className="provider-action quiet"
                    onClick={() => handleSetDefault(selectedProvider)}
                    disabled={pending !== null || selectedProvider.isDefault || selectedProvider.connectionState !== 'connected'}
                  >
                    {pending?.providerId === selectedProvider.id && pending.action === 'default'
                      ? <LoaderCircle size={13} className="spin" />
                      : selectedProvider.isDefault ? <Check size={13} /> : <Star size={13} />}
                    {selectedProvider.isDefault ? '当前默认' : '设为默认'}
                  </button>
                  {selectedProvider.authMode === 'byok' && selectedProvider.hasStoredCredential && (
                    <button
                      type="button"
                      className={`provider-action danger ${deleteConfirmationId === selectedProvider.id ? 'confirming' : ''}`}
                      onClick={() => handleDelete(selectedProvider)}
                      disabled={pending !== null}
                    >
                      {pending?.providerId === selectedProvider.id && pending.action === 'delete'
                        ? <LoaderCircle size={13} className="spin" />
                        : <Trash2 size={13} />}
                      {deleteConfirmationId === selectedProvider.id ? '确认删除' : '删除凭据'}
                    </button>
                  )}
                </footer>
              </>
            ) : (
              <div className="provider-editor-placeholder">
                <PlugZap size={24} />
                <strong>选择 Provider</strong>
                <span>在左侧选择一个服务后查看连接设置。</span>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default ProviderSettingsDialog
