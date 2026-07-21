import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import type { KeychainCredentialSlot } from './keychain.js'
import type { ProviderCredentialStore } from './providers/service.js'
import type { StoryDocument } from './story-schema.js'
import type {
  ImageEditMode,
  ImageGenerationInput,
  ImageProvider,
  JsonObject,
  ProviderImage,
  ProviderImageReference,
} from './types.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const SOURCE_PNG = Buffer.concat([PNG, Buffer.from([1])])
const REFERENCE_PNG = Buffer.concat([PNG, Buffer.from([2])])
const OUTPUT_PNG = Buffer.concat([PNG, Buffer.from([3])])

class MemoryCredentials implements ProviderCredentialStore {
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

class EditingProvider implements ImageProvider {
  readonly name = 'fixture-image-editor'
  readonly model = 'fixture-model'
  readonly configured = true
  readonly supportsImageReferences = true
  readonly supportsImageEdits = true
  readonly supportsImageVariations = true
  readonly calls: Array<{
    input: ImageGenerationInput
    mode: ImageEditMode
    source: Buffer
    references: Buffer[]
  }> = []
  beforeReturn?: () => Promise<void>

  async health() {
    return { status: 'ok' as const, message: 'ready' }
  }

  async generate(input: ImageGenerationInput): Promise<ProviderImage[]> {
    return Array.from({ length: input.count }, () => ({ bytes: PNG, mimeType: 'image/png' }))
  }

  async edit(
    input: ImageGenerationInput,
    _signal: AbortSignal,
    source: ProviderImageReference,
    references: readonly ProviderImageReference[],
    mode: ImageEditMode,
  ): Promise<ProviderImage[]> {
    this.calls.push({
      input,
      mode,
      source: Buffer.from(source.bytes),
      references: references.map((reference) => Buffer.from(reference.bytes)),
    })
    await this.beforeReturn?.()
    return [{ bytes: OUTPUT_PNG, mimeType: 'image/png', revisedPrompt: input.prompt }]
  }
}

interface Fixture {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
  provider: EditingProvider
}

const fixtures: Fixture[] = []

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address missing')
  return `http://127.0.0.1:${address.port}`
}

async function fixture(
  autoStartWorker = true,
  enforcePaidAigcConfirmation = false,
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-asset-image-edit-'))
  const provider = new EditingProvider()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider,
    keychain: new MemoryCredentials(),
    loadByoaCredential: async (id) => id === 'codex-tools-image' ? 'fixture-key' : null,
    hasByoaCredential: async (id) => id === 'codex-tools-image',
    providerProbe: async () => ({ status: 'ok', message: 'fixture ready' }),
    autoStartWorker,
    enforcePaidAigcConfirmation,
  })
  const server = createServer(runtime.app)
  const value = { directory, runtime, server, baseUrl: await listen(server), provider }
  fixtures.push(value)
  return value
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await new Promise<void>((resolve) => item.server.close(() => resolve()))
    await item.runtime.close()
    await rm(item.directory, { recursive: true, force: true })
  }
})

async function json<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init)
  return { response, body: await response.json() as T }
}

async function terminalJob(baseUrl: string, jobId: string): Promise<Record<string, unknown>> {
  for (let index = 0; index < 200; index += 1) {
    const result = await json<{ job: Record<string, unknown> }>(`${baseUrl}/api/v1/jobs/${jobId}`)
    if (['succeeded', 'failed', 'cancelled'].includes(String(result.body.job.status))) return result.body.job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`job did not finish: ${jobId}`)
}

function story(): StoryDocument {
  return {
    version: 1,
    title: '编辑测试',
    targetDurationSeconds: 30,
    bible: {
      logline: '角色测试',
      theme: '一致性',
      tone: '平静',
      visualStyle: '国风动画',
    },
    characters: [{
      id: 'ali',
      name: '阿离',
      role: '主角',
      storyDescription: '年轻剑客',
      visualDescription: '黑发红绳青袍',
    }],
    locations: [
      {
        id: 'cliff',
        name: '断崖',
        storyDescription: '城外',
        visualDescription: '云海',
      },
      {
        id: 'river',
        name: '河谷',
        storyDescription: '山间河道',
        visualDescription: '青石浅滩',
      },
    ],
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
      description: '角色站立',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `角色近景 ${index + 1}`,
        description: '角色看向远方',
        framing: '近景',
        movement: '固定',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '阿离在断崖',
        dialogueLines: [],
      })),
    }],
  }
}

