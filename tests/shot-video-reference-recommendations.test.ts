import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSmartShotVideoReferenceDraft,
  recommendShotVideoReferenceAssetIds,
  shotVideoReferenceRecommendationDetails,
} from '../src/features/video/shot-video-reference-recommendations'
import type { StoryDocument, VisualAssetTarget } from '../src/lib'

const story: StoryDocument = {
  version: 1,
  title: '秦岭龙吟',
  targetDurationSeconds: 45,
  bible: { logline: '龙吟再起', theme: '选择', tone: '悬疑', visualStyle: '国风动画' },
  characters: [
    { id: 'ali', name: '阿离', role: '主角', storyDescription: '守候者', visualDescription: '红绳剑客' },
    { id: 'wen', name: '闻人', role: '配角', storyDescription: '来客', visualDescription: '黑衣' },
  ],
  locations: [{ id: 'cliff', name: '秦岭断崖', storyDescription: '断崖', visualDescription: '云海' }],
  props: [{ id: 'token', name: '青铜令', description: '唤醒龙脉', visualDescription: '暗红纹路' }],
  scenes: [{
    id: 'scene-1',
    sequence: 0,
    title: '龙吟',
    locationId: 'cliff',
    timeOfDay: '黄昏',
    description: '暮色压山',
    shots: [{
      id: 'shot-1',
      sequence: 0,
      code: 'S0-1',
      title: '来客',
      description: '闻人回头',
      framing: '中景',
      movement: '固定',
      transition: '硬切',
      durationSeconds: 5,
      visualPrompt: '闻人回头',
      dialogueLines: [{ id: 'line-1', sequence: 0, kind: 'dialogue', speaker: '闻人', text: '谁？' }],
    }, {
      id: 'shot-2',
      sequence: 1,
      code: 'S0-2',
      title: '青铜令细节',
      description: '阿离手中的青铜令亮起暗红纹路',
      framing: '特写',
      movement: '缓慢推近',
      transition: '硬切',
      durationSeconds: 5,
      visualPrompt: '阿离守在崖边',
      dialogueLines: [{ id: 'line-2', sequence: 0, kind: 'narration', speaker: '旁白', text: '十年。' }],
    }],
  }],
}

const targets: VisualAssetTarget[] = [
  { type: 'character', id: 'ali', name: '阿离', description: '', visualDescription: '', role: '主角', version: 2, lockedAssetId: 'asset-ali' },
  { type: 'character', id: 'wen', name: '闻人', description: '', visualDescription: '', role: '配角', version: 1, lockedAssetId: 'asset-wen' },
  { type: 'location', id: 'cliff', name: '秦岭断崖', description: '', visualDescription: '', role: null, version: 3, lockedAssetId: 'asset-cliff' },
  { type: 'prop', id: 'token', name: '青铜令', description: '', visualDescription: '', role: null, version: 1, lockedAssetId: 'asset-token' },
]

test('ordinary shots use no auxiliary locks while explicit detail shots keep locked subject, prop, and scene metadata', () => {
  const recommendations = recommendShotVideoReferenceAssetIds(story, targets)
  assert.deepEqual(recommendations, {
    'shot-1': [],
    'shot-2': ['asset-ali', 'asset-token', 'asset-cliff'],
  })
  assert.deepEqual(shotVideoReferenceRecommendationDetails(recommendations['shot-2']), [{
    assetId: 'asset-ali',
    entityType: 'character',
    entityId: 'ali',
    entityName: '阿离',
    sourceLabel: '已锁定角色设定',
    purposeLabel: '角色外观一致性',
  }, {
    assetId: 'asset-token',
    entityType: 'prop',
    entityId: 'token',
    entityName: '青铜令',
    sourceLabel: '已锁定道具设定',
    purposeLabel: '道具造型与细节',
  }, {
    assetId: 'asset-cliff',
    entityType: 'location',
    entityId: 'cliff',
    entityName: '秦岭断崖',
    sourceLabel: '已锁定场景设定',
    purposeLabel: '场景空间与风格一致性',
  }])
})

