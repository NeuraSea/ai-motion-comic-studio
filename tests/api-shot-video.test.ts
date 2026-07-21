import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  createShotVideoVisualReferenceAnalysis,
  createShotVideoVisualReferenceAnalysisBatch,
  createShotVideoBatch,
  createShotVideoGenerationJob,
  getShotVideoReferenceRecommendation,
  getShotVideoVisualReferenceAnalysisJob,
  listShotVideoVisualReferenceAnalyses,
  preflightShotVideoBatch,
  resolveShotVideoUnknownSubmission,
} from '../src/lib/api'

const NOW = '2026-07-14T00:00:00.000Z'

function manualReferenceDecision() {
  return {
    version: 1,
    source: 'manual_override',
    storyboardAnchorAssetId: null,
    selectedReferences: [{ assetId: 'asset-reference-1', role: 'first_frame' }],
    recommendation: {
      version: 1,
      policy: 'deterministic-character-view-v1',
      status: 'not_applicable',
      shotId: 'shot:1',
      sceneId: 'scene-1',
      sourceRevisionId: 'story-revision-1',
      confidence: null,
      rationale: '镜头未明确关联当前分集的角色，不自动添加角色参考图。',
      characters: [],
      references: [],
    },
  } as const
}

function manualDurationDecision() {
  return {
    version: 1,
    source: 'manual_override',
    frameRate: 24,
    plannedDurationSeconds: 5,
    speechDurationSeconds: null,
    timelineDurationSeconds: 5,
    providerDurationSeconds: 5,
    speechBindings: [],
    notices: [],
  } as const
}

function completedShotVideoJob(bindingShotId = 'shot:1') {
  return {
    id: 'job-video-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    pipelineRunId: null,
    type: 'shot.video.generate',
    status: 'succeeded',
    progress: 100,
    resourceType: 'provider:video',
    resourceId: 'shot:1',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 2,
    externalTaskId: 'seedance-task-1',
    idempotencyKey: 'shot-video-v1',
    retryOf: null,
    attempt: 1,
    input: {
      prompt: '阿离在断崖回望，镜头缓慢推近。',
      aspectRatio: '16:9',
      resolution: '720p',
      durationSeconds: 5,
      generateAudio: false,
      binding: {
        episodeId: 'episode-1',
        shotId: bindingShotId,
        sceneId: 'scene-1',
        databaseShotId: 'database-shot-1',
        expectedRevisionId: 'story-revision-1',
        expectedPreviousVideoAssetId: null,
      },
    },
    progressDetail: {},
    output: {
      asset: {
        id: 'asset-video-1',
        url: '/api/v1/assets/asset-video-1/content',
        mimeType: 'video/mp4',
        width: 1280,
        height: 720,
        durationSeconds: 5,
      },
      shotId: bindingShotId,
      externalTaskId: 'seedance-task-1',
    },
    error: null,
    cost: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
  }
}

function queuedBatchJob() {
  const job = completedShotVideoJob('shot:1')
  return {
    ...job,
    status: 'queued',
    progress: 0,
    externalTaskId: null,
    idempotencyKey: `svb1_${'b'.repeat(64)}`,
    input: {
      ...job.input,
      references: [{
        assetId: 'asset-reference-1',
        role: 'first_frame',
        version: 1,
        checksum: 'c'.repeat(64),
        sourceRevisionId: 'story-revision-1',
      }],
      referenceDecision: manualReferenceDecision(),
      batch: {
        version: 1,
        requestFingerprint: 'd'.repeat(64),
        selectionIndex: 0,
        selectionCount: 1,
      },
      durationDecision: manualDurationDecision(),
    },
    output: null,
    startedAt: null,
    completedAt: null,
  }
}

function persistedVisionReferenceDecision(
  shotId: string,
  referenceAnalysisJobId: string,
) {
  const storyboardAssetId = `storyboard-${shotId}`
  return {
    version: 1,
    source: 'agentic_auto',
    automaticPolicy: 'persisted_vision',
    visionAnalysisJobId: referenceAnalysisJobId,
    resolution: 'storyboard_anchor',
    storyboardAnchorAssetId: storyboardAssetId,
    selectedReferences: [{ assetId: storyboardAssetId, role: 'first_frame' }],
    recommendation: {
      version: 1,
      policy: 'deterministic-character-view-v1',
      status: 'not_applicable',
      shotId,
      sceneId: 'scene-1',
      sourceRevisionId: 'story-revision-1',
      confidence: null,
      rationale: '当前镜头使用持久化视觉分析确认的分镜首帧。',
      characters: [],
      references: [],
    },
  } as const
}

