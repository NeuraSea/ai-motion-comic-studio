import type { ProviderConnection, ProviderKind } from '../../lib'

export type ProviderUiConnectionState =
  | 'unconfigured'
  | 'disabled'
  | 'untested'
  | 'connected'
  | 'degraded'
  | 'unavailable'

export interface SpeechControlPolicy {
  supportsEmotion: boolean
  supportsVolume: boolean
  supportsWordTimestamps: boolean
  voiceLabel: string
}

export function hasProviderCredential(provider: ProviderConnection | undefined): boolean {
  return provider?.credentialState === 'present' || provider?.credentialState === 'external'
}

/**
 * A saved credential is not a successful connection test. Only a current
 * `health.status === "ok"` result may be presented as connected.
 */
export function providerUiConnectionState(
  provider: ProviderConnection | undefined,
): ProviderUiConnectionState {
  if (!provider || !hasProviderCredential(provider)) return 'unconfigured'
  if (!provider.enabled) return 'disabled'
  if (provider.health.status === 'ok') return 'connected'
  return provider.health.status
}

export function providerStatusDetail(provider: ProviderConnection | undefined): string {
  if (!provider || !hasProviderCredential(provider)) return '尚未配置可用凭据。'
  if (!provider.enabled) return '凭据已保存，但 Provider 当前已停用。'
  const message = provider.health.message.trim()
    .replace(/\bbearer\s+[a-z0-9._~+/=-]{8,}/gi, 'Bearer [已隐藏]')
    .replace(/\b(authorization|api[-_ ]?key|access[-_ ]?token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1: [已隐藏]')
    .slice(0, 240)
  if (message) return message
  if (provider.health.status === 'untested') return '凭据已保存，尚未运行连接测试。'
  if (provider.health.status === 'degraded') return 'Provider 连接受限，请重新测试。'
  if (provider.health.status === 'unavailable') return 'Provider 当前不可用，请检查配置后重新测试。'
  return '连接测试已通过。'
}

function isSeedanceAgentPlan(provider: ProviderConnection | undefined): boolean {
  if (!provider || provider.adapter !== 'seedance') return false
  try {
    return new URL(provider.baseUrl).pathname.replace(/\/+$/, '').endsWith('/api/plan/v3')
  } catch {
    return false
  }
}

/** A green Agent Plan probe proves only the non-billable list route. */
export function providerConnectionLabel(provider: ProviderConnection | undefined): string | null {
  if (providerUiConnectionState(provider) !== 'connected') return null
  if (isSeedanceAgentPlan(provider)) return '列表可用'
  if (provider?.adapter === 'seedance') return '路由可用'
  return null
}

export function providerVerificationNotice(provider: ProviderConnection | undefined): string | null {
  if (providerUiConnectionState(provider) !== 'connected' || provider?.adapter !== 'seedance') {
    return null
  }
  return isSeedanceAgentPlan(provider)
    ? '零计费只读诊断：只验证当前 Key、模型过滤与任务列表路由；不会创建视频，也不能证明套餐创建额度已经恢复。'
    : '零计费连接诊断：不会创建视频，也不能证明账号余额、限额或实际创建权限可用。'
}

function adapterSupportsKind(provider: ProviderConnection, kind: ProviderKind): boolean {
  if (kind === 'text') {
    return provider.adapter === 'codex-tools' || provider.adapter === 'openai-compatible'
  }
  if (kind === 'image') {
    return provider.adapter === 'codex-tools' || provider.adapter === 'openai-compatible'
  }
  if (kind === 'video') return provider.adapter === 'seedance'
  return provider.adapter === 'minimax'
    || provider.adapter === 'openai-compatible'
    || provider.adapter === 'indextts'
    || provider.adapter === 'doubao-speech'
}

function requiredCapability(kind: ProviderKind): string | null {
  if (kind === 'image') return 'generate'
  if (kind === 'speech') return 'speech'
  if (kind === 'video') return 'text-to-video'
  return null
}

/** Mirrors the non-health execution prerequisites enforced by the API. */
export function isProviderRuntimeExecutable(
  provider: ProviderConnection | undefined,
  kind: ProviderKind,
): provider is ProviderConnection {
  if (!provider || provider.kind !== kind || !adapterSupportsKind(provider, kind)) return false
  const capability = requiredCapability(kind)
  return provider.enabled
    && hasProviderCredential(provider)
    && Boolean(provider.baseUrl.trim())
    && Boolean(provider.model.trim())
    && (capability === null || provider.capabilities.includes(capability))
}

export function defaultProviderForKind(
  providers: readonly ProviderConnection[],
  kind: ProviderKind,
): ProviderConnection | null {
  return providers.find((provider) => provider.kind === kind && provider.isDefault) ?? null
}

export function defaultExecutableProviderForKind(
  providers: readonly ProviderConnection[],
  kind: ProviderKind,
): ProviderConnection | null {
  const provider = defaultProviderForKind(providers, kind) ?? undefined
  return isProviderRuntimeExecutable(provider, kind) ? provider : null
}

export function providerSupportsCapability(
  provider: ProviderConnection | null | undefined,
  capability: string,
): boolean {
  return Boolean(provider?.capabilities.includes(capability))
}

/** Seedance is fail-closed until the exact saved model/key has passed a test. */
export function seedanceGenerationBlockReason(
  provider: ProviderConnection | undefined,
): string | null {
  if (!provider || provider.kind !== 'video' || provider.adapter !== 'seedance') {
    return '请先配置 Seedance 2.0 Provider。'
  }
  if (!provider.enabled) return 'Seedance 2.0 Provider 已停用，请先启用。'
  if (!hasProviderCredential(provider)) return '请先保存 Seedance 2.0 API Key。'
  if (!provider.baseUrl.trim()) return '请先填写 Seedance 2.0 Base URL。'
  if (!provider.model.trim()) return '请先填写 Seedance 2.0 模型名。'
  if (!providerSupportsCapability(provider, 'text-to-video')) {
    return '当前 Seedance Provider 未声明可执行的视频生成能力。'
  }
  if (provider.health.status === 'untested') {
    return 'Seedance 凭据已保存但尚未验证，请先在 Provider 设置中点击“测试连接”。'
  }
  if (provider.health.status !== 'ok') {
    return 'Seedance 连接测试未通过，请检查配置并重新测试。'
  }
  return null
}

export function isVerifiedSeedanceProvider(
  provider: ProviderConnection | undefined,
): provider is ProviderConnection {
  return seedanceGenerationBlockReason(provider) === null
}

export function speechControlPolicy(
  provider: ProviderConnection | null | undefined,
): SpeechControlPolicy {
  const isMiniMax = provider?.adapter === 'minimax'
  const isIndexTts = provider?.adapter === 'indextts'
  const isDoubao = provider?.adapter === 'doubao-speech'
  return {
    supportsEmotion: isMiniMax || isIndexTts || isDoubao,
    supportsVolume: isMiniMax || isDoubao,
    supportsWordTimestamps: isMiniMax
      && providerSupportsCapability(provider, 'word-timestamps'),
    voiceLabel: isMiniMax
      ? 'MiniMax voice_id'
      : isIndexTts
        ? 'IndexTTS 声线 ID'
        : isDoubao
          ? '豆包 voice_type'
        : 'Voice',
  }
}
