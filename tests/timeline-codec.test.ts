import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inspectOpenCutRevisionCompatibility,
  inspectOpenCutSnapshotCompatibility,
  openCutTimelineDocument,
  parseOpenCutFrameRate,
  parseOpenCutTracks,
} from '../src/features/editor/timeline-codec'
import {
  compileRenderSemanticPlan,
  OPEN_CUT_CLASSIC_COMMIT,
  RenderSemanticPlanError,
  type EditorSceneTracks,
} from '@manju/opencut-editor'
import type { TimelineDocumentSnapshot } from '../src/lib/api-types'

function legacyTracks(): EditorSceneTracks {
  return {
    overlay: [{
      id: 'visual',
      type: 'video',
      elements: [{
        id: 'image-1',
        type: 'image',
        startTime: 0,
        duration: 120_000,
        params: { assetId: 'asset-1', storyShotId: 'shot-1' },
      }],
    }],
    main: { id: 'main', type: 'video', elements: [] },
    audio: [],
  }
}

test('client timeline boundary saves canonical v2 and reloads top-level mediaId', () => {
  const document = openCutTimelineDocument(legacyTracks(), {
    frameRate: { numerator: 30, denominator: 1 },
    manju: { projectId: 'project-1' },
  })
  assert.equal(document.version, 2)
  assert.deepEqual(document.frameRate, { numerator: 30, denominator: 1 })

  const tracks = parseOpenCutTracks(document)
  const track = tracks?.overlay[0]
  const image = track?.elements[0]
  assert.equal(track?.name, 'visual')
  assert.equal(track?.hidden, false)
  assert.equal(track?.muted, false)
  assert.equal(image?.mediaId, 'asset-1')
  assert.equal(image?.params?.assetId, undefined)
  assert.equal(image?.params?.storyShotId, 'shot-1')
  assert.deepEqual(parseOpenCutFrameRate(document), {
    numerator: 30,
    denominator: 1,
  })
})

test('client timeline boundary rejects invalid canonical v2 without a fallback parser', () => {
  const document = openCutTimelineDocument(legacyTracks())
  const tracks = (document.tracks as EditorSceneTracks)
  delete tracks.overlay[0]!.elements[0]!.mediaId
  tracks.overlay[0]!.elements[0]!.manju = { mediaId: 'not-canonical' }

  assert.equal(parseOpenCutTracks(document), null)
  assert.deepEqual(parseOpenCutFrameRate(document), {
    numerator: 24,
    denominator: 1,
  })
})

test('unknown element types quarantine the canonical head instead of becoming fallback tracks', () => {
  const document = openCutTimelineDocument(legacyTracks())
  const tracks = document.tracks as EditorSceneTracks
  tracks.overlay[0]!.elements[0]!.type = 'future-hologram' as 'image'

  assert.equal(parseOpenCutTracks(document), null)
})

test('known elements retain unknown effects and animations while render semantics fail closed', () => {
  const source = legacyTracks()
  const image = source.overlay[0]!.elements[0]!
  image.animations = {
    'vendor.depthPulse': {
      version: 7,
      keys: [{ frame: 0, value: 0.25 }],
    },
  }
  image.effects = [{
    id: 'vendor.chromatic-future',
    enabled: true,
    settings: { amount: 0.42 },
  }]
  const document = openCutTimelineDocument(source)
  const parsed = parseOpenCutTracks(document)
  assert.ok(parsed)
  assert.deepEqual(parsed.overlay[0]!.elements[0]!.animations, image.animations)
  assert.deepEqual(parsed.overlay[0]!.elements[0]!.effects, image.effects)

  const roundTripped = openCutTimelineDocument(parsed, document)
  const roundTrippedElement = (roundTripped.tracks as EditorSceneTracks)
    .overlay[0]!.elements[0]!
  assert.deepEqual(roundTrippedElement.animations, image.animations)
  assert.deepEqual(roundTrippedElement.effects, image.effects)

  const compile = (timelineDocument: Record<string, unknown>) => compileRenderSemanticPlan({
    timelineDocument,
    timelineDocumentId: 'timeline-1',
    timelineRevisionId: 'revision-1',
    storyRevisionId: 'story-1',
    aspectRatio: '16:9',
    assets: [{
      assetId: 'asset-1',
      version: 1,
      checksum: 'a'.repeat(64),
      mediaType: 'image',
    }],
  })
  assert.throws(
    () => compile(roundTripped),
    (error: unknown) => error instanceof RenderSemanticPlanError
      && error.code === 'UNSUPPORTED_TIMELINE'
      && error.path.includes('animations.vendor.depthPulse'),
  )

  const effectsOnlyTracks = legacyTracks()
  effectsOnlyTracks.overlay[0]!.elements[0]!.effects = structuredClone(image.effects)
  assert.throws(
    () => compile(openCutTimelineDocument(effectsOnlyTracks)),
    (error: unknown) => error instanceof RenderSemanticPlanError
      && error.code === 'UNSUPPORTED_TIMELINE'
      && error.path.endsWith('.effects'),
  )
})

