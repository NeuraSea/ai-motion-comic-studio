import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import type { GenerationJobRecord, MediaAssetRecord } from './database.js'
import type { KeychainCredentialSlot } from './keychain.js'
import type { MiniMaxVoiceCatalog } from './minimax-voice-catalog.js'
import {
  PROJECT_NARRATOR_VOICE_PREVIEW_FALLBACK_TEXT,
  PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE,
  createProjectNarratorVoicePreviewHandler,
  resolveProjectNarratorVoicePreviewTarget,
  type ProjectNarratorVoicePreviewJobInput,
} from './project-narrator-voice-preview.js'
import {
  MiniMaxSpeechError,
  type MiniMaxSpeechInput,
  type MiniMaxSpeechResult,
  type SpeechProvider,
} from './providers/minimax-tts.js'
import type { ProviderCredentialStore } from './providers/service.js'
import type { ImageGenerationInput, ImageProvider, JsonObject, ProviderImage } from './types.js'
import { JobExecutionError, type JobHandlerContext, type JobRecord } from './worker.js'

const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
const CATALOG_FINGERPRINT = 'e'.repeat(64)

class NoopImageProvider implements ImageProvider {
  readonly name = 'noop-image'
  readonly model = 'noop-image'
  readonly configured = true
  async health() { return { status: 'ok' as const, message: 'ready' } }
  async generate(_input: ImageGenerationInput): Promise<ProviderImage[]> {
    throw new Error('not used')
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

class FixtureSpeechProvider implements SpeechProvider {
  readonly name = 'minimax-speech'
  readonly model = 'speech-2.8-hd'
  readonly configured = true
  readonly calls: MiniMaxSpeechInput[] = []

  constructor(
    private readonly gate?: Promise<void>,
    private readonly failure?: MiniMaxSpeechError,
  ) {}

  async synthesize(input: MiniMaxSpeechInput): Promise<MiniMaxSpeechResult> {
    this.calls.push(structuredClone(input))
    if (this.gate) await this.gate
    if (this.failure) throw this.failure
    return {
      audio: { kind: 'bytes', bytes: MP3_BYTES, sourceEncoding: 'hex' },
      format: 'mp3',
      mimeType: 'audio/mpeg',
      durationMs: 900,
      usageCharacters: Array.from(input.text).length,
    }
  }
}

const runtimes: Array<{ directory: string; runtime: ApplicationRuntime }> = []

afterEach(async () => {
  for (const item of runtimes.splice(0)) {
    await item.runtime.close()
    await rm(item.directory, { recursive: true, force: true })
  }
})

function story(withNarration = true) {
  return {
    version: 1 as const,
    title: '项目旁白试听',
    targetDurationSeconds: 30,
    bible: {
      logline: '阿离在断崖做出决定。',
      theme: '责任',
      tone: '克制',
      visualStyle: '国风动画',
    },
    characters: [{
      id: 'ali', name: '阿离', role: '主角',
      storyDescription: '年轻剑客', visualDescription: '黑发青衣',
    }],
    locations: [{
      id: 'cliff', name: '断崖', storyDescription: '长安城外', visualDescription: '云海与山石',
    }],
    props: [{
      id: 'token', name: '青铜令', description: '唤醒龙脉', visualDescription: '暗红纹路',
    }],
    scenes: [{
      id: 'scene-1', sequence: 0, title: '断崖', locationId: 'cliff',
      timeOfDay: '黄昏', description: '风起云涌',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `镜头 ${index + 1}`,
        description: '阿离看向云海。',
        framing: '中景',
        movement: '缓慢推进',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '断崖黄昏',
        dialogueLines: index === 0 && withNarration ? [{
          id: 'narration-1',
          sequence: 0,
          kind: 'narration' as const,
          speaker: '',
          text: '暮色笼罩断崖，远处第一盏灯亮了。',
        }, {
          id: 'dialogue-1',
          sequence: 1,
          kind: 'dialogue' as const,
          speaker: '阿离',
          text: '我会守住这里。',
        }] : [],
      })),
    }],
  }
}

