import type { ManjuDatabase } from './database.js'

export const SHOT_VIDEO_DURATION_DECISION_VERSION = 1 as const
export const SHOT_VIDEO_DURATION_FRAME_RATE = 24 as const
export const SHOT_VIDEO_PROVIDER_MIN_DURATION_SECONDS = 4 as const
export const SHOT_VIDEO_PROVIDER_MAX_DURATION_SECONDS = 15 as const

export type ShotVideoDurationSource =
  | 'speech_assets'
  | 'story_duration'
  | 'manual_override'

export type ShotVideoDurationNotice =
  | 'AUDIO_DRIVEN_TIMELINE'
  | 'PROVIDER_MINIMUM_SOURCE_WILL_BE_TRIMMED'
  | 'MANUAL_DURATION_ADDS_SILENT_TAIL'
  | 'LINE_DURATION_METADATA_DIFFERS_FROM_ASSET'
  | 'STORY_DURATION_USED_WITHOUT_SPEECH'

export interface ShotVideoSpeechDurationBinding {
  dialogueLineId: string
  assetId: string
  version: number
  checksum: string
  durationSeconds: number
  durationFrames: number
}

/**
 * Immutable timing authority fixed before a billable Seedance request.
 *
 * `providerDurationSeconds` is the integer 4-15 value sent to Seedance.
 * `timelineDurationSeconds` is the frame-aligned edit point consumed by the
 * OpenCut materializer. They intentionally differ for speech shorter than the
 * Provider minimum: the generated source is trimmed, never speed-stretched.
 */
export interface ShotVideoDurationDecision {
  version: typeof SHOT_VIDEO_DURATION_DECISION_VERSION
  source: ShotVideoDurationSource
  frameRate: typeof SHOT_VIDEO_DURATION_FRAME_RATE
  plannedDurationSeconds: number
  speechDurationSeconds: number | null
  timelineDurationSeconds: number
  providerDurationSeconds: number
  speechBindings: ShotVideoSpeechDurationBinding[]
  notices: ShotVideoDurationNotice[]
}

export interface ShotVideoDurationTarget {
  databaseShotId: string
  publicShotId: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  durationSeconds: number
}

export type ShotVideoDurationBlockReason =
  | 'SPEECH_ASSET_MISSING'
  | 'SPEECH_ASSET_NOT_READY'
  | 'SPEECH_ASSET_NOT_AUDIO'
  | 'SPEECH_ASSET_SCOPE_MISMATCH'
  | 'SPEECH_ASSET_REVISION_MISMATCH'
  | 'SPEECH_ASSET_IDENTITY_MISSING'
  | 'SPEECH_DURATION_MISSING'
  | 'DUPLICATE_DIALOGUE_LINE_ID'

export interface ShotVideoDurationBlockedLine {
  dialogueLineId: string
  reason: ShotVideoDurationBlockReason
}

export type SpeechAssetBindingBlockReason = Exclude<
  ShotVideoDurationBlockReason,
  'DUPLICATE_DIALOGUE_LINE_ID'
>

export interface SpeechAssetBindingCandidate {
  referencedAssetId: unknown
  assetId: unknown
  projectId: unknown
  episodeId: unknown
  version: unknown
  status: unknown
  mimeType: unknown
  durationSeconds: unknown
  checksum: unknown
  sourceRevisionId: unknown
}

export interface SpeechAssetBindingScope {
  projectId: string
  episodeId: string
  sourceRevisionId: string
}

export type ShotVideoDurationResolution =
  | { status: 'ready'; decision: ShotVideoDurationDecision }
  | {
      status: 'audio_required'
      shotId: string
      blockedLines: ShotVideoDurationBlockedLine[]
    }
  | {
      status: 'requires_shot_split'
      shotId: string
      speechDurationSeconds: number
      maximumProviderDurationSeconds: number
      speechBindings: ShotVideoSpeechDurationBinding[]
    }
  | {
      status: 'manual_duration_too_short'
      shotId: string
      requestedDurationSeconds: number
      speechDurationSeconds: number
    }

