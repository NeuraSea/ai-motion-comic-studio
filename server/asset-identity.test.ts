import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import { initializeDatabase } from './database.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

interface Fixture {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
}

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await new Promise<void>((resolve, reject) => item.server.close((error) => error ? reject(error) : resolve()))
    await item.runtime.close()
    await rm(item.directory, { recursive: true, force: true })
  }
})

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-asset-identity-'))
  const runtime = await createApplication({
    runtimeDirectory: directory,
    autoStartWorker: false,
    enforcePaidAigcConfirmation: true,
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
  })
  const server = createServer(runtime.app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  const value = {
    directory,
    runtime,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
  fixtures.push(value)
  return value
}

async function json<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init)
  const body = await response.json() as T
  return { response, body }
}

async function seedVersions(runtime: ApplicationRuntime) {
  runtime.storyRepository.ensureEpisode('default', {
    id: 'identity-episode',
    title: '素材版本测试',
    aspectRatio: '16:9',
    stylePreset: '国风动画',
  })
  const first = await runtime.mediaStore.save({
    id: 'character-ali-v1',
    projectId: 'default',
    episodeId: 'identity-episode',
    kind: 'character-turnaround',
    version: 7,
    bytes: PNG,
    mimeType: 'image/png',
    source: 'upload',
    generationParameters: { entityType: 'character', entityId: 'ali' },
    width: 1,
    height: 1,
  })
  const second = await runtime.mediaStore.save({
    id: 'character-ali-v2',
    projectId: 'default',
    episodeId: 'identity-episode',
    kind: 'character-turnaround',
    // Deliberately repeats the legacy local version. The new membership
    // versionNumber, not MediaAsset.version, is authoritative.
    version: 7,
    bytes: PNG,
    mimeType: 'image/png',
    source: 'provider',
    generationParameters: {
      assetFamilyId: first.id,
      entityType: 'character',
      entityId: 'ali',
    },
    parentAssetId: first.id,
    width: 1,
    height: 1,
  })
  const derived = await runtime.mediaStore.save({
    id: 'character-ali-front',
    projectId: 'default',
    episodeId: 'identity-episode',
    kind: 'character-reference.front',
    bytes: PNG,
    mimeType: 'image/png',
    source: 'derived',
    generationParameters: { operation: 'asset.image.turnaround.derive' },
    parentAssetId: first.id,
    width: 1,
    height: 1,
  })
  const third = await runtime.mediaStore.save({
    id: 'character-ali-v3',
    projectId: 'default',
    episodeId: 'identity-episode',
    kind: 'character-turnaround',
    version: 8,
    bytes: PNG,
    mimeType: 'image/png',
    source: 'provider',
    // A producer may hold any exact version ID. Registration must resolve it
    // through membership instead of silently starting a second handle.
    generationParameters: {
      assetFamilyId: second.id,
      entityType: 'character',
      entityId: 'ali',
    },
    parentAssetId: second.id,
    width: 1,
    height: 1,
  })
  return { first, second, third, derived }
}

test('stable Asset handle lists immutable versions and resolves a flat version ID', async () => {
  const { runtime, baseUrl } = await fixture()
  const seeded = await seedVersions(runtime)

  const listed = await json<{
    assets: Array<{
      assetId: string
      currentAssetVersionId: string
      versionCount: number
      revision: number
      currentVersion: { id: string }
      businessBinding: {
        domain: string
        groupKey: string
        groupLabel: string
        episodeId: string | null
        entityType: string | null
        entityId: string | null
      }
    }>
  }>(`${baseUrl}/api/v1/projects/default/asset-handles?episodeId=identity-episode`)
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body))
  const family = listed.body.assets.find((asset) => asset.assetId === seeded.first.id)
  assert.ok(family)
  assert.equal(family.currentAssetVersionId, seeded.third.id)
  assert.equal(family.currentVersion.id, seeded.third.id)
  assert.equal(family.versionCount, 3)
  assert.equal(family.revision, 3)
  assert.deepEqual(family.businessBinding, {
    domain: 'character',
    groupKey: 'character:ali',
    groupLabel: '角色 ali',
    episodeId: 'identity-episode',
    sceneId: null,
    shotId: null,
    lineId: null,
    entityType: 'character',
    entityId: 'ali',
    role: null,
  })

  const resolved = await json<{ assets: Array<{ assetId: string }> }>(
    `${baseUrl}/api/v1/projects/default/asset-handles?assetVersionId=${seeded.second.id}`,
  )
  assert.deepEqual(resolved.body.assets.map((asset) => asset.assetId), [seeded.first.id])

  // parent_asset_id on a derived crop is provenance, not a version edge.
  const derived = await json<{ assets: Array<{ assetId: string; versionCount: number }> }>(
    `${baseUrl}/api/v1/projects/default/asset-handles?assetVersionId=${seeded.derived.id}`,
  )
  assert.equal(derived.body.assets.length, 1)
  assert.equal(derived.body.assets[0]?.assetId, seeded.derived.id)
  assert.equal(derived.body.assets[0]?.versionCount, 1)

  const versions = await json<{
    asset: { assetId: string; currentAssetVersionId: string; etag: string }
    versions: Array<{ assetVersionId: string; versionNumber: number; version: { version: number } }>
  }>(`${baseUrl}/api/v1/projects/default/asset-handles/${seeded.first.id}/versions`)
  assert.equal(versions.response.status, 200)
  assert.equal(versions.response.headers.get('etag'), versions.body.asset.etag)
  assert.deepEqual(versions.body.versions.map((version) => ({
    id: version.assetVersionId,
    number: version.versionNumber,
    legacy: version.version.version,
  })), [
    { id: seeded.third.id, number: 3, legacy: 8 },
    { id: seeded.second.id, number: 2, legacy: 7 },
    { id: seeded.first.id, number: 1, legacy: 7 },
  ])
})

