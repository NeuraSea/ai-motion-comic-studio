import assert from 'node:assert/strict'
import test from 'node:test'

import { initializeDatabase, type JobStatus, type ManjuDatabase } from './database.js'
import {
  parseShotVideoBatchRequest,
  prepareShotVideoBatch,
  shotVideoBatchRequestFingerprint,
  ShotVideoBatchError,
  type ShotVideoBatchRequest,
} from './shot-video-batch.js'
import {
  SHOT_VIDEO_VISUAL_REFERENCE_ANALYSIS_VERSION,
  type ShotVideoVisualReferenceAnalysis,
} from './shot-video-visual-reference-analysis.js'
import {
  prepareShotVideoVisualReferenceJob,
  resolvePersistedShotVideoVisionAssessment,
  SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
  ShotVideoVisualReferenceResolutionError,
  type ShotVideoVisualReferenceJobInput,
} from './shot-video-visual-reference-job.js'
import type { JsonObject } from './types.js'

const NOW = '2026-07-15T08:00:00.000Z'
const PROJECT_ID = 'project-vision-resolution'
const EPISODE_ID = 'episode-vision-resolution'
const REVISION_ID = 'story-vision-resolution-r1'
const PROVIDER = {
  providerId: 'seedance-video',
  configRevision: 7,
  model: 'doubao-seedance-test',
}

function createImage(
  database: ManjuDatabase,
  id: string,
  checksumCharacter: string,
): void {
  database.createMediaAsset({
    id,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    kind: 'fixture.image',
    version: 1,
    status: 'ready',
    mimeType: 'image/png',
    width: 1_024,
    height: 1_024,
    checksum: checksumCharacter.repeat(64),
    source: 'fixture',
    sourceRevisionId: REVISION_ID,
  })
}

function fixture(): ManjuDatabase {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  database.createProject({ id: PROJECT_ID, title: '视觉选镜持久化契约' })
  database.createRevision({
    id: REVISION_ID,
    projectId: PROJECT_ID,
    summary: '视觉选镜测试剧本',
    snapshot: { version: 1, kind: 'story' },
    createdAt: NOW,
  })
  database.withSql((sql) => sql.run(`
    INSERT INTO episodes (
      id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
      style_preset, status, sort_order, created_at, updated_at, metadata_json,
      source_revision_id
    ) VALUES (?, ?, '第 1 集', '', 10, '16:9', '国风动画', 'draft', 0, ?, ?, '{}', ?)
  `, EPISODE_ID, PROJECT_ID, NOW, NOW, REVISION_ID))

  createImage(database, 'storyboard-sh0', '1')
  createImage(database, 'storyboard-sh1', '2')
  createImage(database, 'asset-token', '3')
  createImage(database, 'asset-cliff', '4')
  createImage(database, 'asset-rogue', '5')

  database.withSql((sql) => {
    sql.run(`
      INSERT INTO props (
        id, project_id, episode_id, name, story_description, visual_description,
        locked_asset_id, version, metadata_json, created_at, updated_at
      ) VALUES (
        'prop-token-row', ?, ?, '青铜令牌', '龙脉钥匙', '暗红纹路的六边形令牌',
        'asset-token', 1, '{"storyId":"token"}', ?, ?
      )
    `, PROJECT_ID, EPISODE_ID, NOW, NOW)
    sql.run(`
      INSERT INTO locations (
        id, project_id, episode_id, name, story_description, visual_description,
        locked_asset_id, version, metadata_json, created_at, updated_at
      ) VALUES (
        'location-cliff-row', ?, ?, '断崖', '长安城外', '云海与山石',
        'asset-cliff', 1, '{"storyId":"cliff"}', ?, ?
      )
    `, PROJECT_ID, EPISODE_ID, NOW, NOW)
    sql.run(`
      INSERT INTO scenes (
        id, episode_id, sequence, title, description, duration_seconds,
        metadata_json, created_at, updated_at
      ) VALUES (
        'scene-row', ?, 0, '断崖', '黄昏断崖', 10,
        '{"storyId":"scene-0","locationId":"cliff"}', ?, ?
      )
    `, EPISODE_ID, NOW, NOW)
    for (const [index, shotId, storyboardId] of [
      [0, 'sh0', 'storyboard-sh0'],
      [1, 'sh1', 'storyboard-sh1'],
    ] as const) {
      sql.run(`
        INSERT INTO shots (
          id, scene_id, sequence, code, title, description, framing, movement,
          transition, duration_seconds, timeline_start_seconds, prompt, status,
          storyboard_asset_id, source_revision_id, metadata_json, created_at, updated_at
        ) VALUES (?, 'scene-row', ?, ?, ?, ?, '特写', '缓慢推近', 'cut', 5, ?, ?,
          'storyboard_ready', ?, ?, ?, ?, ?)
      `,
      `shot-row-${shotId}`,
      index,
      `S0-${index}`,
      index === 0 ? '令牌发光' : '云海翻涌',
      index === 0 ? '青铜令牌在掌心发光' : '断崖云海翻涌',
      index * 5,
      index === 0 ? '青铜令牌与断崖的细节' : '断崖云海',
      storyboardId,
      REVISION_ID,
      JSON.stringify({ storyId: shotId }),
      NOW,
      NOW)
    }
  })
  database.updateProject(PROJECT_ID, {
    currentEpisodeId: EPISODE_ID,
    currentRevisionId: REVISION_ID,
  })
  return database
}

