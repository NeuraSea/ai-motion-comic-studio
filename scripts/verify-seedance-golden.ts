import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const SEEDANCE_GOLDEN_METRICS = [
  'characterConsistency',
  'actionAdherence',
  'cameraAdherence',
  'compositionStability',
  'editability',
  'audioCleanliness',
] as const

export type SeedanceGoldenMetric = typeof SEEDANCE_GOLDEN_METRICS[number]
export type SeedanceGoldenAxis =
  | 'prompt_strategy'
  | 'reference_strategy'
  | 'timecode_instruction'
  | 'resolution'
  | 'audio_policy'
  | 'generation_mode'

type JsonRecord = Record<string, unknown>

export interface SeedanceGoldenVariant {
  id: string
  blindLabel: 'A' | 'B'
  role: 'candidate' | 'baseline'
  jobId: string
  providerTaskId: string
  outputAssetId: string
  outputChecksum: string
  sourceRevisionId: string
  timingManifestFingerprint: string
  providerId: string
  providerConfigRevision: number
  model: string
  durationSeconds: number
  resolution: '480p' | '720p' | '1080p'
  audioPolicy: 'silent' | 'sfx_only' | 'provider_audio'
  generationMode: 'sequential' | 'continuous'
  promptCompilerVersion: string
  promptChecksum: string
  referenceStrategy: string
  referenceFingerprint: string
  includeTimecodes: boolean
  latencySeconds: number
  providerCost: { currency: string; amount: number } | null
  providerCostEvidence: string
  completedAt: string
  review: {
    reviewerId: string
    reviewedAt: string
    playbackComplete: true
    scores: Record<SeedanceGoldenMetric, number>
    notes: string
  }
}

export interface SeedanceGoldenManifest {
  version: 1
  name: string
  episodeId: string
  comparisonAxis: SeedanceGoldenAxis
  createdAt: string
  policy: {
    nonInferiorityMargin: number
    minimumCandidateScore: number
    maximumPerCaseRegression: number
  }
  cases: Array<{
    sceneId: string
    shotId: string
    variants: [SeedanceGoldenVariant, SeedanceGoldenVariant]
  }>
}

export interface SeedanceGoldenReport {
  version: 1
  manifestName: string
  episodeId: string
  comparisonAxis: SeedanceGoldenAxis
  caseCount: number
  passed: boolean
  verifiedAt: string
  metrics: Record<SeedanceGoldenMetric, {
    candidateAverage: number
    baselineAverage: number
    delta: number
    nonInferior: boolean
    minimumMet: boolean
  }>
  latency: {
    candidateAverageSeconds: number
    baselineAverageSeconds: number
  }
  providerCost: {
    candidateKnownTotal: number | null
    baselineKnownTotal: number | null
    currency: string | null
    complete: boolean
  }
  failures: string[]
}

const HASH = /^[a-f0-9]{64}$/
const AXES = new Set<SeedanceGoldenAxis>([
  'prompt_strategy',
  'reference_strategy',
  'timecode_instruction',
  'resolution',
  'audio_policy',
  'generation_mode',
])

function record(value: unknown, path: string, failures: string[]): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failures.push(`${path} 必须是对象`)
    return null
  }
  return value as JsonRecord
}

function exactKeys(value: JsonRecord, keys: readonly string[], path: string, failures: string[]): void {
  const expected = new Set(keys)
  const unknown = Object.keys(value).filter((key) => !expected.has(key))
  const missing = keys.filter((key) => !Object.hasOwn(value, key))
  if (unknown.length) failures.push(`${path} 包含未知字段：${unknown.join(', ')}`)
  if (missing.length) failures.push(`${path} 缺少字段：${missing.join(', ')}`)
}

function nonEmpty(value: unknown, path: string, failures: string[], maximum = 300): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\u0000')) {
    failures.push(`${path} 必须是 1–${maximum} 字符的非空文本`)
    return false
  }
  return true
}

function isoDate(value: unknown, path: string, failures: string[]): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    failures.push(`${path} 必须是 ISO 时间`)
    return false
  }
  return true
}

