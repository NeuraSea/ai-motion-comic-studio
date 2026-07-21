import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

import express from 'express'

import { createApplication, type ApplicationRuntime } from '../server/app-v1.js'
import type { KeychainCredentialSlot } from '../server/keychain.js'
import type { ProviderCredentialStore } from '../server/providers/service.js'
import type {
  MiniMaxSpeechInput,
  MiniMaxSpeechResult,
  SpeechProvider,
} from '../server/providers/minimax-tts.js'
import type {
  ImageGenerationInput,
  ImageProvider,
  ProviderImage,
  ProviderImageReference,
} from '../server/types.js'
import type { JsonObject } from '../server/types.js'
import {
  createShotVideoJobInput,
  resolvePublicShotVideoTarget,
} from '../server/shot-video-generation.js'
import { resolveShotVideoDuration } from '../server/shot-video-duration.js'
import { createShotVideoTimingRemediation } from '../server/shot-video-timing-remediation.js'

const E2E_MARKER = 'MANJU_E2E_READY '

if (process.env.MANJU_E2E !== '1') {
  throw new Error('The offline browser server is test-only; set MANJU_E2E=1 explicitly')
}

const runtimeDirectory = process.env.MANJU_E2E_RUNTIME_DIR?.trim()
if (!runtimeDirectory) throw new Error('MANJU_E2E_RUNTIME_DIR is required')

const performanceSpike = process.env.MANJU_E2E_PERFORMANCE_SPIKE === '1'
const performanceSpikeSpeechDirectory = process.env.MANJU_E2E_SPIKE_SPEECH_DIR?.trim()
if (performanceSpike && !performanceSpikeSpeechDirectory) {
  throw new Error('MANJU_E2E_SPIKE_SPEECH_DIR is required for the performance Spike')
}
const audioFirstAcceptance = process.env.MANJU_E2E_AUDIO_FIRST === '1'
const audioFirstSpeechDirectory = process.env.MANJU_E2E_AUDIO_FIRST_SPEECH_DIR?.trim()
if (audioFirstAcceptance && !audioFirstSpeechDirectory) {
  throw new Error('MANJU_E2E_AUDIO_FIRST_SPEECH_DIR is required for audio-first acceptance')
}
const recoveryGolden = process.env.MANJU_E2E_RECOVERY_GOLDEN === '1'
const perShotVisualGolden = process.env.MANJU_E2E_PER_SHOT_VISUAL_GOLDEN === '1'
if ([
  performanceSpike,
  audioFirstAcceptance,
  recoveryGolden,
  perShotVisualGolden,
].filter(Boolean).length > 1) {
  throw new Error('Performance Spike, audio-first acceptance, recovery golden, and per-shot visual golden modes are mutually exclusive')
}

const webRoot = resolve(process.env.MANJU_WEB_ROOT?.trim() || 'dist')
if (!existsSync(resolve(webRoot, 'index.html'))) {
  throw new Error(`Built web application not found at ${webRoot}; run npm run build first`)
}

class OfflineCredentialStore implements ProviderCredentialStore {
  private readonly values = new Map<string, string>()

  private key(slot: KeychainCredentialSlot): string {
    return JSON.stringify(slot)
  }

  async get(slot: KeychainCredentialSlot): Promise<string | null> {
    return this.values.get(this.key(slot)) ?? null
  }

  async set(slot: KeychainCredentialSlot, secret: string): Promise<void> {
    this.values.set(this.key(slot), secret)
  }

  async delete(slot: KeychainCredentialSlot): Promise<boolean> {
    return this.values.delete(this.key(slot))
  }

  async exists(slot: KeychainCredentialSlot): Promise<boolean> {
    return this.values.has(this.key(slot))
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0)) >>> 0
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  typeBytes.copy(header, 4)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([header, data, checksum])
}

/** A real non-black PNG; production image parsing and black-frame QC consume it unchanged. */
function solidPng(call: number, width = 640, height = 360): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const scanlines = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3)
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3
      scanlines[pixel] = 176 + ((call * 13 + x) % 64)
      scanlines[pixel + 1] = 64 + ((call * 29 + y) % 96)
      scanlines[pixel + 2] = 32 + ((x + y) % 64)
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Distinct vertical frames make decoded shot boundaries measurable after H.264. */
function performanceSpikePng(call: number): Buffer {
  const palette = [
    [190, 72, 54],
    [46, 116, 194],
    [203, 154, 48],
    [74, 164, 91],
    [143, 79, 182],
    [37, 158, 168],
    [211, 88, 135],
    [103, 116, 211],
    [198, 126, 52],
  ] as const
  const [baseRed, baseGreen, baseBlue] = palette[(call - 1) % palette.length]!
  const width = 360
  const height = 640
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const scanlines = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3)
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3
      const texture = ((x * 3 + y * 5) % 23) - 11
      scanlines[pixel] = Math.max(0, Math.min(255, baseRed + texture))
      scanlines[pixel + 1] = Math.max(0, Math.min(255, baseGreen + texture))
      scanlines[pixel + 2] = Math.max(0, Math.min(255, baseBlue + texture))
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

class OfflineImageProvider implements ImageProvider {
  readonly name = 'offline-browser-e2e'
  readonly model = 'gpt-image-2'
  readonly configured = true
  readonly supportsImageReferences = true
  calls = 0
  heldCalls = 0
  referenceCounts: number[] = []
  private holdNext = false
  private releases: Array<() => void> = []

  armNextCall(): void {
    if (this.holdNext) throw new Error('An offline image call is already armed')
    this.holdNext = true
  }

  releaseHeldCalls(): void {
    for (const release of this.releases.splice(0)) release()
  }

  async health() {
    return { status: 'ok' as const, message: '离线浏览器 E2E Provider 已就绪' }
  }

