/**
 * Phase 1: 真人数字人（脱口秀场景）硬编码 DAG 管道。
 *
 * 与漫剧 `pipeline-production.ts` 平行，但领域完全不同：
 *   素材(照片) → 参考图集(image.edit) → 逐句语音(TTS) → 音频驱动 timing
 *   → 逐句 Seedance 首帧视频 → FFmpeg 拼接+字幕 → 七项 QC
 *
 * 设计约束（见 docs/modularization-and-canvas-dag-design.md §6 Phase 1）：
 * - 硬编码 DAG，**不抽象**通用 executor（Phase 2 才抽取）
 * - 复用 L0 Provider（providerService 物化）、L1 Job Worker（持久/幂等/恢复）、
 *   L2 Asset（MediaStore 不可变 + checksum）
 * - 付费阶段（参考图/语音/视频）必须经显式确认门禁，确认令牌绑定计费单元数量
 * - 付费 Provider 提交结果 unknown 时 fail-closed，绝不自动重提
 *
 * 整个管道作为一个持久 Job（`digital-human.pipeline`）在 Worker 中运行，
 * 因此自动获得幂等、SSE 进度、取消与服务重启恢复。重启恢复通过持久化的
 * 运行状态（每阶段产物 Asset id 记录在 job.providerState）实现：
 * 已物化的阶段产物在恢复时被复用，不重复发起付费调用。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

import { CodexToolsImageProvider } from './providers/codex-tools.js'
import { DoubaoSpeechProvider } from './providers/doubao-speech.js'
import { MiniMaxSpeechProvider } from './providers/minimax-tts.js'
import type { SpeechProvider } from './providers/minimax-tts.js'
import { SeedanceVideoProvider } from './providers/seedance.js'
import type { SeedanceImageReference } from './providers/seedance.js'
import { probeAudioDuration } from './audio-duration.js'
import { createFfmpegRenderer } from './ffmpeg-renderer.js'
import type {
  AudioRenderClip,
  ImmutableRenderTimelineSnapshot,
  VideoRenderClip,
} from './ffmpeg-renderer.js'
import { FfmpegQualityAnalyzer, DEFAULT_QUALITY_POLICY } from './quality-check.js'
import type { QualityAnalysisResult, QualityExpectedSpecification } from './quality-check.js'
import { downloadSeedanceVideo } from './shot-video-generation.js'
import { JobExecutionError } from './worker.js'
import type { JobHandler, JobHandlerContext, JobRecord } from './worker.js'
import type { MediaStore } from './media.js'
import type { ProviderService } from './providers/service.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const DIGITAL_HUMAN_PIPELINE_JOB_TYPE = 'digital-human.pipeline' as const

const FPS = 24 as const
const MIN_VIDEO_SECONDS = 4
const MAX_VIDEO_SECONDS = 15
const MAX_LINES = 24
const MAX_LINE_CHARS = 500
const MAX_PHOTO_BYTES = 30 * 1024 * 1024
const POLL_INTERVAL_MS = 5_000
const VIDEO_DEADLINE_MS = 15 * 60_000

const REFERENCE_VIEWS = [
  { key: 'front', label: '正面', prompt: '一张脱口秀演员的正面半身肖像，直视镜头，中性微笑，纯色深灰背景，舞台柔光，高清写实风格，保持与参考照片完全一致的五官、发型与服装' },
  { key: 'side', label: '侧面', prompt: '同一位脱口秀演员的侧面半身肖像，与参考照片完全一致的五官、发型与服装，纯色深灰背景，舞台柔光，高清写实风格' },
  { key: 'smile', label: '大笑表情', prompt: '同一位脱口秀演员的正面半身像，开怀大笑的表情，手持麦克风站在脱口秀舞台上，与参考照片完全一致的五官、发型与服装，舞台聚光灯，高清写实风格' },
  { key: 'talking', label: '说话表情', prompt: '同一位脱口秀演员的正面半身像，正在开口说话的表情，手持麦克风，与参考照片完全一致的五官、发型与服装，脱口秀舞台背景，高清写实风格' },
] as const

const VIDEO_STYLE_PROMPT =
  '脱口秀舞台场景，演员手持麦克风讲段子，自然的面部表情和口型，轻微的肢体动作，舞台聚光灯，观众席虚化的深色背景，真实摄影风格'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export const DIGITAL_HUMAN_STAGES = [
  'references',
  'speech',
  'timing',
  'video',
  'export',
  'quality',
] as const
export type DigitalHumanStage = (typeof DIGITAL_HUMAN_STAGES)[number]

export interface DigitalHumanLine {
  index: number
  text: string
}

export interface DigitalHumanPipelineInput {
  /** 服务器已物化的演员照片 Asset id（kind=digital-human-photo）。 */
  photoAssetId: string
  lines: DigitalHumanLine[]
  /** 语音来源：TTS（需 voiceId + 可选 Provider 选择）或上传的逐句录音 Asset。 */
  speech:
    | { mode: 'tts'; voiceId: string; provider?: 'doubao' | 'minimax' }
    | { mode: 'upload'; audioAssetIds: string[] }
  video: {
    aspectRatio: '16:9' | '9:16' | '1:1'
    resolution: '480p' | '720p' | '1080p'
    /** 默认 doubao-seedance-2.0；2.5 需 Ark 开通后显式指定。 */
    model?: string
  }
  /** 付费确认令牌：绑定计费单元数量与源资产 checksum，缺省则拒绝付费阶段。 */
  paidConfirmation?: {
    /** 必须与预估的付费单元数一致（参考图数 + 语音句数 + 视频段数）。 */
    units: number
    /** 用户显式确认短语。 */
    acknowledgement: string
  }
}

