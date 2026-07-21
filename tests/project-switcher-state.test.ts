import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_RECENT_PRODUCTION_EPISODES,
  parseProjectSwitcherMemory,
  rememberProductionWorkspace,
  serializeProjectSwitcherMemory,
  workspaceLocationForEpisode,
} from '../src/features/catalog/project-switcher-state'

test('project switcher remembers independent stage and shot locations per episode', () => {
  let memory = parseProjectSwitcherMemory(null)
  memory = rememberProductionWorkspace(memory, {
    projectId: 'project-a',
    episodeId: 'episode-1',
    stage: 'storyboard',
    storyShotId: 'shot-4',
    now: '2026-07-15T10:00:00.000Z',
    markRecent: true,
  })
  memory = rememberProductionWorkspace(memory, {
    projectId: 'project-b',
    episodeId: 'episode-1',
    stage: 'audio',
    storyShotId: 'shot-2',
    now: '2026-07-15T11:00:00.000Z',
    markRecent: true,
  })

  assert.deepEqual(workspaceLocationForEpisode(memory, 'project-a', 'episode-1'), {
    projectId: 'project-a',
    episodeId: 'episode-1',
    stage: 'storyboard',
    storyShotId: 'shot-4',
    updatedAt: '2026-07-15T10:00:00.000Z',
  })
  assert.equal(workspaceLocationForEpisode(memory, 'project-b', 'episode-1')?.stage, 'audio')
  assert.deepEqual(memory.recentEpisodes.map(({ projectId, episodeId }) => ({ projectId, episodeId })), [
    { projectId: 'project-b', episodeId: 'episode-1' },
    { projectId: 'project-a', episodeId: 'episode-1' },
  ])
})

test('stage-only updates preserve the last selected Story shot', () => {
  const first = rememberProductionWorkspace(parseProjectSwitcherMemory(null), {
    projectId: 'project-a',
    episodeId: 'episode-1',
    stage: 'storyboard',
    storyShotId: 'story-shot-7',
    now: '2026-07-15T10:00:00.000Z',
  })
  const next = rememberProductionWorkspace(first, {
    projectId: 'project-a',
    episodeId: 'episode-1',
    stage: 'export',
    now: '2026-07-15T10:01:00.000Z',
  })

  assert.equal(workspaceLocationForEpisode(next, 'project-a', 'episode-1')?.stage, 'export')
  assert.equal(workspaceLocationForEpisode(next, 'project-a', 'episode-1')?.storyShotId, 'story-shot-7')
})

test('recent episodes are deduplicated, bounded and survive serialization', () => {
  let memory = parseProjectSwitcherMemory(null)
  for (let index = 0; index < MAX_RECENT_PRODUCTION_EPISODES + 3; index += 1) {
    memory = rememberProductionWorkspace(memory, {
      projectId: 'project-a',
      episodeId: `episode-${index}`,
      stage: 'source',
      now: `2026-07-15T10:${String(index).padStart(2, '0')}:00.000Z`,
      markRecent: true,
    })
  }
  memory = rememberProductionWorkspace(memory, {
    projectId: 'project-a',
    episodeId: 'episode-7',
    stage: 'script',
    now: '2026-07-15T12:00:00.000Z',
    markRecent: true,
  })

  const restored = parseProjectSwitcherMemory(serializeProjectSwitcherMemory(memory))
  assert.equal(restored.recentEpisodes.length, MAX_RECENT_PRODUCTION_EPISODES)
  assert.equal(restored.recentEpisodes[0]?.episodeId, 'episode-7')
  assert.equal(restored.recentEpisodes.filter((entry) => entry.episodeId === 'episode-7').length, 1)
})

test('invalid browser storage is ignored without accepting invalid production routes', () => {
  const memory = parseProjectSwitcherMemory(JSON.stringify({
    version: 1,
    workspaces: {
      bad: {
        projectId: 'project-a',
        episodeId: 'episode-a',
        stage: 'catalog-assets',
        storyShotId: null,
        updatedAt: '2026-07-15T10:00:00.000Z',
      },
    },
    recentEpisodes: [{ projectId: '', episodeId: 'episode-a', openedAt: 'not-a-date' }],
  }))

  assert.deepEqual(memory.workspaces, {})
  assert.deepEqual(memory.recentEpisodes, [])
})
