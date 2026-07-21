import assert from 'node:assert/strict'
import test from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import { prepareShotVideoBatch, ShotVideoBatchError } from './shot-video-batch.js'
import { resolvePublicShotVideoTarget } from './shot-video-generation.js'
import {
  recommendCharacterReferenceView,
  resolveShotVideoReferenceRecommendation,
  validateCurrentAgenticReferenceDecision,
} from './shot-video-reference-recommendation.js'

const NOW = '2026-07-15T00:00:00.000Z'
const PROJECT_ID = 'project-view'
const EPISODE_ID = 'episode-view'
const REVISION_ID = 'story-view-r1'

function fixture(input: {
  description?: string
  framing?: string
  movement?: string
  prompt?: string
} = {}): ManjuDatabase {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  database.createProject({ id: PROJECT_ID, title: '角色视角测试' })
  database.createRevision({
    id: REVISION_ID,
    projectId: PROJECT_ID,
    summary: '可追溯剧本',
    snapshot: { version: 1, kind: 'story' },
    createdAt: NOW,
  })
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
        style_preset, status, sort_order, created_at, updated_at, metadata_json,
        source_revision_id
      ) VALUES (?, ?, '第一集', '', 30, '16:9', '', 'draft', 0, ?, ?, '{}', ?)
    `, EPISODE_ID, PROJECT_ID, NOW, NOW, REVISION_ID)
    sql.run(`
      INSERT INTO characters (
        id, project_id, episode_id, name, story_description, visual_description,
        version, metadata_json, created_at, updated_at
      ) VALUES ('character-row', ?, ?, '阿离', '', '', 1, '{"storyId":"ali"}', ?, ?)
    `, PROJECT_ID, EPISODE_ID, NOW, NOW)
    sql.run(`
      INSERT INTO scenes (
        id, episode_id, sequence, title, description, duration_seconds,
        metadata_json, created_at, updated_at
      ) VALUES ('scene-row', ?, 0, '断崖', '', 5, '{"storyId":"scene-1"}', ?, ?)
    `, EPISODE_ID, NOW, NOW)
    sql.run(`
      INSERT INTO shots (
        id, scene_id, sequence, code, title, description, framing, movement,
        transition, duration_seconds, timeline_start_seconds, prompt, status,
        source_revision_id, metadata_json, created_at, updated_at
      ) VALUES (
        'shot-row', 'scene-row', 0, 'S0-1', '回头', ?, ?, ?, 'cut', 5, 0, ?,
        'draft', ?, '{"storyId":"shot-1"}', ?, ?
      )
    `,
    input.description ?? '阿离侧身望向云海',
    input.framing ?? '中景',
    input.movement ?? '缓慢推近',
    input.prompt ?? '阿离侧面站在断崖',
    REVISION_ID,
    NOW,
    NOW,
    )
  })
  const audit = database.createRevision({
    id: 'view-lock-audit',
    projectId: PROJECT_ID,
    summary: '锁定三视图',
    snapshot: { version: 1, kind: 'character.visual-references.lock' },
    createdAt: NOW,
  })
  for (const [index, role] of ['front', 'side', 'back'].entries()) {
    database.createMediaAsset({
      id: `asset-${role}`,
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      kind: `character-turnaround-${role}`,
      version: index + 1,
      status: 'ready',
      mimeType: 'image/png',
      width: 512,
      height: 512,
      checksum: String(index + 1).repeat(64),
      source: 'local-turnaround',
      sourceRevisionId: REVISION_ID,
    })
    database.withSql((sql) => sql.run(`
      INSERT INTO character_visual_references (
        character_id, project_id, episode_id, role, asset_id, version,
        audit_revision_id, updated_at
      ) VALUES ('character-row', ?, ?, ?, ?, 1, ?, ?)
    `, PROJECT_ID, EPISODE_ID, role, `asset-${role}`, audit.id, NOW))
  }
  database.updateProject(PROJECT_ID, {
    currentEpisodeId: EPISODE_ID,
    currentRevisionId: REVISION_ID,
  })
  return database
}

function target(database: ManjuDatabase) {
  return resolvePublicShotVideoTarget(database, {
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    shotId: 'shot-1',
    sceneId: 'scene-1',
  })
}

test('view classifier is deterministic and refuses contradictory camera-relative evidence', () => {
  assert.deepEqual(recommendCharacterReferenceView({ action: '背对镜头走向远处' }), {
    status: 'recommended',
    view: 'back',
    confidence: 0.98,
    reasonCode: 'explicit_back',
    rationale: '镜头文本明确指定背面视角。',
  })
  const conflict = recommendCharacterReferenceView({ action: '阿离正面看镜头，同时呈现侧脸' })
  assert.equal(conflict.status, 'manual_required')
  assert.equal(conflict.view, null)
  assert.equal(conflict.reasonCode, 'conflicting_direction_cues')
})

test('distant aerial silhouette is auditable not-applicable instead of a circular manual blocker', () => {
  const decision = recommendCharacterReferenceView({
    shotSize: '高空大全景',
    action: '阿离只是云海远处的小小剪影',
    prompt: '航拍建立镜头',
    hasDialogueSubject: false,
  })
  assert.equal(decision.status, 'not_required')
  assert.equal(decision.reasonCode, 'distant_character_not_required')
  assert.equal(decision.view, null)
  const identityCritical = recommendCharacterReferenceView({
    shotSize: '高空大全景',
    action: '远处小小剪影，但必须看清服饰徽记与武器造型',
    hasDialogueSubject: false,
  })
  assert.equal(identityCritical.status, 'manual_required')
  assert.equal(identityCritical.reasonCode, 'insufficient_direction_evidence')

  const database = fixture({
    description: '阿离只是远处的小小剪影',
    framing: '高空大全景',
    movement: '航拍俯瞰',
    prompt: '云海中的远处身影',
  })
  try {
    const recommendation = resolveShotVideoReferenceRecommendation(database, target(database))
    assert.equal(recommendation.status, 'not_applicable')
    assert.match(recommendation.rationale, /distant_character_not_required/)
    assert.deepEqual(recommendation.references, [])
    const prepared = prepareShotVideoBatch(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p',
      audioPolicy: 'silent',
      generateAudio: false,
      selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
    }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    assert.equal(prepared.targets[0].referenceMode, 'text-to-video')
    assert.equal(prepared.targets[0].referenceDecision.resolution, 'not_applicable')
    assert.deepEqual(prepared.targets[0].references, [])
    const decisionWithoutEffectiveAnchor = prepared.targets[0].referenceDecision
    assert.equal(validateCurrentAgenticReferenceDecision(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      databaseShotId: 'shot-row',
      decision: decisionWithoutEffectiveAnchor,
    }), true)

    // A raw stale pointer is still effectively “no anchor” and must not make
    // a safe text-only decision fail at the paid checkpoint.
    database.createMediaAsset({
      id: 'asset-stale-distant-storyboard',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      kind: 'storyboard',
      version: 1,
      status: 'stale',
      mimeType: 'image/png',
      width: 512,
      height: 512,
      checksum: '8'.repeat(64),
      source: 'provider',
      sourceRevisionId: REVISION_ID,
    })
    database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'asset-stale-distant-storyboard' WHERE id = 'shot-row'
    `))
    assert.equal(validateCurrentAgenticReferenceDecision(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      databaseShotId: 'shot-row',
      decision: decisionWithoutEffectiveAnchor,
    }), true)

    // If that exact raw pointer later becomes eligible, the effective input
    // changed and the old text-only decision must fail closed before billing.
    database.updateMediaAsset('asset-stale-distant-storyboard', { status: 'ready' })
    assert.equal(validateCurrentAgenticReferenceDecision(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      databaseShotId: 'shot-row',
      decision: decisionWithoutEffectiveAnchor,
    }), false)
  } finally {
    database.close()
  }
})

