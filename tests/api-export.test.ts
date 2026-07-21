import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  createExportRender,
  createReleaseReview,
  getExportRender,
  listReleaseReviews,
} from '../src/lib/api'

const NOW = '2026-07-14T00:00:00.000Z'

function exportRecord(kenBurns = true) {
  return {
    id: 'export-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    status: 'queued',
    timelineRevisionId: 'timeline-revision-2',
    storyRevisionId: 'story-revision-3',
    specification: {
      version: 1,
      resolution: '1080p',
      aspectRatio: '9:16',
      kenBurns,
      burnSubtitles: true,
      introTitle: true,
      outroCard: true,
      reviewWatermark: false,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      frameRate: 24,
      audioCodec: 'aac',
      audioSampleRate: 48_000,
      timelineRevisionId: 'timeline-revision-2',
      storyRevisionId: 'story-revision-3',
    },
    outputAsset: null,
    reviewDownloadUrl: null,
    downloadUrl: null,
    jobId: 'job-export-1',
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  }
}

function exportJob() {
  return {
    id: 'job-export-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'export.render',
    status: 'queued',
    progress: 0,
    resourceId: 'export-1',
    attempt: 1,
    input: { exportId: 'export-1' },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function exportAsset(url = '/api/v1/exports/export-1/download') {
  return {
    id: 'asset-export-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'export.video',
    version: 1,
    status: 'ready',
    mimeType: 'video/mp4',
    width: 1080,
    height: 1920,
    durationSeconds: 45,
    checksum: 'a'.repeat(64),
    source: 'generated',
    providerId: null,
    generationJobId: 'job-export-1',
    sourceRevisionId: 'story-revision-3',
    parentAssetId: null,
    url,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function succeededExportRecord(url = '/api/v1/exports/export-1/download') {
  return {
    ...exportRecord(),
    status: 'succeeded',
    outputAsset: exportAsset(url),
    reviewDownloadUrl: '/api/v1/exports/export-1/review-download',
    downloadUrl: '/api/v1/exports/export-1/download',
    completedAt: NOW,
  }
}

test('export client pins timeline in body and If-Match and preserves Idempotency-Key', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const responses = [
    new Response(JSON.stringify({ export: exportRecord(false), job: exportJob() }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify({ export: exportRecord(false) }), {
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
    const created = await createExportRender('episode-1', {
      projectId: 'project-1',
      timelineRevisionId: 'timeline-revision-2',
      resolution: '1080p',
      kenBurns: false,
      burnSubtitles: true,
      introTitle: true,
      outroCard: true,
      reviewWatermark: false,
    }, 'W/"timeline-revision-2"', 'export-key-1')
    assert.equal(created.export.id, 'export-1')
    assert.equal(created.job.input.exportId, 'export-1')

    const fetched = await getExportRender('export-1')
    assert.equal(fetched.specification.resolution, '1080p')
    assert.equal(fetched.specification.aspectRatio, '9:16')
    assert.equal(fetched.specification.kenBurns, false)
    assert.deepEqual(calls.map(({ url }) => url), [
      '/api/v1/episodes/episode-1/exports',
      '/api/v1/exports/export-1',
    ])
    const headers = new Headers(calls[0]?.init.headers)
    assert.equal(headers.get('If-Match'), 'W/"timeline-revision-2"')
    assert.equal(headers.get('Idempotency-Key'), 'export-key-1')
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      projectId: 'project-1',
      timelineRevisionId: 'timeline-revision-2',
      resolution: '1080p',
      kenBurns: false,
      burnSubtitles: true,
      introTitle: true,
      outroCard: true,
      reviewWatermark: false,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('export client rejects a response whose immutable revision links disagree', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    export: {
      ...exportRecord(),
      specification: {
        ...exportRecord().specification,
        timelineRevisionId: 'different-revision',
      },
    },
  }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch

  try {
    await assert.rejects(
      getExportRender('export-1'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('export client rejects missing or mismatched immutable branding booleans', async () => {
  const originalFetch = globalThis.fetch
  const missingIntro = exportRecord()
  delete (missingIntro.specification as Record<string, unknown>).introTitle
  const responses = [
    { export: missingIntro },
    {
      export: {
        ...exportRecord(),
        specification: {
          ...exportRecord().specification,
          reviewWatermark: true,
        },
      },
      job: exportJob(),
    },
  ]
  globalThis.fetch = (async () => new Response(JSON.stringify(responses.shift()), {
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch

  try {
    await assert.rejects(
      getExportRender('export-1'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
    await assert.rejects(
      createExportRender('episode-1', {
        projectId: 'project-1',
        timelineRevisionId: 'timeline-revision-2',
        resolution: '1080p',
        kenBurns: true,
        burnSubtitles: true,
        introTitle: true,
        outroCard: true,
        reviewWatermark: false,
      }, 'W/"timeline-revision-2"', 'export-key-branding-mismatch'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('export client accepts only the distinct review and release gates for succeeded export bytes', async () => {
  const originalFetch = globalThis.fetch
  const responses = [
    succeededExportRecord(),
    succeededExportRecord('/api/v1/assets/asset-export-1/content'),
  ]
  globalThis.fetch = (async () => new Response(JSON.stringify({
    export: responses.shift(),
  }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch

  try {
    const accepted = await getExportRender('export-1')
    assert.equal(accepted.outputAsset?.url, '/api/v1/exports/export-1/download')
    assert.equal(accepted.reviewDownloadUrl, '/api/v1/exports/export-1/review-download')
    await assert.rejects(
      getExportRender('export-1'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

function releaseReview(decision: 'approve' | 'reject' = 'approve') {
  const approved = decision === 'approve'
  return {
    id: `review-${decision}`,
    projectId: 'project-1',
    episodeId: 'episode-1',
    exportId: 'export-1',
    outputAssetId: 'asset-export-1',
    outputAssetChecksum: 'a'.repeat(64),
    timelineRevisionId: 'timeline-revision-2',
    storyRevisionId: 'story-revision-3',
    qualityReportId: 'quality-report-1',
    qualityPolicyVersion: 2,
    decision,
    checklist: {
      audioVideoSync: approved,
      subtitleSyncAndComplete: approved,
      characterVisualSemantics: approved,
    },
    notes: approved ? null : '台词与口型节点错位',
    reviewedAt: NOW,
    isCurrent: true,
    invalidReasons: [],
  }
}

test('release review client preserves the exact checklist and idempotency key', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ releaseReview: releaseReview() }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const input = {
      decision: 'approve' as const,
      checklist: {
        audioVideoSync: true,
        subtitleSyncAndComplete: true,
        characterVisualSemantics: true,
      },
    }
    const result = await createReleaseReview('export-1', input, 'release-review-key-1')
    assert.equal(result.releaseReview.decision, 'approve')
    assert.equal(calls[0]?.url, '/api/v1/exports/export-1/release-reviews')
    const headers = new Headers(calls[0]?.init.headers)
    assert.equal(headers.get('Idempotency-Key'), 'release-review-key-1')
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), input)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('release review client lists immutable records and rejects a mismatched submission', async () => {
  const originalFetch = globalThis.fetch
  const responses = [
    { releaseReviews: [releaseReview('reject'), { ...releaseReview(), isCurrent: false }] },
    { releaseReview: releaseReview('reject') },
  ]
  globalThis.fetch = (async () => new Response(JSON.stringify(responses.shift()), {
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch

  try {
    const history = await listReleaseReviews('export-1')
    assert.equal(history.length, 2)
    await assert.rejects(
      createReleaseReview('export-1', {
        decision: 'approve',
        checklist: {
          audioVideoSync: true,
          subtitleSyncAndComplete: true,
          characterVisualSemantics: true,
        },
      }, 'release-review-key-mismatch'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
