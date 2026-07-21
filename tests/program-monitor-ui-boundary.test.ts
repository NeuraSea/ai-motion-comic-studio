import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('timeline exposes a program monitor and keeps playhead-only transport explicit', async () => {
  const timeline = await readFile('src/features/editor/OpenCutTimeline.tsx', 'utf8')
  const monitor = await readFile('src/features/editor/OpenCutProgramMonitor.tsx', 'utf8')

  assert.match(timeline, /<OpenCutProgramMonitor/)
  assert.match(timeline, /aria-label=\{playbackState\.isPlaying && programPlaybackEnabled \? '暂停节目' : '播放节目'\}/)
  assert.match(timeline, /aria-label=\{playbackState\.isPlaying && !programPlaybackEnabled \? '暂停播放头' : '仅运行播放头'\}/)
  assert.match(timeline, /if \(element\) commandEditor\.playback\.seek\(element\.startTime\)/)

  assert.match(monitor, /画面 · 对白 · 原视频音效 · 字幕/)
  assert.match(monitor, /ProgramVideo/)
  assert.match(monitor, /ProgramAudio/)
  assert.match(monitor, /program-monitor-subtitles/)
  assert.match(monitor, /semanticAudioGainAtSeconds/)
  assert.match(monitor, /createLiveRenderSemanticSession/)
})
