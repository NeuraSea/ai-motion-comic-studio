import assert from 'node:assert/strict'
import { access, stat } from 'node:fs/promises'
import { test } from 'node:test'

import {
  AudioDurationProbeError,
  createAudioDurationProbe,
} from './audio-duration.js'
import type {
  ProcessRunRequest,
  ProcessRunResult,
  RenderProcessRunner,
} from './ffmpeg-renderer.js'

class FixtureRunner implements RenderProcessRunner {
  calls: ProcessRunRequest[] = []
  result: ProcessRunResult = {
    exitCode: 0,
    stdout: Buffer.from(JSON.stringify({
      streams: [{ codec_type: 'audio' }],
      format: { duration: '1.234' },
    })),
    stderr: Buffer.alloc(0),
  }

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    await access(request.args.at(-1)!)
    const info = await stat(request.args.at(-1)!)
    assert.equal(info.isFile(), true)
    assert.equal(info.mode & 0o077, 0)
    return this.result
  }
}

test('measures audio through a private temporary file and removes it afterwards', async () => {
  const runner = new FixtureRunner()
  const probe = createAudioDurationProbe({ ffprobePath: '/fixture/ffprobe', runner })
  const duration = await probe(Buffer.from('fixture audio'), 'audio/mpeg')
  assert.equal(duration, 1.234)
  assert.equal(runner.calls.length, 1)
  assert.deepEqual(runner.calls[0].args.slice(0, -1), [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'format=duration:stream=codec_type,duration_ts,time_base',
    '-of', 'json',
  ])
  await assert.rejects(() => access(runner.calls[0].args.at(-1)!))
})

test('prefers exact stream timestamps over rounded container duration', async () => {
  const runner = new FixtureRunner()
  runner.result = {
    exitCode: 0,
    stdout: Buffer.from(JSON.stringify({
      streams: [{
        codec_type: 'audio',
        duration_ts: 227_850,
        time_base: '1/44100',
      }],
      format: { duration: '5.166667' },
    })),
    stderr: Buffer.alloc(0),
  }
  const probe = createAudioDurationProbe({ ffprobePath: '/fixture/ffprobe', runner })
  const duration = await probe(Buffer.from('fixture audio'), 'audio/wav')
  assert.equal(duration * 24, 124)
})

test('fails safely for missing binaries, unsupported media, bad probe output, and probe errors', async () => {
  await assert.rejects(
    () => createAudioDurationProbe({ ffprobePath: null })(Buffer.from('x'), 'audio/mpeg'),
    (error: unknown) => error instanceof AudioDurationProbeError && error.code === 'BINARY_UNAVAILABLE',
  )
  await assert.rejects(
    () => createAudioDurationProbe({ ffprobePath: '/fixture/ffprobe', runner: new FixtureRunner() })(Buffer.from('x'), 'audio/ogg'),
    (error: unknown) => error instanceof AudioDurationProbeError && error.code === 'INVALID_AUDIO',
  )

  const malformed = new FixtureRunner()
  malformed.result = { exitCode: 0, stdout: Buffer.from('{}'), stderr: Buffer.alloc(0) }
  await assert.rejects(
    () => createAudioDurationProbe({ ffprobePath: '/fixture/ffprobe', runner: malformed })(Buffer.from('x'), 'audio/wav'),
    (error: unknown) => error instanceof AudioDurationProbeError && error.code === 'INVALID_AUDIO',
  )

  const noAudioStream = new FixtureRunner()
  noAudioStream.result = {
    exitCode: 0,
    stdout: Buffer.from(JSON.stringify({ streams: [], format: { duration: '1.25' } })),
    stderr: Buffer.alloc(0),
  }
  await assert.rejects(
    () => createAudioDurationProbe({ ffprobePath: '/fixture/ffprobe', runner: noAudioStream })(Buffer.from('x'), 'audio/mpeg'),
    (error: unknown) => error instanceof AudioDurationProbeError && error.code === 'INVALID_AUDIO',
  )

  const failed = new FixtureRunner()
  failed.result = { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('private path') }
  await assert.rejects(
    () => createAudioDurationProbe({ ffprobePath: '/fixture/ffprobe', runner: failed })(Buffer.from('x'), 'audio/wav'),
    (error: unknown) => error instanceof AudioDurationProbeError
      && error.code === 'PROBE_FAILED'
      && !error.message.includes('private path'),
  )
})
