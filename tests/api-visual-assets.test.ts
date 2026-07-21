import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiError, listVisualAssetTargets } from '../src/lib/api'

test('visual asset client addresses the episode graph and validates normalized targets', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input) => {
    calls.push(String(input))
    return new Response(JSON.stringify({
      episodeId: 'episode-1',
      sourceRevisionId: 'story-revision-1',
      targets: [{
        type: 'character',
        id: 'hero',
        name: '阿离',
        description: '年轻剑客',
        visualDescription: '黑发红绳青袍',
        role: '主角',
        version: 1,
        lockedAssetId: null,
      }],
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  try {
    const result = await listVisualAssetTargets('project-1', 'episode-1')
    assert.equal(result.targets[0]?.name, '阿离')
    assert.deepEqual(calls, [
      '/api/v1/episodes/episode-1/visual-asset-targets?projectId=project-1',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('visual asset client rejects an unrecognized target type', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    episodeId: 'episode-1',
    sourceRevisionId: 'story-revision-1',
    targets: [{
      type: 'fake-character',
      id: 'hero',
      name: '阿离',
      description: '',
      visualDescription: '',
      role: null,
      version: 1,
      lockedAssetId: null,
    }],
  }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch

  try {
    await assert.rejects(
      listVisualAssetTargets('project-1', 'episode-1'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
