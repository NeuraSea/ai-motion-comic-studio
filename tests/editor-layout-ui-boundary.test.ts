import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const stylesPath = new URL('../src/styles.css', import.meta.url)

test('production editor exposes both accessible drag separators without replacing collapse controls', async () => {
  const [app, styles] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(stylesPath, 'utf8'),
  ])

  assert.match(app, /aria-label="调整主画布与镜头属性栏宽度"/)
  assert.match(app, /aria-orientation="vertical"/)
  assert.match(app, /beginLayoutResize\('inspector', event\)/)
  assert.match(app, /aria-label="调整制作区与时间线高度"/)
  assert.match(app, /aria-orientation="horizontal"/)
  assert.match(app, /beginLayoutResize\('timeline', event\)/)
  assert.match(app, /onClose=\{\(\) => setInspectorOpen\(false\)\}/)
  assert.match(app, /onToggle=\{\(\) => setTimelineOpen\(\(value\) => !value\)\}/)
  assert.match(app, /EDITOR_LAYOUT_STORAGE_KEY/)
  assert.match(app, /serializeEditorLayoutPreferences/)

  assert.match(styles, /\.workspace-splitter-vertical/)
  assert.match(styles, /cursor: col-resize/)
  assert.match(styles, /\.workspace-splitter-horizontal/)
  assert.match(styles, /cursor: row-resize/)
  assert.match(styles, /\.timeline-region\.collapsed/)
})
