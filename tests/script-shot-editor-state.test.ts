import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasUncommittedScriptShotDraft,
  scriptStageCommitState,
  scriptShotDraftChanged,
  scriptShotDraftValidationError,
  scriptShotEditablePatch,
  scriptShotReorderConfirmation,
  scriptShotSourcePatch,
  scriptShotStructureAvailability,
} from '../src/features/story/script-shot-editor-state'

const source = {
  code: 'S01-01',
  title: '推门',
  description: '主角推开旧门。',
  framing: '中景',
  movement: '缓推',
  transition: '硬切',
  durationSeconds: 4.2,
  visualPrompt: '中景，主角推开旧门，电影光影。',
}

test('剧本与配音工作台的镜头编辑提交完整结构属性', () => {
  const draft = {
    code: 'S01-02',
    title: '入室',
    copy: '主角进入房间。',
    framing: '全景',
    movement: '跟拍',
    transition: '叠化',
    duration: '5.3s',
    visualPrompt: '全景，主角进入房间，跟拍。',
  }

  assert.deepEqual(scriptShotEditablePatch(draft), draft)
  assert.deepEqual(scriptShotSourcePatch(source), {
    code: 'S01-01',
    title: '推门',
    copy: '主角推开旧门。',
    framing: '中景',
    movement: '缓推',
    transition: '硬切',
    duration: '4.2s',
    visualPrompt: '中景，主角推开旧门，电影光影。',
  })
  assert.equal(scriptShotDraftChanged(draft, source), true)
  assert.equal(scriptShotDraftChanged(scriptShotSourcePatch(source), source), false)
})

test('剧本与配音工作台在客户端拒绝空字段与越界时长', () => {
  const validDraft = scriptShotSourcePatch(source)
  assert.equal(scriptShotDraftValidationError(validDraft), null)
  assert.equal(scriptShotDraftValidationError({ ...validDraft, code: '  ' }), '镜头编号不能为空')
  assert.equal(scriptShotDraftValidationError({ ...validDraft, duration: '15.1s' }), '镜头时长必须介于 0.5 到 15 秒')
})

test('新增、删除和排序遵守全局数量与同场边界', () => {
  assert.deepEqual(scriptShotStructureAvailability({
    sceneIndex: 1,
    sceneShotCount: 3,
    totalShotCount: 8,
    mutationBusy: false,
    hasUncommittedDraft: false,
  }), {
    canMoveUp: true,
    canMoveDown: true,
    canDelete: true,
    canAdd: true,
    structureBlocked: false,
  })

  assert.equal(scriptShotStructureAvailability({
    sceneIndex: 0,
    sceneShotCount: 3,
    totalShotCount: 6,
    mutationBusy: false,
    hasUncommittedDraft: false,
  }).canMoveUp, false)
  assert.equal(scriptShotStructureAvailability({
    sceneIndex: 2,
    sceneShotCount: 3,
    totalShotCount: 12,
    mutationBusy: false,
    hasUncommittedDraft: false,
  }).canMoveDown, false)
  assert.equal(scriptShotStructureAvailability({
    sceneIndex: 0,
    sceneShotCount: 3,
    totalShotCount: 6,
    mutationBusy: false,
    hasUncommittedDraft: false,
  }).canDelete, false)
  assert.equal(scriptShotStructureAvailability({
    sceneIndex: 0,
    sceneShotCount: 3,
    totalShotCount: 12,
    mutationBusy: false,
    hasUncommittedDraft: false,
  }).canAdd, false)

  const blocked = scriptShotStructureAvailability({
    sceneIndex: 1,
    sceneShotCount: 3,
    totalShotCount: 8,
    mutationBusy: false,
    hasUncommittedDraft: true,
  })
  assert.equal(blocked.structureBlocked, true)
  assert.equal(blocked.canMoveUp, false)
  assert.equal(blocked.canMoveDown, false)
  assert.equal(blocked.canDelete, false)
  assert.equal(blocked.canAdd, false)
})

test('镜头排序必须显示准确位置并写入可解释的人工确认审计', () => {
  assert.deepEqual(scriptShotReorderConfirmation({
    code: 'S0-0',
    currentIndex: 0,
    targetIndex: 1,
    sceneShotCount: 8,
  }), {
    summary: '人工确认：镜头 S0-0 从第 1 位后移到第 2 位',
    message: '镜头 S0-0 已从第 1 位后移到第 2 位',
    confirmation: '确认将镜头 S0-0 从当前场景第 1 位后移到第 2 位？\n\n这是剧本结构变更，会创建不可变修订并要求时间线重新对账。不会因为点击箭头而静默执行。',
  })
  assert.throws(() => scriptShotReorderConfirmation({
    code: 'S0-0',
    currentIndex: 0,
    targetIndex: 2,
    sceneShotCount: 8,
  }), /排序位置无效/)
})

test('镜头草稿只与同一场景和镜头 ID 的权威源比较', () => {
  const story = {
    scenes: [
      { id: 'scene-a', shots: [{ id: 'shared-shot', ...source }] },
      {
        id: 'scene-b',
        shots: [{
          id: 'shared-shot',
          ...source,
          title: '另一场的同名镜头',
        }],
      },
    ],
  }
  const unchangedInSceneA = {
    sceneId: 'scene-a',
    storyId: 'shared-shot',
    ...scriptShotSourcePatch(source),
  }
  assert.equal(hasUncommittedScriptShotDraft([unchangedInSceneA], story), false)
  assert.equal(hasUncommittedScriptShotDraft([{
    ...unchangedInSceneA,
    title: '本地修改',
  }], story), true)
  assert.equal(hasUncommittedScriptShotDraft([{
    ...unchangedInSceneA,
    sceneId: 'scene-b',
    title: '另一场的同名镜头',
  }], story), false)
  assert.equal(hasUncommittedScriptShotDraft([{
    ...unchangedInSceneA,
    sceneId: 'missing-scene',
    title: '不允许模糊匹配到同 ID 镜头',
  }], story), false)
})

test('任一草稿或保存中都会阻止剧本与配音工作台继续', () => {
  assert.deepEqual(scriptStageCommitState({
    mutationBusy: false,
    hasUncommittedDraft: false,
  }), {
    canContinue: true,
    status: 'saved',
    message: '已保存为不可变剧本修订；继续只进入语音子页，不会自动发起 TTS',
    continueTitle: '继续生成与确认语音',
  })
  assert.equal(scriptStageCommitState({
    mutationBusy: false,
    hasUncommittedDraft: true,
  }).canContinue, false)
  assert.equal(scriptStageCommitState({
    mutationBusy: true,
    hasUncommittedDraft: false,
  }).status, 'saving')
})
