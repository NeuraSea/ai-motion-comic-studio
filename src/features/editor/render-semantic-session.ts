import {
  compileRenderSemanticPlan,
  parseCanonicalTimelineDocument,
  projectTimelineMediaParticipation,
  shortVideoFillDescriptor,
  type CanonicalTimelineDocument,
  type CanonicalTimelineElement,
  type EditorSceneTracks,
  type RenderSemanticAssetBinding,
  type RenderSemanticAudioRole,
  type RenderSemanticPlan,
} from '@manju/opencut-editor'
import type {
  EpisodeSummary,
  MediaAsset,
  TimelineDocumentSnapshot,
} from '../../lib'
import {
  resolveTimelineMediaFromAssets,
  type TimelineMediaManifest,
} from './manju-media-resolver'
import { openCutTimelineDocument, parseOpenCutTracks } from './timeline-codec'
import { assertPinnedTimeline } from './timeline-revision-handoff'

const FRAME_RATE = 24
const MAX_SOURCE_DURATION_FRAMES = FRAME_RATE * 86_400
const SHA256 = /^[0-9a-f]{64}$/i

export class RenderSemanticSessionError extends Error {
  constructor(
    readonly code:
      | 'INVALID_ASPECT_RATIO'
      | 'INVALID_ASSET'
      | 'INVALID_TIMELINE'
      | 'MEDIA_UNRESOLVED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RenderSemanticSessionError'
  }
}

export interface PinnedRenderSemanticSession {
  tracks: EditorSceneTracks
  media: TimelineMediaManifest
  plan: RenderSemanticPlan
  repairs: readonly RenderSemanticRepair[]
}

export interface RenderSemanticRepair {
  elementId: string
  assetId: string
  code: 'MANAGED_AUDIO_SOURCE_OVERRUN_CLAMPED'
  previousDurationFrames: number
  repairedDurationFrames: number
}

export interface LiveRenderSemanticSessionInput {
  projectId: string
  episodeId: string
  sourceRevisionId: string | null
  aspectRatio: string
  timelineDocumentId: string
  timelineRevisionId: string
  tracks: EditorSceneTracks
  baseDocument?: Record<string, unknown>
  assets: readonly MediaAsset[]
}

interface ActiveMediaReference {
  element: CanonicalTimelineElement & { mediaId: string }
  expected: 'image' | 'video' | 'audio'
}

function activeMedia(document: CanonicalTimelineDocument): ActiveMediaReference[] {
  const references: ActiveMediaReference[] = []
  for (const track of [
    ...document.tracks.overlay,
    document.tracks.main,
    ...document.tracks.audio,
  ]) {
    for (const element of track.elements) {
      const participation = projectTimelineMediaParticipation(track, element)
      if ((element.type === 'image' || element.type === 'video') && participation.visual) {
        references.push({ element, expected: element.type })
      } else if (
        element.type === 'audio'
        && element.sourceType === 'upload'
        && participation.timelineAudio
      ) {
        references.push({ element, expected: 'audio' })
      }
    }
  }
  return references
}

function sourceDurationFrames(asset: MediaAsset, expected: 'video' | 'audio'): number {
  const frames = typeof asset.durationSeconds === 'number' && Number.isFinite(asset.durationSeconds)
    ? expected === 'audio'
      ? Math.ceil(asset.durationSeconds * FRAME_RATE)
      : Math.round(asset.durationSeconds * FRAME_RATE)
    : Number.NaN
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > MAX_SOURCE_DURATION_FRAMES) {
    throw new RenderSemanticSessionError(
      'INVALID_ASSET',
      `${expected === 'audio' ? '音频' : '视频'}资产 ${asset.id} 缺少可信源时长`,
    )
  }
  return frames
}

