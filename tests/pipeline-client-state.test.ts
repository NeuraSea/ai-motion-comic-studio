import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CreatePipelineRunInput,
  PipelineRun,
  PipelineRunPreflightInput,
  ProviderConnection,
} from '../src/lib/api-types'
import {
  adoptPipelineRun,
  completePipelineAttempt,
  getOrCreatePipelineAttempt,
  isExecutablePipelineProvider,
  normalizePipelineCreateInput,
  pipelineErrorMessage,
  pipelinePreflightIsExpired,
  pipelinePreflightRemainingSeconds,
  pipelineRunContextKey,
  type PipelineRunContext,
} from '../src/features/pipeline/pipeline-client-state'

const context: PipelineRunContext = {
  projectId: 'project-1',
  episodeId: 'episode-1',
  sourceRevisionId: 'source-1',
}

const PREFLIGHT_EXPIRY = '2030-01-01T00:03:00.000Z'
const PREFLIGHT_EPOCH = Math.floor(Date.parse(PREFLIGHT_EXPIRY) / 1_000)
const confirmationToken = (mac: string) => `pfr1_${PREFLIGHT_EPOCH}_${mac.repeat(64)}`

function request(
  overrides: Partial<PipelineRunPreflightInput> = {},
): PipelineRunPreflightInput {
  return {
    projectId: context.projectId,
    resolution: '1080p',
    kenBurns: true,
    burnSubtitles: true,
    introTitle: true,
    outroCard: true,
    reviewWatermark: false,
    speechMode: 'auto',
    ...overrides,
  }
}

function pipelineRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'pipeline-1',
    ...context,
    status: 'running',
    progress: 20,
    version: 1,
    mode: 'dynamic-comic',
    options: {
      resolution: '1080p',
      kenBurns: true,
      burnSubtitles: true,
      introTitle: true,
      outroCard: true,
      reviewWatermark: false,
      speechMode: 'auto',
      defaultVoiceId: 'voice-1',
    },
    bindings: {},
    targets: { storyboard: [], speech: [] },
    steps: {
      storyboard: { status: 'succeeded', jobIds: [], completed: 0, total: 0 },
      speech: { status: 'succeeded', jobIds: [], completed: 0, total: 0 },
      timeline: { status: 'running' },
      export: { status: 'pending' },
      quality: { status: 'pending' },
    },
    error: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:01.000Z',
    completedAt: null,
    ...overrides,
  }
}

function provider(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: 'image-1',
    label: 'Image',
    kind: 'image',
    adapter: 'codex-tools',
    authMode: 'byoa',
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: 'gpt-image-2',
    capabilities: [],
    configurableBaseUrl: false,
    enabled: true,
    configRevision: 1,
    isDefault: true,
    credentialState: 'external',
    health: { status: 'untested', message: '' },
    ...overrides,
  }
}

test('pipeline idempotency retains every context and canonical intent until exact ack', () => {
  const attempts = new Map<string, string>()
  let sequence = 0
  const makeKey = () => `key-${++sequence}`
  const contextKey = pipelineRunContextKey(context)

  const firstA = getOrCreatePipelineAttempt(attempts, contextKey, request(), makeKey)
  const firstB = getOrCreatePipelineAttempt(
    attempts,
    contextKey,
    request({ resolution: '720p' }),
    makeKey,
  )
  const replayA = getOrCreatePipelineAttempt(attempts, contextKey, request(), makeKey)
  const anotherEpisode = getOrCreatePipelineAttempt(
    attempts,
    pipelineRunContextKey({ ...context, episodeId: 'episode-2' }),
    request(),
    makeKey,
  )

  assert.equal(firstA.idempotencyKey, 'key-1')
  assert.equal(firstB.idempotencyKey, 'key-2')
  assert.equal(replayA.idempotencyKey, firstA.idempotencyKey)
  assert.equal(anotherEpisode.idempotencyKey, 'key-3')
  assert.equal(attempts.size, 3)

  completePipelineAttempt(attempts, firstA)
  assert.equal(attempts.size, 2)
  assert.equal(
    getOrCreatePipelineAttempt(attempts, contextKey, request({ resolution: '720p' }), makeKey).idempotencyKey,
    firstB.idempotencyKey,
  )
})

test('pipeline caller intent never contains a raw voice or speech provider selector', () => {
  const normalized = normalizePipelineCreateInput({
    ...request({
    speechMode: 'skip',
    imageProviderId: 'image-1',
    }),
    confirmationToken: confirmationToken('a'),
  })
  assert.deepEqual(normalized, {
    projectId: 'project-1',
    resolution: '1080p',
    kenBurns: true,
    burnSubtitles: true,
    introTitle: true,
    outroCard: true,
    reviewWatermark: false,
    speechMode: 'skip',
    imageProviderId: 'image-1',
    confirmationToken: confirmationToken('a'),
  })
})