async function fixture(withNarration = true): Promise<{
  runtime: ApplicationRuntime
  speech: FixtureSpeechProvider
  input: ProjectNarratorVoicePreviewJobInput
  catalog: MiniMaxVoiceCatalog
}> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-project-narrator-preview-'))
  const speech = new FixtureSpeechProvider()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    enforcePaidAigcConfirmation: false,
    provider: new NoopImageProvider(),
    speechProvider: speech,
    keychain: new MemoryCredentialStore(),
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    autoStartWorker: false,
  })
  runtimes.push({ directory, runtime })
  runtime.storyRepository.ensureEpisode('default', {
    id: 'preview-episode',
    title: '项目旁白试听',
    sourceText: '阿离在断崖。',
    targetDurationSeconds: 30,
  })
  const applied = runtime.storyRepository.applyStory('preview-episode', story(withNarration))
  const provider = await runtime.providerService.save('minimax-speech', {
    apiKey: 'fixture-secret-that-must-not-leak',
    enabled: true,
  })
  await runtime.providerService.test('minimax-speech')
  const catalog: MiniMaxVoiceCatalog = {
    providerId: 'minimax-speech',
    providerConfigRevision: provider.configRevision,
    model: provider.model,
    observedAt: '2026-07-15T00:00:00.000Z',
    fingerprint: CATALOG_FINGERPRINT,
    voices: [{
      voiceId: 'voice-narrator',
      name: '项目旁白候选',
      descriptions: ['沉稳、克制'],
      type: 'system',
    }],
  }
  return {
    runtime,
    speech,
    catalog,
    input: {
      episodeId: 'preview-episode',
      expectedStoryRevisionId: applied.revision.id,
      voiceId: 'voice-narrator',
      expectedCatalogFingerprint: CATALOG_FINGERPRINT,
      expectedProviderConfigRevision: provider.configRevision,
    },
  }
}

function createDurableJob(
  runtime: ApplicationRuntime,
  input: ProjectNarratorVoicePreviewJobInput,
  providerState: JsonObject = {},
): GenerationJobRecord {
  return runtime.database.createGenerationJob({
    projectId: 'default',
    episodeId: input.episodeId,
    type: PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE,
    resourceType: 'project',
    resourceId: 'default',
    providerId: 'minimax-speech',
    providerConfigRevision: input.expectedProviderConfigRevision,
    model: 'speech-2.8-hd',
    idempotencyKey: `narrator-preview:${Math.random()}`,
    input: input as unknown as JsonObject,
    providerState,
  })
}

function publicAsset(asset: MediaAssetRecord): JsonObject {
  return {
    id: asset.id,
    projectId: asset.projectId,
    episodeId: asset.episodeId,
    kind: asset.kind,
    status: asset.status,
    mimeType: asset.mimeType,
    durationSeconds: asset.durationSeconds,
    source: asset.source,
    providerId: asset.providerId,
    generationJobId: asset.generationJobId,
    sourceRevisionId: asset.sourceRevisionId,
    url: `/api/v1/assets/${encodeURIComponent(asset.id)}/content`,
  }
}

function context(runtime: ApplicationRuntime, jobId: string): JobHandlerContext {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    async reportProgress() {},
    async waitingForProvider(state) {
      assert.ok(state && typeof state === 'object' && !Array.isArray(state))
      runtime.database.updateGenerationJob(jobId, { providerState: state as JsonObject })
    },
  }
}

test('server selects the current episode narration and uses a fixed fallback', async () => {
  const current = await fixture(true)
  const target = resolveProjectNarratorVoicePreviewTarget(current.runtime.database, {
    projectId: 'default', episodeId: 'preview-episode',
  })
  assert.equal(target.sampleText, '暮色笼罩断崖，远处第一盏灯亮了。')
  assert.equal(target.sampleSource, 'narration')

  const fallback = await fixture(false)
  const fallbackTarget = resolveProjectNarratorVoicePreviewTarget(fallback.runtime.database, {
    projectId: 'default', episodeId: 'preview-episode',
  })
  assert.equal(fallbackTarget.sampleText, PROJECT_NARRATOR_VOICE_PREVIEW_FALLBACK_TEXT)
  assert.equal(fallbackTarget.sampleSource, 'fallback')
})

