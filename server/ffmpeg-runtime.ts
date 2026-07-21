import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

const runtimeRequire = createRequire(
  typeof __filename === 'string' ? __filename : join(process.cwd(), 'package.json'),
)

const SHA256 = /^[0-9a-f]{64}$/
const SAFE_LICENSE_EXPRESSIONS = new Set([
  'GPL-2.0-or-later',
  'GPL-3.0-or-later',
  'LGPL-2.1-or-later',
  'LGPL-3.0-or-later',
])

export const APPROVED_FFMPEG_SOURCES = Object.freeze({
  '8.1.2': Object.freeze({
    archiveUrl: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
    archiveSha256: '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c',
    signatureUrl: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.asc',
    signingKeyFingerprint: 'FCF986EA15E6E293A5644F10B4322F04D67658D8',
  }),
} as const)

export const REQUIRED_FFMPEG_CAPABILITIES = Object.freeze({
  encoders: Object.freeze(['aac', 'libx264', 'png']),
  decoders: Object.freeze([
    'aac',
    'av1',
    'gif',
    'h264',
    'mjpeg',
    'mp3',
    'opus',
    'pcm_s16le',
    'png',
    'vorbis',
    'vp8',
    'vp9',
    'webp',
  ]),
  filters: Object.freeze([
    'adelay',
    'afade',
    'aformat',
    'amix',
    'anullsrc',
    'apad',
    'aresample',
    'asetpts',
    'ass',
    'atrim',
    'blackdetect',
    'concat',
    'crop',
    'fade',
    'format',
    'fps',
    'geq',
    'null',
    'pad',
    'scale',
    'setsar',
    'silencedetect',
    'split',
    'subtitles',
    'trim',
    'volume',
    'volumedetect',
    'zoompan',
  ]),
  demuxers: Object.freeze(['gif', 'image2', 'matroska', 'mov', 'mp3', 'wav']),
  muxers: Object.freeze(['image2', 'mp4', 'null']),
} as const)

export const REQUIRED_FFMPEG_SMOKE_CHECKS = Object.freeze([
  'libx264+aac-mp4-encode',
  'ffprobe-json-probe',
  'libass-subtitle-render',
  'shape-filter-geq',
  'qc-blackdetect',
  'qc-silencedetect-volumedetect',
  'png-crop-encode',
] as const)

export interface FfmpegHashedFileReference {
  readonly path: string
  readonly sha256: string
}

export interface FfmpegDistributionManifest {
  readonly schemaVersion: 1
  readonly target: {
    readonly platform: string
    readonly arch: string
  }
  readonly source: {
    readonly project: 'FFmpeg'
    readonly version: string
    readonly archiveUrl: string
    readonly archiveSha256: string
    readonly signatureUrl: string
    readonly signingKeyFingerprint: string
  }
  readonly build: {
    readonly recipe: FfmpegHashedFileReference
  }
  readonly license: {
    readonly expression: string
    readonly noticeFiles: readonly FfmpegHashedFileReference[]
    readonly correspondingSource: FfmpegHashedFileReference
  }
  readonly binaries: {
    readonly ffmpeg: {
      readonly sha256: string
      readonly versionLine: string
      readonly configuration: string
    }
    readonly ffprobe: {
      readonly sha256: string
      readonly versionLine: string
      readonly configuration: string
    }
  }
  readonly capabilities: {
    readonly encoders: readonly string[]
    readonly decoders: readonly string[]
    readonly filters: readonly string[]
    readonly demuxers: readonly string[]
    readonly muxers: readonly string[]
  }
}

/** Build-time proof produced only after live inspection and renderer/QC smoke. */
export interface FfmpegDistributionVerificationReceipt {
  readonly schemaVersion: 1
  readonly status: 'verified'
  readonly manifestSha256: string
  readonly target: FfmpegDistributionManifest['target']
  readonly source: FfmpegDistributionManifest['source']
  readonly licenseExpression: string
  readonly ffmpegSha256: string
  readonly ffprobeSha256: string
  readonly ffmpegVersionLine: string
  readonly ffprobeVersionLine: string
  readonly ffmpegConfiguration: string
  readonly ffprobeConfiguration: string
  readonly requiredCapabilities: typeof REQUIRED_FFMPEG_CAPABILITIES
  readonly smokeChecks: readonly string[]
}