test('insert details and peripheral wide shots do not misreport complete turnaround slots as missing', () => {
  const insert = recommendCharacterReferenceView({
    shotSize: '特写',
    action: '阿离收紧手指，掌心的青铜令发烫',
    prompt: '只露出深青袖口、黑色护腕和令牌',
    hasDialogueSubject: false,
  })
  assert.equal(insert.status, 'not_required')
  assert.equal(insert.reasonCode, 'insert_detail_not_required')

  const peripheral = recommendCharacterReferenceView({
    shotSize: '大全景',
    action: '阿离站在左下角崖边，群山与云层占据主体',
    prompt: '深青短袍、灰白披肩在风中翻卷',
    hasDialogueSubject: false,
  })
  assert.equal(peripheral.status, 'recommended')
  assert.equal(peripheral.view, 'front')
  assert.equal(peripheral.reasonCode, 'peripheral_distant_identity_anchor')

  const identityCritical = recommendCharacterReferenceView({
    shotSize: '大全景',
    action: '阿离站在左下角，但必须看清服饰徽记与武器造型',
    hasDialogueSubject: false,
  })
  assert.equal(identityCritical.status, 'manual_required')
})

test('recommendation resolves only the current locked role slot and pins full Asset provenance', () => {
  const database = fixture()
  try {
    const recommendation = resolveShotVideoReferenceRecommendation(database, target(database))
    assert.equal(recommendation.status, 'recommended')
    assert.equal(recommendation.confidence, 0.96)
    assert.deepEqual(recommendation.references, [{ assetId: 'asset-side', role: 'reference_image' }])
    assert.deepEqual(recommendation.characters[0], {
      characterId: 'ali',
      characterName: '阿离',
      status: 'recommended',
      view: 'side',
      confidence: 0.96,
      rationale: '镜头文本明确指定侧面视角。',
      assetId: 'asset-side',
      assetVersion: 2,
      assetChecksum: '2'.repeat(64),
      assetSourceRevisionId: REVISION_ID,
      slotVersion: 1,
      slotAuditRevisionId: 'view-lock-audit',
    })
  } finally {
    database.close()
  }
})

