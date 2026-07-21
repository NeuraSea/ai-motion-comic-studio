import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import ffmpegStaticPath from 'ffmpeg-static'

import {
  FfmpegRenderError,
  SpawnProcessRunner,
  createFfmpegRenderer,
  resolutionDimensions,
  type ImmutableRenderTimelineSnapshot,
  type ProcessRunRequest,
  type ProcessRunResult,
  type RenderProcessRunner,
} from './ffmpeg-renderer.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function fixture(): Promise<{ directory: string; first: string; second: string; subtitles: string }> {
  const created = await mkdtemp(join(tmpdir(), 'manju-ffmpeg-renderer-test-'))
  const directory = await realpath(created)
  const first = join(directory, 'first.ppm')
  const second = join(directory, 'second.ppm')
  const subtitles = join(directory, 'captions.srt')
  await Promise.all([
    writeFile(first, ppm(255, 20, 20)),
    writeFile(second, ppm(20, 20, 255)),
    writeFile(subtitles, '1\n00:00:00,000 --> 00:00:00,900\n漫剧字幕\n'),
  ])
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return { directory, first, second, subtitles }
}

function ppm(red: number, green: number, blue: number): Buffer {
  const width = 32
  const height = 18
  const pixels = Buffer.alloc(width * height * 3)
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = red
    pixels[offset + 1] = green
    pixels[offset + 2] = blue
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels])
}

function probeJson(width: number, height: number, frames: number, duration = frames / 24): Buffer {
  return Buffer.from(JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width,
        height,
        pix_fmt: 'yuv420p',
        r_frame_rate: '24/1',
        avg_frame_rate: '24/1',
        nb_frames: String(frames),
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
      duration: String(duration),
    },
  }))
}

class FakeRunner implements RenderProcessRunner {
  readonly calls: ProcessRunRequest[] = []

  constructor(
    private readonly probeOutput: Buffer,
    private readonly beforeProbe?: () => Promise<void>,
    private readonly sourceProbeOutput?: Buffer,
  ) {}

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    if (request.command === '/test/ffmpeg') {
      await writeFile(request.args.at(-1)!, Buffer.from('....ftypisom-fake-mp4'))
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.from('bounded progress') }
    }
    await this.beforeProbe?.()
    if (request.args.includes('format=duration:stream=codec_type')) {
      return {
        exitCode: 0,
        stdout: this.sourceProbeOutput ?? this.probeOutput,
        stderr: Buffer.alloc(0),
      }
    }
    return { exitCode: 0, stdout: this.probeOutput, stderr: Buffer.alloc(0) }
  }
}

function sourceProbeJson(durationSeconds: number): Buffer {
  return Buffer.from(JSON.stringify({
    streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
    format: { duration: String(durationSeconds) },
  }))
}

function basicTimeline(first: string, second: string): ImmutableRenderTimelineSnapshot {
  return {
    revisionId: 'immutable-revision-1',
    frameRate: 24,
    visualClips: [
      { id: 'shot-1', startFrame: 0, durationFrames: 12, assetPath: first, kenBurns: true },
      { id: 'shot-2', startFrame: 12, durationFrames: 12, assetPath: second, fit: 'contain' },
    ],
  }
}

