import type {
  RenderSemanticAudioClip,
  RenderSemanticFit,
  RenderSemanticPlan,
  RenderSemanticSubtitleCue,
  RenderSemanticVisualClip,
} from '@manju/opencut-editor'
import {
  renderSemanticPlanBoundarySignature,
  renderSemanticVisualOpacityAtFrame,
  renderSemanticVisualScaleAtFrame,
  renderSemanticVisualShapeMaskGeometry,
} from '@manju/opencut-editor'
import type { TimelineMediaBinding, TimelineMediaManifest } from './manju-media-resolver'

// Keep review exports on the same explicit delivery clock as the formal
// renderer. AAC encoder delay may still differ between WebCodecs and FFmpeg,
// but the persisted files must not silently disagree about sample rate.
const QUICK_EXPORT_SAMPLE_RATE = 48_000
const QUICK_EXPORT_CHANNELS = 2
const MAX_QUICK_EXPORT_FRAMES = 24 * 60 * 10
const MAX_ASSET_BYTES = 500 * 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/

type Mediabunny = typeof import('mediabunny')
type WrappedCanvas = import('mediabunny').WrappedCanvas
type MediaInput = import('mediabunny').Input

export type BrowserQuickExportErrorCode =
  | 'ABORTED'
  | 'ASSET_CHANGED'
  | 'ASSET_FETCH_FAILED'
  | 'ASSET_TOO_LARGE'
  | 'AUDIO_DECODE_FAILED'
  | 'EXPORT_FAILED'
  | 'INVALID_MANIFEST'
  | 'MEDIA_DECODE_FAILED'
  | 'TOO_LONG'
  | 'UNSUPPORTED_BROWSER'

export class BrowserQuickExportError extends Error {
  constructor(
    readonly code: BrowserQuickExportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'BrowserQuickExportError'
  }
}

export interface BrowserQuickExportSupport {
  supported: boolean
  reason: string | null
}

export interface BrowserQuickExportProgress {
  phase: 'assets' | 'audio' | 'frames' | 'finalize'
  progress: number
}

export interface BrowserQuickExportRuntimeCapabilities {
  document: boolean
  fetch: boolean
  crypto: boolean
  createImageBitmap: boolean
  videoEncoder: boolean
  videoDecoder: boolean
  audioEncoder: boolean
  audioDecoder: boolean
  offlineAudioContext: boolean
}

interface VerifiedAsset {
  binding: TimelineMediaBinding
  blob: Blob
}

interface DecodedAudio {
  sampleRate: number
  channels: Float32Array[]
}

function runtimeCapabilities(): BrowserQuickExportRuntimeCapabilities {
  return {
    document: typeof document !== 'undefined' && typeof document.createElement === 'function',
    fetch: typeof fetch === 'function',
    crypto: typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function',
    createImageBitmap: typeof createImageBitmap === 'function',
    videoEncoder: typeof VideoEncoder !== 'undefined',
    videoDecoder: typeof VideoDecoder !== 'undefined',
    audioEncoder: typeof AudioEncoder !== 'undefined',
    audioDecoder: typeof AudioDecoder !== 'undefined',
    offlineAudioContext: typeof OfflineAudioContext !== 'undefined',
  }
}

