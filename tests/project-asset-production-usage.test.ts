import assert from 'node:assert/strict'
import test from 'node:test'

import { collectCurrentProductionAssetVersionIds } from '../src/features/assets/project-asset-production-usage'
import type { MediaAsset } from '../src/lib/api-types'

const CURRENT_REVISION = 'revision-current'

function asset(id: string, patch: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'storyboard.image',
    version: 1,
    status: 'ready',
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    durationSeconds: null,
    checksum: 'a'.repeat(64),
    source: 'provider',
    providerId: 'image-provider',
    generationJobId: 'job-1',
    sourceRevisionId: CURRENT_REVISION,
    parentAssetId: null,
    url: `/api/v1/assets/${id}/content`,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...patch,
  }
}

test('only sealed exact versions from the current project, episode, and Story revision are marked in use', () => {
  const current = asset('current')
  const assets = [
    current,
    asset('project-global', { episodeId: null, sourceRevisionId: null }),
    asset('project-current', { episodeId: null }),
    asset('project-historical', { episodeId: null, sourceRevisionId: 'revision-old' }),
    asset('project-not-referenced', { episodeId: null, sourceRevisionId: null }),
    asset('historical', { sourceRevisionId: 'revision-old' }),
    asset('unready', { status: 'stale' }),
    asset('unsealed', { checksum: null }),
    asset('other-episode', { episodeId: 'episode-2' }),
    asset('other-project', { projectId: 'project-2' }),
  ]

  assert.deepEqual(collectCurrentProductionAssetVersionIds({
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: CURRENT_REVISION,
    assets,
    referencedAssetVersionIds: [
      'historical',
      'current',
      'project-global',
      'project-current',
      'project-historical',
      'unready',
      'current',
      'unsealed',
      'other-episode',
      'other-project',
      'unknown',
      null,
      undefined,
    ],
  }), ['current', 'project-global', 'project-current'])
})

test('project-level versions require an explicit exact reference and never admit historical project revision drift', () => {
  const assets = [
    asset('global-null-revision', { episodeId: null, sourceRevisionId: null }),
    asset('global-current-revision', { episodeId: null }),
    asset('global-old-revision', { episodeId: null, sourceRevisionId: 'revision-old' }),
    asset('global-other-project', { projectId: 'project-2', episodeId: null, sourceRevisionId: null }),
  ]

  assert.deepEqual(collectCurrentProductionAssetVersionIds({
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: CURRENT_REVISION,
    assets,
    referencedAssetVersionIds: [
      'global-current-revision',
      'global-old-revision',
      'global-other-project',
    ],
  }), ['global-current-revision'])
})

test('missing immutable Story authority fails closed instead of borrowing a project default', () => {
  assert.deepEqual(collectCurrentProductionAssetVersionIds({
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: null,
    assets: [asset('current')],
    referencedAssetVersionIds: ['current'],
  }), [])
})