  async generate(
    input: ImageGenerationInput,
    signal: AbortSignal,
    references: readonly ProviderImageReference[] = [],
  ): Promise<ProviderImage[]> {
    signal.throwIfAborted()
    this.calls += 1
    this.referenceCounts.push(references.length)
    if (this.holdNext) {
      this.holdNext = false
      this.heldCalls += 1
      await new Promise<void>((resolveHold, rejectHold) => {
        const release = () => {
          signal.removeEventListener('abort', onAbort)
          resolveHold()
        }
        const onAbort = () => {
          this.releases = this.releases.filter((candidate) => candidate !== release)
          rejectHold(signal.reason)
        }
        this.releases.push(release)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      signal.throwIfAborted()
    }
    const isCharacterTurnaround = input.metadata?.kind === 'character-turnaround'
    return Array.from({ length: input.count }, (_, index) => ({
      bytes: performanceSpike
        ? performanceSpikePng(this.calls + index)
        // Turnaround confirmation splits the source into three vertical view
        // assets. Keep every derived view above Seedance's 300 px minimum and
        // inside its accepted aspect-ratio range without weakening production
        // validation for real user assets.
        : isCharacterTurnaround
          ? solidPng(this.calls + index, 1_536, 1_024)
          : solidPng(this.calls + index),
      mimeType: 'image/png',
      revisedPrompt: input.prompt,
    }))
  }
}

/**
 * Reads real, locally synthesized narration WAV files prepared by the Spike
 * harness. This exercises the production speech Job/Asset boundary without a
 * network request or billable Provider. The line number is intentionally part
 * of the immutable Story text so a mismatched fixture fails closed.
 */
class OfflineNarrationProvider implements SpeechProvider {
  readonly name = 'offline-performance-spike-speech'
  readonly model = 'speech-2.8-hd'
  readonly configured = true
  calls = 0

  constructor(private readonly directory: string) {}

  async synthesize(input: MiniMaxSpeechInput, signal?: AbortSignal): Promise<MiniMaxSpeechResult> {
    signal?.throwIfAborted()
    const match = input.text.match(/第\s*([1-9一二三四五六七八九])\s*镜/u)
    if (!match) throw new Error('离线旁白文本缺少可校验的镜头序号')
    const chineseIndex = '一二三四五六七八九'.indexOf(match[1]!) + 1
    const index = /^[1-9]$/u.test(match[1]!) ? Number(match[1]) : chineseIndex
    if (!Number.isInteger(index) || index < 1 || index > 9) {
      throw new Error('离线旁白镜头序号超出 Spike 边界')
    }
    const bytes = await readFile(resolve(this.directory, `speech-${index}.wav`))
    signal?.throwIfAborted()
    this.calls += 1
    return {
      audio: { kind: 'bytes', bytes, sourceEncoding: 'raw' },
      format: 'wav',
      mimeType: 'audio/wav',
      // Deliberately omit Provider duration metadata. Production speech code
      // must probe each locally generated WAV and persist its real length;
      // those unequal lengths become the OpenCut/Seedance timing authority.
      sampleRate: 44_100,
      bitrate: 1_536_000,
      channels: 2,
      audioSizeBytes: bytes.byteLength,
      usageCharacters: Array.from(input.text).length,
      wordCount: Array.from(input.text.replace(/[\s，。！？]/gu, '')).length,
      traceId: `offline-spike-speech-${index}`,
    }
  }
}

function fixtureStory() {
  if (performanceSpike) {
    const narration = [
      '第一镜，暮色降临古港。',
      '第二镜，守灯人穿过海雾。',
      '第三镜，铜灯映亮石阶。',
      '第四镜，远船在雾中回应。',
      '第五镜，灯芯迎着海风苏醒。',
      '第六镜，暖光越过青石码头。',
      '第七镜，归航帆影逐渐清晰。',
      '第八镜，钟声在港湾间回荡。',
      '第九镜，归航灯终于照亮归途。',
    ]
    return {
      version: 1 as const,
      title: '第 1 集',
      targetDurationSeconds: 45,
      bible: {
        logline: '守灯人在海雾中为归航者点亮古港的灯。',
        theme: '守望与归途',
        tone: '温暖克制',
        visualStyle: '国风动画，9:16 竖屏构图',
      },
      characters: [{
        id: 'keeper',
        name: '守灯人',
        role: '主角',
        storyDescription: '独自守望港口的年轻人。',
        visualDescription: '黑色短发，藏青长衫，暖色围巾，手持铜质灯盏。',
      }],
      locations: [{
        id: 'harbor',
        name: '黄昏古港',
        storyDescription: '潮水起落的安静古港。',
        visualDescription: '青石码头，远处帆影，黄昏金色侧光与薄雾。',
      }],
      props: [],
      scenes: [{
        id: 'scene-1',
        sequence: 0,
        title: '归航灯',
        locationId: 'harbor',
        timeOfDay: '黄昏',
        description: '守灯人穿过码头，将归航灯点亮。',
        shots: narration.map((text, index) => ({
          id: `shot-${index + 1}`,
          sequence: index,
          code: `01${String.fromCharCode(65 + index)}`,
          title: `归航镜头 ${index + 1}`,
          description: index < 8
            ? '守灯人沿青石码头向灯塔走去，海雾在暖光中流动。'
            : '归航灯亮起，远处帆影穿过薄雾。',
          framing: index === 0 ? '远景' : index === 8 ? '全景' : '中景',
          movement: '固定',
          transition: '硬切',
          durationSeconds: 5,
          visualPrompt: `国风动画，黄昏古港，藏青长衫与暖色围巾的守灯人，9:16 竖屏构图，镜头 ${index + 1}。`,
          dialogueLines: [{
            id: `line-${index + 1}`,
            sequence: 0,
            kind: 'narration' as const,
            speaker: '旁白',
            text,
          }],
        })),
      }],
    }
  }
  if (audioFirstAcceptance) {
    const lines = [
      { kind: 'narration' as const, speaker: '旁白', text: '第一镜，海雾压低了远处的天光。' },
      { kind: 'dialogue' as const, speaker: '阿岚', text: '第二镜，阿岚说，旧灯还没有亮。' },
      { kind: 'narration' as const, speaker: '旁白', text: '第三镜，她护住火种走上石阶。' },
      { kind: 'dialogue' as const, speaker: '阿岚', text: '第四镜，阿岚说，归航的人正在等我。' },
      { kind: 'narration' as const, speaker: '旁白', text: '第五镜，铜灯终于穿透层层海雾。' },
      { kind: 'dialogue' as const, speaker: '阿岚', text: '第六镜，阿岚说，看见灯，就能回家。' },
    ]
    return {
      version: 1 as const,
      title: '第 1 集',
      targetDurationSeconds: 30,
      bible: {
        logline: '守灯人阿岚在海雾中点亮归航灯。',
        theme: '守望与归途',
        tone: '温暖坚定',
        visualStyle: '国风动画，16:9 电影构图',
      },
      characters: [{
        id: 'keeper',
        name: '阿岚',
        role: '主角',
        storyDescription: '守护古港归航灯的年轻守灯人。',
        visualDescription: '黑色短发，藏青长衫，暖色围巾，手持铜质灯盏。',
      }],
      locations: [{
        id: 'harbor',
        name: '海雾古港',
        storyDescription: '归航船只等待灯火的古港。',
        visualDescription: '青石码头、灯塔、远处帆影与流动海雾。',
      }],
      props: [{
        id: 'lamp',
        name: '归航灯',
        description: '指引船只回港的铜灯。',
        visualDescription: '旧铜灯盏，暖黄色火焰。',
      }],
      scenes: [{
        id: 'scene-1',
        sequence: 0,
        title: '点亮归航灯',
        locationId: 'harbor',
        timeOfDay: '黄昏',
        description: '阿岚穿过海雾，点亮灯塔顶端的归航灯。',
        shots: lines.map((line, index) => ({
          id: `shot-${index + 1}`,
          sequence: index,
          code: `01${String.fromCharCode(65 + index)}`,
          title: `归航镜头 ${index + 1}`,
          description: [
            '阿岚正面面向镜头站在青石码头，海雾在她身后流动。',
            '阿岚侧面沿青石台阶向灯塔走去，手中护住铜灯。',
            '阿岚背对镜头走上灯塔石阶，远处帆影若隐若现。',
            '阿岚正面面向镜头停在灯室门口，说出等待归航的决心。',
            '阿岚侧面点燃铜灯，暖光穿透层层海雾。',
            '阿岚背对镜头举起归航灯，远船穿过薄雾回港。',
          ][index]!,
          framing: index === 0 ? '远景' : index === 5 ? '全景' : '中景',
          movement: '固定',
          transition: '硬切',
          durationSeconds: 5,
          visualPrompt: `国风动画，海雾古港，藏青长衫的阿岚与铜灯，16:9，${[
            '正面面向镜头',
            '侧面',
            '背对镜头',
            '正面面向镜头',
            '侧面',
            '背对镜头',
          ][index]}，镜头 ${index + 1}。`,
          dialogueLines: [{
            id: `line-${index + 1}`,
            sequence: 0,
            kind: line.kind,
            speaker: line.speaker,
            text: line.text,
          }],
        })),
      }],
    }
  }
  return {
    version: 1 as const,
    title: '第 1 集',
    targetDurationSeconds: 30,
    bible: {
      logline: '一名年轻守灯人在黄昏中点亮了归航的灯。',
      theme: '守望与希望',
      tone: '温暖克制',
      visualStyle: '国风动画，16:9 电影构图',
    },
    characters: [{
      id: 'keeper',
      name: '守灯人',
      role: '主角',
      storyDescription: '独自守望港口的年轻人。',
      visualDescription: '黑色短发，藏青长衫，暖色围巾，手持铜质灯盏。',
    }],
    locations: [{
      id: 'harbor',
      name: '黄昏港口',
      storyDescription: '潮水起落的安静古港。',
      visualDescription: '青石码头，远处帆影，黄昏金色侧光与薄雾。',
    }],
    props: [],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '归航灯',
      locationId: 'harbor',
      timeOfDay: '黄昏',
      description: '守灯人穿过码头，将归航灯点亮。',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `归航镜头 ${index + 1}`,
        description: index < 5
          ? '守灯人沿青石码头向灯塔走去，海雾在暖光中流动。'
          : '归航灯亮起，远处帆影穿过薄雾。',
        framing: index === 0 ? '远景' : index === 5 ? '全景' : '中景',
        movement: '固定',
        transition: '硬切',
        durationSeconds: 5,
        visualPrompt: `国风动画，黄昏港口，藏青长衫与暖色围巾的守灯人，电影构图，镜头 ${index + 1}。`,
        dialogueLines: [],
      })),
    }],
  }
}

