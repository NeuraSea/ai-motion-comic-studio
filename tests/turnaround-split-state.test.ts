import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_TURNAROUND_OVERLAP_RATIO,
  MIN_TURNAROUND_CROP_EDGE,
  createGeometricTurnaroundSuggestion,
  createManualTurnaroundSplit,
  isCompleteValidTurnaroundCrops,
  turnaroundCropOverlapRatio,
  updateTurnaroundCrop,
  validateTurnaroundCrops,
} from '../src/features/assets/turnaround-split-state'
import type { TurnaroundCrops } from '../src/features/assets/turnaround-split-state'

const validCrops: TurnaroundCrops = {
  front: { x: 0, y: 0.1, width: 0.3, height: 0.8 },
  side: { x: 0.35, y: 0.1, width: 0.3, height: 0.8 },
  back: { x: 0.7, y: 0.1, width: 0.3, height: 0.8 },
}

test('equal thirds are returned as an explicit geometric suggestion, never an inferred orientation', () => {
  const first = createGeometricTurnaroundSuggestion()
  const second = createGeometricTurnaroundSuggestion()

  assert.equal(first.origin, 'geometric-suggestion')
  assert.deepEqual(first.crops, {
    front: { x: 0, y: 0, width: 1 / 3, height: 1 },
    side: { x: 1 / 3, y: 0, width: 1 / 3, height: 1 },
    back: { x: 2 / 3, y: 0, width: 1 / 3, height: 1 },
  })
  assert.equal(validateTurnaroundCrops(first.crops).valid, true)

  first.crops.front.x = 0.1
  assert.equal(second.crops.front.x, 0, 'each suggestion must own independent crop objects')
})

test('manual construction and updates clone inputs and remove the geometric-suggestion marker', () => {
  const manual = createManualTurnaroundSplit(validCrops)
  assert.equal(manual.origin, 'manual')
  assert.notEqual(manual.crops.front, validCrops.front)

  const geometric = createGeometricTurnaroundSuggestion()
  const updated = updateTurnaroundCrop(geometric, 'side', { x: 0.36, width: 0.28 })
  assert.equal(updated.origin, 'manual')
  assert.deepEqual(updated.crops.side, { x: 0.36, y: 0, width: 0.28, height: 1 })
  assert.deepEqual(geometric.crops.side, { x: 1 / 3, y: 0, width: 1 / 3, height: 1 })
})

test('validation requires all three finite crops', () => {
  const missing = validateTurnaroundCrops({ front: validCrops.front, side: validCrops.side })
  assert.equal(missing.valid, false)
  assert.deepEqual(missing.issues.map((issue) => issue.code), ['missing-crop'])
  assert.deepEqual(missing.issues[0]?.roles, ['back'])

  const nonFinite = validateTurnaroundCrops({
    ...validCrops,
    side: { ...validCrops.side, width: Number.NaN },
  })
  assert.equal(nonFinite.valid, false)
  assert.equal(nonFinite.issues[0]?.code, 'non-finite-value')
  assert.equal(nonFinite.issues[0]?.field, 'width')
  assert.equal(isCompleteValidTurnaroundCrops(validCrops), true)
})

test('validation rejects out-of-bounds and microscopic crops without silently clamping them', () => {
  const result = validateTurnaroundCrops({
    front: { ...validCrops.front, x: -0.01 },
    side: { ...validCrops.side, width: MIN_TURNAROUND_CROP_EDGE - 0.01 },
    back: { ...validCrops.back, x: 0.95, width: 0.1 },
  })

  assert.equal(result.valid, false)
  assert.ok(result.issues.some((issue) => issue.code === 'out-of-bounds' && issue.roles[0] === 'front'))
  assert.ok(result.issues.some((issue) => issue.code === 'crop-too-small' && issue.roles[0] === 'side'))
  assert.ok(result.issues.some((issue) => issue.code === 'out-of-bounds' && issue.roles[0] === 'back'))
})

test('overlap uses the smaller crop as denominator so containment cannot evade the limit', () => {
  assert.equal(turnaroundCropOverlapRatio(
    { x: 0, y: 0, width: 0.8, height: 1 },
    { x: 0.2, y: 0.2, width: 0.2, height: 0.4 },
  ), 1)

  const excessive = validateTurnaroundCrops({
    front: { x: 0, y: 0, width: 0.4, height: 1 },
    side: { x: 0.3, y: 0, width: 0.4, height: 1 },
    back: { x: 0.72, y: 0, width: 0.28, height: 1 },
  })
  assert.equal(excessive.valid, false)
  assert.ok(excessive.issues.some((issue) => issue.code === 'excessive-overlap'))

  const allowedOverlapWidth = 0.3 * MAX_TURNAROUND_OVERLAP_RATIO
  const atLimit = validateTurnaroundCrops({
    front: { x: 0, y: 0, width: 0.3, height: 1 },
    side: { x: 0.3 - allowedOverlapWidth, y: 0, width: 0.3, height: 1 },
    back: { x: 0.7, y: 0, width: 0.3, height: 1 },
  })
  assert.equal(atLimit.valid, true, 'the documented maximum itself is allowed')
})
