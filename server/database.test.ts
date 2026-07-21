import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'

import {
  DATABASE_SCHEMA_VERSION,
  DatabaseIntegrityError,
  initializeDatabase,
  type ManjuDatabase,
} from './database.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-database-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

function insertEpisode(database: ManjuDatabase, id: string, projectId: string, sortOrder = 0): void {
  database.withSql((sql) => sql.run(`
    INSERT INTO episodes (
      id, project_id, title, source_text, aspect_ratio, style_preset, status,
      sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, '', '16:9', '', 'draft', ?, ?, ?)
  `, id, projectId, id, sortOrder, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'))
}

function insertPipelineRun(database: ManjuDatabase, id: string, projectId: string, episodeId: string): void {
  database.withSql((sql) => sql.run(`
    INSERT INTO pipeline_runs (
      id, project_id, episode_id, status, progress, steps_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'queued', 0, '{}', ?, ?)
  `, id, projectId, episodeId, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'))
}

function removeV4TimelineSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER quality_reports_binding_no_update;
    DROP INDEX exports_timeline_document_revision_idx;
    ALTER TABLE exports DROP COLUMN timeline_document_revision_id;
    DROP TRIGGER timeline_document_revisions_no_update;
    DROP TABLE timeline_document_revisions;
    DROP TABLE timeline_documents;
    DROP INDEX episodes_id_project_unique;
    DROP INDEX revisions_id_project_unique;
  `)
}

function removeV6PipelineSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    DROP INDEX generation_jobs_pipeline_idx;
    DROP INDEX pipeline_runs_idempotency_idx;
    ALTER TABLE pipeline_runs DROP COLUMN source_revision_id;
    ALTER TABLE pipeline_runs DROP COLUMN idempotency_key;
  `)
}

function removeV7TimelineAutoEditSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    DROP TRIGGER timeline_edit_undos_no_delete;
    DROP TRIGGER timeline_edit_undos_no_update;
    DROP INDEX timeline_edit_undos_document_idx;
    DROP TABLE timeline_edit_undos;
    DROP TRIGGER timeline_edit_applications_no_delete;
    DROP TRIGGER timeline_edit_applications_no_update;
    DROP INDEX timeline_edit_applications_document_idx;
    DROP TABLE timeline_edit_applications;
    DROP TRIGGER timeline_auto_edit_plans_no_delete;
    DROP TRIGGER timeline_auto_edit_plans_no_update;
    DROP INDEX timeline_auto_edit_plans_document_idx;
    DROP TABLE timeline_auto_edit_plans;
  `)
}

function removeV8TimelineAutoEditDeleteGuards(sqlite: DatabaseSync): void {
  sqlite.exec(`
    DROP TRIGGER timeline_auto_edit_plans_no_delete;
    DROP TRIGGER timeline_edit_applications_no_delete;
    DROP TRIGGER timeline_edit_undos_no_delete;
  `)
}

function removeV10StoryRevisionImmutabilityGuards(sqlite: DatabaseSync): void {
  sqlite.exec(`
    DROP TRIGGER story_scoped_revisions_no_delete;
    DROP TRIGGER story_scoped_revisions_no_update;
  `)
}

function removeV11ReleaseReviewSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    DROP TRIGGER release_reviews_no_delete;
    DROP TRIGGER release_reviews_no_update;
    DROP INDEX release_reviews_quality_report_idx;
    DROP INDEX release_reviews_export_idx;
    DROP TABLE release_reviews;
  `)
}

function removeV12TimelineRevisionRestoreSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    DROP TRIGGER timeline_revision_restores_no_delete;
    DROP TRIGGER timeline_revision_restores_no_update;
    DROP INDEX timeline_revision_restores_document_idx;
    DROP TABLE timeline_revision_restores;
  `)
}

function removeV13ShotMediaReviewSchema(sqlite: DatabaseSync): void {
  removeV14TimelineMediaAuthoritySchema(sqlite)
  sqlite.exec(`
    DROP TRIGGER shot_media_review_no_delete;
    DROP TRIGGER shot_media_review_no_update;
    DROP TRIGGER shot_media_review_validate_insert;
    DROP INDEX shot_media_review_asset_idx;
    DROP INDEX shot_media_review_scope_idx;
    DROP TABLE shot_media_review_decisions;
  `)
}

function removeV14TimelineMediaAuthoritySchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    DROP TRIGGER timeline_media_authority_receipts_no_delete;
    DROP TRIGGER timeline_media_authority_receipts_no_update;
    DROP TRIGGER timeline_media_authority_receipts_validate_insert;
    DROP INDEX timeline_media_authority_receipts_scope_idx;
    DROP TABLE timeline_media_authority_receipts;
  `)
}

function removeV16ProductionAssetManifestSchema(sqlite: DatabaseSync): void {
  removeV17ProjectKnowledgeSchema(sqlite)
  sqlite.exec(`
    DROP TRIGGER production_asset_manifest_entries_no_delete;
    DROP TRIGGER production_asset_manifests_no_delete;
    DROP TRIGGER production_asset_manifests_validate_parent;
    DROP TRIGGER production_asset_manifest_entries_no_update;
    DROP TRIGGER production_asset_manifests_no_update;
    DROP INDEX production_asset_manifest_entries_handle_idx;
    DROP INDEX production_asset_manifest_entries_version_idx;
    DROP INDEX production_asset_manifests_episode_idx;
    DROP TABLE production_asset_manifest_entries;
    DROP TABLE production_asset_manifests;
  `)
}

function removeV17ProjectKnowledgeSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    DROP TRIGGER project_knowledge_snapshot_no_delete;
    DROP TRIGGER project_knowledge_snapshot_no_update;
    DROP TRIGGER project_knowledge_revisions_no_delete;
    DROP TRIGGER project_knowledge_revisions_no_update;
    DROP TRIGGER project_knowledge_revisions_validate_insert;
    DROP TRIGGER project_knowledge_heads_validate_update;
    DROP TRIGGER projects_create_knowledge_head;
    DROP INDEX project_knowledge_revisions_scope_idx;
    DROP TABLE project_knowledge_revisions;
    DROP TABLE project_knowledge_heads;
  `)
}

function removeV9StoryAndCharacterReferenceScope(sqlite: DatabaseSync): void {
  removeV13ShotMediaReviewSchema(sqlite)
  removeV10StoryRevisionImmutabilityGuards(sqlite)
  sqlite.exec(`
    DROP INDEX character_visual_references_asset_idx;
    DROP TABLE character_visual_references;
    DROP TRIGGER story_revision_scopes_no_update;
    DROP INDEX story_revision_scopes_episode_idx;
    DROP TABLE story_revision_scopes;
  `)
}

test('migration creates every core table with WAL, foreign keys, and user_version', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  const database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })

  assert.deepEqual(database.health(), {
    schemaVersion: DATABASE_SCHEMA_VERSION,
    foreignKeys: true,
    journalMode: 'wal',
    quickCheck: 'ok',
  })
  database.close()

  const sqlite = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const version = sqlite.prepare('PRAGMA user_version').get() as { user_version: number }
    assert.equal(version.user_version, DATABASE_SCHEMA_VERSION)
    const rows = sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all() as Array<{ name: string }>
    const tables = new Set(rows.map((row) => row.name))
    for (const name of [
      'projects',
      'episodes',
      'revisions',
      'characters',
      'locations',
      'props',
      'scenes',
      'shots',
      'dialogue_lines',
      'media_assets',
      'asset_handles',
      'asset_handle_versions',
      'asset_version_switches',
      'production_asset_manifests',
      'production_asset_manifest_entries',
      'project_knowledge_heads',
      'project_knowledge_revisions',
      'generation_jobs',
      'pipeline_runs',
      'provider_connections',
      'provider_connection_versions',
      'timeline_documents',
      'timeline_document_revisions',
      'timeline_auto_edit_plans',
      'timeline_edit_applications',
      'timeline_edit_undos',
      'story_revision_scopes',
      'character_visual_references',
      'exports',
      'quality_reports',
      'release_reviews',
      'timeline_revision_restores',
      'shot_media_review_decisions',
      'timeline_media_authority_receipts',
      'voice_preview_reviews',
      'legacy_imports',
    ]) assert.ok(tables.has(name), `missing table ${name}`)
    const exportColumns = sqlite.prepare('PRAGMA table_info(exports)').all() as Array<{ name: string }>
    assert.ok(exportColumns.some((column) => column.name === 'timeline_document_revision_id'))
    const pipelineColumns = sqlite.prepare('PRAGMA table_info(pipeline_runs)').all() as Array<{ name: string }>
    assert.ok(pipelineColumns.some((column) => column.name === 'idempotency_key'))
    assert.ok(pipelineColumns.some((column) => column.name === 'source_revision_id'))
    assert.ok(sqlite.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name = 'quality_reports_binding_no_update'
    `).get())
    assert.ok(sqlite.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'pipeline_runs_idempotency_idx'
    `).get())
    assert.ok(sqlite.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'generation_jobs_pipeline_idx'
    `).get())
  } finally {
    sqlite.close()
  }
})

