import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import type { KeychainCredentialSlot } from './keychain.js'
import type {
  MiniMaxSpeechInput,
  MiniMaxSpeechResult,
  SpeechProvider,
} from './providers/minimax-tts.js'
import type { ProviderCredentialStore } from './providers/service.js'
import type { ImageGenerationInput, ImageProvider, ProviderImage } from './types.js'

const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

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
  constructor(readonly waits = false) {}

  async synthesize(input: MiniMaxSpeechInput, signal?: AbortSignal): Promise<MiniMaxSpeechResult> {
    this.calls.push(structuredClone(input))
    if (this.waits) {
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    return {
      audio: { kind: 'bytes', bytes: MP3_BYTES, sourceEncoding: 'hex' },
      format: 'mp3',
      mimeType: 'audio/mpeg',
      durationMs: 800,
      usageCharacters: Array.from(input.text).length,
    }
  }
}

interface Running {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
  credentials: MemoryCredentialStore
  speech: FixtureSpeechProvider
}

const runningFixtures: Running[] = []

afterEach(async () => {
  for (const running of runningFixtures.splice(0)) {
    if (running.server.listening) {
      await new Promise<void>((resolve, reject) => running.server.close((error) => error ? reject(error) : resolve()))
    }
    await running.runtime.close().catch(() => undefined)
    await rm(running.directory, { recursive: true, force: true })
  }
})

function voiceCatalogPayload(voiceId = 'voice-ali') {
  return {
    base_resp: { status_code: 0, status_msg: 'success' },
    system_voice: [{
      voice_id: voiceId,
      voice_name: voiceId === 'voice-ali' ? '阿离候选' : '已变化音色',
      description: ['沉静、坚定'],
    }],
    voice_cloning: [],
    voice_generation: [],
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server address')
  return `http://127.0.0.1:${address.port}`
}

async function startRuntime(options: {
  directory?: string
  credentials?: MemoryCredentialStore
  speech?: FixtureSpeechProvider
  catalogFetch?: typeof fetch
  enforcePaidAigcConfirmation?: boolean
} = {}): Promise<Running> {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'manju-voice-preview-http-'))
  const credentials = options.credentials ?? new MemoryCredentialStore()
  const speech = options.speech ?? new FixtureSpeechProvider()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider: new NoopImageProvider(),
    speechProvider: speech,
    keychain: credentials,
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    enforcePaidAigcConfirmation: options.enforcePaidAigcConfirmation ?? false,
    miniMaxVoiceCatalogFetch: options.catalogFetch ?? (async () => new Response(
      JSON.stringify(voiceCatalogPayload()),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )),
  })
  const server = createServer(runtime.app)
  const running = {
    directory,
    runtime,
    server,
    baseUrl: await listen(server),
    credentials,
    speech,
  }
  runningFixtures.push(running)
  return running
}

function story() {
  return {
    version: 1 as const,
    title: '声线试听',
    targetDurationSeconds: 30,
    bible: {
      logline: '阿离在断崖做出决定。', theme: '责任', tone: '克制', visualStyle: '国风动画',
    },
    characters: [{
      id: 'ali', name: '阿离', role: '主角', storyDescription: '年轻剑客', visualDescription: '黑发青衣',
    }],
    locations: [{
      id: 'cliff', name: '断崖', storyDescription: '长安城外', visualDescription: '云海与山石',
    }],
    props: [{
      id: 'token', name: '青铜令', description: '唤醒龙脉', visualDescription: '暗红纹路',
    }],
    scenes: [{
      id: 'scene-1', sequence: 0, title: '断崖', locationId: 'cliff', timeOfDay: '黄昏', description: '风起云涌',
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
        dialogueLines: index === 0 ? [{
          id: 'line-1', sequence: 0, kind: 'dialogue' as const, speaker: '阿离', text: '我会守住这里，直到天亮。',
        }] : [],
      })),
    }],
  }
}