export type FfmpegRuntimeSource =
  | 'explicit-audited'
  | 'explicit-development'
  | 'bundled-audited'
  | 'ffmpeg-static-development'
  | 'unavailable'

/** Path-free receipt safe to persist with a failed render Job. */
export interface FfmpegRuntimeAuditSummary {
  readonly schemaVersion: 1
  readonly source: Extract<FfmpegRuntimeSource, 'explicit-audited' | 'bundled-audited'>
  readonly target: FfmpegDistributionManifest['target']
  readonly sourceVersion: string
  readonly manifestSha256: string
  readonly verificationReceiptSha256: string | null
  readonly ffmpegSha256: string
  readonly ffprobeSha256: string
}

export interface FfmpegRuntimeDiagnosticReceipt {
  readonly schemaVersion: 1
  readonly source: FfmpegRuntimeSource
  readonly releaseEligible: boolean
  readonly audit: FfmpegRuntimeAuditSummary | null
}

export interface FfmpegRuntimeResolution {
  readonly ffmpegPath: string | null
  readonly ffprobePath: string | null
  readonly source: FfmpegRuntimeSource
  readonly releaseEligible: boolean
  readonly manifestPath: string | null
  readonly verificationReceiptPath: string | null
  readonly audit: FfmpegRuntimeAuditSummary | null
  readonly issues: readonly string[]
}

export interface FfmpegManifestVerification {
  readonly valid: boolean
  readonly manifest: FfmpegDistributionManifest | null
  readonly issues: readonly string[]
}

export interface FfmpegReceiptVerification {
  readonly valid: boolean
  readonly receipt: FfmpegDistributionVerificationReceipt | null
  readonly issues: readonly string[]
}

interface RuntimeEnvironment {
  readonly MANJU_FFMPEG_PATH?: string
  readonly MANJU_FFPROBE_PATH?: string
  readonly MANJU_FFMPEG_MANIFEST?: string
  readonly MANJU_FFMPEG_RECEIPT?: string
  readonly MANJU_FFMPEG_BUNDLE_DIR?: string
  readonly MANJU_FFMPEG_RELEASE_MODE?: string
}

interface RuntimeResolutionOptions {
  readonly environment?: RuntimeEnvironment
  readonly cwd?: string
  readonly platform?: string
  readonly arch?: string
  readonly requireModule?: (id: string) => unknown
  /** Build verifier only: it creates the receipt after live smoke succeeds. */
  readonly requireVerificationReceipt?: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) return null
  return value as string[]
}

function hashedFile(value: unknown): FfmpegHashedFileReference | null {
  if (!isObject(value) || !isNonEmptyString(value.path) || !SHA256.test(String(value.sha256))) return null
  return { path: value.path, sha256: String(value.sha256) }
}

