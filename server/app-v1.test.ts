import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationOptions, type ApplicationRuntime } from './app.js'
import type { KeychainCredentialSlot } from './keychain.js'
import type { ProviderCredentialStore } from './providers/service.js'
import {
  resolvePublicShotVideoTarget,
  SHOT_VIDEO_GENERATION_JOB_TYPE,
} from './shot-video-generation.js'
import { resolveShotVideoDuration } from './shot-video-duration.js'
import { createShotVideoTimingRemediation } from './shot-video-timing-remediation.js'
import { StoryRepository } from './story-repository.js'
import type { StoryDocument } from './story-schema.js'
import type {
  ImageGenerationInput,
  ImageProvider,
  JsonObject,
  ProviderImage,
  ProviderImageReference,
} from './types.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

class FixtureImageProvider implements ImageProvider {
  readonly name = 'fixture-image'
  readonly model = 'fixture-image-model'
  readonly configured = true
  readonly supportsImageReferences = true
  calls = 0
  referenceCounts: number[] = []
  beforeResponse?: (input: ImageGenerationInput) => Promise<void>

  async health() {
    return { status: 'ok' as const, message: 'fixture ready' }
  }

  async generate(
    input: ImageGenerationInput,
    _signal?: AbortSignal,
    references: readonly ProviderImageReference[] = [],
  ): Promise<ProviderImage[]> {
    this.calls += 1
    this.referenceCounts.push(references.length)
    await this.beforeResponse?.(input)
    return Array.from({ length: input.count }, () => ({
      bytes: ONE_PIXEL_PNG,
      mimeType: 'image/png',
      revisedPrompt: input.prompt,
    }))
  }
}

class MemoryCredentialStore implements ProviderCredentialStore {
  readonly values = new Map<string, string>()

  private key(slot: KeychainCredentialSlot): string {
    return `${slot.providerId}:${slot.credentialKind ?? 'api-key'}`
  }

  async get(slot: KeychainCredentialSlot): Promise<string | null> {
    return this.values.get(this.key(slot)) ?? null
  }

  async set(slot: KeychainCredentialSlot, secret: string): Promise<void> {
    this.values.set(this.key(slot), secret)
  }

  async delete(slot: KeychainCredentialSlot): Promise<boolean> {
    return this.values.delete(this.key(slot))
  }

  async exists(slot: KeychainCredentialSlot): Promise<boolean> {
    return this.values.has(this.key(slot))
  }
}

interface RunningFixture {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
  provider: FixtureImageProvider
  credentials: MemoryCredentialStore
}

const fixtures: RunningFixture[] = []

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return `http://127.0.0.1:${address.port}`
}

async function fixture(
  options: Pick<
    ApplicationOptions,
    | 'miniMaxVoiceCatalogFetch'
    | 'textCompatibleFetch'
    | 'providerProbe'
    | 'enforcePaidAigcConfirmation'
    | 'paidAigcConfirmationNow'
    | 'autoStartWorker'
    | 'maxQueueDepth'
  > = {},
): Promise<RunningFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-app-v1-test-'))
  const provider = new FixtureImageProvider()
  const credentials = new MemoryCredentialStore()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider,
    keychain: credentials,
    loadByoaCredential: async (id) => id.startsWith('codex-tools') ? 'fixture-byoa' : null,
    hasByoaCredential: async (id) => id.startsWith('codex-tools'),
    enforcePaidAigcConfirmation: false,
    ...options,
  })
  const server = createServer(runtime.app)
  const running = { directory, runtime, server, baseUrl: await listen(server), provider, credentials }
  fixtures.push(running)
  return running
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await new Promise<void>((resolve, reject) => item.server.close((error) => error ? reject(error) : resolve()))
    await item.runtime.close()
    await rm(item.directory, { recursive: true, force: true })
  }
})

test('generic retry endpoint follows the public server-authored fee disposition', async () => {
  const { baseUrl, runtime, provider } = await fixture({ autoStartWorker: false })
  const createFailed = (input: {
    id: string
    type: string
    providerId?: string
    model?: string
    providerConfigRevision?: number
    externalTaskId?: string
    providerState?: JsonObject
    error?: JsonObject
  }) => runtime.database.createGenerationJob({
    id: input.id,
    projectId: 'default',
    type: input.type,
    status: 'failed',
    resourceType: input.type === 'shot.video.generate' ? 'provider:video' : null,
    resourceId: input.type === 'shot.video.generate' ? `shot-${input.id}` : null,
    providerId: input.providerId ?? null,
    model: input.model ?? null,
    providerConfigRevision: input.providerConfigRevision ?? null,
    externalTaskId: input.externalTaskId ?? null,
    idempotencyKey: `source:${input.id}`,
    input: {},
    providerState: input.providerState,
    error: input.error ?? {
      code: 'UPSTREAM_TIMEOUT',
      message: '上游超时',
      retryable: true,
      category: 'timeout',
    },
  })
  const get = (id: string) => json<{ job: { retryDisposition: string } }>(
    `${baseUrl}/api/v1/jobs/${id}`,
  )
  const retry = (id: string) => json<{
    job?: { id: string; retryOf: string; retryDisposition: string }
    error?: { code: string }
  }>(`${baseUrl}/api/v1/jobs/${id}/retry`, {
    method: 'POST',
    headers: { 'idempotency-key': `retry:${id}` },
  })

  const free = createFailed({
    id: 'retry-free-story',
    type: 'story.generate',
    providerId: 'codex-tools-text',
    model: 'gpt-5.5',
    providerConfigRevision: 1,
  })
  assert.equal((await get(free.id)).body.job.retryDisposition, 'generic-free-retry')
  const freeRetry = await retry(free.id)
  assert.equal(freeRetry.response.status, 202)
  assert.equal(freeRetry.body.job?.retryOf, free.id)

  for (const item of [
    {
      id: 'retry-paid-image',
      type: 'asset.image.generate',
      providerId: 'codex-tools-image',
      model: 'gpt-image-2',
    },
    {
      id: 'retry-paid-speech',
      type: 'dialogue.speech.generate',
      providerId: 'minimax-speech',
      model: 'speech-2.8-hd',
    },
  ]) {
    const paid = createFailed({ ...item, providerConfigRevision: 1 })
    assert.equal((await get(paid.id)).body.job.retryDisposition, 'paid-reconfirmation-required')
    const countBefore = runtime.database.listGenerationJobs({ projectId: 'default' }).length
    const rejected = await retry(paid.id)
    assert.equal(rejected.response.status, 409)
    assert.equal(rejected.body.error?.code, 'JOB_PAID_RECONFIRMATION_REQUIRED')
    assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, countBefore)
  }

  const videoWithoutTask = createFailed({
    id: 'retry-video-without-task',
    type: 'shot.video.generate',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
  })
  assert.equal((await get(videoWithoutTask.id)).body.job.retryDisposition, 'paid-reconfirmation-required')
  const videoWithoutTaskRetry = await retry(videoWithoutTask.id)
  assert.equal(videoWithoutTaskRetry.response.status, 409)
  assert.equal(videoWithoutTaskRetry.body.error?.code, 'JOB_PAID_RECONFIRMATION_REQUIRED')

  const videoWithTask = createFailed({
    id: 'retry-video-with-task',
    type: 'shot.video.generate',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    externalTaskId: 'seedance-existing-task',
    providerState: {
      operation: 'shot.video.generate',
      phase: 'polling',
      externalTaskId: 'seedance-existing-task',
      lastStatus: 'running',
    },
  })
  assert.equal((await get(videoWithTask.id)).body.job.retryDisposition, 'resume-existing-provider-task')
  const resumed = await retry(videoWithTask.id)
  assert.equal(resumed.response.status, 202)
  assert.equal(resumed.body.job?.retryOf, videoWithTask.id)

  const cancelledVideo = runtime.database.createGenerationJob({
    id: 'retry-cancelled-video-with-task',
    projectId: 'default',
    type: 'shot.video.generate',
    status: 'cancelled',
    resourceType: 'provider:video',
    resourceId: 'shot-retry-cancelled-video-with-task',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    externalTaskId: 'seedance-cancelled-existing-task',
    idempotencyKey: 'source:retry-cancelled-video-with-task',
    input: {},
    providerState: {
      operation: 'shot.video.generate',
      phase: 'polling',
      externalTaskId: 'seedance-cancelled-existing-task',
      lastStatus: 'running',
      cancellationCapability: 'local-only',
      cancellationOutcome: 'unsupported',
    },
    error: {
      code: 'JOB_CANCELLED',
      message: '本地处理已停止',
      retryable: false,
      category: 'cancelled',
    },
  })
  assert.equal((await get(cancelledVideo.id)).body.job.retryDisposition, 'resume-existing-provider-task')
  const resumedCancelled = await retry(cancelledVideo.id)
  assert.equal(resumedCancelled.response.status, 202)
  assert.equal(resumedCancelled.body.job?.retryOf, cancelledVideo.id)
  const replayedCancelled = await retry(cancelledVideo.id)
  assert.equal(replayedCancelled.response.status, 200)
  assert.equal(replayedCancelled.body.job?.id, resumedCancelled.body.job?.id)

  const unknown = createFailed({
    id: 'retry-video-unknown',
    type: 'shot.video.generate',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    providerState: {
      operation: 'shot.video.generate',
      phase: 'submitting',
      clientRequestId: 'retry-video-unknown',
    },
    error: {
      code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
      message: '提交结果不明',
      retryable: false,
      category: 'provider',
    },
  })
  assert.equal((await get(unknown.id)).body.job.retryDisposition, 'manual-resolution')
  const unknownRetry = await retry(unknown.id)
  assert.equal(unknownRetry.response.status, 409)
  assert.equal(unknownRetry.body.error?.code, 'JOB_MANUAL_RESOLUTION_REQUIRED')

  assert.equal(provider.calls, 0, 'retry policy tests must not invoke a paid Provider')
})