function immutableAudioRole(asset: MediaAsset): RenderSemanticAudioRole | undefined {
  if (asset.kind === 'speech' || asset.kind === 'dialogue.speech' || asset.kind.endsWith('.speech')) {
    return 'dialogue'
  }
  if (asset.kind === 'bgm') return 'bgm'
  if (asset.kind === 'sfx' || asset.kind === 'shot.video') return 'sfx'
  return undefined
}

function validateAsset(
  asset: MediaAsset,
  expected: ActiveMediaReference['expected'],
): RenderSemanticAssetBinding {
  if (!Number.isSafeInteger(asset.version) || asset.version < 1) {
    throw new RenderSemanticSessionError('INVALID_ASSET', `资产 ${asset.id} 缺少有效版本号`)
  }
  if (typeof asset.checksum !== 'string' || !SHA256.test(asset.checksum)) {
    throw new RenderSemanticSessionError('INVALID_ASSET', `资产 ${asset.id} 缺少 SHA-256 校验和`)
  }
  const mimeType = asset.mimeType?.trim().toLowerCase() ?? ''
  const supported = expected === 'image'
    ? mimeType.startsWith('image/')
    : expected === 'video'
      ? mimeType === 'video/mp4' || mimeType === 'video/webm'
      : mimeType === 'audio/mpeg' || mimeType === 'audio/wav'
  if (!supported) {
    throw new RenderSemanticSessionError(
      'INVALID_ASSET',
      `资产 ${asset.id} 不是受支持的 ${expected} 媒体`,
    )
  }
  const duration = expected === 'image'
    ? undefined
    : sourceDurationFrames(asset, expected)
  return {
    assetId: asset.id,
    version: asset.version,
    checksum: asset.checksum.toLowerCase(),
    mediaType: expected,
    ...(duration === undefined ? {} : { sourceDurationFrames: duration }),
    ...(expected === 'image' ? {} : { audioRole: immutableAudioRole(asset) }),
  }
}

function frameForTicks(value: number, ticksPerSecond: number, label: string): number {
  const numerator = value * FRAME_RATE
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(numerator)
    || numerator % ticksPerSecond !== 0) {
    throw new RenderSemanticSessionError(
      'INVALID_TIMELINE',
      `${label} 必须精确对齐 24fps 帧边界`,
    )
  }
  return numerator / ticksPerSecond
}

/**
 * Complete redundant OpenCut source-duration fields on a parsed clone. The
 * authoritative snapshot is never mutated: source duration comes only from
 * immutable Asset metadata, matching the formal export adapter.
 */