test('switches the project default version with ETag, idempotency and immutable audit only', async () => {
  const { runtime, baseUrl } = await fixture()
  const seeded = await seedVersions(runtime)
  runtime.database.withSql((sql) => sql.run(`
    INSERT INTO characters (
      id, project_id, episode_id, name, locked_asset_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  'locked-character',
  'default',
  'identity-episode',
  '阿离',
  seeded.third.id,
  '2026-07-15T00:00:00.000Z',
  '2026-07-15T00:00:00.000Z',
  ))
  const versions = await json<{ asset: { etag: string } }>(
    `${baseUrl}/api/v1/projects/default/asset-handles/${seeded.first.id}/versions`,
  )
  const jobsBefore = runtime.database.listGenerationJobs({ projectId: 'default', limit: 1000 }).length
  const submit = (assetVersionId: string, etag = versions.body.asset.etag, key = 'switch-ali-to-v1') => json<{
    asset: { assetId: string; currentAssetVersionId: string; revision: number; etag: string }
    switch: {
      id: string
      previousAssetVersionId: string
      selectedAssetVersionId: string
      changed: boolean
      idempotent: boolean
      providerCallRequired: boolean
    }
  }>(`${baseUrl}/api/v1/projects/default/asset-handles/${seeded.first.id}/current-version`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': etag,
      'idempotency-key': key,
    },
    body: JSON.stringify({ assetVersionId }),
  })

  const switched = await submit(seeded.first.id)
  assert.equal(switched.response.status, 201, JSON.stringify(switched.body))
  assert.equal(switched.body.asset.currentAssetVersionId, seeded.first.id)
  assert.equal(switched.body.asset.revision, 4)
  assert.equal(switched.body.switch.previousAssetVersionId, seeded.third.id)
  assert.equal(switched.body.switch.selectedAssetVersionId, seeded.first.id)
  assert.equal(switched.body.switch.changed, true)
  assert.equal(switched.body.switch.idempotent, false)
  assert.equal(switched.body.switch.providerCallRequired, false)
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default', limit: 1000 }).length, jobsBefore)
  assert.equal(runtime.database.withSql((sql) => sql.get(`
    SELECT locked_asset_id FROM characters WHERE id = 'locked-character'
  `))?.locked_asset_id, seeded.third.id)
  assert.equal(runtime.database.withSql((sql) => sql.get(`
    SELECT count(*) AS count FROM asset_version_switches
  `))?.count, 1)

  const replay = await submit(seeded.first.id)
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.switch.id, switched.body.switch.id)
  assert.equal(replay.body.switch.idempotent, true)

  const conflict = await submit(seeded.second.id)
  assert.equal(conflict.response.status, 409)
  assert.equal((conflict.body as unknown as { error: { code: string } }).error.code, 'IDEMPOTENCY_CONFLICT')

  const stale = await submit(seeded.second.id, versions.body.asset.etag, 'switch-with-stale-etag')
  assert.equal(stale.response.status, 412)
  assert.equal((stale.body as unknown as { error: { code: string } }).error.code, 'PRECONDITION_FAILED')
})

test('one-way seals a staged checksum and rejects a later checksum drift', async () => {
  const { runtime, baseUrl } = await fixture()
  runtime.database.createMediaAsset({
    id: 'staged-version',
    projectId: 'default',
    kind: 'generated.image',
    status: 'pending',
    source: 'provider',
  })
  assert.equal(runtime.database.withSql((sql) => sql.get(`
    SELECT checksum FROM asset_handle_versions WHERE asset_version_id = 'staged-version'
  `))?.checksum, null)
  runtime.database.updateMediaAsset('staged-version', {
    checksum: 'a'.repeat(64),
    status: 'ready',
  })
  assert.equal(runtime.database.withSql((sql) => sql.get(`
    SELECT checksum FROM asset_handle_versions WHERE asset_version_id = 'staged-version'
  `))?.checksum, 'a'.repeat(64))
  assert.throws(() => runtime.database.withSql((sql) => sql.run(`
    UPDATE asset_handle_versions SET checksum = ? WHERE asset_version_id = 'staged-version'
  `, 'b'.repeat(64))), /asset versions are immutable/)

  // An internal corruption cannot be selected: the sealed membership remains
  // authoritative even if a legacy caller mutates media_assets directly.
  runtime.database.updateMediaAsset('staged-version', { checksum: 'c'.repeat(64) })
  const versions = await json<{ asset: { etag: string } }>(
    `${baseUrl}/api/v1/projects/default/asset-handles/staged-version/versions`,
  )
  const rejected = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/projects/default/asset-handles/staged-version/current-version`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': versions.body.asset.etag,
        'idempotency-key': 'reject-drifted-version',
      },
      body: JSON.stringify({ assetVersionId: 'staged-version' }),
    },
  )
  assert.equal(rejected.response.status, 409)
  assert.equal(rejected.body.error.code, 'ASSET_VERSION_UNUSABLE')
})

