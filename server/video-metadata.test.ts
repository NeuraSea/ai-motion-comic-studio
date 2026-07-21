import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import ffmpegStaticPath from 'ffmpeg-static'

import {
  SpawnProcessRunner,
  type ProcessRunRequest,
  type ProcessRunResult,
  type RenderProcessRunner,
} from './ffmpeg-renderer.js'
import { createVideoMetadataProbe } from './video-metadata.js'

class FixtureRunner implements RenderProcessRunner {
  readonly calls: ProcessRunRequest[] = []
  readonly inputPaths: string[] = []

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    const inputPath = request.args.at(-1)!
    this.inputPaths.push(inputPath)
    const info = await stat(inputPath)
    assert.equal(info.isFile(), true)
    assert.equal(info.mode & 0o077, 0)
    return {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1280,
            height: 720,
            avg_frame_rate: '24/1',
          },
          {
            codec_type: 'audio',
            codec_name: 'aac',
            sample_rate: '48000',
            channels: 2,
          },
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '5.125',
        },
      })),
      stderr: Buffer.alloc(0),
    }
  }
}

test('probes provider bytes through a private temporary file and returns normalized stream metadata', async () => {
  const runner = new FixtureRunner()
  const probe = createVideoMetadataProbe({ ffprobePath: '/fixture/ffprobe', runner })
  const result = await probe(Buffer.from('....ftypisom-fixture'), 'video/mp4')

  assert.deepEqual(result, {
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationSeconds: 5.125,
    streamCount: 2,
    video: { codec: 'h264', width: 1280, height: 720, frameRate: 24 },
    audio: [{ codec: 'aac', sampleRate: 48_000, channels: 2 }],
  })
  assert.equal(runner.calls.length, 1)
  assert.deepEqual(runner.calls[0].args.slice(0, -1), [
    '-v', 'error',
    '-show_entries',
    'format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels',
    '-of', 'json',
  ])
  await assert.rejects(() => access(runner.inputPaths[0]))
})

const realBinariesAvailable = typeof ffmpegStaticPath === 'string'
  && existsSync(ffmpegStaticPath)
  && existsSync(ffprobeInstaller.path)

test('probes a real short MP4 with video and audio using the pinned binaries', {
  skip: realBinariesAvailable ? false : 'bundled FFmpeg/ffprobe are unavailable on this platform',
  timeout: 120_000,
}, async () => {
  if (typeof ffmpegStaticPath !== 'string') assert.fail('ffmpeg-static path unavailable')
  const directory = await mkdtemp(join(tmpdir(), 'manju-video-probe-golden-'))
  try {
    const outputPath = join(directory, 'golden.mp4')
    const generated = await new SpawnProcessRunner().run({
      command: ffmpegStaticPath,
      args: [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
        '-t', '1', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart',
        outputPath,
      ],
      cwd: directory,
      timeoutMs: 60_000,
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 256 * 1024,
    })
    assert.equal(generated.exitCode, 0, generated.stderr.toString('utf8'))

    const result = await createVideoMetadataProbe()(await readFile(outputPath), 'video/mp4')
    assert.equal(result.video.codec, 'h264')
    assert.equal(result.video.width, 320)
    assert.equal(result.video.height, 180)
    assert.equal(result.video.frameRate, 24)
    assert.equal(result.audio.length, 1)
    assert.equal(result.audio[0].codec, 'aac')
    assert.equal(result.audio[0].sampleRate, 48_000)
    assert.equal(result.audio[0].channels, 2)
    assert.ok(result.durationSeconds >= 0.9 && result.durationSeconds <= 1.1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
