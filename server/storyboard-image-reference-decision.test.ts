import assert from 'node:assert/strict'
import test from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import {
  assertCurrentStoryboardReferenceDecision,
  createStoryboardReferenceDecision,
  isStoryboardReferenceDecision,
  resolvePublicStoryboardShot,
  StoryboardImageError,
  type StoryboardShotTarget,
} from './storyboard-image-generation.js'
import { JobExecutionError } from './worker.js'

const PROJECT_ID = 'storyboard-reference-project'
const EPISODE_ID = 'storyboard-reference-episode'
const REVISION_ID = 'storyboard-reference-story-r1'
const NOW = '2026-07-15T04:00:00.000Z'

function fixture(): ManjuDatabase {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  database.createProject({ id: PROJECT_ID, title: '分镜视角参考决策' })
  database.createRevision({
    id: REVISION_ID,
    projectId: PROJECT_ID,
    summary: '当前 Story',
    snapshot: { version: 1, kind: 'story' },
    createdAt: NOW,
  })
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
        style_preset, status, sort_order, created_at, updated_at, metadata_json,
        source_revision_id
      ) VALUES (?, ?, '第一集', '', 30, '16:9', '国风', 'draft', 0, ?, ?, '{}', ?)
    `, EPISODE_ID, PROJECT_ID, NOW, NOW, REVISION_ID)
    sql.run(`
      INSERT INTO characters (
        id, project_id, episode_id, name, story_description, visual_description,
        locked_asset_id, version, metadata_json, created_at, updated_at
      ) VALUES ('character-ali', ?, ?, '阿离', '', '', NULL, 1, '{"storyId":"ali"}', ?, ?)
    `, PROJECT_ID, EPISODE_ID, NOW, NOW)
    sql.run(`
      INSERT INTO locations (
        id, project_id, episode_id, name, story_description, visual_description,
        locked_asset_id, version, metadata_json, created_at, updated_at
      ) VALUES ('location-cliff', ?, ?, '断崖', '', '', NULL, 1, '{"storyId":"cliff"}', ?, ?)
    `, PROJECT_ID, EPISODE_ID, NOW, NOW)
    sql.run(`
      INSERT INTO scenes (
        id, episode_id, sequence, title, description, duration_seconds,
        metadata_json, created_at, updated_at
      ) VALUES (
        'scene-row', ?, 0, '断崖龙吟', '黄昏云海', 30,
        '{"storyId":"scene-1","locationId":"cliff"}', ?, ?
      )
    `, EPISODE_ID, NOW, NOW)
    const shots = [
      ['front', '阿离正面面向镜头', '中景', '缓慢推进', '阿离正面站在断崖'],
      ['side', '阿离侧身看向云海', '全景', '横向跟拍', '阿离侧面剪影'],
      ['back', '阿离背对镜头走向远处', '全景', '缓慢拉远', '阿离背影'],
      ['conflict', '阿离正面看镜头同时呈现侧脸', '中景', '固定', '角色冲突视角'],
      ['unknown', '阿离站在断崖', '全景', '缓慢推进', '黄昏云海'],
    ] as const
    shots.forEach(([id, action, framing, movement, prompt], index) => {
      sql.run(`
        INSERT INTO shots (
          id, scene_id, sequence, code, title, description, framing, movement,
          transition, duration_seconds, timeline_start_seconds, prompt, status,
          source_revision_id, metadata_json, created_at, updated_at
        ) VALUES (?, 'scene-row', ?, ?, ?, ?, ?, ?, 'cut', 6, ?, ?, 'draft', ?, ?, ?, ?)
      `,
      `shot-${id}`,
      index,
      `S0-${index}`,
      id,
      action,
      framing,
      movement,
      index * 6,
      prompt,
      REVISION_ID,
      JSON.stringify({ storyId: `shot-${id}` }),
      NOW,
      NOW,
      )
    })
    sql.run(`
      INSERT INTO dialogue_lines (
        id, shot_id, character_id, sequence, kind, text, metadata_json, created_at, updated_at
      ) VALUES (
        'line-front', 'shot-front', 'character-ali', 0, 'dialogue', '我看见了。',
        '{"storyId":"line-front","speaker":"阿离"}', ?, ?
      )
    `, NOW, NOW)
  })

  database.createMediaAsset({
    id: 'asset-primary-turnaround-sheet',
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    kind: 'character-turnaround',
    status: 'ready',
    mimeType: 'image/png',
    checksum: '9'.repeat(64),
    source: 'fixture',
    sourceRevisionId: REVISION_ID,
  })
  database.withSql((sql) => sql.run(
    `UPDATE characters SET locked_asset_id = 'asset-primary-turnaround-sheet' WHERE id = 'character-ali'`,
  ))

  const slotAudit = database.createRevision({
    id: 'slot-audit-r1',
    projectId: PROJECT_ID,
    summary: '三视图槽位锁定',
    snapshot: { version: 1, kind: 'character.visual-references.lock' },
    createdAt: NOW,
  })
  for (const [index, view] of ['front', 'side', 'back'].entries()) {
    database.createMediaAsset({
      id: `asset-${view}`,
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      kind: `character-turnaround-${view}`,
      version: index + 1,
      status: 'ready',
      mimeType: 'image/png',
      checksum: String(index + 1).repeat(64),
      source: 'fixture',
      sourceRevisionId: REVISION_ID,
    })
    database.withSql((sql) => sql.run(`
      INSERT INTO character_visual_references (
        character_id, project_id, episode_id, role, asset_id, version,
        audit_revision_id, updated_at
      ) VALUES ('character-ali', ?, ?, ?, ?, 1, ?, ?)
    `, PROJECT_ID, EPISODE_ID, view, `asset-${view}`, slotAudit.id, NOW))
  }

  database.createMediaAsset({
    id: 'asset-location-cliff',
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    kind: 'location-concept',
    version: 4,
    status: 'ready',
    mimeType: 'image/png',
    checksum: 'a'.repeat(64),
    source: 'fixture',
    sourceRevisionId: REVISION_ID,
  })
  const locationAudit = database.createRevision({
    id: 'location-lock-audit-r1',
    projectId: PROJECT_ID,
    summary: '锁定断崖',
    snapshot: {
      version: 1,
      kind: 'asset.lock',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      target: {
        type: 'location',
        id: 'cliff',
        previousLockedAssetId: null,
        lockedAssetId: 'asset-location-cliff',
      },
      asset: { id: 'asset-location-cliff' },
      createdAt: NOW,
    },
    createdAt: NOW,
  })
  assert.equal(locationAudit.id, 'location-lock-audit-r1')
  database.withSql((sql) => sql.run(`
    UPDATE locations
    SET locked_asset_id = 'asset-location-cliff', version = 2
    WHERE id = 'location-cliff'
  `))
  database.updateProject(PROJECT_ID, {
    currentEpisodeId: EPISODE_ID,
    currentRevisionId: REVISION_ID,
  })
  return database
}

function target(database: ManjuDatabase, shotId: string): StoryboardShotTarget {
  return resolvePublicStoryboardShot(database, {
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sceneId: 'scene-1',
    shotId,
  })
}

test('storyboard target carries authoritative classifier context and dialogue subjects', () => {
  const database = fixture()
  try {
    const value = target(database, 'shot-front')
    assert.deepEqual(value.subjectNames, ['阿离'])
    assert.equal(value.scene, '断崖龙吟 黄昏云海')
    assert.equal(value.action, '阿离正面面向镜头')
    assert.equal(value.framing, '中景')
    assert.equal(value.movement, '缓慢推进')
    assert.equal(value.prompt, '阿离正面站在断崖')
  } finally {
    database.close()
  }
})

test('front/side/back decisions select derived slots, never the primary sheet, and keep current location last', () => {
  const database = fixture()
  try {
    for (const view of ['front', 'side', 'back'] as const) {
      const decision = createStoryboardReferenceDecision(database, target(database, `shot-${view}`), {
        useLockedReferences: true,
      })
      assert.equal(isStoryboardReferenceDecision(decision), true)
      assert.equal(decision.source, 'agentic_auto')
      assert.deepEqual(decision.referenceAssetIds, [`asset-${view}`, 'asset-location-cliff'])
      assert.equal(decision.referenceAssetIds.includes('asset-primary-turnaround-sheet'), false)
      assert.equal(decision.recommendation?.characters[0]?.view, view)
      assert.equal(decision.recommendation?.characters[0]?.slotVersion, 1)
      assert.equal(decision.recommendation?.characters[0]?.slotAuditRevisionId, 'slot-audit-r1')
      assert.equal(decision.recommendation?.characters[0]?.assetChecksum, ({
        front: '1', side: '2', back: '3',
      } as const)[view].repeat(64))
      assert.deepEqual(decision.locationPin, {
        databaseLocationId: 'location-cliff',
        locationId: 'cliff',
        locationName: '断崖',
        locationVersion: 2,
        assetId: 'asset-location-cliff',
        assetVersion: 4,
        assetChecksum: 'a'.repeat(64),
        assetSourceRevisionId: REVISION_ID,
        lockAuditRevisionId: 'location-lock-audit-r1',
      })
      assert.ok(decision.referenceAssetIds.length <= 4)
    }
  } finally {
    database.close()
  }
})

test('ambiguous storyboard direction uses the current front slot only as an identity anchor', () => {
  const database = fixture()
  try {
    for (const shotId of ['shot-conflict', 'shot-unknown']) {
      const decision = createStoryboardReferenceDecision(database, target(database, shotId), {
        useLockedReferences: true,
      })
      assert.equal(isStoryboardReferenceDecision(decision), true)
      assert.deepEqual(decision.referenceAssetIds, ['asset-front', 'asset-location-cliff'])
      assert.equal(decision.recommendation?.characters[0]?.view, 'front')
      assert.match(decision.recommendation?.rationale ?? '', /身份锚点/)
      assert.match(decision.recommendation?.rationale ?? '', /目标画面朝向仍由镜头 Prompt 决定/)
    }
    const optedOut = createStoryboardReferenceDecision(database, target(database, 'shot-conflict'), {
      useLockedReferences: false,
    })
    assert.equal(optedOut.source, 'explicit_opt_out')
    assert.equal(optedOut.recommendation, null)
    assert.equal(optedOut.locationPin, null)
    assert.deepEqual(optedOut.referenceAssetIds, [])
    assert.equal(isStoryboardReferenceDecision(optedOut), true)
  } finally {
    database.close()
  }
})

test('ambiguous storyboard direction still fails closed when a current front identity slot is unavailable', () => {
  const database = fixture()
  try {
    database.withSql((sql) => sql.run(`
      DELETE FROM character_visual_references
      WHERE character_id = 'character-ali' AND role = 'front'
    `))
    assert.throws(
      () => createStoryboardReferenceDecision(database, target(database, 'shot-unknown'), {
        useLockedReferences: true,
      }),
      (error: unknown) => error instanceof StoryboardImageError
        && error.code === 'STORYBOARD_REFERENCE_MANUAL_REQUIRED'
        && /缺少可验证的当前槽位/.test(error.message),
    )
  } finally {
    database.close()
  }
})

test('distant aerial silhouette can generate the first storyboard with location only', () => {
  const database = fixture()
  try {
    database.withSql((sql) => sql.run(`
      UPDATE shots
      SET description = '阿离只是云海远处的小小剪影',
          framing = '高空大全景',
          movement = '航拍俯瞰',
          prompt = '云海远处身影'
      WHERE id = 'shot-unknown'
    `))
    const decision = createStoryboardReferenceDecision(database, target(database, 'shot-unknown'), {
      useLockedReferences: true,
    })
    assert.equal(decision.recommendation?.status, 'not_applicable')
    assert.match(decision.recommendation?.rationale ?? '', /distant_character_not_required/)
    assert.deepEqual(decision.referenceAssetIds, ['asset-location-cliff'])
  } finally {
    database.close()
  }
})

test('paid-call validation rejects slot and current-scene location drift', () => {
  const database = fixture()
  try {
    const currentTarget = target(database, 'shot-side')
    const decision = createStoryboardReferenceDecision(database, currentTarget, {
      useLockedReferences: true,
    })
    assert.equal(assertCurrentStoryboardReferenceDecision(database, {
      target: currentTarget,
      decision,
      referenceAssetIds: decision.referenceAssetIds,
    }), decision)

    database.withSql((sql) => sql.run(`
      UPDATE character_visual_references
      SET version = version + 1
      WHERE character_id = 'character-ali' AND role = 'side'
    `))
    assert.throws(
      () => assertCurrentStoryboardReferenceDecision(database, {
        target: target(database, 'shot-side'),
        decision,
        referenceAssetIds: decision.referenceAssetIds,
      }),
      (error: unknown) => error instanceof JobExecutionError
        && error.code === 'STALE_STORYBOARD_REFERENCE_DECISION',
    )

    database.withSql((sql) => {
      sql.run(`
        UPDATE character_visual_references SET version = 1
        WHERE character_id = 'character-ali' AND role = 'side'
      `)
      sql.run(`UPDATE locations SET version = version + 1 WHERE id = 'location-cliff'`)
    })
    assert.throws(
      () => assertCurrentStoryboardReferenceDecision(database, {
        target: target(database, 'shot-side'),
        decision,
        referenceAssetIds: decision.referenceAssetIds,
      }),
      (error: unknown) => error instanceof JobExecutionError
        && error.code === 'STALE_STORYBOARD_REFERENCE_DECISION',
    )
  } finally {
    database.close()
  }
})