async function prepare(running: Running): Promise<{ etag: string; fingerprint: string }> {
  running.runtime.storyRepository.ensureEpisode('default', {
    id: 'preview-episode', title: '声线试听', sourceText: '阿离在断崖。', targetDurationSeconds: 30,
  })
  running.runtime.storyRepository.applyStory('preview-episode', story())
  await running.runtime.providerService.save('minimax-speech', {
    apiKey: 'fixture-preview-secret', enabled: true,
  })
  await running.runtime.providerService.test('minimax-speech')
  const episodeResponse = await fetch(`${running.baseUrl}/api/v1/episodes/preview-episode?projectId=default`)
  assert.equal(episodeResponse.status, 200)
  const etag = episodeResponse.headers.get('etag')
  assert.ok(etag)
  await episodeResponse.body?.cancel()
  const catalog = await json<{ fingerprint: string }>(
    `${running.baseUrl}/api/v1/providers/minimax-speech/voices`,
  )
  assert.equal(catalog.response.status, 200)
  assert.equal(running.speech.calls.length, 0, 'reading/selecting the catalog must not synthesize')
  return { etag, fingerprint: catalog.body.fingerprint }
}

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
  throw new Error(`job did not finish: ${id}`)
}

async function waitForStatus(baseUrl: string, id: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await json<{ job: Record<string, unknown> }>(`${baseUrl}/api/v1/jobs/${id}`)
    if (result.body.job.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`job did not reach ${status}: ${id}`)
}

function previewRequest(
  etag: string,
  fingerprint: string,
  idempotencyKey: string,
  confirmationToken?: string,
  voiceId = 'voice-ali',
): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'if-match': etag,
      ...(confirmationToken
        ? { 'x-manju-aigc-confirmation': confirmationToken }
        : {}),
    },
    body: JSON.stringify({
      projectId: 'default',
      voiceId,
      expectedCatalogFingerprint: fingerprint,
    }),
  }
}

