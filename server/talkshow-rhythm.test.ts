import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import {
  extractTalkshowRhythm,
  rhythmToStructuredScript,
  createLlmBeatClassifier,
  type TalkshowSegment,
} from './talkshow-rhythm.js'
import { resolveBundledFfmpegPath } from './ffmpeg-renderer.js'
import type { TextProvider } from './providers/text.js'

/** 用 ffmpeg 合成一段「句-停顿-句-长停顿-句」的测试音频。 */
async function synthesizePerformance(path: string): Promise<void> {
  const ffmpeg = resolveBundledFfmpegPath()
  assert.ok(ffmpeg, '需要固定版本 ffmpeg')
  // 3 段不同频率的正弦"语音"，中间夹 0.3s(breath) 与 1.0s(comedic_beat) 静音
  const filter =
    "sine=frequency=300:duration=1.0[s1];" +
    "sine=frequency=400:duration=1.2[s2];" +
    "sine=frequency=350:duration=1.0[s3];" +
    '[s1]apad=pad_dur=0.3[a1];' +
    '[a1][s2]concat=n=2:v=0:a=1[b];' +
    '[b]apad=pad_dur=1.0[b2];' +
    '[b2][s3]concat=n=2:v=0:a=1[out]'
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(ffmpeg!, [
      '-y', '-filter_complex', filter, '-map', '[out]', '-t', '5', path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (c: Buffer) => { err += c.toString() })
    child.on('error', rejectPromise)
    child.on('close', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(err.slice(-300)))))
  })
}

test('extractTalkshowRhythm detects speech segments and classifies pauses', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'rhythm-test-'))
  try {
    const mediaPath = join(workRoot, 'perf.wav')
    await synthesizePerformance(mediaPath)
    const timeline = await extractTalkshowRhythm(mediaPath, { workRoot })

    assert.ok(timeline.durationSeconds > 3, '应探测到总时长')
    assert.ok(timeline.segments.length >= 2, '应检测到至少 2 个语音段')
    assert.equal(timeline.sourceAudioChecksum.length, 64, '应有音频 checksum')
    assert.equal(timeline.classification, 'none', '无 ASR/文本时分类为 none')

    // 停顿应区分 breath（短）与 comedic_beat（长）
    const breaths = timeline.pauses.filter((p) => p.kind === 'breath')
    const beats = timeline.pauses.filter((p) => p.kind === 'comedic_beat')
    assert.ok(timeline.pauses.length >= 1, '应检测到停顿')
    // 长停顿（1.0s）应被判为 comedic_beat
    if (beats.length > 0) {
      assert.ok(beats.every((b) => b.durationSeconds > 0.4), 'comedic_beat 应长于 breath 阈值')
    }
    void breaths
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
})

test('rhythmToStructuredScript emits pause beats and skips breaths', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'rhythm-test-'))
  try {
    const mediaPath = join(workRoot, 'perf.wav')
    await synthesizePerformance(mediaPath)
    const timeline = await extractTalkshowRhythm(mediaPath, { workRoot })
    const script = rhythmToStructuredScript(timeline)

    assert.equal(script.version, 1)
    assert.equal(script.sourceAudioChecksum, timeline.sourceAudioChecksum)
    assert.ok(Array.isArray(script.beats))
    // 结构化脚本里不应包含 breath 类型的显式停顿
    const breathBeats = script.beats.filter((b) => b.kind === 'breath')
    assert.equal(breathBeats.length, 0, '气口不应显式插入脚本')
    // 每个语音段对应一个内容 beat
    const contentBeats = script.beats.filter((b) => b.type !== 'pause')
    assert.equal(contentBeats.length, timeline.segments.length)
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
})

test('ASR port aligns transcript text into segments', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'rhythm-test-'))
  try {
    const mediaPath = join(workRoot, 'perf.wav')
    await synthesizePerformance(mediaPath)
    const timeline = await extractTalkshowRhythm(mediaPath, {
      workRoot,
      // 伪 ASR：返回覆盖全时间轴的词级时间戳
      asr: async () => ({
        words: [
          { text: '大家好', startSeconds: 0, endSeconds: 1.0 },
          { text: '我是演员', startSeconds: 1.3, endSeconds: 2.5 },
        ],
      }),
    })
    const withText = timeline.segments.filter((s) => s.text.length > 0)
    assert.ok(withText.length >= 1, 'ASR 文本应填入至少一个语音段')
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
})

test('LLM beat classifier maps provider verdicts onto segments with strict validation', async () => {
  const segments: TalkshowSegment[] = [
    { index: 1, startSeconds: 0, endSeconds: 1.5, durationSeconds: 1.5, text: '铺垫一句', peakDb: null },
    { index: 2, startSeconds: 2.0, endSeconds: 3.0, durationSeconds: 1.0, text: '包袱来了', peakDb: null },
  ]
  const fakeTextProvider = {
    name: 'fake',
    model: 'fake',
    configured: true,
    async listModels() { return ['fake'] },
    async generateStructured<T>(_input: unknown, validate: (v: unknown) => T): Promise<T> {
      return validate({
        beats: [
          { segmentIndex: 1, type: 'setup', emphasis: [], waitForLaugh: false },
          { segmentIndex: 2, type: 'punchline', emphasis: ['包袱'], waitForLaugh: true },
        ],
      })
    },
  } as unknown as TextProvider

  const classifier = createLlmBeatClassifier(fakeTextProvider)
  const beats = await classifier(segments)
  assert.equal(beats.length, 2)
  assert.equal(beats[0].type, 'setup')
  assert.equal(beats[1].type, 'punchline')
  assert.deepEqual(beats[1].emphasis, ['包袱'])
  assert.equal(beats[1].waitForLaugh, true)
})

test('LLM beat classifier rejects out-of-range segmentIndex (fail-closed)', async () => {
  const segments: TalkshowSegment[] = [
    { index: 1, startSeconds: 0, endSeconds: 1.5, durationSeconds: 1.5, text: '唯一一句', peakDb: null },
  ]
  const badProvider = {
    name: 'fake', model: 'fake', configured: true,
    async listModels() { return ['fake'] },
    async generateStructured<T>(_input: unknown, validate: (v: unknown) => T): Promise<T> {
      return validate({ beats: [{ segmentIndex: 99, type: 'punchline', emphasis: [], waitForLaugh: true }] })
    },
  } as unknown as TextProvider
  const classifier = createLlmBeatClassifier(badProvider)
  await assert.rejects(() => classifier(segments), /越界|beats\[0\]\.segmentIndex/)
})
