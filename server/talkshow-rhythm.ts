/**
 * 脱口秀节奏提取：从演员 A 的表演视频中提取结构化稿子 + 节奏时间轴。
 *
 * 背景（见 docs/talkshow-characteristics-and-tech-requirements.md）：
 * 脱口秀数字人的技术核心是**时间控制**——气口、喜剧停顿、包袱后的等笑声窗口。
 * 这些节奏信息活在 A 的表演音频里，不在文字稿子里。本模块把节奏"抠"出来，
 * 供 B 的声音复刻时逐点注入（pausePlan），让 B 按 A 的节奏讲 A 的段子。
 *
 * 设计原则：
 * - **纯信号 VAD 分段是确定性、离线、零外部依赖的**：用 ffmpeg 提取音频能量包络，
 *   通过自适应阈值检测语音/静音边界，得到停顿与笑声候选。这部分不调用任何 ASR/LLM。
 * - **ASR 是可插拔端口**：只要能提供"带词级/句级时间戳的转写"（OpenAI-compatible
 *   /audio/transcriptions、本地 whisper.cpp 等），就把文本填进时间轴；没有 ASR 时
 *   退化为纯节奏骨架（segments + pauses），文本由创作者手工补齐。
 * - **LLM beat 分类也是可插拔端口**：给定带时间戳的句子，分类 setup/punchline/callback。
 *   未配置文本 Provider 时退化为启发式（停顿后接短句→punchline 候选），并明确标注
 *   `classification: 'heuristic'`，不假装是 Agentic 判断。
 *
 * 安全：所有媒体经 ffmpeg 子进程处理，工作目录落在调用方提供的安全 runtime 目录
 * （不能是 /tmp——macOS 符号链接会被渲染/写入校验拒绝）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveBundledFfmpegPath, resolveBundledFfprobePath } from './ffmpeg-renderer.js'
import type { TextProvider } from './providers/text.js'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一个语音段（一句或一段连续表演）。 */
export interface TalkshowSegment {
  index: number
  /** 秒，相对音频起点。 */
  startSeconds: number
  endSeconds: number
  durationSeconds: number
  /** ASR 文本；无 ASR 时为空字符串，由创作者补齐。 */
  text: string
  /** 该段能量峰值（dB），用于笑声/强调判断。 */
  peakDb: number | null
}

/** 一个停顿/间隙。 */
export interface TalkshowPause {
  /** 停顿出现在第几个语音段之后（1-based；0 表示开头）。 */
  afterSegment: number
  startSeconds: number
  durationSeconds: number
  /** 间隙内能量高于语音段的某个比例 → 可能是笑声而非纯停顿。 */
  kind: 'comedic_beat' | 'laughter_window' | 'breath'
  /** 笑声候选的平均能量（dB）；纯停顿为 null。 */
  energyDb: number | null
}

export type TalkshowBeatType = 'setup' | 'punchline' | 'callback' | 'crowd_work'

export interface TalkshowBeat {
  index: number
  type: TalkshowBeatType
  segmentIndex: number
  text: string
  startSeconds: number
  endSeconds: number
  /** 包袱词强调（来自 LLM 或创作者标注）。 */
  emphasis: string[]
  /** 该 beat 之后是否应等待笑声。 */
  waitForLaugh: boolean
}

export interface TalkshowRhythmTimeline {
  version: 1
  /** 节奏来源的哈希（音频字节），用于溯源。 */
  sourceAudioChecksum: string
  durationSeconds: number
  segments: TalkshowSegment[]
  pauses: TalkshowPause[]
  beats: TalkshowBeat[]
  /** 分类来源：'llm' | 'heuristic' | 'none'（无文本时无法分类）。 */
  classification: 'llm' | 'heuristic' | 'none'
}

// ---------------------------------------------------------------------------
// ASR / LLM 端口（可插拔）
// ---------------------------------------------------------------------------

export interface AsrWord {
  text: string
  startSeconds: number
  endSeconds: number
}

export interface AsrTranscript {
  /** 句级或词级时间戳；至少提供句级。 */
  words: AsrWord[]
}