test('omitted references consume Agentic recommendation while an explicit empty array remains a user override', () => {
  const database = fixture()
  try {
    database.createMediaAsset({
      id: 'asset-current-storyboard',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      kind: 'storyboard',
      version: 1,
      status: 'ready',
      mimeType: 'image/png',
      width: 512,
      height: 512,
      checksum: '4'.repeat(64),
      source: 'provider',
      sourceRevisionId: REVISION_ID,
    })
    database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'asset-current-storyboard' WHERE id = 'shot-row'
    `))
    const base = {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p' as const,
      audioPolicy: 'silent' as const,
      generateAudio: false,
    }
    const automatic = prepareShotVideoBatch(database, {
      ...base,
      selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
    }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    assert.equal(automatic.targets[0].referenceDecision.source, 'agentic_auto')
    assert.deepEqual(automatic.targets[0].references, [{
      assetId: 'asset-current-storyboard',
      role: 'reference_image',
      version: 1,
      checksum: '4'.repeat(64),
      sourceRevisionId: REVISION_ID,
    }, {
      assetId: 'asset-side',
      role: 'reference_image',
      version: 2,
      checksum: '2'.repeat(64),
      sourceRevisionId: REVISION_ID,
    }])
    assert.deepEqual(automatic.targets[0].referenceDecision.selectedReferences, [
      { assetId: 'asset-current-storyboard', role: 'reference_image' },
      { assetId: 'asset-side', role: 'reference_image' },
    ])
    assert.equal(automatic.targets[0].referenceDecision.storyboardAnchorAssetId, 'asset-current-storyboard')
    assert.equal(validateCurrentAgenticReferenceDecision(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      databaseShotId: 'shot-row',
      decision: automatic.targets[0].referenceDecision,
    }), true)
    database.withSql((sql) => sql.run(`UPDATE shots SET storyboard_asset_id = NULL WHERE id = 'shot-row'`))
    assert.equal(validateCurrentAgenticReferenceDecision(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      databaseShotId: 'shot-row',
      decision: automatic.targets[0].referenceDecision,
    }), false)
    database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'asset-current-storyboard' WHERE id = 'shot-row'
    `))
    assert.deepEqual(automatic.targets[0].input.references, automatic.targets[0].references)

    const manual = prepareShotVideoBatch(database, {
      ...base,
      selections: [{ shotId: 'shot-1', sceneId: 'scene-1', references: [] }],
    }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    assert.equal(manual.targets[0].referenceDecision.source, 'manual_override')
    assert.deepEqual(manual.targets[0].references, [])
    assert.equal(manual.targets[0].input.references, undefined)

    const genericAdvancedOverride = prepareShotVideoBatch(database, {
      ...base,
      selections: [{
        shotId: 'shot-1',
        sceneId: 'scene-1',
        references: [{ assetId: 'asset-current-storyboard', role: 'reference_image' }],
      }],
    }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    assert.equal(genericAdvancedOverride.targets[0].referenceDecision.source, 'manual_override')
    assert.equal(genericAdvancedOverride.targets[0].referenceDecision.manualCharacterSlotPins, undefined)
    assert.deepEqual(genericAdvancedOverride.targets[0].referenceDecision.selectedReferences, [{
      assetId: 'asset-current-storyboard',
      role: 'reference_image',
    }])
  } finally {
    database.close()
  }
})

