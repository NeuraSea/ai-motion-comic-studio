import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalTimelineDocumentFromTracks,
  compileRenderSemanticPlan,
  OPEN_CUT_TICKS_PER_SECOND,
  RenderSemanticPlanError,
} from '@manju/opencut-editor'
import {
  buildTimelineRenderRescueEnvelope,
  classifyTimelineRenderFailure,
  serializeTimelineRenderRescue,
  timelineRenderRescueFilename,
} from '../src/features/editor/timeline-render-rescue'
import type { TimelineDocumentSnapshot } from '../src/lib'

const COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'

function unsupportedSnapshot(): TimelineDocumentSnapshot {
  const document = canonicalTimelineDocumentFromTracks({
    overlay: [],
    main: {
      id: 'visual-main',
      type: 'video',
      elements: [{
        id: 'shot-1',
        type: 'image',
        mediaId: 'asset-image-1',
        name: '镜头一',
        startTime: 0,
        duration: 5 * OPEN_CUT_TICKS_PER_SECOND,
        trimStart: 0,
        trimEnd: 0,
        params: { fit: 'cover', storyShotId: 'shot-1' },
      }],
    },
    audio: [],
  }, { frameRate: { numerator: 24, denominator: 1 } })
  const main = document.tracks.main.elements[0] as unknown as Record<string, unknown>
  main.effects = [{
    type: 'future-volumetric-light',
    vendorPayload: { intensity: 0.72, color: '#ffbc88' },
  }]
  main.futureElementField = { mustRoundTrip: ['alpha', 7, true] }

  return {
    timelineDocument: {
      id: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      currentRevisionId: 'revision-1',
      schemaVersion: 1,
      upstreamCommit: COMMIT,
      sourceRevisionId: 'story-1',
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z',
    },
    revision: {
      id: 'revision-1',
      documentId: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      parentRevisionId: null,
      schemaVersion: 1,
      upstreamCommit: COMMIT,
      sourceRevisionId: 'story-1',
      summary: '含未来特效的不可变修订',
      snapshot: structuredClone(document) as unknown as Record<string, unknown>,
      createdAt: '2026-07-15T00:00:00.000Z',
    },
    document: document as unknown as Record<string, unknown>,
    etag: 'W/"revision-1"',
  }
}

test('unknown OpenCut effect is rejected instead of silently flattened', () => {
  const snapshot = unsupportedSnapshot()
  assert.throws(() => compileRenderSemanticPlan({
    timelineDocument: snapshot.document,
    timelineDocumentId: 'timeline-1',
    timelineRevisionId: 'revision-1',
    storyRevisionId: 'story-1',
    aspectRatio: '16:9',
    assets: [{
      assetId: 'asset-image-1',
      version: 1,
      checksum: 'a'.repeat(64),
      mediaType: 'image',
    }],
  }), (cause: unknown) => cause instanceof RenderSemanticPlanError
    && cause.code === 'UNSUPPORTED_TIMELINE'
    && cause.path.endsWith('.effects'))
})

test('render rescue pins scope and preserves every unknown field byte-for-JSON', () => {
  const snapshot = unsupportedSnapshot()
  let caught: unknown
  try {
    compileRenderSemanticPlan({
      timelineDocument: snapshot.document,
      timelineDocumentId: 'timeline-1',
      timelineRevisionId: 'revision-1',
      storyRevisionId: 'story-1',
      aspectRatio: '16:9',
      assets: [{
        assetId: 'asset-image-1', version: 1, checksum: 'a'.repeat(64), mediaType: 'image',
      }],
    })
  } catch (cause) {
    caught = cause
  }
  const failure = classifyTimelineRenderFailure(caught)
  assert.equal(failure.kind, 'unsupported')
  assert.equal(failure.retryable, false)
  assert.equal(failure.rescueRecommended, true)
  assert.match(failure.path ?? '', /\.effects$/)

  const original = structuredClone(snapshot.document)
  const rescue = buildTimelineRenderRescueEnvelope({
    snapshot,
    failure,
    capturedAt: '2026-07-15T01:02:03.000Z',
  })
  assert.equal(rescue.scope.timelineRevisionId, 'revision-1')
  assert.equal(rescue.scope.timelineEtag, 'W/"revision-1"')
  assert.equal(rescue.scope.sourceRevisionId, 'story-1')
  assert.deepEqual(rescue.document, original)

  const sourceMain = ((snapshot.document.tracks as Record<string, unknown>).main as {
    elements: Array<Record<string, unknown>>
  }).elements[0]!
  ;(sourceMain.effects as Array<Record<string, unknown>>)[0]!.type = 'mutated-after-capture'
  assert.deepEqual(rescue.document, original, 'rescue must be detached from later editor mutation')

  const serialized = serializeTimelineRenderRescue(rescue)
  const parsed = JSON.parse(serialized) as typeof rescue
  assert.deepEqual(parsed.document, original)
  assert.equal(parsed.kind, 'manju.timeline-render-compatibility-rescue')
  assert.equal(
    timelineRenderRescueFilename(snapshot),
    'manju-episode-1-revision-1-render-rescue.json',
  )
})
