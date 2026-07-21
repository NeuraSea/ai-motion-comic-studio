import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAssetVersionSwitcherState,
  createAssetDefaultVersionSwitch,
  createProductionAssetVersionPin,
  selectAssetVersion,
  type ProductionAssetVersionPin,
  type ProjectAssetVersion,
} from '../src/features/assets/asset-version-switcher-state'
import type { MediaAsset } from '../src/lib/api-types'

const NOW = '2026-07-15T00:00:00.000Z'

function mediaAsset(id: string, version: number, patch: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'character-turnaround',
    version,
    status: 'ready',
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    durationSeconds: null,
    checksum: String(version).repeat(64),
    source: 'provider',
    providerId: 'image-provider',
    generationJobId: `job-${version}`,
    sourceRevisionId: 'revision-current',
    parentAssetId: version === 1 ? null : `asset-version-${version - 1}`,
    url: `/api/v1/assets/${id}/content`,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  }
}

function assetVersion(version: number, patch: Partial<MediaAsset> = {}): ProjectAssetVersion {
  const assetVersionId = `asset-version-${version}`
  return {
    assetId: 'asset-character-ali',
    assetVersionId,
    versionNumber: version,
    asset: mediaAsset(assetVersionId, version, patch),
  }
}

test('stable handle ordering uses authoritative versionNumber rather than legacy MediaAsset.version', () => {
  const first = assetVersion(1)
  const second = assetVersion(2)
  first.asset.version = 99
  second.asset.version = 1
  const state = buildAssetVersionSwitcherState({
    assetId: 'asset-character-ali',
    versions: [first, second],
    defaultAssetVersionId: second.assetVersionId,
  })

  assert.deepEqual(state.versions.map((version) => version.assetVersionId), [
    second.assetVersionId,
    first.assetVersionId,
  ])
  assert.ok(!state.issues.some((issue) => issue.code === 'DUPLICATE_VERSION_NUMBER'))
})

test('one stable asset ID exposes immutable versions and switches preview without changing identity', () => {
  const state = buildAssetVersionSwitcherState({
    assetId: 'asset-character-ali',
    versions: [assetVersion(1), assetVersion(2), assetVersion(3)],
    defaultAssetVersionId: 'asset-version-2',
  })

  assert.deepEqual(state.versions.map((version) => version.assetVersionId), [
    'asset-version-3', 'asset-version-2', 'asset-version-1',
  ])
  assert.equal(state.selectedAssetVersionId, 'asset-version-2')

  const selected = selectAssetVersion(state, 'asset-version-3')
  assert.equal(selected.assetId, 'asset-character-ali')
  assert.equal(selected.defaultAssetVersionId, 'asset-version-2')
  assert.equal(selected.selectedAssetVersionId, 'asset-version-3')
})

test('changing the library default never silently rewrites an existing production pin', () => {
  const pin: ProductionAssetVersionPin = {
    slotId: 'character:ali:front',
    assetId: 'asset-character-ali',
    assetVersionId: 'asset-version-1',
    checksum: '1'.repeat(64),
  }
  const state = buildAssetVersionSwitcherState({
    assetId: 'asset-character-ali',
    versions: [assetVersion(1), assetVersion(2)],
    defaultAssetVersionId: 'asset-version-1',
    productionPins: [pin],
  })

  const mutation = createAssetDefaultVersionSwitch({
    state,
    assetVersionId: 'asset-version-2',
    assetHandleEtag: '"asset-handle-r7"',
  })
  assert.deepEqual(mutation, {
    assetId: 'asset-character-ali',
    assetVersionId: 'asset-version-2',
    ifMatch: '"asset-handle-r7"',
  })
  assert.deepEqual(state.productionPins, [pin])
  assert.deepEqual(state.versions.find((version) => version.assetVersionId === 'asset-version-1')?.pinnedSlots, [
    'character:ali:front',
  ])
})

test('production upgrade pins an exact version ID and checksum, not the current default pointer', () => {
  const state = buildAssetVersionSwitcherState({
    assetId: 'asset-character-ali',
    versions: [assetVersion(1), assetVersion(2)],
    defaultAssetVersionId: 'asset-version-1',
  })
  const pin = createProductionAssetVersionPin({
    state,
    slotId: 'shot:s0-sh1:character:ali',
    assetVersionId: 'asset-version-2',
  })

  assert.deepEqual(pin, {
    slotId: 'shot:s0-sh1:character:ali',
    assetId: 'asset-character-ali',
    assetVersionId: 'asset-version-2',
    checksum: '2'.repeat(64),
  })
})

test('missing or mismatched version identities fail closed instead of selecting a fallback', () => {
  const wrongId = assetVersion(2)
  wrongId.asset.id = 'another-media-asset'
  const state = buildAssetVersionSwitcherState({
    assetId: 'asset-character-ali',
    versions: [assetVersion(1), wrongId],
    defaultAssetVersionId: 'asset-version-missing',
    selectedAssetVersionId: 'asset-version-2',
  })

  assert.equal(state.defaultAssetVersionId, null)
  assert.equal(state.selectedAssetVersionId, null)
  assert.ok(state.issues.some((issue) => issue.code === 'INVALID_VERSION_IDENTITY'))
  assert.ok(state.issues.some((issue) => issue.code === 'DEFAULT_VERSION_MISSING'))
  assert.ok(state.issues.some((issue) => issue.code === 'SELECTED_VERSION_MISSING'))
})

test('unready or unchecksummed versions remain inspectable but cannot be switched or pinned', () => {
  const state = buildAssetVersionSwitcherState({
    assetId: 'asset-character-ali',
    versions: [assetVersion(1, { status: 'stale', checksum: null })],
    defaultAssetVersionId: 'asset-version-1',
  })

  assert.equal(state.versions[0]?.switchable, false)
  assert.equal(selectAssetVersion(state, 'asset-version-1'), state)
  assert.equal(createAssetDefaultVersionSwitch({
    state,
    assetVersionId: 'asset-version-1',
    assetHandleEtag: '"r1"',
  }), null)
  assert.equal(createProductionAssetVersionPin({
    state,
    slotId: 'shot:s0-sh1',
    assetVersionId: 'asset-version-1',
  }), null)
})

test('a production pin with a checksum mismatch is rejected from display state', () => {
  const state = buildAssetVersionSwitcherState({
    assetId: 'asset-character-ali',
    versions: [assetVersion(1)],
    defaultAssetVersionId: 'asset-version-1',
    productionPins: [{
      slotId: 'shot:s0-sh1',
      assetId: 'asset-character-ali',
      assetVersionId: 'asset-version-1',
      checksum: 'f'.repeat(64),
    }],
  })

  assert.deepEqual(state.productionPins, [])
  assert.ok(state.issues.some((issue) => issue.code === 'INVALID_PRODUCTION_PIN'))
})