test('builds a hard-cut image render, burns a safely staged subtitle, adds silence, probes, and atomically publishes', async () => {
  const { directory, first, second, subtitles } = await fixture()
  const runner = new FakeRunner(probeJson(1280, 720, 24))
  const outputPath = join(directory, 'episode.mp4')
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })

  const result = await renderer.render({
    outputPath,
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: {
      ...basicTimeline(first, second),
      subtitles: { assetPath: subtitles, format: 'srt', burnIn: true },
    },
  })

  assert.equal(result.outputPath, outputPath)
  assert.equal(result.frameCount, 24)
  assert.equal(result.durationSeconds, 1)
  assert.deepEqual(result.probe.audio, { codec: 'aac', sampleRate: 48_000, channels: 2 })
  assert.deepEqual(await readFile(outputPath), Buffer.from('....ftypisom-fake-mp4'))
  assert.equal(runner.calls.length, 2)

  const ffmpeg = runner.calls[0]
  assert.equal(ffmpeg.command, '/test/ffmpeg')
  assert.ok(Array.isArray(ffmpeg.args))
  const graph = ffmpeg.args[ffmpeg.args.indexOf('-filter_complex') + 1]
  assert.match(graph, /zoompan=/)
  assert.match(graph, /pad=1280:720/)
  assert.match(graph, /concat=n=2:v=1:a=0/)
  assert.match(graph, /subtitles=filename='subtitles\.srt'/)
  assert.doesNotMatch(graph, /captions\.srt/)
  assert.ok(ffmpeg.args.includes('anullsrc=channel_layout=stereo:sample_rate=48000'))
  assert.ok(ffmpeg.args.includes('-nostats'))
  assert.deepEqual(ffmpeg.args.slice(ffmpeg.args.indexOf('-c:v'), ffmpeg.args.indexOf('-c:v') + 4), [
    '-c:v', 'libx264', '-preset', 'medium',
  ])
  assert.ok(ffmpeg.args.includes('yuv420p'))
  assert.ok(ffmpeg.args.includes('aac'))
  assert.equal(runner.calls[1].command, '/test/ffprobe')
  assert.deepEqual((await readdir(directory)).sort(), ['captions.srt', 'episode.mp4', 'first.ppm', 'second.ppm'])
})

test('stages ASS subtitles under a fixed task name and selects the libass filter', async () => {
  const { directory, first } = await fixture()
  const ass = join(directory, 'captions.ass')
  await writeFile(ass, [
    '[Script Info]',
    'ScriptType: v4.00+',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Alignment',
    'Style: Default,Arial,36,&H00FFFFFF,2',
    '[Events]',
    'Format: Layer, Start, End, Style, Text',
    'Dialogue: 0,0:00:00.00,0:00:00.40,Default,ASS',
  ].join('\n'))
  const runner = new FakeRunner(probeJson(1280, 720, 12, 0.5))
  const renderer = createFfmpegRenderer({ ffmpegPath: '/test/ffmpeg', ffprobePath: '/test/ffprobe', runner })

  await renderer.render({
    outputPath: join(directory, 'ass.mp4'),
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: {
      revisionId: 'ass-revision',
      frameRate: 24,
      visualClips: [{ id: 'shot', startFrame: 0, durationFrames: 12, assetPath: first }],
      subtitles: { assetPath: ass, format: 'ass', burnIn: true },
    },
  })

  const args = runner.calls[0].args
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.match(graph, /ass=filename='subtitles\.ass'/)
  assert.doesNotMatch(graph, /captions\.ass/)
})

test('mixes trusted audio at frame-accurate 48 kHz offsets instead of generating silence', async () => {
  const { directory, first, second } = await fixture()
  const audio = join(directory, 'voice.wav')
  await writeFile(audio, Buffer.from('RIFFfakeWAVEdata'))
  const runner = new FakeRunner(probeJson(1920, 1080, 24))
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })

  await renderer.render({
    outputPath: join(directory, 'with-audio.mp4'),
    resolution: '1080p',
    aspectRatio: '16:9',
    timeline: {
      ...basicTimeline(first, second),
      audioClips: [{
        id: 'voice-1',
        startFrame: 3,
        durationFrames: 12,
        sourceStartSeconds: 0.25,
        assetPath: audio,
        volume: 0.8,
        fadeInSeconds: 0.125,
        fadeOutSeconds: 0.25,
      }],
    },
  })

  const args = runner.calls[0].args
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.ok(args.includes(audio))
  assert.equal(args.some((argument) => argument.startsWith('anullsrc=')), false)
  assert.match(graph, /scale=1920:1080/)
  assert.match(graph, /atrim=start=0\.25:duration=0\.5/)
  assert.match(graph, /aresample=48000/)
  assert.match(graph, /afade=t=in:st=0:d=0\.125/)
  assert.match(graph, /afade=t=out:st=0\.25:d=0\.25/)
  assert.match(graph, /afade=t=in[^;]+afade=t=out[^;]+volume=0\.8[^;]+adelay=6000S:all=1/)
  assert.match(graph, /adelay=6000S:all=1/)
  assert.match(graph, /apad,atrim=end=1/)
})

