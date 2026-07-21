import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createStoryRevisionHistoryState,
  storyRevisionHistoryReducer,
  storyRevisionNavigationCommand,
  storyRevisionNavigationTarget,
} from '../src/features/story/story-revision-history'

function commit(
  state: ReturnType<typeof createStoryRevisionHistoryState>,
  beforeRevisionId: string,
  afterRevisionId: string,
  label: string,
) {
  return storyRevisionHistoryReducer(state, {
    type: 'record-commit',
    beforeRevisionId,
    afterRevisionId,
    label,
  })
}

function navigate(
  state: ReturnType<typeof createStoryRevisionHistoryState>,
  direction: 'undo' | 'redo',
  resultRevisionId: string,
) {
  const begun = storyRevisionHistoryReducer(state, { type: 'begin-navigation', direction })
  return storyRevisionHistoryReducer(begun, {
    type: 'complete-navigation',
    direction,
    headRevisionId: resultRevisionId,
  })
}

test('undo and redo traverse immutable before/after targets while every result becomes a new head', () => {
  let state = createStoryRevisionHistoryState('revision-a')
  state = commit(state, 'revision-a', 'revision-b', '编辑场景')
  state = commit(state, 'revision-b', 'revision-c', '编辑台词')

  const second = storyRevisionNavigationCommand(state, 'undo')
  assert.ok(second)
  assert.equal(storyRevisionNavigationTarget(second, 'undo'), 'revision-b')
  state = navigate(state, 'undo', 'revision-undo-1')
  assert.equal(state.headRevisionId, 'revision-undo-1')
  assert.equal(storyRevisionNavigationTarget(storyRevisionNavigationCommand(state, 'undo')!, 'undo'), 'revision-a')

  state = navigate(state, 'undo', 'revision-undo-2')
  assert.equal(state.headRevisionId, 'revision-undo-2')
  assert.equal(storyRevisionNavigationTarget(storyRevisionNavigationCommand(state, 'redo')!, 'redo'), 'revision-b')

  state = navigate(state, 'redo', 'revision-redo-1')
  assert.equal(state.headRevisionId, 'revision-redo-1')
  assert.equal(storyRevisionNavigationTarget(storyRevisionNavigationCommand(state, 'redo')!, 'redo'), 'revision-c')

  state = navigate(state, 'redo', 'revision-redo-2')
  assert.equal(state.headRevisionId, 'revision-redo-2')
  assert.equal(state.undo.length, 2)
  assert.equal(state.redo.length, 0)
})

test('a new commit after undo clears redo and no-op commits do not create commands', () => {
  let state = createStoryRevisionHistoryState('revision-a')
  state = commit(state, 'revision-a', 'revision-b', '编辑镜头')
  state = commit(state, 'revision-b', 'revision-b', '无变更排序')
  assert.equal(state.undo.length, 1)

  state = navigate(state, 'undo', 'revision-undo')
  assert.equal(state.redo.length, 1)
  state = commit(state, 'revision-undo', 'revision-branch', '新增镜头')
  assert.equal(state.undo.length, 1)
  assert.equal(state.undo[0]?.afterRevisionId, 'revision-branch')
  assert.equal(state.redo.length, 0)
})

test('authority refresh preserves history only for the exact same source revision', () => {
  let state = createStoryRevisionHistoryState('revision-a')
  state = commit(state, 'revision-a', 'revision-b', '编辑场景')
  state = storyRevisionHistoryReducer(state, { type: 'begin-navigation', direction: 'undo' })

  const independentEpisodeWrite = storyRevisionHistoryReducer(state, {
    type: 'authority-refreshed',
    headRevisionId: 'revision-b',
  })
  assert.equal(independentEpisodeWrite.undo.length, 1)
  assert.equal(independentEpisodeWrite.pending, null)

  const externalStoryWrite = storyRevisionHistoryReducer(state, {
    type: 'authority-refreshed',
    headRevisionId: 'revision-external',
  })
  assert.deepEqual(externalStoryWrite, createStoryRevisionHistoryState('revision-external'))
})

test('an unrecognised commit base cannot retain an unsafe local traversal chain', () => {
  let state = createStoryRevisionHistoryState('revision-a')
  state = commit(state, 'revision-a', 'revision-b', '编辑场景')

  state = commit(state, 'revision-external', 'revision-local-after-refresh', '编辑镜头')
  assert.equal(state.headRevisionId, 'revision-local-after-refresh')
  assert.equal(state.undo.length, 1)
  assert.equal(state.undo[0]?.beforeRevisionId, 'revision-external')
  assert.equal(state.redo.length, 0)
})

test('pending navigation is single-flight and failed navigation keeps the command', () => {
  let state = commit(createStoryRevisionHistoryState('revision-a'), 'revision-a', 'revision-b', '编辑场景')
  state = storyRevisionHistoryReducer(state, { type: 'begin-navigation', direction: 'undo' })
  const duplicate = storyRevisionHistoryReducer(state, { type: 'begin-navigation', direction: 'undo' })
  assert.strictEqual(duplicate, state)

  state = storyRevisionHistoryReducer(state, { type: 'abort-navigation' })
  assert.equal(state.pending, null)
  assert.equal(state.undo.length, 1)
  assert.equal(state.redo.length, 0)
})

test('selection anchors travel with structural commands', () => {
  let state = createStoryRevisionHistoryState('revision-a')
  state = storyRevisionHistoryReducer(state, {
    type: 'record-commit',
    beforeRevisionId: 'revision-a',
    afterRevisionId: 'revision-b',
    label: '删除镜头 S00-03',
    selectionBefore: 'shot-3',
    selectionAfter: 'shot-4',
  })
  const command = storyRevisionNavigationCommand(state, 'undo')
  assert.equal(command?.selectionBefore, 'shot-3')
  assert.equal(command?.selectionAfter, 'shot-4')
})
