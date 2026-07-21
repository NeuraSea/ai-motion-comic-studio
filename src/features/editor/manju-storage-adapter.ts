import {
  ApiError,
  api,
  type SaveTimelineDocumentInput,
  type TimelineDocumentSnapshot,
  type TimelineMaterializationSnapshot,
} from '../../lib'

export type TimelineStoragePhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'saving'
  | 'missing'
  | 'conflict'
  | 'error'

export interface TimelineStorageState {
  phase: TimelineStoragePhase
  dirty: boolean
  etag: string | null
  currentRevisionId: string | null
  lastSavedAt: string | null
  message?: string
}

export interface TimelineConflictRescueSnapshot {
  document: Record<string, unknown>
  currentRevisionId: string | null
  expectedEtag: string | null
  capturedAt: string
}

export interface TimelineStorageTransport {
  load(episodeId: string, signal?: AbortSignal): Promise<TimelineDocumentSnapshot>
  save(
    episodeId: string,
    input: SaveTimelineDocumentInput,
    etag: string | '*',
    signal?: AbortSignal,
  ): Promise<TimelineDocumentSnapshot>
  materialize?(
    episodeId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<TimelineMaterializationSnapshot>
  reconcile?(
    episodeId: string,
    projectId: string,
    etag: string,
    signal?: AbortSignal,
  ): Promise<TimelineMaterializationSnapshot>
}

export interface ManjuStorageAdapterOptions {
  projectId: string
  episodeId: string
  schemaVersion: number
  upstreamCommit: string
  sourceRevisionId?: string | null
  /**
   * Optional UI-neutral canonical-document gate used before any authoritative
   * mutation response advances the adapter cursor. Normal load deliberately
   * still returns an incompatible authoritative snapshot so the caller can
   * quarantine and export its raw JSON instead of losing access to it.
   */
  validateDocument?: (document: Record<string, unknown>) => boolean
  transport?: TimelineStorageTransport
}

export class TimelineStorageConflictError extends Error {
  constructor(
    readonly localDocument: Record<string, unknown>,
    readonly currentRevisionId: string | null,
    readonly expectedEtag: string | null,
    options?: ErrorOptions,
  ) {
    super('时间线已在其他会话中更新，本地修改尚未覆盖服务端版本', options)
    this.name = 'TimelineStorageConflictError'
  }
}

const defaultTransport: TimelineStorageTransport = {
  load: (episodeId, signal) => api.getTimelineDocument(episodeId, { signal }),
  save: (episodeId, input, etag, signal) => api.saveTimelineDocument(
    episodeId,
    input,
    etag,
    { signal },
  ),
  materialize: (episodeId, projectId, signal) => api.materializeTimelineDocument(
    episodeId,
    { projectId, summary: '从当前剧本创建 OpenCut 时间线' },
    { signal },
  ),
  reconcile: (episodeId, projectId, etag, signal) => api.reconcileTimelineDocument(
    episodeId,
    { projectId, summary: '对账最新剧本修订' },
    etag,
    { signal },
  ),
}

function cloneDocument(document: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(document)
}

function cloneSnapshot(snapshot: TimelineDocumentSnapshot): TimelineDocumentSnapshot {
  return {
    ...snapshot,
    timelineDocument: { ...snapshot.timelineDocument },
    revision: {
      ...snapshot.revision,
      snapshot: cloneDocument(snapshot.revision.snapshot),
    },
    document: cloneDocument(snapshot.document),
  }
}

export class TimelineStorageIncompatibleSnapshotError extends Error {
  readonly snapshot: TimelineDocumentSnapshot

  constructor(
    snapshot: TimelineDocumentSnapshot,
    message = '服务端返回的时间线 head 与当前 pinned OpenCut 编辑器不兼容',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TimelineStorageIncompatibleSnapshotError'
    this.snapshot = cloneSnapshot(snapshot)
  }
}

function documentsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isAmbiguousWriteFailure(error: unknown): boolean {
  return error instanceof ApiError
    && (error.code === 'NETWORK_ERROR' || error.code === 'INVALID_RESPONSE')
}

/**
 * Cloud persistence boundary for the extracted OpenCut command engine.
 *
 * OpenCut commands remain in memory; only their plain document snapshot is
 * persisted. Saves are serialized and always carry the latest server ETag, so
 * an autosave can never silently overwrite another editor session.
 */
export class ManjuStorageAdapter {
  private readonly transport: TimelineStorageTransport
  private readonly listeners = new Set<(state: TimelineStorageState) => void>()
  private saveChain: Promise<unknown> = Promise.resolve()
  private latestSaveSequence = 0
  private lastSnapshot: TimelineDocumentSnapshot | null = null
  private conflictRescue: TimelineConflictRescueSnapshot | null = null
  private state: TimelineStorageState = {
    phase: 'idle',
    dirty: false,
    etag: null,
    currentRevisionId: null,
    lastSavedAt: null,
  }

