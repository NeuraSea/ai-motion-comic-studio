import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  CircleDashed,
  Mic2,
  RefreshCcw,
  Search,
  Settings2,
  Sparkles,
  Volume2,
} from 'lucide-react'

import {
  ApiError,
  api,
  type CharacterVoiceProfileMutationResponse,
  type CharacterVoicePreviewJob,
  type CharacterVoiceRecommendation,
  type CharacterVoiceRecommendationJob,
  type MiniMaxVoiceCatalog,
  type MiniMaxVoiceCatalogEntry,
  type PublicPaidAigcConfirmation,
  type ProviderConnection,
  type StoryCharacter,
  type StoryDocument,
} from '../../lib'
import { PaidAigcConfirmationDialog } from '../paid-aigc/PaidAigcConfirmationDialog'
import { VoicePreviewReviewControl } from './VoicePreviewReviewControl'
import {
  createAudioPlaybackEvidence,
  type VoicePreviewPlaybackEvidence,
} from './voice-preview-playback'
import {
  filterMiniMaxVoices,
  characterVoiceProfileConfirmationInput,
  findCatalogVoice,
  isVoiceProfileCurrentForCatalog,
  recommendationCanBeConfirmed,
  resolveCharacterVoiceDelivery,
  VOICE_EMOTION_LABELS,
  VOICE_TYPE_LABELS,
} from './voice-casting-state'
import {
  providerStatusDetail,
  providerUiConnectionState,
} from '../providers/provider-ui-state'
import {
  confirmationMatchesVoicePaidAttempt,
  freezeCharacterVoicePreviewAttempt,
  freezeCharacterVoiceRecommendationAttempt,
  type FrozenCharacterVoicePreviewAttempt,
  type FrozenCharacterVoiceRecommendationAttempt,
} from './voice-paid-confirmation-state'
import './CharacterVoiceCastingCard.css'

export interface VoiceCatalogState {
  status: 'blocked' | 'loading' | 'ready' | 'error'
  catalog: MiniMaxVoiceCatalog | null
  error: string
}

export function speechProviderDisplayName(providerId: string, uppercase = false): string {
  const label = providerId === 'indextts-speech'
    ? 'IndexTTS'
    : providerId === 'doubao-speech'
      ? '豆包语音'
      : 'MiniMax'
  return uppercase ? label.toUpperCase() : label
}

function providerCatalogBlockReason(provider: ProviderConnection | null): string | null {
  if (!provider) return '尚未配置支持声线目录的语音 Provider。'
  if ((provider.id !== 'minimax-speech' || provider.adapter !== 'minimax')
    && (provider.id !== 'indextts-speech' || provider.adapter !== 'indextts')
    && (provider.id !== 'doubao-speech' || provider.adapter !== 'doubao-speech')) {
    return '当前语音 Provider 不提供可验证的声线目录。'
  }
  const state = providerUiConnectionState(provider)
  if (state === 'connected') return null
  if (state === 'untested') return '语音 Provider 已保存，但尚未测试连接。'
  return providerStatusDetail(provider)
}

export function useMiniMaxVoiceCatalog(provider: ProviderConnection | null): {
  state: VoiceCatalogState
  reload: () => void
} {
  const [reloadIndex, setReloadIndex] = useState(0)
  const [state, setState] = useState<VoiceCatalogState>(() => ({
    status: providerCatalogBlockReason(provider) ? 'blocked' : 'loading',
    catalog: null,
    error: providerCatalogBlockReason(provider) ?? '',
  }))
  const reload = useCallback(() => setReloadIndex((value) => value + 1), [])

  useEffect(() => {
    const blocked = providerCatalogBlockReason(provider)
    if (blocked) {
      setState({ status: 'blocked', catalog: null, error: blocked })
      return
    }
    const controller = new AbortController()
    setState((current) => ({ ...current, status: 'loading', error: '' }))
    void api.listSpeechVoices(provider!.id as 'minimax-speech' | 'indextts-speech' | 'doubao-speech', {
      signal: controller.signal,
    }).then((catalog) => {
      setState({ status: 'ready', catalog, error: '' })
    }).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.code === 'REQUEST_ABORTED')) {
        setState({
          status: 'error',
          catalog: null,
          error: error instanceof Error ? error.message : '无法读取语音 Provider 声线目录',
        })
      }
    })
    return () => controller.abort()
  }, [provider?.configRevision, provider?.health.status, provider?.id, reloadIndex])

  return { state, reload }
}