function parseManifest(value: unknown): FfmpegDistributionManifest | null {
  if (!isObject(value)
    || value.schemaVersion !== 1
    || !isObject(value.target)
    || !isNonEmptyString(value.target.platform)
    || !isNonEmptyString(value.target.arch)
    || !isObject(value.source)
    || value.source.project !== 'FFmpeg'
    || !isNonEmptyString(value.source.version)
    || !isNonEmptyString(value.source.archiveUrl)
    || !SHA256.test(String(value.source.archiveSha256))
    || !isNonEmptyString(value.source.signatureUrl)
    || !/^[0-9A-F]{40}$/.test(String(value.source.signingKeyFingerprint))
    || !isObject(value.build)
    || !isObject(value.license)
    || !isNonEmptyString(value.license.expression)
    || !isObject(value.binaries)
    || !isObject(value.binaries.ffmpeg)
    || !isObject(value.binaries.ffprobe)
    || !isObject(value.capabilities)) return null

  const recipe = hashedFile(value.build.recipe)
  const correspondingSource = hashedFile(value.license.correspondingSource)
  const noticeFiles = Array.isArray(value.license.noticeFiles)
    ? value.license.noticeFiles.map(hashedFile)
    : []
  const encoders = stringArray(value.capabilities.encoders)
  const decoders = stringArray(value.capabilities.decoders)
  const filters = stringArray(value.capabilities.filters)
  const demuxers = stringArray(value.capabilities.demuxers)
  const muxers = stringArray(value.capabilities.muxers)
  if (!recipe || !correspondingSource || noticeFiles.length === 0 || noticeFiles.some((item) => !item)
    || !encoders || !decoders || !filters || !demuxers || !muxers) return null

  const ffmpeg = value.binaries.ffmpeg
  const ffprobe = value.binaries.ffprobe
  if (!SHA256.test(String(ffmpeg.sha256))
    || !isNonEmptyString(ffmpeg.versionLine)
    || !isNonEmptyString(ffmpeg.configuration)
    || !SHA256.test(String(ffprobe.sha256))
    || !isNonEmptyString(ffprobe.versionLine)
    || !isNonEmptyString(ffprobe.configuration)) return null

  return {
    schemaVersion: 1,
    target: { platform: value.target.platform, arch: value.target.arch },
    source: {
      project: 'FFmpeg',
      version: value.source.version,
      archiveUrl: value.source.archiveUrl,
      archiveSha256: String(value.source.archiveSha256),
      signatureUrl: value.source.signatureUrl,
      signingKeyFingerprint: String(value.source.signingKeyFingerprint),
    },
    build: { recipe },
    license: {
      expression: value.license.expression,
      noticeFiles: noticeFiles as FfmpegHashedFileReference[],
      correspondingSource,
    },
    binaries: {
      ffmpeg: {
        sha256: String(ffmpeg.sha256),
        versionLine: ffmpeg.versionLine,
        configuration: ffmpeg.configuration,
      },
      ffprobe: {
        sha256: String(ffprobe.sha256),
        versionLine: ffprobe.versionLine,
        configuration: ffprobe.configuration,
      },
    },
    capabilities: { encoders, decoders, filters, demuxers, muxers },
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function parseVerificationReceipt(value: unknown): FfmpegDistributionVerificationReceipt | null {
  if (!isObject(value)
    || value.schemaVersion !== 1
    || value.status !== 'verified'
    || !SHA256.test(String(value.manifestSha256))
    || !isObject(value.target)
    || !isNonEmptyString(value.target.platform)
    || !isNonEmptyString(value.target.arch)
    || !isObject(value.source)
    || value.source.project !== 'FFmpeg'
    || !isNonEmptyString(value.source.version)
    || !isNonEmptyString(value.source.archiveUrl)
    || !SHA256.test(String(value.source.archiveSha256))
    || !isNonEmptyString(value.source.signatureUrl)
    || !/^[0-9A-F]{40}$/.test(String(value.source.signingKeyFingerprint))
    || !isNonEmptyString(value.licenseExpression)
    || !SHA256.test(String(value.ffmpegSha256))
    || !SHA256.test(String(value.ffprobeSha256))
    || !isNonEmptyString(value.ffmpegVersionLine)
    || !isNonEmptyString(value.ffprobeVersionLine)
    || !isNonEmptyString(value.ffmpegConfiguration)
    || !isNonEmptyString(value.ffprobeConfiguration)
    || !isObject(value.requiredCapabilities)) return null
  const capabilities = {
    encoders: stringArray(value.requiredCapabilities.encoders),
    decoders: stringArray(value.requiredCapabilities.decoders),
    filters: stringArray(value.requiredCapabilities.filters),
    demuxers: stringArray(value.requiredCapabilities.demuxers),
    muxers: stringArray(value.requiredCapabilities.muxers),
  }
  const smokeChecks = stringArray(value.smokeChecks)
  if (Object.values(capabilities).some((item) => item === null) || !smokeChecks) return null
  return {
    schemaVersion: 1,
    status: 'verified',
    manifestSha256: String(value.manifestSha256),
    target: { platform: value.target.platform, arch: value.target.arch },
    source: {
      project: 'FFmpeg',
      version: value.source.version,
      archiveUrl: value.source.archiveUrl,
      archiveSha256: String(value.source.archiveSha256),
      signatureUrl: value.source.signatureUrl,
      signingKeyFingerprint: String(value.source.signingKeyFingerprint),
    },
    licenseExpression: value.licenseExpression,
    ffmpegSha256: String(value.ffmpegSha256),
    ffprobeSha256: String(value.ffprobeSha256),
    ffmpegVersionLine: value.ffmpegVersionLine,
    ffprobeVersionLine: value.ffprobeVersionLine,
    ffmpegConfiguration: value.ffmpegConfiguration,
    ffprobeConfiguration: value.ffprobeConfiguration,
    requiredCapabilities: capabilities as unknown as typeof REQUIRED_FFMPEG_CAPABILITIES,
    smokeChecks,
  }
}

function regularFile(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function resolveContainedFile(root: string, path: string): string | null {
  if (!path || isAbsolute(path)) return null
  const destination = resolve(root, path)
  const relationship = relative(root, destination)
  if (!relationship || relationship.startsWith('..') || isAbsolute(relationship)) return null
  return destination
}

function verifyHashedFile(
  manifestDirectory: string,
  item: FfmpegHashedFileReference,
  label: string,
  issues: string[],
  verifyChecksum = true,
): void {
  const path = resolveContainedFile(manifestDirectory, item.path)
  if (!path || !regularFile(path)) {
    issues.push(`${label} is missing, unsafe, a symlink, or not a regular file`)
    return
  }
  if (verifyChecksum && sha256File(path) !== item.sha256) issues.push(`${label} checksum does not match the manifest`)
}

function missingCapabilities(
  actual: FfmpegDistributionManifest['capabilities'],
): string[] {
  const missing: string[] = []
  for (const [group, required] of Object.entries(REQUIRED_FFMPEG_CAPABILITIES)) {
    const values = new Set(actual[group as keyof typeof actual])
    for (const capability of required) {
      if (!values.has(capability)) missing.push(`${group}:${capability}`)
    }
  }
  return missing
}

export function verifyFfmpegDistributionManifest(input: {
  readonly manifestPath: string
  readonly ffmpegPath: string
  readonly ffprobePath: string
  readonly platform?: string
  readonly arch?: string
  readonly verifyLegalFileChecksums?: boolean
}): FfmpegManifestVerification {
  const issues: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(input.manifestPath, 'utf8'))
  } catch {
    return { valid: false, manifest: null, issues: ['distribution manifest cannot be read as JSON'] }
  }
  const manifest = parseManifest(parsed)
  if (!manifest) return { valid: false, manifest: null, issues: ['distribution manifest schema is invalid'] }
  const expectedPlatform = input.platform ?? process.platform
  const expectedArch = input.arch ?? process.arch
  if (manifest.target.platform !== expectedPlatform || manifest.target.arch !== expectedArch) {
    issues.push(`manifest target ${manifest.target.platform}/${manifest.target.arch} does not match ${expectedPlatform}/${expectedArch}`)
  }
  if (!regularFile(input.ffmpegPath)) issues.push('FFmpeg binary is missing, a symlink, or not a regular file')
  if (!regularFile(input.ffprobePath)) issues.push('ffprobe binary is missing, a symlink, or not a regular file')
  if (regularFile(input.ffmpegPath) && sha256File(input.ffmpegPath) !== manifest.binaries.ffmpeg.sha256) {
    issues.push('FFmpeg binary checksum does not match the manifest')
  }
  if (regularFile(input.ffprobePath) && sha256File(input.ffprobePath) !== manifest.binaries.ffprobe.sha256) {
    issues.push('ffprobe binary checksum does not match the manifest')
  }
  if (/(?:^|\s)--enable-nonfree(?:\s|$)/.test(manifest.binaries.ffmpeg.configuration)
    || /(?:^|\s)--enable-nonfree(?:\s|$)/.test(manifest.binaries.ffprobe.configuration)) {
    issues.push('manifest records --enable-nonfree; this binary is not release eligible')
  }
  if (!SAFE_LICENSE_EXPRESSIONS.has(manifest.license.expression)) {
    issues.push(`unsupported license expression: ${manifest.license.expression}`)
  }
  const enablesGpl = /(?:^|\s)--enable-gpl(?:\s|$)/.test(manifest.binaries.ffmpeg.configuration)
  const enablesVersion3 = /(?:^|\s)--enable-version3(?:\s|$)/.test(manifest.binaries.ffmpeg.configuration)
  const expectedLicense = enablesGpl
    ? enablesVersion3 ? 'GPL-3.0-or-later' : 'GPL-2.0-or-later'
    : enablesVersion3 ? 'LGPL-3.0-or-later' : 'LGPL-2.1-or-later'
  if (manifest.license.expression !== expectedLicense) {
    issues.push(`FFmpeg configuration requires ${expectedLicense}, not ${manifest.license.expression}`)
  }
  const approvedSource = APPROVED_FFMPEG_SOURCES[
    manifest.source.version as keyof typeof APPROVED_FFMPEG_SOURCES
  ]
  if (!approvedSource
    || manifest.source.archiveUrl !== approvedSource.archiveUrl
    || manifest.source.archiveSha256 !== approvedSource.archiveSha256
    || manifest.source.signatureUrl !== approvedSource.signatureUrl
    || manifest.source.signingKeyFingerprint !== approvedSource.signingKeyFingerprint) {
    issues.push('FFmpeg source provenance does not match the reviewed primary-source ledger')
  }
  const missing = missingCapabilities(manifest.capabilities)
  if (missing.length > 0) issues.push(`manifest omits required renderer capabilities: ${missing.join(', ')}`)

  const manifestDirectory = dirname(resolve(input.manifestPath))
  const verifyLegalFileChecksums = input.verifyLegalFileChecksums !== false
  verifyHashedFile(manifestDirectory, manifest.build.recipe, 'build recipe', issues, verifyLegalFileChecksums)
  verifyHashedFile(manifestDirectory, manifest.license.correspondingSource, 'corresponding source archive', issues, verifyLegalFileChecksums)
  manifest.license.noticeFiles.forEach((item, index) => {
    verifyHashedFile(manifestDirectory, item, `license notice ${index + 1}`, issues, verifyLegalFileChecksums)
  })
  return { valid: issues.length === 0, manifest, issues }
}

function sameStringArray(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index])
}

