import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  applyTimelineAutomaticEdit,
  previewTimelineAutomaticEdit,
  undoTimelineAutomaticEdit,
} from '../src/lib/api'

const NOW = '2026-07-14T00:00:00.000Z'
const COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'

function timeline(revisionId: string, parentRevisionId: string | null) {
  return {
    timelineDocument: {
      id: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      currentRevisionId: revisionId,
      schemaVersion: 2,
      upstreamCommit: COMMIT,
      sourceRevisionId: 'story-1',
      createdAt: NOW,
      updatedAt: NOW,
    },
    revision: {
      id: revisionId,
      documentId: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      parentRevisionId,
      schemaVersion: 2,
      upstreamCommit: COMMIT,
      sourceRevisionId: 'story-1',
      summary: 'Agentic auto edit',
      snapshot: {},
      createdAt: NOW,
    },
    document: { version: 2, tracks: [] },
    etag: `W/"${revisionId}"`,
  }
}

const operation = {
  kind: 'update-element-timing',
  trackId: 'dialogue-main',
  elementId: 'dialogue-1',
  reason: 'Reflow managed dialogue',
  before: { startTime: 0, duration: 48_000, trimStart: 0, trimEnd: 0 },
  after: { startTime: 24_000, duration: 48_000, trimStart: 0, trimEnd: 0 },
} as const

const planWithToken = {
  id: 'plan-1',
  projectId: 'project-1',
  episodeId: 'episode-1',
  documentId: 'timeline-1',
  baseRevisionId: 'revision-1',
  sourceRevisionId: 'story-1',
  goal: 'exportable',
  policy: 'safe',
  strategy: 'managed-dialogue-reflow-v1',
  executor: 'OpenCut-Classic/UpdateElementsCommand',
  upstreamCommit: COMMIT,
  schemaVersion: 2,
  planHash: 'a'.repeat(64),
  risk: 'safe',
  diagnostics: [{ code: 'DIALOGUE_REFLOW', severity: 'info', message: '对白将重排', elementIds: ['dialogue-1'] }],
  operations: [operation],
  changedElementIds: ['dialogue-1'],
  confirmationToken: 'confirm-plan-1',
  createdAt: NOW,
} as const

