import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REQUIRED_FFMPEG_CAPABILITIES,
  REQUIRED_FFMPEG_SMOKE_CHECKS,
  resolveFfmpegRuntime,
  verifyFfmpegDistributionManifest,
  type FfmpegDistributionManifest,
  type FfmpegDistributionVerificationReceipt,
} from '../server/ffmpeg-runtime.js'

interface CommandOutput {
  readonly stdout: string
  readonly stderr: string
}

export interface FfmpegBinaryInspection {
  readonly ffmpegSha256: string
  readonly ffprobeSha256: string
  readonly ffmpegVersionLine: string
  readonly ffprobeVersionLine: string
  readonly ffmpegConfiguration: string
  readonly ffprobeConfiguration: string
  readonly capabilities: {
    readonly encoders: readonly string[]
    readonly decoders: readonly string[]
    readonly filters: readonly string[]
    readonly demuxers: readonly string[]
    readonly muxers: readonly string[]
  }
  readonly issues: readonly string[]
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function command(path: string, args: readonly string[], cwd?: string): CommandOutput {
  try {
    const stdout = execFileSync(path, [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '' }
  } catch (error) {
    if (error && typeof error === 'object') {
      const stdout = 'stdout' in error ? String(error.stdout ?? '') : ''
      const stderr = 'stderr' in error ? String(error.stderr ?? '') : ''
      const message = 'message' in error ? String(error.message) : 'command failed'
      throw new Error(`${path} ${args.join(' ')} failed: ${message}\n${stdout}\n${stderr}`)
    }
    throw error
  }
}

function firstLine(output: string, prefix: string): string {
  const line = output.split(/\r?\n/).find((item) => item.startsWith(prefix))
  if (!line) throw new Error(`missing ${prefix.trim()} line`)
  return line.trim()
}

function configurationLine(output: string): string {
  const line = output.split(/\r?\n/).find((item) => item.startsWith('configuration:'))
  if (!line) throw new Error('missing FFmpeg configuration line')
  return line.slice('configuration:'.length).trim()
}

function parseSixFlagList(output: string): string[] {
  const values = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[A-Z.]{6}\s+(\S+)/)
    if (match) values.add(match[1]!)
  }
  return [...values].sort()
}

function parseFilterList(output: string): string[] {
  const values = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[TSC.]{3}\s+(\S+)/)
    if (match) values.add(match[1]!)
  }
  return [...values].sort()
}

function parseFormatList(output: string, mode: 'demuxer' | 'muxer'): string[] {
  const values = new Set<string>()
  const matcher = mode === 'demuxer'
    ? /^\s*D\s+([a-zA-Z0-9_,]+)/
    : /^\s*E\s+([a-zA-Z0-9_,]+)/
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(matcher)
    if (!match) continue
    for (const value of match[1]!.split(',')) values.add(value)
  }
  return [...values].sort()
}

function listMissing(
  actual: FfmpegBinaryInspection['capabilities'],
): string[] {
  const missing: string[] = []
  for (const [group, required] of Object.entries(REQUIRED_FFMPEG_CAPABILITIES)) {
    const available = new Set(actual[group as keyof typeof actual])
    for (const name of required) {
      if (!available.has(name)) missing.push(`${group}:${name}`)
    }
  }
  return missing
}