function finiteRange(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
  failures: string[],
  integer = false,
): value is number {
  if (typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
    || (integer && !Number.isInteger(value))) {
    failures.push(`${path} 必须是 ${minimum}–${maximum}${integer ? ' 的整数' : ''}`)
    return false
  }
  return true
}

function hash(value: unknown, path: string, failures: string[]): value is string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    failures.push(`${path} 必须是小写 SHA-256`)
    return false
  }
  return true
}

const VARIANT_KEYS = [
  'id', 'blindLabel', 'role', 'jobId', 'providerTaskId', 'outputAssetId', 'outputChecksum',
  'sourceRevisionId', 'timingManifestFingerprint', 'providerId', 'providerConfigRevision', 'model',
  'durationSeconds', 'resolution', 'audioPolicy', 'generationMode', 'promptCompilerVersion',
  'promptChecksum', 'referenceStrategy', 'referenceFingerprint', 'includeTimecodes', 'latencySeconds',
  'providerCost', 'providerCostEvidence', 'completedAt', 'review',
] as const

function parseVariant(value: unknown, path: string, failures: string[]): SeedanceGoldenVariant | null {
  const failureCount = failures.length
  const item = record(value, path, failures)
  if (!item) return null
  exactKeys(item, VARIANT_KEYS, path, failures)
  for (const field of [
    'id', 'jobId', 'providerTaskId', 'outputAssetId', 'sourceRevisionId', 'providerId', 'model',
    'promptCompilerVersion', 'referenceStrategy', 'providerCostEvidence',
  ] as const) nonEmpty(item[field], `${path}.${field}`, failures)
  hash(item.outputChecksum, `${path}.outputChecksum`, failures)
  hash(item.timingManifestFingerprint, `${path}.timingManifestFingerprint`, failures)
  hash(item.promptChecksum, `${path}.promptChecksum`, failures)
  hash(item.referenceFingerprint, `${path}.referenceFingerprint`, failures)
  if (item.blindLabel !== 'A' && item.blindLabel !== 'B') failures.push(`${path}.blindLabel 必须是 A 或 B`)
  if (item.role !== 'candidate' && item.role !== 'baseline') failures.push(`${path}.role 必须是 candidate 或 baseline`)
  finiteRange(item.providerConfigRevision, 1, Number.MAX_SAFE_INTEGER, `${path}.providerConfigRevision`, failures, true)
  finiteRange(item.durationSeconds, 4, 15, `${path}.durationSeconds`, failures, true)
  if (!['480p', '720p', '1080p'].includes(String(item.resolution))) failures.push(`${path}.resolution 无效`)
  if (!['silent', 'sfx_only', 'provider_audio'].includes(String(item.audioPolicy))) failures.push(`${path}.audioPolicy 无效`)
  if (!['sequential', 'continuous'].includes(String(item.generationMode))) failures.push(`${path}.generationMode 无效`)
  if (typeof item.includeTimecodes !== 'boolean') failures.push(`${path}.includeTimecodes 必须是布尔值`)
  finiteRange(item.latencySeconds, 0.001, 86_400, `${path}.latencySeconds`, failures)
  isoDate(item.completedAt, `${path}.completedAt`, failures)

  const providerCost = item.providerCost === null ? null : record(item.providerCost, `${path}.providerCost`, failures)
  if (providerCost) {
    exactKeys(providerCost, ['currency', 'amount'], `${path}.providerCost`, failures)
    nonEmpty(providerCost.currency, `${path}.providerCost.currency`, failures, 12)
    finiteRange(providerCost.amount, 0, 1_000_000_000, `${path}.providerCost.amount`, failures)
  } else if (item.providerCost !== null) {
    failures.push(`${path}.providerCost 必须是对象或 null`)
  }
  if (item.providerCost === null && item.providerCostEvidence !== 'unavailable') {
    failures.push(`${path}.providerCost 为 null 时证据必须明确为 unavailable`)
  }

  const review = record(item.review, `${path}.review`, failures)
  if (review) {
    exactKeys(review, ['reviewerId', 'reviewedAt', 'playbackComplete', 'scores', 'notes'], `${path}.review`, failures)
    nonEmpty(review.reviewerId, `${path}.review.reviewerId`, failures, 120)
    isoDate(review.reviewedAt, `${path}.review.reviewedAt`, failures)
    if (review.playbackComplete !== true) failures.push(`${path}.review.playbackComplete 必须明确为 true`)
    if (typeof review.notes !== 'string' || review.notes.length > 2_000) failures.push(`${path}.review.notes 必须是不超过 2000 字的文本`)
    const scores = record(review.scores, `${path}.review.scores`, failures)
    if (scores) {
      exactKeys(scores, SEEDANCE_GOLDEN_METRICS, `${path}.review.scores`, failures)
      for (const metric of SEEDANCE_GOLDEN_METRICS) {
        finiteRange(scores[metric], 1, 5, `${path}.review.scores.${metric}`, failures, true)
      }
    }
  }
  // Never let a malformed review or score enter aggregate calculations. Keep
  // every collected diagnostic, but omit the unsafe variant from the report.
  return failures.length === failureCount
    ? item as unknown as SeedanceGoldenVariant
    : null
}