test('insufficient view evidence requires manual selection and cannot silently become text-to-video', () => {
  const database = fixture({
    description: '阿离在远处的断崖上',
    framing: '远景',
    movement: '固定',
    prompt: '阿离在断崖，云海广阔',
  })
  try {
    const recommendation = resolveShotVideoReferenceRecommendation(database, target(database))
    assert.equal(recommendation.status, 'manual_required')
    assert.deepEqual(recommendation.references, [])
    assert.throws(() => prepareShotVideoBatch(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p',
      audioPolicy: 'silent',
      generateAudio: false,
      selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
    }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' }), (error) => (
      error instanceof ShotVideoBatchError
      && error.code === 'VIDEO_REFERENCE_SELECTION_REQUIRED'
      && error.details?.recommendation !== undefined
      && Array.isArray((error.details?.manualSelection as { characters?: Array<{ slots?: unknown[] }> } | undefined)?.characters)
      && (error.details?.manualSelection as { characters: Array<{ slots: unknown[] }> }).characters[0]?.slots.length === 3
    ))

    const manual = prepareShotVideoBatch(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p',
      audioPolicy: 'silent',
      generateAudio: false,
      selections: [{
        shotId: 'shot-1',
        sceneId: 'scene-1',
        characterReferenceSelections: [{ characterId: 'ali', view: 'side' }],
      }],
    }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    assert.deepEqual(manual.targets[0].references.map(({ assetId, role }) => ({ assetId, role })), [{
      assetId: 'asset-side',
      role: 'reference_image',
    }])
    assert.deepEqual(manual.targets[0].referenceDecision.manualCharacterSlotPins?.map((pin) => ({
      characterId: pin.characterId,
      view: pin.view,
      assetId: pin.assetId,
      slotVersion: pin.slotVersion,
      slotAuditRevisionId: pin.slotAuditRevisionId,
    })), [{
      characterId: 'ali',
      view: 'side',
      assetId: 'asset-side',
      slotVersion: 1,
      slotAuditRevisionId: 'view-lock-audit',
    }])
    assert.equal(validateCurrentAgenticReferenceDecision(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      databaseShotId: 'shot-row',
      decision: manual.targets[0].referenceDecision,
    }), true)
    database.withSql((sql) => sql.run(`
      UPDATE character_visual_references SET version = version + 1
      WHERE character_id = 'character-row' AND role = 'side'
    `))
    assert.equal(validateCurrentAgenticReferenceDecision(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      databaseShotId: 'shot-row',
      decision: manual.targets[0].referenceDecision,
    }), false)
  } finally {
    database.close()
  }
})