test('job DTO exposes only a strict public STALE_AUDIO_TIMING remediation projection', async () => {
  const { baseUrl, runtime } = await fixture({ autoStartWorker: false })
  const story = persistedStory(runtime, { episodeId: 'timing-remediation-episode' })
  const target = resolvePublicShotVideoTarget(runtime.database, {
    projectId: 'default',
    episodeId: story.episodeId,
    shotId: 'shot-1',
    sceneId: 'scene-1',
  })
  const resolved = resolveShotVideoDuration(runtime.database, target)
  assert.equal(resolved.status, 'ready')
  if (resolved.status !== 'ready') throw new Error('expected a ready duration fixture')
  const previousDecision = {
    ...resolved.decision,
    plannedDurationSeconds: 6,
    timelineDurationSeconds: 6,
    providerDurationSeconds: 6,
  }
  const timingRemediation = createShotVideoTimingRemediation(runtime.database, {
    target,
    sceneId: 'scene-1',
    previousDecision,
    checkpoint: 'initial',
    providerSubmissionState: 'not-started',
    detectedAt: '2026-07-15T00:00:00.000Z',
  })
  const input: JsonObject = {
    durationDecision: previousDecision as unknown as JsonObject,
    binding: {
      episodeId: story.episodeId,
      shotId: 'shot-1',
      sceneId: 'scene-1',
      databaseShotId: target.databaseShotId,
      expectedRevisionId: story.revisionId,
      expectedPreviousVideoAssetId: null,
    },
  }
  const valid = runtime.database.createGenerationJob({
    id: 'public-timing-remediation-valid',
    projectId: 'default',
    episodeId: story.episodeId,
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'failed',
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    idempotencyKey: 'public-timing-remediation-valid',
    input,
    providerState: {
      timingRemediation: timingRemediation as unknown as JsonObject,
    },
    error: {
      code: 'STALE_AUDIO_TIMING',
      message: '音频时长合同已变更',
      retryable: false,
      category: 'validation',
    },
  })
  const publicValid = await json<{
    job: { retryDisposition: string; timingRemediation?: JsonObject }
  }>(`${baseUrl}/api/v1/jobs/${valid.id}`)
  assert.equal(publicValid.response.status, 200)
  assert.equal(publicValid.body.job.retryDisposition, 'paid-reconfirmation-required')
  assert.deepEqual(publicValid.body.job.timingRemediation, timingRemediation)

  const unknownAncestor = runtime.database.createGenerationJob({
    id: 'public-timing-remediation-unknown-ancestor',
    projectId: 'default',
    episodeId: story.episodeId,
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'failed',
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    idempotencyKey: 'public-timing-remediation-unknown-ancestor',
    input,
    providerState: {
      operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
      phase: 'submitting',
    },
    error: {
      code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
      message: '原提交结果不明',
      retryable: false,
      category: 'provider',
    },
  })
  const manualLineage = runtime.database.createGenerationJob({
    id: 'public-timing-remediation-manual-lineage',
    projectId: 'default',
    episodeId: story.episodeId,
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'failed',
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    idempotencyKey: 'public-timing-remediation-manual-lineage',
    retryOf: unknownAncestor.id,
    attempt: 2,
    input,
    providerState: {
      timingRemediation: timingRemediation as unknown as JsonObject,
    },
    error: {
      code: 'STALE_AUDIO_TIMING',
      message: '当前节点有完整证据，但重试祖先提交结果不明',
      retryable: false,
      category: 'validation',
    },
  })
  const publicManualLineage = await json<{
    job: { retryDisposition: string; timingRemediation?: JsonObject }
  }>(`${baseUrl}/api/v1/jobs/${manualLineage.id}`)
  assert.equal(publicManualLineage.response.status, 200)
  assert.equal(publicManualLineage.body.job.retryDisposition, 'manual-resolution')
  assert.equal(
    publicManualLineage.body.job.timingRemediation,
    undefined,
    'manual isolation must not expose an actionable paid recovery payload',
  )

  const forged = runtime.database.createGenerationJob({
    id: 'public-timing-remediation-forged',
    projectId: 'default',
    episodeId: story.episodeId,
    type: SHOT_VIDEO_GENERATION_JOB_TYPE,
    status: 'failed',
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    idempotencyKey: 'public-timing-remediation-forged',
    input,
    providerState: {
      operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
      phase: 'submitting',
      timingRemediation: {
        ...(timingRemediation as unknown as JsonObject),
        privateProviderPayload: 'must-not-be-projected',
      },
    },
    error: {
      code: 'STALE_AUDIO_TIMING',
      message: '音频时长合同已变更',
      retryable: false,
      category: 'validation',
    },
  })
  const publicForged = await json<{
    job: { retryDisposition: string; timingRemediation?: JsonObject }
  }>(`${baseUrl}/api/v1/jobs/${forged.id}`)
  assert.equal(publicForged.response.status, 200)
  assert.equal(publicForged.body.job.retryDisposition, 'manual-resolution')
  assert.equal(publicForged.body.job.timingRemediation, undefined)
  assert.equal(JSON.stringify(publicForged.body).includes('must-not-be-projected'), false)
})

test('v1 retry replays its existing child even when that child fills the queue', async () => {
  const { baseUrl, runtime } = await fixture({ autoStartWorker: false, maxQueueDepth: 1 })
  const source = runtime.database.createGenerationJob({
    id: 'retry-replay-source',
    projectId: 'default',
    type: 'story.generate',
    status: 'failed',
    resourceType: 'provider:text',
    providerId: 'codex-tools-text',
    model: 'gpt-5.5',
    providerConfigRevision: 1,
    idempotencyKey: 'retry-replay-source',
    input: {},
    error: {
      code: 'UPSTREAM_TIMEOUT',
      message: '上游超时',
      retryable: true,
      category: 'timeout',
    },
  })
  const retry = (key: string) => json<{ job?: { id: string }; error?: { code: string } }>(
    `${baseUrl}/api/v1/jobs/${source.id}/retry`,
    { method: 'POST', headers: { 'idempotency-key': key } },
  )

  const created = await retry('retry-replay-first')
  assert.equal(created.response.status, 202)
  assert.ok(created.body.job?.id)
  assert.equal(runtime.database.listGenerationJobs({ status: 'queued' }).length, 1)

  const replay = await retry('retry-replay-second-key-is-ignored-by-linear-lineage')
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.job?.id, created.body.job?.id)
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 2)
})

test('cancelled Seedance resume replays its polling child even when the queue is full', async () => {
  const { baseUrl, runtime } = await fixture({ autoStartWorker: false, maxQueueDepth: 1 })
  const source = runtime.database.createGenerationJob({
    id: 'cancelled-video-replay-source',
    projectId: 'default',
    type: 'shot.video.generate',
    status: 'cancelled',
    resourceType: 'provider:video',
    resourceId: 'cancelled-video-shot',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 1,
    externalTaskId: 'cancelled-video-provider-task',
    idempotencyKey: 'cancelled-video-replay-source',
    input: {},
    providerState: {
      operation: 'shot.video.generate',
      phase: 'polling',
      externalTaskId: 'cancelled-video-provider-task',
      lastStatus: 'running',
      cancellationCapability: 'upstream-delete',
      cancellationOutcome: 'request-failed',
    },
    error: {
      code: 'JOB_CANCELLED',
      message: '本地处理已停止',
      retryable: false,
      category: 'cancelled',
    },
  })
  const retry = (key: string) => json<{ job?: { id: string }; error?: { code: string } }>(
    `${baseUrl}/api/v1/jobs/${source.id}/retry`,
    { method: 'POST', headers: { 'idempotency-key': key } },
  )

  const created = await retry('cancelled-video-resume-first')
  assert.equal(created.response.status, 202)
  assert.equal(runtime.database.listGenerationJobs({ status: 'queued' }).length, 1)

  const replay = await retry('cancelled-video-resume-replay')
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.job?.id, created.body.job?.id)
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 2)
})

test('image generation requires an exact signed paid confirmation before creating a Job', async () => {
  let now = new Date('2026-07-15T00:00:00.000Z')
  const { baseUrl, provider, runtime } = await fixture({
    enforcePaidAigcConfirmation: true,
    paidAigcConfirmationNow: () => now,
  })
  const path = `${baseUrl}/api/v1/assets/image-generations`
  const body = {
    projectId: 'default',
    input: {
      prompt: '一张需要明确确认的国风场景图',
      size: '1024x1024',
      quality: 'medium',
      count: 1,
    },
  }
  const key = 'paid-image-generate-v1'
  const submit = (requestBody: unknown, idempotency = key, confirmation?: string) => json<{
    error?: {
      code: string
      details?: { confirmation?: { action: string; confirmationToken: string; expiresAt: string } }
    }
    job?: { id: string }
  }>(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotency,
      ...(confirmation ? { 'x-manju-aigc-confirmation': confirmation } : {}),
    },
    body: JSON.stringify(requestBody),
  })

  const preflight = await submit(body)
  assert.equal(preflight.response.status, 409)
  assert.equal(preflight.body.error?.code, 'PAID_CONFIRMATION_REQUIRED')
  assert.equal(preflight.body.error?.details?.confirmation?.action, 'asset.image.generate')
  assert.equal(provider.calls, 0)
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 0)
  const firstToken = preflight.body.error?.details?.confirmation?.confirmationToken
  assert.ok(firstToken)

  const wrongKey = await submit(body, 'paid-image-generate-other-key', firstToken)
  assert.equal(wrongKey.response.status, 409)
  assert.equal(wrongKey.body.error?.code, 'PAID_CONFIRMATION_REQUIRED')
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 0)

  now = new Date('2026-07-15T00:06:00.000Z')
  const expired = await submit(body, key, firstToken)
  assert.equal(expired.response.status, 409)
  assert.equal(expired.body.error?.code, 'PAID_CONFIRMATION_REQUIRED')
  const refreshedToken = expired.body.error?.details?.confirmation?.confirmationToken
  assert.ok(refreshedToken)
  assert.notEqual(refreshedToken, firstToken)
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 0)

  const confirmed = await submit(body, key, refreshedToken)
  assert.equal(confirmed.response.status, 202)
  assert.ok(confirmed.body.job?.id)
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 1)

  const replay = await submit(body, key)
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.job?.id, confirmed.body.job?.id)
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 1)

  const drift = await submit({
    ...body,
    input: { ...body.input, prompt: '相同 Key 的不同提示词' },
  }, key)
  assert.equal(drift.response.status, 409)
  assert.equal(drift.body.error?.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 1)

  const legacy = await json<{ error: { code: string } }>(`${baseUrl}/api/images/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body.input),
  })
  assert.equal(legacy.response.status, 410)
  assert.equal(legacy.body.error.code, 'LEGACY_API_REMOVED')
})

async function json<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init)
  return { response, body: await response.json() as T }
}

async function terminalJob(baseUrl: string, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await json<{ job: Record<string, unknown> }>(`${baseUrl}/api/v1/jobs/${id}`)
    if (['succeeded', 'failed', 'cancelled'].includes(String(result.body.job.status))) return result.body.job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Job did not finish: ${id}`)
}

