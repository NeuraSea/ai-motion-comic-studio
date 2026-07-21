import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiError,
  createCharacterVoicePreview,
  createVoicePreviewReview,
  createCharacterVoiceRecommendation,
  createDialogueSpeechGenerationJob,
  getCharacterVoiceRecommendationJob,
  getCharacterVoicePreviewJob,
  listCharacterVoicePreviewJobs,
  listMiniMaxVoices,
  listVoicePreviewReviews,
  preflightCharacterVoicePreview,
  putCharacterVoiceProfile,
} from '../src/lib/api'
import type { StoryCharacterVoiceProfile } from '../src/lib/api-types'

const NOW = '2026-07-14T00:00:00.000Z'
const FINGERPRINT = 'a'.repeat(64)
const CONFIRMATION_EXPIRY = 4_102_444_800

function paidConfirmation(
  action: 'character.voice.preview',
) {
  return {
    version: 1 as const,
    action,
    label: '角色声线试听',
    billableTaskCount: 1 as const,
    provider: { providerId: 'minimax-speech', model: 'speech-2.8-hd', configRevision: 7 },
    intentFingerprint: 'd'.repeat(64),
    expiresAt: '2100-01-01T00:00:00.000Z',
    confirmationToken: `aigcpf1_${CONFIRMATION_EXPIRY}_${'e'.repeat(64)}`,
    priceEstimate: null,
    priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE' as const,
  }
}
const PAID_CONFIRMATION_TOKEN = `aigcpf1_4102444800_${'f'.repeat(64)}`
const PUBLIC_RECOMMENDATION_INPUT = {
  episodeId: 'episode-1',
  characterId: 'ali',
  expectedStoryRevisionId: 'story-revision-1',
  catalog: {
    providerId: 'minimax-speech' as const,
    providerConfigRevision: 7,
    fingerprint: FINGERPRINT,
    voiceCount: 332,
  },
}

const profile: StoryCharacterVoiceProfile = {
  version: 1,
  voiceId: 'cn-heroine',
  providerId: 'minimax-speech',
  providerConfigRevision: 7,
  voiceType: 'system',
  voiceName: '英气少女',
  descriptions: ['坚定、克制的年轻女声'],
  selectionSource: 'manual',
  defaultDelivery: { emotion: 'calm', speed: 0.95, pitch: 0 },
  catalogFingerprint: FINGERPRINT,
  catalogObservedAt: NOW,
  historicalPin: false,
  updatedAt: NOW,
}

