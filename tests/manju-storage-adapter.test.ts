import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ManjuStorageAdapter,
  TimelineStorageConflictError,
  TimelineStorageIncompatibleSnapshotError,
  type TimelineStorageTransport,
} from '../src/features/editor/manju-storage-adapter'
import { ApiError } from '../src/lib/api'
import type {
  SaveTimelineDocumentInput,
  TimelineMaterializationSnapshot,
  TimelineDocumentSnapshot,
} from '../src/lib/api-types'

const COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'

function snapshot(revisionId: string, document: Record<string, unknown>): TimelineDocumentSnapshot {
  const now = '2026-07-14T00:00:00.000Z'
  return {
    timelineDocument: {
      id: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      currentRevisionId: revisionId,
      schemaVersion: 1,
      upstreamCommit: COMMIT,
      sourceRevisionId: 'story-1',
      createdAt: now,
      updatedAt: now,
    },
    revision: {
      id: revisionId,
      documentId: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      parentRevisionId: null,
      schemaVersion: 1,
      upstreamCommit: COMMIT,
      sourceRevisionId: 'story-1',
      summary: '保存',
      snapshot: structuredClone(document),
      createdAt: now,
    },
    document: structuredClone(document),
    etag: `W/"${revisionId}"`,
  }
}

function adapter(transport: TimelineStorageTransport): ManjuStorageAdapter {
  return new ManjuStorageAdapter({
    projectId: 'project-1',
    episodeId: 'episode-1',
    schemaVersion: 1,
    upstreamCommit: COMMIT,
    sourceRevisionId: 'story-1',
    transport,
  })
}

function materialized(
  operation: 'materialize' | 'reconcile',
  revisionId: string,
): TimelineMaterializationSnapshot {
  return {
    ...snapshot(revisionId, { tracks: [] }),
    created: operation === 'materialize',
    report: {
      operation,
      sourceRevisionId: 'story-1',
      previousSourceRevisionId: operation === 'reconcile' ? 'story-0' : null,
      changed: true,
      preservedElementIds: [],
      appendedShots: [],
      orphanedElements: [],
      preservedAbsentShots: [],
      unresolvedShots: [],
    },
  }
}

test('ManjuStorageAdapter loads and saves with the authoritative ETag', async () => {
  const calls: Array<{ input: SaveTimelineDocumentInput; etag: string }> = []
  const transport: TimelineStorageTransport = {
    async load() {
      return snapshot('revision-1', { tracks: [] })
    },
    async save(_episodeId, input, etag) {
      calls.push({ input, etag })
      return snapshot('revision-2', input.document)
    },
  }
  const storage = adapter(transport)

  assert.deepEqual((await storage.load())?.document, { tracks: [] })
  const saved = await storage.save({ tracks: [{ id: 'visual' }] }, { summary: '移动镜头' })

  assert.equal(calls[0].etag, 'W/"revision-1"')
  assert.equal(calls[0].input.summary, '移动镜头')
  assert.equal(Object.hasOwn(calls[0].input, 'sourceRevisionId'), false)
  assert.equal(saved.revision.id, 'revision-2')
  assert.deepEqual(storage.getState(), {
    phase: 'ready',
    dirty: false,
    etag: 'W/"revision-2"',
    currentRevisionId: 'revision-2',
    lastSavedAt: '2026-07-14T00:00:00.000Z',
    message: undefined,
  })
})

test('a missing timeline is created with If-Match star', async () => {
  let saveEtag = ''
  const storage = adapter({
    async load() {
      throw new ApiError('missing', { status: 404, code: 'TIMELINE_DOCUMENT_NOT_FOUND' })
    },
    async save(_episodeId, input, etag) {
      saveEtag = etag
      return snapshot('revision-created', input.document)
    },
  })

  assert.equal(await storage.load(), null)
  await assert.rejects(storage.flush(), /尚未持久化/)
  await storage.save({ tracks: [] })
  assert.equal(saveEtag, '*')
})