async function episodeEtag(baseUrl: string, episodeId: string): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/v1/episodes/${episodeId}?projectId=default`,
  )
  assert.equal(response.status, 200)
  const etag = response.headers.get('etag')
  assert.ok(etag)
  await response.body?.cancel()
  return etag
}

function validGeneratedStory(title: string): StoryDocument {
  return {
    version: 1,
    title,
    targetDurationSeconds: 30,
    bible: {
      logline: '少女在断崖听见龙吟。',
      theme: '责任',
      tone: '紧张',
      visualStyle: '国风动画，16:9 电影构图',
    },
    characters: [{
      id: 'ali',
      name: '阿离',
      role: '主角',
      storyDescription: '年轻剑客',
      visualDescription: '黑色长发、红绳、青色圆领袍',
    }],
    locations: [{
      id: 'cliff',
      name: '断崖',
      storyDescription: '长安城外',
      visualDescription: '云海与落日，青黑色山石',
    }],
    props: [{
      id: 'token',
      name: '青铜令',
      description: '唤醒龙脉',
      visualDescription: '暗红纹路的六边形青铜令',
    }],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '断崖龙吟',
      locationId: 'cliff',
      timeOfDay: '黄昏',
      description: '龙脉苏醒',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `镜头 ${index + 1}`,
        description: '阿离在风中看向云海。',
        framing: '中景',
        movement: '缓慢推进',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '国风动画，阿离黑发红绳青袍，断崖黄昏云海，电影构图。',
        dialogueLines: index === 2 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue',
          speaker: '阿离',
          text: '它醒了。',
        }] : [],
      })),
    }],
  }
}

function persistedStory(
  runtime: ApplicationRuntime,
  options: { episodeId?: string; story?: StoryDocument } = {},
): { episodeId: string; revisionId: string; story: StoryDocument } {
  const episodeId = options.episodeId ?? 'storyboard-episode'
  const story = options.story ?? validGeneratedStory('龙脉初醒')
  runtime.storyRepository.ensureEpisode('default', { id: episodeId, title: story.title })
  const project = runtime.database.getProject('default')
  assert.ok(project)
  const revision = runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: project.currentRevisionId,
    summary: '分镜图片测试剧本',
    snapshot: structuredClone(story) as unknown as JsonObject,
  })
  runtime.storyRepository.applyStory(episodeId, story, revision.id)
  return { episodeId, revisionId: revision.id, story }
}

async function bindCurrentCharacterViewSlots(
  runtime: ApplicationRuntime,
  storyFixture: { episodeId: string; revisionId: string },
  prefix: string,
): Promise<Record<'front' | 'side' | 'back', string>> {
  const characterRow = runtime.database.withSql((sql) => sql.get(`
    SELECT id FROM characters
    WHERE episode_id = ? AND json_extract(metadata_json, '$.storyId') = 'ali'
  `, storyFixture.episodeId))
  assert.equal(typeof characterRow?.id, 'string')

  const audit = runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: runtime.database.getProject('default')?.currentRevisionId,
    summary: '测试锁定当前角色三视图槽位',
    snapshot: { version: 1, kind: 'character.visual-references.lock' },
  })
  const assetIds: Record<'front' | 'side' | 'back', string> = {
    front: '',
    side: '',
    back: '',
  }
  for (const [index, view] of (['front', 'side', 'back'] as const).entries()) {
    const asset = await runtime.mediaStore.save({
      id: `${prefix}-${view}`,
      projectId: 'default',
      episodeId: storyFixture.episodeId,
      kind: `character-turnaround-${view}`,
      version: index + 1,
      bytes: ONE_PIXEL_PNG,
      mimeType: 'image/png',
      source: 'fixture-derived-slot',
      sourceRevisionId: storyFixture.revisionId,
    })
    assetIds[view] = asset.id
    runtime.database.withSql((sql) => sql.run(`
      INSERT INTO character_visual_references (
        character_id, project_id, episode_id, role, asset_id, version,
        audit_revision_id, updated_at
      ) VALUES (?, 'default', ?, ?, ?, 1, ?, ?)
    `, String(characterRow?.id), storyFixture.episodeId, view, asset.id, audit.id, new Date().toISOString()))
  }
  runtime.database.withSql((sql) => sql.run(`
    UPDATE shots
    SET description = '阿离正面面向镜头，站在断崖上',
        prompt = '阿离正面面向镜头，断崖云海'
    WHERE scene_id IN (SELECT id FROM scenes WHERE episode_id = ?)
      AND json_extract(metadata_json, '$.storyId') = 'shot-1'
  `, storyFixture.episodeId))
  return assetIds
}

test('timeline document API enforces ETags, ownership, and immutable history', async () => {
  const { baseUrl, runtime } = await fixture()
  const sourceRevisionId = runtime.database.getProject('default')?.currentRevisionId
  assert.ok(sourceRevisionId)
  new StoryRepository(runtime.database).ensureEpisode('default', {
    id: 'timeline-episode',
    title: '时间线测试',
  })
  runtime.database.withSql((sql) => sql.run(
    'UPDATE episodes SET source_revision_id = ? WHERE id = ?',
    sourceRevisionId,
    'timeline-episode',
  ))

  const missing = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/episodes/timeline-episode/timeline-document`,
  )
  assert.equal(missing.response.status, 404)
  assert.equal(missing.body.error.code, 'TIMELINE_DOCUMENT_NOT_FOUND')

  const initialBody = {
    projectId: 'default',
    schemaVersion: 1,
    upstreamCommit: 'cf5e79e919144200294fb9fed22a222592a0aeea',
    summary: 'Initial OpenCut timeline',
    document: {
      tracks: [],
      unknownUpstreamExtension: {
        effect: 'preserve-me',
        values: [1, true, null],
      },
    },
  }
  const noPrecondition = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/episodes/timeline-episode/timeline-document`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(initialBody),
    },
  )
  assert.equal(noPrecondition.response.status, 428)
  assert.equal(noPrecondition.body.error.code, 'PRECONDITION_REQUIRED')

  const created = await json<{
    timelineDocument: { id: string; projectId: string; episodeId: string; currentRevisionId: string }
    revision: { id: string; sourceRevisionId: string | null; snapshot: Record<string, unknown> }
    document: Record<string, unknown>
    created: boolean
  }>(`${baseUrl}/api/v1/episodes/timeline-episode/timeline-document`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': '*' },
    body: JSON.stringify(initialBody),
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.created, true)
  assert.equal(created.body.timelineDocument.projectId, 'default')
  assert.equal(created.body.timelineDocument.episodeId, 'timeline-episode')
  assert.equal(created.body.revision.sourceRevisionId, null)
  assert.deepEqual(created.body.document, initialBody.document)
  const firstEtag = created.response.headers.get('etag')
  assert.ok(firstEtag)

  const loaded = await json<{ document: Record<string, unknown> }>(
    `${baseUrl}/api/v1/episodes/timeline-episode/timeline-document`,
  )
  assert.equal(loaded.response.status, 200)
  assert.equal(loaded.response.headers.get('etag'), firstEtag)
  assert.deepEqual(loaded.body.document, initialBody.document)

  const nextDocument = {
    tracks: [{ id: 'main', elements: [{ id: 'clip-1', assetId: 'asset-1' }] }],
    unknownUpstreamExtension: { effect: 'still-preserved', future: { mode: 9 } },
  }
  const updated = await json<{
    timelineDocument: { currentRevisionId: string }
    revision: { id: string; parentRevisionId: string }
    document: Record<string, unknown>
  }>(`${baseUrl}/api/v1/episodes/timeline-episode/timeline-document`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': firstEtag! },
    body: JSON.stringify({ ...initialBody, summary: 'Move clip', document: nextDocument }),
  })
  assert.equal(updated.response.status, 200)
  assert.equal(updated.body.revision.parentRevisionId, created.body.revision.id)
  assert.deepEqual(updated.body.document, nextDocument)
  const secondEtag = updated.response.headers.get('etag')
  assert.ok(secondEtag)
  assert.notEqual(secondEtag, firstEtag)

  const stale = await json<{ error: { code: string; details: { currentRevisionId: string } } }>(
    `${baseUrl}/api/v1/episodes/timeline-episode/timeline-document`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': firstEtag! },
      body: JSON.stringify({ ...initialBody, document: { tracks: [{ id: 'must-not-win' }] } }),
    },
  )
  assert.equal(stale.response.status, 412)
  assert.equal(stale.body.error.code, 'TIMELINE_DOCUMENT_CONFLICT')
  assert.equal(stale.body.error.details.currentRevisionId, updated.body.revision.id)

  const wrongProject = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/episodes/timeline-episode/timeline-document`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': secondEtag! },
      body: JSON.stringify({ ...initialBody, projectId: 'another-project' }),
    },
  )
  assert.equal(wrongProject.response.status, 409)
  assert.equal(wrongProject.body.error.code, 'EPISODE_PROJECT_MISMATCH')

  const history = await json<{
    etag: string
    revisions: Array<{ id: string; parentRevisionId: string | null; snapshot: Record<string, unknown> }>
  }>(`${baseUrl}/api/v1/timeline-documents/${created.body.timelineDocument.id}/revisions`)
  assert.equal(history.response.status, 200)
  assert.equal(history.response.headers.get('etag'), secondEtag)
  assert.equal(history.body.etag, secondEtag)
  assert.deepEqual(history.body.revisions.map((revision) => revision.id), [
    updated.body.revision.id,
    created.body.revision.id,
  ])
  assert.deepEqual(history.body.revisions[1].snapshot, initialBody.document)

  const restoreEndpoint = `${baseUrl}/api/v1/episodes/timeline-episode/timeline-document/revisions/${created.body.revision.id}/restore`
  const restored = await json<{
    timeline: { revision: { id: string; parentRevisionId: string }; document: Record<string, unknown> }
    operationResultTimeline: { revision: { id: string } }
    restore: { baseRevisionId: string; targetRevisionId: string; resultRevisionId: string }
    headAdvanced: boolean
    idempotent: boolean
  }>(restoreEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': secondEtag!,
      'idempotency-key': 'timeline-http-restore-1',
    },
    body: JSON.stringify({
      projectId: 'default',
      documentId: created.body.timelineDocument.id,
      summary: '人工恢复初版',
    }),
  })
  assert.equal(restored.response.status, 201)
  assert.equal(restored.body.idempotent, false)
  assert.equal(restored.body.headAdvanced, false)
  assert.equal(restored.body.timeline.revision.parentRevisionId, updated.body.revision.id)
  assert.deepEqual(restored.body.timeline.document, initialBody.document)
  assert.equal(restored.body.restore.baseRevisionId, updated.body.revision.id)
  assert.equal(restored.body.restore.targetRevisionId, created.body.revision.id)
  assert.equal(restored.body.restore.resultRevisionId, restored.body.timeline.revision.id)
  assert.equal(
    restored.body.operationResultTimeline.revision.id,
    restored.body.timeline.revision.id,
  )
  const restoredEtag = restored.response.headers.get('etag')
  assert.ok(restoredEtag)

  const replay = await json<{ idempotent: boolean; headAdvanced: boolean; restore: { resultRevisionId: string } }>(
    restoreEndpoint,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': secondEtag!,
        'idempotency-key': 'timeline-http-restore-1',
      },
      body: JSON.stringify({
        projectId: 'default',
        documentId: created.body.timelineDocument.id,
        summary: '人工恢复初版',
      }),
    },
  )
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.idempotent, true)
  assert.equal(replay.body.headAdvanced, false)
  assert.equal(replay.body.restore.resultRevisionId, restored.body.timeline.revision.id)

  const staleRestore = await json<{ error: { code: string; details: { currentRevisionId: string } } }>(
    restoreEndpoint,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': secondEtag!,
        'idempotency-key': 'timeline-http-restore-stale',
      },
      body: JSON.stringify({ projectId: 'default', documentId: created.body.timelineDocument.id }),
    },
  )
  assert.equal(staleRestore.response.status, 412)
  assert.equal(staleRestore.body.error.code, 'TIMELINE_DOCUMENT_CONFLICT')
  assert.equal(staleRestore.body.error.details.currentRevisionId, restored.body.timeline.revision.id)

  for (const operation of ['materialize', 'reconcile'] as const) {
    const unsupported = await json<{ error: { code: string } }>(
      `${baseUrl}/api/v1/episodes/timeline-episode/timeline-document/${operation}`,
      { method: 'POST' },
    )
    assert.equal(unsupported.response.status, 428)
    assert.equal(unsupported.body.error.code, 'PRECONDITION_REQUIRED')
  }
})

test('timeline materialize and reconcile routes expose real optimistic story-to-editor operations', async () => {
  const { baseUrl, runtime } = await fixture()
  const persisted = persistedStory(runtime, { episodeId: 'timeline-materialize-episode' })
  const endpoint = `${baseUrl}/api/v1/episodes/${persisted.episodeId}/timeline-document`

  const created = await json<{
    timelineDocument: { projectId: string; sourceRevisionId: string; upstreamCommit: string }
    revision: { id: string; sourceRevisionId: string }
    document: { tracks: { overlay: Array<{ elements: Array<{ params: { storyShotId: string } }> }> } }
    report: { operation: string; changed: boolean; appendedShots: Array<{ shotId: string }> }
  }>(`${endpoint}/materialize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': '*' },
    body: JSON.stringify({ projectId: 'default' }),
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.timelineDocument.projectId, 'default')
  assert.equal(created.body.timelineDocument.sourceRevisionId, persisted.revisionId)
  assert.equal(created.body.revision.sourceRevisionId, persisted.revisionId)
  assert.equal(created.body.report.operation, 'materialize')
  assert.equal(created.body.report.changed, true)
  assert.equal(created.body.report.appendedShots.length, 6)
  assert.deepEqual(
    created.body.document.tracks.overlay[0].elements.map((element) => element.params.storyShotId),
    persisted.story.scenes[0].shots.map((shot) => shot.id),
  )
  const materializedEtag = created.response.headers.get('etag')
  assert.ok(materializedEtag)

  const crossProject = await json<{ error: { code: string } }>(`${endpoint}/reconcile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': materializedEtag },
    body: JSON.stringify({ projectId: 'another-project' }),
  })
  assert.equal(crossProject.response.status, 409)
  assert.equal(crossProject.body.error.code, 'EPISODE_PROJECT_MISMATCH')

  const storyUpdate = runtime.storyRepository.updateShot(
    persisted.episodeId,
    'shot-1',
    { durationSeconds: 6 },
  )
  const forged = await json<{ error: { code: string } }>(endpoint, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': materializedEtag },
    body: JSON.stringify({
      projectId: 'default',
      schemaVersion: 2,
      upstreamCommit: created.body.timelineDocument.upstreamCommit,
      sourceRevisionId: storyUpdate.revision.id,
      document: created.body.document,
    }),
  })
  assert.equal(forged.response.status, 400)
  assert.equal(forged.body.error.code, 'INVALID_REQUEST')

  const afterForgedSave = await json<{
    timelineDocument: { currentRevisionId: string; sourceRevisionId: string }
    revision: { id: string; sourceRevisionId: string }
  }>(endpoint)
  assert.equal(afterForgedSave.response.status, 200)
  assert.equal(afterForgedSave.body.timelineDocument.currentRevisionId, created.body.revision.id)
  assert.equal(afterForgedSave.body.timelineDocument.sourceRevisionId, persisted.revisionId)
  assert.equal(afterForgedSave.body.revision.sourceRevisionId, persisted.revisionId)

  const reconciled = await json<{
    timelineDocument: { sourceRevisionId: string }
    revision: { id: string; parentRevisionId: string; sourceRevisionId: string }
    report: { operation: string; changed: boolean; preservedElementIds: string[] }
  }>(`${endpoint}/reconcile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': materializedEtag },
    body: JSON.stringify({ summary: '对账最新剧本' }),
  })
  assert.equal(reconciled.response.status, 200)
  assert.equal(reconciled.body.timelineDocument.sourceRevisionId, storyUpdate.revision.id)
  assert.equal(reconciled.body.revision.parentRevisionId, created.body.revision.id)
  assert.equal(reconciled.body.revision.sourceRevisionId, storyUpdate.revision.id)
  assert.equal(reconciled.body.report.operation, 'reconcile')
  assert.equal(reconciled.body.report.changed, true)
  assert.equal(reconciled.body.report.preservedElementIds.length, 6)
  const reconciledEtag = reconciled.response.headers.get('etag')
  assert.ok(reconciledEtag)
  assert.notEqual(reconciledEtag, materializedEtag)

  const stale = await json<{ error: { code: string; details: { currentRevisionId: string } } }>(
    `${endpoint}/reconcile`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': materializedEtag },
      body: '{}',
    },
  )
  assert.equal(stale.response.status, 412)
  assert.equal(stale.body.error.code, 'TIMELINE_DOCUMENT_CONFLICT')
  assert.equal(stale.body.error.details.currentRevisionId, reconciled.body.revision.id)

  const noOp = await json<{
    revision: { id: string }
    report: { changed: boolean }
  }>(`${endpoint}/reconcile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': reconciledEtag },
    body: '{}',
  })
  assert.equal(noOp.response.status, 200)
  assert.equal(noOp.response.headers.get('etag'), reconciledEtag)
  assert.equal(noOp.body.revision.id, reconciled.body.revision.id)
  assert.equal(noOp.body.report.changed, false)
})