test('schema v17 databases gain immutable voice preview review audits', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'voice-review-v17-project', title: 'Voice review migration' })
  database.close()

  const v17 = new DatabaseSync(databasePath)
  try {
    v17.exec(`
      DROP TRIGGER IF EXISTS voice_preview_reviews_no_delete;
      DROP TRIGGER IF EXISTS voice_preview_reviews_no_update;
      DROP TRIGGER IF EXISTS voice_preview_reviews_validate_insert;
      DROP INDEX IF EXISTS voice_preview_reviews_subject_idx;
      DROP INDEX IF EXISTS voice_preview_reviews_job_idx;
      DROP TABLE IF EXISTS voice_preview_reviews;
      PRAGMA user_version = 17;
    `)
  } finally {
    v17.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'voice_preview_reviews'
    `)))
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name = 'voice_preview_reviews_no_update'
    `)))
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v17-before-v19-.*\.sqlite$/)
  } finally {
    database.close()
  }
})

test('schema v18 databases gain immutable voice preview played-range evidence', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.close()

  const v18 = new DatabaseSync(databasePath)
  try {
    v18.exec(`
      DROP TRIGGER IF EXISTS voice_preview_reviews_playback_evidence_validate_insert;
      ALTER TABLE voice_preview_reviews DROP COLUMN playback_evidence_json;
      PRAGMA user_version = 18;
    `)
  } finally {
    v18.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM pragma_table_info('voice_preview_reviews')
       WHERE name = 'playback_evidence_json'
    `)))
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'voice_preview_reviews_playback_evidence_validate_insert'
    `)))
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v18-before-v19-.*\.sqlite$/)
  } finally {
    database.close()
  }
})

test('schema v16 databases gain an isolated project knowledge head without guessing generic audits', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  const project = database.createProject({ id: 'knowledge-v16-project', title: 'Knowledge migration' })
  const generic = database.createRevision({
    id: 'knowledge-v16-generic-voice-revision',
    projectId: project.id,
    summary: '设置角色声线',
    snapshot: { voiceProfile: { voiceId: 'voice-1' } },
  })
  database.updateProject(project.id, { currentRevisionId: generic.id })
  database.close()

  const v16 = new DatabaseSync(databasePath)
  try {
    removeV17ProjectKnowledgeSchema(v16)
    v16.exec('PRAGMA user_version = 16')
  } finally {
    v16.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.equal(database.getProject(project.id)?.currentRevisionId, generic.id)
    const knowledgeHead = database.withSql((sql) => sql.get(`
      SELECT project_id, current_revision_id
        FROM project_knowledge_heads
       WHERE project_id = ?
    `, project.id))
    assert.equal(knowledgeHead?.project_id, project.id)
    assert.equal(knowledgeHead?.current_revision_id, null)
    assert.equal(database.withSql((sql) => sql.all(`
      SELECT * FROM project_knowledge_revisions WHERE project_id = ?
    `, project.id)).length, 0)
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v16-before-v19-.*\.sqlite$/)
  } finally {
    database.close()
  }
})

test('schema v15 databases gain immutable Production Asset Manifest tables', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'manifest-v15-project', title: 'Manifest migration' })
  insertEpisode(database, 'manifest-v15-episode', 'manifest-v15-project')
  database.close()

  const v15 = new DatabaseSync(databasePath)
  try {
    removeV16ProductionAssetManifestSchema(v15)
    v15.exec('PRAGMA user_version = 15')
  } finally {
    v15.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'production_asset_manifests'
    `)))
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'production_asset_manifest_entries'
    `)))
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT project_id FROM episodes WHERE id = 'manifest-v15-episode'
    `))?.project_id, 'manifest-v15-project')
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v15-before-v19-.*\.sqlite$/)
  } finally {
    database.close()
  }
})

test('schema v1 databases gain episode story metadata without losing rows', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'v1-project', title: 'Existing project' })
  database.withSql((sql) => sql.run(`
    INSERT INTO episodes (
      id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
      style_preset, status, sort_order, created_at, updated_at
    ) VALUES (
      'v1-episode', 'v1-project', 'Existing episode', '', 30, '16:9',
      '', 'draft', 0, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
    )
  `))
  database.createMediaAsset({
    id: 'v1-asset',
    projectId: 'v1-project',
    kind: 'image',
    filePath: 'media/v1-project/v1-asset.png',
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    checksum: 'a'.repeat(64),
    source: 'upload',
    generationParameters: { importedFrom: 'v1-fixture' },
  })
  database.close()

  const v1 = new DatabaseSync(databasePath)
  try {
    removeV9StoryAndCharacterReferenceScope(v1)
    removeV7TimelineAutoEditSchema(v1)
    removeV6PipelineSchema(v1)
    removeV4TimelineSchema(v1)
    v1.exec(`
      DROP INDEX episodes_source_revision_idx;
      ALTER TABLE episodes DROP COLUMN source_revision_id;
      ALTER TABLE episodes DROP COLUMN metadata_json;
      DROP TABLE provider_connection_versions;
      PRAGMA user_version = 1;
    `)
  } finally {
    v1.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    const episode = database.withSql((sql) => sql.get(`
      SELECT id, metadata_json, source_revision_id FROM episodes WHERE id = 'v1-episode'
    `))
    assert.deepEqual(episode ? { ...episode } : episode, {
      id: 'v1-episode',
      metadata_json: '{}',
      source_revision_id: null,
    })
    assert.equal(database.health().quickCheck, 'ok')
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v1-before-v19-.*\.sqlite$/)
    const backup = new DatabaseSync(join(runtimeDirectory, 'backups', backups[0]), { readOnly: true })
    try {
      assert.deepEqual({ ...backup.prepare(`SELECT id FROM episodes WHERE id = 'v1-episode'`).get() }, {
        id: 'v1-episode',
      })
      assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1)
      assert.equal((backup.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check, 'ok')
    } finally {
      backup.close()
    }
    const mediaIndexes = await readdir(join(runtimeDirectory, 'media-index-backups'))
    assert.equal(mediaIndexes.length, 1)
    assert.match(mediaIndexes[0], /^media-index-v1-before-v19-.*\.json$/)
    const mediaIndexPath = join(runtimeDirectory, 'media-index-backups', mediaIndexes[0])
    const mediaIndex = JSON.parse(await readFile(mediaIndexPath, 'utf8')) as {
      payload: {
        sourceSchemaVersion: number
        targetSchemaVersion: number
        sqliteBackupFile: string
        assets: Array<Record<string, unknown>>
      }
      payloadSha256: string
    }
    assert.equal(mediaIndex.payload.sourceSchemaVersion, 1)
    assert.equal(mediaIndex.payload.targetSchemaVersion, DATABASE_SCHEMA_VERSION)
    assert.equal(mediaIndex.payload.sqliteBackupFile, backups[0])
    assert.equal(mediaIndex.payload.assets.length, 1)
    const indexedAsset = mediaIndex.payload.assets[0]!
    assert.equal(typeof indexedAsset.createdAt, 'string')
    assert.equal(typeof indexedAsset.updatedAt, 'string')
    assert.deepEqual(indexedAsset, {
      id: 'v1-asset',
      projectId: 'v1-project',
      episodeId: null,
      kind: 'image',
      version: 1,
      status: 'ready',
      filePath: 'media/v1-project/v1-asset.png',
      mimeType: 'image/png',
      width: 1280,
      height: 720,
      durationSeconds: null,
      checksum: 'a'.repeat(64),
      source: 'upload',
      providerId: null,
      generationJobId: null,
      sourceRevisionId: null,
      parentAssetId: null,
      createdAt: indexedAsset.createdAt,
      updatedAt: indexedAsset.updatedAt,
    })
    assert.equal(
      mediaIndex.payloadSha256,
      createHash('sha256').update(JSON.stringify(mediaIndex.payload)).digest('hex'),
    )
    assert.equal((await stat(mediaIndexPath)).mode & 0o777, 0o600)
  } finally {
    database.close()
  }
})

test('schema v2 provider rows and job-bound revisions gain immutable execution profiles', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'profile-project', title: 'Profile migration' })
  database.createProviderConnection({
    id: 'profile-provider',
    kind: 'image',
    adapter: 'openai-compatible',
    displayName: 'Profile provider',
    baseUrl: 'https://images-v1.example.test/v1',
    defaultModel: 'image-v1',
    authMode: 'byok',
    credentialReference: { service: 'com.manju.test', account: 'profile-provider:r1' },
    config: { timeoutMs: 30_000, isDefault: true, lastTestStatus: 'ok' },
  })
  const current = database.updateProviderConnection('profile-provider', {
    baseUrl: 'https://images-v2.example.test/v1',
    defaultModel: 'image-v2',
  })!
  database.createGenerationJob({
    id: 'profile-job',
    projectId: 'profile-project',
    providerId: 'profile-provider',
    providerConfigRevision: 1,
    type: 'asset.image.generate',
    input: {},
  })
  assert.equal(current.configRevision, 2)
  database.close()

  const v2 = new DatabaseSync(databasePath)
  try {
    removeV9StoryAndCharacterReferenceScope(v2)
    removeV7TimelineAutoEditSchema(v2)
    removeV6PipelineSchema(v2)
    removeV4TimelineSchema(v2)
    v2.exec(`
      DROP TABLE provider_connection_versions;
      PRAGMA user_version = 2;
    `)
  } finally {
    v2.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    const versions = database.listProviderConnectionVersions('profile-provider')
    assert.deepEqual(versions.map((version) => version.configRevision), [1, 2])
    for (const version of versions) {
      assert.equal(version.baseUrl, 'https://images-v2.example.test/v1')
      assert.equal(version.model, 'image-v2')
      assert.deepEqual(version.executionConfig, {
        timeoutMs: 30_000,
        __migrationProvenance: 'v2-approximation',
      })
      assert.equal(JSON.stringify(version).includes('lastTestStatus'), false)
    }
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.ok(backups.some((name) => /^manju-v2-before-v19-.*\.sqlite$/.test(name)))
  } finally {
    database.close()
  }
})

test('schema v3 databases gain timeline documents, immutable revisions, and export revision pins', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'timeline-migration-project', title: 'Timeline migration' })
  insertEpisode(database, 'timeline-migration-episode', 'timeline-migration-project')
  database.close()

  const v3 = new DatabaseSync(databasePath)
  try {
    removeV9StoryAndCharacterReferenceScope(v3)
    removeV7TimelineAutoEditSchema(v3)
    removeV6PipelineSchema(v3)
    removeV4TimelineSchema(v3)
    v3.exec('PRAGMA user_version = 3')
  } finally {
    v3.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    const migratedEpisode = database.withSql((sql) => sql.get(`
      SELECT id, project_id FROM episodes WHERE id = 'timeline-migration-episode'
    `))
    assert.deepEqual(migratedEpisode ? { ...migratedEpisode } : migratedEpisode, {
      id: 'timeline-migration-episode',
      project_id: 'timeline-migration-project',
    })
    const schema = database.withSql((sql) => ({
      documents: sql.get(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'timeline_documents'
      `),
      revisions: sql.get(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'timeline_document_revisions'
      `),
      exportColumns: sql.all('PRAGMA table_info(exports)'),
    }))
    assert.ok(schema.documents)
    assert.ok(schema.revisions)
    assert.ok(schema.exportColumns.some((column) => column.name === 'timeline_document_revision_id'))
    assert.equal(database.health().quickCheck, 'ok')

    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v3-before-v19-.*\.sqlite$/)
    const backup = new DatabaseSync(join(runtimeDirectory, 'backups', backups[0]), { readOnly: true })
    try {
      assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3)
      assert.deepEqual({ ...backup.prepare(`
        SELECT id FROM episodes WHERE id = 'timeline-migration-episode'
      `).get() }, { id: 'timeline-migration-episode' })
    } finally {
      backup.close()
    }
  } finally {
    database.close()
  }
})

test('schema v4 databases gain immutable quality report bindings without losing report rows', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'quality-v4-project', title: 'Quality v4 migration' })
  insertEpisode(database, 'quality-v4-episode', 'quality-v4-project')
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO quality_reports (
        id, project_id, episode_id, export_id, status, checks_json, passed, created_at
      ) VALUES ('legacy-quality-report', 'quality-v4-project', 'quality-v4-episode',
        NULL, 'queued', '{}', 0, '2026-07-14T00:00:00.000Z')
    `)
  })
  database.close()

  const v4 = new DatabaseSync(databasePath)
  try {
    removeV9StoryAndCharacterReferenceScope(v4)
    removeV7TimelineAutoEditSchema(v4)
    removeV6PipelineSchema(v4)
    v4.exec(`
      DROP TRIGGER quality_reports_binding_no_update;
      PRAGMA user_version = 4;
    `)
  } finally {
    v4.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT status FROM quality_reports WHERE id = 'legacy-quality-report'
    `))?.status, 'queued')
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name = 'quality_reports_binding_no_update'
    `)))
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v4-before-v19-.*\.sqlite$/)
  } finally {
    database.close()
  }
})