test('keeps the legacy no-fade audio graph unchanged', async () => {
  const { directory, first, second } = await fixture()
  const audio = join(directory, 'legacy.wav')
  await writeFile(audio, Buffer.from('RIFFfakeWAVEdata'))
  const runner = new FakeRunner(probeJson(1920, 1080, 24))
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })

  await renderer.render({
    outputPath: join(directory, 'legacy-audio.mp4'),
    resolution: '1080p',
    aspectRatio: '16:9',
    timeline: {
      ...basicTimeline(first, second),
      audioClips: [{
        id: 'legacy-audio',
        startFrame: 0,
        durationFrames: 12,
        sourceStartSeconds: 0,
        assetPath: audio,
        volume: 1,
      }],
    },
  })

  const args = runner.calls[0].args
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.doesNotMatch(graph, /afade=/)
  assert.match(graph, /aformat=sample_rates=48000:channel_layouts=stereo,volume=1,adelay=0S:all=1/)
})

test('ducks only pinned BGM over frame-accurate dialogue intervals with 120 ms ramps', async () => {
  const { directory, first, second } = await fixture()
  const bgm = join(directory, 'bgm.wav')
  const dialogue = join(directory, 'dialogue.wav')
  const sfx = join(directory, 'sfx.wav')
  await Promise.all([
    writeFile(bgm, Buffer.from('RIFFbgm-WAVE')),
    writeFile(dialogue, Buffer.from('RIFFdialogue-WAVE')),
    writeFile(sfx, Buffer.from('RIFFsfx-WAVE')),
  ])
  const runner = new FakeRunner(probeJson(1920, 1080, 24))
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })

  await renderer.render({
    outputPath: join(directory, 'ducked-audio.mp4'),
    resolution: '1080p',
    aspectRatio: '16:9',
    timeline: {
      ...basicTimeline(first, second),
      audioClips: [
        {
          id: 'bgm-1', startFrame: 0, durationFrames: 24,
          assetPath: bgm, volume: 0.65, audioRole: 'bgm',
        },
        {
          id: 'dialogue-1', startFrame: 12, durationFrames: 6,
          assetPath: dialogue, volume: 1, audioRole: 'dialogue',
        },
        {
          id: 'sfx-1', startFrame: 15, durationFrames: 3,
          assetPath: sfx, volume: 0.8, audioRole: 'sfx',
        },
      ],
    },
  })

  const args = runner.calls[0].args
  const graph = args[args.indexOf('-filter_complex') + 1]
  const audioChains = graph.split(';').filter((chain) => /\[a\d+\]$/.test(chain))
  assert.equal(audioChains.length, 3)
  assert.match(
    audioChains[0],
    /volume=0\.65,volume='if\(lt\(t,0\.38\),1,if\(lt\(t,0\.5\),1-0\.65\*\(t-\(0\.38\)\)\/0\.12,if\(lt\(t,0\.75\),0\.35,if\(lt\(t,0\.87\),0\.35\+0\.65\*\(t-\(0\.75\)\)\/0\.12,1\)\)\)\)'\:eval=frame/,
  )
  assert.doesNotMatch(audioChains[1], /eval=frame/)
  assert.doesNotMatch(audioChains[2], /eval=frame/)
  assert.match(graph, /amix=inputs=3:duration=longest/)
})

test('uses explicit RenderSemanticPlan ducking windows without re-deriving dialogue intervals', async () => {
  const { directory, first, second } = await fixture()
  const bgm = join(directory, 'planned-bgm.wav')
  await writeFile(bgm, Buffer.from('RIFFplanned-WAVE'))
  const runner = new FakeRunner(probeJson(1920, 1080, 24))
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })

  await renderer.render({
    outputPath: join(directory, 'planned-ducking.mp4'),
    resolution: '1080p',
    aspectRatio: '16:9',
    timeline: {
      ...basicTimeline(first, second),
      audioClips: [{
        id: 'planned-bgm',
        startFrame: 0,
        durationFrames: 24,
        assetPath: bgm,
        volume: 0.5,
        audioRole: 'bgm',
        duckingWindows: [{
          startFrame: 6,
          endFrameExclusive: 12,
          duckedLinearGain: 0.2,
          attackSeconds: 0.1,
          releaseSeconds: 0.2,
        }],
      }],
    },
  })

  const args = runner.calls[0].args
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.match(
    graph,
    /volume=0\.5,volume='if\(lt\(t,0\.15\),1,if\(lt\(t,0\.25\),1-0\.8\*\(t-\(0\.15\)\)\/0\.1,if\(lt\(t,0\.5\),0\.2,if\(lt\(t,0\.7\),0\.2\+0\.8\*\(t-\(0\.5\)\)\/0\.2,1\)\)\)\)'\:eval=frame/,
  )
})

