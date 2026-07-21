import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import express from 'express'

import {
  AssetRetentionCrashSimulation,
  AssetRetentionError,
  AssetRetentionService,
} from './asset-retention.js'
import { createApplication, type ApplicationRuntime } from './app.js'
import { initializeDatabase } from './database.js'
import type { KeychainCredentialSlot } from './keychain.js'
import type { ProviderCredentialStore } from './providers/service.js'
import {
  createSafeRequestLogger,
  type SafeRequestLogEntry,
} from './request-logging.js'
import type { ImageGenerationInput, ImageProvider, ProviderImage } from './types.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const servers: Server[] = []
const runtimes: ApplicationRuntime[] = []
const directories: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
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

class EmptyCredentialStore implements ProviderCredentialStore {
  async get(_slot: KeychainCredentialSlot): Promise<string | null> { return null }
  async set(_slot: KeychainCredentialSlot, _secret: string): Promise<void> {}
  async delete(_slot: KeychainCredentialSlot): Promise<boolean> { return false }
  async exists(_slot: KeychainCredentialSlot): Promise<boolean> { return false }
}

class FixtureImageProvider implements ImageProvider {
  readonly name = 'operations-fixture'
  readonly model = 'fixture-image'
  readonly configured = true

  async health() {
    return { status: 'ok' as const, message: 'fixture ready' }
  }

  async generate(input: ImageGenerationInput): Promise<ProviderImage[]> {
    return Array.from({ length: input.count }, () => ({
      bytes: ONE_PIXEL_PNG,
      mimeType: 'image/png',
    }))
  }
}

test('structured request logs contain only allow-listed identities and never request secrets', async () => {
  const logs: SafeRequestLogEntry[] = []
  const app = express()
  app.use(createSafeRequestLogger((entry) => logs.push(entry)))
  app.use(express.json())
  app.post('/api/v1/projects/:projectId/run', (_request, response) => {
    response.status(202).json({
      job: {
        id: 'job-safe-1',
        projectId: 'project-safe-1',
        externalTaskId: 'provider-task-safe-1',
      },
      sourceText: 'response-secret-must-not-be-logged',
      apiKey: 'response-key-must-not-be-logged',
    })
  })
  const baseUrl = await listen(createServer(app))
  const response = await fetch(
    `${baseUrl}/api/v1/projects/project-safe-1/run?apiKey=query-secret-must-not-be-logged`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'attacker-controlled-secret-id',
      },
      body: JSON.stringify({ sourceText: 'body-secret-must-not-be-logged' }),
    },
  )
  assert.equal(response.status, 202)
  assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/)
  await response.body?.cancel()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(logs.length, 1)
  assert.deepEqual(
    {
      event: logs[0].event,
      method: logs[0].method,
      route: logs[0].route,
      statusCode: logs[0].statusCode,
      outcome: logs[0].outcome,
      projectId: logs[0].projectId,
      jobId: logs[0].jobId,
      providerTaskId: logs[0].providerTaskId,
    },
    {
      event: 'http.request',
      method: 'POST',
      route: '/api/v1/projects/:projectId/run',
      statusCode: 202,
      outcome: 'finished',
      projectId: 'project-safe-1',
      jobId: 'job-safe-1',
      providerTaskId: 'provider-task-safe-1',
    },
  )
  assert.ok(logs[0].durationMs >= 0)
  const serialized = JSON.stringify(logs[0])
  for (const forbidden of [
    'attacker-controlled-secret-id',
    'query-secret-must-not-be-logged',
    'body-secret-must-not-be-logged',
    'response-secret-must-not-be-logged',
    'response-key-must-not-be-logged',
    'apiKey',
    'sourceText',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `log leaked ${forbidden}`)
  }
})