interface DurationRow {
  public_line_id?: unknown
  speech_asset_id?: unknown
  line_duration_seconds?: unknown
  media_asset_id?: unknown
  media_project_id?: unknown
  media_episode_id?: unknown
  media_version?: unknown
  media_status?: unknown
  media_mime_type?: unknown
  media_duration_seconds?: unknown
  media_checksum?: unknown
  media_source_revision_id?: unknown
}

function nearestFramesForSeconds(seconds: number): number {
  return Math.max(1, Math.round(seconds * SHOT_VIDEO_DURATION_FRAME_RATE))
}

function coveringFramesForSeconds(seconds: number): number {
  return Math.max(1, Math.ceil(seconds * SHOT_VIDEO_DURATION_FRAME_RATE))
}

function secondsForFrames(frames: number): number {
  return frames / SHOT_VIDEO_DURATION_FRAME_RATE
}

function providerDurationForTimeline(timelineDurationSeconds: number): number {
  return Math.max(
    SHOT_VIDEO_PROVIDER_MIN_DURATION_SECONDS,
    Math.ceil(timelineDurationSeconds),
  )
}

function storyProviderDuration(durationSeconds: number): number {
  return Math.max(
    SHOT_VIDEO_PROVIDER_MIN_DURATION_SECONDS,
    Math.min(SHOT_VIDEO_PROVIDER_MAX_DURATION_SECONDS, Math.ceil(durationSeconds)),
  )
}

function publicLineId(row: DurationRow): string | null {
  return typeof row.public_line_id === 'string' && row.public_line_id.trim()
    ? row.public_line_id
    : null
}

/** Shared fail-closed authority used by video timing and OpenCut materialization. */
export function speechAssetBindingBlockReason(
  candidate: SpeechAssetBindingCandidate,
  scope: SpeechAssetBindingScope,
): SpeechAssetBindingBlockReason | null {
  if (typeof candidate.referencedAssetId !== 'string' || !candidate.referencedAssetId) {
    return 'SPEECH_ASSET_MISSING'
  }
  if (typeof candidate.assetId !== 'string'
    || candidate.assetId !== candidate.referencedAssetId) {
    return 'SPEECH_ASSET_MISSING'
  }
  if (candidate.status !== 'ready') return 'SPEECH_ASSET_NOT_READY'
  const mimeType = typeof candidate.mimeType === 'string'
    ? candidate.mimeType.split(';', 1)[0]!.trim().toLowerCase()
    : null
  if (mimeType !== 'audio/mpeg' && mimeType !== 'audio/wav') {
    return 'SPEECH_ASSET_NOT_AUDIO'
  }
  if (candidate.projectId !== scope.projectId || candidate.episodeId !== scope.episodeId) {
    return 'SPEECH_ASSET_SCOPE_MISMATCH'
  }
  if (candidate.sourceRevisionId !== scope.sourceRevisionId) {
    return 'SPEECH_ASSET_REVISION_MISMATCH'
  }
  if (!Number.isInteger(candidate.version)
    || (candidate.version as number) < 1
    || typeof candidate.checksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(candidate.checksum)) {
    return 'SPEECH_ASSET_IDENTITY_MISSING'
  }
  if (typeof candidate.durationSeconds !== 'number'
    || !Number.isFinite(candidate.durationSeconds)
    || candidate.durationSeconds <= 0
    || candidate.durationSeconds > 3_600) {
    return 'SPEECH_DURATION_MISSING'
  }
  return null
}

function blockedReason(
  row: DurationRow,
  target: ShotVideoDurationTarget,
): SpeechAssetBindingBlockReason | null {
  return speechAssetBindingBlockReason({
    referencedAssetId: row.speech_asset_id,
    assetId: row.media_asset_id,
    projectId: row.media_project_id,
    episodeId: row.media_episode_id,
    version: row.media_version,
    status: row.media_status,
    mimeType: row.media_mime_type,
    durationSeconds: row.media_duration_seconds,
    checksum: row.media_checksum,
    sourceRevisionId: row.media_source_revision_id,
  }, target)
}