function persistStory(runtime: ApplicationRuntime, episodeId = 'asset-edit-episode'): string {
  const document = story()
  runtime.storyRepository.ensureEpisode('default', { id: episodeId, title: document.title })
  const project = runtime.database.getProject('default')!
  const revision = runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: project.currentRevisionId,
    summary: '图片编辑测试剧本',
    snapshot: structuredClone(document) as unknown as JsonObject,
  })
  runtime.storyRepository.applyStory(episodeId, document, revision.id)
  return revision.id
}

async function characterAsset(
  runtime: ApplicationRuntime,
  episodeId: string,
  revisionId: string,
  version: number,
  bytes: Uint8Array,
) {
  return runtime.mediaStore.save({
    projectId: 'default',
    episodeId,
    kind: 'character-turnaround',
    version,
    bytes,
    mimeType: 'image/png',
    source: 'provider',
    generationParameters: { entityType: 'character', entityId: 'ali' },
    sourceRevisionId: revisionId,
    width: 1,
    height: 1,
  })
}

async function entityAsset(
  runtime: ApplicationRuntime,
  episodeId: string,
  revisionId: string,
  input: {
    entityType: 'character' | 'location' | 'prop'
    entityId: string
    kind: string
    version?: number
    bytes?: Uint8Array
  },
) {
  return runtime.mediaStore.save({
    projectId: 'default',
    episodeId,
    kind: input.kind,
    version: input.version ?? 1,
    bytes: input.bytes ?? SOURCE_PNG,
    mimeType: 'image/png',
    source: 'provider',
    generationParameters: { entityType: input.entityType, entityId: input.entityId },
    sourceRevisionId: revisionId,
    width: 1,
    height: 1,
  })
}

async function assetEtag(baseUrl: string, assetId: string): Promise<string> {
  const result = await json<{ asset: { etag: string } }>(`${baseUrl}/api/v1/assets/${assetId}`)
  assert.equal(result.response.status, 200)
  assert.ok(result.response.headers.get('etag'))
  assert.equal(result.body.asset.etag, result.response.headers.get('etag'))
  return result.body.asset.etag
}