test('recommendations never select unlocked candidates or unrelated entities', () => {
  const recommendations = recommendShotVideoReferenceAssetIds(story, targets.map((target) => (
    target.id === 'token' ? { ...target, lockedAssetId: null } : target
  )))
  assert.deepEqual(recommendations['shot-1'], [])
  assert.deepEqual(recommendations['shot-2'], ['asset-ali', 'asset-cliff'])
  assert.equal(recommendations['shot-1'].includes('asset-token'), false)
})

test('smart policy defaults to current storyboard and uses multi-reference only for detail locks', () => {
  const eligible = new Set(['storyboard-current', 'asset-ali', 'asset-token', 'asset-cliff'])
  assert.deepEqual(buildSmartShotVideoReferenceDraft({
    currentStoryboardAssetId: 'storyboard-current',
    recommendedAssetIds: [],
    eligibleAssetIds: eligible,
  }), {
    mode: 'first-frame',
    firstFrameAssetId: 'storyboard-current',
    lastFrameAssetId: '',
    referenceAssetIds: [],
    strategy: 'current-storyboard',
  })
  assert.deepEqual(buildSmartShotVideoReferenceDraft({
    currentStoryboardAssetId: 'storyboard-current',
    recommendedAssetIds: ['asset-ali', 'asset-token', 'asset-cliff'],
    eligibleAssetIds: eligible,
  }), {
    mode: 'multi-reference',
    firstFrameAssetId: 'storyboard-current',
    lastFrameAssetId: '',
    referenceAssetIds: ['storyboard-current', 'asset-ali', 'asset-token', 'asset-cliff'],
    strategy: 'detail-multi-reference',
  })
})

test('first-last requires an explicit same-shot transition and a dedicated tail keyframe', () => {
  const eligible = new Set(['storyboard-current', 'dedicated-tail', 'next-shot-storyboard'])
  const withoutTransition = buildSmartShotVideoReferenceDraft({
    currentStoryboardAssetId: 'storyboard-current',
    recommendedAssetIds: [],
    eligibleAssetIds: eligible,
    sameShotStateChange: false,
    dedicatedLastFrameAssetId: 'dedicated-tail',
  })
  assert.equal(withoutTransition.mode, 'first-frame')
  assert.equal(withoutTransition.lastFrameAssetId, '')
  const withoutDedicatedTail = buildSmartShotVideoReferenceDraft({
    currentStoryboardAssetId: 'storyboard-current',
    recommendedAssetIds: [],
    eligibleAssetIds: eligible,
    sameShotStateChange: true,
  })
  assert.equal(withoutDedicatedTail.mode, 'first-frame')
  const explicit = buildSmartShotVideoReferenceDraft({
    currentStoryboardAssetId: 'storyboard-current',
    recommendedAssetIds: [],
    eligibleAssetIds: eligible,
    sameShotStateChange: true,
    dedicatedLastFrameAssetId: 'dedicated-tail',
  })
  assert.equal(explicit.mode, 'first-last-frame')
  assert.equal(explicit.lastFrameAssetId, 'dedicated-tail')
  assert.notEqual(explicit.lastFrameAssetId, 'next-shot-storyboard')
})

test('the final shot follows the same policy because recommendation has no neighbour or position input', () => {
  const eligible = new Set(['final-storyboard'])
  const ordinary = buildSmartShotVideoReferenceDraft({
    currentStoryboardAssetId: 'final-storyboard',
    recommendedAssetIds: [],
    eligibleAssetIds: eligible,
  })
  assert.equal(ordinary.mode, 'first-frame')
  assert.equal(ordinary.firstFrameAssetId, 'final-storyboard')
  assert.equal(ordinary.lastFrameAssetId, '')
})
