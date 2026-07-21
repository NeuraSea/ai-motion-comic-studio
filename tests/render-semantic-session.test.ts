import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalTimelineDocumentFromTracks,
  OPEN_CUT_CLASSIC_COMMIT,
  type EditorSceneTracks,
} from '@manju/opencut-editor'
import {
  createLiveRenderSemanticSession,
  createPinnedRenderSemanticSession,
  RenderSemanticSessionError,
} from '../src/features/editor/render-semantic-session'
import { parseOpenCutTracks } from '../src/features/editor/timeline-codec'
import type {
  EpisodeSummary,
  MediaAsset,
  TimelineDocumentSnapshot,
} from '../src/lib'

const PROJECT_ID = 'project-1'
const EPISODE_ID = 'episode-1'
const STORY_REVISION_ID = 'story-revision-1'
const TIMELINE_REVISION_ID = 'timeline-revision-1'
const FRAME = 5_000
const checksum = (digit: string) => digit.repeat(64)

function fixture(): {
  snapshot: TimelineDocumentSnapshot
  episode: EpisodeSummary
  assets: MediaAsset[]
} {
  const tracks: EditorSceneTracks = {
    overlay: [{
      id: 'visuals',
      type: 'video',
      elements: [
        {
          id: 'still',
          name: '定场',
          type: 'image',
          mediaId: 'asset-image',
          startTime: 0,
          duration: 24 * FRAME,
          trimStart: 0,
          trimEnd: 0,
          params: { fit: 'cover' },
        },
        {
          id: 'motion',
          name: '动作',
          type: 'video',
          mediaId: 'asset-video',
          startTime: 24 * FRAME,
          duration: 24 * FRAME,
          trimStart: 0,
          trimEnd: 0,
          params: { fit: 'contain' },
          isSourceAudioEnabled: false,
        },
      ],
    }, {
      id: 'subtitles',
      type: 'text',
      elements: [{
        id: 'subtitle',
        name: '醒来',
        type: 'text',
        startTime: 0,
        duration: 24 * FRAME,
        trimStart: 0,
        trimEnd: 0,
        params: { content: '醒来', text: '醒来', manjuRole: 'subtitle' },
      }],
    }],
    main: { id: 'main', type: 'video', elements: [] },
    audio: [{
      id: 'dialogue',
      type: 'audio',
      elements: [{
        id: 'speech',
        name: '对白',
        type: 'audio',
        sourceType: 'upload',
        mediaId: 'asset-speech',
        startTime: 0,
        duration: 24 * FRAME,
        trimStart: 0,
        trimEnd: 0,
        params: { dialogueLineId: 'line-1', volume: 0.8 },
      }],
    }],
  }
  const document = canonicalTimelineDocumentFromTracks(tracks, {
    frameRate: { numerator: 24, denominator: 1 },
  }) as unknown as Record<string, unknown>
  const now = '2026-07-14T00:00:00.000Z'
  const snapshot: TimelineDocumentSnapshot = {
    timelineDocument: {
      id: 'timeline-document-1',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      currentRevisionId: TIMELINE_REVISION_ID,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      sourceRevisionId: STORY_REVISION_ID,
      createdAt: now,
      updatedAt: now,
    },
    revision: {
      id: TIMELINE_REVISION_ID,
      documentId: 'timeline-document-1',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      parentRevisionId: null,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      sourceRevisionId: STORY_REVISION_ID,
      summary: 'fixture',
      snapshot: document,
      createdAt: now,
    },
    document,
    etag: `W/"${TIMELINE_REVISION_ID}"`,
  }
  const episode: EpisodeSummary = {
    id: EPISODE_ID,
    projectId: PROJECT_ID,
    title: '第一集',
    sourceText: '测试',
    targetDurationSeconds: 2,
    aspectRatio: '9:16',
    stylePreset: '国风',
    status: 'ready',
    sortOrder: 0,
    sourceRevisionId: STORY_REVISION_ID,
    createdAt: now,
    updatedAt: now,
  }
  const asset = (overrides: Partial<MediaAsset> & { id: string }): MediaAsset => ({
    id: overrides.id,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    kind: 'storyboard',
    version: 1,
    status: 'ready',
    mimeType: 'image/png',
    width: 720,
    height: 1280,
    durationSeconds: null,
    checksum: checksum('a'),
    source: 'fixture',
    providerId: null,
    generationJobId: null,
    sourceRevisionId: STORY_REVISION_ID,
    parentAssetId: null,
    url: 'https://untrusted.invalid/never-used',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })
  return {
    snapshot,
    episode,
    assets: [
      asset({ id: 'asset-image' }),
      asset({
        id: 'asset-video',
        kind: 'shot.video',
        mimeType: 'video/mp4',
        durationSeconds: 2,
        checksum: checksum('b'),
      }),
      asset({
        id: 'asset-speech',
        kind: 'speech',
        mimeType: 'audio/mpeg',
        width: null,
        height: null,
        durationSeconds: 1,
        checksum: checksum('c'),
      }),
    ],
  }
}

