import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import { characterVoiceCatalogFingerprint } from './character-voice-recommendation.js'
import { episodeEtag, versionTokenFromEtag } from './episode-version.js'
import type { KeychainCredentialSlot } from './keychain.js'
import type { MiniMaxSubtitleLoader } from './minimax-subtitle.js'
import { LINE_PERFORMANCE_RECOMMENDATION_VERSION } from './line-performance.js'
import { providerPlatformCostPolicy } from './provider-cost-policy.js'
import {
  MiniMaxSpeechError,
  type MiniMaxSpeechInput,
  type MiniMaxSpeechResult,
  type SpeechProvider,
} from './providers/minimax-tts.js'
import type { ProviderCredentialStore } from './providers/service.js'
import type { StoryCharacterVoiceProfile } from './story-schema.js'
import type { ImageGenerationInput, ImageProvider, ProviderImage } from './types.js'

const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
const TEST_VOICE_CATALOG = [{
  voiceId: 'ali-account-voice',
  voiceName: '阿离自有音色',
  descriptions: ['年轻', '克制'],
  type: 'voice_cloning' as const,
}]
const TEST_VOICE_CATALOG_FINGERPRINT = characterVoiceCatalogFingerprint(TEST_VOICE_CATALOG)

function voiceCatalogResponse(voiceId = 'ali-account-voice'): Response {
  const matched = TEST_VOICE_CATALOG.find((voice) => voice.voiceId === voiceId)
  return new Response(JSON.stringify({
    base_resp: { status_code: 0, status_msg: 'success' },
    system_voice: [],
    voice_cloning: [{
      voice_id: voiceId,
      voice_name: matched?.voiceName ?? voiceId,
      description: matched?.descriptions ?? ['changed'],
    }],
    voice_generation: [],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

class NoopImageProvider implements ImageProvider {
  readonly name = 'noop-image'
  readonly model = 'noop-image'
  readonly configured = true

  async health() {
    return { status: 'ok' as const, message: 'ready' }
  }

  async generate(_input: ImageGenerationInput): Promise<ProviderImage[]> {
    throw new Error('Image generation is not used by speech tests')
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

type SpeechBehavior =
  | 'success'
  | 'subtitle-success'
  | 'provider-error'
  | 'provider-confirmed-error'
  | 'provider-timeout-response'
  | 'wait-for-cancel'

class FixtureSpeechProvider implements SpeechProvider {
  readonly name = 'minimax-speech'
  readonly model = 'speech-2.8-hd'
  readonly configured = true
  readonly calls: MiniMaxSpeechInput[] = []
  beforeResponse?: () => void | Promise<void>

  constructor(readonly behavior: SpeechBehavior = 'success') {}

  async synthesize(input: MiniMaxSpeechInput, signal?: AbortSignal): Promise<MiniMaxSpeechResult> {
    this.calls.push(structuredClone(input))
    if (this.behavior === 'provider-error') {
      throw new MiniMaxSpeechError('UPSTREAM_UNAVAILABLE', 'MiniMax 语音服务暂时不可用', true)
    }
    if (this.behavior === 'provider-confirmed-error') {
      throw new MiniMaxSpeechError(
        'PROVIDER_USAGE_LIMIT_EXCEEDED',
        'MiniMax Token Plan 资源额度已用尽 (2056)',
        false,
        2056,
      )
    }
    if (this.behavior === 'provider-timeout-response') {
      throw new MiniMaxSpeechError(
        'UPSTREAM_TIMEOUT',
        'MiniMax 语音服务响应超时',
        true,
        504,
      )
    }
    if (this.behavior === 'wait-for-cancel') {
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    await this.beforeResponse?.()
    return {
      audio: { kind: 'bytes', bytes: MP3_BYTES, sourceEncoding: 'hex' },
      format: 'mp3',
      mimeType: 'audio/mpeg',
      durationMs: 1_250,
      sampleRate: 32_000,
      bitrate: 128_000,
      channels: 1,
      audioSizeBytes: MP3_BYTES.byteLength,
      usageCharacters: [...input.text].length,
      ...(this.behavior === 'subtitle-success' ? {
        subtitle: {
          url: 'https://cdn.minimax.io/fixture.titles?token=must-not-persist',
          granularity: 'word' as const,
        },
      } : {}),
    }
  }
}

function voiceProfile(
  providerConfigRevision: number,
  options: { voiceId?: string; historicalPin?: boolean } = {},
): StoryCharacterVoiceProfile {
  return {
    version: 1,
    voiceId: options.voiceId ?? 'ali-account-voice',
    providerId: 'minimax-speech',
    providerConfigRevision,
    voiceType: 'voice_cloning',
    voiceName: '阿离自有音色',
    descriptions: ['年轻', '克制'],
    selectionSource: 'manual',
    defaultDelivery: { emotion: 'calm', speed: 0.95, pitch: 0 },
    sceneDirections: [{
      sceneId: 'scene-1',
      emotion: 'whisper',
      speed: 0.82,
      pitch: -1,
      rationale: '断崖龙吟后压低声音。',
    }],
    catalogFingerprint: TEST_VOICE_CATALOG_FINGERPRINT,
    catalogObservedAt: '2026-07-14T00:00:00.000Z',
    historicalPin: options.historicalPin ?? false,
    updatedAt: new Date().toISOString(),
  }
}

function saveVoiceProfile(
  runtime: ApplicationRuntime,
  episodeId: string,
  profile: StoryCharacterVoiceProfile,
) {
  const episode = runtime.storyRepository.getEpisode(episodeId)
  assert.ok(episode)
  return runtime.characterVoiceProfiles.save({
    projectId: 'default',
    episodeId,
    characterId: 'ali',
    expectedEpisodeVersion: versionTokenFromEtag(episodeEtag(episode))!,
    profile,
  })
}

function saveLinePerformance(
  runtime: ApplicationRuntime,
  episodeId: string,
  databaseLineId: string,
  recommendationJobId: string,
  options: { afterCharacter?: number; durationSeconds?: number } = {},
) {
  const episode = runtime.storyRepository.getEpisode(episodeId)
  assert.ok(episode?.sourceRevisionId)
  const state = runtime.linePerformanceProfiles.getState('default', episodeId, 'line-1')
  const voice = runtime.characterVoiceProfiles.get('default', episodeId, 'ali')
  assert.ok(voice)
  return runtime.linePerformanceProfiles.save({
    projectId: 'default',
    episodeId,
    lineId: 'line-1',
    databaseLineId,
    expectedSourceRevisionId: episode.sourceRevisionId,
    expectedEtag: state.etag,
    voiceProfileRevisionId: voice.revisionId,
    recommendationJobId,
    recommendation: {
      version: LINE_PERFORMANCE_RECOMMENDATION_VERSION,
      lineId: 'line-1',
      emotion: 'surprised',
      speed: 0.8,
      pitch: 1,
      openingSoundTag: '(gasps)',
      pausePlan: [{
        afterCharacter: options.afterCharacter ?? 1,
        durationSeconds: options.durationSeconds ?? 0.8,
      }],
      rationale: '先震惊吸气，再用停顿表现难以置信。',
    },
  })
}

interface RunningFixture {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
  speech: FixtureSpeechProvider
  compatibleRequests?: Array<{ url: string; init?: RequestInit }>
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
  behavior: SpeechBehavior = 'success',
  speechSubtitleLoader?: MiniMaxSubtitleLoader,
): Promise<RunningFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-speech-test-'))
  const speech = new FixtureSpeechProvider(behavior)
  const runtime = await createApplication({
    runtimeDirectory: directory,
    enforcePaidAigcConfirmation: false,
    provider: new NoopImageProvider(),
    speechProvider: speech,
    ...(speechSubtitleLoader ? { speechSubtitleLoader } : {}),
    miniMaxVoiceCatalogFetch: async () => voiceCatalogResponse(),
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    keychain: new MemoryCredentialStore(),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
  })
  const server = createServer(runtime.app)
  const running = { directory, runtime, server, baseUrl: await listen(server), speech }
  fixtures.push(running)
  return running
}

async function compatibleSpeechFixture(): Promise<RunningFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-compatible-speech-test-'))
  const speech = new FixtureSpeechProvider()
  const compatibleRequests: Array<{ url: string; init?: RequestInit }> = []
  const runtime = await createApplication({
    runtimeDirectory: directory,
    enforcePaidAigcConfirmation: false,
    provider: new NoopImageProvider(),
    speechProvider: speech,
    miniMaxVoiceCatalogFetch: async () => voiceCatalogResponse(),
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    speechCompatibleFetch: async (url, init) => {
      compatibleRequests.push({ url: String(url), init })
      return new Response(MP3_BYTES, { headers: { 'content-type': 'audio/mpeg' } })
    },
    speechAudioDurationProbe: async () => 1.5,
    keychain: new MemoryCredentialStore(),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
  })
  const server = createServer(runtime.app)
  const running = {
    directory,
    runtime,
    server,
    baseUrl: await listen(server),
    speech,
    compatibleRequests,
  }
  fixtures.push(running)
  return running
}

async function paidSpeechFixture(
  catalogFetch: typeof fetch = async () => voiceCatalogResponse(),
): Promise<RunningFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-paid-speech-test-'))
  const speech = new FixtureSpeechProvider()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    autoStartWorker: false,
    provider: new NoopImageProvider(),
    speechProvider: speech,
    miniMaxVoiceCatalogFetch: catalogFetch,
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    keychain: new MemoryCredentialStore(),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
  })
  const server = createServer(runtime.app)
  const running = { directory, runtime, server, baseUrl: await listen(server), speech }
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

async function json<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init)
  return { response, body: await response.json() as T }
}

async function terminalJob(baseUrl: string, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await json<{ job: Record<string, unknown> }>(`${baseUrl}/api/v1/jobs/${id}`)
    if (['succeeded', 'failed', 'cancelled'].includes(String(result.body.job.status))) return result.body.job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Job did not finish: ${id}`)
}

async function waitForJobStatus(baseUrl: string, id: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await json<{ job: Record<string, unknown> }>(`${baseUrl}/api/v1/jobs/${id}`)
    if (result.body.job.status === expected) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Job did not reach ${expected}: ${id}`)
}

