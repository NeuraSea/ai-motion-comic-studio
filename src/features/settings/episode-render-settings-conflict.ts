import type { EpisodeSummary, StoryDocument } from '../../lib/api-types'

export const EPISODE_RENDER_ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const

export type EpisodeRenderAspectRatio = typeof EPISODE_RENDER_ASPECT_RATIOS[number]

export type EpisodeRenderSettings = {
  stylePreset: string
  aspectRatio: EpisodeRenderAspectRatio
}

export type EpisodeRenderSettingsScope = {
  projectId: string
  episodeId: string
}

export type EpisodeRenderSettingsAuthority = {
  episode: EpisodeSummary
  etag: string
}

export type EpisodeRenderSettingsAuthorityBundle = EpisodeRenderSettingsAuthority & {
  revisionId: string | null
  story: StoryDocument | null
}

export type EpisodeRenderSettingsStoryAuthority = {
  episodeId: string
  revisionId: string | null
  story: StoryDocument
  etag: string
}

export type EpisodeRenderSettingsConflictAction = 'adopt-server' | 'reapply-local'

export type EpisodeRenderSettingsConflictPhase =
  | 'refreshing'
  | 'ready'
  | 'adopting'
  | 'reapplying'

export type EpisodeRenderSettingsConflict = {
  conflictId: number
  resolutionId: number
  scope: EpisodeRenderSettingsScope
  localIntent: EpisodeRenderSettings
  /** Immutable client base used to detect whether render outputs really changed. */
  baseSnapshot: EpisodeRenderSettings
  serverSnapshot: EpisodeRenderSettings
  serverEtag: string
  serverVerified: boolean
  phase: EpisodeRenderSettingsConflictPhase
  error: string
}

export type EpisodeRenderSettingsResolutionToken = {
  conflictId: number
  resolutionId: number
  action: EpisodeRenderSettingsConflictAction
}

type ConflictResolutionStart = {
  state: EpisodeRenderSettingsConflict
  token: EpisodeRenderSettingsResolutionToken | null
}

type EpisodeRenderSettingsTransport<
  TAuthority extends EpisodeRenderSettingsAuthority = EpisodeRenderSettingsAuthority,
> = {
  load: (scope: EpisodeRenderSettingsScope) => Promise<TAuthority>
  save: (
    scope: EpisodeRenderSettingsScope,
    intent: EpisodeRenderSettings,
    authoritativeEtag: string,
  ) => Promise<EpisodeRenderSettingsAuthority>
}

function isAspectRatio(value: string): value is EpisodeRenderAspectRatio {
  return EPISODE_RENDER_ASPECT_RATIOS.includes(value as EpisodeRenderAspectRatio)
}

function requireScope(scope: EpisodeRenderSettingsScope): EpisodeRenderSettingsScope {
  const projectId = scope.projectId.trim()
  const episodeId = scope.episodeId.trim()
  if (!projectId || !episodeId) throw new Error('Render settings scope is required')
  return { projectId, episodeId }
}

export function normalizeEpisodeRenderSettings(
  value: { stylePreset: string; aspectRatio: string },
): EpisodeRenderSettings {
  const stylePreset = value.stylePreset.trim()
  if (!stylePreset) throw new Error('Render style is required')
  if (!isAspectRatio(value.aspectRatio)) throw new Error('Render aspect ratio is invalid')
  return { stylePreset, aspectRatio: value.aspectRatio }
}

export function episodeRenderSettingsFromEpisode(episode: EpisodeSummary): EpisodeRenderSettings {
  return normalizeEpisodeRenderSettings(episode)
}

export function sameEpisodeRenderSettings(
  left: EpisodeRenderSettings,
  right: EpisodeRenderSettings,
): boolean {
  return left.stylePreset === right.stylePreset && left.aspectRatio === right.aspectRatio
}

export function createEpisodeRenderSettingsConflict(input: {
  conflictId: number
  scope: EpisodeRenderSettingsScope
  localIntent: EpisodeRenderSettings
  lastKnownServer: EpisodeRenderSettings
  lastKnownEtag: string
}): EpisodeRenderSettingsConflict {
  if (!Number.isSafeInteger(input.conflictId) || input.conflictId < 1) {
    throw new Error('Conflict id must be a positive safe integer')
  }
  return {
    conflictId: input.conflictId,
    resolutionId: 0,
    scope: requireScope(input.scope),
    localIntent: normalizeEpisodeRenderSettings(input.localIntent),
    baseSnapshot: normalizeEpisodeRenderSettings(input.lastKnownServer),
    serverSnapshot: normalizeEpisodeRenderSettings(input.lastKnownServer),
    serverEtag: input.lastKnownEtag.trim(),
    serverVerified: false,
    phase: 'refreshing',
    error: '',
  }
}

export function withEpisodeRenderSettingsIntent(
  state: EpisodeRenderSettingsConflict,
  localIntent: EpisodeRenderSettings,
): EpisodeRenderSettingsConflict {
  return { ...state, localIntent: normalizeEpisodeRenderSettings(localIntent) }
}

export function assertEpisodeRenderSettingsAuthority<
  TAuthority extends EpisodeRenderSettingsAuthority,
>(
  scope: EpisodeRenderSettingsScope,
  authority: TAuthority,
): TAuthority {
  const expected = requireScope(scope)
  if (
    authority.episode.id !== expected.episodeId
    || authority.episode.projectId !== expected.projectId
  ) {
    throw new Error('Render settings authority does not belong to the active episode')
  }
  if (!authority.etag.trim()) throw new Error('Render settings authority has no ETag')
  episodeRenderSettingsFromEpisode(authority.episode)
  return authority
}