test('readiness validates media safety while optional unconfigured providers remain capability-scoped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-operations-ready-'))
  directories.push(directory)
  const logs: SafeRequestLogEntry[] = []
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider: new FixtureImageProvider(),
    keychain: new EmptyCredentialStore(),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    requestLogSink: (entry) => logs.push(entry),
  })
  runtimes.push(runtime)
  const baseUrl = await listen(createServer(runtime.app))

  const readyResponse = await fetch(`${baseUrl}/health/ready`)
  const ready = await readyResponse.json() as {
    status: string
    media: { status: string; safe: boolean; writable: boolean }
    providerCapabilities: {
      requiredForApi: boolean
      status: string
      providers: Array<{ providerId: string; state: string; ready: boolean }>
    }
  }
  assert.equal(readyResponse.status, 200)
  assert.equal(ready.status, 'ok')
  assert.deepEqual(ready.media, {
    status: 'ok',
    safe: true,
    writable: true,
    message: '媒体目录安全且可写',
  })
  assert.equal(ready.providerCapabilities.requiredForApi, false)
  assert.equal(ready.providerCapabilities.status, 'unconfigured')
  assert.ok(ready.providerCapabilities.providers.some((provider) => (
    provider.providerId === 'seedance-video'
      && ['disabled', 'unconfigured'].includes(provider.state)
      && provider.ready === false
  )))

  const outside = join(directory, 'outside-media')
  await mkdir(outside)
  await rm(runtime.mediaStore.mediaDirectory, { recursive: true, force: true })
  await symlink(outside, runtime.mediaStore.mediaDirectory, 'dir')
  const unsafeResponse = await fetch(`${baseUrl}/health/ready`)
  const unsafe = await unsafeResponse.json() as {
    status: string
    media: { status: string; safe: boolean; writable: boolean; message: string }
  }
  assert.equal(unsafeResponse.status, 503)
  assert.equal(unsafe.status, 'unavailable')
  assert.deepEqual(unsafe.media, {
    status: 'unavailable',
    safe: false,
    writable: false,
    message: '媒体目录未通过安全检查',
  })
  assert.ok(logs.every((entry) => entry.requestId && entry.durationMs >= 0))
})

function createAsset(
  database: ReturnType<typeof initializeDatabase>,
  input: {
    id: string
    source?: string
    kind?: string
    updatedAt?: string
    parentAssetId?: string
  },
): void {
  database.createMediaAsset({
    id: input.id,
    projectId: 'project-1',
    kind: input.kind ?? 'storyboard',
    status: 'ready',
    filePath: `media/project-1/${input.id}.png`,
    mimeType: 'image/png',
    source: input.source ?? 'provider',
    parentAssetId: input.parentAssetId,
    createdAt: input.updatedAt ?? '2026-06-01T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-06-01T00:00:00.000Z',
  })
}

