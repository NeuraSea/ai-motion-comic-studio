import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import {
  isShotVideoDurationDecision,
  resolveShotVideoDuration,
  shotVideoDurationDecisionIsCurrent,
  speechAssetBindingBlockReason,
  type ShotVideoDurationTarget,
} from './shot-video-duration.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

async function fixture(): Promise<{
  database: ManjuDatabase
  target: ShotVideoDurationTarget
  close(): Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-shot-video-duration-test-'))
  directories.push(directory)
  const database = initializeDatabase({ runtimeDirectory: directory, legacyStatePath: false })
  const now = '2026-07-15T00:00:00.000Z'
  database.createProject({ id: 'project-1', title: '项目', createdAt: now, updatedAt: now })
  database.createRevision({
    id: 'revision-1',
    projectId: 'project-1',
    summary: '剧本',
    snapshot: { version: 1 },
    createdAt: now,
  })
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
        style_preset, status, sort_order, created_at, updated_at, metadata_json,
        source_revision_id
      ) VALUES (
        'episode-1', 'project-1', '第一集', '', 5, '16:9', '', 'draft', 0,
        ?, ?, '{}', 'revision-1'
      )
    `, now, now)
    sql.run(`
      INSERT INTO scenes (
        id, episode_id, sequence, title, description, duration_seconds,
        metadata_json, created_at, updated_at
      ) VALUES ('scene-db-1', 'episode-1', 0, '场景', '', 5, '{"storyId":"scene-1"}', ?, ?)
    `, now, now)
    sql.run(`
      INSERT INTO shots (
        id, scene_id, sequence, code, title, description, framing, movement,
        transition, duration_seconds, timeline_start_seconds, prompt, status,
        source_revision_id, metadata_json, created_at, updated_at
      ) VALUES (
        'shot-db-1', 'scene-db-1', 0, 'S0-0', '镜头', '人物转身', '中景', '推近',
        'cut', 5.25, 0, '人物转身', 'draft', 'revision-1',
        '{"storyId":"shot-1"}', ?, ?
      )
    `, now, now)
  })
  return {
    database,
    target: {
      databaseShotId: 'shot-db-1',
      publicShotId: 'shot-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      sourceRevisionId: 'revision-1',
      durationSeconds: 5.25,
    },
    async close() {
      database.close()
    },
  }
}

function addLine(database: ManjuDatabase, index: number, durationSeconds?: number): void {
  const now = '2026-07-15T00:00:00.000Z'
  database.withSql((sql) => sql.run(`
    INSERT INTO dialogue_lines (
      id, shot_id, sequence, kind, text, duration_seconds, metadata_json, created_at, updated_at
    ) VALUES (?, 'shot-db-1', ?, 'dialogue', ?, ?, ?, ?, ?)
  `,
  `line-db-${index}`,
  index,
  `台词 ${index}`,
  durationSeconds ?? null,
  JSON.stringify({ storyId: `line-${index}` }),
  now,
  now,
  ))
}

function bindSpeech(
  database: ManjuDatabase,
  index: number,
  durationSeconds: number,
  options: { checksumSeed?: string; sourceRevisionId?: string } = {},
): string {
  const assetId = `speech-${index}-${options.checksumSeed ?? 'a'}`
  database.createMediaAsset({
    id: assetId,
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'speech',
    status: 'ready',
    source: 'fixture',
    filePath: `/fixture/${assetId}.mp3`,
    mimeType: 'audio/mpeg',
    durationSeconds,
    checksum: (options.checksumSeed ?? 'a').repeat(64),
    sourceRevisionId: options.sourceRevisionId ?? 'revision-1',
  })
  database.withSql((sql) => sql.run(`
    UPDATE dialogue_lines
       SET speech_asset_id = ?, duration_seconds = ?
     WHERE id = ?
  `, assetId, durationSeconds, `line-db-${index}`))
  return assetId
}

test('no-dialogue shot preserves frame-aligned story edit point and Provider integer request', async () => {
  const context = await fixture()
  try {
    const result = resolveShotVideoDuration(context.database, context.target)
    assert.equal(result.status, 'ready')
    if (result.status !== 'ready') return
    assert.deepEqual(result.decision, {
      version: 1,
      source: 'story_duration',
      frameRate: 24,
      plannedDurationSeconds: 5.25,
      speechDurationSeconds: null,
      timelineDurationSeconds: 5.25,
      providerDurationSeconds: 6,
      speechBindings: [],
      notices: ['STORY_DURATION_USED_WITHOUT_SPEECH'],
    })
    assert.equal(isShotVideoDurationDecision(result.decision), true)
    assert.equal(shotVideoDurationDecisionIsCurrent(context.database, context.target, result.decision), true)
  } finally {
    await context.close()
  }
})

test('spoken shot blocks video before every real speech Asset is ready', async () => {
  const context = await fixture()
  try {
    addLine(context.database, 0)
    addLine(context.database, 1)
    bindSpeech(context.database, 0, 1)
    assert.deepEqual(resolveShotVideoDuration(context.database, context.target), {
      status: 'audio_required',
      shotId: 'shot-1',
      blockedLines: [{ dialogueLineId: 'line-1', reason: 'SPEECH_ASSET_MISSING' }],
    })
  } finally {
    await context.close()
  }
})

test('shared speech binding validation pins scope, revision, identity, readiness, MIME, and duration', () => {
  const valid = {
    referencedAssetId: 'speech-1',
    assetId: 'speech-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    version: 1,
    status: 'ready',
    mimeType: 'audio/mpeg',
    durationSeconds: 1.25,
    checksum: 'a'.repeat(64),
    sourceRevisionId: 'revision-1',
  }
  const scope = {
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: 'revision-1',
  }
  assert.equal(speechAssetBindingBlockReason(valid, scope), null)
  assert.equal(speechAssetBindingBlockReason({
    ...valid,
    mimeType: 'Audio/WAV; charset=binary',
  }, scope), null)
  assert.deepEqual([
    speechAssetBindingBlockReason({ ...valid, assetId: null }, scope),
    speechAssetBindingBlockReason({ ...valid, status: 'stale' }, scope),
    speechAssetBindingBlockReason({ ...valid, mimeType: 'image/png' }, scope),
    speechAssetBindingBlockReason({ ...valid, mimeType: 'audio/ogg' }, scope),
    speechAssetBindingBlockReason({ ...valid, projectId: 'project-2' }, scope),
    speechAssetBindingBlockReason({ ...valid, episodeId: 'episode-2' }, scope),
    speechAssetBindingBlockReason({ ...valid, sourceRevisionId: 'revision-old' }, scope),
    speechAssetBindingBlockReason({ ...valid, version: 0 }, scope),
    speechAssetBindingBlockReason({ ...valid, checksum: null }, scope),
    speechAssetBindingBlockReason({ ...valid, durationSeconds: null }, scope),
  ], [
    'SPEECH_ASSET_MISSING',
    'SPEECH_ASSET_NOT_READY',
    'SPEECH_ASSET_NOT_AUDIO',
    'SPEECH_ASSET_NOT_AUDIO',
    'SPEECH_ASSET_SCOPE_MISMATCH',
    'SPEECH_ASSET_SCOPE_MISMATCH',
    'SPEECH_ASSET_REVISION_MISMATCH',
    'SPEECH_ASSET_IDENTITY_MISSING',
    'SPEECH_ASSET_IDENTITY_MISSING',
    'SPEECH_DURATION_MISSING',
  ])
})

test('real speech durations become a frame-aligned edit point and a trim-only Provider source', async () => {
  const context = await fixture()
  try {
    addLine(context.database, 0)
    addLine(context.database, 1)
    const firstAssetId = bindSpeech(context.database, 0, 1.01, { checksumSeed: 'a' })
    const secondAssetId = bindSpeech(context.database, 1, 2.51, { checksumSeed: 'b' })
    const result = resolveShotVideoDuration(context.database, context.target)
    assert.equal(result.status, 'ready')
    if (result.status !== 'ready') return
    assert.equal(result.decision.source, 'speech_assets')
    assert.equal(result.decision.speechDurationSeconds, 3.5833333333333335)
    assert.equal(result.decision.timelineDurationSeconds, 3.5833333333333335)
    assert.equal(result.decision.providerDurationSeconds, 4)
    assert.deepEqual(result.decision.notices, [
      'AUDIO_DRIVEN_TIMELINE',
      'PROVIDER_MINIMUM_SOURCE_WILL_BE_TRIMMED',
    ])
    assert.deepEqual(result.decision.speechBindings.map((binding) => ({
      dialogueLineId: binding.dialogueLineId,
      assetId: binding.assetId,
      durationFrames: binding.durationFrames,
    })), [
      { dialogueLineId: 'line-0', assetId: firstAssetId, durationFrames: 25 },
      { dialogueLineId: 'line-1', assetId: secondAssetId, durationFrames: 61 },
    ])
    assert.equal(shotVideoDurationDecisionIsCurrent(context.database, context.target, result.decision), true)

    const replacement = bindSpeech(context.database, 1, 2.25, { checksumSeed: 'c' })
    assert.notEqual(replacement, secondAssetId)
    assert.equal(shotVideoDurationDecisionIsCurrent(context.database, context.target, result.decision), false)
  } finally {
    await context.close()
  }
})

test('manual duration cannot truncate speech and a longer override remains explicit', async () => {
  const context = await fixture()
  try {
    addLine(context.database, 0)
    bindSpeech(context.database, 0, 4.51)
    assert.deepEqual(resolveShotVideoDuration(context.database, context.target, {
      manualProviderDurationSeconds: 4,
    }), {
      status: 'manual_duration_too_short',
      shotId: 'shot-1',
      requestedDurationSeconds: 4,
      speechDurationSeconds: 4.541666666666667,
    })
    const result = resolveShotVideoDuration(context.database, context.target, {
      manualProviderDurationSeconds: 5,
    })
    assert.equal(result.status, 'ready')
    if (result.status !== 'ready') return
    assert.equal(result.decision.source, 'manual_override')
    assert.equal(result.decision.timelineDurationSeconds, 5)
    assert.equal(result.decision.providerDurationSeconds, 5)
    assert.deepEqual(result.decision.notices, [
      'AUDIO_DRIVEN_TIMELINE',
      'MANUAL_DURATION_ADDS_SILENT_TAIL',
    ])
  } finally {
    await context.close()
  }
})

test('speech beyond the Provider maximum requires a real shot split instead of stretch or truncation', async () => {
  const context = await fixture()
  try {
    addLine(context.database, 0)
    addLine(context.database, 1)
    bindSpeech(context.database, 0, 8)
    bindSpeech(context.database, 1, 7.1, { checksumSeed: 'b' })
    const result = resolveShotVideoDuration(context.database, context.target)
    assert.equal(result.status, 'requires_shot_split')
    if (result.status !== 'requires_shot_split') return
    assert.equal(result.speechDurationSeconds, 15.125)
    assert.equal(result.maximumProviderDurationSeconds, 15)
    assert.deepEqual(result.speechBindings.map((binding) => binding.dialogueLineId), ['line-0', 'line-1'])
  } finally {
    await context.close()
  }
})

test('a fractional speech tail beyond 15 seconds cannot bypass the real shot-split gate', async () => {
  const context = await fixture()
  try {
    addLine(context.database, 0)
    bindSpeech(context.database, 0, 15.02)
    const result = resolveShotVideoDuration(context.database, context.target)
    assert.equal(result.status, 'requires_shot_split')
    if (result.status !== 'requires_shot_split') return
    assert.equal(result.speechDurationSeconds, 361 / 24)
    assert.equal(result.speechBindings[0]?.durationSeconds, 15.02)
    assert.equal(result.speechBindings[0]?.durationFrames, 361)
  } finally {
    await context.close()
  }
})

test('duration decision parser rejects altered frame and Asset identities', async () => {
  const context = await fixture()
  try {
    addLine(context.database, 0)
    bindSpeech(context.database, 0, 1)
    const result = resolveShotVideoDuration(context.database, context.target)
    assert.equal(result.status, 'ready')
    if (result.status !== 'ready') return
    assert.equal(isShotVideoDurationDecision({
      ...result.decision,
      providerDurationSeconds: 3,
    }), false)
    assert.equal(isShotVideoDurationDecision({
      ...result.decision,
      speechBindings: [{ ...result.decision.speechBindings[0], checksum: 'not-a-checksum' }],
    }), false)
    assert.throws(() => resolveShotVideoDuration(context.database, context.target, {
      manualProviderDurationSeconds: 3,
    }), /integer from 4 through 15/)
  } finally {
    await context.close()
  }
})