const CONTROLLED_FIELDS = [
  'sourceRevisionId', 'timingManifestFingerprint', 'providerId', 'providerConfigRevision', 'model',
  'durationSeconds', 'resolution', 'audioPolicy', 'generationMode', 'promptCompilerVersion',
  'promptChecksum', 'referenceStrategy', 'referenceFingerprint', 'includeTimecodes',
] as const satisfies readonly (keyof SeedanceGoldenVariant)[]

const AXIS_ALLOWED_DIFFERENCES: Record<SeedanceGoldenAxis, ReadonlySet<keyof SeedanceGoldenVariant>> = {
  prompt_strategy: new Set(['promptCompilerVersion', 'promptChecksum']),
  reference_strategy: new Set(['referenceStrategy', 'referenceFingerprint']),
  timecode_instruction: new Set(['includeTimecodes', 'promptChecksum']),
  resolution: new Set(['resolution']),
  audio_policy: new Set(['audioPolicy', 'promptChecksum']),
  generation_mode: new Set(['generationMode']),
}

function comparePair(
  axis: SeedanceGoldenAxis,
  shotPath: string,
  candidate: SeedanceGoldenVariant,
  baseline: SeedanceGoldenVariant,
  failures: string[],
): void {
  const allowed = AXIS_ALLOWED_DIFFERENCES[axis]
  for (const field of CONTROLLED_FIELDS) {
    if (allowed.has(field)) continue
    if (candidate[field] !== baseline[field]) failures.push(`${shotPath} 除 ${axis} 外的控制变量 ${field} 不一致`)
  }
  if (![...allowed].some((field) => candidate[field] !== baseline[field])) {
    failures.push(`${shotPath} 的 ${axis} 实际没有形成 A/B 差异`)
  }
  if (axis === 'prompt_strategy') {
    if (candidate.promptCompilerVersion !== 'seedance-compact-v1') {
      failures.push(`${shotPath} candidate 必须使用 seedance-compact-v1`)
    }
    if (baseline.promptCompilerVersion !== 'seedance-verbose-baseline-v1') {
      failures.push(`${shotPath} baseline 必须使用 seedance-verbose-baseline-v1`)
    }
    if (candidate.promptChecksum === baseline.promptChecksum) {
      failures.push(`${shotPath} 的实际 Prompt checksum 未形成差异`)
    }
  }
}

