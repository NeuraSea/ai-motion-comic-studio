import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  decideShotMediaReview,
  getShotMediaReview,
} from '../src/lib/api'

const EPISODE_ETAG = 'W/"episode-head-1"'
const NEXT_EPISODE_ETAG = 'W/"episode-head-2"'
const NOW = '2026-07-15T00:00:00.000Z'

function candidate(overrides: Record<string, unknown> = {}) {
  const value = {
    id: 'asset-video-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'shot.video',
    version: 2,
    status: 'ready',
    mimeType: 'video/mp4',
    width: 1280,
    height: 720,
    durationSeconds: 5,
    checksum: 'a'.repeat(64),
    sourceRevisionId: 'story-revision-1',
    parentAssetId: 'asset-video-0',
    generationJobId: 'job-video-1',
    url: '/api/v1/assets/asset-video-1/content',
    createdAt: NOW,
    selected: true,
    eligible: true,
    eligibilityError: null,
    lastDecision: 'adopt',
    ...overrides,
  }
  return {
    ...value,
    url: `/api/v1/assets/${encodeURIComponent(String(value.id))}/content`,
  }
}

function historyRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'review-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    databaseShotId: 'database-shot-1',
    shotId: 'shot:1',
    sceneId: 'scene-1',
    sourceRevisionId: 'story-revision-1',
    mediaType: 'video',
    decision: 'adopt',
    assetId: 'asset-video-1',
    previousAssetId: 'asset-video-0',
    selectedAssetId: 'asset-video-1',
    clearedVideoAssetId: null,
    note: '选用动作更稳定的版本',
    timelineReconcileRequired: true,
    stale: {
      generationJobs: 1,
      shotVideoJobs: 0,
      exports: 1,
      qualityReports: 1,
      pipelineRuns: 1,
    },
    createdAt: NOW,
    ...overrides,
  }
}

function snapshot(overrides: Record<string, unknown> = {}) {
  const current = candidate()
  return {
    projectId: 'project-1',
    episodeId: 'episode-1',
    databaseShotId: 'database-shot-1',
    shotId: 'shot:1',
    sceneId: 'scene-1',
    sourceRevisionId: 'story-revision-1',
    mediaType: 'video',
    episodeEtag: EPISODE_ETAG,
    currentSelection: current,
    currentSelectionAssetId: current.id,
    candidates: [current, candidate({
      id: 'asset-video-0',
      version: 1,
      checksum: 'b'.repeat(64),
      parentAssetId: null,
      generationJobId: 'job-video-0',
      selected: false,
      lastDecision: null,
    })],
    history: [historyRecord()],
    pagination: { limit: 200, offset: 0 },
    ...overrides,
  }
}