async function episodeEtag(baseUrl: string, episodeId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/episodes/${episodeId}?projectId=default`)
  assert.equal(response.status, 200)
  const value = response.headers.get('etag')
  assert.ok(value)
  await response.body?.cancel()
  return value
}

test('asset edit creates no paid Job until the exact source request is explicitly confirmed', async () => {
  const { runtime, baseUrl, provider } = await fixture(true, true)
  const episodeId = 'asset-edit-paid-confirmation'
  const revisionId = persistStory(runtime, episodeId)
  const source = await characterAsset(runtime, episodeId, revisionId, 1, SOURCE_PNG)
  const etag = await assetEtag(baseUrl, source.id)
  const path = `${baseUrl}/api/v1/assets/${source.id}/edits`
  const body = {
    projectId: 'default',
    mode: 'edit',
    prompt: '保持角色身份并改为回眸动作',
    providerId: 'codex-tools-image',
    referenceAssetIds: [],
    size: '1024x1024',
    quality: 'high',
  }
  const submit = (
    requestBody: unknown,
    key = 'asset-edit-paid-confirmation-v1',
    confirmation?: string,
  ) => json<{
    error?: {
      code: string
      details?: { confirmation?: { action: string; confirmationToken: string } }
    }
    job?: { id: string }
  }>(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      'if-match': etag,
      ...(confirmation ? { 'x-manju-aigc-confirmation': confirmation } : {}),
    },
    body: JSON.stringify(requestBody),
  })

  const preflight = await submit(body)
  assert.equal(preflight.response.status, 409)
  assert.equal(preflight.body.error?.code, 'PAID_CONFIRMATION_REQUIRED')
  assert.equal(preflight.body.error?.details?.confirmation?.action, 'asset.image.edit')
  assert.equal(provider.calls.length, 0)
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 0)
  const token = preflight.body.error?.details?.confirmation?.confirmationToken
  assert.ok(token)

  const bodyDrift = await submit({ ...body, prompt: '确认后偷偷改变的提示词' }, undefined, token)
  assert.equal(bodyDrift.response.status, 409)
  assert.equal(bodyDrift.body.error?.code, 'PAID_CONFIRMATION_REQUIRED')
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 0)

  const keyDrift = await submit(body, 'asset-edit-paid-confirmation-v2', token)
  assert.equal(keyDrift.response.status, 409)
  assert.equal(keyDrift.body.error?.code, 'PAID_CONFIRMATION_REQUIRED')
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 0)

  const confirmed = await submit(body, undefined, token)
  assert.equal(confirmed.response.status, 202, JSON.stringify(confirmed.body))
  assert.ok(confirmed.body.job?.id)
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 1)

  const replay = await submit(body)
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.job?.id, confirmed.body.job?.id)
  assert.equal(runtime.database.listGenerationJobs({ projectId: 'default' }).length, 1)
})

test('asset edit sends immutable source/reference bytes and publishes a lockable max-version child', async () => {
  const { runtime, baseUrl, provider } = await fixture()
  const episodeId = 'asset-edit-success'
  const revisionId = persistStory(runtime, episodeId)
  const source = await characterAsset(runtime, episodeId, revisionId, 1, SOURCE_PNG)
  const newerSibling = await characterAsset(runtime, episodeId, revisionId, 2, REFERENCE_PNG)
  const etag = await assetEtag(baseUrl, source.id)
  const body = JSON.stringify({
    projectId: 'default',
    mode: 'edit',
    prompt: '保持阿离身份，改为拔剑动作',
    providerId: 'codex-tools-image',
    referenceAssetIds: [newerSibling.id],
    size: '1024x1024',
    quality: 'high',
  })
  const submit = () => json<{ job: { id: string; input: Record<string, unknown> } }>(
    `${baseUrl}/api/v1/assets/${source.id}/edits`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'asset-edit-success-v1',
        'if-match': etag,
      },
      body,
    },
  )
  const created = await submit()
  assert.equal(created.response.status, 202, JSON.stringify(created.body))
  assert.equal(created.body.job.input.operation, 'asset.image.edit')
  assert.equal(created.body.job.input.sourceAssetId, source.id)
  assert.deepEqual((created.body.job.input.assetEntityBinding as Record<string, unknown>).parentAssetId, source.id)
  assert.equal((created.body.job.input.assetEntityBinding as Record<string, unknown>).nextVersion, 3)

  const completed = await terminalJob(baseUrl, created.body.job.id)
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed))
  assert.equal(provider.calls.length, 1)
  assert.equal(provider.calls[0].mode, 'edit')
  assert.deepEqual(provider.calls[0].source, SOURCE_PNG)
  assert.deepEqual(provider.calls[0].references, [REFERENCE_PNG])
  const output = completed.output as { images: Array<{ id: string }> }
  const edited = runtime.database.getMediaAsset(output.images[0].id)!
  assert.equal(edited.parentAssetId, source.id)
  assert.equal(edited.version, 3)
  assert.equal(edited.sourceRevisionId, revisionId)
  assert.equal(edited.generationParameters.operation, 'asset.image.edit')
  assert.equal(edited.generationParameters.mode, 'edit')
  assert.equal(edited.generationParameters.entityType, 'character')
  assert.equal(edited.generationParameters.entityId, 'ali')
  assert.equal((edited.generationParameters.source as JsonObject).assetId, source.id)
  const openedEdited = await runtime.mediaStore.openAsset(edited.id)
  try {
    assert.deepEqual(Buffer.from(await openedEdited.file.readFile()), OUTPUT_PNG)
  } finally {
    await openedEdited.file.close()
  }

  const targets = await json<{ targets: Array<{ id: string; lockedAssetId: string | null }> }>(
    `${baseUrl}/api/v1/episodes/${episodeId}/visual-asset-targets?projectId=default`,
  )
  assert.equal(targets.body.targets.find((target) => target.id === 'ali')?.lockedAssetId, null)
  const lock = await json<{ target: { lockedAssetId: string } }>(`${baseUrl}/api/v1/assets/${edited.id}/lock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': await episodeEtag(baseUrl, episodeId) },
    body: JSON.stringify({
      projectId: 'default',
      episodeId,
      targetType: 'character',
      targetId: 'ali',
    }),
  })
  assert.equal(lock.response.status, 201, JSON.stringify(lock.body))
  assert.equal(lock.body.target.lockedAssetId, edited.id)

  const replay = await submit()
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.job.id, created.body.job.id)
  assert.equal(provider.calls.length, 1)
  const conflict = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/assets/${source.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'asset-edit-success-v1',
      'if-match': etag,
    },
    body: JSON.stringify({ ...JSON.parse(body), prompt: '不同的编辑' }),
  })
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT')
})

