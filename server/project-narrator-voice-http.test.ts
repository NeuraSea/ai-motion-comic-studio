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

async function json<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init)
  return { response, body: await response.json() as T }
}

test('project narrator HTTP API is catalog-gated, CAS protected, and rejects client-authored audit fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-project-narrator-http-'))
  const credentials = new MemoryCredentialStore()
  let catalogCalls = 0
  const runtime = await createApplication({
    runtimeDirectory: directory,
    keychain: credentials,
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    miniMaxVoiceCatalogFetch: async (_input, init) => {
      catalogCalls += 1
      assert.match(new Headers(init?.headers).get('authorization') ?? '', /^Bearer /)
      return new Response(JSON.stringify({
        base_resp: { status_code: 0, status_msg: 'success' },
        system_voice: [{
          voice_id: 'narrator-real-account-voice',
          voice_name: '沉稳旁白',
          description: ['沉稳清晰'],
        }],
        voice_cloning: [],
        voice_generation: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    autoStartWorker: false,
  })
  const server = createServer(runtime.app)
  try {
    await runtime.providerService.save('minimax-speech', {
      apiKey: 'fixture-secret-never-public',
      enabled: true,
    })
    await runtime.providerService.test('minimax-speech')
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

    const initial = await json<{
      voiceProfile: null
      revisionId: null
      project: { currentRevisionId: string }
    }>(`${baseUrl}/api/v1/projects/default/narrator-voice-profile`)
    assert.equal(initial.response.status, 200)
    assert.equal(initial.body.voiceProfile, null)
    assert.equal(initial.body.revisionId, null)
    const initialEtag = initial.response.headers.get('etag')
    assert.match(initialEtag ?? '', /^W\/"project\./)

    const catalog = await json<{
      fingerprint: string
      provider: { configRevision: number }
      voices: Array<{ voiceId: string }>
    }>(`${baseUrl}/api/v1/providers/minimax-speech/voices`)
    assert.equal(catalog.response.status, 200)
    assert.deepEqual(catalog.body.voices.map((voice) => voice.voiceId), ['narrator-real-account-voice'])

    const injected = await json<{ error: { code: string } }>(
      `${baseUrl}/api/v1/projects/default/narrator-voice-profile`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': initialEtag! },
        body: JSON.stringify({
          voiceId: 'narrator-real-account-voice',
          expectedCatalogFingerprint: catalog.body.fingerprint,
          expectedProviderConfigRevision: catalog.body.provider.configRevision,
          selectionRationale: '客户端伪造审计理由',
        }),
      },
    )
    assert.equal(injected.response.status, 400)
    assert.equal(injected.body.error.code, 'INVALID_REQUEST')

    const arbitrary = await json<{ error: { code: string } }>(
      `${baseUrl}/api/v1/projects/default/narrator-voice-profile`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': initialEtag! },
        body: JSON.stringify({
          voiceId: '这是任意文本而不是真实 voice_id',
          expectedCatalogFingerprint: catalog.body.fingerprint,
          expectedProviderConfigRevision: catalog.body.provider.configRevision,
        }),
      },
    )
    assert.equal(arbitrary.response.status, 409)
    assert.equal(arbitrary.body.error.code, 'VOICE_NOT_AVAILABLE')

    const saved = await json<{
      voiceProfile: {
        voiceId: string
        selectionSource: string
        selectionRationale?: string
        catalogFingerprint: string
        providerConfigRevision: number
      }
      revisionId: string
      stale: Record<string, number>
      project: { currentRevisionId: string }
    }>(`${baseUrl}/api/v1/projects/default/narrator-voice-profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': initialEtag! },
      body: JSON.stringify({
        voiceId: 'narrator-real-account-voice',
        expectedCatalogFingerprint: catalog.body.fingerprint,
        expectedProviderConfigRevision: catalog.body.provider.configRevision,
      }),
    })
    assert.equal(saved.response.status, 200)
    assert.equal(saved.body.voiceProfile.voiceId, 'narrator-real-account-voice')
    assert.equal(saved.body.voiceProfile.selectionSource, 'manual')
    assert.equal(saved.body.voiceProfile.selectionRationale, undefined)
    assert.equal(saved.body.voiceProfile.catalogFingerprint, catalog.body.fingerprint)
    assert.equal(saved.body.voiceProfile.providerConfigRevision, catalog.body.provider.configRevision)
    assert.equal(saved.body.project.currentRevisionId, initial.body.project.currentRevisionId)
    assert.equal(JSON.stringify(saved.body).includes('fixture-secret-never-public'), false)
    const savedEtag = saved.response.headers.get('etag')
    assert.ok(savedEtag)
    assert.notEqual(savedEtag, initialEtag)
    assert.equal(runtime.database.getRevision(saved.body.revisionId)?.snapshot.kind,
      'project.narrator-voice-profile')

    const staleWrite = await json<{ error: { code: string; details: { currentEtag: string } } }>(
      `${baseUrl}/api/v1/projects/default/narrator-voice-profile`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': initialEtag! },
        body: JSON.stringify({
          voiceId: 'narrator-real-account-voice',
          expectedCatalogFingerprint: catalog.body.fingerprint,
          expectedProviderConfigRevision: catalog.body.provider.configRevision,
        }),
      },
    )
    assert.equal(staleWrite.response.status, 412)
    assert.equal(staleWrite.body.error.code, 'REVISION_CONFLICT')
    assert.equal(staleWrite.body.error.details.currentEtag, savedEtag)

    const deleted = await json<{ voiceProfile: null; revisionId: string }>(
      `${baseUrl}/api/v1/projects/default/narrator-voice-profile`,
      { method: 'DELETE', headers: { 'if-match': savedEtag! } },
    )
    assert.equal(deleted.response.status, 200)
    assert.equal(deleted.body.voiceProfile, null)
    assert.equal(runtime.database.getRevision(deleted.body.revisionId)?.snapshot.profile, null)
    assert.equal(catalogCalls, 4, 'catalog reads are non-billable and no TTS endpoint is called')
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
