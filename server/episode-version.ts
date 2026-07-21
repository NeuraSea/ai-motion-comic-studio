export interface EpisodeVersionSource {
  sourceRevisionId: string | null
  updatedAt: string
}

/** Opaque HTTP version for every Episode-scoped optimistic write. */
export function episodeEtag(episode: EpisodeVersionSource): string {
  const version = Buffer.from(JSON.stringify([
    episode.sourceRevisionId,
    episode.updatedAt,
  ]), 'utf8').toString('base64url')
  return `W/"episode.${version}"`
}

export function versionTokenFromEtag(value: string | undefined): string | undefined {
  if (!value) return undefined
  return /^(?:W\/)?"([^"\s]+)"$/.exec(value.trim())?.[1]
}

export function episodeVersionMatches(
  episode: EpisodeVersionSource,
  expectedVersion: string,
): boolean {
  return versionTokenFromEtag(episodeEtag(episode)) === expectedVersion
}