test('timeline auto-edit preview sends only the safe goal and policy and pins the base ETag', async () => {
  const originalFetch = globalThis.fetch
  let captured: { url: string; init: RequestInit } | null = null
  globalThis.fetch = (async (input, init = {}) => {
    captured = { url: String(input), init }
    return new Response(JSON.stringify({
      timeline: timeline('revision-1', null),
      plan: planWithToken,
      previewDocument: { version: 2, tracks: [] },
      diagnostics: [{ code: 'DIALOGUE_REFLOW', severity: 'info', message: '对白将重排', elementIds: ['dialogue-1'] }],
      operations: [operation],
      risk: 'safe',
      changedElementIds: ['dialogue-1'],
    }), {
      headers: { 'Content-Type': 'application/json', ETag: 'W/"revision-1"' },
    })
  }) as typeof fetch

  try {
    const preview = await previewTimelineAutomaticEdit(
      'episode-1',
      { goal: 'exportable', policy: 'safe' },
      'W/"revision-1"',
    )
    assert.equal(preview.plan.confirmationToken, 'confirm-plan-1')
    assert.equal(captured?.url, '/api/v1/episodes/episode-1/timeline-document/auto-edit/preview')
    const init = captured!.init
    assert.equal(new Headers(init.headers).get('If-Match'), 'W/"revision-1"')
    assert.deepEqual(JSON.parse(String(init.body)), {
      goal: 'exportable',
      policy: 'safe',
    })
    assert.equal('operations' in JSON.parse(String(init.body)), false)
    assert.equal('document' in JSON.parse(String(init.body)), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('timeline auto-edit apply and undo preserve confirmation, CAS and idempotency boundaries', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const { confirmationToken: _confirmationToken, ...plan } = planWithToken
  const application = {
    id: 'application-1',
    planId: 'plan-1',
    documentId: 'timeline-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    baseRevisionId: 'revision-1',
    resultRevisionId: 'revision-2',
    createdAt: NOW,
  }
  const responses = [
    new Response(JSON.stringify({
      timeline: timeline('revision-2', 'revision-1'),
      operationResultTimeline: timeline('revision-2', 'revision-1'),
      headAdvanced: false,
      application,
      plan,
      diagnostics: plan.diagnostics,
      operations: [operation],
      risk: 'safe',
      changedElementIds: ['dialogue-1'],
      idempotent: false,
    }), { status: 201, headers: { 'Content-Type': 'application/json', ETag: 'W/"revision-2"' } }),
    new Response(JSON.stringify({
      timeline: timeline('revision-3', 'revision-2'),
      operationResultTimeline: timeline('revision-3', 'revision-2'),
      headAdvanced: false,
      application,
      undo: {
        id: 'undo-1',
        applicationId: 'application-1',
        documentId: 'timeline-1',
        projectId: 'project-1',
        episodeId: 'episode-1',
        baseRevisionId: 'revision-2',
        resultRevisionId: 'revision-3',
        createdAt: NOW,
      },
      idempotent: false,
    }), { status: 201, headers: { 'Content-Type': 'application/json', ETag: 'W/"revision-3"' } }),
  ]
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    const response = responses.shift()
    assert.ok(response)
    return response
  }) as typeof fetch

  try {
    const applied = await applyTimelineAutomaticEdit(
      'episode-1',
      { planId: 'plan-1', confirmationToken: 'confirm-plan-1' },
      'W/"revision-1"',
      'apply-key-1',
    )
    assert.equal(applied.timeline.revision.id, 'revision-2')
    assert.equal(applied.operationResultTimeline.revision.id, 'revision-2')
    assert.equal(applied.headAdvanced, false)
    const undone = await undoTimelineAutomaticEdit(
      'application-1',
      'W/"revision-2"',
      'undo-key-1',
    )
    assert.equal(undone.timeline.revision.id, 'revision-3')
    assert.equal(undone.operationResultTimeline.revision.id, 'revision-3')
    assert.equal(undone.headAdvanced, false)

    assert.deepEqual(calls.map(({ url }) => url), [
      '/api/v1/episodes/episode-1/timeline-document/auto-edit/apply',
      '/api/v1/timeline-edit-applications/application-1/undo',
    ])
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      planId: 'plan-1',
      confirmationToken: 'confirm-plan-1',
    })
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), {})
    assert.equal(new Headers(calls[0].init.headers).get('If-Match'), 'W/"revision-1"')
    assert.equal(new Headers(calls[0].init.headers).get('Idempotency-Key'), 'apply-key-1')
    assert.equal(new Headers(calls[1].init.headers).get('If-Match'), 'W/"revision-2"')
    assert.equal(new Headers(calls[1].init.headers).get('Idempotency-Key'), 'undo-key-1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('idempotent apply replay keeps its immutable result but returns the later authoritative head', async () => {
  const originalFetch = globalThis.fetch
  const { confirmationToken: _confirmationToken, ...plan } = planWithToken
  const application = {
    id: 'application-1',
    planId: 'plan-1',
    documentId: 'timeline-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    baseRevisionId: 'revision-1',
    resultRevisionId: 'revision-2',
    createdAt: NOW,
  }
  globalThis.fetch = (async () => new Response(JSON.stringify({
    // Another tab has advanced the document after the original response was lost.
    timeline: timeline('revision-4', 'revision-3'),
    operationResultTimeline: timeline('revision-2', 'revision-1'),
    headAdvanced: true,
    application,
    plan,
    diagnostics: plan.diagnostics,
    operations: [operation],
    risk: 'safe',
    changedElementIds: ['dialogue-1'],
    idempotent: true,
  }), {
    headers: { 'Content-Type': 'application/json', ETag: 'W/"revision-4"' },
  })) as typeof fetch

  try {
    const replay = await applyTimelineAutomaticEdit(
      'episode-1',
      { planId: 'plan-1', confirmationToken: 'lost-response-retry' },
      'W/"revision-1"',
      'same-apply-key',
    )
    assert.equal(replay.idempotent, true)
    assert.equal(replay.headAdvanced, true)
    assert.equal(replay.application.resultRevisionId, 'revision-2')
    assert.equal(replay.operationResultTimeline.revision.id, 'revision-2')
    assert.equal(replay.timeline.revision.id, 'revision-4')
    assert.equal(replay.timeline.etag, 'W/"revision-4"')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('timeline auto-edit client rejects an operation list that does not explain changed IDs', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    timeline: timeline('revision-1', null),
    plan: planWithToken,
    previewDocument: { version: 2, tracks: [] },
    diagnostics: [],
    operations: [operation],
    risk: 'safe',
    changedElementIds: ['different-element'],
  }), { headers: { 'Content-Type': 'application/json', ETag: 'W/"revision-1"' } })) as typeof fetch

  try {
    await assert.rejects(
      previewTimelineAutomaticEdit(
        'episode-1',
        { goal: 'exportable', policy: 'safe' },
        'W/"revision-1"',
      ),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('timeline auto-edit client accepts a strictly matched blocked exportability diagnosis', async () => {
  const originalFetch = globalThis.fetch
  const diagnostics = [{
    code: 'UNSAFE_VISUAL_GAP_OR_OVERLAP',
    severity: 'error',
    message: '视觉轨存在空隙或重叠，无法安全自动修复',
    elementIds: [],
  }] as const
  const blockedPlan = {
    ...planWithToken,
    risk: 'blocked',
    diagnostics,
    operations: [],
    changedElementIds: [],
  } as const
  globalThis.fetch = (async () => new Response(JSON.stringify({
    timeline: timeline('revision-1', null),
    plan: blockedPlan,
    previewDocument: { version: 2, tracks: [] },
    diagnostics,
    operations: [],
    risk: 'blocked',
    changedElementIds: [],
  }), { headers: { 'Content-Type': 'application/json', ETag: 'W/"revision-1"' } })) as typeof fetch

  try {
    const preview = await previewTimelineAutomaticEdit(
      'episode-1',
      { goal: 'exportable', policy: 'safe' },
      'W/"revision-1"',
    )
    assert.equal(preview.risk, 'blocked')
    assert.equal(preview.plan.risk, 'blocked')
    assert.equal(preview.diagnostics[0]?.code, 'UNSAFE_VISUAL_GAP_OR_OVERLAP')
    assert.deepEqual(preview.operations, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('timeline auto-edit client rejects a top-level risk that disagrees with the signed plan', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    timeline: timeline('revision-1', null),
    plan: planWithToken,
    previewDocument: { version: 2, tracks: [] },
    diagnostics: planWithToken.diagnostics,
    operations: [operation],
    risk: 'blocked',
    changedElementIds: ['dialogue-1'],
  }), { headers: { 'Content-Type': 'application/json', ETag: 'W/"revision-1"' } })) as typeof fetch

  try {
    await assert.rejects(
      previewTimelineAutomaticEdit(
        'episode-1',
        { goal: 'exportable', policy: 'safe' },
        'W/"revision-1"',
      ),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
