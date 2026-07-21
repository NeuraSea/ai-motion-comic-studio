export type VisibleProductionStageId = 'source' | 'assets' | 'script' | 'storyboard' | 'export'

export type ProductionStageRoute = VisibleProductionStageId | 'audio'
export type CatalogWorkspaceRoute = 'catalog-source' | 'catalog-assets'
export type WorkspaceRoute = ProductionStageRoute | CatalogWorkspaceRoute

export type ProductionStageStatus = 'done' | 'active' | 'pending' | 'warning'

export type ProductionStageDefinition = Readonly<{
  id: VisibleProductionStageId
  short: string
  name: string
}>

/**
 * The global Catalog and the Episode production console are separate scopes.
 * Catalog owns project knowledge and the long-lived asset library. Production
 * still keeps every operational gate: choose the source revision, prepare and
 * pin characters/scenes, split the script and finish speech, generate visuals,
 * then edit/export in OpenCut. The first two stages reference Catalog records;
 * they do not transfer ownership to the Episode.
 *
 * `audio` remains a durable deep-link for the second page of the script stage.
 */
export const PRODUCTION_STAGES: readonly ProductionStageDefinition[] = Object.freeze([
  { id: 'source', short: '选集', name: '原著选集与制作设定' },
  { id: 'assets', short: '资产', name: '角色与场景准备' },
  { id: 'script', short: '剧本', name: '拆剧本与配音' },
  { id: 'storyboard', short: '镜头', name: '分镜与逐镜视频' },
  { id: 'export', short: '成片', name: 'OpenCut 剪辑与成片' },
])

const VISIBLE_STAGE_BY_ID = new Map(PRODUCTION_STAGES.map((stage) => [stage.id, stage]))

const NEXT_ROUTE: Readonly<Record<ProductionStageRoute, ProductionStageRoute | null>> = Object.freeze({
  source: 'assets',
  assets: 'script',
  script: 'audio',
  audio: 'storyboard',
  storyboard: 'export',
  export: null,
})

export function isProductionStageRoute(value: string | null): value is ProductionStageRoute {
  return value === 'audio'
    || (value !== null && VISIBLE_STAGE_BY_ID.has(value as VisibleProductionStageId))
}

export function isCatalogWorkspaceRoute(value: string | null): value is CatalogWorkspaceRoute {
  return value === 'catalog-source' || value === 'catalog-assets'
}

export function isWorkspaceRoute(value: string | null): value is WorkspaceRoute {
  return isProductionStageRoute(value) || isCatalogWorkspaceRoute(value)
}

export function visibleProductionStageIdForRoute(route: string): VisibleProductionStageId | null {
  if (route === 'audio') return 'script'
  return VISIBLE_STAGE_BY_ID.has(route as VisibleProductionStageId)
    ? route as VisibleProductionStageId
    : null
}

export function productionStageForRoute(route: string): ProductionStageDefinition | null {
  const visibleId = visibleProductionStageIdForRoute(route)
  return visibleId ? VISIBLE_STAGE_BY_ID.get(visibleId) ?? null : null
}

export function nextProductionStageRoute(route: ProductionStageRoute): ProductionStageRoute | null {
  return NEXT_ROUTE[route]
}

/**
 * Storyboard images are the required visual contract for the local dynamic
 * manga path. Seedance is an optional per-shot enhancement and must never
 * become an implicit gate: a project without a Seedance key still has to
 * reach OpenCut and export a real MP4. Failed or missing storyboard images do
 * remain blocking because neither renderer may invent a visual Asset.
 */
export function storyboardProductionGateStatus(
  shots: readonly { imageReady: boolean; imageFailed: boolean }[],
): ProductionStageStatus {
  if (shots.length === 0) return 'pending'
  if (shots.every((shot) => shot.imageReady)) return 'done'
  if (shots.some((shot) => !shot.imageReady && shot.imageFailed)) return 'warning'
  return 'pending'
}
