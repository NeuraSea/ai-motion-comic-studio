export const OFFLINE_STORY_DRAFT_SCHEMA = 'manju.offline-story-draft'
export const OFFLINE_STORY_DRAFT_VERSION = 1
export const MAX_OFFLINE_STORY_DRAFT_BYTES = 256 * 1024

const STORAGE_PREFIX = 'manju.story-draft.v1'
const INDEX_STORAGE_PREFIX = 'manju.story-draft-index.v1'
const OFFLINE_STORY_DRAFT_INDEX_SCHEMA = 'manju.offline-story-draft-index'
const OFFLINE_STORY_DRAFT_INDEX_VERSION = 1
const MAX_IDENTIFIER_LENGTH = 200
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const MAX_DRAFT_ENTRIES = 2_000
const MAX_INDEX_ENTRIES = 32

export interface OfflineStoryDraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** Browser localStorage supports these; tests and non-browser stores may omit them. */
  readonly length?: number
  key?(index: number): string | null
}

export interface OfflineStoryDraftScope {
  projectId: string
  episodeId: string
  baseSourceRevisionId: string
}

export type OfflineStoryDraftEpisodeScope = Pick<OfflineStoryDraftScope, 'projectId' | 'episodeId'>

export interface OfflineStorySceneDraft {
  sceneId: string
  patch: {
    title?: string
    locationId?: string
    timeOfDay?: string
    description?: string
  }
}

export interface OfflineStoryDialogueLineDraft {
  sceneId: string
  shotId: string
  lineId: string
  text: string
}

export interface OfflineStoryShotDraft {
  sceneId: string
  shotId: string
  patch: {
    code?: string
    title?: string
    description?: string
    framing?: string
    movement?: string
    transition?: string
    durationSeconds?: number
    visualPrompt?: string
  }
}

/**
 * Deliberately excludes complete Story objects, generated assets, Provider
 * bindings and credentials. Only fields that can be edited in the Story UI
 * belong in this DTO.
 */
export interface OfflineStoryDraftChanges {
  scenes: OfflineStorySceneDraft[]
  dialogueLines: OfflineStoryDialogueLineDraft[]
  shots: OfflineStoryShotDraft[]
}

export interface OfflineStoryDraft {
  schema: typeof OFFLINE_STORY_DRAFT_SCHEMA
  version: typeof OFFLINE_STORY_DRAFT_VERSION
  scope: OfflineStoryDraftScope
  savedAt: string
  drafts: OfflineStoryDraftChanges
}

export type OfflineStoryDraftLoadResult =
  | { status: 'missing'; key: string }
  | { status: 'loaded'; key: string; byteLength: number; draft: OfflineStoryDraft }
  | {
      status: 'invalid'
      key: string
      reason: 'oversized' | 'malformed-json' | 'invalid-schema' | 'scope-mismatch'
    }
  | { status: 'unavailable'; key: string }

export type OfflineStoryDraftSaveResult =
  | { status: 'saved'; key: string; byteLength: number; draft: OfflineStoryDraft }
  | { status: 'rejected'; key: string; reason: 'invalid-schema' | 'oversized' }
  | { status: 'unavailable'; key: string }

export type OfflineStoryDraftClearResult =
  | { status: 'cleared'; key: string }
  | { status: 'unavailable'; key: string }

export type OfflineStoryDraftEpisodeLoadResult =
  | { status: 'missing'; key: string }
  | { status: 'loaded'; key: string; byteLength: number; draft: OfflineStoryDraft }
  | {
      status: 'invalid'
      key: string
      reason: 'oversized' | 'malformed-json' | 'invalid-schema' | 'scope-mismatch'
    }
  | { status: 'unavailable'; key: string }

export type OfflineStoryDraftRecoveryDecision =
  | { kind: 'none' }
  | {
      kind: 'restore-same-base'
      draft: OfflineStoryDraft
      autoApply: true
    }
  | {
      kind: 'authoritative-source-changed'
      draft: OfflineStoryDraft
      autoApply: false
      /** No merge/apply action is intentionally available across revisions. */
      allowedActions: readonly ['discard', 'copy-as-text']
    }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_IDENTIFIER_LENGTH
    && IDENTIFIER_PATTERN.test(value)
}

function isDraftText(value: unknown, maximum: number): value is string {
  // Empty values are valid while a form is in progress. The authoritative
  // mutation endpoint remains responsible for commit-time domain validation.
  return typeof value === 'string' && value.length <= maximum
}