export function withEpisodeRenderSettingsAuthority(
  state: EpisodeRenderSettingsConflict,
  authority: EpisodeRenderSettingsAuthority,
): EpisodeRenderSettingsConflict {
  assertEpisodeRenderSettingsAuthority(state.scope, authority)
  return {
    ...state,
    serverSnapshot: episodeRenderSettingsFromEpisode(authority.episode),
    serverEtag: authority.etag,
    serverVerified: true,
    error: '',
  }
}

export function makeEpisodeRenderSettingsConflictReady(
  state: EpisodeRenderSettingsConflict,
  error = '',
): EpisodeRenderSettingsConflict {
  return { ...state, phase: 'ready', error }
}

export function beginEpisodeRenderSettingsResolution(
  state: EpisodeRenderSettingsConflict,
  action: EpisodeRenderSettingsConflictAction,
): ConflictResolutionStart {
  if (state.phase !== 'ready') return { state, token: null }
  const resolutionId = state.resolutionId + 1
  const token = { conflictId: state.conflictId, resolutionId, action }
  return {
    state: {
      ...state,
      resolutionId,
      phase: action === 'adopt-server' ? 'adopting' : 'reapplying',
      error: '',
    },
    token,
  }
}

export function isEpisodeRenderSettingsResolutionCurrent(
  state: EpisodeRenderSettingsConflict | null,
  token: EpisodeRenderSettingsResolutionToken,
): boolean {
  return Boolean(
    state
    && state.conflictId === token.conflictId
    && state.resolutionId === token.resolutionId
    && state.phase === (token.action === 'adopt-server' ? 'adopting' : 'reapplying'),
  )
}

export async function loadEpisodeRenderSettingsAuthority<
  TAuthority extends EpisodeRenderSettingsAuthority,
>(
  scope: EpisodeRenderSettingsScope,
  load: EpisodeRenderSettingsTransport<TAuthority>['load'],
): Promise<TAuthority> {
  const normalizedScope = requireScope(scope)
  return assertEpisodeRenderSettingsAuthority(normalizedScope, await load(normalizedScope))
}

/**
 * Reads Episode + Story as one client authority bundle. The public API exposes
 * them through separate resources, so the Episode is read both before and
 * after Story and every opaque ETag/revision binding must agree. A concurrent
 * mutation causes a bounded retry rather than a mixed "old Story + new ETag"
 * state that could defeat the next optimistic write.
 */
export async function loadConsistentEpisodeRenderSettingsAuthority(input: {
  scope: EpisodeRenderSettingsScope
  loadEpisode: (scope: EpisodeRenderSettingsScope) => Promise<
    EpisodeRenderSettingsAuthority & { revisionId: string | null }
  >
  loadStory: (scope: EpisodeRenderSettingsScope) => Promise<
    EpisodeRenderSettingsStoryAuthority | null
  >
  maxAttempts?: number
}): Promise<EpisodeRenderSettingsAuthorityBundle> {
  const scope = requireScope(input.scope)
  const maxAttempts = input.maxAttempts ?? 3
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('Render settings authority retry count is invalid')
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = assertEpisodeRenderSettingsAuthority(scope, await input.loadEpisode(scope))
    if (before.revisionId !== before.episode.sourceRevisionId) {
      throw new Error('Episode authority revision does not match its source revision')
    }
    const story = before.revisionId === null ? null : await input.loadStory(scope)
    const after = assertEpisodeRenderSettingsAuthority(scope, await input.loadEpisode(scope))
    if (after.revisionId !== after.episode.sourceRevisionId) {
      throw new Error('Episode authority revision does not match its source revision')
    }

    if (before.etag !== after.etag || before.revisionId !== after.revisionId) continue
    if (after.revisionId === null) {
      if (story !== null) continue
      return { ...after, story: null }
    }
    if (story === null) {
      throw new Error('Authoritative Episode references a Story revision that cannot be read')
    }
    if (story.episodeId !== scope.episodeId
      || story.etag !== after.etag
      || story.revisionId !== after.revisionId) {
      continue
    }
    return { ...after, story: story.story }
  }

  throw new Error('Episode authority changed repeatedly while resolving the conflict')
}

/**
 * Conflict reapplication is intentionally a two-step operation: it always
 * reads the authoritative Episode first and sends that exact opaque ETag to
 * the explicit save. It never retries a stale write or performs LWW merging.
 */
export async function reapplyEpisodeRenderSettingsAfterRefresh<
  TAuthority extends EpisodeRenderSettingsAuthority = EpisodeRenderSettingsAuthority,
>(input: {
  scope: EpisodeRenderSettingsScope
  localIntent: EpisodeRenderSettings
  transport: EpisodeRenderSettingsTransport<TAuthority>
}): Promise<{
  refreshed: TAuthority
  saved: EpisodeRenderSettingsAuthority
}> {
  const scope = requireScope(input.scope)
  const intent = normalizeEpisodeRenderSettings(input.localIntent)
  const refreshed = await loadEpisodeRenderSettingsAuthority(scope, input.transport.load)
  const saved = assertEpisodeRenderSettingsAuthority(
    scope,
    await input.transport.save(scope, intent, refreshed.etag),
  )
  if (!sameEpisodeRenderSettings(episodeRenderSettingsFromEpisode(saved.episode), intent)) {
    throw new Error('Render settings save did not persist the requested intent')
  }
  return { refreshed, saved }
}
