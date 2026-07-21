import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AssetLockError,
  AssetLockService,
  CharacterVisualReferenceLockService,
  type AssetLockTargetType,
} from './asset-locking.js'
import { TURNAROUND_DERIVATION_ALGORITHM } from './asset-turnaround-derivation.js'
import { createApplication } from './app-v1.js'
import {
  initializeDatabase,
  type ManjuDatabase,
} from './database.js'
import { episodeEtag } from './episode-version.js'
import type { ImageProvider } from './types.js'
import { listVisualAssetTargets } from './visual-asset-generation.js'

const NOW = '2026-07-14T00:00:00.000Z'

interface LockFixture {
  database: ManjuDatabase
  projectId: string
  episodeId: string
  sourceRevisionId: string
}

function insertEpisodeGraph(
  database: ManjuDatabase,
  projectId: string,
  episodeId: string,
  sourceRevisionId: string,
): void {
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
        style_preset, status, sort_order, metadata_json, source_revision_id,
        created_at, updated_at
      ) VALUES (?, ?, '锁定测试', '', 30, '16:9', '国风', 'draft', 0, ?, ?, ?, ?)
    `, episodeId, projectId, JSON.stringify({ storyVersion: 1 }), sourceRevisionId, NOW, NOW)
    for (const [table, id, storyId, name] of [
      ['characters', 'character-row', 'hero', '阿离'],
      ['locations', 'location-row', 'cliff', '断崖'],
      ['props', 'prop-row', 'token', '青铜令'],
    ] as const) {
      sql.run(`
        INSERT INTO ${table} (
          id, project_id, episode_id, name, story_description, visual_description,
          version, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', '', 1, ?, ?, ?)
      `, id, projectId, episodeId, name, JSON.stringify({ storyId, sequence: 0 }), NOW, NOW)
    }
  })
  database.updateProject(projectId, { currentEpisodeId: episodeId })
}

function fixture(): LockFixture {
  let sequence = 0
  const database = initializeDatabase({
    databasePath: ':memory:',
    legacyStatePath: false,
    now: () => NOW,
    idFactory: () => `generated-${++sequence}`,
  })
  const projectId = 'project-lock'
  const episodeId = 'episode-lock'
  database.createProject({ id: projectId, title: '锁定项目' })
  const revision = database.createRevision({
    id: 'story-revision-1',
    projectId,
    summary: '结构化剧本',
    snapshot: { version: 1, kind: 'story' },
  })
  database.updateProject(projectId, { currentRevisionId: revision.id })
  insertEpisodeGraph(database, projectId, episodeId, revision.id)
  return { database, projectId, episodeId, sourceRevisionId: revision.id }
}

function createImage(
  fixtureValue: LockFixture,
  input: {
    id: string
    kind?: string
    status?: string
    mimeType?: string
    sourceRevisionId?: string | null
    episodeId?: string
    generationJobId?: string
  },
): void {
  fixtureValue.database.createMediaAsset({
    id: input.id,
    projectId: fixtureValue.projectId,
    episodeId: input.episodeId ?? fixtureValue.episodeId,
    kind: input.kind ?? 'character-turnaround',
    status: input.status ?? 'ready',
    mimeType: input.mimeType ?? 'image/png',
    source: 'provider',
    sourceRevisionId: input.sourceRevisionId === undefined
      ? fixtureValue.sourceRevisionId
      : input.sourceRevisionId,
    generationJobId: input.generationJobId,
  })
}

function createTurnaroundFamily(
  fixtureValue: LockFixture,
  prefix = 'turnaround',
  algorithm = TURNAROUND_DERIVATION_ALGORITHM,
): { sourceAssetId: string; frontAssetId: string; sideAssetId: string; backAssetId: string; jobId: string } {
  const { database, projectId, episodeId, sourceRevisionId } = fixtureValue
  const sourceAssetId = `${prefix}-source`
  const sourceJobId = `${prefix}-source-job`
  const jobId = `${prefix}-derive-job`
  const binding = {
    episodeId,
    entityType: 'character',
    entityId: 'hero',
    databaseEntityId: 'character-row',
    expectedRevisionId: sourceRevisionId,
    parentAssetId: null,
    nextVersion: 1,
  }
  const sourceChecksum = 'a'.repeat(64)
  database.createGenerationJob({
    id: sourceJobId,
    projectId,
    episodeId,
    type: 'asset.image.generate',
    status: 'succeeded',
    progress: 100,
    input: { assetEntityBinding: binding },
    output: { images: [{ id: sourceAssetId }] },
  })
  database.createMediaAsset({
    id: sourceAssetId,
    projectId,
    episodeId,
    kind: 'character-turnaround',
    status: 'ready',
    mimeType: 'image/png',
    width: 300,
    height: 100,
    checksum: sourceChecksum,
    source: 'provider',
    generationJobId: sourceJobId,
    generationParameters: { entityType: 'character', entityId: 'hero' },
    sourceRevisionId,
  })
  const source = {
    assetId: sourceAssetId,
    projectId,
    episodeId,
    checksum: sourceChecksum,
    version: 1,
    mimeType: 'image/png',
    width: 300,
    height: 100,
    sourceRevisionId,
    character: binding,
  }
  const ids = {
    front: `${prefix}-front`,
    side: `${prefix}-side`,
    back: `${prefix}-back`,
  } as const
  database.createGenerationJob({
    id: jobId,
    projectId,
    episodeId,
    type: 'asset.image.turnaround.derive',
    status: 'succeeded',
    progress: 100,
    input: {
      operation: 'asset.image.turnaround.derive',
      algorithm,
      sourceAssetId,
      source,
      crops: [],
      assetEntityBinding: binding,
    },
    output: {
      operation: 'asset.image.turnaround.derive',
      assets: Object.entries(ids).map(([role, id]) => ({ role, asset: { id } })),
    },
  })
  for (const [index, role] of (['front', 'side', 'back'] as const).entries()) {
    database.createMediaAsset({
      id: ids[role],
      projectId,
      episodeId,
      kind: `character-reference.${role}`,
      status: 'ready',
      mimeType: 'image/png',
      width: 100,
      height: 100,
      checksum: String(index + 1).repeat(64),
      source: 'derived',
      providerId: null,
      generationJobId: jobId,
      generationParameters: {
        operation: 'asset.image.turnaround.derive',
        algorithm,
        orientation: role,
        entityType: 'character',
        entityId: 'hero',
        assetEntityBinding: binding,
        source: {
          assetId: sourceAssetId,
          checksum: sourceChecksum,
          version: 1,
          width: 300,
          height: 100,
          sourceRevisionId,
        },
      },
      sourceRevisionId,
      parentAssetId: sourceAssetId,
    })
  }
  return {
    sourceAssetId,
    frontAssetId: ids.front,
    sideAssetId: ids.side,
    backAssetId: ids.back,
    jobId,
  }
}

function targetId(type: AssetLockTargetType): string {
  return type === 'character' ? 'hero' : type === 'location' ? 'cliff' : 'token'
}

function lock(
  fixtureValue: LockFixture,
  input: Partial<Parameters<AssetLockService['lock']>[0]> = {},
) {
  return new AssetLockService(fixtureValue.database).lock({
    assetId: 'asset-lock',
    projectId: fixtureValue.projectId,
    episodeId: fixtureValue.episodeId,
    targetType: 'character',
    targetId: 'hero',
    expectedRevisionId: fixtureValue.sourceRevisionId,
    ...input,
  })
}

function assertLockError(operation: () => unknown, code: AssetLockError['code']): AssetLockError {
  let captured: AssetLockError | undefined
  assert.throws(() => {
    try {
      operation()
    } catch (error) {
      if (error instanceof AssetLockError) captured = error
      throw error
    }
  }, (error: unknown) => {
    assert.ok(error instanceof AssetLockError)
    assert.equal(error.code, code)
    return true
  })
  assert.ok(captured)
  return captured
}

test('locks a current ready image, writes one audit revision, and stales only visual downstream', () => {
  const current = fixture()
  try {
    const { database, projectId, episodeId, sourceRevisionId } = current
    database.createGenerationJob({
      id: 'job-candidate',
      projectId,
      episodeId,
      type: 'asset.image.generate',
      status: 'succeeded',
      progress: 100,
      input: { metadata: { kind: 'character-turnaround', characterId: 'hero' } },
    })
    database.createGenerationJob({
      id: 'job-storyboard',
      projectId,
      episodeId,
      type: 'asset.image.generate',
      status: 'queued',
      input: { metadata: { kind: 'storyboard', shotId: 'shot-1' } },
    })
    database.createGenerationJob({
      id: 'job-video',
      projectId,
      episodeId,
      type: 'shot.video.generate',
      status: 'succeeded',
      progress: 100,
      input: { shotId: 'shot-1' },
    })
    database.createGenerationJob({
      id: 'job-export',
      projectId,
      episodeId,
      type: 'export.render',
      status: 'succeeded',
      progress: 100,
      input: { episodeId },
    })
    createImage(current, { id: 'asset-lock', generationJobId: 'job-candidate' })
    createImage(current, { id: 'asset-alternate' })
    createImage(current, { id: 'asset-storyboard', kind: 'storyboard', generationJobId: 'job-storyboard' })
    createImage(current, { id: 'asset-job-output', kind: 'custom.render', generationJobId: 'job-video' })
    createImage(current, { id: 'asset-video', kind: 'video', mimeType: 'video/mp4' })
    createImage(current, { id: 'asset-export', kind: 'final.video', mimeType: 'video/mp4' })
    database.withSql((sql) => {
      sql.run(`
        INSERT INTO pipeline_runs (
          id, project_id, episode_id, status, progress, steps_json, created_at, updated_at
        ) VALUES ('pipeline-lock', ?, ?, 'succeeded', 100, '{}', ?, ?)
      `, projectId, episodeId, NOW, NOW)
      sql.run(`
        INSERT INTO exports (
          id, project_id, episode_id, status, timeline_snapshot_json, output_asset_id,
          specification_json, created_at, updated_at
        ) VALUES ('export-lock', ?, ?, 'succeeded', '{}', 'asset-export', '{}', ?, ?)
      `, projectId, episodeId, NOW, NOW)
      sql.run(`
        INSERT INTO quality_reports (
          id, project_id, episode_id, export_id, status, checks_json, passed, created_at
        ) VALUES ('quality-lock', ?, ?, 'export-lock', 'passed', '{}', 1, ?)
      `, projectId, episodeId, NOW)
    })

    const result = lock(current)

    assert.equal(result.idempotent, false)
    assert.equal(result.auditRevision, true)
    assert.equal(result.sourceRevisionId, sourceRevisionId)
    assert.equal(result.target.id, 'hero')
    assert.equal(result.target.lockedAssetId, 'asset-lock')
    assert.equal(result.target.version, 2)
    assert.deepEqual(result.stale, {
      assets: 4,
      jobs: 3,
      exports: 1,
      qualityReports: 1,
      pipelineRuns: 1,
    })
    assert.equal(result.revision.snapshot.kind, 'asset.lock')
    assert.equal(result.revision.snapshot.sourceRevisionId, sourceRevisionId)
    assert.equal(database.getProject(projectId)?.currentRevisionId, sourceRevisionId)
    assert.equal(database.withSql((sql) => sql.get(
      "SELECT locked_asset_id FROM characters WHERE id = 'character-row'",
    ))?.locked_asset_id, 'asset-lock')

    for (const id of ['asset-storyboard', 'asset-job-output', 'asset-video', 'asset-export']) {
      assert.equal(database.getMediaAsset(id)?.status, 'stale', id)
    }
    assert.equal(database.getMediaAsset('asset-lock')?.status, 'ready')
    assert.equal(database.getMediaAsset('asset-alternate')?.status, 'ready')
    assert.equal(database.getGenerationJob('job-candidate')?.progressDetail.stale, undefined)
    assert.equal(database.getGenerationJob('job-storyboard')?.status, 'cancelled')
    assert.equal(database.getGenerationJob('job-storyboard')?.error?.code, 'STALE_VISUAL_LOCK')
    assert.equal(database.getGenerationJob('job-video')?.progressDetail.staleRevisionId, result.revision.id)
    assert.equal(database.health().quickCheck, 'ok')
  } finally {
    current.database.close()
  }
})

test('repeating the same lock is idempotent and creates no new revision or stale changes', () => {
  const current = fixture()
  try {
    createImage(current, { id: 'asset-lock' })
    const first = lock(current)
    const countAfterFirst = current.database.listRevisions(current.projectId).length
    const repeated = lock(current)
    assert.equal(repeated.idempotent, true)
    assert.equal(repeated.auditRevision, true)
    assert.equal(repeated.revision.id, first.revision.id)
    assert.deepEqual(repeated.stale, {
      assets: 0,
      jobs: 0,
      exports: 0,
      qualityReports: 0,
      pipelineRuns: 0,
    })
    assert.equal(current.database.listRevisions(current.projectId).length, countAfterFirst)
  } finally {
    current.database.close()
  }
})

test('all three public story entity types can be locked without exposing database IDs', () => {
  for (const type of ['character', 'location', 'prop'] as const) {
    const current = fixture()
    try {
      createImage(current, { id: 'asset-lock', kind: 'generated.image' })
      const result = lock(current, { targetType: type, targetId: targetId(type) })
      assert.deepEqual(result.target, {
        type,
        id: targetId(type),
        name: type === 'character' ? '阿离' : type === 'location' ? '断崖' : '青铜令',
        version: 2,
        lockedAssetId: 'asset-lock',
      })
      assert.equal('databaseId' in result.target, false)
    } finally {
      current.database.close()
    }
  }
})

test('rejects stale ETags, unsafe ownership, non-ready/non-image assets, and incompatible revisions', () => {
  const current = fixture()
  try {
    createImage(current, { id: 'asset-lock' })
    const stale = assertLockError(
      () => lock(current, { expectedRevisionId: 'old-revision' }),
      'REVISION_CONFLICT',
    )
    assert.deepEqual(stale.details, { currentRevisionId: current.sourceRevisionId })

    current.database.withSql((sql) => sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, aspect_ratio, style_preset, status,
        sort_order, metadata_json, source_revision_id, created_at, updated_at
      ) VALUES ('episode-other', ?, '其他分集', '', '16:9', '', 'draft', 1, '{}', ?, ?, ?)
    `, current.projectId, current.sourceRevisionId, NOW, NOW))
    createImage(current, { id: 'asset-other-episode', episodeId: 'episode-other' })
    assertLockError(
      () => lock(current, { assetId: 'asset-other-episode' }),
      'ASSET_NOT_FOUND',
    )

    createImage(current, { id: 'asset-pending', status: 'processing' })
    assertLockError(() => lock(current, { assetId: 'asset-pending' }), 'ASSET_NOT_READY')
    createImage(current, { id: 'asset-video-mime', mimeType: 'video/mp4' })
    assertLockError(() => lock(current, { assetId: 'asset-video-mime' }), 'ASSET_NOT_IMAGE')
    createImage(current, { id: 'asset-speech-kind', kind: 'speech', mimeType: 'image/png' })
    assertLockError(() => lock(current, { assetId: 'asset-speech-kind' }), 'ASSET_NOT_IMAGE')

    const otherRevision = current.database.createRevision({
      id: 'story-revision-other',
      projectId: current.projectId,
      parentRevisionId: current.sourceRevisionId,
      summary: '其他剧本版本',
      snapshot: { version: 1 },
    })
    createImage(current, { id: 'asset-old-source', sourceRevisionId: otherRevision.id })
    const mismatch = assertLockError(
      () => lock(current, { assetId: 'asset-old-source' }),
      'ASSET_SOURCE_REVISION_MISMATCH',
    )
    assert.deepEqual(mismatch.details, {
      currentRevisionId: current.sourceRevisionId,
      assetRevisionId: otherRevision.id,
    })
    assertLockError(() => lock(current, { targetId: 'missing' }), 'TARGET_NOT_FOUND')
  } finally {
    current.database.close()
  }
})

