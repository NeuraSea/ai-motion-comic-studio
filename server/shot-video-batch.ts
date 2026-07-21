import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import type { GenerationJobRecord, ManjuDatabase } from './database.js'
import type { SeedanceImageRole, SeedanceResolution } from './providers/seedance.js'
import {
  compileVideoGenerationPrompt,
  isVideoPromptCompilerVersion,
  isVideoAudioPolicy,
  videoAudioPolicyGeneratesAudio,
  type VideoAudioPolicy,
  type VideoPromptCompilerVersion,
} from './video-generation-spec.js'
import {
  createShotVideoJobInput,
  createShotVideoReferenceBindings,
  resolvePublicShotVideoTarget,
  SHOT_VIDEO_GENERATION_JOB_TYPE,
  type ShotVideoReferenceBinding,
  type ShotVideoJobInput,
  type ShotVideoPublicationMode,
  type ShotVideoTarget,
} from './shot-video-generation.js'
import {
  resolveManualCharacterSlotSelectors,
  resolveShotVideoReferenceRecommendation,
  resolveShotVideoManualReferenceOptions,
  type ShotVideoReferenceDecision,
  type ShotVideoReferenceRecommendation,
  type ShotVideoManualCharacterSlotSelector,
} from './shot-video-reference-recommendation.js'
import { jobRetryDisposition } from './job-retry-policy.js'
import {
  resolveShotVideoDuration,
  type ShotVideoDurationDecision,
} from './shot-video-duration.js'
import { createShotVideoReferencePlan } from './shot-video-reference-plan.js'
import {
  resolvePersistedShotVideoVisionAssessment,
  ShotVideoVisualReferenceResolutionError,
} from './shot-video-visual-reference-job.js'
import type { JsonObject } from './types.js'
import { JobExecutionError } from './worker.js'

export const MAX_SHOT_VIDEO_BATCH_SIZE = 24
export const SHOT_VIDEO_BATCH_PREFLIGHT_TTL_SECONDS = 5 * 60

export interface ShotVideoReferenceSelection {
  assetId: string
  role: SeedanceImageRole
}

export interface ShotVideoBatchSelection {
  shotId: string
  sceneId?: string
  /** Omitted means audio-driven timing; present is an explicit advanced override. */
  durationSeconds?: number
  /** Succeeded visual-analysis Job scoped to this automatic selection. */
  referenceAnalysisJobId?: string
  /** Omitted means server Agentic selection; present (including []) is an explicit user override. */
  references?: ShotVideoReferenceSelection[]
  /** Safe manual path: the server resolves role slots; clients never submit their Asset IDs. */
  characterReferenceSelections?: ShotVideoManualCharacterSlotSelector[]
}

export interface ShotVideoBatchRequest {
  projectId: string
  episodeId: string
  providerId?: string
  resolution: SeedanceResolution
  /** Defaults to compact; verbose is reserved for controlled A/B baseline runs. */
  promptCompilerVersion?: VideoPromptCompilerVersion
  /** Evaluation assets remain reviewable versions and never replace the current Shot pointer. */
  publicationMode?: ShotVideoPublicationMode
  audioPolicy?: VideoAudioPolicy
  generateAudio: boolean
  /** Succeeded, revision-bound server Job. Raw visual plans are never accepted. */
  referenceAnalysisJobId?: string
  selections: ShotVideoBatchSelection[]
  confirmationToken?: string
}

export interface ShotVideoProviderBinding {
  providerId: string
  configRevision: number
  model: string
}

export type ShotVideoReferenceMode = 'text-to-video' | 'first-frame' | 'first-last-frame' | 'multi-reference'

export interface PreparedShotVideoBatchTarget {
  shotId: string
  sceneId: string
  durationSeconds: number
  timelineDurationSeconds: number
  durationDecision: ShotVideoDurationDecision
  referenceMode: ShotVideoReferenceMode
  references: ShotVideoReferenceBinding[]
  referenceDecision: ShotVideoReferenceDecision
  input: ShotVideoJobInput
}

export interface PreparedShotVideoBatch {
  version: 1
  requestFingerprint: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  resolution: SeedanceResolution
  publicationMode: ShotVideoPublicationMode
  audioPolicy: VideoAudioPolicy
  generateAudio: boolean
  provider: ShotVideoProviderBinding
  targets: PreparedShotVideoBatchTarget[]
}

export class ShotVideoBatchError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'INVALID_VIDEO_BATCH_REQUEST'
      | 'VIDEO_BATCH_IDEMPOTENCY_CONFLICT'
      | 'VIDEO_BATCH_PREFLIGHT_CHANGED'
      | 'VIDEO_BATCH_PREFLIGHT_EXPIRED'
      | 'VIDEO_BATCH_PREFLIGHT_REQUIRED'
      | 'VIDEO_GENERATION_ALREADY_ACTIVE'
      | 'VIDEO_SUBMISSION_OUTCOME_UNKNOWN'
      | 'VIDEO_REFERENCE_SELECTION_REQUIRED'
      | 'VIDEO_REFERENCE_ASSET_INCOMPATIBLE'
      | 'VIDEO_REFERENCE_ANALYSIS_NOT_FOUND'
      | 'VIDEO_REFERENCE_ANALYSIS_NOT_READY'
      | 'VIDEO_REFERENCE_ANALYSIS_STALE'
      | 'VIDEO_REFERENCE_ANALYSIS_INVALID'
      | 'VIDEO_AUDIO_PREREQUISITE_REQUIRED'
      | 'VIDEO_AUDIO_DURATION_REQUIRES_SHOT_SPLIT'
      | 'VIDEO_DURATION_SHORTER_THAN_AUDIO',
    message: string,
    readonly details?: JsonObject,
  ) {
    super(message)
    this.name = 'ShotVideoBatchError'
  }
}

