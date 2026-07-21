import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)

function slice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing boundary: ${start}`)
  assert.ok(endIndex > startIndex, `missing boundary: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('asset workbench receives episode-wide visual history instead of current-only Jobs', async () => {
  const app = await readFile(appPath, 'utf8')
  const historyJobs = slice(
    app,
    'const visualAssetHistoryJobs = useMemo(',
    '\n  const visualAssetSuccessKey',
  )

  assert.match(historyJobs, /episodeJobs\.filter/)
  assert.match(historyJobs, /visualAssetJobBinding\(job\) !== null/)
  assert.doesNotMatch(historyJobs, /expectedRevisionId\s*===/)
  assert.match(app, /jobs=\{visualAssetHistoryJobs\}/)
})

test('revision drift changes candidate actions without erasing persisted thumbnails', async () => {
  const app = await readFile(appPath, 'utf8')
  const candidates = slice(
    app,
    'const selectedCandidates = selectedCandidateJobs.flatMap',
    '\n  const selectedCurrentCandidates',
  )

  // The persisted Asset and Job still have to agree on ownership/provenance,
  // but source revision equality is a state flag rather than a visibility gate.
  assert.match(candidates, /asset\.generationJobId !== job\.id/)
  assert.match(candidates, /asset\.projectId !== job\.projectId/)
  assert.match(candidates, /asset\.episodeId !== job\.episodeId/)
  assert.doesNotMatch(candidates, /asset\.sourceRevisionId !== sourceRevisionId/)
  assert.match(candidates, /isCurrentRevision: asset\.sourceRevisionId === sourceRevisionId/)
  assert.match(candidates, /visualAssetJobBinding\(job\)\?\.expectedRevisionId === sourceRevisionId/)
})

test('historical candidates remain immutable and expose a separate zero-provider adoption action', async () => {
  const app = await readFile(appPath, 'utf8')
  const historyUi = slice(
    app,
    '{selectedHistoricalCandidates.length > 0 && (',
    '\n              <div className="visual-candidate-grid">',
  )
  const candidateCard = slice(
    app,
    '{selectedCandidates.map(({ image, asset, job, isCurrentRevision }) => {',
    '\n                {failedJobs.map',
  )

  assert.match(historyUi, /个历史版本仍在项目资产库/)
  assert.match(historyUi, /它们没有丢失/)
  assert.match(historyUi, /旧版本保持不可变/)
  assert.match(historyUi, /零费用继承/)
  assert.match(historyUi, /不调用 Provider/)
  assert.match(candidateCard, /本集引用 · 旧源修订/)
  assert.match(candidateCard, /历史版本/)
  assert.match(candidateCard, /历史修订 \$\{asset\.sourceRevisionId\?\.slice\(0, 8\)/)
  assert.match(candidateCard, /disabled=\{!isCurrentRevision \|\| Boolean\(actionKey\)/)
  assert.match(candidateCard, /\|\| !isCurrentRevision/)
  assert.match(candidateCard, /disabled=\{!isCurrentRevision \|\| locked/)
  assert.match(candidateCard, /等待语义核验继承/)
  assert.match(candidateCard, /className="history-adopt"/)
  assert.match(candidateCard, /onAdoptHistorical\(selectedTarget, asset\)/)
  assert.match(candidateCard, /服务端先核验实体语义、风格、画幅与校验和/)
  assert.doesNotMatch(candidateCard, /preflight|confirmation|onGenerate\(selectedTarget\)/)
})

test('historical adoption pins a fresh compatibility listing, ETag, and stable idempotency intent', async () => {
  const app = await readFile(appPath, 'utf8')
  const adoption = slice(
    app,
    '  const adoptHistoricalVisualAsset = async (',
    '\n  const trackImageJobs',
  )

  assert.match(adoption, /api\.listHistoricalVisualAssetCandidates/)
  assert.match(adoption, /item\.assetVersionId === source\.id/)
  assert.match(adoption, /candidate\.semanticFingerprint/)
  assert.match(adoption, /imageIdempotencyRef\.current\.get\(signature\)/)
  assert.match(adoption, /api\.adoptHistoricalVisualAsset/)
  assert.match(adoption, /history\.etag, \{ idempotencyKey \}/)
  assert.match(adoption, /未调用图片 Provider/)
  assert.doesNotMatch(adoption, /preflightAssetImage|openAssetImageConfirmation|generateVisualAsset/)
})

test('Episode references remain confirmed across script revisions when the immutable Asset is ready', async () => {
  const app = await readFile(appPath, 'utf8')
  const outerCount = slice(
    app,
    'const lockedVisualAssetCount = visualAssetTargets.filter',
    '\n  const visualAssetStageStatus',
  )
  const stageCount = slice(
    app,
    'const lockedCount = targets.filter',
    '\n  const imageEditCapability',
  )

  for (const boundary of [outerCount, stageCount]) {
    assert.match(boundary, /asset\?\.status === 'ready'/)
    assert.doesNotMatch(boundary, /asset\.sourceRevisionId ===/)
  }
  assert.match(app, /currentLockedAsset = lockedAsset\?\.status === 'ready' \? lockedAsset : undefined/)
  assert.match(app, /本集已引用 · 源自旧剧本修订/)
  assert.match(app, /historicalOnly[\s\S]*'历史候选'/)
})
