import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dialogPath = new URL('../src/features/video/ShotVideoBatchDialog.tsx', import.meta.url)

test('Seedance batch UI exposes an explicit preflighted verbose baseline without changing the production default', () => {
  const source = readFileSync(dialogPath, 'utf8')

  assert.match(source, /useState<ShotVideoPromptCompilerVersion>\('seedance-compact-v1'\)/)
  assert.match(source, /aria-label="Prompt 策略"/)
  assert.match(source, /A\/B 长 Prompt 基线/)
  assert.match(source, /setPromptCompilerVersion\('seedance-verbose-baseline-v1'\)/)
  assert.match(source, /promptCompilerVersion,\s*publicationMode,\s*audioPolicy,\s*selections,/)
  assert.match(source, /Baseline 仍是独立计费任务/)
  assert.match(source, /只进入验收素材，不替换当前生产镜头/)
  assert.match(source, /audioPolicy === 'provider_audio'/)
  assert.match(source, /Seedance 同步台词试听/)
  assert.match(source, /仅保存候选版本/)
  assert.match(source, /第一步只预检，不创建付费任务/)
  assert.match(source, /确认 \$\{validPreflight\.billableTaskCount\} 个计费任务并开始/)
})
