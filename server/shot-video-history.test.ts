import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { initializeDatabase } from './database.js'
import { versionTokenFromEtag } from './episode-version.js'
import { MediaStore } from './media.js'
import {
  SHOT_VIDEO_HISTORY_ADOPTION_JOB_TYPE,
  ShotMediaReviewService,
} from './shot-media-review.js'
import { ShotVideoHistoryService } from './shot-video-history.js'

const PRIOR_REVISION = 'story-prior'
const CURRENT_REVISION = 'story-current'

test('lists exact-snapshot historical shot videos and restores one without a Provider call', async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'manju-shot-video-history-'))
  const database = initializeDatabase({
    databasePath: join(runtimeDirectory, 'manju.sqlite'),
    legacyStatePath: false,
  })
  try {
    database.createProject({ id: 'project-1', title: 'History project' })
    const exactSnapshot = {
      version: 1,
      title: 'Same story',
      scenes: [{ id: 'scene-1', shots: [{ id: 'shot-1', prompt: 'same' }] }],
    }
    database.createRevision({
      id: PRIOR_REVISION,
      projectId: 'project-1',
      summary: 'Prior',
      snapshot: exactSnapshot,
    })
    database.createRevision({
      id: CURRENT_REVISION,
      projectId: 'project-1',
      parentRevisionId: PRIOR_REVISION,
      summary: 'Undo back to identical story',
      snapshot: exactSnapshot,
    })
    database.withSql((sql) => {
      sql.run(`
        INSERT INTO episodes (
          id, project_id, title, source_text, aspect_ratio, style_preset, status,
          sort_order, source_revision_id, created_at, updated_at
        ) VALUES ('episode-1', 'project-1', 'Episode', '', '16:9', '', 'draft',
          0, ?, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')
      `, CURRENT_REVISION)
      sql.run(`
        INSERT INTO scenes (
          id, episode_id, sequence, title, metadata_json, created_at, updated_at
        ) VALUES ('database-scene-1', 'episode-1', 0, 'Scene', '{"storyId":"scene-1"}',
          '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')
      `)
      sql.run(`
        INSERT INTO shots (
          id, scene_id, sequence, title, duration_seconds, status,
          source_revision_id, metadata_json, created_at, updated_at
        ) VALUES ('database-shot-1', 'database-scene-1', 0, 'Shot', 5, 'storyboard_ready',
          ?, '{"storyId":"shot-1"}', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')
      `, CURRENT_REVISION)
    })

    const mediaStore = new MediaStore(database, { runtimeDirectory })
    await mediaStore.init()
    const bytes = Buffer.from([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d,
      0x00, 0x00, 0x00, 0x00,
    ])
    await mediaStore.save({
      id: 'historical-video',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'shot.video',
      bytes,
      mimeType: 'video/mp4',
      source: 'provider',
      generationJobId: 'historical-video-job',
      generationParameters: { shotId: 'shot-1', sceneId: 'scene-1' },
      sourceRevisionId: PRIOR_REVISION,
      width: 1280,
      height: 720,
      durationSeconds: 5,
      status: 'stale',
    }, {
      beforeCreate: (transaction) => transaction.createGenerationJob({
        id: 'historical-video-job',
        projectId: 'project-1',
        episodeId: 'episode-1',
        type: 'shot.video.generate',
        status: 'succeeded',
        progress: 100,
        input: {
          binding: {
            databaseShotId: 'database-shot-1',
            episodeId: 'episode-1',
            shotId: 'shot-1',
            sceneId: 'scene-1',
            expectedRevisionId: PRIOR_REVISION,
          },
        },
        completedAt: '2026-07-15T00:00:00.000Z',
      }),
    })

    const reviewService = new ShotMediaReviewService(database)
    const service = new ShotVideoHistoryService({
      database,
      mediaStore,
      shotMediaReviewService: reviewService,
      publicAsset: (asset) => ({ id: asset.id }),
      publicJob: (job) => ({ id: job.id }),
      admit: (operation) => operation(),
    })
    const listed = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
    })
    assert.equal(listed.candidates.length, 1)
    assert.equal(listed.candidates[0]?.priorSourceRevisionId, PRIOR_REVISION)
    assert.equal(listed.candidates[0]?.compatibility.providerCallRequired, false)

    const expectedEpisodeVersion = versionTokenFromEtag(listed.episodeEtag)!
    const restored = await service.restore({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      sourceAssetId: 'historical-video',
      expectedEpisodeVersion,
      idempotencyKey: 'restore-history-once',
    })
    assert.equal(restored.providerCallRequired, false)
    assert.equal(restored.asset.parentAssetId, 'historical-video')
    assert.equal(restored.asset.sourceRevisionId, CURRENT_REVISION)
    assert.equal(restored.job.type, 'shot.video.generate')
    assert.equal(restored.job.input.operation, SHOT_VIDEO_HISTORY_ADOPTION_JOB_TYPE)
    assert.equal(restored.review.currentSelectionAssetId, restored.asset.id)
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT video_asset_id FROM shots WHERE id = 'database-shot-1'
    `))?.video_asset_id, restored.asset.id)

    const replay = await service.restore({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      sourceAssetId: 'historical-video',
      expectedEpisodeVersion,
      idempotencyKey: 'restore-history-once',
    })
    assert.equal(replay.idempotent, true)
    assert.equal(replay.asset.id, restored.asset.id)
    assert.equal(database.listMediaAssets({ projectId: 'project-1', kind: 'shot.video' }).length, 2)
  } finally {
    database.close()
    await rm(runtimeDirectory, { recursive: true, force: true })
  }
})
