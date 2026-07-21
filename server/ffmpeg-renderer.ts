import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
} from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import {
  resolveRuntimeFfmpegDiagnosticReceipt,
  resolveRuntimeFfmpegPath,
  resolveRuntimeFfprobePath,
  type FfmpegRuntimeAuditSummary,
  type FfmpegRuntimeSource,
} from './ffmpeg-runtime.js'

export function resolveBundledFfmpegPath(): string | null {
  return resolveRuntimeFfmpegPath()
}

export function resolveBundledFfprobePath(): string | null {
  return resolveRuntimeFfprobePath()
}

export const RENDER_FRAME_RATE = 24 as const
export const RENDER_AUDIO_SAMPLE_RATE = 48_000 as const

const DEFAULT_RENDER_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_PROBE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_STDERR_BYTES = 512 * 1_024
const DEFAULT_MAX_STDOUT_BYTES = 2 * 1_024 * 1_024
const MAX_VISUAL_CLIPS = 1_000
const MAX_AUDIO_CLIPS = 256
const MAX_RENDER_FRAMES = RENDER_FRAME_RATE * 60 * 60 * 6
const DIALOGUE_DUCKING_GAIN = 0.35
const DIALOGUE_DUCKING_SMOOTH_SECONDS = 0.12

export type RenderResolution = '1080p' | '720p'
export type RenderAspectRatio = '16:9' | '9:16' | '1:1'
export type ImageFit = 'cover' | 'contain'
export type SubtitleFormat = 'srt' | 'ass'

export interface VisualOpacityFadeSegment {
  readonly startFrame: number
  readonly durationFrames: number
}

/** Renderer-facing copy of the pinned RenderSemanticPlan opacity slice. */
export interface VisualOpacityFade {
  readonly version: 1
  readonly fadeIn: VisualOpacityFadeSegment | null
  readonly fadeOut: VisualOpacityFadeSegment | null
}

interface VisualShapeMaskBase {
  readonly type: 'rectangle' | 'ellipse'
  readonly centerX: number
  readonly centerY: number
  readonly width: number
  readonly height: number
}

/** Renderer-facing copy of the legacy RSP v3/v4 hard-mask slice. */
export interface VisualShapeMaskV1 extends VisualShapeMaskBase {
  readonly version: 1
}

/** Renderer-facing copy of the RSP v5 hard-mask polarity slice. */
export interface VisualShapeMaskV2 extends VisualShapeMaskBase {
  readonly version: 2
  readonly inverted: boolean
}

export type VisualShapeMask = VisualShapeMaskV1 | VisualShapeMaskV2

/** Renderer-facing copy of the pinned RenderSemanticPlan uniform-scale slice. */
export interface VisualUniformScaleMotion {
  readonly version: 1
  readonly startFrame: 0
  readonly durationFrames: number
  readonly fromScale: number
  readonly toScale: number
  readonly anchorX: 0.5
  readonly anchorY: 0.5
}

export interface StaticImageRenderClip {
  readonly mediaType?: 'image'
  readonly id: string
  /** Absolute frame on the 24 fps output timeline. Clips must be contiguous. */
  readonly startFrame: number
  readonly durationFrames: number
  /** Trusted, server-resolved absolute path to an existing regular file. */
  readonly assetPath: string
  readonly fit?: ImageFit
  readonly kenBurns?: boolean
  readonly uniformScaleMotion?: VisualUniformScaleMotion
  readonly opacityFade?: VisualOpacityFade
  readonly shapeMask?: VisualShapeMask
}

export interface VideoRenderClip {
  readonly mediaType: 'video'
  readonly id: string
  /** Absolute frame on the 24 fps output timeline. Clips must be contiguous. */
  readonly startFrame: number
  readonly durationFrames: number
  /** Trusted, server-resolved absolute path to an existing regular file. */
  readonly assetPath: string
  /** Immutable source trim pinned by the export snapshot. */
  readonly sourceStartSeconds: number
  /** Immutable source duration from the persisted asset record. */
  readonly sourceDurationSeconds: number
  readonly fit?: ImageFit
  readonly kenBurns?: never
  readonly uniformScaleMotion?: never
  readonly opacityFade?: VisualOpacityFade
  readonly shapeMask?: VisualShapeMask
}

export type VisualRenderClip = StaticImageRenderClip | VideoRenderClip

export interface AudioRenderClip {
  readonly id: string
  /** Absolute frame on the 24 fps output timeline. */
  readonly startFrame: number
  /** Trusted, server-resolved absolute path to an existing regular file. */
  readonly assetPath: string
  readonly sourceStartSeconds?: number
  readonly durationFrames?: number
  readonly volume?: number
  /** Optional for legacy snapshots; only explicitly pinned roles drive ducking. */
  readonly audioRole?: 'dialogue' | 'bgm' | 'sfx'
  /** Fade from silence, relative to the start of the trimmed clip. */
  readonly fadeInSeconds?: number
  /** Fade to silence, relative to the end of the trimmed clip. */
  readonly fadeOutSeconds?: number
  /**
   * Absolute, renderer-neutral ducking windows compiled by the shared
   * RenderSemanticPlan. Undefined preserves legacy role-derived behavior;
   * an explicit empty array means no ducking for this clip.
   */
  readonly duckingWindows?: readonly AudioDuckingWindow[]
}

export interface AudioDuckingWindow {
  readonly startFrame: number
  readonly endFrameExclusive: number
  readonly duckedLinearGain: number
  readonly attackSeconds: number
  readonly releaseSeconds: number
}

export interface BurnedSubtitleTrack {
  /** Trusted, server-resolved absolute path to an existing regular file. */
  readonly assetPath: string
  readonly format: SubtitleFormat
  readonly burnIn: boolean
}

/**
 * A normalized, immutable rendering contract. Raw OpenCut/client JSON must be
 * parsed and asset IDs must be resolved by the caller before reaching here.
 */
export interface ImmutableRenderTimelineSnapshot {
  readonly revisionId: string
  readonly frameRate: typeof RENDER_FRAME_RATE
  readonly visualClips: readonly VisualRenderClip[]
  readonly audioClips?: readonly AudioRenderClip[]
  readonly subtitles?: BurnedSubtitleTrack
}

export interface FfmpegRenderRequest {
  readonly timeline: ImmutableRenderTimelineSnapshot
  readonly resolution: RenderResolution
  /** Server-pinned episode aspect ratio; never inferred from client media. */
  readonly aspectRatio: RenderAspectRatio
  /** New, absolute `.mp4` path. Existing destinations are never overwritten. */
  readonly outputPath: string
  readonly signal?: AbortSignal
}

export interface ProcessRunRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly signal?: AbortSignal
  readonly timeoutMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
}