test('schema v5 databases gain durable pipeline bindings and indexes without losing rows', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'pipeline-v5-project', title: 'Pipeline v5 migration' })
  insertEpisode(database, 'pipeline-v5-episode', 'pipeline-v5-project')
  const pipeline = database.createPipelineRun({
    id: 'pipeline-v5-run',
    projectId: 'pipeline-v5-project',
    episodeId: 'pipeline-v5-episode',
    steps: { storyboard: { status: 'queued' } },
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  })
  database.createGenerationJob({
    id: 'pipeline-v5-job',
    projectId: 'pipeline-v5-project',
    episodeId: 'pipeline-v5-episode',
    pipelineRunId: pipeline.id,
    type: 'asset.image.generate',
    input: {},
  })
  database.close()

  const v5 = new DatabaseSync(databasePath)
  try {
    removeV9StoryAndCharacterReferenceScope(v5)
    removeV7TimelineAutoEditSchema(v5)
    removeV6PipelineSchema(v5)
    v5.exec('PRAGMA user_version = 5')
  } finally {
    v5.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.deepEqual(database.getPipelineRun('pipeline-v5-run'), {
      id: 'pipeline-v5-run',
      projectId: 'pipeline-v5-project',
      episodeId: 'pipeline-v5-episode',
      idempotencyKey: null,
      sourceRevisionId: null,
      status: 'queued',
      progress: 0,
      steps: { storyboard: { status: 'queued' } },
      error: null,
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      completedAt: null,
    })
    assert.deepEqual(
      database.listGenerationJobs({ pipelineRunId: 'pipeline-v5-run' }).map((job) => job.id),
      ['pipeline-v5-job'],
    )
    assert.equal(database.health().quickCheck, 'ok')
    const indexes = database.withSql((sql) => sql.all(`
      SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name IN ('pipeline_runs_idempotency_idx', 'generation_jobs_pipeline_idx')
       ORDER BY name
    `))
    assert.deepEqual(indexes.map((row) => row.name), [
      'generation_jobs_pipeline_idx',
      'pipeline_runs_idempotency_idx',
    ])
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v5-before-v19-.*\.sqlite$/)
  } finally {
    database.close()
  }
})

test('schema v6 databases gain immutable automatic-edit plans, applications, and undos', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'auto-edit-v6-project', title: 'Auto edit v6 migration' })
  insertEpisode(database, 'auto-edit-v6-episode', 'auto-edit-v6-project')
  database.close()

  const v6 = new DatabaseSync(databasePath)
  try {
    removeV9StoryAndCharacterReferenceScope(v6)
    removeV7TimelineAutoEditSchema(v6)
    v6.exec('PRAGMA user_version = 6')
  } finally {
    v6.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.equal(database.health().quickCheck, 'ok')
    const schema = database.withSql((sql) => sql.all(`
      SELECT type, name FROM sqlite_master
       WHERE name IN (
         'timeline_auto_edit_plans',
         'timeline_edit_applications',
         'timeline_edit_undos',
         'timeline_auto_edit_plans_no_delete',
         'timeline_auto_edit_plans_no_update',
         'timeline_edit_applications_no_delete',
         'timeline_edit_applications_no_update',
         'timeline_edit_undos_no_delete',
         'timeline_edit_undos_no_update'
       )
       ORDER BY name
    `))
    assert.deepEqual(schema.map((item) => item.name), [
      'timeline_auto_edit_plans',
      'timeline_auto_edit_plans_no_delete',
      'timeline_auto_edit_plans_no_update',
      'timeline_edit_applications',
      'timeline_edit_applications_no_delete',
      'timeline_edit_applications_no_update',
      'timeline_edit_undos',
      'timeline_edit_undos_no_delete',
      'timeline_edit_undos_no_update',
    ])
    assert.deepEqual({ ...database.withSql((sql) => sql.get(`
      SELECT id, project_id FROM episodes WHERE id = 'auto-edit-v6-episode'
    `)) }, { id: 'auto-edit-v6-episode', project_id: 'auto-edit-v6-project' })
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v6-before-v19-.*\.sqlite$/)
  } finally {
    database.close()
  }
})

test('schema v7 databases gain append-only automatic-edit delete guards', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'auto-edit-v7-project', title: 'Auto edit v7 migration' })
  insertEpisode(database, 'auto-edit-v7-episode', 'auto-edit-v7-project')
  database.close()

  const v7 = new DatabaseSync(databasePath)
  try {
    removeV9StoryAndCharacterReferenceScope(v7)
    removeV8TimelineAutoEditDeleteGuards(v7)
    v7.exec('PRAGMA user_version = 7')
  } finally {
    v7.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.equal(database.health().quickCheck, 'ok')
    const triggers = database.withSql((sql) => sql.all(`
      SELECT name FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN (
           'timeline_auto_edit_plans_no_delete',
           'timeline_edit_applications_no_delete',
           'timeline_edit_undos_no_delete'
         )
       ORDER BY name
    `))
    assert.deepEqual(triggers.map((item) => item.name), [
      'timeline_auto_edit_plans_no_delete',
      'timeline_edit_applications_no_delete',
      'timeline_edit_undos_no_delete',
    ])
    assert.deepEqual({ ...database.withSql((sql) => sql.get(`
      SELECT id, project_id FROM episodes WHERE id = 'auto-edit-v7-episode'
    `)) }, { id: 'auto-edit-v7-episode', project_id: 'auto-edit-v7-project' })
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v7-before-v19-.*\.sqlite$/)
  } finally {
    database.close()
  }
})

