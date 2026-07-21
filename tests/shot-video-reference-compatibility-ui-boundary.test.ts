import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const dialogPath = new URL('../src/features/video/ShotVideoBatchDialog.tsx', import.meta.url)
const stylesPath = new URL('../src/features/video/ShotVideoBatchDialog.css', import.meta.url)

test('Seedance reference failures render exact image evidence and a per-shot whole-turnaround recovery', async () => {
  const [source, styles] = await Promise.all([
    readFile(dialogPath, 'utf8'),
    readFile(stylesPath, 'utf8'),
  ])
  assert.match(source, /VIDEO_REFERENCE_ASSET_INCOMPATIBLE/)
  assert.match(source, /parseShotVideoReferenceCompatibilityIssues/)
  assert.match(source, /已定位 \{referenceCompatibilityIssues\.length\} 张不合规参考图/)
  assert.match(source, /\{issue\.width \?\? '\?'\}×\{issue\.height \?\? '\?'\}/)
  assert.match(source, /本镜采用分镜 \+ 整张三视图/)
  assert.match(source, /本地 FFmpeg 重新拆分/)
  assert.match(source, /\[issue\.shotId\]: issue\.turnaroundSource!\.assetId/)
  assert.match(styles, /\.shot-video-reference-compatibility/)
})

test('whole-turnaround recovery is scoped to one smart selection rather than changing the full batch mode', async () => {
  const source = await readFile(dialogPath, 'utf8')
  assert.match(source, /const compatibilityOverride = referenceCompatibilityOverrides\[shot\.shotId\]/)
  assert.match(source, /wholeTurnaroundCompatibilityRecoveryReferences\(\{/)
  assert.match(source, /storyboardAssetId: shot\.assetId/)
  assert.match(source, /turnaroundAssetId: compatibilityOverride/)
  assert.doesNotMatch(source, /setReferenceControlMode\('manual'\)[\s\S]{0,300}本镜改用整张三视图/)
})