test('history restore compatibility requires scope, provenance, and canonical parsing', () => {
  const document = openCutTimelineDocument(legacyTracks())
  const now = '2026-07-15T00:00:00.000Z'
  const authoritative: TimelineDocumentSnapshot = {
    timelineDocument: {
      id: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      currentRevisionId: 'revision-head',
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      sourceRevisionId: 'story-1',
      createdAt: now,
      updatedAt: now,
    },
    revision: {
      id: 'revision-head',
      documentId: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      parentRevisionId: 'revision-old',
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      sourceRevisionId: 'story-1',
      summary: 'future head',
      snapshot: document,
      createdAt: now,
    },
    document,
    etag: 'W/"revision-head"',
  }
  const compatible = {
    ...authoritative.revision,
    id: 'revision-old',
    parentRevisionId: null,
    summary: 'known good',
  }
  assert.deepEqual(inspectOpenCutRevisionCompatibility(compatible, authoritative), {
    compatible: true,
    canonical: true,
    reasons: [],
  })

  const unknownElementSnapshot = structuredClone(document)
  const unknownTracks = unknownElementSnapshot.tracks as EditorSceneTracks
  unknownTracks.overlay[0]!.elements[0]!.type = 'future-hologram' as 'image'
  const incompatible = inspectOpenCutRevisionCompatibility({
    ...compatible,
    id: 'revision-incompatible',
    sourceRevisionId: 'story-other',
    snapshot: unknownElementSnapshot,
  }, authoritative)
  assert.equal(incompatible.compatible, false)
  assert.equal(incompatible.canonical, false)
  assert.deepEqual(incompatible.reasons, [
    'Story 源修订不一致',
    '快照未通过 pinned OpenCut canonical 校验',
  ])
})

test('current authoritative head rejects parseable metadata mismatches before adoption', () => {
  const document = openCutTimelineDocument(legacyTracks())
  const now = '2026-07-15T00:00:00.000Z'
  const authoritative: TimelineDocumentSnapshot = {
    timelineDocument: {
      id: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      currentRevisionId: 'revision-head',
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      sourceRevisionId: 'story-current',
      createdAt: now,
      updatedAt: now,
    },
    revision: {
      id: 'revision-head',
      documentId: 'timeline-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      parentRevisionId: null,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      sourceRevisionId: 'story-current',
      summary: 'head',
      snapshot: structuredClone(document),
      createdAt: now,
    },
    document: structuredClone(document),
    etag: 'W/"revision-head"',
  }
  const expected = {
    projectId: 'project-1',
    episodeId: 'episode-1',
    schemaVersion: 2,
    upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
    sourceRevisionId: 'story-current',
  }

  const cases: Array<{
    reason: string
    mutate(snapshot: TimelineDocumentSnapshot): void
  }> = [{
    reason: 'canonical schema 版本不一致',
    mutate(snapshot) {
      snapshot.timelineDocument.schemaVersion = 3
      snapshot.revision.schemaVersion = 3
    },
  }, {
    reason: 'pinned OpenCut 上游 commit 不一致',
    mutate(snapshot) {
      const otherCommit = 'f'.repeat(40)
      snapshot.timelineDocument.upstreamCommit = otherCommit
      snapshot.revision.upstreamCommit = otherCommit
    },
  }, {
    reason: 'Story 源修订不一致',
    mutate(snapshot) {
      snapshot.timelineDocument.sourceRevisionId = 'story-other'
      snapshot.revision.sourceRevisionId = 'story-other'
    },
  }, {
    reason: '项目、分集或时间线文档作用域不一致',
    mutate(snapshot) {
      snapshot.timelineDocument.projectId = 'project-other'
      snapshot.revision.projectId = 'project-other'
    },
  }]

  for (const entry of cases) {
    const candidate = structuredClone(authoritative)
    entry.mutate(candidate)
    const compatibility = inspectOpenCutSnapshotCompatibility(candidate, expected)
    assert.equal(compatibility.compatible, false)
    assert.equal(compatibility.canonical, true, entry.reason)
    assert.ok(compatibility.reasons.includes(entry.reason))
  }
})

test('pre-reconcile head may trail Story only when both metadata envelopes agree', () => {
  const document = openCutTimelineDocument(legacyTracks())
  const now = '2026-07-15T00:00:00.000Z'
  const stale: TimelineDocumentSnapshot = {
    timelineDocument: {
      id: 'timeline-1', projectId: 'project-1', episodeId: 'episode-1',
      currentRevisionId: 'revision-old', schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT, sourceRevisionId: 'story-old',
      createdAt: now, updatedAt: now,
    },
    revision: {
      id: 'revision-old', documentId: 'timeline-1', projectId: 'project-1',
      episodeId: 'episode-1', parentRevisionId: null, schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT, sourceRevisionId: 'story-old',
      summary: 'old story head', snapshot: structuredClone(document), createdAt: now,
    },
    document: structuredClone(document),
    etag: 'W/"revision-old"',
  }
  const expected = {
    projectId: 'project-1', episodeId: 'episode-1', schemaVersion: 2,
    upstreamCommit: OPEN_CUT_CLASSIC_COMMIT, sourceRevisionId: 'story-current',
  }

  assert.equal(inspectOpenCutSnapshotCompatibility(
    stale,
    expected,
    { allowStaleSourceRevision: true },
  ).compatible, true)
  assert.equal(inspectOpenCutSnapshotCompatibility(stale, expected).compatible, false)

  const internallyMismatched = structuredClone(stale)
  internallyMismatched.revision.sourceRevisionId = 'story-different'
  const compatibility = inspectOpenCutSnapshotCompatibility(
    internallyMismatched,
    expected,
    { allowStaleSourceRevision: true },
  )
  assert.equal(compatibility.compatible, false)
  assert.ok(compatibility.reasons.includes('Story 源修订不一致'))
})