/** Synchronous feature gate used to keep an unsupported button disabled. */
export function browserQuickExportBaseSupport(
  plan: Pick<RenderSemanticPlan, 'version' | 'visualClips' | 'audioClips'>,
  capabilities: BrowserQuickExportRuntimeCapabilities = runtimeCapabilities(),
): BrowserQuickExportSupport {
  const planVersion = Number(plan.version)
  const hasShapeMaskV2 = plan.visualClips.some((clip) => (
    Number((clip.shapeMask as { version?: unknown } | undefined)?.version) === 2
  ))
  const hasLegacyShapeMask = plan.visualClips.some((clip) => (
    clip.shapeMask !== undefined
      && Number((clip.shapeMask as { version?: unknown }).version) !== 2
  ))
  if (plan.version === 1 && plan.visualClips.some((clip) => clip.shapeMask !== undefined)) {
    return { supported: false, reason: 'RenderSemanticPlan v1 不能携带形状遮罩语义' }
  }
  if (plan.version === 1 && plan.visualClips.some((clip) => clip.opacityFade !== undefined)) {
    return { supported: false, reason: 'RenderSemanticPlan v1 不能携带透明度组合语义' }
  }
  if (plan.version === 2 && plan.visualClips.some((clip) => clip.shapeMask !== undefined)) {
    return { supported: false, reason: 'RenderSemanticPlan v2 不能携带形状遮罩语义' }
  }
  if (planVersion < 5 && hasShapeMaskV2) {
    return {
      supported: false,
      reason: `RenderSemanticPlan v${plan.version} 不能携带形状遮罩 v2 语义`,
    }
  }
  if (planVersion >= 5 && hasLegacyShapeMask) {
    return {
      supported: false,
      reason: `RenderSemanticPlan v${plan.version} 形状遮罩必须使用 v2 receipt`,
    }
  }
  if (plan.version < 4 && plan.visualClips.some((clip) => clip.uniformScaleMotion !== undefined)) {
    return {
      supported: false,
      reason: `RenderSemanticPlan v${plan.version} 不能携带图片推拉运动语义`,
    }
  }
  if (plan.visualClips.some((clip) => (
    clip.mediaType === 'video' && clip.uniformScaleMotion !== undefined
  ))) {
    return { supported: false, reason: '视频片段不能携带图片推拉运动语义' }
  }
  const required: Array<[keyof BrowserQuickExportRuntimeCapabilities, string]> = [
    ['document', '当前环境没有 Canvas DOM'],
    ['fetch', '当前环境没有 Fetch API'],
    ['crypto', '当前环境不能校验资产 SHA-256'],
    ['videoEncoder', '当前浏览器没有 WebCodecs VideoEncoder'],
  ]
  if (plan.visualClips.some((clip) => clip.mediaType === 'image')) {
    required.push(['createImageBitmap', '当前浏览器不能安全解码图片'])
  }
  if (plan.visualClips.some((clip) => clip.mediaType === 'video')) {
    required.push(['videoDecoder', '当前浏览器没有 WebCodecs VideoDecoder'])
  }
  if (plan.audioClips.length > 0) {
    required.push(
      ['audioEncoder', '当前浏览器没有 WebCodecs AudioEncoder'],
      ['audioDecoder', '当前浏览器没有 WebCodecs AudioDecoder'],
      ['offlineAudioContext', '当前浏览器没有 OfflineAudioContext'],
    )
  }
  const missing = required.find(([key]) => !capabilities[key])
  return missing
    ? { supported: false, reason: missing[1] }
    : { supported: true, reason: null }
}

export function quickExportDimensions(
  aspectRatio: RenderSemanticPlan['aspectRatio'],
): { width: number; height: number } {
  if (aspectRatio === '16:9') return { width: 1280, height: 720 }
  if (aspectRatio === '9:16') return { width: 720, height: 1280 }
  return { width: 720, height: 720 }
}

/**
 * Probe the exact Mediabunny codecs used by the export. A package import or
 * codec probe failure is an unsupported result, never a silent format switch.
 */
export async function probeBrowserQuickExport(
  plan: RenderSemanticPlan,
): Promise<BrowserQuickExportSupport> {
  const base = browserQuickExportBaseSupport(plan)
  if (!base.supported) return base
  if (plan.totalFrames > MAX_QUICK_EXPORT_FRAMES) {
    return { supported: false, reason: '浏览器快导暂限 10 分钟，请使用正式 FFmpeg 导出' }
  }
  try {
    const mediabunny = await import('mediabunny')
    const { width, height } = quickExportDimensions(plan.aspectRatio)
    const video = await mediabunny.canEncodeVideo('avc', {
      width,
      height,
      bitrate: mediabunny.QUALITY_HIGH,
      bitrateMode: 'variable',
      latencyMode: 'quality',
    })
    if (!video) return { supported: false, reason: '当前浏览器不能编码 H.264/AVC MP4' }
    if (plan.audioClips.length > 0) {
      const audio = await mediabunny.canEncodeAudio('aac', {
        numberOfChannels: QUICK_EXPORT_CHANNELS,
        sampleRate: QUICK_EXPORT_SAMPLE_RATE,
        bitrate: 192_000,
      })
      if (!audio) return { supported: false, reason: '当前浏览器不能编码 AAC 音轨' }
    }
    return { supported: true, reason: null }
  } catch (cause) {
    return {
      supported: false,
      reason: cause instanceof Error
        ? `Mediabunny 初始化失败：${cause.message}`
        : 'Mediabunny 初始化失败',
    }
  }
}

