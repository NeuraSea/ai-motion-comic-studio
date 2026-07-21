import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import ffmpegStaticPath from 'ffmpeg-static'

import {
  FfmpegRenderError,
  SpawnProcessRunner,
  createFfmpegRenderer,
  type ProcessRunRequest,
  type ProcessRunResult,
  type RenderProcessRunner,
} from './ffmpeg-renderer.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const realBinariesAvailable = typeof ffmpegStaticPath === 'string'
  && existsSync(ffmpegStaticPath)
  && existsSync(ffprobeInstaller.path)

test('real FFmpeg output contains the audited black-to-visible-to-black opacity envelope', {
  skip: realBinariesAvailable ? false : 'bundled FFmpeg/ffprobe are unavailable on this platform',
  timeout: 120_000,
}, async () => {
  const { directory, image } = await fixture()
  const outputPath = join(directory, 'real-opacity.mp4')
  const result = await createFfmpegRenderer({ renderTimeoutMs: 90_000 }).render({
    outputPath,
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: {
      revisionId: 'real-opacity',
      frameRate: 24,
      visualClips: [{
        id: 'shot',
        startFrame: 0,
        durationFrames: 48,
        assetPath: image,
        opacityFade: {
          version: 1,
          fadeIn: { startFrame: 0, durationFrames: 12 },
          fadeOut: { startFrame: 36, durationFrames: 12 },
        },
      }],
    },
  })
  assert.equal(result.frameCount, 48)
  assert.equal((await readFile(outputPath)).subarray(4, 8).toString('ascii'), 'ftyp')
  if (typeof ffmpegStaticPath !== 'string') assert.fail('ffmpeg-static path unavailable')
  const sampled = await new SpawnProcessRunner().run({
    command: ffmpegStaticPath,
    args: [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', outputPath,
      '-vf', 'select=eq(n\\,0)+eq(n\\,12)+eq(n\\,47),scale=1:1,format=rgb24',
      '-fps_mode', 'vfr', '-f', 'rawvideo', '-',
    ],
    cwd: directory,
    timeoutMs: 60_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 64 * 1_024,
  })
  assert.equal(sampled.exitCode, 0, sampled.stderr.toString('utf8'))
  assert.equal(sampled.stdout.length, 9)
  const brightness = [0, 1, 2].map((sample) => (
    sampled.stdout.subarray(sample * 3, sample * 3 + 3)
      .reduce((sum, channel) => sum + channel, 0) / 3
  ))
  assert.ok(brightness[0]! < 8, `first frame should be black, received ${brightness[0]}`)
  assert.ok(brightness[1]! > 140, `middle frame should be visible, received ${brightness[1]}`)
  assert.ok(brightness[2]! < 35, `last frame should be nearly black, received ${brightness[2]}`)
})

class CapturingRunner implements RenderProcessRunner {
  readonly calls: ProcessRunRequest[] = []

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    if (request.command === '/test/ffmpeg') {
      await writeFile(request.args.at(-1)!, Buffer.from('....ftypisom-opacity'))
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({
        streams: [
          {
            codec_type: 'video', codec_name: 'h264', width: 1280, height: 720,
            pix_fmt: 'yuv420p', r_frame_rate: '24/1', avg_frame_rate: '24/1',
            nb_frames: '48',
          },
          { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
        ],
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2' },
      })),
      stderr: Buffer.alloc(0),
    }
  }
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'manju-opacity-compositor-')))
  const image = join(directory, 'image.ppm')
  const pixels = Buffer.alloc(32 * 18 * 3, 180)
  await writeFile(image, Buffer.concat([Buffer.from('P6\n32 18\n255\n'), pixels]))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return { directory, image }
}

test('formal FFmpeg renderer applies the pinned OpenCut opacity fade after frame normalization', async () => {
  const { directory, image } = await fixture()
  const runner = new CapturingRunner()
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })
  await renderer.render({
    outputPath: join(directory, 'output.mp4'),
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: {
      revisionId: 'revision',
      frameRate: 24,
      visualClips: [{
        id: 'shot',
        startFrame: 0,
        durationFrames: 48,
        assetPath: image,
        opacityFade: {
          version: 1,
          fadeIn: { startFrame: 0, durationFrames: 12 },
          fadeOut: { startFrame: 36, durationFrames: 12 },
        },
      }],
    },
  })
  const args = runner.calls[0]!.args
  const graph = args[args.indexOf('-filter_complex') + 1]!
  assert.match(
    graph,
    /setpts=PTS-STARTPTS,fade=t=in:st=0:d=0\.5,fade=t=out:st=1\.5:d=0\.5,format=yuv420p/,
  )
})

test('formal FFmpeg renderer rejects malformed or overlapping opacity receipts before spawn', async () => {
  const { directory, image } = await fixture()
  const runner = new CapturingRunner()
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })
  await assert.rejects(
    renderer.render({
      outputPath: join(directory, 'invalid.mp4'),
      resolution: '720p',
      aspectRatio: '16:9',
      timeline: {
        revisionId: 'revision',
        frameRate: 24,
        visualClips: [{
          id: 'shot',
          startFrame: 0,
          durationFrames: 24,
          assetPath: image,
          opacityFade: {
            version: 1,
            fadeIn: { startFrame: 0, durationFrames: 16 },
            fadeOut: { startFrame: 12, durationFrames: 12 },
          },
        }],
      },
    }),
    (error: unknown) => error instanceof FfmpegRenderError
      && error.code === 'INVALID_TIMELINE',
  )
  assert.equal(runner.calls.length, 0)
})