export interface ProcessRunResult {
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export interface RenderProcessRunner {
  run(request: ProcessRunRequest): Promise<ProcessRunResult>
}

export type FfmpegRenderErrorCode =
  | 'BINARY_UNAVAILABLE'
  | 'CANCELLED'
  | 'FFMPEG_FAILED'
  | 'FFPROBE_FAILED'
  | 'INVALID_RENDER_OUTPUT'
  | 'INVALID_TIMELINE'
  | 'INVALID_VIDEO_INPUT'
  | 'OUTPUT_EXISTS'
  | 'PROCESS_OUTPUT_LIMIT'
  | 'PROCESS_SPAWN_FAILED'
  | 'PUBLISH_FAILED'
  | 'TIMEOUT'
  | 'UNSAFE_INPUT_PATH'
  | 'UNSAFE_OUTPUT_PATH'

export class FfmpegRenderError extends Error {
  constructor(
    readonly code: FfmpegRenderErrorCode,
    message: string,
    readonly stderr?: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'FfmpegRenderError'
  }
}

export interface VerifiedRenderProbe {
  readonly formatName: string
  readonly durationSeconds: number
  readonly video: {
    readonly codec: 'h264'
    readonly width: number
    readonly height: number
    readonly pixelFormat: 'yuv420p'
    readonly frameRate: 24
    readonly frames?: number
  }
  readonly audio: {
    readonly codec: 'aac'
    readonly sampleRate: 48_000
    readonly channels: 2
  }
}

export interface FfmpegRenderResult {
  readonly outputPath: string
  readonly timelineRevisionId: string
  readonly durationSeconds: number
  readonly frameCount: number
  readonly width: number
  readonly height: number
  readonly probe: VerifiedRenderProbe
}

export interface FfmpegRendererOptions {
  readonly ffmpegPath?: string | null
  readonly ffprobePath?: string | null
  readonly runner?: RenderProcessRunner
  readonly renderTimeoutMs?: number
  readonly probeTimeoutMs?: number
  readonly maxStderrBytes?: number
}

export interface FfmpegRendererRuntimeReceipt {
  readonly schemaVersion: 1
  readonly source: FfmpegRuntimeSource | 'injected'
  readonly releaseEligible: boolean
  readonly audit: FfmpegRuntimeAuditSummary | null
}

interface NormalizedAudioRenderClip extends AudioRenderClip {
  readonly sourceStartSeconds: number
  readonly volume: number
  readonly effectiveDurationFrames: number
  readonly effectiveDurationSeconds: number
}

interface AudioFrameInterval {
  startFrame: number
  endFrame: number
}

interface NormalizedTimeline {
  revisionId: string
  visualClips: Array<
    | (StaticImageRenderClip & { mediaType: 'image' })
    | VideoRenderClip
  >
  audioClips: NormalizedAudioRenderClip[]
  subtitles?: BurnedSubtitleTrack
  totalFrames: number
}

interface RawProbeStream {
  codec_type?: unknown
  codec_name?: unknown
  width?: unknown
  height?: unknown
  pix_fmt?: unknown
  r_frame_rate?: unknown
  avg_frame_rate?: unknown
  sample_rate?: unknown
  channels?: unknown
  nb_frames?: unknown
}

interface RawProbeDocument {
  streams?: unknown
  format?: unknown
}

function renderError(
  code: FfmpegRenderErrorCode,
  message: string,
  options?: { stderr?: string; cause?: unknown },
): FfmpegRenderError {
  return new FfmpegRenderError(code, message, options?.stderr, { cause: options?.cause })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw renderError('CANCELLED', '导出任务已取消')
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw renderError('INVALID_TIMELINE', `${label} 必须是正整数`)
  }
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw renderError('INVALID_TIMELINE', `${label} 必须是非负整数`)
  }
  return value
}

function nonEmptyId(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 200) {
    throw renderError('INVALID_TIMELINE', `${label} 无效`)
  }
  return normalized
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function normalizeVisualOpacityFade(
  value: VisualOpacityFade | undefined,
  durationFrames: number,
  label: string,
): VisualOpacityFade | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['version', 'fadeIn', 'fadeOut'])
    || value.version !== 1) {
    throw renderError('INVALID_TIMELINE', `${label}.opacityFade 无效`)
  }
  const segment = (
    raw: VisualOpacityFadeSegment | null,
    key: 'fadeIn' | 'fadeOut',
  ): VisualOpacityFadeSegment | null => {
    if (raw === null) return null
    if (!isPlainObject(raw) || !hasExactKeys(raw, ['startFrame', 'durationFrames'])) {
      throw renderError('INVALID_TIMELINE', `${label}.opacityFade.${key} 无效`)
    }
    const startFrame = nonNegativeInteger(raw.startFrame, `${label}.opacityFade.${key}.startFrame`)
    const transitionFrames = positiveInteger(
      raw.durationFrames,
      `${label}.opacityFade.${key}.durationFrames`,
    )
    if (startFrame + transitionFrames > durationFrames) {
      throw renderError('INVALID_TIMELINE', `${label}.opacityFade.${key} 超出片段时长`)
    }
    return { startFrame, durationFrames: transitionFrames }
  }
  const fadeIn = segment(value.fadeIn, 'fadeIn')
  const fadeOut = segment(value.fadeOut, 'fadeOut')
  if (!fadeIn && !fadeOut) {
    throw renderError('INVALID_TIMELINE', `${label}.opacityFade 至少需要一个淡入或淡出`)
  }
  if (fadeIn && fadeOut && fadeIn.startFrame + fadeIn.durationFrames > fadeOut.startFrame) {
    throw renderError('INVALID_TIMELINE', `${label}.opacityFade 淡入与淡出不能重叠`)
  }
  return { version: 1, fadeIn, fadeOut }
}

function normalizeVisualShapeMask(
  value: VisualShapeMask | undefined,
  label: string,
): VisualShapeMask | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    throw renderError('INVALID_TIMELINE', `${label}.shapeMask 无效`)
  }
  const version = value.version
  const keys = version === 1
    ? ['version', 'type', 'centerX', 'centerY', 'width', 'height']
    : version === 2
      ? ['version', 'type', 'inverted', 'centerX', 'centerY', 'width', 'height']
      : null
  if (!keys
    || !hasExactKeys(value, keys)
    || (value.type !== 'rectangle' && value.type !== 'ellipse')
    || (version === 2 && typeof value.inverted !== 'boolean')) {
    throw renderError('INVALID_TIMELINE', `${label}.shapeMask 无效`)
  }
  const scalar = (
    raw: unknown,
    key: 'centerX' | 'centerY' | 'width' | 'height',
    minimum: number,
    maximum: number,
  ): number => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)
      || raw < minimum || raw > maximum) {
      throw renderError('INVALID_TIMELINE', `${label}.shapeMask.${key} 无效`)
    }
    const rounded = Number(raw.toFixed(6))
    return Object.is(rounded, -0) ? 0 : rounded
  }
  const geometry = {
    type: value.type,
    centerX: scalar(value.centerX, 'centerX', -1, 1),
    centerY: scalar(value.centerY, 'centerY', -1, 1),
    width: scalar(value.width, 'width', 0.01, 2),
    height: scalar(value.height, 'height', 0.01, 2),
  }
  if (version === 1) return { version: 1, ...geometry }
  return { version: 2, inverted: value.inverted as boolean, ...geometry }
}