export function inspectFfmpegBinaryPair(
  ffmpegPath: string,
  ffprobePath: string,
): FfmpegBinaryInspection {
  const ffmpegVersion = command(ffmpegPath, ['-hide_banner', '-version']).stdout
  const ffprobeVersion = command(ffprobePath, ['-hide_banner', '-version']).stdout
  const capabilities = {
    encoders: parseSixFlagList(command(ffmpegPath, ['-hide_banner', '-encoders']).stdout),
    decoders: parseSixFlagList(command(ffmpegPath, ['-hide_banner', '-decoders']).stdout),
    filters: parseFilterList(command(ffmpegPath, ['-hide_banner', '-filters']).stdout),
    demuxers: parseFormatList(command(ffmpegPath, ['-hide_banner', '-demuxers']).stdout, 'demuxer'),
    muxers: parseFormatList(command(ffmpegPath, ['-hide_banner', '-muxers']).stdout, 'muxer'),
  }
  const ffmpegConfiguration = configurationLine(ffmpegVersion)
  const ffprobeConfiguration = configurationLine(ffprobeVersion)
  const issues: string[] = []
  if (/(?:^|\s)--enable-nonfree(?:\s|$)/.test(ffmpegConfiguration)) {
    issues.push('FFmpeg configuration contains --enable-nonfree')
  }
  if (/(?:^|\s)--enable-nonfree(?:\s|$)/.test(ffprobeConfiguration)) {
    issues.push('ffprobe configuration contains --enable-nonfree')
  }
  const missing = listMissing(capabilities)
  if (missing.length > 0) issues.push(`required capabilities are missing: ${missing.join(', ')}`)
  return {
    ffmpegSha256: sha256File(ffmpegPath),
    ffprobeSha256: sha256File(ffprobePath),
    ffmpegVersionLine: firstLine(ffmpegVersion, 'ffmpeg version '),
    ffprobeVersionLine: firstLine(ffprobeVersion, 'ffprobe version '),
    ffmpegConfiguration,
    ffprobeConfiguration,
    capabilities,
    issues,
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function verifyInspectionAgainstManifest(
  inspection: FfmpegBinaryInspection,
  manifest: FfmpegDistributionManifest,
): string[] {
  const issues = [...inspection.issues]
  if (inspection.ffmpegSha256 !== manifest.binaries.ffmpeg.sha256) issues.push('live FFmpeg SHA-256 differs from manifest')
  if (inspection.ffprobeSha256 !== manifest.binaries.ffprobe.sha256) issues.push('live ffprobe SHA-256 differs from manifest')
  if (inspection.ffmpegVersionLine !== manifest.binaries.ffmpeg.versionLine) issues.push('live FFmpeg version line differs from manifest')
  if (inspection.ffprobeVersionLine !== manifest.binaries.ffprobe.versionLine) issues.push('live ffprobe version line differs from manifest')
  if (inspection.ffmpegConfiguration !== manifest.binaries.ffmpeg.configuration) issues.push('live FFmpeg configuration differs from manifest')
  if (inspection.ffprobeConfiguration !== manifest.binaries.ffprobe.configuration) issues.push('live ffprobe configuration differs from manifest')
  const version = escapeRegex(manifest.source.version)
  if (!new RegExp(`^ffmpeg version (?:n)?${version}(?:\\s|$)`).test(inspection.ffmpegVersionLine)) {
    issues.push('FFmpeg binary version does not match the declared source version')
  }
  if (!new RegExp(`^ffprobe version (?:n)?${version}(?:\\s|$)`).test(inspection.ffprobeVersionLine)) {
    issues.push('ffprobe binary version does not match the declared source version')
  }
  for (const [group, declared] of Object.entries(manifest.capabilities)) {
    const actual = new Set(inspection.capabilities[group as keyof typeof inspection.capabilities])
    const falseClaims = declared.filter((name) => !actual.has(name))
    if (falseClaims.length > 0) issues.push(`manifest falsely claims ${group}: ${falseClaims.join(', ')}`)
  }
  return issues
}

export function runFfmpegCapabilitySmokeChecks(ffmpegPath: string, ffprobePath: string): string[] {
  const directory = mkdtempSync(resolve(tmpdir(), 'manju-ffmpeg-release-'))
  const output = resolve(directory, 'fixture.mp4')
  const assPath = resolve(directory, 'fixture.ass')
  const pngPath = resolve(directory, 'fixture.png')
  try {
    writeFileSync(assPath, [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 64',
      'PlayResY: 64',
      '',
      '[V4+ Styles]',
      'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
      'Style: Default,Arial,10,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,4,4,4,1',
      '',
      '[Events]',
      'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
      'Dialogue: 0,0:00:00.00,0:00:00.20,Default,,0,0,0,,Manju',
      '',
    ].join('\n'))
    command(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24:d=0.25',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000:d=0.25',
      '-filter_complex', [
        "[0:v]scale=64:64,pad=64:64:0:0,setsar=1,fps=24,trim=end_frame=6,setpts=PTS-STARTPTS,format=gbrp,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)',fade=t=in:st=0:d=0.04,format=yuv420p,ass=filename='fixture.ass'[v]",
        '[1:a]atrim=end=0.25,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:st=0:d=0.04,volume=1,adelay=0S:all=1,apad,atrim=end=0.25,asetpts=PTS-STARTPTS[a]',
      ].join(';'),
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-movflags', '+faststart',
      '-f', 'mp4', output,
    ], directory)
    command(ffprobePath, [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', output,
    ], directory)
    command(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', output,
      '-map', '0:v:0', '-an', '-vf', 'blackdetect=d=0.1:pix_th=0.1:pic_th=0.9',
      '-f', 'null', '-',
    ], directory)
    command(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', output,
      '-map', '0:a:0', '-vn', '-af', 'silencedetect=noise=-48dB:d=0.1,volumedetect',
      '-f', 'null', '-',
    ], directory)
    command(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'color=c=white:s=64x64:d=0.1',
      '-vf', 'crop=32:32:0:0', '-frames:v', '1', '-c:v', 'png', '-f', 'image2', pngPath,
    ], directory)
    return [...REQUIRED_FFMPEG_SMOKE_CHECKS]
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function verifyFfmpegRelease(input: {
  readonly manifestPath: string
  readonly ffmpegPath: string
  readonly ffprobePath: string
  readonly platform?: string
  readonly arch?: string
  readonly smoke?: boolean
}): FfmpegDistributionVerificationReceipt {
  const staticVerification = verifyFfmpegDistributionManifest(input)
  if (!staticVerification.valid || !staticVerification.manifest) {
    throw new Error(`FFmpeg distribution manifest rejected:\n- ${staticVerification.issues.join('\n- ')}`)
  }
  const inspection = inspectFfmpegBinaryPair(input.ffmpegPath, input.ffprobePath)
  const issues = verifyInspectionAgainstManifest(inspection, staticVerification.manifest)
  if (issues.length > 0) throw new Error(`FFmpeg binary audit rejected:\n- ${issues.join('\n- ')}`)
  const smokeChecks = input.smoke === false
    ? []
    : runFfmpegCapabilitySmokeChecks(input.ffmpegPath, input.ffprobePath)
  return {
    schemaVersion: 1,
    status: 'verified',
    manifestSha256: sha256File(input.manifestPath),
    target: staticVerification.manifest.target,
    source: staticVerification.manifest.source,
    licenseExpression: staticVerification.manifest.license.expression,
    ffmpegSha256: inspection.ffmpegSha256,
    ffprobeSha256: inspection.ffprobeSha256,
    ffmpegVersionLine: inspection.ffmpegVersionLine,
    ffprobeVersionLine: inspection.ffprobeVersionLine,
    ffmpegConfiguration: inspection.ffmpegConfiguration,
    ffprobeConfiguration: inspection.ffprobeConfiguration,
    requiredCapabilities: REQUIRED_FFMPEG_CAPABILITIES,
    smokeChecks,
  }
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return resolve(value)
}

