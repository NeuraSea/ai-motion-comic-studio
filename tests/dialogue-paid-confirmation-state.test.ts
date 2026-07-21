import assert from 'node:assert/strict'
import test from 'node:test'

import type { PublicPaidAigcConfirmation } from '../src/lib/api-types'
import {
  confirmedDialogueSpeechGenerationRequest,
  freezeDialoguePerformanceRecommendationAttempt,
  freezeDialogueSpeechGenerationAttempt,
} from '../src/features/voices/dialogue-paid-confirmation-state'

const EXPIRES_AT = '2100-01-01T00:00:00.000Z'

function confirmation(
  action: PublicPaidAigcConfirmation['action'],
  overrides: Partial<PublicPaidAigcConfirmation> = {},
): PublicPaidAigcConfirmation {
  return {
    version: 1,
    action,
    label: '生成 1 个任务',
    billableTaskCount: 1,
    provider: {
      providerId: action === 'dialogue.speech.generate' ? 'minimax-speech' : 'other-provider',
      model: action === 'dialogue.speech.generate' ? 'speech-2.8-hd' : 'other-model',
      configRevision: 4,
    },
    intentFingerprint: 'a'.repeat(64),
    expiresAt: EXPIRES_AT,
    confirmationToken: `aigcpf1_4102444800_${'b'.repeat(64)}`,
    priceEstimate: null,
    priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE',
    ...overrides,
  }
}

test('performance recommendation freezes the exact direct-submission request', () => {
  const request = {
    projectId: 'project-1',
    episodeId: 'episode-1',
    textProviderId: 'openai-text',
  }
  const attempt = freezeDialoguePerformanceRecommendationAttempt({
    signature: 'performance-signature-1',
    lineId: 'line-1',
    idempotencyKey: 'performance-key-1',
    request,
  })
  request.projectId = 'other-project'
  request.textProviderId = 'other-provider'

  assert.ok(Object.isFrozen(attempt))
  assert.ok(Object.isFrozen(attempt.input))
  assert.equal(attempt.lineId, 'line-1')
  assert.equal(attempt.idempotencyKey, 'performance-key-1')
  assert.deepEqual(attempt.input, {
    projectId: 'project-1',
    episodeId: 'episode-1',
    textProviderId: 'openai-text',
  })
})

test('speech confirmation freezes inherited voice controls and exact story scope', () => {
  const request = {
    projectId: 'project-1',
    episodeId: 'episode-1',
    speed: 0.9,
    pitch: -1,
    emotion: 'fearful' as const,
    format: 'mp3' as const,
  }
  const attempt = freezeDialogueSpeechGenerationAttempt({
    signature: 'speech-signature-1',
    lineId: 'line-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: 'story-revision-1',
    idempotencyKey: 'speech-key-1',
    request,
  })
  request.speed = 1.2
  request.pitch = 4

  assert.equal(attempt.projectId, 'project-1')
  assert.equal(attempt.episodeId, 'episode-1')
  assert.equal(attempt.sourceRevisionId, 'story-revision-1')
  assert.equal(attempt.input.speed, 0.9)
  assert.equal(attempt.input.pitch, -1)
  assert.ok(Object.isFrozen(attempt.input))
  assert.deepEqual(confirmedDialogueSpeechGenerationRequest(
    attempt,
    confirmation('dialogue.speech.generate'),
    Date.parse(EXPIRES_AT) - 1,
  ), {
    lineId: 'line-1',
    input: {
      projectId: 'project-1',
      episodeId: 'episode-1',
      speed: 0.9,
      pitch: -1,
      emotion: 'fearful',
      format: 'mp3',
    },
    idempotencyKey: 'speech-key-1',
    confirmationToken: `aigcpf1_4102444800_${'b'.repeat(64)}`,
  })
})

test('wrong-action and expired confirmations never become paid dialogue requests', () => {
  const attempt = freezeDialogueSpeechGenerationAttempt({
    signature: 'speech-signature-1',
    lineId: 'line-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: 'story-revision-1',
    idempotencyKey: 'speech-key-1',
    request: { projectId: 'project-1', episodeId: 'episode-1' },
  })
  assert.equal(
    confirmedDialogueSpeechGenerationRequest(
      attempt,
      confirmation('character.voice.preview'),
      Date.parse(EXPIRES_AT) - 1,
    ),
    null,
  )
  assert.equal(
    confirmedDialogueSpeechGenerationRequest(
      attempt,
      confirmation('dialogue.speech.generate'),
      Date.parse(EXPIRES_AT),
    ),
    null,
  )
})