/**
 * A fresh batch root must never create a second paid attempt for the same
 * immutable shot revision while another attempt is active or its paid POST
 * has an unresolved outcome. Exact child replay is the only exemption.
 */
export function assertNoConflictingShotVideoAttempts(
  database: ManjuDatabase,
  batch: Pick<PreparedShotVideoBatch, 'projectId' | 'episodeId' | 'sourceRevisionId' | 'targets'>,
  allowedJobIds: ReadonlySet<string> = new Set(),
): void {
  let hasActive = false
  let hasUnknownOutcome = false
  for (const target of batch.targets) {
    const rows = database.withSql((sql) => sql.all(`
      SELECT id
      FROM generation_jobs
      WHERE project_id = ?
        AND episode_id = ?
        AND type = ?
        AND resource_id = ?
        AND json_extract(input_json, '$.binding.expectedRevisionId') = ?
    `,
    batch.projectId,
    batch.episodeId,
    SHOT_VIDEO_GENERATION_JOB_TYPE,
    target.shotId,
    batch.sourceRevisionId,
    ))

    const jobs = rows.flatMap((row) => {
      if (typeof row.id !== 'string') return []
      const job = database.getGenerationJob(row.id)
      if (!job) {
        hasUnknownOutcome = true
        return []
      }
      return [job]
    })
    const byId = new Map(jobs.map((job) => [job.id, job]))
    const children = new Map<string, GenerationJobRecord[]>()
    for (const job of jobs) {
      if (!job.retryOf) continue
      const parent = byId.get(job.retryOf)
      if (!parent
        || parent.projectId !== job.projectId
        || parent.episodeId !== job.episodeId
        || parent.type !== job.type
        || parent.resourceId !== job.resourceId
        || parent.providerId !== job.providerId
        || parent.model !== job.model
        || parent.providerConfigRevision !== job.providerConfigRevision) {
        hasUnknownOutcome = true
        continue
      }
      const siblings = children.get(parent.id) ?? []
      siblings.push(job)
      children.set(parent.id, siblings)
      if (siblings.length > 1) hasUnknownOutcome = true
    }

    const leaves = jobs.filter((job) => !children.has(job.id))
    if (jobs.length > 0 && leaves.length === 0) hasUnknownOutcome = true
    for (const leaf of leaves) {
      const visited = new Set<string>()
      let current: GenerationJobRecord | undefined = leaf
      let exactReplay = false
      while (current) {
        if (visited.has(current.id)) {
          hasUnknownOutcome = true
          break
        }
        visited.add(current.id)
        if (allowedJobIds.has(current.id)) exactReplay = true
        if (!current.retryOf) break
        current = byId.get(current.retryOf)
        if (!current) {
          hasUnknownOutcome = true
          break
        }
      }
      // The confirmed batch route is replaying this exact immutable child, so
      // it will not create another attempt for this shot lineage.
      if (exactReplay) continue

      if (leaf.status === 'queued'
        || leaf.status === 'running'
        || leaf.status === 'waiting_provider') {
        hasActive = true
        continue
      }
      const disposition = jobRetryDisposition(database, leaf)
      if (disposition === 'resume-existing-provider-task') {
        // This includes locally-cancelled Seedance work whose accepted task is
        // still running, as well as failed polling/download attempts. A fresh
        // root is unsafe; only the explicit retry child may poll the old id.
        hasActive = true
        continue
      }
      if (disposition === 'manual-resolution') {
        hasUnknownOutcome = true
      }
    }
  }
  if (hasUnknownOutcome) {
    throw new ShotVideoBatchError(
      409,
      'VIDEO_SUBMISSION_OUTCOME_UNKNOWN',
      '该镜头存在 Seedance 提交结果未确认的历史任务；请先在供应商控制台人工核对并解锁，系统不会重复付费提交',
    )
  }
  if (hasActive) {
    throw new ShotVideoBatchError(
      409,
      'VIDEO_GENERATION_ALREADY_ACTIVE',
      '该镜头的当前剧本修订已有视频任务在执行，或存在必须继续查询的原 Provider 任务',
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', `${label} 必须是字符串`)
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)) {
    throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', `${label} 格式无效`)
  }
  return normalized
}

function parseReferences(value: unknown, path: string): ShotVideoReferenceSelection[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 9) {
    throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', `${path} 必须是最多 9 项的数组`)
  }
  return value.map((item, index) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['assetId', 'role'])) {
      throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', `${path}[${index}] 格式无效`)
    }
    if (item.role !== 'first_frame' && item.role !== 'last_frame' && item.role !== 'reference_image') {
      throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', `${path}[${index}].role 无效`)
    }
    return {
      assetId: identifier(item.assetId, `${path}[${index}].assetId`),
      role: item.role,
    }
  })
}

