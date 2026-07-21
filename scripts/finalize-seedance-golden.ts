import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import {
  SEEDANCE_GOLDEN_METRICS,
  verifySeedanceGoldenManifest,
  type SeedanceGoldenManifest,
  type SeedanceGoldenMetric,
} from './verify-seedance-golden.js'
import type {
  SeedanceGoldenBlindReviewSheet,
  SeedanceGoldenManifestDraft,
} from './prepare-seedance-golden.js'

type JsonRecord = Record<string, unknown>

export class SeedanceGoldenFinalizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedanceGoldenFinalizationError'
  }
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SeedanceGoldenFinalizationError(`${path} 必须是对象`)
  }
  return value as JsonRecord
}

function exactKeys(value: JsonRecord, expected: readonly string[], path: string): void {
  const allowed = new Set(expected)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  const missing = expected.filter((key) => !Object.hasOwn(value, key))
  if (unknown.length || missing.length) {
    throw new SeedanceGoldenFinalizationError(`${path} 字段不匹配${unknown.length ? `，未知：${unknown.join(', ')}` : ''}${missing.length ? `，缺少：${missing.join(', ')}` : ''}`)
  }
}

function nonEmpty(value: unknown, path: string, maximum = 2_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\u0000')) {
    throw new SeedanceGoldenFinalizationError(`${path} 必须是非空文本`)
  }
  return value
}

function isoDate(value: unknown, path: string): string {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed)) throw new SeedanceGoldenFinalizationError(`${path} 必须是 ISO 时间`)
  return value as string
}

function integerScore(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5) {
    throw new SeedanceGoldenFinalizationError(`${path} 必须是 1–5 整数`)
  }
  return value as number
}

function assertDraftReviewPlaceholder(value: unknown, path: string): void {
  const review = record(value, path)
  exactKeys(review, ['reviewerId', 'reviewedAt', 'playbackComplete', 'scores', 'notes'], path)
  if (review.reviewerId !== '' || review.reviewedAt !== '' || review.playbackComplete !== false || review.notes !== '') {
    throw new SeedanceGoldenFinalizationError(`${path} 已被直接编辑；必须只在盲审表填写评分`)
  }
  const scores = record(review.scores, `${path}.scores`)
  exactKeys(scores, SEEDANCE_GOLDEN_METRICS, `${path}.scores`)
  if (SEEDANCE_GOLDEN_METRICS.some((metric) => scores[metric] !== 0)) {
    throw new SeedanceGoldenFinalizationError(`${path}.scores 已被直接编辑；必须只在盲审表填写评分`)
  }
}

function parsedScores(value: unknown, path: string): Record<SeedanceGoldenMetric, number> {
  const scores = record(value, path)
  exactKeys(scores, SEEDANCE_GOLDEN_METRICS, path)
  return Object.fromEntries(SEEDANCE_GOLDEN_METRICS.map((metric) => (
    [metric, integerScore(scores[metric], `${path}.${metric}`)]
  ))) as Record<SeedanceGoldenMetric, number>
}

function structuralValidationCopy(manifest: SeedanceGoldenManifest): SeedanceGoldenManifest {
  return {
    ...manifest,
    cases: manifest.cases.map((item) => ({
      ...item,
      variants: item.variants.map((variant) => ({
        ...variant,
        review: {
          ...variant.review,
          scores: Object.fromEntries(SEEDANCE_GOLDEN_METRICS.map((metric) => [metric, 5])) as Record<SeedanceGoldenMetric, number>,
        },
      })) as typeof item.variants,
    })),
  }
}