test('MiniMax catalog client exposes only verified provider metadata and real voice entries', async () => {
  const originalFetch = globalThis.fetch
  let captured = ''
  globalThis.fetch = (async (input) => {
    captured = String(input)
    return Response.json({
      provider: { id: 'minimax-speech', configRevision: 7, model: 'speech-2.8-hd' },
      observedAt: NOW,
      fingerprint: FINGERPRINT,
      voices: [{
        voiceId: 'cn-heroine',
        name: '英气少女',
        descriptions: ['坚定、克制的年轻女声'],
        type: 'system',
      }],
    })
  }) as typeof fetch
  try {
    const catalog = await listMiniMaxVoices()
    assert.equal(captured, '/api/v1/providers/minimax-speech/voices')
    assert.equal(catalog.voices[0].name, '英气少女')
    assert.equal(JSON.stringify(catalog).includes('apiKey'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('character profile confirmation uses Episode ETag while preserving an independent audit revision', async () => {
  const originalFetch = globalThis.fetch
  let captured: { url: string; init: RequestInit } | undefined
  globalThis.fetch = (async (input, init = {}) => {
    captured = { url: String(input), init }
    return new Response(JSON.stringify({
      episode: {
        id: 'episode-1',
        projectId: 'project-1',
        sourceRevisionId: 'story-revision-stays-the-same',
        updatedAt: NOW,
      },
      character: { id: 'ali', name: '阿离', role: '年轻剑客' },
      voiceProfile: profile,
      revisionId: 'voice-audit-revision-1',
      stale: {
        speechAssets: 1,
        exportAssets: 1,
        jobs: 2,
        dialogueLines: 1,
        exports: 1,
        qualityReports: 1,
        pipelineRuns: 0,
      },
    }), {
      headers: { 'Content-Type': 'application/json', ETag: 'W/"episode-version-2"' },
    })
  }) as typeof fetch
  try {
    const result = await putCharacterVoiceProfile('episode-1', 'ali', {
      projectId: 'project-1',
      voiceId: 'cn-heroine',
      selectionSource: 'manual',
      expectedProviderConfigRevision: 7,
    }, 'W/"episode-version-1"')
    assert.equal(result.revisionId, 'voice-audit-revision-1')
    assert.equal(result.episode.sourceRevisionId, 'story-revision-stays-the-same')
    assert.equal(result.etag, 'W/"episode-version-2"')
    assert.equal(captured?.url, '/api/v1/episodes/episode-1/characters/ali/voice-profile')
    assert.equal(new Headers(captured?.init.headers).get('If-Match'), 'W/"episode-version-1"')
    assert.deepEqual(JSON.parse(String(captured?.init.body)), {
      projectId: 'project-1',
      voiceId: 'cn-heroine',
      selectionSource: 'manual',
      expectedProviderConfigRevision: 7,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('inherited dialogue request omits raw providerId and voiceId while durable job records audited resolution', async () => {
  const originalFetch = globalThis.fetch
  let capturedBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init = {}) => {
    capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>
    return Response.json({
      job: {
        id: 'speech-job-1',
        projectId: 'project-1',
        episodeId: 'episode-1',
        type: 'dialogue.speech.generate',
        status: 'queued',
        progress: 0,
        attempt: 1,
        input: {
          episodeId: 'episode-1',
          lineId: 'line-1',
          databaseLineId: 'line-db-1',
          expectedRevisionId: 'story-revision-1',
          inheritedVoiceProfileRevisionId: 'voice-audit-revision-1',
          voiceId: 'cn-heroine',
          speed: 0.95,
          volume: 1,
          pitch: 0,
          emotion: 'calm',
          format: 'mp3',
          sampleRate: 32_000,
          bitrate: 128_000,
          channels: 1,
        },
        output: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    })
  }) as typeof fetch
  try {
    const job = await createDialogueSpeechGenerationJob('line-1', {
      projectId: 'project-1',
      episodeId: 'episode-1',
      speed: 0.95,
      volume: 1,
      pitch: 0,
      emotion: 'calm',
      format: 'mp3',
      sampleRate: 32_000,
      bitrate: 128_000,
      channels: 1,
    }, 'inherit-line-1', PAID_CONFIRMATION_TOKEN)
    assert.equal(job.input.inheritedVoiceProfileRevisionId, 'voice-audit-revision-1')
    assert.equal('providerId' in (capturedBody ?? {}), false)
    assert.equal('voiceId' in (capturedBody ?? {}), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('agentic recommendation directly pins catalog fingerprint in a durable text-model job', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const queued = {
    id: 'voice-recommend-job-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'character.voice.recommend',
    status: 'queued',
    progress: 0,
    input: PUBLIC_RECOMMENDATION_INPUT,
    output: null,
    attempt: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
  const recommendation = {
    version: 'character-voice-agent-v1',
    catalogFingerprint: FINGERPRINT,
    selectedVoiceId: 'cn-heroine',
    rationale: '英气且克制，符合年轻剑客。',
    profileTags: ['年轻', '英气'],
    alternatives: [],
    defaultDelivery: { emotion: 'calm', speed: 0.95, pitch: 0 },
    sceneDirections: [],
  }
  const responses = [
    Response.json({ job: queued }, { status: 202 }),
    Response.json({ job: {
      ...queued,
      status: 'succeeded',
      progress: 100,
      output: { characterId: 'ali', recommendation },
    } }),
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
      textProviderId: 'custom-text',
      expectedCatalogFingerprint: FINGERPRINT,
    }
    const job = await createCharacterVoiceRecommendation(
      'episode-1',
      'ali',
      input,
      'W/"episode-version-1"',
      'voice-cast-attempt-1',
    )
    assert.equal(job.status, 'queued')
    const completed = await getCharacterVoiceRecommendationJob(job.id)
    assert.equal(completed.output?.recommendation.selectedVoiceId, 'cn-heroine')
    assert.equal(calls[0].url, '/api/v1/episodes/episode-1/characters/ali/voice-recommendations')
    assert.equal(new Headers(calls[0].init.headers).get('If-Match'), 'W/"episode-version-1"')
    assert.equal(new Headers(calls[0].init.headers).get('Idempotency-Key'), 'voice-cast-attempt-1')
    assert.equal(new Headers(calls[0].init.headers).get('x-manju-aigc-confirmation'), null)
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      projectId: 'project-1',
      textProviderId: 'custom-text',
      expectedCatalogFingerprint: FINGERPRINT,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('recommendation client rejects invented score fields instead of presenting fake confidence', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({
    job: {
      id: 'voice-recommend-job-invalid',
      type: 'character.voice.recommend',
      status: 'succeeded',
      input: PUBLIC_RECOMMENDATION_INPUT,
      output: {
        characterId: 'ali',
        recommendation: {
          version: 'character-voice-agent-v1',
          catalogFingerprint: FINGERPRINT,
          selectedVoiceId: 'cn-heroine',
          rationale: '理由',
          score: 0.99,
          profileTags: ['英气'],
          alternatives: [],
          defaultDelivery: { emotion: 'calm', speed: 1, pitch: 0 },
          sceneDirections: [],
        },
      },
    },
  })) as typeof fetch
  try {
    await assert.rejects(
      getCharacterVoiceRecommendationJob('voice-recommend-job-invalid'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('voice preview is an explicit paid request and restored jobs keep a playable persisted asset', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const previewInput = {
    episodeId: 'episode-1',
    characterId: 'ali',
    expectedStoryRevisionId: 'story-revision-1',
    voiceId: 'cn-heroine',
    expectedCatalogFingerprint: FINGERPRINT,
    expectedProviderConfigRevision: 7,
  }
  const queued = {
    id: 'voice-preview-job-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'character.voice.preview',
    status: 'queued',
    progress: 0,
    resourceId: 'ali',
    providerId: 'minimax-speech',
    providerConfigRevision: 7,
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
      characterId: 'ali',
      voiceId: 'cn-heroine',
      sampleSource: 'dialogue',
      sampleCharacterCount: 12,
      asset: {
        id: 'voice-preview-asset-1',
        projectId: 'project-1',
        episodeId: 'episode-1',
        kind: 'character.voice.preview',
        version: 1,
        status: 'ready',
        mimeType: 'audio/mpeg',
        width: null,
        height: null,
        durationSeconds: 0.8,
        checksum: 'b'.repeat(64),
        source: 'provider',
        providerId: 'minimax-speech',
        generationJobId: 'voice-preview-job-1',
        sourceRevisionId: 'story-revision-1',
        parentAssetId: null,
        url: '/api/v1/assets/voice-preview-asset-1/content',
        createdAt: NOW,
        updatedAt: NOW,
      },
      provider: { id: 'minimax-speech', model: 'speech-2.8-hd', configRevision: 7 },
    },
  }
  const responses = [
    new Response(JSON.stringify({
      error: {
        code: 'PAID_CONFIRMATION_REQUIRED',
        message: '需要明确确认',
        details: { confirmation: paidConfirmation('character.voice.preview') },
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
    // No function is called merely by selecting a catalog item. TTS begins
    // only at this explicit API invocation.
    const input = {
      projectId: 'project-1',
      voiceId: 'cn-heroine',
      expectedCatalogFingerprint: FINGERPRINT,
    }
    const confirmation = await preflightCharacterVoicePreview(
      'episode-1',
      'ali',
      input,
      'W/"episode-version-1"',
      'preview-attempt-1',
    )
    const submitted = await createCharacterVoicePreview(
      'episode-1',
      'ali',
      input,
      'W/"episode-version-1"',
      'preview-attempt-1',
      confirmation.confirmationToken,
    )
    assert.equal(submitted.status, 'queued')
    assert.equal(calls[0].url, '/api/v1/episodes/episode-1/characters/ali/voice-previews')
    assert.equal(calls[1].url, calls[0].url)
    assert.equal(calls[1].init.body, calls[0].init.body)
    assert.deepEqual(calls.slice(0, 2).map((call) => new Headers(call.init.headers).get('If-Match')), [
      'W/"episode-version-1"',
      'W/"episode-version-1"',
    ])
    assert.deepEqual(calls.slice(0, 2).map((call) => new Headers(call.init.headers).get('Idempotency-Key')), [
      'preview-attempt-1',
      'preview-attempt-1',
    ])
    assert.deepEqual(calls.slice(0, 2).map((call) => new Headers(call.init.headers).get('x-manju-aigc-confirmation')), [
      null,
      confirmation.confirmationToken,
    ])
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      projectId: 'project-1',
      voiceId: 'cn-heroine',
      expectedCatalogFingerprint: FINGERPRINT,
    })

    const terminal = await getCharacterVoicePreviewJob(submitted.id)
    assert.equal(terminal.output?.asset.url, '/api/v1/assets/voice-preview-asset-1/content')
    const restored = await listCharacterVoicePreviewJobs('project-1')
    assert.equal(restored[0].id, submitted.id)
    assert.equal(restored[0].output?.asset.kind, 'character.voice.preview')
    assert.match(calls[3].url, /type=character\.voice\.preview/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('voice preview review is a separate zero-Provider audit request with strict response parsing', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  const review = {
    id: 'voice-review-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    subjectType: 'character',
    subjectId: 'ali',
    previewJobId: 'voice-preview-job-1',
    previewAssetId: 'voice-preview-asset-1',
    previewAssetChecksum: 'b'.repeat(64),
    voiceId: 'cn-heroine',
    providerId: 'minimax-speech',
    model: 'speech-2.8-hd',
    providerConfigRevision: 7,
    catalogFingerprint: FINGERPRINT,
    storyRevisionId: 'story-revision-1',
    decision: 'approve',
    notes: '符合角色。',
    playbackCompletedAt: NOW,
    playbackEvidence: {
      version: 'html-media-played-v1',
      durationSeconds: 2.268,
      ranges: [{ startSeconds: 0, endSeconds: 2.268 }],
    },
    reviewedAt: NOW,
    isCurrent: true,
    invalidReasons: [],
  }
  const responses = [
    Response.json({ review }, { status: 201 }),
    Response.json({ reviews: [review] }),
  ]
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init })
    const response = responses.shift()
    assert.ok(response)
    return response
  }) as typeof fetch
  try {
    const created = await createVoicePreviewReview('voice-preview-job-1', {
      projectId: 'project-1',
      decision: 'approve',
      playbackCompleted: true,
      playbackEvidence: review.playbackEvidence,
      notes: '符合角色。',
    }, 'voice-review-key-1')
    assert.equal(created.id, review.id)
    assert.equal(calls[0]?.url, '/api/v1/jobs/voice-preview-job-1/voice-preview-reviews')
    assert.equal(new Headers(calls[0]?.init.headers).get('Idempotency-Key'), 'voice-review-key-1')
    assert.equal(new Headers(calls[0]?.init.headers).get('x-manju-aigc-confirmation'), null)
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      projectId: 'project-1',
      decision: 'approve',
      playbackCompleted: true,
      playbackEvidence: review.playbackEvidence,
      notes: '符合角色。',
    })

    const restored = await listVoicePreviewReviews('voice-preview-job-1', 'project-1')
    assert.equal(restored[0]?.previewAssetChecksum, 'b'.repeat(64))
    assert.match(calls[1]?.url ?? '', /projectId=project-1/)

    responses.push(Response.json({
      reviews: [{
        ...review,
        playbackEvidence: {
          version: 'html-media-played-v1',
          durationSeconds: 2.268,
          ranges: [
            { startSeconds: 0, endSeconds: 0.5 },
            { startSeconds: 1.5, endSeconds: 2.268 },
          ],
        },
      }],
    }))
    await assert.rejects(
      () => listVoicePreviewReviews('voice-preview-job-1', 'project-1'),
      /格式不正确/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
