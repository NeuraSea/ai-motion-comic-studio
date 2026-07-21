import type { ProductionStageRoute } from '../workflow/production-stage-state'
import { isProductionStageRoute } from '../workflow/production-stage-state'

export const PROJECT_SWITCHER_STORAGE_KEY = 'manju.project-switcher.workspace.v1'
export const MAX_RECENT_PRODUCTION_EPISODES = 8

export interface ProductionWorkspaceLocation {
  projectId: string
  episodeId: string
  stage: ProductionStageRoute
  storyShotId: string | null
  updatedAt: string
}

export interface RecentProductionEpisode {
  projectId: string
  episodeId: string
  openedAt: string
}

export interface ProjectSwitcherMemory {
  version: 1
  workspaces: Record<string, ProductionWorkspaceLocation>
  recentEpisodes: RecentProductionEpisode[]
}

export const EMPTY_PROJECT_SWITCHER_MEMORY: ProjectSwitcherMemory = Object.freeze({
  version: 1,
  workspaces: {},
  recentEpisodes: [],
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scopeKey(projectId: string, episodeId: string): string {
  return `${projectId}\u0000${episodeId}`
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function parseWorkspace(value: unknown): ProductionWorkspaceLocation | null {
  const stage = isRecord(value) && typeof value.stage === 'string' ? value.stage : null
  if (!isRecord(value)
    || typeof value.projectId !== 'string' || !value.projectId
    || typeof value.episodeId !== 'string' || !value.episodeId
    || !isProductionStageRoute(stage)
    || !(value.storyShotId === null || typeof value.storyShotId === 'string')
    || !validDate(value.updatedAt)) return null
  return {
    projectId: value.projectId,
    episodeId: value.episodeId,
    stage,
    storyShotId: value.storyShotId,
    updatedAt: value.updatedAt,
  }
}

function parseRecent(value: unknown): RecentProductionEpisode | null {
  if (!isRecord(value)
    || typeof value.projectId !== 'string' || !value.projectId
    || typeof value.episodeId !== 'string' || !value.episodeId
    || !validDate(value.openedAt)) return null
  return {
    projectId: value.projectId,
    episodeId: value.episodeId,
    openedAt: value.openedAt,
  }
}

export function parseProjectSwitcherMemory(raw: string | null): ProjectSwitcherMemory {
  if (!raw) return { version: 1, workspaces: {}, recentEpisodes: [] }
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.version !== 1) {
      return { version: 1, workspaces: {}, recentEpisodes: [] }
    }
    const workspaces = isRecord(value.workspaces)
      ? Object.values(value.workspaces).reduce<Record<string, ProductionWorkspaceLocation>>((result, candidate) => {
          const workspace = parseWorkspace(candidate)
          if (workspace) result[scopeKey(workspace.projectId, workspace.episodeId)] = workspace
          return result
        }, {})
      : {}
    const recentEpisodes = Array.isArray(value.recentEpisodes)
      ? value.recentEpisodes
          .map(parseRecent)
          .filter((candidate): candidate is RecentProductionEpisode => candidate !== null)
          .filter((candidate, index, candidates) => candidates.findIndex((other) => (
            other.projectId === candidate.projectId && other.episodeId === candidate.episodeId
          )) === index)
          .slice(0, MAX_RECENT_PRODUCTION_EPISODES)
      : []
    return { version: 1, workspaces, recentEpisodes }
  } catch {
    return { version: 1, workspaces: {}, recentEpisodes: [] }
  }
}

export function serializeProjectSwitcherMemory(memory: ProjectSwitcherMemory): string {
  return JSON.stringify(memory)
}

export function workspaceLocationForEpisode(
  memory: ProjectSwitcherMemory,
  projectId: string,
  episodeId: string,
): ProductionWorkspaceLocation | null {
  return memory.workspaces[scopeKey(projectId, episodeId)] ?? null
}

export function rememberProductionWorkspace(
  memory: ProjectSwitcherMemory,
  input: {
    projectId: string
    episodeId: string
    stage: ProductionStageRoute
    storyShotId?: string | null
    now?: string
    markRecent?: boolean
  },
): ProjectSwitcherMemory {
  const key = scopeKey(input.projectId, input.episodeId)
  const previous = memory.workspaces[key]
  const now = input.now ?? new Date().toISOString()
  const workspace: ProductionWorkspaceLocation = {
    projectId: input.projectId,
    episodeId: input.episodeId,
    stage: input.stage,
    storyShotId: input.storyShotId === undefined
      ? previous?.storyShotId ?? null
      : input.storyShotId,
    updatedAt: now,
  }
  const recentEpisodes = input.markRecent
    ? [
        { projectId: input.projectId, episodeId: input.episodeId, openedAt: now },
        ...memory.recentEpisodes.filter((candidate) => !(
          candidate.projectId === input.projectId && candidate.episodeId === input.episodeId
        )),
      ].slice(0, MAX_RECENT_PRODUCTION_EPISODES)
    : memory.recentEpisodes
  return {
    version: 1,
    workspaces: { ...memory.workspaces, [key]: workspace },
    recentEpisodes,
  }
}
