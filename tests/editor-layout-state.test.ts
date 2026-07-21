import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_EDITOR_LAYOUT,
  DEFAULT_INSPECTOR_WIDTH_PX,
  MIN_INSPECTOR_WIDTH_PX,
  MIN_TIMELINE_HEIGHT_PX,
  clampInspectorWidth,
  clampTimelineHeight,
  parseEditorLayoutPreferences,
  serializeEditorLayoutPreferences,
} from '../src/features/editor/editor-layout-state.ts'

test('editor layout preferences fail closed to usable defaults', () => {
  assert.deepEqual(parseEditorLayoutPreferences(null), DEFAULT_EDITOR_LAYOUT)
  assert.deepEqual(parseEditorLayoutPreferences('{broken'), DEFAULT_EDITOR_LAYOUT)
  assert.equal(parseEditorLayoutPreferences('{}').inspectorWidthPx, DEFAULT_INSPECTOR_WIDTH_PX)
})

test('inspector and timeline dimensions stay inside responsive editing bounds', () => {
  assert.equal(clampInspectorWidth(20, 1200), MIN_INSPECTOR_WIDTH_PX)
  assert.equal(clampInspectorWidth(900, 1000), 680)
  assert.equal(clampTimelineHeight(20, 900), MIN_TIMELINE_HEIGHT_PX)
  assert.equal(clampTimelineHeight(1000, 900), 680)
})

test('serialized layout round-trips only bounded numeric preferences', () => {
  const serialized = serializeEditorLayoutPreferences({
    inspectorWidthPx: 444,
    timelineHeightPx: 512,
  })
  assert.deepEqual(parseEditorLayoutPreferences(serialized), {
    inspectorWidthPx: 444,
    timelineHeightPx: 512,
  })
  assert.equal(parseEditorLayoutPreferences('{"inspectorWidthPx":"wide","timelineHeightPx":false}').timelineHeightPx, null)
})
