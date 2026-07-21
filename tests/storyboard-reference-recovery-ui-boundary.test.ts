import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const serverPath = new URL('../server/storyboard-image-generation.ts', import.meta.url)

function slice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing boundary: ${start}`)
  assert.ok(endIndex > startIndex, `missing boundary: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('storyboard stage exposes missing real slots before any per-shot action', async () => {
  const app = await readFile(appPath, 'utf8')
  const stage = slice(app, 'function StoryboardStage({', '\nfunction ShotCard(')

  assert.match(app, /<strong className=\{primaryTurnaroundReferenceCount === 3 \? 'good' : ''\}>\{primaryTurnaroundReferenceCount\}\/3 已锁定<\/strong>/)
  assert.match(stage, /characterReferencesMissing && \(/)
  assert.match(stage, /aria-label="分镜角色参考图恢复"/)
  assert.match(stage, /锁定主图不能替代正面、侧面、背面三个真实槽位/)
  assert.match(stage, /disabled=\{generationBusy \|\| missingShotIds\.length === 0 \|\| characterReferencesMissing\}/)
  assert.match(stage, /disabled=\{generationBusy \|\| readyShotCount === 0 \|\| characterReferencesMissing\}/)
  assert.match(stage, /generationBlocked=\{characterReferencesMissing\}/)
})

test('one centralized gate prevents single, batch, retry and regenerate preflight', async () => {
  const app = await readFile(appPath, 'utf8')
  const startGeneration = slice(
    app,
    'const startGeneration = async (targetIds: number[] = [activeShot]) =>',
    '\n\n  const retryShotGeneration',
  )

  const gateIndex = startGeneration.indexOf('if (storyboardCharacterReferencesMissing)')
  const freezeIndex = startGeneration.indexOf('targets.map(freezeShotImageAttempt)')
  const preflightIndex = startGeneration.indexOf('openAssetImageConfirmation(attempts[0])')
  assert.ok(gateIndex >= 0)
  assert.ok(freezeIndex > gateIndex)
  assert.ok(preflightIndex > freezeIndex)
  assert.match(startGeneration.slice(gateIndex, freezeIndex), /return/)

  const retry = slice(app, 'const retryShotGeneration = async (shotId: number) =>', '\n\n  const cancelShotGeneration')
  assert.match(retry, /await startGeneration\(\[shotId\]\)/)
  assert.equal(app.match(/const startGeneration = async/g)?.length, 1)
})

test('recovery actions deep-link the exact character and require an explicit text-only choice', async () => {
  const app = await readFile(appPath, 'utf8')
  const actions = slice(app, 'const openPrimaryCharacterReferenceSetup = () =>', '\n  const buildShotPrompt')
  const frozenShot = slice(app, 'const freezeShotImageAttempt = (shot: Shot) =>', '\n\n  const freezeAliImageAttempt')

  assert.match(actions, /setAssetEntityFocus\(\{ type: 'character', id: primaryCharacter\.id \}\)/)
  assert.match(actions, /changeStage\('assets'\)/)
  assert.match(actions, /拆分三视图/)
  assert.match(actions, /const useTextOnlyStoryboards = \(\) => \{/)
  assert.match(actions, /setConsistencyLocked\(false\)/)
  assert.match(actions, /已明确关闭锁定参考图/)
  assert.match(frozenShot, /useLockedReferences: consistencyLocked/)
})

test('server fails closed for automatic references and makes opt-out immutable text-only evidence', async () => {
  const server = await readFile(serverPath, 'utf8')
  const decision = slice(
    server,
    'export function createStoryboardReferenceDecision(',
    '\n\n/** @deprecated Prefer the durable decision',
  )
  const paidGate = slice(
    server,
    'export function assertCurrentStoryboardReferenceDecision(',
    '\n\nexport function resolveDurableEpisodeImageBinding(',
  )

  assert.match(decision, /if \(options\.useLockedReferences\) return automaticStoryboardReferenceDecision\(database, target\)/)
  assert.match(decision, /source: 'explicit_opt_out'/)
  assert.match(decision, /recommendation: null/)
  assert.match(decision, /locationPin: null/)
  assert.match(decision, /referenceAssetIds: \[\]/)
  assert.match(paidGate, /createStoryboardReferenceDecision\(database, input\.target/)
  assert.match(paidGate, /useLockedReferences: decision\.source === 'agentic_auto'/)
  assert.match(paidGate, /STALE_STORYBOARD_REFERENCE_DECISION/)
})
