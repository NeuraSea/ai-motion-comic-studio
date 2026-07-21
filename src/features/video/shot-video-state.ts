import type { GenerationJob } from '../../lib'

export type ShotVideoViewStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'stale'

export interface ShotVideoViewState {
  status: ShotVideoViewStatus
  jobId: string | null
  progress: number
  asset: {
    id: string
    url: string
    mimeType: 'video/mp4' | 'video/webm'
    durationSeconds: number
  } | null
  error: string | null
  retryable: boolean
  manualReviewRequired: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStale(job: GenerationJob): boolean {
  return isRecord(job.progressDetail) && job.progressDetail.stale === true
}

function verifiedUnknownSubmissionResolution(job: GenerationJob): boolean {
  const resolution = job.unknownSubmissionResolution
  return job.error?.code === 'PROVIDER_SUBMISSION_CONFIRMED_NOT_CREATED'
    && isRecord(resolution)
    && resolution.version === 1
    && resolution.resolution === 'confirmed-not-created'
    && resolution.confirmedProviderConsoleChecked === true
    && resolution.jobId === job.id
    && resolution.projectId === job.projectId
    && resolution.episodeId === job.episodeId
    && resolution.shotId === job.resourceId
    && resolution.provider?.id === job.providerId
    && resolution.provider?.configRevision === job.providerConfigRevision
    && resolution.provider?.model === job.model
}

function unknownSubmissionNeedsReview(job: GenerationJob): boolean {
  // Error codes explain the incident, but only the server has the full retry
  // lineage/provider checkpoint needed to decide whether a new paid task is
  // safe. Never open generation based on a client-side error-code guess.
  return job.retryDisposition === 'manual-resolution'
}

function boundToShot(
  job: GenerationJob,
  target: { episodeId: string; shotId: string; sourceRevisionId: string | null },
): boolean {
  if (job.type !== 'shot.video.generate'
    || job.episodeId !== target.episodeId
    || !isRecord(job.input)
    || !isRecord(job.input.binding)) return false
  return job.input.binding.episodeId === target.episodeId
    && job.input.binding.shotId === target.shotId
    && (target.sourceRevisionId === null
      || job.input.binding.expectedRevisionId === target.sourceRevisionId)
}

/**
 * Prevents a second paid submission while one durable task is active or its
 * non-idempotent Provider POST has an unknown outcome. The server enforces the
 * same rule; this copy is only an early UX explanation.
 */
export function shotVideoCreationBlockReason(
  jobs: readonly GenerationJob[],
  target: { episodeId: string; shotId: string; sourceRevisionId: string | null },
): string | null {
  const candidates = jobs.filter((job) => boundToShot(job, target))
  const retriedJobIds = new Set(candidates.flatMap((job) => job.retryOf ? [job.retryOf] : []))
  const lineageLeaves = candidates.filter((job) => !retriedJobIds.has(job.id))
  if (lineageLeaves.some((job) => ['queued', 'running', 'waiting_provider'].includes(job.status))) {
    return '该镜头已有进行中的 Seedance 任务'
  }
  if (lineageLeaves.some(unknownSubmissionNeedsReview)) {
    return '上次 Provider 提交结果未知，为防止重复计费已锁定'
  }
  if (lineageLeaves.some((job) => (
    (job.status === 'failed' || job.status === 'cancelled')
    && job.retryDisposition === 'resume-existing-provider-task'
  ))) {
    return '该镜头存在仍需继续查询的原 Seedance 任务，不能重复付费提交'
  }
  return null
}

function outputAsset(job: GenerationJob): ShotVideoViewState['asset'] {
  if (!isRecord(job.output) || !isRecord(job.output.asset)) return null
  const asset = job.output.asset
  if (typeof asset.id !== 'string'
    || typeof asset.url !== 'string'
    || (asset.mimeType !== 'video/mp4' && asset.mimeType !== 'video/webm')
    || typeof asset.durationSeconds !== 'number'
    || !Number.isFinite(asset.durationSeconds)
    || asset.durationSeconds <= 0) return null
  return {
    id: asset.id,
    url: asset.url,
    mimeType: asset.mimeType,
    durationSeconds: asset.durationSeconds,
  }
}

function failedJobMessage(job: GenerationJob): string {
  if (verifiedUnknownSubmissionResolution(job)) {
    return '历史未知提交已由人工核对结案；未创建新任务，可重新进行权威预检。'
  }
  if (!unknownSubmissionNeedsReview(job)) {
    return job.error?.message ?? '视频生成失败'
  }
  const revision = Number.isInteger(job.providerConfigRevision)
    ? `（Provider r${job.providerConfigRevision}）`
    : ''
  // Older durable jobs named the Ark console even when the immutable task was
  // actually bound to a NewAPI gateway. Do not rewrite the audit row; project
  // a provider-neutral, revision-specific instruction in the UI instead.
  return `Seedance 提交结果未能确认${revision}。为避免重复计费，系统不会自动重提；请在该任务绑定的供应商控制台核对后人工处理。`
}

/**
 * Rebuilds one shot's video UI exclusively from durable v1 jobs. The current
 * Story revision is part of the match so a paid result from an older script is
 * never presented as the active clip.
 */
export function resolveShotVideoViewState(
  jobs: readonly GenerationJob[],
  target: { episodeId: string; shotId: string; sourceRevisionId: string | null },
): ShotVideoViewState {
  const candidates = jobs.filter((job) => boundToShot(job, target))
    .slice()
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  const latest = candidates[0]
  if (!latest) {
    return {
      status: 'idle',
      jobId: null,
      progress: 0,
      asset: null,
      error: null,
      retryable: false,
      manualReviewRequired: false,
    }
  }
  const asset = candidates.map(outputAsset).find((value) => value !== null) ?? null
  if (isStale(latest)) {
    return {
      status: 'stale',
      jobId: latest.id,
      progress: latest.progress,
      asset,
      error: '剧本已修改，该视频不再属于当前修订',
      retryable: false,
      manualReviewRequired: false,
    }
  }
  if (latest.status === 'succeeded' && asset) {
    return {
      status: 'ready',
      jobId: latest.id,
      progress: 100,
      asset,
      error: null,
      retryable: false,
      manualReviewRequired: false,
    }
  }
  if (latest.status === 'failed') {
    return {
      status: 'failed',
      jobId: latest.id,
      progress: latest.progress,
      asset,
      error: failedJobMessage(latest),
      retryable: latest.retryDisposition === 'resume-existing-provider-task',
      manualReviewRequired: unknownSubmissionNeedsReview(latest),
    }
  }
  if (latest.status === 'cancelled') {
    return {
      status: 'cancelled',
      jobId: latest.id,
      progress: latest.progress,
      asset,
      error: latest.cancellation?.message
        ?? latest.error?.message
        ?? '本地视频处理已停止；请核对上游任务与费用状态',
      retryable: latest.retryDisposition === 'resume-existing-provider-task',
      manualReviewRequired: false,
    }
  }
  return {
    status: latest.status === 'queued' ? 'queued' : 'running',
    jobId: latest.id,
    progress: latest.progress,
    asset,
    error: null,
    retryable: false,
    manualReviewRequired: false,
  }
}