function isScope(value: unknown): value is OfflineStoryDraftScope {
  return isPlainRecord(value)
    && hasExactKeys(value, ['projectId', 'episodeId', 'baseSourceRevisionId'])
    && isIdentifier(value.projectId)
    && isIdentifier(value.episodeId)
    && isIdentifier(value.baseSourceRevisionId)
}

function isEpisodeScope(value: unknown): value is OfflineStoryDraftEpisodeScope {
  return isPlainRecord(value)
    && hasExactKeys(value, ['projectId', 'episodeId'])
    && isIdentifier(value.projectId)
    && isIdentifier(value.episodeId)
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function hasAtLeastOneKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

function isSceneDraft(value: unknown): value is OfflineStorySceneDraft {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['sceneId', 'patch'])) return false
  if (!isIdentifier(value.sceneId) || !isPlainRecord(value.patch)) return false
  if (!hasExactKeys(value.patch, [], ['title', 'locationId', 'timeOfDay', 'description'])) return false
  if (!hasAtLeastOneKey(value.patch)) return false
  return (value.patch.title === undefined || isDraftText(value.patch.title, 200))
    && (value.patch.locationId === undefined || isDraftText(value.patch.locationId, 2_000))
    && (value.patch.timeOfDay === undefined || isDraftText(value.patch.timeOfDay, 2_000))
    && (value.patch.description === undefined || isDraftText(value.patch.description, 2_000))
}

function isDialogueLineDraft(value: unknown): value is OfflineStoryDialogueLineDraft {
  return isPlainRecord(value)
    && hasExactKeys(value, ['sceneId', 'shotId', 'lineId', 'text'])
    && isIdentifier(value.sceneId)
    && isIdentifier(value.shotId)
    && isIdentifier(value.lineId)
    && isDraftText(value.text, 1_000)
}

function isShotDraft(value: unknown): value is OfflineStoryShotDraft {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['sceneId', 'shotId', 'patch'])) return false
  if (!isIdentifier(value.sceneId) || !isIdentifier(value.shotId) || !isPlainRecord(value.patch)) {
    return false
  }
  if (!hasExactKeys(value.patch, [], [
    'code',
    'title',
    'description',
    'framing',
    'movement',
    'transition',
    'durationSeconds',
    'visualPrompt',
  ])) return false
  if (!hasAtLeastOneKey(value.patch)) return false
  return (value.patch.code === undefined || isDraftText(value.patch.code, 2_000))
    && (value.patch.title === undefined || isDraftText(value.patch.title, 2_000))
    && (value.patch.description === undefined || isDraftText(value.patch.description, 2_000))
    && (value.patch.framing === undefined || isDraftText(value.patch.framing, 2_000))
    && (value.patch.movement === undefined || isDraftText(value.patch.movement, 2_000))
    && (value.patch.transition === undefined || isDraftText(value.patch.transition, 2_000))
    && (
      value.patch.durationSeconds === undefined
      || (
        typeof value.patch.durationSeconds === 'number'
        && Number.isFinite(value.patch.durationSeconds)
        && value.patch.durationSeconds >= 0.5
        && value.patch.durationSeconds <= 15
      )
    )
    && (value.patch.visualPrompt === undefined || isDraftText(value.patch.visualPrompt, 4_000))
}

function entriesAreUnique<T>(entries: readonly T[], key: (entry: T) => string): boolean {
  const seen = new Set<string>()
  for (const entry of entries) {
    const identity = key(entry)
    if (seen.has(identity)) return false
    seen.add(identity)
  }
  return true
}

function isDraftChanges(value: unknown): value is OfflineStoryDraftChanges {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['scenes', 'dialogueLines', 'shots'])) return false
  if (!Array.isArray(value.scenes) || !Array.isArray(value.dialogueLines) || !Array.isArray(value.shots)) {
    return false
  }
  const entryCount = value.scenes.length + value.dialogueLines.length + value.shots.length
  if (entryCount === 0 || entryCount > MAX_DRAFT_ENTRIES) return false
  if (!value.scenes.every(isSceneDraft)
    || !value.dialogueLines.every(isDialogueLineDraft)
    || !value.shots.every(isShotDraft)) return false
  return entriesAreUnique(value.scenes, (entry) => entry.sceneId)
    && entriesAreUnique(
      value.dialogueLines,
      (entry) => `${entry.sceneId}\u0000${entry.shotId}\u0000${entry.lineId}`,
    )
    && entriesAreUnique(value.shots, (entry) => `${entry.sceneId}\u0000${entry.shotId}`)
}

