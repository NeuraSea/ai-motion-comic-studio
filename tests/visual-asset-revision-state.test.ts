import assert from 'node:assert/strict'
import test from 'node:test'

import type { GenerationJob, MediaAsset } from '../src/lib/api-types'
import {
  lockedVisualAssetRevisionState,
  summarizeCharacterVisualReferenceSlots,
  visualAssetDisplayCandidate,
} from '../src/features/assets/visual-asset-revision-state'

const NOW = '2026-07-15T00:00:00.000Z'

function asset(input: Partial<MediaAsset> & Pick<MediaAsset, 'id'>): MediaAsset {
  return {
    id: input.id,
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'character-turnaround',
    version: 1,
    status: 'ready',
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    durationSeconds: null,
    checksum: 'a'.repeat(64),
    source: 'provider',
    providerId: 'image-provider',
    generationJobId: 'job-1',
    sourceRevisionId: 'revision-current',
    parentAssetId: null,
    url: `/api/v1/assets/${input.id}/content`,
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  }
}

function job(input: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'job-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'asset.image.generate',
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    input: {
      assetEntityBinding: {
        entityType: 'character',
        entityId: 'ali',
        expectedRevisionId: 'revision-current',
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  }
}

test('a Story revision change keeps an owned paid candidate visible but makes it non-actionable', () => {
  const historicalJob = job({
    input: {
      assetEntityBinding: {
        entityType: 'character',
        entityId: 'ali',
        expectedRevisionId: 'revision-old',
      },
    },
  })
  const candidate = visualAssetDisplayCandidate({
    asset: asset({ id: 'candidate-old', sourceRevisionId: 'revision-old' }),
    job: historicalJob,
    projectId: 'project-1',
    episodeId: 'episode-1',
    targetType: 'character',
    targetId: 'ali',
    currentSourceRevisionId: 'revision-current',
  })

  assert.equal(candidate?.revisionState, 'historical')
  assert.equal(candidate?.usableAsCurrentReference, false)
})

test('candidate history cannot expose an arbitrary image from another entity', () => {
  assert.equal(visualAssetDisplayCandidate({
    asset: asset({ id: 'candidate-other' }),
    job: job(),
    projectId: 'project-1',
    episodeId: 'episode-1',
    targetType: 'location',
    targetId: 'cliff',
    currentSourceRevisionId: 'revision-current',
  }), null)
})

test('an old persisted lock remains inspectable without becoming a current reference', () => {
  const old = asset({ id: 'locked-old', sourceRevisionId: 'revision-old' })
  assert.deepEqual(lockedVisualAssetRevisionState({
    lockedAssetId: old.id,
    assets: [old],
    projectId: 'project-1',
    episodeId: 'episode-1',
    currentSourceRevisionId: 'revision-current',
  }), {
    asset: old,
    state: 'historical',
    usableAsCurrentReference: false,
  })
})

test('three non-null historical turnaround slots count as zero current slots', () => {
  const references = {
    frontAssetId: 'front-old',
    sideAssetId: 'side-old',
    backAssetId: 'back-old',
  }
  const assets = (['front', 'side', 'back'] as const).map((role) => asset({
    id: `${role}-old`,
    kind: `character-reference.${role}`,
    source: 'derived',
    providerId: null,
    sourceRevisionId: 'revision-old',
  }))
  const summary = summarizeCharacterVisualReferenceSlots({
    references,
    assets,
    projectId: 'project-1',
    episodeId: 'episode-1',
    currentSourceRevisionId: 'revision-current',
  })

  assert.equal(summary.currentCount, 0)
  assert.equal(summary.historicalCount, 3)
  assert.equal(summary.missingCount, 0)
  assert.deepEqual(Object.values(summary.slots).map((slot) => slot.state), [
    'historical', 'historical', 'historical',
  ])
})

test('only complete owned current front/side/back assets satisfy slot readiness', () => {
  const references = {
    frontAssetId: 'front-current',
    sideAssetId: 'side-current',
    backAssetId: 'back-current',
  }
  const assets = (['front', 'side', 'back'] as const).map((role) => asset({
    id: `${role}-current`,
    kind: `character-reference.${role}`,
    source: 'derived',
    providerId: null,
  }))
  const summary = summarizeCharacterVisualReferenceSlots({
    references,
    assets,
    projectId: 'project-1',
    episodeId: 'episode-1',
    currentSourceRevisionId: 'revision-current',
  })

  assert.equal(summary.currentCount, 3)
  assert.equal(summary.historicalCount, 0)
  assert.equal(summary.invalidCount, 0)
})
