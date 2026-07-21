import { createHash } from 'node:crypto'

import type { ManjuDatabase } from './database.js'
import type { JsonObject } from './types.js'

export const MEDIA_AUTHORITY_FINGERPRINT_FIELD = 'mediaAuthorityFingerprint'

interface MediaAuthorityAssetPin {
  assetId: string | null
  version: number | null
  checksum: string | null
}

export interface CurrentMediaAuthority {
  sourceRevisionId: string | null
  fingerprint: string
  /** A review changed a current media pointer, so export must require a receipt. */
  receiptRequired: boolean
}

export interface TimelineMediaAuthorityReceipt {
  timelineRevisionId: string
  documentId: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  fingerprint: string
}

function assetPin(
  assetId: unknown,
  version: unknown,
  checksum: unknown,
): MediaAuthorityAssetPin {
  return {
    assetId: typeof assetId === 'string' ? assetId : null,
    version: Number.isSafeInteger(version) && (version as number) >= 1
      ? version as number
      : null,
    checksum: typeof checksum === 'string' ? checksum : null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Hash the mutable media authority that Story materialization consumes. The
 * payload is built only from SQLite facts and sorted relational identities;
 * no client timeline state participates in this receipt.
 */
export function currentMediaAuthority(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string },
): CurrentMediaAuthority {
  const episode = database.withSql((sql) => sql.get(`
    SELECT project_id, source_revision_id
      FROM episodes
     WHERE id = ?
  `, input.episodeId))
  if (!episode || episode.project_id !== input.projectId) {
    throw new Error(`Media authority scope does not exist: ${input.projectId}/${input.episodeId}`)
  }
  const sourceRevisionId = typeof episode.source_revision_id === 'string'
    ? episode.source_revision_id
    : null
  const rows = database.withSql((sql) => sql.all(`
    SELECT
      scenes.id AS scene_id,
      scenes.sequence AS scene_sequence,
      shots.id AS shot_id,
      shots.sequence AS shot_sequence,
      shots.source_revision_id AS shot_source_revision_id,
      shots.storyboard_asset_id,
      storyboard.version AS storyboard_version,
      storyboard.checksum AS storyboard_checksum,
      shots.video_asset_id,
      video.version AS video_version,
      video.checksum AS video_checksum
    FROM scenes
    JOIN shots ON shots.scene_id = scenes.id
    LEFT JOIN media_assets AS storyboard ON storyboard.id = shots.storyboard_asset_id
    LEFT JOIN media_assets AS video ON video.id = shots.video_asset_id
    WHERE scenes.episode_id = ?
    ORDER BY scenes.sequence, scenes.id, shots.sequence, shots.id
  `, input.episodeId))
  const payload = {
    version: 1,
    projectId: input.projectId,
    episodeId: input.episodeId,
    sourceRevisionId,
    shots: rows.map((row) => ({
      sceneId: row.scene_id,
      sceneSequence: row.scene_sequence,
      shotId: row.shot_id,
      shotSequence: row.shot_sequence,
      sourceRevisionId: row.shot_source_revision_id,
      storyboard: assetPin(
        row.storyboard_asset_id,
        row.storyboard_version,
        row.storyboard_checksum,
      ),
      video: assetPin(row.video_asset_id, row.video_version, row.video_checksum),
    })),
  }
  const receiptRequired = sourceRevisionId !== null && Boolean(database.withSql((sql) => sql.get(`
    SELECT 1 AS required
      FROM shot_media_review_decisions
     WHERE project_id = ?
       AND episode_id = ?
       AND source_revision_id = ?
       AND timeline_reconcile_required = 1
     LIMIT 1
  `, input.projectId, input.episodeId, sourceRevisionId)))
  return {
    sourceRevisionId,
    fingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    receiptRequired,
  }
}

export function mediaAuthorityFingerprint(document: JsonObject): string | null {
  const integration = document.manjuTimeline
  if (!isRecord(integration)) return null
  const value = integration[MEDIA_AUTHORITY_FINGERPRINT_FIELD]
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
}

export function timelineMediaAuthorityReceipt(
  database: ManjuDatabase,
  timelineRevisionId: string,
): TimelineMediaAuthorityReceipt | null {
  const row = database.withSql((sql) => sql.get(`
    SELECT timeline_revision_id, document_id, project_id, episode_id,
           source_revision_id, fingerprint
      FROM timeline_media_authority_receipts
     WHERE timeline_revision_id = ?
  `, timelineRevisionId))
  if (!row) return null
  const values = [
    row.timeline_revision_id,
    row.document_id,
    row.project_id,
    row.episode_id,
    row.source_revision_id,
    row.fingerprint,
  ]
  if (!values.every((value) => typeof value === 'string')
    || !/^[a-f0-9]{64}$/.test(row.fingerprint as string)) {
    throw new Error(`Timeline media authority receipt is corrupt: ${timelineRevisionId}`)
  }
  return {
    timelineRevisionId: row.timeline_revision_id as string,
    documentId: row.document_id as string,
    projectId: row.project_id as string,
    episodeId: row.episode_id as string,
    sourceRevisionId: row.source_revision_id as string,
    fingerprint: row.fingerprint as string,
  }
}

/** Trusted materialize/reconcile writer. */
export function setMediaAuthorityFingerprint(
  document: JsonObject,
  fingerprint: string,
): void {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('Media authority fingerprint is invalid')
  }
  const integration = isRecord(document.manjuTimeline) ? document.manjuTimeline : {}
  document.manjuTimeline = {
    ...integration,
    [MEDIA_AUTHORITY_FINGERPRINT_FIELD]: fingerprint,
  }
}

/**
 * Project a separately trusted durable receipt into a public snapshot. The
 * snapshot value is never itself a trust source: ordinary saves call this
 * with `null`, while materialize/reconcile first persist an exact DB binding.
 */
export function withServerMediaAuthorityFingerprint(
  document: JsonObject,
  trustedFingerprint: string | null,
): JsonObject {
  const next = structuredClone(document)
  const integration = isRecord(next.manjuTimeline) ? { ...next.manjuTimeline } : {}
  delete integration[MEDIA_AUTHORITY_FINGERPRINT_FIELD]
  if (trustedFingerprint) {
    if (!/^[a-f0-9]{64}$/.test(trustedFingerprint)) {
      throw new Error('Trusted media authority fingerprint is invalid')
    }
    integration[MEDIA_AUTHORITY_FINGERPRINT_FIELD] = trustedFingerprint
  }
  if (Object.keys(integration).length > 0) next.manjuTimeline = integration as JsonObject
  else delete next.manjuTimeline
  return next
}