function preparedScope(database: ManjuDatabase): ShotVideoVisualReferenceJobInput {
  return prepareShotVideoVisualReferenceJob(database, {
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    selectors: [
      { shotId: 'sh0', sceneId: 'scene-0' },
      { shotId: 'sh1', sceneId: 'scene-0' },
    ],
  })
}

function validAnalysis(scope: ShotVideoVisualReferenceJobInput): ShotVideoVisualReferenceAnalysis {
  return {
    version: SHOT_VIDEO_VISUAL_REFERENCE_ANALYSIS_VERSION,
    inputFingerprint: scope.inputFingerprint,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sourceRevisionId: REVISION_ID,
    plans: [{
      shotId: 'sh0',
      sceneId: 'scene-0',
      status: 'recommended',
      strategy: 'multi_reference',
      confidence: 0.94,
      rationale: '画面主体是令牌，使用本镜分镜和锁定道具图。',
      visualEvidence: ['分镜中令牌占据画面中心。'],
      selectedReferences: [{
        assetId: 'storyboard-sh0',
        role: 'reference_image',
        purpose: '当前镜头构图',
      }, {
        assetId: 'asset-token',
        role: 'reference_image',
        purpose: '令牌造型一致性',
      }],
      missingCharacterViews: [],
    }, {
      shotId: 'sh1',
      sceneId: 'scene-0',
      status: 'recommended',
      strategy: 'first_frame',
      confidence: 0.91,
      rationale: '本镜分镜足以约束云海构图。',
      visualEvidence: ['画面没有身份敏感角色。'],
      selectedReferences: [{
        assetId: 'storyboard-sh1',
        role: 'first_frame',
        purpose: '当前镜头首帧构图',
      }],
      missingCharacterViews: [],
    }],
  }
}

function persistAnalysisJob(
  database: ManjuDatabase,
  options: {
    id?: string
    status?: JobStatus
    scope?: ShotVideoVisualReferenceJobInput
    analysis?: ShotVideoVisualReferenceAnalysis
    type?: string
    projectId?: string
    episodeId?: string
  } = {},
): string {
  const scope = options.scope ?? preparedScope(database)
  const analysis = options.analysis ?? validAnalysis(scope)
  const id = options.id ?? 'vision-analysis-job'
  database.createGenerationJob({
    id,
    projectId: options.projectId ?? PROJECT_ID,
    episodeId: options.episodeId ?? EPISODE_ID,
    type: options.type ?? SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE,
    status: options.status ?? 'succeeded',
    progress: options.status === 'succeeded' || options.status === undefined ? 100 : 0,
    resourceType: 'episode',
    resourceId: EPISODE_ID,
    input: scope as unknown as JsonObject,
    output: { analysis: analysis as unknown as JsonObject },
    completedAt: options.status === 'succeeded' || options.status === undefined ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  })
  return id
}

function resolve(database: ManjuDatabase, overrides: Partial<{
  jobId: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  shotId: string
  sceneId: string
}> = {}) {
  return resolvePersistedShotVideoVisionAssessment(database, {
    jobId: 'vision-analysis-job',
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sourceRevisionId: REVISION_ID,
    shotId: 'sh0',
    sceneId: 'scene-0',
    ...overrides,
  })
}

