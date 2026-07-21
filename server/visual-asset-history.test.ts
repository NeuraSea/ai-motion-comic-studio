import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createApplication, type ApplicationRuntime } from './app.js'
import { episodeEtag } from './episode-version.js'
import type { StoryDocument } from './story-schema.js'
import type { JsonObject } from './types.js'
import { resolveVisualAssetEntity } from './visual-asset-generation.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

interface Fixture {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
}

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await new Promise<void>((resolve, reject) => item.server.close((error) => error ? reject(error) : resolve()))
    await item.runtime.close()
    await rm(item.directory, { recursive: true, force: true })
  }
})

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-visual-history-'))
  const runtime = await createApplication({
    runtimeDirectory: directory,
    autoStartWorker: false,
    enforcePaidAigcConfirmation: true,
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
  })
  const server = createServer(runtime.app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  const value = {
    directory,
    runtime,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
  fixtures.push(value)
  return value
}

function shot(id: string, sequence: number) {
  return {
    id,
    sequence,
    code: `S0-${sequence}`,
    title: id,
    description: `${id} 描述`,
    framing: '中景',
    movement: '静止',
    transition: '硬切',
    durationSeconds: 4,
    visualPrompt: `${id} 视觉提示`,
    dialogueLines: [],
  }
}

const FORWARD_SHOTS = ['sh0', 'sh1', 'sh2', 'sh3', 'sh4', 'sh5'] as const
const REORDERED_SHOTS = ['sh1', 'sh0', 'sh2', 'sh3', 'sh4', 'sh5'] as const

function story(order: readonly string[] = FORWARD_SHOTS, visualDescription = '红衣，黑发。'): StoryDocument {
  return {
    version: 1,
    title: '历史素材测试',
    targetDurationSeconds: 30,
    bible: {
      logline: '测试历史视觉素材恢复。',
      theme: '恢复',
      tone: '稳定',
      visualStyle: '国风动画，克制光影。',
    },
    characters: [{
      id: 'ali',
      name: '阿离',
      role: '主角',
      storyDescription: '守在断崖。',
      visualDescription,
    }],
    locations: [{
      id: 'cliff',
      name: '断崖',
      storyDescription: '秦岭断崖。',
      visualDescription: '暮春，云海。',
    }],
    props: [],
    scenes: [{
      id: 's0',
      sequence: 0,
      title: '断崖',
      locationId: 'cliff',
      timeOfDay: '黄昏',
      description: '阿离守在断崖。',
      shots: order.map((id, sequence) => ({ ...shot(id, sequence), durationSeconds: 5 })),
    }],
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init)
  const body = await response.json() as T
  return { response, body }
}

async function seedHistoricalCharacterAsset(runtime: ApplicationRuntime, episodeId: string) {
  const stories = runtime.storyRepository
  stories.ensureEpisode('default', {
    id: episodeId,
    title: '历史素材测试',
    aspectRatio: '16:9',
    stylePreset: '国风动画',
  })
  const historical = stories.applyStory(episodeId, story())
  const target = resolveVisualAssetEntity(runtime.database, {
    projectId: 'default',
    episodeId,
    entityType: 'character',
    entityId: 'ali',
  })
  const provider = runtime.database.getProviderConnection('codex-tools-image')
  assert.ok(provider)
  const assetId = 'historical-character-version'
  const jobId = 'historical-character-generation'
  const prompt = '制作阿离角色三视图。'
  const input: JsonObject = {
    prompt,
    size: '1536x1024',
    quality: 'medium',
    count: 1,
    metadata: {
      kind: 'character-turnaround',
      entityType: 'character',
      entityId: 'ali',
    },
    assetEntityBinding: {
      episodeId,
      entityType: 'character',
      entityId: 'ali',
      databaseEntityId: target.databaseId,
      expectedRevisionId: historical.revision.id,
      parentAssetId: null,
      nextVersion: 1,
    },
    episodeBinding: {
      episodeId,
      expectedRevisionId: historical.revision.id,
      stylePreset: '国风动画',
      aspectRatio: '16:9',
    },
  }
  runtime.database.createGenerationJob({
    id: jobId,
    projectId: 'default',
    episodeId,
    type: 'asset.image.generate',
    status: 'succeeded',
    progress: 100,
    resourceType: 'character',
    resourceId: 'character:ali',
    providerId: provider.id,
    model: provider.defaultModel,
    providerConfigRevision: provider.configRevision,
    idempotencyKey: 'historical-source-generation',
    input,
    output: {
      images: [{ id: assetId, url: `/api/v1/assets/${assetId}/content`, mimeType: 'image/png' }],
      referenceAssetIds: [],
    },
    startedAt: historical.revision.createdAt,
    completedAt: historical.revision.createdAt,
  })
  const asset = await runtime.mediaStore.save({
    id: assetId,
    projectId: 'default',
    episodeId,
    kind: 'character-turnaround',
    version: 1,
    bytes: PNG,
    mimeType: 'image/png',
    source: 'provider',
    providerId: provider.id,
    generationJobId: jobId,
    generationParameters: {
      prompt,
      size: '1536x1024',
      quality: 'medium',
      index: 0,
      referenceAssetIds: [],
      stylePreset: '国风动画',
      aspectRatio: '16:9',
      entityType: 'character',
      entityId: 'ali',
      entityName: '阿离',
      sourceRevisionId: historical.revision.id,
    },
    sourceRevisionId: historical.revision.id,
    width: 1,
    height: 1,
  })
  return { historical, asset }
}

test('lists and adopts an exact historical visual version without a Provider call', async () => {
  const { runtime, baseUrl, directory } = await fixture()
  const episodeId = 'visual-history-episode'
  const seeded = await seedHistoricalCharacterAsset(runtime, episodeId)
  const current = runtime.storyRepository.applyStory(episodeId, story(REORDERED_SHOTS))
  assert.notEqual(current.revision.id, seeded.historical.revision.id)

  const listed = await json<{
    episodeId: string
    sourceRevisionId: string
    entityType: string
    entityId: string
    candidates: Array<{
      asset: { id: string }
      assetFamilyId: string
      assetVersionId: string
      priorSourceRevisionId: string
      currentSourceRevisionId: string
      semanticFingerprint: string
      compatibility: { providerCallRequired: boolean }
    }>
  }>(`${baseUrl}/api/v1/episodes/${episodeId}/visual-asset-history?projectId=default&entityType=character&entityId=ali`)
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body))
  assert.equal(listed.body.sourceRevisionId, current.revision.id)
  assert.equal(listed.body.candidates.length, 1)
  assert.equal(listed.body.candidates[0].asset.id, seeded.asset.id)
  assert.equal(listed.body.candidates[0].assetFamilyId, seeded.asset.id)
  assert.equal(listed.body.candidates[0].assetVersionId, seeded.asset.id)
  assert.equal(listed.body.candidates[0].priorSourceRevisionId, seeded.historical.revision.id)
  assert.equal(listed.body.candidates[0].currentSourceRevisionId, current.revision.id)
  assert.match(listed.body.candidates[0].semanticFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(listed.body.candidates[0].compatibility.providerCallRequired, false)
  const etag = listed.response.headers.get('etag')
  assert.ok(etag)

  const submit = () => json<{
    adoption: {
      asset: {
        id: string
        parentAssetId: string
        source: string
        sourceRevisionId: string
        generationJobId: string
        checksum: string
        version: number
      }
      sourceAsset: { id: string }
      job: { id: string; type: string; providerId: string | null; status: string }
      revision: { id: string }
      assetFamilyId: string
      assetVersionId: string
      previousAssetVersionId: string
      sourceRevisionId: string
      priorSourceRevisionId: string
      idempotent: boolean
      providerCallRequired: boolean
    }
  }>(`${baseUrl}/api/v1/assets/${seeded.asset.id}/adopt-current-visual-revision`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': etag!,
      'idempotency-key': 'adopt-historical-character-v1',
    },
    body: JSON.stringify({
      projectId: 'default',
      episodeId,
      entityType: 'character',
      entityId: 'ali',
    }),
  })
  const adopted = await submit()
  assert.equal(adopted.response.status, 201, JSON.stringify(adopted.body))
  assert.equal(adopted.body.adoption.asset.parentAssetId, seeded.asset.id)
  assert.equal(adopted.body.adoption.asset.source, 'history-adoption')
  assert.equal(adopted.body.adoption.asset.sourceRevisionId, current.revision.id)
  assert.equal(adopted.body.adoption.asset.version, 2)
  assert.equal(adopted.body.adoption.sourceAsset.id, seeded.asset.id)
  assert.equal(adopted.body.adoption.job.type, 'asset.image.history.adopt')
  assert.equal(adopted.body.adoption.job.status, 'succeeded')
  assert.equal(adopted.body.adoption.job.providerId, null)
  assert.equal(adopted.body.adoption.assetFamilyId, seeded.asset.id)
  assert.equal(adopted.body.adoption.assetVersionId, adopted.body.adoption.asset.id)
  assert.equal(adopted.body.adoption.previousAssetVersionId, seeded.asset.id)
  assert.equal(adopted.body.adoption.providerCallRequired, false)
  assert.equal(adopted.body.adoption.idempotent, false)
  assert.ok(runtime.database.getRevision(adopted.body.adoption.revision.id))

  const sourcePath = join(directory, seeded.asset.filePath!)
  const adoptedRecord = runtime.database.getMediaAsset(adopted.body.adoption.asset.id)
  assert.ok(adoptedRecord?.filePath)
  assert.notEqual(adoptedRecord.filePath, seeded.asset.filePath)
  assert.deepEqual(await readFile(sourcePath), PNG)
  assert.deepEqual(await readFile(join(directory, adoptedRecord.filePath!)), PNG)

  const replay = await submit()
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.adoption.asset.id, adopted.body.adoption.asset.id)
  assert.equal(replay.body.adoption.job.id, adopted.body.adoption.job.id)
  assert.equal(replay.body.adoption.idempotent, true)
  assert.equal(runtime.database.listMediaAssets({ projectId: 'default', episodeId }).length, 2)
})