  constructor(private readonly options: ManjuStorageAdapterOptions) {
    if (!options.projectId.trim() || !options.episodeId.trim()) {
      throw new TypeError('projectId and episodeId are required')
    }
    if (!Number.isSafeInteger(options.schemaVersion) || options.schemaVersion < 1) {
      throw new TypeError('schemaVersion must be a positive integer')
    }
    if (!/^[0-9a-f]{40}$/i.test(options.upstreamCommit)) {
      throw new TypeError('upstreamCommit must be a full Git commit SHA')
    }
    this.transport = options.transport ?? defaultTransport
  }

  getState(): TimelineStorageState {
    return { ...this.state }
  }

  getConflictRescue(): TimelineConflictRescueSnapshot | null {
    return this.conflictRescue ? {
      ...this.conflictRescue,
      document: cloneDocument(this.conflictRescue.document),
    } : null
  }

  subscribe(listener: (state: TimelineStorageState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  async load(signal?: AbortSignal): Promise<TimelineDocumentSnapshot | null> {
    this.update({ phase: 'loading', message: undefined })
    try {
      const snapshot = await this.transport.load(this.options.episodeId, signal)
      this.conflictRescue = null
      this.update({
        phase: 'ready',
        dirty: false,
        etag: snapshot.etag,
        currentRevisionId: snapshot.revision.id,
        lastSavedAt: snapshot.timelineDocument.updatedAt,
        message: undefined,
      })
      this.lastSnapshot = cloneSnapshot(snapshot)
      return cloneSnapshot(snapshot)
    } catch (error) {
      if (error instanceof ApiError
        && error.status === 404
        && error.code === 'TIMELINE_DOCUMENT_NOT_FOUND') {
        this.lastSnapshot = null
        this.update({
          phase: 'missing',
          dirty: false,
          etag: null,
          currentRevisionId: null,
          lastSavedAt: null,
          message: undefined,
        })
        return null
      }
      this.update({
        phase: 'error',
        message: error instanceof Error ? error.message : '无法加载时间线',
      })
      throw error
    }
  }

  async materialize(signal?: AbortSignal): Promise<TimelineMaterializationSnapshot> {
    if (!this.transport.materialize) {
      throw new Error('当前时间线传输层不支持从剧本创建时间线')
    }
    this.update({ phase: 'loading', message: undefined })
    try {
      const snapshot = await this.transport.materialize(
        this.options.episodeId,
        this.options.projectId,
        signal,
      )
      this.assertSnapshotCanAdvanceCursor(snapshot)
      this.adopt(snapshot)
      return { ...snapshot, document: cloneDocument(snapshot.document) }
    } catch (error) {
      const recovered = await this.recoverMaterialization(
        'materialize',
        null,
        error,
        signal,
      )
      if (recovered) return recovered
      this.update({
        phase: 'error',
        message: error instanceof Error ? error.message : '无法从剧本创建时间线',
      })
      throw error
    }
  }

  async reconcile(signal?: AbortSignal): Promise<TimelineMaterializationSnapshot> {
    if (!this.transport.reconcile) {
      throw new Error('当前时间线传输层不支持剧本对账')
    }
    if (!this.state.etag) throw new Error('对账前必须先读取服务端时间线修订')
    const priorSnapshot = this.lastSnapshot ? cloneSnapshot(this.lastSnapshot) : null
    this.update({ phase: 'saving', message: undefined })
    try {
      const snapshot = await this.transport.reconcile(
        this.options.episodeId,
        this.options.projectId,
        this.state.etag,
        signal,
      )
      this.assertSnapshotCanAdvanceCursor(snapshot)
      this.adopt(snapshot)
      return { ...snapshot, document: cloneDocument(snapshot.document) }
    } catch (error) {
      const recovered = await this.recoverMaterialization(
        'reconcile',
        priorSnapshot,
        error,
        signal,
      )
      if (recovered) return recovered
      if (error instanceof ApiError && error.status === 412
        && error.code === 'TIMELINE_DOCUMENT_CONFLICT') {
        const details = error.details
        const currentRevisionId = details && typeof details === 'object'
          && 'currentRevisionId' in details
          && (typeof details.currentRevisionId === 'string' || details.currentRevisionId === null)
          ? details.currentRevisionId
          : null
        this.update({
          phase: 'conflict',
          dirty: false,
          currentRevisionId,
          message: '时间线已在其他操作中更新，未自动覆盖',
        })
      } else {
        this.update({
          phase: 'error',
          message: error instanceof Error ? error.message : '时间线对账失败',
        })
      }
      throw error
    }
  }

  save(
    document: Record<string, unknown>,
    options: { summary?: string; signal?: AbortSignal } = {},
  ): Promise<TimelineDocumentSnapshot> {
    const localDocument = cloneDocument(document)
    const sequence = ++this.latestSaveSequence
    this.update({ phase: 'saving', dirty: true, message: undefined })

    const operation = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        const etag = this.state.etag ?? '*'
        const priorSnapshot = this.lastSnapshot ? cloneSnapshot(this.lastSnapshot) : null
        try {
          const snapshot = await this.transport.save(
            this.options.episodeId,
            {
              projectId: this.options.projectId,
              schemaVersion: this.options.schemaVersion,
              upstreamCommit: this.options.upstreamCommit,
              summary: options.summary,
              document: localDocument,
            },
            etag,
            options.signal,
          )
          this.assertSnapshotCanAdvanceCursor(snapshot)
          this.update({
            phase: sequence === this.latestSaveSequence ? 'ready' : 'saving',
            dirty: sequence !== this.latestSaveSequence,
            etag: snapshot.etag,
            currentRevisionId: snapshot.revision.id,
            lastSavedAt: snapshot.timelineDocument.updatedAt,
            message: undefined,
          })
          this.lastSnapshot = cloneSnapshot(snapshot)
          return cloneSnapshot(snapshot)
        } catch (error) {
          const recovered = await this.recoverSave(
            localDocument,
            priorSnapshot,
            error,
            options.signal,
          )
          if (recovered) {
            this.update({
              phase: sequence === this.latestSaveSequence ? 'ready' : 'saving',
              dirty: sequence !== this.latestSaveSequence,
            })
            return recovered
          }
          if (error instanceof ApiError && error.status === 412
            && error.code === 'TIMELINE_DOCUMENT_CONFLICT') {
            const details = error.details
            const currentRevisionId = details && typeof details === 'object'
              && 'currentRevisionId' in details
              && (typeof details.currentRevisionId === 'string' || details.currentRevisionId === null)
              ? details.currentRevisionId
              : null
            this.update({
              phase: 'conflict',
              dirty: true,
              currentRevisionId,
              message: '检测到服务端新版本，未覆盖本地修改',
            })
            this.rememberConflict(localDocument, currentRevisionId, etag)
            throw new TimelineStorageConflictError(localDocument, currentRevisionId, etag, { cause: error })
          }
          this.update({
            phase: 'error',
            dirty: true,
            message: error instanceof Error ? error.message : '时间线保存失败',
          })
          throw error
        }
      })

    this.saveChain = operation
    return operation
  }