test('rejects ambiguous public target IDs and rolls back target/revision if stale propagation fails', () => {
  const current = fixture()
  try {
    createImage(current, { id: 'asset-lock' })
    current.database.withSql((sql) => sql.run(`
      INSERT INTO characters (
        id, project_id, episode_id, name, story_description, visual_description,
        version, metadata_json, created_at, updated_at
      ) VALUES ('character-duplicate', ?, ?, '重名实体', '', '', 1, ?, ?, ?)
    `, current.projectId, current.episodeId, JSON.stringify({ storyId: 'hero' }), NOW, NOW))
    assertLockError(() => lock(current), 'AMBIGUOUS_ASSET_LOCK_TARGET')
    current.database.withSql((sql) => sql.run(
      "DELETE FROM characters WHERE id = 'character-duplicate'",
    ))

    current.database.createGenerationJob({
      id: 'job-block-stale',
      projectId: current.projectId,
      episodeId: current.episodeId,
      type: 'shot.video.generate',
      status: 'queued',
      input: {},
    })
    const revisionCount = current.database.listRevisions(current.projectId).length
    current.database.withSql((sql) => sql.run(`
      CREATE TRIGGER block_asset_lock_stale
      BEFORE UPDATE ON generation_jobs
      BEGIN
        SELECT RAISE(ABORT, 'blocked stale propagation');
      END
    `))
    assert.throws(() => lock(current), /blocked stale propagation/)
    assert.equal(current.database.listRevisions(current.projectId).length, revisionCount)
    assert.equal(current.database.withSql((sql) => sql.get(
      "SELECT locked_asset_id FROM characters WHERE id = 'character-row'",
    ))?.locked_asset_id, null)
    assert.equal(current.database.getMediaAsset('asset-lock')?.status, 'ready')
    assert.equal(current.database.health().quickCheck, 'ok')
  } finally {
    current.database.close()
  }
})

