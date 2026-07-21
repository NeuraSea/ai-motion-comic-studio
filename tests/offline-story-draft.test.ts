import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_OFFLINE_STORY_DRAFT_BYTES,
  clearOfflineStoryDraft,
  createOfflineStoryDraft,
  decideOfflineStoryDraftRecovery,
  loadOfflineStoryDraft,
  loadOfflineStoryDraftForEpisode,
  offlineStoryDraftAsText,
  offlineStoryDraftStorageKey,
  saveOfflineStoryDraft,
  type OfflineStoryDraftChanges,
  type OfflineStoryDraftScope,
} from '../src/features/story/offline-story-draft'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  putRaw(key: string, value: string): void {
    this.values.set(key, value)
  }

  dump(): string[] {
    return [...this.values.values()]
  }
}

const scope: OfflineStoryDraftScope = {
  projectId: 'project:one',
  episodeId: 'episode-1',
  baseSourceRevisionId: 'revision:base-1',
}

function changes(): OfflineStoryDraftChanges {
  return {
    scenes: [{
      sceneId: 'scene-1',
      patch: {
        title: '雨夜追车',
        description: '',
      },
    }],
    dialogueLines: [{
      sceneId: 'scene-1',
      shotId: 'shot-1',
      lineId: 'line-1',
      text: '别回头。',
    }],
    shots: [{
      sceneId: 'scene-1',
      shotId: 'shot-1',
      patch: {
        framing: '近景',
        movement: '手持跟拍',
        durationSeconds: 4.5,
      },
    }],
  }
}

test('storage keys isolate project, episode and base source revision', () => {
  const key = offlineStoryDraftStorageKey(scope)
  assert.match(key, /^manju\.story-draft\.v1:/)
  assert.ok(key.includes('project%3Aone'))
  assert.ok(key.includes('revision%3Abase-1'))
  assert.notEqual(key, offlineStoryDraftStorageKey({ ...scope, episodeId: 'episode-2' }))
  assert.notEqual(key, offlineStoryDraftStorageKey({ ...scope, baseSourceRevisionId: 'revision:base-2' }))
})

test('save and load round-trip only allowlisted editable Story fields', () => {
  const storage = new MemoryStorage()
  const saved = saveOfflineStoryDraft(storage, scope, changes(), {
    savedAt: '2026-07-15T02:03:04.000Z',
  })
  assert.equal(saved.status, 'saved')

  const loaded = loadOfflineStoryDraft(storage, scope)
  assert.equal(loaded.status, 'loaded')
  if (loaded.status !== 'loaded') return
  assert.deepEqual(loaded.draft.drafts, changes())
  assert.equal(loaded.draft.scope.baseSourceRevisionId, 'revision:base-1')
  assert.equal(loaded.draft.savedAt, '2026-07-15T02:03:04.000Z')

  const raw = storage.dump().join('\n')
  assert.ok(!raw.includes('apiKey'))
  assert.ok(!raw.includes('providerId'))
  assert.ok(!raw.includes('token'))
})

test('unknown credential or Provider fields are rejected instead of persisted', () => {
  const storage = new MemoryStorage()
  const unsafeRoot = {
    ...changes(),
    apiKey: 'must-not-be-persisted',
  } as unknown as OfflineStoryDraftChanges
  assert.deepEqual(saveOfflineStoryDraft(storage, scope, unsafeRoot), {
    status: 'rejected',
    key: offlineStoryDraftStorageKey(scope),
    reason: 'invalid-schema',
  })

  const unsafePatch = changes() as unknown as {
    scenes: Array<{ sceneId: string; patch: Record<string, unknown> }>
    dialogueLines: OfflineStoryDraftChanges['dialogueLines']
    shots: OfflineStoryDraftChanges['shots']
  }
  unsafePatch.scenes[0]!.patch.provider = { token: 'also-secret' }
  assert.equal(
    saveOfflineStoryDraft(storage, scope, unsafePatch as unknown as OfflineStoryDraftChanges).status,
    'rejected',
  )
  assert.deepEqual(storage.dump(), [])
})

test('corruption, version drift and scope mismatch fail closed', () => {
  const storage = new MemoryStorage()
  const key = offlineStoryDraftStorageKey(scope)

  storage.putRaw(key, '{not-json')
  assert.deepEqual(loadOfflineStoryDraft(storage, scope), {
    status: 'invalid',
    key,
    reason: 'malformed-json',
  })

  const draft = createOfflineStoryDraft(scope, changes(), '2026-07-15T02:03:04.000Z')
  storage.putRaw(key, JSON.stringify({ ...draft, version: 2 }))
  assert.deepEqual(loadOfflineStoryDraft(storage, scope), {
    status: 'invalid',
    key,
    reason: 'invalid-schema',
  })

  storage.putRaw(key, JSON.stringify({
    ...draft,
    scope: { ...scope, baseSourceRevisionId: 'revision:other' },
  }))
  assert.deepEqual(loadOfflineStoryDraft(storage, scope), {
    status: 'invalid',
    key,
    reason: 'scope-mismatch',
  })
})

