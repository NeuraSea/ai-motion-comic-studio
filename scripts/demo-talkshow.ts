#!/usr/bin/env tsx
/**
 * Phase 0: 脱口秀真人数字人 Demo 命令行脚本
 *
 * 硬编码调用链（不动架构，直接复用 server 模块）：
 *   照片 → gpt-image-2 参考图集 → TTS → 音频驱动 timing
 *   → Seedance 2.5 逐句首帧视频 → FFmpeg 拼接+字幕 → 七项 QC
 *
 * 用法：
 *   npx tsx scripts/demo-talkshow.ts \
 *     --photo ./actor.jpg \
 *     --lines ./lines.txt \
 *     --out ./output/talkshow-demo \
 *     --voice-id <MiniMax音色ID> \
 *     --confirm-paid "我已确认付费"   # 显式付费确认门禁
 *
 * 可选：
 *   --audio-dir ./recordings/     # 用真人录音替代 TTS（逐句 mp3/wav，按行序命名 001.mp3 ...）
 *   --tts-provider doubao|minimax # TTS Provider（默认 doubao，复用 Ark 体系）
 *   --aspect 16:9 --resolution 1080p
 *   --seedance-model doubao-seedance-2.0   # 默认 2.0；2.5 需在 Ark 开通后显式指定
 *   --dry-run                     # 只生成参考图+音频+manifest，不提交付费视频任务
 *
 * 环境变量（或 macOS Keychain）：
 *   CODEX_TOOLS_API_KEY  或 Codex Tools api-proxy.key（图片）
 *   DOUBAO_SPEECH_API_KEY / MINIMAX_API_KEY（TTS，仅未提供 --audio-dir 时）
 *   SEEDANCE_API_KEY     或 Keychain provider:seedance-video（视频）
 *
 * 付费门禁：脚本对所有付费 Provider 调用（图片编辑、TTS、视频生成）要求
 * 显式传入 --confirm-paid，并在控制台打印估算的计费单元数量后等待用户
 * 二次确认（非 TTY 环境下 --confirm-paid 即视为确认）。这与服务端
 * paid-aigc-confirmation 的语义等价：无显式确认绝不发起计费请求。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, extname, basename } from 'node:path'
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'

import { CodexToolsImageProvider, loadCodexToolsApiKey } from '../server/providers/codex-tools.js'
import { MiniMaxSpeechProvider } from '../server/providers/minimax-tts.js'
import { DoubaoSpeechProvider } from '../server/providers/doubao-speech.js'
import { SeedanceVideoProvider } from '../server/providers/seedance.js'
import type { SeedanceImageReference } from '../server/providers/seedance.js'
import type { SpeechProvider } from '../server/providers/minimax-tts.js'
import { MacOSKeychain } from '../server/keychain.js'
import { probeAudioDuration } from '../server/audio-duration.js'
import { createFfmpegRenderer, resolveBundledFfmpegPath } from '../server/ffmpeg-renderer.js'
import type {
  ImmutableRenderTimelineSnapshot,
  VideoRenderClip,
  AudioRenderClip,
} from '../server/ffmpeg-renderer.js'
import { FfmpegQualityAnalyzer, DEFAULT_QUALITY_POLICY } from '../server/quality-check.js'
import type { QualityExpectedSpecification } from '../server/quality-check.js'
import { detectMediaMime } from '../server/media.js'

// 音频格式 → MIME 映射（probeAudioDuration 需要 mimeType；仅支持 mp3/wav）
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
}

// ---------------------------------------------------------------------------
// 配置与常量
// ---------------------------------------------------------------------------

const FPS = 24
const MIN_SEEDANCE_SECONDS = 4 // Seedance 最短源片
const MAX_SEEDANCE_SECONDS = 15 // 超过则要求拆句

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

interface TalkshowLine {
  index: number
  text: string
}

interface ReferenceAsset {
  key: string
  path: string
  sha256: string
}

interface LineAudioAsset {
  lineIndex: number
  text: string
  path: string
  sha256: string
  durationSeconds: number
}

interface LineVideoAsset {
  lineIndex: number
  path: string
  sha256: string
  providerTaskId: string
  durationSeconds: number
}

interface DemoManifest {
  version: 1
  createdAt: string
  photo: { path: string; sha256: string }
  references: ReferenceAsset[]
  lines: Array<{
    index: number
    text: string
    audio?: LineAudioAsset
    video?: LineVideoAsset
  }>
  output?: { path: string; sha256: string; durationSeconds: number }
  qc?: { passed: boolean | null; failedChecks: number; warningChecks: number }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fatal(message: string): never {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function info(message: string): void {
  console.log(`  ${message}`)
}

function step(title: string): void {
  console.log(`\n== ${title} ==`)
}

async function confirmPaid(promptText: string, autoConfirmed: boolean): Promise<void> {
  if (autoConfirmed) {
    info(`付费确认：--confirm-paid 已提供（${promptText}）`)
    return
  }
  if (!process.stdin.isTTY) {
    fatal(`需要付费确认：${promptText}\n请传入 --confirm-paid "我已确认付费" 后重试`)
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`\n⚠ 即将发起付费 Provider 调用：${promptText}\n输入 "确认付费" 继续，其它任意输入取消：`)
  rl.close()
  if (answer.trim() !== '确认付费') fatal('用户取消付费调用')
}

function resolveFfmpeg(): { ffmpeg: string; ffprobe: string } {
  const ffmpeg = resolveBundledFfmpegPath()
  if (!ffmpeg) fatal('找不到固定版本的 FFmpeg 二进制')
  const ffprobe = ffmpeg.replace(/ffmpeg[^/]*$/, 'ffprobe')
  return { ffmpeg, ffprobe }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      photo: { type: 'string' },
      lines: { type: 'string' },
      out: { type: 'string', default: './output/talkshow-demo' },
      'voice-id': { type: 'string' },
      'tts-provider': { type: 'string', default: 'doubao' },
      'audio-dir': { type: 'string' },
      aspect: { type: 'string', default: '16:9' },
      resolution: { type: 'string', default: '1080p' },
      'seedance-model': { type: 'string', default: 'doubao-seedance-2.0' },
      'confirm-paid': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'max-lines': { type: 'string' },
    },
    strict: true,
  })

  if (!values.photo) fatal('缺少 --photo <演员照片路径>')
  if (!values.lines) fatal('缺少 --lines <台词 txt 路径>')
  if (!values['audio-dir'] && !values['voice-id']) {
    fatal('缺少 --voice-id <音色ID>（或提供 --audio-dir 使用真人录音）')
  }
  const ttsProviderName = values['tts-provider'] ?? 'doubao'
  if (!['doubao', 'minimax'].includes(ttsProviderName)) {
    fatal('--tts-provider 必须是 doubao 或 minimax')
  }

  const aspectRatio = values.aspect as '16:9' | '9:16' | '1:1'
  if (!['16:9', '9:16', '1:1'].includes(aspectRatio)) fatal('--aspect 必须是 16:9 / 9:16 / 1:1')
  const resolution = values.resolution as '480p' | '720p' | '1080p'
  if (!['480p', '720p', '1080p'].includes(resolution)) fatal('--resolution 必须是 480p / 720p / 1080p')

  const outDir = resolve(values.out)
  await mkdir(outDir, { recursive: true })
  const refsDir = join(outDir, 'references')
  const audioDir = join(outDir, 'audio')
  const videoDir = join(outDir, 'videos')
  await mkdir(refsDir, { recursive: true })
  await mkdir(audioDir, { recursive: true })
  await mkdir(videoDir, { recursive: true })

  const paidConfirmed = typeof values['confirm-paid'] === 'string' && values['confirm-paid'].length > 0

  // ---- 读取输入 -----------------------------------------------------------
  step('1/7 读取演员照片与台词')
  const photoBytes = new Uint8Array(await readFile(resolve(values.photo)))
  const photoMime = detectMediaMime(photoBytes)
  if (!photoMime.startsWith('image/')) fatal(`照片不是有效图片（检测到 ${photoMime}）`)
  info(`照片: ${values.photo} (${photoMime}, ${photoBytes.length} bytes, sha256 ${sha256(photoBytes).slice(0, 12)}…)`)

  const linesRaw = await readFile(resolve(values.lines), 'utf-8')
  let lines: TalkshowLine[] = linesRaw
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text.length > 0 && !text.startsWith('#'))
    .map((text, index) => ({ index: index + 1, text }))
  const maxLines = values['max-lines'] ? Number.parseInt(values['max-lines'], 10) : undefined
  if (maxLines && maxLines > 0) lines = lines.slice(0, maxLines)
  if (lines.length === 0) fatal('台词文件为空')
  if (lines.length > 24) fatal(`台词最多 24 句（当前 ${lines.length} 句），超出请拆分`)
  info(`台词: ${lines.length} 句`)

  const manifest: DemoManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    photo: { path: resolve(values.photo), sha256: sha256(photoBytes) },
    references: [],
    lines: lines.map((l) => ({ index: l.index, text: l.text })),
  }

  // ---- 参考图集（幂等：已存在且非空则复用，不重复付费） ---------------------
  step('2/7 生成参考图集（gpt-image-2 edits，付费）')
  const controller = new AbortController()
  const pendingViews = []
  for (const view of REFERENCE_VIEWS) {
    const path = join(refsDir, `${view.key}.png`)
    let reused = false
    try {
      const existing = await stat(path)
      if (existing.size > 0) {
        const bytes = new Uint8Array(await readFile(path))
        manifest.references.push({ key: view.key, path, sha256: sha256(bytes) })
        info(`✓ ${view.label}（复用已有）: ${path}`)
        reused = true
      }
    } catch { /* 不存在则生成 */ }
    if (!reused) pendingViews.push(view)
  }
  if (pendingViews.length > 0) {
    const codexKey = await loadCodexToolsApiKey()
    if (!codexKey) fatal('未找到 Codex Tools API key（CODEX_TOOLS_API_KEY 或 Keychain）')
    const imageProvider = new CodexToolsImageProvider({ apiKey: codexKey })
    const health = await imageProvider.health()
    if (health.status === 'unavailable') fatal(`Codex Tools 不可用：${health.message}`)
    await confirmPaid(`图片编辑 ×${pendingViews.length}（gpt-image-2）`, paidConfirmed)
    for (const view of pendingViews) {
      const images = await imageProvider.generate(
        { prompt: view.prompt, size: '1024x1536', quality: 'high', count: 1 },
        controller.signal,
        [{ bytes: photoBytes, mimeType: photoMime }],
      )
      if (images.length === 0) fatal(`参考图「${view.label}」生成失败`)
      const bytes = images[0].bytes
      const path = join(refsDir, `${view.key}.png`)
      await writeFile(path, bytes)
      manifest.references.push({ key: view.key, path, sha256: sha256(bytes) })
      info(`✓ ${view.label}: ${path} (sha256 ${sha256(bytes).slice(0, 12)}…)`)
    }
  }
  // 按 REFERENCE_VIEWS 顺序排序 manifest.references
  manifest.references.sort((a, b) =>
    REFERENCE_VIEWS.findIndex((v) => v.key === a.key) - REFERENCE_VIEWS.findIndex((v) => v.key === b.key))
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // ---- 语音 ---------------------------------------------------------------
  step('3/7 生成/收集逐句语音')
  const lineAudios: LineAudioAsset[] = []
  if (values['audio-dir']) {
    info(`使用真人录音目录: ${values['audio-dir']}`)
    const dir = resolve(values['audio-dir'])
    for (const line of lines) {
      const padded = String(line.index).padStart(3, '0')
      const candidates = await readdir(dir)
      const match = candidates.find((f) => f.startsWith(padded) && /\.(mp3|wav)$/i.test(f))
      if (!match) fatal(`录音目录中找不到第 ${line.index} 句（${padded}.mp3/wav，仅支持 mp3/wav）`)
      const path = join(dir, match)
      const bytes = new Uint8Array(await readFile(path))
      const mime = AUDIO_MIME[extname(match).slice(1).toLowerCase()]
      if (!mime) fatal(`第 ${line.index} 句录音格式不支持（仅 mp3/wav）`)
      const durationSeconds = await probeAudioDuration(bytes, mime)
      lineAudios.push({ lineIndex: line.index, text: line.text, path, sha256: sha256(bytes), durationSeconds })
      info(`✓ 第${line.index}句: ${match} (${durationSeconds.toFixed(2)}s)`)
    }
  } else {
    const keychain = new MacOSKeychain()
    let tts: SpeechProvider
    let ttsLabel: string
    if (ttsProviderName === 'doubao') {
      const apiKey = process.env.DOUBAO_SPEECH_API_KEY
        ?? await keychain.get({ providerId: 'doubao-speech' })
        ?? await keychain.get({ providerId: 'doubao-speech', credentialKind: 'api-key' })
      if (!apiKey) fatal('未找到豆包语音 key（DOUBAO_SPEECH_API_KEY 或 Keychain provider:doubao-speech）')
      tts = new DoubaoSpeechProvider({ apiKey })
      ttsLabel = '豆包语音 2.0'
    } else {
      const apiKey = process.env.MINIMAX_API_KEY
        ?? await keychain.get({ providerId: 'minimax-speech' })
      if (!apiKey) fatal('未找到 MiniMax key（MINIMAX_API_KEY 或 Keychain provider:minimax-speech）')
      tts = new MiniMaxSpeechProvider({ apiKey })
      ttsLabel = 'MiniMax speech-2.8-hd'
    }
    if (!tts.configured) fatal(`${ttsLabel} 未正确配置`)
    await confirmPaid(`TTS ×${lines.length} 句（${ttsLabel}）`, paidConfirmed)
    for (const line of lines) {
      const result = await tts.synthesize(
        {
          text: line.text,
          voiceId: values['voice-id']!,
          subtitleEnable: true,
          subtitleType: 'word',
          outputFormat: 'hex',
        },
        controller.signal,
      )
      if (result.audio.kind !== 'bytes') fatal(`第${line.index}句 TTS 返回 URL 音频，脚本模式暂不支持`)
      const bytes = result.audio.bytes
      const padded = String(line.index).padStart(3, '0')
      const path = join(audioDir, `${padded}.${result.format}`)
      await writeFile(path, bytes)
      const audioMime = AUDIO_MIME[result.format]
      if (!audioMime) fatal(`TTS 返回了不支持的音频格式 ${result.format}（仅支持 mp3/wav）`)
      const durationSeconds = await probeAudioDuration(bytes, audioMime)
      lineAudios.push({ lineIndex: line.index, text: line.text, path, sha256: sha256(bytes), durationSeconds })
      info(`✓ 第${line.index}句: ${durationSeconds.toFixed(2)}s → ${basename(path)}`)
    }
  }
  for (const la of lineAudios) {
    manifest.lines[la.lineIndex - 1].audio = la
  }
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // ---- 音频驱动 timing ----------------------------------------------------
  step('4/7 音频驱动 timing manifest（24fps）')
  const timings = lineAudios.map((la) => {
    const seconds = la.durationSeconds
    if (seconds > MAX_SEEDANCE_SECONDS) {
      fatal(`第${la.lineIndex}句音频 ${seconds.toFixed(2)}s 超过 ${MAX_SEEDANCE_SECONDS}s 上限，请拆句`)
    }
    const targetSeconds = Math.max(MIN_SEEDANCE_SECONDS, Math.ceil(seconds))
    const frames = Math.round(seconds * FPS)
    return { ...la, seconds, targetSeconds, frames }
  })
  const totalSeconds = timings.reduce((sum, t) => sum + t.seconds, 0)
  info(`共 ${timings.length} 句，总时长 ${totalSeconds.toFixed(2)}s`)
  for (const t of timings) {
    info(`  第${t.lineIndex}句: 音频 ${t.seconds.toFixed(2)}s → Seedance 源片 ${t.targetSeconds}s（${t.frames} 帧）`)
  }

  if (values['dry-run']) {
    step('DRY-RUN 完成')
    info(`manifest: ${join(outDir, 'manifest.json')}`)
    info('未提交任何付费视频任务')
    return
  }

  // ---- Seedance 逐句视频 --------------------------------------------------
  step(`5/7 Seedance 逐句首帧视频（付费，模型 ${values['seedance-model']}）`)
  const seedanceKey = process.env.SEEDANCE_API_KEY
    ?? await new MacOSKeychain().get({ providerId: 'seedance-video' })
    ?? await new MacOSKeychain().get({ providerId: 'seedance-video', credentialKind: 'api-key' })
  if (!seedanceKey) fatal('未找到 Seedance key（SEEDANCE_API_KEY 或 Keychain provider:seedance-video）')
  const seedance = new SeedanceVideoProvider({
    apiKey: seedanceKey,
    model: values['seedance-model'],
  })
  info(`模型: ${seedance.model}，分辨率: ${resolution}，比例: ${aspectRatio}`)

  await confirmPaid(`Seedance 视频 ×${timings.length} 段（${values['seedance-model']}，预计 ${timings.reduce((s, t) => s + t.targetSeconds, 0)}s）`, paidConfirmed)

  // 每句用「正面」或「说话表情」参考图作为首帧
  const frontRef = manifest.references.find((r) => r.key === 'front') ?? manifest.references[0]
  const frontBytes = new Uint8Array(await readFile(frontRef.path))
  const frontDataUrl = `data:image/png;base64,${Buffer.from(frontBytes).toString('base64')}`

  for (const t of timings) {
    const reference: SeedanceImageReference = { url: frontDataUrl, role: 'first_frame' }
    const prompt = `${VIDEO_STYLE_PROMPT}。演员正在说：「${t.text}」`
    info(`提交第${t.lineIndex}句视频任务…`)
    const created = await seedance.createTask(
      {
        prompt,
        aspectRatio,
        resolution,
        durationSeconds: t.targetSeconds,
        generateAudio: false,
        referenceImages: [reference],
      },
      controller.signal,
    )
    info(`  任务 ${created.id} 已提交，轮询中…`)

    let task
    for (;;) {
      await new Promise((r) => setTimeout(r, 5_000))
      task = await seedance.getTask(created.id, controller.signal)
      if (task.status === 'succeeded') break
      if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'expired') {
        fatal(`第${t.lineIndex}句视频任务 ${task.status}: ${task.error?.message ?? '无详情'}`)
      }
      process.stdout.write('.')
    }
    if (!task.videoUrl) fatal(`第${t.lineIndex}句任务成功但无视频 URL`)

    const { downloadSeedanceVideo } = await import('../server/shot-video-generation.js')
    const video = await downloadSeedanceVideo(task.videoUrl, controller.signal)
    const padded = String(t.lineIndex).padStart(3, '0')
    const videoPath = join(videoDir, `${padded}.mp4`)
    await writeFile(videoPath, video.bytes)
    const videoAsset: LineVideoAsset = {
      lineIndex: t.lineIndex,
      path: videoPath,
      sha256: sha256(video.bytes),
      providerTaskId: created.id,
      durationSeconds: task.durationSeconds ?? t.targetSeconds,
    }
    manifest.lines[t.lineIndex - 1].video = videoAsset
    await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    info(`\n✓ 第${t.lineIndex}句视频: ${videoPath} (${videoAsset.durationSeconds}s)`)
  }

  // ---- FFmpeg 拼接 + 字幕 --------------------------------------------------
  step('6/7 FFmpeg 拼接 + 字幕烧录')
  const renderer = createFfmpegRenderer()
  const outputPath = join(outDir, 'talkshow-demo.mp4')

  // 生成 SRT
  const srtEntries: string[] = []
  let cursorSeconds = 0
  for (const t of timings) {
    const start = cursorSeconds
    const end = cursorSeconds + t.seconds
    srtEntries.push(
      `${t.lineIndex}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${t.text}\n`,
    )
    cursorSeconds = end
  }
  const srtPath = join(outDir, 'subtitles.srt')
  await writeFile(srtPath, srtEntries.join('\n'), 'utf-8')

  // 构建 ImmutableRenderTimelineSnapshot
  let currentFrame = 0
  const visualClips: VideoRenderClip[] = []
  const audioClips: AudioRenderClip[] = []
  for (const t of timings) {
    const videoAsset = manifest.lines[t.lineIndex - 1].video!
    const durationFrames = Math.round(t.seconds * FPS)
    visualClips.push({
      mediaType: 'video',
      id: `line-${t.lineIndex}`,
      startFrame: currentFrame,
      durationFrames,
      assetPath: videoAsset.path,
      sourceStartSeconds: 0,
      sourceDurationSeconds: t.seconds,
      fit: 'cover',
    })
    audioClips.push({
      id: `audio-${t.lineIndex}`,
      startFrame: currentFrame,
      assetPath: t.path,
      durationFrames,
      audioRole: 'dialogue',
    })
    currentFrame += durationFrames
  }

  const timeline: ImmutableRenderTimelineSnapshot = {
    revisionId: `demo-${Date.now()}`,
    frameRate: FPS,
    visualClips,
    audioClips,
    subtitles: { assetPath: srtPath, format: 'srt', burnIn: true },
  }

  const renderResult = await renderer.render({
    timeline,
    resolution: resolution === '480p' ? '720p' : resolution,
    aspectRatio,
    outputPath,
  })
  info(`✓ 成片: ${renderResult.outputPath}`)

  const outputBytes = new Uint8Array(await readFile(outputPath))
  manifest.output = {
    path: outputPath,
    sha256: sha256(outputBytes),
    durationSeconds: totalSeconds,
  }

  // ---- QC ------------------------------------------------------------------
  step('7/7 七项 QC')
  const analyzer = new FfmpegQualityAnalyzer()
  const expectedWidth = aspectRatio === '16:9' ? (resolution === '1080p' ? 1920 : 1280) : (resolution === '1080p' ? 1080 : 720)
  const expectedHeight = aspectRatio === '16:9' ? (resolution === '1080p' ? 1080 : 720) : (resolution === '1080p' ? 1920 : 1280)
  const expected: QualityExpectedSpecification = {
    container: 'mp4',
    durationSeconds: totalSeconds,
    frameCount: Math.round(totalSeconds * FPS),
    videoCodec: 'h264',
    width: expectedWidth,
    height: expectedHeight,
    pixelFormat: 'yuv420p',
    frameRate: FPS,
    audioCodec: 'aac',
    audioSampleRate: 48_000,
    audioChannels: 2,
  }
  const qc = await analyzer.analyze({ inputPath: outputPath, expected, policy: DEFAULT_QUALITY_POLICY })
  manifest.qc = {
    passed: qc.passed,
    failedChecks: qc.checks.filter((c) => c.status === 'failed').length,
    warningChecks: qc.checks.filter((c) => c.status === 'warning').length,
  }
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await writeFile(join(outDir, 'qc-report.json'), JSON.stringify(qc, null, 2))

  for (const check of qc.checks) {
    const icon = check.status === 'passed' ? '✓' : check.status === 'warning' ? '⚠' : '✗'
    info(`${icon} ${check.id}: ${check.status}${check.message ? ` — ${check.message}` : ''}`)
  }

  step('完成')
  info(`成片: ${outputPath}`)
  info(`QC: ${qc.passed === true ? '通过' : qc.passed === false ? '未通过' : '部分通过'}`)
  info(`manifest: ${join(outDir, 'manifest.json')}`)
  info(`QC 报告: ${join(outDir, 'qc-report.json')}`)
  if (qc.passed === false) process.exit(1)
}

function formatSrtTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const ms = Math.round((totalSeconds % 1) * 1000)
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${String(ms).padStart(3, '0')}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// ---------------------------------------------------------------------------

main().catch((error) => {
  console.error('\n✗ 未预期错误:', error)
  process.exit(1)
})