  /**
   * Waits for every queued save and returns that exact immutable revision.
   * When a document is supplied, it is persisted first if it differs from the
   * last authoritative snapshot. Preview/export can therefore share one
   * explicit handoff instead of independently reconciling mutable state.
   */
  async flush(
    document?: Record<string, unknown>,
    options: { summary?: string; signal?: AbortSignal } = {},
  ): Promise<TimelineDocumentSnapshot> {
    while (true) {
      options.signal?.throwIfAborted()
      const barrier = this.saveChain
      await barrier
      if (barrier === this.saveChain) break
    }
    options.signal?.throwIfAborted()

    if (document) {
      const localDocument = cloneDocument(document)
      if (!this.lastSnapshot
        || JSON.stringify(this.lastSnapshot.document) !== JSON.stringify(localDocument)) {
        return this.save(localDocument, options)
      }
    }
    if (!this.lastSnapshot) {
      throw new Error('时间线尚未持久化，无法固化修订')
    }
    return cloneSnapshot(this.lastSnapshot)
  }

  /**
   * Adopts the authoritative snapshot returned by a separate server-side
   * timeline mutation (for example Agentic auto-edit apply/undo). This is not
   * a local write: scope, schema, pinned OpenCut commit and ETag must all match
   * before the adapter advances its persistence cursor.
   */
  adoptServerMutation(snapshot: TimelineDocumentSnapshot): TimelineDocumentSnapshot {
    if (!this.matchesScope(snapshot)) {
      throw new TimelineStorageIncompatibleSnapshotError(
        snapshot,
        '服务端时间线修订与当前 OpenCut 编辑器作用域不一致',
      )
    }
    if (!documentsEqual(snapshot.revision.snapshot, snapshot.document)
      || !this.documentPassesValidation(snapshot.document)) {
      throw new TimelineStorageIncompatibleSnapshotError(snapshot)
    }
    this.adopt(snapshot)
    return cloneSnapshot(snapshot)
  }

