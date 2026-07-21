import assert from 'node:assert/strict'
import test from 'node:test'
import type { EpisodeSummary } from '../src/lib/api-types'
import {
  beginEpisodeRenderSettingsResolution,
  createEpisodeRenderSettingsConflict,
  isEpisodeRenderSettingsResolutionCurrent,
  loadConsistentEpisodeRenderSettingsAuthority,
  makeEpisodeRenderSettingsConflictReady,
  reapplyEpisodeRenderSettingsAfterRefresh,
  withEpisodeRenderSettingsAuthority,
  withEpisodeRenderSettingsIntent,
} from '../src/features/settings/episode-render-settings-conflict'

const story = {
  version: 1 as const,
  title: '第一集',
  targetDurationSeconds: 45,
  bible: { logline: '一句话', theme: '主题', tone: '克制', visualStyle: '国风动画' },
  characters: [],
  locations: [],
  props: [],
  scenes: [],
}

function episode(overrides: Partial<EpisodeSummary> = {}): EpisodeSummary {
  return {
    id: 'episode-1',
    projectId: 'project-1',
    title: '第一集',
    sourceText: '原文',
    targetDurationSeconds: 45,
    aspectRatio: '16:9',
    stylePreset: '国风动画',
    status: 'draft',
    sortOrder: 0,
    sourceRevisionId: 'story-1',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  }
}

function conflict(conflictId = 1) {
  return createEpisodeRenderSettingsConflict({
    conflictId,
    scope: { projectId: 'project-1', episodeId: 'episode-1' },
    localIntent: { stylePreset: '日漫赛璐璐', aspectRatio: '9:16' },
    lastKnownServer: { stylePreset: '国风动画', aspectRatio: '16:9' },
    lastKnownEtag: 'W/"episode.old"',
  })
}

test('conflict state keeps the local intent separate from refreshed server settings', () => {
  const initial = conflict()
  const refreshed = withEpisodeRenderSettingsAuthority(initial, {
    episode: episode({ stylePreset: '东方水墨', aspectRatio: '1:1' }),
    etag: 'W/"episode.current"',
  })
  const ready = makeEpisodeRenderSettingsConflictReady(refreshed)

  assert.deepEqual(ready.localIntent, { stylePreset: '日漫赛璐璐', aspectRatio: '9:16' })
  assert.deepEqual(ready.baseSnapshot, { stylePreset: '国风动画', aspectRatio: '16:9' })
  assert.deepEqual(ready.serverSnapshot, { stylePreset: '东方水墨', aspectRatio: '1:1' })
  assert.equal(ready.serverEtag, 'W/"episode.current"')
  assert.equal(ready.serverVerified, true)
})

test('queued local edits coalesce into the preserved conflict intent', () => {
  const next = withEpisodeRenderSettingsIntent(conflict(), {
    stylePreset: '3D 写实',
    aspectRatio: '1:1',
  })

  assert.deepEqual(next.localIntent, { stylePreset: '3D 写实', aspectRatio: '1:1' })
  assert.deepEqual(next.serverSnapshot, { stylePreset: '国风动画', aspectRatio: '16:9' })
})

test('resolution tokens reject double clicks and stale ABA completions', () => {
  const ready = makeEpisodeRenderSettingsConflictReady(conflict(7))
  const first = beginEpisodeRenderSettingsResolution(ready, 'reapply-local')
  assert.ok(first.token)
  assert.equal(isEpisodeRenderSettingsResolutionCurrent(first.state, first.token), true)

  const repeated = beginEpisodeRenderSettingsResolution(first.state, 'reapply-local')
  assert.equal(repeated.token, null)
  assert.equal(repeated.state, first.state)

  // Even if values cycle A -> B -> A, a newly opened conflict has a distinct
  // identity and cannot be completed by the previous asynchronous request.
  const reopened = makeEpisodeRenderSettingsConflictReady(conflict(8))
  assert.equal(isEpisodeRenderSettingsResolutionCurrent(reopened, first.token), false)
})

