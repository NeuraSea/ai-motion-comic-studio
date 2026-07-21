import type { StoryDocument } from '../../lib'
import type {
  OfflineStoryDialogueLineDraft,
  OfflineStoryDraftChanges,
  OfflineStorySceneDraft,
  OfflineStoryShotDraft,
} from './offline-story-draft'

export const EMPTY_OFFLINE_STORY_DRAFT_CHANGES: OfflineStoryDraftChanges = {
  scenes: [],
  dialogueLines: [],
  shots: [],
}

export function offlineStoryDraftHasChanges(changes: OfflineStoryDraftChanges): boolean {
  return changes.scenes.length > 0
    || changes.dialogueLines.length > 0
    || changes.shots.length > 0
}

export function withOfflineSceneDraft(
  changes: OfflineStoryDraftChanges,
  draft: OfflineStorySceneDraft | null,
  sceneId: string,
): OfflineStoryDraftChanges {
  const scenes = changes.scenes.filter((entry) => entry.sceneId !== sceneId)
  if (draft) scenes.push(draft)
  return { ...changes, scenes }
}

export function withOfflineDialogueDraft(
  changes: OfflineStoryDraftChanges,
  draft: OfflineStoryDialogueLineDraft | null,
  target: Pick<OfflineStoryDialogueLineDraft, 'sceneId' | 'shotId' | 'lineId'>,
): OfflineStoryDraftChanges {
  const dialogueLines = changes.dialogueLines.filter((entry) => !(
    entry.sceneId === target.sceneId
    && entry.shotId === target.shotId
    && entry.lineId === target.lineId
  ))
  if (draft) dialogueLines.push(draft)
  return { ...changes, dialogueLines }
}

export function withoutOfflineShotDraft(
  changes: OfflineStoryDraftChanges,
  sceneId: string,
  shotId: string,
): OfflineStoryDraftChanges {
  return {
    ...changes,
    shots: changes.shots.filter((entry) => !(
      entry.sceneId === sceneId && entry.shotId === shotId
    )),
  }
}

export interface OfflineStoryEditableShotProjection {
  storyId?: string
  sceneId?: string
  code: string
  title: string
  copy: string
  framing: string
  movement: string
  transition?: string
  duration: string
  visualPrompt: string
}

export function projectOfflineShotDrafts(
  shots: readonly OfflineStoryEditableShotProjection[],
  story: StoryDocument | null,
): OfflineStoryShotDraft[] {
  if (!story) return []
  const authoritative = new Map(story.scenes.flatMap((scene) => scene.shots.map((shot) => (
    [`${scene.id}\u0000${shot.id}`, shot] as const
  ))))
  return shots.flatMap((shot): OfflineStoryShotDraft[] => {
    if (!shot.sceneId || !shot.storyId) return []
    const source = authoritative.get(`${shot.sceneId}\u0000${shot.storyId}`)
    if (!source) return []
    const patch: OfflineStoryShotDraft['patch'] = {}
    if (shot.code !== source.code) patch.code = shot.code
    if (shot.title !== source.title) patch.title = shot.title
    if (shot.copy !== source.description) patch.description = shot.copy
    if (shot.framing !== source.framing) patch.framing = shot.framing
    if (shot.movement !== source.movement) patch.movement = shot.movement
    if ((shot.transition ?? '硬切') !== source.transition) patch.transition = shot.transition ?? '硬切'
    if (shot.visualPrompt !== source.visualPrompt) patch.visualPrompt = shot.visualPrompt
    const durationSeconds = Number.parseFloat(shot.duration)
    if (!Number.isFinite(durationSeconds)
      || Math.abs(durationSeconds - source.durationSeconds) > 0.0001) {
      patch.durationSeconds = durationSeconds
    }
    return Object.keys(patch).length > 0
      ? [{ sceneId: shot.sceneId, shotId: shot.storyId, patch }]
      : []
  })
}

export function composeOfflineStoryDraftChanges(
  formDrafts: Pick<OfflineStoryDraftChanges, 'scenes' | 'dialogueLines'>,
  shots: readonly OfflineStoryEditableShotProjection[],
  story: StoryDocument | null,
): OfflineStoryDraftChanges {
  return {
    scenes: formDrafts.scenes,
    dialogueLines: formDrafts.dialogueLines,
    shots: projectOfflineShotDrafts(shots, story),
  }
}

/**
 * Exact IDs must still exist before same-base recovery is applied. This is a
 * defensive check against damaged storage; it never attempts fuzzy matching.
 */
export function offlineStoryDraftTargetError(
  story: StoryDocument,
  changes: OfflineStoryDraftChanges,
): string | null {
  const scenes = new Map(story.scenes.map((scene) => [scene.id, scene] as const))
  for (const draft of changes.scenes) {
    if (!scenes.has(draft.sceneId)) return `草稿场景 ${draft.sceneId} 不存在于当前剧本`
  }
  for (const draft of changes.shots) {
    const shot = scenes.get(draft.sceneId)?.shots.find((candidate) => candidate.id === draft.shotId)
    if (!shot) return `草稿镜头 ${draft.shotId} 不存在于当前剧本`
  }
  for (const draft of changes.dialogueLines) {
    const line = scenes.get(draft.sceneId)?.shots
      .find((candidate) => candidate.id === draft.shotId)?.dialogueLines
      .find((candidate) => candidate.id === draft.lineId)
    if (!line) return `草稿台词 ${draft.lineId} 不存在于当前剧本`
  }
  return null
}

export function applyOfflineShotDrafts<T extends OfflineStoryEditableShotProjection>(
  shots: readonly T[],
  drafts: readonly OfflineStoryShotDraft[],
): T[] {
  const byTarget = new Map(drafts.map((draft) => (
    [`${draft.sceneId}\u0000${draft.shotId}`, draft.patch] as const
  )))
  return shots.map((shot) => {
    if (!shot.sceneId || !shot.storyId) return shot
    const patch = byTarget.get(`${shot.sceneId}\u0000${shot.storyId}`)
    if (!patch) return shot
    return {
      ...shot,
      ...(patch.code !== undefined ? { code: patch.code } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { copy: patch.description } : {}),
      ...(patch.framing !== undefined ? { framing: patch.framing } : {}),
      ...(patch.movement !== undefined ? { movement: patch.movement } : {}),
      ...(patch.transition !== undefined ? { transition: patch.transition } : {}),
      ...(patch.durationSeconds !== undefined ? { duration: `${patch.durationSeconds}s` } : {}),
      ...(patch.visualPrompt !== undefined ? { visualPrompt: patch.visualPrompt } : {}),
    }
  })
}

export function discardOfflineShotDrafts<T extends OfflineStoryEditableShotProjection>(
  shots: readonly T[],
  story: StoryDocument,
): T[] {
  const authoritative = new Map(story.scenes.flatMap((scene) => scene.shots.map((shot) => (
    [`${scene.id}\u0000${shot.id}`, shot] as const
  ))))
  return shots.map((shot) => {
    if (!shot.sceneId || !shot.storyId) return shot
    const source = authoritative.get(`${shot.sceneId}\u0000${shot.storyId}`)
    if (!source) return shot
    return {
      ...shot,
      code: source.code,
      title: source.title,
      copy: source.description,
      framing: source.framing,
      movement: source.movement,
      transition: source.transition,
      duration: `${source.durationSeconds.toFixed(1)}s`,
      visualPrompt: source.visualPrompt,
    }
  })
}