  /**
   * Explicit conflict resolution path that discards the in-memory intent and
   * adopts the latest authoritative head. Callers must update their editor
   * from the returned document; this method never runs automatically.
   */
  async adoptAuthoritativeHead(signal?: AbortSignal): Promise<TimelineDocumentSnapshot> {
    await this.awaitSaveBarrier(signal)
    const snapshot = await this.transport.load(this.options.episodeId, signal)
    if (!this.matchesScope(snapshot)) {
      this.update({
        phase: 'conflict',
        dirty: true,
        message: '服务端最新修订与当前 OpenCut 编辑器不兼容',
      })
      throw new TimelineStorageIncompatibleSnapshotError(
        snapshot,
        '服务端最新修订与当前 OpenCut 编辑器作用域不一致',
      )
    }
    if (!this.documentPassesValidation(snapshot.document)) {
      this.update({
        phase: 'conflict',
        dirty: true,
        currentRevisionId: snapshot.revision.id,
        message: '服务端最新修订未通过 pinned OpenCut canonical 校验，仍保持隔离',
      })
      throw new TimelineStorageIncompatibleSnapshotError(
        snapshot,
        '服务端最新修订不符合 pinned OpenCut canonical schema；尚未采用',
      )
    }
    if (!documentsEqual(snapshot.revision.snapshot, snapshot.document)) {
      this.update({
        phase: 'conflict',
        dirty: true,
        currentRevisionId: snapshot.revision.id,
        message: '服务端最新修订与 authoritative document 不一致，仍保持隔离',
      })
      throw new TimelineStorageIncompatibleSnapshotError(
        snapshot,
        '服务端最新修订与 authoritative document 不一致；尚未采用',
      )
    }
    this.adopt(snapshot)
    return cloneSnapshot(snapshot)
  }