test('reapply always GETs authority first and PATCHes with that exact newest ETag', async () => {
  const calls: string[] = []
  const result = await reapplyEpisodeRenderSettingsAfterRefresh({
    scope: { projectId: 'project-1', episodeId: 'episode-1' },
    localIntent: { stylePreset: '日漫赛璐璐', aspectRatio: '9:16' },
    transport: {
      async load(scope) {
        calls.push(`GET:${scope.projectId}:${scope.episodeId}`)
        // Same visible value as an older state is deliberate: only the opaque,
        // monotonic ETag distinguishes this ABA cycle.
        return { episode: episode(), etag: 'W/"episode.after-aba"' }
      },
      async save(scope, intent, etag) {
        calls.push(`PATCH:${scope.projectId}:${scope.episodeId}:${etag}`)
        assert.deepEqual(intent, { stylePreset: '日漫赛璐璐', aspectRatio: '9:16' })
        assert.equal(etag, 'W/"episode.after-aba"')
        return {
          episode: episode({ stylePreset: intent.stylePreset, aspectRatio: intent.aspectRatio }),
          etag: 'W/"episode.saved"',
        }
      },
    },
  })

  assert.deepEqual(calls, [
    'GET:project-1:episode-1',
    'PATCH:project-1:episode-1:W/"episode.after-aba"',
  ])
  assert.equal(result.refreshed.etag, 'W/"episode.after-aba"')
  assert.equal(result.saved.etag, 'W/"episode.saved"')
})

test('authority validation rejects cross-episode refreshes before any PATCH', async () => {
  let saved = false
  await assert.rejects(
    reapplyEpisodeRenderSettingsAfterRefresh({
      scope: { projectId: 'project-1', episodeId: 'episode-1' },
      localIntent: { stylePreset: '东方水墨', aspectRatio: '1:1' },
      transport: {
        async load() {
          return { episode: episode({ id: 'episode-other' }), etag: 'W/"episode.other"' }
        },
        async save() {
          saved = true
          return { episode: episode(), etag: 'W/"episode.saved"' }
        },
      },
    }),
    /does not belong to the active episode/,
  )
  assert.equal(saved, false)
})

test('reapply rejects an acknowledged response that did not persist the local intent', async () => {
  await assert.rejects(
    reapplyEpisodeRenderSettingsAfterRefresh({
      scope: { projectId: 'project-1', episodeId: 'episode-1' },
      localIntent: { stylePreset: '东方水墨', aspectRatio: '1:1' },
      transport: {
        async load() {
          return { episode: episode(), etag: 'W/"episode.latest"' }
        },
        async save() {
          return { episode: episode(), etag: 'W/"episode.invalid-success"' }
        },
      },
    }),
    /did not persist the requested intent/,
  )
})

test('authority bundle retries an ABA-visible Episode change instead of mixing Story with a new ETag', async () => {
  const episodeReads = [
    { episode: episode({ sourceRevisionId: 'story-1' }), revisionId: 'story-1', etag: 'W/"episode-a"' },
    // Visible render settings returned to A, but the opaque version advanced.
    { episode: episode({ sourceRevisionId: 'story-1' }), revisionId: 'story-1', etag: 'W/"episode-b"' },
    { episode: episode({ sourceRevisionId: 'story-1' }), revisionId: 'story-1', etag: 'W/"episode-b"' },
    { episode: episode({ sourceRevisionId: 'story-1' }), revisionId: 'story-1', etag: 'W/"episode-b"' },
  ]
  const storyEtags = ['W/"episode-a"', 'W/"episode-b"']
  let episodeIndex = 0
  let storyIndex = 0

  const bundle = await loadConsistentEpisodeRenderSettingsAuthority({
    scope: { projectId: 'project-1', episodeId: 'episode-1' },
    async loadEpisode() {
      return episodeReads[episodeIndex++]
    },
    async loadStory() {
      return {
        episodeId: 'episode-1',
        revisionId: 'story-1',
        story,
        etag: storyEtags[storyIndex++],
      }
    },
  })

  assert.equal(episodeIndex, 4)
  assert.equal(storyIndex, 2)
  assert.equal(bundle.etag, 'W/"episode-b"')
  assert.equal(bundle.story, story)
})

test('authority bundle fails closed when a stable Episode points to an unreadable Story', async () => {
  await assert.rejects(
    loadConsistentEpisodeRenderSettingsAuthority({
      scope: { projectId: 'project-1', episodeId: 'episode-1' },
      maxAttempts: 1,
      async loadEpisode() {
        return {
          episode: episode({ sourceRevisionId: 'story-1' }),
          revisionId: 'story-1',
          etag: 'W/"episode-current"',
        }
      },
      async loadStory() {
        return null
      },
    }),
    /Story revision that cannot be read/,
  )
})
