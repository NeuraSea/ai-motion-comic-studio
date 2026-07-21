import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDashed,
  Mic2,
  RefreshCcw,
  Settings2,
  Trash2,
  Volume2,
} from 'lucide-react'

import {
  ApiError,
  api,
  type MiniMaxVoiceCatalog,
  type MiniMaxVoiceCatalogEntry,
  type PublicPaidAigcConfirmation,
  type ProjectNarratorVoiceProfileMutationResponse,
  type ProjectNarratorVoiceProfileState,
  type ProjectNarratorVoicePreviewJob,
  type ProviderConnection,
} from '../../lib'
import { PaidAigcConfirmationDialog } from '../paid-aigc/PaidAigcConfirmationDialog'
import { VoicePreviewReviewControl } from './VoicePreviewReviewControl'
import {
  createAudioPlaybackEvidence,
  type VoicePreviewPlaybackEvidence,
} from './voice-preview-playback'
import {
  findCatalogVoice,
  isVoiceProfileCurrentForCatalog,
  VOICE_TYPE_LABELS,
} from './voice-casting-state'
import {
  confirmationMatchesVoicePaidAttempt,
  freezeProjectNarratorVoicePreviewAttempt,
  type FrozenProjectNarratorVoicePreviewAttempt,
} from './voice-paid-confirmation-state'
import {
  VoiceCatalogBrowser,
  speechProviderDisplayName,
  useMiniMaxVoiceCatalog,
} from './CharacterVoiceCastingCard'
import './CharacterVoiceCastingCard.css'

export interface ProjectNarratorVoiceCardProps {
  projectId: string
  episodeId: string
  episodeEtag: string
  sourceRevisionId: string
  profileState: ProjectNarratorVoiceProfileState | null
  state: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  miniMaxProvider: ProviderConnection | null
  onConfigureProvider: () => void
  onReload: () => void
  onSaved: (result: ProjectNarratorVoiceProfileMutationResponse) => void
  attentionRequest?: number
}

