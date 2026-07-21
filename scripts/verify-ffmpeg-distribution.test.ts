import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ffmpegStaticPath from 'ffmpeg-static'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'

import { REQUIRED_FFMPEG_CAPABILITIES, type FfmpegDistributionManifest } from '../server/ffmpeg-runtime.js'
import {
  inspectFfmpegBinaryPair,
  runFfmpegCapabilitySmokeChecks,
  verifyFfmpegRelease,
} from './verify-ffmpeg-distribution.js'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function list(flags: string, values: readonly string[]): string {
  return values.map((value) => ` ${flags} ${value} fixture`).join('\\n')
}

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { mode: 0o755 })
  await chmod(path, 0o755)
}

async function fixture(nonfree = false): Promise<{
  root: string
  ffmpegPath: string
  ffprobePath: string
  manifestPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'manju-ffmpeg-verifier-'))
  const ffmpegPath = join(root, 'ffmpeg')
  const ffprobePath = join(root, 'ffprobe')
  const manifestPath = join(root, 'FFMPEG_DISTRIBUTION.json')
  const configuration = `--enable-gpl --enable-version3 --enable-libx264 --enable-libass${nonfree ? ' --enable-nonfree' : ''}`
  const encoders = list('V.....', REQUIRED_FFMPEG_CAPABILITIES.encoders)
  const decoders = list('V.....', REQUIRED_FFMPEG_CAPABILITIES.decoders)
  const filters = list('...', REQUIRED_FFMPEG_CAPABILITIES.filters)
  const demuxers = REQUIRED_FFMPEG_CAPABILITIES.demuxers.map((value) => ` D  ${value} fixture`).join('\\n')
  const muxers = REQUIRED_FFMPEG_CAPABILITIES.muxers.map((value) => `  E ${value} fixture`).join('\\n')
  const ffmpegSource = `#!/bin/sh
case "$2" in
  -version) printf '%s\\n' 'ffmpeg version 8.1.2' 'configuration: ${configuration}' ;;
  -encoders) printf '%b\\n' '${encoders}' ;;
  -decoders) printf '%b\\n' '${decoders}' ;;
  -filters) printf '%b\\n' '${filters}' ;;
  -demuxers) printf '%b\\n' '${demuxers}' ;;
  -muxers) printf '%b\\n' '${muxers}' ;;
  *) exit 2 ;;
esac
`
  const ffprobeSource = `#!/bin/sh
printf '%s\\n' 'ffprobe version 8.1.2' 'configuration: ${configuration}'
`
  await Promise.all([
    executable(ffmpegPath, ffmpegSource),
    executable(ffprobePath, ffprobeSource),
    writeFile(join(root, 'BUILD.md'), 'recipe'),
    writeFile(join(root, 'COPYING.GPLv3'), 'license'),
    writeFile(join(root, 'corresponding-source.tar.xz'), 'source'),
  ])
  const inspection = inspectFfmpegBinaryPair(ffmpegPath, ffprobePath)
  const manifest: FfmpegDistributionManifest = {
    schemaVersion: 1,
    target: { platform: process.platform, arch: process.arch },
    source: {
      project: 'FFmpeg',
      version: '8.1.2',
      archiveUrl: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
      archiveSha256: '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c',
      signatureUrl: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.asc',
      signingKeyFingerprint: 'FCF986EA15E6E293A5644F10B4322F04D67658D8',
    },
    build: { recipe: { path: 'BUILD.md', sha256: sha256('recipe') } },
    license: {
      expression: 'GPL-3.0-or-later',
      noticeFiles: [{ path: 'COPYING.GPLv3', sha256: sha256('license') }],
      correspondingSource: { path: 'corresponding-source.tar.xz', sha256: sha256('source') },
    },
    binaries: {
      ffmpeg: {
        sha256: inspection.ffmpegSha256,
        versionLine: inspection.ffmpegVersionLine,
        configuration: inspection.ffmpegConfiguration,
      },
      ffprobe: {
        sha256: inspection.ffprobeSha256,
        versionLine: inspection.ffprobeVersionLine,
        configuration: inspection.ffprobeConfiguration,
      },
    },
    capabilities: REQUIRED_FFMPEG_CAPABILITIES,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { root, ffmpegPath, ffprobePath, manifestPath }
}

test('release verifier binds live version, configuration, hashes and renderer capabilities', async (context) => {
  const created = await fixture()
  context.after(() => rm(created.root, { recursive: true, force: true }))
  const receipt = verifyFfmpegRelease({
    manifestPath: created.manifestPath,
    ffmpegPath: created.ffmpegPath,
    ffprobePath: created.ffprobePath,
    smoke: false,
  })
  assert.equal(receipt.status, 'verified')
  assert.equal(receipt.source.version, '8.1.2')
  assert.match(receipt.ffmpegConfiguration, /--enable-libx264/)
  assert.equal(receipt.smokeChecks.length, 0)
})

test('live --enable-nonfree is rejected even if a manifest records the same bytes', async (context) => {
  const created = await fixture(true)
  context.after(() => rm(created.root, { recursive: true, force: true }))
  assert.throws(() => verifyFfmpegRelease({
    manifestPath: created.manifestPath,
    ffmpegPath: created.ffmpegPath,
    ffprobePath: created.ffprobePath,
    smoke: false,
  }), /--enable-nonfree/)
})

test('live configuration drift after manifest creation is rejected', async (context) => {
  const created = await fixture()
  context.after(() => rm(created.root, { recursive: true, force: true }))
  const source = await (await import('node:fs/promises')).readFile(created.ffmpegPath, 'utf8')
  await executable(created.ffmpegPath, source.replace('--enable-libass', '--disable-libass'))
  assert.throws(() => verifyFfmpegRelease({
    manifestPath: created.manifestPath,
    ffmpegPath: created.ffmpegPath,
    ffprobePath: created.ffprobePath,
    smoke: false,
  }), /checksum|configuration|capabilities/)
})

const localBinariesAvailable = typeof ffmpegStaticPath === 'string'
  && existsSync(ffmpegStaticPath)
  && typeof ffprobeInstaller.path === 'string'
  && existsSync(ffprobeInstaller.path)

test('capability smoke executes the production encode, subtitle, QC and crop primitives', {
  skip: localBinariesAvailable ? false : 'local FFmpeg development binaries are unavailable',
}, () => {
  if (typeof ffmpegStaticPath !== 'string') assert.fail('ffmpeg-static path unavailable')
  const checks = runFfmpegCapabilitySmokeChecks(ffmpegStaticPath, ffprobeInstaller.path)
  assert.deepEqual(checks, [
    'libx264+aac-mp4-encode',
    'ffprobe-json-probe',
    'libass-subtitle-render',
    'shape-filter-geq',
    'qc-blackdetect',
    'qc-silencedetect-volumedetect',
    'png-crop-encode',
  ])
})