const counters = { textRequests: 0, voiceCatalogRequests: 0, unexpectedNetworkRequests: 0 }

interface PerShotVisualBoundaryCall {
  idempotencyKey: string | null
  schemaName: string
  shotIds: string[]
  imageLabels: string[]
}

interface PerShotVisualGoldenEvidence {
  episodeId: string
  sourceRevisionId: string
  shots: Array<{
    shotId: string
    sceneId: string
    code: string
    storyboardAssetId: string
  }>
}

const perShotVisualBoundaryCalls: PerShotVisualBoundaryCall[] = []
let perShotVisualGoldenEvidence: PerShotVisualGoldenEvidence | null = null

interface RecoveryGoldenEvidence {
  episodeId: string
  sourceRevisionId: string
  staleTimingJobId: string
  affectedLineId: string
  timelineDocumentId: string
  compatibleRevisionId: string
  incompatibleRevisionId: string
}

let recoveryGoldenEvidence: RecoveryGoldenEvidence | null = null

function perShotVisualStory() {
  return {
    version: 1 as const,
    title: '逐镜视觉分析验收集',
    targetDurationSeconds: 30,
    bible: {
      logline: '三盏归航灯在海雾中依次亮起。',
      theme: '守望与归途',
      tone: '温暖克制',
      visualStyle: '国风动画，16:9 电影构图',
    },
    characters: [{
      id: 'keeper',
      name: '阿岚',
      role: '守灯人',
      storyDescription: '在海雾中守护归航灯的年轻人。',
      visualDescription: '黑色短发，藏青长衫，暖色围巾，手持铜灯。',
    }],
    locations: [{
      id: 'harbor',
      name: '海雾古港',
      storyDescription: '归航船只等待灯光的古港。',
      visualDescription: '青石码头、灯塔、远处帆影与流动海雾。',
    }],
    props: [],
    scenes: [{
      id: 'scene-visual',
      sequence: 0,
      title: '归航灯逐次亮起',
      locationId: 'harbor',
      timeOfDay: '黄昏',
      description: '海雾沿青石码头流动，三个镜头保持同一美术方向。',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `visual-shot-${index + 1}`,
        sequence: index,
        code: `V${index + 1}`,
        title: ['远山灯影', '码头雾光', '归航帆影', '灯塔铜铃', '潮水暖光', '破雾归航'][index]!,
        description: [
          '阿岚站在远处灯塔前，灯光在薄雾中刚刚亮起。',
          '阿岚守在潮湿的青石码头，暖光向前延伸。',
          '阿岚望着帆影穿过海雾，向明亮的港口驶来。',
        ][index % 3]!,
        framing: '中景',
        movement: '缓慢推进',
        transition: '硬切',
        durationSeconds: 5,
        // Deliberately names the character without a camera-relative front /
        // side / back cue. The fast deterministic policy must return a real
        // manual recovery, which the explicit visual Agent can then resolve.
        visualPrompt: `国风动画，阿岚、黄昏海雾与归航灯，16:9，独立镜头 ${index + 1}。`,
        dialogueLines: [],
      })),
    }],
  }
}