function validStory() {
  return {
    version: 1 as const,
    title: '龙脉初醒',
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
        visualPrompt: '国风动画，断崖黄昏云海，电影构图。',
        dialogueLines: index === 2 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue' as const,
          speaker: '阿离',
          text: '它醒了。',
        }] : [],
      })),
    }],
  }
}

function prepareStory(runtime: ApplicationRuntime): { episodeId: string; databaseLineId: string } {
  const episodeId = 'speech-episode'
  runtime.storyRepository.ensureEpisode('default', {
    id: episodeId,
    title: '龙脉初醒',
    sourceText: '少女听见龙吟。',
    targetDurationSeconds: 30,
  })
  runtime.storyRepository.applyStory(episodeId, validStory())
  const line = runtime.database.withSql((sql) => sql.get(`
    SELECT dialogue_lines.id
    FROM dialogue_lines
    JOIN shots ON shots.id = dialogue_lines.shot_id
    JOIN scenes ON scenes.id = shots.scene_id
    WHERE scenes.episode_id = ?
      AND json_extract(dialogue_lines.metadata_json, '$.storyId') = 'line-1'
  `, episodeId))
  const databaseLineId = line?.id
  assert.equal(typeof databaseLineId, 'string')
  return { episodeId, databaseLineId: databaseLineId as string }
}

