import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  estimatePaidUnits,
  validateDigitalHumanInput,
} from './digital-human-pipeline.js'
import { JobExecutionError } from './worker.js'

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    photoAssetId: 'photo-1',
    lines: [{ index: 1, text: '大家好' }, { index: 2, text: '脱口秀' }],
    speech: { mode: 'tts', voiceId: 'voice-1', provider: 'doubao' },
    video: { aspectRatio: '16:9', resolution: '1080p', model: 'doubao-seedance-2.0' },
    ...overrides,
  }
}

test('validateDigitalHumanInput accepts a valid TTS input', () => {
  const input = validateDigitalHumanInput(baseInput())
  assert.equal(input.photoAssetId, 'photo-1')
  assert.equal(input.lines.length, 2)
  assert.equal(input.speech.mode, 'tts')
  assert.equal(input.video.resolution, '1080p')
})

test('validateDigitalHumanInput rejects empty lines', () => {
  assert.throws(
    () => validateDigitalHumanInput(baseInput({ lines: [] })),
    (error) => error instanceof JobExecutionError && error.code === 'INVALID_INPUT',
  )
})

test('validateDigitalHumanInput rejects too many lines', () => {
  const lines = Array.from({ length: 25 }, (_, i) => ({ index: i + 1, text: `第${i + 1}句` }))
  assert.throws(
    () => validateDigitalHumanInput(baseInput({ lines })),
    (error) => error instanceof JobExecutionError && error.code === 'INVALID_INPUT',
  )
})

test('validateDigitalHumanInput rejects invalid aspect ratio', () => {
  assert.throws(
    () => validateDigitalHumanInput(baseInput({ video: { aspectRatio: '4:3', resolution: '1080p' } })),
    (error) => error instanceof JobExecutionError && error.code === 'INVALID_INPUT',
  )
})

test('validateDigitalHumanInput rejects upload mode with mismatched audio count', () => {
  assert.throws(
    () => validateDigitalHumanInput(baseInput({ speech: { mode: 'upload', audioAssetIds: ['only-one'] } })),
    (error) => error instanceof JobExecutionError && error.code === 'INVALID_INPUT',
  )
})

test('validateDigitalHumanInput accepts upload mode with matching audio count', () => {
  const input = validateDigitalHumanInput(
    baseInput({ speech: { mode: 'upload', audioAssetIds: ['a1', 'a2'] } }),
  )
  assert.equal(input.speech.mode, 'upload')
  if (input.speech.mode === 'upload') assert.deepEqual(input.speech.audioAssetIds, ['a1', 'a2'])
})

test('validateDigitalHumanInput rejects invalid tts provider', () => {
  assert.throws(
    () => validateDigitalHumanInput(baseInput({ speech: { mode: 'tts', voiceId: 'v', provider: 'azure' } })),
    (error) => error instanceof JobExecutionError && error.code === 'INVALID_INPUT',
  )
})

test('estimatePaidUnits counts references + tts + videos', () => {
  const input = validateDigitalHumanInput(baseInput())
  // 4 参考图 + 2 句 TTS + 2 段视频
  assert.equal(estimatePaidUnits(input), 8)
})

test('estimatePaidUnits excludes speech billing for upload mode', () => {
  const input = validateDigitalHumanInput(
    baseInput({ speech: { mode: 'upload', audioAssetIds: ['a1', 'a2'] } }),
  )
  // 4 参考图 + 0 语音 + 2 段视频
  assert.equal(estimatePaidUnits(input), 6)
})

test('validateDigitalHumanInput validates paidConfirmation shape when present', () => {
  assert.throws(
    () => validateDigitalHumanInput(baseInput({ paidConfirmation: { units: -1, acknowledgement: '确认付费' } })),
    (error) => error instanceof JobExecutionError && error.code === 'INVALID_INPUT',
  )
  assert.throws(
    () => validateDigitalHumanInput(baseInput({ paidConfirmation: { units: 8, acknowledgement: '' } })),
    (error) => error instanceof JobExecutionError && error.code === 'INVALID_INPUT',
  )
  const ok = validateDigitalHumanInput(baseInput({ paidConfirmation: { units: 8, acknowledgement: '确认付费' } }))
  assert.equal(ok.paidConfirmation?.units, 8)
})