function isOfflineStoryDraft(value: unknown): value is OfflineStoryDraft {
  return isPlainRecord(value)
    && hasExactKeys(value, ['schema', 'version', 'scope', 'savedAt', 'drafts'])
    && value.schema === OFFLINE_STORY_DRAFT_SCHEMA
    && value.version === OFFLINE_STORY_DRAFT_VERSION
    && isScope(value.scope)
    && isIsoInstant(value.savedAt)
    && isDraftChanges(value.drafts)
}

function sameScope(left: OfflineStoryDraftScope, right: OfflineStoryDraftScope): boolean {
  return left.projectId === right.projectId
    && left.episodeId === right.episodeId
    && left.baseSourceRevisionId === right.baseSourceRevisionId
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function checkedScope(scope: OfflineStoryDraftScope): OfflineStoryDraftScope {
  if (!isScope(scope)) throw new TypeError('Invalid offline Story draft scope')
  return scope
}

function checkedEpisodeScope(scope: OfflineStoryDraftEpisodeScope): OfflineStoryDraftEpisodeScope {
  if (!isEpisodeScope(scope)) throw new TypeError('Invalid offline Story draft episode scope')
  return scope
}

interface OfflineStoryDraftIndexEntry {
  baseSourceRevisionId: string
  savedAt: string
}

interface OfflineStoryDraftIndex {
  schema: typeof OFFLINE_STORY_DRAFT_INDEX_SCHEMA
  version: typeof OFFLINE_STORY_DRAFT_INDEX_VERSION
  scope: OfflineStoryDraftEpisodeScope
  entries: OfflineStoryDraftIndexEntry[]
}

function offlineStoryDraftIndexStorageKey(scope: OfflineStoryDraftEpisodeScope): string {
  const checked = checkedEpisodeScope(scope)
  return [
    INDEX_STORAGE_PREFIX,
    encodeURIComponent(checked.projectId),
    encodeURIComponent(checked.episodeId),
  ].join(':')
}

function isOfflineStoryDraftIndex(value: unknown): value is OfflineStoryDraftIndex {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['schema', 'version', 'scope', 'entries'])
    || value.schema !== OFFLINE_STORY_DRAFT_INDEX_SCHEMA
    || value.version !== OFFLINE_STORY_DRAFT_INDEX_VERSION
    || !isEpisodeScope(value.scope)
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_INDEX_ENTRIES) return false
  const revisions = new Set<string>()
  return value.entries.every((entry) => {
    if (!isPlainRecord(entry)
      || !hasExactKeys(entry, ['baseSourceRevisionId', 'savedAt'])
      || !isIdentifier(entry.baseSourceRevisionId)
      || !isIsoInstant(entry.savedAt)
      || revisions.has(entry.baseSourceRevisionId)) return false
    revisions.add(entry.baseSourceRevisionId)
    return true
  })
}

function readOfflineStoryDraftIndex(
  storage: OfflineStoryDraftStorage,
  scope: OfflineStoryDraftEpisodeScope,
): OfflineStoryDraftIndex | null {
  const raw = storage.getItem(offlineStoryDraftIndexStorageKey(scope))
  if (raw === null) return null
  const parsed: unknown = JSON.parse(raw)
  if (!isOfflineStoryDraftIndex(parsed)
    || parsed.scope.projectId !== scope.projectId
    || parsed.scope.episodeId !== scope.episodeId) throw new TypeError('Invalid offline Story draft index')
  return parsed
}

function updateOfflineStoryDraftIndex(
  storage: OfflineStoryDraftStorage,
  scope: OfflineStoryDraftScope,
  savedAt: string | null,
): void {
  const episodeScope: OfflineStoryDraftEpisodeScope = {
    projectId: scope.projectId,
    episodeId: scope.episodeId,
  }
  let current: OfflineStoryDraftIndex | null = null
  try {
    current = readOfflineStoryDraftIndex(storage, episodeScope)
  } catch {
    // A damaged metadata-only index must not block saving a valid allowlisted
    // draft. Browser enumeration below can still recover older envelopes.
  }
  const entries = (current?.entries ?? [])
    .filter((entry) => entry.baseSourceRevisionId !== scope.baseSourceRevisionId)
  if (savedAt !== null) entries.unshift({ baseSourceRevisionId: scope.baseSourceRevisionId, savedAt })
  const index: OfflineStoryDraftIndex = {
    schema: OFFLINE_STORY_DRAFT_INDEX_SCHEMA,
    version: OFFLINE_STORY_DRAFT_INDEX_VERSION,
    scope: episodeScope,
    entries: entries
      .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt))
      .slice(0, MAX_INDEX_ENTRIES),
  }
  const key = offlineStoryDraftIndexStorageKey(episodeScope)
  if (index.entries.length === 0) storage.removeItem(key)
  else storage.setItem(key, JSON.stringify(index))
}

