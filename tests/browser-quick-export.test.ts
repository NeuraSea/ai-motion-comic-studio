import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  RenderSemanticAudioClip,
  RenderSemanticPlan,
  RenderSemanticVisualClip,
} from '@manju/opencut-editor'
import {
  applyCanvasRenderSemanticUniformScale,
  BrowserQuickExportError,
  browserQuickExportBoundarySignature,
  browserQuickExportBaseSupport,
  clipCanvasToRenderSemanticShapeMask,
  fittedMediaRect,
  semanticAudioGainAtSeconds,
  validateQuickExportManifest,
  type BrowserQuickExportRuntimeCapabilities,
} from '../src/features/editor/browser-quick-export'
import type { TimelineMediaManifest } from '../src/features/editor/manju-media-resolver'

const checksum = 'a'.repeat(64)

function audioClip(): RenderSemanticAudioClip {
  return {
    id: 'bgm',
    asset: {
      assetId: 'asset-bgm',
      version: 3,
      checksum,
      sourceDurationFrames: 96,
    },
    startFrame: 0,
    durationFrames: 96,
    endFrameExclusive: 96,
    sourceTrim: {
      startFrame: 0,
      durationFrames: 96,
      endTrimFrames: 0,
      sourceDurationFrames: 96,
    },
    linearGain: 0.5,
    fadeInSeconds: 1,
    fadeOutSeconds: 1,
    role: 'bgm',
    duckingWindows: [{
      triggerAudioClipIds: ['dialogue'],
      startFrame: 24,
      endFrameExclusive: 48,
      duckedLinearGain: 0.35,
      attackSeconds: 0.12,
      releaseSeconds: 0.12,
    }],
  }
}

function plan(): RenderSemanticPlan {
  return {
    version: 1,
    timelineDocumentId: 'doc',
    timelineRevisionId: 'revision',
    storyRevisionId: 'story',
    upstreamCommit: 'cf5e79e919144200294fb9fed22a222592a0aeea',
    ticksPerSecond: 120_000,
    frameRate: 24,
    aspectRatio: '9:16',
    totalFrames: 96,
    visualClips: [{
      id: 'visual',
      mediaType: 'image',
      asset: {
        assetId: 'asset-image',
        version: 2,
        checksum: 'b'.repeat(64),
        sourceDurationFrames: null,
      },
      startFrame: 0,
      durationFrames: 96,
      endFrameExclusive: 96,
      sourceTrim: null,
      fit: 'cover',
    }],
    audioClips: [audioClip()],
    subtitleCues: [],
    audioMix: {
      dialogueDucking: {
        triggerRole: 'dialogue',
        targetRole: 'bgm',
        duckedLinearGain: 0.35,
        attackSeconds: 0.12,
        releaseSeconds: 0.12,
        mergedDialogueWindows: [],
      },
    },
  }
}

const allCapabilities: BrowserQuickExportRuntimeCapabilities = {
  document: true,
  fetch: true,
  crypto: true,
  createImageBitmap: true,
  videoEncoder: true,
  videoDecoder: true,
  audioEncoder: true,
  audioDecoder: true,
  offlineAudioContext: true,
}

test('quick export stays disabled when a required browser codec primitive is absent', () => {
  assert.deepEqual(browserQuickExportBaseSupport(plan(), allCapabilities), {
    supported: true,
    reason: null,
  })
  const unsupported = browserQuickExportBaseSupport(plan(), {
    ...allCapabilities,
    audioEncoder: false,
  })
  assert.equal(unsupported.supported, false)
  assert.match(unsupported.reason ?? '', /AudioEncoder/)
})

function scaleMotionClip({
  fromScale = 1,
  toScale = 1.12,
  mediaType = 'image',
}: {
  fromScale?: number
  toScale?: number
  mediaType?: 'image' | 'video'
} = {}): RenderSemanticVisualClip {
  return {
    ...plan().visualClips[0]!,
    mediaType,
    sourceTrim: mediaType === 'video'
      ? {
          startFrame: 0,
          durationFrames: 96,
          endTrimFrames: 0,
          sourceDurationFrames: 96,
        }
      : null,
    uniformScaleMotion: {
      version: 1,
      startFrame: 0,
      durationFrames: 96,
      fromScale,
      toScale,
      anchorX: 0.5,
      anchorY: 0.5,
    },
  }
}

