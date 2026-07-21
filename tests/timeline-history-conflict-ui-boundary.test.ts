import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const timelinePath = new URL('../src/features/editor/OpenCutTimeline.tsx', import.meta.url)

function functionSlice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing boundary: ${start}`)
  assert.ok(endIndex > startIndex, `missing boundary: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('timeline history is read-only until one explicit restore creates a new revision', async () => {
  const source = await readFile(timelinePath, 'utf8')
  const load = functionSlice(source, 'const loadTimelineHistory', 'const toggleTimelineHistory')
  const restore = functionSlice(
    source,
    'const restoreSelectedHistoryRevision',
    'const copyTimelineConflictRescue',
  )

  assert.equal(load.match(/listTimelineDocumentRevisions\(/g)?.length, 1)
  assert.doesNotMatch(load, /save\(|restoreTimelineDocumentRevision\(|adoptServerMutation/)
  assert.equal(restore.match(/restoreTimelineDocumentRevision\(/g)?.length, 1)
  assert.match(restore, /storageState\.etag/)
  assert.match(restore, /historyRestoreAttemptsRef/)
  assert.match(restore, /replaceEditorWithAuthoritativeSnapshot/)
  assert.match(source, /恢复为新修订/)
  assert.match(source, /不会移动或删除旧 head/)
})

test('timeline conflict UX never auto-overwrites and exposes both rescue choices', async () => {
  const source = await readFile(timelinePath, 'utf8')
  const adopt = functionSlice(
    source,
    'const adoptConflictServerHead',
    'const saveConflictLocalAsNewRevision',
  )
  const save = functionSlice(
    source,
    'const saveConflictLocalAsNewRevision',
    'const splitSelected',
  )

  assert.equal(adopt.match(/adoptAuthoritativeHead\(/g)?.length, 1)
  assert.doesNotMatch(adopt, /saveConflictAsNewRevision|\.save\(/)
  assert.match(save, /parseOpenCutTracks\(timelineConflictRescue\.document\)/)
  assert.equal(save.match(/saveConflictAsNewRevision\(/g)?.length, 1)
  assert.match(save, /TimelineStorageConflictError/)
  assert.match(source, /复制 JSON/)
  assert.match(source, /下载 JSON/)
  assert.match(source, /采用服务端/)
  assert.match(source, /本地副本另存新修订/)
  assert.doesNotMatch(source, /useEffect\([\s\S]{0,500}saveConflictAsNewRevision/)
})

test('an incompatible authoritative head is quarantined before reconcile and never shown as fallback editing', async () => {
  const source = await readFile(timelinePath, 'utf8')
  const loadEffect = functionSlice(
    source,
    'void storage.load(controller.signal)',
    'useEffect(() => {\n    const nextTracks = commandEditor.getTracks()',
  )
  const compatibilityGate = loadEffect.indexOf('inspectAuthoritativeSnapshot(snapshot, true)')
  const reconcile = loadEffect.indexOf('await storage.reconcile(controller.signal)')
  assert.ok(compatibilityGate >= 0, 'load must inspect authoritative metadata and canonical document')
  assert.ok(reconcile > compatibilityGate, 'compatibility inspection must happen before reconcile can mutate head')
  assert.match(loadEffect, /inspectAuthoritativeSnapshot\(snapshot, true\)[\s\S]*quarantineAuthoritativeSnapshot\(snapshot, loadedCompatibility\.reasons\)[\s\S]*return/)
  assert.match(loadEffect, /const compatibility = inspectAuthoritativeSnapshot\(snapshot\)/)

  const quarantine = functionSlice(
    source,
    'const quarantineAuthoritativeSnapshot',
    'const replaceEditorWithAuthoritativeSnapshot',
  )
  assert.match(quarantine, /setAuthoritativeTimeline\(snapshot\)/)
  assert.match(quarantine, /setHydratedTimeline\(null\)/)
  assert.match(quarantine, /setTimelineCanonicalQuarantine/)
  assert.match(quarantine, /reasons: \[\.\.\.reasons\]/)
  assert.match(source, /open && !timelineHeadIncompatible && \(/)
  assert.match(source, /系统没有用分镜 fallback 伪装成可编辑时间线/)
})

test('canonical quarantine exposes raw authoritative metadata and compatible-history recovery', async () => {
  const source = await readFile(timelinePath, 'utf8')
  const payload = functionSlice(
    source,
    'function authoritativeQuarantinePayload',
    'function readViewState',
  )
  for (const binding of [
    'documentId',
    'projectId',
    'episodeId',
    'sourceRevisionId',
    'schemaVersion',
    'upstreamCommit',
    'etag',
    'document: snapshot.document',
  ]) assert.match(payload, new RegExp(binding.replace('.', '\\.')))
  assert.match(source, /复制当前 raw JSON/)
  assert.match(source, /下载当前 raw JSON/)
  assert.match(source, /选择兼容历史/)
  assert.match(source, /inspectOpenCutRevisionCompatibility/)
  assert.match(source, /data-restorable=/)
  assert.match(source, /不可恢复/)
  assert.match(source, /!selectedHistoryCompatible/)
  assert.match(source, /setTimelineCanonicalQuarantine\(null\)/)
})
