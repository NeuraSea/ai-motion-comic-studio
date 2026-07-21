import assert from 'node:assert/strict'
import test from 'node:test'

import {
  missingManualSlotAssetIds,
  parseShotVideoManualReferenceRecoveries,
  parseShotVideoManualReferenceRecovery,
  selectorsForManualSlotChoices,
} from '../src/features/video/shot-video-manual-reference.js'

const sourceRevisionId = 'story-r1'
const details = {
  recommendation: { status: 'manual_required' },
  manualSelection: {
    version: 1,
    shotId: 'sh0',
    sceneId: 'scene-1',
    sourceRevisionId,
    characters: [{
      characterId: 'hero',
      characterName: '阿岚',
      rationale: '视角证据不足，不会猜测。',
      slots: ['front', 'side', 'back'].map((view, index) => ({
        characterId: 'hero',
        characterName: '阿岚',
        view,
        assetId: `private-slot-asset-${view}`,
        assetVersion: index + 1,
        assetChecksum: String(index + 1).repeat(64),
        assetSourceRevisionId: sourceRevisionId,
        slotVersion: 2,
        slotAuditRevisionId: 'slot-audit-r2',
      })),
    }],
  },
}

test('VIDEO_REFERENCE_SELECTION_REQUIRED evidence becomes thumbnail-safe role choices', () => {
  const recovery = parseShotVideoManualReferenceRecovery(details)
  assert.ok(recovery)
  assert.deepEqual(recovery.characters[0].slots.map((slot) => slot.view), ['front', 'side', 'back'])
})

test('manual role choice sends characterId+view and never an Asset ID', () => {
  const recovery = parseShotVideoManualReferenceRecovery(details)
  assert.ok(recovery)
  const selectors = selectorsForManualSlotChoices(recovery, { hero: 'side' })
  assert.deepEqual(selectors, [{ characterId: 'hero', view: 'side' }])
  assert.equal(JSON.stringify(selectors).includes('private-slot-asset'), false)
  assert.equal(selectorsForManualSlotChoices(recovery, {}), null)
})

test('stale or malformed slot evidence is not rendered as a selectable role', () => {
  const stale = structuredClone(details)
  stale.manualSelection.characters[0].slots[0].assetSourceRevisionId = 'old-story'
  assert.equal(parseShotVideoManualReferenceRecovery(stale), null)
})

test('aggregate 409 exposes all unresolved shots in one parse', () => {
  const second = structuredClone(details)
  second.manualSelection.shotId = 'sh1'
  const recoveries = parseShotVideoManualReferenceRecoveries({
    version: 1,
    unresolvedShots: [
      {
        ...details,
        reasonCode: 'VIEW_SELECTION_REQUIRED',
        maximumReferenceImages: 9,
        slotSelectionAllowed: true,
      },
      {
        ...second,
        reasonCode: 'SLOT_SELECTION_STALE',
        maximumReferenceImages: 9,
        slotSelectionAllowed: true,
      },
    ],
  })
  assert.deepEqual(recoveries.map((recovery) => recovery.shotId), ['sh0', 'sh1'])
  assert.deepEqual(recoveries.map((recovery) => recovery.reasonCode), [
    'VIEW_SELECTION_REQUIRED',
    'SLOT_SELECTION_STALE',
  ])
})

test('more than nine related characters is explicitly text-only-or-split, never an impossible slot request', () => {
  const tooMany = structuredClone(details)
  tooMany.reasonCode = 'RELATED_CHARACTER_LIMIT_EXCEEDED'
  tooMany.maximumReferenceImages = 9
  tooMany.slotSelectionAllowed = false
  tooMany.manualSelection.selectionPolicy = {
    maximumReferences: 9,
    slotSelectionAllowed: false,
    reason: 'related_character_limit_exceeded',
  }
  tooMany.manualSelection.characters = Array.from({ length: 10 }, (_, index) => ({
    characterId: `character-${index}`,
    characterName: `角色${index}`,
    rationale: '群像超过上限。',
    slots: [],
  }))
  const recovery = parseShotVideoManualReferenceRecovery(tooMany)
  assert.ok(recovery)
  assert.equal(recovery.characters.length, 10)
  assert.equal(recovery.slotSelectionAllowed, false)
  assert.equal(selectorsForManualSlotChoices(recovery, {}), null)
})

test('locked slot evidence missing from the local Asset library remains an explicit refresh state', () => {
  const recovery = parseShotVideoManualReferenceRecovery(details)
  assert.ok(recovery)
  assert.deepEqual(missingManualSlotAssetIds(recovery, new Set([
    'private-slot-asset-front',
    'private-slot-asset-back',
  ])), ['private-slot-asset-side'])
  assert.deepEqual(missingManualSlotAssetIds(recovery, new Set(
    recovery.characters[0].slots.map((slot) => slot.assetId),
  )), [])
})
