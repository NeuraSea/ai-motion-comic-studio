import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  canonicalTimelineDocumentFromTracks,
  createOpenCutCommandEditor,
  parseCanonicalTimelineDocument,
  serializeCanonicalTimelineDocument,
  type EditorSceneTracks,
  type EditorTimelineElement,
} from '../apps/opencut-editor/src/index.js'
import {
  buildVisualFitParamPatch,
  readVisualFitDraft,
  VisualFitControlError,
} from '../src/features/editor/visual-fit.js'

const timelinePath = new URL('../src/features/editor/OpenCutTimeline.tsx', import.meta.url)

function visual(
  type: 'image' | 'video' = 'image',
  params: Record<string, number | string | boolean> = {},
): EditorTimelineElement {
  return {
    id: 'shot',
    type,
    mediaId: 'asset',
    name: 'shot',
    startTime: 0,
    duration: 120_000,
    trimStart: 0,
    trimEnd: 0,
    ...(type === 'video' ? { sourceDuration: 120_000 } : {}),
    params,
  }
}

function tracks(element = visual()): EditorSceneTracks {
  return {
    overlay: [],
    main: {
      id: 'main', name: 'main', type: 'video', hidden: false, muted: false,
      elements: [element],
    },
    audio: [],
  }
}

function functionSlice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing boundary: ${start}`)
  assert.ok(endIndex > startIndex, `missing boundary: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('fit reader accepts only exact image/video params.fit and defaults missing fit to cover', () => {
  assert.deepEqual(readVisualFitDraft(visual('image')), {
    editable: true,
    draft: { fit: 'cover' },
  })
  assert.deepEqual(readVisualFitDraft(visual('video', { fit: 'contain' })), {
    editable: true,
    draft: { fit: 'contain' },
  })

  const unknown = readVisualFitDraft(visual('image', { fit: 'stretch' }))
  assert.equal(unknown.editable, false)
  assert.match(unknown.editable ? '' : unknown.reason, /cover 或 contain/)
  assert.equal(readVisualFitDraft({
    ...visual('image'),
    params: { fit: undefined } as unknown as Record<string, string>,
  }).editable, false)
  assert.equal(readVisualFitDraft({
    ...visual('image'),
    params: { fit: 'cover', future: { opaque: true } } as unknown as Record<string, string>,
  }).editable, false)
  const accessorParams = Object.defineProperty({}, 'fit', {
    enumerable: true,
    get: () => { throw new Error('fit accessor must not execute') },
  })
  assert.equal(readVisualFitDraft({
    ...visual('image'),
    params: accessorParams as Record<string, string>,
  }).editable, false)
  assert.equal(readVisualFitDraft({
    ...visual('image'),
    manju: { shortVideoFill: { version: 99 } },
  }).editable, false)
  assert.equal(readVisualFitDraft({ ...visual('image'), type: 'audio' }).editable, false)
})

test('fit builder emits a narrow patch and rejects stale or blocked semantics', () => {
  const element = visual('image', {
    fit: 'cover',
    storyShotId: 'shot-1',
    futureLayoutMode: 'opaque-v9',
    futureFlag: true,
  })
  const before = structuredClone(element.params)
  const params = buildVisualFitParamPatch({
    element,
    expectedFit: 'cover',
    fit: 'contain',
  })
  assert.deepEqual(params, { fit: 'contain' })
  assert.deepEqual(element.params, before, 'builder must not mutate caller-owned params')

  assert.deepEqual(buildVisualFitParamPatch({
    element: visual('video', { fit: 'contain', futureLayoutMode: 'keep' }),
    expectedFit: 'contain',
    fit: 'cover',
  }), { fit: 'cover' }, 'cover must be written explicitly instead of clearing fit')

  assert.throws(() => buildVisualFitParamPatch({
    element: visual('image', { fit: 'contain', futureLayoutMode: 'keep' }),
    expectedFit: 'cover',
    fit: 'contain',
  }), (error: unknown) => error instanceof VisualFitControlError
    && error.code === 'CONFLICT')
  assert.throws(() => buildVisualFitParamPatch({
    element: { ...element, manju: { shortVideoFill: { version: 1 } } },
    expectedFit: 'cover',
    fit: 'contain',
  }), (error: unknown) => error instanceof VisualFitControlError
    && error.code === 'UNSUPPORTED')
})

test('one OpenCut property command owns fit undo/redo and canonical save/reload', () => {
  const editor = createOpenCutCommandEditor({
    tracks: tracks(visual('image', {
      fit: 'cover',
      storyShotId: 'shot-1',
      futureLayoutMode: 'opaque-v9',
    })),
  })
  editor.clearHistory()
  const before = editor.getTracks()
  const current = before.main.elements[0]!
  editor.commitElementPropertyUpdates({
    updates: [{
      trackId: 'main',
      elementId: 'shot',
      patch: {
        params: buildVisualFitParamPatch({
          element: current,
          expectedFit: 'cover',
          fit: 'contain',
        }),
      },
    }],
  })
  const updated = editor.getTracks()
  assert.deepEqual(updated.main.elements[0]!.params, {
    fit: 'contain',
    storyShotId: 'shot-1',
    futureLayoutMode: 'opaque-v9',
  })
  assert.equal(editor.canUndo(), true)
  editor.undo()
  assert.deepEqual(editor.getTracks(), before)
  assert.equal(editor.canUndo(), false, 'fit change must be exactly one history command')
  editor.redo()
  assert.deepEqual(editor.getTracks(), updated)

  const saved = serializeCanonicalTimelineDocument(
    canonicalTimelineDocumentFromTracks(editor.getTracks()),
  )
  const reloadedDocument = parseCanonicalTimelineDocument(JSON.parse(saved))
  const reloaded = createOpenCutCommandEditor({
    tracks: structuredClone(reloadedDocument.tracks) as EditorSceneTracks,
  }).getTracks().main.elements[0]!
  assert.deepEqual(readVisualFitDraft(reloaded), {
    editable: true,
    draft: { fit: 'contain' },
  })
  assert.equal(reloaded.params?.futureLayoutMode, 'opaque-v9')
})

test('timeline UI reads through the strict helper and writes fit with one property command', async () => {
  const source = await readFile(timelinePath, 'utf8')
  const apply = functionSlice(source, 'const applyVisualFit =', 'const applyVisualFade =')

  assert.match(source, /readVisualFitDraft\(selectedVisualBinding\.element\)/)
  assert.match(source, /element\.type === 'image' \|\| element\.type === 'video'/)
  assert.equal(apply.match(/commitElementPropertyUpdates\(/g)?.length, 1)
  assert.match(apply, /buildVisualFitParamPatch\(\{[\s\S]*expectedFit:[\s\S]*fit:/)
  assert.match(apply, /patch: \{ params \}/)
  assert.match(apply, /refreshCommandState\(/)
  assert.doesNotMatch(apply, /storage\.(?:save|flush)|api\./)
  assert.match(source, /\['cover', '填满画布（裁切）'\]/)
  assert.match(source, /\['contain', '完整显示（留边）'\]/)
  assert.match(source, /visualFitDraft\.fit === visualFitDraft\.expectedFit/)
})
