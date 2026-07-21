import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EditorAudioTrack, EditorSceneTracks, EditorTimelineElement } from '@manju/opencut-editor'
import { projectManagedSubtitleCueSetToOpenCut } from '../src/features/editor/managed-subtitle-projection'

const SECOND = 120_000
const FRAME = SECOND / 24

function audioElement(overrides: Partial<EditorTimelineElement> = {}): EditorTimelineElement {
  return {
    id: 'audio-1',
    type: 'audio',
    sourceType: 'upload',
    mediaId: 'speech-1',
    name: '对白',
    startTime: 2 * SECOND,
    duration: SECOND,
    trimStart: 0,
    trimEnd: 0,
    sourceDuration: SECOND,
    params: {
      dialogueLineId: 'line-1',
      storySceneId: 'scene-1',
      storyShotId: 'shot-1',
    },
    ...overrides,
  }
}

function tracks(audio: EditorTimelineElement | EditorTimelineElement[], extra: EditorAudioTrack[] = []): EditorSceneTracks {
  return {
    overlay: [],
    main: { id: 'main', name: '主轨', type: 'video', elements: [] },
    audio: [{
      id: 'dialogue-main', name: '对白', type: 'audio', muted: false,
      elements: Array.isArray(audio) ? audio : [audio],
    }, ...extra],
  }
}

function input() {
  return {
    cueSetId: 'cue-set-1',
    dialogueLineId: 'line-1',
    storySceneId: 'scene-1',
    storyShotId: 'shot-1',
    speechAssetId: 'speech-1',
    cues: [
      { text: ' 第一条 ', startMs: 100, endMs: 300 },
      { text: '第二条', startMs: 300, endMs: 600 },
    ],
  }
}

test('projects source millisecond cues to absolute 24fps OpenCut ticks', () => {
  const result = projectManagedSubtitleCueSetToOpenCut(tracks(audioElement()), input())
  assert.deepEqual(result, {
    cueSetId: 'cue-set-1',
    dialogueLineId: 'line-1',
    storySceneId: 'scene-1',
    storyShotId: 'shot-1',
    speechAssetId: 'speech-1',
    sourceAudioElementId: 'audio-1',
    sourceAudioStartTime: 2 * SECOND,
    sourceAudioTrimStart: 0,
    sourceAudioDuration: SECOND,
    cues: [
      { text: '第一条', startTime: 2 * SECOND + 2 * FRAME, duration: 5 * FRAME, sourceStartMs: 100, sourceEndMs: 300 },
      { text: '第二条', startTime: 2 * SECOND + 7 * FRAME, duration: 7 * FRAME, sourceStartMs: 300, sourceEndMs: 600 },
    ],
  })
})

test('clips source cue provenance inward at the visible trim range', () => {
  const result = projectManagedSubtitleCueSetToOpenCut(tracks(audioElement({
    startTime: 0,
    trimStart: SECOND / 2,
    sourceDuration: SECOND * 2,
  })), {
    ...input(),
    cues: [
      { text: '跨过裁剪点', startMs: 400, endMs: 700 },
      { text: '可见', startMs: 700, endMs: 1_000 },
    ],
  })
  assert.deepEqual(result.cues, [
    { text: '跨过裁剪点', startTime: 0, duration: 5 * FRAME, sourceStartMs: 500, sourceEndMs: 700 },
    { text: '可见', startTime: 5 * FRAME, duration: 7 * FRAME, sourceStartMs: 700, sourceEndMs: 1_000 },
  ])
})

test('fails closed when trim removes a cue or frame rounding creates overlap', () => {
  assert.throws(() => projectManagedSubtitleCueSetToOpenCut(tracks(audioElement({
    startTime: 0,
    trimStart: SECOND / 2,
    sourceDuration: SECOND * 2,
  })), {
    ...input(),
    cues: [{ text: '已裁掉', startMs: 0, endMs: 400 }],
  }), /裁剪后为空/)

  assert.throws(() => projectManagedSubtitleCueSetToOpenCut(tracks(audioElement({ startTime: 0 })), {
    ...input(),
    cues: [
      { text: 'a', startMs: 0, endMs: 1 },
      { text: 'b', startMs: 1, endMs: 2 },
    ],
  }), /投影到 24fps 后与上一条重叠/)
})

test('requires exactly one active audio element with the full asset and story binding', () => {
  const muted: EditorAudioTrack = {
    id: 'muted', type: 'audio', muted: true,
    elements: [audioElement({ id: 'muted-copy' })],
  }
  assert.equal(
    projectManagedSubtitleCueSetToOpenCut(tracks(audioElement(), [muted]), input()).sourceAudioElementId,
    'audio-1',
  )

  assert.throws(() => projectManagedSubtitleCueSetToOpenCut(
    tracks([audioElement(), audioElement({ id: 'audio-2' })]),
    input(),
  ), /存在多个/)
  assert.throws(() => projectManagedSubtitleCueSetToOpenCut(
    tracks(audioElement({ params: { ...audioElement().params, storyShotId: 'other-shot' } })),
    input(),
  ), /找不到/)
  assert.throws(() => projectManagedSubtitleCueSetToOpenCut(
    tracks(audioElement({ hidden: true })),
    input(),
  ), /找不到/)
})

test('rejects source audio that cannot produce frame-aligned managed cues', () => {
  assert.throws(() => projectManagedSubtitleCueSetToOpenCut(
    tracks(audioElement({ startTime: 1 })),
    input(),
  ), /24fps/)
  assert.throws(() => projectManagedSubtitleCueSetToOpenCut(
    tracks(audioElement({ duration: SECOND, trimStart: SECOND, sourceDuration: SECOND })),
    input(),
  ), /超出源音频时长/)
})
