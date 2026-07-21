import type {
  ShotMediaCandidate,
  ShotMediaReviewDecision,
  ShotMediaReviewRecord,
  ShotMediaType,
} from '../../lib'

export type ShotMediaReviewIdempotencyRegistry = Map<string, string>

export interface ShotMediaReviewAttemptScope {
  projectId: string
  episodeId: string
  shotId: string
  sceneId: string
  sourceRevisionId: string
  mediaType: ShotMediaType
  decision: ShotMediaReviewDecision
  assetId: string
  note: string
  episodeEtag: string
}

export function shotMediaReviewAttemptSignature(scope: ShotMediaReviewAttemptScope): string {
  return JSON.stringify({
    version: 1,
    ...scope,
    note: scope.note.trim(),
  })
}

export function acquireShotMediaReviewIdempotencyKey(
  registry: ShotMediaReviewIdempotencyRegistry,
  signature: string,
  createKey: () => string = () => `shot-media-review-${crypto.randomUUID()}`,
): string {
  const existing = registry.get(signature)
  if (existing) return existing
  const created = createKey()
  registry.set(signature, created)
  return created
}

export function acknowledgeShotMediaReviewAttempt(
  registry: ShotMediaReviewIdempotencyRegistry,
  signature: string,
  expectedKey: string,
): void {
  if (registry.get(signature) === expectedKey) registry.delete(signature)
}

/** True only when the client cannot prove that the server did not commit. */
export function shotMediaReviewSubmissionOutcomeIsUnknown(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true
  const value = error as { status?: unknown; code?: unknown }
  const status = typeof value.status === 'number' ? value.status : 0
  const code = typeof value.code === 'string' ? value.code : ''
  if (code === 'REQUEST_ABORTED') return false
  return code === 'NETWORK_ERROR'
    || code === 'INVALID_RESPONSE'
    || status >= 500
    || status === 0
}

export function wasShotMediaCandidatePreviouslySelected(
  history: readonly ShotMediaReviewRecord[],
  assetId: string,
): boolean {
  return history.some((record) => (
    record.selectedAssetId === assetId || record.previousAssetId === assetId
  ))
}

export function availableShotMediaReviewDecisions(
  candidate: ShotMediaCandidate,
  history: readonly ShotMediaReviewRecord[],
): ShotMediaReviewDecision[] {
  if (!candidate.eligible) return []
  if (candidate.selected) {
    return candidate.lastDecision === null || candidate.lastDecision === 'reject'
      ? ['adopt']
      : []
  }
  return wasShotMediaCandidatePreviouslySelected(history, candidate.id)
    ? ['restore', 'reject']
    : ['adopt', 'reject']
}