export function VoiceCatalogBrowser({
  state,
  value,
  onChange,
  onReload,
  compact = false,
}: {
  state: VoiceCatalogState
  value: string | null
  onChange: (voice: MiniMaxVoiceCatalogEntry) => void
  onReload: () => void
  compact?: boolean
}) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => (
    filterMiniMaxVoices(state.catalog?.voices ?? [], query)
  ), [query, state.catalog?.voices])
  const visible = filtered.slice(0, compact ? 30 : 60)

  if (state.status === 'blocked' || state.status === 'error') {
    return (
      <div className={`voice-catalog-message ${state.status}`}>
        <AlertTriangle size={15} />
        <span>{state.error}</span>
        {state.status === 'error' && <button onClick={onReload}><RefreshCcw size={12} />重试目录</button>}
      </div>
    )
  }
  if (state.status === 'loading') {
    return <div className="voice-catalog-message"><CircleDashed size={15} />正在读取当前 Provider 的真实声线…</div>
  }
  return (
    <div className={`voice-catalog-browser ${compact ? 'compact' : ''}`}>
      <label className="voice-catalog-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索音色名称、描述或类型"
          aria-label="搜索 Provider 声线"
        />
        <span>{filtered.length}/{state.catalog?.voices.length ?? 0}</span>
      </label>
      <div className="voice-catalog-list" role="listbox" aria-label="Provider 声线目录">
        {visible.map((voice) => (
          <button
            type="button"
            role="option"
            aria-selected={voice.voiceId === value}
            className={voice.voiceId === value ? 'selected' : ''}
            key={voice.voiceId}
            onClick={() => onChange(voice)}
          >
            <span className="voice-catalog-icon"><Volume2 size={14} /></span>
            <span className="voice-catalog-copy">
              <strong>{voice.name}</strong>
              <small>{voice.descriptions[0] || 'Provider 未提供音色描述'}</small>
              <i>{VOICE_TYPE_LABELS[voice.type]}</i>
            </span>
            {voice.voiceId === value && <Check size={15} />}
          </button>
        ))}
        {visible.length === 0 && <div className="voice-catalog-empty">当前真实目录中没有匹配项</div>}
      </div>
      {filtered.length > visible.length && (
        <small className="voice-catalog-limit">继续缩小搜索范围以查看其余 {filtered.length - visible.length} 个音色。</small>
      )}
      <footer>
        <span>目录 r{state.catalog?.provider.configRevision} · 仅读取，不生成语音</span>
        <button type="button" onClick={onReload}><RefreshCcw size={11} />刷新</button>
      </footer>
    </div>
  )
}

function VoiceProfileSummary({
  character,
  story,
}: {
  character: StoryCharacter
  story: StoryDocument
}) {
  const profile = character.voiceProfile
  if (!profile) {
    return (
      <div className="voice-profile-empty">
        <Mic2 size={18} />
        <div><strong>尚未绑定角色声线</strong><span>配音阶段不会再要求手工猜 voice_id；请从真实账号目录选择或使用 AI 选角。</span></div>
      </div>
    )
  }
  const delivery = resolveCharacterVoiceDelivery(profile, null)
  return (
    <div className="voice-profile-summary">
      <div className="voice-profile-heading">
        <span className="voice-profile-avatar"><Volume2 size={16} /></span>
        <div>
          <small>当前角色声线</small>
          <strong>{profile.voiceName}</strong>
          <span>{VOICE_TYPE_LABELS[profile.voiceType]} · Provider r{profile.providerConfigRevision}</span>
        </div>
        <em className={profile.selectionSource}>{profile.selectionSource === 'agentic' ? 'AI 选角' : '手动选择'}</em>
      </div>
      {profile.descriptions[0] && <p>{profile.descriptions[0]}</p>}
      {profile.selectionRationale && <blockquote>{profile.selectionRationale}</blockquote>}
      <div className="voice-profile-tags">
        {profile.profileTags?.map((tag) => <span key={tag}>{tag}</span>)}
        <span>{VOICE_EMOTION_LABELS[delivery.delivery.emotion]}</span>
        <span>{delivery.delivery.speed.toFixed(2)}×</span>
        <span>{delivery.delivery.pitch > 0 ? '+' : ''}{delivery.delivery.pitch} 半音</span>
      </div>
      {profile.sceneDirections && profile.sceneDirections.length > 0 && (
        <div className="voice-scene-directions">
          <small className="voice-scene-count">已为 {profile.sceneDirections.length} 个场景保存表演指令；基础音色保持不变。</small>
          {profile.sceneDirections.map((direction) => (
            <div key={direction.sceneId}>
              <strong>{story.scenes.find((scene) => scene.id === direction.sceneId)?.title ?? '历史场景'}</strong>
              <span>{VOICE_EMOTION_LABELS[direction.emotion]} · {direction.speed.toFixed(2)}× · {direction.pitch > 0 ? '+' : ''}{direction.pitch} 半音</span>
              <small>{direction.rationale}</small>
            </div>
          ))}
        </div>
      )}
      {profile.historicalPin && (
        <div className="voice-profile-warning"><AlertTriangle size={13} />该绑定是历史固化版本，当前目录可能已不可用；重新合成前请复核。</div>
      )}
    </div>
  )
}