/** Strict public DTO parser shared by preflight and confirmed creation. */
export function parseShotVideoBatchRequest(
  body: unknown,
  episodeIdValue: unknown,
  options: { confirmation: 'forbidden' | 'required' },
): ShotVideoBatchRequest {
  if (!isRecord(body) || !hasOnlyKeys(body, [
    'projectId',
    'providerId',
    'resolution',
    'promptCompilerVersion',
    'publicationMode',
    'audioPolicy',
    'generateAudio',
    'referenceAnalysisJobId',
    'selections',
    'confirmationToken',
  ])) {
    throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', '视频批量请求必须是严格 JSON 对象')
  }
  const episodeId = identifier(episodeIdValue, 'episodeId')
  const projectId = identifier(body.projectId, 'projectId')
  const providerId = body.providerId === undefined ? undefined : identifier(body.providerId, 'providerId')
  const referenceAnalysisJobId = body.referenceAnalysisJobId === undefined
    ? undefined
    : identifier(body.referenceAnalysisJobId, 'referenceAnalysisJobId')
  const resolution = body.resolution ?? '720p'
  if (resolution !== '480p' && resolution !== '720p' && resolution !== '1080p') {
    throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', 'resolution 必须是 480p、720p 或 1080p')
  }
  const promptCompilerVersion = body.promptCompilerVersion === undefined
    ? undefined
    : body.promptCompilerVersion
  if (promptCompilerVersion !== undefined && !isVideoPromptCompilerVersion(promptCompilerVersion)) {
    throw new ShotVideoBatchError(
      400,
      'INVALID_VIDEO_BATCH_REQUEST',
      'promptCompilerVersion 必须是 seedance-compact-v1 或 seedance-verbose-baseline-v1',
    )
  }
  if (body.publicationMode !== undefined
    && body.publicationMode !== 'replace_current'
    && body.publicationMode !== 'evaluation_only') {
    throw new ShotVideoBatchError(
      400,
      'INVALID_VIDEO_BATCH_REQUEST',
      'publicationMode 必须是 replace_current 或 evaluation_only',
    )
  }
  if (promptCompilerVersion === 'seedance-verbose-baseline-v1'
    && body.publicationMode === 'replace_current') {
    throw new ShotVideoBatchError(
      400,
      'INVALID_VIDEO_BATCH_REQUEST',
      'A/B 长 Prompt 基线只能保存为验收候选，不能替换当前镜头',
    )
  }
  if (body.audioPolicy !== undefined && !isVideoAudioPolicy(body.audioPolicy)) {
    throw new ShotVideoBatchError(
      400,
      'INVALID_VIDEO_BATCH_REQUEST',
      'audioPolicy 必须是 sfx_only、silent 或 provider_audio',
    )
  }
  if (body.generateAudio !== undefined && typeof body.generateAudio !== 'boolean') {
    throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', 'generateAudio 必须是布尔值')
  }
  const audioPolicy: VideoAudioPolicy = isVideoAudioPolicy(body.audioPolicy)
    ? body.audioPolicy
    : body.generateAudio === true
      ? 'provider_audio'
      : 'silent'
  const generateAudio = videoAudioPolicyGeneratesAudio(audioPolicy)
  if (body.generateAudio !== undefined && body.generateAudio !== generateAudio) {
    throw new ShotVideoBatchError(
      400,
      'INVALID_VIDEO_BATCH_REQUEST',
      'generateAudio 与 audioPolicy 冲突',
    )
  }
  if (!Array.isArray(body.selections)
    || body.selections.length < 1
    || body.selections.length > MAX_SHOT_VIDEO_BATCH_SIZE) {
    throw new ShotVideoBatchError(
      400,
      'INVALID_VIDEO_BATCH_REQUEST',
      `selections 必须包含 1 到 ${MAX_SHOT_VIDEO_BATCH_SIZE} 个镜头`,
    )
  }
  const selections = body.selections.map((item, index): ShotVideoBatchSelection => {
    if (!isRecord(item) || !hasOnlyKeys(item, [
      'shotId', 'sceneId', 'durationSeconds', 'referenceAnalysisJobId', 'references',
      'characterReferenceSelections',
    ])) {
      throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', `selections[${index}] 格式无效`)
    }
    const sceneId = item.sceneId === undefined ? undefined : identifier(item.sceneId, `selections[${index}].sceneId`)
    const selectionReferenceAnalysisJobId = item.referenceAnalysisJobId === undefined
      ? undefined
      : identifier(item.referenceAnalysisJobId, `selections[${index}].referenceAnalysisJobId`)
    let durationSeconds: number | undefined
    if (item.durationSeconds !== undefined) {
      if (!Number.isInteger(item.durationSeconds)
        || (item.durationSeconds as number) < 4
        || (item.durationSeconds as number) > 15) {
        throw new ShotVideoBatchError(
          400,
          'INVALID_VIDEO_BATCH_REQUEST',
          `selections[${index}].durationSeconds 必须是 4 到 15 的整数`,
        )
      }
      durationSeconds = item.durationSeconds as number
    }
    if (Object.hasOwn(item, 'references') && Object.hasOwn(item, 'characterReferenceSelections')) {
      throw new ShotVideoBatchError(
        400,
        'INVALID_VIDEO_BATCH_REQUEST',
        `selections[${index}] 不能同时提交通用参考图与角色槽位选择`,
      )
    }
    if (selectionReferenceAnalysisJobId !== undefined
      && (Object.hasOwn(item, 'references') || Object.hasOwn(item, 'characterReferenceSelections'))) {
      throw new ShotVideoBatchError(
        400,
        'INVALID_VIDEO_BATCH_REQUEST',
        `selections[${index}].referenceAnalysisJobId 仅适用于自动参考图选择`,
      )
    }
    let characterReferenceSelections: ShotVideoManualCharacterSlotSelector[] | undefined
    if (Object.hasOwn(item, 'characterReferenceSelections')) {
      if (!Array.isArray(item.characterReferenceSelections)
        || item.characterReferenceSelections.length < 1
        || item.characterReferenceSelections.length > 9) {
        throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', `selections[${index}].characterReferenceSelections 无效`)
      }
      characterReferenceSelections = item.characterReferenceSelections.map((selector, selectorIndex) => {
        if (!isRecord(selector)
          || !hasOnlyKeys(selector, ['characterId', 'view'])
          || !['front', 'side', 'back'].includes(String(selector.view))) {
          throw new ShotVideoBatchError(
            400,
            'INVALID_VIDEO_BATCH_REQUEST',
            `selections[${index}].characterReferenceSelections[${selectorIndex}] 无效`,
          )
        }
        return {
          characterId: identifier(selector.characterId, `selections[${index}].characterReferenceSelections[${selectorIndex}].characterId`),
          view: selector.view as ShotVideoManualCharacterSlotSelector['view'],
        }
      })
      if (new Set(characterReferenceSelections.map((selector) => selector.characterId)).size
        !== characterReferenceSelections.length) {
        throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', '同一角色只能选择一个视角槽位')
      }
    }
    return {
      shotId: identifier(item.shotId, `selections[${index}].shotId`),
      ...(sceneId ? { sceneId } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(selectionReferenceAnalysisJobId ? { referenceAnalysisJobId: selectionReferenceAnalysisJobId } : {}),
      ...(Object.hasOwn(item, 'references')
        ? { references: parseReferences(item.references, `selections[${index}].references`) }
        : {}),
      ...(characterReferenceSelections ? { characterReferenceSelections } : {}),
    }
  })
  if (referenceAnalysisJobId !== undefined
    && selections.some((selection) => selection.referenceAnalysisJobId !== undefined)) {
    throw new ShotVideoBatchError(
      400,
      'INVALID_VIDEO_BATCH_REQUEST',
      '不能同时提交批次级与分镜级 referenceAnalysisJobId',
    )
  }
  const targetKeys = selections.map((selection) => `${selection.sceneId ?? ''}\u0000${selection.shotId}`)
  if (new Set(targetKeys).size !== targetKeys.length) {
    throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', '同一镜头不能在一个批次中重复提交')
  }

  let confirmationToken: string | undefined
  if (options.confirmation === 'forbidden') {
    if (Object.hasOwn(body, 'confirmationToken')) {
      throw new ShotVideoBatchError(400, 'INVALID_VIDEO_BATCH_REQUEST', '预检请求不接受 confirmationToken')
    }
  } else {
    if (typeof body.confirmationToken !== 'string'
      || !/^svpf1_[1-9][0-9]{9,12}_[a-f0-9]{64}$/.test(body.confirmationToken)) {
      throw new ShotVideoBatchError(
        428,
        'VIDEO_BATCH_PREFLIGHT_REQUIRED',
        '请先完成 Seedance 批量计费预检并确认任务范围',
      )
    }
    confirmationToken = body.confirmationToken
  }
  return {
    projectId,
    episodeId,
    ...(providerId ? { providerId } : {}),
    resolution,
    ...(promptCompilerVersion ? { promptCompilerVersion } : {}),
    ...(body.publicationMode === 'replace_current' || body.publicationMode === 'evaluation_only'
      ? { publicationMode: body.publicationMode }
      : {}),
    audioPolicy,
    generateAudio,
    ...(referenceAnalysisJobId ? { referenceAnalysisJobId } : {}),
    selections,
    ...(confirmationToken ? { confirmationToken } : {}),
  }
}

export function shotVideoBatchRequestFingerprint(request: ShotVideoBatchRequest): string {
  const audioPolicy = request.audioPolicy
    ?? (request.generateAudio ? 'provider_audio' : 'silent')
  const publicationMode: ShotVideoPublicationMode = request.publicationMode
    ?? (request.promptCompilerVersion === 'seedance-verbose-baseline-v1'
      ? 'evaluation_only'
      : 'replace_current')
  if (request.promptCompilerVersion === 'seedance-verbose-baseline-v1'
    && publicationMode !== 'evaluation_only') {
    throw new ShotVideoBatchError(
      400,
      'INVALID_VIDEO_BATCH_REQUEST',
      'A/B 长 Prompt 基线只能保存为验收候选，不能替换当前镜头',
    )
  }
  const includePublicationMode = request.publicationMode !== undefined
    || request.promptCompilerVersion === 'seedance-verbose-baseline-v1'
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    projectId: request.projectId,
    episodeId: request.episodeId,
    providerId: request.providerId ?? null,
    resolution: request.resolution,
    ...(request.promptCompilerVersion !== undefined
      ? { promptCompilerVersion: request.promptCompilerVersion }
      : {}),
    ...(includePublicationMode ? { publicationMode } : {}),
    audioPolicy,
    generateAudio: request.generateAudio,
    referenceAnalysisJobId: request.referenceAnalysisJobId ?? null,
    selections: request.selections.map((selection) => ({
      shotId: selection.shotId,
      sceneId: selection.sceneId ?? null,
      durationSeconds: selection.durationSeconds ?? null,
      // Keep legacy top-level-only fingerprints byte-for-byte stable by
      // omitting this new key when an old request did not contain it.
      ...(selection.referenceAnalysisJobId !== undefined
        ? { referenceAnalysisJobId: selection.referenceAnalysisJobId }
        : {}),
      referenceSource: selection.characterReferenceSelections
        ? 'manual_character_slots'
        : selection.references === undefined ? 'agentic_auto' : 'manual_override',
      references: selection.references?.map((reference) => ({ ...reference })) ?? null,
      characterReferenceSelections: selection.characterReferenceSelections?.map((selector) => ({ ...selector })) ?? null,
    })),
  })).digest('hex')
}

