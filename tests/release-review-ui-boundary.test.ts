import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)

test('technical QC exposes only a review copy until an immutable human approval is current', async () => {
  const source = await readFile(appPath, 'utf8')
  const start = source.indexOf('function ExportStage(')
  const end = source.indexOf('function isStoryRevisionSnapshot', start)
  assert.ok(start > 0 && end > start)
  const stage = source.slice(start, end)

  assert.match(stage, /const reviewUrl = qualityPassed[\s\S]*reviewDownloadUrl/)
  assert.match(stage, /const downloadUrl = qualityPassed && releaseApproved[\s\S]*downloadUrl/)
  assert.match(stage, /const releaseApproved = currentReleaseReview\?\.decision === 'approve'[\s\S]*invalidReasons\.length === 0/)
  assert.match(stage, /人工发行复验/)
  assert.match(stage, /下载审片版/)
  assert.match(stage, /下载发布版/)
  assert.doesNotMatch(stage, /真实质检已通过，可播放并下载发布版/)
})

test('human approval requires full playback acknowledgement and all three semantic checks', async () => {
  const source = await readFile(appPath, 'utf8')
  const start = source.indexOf('function ExportStage(')
  const end = source.indexOf('function isStoryRevisionSnapshot', start)
  const stage = source.slice(start, end)

  for (const field of [
    'audioVideoSync',
    'subtitleSyncAndComplete',
    'characterVisualSemantics',
  ]) {
    assert.match(stage, new RegExp(`releaseReviewChecklist\\.${field}`))
  }
  assert.match(stage, /!releaseReviewAcknowledged \|\| !allReleaseChecksPassed/)
  assert.match(stage, /submitReleaseReview\('approve'\)/)
  assert.match(stage, /submitReleaseReview\('reject'\)/)
  assert.match(stage, /驳回时请填写可执行的修改说明/)
  assert.match(stage, /我已在网页或系统播放器中完整审看当前成片/)
})
