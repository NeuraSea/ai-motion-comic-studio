import assert from 'node:assert/strict'
import test from 'node:test'

import type { EditorSceneTracks, EditorTimelineElement } from '@manju/opencut-editor'
import {
  ManjuMediaResolver,
  resolveTimelineMediaFromAssets,
  type ManjuMediaResolverTransport,
} from '../src/features/editor/manju-media-resolver'
import type { MediaAsset } from '../src/lib'
import { ApiError, listAssets } from '../src/lib/api'

const PROJECT_ID = 'project-1'
const EPISODE_ID = 'episode-1'

function element(
  id: string,
  type: 'image' | 'video' | 'audio',
  assetId?: string,
): EditorTimelineElement {
  return {
    id,
    type,
    ...(assetId ? { mediaId: assetId } : {}),
    ...(type === 'audio' ? { sourceType: 'upload' as const } : {}),
    startTime: 0,
    duration: 120_000,
    trimStart: 0,
    trimEnd: 0,
    params: {},
  }
}

function tracks(elements: EditorTimelineElement[]): EditorSceneTracks {
  return {
    overlay: [{
      id: 'visual',
      type: 'video',
      elements: elements.filter((item) => item.type !== 'audio'),
    }],
    main: { id: 'main', type: 'video', elements: [] },
    audio: [{
      id: 'dialogue',
      type: 'audio',
      elements: elements.filter((item) => item.type === 'audio'),
    }],
  }
}

function asset(overrides: Partial<MediaAsset> & { id: string }): MediaAsset {
  return {
    id: overrides.id,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    kind: 'storyboard',
    version: 1,
    status: 'ready',
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    durationSeconds: null,
    checksum: 'checksum',
    source: 'provider',
    providerId: null,
    generationJobId: null,
    sourceRevisionId: 'story-1',
    parentAssetId: null,
    url: 'https://attacker.invalid/do-not-use.png',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  }
}

test('resolves ready in-episode assets through canonical content URLs', () => {
  const manifest = resolveTimelineMediaFromAssets({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    tracks: tracks([
      element('image-good', 'image', 'asset/image 1'),
      element('audio-good', 'audio', 'audio-1'),
    ]),
    assets: [
      asset({ id: 'asset/image 1' }),
      asset({
        id: 'audio-1',
        kind: 'speech',
        mimeType: 'audio/mpeg',
        width: null,
        height: null,
        durationSeconds: 1,
      }),
    ],
  })

  assert.deepEqual(manifest.issues, [])
  assert.deepEqual(manifest.bindings.map((binding) => ({
    elementId: binding.elementId,
    type: binding.elementType,
    url: binding.url,
  })), [
    {
      elementId: 'image-good',
      type: 'image',
      url: '/api/v1/assets/asset%2Fimage%201/content',
    },
    {
      elementId: 'audio-good',
      type: 'audio',
      url: '/api/v1/assets/audio-1/content',
    },
  ])
})

test('resolves the explicit same-shot image binding for a short-video hold', () => {
  const video = element('short-video-element', 'video', 'short-video')
  video.duration = 600_000
  video.sourceDuration = 360_000
  video.params = {
    storySceneId: 'scene-1',
    storyShotId: 'shot-1',
    sourceRevisionId: 'story-1',
  }
  video.manju = {
    shortVideoFill: {
      version: 1,
      strategy: 'same-shot-locked-image-hold-v1',
      fallbackAssetId: 'locked-storyboard',
      storySceneId: 'scene-1',
      storyShotId: 'shot-1',
      sourceRevisionId: 'story-1',
      sourceDurationTicks: 360_000,
      targetDurationTicks: 600_000,
      appliedByOpenCut: true,
      appliedPlanHash: 'f'.repeat(64),
    },
  }
  const manifest = resolveTimelineMediaFromAssets({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    tracks: tracks([video]),
    assets: [asset({
      id: 'short-video',
      kind: 'shot.video',
      mimeType: 'video/mp4',
      durationSeconds: 3,
    }), asset({ id: 'locked-storyboard' })],
  })

  assert.deepEqual(manifest.issues, [])
  assert.deepEqual(manifest.bindings.map((binding) => ({
    elementId: binding.elementId,
    type: binding.elementType,
    assetId: binding.assetId,
    startTime: binding.startTime,
    duration: binding.duration,
  })), [{
    elementId: 'short-video-element',
    type: 'video',
    assetId: 'short-video',
    startTime: 0,
    duration: 600_000,
  }, {
    elementId: 'short-video-element::same-shot-locked-image-hold-v1',
    type: 'image',
    assetId: 'locked-storyboard',
    startTime: 360_000,
    duration: 240_000,
  }])
})