test('explicit narrator preview persists an unbound asset and does not alter formal narration', async () => {
  const { runtime, speech, input, catalog } = await fixture()
  const job = createDurableJob(runtime, input)
  const handler = createProjectNarratorVoicePreviewHandler({
    database: runtime.database,
    mediaStore: runtime.mediaStore,
    providerService: runtime.providerService,
    voiceCatalogService: { list: async () => catalog },
    injectedProvider: speech,
    publicAsset,
    publishAsset() {},
  })
  const output = await handler(
    job as unknown as JobRecord<ProjectNarratorVoicePreviewJobInput>,
    context(runtime, job.id),
  )
  assert.equal(speech.calls.length, 1)
  assert.equal(speech.calls[0].text, '暮色笼罩断崖，远处第一盏灯亮了。')
  assert.equal(speech.calls[0].voiceId, 'voice-narrator')
  assert.equal((output.asset as JsonObject).kind, 'project.narrator.voice.preview')
  const persisted = runtime.database.getMediaAsset((output.asset as JsonObject).id as string)
  assert.equal(persisted?.sourceRevisionId, input.expectedStoryRevisionId)
  assert.equal(persisted?.generationJobId, job.id)

  const narration = runtime.database.withSql((sql) => sql.get(`
    SELECT speech_asset_id, voice_id
      FROM dialogue_lines
     WHERE kind = 'narration'
     LIMIT 1
  `))
  assert.equal(narration?.speech_asset_id, null)
  assert.equal(narration?.voice_id, null)
  assert.doesNotMatch(JSON.stringify(output), /fixture-secret-that-must-not-leak/)
  assert.doesNotMatch(JSON.stringify(output), /暮色笼罩断崖/)
})

test('a confirmed narrator preview rejection records a failed checkpoint for paid reconfirmation', async () => {
  const { runtime, input, catalog } = await fixture()
  const job = createDurableJob(runtime, input)
  const speech = new FixtureSpeechProvider(undefined, new MiniMaxSpeechError(
    'PROVIDER_USAGE_LIMIT_EXCEEDED',
    'MiniMax Token Plan 资源额度已用尽 (2056)',
    false,
    2056,
  ))
  const handler = createProjectNarratorVoicePreviewHandler({
    database: runtime.database,
    mediaStore: runtime.mediaStore,
    providerService: runtime.providerService,
    voiceCatalogService: { list: async () => catalog },
    injectedProvider: speech,
    publicAsset,
    publishAsset() {},
  })

  await assert.rejects(
    () => handler(
      job as unknown as JobRecord<ProjectNarratorVoicePreviewJobInput>,
      context(runtime, job.id),
    ),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === 'PROVIDER_USAGE_LIMIT_EXCEEDED',
  )
  const state = runtime.database.getGenerationJob(job.id)?.providerState
  assert.equal(state?.phase, 'failed')
  assert.equal(state?.providerFailureConfirmed, true)
  assert.equal(state?.providerStatus, 2056)
})

test('story/catalog drift and non-idempotent checkpoints block narrator TTS before charging', async () => {
  const { runtime, speech, input, catalog } = await fixture()
  runtime.storyRepository.applyStory('preview-episode', {
    ...story(true),
    title: '剧本已修改',
  })
  const staleJob = createDurableJob(runtime, input)
  const handler = createProjectNarratorVoicePreviewHandler({
    database: runtime.database,
    mediaStore: runtime.mediaStore,
    providerService: runtime.providerService,
    voiceCatalogService: { list: async () => catalog },
    injectedProvider: speech,
    publicAsset,
    publishAsset() {},
  })
  await assert.rejects(
    () => handler(
      staleJob as unknown as JobRecord<ProjectNarratorVoicePreviewJobInput>,
      context(runtime, staleJob.id),
    ),
    (error: unknown) => error instanceof JobExecutionError && error.code === 'STALE_SOURCE',
  )

  const fresh = await fixture()
  const checkpointJob = createDurableJob(fresh.runtime, fresh.input, {
    operation: PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE,
    phase: 'submitting',
    providerSupportsIdempotency: false,
  })
  const checkpointHandler = createProjectNarratorVoicePreviewHandler({
    database: fresh.runtime.database,
    mediaStore: fresh.runtime.mediaStore,
    providerService: fresh.runtime.providerService,
    voiceCatalogService: { list: async () => fresh.catalog },
    injectedProvider: fresh.speech,
    publicAsset,
    publishAsset() {},
  })
  await assert.rejects(
    () => checkpointHandler(
      checkpointJob as unknown as JobRecord<ProjectNarratorVoicePreviewJobInput>,
      context(fresh.runtime, checkpointJob.id),
    ),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
  )
  assert.equal(speech.calls.length, 0)
  assert.equal(fresh.speech.calls.length, 0)
})

