import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const settingsPath = new URL('../src/features/providers/ProviderSettingsDialog.tsx', import.meta.url)
const appPath = new URL('../src/App.tsx', import.meta.url)
const pipelinePath = new URL('../src/features/pipeline/OneClickProductionPanel.tsx', import.meta.url)

test('Provider UI states that every text, vision, and Agentic LLM capability is free', async () => {
  const [settings, app, pipeline] = await Promise.all([
    readFile(settingsPath, 'utf8'),
    readFile(appPath, 'utf8'),
    readFile(pipelinePath, 'utf8'),
  ])

  assert.match(settings, /文字生成、理解、视觉与 Agentic 编排/)
  assert.match(settings, /LLM \/ Agentic 免费/)
  assert.match(settings, /不进入计费确认/)
  assert.match(settings, /只在你点击后创建持久幂等任务/)
  assert.match(settings, /BYOK \/ BYOA 上游账户是否收费/)
  assert.match(settings, /以对应 Provider 账单为准/)
  assert.match(app, /LLM 文本生成免费/)
  assert.match(pipeline, /只做图片 \/ TTS 计费与素材预检/)
  assert.match(pipeline, /新增付费媒体任务/)
  assert.match(pipeline, /不会新增图片、TTS 或视频生成调用/)
  assert.doesNotMatch(pipeline, /只做 AIGC 计费/)
  assert.doesNotMatch(pipeline, /新增 AIGC 任务/)
})