function durationRows(
  database: ManjuDatabase,
  target: ShotVideoDurationTarget,
): DurationRow[] {
  return database.withSql((sql) => sql.all(`
    SELECT
      CASE
        WHEN typeof(json_extract(dialogue_lines.metadata_json, '$.storyId')) = 'text'
          AND length(trim(json_extract(dialogue_lines.metadata_json, '$.storyId'))) > 0
        THEN json_extract(dialogue_lines.metadata_json, '$.storyId')
        ELSE dialogue_lines.id
      END AS public_line_id,
      dialogue_lines.speech_asset_id,
      dialogue_lines.duration_seconds AS line_duration_seconds,
      speech.id AS media_asset_id,
      speech.project_id AS media_project_id,
      speech.episode_id AS media_episode_id,
      speech.version AS media_version,
      speech.status AS media_status,
      speech.mime_type AS media_mime_type,
      speech.duration_seconds AS media_duration_seconds,
      speech.checksum AS media_checksum,
      speech.source_revision_id AS media_source_revision_id
    FROM dialogue_lines
    JOIN shots ON shots.id = dialogue_lines.shot_id
    JOIN scenes ON scenes.id = shots.scene_id
    JOIN episodes ON episodes.id = scenes.episode_id
    LEFT JOIN media_assets AS speech ON speech.id = dialogue_lines.speech_asset_id
    WHERE shots.id = ?
      AND episodes.id = ?
      AND episodes.project_id = ?
    ORDER BY dialogue_lines.sequence, dialogue_lines.id
  `, target.databaseShotId, target.episodeId, target.projectId)) as DurationRow[]
}

/**
 * Resolve the authoritative edit duration without invoking a Provider.
 * Any shot containing spoken lines requires every real speech Asset first.
 */
