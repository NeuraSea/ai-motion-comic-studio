import {
  classifyTimelineAssetScope,
  projectTimelineMediaParticipation,
  shortVideoFillClipId,
  shortVideoFillDescriptor,
  type CanonicalTimelineElement,
  type EditorSceneTracks,
  type EditorTimelineElement,
} from '@manju/opencut-editor'
import { api, type MediaAsset } from '../../lib'

export type PreviewMediaKind = 'image' | 'video' | 'audio'

export type MediaResolutionIssueCode =
  | 'ASSET_ID_MISSING'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_PROJECT_MISMATCH'
  | 'ASSET_EPISODE_MISMATCH'
  | 'ASSET_NOT_READY'
  | 'ASSET_MIME_MISSING'
  | 'ASSET_MIME_MISMATCH'

export interface TimelineMediaBinding {
  trackId: string
  elementId: string
  elementType: PreviewMediaKind
  assetId: string
  /** Immutable repository identity checked again before browser export. */
  assetVersion: number
  assetChecksum: string | null
  url: string
  mimeType: string
  startTime: number
  duration: number
  trimStart: number
  trimEnd: number
  retimeRate: number
  width: number | null
  height: number | null
  sourceDurationSeconds: number | null
  /** True only when the visible video element explicitly enables source audio. */
  sourceAudioEnabled: boolean
}

export interface MediaResolutionIssue {
  code: MediaResolutionIssueCode
  trackId: string
  elementId: string
  elementType: PreviewMediaKind
  assetId: string | null
  message: string
}

export interface TimelineMediaManifest {
  bindings: TimelineMediaBinding[]
  issues: MediaResolutionIssue[]
}

export interface ManjuMediaResolverTransport {
  listAssets(
    projectId: string,
    episodeId: string,
    signal?: AbortSignal,
  ): Promise<MediaAsset[]>
}

const defaultTransport: ManjuMediaResolverTransport = {
  listAssets: (projectId, episodeId, signal) => api.listAssets(projectId, {
    episodeId,
    includeProjectAssets: true,
    signal,
  }),
}

function mediaElements(tracks: EditorSceneTracks): Array<{
  trackId: string
  element: EditorTimelineElement & { type: PreviewMediaKind }
  sourceAudioEnabled: boolean
}> {
  const isPreviewMediaElement = (
    element: EditorTimelineElement,
  ): element is EditorTimelineElement & { type: PreviewMediaKind } => (
    element.type === 'image' || element.type === 'video' || element.type === 'audio'
  )
  return [...tracks.overlay, tracks.main, ...tracks.audio].flatMap((track) => (
    track.elements.flatMap((element) => {
      if (!isPreviewMediaElement(element)) return []
      const participation = projectTimelineMediaParticipation(track, element)
      if (!participation.visual && !participation.timelineAudio) return []
      return [{
        trackId: track.id,
        element,
        sourceAudioEnabled: participation.sourceAudio,
      }]
    })
  ))
}

function issueMessage(code: MediaResolutionIssueCode): string {
  switch (code) {
    case 'ASSET_ID_MISSING': return '时间线片段未绑定已持久化媒体资产'
    case 'ASSET_NOT_FOUND': return '时间线引用的媒体资产不存在'
    case 'ASSET_PROJECT_MISMATCH': return '拒绝解析其他项目的媒体资产'
    case 'ASSET_EPISODE_MISMATCH': return '拒绝解析其他分集的媒体资产'
    case 'ASSET_NOT_READY': return '媒体资产尚未进入 ready 状态'
    case 'ASSET_MIME_MISSING': return '媒体资产缺少可信 MIME 类型'
    case 'ASSET_MIME_MISMATCH': return '媒体 MIME 与时间线元素类型不匹配'
  }
}

function canonicalAssetContentUrl(assetId: string): string {
  // Never render a provider URL or a URL returned inside the timeline. The
  // server-owned content route performs path containment and range handling.
  return `/api/v1/assets/${encodeURIComponent(assetId)}/content`
}

function expectedMimePrefix(kind: PreviewMediaKind): string {
  return `${kind}/`
}

