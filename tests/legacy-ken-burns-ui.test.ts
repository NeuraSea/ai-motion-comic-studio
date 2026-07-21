import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const pipelinePath = new URL(
  '../src/features/pipeline/OneClickProductionPanel.tsx',
  import.meta.url,
)

async function inspectNewRequestBoundary(path: URL): Promise<{
  source: string
  falseAssignments: number
  shorthandAssignments: number
}> {
  const source = await readFile(path, 'utf8')
  const falseAssignments = source.match(/\bkenBurns\s*:\s*false\b/g)?.length ?? 0
  const shorthandAssignments = source.match(/^\s*kenBurns\s*,\s*$/gm)?.length ?? 0
  return { source, falseAssignments, shorthandAssignments }
}

test('new export and one-click production UI cannot enable the retired global Ken Burns layer', async () => {
  for (const path of [appPath, pipelinePath]) {
    const inspected = await inspectNewRequestBoundary(path)
    assert.equal(inspected.falseAssignments, 1)
    assert.equal(inspected.shorthandAssignments, 0)
    assert.match(inspected.source, /镜头运动来自 OpenCut 时间线/)
    assert.doesNotMatch(inspected.source, /启用轻微推拉动效|镜头轻微推拉/)
    assert.doesNotMatch(inspected.source, /setKenBurns/)
  }
})
