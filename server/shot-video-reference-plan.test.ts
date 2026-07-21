import assert from 'node:assert/strict'
import test from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import { prepareShotVideoBatch, ShotVideoBatchError } from './shot-video-batch.js'
import {
  createShotVideoReferencePlan,
  MAX_SHOT_VIDEO_REFERENCE_IMAGES,
} from './shot-video-reference-plan.js'
import { resolvePublicShotVideoTarget } from './shot-video-generation.js'
import { resolveShotVideoReferenceRecommendation } from './shot-video-reference-recommendation.js'

const NOW = '2026-07-15T00:00:00.000Z'
const PROJECT_ID = 'project-reference-plan'
const EPISODE_ID = 'episode-reference-plan'
const REVISION_ID = 'story-reference-plan-r1'

const SHOTS = [
  {
    id: 'sh0',
    title: '龙脊暮色',
    description: '以高空远景建立秦岭与长安的距离，断崖上的阿离只是一个小小剪影，云层压低，群山像沉睡龙脊。',
    framing: '远景',
    movement: '缓慢推近',
    prompt: '16:9宽银幕构图，国风动画风格，暮春黄昏，长安城外秦岭断崖；远处群山如沉睡龙脊，厚云压顶，长安城轮廓隐在地平线；阿离为崖边小剪影，黑发高束、鬓边红绳、深青窄袖短袍、灰白披肩、腰悬长剑；暖橙夕光与青绿色山影交错，镜头高空远景缓慢推近。',
  },
  { id: 'sh1', title: '崖边守候', description: '云海翻涌', framing: '全景', movement: '缓慢推进', prompt: '断崖与云海' },
  { id: 'sh2', title: '令牌发烫', description: '青铜令牌在手心发烫', framing: '特写', movement: '微距推近', prompt: '青铜令牌的暗红纹路亮起' },
  { id: 'sh3', title: '旧兆重现', description: '阿离背对镜头看向云海', framing: '中景', movement: '缓慢环绕', prompt: '阿离的背影与断崖' },
  { id: 'sh4', title: '第一盏灯', description: '断崖上亮起灯火', framing: '全景', movement: '固定', prompt: '黄昏断崖上的灯火' },
  { id: 'sh5', title: '云中龙吟', description: '云海中有龙形气流', framing: '大全景', movement: '仰拍', prompt: '断崖云海中的龙形气流' },
  { id: 'sh6', title: '握剑确认', description: '阿离侧身握紧长剑', framing: '中景', movement: '横向跟拍', prompt: '阿离侧面握剑' },
  { id: 'sh7', title: '黑夜睁眼', description: '阿离正脸特写，在黑夜中睁开眼睛', framing: '大特写', movement: '缓慢推近', prompt: '阿离正面眼神特写' },
] as const

function createImage(
  database: ManjuDatabase,
  id: string,
  checksumCharacter: string,
): void {
  database.createMediaAsset({
    id,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    kind: 'reference-fixture',
    version: 1,
    status: 'ready',
    mimeType: 'image/png',
    width: 512,
    height: 512,
    checksum: checksumCharacter.repeat(64),
    source: 'fixture',
    sourceRevisionId: REVISION_ID,
  })
}

