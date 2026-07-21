import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  createOpenCutCommandEditor,
  OPEN_CUT_TICKS_PER_SECOND,
  RENDER_SEMANTIC_PLAN_VERSION,
  renderSemanticVisualOpacityAtFrame,
  renderSemanticVisualScaleAtFrame,
  type OpenCutCommandEditor,
  type OpenCutPlaybackSnapshot,
  type RenderSemanticAudioClip,
  type RenderSemanticPlan,
  type RenderSemanticVisualClip,
} from '@manju/opencut-editor'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Film,
  LoaderCircle,
  Pause,
  Play,
  RefreshCcw,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import {
  api,
  ApiError,
  type EpisodeSummary,
  type TimelineDocumentSnapshot,
} from '../../lib'
import {
  exportRenderSemanticPlanToMp4,
  probeBrowserQuickExport,
  semanticAudioGainAtSeconds,
  type BrowserQuickExportProgress,
  type BrowserQuickExportSupport,
} from './browser-quick-export'
import type { TimelineMediaBinding, TimelineMediaManifest } from './manju-media-resolver'
import {
  renderSemanticInvertedShapeMaskPath,
  renderSemanticShapeMaskClipPath,
} from './visual-shape-mask'
import { createPinnedRenderSemanticSession } from './render-semantic-session'
import {
  buildTimelineRenderRescueEnvelope,
  classifyTimelineRenderFailure,
  serializeTimelineRenderRescue,
  timelineRenderRescueFilename,
  type TimelineRenderFailure,
  type TimelineRenderRescueEnvelope,
} from './timeline-render-rescue'
import './OpenCutPreviewModal.css'

type PreviewPhase = 'loading' | 'ready' | 'error'

interface PreviewSession {
  editor: OpenCutCommandEditor
  media: TimelineMediaManifest
  plan: RenderSemanticPlan
  timelineRevisionId: string
  repairedManagedAudioCount: number
}

type QuickExportPhase = 'probing' | 'ready' | 'exporting' | 'succeeded' | 'error' | 'unsupported'

const EMPTY_PLAYBACK: OpenCutPlaybackSnapshot = {
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  isScrubbing: false,
}

function timecode(ticks: number, fps: number): string {
  const seconds = Math.max(0, ticks) / OPEN_CUT_TICKS_PER_SECOND
  const whole = Math.floor(seconds)
  const frames = Math.min(
    Math.max(1, Math.round(fps)) - 1,
    Math.floor((seconds - whole) * fps),
  )
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}

function previewStageWidth(aspectRatio: EpisodeSummary['aspectRatio']): string {
  // `max-height` alone overrides an aspect-ratio-derived height without
  // shrinking the width, which turns a 9:16 preview into an almost-square
  // stage on a short viewport. Pre-expand the height constraint into an
  // equivalent width so the actual Chrome preview keeps its delivery ratio.
  if (aspectRatio === '9:16') return 'min(100%, 760px, calc(56.25vh - 146.25px))'
  if (aspectRatio === '1:1') return 'min(100%, 760px, calc(100vh - 260px))'
  return 'min(100%, 760px, calc(177.7778vh - 462.2223px))'
}

function sourceTimeSeconds(
  clip: RenderSemanticVisualClip | RenderSemanticAudioClip,
  timelineTime: number,
  plan: RenderSemanticPlan,
): number {
  const timelineSeconds = timelineTime / plan.ticksPerSecond
  const clipStartSeconds = clip.startFrame / plan.frameRate
  const localSeconds = Math.max(
    0,
    Math.min(clip.durationFrames / plan.frameRate, timelineSeconds - clipStartSeconds),
  )
  return (clip.sourceTrim?.startFrame ?? 0) / plan.frameRate + localSeconds
}

function synchronizeMediaTime(
  media: HTMLMediaElement,
  clip: RenderSemanticVisualClip | RenderSemanticAudioClip,
  plan: RenderSemanticPlan,
  timelineTime: number,
): void {
  let target = sourceTimeSeconds(clip, timelineTime, plan)
  if (Number.isFinite(media.duration) && media.duration > 0) {
    target = Math.min(target, Math.max(0, media.duration - 0.001))
  }
  if (Number.isFinite(target) && Math.abs(media.currentTime - target) > 0.09) {
    media.currentTime = target
  }
}