test('a staged family version does not replace a usable default until its checksum is sealed', async () => {
  const { runtime } = await fixture()
  const first = await runtime.mediaStore.save({
    id: 'usable-family-v1',
    projectId: 'default',
    kind: 'generated.image',
    bytes: PNG,
    mimeType: 'image/png',
    source: 'upload',
  })
  runtime.database.createMediaAsset({
    id: 'pending-family-v2',
    projectId: 'default',
    kind: 'generated.image',
    status: 'pending',
    source: 'provider',
    generationParameters: { assetFamilyId: first.id },
  })
  assert.equal(runtime.database.withSql((sql) => sql.get(`
    SELECT current_asset_version_id FROM asset_handles WHERE id = ?
  `, first.id))?.current_asset_version_id, first.id)

  runtime.database.updateMediaAsset('pending-family-v2', {
    checksum: 'd'.repeat(64),
    status: 'ready',
  })
  assert.equal(runtime.database.withSql((sql) => sql.get(`
    SELECT current_asset_version_id FROM asset_handles WHERE id = ?
  `, first.id))?.current_asset_version_id, 'pending-family-v2')
})

test('deleting the current version leaves the stable handle unselected when no usable version survives', async () => {
  const { runtime } = await fixture()
  runtime.database.createMediaAsset({
    id: 'delete-family-v1',
    projectId: 'default',
    kind: 'generated.image',
    version: 1,
    status: 'ready',
    checksum: 'e'.repeat(64),
    source: 'provider',
  })
  runtime.database.createMediaAsset({
    id: 'delete-family-v2',
    projectId: 'default',
    kind: 'generated.image',
    version: 2,
    status: 'ready',
    checksum: 'f'.repeat(64),
    source: 'provider',
    generationParameters: { assetFamilyId: 'delete-family-v1' },
  })
  runtime.database.updateMediaAsset('delete-family-v1', { status: 'stale' })

  assert.equal(runtime.database.deleteMediaAsset('delete-family-v2'), true)
  const handle = runtime.database.withSql((sql) => sql.get(`
    SELECT id, current_asset_version_id
    FROM asset_handles
    WHERE id = 'delete-family-v1'
  `))
  assert.deepEqual(handle ? { ...handle } : handle, {
    id: 'delete-family-v1',
    current_asset_version_id: null,
  })
  assert.deepEqual(runtime.database.withSql((sql) => sql.all(`
    SELECT asset_version_id
    FROM asset_handle_versions
    WHERE asset_id = 'delete-family-v1'
  `)).map((row) => ({ ...row })), [
    { asset_version_id: 'delete-family-v1' },
  ])
})