function sameSource(
  actual: FfmpegDistributionVerificationReceipt['source'],
  expected: FfmpegDistributionManifest['source'],
): boolean {
  return actual.project === expected.project
    && actual.version === expected.version
    && actual.archiveUrl === expected.archiveUrl
    && actual.archiveSha256 === expected.archiveSha256
    && actual.signatureUrl === expected.signatureUrl
    && actual.signingKeyFingerprint === expected.signingKeyFingerprint
}

export function verifyFfmpegDistributionReceipt(input: {
  readonly receiptPath: string
  readonly manifestPath: string
  readonly manifest: FfmpegDistributionManifest
}): FfmpegReceiptVerification {
  if (!regularFile(input.receiptPath)) {
    return {
      valid: false,
      receipt: null,
      issues: ['FFmpeg verification receipt is missing, a symlink, or not a regular file'],
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(input.receiptPath, 'utf8'))
  } catch {
    return { valid: false, receipt: null, issues: ['FFmpeg verification receipt cannot be read as JSON'] }
  }
  const receipt = parseVerificationReceipt(parsed)
  if (!receipt) {
    return { valid: false, receipt: null, issues: ['FFmpeg verification receipt schema is invalid'] }
  }
  const issues: string[] = []
  if (!regularFile(input.manifestPath)
    || receipt.manifestSha256 !== sha256File(input.manifestPath)) {
    issues.push('FFmpeg verification receipt does not match the distribution manifest')
  }
  if (receipt.target.platform !== input.manifest.target.platform
    || receipt.target.arch !== input.manifest.target.arch) {
    issues.push('FFmpeg verification receipt target does not match the manifest')
  }
  if (!sameSource(receipt.source, input.manifest.source)) {
    issues.push('FFmpeg verification receipt source does not match the manifest')
  }
  if (receipt.licenseExpression !== input.manifest.license.expression) {
    issues.push('FFmpeg verification receipt license does not match the manifest')
  }
  if (receipt.ffmpegSha256 !== input.manifest.binaries.ffmpeg.sha256
    || receipt.ffprobeSha256 !== input.manifest.binaries.ffprobe.sha256) {
    issues.push('FFmpeg verification receipt binary hashes do not match the manifest')
  }
  if (receipt.ffmpegVersionLine !== input.manifest.binaries.ffmpeg.versionLine
    || receipt.ffprobeVersionLine !== input.manifest.binaries.ffprobe.versionLine
    || receipt.ffmpegConfiguration !== input.manifest.binaries.ffmpeg.configuration
    || receipt.ffprobeConfiguration !== input.manifest.binaries.ffprobe.configuration) {
    issues.push('FFmpeg verification receipt binary inspection does not match the manifest')
  }
  for (const [group, expected] of Object.entries(REQUIRED_FFMPEG_CAPABILITIES)) {
    const actual = receipt.requiredCapabilities[group as keyof typeof receipt.requiredCapabilities]
    if (!sameStringArray(actual, expected)) {
      issues.push(`FFmpeg verification receipt required ${group} are incomplete or reordered`)
    }
  }
  if (!sameStringArray(receipt.smokeChecks, REQUIRED_FFMPEG_SMOKE_CHECKS)) {
    issues.push('FFmpeg verification receipt does not contain the complete smoke suite')
  }
  return { valid: issues.length === 0, receipt, issues }
}