test('conflicts preserve the dirty local document and never retry or overwrite', async () => {
  let attempts = 0
  const storage = adapter({
    async load() {
      return snapshot('revision-1', { tracks: [] })
    },
    async save() {
      attempts += 1
      throw new ApiError('conflict', {
        status: 412,
        code: 'TIMELINE_DOCUMENT_CONFLICT',
        details: { currentRevisionId: 'revision-remote' },
      })
    },
  })
  await storage.load()
  const local = { tracks: [{ id: 'local' }] }

  await assert.rejects(storage.save(local), (error: unknown) => {
    assert.ok(error instanceof TimelineStorageConflictError)
    assert.equal(error.currentRevisionId, 'revision-remote')
    assert.equal(error.expectedEtag, 'W/"revision-1"')
    assert.deepEqual(error.localDocument, local)
    return true
  })
  assert.equal(attempts, 1)
  assert.equal(storage.getState().phase, 'conflict')
  assert.equal(storage.getState().dirty, true)
})

test('conflict recovery adopts the authoritative head only after an explicit call', async () => {
  let remote = snapshot('revision-1', { tracks: [] })
  const storage = adapter({
    async load() {
      return remote
    },
    async save() {
      remote = snapshot('revision-remote', { tracks: ['remote'] })
      remote.revision.parentRevisionId = 'revision-1'
      throw new ApiError('conflict', {
        status: 412,
        code: 'TIMELINE_DOCUMENT_CONFLICT',
        details: { currentRevisionId: remote.revision.id },
      })
    },
  })
  await storage.load()
  await assert.rejects(storage.save({ tracks: ['local'] }), TimelineStorageConflictError)
  assert.equal(storage.getState().currentRevisionId, 'revision-remote')

  const adopted = await storage.adoptAuthoritativeHead()
  assert.equal(adopted.revision.id, 'revision-remote')
  assert.deepEqual(adopted.document, { tracks: ['remote'] })
  assert.equal(storage.getState().phase, 'ready')
  assert.equal(storage.getState().dirty, false)
})

test('conflict adoption validates the remote canonical document before advancing the cursor', async () => {
  let remote = snapshot('revision-1', { canonical: true })
  const storage = new ManjuStorageAdapter({
    projectId: 'project-1',
    episodeId: 'episode-1',
    schemaVersion: 1,
    upstreamCommit: COMMIT,
    sourceRevisionId: 'story-1',
    validateDocument: (document) => document.canonical === true,
    transport: {
      async load() {
        return remote
      },
      async save() {
        remote = snapshot('revision-remote', { canonical: false, futureElement: true })
        remote.revision.parentRevisionId = 'revision-1'
        throw new ApiError('conflict', {
          status: 412,
          code: 'TIMELINE_DOCUMENT_CONFLICT',
          details: { currentRevisionId: remote.revision.id },
        })
      },
    },
  })
  await storage.load()
  await assert.rejects(storage.save({ canonical: true, local: true }), TimelineStorageConflictError)

  await assert.rejects(
    storage.adoptAuthoritativeHead(),
    /尚未采用/,
  )
  assert.deepEqual(storage.getState(), {
    phase: 'conflict',
    dirty: true,
    etag: 'W/"revision-1"',
    currentRevisionId: 'revision-remote',
    lastSavedAt: '2026-07-14T00:00:00.000Z',
    message: '服务端最新修订未通过 pinned OpenCut canonical 校验，仍保持隔离',
  })

  remote = snapshot('revision-compatible', { canonical: true })
  remote.revision.parentRevisionId = 'revision-remote'
  const adopted = await storage.adoptAuthoritativeHead()
  assert.equal(adopted.revision.id, 'revision-compatible')
  assert.equal(storage.getState().etag, 'W/"revision-compatible"')
  assert.equal(storage.getState().dirty, false)
})

test('conflict recovery explicitly saves a canonical local copy as a new latest-head child', async () => {
  let remote = snapshot('revision-1', { tracks: [] })
  const etags: string[] = []
  let firstSave = true
  const storage = adapter({
    async load() {
      return remote
    },
    async save(_episodeId, input, etag) {
      etags.push(etag)
      if (firstSave) {
        firstSave = false
        remote = snapshot('revision-remote', { tracks: ['remote'] })
        remote.revision.parentRevisionId = 'revision-1'
        throw new ApiError('conflict', {
          status: 412,
          code: 'TIMELINE_DOCUMENT_CONFLICT',
          details: { currentRevisionId: remote.revision.id },
        })
      }
      const saved = snapshot('revision-rescued', input.document)
      saved.revision.parentRevisionId = remote.revision.id
      remote = saved
      return saved
    },
  })
  await storage.load()
  const local = { tracks: ['local'] }
  await assert.rejects(storage.save(local), TimelineStorageConflictError)

  const rescued = await storage.saveConflictAsNewRevision(local)
  assert.equal(rescued.revision.id, 'revision-rescued')
  assert.equal(rescued.revision.parentRevisionId, 'revision-remote')
  assert.deepEqual(rescued.document, local)
  assert.deepEqual(etags, ['W/"revision-1"', 'W/"revision-remote"'])
  assert.equal(storage.getState().phase, 'ready')
  assert.equal(storage.getState().dirty, false)
})

