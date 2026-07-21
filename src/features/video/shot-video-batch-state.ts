import type {
  CreateShotVideoBatchInput,
  ShotVideoBatchPreflight,
  ShotVideoBatchPreflightInput,
  ShotVideoReferenceSelection,
  ShotVideoAudioPolicy,
  ShotVideoTimingRemediation,
} from '../../lib'

export interface ShotVideoReferenceCompatibilityIssue {
  shotId: string
  sceneId: string | null
  assetId: string
  role: 'first_frame' | 'last_frame' | 'reference_image'
  kind: string
  width: number | null
  height: number | null
  aspectRatio: number | null
  character: {
    id: string
    name: string
    view: 'front' | 'side' | 'back'
  } | null
  turnaroundSource: {
    assetId: string
    width: number
    height: number
    aspectRatio: number
  } | null
}

/**
 * Build the explicit multi-reference request used when a derived character
 * view falls outside Seedance's image envelope. The current storyboard stays
 * first as the shot/content anchor while the same-source turnaround sheet is
 * added as the character identity reference. Both must use reference_image:
 * Seedance does not allow first_frame and multi-reference roles in one task.
 */
export function wholeTurnaroundCompatibilityRecoveryReferences(
  input: {
    storyboardAssetId: string | null | undefined
    turnaroundAssetId: string
  },
  eligibleAssetIds: ReadonlySet<string>,
): ShotVideoReferenceSelection[] {
  if (!eligibleAssetIds.has(input.turnaroundAssetId)) return []
  const assetIds = [
    ...(input.storyboardAssetId
      && input.storyboardAssetId !== input.turnaroundAssetId
      && eligibleAssetIds.has(input.storyboardAssetId)
      ? [input.storyboardAssetId]
      : []),
    input.turnaroundAssetId,
  ]
  return assetIds.map((assetId) => ({ assetId, role: 'reference_image' }))
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function positiveIntegerOrNull(value: unknown): number | null | undefined {
  return value === null ? null : Number.isInteger(value) && (value as number) > 0 ? value as number : undefined
}

function positiveFiniteOrNull(value: unknown): number | null | undefined {
  return value === null ? null : typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Parses only the safe, actionable subset of a 422 reference diagnostic. */
export function parseShotVideoReferenceCompatibilityIssues(
  value: unknown,
): ShotVideoReferenceCompatibilityIssue[] {
  const details = record(value)
  if (!details || details.version !== 1 || !Array.isArray(details.issues)) return []
  return details.issues.flatMap((raw): ShotVideoReferenceCompatibilityIssue[] => {
    const issue = record(raw)
    if (!issue
      || typeof issue.shotId !== 'string'
      || (issue.sceneId !== null && typeof issue.sceneId !== 'string')
      || typeof issue.assetId !== 'string'
      || !['first_frame', 'last_frame', 'reference_image'].includes(String(issue.role))
      || typeof issue.kind !== 'string') return []
    const width = positiveIntegerOrNull(issue.width)
    const height = positiveIntegerOrNull(issue.height)
    const aspectRatio = positiveFiniteOrNull(issue.aspectRatio)
    if (width === undefined || height === undefined || aspectRatio === undefined) return []
    const rawCharacter = record(issue.character)
    const character = issue.character === null ? null
      : rawCharacter
        && typeof rawCharacter.id === 'string'
        && typeof rawCharacter.name === 'string'
        && ['front', 'side', 'back'].includes(String(rawCharacter.view))
        ? {
            id: rawCharacter.id,
            name: rawCharacter.name,
            view: rawCharacter.view as 'front' | 'side' | 'back',
          }
        : undefined
    const rawTurnaround = record(issue.turnaroundSource)
    const turnaroundSource = issue.turnaroundSource === null ? null
      : rawTurnaround
        && typeof rawTurnaround.assetId === 'string'
        && Number.isInteger(rawTurnaround.width) && (rawTurnaround.width as number) > 0
        && Number.isInteger(rawTurnaround.height) && (rawTurnaround.height as number) > 0
        && typeof rawTurnaround.aspectRatio === 'number'
        && Number.isFinite(rawTurnaround.aspectRatio)
        && rawTurnaround.aspectRatio > 0
        ? {
            assetId: rawTurnaround.assetId,
            width: rawTurnaround.width as number,
            height: rawTurnaround.height as number,
            aspectRatio: rawTurnaround.aspectRatio,
          }
        : undefined
    if (character === undefined || turnaroundSource === undefined) return []
    return [{
      shotId: issue.shotId,
      sceneId: issue.sceneId as string | null,
      assetId: issue.assetId,
      role: issue.role as ShotVideoReferenceCompatibilityIssue['role'],
      kind: issue.kind,
      width,
      height,
      aspectRatio,
      character,
      turnaroundSource,
    }]
  })
}

export type ShotVideoBatchAvailability = 'pending' | 'generated' | 'locked'

export interface ShotVideoBatchAvailabilityItem {
  shotId: string
  videoState: ShotVideoBatchAvailability
}

export interface ShotVideoBatchAvailabilitySummary {
  pending: number
  generated: number
  locked: number
}

export interface ShotVideoVisualAnalysisAuthorityInput {
  sourceRevisionId: string
  selections: readonly { shotId: string; sceneId: string }[]
  assets: readonly { id: string; version: number; checksum?: string | null }[]
  textProviderId?: string
  textProviderConfigRevision?: number
  textProviderModel?: string
  textProviderReady?: boolean
}

/** Exact, browser-local handoff from an audio remediation to stage 4. */
export interface ShotVideoTimingRepreflightRecovery {
  version: 1
  reason: 'stale_audio_timing'
  sourceJobId: string
  projectId: string
  episodeId: string
  shotId: string
  sceneId: string
  sourceRevisionId: string
  detectedAt: string
  providerSubmissionState: ShotVideoTimingRemediation['providerSubmissionState']
}

export interface ShotVideoTimingRemediationFocusTarget {
  sceneId: string
  shotId: string
  dialogueLineId: string
}

export function shotVideoTimingRepreflightRecovery(
  sourceJobId: string,
  remediation: ShotVideoTimingRemediation,
): ShotVideoTimingRepreflightRecovery {
  return {
    version: 1,
    reason: 'stale_audio_timing',
    sourceJobId,
    projectId: remediation.projectId,
    episodeId: remediation.episodeId,
    shotId: remediation.shotId,
    sceneId: remediation.sceneId,
    sourceRevisionId: remediation.sourceRevisionId,
    detectedAt: remediation.detectedAt,
    providerSubmissionState: remediation.providerSubmissionState,
  }
}

export function shotVideoTimingRemediationFocusLineId(
  remediation: ShotVideoTimingRemediation,
): string | null {
  const affected = remediation.affectedLines[0]?.dialogueLineId
  if (affected) return affected
  if (remediation.currentResolution.status === 'audio_required') {
    return remediation.currentResolution.blockedLines[0]?.dialogueLineId ?? null
  }
  if (remediation.currentResolution.status === 'requires_shot_split') {
    return remediation.currentResolution.speechBindings[0]?.dialogueLineId ?? null
  }
  return remediation.previousDecision.speechBindings[0]?.dialogueLineId ?? null
}

/**
 * A Story only requires shot IDs to be unique inside one scene and dialogue
 * IDs inside one shot. Recovery therefore carries the complete public scope;
 * a line ID by itself is never sufficient to focus UI state safely.
 */
export function shotVideoTimingRemediationFocusTarget(
  remediation: ShotVideoTimingRemediation,
): ShotVideoTimingRemediationFocusTarget | null {
  const dialogueLineId = shotVideoTimingRemediationFocusLineId(remediation)
  return dialogueLineId ? {
    sceneId: remediation.sceneId,
    shotId: remediation.shotId,
    dialogueLineId,
  } : null
}

/**
 * Forget only ambiguous local root leases whose complete scope is this one
 * shot. Multi-shot and other-scene leases are intentionally preserved.
 */
export function clearShotVideoBatchAttemptsForTimingRecovery(
  attempts: Map<string, string>,
  input: Pick<ShotVideoTimingRepreflightRecovery, 'projectId' | 'episodeId' | 'shotId' | 'sceneId'>,
): number {
  let removed = 0
  for (const cacheKey of attempts.keys()) {
    let candidate: unknown
    try {
      candidate = JSON.parse(cacheKey)
    } catch {
      continue
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as Record<string, unknown>
    if (record.projectId !== input.projectId || record.episodeId !== input.episodeId) continue
    if (!Array.isArray(record.selections) || record.selections.length !== 1) continue
    const selection = record.selections[0]
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) continue
    const scoped = selection as Record<string, unknown>
    if (scoped.shotId !== input.shotId) continue
    // Older single-shot cache keys may not have carried a scene. A concrete,
    // different scene is protected; a missing legacy scene is still this
    // globally identified shot and must not retain the stale timing lease.
    if (typeof scoped.sceneId === 'string' && scoped.sceneId !== input.sceneId) continue
    attempts.delete(cacheKey)
    removed += 1
  }
  return removed
}

/**
 * Browser-side invalidation key only. The server independently rebinds the
 * durable Job to the Story revision, candidate Asset checksums and Provider
 * revision before a paid preflight may consume it.
 */
export function shotVideoVisualAnalysisAuthorityKey(
  input: ShotVideoVisualAnalysisAuthorityInput,
): string {
  return JSON.stringify({
    version: 1,
    sourceRevisionId: input.sourceRevisionId,
    selections: [...input.selections]
      .map((selection) => ({ shotId: selection.shotId, sceneId: selection.sceneId }))
      .sort((left, right) => (
        left.sceneId.localeCompare(right.sceneId) || left.shotId.localeCompare(right.shotId)
      )),
    assets: [...input.assets]
      .map((asset) => ({
        id: asset.id,
        version: asset.version,
        checksum: asset.checksum ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    textProvider: {
      id: input.textProviderId ?? null,
      configRevision: input.textProviderConfigRevision ?? null,
      model: input.textProviderModel ?? null,
      ready: input.textProviderReady === true,
    },
  })
}

/** A succeeded Job is consumable only while its exact browser authority remains current. */
export function validShotVideoVisualAnalysisJobId(input: {
  jobId: string | null | undefined
  jobStatus: string | null | undefined
  jobAuthorityKey: string | null | undefined
  currentAuthorityKey: string
}): string | null {
  return input.jobId
    && input.jobStatus === 'succeeded'
    && input.jobAuthorityKey === input.currentAuthorityKey
    ? input.jobId
    : null
}

/** A background visual Job never blocks an explicit manual reference override. */
export function shotVideoVisualAnalysisBlocksPreflight(
  referenceControlMode: 'smart' | 'manual',
  visualAnalysisActive: boolean,
): boolean {
  return referenceControlMode === 'smart' && visualAnalysisActive
}

export interface ShotVideoVisualAnalysisTarget {
  shotId: string
  sceneId: string
}

/**
 * Shot IDs are only unique inside a scene. Every browser-side visual-analysis
 * binding therefore uses the complete public scope rather than a lossy
 * `shotId` dictionary key.
 */
export function shotVideoVisualAnalysisShotKey(
  input: Pick<ShotVideoVisualAnalysisTarget, 'sceneId' | 'shotId'>,
): string {
  return JSON.stringify([input.sceneId, input.shotId])
}

/**
 * Deep visual reasoning is an exception path, not the batch default. A batch
 * first uses the deterministic server preflight; once that preflight reports
 * ambiguous shots, the Agent sees only those shots. A one-shot entry point may
 * still opt into deep analysis directly.
 */
export function shotVideoVisualAnalysisTargets<T extends ShotVideoVisualAnalysisTarget>(
  selectedShots: readonly T[],
  manualRecoveryShotIds: ReadonlySet<string>,
): T[] {
  const ambiguous = selectedShots.filter((shot) => manualRecoveryShotIds.has(shot.shotId))
  if (ambiguous.length > 0) return ambiguous
  return selectedShots.length === 1 ? [selectedShots[0]!] : []
}

/** Pending work is the safe default; regeneration always requires an explicit click. */
export function defaultShotVideoBatchSelection(
  shots: readonly ShotVideoBatchAvailabilityItem[],
): string[] {
  return shots.filter((shot) => shot.videoState === 'pending').map((shot) => shot.shotId)
}

/**
 * A per-shot entry point must honor the shot the user clicked, including an
 * already-generated shot that is being regenerated. Batch entry points keep
 * the conservative pending-only default. Callers remove server-blocked shots
 * before invoking this helper.
 */
export function initialShotVideoBatchSelection(
  shots: readonly ShotVideoBatchAvailabilityItem[],
  initialShotId: string | null,
): string[] {
  if (initialShotId) {
    const selected = shots.find((shot) => (
      shot.shotId === initialShotId && shot.videoState !== 'locked'
    ))
    if (selected) return [selected.shotId]
  }
  return defaultShotVideoBatchSelection(shots)
}

export function summarizeShotVideoBatchAvailability(
  shots: readonly ShotVideoBatchAvailabilityItem[],
): ShotVideoBatchAvailabilitySummary {
  return shots.reduce<ShotVideoBatchAvailabilitySummary>((summary, shot) => ({
    ...summary,
    [shot.videoState]: summary[shot.videoState] + 1,
  }), { pending: 0, generated: 0, locked: 0 })
}

export type ShotVideoReferenceDraft =
  | { mode: 'text-to-video' }
  | { mode: 'frames'; firstFrameAssetId: string | null; lastFrameAssetId: string | null }
  | { mode: 'multi-reference'; assetIds: string[] }

export interface ShotVideoReferenceDraftResult {
  references: ShotVideoReferenceSelection[]
  issues: string[]
}

function normalizedAssetId(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

export function shotVideoAudioPolicy(
  input: Pick<ShotVideoBatchPreflightInput, 'audioPolicy' | 'generateAudio'>,
): ShotVideoAudioPolicy {
  return input.audioPolicy ?? (input.generateAudio === true ? 'provider_audio' : 'silent')
}

export function shotVideoPolicyGeneratesAudio(policy: ShotVideoAudioPolicy): boolean {
  return policy !== 'silent'
}

export function shotVideoPublicationMode(
  input: Pick<ShotVideoBatchPreflightInput, 'promptCompilerVersion' | 'publicationMode'>,
): 'replace_current' | 'evaluation_only' {
  return input.publicationMode
    ?? (input.promptCompilerVersion === 'seedance-verbose-baseline-v1'
      ? 'evaluation_only'
      : 'replace_current')
}

/** Converts the three mutually exclusive Seedance image modes into the strict API DTO. */
export function referencesFromShotVideoDraft(
  draft: ShotVideoReferenceDraft,
  eligibleAssetIds?: ReadonlySet<string>,
): ShotVideoReferenceDraftResult {
  const issues: string[] = []
  let references: ShotVideoReferenceSelection[] = []
  if (draft.mode === 'frames') {
    const firstFrameAssetId = normalizedAssetId(draft.firstFrameAssetId)
    const lastFrameAssetId = normalizedAssetId(draft.lastFrameAssetId)
    if (!firstFrameAssetId) issues.push('首尾帧模式必须选择首帧')
    if (firstFrameAssetId) references.push({ assetId: firstFrameAssetId, role: 'first_frame' })
    if (lastFrameAssetId) references.push({ assetId: lastFrameAssetId, role: 'last_frame' })
  } else if (draft.mode === 'multi-reference') {
    const assetIds = draft.assetIds.map(normalizedAssetId)
    if (assetIds.length < 1) issues.push('多参考模式至少选择 1 张图片')
    if (assetIds.length > 9) issues.push('Seedance 2.0 最多接受 9 张参考图')
    if (assetIds.some((assetId) => !assetId)) issues.push('参考图资产 ID 不能为空')
    if (new Set(assetIds).size !== assetIds.length) issues.push('多参考图不能重复选择同一资产')
    references = assetIds
      .filter(Boolean)
      .slice(0, 9)
      .map((assetId) => ({ assetId, role: 'reference_image' }))
  }
  if (eligibleAssetIds) {
    const unavailable = references.find((reference) => !eligibleAssetIds.has(reference.assetId))
    if (unavailable) issues.push('所选参考图已失效或不属于当前剧本修订')
  }
  return { references, issues }
}

export function shotVideoBatchConfigurationKey(
  episodeId: string,
  input: ShotVideoBatchPreflightInput,
): string {
  const audioPolicy = shotVideoAudioPolicy(input)
  const publicationMode = shotVideoPublicationMode(input)
  const referenceAnalysisJobId = (input as ShotVideoBatchPreflightInput & {
    referenceAnalysisJobId?: string
  }).referenceAnalysisJobId
  return JSON.stringify({
    version: 1,
    episodeId,
    projectId: input.projectId,
    providerId: input.providerId ?? null,
    resolution: input.resolution ?? '720p',
    promptCompilerVersion: input.promptCompilerVersion ?? 'seedance-compact-v1',
    publicationMode,
    audioPolicy,
    generateAudio: shotVideoPolicyGeneratesAudio(audioPolicy),
    referenceAnalysisJobId: referenceAnalysisJobId ?? null,
    selections: input.selections.map((selection) => ({
      shotId: selection.shotId,
      sceneId: selection.sceneId ?? null,
      durationSeconds: selection.durationSeconds ?? null,
      ...(selection.referenceAnalysisJobId
        ? { referenceAnalysisJobId: selection.referenceAnalysisJobId }
        : {}),
      referenceSource: selection.characterReferenceSelections
        ? 'manual_character_slots'
        : selection.references === undefined
          ? selection.referenceAnalysisJobId ? 'persisted_vision' : 'agentic_auto'
          : 'manual_override',
      references: selection.references?.map((reference) => ({ ...reference })) ?? null,
      characterReferenceSelections: selection.characterReferenceSelections?.map((selector) => ({ ...selector })) ?? null,
    })),
  })
}

export function shotVideoBatchPreflightMatches(
  preflight: ShotVideoBatchPreflight | null,
  episodeId: string,
  sourceRevisionId: string | null,
  input: ShotVideoBatchPreflightInput,
): preflight is ShotVideoBatchPreflight {
  const audioPolicy = shotVideoAudioPolicy(input)
  const publicationMode = shotVideoPublicationMode(input)
  const referenceAnalysisJobId = (input as ShotVideoBatchPreflightInput & {
    referenceAnalysisJobId?: string
  }).referenceAnalysisJobId
  if (!preflight
    || !sourceRevisionId
    || preflight.projectId !== input.projectId
    || preflight.episodeId !== episodeId
    || preflight.sourceRevisionId !== sourceRevisionId
    || preflight.resolution !== (input.resolution ?? '720p')
    || preflight.publicationMode !== publicationMode
    || preflight.audioPolicy !== audioPolicy
    || preflight.generateAudio !== shotVideoPolicyGeneratesAudio(audioPolicy)
    || Date.parse(preflight.expiresAt) <= Date.now()
    || preflight.billableTaskCount !== input.selections.length
    || (input.providerId !== undefined && preflight.provider.providerId !== input.providerId)) return false
  const promptCompilerVersion = input.promptCompilerVersion ?? 'seedance-compact-v1'
  if (preflight.targets.some((target) => target.promptCompilerVersion !== promptCompilerVersion)) return false
  return input.selections.every((selection, index) => {
    const target = preflight.targets[index]
    if (!target) return false
    if (target.shotId !== selection.shotId
      || (selection.sceneId !== undefined && target.sceneId !== selection.sceneId)
      || (selection.durationSeconds !== undefined && target.durationSeconds !== selection.durationSeconds)) return false
    if (!target.referenceDecision) return false
    const visionAnalysisJobId = (target.referenceDecision as typeof target.referenceDecision & {
      visionAnalysisJobId?: string
    }).visionAnalysisJobId
    const automaticReferenceSelection = !selection.characterReferenceSelections
      && selection.references === undefined
    const selectionReferenceAnalysisJobId = selection.referenceAnalysisJobId
      ?? referenceAnalysisJobId
    if (automaticReferenceSelection
      ? (selectionReferenceAnalysisJobId !== undefined
          ? visionAnalysisJobId !== selectionReferenceAnalysisJobId
          : visionAnalysisJobId !== undefined)
      : visionAnalysisJobId !== undefined) return false
    if (selection.characterReferenceSelections) {
      const pins = target.referenceDecision.manualCharacterSlotPins
      return target.referenceDecision.source === 'manual_override'
        && pins?.length === selection.characterReferenceSelections.length
        && selection.characterReferenceSelections.every((selector, selectorIndex) => (
          pins[selectorIndex]?.characterId === selector.characterId
          && pins[selectorIndex]?.view === selector.view
        ))
    }
    if (selection.references === undefined) return target.referenceDecision.source === 'agentic_auto'
    return target.referenceDecision.source === 'manual_override'
      && target.references.length === selection.references.length
      && target.references.every((reference, referenceIndex) => (
        reference.assetId === selection.references?.[referenceIndex]?.assetId
        && reference.role === selection.references?.[referenceIndex]?.role
      ))
  })
}

export function confirmedShotVideoBatchInput(
  preflight: ShotVideoBatchPreflight,
  episodeId: string,
  sourceRevisionId: string,
  input: ShotVideoBatchPreflightInput,
): CreateShotVideoBatchInput | null {
  if (!shotVideoBatchPreflightMatches(preflight, episodeId, sourceRevisionId, input)) return null
  return { ...input, confirmationToken: preflight.confirmationToken }
}

export interface ShotVideoBatchAttempt {
  cacheKey: string
  idempotencyKey: string
}

/** Keeps an ambiguous paid POST on the exact same root key until acknowledged. */
export function prepareShotVideoBatchAttempt(
  attempts: Map<string, string>,
  episodeId: string,
  input: ShotVideoBatchPreflightInput,
  createKey: () => string,
): ShotVideoBatchAttempt {
  const cacheKey = shotVideoBatchConfigurationKey(episodeId, input)
  const existing = attempts.get(cacheKey)
  if (existing) return { cacheKey, idempotencyKey: existing }
  const idempotencyKey = createKey()
  attempts.set(cacheKey, idempotencyKey)
  return { cacheKey, idempotencyKey }
}

export function completeShotVideoBatchAttempt(
  attempts: Map<string, string>,
  attempt: ShotVideoBatchAttempt,
): void {
  if (attempts.get(attempt.cacheKey) === attempt.idempotencyKey) {
    attempts.delete(attempt.cacheKey)
  }
}
