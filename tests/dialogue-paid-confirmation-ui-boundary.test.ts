import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const performancePath = new URL(
  '../src/features/voices/LinePerformanceDirector.tsx',
  import.meta.url,
)
const confirmationDialogPath = new URL(
  '../src/features/paid-aigc/PaidAigcConfirmationDialog.tsx',
  import.meta.url,
)

test('AI director submits directly while speech stays behind the shared paid confirmation dialog', async () => {
  const [app, performance, confirmationDialog] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(performancePath, 'utf8'),
    readFile(confirmationDialogPath, 'utf8'),
  ])

  assert.equal(app.match(/api\.createDialogueSpeechGenerationJob\(/g)?.length, 1)
  assert.equal(app.match(/api\.preflightDialogueSpeechGenerationJob\(/g)?.length, 2)
  assert.equal(performance.match(/api\.createDialoguePerformanceRecommendation\(/g)?.length, 1)
  assert.doesNotMatch(performance, /preflightDialoguePerformanceRecommendation/)

  const speechPrepareStart = app.indexOf('const generateDialogueSpeech')
  const speechPrepareEnd = app.indexOf('const refreshDialogueSpeechConfirmation', speechPrepareStart)
  const speechConfirmStart = app.indexOf('const confirmDialogueSpeech', speechPrepareEnd)
  const speechConfirmEnd = app.indexOf('const generateSelectedShotVideo', speechConfirmStart)
  assert.ok(speechPrepareStart > 0 && speechPrepareEnd > speechPrepareStart)
  assert.ok(speechConfirmStart > speechPrepareEnd && speechConfirmEnd > speechConfirmStart)
  assert.doesNotMatch(
    app.slice(speechPrepareStart, speechPrepareEnd),
    /createDialogueSpeechGenerationJob/,
  )
  assert.match(
    app.slice(speechConfirmStart, speechConfirmEnd),
    /confirmedDialogueSpeechGenerationRequest[\s\S]*createDialogueSpeechGenerationJob/,
  )

  const performancePrepareStart = performance.indexOf('const startRecommendation')
  const performancePrepareEnd = performance.indexOf(
    'const adoptRecommendation',
    performancePrepareStart,
  )
  assert.ok(performancePrepareStart > 0 && performancePrepareEnd > performancePrepareStart)
  assert.match(
    performance.slice(performancePrepareStart, performancePrepareEnd),
    /createDialoguePerformanceRecommendation/,
  )
  assert.match(performance, /sourceRevisionId \?\? 'no-source-revision'/)
  assert.match(performance, /voiceProfileRevision \?\? 'no-voice-profile'/)
  assert.match(
    app,
    /key=\{`\$\{productionScope\.episodeId\}:\$\{productionScope\.sourceRevisionId \?\? 'no-source-revision'\}:\$\{inheritedProfile\?\.updatedAt \?\? 'no-voice-profile'\}:\$\{selectedEntry\.line\.id\}`\}/,
  )

  assert.match(app, /<PaidAigcConfirmationDialog[\s\S]*角色配音 · 付费任务门禁/)
  assert.doesNotMatch(performance, /PaidAigcConfirmationDialog|付费任务门禁|计费预检/)
  assert.match(confirmationDialog, /重新预检（不建单）/)
  assert.match(confirmationDialog, /明确确认并创建 1 个任务/)
  assert.doesNotMatch(`${app}\n${performance}`, /window\.confirm/)
})