export function resolveShotVideoDuration(
  database: ManjuDatabase,
  target: ShotVideoDurationTarget,
  options: { manualProviderDurationSeconds?: number } = {},
): ShotVideoDurationResolution {
  if (!Number.isFinite(target.durationSeconds) || target.durationSeconds < 0) {
    throw new TypeError('Shot planned duration must be a finite non-negative number')
  }
  if (options.manualProviderDurationSeconds !== undefined
    && (!Number.isInteger(options.manualProviderDurationSeconds)
      || options.manualProviderDurationSeconds < SHOT_VIDEO_PROVIDER_MIN_DURATION_SECONDS
      || options.manualProviderDurationSeconds > SHOT_VIDEO_PROVIDER_MAX_DURATION_SECONDS)) {
    throw new TypeError('Manual Provider duration must be an integer from 4 through 15')
  }
  const rows = durationRows(database, target)
  if (rows.length === 0) {
    const providerDurationSeconds = options.manualProviderDurationSeconds
      ?? storyProviderDuration(target.durationSeconds)
    return {
      status: 'ready',
      decision: {
        version: SHOT_VIDEO_DURATION_DECISION_VERSION,
        source: options.manualProviderDurationSeconds === undefined
          ? 'story_duration'
          : 'manual_override',
        frameRate: SHOT_VIDEO_DURATION_FRAME_RATE,
        plannedDurationSeconds: target.durationSeconds,
        speechDurationSeconds: null,
        timelineDurationSeconds: options.manualProviderDurationSeconds
          ?? secondsForFrames(nearestFramesForSeconds(target.durationSeconds)),
        providerDurationSeconds,
        speechBindings: [],
        notices: options.manualProviderDurationSeconds === undefined
          ? ['STORY_DURATION_USED_WITHOUT_SPEECH']
          : [],
      },
    }
  }

  const seenLineIds = new Set<string>()
  const blockedLines: ShotVideoDurationBlockedLine[] = []
  for (const row of rows) {
    const dialogueLineId = publicLineId(row)
    if (!dialogueLineId || seenLineIds.has(dialogueLineId)) {
      blockedLines.push({
        dialogueLineId: dialogueLineId ?? '(unknown)',
        reason: 'DUPLICATE_DIALOGUE_LINE_ID',
      })
      continue
    }
    seenLineIds.add(dialogueLineId)
    const reason = blockedReason(row, target)
    if (reason) blockedLines.push({ dialogueLineId, reason })
  }
  if (blockedLines.length > 0) {
    return {
      status: 'audio_required',
      shotId: target.publicShotId,
      blockedLines,
    }
  }

  const speechBindings = rows.map((row): ShotVideoSpeechDurationBinding => {
    const durationSeconds = row.media_duration_seconds as number
    return {
      dialogueLineId: row.public_line_id as string,
      assetId: row.media_asset_id as string,
      version: row.media_version as number,
      checksum: row.media_checksum as string,
      durationSeconds,
      // A media duration is a lower bound on the interval that must remain
      // audible. Round outward so frame quantization can add silence but can
      // never cut the final samples from a paid speech Asset.
      durationFrames: coveringFramesForSeconds(durationSeconds),
    }
  })
  const speechFrames = speechBindings.reduce((total, binding) => total + binding.durationFrames, 0)
  const speechDurationSeconds = secondsForFrames(speechFrames)
  if (speechFrames > SHOT_VIDEO_PROVIDER_MAX_DURATION_SECONDS * SHOT_VIDEO_DURATION_FRAME_RATE) {
    return {
      status: 'requires_shot_split',
      shotId: target.publicShotId,
      speechDurationSeconds,
      maximumProviderDurationSeconds: SHOT_VIDEO_PROVIDER_MAX_DURATION_SECONDS,
      speechBindings,
    }
  }
  if (options.manualProviderDurationSeconds !== undefined
    && options.manualProviderDurationSeconds * SHOT_VIDEO_DURATION_FRAME_RATE < speechFrames) {
    return {
      status: 'manual_duration_too_short',
      shotId: target.publicShotId,
      requestedDurationSeconds: options.manualProviderDurationSeconds,
      speechDurationSeconds,
    }
  }

  const providerDurationSeconds = options.manualProviderDurationSeconds
    ?? providerDurationForTimeline(speechDurationSeconds)
  const notices: ShotVideoDurationNotice[] = ['AUDIO_DRIVEN_TIMELINE']
  if (providerDurationSeconds > speechDurationSeconds) {
    notices.push(options.manualProviderDurationSeconds === undefined
      ? 'PROVIDER_MINIMUM_SOURCE_WILL_BE_TRIMMED'
      : 'MANUAL_DURATION_ADDS_SILENT_TAIL')
  }
  if (rows.some((row) => typeof row.line_duration_seconds === 'number'
    && Number.isFinite(row.line_duration_seconds)
    && Math.abs((row.line_duration_seconds as number) - (row.media_duration_seconds as number))
      > 1 / SHOT_VIDEO_DURATION_FRAME_RATE)) {
    notices.push('LINE_DURATION_METADATA_DIFFERS_FROM_ASSET')
  }
  return {
    status: 'ready',
    decision: {
      version: SHOT_VIDEO_DURATION_DECISION_VERSION,
      source: options.manualProviderDurationSeconds === undefined
        ? 'speech_assets'
        : 'manual_override',
      frameRate: SHOT_VIDEO_DURATION_FRAME_RATE,
      plannedDurationSeconds: target.durationSeconds,
      speechDurationSeconds,
      timelineDurationSeconds: options.manualProviderDurationSeconds ?? speechDurationSeconds,
      providerDurationSeconds,
      speechBindings,
      notices,
    },
  }
}

