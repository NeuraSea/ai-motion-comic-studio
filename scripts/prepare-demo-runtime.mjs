#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRuntime = resolve(process.env.MANJU_DEMO_SOURCE_RUNTIME || resolve(rootDir, 'runtime'))
const targetRuntime = resolve(process.env.MANJU_DEMO_RUNTIME_DIR || resolve(rootDir, 'runtime/demo'))

function assertSafeTarget() {
  const expectedParent = `${resolve(rootDir, 'runtime')}/`
  if (!targetRuntime.startsWith(expectedParent) || targetRuntime === sourceRuntime) {
    throw new Error('Demo runtime target must be an isolated directory inside runtime/')
  }
}

function copyDirectory(source, target) {
  if (!existsSync(source)) return
  try {
    // macOS/APFS clone-on-write avoids duplicating hundreds of megabytes while
    // preserving regular-file boundaries required by MediaStore.
    execFileSync('cp', ['-cR', source, target], { stdio: 'pipe' })
  } catch {
    cpSync(source, target, { recursive: true, errorOnExist: true })
  }
}

export function prepareDemoRuntime() {
  assertSafeTarget()
  const sourceDatabase = resolve(sourceRuntime, 'manju.sqlite')
  if (!existsSync(sourceDatabase) || !statSync(sourceDatabase).isFile()) {
    throw new Error(`Source database does not exist: ${sourceDatabase}`)
  }

  rmSync(targetRuntime, { recursive: true, force: true })
  mkdirSync(targetRuntime, { recursive: true, mode: 0o700 })

  const targetDatabase = resolve(targetRuntime, 'manju.sqlite')
  execFileSync('sqlite3', [sourceDatabase, `.backup '${targetDatabase.replaceAll("'", "''")}'`], {
    stdio: 'pipe',
  })
  copyDirectory(resolve(sourceRuntime, 'media'), resolve(targetRuntime, 'media'))
  copyDirectory(resolve(sourceRuntime, 'generated'), resolve(targetRuntime, 'generated'))

  const manifest = {
    version: 1,
    sourceRuntime,
    targetRuntime,
    sourceDatabaseBytes: statSync(sourceDatabase).size,
    databaseBytes: statSync(targetDatabase).size,
    preparedAt: new Date().toISOString(),
    providerExecution: process.env.MANJU_DEMO_ALLOW_PROVIDER_EXECUTION === '1'
      ? 'enabled-with-locked-configuration'
      : 'disabled-by-MANJU_DEMO_MODE',
  }
  const temporary = resolve(targetRuntime, `.demo-runtime.${process.pid}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, resolve(targetRuntime, 'demo-runtime.json'))
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(prepareDemoRuntime())}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
