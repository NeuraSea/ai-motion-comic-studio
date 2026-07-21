import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { deflateSync } from 'node:zlib'

import {
  compileRenderSemanticPlan,
  renderSemanticPlanBoundarySignature,
  type RenderSemanticAssetBinding,
} from '@manju/opencut-editor'

import {
  renderTimelineFromSemanticPlan,
  subtitlesAsSrt,
} from '../server/export-render.js'
import { createFfmpegRenderer } from '../server/ffmpeg-renderer.js'
import { browserQuickExportBoundarySignature } from '../src/features/editor/browser-quick-export.js'
import type { TimelineMediaBinding, TimelineMediaManifest } from '../src/features/editor/manju-media-resolver.js'

const TICKS_PER_SECOND = 120_000
const FRAME_RATE = 24
const TOTAL_SECONDS = 6
const TOTAL_FRAMES = TOTAL_SECONDS * FRAME_RATE
// Unequal, frame-aligned speech lengths drive both the visual edit points and
// the three dialogue clips. This prevents the dual-encoder golden from
// accidentally blessing a fixed two-second Story-slot assumption.
const AUDIO_DRIVEN_SEGMENT_FRAMES = [36, 54, 54] as const
const AUDIO_DRIVEN_START_FRAMES = AUDIO_DRIVEN_SEGMENT_FRAMES.map((_, index) => (
  AUDIO_DRIVEN_SEGMENT_FRAMES.slice(0, index).reduce((sum, frames) => sum + frames, 0)
))
if (AUDIO_DRIVEN_SEGMENT_FRAMES.reduce((sum, frames) => sum + frames, 0) !== TOTAL_FRAMES) {
  throw new Error('audio-driven fixture durations must span the full timeline')
}
const TIMELINE_REVISION_ID = 'dual-encoder-timeline-revision-v1'
const STORY_REVISION_ID = 'dual-encoder-story-revision-v1'

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

function solidPng(red: number, green: number, blue: number, width = 640, height = 360): Buffer {
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
      scanlines[pixel] = red
      scanlines[pixel + 1] = green
      scanlines[pixel + 2] = blue
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function speechToneWav(frequency: number, durationFrames: number): Buffer {
  const sampleRate = 48_000
  const channels = 2
  const sampleWidth = 2
  const sampleCount = durationFrames * sampleRate / FRAME_RATE
  const dataBytes = sampleCount * channels * sampleWidth
  const output = Buffer.alloc(44 + dataBytes)
  output.write('RIFF', 0, 'ascii')
  output.writeUInt32LE(36 + dataBytes, 4)
  output.write('WAVE', 8, 'ascii')
  output.write('fmt ', 12, 'ascii')
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(channels, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * channels * sampleWidth, 28)
  output.writeUInt16LE(channels * sampleWidth, 32)
  output.writeUInt16LE(sampleWidth * 8, 34)
  output.write('data', 36, 'ascii')
  output.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    const seconds = index / sampleRate
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * seconds) * 8_000)
    const offset = 44 + index * channels * sampleWidth
    output.writeInt16LE(sample, offset)
    output.writeInt16LE(sample, offset + sampleWidth)
  }
  return output
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function bindingFor({
  trackId,
  elementId,
  elementType,
  assetId,
  checksum,
  url,
  startFrame,
  durationFrames,
}: {
  trackId: string
  elementId: string
  elementType: 'image' | 'audio'
  assetId: string
  checksum: string
  url: string
  startFrame: number
  durationFrames: number
}): TimelineMediaBinding {
  return {
    trackId,
    elementId,
    elementType,
    assetId,
    assetVersion: 1,
    assetChecksum: checksum,
    url,
    mimeType: elementType === 'image' ? 'image/png' : 'audio/wav',
    startTime: startFrame * TICKS_PER_SECOND / FRAME_RATE,
    duration: durationFrames * TICKS_PER_SECOND / FRAME_RATE,
    trimStart: 0,
    trimEnd: 0,
    retimeRate: 1,
    width: elementType === 'image' ? 640 : null,
    height: elementType === 'image' ? 360 : null,
    sourceDurationSeconds: elementType === 'audio' ? durationFrames / FRAME_RATE : null,
    sourceAudioEnabled: false,
  }
}

