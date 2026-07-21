import assert from 'node:assert/strict'
import test from 'node:test'

import type { GenerationJob, MediaAsset } from '../src/lib/api-types'
import {
  visualAssetCandidateProvenance,
  visualAssetJobBinding,
  visualAssetJobProvenance,
} from '../src/features/assets/visual-asset-job-state'

function job(type: string, input: Record<string, unknown>): GenerationJob {
  return {
    id: `${type}-job`,
    projectId: 'project-1',
    episodeId: 'episode-1',
    type,
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    input,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:01.000Z',
  }
}

const binding = {
  entityType: 'character',
  entityId: 'ali',
  expectedRevisionId: 'revision-1',
}

test('generate, edit, and local turnaround jobs share the server-authored entity binding', () => {
  assert.deepEqual(visualAssetJobBinding(job('asset.image.generate', {
    assetEntityBinding: binding,
  })), binding)
  assert.deepEqual(visualAssetJobBinding(job('asset.image.edit', {
    assetEntityBinding: binding,
  })), binding)
  assert.deepEqual(visualAssetJobBinding(job('asset.image.turnaround.derive', {
    assetEntityBinding: binding,
  })), binding)
})

test('edit provenance requires a consistent durable source and reference snapshots', () => {
  const current = job('asset.image.edit', {
    operation: 'asset.image.edit',
    sourceAssetId: 'source-1',
    assetEntityBinding: binding,
    editBinding: {
      mode: 'edit',
      source: { assetId: 'source-1' },
      references: [{ assetId: 'ref-1' }, { assetId: 'ref-2' }],
    },
  })
  assert.deepEqual(visualAssetJobProvenance(current), {
    operation: 'edit',
    sourceAssetId: 'source-1',
    referenceAssetIds: ['ref-1', 'ref-2'],
  })
  assert.equal(visualAssetJobProvenance(job('asset.image.edit', {
    ...current.input,
    sourceAssetId: 'drifted',
  })), null)
})

test('a legacy parentAssetId never masquerades as Provider image input', () => {
  const asset = {
    id: 'candidate-2',
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'character-turnaround',
    version: 2,
    status: 'ready',
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    durationSeconds: null,
    checksum: 'a'.repeat(64),
    source: 'provider',
    providerId: 'codex-tools-image',
    generationJobId: 'legacy-regenerate',
    sourceRevisionId: 'revision-1',
    parentAssetId: 'candidate-1',
    url: '/api/v1/assets/candidate-2/content',
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  } satisfies MediaAsset
  assert.deepEqual(visualAssetCandidateProvenance(asset, job('asset.image.generate', {
    assetEntityBinding: binding,
  })), {
    operation: 'generate',
    sourceAssetId: null,
    referenceAssetIds: [],
  })
})
