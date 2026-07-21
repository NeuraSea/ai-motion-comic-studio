import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileLock2, RefreshCcw } from 'lucide-react'

import {
  ApiError,
  api,
  type ProductionAssetManifestProjection,
} from '../../lib'

import './ProductionAssetManifestCard.css'

export interface ProductionAssetManifestCardProps {
  projectId: string
  episodeId: string
  refreshKey: string
}

export function ProductionAssetManifestCard({
  projectId,
  episodeId,
  refreshKey,
}: ProductionAssetManifestCardProps) {
  const [projection, setProjection] = useState<ProductionAssetManifestProjection | null>(null)
  const [episodeEtag, setEpisodeEtag] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading')
  const [error, setError] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    setState('loading')
    setError('')
    try {
      const result = await api.getProductionAssetManifest(projectId, episodeId, { signal })
      setProjection(result.projection)
      setEpisodeEtag(result.episodeEtag)
      setState('ready')
    } catch (cause) {
      if (signal?.aborted) return
      setState('error')
      setError(cause instanceof Error ? cause.message : '制作素材清单加载失败')
    }
  }, [episodeId, projectId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, refreshKey])

  const materialize = async () => {
    if (!projection || !episodeEtag || projection.status === 'blocked') return
    setState('saving')
    setError('')
    try {
      await api.materializeProductionAssetManifest(projectId, episodeId, episodeEtag, {
        summary: '角色与场景准备阶段确认本集制作引用',
      })
      await load()
    } catch (cause) {
      setState('error')
      setError(cause instanceof ApiError || cause instanceof Error
        ? cause.message
        : '制作素材清单固化失败')
    }
  }

  const status = projection?.status ?? 'blocked'
  const latest = projection?.latestManifest ?? null
  const statusLabel = state === 'loading'
    ? '正在核对服务端引用…'
    : state === 'saving'
      ? '正在固化不可变清单…'
      : status === 'current'
        ? `r${latest?.revisionNumber ?? 0} 已固化`
        : status === 'changed'
          ? `引用已变化 · 当前为 r${latest?.revisionNumber ?? 0}`
          : status === 'missing'
            ? '尚未固化本集制作清单'
            : `${projection?.blockers.length ?? 0} 项需先处理`

  return (
    <section
      className={`production-manifest-card ${status}`}
      data-production-manifest-status={status}
      aria-label="本集制作资产清单"
    >
      <div className="production-manifest-heading">
        {status === 'current' ? <CheckCircle2 size={18} /> : status === 'blocked' ? <AlertTriangle size={18} /> : <FileLock2 size={18} />}
        <div>
          <strong>本集制作资产清单</strong>
          <span>{statusLabel}</span>
        </div>
      </div>
      <div className="production-manifest-metrics">
        <span><b>{projection?.entries.length ?? 0}</b> 个精确版本</span>
        <span><b>{new Set(projection?.entries.map((entry) => entry.assetId) ?? []).size}</b> 个稳定素材 ID</span>
        <span>图片 / 音频 / 视频 / OpenCut 时间线引用由服务端派生，Catalog 默认版本变化不会改写已固化清单。</span>
      </div>
      {projection && projection.blockers.length > 0 && (
        <ul className="production-manifest-blockers">
          {projection.blockers.slice(0, 4).map((blocker) => (
            <li key={`${blocker.code}:${blocker.slotKey ?? 'scope'}`}>{blocker.message}</li>
          ))}
          {projection.blockers.length > 4 && <li>另有 {projection.blockers.length - 4} 项，请刷新后继续处理。</li>}
        </ul>
      )}
      {error && <p className="production-manifest-error" role="alert">{error}</p>}
      <div className="production-manifest-actions">
        <button type="button" onClick={() => void load()} disabled={state === 'loading' || state === 'saving'}>
          <RefreshCcw size={13} /> 刷新核对
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => void materialize()}
          disabled={!projection || state !== 'ready' || status === 'blocked' || status === 'current'}
        >
          <FileLock2 size={13} /> {status === 'changed' ? '固化新修订' : status === 'current' ? '清单已是最新' : '固化本集制作引用'}
        </button>
      </div>
    </section>
  )
}
