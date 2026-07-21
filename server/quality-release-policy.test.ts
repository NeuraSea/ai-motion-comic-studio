import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REQUIRED_RELEASE_QUALITY_CHECK_IDS,
  validateCurrentQualityReleasePolicy,
} from './quality-release-policy.js'
import {
  DEFAULT_QUALITY_POLICY,
  type QualityReportRecord,
} from './quality-check.js'

function reportWith(
  checkIds: readonly string[],
  policyVersion: number = DEFAULT_QUALITY_POLICY.version,
) {
  return {
    document: {
      policy: { ...DEFAULT_QUALITY_POLICY, version: policyVersion },
      checks: checkIds.map((id) => ({
        id,
        status: 'passed',
        severity: 'info',
        message: 'ok',
        metrics: {},
      })),
    },
  } as unknown as Pick<QualityReportRecord, 'document'>
}

test('release policy accepts exactly one of every current media and subtitle check', () => {
  assert.deepEqual(
    validateCurrentQualityReleasePolicy(reportWith(REQUIRED_RELEASE_QUALITY_CHECK_IDS)),
    { ok: true },
  )
})

test('release policy rejects a legacy five-check report', () => {
  const result = validateCurrentQualityReleasePolicy(reportWith(
    REQUIRED_RELEASE_QUALITY_CHECK_IDS.slice(0, 5),
  ))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /subtitle\.timing/)
})

test('release policy rejects duplicate required checks and a stale policy version', () => {
  const duplicate = validateCurrentQualityReleasePolicy(reportWith([
    ...REQUIRED_RELEASE_QUALITY_CHECK_IDS,
    'subtitle.timing',
  ]))
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.match(duplicate.reason, /subtitle\.timing/)

  const stale = validateCurrentQualityReleasePolicy(reportWith(
    REQUIRED_RELEASE_QUALITY_CHECK_IDS,
    DEFAULT_QUALITY_POLICY.version + 1,
  ))
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.match(stale.reason, /版本/)
})
