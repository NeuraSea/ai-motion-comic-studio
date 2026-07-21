import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  REQUIRED_FFMPEG_CAPABILITIES,
  REQUIRED_FFMPEG_SMOKE_CHECKS,
  resolveFfmpegRuntime,
  verifyFfmpegDistributionManifest,
  verifyFfmpegDistributionReceipt,
  type FfmpegDistributionManifest,
  type FfmpegDistributionVerificationReceipt,
} from './ffmpeg-runtime.js'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fixture(nonfree = false): Promise<{
  root: string
  ffmpegPath: string
  ffprobePath: string
  manifestPath: string
  receiptPath: string
  manifest: FfmpegDistributionManifest
}> {
  const root = await mkdtemp(join(tmpdir(), 'manju-ffmpeg-runtime-'))
  const ffmpeg = 'audited ffmpeg bytes'
  const ffprobe = 'audited ffprobe bytes'
  const recipe = 'reproducible source build recipe'
  const notice = 'GPL license and third-party notices'
  const source = 'complete corresponding source archive'
  const ffmpegPath = join(root, 'ffmpeg')
  const ffprobePath = join(root, 'ffprobe')
  const manifestPath = join(root, 'FFMPEG_DISTRIBUTION.json')
  const receiptPath = join(root, 'VERIFICATION_RECEIPT.json')
  await Promise.all([
    writeFile(ffmpegPath, ffmpeg, { mode: 0o755 }),
    writeFile(ffprobePath, ffprobe, { mode: 0o755 }),
    writeFile(join(root, 'BUILD.md'), recipe),
    writeFile(join(root, 'COPYING.GPLv3'), notice),
    writeFile(join(root, 'corresponding-source.tar.xz'), source),
  ])
  const configuration = `--enable-gpl --enable-version3 --enable-libx264 --enable-libass${nonfree ? ' --enable-nonfree' : ''}`
  const manifest: FfmpegDistributionManifest = {
    schemaVersion: 1,
    target: { platform: 'test-platform', arch: 'test-arch' },
    source: {
      project: 'FFmpeg',
      version: '8.1.2',
      archiveUrl: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
      archiveSha256: '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c',
      signatureUrl: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.asc',
      signingKeyFingerprint: 'FCF986EA15E6E293A5644F10B4322F04D67658D8',
    },
    build: { recipe: { path: 'BUILD.md', sha256: sha256(recipe) } },
    license: {
      expression: 'GPL-3.0-or-later',
      noticeFiles: [{ path: 'COPYING.GPLv3', sha256: sha256(notice) }],
      correspondingSource: { path: 'corresponding-source.tar.xz', sha256: sha256(source) },
    },
    binaries: {
      ffmpeg: {
        sha256: sha256(ffmpeg),
        versionLine: 'ffmpeg version 8.1.2',
        configuration,
      },
      ffprobe: {
        sha256: sha256(ffprobe),
        versionLine: 'ffprobe version 8.1.2',
        configuration,
      },
    },
    capabilities: REQUIRED_FFMPEG_CAPABILITIES,
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(manifestPath, manifestText)
  const receipt: FfmpegDistributionVerificationReceipt = {
    schemaVersion: 1,
    status: 'verified',
    manifestSha256: sha256(manifestText),
    target: manifest.target,
    source: manifest.source,
    licenseExpression: manifest.license.expression,
    ffmpegSha256: manifest.binaries.ffmpeg.sha256,
    ffprobeSha256: manifest.binaries.ffprobe.sha256,
    ffmpegVersionLine: manifest.binaries.ffmpeg.versionLine,
    ffprobeVersionLine: manifest.binaries.ffprobe.versionLine,
    ffmpegConfiguration: manifest.binaries.ffmpeg.configuration,
    ffprobeConfiguration: manifest.binaries.ffprobe.configuration,
    requiredCapabilities: REQUIRED_FFMPEG_CAPABILITIES,
    smokeChecks: REQUIRED_FFMPEG_SMOKE_CHECKS,
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  return { root, ffmpegPath, ffprobePath, manifestPath, receiptPath, manifest }
}

test('development runtime keeps ffmpeg-static as an explicitly non-release fallback', () => {
  const result = resolveFfmpegRuntime({
    environment: {},
    cwd: '/empty',
    platform: 'test-platform',
    arch: 'test-arch',
    requireModule: (id) => id === 'ffmpeg-static'
      ? '/development/ffmpeg'
      : { path: '/development/ffprobe' },
  })
  assert.equal(result.source, 'ffmpeg-static-development')
  assert.equal(result.releaseEligible, false)
  assert.equal(result.ffmpegPath, '/development/ffmpeg')
  assert.match(result.issues.join(' '), /development-only/)
})

test('release mode fails closed rather than resolving ffmpeg-static', () => {
  const result = resolveFfmpegRuntime({
    environment: { MANJU_FFMPEG_RELEASE_MODE: '1' },
    cwd: '/empty',
    platform: 'test-platform',
    arch: 'test-arch',
    requireModule: () => assert.fail('release mode must not load locator packages'),
  })
  assert.equal(result.source, 'unavailable')
  assert.equal(result.ffmpegPath, null)
  assert.match(result.issues.join(' '), /no audited FFmpeg bundle/)
})

test('explicit development paths must be paired and absolute', () => {
  const missingPair = resolveFfmpegRuntime({
    environment: { MANJU_FFMPEG_PATH: '/tmp/ffmpeg' },
    platform: 'test-platform',
    arch: 'test-arch',
  })
  assert.equal(missingPair.source, 'unavailable')
  assert.match(missingPair.issues.join(' '), /configured together/)

  const relative = resolveFfmpegRuntime({
    environment: { MANJU_FFMPEG_PATH: 'ffmpeg', MANJU_FFPROBE_PATH: 'ffprobe' },
    platform: 'test-platform',
    arch: 'test-arch',
  })
  assert.equal(relative.source, 'unavailable')
  assert.match(relative.issues.join(' '), /absolute/)
})

test('a hash-pinned manifest makes an explicit binary pair release eligible', async (context) => {
  const created = await fixture()
  context.after(() => rm(created.root, { recursive: true, force: true }))
  const result = resolveFfmpegRuntime({
    environment: {
      MANJU_FFMPEG_RELEASE_MODE: '1',
      MANJU_FFMPEG_PATH: created.ffmpegPath,
      MANJU_FFPROBE_PATH: created.ffprobePath,
      MANJU_FFMPEG_MANIFEST: created.manifestPath,
    },
    platform: 'test-platform',
    arch: 'test-arch',
  })
  assert.equal(result.source, 'explicit-audited')
  assert.equal(result.releaseEligible, true)
  assert.deepEqual(result.issues, [])
})

test('an audited target bundle is preferred without environment binary paths', async (context) => {
  const created = await fixture()
  context.after(() => rm(created.root, { recursive: true, force: true }))
  const result = resolveFfmpegRuntime({
    environment: {
      MANJU_FFMPEG_RELEASE_MODE: '1',
      MANJU_FFMPEG_BUNDLE_DIR: created.root,
    },
    platform: 'test-platform',
    arch: 'test-arch',
  })
  assert.equal(result.source, 'bundled-audited')
  assert.equal(result.releaseEligible, true)
  assert.equal(result.manifestPath, created.manifestPath)
  assert.equal(result.verificationReceiptPath, created.receiptPath)
  assert.equal(result.audit?.manifestSha256, sha256(`${JSON.stringify(created.manifest, null, 2)}\n`))
})

test('release runtime requires a build receipt bound to the exact manifest and complete smoke suite', async (context) => {
  const created = await fixture()
  context.after(() => rm(created.root, { recursive: true, force: true }))
  await unlink(created.receiptPath)
  const missing = resolveFfmpegRuntime({
    environment: {
      MANJU_FFMPEG_RELEASE_MODE: '1',
      MANJU_FFMPEG_PATH: created.ffmpegPath,
      MANJU_FFPROBE_PATH: created.ffprobePath,
      MANJU_FFMPEG_MANIFEST: created.manifestPath,
    },
    platform: 'test-platform',
    arch: 'test-arch',
  })
  assert.equal(missing.source, 'unavailable')
  assert.match(missing.issues.join('\n'), /verification receipt is missing/)
  const buildGate = resolveFfmpegRuntime({
    environment: {
      MANJU_FFMPEG_RELEASE_MODE: '1',
      MANJU_FFMPEG_PATH: created.ffmpegPath,
      MANJU_FFPROBE_PATH: created.ffprobePath,
      MANJU_FFMPEG_MANIFEST: created.manifestPath,
    },
    platform: 'test-platform',
    arch: 'test-arch',
    requireVerificationReceipt: false,
  })
  assert.equal(buildGate.source, 'explicit-audited')
  assert.equal(buildGate.verificationReceiptPath, null)

  const incomplete: FfmpegDistributionVerificationReceipt = {
    schemaVersion: 1,
    status: 'verified',
    manifestSha256: sha256(`${JSON.stringify(created.manifest, null, 2)}\n`),
    target: created.manifest.target,
    source: created.manifest.source,
    licenseExpression: created.manifest.license.expression,
    ffmpegSha256: created.manifest.binaries.ffmpeg.sha256,
    ffprobeSha256: created.manifest.binaries.ffprobe.sha256,
    ffmpegVersionLine: created.manifest.binaries.ffmpeg.versionLine,
    ffprobeVersionLine: created.manifest.binaries.ffprobe.versionLine,
    ffmpegConfiguration: created.manifest.binaries.ffmpeg.configuration,
    ffprobeConfiguration: created.manifest.binaries.ffprobe.configuration,
    requiredCapabilities: REQUIRED_FFMPEG_CAPABILITIES,
    smokeChecks: REQUIRED_FFMPEG_SMOKE_CHECKS.slice(0, -1),
  }
  await writeFile(created.receiptPath, `${JSON.stringify(incomplete, null, 2)}\n`)
  const rejected = verifyFfmpegDistributionReceipt({
    receiptPath: created.receiptPath,
    manifestPath: created.manifestPath,
    manifest: created.manifest,
  })
  assert.equal(rejected.valid, false)
  assert.match(rejected.issues.join('\n'), /complete smoke suite/)
  const rebuildGate = resolveFfmpegRuntime({
    environment: {
      MANJU_FFMPEG_RELEASE_MODE: '1',
      MANJU_FFMPEG_PATH: created.ffmpegPath,
      MANJU_FFPROBE_PATH: created.ffprobePath,
      MANJU_FFMPEG_MANIFEST: created.manifestPath,
    },
    platform: 'test-platform',
    arch: 'test-arch',
    requireVerificationReceipt: false,
  })
  assert.equal(rebuildGate.source, 'explicit-audited')
})

test('runtime audited resolution re-hashes legal files instead of trusting manifest existence', async (context) => {
  const created = await fixture()
  context.after(() => rm(created.root, { recursive: true, force: true }))
  await writeFile(join(created.root, 'COPYING.GPLv3'), 'post-build tampering')
  const result = resolveFfmpegRuntime({
    environment: {
      MANJU_FFMPEG_RELEASE_MODE: '1',
      MANJU_FFMPEG_BUNDLE_DIR: created.root,
    },
    platform: 'test-platform',
    arch: 'test-arch',
  })
  assert.equal(result.source, 'unavailable')
  assert.match(result.issues.join('\n'), /license notice 1 checksum/)
})

test('manifest verification rejects nonfree configuration and legal-file tampering', async (context) => {
  const created = await fixture(true)
  context.after(() => rm(created.root, { recursive: true, force: true }))
  await writeFile(join(created.root, 'COPYING.GPLv3'), 'tampered notice')
  const result = verifyFfmpegDistributionManifest({
    manifestPath: created.manifestPath,
    ffmpegPath: created.ffmpegPath,
    ffprobePath: created.ffprobePath,
    platform: 'test-platform',
    arch: 'test-arch',
  })
  assert.equal(result.valid, false)
  assert.match(result.issues.join('\n'), /--enable-nonfree/)
  assert.match(result.issues.join('\n'), /license notice 1 checksum/)
})

test('an incomplete claimed capability set cannot authorize a release binary', async (context) => {
  const created = await fixture()
  context.after(() => rm(created.root, { recursive: true, force: true }))
  const incomplete = {
    ...created.manifest,
    capabilities: {
      ...created.manifest.capabilities,
      filters: created.manifest.capabilities.filters.filter((item) => item !== 'subtitles'),
    },
  }
  await writeFile(created.manifestPath, `${JSON.stringify(incomplete, null, 2)}\n`)
  const result = verifyFfmpegDistributionManifest({
    manifestPath: created.manifestPath,
    ffmpegPath: created.ffmpegPath,
    ffprobePath: created.ffprobePath,
    platform: 'test-platform',
    arch: 'test-arch',
  })
  assert.equal(result.valid, false)
  assert.match(result.issues.join('\n'), /filters:subtitles/)
})

test('unreviewed source coordinates cannot be substituted behind an otherwise valid manifest', async (context) => {
  const created = await fixture()
  context.after(() => rm(created.root, { recursive: true, force: true }))
  const substituted = {
    ...created.manifest,
    source: { ...created.manifest.source, archiveSha256: '2'.repeat(64) },
  }
  await writeFile(created.manifestPath, `${JSON.stringify(substituted, null, 2)}\n`)
  const result = verifyFfmpegDistributionManifest({
    manifestPath: created.manifestPath,
    ffmpegPath: created.ffmpegPath,
    ffprobePath: created.ffprobePath,
    platform: 'test-platform',
    arch: 'test-arch',
  })
  assert.equal(result.valid, false)
  assert.match(result.issues.join('\n'), /primary-source ledger/)
})

test('license declaration must match GPL and version3 configure switches', async (context) => {
  const created = await fixture()
  context.after(() => rm(created.root, { recursive: true, force: true }))
  const mislabeled = {
    ...created.manifest,
    license: { ...created.manifest.license, expression: 'LGPL-2.1-or-later' },
  }
  await writeFile(created.manifestPath, `${JSON.stringify(mislabeled, null, 2)}\n`)
  const result = verifyFfmpegDistributionManifest({
    manifestPath: created.manifestPath,
    ffmpegPath: created.ffmpegPath,
    ffprobePath: created.ffprobePath,
    platform: 'test-platform',
    arch: 'test-arch',
  })
  assert.equal(result.valid, false)
  assert.match(result.issues.join('\n'), /requires GPL-3\.0-or-later/)
})
