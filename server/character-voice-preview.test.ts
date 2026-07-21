import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import {
  CHARACTER_VOICE_PREVIEW_FALLBACK_TEXT,
  CHARACTER_VOICE_PREVIEW_JOB_TYPE,
  characterVoicePreviewText,
  createCharacterVoicePreviewHandler,
  resolvePublicCharacterVoicePreviewTarget,
  type CharacterVoicePreviewJobInput,
} from './character-voice-preview.js'
import type { GenerationJobRecord, MediaAssetRecord } from './database.js'
import type { KeychainCredentialSlot } from './keychain.js'
import type { MiniMaxVoiceCatalog } from './minimax-voice-catalog.js'
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
const CATALOG_FINGERPRINT = 'a'.repeat(64)

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

  constructor(private readonly failure?: MiniMaxSpeechError) {}

  async synthesize(input: MiniMaxSpeechInput): Promise<MiniMaxSpeechResult> {
    this.calls.push(structuredClone(input))
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

function story(withDialogue = true) {
  return {
    version: 1 as const,
    title: '声线试听',
    targetDurationSeconds: 30,
    bible: {
      logline: '阿离在断崖做出决定。',
      theme: '责任',
      tone: '克制',
      visualStyle: '国风动画',
    },
    characters: [{
      id: 'ali',
      name: '阿离',
      role: '主角',
      storyDescription: '年轻剑客',
      visualDescription: '黑发青衣',
    }],
    locations: [{
      id: 'cliff',
      name: '断崖',
      storyDescription: '长安城外',
      visualDescription: '云海与山石',
    }],
    props: [{
      id: 'token',
      name: '青铜令',
      description: '唤醒龙脉',
      visualDescription: '暗红纹路',
    }],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '断崖',
      locationId: 'cliff',
      timeOfDay: '黄昏',
      description: '风起云涌',
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
        dialogueLines: withDialogue && index === 0 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue' as const,
          speaker: '阿离',
          text: '我会守住这里，直到天亮。',
        }] : [],
      })),
    }],
  }
}

async function fixture(withDialogue = true): Promise<{
  runtime: ApplicationRuntime
  speech: FixtureSpeechProvider
  input: CharacterVoicePreviewJobInput
  catalog: MiniMaxVoiceCatalog
}> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-character-voice-preview-'))
  const speech = new FixtureSpeechProvider()
  const runtime = await createApplication({
    runtimeDirectory: directory,
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
    title: '声线试听',
    sourceText: '阿离在断崖。',
    targetDurationSeconds: 30,
  })
  const applied = runtime.storyRepository.applyStory('preview-episode', story(withDialogue))
  const target = resolvePublicCharacterVoicePreviewTarget(runtime.database, {
    projectId: 'default',
    episodeId: 'preview-episode',
    characterId: 'ali',
  })
  const provider = await runtime.providerService.save('minimax-speech', {
    apiKey: 'fixture-secret-that-must-not-leak',
    enabled: true,
  })
  await runtime.providerService.test('minimax-speech')
  const catalog: MiniMaxVoiceCatalog = {
    providerId: 'minimax-speech',
    providerConfigRevision: provider.configRevision,
    model: provider.model,
    observedAt: '2026-07-14T00:00:00.000Z',
    fingerprint: CATALOG_FINGERPRINT,
    voices: [{
      voiceId: 'voice-ali',
      name: '阿离候选',
      descriptions: ['沉静、坚定'],
      type: 'system',
    }],
  }
  return {
    runtime,
    speech,
    catalog,
    input: {
      episodeId: 'preview-episode',
      characterId: 'ali',
      characterDatabaseId: target.characterDatabaseId,
      expectedStoryRevisionId: applied.revision.id,
      voiceId: 'voice-ali',
      expectedCatalogFingerprint: CATALOG_FINGERPRINT,
      expectedProviderConfigRevision: provider.configRevision,
    },
  }
}