test('compiles preview and browser export from one exact pinned snapshot and asset set', () => {
  const input = fixture()
  const before = structuredClone(input.snapshot.document)
  const session = createPinnedRenderSemanticSession({
    projectId: PROJECT_ID,
    episode: input.episode,
    timelineSnapshot: input.snapshot,
    assets: input.assets,
  })

  assert.equal(session.plan.timelineDocumentId, 'timeline-document-1')
  assert.equal(session.plan.timelineRevisionId, TIMELINE_REVISION_ID)
  assert.equal(session.plan.storyRevisionId, STORY_REVISION_ID)
  assert.equal(session.plan.aspectRatio, '9:16')
  assert.equal(session.plan.totalFrames, 48)
  assert.deepEqual(session.plan.visualClips.map((clip) => ({
    id: clip.id,
    version: clip.asset.version,
    checksum: clip.asset.checksum,
    trim: clip.sourceTrim,
    fit: clip.fit,
  })), [
    { id: 'still', version: 1, checksum: checksum('a'), trim: null, fit: 'cover' },
    {
      id: 'motion',
      version: 1,
      checksum: checksum('b'),
      trim: {
        startFrame: 0,
        durationFrames: 24,
        endTrimFrames: 24,
        sourceDurationFrames: 48,
      },
      fit: 'contain',
    },
  ])
  assert.deepEqual(session.plan.audioClips.map((clip) => ({
    id: clip.id,
    role: clip.role,
    gain: clip.linearGain,
  })), [{ id: 'speech', role: 'dialogue', gain: 0.8 }])
  assert.deepEqual(session.media.bindings.map((binding) => ({
    id: binding.assetId,
    version: binding.assetVersion,
    checksum: binding.assetChecksum,
    url: binding.url,
  })), [
    {
      id: 'asset-image',
      version: 1,
      checksum: checksum('a'),
      url: '/api/v1/assets/asset-image/content',
    },
    {
      id: 'asset-video',
      version: 1,
      checksum: checksum('b'),
      url: '/api/v1/assets/asset-video/content',
    },
    {
      id: 'asset-speech',
      version: 1,
      checksum: checksum('c'),
      url: '/api/v1/assets/asset-speech/content',
    },
  ])
  assert.deepEqual(input.snapshot.document, before, 'authoritative snapshot must remain immutable')
})