function ProjectNarratorVoicePreviewControl({
  projectId,
  episodeId,
  episodeEtag,
  sourceRevisionId,
  voice,
  catalog,
}: {
  projectId: string
  episodeId: string
  episodeEtag: string
  sourceRevisionId: string
  voice: MiniMaxVoiceCatalogEntry
  catalog: MiniMaxVoiceCatalog
}) {
  const [job, setJob] = useState<ProjectNarratorVoicePreviewJob | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [pollTick, setPollTick] = useState(0)
  const [error, setError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [preflighting, setPreflighting] = useState(false)
  const [confirmationBusy, setConfirmationBusy] = useState(false)
  const [confirmationError, setConfirmationError] = useState('')
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    attempt: FrozenProjectNarratorVoicePreviewAttempt
    confirmation: PublicPaidAigcConfirmation
  } | null>(null)
  const [playbackEvidence, setPlaybackEvidence] = useState<{
    jobId: string
    value: VoicePreviewPlaybackEvidence
  } | null>(null)
  const [playbackIncompleteJobId, setPlaybackIncompleteJobId] = useState<string | null>(null)
  const attempt = useRef<FrozenProjectNarratorVoicePreviewAttempt | null>(null)
  const audioElement = useRef<HTMLAudioElement | null>(null)
  const active = Boolean(job && ['queued', 'running', 'waiting_provider'].includes(job.status))

  useEffect(() => () => {
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
    void api.listProjectNarratorVoicePreviewJobs(projectId, { limit: 100, signal: controller.signal })
      .then((jobs) => {
        const restored = jobs.find((candidate) => (
          candidate.input.episodeId === episodeId
          && candidate.input.voiceId === voice.voiceId
        )) ?? null
        setJob(restored)
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) {
          setError(cause instanceof Error ? cause.message : '无法恢复已保存的旁白试听任务')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false)
      })
    return () => controller.abort()
  }, [episodeId, projectId, voice.voiceId])

  useEffect(() => {
    if (!job || !['queued', 'running', 'waiting_provider'].includes(job.status)) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void api.getProjectNarratorVoicePreviewJob(job.id, { signal: controller.signal })
        .then((updated) => {
          setJob(updated)
          if (updated.status === 'succeeded') {
            setError('')
            attempt.current = null
          } else if (updated.status === 'failed' || updated.status === 'cancelled') {
            setError(updated.error?.message ?? '项目旁白试听任务未完成')
            attempt.current = null
          }
        })
        .catch((cause: unknown) => {
          if (!(cause instanceof ApiError && cause.code === 'REQUEST_ABORTED')) {
            setError(cause instanceof Error ? cause.message : '无法刷新项目旁白试听任务')
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

  const acceptCreatedJob = (created: ProjectNarratorVoicePreviewJob) => {
    setJob(created)
    setPlaybackEvidence(null)
    setPlaybackIncompleteJobId(null)
    setPendingConfirmation(null)
    setConfirmationError('')
    // A typed durable Job is the acknowledgement boundary. From here polling
    // is Job-ID based and a later explicit regeneration must receive a new key.
    attempt.current = null
    if (created.status === 'failed' || created.status === 'cancelled') {
      setError(created.error?.message ?? '项目旁白试听任务未完成')
    }
  }

  const preflightAttempt = async (currentAttempt: FrozenProjectNarratorVoicePreviewAttempt) => {
    const confirmation = await api.preflightProjectNarratorVoicePreview(
      currentAttempt.episodeId,
      currentAttempt.input,
      currentAttempt.episodeEtag,
      currentAttempt.idempotencyKey,
    )
    if (!confirmationMatchesVoicePaidAttempt(currentAttempt, confirmation)) {
      throw new ApiError('项目旁白试听的计费确认已过期或与当前请求不匹配。', {
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
      sourceRevisionId,
      voice.voiceId,
      catalog.provider.configRevision,
      catalog.fingerprint,
    ].join(':')
    const currentAttempt = attempt.current?.signature === signature
      ? attempt.current
      : freezeProjectNarratorVoicePreviewAttempt({
          signature,
          episodeId,
          episodeEtag,
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
      setError(cause instanceof Error ? cause.message : '无法预检项目旁白试听任务')
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
      setConfirmationError(cause instanceof Error ? cause.message : '无法重新预检项目旁白试听')
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
      const created = await api.createProjectNarratorVoicePreview(
        confirmedAttempt.episodeId,
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
            'project.narrator.voice.preview',
          )
          setPendingConfirmation({ attempt: confirmedAttempt, confirmation: refreshed })
          setConfirmationError('服务端已重新核定本次任务；尚未建单，请再次明确确认。')
        } catch (parseError) {
          setConfirmationError(parseError instanceof Error ? parseError.message : '计费确认响应无效')
        }
      } else if (!(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500) {
        // The acknowledgement may have been interrupted after admission. Keep
        // the exact snapshot and key so the only available retry is a replay.
        setConfirmationError(`${cause instanceof Error ? cause.message : '请求结果未知'}。如重试，将复用同一 Idempotency-Key，不会创建第二个付费任务。`)
      } else {
        setPendingConfirmation(null)
        attempt.current = null
        setError(cause instanceof Error ? cause.message : '无法创建项目旁白试听任务')
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
      const updated = await api.getProjectNarratorVoicePreviewJob(job.id)
      setJob(updated)
      if (updated.status === 'failed' || updated.status === 'cancelled') {
        attempt.current = null
        setError(updated.error?.message ?? '已停止本地旁白试听处理')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法停止项目旁白试听任务')
    } finally {
      setCancelling(false)
    }
  }

  const statusLabel = job?.status === 'queued'
    ? '等待试听队列'
    : job?.status === 'running'
      ? '准备旁白试听'
      : job?.status === 'waiting_provider'
        ? `${speechProviderDisplayName(catalog.provider.id)} 正在合成旁白试听`
        : null
  const historical = Boolean(job && (
    job.input.expectedStoryRevisionId !== sourceRevisionId
    || job.input.expectedCatalogFingerprint !== catalog.fingerprint
    || job.input.expectedProviderConfigRevision !== catalog.provider.configRevision
  ))

  return (
    <section className="voice-preview-control" aria-label={`${voice.name}项目旁白试听`}>
      <div className="voice-preview-copy">
        <strong><Volume2 size={14} />试听项目旁白「{voice.name}」</strong>
        <span>会调用当前语音 Provider；系统只取本集第一句旁白或固定安全样句，不会绑定正式旁白。</span>
      </div>
      {restoring ? (
        <div className="voice-preview-status"><CircleDashed size={13} />正在查找本地已保存的旁白试听…</div>
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
            {job.output.sampleSource === 'narration' ? '使用本集当前短旁白' : '本集暂无旁白，使用固定安全样句'}
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
        <small>试听与保存分离；确认听感后再点击下方按钮绑定项目旁白。</small>
      </div>
      {pendingConfirmation && (
        <PaidAigcConfirmationDialog
          confirmation={pendingConfirmation.confirmation}
          eyebrow={`${speechProviderDisplayName(catalog.provider.id, true)} 语音 · 任务门禁`}
          title="确认生成 1 个项目旁白试听"
          description="预检已完成。只有你在此明确确认后，才会创建语音合成任务。"
          bindingDescription="确认已绑定本集修订、所选旁白音色、目录指纹、Provider 修订、完整请求体与 Idempotency-Key。"
          cancelAriaLabel="取消项目旁白试听计费确认"
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

/**
 * Selects one narrator for the whole project. Catalog selection and profile
 * persistence are deliberately non-generative: neither operation calls TTS.
 */
export function ProjectNarratorVoiceCard({
  projectId,
  episodeId,
  episodeEtag,
  sourceRevisionId,
  profileState,
  state,
  error: loadError,
  miniMaxProvider,
  onConfigureProvider,
  onReload,
  onSaved,
  attentionRequest = 0,
}: ProjectNarratorVoiceCardProps) {
  const { state: catalogState, reload: reloadCatalog } = useMiniMaxVoiceCatalog(miniMaxProvider)
  const profile = profileState?.voiceProfile ?? null
  const [expanded, setExpanded] = useState(!profile)
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(profile?.voiceId ?? null)
  const [saving, setSaving] = useState(false)
  const [clearArmed, setClearArmed] = useState(false)
  const [error, setError] = useState('')
  const cardElement = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (attentionRequest <= 0) return
    setExpanded(true)
    const frame = window.requestAnimationFrame(() => {
      cardElement.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [attentionRequest])

  useEffect(() => {
    setSelectedVoiceId(profile?.voiceId ?? null)
    setClearArmed(false)
    setError('')
    if (!profile && state === 'ready') setExpanded(true)
  }, [profile?.updatedAt, profile?.voiceId, profileState?.etag, state])

  const catalogCurrent = isVoiceProfileCurrentForCatalog(profile, catalogState.catalog
    ? {
        providerId: catalogState.catalog.provider.id,
        providerConfigRevision: catalogState.catalog.provider.configRevision,
        fingerprint: catalogState.catalog.fingerprint,
      }
    : null)
  const unchanged = Boolean(profile
    && selectedVoiceId === profile.voiceId
    && catalogCurrent)
  const selectedVoice = selectedVoiceId
    ? findCatalogVoice(catalogState.catalog?.voices ?? [], selectedVoiceId)
    : null

  const handleVersionConflict = (cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 412) {
      setError('项目旁白设置已在其他页面更新，已请求最新档案；请重新确认所选音色。')
      onReload()
      return true
    }
    return false
  }

  const save = async () => {
    if (!profileState || !catalogState.catalog || !selectedVoiceId || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await api.putProjectNarratorVoiceProfile(projectId, {
        providerId: catalogState.catalog.provider.id,
        voiceId: selectedVoiceId,
        expectedCatalogFingerprint: catalogState.catalog.fingerprint,
        expectedProviderConfigRevision: catalogState.catalog.provider.configRevision,
      }, profileState.etag)
      onSaved(result)
      setExpanded(false)
    } catch (cause) {
      if (!handleVersionConflict(cause)) {
        setError(cause instanceof Error ? cause.message : '项目旁白声线保存失败')
      }
    } finally {
      setSaving(false)
    }
  }

  const clear = async () => {
    if (!profileState || !profile || saving) return
    if (!clearArmed) {
      setClearArmed(true)
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await api.deleteProjectNarratorVoiceProfile(projectId, profileState.etag)
      onSaved(result)
      setSelectedVoiceId(null)
      setExpanded(true)
    } catch (cause) {
      if (!handleVersionConflict(cause)) {
        setError(cause instanceof Error ? cause.message : '项目旁白声线清除失败')
      }
    } finally {
      setSaving(false)
      setClearArmed(false)
    }
  }

  return (
    <section ref={cardElement} className="character-voice-card project-narrator-voice-card" aria-label="项目旁白声线">
      <header className="character-voice-card-header">
        <div>
          <Mic2 size={16} />
          <span><small>项目旁白</small><strong>所有分集旁白继承同一声线</strong></span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          disabled={state === 'loading'}
        >
          {profile ? '重新选择' : '配置旁白'} <ChevronDown size={13} />
        </button>
      </header>

      {state === 'loading' || state === 'idle' ? (
        <div className="voice-profile-empty"><CircleDashed size={18} /><div><strong>正在读取项目旁白档案</strong><span>读取独立项目设置，不修改剧本或分集修订。</span></div></div>
      ) : state === 'error' ? (
        <div className="voice-casting-error"><AlertTriangle size={14} /><span>{loadError || '无法读取项目旁白档案'}</span><button type="button" onClick={onReload}><RefreshCcw size={11} />重试</button></div>
      ) : profile ? (
        <div className="voice-profile-summary">
          <div className="voice-profile-heading">
            <span className="voice-profile-avatar"><Volume2 size={16} /></span>
            <div>
              <small>当前项目旁白</small>
              <strong>{profile.voiceName}</strong>
              <span>{VOICE_TYPE_LABELS[profile.voiceType]} · {speechProviderDisplayName(profile.providerId)} Provider r{profile.providerConfigRevision}</span>
            </div>
            <em className="manual">项目级</em>
          </div>
          {profile.descriptions[0] && <p>{profile.descriptions[0]}</p>}
          <div className="project-narrator-inheritance-note">
            当前项目的每个分集、每条旁白都会继承此声线；角色对白档案不受影响。
          </div>
          {catalogState.status === 'ready' && !catalogCurrent && (
            <div className="voice-profile-warning"><AlertTriangle size={13} />当前 Provider 修订或真实音色目录已变化；历史绑定仍保留，重新合成前请重新确认。</div>
          )}
        </div>
      ) : (
        <div className="voice-profile-empty"><Mic2 size={18} /><div><strong>尚未配置项目旁白</strong><span>旁白合成会被安全阻止；请从当前语音 Provider 的真实声线目录选择。</span></div></div>
      )}

      {expanded && state === 'ready' && profileState && (
        <div className="voice-casting-editor">
          <div className="voice-casting-actions">
            <div><strong>从真实账号音色选择</strong><small>仅选择项目声线，不接受手填 voice_id</small></div>
            {profile && (
              <button
                type="button"
                className={`voice-narrator-clear ${clearArmed ? 'armed' : ''}`}
                disabled={saving}
                onClick={() => void clear()}
              ><Trash2 size={12} />{clearArmed ? '确认清除' : '清除绑定'}</button>
            )}
          </div>
          <VoiceCatalogBrowser
            state={catalogState}
            value={selectedVoiceId}
            onChange={(voice) => {
              setSelectedVoiceId(voice.voiceId)
              setClearArmed(false)
              setError('')
            }}
            onReload={reloadCatalog}
          />
          {catalogState.status === 'blocked' && (
            <button type="button" className="button secondary voice-configure-provider" onClick={onConfigureProvider}><Settings2 size={13} />配置并测试语音 Provider</button>
          )}
          {selectedVoice && catalogState.catalog && (
            <ProjectNarratorVoicePreviewControl
              key={`${episodeId}:${selectedVoice.voiceId}:${catalogState.catalog.fingerprint}`}
              projectId={projectId}
              episodeId={episodeId}
              episodeEtag={episodeEtag}
              sourceRevisionId={sourceRevisionId}
              voice={selectedVoice}
              catalog={catalogState.catalog}
            />
          )}
          {error && <div className="voice-casting-error"><AlertTriangle size={14} /><span>{error}</span></div>}
          <footer className="voice-casting-footer">
            <span>保存会创建独立、不可变的项目旁白审计版本；所有分集继承，且不会让角色画面、角色声线或视频失效。</span>
            <button
              type="button"
              className="button primary"
              disabled={!selectedVoiceId || catalogState.status !== 'ready' || saving || unchanged}
              onClick={() => void save()}
            ><Check size={13} />{saving ? '保存中…' : unchanged ? '已是当前旁白' : '设为项目旁白'}</button>
          </footer>
        </div>
      )}
    </section>
  )
}
