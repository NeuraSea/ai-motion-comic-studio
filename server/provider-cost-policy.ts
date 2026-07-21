import type { ProviderKind } from './database.js'
import type { JsonObject } from './types.js'

export const PROVIDER_PLATFORM_COST_POLICY_VERSION = 1 as const

export type ProviderPlatformCostClass = 'free-llm' | 'billable-media'

/**
 * Platform billing policy recorded on every durable Provider-backed Job.
 *
 * `platformBillable` describes only Manju's confirmation/accounting boundary.
 * A BYOK/BYOA Provider may still charge its own account, so this record never
 * claims that upstream usage has zero monetary cost.
 */
export interface ProviderPlatformCostPolicy extends JsonObject {
  version: typeof PROVIDER_PLATFORM_COST_POLICY_VERSION
  costClass: ProviderPlatformCostClass
  billable: boolean
  paidConfirmationRequired: boolean
  upstreamProviderBilling: 'outside-platform-policy'
}

export function providerPlatformCostPolicy(
  kind: ProviderKind,
): ProviderPlatformCostPolicy {
  const freeLlm = kind === 'text'
  return {
    version: PROVIDER_PLATFORM_COST_POLICY_VERSION,
    costClass: freeLlm ? 'free-llm' : 'billable-media',
    billable: !freeLlm,
    paidConfirmationRequired: !freeLlm,
    upstreamProviderBilling: 'outside-platform-policy',
  }
}

/**
 * Preserve Provider usage metadata while making the platform classification
 * authoritative. Callers cannot downgrade a media Job or mark an LLM Job as
 * platform-billable by supplying conflicting keys in `cost`.
 */
export function withProviderPlatformCostPolicy(
  kind: ProviderKind,
  cost: JsonObject | null | undefined,
): JsonObject {
  return {
    ...(cost ?? {}),
    platformPolicy: providerPlatformCostPolicy(kind),
  }
}