async function configureMiniMax(runtime: ApplicationRuntime): Promise<number> {
  const provider = await runtime.providerService.save('minimax-speech', {
    apiKey: 'fixture-speech-secret',
    enabled: true,
  })
  await runtime.providerService.test('minimax-speech')
  return provider.configRevision
}

function speechRequest(episodeId: string, overrides: Record<string, unknown> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'speech-line-1-v1' },
    body: JSON.stringify({
      projectId: 'default',
      episodeId,
      voiceId: 'female-shaonv',
      speed: 1,
      volume: 1,
      pitch: 0,
      emotion: 'calm',
      format: 'mp3',
      ...overrides,
    }),
  }
}

test('speech generation persists and links a public asset without exposing dialogue or credentials', async () => {
  const { baseUrl, runtime, speech } = await fixture()
  const { episodeId, databaseLineId } = prepareStory(runtime)
  const configRevision = await configureMiniMax(runtime)

  const submitted = await json<{ job: { id: string; providerId: string; model: string; providerConfigRevision: number } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId),
  )
  assert.equal(submitted.response.status, 202)
  assert.equal(submitted.body.job.providerId, 'minimax-speech')
  assert.equal(submitted.body.job.model, 'speech-2.8-hd')
  assert.equal(submitted.body.job.providerConfigRevision, configRevision)

  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'succeeded')
  assert.equal(speech.calls.length, 1)
  assert.equal(speech.calls[0].text, '它醒了。')
  assert.equal(speech.calls[0].outputFormat, 'hex')
  assert.equal(speech.calls[0].subtitleEnable, true)
  assert.equal(speech.calls[0].subtitleType, 'word')
  const output = completed.output as {
    dialogueLineId: string
    asset: { id: string; kind: string; url: string; filePath?: string; generationParameters?: unknown }
  }
  assert.equal(output.dialogueLineId, 'line-1')
  assert.equal(output.asset.kind, 'speech')
  assert.equal(output.asset.url, `/api/v1/assets/${output.asset.id}/content`)
  assert.equal(output.asset.filePath, undefined)
  assert.equal(output.asset.generationParameters, undefined)

  const linked = runtime.database.withSql((sql) => sql.get(`
    SELECT speech_asset_id, voice_id, duration_seconds
    FROM dialogue_lines WHERE id = ?
  `, databaseLineId))
  assert.equal(linked?.speech_asset_id, output.asset.id)
  assert.equal(linked?.voice_id, 'female-shaonv')
  assert.equal(linked?.duration_seconds, 1.25)
  assert.equal(runtime.database.getMediaAsset(output.asset.id)?.generationJobId, submitted.body.job.id)
  assert.deepEqual(runtime.database.getGenerationJob(submitted.body.job.id)?.cost, {
    providerId: 'minimax-speech',
    model: 'speech-2.8-hd',
    unit: 'characters',
    usageCharacters: 4,
    currency: null,
    amount: null,
    platformPolicy: providerPlatformCostPolicy('speech'),
  })
  assert.deepEqual(runtime.database.getMediaAsset(output.asset.id)?.generationParameters, {
    lineId: 'line-1',
    voiceId: 'female-shaonv',
    speed: 1,
    format: 'mp3',
    adapter: 'minimax',
    volume: 1,
    pitch: 0,
    emotion: 'calm',
    sampleRate: 32_000,
    bitrate: 128_000,
    channels: 1,
    usageCharacters: 4,
    subtitle: {
      mode: 'sentence-fallback',
      reason: 'provider-returned-no-sidecar',
    },
  })

  const content = await fetch(`${baseUrl}${output.asset.url}`)
  assert.equal(content.status, 200)
  assert.equal(content.headers.get('content-type'), 'audio/mpeg')
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), MP3_BYTES)

  const serialized = JSON.stringify(completed)
  assert.doesNotMatch(serialized, /它醒了/)
  assert.doesNotMatch(serialized, /fixture-speech-secret/)
  const assetEvents = runtime.eventHub.since().filter((event) => event.type === 'asset.created')
  assert.equal(assetEvents.length, 1)
  assert.doesNotMatch(JSON.stringify(assetEvents[0]), /它醒了|fixture-speech-secret/)
})

