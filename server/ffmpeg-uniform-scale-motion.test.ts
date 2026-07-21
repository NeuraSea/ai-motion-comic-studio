import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  FfmpegRenderError,
  createFfmpegRenderer,
  type ImmutableRenderTimelineSnapshot,
  type ProcessRunRequest,
  type ProcessRunResult,
  type RenderProcessRunner,
} from './ffmpeg-renderer.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

class CapturingRunner implements RenderProcessRunner {
  readonly calls: ProcessRunRequest[] = []

  constructor(
    private readonly frameCount = 48,
  ) {}

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    if (request.command === '/test/ffmpeg') {
      await writeFile(request.args.at(-1)!, Buffer.from('....ftypisom-uniform-scale'))
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({
        streams: [
          {
            codec_type: 'video', codec_name: 'h264', width: 1280, height: 720,
            pix_fmt: 'yuv420p', r_frame_rate: '24/1', avg_frame_rate: '24/1',
            nb_frames: String(this.frameCount),
          },
          { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: String(this.frameCount / 24),
        },
      })),
      stderr: Buffer.alloc(0),
    }
  }
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'manju-uniform-scale-')))
  const image = join(directory, 'image.ppm')
  const pixels = Buffer.alloc(64 * 36 * 3, 210)
  await writeFile(image, Buffer.concat([Buffer.from('P6\n64 36\n255\n'), pixels]))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return { directory, image }
}

function uniformScaleMotion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    startFrame: 0,
    durationFrames: 24,
    fromScale: 1,
    toScale: 1.2,
    anchorX: 0.5,
    anchorY: 0.5,
    ...overrides,
  }
}

function imageClip(
  image: string,
  overrides: Record<string, unknown> = {},
): ImmutableRenderTimelineSnapshot['visualClips'][number] {
  return {
    id: 'shot',
    startFrame: 0,
    durationFrames: 24,
    assetPath: image,
    ...overrides,
  } as unknown as ImmutableRenderTimelineSnapshot['visualClips'][number]
}

function timeline(
  clips: readonly ImmutableRenderTimelineSnapshot['visualClips'][number][],
): ImmutableRenderTimelineSnapshot {
  return {
    revisionId: 'uniform-scale-revision',
    frameRate: 24,
    visualClips: clips,
  }
}

function renderer(runner: CapturingRunner) {
  return createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })
}

function filterGraph(runner: CapturingRunner): string {
  const ffmpeg = runner.calls.find((call) => call.command === '/test/ffmpeg')
  assert.ok(ffmpeg, 'FFmpeg must be called for a valid normalized timeline')
  const filterIndex = ffmpeg.args.indexOf('-filter_complex')
  assert.notEqual(filterIndex, -1)
  return ffmpeg.args[filterIndex + 1]!
}

function visualFilter(graph: string, index: number): string {
  const start = graph.indexOf(`[${index}:v]`)
  const end = graph.indexOf(`[v${index}]`, start)
  assert.notEqual(start, -1, `missing input visual filter ${index}`)
  assert.notEqual(end, -1, `missing output visual filter ${index}`)
  return graph.slice(start, end)
}