test('asset discovery can include same-project global media without leaking other episodes', async () => {
  const { baseUrl, runtime } = await fixture()
  const stories = new StoryRepository(runtime.database)
  stories.ensureEpisode('default', { id: 'asset-scope-episode', title: '资产作用域' })
  stories.ensureEpisode('default', { id: 'asset-other-episode', title: '其他分集' })
  const sourceRevisionId = runtime.database.getProject('default')?.currentRevisionId
  assert.ok(sourceRevisionId)
  await runtime.mediaStore.save({
    id: 'project-global-image',
    projectId: 'default',
    kind: 'character-turnaround',
    bytes: ONE_PIXEL_PNG,
    mimeType: 'image/png',
    source: 'fixture',
    sourceRevisionId,
  })
  await runtime.mediaStore.save({
    id: 'episode-image',
    projectId: 'default',
    episodeId: 'asset-scope-episode',
    kind: 'storyboard.image',
    bytes: ONE_PIXEL_PNG,
    mimeType: 'image/png',
    source: 'fixture',
    sourceRevisionId,
  })
  await runtime.mediaStore.save({
    id: 'other-episode-image',
    projectId: 'default',
    episodeId: 'asset-other-episode',
    kind: 'storyboard.image',
    bytes: ONE_PIXEL_PNG,
    mimeType: 'image/png',
    source: 'fixture',
    sourceRevisionId,
  })

  const scoped = await json<{ assets: Array<{ id: string }> }>(
    `${baseUrl}/api/v1/assets?projectId=default&episodeId=asset-scope-episode&includeProjectAssets=true`,
  )
  assert.equal(scoped.response.status, 200)
  assert.deepEqual(new Set(scoped.body.assets.map((asset) => asset.id)), new Set([
    'project-global-image',
    'episode-image',
  ]))

  const exact = await json<{ assets: Array<{ id: string }> }>(
    `${baseUrl}/api/v1/assets?projectId=default&episodeId=asset-scope-episode`,
  )
  assert.deepEqual(exact.body.assets.map((asset) => asset.id), ['episode-image'])
})

test('v1 project writes require If-Match and reject stale revisions', async () => {
  const { baseUrl } = await fixture()
  const current = await json<{ document: Record<string, unknown> }>(`${baseUrl}/api/v1/projects/default`)
  const originalEtag = current.response.headers.get('etag')
  assert.ok(originalEtag)

  const missing = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/projects/default`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { title: 'Missing precondition' } }),
  })
  assert.equal(missing.response.status, 428)
  assert.equal(missing.body.error.code, 'PRECONDITION_REQUIRED')

  const updated = await json<{ document: { title: string } }>(`${baseUrl}/api/v1/projects/default`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'if-match': originalEtag! },
    body: JSON.stringify({ patch: { title: 'Optimistic project' }, summary: 'rename' }),
  })
  assert.equal(updated.response.status, 200)
  assert.equal(updated.body.document.title, 'Optimistic project')
  assert.notEqual(updated.response.headers.get('etag'), originalEtag)

  const stale = await json<{ error: { code: string; details: { currentRevisionId: string } } }>(
    `${baseUrl}/api/v1/projects/default`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': originalEtag! },
      body: JSON.stringify({ patch: { title: 'Must not win' } }),
    },
  )
  assert.equal(stale.response.status, 412)
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT')
  assert.ok(stale.body.error.details.currentRevisionId)
})

test('project source import is knowledge-scoped, optimistic, strict, and preserves structured fields', async () => {
  const { baseUrl, runtime } = await fixture()
  const genericHead = runtime.database.getProject('default')?.currentRevisionId
  const empty = await json<{
    document: Record<string, unknown>
    etag: string
  }>(`${baseUrl}/api/v1/projects/default/knowledge`)
  const emptyEtag = empty.response.headers.get('etag')
  assert.equal(empty.response.status, 200)
  assert.equal(emptyEtag, 'W/"knowledge-empty"')

  const seededDocument = {
    version: 2,
    sourceText: '旧原著',
    worldbuilding: '龙脉规则',
    eventLine: '',
    relationshipNotes: '',
    worldEntries: [{ id: 'rule-1', category: 'rule', title: '龙脉', detail: '不可逆' }],
    events: [],
    relationships: [],
  }
  const seeded = await json<{ document: typeof seededDocument; etag: string }>(
    `${baseUrl}/api/v1/projects/default/knowledge`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': emptyEtag! },
      body: JSON.stringify({ document: seededDocument }),
    },
  )
  assert.equal(seeded.response.status, 200)
  const seededEtag = seeded.response.headers.get('etag')
  assert.ok(seededEtag)

  const missing = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/projects/default/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'story.md', content: '# 新原著' }),
  })
  assert.equal(missing.response.status, 428)
  assert.equal(missing.body.error.code, 'PRECONDITION_REQUIRED')

  const imported = await json<{
    document: typeof seededDocument
    revision: { summary: string }
  }>(`${baseUrl}/api/v1/projects/default/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': seededEtag! },
    body: JSON.stringify({ fileName: 'story.md', content: '\ufeff# 新原著' }),
  })
  assert.equal(imported.response.status, 201)
  assert.equal(imported.body.document.sourceText, '# 新原著')
  assert.equal(imported.body.document.worldbuilding, seededDocument.worldbuilding)
  assert.deepEqual(imported.body.document.worldEntries, seededDocument.worldEntries)
  assert.equal(imported.body.revision.summary, '导入项目原著：story.md')
  assert.equal(runtime.database.getProject('default')?.currentRevisionId, genericHead)

  const stale = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/projects/default/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': seededEtag! },
    body: JSON.stringify({ fileName: 'story.txt', content: '不能覆盖' }),
  })
  assert.equal(stale.response.status, 412)
  assert.equal(stale.body.error.code, 'KNOWLEDGE_REVISION_CONFLICT')

  const currentEtag = imported.response.headers.get('etag')
  assert.ok(currentEtag)
  const invalid = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/projects/default/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': currentEtag! },
    body: JSON.stringify({ fileName: '../story.txt', content: '路径注入' }),
  })
  assert.equal(invalid.response.status, 400)
  assert.equal(invalid.body.error.code, 'INVALID_PROJECT_KNOWLEDGE')

  const extra = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/projects/default/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': currentEtag! },
    body: JSON.stringify({ fileName: 'story.txt', content: 'x', path: '/tmp/x' }),
  })
  assert.equal(extra.response.status, 400)
  assert.equal(extra.body.error.code, 'INVALID_PROJECT_IMPORT')
})

