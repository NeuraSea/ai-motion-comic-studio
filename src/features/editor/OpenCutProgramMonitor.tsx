import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  OPEN_CUT_TICKS_PER_SECOND,
  renderSemanticVisualOpacityAtFrame,
  renderSemanticVisualScaleAtFrame,
  type EditorSceneTracks,
  type OpenCutCommandEditor,
  type OpenCutPlaybackSnapshot,
  type RenderSemanticAudioClip,
  type RenderSemanticPlan,
  type RenderSemanticVisualClip,
} from '@manju/opencut-editor'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Film,
  LoaderCircle,
  Pause,
  Play,
  RefreshCcw,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { ApiError, api, type MediaAsset } from '../../lib'
import { semanticAudioGainAtSeconds } from './browser-quick-export'
import type { TimelineMediaBinding } from './manju-media-resolver'
import {
  createLiveRenderSemanticSession,
  type PinnedRenderSemanticSession,
} from './render-semantic-session'
import {
  renderSemanticInvertedShapeMaskPath,
  renderSemanticShapeMaskClipPath,
} from './visual-shape-mask'
import './OpenCutProgramMonitor.css'

export interface OpenCutProgramMonitorHandle {
  /** Returns false when no render-safe program session is available. */
  toggleProgramPlayback(): Promise<boolean>
}

interface OpenCutProgramMonitorProps {
  expanded: boolean
  onToggleExpanded: () => void
  editor: OpenCutCommandEditor
  tracks: EditorSceneTracks
  playback: OpenCutPlaybackSnapshot
  programEnabled: boolean
  onProgramEnabledChange: (enabled: boolean) => void
  onReadyChange?: (ready: boolean) => void
  scope: {
    projectId: string
    episodeId: string
    sourceRevisionId: string | null
    aspectRatio: string
    assetRevisionKey: string
    timelineDocumentId: string
    timelineRevisionId: string
    baseDocument: Record<string, unknown>
  } | null
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

function playbackErrorMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : fallback
  return /user didn't interact|notallowederror|not allowed by the user agent/i.test(message)
    ? '浏览器尚未授权声音输出；请再点击一次“节目”播放。'
    : message
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

function InvertedShapeMaskDefinition({ id, path }: { id: string; path?: string }) {
  if (!path) return null
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" className="program-monitor-mask-definition">
      <defs>
        <clipPath id={id} clipPathUnits="objectBoundingBox">
          <path d={path} fillRule="evenodd" clipRule="evenodd" />
        </clipPath>
      </defs>
    </svg>
  )
}

