import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTimelineKernelLabel } from '../src/features/editor/timeline-status'

test('a missing persisted timeline never presents itself as local-only', () => {
  assert.equal(
    resolveTimelineKernelLabel('OpenCut 命令栈已启用 · 本地态', 'missing', true),
    'OpenCut 命令栈已启用 · 待首次保存',
  )
})

test('a persisted timeline reports loading instead of a stale local-only label', () => {
  assert.equal(
    resolveTimelineKernelLabel('OpenCut 命令栈已启用 · 本地态', 'loading', true),
    'OpenCut 命令栈已启用 · 正在读取修订',
  )
})

test('interaction feedback is not hidden by the storage phase', () => {
  assert.equal(
    resolveTimelineKernelLabel('OpenCut 分割完成', 'missing', true),
    'OpenCut 分割完成',
  )
})

test('a timeline without persistence keeps the local-only label', () => {
  assert.equal(
    resolveTimelineKernelLabel('OpenCut 命令栈已启用 · 本地态', 'missing', false),
    'OpenCut 命令栈已启用 · 本地态',
  )
})
