import assert from 'node:assert/strict'
import test from 'node:test'

import type { MediaAssetRecord } from './database.js'
import {
  parseCanonicalSpeechSubtitleCues,
  parseSpeechSubtitleCueOverride,
  publicSpeechSubtitle,
  SpeechSubtitleError,
} from './speech-subtitle.js'

function speechAsset(parameters: MediaAssetRecord['generationParameters']): MediaAssetRecord {
  return {
    id: 'speech-asset-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'speech',
    version: 1,
    status: 'ready',
    filePath: 'project/speech.mp3',
    mimeType: 'audio/mpeg',
    width: null,
    height: null,
    durationSeconds: 1.5,
    checksum: 'a'.repeat(64),
    source: 'provider',
    providerId: 'minimax',
    generationJobId: 'job-1',
    generationParameters: parameters,
    sourceRevisionId: 'revision-1',
    parentAssetId: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  }
}

test('canonical speech cues are exact, bounded, ordered, and non-overlapping', () => {
  assert.deepEqual(parseCanonicalSpeechSubtitleCues([
    { text: '长安', startMs: 0, endMs: 500 },
    { text: '醒了', startMs: 500, endMs: 1_200 },
  ], { durationMs: 1_500 }), [
    { text: '长安', startMs: 0, endMs: 500 },
    { text: '醒了', startMs: 500, endMs: 1_200 },
  ])
  for (const invalid of [
    [{ text: '重叠', startMs: 0, endMs: 600 }, { text: '字幕', startMs: 500, endMs: 900 }],
    [{ text: '', startMs: 0, endMs: 100 }],
    [{ text: '越界', startMs: 0, endMs: 1_501 }],
    [{ text: '多字段', startMs: 0, endMs: 100, url: 'https://secret.invalid' }],
  ]) {
    assert.throws(
      () => parseCanonicalSpeechSubtitleCues(invalid, { durationMs: 1_500 }),
      (error: unknown) => error instanceof SpeechSubtitleError
        && error.code === 'INVALID_SUBTITLE_CUES',
    )
  }
})

test('public speech subtitle exposes only a sanitized bound cue document', () => {
  const asset = speechAsset({
    lineId: 'line-1',
    voiceId: 'private-voice',
    usageCharacters: 99,
    subtitle: {
      mode: 'word',
      granularity: 'word',
      cues: [
        { text: '它', startMs: 0, endMs: 300 },
        { text: '醒了', startMs: 300, endMs: 1_200 },
      ],
    },
  })
  const projected = publicSpeechSubtitle(asset)
  assert.deepEqual(projected, {
    version: 1,
    lineId: 'line-1',
    mode: 'word',
    granularity: 'word',
    cues: [
      { text: '它', startMs: 0, endMs: 300 },
      { text: '醒了', startMs: 300, endMs: 1_200 },
    ],
  })
  assert.equal(JSON.stringify(projected).includes('private-voice'), false)
  assert.equal(JSON.stringify(projected).includes('usageCharacters'), false)

  assert.deepEqual(publicSpeechSubtitle(speechAsset({
    lineId: 'line-1',
    subtitle: { mode: 'word', cues: [
      { text: '一', startMs: 0, endMs: 800 },
      { text: '二', startMs: 700, endMs: 1_000 },
    ] },
  })), {
    version: 1,
    lineId: 'line-1',
    mode: 'sentence-fallback',
    reason: 'timestamps-invalid',
  })
})

test('manual cue overrides are immutable-asset bound and reject stale audio', () => {
  const value = {
    version: 1,
    sourceAssetId: 'speech-asset-1',
    dialogueLineId: 'line-1',
    cues: [{ text: '人工', startMs: 100, endMs: 700 }],
  }
  assert.deepEqual(parseSpeechSubtitleCueOverride(value, {
    sourceAssetId: 'speech-asset-1',
    dialogueLineId: 'line-1',
    durationMs: 1_500,
  }), value)
  assert.throws(() => parseSpeechSubtitleCueOverride(value, {
    sourceAssetId: 'speech-asset-2',
    dialogueLineId: 'line-1',
    durationMs: 1_500,
  }), (error: unknown) => error instanceof SpeechSubtitleError
    && error.code === 'SUBTITLE_OVERRIDE_BINDING_CONFLICT')
})
