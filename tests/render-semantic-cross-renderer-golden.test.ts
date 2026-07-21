import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  OPEN_CUT_CLASSIC_COMMIT,
  renderSemanticPlanBoundarySignature,
  type RenderSemanticAudioClip,
  type RenderSemanticPlan,
  type RenderSemanticVisualClip,
} from '@manju/opencut-editor'
import {
  renderTimelineFromSemanticPlan,
  subtitlesAsSrt,
} from '../server/export-render.js'
import {
  createFfmpegRenderer,
  type ImmutableRenderTimelineSnapshot,
  type ProcessRunRequest,
  type ProcessRunResult,
  type RenderProcessRunner,
} from '../server/ffmpeg-renderer.js'
import { browserQuickExportBoundarySignature } from '../src/features/editor/browser-quick-export'
import { createPinnedRenderSemanticSession } from '../src/features/editor/render-semantic-session'
import type {
  EpisodeSummary,
  MediaAsset,
  TimelineDocumentSnapshot,
} from '../src/lib'

const SECOND = 120_000
const PROJECT_ID = 'semantic-golden-project'
const EPISODE_ID = 'semantic-golden-episode'
const STORY_REVISION_ID = 'semantic-golden-story-revision'
const TIMELINE_REVISION_ID = 'semantic-golden-timeline-revision'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01])
const SPEECH = Buffer.from('RIFF0000WAVEfmt test')
const BGM = Buffer.from('RIFF0000WAVEfmt semantic bgm')
const MP4 = Buffer.from('0000ftypisom-semantic-golden')

function checksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fixture(): {
  snapshot: TimelineDocumentSnapshot
  episode: EpisodeSummary
  assets: MediaAsset[]
} {
  const now = '2026-07-14T00:00:00.000Z'
  const document = {
    version: 1,
    editor: 'OpenCut-Classic',
    ticksPerSecond: SECOND,
    tracks: {
      overlay: [{
        id: 'visual-main',
        type: 'video',
        elements: [{
          id: 'semantic-image',
          type: 'image',
          mediaId: 'storyboard-image',
          startTime: 0,
          duration: 5 * SECOND,
          params: { fit: 'cover' },
          animations: {
            'transform.scaleX': {
              keys: [{
                id: 'push-x-start', time: 0, value: 1,
                segmentToNext: 'linear', tangentMode: 'flat',
              }, {
                id: 'push-x-end', time: 5 * SECOND, value: 1.08,
                segmentToNext: 'linear', tangentMode: 'flat',
              }],
              extrapolation: { before: 'hold', after: 'hold' },
            },
            'transform.scaleY': {
              keys: [{
                id: 'push-y-start', time: 0, value: 1,
                segmentToNext: 'linear', tangentMode: 'flat',
              }, {
                id: 'push-y-end', time: 5 * SECOND, value: 1.08,
                segmentToNext: 'linear', tangentMode: 'flat',
              }],
              extrapolation: { before: 'hold', after: 'hold' },
            },
          },
        }, {
          id: 'semantic-video-clip',
          type: 'video',
          mediaId: 'semantic-video',
          isSourceAudioEnabled: false,
          startTime: 5 * SECOND,
          duration: 5 * SECOND,
          trimStart: SECOND,
          sourceDuration: 8 * SECOND,
          params: { fit: 'contain' },
        }],
      }, {
        id: 'subtitles',
        type: 'text',
        elements: [{
          id: 'semantic-subtitle-a',
          type: 'text',
          name: '甲',
          startTime: 0,
          duration: SECOND,
          params: { text: '甲' },
        }, {
          id: 'semantic-subtitle-b',
          type: 'text',
          name: '乙',
          startTime: SECOND,
          duration: SECOND,
          params: { text: '乙' },
        }],
      }],
      main: { id: 'main', type: 'video', elements: [] },
      audio: [{
        id: 'dialogue',
        type: 'audio',
        elements: [{
          id: 'semantic-dialogue',
          type: 'audio',
          sourceType: 'upload',
          mediaId: 'speech-audio',
          startTime: 2 * SECOND,
          duration: 2 * SECOND,
          params: { dialogueLineId: 'line-1' },
        }],
      }, {
        id: 'semantic-bgm-track',
        type: 'audio',
        elements: [{
          id: 'semantic-bgm-clip',
          type: 'audio',
          sourceType: 'upload',
          mediaId: 'semantic-bgm',
          startTime: 0,
          duration: 10 * SECOND,
          params: {
            audioRole: 'bgm',
            volume: 0.4,
            fadeInSeconds: 0.5,
            fadeOutSeconds: 1,
          },
        }],
      }],
    },
  }
  const snapshot: TimelineDocumentSnapshot = {
    timelineDocument: {
      id: 'semantic-golden-document',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      currentRevisionId: TIMELINE_REVISION_ID,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      sourceRevisionId: STORY_REVISION_ID,
      createdAt: now,
      updatedAt: now,
    },
    revision: {
      id: TIMELINE_REVISION_ID,
      documentId: 'semantic-golden-document',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      parentRevisionId: null,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      sourceRevisionId: STORY_REVISION_ID,
      summary: 'cross-renderer golden',
      snapshot: document,
      createdAt: now,
    },
    document,
    etag: `W/"${TIMELINE_REVISION_ID}"`,
  }
  const episode: EpisodeSummary = {
    id: EPISODE_ID,
    projectId: PROJECT_ID,
    title: '语义黄金分集',
    sourceText: '语义黄金测试',
    targetDurationSeconds: 10,
    aspectRatio: '9:16',
    stylePreset: '国风动画',
    status: 'ready',
    sortOrder: 0,
    sourceRevisionId: STORY_REVISION_ID,
    createdAt: now,
    updatedAt: now,
  }
  const asset = (
    id: string,
    kind: string,
    mimeType: string,
    bytes: Buffer,
    durationSeconds: number | null,
  ): MediaAsset => ({
    id,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    kind,
    version: 1,
    status: 'ready',
    mimeType,
    width: mimeType.startsWith('image/') ? 1 : null,
    height: mimeType.startsWith('image/') ? 1 : null,
    durationSeconds,
    checksum: checksum(bytes),
    source: 'fixture',
    providerId: null,
    generationJobId: null,
    sourceRevisionId: STORY_REVISION_ID,
    parentAssetId: null,
    url: `/api/v1/assets/${encodeURIComponent(id)}/content`,
    createdAt: now,
    updatedAt: now,
  })
  return {
    snapshot,
    episode,
    assets: [
      asset('storyboard-image', 'storyboard.image', 'image/png', PNG, null),
      asset('semantic-video', 'shot.video', 'video/webm', WEBM, 8),
      asset('speech-audio', 'dialogue.speech', 'audio/wav', SPEECH, 5),
      asset('semantic-bgm', 'bgm', 'audio/wav', BGM, 10),
    ],
  }
}

function outputProbe(width: number, height: number, frames: number): Buffer {
  return Buffer.from(JSON.stringify({
    streams: [{
      codec_type: 'video',
      codec_name: 'h264',
      width,
      height,
      pix_fmt: 'yuv420p',
      r_frame_rate: '24/1',
      avg_frame_rate: '24/1',
      nb_frames: String(frames),
    }, {
      codec_type: 'audio',
      codec_name: 'aac',
      sample_rate: '48000',
      channels: 2,
    }],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: String(frames / 24),
    },
  }))
}

class GoldenRunner implements RenderProcessRunner {
  readonly calls: ProcessRunRequest[] = []

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    if (request.command === '/semantic-golden/ffmpeg') {
      await writeFile(request.args.at(-1)!, MP4, { flag: 'wx' })
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    if (request.args.includes('format=duration:stream=codec_type')) {
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({
          streams: [{ codec_type: 'video' }],
          format: { duration: '8' },
        })),
        stderr: Buffer.alloc(0),
      }
    }
    return {
      exitCode: 0,
      stdout: outputProbe(720, 1280, 240),
      stderr: Buffer.alloc(0),
    }
  }
}