function normalizeVisualUniformScaleMotion(
  value: VisualUniformScaleMotion | undefined,
  durationFrames: number,
  label: string,
): VisualUniformScaleMotion | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)
    || !hasExactKeys(value, [
      'version',
      'startFrame',
      'durationFrames',
      'fromScale',
      'toScale',
      'anchorX',
      'anchorY',
    ])
    || value.version !== 1) {
    throw renderError('INVALID_TIMELINE', `${label}.uniformScaleMotion 无效`)
  }
  const startFrame = nonNegativeInteger(
    value.startFrame,
    `${label}.uniformScaleMotion.startFrame`,
  )
  if (startFrame !== 0) {
    throw renderError('INVALID_TIMELINE', `${label}.uniformScaleMotion.startFrame 必须为 0`)
  }
  const motionDurationFrames = positiveInteger(
    value.durationFrames,
    `${label}.uniformScaleMotion.durationFrames`,
  )
  if (motionDurationFrames !== durationFrames) {
    throw renderError(
      'INVALID_TIMELINE',
      `${label}.uniformScaleMotion.durationFrames 必须覆盖整个片段`,
    )
  }
  const scale = (raw: unknown, key: 'fromScale' | 'toScale'): number => {
    if (typeof raw !== 'number'
      || !Number.isFinite(raw)
      || raw < 1
      || raw > 1.2) {
      throw renderError('INVALID_TIMELINE', `${label}.uniformScaleMotion.${key} 无效`)
    }
    const rounded = Number(raw.toFixed(6))
    return Object.is(rounded, -0) ? 0 : rounded
  }
  const fromScale = scale(value.fromScale, 'fromScale')
  const toScale = scale(value.toScale, 'toScale')
  if (fromScale === toScale) {
    throw renderError('INVALID_TIMELINE', `${label}.uniformScaleMotion 缩放值必须发生变化`)
  }
  if (value.anchorX !== 0.5 || value.anchorY !== 0.5) {
    throw renderError('INVALID_TIMELINE', `${label}.uniformScaleMotion 只支持中心锚点`)
  }
  return {
    version: 1,
    startFrame: 0,
    durationFrames: motionDurationFrames,
    fromScale,
    toScale,
    anchorX: 0.5,
    anchorY: 0.5,
  }
}

function normalizeTimeline(timeline: ImmutableRenderTimelineSnapshot): NormalizedTimeline {
  if (timeline.frameRate !== RENDER_FRAME_RATE) {
    throw renderError('INVALID_TIMELINE', `正式导出只接受 ${RENDER_FRAME_RATE} fps 时间线`)
  }
  const revisionId = nonEmptyId(timeline.revisionId, 'timeline revisionId')
  if (!Array.isArray(timeline.visualClips) || timeline.visualClips.length === 0) {
    throw renderError('INVALID_TIMELINE', '时间线至少需要一个视觉片段')
  }
  if (timeline.visualClips.length > MAX_VISUAL_CLIPS) {
    throw renderError('INVALID_TIMELINE', `视觉片段不能超过 ${MAX_VISUAL_CLIPS} 个`)
  }

  let nextFrame = 0
  const ids = new Set<string>()
  const visualClips = timeline.visualClips.map((clip, index) => {
    const id = nonEmptyId(clip.id, `visualClips[${index}].id`)
    if (ids.has(id)) throw renderError('INVALID_TIMELINE', `片段 ID 重复: ${id}`)
    ids.add(id)
    const startFrame = nonNegativeInteger(clip.startFrame, `visualClips[${index}].startFrame`)
    const durationFrames = positiveInteger(clip.durationFrames, `visualClips[${index}].durationFrames`)
    if (startFrame !== nextFrame) {
      throw renderError(
        'INVALID_TIMELINE',
        `visualClips[${index}] 必须从第 ${nextFrame} 帧开始；MVP 仅支持无缝硬切`,
      )
    }
    nextFrame += durationFrames
    if (nextFrame > MAX_RENDER_FRAMES) {
      throw renderError('INVALID_TIMELINE', '单次导出时长不能超过 6 小时')
    }
    if (clip.fit !== undefined && clip.fit !== 'cover' && clip.fit !== 'contain') {
      throw renderError('INVALID_TIMELINE', `visualClips[${index}].fit 无效`)
    }
    if (clip.mediaType !== undefined
      && clip.mediaType !== 'image'
      && clip.mediaType !== 'video') {
      throw renderError('INVALID_TIMELINE', `visualClips[${index}].mediaType 无效`)
    }
    if (clip.mediaType === 'video') {
      if ((clip as VideoRenderClip & { uniformScaleMotion?: unknown }).uniformScaleMotion !== undefined) {
        throw renderError(
          'INVALID_TIMELINE',
          `visualClips[${index}].uniformScaleMotion 不适用于视频`,
        )
      }
      const sourceStartSeconds = clip.sourceStartSeconds
      const sourceDurationSeconds = clip.sourceDurationSeconds
      if (!Number.isFinite(sourceStartSeconds)
        || sourceStartSeconds < 0
        || sourceStartSeconds > 86_400) {
        throw renderError('INVALID_TIMELINE', `visualClips[${index}].sourceStartSeconds 无效`)
      }
      if (!Number.isFinite(sourceDurationSeconds)
        || sourceDurationSeconds <= 0
        || sourceDurationSeconds > 86_400) {
        throw renderError('INVALID_TIMELINE', `visualClips[${index}].sourceDurationSeconds 无效`)
      }
      const selectedDurationSeconds = durationFrames / RENDER_FRAME_RATE
      if (sourceStartSeconds + selectedDurationSeconds > sourceDurationSeconds + 0.1) {
        throw renderError('INVALID_TIMELINE', `visualClips[${index}] 的源视频裁剪超出固化时长`)
      }
      const opacityFade = normalizeVisualOpacityFade(
        clip.opacityFade,
        durationFrames,
        `visualClips[${index}]`,
      )
      const shapeMask = normalizeVisualShapeMask(
        clip.shapeMask,
        `visualClips[${index}]`,
      )
      return {
        mediaType: 'video' as const,
        id,
        startFrame,
        durationFrames,
        assetPath: clip.assetPath,
        sourceStartSeconds,
        sourceDurationSeconds,
        fit: clip.fit ?? 'cover',
        ...(opacityFade ? { opacityFade } : {}),
        ...(shapeMask ? { shapeMask } : {}),
      }
    }
    const opacityFade = normalizeVisualOpacityFade(
      clip.opacityFade,
      durationFrames,
      `visualClips[${index}]`,
    )
    const shapeMask = normalizeVisualShapeMask(
      clip.shapeMask,
      `visualClips[${index}]`,
    )
    const uniformScaleMotion = normalizeVisualUniformScaleMotion(
      clip.uniformScaleMotion,
      durationFrames,
      `visualClips[${index}]`,
    )
    if (uniformScaleMotion && clip.kenBurns === true) {
      throw renderError(
        'INVALID_TIMELINE',
        `visualClips[${index}] 不能同时使用 uniformScaleMotion 和 legacy Ken Burns`,
      )
    }
    return {
      mediaType: 'image' as const,
      id,
      startFrame,
      durationFrames,
      assetPath: clip.assetPath,
      fit: clip.fit ?? 'cover',
      kenBurns: clip.kenBurns === true,
      ...(uniformScaleMotion ? { uniformScaleMotion } : {}),
      ...(opacityFade ? { opacityFade } : {}),
      ...(shapeMask ? { shapeMask } : {}),
    }
  })

  const sourceAudioClips = timeline.audioClips ?? []
  if (!Array.isArray(sourceAudioClips) || sourceAudioClips.length > MAX_AUDIO_CLIPS) {
    throw renderError('INVALID_TIMELINE', `音频片段不能超过 ${MAX_AUDIO_CLIPS} 个`)
  }
  const audioClips = sourceAudioClips.map((clip, index) => {
    const id = nonEmptyId(clip.id, `audioClips[${index}].id`)
    if (ids.has(id)) throw renderError('INVALID_TIMELINE', `片段 ID 重复: ${id}`)
    ids.add(id)
    const startFrame = nonNegativeInteger(clip.startFrame, `audioClips[${index}].startFrame`)
    if (startFrame >= nextFrame) {
      throw renderError('INVALID_TIMELINE', `audioClips[${index}] 超出视频时长`)
    }
    const sourceStartSeconds = clip.sourceStartSeconds ?? 0
    if (!Number.isFinite(sourceStartSeconds) || sourceStartSeconds < 0 || sourceStartSeconds > 86_400) {
      throw renderError('INVALID_TIMELINE', `audioClips[${index}].sourceStartSeconds 无效`)
    }
    const durationFrames = clip.durationFrames === undefined
      ? undefined
      : positiveInteger(clip.durationFrames, `audioClips[${index}].durationFrames`)
    if (durationFrames !== undefined && startFrame + durationFrames > nextFrame) {
      throw renderError('INVALID_TIMELINE', `audioClips[${index}] 超出视频时长`)
    }
    const volume = clip.volume ?? 1
    if (!Number.isFinite(volume) || volume < 0 || volume > 4) {
      throw renderError('INVALID_TIMELINE', `audioClips[${index}].volume 必须介于 0 和 4 之间`)
    }
    const audioRole = clip.audioRole
    if (audioRole !== undefined
      && audioRole !== 'dialogue'
      && audioRole !== 'bgm'
      && audioRole !== 'sfx') {
      throw renderError(
        'INVALID_TIMELINE',
        `audioClips[${index}].audioRole 只支持 dialogue、bgm 或 sfx`,
      )
    }
    const effectiveDurationFrames = durationFrames ?? (nextFrame - startFrame)
    const effectiveDurationSeconds = effectiveDurationFrames / RENDER_FRAME_RATE
    const fade = (
      value: number | undefined,
      key: 'fadeInSeconds' | 'fadeOutSeconds',
    ): number | undefined => {
      if (value === undefined) return undefined
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw renderError('INVALID_TIMELINE', `audioClips[${index}].${key} 必须是有限非负数`)
      }
      if (value > effectiveDurationSeconds) {
        throw renderError('INVALID_TIMELINE', `audioClips[${index}].${key} 不能超过片段时长`)
      }
      return value
    }
    const fadeInSeconds = fade(clip.fadeInSeconds, 'fadeInSeconds')
    const fadeOutSeconds = fade(clip.fadeOutSeconds, 'fadeOutSeconds')
    if ((fadeInSeconds ?? 0) + (fadeOutSeconds ?? 0) > effectiveDurationSeconds) {
      throw renderError(
        'INVALID_TIMELINE',
        `audioClips[${index}] 淡入与淡出时长之和不能超过片段时长`,
      )
    }
    let duckingWindows: AudioDuckingWindow[] | undefined
    if (clip.duckingWindows !== undefined) {
      if (!Array.isArray(clip.duckingWindows) || clip.duckingWindows.length > MAX_AUDIO_CLIPS) {
        throw renderError('INVALID_TIMELINE', `audioClips[${index}].duckingWindows 无效`)
      }
      let previousEnd = -1
      const normalizedDuckingWindows = clip.duckingWindows.map((
        window: AudioDuckingWindow,
        windowIndex: number,
      ) => {
        const path = `audioClips[${index}].duckingWindows[${windowIndex}]`
        const startFrame = nonNegativeInteger(window.startFrame, `${path}.startFrame`)
        const endFrameExclusive = positiveInteger(
          window.endFrameExclusive,
          `${path}.endFrameExclusive`,
        )
        if (endFrameExclusive <= startFrame || startFrame < previousEnd) {
          throw renderError('INVALID_TIMELINE', `${path} 必须按时间排序且不能重叠`)
        }
        previousEnd = endFrameExclusive
        const duckedLinearGain = window.duckedLinearGain
        const attackSeconds = window.attackSeconds
        const releaseSeconds = window.releaseSeconds
        if (!Number.isFinite(duckedLinearGain)
          || duckedLinearGain < 0
          || duckedLinearGain > 1
          || !Number.isFinite(attackSeconds)
          || attackSeconds <= 0
          || attackSeconds > 10
          || !Number.isFinite(releaseSeconds)
          || releaseSeconds <= 0
          || releaseSeconds > 10) {
          throw renderError('INVALID_TIMELINE', `${path} 的增益或平滑时长无效`)
        }
        return {
          startFrame,
          endFrameExclusive,
          duckedLinearGain,
          attackSeconds,
          releaseSeconds,
        }
      })
      if (normalizedDuckingWindows.length > 0 && audioRole !== 'bgm') {
        throw renderError('INVALID_TIMELINE', `audioClips[${index}] 只有 bgm 可包含 duckingWindows`)
      }
      duckingWindows = normalizedDuckingWindows
    }
    return {
      id,
      startFrame,
      durationFrames,
      assetPath: clip.assetPath,
      sourceStartSeconds,
      volume,
      effectiveDurationFrames,
      effectiveDurationSeconds,
      ...(audioRole === undefined ? {} : { audioRole }),
      ...(fadeInSeconds === undefined ? {} : { fadeInSeconds }),
      ...(fadeOutSeconds === undefined ? {} : { fadeOutSeconds }),
      ...(duckingWindows === undefined ? {} : { duckingWindows }),
    }
  })

  let subtitles: BurnedSubtitleTrack | undefined
  if (timeline.subtitles?.burnIn) {
    if (timeline.subtitles.format !== 'srt' && timeline.subtitles.format !== 'ass') {
      throw renderError('INVALID_TIMELINE', '字幕格式必须是 srt 或 ass')
    }
    subtitles = {
      assetPath: timeline.subtitles.assetPath,
      format: timeline.subtitles.format,
      burnIn: true,
    }
  }

  return { revisionId, visualClips, audioClips, subtitles, totalFrames: nextFrame }
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number },
  limit: number,
): boolean {
  const remaining = Math.max(0, limit - state.bytes)
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
  state.bytes += chunk.length
  return state.bytes <= limit
}

