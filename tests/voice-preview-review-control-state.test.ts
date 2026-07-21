import assert from 'node:assert/strict'
import test from 'node:test'

import { voicePreviewReviewInvalidationMessage } from '../src/features/voices/VoicePreviewReviewControl.js'

test('legacy ended-only reviews explicitly require a new complete playback', () => {
  assert.equal(voicePreviewReviewInvalidationMessage({
    isCurrent: false,
    invalidReasons: ['PLAYBACK_EVIDENCE_LEGACY'],
  }), '旧播放证据，需重新完整试听')
})

test('binding drift remains distinct from a legacy playback-evidence migration', () => {
  assert.equal(voicePreviewReviewInvalidationMessage({
    isCurrent: false,
    invalidReasons: ['STORY_REVISION_CHANGED'],
  }), '绑定条件已变化，需重新试听当前版本')
  assert.equal(voicePreviewReviewInvalidationMessage({
    isCurrent: true,
    invalidReasons: [],
  }), null)
})