test('ordinary v1 image generation remains idempotent, durable, and serves byte ranges', async () => {
  const { baseUrl, provider, runtime } = await fixture()
  const requestBody = JSON.stringify({
    projectId: 'default',
    prompt: '真实分镜图',
    size: '1024x1024',
    quality: 'medium',
    count: 1,
    metadata: { kind: 'concept-art', shotId: 'shot-1' },
  })

  const missingKey = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/assets/image-generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: requestBody,
  })
  assert.equal(missingKey.response.status, 400)
  assert.equal(missingKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED')

  const create = () => json<{ job: { id: string; providerId: string; providerConfigRevision: number } }>(
    `${baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'shot-1-image-v1' },
      body: requestBody,
    },
  )
  const first = await create()
  const duplicate = await create()
  assert.equal(first.response.status, 202)
  assert.equal(duplicate.response.status, 200)
  assert.equal(duplicate.body.job.id, first.body.job.id)
  assert.equal(first.body.job.providerId, 'codex-tools-image')
  assert.equal(first.body.job.providerConfigRevision, 1)

  const completed = await terminalJob(baseUrl, first.body.job.id)
  assert.equal(completed.status, 'succeeded')
  assert.equal(provider.calls, 1)
  assert.equal(runtime.database.getGenerationJob(first.body.job.id)?.providerState.phase, 'response-received')
  const output = completed.output as { images: Array<{ id: string; url: string }> }
  assert.equal(output.images.length, 1)

  const range = await fetch(`${baseUrl}${output.images[0].url}`, { headers: { range: 'bytes=0-7' } })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), `bytes 0-7/${ONE_PIXEL_PNG.length}`)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), ONE_PIXEL_PNG.subarray(0, 8))

  const jobs = await json<{ jobs: Array<{ id: string; projectId: string; providerConfigRevision: number }> }>(
    `${baseUrl}/api/v1/jobs?projectId=default`,
  )
  assert.ok(jobs.body.jobs.some((job) => (
    job.id === first.body.job.id
    && job.projectId === 'default'
    && job.providerConfigRevision === 1
  )))
})

test('visual asset workbench lists normalized targets and keeps immutable candidate ancestry', async () => {
  const { baseUrl, provider, runtime } = await fixture()
  const storyFixture = persistedStory(runtime, { episodeId: 'visual-workbench-episode' })

  const targetResult = await json<{
    episodeId: string
    sourceRevisionId: string
    targets: Array<{
      type: string
      id: string
      name: string
      lockedAssetId: string | null
      visualDescription: string
    }>
  }>(`${baseUrl}/api/v1/episodes/${storyFixture.episodeId}/visual-asset-targets?projectId=default`)
  assert.equal(targetResult.response.status, 200, JSON.stringify(targetResult.body))
  assert.equal(targetResult.body.sourceRevisionId, storyFixture.revisionId)
  assert.deepEqual(targetResult.body.targets.map(({ type, id, name }) => ({ type, id, name })), [
    { type: 'character', id: 'ali', name: '阿离' },
    { type: 'location', id: 'cliff', name: '断崖' },
    { type: 'prop', id: 'token', name: '青铜令' },
  ])
  assert.ok(targetResult.body.targets.every((target) => target.lockedAssetId === null))
  assert.equal(JSON.stringify(targetResult.body).includes('databaseEntityId'), false)

  const submit = (key: string) => json<{
    job: {
      id: string
      resourceId: string
      input: {
        metadata: Record<string, unknown>
        assetEntityBinding: {
          entityType: string
          entityId: string
          expectedRevisionId: string
          parentAssetId: string | null
          nextVersion: number
        }
      }
    }
  }>(`${baseUrl}/api/v1/assets/image-generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({
      projectId: 'default',
      episodeId: storyFixture.episodeId,
      input: {
        prompt: '阿离角色设定三视图',
        size: '1536x1024',
        quality: 'medium',
        count: 1,
        metadata: { kind: 'character-turnaround', entityType: 'character', entityId: 'ali' },
      },
    }),
  })

  const first = await submit('visual-workbench-character-v1')
  assert.equal(first.response.status, 202)
  assert.equal(first.body.job.resourceId, 'character:ali')
  assert.deepEqual(first.body.job.input.metadata, {
    kind: 'character-turnaround',
    entityType: 'character',
    entityId: 'ali',
  })
  assert.equal(first.body.job.input.assetEntityBinding.expectedRevisionId, storyFixture.revisionId)
  assert.equal(first.body.job.input.assetEntityBinding.parentAssetId, null)
  assert.equal(first.body.job.input.assetEntityBinding.nextVersion, 1)
  const firstDone = await terminalJob(baseUrl, first.body.job.id)
  assert.equal(firstDone.status, 'succeeded')
  const firstAssetId = (firstDone.output as { images: Array<{ id: string }> }).images[0].id
  const firstAsset = runtime.database.getMediaAsset(firstAssetId)
  assert.equal(firstAsset?.version, 1)
  assert.equal(firstAsset?.parentAssetId, null)
  assert.equal(firstAsset?.generationParameters.entityType, 'character')
  assert.equal(firstAsset?.generationParameters.entityId, 'ali')

  const second = await submit('visual-workbench-character-v2')
  assert.equal(second.body.job.input.assetEntityBinding.parentAssetId, firstAssetId)
  assert.equal(second.body.job.input.assetEntityBinding.nextVersion, 2)
  const secondDone = await terminalJob(baseUrl, second.body.job.id)
  const secondAssetId = (secondDone.output as { images: Array<{ id: string }> }).images[0].id
  const secondAsset = runtime.database.getMediaAsset(secondAssetId)
  assert.equal(secondAsset?.version, 2)
  assert.equal(secondAsset?.parentAssetId, firstAssetId)
  assert.ok(runtime.database.getMediaAsset(firstAssetId))
  const lockEtag = await episodeEtag(baseUrl, storyFixture.episodeId)

  const mismatchedLock = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/assets/${secondAssetId}/lock`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': lockEtag },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        targetType: 'location',
        targetId: 'cliff',
      }),
    },
  )
  assert.equal(mismatchedLock.response.status, 409)
  assert.equal(mismatchedLock.body.error.code, 'ASSET_TARGET_MISMATCH')

  const locked = await json<{ target: { lockedAssetId: string } }>(
    `${baseUrl}/api/v1/assets/${secondAssetId}/lock`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': lockEtag },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        targetType: 'character',
        targetId: 'ali',
      }),
    },
  )
  assert.equal(locked.response.status, 201)
  assert.equal(locked.body.target.lockedAssetId, secondAssetId)

  const unknown = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'visual-workbench-missing' },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        input: {
          prompt: '不存在的角色',
          size: '1024x1024',
          quality: 'medium',
          count: 1,
          metadata: { kind: 'character-turnaround', entityType: 'character', entityId: 'missing' },
        },
      }),
    },
  )
  assert.equal(unknown.response.status, 404)
  assert.equal(unknown.body.error.code, 'VISUAL_ASSET_TARGET_NOT_FOUND')
  assert.equal(provider.calls, 2)
})

test('storyboard images bind to the exact submitted Story shot and keep immutable regeneration history', async () => {
  const { baseUrl, provider, runtime } = await fixture()
  const storyFixture = persistedStory(runtime)

  // The project may advance for unrelated reasons. Storyboard provenance must
  // still use the episode's submitted source revision, not this project head.
  const unrelatedRevision = runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: runtime.database.getProject('default')?.currentRevisionId,
    summary: '与分集无关的项目修订',
    snapshot: { unrelated: true },
  })
  runtime.database.updateProject('default', { currentRevisionId: unrelatedRevision.id })
  assert.notEqual(storyFixture.revisionId, unrelatedRevision.id)

  const submit = (idempotencyKey: string) => json<{ job: { id: string; input: Record<string, unknown> } }>(
    `${baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        input: {
          prompt: '阿离在断崖听见龙吟的第一镜',
          size: '1536x1024',
          quality: 'medium',
          count: 1,
          metadata: { kind: 'storyboard', shotId: 'shot-1', sceneId: 'scene-1', useLockedReferences: false },
        },
      }),
    },
  )

  const firstSubmission = await submit('storyboard-shot-1-v1')
  assert.equal(firstSubmission.response.status, 202)
  const firstCompleted = await terminalJob(baseUrl, firstSubmission.body.job.id)
  assert.equal(firstCompleted.status, 'succeeded')
  const firstAssetId = (firstCompleted.output as { images: Array<{ id: string }> }).images[0].id
  const firstAsset = runtime.database.getMediaAsset(firstAssetId)
  assert.ok(firstAsset)
  assert.equal(firstAsset.episodeId, storyFixture.episodeId)
  assert.equal(firstAsset.sourceRevisionId, storyFixture.revisionId)
  assert.equal(firstAsset.parentAssetId, null)
  assert.equal(firstAsset.generationParameters.sourceRevisionId, storyFixture.revisionId)
  assert.equal(firstAsset.generationParameters.episodeId, storyFixture.episodeId)
  assert.equal(firstAsset.generationParameters.shotId, 'shot-1')
  assert.equal(firstAsset.generationParameters.sceneId, 'scene-1')
  const firstBinding = (runtime.database.getGenerationJob(firstSubmission.body.job.id)?.input as {
    storyboardBinding?: { expectedRevisionId?: string; databaseShotId?: string }
  }).storyboardBinding
  assert.equal(firstBinding?.expectedRevisionId, storyFixture.revisionId)
  assert.ok(firstBinding?.databaseShotId)

  let shot = runtime.database.withSql((sql) => sql.get(`
    SELECT shots.storyboard_asset_id, shots.status
    FROM shots JOIN scenes ON scenes.id = shots.scene_id
    WHERE scenes.episode_id = ?
      AND json_extract(shots.metadata_json, '$.storyId') = 'shot-1'
      AND json_extract(scenes.metadata_json, '$.storyId') = 'scene-1'
  `, storyFixture.episodeId))
  assert.equal(shot?.storyboard_asset_id, firstAssetId)
  assert.equal(shot?.status, 'storyboard_ready')

  const secondSubmission = await submit('storyboard-shot-1-v2')
  assert.equal(secondSubmission.response.status, 202)
  const secondCompleted = await terminalJob(baseUrl, secondSubmission.body.job.id)
  assert.equal(secondCompleted.status, 'succeeded')
  const secondAssetId = (secondCompleted.output as { images: Array<{ id: string }> }).images[0].id
  const secondAsset = runtime.database.getMediaAsset(secondAssetId)
  assert.ok(secondAsset)
  assert.notEqual(secondAssetId, firstAssetId)
  assert.notEqual(secondAsset.filePath, firstAsset.filePath)
  assert.equal(secondAsset.parentAssetId, firstAssetId)
  assert.equal(secondAsset.sourceRevisionId, storyFixture.revisionId)
  assert.ok(runtime.database.getMediaAsset(firstAssetId), 'regeneration must retain the previous immutable asset')
  for (const assetId of [firstAssetId, secondAssetId]) {
    const opened = await runtime.mediaStore.openAsset(assetId)
    await opened.file.close()
  }
  shot = runtime.database.withSql((sql) => sql.get(`
    SELECT shots.storyboard_asset_id, shots.status
    FROM shots JOIN scenes ON scenes.id = shots.scene_id
    WHERE scenes.episode_id = ?
      AND json_extract(shots.metadata_json, '$.storyId') = 'shot-1'
      AND json_extract(scenes.metadata_json, '$.storyId') = 'scene-1'
  `, storyFixture.episodeId))
  assert.equal(shot?.storyboard_asset_id, secondAssetId)
  assert.equal(shot?.status, 'storyboard_ready')
  assert.equal(provider.calls, 2)
})

test('generated character and current-scene location locks both drive storyboard edits', async () => {
  const { baseUrl, provider, runtime } = await fixture()
  const storyFixture = persistedStory(runtime, { episodeId: 'locked-reference-episode' })

  const characterGeneration = await json<{ job: { id: string; input: Record<string, unknown> } }>(
    `${baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'character-turnaround-reference-v1' },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        input: {
          prompt: '阿离角色三视图，黑发红绳青袍',
          size: '1024x1024',
          quality: 'medium',
          count: 1,
          metadata: { kind: 'character-turnaround', characterId: 'ali' },
        },
      }),
    },
  )
  assert.equal(characterGeneration.response.status, 202)
  assert.deepEqual(characterGeneration.body.job.input.episodeBinding, {
    episodeId: storyFixture.episodeId,
    expectedRevisionId: storyFixture.revisionId,
    stylePreset: '',
    aspectRatio: '16:9',
  })
  const characterCompleted = await terminalJob(baseUrl, characterGeneration.body.job.id)
  assert.equal(characterCompleted.status, 'succeeded')
  const characterAssetId = (characterCompleted.output as {
    images: Array<{ id: string }>
    referenceAssetIds: string[]
  }).images[0].id
  assert.deepEqual((characterCompleted.output as { referenceAssetIds: string[] }).referenceAssetIds, [])
  const characterAsset = runtime.database.getMediaAsset(characterAssetId)
  assert.ok(characterAsset)
  assert.equal(characterAsset.episodeId, storyFixture.episodeId)
  assert.equal(characterAsset.sourceRevisionId, storyFixture.revisionId)
  const lockEtag = await episodeEtag(baseUrl, storyFixture.episodeId)

  const locked = await json<{ target: { lockedAssetId: string }; sourceRevisionId: string }>(
    `${baseUrl}/api/v1/assets/${characterAssetId}/lock`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': lockEtag,
      },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        targetType: 'character',
        targetId: 'ali',
      }),
    },
  )
  assert.equal(locked.response.status, 201)
  assert.equal(locked.body.target.lockedAssetId, characterAssetId)
  assert.equal(locked.body.sourceRevisionId, storyFixture.revisionId)

  const characterRow = runtime.database.withSql((sql) => sql.get(`
    SELECT id FROM characters
    WHERE episode_id = ? AND json_extract(metadata_json, '$.storyId') = 'ali'
  `, storyFixture.episodeId))
  assert.equal(typeof characterRow?.id, 'string')
  const slotAudit = runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: runtime.database.getProject('default')?.currentRevisionId,
    summary: '分镜测试锁定角色三视图',
    snapshot: { version: 1, kind: 'character.visual-references.lock' },
  })
  const characterSlotAssetIds: Record<'front' | 'side' | 'back', string> = {
    front: '', side: '', back: '',
  }
  for (const [index, view] of (['front', 'side', 'back'] as const).entries()) {
    const asset = await runtime.mediaStore.save({
      id: `locked-reference-ali-${view}`,
      projectId: 'default',
      episodeId: storyFixture.episodeId,
      kind: `character-turnaround-${view}`,
      version: index + 1,
      bytes: ONE_PIXEL_PNG,
      mimeType: 'image/png',
      source: 'local-turnaround',
      sourceRevisionId: storyFixture.revisionId,
    })
    characterSlotAssetIds[view] = asset.id
    runtime.database.withSql((sql) => sql.run(`
      INSERT INTO character_visual_references (
        character_id, project_id, episode_id, role, asset_id, version,
        audit_revision_id, updated_at
      ) VALUES (?, 'default', ?, ?, ?, 1, ?, ?)
    `, String(characterRow?.id), storyFixture.episodeId, view, asset.id, slotAudit.id, new Date().toISOString()))
  }
  runtime.database.withSql((sql) => sql.run(`
    UPDATE shots
    SET description = '阿离正面面向镜头，站在断崖上',
        prompt = '阿离正面面向镜头，断崖云海'
    WHERE scene_id IN (SELECT id FROM scenes WHERE episode_id = ?)
      AND json_extract(metadata_json, '$.storyId') = 'shot-1'
  `, storyFixture.episodeId))

  const locationGeneration = await json<{ job: { id: string; input: Record<string, unknown> } }>(
    `${baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'location-concept-reference-v1' },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        input: {
          prompt: '断崖场景设定图，暮色云海与龙脉裂隙',
          size: '1536x1024',
          quality: 'medium',
          count: 1,
          metadata: { kind: 'location-concept', locationId: 'cliff' },
        },
      }),
    },
  )
  assert.equal(locationGeneration.response.status, 202)
  const locationCompleted = await terminalJob(baseUrl, locationGeneration.body.job.id)
  assert.equal(locationCompleted.status, 'succeeded')
  const locationAssetId = (locationCompleted.output as {
    images: Array<{ id: string }>
  }).images[0].id
  const locationLocked = await json<{ target: { lockedAssetId: string } }>(
    `${baseUrl}/api/v1/assets/${locationAssetId}/lock`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': lockEtag,
      },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        targetType: 'location',
        targetId: 'cliff',
      }),
    },
  )
  assert.equal(locationLocked.response.status, 201)
  assert.equal(locationLocked.body.target.lockedAssetId, locationAssetId)

  const storyboard = await json<{ job: { id: string; input: Record<string, unknown> } }>(
    `${baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'locked-storyboard-reference-v1' },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        input: {
          prompt: '保持锁定角色形象，阿离站在断崖上',
          size: '1536x1024',
          quality: 'medium',
          count: 1,
          metadata: { kind: 'storyboard', shotId: 'shot-1', sceneId: 'scene-1' },
        },
      }),
    },
  )
  assert.equal(storyboard.response.status, 202)
  assert.deepEqual(storyboard.body.job.input.referenceAssetIds, [characterSlotAssetIds.front, locationAssetId])
  assert.equal(JSON.stringify(storyboard.body.job.input).includes(characterAssetId), false)
  const referenceDecision = storyboard.body.job.input.storyboardReferenceDecision as {
    recommendation: { characters: Array<{ view: string; slotAuditRevisionId: string }> }
    locationPin: { assetId: string; lockAuditRevisionId: string }
  }
  assert.equal(referenceDecision.recommendation.characters[0]?.view, 'front')
  assert.equal(referenceDecision.recommendation.characters[0]?.slotAuditRevisionId, slotAudit.id)
  assert.equal(referenceDecision.locationPin.assetId, locationAssetId)
  assert.equal(typeof referenceDecision.locationPin.lockAuditRevisionId, 'string')
  const storyboardCompleted = await terminalJob(baseUrl, storyboard.body.job.id)
  assert.equal(storyboardCompleted.status, 'succeeded')
  assert.deepEqual(
    (storyboardCompleted.output as { referenceAssetIds: string[] }).referenceAssetIds,
    [characterSlotAssetIds.front, locationAssetId],
  )
  assert.deepEqual(
    (storyboardCompleted.progressDetail as { referenceAssetIds: string[] }).referenceAssetIds,
    [characterSlotAssetIds.front, locationAssetId],
  )
  const storyboardAssetId = (storyboardCompleted.output as { images: Array<{ id: string }> }).images[0].id
  assert.deepEqual(
    runtime.database.getMediaAsset(storyboardAssetId)?.generationParameters.referenceAssetIds,
    [characterSlotAssetIds.front, locationAssetId],
  )
  assert.deepEqual(provider.referenceCounts, [0, 0, 2])

  const optedOut = await json<{ job: { id: string; input: Record<string, unknown> } }>(
    `${baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'locked-storyboard-opt-out-v1' },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        input: {
          prompt: '显式不使用锁定参考图',
          size: '1024x1024',
          quality: 'medium',
          count: 1,
          metadata: {
            kind: 'storyboard',
            shotId: 'shot-2',
            sceneId: 'scene-1',
            useLockedReferences: false,
          },
        },
      }),
    },
  )
  assert.equal(optedOut.response.status, 202)
  assert.deepEqual(optedOut.body.job.input.referenceAssetIds, [])
  assert.equal((await terminalJob(baseUrl, optedOut.body.job.id)).status, 'succeeded')
  assert.deepEqual(provider.referenceCounts, [0, 0, 2, 0])
})

