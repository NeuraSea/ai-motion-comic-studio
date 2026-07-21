import assert from 'node:assert/strict'
import test from 'node:test'

import type { ShotMediaCandidate, ShotMediaReviewRecord } from '../src/lib'
import {
  acknowledgeShotMediaReviewAttempt,
  acquireShotMediaReviewIdempotencyKey,
  availableShotMediaReviewDecisions,
  shotMediaReviewAttemptSignature,
  shotMediaReviewSubmissionOutcomeIsUnknown,
} from '../src/features/video/shot-media-review-state'

function candidate(overrides: Partial<ShotMediaCandidate> = {}): ShotMediaCandidate {
  return {
    id: 'asset-2',
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'shot.video',
    version: 2,
    status: 'ready',
    mimeType: 'video/mp4',
    width: 1280,
    height: 720,
    durationSeconds: 5,
    checksum: 'a'.repeat(64),
    sourceRevisionId: 'revision-1',
    parentAssetId: null,
    generationJobId: 'job-2',
    url: '/api/v1/assets/asset-2/content',
    createdAt: '2026-07-15T00:00:00.000Z',
    selected: false,
    eligible: true,
    eligibilityError: null,
    lastDecision: null,
    ...overrides,
  }
}

function history(overrides: Partial<ShotMediaReviewRecord> = {}): ShotMediaReviewRecord {
  return {
    id: 'review-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    databaseShotId: 'db-shot-1',
    shotId: 'shot-1',
    sceneId: 'scene-1',
    sourceRevisionId: 'revision-1',
    mediaType: 'video',
    decision: 'adopt',
    assetId: 'asset-1',
    previousAssetId: null,
    selectedAssetId: 'asset-1',
    clearedVideoAssetId: null,
    note: null,
    timelineReconcileRequired: true,
    stale: { generationJobs: 0, shotVideoJobs: 0, exports: 0, qualityReports: 0, pipelineRuns: 0 },
    createdAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  }
}

test('review attempt retains one idempotency key until the confirmed response is acknowledged', () => {
  const registry = new Map<string, string>()
  const signature = shotMediaReviewAttemptSignature({
    projectId: 'project-1',
    episodeId: 'episode-1',
    shotId: 'shot-1',
    sceneId: 'scene-1',
    sourceRevisionId: 'revision-1',
    mediaType: 'video',
    decision: 'adopt',
    assetId: 'asset-2',
    note: '  采用  ',
    episodeEtag: 'W/"head-1"',
  })
  let count = 0
  const create = () => `key-${++count}`
  const first = acquireShotMediaReviewIdempotencyKey(registry, signature, create)
  const replay = acquireShotMediaReviewIdempotencyKey(registry, signature, create)
  assert.equal(replay, first)
  assert.equal(count, 1)
  acknowledgeShotMediaReviewAttempt(registry, signature, 'wrong-key')
  assert.equal(acquireShotMediaReviewIdempotencyKey(registry, signature, create), first)
  acknowledgeShotMediaReviewAttempt(registry, signature, first)
  assert.equal(acquireShotMediaReviewIdempotencyKey(registry, signature, create), 'key-2')
})

test('candidate actions distinguish new versions, prior selections and already-reviewed current media', () => {
  assert.deepEqual(availableShotMediaReviewDecisions(candidate(), []), ['adopt', 'reject'])
  assert.deepEqual(availableShotMediaReviewDecisions(candidate(), [
    history({ previousAssetId: 'asset-2' }),
  ]), ['restore', 'reject'])
  assert.deepEqual(availableShotMediaReviewDecisions(candidate({
    selected: true,
    lastDecision: null,
  }), []), ['adopt'])
  assert.deepEqual(availableShotMediaReviewDecisions(candidate({
    selected: true,
    lastDecision: 'adopt',
  }), []), [])
  assert.deepEqual(availableShotMediaReviewDecisions(candidate({
    selected: true,
    lastDecision: 'restore',
  }), []), [])
  assert.deepEqual(availableShotMediaReviewDecisions(candidate({
    eligible: false,
    eligibilityError: '绑定无效',
  }), []), [])
})

test('only ambiguous transport/response failures permit one automatic exact replay', () => {
  assert.equal(shotMediaReviewSubmissionOutcomeIsUnknown({ status: 0, code: 'NETWORK_ERROR' }), true)
  assert.equal(shotMediaReviewSubmissionOutcomeIsUnknown({ status: 200, code: 'INVALID_RESPONSE' }), true)
  assert.equal(shotMediaReviewSubmissionOutcomeIsUnknown({ status: 503, code: 'HTTP_503' }), true)
  assert.equal(shotMediaReviewSubmissionOutcomeIsUnknown(new Error('transport disappeared')), true)
  assert.equal(shotMediaReviewSubmissionOutcomeIsUnknown({ status: 412, code: 'PRECONDITION_FAILED' }), false)
  assert.equal(shotMediaReviewSubmissionOutcomeIsUnknown({ status: 409, code: 'INVALID_MEDIA_CANDIDATE' }), false)
  assert.equal(shotMediaReviewSubmissionOutcomeIsUnknown({ status: 0, code: 'REQUEST_ABORTED' }), false)
})