function fixture(): ManjuDatabase {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  database.createProject({ id: PROJECT_ID, title: '逐镜参考计划' })
  database.createRevision({
    id: REVISION_ID,
    projectId: PROJECT_ID,
    summary: '八镜剧本',
    snapshot: { version: 1, kind: 'story' },
    createdAt: NOW,
  })
  database.withSql((sql) => sql.run(`
    INSERT INTO episodes (
      id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
      style_preset, status, sort_order, created_at, updated_at, metadata_json,
      source_revision_id
    ) VALUES (?, ?, '第 1 集', '', 40, '16:9', '国风动画', 'draft', 0, ?, ?, '{}', ?)
  `, EPISODE_ID, PROJECT_ID, NOW, NOW, REVISION_ID))

  SHOTS.forEach((shot, index) => createImage(
    database,
    `storyboard-${shot.id}`,
    '0123456789abcdef'[index],
  ))
  createImage(database, 'asset-character-front', '8')
  createImage(database, 'asset-character-side', '9')
  createImage(database, 'asset-prop-token', 'a')
  createImage(database, 'asset-location-cliff', 'b')

  database.withSql((sql) => {
    sql.run(`
      INSERT INTO characters (
        id, project_id, episode_id, name, story_description, visual_description,
        version, metadata_json, created_at, updated_at
      ) VALUES ('character-ali', ?, ?, '阿离', '年轻剑客', '黑发红绳青袍', 1, '{"storyId":"ali"}', ?, ?)
    `, PROJECT_ID, EPISODE_ID, NOW, NOW)
    sql.run(`
      INSERT INTO locations (
        id, project_id, episode_id, name, story_description, visual_description,
        locked_asset_id, version, metadata_json, created_at, updated_at
      ) VALUES ('location-cliff', ?, ?, '断崖', '长安城外', '云海与青黑山石',
        'asset-location-cliff', 1, '{"storyId":"cliff"}', ?, ?)
    `, PROJECT_ID, EPISODE_ID, NOW, NOW)
    sql.run(`
      INSERT INTO props (
        id, project_id, episode_id, name, story_description, visual_description,
        locked_asset_id, version, metadata_json, created_at, updated_at
      ) VALUES ('prop-token', ?, ?, '青铜令牌', '唤醒龙脉', '暗红纹路的六边形令牌',
        'asset-prop-token', 1, '{"storyId":"token"}', ?, ?)
    `, PROJECT_ID, EPISODE_ID, NOW, NOW)
    sql.run(`
      INSERT INTO scenes (
        id, episode_id, sequence, title, description, duration_seconds,
        metadata_json, created_at, updated_at
      ) VALUES (
        'scene-row', ?, 0, '断崖龙吟', '黄昏到黑夜', 40,
        '{"storyId":"scene-0","locationId":"cliff","timeOfDay":"黄昏"}', ?, ?
      )
    `, EPISODE_ID, NOW, NOW)
    SHOTS.forEach((shot, index) => sql.run(`
      INSERT INTO shots (
        id, scene_id, sequence, code, title, description, framing, movement,
        transition, duration_seconds, timeline_start_seconds, prompt, status,
        storyboard_asset_id, source_revision_id, metadata_json, created_at, updated_at
      ) VALUES (?, 'scene-row', ?, ?, ?, ?, ?, ?, 'cut', 5, ?, ?, 'storyboard_ready', ?, ?, ?, ?, ?)
    `,
    `shot-row-${shot.id}`,
    index,
    `S0-${index}`,
    shot.title,
    shot.description,
    shot.framing,
    shot.movement,
    index * 5,
    shot.prompt,
    `storyboard-${shot.id}`,
    REVISION_ID,
    JSON.stringify({ storyId: shot.id }),
    NOW,
    NOW,
    ))
  })
  const audit = database.createRevision({
    id: 'character-slot-audit',
    projectId: PROJECT_ID,
    summary: '锁定当前角色视图',
    snapshot: { version: 1, kind: 'character.visual-references.lock' },
    createdAt: NOW,
  })
  database.withSql((sql) => {
    for (const [role, assetId] of [
      ['front', 'asset-character-front'],
      ['side', 'asset-character-side'],
    ] as const) {
      sql.run(`
        INSERT INTO character_visual_references (
          character_id, project_id, episode_id, role, asset_id, version,
          audit_revision_id, updated_at
        ) VALUES ('character-ali', ?, ?, ?, ?, 1, ?, ?)
      `, PROJECT_ID, EPISODE_ID, role, assetId, audit.id, NOW)
    }
  })
  database.updateProject(PROJECT_ID, {
    currentEpisodeId: EPISODE_ID,
    currentRevisionId: REVISION_ID,
  })
  return database
}

function target(database: ManjuDatabase, shotId: string) {
  return resolvePublicShotVideoTarget(database, {
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    shotId,
    sceneId: 'scene-0',
  })
}

function plan(database: ManjuDatabase, shotId: string) {
  const resolved = target(database, shotId)
  const recommendation = resolveShotVideoReferenceRecommendation(database, resolved)
  return createShotVideoReferencePlan(database, {
    target: resolved,
    recommendation,
    storyboardAnchorAssetId: resolved.storyboardAssetId,
  })
}