test('speech inherits the audited character timbre and scene direction while disabled providers block billing', async () => {
  const { baseUrl, runtime, speech } = await fixture()
  const { episodeId } = prepareStory(runtime)
  const configRevision = await configureMiniMax(runtime)
  const saved = saveVoiceProfile(runtime, episodeId, voiceProfile(configRevision))

  await runtime.providerService.save('minimax-speech', { enabled: false })
  const disabled = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'inherited-disabled' },
      body: JSON.stringify({ projectId: 'default', episodeId, format: 'mp3' }),
    },
  )
  assert.equal(disabled.response.status, 409)
  assert.equal(disabled.body.error.code, 'CHARACTER_VOICE_PROVIDER_DISABLED')
  assert.equal(speech.calls.length, 0)
  assert.equal(runtime.database.findGenerationJobByIdempotencyKey('default', 'inherited-disabled'), undefined)

  await runtime.providerService.save('minimax-speech', { enabled: true })
  const submitted = await json<{ job: { id: string; input: Record<string, unknown> } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'inherited-success' },
      body: JSON.stringify({ projectId: 'default', episodeId, format: 'mp3' }),
    },
  )
  assert.equal(submitted.response.status, 202)
  assert.equal(submitted.body.job.input.inheritedVoiceProfileRevisionId, saved.revision.id)
  assert.equal((await terminalJob(baseUrl, submitted.body.job.id)).status, 'succeeded')
  assert.equal(speech.calls.length, 1)
  assert.deepEqual({
    voiceId: speech.calls[0].voiceId,
    speed: speech.calls[0].speed,
    pitch: speech.calls[0].pitch,
    emotion: speech.calls[0].emotion,
  }, {
    voiceId: 'ali-account-voice',
    speed: 0.82,
    pitch: -1,
    emotion: 'whisper',
  })
})

test('an inherited speech result never binds after the character voice revision changes mid-request', async () => {
  const { baseUrl, runtime, speech } = await fixture()
  const { episodeId, databaseLineId } = prepareStory(runtime)
  const configRevision = await configureMiniMax(runtime)
  const initial = saveVoiceProfile(runtime, episodeId, voiceProfile(configRevision))
  speech.beforeResponse = () => {
    saveVoiceProfile(runtime, episodeId, voiceProfile(configRevision, { voiceId: 'ali-new-voice' }))
  }

  const submitted = await json<{ job: { id: string; input: Record<string, unknown> } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'inherited-cas-race' },
      body: JSON.stringify({ projectId: 'default', episodeId, format: 'mp3' }),
    },
  )
  assert.equal(submitted.body.job.input.inheritedVoiceProfileRevisionId, initial.revision.id)
  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'STALE_CHARACTER_VOICE')
  assert.equal(speech.calls.length, 1)
  const line = runtime.database.withSql((sql) => sql.get(
    'SELECT speech_asset_id, voice_id FROM dialogue_lines WHERE id = ?',
    databaseLineId,
  ))
  assert.equal(line?.speech_asset_id, null)
  assert.equal(line?.voice_id, null)
  const assets = runtime.database.listMediaAssets({
    projectId: 'default',
    episodeId,
    kind: 'speech',
  })
  assert.equal(assets.length, 1)
  assert.equal(assets[0].status, 'stale')
})

test('a queued inherited speech job rechecks the profile revision before Provider access', async () => {
  const { baseUrl, runtime, speech } = await fixture()
  const { episodeId } = prepareStory(runtime)
  const configRevision = await configureMiniMax(runtime)
  saveVoiceProfile(runtime, episodeId, voiceProfile(configRevision))
  await runtime.worker.stop()

  const submitted = await json<{ job: { id: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'inherited-preflight-cas' },
      body: JSON.stringify({ projectId: 'default', episodeId, format: 'mp3' }),
    },
  )
  assert.equal(submitted.response.status, 202)
  saveVoiceProfile(runtime, episodeId, voiceProfile(configRevision, { voiceId: 'ali-new-voice' }))
  assert.equal(runtime.database.getGenerationJob(submitted.body.job.id)?.status, 'queued')

  await runtime.worker.start()
  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'STALE_CHARACTER_VOICE')
  assert.equal(speech.calls.length, 0)
})

test('confirmed per-line AI performance compiles controlled markup while public subtitles retain the original line', async () => {
  const { baseUrl, runtime, speech } = await fixture()
  const { episodeId, databaseLineId } = prepareStory(runtime)
  const configRevision = await configureMiniMax(runtime)
  saveVoiceProfile(runtime, episodeId, voiceProfile(configRevision))
  const performance = saveLinePerformance(
    runtime,
    episodeId,
    databaseLineId,
    'director-job-1',
  )

  const submitted = await json<{ job: { id: string; input: Record<string, unknown> } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'performance-speech-v1' },
      body: JSON.stringify({ projectId: 'default', episodeId, format: 'mp3' }),
    },
  )
  assert.equal(submitted.response.status, 202)
  assert.equal(
    submitted.body.job.input.inheritedPerformanceRevisionId,
    performance.revision.id,
  )
  assert.equal(submitted.body.job.input.compiledText, undefined)
  const durable = runtime.database.getGenerationJob(submitted.body.job.id)
  assert.equal(durable?.input.compiledText, '(gasps)它<#0.80#>醒了。')

  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'succeeded')
  assert.equal(speech.calls.length, 1)
  assert.equal(speech.calls[0].text, '(gasps)它<#0.80#>醒了。')
  assert.deepEqual({
    speed: speech.calls[0].speed,
    pitch: speech.calls[0].pitch,
    emotion: speech.calls[0].emotion,
  }, { speed: 0.8, pitch: 1, emotion: 'surprised' })
  const output = completed.output as { asset: { id: string } }
  const asset = runtime.database.getMediaAsset(output.asset.id)
  assert.equal(asset?.generationParameters.annotatedText, '(gasps)它<#0.80#>醒了。')
  assert.equal(asset?.generationParameters.inheritedPerformanceRevisionId, performance.revision.id)
  assert.deepEqual(asset?.generationParameters.subtitle, {
    mode: 'sentence-fallback',
    reason: 'line-performance-original-text',
  })
})

