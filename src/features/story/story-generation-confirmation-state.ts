export interface FrozenStoryGenerationAttempt {
  readonly signature: string
  readonly episodeId: string
  readonly projectId: string
  readonly etag: string
  readonly idempotencyKey: string
  readonly body: Readonly<{
    projectId: string
    providerId?: string
  }>
}

export type StoryGenerationIdempotencyRegistry = Map<string, string>

/** Cancellation intentionally has no companion mutation: only success acks. */
export function acquireStoryGenerationIdempotencyKey(
  registry: StoryGenerationIdempotencyRegistry,
  signature: string,
  create: () => string,
): string {
  const normalizedSignature = required(signature, 'signature')
  const existing = registry.get(normalizedSignature)
  if (existing) return existing
  const created = required(create(), 'idempotencyKey')
  registry.set(normalizedSignature, created)
  return created
}

export function acknowledgeStoryGenerationAttempt(
  registry: StoryGenerationIdempotencyRegistry,
  attempt: FrozenStoryGenerationAttempt,
): void {
  if (registry.get(attempt.signature) === attempt.idempotencyKey) {
    registry.delete(attempt.signature)
  }
}

function required(value: string, field: string): string {
  if (!value || value.trim() !== value) throw new TypeError(`${field} must be a non-empty exact value`)
  return value
}

/** Freeze the exact direct-submission request so ambiguous retries reuse one key. */
export function freezeStoryGenerationAttempt(input: {
  signature: string
  episodeId: string
  projectId: string
  etag: string
  idempotencyKey: string
  body: { projectId: string; providerId?: string }
}): FrozenStoryGenerationAttempt {
  const projectId = required(input.projectId, 'projectId')
  if (required(input.body.projectId, 'body.projectId') !== projectId) {
    throw new TypeError('body.projectId must match projectId')
  }
  const body = Object.freeze({
    projectId,
    ...(input.body.providerId !== undefined
      ? { providerId: required(input.body.providerId, 'body.providerId') }
      : {}),
  })
  return Object.freeze({
    signature: required(input.signature, 'signature'),
    episodeId: required(input.episodeId, 'episodeId'),
    projectId,
    etag: required(input.etag, 'etag'),
    idempotencyKey: required(input.idempotencyKey, 'idempotencyKey'),
    body,
  })
}