const PROVIDER = { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' }
const REQUEST_BASE = {
  projectId: PROJECT_ID,
  episodeId: EPISODE_ID,
  resolution: '720p' as const,
  audioPolicy: 'silent' as const,
  generateAudio: false,
}

test('eight-shot plan keeps sh0 safe, enriches sh2/sh7, and blocks identity-sensitive sh3', () => {
  const database = fixture()
  try {
    const sh0 = plan(database, 'sh0')
    assert.equal(sh0.status, 'ready')
    assert.equal(sh0.assessmentSource, 'deterministic_safety')
    assert.equal(sh0.safeStoryboardFallback, true)
    assert.deepEqual(sh0.selectedReferences, [{ assetId: 'storyboard-sh0', role: 'first_frame' }])

    const sh2 = plan(database, 'sh2')
    assert.equal(sh2.status, 'ready')
    assert.deepEqual(sh2.contextPins.map((pin) => [pin.entityType, pin.entityId, pin.assetId]), [
      ['prop', 'token', 'asset-prop-token'],
      ['location', 'cliff', 'asset-location-cliff'],
    ])
    assert.deepEqual(sh2.selectedReferences, [
      { assetId: 'storyboard-sh2', role: 'reference_image' },
      { assetId: 'asset-prop-token', role: 'reference_image' },
      { assetId: 'asset-location-cliff', role: 'reference_image' },
    ])
    assert.equal(sh2.selectedReferences.some((reference) => reference.assetId === 'storyboard-sh3'), false)
    assert.deepEqual(plan(database, 'sh2'), sh2, 'the authoritative order must be restart-stable')

    const sh3 = plan(database, 'sh3')
    assert.equal(sh3.status, 'manual_required')
    assert.equal(sh3.reasonCode, 'IDENTITY_REFERENCE_REQUIRED')
    assert.equal(sh3.identitySensitive, true)
    assert.deepEqual(sh3.selectedReferences, [])

    const sh7 = plan(database, 'sh7')
    assert.equal(sh7.status, 'ready')
    assert.deepEqual(sh7.characterReferenceAssetIds, ['asset-character-front'])
    assert.deepEqual(sh7.selectedReferences, [
      { assetId: 'storyboard-sh7', role: 'reference_image' },
      { assetId: 'asset-character-front', role: 'reference_image' },
      { assetId: 'asset-location-cliff', role: 'reference_image' },
    ])
    assert.equal(sh7.selectedReferences.some((reference) => reference.assetId === 'storyboard-sh0'), false)
  } finally {
    database.close()
  }
})

test('batch preflight uses the plan and never lets a storyboard hide a missing identity slot', () => {
  const database = fixture()
  try {
    const sh0 = prepareShotVideoBatch(database, {
      ...REQUEST_BASE,
      selections: [{ shotId: 'sh0', sceneId: 'scene-0' }],
    }, PROVIDER)
    assert.equal(sh0.targets[0].referenceMode, 'first-frame')
    assert.deepEqual(sh0.targets[0].referenceDecision.selectedReferences, [
      { assetId: 'storyboard-sh0', role: 'first_frame' },
    ])

    const sh2 = prepareShotVideoBatch(database, {
      ...REQUEST_BASE,
      selections: [{ shotId: 'sh2', sceneId: 'scene-0' }],
    }, PROVIDER)
    assert.equal(sh2.targets[0].referenceMode, 'multi-reference')
    assert.deepEqual(sh2.targets[0].references.map(({ assetId, role }) => ({ assetId, role })), [
      { assetId: 'storyboard-sh2', role: 'reference_image' },
      { assetId: 'asset-prop-token', role: 'reference_image' },
      { assetId: 'asset-location-cliff', role: 'reference_image' },
    ])

    assert.throws(() => prepareShotVideoBatch(database, {
      ...REQUEST_BASE,
      selections: [{ shotId: 'sh3', sceneId: 'scene-0' }],
    }, PROVIDER), (error) => error instanceof ShotVideoBatchError
      && error.code === 'VIDEO_REFERENCE_SELECTION_REQUIRED'
      && error.details?.reasonCode === 'VIEW_SELECTION_REQUIRED'
      && /身份细节敏感/.test(error.message))

    const sh7 = prepareShotVideoBatch(database, {
      ...REQUEST_BASE,
      selections: [{ shotId: 'sh7', sceneId: 'scene-0' }],
    }, PROVIDER)
    assert.equal(sh7.targets[0].referenceMode, 'multi-reference')
    assert.deepEqual(sh7.targets[0].references.map(({ assetId, role }) => ({ assetId, role })), [
      { assetId: 'storyboard-sh7', role: 'reference_image' },
      { assetId: 'asset-character-front', role: 'reference_image' },
      { assetId: 'asset-location-cliff', role: 'reference_image' },
    ])
    assert.equal(database.listGenerationJobs({ projectId: PROJECT_ID }).length, 0)
  } finally {
    database.close()
  }
})

test('adding the required back slot turns sh3 into a stable multi-reference plan', () => {
  const database = fixture()
  try {
    createImage(database, 'asset-character-back', 'c')
    database.withSql((sql) => sql.run(`
      INSERT INTO character_visual_references (
        character_id, project_id, episode_id, role, asset_id, version,
        audit_revision_id, updated_at
      ) VALUES ('character-ali', ?, ?, 'back', 'asset-character-back', 1,
        'character-slot-audit', ?)
    `, PROJECT_ID, EPISODE_ID, NOW))
    const sh3 = plan(database, 'sh3')
    assert.equal(sh3.status, 'ready')
    assert.deepEqual(sh3.selectedReferences, [
      { assetId: 'storyboard-sh3', role: 'reference_image' },
      { assetId: 'asset-character-back', role: 'reference_image' },
      { assetId: 'asset-location-cliff', role: 'reference_image' },
    ])
  } finally {
    database.close()
  }
})

test('reference IDs are de-duplicated and a plan over nine images fails closed', () => {
  const database = fixture()
  try {
    database.withSql((sql) => sql.run(`
      UPDATE locations SET locked_asset_id = 'asset-prop-token' WHERE id = 'location-cliff'
    `))
    const deduplicated = plan(database, 'sh2')
    assert.deepEqual(deduplicated.selectedReferences.map((reference) => reference.assetId), [
      'storyboard-sh2',
      'asset-prop-token',
    ])

    // Restore the location and mention eight additional independently locked
    // props: storyboard + nine contextual images must not be truncated.
    database.withSql((sql) => sql.run(`
      UPDATE locations SET locked_asset_id = 'asset-location-cliff' WHERE id = 'location-cliff'
    `))
    const names: string[] = []
    for (let index = 0; index < 8; index += 1) {
      const id = `extra-prop-${index}`
      const name = `灵石${index}`
      const assetId = `asset-${id}`
      names.push(name)
      createImage(database, assetId, 'def01234'[index])
      database.withSql((sql) => sql.run(`
        INSERT INTO props (
          id, project_id, episode_id, name, story_description, visual_description,
          locked_asset_id, version, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', '', ?, 1, ?, ?, ?)
      `, id, PROJECT_ID, EPISODE_ID, name, assetId, JSON.stringify({ storyId: id }), NOW, NOW))
    }
    database.withSql((sql) => sql.run(`
      UPDATE shots SET description = ?, prompt = ? WHERE id = 'shot-row-sh2'
    `, `青铜令牌与${names.join('、')}`, `青铜令牌、${names.join('、')}在断崖发光`))
    const oversized = plan(database, 'sh2')
    assert.equal(MAX_SHOT_VIDEO_REFERENCE_IMAGES, 9)
    assert.equal(oversized.status, 'manual_required')
    assert.equal(oversized.reasonCode, 'REFERENCE_IMAGE_LIMIT_EXCEEDED')
    assert.deepEqual(oversized.selectedReferences, [])
  } finally {
    database.close()
  }
})

test('future persisted vision assessment is revision-bound and cannot claim a sensitive fallback', () => {
  const database = fixture()
  try {
    const resolved = target(database, 'sh0')
    const recommendation = resolveShotVideoReferenceRecommendation(database, resolved)
    const assessed = createShotVideoReferencePlan(database, {
      target: resolved,
      recommendation,
      storyboardAnchorAssetId: resolved.storyboardAssetId,
      persistedVisionAssessment: {
        version: 1,
        source: 'persisted_vision',
        shotId: 'sh0',
        sceneId: 'scene-0',
        sourceRevisionId: REVISION_ID,
        identitySensitive: true,
        allowStoryboardFallback: false,
        rationale: '持久化视觉评估认定身份敏感。',
      },
    })
    assert.equal(assessed.assessmentSource, 'persisted_vision')
    assert.equal(assessed.status, 'manual_required')
    assert.equal(assessed.reasonCode, 'IDENTITY_REFERENCE_REQUIRED')

    assert.throws(() => createShotVideoReferencePlan(database, {
      target: resolved,
      recommendation,
      storyboardAnchorAssetId: resolved.storyboardAssetId,
      persistedVisionAssessment: {
        version: 1,
        source: 'persisted_vision',
        shotId: 'sh0',
        sceneId: 'scene-0',
        sourceRevisionId: 'stale-revision',
        identitySensitive: false,
        allowStoryboardFallback: true,
        rationale: '不应被接受。',
      },
    }), /does not match/)
  } finally {
    database.close()
  }
})

test('persisted visual selection is exact, candidate-bound, and cannot reference another shot', () => {
  const database = fixture()
  try {
    const resolved = target(database, 'sh2')
    const recommendation = resolveShotVideoReferenceRecommendation(database, resolved)
    const exact = createShotVideoReferencePlan(database, {
      target: resolved,
      recommendation,
      storyboardAnchorAssetId: resolved.storyboardAssetId,
      persistedVisionAssessment: {
        version: 1,
        source: 'persisted_vision',
        mode: 'selected_references',
        shotId: 'sh2',
        sceneId: 'scene-0',
        sourceRevisionId: REVISION_ID,
        status: 'recommended',
        strategy: 'multi_reference',
        confidence: 0.94,
        rationale: '视觉证据显示当前分镜构图与令牌造型足够，场景锁定图不必重复加入。',
        visualEvidence: ['令牌占据画面主体。'],
        selectedReferences: [
          { assetId: 'storyboard-sh2', role: 'reference_image', purpose: '当前镜头内容与构图' },
          { assetId: 'asset-prop-token', role: 'reference_image', purpose: '道具造型：青铜令牌' },
        ],
        missingCharacterViews: [],
      },
    })
    assert.equal(exact.assessmentSource, 'persisted_vision')
    assert.deepEqual(exact.selectedReferences, [
      { assetId: 'storyboard-sh2', role: 'reference_image' },
      { assetId: 'asset-prop-token', role: 'reference_image' },
    ], 'deterministic location matching must not mutate the persisted visual selection')

    const foreignStoryboard = createShotVideoReferencePlan(database, {
      target: resolved,
      recommendation,
      storyboardAnchorAssetId: resolved.storyboardAssetId,
      persistedVisionAssessment: {
        version: 1,
        source: 'persisted_vision',
        mode: 'selected_references',
        shotId: 'sh2',
        sceneId: 'scene-0',
        sourceRevisionId: REVISION_ID,
        status: 'recommended',
        strategy: 'multi_reference',
        confidence: 0.95,
        rationale: '错误引用下一镜，必须被服务端拦截。',
        visualEvidence: ['不可信输出。'],
        selectedReferences: [
          { assetId: 'storyboard-sh3', role: 'reference_image', purpose: '错误的其他镜头分镜' },
        ],
        missingCharacterViews: [],
      },
    })
    assert.equal(foreignStoryboard.status, 'manual_required')
    assert.equal(foreignStoryboard.reasonCode, 'PERSISTED_VISION_SELECTION_INVALID')
    assert.deepEqual(foreignStoryboard.selectedReferences, [])
  } finally {
    database.close()
  }
})

test('persisted visual manual result preserves missing character-view recovery', () => {
  const database = fixture()
  try {
    const resolved = target(database, 'sh3')
    const recommendation = resolveShotVideoReferenceRecommendation(database, resolved)
    const assessed = createShotVideoReferencePlan(database, {
      target: resolved,
      recommendation,
      storyboardAnchorAssetId: resolved.storyboardAssetId,
      persistedVisionAssessment: {
        version: 1,
        source: 'persisted_vision',
        mode: 'selected_references',
        shotId: 'sh3',
        sceneId: 'scene-0',
        sourceRevisionId: REVISION_ID,
        status: 'manual_required',
        strategy: 'manual_review',
        confidence: 0.93,
        rationale: '背影镜头需要阿离的背面槽位。',
        visualEvidence: ['角色背对镜头。'],
        selectedReferences: [],
        missingCharacterViews: [{
          characterId: 'ali',
          characterName: '阿离',
          view: 'back',
          rationale: '当前角色没有背面槽位。',
        }],
      },
    })
    assert.equal(assessed.status, 'manual_required')
    assert.equal(assessed.reasonCode, 'IDENTITY_REFERENCE_REQUIRED')
    assert.deepEqual(assessed.selectedReferences, [])
  } finally {
    database.close()
  }
})