function planObservedByFfmpeg(
  plan: RenderSemanticPlan,
  timeline: ImmutableRenderTimelineSnapshot,
): RenderSemanticPlan {
  assert.equal(timeline.revisionId, plan.timelineRevisionId)
  assert.equal(timeline.frameRate, plan.frameRate)
  const visualById = new Map(plan.visualClips.map((clip) => [clip.id, clip]))
  const audioById = new Map(plan.audioClips.map((clip) => [clip.id, clip]))
  const visualClips: RenderSemanticVisualClip[] = timeline.visualClips.map((rendered) => {
    const original = visualById.get(rendered.id)
    assert.ok(original, `FFmpeg received unknown visual ${rendered.id}`)
    assert.equal(rendered.mediaType ?? 'image', original.mediaType)
    assert.deepEqual(rendered.uniformScaleMotion, original.uniformScaleMotion)
    const sourceTrim = rendered.mediaType === 'video'
      ? {
          startFrame: Math.round(rendered.sourceStartSeconds * plan.frameRate),
          durationFrames: rendered.durationFrames,
          endTrimFrames: Math.round(rendered.sourceDurationSeconds * plan.frameRate)
            - Math.round(rendered.sourceStartSeconds * plan.frameRate)
            - rendered.durationFrames,
          sourceDurationFrames: Math.round(rendered.sourceDurationSeconds * plan.frameRate),
        }
      : null
    return {
      ...original,
      startFrame: rendered.startFrame,
      durationFrames: rendered.durationFrames,
      endFrameExclusive: rendered.startFrame + rendered.durationFrames,
      fit: rendered.fit ?? 'cover',
      ...(rendered.uniformScaleMotion
        ? { uniformScaleMotion: rendered.uniformScaleMotion }
        : {}),
      sourceTrim,
    } as RenderSemanticVisualClip
  })
  const audioClips: RenderSemanticAudioClip[] = (timeline.audioClips ?? []).map((rendered) => {
    const original = audioById.get(rendered.id)
    assert.ok(original, `FFmpeg received unknown audio ${rendered.id}`)
    assert.deepEqual(rendered.duckingWindows, original.duckingWindows)
    const sourceStartFrame = Math.round((rendered.sourceStartSeconds ?? 0) * plan.frameRate)
    const durationFrames = rendered.durationFrames ?? plan.totalFrames - rendered.startFrame
    return {
      ...original,
      startFrame: rendered.startFrame,
      durationFrames,
      endFrameExclusive: rendered.startFrame + durationFrames,
      sourceTrim: {
        ...original.sourceTrim,
        startFrame: sourceStartFrame,
        durationFrames,
        endTrimFrames: original.sourceTrim.sourceDurationFrames - sourceStartFrame - durationFrames,
      },
      linearGain: rendered.volume ?? 1,
      fadeInSeconds: rendered.fadeInSeconds ?? 0,
      fadeOutSeconds: rendered.fadeOutSeconds ?? 0,
      role: rendered.audioRole ?? original.role,
      duckingWindows: original.duckingWindows,
    }
  })
  return {
    ...plan,
    totalFrames: visualClips.reduce((sum, clip) => sum + clip.durationFrames, 0),
    visualClips,
    audioClips,
  }
}