function RecommendationResult({
  recommendation,
  catalog,
  selectedVoiceId,
  onSelect,
}: {
  recommendation: CharacterVoiceRecommendation
  catalog: MiniMaxVoiceCatalog | null
  selectedVoiceId: string
  onSelect: (voiceId: string) => void
}) {
  const candidates = [{
    voiceId: recommendation.selectedVoiceId,
    rationale: recommendation.rationale,
    primary: true,
  }, ...recommendation.alternatives.map((alternative) => ({ ...alternative, primary: false }))]
  return (
    <div className="voice-recommendation-result">
      <header><Sparkles size={15} /><div><strong>选角建议</strong><span>1 个主选 · {recommendation.alternatives.length} 个备选 · 不使用虚构分数</span></div></header>
      <div className="voice-recommendation-candidates">
        {candidates.map((candidate) => {
          const voice = findCatalogVoice(catalog?.voices ?? [], candidate.voiceId)
          return (
            <button
              type="button"
              key={candidate.voiceId}
              className={selectedVoiceId === candidate.voiceId ? 'selected' : ''}
              onClick={() => onSelect(candidate.voiceId)}
              disabled={!voice}
            >
              <span>{candidate.primary ? '主选' : '备选'}</span>
              <div><strong>{voice?.name ?? '目录已变化'}</strong><small>{candidate.rationale}</small></div>
              {selectedVoiceId === candidate.voiceId && <Check size={15} />}
            </button>
          )
        })}
      </div>
      <div className="voice-profile-tags">{recommendation.profileTags.map((tag) => <span key={tag}>{tag}</span>)}</div>
    </div>
  )
}