function referenceMode(references: readonly ShotVideoReferenceSelection[]): ShotVideoReferenceMode {
  if (references.length === 0) return 'text-to-video'
  if (references.every((reference) => reference.role === 'reference_image')) return 'multi-reference'
  return references.some((reference) => reference.role === 'last_frame')
    ? 'first-last-frame'
    : 'first-frame'
}

function currentStoryboardAnchorAssetId(
  database: ManjuDatabase,
  target: ShotVideoTarget,
): string | null {
  if (!target.storyboardAssetId) return null
  try {
    return createShotVideoReferenceBindings(database, {
      projectId: target.projectId,
      episodeId: target.episodeId,
      sourceRevisionId: target.sourceRevisionId,
      references: [{ assetId: target.storyboardAssetId, role: 'first_frame' }],
    })[0]?.assetId ?? null
  } catch (error) {
    // A stale pointer must enter the same manual-recovery path as a missing
    // pointer. Do not duplicate the paid-path Asset predicate here: the
    // binding resolver is the single source of truth for image eligibility.
    if (error instanceof JobExecutionError && error.code === 'INVALID_VIDEO_REFERENCE_ASSET') {
      return null
    }
    throw error
  }
}

type ShotVideoReferenceRecoveryReason =
  | 'VIEW_SELECTION_REQUIRED'
  | 'REFERENCE_IMAGE_LIMIT_EXCEEDED'
  | 'RELATED_CHARACTER_LIMIT_EXCEEDED'
  | 'SLOT_SELECTION_STALE'

