import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { KeychainCredentialSlot } from '../keychain.js'
import { getProviderDefinition, type ProviderKind } from './catalog.js'
import {
  defaultProviderProbe,
  ProviderConfigurationError,
  ProviderService,
  type ProviderConnectionRecord,
  type ProviderConnectionRepository,
  type ProviderConnectionVersionRecord,
  type ProviderCredentialStore,
} from './service.js'

class MemoryProviderRepository implements ProviderConnectionRepository {
  private readonly records = new Map<string, ProviderConnectionRecord>()
  private readonly versions = new Map<string, ProviderConnectionVersionRecord>()

  listProviderConnections(): ProviderConnectionRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record))
  }

  getProviderConnection(providerId: string): ProviderConnectionRecord | undefined {
    const record = this.records.get(providerId)
    return record ? structuredClone(record) : undefined
  }

  getProviderConnectionVersion(
    providerId: string,
    configRevision: number,
  ): ProviderConnectionVersionRecord | undefined {
    const record = this.versions.get(`${providerId}:${configRevision}`)
    return record ? structuredClone(record) : undefined
  }

  listProviderConnectionVersions(providerId: string): ProviderConnectionVersionRecord[] {
    return [...this.versions.values()]
      .filter((record) => record.providerId === providerId)
      .sort((left, right) => left.configRevision - right.configRevision)
      .map((record) => structuredClone(record))
  }

  upsertProviderConnection(
    providerId: string,
    update: Partial<Omit<
      ProviderConnectionRecord,
      'providerId' | 'configRevision' | 'createdAt' | 'updatedAt'
    >>,
  ): ProviderConnectionRecord {
    const now = new Date().toISOString()
    const current = this.records.get(providerId)
    const configurationChanged = !current
      || (Object.hasOwn(update, 'baseUrl') && update.baseUrl !== current.baseUrl)
      || (Object.hasOwn(update, 'model') && update.model !== current.model)
      || (Object.hasOwn(update, 'credentialRef') && update.credentialRef !== current.credentialRef)
    const configRevision = current
      ? current.configRevision + (configurationChanged ? 1 : 0)
      : 1
    const record: ProviderConnectionRecord = {
      providerId,
      enabled: false,
      isDefault: false,
      createdAt: current?.createdAt ?? now,
      ...current,
      ...update,
      configRevision,
      updatedAt: now,
    }
    this.records.set(providerId, record)
    if (configurationChanged) {
      const definition = getProviderDefinition(providerId)
      assert.ok(definition)
      this.versions.set(`${providerId}:${configRevision}`, {
        providerId,
        configRevision,
        kind: definition.kind,
        adapter: definition.adapter,
        authMode: definition.authMode,
        executionConfig: {},
        createdAt: now,
        ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        ...(record.model !== undefined ? { model: record.model } : {}),
        ...(record.credentialRef ? { credentialRef: record.credentialRef } : {}),
      })
    }
    return structuredClone(record)
  }

  setDefaultProvider(providerId: string, kind: ProviderKind): ProviderConnectionRecord {
    for (const [id, record] of this.records) {
      const sameKind = (kind === 'text' && id.includes('text'))
        || (kind === 'image' && id.includes('image'))
        || (kind === 'video' && id.includes('video'))
        || (kind === 'speech' && id.includes('speech'))
      if (sameKind) this.records.set(id, { ...record, isDefault: id === providerId })
    }
    return this.upsertProviderConnection(providerId, { isDefault: true })
  }
}

class MemoryKeychain implements ProviderCredentialStore {
  readonly values = new Map<string, string>()