async function seedPerShotVisualGolden(
  value: ApplicationRuntime,
): Promise<PerShotVisualGoldenEvidence> {
  const episodeId = 'per-shot-visual-golden-episode'
  const story = perShotVisualStory()
  value.storyRepository.ensureEpisode('default', {
    id: episodeId,
    title: story.title,
    sourceText: '离线逐镜视觉分析固定剧本',
    targetDurationSeconds: story.targetDurationSeconds,
    aspectRatio: '16:9',
    stylePreset: '国风动画',
  })
  const applied = value.storyRepository.applyStory(episodeId, story)
  const sourceRevisionId = applied.revision.id
  const character = value.database.withSql((sql) => sql.get(`
    SELECT id
      FROM characters
     WHERE project_id = 'default'
       AND episode_id = ?
       AND json_extract(metadata_json, '$.storyId') = 'keeper'
  `, episodeId))
  if (typeof character?.id !== 'string') {
    throw new Error('Per-shot visual golden character did not persist')
  }
  const characterId = character.id
  const visualAudit = value.database.createRevision({
    projectId: 'default',
    summary: 'E2E per-shot character view slots',
    snapshot: {
      version: 1,
      kind: 'character.visual-references.lock',
      episodeId,
      sourceRevisionId,
    },
  })
  for (const [index, role] of ['front', 'side', 'back'].entries()) {
    const asset = await value.mediaStore.save({
      id: `per-shot-visual-character-${role}`,
      projectId: 'default',
      episodeId,
      kind: `character-turnaround-${role}`,
      bytes: solidPng(30 + index, 512, 512),
      mimeType: 'image/png',
      width: 512,
      height: 512,
      source: 'offline-per-shot-visual-golden',
      sourceRevisionId,
    })
    value.database.withSql((sql) => sql.run(`
      INSERT INTO character_visual_references (
        character_id, project_id, episode_id, role, asset_id, version,
        audit_revision_id, updated_at
      ) VALUES (?, 'default', ?, ?, ?, 1, ?, ?)
    `, characterId, episodeId, role, asset.id, visualAudit.id, asset.updatedAt))
  }
  const rows = value.database.withSql((sql) => sql.all(`
    SELECT shots.id AS database_shot_id,
           json_extract(shots.metadata_json, '$.storyId') AS shot_id,
           json_extract(scenes.metadata_json, '$.storyId') AS scene_id,
           shots.code AS code
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
     WHERE scenes.episode_id = ?
     ORDER BY scenes.sequence ASC, shots.sequence ASC
  `, episodeId))
  if (rows.length !== 6) throw new Error('Per-shot visual golden story did not persist six shots')
  const shots: PerShotVisualGoldenEvidence['shots'] = []
  for (const [index, row] of rows.entries()) {
    if (typeof row.database_shot_id !== 'string'
      || typeof row.shot_id !== 'string'
      || typeof row.scene_id !== 'string'
      || typeof row.code !== 'string') {
      throw new Error('Per-shot visual golden shot identity is incomplete')
    }
    const databaseShotId = row.database_shot_id
    const shotId = row.shot_id
    const sceneId = row.scene_id
    const code = row.code
    const storyboard = await value.mediaStore.save({
      id: `per-shot-visual-storyboard-${index + 1}`,
      projectId: 'default',
      episodeId,
      kind: 'storyboard.image',
      bytes: solidPng(20 + index),
      mimeType: 'image/png',
      width: 640,
      height: 360,
      source: 'offline-per-shot-visual-golden',
      sourceRevisionId,
    })
    value.database.withSql((sql) => sql.run(`
      UPDATE shots
         SET storyboard_asset_id = ?, status = 'storyboard_ready'
       WHERE id = ?
    `, storyboard.id, databaseShotId))
    shots.push({
      shotId,
      sceneId,
      code,
      storyboardAssetId: storyboard.id,
    })
  }
  return { episodeId, sourceRevisionId, shots }
}