export function resolveTimelineMediaFromAssets({
  tracks,
  assets,
  projectId,
  episodeId,
}: {
  tracks: EditorSceneTracks
  assets: readonly MediaAsset[]
  projectId: string
  episodeId: string
}): TimelineMediaManifest {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]))
  const bindings: TimelineMediaBinding[] = []
  const issues: MediaResolutionIssue[] = []

  for (const { trackId, element, sourceAudioEnabled } of mediaElements(tracks)) {
    // Canonical OpenCut documents bind image/video/upload-audio through the
    // discriminated union's top-level mediaId. The params fallback exists only
    // for unsaved v1 editor state; an explicit library/upload discriminant may
    // never be replaced by Manju metadata.
    const rawAssetId = element.sourceType === 'library'
      ? undefined
      : typeof element.mediaId === 'string'
        ? element.mediaId
        : element.sourceType === undefined
          ? element.params?.assetId
          : undefined
    const canonicalMediaId = element.sourceType !== 'library'
      && typeof element.mediaId === 'string'
      && element.mediaId.trim().length > 0
    const assetId = typeof rawAssetId === 'string' && rawAssetId.trim()
      ? rawAssetId.trim()
      : null
    const addIssue = (code: MediaResolutionIssueCode) => issues.push({
      code,
      trackId,
      elementId: element.id,
      elementType: element.type,
      assetId,
      message: issueMessage(code),
    })

    if (!assetId) {
      addIssue('ASSET_ID_MISSING')
      continue
    }
    const asset = assetMap.get(assetId)
    if (!asset) {
      addIssue('ASSET_NOT_FOUND')
      continue
    }
    const assetScope = classifyTimelineAssetScope(
      asset,
      { projectId, episodeId },
      canonicalMediaId,
    )
    if (assetScope === 'project-mismatch') {
      addIssue('ASSET_PROJECT_MISMATCH')
      continue
    }
    if (assetScope === 'episode-mismatch') {
      addIssue('ASSET_EPISODE_MISMATCH')
      continue
    }
    if (asset.status !== 'ready') {
      addIssue('ASSET_NOT_READY')
      continue
    }
    const mimeType = asset.mimeType?.trim().toLowerCase() ?? ''
    if (!mimeType) {
      addIssue('ASSET_MIME_MISSING')
      continue
    }
    if (!mimeType.startsWith(expectedMimePrefix(element.type))) {
      addIssue('ASSET_MIME_MISMATCH')
      continue
    }

    bindings.push({
      trackId,
      elementId: element.id,
      elementType: element.type,
      assetId,
      assetVersion: asset.version,
      assetChecksum: asset.checksum,
      url: canonicalAssetContentUrl(assetId),
      mimeType,
      startTime: element.startTime,
      duration: element.duration,
      trimStart: element.trimStart ?? 0,
      trimEnd: element.trimEnd ?? 0,
      retimeRate: element.retime?.rate ?? 1,
      width: asset.width,
      height: asset.height,
      sourceDurationSeconds: asset.durationSeconds,
      sourceAudioEnabled,
    })

    if (element.type !== 'video') continue
    const fill = shortVideoFillDescriptor(
      element as CanonicalTimelineElement,
      `timeline element ${element.id}`,
    )
    if (!fill) continue
    const fallback = assetMap.get(fill.fallbackAssetId)
    const fillElementId = shortVideoFillClipId(element.id)
    const addFillIssue = (code: MediaResolutionIssueCode) => issues.push({
      code,
      trackId,
      elementId: fillElementId,
      elementType: 'image',
      assetId: fill.fallbackAssetId,
      message: issueMessage(code),
    })
    if (!fallback) {
      addFillIssue('ASSET_NOT_FOUND')
      continue
    }
    const fallbackScope = classifyTimelineAssetScope(
      fallback,
      { projectId, episodeId },
      true,
    )
    if (fallbackScope === 'project-mismatch') {
      addFillIssue('ASSET_PROJECT_MISMATCH')
      continue
    }
    if (fallbackScope === 'episode-mismatch') {
      addFillIssue('ASSET_EPISODE_MISMATCH')
      continue
    }
    if (fallback.status !== 'ready') {
      addFillIssue('ASSET_NOT_READY')
      continue
    }
    const fallbackMime = fallback.mimeType?.trim().toLowerCase() ?? ''
    if (!fallbackMime) {
      addFillIssue('ASSET_MIME_MISSING')
      continue
    }
    if (!fallbackMime.startsWith('image/')) {
      addFillIssue('ASSET_MIME_MISMATCH')
      continue
    }
    bindings.push({
      trackId,
      elementId: fillElementId,
      elementType: 'image',
      assetId: fallback.id,
      assetVersion: fallback.version,
      assetChecksum: fallback.checksum,
      url: canonicalAssetContentUrl(fallback.id),
      mimeType: fallbackMime,
      startTime: element.startTime + fill.sourceDurationTicks,
      duration: fill.targetDurationTicks - fill.sourceDurationTicks,
      trimStart: 0,
      trimEnd: 0,
      retimeRate: 1,
      width: fallback.width,
      height: fallback.height,
      sourceDurationSeconds: null,
      sourceAudioEnabled: false,
    })
  }

  return { bindings, issues }
}

/**
 * Resolve opaque timeline asset IDs through the authenticated Manju API.
 * This is deliberately a narrow port: no client file path, provider URL, or
 * timeline-supplied URL can cross into the preview media elements.
 */
export class ManjuMediaResolver {
  private readonly transport: ManjuMediaResolverTransport

  constructor(private readonly options: {
    projectId: string
    episodeId: string
    transport?: ManjuMediaResolverTransport
  }) {
    if (!options.projectId.trim() || !options.episodeId.trim()) {
      throw new TypeError('projectId and episodeId are required')
    }
    this.transport = options.transport ?? defaultTransport
  }

  async resolve(
    tracks: EditorSceneTracks,
    signal?: AbortSignal,
  ): Promise<TimelineMediaManifest> {
    const assets = await this.transport.listAssets(
      this.options.projectId,
      this.options.episodeId,
      signal,
    )
    return resolveTimelineMediaFromAssets({
      tracks,
      assets,
      projectId: this.options.projectId,
      episodeId: this.options.episodeId,
    })
  }
}
