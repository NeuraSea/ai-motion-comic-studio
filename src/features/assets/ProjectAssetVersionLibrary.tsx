import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  ImageIcon,
  Layers3,
  LoaderCircle,
  Music2,
  Pin,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'

import {
  ApiError,
  listAssetHandleVersions,
  listAssetHandles,
  switchAssetHandleCurrentVersion,
} from '../../lib/api'
import type {
  AssetHandle,
  AssetHandleVersion,
  AssetHandleVersionsResponse,
  AssetVersionSwitchResponse,
  MediaAsset,
} from '../../lib/api-types'
import './ProjectAssetVersionLibrary.css'

export interface ProjectAssetVersionLibraryClient {
  listAssetHandles: typeof listAssetHandles
  listAssetHandleVersions: typeof listAssetHandleVersions
  switchAssetHandleCurrentVersion: typeof switchAssetHandleCurrentVersion
}

export interface ProjectAssetVersionLibraryProps {
  projectId: string
  /** Optional Catalog episode scope. Null means every handle in the project. */
  episodeId?: string | null
  /** Project Catalog labels used to expose each immutable version's scope. */
  episodeLabelsById?: Readonly<Record<string, string>>
  /** Exact immutable versions currently known to be pinned by production. */
  pinnedAssetVersionIds: readonly string[]
  onChanged?: (result: AssetVersionSwitchResponse) => void | Promise<void>
  onError?: (message: string) => void
  /** Test/integration seam; production uses the real v1 API client by default. */
  client?: ProjectAssetVersionLibraryClient
}

const defaultClient: ProjectAssetVersionLibraryClient = {
  listAssetHandles,
  listAssetHandleVersions,
  switchAssetHandleCurrentVersion,
}

function mediaType(asset: MediaAsset): 'image' | 'video' | 'audio' | 'document' {
  const mimeType = asset.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'document'
}

function kindLabel(kind: string): string {
  if (kind === 'character-turnaround') return '角色三视图'
  if (kind === 'character-reference.front') return '角色正面参考'
  if (kind === 'character-reference.side') return '角色侧面参考'
  if (kind === 'character-reference.back') return '角色背面参考'
  if (kind === 'character.voice.preview') return '角色声线试听'
  if (kind === 'narrator.voice.preview') return '旁白声线试听'
  if (kind === 'shot.video') return '逐镜视频'
  if (kind === 'export.video') return '剧集成片'
  if (kind.includes('character')) return '角色图片'
  if (kind.includes('location')) return '场景图片'
  if (kind.includes('prop')) return '道具图片'
  if (kind.includes('storyboard')) return '分镜图片'
  if (kind.includes('speech') || kind.includes('voice') || kind === 'audio') return '语音音频'
  if (kind === 'bgm') return '背景音乐'
  if (kind === 'sfx') return '音效'
  if (kind.includes('video')) return '视频'
  if (kind.includes('script') || kind === 'story' || kind === 'text') return '脚本与文本'
  return kind
}

function sourceLabel(asset: MediaAsset): string {
  if (asset.source === 'upload') return '用户上传'
  if (asset.source === 'derived') return '本地派生'
  if (asset.providerId || asset.source === 'provider') return 'AIGC 生成'
  if (asset.source === 'renderer') return 'OpenCut 渲染'
  return asset.source || '项目素材'
}

function assetLabel(handle: AssetHandle): string {
  return handle.currentVersion?.originalFileName?.trim()
    || `${kindLabel(handle.kind)} · ${handle.assetId.slice(0, 8)}`
}

const BUSINESS_DOMAIN_ORDER: AssetHandle['businessBinding']['domain'][] = [
  'character',
  'location',
  'prop',
  'shot',
  'dialogue',
  'audio',
  'export',
  'document',
  'other',
  'archive',
]