function recoveryStory() {
  return {
    version: 1 as const,
    title: '恢复链路验收集',
    targetDurationSeconds: 30,
    bible: {
      logline: '守灯人在海雾中修复归航灯。',
      theme: '修复与归途',
      tone: '温暖坚定',
      visualStyle: '国风动画，16:9 电影构图',
    },
    characters: [],
    locations: [{
      id: 'harbor',
      name: '海雾古港',
      storyDescription: '归航船只等待灯火的古港。',
      visualDescription: '青石码头、灯塔、远处帆影与流动海雾。',
    }],
    props: [],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '修复归航灯',
      locationId: 'harbor',
      timeOfDay: '黄昏',
      description: '守灯人修好灯芯，让归航灯再次亮起。',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `R${index + 1}`,
        title: index === 0 ? '海雾中的旧灯' : `归航镜头 ${index + 1}`,
        description: index === 0
          ? '海雾压低天光，旧灯在青石码头边闪烁。'
          : '暖光沿青石码头逐步照亮归途。',
        framing: index === 0 ? '中景' : '远景',
        movement: '固定',
        transition: '硬切',
        durationSeconds: 5,
        visualPrompt: `国风动画，海雾古港与归航灯，16:9，镜头 ${index + 1}。`,
        dialogueLines: index === 0 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'narration' as const,
          speaker: '旁白',
          text: '海雾再浓，也遮不住回家的灯。',
        }] : [],
      })),
    }],
  }
}

/**
 * Seeds two fail-closed recovery incidents without invoking any Provider.
 * Every row is consumed through the same public HTTP and browser boundaries
 * as production; only fixture authoring is test-only.
 */
async function seedRecoveryGolden(value: ApplicationRuntime): Promise<RecoveryGoldenEvidence> {
  const episodeId = 'recovery-golden-episode'
  const story = recoveryStory()
  value.storyRepository.ensureEpisode('default', {
    id: episodeId,
    title: story.title,
    sourceText: '离线恢复链路固定剧本',
    targetDurationSeconds: story.targetDurationSeconds,
    aspectRatio: '16:9',
    stylePreset: '国风动画',
  })
  const applied = value.storyRepository.applyStory(episodeId, story)
  const sourceRevisionId = applied.revision.id
  const recoveryShots = value.database.withSql((sql) => sql.all(`
    SELECT shots.id AS database_shot_id,
           json_extract(shots.metadata_json, '$.storyId') AS story_shot_id
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
     WHERE scenes.episode_id = ?
     ORDER BY scenes.sequence ASC, shots.sequence ASC
  `, episodeId))
  if (recoveryShots.length !== 6) throw new Error('Recovery golden story did not persist six shots')
  for (const [index, row] of recoveryShots.entries()) {
    if (typeof row.database_shot_id !== 'string' || typeof row.story_shot_id !== 'string') {
      throw new Error('Recovery golden shot identity is incomplete')
    }
    const assetId = `recovery-storyboard-${index + 1}`
    const storyboard = await value.mediaStore.save({
      id: assetId,
      projectId: 'default',
      episodeId,
      kind: 'storyboard.image',
      bytes: solidPng(70 + index),
      mimeType: 'image/png',
      width: 640,
      height: 360,
      source: 'offline-recovery-golden',
      sourceRevisionId,
    })
    value.database.withSql((sql) => sql.run(`
      UPDATE shots
         SET storyboard_asset_id = ?, status = 'storyboard_ready'
       WHERE id = ?
    `, storyboard.id, row.database_shot_id))
  }
  const target = resolvePublicShotVideoTarget(value.database, {
    projectId: 'default',
    episodeId,
    shotId: 'shot-1',
    sceneId: 'scene-1',
  })
  const line = value.database.withSql((sql) => sql.get(`
    SELECT dialogue_lines.id AS id
      FROM dialogue_lines
      JOIN shots ON shots.id = dialogue_lines.shot_id
      JOIN scenes ON scenes.id = shots.scene_id
     WHERE scenes.episode_id = ?
       AND json_extract(dialogue_lines.metadata_json, '$.storyId') = 'line-1'
  `, episodeId))
  if (typeof line?.id !== 'string') throw new Error('Recovery golden dialogue line was not persisted')
  const lineId = line.id

  const bindSpeech = (id: string, durationSeconds: number, checksumByte: string) => {
    value.database.createMediaAsset({
      id,
      projectId: 'default',
      episodeId,
      kind: 'speech',
      status: 'ready',
      source: 'offline-recovery-golden',
      filePath: `/offline-fixture/${id}.wav`,
      mimeType: 'audio/wav',
      durationSeconds,
      checksum: checksumByte.repeat(64),
      sourceRevisionId,
    })
    value.database.withSql((sql) => sql.run(`
      UPDATE dialogue_lines
         SET speech_asset_id = ?, duration_seconds = ?
       WHERE id = ?
    `, id, durationSeconds, lineId))
  }

  bindSpeech('recovery-speech-old', 2, 'a')
  const previous = resolveShotVideoDuration(value.database, target)
  if (previous.status !== 'ready') throw new Error('Recovery golden old timing did not resolve')
  bindSpeech('recovery-speech-current', 3, 'b')
  const timingRemediation = createShotVideoTimingRemediation(value.database, {
    target,
    sceneId: 'scene-1',
    previousDecision: previous.decision,
    checkpoint: 'pre-submit',
    providerSubmissionState: 'not-started',
    detectedAt: '2026-07-15T03:00:00.000Z',
  })

  const compatible = value.timelineMaterializationService.materialize({
    projectId: 'default',
    episodeId,
    expectedRevisionId: null,
    summary: 'E2E compatible canonical head',
  })
  const incompatibleDocument = structuredClone(compatible.document)
  const tracks = incompatibleDocument.tracks as {
    overlay?: Array<{ elements?: Array<Record<string, unknown>> }>
  }
  const firstElement = tracks.overlay?.[0]?.elements?.[0]
  if (!firstElement) throw new Error('Recovery golden canonical timeline has no visual element')
  firstElement.type = 'future-hologram'
  firstElement.effects = [{
    id: 'vendor.future-refraction',
    enabled: true,
    settings: { amount: 0.42 },
  }]
  firstElement.animations = {
    'vendor.depthPulse': { version: 7, keys: [{ frame: 0, value: 0.25 }] },
  }
  const incompatible = value.timelineDocumentService.save({
    projectId: 'default',
    episodeId,
    expectedRevisionId: compatible.revision.id,
    schemaVersion: compatible.revision.schemaVersion,
    upstreamCommit: compatible.revision.upstreamCommit,
    summary: 'E2E incompatible future head',
    document: incompatibleDocument,
  })

  const seedance = value.database.getProviderConnection('seedance-video')
  if (!seedance?.defaultModel) throw new Error('Recovery golden Seedance Provider is not configured')
  const staleTimingJobId = 'recovery-stale-audio-timing-job'
  value.database.createGenerationJob({
    id: staleTimingJobId,
    projectId: 'default',
    episodeId,
    type: 'shot.video.generate',
    status: 'failed',
    progress: 5,
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: seedance.id,
    providerConfigRevision: seedance.configRevision,
    model: seedance.defaultModel,
    idempotencyKey: 'recovery-stale-audio-timing-job-root',
    input: createShotVideoJobInput(target, {
      resolution: '720p',
      audioPolicy: 'sfx_only',
      durationDecision: previous.decision,
    }) as unknown as JsonObject,
    providerState: {
      timingRemediation: timingRemediation as unknown as JsonObject,
    },
    progressDetail: { stage: 'pre-submit-audio-timing-check' },
    error: {
      code: 'STALE_AUDIO_TIMING',
      message: '台词或旁白音频已变更，视频时长合同失效；请基于最新音频重新预检',
      retryable: false,
      category: 'validation',
    },
    startedAt: '2026-07-15T02:59:59.000Z',
    completedAt: '2026-07-15T03:00:00.000Z',
  })

  return {
    episodeId,
    sourceRevisionId,
    staleTimingJobId,
    affectedLineId: 'line-1',
    timelineDocumentId: compatible.timelineDocument.id,
    compatibleRevisionId: compatible.revision.id,
    incompatibleRevisionId: incompatible.revision.id,
  }
}