function abortError(): BrowserQuickExportError {
  return new BrowserQuickExportError('ABORTED', '浏览器快导已取消')
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function normalizedChecksum(value: string | null): string | null {
  const result = value?.trim().toLowerCase() ?? null
  return result && SHA256.test(result) ? result : null
}

function audioElementId(clip: RenderSemanticAudioClip): string {
  return clip.id.endsWith(':source-audio')
    ? clip.id.slice(0, -':source-audio'.length)
    : clip.id
}

function findBinding(
  manifest: TimelineMediaManifest,
  clip: RenderSemanticVisualClip | RenderSemanticAudioClip,
): TimelineMediaBinding {
  const elementId = 'mediaType' in clip ? clip.id : audioElementId(clip)
  const binding = manifest.bindings.find((candidate) => (
    candidate.elementId === elementId
    && candidate.assetId === clip.asset.assetId
  ))
  if (!binding) {
    throw new BrowserQuickExportError(
      'INVALID_MANIFEST',
      `渲染计划片段 ${clip.id} 缺少固定媒体绑定`,
    )
  }
  if (
    binding.assetVersion !== clip.asset.version
    || normalizedChecksum(binding.assetChecksum) !== clip.asset.checksum
  ) {
    throw new BrowserQuickExportError(
      'ASSET_CHANGED',
      `资产 ${clip.asset.assetId} 的版本或校验和已变化`,
    )
  }
  return binding
}

export function validateQuickExportManifest(
  plan: RenderSemanticPlan,
  manifest: TimelineMediaManifest,
): TimelineMediaBinding[] {
  if (manifest.issues.length > 0) {
    throw new BrowserQuickExportError(
      'INVALID_MANIFEST',
      `${manifest.issues.length} 个媒体引用未通过解析`,
    )
  }
  const bindings = [
    ...plan.visualClips.map((clip) => findBinding(manifest, clip)),
    ...plan.audioClips.map((clip) => findBinding(manifest, clip)),
  ]
  return [...new Map(bindings.map((binding) => [binding.assetId, binding])).values()]
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function fetchVerifiedAssets({
  plan,
  manifest,
  signal,
  onProgress,
}: {
  plan: RenderSemanticPlan
  manifest: TimelineMediaManifest
  signal?: AbortSignal
  onProgress?: (progress: BrowserQuickExportProgress) => void
}): Promise<Map<string, VerifiedAsset>> {
  const bindings = validateQuickExportManifest(plan, manifest)
  const pins = new Map([
    ...plan.visualClips.map((clip) => [clip.asset.assetId, clip.asset] as const),
    ...plan.audioClips.map((clip) => [clip.asset.assetId, clip.asset] as const),
  ])
  const result = new Map<string, VerifiedAsset>()
  for (const [index, binding] of bindings.entries()) {
    checkAbort(signal)
    let response: Response
    try {
      response = await fetch(binding.url, {
        signal,
        credentials: 'same-origin',
        redirect: 'error',
      })
    } catch (cause) {
      if (signal?.aborted) throw abortError()
      throw new BrowserQuickExportError(
        'ASSET_FETCH_FAILED',
        `无法读取资产 ${binding.assetId}`,
        { cause },
      )
    }
    if (!response.ok) {
      throw new BrowserQuickExportError(
        'ASSET_FETCH_FAILED',
        `读取资产 ${binding.assetId} 失败（HTTP ${response.status}）`,
      )
    }
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSET_BYTES) {
      throw new BrowserQuickExportError('ASSET_TOO_LARGE', `资产 ${binding.assetId} 超过 500MB`)
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType && contentType !== binding.mimeType.toLowerCase()) {
      throw new BrowserQuickExportError(
        'ASSET_CHANGED',
        `资产 ${binding.assetId} 的 MIME 类型已变化`,
      )
    }
    const blob = await response.blob()
    if (blob.size > MAX_ASSET_BYTES) {
      throw new BrowserQuickExportError('ASSET_TOO_LARGE', `资产 ${binding.assetId} 超过 500MB`)
    }
    checkAbort(signal)
    const checksum = await sha256(blob)
    if (checksum !== pins.get(binding.assetId)?.checksum) {
      throw new BrowserQuickExportError(
        'ASSET_CHANGED',
        `资产 ${binding.assetId} 字节校验失败，已拒绝快导`,
      )
    }
    result.set(binding.assetId, { binding, blob })
    onProgress?.({
      phase: 'assets',
      progress: bindings.length === 0 ? 0.18 : 0.18 * ((index + 1) / bindings.length),
    })
  }
  return result
}

/** Adapted from pinned OpenCut Classic VideoCache; errors are not swallowed. */
class PinnedVideoFrameCache {
  private readonly sinks = new Map<string, {
    input: MediaInput
    sink: import('mediabunny').CanvasSink
    iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null
    currentFrame: WrappedCanvas | null
    nextFrame: WrappedCanvas | null
    lastTime: number
  }>()
  private readonly initialization = new Map<string, Promise<void>>()

  constructor(private readonly mediabunny: Mediabunny) {}

  async getFrameAt(mediaId: string, blob: Blob, time: number): Promise<WrappedCanvas | null> {
    await this.ensureSink(mediaId, blob)
    const data = this.sinks.get(mediaId)
    if (!data) return null
    if (data.nextFrame && data.nextFrame.timestamp <= time) {
      data.currentFrame = data.nextFrame
      data.nextFrame = null
    }
    if (data.currentFrame && time >= data.currentFrame.timestamp
      && time < data.currentFrame.timestamp + data.currentFrame.duration) {
      return data.currentFrame
    }
    if (data.iterator && data.currentFrame && time >= data.lastTime && time < data.lastTime + 2) {
      while (true) {
        const { value, done } = await data.iterator.next()
        if (done || !value) break
        data.currentFrame = value
        data.lastTime = value.timestamp
        if (time >= value.timestamp && time < value.timestamp + value.duration) return value
        if (value.timestamp > time + 1) break
      }
    }
    if (data.iterator) await data.iterator.return()
    data.iterator = data.sink.canvases(time)
    data.nextFrame = null
    data.lastTime = time
    const { value } = await data.iterator.next()
    data.currentFrame = value ?? null
    return data.currentFrame
  }

  private async ensureSink(mediaId: string, blob: Blob): Promise<void> {
    if (this.sinks.has(mediaId)) return
    const inFlight = this.initialization.get(mediaId)
    if (inFlight) return inFlight
    const promise = this.initialize(mediaId, blob)
    this.initialization.set(mediaId, promise)
    try {
      await promise
    } finally {
      this.initialization.delete(mediaId)
    }
  }

  private async initialize(mediaId: string, blob: Blob): Promise<void> {
    const input = new this.mediabunny.Input({
      source: new this.mediabunny.BlobSource(blob),
      formats: this.mediabunny.ALL_FORMATS,
    })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (!track || !await track.canDecode()) {
        throw new BrowserQuickExportError(
          'MEDIA_DECODE_FAILED',
          `资产 ${mediaId} 的视频编码不能由当前浏览器解码`,
        )
      }
      this.sinks.set(mediaId, {
        input,
        sink: new this.mediabunny.CanvasSink(track, { poolSize: 3, fit: 'contain' }),
        iterator: null,
        currentFrame: null,
        nextFrame: null,
        lastTime: -1,
      })
    } catch (cause) {
      input.dispose()
      throw cause
    }
  }

  clear(): void {
    for (const data of this.sinks.values()) {
      if (data.iterator) void data.iterator.return()
      data.input.dispose()
    }
    this.sinks.clear()
    this.initialization.clear()
  }
}