test('tampered compiled performance text is rejected before TTS and never billed', async () => {
  const { baseUrl, runtime, speech } = await fixture()
  const { episodeId, databaseLineId } = prepareStory(runtime)
  const configRevision = await configureMiniMax(runtime)
  saveVoiceProfile(runtime, episodeId, voiceProfile(configRevision))
  saveLinePerformance(runtime, episodeId, databaseLineId, 'director-job-tamper')
  await runtime.worker.stop()

  const submitted = await json<{ job: { id: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'performance-tamper-v1' },
      body: JSON.stringify({ projectId: 'default', episodeId, format: 'mp3' }),
    },
  )
  assert.equal(submitted.response.status, 202)
  const durable = runtime.database.getGenerationJob(submitted.body.job.id)
  assert.ok(durable)
  runtime.database.withSql((sql) => sql.run(
    'UPDATE generation_jobs SET input_json = ? WHERE id = ?',
    JSON.stringify({ ...durable.input, compiledText: '(gasps)它<#0.80#>睡了。' }),
    durable.id,
  ))
  await runtime.worker.start()
  const completed = await terminalJob(baseUrl, durable.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'LINE_PERFORMANCE_BINDING_CONFLICT')
  assert.equal(speech.calls.length, 0)
})

test('MiniMax word timestamps are downloaded, validated, persisted without the ephemeral URL, and exposed to later timeline work', async () => {
  const subtitleSources: string[] = []
  const { baseUrl, runtime, speech } = await fixture('subtitle-success', async (source) => {
    subtitleSources.push(source.url)
    return [
      { text: '它', startMs: 0, endMs: 300 },
      { text: '醒了', startMs: 300, endMs: 900 },
    ]
  })
  const { episodeId } = prepareStory(runtime)
  await configureMiniMax(runtime)

  const submitted = await json<{ job: { id: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId),
  )
  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'succeeded')
  assert.equal(speech.calls[0].subtitleEnable, true)
  assert.deepEqual(subtitleSources, [
    'https://cdn.minimax.io/fixture.titles?token=must-not-persist',
  ])
  const output = completed.output as { asset: { id: string } }
  const asset = runtime.database.getMediaAsset(output.asset.id)
  assert.deepEqual(asset?.generationParameters.subtitle, {
    mode: 'word',
    granularity: 'word',
    cues: [
      { text: '它', startMs: 0, endMs: 300 },
      { text: '醒了', startMs: 300, endMs: 900 },
    ],
  })
  assert.doesNotMatch(
    `${JSON.stringify(asset)}\n${JSON.stringify(runtime.database.getGenerationJob(submitted.body.job.id))}`,
    /must-not-persist|cdn\.minimax/,
  )

  const publicResponse = await fetch(`${baseUrl}/api/v1/assets/${output.asset.id}`)
  assert.equal(publicResponse.status, 200)
  const publicBody = await publicResponse.json() as {
    asset: { speechSubtitle?: unknown; generationParameters?: unknown; filePath?: unknown }
  }
  assert.deepEqual(publicBody.asset.speechSubtitle, {
    version: 1,
    lineId: 'line-1',
    mode: 'word',
    granularity: 'word',
    cues: [
      { text: '它', startMs: 0, endMs: 300 },
      { text: '醒了', startMs: 300, endMs: 900 },
    ],
  })
  assert.equal(publicBody.asset.generationParameters, undefined)
  assert.equal(publicBody.asset.filePath, undefined)
  assert.doesNotMatch(JSON.stringify(publicBody), /must-not-persist|cdn\.minimax/)
})

test('speech generation is idempotent and rejects reuse with different parameters', async () => {
  const { baseUrl, runtime, speech } = await fixture()
  const { episodeId } = prepareStory(runtime)
  await configureMiniMax(runtime)

  const first = await json<{ job: { id: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId),
  )
  assert.equal(first.response.status, 202)
  await terminalJob(baseUrl, first.body.job.id)

  const duplicate = await json<{ job: { id: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId),
  )
  assert.equal(duplicate.response.status, 200)
  assert.equal(duplicate.body.job.id, first.body.job.id)
  assert.equal(speech.calls.length, 1)

  const conflict = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId, { pitch: 2 }),
  )
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(speech.calls.length, 1)
})