  private key(slot: KeychainCredentialSlot) {
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

function fixture() {
  const repository = new MemoryProviderRepository()
  const keychain = new MemoryKeychain()
  const probes: Array<{ id: string; apiKey: string }> = []
  const byoaChecks: string[] = []
  const byoaLoads: string[] = []
  const service = new ProviderService({
    repository,
    keychain,
    hasByoaCredential: async (id) => {
      byoaChecks.push(id)
      return id.startsWith('codex-tools')
    },
    loadByoaCredential: async (id) => {
      byoaLoads.push(id)
      return id.startsWith('codex-tools') ? 'external-secret' : null
    },
    probe: async (provider, configuration) => {
      probes.push({ id: provider.id, apiKey: configuration.apiKey })
      return { status: 'ok', message: '测试成功' }
    },
    testTimeoutMs: 1_000,
  })
  return { repository, keychain, service, probes, byoaChecks, byoaLoads }
}

test('provider list exposes BYOA/BYOK states but never credential values', async () => {
  const { service, byoaChecks, byoaLoads } = fixture()
  const providers = await service.list()
  assert.equal(providers.length, 9)
  assert.equal(providers.find((provider) => provider.id === 'codex-tools-image')?.credentialState, 'external')
  assert.equal(providers.find((provider) => provider.id === 'minimax-speech')?.credentialState, 'missing')
  assert.equal(JSON.stringify(providers).includes('external-secret'), false)
  assert.deepEqual(byoaChecks.sort(), ['codex-tools-image', 'codex-tools-text'])
  assert.deepEqual(byoaLoads, [])
})

test('BYOA secrets are materialized only for an actual connection test', async () => {
  const { service, byoaLoads } = fixture()
  await service.list()
  await service.save('codex-tools-text', { enabled: true })
  assert.deepEqual(byoaLoads, [])

  await service.test('codex-tools-text')
  assert.deepEqual(byoaLoads, ['codex-tools-text'])
})

test('BYOA login, rotation, and logout are observed live without changing the pinned config revision', async () => {
  const repository = new MemoryProviderRepository()
  const keychain = new MemoryKeychain()
  let credential: string | null = null
  const probedCredentials: string[] = []
  const service = new ProviderService({
    repository,
    keychain,
    hasByoaCredential: async (id) => id.startsWith('codex-tools') && credential !== null,
    loadByoaCredential: async (id) => id.startsWith('codex-tools') ? credential : null,
    probe: async (_provider, configuration) => {
      probedCredentials.push(configuration.apiKey)
      return { status: 'ok', message: '测试成功' }
    },
  })

  assert.equal(
    (await service.list()).find((provider) => provider.id === 'codex-tools-text')?.credentialState,
    'missing',
  )

  credential = 'external-session-v1'
  const enabled = await service.save('codex-tools-text', { enabled: true })
  assert.equal(enabled.credentialState, 'external')
  assert.equal(enabled.configRevision, 1)
  await service.test('codex-tools-text')
  assert.deepEqual(probedCredentials, ['external-session-v1'])
  const firstMaterialization = await service.materializeExecutionProfile('codex-tools-text', 1)
  assert.equal(firstMaterialization.apiKey, 'external-session-v1')

  credential = 'external-session-v2'
  await service.test('codex-tools-text')
  assert.deepEqual(probedCredentials, ['external-session-v1', 'external-session-v2'])
  const rotatedMaterialization = await service.materializeExecutionProfile('codex-tools-text', 1)
  assert.equal(rotatedMaterialization.configRevision, 1)
  assert.equal(rotatedMaterialization.apiKey, 'external-session-v2')

  credential = null
  assert.equal(
    (await service.list()).find((provider) => provider.id === 'codex-tools-text')?.credentialState,
    'missing',
  )
  await assert.rejects(
    service.materializeExecutionProfile('codex-tools-text', 1),
    (error: unknown) => error instanceof ProviderConfigurationError
      && error.code === 'PROVIDER_NOT_CONFIGURED',
  )
  const serializedPublicState = JSON.stringify(await service.list())
  const serializedRepository = JSON.stringify({
    head: repository.getProviderConnection('codex-tools-text'),
    versions: repository.listProviderConnectionVersions('codex-tools-text'),
  })
  for (const secret of ['external-session-v1', 'external-session-v2']) {
    assert.equal(serializedPublicState.includes(secret), false)
    assert.equal(serializedRepository.includes(secret), false)
  }
})

test('provider list remains backward compatible when no BYOA presence callback is supplied', async () => {
  const byoaLoads: string[] = []
  const service = new ProviderService({
    repository: new MemoryProviderRepository(),
    keychain: new MemoryKeychain(),
    loadByoaCredential: async (id) => {
      byoaLoads.push(id)
      return id.startsWith('codex-tools') ? 'legacy-external-secret' : null
    },
  })

  const providers = await service.list()
  assert.equal(providers.length, 9)
  assert.equal(providers.find((provider) => provider.id === 'codex-tools-text')?.credentialState, 'external')
  assert.deepEqual(byoaLoads.sort(), ['codex-tools-image', 'codex-tools-text'])
  assert.equal(JSON.stringify(providers).includes('legacy-external-secret'), false)
})

test('provider list isolates credential presence failures and exposes only a safe unavailable state', async () => {
  const repository = new MemoryProviderRepository()
  repository.upsertProviderConnection('custom-image', {
    enabled: true,
    isDefault: true,
    lastTestStatus: 'ok',
    lastTestMessage: 'previous result',
    lastTestedAt: '2026-07-14T00:00:00.000Z',
  })
  const keychain = new MemoryKeychain()
  const originalExists = keychain.exists.bind(keychain)
  keychain.exists = async (credentialSlot) => {
    if (credentialSlot.providerId === 'custom-image') {
      throw new Error('keychain failure containing super-secret-value')
    }
    return originalExists(credentialSlot)
  }
  const service = new ProviderService({
    repository,
    keychain,
    hasByoaCredential: async (id) => {
      if (id === 'codex-tools-text') throw new Error('BYOA failure containing external-secret')
      return true
    },
    loadByoaCredential: async () => {
      throw new Error('list must not materialize this credential')
    },
  })

  const providers = await service.list()
  assert.equal(providers.length, 9)
  for (const providerId of ['codex-tools-text', 'custom-image']) {
    const provider = providers.find((candidate) => candidate.id === providerId)
    assert.equal(provider?.credentialState, 'missing')
    assert.deepEqual(provider?.health, {
      status: 'unavailable',
      message: '无法检查凭据状态',
    })
  }
  assert.equal(providers.find((provider) => provider.id === 'codex-tools-image')?.credentialState, 'external')
  const serialized = JSON.stringify(providers)
  assert.equal(serialized.includes('super-secret-value'), false)
  assert.equal(serialized.includes('external-secret'), false)
  assert.equal(serialized.includes('previous result'), false)
})

test('BYOK credentials go to Keychain while only a reference is persisted', async () => {
  const { repository, keychain, service } = fixture()
  const apiKey = ['provider', 'fixture', 'secret'].join('-')
  const provider = await service.save('minimax-speech', { apiKey, enabled: true })

  assert.equal(provider.credentialState, 'present')
  assert.equal(provider.enabled, true)
  assert.equal(keychain.values.get('minimax-speech:api-key-r1'), apiKey)
  const record = repository.getProviderConnection('minimax-speech')
  assert.match(record?.credentialRef ?? '', /^keychain:\/\//)
  assert.equal(JSON.stringify(record).includes(apiKey), false)
  assert.equal(JSON.stringify(provider).includes(apiKey), false)
})

test('MiniMax can switch to the official international endpoint but rejects arbitrary hosts', async () => {
  const { service } = fixture()
  const international = await service.save('minimax-speech', {
    apiKey: 'fixture-minimax-key',
    baseUrl: 'https://api.minimax.io',
    enabled: true,
  })

  assert.equal(international.baseUrl, 'https://api.minimax.io')
  assert.equal(international.model, 'speech-2.8-hd')
  assert.equal(international.health.status, 'untested')

  for (const baseUrl of [
    'https://minimax.example/v1',
    'https://api.minimax.io.evil.example',
    'https://api.minimax.io/v1',
  ]) {
    await assert.rejects(
      service.save('minimax-speech', { baseUrl }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderConfigurationError)
        assert.equal(error.code, 'INVALID_PROVIDER_CONFIG')
        assert.match(error.message, /官方区域地址/)
        return true
      },
    )
  }

  await assert.rejects(
    service.save('minimax-speech', { model: 'unregistered-speech-model' }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderConfigurationError)
      assert.equal(error.code, 'INVALID_PROVIDER_CONFIG')
      assert.match(error.message, /官方模型/)
      return true
    },
  )
})

test('BYOA providers reject API keys and custom base URLs enforce HTTPS', async () => {
  const { service } = fixture()
  await assert.rejects(
    service.save('codex-tools-text', { apiKey: 'should-not-be-accepted' }),
    (error: unknown) => error instanceof ProviderConfigurationError && error.code === 'PROVIDER_USES_BYOA',
  )
  await assert.rejects(
    service.save('custom-text', { apiKey: 'fixture', baseUrl: 'http://provider.example/v1' }),
    (error: unknown) => error instanceof ProviderConfigurationError && error.code === 'INVALID_PROVIDER_CONFIG',
  )
})

test('Seedance persists a custom HTTPS gateway and model without exposing its credential', async () => {
  const { repository, service } = fixture()
  const apiKey = ['seedance', 'fixture', 'credential'].join('-')
  const provider = await service.save('seedance-video', {
    apiKey,
    baseUrl: 'https://video-gateway.example/v1',
    model: 'seedance-compatible-model',
    enabled: true,
  })

  assert.equal(provider.configurableBaseUrl, true)
  assert.equal(provider.baseUrl, 'https://video-gateway.example/v1')
  assert.equal(provider.model, 'seedance-compatible-model')
  assert.equal(JSON.stringify(provider).includes(apiKey), false)
  assert.equal(JSON.stringify(repository.getProviderConnection('seedance-video')).includes(apiKey), false)
})

test('Seedance cannot be enabled with an empty editable model', async () => {
  const { service } = fixture()
  await assert.rejects(
    service.save('seedance-video', {
      apiKey: 'fixture-key',
      baseUrl: 'https://video-gateway.example',
      model: '',
      enabled: true,
    }),
    (error: unknown) => error instanceof ProviderConfigurationError
      && error.code === 'PROVIDER_NOT_CONFIGURED'
      && error.message.includes('模型'),
  )
})

test('connection tests retrieve credentials only for the probe and persist safe health', async () => {
  const { repository, service, probes } = fixture()
  const apiKey = ['transient', 'probe', 'credential'].join('-')
  await service.save('seedance-video', { apiKey, enabled: true })
  const tested = await service.test('seedance-video')

  assert.deepEqual(probes, [{ id: 'seedance-video', apiKey }])
  assert.equal(tested.health.status, 'ok')
  assert.equal(tested.health.message, '测试成功')
  assert.equal(JSON.stringify(repository.getProviderConnection('seedance-video')).includes(apiKey), false)
  assert.equal(JSON.stringify(tested).includes(apiKey), false)
})

test('Seedance probe uses the non-billable model-list route for Ark and NewAPI bases', async () => {
  const definition = getProviderDefinition('seedance-video')
  assert.ok(definition)
  const requestedUrls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    requestedUrls.push(String(input))
    return new Response(JSON.stringify({
      data: [{ id: definition.defaultModel, object: 'model' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    for (const baseUrl of [
      'https://ark.cn-beijing.volces.com/api/v3',
      'https://gateway.example',
      'https://gateway.example/v1',
    ]) {
      const result = await defaultProviderProbe(definition, {
        baseUrl,
        model: definition.defaultModel,
        apiKey: 'fixture-key',
      }, new AbortController().signal)
      assert.equal(result.status, 'ok')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(requestedUrls, [
    'https://ark.cn-beijing.volces.com/api/v3/models',
    'https://gateway.example/v1/models',
    'https://gateway.example/v1/models',
  ])
})

test('Seedance Ark and NewAPI probes fail closed when the configured model is absent', async () => {
  const definition = getProviderDefinition('seedance-video')
  assert.ok(definition)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [{ id: 'another-video-model' }],
  }), { status: 200 })) as typeof fetch
  try {
    for (const baseUrl of [
      'https://ark.cn-beijing.volces.com/api/v3',
      'https://gateway.example',
    ]) {
      const result = await defaultProviderProbe(definition, {
        baseUrl,
        model: definition.defaultModel,
        apiKey: 'fixture-key',
      }, new AbortController().signal)
      assert.equal(result.status, 'unavailable')
      assert.match(result.message, /指定 Seedance 模型/)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Seedance Agent Plan probe reads the task list without creating a billable task', async () => {
  const definition = getProviderDefinition('seedance-video')
  assert.ok(definition)
  const originalFetch = globalThis.fetch
  let observedMethod = ''
  let observedAuthorization = ''
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin + url.pathname, 'https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks')
    assert.equal(url.searchParams.get('page_num'), '1')
    assert.equal(url.searchParams.get('page_size'), '1')
    assert.equal(url.searchParams.get('filter.model'), 'doubao-seedance-2.0')
    observedMethod = init?.method ?? 'GET'
    observedAuthorization = new Headers(init?.headers).get('authorization') ?? ''
    return Response.json({ items: [], total: 12 })
  }) as typeof fetch
  try {
    const result = await defaultProviderProbe(definition, {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      model: 'doubao-seedance-2.0',
      apiKey: 'fixture-plan-key',
    }, new AbortController().signal)
    assert.equal(result.status, 'ok')
    assert.match(result.message, /Plan 路由可用/)
    assert.match(result.message, /当前模型可见任务 12 个/)
    assert.match(result.message, /未创建任务，也未验证视频创建额度/)
    assert.equal(observedMethod, 'GET')
    assert.equal(observedAuthorization, 'Bearer fixture-plan-key')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Doubao Speech probe verifies Agent Plan auth with a reserved invalid speaker and never requests audio', async () => {
  const definition = getProviderDefinition('doubao-speech')
  assert.ok(definition)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), definition.defaultBaseUrl)
    assert.equal(init?.method, 'POST')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('x-api-key'), 'fixture-plan-key')
    assert.equal(headers.get('x-api-resource-id'), 'seed-tts-2.0')
    assert.equal(headers.get('authorization'), null)
    const body = JSON.parse(String(init?.body))
    assert.equal(body.req_params.speaker, '__manju_connection_probe__')
    return new Response([
      JSON.stringify({ code: 0, message: 'accepted', data: null }),
      JSON.stringify({ code: 3001, message: 'invalid speaker parameter', data: null }),
      '',
    ].join('\n'), {
      headers: { 'content-type': 'application/x-ndjson' },
    })
  }) as typeof fetch
  try {
    const result = await defaultProviderProbe(definition, {
      baseUrl: definition.defaultBaseUrl,
      model: definition.defaultModel,
      apiKey: 'fixture-plan-key',
    }, new AbortController().signal)
    assert.equal(result.status, 'ok')
    assert.match(result.message, /未生成音频/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('deleting credentials disables a BYOK provider', async () => {
  const { service } = fixture()
  await service.save('custom-image', {
    apiKey: 'fixture-key',
    baseUrl: 'https://images.example/v1',
    model: 'image-model',
    enabled: true,
  })
  const deleted = await service.deleteCredential('custom-image')
  assert.equal(deleted.credentialState, 'missing')
  assert.equal(deleted.enabled, false)
  assert.equal(deleted.isDefault, false)
  assert.equal(deleted.health.status, 'untested')
  assert.equal(deleted.health.testedAt, undefined)
})

test('an explicit custom default replaces the implicit built-in default for its kind', async () => {
  const { service } = fixture()
  await service.save('custom-text', {
    apiKey: 'fixture-key',
    baseUrl: 'https://text.example/v1',
    model: 'text-model',
    enabled: true,
  })
  await service.setDefault('custom-text')
  const providers = await service.list()
  assert.equal(providers.find((provider) => provider.id === 'custom-text')?.isDefault, true)
  assert.equal(providers.find((provider) => provider.id === 'codex-tools-text')?.isDefault, false)
})

test('custom providers require a model before enable, test, or default', async (t) => {
  for (const providerId of ['custom-text', 'custom-image', 'custom-speech']) {
    await t.test(providerId, async () => {
      const { service } = fixture()
      await service.save(providerId, {
        apiKey: 'fixture-key',
        baseUrl: `https://${providerId}.example/v1`,
        model: '',
        enabled: false,
      })

      for (const operation of [
        () => service.save(providerId, { enabled: true }),
        () => service.test(providerId),
        () => service.setDefault(providerId),
      ]) {
        await assert.rejects(
          operation(),
          (error: unknown) => error instanceof ProviderConfigurationError
            && error.code === 'PROVIDER_NOT_CONFIGURED'
            && error.message.includes('模型'),
        )
      }
    })
  }
})

test('actual provider configuration changes clear stale health while identical saves preserve it', async () => {
  const { service } = fixture()
  const initial = {
    apiKey: 'fixture-key-v1',
    baseUrl: 'https://text.example/v1',
    model: 'text-model-v1',
    enabled: true,
  }
  await service.save('custom-text', initial)
  const tested = await service.test('custom-text')
  assert.equal(tested.health.status, 'ok')

  const unchanged = await service.save('custom-text', {
    ...initial,
    baseUrl: 'https://text.example/v1/',
  })
  assert.equal(unchanged.health.status, 'ok')
  assert.equal(unchanged.health.testedAt, tested.health.testedAt)

  const changedModel = await service.save('custom-text', { model: 'text-model-v2' })
  assert.equal(changedModel.health.status, 'untested')
  assert.equal(changedModel.health.testedAt, undefined)

  await service.test('custom-text')
  const changedBaseUrl = await service.save('custom-text', { baseUrl: 'https://text-2.example/v1' })
  assert.equal(changedBaseUrl.health.status, 'untested')
  assert.equal(changedBaseUrl.health.testedAt, undefined)

  await service.test('custom-text')
  const changedApiKey = await service.save('custom-text', { apiKey: 'fixture-key-v2' })
  assert.equal(changedApiKey.health.status, 'untested')
  assert.equal(changedApiKey.health.testedAt, undefined)
})

test('concurrent BYOK rotations receive distinct immutable slots and delete affects only the current head', async () => {
  const { repository, keychain, service, probes } = fixture()
  const common = {
    baseUrl: 'https://text.example/v1',
    model: 'text-model',
    enabled: true,
  }
  const first = await service.save('custom-text', { ...common, apiKey: 'rotation-key-v1' })
  assert.equal(first.configRevision, 1)

  const [second, third] = await Promise.all([
    service.save('custom-text', { apiKey: 'rotation-key-v2' }),
    service.save('custom-text', { apiKey: 'rotation-key-v3' }),
  ])
  assert.equal(second.configRevision, 2)
  assert.equal(third.configRevision, 3)
  assert.equal(keychain.values.get('custom-text:api-key-r1'), 'rotation-key-v1')
  assert.equal(keychain.values.get('custom-text:api-key-r2'), 'rotation-key-v2')
  assert.equal(keychain.values.get('custom-text:api-key-r3'), 'rotation-key-v3')

  await service.test('custom-text')
  assert.deepEqual(probes.at(-1), { id: 'custom-text', apiKey: 'rotation-key-v3' })
  assert.equal((await service.materializeExecutionProfile('custom-text', 1)).apiKey, 'rotation-key-v1')
  assert.equal((await service.materializeExecutionProfile('custom-text', 2)).apiKey, 'rotation-key-v2')
  assert.equal((await service.materializeExecutionProfile('custom-text', 3)).apiKey, 'rotation-key-v3')

  const deleted = await service.deleteCredential('custom-text')
  assert.equal(deleted.configRevision, 4)
  assert.equal(deleted.credentialState, 'missing')
  assert.equal((await service.materializeExecutionProfile('custom-text', 1)).apiKey, 'rotation-key-v1')
  assert.equal((await service.materializeExecutionProfile('custom-text', 2)).apiKey, 'rotation-key-v2')
  assert.equal((await service.materializeExecutionProfile('custom-text', 3)).apiKey, 'rotation-key-v3')

  const publicJson = JSON.stringify(await service.list())
  const repositoryJson = JSON.stringify({
    head: repository.getProviderConnection('custom-text'),
    versions: repository.listProviderConnectionVersions('custom-text'),
  })
  for (const secret of ['rotation-key-v1', 'rotation-key-v2', 'rotation-key-v3']) {
    assert.equal(publicJson.includes(secret), false)
    assert.equal(repositoryJson.includes(secret), false)
  }
})

test('a slow probe cannot verify a credential revision created after that probe started', async () => {
  const repository = new MemoryProviderRepository()
  const keychain = new MemoryKeychain()
  let releaseProbe!: () => void
  let notifyProbeStarted!: () => void
  const probeStarted = new Promise<void>((resolve) => { notifyProbeStarted = resolve })
  const probeCredentials: string[] = []
  const service = new ProviderService({
    repository,
    keychain,
    loadByoaCredential: async () => null,
    probe: async (_provider, configuration) => {
      probeCredentials.push(configuration.apiKey)
      notifyProbeStarted()
      await new Promise<void>((resolve) => { releaseProbe = resolve })
      return { status: 'ok', message: '测试成功' }
    },
  })
  await service.save('custom-text', {
    apiKey: 'probe-race-key-v1',
    baseUrl: 'https://text.example/v1',
    model: 'text-model',
    enabled: true,
  })

  const testing = service.test('custom-text')
  await probeStarted
  let rotationSettled = false
  const rotating = service.save('custom-text', { apiKey: 'probe-race-key-v2' })
    .then((provider) => {
      rotationSettled = true
      return provider
    })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(rotationSettled, false)

  releaseProbe()
  const tested = await testing
  assert.equal(tested.configRevision, 1)
  assert.equal(tested.health.status, 'ok')
  const rotated = await rotating
  assert.equal(rotated.configRevision, 2)
  assert.equal(rotated.health.status, 'untested')
  assert.deepEqual(probeCredentials, ['probe-race-key-v1'])
})

async function probeMiniMax(response: Response) {
  const definition = getProviderDefinition('minimax-speech')
  assert.ok(definition)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => response) as typeof fetch
  try {
    return await defaultProviderProbe(definition, {
      baseUrl: definition.defaultBaseUrl,
      model: definition.defaultModel,
      apiKey: 'fixture-key',
    }, new AbortController().signal)
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('MiniMax probe reads base_resp status codes even when HTTP status is 200', async () => {
  const cases = [
    { code: 0, status: 'ok' },
    { code: 1004, status: 'unavailable' },
    { code: 2049, status: 'unavailable' },
    { code: 1002, status: 'degraded' },
    { code: 1008, status: 'unavailable' },
    { code: 1999, status: 'degraded' },
  ] as const

  for (const testCase of cases) {
    const result = await probeMiniMax(new Response(JSON.stringify({
      base_resp: { status_code: testCase.code, status_msg: 'provider detail must not leak' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    assert.equal(result.status, testCase.status, `status_code=${testCase.code}`)
    assert.equal(result.message.includes('provider detail must not leak'), false)
  }
})

test('MiniMax probe safely rejects malformed and oversized HTTP 200 responses', async () => {
  const malformed = await probeMiniMax(new Response('{not-json', { status: 200 }))
  assert.equal(malformed.status, 'degraded')
  assert.match(malformed.message, /无效响应/)

  const oversized = await probeMiniMax(new Response('x'.repeat(64 * 1024 + 1), { status: 200 }))
  assert.equal(oversized.status, 'degraded')
  assert.match(oversized.message, /响应过大/)

  const declaredOversized = await probeMiniMax(new Response('{}', {
    status: 200,
    headers: { 'content-length': String(64 * 1024 + 1) },
  }))
  assert.equal(declaredOversized.status, 'degraded')
  assert.match(declaredOversized.message, /响应过大/)
})

test('IndexTTS probe requires matching model files and at least one real voice', async () => {
  const definition = getProviderDefinition('indextts-speech')
  assert.ok(definition)
  const responses = [
    {
      body: { status: 'ready', model: 'IndexTTS-2', voice_count: 2, missing_model_files: [] },
      status: 'ok',
    },
    {
      body: { status: 'not_ready', model: 'IndexTTS-2', voice_count: 0, missing_model_files: ['gpt.pth'] },
      status: 'unavailable',
    },
    {
      body: { status: 'ready', model: 'another-model', voice_count: 1, missing_model_files: [] },
      status: 'unavailable',
    },
  ] as const
  const originalFetch = globalThis.fetch
  try {
    for (const candidate of responses) {
      globalThis.fetch = (async (input, init) => {
        assert.equal(String(input), 'http://127.0.0.1:7861/health')
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token')
        return new Response(JSON.stringify(candidate.body), { status: 200 })
      }) as typeof fetch
      const result = await defaultProviderProbe(definition, {
        baseUrl: definition.defaultBaseUrl,
        model: definition.defaultModel,
        apiKey: 'fixture-token',
      }, new AbortController().signal)
      assert.equal(result.status, candidate.status)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
