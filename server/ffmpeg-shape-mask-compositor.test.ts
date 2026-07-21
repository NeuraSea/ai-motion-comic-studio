import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'manju-shape-mask-')))
  const image = join(directory, 'image.ppm')
  const pixels = Buffer.alloc(64 * 36 * 3, 210)
  await writeFile(image, Buffer.concat([Buffer.from('P6\n64 36\n255\n'), pixels]))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return { directory, image }
}

const realBinariesAvailable = typeof ffmpegStaticPath === 'string'
  && existsSync(ffmpegStaticPath)
  && existsSync(ffprobeInstaller.path)

test('real FFmpeg ellipse mask keeps pixels inside and blacks pixels outside its curved edge', {
  skip: realBinariesAvailable ? false : 'bundled FFmpeg/ffprobe are unavailable on this platform',
  timeout: 120_000,
}, async () => {
  const { directory, image } = await fixture()
  const outputPath = join(directory, 'ellipse.mp4')
  await createFfmpegRenderer({ renderTimeoutMs: 90_000 }).render({
    outputPath,
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: {
      revisionId: 'ellipse-mask',
      frameRate: 24,
      visualClips: [{
        id: 'shot', startFrame: 0, durationFrames: 24, assetPath: image,
        shapeMask: {
          version: 1, type: 'ellipse', centerX: 0, centerY: 0, width: 0.5, height: 0.4,
        },
      }],
    },
  })
  const ffmpegPath = ffmpegStaticPath
  if (typeof ffmpegPath !== 'string') assert.fail('ffmpeg-static path unavailable')

  const sample = async (x: number, y: number): Promise<number> => {
    const result = await new SpawnProcessRunner().run({
      command: ffmpegPath,
      args: [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', outputPath,
        '-vf', `select=eq(n\\,12),format=rgb24,crop=1:1:${x}:${y}`,
        '-frames:v', '1', '-f', 'rawvideo', '-',
      ],
      cwd: directory,
      timeoutMs: 60_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 64 * 1_024,
    })
    assert.equal(result.exitCode, 0, result.stderr.toString('utf8'))
    assert.equal(result.stdout.length, 3)
    return result.stdout.reduce((sum, channel) => sum + channel, 0) / 3
  }

  assert.ok(await sample(640, 360) > 170, 'ellipse centre should retain the source')
  assert.ok(await sample(800, 432) > 170, 'point inside the ellipse should retain the source')
  // This point is inside the ellipse bounding rectangle but outside the curve.
  assert.ok(await sample(800, 490) < 20, 'curved-edge exclusion should be black')
  assert.ok(await sample(100, 100) < 20, 'outside the mask should be black')
})

test('real FFmpeg inverted ellipse mask blacks pixels inside and keeps pixels outside', {
  skip: realBinariesAvailable ? false : 'bundled FFmpeg/ffprobe are unavailable on this platform',
  timeout: 120_000,
}, async () => {
  const { directory, image } = await fixture()
  const outputPath = join(directory, 'inverted-ellipse.mp4')
  await createFfmpegRenderer({ renderTimeoutMs: 90_000 }).render({
    outputPath,
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: {
      revisionId: 'inverted-ellipse-mask',
      frameRate: 24,
      visualClips: [{
        id: 'shot', startFrame: 0, durationFrames: 24, assetPath: image,
        shapeMask: {
          version: 2, type: 'ellipse', inverted: true,
          centerX: 0, centerY: 0, width: 0.5, height: 0.4,
        },
      }],
    },
  })
  const ffmpegPath = ffmpegStaticPath
  if (typeof ffmpegPath !== 'string') assert.fail('ffmpeg-static path unavailable')

  const sample = async (x: number, y: number): Promise<number> => {
    const result = await new SpawnProcessRunner().run({
      command: ffmpegPath,
      args: [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', outputPath,
        '-vf', `select=eq(n\\,12),format=rgb24,crop=1:1:${x}:${y}`,
        '-frames:v', '1', '-f', 'rawvideo', '-',
      ],
      cwd: directory,
      timeoutMs: 60_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 64 * 1_024,
    })
    assert.equal(result.exitCode, 0, result.stderr.toString('utf8'))
    assert.equal(result.stdout.length, 3)
    return result.stdout.reduce((sum, channel) => sum + channel, 0) / 3
  }

  assert.ok(await sample(640, 360) < 20, 'ellipse centre should be black')
  assert.ok(await sample(800, 432) < 20, 'point inside the ellipse should be black')
  assert.ok(await sample(800, 490) > 170, 'point outside the curve should retain the source')
  assert.ok(await sample(100, 100) > 170, 'outside the mask should retain the source')
})

