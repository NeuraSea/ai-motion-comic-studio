import {
  QUALITY_POLICY_VERSION,
  type QualityCheckResult,
  type QualityReportRecord,
} from './quality-check.js'

/**
 * The complete check set required by a release authorization.
 *
 * This is deliberately enforced at the two production release consumers as
 * well as by the report summary. Reports produced before subtitle QC existed
 * can otherwise remain durably `passed` and retain a valid asset binding.
 */
export const REQUIRED_RELEASE_QUALITY_CHECK_IDS = Object.freeze([
  'decodable',
  'ffprobe.specification',
  'video.black-frames',
  'audio.silence',
  'audio.peak',
  'subtitle.timing',
  'subtitle.safe-area',
] satisfies QualityCheckResult['id'][])

export type QualityReleasePolicyValidation =
  | { ok: true }
  | { ok: false; reason: string }

export function validateCurrentQualityReleasePolicy(
  report: Pick<QualityReportRecord, 'document'>,
): QualityReleasePolicyValidation {
  if (report.document.policy?.version !== QUALITY_POLICY_VERSION) {
    return {
      ok: false,
      reason: `质检策略版本已过期（当前版本 ${QUALITY_POLICY_VERSION}）`,
    }
  }

  const counts = new Map<string, number>()
  for (const check of report.document.checks) {
    counts.set(check.id, (counts.get(check.id) ?? 0) + 1)
  }
  const invalid = REQUIRED_RELEASE_QUALITY_CHECK_IDS.filter((id) => counts.get(id) !== 1)
  if (invalid.length > 0) {
    return {
      ok: false,
      reason: `质检项不完整或重复：${invalid.join(', ')}`,
    }
  }
  return { ok: true }
}
