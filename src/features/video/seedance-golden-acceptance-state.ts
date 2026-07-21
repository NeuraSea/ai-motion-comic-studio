import type { GenerationJob } from '../../lib'

export type SeedanceGoldenShotStatus =
  | 'candidate-missing'
  | 'baseline-missing'
  | 'baseline-running'
  | 'baseline-failed'
  | 'pair-ready'

export interface SeedanceGoldenShotTarget {
  shotId: string
  code: string
}

export interface SeedanceGoldenProviderIdentity {
  providerId: string
  model: string
  configRevision: number
}

export interface SeedanceGoldenShotItem {
  shotId: string
  code: string
  status: SeedanceGoldenShotStatus
  candidateJobId: string | null
  historicalCandidateJobId: string | null
  baselineJobId: string | null
  baselineError: string | null
  baselineErrorCode: string | null
  baselineProviderCode: string | null
  baselineHttpStatus: number | null
  candidateProvider: SeedanceGoldenProviderIdentity | null
}

export interface SeedanceGoldenFailureSummary {
  code: string
  providerCode: string | null
  httpStatus: number | null
  count: number
}

export interface SeedanceGoldenAcceptanceState {
  items: SeedanceGoldenShotItem[]
  candidateReady: number
  historicalCandidateReady: number
  baselineReady: number
  baselineRunning: number
  baselineFailed: number
  failures: SeedanceGoldenFailureSummary[]
  candidateProvider: SeedanceGoldenProviderIdentity | null
  candidateProviderConsistent: boolean
  currentProviderCompatible: boolean
  providerMismatchReason: string | null
  targetCount: number
  pairSetReady: boolean
}

