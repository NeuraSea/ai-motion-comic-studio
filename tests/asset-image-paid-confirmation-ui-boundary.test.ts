import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const editDialogPath = new URL('../src/features/assets/VisualAssetEditDialog.tsx', import.meta.url)
const confirmationDialogPath = new URL(
  '../src/features/paid-aigc/PaidAigcConfirmationDialog.tsx',
  import.meta.url,
)

test('every image create boundary lives behind signed preflight and no local confirm shortcut', async () => {
  const [app, editDialog, confirmationDialog] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(editDialogPath, 'utf8'),
    readFile(confirmationDialogPath, 'utf8'),
  ])

  assert.equal(app.match(/api\.createAssetImageJob\(/g)?.length, 1)
  assert.equal(app.match(/api\.createAssetImageEdit\(/g)?.length, 1)
  assert.equal(app.match(/api\.preflightAssetImageJob\(/g)?.length, 1)
  assert.equal(app.match(/api\.preflightAssetImageEdit\(/g)?.length, 1)
  assert.match(app, /confirmationMatchesAssetImageAttempt/)
  assert.match(app, /x-manju-aigc-confirmation|confirmationToken/)
  assert.match(app, /Provider retry is also billable/)

  const retryVisualStart = app.indexOf('const retryVisualAsset')
  const retryVisualEnd = app.indexOf('const lockVisualAsset', retryVisualStart)
  assert.ok(retryVisualStart > 0 && retryVisualEnd > retryVisualStart)
  const retryVisualBoundary = app.slice(retryVisualStart, retryVisualEnd)
  assert.doesNotMatch(retryVisualBoundary, /retryGenerationJob|retryImageJob/)
  assert.match(retryVisualBoundary, /generateVisualAsset/)

  assert.doesNotMatch(editDialog, /paidRiskConfirmed/)
  assert.match(editDialog, /预检 1 个.*不建单/)
  assert.match(editDialog, /suspended/)
  assert.match(confirmationDialog, /重新预检（不建单）/)
  assert.match(confirmationDialog, /明确确认并创建 1 个任务/)
  assert.doesNotMatch(`${app}\n${editDialog}\n${confirmationDialog}`, /window\.confirm/)
})