/** Native spawn runner: argument arrays only, never a shell. */
export class SpawnProcessRunner implements RenderProcessRunner {
  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    throwIfAborted(request.signal)
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1) {
      throw new RangeError('timeoutMs must be a positive integer')
    }
    if (!Number.isSafeInteger(request.maxStdoutBytes) || request.maxStdoutBytes < 1) {
      throw new RangeError('maxStdoutBytes must be a positive integer')
    }
    if (!Number.isSafeInteger(request.maxStderrBytes) || request.maxStderrBytes < 1) {
      throw new RangeError('maxStderrBytes must be a positive integer')
    }

    return await new Promise<ProcessRunResult>((resolvePromise, rejectPromise) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        rejectPromise(renderError('PROCESS_SPAWN_FAILED', '无法启动媒体处理进程', { cause: error }))
        return
      }

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      const stdoutState = { bytes: 0 }
      const stderrState = { bytes: 0 }
      let settled = false
      let pendingFailure: FfmpegRenderError | undefined
      let forceKillTimer: NodeJS.Timeout | undefined

      const terminate = (failure: FfmpegRenderError) => {
        if (pendingFailure) return
        pendingFailure = failure
        child.kill('SIGTERM')
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
        forceKillTimer.unref()
      }
      const timeout = setTimeout(() => {
        terminate(renderError('TIMEOUT', `媒体处理超过 ${request.timeoutMs}ms 时限`))
      }, request.timeoutMs)
      timeout.unref()
      const onAbort = () => terminate(renderError('CANCELLED', '导出任务已取消'))
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const cleanup = () => {
        clearTimeout(timeout)
        if (forceKillTimer) clearTimeout(forceKillTimer)
        request.signal?.removeEventListener('abort', onAbort)
      }

      child.stdout!.on('data', (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        if (!appendBounded(stdoutChunks, chunk, stdoutState, request.maxStdoutBytes)) {
          terminate(renderError('PROCESS_OUTPUT_LIMIT', '媒体处理标准输出超过安全上限'))
        }
      })
      child.stderr!.on('data', (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        if (!appendBounded(stderrChunks, chunk, stderrState, request.maxStderrBytes)) {
          terminate(renderError('PROCESS_OUTPUT_LIMIT', '媒体处理错误输出超过安全上限'))
        }
      })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        cleanup()
        rejectPromise(renderError('PROCESS_SPAWN_FAILED', '媒体处理进程启动失败', { cause: error }))
      })
      child.once('close', (code) => {
        if (settled) return
        settled = true
        cleanup()
        if (pendingFailure) {
          rejectPromise(pendingFailure)
          return
        }
        resolvePromise({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
        })
      })
    })
  }
}