test('rejects an unknown renderer audio role before invoking FFmpeg', async () => {
  const { directory, first, second } = await fixture()
  const audio = join(directory, 'unknown-role.wav')
  await writeFile(audio, Buffer.from('RIFFunknown-WAVE'))
  const runner = new FakeRunner(probeJson(1920, 1080, 24))
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })

  await assert.rejects(
    renderer.render({
      outputPath: join(directory, 'unknown-role.mp4'),
      resolution: '1080p',
      aspectRatio: '16:9',
      timeline: {
        ...basicTimeline(first, second),
        audioClips: [{
          id: 'unknown-role',
          startFrame: 0,
          durationFrames: 12,
          assetPath: audio,
          audioRole: 'music' as 'bgm',
        }],
      },
    }),
    (error: unknown) => error instanceof FfmpegRenderError
      && error.code === 'INVALID_TIMELINE'
      && /audioRole/.test(error.message),
  )
  assert.equal(runner.calls.length, 0)
})

test('rejects non-finite, negative, oversized, or overlapping audio fades before FFmpeg', async () => {
  const { directory, first, second } = await fixture()
  const audio = join(directory, 'invalid-fades.wav')
  await writeFile(audio, Buffer.from('RIFFfakeWAVEdata'))
  const runner = new FakeRunner(probeJson(1920, 1080, 24))
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })
  const invalidCases: Array<{
    name: string
    fadeInSeconds?: number
    fadeOutSeconds?: number
  }> = [
    { name: 'nan', fadeInSeconds: Number.NaN },
    { name: 'infinity', fadeOutSeconds: Number.POSITIVE_INFINITY },
    { name: 'negative', fadeInSeconds: -0.01 },
    { name: 'fade-in-too-long', fadeInSeconds: 0.501 },
    { name: 'fade-out-too-long', fadeOutSeconds: 0.501 },
    { name: 'overlap', fadeInSeconds: 0.25, fadeOutSeconds: 0.251 },
  ]

  for (const invalid of invalidCases) {
    await assert.rejects(
      renderer.render({
        outputPath: join(directory, `${invalid.name}.mp4`),
        resolution: '1080p',
        aspectRatio: '16:9',
        timeline: {
          ...basicTimeline(first, second),
          audioClips: [{
            id: `invalid-${invalid.name}`,
            startFrame: 0,
            durationFrames: 12,
            sourceStartSeconds: 0,
            assetPath: audio,
            ...(invalid.fadeInSeconds === undefined
              ? {}
              : { fadeInSeconds: invalid.fadeInSeconds }),
            ...(invalid.fadeOutSeconds === undefined
              ? {}
              : { fadeOutSeconds: invalid.fadeOutSeconds }),
          }],
        },
      }),
      (error: unknown) => error instanceof FfmpegRenderError
        && error.code === 'INVALID_TIMELINE',
      invalid.name,
    )
  }
  assert.equal(runner.calls.length, 0)
})