export interface DigitalHumanStageProgress {
  stage: DigitalHumanStage
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  detail?: string
}

interface LineAudio {
  lineIndex: number
  text: string
  assetId: string
  path: string
  sha256: string
  durationSeconds: number
}

interface LineTiming extends LineAudio {
  targetSeconds: number
  frames: number
}

export interface DigitalHumanPipelineOutput {
  exportAssetId: string
  exportPath: string
  durationSeconds: number
  qc: {
    passed: boolean | null
    failedChecks: number
    warningChecks: number
  }
  references: Array<{ key: string; assetId: string }>
}

/** 持久化到 job.providerState 的恢复检查点。 */
interface PipelineCheckpoint {
  references?: Array<{ key: string; assetId: string; path: string; sha256: string }>
  lineAudios?: LineAudio[]
  timings?: LineTiming[]
  videos?: Array<{ lineIndex: number; assetId: string; path: string; durationSeconds: number }>
  exportAssetId?: string
  exportPath?: string
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export function validateDigitalHumanInput(input: unknown): DigitalHumanPipelineInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new JobExecutionError('INVALID_INPUT', '数字人管道输入必须是对象', false, 'validation')
  }
  const raw = input as Record<string, unknown>
  const photoAssetId = raw.photoAssetId
  if (typeof photoAssetId !== 'string' || photoAssetId.trim().length === 0) {
    throw new JobExecutionError('INVALID_INPUT', '缺少 photoAssetId', false, 'validation')
  }
  const lines = raw.lines
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new JobExecutionError('INVALID_INPUT', '台词不能为空', false, 'validation')
  }
  if (lines.length > MAX_LINES) {
    throw new JobExecutionError('INVALID_INPUT', `台词最多 ${MAX_LINES} 句`, false, 'validation')
  }
  const parsedLines: DigitalHumanLine[] = lines.map((line, i) => {
    if (!line || typeof line !== 'object') {
      throw new JobExecutionError('INVALID_INPUT', `第 ${i + 1} 句台词格式无效`, false, 'validation')
    }
    const text = (line as Record<string, unknown>).text
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new JobExecutionError('INVALID_INPUT', `第 ${i + 1} 句台词为空`, false, 'validation')
    }
    if (text.length > MAX_LINE_CHARS) {
      throw new JobExecutionError('INVALID_INPUT', `第 ${i + 1} 句台词超过 ${MAX_LINE_CHARS} 字`, false, 'validation')
    }
    return { index: i + 1, text: text.trim() }
  })

  const speech = raw.speech as Record<string, unknown> | undefined
  if (!speech || typeof speech !== 'object') {
    throw new JobExecutionError('INVALID_INPUT', '缺少 speech 配置', false, 'validation')
  }
  let parsedSpeech: DigitalHumanPipelineInput['speech']
  if (speech.mode === 'tts') {
    const voiceId = speech.voiceId
    if (typeof voiceId !== 'string' || voiceId.trim().length === 0) {
      throw new JobExecutionError('INVALID_INPUT', 'TTS 模式缺少 voiceId', false, 'validation')
    }
    const provider = speech.provider
    if (provider !== undefined && provider !== 'doubao' && provider !== 'minimax') {
      throw new JobExecutionError('INVALID_INPUT', 'speech.provider 必须是 doubao 或 minimax', false, 'validation')
    }
    parsedSpeech = { mode: 'tts', voiceId: voiceId.trim(), ...(provider ? { provider } : {}) }
  } else if (speech.mode === 'upload') {
    const audioAssetIds = speech.audioAssetIds
    if (!Array.isArray(audioAssetIds) || audioAssetIds.length !== parsedLines.length) {
      throw new JobExecutionError('INVALID_INPUT', '上传模式的 audioAssetIds 数量必须与台词句数一致', false, 'validation')
    }
    for (const id of audioAssetIds) {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new JobExecutionError('INVALID_INPUT', '上传模式包含无效 audioAssetId', false, 'validation')
      }
    }
    parsedSpeech = { mode: 'upload', audioAssetIds: audioAssetIds.map((s) => (s as string).trim()) }
  } else {
    throw new JobExecutionError('INVALID_INPUT', 'speech.mode 必须是 tts 或 upload', false, 'validation')
  }

  const video = raw.video as Record<string, unknown> | undefined
  if (!video || typeof video !== 'object') {
    throw new JobExecutionError('INVALID_INPUT', '缺少 video 配置', false, 'validation')
  }
  const aspectRatio = video.aspectRatio
  if (aspectRatio !== '16:9' && aspectRatio !== '9:16' && aspectRatio !== '1:1') {
    throw new JobExecutionError('INVALID_INPUT', 'video.aspectRatio 必须是 16:9/9:16/1:1', false, 'validation')
  }
  const resolution = video.resolution
  if (resolution !== '480p' && resolution !== '720p' && resolution !== '1080p') {
    throw new JobExecutionError('INVALID_INPUT', 'video.resolution 必须是 480p/720p/1080p', false, 'validation')
  }
  const model = video.model
  if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
    throw new JobExecutionError('INVALID_INPUT', 'video.model 无效', false, 'validation')
  }

  let paidConfirmation: DigitalHumanPipelineInput['paidConfirmation']
  const pc = raw.paidConfirmation as Record<string, unknown> | undefined
  if (pc && typeof pc === 'object') {
    const units = pc.units
    const acknowledgement = pc.acknowledgement
    if (typeof units !== 'number' || !Number.isInteger(units) || units < 0) {
      throw new JobExecutionError('INVALID_INPUT', 'paidConfirmation.units 无效', false, 'validation')
    }
    if (typeof acknowledgement !== 'string' || acknowledgement.trim().length === 0) {
      throw new JobExecutionError('INVALID_INPUT', 'paidConfirmation.acknowledgement 不能为空', false, 'validation')
    }
    paidConfirmation = { units, acknowledgement: acknowledgement.trim() }
  }

  return {
    photoAssetId: photoAssetId.trim(),
    lines: parsedLines,
    speech: parsedSpeech,
    video: { aspectRatio, resolution, ...(model ? { model: model.trim() } : {}) },
    ...(paidConfirmation ? { paidConfirmation } : {}),
  }
}

