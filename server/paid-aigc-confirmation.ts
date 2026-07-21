import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import type { JsonValue } from './types.js'

export const PAID_AIGC_CONFIRMATION_VERSION = 1 as const
export const DEFAULT_PAID_AIGC_CONFIRMATION_TTL_SECONDS = 5 * 60
export const PAID_AIGC_CONFIRMATION_HEADER = 'x-manju-aigc-confirmation'

export const paidAigcActions = [
  'asset.image.generate',
  'asset.image.edit',
  'dialogue.speech.generate',
  'project.narrator.voice.preview',
  'character.voice.preview',
] as const

export type PaidAigcAction = typeof paidAigcActions[number]

export interface PaidAigcProviderBinding {
  providerId: string
  model: string
  configRevision: number
}

/**
 * Exact server-authored state admitted by one paid confirmation. `input` may
 * contain private prompt material, but it is used only in the in-memory HMAC
 * payload and is never returned to the browser or persisted by this module.
 */
export interface PaidAigcConfirmationIntent {
  action: PaidAigcAction
  projectId: string
  episodeId: string | null
  resourceId: string
  idempotencyKey: string
  provider: PaidAigcProviderBinding
  input: JsonValue
}

export interface PublicPaidAigcConfirmation {
  version: typeof PAID_AIGC_CONFIRMATION_VERSION
  action: PaidAigcAction
  label: string
  billableTaskCount: 1
  provider: PaidAigcProviderBinding
  intentFingerprint: string
  expiresAt: string
  confirmationToken: string
  priceEstimate: null
  priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE'
}

export type PaidAigcConfirmationVerification = 'valid' | 'expired' | 'invalid'

interface ConfirmationPayload {
  version: typeof PAID_AIGC_CONFIRMATION_VERSION
  action: PaidAigcAction
  projectId: string
  episodeId: string | null
  resourceId: string
  idempotencyKey: string
  provider: PaidAigcProviderBinding
  input: JsonValue
  expiresAtEpochSeconds: number
}

function assertBoundedText(value: string, field: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`${field} is invalid`)
  }
  return normalized
}

function assertProvider(provider: PaidAigcProviderBinding): PaidAigcProviderBinding {
  if (!Number.isSafeInteger(provider.configRevision) || provider.configRevision < 1) {
    throw new TypeError('provider.configRevision must be a positive safe integer')
  }
  return {
    providerId: assertBoundedText(provider.providerId, 'provider.providerId', 256),
    model: assertBoundedText(provider.model, 'provider.model', 512),
    configRevision: provider.configRevision,
  }
}

function canonicalJson(value: JsonValue): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('confirmation input contains a non-finite number')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item))
  const output: Record<string, JsonValue> = {}
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new TypeError('confirmation input contains a forbidden key')
    }
    output[key] = canonicalJson(value[key]!)
  }
  return output
}

function payloadFor(
  intent: PaidAigcConfirmationIntent,
  expiresAtEpochSeconds: number,
): ConfirmationPayload {
  if (!paidAigcActions.includes(intent.action)) throw new TypeError('action is invalid')
  if (!Number.isSafeInteger(expiresAtEpochSeconds) || expiresAtEpochSeconds < 1) {
    throw new TypeError('expiresAtEpochSeconds must be a positive safe integer')
  }
  return {
    version: PAID_AIGC_CONFIRMATION_VERSION,
    action: intent.action,
    projectId: assertBoundedText(intent.projectId, 'projectId', 256),
    episodeId: intent.episodeId === null
      ? null
      : assertBoundedText(intent.episodeId, 'episodeId', 256),
    resourceId: assertBoundedText(intent.resourceId, 'resourceId', 512),
    idempotencyKey: assertBoundedText(intent.idempotencyKey, 'idempotencyKey', 512),
    provider: assertProvider(intent.provider),
    input: canonicalJson(intent.input),
    expiresAtEpochSeconds,
  }
}

function serializedPayload(payload: ConfirmationPayload): string {
  return JSON.stringify(payload)
}

function intentFingerprint(payload: ConfirmationPayload): string {
  const { expiresAtEpochSeconds: _expiresAtEpochSeconds, ...intent } = payload
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex')
}

function epochSeconds(now: Date): number {
  const value = Math.floor(now.getTime() / 1_000)
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('now is invalid')
  return value
}

export class PaidAigcConfirmationGate {
  private readonly secret: Buffer
  private readonly ttlSeconds: number
  private readonly now: () => Date

  constructor(options: {
    secret: Uint8Array
    ttlSeconds?: number
    now?: () => Date
  }) {
    this.secret = Buffer.from(options.secret)
    if (this.secret.byteLength < 32) throw new RangeError('secret must contain at least 32 bytes')
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_PAID_AIGC_CONFIRMATION_TTL_SECONDS
    if (!Number.isSafeInteger(this.ttlSeconds) || this.ttlSeconds < 30 || this.ttlSeconds > 30 * 60) {
      throw new RangeError('ttlSeconds must be between 30 and 1800 seconds')
    }
    this.now = options.now ?? (() => new Date())
  }

  issue(intent: PaidAigcConfirmationIntent, label: string): PublicPaidAigcConfirmation {
    const expiresAtEpochSeconds = epochSeconds(this.now()) + this.ttlSeconds
    const payload = payloadFor(intent, expiresAtEpochSeconds)
    const mac = createHmac('sha256', this.secret).update(serializedPayload(payload)).digest('hex')
    return {
      version: PAID_AIGC_CONFIRMATION_VERSION,
      action: payload.action,
      label: assertBoundedText(label, 'label', 200),
      billableTaskCount: 1,
      provider: { ...payload.provider },
      intentFingerprint: intentFingerprint(payload),
      expiresAt: new Date(expiresAtEpochSeconds * 1_000).toISOString(),
      confirmationToken: `aigcpf1_${expiresAtEpochSeconds}_${mac}`,
      priceEstimate: null,
      priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE',
    }
  }

  verify(
    intent: PaidAigcConfirmationIntent,
    confirmationToken: string,
  ): PaidAigcConfirmationVerification {
    const match = /^aigcpf1_([1-9][0-9]{9,12})_([a-f0-9]{64})$/.exec(confirmationToken)
    if (!match) return 'invalid'
    const expiresAtEpochSeconds = Number(match[1])
    if (!Number.isSafeInteger(expiresAtEpochSeconds)) return 'invalid'
    let payload: ConfirmationPayload
    try {
      payload = payloadFor(intent, expiresAtEpochSeconds)
    } catch {
      return 'invalid'
    }
    const expected = createHmac('sha256', this.secret).update(serializedPayload(payload)).digest()
    const actual = Buffer.from(match[2], 'hex')
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return 'invalid'
    return epochSeconds(this.now()) >= expiresAtEpochSeconds ? 'expired' : 'valid'
  }
}