function expectResolutionError(
  operation: () => unknown,
  code: ShotVideoVisualReferenceResolutionError['code'],
): void {
  assert.throws(operation, (error) => (
    error instanceof ShotVideoVisualReferenceResolutionError && error.code === code
  ))
}

test('resolver accepts only a succeeded, fingerprint-bound Job from the exact project and shot scope', async (context) => {
  await context.test('valid succeeded Job resolves the exact per-shot assessment', () => {
    const database = fixture()
    try {
      persistAnalysisJob(database)
      const assessment = resolve(database)
      assert.equal(assessment.source, 'persisted_vision')
      assert.equal(assessment.mode, 'selected_references')
      assert.equal(assessment.shotId, 'sh0')
      assert.deepEqual(assessment.selectedReferences.map(({ assetId, role }) => ({ assetId, role })), [{
        assetId: 'storyboard-sh0',
        role: 'reference_image',
      }, {
        assetId: 'asset-token',
        role: 'reference_image',
      }])
    } finally {
      database.close()
    }
  })

  for (const status of ['queued', 'running', 'waiting_provider', 'failed', 'cancelled'] as const) {
    await context.test(`${status} Job is not authoritative`, () => {
      const database = fixture()
      try {
        persistAnalysisJob(database, { status })
        expectResolutionError(() => resolve(database), 'VIDEO_REFERENCE_ANALYSIS_NOT_READY')
      } finally {
        database.close()
      }
    })
  }

  await context.test('wrong project is indistinguishable from a missing Job', () => {
    const database = fixture()
    try {
      persistAnalysisJob(database)
      expectResolutionError(
        () => resolve(database, { projectId: 'other-project' }),
        'VIDEO_REFERENCE_ANALYSIS_NOT_FOUND',
      )
    } finally {
      database.close()
    }
  })

  await context.test('wrong shot and revision are stale rather than silently reused', () => {
    const database = fixture()
    try {
      persistAnalysisJob(database)
      expectResolutionError(
        () => resolve(database, { shotId: 'sh-not-in-analysis' }),
        'VIDEO_REFERENCE_ANALYSIS_STALE',
      )
      expectResolutionError(
        () => resolve(database, { sourceRevisionId: 'story-newer-r2' }),
        'VIDEO_REFERENCE_ANALYSIS_STALE',
      )
    } finally {
      database.close()
    }
  })

  await context.test('output fingerprint must match the immutable prepared input', () => {
    const database = fixture()
    try {
      const scope = preparedScope(database)
      const analysis = validAnalysis(scope)
      analysis.inputFingerprint = 'f'.repeat(64)
      persistAnalysisJob(database, { scope, analysis })
      expectResolutionError(() => resolve(database), 'VIDEO_REFERENCE_ANALYSIS_INVALID')
    } finally {
      database.close()
    }
  })
})

test('resolver rejects current-scope Asset drift before an analysis can reach Seedance preflight', () => {
  const database = fixture()
  try {
    persistAnalysisJob(database)
    database.updateMediaAsset('asset-token', { version: 2 })
    expectResolutionError(() => resolve(database), 'VIDEO_REFERENCE_ANALYSIS_STALE')
    assert.equal(database.listGenerationJobs({ projectId: PROJECT_ID }).length, 1)
  } finally {
    database.close()
  }
})

test('resolver rejects an otherwise well-formed output that selects an Asset outside the shot candidate set', () => {
  const database = fixture()
  try {
    const scope = preparedScope(database)
    const analysis = validAnalysis(scope)
    analysis.plans[0]!.selectedReferences[1] = {
      assetId: 'asset-rogue',
      role: 'reference_image',
      purpose: '不属于分析候选范围的图片',
    }
    persistAnalysisJob(database, { scope, analysis })
    expectResolutionError(() => resolve(database), 'VIDEO_REFERENCE_ANALYSIS_INVALID')
  } finally {
    database.close()
  }
})