test('batch preflight aggregates every unresolved shot in one non-billable 409', () => {
  const database = fixture({
    description: '阿离在断崖上等待',
    framing: '远景',
    movement: '固定',
    prompt: '阿离在云海前等待',
  })
  try {
    database.withSql((sql) => sql.run(`
      INSERT INTO shots (
        id, scene_id, sequence, code, title, description, framing, movement,
        transition, duration_seconds, timeline_start_seconds, prompt, status,
        source_revision_id, metadata_json, created_at, updated_at
      ) VALUES (
        'shot-row-2', 'scene-row', 1, 'S0-2', '等待', '阿离在断崖上等待', '远景', '固定',
        'cut', 5, 5, '阿离在云海前等待', 'draft', ?, '{"storyId":"shot-2"}', ?, ?
      )
    `, REVISION_ID, NOW, NOW))
    let failure: unknown
    try {
      prepareShotVideoBatch(database, {
        projectId: PROJECT_ID,
        episodeId: EPISODE_ID,
        resolution: '720p',
        audioPolicy: 'silent',
        generateAudio: false,
        selections: [
          { shotId: 'shot-1', sceneId: 'scene-1' },
          { shotId: 'shot-2', sceneId: 'scene-1' },
        ],
      }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    } catch (error) {
      failure = error
    }
    assert.ok(failure instanceof ShotVideoBatchError)
    assert.equal(failure.code, 'VIDEO_REFERENCE_SELECTION_REQUIRED')
    assert.match(failure.message, /2 个镜头/)
    const unresolved = failure.details?.unresolvedShots as Array<{
      shotId: string
      reasonCode: string
      manualSelection: { shotId: string; characters: unknown[] }
    }>
    assert.deepEqual(unresolved.map((issue) => issue.shotId), ['shot-1', 'shot-2'])
    assert.deepEqual(unresolved.map((issue) => issue.manualSelection.shotId), ['shot-1', 'shot-2'])
    assert.ok(unresolved.every((issue) => issue.reasonCode === 'VIEW_SELECTION_REQUIRED'))
    assert.equal(database.listGenerationJobs({ projectId: PROJECT_ID }).length, 0)
  } finally {
    database.close()
  }
})

test('more than nine related characters returns a recoverable fail-closed contract', () => {
  const database = fixture({
    description: '阿离与众人站在断崖上',
    framing: '远景',
    movement: '固定',
    prompt: '群像站在云海前',
  })
  try {
    const names = Array.from({ length: 9 }, (_, index) => `同伴${index + 1}`)
    database.withSql((sql) => {
      names.forEach((name, index) => sql.run(`
        INSERT INTO characters (
          id, project_id, episode_id, name, story_description, visual_description,
          version, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', '', 1, ?, ?, ?)
      `, `character-extra-${index}`, PROJECT_ID, EPISODE_ID, name, JSON.stringify({ storyId: `extra-${index}` }), NOW, NOW))
      sql.run(`
        UPDATE shots SET description = ?, prompt = ? WHERE id = 'shot-row'
      `, `阿离、${names.join('、')}在断崖上等待`, `阿离、${names.join('、')}的群像镜头`)
    })
    let failure: unknown
    try {
      prepareShotVideoBatch(database, {
        projectId: PROJECT_ID,
        episodeId: EPISODE_ID,
        resolution: '720p',
        audioPolicy: 'silent',
        generateAudio: false,
        selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
      }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    } catch (error) {
      failure = error
    }
    assert.ok(failure instanceof ShotVideoBatchError)
    assert.equal(failure.code, 'VIDEO_REFERENCE_SELECTION_REQUIRED')
    assert.match(failure.message, /10 个角色.*9 张参考图上限/)
    assert.equal(failure.details?.reasonCode, 'RELATED_CHARACTER_LIMIT_EXCEEDED')
    assert.equal(failure.details?.slotSelectionAllowed, false)
    assert.deepEqual(failure.details?.recoveryActions, ['USE_TEXT_ONLY', 'SPLIT_SHOT'])
    const manualSelection = failure.details?.manualSelection as {
      selectionPolicy: { slotSelectionAllowed: boolean; maximumReferences: number }
      characters: unknown[]
    }
    assert.equal(manualSelection.characters.length, 10)
    assert.deepEqual(manualSelection.selectionPolicy, {
      maximumReferences: 9,
      slotSelectionAllowed: false,
      reason: 'related_character_limit_exceeded',
    })

    const textOnly = prepareShotVideoBatch(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p',
      audioPolicy: 'silent',
      generateAudio: false,
      selections: [{ shotId: 'shot-1', sceneId: 'scene-1', references: [] }],
    }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    assert.equal(textOnly.targets[0].referenceMode, 'text-to-video')
    assert.equal(textOnly.targets[0].referenceDecision.source, 'manual_override')
    assert.equal(database.listGenerationJobs({ projectId: PROJECT_ID }).length, 0)
  } finally {
    database.close()
  }
})

test('insufficient view evidence safely falls back to the current same-shot storyboard anchor', () => {
  const database = fixture({
    description: '阿离在远处的断崖上',
    framing: '远景',
    movement: '固定',
    prompt: '阿离在断崖，云海广阔',
  })
  try {
    database.createMediaAsset({
      id: 'asset-ambiguous-storyboard',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      kind: 'storyboard',
      version: 1,
      status: 'ready',
      mimeType: 'image/png',
      width: 512,
      height: 512,
      checksum: '5'.repeat(64),
      source: 'provider',
      sourceRevisionId: REVISION_ID,
    })
    database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'asset-ambiguous-storyboard' WHERE id = 'shot-row'
    `))
    const prepared = prepareShotVideoBatch(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p',
      audioPolicy: 'silent',
      generateAudio: false,
      selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
    }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    assert.equal(prepared.targets[0].referenceDecision.resolution, 'storyboard_anchor')
    assert.equal(prepared.targets[0].referenceDecision.recommendation.status, 'manual_required')
    assert.deepEqual(prepared.targets[0].referenceDecision.selectedReferences, [{
      assetId: 'asset-ambiguous-storyboard',
      role: 'first_frame',
    }])
    assert.deepEqual(prepared.targets[0].references, [{
      assetId: 'asset-ambiguous-storyboard',
      role: 'first_frame',
      version: 1,
      checksum: '5'.repeat(64),
      sourceRevisionId: REVISION_ID,
    }])
    assert.equal(validateCurrentAgenticReferenceDecision(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      databaseShotId: 'shot-row',
      decision: prepared.targets[0].referenceDecision,
    }), true)
  } finally {
    database.close()
  }
})

test('same-shot storyboard with unknown dimensions remains a valid first-frame anchor', () => {
  const database = fixture({
    description: '阿离在远处的断崖上',
    framing: '远景',
    movement: '固定',
    prompt: '阿离在断崖，云海广阔',
  })
  try {
    database.createMediaAsset({
      id: 'asset-storyboard-unknown-dimensions',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      kind: 'storyboard',
      version: 1,
      status: 'ready',
      mimeType: 'image/png',
      width: null,
      height: null,
      checksum: '6'.repeat(64),
      source: 'provider',
      sourceRevisionId: REVISION_ID,
    })
    database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'asset-storyboard-unknown-dimensions' WHERE id = 'shot-row'
    `))
    const prepared = prepareShotVideoBatch(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p',
      audioPolicy: 'silent',
      generateAudio: false,
      selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
    }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    assert.equal(prepared.targets[0].referenceDecision.resolution, 'storyboard_anchor')
    assert.deepEqual(prepared.targets[0].referenceDecision.selectedReferences, [{
      assetId: 'asset-storyboard-unknown-dimensions',
      role: 'first_frame',
    }])
  } finally {
    database.close()
  }
})