test('the UTF-8 size cap is enforced on both save and load', () => {
  const storage = new MemoryStorage()
  const oversizedChanges: OfflineStoryDraftChanges = {
    scenes: [],
    dialogueLines: [],
    shots: Array.from({ length: 70 }, (_, index) => ({
      sceneId: 'scene-1',
      shotId: `shot-${index}`,
      patch: { visualPrompt: '龙'.repeat(4_000) },
    })),
  }
  const saveResult = saveOfflineStoryDraft(storage, scope, oversizedChanges, {
    savedAt: '2026-07-15T02:03:04.000Z',
  })
  assert.deepEqual(saveResult, {
    status: 'rejected',
    key: offlineStoryDraftStorageKey(scope),
    reason: 'oversized',
  })
  assert.deepEqual(storage.dump(), [])

  const key = offlineStoryDraftStorageKey(scope)
  storage.putRaw(key, 'x'.repeat(MAX_OFFLINE_STORY_DRAFT_BYTES + 1))
  assert.deepEqual(loadOfflineStoryDraft(storage, scope), {
    status: 'invalid',
    key,
    reason: 'oversized',
  })
})

test('duplicate targets and empty snapshots are invalid because recovery would be ambiguous', () => {
  const storage = new MemoryStorage()
  const duplicate = changes()
  duplicate.scenes.push({ sceneId: 'scene-1', patch: { title: '重复' } })
  assert.equal(saveOfflineStoryDraft(storage, scope, duplicate).status, 'rejected')
  assert.equal(saveOfflineStoryDraft(storage, scope, {
    scenes: [],
    dialogueLines: [],
    shots: [],
  }).status, 'rejected')
})

test('clear removes only the exact scoped draft', () => {
  const storage = new MemoryStorage()
  const otherScope = { ...scope, baseSourceRevisionId: 'revision:base-2' }
  assert.equal(saveOfflineStoryDraft(storage, scope, changes()).status, 'saved')
  assert.equal(saveOfflineStoryDraft(storage, otherScope, changes()).status, 'saved')

  assert.equal(clearOfflineStoryDraft(storage, scope).status, 'cleared')
  assert.equal(loadOfflineStoryDraft(storage, scope).status, 'missing')
  assert.equal(loadOfflineStoryDraft(storage, otherScope).status, 'loaded')
})

test('episode recovery finds the newest stale revision but always prefers an exact current base', () => {
  const storage = new MemoryStorage()
  const newerScope = { ...scope, baseSourceRevisionId: 'revision:base-2' }
  const unseenScope = { ...scope, baseSourceRevisionId: 'revision:base-3' }
  assert.equal(saveOfflineStoryDraft(storage, scope, changes(), {
    savedAt: '2026-07-15T02:03:04.000Z',
  }).status, 'saved')
  assert.equal(saveOfflineStoryDraft(storage, newerScope, changes(), {
    savedAt: '2026-07-15T03:03:04.000Z',
  }).status, 'saved')

  const exact = loadOfflineStoryDraftForEpisode(storage, scope)
  assert.equal(exact.status, 'loaded')
  if (exact.status === 'loaded') {
    assert.equal(exact.draft.scope.baseSourceRevisionId, scope.baseSourceRevisionId)
  }

  const stale = loadOfflineStoryDraftForEpisode(storage, unseenScope)
  assert.equal(stale.status, 'loaded')
  if (stale.status === 'loaded') {
    assert.equal(stale.draft.scope.baseSourceRevisionId, newerScope.baseSourceRevisionId)
  }

  assert.equal(clearOfflineStoryDraft(storage, newerScope).status, 'cleared')
  const fallback = loadOfflineStoryDraftForEpisode(storage, unseenScope)
  assert.equal(fallback.status, 'loaded')
  if (fallback.status === 'loaded') {
    assert.equal(fallback.draft.scope.baseSourceRevisionId, scope.baseSourceRevisionId)
  }
})

test('recovery is a pure three-way policy and never applies across revisions', () => {
  const draft = createOfflineStoryDraft(scope, changes(), '2026-07-15T02:03:04.000Z')
  assert.deepEqual(decideOfflineStoryDraftRecovery(null, scope.baseSourceRevisionId), {
    kind: 'none',
  })

  const sameBase = decideOfflineStoryDraftRecovery(draft, scope.baseSourceRevisionId)
  assert.equal(sameBase.kind, 'restore-same-base')
  if (sameBase.kind === 'restore-same-base') assert.equal(sameBase.autoApply, true)

  const changedAuthority = decideOfflineStoryDraftRecovery(draft, 'revision:new-authority')
  assert.equal(changedAuthority.kind, 'authoritative-source-changed')
  if (changedAuthority.kind !== 'authoritative-source-changed') return
  assert.equal(changedAuthority.autoApply, false)
  assert.deepEqual(changedAuthority.allowedActions, ['discard', 'copy-as-text'])
  assert.ok(!Object.values(changedAuthority).includes('restore'))

  const salvage = offlineStoryDraftAsText(draft)
  assert.ok(salvage.includes('别回头。'))
  assert.ok(!salvage.includes('projectId'))
  assert.ok(!salvage.includes('provider'))
})

test('storage denial is reported without throwing or claiming persistence', () => {
  const denied = {
    getItem(): string | null { throw new Error('denied') },
    setItem(): void { throw new Error('denied') },
    removeItem(): void { throw new Error('denied') },
  }
  assert.equal(saveOfflineStoryDraft(denied, scope, changes()).status, 'unavailable')
  assert.equal(loadOfflineStoryDraft(denied, scope).status, 'unavailable')
  assert.equal(clearOfflineStoryDraft(denied, scope).status, 'unavailable')
})