test('v15 backfill preserves MediaAsset IDs, groups explicit families and prefers a usable current version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-asset-identity-migration-'))
  const path = join(directory, 'manju.sqlite')
  try {
    let database = initializeDatabase({ runtimeDirectory: directory, legacyStatePath: false })
    database.createProject({ id: 'migration-project', title: '迁移测试' })
    database.createMediaAsset({
      id: 'migration-v1',
      projectId: 'migration-project',
      kind: 'character-turnaround',
      version: 1,
      status: 'ready',
      checksum: 'a'.repeat(64),
      source: 'provider',
    })
    database.createMediaAsset({
      id: 'migration-v2-stale',
      projectId: 'migration-project',
      kind: 'character-turnaround',
      version: 2,
      status: 'stale',
      checksum: 'b'.repeat(64),
      source: 'provider',
      generationParameters: { assetFamilyId: 'migration-v1' },
      parentAssetId: 'migration-v1',
    })
    database.createMediaAsset({
      id: 'migration-v3-chain',
      projectId: 'migration-project',
      kind: 'character-turnaround',
      version: 3,
      status: 'ready',
      checksum: 'c'.repeat(64),
      source: 'provider',
      generationParameters: { assetFamilyId: 'migration-v2-stale' },
      parentAssetId: 'migration-v2-stale',
    })
    database.createMediaAsset({
      id: 'migration-invalid-v1',
      projectId: 'migration-project',
      kind: 'location-concept',
      version: 1,
      status: 'stale',
      checksum: 'd'.repeat(64),
      source: 'provider',
    })
    database.createMediaAsset({
      id: 'migration-invalid-v2',
      projectId: 'migration-project',
      kind: 'location-concept',
      version: 2,
      status: 'pending',
      source: 'provider',
      generationParameters: { assetFamilyId: 'migration-invalid-v1' },
      parentAssetId: 'migration-invalid-v1',
    })
    database.close()

    const v14 = new DatabaseSync(path)
    v14.exec(`
      DROP TRIGGER media_assets_register_asset_identity;
      DROP TRIGGER media_assets_repair_asset_identity_before_delete;
      DROP TRIGGER media_assets_seal_asset_identity_checksum;
      DROP TRIGGER media_assets_publish_asset_identity_current;
      DROP TRIGGER asset_handle_versions_no_update;
      DROP TRIGGER asset_version_switches_no_update;
      DROP TRIGGER asset_version_switches_no_delete;
      DROP TABLE asset_version_switches;
      DROP TABLE asset_handle_versions;
      DROP TABLE asset_handles;
      PRAGMA user_version = 14;
    `)
    v14.close()

    database = initializeDatabase({ runtimeDirectory: directory, legacyStatePath: false })
    try {
      const handle = database.withSql((sql) => sql.get(`
        SELECT id, current_asset_version_id
        FROM asset_handles
        WHERE id = 'migration-v1'
      `))
      assert.deepEqual(handle ? { ...handle } : handle, {
        id: 'migration-v1',
        current_asset_version_id: 'migration-v3-chain',
      })
      assert.deepEqual(database.withSql((sql) => sql.all(`
        SELECT asset_version_id, version_number
        FROM asset_handle_versions
        WHERE asset_id = 'migration-v1'
        ORDER BY version_number
      `)).map((row) => ({ ...row })), [
        { asset_version_id: 'migration-v1', version_number: 1 },
        { asset_version_id: 'migration-v2-stale', version_number: 2 },
        { asset_version_id: 'migration-v3-chain', version_number: 3 },
      ])
      const invalidHandle = database.withSql((sql) => sql.get(`
        SELECT id, current_asset_version_id
        FROM asset_handles
        WHERE id = 'migration-invalid-v1'
      `))
      assert.deepEqual(invalidHandle ? { ...invalidHandle } : invalidHandle, {
        id: 'migration-invalid-v1',
        current_asset_version_id: null,
      })
      assert.deepEqual(database.withSql((sql) => sql.all(`
        SELECT asset_version_id, version_number
        FROM asset_handle_versions
        WHERE asset_id = 'migration-invalid-v1'
        ORDER BY version_number
      `)).map((row) => ({ ...row })), [
        { asset_version_id: 'migration-invalid-v1', version_number: 1 },
        { asset_version_id: 'migration-invalid-v2', version_number: 2 },
      ])
      assert.ok(database.getMediaAsset('migration-v1'))
      assert.ok(database.getMediaAsset('migration-v2-stale'))
      assert.ok(database.getMediaAsset('migration-v3-chain'))
    } finally {
      database.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