test('resolver rejects another Shot storyboard instead of accepting it as the current Shot reference', () => {
  const database = fixture()
  try {
    const scope = preparedScope(database)
    const analysis = validAnalysis(scope)
    analysis.plans[0]!.selectedReferences[0] = {
      assetId: 'storyboard-sh1',
      role: 'reference_image',
      purpose: '错误的下一镜分镜',
    }
    persistAnalysisJob(database, { scope, analysis })
    expectResolutionError(() => resolve(database), 'VIDEO_REFERENCE_ANALYSIS_INVALID')
  } finally {
    database.close()
  }
})

test('batch DTO supports unambiguous per-selection analysis Jobs without changing legacy fingerprints', () => {
  const body = {
    projectId: PROJECT_ID,
    resolution: '720p',
    audioPolicy: 'silent',
    generateAudio: false,
    referenceAnalysisJobId: 'vision-analysis-job',
    selections: [{ shotId: 'sh0', sceneId: 'scene-0' }],
  }
  const parsed = parseShotVideoBatchRequest(body, EPISODE_ID, { confirmation: 'forbidden' })
  assert.equal(parsed.referenceAnalysisJobId, 'vision-analysis-job')
  assert.equal(
    shotVideoBatchRequestFingerprint(parsed),
    'e94039a90150e6181dcd3ee5ca0debca246cd28374180b78cb9739e72a399bfd',
  )
  assert.throws(() => parseShotVideoBatchRequest({
    ...body,
    referenceAnalysisJobId: '',
  }, EPISODE_ID, { confirmation: 'forbidden' }), (error) => (
    error instanceof ShotVideoBatchError && error.code === 'INVALID_VIDEO_BATCH_REQUEST'
  ))
  assert.throws(() => parseShotVideoBatchRequest({
    ...body,
    referenceAnalysis: { selectedReferences: [] },
  }, EPISODE_ID, { confirmation: 'forbidden' }), (error) => (
    error instanceof ShotVideoBatchError && error.code === 'INVALID_VIDEO_BATCH_REQUEST'
  ))

  const withoutJob: ShotVideoBatchRequest = { ...parsed }
  delete withoutJob.referenceAnalysisJobId
  const anotherJob: ShotVideoBatchRequest = {
    ...parsed,
    referenceAnalysisJobId: 'vision-analysis-job-2',
  }
  assert.notEqual(shotVideoBatchRequestFingerprint(parsed), shotVideoBatchRequestFingerprint(withoutJob))
  assert.notEqual(shotVideoBatchRequestFingerprint(parsed), shotVideoBatchRequestFingerprint(anotherJob))

  const verboseBaseline = parseShotVideoBatchRequest({
    ...body,
    promptCompilerVersion: 'seedance-verbose-baseline-v1',
  }, EPISODE_ID, { confirmation: 'forbidden' })
  assert.equal(verboseBaseline.promptCompilerVersion, 'seedance-verbose-baseline-v1')
  assert.notEqual(
    shotVideoBatchRequestFingerprint(verboseBaseline),
    shotVideoBatchRequestFingerprint(parsed),
  )
  assert.throws(() => parseShotVideoBatchRequest({
    ...body,
    promptCompilerVersion: 'unreviewed-compiler',
  }, EPISODE_ID, { confirmation: 'forbidden' }), (error) => (
    error instanceof ShotVideoBatchError && error.code === 'INVALID_VIDEO_BATCH_REQUEST'
  ))

  const perSelection = parseShotVideoBatchRequest({
    projectId: PROJECT_ID,
    resolution: '720p',
    audioPolicy: 'silent',
    generateAudio: false,
    selections: [{
      shotId: 'sh0',
      sceneId: 'scene-0',
      referenceAnalysisJobId: 'vision-analysis-shot-0',
    }],
  }, EPISODE_ID, { confirmation: 'forbidden' })
  assert.equal(perSelection.referenceAnalysisJobId, undefined)
  assert.equal(perSelection.selections[0]?.referenceAnalysisJobId, 'vision-analysis-shot-0')
  assert.notEqual(
    shotVideoBatchRequestFingerprint(perSelection),
    shotVideoBatchRequestFingerprint(withoutJob),
  )

  assert.throws(() => parseShotVideoBatchRequest({
    ...body,
    selections: [{
      shotId: 'sh0',
      sceneId: 'scene-0',
      referenceAnalysisJobId: 'vision-analysis-shot-0',
    }],
  }, EPISODE_ID, { confirmation: 'forbidden' }), (error) => (
    error instanceof ShotVideoBatchError && error.code === 'INVALID_VIDEO_BATCH_REQUEST'
  ))
  for (const manualSelection of [{
    references: [] as const,
  }, {
    characterReferenceSelections: [{ characterId: 'character-0', view: 'front' as const }],
  }]) {
    assert.throws(() => parseShotVideoBatchRequest({
      projectId: PROJECT_ID,
      resolution: '720p',
      audioPolicy: 'silent',
      generateAudio: false,
      selections: [{
        shotId: 'sh0',
        sceneId: 'scene-0',
        referenceAnalysisJobId: 'vision-analysis-shot-0',
        ...manualSelection,
      }],
    }, EPISODE_ID, { confirmation: 'forbidden' }), (error) => (
      error instanceof ShotVideoBatchError && error.code === 'INVALID_VIDEO_BATCH_REQUEST'
    ))
  }
})

