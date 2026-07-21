import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

test('release build archives pinned OpenCut and dependency licenses with verified checksums', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-release-licenses-'))
  const output = join(directory, 'legal', 'OpenCut-Classic')
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/archive-opencut-licenses.mjs', output],
      { cwd: resolve('.'), encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const manifest = JSON.parse(await readFile(join(output, 'LEGAL_MANIFEST.json'), 'utf8')) as {
      schemaVersion: number
      component: string
      upstreamRepository: string
      upstreamCommit: string
      license: string
      dependencies: Array<{
        name: string
        version: string
        license: string
        licenseFile: string
        licenseSha256: string
      }>
      archivedFiles: Array<{ path: string; bytes: number; sha256: string }>
    }
    assert.deepEqual({
      schemaVersion: manifest.schemaVersion,
      component: manifest.component,
      upstreamRepository: manifest.upstreamRepository,
      upstreamCommit: manifest.upstreamCommit,
      license: manifest.license,
    }, {
      schemaVersion: 1,
      component: 'OpenCut-Classic',
      upstreamRepository: 'https://github.com/OpenCut-app/OpenCut-Classic.git',
      upstreamCommit: 'cf5e79e919144200294fb9fed22a222592a0aeea',
      license: 'MIT',
    })
    assert.deepEqual(
      manifest.dependencies.map(({ name, version, license }) => ({ name, version, license })),
      [
        { name: 'mediabunny', version: '1.29.1', license: 'MPL-2.0' },
        { name: 'culori', version: '4.0.2', license: 'MIT' },
      ],
    )
    assert.deepEqual(
      new Set(manifest.archivedFiles.map((item) => item.path)),
      new Set([
        'LICENSE',
        'THIRD_PARTY_NOTICES.md',
        'UPSTREAM_COMMIT',
        'UPSTREAM_SOURCES.json',
        'dependencies/mediabunny-LICENSE',
        'dependencies/culori-LICENSE',
      ]),
    )
    for (const item of manifest.archivedFiles) {
      const path = join(output, item.path)
      const info = await stat(path)
      assert.equal(info.isFile(), true)
      assert.equal(info.isSymbolicLink(), false)
      const bytes = await readFile(path)
      assert.equal(bytes.length, item.bytes)
      assert.equal(sha256(bytes), item.sha256)
    }
    for (const dependency of manifest.dependencies) {
      const bytes = await readFile(join(output, dependency.licenseFile))
      assert.equal(sha256(bytes), dependency.licenseSha256)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