test('shot media review GET sends exact scoped query and strictly accepts the Episode ETag', async () => {
  const originalFetch = globalThis.fetch
  let captured: { url: string; init: RequestInit } | undefined
  globalThis.fetch = (async (request, init = {}) => {
    captured = { url: String(request), init }
    return new Response(JSON.stringify({ mediaReview: snapshot() }), {
      status: 200,
      headers: { 'content-type': 'application/json', ETag: EPISODE_ETAG },
    })
  }) as typeof fetch
  try {
    const result = await getShotMediaReview('shot:1', {
      projectId: 'project-1',
      episodeId: 'episode-1',
      sceneId: 'scene-1',
      mediaType: 'video',
      limit: 200,
      offset: 0,
    })
    assert.equal(result.currentSelection?.id, 'asset-video-1')
    assert.equal(result.history[0]?.timelineReconcileRequired, true)
    assert.equal(
      captured?.url,
      '/api/v1/shots/shot%3A1/media-review?projectId=project-1&episodeId=episode-1&mediaType=video&sceneId=scene-1&limit=200&offset=0',
    )
    assert.equal(captured?.init.method, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shot media decision POST carries current Episode If-Match and stable idempotency key without paid headers', async () => {
  const originalFetch = globalThis.fetch
  let captured: { url: string; init: RequestInit } | undefined
  const review = historyRecord()
  globalThis.fetch = (async (request, init = {}) => {
    captured = { url: String(request), init }
    return new Response(JSON.stringify({
      mediaReview: {
        review,
        episodeEtag: NEXT_EPISODE_ETAG,
        currentSelectionAssetId: 'asset-video-1',
        clearedVideoAssetId: null,
        timelineReconcileRequired: true,
        idempotent: false,
        headAdvanced: false,
      },
    }), {
      status: 201,
      headers: { 'content-type': 'application/json', ETag: NEXT_EPISODE_ETAG },
    })
  }) as typeof fetch
  const input = {
    projectId: 'project-1',
    episodeId: 'episode-1',
    sceneId: 'scene-1',
    mediaType: 'video' as const,
    decision: 'adopt' as const,
    assetId: 'asset-video-1',
    note: '选用动作更稳定的版本',
  }
  try {
    const result = await decideShotMediaReview(
      'shot:1',
      input,
      EPISODE_ETAG,
      'shot-media-review-9f9646b1-355e-4b73-b4a0-28a3f36f0424',
    )
    assert.equal(result.review.id, 'review-1')
    assert.equal(captured?.url, '/api/v1/shots/shot%3A1/media-review')
    assert.equal(captured?.init.method, 'POST')
    const headers = new Headers(captured?.init.headers)
    assert.equal(headers.get('If-Match'), EPISODE_ETAG)
    assert.equal(
      headers.get('Idempotency-Key'),
      'shot-media-review-9f9646b1-355e-4b73-b4a0-28a3f36f0424',
    )
    assert.equal(headers.get('x-manju-aigc-confirmation'), null)
    assert.deepEqual(JSON.parse(String(captured?.init.body)), input)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shot media review rejects an envelope whose embedded and header Episode ETags differ', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ mediaReview: snapshot() }), {
    status: 200,
    headers: { 'content-type': 'application/json', ETag: NEXT_EPISODE_ETAG },
  })) as typeof fetch
  try {
    await assert.rejects(
      getShotMediaReview('shot:1', {
        projectId: 'project-1',
        episodeId: 'episode-1',
        sceneId: 'scene-1',
        mediaType: 'video',
        limit: 200,
        offset: 0,
      }),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shot media review rejects cross-shot history instead of trusting display-only JSON', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    mediaReview: snapshot({ history: [historyRecord({ shotId: 'other-shot' })] }),
  }), {
    status: 200,
    headers: { 'content-type': 'application/json', ETag: EPISODE_ETAG },
  })) as typeof fetch
  try {
    await assert.rejects(
      getShotMediaReview('shot:1', {
        projectId: 'project-1',
        episodeId: 'episode-1',
        sceneId: 'scene-1',
        mediaType: 'video',
        limit: 200,
        offset: 0,
      }),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shot media review keeps a provenance-invalid historical video visible with an explanation', async () => {
  const originalFetch = globalThis.fetch
  const value = snapshot()
  value.candidates[1] = candidate({
    id: 'asset-video-old-anchor',
    version: 1,
    checksum: 'c'.repeat(64),
    parentAssetId: null,
    generationJobId: 'job-video-old-anchor',
    selected: false,
    eligible: false,
    eligibilityError: '该视频绑定的分镜锚点不是当前分镜版本',
    lastDecision: 'restore',
  })
  globalThis.fetch = (async () => new Response(JSON.stringify({ mediaReview: value }), {
    status: 200,
    headers: { 'content-type': 'application/json', ETag: EPISODE_ETAG },
  })) as typeof fetch
  try {
    const result = await getShotMediaReview('shot:1', {
      projectId: 'project-1',
      episodeId: 'episode-1',
      sceneId: 'scene-1',
      mediaType: 'video',
      limit: 200,
      offset: 0,
    })
    assert.equal(result.candidates[1]?.eligible, false)
    assert.match(result.candidates[1]?.eligibilityError ?? '', /分镜锚点/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