test('preflights and hard-cuts a trimmed video beside an image while ignoring embedded audio', async () => {
  const { directory, first } = await fixture()
  const video = join(directory, 'seedance.mp4')
  await writeFile(video, Buffer.from('....ftypisom-source-with-audio'))
  const runner = new FakeRunner(
    probeJson(1280, 720, 24),
    undefined,
    sourceProbeJson(1),
  )
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })

  await renderer.render({
    outputPath: join(directory, 'mixed.mp4'),
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: {
      revisionId: 'mixed-video-revision',
      frameRate: 24,
      visualClips: [
        { mediaType: 'image', id: 'image', startFrame: 0, durationFrames: 12, assetPath: first },
        {
          mediaType: 'video',
          id: 'video',
          startFrame: 12,
          durationFrames: 12,
          assetPath: video,
          sourceStartSeconds: 0.25,
          sourceDurationSeconds: 1,
          fit: 'contain',
        },
      ],
    },
  })

  assert.equal(runner.calls.length, 3)
  assert.equal(runner.calls[0].command, '/test/ffprobe')
  assert.equal(runner.calls[0].args.at(-1), video)
  const ffmpeg = runner.calls[1]
  assert.equal(ffmpeg.command, '/test/ffmpeg')
  assert.equal(ffmpeg.args.filter((argument) => argument === '-loop').length, 1)
  assert.ok(ffmpeg.args.includes(video))
  const graph = ffmpeg.args[ffmpeg.args.indexOf('-filter_complex') + 1]
  assert.match(graph, /\[1:v\]trim=start=0\.25:duration=0\.5/)
  assert.match(graph, /pad=1280:720/)
  assert.match(graph, /fps=24/)
  assert.match(graph, /concat=n=2:v=1:a=0/)
  assert.doesNotMatch(graph, /\[1:a\]/)
  assert.ok(ffmpeg.args.includes('anullsrc=channel_layout=stereo:sample_rate=48000'))
})

test('rejects a video when ffprobe proves the immutable trim exceeds the real source', async () => {
  const { directory } = await fixture()
  const video = join(directory, 'too-short.mp4')
  await writeFile(video, Buffer.from('....ftypisom-short-source'))
  const runner = new FakeRunner(
    probeJson(1280, 720, 12, 0.5),
    undefined,
    sourceProbeJson(0.5),
  )
  const renderer = createFfmpegRenderer({
    ffmpegPath: '/test/ffmpeg',
    ffprobePath: '/test/ffprobe',
    runner,
  })

  await assert.rejects(renderer.render({
    outputPath: join(directory, 'must-not-render.mp4'),
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: {
      revisionId: 'short-source',
      frameRate: 24,
      visualClips: [{
        mediaType: 'video',
        id: 'video',
        startFrame: 0,
        durationFrames: 12,
        assetPath: video,
        sourceStartSeconds: 0.25,
        sourceDurationSeconds: 1,
      }],
    },
  }), (error: unknown) => (
    error instanceof FfmpegRenderError && error.code === 'INVALID_VIDEO_INPUT'
  ))
  assert.equal(runner.calls.length, 1)
})

test('rejects timeline gaps and non-24-fps snapshots before invoking a process', async () => {
  const { directory, first, second } = await fixture()
  const runner = new FakeRunner(probeJson(1280, 720, 24))
  const renderer = createFfmpegRenderer({ ffmpegPath: '/test/ffmpeg', ffprobePath: '/test/ffprobe', runner })
  const invalid = basicTimeline(first, second)

  await assert.rejects(
    renderer.render({
      outputPath: join(directory, 'gap.mp4'),
      resolution: '720p',
      aspectRatio: '16:9',
      timeline: {
        ...invalid,
        visualClips: [invalid.visualClips[0], { ...invalid.visualClips[1], startFrame: 13 }],
      },
    }),
    (error: unknown) => error instanceof FfmpegRenderError && error.code === 'INVALID_TIMELINE',
  )
  await assert.rejects(
    renderer.render({
      outputPath: join(directory, 'wrong-fps.mp4'),
      resolution: '720p',
      aspectRatio: '16:9',
      timeline: { ...invalid, frameRate: 30 as 24 },
    }),
    (error: unknown) => error instanceof FfmpegRenderError && error.code === 'INVALID_TIMELINE',
  )
  assert.equal(runner.calls.length, 0)
})

test('reports an unavailable platform binary as a structured error', async () => {
  const { directory, first, second } = await fixture()
  const renderer = createFfmpegRenderer({ ffmpegPath: null, ffprobePath: '/test/ffprobe' })
  await assert.rejects(
    renderer.render({
      outputPath: join(directory, 'unavailable.mp4'),
      resolution: '720p',
      aspectRatio: '16:9',
      timeline: basicTimeline(first, second),
    }),
    (error: unknown) => error instanceof FfmpegRenderError && error.code === 'BINARY_UNAVAILABLE',
  )
})

