import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  providerSubtitleCueDrafts,
  subtitleCueDraftsFromCues,
  validateSubtitleCueDrafts,
} from '../src/features/editor/subtitle-cue-state'

test('provider word cues become editable seconds while fallback stays explicit and empty', () => {
  assert.deepEqual(providerSubtitleCueDrafts({
    version: 1,
    lineId: 'line-1',
    mode: 'word',
    granularity: 'word',
    cues: [{ text: '醒来', startMs: 250, endMs: 1_500 }],
  }), [{
    key: 'cue-1', text: '醒来', startSeconds: '0.25', endSeconds: '1.5',
  }])
  assert.deepEqual(providerSubtitleCueDrafts({
    version: 1,
    lineId: 'line-1',
    mode: 'sentence-fallback',
    reason: 'timestamps-unavailable',
  }), [])
})

test('cue validation normalizes text and accepts ordered non-overlapping millisecond times', () => {
  const result = validateSubtitleCueDrafts(subtitleCueDraftsFromCues([
    { text: '  它  ', startMs: 0, endMs: 300 },
    { text: '醒了', startMs: 300, endMs: 900 },
  ]), 1.25)
  assert.deepEqual(result, {
    cues: [
      { text: '它', startMs: 0, endMs: 300 },
      { text: '醒了', startMs: 300, endMs: 900 },
    ],
    errors: [],
    rowErrors: {},
  })
})

test('cue validation rejects invalid precision, overlap, empty text, and out-of-range ends', () => {
  const result = validateSubtitleCueDrafts([{
    key: 'a', text: '第一句', startSeconds: '0', endSeconds: '0.5',
  }, {
    key: 'b', text: '', startSeconds: '0.4999', endSeconds: '1.6',
  }], 1.5)
  assert.equal(result.cues, null)
  assert.match(result.errors.join('\n'), /修正/)
  assert.match(result.rowErrors.b.join('\n'), /文本不能为空/)
  assert.match(result.rowErrors.b.join('\n'), /最多 3 位小数/)
})
