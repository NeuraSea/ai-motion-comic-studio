import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const dialogPath = new URL('../src/features/video/ShotVideoBatchDialog.tsx', import.meta.url)
const stylesPath = new URL('../src/features/video/ShotVideoBatchDialog.css', import.meta.url)

test('every shot exposes an explicit visual action outside paid selection', async () => {
  const source = await readFile(dialogPath, 'utf8')
  const handlerStart = source.indexOf('const runVisualReferenceAnalysis = async (')
  const handlerEnd = source.indexOf('\n  const useFastReferenceRecommendation', handlerStart)
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart)
  assert.doesNotMatch(
    source.slice(0, handlerStart),
    /api\.createShotVideoVisualReferenceAnalysis/,
    'opening, hydration, and effects must not create a visual model Job',
  )
  assert.match(source.slice(handlerStart, handlerEnd), /api\.createShotVideoVisualReferenceAnalysis\(/)
  assert.equal(source.match(/api\.createShotVideoVisualReferenceAnalysis\(/g)?.length, 1)

  const cardStart = source.indexOf('className="shot-video-batch-shot-header"')
  const selectedOnlyStart = source.indexOf('{selected && (', cardStart)
  const header = source.slice(cardStart, selectedOnlyStart)
  assert.match(header, /<\/label>\s*<button/)
  assert.match(header, /aria-label=\{`分析 \$\{shot\.code\} 视觉参考`\}/)
  assert.match(header, /onClick=\{\(\) => void runVisualReferenceAnalysis\(\[shot\]\)\}/)
  assert.match(source, /aria-label=\{`\$\{shot\.code\} 视觉分析状态`\}/)
})

test('per-shot bindings survive other-shot work and poll with job-id CAS', async () => {
  const source = await readFile(dialogPath, 'utf8')
  assert.match(source, /visualAnalysisJobsById/)
  assert.match(source, /visualAnalysisBindingByShotKey/)
  assert.match(source, /shotVideoVisualAnalysisShotKey\(shot\)/)
  assert.match(source, /api\.getShotVideoVisualReferenceAnalysisJob\(jobId\)/)
  assert.match(source, /current\[jobId\]\?\.id === jobId/)
  assert.match(source, /binding\.jobId !== jobId/)
  assert.match(source, /referenceAnalysisJobId: visualResult\.jobId/)
  assert.match(source, /delete updated\[shotKey\]/)
  assert.match(source, /不会自动重提/)
  assert.match(source, /项目规则：LLM \/ Agentic 免费/)
  assert.match(source, /Seedance 仍须另行确认付费/)
})

test('batch ambiguity action remains explicit and per-card evidence is scroll-safe', async () => {
  const [source, styles] = await Promise.all([
    readFile(dialogPath, 'utf8'),
    readFile(stylesPath, 'utf8'),
  ])
  assert.match(source, /批量分析 \$\{batchVisualAnalysisSummary\.retryable\.length\} 个歧义镜头/)
  assert.match(source, /runVisualReferenceAnalysis\(batchVisualAnalysisSummary\.retryable\)/)
  assert.match(source, /shotVideoVisualAnalysisTargets\(\s*selectedShots/)
  assert.doesNotMatch(source, /selections:\s*selectedShots\.map\(\(shot\) =>/)
  assert.match(source, /visualResult\.plan\.visualEvidence\.map/)
  assert.match(styles, /\.shot-video-batch-scope\s*\{[^}]*overflow:\s*auto/s)
  assert.match(styles, /\.shot-video-batch-confirmation-scroll\s*\{[^}]*overflow-y:\s*auto/s)
  assert.match(styles, /\.shot-video-card-analysis > p\s*\{[^}]*overflow-wrap/s)
  assert.match(styles, /\.shot-video-selected-references span\s*\{[^}]*-webkit-line-clamp:\s*2/s)
})
