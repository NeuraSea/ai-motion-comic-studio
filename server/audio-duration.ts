import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveBundledFfprobePath,
  SpawnProcessRunner,
  type RenderProcessRunner,
} from './ffmpeg-renderer.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024

export class AudioDurationProbeError extends Error {
  constructor(
    readonly code: 'BINARY_UNAVAILABLE' | 'INVALID_AUDIO' | 'PROBE_FAILED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AudioDurationProbeError'
  }
}

export interface AudioDurationProbeOptions {
  ffprobePath?: string | null
  runner?: RenderProcessRunner
  timeoutMs?: number
}

export type AudioDurationProbe = (
  bytes: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
) => Promise<number>

function extensionForMime(mimeType: string): string {
  if (mimeType === 'audio/mpeg') return 'mp3'
  if (mimeType === 'audio/wav') return 'wav'
  throw new AudioDurationProbeError('INVALID_AUDIO', '无法测量不受支持的音频格式')
}

function durationFromProbe(stdout: Buffer): number {
  let payload: unknown
  try {
    payload = JSON.parse(stdout.toString('utf8')) as unknown
  } catch (error) {
    throw new AudioDurationProbeError('PROBE_FAILED', 'ffprobe 返回了无效 JSON', { cause: error })
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null
  const streams = record && Array.isArray(record.streams)
    ? record.streams
    : []
  const audioStreams = streams.filter((stream) => (
    stream && typeof stream === 'object' && !Array.isArray(stream)
    && 'codec_type' in stream && stream.codec_type === 'audio'
  ))
  if (audioStreams.length === 0) {
    throw new AudioDurationProbeError('INVALID_AUDIO', 'ffprobe 未返回有效音频流')
  }

  // Prefer ffprobe's integer timestamp and rational time base. `format.duration`
  // is commonly rounded to six decimals; applying an outward frame cover to
  // that rounded value can invent a whole extra frame for an audio file whose
  // sample boundary is exactly frame-aligned (for example 227850/44100 s).
  const exactStreamDurations = audioStreams.flatMap((stream) => {
    const value = stream as Record<string, unknown>
    const timestamp = typeof value.duration_ts === 'string'
      ? value.duration_ts
      : Number.isSafeInteger(value.duration_ts)
        ? String(value.duration_ts)
        : null
    const timeBase = typeof value.time_base === 'string' ? value.time_base : null
    const timestampMatch = timestamp?.match(/^\d+$/u)
    const timeBaseMatch = timeBase?.match(/^(\d+)\/(\d+)$/u)
    if (!timestampMatch || !timeBaseMatch) return []
    const ticks = BigInt(timestampMatch[0])
    const numerator = BigInt(timeBaseMatch[1]!)
    const denominator = BigInt(timeBaseMatch[2]!)
    if (ticks <= 0n || numerator <= 0n || denominator <= 0n) return []
    const duration = Number(ticks * numerator) / Number(denominator)
    return Number.isFinite(duration) && duration > 0 && duration <= 3_600
      ? [duration]
      : []
  })
  const duration = exactStreamDurations.length > 0
    ? Math.max(...exactStreamDurations)
    : record
    && record.format && typeof record.format === 'object' && !Array.isArray(record.format)
    && 'duration' in record.format
    ? Number(record.format.duration)
    : Number.NaN
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3_600) {
    throw new AudioDurationProbeError('INVALID_AUDIO', 'ffprobe 未返回有效音频时长')
  }
  return duration
}

/** Measure provider audio before it is published as an immutable MediaStore asset. */
export function createAudioDurationProbe(options: AudioDurationProbeOptions = {}): AudioDurationProbe {
  const ffprobePath = options.ffprobePath === undefined
    ? resolveBundledFfprobePath()
    : options.ffprobePath
  const runner = options.runner ?? new SpawnProcessRunner()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be positive')

  return async (bytes, mimeType, signal) => {
    if (!ffprobePath) {
      throw new AudioDurationProbeError('BINARY_UNAVAILABLE', '当前平台没有可用的 ffprobe 固定二进制')
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new AudioDurationProbeError('INVALID_AUDIO', '待测音频为空')
    }
    const extension = extensionForMime(mimeType)
    const directory = await mkdtemp(join(tmpdir(), 'manju-audio-probe-'))
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
          '-select_streams', 'a',
          '-show_entries', 'format=duration:stream=codec_type,duration_ts,time_base',
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
        throw new AudioDurationProbeError('PROBE_FAILED', `ffprobe 音频时长检测失败（退出码 ${result.exitCode}）`)
      }
      return durationFromProbe(result.stdout)
    } catch (error) {
      if (error instanceof AudioDurationProbeError) throw error
      throw new AudioDurationProbeError('PROBE_FAILED', '无法检测音频时长', { cause: error })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

export const probeAudioDuration = createAudioDurationProbe()