test('paid character preview preflights without a Job and binds exact intent before TTS', async () => {
  let catalogMode: 'stable' | 'drift' | 'unavailable' = 'stable'
  let catalogCalls = 0
  const running = await startRuntime({
    enforcePaidAigcConfirmation: true,
    catalogFetch: async () => {
      catalogCalls += 1
      if (catalogMode === 'unavailable') throw new Error('catalog must not be read on replay')
      return new Response(JSON.stringify(voiceCatalogPayload(
        catalogMode === 'drift' ? 'voice-changed' : 'voice-ali',
      )), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const { etag, fingerprint } = await prepare(running)
  const url = `${running.baseUrl}/api/v1/episodes/preview-episode/characters/ali/voice-previews`
  const key = 'paid-character-preview'
  const before = await json<{
    error: {
      code: string
      details: {
        confirmation: {
          action: string
          billableTaskCount: number
          confirmationToken: string
          provider: { providerId: string; model: string; configRevision: number }
        }
      }
    }
  }>(url, previewRequest(etag, fingerprint, key))
  assert.equal(before.response.status, 409)
  assert.equal(before.body.error.code, 'PAID_CONFIRMATION_REQUIRED')
  assert.equal(before.body.error.details.confirmation.action, 'character.voice.preview')
  assert.equal(before.body.error.details.confirmation.billableTaskCount, 1)
  assert.deepEqual(before.body.error.details.confirmation.provider, {
    providerId: 'minimax-speech',
    model: 'speech-2.8-hd',
    configRevision: 2,
  })
  assert.equal(running.runtime.database.listGenerationJobs({
    projectId: 'default',
    type: 'character.voice.preview',
  }).length, 0)
  assert.equal(running.speech.calls.length, 0)

  const wrongKey = await json<{ error: { code: string } }>(
    url,
    previewRequest(
      etag,
      fingerprint,
      `${key}-other`,
      before.body.error.details.confirmation.confirmationToken,
    ),
  )
  assert.equal(wrongKey.response.status, 409)
  assert.equal(wrongKey.body.error.code, 'PAID_CONFIRMATION_REQUIRED')
  assert.equal(running.runtime.database.listGenerationJobs({
    projectId: 'default',
    type: 'character.voice.preview',
  }).length, 0)
  assert.equal(running.speech.calls.length, 0)

  const submitted = await json<{ job: { id: string } }>(
    url,
    previewRequest(
      etag,
      fingerprint,
      key,
      before.body.error.details.confirmation.confirmationToken,
    ),
  )
  assert.equal(submitted.response.status, 202)
  assert.equal((await terminalJob(running.baseUrl, submitted.body.job.id)).status, 'succeeded')
  assert.equal(running.speech.calls.length, 1)

  catalogMode = 'drift'
  const driftedCatalog = await json<{ fingerprint: string }>(
    `${running.baseUrl}/api/v1/providers/minimax-speech/voices`,
  )
  const drifted = await json<{ error: { code: string } }>(
    url,
    previewRequest(
      etag,
      driftedCatalog.body.fingerprint,
      `${key}-catalog-drift`,
      before.body.error.details.confirmation.confirmationToken,
      'voice-changed',
    ),
  )
  assert.equal(drifted.response.status, 409)
  assert.equal(drifted.body.error.code, 'PAID_CONFIRMATION_REQUIRED')
  assert.equal(running.runtime.database.listGenerationJobs({
    projectId: 'default',
    type: 'character.voice.preview',
  }).length, 1)
  assert.equal(running.speech.calls.length, 1)

  catalogMode = 'unavailable'
  const callsBeforeReplay = catalogCalls
  const replay = await json<{ job: { id: string } }>(
    url,
    previewRequest(etag, fingerprint, key),
  )
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.job.id, submitted.body.job.id)
  assert.equal(catalogCalls, callsBeforeReplay)
  assert.equal(running.speech.calls.length, 1)
})

test('preview is explicit, idempotent, publicly redacted, unbound, and survives restart', async () => {
  const first = await startRuntime()
  const { etag, fingerprint } = await prepare(first)
  const url = `${first.baseUrl}/api/v1/episodes/preview-episode/characters/ali/voice-previews`

  const submitted = await json<{ job: Record<string, unknown> }>(
    url,
    previewRequest(etag, fingerprint, 'preview-ali-v1'),
  )
  assert.equal(submitted.response.status, 202)
  const jobId = String(submitted.body.job.id)
  const completed = await terminalJob(first.baseUrl, jobId)
  assert.equal(completed.status, 'succeeded')
  assert.equal(first.speech.calls.length, 1)
  assert.equal(first.speech.calls[0].text, '我会守住这里，直到天亮。')
  assert.equal(completed.resourceId, 'ali')
  assert.equal(JSON.stringify(completed).includes('characterDatabaseId'), false)
  assert.doesNotMatch(JSON.stringify(completed), /我会守住这里|fixture-preview-secret/)
  const output = completed.output as {
    characterId: string
    voiceId: string
    sampleSource: string
    sampleCharacterCount: number
    asset: { id: string; kind: string; url: string }
  }
  assert.equal(output.characterId, 'ali')
  assert.equal(output.voiceId, 'voice-ali')
  assert.equal(output.sampleSource, 'dialogue')
  assert.equal(output.sampleCharacterCount, 12)
  assert.equal(output.asset.kind, 'character.voice.preview')

  const replay = await json<{ job: { id: string } }>(
    url,
    previewRequest(etag, fingerprint, 'preview-ali-v1'),
  )
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.job.id, jobId)
  assert.equal(first.speech.calls.length, 1, 'idempotent replay must not synthesize twice')
  const linked = first.runtime.database.withSql((sql) => sql.get(`
    SELECT speech_asset_id, voice_id FROM dialogue_lines
    WHERE character_id = (
      SELECT id FROM characters
      WHERE episode_id = 'preview-episode'
        AND json_extract(metadata_json, '$.storyId') = 'ali'
    )
  `))
  assert.equal(linked?.speech_asset_id, null)
  assert.equal(linked?.voice_id, null)

  await new Promise<void>((resolve, reject) => first.server.close((error) => error ? reject(error) : resolve()))
  await first.runtime.close()
  const restarted = await startRuntime({
    directory: first.directory,
    credentials: first.credentials,
    speech: first.speech,
  })
  // Prevent afterEach from closing an already closed runtime twice.
  const index = runningFixtures.indexOf(first)
  if (index >= 0) runningFixtures.splice(index, 1)
  const restored = await json<{ job: Record<string, unknown> }>(`${restarted.baseUrl}/api/v1/jobs/${jobId}`)
  assert.equal(restored.response.status, 200)
  assert.equal(restored.body.job.status, 'succeeded')
  const content = await fetch(`${restarted.baseUrl}${output.asset.url}`)
  assert.equal(content.status, 200)
  assert.equal(content.headers.get('content-type'), 'audio/mpeg')
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), MP3_BYTES)
  assert.equal(first.speech.calls.length, 1, 'restart must not resubmit a completed preview')
})

