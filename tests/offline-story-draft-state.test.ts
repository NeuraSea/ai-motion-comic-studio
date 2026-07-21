import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { StoryDocument } from '../src/lib'
import { OfflineStoryDraftRecoveryDialog } from '../src/features/story/OfflineStoryDraftRecoveryDialog'
import {
  createOfflineStoryDraft,
  type OfflineStoryDraftChanges,
} from '../src/features/story/offline-story-draft'
import {
  applyOfflineShotDrafts,
  composeOfflineStoryDraftChanges,
  discardOfflineShotDrafts,
  offlineStoryDraftTargetError,
  withOfflineDialogueDraft,
  withOfflineSceneDraft,
  withoutOfflineShotDraft,
} from '../src/features/story/offline-story-draft-state'

function story(): StoryDocument {
  return {
    version: 1,
    title: '断网测试',
    targetDurationSeconds: 30,
    bible: { logline: '测试', theme: '恢复', tone: '克制', visualStyle: '国风' },
    characters: [],
    locations: [],
    props: [],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '雨夜',
      locationId: 'location-1',
      timeOfDay: '夜',
      description: '雨落在屋檐。',
      shots: [{
        id: 'shot-1',
        sequence: 0,
        code: 'S00-01',
        title: '抬头',
        description: '人物抬头。',
        framing: '近景',
        movement: '静止',
        transition: '硬切',
        durationSeconds: 3,
        visualPrompt: '雨夜近景',
        dialogueLines: [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue',
          speaker: '阿离',
          text: '来了。',
        }],
      }],
    }],
  }
}

const sourceShot = {
  storyId: 'shot-1',
  sceneId: 'scene-1',
  code: 'S00-01',
  title: '抬头',
  copy: '人物抬头。',
  framing: '近景',
  movement: '静止',
  transition: '硬切',
  duration: '3.0s',
  visualPrompt: '雨夜近景',
  retainedAssetId: 'asset-must-survive',
}

test('draft projection stores only changed editable Story fields', () => {
  const changes = composeOfflineStoryDraftChanges({
    scenes: [{ sceneId: 'scene-1', patch: { title: '雨夜重逢' } }],
    dialogueLines: [{ sceneId: 'scene-1', shotId: 'shot-1', lineId: 'line-1', text: '终于来了。' }],
  }, [{
    ...sourceShot,
    copy: '人物在雨中缓慢抬头。',
    duration: '4.5s',
  }], story())

  assert.deepEqual(changes.shots, [{
    sceneId: 'scene-1',
    shotId: 'shot-1',
    patch: { description: '人物在雨中缓慢抬头。', durationSeconds: 4.5 },
  }])
  const serialized = JSON.stringify(changes)
  assert.ok(!serialized.includes('retainedAssetId'))
  assert.ok(!serialized.includes('provider'))
  assert.ok(!serialized.includes('token'))
})

test('same-base shot recovery and discard preserve non-Story UI metadata', () => {
  const recovered = applyOfflineShotDrafts([sourceShot], [{
    sceneId: 'scene-1',
    shotId: 'shot-1',
    patch: { framing: '特写', durationSeconds: 5 },
  }])
  assert.equal(recovered[0]?.framing, '特写')
  assert.equal(recovered[0]?.duration, '5s')
  assert.equal(recovered[0]?.retainedAssetId, 'asset-must-survive')

  const discarded = discardOfflineShotDrafts(recovered, story())
  assert.equal(discarded[0]?.framing, '近景')
  assert.equal(discarded[0]?.duration, '3.0s')
  assert.equal(discarded[0]?.retainedAssetId, 'asset-must-survive')
})

test('recovery fails closed when any exact Story target no longer exists', () => {
  assert.equal(offlineStoryDraftTargetError(story(), {
    scenes: [],
    shots: [],
    dialogueLines: [{
      sceneId: 'scene-1',
      shotId: 'shot-1',
      lineId: 'missing-line',
      text: '不能模糊匹配',
    }],
  }), '草稿台词 missing-line 不存在于当前剧本')
})

test('clearing a committed target keeps unrelated edits in the old-base envelope', () => {
  const initial: OfflineStoryDraftChanges = {
    scenes: [{ sceneId: 'scene-1', patch: { title: '新标题' } }],
    shots: [{ sceneId: 'scene-1', shotId: 'shot-1', patch: { framing: '特写' } }],
    dialogueLines: [{ sceneId: 'scene-1', shotId: 'shot-1', lineId: 'line-1', text: '新台词' }],
  }
  const withoutScene = withOfflineSceneDraft(initial, null, 'scene-1')
  assert.equal(withoutScene.scenes.length, 0)
  assert.equal(withoutScene.shots.length, 1)
  assert.equal(withoutScene.dialogueLines.length, 1)
  const withoutLine = withOfflineDialogueDraft(withoutScene, null, {
    sceneId: 'scene-1', shotId: 'shot-1', lineId: 'line-1',
  })
  const empty = withoutOfflineShotDraft(withoutLine, 'scene-1', 'shot-1')
  assert.deepEqual(empty, { scenes: [], shots: [], dialogueLines: [] })
})

test('recovery dialog exposes restore only for the exact authoritative base', () => {
  const draft = createOfflineStoryDraft({
    projectId: 'project-1',
    episodeId: 'episode-1',
    baseSourceRevisionId: 'revision-1',
  }, {
    scenes: [{ sceneId: 'scene-1', patch: { title: '本地标题' } }],
    shots: [],
    dialogueLines: [],
  }, '2026-07-15T02:03:04.000Z')
  const html = renderToStaticMarkup(createElement(OfflineStoryDraftRecoveryDialog, {
    draft,
    authoritativeSourceRevisionId: 'revision-1',
    onRestore() {},
    onDiscard() {},
    onCopyAsText() {},
  }))
  assert.match(html, /恢复到编辑器/)
  assert.doesNotMatch(html, /复制救援文本并继续/)
})

test('cross-revision dialog has no restore action and offers only salvage or discard', () => {
  const draft = createOfflineStoryDraft({
    projectId: 'project-1',
    episodeId: 'episode-1',
    baseSourceRevisionId: 'revision-old',
  }, {
    scenes: [],
    shots: [],
    dialogueLines: [{ sceneId: 'scene-1', shotId: 'shot-1', lineId: 'line-1', text: '救援文本' }],
  }, '2026-07-15T02:03:04.000Z')
  const html = renderToStaticMarkup(createElement(OfflineStoryDraftRecoveryDialog, {
    draft,
    authoritativeSourceRevisionId: 'revision-new',
    onRestore() {},
    onDiscard() {},
    onCopyAsText() {},
  }))
  assert.match(html, /复制救援文本并继续/)
  assert.match(html, /丢弃本地草稿/)
  assert.match(html, /禁止恢复或自动合并/)
  assert.doesNotMatch(html, />恢复到编辑器</)
})
