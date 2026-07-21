import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Episode production owns immutable Asset Manifest controls while Catalog remains version-only', async () => {
  const app = await readFile('src/App.tsx', 'utf8')
  const card = await readFile('src/features/assets/ProductionAssetManifestCard.tsx', 'utf8')
  const catalog = await readFile('src/features/assets/ProjectAssetVersionLibrary.tsx', 'utf8')

  assert.match(app, /<ProductionAssetManifestCard/)
  assert.match(card, /本集制作资产清单/)
  assert.match(card, /固化本集制作引用/)
  assert.match(card, /Catalog 默认版本变化不会改写已固化清单/)
  assert.match(card, /api\.getProductionAssetManifest/)
  assert.match(card, /api\.materializeProductionAssetManifest/)
  assert.doesNotMatch(catalog, /materializeProductionAssetManifest|本集制作资产清单/)
})