async function decodeAudio(
  mediabunny: Mediabunny,
  assetId: string,
  blob: Blob,
): Promise<DecodedAudio> {
  const input = new mediabunny.Input({
    source: new mediabunny.BlobSource(blob),
    formats: mediabunny.ALL_FORMATS,
  })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !await track.canDecode()) {
      throw new BrowserQuickExportError(
        'AUDIO_DECODE_FAILED',
        `资产 ${assetId} 没有当前浏览器可解码的音轨`,
      )
    }
    const chunks: import('mediabunny').WrappedAudioBuffer[] = []
    let sampleRate = 0
    let endSample = 0
    for await (const chunk of new mediabunny.AudioBufferSink(track).buffers(0)) {
      if (sampleRate === 0) sampleRate = chunk.buffer.sampleRate
      if (chunk.buffer.sampleRate !== sampleRate) {
        throw new BrowserQuickExportError('AUDIO_DECODE_FAILED', `资产 ${assetId} 的音频采样率不稳定`)
      }
      chunks.push(chunk)
      endSample = Math.max(
        endSample,
        Math.round(chunk.timestamp * sampleRate) + chunk.buffer.length,
      )
    }
    if (sampleRate < 1 || chunks.length === 0 || endSample < 1) {
      throw new BrowserQuickExportError('AUDIO_DECODE_FAILED', `资产 ${assetId} 的音轨为空`)
    }
    const channelCount = Math.min(
      QUICK_EXPORT_CHANNELS,
      Math.max(...chunks.map((chunk) => chunk.buffer.numberOfChannels)),
    )
    const channels = Array.from({ length: channelCount }, () => new Float32Array(endSample))
    for (const chunk of chunks) {
      const offset = Math.max(0, Math.round(chunk.timestamp * sampleRate))
      for (let channel = 0; channel < channelCount; channel += 1) {
        channels[channel]!.set(
          chunk.buffer.getChannelData(Math.min(channel, chunk.buffer.numberOfChannels - 1)),
          offset,
        )
      }
    }
    return { sampleRate, channels }
  } finally {
    input.dispose()
  }
}

function semanticAudioDuckingGainAtSeconds(
  clip: RenderSemanticAudioClip,
  timelineSeconds: number,
  frameRate: number,
): number {
  let gain = 1
  for (const window of clip.duckingWindows) {
    const dialogueStart = window.startFrame / frameRate
    const dialogueEnd = window.endFrameExclusive / frameRate
    const attackStart = dialogueStart - window.attackSeconds
    const releaseEnd = dialogueEnd + window.releaseSeconds
    if (timelineSeconds < attackStart || timelineSeconds >= releaseEnd) continue
    if (timelineSeconds < dialogueStart) {
      gain *= 1 - (1 - window.duckedLinearGain)
        * ((timelineSeconds - attackStart) / window.attackSeconds)
    } else if (timelineSeconds < dialogueEnd) {
      gain *= window.duckedLinearGain
    } else {
      gain *= window.duckedLinearGain + (1 - window.duckedLinearGain)
        * ((timelineSeconds - dialogueEnd) / window.releaseSeconds)
    }
  }
  return gain
}

