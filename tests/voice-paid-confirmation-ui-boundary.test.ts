import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const narratorPath = new URL('../src/features/voices/ProjectNarratorVoiceCard.tsx', import.meta.url)
const characterPath = new URL('../src/features/voices/CharacterVoiceCastingCard.tsx', import.meta.url)
const statePath = new URL('../src/features/voices/voice-paid-confirmation-state.ts', import.meta.url)
const reviewPath = new URL('../src/features/voices/VoicePreviewReviewControl.tsx', import.meta.url)
const checklistPath = new URL('../src/features/voices/VoiceAcceptanceChecklist.tsx', import.meta.url)

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing section ${start}`)
  return source.slice(startIndex, endIndex)
}

test('voice previews remain paid while LLM casting submits directly with durable idempotency', async () => {
  const [narrator, character, state, review, checklist] = await Promise.all([
    readFile(narratorPath, 'utf8'),
    readFile(characterPath, 'utf8'),
    readFile(statePath, 'utf8'),
    readFile(reviewPath, 'utf8'),
    readFile(checklistPath, 'utf8'),
  ])

  const narratorStart = section(narrator, 'const startPreview = async', 'const cancelConfirmation')
  assert.match(narratorStart, /preflightAttempt\(currentAttempt\)/)
  assert.doesNotMatch(narratorStart, /createProjectNarratorVoicePreview/)
  assert.match(narrator, /PaidAigcConfirmationDialog/)
  assert.match(narrator, /createProjectNarratorVoicePreview/)

  const previewStart = section(character, 'const startPreview = async', 'const cancelConfirmation')
  assert.match(previewStart, /preflightAttempt\(currentAttempt\)/)
  assert.doesNotMatch(previewStart, /createCharacterVoicePreview/)

  const recommendationStart = section(
    character,
    'const startRecommendation = async',
    'const catalogCurrent',
  )
  assert.match(recommendationStart, /freezeCharacterVoiceRecommendationAttempt/)
  assert.match(recommendationStart, /createCharacterVoiceRecommendation/)
  assert.match(recommendationStart, /currentAttempt\.idempotencyKey/)
  assert.doesNotMatch(recommendationStart, /preflightRecommendationAttempt|confirmationToken/)

  // Character and narrator TTS previews remain billable. AI casting is an
  // explicitly clicked but policy-free LLM Job, so it must not open a second
  // paid-confirmation dialog.
  assert.equal(character.match(/<PaidAigcConfirmationDialog/g)?.length, 1)
  assert.equal(narrator.match(/<PaidAigcConfirmationDialog/g)?.length, 1)
  assert.match(character, /parsePaidAigcConfirmationRequiredError/)
  assert.match(narrator, /parsePaidAigcConfirmationRequiredError/)
  assert.match(`${narrator}\n${character}`, /\u540c\u4e00 Idempotency-Key|\u540c一 Idempotency-Key/)
  assert.match(state, /structuredClone/)
  assert.match(state, /Object\.freeze/)
  assert.match(state, /paidAigcConfirmationExpired/)
  assert.doesNotMatch(`${narrator}\n${character}`, /window\.confirm/)

  // Human audition acceptance is a separate zero-Provider boundary. The
  // buttons stay gated by the media element's ended event and never call the
  // profile mutation or either paid preview endpoint.
  assert.match(character, /createAudioPlaybackEvidence\(/)
  assert.match(narrator, /createAudioPlaybackEvidence\(/)
  assert.match(checklist, /VoicePreviewReviewControl/)
  assert.match(checklist, /createAudioPlaybackEvidence\(/)
  assert.doesNotMatch(checklist, /createCharacterVoicePreview|createProjectNarratorVoicePreview/)
  assert.match(review, /!playbackEvidence/)
  assert.match(review, /createVoicePreviewReview/)
  assert.match(review, /playbackCompleted: true/)
  assert.match(review, /PLAYBACK_EVIDENCE_LEGACY/)
  assert.match(review, /旧播放证据，需重新完整试听/)
  assert.doesNotMatch(review, /putCharacterVoiceProfile|putProjectNarratorVoiceProfile/)
  assert.doesNotMatch(review, /createCharacterVoicePreview|createProjectNarratorVoicePreview/)
})