test('accepts only canonical absolute regular asset files and rejects symlinks', async () => {
  const { directory, first } = await fixture()
  const linked = join(directory, 'linked.ppm')
  await symlink(first, linked)
  const runner = new FakeRunner(probeJson(1280, 720, 12, 0.5))
  const renderer = createFfmpegRenderer({ ffmpegPath: '/test/ffmpeg', ffprobePath: '/test/ffprobe', runner })

  await assert.rejects(
    renderer.render({
      outputPath: join(directory, 'relative.mp4'),
      resolution: '720p',
      aspectRatio: '16:9',
      timeline: {
        revisionId: 'r',
        frameRate: 24,
        visualClips: [{ id: 'image', startFrame: 0, durationFrames: 12, assetPath: 'relative.ppm' }],
      },
    }),
    (error: unknown) => error instanceof FfmpegRenderError && error.code === 'UNSAFE_INPUT_PATH',
  )
  await assert.rejects(
    renderer.render({
      outputPath: join(directory, 'linked.mp4'),
      resolution: '720p',
      aspectRatio: '16:9',
      timeline: {
        revisionId: 'r',
        frameRate: 24,
        visualClips: [{ id: 'image', startFrame: 0, durationFrames: 12, assetPath: linked }],
      },
    }),
    (error: unknown) => error instanceof FfmpegRenderError && error.code === 'UNSAFE_INPUT_PATH',
  )
  assert.equal(runner.calls.length, 0)
})

test('never overwrites an existing output', async () => {
  const { directory, first, second } = await fixture()
  const outputPath = join(directory, 'existing.mp4')
  await writeFile(outputPath, 'original')
  const runner = new FakeRunner(probeJson(1280, 720, 24))
  const renderer = createFfmpegRenderer({ ffmpegPath: '/test/ffmpeg', ffprobePath: '/test/ffprobe', runner })

  await assert.rejects(
    renderer.render({
      outputPath,
      resolution: '720p',
      aspectRatio: '16:9',
      timeline: basicTimeline(first, second),
    }),
    (error: unknown) => error instanceof FfmpegRenderError && error.code === 'OUTPUT_EXISTS',
  )
  assert.equal(await readFile(outputPath, 'utf8'), 'original')
  assert.equal(runner.calls.length, 0)
})

test('does not publish an output that fails ffprobe specification validation', async () => {
  const { directory, first, second } = await fixture()
  const outputPath = join(directory, 'invalid-probe.mp4')
  const invalidProbe = JSON.parse(probeJson(1280, 720, 24).toString('utf8'))
  invalidProbe.streams[0].codec_name = 'hevc'
  const runner = new FakeRunner(Buffer.from(JSON.stringify(invalidProbe)))
  const renderer = createFfmpegRenderer({ ffmpegPath: '/test/ffmpeg', ffprobePath: '/test/ffprobe', runner })

  await assert.rejects(
    renderer.render({
      outputPath,
      resolution: '720p',
      aspectRatio: '16:9',
      timeline: basicTimeline(first, second),
    }),
    (error: unknown) => error instanceof FfmpegRenderError && error.code === 'INVALID_RENDER_OUTPUT',
  )
  assert.equal(existsSync(outputPath), false)
  assert.equal((await readdir(directory)).some((name) => name.startsWith('.manju-render-')), false)
})

test('a destination created during rendering wins and is never replaced', async () => {
  const { directory, first, second } = await fixture()
  const outputPath = join(directory, 'raced.mp4')
  const runner = new FakeRunner(probeJson(1280, 720, 24), async () => {
    await writeFile(outputPath, 'other-writer')
  })
  const renderer = createFfmpegRenderer({ ffmpegPath: '/test/ffmpeg', ffprobePath: '/test/ffprobe', runner })

  await assert.rejects(
    renderer.render({
      outputPath,
      resolution: '720p',
      aspectRatio: '16:9',
      timeline: basicTimeline(first, second),
    }),
    (error: unknown) => error instanceof FfmpegRenderError && error.code === 'OUTPUT_EXISTS',
  )
  assert.equal(await readFile(outputPath, 'utf8'), 'other-writer')
})

