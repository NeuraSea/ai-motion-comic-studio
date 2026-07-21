import assert from 'node:assert/strict'
import { test } from 'node:test'

import { STORY_DOCUMENT_JSON_SCHEMA, StoryValidationError, parseStoryDocument } from './story-schema.js'

function validStory() {
  return {
    version: 1,
    title: '龙脉初醒',
    targetDurationSeconds: 30,
    bible: { logline: '少女守护长安。', theme: '责任', tone: '紧张', visualStyle: '国风动画' },
    characters: [{
      id: 'ali', name: '阿离', role: '主角', storyDescription: '年轻剑客', visualDescription: '黑色长发与红绳',
    }],
    locations: [{
      id: 'cliff', name: '断崖', storyDescription: '长安城外', visualDescription: '云海与落日',
    }],
    props: [{ id: 'token', name: '青铜令', description: '唤醒龙脉', visualDescription: '暗红纹路' }],
    scenes: [{
      id: 'scene-1', sequence: 0, title: '断崖龙吟', locationId: 'cliff', timeOfDay: '黄昏', description: '龙脉苏醒',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `镜头 ${index + 1}`,
        description: '阿离在风中看向云海。',
        framing: '中景',
        movement: '缓慢推进',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '国风动画，断崖，黄昏，云海。',
        dialogueLines: index === 2 ? [{
          id: 'line-1', sequence: 0, kind: 'dialogue', speaker: '阿离', text: '它醒了。',
        }] : [],
      })),
    }],
  }
}

test('accepts a 30-60 second editable story with 1-2 scenes and 6-12 shots', () => {
  const story = parseStoryDocument(validStory())
  assert.equal(story.scenes.length, 1)
  assert.equal(story.scenes[0].shots.length, 6)
  assert.equal(story.scenes[0].shots.reduce((sum, shot) => sum + shot.durationSeconds, 0), 30)
  assert.equal(STORY_DOCUMENT_JSON_SCHEMA.type, 'object')
})

test('rejects bad references, discontinuous sequences and invalid total duration', () => {
  const story = validStory()
  story.scenes[0].locationId = 'missing-location'
  story.scenes[0].shots[1].sequence = 9
  story.scenes[0].shots.forEach((shot) => { shot.durationSeconds = 1 })
  assert.throws(
    () => parseStoryDocument(story),
    (error: unknown) => {
      assert.ok(error instanceof StoryValidationError)
      assert.ok(error.issues.some((issue) => issue.includes('不存在的地点')))
      assert.ok(error.issues.some((issue) => issue.includes('镜头总时长')))
      assert.ok(error.issues.some((issue) => issue.includes('sequence')))
      return true
    },
  )
})
