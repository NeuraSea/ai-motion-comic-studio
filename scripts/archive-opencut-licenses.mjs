import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const openCutRoot = join(root, 'third_party', 'OpenCut-Classic')
const packageLockPath = join(root, 'package-lock.json')
const pinnedProvenancePath = join(root, 'apps', 'opencut-editor', 'src', 'opencut-pinned-provenance.ts')
const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/

const outputArguments = process.argv.slice(2)
const outputDirectories = outputArguments.length > 0
  ? outputArguments.map((value) => resolve(root, value))
  : [
      join(root, 'dist', 'legal', 'OpenCut-Classic'),
      join(root, 'dist-server', 'legal', 'OpenCut-Classic'),
    ]

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readRegularFile(path, label) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`)
  }
  return readFile(path)
}

function requirePackage(lock, packageName, expectedLicense) {
  const key = `node_modules/${packageName}`
  const item = lock.packages?.[key]
  if (!item || typeof item !== 'object') {
    throw new Error(`package-lock.json does not pin ${packageName}`)
  }
  if (typeof item.version !== 'string' || !item.version.trim()) {
    throw new Error(`package-lock.json does not pin a version for ${packageName}`)
  }
  const packageRoot = join(root, 'node_modules', packageName)
  return {
    name: packageName,
    version: item.version,
    expectedLicense,
    packageRoot,
  }
}

async function prepareArchive() {
  const [commitBytes, sourcesBytes, licenseBytes, noticesBytes, packageLockBytes, provenanceBytes] = await Promise.all([
    readRegularFile(join(openCutRoot, 'UPSTREAM_COMMIT'), 'OpenCut UPSTREAM_COMMIT'),
    readRegularFile(join(openCutRoot, 'UPSTREAM_SOURCES.json'), 'OpenCut UPSTREAM_SOURCES.json'),
    readRegularFile(join(openCutRoot, 'LICENSE'), 'OpenCut LICENSE'),
    readRegularFile(join(openCutRoot, 'THIRD_PARTY_NOTICES.md'), 'OpenCut THIRD_PARTY_NOTICES.md'),
    readRegularFile(packageLockPath, 'package-lock.json'),
    readRegularFile(pinnedProvenancePath, 'OpenCut pinned provenance'),
  ])
  const commit = commitBytes.toString('utf8').trim()
  if (!FULL_GIT_COMMIT.test(commit)) throw new Error('OpenCut UPSTREAM_COMMIT is not a full lowercase git commit')
  const sources = JSON.parse(sourcesBytes.toString('utf8'))
  if (sources?.schemaVersion !== 1
    || sources?.upstream?.repository !== 'https://github.com/OpenCut-app/OpenCut-Classic.git'
    || sources?.upstream?.commit !== commit
    || sources?.upstream?.license !== 'MIT') {
    throw new Error('OpenCut upstream source ledger does not match the pinned MIT provenance')
  }
  if (!provenanceBytes.toString('utf8').includes(`"${commit}"`)) {
    throw new Error('OpenCut runtime boundary commit disagrees with UPSTREAM_COMMIT')
  }
  const lock = JSON.parse(packageLockBytes.toString('utf8'))
  const dependencies = [
    requirePackage(lock, 'mediabunny', 'MPL-2.0'),
    requirePackage(lock, 'culori', 'MIT'),
  ]
  const dependencyFiles = []
  for (const dependency of dependencies) {
    const [manifestBytes, dependencyLicense] = await Promise.all([
      readRegularFile(join(dependency.packageRoot, 'package.json'), `${dependency.name} package.json`),
      readRegularFile(join(dependency.packageRoot, 'LICENSE'), `${dependency.name} LICENSE`),
    ])
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    if (manifest.name !== dependency.name
      || manifest.version !== dependency.version
      || manifest.license !== dependency.expectedLicense) {
      throw new Error(`${dependency.name} installed package disagrees with the locked version/license`)
    }
    dependencyFiles.push({
      name: dependency.name,
      version: dependency.version,
      license: dependency.expectedLicense,
      destination: join('dependencies', `${dependency.name}-LICENSE`),
      bytes: dependencyLicense,
    })
  }
  const files = [
    { destination: 'LICENSE', bytes: licenseBytes },
    { destination: 'THIRD_PARTY_NOTICES.md', bytes: noticesBytes },
    { destination: 'UPSTREAM_COMMIT', bytes: commitBytes },
    { destination: 'UPSTREAM_SOURCES.json', bytes: sourcesBytes },
    ...dependencyFiles.map(({ destination, bytes }) => ({ destination, bytes })),
  ]
  const manifest = {
    schemaVersion: 1,
    component: 'OpenCut-Classic',
    upstreamRepository: sources.upstream.repository,
    upstreamCommit: commit,
    license: 'MIT',
    dependencies: dependencyFiles.map((item) => ({
      name: item.name,
      version: item.version,
      license: item.license,
      licenseFile: item.destination.replaceAll('\\', '/'),
      licenseSha256: sha256(item.bytes),
    })),
    archivedFiles: files.map((item) => ({
      path: item.destination.replaceAll('\\', '/'),
      bytes: item.bytes.length,
      sha256: sha256(item.bytes),
    })),
  }
  return { files, manifest }
}

async function writeArchive(outputDirectory, archive) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o755 })
  for (const item of archive.files) {
    const destination = resolve(outputDirectory, item.destination)
    const relativePath = relative(outputDirectory, destination)
    if (!relativePath || relativePath.startsWith('..') || resolve(outputDirectory, relativePath) !== destination) {
      throw new Error(`Unsafe legal archive destination: ${item.destination}`)
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 })
    await writeFile(destination, item.bytes, { mode: 0o644 })
    await chmod(destination, 0o644)
    const written = await readRegularFile(destination, `archived ${item.destination}`)
    if (sha256(written) !== sha256(item.bytes)) {
      throw new Error(`Archived legal file checksum mismatch: ${item.destination}`)
    }
  }
  const manifestPath = join(outputDirectory, 'LEGAL_MANIFEST.json')
  await writeFile(manifestPath, `${JSON.stringify(archive.manifest, null, 2)}\n`, { mode: 0o644 })
  await chmod(manifestPath, 0o644)
  return manifestPath
}

const archive = await prepareArchive()
for (const directory of outputDirectories) {
  const manifestPath = await writeArchive(directory, archive)
  process.stdout.write(`Archived OpenCut legal materials: ${relative(root, manifestPath)}\n`)
}