test('asset edit rejects stale/cross-project/identity references and missing capabilities before billing', async () => {
  const { runtime, baseUrl, provider } = await fixture()
  const episodeId = 'asset-edit-security'
  const revisionId = persistStory(runtime, episodeId)
  const source = await characterAsset(runtime, episodeId, revisionId, 1, SOURCE_PNG)
  const etag = await assetEtag(baseUrl, source.id)

  runtime.database.createProject({ id: 'other-project', title: '其他项目' })
  const foreign = await runtime.mediaStore.save({
    projectId: 'other-project',
    kind: 'reference.image',
    bytes: REFERENCE_PNG,
    mimeType: 'image/png',
    source: 'upload',
  })
  const crossProject = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/assets/${source.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'cross-project-ref',
      'if-match': etag,
    },
    body: JSON.stringify({
      projectId: 'default',
      mode: 'edit',
      prompt: '跨项目参考',
      referenceAssetIds: [foreign.id],
    }),
  })
  assert.equal(crossProject.response.status, 400)
  assert.equal(crossProject.body.error.code, 'INVALID_REFERENCE_ASSET', JSON.stringify(crossProject.body))

  const genericReference = await runtime.mediaStore.save({
    projectId: 'default',
    episodeId,
    kind: 'reference.image',
    bytes: REFERENCE_PNG,
    mimeType: 'image/png',
    source: 'upload',
    sourceRevisionId: revisionId,
  })
  const identityMismatch = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/assets/${source.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'identity-ref',
      'if-match': etag,
    },
    body: JSON.stringify({
      projectId: 'default',
      mode: 'edit',
      prompt: '身份不明的参考',
      referenceAssetIds: [genericReference.id],
    }),
  })
  assert.equal(identityMismatch.response.status, 400)
  assert.equal(identityMismatch.body.error.code, 'INVALID_REFERENCE_ASSET')

  const variationReferences = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/assets/${source.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'variation-ref',
      'if-match': etag,
    },
    body: JSON.stringify({
      projectId: 'default',
      mode: 'variation',
      prompt: '原生变体',
      referenceAssetIds: [source.id],
    }),
  })
  assert.equal(variationReferences.response.status, 400)
  assert.equal(variationReferences.body.error.code, 'INVALID_REFERENCE_ASSET')

  await runtime.providerService.save('custom-image', {
    apiKey: 'fixture-custom-key',
    baseUrl: 'https://provider.invalid/v1',
    model: 'custom-model',
    enabled: true,
  })
  const noCapability = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/assets/${source.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'no-edit-capability',
      'if-match': etag,
    },
    body: JSON.stringify({
      projectId: 'default',
      mode: 'edit',
      prompt: '不允许降级',
      providerId: 'custom-image',
    }),
  })
  assert.equal(noCapability.response.status, 409)
  assert.equal(noCapability.body.error.code, 'PROVIDER_CAPABILITY_MISSING')
  assert.equal(provider.calls.length, 0)
})