  /**
   * Explicitly preserves a conflict document as a new child of the latest
   * server head. This is intentionally not an automatic merge/rebase: the UI
   * must first validate the canonical OpenCut document and obtain a deliberate
   * user action. A second race fails closed with another rescue error.
   */
  async saveConflictAsNewRevision(
    document: Record<string, unknown>,
    options: { summary?: string; signal?: AbortSignal } = {},
  ): Promise<TimelineDocumentSnapshot> {
    const localDocument = cloneDocument(document)
    await this.awaitSaveBarrier(options.signal)
    if (!this.conflictRescue || !documentsEqual(this.conflictRescue.document, localDocument)) {
      throw new Error('只能另存当前冲突中保留的完整本地时间线副本')
    }
    const conflictBase = this.lastSnapshot ? cloneSnapshot(this.lastSnapshot) : null
    this.update({ phase: 'loading', dirty: true, message: undefined })
    let current: TimelineDocumentSnapshot
    try {
      current = await this.transport.load(this.options.episodeId, options.signal)
    } catch (error) {
      this.update({
        phase: 'conflict',
        dirty: true,
        message: error instanceof Error ? error.message : '无法读取服务端最新修订',
      })
      throw error
    }
    const expectedSourceRevisionId = this.options.sourceRevisionId
      ?? conflictBase?.timelineDocument.sourceRevisionId
    if (!this.matchesScope(current)
      || (conflictBase !== null
        && current.timelineDocument.id !== conflictBase.timelineDocument.id)
      || (expectedSourceRevisionId !== undefined
        && (current.timelineDocument.sourceRevisionId !== expectedSourceRevisionId
          || current.revision.sourceRevisionId !== expectedSourceRevisionId))) {
      this.update({
        phase: 'conflict',
        dirty: true,
        currentRevisionId: current.revision.id,
        message: '服务端最新修订的剧本源、schema 或上游 commit 已变化',
      })
      this.rememberConflict(localDocument, current.revision.id, current.etag)
      throw new TimelineStorageConflictError(
        localDocument,
        current.revision.id,
        current.etag,
      )
    }

    this.update({ phase: 'saving', dirty: true, message: undefined })
    try {
      const saved = await this.transport.save(
        this.options.episodeId,
        {
          projectId: this.options.projectId,
          schemaVersion: this.options.schemaVersion,
          upstreamCommit: this.options.upstreamCommit,
          summary: options.summary ?? '冲突救援：将本地副本另存为新修订',
          document: localDocument,
        },
        current.etag,
        options.signal,
      )
      if (!this.matchesScope(saved)
        || saved.revision.parentRevisionId !== current.revision.id
        || saved.timelineDocument.id !== current.timelineDocument.id
        || saved.timelineDocument.sourceRevisionId !== current.timelineDocument.sourceRevisionId
        || saved.revision.sourceRevisionId !== current.revision.sourceRevisionId
        || !documentsEqual(saved.document, localDocument)) {
        throw new Error('服务端未按最新 head 创建可验证的新修订')
      }
      this.assertSnapshotCanAdvanceCursor(saved)
      this.adopt(saved)
      return cloneSnapshot(saved)
    } catch (error) {
      const recovered = await this.recoverSave(
        localDocument,
        current,
        error,
        options.signal,
      )
      if (recovered) return recovered
      if (error instanceof ApiError
        && error.status === 412
        && error.code === 'TIMELINE_DOCUMENT_CONFLICT') {
        const details = error.details
        const currentRevisionId = details && typeof details === 'object'
          && 'currentRevisionId' in details
          && (typeof details.currentRevisionId === 'string' || details.currentRevisionId === null)
          ? details.currentRevisionId
          : null
        this.update({
          phase: 'conflict',
          dirty: true,
          currentRevisionId,
          message: '另存前服务端再次更新，本地副本仍未覆盖远端',
        })
        this.rememberConflict(localDocument, currentRevisionId, current.etag)
        throw new TimelineStorageConflictError(
          localDocument,
          currentRevisionId,
          current.etag,
          { cause: error },
        )
      }
      this.update({
        phase: 'conflict',
        dirty: true,
        message: error instanceof Error ? error.message : '本地副本另存失败',
      })
      throw error
    }
  }

  private async awaitSaveBarrier(signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted()
      const barrier = this.saveChain
      await barrier.catch(() => undefined)
      if (barrier === this.saveChain) return
    }
  }

  private update(patch: Partial<TimelineStorageState>): void {
    this.state = { ...this.state, ...patch }
    const snapshot = this.getState()
    this.listeners.forEach((listener) => listener(snapshot))
  }

  private adopt(snapshot: TimelineDocumentSnapshot): void {
    this.conflictRescue = null
    this.lastSnapshot = cloneSnapshot(snapshot)
    this.update({
      phase: 'ready',
      dirty: false,
      etag: snapshot.etag,
      currentRevisionId: snapshot.revision.id,
      lastSavedAt: snapshot.timelineDocument.updatedAt,
      message: undefined,
    })
  }

  private rememberConflict(
    document: Record<string, unknown>,
    currentRevisionId: string | null,
    expectedEtag: string | null,
  ): void {
    this.conflictRescue = {
      document: cloneDocument(document),
      currentRevisionId,
      expectedEtag,
      capturedAt: new Date().toISOString(),
    }
  }