async function main(): Promise<void> {
  const outputDirectory = resolve(process.argv[2] ?? '')
  if (!process.argv[2]) throw new Error('usage: dual-encoder-fixture.ts OUTPUT_DIRECTORY')
  const assetsDirectory = join(outputDirectory, 'assets')
  const imageBytes = [
    solidPng(180, 30, 30),
    solidPng(30, 180, 30),
    solidPng(30, 30, 180),
  ]
  const imageIds = ['visual-red', 'visual-green', 'visual-blue']
  const imageFiles = ['red.png', 'green.png', 'blue.png']
  const audioFrequencies = [330, 550, 770]
  const audioIds = ['speech-red', 'speech-green', 'speech-blue']
  const audioFiles = ['speech-red.wav', 'speech-green.wav', 'speech-blue.wav']
  const audioFileById = new Map(audioIds.map((id, index) => [id, audioFiles[index]!] as const))
  const toneBytes = audioFrequencies.map((frequency, index) => (
    speechToneWav(frequency, AUDIO_DRIVEN_SEGMENT_FRAMES[index]!)
  ))
  const visualElements = imageIds.map((assetId, index) => ({
    id: `clip-${index + 1}`,
    type: 'image' as const,
    mediaId: assetId,
    startTime: AUDIO_DRIVEN_START_FRAMES[index]! * TICKS_PER_SECOND / FRAME_RATE,
    duration: AUDIO_DRIVEN_SEGMENT_FRAMES[index]! * TICKS_PER_SECOND / FRAME_RATE,
    params: { fit: 'cover' as const },
  }))
  const subtitleTexts = ['I', 'SECOND SECOND', 'THIRD THIRD THIRD THIRD']
  const subtitleElements = subtitleTexts.map((text, index) => ({
    id: `subtitle-${index + 1}`,
    type: 'text' as const,
    name: text,
    startTime: (AUDIO_DRIVEN_START_FRAMES[index]! + 12) * TICKS_PER_SECOND / FRAME_RATE,
    duration: 18 * TICKS_PER_SECOND / FRAME_RATE,
    params: { text },
  }))
  const audioElements = audioIds.map((assetId, index) => ({
    id: `speech-${index + 1}`,
    type: 'audio' as const,
    sourceType: 'upload' as const,
    mediaId: assetId,
    startTime: AUDIO_DRIVEN_START_FRAMES[index]! * TICKS_PER_SECOND / FRAME_RATE,
    duration: AUDIO_DRIVEN_SEGMENT_FRAMES[index]! * TICKS_PER_SECOND / FRAME_RATE,
    params: { audioRole: 'dialogue' as const, volume: 0.75 },
  }))
  const timelineDocument = {
    version: 1,
    editor: 'OpenCut-Classic',
    ticksPerSecond: TICKS_PER_SECOND,
    tracks: {
      overlay: [{ id: 'visual-track', type: 'video', elements: visualElements }, {
        id: 'subtitle-track', type: 'text', elements: subtitleElements,
      }],
      main: { id: 'main', type: 'video', elements: [] },
      audio: [{
        id: 'audio-track',
        type: 'audio',
        elements: audioElements,
      }],
    },
  }
  const assetBindings: RenderSemanticAssetBinding[] = [
    ...imageIds.map((assetId, index) => ({
      assetId,
      version: 1,
      checksum: sha256(imageBytes[index]!),
      mediaType: 'image' as const,
    })),
    ...audioIds.map((assetId, index) => ({
      assetId,
      version: 1,
      checksum: sha256(toneBytes[index]!),
      mediaType: 'audio' as const,
      sourceDurationFrames: AUDIO_DRIVEN_SEGMENT_FRAMES[index]!,
      audioRole: 'dialogue' as const,
    })),
  ]
  const plan = compileRenderSemanticPlan({
    timelineDocument,
    timelineDocumentId: 'dual-encoder-document-v1',
    timelineRevisionId: TIMELINE_REVISION_ID,
    storyRevisionId: STORY_REVISION_ID,
    aspectRatio: '16:9',
    assets: assetBindings,
  })
  if (plan.totalFrames !== TOTAL_FRAMES) throw new Error('fixture plan duration drifted')
  const manifest: TimelineMediaManifest = {
    issues: [],
    bindings: [
      ...plan.visualClips.map((clip, index) => bindingFor({
        trackId: 'visual-track',
        elementId: clip.id,
        elementType: 'image',
        assetId: clip.asset.assetId,
        checksum: clip.asset.checksum,
        url: `/assets/${imageFiles[index]}`,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
      })),
      ...plan.audioClips.map((clip) => {
        const filename = audioFileById.get(clip.asset.assetId)
        if (!filename) throw new Error(`missing fixture audio file for ${clip.asset.assetId}`)
        return bindingFor({
          trackId: 'audio-track',
          elementId: clip.id,
          elementType: 'audio',
          assetId: clip.asset.assetId,
          checksum: clip.asset.checksum,
          url: `/assets/${filename}`,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
        })
      }),
    ],
  }
  const canonicalSignature = renderSemanticPlanBoundarySignature(plan)
  const browserSignature = browserQuickExportBoundarySignature(plan)
  if (canonicalSignature !== browserSignature) {
    throw new Error('browser helper does not observe the canonical semantic boundaries')
  }
  const expected = {
    planSha256: sha256(JSON.stringify(plan)),
    boundarySignatureSha256: sha256(canonicalSignature),
    totalFrames: TOTAL_FRAMES,
    durationSeconds: TOTAL_SECONDS,
    frameRate: FRAME_RATE,
    audioDrivenSegmentDurationFrames: [...AUDIO_DRIVEN_SEGMENT_FRAMES],
    audioDrivenSegmentStartFrames: AUDIO_DRIVEN_START_FRAMES,
    audioSampleRate: 48_000,
    timelineRevisionId: TIMELINE_REVISION_ID,
    keyframes: [
      { seconds: 0.15, expectedDominantChannel: 0, label: 'red-before-subtitle' },
      { seconds: 0.75, expectedDominantChannel: 0, label: 'red-with-subtitle' },
      { seconds: 1.35, expectedDominantChannel: 0, label: 'red-after-subtitle' },
      { seconds: 1.65, expectedDominantChannel: 1, label: 'green-before-subtitle' },
      { seconds: 2.5, expectedDominantChannel: 1, label: 'green-with-subtitle' },
      { seconds: 3.6, expectedDominantChannel: 1, label: 'green-after-subtitle' },
      { seconds: 3.9, expectedDominantChannel: 2, label: 'blue-before-subtitle' },
      { seconds: 4.75, expectedDominantChannel: 2, label: 'blue-with-subtitle' },
      { seconds: 5.75, expectedDominantChannel: 2, label: 'blue-after-subtitle' },
    ],
    visualBoundaries: [
      { seconds: 1.5, beforeChannel: 0, afterChannel: 1 },
      { seconds: 3.75, beforeChannel: 1, afterChannel: 2 },
    ],
    subtitleSamplesSeconds: [0.75, 2.5, 4.75],
    subtitleBaselineSeconds: [0.15, 1.65, 3.9],
    audioSamples: [
      { seconds: 0.75, expectedFrequencyHz: 330 },
      { seconds: 2.5, expectedFrequencyHz: 550 },
      { seconds: 4.75, expectedFrequencyHz: 770 },
    ],
    subtitleTexts,
  }

  await Promise.all([
    ...imageBytes.map((bytes, index) => writeFile(join(assetsDirectory, imageFiles[index]!), bytes)),
    ...toneBytes.map((bytes, index) => writeFile(join(assetsDirectory, audioFiles[index]!), bytes)),
  ])
  const subtitlePath = join(outputDirectory, 'subtitles.srt')
  await writeFile(subtitlePath, subtitlesAsSrt(plan.subtitleCues))
  const assetPaths = new Map<string, string>([
    ...imageIds.map((id, index) => [id, join(assetsDirectory, imageFiles[index]!)] as const),
    ...audioIds.map((id, index) => [id, join(assetsDirectory, audioFiles[index]!)] as const),
  ])
  const renderer = createFfmpegRenderer()
  const formalOutput = join(outputDirectory, 'formal-ffmpeg.mp4')
  const result = await renderer.render({
    timeline: renderTimelineFromSemanticPlan({
      plan,
      assetPath: (assetId) => assetPaths.get(assetId),
      kenBurns: false,
      subtitles: { assetPath: subtitlePath, format: 'srt', burnIn: true },
    }),
    resolution: '720p',
    aspectRatio: '16:9',
    outputPath: formalOutput,
  })
  if (result.frameCount !== TOTAL_FRAMES) throw new Error('formal renderer frame count drifted')
  await writeFile(join(outputDirectory, 'fixture.json'), JSON.stringify({
    plan,
    manifest,
    expected,
    formal: {
      output: 'formal-ffmpeg.mp4',
      timelineRevisionId: plan.timelineRevisionId,
      planSha256: expected.planSha256,
      boundarySignatureSha256: expected.boundarySignatureSha256,
      durationSeconds: result.durationSeconds,
      frameCount: result.frameCount,
      width: result.width,
      height: result.height,
    },
  }))
}

await main()