function shotVideoReferenceRecoveryError(
  database: ManjuDatabase,
  target: ShotVideoTarget,
  recommendation: ShotVideoReferenceRecommendation,
  reasonCode: Exclude<ShotVideoReferenceRecoveryReason, 'RELATED_CHARACTER_LIMIT_EXCEEDED'>,
  message: string,
): ShotVideoBatchError {
  const manualSelection = resolveShotVideoManualReferenceOptions(database, target, recommendation)
  const relatedCharacterLimitExceeded = !manualSelection.selectionPolicy.slotSelectionAllowed
  const effectiveReason: ShotVideoReferenceRecoveryReason = relatedCharacterLimitExceeded
    ? 'RELATED_CHARACTER_LIMIT_EXCEEDED'
    : reasonCode
  const effectiveMessage = relatedCharacterLimitExceeded
    ? `镜头 ${target.publicShotId} 明确关联 ${manualSelection.characters.length} 个角色，超过 Seedance 9 张参考图上限；不能要求你选择全部角色，请拆镜或明确使用纯文本模式`
    : message
  return new ShotVideoBatchError(
    409,
    'VIDEO_REFERENCE_SELECTION_REQUIRED',
    effectiveMessage,
    {
      shotId: target.publicShotId,
      sceneId: target.publicSceneId,
      reasonCode: effectiveReason,
      maximumReferenceImages: 9,
      slotSelectionAllowed: manualSelection.selectionPolicy.slotSelectionAllowed,
      recoveryActions: manualSelection.selectionPolicy.slotSelectionAllowed
        ? ['SELECT_LOCKED_CHARACTER_SLOTS', 'USE_TEXT_ONLY', 'REFRESH_ASSET_LIBRARY']
        : ['USE_TEXT_ONLY', 'SPLIT_SHOT'],
      recommendation: recommendation as unknown as JsonObject,
      manualSelection: manualSelection as unknown as JsonObject,
    },
  )
}