test('rejects adoption when current visual semantics changed', async () => {
  const { runtime, baseUrl } = await fixture()
  const episodeId = 'visual-history-semantic-change'
  const seeded = await seedHistoricalCharacterAsset(runtime, episodeId)
  const current = runtime.storyRepository.applyStory(
    episodeId,
    story(REORDERED_SHOTS, '白衣，银发。'),
  )
  const authority = runtime.storyRepository.getEpisode(episodeId)
  assert.ok(authority)
  const etag = episodeEtag(authority)

  const listed = await json<{ candidates: unknown[] }>(
    `${baseUrl}/api/v1/episodes/${episodeId}/visual-asset-history?projectId=default&entityType=character&entityId=ali`,
  )
  assert.equal(listed.response.status, 200)
  assert.deepEqual(listed.body.candidates, [])

  const beforeAssets = runtime.database.listMediaAssets({ projectId: 'default', episodeId }).length
  const response = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/assets/${seeded.asset.id}/adopt-current-visual-revision`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': etag,
        'idempotency-key': 'semantic-change-must-reject',
      },
      body: JSON.stringify({
        projectId: 'default',
        episodeId,
        entityType: 'character',
        entityId: 'ali',
      }),
    },
  )
  assert.equal(response.response.status, 409)
  assert.equal(response.body.error.code, 'VISUAL_ASSET_HISTORY_INCOMPATIBLE')
  assert.equal(runtime.database.listMediaAssets({ projectId: 'default', episodeId }).length, beforeAssets)
  assert.equal(runtime.database.findGenerationJobByIdempotencyKey('default', 'semantic-change-must-reject'), undefined)
  assert.equal(runtime.storyRepository.getEpisode(episodeId)?.sourceRevisionId, current.revision.id)
})

test('rejects stale If-Match and style drift before copying any Asset', async () => {
  const { runtime, baseUrl } = await fixture()
  const episodeId = 'visual-history-style-change'
  const seeded = await seedHistoricalCharacterAsset(runtime, episodeId)
  runtime.storyRepository.applyStory(episodeId, story(REORDERED_SHOTS))
  const beforeStyle = runtime.storyRepository.getEpisode(episodeId)
  assert.ok(beforeStyle)
  const staleEtag = episodeEtag(beforeStyle)
  runtime.storyRepository.updateRenderSettings(episodeId, { stylePreset: '3D 写实' })
  const current = runtime.storyRepository.getEpisode(episodeId)
  assert.ok(current)

  const stale = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/assets/${seeded.asset.id}/adopt-current-visual-revision`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': staleEtag,
        'idempotency-key': 'stale-style-adoption',
      },
      body: JSON.stringify({
        projectId: 'default',
        episodeId,
        entityType: 'character',
        entityId: 'ali',
      }),
    },
  )
  assert.equal(stale.response.status, 412)
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT')

  const currentStyle = await json<{ error: { code: string } }>(
    `${baseUrl}/api/v1/assets/${seeded.asset.id}/adopt-current-visual-revision`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': episodeEtag(current),
        'idempotency-key': 'current-style-adoption',
      },
      body: JSON.stringify({
        projectId: 'default',
        episodeId,
        entityType: 'character',
        entityId: 'ali',
      }),
    },
  )
  assert.equal(currentStyle.response.status, 409)
  assert.equal(currentStyle.body.error.code, 'VISUAL_ASSET_HISTORY_INCOMPATIBLE')
  assert.equal(runtime.database.listMediaAssets({ projectId: 'default', episodeId }).length, 1)
})
