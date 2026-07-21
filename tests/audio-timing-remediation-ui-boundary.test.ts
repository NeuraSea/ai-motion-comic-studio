import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appUrl = new URL('../src/App.tsx', import.meta.url)
const dialogUrl = new URL('../src/features/video/ShotVideoBatchDialog.tsx', import.meta.url)

test('paid STALE_AUDIO_TIMING recovery returns to audio and never invokes a Provider', async () => {
  const app = await readFile(appUrl, 'utf8')
  const routeStart = app.indexOf("if (job.type === 'shot.video.generate')", app.indexOf('const routePaidReconfirmation'))
  const routeEnd = app.indexOf("setToast('该任务需要回到原工作台", routeStart)
  assert.ok(routeStart >= 0 && routeEnd > routeStart)
  const route = app.slice(routeStart, routeEnd)
  assert.match(route, /job\.error\?\.code === 'STALE_AUDIO_TIMING' && job\.timingRemediation/)
  assert.match(route, /setShotVideoTimingRemediation\(\{ sourceJobId: job\.id, remediation \}\)/)
  assert.match(route, /focusBoundShot\('audio'\)/)
  assert.match(route, /旧 .*秒/)
  assert.match(route, /Provider task 已存在/)
  assert.doesNotMatch(route, /generateDialogueSpeech|createShotVideoBatch|preflightShotVideoBatch/)
})

test('AudioStage focuses and scrolls to one remediation line and shows immutable timing evidence', async () => {
  const app = await readFile(appUrl, 'utf8')
  const start = app.indexOf('function AudioStage(')
  const end = app.indexOf('\nfunction ExportStage(', start)
  assert.ok(start >= 0 && end > start)
  const audioStage = app.slice(start, end)
  assert.match(audioStage, /focusTarget: ShotVideoTimingRemediationFocusTarget \| null/)
  assert.match(audioStage, /const focusKey = `\$\{focusTarget\.sceneId\}\\u0000\$\{focusTarget\.shotId\}\\u0000\$\{focusTarget\.dialogueLineId\}`/)
  assert.match(audioStage, /setSelectedLineKey\(focusKey\)/)
  assert.match(audioStage, /scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/)
  assert.match(audioStage, /data-dialogue-line-id=\{line\.id\}/)
  assert.match(audioStage, /data-dialogue-line-scope=\{entryKey\}/)
  assert.match(audioStage, /key=\{entryKey\}/)
  assert.match(audioStage, /dialogueLineButtonRefs\.current\.get\(focusKey\)/)
  assert.match(audioStage, /aria-label="音频时长恢复"/)
  assert.match(audioStage, /timingBindingLabel\(line\.previous\)/)
  assert.match(audioStage, /timingBindingLabel\(line\.current\)/)
  assert.match(app, /durationSeconds\.toFixed\(2\).*秒 \/.*durationFrames.*帧/)
  assert.match(audioStage, /系统没有自动生成语音，也不会自动重提 Seedance/)
  assert.match(audioStage, /onClick=\{onContinueTimingRepreflight\}/)

  const focusEffect = audioStage.slice(
    audioStage.indexOf('const requestKey ='),
    audioStage.indexOf('const applyConfirmedLinePerformance'),
  )
  assert.doesNotMatch(focusEffect, /onGenerate\(|api\.|preflight|Seedance/)
})

test('Task Center shot recovery is fail-closed for duplicate shot IDs across scenes', async () => {
  const app = await readFile(appUrl, 'utf8')
  const focusStart = app.indexOf("const focusBoundShot = (stage: 'audio' | 'storyboard'")
  const focusEnd = app.indexOf('\n\n    const routePaidReconfirmation', focusStart)
  assert.ok(focusStart >= 0 && focusEnd > focusStart)
  const focus = app.slice(focusStart, focusEnd)
  assert.match(focus, /const publicSceneId = typeof binding\?\.sceneId === 'string'/)
  assert.match(focus, /matchingShots\.find\(\(candidate\) => candidate\.sceneId === publicSceneId\)/)
  assert.match(focus, /matchingShots\.length === 1 \? matchingShots\[0\]! : null/)
  assert.doesNotMatch(focus, /find\(\(candidate\) => candidate\.storyId === publicShotId\) \?\? null/)
})

test('audio-to-video handoff only opens an exact recovery scope and leaves preflight explicit', async () => {
  const [app, dialog] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(dialogUrl, 'utf8'),
  ])
  const handoffStart = app.indexOf('onContinueTimingRepreflight={() => {')
  const handoffEnd = app.indexOf("onNext={() => changeStage", handoffStart)
  assert.ok(handoffStart >= 0 && handoffEnd > handoffStart)
  const handoff = app.slice(handoffStart, handoffEnd)
  assert.match(handoff, /shotVideoTimingRepreflightRecovery\(/)
  assert.match(handoff, /setCurrentStage\('storyboard'\)/)
  assert.match(handoff, /setShowShotVideoBatch\(true\)/)
  assert.match(handoff, /请手动点击.*快速权威预检/)
  assert.doesNotMatch(handoff, /api\.|runPreflight|createShotVideoBatch|generateDialogueSpeech/)

  const recoveryEffectStart = dialog.indexOf('const recoveryKey = JSON.stringify(timingRepreflightRecovery)')
  const recoveryEffectEnd = dialog.indexOf('\n\n  useEffect(() => {', recoveryEffectStart)
  assert.ok(recoveryEffectStart >= 0 && recoveryEffectEnd > recoveryEffectStart)
  const recoveryEffect = dialog.slice(recoveryEffectStart, recoveryEffectEnd)
  assert.match(recoveryEffect, /clearShotVideoBatchAttemptsForTimingRecovery\(attemptsRef\.current/)
  assert.match(recoveryEffect, /setSelectedShotIds\(\[shot\.shotId\]\)/)
  assert.match(recoveryEffect, /setReferenceControlMode\('smart'\)/)
  assert.doesNotMatch(recoveryEffect, /api\.|runPreflight|createShotVideoBatch/)
  assert.match(dialog, /系统不会自动预检或提交 Seedance/)
})
