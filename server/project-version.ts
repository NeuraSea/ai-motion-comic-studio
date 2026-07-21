import type { ProjectRecord } from './database.js'

export interface ProjectVersionSource {
  currentRevisionId: string | null
  updatedAt: string
}

/**
 * Opaque version for project-scoped settings writes.
 *
 * The normal project document ETag is its immutable document revision ID. A
 * narrator casting change deliberately does not replace that document, so its
 * optimistic version also includes `projects.updated_at` to prevent two
 * settings writes from accepting the same document revision (an ABA hole).
 */
export function projectSettingsEtag(
  project: ProjectVersionSource | Pick<ProjectRecord, 'currentRevisionId' | 'updatedAt'>,
): string {
  const version = Buffer.from(JSON.stringify([
    project.currentRevisionId,
    project.updatedAt,
  ]), 'utf8').toString('base64url')
  return `W/"project.${version}"`
}

export function projectVersionTokenFromEtag(value: string | undefined): string | undefined {
  if (!value) return undefined
  return /^(?:W\/)?"([^"\s]+)"$/.exec(value.trim())?.[1]
}

export function projectSettingsVersionMatches(
  project: ProjectVersionSource,
  expectedVersion: string,
): boolean {
  return projectVersionTokenFromEtag(projectSettingsEtag(project)) === expectedVersion
}