test('catalog drift between submission and worker execution blocks TTS', async () => {
  let calls = 0
  const running = await startRuntime({
    catalogFetch: async () => {
      calls += 1
      const payload = calls <= 2 ? voiceCatalogPayload('voice-ali') : voiceCatalogPayload('voice-changed')
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const { etag, fingerprint } = await prepare(running)
  const submitted = await json<{ job: { id: string } }>(
    `${running.baseUrl}/api/v1/episodes/preview-episode/characters/ali/voice-previews`,
    previewRequest(etag, fingerprint, 'preview-catalog-drift'),
  )
  assert.equal(submitted.response.status, 202)
  const completed = await terminalJob(running.baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'failed')
  assert.equal((completed.error as { code: string }).code, 'VOICE_CATALOG_CHANGED')
  assert.equal(running.speech.calls.length, 0)
  assert.equal(running.runtime.database.listMediaAssets({
    projectId: 'default',
    kind: 'character.voice.preview',
  }).length, 0)
})

test('a different cross-tab key cannot create a second active preview for the same character', async () => {
  const speech = new FixtureSpeechProvider(true)
  const running = await startRuntime({ speech })
  const { etag, fingerprint } = await prepare(running)
  const url = `${running.baseUrl}/api/v1/episodes/preview-episode/characters/ali/voice-previews`
  const first = await json<{ job: { id: string } }>(
    url,
    previewRequest(etag, fingerprint, 'preview-cross-tab-first'),
  )
  assert.equal(first.response.status, 202)
  await waitForStatus(running.baseUrl, first.body.job.id, 'waiting_provider')

  const duplicate = await json<{
    error: { code: string; details?: { existingJobId?: string } }
  }>(url, previewRequest(etag, fingerprint, 'preview-cross-tab-second'))
  assert.equal(duplicate.response.status, 409)
  assert.equal(duplicate.body.error.code, 'VOICE_PREVIEW_ALREADY_ACTIVE')
  assert.equal(duplicate.body.error.details?.existingJobId, first.body.job.id)
  assert.equal(speech.calls.length, 1)

  await fetch(`${running.baseUrl}/api/v1/jobs/${first.body.job.id}/cancel`, { method: 'POST' })
})

test('cancelling after the non-idempotent paid checkpoint fails closed and never publishes an asset', async () => {
  const speech = new FixtureSpeechProvider(true)
  const running = await startRuntime({ speech })
  const { etag, fingerprint } = await prepare(running)
  const submitted = await json<{ job: { id: string } }>(
    `${running.baseUrl}/api/v1/episodes/preview-episode/characters/ali/voice-previews`,
    previewRequest(etag, fingerprint, 'preview-cancel'),
  )
  assert.equal(submitted.response.status, 202)
  await waitForStatus(running.baseUrl, submitted.body.job.id, 'waiting_provider')
  const cancelled = await json<{ job: Record<string, unknown> }>(
    `${running.baseUrl}/api/v1/jobs/${submitted.body.job.id}/cancel`,
    { method: 'POST' },
  )
  assert.equal(cancelled.response.status, 200)
  assert.equal(cancelled.body.job.status, 'failed')
  assert.equal((cancelled.body.job.error as { code: string }).code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
  assert.equal(speech.calls.length, 1)
  assert.equal(running.runtime.database.listMediaAssets({
    projectId: 'default',
    kind: 'character.voice.preview',
  }).length, 0)
})
