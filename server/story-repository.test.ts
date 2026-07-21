import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import {
  StoryRepository,
  StoryRepositoryError,
  type StoryShotCreateInput,
} from './story-repository.js'
import type { StoryDocument } from './story-schema.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-story-repository-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

function validStory(): StoryDocument {
  return {
    version: 1,
    title: '龙脉初醒',
    targetDurationSeconds: 30,
    bible: {
      logline: '少女守护长安。',
      theme: '责任',
      tone: '紧张',
      visualStyle: '国风动画',
    },
    characters: [{
      id: 'ali',
      name: '阿离',
      role: '主角',
      storyDescription: '年轻剑客',
      visualDescription: '黑色长发与红绳',
    }],
    locations: [{
      id: 'cliff',
      name: '断崖',
      storyDescription: '长安城外',
      visualDescription: '云海与落日',
    }],
    props: [{
      id: 'token',
      name: '青铜令',
      description: '唤醒龙脉',
      visualDescription: '暗红纹路',
    }],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '断崖龙吟',
      locationId: 'cliff',
      timeOfDay: '黄昏',
      description: '龙脉苏醒',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `镜头 ${index + 1}`,
        description: '阿离在风中看向云海。',
        framing: '中景',
        movement: '缓慢推进',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '国风动画，断崖，黄昏，云海。',
        dialogueLines: index === 2 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue' as const,
          speaker: '阿离',
          text: '它醒了。',
        }] : [],
      })),
    }],
  }
}

function createProjectStory(database: ManjuDatabase): {
  stories: StoryRepository
  episodeId: string
  revisionId: string
  story: StoryDocument
} {
  database.createProject({ id: 'project-1', title: 'MVP' })
  const stories = new StoryRepository(database)
  const episode = stories.ensureEpisode('project-1', { id: 'episode-1', title: '第 1 集' })
  const story = validStory()
  const revision = database.createRevision({
    id: 'revision-1',
    projectId: 'project-1',
    summary: '生成剧本',
    snapshot: structuredClone(story) as unknown as Record<string, never>,
  })
  stories.applyStory(episode.id, story, revision.id)
  return { stories, episodeId: episode.id, revisionId: revision.id, story }
}

function newShot(id: string, durationSeconds = 0.5): StoryShotCreateInput {
  return {
    id,
    code: `NEW-${id}`,
    title: `新增 ${id}`,
    description: '云海掠过一道龙影。',
    framing: '远景',
    movement: '横移',
    transition: '硬切',
    durationSeconds,
    visualPrompt: '国风动画，断崖云海中掠过龙影。',
    dialogueLines: [],
  }
}