function processRequest(
  directory: string,
  code: string,
  overrides: Partial<ProcessRunRequest> = {},
): ProcessRunRequest {
  return {
    command: process.execPath,
    args: ['-e', code],
    cwd: directory,
    timeoutMs: 2_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    ...overrides,
  }
}

test('native runner cancels a spawned process through AbortSignal', async () => {
  const { directory } = await fixture()
  const controller = new AbortController()
  const runner = new SpawnProcessRunner()
  const running = runner.run(processRequest(
    directory,
    'setInterval(() => {}, 1000)',
    { signal: controller.signal },
  ))
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(
    running,
    (error: unknown) => error instanceof FfmpegRenderError && error.code === 'CANCELLED',
  )
})

test('native runner enforces timeout and bounded stderr', async () => {
  const { directory } = await fixture()
  const runner = new SpawnProcessRunner()
  await assert.rejects(
    runner.run(processRequest(directory, 'setInterval(() => {}, 1000)', { timeoutMs: 30 })),
    (error: unknown) => error instanceof FfmpegRenderError && error.code === 'TIMEOUT',
  )
  await assert.rejects(
    runner.run(processRequest(
      directory,
      "process.stderr.write('x'.repeat(10000)); setInterval(() => {}, 1000)",
      { maxStderrBytes: 100 },
    )),
    (error: unknown) => error instanceof FfmpegRenderError && error.code === 'PROCESS_OUTPUT_LIMIT',
  )
})

const realBinariesAvailable = typeof ffmpegStaticPath === 'string'
  && existsSync(ffmpegStaticPath)
  && existsSync(ffprobeInstaller.path)

test('renders and ffprobes a real short golden MP4 with the pinned arm64 binaries', {
  skip: realBinariesAvailable ? false : 'bundled FFmpeg/ffprobe are unavailable on this platform',
  timeout: 120_000,
}, async () => {
  const { directory, first, second, subtitles } = await fixture()
  const outputPath = join(directory, 'golden.mp4')
  const result = await createFfmpegRenderer({ renderTimeoutMs: 90_000 }).render({
    outputPath,
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: {
      ...basicTimeline(first, second),
      subtitles: { assetPath: subtitles, format: 'srt', burnIn: true },
    },
  })

  assert.equal(result.probe.video.codec, 'h264')
  assert.equal(result.probe.video.width, 1280)
  assert.equal(result.probe.video.height, 720)
  assert.equal(result.probe.video.pixelFormat, 'yuv420p')
  assert.equal(result.probe.video.frameRate, 24)
  assert.equal(result.probe.audio.codec, 'aac')
  assert.equal(result.probe.audio.sampleRate, 48_000)
  assert.equal(result.probe.audio.channels, 2)
  assert.equal(result.frameCount, 24)
  assert.equal((await readFile(outputPath)).subarray(4, 8).toString('ascii'), 'ftyp')
})