test('schema v8 databases gain episode-scoped Story revisions and character view slots', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'scope-v8-project', title: 'Scope migration' })
  insertEpisode(database, 'scope-v8-episode', 'scope-v8-project')
  const revision = database.createRevision({
    id: 'scope-v8-story',
    projectId: 'scope-v8-project',
    summary: 'existing story',
    snapshot: {
      version: 1,
      title: '第 1 集',
      bible: {},
      characters: [],
      locations: [],
      props: [],
      scenes: [],
    },
  })
  database.withSql((sql) => sql.run(`
    UPDATE episodes SET source_revision_id = ? WHERE id = 'scope-v8-episode'
  `, revision.id))
  database.close()

  const v8 = new DatabaseSync(databasePath)
  try {
    removeV9StoryAndCharacterReferenceScope(v8)
    v8.exec('PRAGMA user_version = 8;')
  } finally {
    v8.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.deepEqual({ ...database.withSql((sql) => sql.get(`
      SELECT revision_id, project_id, episode_id
      FROM story_revision_scopes
      WHERE revision_id = 'scope-v8-story'
    `)) }, {
      revision_id: 'scope-v8-story',
      project_id: 'scope-v8-project',
      episode_id: 'scope-v8-episode',
    })
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'character_visual_references'
    `)))
    assert.equal(database.health().quickCheck, 'ok')
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v8-before-v19-.*\.sqlite$/)
  } finally {
    database.close()
  }
})

test('schema v9 migration scopes only valid Story heads with one unambiguous episode owner', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  const snapshot = (title: string) => ({
    version: 1,
    title,
    bible: {},
    characters: [],
    locations: [],
    props: [],
    scenes: [],
  })

  database.createProject({ id: 'scope-distinct-project', title: 'Distinct heads' })
  insertEpisode(database, 'scope-distinct-a', 'scope-distinct-project', 0)
  insertEpisode(database, 'scope-distinct-b', 'scope-distinct-project', 1)
  const distinctA = database.createRevision({
    id: 'scope-distinct-a-current',
    projectId: 'scope-distinct-project',
    summary: 'A current',
    snapshot: snapshot('A current'),
  })
  const distinctB = database.createRevision({
    id: 'scope-distinct-b-current',
    projectId: 'scope-distinct-project',
    summary: 'B current',
    snapshot: snapshot('B current'),
  })
  database.createRevision({
    id: 'scope-distinct-history',
    projectId: 'scope-distinct-project',
    summary: 'ambiguous history',
    snapshot: snapshot('Historical Story'),
  })
  database.withSql((sql) => {
    sql.run('UPDATE episodes SET source_revision_id = ? WHERE id = ?', distinctA.id, 'scope-distinct-a')
    sql.run('UPDATE episodes SET source_revision_id = ? WHERE id = ?', distinctB.id, 'scope-distinct-b')
  })

  database.createProject({ id: 'scope-single-project', title: 'Single episode history' })
  insertEpisode(database, 'scope-single-episode', 'scope-single-project')
  const singleCurrent = database.createRevision({
    id: 'scope-single-current',
    projectId: 'scope-single-project',
    summary: 'single current',
    snapshot: snapshot('Single current'),
  })
  database.createRevision({
    id: 'scope-single-history',
    projectId: 'scope-single-project',
    summary: 'single ambiguous history',
    snapshot: snapshot('Single historical Story'),
  })
  database.withSql((sql) => sql.run(`
    UPDATE episodes SET source_revision_id = ? WHERE id = ?
  `, singleCurrent.id, 'scope-single-episode'))

  database.createProject({ id: 'scope-shared-project', title: 'Shared head' })
  insertEpisode(database, 'scope-shared-a', 'scope-shared-project', 0)
  insertEpisode(database, 'scope-shared-b', 'scope-shared-project', 1)
  const shared = database.createRevision({
    id: 'scope-shared-current',
    projectId: 'scope-shared-project',
    summary: 'shared current',
    snapshot: snapshot('Shared current'),
  })
  database.withSql((sql) => sql.run(`
    UPDATE episodes SET source_revision_id = ? WHERE project_id = ?
  `, shared.id, 'scope-shared-project'))
  database.close()

  const v8 = new DatabaseSync(databasePath)
  try {
    removeV9StoryAndCharacterReferenceScope(v8)
    v8.exec('PRAGMA user_version = 8;')
  } finally {
    v8.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.deepEqual(database.withSql((sql) => sql.all(`
      SELECT revision_id, episode_id
      FROM story_revision_scopes
      ORDER BY revision_id
    `)).map((row) => ({ ...row })), [
      { revision_id: 'scope-distinct-a-current', episode_id: 'scope-distinct-a' },
      { revision_id: 'scope-distinct-b-current', episode_id: 'scope-distinct-b' },
      { revision_id: 'scope-single-current', episode_id: 'scope-single-episode' },
    ])
    assert.equal(database.health().quickCheck, 'ok')
  } finally {
    database.close()
  }
})

test('schema v9 databases install scoped Story revision immutability guards in v10', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'guard-v9-project', title: 'Guard migration' })
  insertEpisode(database, 'guard-v9-episode', 'guard-v9-project')
  const revision = database.createRevision({
    id: 'guard-v9-revision',
    projectId: 'guard-v9-project',
    summary: 'must become immutable',
    snapshot: { version: 1 },
  })
  database.withSql((sql) => sql.run(`
    INSERT INTO story_revision_scopes (revision_id, project_id, episode_id, created_at)
    VALUES (?, ?, ?, ?)
  `, revision.id, 'guard-v9-project', 'guard-v9-episode', '2026-07-14T00:00:00.000Z'))
  database.close()

  const v9 = new DatabaseSync(databasePath)
  try {
    removeV10StoryRevisionImmutabilityGuards(v9)
    v9.exec('PRAGMA user_version = 9;')
  } finally {
    v9.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.deepEqual(database.withSql((sql) => sql.all(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (
          'story_scoped_revisions_no_delete',
          'story_scoped_revisions_no_update'
        )
      ORDER BY name
    `)).map((row) => row.name), [
      'story_scoped_revisions_no_delete',
      'story_scoped_revisions_no_update',
    ])
    assert.throws(
      () => database.updateRevision(revision.id, { summary: 'rewritten' }),
      /scoped story revisions are immutable/,
    )
    assert.throws(
      () => database.deleteRevision(revision.id),
      /scoped story revisions are immutable/,
    )
    assert.equal(database.getRevision(revision.id)?.summary, 'must become immutable')
    assert.equal(database.deleteProject('guard-v9-project'), true)
    assert.equal(database.getRevision(revision.id), undefined)
    assert.equal(database.health().quickCheck, 'ok')

    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v9-before-v19-.*\.sqlite$/)
    const backup = new DatabaseSync(join(runtimeDirectory, 'backups', backups[0]), { readOnly: true })
    try {
      assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9)
      assert.equal(backup.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = 'story_scoped_revisions_no_update'
      `).get(), undefined)
    } finally {
      backup.close()
    }
  } finally {
    database.close()
  }
})

test('scoped Story revisions are immutable while project deletion still cascades', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'immutable-project', title: 'Immutable Story history' })
    insertEpisode(database, 'immutable-episode', 'immutable-project')
    const scoped = database.createRevision({
      id: 'immutable-scoped-revision',
      projectId: 'immutable-project',
      summary: 'immutable',
      snapshot: { version: 1 },
    })
    database.withSql((sql) => sql.run(`
      INSERT INTO story_revision_scopes (revision_id, project_id, episode_id, created_at)
      VALUES (?, ?, ?, ?)
    `, scoped.id, 'immutable-project', 'immutable-episode', '2026-07-14T00:00:00.000Z'))

    assert.throws(
      () => database.updateRevision(scoped.id, { summary: 'rewritten' }),
      /scoped story revisions are immutable/,
    )
    assert.throws(
      () => database.deleteRevision(scoped.id),
      /scoped story revisions are immutable/,
    )
    assert.equal(database.getRevision(scoped.id)?.summary, 'immutable')

    const unscoped = database.createRevision({
      id: 'mutable-unscoped-revision',
      projectId: 'immutable-project',
      summary: 'mutable audit row',
      snapshot: { type: 'provider.audit' },
    })
    assert.equal(database.updateRevision(unscoped.id, { summary: 'updated audit row' })?.summary, 'updated audit row')
    assert.equal(database.deleteRevision(unscoped.id), true)

    assert.equal(database.deleteProject('immutable-project'), true)
    assert.equal(database.getRevision(scoped.id), undefined)
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT revision_id FROM story_revision_scopes WHERE revision_id = ?
    `, scoped.id)), undefined)
    assert.equal(database.health().quickCheck, 'ok')
  } finally {
    database.close()
  }
})

test('schema v10 databases gain immutable release reviews through the verified backup path', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'release-migration-project', title: 'Release migration' })
  database.close()

  const v10 = new DatabaseSync(databasePath)
  try {
    removeV12TimelineRevisionRestoreSchema(v10)
    removeV11ReleaseReviewSchema(v10)
    v10.exec('PRAGMA user_version = 10;')
  } finally {
    v10.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.deepEqual(database.withSql((sql) => sql.all(`
      SELECT name FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN ('release_reviews_no_delete', 'release_reviews_no_update')
       ORDER BY name
    `)).map((row) => row.name), [
      'release_reviews_no_delete',
      'release_reviews_no_update',
    ])
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'release_reviews'
    `)))
    assert.ok(database.getProject('release-migration-project'))
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v10-before-v19-.*\.sqlite$/)
    const backup = new DatabaseSync(join(runtimeDirectory, 'backups', backups[0]), { readOnly: true })
    try {
      assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10)
      assert.equal(backup.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'release_reviews'
      `).get(), undefined)
    } finally {
      backup.close()
    }
  } finally {
    database.close()
  }
})

