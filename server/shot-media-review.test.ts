import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AssetRetentionService } from './asset-retention.js'
import { initializeDatabase, type ManjuDatabase } from './database.js'
import { versionTokenFromEtag } from './episode-version.js'
import {
  ShotMediaReviewError,
  ShotMediaReviewRepository,
  ShotMediaReviewService,
} from './shot-media-review.js'
import type { JsonObject } from './types.js'

const NOW = '2026-07-15T01:00:00.000Z'
const SOURCE_REVISION = 'story-revision-1'

function seedGraph(database: ManjuDatabase): void {
  database.createProject({ id: 'project-1', title: 'Review project' })
  database.createProject({ id: 'project-2', title: 'Other project' })
  database.createRevision({
    id: SOURCE_REVISION,
    projectId: 'project-1',
    summary: 'Story',
    snapshot: { version: 1 },
  })
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO episodes (
        id, project_id, title, source_text, aspect_ratio, style_preset, status,
        sort_order, source_revision_id, created_at, updated_at
      ) VALUES (?, ?, 'Episode', '', '16:9', '', 'draft', 0, ?, ?, ?)
    `, 'episode-1', 'project-1', SOURCE_REVISION, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')
    sql.run(`
      INSERT INTO scenes (
        id, episode_id, sequence, title, metadata_json, created_at, updated_at
      ) VALUES (?, ?, 0, 'Scene', ?, ?, ?)
    `, 'database-scene-1', 'episode-1', JSON.stringify({ storyId: 'scene-1' }), NOW, NOW)
    for (const [sequence, databaseShotId, publicShotId] of [
      [0, 'database-shot-1', 'shot-1'],
      [1, 'database-shot-2', 'shot-2'],
    ] as const) {
      sql.run(`
        INSERT INTO shots (
          id, scene_id, sequence, title, duration_seconds, status,
          source_revision_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 5, 'storyboard_ready', ?, ?, ?, ?)
      `,
      databaseShotId,
      'database-scene-1',
      sequence,
      publicShotId,
      SOURCE_REVISION,
      JSON.stringify({ storyId: publicShotId }),
      NOW,
      NOW,
      )
    }
  })
}

function createStoryboardCandidate(
  database: ManjuDatabase,
  input: {
    assetId: string
    jobId: string
    databaseShotId?: string
    publicShotId?: string
    sourceRevisionId?: string
    projectId?: string
    episodeId?: string
    status?: string
    mimeType?: string
    createdAt?: string
  },
): void {
  const projectId = input.projectId ?? 'project-1'
  const episodeId = input.episodeId ?? 'episode-1'
  const databaseShotId = input.databaseShotId ?? 'database-shot-1'
  const publicShotId = input.publicShotId ?? 'shot-1'
  const sourceRevisionId = input.sourceRevisionId ?? SOURCE_REVISION
  database.createGenerationJob({
    id: input.jobId,
    projectId,
    episodeId,
    type: 'asset.image.generate',
    status: 'succeeded',
    progress: 100,
    resourceId: databaseShotId,
    input: {
      count: 1,
      metadata: { kind: 'storyboard' },
      storyboardBinding: {
        episodeId,
        shotId: publicShotId,
        sceneId: 'scene-1',
        databaseShotId,
        expectedRevisionId: sourceRevisionId,
      },
    },
    completedAt: input.createdAt ?? NOW,
  })
  database.createMediaAsset({
    id: input.assetId,
    projectId,
    episodeId,
    kind: 'storyboard',
    status: input.status ?? 'ready',
    filePath: `media/${projectId}/${input.assetId}.png`,
    mimeType: input.mimeType ?? 'image/png',
    width: 1280,
    height: 720,
    checksum: input.assetId.padEnd(64, 'a').slice(0, 64).replace(/[^a-f0-9]/g, 'a'),
    source: 'provider',
    generationJobId: input.jobId,
    generationParameters: {
      shotId: publicShotId,
      sceneId: 'scene-1',
      sourceRevisionId,
    },
    sourceRevisionId,
    createdAt: input.createdAt ?? NOW,
    updatedAt: input.createdAt ?? NOW,
  })
}

function createVideoCandidate(
  database: ManjuDatabase,
  assetId: string,
  jobId: string,
  options: {
    references?: Array<{
      assetId: string
      role: 'first_frame' | 'last_frame' | 'reference_image'
      version: number
      checksum: string
      sourceRevisionId: string
    }>
    referenceDecision?: JsonObject
    omitReferenceDecision?: boolean
  } = {},
): void {
  const durableDecision = options.omitReferenceDecision
    ? undefined
    : options.referenceDecision ?? manualReferenceDecision({
        storyboardAnchorAssetId: null,
        selectedReferences: [],
      })
  database.createGenerationJob({
    id: jobId,
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'shot.video.generate',
    status: 'succeeded',
    progress: 100,
    input: {
      binding: {
        episodeId: 'episode-1',
        shotId: 'shot-1',
        sceneId: 'scene-1',
        databaseShotId: 'database-shot-1',
        expectedRevisionId: SOURCE_REVISION,
        expectedPreviousVideoAssetId: null,
      },
      ...(options.references?.length ? { references: options.references } : {}),
      ...(durableDecision ? { referenceDecision: durableDecision } : {}),
    },
  })
  database.createMediaAsset({
    id: assetId,
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'shot.video',
    status: 'ready',
    filePath: `media/project-1/${assetId}.mp4`,
    mimeType: 'video/mp4',
    width: 1280,
    height: 720,
    durationSeconds: 5,
    checksum: 'f'.repeat(64),
    source: 'provider',
    generationJobId: jobId,
    generationParameters: {
      shotId: 'shot-1',
      sceneId: 'scene-1',
      ...(options.references?.length ? { referenceAssets: options.references } : {}),
      ...(durableDecision ? { referenceDecision: durableDecision } : {}),
    },
    sourceRevisionId: SOURCE_REVISION,
  })
}

function referenceDecision(input: {
  resolution: 'storyboard_anchor' | 'not_applicable'
  storyboardAnchorAssetId: string | null
  selectedReferences: Array<{
    assetId: string
    role: 'first_frame' | 'last_frame' | 'reference_image'
  }>
}): JsonObject {
  return {
    version: 1,
    source: 'agentic_auto',
    automaticPolicy: 'deterministic_safety',
    resolution: input.resolution,
    storyboardAnchorAssetId: input.storyboardAnchorAssetId,
    selectedReferences: input.selectedReferences,
    recommendation: {
      version: 1,
      policy: 'deterministic-character-view-v1',
      status: 'not_applicable',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      sourceRevisionId: SOURCE_REVISION,
      confidence: null,
      rationale: '当前镜头没有需要绑定的角色参考图。',
      characters: [],
      references: [],
    },
  }
}

function manualReferenceDecision(input: {
  storyboardAnchorAssetId: string | null
  selectedReferences: Array<{
    assetId: string
    role: 'first_frame' | 'last_frame' | 'reference_image'
  }>
  manualCharacterSlotPins?: JsonObject[]
}): JsonObject {
  const automatic = referenceDecision({
    resolution: 'not_applicable',
    storyboardAnchorAssetId: null,
    selectedReferences: [],
  })
  delete automatic.automaticPolicy
  return {
    ...automatic,
    source: 'manual_override',
    resolution: 'manual_override',
    storyboardAnchorAssetId: input.storyboardAnchorAssetId,
    selectedReferences: input.selectedReferences,
    ...(input.manualCharacterSlotPins
      ? { manualCharacterSlotPins: input.manualCharacterSlotPins }
      : {}),
  }
}

function seedDownstream(database: ManjuDatabase): void {
  database.createPipelineRun({
    id: 'pipeline-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: SOURCE_REVISION,
    status: 'running',
    steps: { timeline: { status: 'running' } },
  })
  database.createGenerationJob({
    id: 'pipeline-render-job',
    projectId: 'project-1',
    episodeId: 'episode-1',
    pipelineRunId: 'pipeline-1',
    type: 'export.render',
    status: 'running',
    input: {},
  })
  database.createGenerationJob({
    id: 'pipeline-upstream-image-job',
    projectId: 'project-1',
    episodeId: 'episode-1',
    pipelineRunId: 'pipeline-1',
    type: 'asset.image.generate',
    status: 'queued',
    input: { metadata: { kind: 'storyboard' } },
  })
  database.createGenerationJob({
    id: 'independent-video-job',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'shot.video.generate',
    status: 'queued',
    input: {
      binding: {
        episodeId: 'episode-1',
        shotId: 'shot-1',
        sceneId: 'scene-1',
        databaseShotId: 'database-shot-1',
        expectedRevisionId: SOURCE_REVISION,
        expectedPreviousVideoAssetId: null,
      },
    },
  })
  database.createGenerationJob({
    id: 'other-shot-video-job',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'shot.video.generate',
    status: 'queued',
    input: {
      binding: {
        episodeId: 'episode-1',
        shotId: 'shot-2',
        sceneId: 'scene-1',
        databaseShotId: 'database-shot-2',
        expectedRevisionId: SOURCE_REVISION,
        expectedPreviousVideoAssetId: null,
      },
    },
  })
  database.withSql((sql) => {
    sql.run(`
      INSERT INTO exports (
        id, project_id, episode_id, status, timeline_snapshot_json,
        specification_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'succeeded', '{}', '{}', ?, ?)
    `, 'export-1', 'project-1', 'episode-1', NOW, NOW)
    sql.run(`
      INSERT INTO quality_reports (
        id, project_id, episode_id, export_id, status, checks_json,
        passed, created_at, completed_at
      ) VALUES (?, ?, ?, ?, 'passed', '{}', 1, ?, ?)
    `, 'quality-1', 'project-1', 'episode-1', 'export-1', NOW, NOW)
  })
}

function fixture() {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  seedGraph(database)
  createStoryboardCandidate(database, {
    assetId: 'asset-storyboard-a',
    jobId: 'job-storyboard-a',
    createdAt: '2026-07-15T00:10:00.000Z',
  })
  createStoryboardCandidate(database, {
    assetId: 'asset-storyboard-b',
    jobId: 'job-storyboard-b',
    createdAt: '2026-07-15T00:20:00.000Z',
  })
  database.withSql((sql) => sql.run(`
    UPDATE shots SET storyboard_asset_id = ? WHERE id = ?
  `, 'asset-storyboard-a', 'database-shot-1'))
  seedDownstream(database)
  const service = new ShotMediaReviewService(database, {
    now: () => '2026-07-15T02:00:00.000Z',
    idFactory: (() => {
      let sequence = 0
      return () => `review-${++sequence}`
    })(),
  })
  return { database, service }
}

test('repository lists immutable current-revision decisions in reverse audit order', () => {
  const { database, service } = fixture()
  try {
    const initial = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      mediaType: 'storyboard',
    })
    const version = versionTokenFromEtag(initial.episodeEtag)!
    const first = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      mediaType: 'storyboard',
      decision: 'adopt',
      assetId: 'asset-storyboard-b',
      expectedEpisodeVersion: version,
      idempotencyKey: 'adopt-b',
    })
    const repository = new ShotMediaReviewRepository(database)
    const rows = repository.listHistory({
      projectId: 'project-1',
      episodeId: 'episode-1',
      databaseShotId: 'database-shot-1',
      sourceRevisionId: SOURCE_REVISION,
    }, 'storyboard', 10, 0)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, first.review.id)
    assert.throws(
      () => database.withSql((sql) => sql.run(`
        UPDATE shot_media_review_decisions SET note = 'rewritten' WHERE id = ?
      `, first.review.id)),
      /shot media review decisions are immutable/,
    )
    assert.throws(
      () => database.withSql((sql) => sql.run(`
        DELETE FROM shot_media_review_decisions WHERE id = ?
      `, first.review.id)),
      /shot media review decisions are immutable/,
    )
    // Project deletion is the explicit audit lifecycle boundary; the trigger
    // must not make an otherwise valid project cascade undeletable.
    assert.equal(database.deleteProject('project-1'), true)
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT id FROM shot_media_review_decisions WHERE id = ?
    `, first.review.id)), undefined)
  } finally {
    database.close()
  }
})