type ShotVideoJobFacts = {
  job: GenerationJob
  shotId: string
  strategy: 'candidate' | 'baseline'
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function shotVideoFacts(
  job: GenerationJob,
  episodeId: string,
  sourceRevisionId: string,
): ShotVideoJobFacts | null {
  if (job.type !== 'shot.video.generate' || job.episodeId !== episodeId) return null
  const input = record(job.input)
  const binding = record(input?.binding)
  const spec = record(input?.spec)
  if (!input || !binding || !spec
    || binding.episodeId !== episodeId
    || binding.expectedRevisionId !== sourceRevisionId
    || spec.sourceRevisionId !== sourceRevisionId
    || typeof binding.shotId !== 'string') return null
  if (spec.promptCompilerVersion === 'seedance-compact-v1'
    && input.publicationMode === undefined) {
    return { job, shotId: binding.shotId, strategy: 'candidate' }
  }
  if (spec.promptCompilerVersion === 'seedance-verbose-baseline-v1'
    && input.publicationMode === 'evaluation_only') {
    return { job, shotId: binding.shotId, strategy: 'baseline' }
  }
  return null
}

function latest(jobs: readonly GenerationJob[]): GenerationJob | null {
  return jobs.reduce<GenerationJob | null>((current, job) => (
    !current || Date.parse(job.createdAt) > Date.parse(current.createdAt) ? job : current
  ), null)
}

function successful(job: GenerationJob | null): boolean {
  if (!job || job.status !== 'succeeded' || !job.externalTaskId) return false
  const output = record(job.output)
  const asset = record(output?.asset)
  return typeof asset?.id === 'string' && asset.id.length > 0
}

function active(job: GenerationJob | null): boolean {
  return job?.status === 'queued' || job?.status === 'running'
}

function providerIdentity(job: GenerationJob | null): SeedanceGoldenProviderIdentity | null {
  if (!job
    || typeof job.providerId !== 'string'
    || !job.providerId
    || typeof job.model !== 'string'
    || !job.model
    || typeof job.providerConfigRevision !== 'number'
    || !Number.isSafeInteger(job.providerConfigRevision)
    || job.providerConfigRevision < 1) return null
  return {
    providerId: job.providerId,
    model: job.model,
    configRevision: job.providerConfigRevision,
  }
}

function sameProvider(
  left: SeedanceGoldenProviderIdentity,
  right: SeedanceGoldenProviderIdentity,
): boolean {
  return left.providerId === right.providerId
    && left.model === right.model
    && left.configRevision === right.configRevision
}

function errorSummary(job: GenerationJob | null): string | null {
  if (!job?.error) return null
  const rawError = record(job.error)
  const providerCode = typeof rawError?.providerCode === 'string' ? rawError.providerCode : null
  return providerCode ? `${job.error.code} · ${providerCode}` : job.error.code
}

function errorFacts(job: GenerationJob | null): Omit<SeedanceGoldenFailureSummary, 'count'> | null {
  if (!job?.error) return null
  const rawError = record(job.error)
  return {
    code: job.error.code,
    providerCode: typeof rawError?.providerCode === 'string' ? rawError.providerCode : null,
    httpStatus: typeof rawError?.httpStatus === 'number' && Number.isSafeInteger(rawError.httpStatus)
      ? rawError.httpStatus
      : null,
  }
}

/**
 * Read-only projection of the persisted Seedance evidence. This intentionally
 * does not claim that a pair passed the authoritative controlled-variable
 * verifier; it only makes missing paid baselines and their durable state
 * visible in the production UI.
 */
export function buildSeedanceGoldenAcceptanceState(input: {
  episodeId: string
  sourceRevisionId: string
  shots: readonly SeedanceGoldenShotTarget[]
  jobs: readonly GenerationJob[]
  currentProvider?: SeedanceGoldenProviderIdentity | null
}): SeedanceGoldenAcceptanceState {
  const currentProvider = input.currentProvider ?? null
  const targetIds = new Set(input.shots.map((shot) => shot.shotId))
  const facts = input.jobs.flatMap((job) => {
    const value = shotVideoFacts(job, input.episodeId, input.sourceRevisionId)
    return value && targetIds.has(value.shotId) ? [value] : []
  })
  const items = input.shots.map<SeedanceGoldenShotItem>((shot) => {
    const successfulCandidates = facts.filter((item) => (
      item.shotId === shot.shotId && item.strategy === 'candidate' && successful(item.job)
    )).map((item) => item.job)
    // Golden is a controlled comparison under the currently executable
    // Provider identity. Historical successes remain visible evidence, but
    // they must never make the current candidate counter look complete.
    const candidate = currentProvider
      ? latest(successfulCandidates.filter((job) => {
          const identity = providerIdentity(job)
          return identity ? sameProvider(identity, currentProvider) : false
        }))
      : null
    const historicalCandidate = latest(successfulCandidates.filter((job) => {
      const identity = providerIdentity(job)
      return !currentProvider || !identity || !sameProvider(identity, currentProvider)
    }))
    const candidateIdentity = providerIdentity(candidate)
    const baselineJobs = candidateIdentity
      ? facts.filter((item) => (
          item.shotId === shot.shotId
          && item.strategy === 'baseline'
          && (() => {
            const identity = providerIdentity(item.job)
            return identity ? sameProvider(identity, candidateIdentity) : false
          })()
        )).map((item) => item.job)
      : []
    const readyBaseline = latest(baselineJobs.filter(successful))
    const activeBaseline = latest(baselineJobs.filter(active))
    const latestBaseline = latest(baselineJobs)
    const status: SeedanceGoldenShotStatus = !candidate
      ? 'candidate-missing'
      : readyBaseline
        ? 'pair-ready'
        : activeBaseline
          ? 'baseline-running'
          : latestBaseline?.status === 'failed' || latestBaseline?.status === 'cancelled'
            ? 'baseline-failed'
            : 'baseline-missing'
    const failure = status === 'baseline-failed' ? errorFacts(latestBaseline) : null
    return {
      shotId: shot.shotId,
      code: shot.code,
      status,
      candidateJobId: candidate?.id ?? null,
      historicalCandidateJobId: historicalCandidate?.id ?? null,
      baselineJobId: (readyBaseline ?? activeBaseline ?? latestBaseline)?.id ?? null,
      baselineError: status === 'baseline-failed' ? errorSummary(latestBaseline) : null,
      baselineErrorCode: failure?.code ?? null,
      baselineProviderCode: failure?.providerCode ?? null,
      baselineHttpStatus: failure?.httpStatus ?? null,
      candidateProvider: providerIdentity(candidate),
    }
  })
  const candidateReady = items.filter((item) => item.candidateJobId !== null).length
  // “Historical candidate” is the non-overlapping recovery coverage for shots
  // that still lack a candidate under the executable Provider identity. A
  // shot may retain older successful Jobs after migration, but once its
  // current-Provider candidate exists it must not be counted in both totals.
  const historicalCandidateReady = items.filter((item) => (
    item.candidateJobId === null && item.historicalCandidateJobId !== null
  )).length
  const baselineReady = items.filter((item) => item.status === 'pair-ready').length
  const baselineRunning = items.filter((item) => item.status === 'baseline-running').length
  const baselineFailed = items.filter((item) => item.status === 'baseline-failed').length
  const candidateProviders = items.flatMap((item) => item.candidateProvider ? [item.candidateProvider] : [])
  const candidateProvider = candidateProviders[0] ?? null
  const candidateProviderConsistent = Boolean(candidateProvider)
    && candidateProviders.length === candidateReady
    && candidateProviders.every((value) => sameProvider(value, candidateProvider))
  const currentProviderCompatible = Boolean(
    candidateProviderConsistent
    && candidateProvider
    && currentProvider
    && sameProvider(candidateProvider, currentProvider),
  )
  const providerMismatchReason = !currentProvider && historicalCandidateReady > 0
    ? '当前没有可执行的 Seedance Provider；历史 candidate 只能保留审计，不能创建新的同身份 baseline。'
    : currentProvider && candidateReady < items.length && historicalCandidateReady > 0
      ? `当前 ${currentProvider.model} · Provider r${currentProvider.configRevision} 的 compact candidate 只有 ${candidateReady}/${items.length}；另有 ${historicalCandidateReady} 镜来自历史 Provider 身份，不会混入 Golden。`
      : candidateReady > 0 && !candidateProviderConsistent
      ? '当前 candidate 没有统一、完整的 Provider / 模型 / revision 身份，不能创建单变量 baseline。'
      : candidateReady > 0 && !currentProviderCompatible
          ? `当前 candidate 使用 ${candidateProvider!.model} · Provider r${candidateProvider!.configRevision}，但当前配置是 ${currentProvider!.model} · Provider r${currentProvider!.configRevision}。Golden 只允许 Prompt 策略不同。`
          : null
  const failureCounts = new Map<string, SeedanceGoldenFailureSummary>()
  for (const item of items) {
    if (!item.baselineErrorCode) continue
    const key = JSON.stringify([
      item.baselineErrorCode,
      item.baselineProviderCode,
      item.baselineHttpStatus,
    ])
    const current = failureCounts.get(key)
    if (current) current.count += 1
    else failureCounts.set(key, {
      code: item.baselineErrorCode,
      providerCode: item.baselineProviderCode,
      httpStatus: item.baselineHttpStatus,
      count: 1,
    })
  }
  return {
    items,
    candidateReady,
    historicalCandidateReady,
    baselineReady,
    baselineRunning,
    baselineFailed,
    failures: [...failureCounts.values()].sort((left, right) => (
      right.count - left.count || left.code.localeCompare(right.code)
    )),
    candidateProvider,
    candidateProviderConsistent,
    currentProviderCompatible,
    providerMismatchReason,
    targetCount: items.length,
    pairSetReady: items.length >= 6 && baselineReady === items.length,
  }
}