  private matchesScope(snapshot: TimelineDocumentSnapshot): boolean {
    return snapshot.revision.documentId === snapshot.timelineDocument.id
      && snapshot.timelineDocument.projectId === this.options.projectId
      && snapshot.timelineDocument.episodeId === this.options.episodeId
      && snapshot.revision.projectId === this.options.projectId
      && snapshot.revision.episodeId === this.options.episodeId
      && snapshot.timelineDocument.schemaVersion === this.options.schemaVersion
      && snapshot.revision.schemaVersion === this.options.schemaVersion
      && snapshot.timelineDocument.upstreamCommit === this.options.upstreamCommit
      && snapshot.revision.upstreamCommit === this.options.upstreamCommit
      && snapshot.timelineDocument.sourceRevisionId === snapshot.revision.sourceRevisionId
      && (this.options.sourceRevisionId === undefined
        || (snapshot.timelineDocument.sourceRevisionId === this.options.sourceRevisionId
          && snapshot.revision.sourceRevisionId === this.options.sourceRevisionId))
      && snapshot.timelineDocument.currentRevisionId === snapshot.revision.id
      && snapshot.etag === `W/"${snapshot.revision.id}"`
  }

  private documentPassesValidation(document: Record<string, unknown>): boolean {
    if (!this.options.validateDocument) return true
    try {
      return this.options.validateDocument(cloneDocument(document)) === true
    } catch {
      return false
    }
  }

  private assertSnapshotCanAdvanceCursor(snapshot: TimelineDocumentSnapshot): void {
    if (!this.matchesScope(snapshot)
      || !documentsEqual(snapshot.revision.snapshot, snapshot.document)
      || !this.documentPassesValidation(snapshot.document)) {
      throw new TimelineStorageIncompatibleSnapshotError(snapshot)
    }
  }

  private async loadRecoveryCandidate(
    error: unknown,
    signal?: AbortSignal,
  ): Promise<TimelineDocumentSnapshot | null> {
    if (!isAmbiguousWriteFailure(error)) return null
    try {
      signal?.throwIfAborted()
      const snapshot = await this.transport.load(this.options.episodeId, signal)
      return this.matchesScope(snapshot)
        && documentsEqual(snapshot.revision.snapshot, snapshot.document)
        && this.documentPassesValidation(snapshot.document)
        ? snapshot
        : null
    } catch {
      return null
    }
  }

  private async recoverSave(
    localDocument: Record<string, unknown>,
    priorSnapshot: TimelineDocumentSnapshot | null,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<TimelineDocumentSnapshot | null> {
    const snapshot = await this.loadRecoveryCandidate(error, signal)
    if (!snapshot || !documentsEqual(snapshot.document, localDocument)) return null
    const priorRevisionId = priorSnapshot?.revision.id ?? null
    if (snapshot.revision.parentRevisionId !== priorRevisionId) return null
    this.adopt(snapshot)
    return cloneSnapshot(snapshot)
  }

  private async recoverMaterialization(
    operation: 'materialize' | 'reconcile',
    priorSnapshot: TimelineDocumentSnapshot | null,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<TimelineMaterializationSnapshot | null> {
    const snapshot = await this.loadRecoveryCandidate(error, signal)
    const expectedSourceRevisionId = this.options.sourceRevisionId
    if (!snapshot || !expectedSourceRevisionId
      || snapshot.timelineDocument.sourceRevisionId !== expectedSourceRevisionId
      || snapshot.revision.sourceRevisionId !== expectedSourceRevisionId) return null

    const priorRevisionId = priorSnapshot?.revision.id ?? null
    const isNoopReconcile = operation === 'reconcile'
      && snapshot.revision.id === priorRevisionId
    if (!isNoopReconcile && snapshot.revision.parentRevisionId !== priorRevisionId) return null

    this.adopt(snapshot)
    return {
      ...cloneSnapshot(snapshot),
      created: operation === 'materialize',
      report: {
        operation,
        sourceRevisionId: expectedSourceRevisionId,
        previousSourceRevisionId: priorSnapshot?.timelineDocument.sourceRevisionId ?? null,
        changed: snapshot.revision.id !== priorRevisionId,
        preservedElementIds: [],
        appendedShots: [],
        orphanedElements: [],
        preservedAbsentShots: [],
        unresolvedShots: [],
      },
    }
  }
}