test('schema v11 databases gain immutable idempotent timeline restore audits', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'restore-migration-project', title: 'Restore migration' })
  database.close()

  const v11 = new DatabaseSync(databasePath)
  try {
    removeV12TimelineRevisionRestoreSchema(v11)
    v11.exec('PRAGMA user_version = 11;')
  } finally {
    v11.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'timeline_revision_restores'
    `)))
    assert.deepEqual(database.withSql((sql) => sql.all(`
      SELECT name FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN (
           'timeline_revision_restores_no_delete',
           'timeline_revision_restores_no_update'
         )
       ORDER BY name
    `)).map((row) => row.name), [
      'timeline_revision_restores_no_delete',
      'timeline_revision_restores_no_update',
    ])
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'release_reviews'
    `)))
    assert.ok(database.getProject('restore-migration-project'))
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v11-before-v19-.*\.sqlite$/)
    const backup = new DatabaseSync(join(runtimeDirectory, 'backups', backups[0]), { readOnly: true })
    try {
      assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 11)
      assert.equal(backup.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'timeline_revision_restores'
      `).get(), undefined)
      assert.ok(backup.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'release_reviews'
      `).get())
    } finally {
      backup.close()
    }
  } finally {
    database.close()
  }
})

test('schema v12 databases gain immutable shot media review audits without rewriting assets', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'media-review-migration-project', title: 'Media review migration' })
  database.createMediaAsset({
    id: 'media-review-migration-asset',
    projectId: 'media-review-migration-project',
    kind: 'storyboard',
    filePath: 'media/media-review-migration-project/storyboard.png',
    mimeType: 'image/png',
    checksum: 'd'.repeat(64),
    source: 'provider',
    generationParameters: { preserved: true },
  })
  database.close()

  const v12 = new DatabaseSync(databasePath)
  try {
    removeV13ShotMediaReviewSchema(v12)
    v12.exec('PRAGMA user_version = 12;')
  } finally {
    v12.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'shot_media_review_decisions'
    `)))
    const reviewColumns = database.withSql((sql) => sql.all(`
      PRAGMA table_info(shot_media_review_decisions)
    `)).map((row) => row.name)
    assert.ok(reviewColumns.includes('cleared_video_asset_id'))
    assert.ok(reviewColumns.includes('stale_shot_video_jobs'))
    assert.deepEqual(database.withSql((sql) => sql.all(`
      SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name LIKE 'shot_media_review_%'
       ORDER BY name
    `)).map((row) => row.name), [
      'shot_media_review_no_delete',
      'shot_media_review_no_update',
      'shot_media_review_validate_insert',
    ])
    assert.deepEqual(database.getMediaAsset('media-review-migration-asset')?.generationParameters, {
      preserved: true,
    })
    assert.equal(database.health().quickCheck, 'ok')
    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v12-before-v19-.*\.sqlite$/)
    const backup = new DatabaseSync(join(runtimeDirectory, 'backups', backups[0]), { readOnly: true })
    try {
      assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 12)
      assert.equal(backup.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'shot_media_review_decisions'
      `).get(), undefined)
      assert.deepEqual({ ...backup.prepare(`
        SELECT id, checksum FROM media_assets WHERE id = 'media-review-migration-asset'
      `).get() }, {
        id: 'media-review-migration-asset',
        checksum: 'd'.repeat(64),
      })
    } finally {
      backup.close()
    }
  } finally {
    database.close()
  }
})

test('schema v13 databases gain durable media receipts and the tightened review trigger through a verified backup', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'media-authority-migration-project', title: 'Authority migration' })
  database.close()

  const v13 = new DatabaseSync(databasePath)
  try {
    removeV14TimelineMediaAuthoritySchema(v13)
    v13.exec(`
      DROP TRIGGER shot_media_review_validate_insert;
      CREATE TRIGGER shot_media_review_validate_insert
      BEFORE INSERT ON shot_media_review_decisions
      BEGIN
        SELECT 1;
      END;
      PRAGMA user_version = 13;
    `)
  } finally {
    v13.close()
  }

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.equal(database.schemaVersion, DATABASE_SCHEMA_VERSION)
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'timeline_media_authority_receipts'
    `)))
    assert.ok(database.withSql((sql) => sql.get(`
      SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'timeline_media_authority_receipts_scope_idx'
    `)))
    const reviewTrigger = database.withSql((sql) => sql.get(`
      SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'shot_media_review_validate_insert'
    `))
    assert.match(String(reviewTrigger?.sql), /NEW\.selected_asset_id/)
    assert.match(String(reviewTrigger?.sql), /media_assets\.source_revision_id/)
    assert.equal(database.health().quickCheck, 'ok')

    const backups = await readdir(join(runtimeDirectory, 'backups'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^manju-v13-before-v19-.*\.sqlite$/)
    const backup = new DatabaseSync(join(runtimeDirectory, 'backups', backups[0]), { readOnly: true })
    try {
      assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 13)
      assert.equal(backup.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'timeline_media_authority_receipts'
      `).get(), undefined)
      const oldTrigger = backup.prepare(`
        SELECT sql FROM sqlite_master
         WHERE type = 'trigger' AND name = 'shot_media_review_validate_insert'
      `).get() as { sql: string }
      assert.doesNotMatch(oldTrigger.sql, /NEW\.selected_asset_id/)
    } finally {
      backup.close()
    }
    const mediaIndexes = await readdir(join(runtimeDirectory, 'media-index-backups'))
    assert.equal(mediaIndexes.length, 1)
    assert.match(mediaIndexes[0], /^media-index-v13-before-v19-.*\.json$/)
    const mediaIndex = JSON.parse(await readFile(
      join(runtimeDirectory, 'media-index-backups', mediaIndexes[0]),
      'utf8',
    )) as {
      payload: {
        sourceSchemaVersion: number
        targetSchemaVersion: number
        sqliteBackupFile: string
        assets: Array<Record<string, unknown>>
      }
      payloadSha256: string
    }
    assert.equal(mediaIndex.payload.sourceSchemaVersion, 13)
    assert.equal(mediaIndex.payload.targetSchemaVersion, DATABASE_SCHEMA_VERSION)
    assert.equal(mediaIndex.payload.sqliteBackupFile, backups[0])
    assert.equal(
      mediaIndex.payloadSha256,
      createHash('sha256').update(JSON.stringify(mediaIndex.payload)).digest('hex'),
    )
  } finally {
    database.close()
  }
})

