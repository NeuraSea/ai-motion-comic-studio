import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const taskCenterUrl = new URL('../src/features/jobs/TaskCenter.tsx', import.meta.url)
const retryActionUrl = new URL('../src/features/jobs/job-retry-action.ts', import.meta.url)
const appUrl = new URL('../src/App.tsx', import.meta.url)

test('TaskCenter never uses error.retryable as paid retry authority', async () => {
  const [taskCenter, retryAction] = await Promise.all([
    readFile(taskCenterUrl, 'utf8'),
    readFile(retryActionUrl, 'utf8'),
  ])
  assert.doesNotMatch(taskCenter, /error\??\.retryable/)
  assert.doesNotMatch(retryAction, /error\??\.retryable/)
  assert.match(taskCenter, /retriedJobIds\.has\(job\.id\) \? null : jobRetryAction\(job\)/)
  for (const label of ['重试', '继续查询', '重新预检', '人工处理']) {
    assert.match(retryAction, new RegExp(label))
  }
})

test('App routes paid reconfirmation without calling paid generation helpers', async () => {
  const app = await readFile(appUrl, 'utf8')
  const start = app.indexOf("if (job.retryDisposition === 'paid-reconfirmation-required')")
  const end = app.indexOf("if (job.retryDisposition === 'manual-resolution')", start)
  assert.ok(start >= 0 && end > start)
  const paidBranch = app.slice(start, end)
  assert.match(paidBranch, /routePaidReconfirmation\(\)/)
  assert.doesNotMatch(paidBranch, /generateVisualAsset|retryShotGeneration|retryGenerationJob/)
  assert.match(app, /job\.retryDisposition === 'resume-existing-provider-task'/)
})

test('free LLM manual outcomes return to their exact workspaces without paid copy', async () => {
  const app = await readFile(appUrl, 'utf8')
  const start = app.indexOf("if (job.retryDisposition === 'manual-resolution')")
  const end = app.indexOf("if (job.retryDisposition !== 'generic-free-retry'", start)
  assert.ok(start >= 0 && end > start)
  const manualBranch = app.slice(start, end)
  for (const type of [
    'story.generate',
    'character.voice.recommend',
    'dialogue.performance.recommend',
    'shot.video.reference.analyze',
  ]) {
    assert.match(manualBranch, new RegExp(type.replaceAll('.', '\\.')))
  }
  for (const stage of ['source', 'assets', 'audio', 'storyboard']) {
    assert.match(manualBranch, new RegExp(`setCurrentStage\\('${stage}'\\)`))
  }
  assert.match(manualBranch, /显式发起新一轮/)
})