test('safely clamps a stale system-managed dialogue tail to immutable Asset duration', () => {
  const input = fixture()
  const tracks = parseOpenCutTracks(input.snapshot.document)
  assert.ok(tracks)
  const speech = tracks.audio[0]!.elements[0]!
  speech.duration = 36 * FRAME
  speech.sourceDuration = 36 * FRAME
  speech.params = {
    ...speech.params,
    storyManagedAssetId: 'asset-speech',
    storySceneId: 'scene-1',
    storyShotId: 'shot-1',
  }
  const staleDocument = canonicalTimelineDocumentFromTracks(tracks, {
    frameRate: { numerator: 24, denominator: 1 },
  }) as unknown as Record<string, unknown>
  input.snapshot.document = staleDocument
  input.snapshot.revision.snapshot = staleDocument
  const before = structuredClone(staleDocument)

  const session = createPinnedRenderSemanticSession({
    projectId: PROJECT_ID,
    episode: input.episode,
    timelineSnapshot: input.snapshot,
    assets: input.assets,
  })

  assert.deepEqual(session.repairs, [{
    elementId: 'speech',
    assetId: 'asset-speech',
    code: 'MANAGED_AUDIO_SOURCE_OVERRUN_CLAMPED',
    previousDurationFrames: 36,
    repairedDurationFrames: 24,
  }])
  assert.equal(session.plan.audioClips[0]?.durationFrames, 24)
  assert.deepEqual(input.snapshot.document, before, 'pinned timeline snapshot must remain immutable')
})

test('still fails closed for an overrun on manually edited audio', () => {
  const input = fixture()
  const tracks = parseOpenCutTracks(input.snapshot.document)
  assert.ok(tracks)
  tracks.audio[0]!.elements[0]!.duration = 36 * FRAME
  const staleDocument = canonicalTimelineDocumentFromTracks(tracks, {
    frameRate: { numerator: 24, denominator: 1 },
  }) as unknown as Record<string, unknown>
  input.snapshot.document = staleDocument
  input.snapshot.revision.snapshot = staleDocument

  assert.throws(
    () => createPinnedRenderSemanticSession({
      projectId: PROJECT_ID,
      episode: input.episode,
      timelineSnapshot: input.snapshot,
      assets: input.assets,
    }),
    (error: unknown) => error instanceof RenderSemanticSessionError
      && error.code === 'INVALID_TIMELINE'
      && /裁剪范围超出资产/.test(error.message),
  )
})

test('compiles the mounted OpenCut command state for the program monitor without mutating it', () => {
  const input = fixture()
  const tracks = parseOpenCutTracks(input.snapshot.document)
  assert.ok(tracks)
  const beforeTracks = structuredClone(tracks)
  const beforeDocument = structuredClone(input.snapshot.document)

  const session = createLiveRenderSemanticSession({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sourceRevisionId: STORY_REVISION_ID,
    aspectRatio: input.episode.aspectRatio,
    timelineDocumentId: input.snapshot.timelineDocument.id,
    timelineRevisionId: input.snapshot.revision.id,
    tracks,
    baseDocument: input.snapshot.document,
    assets: input.assets,
  })

  assert.equal(session.plan.timelineRevisionId, TIMELINE_REVISION_ID)
  assert.equal(session.plan.visualClips.length, 2)
  assert.equal(session.plan.audioClips.length, 1)
  assert.equal(session.plan.subtitleCues.length, 1)
  assert.deepEqual(tracks, beforeTracks, 'mounted command state must remain immutable')
  assert.deepEqual(input.snapshot.document, beforeDocument, 'base document must remain immutable')
})

test('fails closed before preview when an immutable asset pin is missing or invalid', () => {
  const missing = fixture()
  missing.assets = missing.assets.filter((asset) => asset.id !== 'asset-video')
  assert.throws(
    () => createPinnedRenderSemanticSession({
      projectId: PROJECT_ID,
      episode: missing.episode,
      timelineSnapshot: missing.snapshot,
      assets: missing.assets,
    }),
    (error: unknown) => error instanceof RenderSemanticSessionError
      && error.code === 'MEDIA_UNRESOLVED',
  )

  const unpinned = fixture()
  unpinned.assets.find((asset) => asset.id === 'asset-video')!.checksum = null
  assert.throws(
    () => createPinnedRenderSemanticSession({
      projectId: PROJECT_ID,
      episode: unpinned.episode,
      timelineSnapshot: unpinned.snapshot,
      assets: unpinned.assets,
    }),
    (error: unknown) => error instanceof RenderSemanticSessionError
      && error.code === 'INVALID_ASSET'
      && /SHA-256/.test(error.message),
  )
})