// The deterministic providers below do not use global fetch. Fail closed if
// any other server path attempts an outbound HTTP request during this suite.
globalThis.fetch = (async () => {
  counters.unexpectedNetworkRequests += 1
  throw new Error('Unexpected outbound network request in offline browser E2E')
}) as typeof fetch

function recordPerShotVisualBoundary(init: RequestInit | undefined): {
  schemaName: string
  output: { shots: Array<Record<string, unknown>> }
} | null {
  if (!perShotVisualGolden || typeof init?.body !== 'string') return null
  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse(init.body) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    body = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const text = body.text
  const format = text && typeof text === 'object' && !Array.isArray(text)
    ? (text as Record<string, unknown>).format
    : null
  const schemaName = format && typeof format === 'object' && !Array.isArray(format)
    ? (format as Record<string, unknown>).name
    : null
  if (schemaName !== 'shot_video_visual_reference_plan') return null
  const messages = Array.isArray(body.input) ? body.input : []
  const user = messages.find((candidate) => (
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).role === 'user'
  )) as Record<string, unknown> | undefined
  const content = Array.isArray(user?.content) ? user.content : []
  const textParts = content.flatMap((candidate) => (
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).type === 'input_text'
    && typeof (candidate as Record<string, unknown>).text === 'string'
      ? [(candidate as Record<string, unknown>).text as string]
      : []
  ))
  const imageLabels = textParts.flatMap((part) => (
    part.startsWith('IMAGE_LABEL: ') ? [part.slice('IMAGE_LABEL: '.length)] : []
  ))
  const shotInputs = textParts[0]?.split('\n').flatMap((line) => {
    if (!line.startsWith('{')) return []
    try {
      const parsed = JSON.parse(line) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && typeof (parsed as Record<string, unknown>).shotId === 'string'
        ? [parsed as Record<string, unknown>]
        : []
    } catch {
      return []
    }
  }) ?? []
  if (shotInputs.length < 1) throw new Error('Per-shot visual fixture received no shot scope')
  const headers = new Headers(init.headers)
  perShotVisualBoundaryCalls.push({
    idempotencyKey: headers.get('idempotency-key'),
    schemaName,
    shotIds: shotInputs.map((shot) => shot.shotId as string),
    imageLabels,
  })
  const views = ['front', 'side', 'back'] as const
  const shots = shotInputs.map((shot, fallbackIndex) => {
    const shotId = shot.shotId as string
    const numeric = Number.parseInt(shotId.match(/(\d+)$/u)?.[1] ?? '', 10)
    const view = views[(Number.isInteger(numeric) ? numeric - 1 : fallbackIndex) % views.length]!
    const candidates = Array.isArray(shot.candidates)
      ? shot.candidates.filter((candidate): candidate is Record<string, unknown> => (
          Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate)
        ))
      : []
    const roleCandidate = candidates.find((candidate) => candidate.kind === `character-${view}`)
    if (!roleCandidate || typeof roleCandidate.visualId !== 'string') {
      throw new Error(`Per-shot visual fixture is missing ${view} role candidate for ${shotId}`)
    }
    const anchor = shot.storyboardVisualId
    if (typeof anchor !== 'string') {
      throw new Error(`Per-shot visual fixture is missing storyboard anchor for ${shotId}`)
    }
    const characters = Array.isArray(shot.characters)
      ? shot.characters.filter((character): character is Record<string, unknown> => (
          Boolean(character) && typeof character === 'object' && !Array.isArray(character)
          && typeof (character as Record<string, unknown>).characterId === 'string'
        ))
      : []
    return {
      shotId,
      strategy: 'multi_reference',
      compositionAnchorVisualId: anchor,
      referenceVisualIds: [roleCandidate.visualId],
      characterViews: characters.map((character) => ({
        characterId: character.characterId,
        view,
        confidence: 0.94,
        rationale: `离线视觉边界在本镜画面中验证了${{ front: '正面', side: '侧面', back: '背面' }[view]}身份特征。`,
      })),
      confidence: 0.94,
      rationale: '保留当前分镜作为构图锚点，并只绑定本镜视觉证据支持的角色槽位。',
      visualEvidence: [
        '分镜图的灯光位置与前景留白构成本镜构图锚点。',
        `角色轮廓与 ${view} 槽位的服饰、发型特征一致。`,
      ],
    }
  })
  return { schemaName, output: { shots } }
}

const offlineTextFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.endsWith('/v1/responses') || init?.method !== 'POST') {
    return Response.json({ error: { message: 'Unexpected offline text request' } }, { status: 404 })
  }
  const authorization = new Headers(init.headers).get('authorization')
  if (authorization !== 'Bearer offline-browser-e2e') {
    return Response.json({ error: { message: 'Missing fixture credential' } }, { status: 401 })
  }
  counters.textRequests += 1
  const visual = recordPerShotVisualBoundary(init)
  if (visual) {
    // Keep the Job observably active long enough for the browser to prove it
    // polls the durable Job rather than treating POST acceptance as success.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_050))
    return Response.json({
      output: [{
        content: [{ type: 'output_text', text: JSON.stringify(visual.output) }],
      }],
    })
  }
  return Response.json({
    output: [{
      content: [{ type: 'output_text', text: JSON.stringify(fixtureStory()) }],
    }],
  })
}

// The performance page mounts the real narrator/character casting controls,
// which read the verified account voice directory. Keep that read inside the
// explicit offline boundary instead of allowing it to fall through to the
// global network tripwire. The selected fixture voice is the same immutable
// voice ID submitted by the local speech Jobs.
const offlineVoiceCatalogFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const headers = new Headers(init?.headers)
  const expectedCredential = audioFirstAcceptance
    ? 'offline-audio-first-only'
    : 'offline-performance-spike-only'
  if (!url.endsWith('/v1/get_voice')
    || init?.method !== 'POST'
    || headers.get('authorization') !== `Bearer ${expectedCredential}`
    || init.body !== JSON.stringify({ voice_type: 'all' })) {
    return Response.json({ error: { message: 'Unexpected offline voice catalog request' } }, {
      status: 404,
    })
  }
  counters.voiceCatalogRequests += 1
  return Response.json({
    system_voice: audioFirstAcceptance ? [{
      voice_id: 'offline-audio-first-narrator',
      voice_name: '离线旁白声线',
      description: ['仅用于零外网音频优先验收的项目旁白。'],
    }, {
      voice_id: 'offline-audio-first-character',
      voice_name: '离线角色声线',
      description: ['仅用于零外网音频优先验收的角色对白。'],
    }] : [{
      voice_id: 'offline-system-narrator',
      voice_name: 'Offline system narrator',
      description: ['Local performance Spike narration voice.'],
    }],
    voice_cloning: [],
    voice_generation: [],
    base_resp: { status_code: 0, status_msg: 'success' },
  })
}

const imageProvider = new OfflineImageProvider()
const narrationProvider = performanceSpike || audioFirstAcceptance
  ? new OfflineNarrationProvider(
      performanceSpike ? performanceSpikeSpeechDirectory! : audioFirstSpeechDirectory!,
    )
  : undefined
let runtime: ApplicationRuntime | undefined
let server: Server | undefined
let shuttingDown = false

async function shutdown(exitCode = 0): Promise<never> {
  if (shuttingDown) await new Promise(() => undefined)
  shuttingDown = true
  if (server) {
    await new Promise<void>((resolveClose) => {
      server!.close(() => resolveClose())
      server!.closeAllConnections()
    })
  }
  await runtime?.close()
  process.exit(exitCode)
}