/**
 * ASR 端口：输入音频文件的绝对路径，输出带时间戳的转写。
 * 实现可以是 OpenAI-compatible /audio/transcriptions、本地 whisper.cpp 等。
 * 未提供时退化为纯节奏骨架。
 */
export type TalkshowAsrPort = (audioPath: string, signal?: AbortSignal) => Promise<AsrTranscript>

/**
 * LLM beat 分类端口：输入带时间戳的句子，输出 beat 类型与强调词。
 * 未提供时退化为启发式。
 */
export type TalkshowBeatClassifierPort = (
  segments: readonly TalkshowSegment[],
  signal?: AbortSignal,
) => Promise<TalkshowBeat[]>

export interface RhythmExtractionOptions {
  /** 安全工作目录（必须在已校验的 runtime 内，不能是 /tmp）。 */
  workRoot: string
  asr?: TalkshowAsrPort
  beatClassifier?: TalkshowBeatClassifierPort
  /** 语音/静音能量阈值相对噪声 Floor 的偏移（dB）。默认 12。 */
  speechThresholdOffsetDb?: number
  /** 短于此时长（秒）的静音视为气口而非喜剧停顿。默认 0.4。 */
  breathMaxSeconds?: number
  /** 长于此时长（秒）的间隙若含高能量则判为笑声窗口。默认 0.5。 */
  laughterMinSeconds?: number
  signal?: AbortSignal
}

export class RhythmExtractionError extends Error {
  constructor(
    readonly code:
      | 'BINARY_UNAVAILABLE'
      | 'AUDIO_EXTRACTION_FAILED'
      | 'NO_SPEECH_DETECTED'
      | 'INVALID_MEDIA',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RhythmExtractionError'
  }
}

// ---------------------------------------------------------------------------
// 能量包络提取（ffmpeg astats + silencedetect）
// ---------------------------------------------------------------------------

interface SilenceInterval {
  startSeconds: number
  endSeconds: number
}

/**
 * 用 ffmpeg silencedetect 提取静音区间。silencedetect 的输出是确定性、可复现的，
 * 适合作为节奏骨架的信号源。
 */
