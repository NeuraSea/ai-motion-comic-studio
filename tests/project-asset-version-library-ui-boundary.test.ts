import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const componentPath = new URL('../src/features/assets/ProjectAssetVersionLibrary.tsx', import.meta.url)
const cssPath = new URL('../src/features/assets/ProjectAssetVersionLibrary.css', import.meta.url)

function slice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing boundary: ${start}`)
  assert.ok(endIndex > startIndex, `missing boundary: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('project asset library reads stable handles and expands exact immutable versions', async () => {
  const source = await readFile(componentPath, 'utf8')
  const props = slice(
    source,
    'export interface ProjectAssetVersionLibraryProps {',
    '\n}\n\nconst defaultClient',
  )
  const loadHandles = slice(source, '  const loadHandles = useCallback', '\n\n  const loadVersions')
  const loadVersions = slice(source, '  const loadVersions = useCallback', '\n\n  useEffect')

  assert.match(props, /projectId: string/)
  assert.match(props, /episodeId\?: string \| null/)
  assert.match(props, /pinnedAssetVersionIds: readonly string\[\]/)
  assert.match(props, /onChanged\?: \(result: AssetVersionSwitchResponse\)/)
  assert.match(props, /onError\?: \(message: string\)/)

  assert.match(loadHandles, /client\.listAssetHandles\(projectId/)
  assert.match(loadHandles, /\.\.\.\(episodeId \? \{ episodeId \} : \{\}\)/)
  assert.match(loadHandles, /limit: 500/)
  assert.match(loadVersions, /client\.listAssetHandleVersions\(projectId, assetId\)/)
  assert.match(source, /素材 ID · \{handle\.assetId\}/)
  assert.match(source, /assetVersionId/)
  assert.match(source, /version\.versionNumber/)
  assert.doesNotMatch(source, /v\{version\.version\.version\}/)
})

test('the Catalog aggregates stable handles by business domain and entity instead of file order', async () => {
  const source = await readFile(componentPath, 'utf8')
  const css = await readFile(cssPath, 'utf8')

  assert.match(source, /BUSINESS_DOMAIN_ORDER/)
  assert.match(source, /BUSINESS_DOMAIN_LABEL/)
  assert.match(source, /handle\.businessBinding/)
  assert.match(source, /binding\.groupKey/)
  assert.match(source, /binding\.groupLabel/)
  assert.match(source, /按真实业务对象聚合，不再按文件平铺/)
  assert.match(source, /showArchived \|\| handle\.businessBinding\.domain !== 'archive'/)
  assert.match(source, /显示归档/)
  assert.match(css, /\.project-asset-business-domain/)
  assert.match(css, /\.project-asset-business-group/)
})

test('clicking a version is local preview only and cannot mutate defaults or production pins', async () => {
  const source = await readFile(componentPath, 'utf8')
  const preview = slice(
    source,
    '  const selectPreview = (assetId: string, assetVersionId: string) => {',
    '\n\n  const setLibraryDefault',
  )

  assert.match(preview, /setSelectedByAssetId/)
  assert.doesNotMatch(preview, /client\.|fetch\(|switch|Provider|Manifest|pin/i)
  assert.match(source, /onClick=\{\(\) => selectPreview\(handle\.assetId, version\.assetVersionId\)\}/)
  assert.match(source, />单击仅预览</)
  assert.match(source, /pinnedVersions\.has\(selectedVersion\.assetVersionId\)/)
  assert.match(source, />本制作使用</)
})

test('changing the library default uses If-Match plus a stable idempotency intent', async () => {
  const source = await readFile(componentPath, 'utf8')
  const mutation = slice(
    source,
    '  const setLibraryDefault = async (',
    '\n\n  return (',
  )

  assert.match(mutation, /const intent = `\$\{projectId\}\\0\$\{asset\.assetId\}\\0\$\{version\.assetVersionId\}\\0\$\{asset\.etag\}`/)
  assert.match(mutation, /idempotencyKeysRef\.current\.get\(intent\)/)
  assert.match(mutation, /client\.switchAssetHandleCurrentVersion\(/)
  assert.match(mutation, /version\.assetVersionId,[\s\S]*asset\.etag,[\s\S]*\{ idempotencyKey \}/)
  assert.match(mutation, /error\.status === 412[\s\S]*await loadVersions\(asset\.assetId\)/)
  assert.match(mutation, /系统不会自动重提/)
  assert.doesNotMatch(mutation, /client\.(?:preflight|createAssetImage|generate|pin)|productionPins|pinnedAssetVersionIds/i)
})

test('a completed mutation cannot write into a different project or Episode Catalog scope', async () => {
  const source = await readFile(componentPath, 'utf8')
  const effect = slice(source, '  useEffect(() => {', '\n\n  const toggleVersions')
  const mutation = slice(source, '  const setLibraryDefault = async (', '\n\n  return (')

  assert.match(source, /const scopeKey = `\$\{projectId\}\\0\$\{episodeId \?\? ''\}`/)
  assert.match(source, /const projectScopeRef = useRef\(scopeKey\)/)
  assert.match(source, /projectScopeRef\.current = scopeKey/)
  assert.match(effect, /setSwitchingKey\(null\)/)
  assert.match(effect, /idempotencyKeysRef\.current\.clear\(\)/)
  assert.match(mutation, /const requestProjectId = projectId/)
  assert.match(mutation, /const requestScopeKey = scopeKey/)
  assert.match(mutation, /projectScopeRef\.current !== requestScopeKey/)
  assert.match(mutation, /projectScopeRef\.current === requestScopeKey\) setSwitchingKey\(null\)/)
})

test('the component explains and renders default versus exact production use separately', async () => {
  const source = await readFile(componentPath, 'utf8')

  assert.match(source, /切换素材库默认，不会改写本制作使用的版本/)
  assert.match(source, /不调用 AIGC Provider/)
  assert.match(source, /不会自动升级当前分集已经固定的版本/)
  assert.match(source, /统一 Asset Manifest 尚在建设/)
  assert.match(source, /不会修改“本制作使用”标记/)
  assert.match(source, /素材库默认/)
  assert.match(source, /本制作使用/)
  assert.match(source, /sourceLabel\(selectedVersion\.version\)/)
  assert.match(source, /<MediaThumbnail asset=\{version\.version\}/)
})

test('version strip stays scrollable and responsive without resizing the workspace', async () => {
  const css = await readFile(cssPath, 'utf8')
  const strip = slice(css, '.project-asset-version-strip {', '\n.project-asset-version-tile {')

  assert.match(strip, /display: flex/)
  assert.match(strip, /overflow-x: auto/)
  assert.match(css, /\.project-asset-version-tile[\s\S]*min-width: 148px/)
  assert.match(css, /@media \(max-width: 760px\)/)
  assert.match(css, /\.project-asset-version-preview \{ grid-template-columns: 1fr; \}/)
})
