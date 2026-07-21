import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import { episodeEtag, versionTokenFromEtag } from './episode-version.js'
import type { KeychainCredentialSlot } from './keychain.js'
import type { ProviderCredentialStore } from './providers/service.js'
import type { StoryCharacterVoiceProfile } from './story-schema.js'
import type { ImageGenerationInput, ImageProvider, ProviderImage } from './types.js'

class NoopImageProvider implements ImageProvider {
  readonly name = 'noop'
  readonly model = 'noop'
  readonly configured = true
  async health() { return { status: 'ok' as const, message: 'ready' } }
  async generate(_input: ImageGenerationInput): Promise<ProviderImage[]> {
    throw new Error('not used')
  }
}

class MemoryCredentials implements ProviderCredentialStore {
  private readonly values = new Map<string, string>()
  private key(slot: KeychainCredentialSlot) {
    return `${slot.providerId}:${slot.credentialKind ?? 'api-key'}`
  }
  async get(slot: KeychainCredentialSlot) { return this.values.get(this.key(slot)) ?? null }
  async set(slot: KeychainCredentialSlot, value: string) { this.values.set(this.key(slot), value) }
  async delete(slot: KeychainCredentialSlot) { return this.values.delete(this.key(slot)) }
  async exists(slot: KeychainCredentialSlot) { return this.values.has(this.key(slot)) }
}

const fixtures: Array<{
  directory: string
  runtime: ApplicationRuntime
  server: Server
}> = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
    await fixture.runtime.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

async function json<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init)
  return { response, body: await response.json() as T }
}

async function waitForJob(baseUrl: string, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await json<{ job: Record<string, unknown> }>(`${baseUrl}/api/v1/jobs/${id}`)
    if (['succeeded', 'failed', 'cancelled'].includes(String(result.body.job.status))) return result.body.job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('job timeout')
}