function runCli(): void {
  const environment = process.argv.includes('--release')
    ? { ...process.env, MANJU_FFMPEG_RELEASE_MODE: '1' }
    : process.env
  const resolution = resolveFfmpegRuntime({
    environment,
    // This command creates the receipt only after live inspection and smoke;
    // normal release runtime resolution never receives this exemption.
    requireVerificationReceipt: false,
  })
  const ffmpegPath = argument('--ffmpeg') ?? resolution.ffmpegPath
  const ffprobePath = argument('--ffprobe') ?? resolution.ffprobePath
  const manifestPath = argument('--manifest') ?? resolution.manifestPath
  const receiptPath = argument('--receipt')
  if (!ffmpegPath || !ffprobePath || !manifestPath || !resolution.releaseEligible) {
    const details = resolution.issues.length === 0 ? 'no audited runtime binary pair' : resolution.issues.join('; ')
    throw new Error(`FFmpeg release gate is closed: ${details}`)
  }
  const receipt = verifyFfmpegRelease({
    manifestPath,
    ffmpegPath,
    ffprobePath,
    smoke: true,
  })
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`
  if (receiptPath) {
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o755 })
    writeFileSync(receiptPath, serialized, { mode: 0o644 })
  }
  process.stdout.write(serialized)
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  try {
    runCli()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
