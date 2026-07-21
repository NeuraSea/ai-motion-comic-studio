import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  createEpisode,
  createDialogueSpeechGenerationJob,
  createStoryShot,
  deleteStoryShot,
  getEpisode,
  getStory,
  lockAsset,
  materializeTimelineDocument,
  parsePublicPaidAigcConfirmation,
  preflightDialogueSpeechGenerationJob,
  reconcileTimelineDocument,
  reorderStoryShots,
  restoreStoryRevision,
  updateEpisode,
  updateStoryScene,
  updateStoryShot,
  generateStory,
} from '../src/lib/api'
import type {
  StoryDocument,
  StoryScene,
  StoryShot,
} from '../src/lib/api-types'

const NOW = '2026-07-14T00:00:00.000Z'
const PAID_CONFIRMATION_EXPIRY = 4_102_444_800
const PAID_CONFIRMATION_TOKEN = `aigcpf1_${PAID_CONFIRMATION_EXPIRY}_${'a'.repeat(64)}`

function speechGenerationConfirmation() {
  return {
    version: 1 as const,
    action: 'dialogue.speech.generate' as const,
    label: '生成当前台词语音',
    billableTaskCount: 1 as const,
    provider: {
      providerId: 'minimax-speech',
      model: 'speech-2.8-hd',
      configRevision: 2,
    },
    intentFingerprint: 'c'.repeat(64),
    expiresAt: '2100-01-01T00:00:00.000Z',
    confirmationToken: PAID_CONFIRMATION_TOKEN,
    priceEstimate: null,
    priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE' as const,
  }
}

function storyShot(id: string, sequence = 0): StoryShot {
  return {
    id,
    sequence,
    code: `S-${sequence + 1}`,
    title: `镜头 ${sequence + 1}`,
    description: '人物走入画面',
    framing: '中景',
    movement: '固定',
    transition: '硬切',
    durationSeconds: 5,
    visualPrompt: '古风街道',
    dialogueLines: [],
  }
}

function storyScene(shots: StoryShot[] = [storyShot('shot-1')]): StoryScene {
  return {
    id: 'scene-1',
    sequence: 0,
    title: '开场',
    locationId: 'location-1',
    timeOfDay: '日',
    description: '一条街道',
    shots,
  }
}

function storyDocument(scene = storyScene()): StoryDocument {
  return {
    version: 1,
    title: '第一集',
    targetDurationSeconds: 45,
    bible: {
      logline: '一句话故事',
      theme: '选择',
      tone: '克制',
      visualStyle: '国风',
    },
    characters: [],
    locations: [],
    props: [],
    scenes: [scene],
  }
}

function mutationBody(
  revisionId: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    episode: {
      id: 'episode-1',
      projectId: 'project-1',
      title: '第一集',
      sourceText: '原文',
      targetDurationSeconds: 45,
      aspectRatio: '9:16',
      stylePreset: '国风',
      status: 'draft',
      sortOrder: 0,
      sourceRevisionId: revisionId,
      createdAt: NOW,
      updatedAt: NOW,
    },
    story: storyDocument(),
    revisionId,
    stale: {
      assets: 1,
      jobs: 2,
      exports: 3,
      qualityReports: 4,
      pipelineRuns: 5,
    },
    ...extra,
  }
}

function jsonResponse(
  body: unknown,
  revisionId: string,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ETag: `W/"${revisionId}"`,
    },
  })
}