test('every bound entity type requires every edit reference to match the exact entity identity', async () => {
  const { runtime, baseUrl, provider } = await fixture()
  const episodeId = 'asset-edit-all-entity-references'
  const revisionId = persistStory(runtime, episodeId)
  const locationSource = await entityAsset(runtime, episodeId, revisionId, {
    entityType: 'location',
    entityId: 'cliff',
    kind: 'location-concept',
    version: 1,
    bytes: SOURCE_PNG,
  })
  const locationReference = await entityAsset(runtime, episodeId, revisionId, {
    entityType: 'location',
    entityId: 'cliff',
    kind: 'location-concept',
    version: 2,
    bytes: REFERENCE_PNG,
  })
  const prop = await entityAsset(runtime, episodeId, revisionId, {
    entityType: 'prop',
    entityId: 'token',
    kind: 'prop-concept',
    bytes: Buffer.concat([PNG, Buffer.from([4])]),
  })
  const otherLocation = await entityAsset(runtime, episodeId, revisionId, {
    entityType: 'location',
    entityId: 'river',
    kind: 'location-concept',
    bytes: Buffer.concat([PNG, Buffer.from([6])]),
  })
  const character = await characterAsset(
    runtime,
    episodeId,
    revisionId,
    1,
    Buffer.concat([PNG, Buffer.from([5])]),
  )

  for (const [label, source, reference] of [
    ['location-to-prop', locationSource, prop],
    ['location-to-character', locationSource, character],
    ['location-to-other-location', locationSource, otherLocation],
    ['prop-to-location', prop, locationReference],
  ] as const) {
    const rejected = await json<{ error: { code: string } }>(`${baseUrl}/api/v1/assets/${source.id}/edits`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `entity-reference-${label}`,
        'if-match': await assetEtag(baseUrl, source.id),
      },
      body: JSON.stringify({
        projectId: 'default',
        mode: 'edit',
        prompt: '实体参考一致性',
        referenceAssetIds: [reference.id],
      }),
    })
    assert.equal(rejected.response.status, 400, JSON.stringify(rejected.body))
    assert.equal(rejected.body.error.code, 'INVALID_REFERENCE_ASSET')
  }
  assert.equal(provider.calls.length, 0)

  const accepted = await json<{ job: { id: string } }>(`${baseUrl}/api/v1/assets/${locationSource.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'entity-reference-location-match',
      'if-match': await assetEtag(baseUrl, locationSource.id),
    },
    body: JSON.stringify({
      projectId: 'default',
      mode: 'edit',
      prompt: '同一场景的参考图',
      referenceAssetIds: [locationReference.id],
    }),
  })
  assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body))
  const completed = await terminalJob(baseUrl, accepted.body.job.id)
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed))
  assert.equal(provider.calls.length, 1)
})

test('durable edit binding rejects a forged non-character reference identity before Provider access', async () => {
  const value = await fixture(false)
  const episodeId = 'asset-edit-reference-binding-tamper'
  const revisionId = persistStory(value.runtime, episodeId)
  const source = await entityAsset(value.runtime, episodeId, revisionId, {
    entityType: 'location',
    entityId: 'cliff',
    kind: 'location-concept',
    version: 1,
    bytes: SOURCE_PNG,
  })
  const reference = await entityAsset(value.runtime, episodeId, revisionId, {
    entityType: 'location',
    entityId: 'cliff',
    kind: 'location-concept',
    version: 2,
    bytes: REFERENCE_PNG,
  })
  const submitted = await json<{ job: { id: string } }>(`${value.baseUrl}/api/v1/assets/${source.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'entity-reference-tamper-v1',
      'if-match': await assetEtag(value.baseUrl, source.id),
    },
    body: JSON.stringify({
      projectId: 'default',
      mode: 'edit',
      prompt: '排队后绑定被篡改',
      referenceAssetIds: [reference.id],
    }),
  })
  assert.equal(submitted.response.status, 202, JSON.stringify(submitted.body))
  value.runtime.database.withSql((sql) => sql.run(`
    UPDATE generation_jobs
    SET input_json = json_set(
      input_json,
      '$.editBinding.references[0].entityType', 'prop',
      '$.editBinding.references[0].entityId', 'token'
    )
    WHERE id = ?
  `, submitted.body.job.id))
  await value.runtime.worker.start()
  const failed = await terminalJob(value.baseUrl, submitted.body.job.id)
  assert.equal(failed.status, 'failed')
  assert.equal((failed.error as Record<string, unknown>).code, 'INVALID_ASSET_EDIT_BINDING')
  assert.equal(value.provider.calls.length, 0)
})