export function offlineStoryDraftStorageKey(scope: OfflineStoryDraftScope): string {
  const checked = checkedScope(scope)
  return [
    STORAGE_PREFIX,
    encodeURIComponent(checked.projectId),
    encodeURIComponent(checked.episodeId),
    encodeURIComponent(checked.baseSourceRevisionId),
  ].join(':')
}

export function createOfflineStoryDraft(
  scope: OfflineStoryDraftScope,
  drafts: OfflineStoryDraftChanges,
  savedAt = new Date().toISOString(),
): OfflineStoryDraft {
  return {
    schema: OFFLINE_STORY_DRAFT_SCHEMA,
    version: OFFLINE_STORY_DRAFT_VERSION,
    scope: checkedScope(scope),
    savedAt,
    drafts,
  }
}

/**
 * Writes a complete, strictly validated envelope. Unknown fields fail closed
 * instead of being silently persisted, which prevents credentials or Provider
 * configuration from leaking through an accidentally over-broad snapshot.
 */
export function saveOfflineStoryDraft(
  storage: OfflineStoryDraftStorage,
  scope: OfflineStoryDraftScope,
  drafts: OfflineStoryDraftChanges,
  options: { savedAt?: string } = {},
): OfflineStoryDraftSaveResult {
  const key = offlineStoryDraftStorageKey(scope)
  const candidate = createOfflineStoryDraft(scope, drafts, options.savedAt)
  if (!isOfflineStoryDraft(candidate)) return { status: 'rejected', key, reason: 'invalid-schema' }

  let serialized: string
  let normalizedDraft: OfflineStoryDraft
  try {
    serialized = JSON.stringify(candidate)
    // Re-validate the exact serialized form so custom/inherited toJSON hooks
    // can never broaden what reaches localStorage.
    const serializedValue: unknown = JSON.parse(serialized)
    if (!isOfflineStoryDraft(serializedValue) || !sameScope(serializedValue.scope, scope)) {
      return { status: 'rejected', key, reason: 'invalid-schema' }
    }
    normalizedDraft = serializedValue
  } catch {
    return { status: 'rejected', key, reason: 'invalid-schema' }
  }

  const byteLength = utf8ByteLength(serialized)
  if (byteLength > MAX_OFFLINE_STORY_DRAFT_BYTES) {
    return { status: 'rejected', key, reason: 'oversized' }
  }
  try {
    storage.setItem(key, serialized)
    updateOfflineStoryDraftIndex(storage, scope, normalizedDraft.savedAt)
  } catch {
    return { status: 'unavailable', key }
  }
  return { status: 'saved', key, byteLength, draft: normalizedDraft }
}

export function loadOfflineStoryDraft(
  storage: OfflineStoryDraftStorage,
  scope: OfflineStoryDraftScope,
): OfflineStoryDraftLoadResult {
  const key = offlineStoryDraftStorageKey(scope)
  let serialized: string | null
  try {
    serialized = storage.getItem(key)
  } catch {
    return { status: 'unavailable', key }
  }
  if (serialized === null) return { status: 'missing', key }

  const byteLength = utf8ByteLength(serialized)
  if (byteLength > MAX_OFFLINE_STORY_DRAFT_BYTES) {
    return { status: 'invalid', key, reason: 'oversized' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    return { status: 'invalid', key, reason: 'malformed-json' }
  }
  if (!isOfflineStoryDraft(parsed)) {
    return { status: 'invalid', key, reason: 'invalid-schema' }
  }
  if (!sameScope(parsed.scope, scope)) {
    return { status: 'invalid', key, reason: 'scope-mismatch' }
  }
  return { status: 'loaded', key, byteLength, draft: parsed }
}

export function clearOfflineStoryDraft(
  storage: OfflineStoryDraftStorage,
  scope: OfflineStoryDraftScope,
): OfflineStoryDraftClearResult {
  const key = offlineStoryDraftStorageKey(scope)
  try {
    storage.removeItem(key)
    updateOfflineStoryDraftIndex(storage, scope, null)
  } catch {
    return { status: 'unavailable', key }
  }
  return { status: 'cleared', key }
}

function indexedRevisionIds(
  storage: OfflineStoryDraftStorage,
  scope: OfflineStoryDraftEpisodeScope,
): { revisionIds: string[]; indexInvalid: boolean } {
  let indexInvalid = false
  let revisionIds: string[] = []
  try {
    revisionIds = readOfflineStoryDraftIndex(storage, scope)?.entries
      .map((entry) => entry.baseSourceRevisionId) ?? []
  } catch {
    indexInvalid = true
  }

  // Browser localStorage enumeration is a compatibility path for envelopes
  // written before the index existed and for a damaged metadata-only index.
  if (typeof storage.length === 'number' && typeof storage.key === 'function') {
    const prefix = [
      STORAGE_PREFIX,
      encodeURIComponent(scope.projectId),
      encodeURIComponent(scope.episodeId),
      '',
    ].join(':')
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (!key?.startsWith(prefix)) continue
        const encodedRevision = key.slice(prefix.length)
        if (!encodedRevision) continue
        const revisionId = decodeURIComponent(encodedRevision)
        if (isIdentifier(revisionId)) revisionIds.push(revisionId)
      }
    } catch {
      indexInvalid = true
    }
  }
  return { revisionIds: [...new Set(revisionIds)], indexInvalid }
}

