import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PRODUCTION_STAGES,
  isCatalogWorkspaceRoute,
  isProductionStageRoute,
  nextProductionStageRoute,
  productionStageForRoute,
  storyboardProductionGateStatus,
  visibleProductionStageIdForRoute,
} from '../src/features/workflow/production-stage-state.ts'

test('production workflow keeps all five episode-making gates while Catalog stays global', () => {
  assert.deepEqual(
    PRODUCTION_STAGES.map(({ id, name }) => ({ id, name })),
    [
      { id: 'source', name: '原著选集与制作设定' },
      { id: 'assets', name: '角色与场景准备' },
      { id: 'script', name: '拆剧本与配音' },
      { id: 'storyboard', name: '分镜与逐镜视频' },
      { id: 'export', name: 'OpenCut 剪辑与成片' },
    ],
  )
  assert.equal(visibleProductionStageIdForRoute('source'), 'source')
  assert.equal(visibleProductionStageIdForRoute('assets'), 'assets')
  assert.equal(isCatalogWorkspaceRoute('catalog-source'), true)
  assert.equal(isCatalogWorkspaceRoute('catalog-assets'), true)
  assert.equal(isProductionStageRoute('catalog-source'), false)
})

test('audio stays a compatible internal route of the script production stage', () => {
  assert.equal(isProductionStageRoute('audio'), true)
  assert.equal(visibleProductionStageIdForRoute('audio'), 'script')
  assert.equal(productionStageForRoute('audio')?.name, '拆剧本与配音')
  assert.equal(PRODUCTION_STAGES.some((stage) => stage.id === ('audio' as never)), false)
})

test('cross-workspace handoff remains explicit and has no provider side effects', () => {
  const routes: string[] = ['source']
  let route = nextProductionStageRoute('source')
  while (route) {
    routes.push(route)
    route = nextProductionStageRoute(route)
  }
  assert.deepEqual(routes, ['source', 'assets', 'script', 'audio', 'storyboard', 'export'])
})

test('unknown stage routes fail closed', () => {
  assert.equal(isProductionStageRoute('video'), false)
  assert.equal(visibleProductionStageIdForRoute('video'), null)
  assert.equal(productionStageForRoute('video'), null)
})

test('storyboard gate completes the dynamic manga path without requiring Seedance', () => {
  assert.equal(storyboardProductionGateStatus([
    { imageReady: true, imageFailed: false },
    { imageReady: true, imageFailed: false },
  ]), 'done')
})

test('storyboard gate remains blocked by missing or failed required images', () => {
  assert.equal(storyboardProductionGateStatus([]), 'pending')
  assert.equal(storyboardProductionGateStatus([
    { imageReady: true, imageFailed: false },
    { imageReady: false, imageFailed: false },
  ]), 'pending')
  assert.equal(storyboardProductionGateStatus([
    { imageReady: true, imageFailed: false },
    { imageReady: false, imageFailed: true },
  ]), 'warning')
})
