import { createHash } from 'node:crypto'

import type {
  GenerationJobRecord,
  ManjuDatabase,
  MediaAssetRecord,
} from './database.js'
import { stableAssetIdForVersion } from './asset-identity.js'
import { detectMediaMime, imageDimensions, MediaStore, MediaStoreError } from './media.js'
import {
  SeedanceProviderError,
  type SeedanceAspectRatio,
  type SeedanceCancellationCapability,
  type SeedanceCancellationOutcome,
  type SeedanceCreateTaskInput,
  type SeedanceImageReference,
  type SeedanceImageRole,
  type SeedanceProviderDiagnostic,
  type SeedanceResolution,
  type SeedanceTask,
  type SeedanceVideoProviderContract,
} from './providers/seedance.js'
import {
  downloadPublicResource,
  SafePublicDownloadError,
} from './safe-image-download.js'
import type { JsonObject } from './types.js'
import {
  probeVideoMetadata,
  VideoMetadataProbeError,
  type VideoMetadataProbe,
  type VideoMetadataProbeResult,
} from './video-metadata.js'
import {
  JobCancelledError,
  JobExecutionError,
  type JobHandler,
  type JobRecord,
} from './worker.js'
import {
  compileVideoGenerationPrompt,
  createVideoGenerationSpec,
  isVideoGenerationSpec,
  videoAudioPolicyGeneratesAudio,
  type VideoAudioPolicy,
  type VideoGenerationAudioLineSpec,
  type VideoGenerationSpec,
  type VideoPromptCompilerVersion,
} from './video-generation-spec.js'
import {
  isShotVideoDurationDecision,
  shotVideoDurationDecisionIsCurrent,
  type ShotVideoDurationDecision,
} from './shot-video-duration.js'
import {
  createShotVideoTimingRemediation,
  readShotVideoTimingRemediation,
  type ShotVideoTimingCheckpoint,
  type ShotVideoTimingRemediation,
} from './shot-video-timing-remediation.js'
import {
  isShotVideoReferenceDecision,
  validateCurrentAgenticReferenceDecision,
  type ShotVideoReferenceDecision,
} from './shot-video-reference-recommendation.js'
import {
  shotVideoReferenceAssetCompatibilityIssue,
  shotVideoReferenceAssetEligibility,
} from './shot-video-reference-asset.js'

export const SHOT_VIDEO_GENERATION_JOB_TYPE = 'shot.video.generate'
export const SHOT_VIDEO_KIND = 'shot.video'
export const SHOT_VIDEO_READY_STATUS = 'video_ready'

const MAX_VIDEO_BYTES = 250 * 1024 * 1024
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_MAX_CONSECUTIVE_POLL_ERRORS = 5
const DEFAULT_DURABLE_STATUS_CHECK_INTERVAL_MS = 100
const DEFAULT_TOTAL_DEADLINE_MS = 30 * 60_000
const MAX_TOTAL_DEADLINE_MS = 2 * 60 * 60_000
const MAX_REFERENCE_IMAGE_BYTES = 30 * 1024 * 1024
// Base64 expands by 4/3 and the complete Ark request must remain below 64 MB.
const MAX_REFERENCE_IMAGES_TOTAL_BYTES = 45 * 1024 * 1024
const PROVIDER_SUBMISSION_OUTCOME_UNKNOWN = 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN'
const PROVIDER_SUBMISSION_CHECKPOINT_PHASES = new Set([
  'submitting',
  'polling',
  'downloading',
])

const PUBLIC_SHOT_ID = `CASE
  WHEN typeof(json_extract(shots.metadata_json, '$.storyId')) = 'text'
    AND length(trim(json_extract(shots.metadata_json, '$.storyId'))) > 0
  THEN json_extract(shots.metadata_json, '$.storyId')
  ELSE shots.id
END`

const PUBLIC_SCENE_ID = `CASE
  WHEN typeof(json_extract(scenes.metadata_json, '$.storyId')) = 'text'
    AND length(trim(json_extract(scenes.metadata_json, '$.storyId'))) > 0
  THEN json_extract(scenes.metadata_json, '$.storyId')
  ELSE scenes.id
END`

const PUBLIC_LOCATION_ID = `CASE
  WHEN typeof(json_extract(locations.metadata_json, '$.storyId')) = 'text'
    AND length(trim(json_extract(locations.metadata_json, '$.storyId'))) > 0
  THEN json_extract(locations.metadata_json, '$.storyId')
  ELSE locations.id
END`

const TARGET_SELECT = `
  SELECT
    shots.id AS database_shot_id,
    ${PUBLIC_SHOT_ID} AS public_shot_id,
    ${PUBLIC_SCENE_ID} AS public_scene_id,
    shots.prompt,
    shots.description,
    shots.framing,
    shots.movement,
    shots.duration_seconds,
    shots.storyboard_asset_id,
    shots.video_asset_id,
    shots.source_revision_id AS shot_source_revision_id,
    episodes.id AS episode_id,
    episodes.project_id,
    episodes.aspect_ratio,
    episodes.source_revision_id AS episode_source_revision_id,
    COALESCE(
      (
        SELECT locations.name
        FROM locations
        WHERE locations.project_id = episodes.project_id
          AND locations.episode_id = episodes.id
          AND ${PUBLIC_LOCATION_ID} = json_extract(scenes.metadata_json, '$.locationId')
        ORDER BY locations.id
        LIMIT 1
      ),
      scenes.title
    ) AS scene_name,
    COALESCE(json_extract(scenes.metadata_json, '$.timeOfDay'), '') AS scene_time_of_day,
    COALESCE(
      (
        SELECT json_group_array(subject_name)
        FROM (
          SELECT characters.name AS subject_name
          FROM dialogue_lines
          JOIN characters ON characters.id = dialogue_lines.character_id
          WHERE dialogue_lines.shot_id = shots.id
          GROUP BY characters.id, characters.name
          ORDER BY MIN(dialogue_lines.sequence), characters.id
        )
      ),
      '[]'
    ) AS subject_names_json,
    COALESCE(
      (
        SELECT json_group_array(json(audio_line))
        FROM (
          SELECT json_object(
            'kind', dialogue_lines.kind,
            'speaker', COALESCE(characters.name, '旁白'),
            'text', dialogue_lines.text
          ) AS audio_line
          FROM dialogue_lines
          LEFT JOIN characters ON characters.id = dialogue_lines.character_id
          WHERE dialogue_lines.shot_id = shots.id
          ORDER BY dialogue_lines.sequence, dialogue_lines.id
        )
      ),
      '[]'
    ) AS audio_lines_json
  FROM shots
  JOIN scenes ON scenes.id = shots.scene_id
  JOIN episodes ON episodes.id = scenes.episode_id
`

export interface ShotVideoTarget {
  databaseShotId: string
  publicShotId: string
  publicSceneId: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  subjectNames?: string[]
  audioLines?: VideoGenerationAudioLineSpec[]
  scene?: string
  action?: string
  shotSize?: string
  cameraMovement?: string
  prompt: string
  durationSeconds: number
  aspectRatio: SeedanceAspectRatio
  storyboardAssetId: string | null
  videoAssetId: string | null
}

export interface ShotVideoBinding {
  episodeId: string
  shotId: string
  sceneId: string
  databaseShotId: string
  expectedRevisionId: string
  expectedPreviousVideoAssetId: string | null
}

export interface ShotVideoReferenceBinding {
  assetId: string
  role: SeedanceImageRole
  /** Immutable publication identity pinned before any billable request is admitted. */
  version: number
  checksum: string
  sourceRevisionId: string
}

export interface ShotVideoBatchBinding {
  version: 1
  requestFingerprint: string
  selectionIndex: number
  selectionCount: number
}

export type ShotVideoPublicationMode = 'replace_current' | 'evaluation_only'

/** Entire paid request is fixed server-side when the durable job is created. */
export interface ShotVideoJobInput extends Omit<SeedanceCreateTaskInput, 'referenceImages'> {
  /** New jobs carry the server-derived, provider-neutral creative request. */
  spec?: VideoGenerationSpec
  binding: ShotVideoBinding
  /** Server-resolved immutable assets. Provider URLs/data never enter durable job JSON. */
  references?: ShotVideoReferenceBinding[]
  /** Server-authored explanation and slot provenance for automatic/manual selection. */
  referenceDecision?: ShotVideoReferenceDecision
  /** Present only for preflight-confirmed batch children. */
  batch?: ShotVideoBatchBinding
  /**
   * Evaluation baselines publish an immutable Asset without replacing the
   * production Shot pointer. Missing historical values mean replace_current.
   */
  publicationMode?: ShotVideoPublicationMode
  /**
   * Provider source length plus the exact frame-aligned OpenCut edit point.
   * Missing only on historical jobs created before audio-driven timing.
   */
  durationDecision?: ShotVideoDurationDecision
}

export interface DownloadedVideo {
  bytes: Uint8Array
  mimeType: 'video/mp4' | 'video/webm'
}

export type SafeVideoDownloader = (url: string, signal: AbortSignal) => Promise<DownloadedVideo>

export interface ShotVideoHandlerDependencies {
  database: ManjuDatabase
  mediaStore: MediaStore
  resolveProvider(job: GenerationJobRecord): Promise<SeedanceVideoProviderContract>
  downloadVideo?: SafeVideoDownloader
  probeVideo?: VideoMetadataProbe
  publishAsset?: (asset: MediaAssetRecord) => void
  pollIntervalMs?: number
  maxConsecutivePollErrors?: number
  /** How quickly an out-of-band durable cancellation aborts provider I/O. */
  durableStatusCheckIntervalMs?: number
  /** Hard wall-clock limit for one handler attempt, including polling and download. */
  totalDeadlineMs?: number
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  now?: () => string
}

type SqlRow = Record<string, unknown>

