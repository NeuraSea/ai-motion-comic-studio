import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const panelPath = new URL('../src/features/video/ShotMediaReviewPanel.tsx', import.meta.url)
const stylesPath = new URL('../src/features/video/ShotMediaReviewPanel.css', import.meta.url)
const timelinePath = new URL('../src/features/editor/OpenCutTimeline.tsx', import.meta.url)
const handoffPath = new URL('../src/features/editor/timeline-revision-handoff.ts', import.meta.url)

function slice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing boundary: ${start}`)
  assert.ok(endIndex > startIndex, `missing boundary: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('shot media review renders both real media types, immutable history and ineligible provenance', async () => {
  const [source, styles] = await Promise.all([
    readFile(panelPath, 'utf8'),
    readFile(stylesPath, 'utf8'),
  ])
  assert.match(source, /storyboard: '分镜图'/)
  assert.match(source, /video: '逐镜视频'/)
  assert.match(source, /<MediaPreview candidate=\{focused\}/)
  assert.match(source, /<video src=\{candidate\.url\} preload="metadata" muted playsInline/)
  assert.match(source, /focused\.eligibilityError/)
  assert.match(source, /该历史素材仅供查看，不能采用/)
  assert.match(source, /旧逐镜视频已解除当前选中，历史 Asset 仍完整保留/)
  assert.match(source, /不可变历史/)
  assert.match(styles, /\.shot-media-candidate-list\s*\{[^}]*overflow-y:\s*auto/s)
  assert.match(styles, /\.shot-media-history ol\s*\{[^}]*overflow-y:\s*auto/s)
})

test('review decisions are explicit local authority writes and never submit a Provider job', async () => {
  const source = await readFile(appPath, 'utf8')
  const action = slice(
    source,
    'const decideSelectedShotMedia = async (',
    '\n\n  useEffect(() => {',
  )
  const flushIndex = action.indexOf('await currentHandle.flush()')
  const decideIndex = action.indexOf('api.decideShotMediaReview(')
  const reconcileIndex = action.indexOf('reconcileReviewedShotMedia(currentHandle')
  assert.ok(flushIndex >= 0 && decideIndex > flushIndex)
  assert.ok(reconcileIndex > decideIndex)
  assert.match(action, /decision !== 'reject'/)
  assert.doesNotMatch(action, /createShotVideo|createAssetImage|generateStory|preflightShotVideo/)
  assert.doesNotMatch(action, /x-manju-aigc-confirmation|confirmationToken/)
  assert.match(action, /frozen\.idempotencyKey/)
  assert.doesNotMatch(action, /existingHistoryIds|matching|reconciledCommit/)
  assert.match(action, /const submitExactDecision = \(\) => api\.decideShotMediaReview/)
  assert.equal(action.match(/await submitExactDecision\(\)/g)?.length, 2)
  assert.match(action, /Exactly one automatic replay is allowed/)
  assert.match(action, /已保留原 If-Match 与 Idempotency-Key/)
  assert.match(action, /系统不会再自动重提/)
})

test('mounted OpenCut reconciles into command state and blocks export when that replacement fails', async () => {
  const [app, timeline, handoff] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(timelinePath, 'utf8'),
    readFile(handoffPath, 'utf8'),
  ])
  assert.match(handoff, /reconcileCurrentMedia\(signal\?: AbortSignal\): Promise<TimelineDocumentSnapshot>/)
  assert.match(timeline, /reconcileCurrentMedia: async \(signal\) => \{/)
  assert.match(timeline, /const snapshot = await storage\.reconcile\(signal\)/)
  assert.match(timeline, /replaceEditorWithAuthoritativeSnapshot\(/)
  const open = slice(app, "const openWithPinnedTimeline = async (consumer: 'preview' | 'export') =>", '\n\n  const requestShotGeneration')
  assert.match(open, /shotMediaTimelineState === 'required'/)
  assert.match(open, /shotMediaTimelineState === 'reconciling'/)
  assert.match(open, /shotMediaTimelineState === 'error'/)
  assert.match(open, /预览和导出已阻断/)
  const flushIndex = open.indexOf('await handle.flush()')
  const reconcileIndex = open.indexOf('snapshot = await handle.reconcileCurrentMedia()')
  assert.ok(flushIndex >= 0 && reconcileIndex > flushIndex)
})