async function createAssetFile(runtimeDirectory: string, id: string): Promise<string> {
  const directory = join(runtimeDirectory, 'media', 'project-1')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${id}.png`)
  await writeFile(path, ONE_PIXEL_PNG)
  return path
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

test('seven-day retention planner is exact, conservative, and non-destructive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-retention-plan-'))
  directories.push(directory)
  const database = initializeDatabase({ runtimeDirectory: directory })
  try {
    database.createProject({ id: 'project-1', title: 'Retention fixture' })
    createAsset(database, { id: 'deletable-old' })
    createAsset(database, { id: 'settings-protected' })
    createAsset(database, { id: 'revision-protected' })
    createAsset(database, { id: 'job-output-protected' })
    createAsset(database, { id: 'parent-protected' })
    createAsset(database, {
      id: 'fresh-child',
      parentAssetId: 'parent-protected',
      updatedAt: '2026-07-13T00:00:00.000Z',
    })
    createAsset(database, { id: 'fresh-provider', updatedAt: '2026-07-13T00:00:00.000Z' })
    createAsset(database, { id: 'user-upload', source: 'upload' })
    createAsset(database, { id: 'legacy-import', source: 'legacy-import' })
    createAsset(database, { id: 'rendered-output', source: 'renderer', kind: 'export.video' })
    createAsset(database, { id: 'provider-export', source: 'provider', kind: 'export.video' })
    database.updateProject('project-1', {
      settings: {
        selectedAssetId: 'settings-protected',
        unrelatedText: 'deletable-old-suffix-is-not-an-exact-reference',
      },
    })
    database.createRevision({
      id: 'revision-1',
      projectId: 'project-1',
      summary: 'pins a historical asset',
      snapshot: { selectedAssetId: 'revision-protected' },
    })
    database.createGenerationJob({
      id: 'job-1',
      projectId: 'project-1',
      type: 'fixture.generate',
      status: 'succeeded',
      input: {},
      output: { assetId: 'job-output-protected' },
    })

    const service = new AssetRetentionService(database, {
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    })
    const plan = service.plan()
    assert.equal(plan.dryRun, true)
    assert.equal(plan.applyEnabled, false)
    assert.equal(plan.retentionDays, 7)
    assert.equal(plan.cutoff, '2026-07-07T00:00:00.000Z')
    assert.deepEqual(plan.deletable.map((candidate) => candidate.assetId), ['deletable-old'])
    assert.deepEqual(
      new Set(plan.protected.map((candidate) => candidate.assetId)),
      new Set([
        'job-output-protected',
        'parent-protected',
        'revision-protected',
        'settings-protected',
      ]),
    )
    assert.deepEqual(
      plan.protected.find((candidate) => candidate.assetId === 'parent-protected')?.references,
      ['media_assets.parent_asset_id'],
    )
    assert.deepEqual(
      plan.protected.find((candidate) => candidate.assetId === 'settings-protected')?.references,
      ['projects.settings_json'],
    )
    assert.deepEqual(
      plan.protected.find((candidate) => candidate.assetId === 'revision-protected')?.references,
      ['revisions.snapshot_json'],
    )
    assert.deepEqual(
      plan.protected.find((candidate) => candidate.assetId === 'job-output-protected')?.references,
      ['generation_jobs.output_json'],
    )
    for (const excluded of [
      'fresh-child',
      'fresh-provider',
      'user-upload',
      'legacy-import',
      'rendered-output',
      'provider-export',
    ]) {
      assert.equal(
        [...plan.deletable, ...plan.protected].some((candidate) => candidate.assetId === excluded),
        false,
        `${excluded} must be outside deletion candidates`,
      )
    }
    for (const id of [
      'deletable-old',
      'job-output-protected',
      'parent-protected',
      'revision-protected',
      'settings-protected',
    ]) {
      assert.ok(database.getMediaAsset(id), `dry-run must retain ${id}`)
    }
  } finally {
    database.close()
  }
})

test('retention HTTP endpoint defaults to dry-run and requires the exact plan confirmation pair', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-retention-http-'))
  directories.push(directory)
  const runtime = await createApplication({
    runtimeDirectory: directory,
    provider: new FixtureImageProvider(),
    keychain: new EmptyCredentialStore(),
    loadByoaCredential: async () => null,
    hasByoaCredential: async () => false,
    requestLogSink: false,
  })
  runtimes.push(runtime)
  const baseUrl = await listen(createServer(runtime.app))
  runtime.database.createProject({ id: 'project-1', title: 'Retention HTTP fixture' })
  createAsset(runtime.database, { id: 'http-deletable' })
  const filePath = await createAssetFile(directory, 'http-deletable')
  const dryRun = await fetch(`${baseUrl}/api/v1/maintenance/assets/retention`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(dryRun.status, 200)
  const dryRunBody = await dryRun.json() as {
    plan: {
      dryRun: boolean
      applyEnabled: boolean
      planFingerprint: string
      confirmationToken: string
    }
  }
  assert.equal(dryRunBody.plan.dryRun, true)
  assert.equal(dryRunBody.plan.applyEnabled, true)
  assert.match(dryRunBody.plan.planFingerprint, /^[a-f0-9]{64}$/)
  assert.match(dryRunBody.plan.confirmationToken, /^[a-f0-9]{64}$/)

  const missingConfirmation = await fetch(`${baseUrl}/api/v1/maintenance/assets/retention`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dryRun: false }),
  })
  assert.equal(missingConfirmation.status, 400)
  assert.ok(runtime.database.getMediaAsset('http-deletable'))

  const wrongConfirmation = await fetch(`${baseUrl}/api/v1/maintenance/assets/retention`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dryRun: false,
      planFingerprint: dryRunBody.plan.planFingerprint,
      confirmationToken: '0'.repeat(64),
    }),
  })
  assert.equal(wrongConfirmation.status, 403)
  assert.ok(runtime.database.getMediaAsset('http-deletable'))

  const apply = await fetch(`${baseUrl}/api/v1/maintenance/assets/retention`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dryRun: false,
      planFingerprint: dryRunBody.plan.planFingerprint,
      confirmationToken: dryRunBody.plan.confirmationToken,
    }),
  })
  assert.equal(apply.status, 200)
  const applyBody = await apply.json() as {
    result: { dryRun: boolean; idempotent: boolean; deletedAssetIds: string[] }
  }
  assert.equal(applyBody.result.dryRun, false)
  assert.equal(applyBody.result.idempotent, false)
  assert.deepEqual(applyBody.result.deletedAssetIds, ['http-deletable'])
  assert.equal(runtime.database.getMediaAsset('http-deletable'), undefined)
  assert.equal(await pathExists(filePath), false)

  const replay = await fetch(`${baseUrl}/api/v1/maintenance/assets/retention`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dryRun: false,
      planFingerprint: dryRunBody.plan.planFingerprint,
      confirmationToken: dryRunBody.plan.confirmationToken,
    }),
  })
  assert.equal(replay.status, 200)
  const replayBody = await replay.json() as { result: { idempotent: boolean } }
  assert.equal(replayBody.result.idempotent, true)
})

test('retention apply deletes only unreferenced old intermediates and preserves every excluded class', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-retention-exclusions-'))
  directories.push(directory)
  const database = initializeDatabase({ runtimeDirectory: directory })
  try {
    database.createProject({ id: 'project-1', title: 'Retention exclusion fixture' })
    const retained = [
      { id: 'upload-old', source: 'upload' },
      { id: 'legacy-old', source: 'legacy-import' },
      { id: 'renderer-old', source: 'renderer', kind: 'storyboard' },
      { id: 'export-old', source: 'provider', kind: 'export.video' },
      { id: 'suffix-export-old', source: 'provider', kind: 'episode.export' },
      { id: 'suffix-render-old', source: 'provider', kind: 'custom.render' },
      { id: 'fresh-provider', source: 'provider', updatedAt: '2026-07-13T00:00:00.000Z' },
      { id: 'referenced-old', source: 'provider' },
    ]
    createAsset(database, { id: 'delete-old' })
    await createAssetFile(directory, 'delete-old')
    for (const input of retained) {
      createAsset(database, input)
      await createAssetFile(directory, input.id)
    }
    database.updateProject('project-1', { settings: { selectedAssetId: 'referenced-old' } })
    const service = new AssetRetentionService(database, {
      runtimeDirectory: directory,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    })
    const plan = service.plan()
    assert.deepEqual(plan.deletable.map((candidate) => candidate.assetId), ['delete-old'])
    const result = await service.apply({
      planFingerprint: plan.planFingerprint,
      confirmationToken: plan.confirmationToken,
    })
    assert.deepEqual(result.deletedAssetIds, ['delete-old'])
    assert.equal(database.getMediaAsset('delete-old'), undefined)
    for (const input of retained) {
      assert.ok(database.getMediaAsset(input.id), `${input.id} row must survive apply`)
      assert.equal(
        await pathExists(join(directory, 'media', 'project-1', `${input.id}.png`)),
        true,
        `${input.id} file must survive apply`,
      )
    }
  } finally {
    database.close()
  }
})

test('retention apply restores the whole quarantine when a reference appears after planning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-retention-drift-'))
  directories.push(directory)
  const database = initializeDatabase({ runtimeDirectory: directory })
  try {
    database.createProject({ id: 'project-1', title: 'Retention drift fixture' })
    createAsset(database, { id: 'drift-a' })
    createAsset(database, { id: 'drift-b' })
    const firstPath = await createAssetFile(directory, 'drift-a')
    const secondPath = await createAssetFile(directory, 'drift-b')
    let injected = false
    const service = new AssetRetentionService(database, {
      runtimeDirectory: directory,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
      onPhase(phase) {
        if (phase !== 'all-quarantined' || injected) return
        injected = true
        database.updateProject('project-1', { settings: { retainedAssetId: 'drift-b' } })
      },
    })
    const plan = service.plan()
    await assert.rejects(
      service.apply({
        planFingerprint: plan.planFingerprint,
        confirmationToken: plan.confirmationToken,
      }),
      (error: unknown) => error instanceof AssetRetentionError
        && error.code === 'RETENTION_PLAN_DRIFT',
    )
    assert.ok(database.getMediaAsset('drift-a'))
    assert.ok(database.getMediaAsset('drift-b'))
    assert.equal(await pathExists(firstPath), true)
    assert.equal(await pathExists(secondPath), true)
    assert.deepEqual(await readdir(join(directory, '.asset-retention-quarantine')), [])
  } finally {
    database.close()
  }
})

test('retention recovery restores a partial quarantine after a pre-commit crash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-retention-crash-restore-'))
  directories.push(directory)
  const database = initializeDatabase({ runtimeDirectory: directory })
  try {
    database.createProject({ id: 'project-1', title: 'Retention crash restore fixture' })
    createAsset(database, { id: 'crash-restore-a' })
    createAsset(database, { id: 'crash-restore-b' })
    const firstPath = await createAssetFile(directory, 'crash-restore-a')
    const secondPath = await createAssetFile(directory, 'crash-restore-b')
    let crashed = false
    const crashing = new AssetRetentionService(database, {
      runtimeDirectory: directory,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
      onPhase(phase) {
        if (phase === 'asset-quarantined' && !crashed) {
          crashed = true
          throw new AssetRetentionCrashSimulation()
        }
      },
    })
    const plan = crashing.plan()
    await assert.rejects(
      crashing.apply({
        planFingerprint: plan.planFingerprint,
        confirmationToken: plan.confirmationToken,
      }),
      AssetRetentionCrashSimulation,
    )
    assert.ok(database.getMediaAsset('crash-restore-a'))
    assert.ok(database.getMediaAsset('crash-restore-b'))
    assert.equal(await pathExists(firstPath), false)
    assert.equal(await pathExists(secondPath), true)

    const recovering = new AssetRetentionService(database, { runtimeDirectory: directory })
    assert.deepEqual(await recovering.recover(), { operations: 1, restored: 1, cleaned: 0 })
    assert.equal(await pathExists(firstPath), true)
    assert.equal(await pathExists(secondPath), true)
    assert.deepEqual(await readdir(join(directory, '.asset-retention-quarantine')), [])
  } finally {
    database.close()
  }
})

test('retention recovery finishes physical cleanup after a post-commit crash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-retention-crash-cleanup-'))
  directories.push(directory)
  const database = initializeDatabase({ runtimeDirectory: directory })
  try {
    database.createProject({ id: 'project-1', title: 'Retention crash cleanup fixture' })
    createAsset(database, { id: 'crash-cleanup' })
    const filePath = await createAssetFile(directory, 'crash-cleanup')
    const crashing = new AssetRetentionService(database, {
      runtimeDirectory: directory,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
      onPhase(phase) {
        if (phase === 'database-committed') throw new AssetRetentionCrashSimulation()
      },
    })
    const plan = crashing.plan()
    await assert.rejects(
      crashing.apply({
        planFingerprint: plan.planFingerprint,
        confirmationToken: plan.confirmationToken,
      }),
      AssetRetentionCrashSimulation,
    )
    assert.equal(database.getMediaAsset('crash-cleanup'), undefined)
    assert.equal(await pathExists(filePath), false)

    const recovering = new AssetRetentionService(database, { runtimeDirectory: directory })
    assert.deepEqual(await recovering.recover(), { operations: 1, restored: 0, cleaned: 1 })
    assert.deepEqual(await readdir(join(directory, '.asset-retention-quarantine')), [])
  } finally {
    database.close()
  }
})

test('retention apply rejects symlink escapes without deleting the row or target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-retention-path-'))
  directories.push(directory)
  const outside = await mkdtemp(join(tmpdir(), 'manju-retention-outside-'))
  directories.push(outside)
  const database = initializeDatabase({ runtimeDirectory: directory })
  try {
    database.createProject({ id: 'project-1', title: 'Retention path fixture' })
    createAsset(database, { id: 'unsafe-link' })
    const mediaProjectDirectory = join(directory, 'media', 'project-1')
    await mkdir(mediaProjectDirectory, { recursive: true })
    const outsidePath = join(outside, 'must-survive.png')
    await writeFile(outsidePath, ONE_PIXEL_PNG)
    await symlink(outsidePath, join(mediaProjectDirectory, 'unsafe-link.png'))
    const service = new AssetRetentionService(database, {
      runtimeDirectory: directory,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    })
    const plan = service.plan()
    await assert.rejects(
      service.apply({
        planFingerprint: plan.planFingerprint,
        confirmationToken: plan.confirmationToken,
      }),
      (error: unknown) => error instanceof AssetRetentionError
        && error.code === 'RETENTION_UNSAFE_PATH',
    )
    assert.ok(database.getMediaAsset('unsafe-link'))
    assert.equal(await pathExists(outsidePath), true)
  } finally {
    database.close()
  }
})
