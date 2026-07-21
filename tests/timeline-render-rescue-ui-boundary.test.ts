import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('preview fails closed and offers exact immutable timeline rescue', async () => {
  const source = await readFile('src/features/editor/OpenCutPreviewModal.tsx', 'utf8')
  const errorStart = source.indexOf("{phase === 'error'")
  const errorBranch = source.slice(
    errorStart,
    source.indexOf("{phase === 'ready'", errorStart),
  )

  assert.match(source, /classifyTimelineRenderFailure\(cause\)/)
  assert.match(source, /buildTimelineRenderRescueEnvelope\(\{[\s\S]*snapshot: timelineSnapshot/)
  assert.match(errorBranch, /已拒绝不保真预览，原始 OpenCut 数据保持不变/)
  assert.match(errorBranch, /未知 element、effect、mask 或动画不会被删除、扁平化或用近似效果替代/)
  assert.match(errorBranch, /复制完整 JSON/)
  assert.match(errorBranch, /下载完整 JSON/)
  assert.match(errorBranch, /timelineSnapshot\.etag/)
  assert.doesNotMatch(errorBranch, /删除未知|忽略未知|自动降级|继续导出/)
})