test('renders a real image plus trimmed MP4 and its explicit source-audio clip', {
  skip: realBinariesAvailable ? false : 'bundled FFmpeg/ffprobe are unavailable on this platform',
  timeout: 120_000,
}, async () => {
  const { directory, first, second } = await fixture()
  if (typeof ffmpegStaticPath !== 'string') assert.fail('ffmpeg-static path unavailable')
  const sourceVideo = join(directory, 'source-with-audio.mp4')
  const generated = await new SpawnProcessRunner().run({
    command: ffmpegStaticPath,
    args: [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
      '-loop', '1', '-framerate', '24', '-i', second,
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
      '-t', '1', '-shortest',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      sourceVideo,
    ],
    cwd: directory,
    timeoutMs: 60_000,
    maxStdoutBytes: 256 * 1_024,
    maxStderrBytes: 256 * 1_024,
  })
  assert.equal(generated.exitCode, 0, generated.stderr.toString('utf8'))

  const outputPath = join(directory, 'mixed-golden.mp4')
  const result = await createFfmpegRenderer({ renderTimeoutMs: 90_000 }).render({
    outputPath,
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: {
      revisionId: 'real-mixed-revision',
      frameRate: 24,
      visualClips: [
        { mediaType: 'image', id: 'image', startFrame: 0, durationFrames: 12, assetPath: first },
        {
          mediaType: 'video',
          id: 'video',
          startFrame: 12,
          durationFrames: 12,
          assetPath: sourceVideo,
          sourceStartSeconds: 0.25,
          sourceDurationSeconds: 1,
          fit: 'cover',
        },
      ],
      audioClips: [{
        id: 'video-source-audio',
        startFrame: 12,
        durationFrames: 12,
        assetPath: sourceVideo,
        sourceStartSeconds: 0.25,
        fadeInSeconds: 0.1,
        fadeOutSeconds: 0.1,
      }],
    },
  })

  assert.equal(result.timelineRevisionId, 'real-mixed-revision')
  assert.equal(result.frameCount, 24)
  assert.equal(result.durationSeconds, 1)
  assert.equal(result.probe.video.frameRate, 24)
  assert.equal(result.probe.video.width, 1280)
  assert.equal(result.probe.video.height, 720)
  assert.equal(result.probe.audio.codec, 'aac')
  assert.equal((await readFile(outputPath)).subarray(4, 8).toString('ascii'), 'ftyp')
})

test('renders a real short MP4 with deterministic dialogue ducking', {
  skip: realBinariesAvailable ? false : 'bundled FFmpeg/ffprobe are unavailable on this platform',
  timeout: 120_000,
}, async () => {
  const { directory, first } = await fixture()
  if (typeof ffmpegStaticPath !== 'string') assert.fail('ffmpeg-static path unavailable')
  const bgm = join(directory, 'real-bgm.wav')
  const dialogue = join(directory, 'real-dialogue.wav')
  for (const [path, frequency] of [[bgm, 440], [dialogue, 880]] as const) {
    const generated = await new SpawnProcessRunner().run({
      command: ffmpegStaticPath,
      args: [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`,
        '-t', '1', '-c:a', 'pcm_s16le', path,
      ],
      cwd: directory,
      timeoutMs: 60_000,
      maxStdoutBytes: 256 * 1_024,
      maxStderrBytes: 256 * 1_024,
    })
    assert.equal(generated.exitCode, 0, generated.stderr.toString('utf8'))
  }

  const outputPath = join(directory, 'real-ducked.mp4')
  const result = await createFfmpegRenderer({ renderTimeoutMs: 90_000 }).render({
    outputPath,
    resolution: '720p',
    aspectRatio: '16:9',
    timeline: {
      revisionId: 'real-ducking-revision',
      frameRate: 24,
      visualClips: [{ id: 'image', startFrame: 0, durationFrames: 24, assetPath: first }],
      audioClips: [
        {
          id: 'bgm', startFrame: 0, durationFrames: 24,
          assetPath: bgm, volume: 0.65, audioRole: 'bgm',
        },
        {
          id: 'dialogue', startFrame: 8, durationFrames: 8,
          assetPath: dialogue, audioRole: 'dialogue',
        },
      ],
    },
  })

  assert.equal(result.timelineRevisionId, 'real-ducking-revision')
  assert.equal(result.frameCount, 24)
  assert.equal(result.durationSeconds, 1)
  assert.equal(result.probe.audio.codec, 'aac')
  assert.equal(result.probe.audio.sampleRate, 48_000)
  assert.equal((await readFile(outputPath)).subarray(4, 8).toString('ascii'), 'ftyp')
})

test('maps every supported aspect ratio to stable export dimensions', () => {
  assert.deepEqual(resolutionDimensions('1080p', '16:9'), { width: 1920, height: 1080 })
  assert.deepEqual(resolutionDimensions('1080p', '9:16'), { width: 1080, height: 1920 })
  assert.deepEqual(resolutionDimensions('1080p', '1:1'), { width: 1080, height: 1080 })
  assert.deepEqual(resolutionDimensions('720p', '16:9'), { width: 1280, height: 720 })
  assert.deepEqual(resolutionDimensions('720p', '9:16'), { width: 720, height: 1280 })
  assert.deepEqual(resolutionDimensions('720p', '1:1'), { width: 720, height: 720 })
})
