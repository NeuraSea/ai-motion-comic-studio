import { useEffect, useMemo, useRef, useState } from 'react'
import type { ManagedSubtitleCueSetSnapshot } from '@manju/opencut-editor'
import { AlertTriangle, CheckCircle2, Plus, RotateCcw, Save, Trash2 } from 'lucide-react'

import type { MediaAsset, SpeechSubtitleCue } from '../../lib'
import {
  emptySubtitleCueDraft,
  providerSubtitleCueDrafts,
  subtitleCueDraftsFromCues,
  validateSubtitleCueDrafts,
  type SubtitleCueDraft,
} from './subtitle-cue-state'
import './ManagedSubtitleEditor.css'

interface SubtitleBinding {
  dialogueLineId: string
  storySceneId: string
  storyShotId: string
  lineText: string
}

interface ReplaceSubtitleInput extends Omit<SubtitleBinding, 'lineText'> {
  cueSetId: string
  speechAssetId: string
  cues: SpeechSubtitleCue[]
}

export interface ManagedSubtitleEditorProps {
  binding: SubtitleBinding | null
  speechAsset: MediaAsset | null
  assetLoading: boolean
  timelineReady: boolean
  onRead: (input: {
    dialogueLineId: string
    speechAssetId: string
  }) => ManagedSubtitleCueSetSnapshot | null
  onReplace: (input: ReplaceSubtitleInput) => Promise<ManagedSubtitleCueSetSnapshot>
}

type EditorState = 'idle' | 'provider' | 'fallback' | 'saved' | 'dirty' | 'stale'

const staleReasonLabels: Record<string, string> = {
  'speech-asset-mismatch': '语音已经重新生成',
  'source-audio-missing': '来源音频已从时间线删除',
  'source-audio-asset-mismatch': '时间线音频已替换',
  'source-audio-start-mismatch': '时间线音频已移动',
  'source-audio-trim-mismatch': '时间线音频已裁剪',
  'source-audio-duration-mismatch': '时间线音频时长已改变',
  'source-audio-binding-mismatch': '时间线音频的剧本绑定已改变',
  'cue-set-inconsistent': '字幕组数据不完整',
}

function sourceCues(snapshot: ManagedSubtitleCueSetSnapshot): SpeechSubtitleCue[] {
  return snapshot.cues.map((cue) => ({
    text: cue.text,
    startMs: cue.sourceStartMs,
    endMs: cue.sourceEndMs,
  }))
}

function providerState(asset: MediaAsset): EditorState {
  return asset.speechSubtitle?.mode === 'word' ? 'provider' : 'fallback'
}