test('a failed migration leaves the original reopenable and both verified backups in a custom root', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const databasePath = join(runtimeDirectory, 'manju.sqlite')
  const backupDirectory = join(runtimeDirectory, 'separate-backup-volume')
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  database.createProject({ id: 'migration-failure-project', title: 'Must survive' })
  database.createMediaAsset({
    id: 'migration-failure-asset',
    projectId: 'migration-failure-project',
    kind: 'audio',
    filePath: 'media/migration-failure-project/voice.mp3',
    mimeType: 'audio/mpeg',
    durationSeconds: 2.5,
    checksum: 'b'.repeat(64),
    source: 'speech',
    generationParameters: { immutable: true },
  })
  database.close()

  // Deliberately lie about the version while retaining the v2 column. The v1
  // migration will fail on a duplicate ALTER after the physical backup exists.
  const brokenVersion = new DatabaseSync(databasePath)
  brokenVersion.exec('PRAGMA user_version = 1')
  brokenVersion.close()

  assert.throws(
    () => initializeDatabase({
      runtimeDirectory,
      legacyStatePath: false,
      backupDirectory,
    }),
    /duplicate column name: metadata_json/,
  )

  const original = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.deepEqual({ ...original.prepare(`SELECT title FROM projects WHERE id = 'migration-failure-project'`).get() }, {
      title: 'Must survive',
    })
    assert.equal((original.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1)
    assert.equal((original.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check, 'ok')
  } finally {
    original.close()
  }

  const backups = (await readdir(backupDirectory)).filter((name) => name.endsWith('.sqlite'))
  assert.equal(backups.length, 1)
  const backup = new DatabaseSync(join(backupDirectory, backups[0]), { readOnly: true })
  try {
    assert.deepEqual({ ...backup.prepare(`SELECT title FROM projects WHERE id = 'migration-failure-project'`).get() }, {
      title: 'Must survive',
    })
    assert.equal((backup.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check, 'ok')
  } finally {
    backup.close()
  }
  const mediaIndexes = await readdir(join(backupDirectory, 'media-index-backups'))
  assert.equal(mediaIndexes.length, 1)
  const mediaIndex = JSON.parse(await readFile(
    join(backupDirectory, 'media-index-backups', mediaIndexes[0]),
    'utf8',
  )) as {
    payload: { assets: Array<{ id: string; checksum: string | null }> }
    payloadSha256: string
  }
  assert.deepEqual(mediaIndex.payload.assets.map(({ id, checksum }) => ({ id, checksum })), [{
    id: 'migration-failure-asset',
    checksum: 'b'.repeat(64),
  }])
  assert.equal(
    mediaIndex.payloadSha256,
    createHash('sha256').update(JSON.stringify(mediaIndex.payload)).digest('hex'),
  )
})

test('typed CRUD, transactions, idempotency, and restart preserve records', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const clockValues = [
    '2026-07-14T00:00:00.000Z',
    '2026-07-14T00:00:01.000Z',
    '2026-07-14T00:00:02.000Z',
    '2026-07-14T00:00:03.000Z',
    '2026-07-14T00:00:04.000Z',
    '2026-07-14T00:00:05.000Z',
    '2026-07-14T00:00:06.000Z',
    '2026-07-14T00:00:07.000Z',
    '2026-07-14T00:00:08.000Z',
  ]
  const now = () => clockValues.shift() ?? '2026-07-14T00:01:00.000Z'
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false, now })

  const project = database.createProject({ id: 'project-1', title: 'MVP', settings: { aspect: '16:9' } })
  const revision = database.createRevision({
    id: 'revision-1',
    projectId: project.id,
    summary: 'initial',
    snapshot: { title: 'MVP', shots: [] },
  })
  database.updateProject(project.id, { currentRevisionId: revision.id })
  const provider = database.createProviderConnection({
    id: 'provider-1',
    kind: 'image',
    adapter: 'openai-images',
    displayName: 'Image Provider',
    baseUrl: 'https://images.example.test/v1',
    defaultModel: 'image-model',
    authMode: 'byok',
    credentialReference: { service: 'com.manju.provider', account: 'provider-1' },
    config: { timeoutMs: 30_000 },
  })
  const updatedProvider = database.updateProviderConnection(provider.id, { defaultModel: 'image-model-v2' })
  assert.equal(updatedProvider?.configRevision, 2)
  assert.deepEqual(database.getProviderConnectionVersion(provider.id, 1), {
    providerId: provider.id,
    configRevision: 1,
    kind: 'image',
    adapter: 'openai-images',
    baseUrl: 'https://images.example.test/v1',
    model: 'image-model',
    authMode: 'byok',
    credentialReference: { service: 'com.manju.provider', account: 'provider-1' },
    executionConfig: { timeoutMs: 30_000 },
    createdAt: provider.updatedAt,
  })
  assert.equal(database.getProviderConnectionVersion(provider.id, 2)?.model, 'image-model-v2')

  const job = database.createGenerationJob({
    id: 'job-1',
    projectId: project.id,
    type: 'asset.image.generate',
    providerId: provider.id,
    providerConfigRevision: updatedProvider?.configRevision,
    idempotencyKey: 'generate:shot-1:v1',
    input: { prompt: 'mountain gate' },
    providerState: { phase: 'submitted', pollAttempt: 0 },
    progressDetail: { stage: 'provider queue' },
  })
  assert.equal(database.findGenerationJobByIdempotencyKey(project.id, 'generate:shot-1:v1')?.id, job.id)
  assert.throws(() => database.createGenerationJob({
    id: 'job-duplicate',
    projectId: project.id,
    type: 'asset.image.generate',
    idempotencyKey: 'generate:shot-1:v1',
    input: { prompt: 'must not be billed twice' },
  }), /UNIQUE constraint failed/)

  const asset = database.createMediaAsset({
    id: 'asset-1',
    projectId: project.id,
    kind: 'storyboard',
    filePath: 'media/project-1/asset-1.png',
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    source: 'provider',
    providerId: provider.id,
    generationJobId: job.id,
    generationParameters: { prompt: 'mountain gate' },
    sourceRevisionId: revision.id,
  })
  database.updateGenerationJob(job.id, {
    status: 'succeeded',
    progress: 100,
    providerState: { phase: 'completed', providerTaskId: 'provider-task-1' },
    progressDetail: { stage: 'downloaded' },
    output: { assetIds: [asset.id] },
    completedAt: '2026-07-14T00:00:10.000Z',
  })
  const waitingJob = database.createGenerationJob({
    id: 'job-waiting-provider',
    projectId: project.id,
    type: 'shot.video.generate',
    status: 'waiting_provider',
    progress: 35,
    providerId: provider.id,
    providerConfigRevision: updatedProvider?.configRevision,
    externalTaskId: 'seedance-task-1',
    input: { shotId: 'shot-1' },
    providerState: { phase: 'processing', lastProviderStatus: 'running', pollAttempt: 3 },
    progressDetail: { stage: 'Seedance processing', percentSource: 'provider' },
  })

  assert.throws(() => database.transaction((transaction) => {
    transaction.createProject({ id: 'rolled-back', title: 'rollback me' })
    throw new Error('force rollback')
  }), /force rollback/)
  assert.equal(database.getProject('rolled-back'), undefined)
  database.close()

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  assert.equal(database.getProject(project.id)?.currentRevisionId, revision.id)
  assert.deepEqual(database.getRevision(revision.id)?.snapshot, { title: 'MVP', shots: [] })
  assert.equal(database.getProviderConnection(provider.id)?.credentialReference?.service, 'com.manju.provider')
  assert.deepEqual(
    database.listProviderConnectionVersions(provider.id).map((version) => version.configRevision),
    [1, 2],
  )
  assert.equal(database.getGenerationJob(job.id)?.status, 'succeeded')
  assert.deepEqual(database.getGenerationJob(job.id)?.providerState, {
    phase: 'completed',
    providerTaskId: 'provider-task-1',
  })
  assert.deepEqual(database.getGenerationJob(job.id)?.progressDetail, { stage: 'downloaded' })
  assert.equal(database.getGenerationJob(waitingJob.id)?.status, 'waiting_provider')
  assert.equal(database.getGenerationJob(waitingJob.id)?.externalTaskId, 'seedance-task-1')
  assert.deepEqual(database.getGenerationJob(waitingJob.id)?.providerState, {
    phase: 'processing',
    lastProviderStatus: 'running',
    pollAttempt: 3,
  })
  assert.equal(database.getMediaAsset(asset.id)?.generationJobId, job.id)
  assert.equal(database.listGenerationJobs({ projectId: project.id }).length, 2)
  assert.equal(database.listMediaAssets({ projectId: project.id }).length, 1)

  assert.throws(() => database.createProviderConnection({
    id: 'unsafe-provider',
    kind: 'text',
    adapter: 'openai-compatible',
    displayName: 'Unsafe',
    authMode: 'byok',
    config: { apiKey: 'plaintext-secret' } as never,
  }), /must be stored in Keychain/)
  assert.equal(database.getProviderConnection('unsafe-provider'), undefined)
  assert.throws(() => database.createProviderConnection({
    id: 'unsafe-url-provider',
    kind: 'text',
    adapter: 'openai-compatible',
    displayName: 'Unsafe URL',
    baseUrl: 'https://user:plaintext-secret@example.test/v1',
    authMode: 'byok',
  }), /must not contain credentials/)
  assert.equal(database.getProviderConnection('unsafe-url-provider'), undefined)
  database.close()

  const databaseBytes = await readFile(join(runtimeDirectory, 'manju.sqlite'))
  assert.equal(databaseBytes.includes(Buffer.from('plaintext-secret')), false)
})