export function semanticAudioGainAtSeconds(
  clip: RenderSemanticAudioClip,
  timelineSeconds: number,
  frameRate = 24,
): number {
  const clipStart = clip.startFrame / frameRate
  const duration = clip.durationFrames / frameRate
  const relative = timelineSeconds - clipStart
  if (relative < 0 || relative >= duration) return 0
  let gain = clip.linearGain
  if (clip.fadeInSeconds > 0 && relative < clip.fadeInSeconds) {
    gain *= Math.max(0, relative / clip.fadeInSeconds)
  }
  const fadeOutStart = duration - clip.fadeOutSeconds
  if (clip.fadeOutSeconds > 0 && relative >= fadeOutStart) {
    gain *= Math.max(0, (duration - relative) / clip.fadeOutSeconds)
  }
  return gain * semanticAudioDuckingGainAtSeconds(clip, timelineSeconds, frameRate)
}

async function mixAudio(
  plan: RenderSemanticPlan,
  assets: ReadonlyMap<string, VerifiedAsset>,
  mediabunny: Mediabunny,
  signal?: AbortSignal,
  onProgress?: (progress: BrowserQuickExportProgress) => void,
): Promise<AudioBuffer | null> {
  if (plan.audioClips.length === 0) return null
  const decoded = new Map<string, DecodedAudio>()
  const assetIds = [...new Set(plan.audioClips.map((clip) => clip.asset.assetId))]
  for (const [index, assetId] of assetIds.entries()) {
    checkAbort(signal)
    const asset = assets.get(assetId)
    if (!asset) throw new BrowserQuickExportError('INVALID_MANIFEST', `缺少音频资产 ${assetId}`)
    decoded.set(assetId, await decodeAudio(mediabunny, assetId, asset.blob))
    onProgress?.({
      phase: 'audio',
      progress: 0.18 + 0.12 * ((index + 1) / assetIds.length),
    })
  }
  const outputLength = Math.ceil((plan.totalFrames / plan.frameRate) * QUICK_EXPORT_SAMPLE_RATE)
  const context = new OfflineAudioContext(
    QUICK_EXPORT_CHANNELS,
    outputLength,
    QUICK_EXPORT_SAMPLE_RATE,
  )
  const output = context.createBuffer(
    QUICK_EXPORT_CHANNELS,
    outputLength,
    QUICK_EXPORT_SAMPLE_RATE,
  )
  for (const clip of plan.audioClips) {
    checkAbort(signal)
    const source = decoded.get(clip.asset.assetId)
    if (!source) throw new BrowserQuickExportError('AUDIO_DECODE_FAILED', `音频 ${clip.id} 未解码`)
    const outputStart = Math.round((clip.startFrame / plan.frameRate) * QUICK_EXPORT_SAMPLE_RATE)
    const outputCount = Math.round((clip.durationFrames / plan.frameRate) * QUICK_EXPORT_SAMPLE_RATE)
    const sourceStartSeconds = clip.sourceTrim.startFrame / plan.frameRate
    for (let channel = 0; channel < QUICK_EXPORT_CHANNELS; channel += 1) {
      const target = output.getChannelData(channel)
      const sourceData = source.channels[Math.min(channel, source.channels.length - 1)]!
      for (let offset = 0; offset < outputCount; offset += 1) {
        const outputIndex = outputStart + offset
        if (outputIndex >= outputLength) break
        const localSeconds = offset / QUICK_EXPORT_SAMPLE_RATE
        const sourceIndex = (sourceStartSeconds + localSeconds) * source.sampleRate
        const lower = Math.floor(sourceIndex)
        if (lower >= sourceData.length) break
        const upper = Math.min(sourceData.length - 1, lower + 1)
        const fraction = sourceIndex - lower
        const sample = sourceData[lower]! * (1 - fraction) + sourceData[upper]! * fraction
        const timelineSeconds = clip.startFrame / plan.frameRate + localSeconds
        target[outputIndex] += sample * semanticAudioGainAtSeconds(
          clip,
          timelineSeconds,
          plan.frameRate,
        )
      }
    }
  }
  for (let channel = 0; channel < output.numberOfChannels; channel += 1) {
    const samples = output.getChannelData(channel)
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.max(-1, Math.min(1, samples[index]!))
    }
  }
  return output
}

