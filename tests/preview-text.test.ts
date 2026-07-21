import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EditorSceneTracks } from '@manju/opencut-editor'
import { activePreviewTextCues } from '../src/features/editor/preview-text'

function tracks(): EditorSceneTracks {
  return {
    overlay: [{
      id: 'subtitles', type: 'text', elements: [{
        id: 'visible', type: 'text', name: '旧名', startTime: 10, duration: 20,
        params: { text: '  当前字幕  ' },
      }, {
        id: 'hidden', type: 'text', name: '不可见', startTime: 10, duration: 20,
        hidden: true,
      }],
    }, {
      id: 'hidden-track', type: 'text', hidden: true, elements: [{
        id: 'track-hidden', type: 'text', name: '不可见轨', startTime: 10, duration: 20,
      }],
    }],
    main: { id: 'main', type: 'video', elements: [] },
    audio: [],
  }
}

test('preview text uses the export text precedence and respects exact active intervals', () => {
  assert.deepEqual(activePreviewTextCues(tracks(), 10), [{ id: 'visible', text: '当前字幕' }])
  assert.deepEqual(activePreviewTextCues(tracks(), 29), [{ id: 'visible', text: '当前字幕' }])
  assert.deepEqual(activePreviewTextCues(tracks(), 30), [])
})
