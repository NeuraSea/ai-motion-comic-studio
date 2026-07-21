import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveBundledFfprobePath,
  SpawnProcessRunner,
  type RenderProcessRunner,
} from './ffmpeg-renderer.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_PROBE_OUTPUT_BYTES = 128 * 1024
const MAX_STREAMS = 32

export class VideoMetadataProbeError extends Error {
  constructor(
    readonly code: 'BINARY_UNAVAILABLE' | 'INVALID_VIDEO' | 'PROBE_FAILED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'VideoMetadataProbeError'
  }
}

export interface ProbedVideoStream {
  codec: string
  width: number
  height: number
  frameRate: number | null
}

export interface ProbedAudioStream {
  codec: string
  sampleRate: number
  channels: number
}

export interface VideoMetadataProbeResult {
  formatName: string
  durationSeconds: number
  streamCount: number
  video: ProbedVideoStream
  audio: ProbedAudioStream[]
}

export interface VideoMetadataProbeOptions {
  ffprobePath?: string | null
  runner?: RenderProcessRunner
  timeoutMs?: number
}

export type VideoMetadataProbe = (
  bytes: Uint8Array,
  mimeType: 'video/mp4' | 'video/webm',
  signal?: AbortSignal,
) => Promise<VideoMetadataProbeResult>

interface RawProbeStream {
  codec_type?: unknown
  codec_name?: unknown
  width?: unknown
  height?: unknown
  avg_frame_rate?: unknown
  r_frame_rate?: unknown
  sample_rate?: unknown
  channels?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new VideoMetadataProbeError('INVALID_VIDEO', `ffprobe ${label} 无效`)
  }
  return value.trim()
}

function positiveNumber(value: unknown, label: string, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    throw new VideoMetadataProbeError('INVALID_VIDEO', `ffprobe ${label} 无效`)
  }
  return parsed
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  const parsed = positiveNumber(value, label, maximum)
  if (!Number.isSafeInteger(parsed)) {
    throw new VideoMetadataProbeError('INVALID_VIDEO', `ffprobe ${label} 无效`)
  }
  return parsed
}

function frameRate(stream: RawProbeStream): number | null {
  const value = stream.avg_frame_rate ?? stream.r_frame_rate
  if (typeof value !== 'string') return null
  const [numeratorValue, denominatorValue = '1'] = value.split('/', 2)
  const numerator = Number(numeratorValue)
  const denominator = Number(denominatorValue)
  const parsed = denominator === 0 ? Number.NaN : numerator / denominator
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000 ? parsed : null
}

function assertContainerMatchesMime(formatName: string, mimeType: 'video/mp4' | 'video/webm'): void {
  const formats = new Set(formatName.toLowerCase().split(',').map((item) => item.trim()))
  const matches = mimeType === 'video/mp4'
    ? ['mp4', 'mov', '3gp', '3g2', 'mj2'].some((format) => formats.has(format))
    : formats.has('webm') || formats.has('matroska')
  if (!matches) {
    throw new VideoMetadataProbeError('INVALID_VIDEO', '视频容器与检测到的 MIME 类型不一致')
  }
}

function metadataFromProbe(
  stdout: Buffer,
  mimeType: 'video/mp4' | 'video/webm',
): VideoMetadataProbeResult {
  let payload: unknown
  try {
    payload = JSON.parse(stdout.toString('utf8')) as unknown
  } catch (error) {
    throw new VideoMetadataProbeError('PROBE_FAILED', 'ffprobe 返回了无效 JSON', { cause: error })
  }
  if (!isRecord(payload) || !Array.isArray(payload.streams) || !isRecord(payload.format)
    || payload.streams.length < 1 || payload.streams.length > MAX_STREAMS) {
    throw new VideoMetadataProbeError('INVALID_VIDEO', 'ffprobe 未返回有效的容器与媒体流')
  }
  const streams = payload.streams.filter(isRecord) as RawProbeStream[]
  if (streams.length !== payload.streams.length) {
    throw new VideoMetadataProbeError('INVALID_VIDEO', 'ffprobe 媒体流信息无效')
  }
  const videos = streams.filter((stream) => stream.codec_type === 'video')
  const audios = streams.filter((stream) => stream.codec_type === 'audio')
  if (videos.length !== 1) {
    throw new VideoMetadataProbeError('INVALID_VIDEO', 'Seedance 成片必须恰好包含一条视频流')
  }
  if (audios.length > 8) {
    throw new VideoMetadataProbeError('INVALID_VIDEO', 'Seedance 成片包含过多音频流')
  }

  const formatName = requiredText(payload.format.format_name, 'format_name')
  assertContainerMatchesMime(formatName, mimeType)
  const video = videos[0]
  return {
    formatName,
    durationSeconds: positiveNumber(payload.format.duration, 'format.duration', 86_400),
    streamCount: streams.length,
    video: {
      codec: requiredText(video.codec_name, 'video.codec_name', 80),
      width: positiveInteger(video.width, 'video.width', 16_384),
      height: positiveInteger(video.height, 'video.height', 16_384),
      frameRate: frameRate(video),
    },
    audio: audios.map((audio, index) => ({
      codec: requiredText(audio.codec_name, `audio[${index}].codec_name`, 80),
      sampleRate: positiveInteger(audio.sample_rate, `audio[${index}].sample_rate`, 768_000),
      channels: positiveInteger(audio.channels, `audio[${index}].channels`, 32),
    })),
  }
}

/** Probe downloaded provider video before it becomes an immutable MediaStore asset. */
export function createVideoMetadataProbe(options: VideoMetadataProbeOptions = {}): VideoMetadataProbe {
  const ffprobePath = options.ffprobePath === undefined
    ? resolveBundledFfprobePath()
    : options.ffprobePath
  const runner = options.runner ?? new SpawnProcessRunner()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be positive')

  return async (bytes, mimeType, signal) => {
    if (!ffprobePath) {
      throw new VideoMetadataProbeError('BINARY_UNAVAILABLE', '当前平台没有可用的 ffprobe 固定二进制')
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new VideoMetadataProbeError('INVALID_VIDEO', '待测视频为空')
    }
    const extension = mimeType === 'video/mp4' ? 'mp4' : 'webm'
    const directory = await mkdtemp(join(tmpdir(), 'manju-video-probe-'))
    const inputPath = join(directory, `input.${extension}`)
    try {
      const file = await open(inputPath, 'wx', 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      const result = await runner.run({
        command: ffprobePath,
        args: [
          '-v', 'error',
          '-show_entries',
          'format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels',
          '-of', 'json',
          inputPath,
        ],
        cwd: directory,
        signal,
        timeoutMs,
        maxStdoutBytes: MAX_PROBE_OUTPUT_BYTES,
        maxStderrBytes: MAX_PROBE_OUTPUT_BYTES,
      })
      if (result.exitCode !== 0) {
        throw new VideoMetadataProbeError('PROBE_FAILED', `ffprobe 视频检测失败（退出码 ${result.exitCode}）`)
      }
      return metadataFromProbe(result.stdout, mimeType)
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      if (error instanceof VideoMetadataProbeError) throw error
      throw new VideoMetadataProbeError('PROBE_FAILED', '无法检测视频媒体规格', { cause: error })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

export const probeVideoMetadata = createVideoMetadataProbe()