function automaticReferenceBinding(shotId: string, index: number) {
  return {
    assetId: `storyboard-${shotId}`,
    role: 'first_frame',
    version: 1,
    checksum: (index === 0 ? 'c' : 'd').repeat(64),
    sourceRevisionId: 'story-revision-1',
  } as const
}

function queuedAutomaticBatchJob(
  shotId: string,
  index: number,
  selectionCount: number,
  referenceAnalysisJobId: string,
) {
  const job = queuedBatchJob()
  return {
    ...job,
    id: `job-video-${index + 1}`,
    resourceId: shotId,
    idempotencyKey: `svb1_${String(index + 1).repeat(64)}`,
    input: {
      ...job.input,
      binding: {
        ...job.input.binding,
        shotId,
        databaseShotId: `database-${shotId}`,
      },
      references: [automaticReferenceBinding(shotId, index)],
      referenceDecision: persistedVisionReferenceDecision(shotId, referenceAnalysisJobId),
      batch: {
        version: 1,
        requestFingerprint: 'f'.repeat(64),
        selectionIndex: index,
        selectionCount,
      },
    },
  }
}

function automaticBatchPreflight(referenceAnalysisJobIds: readonly string[]) {
  const shotIds = referenceAnalysisJobIds.map((_, index) => `shot:${index + 1}`)
  return {
    version: 1,
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: 'story-revision-1',
    resolution: '720p',
    publicationMode: 'replace_current',
    audioPolicy: 'silent',
    generateAudio: false,
    provider: {
      providerId: 'seedance-video',
      configRevision: 2,
      model: 'doubao-seedance-2-0-260128',
    },
    billableTaskCount: shotIds.length,
    totalRequestedSeconds: shotIds.length * 5,
    priceEstimate: null,
    priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE',
    targets: shotIds.map((shotId, index) => ({
      shotId,
      sceneId: 'scene-1',
      durationSeconds: 5,
      timelineDurationSeconds: 5,
      durationDecision: manualDurationDecision(),
      referenceMode: 'first-frame',
      references: [automaticReferenceBinding(shotId, index)],
      referenceDecision: persistedVisionReferenceDecision(
        shotId,
        referenceAnalysisJobIds[index]!,
      ),
      promptPreview: `镜头 ${shotId} 使用持久化视觉推荐。`,
      promptCompilerVersion: 'seedance-compact-v1',
      promptCompilerNotices: [],
    })),
    expiresAt: '2100-01-01T00:00:00.000Z',
    confirmationToken: `svpf1_4102444800_${'a'.repeat(64)}`,
  }
}

function completedVisualReferenceAnalysisJob() {
  return {
    id: 'vision-analysis-job-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    pipelineRunId: null,
    type: 'shot.video.reference.analyze',
    status: 'succeeded',
    progress: 100,
    resourceType: null,
    resourceId: 'episode-1',
    providerId: 'codex-tools-text',
    model: 'gpt-5.5',
    providerConfigRevision: 3,
    externalTaskId: null,
    idempotencyKey: 'visual-analysis-key',
    retryOf: null,
    attempt: 1,
    input: {
      version: 1,
      episodeId: 'episode-1',
      expectedStoryRevisionId: 'story-revision-1',
      inputFingerprint: 'a'.repeat(64),
      selectors: [{ shotId: 'shot:1', sceneId: 'scene-1' }],
      candidateCount: 3,
    },
    progressDetail: {},
    output: {
      analysis: {
        version: 'shot-video-vision-agent-v1',
        inputFingerprint: 'a'.repeat(64),
        projectId: 'project-1',
        episodeId: 'episode-1',
        sourceRevisionId: 'story-revision-1',
        plans: [{
          shotId: 'shot:1',
          sceneId: 'scene-1',
          status: 'recommended',
          strategy: 'multi_reference',
          confidence: 0.93,
          rationale: '视觉证据表明角色侧面和当前分镜都需要保留。',
          visualEvidence: ['角色在分镜中以清晰侧面入镜。'],
          selectedReferences: [{
            assetId: 'storyboard-shot-1',
            role: 'reference_image',
            purpose: '当前镜头构图',
          }, {
            assetId: 'character-side',
            role: 'reference_image',
            purpose: '角色侧面一致性',
          }],
          missingCharacterViews: [],
        }],
      },
    },
    error: null,
    cost: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
  }
}