test('batch preflight consumes only the persisted vision Job exact references and creates no paid Job', () => {
  const database = fixture()
  try {
    persistAnalysisJob(database)
    const prepared = prepareShotVideoBatch(database, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p',
      promptCompilerVersion: 'seedance-verbose-baseline-v1',
      audioPolicy: 'silent',
      generateAudio: false,
      referenceAnalysisJobId: 'vision-analysis-job',
      selections: [{ shotId: 'sh0', sceneId: 'scene-0' }],
    }, PROVIDER)
    assert.equal(prepared.targets[0]?.referenceDecision.automaticPolicy, 'persisted_vision')
    assert.equal(prepared.targets[0]?.input.publicationMode, 'evaluation_only')
    assert.equal(prepared.targets[0]?.input.spec?.promptCompilerVersion, 'seedance-verbose-baseline-v1')
    assert.equal(prepared.targets[0]?.referenceDecision.visionAnalysisJobId, 'vision-analysis-job')
    assert.equal(prepared.targets[0]?.referenceMode, 'multi-reference')
    assert.deepEqual(prepared.targets[0]?.references.map(({ assetId, role }) => ({ assetId, role })), [{
      assetId: 'storyboard-sh0',
      role: 'reference_image',
    }, {
      assetId: 'asset-token',
      role: 'reference_image',
    }])
    assert.equal(database.listGenerationJobs({ projectId: PROJECT_ID }).length, 1)
    assert.equal(database.listGenerationJobs({ projectId: PROJECT_ID })[0]?.type, SHOT_VIDEO_VISUAL_REFERENCE_JOB_TYPE)
  } finally {
    database.close()
  }
})

test('compact dialogue auditions are signed as evaluation-only while production remains a distinct request', () => {
  const database = fixture()
  try {
    const common: ShotVideoBatchRequest = {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p',
      promptCompilerVersion: 'seedance-compact-v1',
      audioPolicy: 'provider_audio',
      generateAudio: true,
      selections: [{ shotId: 'sh0', sceneId: 'scene-0', references: [] }],
    }
    const production = prepareShotVideoBatch(database, {
      ...common,
      publicationMode: 'replace_current',
    }, PROVIDER)
    const audition = prepareShotVideoBatch(database, {
      ...common,
      publicationMode: 'evaluation_only',
    }, PROVIDER)
    assert.equal(production.publicationMode, 'replace_current')
    assert.equal(production.targets[0]?.input.publicationMode, undefined)
    assert.equal(audition.publicationMode, 'evaluation_only')
    assert.equal(audition.targets[0]?.input.publicationMode, 'evaluation_only')
    assert.notEqual(production.requestFingerprint, audition.requestFingerprint)

    assert.throws(() => parseShotVideoBatchRequest({
      projectId: PROJECT_ID,
      resolution: '720p',
      promptCompilerVersion: 'seedance-verbose-baseline-v1',
      publicationMode: 'replace_current',
      audioPolicy: 'silent',
      generateAudio: false,
      selections: [{ shotId: 'sh0', sceneId: 'scene-0', references: [] }],
    }, EPISODE_ID, { confirmation: 'forbidden' }), (error) => (
      error instanceof ShotVideoBatchError
      && error.code === 'INVALID_VIDEO_BATCH_REQUEST'
    ))
  } finally {
    database.close()
  }
})