function completeSourceTrims(
  document: CanonicalTimelineDocument,
  bindings: ReadonlyMap<string, RenderSemanticAssetBinding>,
): RenderSemanticRepair[] {
  const ticksPerFrame = document.ticksPerSecond / FRAME_RATE
  if (!Number.isSafeInteger(ticksPerFrame)) {
    throw new RenderSemanticSessionError('INVALID_TIMELINE', '时间线不能精确表示 24fps')
  }
  const repairs: RenderSemanticRepair[] = []
  for (const { element, expected } of activeMedia(document)) {
    if (expected === 'image') continue
    const binding = bindings.get(element.mediaId)
    const durationFrames = binding?.sourceDurationFrames
    if (!binding || durationFrames === undefined) {
      throw new RenderSemanticSessionError('INVALID_ASSET', `资产 ${element.mediaId} 缺少源时长绑定`)
    }
    const trimStartFrames = frameForTicks(
      element.trimStart,
      document.ticksPerSecond,
      `${element.id}.trimStart`,
    )
    const shortVideoFill = shortVideoFillDescriptor(element, `timeline element ${element.id}`)
    let clipFrames = shortVideoFill
      ? frameForTicks(
          shortVideoFill.sourceDurationTicks,
          document.ticksPerSecond,
          `${element.id}.manju.shortVideoFill.sourceDurationTicks`,
        )
      : frameForTicks(
          element.duration,
          document.ticksPerSecond,
          `${element.id}.duration`,
        )
    let trimEndFrames = durationFrames - trimStartFrames - clipFrames
    const managedAssetId = typeof element.params?.storyManagedAssetId === 'string'
      ? element.params.storyManagedAssetId
      : null
    const safelyRepairableManagedAudio = expected === 'audio'
      && managedAssetId === element.mediaId
      && !shortVideoFill
      && trimStartFrames < durationFrames
    if (trimEndFrames < 0 && safelyRepairableManagedAudio) {
      const previousDurationFrames = clipFrames
      clipFrames = durationFrames - trimStartFrames
      element.duration = clipFrames * ticksPerFrame
      element.trimEnd = 0
      element.sourceDuration = durationFrames * ticksPerFrame
      trimEndFrames = 0
      repairs.push({
        elementId: element.id,
        assetId: element.mediaId,
        code: 'MANAGED_AUDIO_SOURCE_OVERRUN_CLAMPED',
        previousDurationFrames,
        repairedDurationFrames: clipFrames,
      })
    }
    if (trimEndFrames < 0) {
      throw new RenderSemanticSessionError(
        'INVALID_TIMELINE',
        `片段 ${element.id} 的裁剪范围超出资产 ${element.mediaId} 源时长`,
      )
    }
    element.trimEnd = trimEndFrames * ticksPerFrame
    if (element.sourceDuration === undefined) {
      element.sourceDuration = durationFrames * ticksPerFrame
    }
  }
  return repairs
}

function semanticBindings(
  document: CanonicalTimelineDocument,
  assets: readonly MediaAsset[],
): Map<string, RenderSemanticAssetBinding> {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
  const bindings = new Map<string, RenderSemanticAssetBinding>()
  for (const reference of activeMedia(document)) {
    const asset = assetsById.get(reference.element.mediaId)
    if (!asset) {
      throw new RenderSemanticSessionError(
        'MEDIA_UNRESOLVED',
        `时间线资产 ${reference.element.mediaId} 不存在`,
      )
    }
    const binding = validateAsset(asset, reference.expected)
    const previous = bindings.get(asset.id)
    if (previous && (
      previous.mediaType !== binding.mediaType
      || previous.sourceDurationFrames !== binding.sourceDurationFrames
      || previous.audioRole !== binding.audioRole
    )) {
      throw new RenderSemanticSessionError(
        'INVALID_TIMELINE',
        `资产 ${asset.id} 在同一时间线中具有冲突语义`,
      )
    }
    bindings.set(asset.id, binding)
    const fill = shortVideoFillDescriptor(reference.element, `timeline element ${reference.element.id}`)
    if (fill) {
      if (reference.expected !== 'video') {
        throw new RenderSemanticSessionError(
          'INVALID_TIMELINE',
          `短视频填充绑定只能用于视频片段 ${reference.element.id}`,
        )
      }
      const fallback = assetsById.get(fill.fallbackAssetId)
      if (!fallback) {
        throw new RenderSemanticSessionError(
          'MEDIA_UNRESOLVED',
          `短视频填充资产 ${fill.fallbackAssetId} 不存在`,
        )
      }
      const fallbackBinding = validateAsset(fallback, 'image')
      const previousFallback = bindings.get(fallback.id)
      if (previousFallback && previousFallback.mediaType !== fallbackBinding.mediaType) {
        throw new RenderSemanticSessionError(
          'INVALID_TIMELINE',
          `资产 ${fallback.id} 在同一时间线中具有冲突语义`,
        )
      }
      bindings.set(fallback.id, fallbackBinding)
    }
  }
  return bindings
}

function aspectRatio(value: string): '16:9' | '9:16' | '1:1' {
  if (value === '16:9' || value === '9:16' || value === '1:1') return value
  throw new RenderSemanticSessionError('INVALID_ASPECT_RATIO', `不支持画幅 ${value}`)
}

