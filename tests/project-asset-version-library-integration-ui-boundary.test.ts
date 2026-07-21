import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)

function slice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing boundary: ${start}`)
  assert.ok(endIndex > startIndex, `missing boundary: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('the global digital asset Catalog mounts the stable handle version library outside Episode preparation', async () => {
  const app = await readFile(appPath, 'utf8')
  const catalogWorkspace = slice(
    app,
    '<div className="global-catalog-workspace">',
    "              {currentStage === 'source' && (",
  )
  const episodeAssetPreparation = slice(
    app,
    "              {currentStage === 'assets' && (",
    "              {currentStage === 'storyboard' && (",
  )

  assert.match(app, /import \{ ProjectAssetVersionLibrary \}/)
  assert.match(app, /import \{ collectCurrentProductionAssetVersionIds \}/)
  assert.match(catalogWorkspace, /<CatalogNavigator/)
  assert.match(catalogWorkspace, /<ProjectAssetVersionLibrary/)
  assert.match(catalogWorkspace, /projectId=\{catalogProject\.id\}/)
  assert.match(catalogWorkspace, /episodeId=\{catalogEpisodeId\}/)
  assert.match(catalogWorkspace, /pinnedAssetVersionIds=/)
  assert.match(catalogWorkspace, /素材库默认版本已切换；所有剧集已经固定的版本保持不变/)
  assert.doesNotMatch(catalogWorkspace, /<AssetsStage/)
  assert.match(episodeAssetPreparation, /<AssetsStage/)
  assert.doesNotMatch(episodeAssetPreparation, /<ProjectAssetVersionLibrary/)
})

test('known production usage markers fail closed against current immutable Asset authority', async () => {
  const app = await readFile(appPath, 'utf8')
  const pins = slice(
    app,
    '  const productionPinnedAssetVersionIds = useMemo(',
    '\n  const visualAssetSuccessKey',
  )

  assert.match(pins, /target\.lockedAssetId/)
  assert.match(pins, /target\.lockedReferences\?\.frontAssetId/)
  assert.match(pins, /target\.lockedReferences\?\.sideAssetId/)
  assert.match(pins, /target\.lockedReferences\?\.backAssetId/)
  assert.match(pins, /shot\.assetId/)
  assert.match(pins, /review\?\.currentSelectionAssetId/)
  assert.match(pins, /collectCurrentProductionAssetVersionIds\(\{/)
  assert.match(pins, /projectId: productionContext\?\.projectId/)
  assert.match(pins, /episodeId: productionContext\?\.episode\.id/)
  assert.match(pins, /sourceRevisionId: productionContext\?\.episode\.sourceRevisionId/)
  assert.match(pins, /assets: visualAssetLibrary/)
  assert.match(pins, /referencedAssetVersionIds: references/)
  assert.doesNotMatch(pins, /\.add\(target\.locked|\.add\(shot\.assetId|\.add\(review/)
  assert.doesNotMatch(pins, /currentAssetVersionId|listAssetHandles|switchAssetHandle|Provider/)
})

test('visual Asset authority explicitly includes project-level versions for production references', async () => {
  const app = await readFile(appPath, 'utf8')
  const initialHydration = slice(
    app,
    '  useEffect(() => {\n    if (!productionContext || !storyDocument || !productionContext.episode.sourceRevisionId)',
    '\n  useEffect(() => {\n    const primaryId = storyDocument?.characters[0]?.id',
  )
  const explicitRefresh = slice(
    app,
    '  const refreshVisualAssetWorkbench = async () => {',
    '\n\n  const visualAssetPrompt',
  )

  // Initial hydration and explicit post-mutation refresh must share the same
  // project-inclusive authority; otherwise the badge would disappear on refresh.
  for (const authority of [initialHydration, explicitRefresh]) {
    assert.match(authority, /api\.listAssets\(productionContext\.projectId, \{[\s\S]*episodeId: productionContext\.episode\.id,[\s\S]*includeProjectAssets: true/)
  }
})
