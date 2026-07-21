import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const cardPath = new URL('../src/features/video/SeedanceGoldenAcceptanceCard.tsx', import.meta.url)
const dialogPath = new URL('../src/features/video/ShotVideoBatchDialog.tsx', import.meta.url)

test('Golden acceptance entry opens a safe all-shot 1080p verbose-baseline preset', () => {
  const app = readFileSync(appPath, 'utf8')
  const card = readFileSync(cardPath, 'utf8')
  const dialog = readFileSync(dialogPath, 'utf8')

  assert.match(app, /setShotVideoBatchPreset\('golden-baseline'\)/)
  assert.match(app, /setShotVideoBatchPreset\('golden-candidate'\)/)
  assert.match(app, /initialPromptCompilerVersion=\{shotVideoBatchPreset === 'golden-baseline'[\s\S]*?'seedance-verbose-baseline-v1'/)
  assert.match(app, /initialResolution=\{shotVideoBatchPreset \? '1080p' : '720p'\}/)
  assert.match(app, /initialSelectionMode=\{shotVideoBatchPreset \? 'all-available' : 'default'\}/)

  assert.match(dialog, /initialSelectionMode === 'all-available'[\s\S]*?safeDefaultShots\.map/)
  assert.match(dialog, /setResolution\(initialResolution\)/)
  assert.match(dialog, /setPromptCompilerVersion\(initialPromptCompilerVersion\)/)

  assert.match(card, /AccountOverdueError/)
  assert.match(card, /恢复账户后重新做免费预检；系统不会自动重提/)
  assert.match(card, /检查 Seedance 配置/)
  assert.match(card, /Provider 与 candidate 不一致/)
  assert.match(card, /准备当前 Provider candidate/)
  assert.match(card, /当前 Provider compact/)
  assert.match(card, /历史 Provider candidate/)
  assert.match(card, /入口预置全部镜头、1080p、仅环境音\/动作音和 verbose compiler/)
})