test('batch preflight resolves and audits each automatic selection with its own visual-analysis Job', () => {
  const database = fixture()
  try {
    persistAnalysisJob(database, { id: 'vision-analysis-shot-0' })
    persistAnalysisJob(database, { id: 'vision-analysis-shot-1' })
    const request: ShotVideoBatchRequest = {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      resolution: '720p',
      audioPolicy: 'silent',
      generateAudio: false,
      selections: [{
        shotId: 'sh0',
        sceneId: 'scene-0',
        referenceAnalysisJobId: 'vision-analysis-shot-0',
      }, {
        shotId: 'sh1',
        sceneId: 'scene-0',
        referenceAnalysisJobId: 'vision-analysis-shot-1',
      }],
    }
    const prepared = prepareShotVideoBatch(database, request, PROVIDER)

    assert.equal(prepared.targets[0]?.referenceDecision.automaticPolicy, 'persisted_vision')
    assert.equal(prepared.targets[0]?.referenceDecision.visionAnalysisJobId, 'vision-analysis-shot-0')
    assert.equal(
      prepared.targets[0]?.input.referenceDecision?.visionAnalysisJobId,
      'vision-analysis-shot-0',
    )
    assert.equal(prepared.targets[1]?.referenceDecision.automaticPolicy, 'persisted_vision')
    assert.equal(prepared.targets[1]?.referenceDecision.visionAnalysisJobId, 'vision-analysis-shot-1')
    assert.equal(
      prepared.targets[1]?.input.referenceDecision?.visionAnalysisJobId,
      'vision-analysis-shot-1',
    )
    assert.equal(prepared.targets[1]?.referenceMode, 'first-frame')
    assert.equal(prepared.targets[1]?.references[0]?.assetId, 'storyboard-sh1')

    const swappedRequest: ShotVideoBatchRequest = {
      ...request,
      selections: request.selections.map((selection, index) => ({
        ...selection,
        referenceAnalysisJobId: index === 0
          ? 'vision-analysis-shot-1'
          : 'vision-analysis-shot-0',
      })),
    }
    assert.notEqual(
      shotVideoBatchRequestFingerprint(request),
      shotVideoBatchRequestFingerprint(swappedRequest),
    )
    assert.equal(database.listGenerationJobs({ projectId: PROJECT_ID }).length, 2)
  } finally {
    database.close()
  }
})

test('missing, unfinished, and stale analysis never silently fall back to deterministic references', async (context) => {
  const request = (jobId: string): ShotVideoBatchRequest => ({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    resolution: '720p',
    audioPolicy: 'silent',
    generateAudio: false,
    referenceAnalysisJobId: jobId,
    selections: [{ shotId: 'sh0', sceneId: 'scene-0' }],
  })
  await context.test('missing', () => {
    const database = fixture()
    try {
      assert.throws(() => prepareShotVideoBatch(
        database,
        request('missing-analysis'),
        PROVIDER,
      ), (error) => error instanceof ShotVideoBatchError
        && error.code === 'VIDEO_REFERENCE_ANALYSIS_NOT_FOUND')
      assert.equal(database.listGenerationJobs({ projectId: PROJECT_ID }).length, 0)
    } finally {
      database.close()
    }
  })
  await context.test('unfinished', () => {
    const database = fixture()
    try {
      persistAnalysisJob(database, { status: 'running' })
      assert.throws(() => prepareShotVideoBatch(
        database,
        request('vision-analysis-job'),
        PROVIDER,
      ), (error) => error instanceof ShotVideoBatchError
        && error.code === 'VIDEO_REFERENCE_ANALYSIS_NOT_READY')
      assert.equal(database.listGenerationJobs({ projectId: PROJECT_ID }).length, 1)
    } finally {
      database.close()
    }
  })
  await context.test('stale assets', () => {
    const database = fixture()
    try {
      persistAnalysisJob(database)
      database.updateMediaAsset('storyboard-sh0', { version: 2 })
      assert.throws(() => prepareShotVideoBatch(
        database,
        request('vision-analysis-job'),
        PROVIDER,
      ), (error) => error instanceof ShotVideoBatchError
        && error.code === 'VIDEO_REFERENCE_ANALYSIS_STALE')
      assert.equal(database.listGenerationJobs({ projectId: PROJECT_ID }).length, 1)
    } finally {
      database.close()
    }
  })
})
