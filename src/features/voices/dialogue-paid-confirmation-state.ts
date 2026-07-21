import type {
  CreateDialogueSpeechJobInput,
  PublicPaidAigcConfirmation,
} from '../../lib'
import { paidAigcConfirmationExpired } from '../paid-aigc/paid-aigc-confirmation-state'

export interface DialoguePerformanceRecommendationRequest {
  projectId: string
  episodeId: string
  textProviderId?: string
}

export interface FrozenDialoguePerformanceRecommendationAttempt {
  readonly action: 'dialogue.performance.recommendation'
  readonly signature: string
  readonly lineId: string
  readonly idempotencyKey: string
  readonly input: Readonly<DialoguePerformanceRecommendationRequest>
}

export interface FrozenDialogueSpeechGenerationAttempt {
  readonly action: 'dialogue.speech.generate'
  readonly signature: string
  readonly lineId: string
  readonly projectId: string
  readonly episodeId: string
  readonly sourceRevisionId: string | null
  readonly idempotencyKey: string
  readonly input: Readonly<CreateDialogueSpeechJobInput>
}

export type FrozenDialoguePaidAttempt =
  FrozenDialogueSpeechGenerationAttempt

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

/** Freeze the exact free request so an ambiguous retry reuses the same key. */
export function freezeDialoguePerformanceRecommendationAttempt(input: {
  signature: string
  lineId: string
  idempotencyKey: string
  request: DialoguePerformanceRecommendationRequest
}): FrozenDialoguePerformanceRecommendationAttempt {
  const request = frozenClone(input.request)
  required(request.projectId, 'request.projectId')
  required(request.episodeId, 'request.episodeId')
  if (request.textProviderId !== undefined) {
    required(request.textProviderId, 'request.textProviderId')
  }
  return Object.freeze({
    action: 'dialogue.performance.recommendation' as const,
    signature: required(input.signature, 'signature'),
    lineId: required(input.lineId, 'lineId'),
    idempotencyKey: required(input.idempotencyKey, 'idempotencyKey'),
    input: request,
  })
}

/** Freeze inherited voice selection and every explicit delivery control. */
export function freezeDialogueSpeechGenerationAttempt(input: {
  signature: string
  lineId: string
  projectId: string
  episodeId: string
  sourceRevisionId: string | null
  idempotencyKey: string
  request: CreateDialogueSpeechJobInput
}): FrozenDialogueSpeechGenerationAttempt {
  const request = frozenClone(input.request)
  const projectId = required(input.projectId, 'projectId')
  const episodeId = required(input.episodeId, 'episodeId')
  if (required(request.projectId, 'request.projectId') !== projectId) {
    throw new TypeError('request.projectId must match projectId')
  }
  if (required(request.episodeId, 'request.episodeId') !== episodeId) {
    throw new TypeError('request.episodeId must match episodeId')
  }
  return Object.freeze({
    action: 'dialogue.speech.generate' as const,
    signature: required(input.signature, 'signature'),
    lineId: required(input.lineId, 'lineId'),
    projectId,
    episodeId,
    sourceRevisionId: input.sourceRevisionId === null
      ? null
      : required(input.sourceRevisionId, 'sourceRevisionId'),
    idempotencyKey: required(input.idempotencyKey, 'idempotencyKey'),
    input: request,
  })
}

export function confirmationMatchesDialoguePaidAttempt(
  attempt: FrozenDialoguePaidAttempt,
  confirmation: PublicPaidAigcConfirmation,
  nowEpochMs = Date.now(),
): boolean {
  return confirmation.action === attempt.action
    && confirmation.billableTaskCount === 1
    && !paidAigcConfirmationExpired(confirmation, nowEpochMs)
}

export interface ConfirmedDialogueSpeechGenerationRequest {
  lineId: string
  input: FrozenDialogueSpeechGenerationAttempt['input']
  idempotencyKey: string
  confirmationToken: string
}

export function confirmedDialogueSpeechGenerationRequest(
  attempt: FrozenDialogueSpeechGenerationAttempt,
  confirmation: PublicPaidAigcConfirmation,
  nowEpochMs = Date.now(),
): ConfirmedDialogueSpeechGenerationRequest | null {
  if (!confirmationMatchesDialoguePaidAttempt(attempt, confirmation, nowEpochMs)) return null
  return {
    lineId: attempt.lineId,
    input: attempt.input,
    idempotencyKey: attempt.idempotencyKey,
    confirmationToken: confirmation.confirmationToken,
  }
}