test('paid narrator preview requires an exact confirmation before creating a Job', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-project-narrator-paid-preview-'))
  const speech = new FixtureSpeechProvider()
  let catalogCalls = 0
  const runtime = await createApplication({
    runtimeDirectory: directory,
    enforcePaidAigcConfirmation: true,
    provider: new NoopImageProvider(),
    speechProvider: speech,
    keychain: new MemoryCredentialStore(),
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    miniMaxVoiceCatalogFetch: async () => {
      catalogCalls += 1
      return new Response(JSON.stringify({
        base_resp: { status_code: 0, status_msg: 'success' },
        system_voice: [{
          voice_id: 'voice-narrator',
          voice_name: '项目旁白候选',
          description: ['沉稳、克制'],
        }],
        voice_cloning: [],
        voice_generation: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  runtimes.push({ directory, runtime })
  runtime.storyRepository.ensureEpisode('default', {
    id: 'paid-narrator-preview',
    title: '项目旁白付费预检',
    sourceText: '阿离在断崖。',
    targetDurationSeconds: 30,
  })
  runtime.storyRepository.applyStory('paid-narrator-preview', story(true))
  await runtime.providerService.save('minimax-speech', {
    apiKey: 'fixture-secret-that-must-not-leak',
    enabled: true,
  })
  await runtime.providerService.test('minimax-speech')
  const server = createServer(runtime.app)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const episodeResponse = await fetch(
      `${baseUrl}/api/v1/episodes/paid-narrator-preview?projectId=default`,
    )
    const etag = episodeResponse.headers.get('etag')
    assert.ok(etag)
    await episodeResponse.body?.cancel()
    const catalogResponse = await fetch(`${baseUrl}/api/v1/providers/minimax-speech/voices`)
    const catalog = await catalogResponse.json() as { fingerprint: string }
    const url = `${baseUrl}/api/v1/episodes/paid-narrator-preview/narrator-voice-previews`
    const body = JSON.stringify({
      projectId: 'default',
      voiceId: 'voice-narrator',
      expectedCatalogFingerprint: catalog.fingerprint,
    })
    const headers = {
      'content-type': 'application/json',
      'if-match': etag!,
      'idempotency-key': 'paid-narrator-preview',
    }
    const preflightResponse = await fetch(url, { method: 'POST', headers, body })
    const preflight = await preflightResponse.json() as {
      error: {
        code: string
        details: { confirmation: { action: string; confirmationToken: string } }
      }
    }
    assert.equal(preflightResponse.status, 409)
    assert.equal(preflight.error.code, 'PAID_CONFIRMATION_REQUIRED')
    assert.equal(preflight.error.details.confirmation.action, 'project.narrator.voice.preview')
    assert.equal(runtime.database.listGenerationJobs({
      projectId: 'default',
      type: PROJECT_NARRATOR_VOICE_PREVIEW_JOB_TYPE,
    }).length, 0)
    assert.equal(speech.calls.length, 0)

    const submittedResponse = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'x-manju-aigc-confirmation': preflight.error.details.confirmation.confirmationToken,
      },
      body,
    })
    const submitted = await submittedResponse.json() as { job: { id: string } }
    assert.equal(submittedResponse.status, 202)
    let terminal: { status?: string } | undefined
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/v1/jobs/${submitted.job.id}`)
      const value = await response.json() as { job: { status: string } }
      terminal = value.job
      if (['succeeded', 'failed', 'cancelled'].includes(value.job.status)) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(terminal?.status, 'succeeded')
    assert.equal(speech.calls.length, 1)
    assert.ok(catalogCalls >= 3, 'preflight, confirmation, and worker must re-read the free catalog')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('HTTP admission is ETag/catalog/idempotency guarded and returns a persisted playable asset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-project-narrator-preview-http-'))
  let releaseSpeech!: () => void
  const speechGate = new Promise<void>((resolve) => { releaseSpeech = resolve })
  const speech = new FixtureSpeechProvider(speechGate)
  const runtime = await createApplication({
    runtimeDirectory: directory,
    enforcePaidAigcConfirmation: false,
    provider: new NoopImageProvider(),
    speechProvider: speech,
    keychain: new MemoryCredentialStore(),
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    miniMaxVoiceCatalogFetch: async () => new Response(JSON.stringify({
      base_resp: { status_code: 0, status_msg: 'success' },
      system_voice: [{
        voice_id: 'voice-narrator',
        voice_name: '项目旁白候选',
        description: ['沉稳、克制'],
      }],
      voice_cloning: [],
      voice_generation: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  runtimes.push({ directory, runtime })
  runtime.storyRepository.ensureEpisode('default', {
    id: 'preview-episode',
    title: '项目旁白试听',
    sourceText: '阿离在断崖。',
    targetDurationSeconds: 30,
  })
  runtime.storyRepository.applyStory('preview-episode', story(true))
  await runtime.providerService.save('minimax-speech', {
    apiKey: 'fixture-secret-that-must-not-leak',
    enabled: true,
  })
  await runtime.providerService.test('minimax-speech')
  const server = createServer(runtime.app)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const episodeResponse = await fetch(`${baseUrl}/api/v1/episodes/preview-episode?projectId=default`)
    assert.equal(episodeResponse.status, 200)
    const etag = episodeResponse.headers.get('etag')
    assert.ok(etag)
    const catalogResponse = await fetch(`${baseUrl}/api/v1/providers/minimax-speech/voices`)
    const catalog = await catalogResponse.json() as { fingerprint: string }

    const request: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': etag,
        'idempotency-key': 'project-narrator-preview-http-1',
      },
      body: JSON.stringify({
        projectId: 'default',
        voiceId: 'voice-narrator',
        expectedCatalogFingerprint: catalog.fingerprint,
      }),
    }
    const createdResponse = await fetch(
      `${baseUrl}/api/v1/episodes/preview-episode/narrator-voice-previews`,
      request,
    )
    assert.equal(createdResponse.status, 202)
    const created = await createdResponse.json() as { job: { id: string; input: JsonObject } }
    assert.equal(created.job.input.expectedStoryRevisionId !== undefined, true)
    assert.equal(JSON.stringify(created).includes('暮色笼罩断崖'), false)
    assert.equal(JSON.stringify(created).includes('fixture-secret-that-must-not-leak'), false)

    const replayResponse = await fetch(
      `${baseUrl}/api/v1/episodes/preview-episode/narrator-voice-previews`,
      request,
    )
    assert.equal(replayResponse.status, 200)
    const replay = await replayResponse.json() as { job: { id: string } }
    assert.equal(replay.job.id, created.job.id)

    const duplicateResponse = await fetch(
      `${baseUrl}/api/v1/episodes/preview-episode/narrator-voice-previews`,
      {
        ...request,
        headers: {
          ...request.headers as Record<string, string>,
          'idempotency-key': 'project-narrator-preview-http-cross-tab',
        },
      },
    )
    const duplicate = await duplicateResponse.json() as {
      error: { code: string; details?: { existingJobId?: string } }
    }
    assert.equal(duplicateResponse.status, 409)
    assert.equal(duplicate.error.code, 'VOICE_PREVIEW_ALREADY_ACTIVE')
    assert.equal(duplicate.error.details?.existingJobId, created.job.id)
    releaseSpeech()

    let terminal: {
      job: {
        status: string
        output?: { asset: { id: string; kind: string; url: string } }
        error?: { message?: string }
      }
    } | undefined
    for (let index = 0; index < 100; index += 1) {
      const response = await fetch(`${baseUrl}/api/v1/jobs/${created.job.id}`)
      terminal = await response.json() as typeof terminal
      if (terminal?.job.status === 'succeeded' || terminal?.job.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(
      terminal?.job.status,
      'succeeded',
      terminal?.job.error?.message ?? 'project narrator preview did not reach a terminal success',
    )
    assert.equal(terminal?.job.output?.asset.kind, 'project.narrator.voice.preview')
    assert.match(terminal?.job.output?.asset.url ?? '', /^\/api\/v1\/assets\/.+\/content$/)
    assert.equal(speech.calls.length, 1, 'idempotent replay must not submit a second paid TTS request')
  } finally {
    releaseSpeech()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
})