test('legacy primary-sheet storyboard references are ignored and client-supplied references are rejected before billing', async () => {
  const { baseUrl, provider, runtime } = await fixture()
  const storyFixture = persistedStory(runtime, { episodeId: 'invalid-reference-episode' })
  const characterRow = runtime.database.withSql((sql) => sql.get(`
    SELECT id FROM characters
    WHERE episode_id = ? AND json_extract(metadata_json, '$.storyId') = 'ali'
  `, storyFixture.episodeId))
  assert.equal(typeof characterRow?.id, 'string')
  const characterDatabaseId = String(characterRow?.id)

  const submit = (key: string, inputOverride: JsonObject = {}) => json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        input: {
          prompt: '不得发起计费的参考图请求',
          size: '1024x1024',
          quality: 'medium',
          count: 1,
          metadata: { kind: 'storyboard', shotId: 'shot-1', sceneId: 'scene-1' },
          ...inputOverride,
        },
      }),
    },
  )

  runtime.database.createMediaAsset({
    id: 'stale-reference',
    projectId: 'default',
    episodeId: storyFixture.episodeId,
    kind: 'character-turnaround',
    status: 'stale',
    mimeType: 'image/png',
    source: 'fixture',
    sourceRevisionId: storyFixture.revisionId,
  })
  runtime.database.withSql((sql) => sql.run(
    'UPDATE characters SET locked_asset_id = ? WHERE id = ?',
    'stale-reference',
    characterDatabaseId,
  ))
  const stale = await submit('reject-stale-reference')
  assert.equal(stale.response.status, 409)
  assert.equal(stale.body.error.code, 'STORYBOARD_REFERENCE_MANUAL_REQUIRED')

  runtime.database.createProject({ id: 'other-reference-project', title: '其他项目' })
  const otherRevision = runtime.database.createRevision({
    projectId: 'other-reference-project',
    summary: '其他项目修订',
    snapshot: {},
  })
  runtime.database.updateProject('other-reference-project', { currentRevisionId: otherRevision.id })
  runtime.storyRepository.ensureEpisode('other-reference-project', {
    id: 'other-reference-episode',
    title: '其他分集',
  })
  runtime.database.withSql((sql) => sql.run(
    'UPDATE episodes SET source_revision_id = ? WHERE id = ?',
    otherRevision.id,
    'other-reference-episode',
  ))
  runtime.database.createMediaAsset({
    id: 'cross-project-reference',
    projectId: 'other-reference-project',
    episodeId: 'other-reference-episode',
    kind: 'character-turnaround',
    status: 'ready',
    mimeType: 'image/png',
    source: 'fixture',
    sourceRevisionId: otherRevision.id,
  })
  runtime.database.withSql((sql) => sql.run(
    'UPDATE characters SET locked_asset_id = ? WHERE id = ?',
    'cross-project-reference',
    characterDatabaseId,
  ))
  const crossProject = await submit('reject-cross-project-reference')
  assert.equal(crossProject.response.status, 409)
  assert.equal(crossProject.body.error.code, 'STORYBOARD_REFERENCE_MANUAL_REQUIRED')

  runtime.database.createMediaAsset({
    id: 'audio-reference',
    projectId: 'default',
    episodeId: storyFixture.episodeId,
    kind: 'dialogue.speech',
    status: 'ready',
    mimeType: 'audio/mpeg',
    source: 'fixture',
    sourceRevisionId: storyFixture.revisionId,
  })
  runtime.database.withSql((sql) => sql.run(
    'UPDATE characters SET locked_asset_id = ? WHERE id = ?',
    'audio-reference',
    characterDatabaseId,
  ))
  const nonImage = await submit('reject-non-image-reference')
  assert.equal(nonImage.response.status, 409)
  assert.equal(nonImage.body.error.code, 'STORYBOARD_REFERENCE_MANUAL_REQUIRED')

  const clientUrl = await submit('reject-client-reference-url', {
    referenceUrls: ['file:///private/reference.png'],
  })
  assert.equal(clientUrl.response.status, 400)
  assert.equal(clientUrl.body.error.code, 'INVALID_REFERENCE_INPUT')
  assert.equal(provider.calls, 0)
  assert.equal(runtime.database.listGenerationJobs({
    projectId: 'default',
    type: 'asset.image.generate',
  }).length, 0)
})

test('worker revalidates the durable derived slot before billing when it changes in queue', async () => {
  const { baseUrl, provider, runtime } = await fixture()
  const storyFixture = persistedStory(runtime, { episodeId: 'queued-reference-race-episode' })
  const references = await bindCurrentCharacterViewSlots(
    runtime,
    storyFixture,
    'queued-reference-race-asset',
  )
  await runtime.worker.stop()

  const submitted = await json<{
    job: {
      id: string
      input: {
        referenceAssetIds: string[]
        storyboardReferenceDecision: {
          recommendation: { characters: Array<{ view: string; assetId: string; slotVersion: number }> }
        }
      }
    }
  }>(
    `${baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'queued-reference-race-v1' },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        input: {
          prompt: '排队期间参考图过期',
          size: '1024x1024',
          quality: 'medium',
          count: 1,
          metadata: { kind: 'storyboard', shotId: 'shot-1', sceneId: 'scene-1' },
        },
      }),
    },
  )
  assert.equal(submitted.response.status, 202)
  assert.deepEqual(submitted.body.job.input.referenceAssetIds, [references.front])
  const selectedCharacter = submitted.body.job.input.storyboardReferenceDecision.recommendation.characters[0]
  assert.equal(selectedCharacter?.view, 'front')
  assert.equal(selectedCharacter?.assetId, references.front)
  assert.equal(selectedCharacter?.slotVersion, 1)
  runtime.database.withSql((sql) => sql.run(`
    UPDATE character_visual_references
    SET version = version + 1, updated_at = ?
    WHERE episode_id = ? AND role = 'front'
  `, new Date().toISOString(), storyFixture.episodeId))

  await runtime.worker.start()
  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'STALE_STORYBOARD_REFERENCE_DECISION')
  assert.equal((completed.error as { retryable: boolean }).retryable, false)
  assert.equal(provider.calls, 0)
  assert.equal(JSON.stringify(completed).includes(runtime.mediaStore.runtimeDirectory), false)
})

test('worker refuses a reference job when an injected provider does not explicitly support edits', async () => {
  const { baseUrl, provider, runtime } = await fixture()
  const storyFixture = persistedStory(runtime, { episodeId: 'unsupported-reference-provider-episode' })
  const references = await bindCurrentCharacterViewSlots(
    runtime,
    storyFixture,
    'unsupported-provider-reference',
  )
  Object.defineProperty(provider, 'supportsImageReferences', { value: false })

  const submitted = await json<{ job: { id: string; input: { referenceAssetIds: string[] } } }>(`${baseUrl}/api/v1/assets/image-generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'unsupported-reference-provider-v1' },
    body: JSON.stringify({
      projectId: 'default',
      episodeId: storyFixture.episodeId,
      input: {
        prompt: '不得降级为纯文本生图',
        size: '1024x1024',
        quality: 'medium',
        count: 1,
        metadata: { kind: 'storyboard', shotId: 'shot-1', sceneId: 'scene-1' },
      },
    }),
  })
  assert.equal(submitted.response.status, 202)
  assert.deepEqual(submitted.body.job.input.referenceAssetIds, [references.front])
  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'REFERENCE_IMAGES_UNSUPPORTED')
  assert.equal(provider.calls, 0)
})

test('unknown and ambiguous public Story shot IDs are rejected before Provider billing', async () => {
  const { baseUrl, provider, runtime } = await fixture()
  const story = validGeneratedStory('重复镜头标识测试')
  const firstScene = structuredClone(story.scenes[0])
  firstScene.shots = firstScene.shots.slice(0, 3)
  const secondScene = structuredClone(story.scenes[0])
  secondScene.id = 'scene-2'
  secondScene.sequence = 1
  secondScene.title = '第二场'
  secondScene.shots = secondScene.shots.slice(3).map((shot, sequence) => ({
    ...shot,
    id: sequence === 0 ? 'shot-1' : shot.id,
    sequence,
  }))
  story.scenes = [firstScene, secondScene]
  const storyFixture = persistedStory(runtime, { episodeId: 'ambiguous-shot-episode', story })

  const submit = (idempotencyKey: string, metadata: JsonObject) => json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        input: {
          prompt: '不会被计费的无效分镜',
          size: '1024x1024',
          quality: 'medium',
          count: 1,
          metadata,
        },
      }),
    },
  )

  const unknown = await submit('unknown-storyboard-shot', {
    kind: 'storyboard',
    shotId: 'missing-shot',
    sceneId: 'scene-1',
  })
  assert.equal(unknown.response.status, 404)
  assert.equal(unknown.body.error.code, 'STORYBOARD_SHOT_NOT_FOUND')

  const ambiguous = await submit('ambiguous-storyboard-shot', {
    kind: 'storyboard',
    shotId: 'shot-1',
  })
  assert.equal(ambiguous.response.status, 409)
  assert.equal(ambiguous.body.error.code, 'AMBIGUOUS_STORYBOARD_SHOT_ID')
  assert.equal(provider.calls, 0)
  assert.equal(runtime.database.listGenerationJobs({
    projectId: 'default',
    type: 'asset.image.generate',
  }).length, 0)
})