test('atomically locks one authenticated turnaround family without replacing the primary character image', () => {
  const current = fixture()
  try {
    const family = createTurnaroundFamily(current)
    current.database.withSql((sql) => sql.run(
      "UPDATE characters SET locked_asset_id = ? WHERE id = 'character-row'",
      family.sourceAssetId,
    ))
    current.database.createGenerationJob({
      id: 'downstream-video-job',
      projectId: current.projectId,
      episodeId: current.episodeId,
      type: 'shot.video.generate',
      status: 'queued',
      input: {},
    })
    const revisionCount = current.database.listRevisions(current.projectId).length
    const service = new CharacterVisualReferenceLockService(current.database)
    const result = service.lock({
      projectId: current.projectId,
      episodeId: current.episodeId,
      targetId: 'hero',
      expectedRevisionId: current.sourceRevisionId,
      frontAssetId: family.frontAssetId,
      sideAssetId: family.sideAssetId,
      backAssetId: family.backAssetId,
    })

    assert.equal(result.idempotent, false)
    assert.equal(result.auditRevision, true)
    assert.equal(result.revision.snapshot.kind, 'character.visual-references.lock')
    assert.equal(result.target.version, 2)
    assert.equal(result.target.lockedAssetId, family.sourceAssetId)
    assert.deepEqual(result.target.references, {
      frontAssetId: family.frontAssetId,
      sideAssetId: family.sideAssetId,
      backAssetId: family.backAssetId,
      auditRevisionId: result.revision.id,
    })
    assert.deepEqual(result.stale, {
      assets: 0,
      jobs: 1,
      exports: 0,
      qualityReports: 0,
      pipelineRuns: 0,
    })
    assert.equal(current.database.listRevisions(current.projectId).length, revisionCount + 1)
    assert.equal(current.database.getProject(current.projectId)?.currentRevisionId, current.sourceRevisionId)
    assert.equal(current.database.getGenerationJob(family.jobId)?.progressDetail.stale, undefined)
    assert.equal(current.database.getGenerationJob('downstream-video-job')?.status, 'cancelled')
    const rows = current.database.withSql((sql) => sql.all(`
      SELECT role, asset_id, version, audit_revision_id
      FROM character_visual_references
      WHERE character_id = 'character-row'
      ORDER BY role
    `))
    assert.equal(rows.length, 3)
    assert.ok(rows.every((row) => row.version === 1 && row.audit_revision_id === result.revision.id))
    assert.equal(current.database.withSql((sql) => sql.get(
      "SELECT locked_asset_id FROM characters WHERE id = 'character-row'",
    ))?.locked_asset_id, family.sourceAssetId)

    const listed = listVisualAssetTargets(current.database, {
      projectId: current.projectId,
      episodeId: current.episodeId,
    }).find((target) => target.type === 'character' && target.id === 'hero')
    assert.deepEqual(listed?.lockedReferences, {
      frontAssetId: family.frontAssetId,
      sideAssetId: family.sideAssetId,
      backAssetId: family.backAssetId,
    })

    const replay = service.lock({
      projectId: current.projectId,
      episodeId: current.episodeId,
      targetId: 'hero',
      expectedRevisionId: current.sourceRevisionId,
      frontAssetId: family.frontAssetId,
      sideAssetId: family.sideAssetId,
      backAssetId: family.backAssetId,
    })
    assert.equal(replay.idempotent, true)
    assert.equal(replay.revision.id, result.revision.id)
    assert.deepEqual(replay.stale, {
      assets: 0,
      jobs: 0,
      exports: 0,
      qualityReports: 0,
      pipelineRuns: 0,
    })
    assert.equal(current.database.listRevisions(current.projectId).length, revisionCount + 1)
    assert.equal(replay.target.version, 2)
    assert.equal(current.database.health().quickCheck, 'ok')
    assert.equal(current.database.deleteProject(current.projectId), true)
    assert.equal(current.database.withSql((sql) => sql.get(
      'SELECT COUNT(*) AS count FROM character_visual_references',
    ))?.count, 0)
    assert.equal(current.database.health().quickCheck, 'ok')
  } finally {
    current.database.close()
  }
})