test('paid inherited speech rechecks the real voice catalog before enqueue and replays without another token', async () => {
  let catalogCalls = 0
  let changedCatalogCall = 3
  const { baseUrl, runtime, speech } = await paidSpeechFixture(async () => {
    catalogCalls += 1
    return catalogCalls === changedCatalogCall
      ? voiceCatalogResponse('voice-removed-after-confirmation')
      : voiceCatalogResponse()
  })
  const { episodeId } = prepareStory(runtime)
  const configRevision = await configureMiniMax(runtime)
  const voice = saveVoiceProfile(runtime, episodeId, voiceProfile(configRevision))

  type PaidSpeechResponse = {
    error?: {
      code: string
      details?: {
        confirmation?: {
          action: string
          provider: { providerId: string; model: string; configRevision: number }
          confirmationToken: string
        }
      }
    }
    job?: { id: string; input: Record<string, unknown> }
  }
  const post = (key: string, confirmationToken?: string) => json<PaidSpeechResponse>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        ...(confirmationToken ? { 'x-manju-aigc-confirmation': confirmationToken } : {}),
      },
      body: JSON.stringify({ projectId: 'default', episodeId, format: 'mp3' }),
    },
  )

  const preflight = await post('paid-inherited-speech')
  assert.equal(preflight.response.status, 409)
  assert.equal(preflight.body.error?.code, 'PAID_CONFIRMATION_REQUIRED')
  const challenge = preflight.body.error?.details?.confirmation
  assert.equal(challenge?.action, 'dialogue.speech.generate')
  assert.deepEqual(challenge?.provider, {
    providerId: 'minimax-speech',
    model: 'speech-2.8-hd',
    configRevision,
  })
  assert.match(challenge?.confirmationToken ?? '', /^aigcpf1_[1-9][0-9]{9,12}_[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(preflight.body), /它醒了|ali-account-voice/)
  assert.equal(runtime.database.listGenerationJobs({ type: 'dialogue.speech.generate' }).length, 0)
  assert.equal(speech.calls.length, 0)
  assert.equal(catalogCalls, 1)

  const catalogDriftAtAdmission = await post('paid-inherited-speech', challenge!.confirmationToken)
  assert.equal(catalogDriftAtAdmission.response.status, 409)
  assert.equal(catalogDriftAtAdmission.body.error?.code, 'VOICE_CATALOG_CHANGED')
  assert.equal(runtime.database.listGenerationJobs({ type: 'dialogue.speech.generate' }).length, 0)
  assert.equal(speech.calls.length, 0)
  assert.equal(catalogCalls, 3)

  changedCatalogCall = -1
  const created = await post('paid-inherited-speech', challenge!.confirmationToken)
  assert.equal(created.response.status, 202, JSON.stringify(created.body))
  assert.equal(created.body.job?.input.inheritedVoiceProfileRevisionId, voice.revision.id)
  assert.equal(runtime.database.listGenerationJobs({ type: 'dialogue.speech.generate' }).length, 1)
  assert.equal(speech.calls.length, 0)
  const callsAfterCreate = catalogCalls

  const replay = await post('paid-inherited-speech')
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.job?.id, created.body.job?.id)
  assert.equal(catalogCalls, callsAfterCreate)

  const duplicatePreflight = await post('paid-inherited-speech-2')
  const duplicateToken = duplicatePreflight.body.error?.details?.confirmation?.confirmationToken
  assert.ok(duplicateToken)
  const activeDuplicate = await post('paid-inherited-speech-2', duplicateToken)
  assert.equal(activeDuplicate.response.status, 409)
  assert.equal(activeDuplicate.body.error?.code, 'ACTIVE_GENERATION_CONFLICT')
  assert.equal(runtime.database.listGenerationJobs({ type: 'dialogue.speech.generate' }).length, 1)
  assert.equal(speech.calls.length, 0)
})

test('paid speech confirmation binds the compiled performance revision and settings', async () => {
  const { baseUrl, runtime, speech } = await paidSpeechFixture()
  const { episodeId, databaseLineId } = prepareStory(runtime)
  const configRevision = await configureMiniMax(runtime)
  const voice = saveVoiceProfile(runtime, episodeId, voiceProfile(configRevision))
  const initialPerformance = saveLinePerformance(
    runtime,
    episodeId,
    databaseLineId,
    'paid-performance-initial',
  )
  const endpoint = `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`
  const request = (confirmationToken?: string) => json<{
    error?: {
      code: string
      details?: { confirmation?: { confirmationToken: string; action: string } }
    }
    job?: { id: string }
  }>(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'paid-performance-speech',
      ...(confirmationToken ? { 'x-manju-aigc-confirmation': confirmationToken } : {}),
    },
    body: JSON.stringify({ projectId: 'default', episodeId, format: 'mp3' }),
  })

  const preflight = await request()
  assert.equal(preflight.response.status, 409)
  const originalToken = preflight.body.error?.details?.confirmation?.confirmationToken
  assert.ok(originalToken)
  assert.equal(runtime.database.listGenerationJobs({ type: 'dialogue.speech.generate' }).length, 0)

  const updatedPerformance = saveLinePerformance(
    runtime,
    episodeId,
    databaseLineId,
    'paid-performance-updated',
    { afterCharacter: 2, durationSeconds: 0.4 },
  )
  assert.notEqual(updatedPerformance.revision.id, initialPerformance.revision.id)
  const staleConfirmation = await request(originalToken)
  assert.equal(staleConfirmation.response.status, 409)
  assert.equal(staleConfirmation.body.error?.code, 'PAID_CONFIRMATION_REQUIRED')
  const refreshedToken = staleConfirmation.body.error?.details?.confirmation?.confirmationToken
  assert.ok(refreshedToken)
  assert.notEqual(refreshedToken, originalToken)
  assert.equal(runtime.database.listGenerationJobs({ type: 'dialogue.speech.generate' }).length, 0)
  assert.equal(speech.calls.length, 0)

  const created = await request(refreshedToken)
  assert.equal(created.response.status, 202, JSON.stringify(created.body))
  const durable = runtime.database.getGenerationJob(created.body.job!.id)
  assert.equal(durable?.input.expectedRevisionId, runtime.storyRepository.getEpisode(episodeId)?.sourceRevisionId)
  assert.equal(durable?.input.inheritedVoiceProfileRevisionId, voice.revision.id)
  assert.equal(durable?.input.inheritedPerformanceRevisionId, updatedPerformance.revision.id)
  assert.equal(durable?.input.compiledText, '(gasps)它醒<#0.40#>了。')
  assert.deepEqual({
    speed: durable?.input.speed,
    pitch: durable?.input.pitch,
    emotion: durable?.input.emotion,
  }, { speed: 0.8, pitch: 1, emotion: 'surprised' })
  assert.equal(speech.calls.length, 0)
})