test('typed pipeline runs are scoped, idempotent, validated, transactional, and restart-safe', async () => {
  const runtimeDirectory = await temporaryDirectory()
  let tick = 0
  const now = () => `2026-07-14T00:10:${String(tick++).padStart(2, '0')}.000Z`
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false, now })
  const rejectsCrossProject = (write: () => unknown) => assert.throws(
    write,
    (error: unknown) => error instanceof DatabaseIntegrityError
      && error.code === 'CROSS_PROJECT_REFERENCE',
  )

  database.createProject({ id: 'pipeline-project-a', title: 'Pipeline A' })
  database.createProject({ id: 'pipeline-project-b', title: 'Pipeline B' })
  insertEpisode(database, 'pipeline-episode-a', 'pipeline-project-a')
  insertEpisode(database, 'pipeline-episode-b', 'pipeline-project-b')
  const revisionA = database.createRevision({
    id: 'pipeline-revision-a',
    projectId: 'pipeline-project-a',
    summary: 'A',
    snapshot: {},
  })
  const revisionB = database.createRevision({
    id: 'pipeline-revision-b',
    projectId: 'pipeline-project-b',
    summary: 'B',
    snapshot: {},
  })
  const run = database.createPipelineRun({
    id: 'pipeline-run-a',
    projectId: 'pipeline-project-a',
    episodeId: 'pipeline-episode-a',
    idempotencyKey: 'produce:pipeline-revision-a',
    sourceRevisionId: revisionA.id,
    steps: {
      storyboard: { status: 'queued' },
      export: { status: 'queued' },
    },
  })
  assert.equal(run.status, 'queued')
  assert.equal(run.progress, 0)
  assert.equal(run.sourceRevisionId, revisionA.id)
  assert.equal(
    database.findPipelineRunByIdempotencyKey('pipeline-project-a', 'produce:pipeline-revision-a')?.id,
    run.id,
  )
  assert.equal(
    database.findPipelineRunByIdempotencyKey('pipeline-project-b', 'produce:pipeline-revision-a'),
    undefined,
  )

  assert.throws(() => database.createPipelineRun({
    id: 'pipeline-run-duplicate',
    projectId: 'pipeline-project-a',
    idempotencyKey: 'produce:pipeline-revision-a',
  }), /UNIQUE constraint failed/)
  const otherProjectRun = database.createPipelineRun({
    id: 'pipeline-run-b',
    projectId: 'pipeline-project-b',
    episodeId: 'pipeline-episode-b',
    idempotencyKey: 'produce:pipeline-revision-a',
    sourceRevisionId: revisionB.id,
  })
  assert.equal(otherProjectRun.idempotencyKey, run.idempotencyKey)

  rejectsCrossProject(() => database.createPipelineRun({
    id: 'pipeline-cross-episode',
    projectId: 'pipeline-project-a',
    episodeId: 'pipeline-episode-b',
  }))
  rejectsCrossProject(() => database.createPipelineRun({
    id: 'pipeline-cross-revision',
    projectId: 'pipeline-project-a',
    sourceRevisionId: revisionB.id,
  }))
  assert.throws(() => database.createPipelineRun({
    id: 'pipeline-invalid-status',
    projectId: 'pipeline-project-a',
    status: 'blocked' as never,
  }), /Unsupported pipeline run status/)
  assert.throws(() => database.createPipelineRun({
    id: 'pipeline-invalid-progress',
    projectId: 'pipeline-project-a',
    progress: Number.NaN,
  }), /pipeline run progress/)
  assert.throws(() => database.createPipelineRun({
    id: 'pipeline-array-steps',
    projectId: 'pipeline-project-a',
    steps: [] as never,
  }), /plain JSON object/)
  assert.throws(() => database.createPipelineRun({
    id: 'pipeline-non-finite-steps',
    projectId: 'pipeline-project-a',
    steps: { percent: Number.POSITIVE_INFINITY } as never,
  }), /non-finite number/)
  assert.throws(() => database.createPipelineRun({
    id: 'pipeline-array-error',
    projectId: 'pipeline-project-a',
    error: [] as never,
  }), /plain JSON object/)

  assert.throws(() => database.transaction((transaction) => {
    transaction.createPipelineRun({
      id: 'pipeline-rolled-back',
      projectId: 'pipeline-project-a',
      idempotencyKey: 'produce:rolled-back',
    })
    throw new Error('roll back pipeline run')
  }), /roll back pipeline run/)
  assert.equal(database.getPipelineRun('pipeline-rolled-back'), undefined)

  const attachedJob = database.createGenerationJob({
    id: 'pipeline-job-a',
    projectId: 'pipeline-project-a',
    episodeId: 'pipeline-episode-a',
    pipelineRunId: run.id,
    type: 'pipeline.storyboard',
    input: {},
  })
  database.createGenerationJob({
    id: 'pipeline-unattached-job',
    projectId: 'pipeline-project-a',
    episodeId: 'pipeline-episode-a',
    type: 'asset.image.generate',
    input: {},
  })
  assert.deepEqual(
    database.listGenerationJobs({ pipelineRunId: run.id }).map((job) => job.id),
    [attachedJob.id],
  )

  const running = database.updatePipelineRun(run.id, {
    status: 'running',
    progress: 45,
    steps: {
      storyboard: { status: 'succeeded' },
      export: { status: 'running' },
    },
  })!
  assert.equal(running.status, 'running')
  assert.equal(running.progress, 45)
  assert.throws(() => database.updatePipelineRun(run.id, {
    status: 'blocked' as never,
  }), /Unsupported pipeline run status/)
  assert.throws(() => database.updatePipelineRun(run.id, {
    progress: 101,
  }), /pipeline run progress/)
  assert.throws(() => database.updatePipelineRun(run.id, {
    steps: [] as never,
  }), /plain JSON object/)
  assert.equal(database.getPipelineRun(run.id)?.status, 'running')

  const completedAt = '2026-07-14T00:20:00.000Z'
  const completed = database.updatePipelineRun(run.id, {
    status: 'succeeded',
    progress: 100,
    steps: {
      storyboard: { status: 'succeeded' },
      export: { status: 'succeeded' },
    },
    error: null,
    completedAt,
  })!
  assert.equal(completed.completedAt, completedAt)
  assert.deepEqual(
    database.listPipelineRuns({ projectId: 'pipeline-project-a', status: 'succeeded' })
      .map((pipelineRun) => pipelineRun.id),
    [run.id],
  )
  assert.throws(() => database.listPipelineRuns({ status: 'blocked' as never }), /Unsupported pipeline run status/)
  assert.equal(database.updatePipelineRun('missing-pipeline-run', { status: 'cancelled' }), undefined)

  database.close()
  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  try {
    assert.deepEqual(database.getPipelineRun(run.id), completed)
    assert.equal(
      database.findPipelineRunByIdempotencyKey('pipeline-project-a', 'produce:pipeline-revision-a')?.id,
      run.id,
    )
    assert.deepEqual(
      database.listGenerationJobs({ pipelineRunId: run.id }).map((job) => job.id),
      [attachedJob.id],
    )
  } finally {
    database.close()
  }
})

test('a deferred foreign-key failure at COMMIT rolls back and restores transaction depth', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    assert.throws(
      () => database.transaction((transaction) => {
        transaction.createProject({
          id: 'deferred-fk-failure',
          title: 'must roll back',
          currentEpisodeId: 'missing-episode',
        })
      }),
      /FOREIGN KEY constraint failed/,
    )
    assert.equal(database.getProject('deferred-fk-failure'), undefined)

    // The failed COMMIT used to decrement transactionDepth twice. A subsequent
    // top-level transaction was then opened as a savepoint and close() observed
    // a negative phantom depth. Both operations must remain healthy.
    const recovered = database.transaction((transaction) => transaction.createProject({
      id: 'after-deferred-failure',
      title: 'healthy transaction',
    }))
    assert.equal(recovered.id, 'after-deferred-failure')
    assert.equal(database.health().quickCheck, 'ok')
  } finally {
    assert.doesNotThrow(() => database.close())
  }
})

test('typed writes reject cross-project references and project deletion cannot cascade into another project', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  const rejectsCrossProject = (write: () => unknown) => assert.throws(
    write,
    (error: unknown) => error instanceof DatabaseIntegrityError
      && error.code === 'CROSS_PROJECT_REFERENCE',
  )
  try {
    database.createProject({ id: 'project-a', title: 'Project A' })
    database.createProject({ id: 'project-b', title: 'Project B' })
    insertEpisode(database, 'episode-a', 'project-a')
    insertEpisode(database, 'episode-b', 'project-b')
    insertPipelineRun(database, 'pipeline-a', 'project-a', 'episode-a')
    insertPipelineRun(database, 'pipeline-b', 'project-b', 'episode-b')
    const revisionA = database.createRevision({
      id: 'revision-a',
      projectId: 'project-a',
      summary: 'A',
      snapshot: {},
    })
    const revisionB = database.createRevision({
      id: 'revision-b',
      projectId: 'project-b',
      summary: 'B',
      snapshot: {},
    })
    const jobA = database.createGenerationJob({
      id: 'job-a',
      projectId: 'project-a',
      episodeId: 'episode-a',
      pipelineRunId: 'pipeline-a',
      type: 'asset.image.generate',
      input: {},
    })
    const jobB = database.createGenerationJob({
      id: 'job-b',
      projectId: 'project-b',
      episodeId: 'episode-b',
      pipelineRunId: 'pipeline-b',
      type: 'asset.image.generate',
      input: {},
    })
    const assetA = database.createMediaAsset({
      id: 'asset-a',
      projectId: 'project-a',
      episodeId: 'episode-a',
      generationJobId: jobA.id,
      sourceRevisionId: revisionA.id,
      kind: 'storyboard',
      source: 'fixture',
    })
    const assetB = database.createMediaAsset({
      id: 'asset-b',
      projectId: 'project-b',
      episodeId: 'episode-b',
      generationJobId: jobB.id,
      sourceRevisionId: revisionB.id,
      kind: 'storyboard',
      source: 'fixture',
    })

    rejectsCrossProject(() => database.createGenerationJob({
      id: 'cross-job-episode',
      projectId: 'project-a',
      episodeId: 'episode-b',
      type: 'story.generate',
      input: {},
    }))
    rejectsCrossProject(() => database.createGenerationJob({
      id: 'cross-job-pipeline',
      projectId: 'project-a',
      pipelineRunId: 'pipeline-b',
      type: 'story.generate',
      input: {},
    }))
    rejectsCrossProject(() => database.createGenerationJob({
      id: 'cross-job-retry',
      projectId: 'project-a',
      retryOf: jobB.id,
      type: 'story.generate',
      input: {},
    }))
    rejectsCrossProject(() => database.updateGenerationJob(jobA.id, { retryOf: jobB.id }))

    const createCrossAsset = (
      id: string,
      references: Partial<Parameters<ManjuDatabase['createMediaAsset']>[0]>,
    ) =>
      database.createMediaAsset({
        ...references,
        id,
        projectId: 'project-a',
        kind: 'storyboard',
        source: 'fixture',
      })
    rejectsCrossProject(() => createCrossAsset('cross-asset-episode', { episodeId: 'episode-b' }))
    rejectsCrossProject(() => createCrossAsset('cross-asset-job', { generationJobId: jobB.id }))
    rejectsCrossProject(() => createCrossAsset('cross-asset-revision', { sourceRevisionId: revisionB.id }))
    rejectsCrossProject(() => createCrossAsset('cross-asset-parent', { parentAssetId: assetB.id }))
    rejectsCrossProject(() => database.updateMediaAsset(assetA.id, { episodeId: 'episode-b' }))
    rejectsCrossProject(() => database.updateMediaAsset(assetA.id, { generationJobId: jobB.id }))
    rejectsCrossProject(() => database.updateMediaAsset(assetA.id, { sourceRevisionId: revisionB.id }))
    rejectsCrossProject(() => database.updateMediaAsset(assetA.id, { parentAssetId: assetB.id }))

    rejectsCrossProject(() => database.createRevision({
      id: 'cross-revision',
      projectId: 'project-a',
      parentRevisionId: revisionB.id,
      summary: 'cross',
      snapshot: {},
    }))
    rejectsCrossProject(() => database.updateRevision(revisionA.id, { parentRevisionId: revisionB.id }))
    rejectsCrossProject(() => database.createProject({
      id: 'project-c',
      title: 'Project C',
      currentEpisodeId: 'episode-b',
    }))
    rejectsCrossProject(() => database.updateProject('project-a', { currentEpisodeId: 'episode-b' }))
    rejectsCrossProject(() => database.updateProject('project-a', { currentRevisionId: revisionB.id }))

    database.updateProject('project-a', {
      currentEpisodeId: 'episode-a',
      currentRevisionId: revisionA.id,
    })
    assert.equal(database.deleteProject('project-b'), true)
    assert.equal(database.getGenerationJob(jobA.id)?.projectId, 'project-a')
    assert.equal(database.getMediaAsset(assetA.id)?.projectId, 'project-a')
    assert.equal(database.getProject('project-a')?.currentEpisodeId, 'episode-a')
    assert.equal(database.getProject('project-a')?.currentRevisionId, revisionA.id)
    assert.equal(database.getGenerationJob(jobB.id), undefined)
    assert.equal(database.getMediaAsset(assetB.id), undefined)
  } finally {
    database.close()
  }
})