class CapturingRunner implements RenderProcessRunner {
  readonly calls: ProcessRunRequest[] = []

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    if (request.command === '/test/ffmpeg') {
      await writeFile(request.args.at(-1)!, Buffer.from('....ftypisom-mask'))
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({
        streams: [
          {
            codec_type: 'video', codec_name: 'h264', width: 1280, height: 720,
            pix_fmt: 'yuv420p', r_frame_rate: '24/1', avg_frame_rate: '24/1', nb_frames: '24',
          },
          { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
        ],
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1' },
      })),
      stderr: Buffer.alloc(0),
    }
  }
}

test('formal FFmpeg filter graph applies the pinned rectangle mask before opacity', async () => {
  const { directory, image } = await fixture()
  const runner = new CapturingRunner()
  await createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg', ffprobePath: '/test/ffprobe', runner,
  }).render({
    outputPath: join(directory, 'output.mp4'), resolution: '720p', aspectRatio: '16:9',
    timeline: {
      revisionId: 'rectangle', frameRate: 24,
      visualClips: [{
        id: 'shot', startFrame: 0, durationFrames: 24, assetPath: image,
        shapeMask: {
          version: 1, type: 'rectangle', centerX: 0, centerY: 0, width: 0.5, height: 0.5,
        },
        opacityFade: {
          version: 1, fadeIn: { startFrame: 0, durationFrames: 6 }, fadeOut: null,
        },
      }],
    },
  })
  const args = runner.calls[0]!.args
  const graph = args[args.indexOf('-filter_complex') + 1]!
  assert.match(graph, /format=gbrp,geq=r='/)
  assert.match(graph, /gte\(X,320\).*lte\(X,960\).*gte\(Y,180\).*lte\(Y,540\)/)
  assert.match(graph, /geq=.*fade=t=in:st=0:d=0\.25,format=yuv420p/)
})

test('formal FFmpeg filter graph negates a pinned v2 inverted mask condition', async () => {
  const { directory, image } = await fixture()
  const runner = new CapturingRunner()
  await createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg', ffprobePath: '/test/ffprobe', runner,
  }).render({
    outputPath: join(directory, 'inverted-output.mp4'), resolution: '720p', aspectRatio: '16:9',
    timeline: {
      revisionId: 'inverted-rectangle', frameRate: 24,
      visualClips: [{
        id: 'shot', startFrame: 0, durationFrames: 24, assetPath: image,
        shapeMask: {
          version: 2, type: 'rectangle', inverted: true,
          centerX: 0, centerY: 0, width: 0.5, height: 0.5,
        },
      }],
    },
  })
  const args = runner.calls[0]!.args
  const graph = args[args.indexOf('-filter_complex') + 1]!
  assert.match(
    graph,
    /geq=r='if\(not\(gte\(X,320\)\*lte\(X,960\)\*gte\(Y,180\)\*lte\(Y,540\)\),r\(X,Y\),0\)'/,
  )
})

test('formal FFmpeg renderer rejects malformed masks before spawn', async () => {
  const { directory, image } = await fixture()
  const runner = new CapturingRunner()
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg', ffprobePath: '/test/ffprobe', runner,
  })
  await assert.rejects(renderer.render({
    outputPath: join(directory, 'invalid.mp4'), resolution: '720p', aspectRatio: '16:9',
    timeline: {
      revisionId: 'invalid', frameRate: 24,
      visualClips: [{
        id: 'shot', startFrame: 0, durationFrames: 24, assetPath: image,
        shapeMask: {
          version: 1, type: 'ellipse', centerX: 0, centerY: 0, width: 0, height: 0.5,
        },
      }],
    },
  }), (error: unknown) => error instanceof FfmpegRenderError
    && error.code === 'INVALID_TIMELINE')
  await assert.rejects(renderer.render({
    outputPath: join(directory, 'invalid-v2.mp4'), resolution: '720p', aspectRatio: '16:9',
    timeline: {
      revisionId: 'invalid-v2', frameRate: 24,
      visualClips: [{
        id: 'shot', startFrame: 0, durationFrames: 24, assetPath: image,
        shapeMask: {
          version: 2, type: 'ellipse', centerX: 0, centerY: 0, width: 0.5, height: 0.5,
        } as never,
      }],
    },
  }), (error: unknown) => error instanceof FfmpegRenderError
    && error.code === 'INVALID_TIMELINE')
  assert.equal(runner.calls.length, 0)
})