test('shares OpenCut hidden, muted, element visibility, and source-audio semantics', () => {
  const hiddenTrackImage = element('hidden-track-image', 'image', 'missing-hidden-track')
  const hiddenElement = element('hidden-element', 'image', 'missing-hidden-element')
  hiddenElement.hidden = true
  const video = element('video-source-audio', 'video', 'video-1')
  video.isSourceAudioEnabled = true
  const mutedAudio = element('muted-audio', 'audio', 'missing-muted-audio')
  const scene: EditorSceneTracks = {
    overlay: [
      { id: 'hidden-video', type: 'video', hidden: true, muted: false, elements: [hiddenTrackImage] },
      { id: 'visible-video', type: 'video', hidden: false, muted: false, elements: [hiddenElement, video] },
    ],
    main: { id: 'main', type: 'video', hidden: false, muted: false, elements: [] },
    audio: [{ id: 'muted-track', type: 'audio', muted: true, elements: [mutedAudio] }],
  }
  const manifest = resolveTimelineMediaFromAssets({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    tracks: scene,
    assets: [asset({
      id: 'video-1',
      kind: 'shot.video',
      mimeType: 'video/mp4',
      durationSeconds: 5,
    })],
  })

  assert.deepEqual(manifest.issues, [])
  assert.deepEqual(manifest.bindings.map((binding) => ({
    elementId: binding.elementId,
    sourceAudioEnabled: binding.sourceAudioEnabled,
  })), [{ elementId: 'video-source-audio', sourceAudioEnabled: true }])

  scene.overlay[1].muted = true
  const mutedVideo = resolveTimelineMediaFromAssets({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    tracks: scene,
    assets: [asset({
      id: 'video-1',
      kind: 'shot.video',
      mimeType: 'video/mp4',
      durationSeconds: 5,
    })],
  })
  assert.equal(mutedVideo.bindings[0]?.sourceAudioEnabled, false)
})

test('allows same-project global assets only through canonical mediaId', () => {
  const legacy = element('legacy-global', 'image')
  legacy.params = { assetId: 'global-legacy' }
  const manifest = resolveTimelineMediaFromAssets({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    tracks: tracks([
      element('canonical-global', 'image', 'global-canonical'),
      legacy,
    ]),
    assets: [
      asset({ id: 'global-canonical', episodeId: null }),
      asset({ id: 'global-legacy', episodeId: null }),
    ],
  })

  assert.deepEqual(manifest.bindings.map((binding) => binding.elementId), ['canonical-global'])
  assert.deepEqual(manifest.issues.map((issue) => ({
    elementId: issue.elementId,
    code: issue.code,
  })), [{ elementId: 'legacy-global', code: 'ASSET_EPISODE_MISMATCH' }])
})

test('reports missing IDs, ownership, readiness, and MIME failures without fallback URLs', () => {
  const manifest = resolveTimelineMediaFromAssets({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    tracks: tracks([
      element('missing-id', 'image'),
      element('not-found', 'image', 'unknown'),
      element('wrong-project', 'image', 'project-2-asset'),
      element('wrong-episode', 'image', 'episode-2-asset'),
      element('pending', 'image', 'pending-asset'),
      element('missing-mime', 'image', 'missing-mime-asset'),
      element('wrong-mime', 'video', 'image-as-video'),
    ]),
    assets: [
      asset({ id: 'project-2-asset', projectId: 'project-2' }),
      asset({ id: 'episode-2-asset', episodeId: 'episode-2' }),
      asset({ id: 'pending-asset', status: 'processing' }),
      asset({ id: 'missing-mime-asset', mimeType: null }),
      asset({ id: 'image-as-video', mimeType: 'image/webp' }),
    ],
  })

  assert.deepEqual(manifest.bindings, [])
  assert.deepEqual(manifest.issues.map((issue) => issue.code), [
    'ASSET_ID_MISSING',
    'ASSET_NOT_FOUND',
    'ASSET_PROJECT_MISMATCH',
    'ASSET_EPISODE_MISMATCH',
    'ASSET_NOT_READY',
    'ASSET_MIME_MISSING',
    'ASSET_MIME_MISMATCH',
  ])
})