test('speech endpoint requires idempotency and a configured MiniMax provider', async () => {
  const { baseUrl, runtime, speech } = await fixture()
  const { episodeId } = prepareStory(runtime)
  const withoutKey = speechRequest(episodeId)
  delete (withoutKey.headers as Record<string, string>)['idempotency-key']
  const missingIdempotency = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    withoutKey,
  )
  assert.equal(missingIdempotency.response.status, 400)
  assert.equal(missingIdempotency.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED')

  const unconfigured = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId),
  )
  assert.equal(unconfigured.response.status, 409)
  assert.equal(unconfigured.body.error.code, 'PROVIDER_NOT_CONFIGURED')
  assert.equal(speech.calls.length, 0)
  assert.equal(runtime.database.listGenerationJobs({ type: 'dialogue.speech.generate' }).length, 0)
})

test('speech endpoint rejects unknown or cross-owner public line IDs before creating a job', async () => {
  const { baseUrl, runtime, speech } = await fixture()
  const { episodeId } = prepareStory(runtime)
  await configureMiniMax(runtime)

  for (const [lineId, bodyEpisode] of [['missing-line', episodeId], ['line-1', 'wrong-episode']]) {
    const result = await json<{ error: { code: string } }>(
      `${baseUrl}/api/v1/dialogue-lines/${lineId}/speech-generations`,
      speechRequest(bodyEpisode, { projectId: 'default' }),
    )
    assert.equal(result.response.status, 404)
    assert.equal(result.body.error.code, 'DIALOGUE_LINE_NOT_FOUND')
  }
  assert.equal(speech.calls.length, 0)
  assert.equal(runtime.database.listGenerationJobs({ type: 'dialogue.speech.generate' }).length, 0)
})