test('adoption atomically selects an eligible candidate, preserves versions, and stales only downstream work', () => {
  const { database, service } = fixture()
  try {
    const before = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
    })
    assert.equal(before.currentSelectionAssetId, 'asset-storyboard-a')
    assert.deepEqual(before.candidates.map((candidate) => candidate.id), [
      'asset-storyboard-b',
      'asset-storyboard-a',
    ])

    const result = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'adopt',
      assetId: 'asset-storyboard-b',
      note: 'Composition is clearer',
      expectedEpisodeVersion: versionTokenFromEtag(before.episodeEtag)!,
      idempotencyKey: 'adopt-storyboard-b',
    })
    assert.equal(result.idempotent, false)
    assert.equal(result.timelineReconcileRequired, true)
    assert.deepEqual(result.review.stale, {
      generationJobs: 2,
      shotVideoJobs: 1,
      exports: 1,
      qualityReports: 1,
      pipelineRuns: 1,
    })
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT storyboard_asset_id FROM shots WHERE id = 'database-shot-1'
    `))?.storyboard_asset_id, 'asset-storyboard-b')
    assert.equal(database.getMediaAsset('asset-storyboard-a')?.status, 'ready')
    assert.equal(database.getMediaAsset('asset-storyboard-b')?.status, 'ready')
    assert.equal(database.getGenerationJob('pipeline-render-job')?.status, 'cancelled')
    assert.equal(database.getGenerationJob('independent-video-job')?.status, 'cancelled')
    assert.equal(database.getGenerationJob('other-shot-video-job')?.status, 'queued')
    assert.equal(database.getGenerationJob('pipeline-upstream-image-job')?.status, 'queued')
    assert.equal(database.getPipelineRun('pipeline-1')?.status, 'stale')
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT status FROM exports WHERE id = 'export-1'
    `))?.status, 'stale')
    assert.deepEqual({ ...database.withSql((sql) => sql.get(`
      SELECT status, passed FROM quality_reports WHERE id = 'quality-1'
    `)) }, { status: 'stale', passed: 0 })

    const replay = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'adopt',
      assetId: 'asset-storyboard-b',
      note: 'Composition is clearer',
      expectedEpisodeVersion: versionTokenFromEtag(before.episodeEtag)!,
      idempotencyKey: 'adopt-storyboard-b',
    })
    assert.equal(replay.idempotent, true)
    assert.equal(replay.review.id, result.review.id)
    assert.equal(replay.headAdvanced, false)
    assert.equal(database.withSql((sql) => sql.all(`
      SELECT id FROM shot_media_review_decisions
    `)).length, 1)

    assert.throws(() => service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'reject',
      assetId: 'asset-storyboard-a',
      expectedEpisodeVersion: versionTokenFromEtag(before.episodeEtag)!,
      idempotencyKey: 'adopt-storyboard-b',
    }), (error: unknown) => (
      error instanceof ShotMediaReviewError && error.code === 'IDEMPOTENCY_CONFLICT'
    ))
  } finally {
    database.close()
  }
})