/**
 * Finds the newest strictly valid draft for a project/Episode. The exact
 * current revision is checked first; older revisions are discoverable only so
 * the UI can offer copy-as-text or discard — never cross-revision apply.
 */
export function loadOfflineStoryDraftForEpisode(
  storage: OfflineStoryDraftStorage,
  scope: OfflineStoryDraftScope,
): OfflineStoryDraftEpisodeLoadResult {
  const checked = checkedScope(scope)
  const exact = loadOfflineStoryDraft(storage, checked)
  if (exact.status !== 'missing') return exact

  const episodeScope: OfflineStoryDraftEpisodeScope = {
    projectId: checked.projectId,
    episodeId: checked.episodeId,
  }
  let indexed: ReturnType<typeof indexedRevisionIds>
  try {
    indexed = indexedRevisionIds(storage, episodeScope)
  } catch {
    return { status: 'unavailable', key: offlineStoryDraftIndexStorageKey(episodeScope) }
  }

  let newest: Extract<OfflineStoryDraftLoadResult, { status: 'loaded' }> | null = null
  let firstInvalid: Extract<OfflineStoryDraftLoadResult, { status: 'invalid' }> | null = null
  for (const revisionId of indexed.revisionIds) {
    if (revisionId === checked.baseSourceRevisionId) continue
    const loaded = loadOfflineStoryDraft(storage, {
      ...episodeScope,
      baseSourceRevisionId: revisionId,
    })
    if (loaded.status === 'unavailable') return loaded
    if (loaded.status === 'invalid') {
      firstInvalid ??= loaded
      continue
    }
    if (loaded.status !== 'loaded') continue
    if (newest === null || Date.parse(loaded.draft.savedAt) > Date.parse(newest.draft.savedAt)) {
      newest = loaded
    }
  }
  if (newest) return newest
  if (firstInvalid) return firstInvalid
  if (indexed.indexInvalid) {
    return {
      status: 'invalid',
      key: offlineStoryDraftIndexStorageKey(episodeScope),
      reason: 'invalid-schema',
    }
  }
  return { status: 'missing', key: offlineStoryDraftStorageKey(checked) }
}

/**
 * Pure recovery policy. A draft may be restored only against its exact source
 * revision. Once server authority advances, the UI must offer only discard or
 * copy-as-text; it must never merge or apply the stale fields automatically.
 */
export function decideOfflineStoryDraftRecovery(
  draft: OfflineStoryDraft | null,
  authoritativeSourceRevisionId: string,
): OfflineStoryDraftRecoveryDecision {
  if (draft === null) return { kind: 'none' }
  if (draft.scope.baseSourceRevisionId === authoritativeSourceRevisionId) {
    return { kind: 'restore-same-base', draft, autoApply: true }
  }
  return {
    kind: 'authoritative-source-changed',
    draft,
    autoApply: false,
    allowedActions: ['discard', 'copy-as-text'],
  }
}

/** A safe salvage payload for the explicit cross-revision copy action. */
export function offlineStoryDraftAsText(draft: OfflineStoryDraft): string {
  if (!isOfflineStoryDraft(draft)) throw new TypeError('Invalid offline Story draft')
  return JSON.stringify({
    baseSourceRevisionId: draft.scope.baseSourceRevisionId,
    savedAt: draft.savedAt,
    scenes: draft.drafts.scenes,
    dialogueLines: draft.drafts.dialogueLines,
    shots: draft.drafts.shots,
  }, null, 2)
}