function requiredString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value) {
    throw new JobExecutionError('STORY_GRAPH_INCONSISTENT', `镜头字段 ${key} 无效`, false, 'validation')
  }
  return value
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new JobExecutionError('STORY_GRAPH_INCONSISTENT', `镜头字段 ${key} 无效`, false, 'validation')
  }
  return value
}

function textString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new JobExecutionError('STORY_GRAPH_INCONSISTENT', `镜头字段 ${key} 无效`, false, 'validation')
  }
  return value
}

function stringArray(row: SqlRow, key: string): string[] {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new JobExecutionError('STORY_GRAPH_INCONSISTENT', `镜头字段 ${key} 无效`, false, 'validation')
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('invalid')
    return [...new Set(parsed.map((item) => item.trim()).filter(Boolean))]
  } catch {
    throw new JobExecutionError('STORY_GRAPH_INCONSISTENT', `镜头字段 ${key} 无效`, false, 'validation')
  }
}

function audioLineArray(row: SqlRow, key: string): VideoGenerationAudioLineSpec[] {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new JobExecutionError('STORY_GRAPH_INCONSISTENT', `镜头字段 ${key} 无效`, false, 'validation')
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length > 8 || parsed.some((line) => (
      !isPlainObject(line)
      || (line.kind !== 'dialogue' && line.kind !== 'narration')
      || typeof line.speaker !== 'string'
      || !line.speaker.trim()
      || typeof line.text !== 'string'
      || !line.text.trim()
    ))) throw new Error('invalid')
    return parsed.map((line) => ({
      kind: line.kind as 'dialogue' | 'narration',
      speaker: String(line.speaker),
      text: String(line.text),
    }))
  } catch {
    throw new JobExecutionError('STORY_GRAPH_INCONSISTENT', `镜头字段 ${key} 无效`, false, 'validation')
  }
}

function requiredDuration(row: SqlRow): number {
  const value = row.duration_seconds
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new JobExecutionError('STORY_GRAPH_INCONSISTENT', '镜头时长无效', false, 'validation')
  }
  return value
}

function aspectRatio(value: unknown): SeedanceAspectRatio {
  if (value === '16:9' || value === '9:16' || value === '1:1') return value
  throw new JobExecutionError(
    'UNSUPPORTED_VIDEO_ASPECT_RATIO',
    '当前分集宽高比不受 Seedance 2.0 MVP 支持',
    false,
    'validation',
  )
}

function targetFromRow(row: SqlRow): ShotVideoTarget {
  const episodeRevisionId = nullableString(row, 'episode_source_revision_id')
  if (!episodeRevisionId || nullableString(row, 'shot_source_revision_id') !== episodeRevisionId) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '镜头与分集未绑定同一份可追溯剧本修订',
      false,
      'validation',
    )
  }
  const explicitPrompt = textString(row, 'prompt').trim()
  const action = textString(row, 'description').trim()
  const fallbackPrompt = [action, textString(row, 'movement')]
    .map((item) => item.trim())
    .filter(Boolean)
    .join('；')
  const prompt = explicitPrompt || fallbackPrompt
  if (!prompt) {
    throw new JobExecutionError('INVALID_VIDEO_PROMPT', '镜头尚无可用视频提示词', false, 'validation')
  }
  return {
    databaseShotId: requiredString(row, 'database_shot_id'),
    publicShotId: requiredString(row, 'public_shot_id'),
    publicSceneId: requiredString(row, 'public_scene_id'),
    projectId: requiredString(row, 'project_id'),
    episodeId: requiredString(row, 'episode_id'),
    sourceRevisionId: episodeRevisionId,
    subjectNames: stringArray(row, 'subject_names_json'),
    audioLines: audioLineArray(row, 'audio_lines_json'),
    scene: [textString(row, 'scene_name'), textString(row, 'scene_time_of_day')]
      .map((item) => item.trim())
      .filter(Boolean)
      .join('，'),
    action: action || prompt,
    shotSize: textString(row, 'framing').trim(),
    cameraMovement: textString(row, 'movement').trim(),
    prompt,
    durationSeconds: requiredDuration(row),
    aspectRatio: aspectRatio(row.aspect_ratio),
    storyboardAssetId: nullableString(row, 'storyboard_asset_id'),
    videoAssetId: nullableString(row, 'video_asset_id'),
  }
}

/** Resolve public Story IDs only within the requested project and episode. */
export function resolvePublicShotVideoTarget(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string; shotId: string; sceneId?: string },
): ShotVideoTarget {
  const sceneId = input.sceneId ?? null
  const rows = database.withSql((sql) => sql.all(`
    ${TARGET_SELECT}
    WHERE episodes.project_id = ?
      AND episodes.id = ?
      AND ${PUBLIC_SHOT_ID} = ?
      AND (? IS NULL OR ${PUBLIC_SCENE_ID} = ?)
    ORDER BY scenes.id, shots.id
    LIMIT 2
  `, input.projectId, input.episodeId, input.shotId, sceneId, sceneId))
  if (rows.length === 0) {
    throw new JobExecutionError(
      'SHOT_NOT_FOUND',
      '镜头不存在，或不属于指定项目、分集与场景',
      false,
      'validation',
    )
  }
  if (rows.length > 1) {
    throw new JobExecutionError('AMBIGUOUS_SHOT_ID', '该镜头 ID 在分集中不唯一，请提供 sceneId', false, 'validation')
  }
  return targetFromRow(rows[0])
}

export function createShotVideoJobInput(
  target: ShotVideoTarget,
  options: {
    resolution: SeedanceResolution
    durationSeconds?: number
    generateAudio?: boolean
    audioPolicy?: VideoAudioPolicy
    promptCompilerVersion?: VideoPromptCompilerVersion
    references?: ShotVideoReferenceBinding[]
    referenceDecision?: ShotVideoReferenceDecision
    batch?: ShotVideoBatchBinding
    publicationMode?: ShotVideoPublicationMode
    durationDecision?: ShotVideoDurationDecision
  },
): ShotVideoJobInput {
  // Seedance 2.0 currently bills/generates 4-15 second clips. Short timeline
  // shots use a 4-second source clip which the editor can trim non-destructively.
  const durationSeconds = options.durationDecision?.providerDurationSeconds
    ?? options.durationSeconds
    ?? Math.max(4, Math.min(15, Math.round(target.durationSeconds)))
  if (options.durationDecision
    && options.durationSeconds !== undefined
    && options.durationSeconds !== options.durationDecision.providerDurationSeconds) {
    throw new TypeError('Video duration decision conflicts with durationSeconds')
  }
  const audioPolicy = options.audioPolicy
    ?? (options.generateAudio === true ? 'provider_audio' : 'silent')
  const spec = videoGenerationSpecForTarget(target, {
    resolution: options.resolution,
    durationSeconds,
    audioPolicy,
    promptCompilerVersion: options.promptCompilerVersion,
    references: options.references ?? [],
  })
  const compiled = compileVideoGenerationPrompt(spec)
  return {
    prompt: compiled.prompt,
    aspectRatio: target.aspectRatio,
    resolution: options.resolution,
    durationSeconds,
    generateAudio: videoAudioPolicyGeneratesAudio(audioPolicy),
    spec,
    ...(options.references?.length ? { references: structuredClone(options.references) } : {}),
    ...(options.referenceDecision
      ? { referenceDecision: structuredClone(options.referenceDecision) }
      : {}),
    ...(options.batch ? { batch: { ...options.batch } } : {}),
    ...(options.publicationMode === 'evaluation_only'
      ? { publicationMode: options.publicationMode }
      : {}),
    ...(options.durationDecision
      ? { durationDecision: structuredClone(options.durationDecision) }
      : {}),
    binding: {
      episodeId: target.episodeId,
      shotId: target.publicShotId,
      sceneId: target.publicSceneId,
      databaseShotId: target.databaseShotId,
      expectedRevisionId: target.sourceRevisionId,
      expectedPreviousVideoAssetId: target.videoAssetId,
    },
  }
}

function videoGenerationSpecForTarget(
  target: ShotVideoTarget,
  options: {
    resolution: SeedanceResolution
    durationSeconds: number
    audioPolicy: VideoAudioPolicy
    promptCompilerVersion?: VideoPromptCompilerVersion
    references: readonly Pick<ShotVideoReferenceBinding, 'assetId' | 'role'>[]
  },
): VideoGenerationSpec {
  return createVideoGenerationSpec({
    ...(options.promptCompilerVersion
      ? { promptCompilerVersion: options.promptCompilerVersion }
      : {}),
    subjectNames: target.subjectNames ?? [],
    scene: target.scene ?? '',
    action: target.action?.trim() || target.prompt,
    shotSize: target.shotSize ?? '',
    cameraMovement: target.cameraMovement ?? '',
    audioPolicy: options.audioPolicy,
    ...(options.audioPolicy === 'provider_audio' && target.audioLines?.length
      ? { audioLines: target.audioLines }
      : {}),
    durationSeconds: options.durationSeconds,
    resolution: options.resolution,
    aspectRatio: target.aspectRatio,
    sourceRevisionId: target.sourceRevisionId,
    references: options.references.map(({ assetId, role }) => ({ assetId, role })),
  })
}

