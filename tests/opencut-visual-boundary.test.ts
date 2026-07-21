import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

async function moduleSpecifiers(path: string): Promise<string[]> {
  const values: string[] = []
  await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    logLevel: 'silent',
    platform: 'browser',
    format: 'esm',
    plugins: [{
      name: 'capture-import-specifiers',
      setup(context) {
        context.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === 'entry-point') return undefined
          values.push(args.path)
          return { path: args.path, external: true }
        })
      },
    }],
  })
  return values
}

test('Manju visual source reaches OpenCut only through the UI-neutral workspace boundary', async () => {
  const files = sourceFiles(join(root, 'src'))
  const imports = await Promise.all(files.map(moduleSpecifiers))
  const violations = files.flatMap((path, index) => (
    imports[index]
      .filter((specifier) => (
        specifier.includes('third_party/OpenCut')
        || specifier.toLowerCase().includes('opencut-classic')
        || (
          !specifier.startsWith('.')
          && !specifier.startsWith('/')
          && specifier.toLowerCase().includes('opencut')
          && specifier !== '@manju/opencut-editor'
        )
      ))
      .map((specifier) => `${relative(root, path)} -> ${specifier}`)
  ))

  assert.deepEqual(violations, [], [
    'Manju React/CSS must remain product-owned.',
    'Import OpenCut behavior only from @manju/opencut-editor public contracts.',
  ].join(' '))
})

test('the OpenCut boundary stays UI-neutral and does not import React, Next, or styles', async () => {
  const boundaryRoot = join(root, 'apps', 'opencut-editor', 'src')
  const files = sourceFiles(boundaryRoot)
  const imports = await Promise.all(files.map(moduleSpecifiers))
  const violations = files.flatMap((path, index) => (
    imports[index]
      .filter((specifier) => (
        specifier === 'react'
        || specifier.startsWith('react/')
        || specifier === 'next'
        || specifier.startsWith('next/')
        || /\.(?:css|scss|sass|less)$/.test(specifier)
      ))
      .map((specifier) => `${relative(root, path)} -> ${specifier}`)
  ))

  assert.deepEqual(violations, [], [
    'OpenCut adapter may expose controller/command/document behavior only.',
    'Upstream page components and styling belong outside this boundary.',
  ].join(' '))
})
