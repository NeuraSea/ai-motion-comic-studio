import type {
  CreateAssetImageEditInput,
  GenerateImageInput,
  PublicPaidAigcConfirmation,
} from '../../lib'

export function paidAigcConfirmationExpired(
  confirmation: PublicPaidAigcConfirmation,
  nowEpochMs = Date.now(),
): boolean {
  const expiresAt = Date.parse(confirmation.expiresAt)
  return !Number.isFinite(expiresAt) || nowEpochMs >= expiresAt
}

function required(value: string, field: string): string {
  if (!value || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty exact value`)
  }
  return value
}

function frozenClone<T>(value: T): Readonly<T> {
  const clone = structuredClone(value)
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Object.isFrozen(candidate)) return
    for (const nested of Object.values(candidate)) freeze(nested)
    Object.freeze(candidate)
  }
  freeze(clone)
  return clone
}

export type AssetImageGenerationPurpose =
  | Readonly<{ kind: 'storyboard'; shotId: number; shotCode: string }>
  | Readonly<{ kind: 'primary-character'; label: string }>
  | Readonly<{
      kind: 'visual-asset'
      targetType: 'character' | 'location' | 'prop'
      targetId: string
      label: string
    }>

export interface FrozenAssetImageGenerationAttempt {
  readonly action: 'asset.image.generate'
  readonly signature: string
  readonly idempotencyKey: string
  readonly projectId: string
  readonly episodeId: string | null
  readonly providerId: string
  readonly input: Readonly<GenerateImageInput>
  readonly purpose: AssetImageGenerationPurpose
}

export interface FrozenAssetImageEditAttempt {
  readonly action: 'asset.image.edit'
  readonly signature: string
  readonly idempotencyKey: string
  readonly sourceAssetId: string
  readonly sourceEtag: string
  readonly input: Readonly<CreateAssetImageEditInput>
  readonly purpose: Readonly<{
    kind: 'visual-asset-edit'
    targetType: 'character' | 'location' | 'prop'
    targetId: string
    label: string
    sourceLabel: string
  }>
}

export type FrozenAssetImagePaidAttempt =
  | FrozenAssetImageGenerationAttempt
  | FrozenAssetImageEditAttempt

export function freezeAssetImageGenerationAttempt(input: {
  signature: string
  idempotencyKey: string
  projectId: string
  episodeId: string | null
  providerId: string
  request: GenerateImageInput
  purpose: AssetImageGenerationPurpose
}): FrozenAssetImageGenerationAttempt {
  return Object.freeze({
    action: 'asset.image.generate' as const,
    signature: required(input.signature, 'signature'),
    idempotencyKey: required(input.idempotencyKey, 'idempotencyKey'),
    projectId: required(input.projectId, 'projectId'),
    episodeId: input.episodeId === null ? null : required(input.episodeId, 'episodeId'),
    providerId: required(input.providerId, 'providerId'),
    input: frozenClone(input.request),
    purpose: frozenClone(input.purpose),
  })
}

export function freezeAssetImageEditAttempt(input: {
  signature: string
  idempotencyKey: string
  sourceAssetId: string
  sourceEtag: string
  request: CreateAssetImageEditInput
  purpose: FrozenAssetImageEditAttempt['purpose']
}): FrozenAssetImageEditAttempt {
  return Object.freeze({
    action: 'asset.image.edit' as const,
    signature: required(input.signature, 'signature'),
    idempotencyKey: required(input.idempotencyKey, 'idempotencyKey'),
    sourceAssetId: required(input.sourceAssetId, 'sourceAssetId'),
    sourceEtag: required(input.sourceEtag, 'sourceEtag'),
    input: frozenClone(input.request),
    purpose: frozenClone(input.purpose),
  })
}

export function confirmationMatchesAssetImageAttempt(
  attempt: FrozenAssetImagePaidAttempt,
  confirmation: PublicPaidAigcConfirmation,
  nowEpochMs = Date.now(),
): boolean {
  return confirmation.action === attempt.action
    && confirmation.billableTaskCount === 1
    && !paidAigcConfirmationExpired(confirmation, nowEpochMs)
}