function validateReferenceMode(references: readonly Pick<ShotVideoReferenceBinding, 'assetId' | 'role'>[]): void {
  if (references.length > 9) {
    throw new JobExecutionError('INVALID_VIDEO_REFERENCE_INPUT', 'Seedance 2.0 最多接受 9 张参考图', false, 'validation')
  }
  if (references.some((reference) => typeof reference.assetId !== 'string'
    || !reference.assetId.trim()
    || !['first_frame', 'last_frame', 'reference_image'].includes(reference.role))) {
    throw new JobExecutionError('INVALID_VIDEO_REFERENCE_INPUT', 'Seedance 参考图绑定无效', false, 'validation')
  }
  const firstFrames = references.filter((reference) => reference.role === 'first_frame')
  const lastFrames = references.filter((reference) => reference.role === 'last_frame')
  const referenceImages = references.filter((reference) => reference.role === 'reference_image')
  const frameMode = firstFrames.length > 0 || lastFrames.length > 0
  if (firstFrames.length > 1
    || lastFrames.length > 1
    || (lastFrames.length === 1 && firstFrames.length !== 1)
    || (frameMode && referenceImages.length > 0)) {
    throw new JobExecutionError(
      'INVALID_VIDEO_REFERENCE_INPUT',
      '首尾帧模式与多参考图模式不能混用，尾帧必须与首帧同时提供',
      false,
      'validation',
    )
  }
  if (!frameMode && new Set(references.map((reference) => reference.assetId)).size !== references.length) {
    throw new JobExecutionError('INVALID_VIDEO_REFERENCE_INPUT', '多参考图不能包含重复资产', false, 'validation')
  }
}

/**
 * Resolve caller-selected Asset IDs into immutable durable bindings. This is
 * safe to call during a non-billable preflight: no file bytes or Provider are
 * touched, and ownership failures do not reveal cross-project asset details.
 */