test('a refreshed preflight token reuses the exact caller-intent idempotency key', () => {
  const attempts = new Map<string, string>()
  const contextKey = pipelineRunContextKey(context)
  let sequence = 0
  const first = getOrCreatePipelineAttempt(attempts, contextKey, {
    ...request(),
    confirmationToken: confirmationToken('a'),
  }, () => `key-${++sequence}`)
  const afterAnotherPreflight = getOrCreatePipelineAttempt(attempts, contextKey, {
    ...request(),
    confirmationToken: confirmationToken('b'),
  }, () => `key-${++sequence}`)

  assert.equal(afterAnotherPreflight.idempotencyKey, first.idempotencyKey)
  assert.equal(attempts.size, 1)
})

test('pipeline preflight countdown reaches an irreversible local expiry boundary', () => {
  const expiresAtMs = Date.parse(PREFLIGHT_EXPIRY)
  assert.equal(
    pipelinePreflightRemainingSeconds({ expiresAt: PREFLIGHT_EXPIRY }, expiresAtMs - 90_001),
    91,
  )
  assert.equal(pipelinePreflightIsExpired({ expiresAt: PREFLIGHT_EXPIRY }, expiresAtMs - 1), false)
  assert.equal(pipelinePreflightRemainingSeconds({ expiresAt: PREFLIGHT_EXPIRY }, expiresAtMs), 0)
  assert.equal(pipelinePreflightIsExpired({ expiresAt: PREFLIGHT_EXPIRY }, expiresAtMs), true)
  assert.equal(pipelinePreflightRemainingSeconds({ expiresAt: null }, expiresAtMs), null)
  assert.equal(pipelinePreflightIsExpired({ expiresAt: null }, expiresAtMs), false)
})

test('pipeline adoption is context-bound, monotonic, and terminal-irreversible', () => {
  const scope = { context, runId: 'pipeline-1' }
  const current = pipelineRun()

  assert.equal(adoptPipelineRun(current, pipelineRun({ episodeId: 'episode-2' }), scope), current)
  assert.equal(adoptPipelineRun(current, pipelineRun({ id: 'pipeline-other' }), scope), current)
  assert.equal(adoptPipelineRun(current, pipelineRun({
    progress: 10,
    updatedAt: '2026-07-14T00:00:00.500Z',
  }), scope), current)

  const advanced = pipelineRun({ progress: 55, updatedAt: '2026-07-14T00:00:02.000Z' })
  assert.equal(adoptPipelineRun(current, advanced, scope), advanced)

  const cancelled = pipelineRun({
    status: 'cancelled',
    error: { code: 'PIPELINE_CANCELLED', message: 'cancelled' },
    updatedAt: '2026-07-14T00:00:03.000Z',
    completedAt: '2026-07-14T00:00:03.000Z',
  })
  assert.equal(adoptPipelineRun(advanced, cancelled, scope), cancelled)
  assert.equal(adoptPipelineRun(cancelled, pipelineRun({
    progress: 90,
    updatedAt: '2026-07-14T00:00:04.000Z',
  }), scope), cancelled)
})

test('an older list response cannot replace a newer run in the same context', () => {
  const newer = pipelineRun({
    id: 'pipeline-2',
    createdAt: '2026-07-14T00:01:00.000Z',
    updatedAt: '2026-07-14T00:01:00.000Z',
  })
  const older = pipelineRun({ id: 'pipeline-1' })
  assert.equal(adoptPipelineRun(newer, older, { context }), newer)
  assert.equal(adoptPipelineRun(older, newer, { context }), newer)
})

test('provider executability and pipeline error copy mirror server admission rules', () => {
  assert.equal(isExecutablePipelineProvider(provider(), 'image'), true)
  assert.equal(isExecutablePipelineProvider(provider({ credentialState: 'missing' }), 'image'), false)
  assert.equal(isExecutablePipelineProvider(provider({ adapter: 'seedance' }), 'image'), false)
  assert.equal(isExecutablePipelineProvider(provider({
    id: 'speech-1',
    kind: 'speech',
    adapter: 'minimax',
    authMode: 'byok',
    credentialState: 'present',
  }), 'speech'), true)
  assert.match(pipelineErrorMessage('AUDIO_REQUIRED', 'English upstream copy', 'fallback'), /BGM/)
  assert.equal(pipelineErrorMessage('UNKNOWN', 'durable detail', 'fallback'), 'durable detail')
})