test('formal FFmpeg renderer compiles push and pull receipts with on/durationFrames progress', async () => {
  const { directory, image } = await fixture()
  const runner = new CapturingRunner(48)
  await renderer(runner).render({
    outputPath: join(directory, 'push-pull.mp4'),
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: timeline([
      imageClip(image, {
        uniformScaleMotion: uniformScaleMotion(),
        shapeMask: {
          version: 1, type: 'rectangle', centerX: 0, centerY: 0, width: 0.5, height: 0.5,
        },
        opacityFade: {
          version: 1, fadeIn: { startFrame: 0, durationFrames: 6 }, fadeOut: null,
        },
      }),
      imageClip(image, {
        id: 'shot-pull',
        startFrame: 24,
        uniformScaleMotion: uniformScaleMotion({ fromScale: 1.2, toScale: 1 }),
      }),
    ]),
  })

  const graph = filterGraph(runner)
  const push = visualFilter(graph, 0)
  const pull = visualFilter(graph, 1)

  assert.match(push, /zoompan=z='1(?:\.0+)?\+0\.2(?:0+)?\*on\/24'/)
  assert.match(pull, /zoompan=z='1\.2(?:0+)?-0\.2(?:0+)?\*on\/24'/)
  assert.doesNotMatch(graph, /on\/23/)
  for (const filter of [push, pull]) {
    assert.match(filter, /x='iw\/2-iw\/zoom\/2':y='ih\/2-ih\/zoom\/2':d=1:s=1280x720:fps=24/)
  }

  const fitAt = push.indexOf('scale=')
  const motionAt = push.indexOf('zoompan=')
  const maskAt = push.indexOf('format=gbrp,geq=')
  const opacityAt = push.indexOf('fade=t=in:st=0:d=0.25')
  assert.ok(fitAt >= 0 && fitAt < motionAt, 'fit must run before uniform scale motion')
  assert.ok(motionAt < maskAt, 'uniform scale motion must run before the mask')
  assert.ok(maskAt < opacityAt, 'the mask must run before opacity')
})

test('formal FFmpeg renderer rejects timeline motion combined with legacy kenBurns before spawn', async () => {
  const { directory, image } = await fixture()
  const runner = new CapturingRunner(24)
  await assert.rejects(renderer(runner).render({
    outputPath: join(directory, 'double-motion.mp4'),
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: timeline([imageClip(image, {
      kenBurns: true,
      uniformScaleMotion: uniformScaleMotion(),
    })]),
  }), (error: unknown) => error instanceof FfmpegRenderError
    && error.code === 'INVALID_TIMELINE')
  assert.equal(runner.calls.length, 0)
})

test('formal FFmpeg renderer rejects unknown and drifted scale receipts before spawn', async () => {
  const { directory, image } = await fixture()
  const malformed: Array<[string, Record<string, unknown>]> = [
    ['unknown-key', uniformScaleMotion({ futureField: true })],
    ['version-drift', uniformScaleMotion({ version: 2 })],
    ['start-frame-drift', uniformScaleMotion({ startFrame: 1 })],
    ['duration-drift', uniformScaleMotion({ durationFrames: 23 })],
    ['from-below-range', uniformScaleMotion({ fromScale: 0.999999 })],
    ['to-above-range', uniformScaleMotion({ toScale: 1.200001 })],
    ['unchanged-scale', uniformScaleMotion({ fromScale: 1.1, toScale: 1.1 })],
    ['anchor-x-drift', uniformScaleMotion({ anchorX: 0.500001 })],
    ['anchor-y-drift', uniformScaleMotion({ anchorY: 0.499999 })],
  ]

  for (const [name, receipt] of malformed) {
    const runner = new CapturingRunner(24)
    await assert.rejects(renderer(runner).render({
      outputPath: join(directory, `${name}.mp4`),
      resolution: '720p',
      aspectRatio: '16:9',
      timeline: timeline([imageClip(image, { uniformScaleMotion: receipt })]),
    }), (error: unknown) => error instanceof FfmpegRenderError
      && error.code === 'INVALID_TIMELINE', name)
    assert.equal(runner.calls.length, 0, `${name} must fail before runner/spawn`)
  }
})

test('formal FFmpeg renderer rejects uniform scale motion on video before probe or spawn', async () => {
  const { directory, image } = await fixture()
  const runner = new CapturingRunner(24)
  await assert.rejects(renderer(runner).render({
    outputPath: join(directory, 'video-motion.mp4'),
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: timeline([imageClip(image, {
      mediaType: 'video',
      sourceStartSeconds: 0,
      sourceDurationSeconds: 1,
      uniformScaleMotion: uniformScaleMotion(),
    })]),
  }), (error: unknown) => error instanceof FfmpegRenderError
    && error.code === 'INVALID_TIMELINE')
  assert.equal(runner.calls.length, 0)
})
