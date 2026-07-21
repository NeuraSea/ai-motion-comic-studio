import type { ProviderPublicState } from './providers/service.js'

export type ProviderCapabilityState =
  | 'ready'
  | 'unverified'
  | 'unavailable'
  | 'unconfigured'
  | 'disabled'

export interface ProviderCapabilityReadiness {
  /** External generation is optional for the local editor/API process. */
  requiredForApi: false
  status: 'ready' | 'partial' | 'unavailable' | 'unconfigured'
  providers: Array<{
    providerId: string
    kind: ProviderPublicState['kind']
    label: string
    isDefault: boolean
    enabled: boolean
    configured: boolean
    ready: boolean
    state: ProviderCapabilityState
    healthStatus: ProviderPublicState['health']['status']
    capabilities: string[]
  }>
}

function providerState(provider: ProviderPublicState): ProviderCapabilityState {
  if (!provider.enabled) return 'disabled'
  if (provider.credentialState === 'missing' || !provider.model.trim()) return 'unconfigured'
  if (provider.health.status === 'ok') return 'ready'
  if (provider.health.status === 'untested') return 'unverified'
  return 'unavailable'
}

/**
 * Produces a secret-free capability view. Missing optional external Providers
 * remain visible but do not make the database/editor API itself unready.
 */
export function summarizeProviderCapabilities(
  providers: readonly ProviderPublicState[],
): ProviderCapabilityReadiness {
  const values = providers.map((provider) => {
    const state = providerState(provider)
    return {
      providerId: provider.id,
      kind: provider.kind,
      label: provider.label,
      isDefault: provider.isDefault,
      enabled: provider.enabled,
      configured: provider.enabled
        && provider.credentialState !== 'missing'
        && provider.model.trim().length > 0,
      ready: state === 'ready',
      state,
      healthStatus: provider.health.status,
      capabilities: [...provider.capabilities],
    }
  })
  const selected = values.filter((provider) => provider.isDefault)
  const considered = selected.length > 0 ? selected : values
  const ready = considered.filter((provider) => provider.ready).length
  const configured = considered.filter((provider) => provider.configured).length
  const status = considered.length > 0 && ready === considered.length
    ? 'ready' as const
    : ready > 0
      ? 'partial' as const
      : configured > 0
        ? 'unavailable' as const
        : 'unconfigured' as const
  return {
    requiredForApi: false,
    status,
    providers: values,
  }
}

export function unavailableProviderCapabilities(): ProviderCapabilityReadiness {
  return {
    requiredForApi: false,
    status: 'unavailable',
    providers: [],
  }
}