function queuedVisualBatchChild(index: number, count = 2) {
  const base = completedVisualReferenceAnalysisJob()
  const shotId = `shot:${index + 1}`
  const fingerprint = (index === 0 ? 'b' : 'c').repeat(64)
  return {
    ...base,
    id: `vision-analysis-child-${index + 1}`,
    status: 'queued',
    progress: 0,
    idempotencyKey: `visual-child-${index + 1}`,
    input: {
      ...base.input,
      inputFingerprint: fingerprint,
      selectors: [{ shotId, sceneId: 'scene-1' }],
      batch: {
        version: 1,
        batchId: 'visual-batch-1',
        requestFingerprint: 'd'.repeat(64),
        selectionIndex: index,
        selectionCount: count,
      },
    },
    output: null,
    startedAt: null,
    completedAt: null,
  }
}

function currentVisualAuthority(fingerprint: string, usable: boolean) {
  return {
    usable,
    reason: usable ? 'current' : 'job_not_succeeded',
    boundInputFingerprint: fingerprint,
    currentInputFingerprint: fingerprint,
    expectedStoryRevisionId: 'story-revision-1',
    providerId: 'codex-tools-text',
    providerConfigRevision: 3,
  }
}

function manualSlotReferenceDecision() {
  return {
    version: 1,
    source: 'manual_override',
    resolution: 'manual_override',
    storyboardAnchorAssetId: null,
    selectedReferences: [{ assetId: 'asset-side', role: 'reference_image' }],
    manualCharacterSlotPins: [{
      characterId: 'ali',
      characterName: '阿离',
      view: 'side',
      assetId: 'asset-side',
      assetVersion: 2,
      assetChecksum: 'e'.repeat(64),
      assetSourceRevisionId: 'story-revision-1',
      slotVersion: 3,
      slotAuditRevisionId: 'slot-audit-r3',
    }],
    recommendation: {
      version: 1,
      policy: 'deterministic-character-view-v1',
      status: 'manual_required',
      shotId: 'shot:1',
      sceneId: 'scene-1',
      sourceRevisionId: 'story-revision-1',
      confidence: null,
      rationale: '角色视角需人工确认。',
      characters: [{
        characterId: 'ali',
        characterName: '阿离',
        status: 'manual_required',
        view: null,
        confidence: null,
        rationale: '证据不足。',
        assetId: null,
        assetVersion: null,
        assetChecksum: null,
        assetSourceRevisionId: null,
        slotVersion: null,
        slotAuditRevisionId: null,
      }],
      references: [],
    },
  } as const
}

function queuedManualSlotBatchJob() {
  const job = queuedBatchJob()
  return {
    ...job,
    input: {
      ...job.input,
      references: [{
        assetId: 'asset-side',
        role: 'reference_image',
        version: 2,
        checksum: 'e'.repeat(64),
        sourceRevisionId: 'story-revision-1',
      }],
      referenceDecision: manualSlotReferenceDecision(),
    },
  }
}

function manuallyResolvedShotVideoJob() {
  const base = completedShotVideoJob('shot:1')
  const resolution = {
    version: 1 as const,
    auditRevisionId: 'audit-resolution-1',
    jobId: base.id,
    projectId: base.projectId,
    episodeId: base.episodeId,
    shotId: 'shot:1',
    expectedSourceRevisionId: 'story-revision-1',
    resolution: 'confirmed-not-created' as const,
    confirmedProviderConsoleChecked: true as const,
    note: '已核对历史 Provider 控制台，确认没有对应任务。',
    resolvedAt: NOW,
    provider: {
      id: base.providerId,
      configRevision: base.providerConfigRevision,
      model: base.model,
      baseUrl: 'https://ai.example.test',
    },
  }
  return {
    ...base,
    status: 'failed',
    progress: 0,
    externalTaskId: null,
    output: null,
    error: {
      code: 'PROVIDER_SUBMISSION_CONFIRMED_NOT_CREATED',
      message: '已人工确认未创建，可重新预检。',
      retryable: false,
      category: 'manual_resolution',
      auditRevisionId: resolution.auditRevisionId,
      originalError: {
        code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
        message: '提交结果未知',
        retryable: false,
      },
    },
    unknownSubmissionResolution: resolution,
  }
}