function InvertedShapeMaskDefinition({
  id,
  path,
}: {
  id: string
  path: string | undefined
}) {
  if (!path) return null
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      style={{ position: 'absolute' }}
    >
      <defs>
        <clipPath id={id} clipPathUnits="objectBoundingBox">
          <path d={path} fillRule="evenodd" clipRule="evenodd" />
        </clipPath>
      </defs>
    </svg>
  )
}

function PreviewVideo({
  binding,
  clip,
  plan,
  playback,
  onError,
}: {
  binding: TimelineMediaBinding
  clip: RenderSemanticVisualClip
  plan: RenderSemanticPlan
  playback: OpenCutPlaybackSnapshot
  onError: (message: string) => void
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const inverseMaskId = `preview-video-inverse-mask-${useId().replace(/:/g, '')}`
  const inverseMaskPath = renderSemanticInvertedShapeMaskPath(clip)
  const timelineSeconds = playback.currentTime / plan.ticksPerSecond
  const active = timelineSeconds >= clip.startFrame / plan.frameRate
    && timelineSeconds < clip.endFrameExclusive / plan.frameRate
  const opacityFrame = Math.max(
    clip.startFrame,
    Math.min(clip.endFrameExclusive - 1, Math.floor(timelineSeconds * plan.frameRate)),
  )
  const opacity = renderSemanticVisualOpacityAtFrame(clip, opacityFrame)

  useEffect(() => {
    const video = ref.current
    if (!video) return
    video.muted = true
    video.volume = 0
    video.playbackRate = 1
    synchronizeMediaTime(video, clip, plan, playback.currentTime)
    if (playback.isPlaying && active) {
      void video.play().catch((error: unknown) => {
        onError(error instanceof Error ? error.message : '浏览器拒绝播放当前视频')
      })
    } else {
      video.pause()
    }
  }, [active, clip, onError, plan, playback])

  return (
    <>
      <InvertedShapeMaskDefinition id={inverseMaskId} path={inverseMaskPath} />
      <video
        ref={ref}
        className="opencut-preview-media"
        src={binding.url}
        style={{
          objectFit: clip.fit,
          opacity,
          clipPath: inverseMaskPath
            ? `url(#${inverseMaskId})`
            : renderSemanticShapeMaskClipPath(clip),
        }}
        playsInline
        muted
        preload="auto"
        onLoadedMetadata={() => {
          if (ref.current) synchronizeMediaTime(ref.current, clip, plan, playback.currentTime)
        }}
        onError={() => onError('当前视频编码无法在这个浏览器中解码')}
        aria-label="当前时间线视频画面"
      />
    </>
  )
}

function PreviewAudio({
  binding,
  clip,
  plan,
  playback,
  audioContext,
  onError,
}: {
  binding: TimelineMediaBinding
  clip: RenderSemanticAudioClip
  plan: RenderSemanticPlan
  playback: OpenCutPlaybackSnapshot
  audioContext: AudioContext | null
  onError: (message: string) => void
}) {
  const ref = useRef<HTMLAudioElement>(null)
  const gainRef = useRef<GainNode | null>(null)
  const timelineSeconds = playback.currentTime / plan.ticksPerSecond
  const active = timelineSeconds >= clip.startFrame / plan.frameRate
    && timelineSeconds < clip.endFrameExclusive / plan.frameRate

  useEffect(() => {
    const audio = ref.current
    if (!audio || !audioContext) return
    const source = audioContext.createMediaElementSource(audio)
    const gain = audioContext.createGain()
    source.connect(gain)
    gain.connect(audioContext.destination)
    gainRef.current = gain
    audio.muted = false
    audio.volume = 1
    return () => {
      gainRef.current = null
      source.disconnect()
      gain.disconnect()
    }
  }, [audioContext])

  useEffect(() => {
    const audio = ref.current
    if (!audio) return
    audio.volume = 1
    audio.playbackRate = 1
    audio.preservesPitch = true
    if (active) synchronizeMediaTime(audio, clip, plan, playback.currentTime)
    const semanticGain = semanticAudioGainAtSeconds(clip, timelineSeconds, plan.frameRate)
    if (gainRef.current) {
      gainRef.current.gain.value = playback.muted ? 0 : playback.volume * semanticGain
    }
    if (playback.isPlaying && active && audioContext) {
      void audio.play().catch((error: unknown) => {
        onError(error instanceof Error ? error.message : '浏览器拒绝播放时间线音频')
      })
    } else {
      audio.pause()
    }
  }, [active, audioContext, clip, onError, plan, playback, timelineSeconds])

  return (
    <audio
      ref={ref}
      className="opencut-preview-audio"
      src={binding.url}
      preload="auto"
      muted={!audioContext}
      onLoadedMetadata={() => {
        if (ref.current && active) {
          synchronizeMediaTime(ref.current, clip, plan, playback.currentTime)
        }
      }}
      onError={() => onError('当前音频编码无法在这个浏览器中解码')}
    />
  )
}

export function OpenCutPreviewModal({
  projectId,
  episode,
  timelineSnapshot,
  title,
  onClose,
}: {
  projectId: string
  episode: EpisodeSummary
  timelineSnapshot: TimelineDocumentSnapshot
  title: string
  onClose: () => void
}) {
  const inverseImageMaskId = `preview-image-inverse-mask-${useId().replace(/:/g, '')}`
  const [phase, setPhase] = useState<PreviewPhase>('loading')
  const [error, setError] = useState('')
  const [renderFailure, setRenderFailure] = useState<TimelineRenderFailure | null>(null)
  const [renderRescue, setRenderRescue] = useState<TimelineRenderRescueEnvelope | null>(null)
  const [rescueFeedback, setRescueFeedback] = useState('')
  const [mediaError, setMediaError] = useState('')
  const [session, setSession] = useState<PreviewSession | null>(null)
  const [playback, setPlayback] = useState<OpenCutPlaybackSnapshot>(EMPTY_PLAYBACK)
  const [reloadToken, setReloadToken] = useState(0)
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null)
  const [quickPhase, setQuickPhase] = useState<QuickExportPhase>('probing')
  const [quickSupport, setQuickSupport] = useState<BrowserQuickExportSupport>({
    supported: false,
    reason: null,
  })
  const [quickProgress, setQuickProgress] = useState<BrowserQuickExportProgress>({
    phase: 'assets',
    progress: 0,
  })
  const [quickError, setQuickError] = useState('')
  const [quickUrl, setQuickUrl] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const quickAbortRef = useRef<AbortController | null>(null)
  const quickUrlRef = useRef<string | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const focusFrame = window.requestAnimationFrame(() => {
      dialog?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
      }
    }
    dialog?.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      dialog?.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [])

  useEffect(() => () => {
    quickAbortRef.current?.abort()
    if (quickUrlRef.current) URL.revokeObjectURL(quickUrlRef.current)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let editor: OpenCutCommandEditor | null = null
    setPhase('loading')
    setError('')
    setRenderFailure(null)
    setRenderRescue(null)
    setRescueFeedback('')
    setMediaError('')
    setSession(null)
    setPlayback(EMPTY_PLAYBACK)

    void Promise.resolve(timelineSnapshot)
      .then(async (snapshot) => {
        const assets = await api.listAssets(projectId, {
          episodeId: episode.id,
          includeProjectAssets: true,
          signal: controller.signal,
        })
        const semantic = createPinnedRenderSemanticSession({
          projectId,
          episode,
          timelineSnapshot: snapshot,
          assets,
        })
        if (controller.signal.aborted) return
        const frameRate = { numerator: semantic.plan.frameRate, denominator: 1 }
        editor = createOpenCutCommandEditor({ tracks: semantic.tracks, frameRate })
        const expectedDuration = semantic.plan.totalFrames
          * semantic.plan.ticksPerSecond / semantic.plan.frameRate
        if (editor.playback.getSnapshot().duration !== expectedDuration) {
          throw new Error('共享渲染计划与 OpenCut 播放时钟时长不一致')
        }
        setSession({
          editor,
          media: semantic.media,
          plan: semantic.plan,
          timelineRevisionId: snapshot.revision.id,
          repairedManagedAudioCount: semantic.repairs.filter((repair) => (
            repair.code === 'MANAGED_AUDIO_SOURCE_OVERRUN_CLAMPED'
          )).length,
        })
        setPhase('ready')
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted
          || (cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) return
        const failure = classifyTimelineRenderFailure(cause)
        setError(failure.message)
        setRenderFailure(failure)
        setRenderRescue(buildTimelineRenderRescueEnvelope({
          snapshot: timelineSnapshot,
          failure,
        }))
        setPhase('error')
      })

    return () => {
      controller.abort()
      editor?.playback.pause()
    }
  }, [episode.aspectRatio, episode.id, episode.sourceRevisionId, projectId, reloadToken, timelineSnapshot])

  const copyRenderRescue = async () => {
    if (!renderRescue) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不允许写入剪贴板')
      await navigator.clipboard.writeText(serializeTimelineRenderRescue(renderRescue))
      setRescueFeedback('已复制完整救援 JSON；原时间线没有被修改。')
    } catch (cause) {
      setRescueFeedback(cause instanceof Error ? cause.message : '复制救援 JSON 失败')
    }
  }

  const downloadRenderRescue = () => {
    if (!renderRescue) return
    const url = URL.createObjectURL(new Blob(
      [serializeTimelineRenderRescue(renderRescue)],
      { type: 'application/json;charset=utf-8' },
    ))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = timelineRenderRescueFilename(timelineSnapshot)
    anchor.click()
    URL.revokeObjectURL(url)
    setRescueFeedback('已下载绑定当前修订与 ETag 的完整救援 JSON。')
  }

  useEffect(() => {
    let cancelled = false
    quickAbortRef.current?.abort()
    quickAbortRef.current = null
    if (quickUrlRef.current) URL.revokeObjectURL(quickUrlRef.current)
    quickUrlRef.current = null
    setQuickUrl(null)
    setQuickPhase('probing')
    setQuickError('')
    setQuickSupport({ supported: false, reason: null })
    if (!session) return () => { cancelled = true }
    void probeBrowserQuickExport(session.plan).then((support) => {
      if (cancelled) return
      setQuickSupport(support)
      setQuickPhase(support.supported ? 'ready' : 'unsupported')
    })
    return () => { cancelled = true }
  }, [session])

  useEffect(() => {
    if (!session) return
    const refresh = () => setPlayback(session.editor.playback.getSnapshot())
    const unsubscribeState = session.editor.playback.subscribe(setPlayback)
    const unsubscribeUpdate = session.editor.playback.onUpdate(refresh)
    const unsubscribeSeek = session.editor.playback.onSeek(refresh)
    refresh()
    return () => {
      unsubscribeState()
      unsubscribeUpdate()
      unsubscribeSeek()
      session.editor.playback.pause()
    }
  }, [session])

  useEffect(() => {
    if (!session || session.plan.audioClips.length === 0) return
    const Constructor = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Constructor) return
    const context = new Constructor()
    audioContextRef.current = context
    setAudioContext(context)
    return () => {
      if (audioContextRef.current === context) audioContextRef.current = null
      setAudioContext((current) => current === context ? null : current)
      void context.close()
    }
  }, [session])

  const displayTime = playback.duration > 0
    ? Math.min(playback.currentTime, playback.duration - 1)
    : 0
  const displayFrame = session
    ? Math.min(
        Math.max(0, session.plan.totalFrames - 1),
        Math.max(0, Math.floor(displayTime * session.plan.frameRate / session.plan.ticksPerSecond)),
      )
    : 0
  const visual = useMemo(
    () => session?.plan.visualClips.find((clip) => (
      clip.startFrame <= displayFrame && displayFrame < clip.endFrameExclusive
    )) ?? null,
    [displayFrame, session],
  )
  const visualBinding = visual && session
    ? session.media.bindings.find((binding) => (
        binding.elementId === visual.id
        && binding.assetId === visual.asset.assetId
      )) ?? null
    : null
  const visualScale = visual
    ? renderSemanticVisualScaleAtFrame(visual, displayFrame)
    : 1
  const inverseImageMaskPath = visual
    ? renderSemanticInvertedShapeMaskPath(visual)
    : undefined
  const textCues = useMemo(
    () => session?.plan.subtitleCues.filter((cue) => (
      cue.startFrame <= displayFrame && displayFrame < cue.endFrameExclusive
    )) ?? [],
    [displayFrame, session],
  )
  const audioBindings = session?.plan.audioClips.flatMap((clip) => {
    const elementId = clip.id.endsWith(':source-audio')
      ? clip.id.slice(0, -':source-audio'.length)
      : clip.id
    const binding = session.media.bindings.find((candidate) => (
      candidate.elementId === elementId && candidate.assetId === clip.asset.assetId
    ))
    return binding ? [{ binding, clip }] : []
  }) ?? []
  const fps = session?.plan.frameRate ?? 24
  const resolvedVisualCount = session?.plan.visualClips.length ?? 0
  const missingCount = session?.media.issues.length ?? 0

  const startQuickExport = async () => {
    if (!session || !quickSupport.supported || quickPhase === 'exporting') return
    quickAbortRef.current?.abort()
    const controller = new AbortController()
    quickAbortRef.current = controller
    if (quickUrlRef.current) URL.revokeObjectURL(quickUrlRef.current)
    quickUrlRef.current = null
    setQuickUrl(null)
    setQuickPhase('exporting')
    setQuickError('')
    setQuickProgress({ phase: 'assets', progress: 0 })
    try {
      const blob = await exportRenderSemanticPlanToMp4({
        plan: session.plan,
        manifest: session.media,
        signal: controller.signal,
        onProgress: setQuickProgress,
      })
      if (controller.signal.aborted) return
      if (quickUrlRef.current) URL.revokeObjectURL(quickUrlRef.current)
      const url = URL.createObjectURL(blob)
      quickUrlRef.current = url
      setQuickUrl(url)
      setQuickPhase('succeeded')
    } catch (cause) {
      if (controller.signal.aborted) {
        setQuickPhase('ready')
        return
      }
      setQuickError(cause instanceof Error ? cause.message : '浏览器快导失败')
      setQuickPhase('error')
    } finally {
      if (quickAbortRef.current === controller) quickAbortRef.current = null
    }
  }

  const togglePlayback = async () => {
    if (!session) return
    setMediaError('')
    if (!playback.isPlaying && session.plan.audioClips.length > 0) {
      let context = audioContextRef.current
      if (!context) {
        const Constructor = window.AudioContext
          || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Constructor) {
          setMediaError('当前浏览器不支持 Web Audio 语义混音')
          return
        }
        context = new Constructor()
        audioContextRef.current = context
        setAudioContext(context)
      }
      await context.resume()
    }
    session.editor.playback.toggle()
  }

  return (
    <div className="modal-backdrop opencut-preview-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="opencut-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="opencut-preview-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <small>OpenCut Classic 播放时钟 · RenderSemanticPlan v{RENDER_SEMANTIC_PLAN_VERSION}</small>
            <h2 id="opencut-preview-title">预览「{title}」</h2>
          </div>
          <div className="opencut-preview-header-actions">
            {phase === 'ready' && <span><CheckCircle2 size={12} /> 真实时间线</span>}
            <button onClick={onClose} aria-label="关闭预览"><X size={18} /></button>
          </div>
        </header>

        <main>
          {phase === 'loading' && (
            <div className="opencut-preview-state">
              <LoaderCircle className="spin" size={28} />
              <strong>正在打开已固化时间线修订</strong>
              <span>不会在预览内对账或切换修订</span>
            </div>
          )}
          {phase === 'error' && (
            <div className="opencut-preview-state error">
              <AlertTriangle size={28} />
              <strong>{renderFailure?.title ?? '预览准备失败'}</strong>
              <span>{error}</span>
              {renderFailure?.path && (
                <code>{renderFailure.code} · {renderFailure.path}</code>
              )}
              {renderFailure?.rescueRecommended && renderRescue && (
                <div className="opencut-preview-rescue" role="alert" aria-label="时间线渲染保真救援">
                  <strong>已拒绝不保真预览，原始 OpenCut 数据保持不变</strong>
                  <span>
                    未知 element、effect、mask 或动画不会被删除、扁平化或用近似效果替代。请先保存当前不可变修订的完整 JSON，再回到时间线人工处理。
                  </span>
                  <small>
                    修订 {timelineSnapshot.revision.id.slice(0, 8)} · ETag {timelineSnapshot.etag} · Schema v{timelineSnapshot.revision.schemaVersion}
                  </small>
                  <div>
                    <button className="button secondary" onClick={() => void copyRenderRescue()}>
                      <Copy size={14} />复制完整 JSON
                    </button>
                    <button className="button secondary" onClick={downloadRenderRescue}>
                      <Download size={14} />下载完整 JSON
                    </button>
                    <button className="button primary" onClick={onClose}>回到时间线检查</button>
                  </div>
                  {rescueFeedback && <em role="status">{rescueFeedback}</em>}
                </div>
              )}
              {renderFailure?.retryable && (
                <button className="button secondary" onClick={() => setReloadToken((value) => value + 1)}>
                  <RefreshCcw size={14} /> 重试
                </button>
              )}
            </div>
          )}
          {phase === 'ready' && session && (
            <>
              {session.repairedManagedAudioCount > 0 && (
                <div className="opencut-preview-warning" role="status">
                  <CheckCircle2 size={14} />
                  <span>
                    已按真实音频 Asset 时长安全收尾 {session.repairedManagedAudioCount} 个系统托管对白片段；
                    仅修复本次预览副本，未改写源音频或人工剪辑。
                  </span>
                </div>
              )}
              <section
                className="opencut-preview-stage"
                style={{
                  aspectRatio: episode.aspectRatio.replace(':', ' / '),
                  width: previewStageWidth(episode.aspectRatio),
                }}
              >
                {visualBinding?.elementType === 'image' && (
                  <>
                    <InvertedShapeMaskDefinition
                      id={inverseImageMaskId}
                      path={inverseImageMaskPath}
                    />
                    <div
                      className="opencut-preview-visual-shell"
                      style={{
                        clipPath: inverseImageMaskPath
                          ? `url(#${inverseImageMaskId})`
                          : visual
                            ? renderSemanticShapeMaskClipPath(visual)
                            : undefined,
                        opacity: visual
                          ? renderSemanticVisualOpacityAtFrame(visual, displayFrame)
                          : 1,
                      }}
                    >
                      <img
                        className="opencut-preview-media"
                        src={visualBinding.url}
                        style={{
                          objectFit: visual?.fit,
                          transform: visualScale === 1 ? undefined : `scale(${visualScale})`,
                        }}
                        alt="当前时间线镜头"
                        onError={() => setMediaError('当前分镜图无法解码')}
                      />
                    </div>
                  </>
                )}
                {visualBinding?.elementType === 'video' && (
                  <PreviewVideo
                    binding={visualBinding}
                    clip={visual as RenderSemanticVisualClip}
                    plan={session.plan}
                    playback={playback}
                    onError={setMediaError}
                  />
                )}
                {!visualBinding && (
                  <div className="opencut-preview-empty">
                    <Film size={30} />
                    <strong>当前时码没有可预览画面</strong>
                    <span>共享语义计划要求连续画面；若出现此状态，请重新载入修订。</span>
                  </div>
                )}
                {textCues.length > 0 && (
                  <div className="opencut-preview-subtitles" aria-live="off">
                    {textCues.map((cue) => <span key={cue.id}>{cue.text}</span>)}
                  </div>
                )}
                <div className="opencut-preview-watermark">共享语义预览 · RSP v{session.plan.version}</div>
              </section>

              {audioBindings.map(({ binding, clip }) => (
                <PreviewAudio
                  key={clip.id}
                  binding={binding}
                  clip={clip}
                  plan={session.plan}
                  playback={playback}
                  audioContext={audioContext}
                  onError={setMediaError}
                />
              ))}

              <section className="opencut-preview-transport">
                <button
                  className="opencut-preview-play"
                  onClick={() => void togglePlayback()}
                  disabled={playback.duration <= 0}
                  aria-label={playback.isPlaying ? '暂停预览' : '播放预览'}
                >
                  {playback.isPlaying
                    ? <Pause size={17} fill="currentColor" />
                    : <Play size={17} fill="currentColor" />}
                </button>
                <span className="opencut-preview-timecode">{timecode(playback.currentTime, fps)}</span>
                <input
                  className="opencut-preview-scrubber"
                  type="range"
                  min={0}
                  max={Math.max(1, playback.duration)}
                  step={Math.max(1, Math.round(OPEN_CUT_TICKS_PER_SECOND / fps))}
                  value={Math.min(playback.currentTime, Math.max(1, playback.duration))}
                  onPointerDown={() => session.editor.playback.setScrubbing(true)}
                  onPointerUp={() => session.editor.playback.setScrubbing(false)}
                  onChange={(event) => session.editor.playback.seek(Number(event.target.value))}
                  aria-label="预览播放头"
                />
                <span className="opencut-preview-timecode">{timecode(playback.duration, fps)}</span>
                <button
                  className="opencut-preview-volume-button"
                  onClick={() => session.editor.playback.toggleMute()}
                  aria-label={playback.muted ? '取消静音' : '静音'}
                >
                  {playback.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </button>
                <input
                  className="opencut-preview-volume"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={playback.muted ? 0 : playback.volume}
                  onChange={(event) => session.editor.playback.setVolume(Number(event.target.value))}
                  aria-label="预览音量"
                />
              </section>
            </>
          )}
        </main>

        <footer>
          <div className="opencut-preview-facts">
            <span>修订 <strong>{session?.timelineRevisionId.slice(0, 8) ?? '—'}</strong></span>
            <span>媒体 <strong>{resolvedVisualCount} 画面 / {audioBindings.length} 音频</strong></span>
            <span>语义 <strong>{session ? `${session.plan.totalFrames} 帧 @ ${session.plan.frameRate}fps` : '—'}</strong></span>
            <span className={missingCount ? 'warn' : ''}>未解析 <strong>{missingCount}</strong></span>
          </div>
          <p>
            当前预览与浏览器快导只消费同一个固化 RenderSemanticPlan：连续图片/视频、cover/contain、视频裁剪、OpenCut 透明度淡入淡出、矩形/椭圆遮罩、图片中心推拉、音轨裁剪/增益/淡化/角色/对白 ducking，以及不重叠字幕。
            贴纸、特效、其他蒙版、变速和未审核动画仍会在计划编译阶段直接拒绝，不会静默丢失。
          </p>
          {phase === 'ready' && session && (
            <div className="opencut-quick-export">
              <div className="opencut-quick-export-copy">
                <strong>浏览器快速审片 MP4</strong>
                <span>
                  {quickPhase === 'probing' && '正在探测 WebCodecs / Mediabunny H.264 能力…'}
                  {quickPhase === 'unsupported' && (quickSupport.reason ?? '当前浏览器不支持快导')}
                  {quickPhase === 'ready' && '720p · H.264/AAC · 资产字节 SHA-256 复核'}
                  {quickPhase === 'exporting' && `正在${quickProgress.phase === 'assets' ? '校验素材' : quickProgress.phase === 'audio' ? '混合音频' : quickProgress.phase === 'frames' ? '合成画面' : '封装 MP4'} · ${Math.round(quickProgress.progress * 100)}%`}
                  {quickPhase === 'succeeded' && '审片 MP4 已在本浏览器生成；正式发布仍走 FFmpeg + QC。'}
                  {quickPhase === 'error' && quickError}
                </span>
              </div>
              <div className="opencut-quick-export-actions">
                {quickPhase === 'exporting' ? (
                  <button
                    className="button secondary"
                    onClick={() => quickAbortRef.current?.abort()}
                  >
                    <Square size={12} /> 取消快导
                  </button>
                ) : (
                  <button
                    className="button secondary"
                    disabled={!quickSupport.supported || quickPhase === 'probing'}
                    onClick={() => void startQuickExport()}
                  >
                    <Film size={12} /> {quickPhase === 'succeeded' ? '重新快导' : '快速导出 MP4'}
                  </button>
                )}
                {quickUrl && (
                  <a
                    className="button primary"
                    href={quickUrl}
                    download={`${title.replace(/[<>:"/\\|?*]/g, '-').trim() || 'manju-review'}-${session.timelineRevisionId.slice(0, 8)}.mp4`}
                  >
                    <Download size={12} /> 下载审片版
                  </a>
                )}
              </div>
              {quickPhase === 'exporting' && (
                <div className="opencut-quick-export-progress" aria-label="浏览器快导进度">
                  <span style={{ width: `${Math.max(0, Math.min(100, quickProgress.progress * 100))}%` }} />
                </div>
              )}
            </div>
          )}
          {(mediaError || (phase === 'ready' && missingCount > 0)) && (
            <div className="opencut-preview-warning">
              <AlertTriangle size={13} />
              <span>{mediaError || `${missingCount} 个时间线媒体引用未通过安全解析，对应片段将保持黑场。`}</span>
            </div>
          )}
        </footer>
      </div>
    </div>
  )
}
