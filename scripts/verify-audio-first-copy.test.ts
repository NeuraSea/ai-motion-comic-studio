import assert from 'node:assert/strict'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  guardIsolatedDatabaseCopy,
  requireSpokenShotCount,
  revalidateGuardedDatabaseCopy,
} from './verify-audio-first-copy-safety.js'

function fixture(): {
  root: string
  productionPath: string
  isolatedPath: string
} {
  const root = mkdtempSync(join(tmpdir(), 'manju-audio-first-verifier-'))
  const runtime = join(root, 'runtime')
  mkdirSync(runtime)
  const productionPath = join(runtime, 'manju.sqlite')
  const isolatedPath = join(root, 'isolated.sqlite')
  writeFileSync(productionPath, 'production-sentinel')
  writeFileSync(isolatedPath, 'isolated-sentinel')
  return { root, productionPath, isolatedPath }
}

test('copy guard accepts and revalidates only an existing independent regular file', () => {
  const value = fixture()
  try {
    const guarded = guardIsolatedDatabaseCopy(value.isolatedPath, {
      productionPath: value.productionPath,
    })
    assert.equal(guarded.realPath, realpathSync.native(value.isolatedPath))
    revalidateGuardedDatabaseCopy(guarded, { productionPath: value.productionPath })

    const missing = join(value.root, 'must-not-be-created.sqlite')
    assert.throws(
      () => guardIsolatedDatabaseCopy(missing, { productionPath: value.productionPath }),
      /must already exist/,
    )
  } finally {
    rmSync(value.root, { recursive: true, force: true })
  }
})

test('copy guard rejects direct, lexical, realpath/symlink, and device-inode aliases', () => {
  const value = fixture()
  try {
    assert.throws(
      () => guardIsolatedDatabaseCopy(value.productionPath, {
        productionPath: value.productionPath,
      }),
      /refusing to open runtime\/manju\.sqlite/,
    )
    assert.throws(
      () => guardIsolatedDatabaseCopy(join(value.root, 'runtime', '..', 'runtime', 'manju.sqlite'), {
        productionPath: value.productionPath,
      }),
      /refusing to open runtime\/manju\.sqlite/,
    )

    const finalSymlink = join(value.root, 'live-symlink.sqlite')
    symlinkSync(value.productionPath, finalSymlink)
    assert.throws(
      () => guardIsolatedDatabaseCopy(finalSymlink, { productionPath: value.productionPath }),
      /must not be a symbolic link/,
    )

    const directorySymlink = join(value.root, 'runtime-alias')
    symlinkSync(join(value.root, 'runtime'), directorySymlink, 'dir')
    assert.throws(
      () => guardIsolatedDatabaseCopy(join(directorySymlink, 'manju.sqlite'), {
        productionPath: value.productionPath,
      }),
      /realpath\/device\/inode alias/,
    )

    const hardlink = join(value.root, 'live-hardlink.sqlite')
    linkSync(value.productionPath, hardlink)
    assert.throws(
      () => guardIsolatedDatabaseCopy(hardlink, { productionPath: value.productionPath }),
      /realpath\/device\/inode alias/,
    )
  } finally {
    rmSync(value.root, { recursive: true, force: true })
  }
})

test('revalidation rejects a path replaced after the initial check', () => {
  const value = fixture()
  try {
    const guarded = guardIsolatedDatabaseCopy(value.isolatedPath, {
      productionPath: value.productionPath,
    })
    unlinkSync(value.isolatedPath)
    writeFileSync(value.isolatedPath, 'replacement')
    assert.throws(
      () => revalidateGuardedDatabaseCopy(guarded, { productionPath: value.productionPath }),
      /changed after the safety check/,
    )
  } finally {
    rmSync(value.root, { recursive: true, force: true })
  }
})

test('spoken-shot cardinality is dynamic and fails explicitly at zero', () => {
  assert.equal(requireSpokenShotCount([
    { dialogueLines: [{}] },
    { dialogueLines: [] },
    { dialogueLines: [{}, {}] },
    { dialogueLines: [{}] },
  ]), 3)
  assert.throws(
    () => requireSpokenShotCount([{ dialogueLines: [] }, { dialogueLines: [] }]),
    /at least 1 spoken Story shot; got 0/,
  )
})