export function isShotVideoDurationDecision(value: unknown): value is ShotVideoDurationDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const decision = value as Partial<ShotVideoDurationDecision>
  const keys = Object.keys(value)
  if (keys.some((key) => ![
    'version',
    'source',
    'frameRate',
    'plannedDurationSeconds',
    'speechDurationSeconds',
    'timelineDurationSeconds',
    'providerDurationSeconds',
    'speechBindings',
    'notices',
  ].includes(key))) return false
  if (decision.version !== SHOT_VIDEO_DURATION_DECISION_VERSION
    || !['speech_assets', 'story_duration', 'manual_override'].includes(String(decision.source))
    || decision.frameRate !== SHOT_VIDEO_DURATION_FRAME_RATE
    || typeof decision.plannedDurationSeconds !== 'number'
    || !Number.isFinite(decision.plannedDurationSeconds)
    || decision.plannedDurationSeconds < 0
    || (decision.speechDurationSeconds !== null
      && (typeof decision.speechDurationSeconds !== 'number'
        || !Number.isFinite(decision.speechDurationSeconds)
        || decision.speechDurationSeconds <= 0))
    || typeof decision.timelineDurationSeconds !== 'number'
    || !Number.isFinite(decision.timelineDurationSeconds)
    || decision.timelineDurationSeconds <= 0
    || !Number.isInteger(decision.providerDurationSeconds)
    || (decision.providerDurationSeconds as number) < SHOT_VIDEO_PROVIDER_MIN_DURATION_SECONDS
    || (decision.providerDurationSeconds as number) > SHOT_VIDEO_PROVIDER_MAX_DURATION_SECONDS
    || !Array.isArray(decision.speechBindings)
    || !Array.isArray(decision.notices)
    || decision.notices.some((notice) => ![
      'AUDIO_DRIVEN_TIMELINE',
      'PROVIDER_MINIMUM_SOURCE_WILL_BE_TRIMMED',
      'MANUAL_DURATION_ADDS_SILENT_TAIL',
      'LINE_DURATION_METADATA_DIFFERS_FROM_ASSET',
      'STORY_DURATION_USED_WITHOUT_SPEECH',
    ].includes(String(notice)))) return false
  const bindings = decision.speechBindings as unknown[]
  if (bindings.some((binding) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return true
    const item = binding as Partial<ShotVideoSpeechDurationBinding>
    return Object.keys(binding).some((key) => ![
      'dialogueLineId', 'assetId', 'version', 'checksum', 'durationSeconds', 'durationFrames',
    ].includes(key))
      || typeof item.dialogueLineId !== 'string'
      || !item.dialogueLineId
      || typeof item.assetId !== 'string'
      || !item.assetId
      || !Number.isInteger(item.version)
      || (item.version as number) < 1
      || typeof item.checksum !== 'string'
      || !/^[a-f0-9]{64}$/.test(item.checksum)
      || typeof item.durationSeconds !== 'number'
      || !Number.isFinite(item.durationSeconds)
      || item.durationSeconds <= 0
      || !Number.isInteger(item.durationFrames)
      || (item.durationFrames as number) < 1
      || item.durationFrames !== coveringFramesForSeconds(item.durationSeconds)
  })) return false
  if (decision.source === 'story_duration') {
    return decision.speechDurationSeconds === null
      && bindings.length === 0
      && Math.abs(decision.timelineDurationSeconds * SHOT_VIDEO_DURATION_FRAME_RATE
        - Math.round(decision.timelineDurationSeconds * SHOT_VIDEO_DURATION_FRAME_RATE)) < 1e-9
  }
  if (decision.speechDurationSeconds === null) {
    return decision.source === 'manual_override'
      && bindings.length === 0
      && decision.timelineDurationSeconds === decision.providerDurationSeconds
  }
  const totalFrames = (bindings as ShotVideoSpeechDurationBinding[])
    .reduce((sum, binding) => sum + binding.durationFrames, 0)
  if (totalFrames <= 0
    || Math.abs(secondsForFrames(totalFrames) - decision.speechDurationSeconds) >= 1e-9) return false
  if (decision.source === 'speech_assets') {
    return decision.timelineDurationSeconds === decision.speechDurationSeconds
      && decision.providerDurationSeconds === providerDurationForTimeline(decision.speechDurationSeconds)
  }
  return decision.timelineDurationSeconds === decision.providerDurationSeconds
    && decision.providerDurationSeconds * SHOT_VIDEO_DURATION_FRAME_RATE >= totalFrames
}

/** Recompute from current DB state; exact equality protects paid submission from audio drift. */
export function shotVideoDurationDecisionIsCurrent(
  database: ManjuDatabase,
  target: ShotVideoDurationTarget,
  decision: ShotVideoDurationDecision,
): boolean {
  if (!isShotVideoDurationDecision(decision)) return false
  const result = resolveShotVideoDuration(database, target, {
    ...(decision.source === 'manual_override'
      ? { manualProviderDurationSeconds: decision.providerDurationSeconds }
      : {}),
  })
  return result.status === 'ready'
    && JSON.stringify(result.decision) === JSON.stringify(decision)
}