export interface FittedRect {
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
  targetX: number
  targetY: number
  targetWidth: number
  targetHeight: number
}

export function fittedMediaRect({
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight,
  fit,
}: {
  sourceWidth: number
  sourceHeight: number
  targetWidth: number
  targetHeight: number
  fit: RenderSemanticFit
}): FittedRect {
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every((value) => (
    Number.isFinite(value) && value > 0
  ))) {
    throw new BrowserQuickExportError('MEDIA_DECODE_FAILED', '媒体或画布尺寸无效')
  }
  const sourceRatio = sourceWidth / sourceHeight
  const targetRatio = targetWidth / targetHeight
  if (fit === 'contain') {
    const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight)
    const width = sourceWidth * scale
    const height = sourceHeight * scale
    return {
      sourceX: 0,
      sourceY: 0,
      sourceWidth,
      sourceHeight,
      targetX: (targetWidth - width) / 2,
      targetY: (targetHeight - height) / 2,
      targetWidth: width,
      targetHeight: height,
    }
  }
  if (sourceRatio > targetRatio) {
    const width = sourceHeight * targetRatio
    return {
      sourceX: (sourceWidth - width) / 2,
      sourceY: 0,
      sourceWidth: width,
      sourceHeight,
      targetX: 0,
      targetY: 0,
      targetWidth,
      targetHeight,
    }
  }
  const height = sourceWidth / targetRatio
  return {
    sourceX: 0,
    sourceY: (sourceHeight - height) / 2,
    sourceWidth,
    sourceHeight: height,
    targetX: 0,
    targetY: 0,
    targetWidth,
    targetHeight,
  }
}

function drawMedia(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  fit: RenderSemanticFit,
): void {
  const rect = fittedMediaRect({
    sourceWidth,
    sourceHeight,
    targetWidth: context.canvas.width,
    targetHeight: context.canvas.height,
    fit,
  })
  context.drawImage(
    source,
    rect.sourceX,
    rect.sourceY,
    rect.sourceWidth,
    rect.sourceHeight,
    rect.targetX,
    rect.targetY,
    rect.targetWidth,
    rect.targetHeight,
  )
}

/** Apply the exact hard-edge RSP mask before drawing the fitted media. */
export function clipCanvasToRenderSemanticShapeMask(
  context: CanvasRenderingContext2D,
  clip: Pick<RenderSemanticVisualClip, 'shapeMask'>,
): void {
  if (!clip.shapeMask) return
  const inverted = 'inverted' in clip.shapeMask && clip.shapeMask.inverted === true
  const geometry = renderSemanticVisualShapeMaskGeometry(
    clip.shapeMask,
    context.canvas.width,
    context.canvas.height,
  )
  context.beginPath()
  if (inverted) {
    context.rect(0, 0, context.canvas.width, context.canvas.height)
  }
  if (clip.shapeMask.type === 'ellipse') {
    context.ellipse(
      geometry.centerX,
      geometry.centerY,
      geometry.width / 2,
      geometry.height / 2,
      0,
      0,
      Math.PI * 2,
    )
  } else {
    context.rect(
      geometry.centerX - geometry.width / 2,
      geometry.centerY - geometry.height / 2,
      geometry.width,
      geometry.height,
    )
  }
  if (inverted) context.clip('evenodd')
  else context.clip()
}

/**
 * Apply the audited centre-anchored still-image scale after the fixed
 * canvas-space mask has been clipped. Canvas stores the clipping region in
 * device space, so this transform moves the image without scaling the mask.
 */
export function applyCanvasRenderSemanticUniformScale(
  context: CanvasRenderingContext2D,
  clip: RenderSemanticVisualClip,
  frame: number,
): number {
  const scale = renderSemanticVisualScaleAtFrame(clip, frame)
  if (scale === 1) return scale
  const centerX = context.canvas.width / 2
  const centerY = context.canvas.height / 2
  context.translate(centerX, centerY)
  context.scale(scale, scale)
  context.translate(-centerX, -centerY)
  return scale
}

function wrapSubtitle(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let current = ''
    for (const character of Array.from(paragraph)) {
      const candidate = current + character
      if (current && context.measureText(candidate).width > maxWidth) {
        lines.push(current)
        current = character.trimStart()
      } else {
        current = candidate
      }
    }
    if (current || paragraph === '') lines.push(current)
  }
  return lines.slice(0, 4)
}

