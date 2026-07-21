export interface ScriptShotEditableDraft {
  code: string
  title: string
  copy: string
  framing: string
  movement: string
  transition?: string
  duration: string
  visualPrompt: string
}

export interface ScriptShotEditablePatch {
  code: string
  title: string
  copy: string
  framing: string
  movement: string
  transition: string
  duration: string
  visualPrompt: string
}

export interface ScriptShotSource {
  code: string
  title: string
  description: string
  framing: string
  movement: string
  transition: string
  durationSeconds: number
  visualPrompt: string
}

export interface ScriptShotStructureAvailabilityInput {
  sceneIndex: number
  sceneShotCount: number
  totalShotCount: number
  mutationBusy: boolean
  hasUncommittedDraft: boolean
  maximumShotCount?: number
  minimumShotCount?: number
}

export interface ScriptShotStructureAvailability {
  canMoveUp: boolean
  canMoveDown: boolean
  canDelete: boolean
  canAdd: boolean
  structureBlocked: boolean
}

export interface ScriptStageCommitState {
  canContinue: boolean
  status: 'saved' | 'draft' | 'saving'
  message: string
  continueTitle: string
}

export interface ScriptShotReorderConfirmation {
  summary: string
  message: string
  confirmation: string
}

/**
 * Reordering is a structural Story edit, not a harmless UI sort. Keep the
 * exact before/after positions in both the human confirmation and immutable
 * revision summary so an accidental click can never become an unexplained
 * "shot order updated" audit record.
 */
export function scriptShotReorderConfirmation(input: {
  code: string
  currentIndex: number
  targetIndex: number
  sceneShotCount: number
}): ScriptShotReorderConfirmation {
  if (!Number.isInteger(input.currentIndex)
    || !Number.isInteger(input.targetIndex)
    || !Number.isInteger(input.sceneShotCount)
    || input.sceneShotCount < 1
    || input.currentIndex < 0
    || input.currentIndex >= input.sceneShotCount
    || input.targetIndex < 0
    || input.targetIndex >= input.sceneShotCount
    || Math.abs(input.currentIndex - input.targetIndex) !== 1) {
    throw new RangeError('镜头排序位置无效')
  }
  const code = input.code.trim() || '未命名镜头'
  const from = input.currentIndex + 1
  const to = input.targetIndex + 1
  const direction = to < from ? '前移' : '后移'
  return {
    summary: `人工确认：镜头 ${code} 从第 ${from} 位${direction}到第 ${to} 位`,
    message: `镜头 ${code} 已从第 ${from} 位${direction}到第 ${to} 位`,
    confirmation: `确认将镜头 ${code} 从当前场景第 ${from} 位${direction}到第 ${to} 位？\n\n这是剧本结构变更，会创建不可变修订并要求时间线重新对账。不会因为点击箭头而静默执行。`,
  }
}

export function scriptShotEditablePatch(
  draft: ScriptShotEditableDraft,
): ScriptShotEditablePatch {
  return {
    code: draft.code,
    title: draft.title,
    copy: draft.copy,
    framing: draft.framing,
    movement: draft.movement,
    transition: draft.transition ?? '硬切',
    duration: draft.duration,
    visualPrompt: draft.visualPrompt,
  }
}

export function scriptShotSourcePatch(source: ScriptShotSource): ScriptShotEditablePatch {
  return {
    code: source.code,
    title: source.title,
    copy: source.description,
    framing: source.framing,
    movement: source.movement,
    transition: source.transition,
    duration: `${source.durationSeconds.toFixed(1)}s`,
    visualPrompt: source.visualPrompt,
  }
}

export function scriptShotDraftChanged(
  draft: ScriptShotEditableDraft,
  source: ScriptShotSource,
): boolean {
  const current = scriptShotEditablePatch(draft)
  const authoritative = scriptShotSourcePatch(source)
  return (Object.keys(authoritative) as Array<keyof ScriptShotEditablePatch>)
    .some((key) => current[key] !== authoritative[key])
}

export function hasUncommittedScriptShotDraft(
  drafts: readonly (ScriptShotEditableDraft & { storyId?: string; sceneId?: string })[],
  story: { scenes: readonly { id: string; shots: readonly (ScriptShotSource & { id: string })[] }[] } | null,
): boolean {
  if (!story) return false
  const authoritative = new Map(story.scenes.flatMap((scene) => (
    scene.shots.map((shot) => [`${scene.id}\u0000${shot.id}`, shot] as const)
  )))
  return drafts.some((draft) => {
    if (!draft.sceneId || !draft.storyId) return false
    const source = authoritative.get(`${draft.sceneId}\u0000${draft.storyId}`)
    return source ? scriptShotDraftChanged(draft, source) : false
  })
}

export function scriptShotDraftValidationError(
  draft: ScriptShotEditableDraft,
): string | null {
  if (!draft.code.trim()) return '镜头编号不能为空'
  if (!draft.title.trim()) return '镜头标题不能为空'
  if (!draft.copy.trim()) return '画面描述不能为空'
  if (!draft.visualPrompt.trim()) return '镜头视觉 Prompt 不能为空'
  const durationSeconds = Number.parseFloat(draft.duration)
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0.5 || durationSeconds > 15) {
    return '镜头时长必须介于 0.5 到 15 秒'
  }
  return null
}

export function scriptShotStructureAvailability({
  sceneIndex,
  sceneShotCount,
  totalShotCount,
  mutationBusy,
  hasUncommittedDraft,
  maximumShotCount = 12,
  minimumShotCount = 6,
}: ScriptShotStructureAvailabilityInput): ScriptShotStructureAvailability {
  const structureBlocked = mutationBusy || hasUncommittedDraft
  return {
    canMoveUp: !structureBlocked && sceneIndex > 0,
    canMoveDown: !structureBlocked && sceneIndex >= 0 && sceneIndex < sceneShotCount - 1,
    canDelete: !structureBlocked && totalShotCount > minimumShotCount,
    canAdd: !structureBlocked && totalShotCount < maximumShotCount,
    structureBlocked,
  }
}

export function scriptStageCommitState({
  mutationBusy,
  hasUncommittedDraft,
}: {
  mutationBusy: boolean
  hasUncommittedDraft: boolean
}): ScriptStageCommitState {
  if (mutationBusy) {
    return {
      canContinue: false,
      status: 'saving',
      message: '正在保存剧本修订，请等待服务端确认',
      continueTitle: '剧本修订保存完成后才能继续生成与确认语音',
    }
  }
  if (hasUncommittedDraft) {
    return {
      canContinue: false,
      status: 'draft',
      message: '请先保存或取消本地草稿',
      continueTitle: '存在未提交的场景、镜头或台词草稿',
    }
  }
  return {
    canContinue: true,
    status: 'saved',
    message: '已保存为不可变剧本修订；继续只进入语音子页，不会自动发起 TTS',
    continueTitle: '继续生成与确认语音',
  }
}