async function detectSilences(
  ffmpegPath: string,
  audioPath: string,
  noiseDb: number,
  minSilenceSeconds: number,
  signal?: AbortSignal,
): Promise<SilenceInterval[]> {
  const { spawn } = await import('node:child_process')
  const args = [
    '-hide_banner', '-nostats',
    '-i', audioPath,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceSeconds}`,
    '-f', 'null', '-',
  ]
  const stderr = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    child.on('error', rejectPromise)
    child.on('close', () => resolvePromise(err))
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
  })
  const intervals: SilenceInterval[] = []
  const startRe = /silence_start:\s*([\d.]+)/g
  const endRe = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g
  const starts: number[] = []
  let m: RegExpExecArray | null
  while ((m = startRe.exec(stderr)) !== null) starts.push(Number.parseFloat(m[1]))
  const ends: Array<{ end: number; duration: number }> = []
  while ((m = endRe.exec(stderr)) !== null) {
    ends.push({ end: Number.parseFloat(m[1]), duration: Number.parseFloat(m[2]) })
  }
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    intervals.push({ startSeconds: starts[i], endSeconds: ends[i].end })
  }
  return intervals
}

/** 用 ffmpeg astats 提取整体能量指标（峰值/均值），辅助阈值自适应。 */
async function measureOverall(
  ffmpegPath: string,
  audioPath: string,
  signal?: AbortSignal,
): Promise<{ peakDb: number | null; meanDb: number | null; durationSeconds: number }> {
  const { spawn } = await import('node:child_process')
  const args = [
    '-hide_banner', '-nostats',
    '-i', audioPath,
    '-af', 'astats=metadata=0',
    '-f', 'null', '-',
  ]
  const stderr = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    child.on('error', rejectPromise)
    child.on('close', () => resolvePromise(err))
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
  })
  const grab = (label: string): number | null => {
    const re = new RegExp(`${label}:\\s*(-?[\\d.]+)`)
    const match = stderr.match(re)
    return match ? Number.parseFloat(match[1]) : null
  }
  return {
    peakDb: grab('Peak level dB'),
    meanDb: grab('RMS level dB') ?? grab('Mean level dB'),
    durationSeconds: 0, // 由 ffprobe 单独填
  }
}

async function probeDuration(ffprobePath: string, audioPath: string): Promise<number> {
  const { spawn } = await import('node:child_process')
  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(ffprobePath, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', audioPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.on('error', rejectPromise)
    child.on('close', () => resolvePromise(out))
  })
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } }
  const duration = Number.parseFloat(parsed.format?.duration ?? '')
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RhythmExtractionError('INVALID_MEDIA', '无法探测音频时长')
  }
  return duration
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 从视频/音频文件提取节奏时间轴。
 * @param inputMediaPath 演员 A 的表演视频（或已提取的音频）绝对路径。
 */
export async function extractTalkshowRhythm(
  inputMediaPath: string,
  options: RhythmExtractionOptions,
): Promise<TalkshowRhythmTimeline> {
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobePath = resolveBundledFfprobePath()
  if (!ffmpegPath || !ffprobePath) {
    throw new RhythmExtractionError('BINARY_UNAVAILABLE', '当前平台没有可用的 FFmpeg/ffprobe 固定二进制')
  }
  const signal = options.signal
  const breathMax = options.breathMaxSeconds ?? 0.4
  const laughterMin = options.laughterMinSeconds ?? 0.5

  const workDir = await mkdtemp(join(options.workRoot, '.rhythm-'))
  try {
    // 1. 提取单声道 16kHz PCM（VAD 友好、体积小）
    const audioPath = join(workDir, 'audio.wav')
    const { spawn } = await import('node:child_process')
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(ffmpegPath, [
        '-y', '-i', inputMediaPath,
        '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', audioPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8') })
      child.on('error', rejectPromise)
      child.on('close', (code) => {
        if (code === 0) resolvePromise()
        else rejectPromise(new RhythmExtractionError('AUDIO_EXTRACTION_FAILED', `音频提取失败（${code}）: ${err.slice(-300)}`))
      })
      signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
    })

    const audioBytes = new Uint8Array(await readFile(audioPath))
    const { createHash } = await import('node:crypto')
    const checksum = createHash('sha256').update(audioBytes).digest('hex')
    const durationSeconds = await probeDuration(ffprobePath, audioPath)

    // 2. 自适应阈值：以整体 RMS 为锚，向下偏移得到噪声门限
    const overall = await measureOverall(ffmpegPath, audioPath, signal)
    const offset = options.speechThresholdOffsetDb ?? 12
    const noiseDb = overall.meanDb !== null ? Math.round(overall.meanDb - offset) : -30

    // 3. 静音检测 → 语音段 + 间隙
    const silences = await detectSilences(ffmpegPath, audioPath, noiseDb, 0.18, signal)
    const segments: TalkshowSegment[] = []
    const pauses: TalkshowPause[] = []
    let cursor = 0
    let segIndex = 0
    for (const silence of silences) {
      if (silence.startSeconds > cursor + 0.1) {
        segIndex += 1
        segments.push({
          index: segIndex,
          startSeconds: cursor,
          endSeconds: silence.startSeconds,
          durationSeconds: silence.startSeconds - cursor,
          text: '',
          peakDb: overall.peakDb,
        })
      }
      const gapDuration = silence.endSeconds - silence.startSeconds
      pauses.push({
        afterSegment: segIndex,
        startSeconds: silence.startSeconds,
        durationSeconds: gapDuration,
        kind: gapDuration <= breathMax ? 'breath' : 'comedic_beat',
        energyDb: null,
      })
      cursor = silence.endSeconds
    }
    if (cursor < durationSeconds - 0.1) {
      segIndex += 1
      segments.push({
        index: segIndex,
        startSeconds: cursor,
        endSeconds: durationSeconds,
        durationSeconds: durationSeconds - cursor,
        text: '',
        peakDb: overall.peakDb,
      })
    }
    if (segments.length === 0) {
      throw new RhythmExtractionError('NO_SPEECH_DETECTED', '未在音频中检测到语音段，请确认是含人声的表演素材')
    }

    // 4. ASR（可插拔）：填充文本
    let classification: TalkshowRhythmTimeline['classification'] = 'none'
    if (options.asr) {
      const transcript = await options.asr(audioPath, signal)
      alignTranscriptToSegments(segments, transcript.words)
    }

    // 5. beat 分类（可插拔 LLM；否则启发式）
    let beats: TalkshowBeat[] = []
    const hasText = segments.some((s) => s.text.trim().length > 0)
    if (options.beatClassifier && hasText) {
      beats = await options.beatClassifier(segments, signal)
      classification = 'llm'
    } else if (hasText) {
      beats = heuristicBeatClassification(segments, pauses)
      classification = 'heuristic'
    }

    return {
      version: 1,
      sourceAudioChecksum: checksum,
      durationSeconds,
      segments,
      pauses,
      beats,
      classification,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 把 ASR 词级时间戳聚合到语音段（按时间重叠归属）。 */
function alignTranscriptToSegments(segments: TalkshowSegment[], words: readonly AsrWord[]): void {
  for (const segment of segments) {
    const overlapping = words.filter(
      (w) => w.startSeconds < segment.endSeconds && w.endSeconds > segment.startSeconds,
    )
    segment.text = overlapping.map((w) => w.text).join('').trim()
  }
}

/**
 * 启发式 beat 分类（无 LLM 时的确定性兜底）：
 * 长喜剧停顿后接的较短句 → punchline 候选；其余为 setup。
 * 明确标注为启发式，不假装是语义理解。
 */
function heuristicBeatClassification(
  segments: readonly TalkshowSegment[],
  pauses: readonly TalkshowPause[],
): TalkshowBeat[] {
  const longPauseAfter = new Set(
    pauses.filter((p) => p.kind !== 'breath' && p.durationSeconds >= 0.6).map((p) => p.afterSegment),
  )
  const beats: TalkshowBeat[] = []
  const medianDuration = median(segments.map((s) => s.durationSeconds))
  segments.forEach((segment, i) => {
    // 长停顿之后的短句倾向是包袱
    const followsLongPause = longPauseAfter.has(segment.index - 1)
    const isPunchline = followsLongPause && segment.durationSeconds <= medianDuration * 1.1
    beats.push({
      index: i + 1,
      type: isPunchline ? 'punchline' : 'setup',
      segmentIndex: segment.index,
      text: segment.text,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      emphasis: [],
      waitForLaugh: isPunchline,
    })
  })
  return beats
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// ---------------------------------------------------------------------------
// LLM beat 分类器（接现有文本 Provider，结构化输出 + 严格校验）
// ---------------------------------------------------------------------------

const BEAT_TYPES: readonly TalkshowBeatType[] = ['setup', 'punchline', 'callback', 'crowd_work']

interface LlmBeatVerdict {
  segmentIndex: number
  type: TalkshowBeatType
  emphasis: string[]
  waitForLaugh: boolean
}

function validateLlmBeats(value: unknown, segmentCount: number): LlmBeatVerdict[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LLM 返回必须是对象')
  const beats = (value as Record<string, unknown>).beats
  if (!Array.isArray(beats)) throw new Error('LLM 返回缺少 beats 数组')
  return beats.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new Error(`beats[${i}] 必须是对象`)
    const r = raw as Record<string, unknown>
    const segmentIndex = r.segmentIndex
    if (!Number.isInteger(segmentIndex) || (segmentIndex as number) < 1 || (segmentIndex as number) > segmentCount) {
      throw new Error(`beats[${i}].segmentIndex 越界`)
    }
    const type = r.type
    if (typeof type !== 'string' || !BEAT_TYPES.includes(type as TalkshowBeatType)) {
      throw new Error(`beats[${i}].type 无效`)
    }
    const emphasis = Array.isArray(r.emphasis) ? r.emphasis.filter((e): e is string => typeof e === 'string') : []
    return {
      segmentIndex: segmentIndex as number,
      type: type as TalkshowBeatType,
      emphasis,
      waitForLaugh: r.waitForLaugh === true,
    }
  })
}

/**
 * 用现有文本 Provider 构造 beat 分类端口。对带时间戳的句子做结构化分类，
 * 输出 setup/punchline/callback/crowd_work + 包袱词强调。分类是免费能力
 * （LLM 文本理解对产品免费），但仍是显式调用、可被调用方决定是否启用。
 */
export function createLlmBeatClassifier(textProvider: TextProvider): TalkshowBeatClassifierPort {
  return async (segments, signal) => {
    const lines = segments
      .map((s) => `第${s.index}句 [${s.startSeconds.toFixed(2)}s-${s.endSeconds.toFixed(2)}s]: ${s.text}`)
      .join('\n')
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['beats'],
      properties: {
        beats: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['segmentIndex', 'type', 'emphasis', 'waitForLaugh'],
            properties: {
              segmentIndex: { type: 'integer' },
              type: { type: 'string', enum: [...BEAT_TYPES] },
              emphasis: { type: 'array', items: { type: 'string' } },
              waitForLaugh: { type: 'boolean' },
            },
          },
        },
      },
    }
    const verdicts = await textProvider.generateStructured(
      {
        systemPrompt:
          '你是脱口秀结构分析器。把每句台词分类为 setup(铺垫)/punchline(包袱)/callback(回扣)/crowd_work(现挂互动)。' +
          '包袱句标出需要强调的“包袱词”(emphasis)并设 waitForLaugh=true。只输出严格 JSON。',
        userPrompt: `台词如下（带时间戳）：\n${lines}`,
        schemaName: 'talkshow_beats',
        schema: schema as never,
      },
      (value) => validateLlmBeats(value, segments.length),
      signal ?? new AbortController().signal,
    )
    const bySegment = new Map(verdicts.map((v) => [v.segmentIndex, v]))
    return segments.map((segment, i) => {
      const verdict = bySegment.get(segment.index)
      return {
        index: i + 1,
        type: verdict?.type ?? 'setup',
        segmentIndex: segment.index,
        text: segment.text,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        emphasis: verdict?.emphasis ?? [],
        waitForLaugh: verdict?.waitForLaugh ?? false,
      }
    })
  }
}

// ---------------------------------------------------------------------------
// 导出为结构化脚本（供 B 复刻 + 管道消费）
// ---------------------------------------------------------------------------

/**
 * 把节奏时间轴转成"脱口秀结构化脚本"——这是数字人管道的输入事实源。
 * B 的声音按 pausePlan 逐点注入 A 的停顿，按 beats 的 waitForLaugh 留笑声窗口。
 */
export function rhythmToStructuredScript(timeline: TalkshowRhythmTimeline): {
  version: 1
  sourceAudioChecksum: string
  beats: Array<Record<string, unknown>>
} {
  const beats: Array<Record<string, unknown>> = []
  const pauseAfterSegment = new Map<number, TalkshowPause[]>()
  for (const pause of timeline.pauses) {
    const list = pauseAfterSegment.get(pause.afterSegment) ?? []
    list.push(pause)
    pauseAfterSegment.set(pause.afterSegment, list)
  }

  const beatBySegment = new Map(timeline.beats.map((b) => [b.segmentIndex, b]))
  for (const segment of timeline.segments) {
    const beat = beatBySegment.get(segment.index)
    beats.push({
      type: beat?.type ?? 'setup',
      text: segment.text,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      delivery: { emphasis: beat?.emphasis ?? [] },
      ...(beat?.waitForLaugh ? { reaction: { waitForLaugh: true } } : {}),
    })
    // 在该段之后附上停顿（气口/喜剧节拍/笑声窗口）
    for (const pause of pauseAfterSegment.get(segment.index) ?? []) {
      if (pause.kind === 'breath') continue // 气口由 TTS 自然产生，不显式插入
      beats.push({
        type: 'pause',
        kind: pause.kind,
        durationSeconds: pause.durationSeconds,
      })
    }
  }
  return {
    version: 1,
    sourceAudioChecksum: timeline.sourceAudioChecksum,
    beats,
  }
}