test('one pinned snapshot has identical browser-quick-export and FFmpeg semantic boundaries', async () => {
  const input = fixture()
  const session = createPinnedRenderSemanticSession({
    projectId: PROJECT_ID,
    episode: input.episode,
    timelineSnapshot: input.snapshot,
    assets: input.assets,
  })
  const browserSignature = browserQuickExportBoundarySignature(session.plan)
  assert.equal(browserSignature, renderSemanticPlanBoundarySignature(session.plan))
  assert.deepEqual(session.plan.visualClips[0]?.uniformScaleMotion, {
    version: 1,
    startFrame: 0,
    durationFrames: 120,
    fromScale: 1,
    toScale: 1.08,
    anchorX: 0.5,
    anchorY: 0.5,
  })
  assert.equal(
    createHash('sha256').update(browserSignature).digest('hex'),
    'a79f2b9c9ff70ea62427eecc7f98a456c5c4192a73dda8f1cb839e0a63553dba',
  )

  const created = await mkdtemp(join(tmpdir(), 'manju-cross-renderer-golden-'))
  const directory = await realpath(created)
  try {
    const paths = new Map<string, string>([
      ['storyboard-image', join(directory, 'storyboard.png')],
      ['semantic-video', join(directory, 'shot.webm')],
      ['speech-audio', join(directory, 'speech.wav')],
      ['semantic-bgm', join(directory, 'bgm.wav')],
    ])
    const subtitlePath = join(directory, 'semantic.srt')
    const subtitleDocument = subtitlesAsSrt(session.plan.subtitleCues)
    await Promise.all([
      writeFile(paths.get('storyboard-image')!, PNG),
      writeFile(paths.get('semantic-video')!, WEBM),
      writeFile(paths.get('speech-audio')!, SPEECH),
      writeFile(paths.get('semantic-bgm')!, BGM),
      writeFile(subtitlePath, subtitleDocument),
    ])
    assert.equal(
      subtitleDocument,
      '1\n00:00:00,000 --> 00:00:01,000\n甲\n\n'
        + '2\n00:00:01,000 --> 00:00:02,000\n乙\n',
    )

    const timeline = renderTimelineFromSemanticPlan({
      plan: session.plan,
      assetPath: (assetId) => paths.get(assetId),
      kenBurns: false,
      subtitles: { assetPath: subtitlePath, format: 'srt', burnIn: true },
    })
    const serverObservedPlan = planObservedByFfmpeg(session.plan, timeline)
    assert.equal(renderSemanticPlanBoundarySignature(serverObservedPlan), browserSignature)

    const assetByClip = new Map([
      ...session.plan.visualClips.map((clip) => [clip.id, clip.asset] as const),
      ...session.plan.audioClips.map((clip) => [clip.id, clip.asset] as const),
    ])
    for (const clip of [...timeline.visualClips, ...(timeline.audioClips ?? [])]) {
      assert.equal(
        checksum(await readFile(clip.assetPath)),
        assetByClip.get(clip.id)?.checksum,
        `FFmpeg path for ${clip.id} must retain the immutable asset pin`,
      )
    }

    const runner = new GoldenRunner()
    const renderer = createFfmpegRenderer({
      ffmpegPath: '/semantic-golden/ffmpeg',
      ffprobePath: '/semantic-golden/ffprobe',
      runner,
    })
    const result = await renderer.render({
      timeline,
      resolution: '720p',
      aspectRatio: '9:16',
      outputPath: join(directory, 'semantic-golden.mp4'),
    })
    assert.equal(result.frameCount, session.plan.totalFrames)
    assert.equal(result.durationSeconds, 10)

    const ffmpegCall = runner.calls.find((call) => call.command === '/semantic-golden/ffmpeg')
    assert.ok(ffmpegCall)
    const graph = ffmpegCall.args[ffmpegCall.args.indexOf('-filter_complex') + 1]
    assert.match(
      graph,
      /\[0:v\]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280[^;]+zoompan=z='1\+0\.08\*on\/120'[^;]+trim=end_frame=120/,
    )
    assert.match(
      graph,
      /\[1:v\]trim=start=1:duration=5[^;]+force_original_aspect_ratio=decrease,pad=720:1280[^;]+trim=end_frame=120/,
    )
    assert.match(graph, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[vbase\]/)
    assert.match(graph, /subtitles=filename='subtitles\.srt'/)
    assert.match(graph, /atrim=start=0:duration=10[^;]+afade=t=in:st=0:d=0\.5/)
    assert.match(graph, /afade=t=out:st=9:d=1[^;]+volume=0\.4[^;]+eval=frame/)
    assert.match(graph, /atrim=start=0:duration=2[^;]+volume=1,adelay=96000S:all=1/)
    assert.match(graph, /amix=inputs=2:duration=longest/)
    assert.equal(ffmpegCall.args[ffmpegCall.args.indexOf('-frames:v') + 1], '240')
    assert.equal(ffmpegCall.args[ffmpegCall.args.lastIndexOf('-t') + 1], '10')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
