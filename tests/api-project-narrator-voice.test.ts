import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  createProjectNarratorVoicePreview,
  deleteProjectNarratorVoiceProfile,
  getProjectNarratorVoicePreviewJob,
  getProjectNarratorVoiceProfile,
  listProjectNarratorVoicePreviewJobs,
  preflightProjectNarratorVoicePreview,
  putProjectNarratorVoiceProfile,
} from '../src/lib/api'
import type { StoryCharacterVoiceProfile } from '../src/lib/api-types'

const NOW = '2026-07-14T00:00:00.000Z'
const FINGERPRINT = 'c'.repeat(64)
const CONFIRMATION_EXPIRY = 4_102_444_800

function narratorPreviewConfirmation() {
  return {
    version: 1 as const,
    action: 'project.narrator.voice.preview' as const,
    label: '项目旁白声线试听',
    billableTaskCount: 1 as const,
    provider: { providerId: 'minimax-speech', model: 'speech-2.8-hd', configRevision: 9 },
    intentFingerprint: 'e'.repeat(64),
    expiresAt: '2100-01-01T00:00:00.000Z',
    confirmationToken: `aigcpf1_${CONFIRMATION_EXPIRY}_${'f'.repeat(64)}`,
    priceEstimate: null,
    priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE' as const,
  }
}
const profile: StoryCharacterVoiceProfile = {
  version: 1,
  voiceId: 'narrator-voice-1',
  providerId: 'minimax-speech',
  providerConfigRevision: 9,
  voiceType: 'system',
  voiceName: '沉稳叙事者',
  descriptions: ['沉稳清晰的普通话旁白'],
  selectionSource: 'manual',
  catalogFingerprint: FINGERPRINT,
  catalogObservedAt: NOW,
  historicalPin: false,
  updatedAt: NOW,
}
const project = {
  id: 'project-1',
  title: '锦雪长安',
  currentRevisionId: 'project-document-revision-7',
  updatedAt: NOW,
}
const stale = {
  speechAssets: 2,
  exportAssets: 1,
  jobs: 3,
  narrationLines: 4,
  exports: 1,
  qualityReports: 1,
  pipelineRuns: 0,
}