export function prepareShotVideoBatch(
  database: ManjuDatabase,
  request: ShotVideoBatchRequest,
  provider: ShotVideoProviderBinding,
): PreparedShotVideoBatch {
  const requestFingerprint = shotVideoBatchRequestFingerprint(request)
  const audioPolicy = request.audioPolicy
    ?? (request.generateAudio ? 'provider_audio' : 'silent')
  const publicationMode: ShotVideoPublicationMode = request.publicationMode
    ?? (request.promptCompilerVersion === 'seedance-verbose-baseline-v1'
      ? 'evaluation_only'
      : 'replace_current')
  const unresolvedReferenceShots: JsonObject[] = []
  const incompatibleReferenceShots: JsonObject[] = []
  const targets = request.selections.flatMap((selection, selectionIndex): PreparedShotVideoBatchTarget[] => {
    try {
      const target = resolvePublicShotVideoTarget(database, {
      projectId: request.projectId,
      episodeId: request.episodeId,
      shotId: selection.shotId,
      ...(selection.sceneId ? { sceneId: selection.sceneId } : {}),
      })
      const durationResolution = resolveShotVideoDuration(database, target, {
      ...(selection.durationSeconds !== undefined
        ? { manualProviderDurationSeconds: selection.durationSeconds }
        : {}),
      })
      if (durationResolution.status === 'audio_required') {
        throw new ShotVideoBatchError(
        409,
        'VIDEO_AUDIO_PREREQUISITE_REQUIRED',
        `镜头 ${target.publicShotId} 必须先生成完整台词/旁白音频，再决定视频时长`,
        {
          shotId: target.publicShotId,
          blockedLines: durationResolution.blockedLines,
        } as unknown as JsonObject,
      )
      }
      if (durationResolution.status === 'requires_shot_split') {
        throw new ShotVideoBatchError(
        409,
        'VIDEO_AUDIO_DURATION_REQUIRES_SHOT_SPLIT',
        `镜头 ${target.publicShotId} 的实测语音为 ${durationResolution.speechDurationSeconds.toFixed(3)} 秒，超过 Seedance 单镜 15 秒上限；请先拆镜，系统不会变速或截断语音`,
        {
          shotId: target.publicShotId,
          speechDurationSeconds: durationResolution.speechDurationSeconds,
          maximumProviderDurationSeconds: durationResolution.maximumProviderDurationSeconds,
          dialogueLineIds: durationResolution.speechBindings.map((binding) => binding.dialogueLineId),
        },
      )
      }
      if (durationResolution.status === 'manual_duration_too_short') {
        throw new ShotVideoBatchError(
        409,
        'VIDEO_DURATION_SHORTER_THAN_AUDIO',
        `镜头 ${target.publicShotId} 指定的 ${durationResolution.requestedDurationSeconds} 秒小于实测语音 ${durationResolution.speechDurationSeconds.toFixed(3)} 秒`,
        {
          shotId: target.publicShotId,
          requestedDurationSeconds: durationResolution.requestedDurationSeconds,
          speechDurationSeconds: durationResolution.speechDurationSeconds,
        },
      )
      }
      const durationDecision = durationResolution.decision
      const recommendation = resolveShotVideoReferenceRecommendation(database, target)
      const storyboardAnchorAssetId = currentStoryboardAnchorAssetId(database, target)
      const manualSlotSelection = selection.characterReferenceSelections !== undefined
      const automatic = selection.references === undefined && !manualSlotSelection
      const effectiveReferenceAnalysisJobId = selection.referenceAnalysisJobId
        ?? request.referenceAnalysisJobId
      const automaticReferencePlan = automatic
        ? (() => {
            let persistedVisionAssessment
            if (effectiveReferenceAnalysisJobId) {
              try {
                persistedVisionAssessment = resolvePersistedShotVideoVisionAssessment(database, {
                  jobId: effectiveReferenceAnalysisJobId,
                  projectId: request.projectId,
                  episodeId: request.episodeId,
                  sourceRevisionId: target.sourceRevisionId,
                  shotId: target.publicShotId,
                  sceneId: target.publicSceneId,
                })
              } catch (error) {
                if (error instanceof ShotVideoVisualReferenceResolutionError) {
                  throw new ShotVideoBatchError(409, error.code, error.message, {
                    shotId: target.publicShotId,
                    sceneId: target.publicSceneId,
                    referenceAnalysisJobId: effectiveReferenceAnalysisJobId,
                    recoveryActions: ['RUN_VISUAL_REFERENCE_ANALYSIS'],
                  })
                }
                throw error
              }
            }
            return createShotVideoReferencePlan(database, {
              target,
              recommendation,
              storyboardAnchorAssetId,
              ...(persistedVisionAssessment ? { persistedVisionAssessment } : {}),
            })
          })()
        : null
      if (automaticReferencePlan?.status === 'manual_required') {
        throw shotVideoReferenceRecoveryError(
          database,
          target,
          recommendation,
          automaticReferencePlan.reasonCode === 'REFERENCE_IMAGE_LIMIT_EXCEEDED'
            ? 'REFERENCE_IMAGE_LIMIT_EXCEEDED'
            : 'VIEW_SELECTION_REQUIRED',
          `镜头 ${target.publicShotId}：${automaticReferencePlan.rationale}`,
        )
      }
      const automaticReferences: ShotVideoReferenceSelection[] = automaticReferencePlan?.status === 'ready'
        ? automaticReferencePlan.selectedReferences.map((reference) => ({ ...reference }))
        : []
      const manualCharacterSlotPins = manualSlotSelection
        ? resolveManualCharacterSlotSelectors(
          database,
          target,
          recommendation,
          selection.characterReferenceSelections ?? [],
          )
        : null
      if (manualSlotSelection && !manualCharacterSlotPins) {
        throw shotVideoReferenceRecoveryError(
          database,
          target,
          recommendation,
          'SLOT_SELECTION_STALE',
        `镜头 ${target.publicShotId} 的角色视角槽位已变化或选择不完整，请重新选择`,
        )
      }
      const selectedReferences = automatic
        ? automaticReferences
        : manualCharacterSlotPins
          ? manualCharacterSlotPins.map((pin) => ({ assetId: pin.assetId, role: 'reference_image' as const }))
          : selection.references ?? []
      const references = createShotVideoReferenceBindings(database, {
      projectId: request.projectId,
      episodeId: request.episodeId,
      sourceRevisionId: target.sourceRevisionId,
      references: selectedReferences,
      })
      const referenceDecision: ShotVideoReferenceDecision = {
      version: 1,
      source: automatic ? 'agentic_auto' : 'manual_override',
      ...(automatic
        ? {
            automaticPolicy: automaticReferencePlan?.assessmentSource ?? 'deterministic_safety',
            ...(effectiveReferenceAnalysisJobId
              ? { visionAnalysisJobId: effectiveReferenceAnalysisJobId }
              : {}),
          }
        : {}),
      resolution: automatic
        ? automaticReferencePlan?.safeStoryboardFallback
          && automaticReferences.length === 1
          && automaticReferences[0]?.assetId === storyboardAnchorAssetId
          && automaticReferences[0]?.role === 'first_frame'
          ? 'storyboard_anchor'
          : automaticReferences.length > 0
            ? 'character_views'
            : 'not_applicable'
        : 'manual_override',
      recommendation,
      storyboardAnchorAssetId: automatic ? storyboardAnchorAssetId : null,
      selectedReferences: selectedReferences.map((reference) => ({ ...reference })),
      ...(manualCharacterSlotPins ? { manualCharacterSlotPins } : {}),
      }
      const input = createShotVideoJobInput(target, {
      resolution: request.resolution,
      promptCompilerVersion: request.promptCompilerVersion,
      ...(publicationMode === 'evaluation_only'
        ? { publicationMode: 'evaluation_only' as const }
        : {}),
      audioPolicy,
      durationDecision,
      references,
      referenceDecision,
      batch: {
        version: 1,
        requestFingerprint,
        selectionIndex,
        selectionCount: request.selections.length,
      },
      })
      return [{
        shotId: target.publicShotId,
        sceneId: target.publicSceneId,
        durationSeconds: input.durationSeconds,
        timelineDurationSeconds: durationDecision.timelineDurationSeconds,
        durationDecision,
        referenceMode: referenceMode(selectedReferences),
        references: references.map((reference) => ({ ...reference })),
        referenceDecision,
        input,
      }]
    } catch (error) {
      if (error instanceof ShotVideoBatchError
        && error.code === 'VIDEO_REFERENCE_SELECTION_REQUIRED'
        && error.details) {
        unresolvedReferenceShots.push({
          ...error.details,
          message: error.message,
        })
        return []
      }
      if (error instanceof JobExecutionError
        && error.code === 'INVALID_VIDEO_REFERENCE_ASSET'
        && error.diagnostics
        && typeof error.diagnostics.compatibilityIssue === 'object'
        && error.diagnostics.compatibilityIssue !== null
        && !Array.isArray(error.diagnostics.compatibilityIssue)) {
        incompatibleReferenceShots.push({
          shotId: selection.shotId,
          sceneId: selection.sceneId ?? null,
          message: error.message,
          ...(error.diagnostics.compatibilityIssue as JsonObject),
        })
        return []
      }
      throw error
    }
  })
  if (incompatibleReferenceShots.length > 0) {
    const first = incompatibleReferenceShots[0]
    const character = first.character && typeof first.character === 'object' && !Array.isArray(first.character)
      ? first.character as JsonObject
      : null
    const view = character?.view === 'front' ? '正面'
      : character?.view === 'side' ? '侧面'
        : character?.view === 'back' ? '背面' : '参考'
    const label = typeof character?.name === 'string' ? `${character.name}${view}图` : '参考图'
    const dimensions = Number.isInteger(first.width) && Number.isInteger(first.height)
      ? `（${first.width}×${first.height}，宽高比 ${Number(first.aspectRatio).toFixed(3)}）`
      : ''
    throw new ShotVideoBatchError(
      422,
      'VIDEO_REFERENCE_ASSET_INCOMPATIBLE',
      incompatibleReferenceShots.length === 1
        ? `镜头 ${String(first.shotId)} 的${label}${dimensions}不符合 Seedance 输入要求；未创建计费任务`
        : `${incompatibleReferenceShots.length} 个镜头包含不符合 Seedance 输入要求的参考图；已列出具体图片，未创建计费任务`,
      {
        version: 1,
        issues: incompatibleReferenceShots,
        constraints: first.constraints ?? null,
        recoveryActions: ['USE_TURNAROUND_SOURCE', 'REDERIVE_WITH_FFMPEG_SAFE_CANVAS'],
      },
    )
  }
  if (unresolvedReferenceShots.length > 0) {
    const first = unresolvedReferenceShots[0]
    throw new ShotVideoBatchError(
      409,
      'VIDEO_REFERENCE_SELECTION_REQUIRED',
      unresolvedReferenceShots.length === 1
        ? String(first.message)
        : `${unresolvedReferenceShots.length} 个镜头需要确认角色参考；已一次返回全部待处理镜头，不会创建付费任务`,
      {
        version: 1,
        unresolvedShots: unresolvedReferenceShots,
        // Backward compatibility for clients that only understand one-shot
        // recovery. New clients consume unresolvedShots in one round trip.
        shotId: first.shotId,
        sceneId: first.sceneId,
        reasonCode: first.reasonCode,
        maximumReferenceImages: first.maximumReferenceImages,
        slotSelectionAllowed: first.slotSelectionAllowed,
        recoveryActions: first.recoveryActions,
        recommendation: first.recommendation,
        manualSelection: first.manualSelection,
      },
    )
  }
  const revisions = new Set(targets.map((target) => target.input.binding.expectedRevisionId))
  if (revisions.size !== 1) {
    throw new ShotVideoBatchError(409, 'VIDEO_BATCH_PREFLIGHT_CHANGED', '批量镜头未绑定同一份剧本修订')
  }
  return {
    version: 1,
    requestFingerprint,
    projectId: request.projectId,
    episodeId: request.episodeId,
    sourceRevisionId: targets[0].input.binding.expectedRevisionId,
    resolution: request.resolution,
    publicationMode,
    audioPolicy,
    generateAudio: request.generateAudio,
    provider: { ...provider },
    targets,
  }
}

