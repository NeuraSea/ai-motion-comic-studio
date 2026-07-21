import assert from 'node:assert/strict'
import test from 'node:test'

import type { PublicPaidAigcConfirmation } from '../src/lib'
import {
  confirmationMatchesVoicePaidAttempt,
  freezeCharacterVoicePreviewAttempt,
  freezeCharacterVoiceRecommendationAttempt,
  freezeProjectNarratorVoicePreviewAttempt,
} from '../src/features/voices/voice-paid-confirmation-state'

const FINGERPRINT = 'a'.repeat(64)
const EXPIRY_SECONDS = 4_102_444_800

function confirmation(
  action: PublicPaidAigcConfirmation['action'],
): PublicPaidAigcConfirmation {
  return {
    version: 1,
    action,
    label: '语音付费任务',
    billableTaskCount: 1,
    provider: { providerId: 'provider-1', model: 'model-1', configRevision: 3 },
    intentFingerprint: 'b'.repeat(64),
    expiresAt: '2100-01-01T00:00:00.000Z',
    confirmationToken: `aigcpf1_${EXPIRY_SECONDS}_${'c'.repeat(64)}`,
    priceEstimate: null,
    priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE',
  }
}

test('voice paid attempts freeze the exact body, ETag, target, and idempotency key', () => {
  const narratorInput = {
    projectId: 'project-1',
    providerId: 'minimax-speech' as const,
    voiceId: 'narrator-1',
    expectedCatalogFingerprint: FINGERPRINT,
  }
  const narrator = freezeProjectNarratorVoicePreviewAttempt({
    signature: 'narrator-signature',
    episodeId: 'episode-1',
    episodeEtag: 'W/"episode-v1"',
    idempotencyKey: 'narrator-key',
    request: narratorInput,
  })
  narratorInput.voiceId = 'mutated-after-freeze'

  assert.equal(narrator.input.voiceId, 'narrator-1')
  assert.equal(narrator.episodeEtag, 'W/"episode-v1"')
  assert.equal(narrator.idempotencyKey, 'narrator-key')
  assert.equal(Object.isFrozen(narrator), true)
  assert.equal(Object.isFrozen(narrator.input), true)

  const preview = freezeCharacterVoicePreviewAttempt({
    signature: 'preview-signature',
    episodeId: 'episode-1',
    episodeEtag: 'W/"episode-v1"',
    characterId: 'character-1',
    idempotencyKey: 'preview-key',
    request: {
      projectId: 'project-1',
      providerId: 'minimax-speech',
      voiceId: 'voice-1',
      expectedCatalogFingerprint: FINGERPRINT,
    },
  })
  assert.equal(preview.characterId, 'character-1')
  assert.equal(preview.input.voiceId, 'voice-1')

  const recommendation = freezeCharacterVoiceRecommendationAttempt({
    signature: 'recommend-signature',
    episodeId: 'episode-1',
    episodeEtag: 'W/"episode-v1"',
    characterId: 'character-1',
    idempotencyKey: 'recommend-key',
    request: {
      projectId: 'project-1',
      speechProviderId: 'minimax-speech',
      textProviderId: 'text-provider',
      expectedCatalogFingerprint: FINGERPRINT,
    },
  })
  assert.equal(recommendation.input.textProviderId, 'text-provider')
  assert.equal(recommendation.idempotencyKey, 'recommend-key')
})

test('voice confirmation matching rejects cross-action and expired capabilities', () => {
  const attempt = freezeCharacterVoicePreviewAttempt({
    signature: 'preview-signature',
    episodeId: 'episode-1',
    episodeEtag: 'W/"episode-v1"',
    characterId: 'character-1',
    idempotencyKey: 'preview-key',
    request: {
      projectId: 'project-1',
      providerId: 'minimax-speech',
      voiceId: 'voice-1',
      expectedCatalogFingerprint: FINGERPRINT,
    },
  })

  assert.equal(
    confirmationMatchesVoicePaidAttempt(
      attempt,
      confirmation('character.voice.preview'),
      Date.parse('2099-12-31T23:59:59.000Z'),
    ),
    true,
  )
  assert.equal(
    confirmationMatchesVoicePaidAttempt(
      attempt,
      confirmation('project.narrator.voice.preview'),
      Date.parse('2099-12-31T23:59:59.000Z'),
    ),
    false,
  )
  assert.equal(
    confirmationMatchesVoicePaidAttempt(
      attempt,
      confirmation('character.voice.preview'),
      Date.parse('2100-01-01T00:00:00.000Z'),
    ),
    false,
  )
})