test('shot video client sends the exact route body and Idempotency-Key, then validates the typed result', async () => {
  const originalFetch = globalThis.fetch
  let captured: { url: string; init: RequestInit } | undefined
  globalThis.fetch = (async (input, init = {}) => {
    captured = { url: String(input), init }
    return new Response(JSON.stringify({ job: completedShotVideoJob() }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const job = await createShotVideoGenerationJob('shot:1', {
      projectId: 'project-1',
      episodeId: 'episode-1',
      sceneId: 'scene-1',
      providerId: 'seedance-video',
      resolution: '720p',
      durationSeconds: 5,
    }, 'shot-video-v1')

    assert.equal(job.type, 'shot.video.generate')
    assert.equal(job.output?.asset.mimeType, 'video/mp4')
    assert.equal(job.output?.shotId, 'shot:1')
    assert.equal(captured?.url, '/api/v1/shots/shot%3A1/video-generations')
    assert.equal(captured?.init.method, 'POST')
    const headers = new Headers(captured?.init.headers)
    assert.equal(headers.get('Content-Type'), 'application/json')
    assert.equal(headers.get('Idempotency-Key'), 'shot-video-v1')
    assert.equal(headers.get('If-Match'), null)
    assert.deepEqual(JSON.parse(String(captured?.init.body)), {
      projectId: 'project-1',
      episodeId: 'episode-1',
      sceneId: 'scene-1',
      providerId: 'seedance-video',
      resolution: '720p',
      durationSeconds: 5,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shot video client preserves an actionable provider-not-configured API error', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: {
      code: 'PROVIDER_NOT_CONFIGURED',
      message: '请先在 Provider 设置中填写 Seedance 2.0 API Key，并启用视频 Provider',
    },
  }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch

  try {
    await assert.rejects(
      createShotVideoGenerationJob('shot:1', {
        projectId: 'project-1',
        episodeId: 'episode-1',
      }, 'shot-video-v1'),
      (error: unknown) => error instanceof ApiError
        && error.status === 409
        && error.code === 'PROVIDER_NOT_CONFIGURED'
        && /Seedance 2\.0 API Key/.test(error.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shot video client rejects a valid-looking job bound to a different public shot', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    job: completedShotVideoJob('other-shot'),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch

  try {
    await assert.rejects(
      createShotVideoGenerationJob('shot:1', {
        projectId: 'project-1',
        episodeId: 'episode-1',
        sceneId: 'scene-1',
        resolution: '720p',
        durationSeconds: 5,
      }, 'shot-video-v1'),
      (error: unknown) => error instanceof ApiError
        && error.code === 'INVALID_RESPONSE'
        && /绑定不一致/.test(error.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shot video client accepts exact Seedance dialogue lines on an evaluation candidate', async () => {
  const originalFetch = globalThis.fetch
  const candidate = completedShotVideoJob()
  candidate.input.generateAudio = true
  Object.assign(candidate.input, {
    publicationMode: 'evaluation_only',
    spec: {
      version: 1,
      promptCompilerVersion: 'seedance-compact-v1',
      subjectNames: ['阿离'],
      scene: '黄昏断崖',
      action: '阿离回头望向镜头。',
      shotSize: '中景',
      cameraMovement: '缓慢推近',
      audioPolicy: 'provider_audio',
      audioLines: [{ kind: 'dialogue', speaker: '阿离', text: '不可能……十年了。' }],
      durationSeconds: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      sourceRevisionId: 'story-revision-1',
      references: [],
    },
  })
  globalThis.fetch = (async () => new Response(JSON.stringify({ job: candidate }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
  try {
    const job = await createShotVideoGenerationJob('shot:1', {
      projectId: 'project-1',
      episodeId: 'episode-1',
      sceneId: 'scene-1',
      resolution: '720p',
      durationSeconds: 5,
      audioPolicy: 'provider_audio',
    }, 'shot-video-v1')
    assert.deepEqual(job.input.spec?.audioLines, [{
      kind: 'dialogue',
      speaker: '阿离',
      text: '不可能……十年了。',
    }])
    assert.equal(job.input.publicationMode, 'evaluation_only')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('visual reference analysis is an explicit free durable Job and is read through a strict parser', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (request, init = {}) => {
    calls.push({ url: String(request), init })
    return new Response(JSON.stringify({ job: completedVisualReferenceAnalysisJob() }), {
      status: calls.length === 1 ? 202 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const input = {
    projectId: 'project-1',
    textProviderId: 'codex-tools-text',
    selections: [{ shotId: 'shot:1', sceneId: 'scene-1' }],
  }
  try {
    const created = await createShotVideoVisualReferenceAnalysis(
      'episode-1',
      input,
      'visual-analysis-key',
    )
    const read = await getShotVideoVisualReferenceAnalysisJob(created.id)
    assert.equal(created.output?.analysis.plans[0]?.confidence, 0.93)
    assert.equal(read.output?.analysis.plans[0]?.selectedReferences[1]?.purpose, '角色侧面一致性')
    assert.equal(calls[0]?.url, '/api/v1/episodes/episode-1/video-reference-analyses')
    assert.equal(calls[0]?.init.method, 'POST')
    assert.equal(new Headers(calls[0]?.init.headers).get('Idempotency-Key'), 'visual-analysis-key')
    assert.equal(new Headers(calls[0]?.init.headers).get('x-manju-aigc-confirmation'), null)
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), input)
    assert.equal(String(calls[0]?.init.body).includes('confirmationToken'), false)
    assert.equal(calls[1]?.url, '/api/v1/jobs/vision-analysis-job-1')
    assert.equal(calls[1]?.init.method, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('visual reference analysis client rejects a succeeded Job with a mismatched revision binding', async () => {
  const originalFetch = globalThis.fetch
  const invalid = completedVisualReferenceAnalysisJob()
  invalid.output.analysis.sourceRevisionId = 'other-revision'
  globalThis.fetch = (async () => new Response(JSON.stringify({ job: invalid }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
  try {
    await assert.rejects(
      getShotVideoVisualReferenceAnalysisJob(invalid.id),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('single-shot visual analysis rejects a durable Job scoped to another shot', async () => {
  const originalFetch = globalThis.fetch
  const invalid = completedVisualReferenceAnalysisJob()
  invalid.input.selectors = [{ shotId: 'shot:other', sceneId: 'scene-1' }]
  invalid.output.analysis.plans[0]!.shotId = 'shot:other'
  globalThis.fetch = (async () => new Response(JSON.stringify({ job: invalid }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
  try {
    await assert.rejects(
      createShotVideoVisualReferenceAnalysis('episode-1', {
        projectId: 'project-1',
        textProviderId: 'codex-tools-text',
        selections: [{ shotId: 'shot:1', sceneId: 'scene-1' }],
      }, 'visual-analysis-other-shot'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('visual batch admission returns one independently bound durable child per shot', async () => {
  const originalFetch = globalThis.fetch
  const jobs = [queuedVisualBatchChild(0), queuedVisualBatchChild(1)]
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (request, init = {}) => {
    calls.push({ url: String(request), init })
    return new Response(JSON.stringify({
      batch: {
        version: 1,
        id: 'visual-batch-1',
        projectId: 'project-1',
        episodeId: 'episode-1',
        sourceRevisionId: 'story-revision-1',
        providerId: 'codex-tools-text',
        providerConfigRevision: 3,
        model: 'gpt-5.5',
        requestFingerprint: 'd'.repeat(64),
        status: 'queued',
        progress: 0,
        counts: { total: 2, queued: 2, running: 0, succeeded: 0, failed: 0 },
        selections: jobs.map((job, index) => ({
          selectionIndex: index,
          shotId: `shot:${index + 1}`,
          sceneId: 'scene-1',
          jobId: job.id,
          status: job.status,
          progress: job.progress,
          authority: currentVisualAuthority(job.input.inputFingerprint, false),
        })),
        createdAt: NOW,
        updatedAt: NOW,
      },
      jobs,
    }), { status: 202, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const input = {
    projectId: 'project-1',
    textProviderId: 'codex-tools-text',
    selections: [
      { shotId: 'shot:1', sceneId: 'scene-1' },
      { shotId: 'shot:2', sceneId: 'scene-1' },
    ],
  }
  try {
    const admitted = await createShotVideoVisualReferenceAnalysisBatch(
      'episode-1',
      input,
      'visual-batch-root',
    )
    assert.deepEqual(
      admitted.jobs.map((job) => job.input.selectors[0]?.shotId),
      ['shot:1', 'shot:2'],
    )
    assert.equal(new Set(admitted.jobs.map((job) => job.id)).size, 2)
    assert.equal(new Headers(calls[0]?.init.headers).get('Idempotency-Key'), 'visual-batch-root')
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), input)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('visual analysis hydration is read-only and preserves server authority evidence', async () => {
  const originalFetch = globalThis.fetch
  const job = completedVisualReferenceAnalysisJob()
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  globalThis.fetch = (async (request, init = {}) => {
    requestUrl = String(request)
    requestInit = init
    return new Response(JSON.stringify({
      analyses: [{
        shotId: 'shot:1',
        sceneId: 'scene-1',
        job,
        authority: currentVisualAuthority(job.input.inputFingerprint, true),
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const bindings = await listShotVideoVisualReferenceAnalyses('episode-1', {
      projectId: 'project-1',
      sourceRevisionId: 'story-revision-1',
      textProviderId: 'codex-tools-text',
    })
    assert.equal(bindings[0]?.job.id, job.id)
    assert.equal(bindings[0]?.authority.usable, true)
    assert.equal(requestInit?.method, undefined)
    assert.match(requestUrl, /^\/api\/v1\/episodes\/episode-1\/video-reference-analyses\?/)
    assert.match(requestUrl, /sourceRevisionId=story-revision-1/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Seedance batch client performs non-billable preflight then validates durable children', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (request, init = {}) => {
    calls.push({ url: String(request), init })
    if (String(request).endsWith('/preflight')) {
      return new Response(JSON.stringify({
        preflight: {
          version: 1,
          projectId: 'project-1',
          episodeId: 'episode-1',
          sourceRevisionId: 'story-revision-1',
          resolution: '720p',
          publicationMode: 'replace_current',
          audioPolicy: 'silent',
          generateAudio: false,
          provider: {
            providerId: 'seedance-video',
            configRevision: 2,
            model: 'doubao-seedance-2-0-260128',
          },
          billableTaskCount: 1,
          totalRequestedSeconds: 5,
          priceEstimate: null,
          priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE',
          targets: [{
            shotId: 'shot:1',
            sceneId: 'scene-1',
            durationSeconds: 5,
            timelineDurationSeconds: 5,
            durationDecision: manualDurationDecision(),
            referenceMode: 'first-frame',
            references: [{
              assetId: 'asset-reference-1',
              role: 'first_frame',
              version: 1,
              checksum: 'c'.repeat(64),
              sourceRevisionId: 'story-revision-1',
            }],
            referenceDecision: manualReferenceDecision(),
            promptPreview: '镜头：阿离在断崖回望。\n声音：静音，不生成环境音、背景音乐、旁白或对白。',
            promptCompilerVersion: 'seedance-compact-v1',
            promptCompilerNotices: [],
          }],
          expiresAt: '2100-01-01T00:00:00.000Z',
          confirmationToken: `svpf1_4102444800_${'a'.repeat(64)}`,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ jobs: [queuedBatchJob()] }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const input = {
    projectId: 'project-1',
    providerId: 'seedance-video',
    resolution: '720p' as const,
    selections: [{
      shotId: 'shot:1',
      sceneId: 'scene-1',
      durationSeconds: 5,
      references: [{ assetId: 'asset-reference-1', role: 'first_frame' as const }],
    }],
  }
  try {
    const preflight = await preflightShotVideoBatch('episode-1', input, 'root-batch-key')
    const jobs = await createShotVideoBatch('episode-1', {
      ...input,
      confirmationToken: preflight.confirmationToken,
    }, 'root-batch-key')
    assert.equal(jobs[0].input.batch?.selectionIndex, 0)
    assert.equal(calls[0].url, '/api/v1/episodes/episode-1/video-generations/preflight')
    assert.equal(new Headers(calls[0].init.headers).get('Idempotency-Key'), 'root-batch-key')
    assert.equal(calls[1].url, '/api/v1/episodes/episode-1/video-generations')
    assert.equal(new Headers(calls[1].init.headers).get('Idempotency-Key'), 'root-batch-key')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('batch client validates distinct visual-analysis Job identity for every automatic selection', async () => {
  const originalFetch = globalThis.fetch
  const referenceAnalysisJobIds = ['vision-analysis-shot-1', 'vision-analysis-shot-2'] as const
  const calls: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = (async (request, init = {}) => {
    calls.push({
      url: String(request),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    if (String(request).endsWith('/preflight')) {
      return new Response(JSON.stringify({
        preflight: automaticBatchPreflight(referenceAnalysisJobIds),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      jobs: referenceAnalysisJobIds.map((jobId, index) => queuedAutomaticBatchJob(
        `shot:${index + 1}`,
        index,
        referenceAnalysisJobIds.length,
        jobId,
      )),
    }), { status: 202, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const input = {
    projectId: 'project-1',
    providerId: 'seedance-video',
    resolution: '720p' as const,
    selections: referenceAnalysisJobIds.map((referenceAnalysisJobId, index) => ({
      shotId: `shot:${index + 1}`,
      sceneId: 'scene-1',
      durationSeconds: 5,
      referenceAnalysisJobId,
    })),
  }
  try {
    const preflight = await preflightShotVideoBatch('episode-1', input, 'per-shot-analysis-root')
    const jobs = await createShotVideoBatch('episode-1', {
      ...input,
      confirmationToken: preflight.confirmationToken,
    }, 'per-shot-analysis-root')

    assert.deepEqual(
      preflight.targets.map((target) => target.referenceDecision.visionAnalysisJobId),
      referenceAnalysisJobIds,
    )
    assert.deepEqual(
      jobs.map((job) => job.input.referenceDecision?.visionAnalysisJobId),
      referenceAnalysisJobIds,
    )
    assert.deepEqual(
      (calls[0]?.body as typeof input).selections.map((selection) => selection.referenceAnalysisJobId),
      referenceAnalysisJobIds,
    )
    assert.deepEqual(
      (calls[1]?.body as typeof input).selections.map((selection) => selection.referenceAnalysisJobId),
      referenceAnalysisJobIds,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('batch client rejects swapped per-selection visual-analysis Job identities in server responses', async (context) => {
  const originalFetch = globalThis.fetch
  const expectedJobIds = ['vision-analysis-shot-1', 'vision-analysis-shot-2'] as const
  const swappedJobIds = [...expectedJobIds].reverse()
  const input = {
    projectId: 'project-1',
    providerId: 'seedance-video',
    resolution: '720p' as const,
    selections: expectedJobIds.map((referenceAnalysisJobId, index) => ({
      shotId: `shot:${index + 1}`,
      sceneId: 'scene-1',
      durationSeconds: 5,
      referenceAnalysisJobId,
    })),
  }
  try {
    await context.test('preflight response', async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        preflight: automaticBatchPreflight(swappedJobIds),
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
      await assert.rejects(
        preflightShotVideoBatch('episode-1', input, 'swapped-preflight-root'),
        (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
      )
    })
    await context.test('created Job response', async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        jobs: swappedJobIds.map((jobId, index) => queuedAutomaticBatchJob(
          `shot:${index + 1}`,
          index,
          swappedJobIds.length,
          jobId,
        )),
      }), { status: 202, headers: { 'content-type': 'application/json' } })) as typeof fetch
      await assert.rejects(
        createShotVideoBatch('episode-1', {
          ...input,
          confirmationToken: `svpf1_4102444800_${'a'.repeat(64)}`,
        }, 'swapped-created-root'),
        (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
      )
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('batch client rejects ambiguous or manual per-selection visual-analysis Job input before fetch', async () => {
  const originalFetch = globalThis.fetch
  let fetchCount = 0
  globalThis.fetch = (async () => {
    fetchCount += 1
    throw new Error('fetch must not be called')
  }) as typeof fetch
  try {
    await assert.rejects(preflightShotVideoBatch('episode-1', {
      projectId: 'project-1',
      referenceAnalysisJobId: 'legacy-batch-analysis',
      selections: [{
        shotId: 'shot:1',
        referenceAnalysisJobId: 'per-shot-analysis',
      }],
    }, 'ambiguous-analysis-root'), (error: unknown) => (
      error instanceof ApiError && error.code === 'INVALID_VIDEO_BATCH_REQUEST'
    ))
    await assert.rejects(preflightShotVideoBatch('episode-1', {
      projectId: 'project-1',
      selections: [{
        shotId: 'shot:1',
        referenceAnalysisJobId: 'per-shot-analysis',
        references: [],
      }],
    }, 'manual-analysis-root'), (error: unknown) => (
      error instanceof ApiError && error.code === 'INVALID_VIDEO_BATCH_REQUEST'
    ))
    assert.equal(fetchCount, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('paid batch response accepts the exact manual character slot pin without exposing an Asset selector', async () => {
  const originalFetch = globalThis.fetch
  let body: unknown
  globalThis.fetch = (async (_request, init = {}) => {
    body = JSON.parse(String(init.body))
    return new Response(JSON.stringify({ jobs: [queuedManualSlotBatchJob()] }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const input = {
    projectId: 'project-1',
    providerId: 'seedance-video',
    resolution: '720p' as const,
    selections: [{
      shotId: 'shot:1',
      sceneId: 'scene-1',
      durationSeconds: 5,
      characterReferenceSelections: [{ characterId: 'ali', view: 'side' as const }],
    }],
    confirmationToken: `svpf1_4102444800_${'a'.repeat(64)}`,
  }
  try {
    const jobs = await createShotVideoBatch('episode-1', input, 'manual-slot-root')
    assert.equal(jobs[0].input.referenceDecision?.manualCharacterSlotPins?.[0]?.assetId, 'asset-side')
    assert.deepEqual((body as typeof input).selections[0].characterReferenceSelections, [{
      characterId: 'ali',
      view: 'side',
    }])
    assert.equal(JSON.stringify(body).includes('asset-side'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shot reference recommendation client validates server-authored view and immutable slot provenance', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  globalThis.fetch = (async (request) => {
    capturedUrl = String(request)
    return new Response(JSON.stringify({
      recommendation: {
        version: 1,
        policy: 'deterministic-character-view-v1',
        status: 'recommended',
        shotId: 'shot:1',
        sceneId: 'scene-1',
        sourceRevisionId: 'story-revision-1',
        confidence: 0.96,
        rationale: '已按镜头视角选择真实三视图槽位。',
        characters: [{
          characterId: 'ali',
          characterName: '阿离',
          status: 'recommended',
          view: 'side',
          confidence: 0.96,
          rationale: '镜头明确指定侧面。',
          assetId: 'asset-side',
          assetVersion: 3,
          assetChecksum: 'e'.repeat(64),
          assetSourceRevisionId: 'story-revision-1',
          slotVersion: 2,
          slotAuditRevisionId: 'view-audit-r2',
        }],
        references: [{ assetId: 'asset-side', role: 'reference_image' }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const result = await getShotVideoReferenceRecommendation('shot:1', {
      projectId: 'project-1',
      episodeId: 'episode-1',
      sceneId: 'scene-1',
    })
    assert.equal(result.characters[0].view, 'side')
    assert.equal(result.characters[0].assetVersion, 3)
    assert.equal(capturedUrl, '/api/v1/shots/shot%3A1/video-reference-recommendation?projectId=project-1&episodeId=episode-1&sceneId=scene-1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('manual unknown-submission resolution sends an exact non-billable audit request', async () => {
  const originalFetch = globalThis.fetch
  const job = manuallyResolvedShotVideoJob()
  const resolution = job.unknownSubmissionResolution
  let captured: { url: string; init: RequestInit } | undefined
  globalThis.fetch = (async (request, init = {}) => {
    captured = { url: String(request), init }
    return new Response(JSON.stringify({ resolution, idempotent: false, job }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const input = {
    projectId: 'project-1',
    resolution: 'confirmed-not-created' as const,
    confirmedProviderConsoleChecked: true as const,
    note: resolution.note,
  }
  try {
    const result = await resolveShotVideoUnknownSubmission(job.id, input)
    assert.equal(result.idempotent, false)
    assert.equal(result.resolution.auditRevisionId, 'audit-resolution-1')
    assert.equal(result.job.unknownSubmissionResolution?.jobId, job.id)
    assert.equal(captured?.url, '/api/v1/jobs/job-video-1/shot-video-unknown-submission-resolution')
    assert.equal(captured?.init.method, 'POST')
    assert.equal(new Headers(captured?.init.headers).get('Idempotency-Key'), null)
    assert.deepEqual(JSON.parse(String(captured?.init.body)), input)
  } finally {
    globalThis.fetch = originalFetch
  }
})