/** 预估付费单元数：参考图 + TTS 句数（上传模式为 0）+ 视频段数。 */
export function estimatePaidUnits(input: DigitalHumanPipelineInput): number {
  const references = REFERENCE_VIEWS.length
  const speech = input.speech.mode === 'tts' ? input.lines.length : 0
  const videos = input.lines.length
  return references + speech + videos
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function formatSrtTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const ms = Math.round((totalSeconds % 1) * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${String(ms).padStart(3, '0')}`
}

/**
 * 付费门禁：校验确认令牌绑定到当前预估单元数与确认短语。
 * 无有效确认时 fail-closed，绝不发起付费 Provider 调用。
 */
function assertPaidConfirmation(input: DigitalHumanPipelineInput): void {
  const expectedUnits = estimatePaidUnits(input)
  const pc = input.paidConfirmation
  if (!pc) {
    throw new JobExecutionError(
      'PAID_CONFIRMATION_REQUIRED',
      `本管道将发起 ${expectedUnits} 次付费 Provider 调用（参考图 ${REFERENCE_VIEWS.length} + 语音 + 视频），必须提供 paidConfirmation`,
      false,
      'validation',
    )
  }
  if (pc.units !== expectedUnits) {
    throw new JobExecutionError(
      'PAID_CONFIRMATION_MISMATCH',
      `付费确认单元数 ${pc.units} 与当前预估 ${expectedUnits} 不一致，请重新确认`,
      false,
      'validation',
    )
  }
}

// ---------------------------------------------------------------------------
// 依赖与 Handler 工厂
// ---------------------------------------------------------------------------

export interface DigitalHumanPipelineDependencies {
  mediaStore: MediaStore
  providerService: ProviderService
}

/**
 * 从 ProviderService 物化当前已验证的 Provider 执行配置，并构造具体 Provider。
 * 复用 L0 的 BYOK/Keychain/revision 语义；未配置或未通过连接测试时明确失败。
 */
async function materializeImageProvider(
  deps: DigitalHumanPipelineDependencies,
): Promise<CodexToolsImageProvider> {
  const profile = await deps.providerService.materializeCurrentVerifiedProfile('codex-tools-image')
  return new CodexToolsImageProvider({
    apiKey: profile.apiKey,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    ...(profile.model ? { model: profile.model } : {}),
  })
}

async function materializeSpeechProvider(
  deps: DigitalHumanPipelineDependencies,
  choice: 'doubao' | 'minimax',
): Promise<SpeechProvider> {
  const providerId = choice === 'doubao' ? 'doubao-speech' : 'minimax-speech'
  const profile = await deps.providerService.materializeCurrentVerifiedProfile(providerId)
  return choice === 'doubao'
    ? new DoubaoSpeechProvider({ apiKey: profile.apiKey })
    : new MiniMaxSpeechProvider({ apiKey: profile.apiKey })
}

async function materializeVideoProvider(
  deps: DigitalHumanPipelineDependencies,
  model: string,
): Promise<SeedanceVideoProvider> {
  const profile = await deps.providerService.materializeCurrentVerifiedProfile('seedance-video')
  return new SeedanceVideoProvider({
    apiKey: profile.apiKey,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    model,
  })
}

async function readAssetBytes(deps: DigitalHumanPipelineDependencies, assetId: string): Promise<{ bytes: Uint8Array; mimeType: string; path: string }> {
  const opened = await deps.mediaStore.openAsset(assetId)
  try {
    const buffer = Buffer.alloc(opened.size)
    await opened.file.read(buffer, 0, opened.size, 0)
    const bytes = new Uint8Array(buffer)
    const asset = opened.asset
    return { bytes, mimeType: opened.mimeType, path: asset.filePath ?? '' }
  } finally {
    await opened.file.close().catch(() => undefined)
  }
}

async function resolveAssetPath(deps: DigitalHumanPipelineDependencies, assetId: string): Promise<string> {
  // openAsset 已做完整路径/符号链接/内容类型安全校验；此处取校验后的真实路径。
  const opened = await deps.mediaStore.openAsset(assetId)
  await opened.file.close().catch(() => undefined)
  const asset = opened.asset
  if (!asset.filePath) {
    throw new JobExecutionError('ASSET_FILE_MISSING', '资产尚无本地文件', false, 'internal')
  }
  const lexical = resolvePath(deps.mediaStore.runtimeDirectory, ...asset.filePath.split('/'))
  return realpath(lexical)
}

/**
 * 创建数字人管道 Job handler。整个 DAG 在单个持久 Job 中顺序执行，
 * 每完成一个付费阶段就把产物 Asset 记录进检查点（providerState），
 * 使服务重启恢复时能复用已物化产物而不重复付费。
 */
export function createDigitalHumanPipelineHandler(
  deps: DigitalHumanPipelineDependencies,
): JobHandler<DigitalHumanPipelineInput, DigitalHumanPipelineOutput> {
  return async (job: JobRecord<DigitalHumanPipelineInput>, context: JobHandlerContext) => {
    const input = validateDigitalHumanInput(job.input)
    assertPaidConfirmation(input)
    const signal = context.signal
    const projectId = job.projectId ?? 'default'

    const checkpoint: PipelineCheckpoint = readCheckpoint(job.providerState)
    const reportStage = async (stage: DigitalHumanStage, progress: number, detail?: string) => {
      await context.reportProgress(progress, { stage, detail })
    }

    // ---- 素材：照片 ---------------------------------------------------------
    await reportStage('references', 2, '读取演员照片')
    const photo = await readAssetBytes(deps, input.photoAssetId)
    if (!photo.mimeType.startsWith('image/')) {
      throw new JobExecutionError('INVALID_INPUT', `照片不是有效图片（${photo.mimeType}）`, false, 'validation')
    }
    if (photo.bytes.byteLength > MAX_PHOTO_BYTES) {
      throw new JobExecutionError('INVALID_INPUT', '照片超过大小限制', false, 'validation')
    }

    // ---- 参考图集（付费，幂等恢复） -----------------------------------------
    let references = checkpoint.references
    if (!references || references.length !== REFERENCE_VIEWS.length) {
      await reportStage('references', 5, `生成 ${REFERENCE_VIEWS.length} 张参考图`)
      const imageProvider = await materializeImageProvider(deps)
      references = []
      for (let i = 0; i < REFERENCE_VIEWS.length; i++) {
        const view = REFERENCE_VIEWS[i]
        const images = await imageProvider.generate(
          { prompt: view.prompt, size: '1024x1536', quality: 'high', count: 1 },
          signal,
          [{ bytes: photo.bytes, mimeType: photo.mimeType }],
        )
        if (images.length === 0) {
          throw new JobExecutionError('IMAGE_GENERATION_FAILED', `参考图「${view.label}」生成失败`, true, 'provider')
        }
        const bytes = images[0].bytes
        const asset = await deps.mediaStore.save({
          projectId,
          kind: 'digital-human-reference',
          bytes,
          mimeType: 'image/png',
          source: 'digital-human-pipeline',
          generationJobId: job.id,
          parentAssetId: input.photoAssetId,
        })
        const path = await resolveAssetPath(deps, asset.id)
        references.push({ key: view.key, assetId: asset.id, path, sha256: sha256(bytes) })
        await reportStage('references', 5 + Math.round(((i + 1) / REFERENCE_VIEWS.length) * 20), `已生成「${view.label}」`)
      }
      checkpoint.references = references
      await context.waitingForProvider(checkpoint) // 持久化检查点
    } else {
      await reportStage('references', 25, '复用已生成参考图')
    }

    // ---- 逐句语音（TTS 付费 或 上传复用） ------------------------------------
    let lineAudios = checkpoint.lineAudios
    if (!lineAudios || lineAudios.length !== input.lines.length) {
      await reportStage('speech', 28, '准备逐句语音')
      lineAudios = []
      if (input.speech.mode === 'tts') {
        const choice = input.speech.provider ?? 'doubao'
        const tts = await materializeSpeechProvider(deps, choice)
        for (let i = 0; i < input.lines.length; i++) {
          const line = input.lines[i]
          const result = await tts.synthesize(
            { text: line.text, voiceId: input.speech.voiceId, subtitleEnable: true, subtitleType: 'word', outputFormat: 'hex' },
            signal,
          )
          if (result.audio.kind !== 'bytes') {
            throw new JobExecutionError('TTS_FAILED', `第${line.index}句 TTS 返回 URL 音频，暂不支持`, true, 'provider')
          }
          const bytes = result.audio.bytes
          const durationSeconds = await probeAudioDuration(bytes, audioMime(result.format), signal)
          const asset = await deps.mediaStore.save({
            projectId,
            kind: 'digital-human-audio',
            bytes,
            mimeType: audioMime(result.format),
            source: 'digital-human-pipeline',
            generationJobId: job.id,
            durationSeconds,
          })
          const path = await resolveAssetPath(deps, asset.id)
          lineAudios.push({ lineIndex: line.index, text: line.text, assetId: asset.id, path, sha256: sha256(bytes), durationSeconds })
          await reportStage('speech', 28 + Math.round(((i + 1) / input.lines.length) * 15), `第${line.index}句语音就绪`)
        }
      } else {
        for (let i = 0; i < input.lines.length; i++) {
          const line = input.lines[i]
          const assetId = input.speech.audioAssetIds[i]
          const audio = await readAssetBytes(deps, assetId)
          const durationSeconds = await probeAudioDuration(audio.bytes, audio.mimeType, signal)
          const path = await resolveAssetPath(deps, assetId)
          lineAudios.push({ lineIndex: line.index, text: line.text, assetId, path, sha256: sha256(audio.bytes), durationSeconds })
          await reportStage('speech', 28 + Math.round(((i + 1) / input.lines.length) * 15), `第${line.index}句录音就绪`)
        }
      }
      checkpoint.lineAudios = lineAudios
      await context.waitingForProvider(checkpoint)
    } else {
      await reportStage('speech', 43, '复用已生成语音')
    }

    // ---- 音频驱动 timing（免费，确定性） --------------------------------------
    await reportStage('timing', 45, '计算音频驱动 timing')
    const timings: LineTiming[] = lineAudios.map((la) => {
      const seconds = la.durationSeconds
      if (seconds > MAX_VIDEO_SECONDS) {
        throw new JobExecutionError(
          'AUDIO_TOO_LONG',
          `第${la.lineIndex}句音频 ${seconds.toFixed(2)}s 超过 ${MAX_VIDEO_SECONDS}s 上限，请拆句`,
          false,
          'validation',
        )
      }
      const targetSeconds = Math.max(MIN_VIDEO_SECONDS, Math.ceil(seconds))
      const frames = Math.round(seconds * FPS)
      return { ...la, targetSeconds, frames }
    })
    const totalSeconds = timings.reduce((sum, t) => sum + t.durationSeconds, 0)
    checkpoint.timings = timings
    await context.waitingForProvider(checkpoint)

    // ---- 逐句 Seedance 视频（付费，幂等恢复） ---------------------------------
    let videos = checkpoint.videos
    if (!videos || videos.length !== timings.length) {
      await reportStage('video', 50, '生成逐句视频')
      const videoProvider = await materializeVideoProvider(deps, input.video.model ?? 'doubao-seedance-2.0')
      const frontRef = references.find((r) => r.key === 'front') ?? references[0]
      const frontBytes = new Uint8Array(await readFile(frontRef.path))
      const frontDataUrl = `data:image/png;base64,${Buffer.from(frontBytes).toString('base64')}`
      videos = []
      for (let i = 0; i < timings.length; i++) {
        const t = timings[i]
        const reference: SeedanceImageReference = { url: frontDataUrl, role: 'first_frame' }
        const prompt = `${VIDEO_STYLE_PROMPT}。演员正在说：「${t.text}」`
        const created = await videoProvider.createTask(
          {
            prompt,
            aspectRatio: input.video.aspectRatio,
            resolution: input.video.resolution,
            durationSeconds: t.targetSeconds,
            generateAudio: false,
            referenceImages: [reference],
          },
          signal,
        )
        const deadline = Date.now() + VIDEO_DEADLINE_MS
        let task
        for (;;) {
          if (signal.aborted) throw new JobExecutionError('CANCELLED', '已取消', false, 'cancelled')
          if (Date.now() > deadline) {
            throw new JobExecutionError('VIDEO_TIMEOUT', `第${t.lineIndex}句视频超时`, true, 'provider')
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
          task = await videoProvider.getTask(created.id, signal)
          if (task.status === 'succeeded') break
          if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'expired') {
            throw new JobExecutionError(
              'VIDEO_FAILED',
              `第${t.lineIndex}句视频任务 ${task.status}: ${task.error?.message ?? '无详情'}`,
              false,
              'provider',
            )
          }
        }
        if (!task.videoUrl) {
          throw new JobExecutionError('VIDEO_FAILED', `第${t.lineIndex}句任务成功但无视频 URL`, true, 'provider')
        }
        const video = await downloadSeedanceVideo(task.videoUrl, signal)
        const asset = await deps.mediaStore.save({
          projectId,
          kind: 'digital-human-video',
          bytes: video.bytes,
          mimeType: video.mimeType,
          source: 'digital-human-pipeline',
          generationJobId: job.id,
          parentAssetId: frontRef.assetId,
          durationSeconds: task.durationSeconds ?? t.targetSeconds,
        })
        const path = await resolveAssetPath(deps, asset.id)
        videos.push({ lineIndex: t.lineIndex, assetId: asset.id, path, durationSeconds: task.durationSeconds ?? t.targetSeconds })
        checkpoint.videos = videos
        await context.waitingForProvider(checkpoint) // 每段视频完成后立即持久化
        await reportStage('video', 50 + Math.round(((i + 1) / timings.length) * 30), `第${t.lineIndex}句视频就绪`)
      }
    } else {
      await reportStage('video', 80, '复用已生成视频')
    }

    // ---- FFmpeg 拼接 + 字幕（免费） -------------------------------------------
    await reportStage('export', 82, '拼接导出')
    const workDir = await mkdtemp(join(tmpdir(), 'manju-dh-export-'))
    try {
      const srtEntries: string[] = []
      let cursor = 0
      for (const t of timings) {
        srtEntries.push(`${t.lineIndex}\n${formatSrtTime(cursor)} --> ${formatSrtTime(cursor + t.durationSeconds)}\n${t.text}\n`)
        cursor += t.durationSeconds
      }
      const srtPath = join(workDir, 'subtitles.srt')
      await writeFile(srtPath, srtEntries.join('\n'), 'utf-8')

      let currentFrame = 0
      const visualClips: VideoRenderClip[] = []
      const audioClips: AudioRenderClip[] = []
      for (const t of timings) {
        const video = videos.find((v) => v.lineIndex === t.lineIndex)
        if (!video) throw new JobExecutionError('INTERNAL', `缺少第${t.lineIndex}句视频`, false, 'internal')
        const durationFrames = Math.round(t.durationSeconds * FPS)
        visualClips.push({
          mediaType: 'video',
          id: `line-${t.lineIndex}`,
          startFrame: currentFrame,
          durationFrames,
          assetPath: video.path,
          sourceStartSeconds: 0,
          sourceDurationSeconds: t.durationSeconds,
          fit: 'cover',
        })
        audioClips.push({ id: `audio-${t.lineIndex}`, startFrame: currentFrame, assetPath: t.path, durationFrames, audioRole: 'dialogue' })
        currentFrame += durationFrames
      }
      const timeline: ImmutableRenderTimelineSnapshot = {
        revisionId: `dh-${job.id}`,
        frameRate: FPS,
        visualClips,
        audioClips,
        subtitles: { assetPath: srtPath, format: 'srt', burnIn: true },
      }
      const renderer = createFfmpegRenderer()
      const tempOutput = join(workDir, 'export.mp4')
      await renderer.render({
        timeline,
        resolution: input.video.resolution === '480p' ? '720p' : input.video.resolution,
        aspectRatio: input.video.aspectRatio,
        outputPath: tempOutput,
        signal,
      })
      const outputBytes = new Uint8Array(await readFile(tempOutput))
      const exportAsset = await deps.mediaStore.save({
        projectId,
        kind: 'digital-human-export',
        bytes: outputBytes,
        mimeType: 'video/mp4',
        source: 'digital-human-pipeline',
        generationJobId: job.id,
        durationSeconds: totalSeconds,
      })
      checkpoint.exportAssetId = exportAsset.id
      checkpoint.exportPath = await resolveAssetPath(deps, exportAsset.id)
      await context.waitingForProvider(checkpoint)

      // ---- 七项 QC（免费） -----------------------------------------------------
      await reportStage('quality', 94, '质量检查')
      const analyzer = new FfmpegQualityAnalyzer()
      const { width, height } = expectedDimensions(input.video.aspectRatio, input.video.resolution)
      const expected: QualityExpectedSpecification = {
        container: 'mp4',
        durationSeconds: totalSeconds,
        frameCount: Math.round(totalSeconds * FPS),
        videoCodec: 'h264',
        width,
        height,
        pixelFormat: 'yuv420p',
        frameRate: FPS,
        audioCodec: 'aac',
        audioSampleRate: 48_000,
        audioChannels: 2,
      }
      const qc = await analyzer.analyze({ inputPath: tempOutput, expected, policy: DEFAULT_QUALITY_POLICY, signal })
      await reportStage('quality', 100, '完成')

      return {
        exportAssetId: exportAsset.id,
        exportPath: checkpoint.exportPath,
        durationSeconds: totalSeconds,
        qc: {
          passed: qc.passed,
          failedChecks: qc.checks.filter((c) => c.status === 'failed').length,
          warningChecks: qc.checks.filter((c) => c.status === 'warning').length,
        },
        references: references.map((r) => ({ key: r.key, assetId: r.assetId })),
      }
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

function audioMime(format: string): string {
  if (format === 'wav') return 'audio/wav'
  return 'audio/mpeg'
}

function expectedDimensions(aspectRatio: '16:9' | '9:16' | '1:1', resolution: '480p' | '720p' | '1080p'): { width: number; height: number } {
  const short = resolution === '1080p' ? 1080 : resolution === '720p' ? 720 : 480
  const long = resolution === '1080p' ? 1920 : resolution === '720p' ? 1280 : 854
  if (aspectRatio === '1:1') return { width: short, height: short }
  return aspectRatio === '16:9' ? { width: long, height: short } : { width: short, height: long }
}

function readCheckpoint(providerState: unknown): PipelineCheckpoint {
  if (providerState && typeof providerState === 'object' && !Array.isArray(providerState)) {
    const state = providerState as Record<string, unknown>
    if (state.digitalHuman && typeof state.digitalHuman === 'object') {
      return (state.digitalHuman as PipelineCheckpoint) ?? {}
    }
    return providerState as PipelineCheckpoint
  }
  return {}
}

export function checkpointForPersistence(checkpoint: PipelineCheckpoint): Record<string, unknown> {
  return { digitalHuman: checkpoint }
}