function VoicePreviewControl({
  projectId,
  episodeId,
  episodeEtag,
  characterId,
  sourceRevisionId,
  voice,
  catalog,
}: {
  projectId: string
  episodeId: string
  episodeEtag: string
  characterId: string
  sourceRevisionId: string
  voice: MiniMaxVoiceCatalogEntry
  catalog: MiniMaxVoiceCatalog
}) {
  const [job, setJob] = useState<CharacterVoicePreviewJob | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [pollTick, setPollTick] = useState(0)
  const [error, setError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [preflighting, setPreflighting] = useState(false)
  const [confirmationBusy, setConfirmationBusy] = useState(false)
  const [confirmationError, setConfirmationError] = useState('')
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    attempt: FrozenCharacterVoicePreviewAttempt
    confirmation: PublicPaidAigcConfirmation
  } | null>(null)
  const [playbackEvidence, setPlaybackEvidence] = useState<{
    jobId: string
    value: VoicePreviewPlaybackEvidence
  } | null>(null)
  const [playbackIncompleteJobId, setPlaybackIncompleteJobId] = useState<string | null>(null)
  const attempt = useRef<FrozenCharacterVoicePreviewAttempt | null>(null)
  const audioElement = useRef<HTMLAudioElement | null>(null)
  const active = Boolean(job && ['queued', 'running', 'waiting_provider'].includes(job.status))

  useEffect(() => () => {
    // Candidate changes remount this control. Explicitly stop and detach the
    // prior source so a previously selected voice can never keep playing.
    audioElement.current?.pause()
    audioElement.current?.removeAttribute('src')
    audioElement.current?.load()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setRestoring(true)
    setJob(null)
    setError('')
    setPendingConfirmation(null)
    setConfirmationError('')
    setPlaybackEvidence(null)
    setPlaybackIncompleteJobId(null)
    attempt.current = null
    void api.listCharacterVoicePreviewJobs(projectId, { limit: 100, signal: controller.signal })
      .then((jobs) => {
        const restored = jobs.find((candidate) => (
          candidate.input.episodeId === episodeId
          && candidate.input.characterId === characterId
          && candidate.input.voiceId === voice.voiceId
        )) ?? null
        setJob(restored)
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) {
          setError(cause instanceof Error ? cause.message : '无法恢复已保存的试听任务')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false)
      })
    return () => controller.abort()
  }, [characterId, episodeId, projectId, voice.voiceId])

  useEffect(() => {
    if (!job || !['queued', 'running', 'waiting_provider'].includes(job.status)) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void api.getCharacterVoicePreviewJob(job.id, { signal: controller.signal })
        .then((updated) => {
          setJob(updated)
          if (updated.status === 'succeeded') {
            setError('')
            attempt.current = null
          } else if (updated.status === 'failed' || updated.status === 'cancelled') {
            setError(updated.error?.message ?? '声线试听任务未完成')
            attempt.current = null
          }
        })
        .catch((cause: unknown) => {
          if (!(cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) {
            setError(cause instanceof Error ? cause.message : '无法刷新声线试听任务')
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setPollTick((value) => value + 1)
        })
    }, 800)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [job, pollTick])

  const acceptCreatedJob = (created: CharacterVoicePreviewJob) => {
    setJob(created)
    setPlaybackEvidence(null)
    setPlaybackIncompleteJobId(null)
    setPendingConfirmation(null)
    setConfirmationError('')
    // A typed durable Job is the acknowledgement boundary. From here polling
    // is Job-ID based and a later explicit regeneration must receive a new key.
    attempt.current = null
    if (created.status === 'failed' || created.status === 'cancelled') {
      setError(created.error?.message ?? '声线试听任务未完成')
    }
  }

  const preflightAttempt = async (currentAttempt: FrozenCharacterVoicePreviewAttempt) => {
    const confirmation = await api.preflightCharacterVoicePreview(
      currentAttempt.episodeId,
      currentAttempt.characterId,
      currentAttempt.input,
      currentAttempt.episodeEtag,
      currentAttempt.idempotencyKey,
    )
    if (!confirmationMatchesVoicePaidAttempt(currentAttempt, confirmation)) {
      throw new ApiError('角色声线试听的计费确认已过期或与当前请求不匹配。', {
        code: 'PAID_CONFIRMATION_REQUIRED',
      })
    }
    setPendingConfirmation({ attempt: currentAttempt, confirmation })
  }

  const startPreview = async () => {
    if (active || restoring || preflighting || pendingConfirmation) return
    const signature = [
      projectId,
      episodeId,
      episodeEtag,
      characterId,
      sourceRevisionId,
      voice.voiceId,
      catalog.provider.configRevision,
      catalog.fingerprint,
    ].join(':')
    const currentAttempt = attempt.current?.signature === signature
      ? attempt.current
      : freezeCharacterVoicePreviewAttempt({
          signature,
          episodeId,
          episodeEtag,
          characterId,
          idempotencyKey: crypto.randomUUID(),
          request: {
            projectId,
            providerId: catalog.provider.id,
            voiceId: voice.voiceId,
            expectedCatalogFingerprint: catalog.fingerprint,
          },
        })
    attempt.current = currentAttempt
    setError('')
    setPreflighting(true)
    try {
      await preflightAttempt(currentAttempt)
    } catch (cause) {
      if (attempt.current === currentAttempt) attempt.current = null
      setError(cause instanceof Error ? cause.message : '无法预检声线试听任务')
    } finally {
      setPreflighting(false)
    }
  }

  const cancelConfirmation = () => {
    if (confirmationBusy) return
    setPendingConfirmation(null)
    setConfirmationError('')
    attempt.current = null
  }

  const refreshConfirmation = async () => {
    if (!pendingConfirmation || confirmationBusy) return
    setConfirmationBusy(true)
    setConfirmationError('')
    try {
      await preflightAttempt(pendingConfirmation.attempt)
    } catch (cause) {
      setConfirmationError(cause instanceof Error ? cause.message : '无法重新预检声线试听')
    } finally {
      setConfirmationBusy(false)
    }
  }

  const confirmPreview = async () => {
    if (!pendingConfirmation || confirmationBusy) return
    const { attempt: confirmedAttempt, confirmation } = pendingConfirmation
    if (!confirmationMatchesVoicePaidAttempt(confirmedAttempt, confirmation)) {
      await refreshConfirmation()
      return
    }
    setConfirmationBusy(true)
    setConfirmationError('')
    try {
      const created = await api.createCharacterVoicePreview(
        confirmedAttempt.episodeId,
        confirmedAttempt.characterId,
        confirmedAttempt.input,
        confirmedAttempt.episodeEtag,
        confirmedAttempt.idempotencyKey,
        confirmation.confirmationToken,
      )
      acceptCreatedJob(created)
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'PAID_CONFIRMATION_REQUIRED') {
        try {
          const refreshed = api.parsePaidAigcConfirmationRequiredError(
            cause,
            'character.voice.preview',
          )
          setPendingConfirmation({ attempt: confirmedAttempt, confirmation: refreshed })
          setConfirmationError('服务端已重新核定本次任务；尚未建单，请再次明确确认。')
        } catch (parseError) {
          setConfirmationError(parseError instanceof Error ? parseError.message : '计费确认响应无效')
        }
      } else if (!(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500) {
        setConfirmationError(`${cause instanceof Error ? cause.message : '请求结果未知'}。如重试，将复用同一 Idempotency-Key，不会创建第二个付费任务。`)
      } else {
        setPendingConfirmation(null)
        attempt.current = null
        setError(cause instanceof Error ? cause.message : '无法创建声线试听任务')
      }
    } finally {
      setConfirmationBusy(false)
    }
  }

  const cancelPreview = async () => {
    if (!job || !active || cancelling) return
    setCancelling(true)
    setError('')
    try {
      await api.cancelGenerationJob(job.id)
      const updated = await api.getCharacterVoicePreviewJob(job.id)
      setJob(updated)
      if (updated.status === 'failed' || updated.status === 'cancelled') {
        attempt.current = null
        setError(updated.error?.message ?? '已停止本地试听处理')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法停止声线试听任务')
    } finally {
      setCancelling(false)
    }
  }

  const statusLabel = job?.status === 'queued'
    ? '等待试听队列'
    : job?.status === 'running'
      ? '准备试听'
      : job?.status === 'waiting_provider'
        ? `${speechProviderDisplayName(catalog.provider.id)} 正在合成试听`
        : null
  const historical = Boolean(job && (
    job.input.expectedStoryRevisionId !== sourceRevisionId
    || job.input.expectedCatalogFingerprint !== catalog.fingerprint
    || job.input.expectedProviderConfigRevision !== catalog.provider.configRevision
  ))

  return (
    <section className="voice-preview-control" aria-label={`${voice.name}声线试听`}>
      <div className="voice-preview-copy">
        <strong><Volume2 size={14} />试听「{voice.name}」</strong>
        <span>试听会调用当前语音 Provider；仅生成独立试听音频，不会保存角色声线或绑定正式台词。</span>
      </div>
      {restoring ? (
        <div className="voice-preview-status"><CircleDashed size={13} />正在查找本地已保存的试听…</div>
      ) : job?.status === 'succeeded' && job.output ? (
        <div className="voice-preview-player">
          <audio
            ref={audioElement}
            key={job.output.asset.id}
            controls
            preload="metadata"
            src={job.output.asset.url}
            onEnded={(event) => {
              const evidence = createAudioPlaybackEvidence(
                event.currentTarget.played,
                event.currentTarget.duration,
              )
              if (evidence) {
                setPlaybackEvidence({ jobId: job.id, value: evidence })
                setPlaybackIncompleteJobId(null)
              } else {
                setPlaybackEvidence(null)
                setPlaybackIncompleteJobId(job.id)
              }
            }}
          >
            当前浏览器不支持音频播放。
          </audio>
          <small>
            {job.output.sampleSource === 'dialogue' ? '使用该角色当前短台词' : '角色暂无台词，使用固定安全样句'}
            {' · '}{job.output.sampleCharacterCount} 字 · 本地已保存
            {historical ? ' · 历史版本' : ''}
          </small>
          {playbackIncompleteJobId === job.id && (
            <small className="voice-preview-playback-warning">检测到跳播；请从头完整播放后再验收。</small>
          )}
          <VoicePreviewReviewControl
            projectId={projectId}
            jobId={job.id}
            playbackEvidence={playbackEvidence?.jobId === job.id ? playbackEvidence.value : null}
          />
        </div>
      ) : statusLabel ? (
        <div className="voice-preview-status active">
          <CircleDashed size={13} />
          <span>{statusLabel} · {job?.progress ?? 0}%</span>
          <button type="button" onClick={() => void cancelPreview()} disabled={cancelling}>
            {cancelling ? '停止中…' : '停止本地等待'}
          </button>
        </div>
      ) : null}
      {error && <div className="voice-preview-error"><AlertTriangle size={13} /><span>{error}</span></div>}
      <div className="voice-preview-actions">
        <button
          type="button"
          className="button secondary"
          disabled={active || restoring || preflighting}
          onClick={() => void startPreview()}
        >
          <Volume2 size={13} />
          {preflighting ? '免费预检中…' : active ? '试听生成中…' : job?.status === 'succeeded' ? '重新生成试听（需确认）' : '生成试听（需确认）'}
        </button>
        <small>试听不等于保存；请另行点击下方确认按钮绑定角色声线。</small>
      </div>
      {pendingConfirmation && (
        <PaidAigcConfirmationDialog
          confirmation={pendingConfirmation.confirmation}
          eyebrow={`${speechProviderDisplayName(catalog.provider.id, true)} 语音 · 任务门禁`}
          title="确认生成 1 个角色声线试听"
          description="预检已完成。只有你在此明确确认后，才会创建语音合成任务。"
          bindingDescription="确认已绑定本集修订、角色、所选音色、目录指纹、Provider 修订、完整请求体与 Idempotency-Key。"
          cancelAriaLabel="取消角色声线试听计费确认"
          busy={confirmationBusy}
          error={confirmationError}
          onCancel={cancelConfirmation}
          onConfirm={confirmPreview}
          onRefresh={refreshConfirmation}
        />
      )}
    </section>
  )
}

export function CharacterVoiceCastingCard({
  character,
  story,
  projectId,
  episodeId,
  episodeEtag,
  sourceRevisionId,
  miniMaxProvider,
  textProvider,
  onConfigureProvider,
  onSaved,
  attentionRequest = 0,
}: {
  character: StoryCharacter
  story: StoryDocument
  projectId: string
  episodeId: string
  episodeEtag: string
  sourceRevisionId: string
  miniMaxProvider: ProviderConnection | null
  textProvider: ProviderConnection | null
  onConfigureProvider: () => void
  onSaved: (result: CharacterVoiceProfileMutationResponse) => void
  attentionRequest?: number
}) {
  const { state: catalogState, reload } = useMiniMaxVoiceCatalog(miniMaxProvider)
  const [expanded, setExpanded] = useState(!character.voiceProfile)
  const [selectedVoiceId, setSelectedVoiceId] = useState(character.voiceProfile?.voiceId ?? null)
  const [recommendationJob, setRecommendationJob] = useState<CharacterVoiceRecommendationJob | null>(null)
  const [recommendationPollTick, setRecommendationPollTick] = useState(0)
  const [recommendation, setRecommendation] = useState<CharacterVoiceRecommendation | null>(null)
  const [recommendedVoiceId, setRecommendedVoiceId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [recommendationSubmitting, setRecommendationSubmitting] = useState(false)
  const recommendationAttempt = useRef<FrozenCharacterVoiceRecommendationAttempt | null>(null)
  const cardElement = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (attentionRequest <= 0) return
    setExpanded(true)
    const frame = window.requestAnimationFrame(() => {
      cardElement.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [attentionRequest])

  useEffect(() => {
    setSelectedVoiceId(character.voiceProfile?.voiceId ?? null)
    setRecommendationJob(null)
    setRecommendation(null)
    setRecommendedVoiceId('')
    setError('')
    recommendationAttempt.current = null
  }, [character.id, character.voiceProfile?.updatedAt, sourceRevisionId])

  useEffect(() => {
    if (!recommendationJob || !['queued', 'running', 'waiting_provider'].includes(recommendationJob.status)) return
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      void api.getCharacterVoiceRecommendationJob(recommendationJob.id, { signal: controller.signal })
        .then((job) => {
          setRecommendationJob(job)
          if (job.status === 'succeeded' && job.output) {
            setRecommendation(job.output.recommendation)
            setRecommendedVoiceId(job.output.recommendation.selectedVoiceId)
            recommendationAttempt.current = null
          } else if (job.status === 'failed') {
            setError(job.error?.message ?? 'AI 选角任务失败')
            recommendationAttempt.current = null
          }
        })
        .catch((cause: unknown) => {
          if (!(cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) {
            setError(cause instanceof Error ? cause.message : '无法刷新 AI 选角任务')
          }
        }).finally(() => {
          if (!controller.signal.aborted) setRecommendationPollTick((value) => value + 1)
        })
    }, 800)
    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [recommendationJob, recommendationPollTick])

  const saveProfile = async (
    voiceId: string,
    recommendationJobId?: string,
  ) => {
    if (!catalogState.catalog || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await api.putCharacterVoiceProfile(
        episodeId,
        character.id,
        characterVoiceProfileConfirmationInput({
          projectId,
          providerId: catalogState.catalog.provider.id,
          voiceId,
          providerConfigRevision: catalogState.catalog.provider.configRevision,
          ...(recommendationJobId ? { recommendationJobId } : {}),
        }),
        episodeEtag,
      )
      onSaved(result)
      setExpanded(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色声线保存失败')
    } finally {
      setSaving(false)
    }
  }

  const acceptRecommendationJob = (job: CharacterVoiceRecommendationJob) => {
    setRecommendationJob(job)
    // A validated durable Job acknowledges admission; only ambiguous POST
    // outcomes retain the frozen key for an exact replay.
    recommendationAttempt.current = null
    if (job.status === 'succeeded' && job.output) {
      setRecommendation(job.output.recommendation)
      setRecommendedVoiceId(job.output.recommendation.selectedVoiceId)
    } else if (job.status === 'failed' || job.status === 'cancelled') {
      setError(job.error?.message ?? 'AI 选角任务失败')
    }
  }

  const startRecommendation = async () => {
    if (!catalogState.catalog
      || recommendationSubmitting
      || (recommendationJob && ['queued', 'running', 'waiting_provider'].includes(recommendationJob.status))) return
    if (!textProvider || providerUiConnectionState(textProvider) !== 'connected') {
      setError('AI 选角需要先配置并测试默认文本 Provider。')
      return
    }
    const signature = [
      projectId,
      episodeId,
      episodeEtag,
      character.id,
      sourceRevisionId,
      catalogState.catalog.fingerprint,
      textProvider.id,
      textProvider.configRevision,
    ].join(':')
    const currentAttempt = recommendationAttempt.current?.signature === signature
      ? recommendationAttempt.current
      : freezeCharacterVoiceRecommendationAttempt({
          signature,
          episodeId,
          episodeEtag,
          characterId: character.id,
          idempotencyKey: crypto.randomUUID(),
          request: {
            projectId,
            speechProviderId: catalogState.catalog.provider.id,
            textProviderId: textProvider.id,
            expectedCatalogFingerprint: catalogState.catalog.fingerprint,
          },
        })
    recommendationAttempt.current = currentAttempt
    setError('')
    setRecommendation(null)
    setRecommendedVoiceId('')
    setRecommendationSubmitting(true)
    try {
      const job = await api.createCharacterVoiceRecommendation(
        currentAttempt.episodeId,
        currentAttempt.characterId,
        currentAttempt.input,
        currentAttempt.episodeEtag,
        currentAttempt.idempotencyKey,
      )
      acceptRecommendationJob(job)
    } catch (cause) {
      const ambiguous = !(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500
      if (!ambiguous && recommendationAttempt.current === currentAttempt) {
        recommendationAttempt.current = null
      }
      const message = cause instanceof Error ? cause.message : '无法创建 AI 选角任务'
      setError(ambiguous
        ? `${message}。请求结果可能未知；再次点击会复用同一 Idempotency-Key。`
        : message)
    } finally {
      setRecommendationSubmitting(false)
    }
  }

  const catalogCurrent = isVoiceProfileCurrentForCatalog(character.voiceProfile, catalogState.catalog
    ? {
        providerId: catalogState.catalog.provider.id,
        providerConfigRevision: catalogState.catalog.provider.configRevision,
        fingerprint: catalogState.catalog.fingerprint,
      }
    : null)
  const recommendationReady = recommendation && recommendationCanBeConfirmed({
    recommendationFingerprint: recommendation.catalogFingerprint,
    selectedVoiceId: recommendedVoiceId,
    catalog: catalogState.catalog,
  }) && recommendationJob?.input.catalog.providerConfigRevision
    === catalogState.catalog?.provider.configRevision
  const jobActive = Boolean(recommendationJob
    && ['queued', 'running', 'waiting_provider'].includes(recommendationJob.status))
  const textProviderState = providerUiConnectionState(textProvider ?? undefined)
  const textProviderReady = textProviderState === 'connected'
  const textProviderBlockReason = !textProvider
    ? '尚未配置默认文本 Provider。'
    : textProviderState === 'untested'
      ? '文本 Provider 已保存但尚未测试连接。'
      : textProviderState === 'connected'
        ? null
        : providerStatusDetail(textProvider)
  const previewVoiceId = recommendation ? recommendedVoiceId : selectedVoiceId ?? ''
  const previewVoice = findCatalogVoice(catalogState.catalog?.voices ?? [], previewVoiceId)

  return (
    <section ref={cardElement} className="character-voice-card" aria-label={`${character.name}角色声线`}>
      <header className="character-voice-card-header">
        <div><Mic2 size={16} /><span><small>角色声线</small><strong>跨场景保持同一音色</strong></span></div>
        <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          {character.voiceProfile ? '重新选角' : '配置声线'} <ChevronDown size={13} />
        </button>
      </header>
      <VoiceProfileSummary character={character} story={story} />
      {character.voiceProfile && catalogState.status === 'ready' && !catalogCurrent && (
        <div className="voice-profile-warning"><AlertTriangle size={13} />当前 Provider 修订或音色目录已变化；历史绑定仍保留，但重新合成前应重新确认。</div>
      )}
      {expanded && (
        <div className="voice-casting-editor">
          <div className="voice-casting-actions">
            <div><strong>从真实账号音色选择</strong><small>不会把任意文本当作 voice_id</small></div>
            <button type="button" className="voice-agent-button" onClick={() => void startRecommendation()} disabled={catalogState.status !== 'ready' || !textProviderReady || jobActive || recommendationSubmitting}>
              <Bot size={14} /> {recommendationSubmitting ? '提交中…' : jobActive ? `AI 分析中 ${recommendationJob?.progress ?? 0}%` : recommendation ? '重新 AI 选角' : 'AI 选角'}
            </button>
          </div>
          <div className="voice-agent-billing-note"><Bot size={12} /><span>AI 推荐属于平台内免费的文本理解；只生成建议，必须由你确认后才绑定，也不会自动提交 TTS。</span></div>
          {textProviderBlockReason && (
            <div className="voice-catalog-message blocked"><AlertTriangle size={14} /><span>{textProviderBlockReason} AI 选角暂不可用，仍可手动选音。</span><button type="button" onClick={onConfigureProvider}><Settings2 size={11} />设置</button></div>
          )}
          <VoiceCatalogBrowser
            state={catalogState}
            value={selectedVoiceId}
            onChange={(voice) => { setSelectedVoiceId(voice.voiceId); setError('') }}
            onReload={reload}
          />
          {catalogState.status === 'blocked' && (
            <button type="button" className="button secondary voice-configure-provider" onClick={onConfigureProvider}><Settings2 size={13} />配置并测试语音 Provider</button>
          )}
          {recommendation && (
            <RecommendationResult
              recommendation={recommendation}
              catalog={catalogState.catalog}
              selectedVoiceId={recommendedVoiceId}
              onSelect={setRecommendedVoiceId}
            />
          )}
          {recommendation && !recommendationReady && (
            <div className="voice-profile-warning"><AlertTriangle size={13} />推荐所用目录已变化，请刷新目录后重新运行 AI 选角。</div>
          )}
          {catalogState.catalog && previewVoice && (
            <VoicePreviewControl
              key={`${character.id}:${previewVoice.voiceId}`}
              projectId={projectId}
              episodeId={episodeId}
              episodeEtag={episodeEtag}
              characterId={character.id}
              sourceRevisionId={sourceRevisionId}
              voice={previewVoice}
              catalog={catalogState.catalog}
            />
          )}
          {error && <div className="voice-casting-error"><AlertTriangle size={14} /><span>{error}</span>{jobActive && <button type="button" onClick={() => setRecommendationPollTick((value) => value + 1)}><RefreshCcw size={11} />立即刷新</button>}</div>}
          <footer className="voice-casting-footer">
            <span>保存会创建独立的不可变声线审计记录，并固化 Provider revision 与目录指纹；不会让角色画面或视频失效。</span>
            {recommendation ? (
              <div className="voice-confirm-actions">
                <button type="button" className="button secondary" disabled={saving || jobActive} onClick={() => { setRecommendation(null); setRecommendedVoiceId(''); setRecommendationJob(null) }}>放弃建议</button>
                <button
                  type="button"
                  className="button primary"
                  disabled={!recommendationReady || saving || !recommendationJob || jobActive}
                  onClick={() => void saveProfile(recommendedVoiceId, recommendationJob?.id)}
                ><Sparkles size={13} />{saving ? '保存中…' : '确认 AI 选角'}</button>
              </div>
            ) : (
              <button
                type="button"
                className="button primary"
                disabled={!selectedVoiceId || catalogState.status !== 'ready' || saving}
                onClick={() => selectedVoiceId && void saveProfile(selectedVoiceId)}
              ><Check size={13} />{saving ? '保存中…' : '设为角色声线'}</button>
            )}
          </footer>
        </div>
      )}
    </section>
  )
}

/** Compact real-catalog picker used only behind the single-line override gate. */
export function DialogueVoiceOverridePicker({
  provider,
  value,
  onChange,
  onConfigureProvider,
}: {
  provider: ProviderConnection | null
  value: MiniMaxVoiceCatalogEntry | null
  onChange: (voice: MiniMaxVoiceCatalogEntry | null) => void
  onConfigureProvider: () => void
}) {
  const { state, reload } = useMiniMaxVoiceCatalog(provider)
  return (
    <div className="dialogue-voice-override-picker">
      <VoiceCatalogBrowser
        state={state}
        value={value?.voiceId ?? null}
        onChange={onChange}
        onReload={reload}
        compact
      />
      {state.status === 'blocked' && (
        <button type="button" className="button secondary" onClick={onConfigureProvider}><Settings2 size={12} />配置语音 Provider</button>
      )}
    </div>
  )
}