interface ShotVideoBatchConfirmationContext {
  rootIdempotencyKey: string
  expiresAtEpochSeconds: number
}

function confirmationAuthenticatedPayload(
  batch: PreparedShotVideoBatch,
  context: ShotVideoBatchConfirmationContext,
) {
  if (!context.rootIdempotencyKey.trim()) throw new TypeError('rootIdempotencyKey must not be empty')
  if (!Number.isSafeInteger(context.expiresAtEpochSeconds) || context.expiresAtEpochSeconds <= 0) {
    throw new TypeError('expiresAtEpochSeconds must be a positive safe integer')
  }
  return {
    version: batch.version,
    requestFingerprint: batch.requestFingerprint,
    projectId: batch.projectId,
    episodeId: batch.episodeId,
    sourceRevisionId: batch.sourceRevisionId,
    resolution: batch.resolution,
    publicationMode: batch.publicationMode,
    audioPolicy: batch.audioPolicy,
    generateAudio: batch.generateAudio,
    provider: batch.provider,
    inputs: batch.targets.map((target) => target.input),
    rootIdempotencyKey: context.rootIdempotencyKey,
    expiresAtEpochSeconds: context.expiresAtEpochSeconds,
  }
}

export function shotVideoBatchConfirmationToken(
  secret: Buffer,
  batch: PreparedShotVideoBatch,
  context: ShotVideoBatchConfirmationContext,
): string {
  const authenticated = confirmationAuthenticatedPayload(batch, context)
  return `svpf1_${context.expiresAtEpochSeconds}_${createHmac('sha256', secret)
    .update(JSON.stringify(authenticated))
    .digest('hex')}`
}

