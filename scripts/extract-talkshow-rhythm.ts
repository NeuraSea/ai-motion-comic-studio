#!/usr/bin/env tsx
/**
 * 从演员 A 的表演视频提取脱口秀结构化节奏脚本。
 *
 * 用法：
 *   npx tsx scripts/extract-talkshow-rhythm.ts \
 *     --video ./actor-a-performance.mp4 \
 *     --out ./output/actor-a-rhythm.json
 *
 * 可选：
 *   --llm              用已配置的文本 Provider 做 beat 分类（setup/punchline/...）。
 *                      缺省时退化为启发式并标注 classification。
 *   --work-dir <dir>   安全工作目录（默认 runtime/，不能是 /tmp）。
 *
 * 输出 JSON 含：
 *   - segments: 语音段（起止/时长/能量）
 *   - pauses:   停顿（气口/喜剧节拍/笑声窗口）
 *   - beats:    setup/punchline 分类 + 包袱词强调 + waitForLaugh
 *   - script:   rhythmToStructuredScript 的结构化脚本（数字人管道输入事实源）
 *
 * 说明：ASR（语音转文字）需要可插拔端口；当前脚本默认**不做 ASR**（离线、零依赖），
 * 文本字段为空，由创作者对照原视频补齐。后续接入 ASR 后文本会自动填充并对齐时间戳。
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  extractTalkshowRhythm,
  rhythmToStructuredScript,
  createLlmBeatClassifier,
} from '../server/talkshow-rhythm.js'

function fatal(message: string): never {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      video: { type: 'string' },
      out: { type: 'string' },
      llm: { type: 'boolean', default: false },
      'work-dir': { type: 'string', default: 'runtime' },
    },
    strict: true,
  })
  if (!values.video) fatal('缺少 --video <演员A表演视频路径>')
  const videoPath = resolve(values.video)
  const workRoot = resolve(values['work-dir'] ?? 'runtime')

  console.log(`\n== 提取节奏: ${values.video} ==`)
  let beatClassifier
  if (values.llm) {
    try {
      // 延迟加载，避免无 LLM 时引入 provider 依赖
      const { loadCodexToolsApiKey, } = await import('../server/providers/codex-tools.js')
      const { OpenAICompatibleTextProvider } = await import('../server/providers/text.js')
      const apiKey = await loadCodexToolsApiKey()
      if (!apiKey) {
        console.warn('  ⚠ 未找到 Codex Tools key，退化为启发式分类')
      } else {
        const textProvider = new OpenAICompatibleTextProvider({
          baseUrl: 'http://127.0.0.1:8787',
          apiKey,
          model: 'gpt-5.5',
        })
        beatClassifier = createLlmBeatClassifier(textProvider)
        console.log('  使用 LLM beat 分类 (gpt-5.5)')
      }
    } catch (error) {
      console.warn('  ⚠ LLM 初始化失败，退化为启发式分类:', error instanceof Error ? error.message : error)
    }
  }

  const timeline = await extractTalkshowRhythm(videoPath, {
    workRoot,
    ...(beatClassifier ? { beatClassifier } : {}),
  })
  const script = rhythmToStructuredScript(timeline)

  const output = {
    video: videoPath,
    durationSeconds: timeline.durationSeconds,
    classification: timeline.classification,
    segments: timeline.segments,
    pauses: timeline.pauses,
    beats: timeline.beats,
    script,
  }
  const outPath = resolve(values.out ?? `output/talkshow-rhythm-${Date.now()}.json`)
  await mkdir(resolve(outPath, '..'), { recursive: true })
  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf-8')

  console.log(`\n  时长: ${timeline.durationSeconds.toFixed(2)}s`)
  console.log(`  语音段: ${timeline.segments.length} 个`)
  console.log(`  停顿: ${timeline.pauses.length} 个（气口 ${timeline.pauses.filter((p) => p.kind === 'breath').length}，喜剧节拍 ${timeline.pauses.filter((p) => p.kind === 'comedic_beat').length}，笑声窗口 ${timeline.pauses.filter((p) => p.kind === 'laughter_window').length}）`)
  console.log(`  分类来源: ${timeline.classification}`)
  console.log(`\n✓ 结构化脚本: ${outPath}`)
  if (timeline.classification !== 'llm') {
    console.log('  提示：未做 ASR 与 LLM 分类，文本字段为空。对照原视频补齐 beats[].text 后即可用于数字人管道。')
  }
}

main().catch((error) => {
  console.error('\n✗ 失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
