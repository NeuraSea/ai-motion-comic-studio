import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  createQualityCheck,
  getQualityReport,
} from '../src/lib/api'

const NOW = '2026-07-14T00:00:00.000Z'

function qualityReport(overrides: Record<string, unknown> = {}) {
  return {
    id: 'quality-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    exportId: 'export-1',
    outputAssetId: 'video-1',
    outputAssetChecksum: 'a'.repeat(64),
    timelineRevisionId: 'timeline-1',
    storyRevisionId: 'story-1',
    status: 'queued',
    passed: null,
    policy: { version: 1 },
    expected: { container: 'mp4', width: 1080, height: 1920 },
    checks: [],
    metrics: {},
    summary: { passed: null, failedChecks: 0, warningChecks: 0 },
    jobId: 'quality-job-1',
    jobStatus: 'queued',
    error: null,
    createdAt: NOW,
    completedAt: null,
    ...overrides,
  }
}

function qualityJob() {
  return {
    id: 'quality-job-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'quality.check',
    status: 'queued',
    progress: 0,
    resourceId: 'quality-1',
    attempt: 1,
    input: { qualityReportId: 'quality-1' },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

test('quality client submits an idempotent immutable export check and fetches its report', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const passed = qualityReport({
    status: 'passed',
    passed: true,
    jobStatus: 'succeeded',
    summary: { passed: true, failedChecks: 0, warningChecks: 0 },
    checks: [
      {
        id: 'decodable',
        status: 'passed',
        severity: 'error',
        message: '完整解码通过',
        metrics: {},
      },
      {
        id: 'subtitle.timing',
        status: 'passed',
        severity: 'info',
        message: '字幕时序通过',
        metrics: { cueCount: 2 },
      },
      {
        id: 'subtitle.safe-area',
        status: 'warning',
        severity: 'warning',
        message: '字幕安全区需人工确认',
        metrics: { overflowCueCount: 1 },
      },
    ],
    completedAt: NOW,
  })
  const responses = [
    new Response(JSON.stringify({ qualityReport: qualityReport(), job: qualityJob() }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify({ qualityReport: passed }), {
      headers: { 'content-type': 'application/json' },
    }),
  ]
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    const response = responses.shift()
    assert.ok(response)
    return response
  }) as typeof fetch

  try {
    const created = await createQualityCheck('export-1', 'quality-once')
    assert.equal(created.qualityReport.id, 'quality-1')
    assert.equal(created.job.input.qualityReportId, 'quality-1')
    const fetched = await getQualityReport('quality-1')
    assert.equal(fetched.passed, true)
    assert.equal(fetched.checks[0].id, 'decodable')
    assert.deepEqual(fetched.checks.slice(1).map((check) => check.id), [
      'subtitle.timing',
      'subtitle.safe-area',
    ])
    assert.deepEqual(calls.map((call) => call.url), [
      '/api/v1/exports/export-1/quality-checks',
      '/api/v1/quality-reports/quality-1',
    ])
    const headers = new Headers(calls[0].init.headers)
    assert.equal(headers.get('Idempotency-Key'), 'quality-once')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {})
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('quality client rejects a job/report binding mismatch', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    qualityReport: qualityReport(),
    job: { ...qualityJob(), input: { qualityReportId: 'other-report' } },
  }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
  try {
    await assert.rejects(
      createQualityCheck('export-1', 'quality-once'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('quality client rejects an unknown quality check identifier', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    qualityReport: qualityReport({
      checks: [{
        id: 'subtitle.unsupported',
        status: 'passed',
        severity: 'info',
        message: 'unsupported',
        metrics: {},
      }],
    }),
  }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
  try {
    await assert.rejects(
      getQualityReport('quality-1'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
