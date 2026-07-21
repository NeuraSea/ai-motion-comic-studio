import type {
  ExportRenderRecord,
  GenerationJob,
  QualityReport,
} from '../../lib/api-types'

export interface EpisodeStoryJobScope {
  episodeId: string
  sourceRevisionId: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return isRecord(value[key]) ? value[key] : null
}

export function generationJobIsStale(job: GenerationJob): boolean {
  return isRecord(job.progressDetail) && job.progressDetail.stale === true
}

/**
 * Project task feeds are intentionally broad. A production workbench must
 * narrow that feed by the durable top-level Episode binding before inspecting
 * any input/output pointers.
 */
export function jobBelongsToEpisode(job: GenerationJob, episodeId: string): boolean {
  if (!episodeId || job.episodeId !== episodeId) return false
  const input = isRecord(job.input) ? job.input : null
  const output = isRecord(job.output) ? job.output : null
  const bindingRecords = input ? [
    nestedRecord(input, 'binding'),
    nestedRecord(input, 'storyboardBinding'),
    nestedRecord(input, 'episodeBinding'),
    nestedRecord(input, 'assetEntityBinding'),
  ].filter((value): value is Record<string, unknown> => value !== null) : []
  const declaredEpisodeIds = [
    input && nonEmptyString(input.episodeId),
    ...bindingRecords.map((binding) => nonEmptyString(binding.episodeId)),
    output && nonEmptyString(output.episodeId),
    output && nestedRecord(output, 'asset') && nonEmptyString(nestedRecord(output, 'asset')!.episodeId),
  ].filter((value): value is string => Boolean(value))
  return declaredEpisodeIds.every((declaredEpisodeId) => declaredEpisodeId === episodeId)
}

export function jobsForEpisode(jobs: readonly GenerationJob[], episodeId: string | null | undefined): GenerationJob[] {
  if (!episodeId) return []
  return jobs.filter((job) => jobBelongsToEpisode(job, episodeId))
}

/**
 * Reads only server-authored immutable revision bindings. Conflicting pointers
 * deliberately produce no revision rather than letting a convenient field win.
 */
export function sourceRevisionIdForJob(job: GenerationJob): string | null {
  const input = isRecord(job.input) ? job.input : null
  const output = isRecord(job.output) ? job.output : null
  const bindingRecords = input ? [
    nestedRecord(input, 'binding'),
    nestedRecord(input, 'storyboardBinding'),
    nestedRecord(input, 'episodeBinding'),
    nestedRecord(input, 'assetEntityBinding'),
  ].filter((value): value is Record<string, unknown> => value !== null) : []
  const revisionIds = [
    input && nonEmptyString(input.sourceRevisionId),
    input && nonEmptyString(input.storyRevisionId),
    input && nonEmptyString(input.expectedRevisionId),
    input && nonEmptyString(input.expectedStoryRevisionId),
    ...bindingRecords.flatMap((binding) => [
      nonEmptyString(binding.sourceRevisionId),
      nonEmptyString(binding.expectedRevisionId),
      nonEmptyString(binding.expectedStoryRevisionId),
    ]),
    output && nonEmptyString(output.sourceRevisionId),
    output && nonEmptyString(output.storyRevisionId),
    output && nestedRecord(output, 'asset')
      && nonEmptyString(nestedRecord(output, 'asset')!.sourceRevisionId),
  ].filter((value): value is string => Boolean(value))
  const unique = [...new Set(revisionIds)]
  return unique.length === 1 ? unique[0] : null
}

export function jobBelongsToCurrentStoryRevision(
  job: GenerationJob,
  scope: EpisodeStoryJobScope,
): boolean {
  return scope.sourceRevisionId !== null
    && jobBelongsToEpisode(job, scope.episodeId)
    && !generationJobIsStale(job)
    && sourceRevisionIdForJob(job) === scope.sourceRevisionId
}

export function jobsForCurrentStoryRevision(
  jobs: readonly GenerationJob[],
  scope: EpisodeStoryJobScope,
): GenerationJob[] {
  return jobs.filter((job) => jobBelongsToCurrentStoryRevision(job, scope))
}

function updatedAtMillis(job: GenerationJob): number {
  const parsed = Date.parse(job.updatedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

export function completedSpeechLineIdsForCurrentStory(
  jobs: readonly GenerationJob[],
  scope: EpisodeStoryJobScope,
): Set<string> {
  return new Set(jobsForCurrentStoryRevision(jobs, scope).flatMap((job) => {
    if (job.type !== 'dialogue.speech.generate' || job.status !== 'succeeded' || !isRecord(job.input)) return []
    const lineId = nonEmptyString(job.input.lineId)
    return lineId ? [lineId] : []
  }))
}

export function latestExportJobForCurrentStory(
  jobs: readonly GenerationJob[],
  scope: EpisodeStoryJobScope,
): GenerationJob | null {
  return jobsForCurrentStoryRevision(jobs, scope)
    .filter((job) => job.type === 'export.render')
    .sort((left, right) => updatedAtMillis(right) - updatedAtMillis(left))[0] ?? null
}

export function latestQualityJobForExport(
  jobs: readonly GenerationJob[],
  episodeId: string,
  exportId: string | null,
): GenerationJob | null {
  if (!exportId) return null
  return jobsForEpisode(jobs, episodeId)
    .filter((job) => job.type === 'quality.check'
      && !generationJobIsStale(job)
      && isRecord(job.input)
      && job.input.exportId === exportId)
    .sort((left, right) => updatedAtMillis(right) - updatedAtMillis(left))[0] ?? null
}

export function exportRecordBelongsToCurrentStory(
  record: ExportRenderRecord,
  scope: EpisodeStoryJobScope,
  expectedExportId?: string | null,
): boolean {
  return scope.sourceRevisionId !== null
    && record.episodeId === scope.episodeId
    && record.storyRevisionId === scope.sourceRevisionId
    && (!expectedExportId || record.id === expectedExportId)
    && record.specification.storyRevisionId === scope.sourceRevisionId
    && record.specification.timelineRevisionId === record.timelineRevisionId
}

export function qualityReportBelongsToCurrentStory(
  report: QualityReport,
  scope: EpisodeStoryJobScope,
  expectedExportId: string,
): boolean {
  return scope.sourceRevisionId !== null
    && report.episodeId === scope.episodeId
    && report.storyRevisionId === scope.sourceRevisionId
    && report.exportId === expectedExportId
}