async function assertAbsoluteRegularFile(path: string, label: string): Promise<void> {
  if (!path || path.includes('\0') || !isAbsolute(path) || resolve(path) !== path) {
    throw renderError('UNSAFE_INPUT_PATH', `${label} 必须是已解析的绝对路径`)
  }
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    throw renderError('UNSAFE_INPUT_PATH', `${label} 不存在`, { cause: error })
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw renderError('UNSAFE_INPUT_PATH', `${label} 必须是普通文件，不能是符号链接`)
  }
  const resolvedPath = await realpath(path)
  if (resolvedPath !== path) {
    throw renderError('UNSAFE_INPUT_PATH', `${label} 的上级路径不能包含符号链接`)
  }
}

async function assertOutputPathAvailable(outputPath: string): Promise<void> {
  if (
    !outputPath
    || outputPath.includes('\0')
    || !isAbsolute(outputPath)
    || resolve(outputPath) !== outputPath
    || extname(outputPath).toLowerCase() !== '.mp4'
  ) {
    throw renderError('UNSAFE_OUTPUT_PATH', '输出必须是已解析的绝对 .mp4 路径')
  }
  try {
    await lstat(outputPath)
    throw renderError('OUTPUT_EXISTS', '输出文件已存在，导出不允许覆盖')
  } catch (error) {
    if (error instanceof FfmpegRenderError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw renderError('UNSAFE_OUTPUT_PATH', '无法检查输出路径', { cause: error })
    }
  }

  const parent = dirname(outputPath)
  let parentInfo: Awaited<ReturnType<typeof lstat>>
  try {
    parentInfo = await lstat(parent)
  } catch (error) {
    throw renderError('UNSAFE_OUTPUT_PATH', '输出目录不存在', { cause: error })
  }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw renderError('UNSAFE_OUTPUT_PATH', '输出目录必须是普通目录，不能是符号链接')
  }
  if (await realpath(parent) !== parent) {
    throw renderError('UNSAFE_OUTPUT_PATH', '输出目录的上级路径不能包含符号链接')
  }
}

function fixedSeconds(frames: number): string {
  return (frames / RENDER_FRAME_RATE).toFixed(9).replace(/0+$/, '').replace(/\.$/, '')
}

function fixedDecimalSeconds(seconds: number): string {
  return seconds.toFixed(9).replace(/0+$/, '').replace(/\.$/, '')
}

function mergedDialogueIntervals(
  clips: readonly NormalizedAudioRenderClip[],
): AudioFrameInterval[] {
  const intervals = clips
    .filter((clip) => clip.audioRole === 'dialogue')
    .map((clip) => ({
      startFrame: clip.startFrame,
      endFrame: clip.startFrame + clip.effectiveDurationFrames,
    }))
    .sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame)
  const merged: AudioFrameInterval[] = []
  const smoothingOverlapFrames = DIALOGUE_DUCKING_SMOOTH_SECONDS * 2 * RENDER_FRAME_RATE
  for (const interval of intervals) {
    const previous = merged.at(-1)
    // When the 120 ms release and next 120 ms attack overlap, holding the BGM
    // down is deterministic and avoids a brief pump between adjacent lines.
    if (previous && interval.startFrame - previous.endFrame <= smoothingOverlapFrames) {
      previous.endFrame = Math.max(previous.endFrame, interval.endFrame)
    } else {
      merged.push({ ...interval })
    }
  }
  return merged
}

function dialogueDuckingFilters(
  clip: NormalizedAudioRenderClip,
  dialogueIntervals: readonly AudioFrameInterval[],
): string[] {
  if (clip.audioRole !== 'bgm' || dialogueIntervals.length === 0) return []
  const clipEndFrame = clip.startFrame + clip.effectiveDurationFrames
  const smoothingFrames = DIALOGUE_DUCKING_SMOOTH_SECONDS * RENDER_FRAME_RATE
  return dialogueIntervals
    .filter((interval) => (
      interval.endFrame + smoothingFrames > clip.startFrame
      && interval.startFrame - smoothingFrames < clipEndFrame
    ))
    .map((interval) => duckingEnvelopeFilter(clip, {
      startFrame: interval.startFrame,
      endFrameExclusive: interval.endFrame,
      duckedLinearGain: DIALOGUE_DUCKING_GAIN,
      attackSeconds: DIALOGUE_DUCKING_SMOOTH_SECONDS,
      releaseSeconds: DIALOGUE_DUCKING_SMOOTH_SECONDS,
    }))
}

function duckingEnvelopeFilter(
  clip: NormalizedAudioRenderClip,
  window: AudioDuckingWindow,
): string {
  const dialogueStart = (window.startFrame - clip.startFrame) / RENDER_FRAME_RATE
  const dialogueEnd = (window.endFrameExclusive - clip.startFrame) / RENDER_FRAME_RATE
  const attackStart = dialogueStart - window.attackSeconds
  const releaseEnd = dialogueEnd + window.releaseSeconds
  const gain = fixedDecimalSeconds(window.duckedLinearGain)
  const depth = fixedDecimalSeconds(1 - window.duckedLinearGain)
  const attack = fixedDecimalSeconds(window.attackSeconds)
  const release = fixedDecimalSeconds(window.releaseSeconds)
  const attackStartText = fixedDecimalSeconds(attackStart)
  const dialogueStartText = fixedDecimalSeconds(dialogueStart)
  const dialogueEndText = fixedDecimalSeconds(dialogueEnd)
  const releaseEndText = fixedDecimalSeconds(releaseEnd)
  const envelope = [
    `if(lt(t,${attackStartText}),1`,
    `if(lt(t,${dialogueStartText}),1-${depth}*(t-(${attackStartText}))/${attack}`,
    `if(lt(t,${dialogueEndText}),${gain}`,
    `if(lt(t,${releaseEndText}),${gain}+${depth}*(t-(${dialogueEndText}))/${release},1))))`,
  ].join(',')
  return `volume='${envelope}':eval=frame`
}

export function resolutionDimensions(
  resolution: RenderResolution,
  aspectRatio: RenderAspectRatio,
): { width: number; height: number } {
  const longEdge = resolution === '1080p' ? 1920 : 1280
  const shortEdge = resolution === '1080p' ? 1080 : 720
  if (aspectRatio === '16:9') return { width: longEdge, height: shortEdge }
  if (aspectRatio === '9:16') return { width: shortEdge, height: longEdge }
  if (aspectRatio === '1:1') return { width: shortEdge, height: shortEdge }
  throw renderError('INVALID_TIMELINE', '导出画幅只支持 16:9、9:16 或 1:1')
}

