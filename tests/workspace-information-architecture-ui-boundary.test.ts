import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  PRODUCTION_STAGES,
  isCatalogWorkspaceRoute,
  productionStageForRoute,
  visibleProductionStageIdForRoute,
} from '../src/features/workflow/production-stage-state.ts'

const appPath = new URL('../src/App.tsx', import.meta.url)
const planPath = new URL('../plan.md', import.meta.url)

function slice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing boundary: ${start}`)
  assert.ok(endIndex > startIndex, `missing boundary: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('global Catalog routes are separate from the complete five-stage production console', () => {
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
  assert.equal(productionStageForRoute('catalog-source'), null)
  assert.equal(visibleProductionStageIdForRoute('audio'), 'script')
})

test('first-level rail labels and routes preserve the three workspace domains', async () => {
  const app = await readFile(appPath, 'utf8')
  const railItems = slice(app, 'const railItems:', '\n\nfunction useDialogFocus')
  const appState = slice(app, 'function App() {', '\n  const [shots, setShots]')
  const railSelection = slice(app, '<Rail\n', '\n      />')
  const workspaceRouteBranch = slice(railSelection, '          if (targetStage) {', '\n          } else if')
  const changeStage = slice(app, '  const changeStage = (stageId: string) => {', '\n\n  const openStoryEntitySearchResult')

  assert.match(railItems, /id: 'projects', label: '项目 Catalog'/)
  assert.match(railItems, /id: 'production', label: '分集制作'/)
  assert.match(railItems, /id: 'characters', label: '数字资产 Catalog'/)

  assert.match(appState, /return isWorkspaceRoute\(requestedStage\) \? requestedStage : 'catalog-source'/)
  assert.match(appState, /currentStage === 'catalog-source'[\s\S]*\? 'projects'/)
  assert.doesNotMatch(appState, /const \[activeRail, setActiveRail\] = useState\('production'\)/)

  assert.match(railSelection, /id === 'production'[\s\S]*\? \(isProductionStageRoute\(currentStage\) \? currentStage : 'source'\)/)
  assert.match(railSelection, /id === 'projects'[\s\S]*\? 'catalog-source'/)
  assert.match(railSelection, /id === 'characters'[\s\S]*\? 'catalog-assets'/)
  assert.match(workspaceRouteBranch, /setCurrentStage\(targetStage\)/)
  assert.doesNotMatch(workspaceRouteBranch, /generate|preflight|confirm|Provider|api\./i)

  assert.match(changeStage, /setActiveRail\('production'\)/)
  assert.doesNotMatch(changeStage, /setActiveRail\('(?:projects|characters)'\)/)
})

test('production calls to action preserve source and asset preparation gates', async () => {
  const app = await readFile(appPath, 'utf8')
  const sourceStage = slice(app, 'function SourceStage({', '\nfunction ScriptStage(')
  const assetsStage = slice(app, 'function AssetsStage({', '\nfunction AudioStage(')

  assert.match(sourceStage, />进入角色与场景准备\s*</)
  assert.match(assetsStage, />进入拆剧本与配音\s*</)
})

test('global Catalog and Episode production render different headers', async () => {
  const app = await readFile(appPath, 'utf8')
  const workspaceHeader = slice(app, '          {globalCatalogRoute ? (', '\n          <OfflineStoryDraftPersistenceNotice')
  const projectHeader = slice(app, 'function ProjectHeader({', '\nfunction StoryRevisionControls(')

  assert.match(workspaceHeader, /<ProjectLibraryHeader/)
  assert.match(workspaceHeader, /:\s*\(\s*<ProjectHeader/)
  assert.match(projectHeader, /stages\.map\(\(item, index\) =>/)
})

test('the plan names knowledge, assets, and production as separate domains', async () => {
  const plan = await readFile(planPath, 'utf8')
  const architectureDecision = slice(
    plan,
    '#### 信息架构校正：项目知识库、数字资产库、分集制作台三域分离',
    '\n- 已完成：SQLite',
  )

  assert.match(architectureDecision, /\*\*项目知识库是一级模块，不是制作步骤\*\*/)
  assert.match(architectureDecision, /\*\*数字资产库是一级模块，不是某集临时目录\*\*/)
  assert.match(architectureDecision, /\*\*分集制作台只引用，不拥有素材\*\*/)
  assert.match(architectureDecision, /`assetId`/)
  assert.match(architectureDecision, /`assetVersionId`/)
})