function drawSubtitle(
  context: CanvasRenderingContext2D,
  cue: RenderSemanticSubtitleCue,
): void {
  const fontSize = Math.max(24, Math.round(context.canvas.height * 0.045))
  context.save()
  context.font = `700 ${fontSize}px "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.lineJoin = 'round'
  context.strokeStyle = '#000'
  context.fillStyle = '#fff'
  context.lineWidth = Math.max(3, fontSize * 0.12)
  const lines = wrapSubtitle(context, cue.text, context.canvas.width * 0.88)
  const lineHeight = fontSize * 1.3
  const centerY = context.canvas.height * 0.88 - ((lines.length - 1) * lineHeight) / 2
  lines.forEach((line, index) => {
    const y = centerY + index * lineHeight
    context.strokeText(line, context.canvas.width / 2, y)
    context.fillText(line, context.canvas.width / 2, y)
  })
  context.restore()
}

function activeAtFrame<T extends { startFrame: number; endFrameExclusive: number }>(
  values: readonly T[],
  frame: number,
): T | null {
  return values.find((value) => value.startFrame <= frame && frame < value.endFrameExclusive) ?? null
}

function roundedSemanticGain(value: number): number {
  const rounded = Number(value.toFixed(6))
  return Object.is(rounded, -0) ? 0 : rounded
}

/**
 * Browser-observed samples at every semantic transition. Unlike the canonical
 * signature this deliberately goes through the exact clip selection and audio
 * gain helpers used by the Canvas/WebCodecs quick-export loop. Keeping this
 * pure makes it possible to compare one pinned plan with the server FFmpeg
 * request without requiring pixel-identical encoders.
 */
export function browserQuickExportBoundarySignature(plan: RenderSemanticPlan): string {
  const canonicalSamples = JSON.parse(renderSemanticPlanBoundarySignature(plan)) as Array<{
    frame: number
  }>
  return JSON.stringify(canonicalSamples.map(({ frame }) => {
    const visual = activeAtFrame(plan.visualClips, frame)
    const subtitle = activeAtFrame(plan.subtitleCues, frame)
    const timelineSeconds = frame / plan.frameRate
    return {
      frame,
      visual: visual ? [{
        id: visual.id,
        asset: `${visual.asset.assetId}@${visual.asset.version}:${visual.asset.checksum}`,
        fit: visual.fit,
        ...(visual.opacityFade
          ? { opacity: renderSemanticVisualOpacityAtFrame(visual, frame) }
          : {}),
        ...(visual.uniformScaleMotion
          ? { scale: renderSemanticVisualScaleAtFrame(visual, frame) }
          : {}),
        sourceFrame: visual.sourceTrim === null
          ? null
          : visual.sourceTrim.startFrame + frame - visual.startFrame,
      }] : [],
      audio: plan.audioClips
        .filter((clip) => clip.startFrame <= frame && frame < clip.endFrameExclusive)
        .map((clip) => {
          const duckingGain = semanticAudioDuckingGainAtSeconds(
            clip,
            timelineSeconds,
            plan.frameRate,
          )
          return {
            id: clip.id,
            asset: `${clip.asset.assetId}@${clip.asset.version}:${clip.asset.checksum}`,
            role: clip.role,
            sourceFrame: clip.sourceTrim.startFrame + frame - clip.startFrame,
            effectiveLinearGain: roundedSemanticGain(
              semanticAudioGainAtSeconds(clip, timelineSeconds, plan.frameRate),
            ),
            ducked: duckingGain < 1 - 1e-9,
          }
        }),
      subtitles: subtitle ? [{ id: subtitle.id, text: subtitle.text }] : [],
    }
  }))
}

/**
 * Render a review MP4 entirely in the browser. This is intentionally narrower
 * than formal FFmpeg export and never falls back to another codec or timeline.
 */
export async function exportRenderSemanticPlanToMp4({
  plan,
  manifest,
  signal,
  onProgress,
}: {
  plan: RenderSemanticPlan
  manifest: TimelineMediaManifest
  signal?: AbortSignal
  onProgress?: (progress: BrowserQuickExportProgress) => void
}): Promise<Blob> {
  const support = await probeBrowserQuickExport(plan)
  if (!support.supported) {
    throw new BrowserQuickExportError(
      plan.totalFrames > MAX_QUICK_EXPORT_FRAMES ? 'TOO_LONG' : 'UNSUPPORTED_BROWSER',
      support.reason ?? '当前浏览器不支持快导',
    )
  }
  checkAbort(signal)
  const mediabunny = await import('mediabunny')
  const assets = await fetchVerifiedAssets({ plan, manifest, signal, onProgress })
  const mixedAudio = await mixAudio(plan, assets, mediabunny, signal, onProgress)
  checkAbort(signal)

  const { width, height } = quickExportDimensions(plan.aspectRatio)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new BrowserQuickExportError('UNSUPPORTED_BROWSER', '无法创建 2D Canvas')

  const imageBitmaps = new Map<string, ImageBitmap>()
  for (const clip of plan.visualClips.filter((item) => item.mediaType === 'image')) {
    if (imageBitmaps.has(clip.asset.assetId)) continue
    const asset = assets.get(clip.asset.assetId)
    if (!asset) throw new BrowserQuickExportError('INVALID_MANIFEST', `缺少图片资产 ${clip.asset.assetId}`)
    try {
      imageBitmaps.set(clip.asset.assetId, await createImageBitmap(asset.blob))
    } catch (cause) {
      throw new BrowserQuickExportError(
        'MEDIA_DECODE_FAILED',
        `图片资产 ${clip.asset.assetId} 无法解码`,
        { cause },
      )
    }
  }

  const target = new mediabunny.BufferTarget()
  const output = new mediabunny.Output({
    format: new mediabunny.Mp4OutputFormat(),
    target,
  })
  const videoSource = new mediabunny.CanvasSource(canvas, {
    codec: 'avc',
    bitrate: mediabunny.QUALITY_HIGH,
    bitrateMode: 'variable',
    latencyMode: 'quality',
    keyFrameInterval: 2,
  })
  output.addVideoTrack(videoSource, {
    frameRate: plan.frameRate,
    maximumPacketCount: plan.totalFrames,
  })
  let audioSource: import('mediabunny').AudioBufferSource | null = null
  if (mixedAudio) {
    audioSource = new mediabunny.AudioBufferSource({ codec: 'aac', bitrate: 192_000 })
    output.addAudioTrack(audioSource)
  }
  const videoCache = new PinnedVideoFrameCache(mediabunny)
  let started = false
  try {
    await output.start()
    started = true
    if (audioSource && mixedAudio) {
      await audioSource.add(mixedAudio)
      audioSource.close()
    }
    for (let frame = 0; frame < plan.totalFrames; frame += 1) {
      checkAbort(signal)
      context.fillStyle = '#000'
      context.fillRect(0, 0, width, height)
      const visual = activeAtFrame(plan.visualClips, frame)
      if (!visual) {
        throw new BrowserQuickExportError('EXPORT_FAILED', `第 ${frame} 帧没有画面片段`)
      }
      context.save()
      try {
        context.globalAlpha = renderSemanticVisualOpacityAtFrame(visual, frame)
        clipCanvasToRenderSemanticShapeMask(context, visual)
        applyCanvasRenderSemanticUniformScale(context, visual, frame)
        if (visual.mediaType === 'image') {
          const bitmap = imageBitmaps.get(visual.asset.assetId)
          if (!bitmap) throw new BrowserQuickExportError('MEDIA_DECODE_FAILED', `图片 ${visual.id} 未解码`)
          drawMedia(context, bitmap, bitmap.width, bitmap.height, visual.fit)
        } else {
          const asset = assets.get(visual.asset.assetId)
          if (!asset || !visual.sourceTrim) {
            throw new BrowserQuickExportError('INVALID_MANIFEST', `视频 ${visual.id} 缺少源裁剪`)
          }
          const sourceFrame = visual.sourceTrim.startFrame + frame - visual.startFrame
          const decoded = await videoCache.getFrameAt(
            visual.asset.assetId,
            asset.blob,
            sourceFrame / plan.frameRate,
          )
          if (!decoded) {
            throw new BrowserQuickExportError('MEDIA_DECODE_FAILED', `视频 ${visual.id} 在源帧 ${sourceFrame} 解码失败`)
          }
          drawMedia(
            context,
            decoded.canvas,
            decoded.canvas.width,
            decoded.canvas.height,
            visual.fit,
          )
        }
      } finally {
        context.restore()
      }
      const subtitle = activeAtFrame(plan.subtitleCues, frame)
      if (subtitle) drawSubtitle(context, subtitle)
      await videoSource.add(frame / plan.frameRate, 1 / plan.frameRate, {
        keyFrame: frame % (plan.frameRate * 2) === 0,
      })
      onProgress?.({
        phase: 'frames',
        progress: 0.3 + 0.68 * ((frame + 1) / plan.totalFrames),
      })
    }
    checkAbort(signal)
    videoSource.close()
    onProgress?.({ phase: 'finalize', progress: 0.99 })
    await output.finalize()
    if (!target.buffer) throw new BrowserQuickExportError('EXPORT_FAILED', 'Mediabunny 未生成 MP4 字节')
    onProgress?.({ phase: 'finalize', progress: 1 })
    return new Blob([target.buffer], { type: 'video/mp4' })
  } catch (cause) {
    if (started && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined)
    }
    if (signal?.aborted) throw abortError()
    if (cause instanceof BrowserQuickExportError) throw cause
    throw new BrowserQuickExportError(
      'EXPORT_FAILED',
      cause instanceof Error ? cause.message : '浏览器快导失败',
      { cause },
    )
  } finally {
    videoCache.clear()
    imageBitmaps.forEach((bitmap) => bitmap.close())
  }
}
