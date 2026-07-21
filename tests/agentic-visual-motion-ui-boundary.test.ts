import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const timelinePath = new URL('../src/features/editor/OpenCutTimeline.tsx', import.meta.url)

function functionSlice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing boundary: ${start}`)
  assert.ok(endIndex > startIndex, `missing boundary: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('Agentic motion preview is read-only and apply is one revision-bound OpenCut command', async () => {
  const source = await readFile(timelinePath, 'utf8')
  const preview = functionSlice(
    source,
    'const requestAgenticMotionPreview',
    'const applyAgenticMotionPlan',
  )
  const apply = functionSlice(
    source,
    'const applyAgenticMotionPlan',
    'const dragView',
  )

  assert.match(preview, /planAgenticVisualMotion\(commandEditor\.getTracks\(\), shots\)/)
  assert.doesNotMatch(
    preview,
    /commitElement|addElement|deleteElements|splitElements|storage\.(?:save|flush)|setTracks/,
  )

  assert.equal(apply.match(/commitElementPropertyUpdates\(/g)?.length, 1)
  assert.match(apply, /agenticMotionApplyRef\.current/)
  assert.match(apply, /clearAgenticMotionPreview\(\)[\s\S]*commitElementPropertyUpdates/)
  assert.match(apply, /storage\?\.getState\(\)/)
  assert.match(apply, /currentRevisionId !== preview\.baseRevisionId/)
  assert.match(apply, /etag !== preview\.baseEtag/)
  assert.match(apply, /updatesForAgenticVisualMotion\(commandEditor\.getTracks\(\), preview\.plan\)/)
  assert.match(apply, /refreshCommandState\([\s\S]*Agentic 应用/)
})

test('every OpenCut or SQLite revision invalidates the motion preview and saves are storage-scoped', async () => {
  const source = await readFile(timelinePath, 'utf8')
  const refresh = functionSlice(
    source,
    'const refreshCommandState',
    'const elementInteractionConfig',
  )
  const adoptAutomatic = functionSlice(
    source,
    'const adoptAutomaticEditSnapshot',
    'const requestAutomaticEditPreview',
  )

  assert.match(refresh, /clearAgenticMotionPreview\(\)/)
  assert.equal(refresh.match(/\.save\(/g)?.length, 1)
  assert.match(refresh, /manualTimelineDocument\(nextTracks\)/)
  assert.match(source, /storageState\.currentRevisionId[\s\S]*storageState\.etag/)
  assert.match(source, /liveStorage\.currentRevisionId !== preview\.baseRevisionId/)
  assert.match(source, /liveStorage\.etag !== preview\.baseEtag/)
  assert.match(adoptAutomatic, /clearAgenticMotionPreview\(\)/)
  assert.match(source, /storageRef\.current !== ownerStorage/)
  assert.match(source, /onClick=\{clearAgenticMotionPreview\}>放弃预览/)
})

test('motion apply remains one undoable command while conflicting edit modes stay mutually exclusive', async () => {
  const source = await readFile(timelinePath, 'utf8')
  const undo = functionSlice(source, 'const undo =', 'const redo =')

  assert.equal(undo.match(/commandEditor\.undo\(\)/g)?.length, 1)
  assert.match(undo, /refreshCommandState\('已撤销 OpenCut 命令', '撤销时间线操作'\)/)
  assert.match(source, /disabled=\{!canMutateTimeline \|\| agenticMotionPlan !== null\}/)
  assert.match(source, /automaticEditPreview !== null \|\| agenticMotionPlan !== null/)
  assert.match(source, /disabled=\{!canMutateTimeline \|\| !commandEditor\.canUndo\(\)\}/)
})