test('speech endpoint validates voice controls and rejects an unconfigured custom provider', async () => {
  const { baseUrl, runtime, speech } = await fixture()
  const { episodeId } = prepareStory(runtime)
  await configureMiniMax(runtime)

  for (const invalid of [
    { voiceId: '' },
    { speed: 2.1 },
    { volume: 0 },
    { pitch: 1.5 },
    { emotion: 'ecstatic' },
    { format: 'flac' },
    { text: '客户端不得覆盖数据库台词' },
  ]) {
    const result = await json<{ error: { code: string } }>(
      `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
      speechRequest(episodeId, invalid),
    )
    assert.equal(result.response.status, 400)
    assert.ok(
      ['INVALID_SPEECH_INPUT', 'INVALID_REQUEST'].includes(result.body.error.code),
      JSON.stringify(result.body),
    )
  }

  const custom = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId, { providerId: 'custom-speech' }),
  )
  assert.equal(custom.response.status, 409)
  assert.equal(custom.body.error.code, 'PROVIDER_NOT_CONFIGURED')
  assert.equal(speech.calls.length, 0)
  assert.equal(runtime.database.listGenerationJobs({ type: 'dialogue.speech.generate' }).length, 0)
})

test('custom OpenAI-compatible speech executes its pinned BYOK profile and probes real duration', async () => {
  const { baseUrl, runtime, speech, compatibleRequests } = await compatibleSpeechFixture()
  const { episodeId, databaseLineId } = prepareStory(runtime)
  const configured = await runtime.providerService.save('custom-speech', {
    apiKey: 'custom-speech-secret',
    baseUrl: 'https://speech.example/v1',
    model: 'tts-model-v1',
    enabled: true,
  })

  const submitted = await json<{ job: { id: string; providerId: string; model: string; providerConfigRevision: number } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId, {
      providerId: 'custom-speech',
      voiceId: 'alloy',
      emotion: 'calm',
    }),
  )
  assert.equal(submitted.response.status, 202)
  assert.equal(submitted.body.job.providerId, 'custom-speech')
  assert.equal(submitted.body.job.model, 'tts-model-v1')
  assert.equal(submitted.body.job.providerConfigRevision, configured.configRevision)

  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'succeeded')
  assert.equal(speech.calls.length, 0)
  assert.equal(compatibleRequests?.length, 1)
  assert.equal(compatibleRequests?.[0].url, 'https://speech.example/v1/audio/speech')
  const requestBody = JSON.parse(String(compatibleRequests?.[0].init?.body)) as Record<string, unknown>
  assert.deepEqual(requestBody, {
    model: 'tts-model-v1',
    input: '它醒了。',
    voice: 'alloy',
    response_format: 'mp3',
    speed: 1,
  })
  const output = completed.output as { asset: { id: string }; provider: { id: string } }
  assert.equal(output.provider.id, 'custom-speech')
  const asset = runtime.database.getMediaAsset(output.asset.id)
  assert.equal(asset?.durationSeconds, 1.5)
  assert.deepEqual(asset?.generationParameters, {
    lineId: 'line-1',
    voiceId: 'alloy',
    speed: 1,
    format: 'mp3',
    adapter: 'openai-compatible',
  })
  assert.equal(runtime.database.withSql((sql) => sql.get(
    'SELECT duration_seconds FROM dialogue_lines WHERE id = ?',
    databaseLineId,
  ))?.duration_seconds, 1.5)
  assert.doesNotMatch(JSON.stringify(completed), /它醒了|custom-speech-secret/)
})

test('MiniMax failures are classified safely and never create or link an asset', async () => {
  const { baseUrl, runtime, speech } = await fixture('provider-error')
  const { episodeId, databaseLineId } = prepareStory(runtime)
  await configureMiniMax(runtime)

  const submitted = await json<{ job: { id: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId),
  )
  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'failed')
  assert.deepEqual(completed.error, {
    code: 'UPSTREAM_UNAVAILABLE',
    message: 'MiniMax 语音服务暂时不可用',
    retryable: true,
    category: 'provider',
  })
  assert.equal(completed.retryDisposition, 'manual-resolution')
  assert.equal(speech.calls.length, 1)
  assert.equal(runtime.database.listMediaAssets({ projectId: 'default', kind: 'speech' }).length, 0)
  const line = runtime.database.withSql((sql) => sql.get(
    'SELECT speech_asset_id FROM dialogue_lines WHERE id = ?',
    databaseLineId,
  ))
  assert.equal(line?.speech_asset_id, null)
  assert.doesNotMatch(JSON.stringify(completed), /它醒了|fixture-speech-secret/)
})

test('a confirmed MiniMax failure exits the unknown checkpoint and requires paid reconfirmation', async () => {
  const { baseUrl, runtime } = await fixture('provider-confirmed-error')
  const { episodeId } = prepareStory(runtime)
  const providerConfigRevision = await configureMiniMax(runtime)

  const submitted = await json<{ job: { id: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId),
  )
  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'PROVIDER_USAGE_LIMIT_EXCEEDED')
  assert.equal(completed.retryDisposition, 'paid-reconfirmation-required')
  assert.deepEqual(runtime.database.getGenerationJob(submitted.body.job.id)?.providerState, {
    operation: 'dialogue.speech.generate',
    phase: 'failed',
    clientRequestId: submitted.body.job.id,
    providerSupportsIdempotency: false,
    providerId: 'minimax-speech',
    providerConfigRevision,
    providerFailureConfirmed: true,
    providerErrorCode: 'PROVIDER_USAGE_LIMIT_EXCEEDED',
    providerStatus: 2056,
    failedAt: runtime.database.getGenerationJob(submitted.body.job.id)?.providerState.failedAt,
  })
  assert.equal(
    typeof runtime.database.getGenerationJob(submitted.body.job.id)?.providerState.failedAt,
    'string',
  )
})

test('an HTTP timeout response remains an unknown paid submission outcome', async () => {
  const { baseUrl, runtime } = await fixture('provider-timeout-response')
  const { episodeId } = prepareStory(runtime)
  await configureMiniMax(runtime)

  const submitted = await json<{ job: { id: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId),
  )
  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'UPSTREAM_TIMEOUT')
  assert.equal(completed.retryDisposition, 'manual-resolution')
  assert.equal(
    runtime.database.getGenerationJob(submitted.body.job.id)?.providerState.phase,
    'submitting',
  )
})

test('cancelling an in-flight paid speech request preserves an unknown submission outcome', async () => {
  const { baseUrl, runtime, speech } = await fixture('wait-for-cancel')
  const { episodeId, databaseLineId } = prepareStory(runtime)
  await configureMiniMax(runtime)

  const submitted = await json<{ job: { id: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/speech-generations`,
    speechRequest(episodeId),
  )
  await waitForJobStatus(baseUrl, submitted.body.job.id, 'waiting_provider')
  const cancelled = await json<{ job: { status: string } }>(
    `${baseUrl}/api/v1/jobs/${submitted.body.job.id}/cancel`,
    { method: 'POST' },
  )
  assert.equal(cancelled.response.status, 200)
  assert.equal(cancelled.body.job.status, 'failed')
  const completed = await terminalJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(speech.calls.length, 1)
  assert.equal(runtime.database.listMediaAssets({ projectId: 'default', kind: 'speech' }).length, 0)
  const line = runtime.database.withSql((sql) => sql.get(
    'SELECT speech_asset_id FROM dialogue_lines WHERE id = ?',
    databaseLineId,
  ))
  assert.equal(line?.speech_asset_id, null)
})

test('recovery never resubmits an ambiguous non-idempotent MiniMax speech request', async () => {
  const { baseUrl, runtime, speech } = await fixture()
  const { episodeId, databaseLineId } = prepareStory(runtime)
  const configRevision = await configureMiniMax(runtime)
  const revisionId = runtime.storyRepository.getEpisode(episodeId)?.sourceRevisionId
  assert.ok(revisionId)
  await runtime.worker.stop()
  const job = runtime.database.createGenerationJob({
    projectId: 'default',
    episodeId,
    type: 'dialogue.speech.generate',
    status: 'waiting_provider',
    progress: 5,
    resourceType: 'provider:speech',
    resourceId: databaseLineId,
    providerId: 'minimax-speech',
    model: 'speech-2.8-hd',
    providerConfigRevision: configRevision,
    idempotencyKey: 'ambiguous-speech-v1',
    input: {
      episodeId,
      lineId: 'line-1',
      databaseLineId,
      expectedRevisionId: revisionId,
      voiceId: 'female-shaonv',
      speed: 1,
      volume: 1,
      pitch: 0,
      format: 'mp3',
      sampleRate: 32_000,
      bitrate: 128_000,
      channels: 1,
    },
    providerState: {
      operation: 'dialogue.speech.generate',
      phase: 'submitting',
      clientRequestId: 'ambiguous-speech-v1',
      providerSupportsIdempotency: false,
    },
  })
  await runtime.worker.start()
  const completed = await terminalJob(baseUrl, job.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(speech.calls.length, 0)
})