test('valid story round-trips normalized entities and survives restart', async () => {
  const runtimeDirectory = await temporaryDirectory()
  let database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  let fixture = createProjectStory(database)

  assert.deepEqual(fixture.stories.getStory(fixture.episodeId), fixture.story)
  const relational = database.withSql((sql) => ({
    scenes: sql.all('SELECT sequence FROM scenes WHERE episode_id = ? ORDER BY sequence', fixture.episodeId),
    shots: sql.all(`
      SELECT shots.sequence, shots.timeline_start_seconds
      FROM shots JOIN scenes ON scenes.id = shots.scene_id
      WHERE scenes.episode_id = ? ORDER BY scenes.sequence, shots.sequence
    `, fixture.episodeId),
    dialogue: sql.get(`
      SELECT dialogue_lines.character_id
      FROM dialogue_lines
      JOIN shots ON shots.id = dialogue_lines.shot_id
      JOIN scenes ON scenes.id = shots.scene_id
      WHERE scenes.episode_id = ?
    `, fixture.episodeId),
  }))
  assert.deepEqual(relational.scenes.map((row) => row.sequence), [0])
  assert.deepEqual(relational.shots.map((row) => row.sequence), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(relational.shots.map((row) => row.timeline_start_seconds), [0, 5, 10, 15, 20, 25])
  assert.equal(typeof relational.dialogue?.character_id, 'string')
  assert.equal(database.health().quickCheck, 'ok')
  database.close()

  database = initializeDatabase({ runtimeDirectory, legacyStatePath: false })
  fixture = {
    ...fixture,
    stories: new StoryRepository(database),
  }
  assert.deepEqual(fixture.stories.getStory(fixture.episodeId), fixture.story)
  assert.equal(fixture.stories.getEpisode(fixture.episodeId)?.sourceRevisionId, fixture.revisionId)
  assert.equal(database.health().foreignKeys, true)
  database.close()
})

test('restoring a story revision rebuilds the normalized graph as a new head and stales downstream media', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    const { stories, episodeId, revisionId, story } = createProjectStory(database)
    const edited = stories.updateShot(episodeId, 'shot-1', { title: '后来改过的镜头' }, {
      expectedRevisionId: revisionId,
    })
    database.createMediaAsset({
      id: 'edited-storyboard',
      projectId: 'project-1',
      episodeId,
      kind: 'storyboard.image',
      status: 'ready',
      source: 'provider',
      sourceRevisionId: edited.revision.id,
    })

    const restored = stories.restoreStoryRevision(episodeId, revisionId, {
      expectedRevisionId: edited.revision.id,
    })

    assert.notEqual(restored.revision.id, revisionId)
    assert.notEqual(restored.revision.id, edited.revision.id)
    assert.equal(restored.revision.parentRevisionId, edited.revision.id)
    assert.deepEqual(restored.story, story)
    assert.deepEqual(stories.getStory(episodeId), story)
    assert.equal(stories.getEpisode(episodeId)?.sourceRevisionId, restored.revision.id)
    assert.equal(database.getProject('project-1')?.currentRevisionId, restored.revision.id)
    assert.equal(database.getMediaAsset('edited-storyboard')?.status, 'stale')
    assert.equal(restored.stale.assets, 1)
    assert.deepEqual(database.getRevision(revisionId)?.snapshot, story)

    const nonStory = database.createRevision({
      projectId: 'project-1',
      parentRevisionId: restored.revision.id,
      summary: '非剧本审计记录',
      snapshot: { type: 'asset.lock', assetId: 'x' },
    })
    const revisionCount = database.listRevisions('project-1').length
    assert.throws(
      () => stories.restoreStoryRevision(episodeId, nonStory.id, {
        expectedRevisionId: restored.revision.id,
      }),
      (error: unknown) => error instanceof StoryRepositoryError
        && error.code === 'REVISION_NOT_STORY',
    )
    assert.equal(database.listRevisions('project-1').length, revisionCount)
    assert.throws(
      () => stories.restoreStoryRevision(episodeId, revisionId, {
        expectedRevisionId: edited.revision.id,
      }),
      (error: unknown) => error instanceof StoryRepositoryError
        && error.code === 'REVISION_CONFLICT',
    )
  } finally {
    database.close()
  }
})

test('story revisions are episode-scoped and cross-episode restore fails closed', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'project-scoped', title: '多分集项目' })
    const stories = new StoryRepository(database)
    const firstEpisode = stories.ensureEpisode('project-scoped', { id: 'episode-a', title: 'A' })
    const firstStory = validStory()
    const first = stories.applyStory(firstEpisode.id, firstStory)

    const secondEpisode = stories.ensureEpisode('project-scoped', { id: 'episode-b', title: 'B' })
    const secondStory = { ...validStory(), title: '另一分集' }
    const second = stories.applyStory(secondEpisode.id, secondStory)

    assert.deepEqual(stories.listStoryRevisions(firstEpisode.id).map((revision) => revision.id), [first.revision.id])
    assert.deepEqual(stories.listStoryRevisions(secondEpisode.id).map((revision) => revision.id), [second.revision.id])
    assert.throws(
      () => stories.restoreStoryRevision(secondEpisode.id, first.revision.id, {
        expectedRevisionId: second.revision.id,
      }),
      (error: unknown) => error instanceof StoryRepositoryError
        && error.code === 'REVISION_EPISODE_MISMATCH',
    )
    assert.equal(stories.getEpisode(secondEpisode.id)?.sourceRevisionId, second.revision.id)
    assert.equal(stories.getStory(secondEpisode.id)?.title, secondStory.title)
  } finally {
    database.close()
  }
})