test('adopting the auto-linked current candidate records human approval without staling downstream', () => {
  const { database, service } = fixture()
  try {
    const before = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
    })
    const result = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'adopt',
      assetId: 'asset-storyboard-a',
      note: 'Human approved the automatically linked generation',
      expectedEpisodeVersion: versionTokenFromEtag(before.episodeEtag)!,
      idempotencyKey: 'approve-current-a',
    })
    assert.equal(result.currentSelectionAssetId, 'asset-storyboard-a')
    assert.equal(result.timelineReconcileRequired, false)
    assert.equal(result.review.timelineReconcileRequired, false)
    assert.equal(result.review.previousAssetId, 'asset-storyboard-a')
    assert.equal(result.review.selectedAssetId, 'asset-storyboard-a')
    assert.deepEqual(result.review.stale, {
      generationJobs: 0,
      shotVideoJobs: 0,
      exports: 0,
      qualityReports: 0,
      pipelineRuns: 0,
    })
    assert.equal(database.getPipelineRun('pipeline-1')?.status, 'running')
    assert.equal(database.getGenerationJob('pipeline-render-job')?.status, 'running')
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT status FROM exports WHERE id = 'export-1'
    `))?.status, 'succeeded')
    assert.notEqual(result.episodeEtag, before.episodeEtag)
  } finally {
    database.close()
  }
})

test('storyboard replacement fail-closes a dependent selected video and cancels only exact same-shot active video jobs', () => {
  const { database, service } = fixture()
  try {
    const storyboard = database.getMediaAsset('asset-storyboard-a')!
    const references = [{
      assetId: storyboard.id,
      role: 'first_frame' as const,
      version: storyboard.version,
      checksum: storyboard.checksum!,
      sourceRevisionId: SOURCE_REVISION,
    }]
    const decision = referenceDecision({
      resolution: 'storyboard_anchor',
      storyboardAnchorAssetId: storyboard.id,
      selectedReferences: references.map(({ assetId, role }) => ({ assetId, role })),
    })
    createVideoCandidate(database, 'asset-video-from-storyboard-a', 'job-video-from-storyboard-a', {
      references,
      referenceDecision: decision,
    })
    const initialVideoReview = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'video',
    })
    assert.equal(initialVideoReview.candidates.find((candidate) => (
      candidate.id === 'asset-video-from-storyboard-a'
    ))?.eligible, true)
    const initialVideoAdoption = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'video',
      decision: 'adopt',
      assetId: 'asset-video-from-storyboard-a',
      expectedEpisodeVersion: versionTokenFromEtag(initialVideoReview.episodeEtag)!,
      idempotencyKey: 'adopt-dependent-video-while-a-current',
    })
    const beforeStoryboardChange = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
    })
    const adopted = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'adopt',
      assetId: 'asset-storyboard-b',
      expectedEpisodeVersion: versionTokenFromEtag(beforeStoryboardChange.episodeEtag)!,
      idempotencyKey: 'adopt-b-clears-dependent-video',
    })

    assert.equal(adopted.clearedVideoAssetId, 'asset-video-from-storyboard-a')
    assert.equal(adopted.review.clearedVideoAssetId, 'asset-video-from-storyboard-a')
    assert.equal(adopted.review.stale.shotVideoJobs, 1)
    assert.deepEqual({ ...database.withSql((sql) => sql.get(`
      SELECT storyboard_asset_id, video_asset_id, status
        FROM shots WHERE id = 'database-shot-1'
    `)) }, {
      storyboard_asset_id: 'asset-storyboard-b',
      video_asset_id: null,
      status: 'storyboard_ready',
    })
    assert.equal(database.getMediaAsset('asset-video-from-storyboard-a')?.status, 'ready')
    assert.equal(database.getGenerationJob('independent-video-job')?.status, 'cancelled')
    assert.equal(database.getGenerationJob('other-shot-video-job')?.status, 'queued')
    assert.deepEqual({ ...database.withSql((sql) => sql.get(`
      SELECT cleared_video_asset_id, stale_shot_video_jobs
        FROM shot_media_review_decisions WHERE id = ?
    `, adopted.review.id)) }, {
      cleared_video_asset_id: 'asset-video-from-storyboard-a',
      stale_shot_video_jobs: 1,
    })

    const videoReview = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'video',
    })
    assert.equal(videoReview.currentSelectionAssetId, null)
    const staleVideoCandidate = videoReview.candidates.find((candidate) => (
      candidate.id === 'asset-video-from-storyboard-a'
    ))
    assert.equal(staleVideoCandidate?.status, 'ready')
    assert.equal(staleVideoCandidate?.eligible, false)
    assert.match(staleVideoCandidate?.eligibilityError ?? '', /分镜锚点|分镜图/)
    const currentVideoVersion = versionTokenFromEtag(videoReview.episodeEtag)!
    for (const attemptedDecision of ['adopt', 'restore'] as const) {
      assert.throws(() => service.decide({
        projectId: 'project-1',
        episodeId: 'episode-1',
        shotId: 'shot-1',
        mediaType: 'video',
        decision: attemptedDecision,
        assetId: 'asset-video-from-storyboard-a',
        expectedEpisodeVersion: currentVideoVersion,
        idempotencyKey: `${attemptedDecision}-stale-dependent-video`,
      }), (error: unknown) => (
        error instanceof ShotMediaReviewError
        && error.code === 'INVALID_MEDIA_CANDIDATE'
      ))
    }
    const retention = new AssetRetentionService(database, {
      runtimeDirectory: '/tmp/manju-shot-media-review-retention-test',
      now: () => new Date('2030-07-15T00:00:00.000Z'),
    }).plan()
    const retainedVideo = retention.protected.find((candidate) => (
      candidate.assetId === 'asset-video-from-storyboard-a'
    ))
    assert.ok(retainedVideo)
    assert.ok(retainedVideo.references.includes('shot_media_review_decisions.asset_id'))

    const replay = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'adopt',
      assetId: 'asset-storyboard-b',
      expectedEpisodeVersion: versionTokenFromEtag(beforeStoryboardChange.episodeEtag)!,
      idempotencyKey: 'adopt-b-clears-dependent-video',
    })
    assert.equal(replay.idempotent, true)
    assert.equal(replay.clearedVideoAssetId, 'asset-video-from-storyboard-a')
    const restoredStoryboard = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'restore',
      assetId: 'asset-storyboard-a',
      expectedEpisodeVersion: currentVideoVersion,
      idempotencyKey: 'restore-storyboard-a-for-dependent-video',
    })
    const restoredVideoReview = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'video',
    })
    assert.equal(restoredVideoReview.candidates.find((candidate) => (
      candidate.id === 'asset-video-from-storyboard-a'
    ))?.eligible, true)
    const restoredVideo = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'video',
      decision: 'restore',
      assetId: 'asset-video-from-storyboard-a',
      expectedEpisodeVersion: versionTokenFromEtag(restoredStoryboard.episodeEtag)!,
      idempotencyKey: 'restore-dependent-video-after-storyboard-a',
    })
    assert.equal(restoredVideo.currentSelectionAssetId, 'asset-video-from-storyboard-a')
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT video_asset_id FROM shots WHERE id = 'database-shot-1'
    `))?.video_asset_id, 'asset-video-from-storyboard-a')
    assert.equal(initialVideoAdoption.review.selectedAssetId, 'asset-video-from-storyboard-a')
    assert.equal(database.deleteProject('project-1'), true)
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT id FROM shot_media_review_decisions WHERE id = ?
    `, adopted.review.id)), undefined)
  } finally {
    database.close()
  }
})

test('storyboard replacement preserves a selected video only with matching explicit text-only provenance', () => {
  const { database, service } = fixture()
  try {
    const decision = manualReferenceDecision({
      storyboardAnchorAssetId: null,
      selectedReferences: [],
    })
    createVideoCandidate(database, 'asset-video-text-only', 'job-video-text-only', {
      referenceDecision: decision,
    })
    database.withSql((sql) => sql.run(`
      UPDATE shots
         SET video_asset_id = 'asset-video-text-only', status = 'video_ready'
       WHERE id = 'database-shot-1'
    `))
    const before = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
    })
    const adopted = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'adopt',
      assetId: 'asset-storyboard-b',
      expectedEpisodeVersion: versionTokenFromEtag(before.episodeEtag)!,
      idempotencyKey: 'adopt-b-keeps-proven-text-video',
    })
    assert.equal(adopted.clearedVideoAssetId, null)
    assert.deepEqual({ ...database.withSql((sql) => sql.get(`
      SELECT storyboard_asset_id, video_asset_id, status
        FROM shots WHERE id = 'database-shot-1'
    `)) }, {
      storyboard_asset_id: 'asset-storyboard-b',
      video_asset_id: 'asset-video-text-only',
      status: 'video_ready',
    })
    assert.equal(database.getMediaAsset('asset-video-text-only')?.status, 'ready')
  } finally {
    database.close()
  }
})

test('rejecting a non-current candidate only appends audit and advances Episode ETag', () => {
  const { database, service } = fixture()
  try {
    const before = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
    })
    const originalVersion = versionTokenFromEtag(before.episodeEtag)!
    const rejected = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'reject',
      assetId: 'asset-storyboard-b',
      note: 'Character face is inconsistent',
      expectedEpisodeVersion: originalVersion,
      idempotencyKey: 'reject-storyboard-b',
    })
    assert.notEqual(rejected.episodeEtag, before.episodeEtag)
    assert.equal(rejected.currentSelectionAssetId, 'asset-storyboard-a')
    assert.equal(rejected.review.previousAssetId, 'asset-storyboard-a')
    assert.equal(rejected.review.selectedAssetId, 'asset-storyboard-a')
    assert.equal(rejected.timelineReconcileRequired, false)
    assert.deepEqual(rejected.review.stale, {
      generationJobs: 0,
      shotVideoJobs: 0,
      exports: 0,
      qualityReports: 0,
      pipelineRuns: 0,
    })
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT storyboard_asset_id FROM shots WHERE id = 'database-shot-1'
    `))?.storyboard_asset_id, 'asset-storyboard-a')
    assert.equal(database.getGenerationJob('pipeline-render-job')?.status, 'running')
    assert.equal(database.getPipelineRun('pipeline-1')?.status, 'running')
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT status FROM exports WHERE id = 'export-1'
    `))?.status, 'succeeded')
    assert.deepEqual({ ...database.withSql((sql) => sql.get(`
      SELECT status, passed FROM quality_reports WHERE id = 'quality-1'
    `)) }, { status: 'passed', passed: 1 })

    const replay = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'reject',
      assetId: 'asset-storyboard-b',
      note: 'Character face is inconsistent',
      expectedEpisodeVersion: originalVersion,
      idempotencyKey: 'reject-storyboard-b',
    })
    assert.equal(replay.idempotent, true)
    assert.equal(replay.review.id, rejected.review.id)
    assert.equal(database.withSql((sql) => sql.all(`
      SELECT id FROM shot_media_review_decisions WHERE decision = 'reject'
    `)).length, 1)
  } finally {
    database.close()
  }
})

test('video review accepts only exact shot.video generation provenance and updates video fact source', () => {
  const { database, service } = fixture()
  try {
    createVideoCandidate(database, 'asset-video-a', 'job-video-a')
    const listed = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      mediaType: 'video',
    })
    assert.deepEqual(listed.candidates.map((candidate) => ({
      id: candidate.id,
      mimeType: candidate.mimeType,
      durationSeconds: candidate.durationSeconds,
    })), [{ id: 'asset-video-a', mimeType: 'video/mp4', durationSeconds: 5 }])
    const adopted = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      mediaType: 'video',
      decision: 'adopt',
      assetId: 'asset-video-a',
      expectedEpisodeVersion: versionTokenFromEtag(listed.episodeEtag)!,
      idempotencyKey: 'adopt-video-a',
    })
    assert.equal(adopted.currentSelectionAssetId, 'asset-video-a')
    assert.equal(database.withSql((sql) => sql.get(`
      SELECT video_asset_id FROM shots WHERE id = 'database-shot-1'
    `))?.video_asset_id, 'asset-video-a')
    assert.equal(database.getMediaAsset('asset-video-a')?.status, 'ready')
  } finally {
    database.close()
  }
})

test('video candidates fail closed when durable reference provenance is missing or its immutable pin drifts', () => {
  const { database, service } = fixture()
  try {
    createVideoCandidate(database, 'asset-video-missing-decision', 'job-video-missing-decision', {
      omitReferenceDecision: true,
    })
    const storyboard = database.getMediaAsset('asset-storyboard-a')!
    const driftedReferences = [{
      assetId: storyboard.id,
      role: 'first_frame' as const,
      version: storyboard.version + 1,
      checksum: '0'.repeat(64),
      sourceRevisionId: SOURCE_REVISION,
    }]
    createVideoCandidate(database, 'asset-video-reference-drift', 'job-video-reference-drift', {
      references: driftedReferences,
      referenceDecision: referenceDecision({
        resolution: 'storyboard_anchor',
        storyboardAnchorAssetId: storyboard.id,
        selectedReferences: driftedReferences.map(({ assetId, role }) => ({ assetId, role })),
      }),
    })

    const listed = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      mediaType: 'video',
    })
    const missing = listed.candidates.find((candidate) => (
      candidate.id === 'asset-video-missing-decision'
    ))
    const drifted = listed.candidates.find((candidate) => (
      candidate.id === 'asset-video-reference-drift'
    ))
    assert.equal(missing?.eligible, false)
    assert.match(missing?.eligibilityError ?? '', /缺少完整/)
    assert.equal(drifted?.eligible, false)
    assert.match(drifted?.eligibilityError ?? '', /version\/checksum/)

    const expectedEpisodeVersion = versionTokenFromEtag(listed.episodeEtag)!
    for (const assetId of [
      'asset-video-missing-decision',
      'asset-video-reference-drift',
    ]) {
      assert.throws(() => service.decide({
        projectId: 'project-1',
        episodeId: 'episode-1',
        shotId: 'shot-1',
        sceneId: 'scene-1',
        mediaType: 'video',
        decision: 'adopt',
        assetId,
        expectedEpisodeVersion,
        idempotencyKey: `reject-unsafe-${assetId}`,
      }), (error: unknown) => (
        error instanceof ShotMediaReviewError
        && error.code === 'INVALID_MEDIA_CANDIDATE'
      ))
    }
  } finally {
    database.close()
  }
})

test('video review accepts same-shot first/last storyboard versions while requiring the declared anchor to stay current', () => {
  const { database, service } = fixture()
  try {
    const first = database.getMediaAsset('asset-storyboard-a')!
    const last = database.getMediaAsset('asset-storyboard-b')!
    const references = [{
      assetId: first.id,
      role: 'first_frame' as const,
      version: first.version,
      checksum: first.checksum!,
      sourceRevisionId: SOURCE_REVISION,
    }, {
      assetId: last.id,
      role: 'last_frame' as const,
      version: last.version,
      checksum: last.checksum!,
      sourceRevisionId: SOURCE_REVISION,
    }]
    createVideoCandidate(database, 'asset-video-first-last', 'job-video-first-last', {
      references,
      referenceDecision: manualReferenceDecision({
        storyboardAnchorAssetId: first.id,
        selectedReferences: references.map(({ assetId, role }) => ({ assetId, role })),
      }),
    })

    const listed = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      mediaType: 'video',
    })
    const candidate = listed.candidates.find(({ id }) => id === 'asset-video-first-last')
    assert.equal(candidate?.eligible, true)
    assert.equal(candidate?.eligibilityError, null)
  } finally {
    database.close()
  }
})

test('video review revalidates a manual character slot pin after the slot changes', () => {
  const { database, service } = fixture()
  try {
    database.createRevision({
      id: 'slot-audit-1',
      projectId: 'project-1',
      summary: 'front slot v1',
      snapshot: { type: 'character.slot.audit' },
    })
    database.createRevision({
      id: 'slot-audit-2',
      projectId: 'project-1',
      summary: 'front slot v2',
      snapshot: { type: 'character.slot.audit' },
    })
    database.createMediaAsset({
      id: 'character-front-v1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'character.reference',
      status: 'ready',
      filePath: 'media/project-1/front-v1.png',
      mimeType: 'image/png',
      checksum: 'c'.repeat(64),
      source: 'test',
      sourceRevisionId: SOURCE_REVISION,
    })
    database.createMediaAsset({
      id: 'character-front-v2',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'character.reference',
      status: 'ready',
      filePath: 'media/project-1/front-v2.png',
      mimeType: 'image/png',
      checksum: 'd'.repeat(64),
      source: 'test',
      sourceRevisionId: SOURCE_REVISION,
    })
    database.withSql((sql) => {
      sql.run(`
        INSERT INTO characters (
          id, project_id, episode_id, name, version, metadata_json,
          created_at, updated_at
        ) VALUES (
          'database-character-1', 'project-1', 'episode-1', 'Hero', 1,
          '{"storyId":"hero"}', ?, ?
        )
      `, NOW, NOW)
      sql.run(`
        INSERT INTO character_visual_references (
          character_id, project_id, episode_id, role, asset_id, version,
          audit_revision_id, updated_at
        ) VALUES (
          'database-character-1', 'project-1', 'episode-1', 'front',
          'character-front-v1', 1, 'slot-audit-1', ?
        )
      `, NOW)
    })
    const characterAsset = database.getMediaAsset('character-front-v1')!
    const pin = {
      characterId: 'hero',
      characterName: 'Hero',
      view: 'front',
      assetId: characterAsset.id,
      assetVersion: characterAsset.version,
      assetChecksum: characterAsset.checksum!,
      assetSourceRevisionId: SOURCE_REVISION,
      slotVersion: 1,
      slotAuditRevisionId: 'slot-audit-1',
    }
    const references = [{
      assetId: characterAsset.id,
      role: 'reference_image' as const,
      version: characterAsset.version,
      checksum: characterAsset.checksum!,
      sourceRevisionId: SOURCE_REVISION,
    }]
    createVideoCandidate(database, 'asset-video-character-slot', 'job-video-character-slot', {
      references,
      referenceDecision: manualReferenceDecision({
        storyboardAnchorAssetId: null,
        selectedReferences: [{ assetId: characterAsset.id, role: 'reference_image' }],
        manualCharacterSlotPins: [pin],
      }),
    })
    const before = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'video',
    })
    assert.equal(before.candidates.find(({ id }) => (
      id === 'asset-video-character-slot'
    ))?.eligible, true)

    database.withSql((sql) => sql.run(`
      UPDATE character_visual_references
         SET asset_id = 'character-front-v2', version = 2,
             audit_revision_id = 'slot-audit-2', updated_at = ?
       WHERE character_id = 'database-character-1' AND role = 'front'
    `, '2026-07-15T03:00:00.000Z'))
    const after = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'video',
    })
    const stale = after.candidates.find(({ id }) => id === 'asset-video-character-slot')
    assert.equal(stale?.eligible, false)
    assert.match(stale?.eligibilityError ?? '', /角色参考槽位/)
  } finally {
    database.close()
  }
})

test('immutable review trigger rejects previous/selected assets with the wrong media kind', () => {
  const { database } = fixture()
  try {
    database.createMediaAsset({
      id: 'wrong-previous-audio',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'audio',
      status: 'ready',
      filePath: 'media/project-1/wrong.wav',
      mimeType: 'audio/wav',
      checksum: 'e'.repeat(64),
      source: 'test',
      sourceRevisionId: SOURCE_REVISION,
    })
    assert.throws(() => database.withSql((sql) => sql.run(`
      INSERT INTO shot_media_review_decisions (
        id, project_id, episode_id, shot_id, source_revision_id, media_type,
        decision, asset_id, previous_asset_id, selected_asset_id, note,
        expected_episode_version, idempotency_key_hash, request_hash,
        timeline_reconcile_required, cleared_video_asset_id,
        stale_generation_jobs, stale_shot_video_jobs, stale_exports,
        stale_quality_reports, stale_pipeline_runs, created_at
      ) VALUES (
        'forged-review', 'project-1', 'episode-1', 'database-shot-1', ?,
        'storyboard', 'reject', 'asset-storyboard-b',
        'wrong-previous-audio', 'wrong-previous-audio', NULL,
        'version', ?, ?, 0, NULL, 0, 0, 0, 0, 0, ?
      )
    `, SOURCE_REVISION, '1'.repeat(64), '2'.repeat(64), NOW)),
    /shot media review previous asset mismatch/)
  } finally {
    database.close()
  }
})

test('candidate validation rejects cross-shot and stale/unsafe assets while restore requires audit provenance', () => {
  const { database, service } = fixture()
  try {
    createStoryboardCandidate(database, {
      assetId: 'asset-other-shot',
      jobId: 'job-other-shot',
      databaseShotId: 'database-shot-2',
      publicShotId: 'shot-2',
    })
    database.createMediaAsset({
      id: 'asset-uploaded',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'storyboard',
      status: 'ready',
      filePath: 'media/project-1/uploaded.png',
      mimeType: 'image/png',
      checksum: 'e'.repeat(64),
      source: 'upload',
      generationParameters: { shotId: 'shot-1', sceneId: 'scene-1' },
      sourceRevisionId: SOURCE_REVISION,
    })
    const before = service.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
    })
    assert.equal(before.candidates.some((candidate) => candidate.id === 'asset-other-shot'), false)
    assert.equal(before.candidates.some((candidate) => candidate.id === 'asset-uploaded'), false)
    const expected = versionTokenFromEtag(before.episodeEtag)!

    for (const [assetId, code] of [
      ['asset-other-shot', 'INVALID_MEDIA_CANDIDATE'],
      ['asset-uploaded', 'INVALID_MEDIA_CANDIDATE'],
    ] as const) {
      assert.throws(() => service.decide({
        projectId: 'project-1',
        episodeId: 'episode-1',
        shotId: 'shot-1',
        mediaType: 'storyboard',
        decision: 'adopt',
        assetId,
        expectedEpisodeVersion: expected,
        idempotencyKey: `invalid-${assetId}`,
      }), (error: unknown) => error instanceof ShotMediaReviewError && error.code === code)
    }

    assert.throws(() => service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'restore',
      assetId: 'asset-storyboard-b',
      expectedEpisodeVersion: expected,
      idempotencyKey: 'restore-never-selected',
    }), (error: unknown) => (
      error instanceof ShotMediaReviewError && error.code === 'RESTORE_HISTORY_REQUIRED'
    ))

    const adopted = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'adopt',
      assetId: 'asset-storyboard-b',
      expectedEpisodeVersion: expected,
      idempotencyKey: 'adopt-before-restore',
    })
    const restored = service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'restore',
      assetId: 'asset-storyboard-a',
      expectedEpisodeVersion: versionTokenFromEtag(adopted.episodeEtag)!,
      idempotencyKey: 'restore-a',
    })
    assert.equal(restored.review.previousAssetId, 'asset-storyboard-b')
    assert.equal(restored.review.selectedAssetId, 'asset-storyboard-a')

    assert.throws(() => service.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      mediaType: 'storyboard',
      decision: 'adopt',
      assetId: 'asset-storyboard-b',
      expectedEpisodeVersion: expected,
      idempotencyKey: 'stale-etag',
    }), (error: unknown) => (
      error instanceof ShotMediaReviewError && error.code === 'PRECONDITION_FAILED'
    ))
  } finally {
    database.close()
  }
})