async function main(): Promise<void> {
  const credentialStore = new OfflineCredentialStore()
  runtime = await createApplication({
    runtimeDirectory,
    provider: imageProvider,
    textCompatibleFetch: offlineTextFetch,
    ...(narrationProvider ? { speechProvider: narrationProvider } : {}),
    ...(performanceSpike || audioFirstAcceptance
      ? { miniMaxVoiceCatalogFetch: offlineVoiceCatalogFetch }
      : {}),
    keychain: credentialStore,
    loadByoaCredential: async (providerId) => (
      providerId.startsWith('codex-tools') ? 'offline-browser-e2e' : null
    ),
    hasByoaCredential: async (providerId) => providerId.startsWith('codex-tools'),
    providerProbe: async (provider) => {
      if (provider.id === 'seedance-video') {
        return { status: 'ok', message: 'offline Seedance preflight fixture ready' }
      }
      return { status: 'ok', message: 'offline provider fixture ready' }
    },
  })
  // Configure a test-only Seedance profile so the browser can exercise the
  // non-billable preflight UX. The flow never confirms a task and the global
  // fetch boundary still fails closed on every unexpected network request.
  await runtime.providerService.save('seedance-video', {
    apiKey: 'offline-seedance-preflight-only',
    enabled: true,
  })
  await runtime.providerService.test('seedance-video')
  if (perShotVisualGolden) {
    await runtime.providerService.save('codex-tools-text', { enabled: true })
    await runtime.providerService.test('codex-tools-text')
  }
  if (performanceSpike || audioFirstAcceptance) {
    await runtime.providerService.save('minimax-speech', {
      apiKey: performanceSpike
        ? 'offline-performance-spike-only'
        : 'offline-audio-first-only',
      enabled: true,
    })
    await runtime.providerService.test('minimax-speech')
  }
  if (recoveryGolden) recoveryGoldenEvidence = await seedRecoveryGolden(runtime)
  if (perShotVisualGolden) {
    perShotVisualGoldenEvidence = await seedPerShotVisualGolden(runtime)
  }

  runtime.app.get('/__e2e__/evidence', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.json({
      providerCalls: {
        text: counters.textRequests,
        image: imageProvider.calls,
        speech: narrationProvider?.calls ?? 0,
        video: 0,
      },
      imageReferenceCounts: imageProvider.referenceCounts,
      unexpectedNetworkRequests: counters.unexpectedNetworkRequests,
      localVoiceCatalogRequests: counters.voiceCatalogRequests,
      heldImageRequests: imageProvider.heldCalls,
      performanceSpike,
      audioFirstAcceptance,
      recoveryGolden,
      perShotVisualGolden,
      perShotVisualBoundaryCalls: perShotVisualBoundaryCalls.map((call) => ({ ...call })),
      providerBoundary: perShotVisualGolden
        ? 'in-process-structured-vision-fixture'
        : recoveryGolden
        ? 'database-authored-recovery-fixture'
        : performanceSpike || audioFirstAcceptance
          ? 'local-system-tts-files'
          : 'deterministic-test-provider',
      runtimeDirectory,
    })
  })
  runtime.app.get('/__e2e__/per-shot-visual-evidence', (_request, response) => {
    if (!perShotVisualGolden || !perShotVisualGoldenEvidence) {
      response.status(404).json({ error: 'Per-shot visual golden mode is not active' })
      return
    }
    const jobs = runtime!.database.listGenerationJobs({
      projectId: 'default',
      episodeId: perShotVisualGoldenEvidence.episodeId,
      type: 'shot.video.reference.analyze',
      limit: 100,
    })
    response.setHeader('Cache-Control', 'no-store')
    response.json({
      ...perShotVisualGoldenEvidence,
      boundaryCalls: perShotVisualBoundaryCalls.map((call) => ({ ...call })),
      jobs: jobs.map((job) => ({
        id: job.id,
        status: job.status,
        providerId: job.providerId,
        providerConfigRevision: job.providerConfigRevision,
        model: job.model,
        input: job.input,
        output: job.output,
        cost: job.cost,
      })),
    })
  })
  runtime.app.get('/__e2e__/recovery-evidence', (_request, response) => {
    if (!recoveryGolden || !recoveryGoldenEvidence) {
      response.status(404).json({ error: 'Recovery golden mode is not active' })
      return
    }
    const timeline = runtime!.timelineDocumentService.get(recoveryGoldenEvidence.episodeId)
    const history = runtime!.timelineDocumentService.listRevisions(
      recoveryGoldenEvidence.timelineDocumentId,
      { limit: 100 },
    )
    response.setHeader('Cache-Control', 'no-store')
    response.json({
      ...recoveryGoldenEvidence,
      currentTimelineRevisionId: timeline.revision.id,
      currentTimelineDocument: timeline.document,
      timelineRevisionIds: history.revisions.map((revision) => revision.id),
      timelineRevisions: history.revisions.map((revision) => ({
        id: revision.id,
        parentRevisionId: revision.parentRevisionId,
        summary: revision.summary,
        snapshot: revision.snapshot,
      })),
      staleTimingJobStatus: runtime!.database
        .getGenerationJob(recoveryGoldenEvidence.staleTimingJobId)?.status ?? null,
    })
  })
  runtime.app.post('/__e2e__/control/hold-next-image', (_request, response) => {
    imageProvider.armNextCall()
    response.status(204).end()
  })
  runtime.app.post('/__e2e__/control/release-images', (_request, response) => {
    imageProvider.releaseHeldCalls()
    response.status(204).end()
  })
  runtime.app.use(express.static(webRoot, {
    dotfiles: 'deny',
    fallthrough: true,
    index: 'index.html',
    immutable: true,
    maxAge: '1y',
    setHeaders(response, filePath) {
      if (filePath.endsWith('.html')) response.setHeader('Cache-Control', 'no-store')
    },
  }))
  runtime.app.use((request, response, next) => {
    if (request.method !== 'GET' || !request.accepts('html')) {
      next()
      return
    }
    response.setHeader('Cache-Control', 'no-store')
    response.sendFile(resolve(webRoot, 'index.html'))
  })

  server = createServer(runtime.app)
  await new Promise<void>((resolveListen, reject) => {
    server!.once('error', reject)
  const requestedPort = Number(process.env.MANJU_E2E_PORT ?? '0')
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error('MANJU_E2E_PORT must be an integer from 0 to 65535')
  }
  server!.listen(requestedPort, '127.0.0.1', () => {
      server!.off('error', reject)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Offline E2E server did not bind TCP')
  process.stdout.write(`${E2E_MARKER}${JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}` })}\n`)
}

process.once('SIGINT', () => { void shutdown(0) })
process.once('SIGTERM', () => { void shutdown(0) })
process.stdin.once('end', () => { void shutdown(0) })

main().catch((error) => {
  console.error('Offline browser E2E server failed', error)
  void shutdown(1)
})
