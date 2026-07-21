import assert from 'node:assert/strict'
import test from 'node:test'

import { DOUBAO_SPEECH_2_VOICES } from './doubao-voice-catalog-data.js'

test('official Doubao Speech 2.0 catalog snapshot contains unique bounded voice IDs', () => {
  assert.ok(DOUBAO_SPEECH_2_VOICES.length > 400)
  assert.equal(new Set(DOUBAO_SPEECH_2_VOICES.map((voice) => voice.voiceId)).size, DOUBAO_SPEECH_2_VOICES.length)
  assert.ok(DOUBAO_SPEECH_2_VOICES.some((voice) => voice.voiceId === 'zh_female_vv_uranus_bigtts'))
  for (const voice of DOUBAO_SPEECH_2_VOICES) {
    assert.match(voice.voiceId, /^[A-Za-z0-9_-]{3,256}$/)
    assert.ok(voice.name.length > 0)
    assert.equal(voice.type, 'system')
  }
})