function visualOpacityFilters(fade: VisualOpacityFade | undefined): string {
  if (!fade) return ''
  const filters: string[] = []
  if (fade.fadeIn) {
    filters.push(
      `fade=t=in:st=${fixedSeconds(fade.fadeIn.startFrame)}:d=${fixedSeconds(fade.fadeIn.durationFrames)}`,
    )
  }
  if (fade.fadeOut) {
    filters.push(
      `fade=t=out:st=${fixedSeconds(fade.fadeOut.startFrame)}:d=${fixedSeconds(fade.fadeOut.durationFrames)}`,
    )
  }
  return filters.length === 0 ? '' : `,${filters.join(',')}`
}

function visualShapeMaskFilters(
  mask: VisualShapeMask | undefined,
  width: number,
  height: number,
): string {
  if (!mask) return ''
  const number = (value: number): string => Number(value.toFixed(6)).toString()
  const centerX = width / 2 + mask.centerX * width
  const centerY = height / 2 + mask.centerY * height
  const halfWidth = mask.width * width / 2
  const halfHeight = mask.height * height / 2
  const condition = mask.type === 'ellipse'
    ? `lte(pow((X-${number(centerX)})/${number(halfWidth)},2)+pow((Y-${number(centerY)})/${number(halfHeight)},2),1)`
    : [
        `gte(X,${number(centerX - halfWidth)})`,
        `lte(X,${number(centerX + halfWidth)})`,
        `gte(Y,${number(centerY - halfHeight)})`,
        `lte(Y,${number(centerY + halfHeight)})`,
      ].join('*')
  const keptCondition = mask.version === 2 && mask.inverted
    ? `not(${condition})`
    : condition
  const channel = (reader: 'r' | 'g' | 'b'): string => (
    `if(${keptCondition},${reader}(X,Y),0)`
  )
  return `,format=gbrp,geq=r='${channel('r')}':g='${channel('g')}':b='${channel('b')}'`
}

function imageFilter(
  clip: StaticImageRenderClip,
  index: number,
  width: number,
  height: number,
): string {
  const fit = clip.fit === 'contain'
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
  const motion = clip.uniformScaleMotion
    ? (() => {
        const scalar = (value: number): string => (
          value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
        )
        const delta = clip.uniformScaleMotion.toScale - clip.uniformScaleMotion.fromScale
        const operator = delta < 0 ? '-' : '+'
        const zoom = [
          scalar(clip.uniformScaleMotion.fromScale),
          operator,
          scalar(Math.abs(delta)),
          `*on/${clip.uniformScaleMotion.durationFrames}`,
        ].join('')
        return `,zoompan=z='${zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=${RENDER_FRAME_RATE}`
      })()
    : clip.kenBurns
      ? `,zoompan=z='min(1+0.08*on/${Math.max(clip.durationFrames - 1, 1)},1.08)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=${RENDER_FRAME_RATE}`
      : `,fps=${RENDER_FRAME_RATE}`
  return `[${index}:v]${fit},setsar=1${motion},trim=end_frame=${clip.durationFrames},setpts=PTS-STARTPTS${visualShapeMaskFilters(clip.shapeMask, width, height)}${visualOpacityFilters(clip.opacityFade)},format=yuv420p[v${index}]`
}

function videoFilter(
  clip: VideoRenderClip,
  index: number,
  width: number,
  height: number,
): string {
  const fit = clip.fit === 'contain'
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
  return `[${index}:v]trim=start=${clip.sourceStartSeconds}:duration=${fixedSeconds(clip.durationFrames)},setpts=PTS-STARTPTS,${fit},setsar=1,fps=${RENDER_FRAME_RATE},trim=end_frame=${clip.durationFrames},setpts=PTS-STARTPTS${visualShapeMaskFilters(clip.shapeMask, width, height)}${visualOpacityFilters(clip.opacityFade)},format=yuv420p[v${index}]`
}

function audioFilter(
  clip: NormalizedAudioRenderClip,
  inputIndex: number,
  outputIndex: number,
  dialogueIntervals: readonly AudioFrameInterval[],
): string {
  const trim = clip.durationFrames === undefined
    ? `atrim=start=${clip.sourceStartSeconds}`
    : `atrim=start=${clip.sourceStartSeconds}:duration=${fixedSeconds(clip.durationFrames)}`
  // 48 kHz / 24 fps = exactly 2,000 samples per frame, avoiding ms rounding.
  const delaySamples = clip.startFrame * (RENDER_AUDIO_SAMPLE_RATE / RENDER_FRAME_RATE)
  const fades: string[] = []
  if (clip.fadeInSeconds !== undefined && clip.fadeInSeconds > 0) {
    fades.push(`afade=t=in:st=0:d=${fixedDecimalSeconds(clip.fadeInSeconds)}`)
  }
  if (clip.fadeOutSeconds !== undefined && clip.fadeOutSeconds > 0) {
    const fadeOutStartSeconds = clip.effectiveDurationSeconds - clip.fadeOutSeconds
    fades.push(
      `afade=t=out:st=${fixedDecimalSeconds(fadeOutStartSeconds)}:d=${fixedDecimalSeconds(clip.fadeOutSeconds)}`,
    )
  }
  const fadeFilters = fades.length === 0 ? '' : `,${fades.join(',')}`
  const duckingFilters = clip.duckingWindows === undefined
    ? dialogueDuckingFilters(clip, dialogueIntervals)
    : clip.duckingWindows.map((window) => duckingEnvelopeFilter(clip, window))
  const ducking = duckingFilters.length === 0 ? '' : `,${duckingFilters.join(',')}`
  return `[${inputIndex}:a]${trim},asetpts=PTS-STARTPTS,aresample=${RENDER_AUDIO_SAMPLE_RATE},aformat=sample_rates=${RENDER_AUDIO_SAMPLE_RATE}:channel_layouts=stereo${fadeFilters},volume=${clip.volume}${ducking},adelay=${delaySamples}S:all=1[a${outputIndex}]`
}