export function createShotVideoReferenceBindings(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string
    sourceRevisionId: string
    references: readonly { assetId: string; role: SeedanceImageRole }[]
  },
): ShotVideoReferenceBinding[] {
  validateReferenceMode(input.references)
  return input.references.map((reference) => {
    const eligibility = shotVideoReferenceAssetEligibility(database, {
      projectId: input.projectId,
      episodeId: input.episodeId,
      sourceRevisionId: input.sourceRevisionId,
      assetId: reference.assetId,
    })
    if (eligibility.status === 'unavailable') {
      throw new JobExecutionError(
        'INVALID_VIDEO_REFERENCE_ASSET',
        '参考图不存在、不可用或不属于当前项目、分集与剧本修订',
        false,
        'validation',
      )
    }
    if (eligibility.status === 'invalid_dimensions') {
      const compatibilityIssue = shotVideoReferenceAssetCompatibilityIssue(database, {
        ...input,
        assetId: reference.assetId,
        role: reference.role,
      })
      throw new JobExecutionError(
        'INVALID_VIDEO_REFERENCE_ASSET',
        '参考图尺寸或宽高比不符合 Seedance 输入要求',
        false,
        'validation',
        compatibilityIssue
          ? { diagnostics: { compatibilityIssue: compatibilityIssue as unknown as JsonObject } }
          : undefined,
      )
    }
    const asset = eligibility.asset
    return {
      assetId: asset.id,
      role: reference.role,
      version: asset.version,
      checksum: asset.checksum,
      sourceRevisionId: asset.sourceRevisionId,
    }
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateJobInput(value: unknown): ShotVideoJobInput {
  if (!isPlainObject(value) || !isPlainObject(value.binding)) {
    throw new JobExecutionError('INVALID_VIDEO_JOB', '视频任务参数无效', false, 'validation')
  }
  const binding = value.binding
  const validString = (item: unknown) => typeof item === 'string' && Boolean(item.trim())
  const exactKeys = (record: Record<string, unknown>, keys: readonly string[]) => {
    const allowed = new Set(keys)
    return Object.keys(record).every((key) => allowed.has(key))
  }
  if (!exactKeys(value, [
    'prompt',
    'aspectRatio',
    'resolution',
    'durationSeconds',
    'generateAudio',
    'spec',
    'binding',
    'references',
    'referenceDecision',
    'batch',
    'publicationMode',
    'durationDecision',
  ])
    || !exactKeys(binding, [
      'episodeId',
      'shotId',
      'sceneId',
      'databaseShotId',
      'expectedRevisionId',
      'expectedPreviousVideoAssetId',
    ])
    || !validString(value.prompt)
    || !['16:9', '9:16', '1:1'].includes(String(value.aspectRatio))
    || !['480p', '720p', '1080p'].includes(String(value.resolution))
    || typeof value.durationSeconds !== 'number'
    || !Number.isInteger(value.durationSeconds)
    || value.durationSeconds < 4
    || value.durationSeconds > 15
    || (value.generateAudio !== undefined && typeof value.generateAudio !== 'boolean')
    || !validString(binding.episodeId)
    || !validString(binding.shotId)
    || !validString(binding.sceneId)
    || !validString(binding.databaseShotId)
    || !validString(binding.expectedRevisionId)
    || (binding.expectedPreviousVideoAssetId !== null
      && !validString(binding.expectedPreviousVideoAssetId))) {
    throw new JobExecutionError('INVALID_VIDEO_JOB', '视频任务参数无效', false, 'validation')
  }
  if (value.publicationMode !== undefined
    && (value.publicationMode !== 'evaluation_only'
      || !isVideoGenerationSpec(value.spec))) {
    throw new JobExecutionError(
      'INVALID_VIDEO_JOB',
      'evaluation_only 发布模式必须绑定服务端固化的视频生成规格',
      false,
      'validation',
    )
  }
  if (value.references !== undefined) {
    if (!Array.isArray(value.references)
      || value.references.length === 0
      || value.references.some((reference) => !isPlainObject(reference)
        || !exactKeys(reference, ['assetId', 'role', 'version', 'checksum', 'sourceRevisionId'])
        || !validString(reference.assetId)
        || !['first_frame', 'last_frame', 'reference_image'].includes(String(reference.role))
        || !Number.isInteger(reference.version)
        || (reference.version as number) < 1
        || typeof reference.checksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(reference.checksum)
        || (reference.sourceRevisionId !== undefined
          && (!validString(reference.sourceRevisionId)
            || reference.sourceRevisionId !== binding.expectedRevisionId)))) {
      throw new JobExecutionError('INVALID_VIDEO_REFERENCE_INPUT', '视频任务的参考图绑定无效', false, 'validation')
    }
    validateReferenceMode(value.references as unknown as ShotVideoReferenceBinding[])
  }
  if (value.referenceDecision !== undefined) {
    if (!isShotVideoReferenceDecision(value.referenceDecision)
      || value.referenceDecision.recommendation.shotId !== binding.shotId
      || value.referenceDecision.recommendation.sceneId !== binding.sceneId
      || value.referenceDecision.recommendation.sourceRevisionId !== binding.expectedRevisionId) {
      throw new JobExecutionError('INVALID_VIDEO_JOB', '视频任务的角色视角决策无效', false, 'validation')
    }
    const selected = value.referenceDecision.selectedReferences
    const references = Array.isArray(value.references) ? value.references : []
    if (selected.length !== references.length
      || selected.some((reference, index) => reference.assetId !== references[index]?.assetId
        || reference.role !== references[index]?.role)) {
      throw new JobExecutionError('INVALID_VIDEO_JOB', '角色视角决策与固化参考图不一致', false, 'validation')
    }
  }
  if (value.spec !== undefined) {
    if (!isVideoGenerationSpec(value.spec)) {
      throw new JobExecutionError('INVALID_VIDEO_JOB', '视频任务的结构化生成规格无效', false, 'validation')
    }
    const spec = value.spec
    const compiled = compileVideoGenerationPrompt(spec)
    const references = Array.isArray(value.references) ? value.references : []
    if (compiled.prompt !== value.prompt
      || spec.aspectRatio !== value.aspectRatio
      || spec.resolution !== value.resolution
      || spec.durationSeconds !== value.durationSeconds
      || spec.sourceRevisionId !== binding.expectedRevisionId
      || videoAudioPolicyGeneratesAudio(spec.audioPolicy) !== (value.generateAudio ?? false)
      || spec.references.length !== references.length
      || spec.references.some((reference, index) => (
        reference.assetId !== references[index]?.assetId
        || reference.role !== references[index]?.role
      ))) {
      throw new JobExecutionError('INVALID_VIDEO_JOB', '视频任务规格与 Provider 请求不一致', false, 'validation')
    }
  }
  if (value.durationDecision !== undefined
    && (!isShotVideoDurationDecision(value.durationDecision)
      || value.durationDecision.providerDurationSeconds !== value.durationSeconds)) {
    throw new JobExecutionError('INVALID_VIDEO_JOB', '视频任务的音频驱动时长合同无效', false, 'validation')
  }
  if (value.batch !== undefined) {
    if (!isPlainObject(value.batch)
      || !exactKeys(value.batch, ['version', 'requestFingerprint', 'selectionIndex', 'selectionCount'])
      || value.batch.version !== 1
      || typeof value.batch.requestFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.batch.requestFingerprint)
      || !Number.isInteger(value.batch.selectionIndex)
      || !Number.isInteger(value.batch.selectionCount)
      || (value.batch.selectionIndex as number) < 0
      || (value.batch.selectionCount as number) < 1
      || (value.batch.selectionIndex as number) >= (value.batch.selectionCount as number)) {
      throw new JobExecutionError('INVALID_VIDEO_JOB', '视频批量任务绑定无效', false, 'validation')
    }
  }
  return {
    ...value,
    generateAudio: value.generateAudio ?? false,
  } as unknown as ShotVideoJobInput
}

class StaleAudioTimingError extends JobExecutionError {
  constructor(readonly remediation: ShotVideoTimingRemediation) {
    super(
      'STALE_AUDIO_TIMING',
      '台词或旁白音频已变更，视频时长合同失效；请基于最新音频重新预检',
      false,
      'validation',
    )
    this.name = 'StaleAudioTimingError'
  }
}

function staleAudioTimingError(
  database: ManjuDatabase,
  target: ShotVideoTarget,
  input: ShotVideoJobInput,
  checkpoint: ShotVideoTimingCheckpoint,
  providerSubmissionState: 'not-started' | 'task-exists',
  detectedAt: string,
): StaleAudioTimingError {
  return new StaleAudioTimingError(createShotVideoTimingRemediation(database, {
    target,
    sceneId: input.binding.sceneId,
    previousDecision: input.durationDecision!,
    checkpoint,
    providerSubmissionState,
    detectedAt,
  }))
}

function assertCurrentDurationDecision(
  database: ManjuDatabase,
  target: ShotVideoTarget,
  input: ShotVideoJobInput,
  checkpoint: ShotVideoTimingCheckpoint,
  providerSubmissionState: 'not-started' | 'task-exists',
  detectedAt: string,
): void {
  if (!input.durationDecision) return
  if (!shotVideoDurationDecisionIsCurrent(database, target, input.durationDecision)) {
    throw staleAudioTimingError(
      database,
      target,
      input,
      checkpoint,
      providerSubmissionState,
      detectedAt,
    )
  }
}

function persistTimingRemediation(
  database: ManjuDatabase,
  jobId: string,
  remediation: ShotVideoTimingRemediation,
): void {
  database.transaction((transaction) => {
    const current = transaction.getGenerationJob(jobId)
    if (!current) throw new JobExecutionError('JOB_NOT_FOUND', '视频任务不存在', false, 'validation')
    transaction.updateGenerationJob(jobId, {
      providerState: {
        ...current.providerState,
        timingRemediation: remediation as unknown as JsonObject,
      },
    })
  })
}

function resolveDurableTarget(
  database: ManjuDatabase,
  projectId: string,
  input: ShotVideoJobInput,
): ShotVideoTarget {
  const row = database.withSql((sql) => sql.get(`
    ${TARGET_SELECT}
    WHERE shots.id = ?
      AND episodes.project_id = ?
      AND episodes.id = ?
      AND ${PUBLIC_SHOT_ID} = ?
      AND ${PUBLIC_SCENE_ID} = ?
  `,
  input.binding.databaseShotId,
  projectId,
  input.binding.episodeId,
  input.binding.shotId,
  input.binding.sceneId,
  ))
  if (!row) {
    throw new JobExecutionError('SHOT_NOT_FOUND', '待生成视频的镜头已不存在或已被替换', false, 'validation')
  }
  const target = targetFromRow(row)
  if (target.sourceRevisionId !== input.binding.expectedRevisionId) {
    throw new JobExecutionError('STALE_SOURCE', '源剧本已修改，请基于最新镜头重新生成视频', false, 'validation')
  }
  if (!shotVideoInputMatchesTarget(input, target)) {
    throw new JobExecutionError('STALE_SOURCE', '镜头提示词或分集规格已修改，请重新生成视频', false, 'validation')
  }
  if (target.videoAssetId !== input.binding.expectedPreviousVideoAssetId) {
    throw new JobExecutionError(
      'SHOT_VIDEO_LINK_CONFLICT',
      '镜头视频链接已改变，任务不会覆盖其他生成结果',
      false,
      'validation',
    )
  }
  return target
}

function shotVideoInputMatchesTarget(input: ShotVideoJobInput, target: ShotVideoTarget): boolean {
  if (!input.spec) return target.prompt === input.prompt && target.aspectRatio === input.aspectRatio
  const expected = videoGenerationSpecForTarget(target, {
    resolution: input.resolution,
    durationSeconds: input.durationSeconds,
    audioPolicy: input.spec.audioPolicy,
    promptCompilerVersion: input.spec.promptCompilerVersion,
    references: input.references ?? [],
  })
  return JSON.stringify(expected) === JSON.stringify(input.spec)
    && compileVideoGenerationPrompt(expected).prompt === input.prompt
}

function recoverAlreadyPublishedAsset(
  database: ManjuDatabase,
  durable: GenerationJobRecord,
  input: ShotVideoJobInput,
): MediaAssetRecord | null {
  if (input.publicationMode === 'evaluation_only') {
    // Evaluation assets intentionally never become shots.video_asset_id. A
    // crash after the Asset transaction but before the Job result commit must
    // still recover the exact bytes instead of resubmitting the paid request.
    resolveDurableTarget(database, durable.projectId, input)
    const row = database.withSql((sql) => sql.get(`
      SELECT id FROM media_assets
       WHERE generation_job_id = ?
         AND project_id = ?
         AND episode_id = ?
         AND kind = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    `, durable.id, durable.projectId, input.binding.episodeId, SHOT_VIDEO_KIND))
    const assetId = typeof row?.id === 'string' ? row.id : null
    const asset = assetId ? database.getMediaAsset(assetId) : undefined
    if (!asset
      || asset.status !== 'ready'
      || asset.generationJobId !== durable.id
      || asset.sourceRevisionId !== input.binding.expectedRevisionId
      || (asset.mimeType !== 'video/mp4' && asset.mimeType !== 'video/webm')) return null
    return asset
  }
  const row = database.withSql((sql) => sql.get(`
    ${TARGET_SELECT}
    WHERE shots.id = ?
      AND episodes.project_id = ?
      AND episodes.id = ?
      AND ${PUBLIC_SHOT_ID} = ?
      AND ${PUBLIC_SCENE_ID} = ?
  `,
  input.binding.databaseShotId,
  durable.projectId,
  input.binding.episodeId,
  input.binding.shotId,
  input.binding.sceneId,
  ))
  if (!row) return null
  const target = targetFromRow(row)
  if (target.sourceRevisionId !== input.binding.expectedRevisionId
    || !shotVideoInputMatchesTarget(input, target)
    || target.videoAssetId === input.binding.expectedPreviousVideoAssetId
    || !target.videoAssetId) return null
  const asset = database.getMediaAsset(target.videoAssetId)
  if (!asset
    || asset.projectId !== durable.projectId
    || asset.episodeId !== input.binding.episodeId
    || asset.kind !== SHOT_VIDEO_KIND
    || asset.status !== 'ready'
    || asset.generationJobId !== durable.id
    || asset.sourceRevisionId !== input.binding.expectedRevisionId
    || (asset.mimeType !== 'video/mp4' && asset.mimeType !== 'video/webm')) return null
  return asset
}

function successfulOutput(asset: MediaAssetRecord, input: ShotVideoJobInput, externalTaskId: string): JsonObject {
  return {
    asset: {
      id: asset.id,
      url: `/api/v1/assets/${encodeURIComponent(asset.id)}/content`,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      durationSeconds: asset.durationSeconds,
    },
    shotId: input.binding.shotId,
    externalTaskId,
  }
}

function checkpointTaskId(value: unknown): string | null {
  if (!isPlainObject(value)) return null
  return typeof value.externalTaskId === 'string' && value.externalTaskId ? value.externalTaskId : null
}

function checkpointPhase(value: unknown): string | null {
  if (!isPlainObject(value) || value.operation !== SHOT_VIDEO_GENERATION_JOB_TYPE) return null
  return typeof value.phase === 'string' ? value.phase : null
}

function submissionOutcomeUnknownError(cause?: unknown): JobExecutionError {
  const timeout = cause instanceof SeedanceProviderError
    ? cause.code === 'UPSTREAM_TIMEOUT'
    : cause instanceof Error && cause.name === 'TimeoutError'
  return new JobExecutionError(
    PROVIDER_SUBMISSION_OUTCOME_UNKNOWN,
    'Seedance 提交结果未能确认。为避免重复计费，系统不会自动重提；请在供应商控制台核对后人工处理。',
    false,
    timeout ? 'timeout' : 'provider',
    { cause },
  )
}

function persistSubmissionDiagnostic(
  database: ManjuDatabase,
  jobId: string,
  diagnostic: SeedanceProviderDiagnostic,
  observedAt: string,
): void {
  database.transaction((transaction) => {
    const current = transaction.getGenerationJob(jobId)
    if (!current) return
    transaction.updateGenerationJob(jobId, {
      providerState: {
        ...current.providerState,
        submissionDiagnostic: {
          operation: diagnostic.operation,
          protocol: diagnostic.protocol,
          endpointFamily: diagnostic.endpointFamily,
          httpStatus: diagnostic.httpStatus,
          ...(diagnostic.providerCode ? { providerCode: diagnostic.providerCode } : {}),
          observedAt,
        },
      },
    })
  })
}

function hasUnknownSubmissionOutcome(record: GenerationJobRecord): boolean {
  const externalTaskId = record.externalTaskId ?? checkpointTaskId(record.providerState)
  if (externalTaskId) return false
  if (record.error?.code === PROVIDER_SUBMISSION_OUTCOME_UNKNOWN) return true
  const phase = checkpointPhase(record.providerState)
  const timingRemediation = readShotVideoTimingRemediation(record)
  if (phase === 'submitting'
    && timingRemediation?.checkpoint === 'pre-submit'
    && timingRemediation.providerSubmissionState === 'not-started') return false
  return phase !== null && PROVIDER_SUBMISSION_CHECKPOINT_PHASES.has(phase)
}

interface RetrySubmissionRecovery {
  externalTaskId: string | null
  outcomeUnknown: boolean
  terminalProviderTask?: boolean
  requiresPaidReconfirmation?: boolean
}

/**
 * Walk the whole retry chain. A known task id is safe to poll, while any newer
 * unresolved non-idempotent submission is a hard stop: it must never fall
 * through to another paid POST.
 */
function recoverRetrySubmission(
  database: ManjuDatabase,
  durable: GenerationJobRecord,
): RetrySubmissionRecovery {
  let sourceId = durable.retryOf
  const visited = new Set([durable.id])
  while (sourceId) {
    if (visited.has(sourceId)) return { externalTaskId: null, outcomeUnknown: true }
    visited.add(sourceId)
    const source = database.getGenerationJob(sourceId)
    if (!source
      || source.type !== durable.type
      || source.providerId !== durable.providerId
      || source.model !== durable.model
      || source.providerConfigRevision !== durable.providerConfigRevision) {
      return { externalTaskId: null, outcomeUnknown: true }
    }

    if (source.error?.code === 'STALE_AUDIO_TIMING') {
      if (hasUnknownSubmissionOutcome(source)) {
        return { externalTaskId: null, outcomeUnknown: true }
      }
      return {
        externalTaskId: null,
        outcomeUnknown: false,
        requiresPaidReconfirmation: true,
      }
    }

    const externalTaskId = source.externalTaskId ?? checkpointTaskId(source.providerState)
    if (externalTaskId) {
      // The newest checkpoint for a Provider task wins. A terminal retry child
      // must not fall through and resurrect an ancestor's older running state.
      if (source.providerState.lastStatus === 'failed'
        || source.providerState.lastStatus === 'cancelled'
        || source.providerState.lastStatus === 'expired') {
        return {
          externalTaskId: null,
          outcomeUnknown: false,
          terminalProviderTask: true,
        }
      }
      return { externalTaskId, outcomeUnknown: false }
    }
    if (hasUnknownSubmissionOutcome(source)) {
      return { externalTaskId: null, outcomeUnknown: true }
    }
    sourceId = source.retryOf
  }
  return { externalTaskId: null, outcomeUnknown: false }
}

function persistExternalCheckpoint(
  database: ManjuDatabase,
  jobId: string,
  externalTaskId: string,
  state: JsonObject,
): void {
  database.transaction((transaction) => {
    const current = transaction.getGenerationJob(jobId)
    if (!current) throw new JobExecutionError('JOB_NOT_FOUND', '视频任务不存在', false, 'validation')
    if (current.externalTaskId && current.externalTaskId !== externalTaskId) {
      throw new JobExecutionError(
        'PROVIDER_TASK_CONFLICT',
        '视频任务已绑定不同的上游任务 ID',
        false,
        'provider',
      )
    }
    const currentRoot = retryLineageRoot(transaction, current)
    if (!current.providerId || current.providerConfigRevision === null || !currentRoot) {
      throw new JobExecutionError(
        'PROVIDER_TASK_CONFLICT',
        '视频任务无法证明上游任务归属',
        false,
        'provider',
      )
    }
    const collisionIds = transaction.withSql((sql) => sql.all(`
      SELECT id
      FROM generation_jobs
      WHERE id <> ?
        AND provider_id = ?
        AND provider_config_revision = ?
        AND (
          external_task_id = ?
          OR json_extract(provider_state_json, '$.externalTaskId') = ?
        )
    `,
    current.id,
    current.providerId,
    current.providerConfigRevision,
    externalTaskId,
    externalTaskId,
    ))
    for (const row of collisionIds) {
      const collisionId = typeof row.id === 'string' ? row.id : ''
      const collision = collisionId ? transaction.getGenerationJob(collisionId) : undefined
      if (!collision || retryLineageRoot(transaction, collision) !== currentRoot) {
        throw new JobExecutionError(
          'PROVIDER_TASK_CONFLICT',
          'Seedance 上游任务 ID 已绑定到另一条生成任务链',
          false,
          'provider',
        )
      }
    }
    transaction.updateGenerationJob(jobId, { externalTaskId, providerState: state })
  })
}

function retryLineageRoot(
  database: ManjuDatabase,
  start: GenerationJobRecord,
): string | null {
  const visited = new Set<string>()
  let current = start
  while (true) {
    if (visited.has(current.id)) return null
    visited.add(current.id)
    if (!current.retryOf) return current.id
    const parent = database.getGenerationJob(current.retryOf)
    if (!parent
      || parent.projectId !== start.projectId
      || parent.type !== start.type
      || parent.providerId !== start.providerId
      || parent.providerConfigRevision !== start.providerConfigRevision
      || parent.model !== start.model) return null
    current = parent
  }
}

function providerExecutionError(error: SeedanceProviderError): JobExecutionError {
  const category = error.code === 'PROVIDER_AUTH_FAILED'
    ? 'authentication'
    : error.code === 'PROVIDER_BILLING_UNAVAILABLE'
      ? 'provider'
      : error.code === 'CONTENT_REJECTED'
        ? 'content_policy'
        : error.code === 'PROVIDER_RATE_LIMITED'
          ? 'rate_limit'
          : error.code === 'UPSTREAM_TIMEOUT'
            ? 'timeout'
            : error.code === 'INVALID_VIDEO_REQUEST' || error.code === 'TASK_NOT_FOUND'
              ? 'validation'
              : 'provider'
  return new JobExecutionError(error.code, error.message, error.retryable, category, { cause: error })
}

function failedTaskError(task: SeedanceTask): JobExecutionError {
  const contentRejected = task.error?.code.toLowerCase().includes('sensitive') === true
  return new JobExecutionError(
    contentRejected ? 'CONTENT_REJECTED' : task.error?.code || 'SEEDANCE_TASK_FAILED',
    contentRejected ? 'Seedance 内容安全检查未通过' : 'Seedance 视频生成任务失败',
    !contentRejected,
    contentRejected ? 'content_policy' : 'provider',
  )
}

function expiredTaskError(): JobExecutionError {
  return new JobExecutionError(
    'SEEDANCE_TASK_EXPIRED',
    'Seedance 上游任务已过期，无法继续轮询或下载成片',
    false,
    'provider',
  )
}

function totalDeadlineError(externalTaskId: string | null, cause?: unknown): JobExecutionError {
  return new JobExecutionError(
    'SEEDANCE_EXECUTION_TIMEOUT',
    externalTaskId
      ? 'Seedance 视频任务超过本次执行时限，已释放视频 Provider 槽位'
      : 'Seedance 视频任务在提交前超过本次执行时限',
    externalTaskId !== null,
    'timeout',
    { cause },
  )
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => settle(reject, signal.reason)
    const settle = (callback: (value: never) => void, value: unknown) => {
      signal.removeEventListener('abort', onAbort)
      callback(value as never)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => settle(resolve as (value: never) => void, value),
      (error) => settle(reject, error),
    )
  })
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    timer.unref()
    const onAbort = () => done(signal.reason)
    function done(error?: unknown) {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function normalizedContentType(value: string | null): string | null {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase()
  return normalized || null
}

/** Default output fetch: HTTPS-only, DNS-pinned, redirect-revalidated, bounded. */
export async function downloadSeedanceVideo(url: string, signal: AbortSignal): Promise<DownloadedVideo> {
  let resource
  try {
    resource = await downloadPublicResource(url, signal, {
      maxBytes: MAX_VIDEO_BYTES,
      accept: 'video/mp4,video/webm;q=0.8,application/octet-stream;q=0.2',
      userAgent: 'manju-studio-seedance-fetcher/0.1',
      httpsOnly: true,
    })
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof SafePublicDownloadError) {
      throw new JobExecutionError(
        error.code,
        error.message,
        error.retryable,
        error.code === 'UNSAFE_RESOURCE_URL' || error.code === 'INVALID_RESOURCE_URL'
          ? 'validation'
          : 'provider',
        { cause: error },
      )
    }
    throw error
  }
  let mimeType: string
  try {
    mimeType = detectMediaMime(resource.bytes)
  } catch (error) {
    if (error instanceof MediaStoreError) {
      throw new JobExecutionError('INVALID_VIDEO_RESPONSE', 'Seedance 返回的文件不是受支持视频', true, 'provider')
    }
    throw error
  }
  if (mimeType !== 'video/mp4' && mimeType !== 'video/webm') {
    throw new JobExecutionError('INVALID_VIDEO_RESPONSE', 'Seedance 返回的文件不是 MP4/WebM 视频', true, 'provider')
  }
  const advertised = normalizedContentType(resource.contentType)
  if (advertised && advertised !== 'application/octet-stream' && advertised !== mimeType) {
    throw new JobExecutionError('INVALID_VIDEO_RESPONSE', 'Seedance 视频内容与声明类型不一致', true, 'provider')
  }
  return { bytes: resource.bytes, mimeType }
}

function dimensions(resolution: SeedanceResolution, ratio: SeedanceAspectRatio): { width: number; height: number } {
  const shortEdge = resolution === '480p' ? 480 : resolution === '720p' ? 720 : 1080
  if (ratio === '1:1') return { width: shortEdge, height: shortEdge }
  const longEdge = resolution === '480p' ? 854 : resolution === '720p' ? 1280 : 1920
  return ratio === '16:9'
    ? { width: longEdge, height: shortEdge }
    : { width: shortEdge, height: longEdge }
}

function validateProbedVideoSpecification(
  probe: VideoMetadataProbeResult,
  input: ShotVideoJobInput,
): void {
  const expected = dimensions(input.resolution, input.aspectRatio)
  const widthScale = probe.video.width / expected.width
  const heightScale = probe.video.height / expected.height
  const expectedRatio = expected.width / expected.height
  const actualRatio = probe.video.width / probe.video.height
  const aspectDifference = Math.abs(actualRatio - expectedRatio) / expectedRatio
  if (widthScale < 0.8 || widthScale > 1.25
    || heightScale < 0.8 || heightScale > 1.25
    || aspectDifference > 0.05) {
    throw new JobExecutionError(
      'VIDEO_SPEC_MISMATCH',
      'Seedance 成片的实际分辨率或宽高比与请求严重不符',
      false,
      'provider',
    )
  }
  const durationTolerance = Math.max(1, input.durationSeconds * 0.25)
  if (Math.abs(probe.durationSeconds - input.durationSeconds) > durationTolerance) {
    throw new JobExecutionError(
      'VIDEO_SPEC_MISMATCH',
      'Seedance 成片的实际时长与请求严重不符',
      false,
      'provider',
    )
  }
}

function videoProbeExecutionError(error: VideoMetadataProbeError): JobExecutionError {
  if (error.code === 'BINARY_UNAVAILABLE') {
    return new JobExecutionError(
      'VIDEO_PROBE_UNAVAILABLE',
      '服务端缺少可用的 ffprobe，无法安全验证 Seedance 成片',
      false,
      'internal',
      { cause: error },
    )
  }
  return new JobExecutionError(
    error.code === 'INVALID_VIDEO' ? 'INVALID_VIDEO_RESPONSE' : 'VIDEO_PROBE_FAILED',
    error.code === 'INVALID_VIDEO'
      ? 'Seedance 成片缺少可信的容器或音视频流信息'
      : 'Seedance 成片媒体规格检测失败',
    error.code === 'PROBE_FAILED',
    'provider',
    { cause: error },
  )
}

function linkShotVideo(
  database: ManjuDatabase,
  asset: MediaAssetRecord,
  input: ShotVideoJobInput,
  signal: AbortSignal,
  now: string,
): void {
  signal.throwIfAborted()
  const changed = database.withSql((sql) => sql.run(`
    UPDATE shots
    SET video_asset_id = ?, status = ?, updated_at = ?
    WHERE shots.id = ?
      AND shots.source_revision_id = ?
      AND shots.video_asset_id IS ?
      AND ${PUBLIC_SHOT_ID} = ?
      AND EXISTS (
        SELECT 1
        FROM scenes
        JOIN episodes ON episodes.id = scenes.episode_id
        WHERE scenes.id = shots.scene_id
          AND episodes.project_id = ?
          AND episodes.id = ?
          AND episodes.source_revision_id = ?
          AND ${PUBLIC_SCENE_ID} = ?
      )
  `,
  asset.id,
  SHOT_VIDEO_READY_STATUS,
  now,
  input.binding.databaseShotId,
  input.binding.expectedRevisionId,
  input.binding.expectedPreviousVideoAssetId,
  input.binding.shotId,
  asset.projectId,
  input.binding.episodeId,
  input.binding.expectedRevisionId,
  input.binding.sceneId,
  )).changes
  if (changed === 1) return

  const currentRevision = database.withSql((sql) => sql.get(`
    SELECT source_revision_id FROM episodes WHERE id = ? AND project_id = ?
  `, input.binding.episodeId, asset.projectId))?.source_revision_id
  if (currentRevision !== input.binding.expectedRevisionId) {
    throw new JobExecutionError(
      'STALE_SOURCE',
      '源剧本在视频生成期间已修改；新资产已回滚，原镜头链接保持不变',
      false,
      'validation',
    )
  }
  throw new JobExecutionError(
    'SHOT_VIDEO_LINK_CONFLICT',
    '镜头或其视频链接在生成期间已改变；新资产已回滚',
    false,
    'validation',
  )
}

async function bestEffortProviderCancel(
  database: ManjuDatabase,
  jobId: string,
  provider: SeedanceVideoProviderContract,
  externalTaskId: string | null,
  updatedAt: string,
): Promise<void> {
  let outcome: SeedanceCancellationOutcome | 'not-submitted' | 'request-failed'
  if (!externalTaskId) {
    outcome = 'not-submitted'
  } else {
    const timeout = AbortSignal.timeout(5_000)
    try {
      outcome = (await provider.cancelTask(externalTaskId, timeout)).outcome
    } catch {
      outcome = 'request-failed'
    }
  }
  // Cancellation occurs after JobWorker has already won the terminal-state
  // transition. Persist a safe audit result without reopening the job or
  // changing its immutable Provider binding. A persistence failure must not
  // hide the fact that local processing has stopped.
  try {
    database.transaction((transaction) => {
      const current = transaction.getGenerationJob(jobId)
      if (!current) return
      transaction.updateGenerationJob(jobId, {
        providerState: {
          ...current.providerState,
          cancellationCapability: provider.cancellationCapability,
          cancellationOutcome: outcome,
          cancellationUpdatedAt: updatedAt,
        },
      })
    })
  } catch {
    // Best-effort audit persistence cannot safely replace the terminal job
    // outcome. The public fallback remains conservative when this is absent.
  }
}

interface DurableJobStatusMonitor {
  signal: AbortSignal
  stop(): void
}

/**
 * Story edits stale jobs directly in the same database transaction, outside
 * JobWorker.cancel(). Observe that durable terminal state so an in-flight
 * Seedance poll is aborted and the accepted upstream task can be cancelled.
 */
function monitorDurableJobStatus(
  database: ManjuDatabase,
  jobId: string,
  intervalMs: number,
): DurableJobStatusMonitor {
  const controller = new AbortController()
  const inspect = () => {
    if (controller.signal.aborted) return
    try {
      const current = database.getGenerationJob(jobId)
      if (current && (current.status === 'running' || current.status === 'waiting_provider')) return
      controller.abort(new JobCancelledError(
        current?.error?.code === 'STALE_SOURCE'
          ? '源剧本已修改，Seedance 视频任务已停止'
          : 'Seedance 视频任务已在其他流程中停止',
      ))
    } catch (error) {
      controller.abort(error)
    }
  }
  inspect()
  const timer = controller.signal.aborted ? null : setInterval(inspect, intervalMs)
  timer?.unref()
  return {
    signal: controller.signal,
    stop() {
      if (timer) clearInterval(timer)
    },
  }
}

function validateDurableReferenceBindings(
  database: ManjuDatabase,
  projectId: string,
  input: ShotVideoJobInput,
): ShotVideoReferenceBinding[] {
  const references = input.references ?? []
  const current = createShotVideoReferenceBindings(database, {
    projectId,
    episodeId: input.binding.episodeId,
    sourceRevisionId: input.binding.expectedRevisionId,
    references: references.map(({ assetId, role }) => ({ assetId, role })),
  })
  if (current.length !== references.length
    || current.some((reference, index) => reference.assetId !== references[index]?.assetId
      || reference.role !== references[index]?.role
      || reference.version !== references[index]?.version
      || reference.checksum !== references[index]?.checksum
      || (references[index]?.sourceRevisionId !== undefined
        && reference.sourceRevisionId !== references[index]?.sourceRevisionId))) {
    throw new JobExecutionError(
      'STALE_VIDEO_REFERENCE_ASSET',
      '参考图绑定在任务创建后发生变化，未发起 Seedance 计费请求',
      false,
      'validation',
    )
  }
  if (input.referenceDecision && !validateCurrentAgenticReferenceDecision(database, {
    projectId,
    episodeId: input.binding.episodeId,
    sourceRevisionId: input.binding.expectedRevisionId,
    databaseShotId: input.binding.databaseShotId,
    decision: input.referenceDecision,
  })) {
    throw new JobExecutionError(
      'STALE_VIDEO_REFERENCE_RECOMMENDATION',
      '角色三视图槽位在任务创建后已变化，未发起 Seedance 计费请求',
      false,
      'validation',
    )
  }
  return current
}

async function loadProviderReferenceImages(
  mediaStore: MediaStore,
  references: readonly ShotVideoReferenceBinding[],
  signal: AbortSignal,
): Promise<SeedanceImageReference[]> {
  const result: SeedanceImageReference[] = []
  let totalBytes = 0
  for (const reference of references) {
    signal.throwIfAborted()
    let opened
    try {
      opened = await mediaStore.openAsset(reference.assetId)
    } catch (error) {
      if (error instanceof MediaStoreError) {
        throw new JobExecutionError(
          'VIDEO_REFERENCE_ASSET_UNAVAILABLE',
          '参考图文件不可用，未发起 Seedance 计费请求',
          false,
          'validation',
        )
      }
      throw error
    }
    try {
      if (opened.size > MAX_REFERENCE_IMAGE_BYTES
        || totalBytes + opened.size > MAX_REFERENCE_IMAGES_TOTAL_BYTES) {
        throw new JobExecutionError(
          'VIDEO_REFERENCE_ASSET_TOO_LARGE',
          '参考图超过 Seedance 请求体安全大小限制，未发起计费请求',
          false,
          'validation',
        )
      }
      const bytes = await opened.file.readFile()
      signal.throwIfAborted()
      if (bytes.byteLength !== opened.size
        || createHash('sha256').update(bytes).digest('hex') !== reference.checksum) {
        throw new JobExecutionError(
          'VIDEO_REFERENCE_ASSET_UNAVAILABLE',
          '参考图内容与不可变资产索引不一致，未发起 Seedance 计费请求',
          false,
          'validation',
        )
      }
      const parsedDimensions = imageDimensions(bytes, opened.mimeType)
      const width = parsedDimensions.width ?? opened.asset.width
      const height = parsedDimensions.height ?? opened.asset.height
      if (!Number.isInteger(width) || !Number.isInteger(height)
        || (width as number) < 300 || (width as number) > 6_000
        || (height as number) < 300 || (height as number) > 6_000
        || (width as number) / (height as number) <= 0.4
        || (width as number) / (height as number) >= 2.5) {
        throw new JobExecutionError(
          'INVALID_VIDEO_REFERENCE_ASSET',
          '参考图尺寸或宽高比不符合 Seedance 输入要求，未发起计费请求',
          false,
          'validation',
        )
      }
      totalBytes += bytes.byteLength
      result.push({
        url: `data:${opened.mimeType};base64,${bytes.toString('base64')}`,
        role: reference.role,
      })
    } finally {
      await opened.file.close().catch(() => undefined)
    }
  }
  return result
}

/**
 * Final synchronous paid-submission gate. Story mutations cancel downstream
 * jobs directly in SQLite, so JobHandlerContext.waitingForProvider() may have
 * lost a terminal-state race and returned after a no-op. Re-read both the job
 * transition and every mutable authority immediately before createTask().
 * There is deliberately no await between this check and invoking Provider I/O.
 */
function assertPaidProviderSubmissionAuthority(
  database: ManjuDatabase,
  durable: GenerationJobRecord,
  input: ShotVideoJobInput,
  detectedAt: string,
): void {
  database.transaction((transaction) => {
    const current = transaction.getGenerationJob(durable.id)
    if (!current) {
      throw new JobExecutionError('JOB_NOT_FOUND', '视频任务不存在，未发起 Seedance 计费请求', false, 'validation')
    }
    if (current.status === 'cancelled' || current.status === 'failed' || current.status === 'succeeded') {
      throw new JobCancelledError(
        current.error?.code === 'STALE_SOURCE'
          ? '源剧本已修改，未发起 Seedance 计费请求'
          : '视频任务已终止，未发起 Seedance 计费请求',
      )
    }
    if (current.status !== 'waiting_provider'
      || current.externalTaskId !== null
      || current.providerState.operation !== SHOT_VIDEO_GENERATION_JOB_TYPE
      || current.providerState.phase !== 'submitting'
      || current.providerState.clientRequestId !== durable.id
      || current.providerId !== durable.providerId
      || current.providerConfigRevision !== durable.providerConfigRevision
      || current.model !== durable.model) {
      throw new JobExecutionError(
        'PROVIDER_SUBMISSION_GATE_REJECTED',
        '视频任务未能固化付费提交状态，未发起 Seedance 计费请求',
        false,
        'internal',
      )
    }
    const target = resolveDurableTarget(transaction, durable.projectId, input)
    assertCurrentDurationDecision(
      transaction,
      target,
      input,
      'pre-submit',
      'not-started',
      detectedAt,
    )
    validateDurableReferenceBindings(transaction, durable.projectId, input)
  })
}

export function createShotVideoGenerationHandler(
  dependencies: ShotVideoHandlerDependencies,
): JobHandler<ShotVideoJobInput, JsonObject> {
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const maxConsecutivePollErrors = dependencies.maxConsecutivePollErrors
    ?? DEFAULT_MAX_CONSECUTIVE_POLL_ERRORS
  const durableStatusCheckIntervalMs = dependencies.durableStatusCheckIntervalMs
    ?? DEFAULT_DURABLE_STATUS_CHECK_INTERVAL_MS
  const totalDeadlineMs = dependencies.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60_000) {
    throw new RangeError('pollIntervalMs must be between 0 and 60000')
  }
  if (!Number.isInteger(maxConsecutivePollErrors) || maxConsecutivePollErrors < 0
    || maxConsecutivePollErrors > 20) {
    throw new RangeError('maxConsecutivePollErrors must be between 0 and 20')
  }
  if (!Number.isInteger(durableStatusCheckIntervalMs) || durableStatusCheckIntervalMs < 1
    || durableStatusCheckIntervalMs > 60_000) {
    throw new RangeError('durableStatusCheckIntervalMs must be between 1 and 60000')
  }
  if (!Number.isInteger(totalDeadlineMs) || totalDeadlineMs < 1
    || totalDeadlineMs > MAX_TOTAL_DEADLINE_MS) {
    throw new RangeError(`totalDeadlineMs must be between 1 and ${MAX_TOTAL_DEADLINE_MS}`)
  }
  const delay = dependencies.delay ?? abortableDelay
  const downloadVideo = dependencies.downloadVideo ?? downloadSeedanceVideo
  const probeVideo = dependencies.probeVideo ?? probeVideoMetadata
  const now = dependencies.now ?? (() => new Date().toISOString())

  return async (job: JobRecord<ShotVideoJobInput>, context): Promise<JsonObject> => {
    const deadlineSignal = AbortSignal.timeout(totalDeadlineMs)
    const handlerSignal = AbortSignal.any([context.signal, deadlineSignal])
    const input = validateJobInput(job.input)
    const durable = dependencies.database.getGenerationJob(job.id)
    if (!durable) throw new JobExecutionError('JOB_NOT_FOUND', '视频任务不存在', false, 'validation')
    if (!durable.providerId || durable.providerConfigRevision === null || !durable.model) {
      throw new JobExecutionError('PROVIDER_NOT_CONFIGURED', '任务绑定的 Seedance Provider 不存在', false, 'validation')
    }
    if (durable.episodeId !== input.binding.episodeId || durable.resourceId !== input.binding.shotId) {
      throw new JobExecutionError('INVALID_VIDEO_JOB', '视频任务与镜头归属不一致', false, 'validation')
    }
    const projectId = durable.projectId
    const alreadyPublished = recoverAlreadyPublishedAsset(dependencies.database, durable, input)
    if (alreadyPublished && durable.externalTaskId) {
      return successfulOutput(alreadyPublished, input, durable.externalTaskId)
    }
    const initialTarget = resolveDurableTarget(dependencies.database, projectId, input)
    try {
      const initialTaskId = durable.externalTaskId ?? checkpointTaskId(durable.providerState)
      assertCurrentDurationDecision(
        dependencies.database,
        initialTarget,
        input,
        'initial',
        initialTaskId ? 'task-exists' : 'not-started',
        now(),
      )
    } catch (error) {
      if (error instanceof StaleAudioTimingError) {
        persistTimingRemediation(dependencies.database, job.id, error.remediation)
      }
      throw error
    }
    const durableReferences = validateDurableReferenceBindings(
      dependencies.database,
      projectId,
      input,
    )

    let provider: SeedanceVideoProviderContract | null = null
    let cancellationCapability: SeedanceCancellationCapability | null = null
    let externalTaskId: string | null = durable.externalTaskId ?? checkpointTaskId(durable.providerState)
    let durableStatusMonitor: DurableJobStatusMonitor | null = null
    let executionSignal = handlerSignal
    try {
      provider = await awaitWithSignal(dependencies.resolveProvider(durable), handlerSignal)
      cancellationCapability = provider.cancellationCapability
      handlerSignal.throwIfAborted()
      if (!provider.configured || provider.model !== durable.model) {
        throw new JobExecutionError('PROVIDER_NOT_CONFIGURED', 'Seedance Provider 执行配置不匹配', false, 'validation')
      }

      const retryRecovery = recoverRetrySubmission(dependencies.database, durable)
      externalTaskId ??= retryRecovery.externalTaskId
      if (retryRecovery.requiresPaidReconfirmation) {
        throw new JobExecutionError(
          'STALE_AUDIO_TIMING',
          '原 Seedance 任务的音频时长合同已失效；不会续查或重用该任务，请重新预检并确认新的付费视频。',
          false,
          'validation',
        )
      }
      if (!externalTaskId && retryRecovery.terminalProviderTask) {
        throw new JobExecutionError(
          'PROVIDER_TASK_ALREADY_TERMINAL',
          '原 Seedance Provider 任务已终止；续查任务不会创建新的付费任务，请重新预检',
          false,
          'provider',
        )
      }
      if (!externalTaskId
        && (hasUnknownSubmissionOutcome(durable) || retryRecovery.outcomeUnknown)) {
        throw submissionOutcomeUnknownError()
      }

      if (!externalTaskId) {
        // Resolve and checksum every local reference before the non-idempotent
        // Provider POST checkpoint. No invalid/missing Asset can become a
        // billable Seedance request.
        const referenceImages = await loadProviderReferenceImages(
          dependencies.mediaStore,
          durableReferences,
          handlerSignal,
        )
        handlerSignal.throwIfAborted()
        await context.reportProgress(5, { stage: 'provider-submit' })
        await context.waitingForProvider({
          operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
          phase: 'submitting',
          providerSupportsIdempotency: false,
          clientRequestId: job.id,
          providerId: durable.providerId,
          providerConfigRevision: durable.providerConfigRevision,
          cancellationCapability,
          submittedAt: now(),
        })
        handlerSignal.throwIfAborted()
        assertPaidProviderSubmissionAuthority(dependencies.database, durable, input, now())
        try {
          const result = await provider.createTask({
            prompt: input.prompt,
            aspectRatio: input.aspectRatio,
            resolution: input.resolution,
            durationSeconds: input.durationSeconds,
            generateAudio: input.generateAudio,
            ...(referenceImages.length ? { referenceImages } : {}),
          }, handlerSignal)
          if (!result || typeof result.id !== 'string' || !result.id) {
            throw new Error('Seedance createTask returned no task id')
          }
          externalTaskId = result.id
        } catch (error) {
          if (context.signal.aborted) throw error
          if (error instanceof SeedanceProviderError && error.diagnostic) {
            persistSubmissionDiagnostic(
              dependencies.database,
              job.id,
              error.diagnostic,
              now(),
            )
          }
          // Ark's AccountOverdue and QuotaExceeded responses are explicit
          // rejected submissions: no task id was allocated and there is no
          // ambiguous billable task to recover. Preserve fail-closed handling
          // for every other create failure, including malformed 2xx responses
          // and transport errors.
          if (error instanceof SeedanceProviderError
            && (error.code === 'PROVIDER_BILLING_UNAVAILABLE'
              || error.code === 'PROVIDER_RATE_LIMITED')) {
            throw providerExecutionError(error)
          }
          // Validation/configuration happens before the durable `submitting`
          // checkpoint. Once createTask is invoked, even a network exception or
          // malformed 2xx body may mean the provider accepted a billed task.
          throw submissionOutcomeUnknownError(error)
        }
        const state: JsonObject = {
          operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
          phase: 'polling',
          externalTaskId,
          providerId: durable.providerId,
          providerConfigRevision: durable.providerConfigRevision,
          cancellationCapability,
          taskAcceptedAt: now(),
          pollCount: 0,
        }
        // Store the provider ID column and recovery cursor together before any
        // cancellation check. Even if local cancellation won the race, the
        // external task remains auditable and can receive best-effort DELETE.
        try {
          persistExternalCheckpoint(dependencies.database, job.id, externalTaskId, state)
        } catch (error) {
          if (error instanceof JobExecutionError && error.code === 'PROVIDER_TASK_CONFLICT') {
            throw error
          }
          // The paid task may exist even though its id could not be durably
          // checkpointed. This is the same manual-review boundary as a lost
          // create response and must not become an automatic retry.
          throw submissionOutcomeUnknownError(error)
        }
        await context.waitingForProvider(state)
      } else if (!durable.externalTaskId) {
        const state: JsonObject = {
          operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
          phase: 'polling',
          externalTaskId,
          providerId: durable.providerId,
          providerConfigRevision: durable.providerConfigRevision,
          cancellationCapability,
          recoveredAt: now(),
          pollCount: 0,
        }
        persistExternalCheckpoint(dependencies.database, job.id, externalTaskId, state)
        await context.waitingForProvider(state)
      } else {
        // Revalidate ownership before the first poll as well as on every later
        // checkpoint. A historical/manual row must not query an upstream task
        // already owned by another non-retry lineage.
        const state: JsonObject = {
          ...durable.providerState,
          operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
          phase: 'polling',
          externalTaskId,
          providerId: durable.providerId,
          providerConfigRevision: durable.providerConfigRevision,
          cancellationCapability,
        }
        persistExternalCheckpoint(dependencies.database, job.id, externalTaskId, state)
        await context.waitingForProvider(state)
      }

      durableStatusMonitor = monitorDurableJobStatus(
        dependencies.database,
        job.id,
        durableStatusCheckIntervalMs,
      )
      executionSignal = AbortSignal.any([handlerSignal, durableStatusMonitor.signal])
      executionSignal.throwIfAborted()

      let pollCount = 0
      let consecutiveErrors = 0
      let completedTask: SeedanceTask | null = null
      while (!completedTask) {
        executionSignal.throwIfAborted()
        pollCount += 1
        let task: SeedanceTask
        try {
          task = await provider.getTask(externalTaskId, executionSignal)
          executionSignal.throwIfAborted()
          consecutiveErrors = 0
        } catch (error) {
          if (executionSignal.aborted) throw executionSignal.reason ?? error
          const providerError = error instanceof SeedanceProviderError ? error : null
          if (!providerError?.retryable || consecutiveErrors >= maxConsecutivePollErrors) {
            if (providerError) throw providerExecutionError(providerError)
            throw error
          }
          consecutiveErrors += 1
          const state: JsonObject = {
            operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
            phase: 'polling',
            externalTaskId,
            providerId: durable.providerId,
            providerConfigRevision: durable.providerConfigRevision,
            cancellationCapability,
            pollCount,
            consecutiveErrors,
            lastErrorCode: providerError.code,
            lastPolledAt: now(),
          }
          persistExternalCheckpoint(dependencies.database, job.id, externalTaskId, state)
          await context.waitingForProvider(state)
          await context.reportProgress(Math.min(70, 10 + pollCount), {
            stage: 'provider-poll-retry',
            consecutiveErrors,
          })
          await delay(Math.min(pollIntervalMs * (2 ** (consecutiveErrors - 1)), 60_000), executionSignal)
          continue
        }

        const state: JsonObject = {
          operation: SHOT_VIDEO_GENERATION_JOB_TYPE,
          phase: task.status === 'succeeded' ? 'downloading' : 'polling',
          externalTaskId,
          providerId: durable.providerId,
          providerConfigRevision: durable.providerConfigRevision,
          cancellationCapability,
          pollCount,
          lastStatus: task.status,
          lastPolledAt: now(),
          ...(task.status === 'succeeded' ? { temporaryVideoUrlPresent: true } : {}),
        }
        // Never persist the temporary signed video URL itself.
        persistExternalCheckpoint(dependencies.database, job.id, externalTaskId, state)
        await context.waitingForProvider(state)

        if (task.status === 'failed') throw failedTaskError(task)
        if (task.status === 'cancelled') throw new JobCancelledError('Seedance 上游任务已取消')
        if (task.status === 'expired') throw expiredTaskError()
        if (task.status === 'succeeded') {
          completedTask = task
          break
        }
        await context.reportProgress(Math.min(70, task.status === 'queued' ? 10 + pollCount : 25 + pollCount), {
          stage: 'provider-poll',
          providerStatus: task.status,
          pollCount,
        })
        await delay(pollIntervalMs, executionSignal)
      }

      if (!completedTask.videoUrl) {
        throw new JobExecutionError('INVALID_VIDEO_RESPONSE', 'Seedance 未返回视频下载地址', true, 'provider')
      }
      await context.reportProgress(80, { stage: 'downloading-provider-output' })
      const downloaded = await downloadVideo(completedTask.videoUrl, executionSignal)
      executionSignal.throwIfAborted()
      await context.reportProgress(88, { stage: 'probing-provider-output' })
      let mediaProbe: VideoMetadataProbeResult
      try {
        mediaProbe = await probeVideo(downloaded.bytes, downloaded.mimeType, executionSignal)
      } catch (error) {
        if (executionSignal.aborted) throw executionSignal.reason ?? error
        if (error instanceof VideoMetadataProbeError) throw videoProbeExecutionError(error)
        throw error
      }
      validateProbedVideoSpecification(mediaProbe, input)
      executionSignal.throwIfAborted()
      // Re-resolve immediately before the atomic asset/link transaction. This
      // catches edits that occurred while Seedance was generating/downloading.
      const target = resolveDurableTarget(dependencies.database, projectId, input)
      const assetFamilyId = target.videoAssetId
        ? stableAssetIdForVersion(dependencies.database, projectId, target.videoAssetId)
        : null
      const generationParameters: JsonObject = {
        shotId: input.binding.shotId,
        sceneId: input.binding.sceneId,
        ...(assetFamilyId ? { assetFamilyId } : {}),
        prompt: input.prompt,
        durationSeconds: input.durationSeconds,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        generateAudio: input.generateAudio,
        ...(input.durationDecision ? {
          timelineDurationSeconds: input.durationDecision.timelineDurationSeconds,
          durationDecision: input.durationDecision as unknown as JsonObject,
        } : {}),
        audioPolicy: input.spec?.audioPolicy
          ?? (input.generateAudio ? 'provider_audio' : 'silent'),
        ...(input.spec ? {
          promptCompilerVersion: input.spec.promptCompilerVersion,
          videoGenerationSpec: input.spec as unknown as JsonObject,
          promptCompilerNotices: compileVideoGenerationPrompt(input.spec).notices,
        } : {}),
        ...(durableReferences.length ? {
          referenceAssets: durableReferences.map(({ assetId, role, version, checksum, sourceRevisionId }) => ({
            assetId,
            role,
            version,
            checksum,
            sourceRevisionId,
          })),
        } : {}),
        ...(input.referenceDecision ? {
          referenceDecision: input.referenceDecision as unknown as JsonObject,
        } : {}),
        publicationMode: input.publicationMode ?? 'replace_current',
        externalTaskId,
        providerStatus: completedTask.status,
        mediaProbe: {
          formatName: mediaProbe.formatName,
          durationSeconds: mediaProbe.durationSeconds,
          streamCount: mediaProbe.streamCount,
          video: {
            codec: mediaProbe.video.codec,
            width: mediaProbe.video.width,
            height: mediaProbe.video.height,
            frameRate: mediaProbe.video.frameRate,
          },
          audio: mediaProbe.audio.map((stream) => ({
            codec: stream.codec,
            sampleRate: stream.sampleRate,
            channels: stream.channels,
          })),
        },
        ...(completedTask.completionTokens !== null
          ? { completionTokens: completedTask.completionTokens }
          : {}),
      }
      const asset = await dependencies.mediaStore.save({
        projectId,
        episodeId: input.binding.episodeId,
        kind: SHOT_VIDEO_KIND,
        bytes: downloaded.bytes,
        mimeType: downloaded.mimeType,
        source: 'provider',
        providerId: durable.providerId,
        generationJobId: durable.id,
        generationParameters,
        sourceRevisionId: input.binding.expectedRevisionId,
        ...(target.videoAssetId ? { parentAssetId: target.videoAssetId } : {}),
        width: mediaProbe.video.width,
        height: mediaProbe.video.height,
        durationSeconds: mediaProbe.durationSeconds,
      }, {
        afterCreate(asset, transaction) {
          // The timing authority and the shot link are checked in the exact
          // SQLite transaction that publishes the immutable Asset. A speech
          // relink cannot race between validation and publication.
          const publicationTarget = resolveDurableTarget(transaction, projectId, input)
          assertCurrentDurationDecision(
            transaction,
            publicationTarget,
            input,
            'pre-publish',
            'task-exists',
            now(),
          )
          if (input.publicationMode !== 'evaluation_only') {
            linkShotVideo(transaction, asset, input, executionSignal, now())
          }
        },
      })
      dependencies.publishAsset?.(asset)
      await context.reportProgress(98, { stage: 'asset-published', assetId: asset.id })
      return successfulOutput(asset, input, externalTaskId)
    } catch (error) {
      if (error instanceof StaleAudioTimingError) {
        // A pre-publish drift is discovered inside MediaStore.save's SQLite
        // transaction. That transaction intentionally rolls back the Asset and
        // file first; persist the sanitized remediation in a fresh transaction.
        persistTimingRemediation(dependencies.database, job.id, error.remediation)
        if ((context.signal.aborted || durableStatusMonitor?.signal.aborted || deadlineSignal.aborted)
          && provider) {
          await bestEffortProviderCancel(
            dependencies.database,
            job.id,
            provider,
            externalTaskId,
            now(),
          )
        }
        // Timing drift is the authoritative terminal reason once detected; an
        // overlapping local abort must not hide the persisted remediation.
        throw error
      }
      if (context.signal.aborted) {
        if (provider) await bestEffortProviderCancel(
          dependencies.database,
          job.id,
          provider,
          externalTaskId,
          now(),
        )
        throw context.signal.reason ?? new JobCancelledError()
      }
      if (durableStatusMonitor?.signal.aborted) {
        if (provider) await bestEffortProviderCancel(
          dependencies.database,
          job.id,
          provider,
          externalTaskId,
          now(),
        )
        throw durableStatusMonitor.signal.reason ?? new JobCancelledError()
      }
      if (deadlineSignal.aborted) {
        if (provider) await bestEffortProviderCancel(
          dependencies.database,
          job.id,
          provider,
          externalTaskId,
          now(),
        )
        if (error instanceof JobExecutionError
          && error.code === PROVIDER_SUBMISSION_OUTCOME_UNKNOWN) throw error
        throw totalDeadlineError(externalTaskId, error)
      }
      throw error
    } finally {
      durableStatusMonitor?.stop()
    }
  }
}
