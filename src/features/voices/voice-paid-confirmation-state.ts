import type { PublicPaidAigcConfirmation } from '../../lib'
import { paidAigcConfirmationExpired } from '../paid-aigc/paid-aigc-confirmation-state'

export interface ProjectNarratorVoicePreviewRequest {
  projectId: string
  providerId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
  voiceId: string
  expectedCatalogFingerprint: string
}

export interface CharacterVoicePreviewRequest {
  projectId: string
  providerId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
  voiceId: string
  expectedCatalogFingerprint: string
}

export interface CharacterVoiceRecommendationRequest {
  projectId: string
  speechProviderId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
  textProviderId?: string
  expectedCatalogFingerprint: string
}

interface FrozenEpisodeVoiceAttempt<TAction extends string, TRequest> {
  readonly action: TAction
  readonly signature: string
  readonly episodeId: string
  readonly episodeEtag: string
  readonly idempotencyKey: string
  readonly input: Readonly<TRequest>
}

export interface FrozenProjectNarratorVoicePreviewAttempt
  extends FrozenEpisodeVoiceAttempt<
    'project.narrator.voice.preview',
    ProjectNarratorVoicePreviewRequest
  > {}

export interface FrozenCharacterVoicePreviewAttempt
  extends FrozenEpisodeVoiceAttempt<
    'character.voice.preview',
    CharacterVoicePreviewRequest
  > {
  readonly characterId: string
}

export interface FrozenCharacterVoiceRecommendationAttempt
  extends FrozenEpisodeVoiceAttempt<
    'character.voice.recommendation',
    CharacterVoiceRecommendationRequest
  > {
  readonly characterId: string
}

export type FrozenVoicePaidAttempt =
  | FrozenProjectNarratorVoicePreviewAttempt
  | FrozenCharacterVoicePreviewAttempt

type FrozenVoiceAttemptAction =
  | FrozenVoicePaidAttempt['action']
  | FrozenCharacterVoiceRecommendationAttempt['action']

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

function freezeEpisodeAttempt<TAction extends FrozenVoiceAttemptAction, TRequest>(input: {
  action: TAction
  signature: string
  episodeId: string
  episodeEtag: string
  idempotencyKey: string
  request: TRequest
}): FrozenEpisodeVoiceAttempt<TAction, TRequest> {
  return Object.freeze({
    action: input.action,
    signature: required(input.signature, 'signature'),
    episodeId: required(input.episodeId, 'episodeId'),
    episodeEtag: required(input.episodeEtag, 'episodeEtag'),
    idempotencyKey: required(input.idempotencyKey, 'idempotencyKey'),
    input: frozenClone(input.request),
  })
}

function validateVoiceRequest(input: Readonly<{
  projectId: string
  providerId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
  voiceId: string
  expectedCatalogFingerprint: string
}>): void {
  required(input.projectId, 'request.projectId')
  required(input.providerId, 'request.providerId')
  required(input.voiceId, 'request.voiceId')
  required(input.expectedCatalogFingerprint, 'request.expectedCatalogFingerprint')
}

export function freezeProjectNarratorVoicePreviewAttempt(input: {
  signature: string
  episodeId: string
  episodeEtag: string
  idempotencyKey: string
  request: ProjectNarratorVoicePreviewRequest
}): FrozenProjectNarratorVoicePreviewAttempt {
  const attempt = freezeEpisodeAttempt({
    ...input,
    action: 'project.narrator.voice.preview' as const,
  })
  validateVoiceRequest(attempt.input)
  return attempt
}

export function freezeCharacterVoicePreviewAttempt(input: {
  signature: string
  episodeId: string
  episodeEtag: string
  characterId: string
  idempotencyKey: string
  request: CharacterVoicePreviewRequest
}): FrozenCharacterVoicePreviewAttempt {
  const attempt = freezeEpisodeAttempt({
    ...input,
    action: 'character.voice.preview' as const,
  })
  validateVoiceRequest(attempt.input)
  return Object.freeze({
    ...attempt,
    characterId: required(input.characterId, 'characterId'),
  })
}

export function freezeCharacterVoiceRecommendationAttempt(input: {
  signature: string
  episodeId: string
  episodeEtag: string
  characterId: string
  idempotencyKey: string
  request: CharacterVoiceRecommendationRequest
}): FrozenCharacterVoiceRecommendationAttempt {
  const attempt = freezeEpisodeAttempt({
    ...input,
    action: 'character.voice.recommendation' as const,
  })
  required(attempt.input.projectId, 'request.projectId')
  required(attempt.input.speechProviderId, 'request.speechProviderId')
  required(attempt.input.expectedCatalogFingerprint, 'request.expectedCatalogFingerprint')
  if (attempt.input.textProviderId !== undefined) {
    required(attempt.input.textProviderId, 'request.textProviderId')
  }
  return Object.freeze({
    ...attempt,
    characterId: required(input.characterId, 'characterId'),
  })
}

export function confirmationMatchesVoicePaidAttempt(
  attempt: FrozenVoicePaidAttempt,
  confirmation: PublicPaidAigcConfirmation,
  nowEpochMs = Date.now(),
): boolean {
  return confirmation.action === attempt.action
    && confirmation.billableTaskCount === 1
    && !paidAigcConfirmationExpired(confirmation, nowEpochMs)
}