function createDurableJob(
  runtime: ApplicationRuntime,
  input: CharacterVoicePreviewJobInput,
  providerState: JsonObject = {},
): GenerationJobRecord {
  return runtime.database.createGenerationJob({
    projectId: 'default',
    episodeId: input.episodeId,
    type: CHARACTER_VOICE_PREVIEW_JOB_TYPE,
    resourceType: 'character',
    resourceId: input.characterDatabaseId,
    providerId: 'minimax-speech',
    providerConfigRevision: input.expectedProviderConfigRevision,
    model: 'speech-2.8-hd',
    idempotencyKey: `preview:${Math.random()}`,
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

function context(
  runtime: ApplicationRuntime,
  jobId: string,
): { value: JobHandlerContext; states: JsonObject[] } {
  const states: JsonObject[] = []
  const controller = new AbortController()
  return {
    states,
    value: {
      signal: controller.signal,
      async reportProgress() {},
      async waitingForProvider(state) {
        assert.ok(state && typeof state === 'object' && !Array.isArray(state))
        const safeState = state as JsonObject
        states.push(safeState)
        runtime.database.updateGenerationJob(jobId, { providerState: safeState })
      },
    },
  }
}

test('server selects and bounds actual character dialogue, with a fixed fallback', async () => {
  const withLine = await fixture(true)
  const target = resolvePublicCharacterVoicePreviewTarget(withLine.runtime.database, {
    projectId: 'default', episodeId: 'preview-episode', characterId: 'ali',
  })
  assert.equal(target.sampleText, '我会守住这里，直到天亮。')
  assert.equal(target.sampleSource, 'dialogue')

  const fallback = await fixture(false)
  const fallbackTarget = resolvePublicCharacterVoicePreviewTarget(fallback.runtime.database, {
    projectId: 'default', episodeId: 'preview-episode', characterId: 'ali',
  })
  assert.equal(fallbackTarget.sampleText, CHARACTER_VOICE_PREVIEW_FALLBACK_TEXT)
  assert.equal(fallbackTarget.sampleSource, 'fallback')

  const long = `  ${'声'.repeat(100)}  `
  assert.equal(Array.from(characterVoicePreviewText(long)).length, 72)
  assert.match(characterVoicePreviewText(long), /…$/)
})

test('explicit preview persists an unbound durable asset and never mutates formal dialogue speech', async () => {
  const { runtime, speech, input, catalog } = await fixture()
  const job = createDurableJob(runtime, input)
  const ctx = context(runtime, job.id)
  const published: string[] = []
  const handler = createCharacterVoicePreviewHandler({
    database: runtime.database,
    mediaStore: runtime.mediaStore,
    providerService: runtime.providerService,
    voiceCatalogService: { list: async () => catalog },
    injectedProvider: speech,
    publicAsset,
    publishAsset: (asset) => published.push(asset.id),
  })

  const output = await handler(job as unknown as JobRecord<CharacterVoicePreviewJobInput>, ctx.value)
  assert.equal(speech.calls.length, 1)
  assert.equal(speech.calls[0].text, '我会守住这里，直到天亮。')
  assert.equal(speech.calls[0].voiceId, 'voice-ali')
  assert.equal(speech.calls[0].subtitleEnable, false)
  assert.deepEqual(ctx.states.map((state) => state.phase), ['submitting', 'response-received'])

  const assetValue = output.asset as JsonObject
  assert.equal(assetValue.kind, 'character.voice.preview')
  assert.equal(assetValue.url, `/api/v1/assets/${assetValue.id}/content`)
  assert.deepEqual(published, [assetValue.id as string])
  const persisted = runtime.database.getMediaAsset(assetValue.id as string)
  assert.equal(persisted?.generationJobId, job.id)
  assert.equal(persisted?.sourceRevisionId, input.expectedStoryRevisionId)
  assert.equal(persisted?.filePath?.endsWith('.mp3'), true)

  const formalBinding = runtime.database.withSql((sql) => sql.get(`
    SELECT speech_asset_id, voice_id
    FROM dialogue_lines
    WHERE character_id = ?
  `, input.characterDatabaseId))
  assert.equal(formalBinding?.speech_asset_id, null)
  assert.equal(formalBinding?.voice_id, null)
  const character = runtime.database.withSql((sql) => sql.get(`
    SELECT json_extract(metadata_json, '$.voiceProfile') AS voice_profile
    FROM characters WHERE id = ?
  `, input.characterDatabaseId))
  assert.equal(character?.voice_profile, null)
  assert.doesNotMatch(JSON.stringify(output), /fixture-secret-that-must-not-leak/)
  assert.doesNotMatch(JSON.stringify(output), /我会守住这里/)
})

test('a confirmed character preview rejection records a failed checkpoint for paid reconfirmation', async () => {
  const { runtime, input, catalog } = await fixture()
  const job = createDurableJob(runtime, input)
  const ctx = context(runtime, job.id)
  const speech = new FixtureSpeechProvider(new MiniMaxSpeechError(
    'PROVIDER_RATE_LIMITED',
    'MiniMax 语音服务受到资源限制 (429)',
    true,
    429,
  ))
  const handler = createCharacterVoicePreviewHandler({
    database: runtime.database,
    mediaStore: runtime.mediaStore,
    providerService: runtime.providerService,
    voiceCatalogService: { list: async () => catalog },
    injectedProvider: speech,
    publicAsset,
    publishAsset() {},
  })

  await assert.rejects(
    () => handler(job as unknown as JobRecord<CharacterVoicePreviewJobInput>, ctx.value),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === 'PROVIDER_RATE_LIMITED',
  )
  assert.deepEqual(ctx.states.map((state) => state.phase), ['submitting', 'failed'])
  assert.equal(ctx.states[1].providerFailureConfirmed, true)
  assert.equal(ctx.states[1].providerStatus, 429)
})

test('catalog change is checked before paid TTS', async () => {
  const { runtime, speech, input, catalog } = await fixture()
  const job = createDurableJob(runtime, input)
  const ctx = context(runtime, job.id)
  const handler = createCharacterVoicePreviewHandler({
    database: runtime.database,
    mediaStore: runtime.mediaStore,
    providerService: runtime.providerService,
    voiceCatalogService: { list: async () => ({ ...catalog, fingerprint: 'b'.repeat(64) }) },
    injectedProvider: speech,
    publicAsset,
    publishAsset() {},
  })
  await assert.rejects(
    () => handler(job as unknown as JobRecord<CharacterVoicePreviewJobInput>, ctx.value),
    (error: unknown) => error instanceof JobExecutionError && error.code === 'VOICE_CATALOG_CHANGED',
  )
  assert.equal(speech.calls.length, 0)
  assert.equal(ctx.states.length, 0)
})

test('recovery after a non-idempotent submission checkpoint fails closed without duplicate charge', async () => {
  const { runtime, speech, input, catalog } = await fixture()
  const providerState: JsonObject = {
    operation: CHARACTER_VOICE_PREVIEW_JOB_TYPE,
    phase: 'submitting',
    providerSupportsIdempotency: false,
  }
  const job = createDurableJob(runtime, input, providerState)
  const ctx = context(runtime, job.id)
  const handler = createCharacterVoicePreviewHandler({
    database: runtime.database,
    mediaStore: runtime.mediaStore,
    providerService: runtime.providerService,
    voiceCatalogService: { list: async () => catalog },
    injectedProvider: speech,
    publicAsset,
    publishAsset() {},
  })
  await assert.rejects(
    () => handler(job as unknown as JobRecord<CharacterVoicePreviewJobInput>, ctx.value),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
  )
  assert.equal(speech.calls.length, 0)
  assert.equal(ctx.states.length, 0)
})

test('recovery reuses an already-committed preview asset without resubmitting TTS', async () => {
  const { runtime, speech, input, catalog } = await fixture()
  const providerState: JsonObject = {
    operation: CHARACTER_VOICE_PREVIEW_JOB_TYPE,
    phase: 'response-received',
    providerSupportsIdempotency: false,
  }
  const job = createDurableJob(runtime, input, providerState)
  const asset = await runtime.mediaStore.save({
    projectId: 'default',
    episodeId: input.episodeId,
    kind: 'character.voice.preview',
    bytes: MP3_BYTES,
    mimeType: 'audio/mpeg',
    source: 'provider',
    providerId: 'minimax-speech',
    generationJobId: job.id,
    generationParameters: {
      characterId: input.characterId,
      voiceId: input.voiceId,
      catalogFingerprint: input.expectedCatalogFingerprint,
      sampleSource: 'dialogue',
      sampleCharacterCount: 12,
    },
    sourceRevisionId: input.expectedStoryRevisionId,
    durationSeconds: 0.9,
  })
  const published: string[] = []
  const handler = createCharacterVoicePreviewHandler({
    database: runtime.database,
    mediaStore: runtime.mediaStore,
    providerService: runtime.providerService,
    voiceCatalogService: { list: async () => catalog },
    injectedProvider: speech,
    publicAsset,
    publishAsset: (value) => published.push(value.id),
  })
  const output = await handler(
    job as unknown as JobRecord<CharacterVoicePreviewJobInput>,
    context(runtime, job.id).value,
  )
  assert.equal(speech.calls.length, 0)
  assert.equal((output.asset as JsonObject).id, asset.id)
  assert.deepEqual(published, [asset.id])
})

test('disabled or rotated current MiniMax head blocks a queued preview before paid TTS', async () => {
  for (const change of ['disable', 'rotate'] as const) {
    const { runtime, speech, input, catalog } = await fixture()
    const job = createDurableJob(runtime, input)
    if (change === 'disable') {
      await runtime.providerService.save('minimax-speech', { enabled: false })
    } else {
      await runtime.providerService.save('minimax-speech', {
        apiKey: 'rotated-fixture-secret',
        enabled: true,
      })
      await runtime.providerService.test('minimax-speech')
    }
    const ctx = context(runtime, job.id)
    const handler = createCharacterVoicePreviewHandler({
      database: runtime.database,
      mediaStore: runtime.mediaStore,
      providerService: runtime.providerService,
      // Simulate a catalog response already obtained immediately before the
      // settings change; the provider head recheck remains authoritative.
      voiceCatalogService: { list: async () => catalog },
      injectedProvider: speech,
      publicAsset,
      publishAsset() {},
    })
    await assert.rejects(
      () => handler(job as unknown as JobRecord<CharacterVoicePreviewJobInput>, ctx.value),
      (error: unknown) => error instanceof JobExecutionError
        && (error.code === 'PROVIDER_NOT_CONFIGURED'
          || error.code === 'PROVIDER_NOT_VERIFIED'
          || error.code === 'VOICE_PROVIDER_CHANGED'),
    )
    assert.equal(speech.calls.length, 0, `${change} must not submit TTS`)
    assert.equal(ctx.states.length, 0, `${change} must not enter paid checkpoint`)
  }
})
