/**
 * Phase 1: 真人数字人（脱口秀场景）工作台页面。
 *
 * 自包含页面，通过 `?view=digital-human` 在 main.tsx 顶层分发挂载，
 * 不进入漫剧五阶段工作台。复用与漫剧一致的 Provider / Job / Asset 后端：
 *
 *   ① 素材：上传演员照片（+ 可选逐句真人录音）
 *   ② 参考图：服务端 gpt-image-2 edits（预览在管道产物中展示）
 *   ③ 语音：TTS（豆包/MiniMax）或上传录音
 *   ④ 视频/导出：预检 → 付费确认 → 提交持久管道 Job → 轮询进度 → 下载成片
 *
 * 付费门禁：提交前必须调用 preflight 拿到 units，用户在确认框输入确认短语后
 * 才把 units + acknowledgement 一并提交；服务端再次校验一致才会发起付费调用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

// 服务端 SQLiteJobRepository 的 defaultProjectId；与工作台首个项目一致。
// 数字人 Demo 复用当前项目上下文，此处读取服务端项目列表首个项目。
const FALLBACK_PROJECT_ID = 'default'

type Stage =
  | 'references'
  | 'speech'
  | 'timing'
  | 'video'
  | 'export'
  | 'quality'

interface PipelineJob {
  id: string
  status: string
  progress?: number
  output?: {
    exportAssetId?: string
    durationSeconds?: number
    qc?: { passed: boolean | null; failedChecks: number; warningChecks: number }
  }
  error?: { message?: string }
}

const STAGE_LABELS: Record<Stage, string> = {
  references: '参考图集',
  speech: '逐句语音',
  timing: '音频驱动 timing',
  video: '逐句视频',
  export: '拼接导出',
  quality: '质量检查',
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = (payload as { error?: { message?: string }; message?: string }).error?.message
      ?? (payload as { message?: string }).message
      ?? `请求失败（${response.status}）`
    const error = new Error(message) as Error & { status?: number; code?: string }
    error.status = response.status
    error.code = (payload as { error?: { code?: string } }).error?.code
    throw error
  }
  return payload as T
}

function idempotencyKey(): string {
  return `dh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export default function DigitalHumanPage() {
  const [projectId, setProjectId] = useState<string>(FALLBACK_PROJECT_ID)
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [linesText, setLinesText] = useState('')
  const [speechMode, setSpeechMode] = useState<'tts' | 'upload'>('tts')
  const [voiceId, setVoiceId] = useState('')
  const [ttsProvider, setTtsProvider] = useState<'doubao' | 'minimax'>('doubao')
  const [audioFiles, setAudioFiles] = useState<File[]>([])
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9')
  const [resolution, setResolution] = useState<'720p' | '1080p'>('1080p')
  const [seedanceModel, setSeedanceModel] = useState('doubao-seedance-2.0')

  const [preflight, setPreflight] = useState<{ units: number; breakdown: { references: number; speech: number; videos: number } } | null>(null)
  const [ack, setAck] = useState('')
  const [job, setJob] = useState<PipelineJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  const lines = linesText.split('\n').map((t) => t.trim()).filter((t) => t.length > 0 && !t.startsWith('#'))

  useEffect(() => {
    if (!photoFile) { setPhotoPreview(null); return }
    const url = URL.createObjectURL(photoFile)
    setPhotoPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photoFile])

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current) }, [])

  // 解析当前项目 ID（与服务端 defaultProjectId 对齐）
  useEffect(() => {
    api<{ projects: Array<{ id: string }> }>('/api/v1/projects')
      .then((p) => { if (p.projects[0]?.id) setProjectId(p.projects[0].id) })
      .catch(() => undefined)
  }, [])

  const pollJob = useCallback((jobId: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    pollRef.current = window.setInterval(async () => {
      try {
        const payload = await api<{ job: PipelineJob }>(`/api/v1/jobs/${encodeURIComponent(jobId)}`)
        setJob(payload.job)
        if (['succeeded', 'failed', 'cancelled'].includes(payload.job.status)) {
          if (pollRef.current) window.clearInterval(pollRef.current)
          pollRef.current = null
          setBusy(false)
        }
      } catch {
        // 轮询失败不打断；下次继续
      }
    }, 2000)
  }, [])

  async function uploadAsset(path: string, file: File | Blob, contentType: string): Promise<string> {
    const payload = await api<{ asset: { id: string } }>(
      `${path}?projectId=${encodeURIComponent(projectId)}`,
      { method: 'POST', headers: { 'content-type': contentType }, body: file },
    )
    return payload.asset.id
  }

  function buildInput(photoAssetId: string, audioAssetIds: string[]) {
    return {
      photoAssetId,
      lines: lines.map((text, i) => ({ index: i + 1, text })),
      speech: speechMode === 'tts'
        ? { mode: 'tts', voiceId: voiceId.trim(), provider: ttsProvider }
        : { mode: 'upload', audioAssetIds },
      video: { aspectRatio, resolution, model: seedanceModel },
    }
  }

  async function runPreflight() {
    setError(null)
    setPreflight(null)
    if (!photoFile) { setError('请先上传演员照片'); return }
    if (lines.length === 0) { setError('请输入台词（每行一句）'); return }
    if (speechMode === 'tts' && !voiceId.trim()) { setError('TTS 模式请填写音色 ID'); return }
    if (speechMode === 'upload' && audioFiles.length !== lines.length) {
      setError(`上传模式需要 ${lines.length} 个逐句录音文件（当前 ${audioFiles.length} 个）`); return
    }
    setBusy(true)
    try {
      const photoAssetId = await uploadAsset('/api/v1/digital-human/uploads/photo', photoFile, photoFile.type || 'image/png')
      let audioAssetIds: string[] = []
      if (speechMode === 'upload') {
        audioAssetIds = await Promise.all(
          audioFiles.map((f) => uploadAsset('/api/v1/digital-human/uploads/audio', f, f.type || 'audio/mpeg')),
        )
      }
      sessionStorage.setItem('dh.photoAssetId', photoAssetId)
      sessionStorage.setItem('dh.audioAssetIds', JSON.stringify(audioAssetIds))
      const input = buildInput(photoAssetId, audioAssetIds)
      const result = await api<{ units: number; breakdown: { references: number; speech: number; videos: number } }>(
        '/api/v1/digital-human/pipelines/preflight',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
      )
      setPreflight(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : '预检失败')
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    setError(null)
    if (!preflight) { setError('请先预检'); return }
    if (ack.trim() !== '确认付费') { setError('请在确认框输入「确认付费」'); return }
    const photoAssetId = sessionStorage.getItem('dh.photoAssetId')
    const audioAssetIds = JSON.parse(sessionStorage.getItem('dh.audioAssetIds') ?? '[]') as string[]
    if (!photoAssetId) { setError('照片资产缺失，请重新预检'); return }
    setBusy(true)
    try {
      const input = {
        ...buildInput(photoAssetId, audioAssetIds),
        projectId: projectId,
        paidConfirmation: { units: preflight.units, acknowledgement: ack.trim() },
      }
      const payload = await api<{ job: PipelineJob }>(
        '/api/v1/digital-human/pipelines',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
          body: JSON.stringify(input),
        },
      )
      setJob(payload.job)
      pollJob(payload.job.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败')
      setBusy(false)
    }
  }

  const progress = job?.progress ?? 0
  const running = busy || (job && !['succeeded', 'failed', 'cancelled'].includes(job.status))

  return (
    <div className="dh-page">
      <header className="dh-header">
        <div>
          <small>真人数字人 · Phase 1 Demo</small>
          <h1>脱口秀数字人工作台</h1>
        </div>
        <a className="dh-back" href="/">← 返回漫剧工作台</a>
      </header>

      <div className="dh-grid">
        {/* ① 素材 */}
        <section className="dh-card">
          <h2><span className="dh-step">1</span> 素材</h2>
          <label className="dh-label">演员照片</label>
          <input type="file" accept="image/*" disabled={!!running}
            onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)} />
          {photoPreview && <img className="dh-photo" src={photoPreview} alt="演员照片预览" />}
          <label className="dh-label">台词（每行一句，最多 24 句）</label>
          <textarea className="dh-lines" rows={8} disabled={!!running}
            placeholder={'大家好，我是今天的脱口秀演员。\n其实做脱口秀最难的不是写段子。'}
            value={linesText} onChange={(e) => setLinesText(e.target.value)} />
          <small className="dh-hint">已输入 {lines.length} 句</small>
        </section>

        {/* ② 参考图说明 + ③ 语音 */}
        <section className="dh-card">
          <h2><span className="dh-step">2</span> 参考图（服务端生成）</h2>
          <p className="dh-hint">提交管道后，服务端会用 gpt-image-2 以照片为参考生成正面 / 侧面 / 大笑 / 说话四张参考图，作为视频首帧。产物在下方进度完成后展示。</p>

          <h2 style={{ marginTop: 24 }}><span className="dh-step">3</span> 语音</h2>
          <div className="dh-row">
            <label><input type="radio" checked={speechMode === 'tts'} disabled={!!running} onChange={() => setSpeechMode('tts')} /> TTS 合成</label>
            <label><input type="radio" checked={speechMode === 'upload'} disabled={!!running} onChange={() => setSpeechMode('upload')} /> 上传真人录音</label>
          </div>
          {speechMode === 'tts' ? (
            <>
              <label className="dh-label">音色 ID</label>
              <input className="dh-input" value={voiceId} disabled={!!running} onChange={(e) => setVoiceId(e.target.value)} placeholder="豆包 / MiniMax 音色 ID" />
              <div className="dh-row">
                <label><input type="radio" checked={ttsProvider === 'doubao'} disabled={!!running} onChange={() => setTtsProvider('doubao')} /> 豆包语音</label>
                <label><input type="radio" checked={ttsProvider === 'minimax'} disabled={!!running} onChange={() => setTtsProvider('minimax')} /> MiniMax</label>
              </div>
            </>
          ) : (
            <>
              <label className="dh-label">逐句录音（{lines.length} 个 mp3/wav，按句序选择）</label>
              <input type="file" accept="audio/mpeg,audio/wav" multiple disabled={!!running}
                onChange={(e) => setAudioFiles(Array.from(e.target.files ?? []))} />
              <small className="dh-hint">已选 {audioFiles.length} 个文件</small>
            </>
          )}
        </section>

        {/* ④ 视频 / 导出 */}
        <section className="dh-card">
          <h2><span className="dh-step">4</span> 视频与导出</h2>
          <label className="dh-label">画面比例</label>
          <div className="dh-row">
            {(['16:9', '9:16', '1:1'] as const).map((r) => (
              <button key={r} className={`dh-chip ${aspectRatio === r ? 'active' : ''}`} disabled={!!running} onClick={() => setAspectRatio(r)}>{r}</button>
            ))}
          </div>
          <label className="dh-label">分辨率</label>
          <div className="dh-row">
            {(['720p', '1080p'] as const).map((r) => (
              <button key={r} className={`dh-chip ${resolution === r ? 'active' : ''}`} disabled={!!running} onClick={() => setResolution(r)}>{r.toUpperCase()}</button>
            ))}
          </div>
          <label className="dh-label">Seedance 模型</label>
          <input className="dh-input" value={seedanceModel} disabled={!!running} onChange={(e) => setSeedanceModel(e.target.value)} />
          <small className="dh-hint">默认 doubao-seedance-2.0；2.5 需在 Ark 开通后填写</small>

          <div className="dh-actions">
            <button className="dh-btn secondary" disabled={!!running} onClick={() => void runPreflight()}>
              预检（估算付费单元）
            </button>
          </div>

          {preflight && (
            <div className="dh-preflight">
              <p>本管道将发起 <strong>{preflight.units}</strong> 次付费 Provider 调用：</p>
              <ul>
                <li>参考图 {preflight.breakdown.references} 张（gpt-image-2）</li>
                <li>语音 {preflight.breakdown.speech} 句{speechMode === 'upload' ? '（使用上传录音，不计费）' : ''}</li>
                <li>视频 {preflight.breakdown.videos} 段（{seedanceModel}）</li>
              </ul>
              <label className="dh-label">输入「确认付费」以提交</label>
              <input className="dh-input" value={ack} disabled={!!running} onChange={(e) => setAck(e.target.value)} placeholder="确认付费" />
              <button className="dh-btn primary" disabled={!!running || ack.trim() !== '确认付费'} onClick={() => void submit()}>
                提交数字人管道
              </button>
            </div>
          )}
        </section>
      </div>

      {/* 进度与产物 */}
      {(job || error) && (
        <section className="dh-card dh-result">
          <h2>管道进度</h2>
          {error && <div className="dh-error">✗ {error}</div>}
          {job && (
            <>
              <div className="dh-progress">
                <div className="dh-progress-bar" style={{ width: `${progress}%` }} />
              </div>
              <p className="dh-hint">状态：{job.status} · {progress}%</p>
              <ol className="dh-stages">
                {(Object.keys(STAGE_LABELS) as Stage[]).map((stage) => (
                  <li key={stage}>{STAGE_LABELS[stage]}</li>
                ))}
              </ol>
              {job.status === 'failed' && job.error?.message && <div className="dh-error">✗ {job.error.message}</div>}
              {job.status === 'succeeded' && job.output?.exportAssetId && (
                <div className="dh-done">
                  <p>✓ 成片已生成（{job.output.durationSeconds?.toFixed(1)}s）
                    {job.output.qc && <> · QC {job.output.qc.passed === true ? '通过' : job.output.qc.passed === false ? '未通过' : '部分通过'}（{job.output.qc.failedChecks} 失败 / {job.output.qc.warningChecks} 警告）</>}
                  </p>
                  <video className="dh-video" controls preload="metadata"
                    src={`/api/v1/assets/${encodeURIComponent(job.output.exportAssetId)}/content`} />
                  <a className="dh-btn primary" download
                    href={`/api/v1/assets/${encodeURIComponent(job.output.exportAssetId)}/content`}>
                    下载成片 MP4
                  </a>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  )
}