test('quick export only accepts uniform still-image scale motion in RSP v4', () => {
  const motion = scaleMotionClip()
  const legacy: RenderSemanticPlan = {
    ...plan(),
    version: 3,
    visualClips: [motion],
  }
  assert.deepEqual(browserQuickExportBaseSupport(legacy, allCapabilities), {
    supported: false,
    reason: 'RenderSemanticPlan v3 不能携带图片推拉运动语义',
  })

  const current: RenderSemanticPlan = {
    ...legacy,
    version: 4,
  }
  assert.deepEqual(browserQuickExportBaseSupport(current, allCapabilities), {
    supported: true,
    reason: null,
  })

  assert.deepEqual(browserQuickExportBaseSupport({
    ...current,
    visualClips: [scaleMotionClip({ mediaType: 'video' })],
  }, allCapabilities), {
    supported: false,
    reason: '视频片段不能携带图片推拉运动语义',
  })
})

test('Canvas compositor keeps the mask fixed before applying centre scale', () => {
  const calls: Array<readonly [string, ...number[]]> = []
  const context = {
    canvas: { width: 720, height: 1280 },
    beginPath: () => calls.push(['beginPath']),
    ellipse: (...values: number[]) => calls.push(['ellipse', ...values]),
    rect: (...values: number[]) => calls.push(['rect', ...values]),
    clip: () => calls.push(['clip']),
    translate: (...values: number[]) => calls.push(['translate', ...values]),
    scale: (...values: number[]) => calls.push(['scale', ...values]),
  } as unknown as CanvasRenderingContext2D
  const clip: RenderSemanticVisualClip = {
    ...scaleMotionClip({ fromScale: 1.12, toScale: 1 }),
    shapeMask: {
      version: 1,
      type: 'ellipse',
      centerX: 0,
      centerY: 0,
      width: 0.8,
      height: 0.6,
    },
  }

  clipCanvasToRenderSemanticShapeMask(context, clip)
  assert.equal(applyCanvasRenderSemanticUniformScale(context, clip, 48), 1.06)
  assert.deepEqual(calls.map(([name]) => name), [
    'beginPath',
    'ellipse',
    'clip',
    'translate',
    'scale',
    'translate',
  ])
  assert.deepEqual(calls.slice(-3), [
    ['translate', 360, 640],
    ['scale', 1.06, 1.06],
    ['translate', -360, -640],
  ])
})

test('browser boundary signature observes the same start/middle/last-frame scale', () => {
  const current: RenderSemanticPlan = {
    ...plan(),
    version: 4,
    visualClips: [scaleMotionClip()],
  }
  const signature = JSON.parse(browserQuickExportBoundarySignature(current)) as Array<{
    frame: number
    visual: Array<{ scale?: number }>
  }>
  const scaleAt = (frame: number) => signature.find((sample) => sample.frame === frame)
    ?.visual[0]?.scale
  assert.equal(scaleAt(0), 1)
  assert.equal(scaleAt(48), 1.06)
  assert.equal(scaleAt(95), 1.11875)
})

test('cover crops and contain letterboxes without changing aspect ratio', () => {
  assert.deepEqual(fittedMediaRect({
    sourceWidth: 1920,
    sourceHeight: 1080,
    targetWidth: 720,
    targetHeight: 1280,
    fit: 'cover',
  }), {
    sourceX: 656.25,
    sourceY: 0,
    sourceWidth: 607.5,
    sourceHeight: 1080,
    targetX: 0,
    targetY: 0,
    targetWidth: 720,
    targetHeight: 1280,
  })
  assert.deepEqual(fittedMediaRect({
    sourceWidth: 1920,
    sourceHeight: 1080,
    targetWidth: 720,
    targetHeight: 1280,
    fit: 'contain',
  }), {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: 1920,
    sourceHeight: 1080,
    targetX: 0,
    targetY: 437.5,
    targetWidth: 720,
    targetHeight: 405,
  })
})

test('preview gain follows the plan fade and explicit dialogue ducking windows', () => {
  const clip = audioClip()
  assert.equal(semanticAudioGainAtSeconds(clip, 0), 0)
  assert.equal(semanticAudioGainAtSeconds(clip, 0.5), 0.25)
  assert.equal(semanticAudioGainAtSeconds(clip, 1, 24), 0.175)
  assert.equal(semanticAudioGainAtSeconds(clip, 2, 24), 0.175)
  assert.equal(semanticAudioGainAtSeconds(clip, 3.5), 0.25)
  assert.equal(semanticAudioGainAtSeconds(clip, 4), 0)
})

