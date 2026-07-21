import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acknowledgeStoryGenerationAttempt,
  acquireStoryGenerationIdempotencyKey,
  freezeStoryGenerationAttempt,
} from '../src/features/story/story-generation-confirmation-state.js'

test('direct submission uses an immutable body, ETag, and idempotency key', () => {
  const mutableBody = { projectId: 'project-1', providerId: 'custom-text' }
  const attempt = freezeStoryGenerationAttempt({
    signature: 'draft-signature-1',
    episodeId: 'episode-1',
    projectId: 'project-1',
    etag: 'W/"episode-v3"',
    idempotencyKey: 'story-attempt-1',
    body: mutableBody,
  })
  mutableBody.projectId = 'other-project'
  mutableBody.providerId = 'other-provider'

  assert.ok(Object.isFrozen(attempt))
  assert.ok(Object.isFrozen(attempt.body))
  assert.equal(attempt.episodeId, 'episode-1')
  assert.equal(attempt.etag, 'W/"episode-v3"')
  assert.equal(attempt.idempotencyKey, 'story-attempt-1')
  assert.deepEqual(attempt.body, { projectId: 'project-1', providerId: 'custom-text' })
})

test('ambiguous retry retains the idempotency lease while success acknowledges it', () => {
  const registry = new Map<string, string>()
  let sequence = 0
  const create = () => `story-key-${++sequence}`
  const firstKey = acquireStoryGenerationIdempotencyKey(registry, 'draft-1', create)
  // Simulated unknown response: no acknowledgement is performed.
  const afterUnknown = acquireStoryGenerationIdempotencyKey(registry, 'draft-1', create)
  assert.equal(afterUnknown, firstKey)
  assert.equal(sequence, 1)

  const attempt = freezeStoryGenerationAttempt({
    signature: 'draft-1',
    episodeId: 'episode-1',
    projectId: 'project-1',
    etag: 'W/"episode-v3"',
    idempotencyKey: firstKey,
    body: { projectId: 'project-1' },
  })
  acknowledgeStoryGenerationAttempt(registry, attempt)
  assert.equal(acquireStoryGenerationIdempotencyKey(registry, 'draft-1', create), 'story-key-2')
})