test('project narrator read preserves its dedicated opaque project-settings ETag', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  globalThis.fetch = (async (input) => {
    capturedUrl = String(input)
    return new Response(JSON.stringify({
      project,
      voiceProfile: profile,
      revisionId: 'narrator-audit-1',
    }), {
      headers: { 'Content-Type': 'application/json', ETag: 'W/"project-settings-1"' },
    })
  }) as typeof fetch
  try {
    const result = await getProjectNarratorVoiceProfile('project-1')
    assert.equal(capturedUrl, '/api/v1/projects/project-1/narrator-voice-profile')
    assert.equal(result.voiceProfile?.voiceId, 'narrator-voice-1')
    assert.equal(result.revisionId, 'narrator-audit-1')
    assert.equal(result.etag, 'W/"project-settings-1"')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('project narrator save sends only a catalog-confirmed voice and project If-Match', async () => {
  const originalFetch = globalThis.fetch
  let captured: { url: string; init: RequestInit } | undefined
  globalThis.fetch = (async (input, init = {}) => {
    captured = { url: String(input), init }
    return new Response(JSON.stringify({
      project: { ...project, updatedAt: '2026-07-14T00:01:00.000Z' },
      voiceProfile: profile,
      revisionId: 'narrator-audit-2',
      stale,
    }), {
      headers: { 'Content-Type': 'application/json', ETag: 'W/"project-settings-2"' },
    })
  }) as typeof fetch
  try {
    const result = await putProjectNarratorVoiceProfile('project-1', {
      voiceId: 'narrator-voice-1',
      expectedCatalogFingerprint: FINGERPRINT,
      expectedProviderConfigRevision: 9,
    }, 'W/"project-settings-1"')
    assert.equal(captured?.url, '/api/v1/projects/project-1/narrator-voice-profile')
    assert.equal(captured?.init.method, 'PUT')
    assert.equal(new Headers(captured?.init.headers).get('If-Match'), 'W/"project-settings-1"')
    assert.deepEqual(JSON.parse(String(captured?.init.body)), {
      voiceId: 'narrator-voice-1',
      expectedCatalogFingerprint: FINGERPRINT,
      expectedProviderConfigRevision: 9,
    })
    assert.equal(result.revisionId, 'narrator-audit-2')
    assert.equal(result.etag, 'W/"project-settings-2"')
    assert.deepEqual(result.stale, stale)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('project narrator clear uses the latest project-settings ETag and creates a deletion audit', async () => {
  const originalFetch = globalThis.fetch
  let captured: RequestInit | undefined
  globalThis.fetch = (async (_input, init = {}) => {
    captured = init
    return new Response(JSON.stringify({
      project: { ...project, updatedAt: '2026-07-14T00:02:00.000Z' },
      voiceProfile: null,
      revisionId: 'narrator-delete-audit-3',
      stale: { ...stale, speechAssets: 0, narrationLines: 0 },
    }), {
      headers: { 'Content-Type': 'application/json', ETag: 'W/"project-settings-3"' },
    })
  }) as typeof fetch
  try {
    const result = await deleteProjectNarratorVoiceProfile(
      'project-1',
      'W/"project-settings-2"',
    )
    assert.equal(captured?.method, 'DELETE')
    assert.equal(new Headers(captured?.headers).get('If-Match'), 'W/"project-settings-2"')
    assert.equal(captured?.body, undefined)
    assert.equal(result.voiceProfile, null)
    assert.equal(result.revisionId, 'narrator-delete-audit-3')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('project narrator preview is explicit, episode-bound, durable, and playable after refresh', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const previewInput = {
    episodeId: 'episode-1',
    expectedStoryRevisionId: 'story-revision-1',
    voiceId: 'narrator-voice-1',
    expectedCatalogFingerprint: FINGERPRINT,
    expectedProviderConfigRevision: 9,
  }
  const queued = {
    id: 'narrator-preview-job-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'project.narrator.voice.preview',
    status: 'queued',
    progress: 0,
    resourceId: 'project-1',
    providerId: 'minimax-speech',
    providerConfigRevision: 9,
    attempt: 1,
    input: previewInput,
    output: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
  const completed = {
    ...queued,
    status: 'succeeded',
    progress: 100,
    output: {
      episodeId: 'episode-1',
      voiceId: 'narrator-voice-1',
      sampleSource: 'narration',
      sampleCharacterCount: 11,
      asset: {
        id: 'narrator-preview-asset-1',
        projectId: 'project-1',
        episodeId: 'episode-1',
        kind: 'project.narrator.voice.preview',
        version: 1,
        status: 'ready',
        mimeType: 'audio/mpeg',
        width: null,
        height: null,
        durationSeconds: 0.9,
        checksum: 'd'.repeat(64),
        source: 'provider',
        providerId: 'minimax-speech',
        generationJobId: 'narrator-preview-job-1',
        sourceRevisionId: 'story-revision-1',
        parentAssetId: null,
        url: '/api/v1/assets/narrator-preview-asset-1/content',
        createdAt: NOW,
        updatedAt: NOW,
      },
      provider: { id: 'minimax-speech', model: 'speech-2.8-hd', configRevision: 9 },
    },
  }
  const responses = [
    new Response(JSON.stringify({
      error: {
        code: 'PAID_CONFIRMATION_REQUIRED',
        message: '需要明确确认',
        details: { confirmation: narratorPreviewConfirmation() },
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    Response.json({ job: queued }, { status: 202 }),
    Response.json({ job: completed }),
    Response.json({ jobs: [completed] }),
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
      voiceId: 'narrator-voice-1',
      expectedCatalogFingerprint: FINGERPRINT,
    }
    const confirmation = await preflightProjectNarratorVoicePreview(
      'episode-1',
      input,
      'W/"episode-version-1"',
      'narrator-preview-attempt-1',
    )
    const submitted = await createProjectNarratorVoicePreview(
      'episode-1',
      input,
      'W/"episode-version-1"',
      'narrator-preview-attempt-1',
      confirmation.confirmationToken,
    )
    assert.equal(submitted.status, 'queued')
    assert.equal(calls[0].url, '/api/v1/episodes/episode-1/narrator-voice-previews')
    assert.equal(calls[1].url, calls[0].url)
    assert.equal(calls[1].init.body, calls[0].init.body)
    assert.deepEqual(calls.slice(0, 2).map((call) => new Headers(call.init.headers).get('If-Match')), [
      'W/"episode-version-1"',
      'W/"episode-version-1"',
    ])
    assert.deepEqual(calls.slice(0, 2).map((call) => new Headers(call.init.headers).get('Idempotency-Key')), [
      'narrator-preview-attempt-1',
      'narrator-preview-attempt-1',
    ])
    assert.deepEqual(calls.slice(0, 2).map((call) => new Headers(call.init.headers).get('x-manju-aigc-confirmation')), [
      null,
      confirmation.confirmationToken,
    ])
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      projectId: 'project-1',
      voiceId: 'narrator-voice-1',
      expectedCatalogFingerprint: FINGERPRINT,
    })

    const terminal = await getProjectNarratorVoicePreviewJob(submitted.id)
    assert.equal(terminal.output?.asset.url, '/api/v1/assets/narrator-preview-asset-1/content')
    const restored = await listProjectNarratorVoicePreviewJobs('project-1')
    assert.equal(restored[0].id, submitted.id)
    assert.equal(restored[0].output?.asset.kind, 'project.narrator.voice.preview')
    assert.match(calls[3].url, /type=project\.narrator\.voice\.preview/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('project narrator client rejects profile/revision mismatches and malformed stale counts', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    project,
    voiceProfile: null,
    revisionId: 'orphan-audit',
  }), {
    headers: { 'Content-Type': 'application/json', ETag: 'W/"project-settings-1"' },
  })) as typeof fetch
  try {
    await assert.rejects(
      getProjectNarratorVoiceProfile('project-1'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  globalThis.fetch = (async () => new Response(JSON.stringify({
    project,
    voiceProfile: profile,
    revisionId: 'narrator-audit-2',
    stale: { ...stale, narrationLines: -1 },
  }), {
    headers: { 'Content-Type': 'application/json', ETag: 'W/"project-settings-2"' },
  })) as typeof fetch
  try {
    await assert.rejects(
      putProjectNarratorVoiceProfile('project-1', {
        voiceId: 'narrator-voice-1',
        expectedCatalogFingerprint: FINGERPRINT,
        expectedProviderConfigRevision: 9,
      }, 'W/"project-settings-1"'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