test('conflict recovery cannot substitute a different document for the preserved local intent', async () => {
  let remote = snapshot('revision-1', { tracks: [] })
  let saveCalls = 0
  const storage = adapter({
    async load() {
      return remote
    },
    async save() {
      saveCalls += 1
      remote = snapshot('revision-remote', { tracks: ['remote'] })
      remote.revision.parentRevisionId = 'revision-1'
      throw new ApiError('conflict', {
        status: 412,
        code: 'TIMELINE_DOCUMENT_CONFLICT',
        details: { currentRevisionId: remote.revision.id },
      })
    },
  })
  await storage.load()
  await assert.rejects(storage.save({ tracks: ['preserved'] }), TimelineStorageConflictError)
  await assert.rejects(
    storage.saveConflictAsNewRevision({ tracks: ['substituted'] }),
    /只能另存当前冲突中保留的完整本地时间线副本/,
  )
  assert.equal(saveCalls, 1)
  assert.deepEqual(storage.getConflictRescue()?.document, { tracks: ['preserved'] })
  assert.equal(storage.getState().dirty, true)
})

test('a second race keeps the rescue document dirty instead of overwriting again', async () => {
  let loadCount = 0
  const local = { tracks: ['local'] }
  const storage = adapter({
    async load() {
      loadCount += 1
      const loaded = snapshot(loadCount === 1 ? 'revision-1' : 'revision-remote', {
        tracks: loadCount === 1 ? [] : ['remote'],
      })
      if (loadCount > 1) loaded.revision.parentRevisionId = 'revision-1'
      return loaded
    },
    async save() {
      throw new ApiError('conflict', {
        status: 412,
        code: 'TIMELINE_DOCUMENT_CONFLICT',
        details: { currentRevisionId: loadCount === 1 ? 'revision-remote' : 'revision-newer' },
      })
    },
  })
  await storage.load()
  await assert.rejects(storage.save(local), TimelineStorageConflictError)
  await assert.rejects(storage.saveConflictAsNewRevision(local), (error: unknown) => {
    assert.ok(error instanceof TimelineStorageConflictError)
    assert.deepEqual(error.localDocument, local)
    assert.equal(error.currentRevisionId, 'revision-newer')
    return true
  })
  assert.equal(storage.getState().phase, 'conflict')
  assert.equal(storage.getState().dirty, true)
})