function runtimeAuditSummary(input: {
  source: FfmpegRuntimeAuditSummary['source']
  manifestPath: string
  manifest: FfmpegDistributionManifest
  receiptPath: string | null
}): FfmpegRuntimeAuditSummary {
  return {
    schemaVersion: 1,
    source: input.source,
    target: input.manifest.target,
    sourceVersion: input.manifest.source.version,
    manifestSha256: sha256File(input.manifestPath),
    verificationReceiptSha256: input.receiptPath ? sha256File(input.receiptPath) : null,
    ffmpegSha256: input.manifest.binaries.ffmpeg.sha256,
    ffprobeSha256: input.manifest.binaries.ffprobe.sha256,
  }
}

function packageFfmpegPath(requireModule: (id: string) => unknown): string | null {
  try {
    const value = requireModule('ffmpeg-static')
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

function packageFfprobePath(requireModule: (id: string) => unknown): string | null {
  try {
    const value = requireModule('@ffprobe-installer/ffprobe')
    if (!isObject(value) || typeof value.path !== 'string') return null
    return value.path
  } catch {
    return null
  }
}

function unavailable(issues: readonly string[]): FfmpegRuntimeResolution {
  return {
    ffmpegPath: null,
    ffprobePath: null,
    source: 'unavailable',
    releaseEligible: false,
    manifestPath: null,
    verificationReceiptPath: null,
    audit: null,
    issues,
  }
}

export function resolveFfmpegRuntime(
  options: RuntimeResolutionOptions = {},
): FfmpegRuntimeResolution {
  const environment = options.environment ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const requireModule = options.requireModule ?? runtimeRequire
  const releaseMode = environment.MANJU_FFMPEG_RELEASE_MODE === '1'
  const requireVerificationReceipt = options.requireVerificationReceipt ?? releaseMode
  const isBuildVerification = options.requireVerificationReceipt === false
  const explicitFfmpeg = environment.MANJU_FFMPEG_PATH?.trim() || null
  const explicitFfprobe = environment.MANJU_FFPROBE_PATH?.trim() || null
  const explicitManifest = environment.MANJU_FFMPEG_MANIFEST?.trim() || null
  const configuredReceipt = environment.MANJU_FFMPEG_RECEIPT?.trim() || null

  if (explicitFfmpeg || explicitFfprobe || explicitManifest || configuredReceipt) {
    if (!explicitFfmpeg || !explicitFfprobe) {
      return unavailable(['MANJU_FFMPEG_PATH and MANJU_FFPROBE_PATH must be configured together'])
    }
    if (!isAbsolute(explicitFfmpeg) || !isAbsolute(explicitFfprobe)) {
      return unavailable(['explicit FFmpeg and ffprobe paths must be absolute'])
    }
    if (explicitManifest) {
      if (!isAbsolute(explicitManifest)) return unavailable(['MANJU_FFMPEG_MANIFEST must be absolute'])
      if (configuredReceipt && !isAbsolute(configuredReceipt)) {
        return unavailable(['MANJU_FFMPEG_RECEIPT must be absolute'])
      }
      const verification = verifyFfmpegDistributionManifest({
        manifestPath: explicitManifest,
        ffmpegPath: explicitFfmpeg,
        ffprobePath: explicitFfprobe,
        platform,
        arch,
        verifyLegalFileChecksums: true,
      })
      if (!verification.valid || !verification.manifest) return unavailable(verification.issues)
      const receiptCandidate = configuredReceipt
        ?? join(dirname(explicitManifest), 'VERIFICATION_RECEIPT.json')
      const shouldVerifyReceipt = !isBuildVerification && (
        requireVerificationReceipt
        || configuredReceipt !== null
        || existsSync(receiptCandidate)
      )
      if (shouldVerifyReceipt) {
        const receiptVerification = verifyFfmpegDistributionReceipt({
          receiptPath: receiptCandidate,
          manifestPath: explicitManifest,
          manifest: verification.manifest,
        })
        if (!receiptVerification.valid) return unavailable(receiptVerification.issues)
      }
      return {
        ffmpegPath: explicitFfmpeg,
        ffprobePath: explicitFfprobe,
        source: 'explicit-audited',
        releaseEligible: true,
        manifestPath: explicitManifest,
        verificationReceiptPath: shouldVerifyReceipt ? receiptCandidate : null,
        audit: runtimeAuditSummary({
          source: 'explicit-audited',
          manifestPath: explicitManifest,
          manifest: verification.manifest,
          receiptPath: shouldVerifyReceipt ? receiptCandidate : null,
        }),
        issues: [],
      }
    }
    if (releaseMode) return unavailable(['release mode requires MANJU_FFMPEG_MANIFEST'])
    if (!existsSync(explicitFfmpeg) || !existsSync(explicitFfprobe)) {
      return unavailable(['explicit FFmpeg or ffprobe path does not exist'])
    }
    return {
      ffmpegPath: explicitFfmpeg,
      ffprobePath: explicitFfprobe,
      source: 'explicit-development',
      releaseEligible: false,
      manifestPath: null,
      verificationReceiptPath: null,
      audit: null,
      issues: ['explicit development binaries have not passed the distribution audit'],
    }
  }

  const bundleDirectory = environment.MANJU_FFMPEG_BUNDLE_DIR?.trim()
    ? resolve(cwd, environment.MANJU_FFMPEG_BUNDLE_DIR)
    : join(cwd, 'third_party', 'ffmpeg', 'bundled', `${platform}-${arch}`)
  const bundledFfmpeg = join(bundleDirectory, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const bundledFfprobe = join(bundleDirectory, platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  const bundledManifest = join(bundleDirectory, 'FFMPEG_DISTRIBUTION.json')
  const bundledReceipt = configuredReceipt ?? join(bundleDirectory, 'VERIFICATION_RECEIPT.json')
  if (existsSync(bundledManifest) || existsSync(bundledFfmpeg) || existsSync(bundledFfprobe)) {
    if (configuredReceipt && !isAbsolute(configuredReceipt)) {
      return unavailable(['MANJU_FFMPEG_RECEIPT must be absolute'])
    }
    const verification = verifyFfmpegDistributionManifest({
      manifestPath: bundledManifest,
      ffmpegPath: bundledFfmpeg,
      ffprobePath: bundledFfprobe,
      platform,
      arch,
      verifyLegalFileChecksums: true,
    })
    if (!verification.valid || !verification.manifest) return unavailable(verification.issues)
    const shouldVerifyReceipt = !isBuildVerification && (
      requireVerificationReceipt
      || configuredReceipt !== null
      || existsSync(bundledReceipt)
    )
    if (shouldVerifyReceipt) {
      const receiptVerification = verifyFfmpegDistributionReceipt({
        receiptPath: bundledReceipt,
        manifestPath: bundledManifest,
        manifest: verification.manifest,
      })
      if (!receiptVerification.valid) return unavailable(receiptVerification.issues)
    }
    return {
      ffmpegPath: bundledFfmpeg,
      ffprobePath: bundledFfprobe,
      source: 'bundled-audited',
      releaseEligible: true,
      manifestPath: bundledManifest,
      verificationReceiptPath: shouldVerifyReceipt ? bundledReceipt : null,
      audit: runtimeAuditSummary({
        source: 'bundled-audited',
        manifestPath: bundledManifest,
        manifest: verification.manifest,
        receiptPath: shouldVerifyReceipt ? bundledReceipt : null,
      }),
      issues: [],
    }
  }

  if (releaseMode) {
    return unavailable(['release mode has no audited FFmpeg bundle or explicit audited binary pair'])
  }
  const ffmpegPath = packageFfmpegPath(requireModule)
  const ffprobePath = packageFfprobePath(requireModule)
  if (!ffmpegPath || !ffprobePath) return unavailable(['development FFmpeg locator packages are unavailable'])
  return {
    ffmpegPath,
    ffprobePath,
    source: 'ffmpeg-static-development',
    releaseEligible: false,
    manifestPath: null,
    verificationReceiptPath: null,
    audit: null,
    issues: ['ffmpeg-static is a development-only fallback and must not enter a release package'],
  }
}

export function resolveRuntimeFfmpegPath(): string | null {
  return defaultRuntimeResolution().ffmpegPath
}

export function resolveRuntimeFfprobePath(): string | null {
  return defaultRuntimeResolution().ffprobePath
}

export function resolveRuntimeFfmpegAuditSummary(): FfmpegRuntimeAuditSummary | null {
  return defaultRuntimeResolution().audit
}

export function resolveRuntimeFfmpegDiagnosticReceipt(): FfmpegRuntimeDiagnosticReceipt {
  const resolution = defaultRuntimeResolution()
  return {
    schemaVersion: 1,
    source: resolution.source,
    releaseEligible: resolution.releaseEligible,
    audit: resolution.audit,
  }
}

export function assertFfmpegReleaseRuntime(): FfmpegRuntimeResolution {
  const resolution = defaultRuntimeResolution()
  if (!resolution.releaseEligible || !resolution.verificationReceiptPath || !resolution.audit) {
    const details = resolution.issues.length > 0
      ? resolution.issues.join('; ')
      : 'audited runtime or verified build receipt is unavailable'
    throw new Error(`FFmpeg release runtime gate is closed: ${details}`)
  }
  return resolution
}

let cachedDefaultRuntimeResolution: FfmpegRuntimeResolution | null = null

function defaultRuntimeResolution(): FfmpegRuntimeResolution {
  cachedDefaultRuntimeResolution ??= resolveFfmpegRuntime()
  return cachedDefaultRuntimeResolution
}