function buildFfmpegArgs(
  timeline: NormalizedTimeline,
  dimensions: { width: number; height: number },
  taskOutputPath: string,
  subtitleFileName: string | undefined,
): string[] {
  const totalSeconds = fixedSeconds(timeline.totalFrames)
  const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-nostdin', '-n']
  for (const clip of timeline.visualClips) {
    if (clip.mediaType === 'video') {
      // The input's embedded audio is deliberately not referenced below. The
      // final mix is sourced only from explicit audio tracks, preventing a
      // generated clip from doubling managed TTS/dialogue audio.
      args.push('-i', clip.assetPath)
    } else {
      args.push(
        '-loop', '1',
        '-framerate', String(RENDER_FRAME_RATE),
        '-t', fixedSeconds(clip.durationFrames),
        '-i', clip.assetPath,
      )
    }
  }
  for (const clip of timeline.audioClips) args.push('-i', clip.assetPath)
  if (timeline.audioClips.length === 0) {
    args.push(
      '-f', 'lavfi',
      '-t', totalSeconds,
      '-i', `anullsrc=channel_layout=stereo:sample_rate=${RENDER_AUDIO_SAMPLE_RATE}`,
    )
  }

  const filters: string[] = timeline.visualClips.map((clip, index) => (
    clip.mediaType === 'video'
      ? videoFilter(clip, index, dimensions.width, dimensions.height)
      : imageFilter(clip, index, dimensions.width, dimensions.height)
  ))
  const videoInputs = timeline.visualClips.map((_, index) => `[v${index}]`).join('')
  if (timeline.visualClips.length === 1) {
    filters.push(`${videoInputs}null[vbase]`)
  } else {
    filters.push(`${videoInputs}concat=n=${timeline.visualClips.length}:v=1:a=0[vbase]`)
  }
  if (subtitleFileName) {
    const subtitleFilter = timeline.subtitles?.format === 'ass' ? 'ass' : 'subtitles'
    filters.push(`[vbase]${subtitleFilter}=filename='${subtitleFileName}'[vout]`)
  } else {
    filters.push('[vbase]null[vout]')
  }

  if (timeline.audioClips.length === 0) {
    const silentInputIndex = timeline.visualClips.length
    filters.push(`[${silentInputIndex}:a]atrim=end=${totalSeconds},asetpts=PTS-STARTPTS[aout]`)
  } else {
    const dialogueIntervals = mergedDialogueIntervals(timeline.audioClips)
    timeline.audioClips.forEach((clip, index) => {
      filters.push(audioFilter(
        clip,
        timeline.visualClips.length + index,
        index,
        dialogueIntervals,
      ))
    })
    const audioInputs = timeline.audioClips.map((_, index) => `[a${index}]`).join('')
    if (timeline.audioClips.length === 1) {
      filters.push(`${audioInputs}apad,atrim=end=${totalSeconds},asetpts=PTS-STARTPTS[aout]`)
    } else {
      filters.push(`${audioInputs}amix=inputs=${timeline.audioClips.length}:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end=${totalSeconds},asetpts=PTS-STARTPTS[aout]`)
    }
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', String(RENDER_FRAME_RATE),
    '-fps_mode', 'cfr',
    '-frames:v', String(timeline.totalFrames),
    '-c:a', 'aac',
    '-ar', String(RENDER_AUDIO_SAMPLE_RATE),
    '-ac', '2',
    '-b:a', '192k',
    '-t', totalSeconds,
    '-movflags', '+faststart',
    '-f', 'mp4',
    taskOutputPath,
  )
  return args
}

function parseNumber(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw renderError('INVALID_RENDER_OUTPUT', `ffprobe ${label} 无效`)
  return parsed
}

function parseFrameRate(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN
  const [numeratorValue, denominatorValue = '1'] = value.split('/', 2)
  const numerator = Number(numeratorValue)
  const denominator = Number(denominatorValue)
  return denominator === 0 ? Number.NaN : numerator / denominator
}

function verifySourceVideoProbe(
  stdout: Buffer,
  clip: VideoRenderClip,
  index: number,
): void {
  let parsed: RawProbeDocument
  try {
    parsed = JSON.parse(stdout.toString('utf8')) as RawProbeDocument
  } catch (error) {
    throw renderError('INVALID_VIDEO_INPUT', `视频片段 ${index + 1} 的 ffprobe 结果无效`, { cause: error })
  }
  if (!Array.isArray(parsed.streams) || !parsed.format || typeof parsed.format !== 'object') {
    throw renderError('INVALID_VIDEO_INPUT', `视频片段 ${index + 1} 缺少可解码的视频流或容器时长`)
  }
  const videos = (parsed.streams as RawProbeStream[])
    .filter((stream) => stream.codec_type === 'video')
  if (videos.length !== 1) {
    throw renderError('INVALID_VIDEO_INPUT', `视频片段 ${index + 1} 必须恰好包含一条视频流`)
  }
  const rawDuration = (parsed.format as Record<string, unknown>).duration
  const durationSeconds = typeof rawDuration === 'number' ? rawDuration : Number(rawDuration)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86_400) {
    throw renderError('INVALID_VIDEO_INPUT', `视频片段 ${index + 1} 的容器时长无效`)
  }
  const requiredEnd = clip.sourceStartSeconds + clip.durationFrames / RENDER_FRAME_RATE
  if (durationSeconds + 0.1 < requiredEnd) {
    throw renderError(
      'INVALID_VIDEO_INPUT',
      `视频片段 ${index + 1} 的实际时长不足以完成固化裁剪`,
    )
  }
}

function verifyProbe(
  stdout: Buffer,
  expected: { width: number; height: number; totalFrames: number },
): VerifiedRenderProbe {
  let parsed: RawProbeDocument
  try {
    parsed = JSON.parse(stdout.toString('utf8')) as RawProbeDocument
  } catch (error) {
    throw renderError('INVALID_RENDER_OUTPUT', 'ffprobe 未返回有效 JSON', { cause: error })
  }
  if (!Array.isArray(parsed.streams) || !parsed.format || typeof parsed.format !== 'object') {
    throw renderError('INVALID_RENDER_OUTPUT', 'ffprobe 结果缺少媒体流或容器信息')
  }
  const streams = parsed.streams as RawProbeStream[]
  const videos = streams.filter((stream) => stream.codec_type === 'video')
  const audios = streams.filter((stream) => stream.codec_type === 'audio')
  if (videos.length !== 1 || audios.length !== 1) {
    throw renderError('INVALID_RENDER_OUTPUT', '导出文件必须恰好包含一条视频流和一条音频流')
  }
  const video = videos[0]
  const audio = audios[0]
  if (video.codec_name !== 'h264') throw renderError('INVALID_RENDER_OUTPUT', '导出视频不是 H.264')
  if (video.width !== expected.width || video.height !== expected.height) {
    throw renderError('INVALID_RENDER_OUTPUT', `导出分辨率不是 ${expected.width}x${expected.height}`)
  }
  if (video.pix_fmt !== 'yuv420p') throw renderError('INVALID_RENDER_OUTPUT', '导出像素格式不是 yuv420p')
  const frameRate = parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate)
  if (Math.abs(frameRate - RENDER_FRAME_RATE) > 0.001) {
    throw renderError('INVALID_RENDER_OUTPUT', `导出帧率不是 ${RENDER_FRAME_RATE} fps`)
  }
  if (audio.codec_name !== 'aac') throw renderError('INVALID_RENDER_OUTPUT', '导出音频不是 AAC')
  if (parseNumber(audio.sample_rate, 'audio.sample_rate') !== RENDER_AUDIO_SAMPLE_RATE) {
    throw renderError('INVALID_RENDER_OUTPUT', '导出音频采样率不是 48 kHz')
  }
  if (audio.channels !== 2) throw renderError('INVALID_RENDER_OUTPUT', '导出音频不是双声道')

  const format = parsed.format as Record<string, unknown>
  const durationSeconds = parseNumber(format.duration, 'format.duration')
  const expectedDuration = expected.totalFrames / RENDER_FRAME_RATE
  if (Math.abs(durationSeconds - expectedDuration) > 0.1) {
    throw renderError(
      'INVALID_RENDER_OUTPUT',
      `导出时长 ${durationSeconds}s 与时间线 ${expectedDuration}s 不一致`,
    )
  }
  const formatName = typeof format.format_name === 'string' ? format.format_name : ''
  if (!formatName.split(',').includes('mp4')) {
    throw renderError('INVALID_RENDER_OUTPUT', '导出容器不是 MP4')
  }
  const reportedFrames = video.nb_frames === undefined
    ? undefined
    : parseNumber(video.nb_frames, 'video.nb_frames')
  if (reportedFrames !== undefined && reportedFrames !== expected.totalFrames) {
    throw renderError('INVALID_RENDER_OUTPUT', `导出帧数 ${reportedFrames} 与时间线不一致`)
  }

  return {
    formatName,
    durationSeconds,
    video: {
      codec: 'h264',
      width: expected.width,
      height: expected.height,
      pixelFormat: 'yuv420p',
      frameRate: RENDER_FRAME_RATE,
      ...(reportedFrames === undefined ? {} : { frames: reportedFrames }),
    },
    audio: {
      codec: 'aac',
      sampleRate: RENDER_AUDIO_SAMPLE_RATE,
      channels: 2,
    },
  }
}