test('invalid same-shot storyboard dimensions enter manual recovery instead of bypassing it', async (context) => {
  const cases = [
    { label: '1x1 pixels', width: 1, height: 1 },
    { label: 'over 6000 pixels', width: 6_001, height: 512 },
    { label: 'unsupported aspect ratio', width: 1_600, height: 400 },
  ] as const
  for (const candidate of cases) {
    await context.test(candidate.label, () => {
      const database = fixture({
        description: '阿离在远处的断崖上',
        framing: '远景',
        movement: '固定',
        prompt: '阿离在断崖，云海广阔',
      })
      try {
        database.createMediaAsset({
          id: 'asset-invalid-storyboard-dimensions',
          projectId: PROJECT_ID,
          episodeId: EPISODE_ID,
          kind: 'storyboard',
          version: 1,
          status: 'ready',
          mimeType: 'image/png',
          width: candidate.width,
          height: candidate.height,
          checksum: '7'.repeat(64),
          source: 'provider',
          sourceRevisionId: REVISION_ID,
        })
        database.withSql((sql) => sql.run(`
          UPDATE shots SET storyboard_asset_id = 'asset-invalid-storyboard-dimensions' WHERE id = 'shot-row'
        `))
        assert.throws(() => prepareShotVideoBatch(database, {
          projectId: PROJECT_ID,
          episodeId: EPISODE_ID,
          resolution: '720p',
          audioPolicy: 'silent',
          generateAudio: false,
          selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
        }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' }), (error) => (
          error instanceof ShotVideoBatchError
          && error.code === 'VIDEO_REFERENCE_SELECTION_REQUIRED'
          && Array.isArray((error.details?.manualSelection as { characters?: unknown[] } | undefined)?.characters)
        ))
        assert.equal(database.listGenerationJobs({ projectId: PROJECT_ID }).length, 0)
      } finally {
        database.close()
      }
    })
  }
})

