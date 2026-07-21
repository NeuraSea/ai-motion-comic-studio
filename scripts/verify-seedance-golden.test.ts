import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SEEDANCE_GOLDEN_METRICS,
  verifySeedanceGoldenManifest,
  type SeedanceGoldenManifest,
  type SeedanceGoldenVariant,
} from './verify-seedance-golden.js'

function hash(seed: number): string {
  return seed.toString(16).padStart(64, '0')
}

function variant(index: number, role: 'candidate' | 'baseline'): SeedanceGoldenVariant {
  const candidate = role === 'candidate'
  return {
    id: `${role}-${index}`,
    blindLabel: candidate ? 'B' : 'A',
    role,
    jobId: `job-${role}-${index}`,
    providerTaskId: `task-${role}-${index}`,
    outputAssetId: `asset-${role}-${index}`,
    outputChecksum: hash(index * 10 + (candidate ? 1 : 2)),
    sourceRevisionId: 'revision-current',
    timingManifestFingerprint: hash(900 + index),
    providerId: 'seedance-video',
    providerConfigRevision: 3,
    model: 'doubao-seedance-2-0-260128',
    durationSeconds: 8,
    resolution: '720p',
    audioPolicy: 'sfx_only',
    generationMode: 'sequential',
    promptCompilerVersion: candidate ? 'seedance-compact-v1' : 'seedance-verbose-baseline-v1',
    promptChecksum: hash(index * 10 + (candidate ? 3 : 4)),
    referenceStrategy: 'storyboard-plus-character',
    referenceFingerprint: hash(1_000 + index),
    includeTimecodes: false,
    latencySeconds: candidate ? 42 : 45,
    providerCost: null,
    providerCostEvidence: 'unavailable',
    completedAt: '2026-07-15T10:00:00.000Z',
    review: {
      reviewerId: 'reviewer-1',
      reviewedAt: '2026-07-15T11:00:00.000Z',
      playbackComplete: true,
      scores: Object.fromEntries(SEEDANCE_GOLDEN_METRICS.map((metric) => [metric, candidate ? 4 : 3])) as SeedanceGoldenVariant['review']['scores'],
      notes: '',
    },
  }
}

function manifest(count = 6): SeedanceGoldenManifest {
  return {
    version: 1,
    name: 'Seedance compact prompt golden',
    episodeId: 'episode-1',
    comparisonAxis: 'prompt_strategy',
    createdAt: '2026-07-15T09:00:00.000Z',
    policy: {
      nonInferiorityMargin: 0,
      minimumCandidateScore: 3,
      maximumPerCaseRegression: 1,
    },
    cases: Array.from({ length: count }, (_, index) => ({
      sceneId: 'scene-1',
      shotId: `shot-${index + 1}`,
      variants: [variant(index + 1, 'baseline'), variant(index + 1, 'candidate')],
    })),
  }
}

test('a strict six-shot blind A/B manifest produces a reproducible non-inferiority report', () => {
  const report = verifySeedanceGoldenManifest(manifest(), '2026-07-15T12:00:00.000Z')
  assert.equal(report.passed, true)
  assert.equal(report.caseCount, 6)
  assert.equal(report.metrics.characterConsistency.delta, 1)
  assert.deepEqual(report.latency, { candidateAverageSeconds: 42, baselineAverageSeconds: 45 })
  assert.deepEqual(report.providerCost, {
    candidateKnownTotal: null,
    baselineKnownTotal: null,
    currency: null,
    complete: false,
  })
})

test('old, incomplete, reused, or non-blind evidence cannot masquerade as a golden', () => {
  const input = manifest(5) as unknown as Record<string, unknown>
  const cases = input.cases as SeedanceGoldenManifest['cases']
  cases[1]!.variants[0].jobId = cases[0]!.variants[0].jobId
  cases[2]!.variants[0].blindLabel = 'B'
  cases[3]!.variants[0].review.playbackComplete = false as true
  const report = verifySeedanceGoldenManifest(input)
  assert.equal(report.passed, false)
  assert.ok(report.failures.some((failure) => failure.includes('6–12')))
  assert.ok(report.failures.some((failure) => failure.includes('重用了 jobId')))
  assert.ok(report.failures.some((failure) => failure.includes('盲审标签')))
  assert.ok(report.failures.some((failure) => failure.includes('playbackComplete')))
})

test('malformed nested review data is reported without crashing aggregate evaluation', () => {
  const input = manifest() as unknown as { cases: Array<{ variants: Array<Record<string, unknown>> }> }
  input.cases[0]!.variants[0]!.review = { playbackComplete: true, scores: null }
  const report = verifySeedanceGoldenManifest(input)
  assert.equal(report.passed, false)
  assert.equal(report.caseCount, 5)
  assert.ok(report.failures.some((failure) => failure.includes('review')))
})

test('comparison variables other than the declared axis are fail-closed', () => {
  const input = manifest()
  input.cases[0]!.variants[1].resolution = '1080p'
  input.cases[1]!.variants[1].timingManifestFingerprint = hash(7_777)
  const report = verifySeedanceGoldenManifest(input)
  assert.equal(report.passed, false)
  assert.ok(report.failures.some((failure) => failure.includes('控制变量 resolution 不一致')))
  assert.ok(report.failures.some((failure) => failure.includes('控制变量 timingManifestFingerprint 不一致')))
})

test('prompt strategy evidence accepts only the reviewed compact and verbose compilers', () => {
  const wrongBaseline = manifest()
  wrongBaseline.cases[0]!.variants.find((entry) => entry.role === 'baseline')!.promptCompilerVersion = 'manual-long-prompt-v1'
  const wrongBaselineReport = verifySeedanceGoldenManifest(wrongBaseline)
  assert.equal(wrongBaselineReport.passed, false)
  assert.ok(wrongBaselineReport.failures.some((failure) => failure.includes('baseline 必须使用 seedance-verbose-baseline-v1')))

  const samePrompt = manifest()
  const pair = samePrompt.cases[0]!.variants
  pair.find((entry) => entry.role === 'baseline')!.promptChecksum = pair.find((entry) => entry.role === 'candidate')!.promptChecksum
  const samePromptReport = verifySeedanceGoldenManifest(samePrompt)
  assert.equal(samePromptReport.passed, false)
  assert.ok(samePromptReport.failures.some((failure) => failure.includes('实际 Prompt checksum 未形成差异')))
})

test('average and per-shot regressions both block candidate acceptance', () => {
  const input = manifest()
  for (const item of input.cases) {
    const candidate = item.variants.find((entry) => entry.role === 'candidate')!
    const baseline = item.variants.find((entry) => entry.role === 'baseline')!
    candidate.review.scores.actionAdherence = 2
    baseline.review.scores.actionAdherence = 5
  }
  const report = verifySeedanceGoldenManifest(input)
  assert.equal(report.passed, false)
  assert.equal(report.metrics.actionAdherence.nonInferior, false)
  assert.equal(report.metrics.actionAdherence.minimumMet, false)
  assert.ok(report.failures.some((failure) => failure.includes('单镜退化')))
})