export function verifySeedanceGoldenManifest(
  value: unknown,
  now = new Date().toISOString(),
): SeedanceGoldenReport {
  const failures: string[] = []
  const root = record(value, 'manifest', failures)
  if (!root) throw new Error(failures.join('；'))
  exactKeys(root, ['version', 'name', 'episodeId', 'comparisonAxis', 'createdAt', 'policy', 'cases'], 'manifest', failures)
  if (root.version !== 1) failures.push('manifest.version 必须为 1')
  nonEmpty(root.name, 'manifest.name', failures)
  nonEmpty(root.episodeId, 'manifest.episodeId', failures)
  isoDate(root.createdAt, 'manifest.createdAt', failures)
  const axis = AXES.has(root.comparisonAxis as SeedanceGoldenAxis)
    ? root.comparisonAxis as SeedanceGoldenAxis
    : null
  if (!axis) failures.push('manifest.comparisonAxis 无效')

  const policy = record(root.policy, 'manifest.policy', failures)
  if (policy) {
    exactKeys(policy, ['nonInferiorityMargin', 'minimumCandidateScore', 'maximumPerCaseRegression'], 'manifest.policy', failures)
    finiteRange(policy.nonInferiorityMargin, 0, 1, 'manifest.policy.nonInferiorityMargin', failures)
    finiteRange(policy.minimumCandidateScore, 1, 5, 'manifest.policy.minimumCandidateScore', failures)
    finiteRange(policy.maximumPerCaseRegression, 0, 4, 'manifest.policy.maximumPerCaseRegression', failures)
  }

  const cases = Array.isArray(root.cases) ? root.cases : []
  if (!Array.isArray(root.cases)) failures.push('manifest.cases 必须是数组')
  if (cases.length < 6 || cases.length > 12) failures.push('manifest.cases 必须包含 6–12 个镜头')
  const parsedCases: SeedanceGoldenManifest['cases'] = []
  const caseKeys = new Set<string>()
  const globalIds = new Map<string, string>()
  for (const [index, rawCase] of cases.entries()) {
    const path = `manifest.cases[${index}]`
    const item = record(rawCase, path, failures)
    if (!item) continue
    exactKeys(item, ['sceneId', 'shotId', 'variants'], path, failures)
    nonEmpty(item.sceneId, `${path}.sceneId`, failures)
    nonEmpty(item.shotId, `${path}.shotId`, failures)
    const caseKey = `${String(item.sceneId)}\u0000${String(item.shotId)}`
    if (caseKeys.has(caseKey)) failures.push(`${path} 重复镜头`)
    caseKeys.add(caseKey)
    if (!Array.isArray(item.variants) || item.variants.length !== 2) {
      failures.push(`${path}.variants 必须恰好包含 A/B 两个结果`)
      continue
    }
    const variants = item.variants.map((variant, variantIndex) => (
      parseVariant(variant, `${path}.variants[${variantIndex}]`, failures)
    )).filter((variant): variant is SeedanceGoldenVariant => Boolean(variant))
    if (variants.length !== 2) continue
    if (new Set(variants.map((variant) => variant.blindLabel)).size !== 2) failures.push(`${path} 必须同时包含盲审标签 A 与 B`)
    const candidate = variants.find((variant) => variant.role === 'candidate')
    const baseline = variants.find((variant) => variant.role === 'baseline')
    if (!candidate || !baseline) failures.push(`${path} 必须同时包含 candidate 与 baseline`)
    if (candidate && baseline && axis) comparePair(axis, path, candidate, baseline, failures)
    for (const variant of variants) {
      for (const field of ['id', 'jobId', 'providerTaskId', 'outputAssetId', 'outputChecksum'] as const) {
        const value = variant[field]
        const globalKey = `${field}:${value}`
        const previous = globalIds.get(globalKey)
        if (previous) failures.push(`${path} 重用了 ${field}（已用于 ${previous}）`)
        else globalIds.set(globalKey, path)
      }
    }
    parsedCases.push({
      sceneId: String(item.sceneId),
      shotId: String(item.shotId),
      variants: variants as [SeedanceGoldenVariant, SeedanceGoldenVariant],
    })
  }

  const safePolicy = {
    nonInferiorityMargin: typeof policy?.nonInferiorityMargin === 'number' ? policy.nonInferiorityMargin : 0,
    minimumCandidateScore: typeof policy?.minimumCandidateScore === 'number' ? policy.minimumCandidateScore : 5,
    maximumPerCaseRegression: typeof policy?.maximumPerCaseRegression === 'number' ? policy.maximumPerCaseRegression : 0,
  }
  const metrics = Object.fromEntries(SEEDANCE_GOLDEN_METRICS.map((metric) => {
    const candidateScores = parsedCases.map(({ variants }) => variants.find((variant) => variant.role === 'candidate')!.review.scores[metric])
    const baselineScores = parsedCases.map(({ variants }) => variants.find((variant) => variant.role === 'baseline')!.review.scores[metric])
    const candidateAverage = candidateScores.length ? candidateScores.reduce((a, b) => a + b, 0) / candidateScores.length : 0
    const baselineAverage = baselineScores.length ? baselineScores.reduce((a, b) => a + b, 0) / baselineScores.length : 0
    const nonInferior = candidateAverage + safePolicy.nonInferiorityMargin >= baselineAverage
    const minimumMet = candidateAverage >= safePolicy.minimumCandidateScore
    if (!nonInferior) failures.push(`${metric} candidate 平均分低于 baseline 且超出非劣性边界`)
    if (!minimumMet) failures.push(`${metric} candidate 平均分低于最低门槛`)
    parsedCases.forEach(({ sceneId, shotId }, index) => {
      if ((baselineScores[index] ?? 0) - (candidateScores[index] ?? 0) > safePolicy.maximumPerCaseRegression) {
        failures.push(`${sceneId}/${shotId} 的 ${metric} 单镜退化超过允许值`)
      }
    })
    return [metric, {
      candidateAverage: Number(candidateAverage.toFixed(3)),
      baselineAverage: Number(baselineAverage.toFixed(3)),
      delta: Number((candidateAverage - baselineAverage).toFixed(3)),
      nonInferior,
      minimumMet,
    }]
  })) as SeedanceGoldenReport['metrics']

  const candidates = parsedCases.map(({ variants }) => variants.find((variant) => variant.role === 'candidate')!)
  const baselines = parsedCases.map(({ variants }) => variants.find((variant) => variant.role === 'baseline')!)
  const averageLatency = (variants: SeedanceGoldenVariant[]) => variants.length
    ? variants.reduce((total, variant) => total + variant.latencySeconds, 0) / variants.length
    : 0
  const allCosts = [...candidates, ...baselines].map((variant) => variant.providerCost)
  const currencies = new Set(allCosts.flatMap((cost) => cost ? [cost.currency] : []))
  const completeCost = allCosts.length > 0 && allCosts.every(Boolean) && currencies.size === 1
  if (currencies.size > 1) failures.push('Provider 成本货币不一致，不能汇总')

  return {
    version: 1,
    manifestName: typeof root.name === 'string' ? root.name : '',
    episodeId: typeof root.episodeId === 'string' ? root.episodeId : '',
    comparisonAxis: axis ?? 'prompt_strategy',
    caseCount: parsedCases.length,
    passed: failures.length === 0,
    verifiedAt: now,
    metrics,
    latency: {
      candidateAverageSeconds: Number(averageLatency(candidates).toFixed(3)),
      baselineAverageSeconds: Number(averageLatency(baselines).toFixed(3)),
    },
    providerCost: {
      candidateKnownTotal: completeCost ? Number(candidates.reduce((total, variant) => total + variant.providerCost!.amount, 0).toFixed(6)) : null,
      baselineKnownTotal: completeCost ? Number(baselines.reduce((total, variant) => total + variant.providerCost!.amount, 0).toFixed(6)) : null,
      currency: completeCost ? candidates[0]?.providerCost?.currency ?? null : null,
      complete: completeCost,
    },
    failures: [...new Set(failures)],
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      manifest: { type: 'string', short: 'm' },
      report: { type: 'string', short: 'r' },
    },
    strict: true,
  })
  if (!values.manifest) throw new Error('必须提供 --manifest <path>')
  const parsed = JSON.parse(await readFile(values.manifest, 'utf8')) as unknown
  const report = verifySeedanceGoldenManifest(parsed)
  const encoded = `${JSON.stringify(report, null, 2)}\n`
  if (values.report) await writeFile(values.report, encoded, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(encoded)
  if (!report.passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Seedance golden 校验失败'}\n`)
    process.exitCode = 1
  })
}