async function assertTemporaryOutput(path: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    throw renderError('INVALID_RENDER_OUTPUT', 'FFmpeg 未生成输出文件', { cause: error })
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size === 0) {
    throw renderError('INVALID_RENDER_OUTPUT', 'FFmpeg 输出不是非空普通文件')
  }
}

function boundedStderr(result: ProcessRunResult): string {
  return result.stderr.toString('utf8').trim()
}

export class FfmpegRenderer {
  private readonly ffmpegPath: string | null
  private readonly ffprobePath: string | null
  private readonly runner: RenderProcessRunner
  private readonly renderTimeoutMs: number
  private readonly probeTimeoutMs: number
  private readonly maxStderrBytes: number
  private readonly runtimeReceipt: FfmpegRendererRuntimeReceipt

  constructor(options: FfmpegRendererOptions = {}) {
    const usesResolvedRuntime = options.ffmpegPath === undefined && options.ffprobePath === undefined
    this.ffmpegPath = options.ffmpegPath === undefined ? resolveBundledFfmpegPath() : options.ffmpegPath
    this.ffprobePath = options.ffprobePath === undefined ? resolveBundledFfprobePath() : options.ffprobePath
    this.runtimeReceipt = usesResolvedRuntime
      ? resolveRuntimeFfmpegDiagnosticReceipt()
      : { schemaVersion: 1, source: 'injected', releaseEligible: false, audit: null }
    this.runner = options.runner ?? new SpawnProcessRunner()
    this.renderTimeoutMs = options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
  }

  runtimeDiagnosticReceipt(): FfmpegRendererRuntimeReceipt {
    return structuredClone(this.runtimeReceipt)
  }

  async render(request: FfmpegRenderRequest): Promise<FfmpegRenderResult> {
    throwIfAborted(request.signal)
    if (!this.ffmpegPath || !this.ffprobePath) {
      throw renderError('BINARY_UNAVAILABLE', '当前平台没有可用的 FFmpeg/ffprobe 固定二进制')
    }
    const timeline = normalizeTimeline(request.timeline)
    const dimensions = resolutionDimensions(request.resolution, request.aspectRatio)
    await assertOutputPathAvailable(request.outputPath)
    await Promise.all([
      ...timeline.visualClips.map((clip, index) => (
        assertAbsoluteRegularFile(clip.assetPath, `visualClips[${index}].assetPath`)
      )),
      ...timeline.audioClips.map((clip, index) => (
        assertAbsoluteRegularFile(clip.assetPath, `audioClips[${index}].assetPath`)
      )),
      ...(timeline.subtitles
        ? [assertAbsoluteRegularFile(timeline.subtitles.assetPath, 'subtitles.assetPath')]
        : []),
    ])
    throwIfAborted(request.signal)

    for (let index = 0; index < timeline.visualClips.length; index += 1) {
      const clip = timeline.visualClips[index]
      if (clip.mediaType !== 'video') continue
      const sourceProbe = await this.runner.run({
        command: this.ffprobePath,
        args: [
          '-v', 'error',
          '-show_entries', 'format=duration:stream=codec_type',
          '-of', 'json',
          clip.assetPath,
        ],
        cwd: dirname(clip.assetPath),
        signal: request.signal,
        timeoutMs: this.probeTimeoutMs,
        maxStdoutBytes: DEFAULT_MAX_STDOUT_BYTES,
        maxStderrBytes: this.maxStderrBytes,
      })
      if (sourceProbe.exitCode !== 0) {
        throw renderError('FFPROBE_FAILED', `视频片段 ${index + 1} 无法通过 ffprobe 验证`, {
          stderr: boundedStderr(sourceProbe),
        })
      }
      verifySourceVideoProbe(sourceProbe.stdout, clip, index)
      throwIfAborted(request.signal)
    }

    const outputDirectory = dirname(request.outputPath)
    const taskDirectory = await mkdtemp(join(outputDirectory, '.manju-render-'))
    const temporaryOutput = join(taskDirectory, 'render.mp4')
    let published = false
    try {
      let subtitleFileName: string | undefined
      if (timeline.subtitles) {
        subtitleFileName = `subtitles.${timeline.subtitles.format}`
        await copyFile(
          timeline.subtitles.assetPath,
          join(taskDirectory, subtitleFileName),
          fsConstants.COPYFILE_EXCL,
        )
      }
      const ffmpegArgs = buildFfmpegArgs(timeline, dimensions, temporaryOutput, subtitleFileName)
      const renderResult = await this.runner.run({
        command: this.ffmpegPath,
        args: ffmpegArgs,
        cwd: taskDirectory,
        signal: request.signal,
        timeoutMs: this.renderTimeoutMs,
        maxStdoutBytes: DEFAULT_MAX_STDOUT_BYTES,
        maxStderrBytes: this.maxStderrBytes,
      })
      if (renderResult.exitCode !== 0) {
        throw renderError('FFMPEG_FAILED', `FFmpeg 导出失败（退出码 ${renderResult.exitCode}）`, {
          stderr: boundedStderr(renderResult),
        })
      }
      await assertTemporaryOutput(temporaryOutput)
      throwIfAborted(request.signal)

      const probeResult = await this.runner.run({
        command: this.ffprobePath,
        args: [
          '-v', 'error',
          '-show_entries',
          'format=format_name,duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,sample_rate,channels,nb_frames',
          '-of', 'json',
          temporaryOutput,
        ],
        cwd: taskDirectory,
        signal: request.signal,
        timeoutMs: this.probeTimeoutMs,
        maxStdoutBytes: DEFAULT_MAX_STDOUT_BYTES,
        maxStderrBytes: this.maxStderrBytes,
      })
      if (probeResult.exitCode !== 0) {
        throw renderError('FFPROBE_FAILED', `ffprobe 验证失败（退出码 ${probeResult.exitCode}）`, {
          stderr: boundedStderr(probeResult),
        })
      }
      const probe = verifyProbe(probeResult.stdout, {
        ...dimensions,
        totalFrames: timeline.totalFrames,
      })
      throwIfAborted(request.signal)

      // Re-check immediately before publishing, then use a hard link. link(2)
      // is an atomic no-clobber publication on the same filesystem, unlike
      // rename(), which may replace an existing destination on POSIX.
      await assertOutputPathAvailable(request.outputPath)
      const file = await open(temporaryOutput, 'r')
      try {
        await file.sync()
      } finally {
        await file.close()
      }
      try {
        await link(temporaryOutput, request.outputPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw renderError('OUTPUT_EXISTS', '输出文件在导出期间已被创建，拒绝覆盖', { cause: error })
        }
        throw renderError('PUBLISH_FAILED', '无法原子发布导出文件', { cause: error })
      }
      published = true
      return {
        outputPath: request.outputPath,
        timelineRevisionId: timeline.revisionId,
        durationSeconds: timeline.totalFrames / RENDER_FRAME_RATE,
        frameCount: timeline.totalFrames,
        width: dimensions.width,
        height: dimensions.height,
        probe,
      }
    } finally {
      await rm(taskDirectory, { recursive: true, force: true }).catch(() => undefined)
      // `published` documents that cleanup must never remove the hard-linked
      // final output. It is intentionally retained for audit readability.
      void published
    }
  }
}

export function createFfmpegRenderer(options: FfmpegRendererOptions = {}): FfmpegRenderer {
  return new FfmpegRenderer(options)
}