test('asset version-family admission rejects concurrent edits and entity generations before billing', async () => {
  const edits = await fixture(false)
  const episodeId = 'asset-edit-concurrent-family'
  const revisionId = persistStory(edits.runtime, episodeId)
  const source = await characterAsset(edits.runtime, episodeId, revisionId, 1, SOURCE_PNG)
  const sibling = await characterAsset(edits.runtime, episodeId, revisionId, 2, REFERENCE_PNG)
  const first = await json<{ job: { id: string } }>(`${edits.baseUrl}/api/v1/assets/${source.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'concurrent-family-first-edit',
      'if-match': await assetEtag(edits.baseUrl, source.id),
    },
    body: JSON.stringify({ projectId: 'default', mode: 'edit', prompt: '第一个排队编辑' }),
  })
  assert.equal(first.response.status, 202, JSON.stringify(first.body))
  const second = await json<{ error: { code: string; details?: { activeJobId?: string } } }>(
    `${edits.baseUrl}/api/v1/assets/${sibling.id}/edits`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'concurrent-family-second-edit',
        'if-match': await assetEtag(edits.baseUrl, sibling.id),
      },
      body: JSON.stringify({ projectId: 'default', mode: 'edit', prompt: '同谱系并发编辑' }),
    },
  )
  assert.equal(second.response.status, 409, JSON.stringify(second.body))
  assert.equal(second.body.error.code, 'ASSET_VERSION_FAMILY_BUSY')
  assert.equal(second.body.error.details?.activeJobId, first.body.job.id)

  const generationWhileEditing = await json<{ error: { code: string } }>(
    `${edits.baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'generation-while-editing' },
      body: JSON.stringify({
        projectId: 'default',
        episodeId,
        input: {
          prompt: '同角色生成冲突',
          count: 1,
          metadata: { kind: 'character-turnaround', entityType: 'character', entityId: 'ali' },
        },
      }),
    },
  )
  assert.equal(generationWhileEditing.response.status, 409, JSON.stringify(generationWhileEditing.body))
  assert.equal(generationWhileEditing.body.error.code, 'ASSET_VERSION_FAMILY_BUSY')
  assert.equal(edits.provider.calls.length, 0)
  assert.equal(edits.runtime.database.listGenerationJobs({
    projectId: 'default',
    type: 'asset.image.edit',
  }).length, 1)

  const generations = await fixture(false)
  const generationEpisodeId = 'asset-generation-concurrent-family'
  const generationRevisionId = persistStory(generations.runtime, generationEpisodeId)
  const generationSource = await characterAsset(
    generations.runtime,
    generationEpisodeId,
    generationRevisionId,
    1,
    SOURCE_PNG,
  )
  const queuedGeneration = await json<{ job: { id: string } }>(
    `${generations.baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'concurrent-generation-first' },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: generationEpisodeId,
        input: {
          prompt: '排队的角色生成',
          count: 1,
          metadata: { kind: 'character-turnaround', entityType: 'character', entityId: 'ali' },
        },
      }),
    },
  )
  assert.equal(queuedGeneration.response.status, 202, JSON.stringify(queuedGeneration.body))
  const editWhileGenerating = await json<{ error: { code: string } }>(
    `${generations.baseUrl}/api/v1/assets/${generationSource.id}/edits`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'edit-while-generating',
        'if-match': await assetEtag(generations.baseUrl, generationSource.id),
      },
      body: JSON.stringify({ projectId: 'default', mode: 'edit', prompt: '生成中的并发编辑' }),
    },
  )
  assert.equal(editWhileGenerating.response.status, 409, JSON.stringify(editWhileGenerating.body))
  assert.equal(editWhileGenerating.body.error.code, 'ASSET_VERSION_FAMILY_BUSY')
  const secondGeneration = await json<{ error: { code: string } }>(
    `${generations.baseUrl}/api/v1/assets/image-generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'concurrent-generation-second' },
      body: JSON.stringify({
        projectId: 'default',
        episodeId: generationEpisodeId,
        input: {
          prompt: '第二个并发角色生成',
          count: 1,
          metadata: { kind: 'character-turnaround', entityType: 'character', entityId: 'ali' },
        },
      }),
    },
  )
  assert.equal(secondGeneration.response.status, 409, JSON.stringify(secondGeneration.body))
  assert.equal(secondGeneration.body.error.code, 'ASSET_VERSION_FAMILY_BUSY')
  assert.equal(generations.provider.calls.length, 0)
})