test('applyStory rejects a source revision whose canonical snapshot differs without side effects', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    const { stories, episodeId, revisionId, story } = createProjectStory(database)
    database.createMediaAsset({
      id: 'storyboard-before-mismatch',
      projectId: 'project-1',
      episodeId,
      kind: 'storyboard',
      status: 'ready',
      source: 'provider',
      sourceRevisionId: revisionId,
    })

    const revisionStory = structuredClone(story)
    revisionStory.title = '修订快照中的标题'
    const suppliedRevision = database.createRevision({
      id: 'revision-mismatched-snapshot',
      projectId: 'project-1',
      parentRevisionId: revisionId,
      summary: '不允许绑定到其他内容',
      snapshot: structuredClone(revisionStory) as unknown as Record<string, never>,
    })
    const appliedStory = structuredClone(revisionStory)
    appliedStory.title = '调用方传入的不同标题'
    const revisionCount = database.listRevisions('project-1').length

    assert.throws(
      () => stories.applyStory(episodeId, appliedStory, suppliedRevision.id),
      (error: unknown) => error instanceof StoryRepositoryError
        && error.code === 'REVISION_NOT_STORY'
        && /does not match/.test(error.message),
    )

    assert.equal(database.listRevisions('project-1').length, revisionCount)
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT count(*) AS count
      FROM story_revision_scopes
      WHERE revision_id = ?
    `, suppliedRevision.id))?.count, 0)
    assert.deepEqual(stories.getStory(episodeId), story)
    assert.equal(stories.getEpisode(episodeId)?.sourceRevisionId, revisionId)
    assert.equal(database.getProject('project-1')?.currentRevisionId, revisionId)
    assert.equal(database.getMediaAsset('storyboard-before-mismatch')?.status, 'ready')
  } finally {
    database.close()
  }
})

test('applyStory rolls back graph replacement and stale propagation on a mid-write failure', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    const { stories, episodeId, revisionId, story } = createProjectStory(database)
    database.createMediaAsset({
      id: 'storyboard-before-failure',
      projectId: 'project-1',
      episodeId,
      kind: 'storyboard',
      status: 'ready',
      source: 'provider',
      sourceRevisionId: revisionId,
    })
    database.withSql((sql) => sql.run(`
      CREATE TRIGGER reject_blocked_story_shot
      BEFORE INSERT ON shots
      WHEN NEW.code = 'BLOCK'
      BEGIN
        SELECT RAISE(ABORT, 'blocked by test trigger');
      END
    `))

    const changed = structuredClone(story)
    changed.title = '不应保存的标题'
    changed.scenes[0].shots[2].code = 'BLOCK'
    database.createRevision({
      id: 'revision-2',
      projectId: 'project-1',
      parentRevisionId: revisionId,
      summary: 'will fail',
      snapshot: structuredClone(changed) as unknown as Record<string, never>,
    })
    assert.throws(
      () => stories.applyStory(episodeId, changed, 'revision-2'),
      /blocked by test trigger/,
    )

    assert.deepEqual(stories.getStory(episodeId), story)
    assert.equal(stories.getEpisode(episodeId)?.sourceRevisionId, revisionId)
    assert.equal(database.getProject('project-1')?.currentRevisionId, revisionId)
    assert.equal(database.getMediaAsset('storyboard-before-failure')?.status, 'ready')
    assert.equal(database.health().quickCheck, 'ok')
  } finally {
    database.close()
  }
})

test('scene/shot edits create revisions and make storyboard, video, speech, and export outputs stale', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    const { stories, episodeId, revisionId } = createProjectStory(database)
    for (const [id, kind] of [
      ['asset-storyboard', 'storyboard'],
      ['asset-video', 'video'],
      ['asset-speech', 'speech'],
      ['asset-export', 'export'],
      ['asset-character', 'character.turnaround'],
    ] as const) {
      database.createMediaAsset({
        id,
        projectId: 'project-1',
        // Linked assets are still dependencies even when an older producer did
        // not populate episode_id on the media row.
        episodeId: id === 'asset-video' ? null : episodeId,
        kind,
        status: 'ready',
        source: 'provider',
        sourceRevisionId: revisionId,
      })
    }

    for (const [id, type, status] of [
      ['job-storyboard', 'shot.storyboard.generate', 'succeeded'],
      ['job-video', 'shot.video.generate', 'queued'],
      ['job-speech', 'dialogue.speech.generate', 'succeeded'],
      ['job-export', 'export.render', 'succeeded'],
    ] as const) {
      database.createGenerationJob({
        id,
        projectId: 'project-1',
        episodeId: id === 'job-video' ? null : episodeId,
        type,
        status,
        progress: status === 'succeeded' ? 100 : 0,
        resourceType: id === 'job-video' ? 'shot' : null,
        resourceId: id === 'job-video' ? 'shot-3' : null,
        input: { episodeId },
        output: status === 'succeeded' ? { completed: true } : null,
      })
    }

    database.withSql((sql) => {
      const now = '2026-07-14T00:00:00.000Z'
      sql.run(`
        INSERT INTO pipeline_runs (
          id, project_id, episode_id, status, progress, steps_json, created_at, updated_at
        ) VALUES ('pipeline-1', 'project-1', ?, 'succeeded', 100, '{}', ?, ?)
      `, episodeId, now, now)
      sql.run(`
        INSERT INTO exports (
          id, project_id, episode_id, status, timeline_snapshot_json, output_asset_id,
          specification_json, created_at, updated_at
        ) VALUES ('export-1', 'project-1', ?, 'succeeded', '{}', 'asset-export', '{}', ?, ?)
      `, episodeId, now, now)
      sql.run(`
        INSERT INTO quality_reports (
          id, project_id, episode_id, export_id, status, checks_json, passed, created_at
        ) VALUES ('quality-1', 'project-1', ?, 'export-1', 'passed', '{}', 1, ?)
      `, episodeId, now)
      const shot = sql.get(`
        SELECT shots.id FROM shots
        JOIN scenes ON scenes.id = shots.scene_id
        WHERE scenes.episode_id = ? AND json_extract(shots.metadata_json, '$.storyId') = 'shot-3'
      `, episodeId)
      assert.ok(shot)
      sql.run(`
        UPDATE shots SET storyboard_asset_id = 'asset-storyboard', video_asset_id = 'asset-video'
        WHERE id = ?
      `, String(shot.id))
      sql.run(`
        UPDATE dialogue_lines SET speech_asset_id = 'asset-speech' WHERE shot_id = ?
      `, String(shot.id))
    })

    const result = stories.updateShot(episodeId, 'shot-3', {
      dialogueLines: [{
        id: 'line-1',
        sequence: 0,
        kind: 'dialogue',
        speaker: '阿离',
        text: '龙脉真的醒了。',
      }],
    })

    assert.notEqual(result.revision.id, revisionId)
    assert.equal(result.revision.parentRevisionId, revisionId)
    assert.equal(result.story.scenes[0].shots[2].dialogueLines[0].text, '龙脉真的醒了。')
    assert.deepEqual(result.stale, {
      assets: 4,
      jobs: 4,
      exports: 1,
      qualityReports: 1,
      pipelineRuns: 1,
    })
    for (const id of ['asset-storyboard', 'asset-video', 'asset-speech', 'asset-export']) {
      assert.equal(database.getMediaAsset(id)?.status, 'stale')
    }
    assert.equal(database.getMediaAsset('asset-character')?.status, 'ready')

    const jobs = database.listGenerationJobs({ projectId: 'project-1' })
    for (const job of jobs) {
      assert.equal(job.progressDetail.stale, true)
      assert.equal(job.progressDetail.staleRevisionId, result.revision.id)
    }
    assert.equal(database.getGenerationJob('job-video')?.status, 'cancelled')
    assert.equal(database.getGenerationJob('job-video')?.error?.code, 'STALE_SOURCE')
    assert.equal(database.getGenerationJob('job-video')?.error?.retryable, false)
    assert.equal(database.getGenerationJob('job-storyboard')?.status, 'succeeded')

    const state = database.withSql((sql) => ({
      exportStatus: sql.get("SELECT status FROM exports WHERE id = 'export-1'")?.status,
      qualityStatus: sql.get("SELECT status FROM quality_reports WHERE id = 'quality-1'")?.status,
      pipelineStatus: sql.get("SELECT status FROM pipeline_runs WHERE id = 'pipeline-1'")?.status,
      danglingPointers: sql.get(`
        SELECT COUNT(*) AS count FROM shots
        WHERE storyboard_asset_id IS NOT NULL OR video_asset_id IS NOT NULL
      `)?.count,
      revisionCount: sql.get(`
        SELECT COUNT(*) AS count FROM revisions WHERE project_id = 'project-1'
      `)?.count,
    }))
    assert.deepEqual(state, {
      exportStatus: 'stale',
      qualityStatus: 'stale',
      pipelineStatus: 'stale',
      danglingPointers: 0,
      revisionCount: 2,
    })
    assert.equal(database.health().quickCheck, 'ok')
  } finally {
    database.close()
  }
})

test('shot structure edits resequence, enforce 6-12 bounds, and make identical reorder a no-op', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    const { stories, episodeId, revisionId } = createProjectStory(database)
    const added = stories.createShot(episodeId, 'scene-1', newShot('shot-7', 1), {
      expectedRevisionId: revisionId,
      index: 2,
    })
    assert.deepEqual(added.story.scenes[0].shots.map((shot) => shot.id), [
      'shot-1', 'shot-2', 'shot-7', 'shot-3', 'shot-4', 'shot-5', 'shot-6',
    ])
    assert.deepEqual(added.story.scenes[0].shots.map((shot) => shot.sequence), [0, 1, 2, 3, 4, 5, 6])

    const revisionCountAfterAdd = database.listRevisions('project-1').length
    assert.throws(
      () => stories.createShot(episodeId, 'scene-1', newShot('shot-7'), {
        expectedRevisionId: added.revision.id,
      }),
      (error) => error instanceof StoryRepositoryError && error.code === 'SHOT_ALREADY_EXISTS',
    )
    assert.equal(database.listRevisions('project-1').length, revisionCountAfterAdd)

    const order = ['shot-7', 'shot-1', 'shot-2', 'shot-3', 'shot-4', 'shot-5', 'shot-6']
    const reordered = stories.reorderShots(episodeId, 'scene-1', order, {
      expectedRevisionId: added.revision.id,
    })
    assert.deepEqual(reordered.story.scenes[0].shots.map((shot) => shot.id), order)
    assert.deepEqual(reordered.story.scenes[0].shots.map((shot) => shot.sequence), [0, 1, 2, 3, 4, 5, 6])

    const revisionCountAfterReorder = database.listRevisions('project-1').length
    const idempotent = stories.reorderShots(episodeId, 'scene-1', order, {
      expectedRevisionId: reordered.revision.id,
    })
    assert.equal(idempotent.revision.id, reordered.revision.id)
    assert.equal(database.listRevisions('project-1').length, revisionCountAfterReorder)

    assert.throws(
      () => stories.reorderShots(episodeId, 'scene-1', order.slice(1), {
        expectedRevisionId: reordered.revision.id,
      }),
      (error) => error instanceof StoryRepositoryError && error.code === 'INVALID_SHOT_ORDER',
    )

    const deleted = stories.deleteShot(episodeId, 'shot-7', {
      sceneId: 'scene-1',
      expectedRevisionId: reordered.revision.id,
    })
    assert.equal(deleted.story.scenes[0].shots.length, 6)
    assert.deepEqual(deleted.story.scenes[0].shots.map((shot) => shot.sequence), [0, 1, 2, 3, 4, 5])
    assert.throws(
      () => stories.deleteShot(episodeId, 'shot-1', {
        sceneId: 'scene-1',
        expectedRevisionId: deleted.revision.id,
      }),
      (error) => error instanceof StoryRepositoryError && error.code === 'SHOT_LIMIT_UNDERRUN',
    )

    let head = deleted.revision.id
    for (let index = 7; index <= 12; index += 1) {
      head = stories.createShot(episodeId, 'scene-1', newShot(`shot-${index}`), {
        expectedRevisionId: head,
      }).revision.id
    }
    assert.equal(stories.getStory(episodeId)?.scenes[0].shots.length, 12)
    assert.throws(
      () => stories.createShot(episodeId, 'scene-1', newShot('shot-13'), {
        expectedRevisionId: head,
      }),
      (error) => error instanceof StoryRepositoryError && error.code === 'SHOT_LIMIT_EXCEEDED',
    )
  } finally {
    database.close()
  }
})

test('shot structure edits reject stale writes, roll back failed persistence, and disambiguate legacy IDs by scene', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    const { stories, episodeId, revisionId, story } = createProjectStory(database)
    database.withSql((sql) => sql.run(`
      CREATE TRIGGER reject_blocked_structural_shot
      BEFORE INSERT ON shots
      WHEN NEW.code = 'BLOCK'
      BEGIN
        SELECT RAISE(ABORT, 'blocked structural shot');
      END
    `))
    const blocked = { ...newShot('blocked-shot', 1), code: 'BLOCK' }
    assert.throws(
      () => stories.createShot(episodeId, 'scene-1', blocked, { expectedRevisionId: revisionId }),
      /blocked structural shot/,
    )
    assert.deepEqual(stories.getStory(episodeId), story)
    assert.equal(stories.getEpisode(episodeId)?.sourceRevisionId, revisionId)
    assert.equal(database.listRevisions('project-1').length, 1)

    database.withSql((sql) => sql.run('DROP TRIGGER reject_blocked_structural_shot'))
    const edited = stories.updateScene(episodeId, 'scene-1', { description: '新版本' }, {
      expectedRevisionId: revisionId,
    })
    assert.throws(
      () => stories.createShot(episodeId, 'scene-1', newShot('stale-shot', 1), {
        expectedRevisionId: revisionId,
      }),
      (error) => error instanceof StoryRepositoryError && error.code === 'REVISION_CONFLICT',
    )
    assert.equal(stories.getStory(episodeId)?.scenes[0].shots.length, 6)
    assert.equal(database.listRevisions('project-1').length, 2)

    const legacy = structuredClone(edited.story)
    const originalShots = legacy.scenes[0].shots
    legacy.scenes = [{
      ...legacy.scenes[0],
      shots: originalShots.slice(0, 3).map((shot, sequence) => ({ ...shot, sequence })),
    }, {
      ...legacy.scenes[0],
      id: 'scene-2',
      sequence: 1,
      title: '断崖余波',
      shots: [
        ...originalShots.slice(3).map((shot, sequence) => ({ ...shot, sequence })),
        { ...newShot('shot-1'), sequence: 3 },
      ],
    }]
    const legacyApplied = stories.applyStory(episodeId, legacy)
    assert.throws(
      () => stories.deleteShot(episodeId, 'shot-1', {
        expectedRevisionId: legacyApplied.revision.id,
      }),
      (error) => error instanceof StoryRepositoryError && error.code === 'AMBIGUOUS_SHOT_ID',
    )
    assert.throws(
      () => stories.reorderShots(episodeId, 'scene-1', ['shot-1', 'shot-2', 'shot-4'], {
        expectedRevisionId: legacyApplied.revision.id,
      }),
      (error) => error instanceof StoryRepositoryError && error.code === 'INVALID_SHOT_ORDER',
    )
    const resolved = stories.deleteShot(episodeId, 'shot-1', {
      sceneId: 'scene-2',
      expectedRevisionId: legacyApplied.revision.id,
    })
    assert.equal(resolved.story.scenes.flatMap((scene) => scene.shots).length, 6)
    assert.deepEqual(resolved.story.scenes[1].shots.map((shot) => shot.sequence), [0, 1, 2])
  } finally {
    database.close()
  }
})
