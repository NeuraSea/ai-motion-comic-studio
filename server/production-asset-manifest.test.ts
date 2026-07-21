import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import { episodeEtag } from './episode-version.js'
import {
  ProductionAssetManifestError,
  ProductionAssetManifestService,
} from './production-asset-manifest.js'

function fixture(): {
  database: ManjuDatabase
  service: ProductionAssetManifestService
  etag: () => string
} {
  const database = initializeDatabase({
    databasePath: ':memory:',
    legacyStatePath: false,
    backupDirectory: false,
  })
  database.createProject({ id: 'project-1', title: 'Production manifest' })
  const source = database.createRevision({
    id: 'source-r1',
    projectId: 'project-1',
    summary: '源剧本',
    snapshot: { version: 1 },
  })
  database.updateProject('project-1', { currentRevisionId: source.id })
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, aspect_ratio, style_preset, status,
        sort_order, metadata_json, source_revision_id, created_at, updated_at
      ) VALUES (
        'episode-1', 'project-1', '第一集', '', '16:9', '', 'draft', 0, '{}',
        'source-r1', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
      )
    `)
    sql.run(`
      INSERT INTO characters (
        id, project_id, episode_id, name, story_description, visual_description,
        version, metadata_json, created_at, updated_at
      ) VALUES (
        'character-1', 'project-1', 'episode-1', '阿离', '', '', 1,
        '{"voiceProfileRevisionId":"voice-r1"}',
        '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
      )
    `)
  })
  database.createMediaAsset({
    id: 'character-v1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'character.turnaround',
    status: 'ready',
    source: 'fixture',
    checksum: 'a'.repeat(64),
    mimeType: 'image/png',
    sourceRevisionId: 'source-r1',
  })
  database.withSql((sql) => sql.run(`
    UPDATE characters SET locked_asset_id = 'character-v1' WHERE id = 'character-1'
  `))
  const service = new ProductionAssetManifestService({
    database,
    timelines: { get: () => undefined },
    now: () => '2026-07-15T01:00:00.000Z',
    idFactory: (() => {
      let sequence = 0
      return () => `manifest-${++sequence}`
    })(),
  })
  return {
    database,
    service,
    etag: () => {
      const row = database.withSql((sql) => sql.get(`
        SELECT source_revision_id, updated_at FROM episodes WHERE id = 'episode-1'
      `))!
      return episodeEtag({
        sourceRevisionId: row.source_revision_id as string,
        updatedAt: row.updated_at as string,
      })
    },
  }
}

test('Production Asset Manifest stores immutable stable and exact Asset identities', () => {
  const context = fixture()
  try {
    const projected = context.service.projection('project-1', 'episode-1')
    assert.equal(projected.status, 'missing')
    assert.equal(projected.blockers.length, 0)
    assert.deepEqual(projected.entries.map((entry) => ({
      slotKey: entry.slotKey,
      assetId: entry.assetId,
      assetVersionId: entry.assetVersionId,
      versionNumber: entry.versionNumber,
      checksum: entry.checksum,
    })), [{
      slotKey: 'character:character-1:primary',
      assetId: 'character-v1',
      assetVersionId: 'character-v1',
      versionNumber: 1,
      checksum: 'a'.repeat(64),
    }])

    const first = context.service.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      ifMatch: context.etag(),
      idempotencyKey: 'manifest-request-1',
    })
    assert.equal(first.idempotent, false)
    assert.equal(first.manifest.revisionNumber, 1)
    assert.equal(first.manifest.parentManifestId, null)
    assert.equal(first.manifest.context.sourceRevisionId, 'source-r1')
    assert.equal(context.service.projection('project-1', 'episode-1').status, 'current')

    const replay = context.service.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      ifMatch: context.etag(),
      idempotencyKey: 'manifest-request-1',
    })
    assert.equal(replay.idempotent, true)
    assert.equal(replay.manifest.id, first.manifest.id)

    assert.throws(() => context.database.withSql((sql) => sql.run(`
      UPDATE production_asset_manifests SET summary = 'tampered' WHERE id = ?
    `, first.manifest.id)), /production asset manifests are immutable/)
    assert.throws(() => context.database.withSql((sql) => sql.run(`
      UPDATE production_asset_manifest_entries SET role = 'tampered' WHERE manifest_id = ?
    `, first.manifest.id)), /production asset manifest entries are immutable/)
    assert.throws(() => context.database.withSql((sql) => sql.run(`
      DELETE FROM production_asset_manifests WHERE id = ?
    `, first.manifest.id)), /production asset manifests are immutable/)
  } finally {
    context.database.close()
  }
})

test('Production Asset Manifest detects drift, chains revisions, and rejects idempotency reuse', () => {
  const context = fixture()
  try {
    const first = context.service.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      ifMatch: context.etag(),
      idempotencyKey: 'manifest-request-1',
    })
    context.database.createMediaAsset({
      id: 'character-v2',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'character.turnaround',
      status: 'ready',
      source: 'fixture',
      checksum: 'b'.repeat(64),
      mimeType: 'image/png',
      sourceRevisionId: 'source-r1',
      generationParameters: { assetFamilyId: 'character-v1' },
    })
    context.database.withSql((sql) => sql.run(`
      UPDATE characters SET locked_asset_id = 'character-v2' WHERE id = 'character-1'
    `))
    assert.equal(context.service.projection('project-1', 'episode-1').status, 'changed')
    assert.throws(() => context.service.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      ifMatch: context.etag(),
      idempotencyKey: 'manifest-request-1',
    }), (error: unknown) => (
      error instanceof ProductionAssetManifestError && error.code === 'IDEMPOTENCY_CONFLICT'
    ))

    const second = context.service.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      ifMatch: context.etag(),
      idempotencyKey: 'manifest-request-2',
    })
    assert.equal(second.manifest.revisionNumber, 2)
    assert.equal(second.manifest.parentManifestId, first.manifest.id)
    assert.equal(second.manifest.entries[0]?.assetId, 'character-v1')
    assert.equal(second.manifest.entries[0]?.assetVersionId, 'character-v2')
    assert.equal(second.manifest.entries[0]?.versionNumber, 2)
    assert.deepEqual(context.service.history('project-1', 'episode-1').map((item) => item.id), [
      second.manifest.id,
      first.manifest.id,
    ])
  } finally {
    context.database.close()
  }
})

test('Production Asset Manifest blocks unsealed and cross-Episode references', () => {
  const context = fixture()
  try {
    context.database.withSql((sql) => sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, aspect_ratio, style_preset, status,
        sort_order, metadata_json, source_revision_id, created_at, updated_at
      ) VALUES (
        'episode-2', 'project-1', '第二集', '', '16:9', '', 'draft', 1, '{}',
        'source-r1', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
      )
    `))
    context.database.createMediaAsset({
      id: 'episode-2-asset',
      projectId: 'project-1',
      episodeId: 'episode-2',
      kind: 'character.turnaround',
      status: 'ready',
      source: 'fixture',
      checksum: 'c'.repeat(64),
    })
    context.database.withSql((sql) => sql.run(`
      UPDATE characters SET locked_asset_id = 'episode-2-asset' WHERE id = 'character-1'
    `))
    const projection = context.service.projection('project-1', 'episode-1')
    assert.equal(projection.status, 'blocked')
    assert.equal(projection.blockers[0]?.code, 'ASSET_SCOPE_MISMATCH')
    assert.throws(() => context.service.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      ifMatch: context.etag(),
      idempotencyKey: 'blocked-request',
    }), (error: unknown) => (
      error instanceof ProductionAssetManifestError && error.code === 'MANIFEST_BLOCKED'
    ))
  } finally {
    context.database.close()
  }
})