test('queued edit fails closed on source or Provider drift and rolls back a response-time race', async () => {
  const queued = await fixture(false)
  const episodeId = 'asset-edit-drift'
  const revisionId = persistStory(queued.runtime, episodeId)
  const source = await characterAsset(queued.runtime, episodeId, revisionId, 1, SOURCE_PNG)
  const etag = await assetEtag(queued.baseUrl, source.id)
  const submitted = await json<{ job: { id: string } }>(`${queued.baseUrl}/api/v1/assets/${source.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'provider-drift-before-call',
      'if-match': etag,
    },
    body: JSON.stringify({ projectId: 'default', mode: 'edit', prompt: '排队编辑' }),
  })
  assert.equal(submitted.response.status, 202, JSON.stringify(submitted.body))
  await queued.runtime.providerService.save('codex-tools-image', { model: 'rotated-model' })
  await queued.runtime.worker.start()
  const failed = await terminalJob(queued.baseUrl, submitted.body.job.id)
  assert.equal(failed.status, 'failed')
  assert.equal((failed.error as Record<string, unknown>).code, 'PROVIDER_CONFIGURATION_DRIFT')
  assert.equal(queued.provider.calls.length, 0)
  assert.equal(queued.runtime.database.listMediaAssets({ projectId: 'default', episodeId }).length, 1)

  const race = await fixture()
  const raceEpisodeId = 'asset-edit-response-race'
  const raceRevisionId = persistStory(race.runtime, raceEpisodeId)
  const raceSource = await characterAsset(race.runtime, raceEpisodeId, raceRevisionId, 1, SOURCE_PNG)
  race.provider.beforeReturn = async () => {
    await race.runtime.providerService.save('codex-tools-image', { model: 'rotated-during-call' })
  }
  const raced = await json<{ job: { id: string } }>(`${race.baseUrl}/api/v1/assets/${raceSource.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'provider-drift-after-call',
      'if-match': await assetEtag(race.baseUrl, raceSource.id),
    },
    body: JSON.stringify({ projectId: 'default', mode: 'edit', prompt: '响应竞态' }),
  })
  const racedFailed = await terminalJob(race.baseUrl, raced.body.job.id)
  assert.equal(racedFailed.status, 'failed')
  assert.equal((racedFailed.error as Record<string, unknown>).code, 'PROVIDER_CONFIGURATION_DRIFT')
  assert.equal(race.provider.calls.length, 1)
  assert.equal(race.runtime.database.listMediaAssets({ projectId: 'default', episodeId: raceEpisodeId }).length, 1)
})

test('asset edit enforces MIME, count, byte limits, and the queued episode revision before billing', async () => {
  const value = await fixture()
  const episodeId = 'asset-edit-limits'
  const revisionId = persistStory(value.runtime, episodeId)
  const source = await characterAsset(value.runtime, episodeId, revisionId, 1, SOURCE_PNG)
  const sourceEtag = await assetEtag(value.baseUrl, source.id)
  const references = [] as string[]
  for (let index = 0; index < 5; index += 1) {
    references.push((await characterAsset(
      value.runtime,
      episodeId,
      revisionId,
      index + 2,
      Buffer.concat([PNG, Buffer.from([10 + index])]),
    )).id)
  }
  const tooMany = await json<{ error: { code: string } }>(`${value.baseUrl}/api/v1/assets/${source.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'too-many-edit-references',
      'if-match': sourceEtag,
    },
    body: JSON.stringify({
      projectId: 'default',
      mode: 'edit',
      prompt: '参考图超限',
      referenceAssetIds: references,
    }),
  })
  assert.equal(tooMany.response.status, 400)
  assert.equal(tooMany.body.error.code, 'INVALID_REFERENCE_ASSET')

  const wav = Buffer.alloc(12)
  wav.write('RIFF', 0, 'ascii')
  wav.write('WAVE', 8, 'ascii')
  const audio = await value.runtime.mediaStore.save({
    projectId: 'default',
    episodeId,
    kind: 'reference.audio',
    bytes: wav,
    mimeType: 'audio/wav',
    source: 'upload',
    sourceRevisionId: revisionId,
  })
  const wrongMime = await json<{ error: { code: string } }>(`${value.baseUrl}/api/v1/assets/${audio.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'wrong-edit-mime',
      'if-match': await assetEtag(value.baseUrl, audio.id),
    },
    body: JSON.stringify({ projectId: 'default', mode: 'edit', prompt: '不能编辑音频' }),
  })
  assert.equal(wrongMime.response.status, 400)
  assert.equal(wrongMime.body.error.code, 'INVALID_SOURCE_ASSET')

  const countInjection = await json<{ error: { code: string } }>(`${value.baseUrl}/api/v1/assets/${source.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'edit-count-injection',
      'if-match': sourceEtag,
    },
    body: JSON.stringify({ projectId: 'default', mode: 'edit', prompt: '不允许批量部分发布', count: 2 }),
  })
  assert.equal(countInjection.response.status, 400)
  assert.equal(countInjection.body.error.code, 'INVALID_ASSET_EDIT_REQUEST')

  const largeBytes = Buffer.alloc(30 * 1024 * 1024 + 1)
  PNG.copy(largeBytes, 0, 0, Math.min(PNG.length, largeBytes.length))
  const large = await characterAsset(value.runtime, episodeId, revisionId, 7, largeBytes)
  const largeJob = await json<{ job: { id: string } }>(`${value.baseUrl}/api/v1/assets/${large.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'oversized-source-image',
      'if-match': await assetEtag(value.baseUrl, large.id),
    },
    body: JSON.stringify({ projectId: 'default', mode: 'edit', prompt: '大图限制' }),
  })
  assert.equal(largeJob.response.status, 202)
  const largeFailed = await terminalJob(value.baseUrl, largeJob.body.job.id)
  assert.equal(largeFailed.status, 'failed')
  assert.equal((largeFailed.error as Record<string, unknown>).code, 'ASSET_IMAGE_TOO_LARGE')
  assert.equal(value.provider.calls.length, 0)

  const stale = await fixture(false)
  const staleEpisodeId = 'asset-edit-stale-episode'
  const staleRevision = persistStory(stale.runtime, staleEpisodeId)
  const staleSource = await characterAsset(stale.runtime, staleEpisodeId, staleRevision, 1, SOURCE_PNG)
  const submitted = await json<{ job: { id: string } }>(`${stale.baseUrl}/api/v1/assets/${staleSource.id}/edits`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'stale-episode-before-billing',
      'if-match': await assetEtag(stale.baseUrl, staleSource.id),
    },
    body: JSON.stringify({ projectId: 'default', mode: 'edit', prompt: '源修订竞态' }),
  })
  assert.equal(submitted.response.status, 202)
  const replacement = stale.runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: staleRevision,
    summary: '测试修订漂移',
    snapshot: { kind: 'test.revision' },
  })
  stale.runtime.database.withSql((sql) => sql.run(
    'UPDATE episodes SET source_revision_id = ? WHERE id = ?',
    replacement.id,
    staleEpisodeId,
  ))
  await stale.runtime.worker.start()
  const staleFailed = await terminalJob(stale.baseUrl, submitted.body.job.id)
  assert.equal(staleFailed.status, 'failed')
  assert.equal((staleFailed.error as Record<string, unknown>).code, 'STALE_SOURCE')
  assert.equal(stale.provider.calls.length, 0)
})