export type ShotVideoBatchConfirmationVerification = 'valid' | 'expired' | 'invalid'

/** Authenticate the embedded expiry and root key before admitting any paid jobs. */
export function verifyShotVideoBatchConfirmationToken(
  secret: Buffer,
  batch: PreparedShotVideoBatch,
  token: string,
  rootIdempotencyKey: string,
  nowEpochSeconds: number,
): ShotVideoBatchConfirmationVerification {
  const match = /^svpf1_([1-9][0-9]{9,12})_([a-f0-9]{64})$/.exec(token)
  if (!match || !Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 0) return 'invalid'
  const expiresAtEpochSeconds = Number(match[1])
  if (!Number.isSafeInteger(expiresAtEpochSeconds)) return 'invalid'
  const authenticated = confirmationAuthenticatedPayload(batch, {
    rootIdempotencyKey,
    expiresAtEpochSeconds,
  })
  const actualMac = Buffer.from(match[2], 'hex')
  const expectedMac = createHmac('sha256', secret)
    .update(JSON.stringify(authenticated))
    .digest()
  if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) return 'invalid'
  return nowEpochSeconds >= expiresAtEpochSeconds ? 'expired' : 'valid'
}

export function shotVideoBatchPreflightAsJson(
  batch: PreparedShotVideoBatch,
  confirmationToken: string,
  expiresAt: string,
): JsonObject {
  return {
    version: 1,
    projectId: batch.projectId,
    episodeId: batch.episodeId,
    sourceRevisionId: batch.sourceRevisionId,
    resolution: batch.resolution,
    publicationMode: batch.publicationMode,
    audioPolicy: batch.audioPolicy,
    generateAudio: batch.generateAudio,
    provider: { ...batch.provider },
    billableTaskCount: batch.targets.length,
    totalRequestedSeconds: batch.targets.reduce((total, target) => total + target.durationSeconds, 0),
    priceEstimate: null,
    priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE',
    targets: batch.targets.map((target) => ({
      shotId: target.shotId,
      sceneId: target.sceneId,
      durationSeconds: target.durationSeconds,
      timelineDurationSeconds: target.timelineDurationSeconds,
      durationDecision: target.durationDecision as unknown as JsonObject,
      referenceMode: target.referenceMode,
      references: target.references.map((reference) => ({ ...reference })),
      referenceDecision: target.referenceDecision as unknown as JsonObject,
      promptPreview: target.input.prompt,
      promptCompilerVersion: target.input.spec?.promptCompilerVersion
        ?? 'seedance-compact-v1',
      promptCompilerNotices: target.input.spec
        ? compileVideoGenerationPrompt(target.input.spec).notices
        : [],
    })),
    expiresAt,
    confirmationToken,
  }
}

/** Deterministic child key: a root key can identify only one batch fingerprint. */
export function shotVideoBatchChildIdempotencyKey(
  projectId: string,
  rootIdempotencyKey: string,
  selectionIndex: number,
): string {
  const digest = createHash('sha256')
    .update(`${projectId}\u0000${rootIdempotencyKey}\u0000${selectionIndex}`)
    .digest('hex')
  return `svb1_${digest}`
}

export function assertShotVideoBatchChild(
  job: GenerationJobRecord,
  batch: Pick<PreparedShotVideoBatch, 'projectId' | 'episodeId' | 'requestFingerprint' | 'targets'>,
  selectionIndex: number,
): void {
  const input = job.input as unknown as Partial<ShotVideoJobInput>
  const binding = input.batch
  if (job.type !== SHOT_VIDEO_GENERATION_JOB_TYPE
    || job.projectId !== batch.projectId
    || job.episodeId !== batch.episodeId
    || job.resourceId !== batch.targets[selectionIndex]?.shotId
    || !binding
    || binding.version !== 1
    || binding.requestFingerprint !== batch.requestFingerprint
    || binding.selectionIndex !== selectionIndex
    || binding.selectionCount !== batch.targets.length) {
    throw new ShotVideoBatchError(
      409,
      'VIDEO_BATCH_IDEMPOTENCY_CONFLICT',
      'Idempotency-Key 已用于另一个 Seedance 批量请求',
    )
  }
}

/** Validate an exact replay without rereading mutable shot video cursors. */
export function assertExistingShotVideoBatchChild(
  job: GenerationJobRecord,
  request: ShotVideoBatchRequest,
  selectionIndex: number,
): void {
  const input = job.input as unknown as Partial<ShotVideoJobInput>
  const binding = input.binding
  const batch = input.batch
  const selection = request.selections[selectionIndex]
  const fingerprint = shotVideoBatchRequestFingerprint(request)
  if (!selection
    || job.type !== SHOT_VIDEO_GENERATION_JOB_TYPE
    || job.projectId !== request.projectId
    || job.episodeId !== request.episodeId
    || job.resourceId !== selection.shotId
    || !binding
    || binding.episodeId !== request.episodeId
    || binding.shotId !== selection.shotId
    || (selection.sceneId !== undefined && binding.sceneId !== selection.sceneId)
    || !batch
    || batch.version !== 1
    || batch.requestFingerprint !== fingerprint
    || batch.selectionIndex !== selectionIndex
    || batch.selectionCount !== request.selections.length) {
    throw new ShotVideoBatchError(
      409,
      'VIDEO_BATCH_IDEMPOTENCY_CONFLICT',
      'Idempotency-Key 已用于另一个 Seedance 批量请求',
    )
  }
}