test('turnaround reference locking rejects mixed jobs and rolls back every slot on a partial SQL failure', () => {
  const current = fixture()
  try {
    const first = createTurnaroundFamily(current, 'family-a')
    const second = createTurnaroundFamily(current, 'family-b')
    const service = new CharacterVisualReferenceLockService(current.database)
    const base = {
      projectId: current.projectId,
      episodeId: current.episodeId,
      targetId: 'hero',
      expectedRevisionId: current.sourceRevisionId,
    }
    assertLockError(() => service.lock({
      ...base,
      frontAssetId: first.frontAssetId,
      sideAssetId: second.sideAssetId,
      backAssetId: first.backAssetId,
    }), 'ASSET_TURNAROUND_FAMILY_MISMATCH')
    assertLockError(() => service.lock({
      ...base,
      frontAssetId: first.sideAssetId,
      sideAssetId: first.frontAssetId,
      backAssetId: first.backAssetId,
    }), 'ASSET_TURNAROUND_ROLE_MISMATCH')

    const revisionCount = current.database.listRevisions(current.projectId).length
    current.database.withSql((sql) => sql.run(`
      CREATE TRIGGER block_side_reference
      BEFORE INSERT ON character_visual_references
      WHEN NEW.role = 'side'
      BEGIN
        SELECT RAISE(ABORT, 'blocked side reference');
      END
    `))
    assert.throws(() => service.lock({ ...base, ...first }), /blocked side reference/)
    assert.equal(current.database.listRevisions(current.projectId).length, revisionCount)
    assert.equal(current.database.withSql((sql) => sql.get(
      'SELECT COUNT(*) AS count FROM character_visual_references',
    ))?.count, 0)
    assert.equal(current.database.withSql((sql) => sql.get(
      "SELECT version FROM characters WHERE id = 'character-row'",
    ))?.version, 1)
    assert.equal(current.database.health().quickCheck, 'ok')
  } finally {
    current.database.close()
  }
})