export function createPinnedRenderSemanticSession({
  projectId,
  episode,
  timelineSnapshot,
  assets,
}: {
  projectId: string
  episode: EpisodeSummary
  timelineSnapshot: TimelineDocumentSnapshot
  assets: readonly MediaAsset[]
}): PinnedRenderSemanticSession {
  const pinned = assertPinnedTimeline(timelineSnapshot, {
    projectId,
    episodeId: episode.id,
    sourceRevisionId: episode.sourceRevisionId,
  })
  const tracks = parseOpenCutTracks(pinned.document)
  if (!tracks) {
    throw new RenderSemanticSessionError('INVALID_TIMELINE', '时间线文档不符合 OpenCut 结构约束')
  }
  const media = resolveTimelineMediaFromAssets({
    projectId,
    episodeId: episode.id,
    tracks,
    assets,
  })
  if (media.issues.length > 0) {
    throw new RenderSemanticSessionError(
      'MEDIA_UNRESOLVED',
      `${media.issues.length} 个时间线媒体未通过安全解析：${media.issues[0]!.message}`,
    )
  }

  const document = parseCanonicalTimelineDocument(pinned.document)
  const bindings = semanticBindings(document, assets)
  const repairs = completeSourceTrims(document, bindings)
  const storyRevisionId = pinned.revision.sourceRevisionId
  if (!storyRevisionId) {
    throw new RenderSemanticSessionError('INVALID_TIMELINE', '时间线修订没有固化剧本修订')
  }
  const plan = compileRenderSemanticPlan({
    timelineDocument: document,
    timelineDocumentId: pinned.timelineDocument.id,
    timelineRevisionId: pinned.revision.id,
    storyRevisionId,
    aspectRatio: aspectRatio(episode.aspectRatio),
    assets: [...bindings.values()],
  })
  return { tracks, media, plan, repairs }
}

/**
 * Compile the mounted OpenCut command state for the in-editor program monitor.
 * This intentionally shares the exact resolver and semantic compiler used by
 * pinned preview/export, but does not pretend that unsaved editor state is an
 * immutable timeline revision.
 */
export function createLiveRenderSemanticSession({
  projectId,
  episodeId,
  sourceRevisionId,
  aspectRatio: rawAspectRatio,
  timelineDocumentId,
  timelineRevisionId,
  tracks,
  baseDocument = {},
  assets,
}: LiveRenderSemanticSessionInput): PinnedRenderSemanticSession {
  if (!sourceRevisionId) {
    throw new RenderSemanticSessionError(
      'INVALID_TIMELINE',
      '当前时间线尚未绑定剧本修订，不能打开节目监看器',
    )
  }
  if (!timelineDocumentId.trim() || !timelineRevisionId.trim()) {
    throw new RenderSemanticSessionError(
      'INVALID_TIMELINE',
      '当前时间线缺少可核验的文档或修订标识',
    )
  }
  const liveTracks = structuredClone(tracks)
  const media = resolveTimelineMediaFromAssets({
    projectId,
    episodeId,
    tracks: liveTracks,
    assets,
  })
  if (media.issues.length > 0) {
    throw new RenderSemanticSessionError(
      'MEDIA_UNRESOLVED',
      `${media.issues.length} 个时间线媒体未通过安全解析：${media.issues[0]!.message}`,
    )
  }

  const document = parseCanonicalTimelineDocument(
    openCutTimelineDocument(liveTracks, baseDocument),
  )
  const bindings = semanticBindings(document, assets)
  const repairs = completeSourceTrims(document, bindings)
  const plan = compileRenderSemanticPlan({
    timelineDocument: document,
    timelineDocumentId,
    timelineRevisionId,
    storyRevisionId: sourceRevisionId,
    aspectRatio: aspectRatio(rawAspectRatio),
    assets: [...bindings.values()],
  })
  return { tracks: liveTracks, media, plan, repairs }
}