test('concurrent autosaves serialize and advance the ETag for the next save', async () => {
  const etags: string[] = []
  let releaseFirst: (() => void) | undefined
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
  let call = 0
  const storage = adapter({
    async load() {
      return snapshot('revision-1', { tracks: [] })
    },
    async save(_episodeId, input, etag) {
      call += 1
      etags.push(etag)
      if (call === 1) await firstBlocked
      return snapshot(`revision-${call + 1}`, input.document)
    },
  })
  await storage.load()

  const first = storage.save({ version: 1 })
  const second = storage.save({ version: 2 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(etags, ['W/"revision-1"'])
  releaseFirst?.()
  await Promise.all([first, second])

  assert.deepEqual(etags, ['W/"revision-1"', 'W/"revision-2"'])
  assert.equal(storage.getState().etag, 'W/"revision-3"')
  assert.equal(storage.getState().dirty, false)
})

test('flush awaits queued saves and returns the exact authoritative immutable snapshot', async () => {
  let releaseFirst!: () => void
  const firstSaveBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
  const etags: string[] = []
  const storage = adapter({
    async load() {
      return snapshot('revision-1', { tracks: [] })
    },
    async save(_episodeId, input, etag) {
      etags.push(etag)
      if (etags.length === 1) await firstSaveBlocked
      return snapshot(`revision-${etags.length + 1}`, input.document)
    },
  })
  await storage.load()
  void storage.save({ tracks: ['edited'] })
  const flush = storage.flush({ tracks: ['edited'] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(etags, ['W/"revision-1"'])
  releaseFirst()

  const pinned = await flush
  assert.equal(pinned.revision.id, 'revision-2')
  assert.equal(pinned.etag, 'W/"revision-2"')
  assert.deepEqual(pinned.document, { tracks: ['edited'] })
  assert.deepEqual(etags, ['W/"revision-1"'])
})

test('flush saves a newer supplied command document before returning its revision', async () => {
  const calls: Array<{ document: Record<string, unknown>; etag: string }> = []
  const storage = adapter({
    async load() {
      return snapshot('revision-1', { tracks: [] })
    },
    async save(_episodeId, input, etag) {
      calls.push({ document: input.document, etag })
      return snapshot('revision-2', input.document)
    },
  })
  await storage.load()

  const pinned = await storage.flush({ tracks: ['latest-command-state'] }, {
    summary: '固化预览与导出修订',
  })
  assert.equal(pinned.revision.id, 'revision-2')
  assert.deepEqual(calls, [{
    document: { tracks: ['latest-command-state'] },
    etag: 'W/"revision-1"',
  }])
})

test('an authoritative external timeline mutation advances the adapter revision cursor', async () => {
  const storage = adapter({
    async load() {
      return snapshot('revision-1', { tracks: [] })
    },
    async save() {
      throw new Error('save should not be called')
    },
  })
  await storage.load()
  const external = snapshot('revision-2', { tracks: ['auto-edited'] })
  external.revision.parentRevisionId = 'revision-1'

  const adopted = storage.adoptServerMutation(external)
  assert.equal(adopted.revision.id, 'revision-2')
  assert.equal(storage.getState().etag, 'W/"revision-2"')
  assert.deepEqual((await storage.flush()).document, { tracks: ['auto-edited'] })
})

test('an external timeline mutation with a mismatched scope or ETag is rejected', async () => {
  const storage = adapter({
    async load() {
      return snapshot('revision-1', { tracks: [] })
    },
    async save() {
      throw new Error('save should not be called')
    },
  })
  await storage.load()
  const forged = snapshot('revision-2', { tracks: ['forged'] })
  forged.etag = 'W/"different"'

  assert.throws(() => storage.adoptServerMutation(forged), /作用域不一致/)
  assert.equal(storage.getState().currentRevisionId, 'revision-1')
})

test('server materialization and reconcile adopt their authoritative revisions', async () => {
  const calls: string[] = []
  const storage = adapter({
    async load() {
      throw new ApiError('missing', { status: 404, code: 'TIMELINE_DOCUMENT_NOT_FOUND' })
    },
    async save() {
      throw new Error('save should not be called')
    },
    async materialize(_episodeId, projectId) {
      calls.push(`materialize:${projectId}`)
      return materialized('materialize', 'revision-materialized')
    },
    async reconcile(_episodeId, projectId, etag) {
      calls.push(`reconcile:${projectId}:${etag}`)
      return materialized('reconcile', 'revision-reconciled')
    },
  })

  assert.equal(await storage.load(), null)
  const created = await storage.materialize()
  assert.equal(created.revision.id, 'revision-materialized')
  assert.equal(storage.getState().etag, 'W/"revision-materialized"')
  const reconciled = await storage.reconcile()
  assert.equal(reconciled.revision.id, 'revision-reconciled')
  assert.equal(storage.getState().etag, 'W/"revision-reconciled"')
  assert.deepEqual(calls, [
    'materialize:project-1',
    'reconcile:project-1:W/"revision-materialized"',
  ])
})

test('reconcile validates current Story provenance before advancing the adapter cursor', async () => {
  const oldHead = snapshot('revision-old', { tracks: ['old'] })
  oldHead.timelineDocument.sourceRevisionId = 'story-0'
  oldHead.revision.sourceRevisionId = 'story-0'
  const incompatible = materialized('reconcile', 'revision-incompatible')
  incompatible.timelineDocument.sourceRevisionId = 'story-0'
  incompatible.revision.sourceRevisionId = 'story-0'
  incompatible.revision.parentRevisionId = oldHead.revision.id
  const storage = adapter({
    async load() {
      return oldHead
    },
    async save() {
      throw new Error('save should not be called')
    },
    async reconcile() {
      return incompatible
    },
  })

  await storage.load()
  await assert.rejects(storage.reconcile(), (error: unknown) => {
    assert.ok(error instanceof TimelineStorageIncompatibleSnapshotError)
    assert.equal(error.snapshot.revision.id, 'revision-incompatible')
    assert.deepEqual(error.snapshot.document, incompatible.document)
    return true
  })
  assert.equal(storage.getState().etag, 'W/"revision-old"')
  assert.equal(storage.getState().currentRevisionId, 'revision-old')
  assert.equal(storage.getState().phase, 'error')
})

test('ordinary save validates authoritative metadata before advancing the adapter cursor', async () => {
  const storage = adapter({
    async load() {
      return snapshot('revision-1', { tracks: [] })
    },
    async save(_episodeId, input) {
      const incompatible = snapshot('revision-2', input.document)
      incompatible.timelineDocument.upstreamCommit = 'f'.repeat(40)
      incompatible.revision.upstreamCommit = 'f'.repeat(40)
      incompatible.revision.parentRevisionId = 'revision-1'
      return incompatible
    },
  })

  await storage.load()
  await assert.rejects(
    storage.save({ tracks: ['local'] }),
    TimelineStorageIncompatibleSnapshotError,
  )
  assert.equal(storage.getState().etag, 'W/"revision-1"')
  assert.equal(storage.getState().currentRevisionId, 'revision-1')
  assert.equal(storage.getState().dirty, true)
})

test('recovers an exact committed save after a lost or malformed success response', async () => {
  let remote = snapshot('revision-1', { tracks: [] })
  let saveCalls = 0
  const etags: string[] = []
  const storage = adapter({
    async load() {
      return remote
    },
    async save(_episodeId, input, etag) {
      saveCalls += 1
      etags.push(etag)
      remote = snapshot(`revision-${saveCalls + 1}`, input.document)
      remote.revision.parentRevisionId = `revision-${saveCalls}`
      if (saveCalls === 1) {
        throw new ApiError('response was truncated after commit', {
          code: 'INVALID_RESPONSE',
        })
      }
      return remote
    },
  })
  await storage.load()

  const recovered = await storage.save({ tracks: ['committed'] })
  assert.equal(recovered.revision.id, 'revision-2')
  assert.equal(storage.getState().etag, 'W/"revision-2"')
  assert.equal(storage.getState().dirty, false)

  const next = await storage.save({ tracks: ['next'] })
  assert.equal(next.revision.id, 'revision-3')
  assert.deepEqual(etags, ['W/"revision-1"', 'W/"revision-2"'])
})

test('does not adopt an ambiguous remote head unless parent and document are exact', async () => {
  // The first load represents the prior authoritative head.
  const prior = snapshot('revision-1', { tracks: [] })
  let loadCount = 0
  const strictStorage = adapter({
    async load() {
      loadCount += 1
      if (loadCount === 1) return prior
      const remote = snapshot('revision-other', { tracks: ['other-session'] })
      remote.revision.parentRevisionId = 'revision-1'
      return remote
    },
    async save() {
      throw new ApiError('connection dropped', { code: 'NETWORK_ERROR' })
    },
  })
  await strictStorage.load()
  await assert.rejects(strictStorage.save({ tracks: ['local'] }), (error: unknown) => (
    error instanceof ApiError && error.code === 'NETWORK_ERROR'
  ))
  assert.equal(strictStorage.getState().phase, 'error')
  assert.equal(strictStorage.getState().dirty, true)
  assert.equal(strictStorage.getState().etag, 'W/"revision-1"')
})

test('recovers materialize and reconcile commits through authoritative GET', async () => {
  let remote: TimelineDocumentSnapshot | null = null
  let reconcileCalls = 0
  const storage = adapter({
    async load() {
      if (!remote) {
        throw new ApiError('missing', {
          status: 404,
          code: 'TIMELINE_DOCUMENT_NOT_FOUND',
        })
      }
      return remote
    },
    async save() {
      throw new Error('save should not run')
    },
    async materialize() {
      remote = snapshot('revision-materialized', { tracks: ['created'] })
      throw new ApiError('response lost after materialize', { code: 'NETWORK_ERROR' })
    },
    async reconcile() {
      reconcileCalls += 1
      const next = snapshot('revision-reconciled', { tracks: ['reconciled'] })
      next.revision.parentRevisionId = 'revision-materialized'
      remote = next
      throw new ApiError('response malformed after reconcile', { code: 'INVALID_RESPONSE' })
    },
  })

  assert.equal(await storage.load(), null)
  const created = await storage.materialize()
  assert.equal(created.revision.id, 'revision-materialized')
  const reconciled = await storage.reconcile()
  assert.equal(reconciled.revision.id, 'revision-reconciled')
  assert.equal(reconcileCalls, 1)
  assert.equal(storage.getState().phase, 'ready')
})