test('allows only unsaved v1 state to fall back to params.assetId', () => {
  const legacy = element('legacy-image', 'image')
  legacy.params = { assetId: 'legacy-asset' }
  const libraryAudio = element('library-audio', 'audio')
  libraryAudio.sourceType = 'library'
  libraryAudio.sourceUrl = 'https://provider.invalid/audio.mp3'
  libraryAudio.mediaId = 'must-not-substitute'
  libraryAudio.params = { assetId: 'must-not-substitute' }

  const manifest = resolveTimelineMediaFromAssets({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    tracks: tracks([legacy, libraryAudio]),
    assets: [
      asset({ id: 'legacy-asset' }),
      asset({
        id: 'must-not-substitute',
        kind: 'speech',
        mimeType: 'audio/mpeg',
        width: null,
        height: null,
      }),
    ],
  })

  assert.deepEqual(manifest.bindings.map((binding) => binding.elementId), [
    'legacy-image',
  ])
  assert.deepEqual(manifest.issues.map((issue) => ({
    elementId: issue.elementId,
    code: issue.code,
  })), [{ elementId: 'library-audio', code: 'ASSET_ID_MISSING' }])
})

test('ManjuMediaResolver asks its transport for the exact project and episode', async () => {
  const calls: Array<[string, string, AbortSignal | undefined]> = []
  const transport: ManjuMediaResolverTransport = {
    async listAssets(projectId, episodeId, signal) {
      calls.push([projectId, episodeId, signal])
      return [asset({ id: 'image-1' })]
    },
  }
  const resolver = new ManjuMediaResolver({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    transport,
  })
  const controller = new AbortController()
  const manifest = await resolver.resolve(
    tracks([element('image', 'image', 'image-1')]),
    controller.signal,
  )

  assert.equal(manifest.bindings.length, 1)
  assert.deepEqual(calls, [[PROJECT_ID, EPISODE_ID, controller.signal]])
})

test('ManjuMediaResolver rejects blank ownership scope', () => {
  assert.throws(
    () => new ManjuMediaResolver({ projectId: ' ', episodeId: EPISODE_ID }),
    /projectId and episodeId are required/,
  )
})

test('asset list client requests the episode plus same-project global assets', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ assets: [asset({ id: 'image-1' }), asset({
      id: 'speech-1',
      kind: 'speech',
      mimeType: 'audio/mpeg',
      width: null,
      height: null,
      durationSeconds: 1.25,
      speechSubtitle: {
        version: 1,
        lineId: 'line-1',
        mode: 'word',
        granularity: 'word',
        cues: [{ text: '醒来', startMs: 0, endMs: 900 }],
      },
    })] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const assets = await listAssets(PROJECT_ID, {
      episodeId: EPISODE_ID,
      includeProjectAssets: true,
    })
    assert.equal(assets[0]?.id, 'image-1')
    assert.deepEqual(assets[1]?.speechSubtitle, {
      version: 1,
      lineId: 'line-1',
      mode: 'word',
      granularity: 'word',
      cues: [{ text: '醒来', startMs: 0, endMs: 900 }],
    })
    assert.deepEqual(calls, [
      '/api/v1/assets?projectId=project-1&episodeId=episode-1&includeProjectAssets=true',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('asset list client rejects malformed or overlapping public speech subtitle data', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ assets: [asset({
    id: 'speech-invalid',
    kind: 'speech',
    mimeType: 'audio/mpeg',
    width: null,
    height: null,
    durationSeconds: 1.25,
    speechSubtitle: {
      version: 1,
      lineId: 'line-1',
      mode: 'word',
      granularity: 'word',
      cues: [
        { text: '一', startMs: 0, endMs: 800 },
        { text: '二', startMs: 700, endMs: 900 },
      ],
    },
  })] }), {
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch
  try {
    await assert.rejects(
      () => listAssets(PROJECT_ID, { episodeId: EPISODE_ID, kind: 'speech' }),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