function story() {
  return {
    version: 1 as const,
    title: '十年重逢',
    targetDurationSeconds: 30,
    bible: { logline: '少女与师父重逢。', theme: '重逢', tone: '克制', visualStyle: '国风' },
    characters: [{
      id: 'ali', name: '阿离', role: '主角', storyDescription: '寻找师父十年。', visualDescription: '红绳束发。',
    }],
    locations: [{ id: 'home', name: '旧宅', storyDescription: '荒废旧宅', visualDescription: '月光' }],
    props: [{ id: 'token', name: '令牌', description: '旧令牌', visualDescription: '青铜' }],
    scenes: [{
      id: 'scene-1', sequence: 0, title: '重逢', locationId: 'home', timeOfDay: '夜', description: '阿离认出师父。',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${index + 1}`,
        title: `镜头${index + 1}`,
        description: '镜头缓慢推进。',
        framing: '近景', movement: '推进', transition: '硬切', durationSeconds: 5, visualPrompt: '国风旧宅',
        dialogueLines: index === 2 ? [{
          id: 'line-1', sequence: 0, kind: 'dialogue' as const, speaker: '阿离', text: '不可能……十年了',
        }] : [],
      })),
    }],
  }
}

function voiceProfile(): StoryCharacterVoiceProfile {
  return {
    version: 1,
    voiceId: 'ali-voice',
    providerId: 'minimax-speech',
    providerConfigRevision: 1,
    voiceType: 'voice_cloning',
    voiceName: '阿离',
    descriptions: ['年轻', '克制'],
    selectionSource: 'manual',
    catalogFingerprint: 'a'.repeat(64),
    catalogObservedAt: '2026-07-14T00:00:00.000Z',
    historicalPin: false,
    updatedAt: '2026-07-14T00:00:00.000Z',
  }
}

test('AI director is explicit, adopt-only-by-job, replay-safe, scoped and never auto-submits TTS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-line-director-http-'))
  let textCalls = 0
  const runtime = await createApplication({
    runtimeDirectory: directory,
    enforcePaidAigcConfirmation: false,
    provider: new NoopImageProvider(),
    keychain: new MemoryCredentials(),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    textCompatibleFetch: async (_url, init) => {
      textCalls += 1
      assert.equal(JSON.stringify(JSON.parse(String(init?.body))).includes('uniqueItems'), false)
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          lineId: 'line-1',
          emotion: 'surprised',
          speed: 0.82,
          pitch: 1,
          openingSoundTag: '(gasps)',
          pausePlan: [{ afterCharacter: 5, durationSeconds: 0.8 }],
          rationale: '先震惊吸气，再用长停顿表现十年重逢的难以置信。',
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const server = createServer(runtime.app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`
  fixtures.push({ directory, runtime, server })

  const episodeId = 'episode-1'
  runtime.storyRepository.ensureEpisode('default', {
    id: episodeId, title: '十年重逢', sourceText: '阿离重逢师父。', targetDurationSeconds: 30,
  })
  runtime.storyRepository.applyStory(episodeId, story())
  const episode = runtime.storyRepository.getEpisode(episodeId)
  assert.ok(episode)
  runtime.characterVoiceProfiles.save({
    projectId: 'default',
    episodeId,
    characterId: 'ali',
    expectedEpisodeVersion: versionTokenFromEtag(episodeEtag(episode))!,
    profile: voiceProfile(),
  })
  await runtime.providerService.save('custom-text', {
    apiKey: 'text-secret', baseUrl: 'https://text.example/v1', model: 'text-model', enabled: true,
  })
  await runtime.providerService.test('custom-text')
  await runtime.providerService.setDefault('custom-text')

  assert.equal(runtime.database.listGenerationJobs({ limit: 100 }).length, 0)
  const submitted = await json<{ job: { id: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/performance-recommendations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'director-1' },
      body: JSON.stringify({ projectId: 'default', episodeId }),
    },
  )
  assert.equal(submitted.response.status, 202, JSON.stringify(submitted.body))
  const completed = await waitForJob(baseUrl, submitted.body.job.id)
  assert.equal(completed.status, 'succeeded')
  assert.equal(textCalls, 1)
  assert.doesNotMatch(JSON.stringify(completed.input), /不可能|voice-r|相邻|scene-1/)
  assert.equal(runtime.database.listGenerationJobs({ limit: 100 })
    .filter((job) => job.type === 'dialogue.speech.generate').length, 0)

  const initialProfile = await json<{ profile: null }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/performance-profile?projectId=default&episodeId=${episodeId}`,
  )
  assert.equal(initialProfile.response.status, 200)
  const initialPerformanceEtag = initialProfile.response.headers.get('etag')
  assert.ok(initialPerformanceEtag)

  const rawRejected = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/performance-profile`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': initialPerformanceEtag },
      body: JSON.stringify({
        projectId: 'default', episodeId, recommendationJobId: submitted.body.job.id, speed: 2,
      }),
    },
  )
  assert.equal(rawRejected.response.status, 400)

  const adopted = await json<{ profile: { revisionId: string; recommendationJobId: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/performance-profile`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': initialPerformanceEtag },
      body: JSON.stringify({ projectId: 'default', episodeId, recommendationJobId: submitted.body.job.id }),
    },
  )
  assert.equal(adopted.response.status, 200)
  assert.equal(adopted.body.profile.recommendationJobId, submitted.body.job.id)
  const adoptedPerformanceEtag = adopted.response.headers.get('etag')
  assert.ok(adoptedPerformanceEtag)
  const replay = await json<{ profile: { revisionId: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/performance-profile`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': initialPerformanceEtag },
      body: JSON.stringify({ projectId: 'default', episodeId, recommendationJobId: submitted.body.job.id }),
    },
  )
  assert.equal(replay.body.profile.revisionId, adopted.body.profile.revisionId)
  assert.equal(textCalls, 1)

  const crossProject = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/performance-profile`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': initialPerformanceEtag },
      body: JSON.stringify({ projectId: 'other', episodeId, recommendationJobId: submitted.body.job.id }),
    },
  )
  assert.equal(crossProject.response.status, 409)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cleared: { response: Response; body: { profile: null } } = await json<{ profile: null }>(
      `${baseUrl}/api/v1/dialogue-lines/line-1/performance-profile`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'if-match': adoptedPerformanceEtag },
        body: JSON.stringify({ projectId: 'default', episodeId }),
      },
    )
    assert.equal(cleared.response.status, 200)
    assert.equal(cleared.body.profile, null)
  }
})

test('AI director directly creates an idempotent job and blocks active duplicates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-line-director-paid-http-'))
  let textCalls = 0
  const runtime = await createApplication({
    runtimeDirectory: directory,
    autoStartWorker: false,
    provider: new NoopImageProvider(),
    keychain: new MemoryCredentials(),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    textCompatibleFetch: async () => {
      textCalls += 1
      throw new Error('queued direct submission must not call the text provider')
    },
  })
  const server = createServer(runtime.app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`
  fixtures.push({ directory, runtime, server })

  const episodeId = 'episode-paid-director'
  runtime.storyRepository.ensureEpisode('default', {
    id: episodeId,
    title: '十年重逢',
    sourceText: '阿离重逢师父。',
    targetDurationSeconds: 30,
  })
  runtime.storyRepository.applyStory(episodeId, story())
  const episode = runtime.storyRepository.getEpisode(episodeId)
  assert.ok(episode)
  runtime.characterVoiceProfiles.save({
    projectId: 'default',
    episodeId,
    characterId: 'ali',
    expectedEpisodeVersion: versionTokenFromEtag(episodeEtag(episode))!,
    profile: voiceProfile(),
  })
  await runtime.providerService.save('custom-text', {
    apiKey: 'text-secret',
    baseUrl: 'https://text.example/v1',
    model: 'text-model-v1',
    enabled: true,
  })
  await runtime.providerService.test('custom-text')
  await runtime.providerService.setDefault('custom-text')

  const post = (key: string) => json<{ error?: { code: string }; job?: { id: string } }>(
    `${baseUrl}/api/v1/dialogue-lines/line-1/performance-recommendations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({ projectId: 'default', episodeId }),
    },
  )

  const created = await post('director-free-1')
  assert.equal(created.response.status, 202, JSON.stringify(created.body))
  assert.equal(runtime.database.listGenerationJobs({ limit: 100 }).length, 1)
  assert.equal(textCalls, 0)

  const replay = await post('director-free-1')
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.job?.id, created.body.job?.id)

  const activeDuplicate = await post('director-free-2')
  assert.equal(activeDuplicate.response.status, 409)
  assert.equal(activeDuplicate.body.error?.code, 'ACTIVE_GENERATION_CONFLICT')
  assert.equal(runtime.database.listGenerationJobs({ limit: 100 }).length, 1)
  assert.equal(textCalls, 0)
})