test('a Story revision race rolls back the new asset and file while preserving the old shot link', async () => {
  const { baseUrl, provider, runtime } = await fixture()
  const storyFixture = persistedStory(runtime, { episodeId: 'storyboard-race-episode' })
  const shot = runtime.database.withSql((sql) => sql.get(`
    SELECT shots.id
    FROM shots JOIN scenes ON scenes.id = shots.scene_id
    WHERE scenes.episode_id = ?
      AND json_extract(shots.metadata_json, '$.storyId') = 'shot-1'
      AND json_extract(scenes.metadata_json, '$.storyId') = 'scene-1'
  `, storyFixture.episodeId))
  const databaseShotId = shot?.id
  assert.equal(typeof databaseShotId, 'string')
  if (typeof databaseShotId !== 'string') throw new Error('fixture shot is missing')
  runtime.database.createMediaAsset({
    id: 'old-storyboard-asset',
    projectId: 'default',
    episodeId: storyFixture.episodeId,
    kind: 'storyboard',
    status: 'ready',
    source: 'fixture',
    sourceRevisionId: storyFixture.revisionId,
  })
  runtime.database.withSql((sql) => sql.run(`
    UPDATE shots SET storyboard_asset_id = ?, status = 'storyboard_ready'
    WHERE id = ?
  `, 'old-storyboard-asset', databaseShotId))

  let providerStarted!: () => void
  const started = new Promise<void>((resolveStarted) => { providerStarted = resolveStarted })
  let releaseProvider!: () => void
  const held = new Promise<void>((resolveHeld) => { releaseProvider = resolveHeld })
  provider.beforeResponse = async () => {
    providerStarted()
    await held
  }

  const submitted = await json<{ job: { id: string } }>(
    `${baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'storyboard-race-v1' },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: storyFixture.episodeId,
        input: {
          prompt: '生成期间剧本发生变化',
          size: '1024x1024',
          quality: 'medium',
          count: 1,
          metadata: { kind: 'storyboard', shotId: 'shot-1', sceneId: 'scene-1', useLockedReferences: false },
        },
      }),
    },
  )
  assert.equal(submitted.response.status, 202)
  await started

  const changedRevision = runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: storyFixture.revisionId,
    summary: '生成期间改变剧本',
    snapshot: structuredClone(storyFixture.story) as unknown as JsonObject,
  })
  runtime.database.withSql((sql) => sql.run(
    'UPDATE episodes SET source_revision_id = ?, updated_at = ? WHERE id = ?',
    changedRevision.id,
    new Date().toISOString(),
    storyFixture.episodeId,
  ))
  releaseProvider()

  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'STALE_SOURCE')
  assert.equal(provider.calls, 1)
  const currentShot = runtime.database.withSql((sql) => sql.get(
    'SELECT storyboard_asset_id, status FROM shots WHERE id = ?',
    databaseShotId,
  ))
  assert.equal(currentShot?.storyboard_asset_id, 'old-storyboard-asset')
  assert.equal(currentShot?.status, 'storyboard_ready')
  assert.deepEqual(
    runtime.database.listMediaAssets({ projectId: 'default', episodeId: storyFixture.episodeId })
      .map((asset) => asset.id),
    ['old-storyboard-asset'],
  )
  const mediaEntries = await readdir(runtime.mediaStore.mediaDirectory, {
    recursive: true,
    withFileTypes: true,
  })
  assert.equal(mediaEntries.filter((entry) => entry.isFile()).length, 0)
})

test('an active image response cannot publish after render settings cancel its durable job', async () => {
  const { baseUrl, provider, runtime } = await fixture()
  const storyFixture = persistedStory(runtime, { episodeId: 'storyboard-settings-race-episode' })
  runtime.storyRepository.updateRenderSettings(storyFixture.episodeId, {
    stylePreset: '国风动画',
    aspectRatio: '16:9',
  })
  const episodeRead = await fetch(
    `${baseUrl}/api/v1/episodes/${storyFixture.episodeId}?projectId=default`,
  )
  assert.equal(episodeRead.status, 200)
  const episodeEtag = episodeRead.headers.get('etag')
  assert.ok(episodeEtag)
  await episodeRead.body?.cancel()

  let providerStarted!: () => void
  const started = new Promise<void>((resolveStarted) => { providerStarted = resolveStarted })
  let releaseProvider!: () => void
  const held = new Promise<void>((resolveHeld) => { releaseProvider = resolveHeld })
  provider.beforeResponse = async () => {
    providerStarted()
    await held
  }

  const submitted = await json<{
    job: {
      id: string
      input: {
        episodeBinding: {
          stylePreset: string
          aspectRatio: string
        }
      }
    }
  }>(`${baseUrl}/api/v1/assets/image-generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'storyboard-settings-race-v1',
    },
    body: JSON.stringify({
      projectId: 'default',
      episodeId: storyFixture.episodeId,
      input: {
        prompt: '旧国风分镜',
        size: '1024x1024',
        quality: 'medium',
        count: 1,
        metadata: { kind: 'storyboard', shotId: 'shot-1', sceneId: 'scene-1', useLockedReferences: false },
      },
    }),
  })
  assert.equal(submitted.response.status, 202)
  assert.deepEqual(submitted.body.job.input.episodeBinding, {
    episodeId: storyFixture.episodeId,
    expectedRevisionId: storyFixture.revisionId,
    stylePreset: '国风动画',
    aspectRatio: '16:9',
  })
  await started

  const changed = await json<{
    episode: { stylePreset: string; aspectRatio: string }
  }>(`${baseUrl}/api/v1/episodes/${storyFixture.episodeId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'if-match': episodeEtag!,
    },
    body: JSON.stringify({
      projectId: 'default',
      stylePreset: '赛博朋克',
      aspectRatio: '9:16',
    }),
  })
  assert.equal(changed.response.status, 200)
  assert.equal(changed.body.episode.stylePreset, '赛博朋克')
  assert.equal(changed.body.episode.aspectRatio, '9:16')
  assert.notEqual(changed.response.headers.get('etag'), episodeEtag)
  assert.equal(runtime.database.getGenerationJob(submitted.body.job.id)?.status, 'cancelled')

  releaseProvider()
  await runtime.worker.waitForIdle()

  const durable = runtime.database.getGenerationJob(submitted.body.job.id)
  assert.equal(durable?.status, 'cancelled')
  assert.equal(durable?.error?.code, 'STALE_RENDER_SETTINGS')
  assert.equal(provider.calls, 1)
  assert.equal(runtime.database.withSql((sql) => sql.get(`
    SELECT shots.storyboard_asset_id
    FROM shots JOIN scenes ON scenes.id = shots.scene_id
    WHERE scenes.episode_id = ?
      AND json_extract(shots.metadata_json, '$.storyId') = 'shot-1'
  `, storyFixture.episodeId))?.storyboard_asset_id, null)
  assert.deepEqual(
    runtime.database.listMediaAssets({
      projectId: 'default',
      episodeId: storyFixture.episodeId,
    }),
    [],
  )
  const mediaEntries = await readdir(runtime.mediaStore.mediaDirectory, {
    recursive: true,
    withFileTypes: true,
  })
  assert.equal(mediaEntries.filter((entry) => entry.isFile()).length, 0)
})

test('provider API persists only Keychain references and never returns the key', async () => {
  const { baseUrl, credentials, runtime } = await fixture()
  const secret = 'provider-secret-that-must-not-leak'
  const saved = await json<{ provider: Record<string, unknown> }>(
    `${baseUrl}/api/v1/providers/custom-text/credentials`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: secret,
        baseUrl: 'https://text.example/v1',
        model: 'text-model',
        enabled: true,
      }),
    },
  )
  assert.equal(saved.response.status, 200)
  assert.equal(JSON.stringify(saved.body).includes(secret), false)
  assert.equal(credentials.values.get('custom-text:api-key'), secret)
  assert.equal(JSON.stringify(runtime.database.getProviderConnection('custom-text')).includes(secret), false)

  const listed = await json<{ providers: unknown[] }>(`${baseUrl}/api/v1/providers`)
  assert.equal(listed.response.status, 200)
  assert.equal(listed.body.providers.length, 9)
  assert.equal(JSON.stringify(listed.body).includes(secret), false)
})

test('character voice recommendation is fingerprint-gated, publicly redacted, and confirmable', async () => {
  let textCalls = 0
  let catalogCalls = 0
  const voiceId = 'account-cloned-ali'
  const running = await fixture({
    providerProbe: async () => ({ status: 'ok', message: '测试成功' }),
    miniMaxVoiceCatalogFetch: async (_input, init) => {
      catalogCalls += 1
      assert.match(new Headers(init?.headers).get('authorization') ?? '', /^Bearer /)
      return new Response(JSON.stringify({
        system_voice: [{
          voice_id: 'system-calm',
          voice_name: '沉稳女声',
          description: ['沉稳'],
        }],
        voice_cloning: [{
          voice_id: voiceId,
          voice_name: '阿离自有音色',
          description: ['年轻', '克制', '英气'],
        }],
        voice_generation: [],
        base_resp: { status_code: 0, status_msg: 'success' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    textCompatibleFetch: async (_input, init) => {
      textCalls += 1
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      assert.equal(JSON.stringify(requestBody).includes('uniqueItems'), false)
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          selectedVoiceId: voiceId,
          rationale: '年轻克制且有剑客的果断。',
          profileTags: ['年轻', '克制', '英气'],
          alternatives: [{ voiceId: 'system-calm', rationale: '更沉稳的备选。' }],
          defaultDelivery: { emotion: 'calm', speed: 0.95, pitch: 0 },
          sceneDirections: [{
            sceneId: 'scene-1',
            emotion: 'whisper',
            speed: 0.85,
            pitch: -1,
            rationale: '龙吟后压低声音表现警觉。',
          }],
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const { baseUrl, runtime } = running
  const persisted = persistedStory(runtime, { episodeId: 'voice-casting-episode' })
  const speech = await runtime.providerService.save('minimax-speech', {
    apiKey: 'minimax-secret-never-public',
    enabled: true,
  })
  await runtime.providerService.test('minimax-speech')
  await runtime.providerService.save('custom-text', {
    apiKey: 'text-secret-never-public',
    baseUrl: 'https://text.example/v1',
    model: 'text-model',
    enabled: true,
  })
  await runtime.providerService.test('custom-text')
  await runtime.providerService.setDefault('custom-text')

  const catalog = await json<{
    fingerprint: string
    provider: { configRevision: number }
    voices: Array<{ voiceId: string }>
  }>(`${baseUrl}/api/v1/providers/minimax-speech/voices`)
  assert.equal(catalog.response.status, 200)
  assert.equal(catalog.body.provider.configRevision, speech.configRevision)
  assert.equal(catalog.body.voices.some((voice) => voice.voiceId === voiceId), true)
  const etag = await episodeEtag(baseUrl, persisted.episodeId)

  const staleCatalog = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/episodes/${persisted.episodeId}/characters/ali/voice-recommendations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': etag,
        'idempotency-key': 'voice-casting-stale-catalog',
      },
      body: JSON.stringify({
        projectId: 'default',
        textProviderId: 'custom-text',
        expectedCatalogFingerprint: 'f'.repeat(64),
      }),
    },
  )
  assert.equal(staleCatalog.response.status, 409)
  assert.equal(staleCatalog.body.error.code, 'VOICE_CATALOG_CHANGED')
  assert.equal(textCalls, 0)

  const submitted = await json<{ job: Record<string, unknown> }>(
    `${baseUrl}/api/v1/episodes/${persisted.episodeId}/characters/ali/voice-recommendations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': etag,
        'idempotency-key': 'voice-casting-confirmable',
      },
      body: JSON.stringify({
        projectId: 'default',
        textProviderId: 'custom-text',
        expectedCatalogFingerprint: catalog.body.fingerprint,
      }),
    },
  )
  assert.equal(submitted.response.status, 202)
  assert.equal(JSON.stringify(submitted.body).includes('它醒了'), false)
  assert.equal(JSON.stringify(submitted.body).includes('minimax-secret-never-public'), false)
  assert.equal(JSON.stringify(submitted.body).includes('text-secret-never-public'), false)
  const publicInput = submitted.body.job.input as Record<string, unknown>
  assert.deepEqual(Object.keys(publicInput).sort(), [
    'catalog',
    'characterId',
    'episodeId',
    'expectedStoryRevisionId',
  ])
  assert.equal(Array.isArray((publicInput.catalog as Record<string, unknown>).voices), false)

  const completed = await terminalJob(baseUrl, String(submitted.body.job.id))
  assert.equal(completed.status, 'succeeded')
  assert.equal(textCalls, 1)
  const loaded = await json<{ job: Record<string, unknown> }>(
    `${baseUrl}/api/v1/jobs/${String(submitted.body.job.id)}`,
  )
  assert.equal(JSON.stringify(loaded.body.job.input).includes('它醒了'), false)

  const confirmed = await json<{
    episode: { sourceRevisionId: string }
    voiceProfile: {
      voiceId: string
      selectionSource: string
      recommendationJobId: string
      catalogFingerprint: string
      defaultDelivery: { speed: number }
    }
    revisionId: string
  }>(`${baseUrl}/api/v1/episodes/${persisted.episodeId}/characters/ali/voice-profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': etag },
    body: JSON.stringify({
      projectId: 'default',
      selectionSource: 'agentic',
      recommendationJobId: submitted.body.job.id,
      voiceId,
      expectedProviderConfigRevision: speech.configRevision,
    }),
  })
  assert.equal(confirmed.response.status, 200)
  assert.equal(confirmed.body.episode.sourceRevisionId, persisted.revisionId)
  assert.equal(confirmed.body.voiceProfile.voiceId, voiceId)
  assert.equal(confirmed.body.voiceProfile.selectionSource, 'agentic')
  assert.equal(confirmed.body.voiceProfile.recommendationJobId, submitted.body.job.id)
  assert.equal(confirmed.body.voiceProfile.catalogFingerprint, catalog.body.fingerprint)
  assert.equal(confirmed.body.voiceProfile.defaultDelivery.speed, 0.95)
  assert.notEqual(confirmed.body.revisionId, persisted.revisionId)
  assert.equal(runtime.storyRepository.getEpisode(persisted.episodeId)?.sourceRevisionId, persisted.revisionId)
  assert.ok(catalogCalls >= 4)
})

test('free voice recommendation creates an exact durable job and worker rejects catalog drift', async () => {
  let catalogMode: 'stable' | 'drift' | 'unavailable' = 'stable'
  let catalogCalls = 0
  let textCalls = 0
  const running = await fixture({
    enforcePaidAigcConfirmation: true,
    autoStartWorker: false,
    providerProbe: async () => ({ status: 'ok', message: '测试成功' }),
    miniMaxVoiceCatalogFetch: async () => {
      catalogCalls += 1
      if (catalogMode === 'unavailable') throw new Error('catalog must not be read on durable replay')
      return new Response(JSON.stringify({
        system_voice: [{
          voice_id: catalogMode === 'drift' ? 'system-drifted' : 'system-calm',
          voice_name: catalogMode === 'drift' ? '已变更音色' : '沉稳女声',
          description: [catalogMode === 'drift' ? '目录已变更' : '沉稳'],
        }],
        voice_cloning: [{
          voice_id: 'account-cloned-ali',
          voice_name: '阿离自有音色',
          description: ['年轻', '克制', '英气'],
        }],
        voice_generation: [],
        base_resp: { status_code: 0, status_msg: 'success' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    textCompatibleFetch: async () => {
      textCalls += 1
      throw new Error('text provider must not run after catalog drift')
    },
  })
  const { baseUrl, runtime } = running
  const persisted = persistedStory(runtime, { episodeId: 'paid-voice-casting' })
  await runtime.providerService.save('minimax-speech', {
    apiKey: 'minimax-secret-never-public',
    enabled: true,
  })
  await runtime.providerService.test('minimax-speech')
  await runtime.providerService.save('custom-text', {
    apiKey: 'text-secret-v1',
    baseUrl: 'https://text.example/v1',
    model: 'text-model-v1',
    enabled: true,
  })
  await runtime.providerService.test('custom-text')
  await runtime.providerService.setDefault('custom-text')

  const catalog = await json<{ fingerprint: string }>(
    `${baseUrl}/api/v1/providers/minimax-speech/voices`,
  )
  const firstEtag = await episodeEtag(baseUrl, persisted.episodeId)
  const path = `${baseUrl}/api/v1/episodes/${persisted.episodeId}/characters/ali/voice-recommendations`
  const key = 'free-voice-recommendation'
  const explicitBody = {
    projectId: 'default',
    textProviderId: 'custom-text',
    expectedCatalogFingerprint: catalog.body.fingerprint,
  }
  const submit = (
    requestBody: unknown,
    etag: string,
    idempotency = key,
  ) => json<{
    error?: {
      code: string
      details?: {
        confirmation?: {
          action: string
          billableTaskCount: number
          confirmationToken: string
          provider: { providerId: string; model: string; configRevision: number }
        }
      }
    }
    job?: { id: string }
  }>(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': etag,
      'idempotency-key': idempotency,
    },
    body: JSON.stringify(requestBody),
  })
  const jobCount = () => runtime.database.listGenerationJobs({
    projectId: 'default',
    type: 'character.voice.recommend',
  }).length

  const submitted = await submit(explicitBody, firstEtag)
  assert.equal(submitted.response.status, 202)
  assert.ok(submitted.body.job?.id)
  assert.equal(jobCount(), 1)
  assert.equal(textCalls, 0)

  catalogMode = 'drift'
  await runtime.worker.start()
  const terminal = await terminalJob(baseUrl, submitted.body.job!.id)
  assert.equal(terminal.status, 'failed')
  assert.equal((terminal.error as { code: string }).code, 'VOICE_RECOMMENDATION_CATALOG_CHANGED')
  assert.equal(textCalls, 0)

  catalogMode = 'unavailable'
  const catalogCallsBeforeReplay = catalogCalls
  const replay = await submit(explicitBody, firstEtag, key)
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.job?.id, submitted.body.job?.id)
  assert.equal(catalogCalls, catalogCallsBeforeReplay)
  assert.equal(textCalls, 0)
})

test('the selected custom image Provider executes through its immutable profile', async () => {
  const { baseUrl, credentials } = await fixture()
  const secret = 'custom-image-secret'
  const saved = await json<{ provider: { configRevision: number } }>(
    `${baseUrl}/api/v1/providers/custom-image/credentials`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: secret,
        baseUrl: 'https://images.example/v1',
        model: 'image-model-v1',
        enabled: true,
      }),
    },
  )
  assert.equal(saved.response.status, 200)
  assert.equal(saved.body.provider.configRevision, 2)
  assert.equal(credentials.values.get('custom-image:api-key-r2'), secret)

  const selected = await json<{ provider: { isDefault: boolean } }>(`${baseUrl}/api/v1/providers/custom-image`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isDefault: true }),
  })
  assert.equal(selected.response.status, 200)
  assert.equal(selected.body.provider.isDefault, true)

  const originalFetch = globalThis.fetch
  let upstreamCalls = 0
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === 'https://images.example/v1/images/generations') {
      upstreamCalls += 1
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`)
      const body = JSON.parse(String(init?.body)) as { model: string; prompt: string }
      assert.equal(body.model, 'image-model-v1')
      assert.equal(body.prompt, '自定义 Provider 分镜')
      return new Response(JSON.stringify({
        data: [{ b64_json: ONE_PIXEL_PNG.toString('base64') }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return originalFetch(input, init)
  }
  try {
    const created = await json<{ job: { id: string; providerId: string; providerConfigRevision: number } }>(
      `${baseUrl}/api/v1/assets/image-generations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'custom-image-v1' },
        body: JSON.stringify({
          projectId: 'default',
          prompt: '自定义 Provider 分镜',
          size: '1024x1024',
          quality: 'medium',
          count: 1,
        }),
      },
    )
    assert.equal(created.response.status, 202)
    assert.equal(created.body.job.providerId, 'custom-image')
    assert.equal(created.body.job.providerConfigRevision, 2)
    assert.equal((await terminalJob(baseUrl, created.body.job.id)).status, 'succeeded')
    assert.equal(upstreamCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('story routes are mounted and execution uses the immutable submitted text profile', async () => {
  const { baseUrl, credentials, runtime } = await fixture({
    enforcePaidAigcConfirmation: true,
  })
  await runtime.worker.stop()

  const missing = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/episodes/missing-story-episode/story`,
  )
  assert.equal(missing.response.status, 404)
  assert.equal(missing.body.error.code, 'EPISODE_NOT_FOUND')

  const firstProfile = await json<{ provider: { configRevision: number } }>(
    `${baseUrl}/api/v1/providers/custom-text/credentials`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'story-key-v1',
        baseUrl: 'https://story-v1.example/v1',
        model: 'story-model-v1',
        enabled: true,
      }),
    },
  )
  assert.equal(firstProfile.response.status, 200)
  assert.equal(firstProfile.body.provider.configRevision, 2)
  assert.equal(credentials.values.get('custom-text:api-key-r2'), 'story-key-v1')

  const episode = await json<{ episode: { id: string }; revisionId: string }>(
    `${baseUrl}/api/v1/projects/default/episodes`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'immutable-story-episode',
        title: '龙脉初醒',
        source: '阿离在断崖听见龙吟。',
        durationSeconds: 30,
        aspect: '16:9',
        style: '国风动画',
      }),
    },
  )
  assert.equal(episode.response.status, 201)
  const episodeEtag = episode.response.headers.get('etag')
  assert.ok(episodeEtag)

  const submitted = await json<{
    job: { id: string; providerId: string; model: string; providerConfigRevision: number }
  }>(`${baseUrl}/api/v1/episodes/${episode.body.episode.id}/story-generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': episodeEtag!,
      'idempotency-key': 'immutable-story-profile-v1',
    },
    body: JSON.stringify({ providerId: 'custom-text' }),
  })
  assert.equal(submitted.response.status, 202)
  assert.deepEqual(
    {
      providerId: submitted.body.job.providerId,
      model: submitted.body.job.model,
      providerConfigRevision: submitted.body.job.providerConfigRevision,
    },
    {
      providerId: 'custom-text',
      model: 'story-model-v1',
      providerConfigRevision: 2,
    },
  )

  const secondProfile = await json<{ provider: { configRevision: number } }>(
    `${baseUrl}/api/v1/providers/custom-text/credentials`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'story-key-v2',
        baseUrl: 'https://story-v2.example/v1',
        model: 'story-model-v2',
        enabled: true,
      }),
    },
  )
  assert.equal(secondProfile.response.status, 200)
  assert.equal(secondProfile.body.provider.configRevision, 3)

  const originalFetch = globalThis.fetch
  const upstreamCalls: Array<{ url: string; authorization: string | null; model: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://story-v1.example/') || url.startsWith('https://story-v2.example/')) {
      const body = JSON.parse(String(init?.body)) as { model: string }
      upstreamCalls.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
        model: body.model,
      })
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validGeneratedStory('龙脉初醒')) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return originalFetch(input, init)
  }
  try {
    await runtime.worker.start()
    const completed = await terminalJob(baseUrl, submitted.body.job.id)
    assert.equal(completed.status, 'succeeded')
    assert.deepEqual(upstreamCalls, [{
      url: 'https://story-v1.example/v1/chat/completions',
      authorization: 'Bearer story-key-v1',
      model: 'story-model-v1',
    }])
    assert.equal(runtime.database.getGenerationJob(submitted.body.job.id)?.providerState.phase, 'response-received')
    assert.equal(runtime.storyRepository.getStory(episode.body.episode.id)?.title, '龙脉初醒')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('recovery never resubmits a non-idempotent image request with an ambiguous outcome', async () => {
  const { baseUrl, provider, runtime } = await fixture()
  await runtime.worker.stop()
  const job = runtime.database.createGenerationJob({
    projectId: 'default',
    type: 'asset.image.generate',
    status: 'waiting_provider',
    progress: 5,
    resourceType: 'provider:image',
    providerId: 'codex-tools-image',
    model: 'gpt-image-2',
    providerConfigRevision: 1,
    idempotencyKey: 'ambiguous-image-v1',
    input: {
      prompt: '不得自动重提',
      size: '1024x1024',
      quality: 'medium',
      count: 1,
    },
    providerState: {
      operation: 'image.generate',
      phase: 'submitting',
      clientRequestId: 'ambiguous-image-v1',
      providerSupportsIdempotency: false,
    },
  })
  await runtime.worker.start()
  const completed = await terminalJob(baseUrl, job.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal((completed.error as { retryable: boolean }).retryable, false)
  assert.equal(provider.calls, 0)
})
