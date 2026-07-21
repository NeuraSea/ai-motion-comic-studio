import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  createApplication,
  type ApplicationOptions,
  type ApplicationRuntime,
} from './app-v1.js'
import type { KeychainCredentialSlot } from './keychain.js'
import { createPipelineProductionRequest } from './pipeline-production.js'
import type { ProviderCredentialStore } from './providers/service.js'
import type { StoryDocument } from './story-schema.js'
import type {
  ImageGenerationInput,
  ImageProvider,
  JsonObject,
  ProviderImage,
} from './types.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

class FixtureProvider implements ImageProvider {
  readonly name = 'pipeline-http-fixture'
  readonly model = 'fixture-image'
  readonly configured = true
  readonly supportsImageReferences = true
  calls = 0

  async health() {
    return { status: 'ok' as const, message: 'fixture ready' }
  }

  async generate(input: ImageGenerationInput): Promise<ProviderImage[]> {
    this.calls += 1
    return Array.from({ length: input.count }, () => ({
      bytes: ONE_PIXEL_PNG,
      mimeType: 'image/png',
    }))
  }
}

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

interface Fixture {
  directory: string
  runtime: ApplicationRuntime
  server: Server
  baseUrl: string
  provider: FixtureProvider
  closed: boolean
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
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  return `http://127.0.0.1:${address.port}`
}

async function fixture(overrides: ApplicationOptions = {}): Promise<Fixture> {
  const directory = overrides.runtimeDirectory
    ?? await mkdtemp(join(tmpdir(), 'manju-pipeline-http-'))
  const provider = overrides.provider instanceof FixtureProvider
    ? overrides.provider
    : new FixtureProvider()
  const keychain = overrides.keychain ?? new MemoryCredentials()
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider,
    keychain,
    loadByoaCredential: async (providerId) => providerId.startsWith('codex-tools')
      ? 'fixture-byoa'
      : null,
    hasByoaCredential: async (providerId) => providerId.startsWith('codex-tools'),
    autoStartWorker: false,
    ...overrides,
  })
  const server = createServer(runtime.app)
  const value: Fixture = {
    directory,
    runtime,
    server,
    baseUrl: await listen(server),
    provider,
    closed: false,
  }
  fixtures.push(value)
  return value
}

async function closeFixture(value: Fixture, removeDirectory = true): Promise<void> {
  if (!value.closed) {
    value.closed = true
    await new Promise<void>((resolve, reject) => value.server.close((error) => error ? reject(error) : resolve()))
    await value.runtime.close()
  }
  if (removeDirectory) await rm(value.directory, { recursive: true, force: true })
}

afterEach(async () => {
  for (const value of fixtures.splice(0)) await closeFixture(value)
})