test('an automatic character-view decision sends the eligible same-source whole turnaround to Seedance', () => {
  const database = fixture({
    description: '阿离背对镜头走向云海',
    framing: '中景',
    movement: '缓慢推近',
    prompt: '阿离背面站在断崖',
  })
  try {
    database.createMediaAsset({
      id: 'asset-whole-turnaround',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      kind: 'character-turnaround',
      version: 1,
      status: 'ready',
      mimeType: 'image/png',
      width: 1_536,
      height: 1_024,
      checksum: '8'.repeat(64),
      source: 'provider',
      sourceRevisionId: REVISION_ID,
    })
    database.createMediaAsset({
      id: 'asset-current-storyboard',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      kind: 'storyboard',
      version: 1,
      status: 'ready',
      mimeType: 'image/png',
      width: 1_536,
      height: 1_024,
      checksum: '9'.repeat(64),
      source: 'provider',
      sourceRevisionId: REVISION_ID,
    })
    database.withSql((sql) => sql.run(`
      UPDATE media_assets
      SET kind = 'character-reference.back',
          width = 408,
          height = 1024,
          parent_asset_id = 'asset-whole-turnaround',
          generation_parameters_json = json_object(
            'operation', 'asset.image.turnaround.derive',
            'orientation', 'back'
          )
      WHERE id = 'asset-back'
    `))
    database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'asset-current-storyboard' WHERE id = 'shot-row'
    `))
    const prepared = prepareShotVideoBatch(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p',
      audioPolicy: 'silent',
      generateAudio: false,
      selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
    }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    assert.deepEqual(prepared.targets[0]?.references.map(({ assetId, role }) => ({ assetId, role })), [
      { assetId: 'asset-current-storyboard', role: 'reference_image' },
      { assetId: 'asset-whole-turnaround', role: 'reference_image' },
    ])
    assert.deepEqual(prepared.targets[0]?.referenceDecision.recommendation.references, [{
      assetId: 'asset-back',
      role: 'reference_image',
    }], 'the role crop remains the immutable view-decision audit pin')
    assert.match(prepared.targets[0]?.referenceDecision.recommendation.rationale ?? '', /背面|视角/)
  } finally {
    database.close()
  }
})

test('a changed role slot invalidates the signed automatic decision before Provider billing', () => {
  const database = fixture()
  try {
    const prepared = prepareShotVideoBatch(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p',
      audioPolicy: 'silent',
      generateAudio: false,
      selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
    }, { providerId: 'seedance-video', configRevision: 3, model: 'seedance-test' })
    const decision = prepared.targets[0].referenceDecision
    assert.equal(validateCurrentAgenticReferenceDecision(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      databaseShotId: 'shot-row',
      decision,
    }), true)
    database.withSql((sql) => sql.run(`
      UPDATE character_visual_references
      SET version = version + 1
      WHERE character_id = 'character-row' AND role = 'side'
    `))
    assert.equal(validateCurrentAgenticReferenceDecision(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: REVISION_ID,
      databaseShotId: 'shot-row',
      decision,
    }), false)
  } finally {
    database.close()
  }
})
