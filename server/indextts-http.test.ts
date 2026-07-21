import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createApplication } from './app.js'
import type { KeychainCredentialSlot } from './keychain.js'
import type { ProviderCredentialStore } from './providers/service.js'

class MemoryCredentialStore implements ProviderCredentialStore {
  readonly values = new Map<string, string>()
  private key(slot: KeychainCredentialSlot): string {
    return `${slot.providerId}:${slot.credentialKind ?? 'api-key'}`
  }
  async get(slot: KeychainCredentialSlot): Promise<string | null> { return this.values.get(this.key(slot)) ?? null }
  async set(slot: KeychainCredentialSlot, secret: string): Promise<void> { this.values.set(this.key(slot), secret) }
  async delete(slot: KeychainCredentialSlot): Promise<boolean> { return this.values.delete(this.key(slot)) }
  async exists(slot: KeychainCredentialSlot): Promise<boolean> { return this.values.has(this.key(slot)) }
}

async function readJson<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init)
  return { response, body: await response.json() as T }
}

test('IndexTTS Provider exposes a real catalog and creates an inheritable narrator profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-indextts-http-'))
  const runtime = await createApplication({
    runtimeDirectory: directory,
    keychain: new MemoryCredentialStore(),
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    indexTtsVoiceCatalogFetch: async (_input, init) => {
      assert.match(new Headers(init?.headers).get('authorization') ?? '', /^Bearer /)
      return Response.json({
        voices: [{
          voice_id: 'ali-main',
          name: '阿离主声线',
          description: '清冷、克制',
          tags: ['女声', '青年'],
          type: 'voice_cloning',
        }],
      })
    },
    enforcePaidAigcConfirmation: false,
    autoStartWorker: false,
  })
  const server = createServer(runtime.app)
  try {
    await runtime.providerService.save('indextts-speech', {
      apiKey: 'sidecar-token-never-public',
      baseUrl: 'http://127.0.0.1:7861',
      model: 'IndexTTS-2',
      enabled: true,
    })
    await runtime.providerService.test('indextts-speech')
    await runtime.providerService.setDefault('indextts-speech')
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server address')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const initial = await readJson<{ voiceProfile: null }>(
      `${baseUrl}/api/v1/projects/default/narrator-voice-profile`,
    )
    const etag = initial.response.headers.get('etag')
    assert.ok(etag)
    const catalog = await readJson<{
      provider: { id: string; configRevision: number }
      fingerprint: string
      voices: Array<{ voiceId: string }>
    }>(`${baseUrl}/api/v1/providers/indextts-speech/voices`)
    assert.equal(catalog.response.status, 200)
    assert.equal(catalog.body.provider.id, 'indextts-speech')
    assert.deepEqual(catalog.body.voices.map((voice) => voice.voiceId), ['ali-main'])

    const saved = await readJson<{
      voiceProfile: { providerId: string; voiceId: string; voiceType: string }
    }>(`${baseUrl}/api/v1/projects/default/narrator-voice-profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': etag! },
      body: JSON.stringify({
        providerId: 'indextts-speech',
        voiceId: 'ali-main',
        expectedCatalogFingerprint: catalog.body.fingerprint,
        expectedProviderConfigRevision: catalog.body.provider.configRevision,
      }),
    })
    assert.equal(saved.response.status, 200)
    assert.equal(saved.body.voiceProfile.providerId, 'indextts-speech')
    assert.equal(saved.body.voiceProfile.voiceId, 'ali-main')
    assert.equal(saved.body.voiceProfile.voiceType, 'voice_cloning')
    assert.doesNotMatch(JSON.stringify(saved.body), /sidecar-token-never-public/)

    runtime.storyRepository.ensureEpisode('default', {
      id: 'indextts-preview',
      title: 'IndexTTS 试听',
      sourceText: '阿离说：我会守住这里。',
      targetDurationSeconds: 30,
    })
    runtime.storyRepository.applyStory('indextts-preview', {
      version: 1,
      title: 'IndexTTS 试听',
      targetDurationSeconds: 30,
      bible: { logline: '守夜', theme: '责任', tone: '克制', visualStyle: '国风动画' },
      characters: [{
        id: 'ali', name: '阿离', role: '主角', storyDescription: '守夜人', visualDescription: '黑发青衣',
      }],
      locations: [{
        id: 'wall', name: '城墙', storyDescription: '夜晚城墙', visualDescription: '冷月与烽火',
      }],
      props: [],
      scenes: [{
        id: 'scene-1', sequence: 0, title: '守夜', locationId: 'wall', timeOfDay: '夜晚', description: '风吹城墙',
        shots: Array.from({ length: 6 }, (_, index) => ({
          id: `shot-${index + 1}`,
          sequence: index,
          code: `01${String.fromCharCode(65 + index)}`,
          title: `守望 ${index + 1}`,
          description: '阿离看向远方',
          framing: '中景',
          movement: '静止',
          transition: index === 5 ? '淡出' : '硬切',
          durationSeconds: 5,
          visualPrompt: '夜晚城墙上的少女',
          dialogueLines: index === 0 ? [{
            id: 'line-1', sequence: 0, kind: 'dialogue' as const, speaker: '阿离', text: '我会守住这里。',
          }] : [],
        })),
      }],
    })
    const episode = await readJson<{ episode: { id: string } }>(
      `${baseUrl}/api/v1/episodes/indextts-preview?projectId=default`,
    )
    const episodeEtag = episode.response.headers.get('etag')
    assert.ok(episodeEtag)
    const preview = await readJson<{ job: { id: string; type: string; input: { voiceId: string } } }>(
      `${baseUrl}/api/v1/episodes/indextts-preview/characters/ali/voice-previews`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': episodeEtag!,
          'idempotency-key': 'indextts-preview-1',
        },
        body: JSON.stringify({
          projectId: 'default',
          providerId: 'indextts-speech',
          voiceId: 'ali-main',
          expectedCatalogFingerprint: catalog.body.fingerprint,
        }),
      },
    )
    assert.equal(preview.response.status, 202, JSON.stringify(preview.body))
    assert.equal(preview.body.job.type, 'character.voice.preview')
    assert.equal(preview.body.job.input.voiceId, 'ali-main')
    const durablePreview = runtime.database.getGenerationJob(preview.body.job.id)
    assert.equal(durablePreview?.providerId, 'indextts-speech')
    assert.equal(durablePreview?.model, 'IndexTTS-2')
    assert.doesNotMatch(JSON.stringify(preview.body), /sidecar-token-never-public/)

    await runtime.providerService.save('custom-text', {
      apiKey: 'text-secret-never-public',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-fixture',
      enabled: true,
    })
    await runtime.providerService.test('custom-text')
    await runtime.providerService.setDefault('custom-text')
    const recommendation = await readJson<{
      job: { id: string; type: string; input: { catalog: { providerId: string } } }
    }>(`${baseUrl}/api/v1/episodes/indextts-preview/characters/ali/voice-recommendations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': episodeEtag!,
        'idempotency-key': 'indextts-recommendation-1',
      },
      body: JSON.stringify({
        projectId: 'default',
        speechProviderId: 'indextts-speech',
        textProviderId: 'custom-text',
        expectedCatalogFingerprint: catalog.body.fingerprint,
      }),
    })
    assert.equal(recommendation.response.status, 202, JSON.stringify(recommendation.body))
    assert.equal(recommendation.body.job.type, 'character.voice.recommend')
    assert.equal(recommendation.body.job.input.catalog.providerId, 'indextts-speech')
    const durableRecommendation = runtime.database.getGenerationJob(recommendation.body.job.id)
    assert.equal(durableRecommendation?.providerId, 'custom-text')
    assert.equal(durableRecommendation?.input.catalog
      && typeof durableRecommendation.input.catalog === 'object'
      && !Array.isArray(durableRecommendation.input.catalog)
      ? durableRecommendation.input.catalog.providerId
      : null, 'indextts-speech')
    assert.doesNotMatch(JSON.stringify(recommendation.body), /text-secret-never-public/)
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