export function finalizeSeedanceGoldenManifest(
  manifestDraftValue: unknown,
  reviewSheetValue: unknown,
): {
  manifest: SeedanceGoldenManifest
  report: ReturnType<typeof verifySeedanceGoldenManifest>
} {
  const draft = record(manifestDraftValue, 'manifestDraft')
  const sheet = record(reviewSheetValue, 'reviewSheet')
  exactKeys(sheet, [
    'version', 'manifestName', 'episodeId', 'comparisonAxis', 'reviewerId', 'reviewedAt', 'instructions', 'cases',
  ], 'reviewSheet')
  if (sheet.version !== 1) throw new SeedanceGoldenFinalizationError('reviewSheet.version 必须为 1')
  if (sheet.manifestName !== draft.name
    || sheet.episodeId !== draft.episodeId
    || sheet.comparisonAxis !== draft.comparisonAxis) {
    throw new SeedanceGoldenFinalizationError('盲审表与证据草稿不是同一次 Golden')
  }
  const reviewerId = nonEmpty(sheet.reviewerId, 'reviewSheet.reviewerId', 120)
  const reviewedAt = isoDate(sheet.reviewedAt, 'reviewSheet.reviewedAt')
  if (!Array.isArray(draft.cases) || !Array.isArray(sheet.cases) || draft.cases.length !== sheet.cases.length) {
    throw new SeedanceGoldenFinalizationError('盲审表与证据草稿的镜头数量不一致')
  }
  const reviewCases = new Map<string, JsonRecord>()
  for (const [index, rawCase] of sheet.cases.entries()) {
    const item = record(rawCase, `reviewSheet.cases[${index}]`)
    exactKeys(item, ['sceneId', 'shotId', 'variants'], `reviewSheet.cases[${index}]`)
    const key = `${nonEmpty(item.sceneId, `reviewSheet.cases[${index}].sceneId`)}\u0000${nonEmpty(item.shotId, `reviewSheet.cases[${index}].shotId`)}`
    if (reviewCases.has(key)) throw new SeedanceGoldenFinalizationError(`盲审表重复镜头 ${key.replace('\u0000', '/')}`)
    reviewCases.set(key, item)
  }
  const finalizedCases = draft.cases.map((rawCase, caseIndex) => {
    const draftCase = record(rawCase, `manifestDraft.cases[${caseIndex}]`)
    const sceneId = nonEmpty(draftCase.sceneId, `manifestDraft.cases[${caseIndex}].sceneId`)
    const shotId = nonEmpty(draftCase.shotId, `manifestDraft.cases[${caseIndex}].shotId`)
    const reviewCase = reviewCases.get(`${sceneId}\u0000${shotId}`)
    if (!reviewCase || !Array.isArray(reviewCase.variants) || reviewCase.variants.length !== 2) {
      throw new SeedanceGoldenFinalizationError(`盲审表缺少 ${sceneId}/${shotId} 的 A/B 评分`)
    }
    const reviewsByLabel = new Map<'A' | 'B', JsonRecord>()
    for (const [variantIndex, rawReview] of reviewCase.variants.entries()) {
      const review = record(rawReview, `reviewSheet.cases[${caseIndex}].variants[${variantIndex}]`)
      exactKeys(review, ['blindLabel', 'assetId', 'contentUrl', 'playbackComplete', 'scores', 'notes'], `reviewSheet.cases[${caseIndex}].variants[${variantIndex}]`)
      if (review.blindLabel !== 'A' && review.blindLabel !== 'B') {
        throw new SeedanceGoldenFinalizationError(`${sceneId}/${shotId} 的 blindLabel 无效`)
      }
      if (reviewsByLabel.has(review.blindLabel)) throw new SeedanceGoldenFinalizationError(`${sceneId}/${shotId} 重复 ${review.blindLabel} 评分`)
      reviewsByLabel.set(review.blindLabel, review)
    }
    if (!Array.isArray(draftCase.variants) || draftCase.variants.length !== 2) {
      throw new SeedanceGoldenFinalizationError(`证据草稿 ${sceneId}/${shotId} 不是 A/B 两个结果`)
    }
    const variants = draftCase.variants.map((rawVariant, variantIndex) => {
      const variant = record(rawVariant, `manifestDraft.cases[${caseIndex}].variants[${variantIndex}]`)
      assertDraftReviewPlaceholder(variant.review, `manifestDraft.cases[${caseIndex}].variants[${variantIndex}].review`)
      if (variant.blindLabel !== 'A' && variant.blindLabel !== 'B') {
        throw new SeedanceGoldenFinalizationError(`${sceneId}/${shotId} 的证据 blindLabel 无效`)
      }
      const review = reviewsByLabel.get(variant.blindLabel)
      if (!review || review.assetId !== variant.outputAssetId
        || review.contentUrl !== `/api/v1/assets/${encodeURIComponent(String(variant.outputAssetId))}/content`) {
        throw new SeedanceGoldenFinalizationError(`${sceneId}/${shotId} 的 ${variant.blindLabel} 视频身份已被篡改`)
      }
      if (review.playbackComplete !== true) {
        throw new SeedanceGoldenFinalizationError(`${sceneId}/${shotId} 的 ${variant.blindLabel} 尚未确认完整播放`)
      }
      if (typeof review.notes !== 'string' || review.notes.length > 2_000) {
        throw new SeedanceGoldenFinalizationError(`${sceneId}/${shotId} 的 ${variant.blindLabel} 备注无效`)
      }
      return {
        ...variant,
        review: {
          reviewerId,
          reviewedAt,
          playbackComplete: true as const,
          scores: parsedScores(review.scores, `${sceneId}/${shotId}/${variant.blindLabel}.scores`),
          notes: review.notes,
        },
      }
    })
    return { sceneId, shotId, variants }
  })
  const manifest = {
    ...draft,
    cases: finalizedCases,
  } as unknown as SeedanceGoldenManifest
  const structural = verifySeedanceGoldenManifest(structuralValidationCopy(manifest), reviewedAt)
  if (!structural.passed) {
    throw new SeedanceGoldenFinalizationError(`证据草稿结构或控制变量无效：${structural.failures.join('；')}`)
  }
  return {
    manifest,
    report: verifySeedanceGoldenManifest(manifest, reviewedAt),
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      draft: { type: 'string', short: 'd' },
      review: { type: 'string', short: 'r' },
      output: { type: 'string', short: 'o' },
      report: { type: 'string' },
    },
    strict: true,
  })
  if (!values.draft || !values.review || !values.output || !values.report) {
    throw new SeedanceGoldenFinalizationError('必须提供 --draft、--review、--output 与 --report')
  }
  const [draft, review] = await Promise.all([
    readFile(values.draft, 'utf8').then((value) => JSON.parse(value) as unknown),
    readFile(values.review, 'utf8').then((value) => JSON.parse(value) as unknown),
  ])
  const finalized = finalizeSeedanceGoldenManifest(draft, review)
  await writeFile(values.output, `${JSON.stringify(finalized.manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await writeFile(values.report, `${JSON.stringify(finalized.report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify({
    ok: true,
    passed: finalized.report.passed,
    manifest: resolve(values.output),
    report: resolve(values.report),
    failures: finalized.report.failures,
    providerSubmissions: 0,
  }, null, 2)}\n`)
  if (!finalized.report.passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Seedance Golden 盲审合并失败'}\n`)
    process.exitCode = 1
  })
}