test('manifest validation requires the exact plan asset version and checksum', () => {
  const manifest: TimelineMediaManifest = {
    issues: [],
    bindings: [{
      trackId: 'visual-track',
      elementId: 'visual',
      elementType: 'image',
      assetId: 'asset-image',
      assetVersion: 2,
      assetChecksum: 'b'.repeat(64),
      url: '/api/v1/assets/asset-image/content',
      mimeType: 'image/png',
      startTime: 0,
      duration: 480_000,
      trimStart: 0,
      trimEnd: 0,
      retimeRate: 1,
      width: 720,
      height: 1280,
      sourceDurationSeconds: null,
      sourceAudioEnabled: false,
    }, {
      trackId: 'audio-track',
      elementId: 'bgm',
      elementType: 'audio',
      assetId: 'asset-bgm',
      assetVersion: 3,
      assetChecksum: checksum,
      url: '/api/v1/assets/asset-bgm/content',
      mimeType: 'audio/mpeg',
      startTime: 0,
      duration: 480_000,
      trimStart: 0,
      trimEnd: 0,
      retimeRate: 1,
      width: null,
      height: null,
      sourceDurationSeconds: 4,
      sourceAudioEnabled: false,
    }],
  }
  assert.deepEqual(
    validateQuickExportManifest(plan(), manifest).map((binding) => binding.assetId),
    ['asset-image', 'asset-bgm'],
  )
  manifest.bindings[1]!.assetVersion = 4
  assert.throws(
    () => validateQuickExportManifest(plan(), manifest),
    (error: unknown) => error instanceof BrowserQuickExportError
      && error.code === 'ASSET_CHANGED',
  )
})

test('manifest validation keeps the explicit short-video image-hold as a separate pinned clip', () => {
  const shortPlan: RenderSemanticPlan = {
    ...plan(),
    totalFrames: 120,
    visualClips: [{
      id: 'short-video-element',
      mediaType: 'video',
      asset: {
        assetId: 'short-video',
        version: 2,
        checksum: 'c'.repeat(64),
        sourceDurationFrames: 72,
      },
      startFrame: 0,
      durationFrames: 72,
      endFrameExclusive: 72,
      sourceTrim: {
        startFrame: 0,
        durationFrames: 72,
        endTrimFrames: 0,
        sourceDurationFrames: 72,
      },
      fit: 'cover',
    }, {
      id: 'short-video-element::same-shot-locked-image-hold-v1',
      mediaType: 'image',
      asset: {
        assetId: 'same-shot-storyboard',
        version: 4,
        checksum: 'd'.repeat(64),
        sourceDurationFrames: null,
      },
      startFrame: 72,
      durationFrames: 48,
      endFrameExclusive: 120,
      sourceTrim: null,
      fit: 'cover',
    }],
    audioClips: [],
  }
  const manifest: TimelineMediaManifest = {
    issues: [],
    bindings: [{
      trackId: 'visual-track', elementId: 'short-video-element', elementType: 'video',
      assetId: 'short-video', assetVersion: 2, assetChecksum: 'c'.repeat(64),
      url: '/api/v1/assets/short-video/content', mimeType: 'video/mp4',
      startTime: 0, duration: 600_000, trimStart: 0, trimEnd: 0, retimeRate: 1,
      width: 1280, height: 720, sourceDurationSeconds: 3, sourceAudioEnabled: false,
    }, {
      trackId: 'visual-track',
      elementId: 'short-video-element::same-shot-locked-image-hold-v1',
      elementType: 'image', assetId: 'same-shot-storyboard', assetVersion: 4,
      assetChecksum: 'd'.repeat(64), url: '/api/v1/assets/same-shot-storyboard/content',
      mimeType: 'image/png', startTime: 360_000, duration: 240_000,
      trimStart: 0, trimEnd: 0, retimeRate: 1, width: 1280, height: 720,
      sourceDurationSeconds: null, sourceAudioEnabled: false,
    }],
  }

  assert.deepEqual(validateQuickExportManifest(shortPlan, manifest).map((binding) => (
    [binding.elementId, binding.assetId]
  )), [
    ['short-video-element', 'short-video'],
    ['short-video-element::same-shot-locked-image-hold-v1', 'same-shot-storyboard'],
  ])
})