const fixtureProvider: ImageProvider = {
  name: 'fixture',
  model: 'fixture-image',
  configured: true,
  async health() {
    return { status: 'ok', message: 'ready' }
  },
  async generate() {
    return []
  },
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return `http://127.0.0.1:${address.port}`
}

test('asset lock HTTP route requires episode If-Match and returns only public asset data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-asset-lock-http-'))
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider: fixtureProvider,
    autoStartWorker: false,
  })
  const server = createServer(runtime.app)
  try {
    const projectId = 'default'
    const sourceRevisionId = runtime.database.getProject(projectId)?.currentRevisionId
    assert.ok(sourceRevisionId)
    insertEpisodeGraph(runtime.database, projectId, 'episode-http-lock', sourceRevisionId)
    runtime.database.createMediaAsset({
      id: 'asset-http-lock',
      projectId,
      episodeId: 'episode-http-lock',
      kind: 'character-turnaround',
      status: 'ready',
      filePath: 'generated/private-file-name.png',
      mimeType: 'image/png',
      source: 'provider',
      sourceRevisionId,
    })
    const baseUrl = await listen(server)
    const requestBody = JSON.stringify({
      projectId,
      episodeId: 'episode-http-lock',
      targetType: 'character',
      targetId: 'hero',
    })
    const currentEtag = episodeEtag({ sourceRevisionId, updatedAt: NOW })

    const missingPrecondition = await fetch(`${baseUrl}/api/v1/assets/asset-http-lock/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    })
    assert.equal(missingPrecondition.status, 428)
    assert.equal((await missingPrecondition.json() as { error: { code: string } }).error.code, 'PRECONDITION_REQUIRED')

    const created = await fetch(`${baseUrl}/api/v1/assets/asset-http-lock/lock`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': currentEtag,
      },
      body: requestBody,
    })
    const createdBody = await created.json() as {
      asset: Record<string, unknown>
      target: Record<string, unknown>
      revision: { id: string }
      sourceRevisionId: string
      idempotent: boolean
    }
    assert.equal(created.status, 201)
    assert.equal(created.headers.get('etag'), currentEtag)
    assert.equal(created.headers.get('x-asset-lock-revision'), createdBody.revision.id)
    assert.equal(createdBody.sourceRevisionId, sourceRevisionId)
    assert.equal(createdBody.idempotent, false)
    assert.equal(createdBody.asset.url, '/api/v1/assets/asset-http-lock/content')
    assert.equal('filePath' in createdBody.asset, false)
    assert.equal('databaseId' in createdBody.target, false)

    const repeated = await fetch(`${baseUrl}/api/v1/assets/asset-http-lock/lock`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': currentEtag,
      },
      body: requestBody,
    })
    assert.equal(repeated.status, 200)
    const repeatedBody = await repeated.json() as { revision: { id: string }; idempotent: boolean }
    assert.equal(repeatedBody.idempotent, true)
    assert.equal(repeatedBody.revision.id, createdBody.revision.id)

    const conflict = await fetch(`${baseUrl}/api/v1/assets/asset-http-lock/lock`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': 'W/"obsolete"',
      },
      body: requestBody,
    })
    assert.equal(conflict.status, 412)
    assert.deepEqual(await conflict.json(), {
      error: {
        code: 'REVISION_CONFLICT',
        message: '分集已更新，请刷新后重试锁定',
        details: {
          currentRevisionId: sourceRevisionId,
          currentEtag,
        },
      },
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('character visual reference HTTP route is strictly scoped, ETag guarded, and replay safe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-character-references-http-'))
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider: fixtureProvider,
    autoStartWorker: false,
  })
  const server = createServer(runtime.app)
  try {
    const projectId = 'default'
    const episodeId = 'episode-http-references'
    const sourceRevisionId = runtime.database.getProject(projectId)?.currentRevisionId
    assert.ok(sourceRevisionId)
    insertEpisodeGraph(runtime.database, projectId, episodeId, sourceRevisionId)
    const family = createTurnaroundFamily({
      database: runtime.database,
      projectId,
      episodeId,
      sourceRevisionId,
    }, 'http-family', 'ffmpeg-crop-v1')
    const baseUrl = await listen(server)
    const etag = episodeEtag({ sourceRevisionId, updatedAt: NOW })
    const body = {
      projectId,
      episodeId,
      targetId: 'hero',
      frontAssetId: family.frontAssetId,
      sideAssetId: family.sideAssetId,
      backAssetId: family.backAssetId,
    }
    const endpoint = `${baseUrl}/api/v1/character-visual-references/lock`

    const missingPrecondition = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(missingPrecondition.status, 428)
    assert.equal((await missingPrecondition.json() as { error: { code: string } }).error.code, 'PRECONDITION_REQUIRED')

    const unknownField = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': etag },
      body: JSON.stringify({ ...body, databaseEntityId: 'character-row' }),
    })
    assert.equal(unknownField.status, 400)
    assert.equal((await unknownField.json() as { error: { code: string } }).error.code, 'INVALID_REQUEST')

    const created = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': etag },
      body: JSON.stringify(body),
    })
    const createdBody = await created.json() as {
      assets: Record<string, Record<string, unknown>>
      target: {
        id: string
        lockedAssetId: string | null
        references: Record<string, string>
      }
      revision: { id: string }
      stale: Record<string, number>
      idempotent: boolean
    }
    assert.equal(created.status, 201, JSON.stringify(createdBody))
    assert.equal(created.headers.get('etag'), etag)
    assert.equal(
      created.headers.get('x-character-visual-references-revision'),
      createdBody.revision.id,
    )
    assert.equal(createdBody.target.id, 'hero')
    assert.equal(createdBody.target.lockedAssetId, null)
    assert.equal(createdBody.target.references.frontAssetId, family.frontAssetId)
    assert.equal(createdBody.target.references.auditRevisionId, createdBody.revision.id)
    assert.deepEqual(Object.keys(createdBody.assets).sort(), ['back', 'front', 'side'])
    assert.ok(Object.values(createdBody.assets).every((asset) => !('filePath' in asset)))
    assert.equal(JSON.stringify(createdBody).includes('character-row'), false)

    const replay = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': etag },
      body: JSON.stringify(body),
    })
    const replayBody = await replay.json() as {
      revision: { id: string }
      stale: Record<string, number>
      idempotent: boolean
    }
    assert.equal(replay.status, 200)
    assert.equal(replayBody.idempotent, true)
    assert.equal(replayBody.revision.id, createdBody.revision.id)
    assert.deepEqual(replayBody.stale, {
      assets: 0,
      jobs: 0,
      exports: 0,
      qualityReports: 0,
      pipelineRuns: 0,
    })

    const stale = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': 'W/"obsolete"' },
      body: JSON.stringify(body),
    })
    assert.equal(stale.status, 412)
    assert.equal((await stale.json() as { error: { code: string } }).error.code, 'REVISION_CONFLICT')

    const targets = await fetch(
      `${baseUrl}/api/v1/episodes/${episodeId}/visual-asset-targets?projectId=${projectId}`,
    ).then((response) => response.json()) as {
      targets: Array<{ id: string; lockedReferences?: Record<string, string | null> }>
    }
    assert.deepEqual(targets.targets.find((target) => target.id === 'hero')?.lockedReferences, {
      frontAssetId: family.frontAssetId,
      sideAssetId: family.sideAssetId,
      backAssetId: family.backAssetId,
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