test('story generation directly creates a durable idempotent job without a paid header', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ job: { id: 'story-job-1' } }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  const episodeId = 'episode/story 1'
  const input = { projectId: 'project-1', providerId: 'custom-text' }
  const etag = 'W/"episode-version-1"'
  const idempotencyKey = 'story-generation-attempt-1'
  try {
    const job = await generateStory(
      episodeId,
      input,
      etag,
      idempotencyKey,
    )

    assert.equal(job.id, 'story-job-1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, '/api/v1/episodes/episode%2Fstory%201/story-generations')
    assert.equal(String(calls[0]?.init.body), JSON.stringify(input))
    assert.equal(new Headers(calls[0]?.init.headers).get('If-Match'), etag)
    assert.equal(new Headers(calls[0]?.init.headers).get('Idempotency-Key'), idempotencyKey)
    assert.equal(new Headers(calls[0]?.init.headers).get('x-manju-aigc-confirmation'), null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('paid AIGC confirmation parser rejects schema, action, and expiry/token drift', () => {
  const confirmation = speechGenerationConfirmation()
  assert.deepEqual(
    parsePublicPaidAigcConfirmation(confirmation, 'dialogue.speech.generate'),
    confirmation,
  )

  const invalid: unknown[] = [
    { ...confirmation, extra: true },
    { ...confirmation, action: 'character.voice.preview' },
    { ...confirmation, billableTaskCount: 2 },
    { ...confirmation, label: ' 生成结构剧本' },
    { ...confirmation, provider: { ...confirmation.provider, configRevision: 0 } },
    { ...confirmation, intentFingerprint: 'B'.repeat(64) },
    { ...confirmation, expiresAt: '2100-01-01T00:00:01.000Z' },
    { ...confirmation, confirmationToken: `aigcpf1_${PAID_CONFIRMATION_EXPIRY}_${'A'.repeat(64)}` },
  ]
  for (const value of invalid) {
    assert.throws(
      () => parsePublicPaidAigcConfirmation(value, 'dialogue.speech.generate'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  }
})

test('story mutation clients send If-Match and preserve the authoritative response ETag', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const addedShot = storyShot('shot-new', 1)
  const scene = storyScene([storyShot('shot-1'), addedShot])
  const responses = [
    jsonResponse(mutationBody('revision-scene', { scene }), 'revision-scene'),
    jsonResponse(mutationBody('revision-create', { scene, shot: addedShot }), 'revision-create', 201),
    jsonResponse(mutationBody('revision-order', { scene }), 'revision-order'),
    jsonResponse(mutationBody('revision-shot', { shot: addedShot }), 'revision-shot'),
    jsonResponse(
      mutationBody('revision-delete', { scene: storyScene(), deletedShotId: 'shot-new' }),
      'revision-delete',
    ),
  ]
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    const response = responses.shift()
    assert.ok(response, 'unexpected fetch call')
    return response
  }) as typeof fetch

  try {
    const sceneResult = await updateStoryScene('scene-1', {
      episodeId: 'episode-1',
      patch: { description: '新的场景描述' },
    }, 'W/"revision-original"')
    assert.equal(sceneResult.etag, 'W/"revision-scene"')
    assert.equal(sceneResult.stale.jobs, 2)

    const { sequence: _sequence, ...newShot } = addedShot
    const createResult = await createStoryShot({
      projectId: 'project-1',
      episodeId: 'episode-1',
      sceneId: 'scene-1',
      index: 1,
      shot: newShot,
    }, sceneResult.etag)
    assert.equal(createResult.shot.id, 'shot-new')
    assert.equal(createResult.etag, 'W/"revision-create"')

    const reorderResult = await reorderStoryShots({
      episodeId: 'episode-1',
      sceneId: 'scene-1',
      shotIds: ['shot-new', 'shot-1'],
    }, createResult.etag)
    assert.equal(reorderResult.revisionId, 'revision-order')

    const shotResult = await updateStoryShot('shot-new', {
      episodeId: 'episode-1',
      sceneId: 'scene-1',
      patch: { durationSeconds: 6 },
    }, reorderResult.etag)
    assert.equal(shotResult.shot.id, 'shot-new')

    const deleteResult = await deleteStoryShot('shot-new', {
      episodeId: 'episode-1',
      sceneId: 'scene-1',
      summary: '删除多余镜头',
    }, shotResult.etag)
    assert.equal(deleteResult.deletedShotId, 'shot-new')
    assert.equal(deleteResult.scene?.id, 'scene-1')
    assert.equal(deleteResult.etag, 'W/"revision-delete"')

    assert.deepEqual(calls.map((call) => [call.init.method, call.url]), [
      ['PATCH', '/api/v1/scenes/scene-1'],
      ['POST', '/api/v1/shots'],
      ['POST', '/api/v1/shots/reorder'],
      ['PATCH', '/api/v1/shots/shot-new'],
      ['DELETE', '/api/v1/shots/shot-new'],
    ])
    assert.deepEqual(calls.map((call) => new Headers(call.init.headers).get('If-Match')), [
      'W/"revision-original"',
      'W/"revision-scene"',
      'W/"revision-create"',
      'W/"revision-order"',
      'W/"revision-shot"',
    ])
    assert.deepEqual(JSON.parse(calls[0].init.body as string), {
      episodeId: 'episode-1',
      patch: { description: '新的场景描述' },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('story mutation clients preserve an opaque Episode ETag distinct from the Story revision', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => jsonResponse(
    mutationBody('revision-body', { scene: storyScene() }),
    'episode.full-version-header',
  )) as typeof fetch

  try {
    const result = await reorderStoryShots({
      episodeId: 'episode-1',
      sceneId: 'scene-1',
      shotIds: ['shot-1'],
    }, 'W/"episode.previous-version"')
    assert.equal(result.revisionId, 'revision-body')
    assert.equal(result.etag, 'W/"episode.full-version-header"')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('episode clients read the authoritative ETag header instead of synthesizing it', async () => {
  const originalFetch = globalThis.fetch
  const episode = mutationBody('story-revision-1', {}).episode
  const responses = [
    jsonResponse({ episode, revisionId: 'story-revision-1' }, 'episode.version-1', 201),
    jsonResponse({ episode, revisionId: 'story-revision-1' }, 'episode.version-1'),
    jsonResponse({ episode, revisionId: 'story-revision-1' }, 'episode.version-2'),
    jsonResponse({
      episodeId: 'episode-1',
      revisionId: 'story-revision-1',
      story: storyDocument(),
    }, 'episode.version-2'),
  ]
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    const response = responses.shift()
    assert.ok(response)
    return response
  }) as typeof fetch

  try {
    const created = await createEpisode('project-1', {
      id: 'episode-1',
      title: '第一集',
      sourceText: '原文',
      targetDurationSeconds: 45,
      aspectRatio: '9:16',
      stylePreset: '国风',
    })
    const loaded = await getEpisode('episode-1', { projectId: 'project-1' })
    const updated = await updateEpisode(
      'episode-1',
      { stylePreset: '赛博国风' },
      loaded.etag,
    )
    const story = await getStory('episode-1', { projectId: 'project-1' })

    assert.equal(created.etag, 'W/"episode.version-1"')
    assert.equal(loaded.etag, 'W/"episode.version-1"')
    assert.equal(updated.etag, 'W/"episode.version-2"')
    assert.equal(story.etag, 'W/"episode.version-2"')
    assert.equal(
      new Headers(calls[2].init.headers).get('If-Match'),
      'W/"episode.version-1"',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('story revision restore sends the selected revision and preserves the new audit-head ETag', async () => {
  const originalFetch = globalThis.fetch
  let captured: { url: string; init: RequestInit } | undefined
  globalThis.fetch = (async (input, init = {}) => {
    captured = { url: String(input), init }
    return jsonResponse(
      mutationBody('revision-restored', { restoredFromRevisionId: 'revision-old' }),
      'revision-restored',
    )
  }) as typeof fetch

  try {
    const result = await restoreStoryRevision(
      'episode-1',
      'revision-old',
      {
        projectId: 'project-1',
        summary: '恢复已审核版本',
      },
      'W/"revision-current"',
    )

    assert.equal(captured?.url, '/api/v1/episodes/episode-1/story/revisions/revision-old/restore')
    assert.equal(captured?.init.method, 'POST')
    assert.equal(new Headers(captured?.init.headers).get('If-Match'), 'W/"revision-current"')
    assert.deepEqual(JSON.parse(captured?.init.body as string), {
      projectId: 'project-1',
      summary: '恢复已审核版本',
    })
    assert.equal(result.revisionId, 'revision-restored')
    assert.equal(result.etag, 'W/"revision-restored"')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('speech preflight and confirmation freeze the exact body/key and validate the typed asset output', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const speechJob = {
    id: 'job-speech-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'dialogue.speech.generate',
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    input: {
      episodeId: 'episode-1',
      lineId: 'line:1',
      databaseLineId: 'story-dialogue-database-id',
      expectedRevisionId: 'story-revision-1',
      voiceId: 'female-shaonv',
      speed: 1,
      volume: 1,
      pitch: 0,
      emotion: 'calm',
      format: 'mp3',
      sampleRate: 32_000,
      bitrate: 128_000,
      channels: 1,
    },
    output: {
      dialogueLineId: 'line:1',
      asset: {
        id: 'asset-speech-1',
        projectId: 'project-1',
        episodeId: 'episode-1',
        kind: 'speech',
        version: 1,
        status: 'ready',
        mimeType: 'audio/mpeg',
        width: null,
        height: null,
        durationSeconds: 1.25,
        checksum: 'sha256-value',
        source: 'provider',
        providerId: 'minimax-speech',
        generationJobId: 'job-speech-1',
        sourceRevisionId: 'story-revision-1',
        parentAssetId: null,
        url: '/api/v1/assets/asset-speech-1/content',
        createdAt: NOW,
        updatedAt: NOW,
      },
      provider: {
        id: 'minimax-speech',
        model: 'speech-2.8-hd',
        configRevision: 2,
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
  }
  const responses = [
    new Response(JSON.stringify({
      error: {
        code: 'PAID_CONFIRMATION_REQUIRED',
        message: '需要确认',
        details: { confirmation: speechGenerationConfirmation() },
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ job: speechJob }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ]
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    const response = responses.shift()
    assert.ok(response)
    return response
  }) as typeof fetch

  try {
    const input = {
      projectId: 'project-1',
      episodeId: 'episode-1',
      providerId: 'minimax-speech',
      voiceId: 'female-shaonv',
      emotion: 'calm',
      sampleRate: 32_000,
      bitrate: 128_000,
      channels: 1,
    } as const
    const confirmation = await preflightDialogueSpeechGenerationJob(
      'line:1',
      input,
      'speech-line-1-v1',
    )
    const job = await createDialogueSpeechGenerationJob(
      'line:1',
      input,
      'speech-line-1-v1',
      confirmation.confirmationToken,
    )

    assert.equal(job.output?.dialogueLineId, 'line:1')
    assert.equal(job.output?.asset.kind, 'speech')
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.url, '/api/v1/dialogue-lines/line%3A1/speech-generations')
    assert.equal(calls[1]?.url, calls[0]?.url)
    assert.equal(new Headers(calls[0]?.init.headers).get('Idempotency-Key'), 'speech-line-1-v1')
    assert.equal(new Headers(calls[1]?.init.headers).get('Idempotency-Key'), 'speech-line-1-v1')
    assert.equal(new Headers(calls[0]?.init.headers).get('x-manju-aigc-confirmation'), null)
    assert.equal(new Headers(calls[1]?.init.headers).get('x-manju-aigc-confirmation'), PAID_CONFIRMATION_TOKEN)
    assert.equal(calls[1]?.init.body, calls[0]?.init.body)
    assert.deepEqual(JSON.parse(calls[1]?.init.body as string), {
      projectId: 'project-1',
      episodeId: 'episode-1',
      providerId: 'minimax-speech',
      voiceId: 'female-shaonv',
      emotion: 'calm',
      sampleRate: 32_000,
      bitrate: 128_000,
      channels: 1,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('speech preflight rejects wrong-action challenges and preserves non-paid API errors', async () => {
  const originalFetch = globalThis.fetch
  const responses = [
    new Response(JSON.stringify({
      error: {
        code: 'PAID_CONFIRMATION_REQUIRED',
        message: '需要确认',
        details: {
          confirmation: {
            ...speechGenerationConfirmation(),
            action: 'dialogue.performance.recommendation',
          },
        },
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({
      error: { code: 'VOICE_PROFILE_REQUIRED', message: '请先配置声线' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
  ]
  globalThis.fetch = (async () => {
    const response = responses.shift()
    assert.ok(response)
    return response
  }) as typeof fetch
  const invoke = () => preflightDialogueSpeechGenerationJob('line-1', {
    projectId: 'project-1',
    episodeId: 'episode-1',
  }, 'speech-strict-1')
  try {
    await assert.rejects(
      invoke(),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
    await assert.rejects(
      invoke(),
      (error: unknown) => error instanceof ApiError && error.code === 'VOICE_PROFILE_REQUIRED',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('timeline materialize and reconcile clients preserve optimistic ETags and typed reports', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const responseBody = (operation: 'materialize' | 'reconcile', revisionId: string) => ({
    timelineDocument: {
      id: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      currentRevisionId: revisionId,
      schemaVersion: 1,
      upstreamCommit: 'cf5e79e919144200294fb9fed22a222592a0aeea',
      sourceRevisionId: 'story-revision-2',
      createdAt: NOW,
      updatedAt: NOW,
    },
    revision: {
      id: revisionId,
      documentId: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      parentRevisionId: operation === 'reconcile' ? 'timeline-revision-1' : null,
      schemaVersion: 1,
      upstreamCommit: 'cf5e79e919144200294fb9fed22a222592a0aeea',
      sourceRevisionId: 'story-revision-2',
      summary: operation,
      snapshot: {},
      createdAt: NOW,
    },
    document: { version: 1, tracks: {} },
    etag: `W/"${revisionId}"`,
    created: operation === 'materialize',
    report: {
      operation,
      sourceRevisionId: 'story-revision-2',
      previousSourceRevisionId: operation === 'reconcile' ? 'story-revision-1' : null,
      changed: true,
      preservedElementIds: operation === 'reconcile' ? ['clip-1'] : [],
      appendedShots: [{ sceneId: 'scene-1', shotId: 'shot-2', elementId: 'clip-2' }],
      orphanedElements: [],
      preservedAbsentShots: [],
      unresolvedShots: [],
    },
  })
  const responses = [
    jsonResponse(responseBody('materialize', 'timeline-revision-1'), 'timeline-revision-1', 201),
    jsonResponse(responseBody('reconcile', 'timeline-revision-2'), 'timeline-revision-2'),
  ]
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    const response = responses.shift()
    assert.ok(response)
    return response
  }) as typeof fetch

  try {
    const materialized = await materializeTimelineDocument('episode-1', {
      projectId: 'project-1',
    })
    assert.equal(materialized.etag, 'W/"timeline-revision-1"')
    assert.equal(materialized.report.appendedShots[0]?.shotId, 'shot-2')

    const reconciled = await reconcileTimelineDocument('episode-1', {
      projectId: 'project-1',
      summary: '对账剧本修订',
    }, materialized.etag)
    assert.equal(reconciled.etag, 'W/"timeline-revision-2"')
    assert.deepEqual(reconciled.report.preservedElementIds, ['clip-1'])
    assert.deepEqual(calls.map(({ url }) => url), [
      '/api/v1/episodes/episode-1/timeline-document/materialize',
      '/api/v1/episodes/episode-1/timeline-document/reconcile',
    ])
    assert.deepEqual(calls.map(({ init }) => new Headers(init.headers).get('If-Match')), [
      '*',
      'W/"timeline-revision-1"',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('asset lock client sends and preserves the opaque Episode ETag plus audit revision', async () => {
  const originalFetch = globalThis.fetch
  let captured: { url: string; init: RequestInit } | undefined
  const asset = {
    id: 'asset-character-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'character-image',
    version: 2,
    status: 'ready',
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    durationSeconds: null,
    checksum: 'sha256-character',
    source: 'provider',
    providerId: 'gpt-image',
    generationJobId: 'job-image-1',
    sourceRevisionId: 'story-revision-2',
    parentAssetId: null,
    url: '/api/v1/assets/asset-character-1/content',
    createdAt: NOW,
    updatedAt: NOW,
  }
  globalThis.fetch = (async (input, init = {}) => {
    captured = { url: String(input), init }
    return new Response(JSON.stringify({
      asset,
      target: {
        type: 'character',
        id: 'character-1',
        name: '阿离',
        version: 3,
        lockedAssetId: asset.id,
      },
      revision: { id: 'asset-lock-revision-1' },
      sourceRevisionId: 'story-revision-2',
      stale: { assets: 2, jobs: 1, exports: 1, qualityReports: 0, pipelineRuns: 1 },
      idempotent: false,
      auditRevision: true,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ETag: 'W/"episode.lock-version-2"',
        'X-Asset-Lock-Revision': 'asset-lock-revision-1',
      },
    })
  }) as typeof fetch

  try {
    const result = await lockAsset(asset.id, {
      projectId: 'project-1',
      episodeId: 'episode-1',
      targetType: 'character',
      targetId: 'character-1',
    }, 'W/"episode.lock-version-1"')

    assert.equal(result.etag, 'W/"episode.lock-version-2"')
    assert.equal(result.auditRevisionId, 'asset-lock-revision-1')
    assert.equal(captured?.url, '/api/v1/assets/asset-character-1/lock')
    assert.equal(new Headers(captured?.init.headers).get('If-Match'), 'W/"episode.lock-version-1"')
    assert.deepEqual(JSON.parse(captured?.init.body as string), {
      projectId: 'project-1',
      episodeId: 'episode-1',
      targetType: 'character',
      targetId: 'character-1',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