function story(title: string): StoryDocument {
  return {
    version: 1,
    title,
    targetDurationSeconds: 30,
    bible: {
      logline: '少女在断崖听见龙吟。',
      theme: '责任',
      tone: '紧张',
      visualStyle: '国风动画，16:9 电影构图',
    },
    characters: [{
      id: 'hero',
      name: '阿离',
      role: '主角',
      storyDescription: '年轻剑客',
      visualDescription: '黑色长发、红绳、青色圆领袍',
    }],
    locations: [{
      id: 'cliff',
      name: '断崖',
      storyDescription: '长安城外',
      visualDescription: '云海与落日',
    }],
    props: [],
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
        title: `云海之上 ${index + 1}`,
        description: '阿离正面面向镜头，在风中看向云海。',
        framing: '中景',
        movement: '缓慢推进',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '国风动画，阿离正面站在断崖黄昏云海前。',
        dialogueLines: index === 0 ? [{
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

async function bindCurrentCharacterVisualReferences(
  runtime: ApplicationRuntime,
  episodeId: string,
  sourceRevisionId: string,
): Promise<void> {
  const characters = runtime.database.withSql((sql) => sql.all(`
    SELECT id, name
      FROM characters
     WHERE project_id = 'default' AND episode_id = ?
     ORDER BY id
  `, episodeId))
  const audit = runtime.database.createRevision({
    projectId: 'default',
    summary: `Pipeline HTTP character views ${episodeId}`,
    snapshot: {
      version: 1,
      kind: 'character.visual-references.lock',
      episodeId,
      sourceRevisionId,
    },
  })
  for (const character of characters) {
    assert.equal(typeof character.id, 'string')
    for (const [index, role] of ['front', 'side', 'back'].entries()) {
      const asset = await runtime.mediaStore.save({
        projectId: 'default',
        episodeId,
        kind: `character-turnaround-${role}`,
        version: index + 1,
        bytes: ONE_PIXEL_PNG,
        mimeType: 'image/png',
        source: 'fixture-derived-turnaround',
        sourceRevisionId,
        width: 1,
        height: 1,
      })
      runtime.database.withSql((sql) => sql.run(`
        INSERT INTO character_visual_references (
          character_id, project_id, episode_id, role, asset_id, version,
          audit_revision_id, updated_at
        ) VALUES (?, 'default', ?, ?, ?, 1, ?, ?)
        ON CONFLICT(character_id, role) DO UPDATE SET
          asset_id = excluded.asset_id,
          version = character_visual_references.version + 1,
          audit_revision_id = excluded.audit_revision_id,
          updated_at = excluded.updated_at
      `, character.id as string, episodeId, role, asset.id, audit.id, asset.updatedAt))
    }
  }
}

async function persistStory(
  runtime: ApplicationRuntime,
  episodeId: string,
  value = story(episodeId),
): Promise<string> {
  runtime.storyRepository.ensureEpisode('default', { id: episodeId, title: value.title })
  const project = runtime.database.getProject('default')
  assert.ok(project)
  const revision = runtime.database.createRevision({
    projectId: 'default',
    parentRevisionId: project.currentRevisionId,
    summary: `Pipeline HTTP fixture ${episodeId}`,
    snapshot: structuredClone(value) as unknown as JsonObject,
  })
  runtime.storyRepository.applyStory(episodeId, value, revision.id)
  await bindCurrentCharacterVisualReferences(runtime, episodeId, revision.id)
  return revision.id
}

function addReadySpeech(runtime: ApplicationRuntime, episodeId: string, sourceRevisionId: string): string {
  const asset = runtime.database.createMediaAsset({
    projectId: 'default',
    episodeId,
    kind: 'speech',
    status: 'ready',
    filePath: join(runtime.generatedDirectory, `${episodeId}.mp3`),
    mimeType: 'audio/mpeg',
    durationSeconds: 1,
    checksum: 'a'.repeat(64),
    source: 'fixture',
    sourceRevisionId,
  })
  runtime.database.withSql((sql) => {
    const row = sql.get(`
      SELECT dialogue_lines.id
        FROM dialogue_lines
        JOIN shots ON shots.id = dialogue_lines.shot_id
        JOIN scenes ON scenes.id = shots.scene_id
       WHERE scenes.episode_id = ?
       LIMIT 1
    `, episodeId)
    const lineId = row?.id
    assert.equal(typeof lineId, 'string')
    sql.run('UPDATE dialogue_lines SET speech_asset_id = ? WHERE id = ?', asset.id, lineId as string)
  })
  return asset.id
}

function addReadyStoryboard(runtime: ApplicationRuntime, episodeId: string, sourceRevisionId: string): string {
  const asset = runtime.database.createMediaAsset({
    projectId: 'default',
    episodeId,
    kind: 'storyboard',
    status: 'ready',
    filePath: join(runtime.generatedDirectory, `${episodeId}.png`),
    mimeType: 'image/png',
    width: 1,
    height: 1,
    checksum: 'b'.repeat(64),
    source: 'fixture',
    sourceRevisionId,
  })
  runtime.database.withSql((sql) => {
    const row = sql.get(`
      SELECT shots.id
        FROM shots JOIN scenes ON scenes.id = shots.scene_id
       WHERE scenes.episode_id = ?
       LIMIT 1
    `, episodeId)
    const shotId = row?.id
    assert.equal(typeof shotId, 'string')
    sql.run('UPDATE shots SET storyboard_asset_id = ? WHERE id = ?', asset.id, shotId as string)
  })
  return asset.id
}

function addAllReadyStoryboards(
  runtime: ApplicationRuntime,
  episodeId: string,
  sourceRevisionId: string,
): void {
  runtime.database.withSql((sql) => {
    const rows = sql.all(`
      SELECT shots.id
        FROM shots JOIN scenes ON scenes.id = shots.scene_id
       WHERE scenes.episode_id = ?
       ORDER BY scenes.sequence, shots.sequence
    `, episodeId)
    rows.forEach((row, index) => {
      const shotId = row.id
      assert.equal(typeof shotId, 'string')
      const asset = runtime.database.createMediaAsset({
        projectId: 'default',
        episodeId,
        kind: 'storyboard',
        status: 'ready',
        filePath: join(runtime.generatedDirectory, `${episodeId}-${index}.png`),
        mimeType: 'image/png',
        width: 1,
        height: 1,
        checksum: String(index % 10).repeat(64),
        source: 'fixture',
        sourceRevisionId,
      })
      sql.run('UPDATE shots SET storyboard_asset_id = ? WHERE id = ?', asset.id, shotId as string)
    })
  })
}

const productionBody = {
  projectId: 'default',
  resolution: '720p',
  kenBurns: true,
  burnSubtitles: true,
  introTitle: true,
  outroCard: true,
  reviewWatermark: false,
  speechMode: 'skip',
} as const

async function json<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init)
  return { response, body: await response.json() as T }
}

function post(body: unknown, key?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  }
}

async function preflight(
  baseUrl: string,
  episodeId: string,
  body: unknown,
  rootIdempotencyKey: string,
): Promise<Record<string, unknown>> {
  const result = await json<{ preflight: Record<string, unknown> }>(
    `${baseUrl}/api/v1/episodes/${episodeId}/pipeline-runs/preflight`,
    post(body, rootIdempotencyKey),
  )
  assert.equal(result.response.status, 200, JSON.stringify(result.body))
  assert.equal(typeof result.body.preflight.confirmationToken, 'string')
  assert.equal(typeof result.body.preflight.expiresAt, 'string')
  const token = /^pfr1_([1-9][0-9]{9,12})_[a-f0-9]{64}$/.exec(
    String(result.body.preflight.confirmationToken),
  )
  assert.ok(token)
  assert.equal(
    Math.floor(Date.parse(String(result.body.preflight.expiresAt)) / 1_000),
    Number(token[1]),
  )
  return result.body.preflight
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for pipeline state')
}

test('Pipeline HTTP is strict, idempotent across discovery changes, cancellable, listable, and evented', async () => {
  const value = await fixture()
  const revisionId = await persistStory(value.runtime, 'pipeline-http-main')
  addReadySpeech(value.runtime, 'pipeline-http-main', revisionId)
  const endpoint = `${value.baseUrl}/api/v1/episodes/pipeline-http-main/pipeline-runs`

  const missingKey = await json<{ error: { code: string } }>(endpoint, post(productionBody))
  assert.equal(missingKey.response.status, 400)
  assert.equal(missingKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED')

  const confirmed = await preflight(
    value.baseUrl,
    'pipeline-http-main',
    productionBody,
    'pipeline-http-main-key',
  )
  assert.equal(confirmed.readyStoryboardCount, 0)
  assert.equal(confirmed.missingStoryboardCount, 6)
  assert.equal(confirmed.readySpeechCount, 1)
  assert.equal(confirmed.billableStoryboardCount, 6)
  assert.equal(confirmed.billableSpeechCount, 0)
  assert.equal((confirmed.imageProvider as Record<string, unknown>).providerId, 'codex-tools-image')

  const created = await json<{ pipelineRun: Record<string, unknown> }>(
    endpoint,
    post({ ...productionBody, confirmationToken: confirmed.confirmationToken }, 'pipeline-http-main-key'),
  )
  assert.equal(created.response.status, 202)
  assert.equal(created.body.pipelineRun.projectId, 'default')
  assert.equal(created.body.pipelineRun.episodeId, 'pipeline-http-main')
  assert.equal(created.body.pipelineRun.sourceRevisionId, revisionId)
  assert.equal(created.body.pipelineRun.mode, 'dynamic-comic')
  assert.equal('idempotencyKey' in created.body.pipelineRun, false)
  const runId = String(created.body.pipelineRun.id)
  await waitUntil(() => value.runtime.database.listGenerationJobs({ pipelineRunId: runId }).length === 6)

  // Discovery now sees no missing storyboard, but caller intent is unchanged.
  addReadyStoryboard(value.runtime, 'pipeline-http-main', revisionId)
  const replay = await json<{ pipelineRun: Record<string, unknown> }>(
    endpoint,
    post(productionBody, 'pipeline-http-main-key'),
  )
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.pipelineRun.id, runId)

  const conflict = await json<{ error: { code: string } }>(
    endpoint,
    post({ ...productionBody, resolution: '1080p' }, 'pipeline-http-main-key'),
  )
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT')

  const listed = await json<{ pipelineRuns: Array<Record<string, unknown>> }>(
    `${value.baseUrl}/api/v1/pipeline-runs?projectId=default&episodeId=pipeline-http-main&limit=10`,
  )
  assert.equal(listed.response.status, 200)
  assert.deepEqual(listed.body.pipelineRuns.map((run) => run.id), [runId])

  const cancelled = await json<{ pipelineRun: Record<string, unknown> }>(
    `${value.baseUrl}/api/v1/pipeline-runs/${runId}/cancel`,
    post({}),
  )
  assert.equal(cancelled.response.status, 200)
  assert.equal(cancelled.body.pipelineRun.status, 'cancelled')
  assert.equal((cancelled.body.pipelineRun.error as Record<string, unknown>).code, 'PIPELINE_CANCELLED')
  assert.equal(value.runtime.database.listGenerationJobs({ pipelineRunId: runId })[0]?.status, 'cancelled')

  const read = await json<{ pipelineRun: Record<string, unknown> }>(
    `${value.baseUrl}/api/v1/pipeline-runs/${runId}`,
  )
  assert.equal(read.response.status, 200)
  assert.equal(read.body.pipelineRun.status, 'cancelled')
  const events = value.runtime.eventHub.since(undefined, { projectId: 'default' })
  assert.ok(events.some((event) => event.type === 'pipeline.updated'))
  assert.ok(events.some((event) => event.type === 'job.updated'))

  const legacy = value.runtime.database.createPipelineRun({
    id: 'legacy-pipeline-row',
    projectId: 'default',
    episodeId: 'pipeline-http-main',
    sourceRevisionId: null,
    status: 'failed',
    steps: { legacy: true },
    error: { code: 'LEGACY', message: 'legacy placeholder' },
    completedAt: new Date().toISOString(),
  })
  const legacyRead = await json<{ error: { code: string } }>(
    `${value.baseUrl}/api/v1/pipeline-runs/${legacy.id}`,
  )
  assert.equal(legacyRead.response.status, 410)
  assert.equal(legacyRead.body.error.code, 'PIPELINE_RUN_LEGACY_UNREADABLE')
  const listWithLegacy = await json<{ pipelineRuns: Array<Record<string, unknown>> }>(
    `${value.baseUrl}/api/v1/pipeline-runs?projectId=default&episodeId=pipeline-http-main`,
  )
  assert.deepEqual(listWithLegacy.body.pipelineRuns.map((run) => run.id), [runId])
})

test('Pipeline HTTP rejects fake-audio and incomplete automatic speech preconditions', async () => {
  const value = await fixture()
  await persistStory(value.runtime, 'pipeline-http-audio')
  const endpoint = `${value.baseUrl}/api/v1/episodes/pipeline-http-audio/pipeline-runs`

  const noAudio = await json<{ error: { code: string } }>(
    endpoint,
    post(productionBody, 'pipeline-no-audio'),
  )
  assert.equal(noAudio.response.status, 422)
  assert.equal(noAudio.body.error.code, 'AUDIO_REQUIRED')
  assert.equal(value.runtime.database.listPipelineRuns({ projectId: 'default' }).length, 0)

  await value.runtime.providerService.save('minimax-speech', {
    apiKey: 'fixture-minimax-key',
    enabled: true,
  })
  const missingVoice = await json<{ error: { code: string } }>(
    endpoint,
    post({ ...productionBody, speechMode: 'auto' }, 'pipeline-missing-voice'),
  )
  assert.equal(missingVoice.response.status, 409)
  assert.equal(missingVoice.body.error.code, 'CHARACTER_VOICE_BLOCKED')
  assert.equal(value.runtime.database.listPipelineRuns({ projectId: 'default' }).length, 0)
})

test('Pipeline paid preflight is strict and rejects missing or stale confirmations', async () => {
  const value = await fixture()
  const revisionId = await persistStory(value.runtime, 'pipeline-http-preflight')
  addReadySpeech(value.runtime, 'pipeline-http-preflight', revisionId)
  const preflightEndpoint = `${value.baseUrl}/api/v1/episodes/pipeline-http-preflight/pipeline-runs/preflight`
  const createEndpoint = `${value.baseUrl}/api/v1/episodes/pipeline-http-preflight/pipeline-runs`

  const missingPreflightKey = await json<{ error: { code: string } }>(
    preflightEndpoint,
    post(productionBody),
  )
  assert.equal(missingPreflightKey.response.status, 400)
  assert.equal(missingPreflightKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED')

  const smuggled = await json<{ error: { code: string } }>(
    preflightEndpoint,
    post({ ...productionBody, confirmationToken: 'pfr1_deadbeef' }, 'pipeline-preflight-smuggled'),
  )
  assert.equal(smuggled.response.status, 400)
  assert.equal(smuggled.body.error.code, 'INVALID_PIPELINE_PREFLIGHT_REQUEST')

  const missing = await json<{ error: { code: string } }>(
    createEndpoint,
    post(productionBody, 'pipeline-preflight-missing'),
  )
  assert.equal(missing.response.status, 428)
  assert.equal(missing.body.error.code, 'PIPELINE_PREFLIGHT_REQUIRED')

  const boundKey = 'pipeline-preflight-bound-key'
  const bound = await preflight(
    value.baseUrl,
    'pipeline-http-preflight',
    productionBody,
    boundKey,
  )
  const remainingTtlMs = Date.parse(String(bound.expiresAt)) - Date.now()
  assert.ok(remainingTtlMs >= 2 * 60 * 1_000 - 1_000)
  assert.ok(remainingTtlMs <= 5 * 60 * 1_000)

  const wrongKey = await json<{ error: { code: string } }>(
    createEndpoint,
    post(
      { ...productionBody, confirmationToken: bound.confirmationToken },
      'pipeline-preflight-other-key',
    ),
  )
  assert.equal(wrongKey.response.status, 409)
  assert.equal(wrongKey.body.error.code, 'PIPELINE_PREFLIGHT_CHANGED')

  const requestDrift = await json<{ error: { code: string } }>(
    createEndpoint,
    post(
      { ...productionBody, resolution: '1080p', confirmationToken: bound.confirmationToken },
      boundKey,
    ),
  )
  assert.equal(requestDrift.response.status, 409)
  assert.equal(requestDrift.body.error.code, 'PIPELINE_PREFLIGHT_CHANGED')

  const token = String(bound.confirmationToken)
  const tamperedToken = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`
  const tampered = await json<{ error: { code: string } }>(
    createEndpoint,
    post({ ...productionBody, confirmationToken: tamperedToken }, boundKey),
  )
  assert.equal(tampered.response.status, 409)
  assert.equal(tampered.body.error.code, 'PIPELINE_PREFLIGHT_CHANGED')
  assert.equal(value.runtime.database.listPipelineRuns({ projectId: 'default' }).length, 0)
  assert.equal(value.runtime.database.listGenerationJobs({ projectId: 'default' }).length, 0)

  const confirmed = await preflight(
    value.baseUrl,
    'pipeline-http-preflight',
    productionBody,
    'pipeline-preflight-stale',
  )
  addReadyStoryboard(value.runtime, 'pipeline-http-preflight', revisionId)
  const stale = await json<{ error: { code: string } }>(
    createEndpoint,
    post({ ...productionBody, confirmationToken: confirmed.confirmationToken }, 'pipeline-preflight-stale'),
  )
  assert.equal(stale.response.status, 409)
  assert.equal(stale.body.error.code, 'PIPELINE_PREFLIGHT_CHANGED')

  const providerConfirmed = await preflight(
    value.baseUrl,
    'pipeline-http-preflight',
    productionBody,
    'pipeline-provider-drift',
  )
  await value.runtime.providerService.save('codex-tools-image', {
    model: 'fixture-image-v2',
    enabled: true,
  })
  const providerDrift = await json<{ error: { code: string } }>(
    createEndpoint,
    post({ ...productionBody, confirmationToken: providerConfirmed.confirmationToken }, 'pipeline-provider-drift'),
  )
  assert.equal(providerDrift.response.status, 409)
  assert.equal(providerDrift.body.error.code, 'PIPELINE_PREFLIGHT_CHANGED')
  assert.equal(value.runtime.database.listPipelineRuns({ projectId: 'default' }).length, 0)
  assert.equal(value.runtime.database.listGenerationJobs({ projectId: 'default' }).length, 0)
})

test('expired Pipeline preflight creates no durable run or child job', async () => {
  let nowMs = Date.parse('2030-01-01T00:00:00.000Z')
  const value = await fixture({ pipelinePreflightNow: () => new Date(nowMs) })
  const revisionId = await persistStory(value.runtime, 'pipeline-http-expired')
  addReadySpeech(value.runtime, 'pipeline-http-expired', revisionId)
  const rootKey = 'pipeline-expired-key'
  const confirmed = await preflight(
    value.baseUrl,
    'pipeline-http-expired',
    productionBody,
    rootKey,
  )
  assert.equal(confirmed.expiresAt, '2030-01-01T00:03:00.000Z')
  nowMs += 3 * 60 * 1_000

  const expired = await json<{ error: { code: string } }>(
    `${value.baseUrl}/api/v1/episodes/pipeline-http-expired/pipeline-runs`,
    post({ ...productionBody, confirmationToken: confirmed.confirmationToken }, rootKey),
  )
  assert.equal(expired.response.status, 409)
  assert.equal(expired.body.error.code, 'PIPELINE_PREFLIGHT_EXPIRED')
  assert.equal(value.runtime.database.listPipelineRuns({ projectId: 'default' }).length, 0)
  assert.equal(value.runtime.database.listGenerationJobs({ projectId: 'default' }).length, 0)
})

test('root-key-bound preflights preserve exact replay and prevent duplicate active or terminal reuse', async () => {
  const value = await fixture()
  const revisionId = await persistStory(value.runtime, 'pipeline-http-active-dedupe')
  addReadySpeech(value.runtime, 'pipeline-http-active-dedupe', revisionId)
  const rootKey = 'pipeline-tab-a'
  const confirmed = await preflight(
    value.baseUrl,
    'pipeline-http-active-dedupe',
    productionBody,
    rootKey,
  )
  const endpoint = `${value.baseUrl}/api/v1/episodes/pipeline-http-active-dedupe/pipeline-runs`
  const body = { ...productionBody, confirmationToken: confirmed.confirmationToken }

  const concurrent = await Promise.all([
    json<{ pipelineRun?: Record<string, unknown>; error?: { code: string; details?: Record<string, unknown> } }>(
      endpoint,
      post(body, rootKey),
    ),
    json<{ pipelineRun?: Record<string, unknown>; error?: { code: string; details?: Record<string, unknown> } }>(
      endpoint,
      post(body, rootKey),
    ),
  ])
  const winner = concurrent.find((result) => result.response.status === 202)
  const replay = concurrent.find((result) => result.response.status === 200)
  assert.ok(winner?.body.pipelineRun)
  assert.ok(replay?.body.pipelineRun)
  const winnerId = String(winner.body.pipelineRun.id)
  assert.equal(replay.body.pipelineRun.id, winnerId)
  assert.equal(
    value.runtime.database.listPipelineRuns({ projectId: 'default', episodeId: 'pipeline-http-active-dedupe' }).length,
    1,
  )
  await waitUntil(() => value.runtime.database.listGenerationJobs({ pipelineRunId: winnerId }).length === 6)

  const otherKey = 'pipeline-tab-b'
  const otherConfirmation = await preflight(
    value.baseUrl,
    'pipeline-http-active-dedupe',
    productionBody,
    otherKey,
  )
  const runsBeforeBlocked = value.runtime.database.listPipelineRuns({ projectId: 'default' }).length
  const jobsBeforeBlocked = value.runtime.database.listGenerationJobs({ projectId: 'default' }).length
  const sequentialBlocked = await json<{ error: { code: string; details?: Record<string, unknown> } }>(
    endpoint,
    post({ ...productionBody, confirmationToken: otherConfirmation.confirmationToken }, otherKey),
  )
  assert.equal(sequentialBlocked.response.status, 409)
  assert.equal(sequentialBlocked.body.error.code, 'PIPELINE_RUN_ALREADY_ACTIVE')
  assert.equal(sequentialBlocked.body.error.details?.pipelineRunId, winnerId)
  assert.equal(value.runtime.database.listPipelineRuns({ projectId: 'default' }).length, runsBeforeBlocked)
  assert.equal(value.runtime.database.listGenerationJobs({ projectId: 'default' }).length, jobsBeforeBlocked)

  const cancelled = await json<{ pipelineRun: Record<string, unknown> }>(
    `${value.baseUrl}/api/v1/pipeline-runs/${winnerId}/cancel`,
    post({}),
  )
  assert.equal(cancelled.body.pipelineRun.status, 'cancelled')

  const runsBeforeReuse = value.runtime.database.listPipelineRuns({ projectId: 'default' }).length
  const jobsBeforeReuse = value.runtime.database.listGenerationJobs({ projectId: 'default' }).length
  const afterTerminalKey = 'pipeline-tab-after-terminal'
  const rejectedReuse = await json<{ error: { code: string } }>(
    endpoint,
    post(body, afterTerminalKey),
  )
  assert.equal(rejectedReuse.response.status, 409)
  assert.equal(rejectedReuse.body.error.code, 'PIPELINE_PREFLIGHT_CHANGED')
  assert.equal(value.runtime.database.listPipelineRuns({ projectId: 'default' }).length, runsBeforeReuse)
  assert.equal(value.runtime.database.listGenerationJobs({ projectId: 'default' }).length, jobsBeforeReuse)

  const afterTerminalConfirmation = await preflight(
    value.baseUrl,
    'pipeline-http-active-dedupe',
    productionBody,
    afterTerminalKey,
  )
  const afterTerminal = await json<{ pipelineRun: Record<string, unknown> }>(
    endpoint,
    post(
      { ...productionBody, confirmationToken: afterTerminalConfirmation.confirmationToken },
      afterTerminalKey,
    ),
  )
  assert.equal(afterTerminal.response.status, 202)
  assert.notEqual(afterTerminal.body.pipelineRun.id, winnerId)
})

test('Pipeline HTTP returns 429 without leaving a parent when durable capacity is exhausted', async () => {
  const value = await fixture({ maxQueueDepth: 1 })
  const revisionId = await persistStory(value.runtime, 'pipeline-http-capacity')
  addReadySpeech(value.runtime, 'pipeline-http-capacity', revisionId)
  const confirmed = await preflight(
    value.baseUrl,
    'pipeline-http-capacity',
    productionBody,
    'pipeline-at-capacity',
  )
  await value.runtime.worker.submit({
    type: 'capacity.fixture',
    input: {},
    idempotencyKey: 'capacity-fixture-job',
    projectId: 'default',
  })

  const result = await json<{ error: { code: string } }>(
    `${value.baseUrl}/api/v1/episodes/pipeline-http-capacity/pipeline-runs`,
    post({ ...productionBody, confirmationToken: confirmed.confirmationToken }, 'pipeline-at-capacity'),
  )
  assert.equal(result.response.status, 429)
  assert.equal(result.body.error.code, 'QUEUE_FULL')
  assert.equal(value.runtime.database.listPipelineRuns({ projectId: 'default' }).length, 0)
})

test('an unrelated terminal worker event wakes a recoverable capacity-blocked PipelineRun', async () => {
  const value = await fixture({ maxQueueDepth: 1 })
  const revisionId = await persistStory(value.runtime, 'pipeline-http-liveness')
  addReadySpeech(value.runtime, 'pipeline-http-liveness', revisionId)
  await value.runtime.worker.submit({
    type: 'unrelated.capacity.fixture',
    input: {},
    idempotencyKey: 'unrelated-capacity-fixture',
    projectId: 'default',
  })
  const request = createPipelineProductionRequest(
    { database: value.runtime.database, timelines: value.runtime.timelineDocumentService },
    {
      projectId: 'default',
      episodeId: 'pipeline-http-liveness',
      idempotencyKey: 'pipeline-liveness-parent',
      options: { ...productionBody, speechMode: 'skip' },
      imageProvider: { providerId: 'codex-tools-image' },
    },
  )
  const run = value.runtime.pipelineRunCoordinator.create(request).run
  await assert.rejects(value.runtime.pipelineRunCoordinator.kick(run.id))
  assert.equal(value.runtime.database.listGenerationJobs({ pipelineRunId: run.id }).length, 0)

  await value.runtime.worker.start()
  await waitUntil(() => value.provider.calls > 0)
  assert.ok(value.runtime.database.listGenerationJobs({ pipelineRunId: run.id }).length > 0)
})

test('only external timeline writes stale an active PipelineRun', async () => {
  const value = await fixture()
  const revisionId = await persistStory(value.runtime, 'pipeline-http-timeline')
  addReadySpeech(value.runtime, 'pipeline-http-timeline', revisionId)
  addAllReadyStoryboards(value.runtime, 'pipeline-http-timeline', revisionId)
  const confirmed = await preflight(
    value.baseUrl,
    'pipeline-http-timeline',
    productionBody,
    'pipeline-timeline-key',
  )
  const created = await json<{ pipelineRun: Record<string, unknown> }>(
    `${value.baseUrl}/api/v1/episodes/pipeline-http-timeline/pipeline-runs`,
    post({ ...productionBody, confirmationToken: confirmed.confirmationToken }, 'pipeline-timeline-key'),
  )
  assert.equal(created.response.status, 202)
  const runId = String(created.body.pipelineRun.id)
  await waitUntil(() => value.runtime.database.listGenerationJobs({ pipelineRunId: runId }).length === 1)
  assert.equal(value.runtime.database.getPipelineRun(runId)?.status, 'running')

  // The coordinator's direct materialization did not call the external-write
  // invalidation hook. A user/API reconcile of the same timeline must do so.
  const timeline = await fetch(
    `${value.baseUrl}/api/v1/episodes/pipeline-http-timeline/timeline-document`,
  )
  assert.equal(timeline.status, 200)
  const etag = timeline.headers.get('etag')
  assert.ok(etag)
  await timeline.body?.cancel()
  const reconciled = await json<Record<string, unknown>>(
    `${value.baseUrl}/api/v1/episodes/pipeline-http-timeline/timeline-document/reconcile`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': etag,
      },
      body: JSON.stringify({ projectId: 'default', summary: 'external edit' }),
    },
  )
  assert.equal(reconciled.response.status, 200)
  assert.equal(value.runtime.database.getPipelineRun(runId)?.status, 'stale')
  assert.deepEqual(
    [...new Set(value.runtime.database.listGenerationJobs({ pipelineRunId: runId }).map((job) => job.status))],
    ['cancelled'],
  )
})

test('startup recovery stales changed-source runs before worker/provider execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-pipeline-recovery-'))
  const first = await fixture({ runtimeDirectory: directory })
  const firstRevisionId = await persistStory(first.runtime, 'pipeline-http-recovery')
  addReadySpeech(first.runtime, 'pipeline-http-recovery', firstRevisionId)
  const confirmed = await preflight(
    first.baseUrl,
    'pipeline-http-recovery',
    productionBody,
    'pipeline-recovery-key',
  )
  const created = await json<{ pipelineRun: Record<string, unknown> }>(
    `${first.baseUrl}/api/v1/episodes/pipeline-http-recovery/pipeline-runs`,
    post({ ...productionBody, confirmationToken: confirmed.confirmationToken }, 'pipeline-recovery-key'),
  )
  assert.equal(created.response.status, 202)
  const runId = String(created.body.pipelineRun.id)
  await waitUntil(() => first.runtime.database.listGenerationJobs({ pipelineRunId: runId }).length === 6)
  await first.runtime.pipelineRunCoordinator.kick(runId)

  // Re-applying the Story on a new immutable revision makes the queued child
  // stale. It must be cancelled before JobWorker.start() performs its scan.
  await persistStory(first.runtime, 'pipeline-http-recovery', story('replacement revision'))
  assert.equal(first.runtime.database.getPipelineRun(runId)?.status, 'stale')
  await closeFixture(first, false)

  const provider = new FixtureProvider()
  const second = await fixture({
    runtimeDirectory: directory,
    provider,
    autoStartWorker: true,
  })
  assert.equal(second.runtime.database.getPipelineRun(runId)?.status, 'stale')
  const recoveredJobs = second.runtime.database.listGenerationJobs({ pipelineRunId: runId })
  assert.deepEqual(
    [...new Set(recoveredJobs.map((job) => job.status))],
    ['cancelled'],
    JSON.stringify(recoveredJobs.map((job) => ({ id: job.id, status: job.status, error: job.error }))),
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(provider.calls, 0)
})