function ProgramVideo({
  binding,
  clip,
  plan,
  playback,
  programEnabled,
  onError,
}: {
  binding: TimelineMediaBinding
  clip: RenderSemanticVisualClip
  plan: RenderSemanticPlan
  playback: OpenCutPlaybackSnapshot
  programEnabled: boolean
  onError: (message: string) => void
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const inverseMaskId = `program-video-mask-${useId().replace(/:/g, '')}`
  const inverseMaskPath = renderSemanticInvertedShapeMaskPath(clip)
  const timelineSeconds = playback.currentTime / plan.ticksPerSecond
  const active = timelineSeconds >= clip.startFrame / plan.frameRate
    && timelineSeconds < clip.endFrameExclusive / plan.frameRate
  const opacityFrame = Math.max(
    clip.startFrame,
    Math.min(clip.endFrameExclusive - 1, Math.floor(timelineSeconds * plan.frameRate)),
  )

  useEffect(() => {
    const video = ref.current
    if (!video) return
    video.muted = true
    video.volume = 0
    video.playbackRate = 1
    synchronizeMediaTime(video, clip, plan, playback.currentTime)
    if (programEnabled && playback.isPlaying && active) {
      void video.play().catch((cause: unknown) => {
        onError(playbackErrorMessage(cause, '浏览器拒绝播放当前视频'))
      })
    } else {
      video.pause()
    }
  }, [active, clip, onError, plan, playback, programEnabled])

  return (
    <>
      <InvertedShapeMaskDefinition id={inverseMaskId} path={inverseMaskPath} />
      <video
        ref={ref}
        className="program-monitor-media"
        src={binding.url}
        style={{
          objectFit: clip.fit,
          opacity: renderSemanticVisualOpacityAtFrame(clip, opacityFrame),
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
        aria-label="节目监看器当前视频"
      />
    </>
  )
}

function ProgramAudio({
  binding,
  clip,
  plan,
  playback,
  programEnabled,
  audioContext,
  onElementChange,
  onError,
}: {
  binding: TimelineMediaBinding
  clip: RenderSemanticAudioClip
  plan: RenderSemanticPlan
  playback: OpenCutPlaybackSnapshot
  programEnabled: boolean
  audioContext: AudioContext | null
  onElementChange: (clipId: string, element: HTMLAudioElement | null) => void
  onError: (message: string) => void
}) {
  const ref = useRef<HTMLAudioElement>(null)
  const gainRef = useRef<GainNode | null>(null)
  const timelineSeconds = playback.currentTime / plan.ticksPerSecond
  const active = timelineSeconds >= clip.startFrame / plan.frameRate
    && timelineSeconds < clip.endFrameExclusive / plan.frameRate

  useEffect(() => {
    onElementChange(clip.id, ref.current)
    return () => onElementChange(clip.id, null)
  }, [clip.id, onElementChange])

  useEffect(() => {
    const audio = ref.current
    if (!audio || !audioContext) return
    const source = audioContext.createMediaElementSource(audio)
    const gain = audioContext.createGain()
    source.connect(gain)
    gain.connect(audioContext.destination)
    gainRef.current = gain
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
    const gain = semanticAudioGainAtSeconds(clip, timelineSeconds, plan.frameRate)
    if (gainRef.current) {
      gainRef.current.gain.value = playback.muted ? 0 : playback.volume * gain
    }
    if (programEnabled && playback.isPlaying && active && audioContext) {
      void audio.play().catch((cause: unknown) => {
        onError(playbackErrorMessage(cause, '浏览器拒绝播放时间线音频'))
      })
    } else {
      audio.pause()
    }
  }, [active, audioContext, clip, onError, plan, playback, programEnabled, timelineSeconds])

  return (
    <audio
      ref={ref}
      className="program-monitor-audio"
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

export const OpenCutProgramMonitor = forwardRef<
  OpenCutProgramMonitorHandle,
  OpenCutProgramMonitorProps
>(function OpenCutProgramMonitor({
  expanded,
  onToggleExpanded,
  editor,
  tracks,
  playback,
  programEnabled,
  onProgramEnabledChange,
  onReadyChange,
  scope,
}, ref) {
  const inverseImageMaskId = `program-image-mask-${useId().replace(/:/g, '')}`
  const [assets, setAssets] = useState<MediaAsset[] | null>(null)
  const [assetError, setAssetError] = useState('')
  const [assetReload, setAssetReload] = useState(0)
  const [mediaError, setMediaError] = useState('')
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioElementsRef = useRef(new Map<string, HTMLAudioElement>())

  useEffect(() => {
    setAssets(null)
    setAssetError('')
    setMediaError('')
    if (!scope) return
    const controller = new AbortController()
    void api.listAssets(scope.projectId, {
      episodeId: scope.episodeId,
      includeProjectAssets: true,
      signal: controller.signal,
    }).then(setAssets).catch((cause: unknown) => {
      if (controller.signal.aborted
        || (cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) return
      setAssetError(cause instanceof Error ? cause.message : '节目监看器无法读取媒体资产')
    })
    return () => controller.abort()
  }, [assetReload, scope?.assetRevisionKey, scope?.episodeId, scope?.projectId])

  const compiled = useMemo<{
    session: PinnedRenderSemanticSession | null
    error: string
  }>(() => {
    if (!scope || !assets) return { session: null, error: '' }
    try {
      return {
        session: createLiveRenderSemanticSession({
          projectId: scope.projectId,
          episodeId: scope.episodeId,
          sourceRevisionId: scope.sourceRevisionId,
          aspectRatio: scope.aspectRatio,
          timelineDocumentId: scope.timelineDocumentId,
          timelineRevisionId: scope.timelineRevisionId,
          tracks,
          baseDocument: scope.baseDocument,
          assets,
        }),
        error: '',
      }
    } catch (cause) {
      return {
        session: null,
        error: cause instanceof Error ? cause.message : '当前 OpenCut 状态无法安全监看',
      }
    }
  }, [assets, scope, tracks])
  const session = compiled.session
  const ready = session !== null

  useEffect(() => {
    onReadyChange?.(ready)
    return () => onReadyChange?.(false)
  }, [onReadyChange, ready])

  useEffect(() => {
    if (!session || session.plan.audioClips.length === 0 || audioContextRef.current) return
    const Constructor = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Constructor) return
    // Prepare the graph while the monitor is idle. The context remains
    // suspended until the explicit program-play gesture resumes it.
    const context = new Constructor()
    audioContextRef.current = context
    setAudioContext(context)
  }, [session])

  useEffect(() => () => {
    const context = audioContextRef.current
    audioContextRef.current = null
    if (context) void context.close()
  }, [])

  const ensureAudioContext = useCallback((): boolean => {
    if (!session || session.plan.audioClips.length === 0) return true
    let context = audioContextRef.current
    if (!context) {
      const Constructor = window.AudioContext
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Constructor) {
        setMediaError('当前浏览器不支持 Web Audio 语义混音')
        return false
      }
      context = new Constructor()
      audioContextRef.current = context
      setAudioContext(context)
    }
    void context.resume().catch((cause: unknown) => {
      setMediaError(cause instanceof Error ? cause.message : '浏览器拒绝启用音频输出')
    })
    return true
  }, [session])

  const registerAudioElement = useCallback((clipId: string, element: HTMLAudioElement | null) => {
    if (element) audioElementsRef.current.set(clipId, element)
    else audioElementsRef.current.delete(clipId)
  }, [])

  const toggleProgramPlayback = useCallback(async (): Promise<boolean> => {
    if (!session) {
      setMediaError(assetError || compiled.error || '节目监看器尚未准备完成')
      return false
    }
    setMediaError('')
    if (playback.isPlaying && programEnabled) {
      editor.playback.pause()
      return true
    }
    if (!ensureAudioContext()) return false
    // HTML media playback must also be initiated inside the explicit user
    // gesture. Prime every currently active audio element before React state
    // propagates the shared playback snapshot; later effects keep it synced.
    const timelineSeconds = playback.currentTime / session.plan.ticksPerSecond
    session.plan.audioClips.forEach((clip) => {
      const active = timelineSeconds >= clip.startFrame / session.plan.frameRate
        && timelineSeconds < clip.endFrameExclusive / session.plan.frameRate
      const audio = audioElementsRef.current.get(clip.id)
      if (!active || !audio) return
      synchronizeMediaTime(audio, clip, session.plan, playback.currentTime)
      void audio.play().catch((cause: unknown) => {
        setMediaError(playbackErrorMessage(cause, '浏览器拒绝播放时间线音频'))
      })
    })
    onProgramEnabledChange(true)
    if (!playback.isPlaying) editor.playback.toggle()
    return true
  }, [assetError, compiled.error, editor, ensureAudioContext, onProgramEnabledChange, playback.isPlaying, programEnabled, session])

  useImperativeHandle(ref, () => ({ toggleProgramPlayback }), [toggleProgramPlayback])

  const displayTime = playback.duration > 0
    ? Math.min(playback.currentTime, playback.duration - 1)
    : 0
  const displayFrame = session
    ? Math.min(
        Math.max(0, session.plan.totalFrames - 1),
        Math.max(0, Math.floor(displayTime * session.plan.frameRate / session.plan.ticksPerSecond)),
      )
    : 0
  const visual = session?.plan.visualClips.find((clip) => (
    clip.startFrame <= displayFrame && displayFrame < clip.endFrameExclusive
  )) ?? null
  const visualBinding = visual && session
    ? session.media.bindings.find((binding) => (
        binding.elementId === visual.id && binding.assetId === visual.asset.assetId
      )) ?? null
    : null
  const visualScale = visual ? renderSemanticVisualScaleAtFrame(visual, displayFrame) : 1
  const inverseImageMaskPath = visual
    ? renderSemanticInvertedShapeMaskPath(visual)
    : undefined
  const subtitles = session?.plan.subtitleCues.filter((cue) => (
    cue.startFrame <= displayFrame && displayFrame < cue.endFrameExclusive
  )) ?? []
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
  const error = assetError || compiled.error || mediaError

  return (
    <section className={`program-monitor ${expanded ? 'expanded' : 'collapsed'}`} aria-label="OpenCut 节目监看器">
      <header>
        <div>
          <Film size={14} />
          <span><strong>节目监看器</strong><small>画面 · 对白 · 原视频音效 · 字幕</small></span>
        </div>
        <div>
          {session && <span className="program-monitor-facts">{session.plan.visualClips.length} 画面 · {audioBindings.length} 音频 · {session.plan.subtitleCues.length} 字幕</span>}
          <button type="button" onClick={onToggleExpanded} aria-label={expanded ? '收起节目监看器' : '展开节目监看器'}>
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>
      </header>

      {audioBindings.map(({ binding, clip }) => (
        <ProgramAudio
          key={clip.id}
          binding={binding}
          clip={clip}
          plan={session!.plan}
          playback={playback}
          programEnabled={programEnabled}
          audioContext={audioContext}
          onElementChange={registerAudioElement}
          onError={setMediaError}
        />
      ))}

      {expanded && (
        <div className="program-monitor-body">
          {!scope || (!assets && !assetError) ? (
            <div className="program-monitor-state"><LoaderCircle className="spin" size={20} /><span>正在接入当前 OpenCut 修订…</span></div>
          ) : error && !session ? (
            <div className="program-monitor-state error" role="alert">
              <AlertTriangle size={20} />
              <span><strong>监看准备失败</strong><small>{error}</small></span>
              <button type="button" onClick={() => setAssetReload((value) => value + 1)}><RefreshCcw size={12} />重试</button>
            </div>
          ) : session ? (
            <>
              <div className="program-monitor-stage" style={{ aspectRatio: scope.aspectRatio.replace(':', ' / ') }}>
                {visualBinding?.elementType === 'image' && visual && (
                  <>
                    <InvertedShapeMaskDefinition id={inverseImageMaskId} path={inverseImageMaskPath} />
                    <div
                      className="program-monitor-visual-shell"
                      style={{
                        clipPath: inverseImageMaskPath
                          ? `url(#${inverseImageMaskId})`
                          : renderSemanticShapeMaskClipPath(visual),
                        opacity: renderSemanticVisualOpacityAtFrame(visual, displayFrame),
                      }}
                    >
                      <img
                        className="program-monitor-media"
                        src={visualBinding.url}
                        style={{
                          objectFit: visual.fit,
                          transform: visualScale === 1 ? undefined : `scale(${visualScale})`,
                        }}
                        alt="节目监看器当前镜头"
                        onError={() => setMediaError('当前分镜图无法解码')}
                      />
                    </div>
                  </>
                )}
                {visualBinding?.elementType === 'video' && visual && (
                  <ProgramVideo
                    binding={visualBinding}
                    clip={visual}
                    plan={session.plan}
                    playback={playback}
                    programEnabled={programEnabled}
                    onError={setMediaError}
                  />
                )}
                {!visualBinding && (
                  <div className="program-monitor-empty"><Film size={26} /><strong>当前时码没有画面</strong></div>
                )}
                {subtitles.length > 0 && (
                  <div className="program-monitor-subtitles" aria-live="off">
                    {subtitles.map((cue) => <span key={cue.id}>{cue.text}</span>)}
                  </div>
                )}
                <span className="program-monitor-badge">LIVE EDIT · RSP v{session.plan.version}</span>
              </div>
              <div className="program-monitor-transport">
                <button
                  type="button"
                  className="program-monitor-play"
                  onClick={() => void toggleProgramPlayback()}
                  aria-label={playback.isPlaying && programEnabled ? '暂停节目' : '播放节目'}
                >
                  {playback.isPlaying && programEnabled
                    ? <Pause size={15} fill="currentColor" />
                    : <Play size={15} fill="currentColor" />}
                </button>
                <span>{timecode(playback.currentTime, fps)}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, playback.duration)}
                  step={Math.max(1, Math.round(OPEN_CUT_TICKS_PER_SECOND / fps))}
                  value={Math.min(playback.currentTime, Math.max(1, playback.duration))}
                  onPointerDown={() => editor.playback.setScrubbing(true)}
                  onPointerUp={() => editor.playback.setScrubbing(false)}
                  onChange={(event) => editor.playback.seek(Number(event.target.value))}
                  aria-label="节目监看器播放头"
                />
                <span>{timecode(playback.duration, fps)}</span>
                <button type="button" onClick={() => editor.playback.toggleMute()} aria-label={playback.muted ? '取消节目静音' : '节目静音'}>
                  {playback.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                </button>
                <input
                  className="program-monitor-volume"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={playback.muted ? 0 : playback.volume}
                  onChange={(event) => editor.playback.setVolume(Number(event.target.value))}
                  aria-label="节目监看器音量"
                />
              </div>
              {mediaError && <div className="program-monitor-media-error" role="alert"><AlertTriangle size={12} />{mediaError}</div>}
            </>
          ) : null}
        </div>
      )}
    </section>
  )
})
