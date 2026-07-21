import assert from 'node:assert/strict'
import test from 'node:test'

import {
  audioPlaybackCoversDuration,
  createAudioPlaybackEvidence,
} from '../src/features/voices/voice-preview-playback'

function ranges(values: ReadonlyArray<readonly [number, number]>) {
  return {
    length: values.length,
    start: (index: number) => values[index]![0],
    end: (index: number) => values[index]![1],
  }
}

test('voice preview acceptance requires actual playback coverage from start to end', () => {
  assert.equal(audioPlaybackCoversDuration(ranges([[0, 7.344]]), 7.344), true)
  assert.equal(audioPlaybackCoversDuration(ranges([[0.04, 7.2]]), 7.344), true)
  assert.equal(audioPlaybackCoversDuration(ranges([[0, 2], [2.1, 7.344]]), 7.344), true)
  assert.deepEqual(createAudioPlaybackEvidence(ranges([[0, 2], [2.1, 7.344]]), 7.344), {
    version: 'html-media-played-v1',
    durationSeconds: 7.344,
    ranges: [{ startSeconds: 0, endSeconds: 7.344 }],
  })
})

test('voice preview acceptance rejects seek-to-tail, material gaps and invalid media evidence', () => {
  assert.equal(audioPlaybackCoversDuration(ranges([[7, 7.344]]), 7.344), false)
  assert.equal(audioPlaybackCoversDuration(ranges([[0, 2], [3, 7.344]]), 7.344), false)
  assert.equal(audioPlaybackCoversDuration(ranges([]), 7.344), false)
  assert.equal(audioPlaybackCoversDuration(ranges([[0, 7.344]]), Number.NaN), false)
})
