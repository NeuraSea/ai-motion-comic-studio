import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('top bar exposes the real hierarchical project and episode switcher', async () => {
  const app = await readFile('src/App.tsx', 'utf8')
  const switcher = await readFile('src/features/catalog/ProjectEpisodeSwitcher.tsx', 'utf8')

  assert.match(app, /<ProjectEpisodeSwitcher/)
  assert.match(app, /onSwitchEpisode=\{openCatalogEpisodeInProduction\}/)
  assert.match(app, /await timelineHandle\.flush\(\)/)
  assert.match(app, /preferredStoryShotRef\.current = rememberedWorkspace\?\.storyShotId/)
  assert.match(app, /setCurrentStage\(rememberedWorkspace\?\.stage \?\? 'source'\)/)
  assert.match(switcher, /最近打开/)
  assert.match(switcher, /全部项目/)
  assert.match(switcher, /切换会恢复该集上次的制作阶段、镜头和 OpenCut 播放头/)
  assert.match(switcher, /aria-haspopup="dialog"/)
})

test('unsafe project switches remain blocked by drafts and version conflicts', async () => {
  const app = await readFile('src/App.tsx', 'utf8')

  assert.match(app, /const productionSwitchBlockedReason = hasStoryDraft/)
  assert.match(app, /episodeInputDraftDirtyRef\.current \|\| saveState === 'dirty'/)
  assert.match(app, /saveState === 'conflict'/)
  assert.match(app, /if \(productionSwitchBlockedReason\)/)
})