const BUSINESS_DOMAIN_LABEL: Record<AssetHandle['businessBinding']['domain'], string> = {
  character: '角色资产',
  location: '场景资产',
  prop: '道具资产',
  shot: '镜头资产',
  dialogue: '台词与旁白',
  audio: '音乐与音效',
  export: '成片与导出',
  document: '脚本与文档',
  other: '未归类素材',
  archive: '已归档素材',
}

function dimensions(asset: MediaAsset): string | null {
  if (asset.width && asset.height) return `${asset.width} × ${asset.height}`
  if (asset.durationSeconds !== null) return `${asset.durationSeconds.toFixed(1)} 秒`
  return null
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function operationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `asset-default-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof ApiError && error.code === 'REQUEST_ABORTED'
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

function MediaThumbnail({ asset, large = false }: { asset: MediaAsset | null; large?: boolean }) {
  if (!asset) {
    return <span className="project-asset-version-empty-media"><Layers3 size={large ? 30 : 18} /></span>
  }
  const type = mediaType(asset)
  if (type === 'image') return <img src={asset.url} alt="" />
  if (type === 'video') {
    return large
      ? <video src={asset.url} controls preload="metadata">当前浏览器无法预览视频。</video>
      : <video src={asset.url} muted playsInline preload="metadata" aria-hidden="true" />
  }
  if (type === 'audio') {
    return large
      ? <span className="project-asset-version-audio-preview"><Music2 size={30} /><audio src={asset.url} controls preload="metadata">当前浏览器无法预览音频。</audio></span>
      : <span className="project-asset-version-media-icon"><Music2 size={20} /></span>
  }
  return <span className="project-asset-version-media-icon"><FileText size={large ? 30 : 20} /></span>
}

function VersionBadge({ children, tone }: { children: React.ReactNode; tone: 'default' | 'pinned' | 'immutable' }) {
  return <span className={`project-asset-version-badge ${tone}`}>{children}</span>
}

/**
 * Project-level digital asset library.
 *
 * A row is keyed by a stable `assetId`; opening it reads immutable versions.
 * Clicking a version only changes local preview state. The only write in this
 * component changes the library default pointer with If-Match and an
 * Idempotency-Key. Production pins are deliberately read-only here.
 */
export function ProjectAssetVersionLibrary({
  projectId,
  episodeId = null,
  episodeLabelsById = {},
  pinnedAssetVersionIds,
  onChanged,
  onError,
  client = defaultClient,
}: ProjectAssetVersionLibraryProps) {
  const scopeKey = `${projectId}\0${episodeId ?? ''}`
  const [handles, setHandles] = useState<AssetHandle[]>([])
  const [expandedAssetIds, setExpandedAssetIds] = useState<Set<string>>(() => new Set())
  const [versionsByAssetId, setVersionsByAssetId] = useState<Record<string, AssetHandleVersionsResponse>>({})
  const [selectedByAssetId, setSelectedByAssetId] = useState<Record<string, string>>({})
  const [loadingHandles, setLoadingHandles] = useState(true)
  const [loadingVersions, setLoadingVersions] = useState<Set<string>>(() => new Set())
  const [switchingKey, setSwitchingKey] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [libraryError, setLibraryError] = useState('')
  const mountedRef = useRef(true)
  const projectScopeRef = useRef(scopeKey)
  const versionRequestRef = useRef(new Map<string, symbol>())
  const idempotencyKeysRef = useRef(new Map<string, string>())
  const onErrorRef = useRef(onError)
  const onChangedRef = useRef(onChanged)
  onErrorRef.current = onError
  onChangedRef.current = onChanged
  projectScopeRef.current = scopeKey

  const pinnedVersions = useMemo(
    () => new Set(pinnedAssetVersionIds.filter((id) => id.trim())),
    [pinnedAssetVersionIds],
  )

  const reportError = useCallback((message: string) => {
    if (!mountedRef.current) return
    setLibraryError(message)
    onErrorRef.current?.(message)
  }, [])

  const loadHandles = useCallback(async (signal?: AbortSignal) => {
    if (!projectId.trim()) {
      reportError('缺少项目标识，无法读取数字资产库。')
      setLoadingHandles(false)
      return
    }
    setLoadingHandles(true)
    try {
      const result = await client.listAssetHandles(projectId, {
        ...(episodeId ? { episodeId } : {}),
        limit: 500,
        signal,
      })
      if (!mountedRef.current || signal?.aborted) return
      setHandles(result)
      setLibraryError('')
      setVersionsByAssetId((current) => {
        const liveHandles = new Map(result.map((handle) => [handle.assetId, handle]))
        const next: Record<string, AssetHandleVersionsResponse> = {}
        for (const [assetId, response] of Object.entries(current)) {
          const handle = liveHandles.get(assetId)
          if (handle) next[assetId] = { ...response, asset: handle }
        }
        return next
      })
    } catch (error) {
      if (!isAborted(error)) reportError(errorMessage(error, '项目数字资产库读取失败。'))
    } finally {
      if (mountedRef.current && !signal?.aborted) setLoadingHandles(false)
    }
  }, [client, episodeId, projectId, reportError])

  const loadVersions = useCallback(async (assetId: string) => {
    const requestId = Symbol(assetId)
    versionRequestRef.current.set(assetId, requestId)
    setLoadingVersions((current) => new Set(current).add(assetId))
    try {
      const result = await client.listAssetHandleVersions(projectId, assetId)
      if (!mountedRef.current || versionRequestRef.current.get(assetId) !== requestId) return null
      setVersionsByAssetId((current) => ({ ...current, [assetId]: result }))
      setHandles((current) => current.map((handle) => (
        handle.assetId === assetId ? result.asset : handle
      )))
      setSelectedByAssetId((current) => {
        const requested = current[assetId]
        const selection = requested && result.versions.some((version) => version.assetVersionId === requested)
          ? requested
          : result.asset.currentAssetVersionId ?? result.versions[0]?.assetVersionId
        if (!selection) return current
        return { ...current, [assetId]: selection }
      })
      setLibraryError('')
      return result
    } catch (error) {
      if (versionRequestRef.current.get(assetId) === requestId) {
        reportError(errorMessage(error, '素材版本列表读取失败。'))
      }
      return null
    } finally {
      if (mountedRef.current && versionRequestRef.current.get(assetId) === requestId) {
        setLoadingVersions((current) => {
          const next = new Set(current)
          next.delete(assetId)
          return next
        })
      }
    }
  }, [client, projectId, reportError])

  useEffect(() => {
    mountedRef.current = true
    const controller = new AbortController()
    setHandles([])
    setExpandedAssetIds(new Set())
    setVersionsByAssetId({})
    setSelectedByAssetId({})
    setSwitchingKey(null)
    setShowArchived(false)
    setLibraryError('')
    idempotencyKeysRef.current.clear()
    void loadHandles(controller.signal)
    return () => {
      mountedRef.current = false
      controller.abort()
      versionRequestRef.current.clear()
    }
  }, [loadHandles])

  const organizedCatalog = useMemo(() => {
    const domainCounts = new Map<AssetHandle['businessBinding']['domain'], number>()
    const groupCounts = new Map<string, number>()
    for (const handle of handles) {
      const binding = handle.businessBinding
      domainCounts.set(binding.domain, (domainCounts.get(binding.domain) ?? 0) + 1)
      groupCounts.set(binding.groupKey, (groupCounts.get(binding.groupKey) ?? 0) + 1)
    }
    const archivedCount = domainCounts.get('archive') ?? 0
    const visible = handles.filter((handle) => showArchived || handle.businessBinding.domain !== 'archive')
    visible.sort((left, right) => {
      const leftDomain = BUSINESS_DOMAIN_ORDER.indexOf(left.businessBinding.domain)
      const rightDomain = BUSINESS_DOMAIN_ORDER.indexOf(right.businessBinding.domain)
      if (leftDomain !== rightDomain) return leftDomain - rightDomain
      const leftEpisode = left.businessBinding.episodeId ?? ''
      const rightEpisode = right.businessBinding.episodeId ?? ''
      if (leftEpisode !== rightEpisode) return leftEpisode.localeCompare(rightEpisode, 'zh-CN')
      const group = left.businessBinding.groupLabel.localeCompare(right.businessBinding.groupLabel, 'zh-CN')
      if (group !== 0) return group
      const kind = kindLabel(left.kind).localeCompare(kindLabel(right.kind), 'zh-CN')
      if (kind !== 0) return kind
      return right.updatedAt.localeCompare(left.updatedAt)
    })
    return { visible, domainCounts, groupCounts, archivedCount }
  }, [handles, showArchived])

  const toggleVersions = (assetId: string) => {
    const opening = !expandedAssetIds.has(assetId)
    setExpandedAssetIds((current) => {
      const next = new Set(current)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return next
    })
    if (opening && !versionsByAssetId[assetId] && !loadingVersions.has(assetId)) {
      void loadVersions(assetId)
    }
  }

  /** Local-only preview selection: no API mutation, default switch, or pin rewrite. */
  const selectPreview = (assetId: string, assetVersionId: string) => {
    setSelectedByAssetId((current) => ({ ...current, [assetId]: assetVersionId }))
  }

  const setLibraryDefault = async (
    versionsResponse: AssetHandleVersionsResponse,
    version: AssetHandleVersion,
  ) => {
    const requestProjectId = projectId
    const requestScopeKey = scopeKey
    const { asset } = versionsResponse
    if (asset.currentAssetVersionId === version.assetVersionId || switchingKey) return
    if (version.version.status !== 'ready' || !version.checksum) {
      reportError('只能把已就绪且具有校验和的不可变版本设为素材库默认。')
      return
    }

    const intent = `${projectId}\0${asset.assetId}\0${version.assetVersionId}\0${asset.etag}`
    let idempotencyKey = idempotencyKeysRef.current.get(intent)
    if (!idempotencyKey) {
      idempotencyKey = operationId()
      idempotencyKeysRef.current.set(intent, idempotencyKey)
    }
    const nextSwitchingKey = `${asset.assetId}:${version.assetVersionId}`
    setSwitchingKey(nextSwitchingKey)
    setLibraryError('')
    try {
      const result = await client.switchAssetHandleCurrentVersion(
        requestProjectId,
        asset.assetId,
        version.assetVersionId,
        asset.etag,
        { idempotencyKey },
      )
      if (!mountedRef.current || projectScopeRef.current !== requestScopeKey) return
      idempotencyKeysRef.current.delete(intent)
      setHandles((current) => current.map((handle) => (
        handle.assetId === result.asset.assetId ? result.asset : handle
      )))
      setVersionsByAssetId((current) => {
        const existing = current[result.asset.assetId]
        return existing
          ? { ...current, [result.asset.assetId]: { ...existing, asset: result.asset } }
          : current
      })
      setSelectedByAssetId((current) => ({
        ...current,
        [result.asset.assetId]: result.switch.selectedAssetVersionId,
      }))
      void Promise.resolve(onChangedRef.current?.(result)).catch((error) => {
        reportError(`素材库默认已更新，但外层刷新失败：${errorMessage(error, '未知错误')}`)
      })
    } catch (error) {
      if (!mountedRef.current || projectScopeRef.current !== requestScopeKey) return
      if (error instanceof ApiError && error.status === 412) {
        await loadVersions(asset.assetId)
        reportError('素材库默认已被其他操作更新，版本条已刷新。请确认后再试；系统不会自动重提。')
      } else {
        reportError(`设置素材库默认失败：${errorMessage(error, '请求结果未知')}。未调用 Provider，也没有修改本制作固定版本。`)
      }
    } finally {
      if (mountedRef.current && projectScopeRef.current === requestScopeKey) setSwitchingKey(null)
    }
  }

  return (
    <section className="project-asset-version-library" aria-labelledby="project-asset-version-library-title">
      <header className="project-asset-version-library-header">
        <div>
          <span><Layers3 size={18} /></span>
          <div>
            <small>{episodeId
              ? `剧集范围 · ${episodeLabelsById[episodeId] ?? episodeId.slice(0, 8)}`
              : '项目全部数字资产'}</small>
            <h2 id="project-asset-version-library-title">业务资产与版本</h2>
            <p>先按角色、场景、道具、镜头和台词聚合，再管理固定素材 ID 与不可变版本。</p>
          </div>
        </div>
        <button type="button" onClick={() => void loadHandles()} disabled={loadingHandles}>
          <RefreshCw size={14} className={loadingHandles ? 'spin' : ''} />
          刷新素材库
        </button>
      </header>

      <div className="project-asset-version-library-policy">
        <ShieldCheck size={17} />
        <div>
          <strong>切换素材库默认，不会改写本制作使用的版本</strong>
          <span>单击版本只在本页预览；只有“设为素材库默认”会更新默认指针。该操作不调用 AIGC Provider，也不会自动升级当前分集已经固定的版本。“本制作使用”暂表示当前工作台已加载的精确引用。</span>
        </div>
      </div>

      <div className="project-asset-business-summary" aria-label="素材业务聚合摘要">
        <div>
          {BUSINESS_DOMAIN_ORDER.filter((domain) => domain !== 'archive' && organizedCatalog.domainCounts.has(domain)).map((domain) => (
            <span key={domain}><strong>{BUSINESS_DOMAIN_LABEL[domain]}</strong>{organizedCatalog.domainCounts.get(domain)}</span>
          ))}
        </div>
        {organizedCatalog.archivedCount > 0 && (
          <button type="button" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>
            <Archive size={13} />
            {showArchived ? '隐藏归档' : `显示归档 ${organizedCatalog.archivedCount}`}
          </button>
        )}
      </div>

      {libraryError && (
        <div className="project-asset-version-library-error" role="alert">
          <AlertTriangle size={15} />
          <span>{libraryError}</span>
        </div>
      )}

      {loadingHandles && handles.length === 0 ? (
        <div className="project-asset-version-library-loading">
          <LoaderCircle size={20} className="spin" /> 正在读取稳定素材 ID…
        </div>
      ) : handles.length === 0 ? (
        <div className="project-asset-version-library-empty">
          <Layers3 size={28} />
          <strong>{episodeId ? '该剧集暂无可用素材' : '项目素材库暂无可用素材'}</strong>
          <span>{episodeId
            ? '可切回“项目全部素材”查看共享版本，或在该集制作中生成/引用素材。'
            : '生成或上传的图片、音频、视频与脚本会以稳定素材 ID 归档在这里。'}</span>
        </div>
      ) : (
        <div className="project-asset-version-handle-list">
          {organizedCatalog.visible.map((handle, index) => {
            const binding = handle.businessBinding
            const previous = index > 0 ? organizedCatalog.visible[index - 1]?.businessBinding : null
            const domainChanged = previous?.domain !== binding.domain
            const groupChanged = domainChanged || previous?.groupKey !== binding.groupKey
            const expanded = expandedAssetIds.has(handle.assetId)
            const versionsResponse = versionsByAssetId[handle.assetId]
            const selectedId = selectedByAssetId[handle.assetId]
              ?? versionsResponse?.asset.currentAssetVersionId
              ?? versionsResponse?.versions[0]?.assetVersionId
            const selectedVersion = versionsResponse?.versions.find((version) => (
              version.assetVersionId === selectedId
            ))
            const currentPinned = handle.currentAssetVersionId
              ? pinnedVersions.has(handle.currentAssetVersionId)
              : false

            return (
              <Fragment key={handle.assetId}>
                {domainChanged && (
                  <header className="project-asset-business-domain">
                    <div><span>{BUSINESS_DOMAIN_LABEL[binding.domain]}</span><strong>{organizedCatalog.domainCounts.get(binding.domain) ?? 0}</strong></div>
                    <small>{binding.domain === 'archive' ? '保留稳定素材 ID 与审计记录' : '按真实业务对象聚合，不再按文件平铺'}</small>
                  </header>
                )}
                {groupChanged && (
                  <div className="project-asset-business-group">
                    <div>
                      <strong>{binding.groupLabel}</strong>
                      <span>{binding.episodeId
                        ? episodeLabelsById[binding.episodeId] ?? `剧集 ${binding.episodeId.slice(0, 8)}`
                        : '项目级共享'}</span>
                    </div>
                    <em>{organizedCatalog.groupCounts.get(binding.groupKey) ?? 0} 个固定素材</em>
                  </div>
                )}
                <article className={`project-asset-version-handle${expanded ? ' expanded' : ''}`}>
                <button
                  className="project-asset-version-handle-toggle"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`asset-version-strip-${handle.assetId}`}
                  onClick={() => toggleVersions(handle.assetId)}
                >
                  <span className="project-asset-version-handle-chevron">
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </span>
                  <span className="project-asset-version-handle-thumb">
                    <MediaThumbnail asset={handle.currentVersion} />
                  </span>
                  <span className="project-asset-version-handle-name">
                    <strong>{assetLabel(handle)}</strong>
                    <span>{kindLabel(handle.kind)} · {handle.versionCount} 个版本 · {handle.currentVersion?.episodeId
                      ? episodeLabelsById[handle.currentVersion.episodeId] ?? `剧集 ${handle.currentVersion.episodeId.slice(0, 8)}`
                      : '项目级'}</span>
                    <code title={handle.assetId}>素材 ID · {handle.assetId}</code>
                  </span>
                  <span className="project-asset-version-handle-state">
                    {handle.currentVersion ? <VersionBadge tone="default"><BadgeCheck size={11} />库默认</VersionBadge> : null}
                    {currentPinned ? <VersionBadge tone="pinned"><Pin size={11} />本制作使用</VersionBadge> : null}
                  </span>
                </button>

                {expanded && (
                  <div className="project-asset-version-panel" id={`asset-version-strip-${handle.assetId}`}>
                    {loadingVersions.has(handle.assetId) && !versionsResponse ? (
                      <div className="project-asset-version-inline-loading">
                        <LoaderCircle size={17} className="spin" /> 正在读取不可变版本…
                      </div>
                    ) : versionsResponse && selectedVersion ? (
                      <>
                        <div className="project-asset-version-preview">
                          <div className="project-asset-version-preview-media">
                            <MediaThumbnail asset={selectedVersion.version} large />
                          </div>
                          <div className="project-asset-version-preview-detail">
                            <div className="project-asset-version-preview-heading">
                              <span>当前预览 · v{selectedVersion.versionNumber}</span>
                              <VersionBadge tone="immutable"><ShieldCheck size={11} />不可变版本</VersionBadge>
                            </div>
                            <strong>{selectedVersion.version.originalFileName || kindLabel(selectedVersion.version.kind)}</strong>
                            <dl>
                              <div><dt>assetVersionId</dt><dd><code>{selectedVersion.assetVersionId}</code></dd></div>
                              <div><dt>来源</dt><dd>{sourceLabel(selectedVersion.version)}</dd></div>
                              <div><dt>Catalog 范围</dt><dd>{selectedVersion.version.episodeId
                                ? episodeLabelsById[selectedVersion.version.episodeId] ?? `剧集 ${selectedVersion.version.episodeId}`
                                : '项目级共享素材'}</dd></div>
                              <div><dt>创建时间</dt><dd>{formatDate(selectedVersion.createdAt)}</dd></div>
                              {dimensions(selectedVersion.version) && <div><dt>规格</dt><dd>{dimensions(selectedVersion.version)}</dd></div>}
                              <div><dt>校验和</dt><dd><code>{selectedVersion.checksum?.slice(0, 16) ?? '尚未固化'}{selectedVersion.checksum ? '…' : ''}</code></dd></div>
                            </dl>
                            <div className="project-asset-version-preview-badges">
                              {versionsResponse.asset.currentAssetVersionId === selectedVersion.assetVersionId && (
                                <VersionBadge tone="default"><BadgeCheck size={11} />素材库默认</VersionBadge>
                              )}
                              {pinnedVersions.has(selectedVersion.assetVersionId) && (
                                <VersionBadge tone="pinned"><Pin size={11} />本制作使用</VersionBadge>
                              )}
                            </div>
                            <button
                              className="project-asset-version-set-default"
                              type="button"
                              disabled={
                                versionsResponse.asset.currentAssetVersionId === selectedVersion.assetVersionId
                                || selectedVersion.version.status !== 'ready'
                                || !selectedVersion.checksum
                                || switchingKey !== null
                              }
                              onClick={() => void setLibraryDefault(versionsResponse, selectedVersion)}
                            >
                              {switchingKey === `${handle.assetId}:${selectedVersion.assetVersionId}`
                                ? <LoaderCircle size={14} className="spin" />
                                : <BadgeCheck size={14} />}
                              {versionsResponse.asset.currentAssetVersionId === selectedVersion.assetVersionId
                                ? '已是素材库默认'
                                : '设为素材库默认'}
                            </button>
                            <small className="project-asset-version-pin-note">不会修改“本制作使用”标记；现有制作引用需在对应制作工作台单独确认升级，统一 Asset Manifest 尚在建设。</small>
                          </div>
                        </div>

                        <div className="project-asset-version-strip-heading">
                          <div><Eye size={14} /><strong>版本条</strong><span>单击仅预览</span></div>
                          <button type="button" onClick={() => void loadVersions(handle.assetId)} disabled={loadingVersions.has(handle.assetId)}>
                            <RefreshCw size={12} className={loadingVersions.has(handle.assetId) ? 'spin' : ''} /> 刷新版本
                          </button>
                        </div>
                        <div className="project-asset-version-strip" aria-label={`${assetLabel(handle)}版本`}>
                          {versionsResponse.versions.map((version) => {
                            const selected = version.assetVersionId === selectedVersion.assetVersionId
                            const isDefault = versionsResponse.asset.currentAssetVersionId === version.assetVersionId
                            const isPinned = pinnedVersions.has(version.assetVersionId)
                            return (
                              <button
                                type="button"
                                className={`project-asset-version-tile${selected ? ' selected' : ''}`}
                                aria-pressed={selected}
                                key={version.assetVersionId}
                                onClick={() => selectPreview(handle.assetId, version.assetVersionId)}
                              >
                                <span className="project-asset-version-tile-media"><MediaThumbnail asset={version.version} /></span>
                                <span className="project-asset-version-tile-title">
                                  <strong>v{version.versionNumber}</strong>
                                  <span>{sourceLabel(version.version)} · {version.version.episodeId
                                    ? episodeLabelsById[version.version.episodeId] ?? `剧集 ${version.version.episodeId.slice(0, 8)}`
                                    : '项目级'}</span>
                                </span>
                                <code title={version.assetVersionId}>{version.assetVersionId}</code>
                                <span className="project-asset-version-tile-badges">
                                  {isDefault && <em className="default">默认</em>}
                                  {isPinned && <em className="pinned">本制作使用</em>}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      </>
                    ) : (
                      <div className="project-asset-version-inline-empty">
                        <ImageIcon size={18} /> 该素材尚无可预览版本。
                      </div>
                    )}
                  </div>
                )}
                </article>
              </Fragment>
            )
          })}
        </div>
      )}
    </section>
  )
}