test('queued image edit survives a process restart without losing its immutable bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-asset-image-edit-restart-'))
  const firstProvider = new EditingProvider()
  const common = {
    runtimeDirectory: directory,
    enforcePaidAigcConfirmation: false,
    keychain: new MemoryCredentials(),
    loadByoaCredential: async (id: string) => id === 'codex-tools-image' ? 'fixture-key' : null,
    hasByoaCredential: async (id: string) => id === 'codex-tools-image',
    providerProbe: async () => ({ status: 'ok' as const, message: 'fixture ready' }),
  }
  let first: ApplicationRuntime | undefined
  let second: ApplicationRuntime | undefined
  let firstServer: Server | undefined
  let secondServer: Server | undefined
  try {
    first = await createApplication({ ...common, provider: firstProvider, autoStartWorker: false })
    firstServer = createServer(first.app)
    const firstBaseUrl = await listen(firstServer)
    const episodeId = 'asset-edit-restart'
    const revisionId = persistStory(first, episodeId)
    const source = await characterAsset(first, episodeId, revisionId, 1, SOURCE_PNG)
    const submitted = await json<{ job: { id: string } }>(`${firstBaseUrl}/api/v1/assets/${source.id}/edits`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'restart-durable-edit',
        'if-match': await assetEtag(firstBaseUrl, source.id),
      },
      body: JSON.stringify({ projectId: 'default', mode: 'variation', prompt: '可恢复变体' }),
    })
    assert.equal(submitted.response.status, 202, JSON.stringify(submitted.body))
    await new Promise<void>((resolve) => firstServer!.close(() => resolve()))
    firstServer = undefined
    await first.close()
    first = undefined

    const recoveredProvider = new EditingProvider()
    second = await createApplication({ ...common, provider: recoveredProvider })
    secondServer = createServer(second.app)
    const secondBaseUrl = await listen(secondServer)
    const completed = await terminalJob(secondBaseUrl, submitted.body.job.id)
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed))
    assert.equal(recoveredProvider.calls.length, 1)
    assert.equal(recoveredProvider.calls[0].mode, 'variation')
    assert.deepEqual(recoveredProvider.calls[0].source, SOURCE_PNG)
    const outputId = ((completed.output as { images: Array<{ id: string }> }).images[0].id)
    assert.equal(second.database.getMediaAsset(outputId)?.parentAssetId, source.id)
  } finally {
    if (firstServer) await new Promise<void>((resolve) => firstServer!.close(() => resolve()))
    if (secondServer) await new Promise<void>((resolve) => secondServer!.close(() => resolve()))
    await first?.close()
    await second?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