export function ManagedSubtitleEditor({
  binding,
  speechAsset,
  assetLoading,
  timelineReady,
  onRead,
  onReplace,
}: ManagedSubtitleEditorProps) {
  const [drafts, setDrafts] = useState<SubtitleCueDraft[]>([])
  const [state, setState] = useState<EditorState>('idle')
  const [staleReasons, setStaleReasons] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const cueSetAttemptRef = useRef<{ signature: string; cueSetId: string } | null>(null)
  const rowSequenceRef = useRef(0)
  const readRef = useRef(onRead)
  const replaceRef = useRef(onReplace)
  readRef.current = onRead
  replaceRef.current = onReplace

  const bindingKey = binding && speechAsset
    ? `${binding.storySceneId}\u0000${binding.storyShotId}\u0000${binding.dialogueLineId}\u0000${speechAsset.id}`
    : ''
  const providerDrafts = useMemo(
    () => providerSubtitleCueDrafts(speechAsset?.speechSubtitle),
    [speechAsset?.speechSubtitle],
  )
  const validation = useMemo(
    () => validateSubtitleCueDrafts(drafts, speechAsset?.durationSeconds ?? Number.NaN),
    [drafts, speechAsset?.durationSeconds],
  )

  useEffect(() => {
    setError('')
    setStaleReasons([])
    setSaving(false)
    cueSetAttemptRef.current = null
    if (!binding || !speechAsset) {
      setDrafts([])
      setState('idle')
      return
    }
    setDrafts(providerSubtitleCueDrafts(speechAsset.speechSubtitle))
    setState(providerState(speechAsset))
    if (!timelineReady) return
    try {
      const current = readRef.current({
        dialogueLineId: binding.dialogueLineId,
        speechAssetId: speechAsset.id,
      })
      if (!current) return
      if (current.stale) {
        setState('stale')
        setStaleReasons(current.staleReasons)
        return
      }
      setDrafts(subtitleCueDraftsFromCues(sourceCues(current)))
      setState('saved')
      cueSetAttemptRef.current = {
        signature: '',
        cueSetId: current.provenance.cueSetId,
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取当前时间线字幕')
    }
  }, [bindingKey, timelineReady])

  const markDirty = (next: SubtitleCueDraft[]) => {
    setDrafts(next)
    setState('dirty')
    setError('')
  }

  const resetProvider = () => {
    markDirty(providerDrafts)
    cueSetAttemptRef.current = null
  }

  const createSentenceCue = () => {
    if (!binding || !speechAsset?.durationSeconds) return
    const endMs = Math.max(1, Math.round(speechAsset.durationSeconds * 1_000))
    markDirty([{
      ...emptySubtitleCueDraft(`sentence-${crypto.randomUUID()}`, 0, endMs),
      text: binding.lineText,
    }])
  }

  const addCue = () => {
    const previous = drafts.at(-1)
    const parsedEnd = previous ? Number(previous.endSeconds) * 1_000 : 0
    const startMs = Number.isFinite(parsedEnd) ? Math.max(0, Math.round(parsedEnd)) : 0
    const assetEndMs = Math.max(1, Math.round((speechAsset?.durationSeconds ?? 2) * 1_000))
    const endMs = Math.min(assetEndMs, startMs + 2_000)
    rowSequenceRef.current += 1
    markDirty([
      ...drafts,
      emptySubtitleCueDraft(`manual-${rowSequenceRef.current}-${crypto.randomUUID()}`, startMs, Math.max(startMs + 1, endMs)),
    ])
  }

  const save = async () => {
    if (!binding || !speechAsset || !validation.cues || saving || !timelineReady) return
    const signature = JSON.stringify({ bindingKey, cues: validation.cues })
    const prior = cueSetAttemptRef.current
    // Keep the set identity stable across edits and ambiguous retries. The
    // OpenCut command can then preserve element IDs by cue index.
    const cueSetId = prior?.cueSetId ?? crypto.randomUUID()
    cueSetAttemptRef.current = { signature, cueSetId }
    setSaving(true)
    setError('')
    try {
      const saved = await replaceRef.current({
        cueSetId,
        dialogueLineId: binding.dialogueLineId,
        storySceneId: binding.storySceneId,
        storyShotId: binding.storyShotId,
        speechAssetId: speechAsset.id,
        cues: validation.cues,
      })
      setDrafts(subtitleCueDraftsFromCues(sourceCues(saved)))
      setState('saved')
      setStaleReasons([])
      cueSetAttemptRef.current = { signature: '', cueSetId: saved.provenance.cueSetId }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '字幕组保存失败')
    } finally {
      setSaving(false)
    }
  }

  const subtitle = speechAsset?.speechSubtitle
  const stateLabel = state === 'saved' ? '已固化到 OpenCut'
    : state === 'dirty' ? '有未保存修改'
      : state === 'stale' ? '旧字幕已失效'
        : state === 'provider' ? '供应商时码'
          : state === 'fallback' ? '整句回退'
            : '等待语音'

  return (
    <section className="managed-subtitle-editor">
      <header>
        <div>
          <strong>逐词字幕校订</strong>
          <small>自有编辑界面 · OpenCut 原子 cue-set / 撤销重做 / 持久化</small>
        </div>
        <span className={`managed-subtitle-state state-${state}`}>
          {state === 'saved' && <CheckCircle2 size={12} />}
          {state === 'stale' && <AlertTriangle size={12} />}
          {stateLabel}
        </span>
      </header>

      {!binding && <div className="managed-subtitle-empty">请先从左侧选择一条剧本台词。</div>}
      {binding && assetLoading && <div className="managed-subtitle-empty">正在读取不可变语音 Asset…</div>}
      {binding && !assetLoading && !speechAsset && (
        <div className="managed-subtitle-empty">当前台词还没有可用语音，请先完成真实配音。</div>
      )}
      {binding && speechAsset && (
        <>
          <div className="managed-subtitle-source">
            <div>
              <span>来源 Asset <strong>{speechAsset.id.slice(0, 8)}</strong></span>
              <span>时长 <strong>{speechAsset.durationSeconds?.toFixed(3) ?? '未知'}s</strong></span>
              <span>{subtitle?.mode === 'word'
                ? `${subtitle.granularity === 'sentence' ? '句级' : '词级'} ${subtitle.cues.length} 条`
                : `无可靠词级时码${subtitle?.mode === 'sentence-fallback' ? ` · ${subtitle.reason}` : ''}`}</span>
            </div>
            <div>
              <button className="button secondary" disabled={providerDrafts.length === 0 || saving} onClick={resetProvider}>
                <RotateCcw size={12} /> 恢复供应商时码
              </button>
              {providerDrafts.length === 0 && (
                <button className="button secondary" disabled={saving} onClick={createSentenceCue}>按整句创建</button>
              )}
            </div>
          </div>

          {state === 'stale' && (
            <div className="managed-subtitle-warning">
              <AlertTriangle size={14} />
              <span>旧字幕不会进入正式导出：{staleReasons.map((reason) => staleReasonLabels[reason] ?? reason).join('、')}。请检查并重新保存。</span>
            </div>
          )}

          <div className="managed-subtitle-cues">
            <div className="managed-subtitle-cue heading">
              <span>#</span><span>字幕文本</span><span>开始（秒）</span><span>结束（秒）</span><span />
            </div>
            {drafts.map((draft, index) => {
              const rowErrors = validation.rowErrors[draft.key] ?? []
              return (
                <div className={`managed-subtitle-cue ${rowErrors.length ? 'invalid' : ''}`} key={draft.key}>
                  <span>{index + 1}</span>
                  <input
                    value={draft.text}
                    maxLength={1_000}
                    aria-label={`第 ${index + 1} 条字幕文本`}
                    onChange={(event) => markDirty(drafts.map((item) => item.key === draft.key
                      ? { ...item, text: event.target.value }
                      : item))}
                  />
                  <input
                    value={draft.startSeconds}
                    inputMode="decimal"
                    aria-label={`第 ${index + 1} 条开始秒数`}
                    onChange={(event) => markDirty(drafts.map((item) => item.key === draft.key
                      ? { ...item, startSeconds: event.target.value }
                      : item))}
                  />
                  <input
                    value={draft.endSeconds}
                    inputMode="decimal"
                    aria-label={`第 ${index + 1} 条结束秒数`}
                    onChange={(event) => markDirty(drafts.map((item) => item.key === draft.key
                      ? { ...item, endSeconds: event.target.value }
                      : item))}
                  />
                  <button aria-label={`删除第 ${index + 1} 条字幕`} disabled={saving} onClick={() => markDirty(drafts.filter((item) => item.key !== draft.key))}>
                    <Trash2 size={13} />
                  </button>
                  {rowErrors.length > 0 && <small>{rowErrors.join('；')}</small>}
                </div>
              )
            })}
            {drafts.length === 0 && <div className="managed-subtitle-empty compact">还没有 cue，可按整句创建或手工新增。</div>}
          </div>

          <footer>
            <button className="button secondary" disabled={saving} onClick={addCue}><Plus size={12} /> 新增 cue</button>
            <div>
              {validation.errors.length > 0 && drafts.length > 0 && <span>{validation.errors[0]}</span>}
              {!timelineReady && <span>OpenCut 时间线载入后才可保存</span>}
              <button className="button primary" disabled={!timelineReady || !validation.cues || saving} onClick={() => void save()}>
                <Save size={12} /> {saving ? '固化时间线中' : '保存到时间线'}
              </button>
            </div>
          </footer>
          {error && <div className="managed-subtitle-warning"><AlertTriangle size={14} /><span>{error}</span></div>}
        </>
      )}
    </section>
  )
}