test('provider runtime health/default metadata does not advance generation config revisions', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    const created = database.createProviderConnection({
      id: 'provider-config-test',
      kind: 'image',
      adapter: 'openai-compatible',
      displayName: 'Provider',
      baseUrl: 'https://images.example.test/v1',
      defaultModel: 'image-v1',
      authMode: 'byok',
      config: { timeoutMs: 30_000, isDefault: false },
    })
    assert.equal(created.configRevision, 1)

    const runtimeOnly = database.updateProviderConnection(created.id, {
      config: {
        timeoutMs: 30_000,
        isDefault: true,
        lastTestedAt: '2026-07-14T02:00:00.000Z',
        lastTestStatus: 'ok',
        lastTestMessage: 'connected',
      },
      enabled: true,
    })
    assert.equal(runtimeOnly?.configRevision, 1)

    const optionChanged = database.updateProviderConnection(created.id, {
      config: { ...runtimeOnly!.config, timeoutMs: 45_000 },
    })
    assert.equal(optionChanged?.configRevision, 2)
    assert.equal(database.updateProviderConnection(created.id, {
      baseUrl: 'https://images-2.example.test/v1',
    })?.configRevision, 3)
    assert.equal(database.updateProviderConnection(created.id, {
      defaultModel: 'image-v2',
    })?.configRevision, 4)
    assert.equal(database.updateProviderConnection(created.id, {
      authMode: 'none',
    })?.configRevision, 5)
    assert.equal(database.updateProviderConnection(created.id, {
      credentialReference: { service: 'com.manju.provider', account: 'provider-config-test' },
    })?.configRevision, 6)

    const healthAgain = database.updateProviderConnection(created.id, {
      config: {
        ...database.getProviderConnection(created.id)!.config,
        isDefault: false,
        lastTestStatus: 'degraded',
        lastTestMessage: 'rate limited',
      },
    })
    assert.equal(healthAgain?.configRevision, 6)
    const versions = database.listProviderConnectionVersions(created.id)
    assert.deepEqual(versions.map((version) => version.configRevision), [1, 2, 3, 4, 5, 6])
    assert.deepEqual(versions[0].executionConfig, { timeoutMs: 30_000 })
    assert.deepEqual(versions[1].executionConfig, { timeoutMs: 45_000 })
    assert.equal(versions[0].model, 'image-v1')
    assert.equal(versions.at(-1)?.model, 'image-v2')
    assert.equal(JSON.stringify(versions).includes('lastTestMessage'), false)
    assert.throws(
      () => database.withSql((sql) => sql.run(`
        UPDATE provider_connection_versions SET model = 'mutated'
         WHERE provider_id = 'provider-config-test' AND config_revision = 1
      `)),
      /immutable/,
    )
    assert.throws(
      () => database.withSql((sql) => sql.run(`
        DELETE FROM provider_connection_versions
         WHERE provider_id = 'provider-config-test' AND config_revision = 1
      `)),
      /immutable/,
    )
  } finally {
    database.close()
  }
})

test('legacy state import is read-only, sanitized, complete, idempotent, and restart-safe', async () => {
  const runtimeDirectory = await temporaryDirectory()
  const legacyPath = join(runtimeDirectory, 'state.json')
  const forbiddenSecret = 'legacy-secret-must-not-enter-sqlite'
  const legacyState = {
    version: 1,
    project: {
      id: 'legacy-project',
      title: 'Legacy Story',
      sourceText: 'A short source story.',
      settings: { style: 'national-comic', aspect: '9:16', apiKey: forbiddenSecret },
      shots: [
        {
          id: 1,
          code: '01A',
          title: 'Opening',
          framing: 'wide',
          movement: 'push',
          duration: '3.2s',
          copy: 'The city appears.',
          dialogue: 'Narrator: The story begins.',
          status: 'approved',
          imageUrl: '/generated/legacy-frame.png',
          jobId: 'legacy-job',
        },
      ],
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T01:00:00.000Z',
    },
    jobs: [
      {
        id: 'legacy-job',
        type: 'image.generate',
        status: 'succeeded',
        progress: 100,
        attempt: 1,
        createdAt: '2026-07-13T00:30:00.000Z',
        updatedAt: '2026-07-13T00:31:00.000Z',
        completedAt: '2026-07-13T00:31:00.000Z',
        input: {
          prompt: 'legacy prompt',
          authorization: forbiddenSecret,
          metadata: { projectId: 'legacy-project', shotId: 1 },
        },
        output: {
          images: [{
            id: 'legacy-asset',
            url: '/generated/legacy-frame.png',
            mimeType: 'image/png',
            width: 1536,
            height: 1024,
          }],
        },
      },
    ],
  }
  await writeFile(legacyPath, `${JSON.stringify(legacyState, null, 2)}\n`, { mode: 0o400 })
  const originalBytes = await readFile(legacyPath)
  const originalMode = (await stat(legacyPath)).mode

  let database = initializeDatabase({ runtimeDirectory })
  const imports = database.listLegacyImports()
  assert.equal(imports.length, 1)
  assert.equal(imports[0].projectId, 'legacy-project')
  assert.deepEqual(imports[0].counts, {
    projects: 1,
    episodes: 1,
    revisions: 1,
    scenes: 1,
    shots: 1,
    dialogueLines: 1,
    jobs: 1,
    assets: 1,
  })
  assert.equal(database.getProject('legacy-project')?.title, 'Legacy Story')
  assert.equal(database.getProject('legacy-project')?.settings.apiKey, undefined)
  assert.equal(database.getGenerationJob('legacy-job')?.input.authorization, undefined)
  assert.equal(database.getMediaAsset('legacy-asset')?.filePath, 'generated/legacy-frame.png')
  assert.equal(database.listRevisions('legacy-project').length, 1)
  assert.deepEqual(database.importLegacyState(legacyPath), {
    status: 'already-imported',
    sourcePath: legacyPath,
    projectId: 'legacy-project',
  })
  database.close()

  assert.deepEqual(await readFile(legacyPath), originalBytes)
  assert.equal((await stat(legacyPath)).mode, originalMode)
  const sqliteBytes = await readFile(join(runtimeDirectory, 'manju.sqlite'))
  assert.equal(sqliteBytes.includes(Buffer.from(forbiddenSecret)), false)

  database = initializeDatabase({ runtimeDirectory })
  assert.equal(database.listLegacyImports().length, 1)
  assert.equal(database.listProjects().length, 1)
  assert.equal(database.listGenerationJobs().length, 1)
  assert.equal(database.listMediaAssets({ projectId: 'legacy-project' }).length, 1)
  assert.equal(database.deleteProject('legacy-project'), true)
  assert.equal(database.listLegacyImports().length, 1)
  database.close()

  assert.deepEqual(await readFile(legacyPath), originalBytes)

  // The durable import tombstone prevents a user-deleted legacy project from
  // reappearing merely because the read-only state.json is still present.
  database = initializeDatabase({ runtimeDirectory })
  assert.equal(database.listProjects().length, 0)
  assert.equal(database.listLegacyImports().length, 1)
  database.close()
})
