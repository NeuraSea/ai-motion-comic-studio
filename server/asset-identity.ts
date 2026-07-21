import { createHash, randomUUID } from 'node:crypto'

import type { Express, NextFunction, Request, Response } from 'express'

import type { ManjuDatabase, MediaAssetRecord } from './database.js'
import type { JsonObject } from './types.js'

export type AssetIdentityErrorCode =
  | 'ASSET_HANDLE_NOT_FOUND'
  | 'ASSET_VERSION_NOT_FOUND'
  | 'ASSET_VERSION_NOT_IN_FAMILY'
  | 'ASSET_VERSION_UNUSABLE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_REQUEST'
  | 'PRECONDITION_FAILED'
  | 'PRECONDITION_REQUIRED'

export class AssetIdentityError extends Error {
  constructor(
    readonly status: number,
    readonly code: AssetIdentityErrorCode,
    message: string,
    readonly details?: JsonObject,
  ) {
    super(message)
    this.name = 'AssetIdentityError'
  }
}

export interface AssetHandleRecord {
  id: string
  projectId: string
  kind: string
  currentAssetVersionId: string | null
  revision: number
  createdAt: string
  updatedAt: string
}

export interface AssetHandleVersionRecord {
  assetId: string
  projectId: string
  assetVersionId: string
  versionNumber: number
  checksum: string | null
  createdAt: string
  asset: MediaAssetRecord
}

export type AssetBusinessDomain =
  | 'character'
  | 'location'
  | 'prop'
  | 'shot'
  | 'dialogue'
  | 'audio'
  | 'export'
  | 'document'
  | 'other'
  | 'archive'

/**
 * Read-only, sanitized Catalog projection. Generation parameters remain
 * private; the UI receives only enough information to aggregate one stable
 * Asset handle under the business object it belongs to.
 */
export interface AssetBusinessBinding {
  domain: AssetBusinessDomain
  groupKey: string
  groupLabel: string
  episodeId: string | null
  sceneId: string | null
  shotId: string | null
  lineId: string | null
  entityType: 'character' | 'location' | 'prop' | null
  entityId: string | null
  role: string | null
}

export interface AssetVersionSwitchRecord {
  id: string
  projectId: string
  assetId: string
  previousAssetVersionId: string | null
  selectedAssetVersionId: string
  selectedAssetVersionChecksum: string | null
  handleRevision: number
  idempotencyKey: string
  requestFingerprint: string
  changed: boolean
  createdAt: string
}

export interface AssetHandleSummary {
  handle: AssetHandleRecord
  currentVersion: MediaAssetRecord | null
  versionCount: number
  businessBinding: AssetBusinessBinding
  etag: string
}

export interface AssetVersionSwitchResult extends AssetHandleSummary {
  selectedVersion: MediaAssetRecord
  audit: AssetVersionSwitchRecord
  idempotent: boolean
  providerCallRequired: false
}

interface AssetIdentityDependencies {
  database: ManjuDatabase
  publicAsset(asset: MediaAssetRecord): JsonObject
  onCurrentVersionChanged?: (result: AssetVersionSwitchResult) => void
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function checksum(value: unknown): string | null {
  const normalized = text(value)
  return normalized && /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

function identifier(value: unknown, label: string): string {
  const normalized = text(value)
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AssetIdentityError(400, 'INVALID_REQUEST', `${label} 格式无效`)
  }
  return normalized
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parameterText(parameters: JsonObject, key: string): string | null {
  return text(parameters[key])
}

function nestedParameterText(parameters: JsonObject, parent: string, key: string): string | null {
  const nested = record(parameters[parent])
  return text(nested?.[key])
}

function publicStoryIdExpression(table: string): string {
  return `CASE
    WHEN typeof(json_extract(${table}.metadata_json, '$.storyId')) = 'text'
      AND length(trim(json_extract(${table}.metadata_json, '$.storyId'))) > 0
    THEN json_extract(${table}.metadata_json, '$.storyId')
    ELSE ${table}.id
  END`
}

function entityLabel(
  database: ManjuDatabase,
  input: {
    projectId: string
    episodeId: string | null
    entityType: 'character' | 'location' | 'prop'
    entityId: string
  },
): string | null {
  const table = `${input.entityType}s`
  const row = database.withSql((sql) => sql.get(`
    SELECT name
    FROM ${table}
    WHERE project_id = ?
      AND (? IS NULL OR episode_id = ? OR episode_id IS NULL)
      AND (${publicStoryIdExpression(table)} = ? OR ${table}.id = ?)
    ORDER BY CASE WHEN episode_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `,
  input.projectId,
  input.episodeId,
  input.episodeId,
  input.entityId,
  input.entityId,
  input.episodeId,
  ))
  return text(row?.name)
}

function shotLabel(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string | null; shotId: string },
): { label: string; sceneId: string | null } | null {
  const row = database.withSql((sql) => sql.get(`
    SELECT
      shots.code,
      shots.title,
      ${publicStoryIdExpression('scenes')} AS public_scene_id
    FROM shots
    JOIN scenes ON scenes.id = shots.scene_id
    JOIN episodes ON episodes.id = scenes.episode_id
    WHERE episodes.project_id = ?
      AND (? IS NULL OR episodes.id = ?)
      AND (${publicStoryIdExpression('shots')} = ? OR shots.id = ?)
    LIMIT 1
  `, input.projectId, input.episodeId, input.episodeId, input.shotId, input.shotId))
  if (!row) return null
  const code = text(row.code)
  const title = text(row.title)
  return {
    label: [code, title].filter(Boolean).join(' · ') || `镜头 ${input.shotId}`,
    sceneId: text(row.public_scene_id),
  }
}

function dialogueLabel(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string | null; lineId: string },
): { label: string; sceneId: string | null; shotId: string | null } | null {
  const row = database.withSql((sql) => sql.get(`
    SELECT
      dialogue_lines.kind,
      dialogue_lines.text,
      characters.name AS character_name,
      shots.code,
      ${publicStoryIdExpression('shots')} AS public_shot_id,
      ${publicStoryIdExpression('scenes')} AS public_scene_id
    FROM dialogue_lines
    JOIN shots ON shots.id = dialogue_lines.shot_id
    JOIN scenes ON scenes.id = shots.scene_id
    JOIN episodes ON episodes.id = scenes.episode_id
    LEFT JOIN characters ON characters.id = dialogue_lines.character_id
    WHERE episodes.project_id = ?
      AND (? IS NULL OR episodes.id = ?)
      AND (${publicStoryIdExpression('dialogue_lines')} = ? OR dialogue_lines.id = ?)
    LIMIT 1
  `, input.projectId, input.episodeId, input.episodeId, input.lineId, input.lineId))
  if (!row) return null
  const speaker = text(row.character_name) ?? (text(row.kind) === 'narration' ? '旁白' : '台词')
  const content = text(row.text) ?? ''
  const excerpt = content.length > 24 ? `${content.slice(0, 24)}…` : content
  const code = text(row.code)
  return {
    label: `${code ? `${code} · ` : ''}${speaker}${excerpt ? `：${excerpt}` : ''}`,
    sceneId: text(row.public_scene_id),
    shotId: text(row.public_shot_id),
  }
}

function latestHandleVersion(
  database: ManjuDatabase,
  handle: AssetHandleRecord,
): MediaAssetRecord | null {
  const row = database.withSql((sql) => sql.get(`
    SELECT asset_version_id
    FROM asset_handle_versions
    WHERE project_id = ? AND asset_id = ?
    ORDER BY version_number DESC
    LIMIT 1
  `, handle.projectId, handle.id))
  const assetVersionId = text(row?.asset_version_id)
  return assetVersionId ? database.getMediaAsset(assetVersionId) ?? null : null
}

function businessBinding(
  database: ManjuDatabase,
  handle: AssetHandleRecord,
  asset: MediaAssetRecord | null,
  versionCount: number,
): AssetBusinessBinding {
  if (!asset || versionCount === 0) {
    return {
      domain: 'archive',
      groupKey: 'archive',
      groupLabel: '已归档 / 无可用版本',
      episodeId: null,
      sceneId: null,
      shotId: null,
      lineId: null,
      entityType: null,
      entityId: null,
      role: null,
    }
  }
  const parameters = asset.generationParameters
  const episodeId = asset.episodeId ?? parameterText(parameters, 'episodeId')
  const rawEntityType = parameterText(parameters, 'entityType')
    ?? nestedParameterText(parameters, 'assetEntityBinding', 'entityType')
  const entityType = rawEntityType === 'character' || rawEntityType === 'location' || rawEntityType === 'prop'
    ? rawEntityType
    : null
  const entityId = parameterText(parameters, 'entityId')
    ?? nestedParameterText(parameters, 'assetEntityBinding', 'entityId')
    ?? (handle.kind.includes('character.voice') ? parameterText(parameters, 'characterId') : null)
  const role = parameterText(parameters, 'orientation')
    ?? (handle.kind.startsWith('character-reference.') ? handle.kind.split('.').at(-1) ?? null : null)
  if (entityType && entityId) {
    const explicitName = parameterText(parameters, 'entityName')
    const label = explicitName ?? entityLabel(database, {
      projectId: handle.projectId,
      episodeId,
      entityType,
      entityId,
    }) ?? `${{ character: '角色', location: '场景', prop: '道具' }[entityType]} ${entityId}`
    return {
      domain: entityType,
      groupKey: `${entityType}:${entityId}`,
      groupLabel: label,
      episodeId,
      sceneId: null,
      shotId: null,
      lineId: null,
      entityType,
      entityId,
      role,
    }
  }
  const characterId = parameterText(parameters, 'characterId')
  if (characterId) {
    const label = entityLabel(database, {
      projectId: handle.projectId,
      episodeId,
      entityType: 'character',
      entityId: characterId,
    }) ?? `角色 ${characterId}`
    return {
      domain: 'character',
      groupKey: `character:${characterId}`,
      groupLabel: label,
      episodeId,
      sceneId: null,
      shotId: null,
      lineId: null,
      entityType: 'character',
      entityId: characterId,
      role,
    }
  }
  const lineId = parameterText(parameters, 'lineId')
  if (lineId || handle.kind === 'speech') {
    const identity = lineId ? dialogueLabel(database, {
      projectId: handle.projectId,
      episodeId,
      lineId,
    }) : null
    return {
      domain: 'dialogue',
      groupKey: `dialogue:${episodeId ?? 'project'}:${lineId ?? handle.id}`,
      groupLabel: identity?.label ?? (lineId ? `台词 ${lineId}` : '未关联台词的语音'),
      episodeId,
      sceneId: identity?.sceneId ?? null,
      shotId: identity?.shotId ?? null,
      lineId,
      entityType: null,
      entityId: null,
      role,
    }
  }
  const shotId = parameterText(parameters, 'shotId')
  if (shotId || handle.kind === 'storyboard' || handle.kind === 'shot.video') {
    const identity = shotId ? shotLabel(database, {
      projectId: handle.projectId,
      episodeId,
      shotId,
    }) : null
    return {
      domain: 'shot',
      groupKey: `shot:${episodeId ?? 'project'}:${shotId ?? handle.id}`,
      groupLabel: identity?.label ?? (shotId ? `镜头 ${shotId}` : '未关联镜头的素材'),
      episodeId,
      sceneId: parameterText(parameters, 'sceneId') ?? identity?.sceneId ?? null,
      shotId,
      lineId: null,
      entityType: null,
      entityId: null,
      role,
    }
  }
  if (handle.kind.includes('export') || asset.source === 'renderer') {
    return {
      domain: 'export',
      groupKey: `export:${episodeId ?? 'project'}`,
      groupLabel: episodeId ? '剧集成片与导出' : '项目成片与导出',
      episodeId,
      sceneId: null,
      shotId: null,
      lineId: null,
      entityType: null,
      entityId: null,
      role,
    }
  }
  if (handle.kind === 'bgm' || handle.kind === 'sfx' || asset.mimeType?.startsWith('audio/')) {
    return {
      domain: 'audio',
      groupKey: `audio:${episodeId ?? 'project'}`,
      groupLabel: episodeId ? '剧集音乐与音效' : '项目音乐与音效',
      episodeId,
      sceneId: null,
      shotId: null,
      lineId: null,
      entityType: null,
      entityId: null,
      role,
    }
  }
  if (handle.kind.includes('script') || handle.kind === 'story' || handle.kind === 'text') {
    return {
      domain: 'document',
      groupKey: `document:${episodeId ?? 'project'}`,
      groupLabel: episodeId ? '剧集脚本与文档' : '项目脚本与文档',
      episodeId,
      sceneId: null,
      shotId: null,
      lineId: null,
      entityType: null,
      entityId: null,
      role,
    }
  }
  return {
    domain: 'other',
    groupKey: `other:${episodeId ?? 'project'}`,
    groupLabel: episodeId ? '剧集未归类素材' : '项目未归类素材',
    episodeId,
    sceneId: null,
    shotId: null,
    lineId: null,
    entityType: null,
    entityId: null,
    role,
  }
}

function asHandle(row: Record<string, unknown>): AssetHandleRecord {
  const id = text(row.id)
  const projectId = text(row.project_id)
  const kind = text(row.kind)
  const revision = integer(row.revision)
  const createdAt = text(row.created_at)
  const updatedAt = text(row.updated_at)
  if (!id || !projectId || !kind || !revision || !createdAt || !updatedAt) {
    throw new Error('Database contains an invalid Asset handle')
  }
  return {
    id,
    projectId,
    kind,
    currentAssetVersionId: text(row.current_asset_version_id),
    revision,
    createdAt,
    updatedAt,
  }
}

function asSwitch(row: Record<string, unknown>): AssetVersionSwitchRecord {
  const id = text(row.id)
  const projectId = text(row.project_id)
  const assetId = text(row.asset_id)
  const selectedAssetVersionId = text(row.selected_asset_version_id)
  const handleRevision = integer(row.handle_revision)
  const idempotencyKey = text(row.idempotency_key)
  const requestFingerprint = text(row.request_fingerprint)
  const createdAt = text(row.created_at)
  if (!id || !projectId || !assetId || !selectedAssetVersionId || !handleRevision
    || !idempotencyKey || !requestFingerprint || !createdAt) {
    throw new Error('Database contains an invalid Asset version switch')
  }
  return {
    id,
    projectId,
    assetId,
    previousAssetVersionId: text(row.previous_asset_version_id),
    selectedAssetVersionId,
    selectedAssetVersionChecksum: text(row.selected_asset_version_checksum),
    handleRevision,
    idempotencyKey,
    requestFingerprint,
    changed: row.changed === 1,
    createdAt,
  }
}

function getHandle(
  database: ManjuDatabase,
  projectId: string,
  assetId: string,
): AssetHandleRecord | undefined {
  const row = database.withSql((sql) => sql.get(`
    SELECT * FROM asset_handles WHERE id = ? AND project_id = ?
  `, assetId, projectId))
  return row ? asHandle(row) : undefined
}

/** Resolve a flat MediaAsset version ID to its stable project-level Asset ID. */
export function stableAssetIdForVersion(
  database: ManjuDatabase,
  projectId: string,
  assetVersionId: string,
): string | null {
  const row = database.withSql((sql) => sql.get(`
    SELECT asset_id
    FROM asset_handle_versions
    WHERE project_id = ? AND asset_version_id = ?
  `, projectId, assetVersionId))
  return text(row?.asset_id)
}

function resolveHandleByIdentity(
  database: ManjuDatabase,
  projectId: string,
  identity: { assetId?: string; assetVersionId?: string },
): AssetHandleRecord | undefined {
  if (identity.assetId) return getHandle(database, projectId, identity.assetId)
  if (!identity.assetVersionId) return undefined
  const stableId = stableAssetIdForVersion(database, projectId, identity.assetVersionId)
  return stableId ? getHandle(database, projectId, stableId) : undefined
}

export function assetHandleEtag(handle: AssetHandleRecord): string {
  const fingerprint = createHash('sha256')
    .update(`asset-handle\0${handle.projectId}\0${handle.id}\0${handle.revision}`)
    .digest('hex')
  return `"asset-handle-v1-${fingerprint}"`
}

function handleSummary(database: ManjuDatabase, handle: AssetHandleRecord): AssetHandleSummary {
  const count = database.withSql((sql) => sql.get(`
    SELECT count(*) AS count
    FROM asset_handle_versions
    WHERE project_id = ? AND asset_id = ?
  `, handle.projectId, handle.id))
  const versionCount = integer(count?.count)
  if (versionCount === null || versionCount < 0) throw new Error('Asset version count is invalid')
  const currentVersion = handle.currentAssetVersionId
    ? database.getMediaAsset(handle.currentAssetVersionId) ?? null
    : null
  const catalogVersion = currentVersion ?? latestHandleVersion(database, handle)
  return {
    handle,
    currentVersion,
    versionCount,
    businessBinding: businessBinding(database, handle, catalogVersion, versionCount),
    etag: assetHandleEtag(handle),
  }
}

function requestFingerprint(input: {
  projectId: string
  assetId: string
  assetVersionId: string
}): string {
  return createHash('sha256')
    .update(`asset-version-switch-v1\0${input.projectId}\0${input.assetId}\0${input.assetVersionId}`)
    .digest('hex')
}

function priorSwitch(
  database: ManjuDatabase,
  projectId: string,
  idempotencyKey: string,
): AssetVersionSwitchRecord | undefined {
  const row = database.withSql((sql) => sql.get(`
    SELECT * FROM asset_version_switches
    WHERE project_id = ? AND idempotency_key = ?
  `, projectId, idempotencyKey))
  return row ? asSwitch(row) : undefined
}

function switchReplay(
  database: ManjuDatabase,
  audit: AssetVersionSwitchRecord,
  expectedFingerprint: string,
): AssetVersionSwitchResult {
  if (audit.requestFingerprint !== expectedFingerprint) {
    throw new AssetIdentityError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他素材版本切换')
  }
  const handle = getHandle(database, audit.projectId, audit.assetId)
  const selectedVersion = database.getMediaAsset(audit.selectedAssetVersionId)
  if (!handle || !selectedVersion) {
    throw new AssetIdentityError(409, 'ASSET_VERSION_UNUSABLE', '原版本切换记录所指向的素材已不可用')
  }
  return {
    ...handleSummary(database, handle),
    selectedVersion,
    audit,
    idempotent: true,
    providerCallRequired: false,
  }
}

export class AssetIdentityService {
  constructor(private readonly dependencies: AssetIdentityDependencies) {}

  list(input: {
    projectId: string
    episodeId?: string
    kind?: string
    assetVersionId?: string
    limit?: number
  }): AssetHandleSummary[] {
    const limit = input.limit ?? 200
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new AssetIdentityError(400, 'INVALID_REQUEST', 'limit 必须是 1 到 1000 的整数')
    }
    if (input.assetVersionId) {
      const handle = resolveHandleByIdentity(this.dependencies.database, input.projectId, {
        assetVersionId: input.assetVersionId,
      })
      if (!handle || (input.kind !== undefined && handle.kind !== input.kind)) return []
      if (input.episodeId !== undefined) {
        const episodeId = input.episodeId
        const belongsToEpisode = this.dependencies.database.withSql((sql) => sql.get(`
          SELECT 1 AS present
          FROM asset_handle_versions AS member
          JOIN media_assets AS version ON version.id = member.asset_version_id
          WHERE member.project_id = ?
            AND member.asset_id = ?
            AND version.episode_id = ?
          LIMIT 1
        `, input.projectId, handle.id, episodeId))
        if (!belongsToEpisode) return []
      }
      return [handleSummary(this.dependencies.database, handle)]
    }
    const rows = this.dependencies.database.withSql((sql) => sql.all(`
      SELECT handle.*
      FROM asset_handles AS handle
      WHERE handle.project_id = ?
        AND (? IS NULL OR handle.kind = ?)
        AND (
          ? IS NULL
          OR EXISTS (
            SELECT 1
            FROM asset_handle_versions AS member
            JOIN media_assets AS version ON version.id = member.asset_version_id
            WHERE member.asset_id = handle.id
              AND member.project_id = handle.project_id
              AND version.episode_id = ?
          )
        )
      ORDER BY handle.updated_at DESC, handle.id ASC
      LIMIT ?
    `,
    input.projectId,
    input.kind ?? null,
    input.kind ?? null,
    input.episodeId ?? null,
    input.episodeId ?? null,
    limit,
    ))
    return rows.map((row) => handleSummary(this.dependencies.database, asHandle(row)))
  }

  versions(input: {
    projectId: string
    assetId?: string
    assetVersionId?: string
  }): { summary: AssetHandleSummary; versions: AssetHandleVersionRecord[] } {
    const handle = resolveHandleByIdentity(this.dependencies.database, input.projectId, input)
    if (!handle) {
      throw new AssetIdentityError(404, 'ASSET_HANDLE_NOT_FOUND', '素材不存在或不属于指定项目')
    }
    const rows = this.dependencies.database.withSql((sql) => sql.all(`
      SELECT asset_version_id, version_number, checksum, created_at
      FROM asset_handle_versions
      WHERE project_id = ? AND asset_id = ?
      ORDER BY version_number DESC
      LIMIT 1000
    `, input.projectId, handle.id))
    const versions = rows.map((row): AssetHandleVersionRecord => {
      const assetVersionId = text(row.asset_version_id)
      const versionNumber = integer(row.version_number)
      const createdAt = text(row.created_at)
      const asset = assetVersionId ? this.dependencies.database.getMediaAsset(assetVersionId) : undefined
      if (!assetVersionId || !versionNumber || !createdAt || !asset) {
        throw new Error('Database contains an invalid Asset version membership')
      }
      return {
        assetId: handle.id,
        projectId: input.projectId,
        assetVersionId,
        versionNumber,
        checksum: text(row.checksum),
        createdAt,
        asset,
      }
    })
    return { summary: handleSummary(this.dependencies.database, handle), versions }
  }

  switchCurrentVersion(input: {
    projectId: string
    assetId: string
    assetVersionId: string
    ifMatch: string
    idempotencyKey: string
  }): AssetVersionSwitchResult {
    const fingerprint = requestFingerprint(input)
    const prior = priorSwitch(this.dependencies.database, input.projectId, input.idempotencyKey)
    if (prior) return switchReplay(this.dependencies.database, prior, fingerprint)

    const result = this.dependencies.database.transaction((database) => {
      const raced = priorSwitch(database, input.projectId, input.idempotencyKey)
      if (raced) return switchReplay(database, raced, fingerprint)
      const handle = getHandle(database, input.projectId, input.assetId)
      if (!handle) {
        throw new AssetIdentityError(404, 'ASSET_HANDLE_NOT_FOUND', '素材不存在或不属于指定项目')
      }
      const currentEtag = assetHandleEtag(handle)
      if (input.ifMatch !== currentEtag) {
        throw new AssetIdentityError(412, 'PRECONDITION_FAILED', '素材当前版本已更改，请刷新后重试', {
          assetId: handle.id,
          currentAssetVersionId: handle.currentAssetVersionId,
          currentEtag,
        })
      }
      const member = database.withSql((sql) => sql.get(`
        SELECT media_assets.id, asset_handle_versions.checksum AS sealed_checksum
        FROM asset_handle_versions
        JOIN media_assets ON media_assets.id = asset_handle_versions.asset_version_id
        WHERE asset_handle_versions.project_id = ?
          AND asset_handle_versions.asset_id = ?
          AND asset_handle_versions.asset_version_id = ?
      `, input.projectId, input.assetId, input.assetVersionId))
      if (!member) {
        const outsideFamily = database.getMediaAsset(input.assetVersionId)
        if (outsideFamily?.projectId === input.projectId) {
          throw new AssetIdentityError(409, 'ASSET_VERSION_NOT_IN_FAMILY', '所选版本不属于该素材')
        }
        throw new AssetIdentityError(404, 'ASSET_VERSION_NOT_FOUND', '所选素材版本不存在')
      }
      const selectedVersion = database.getMediaAsset(input.assetVersionId)
      if (!selectedVersion
        || selectedVersion.status !== 'ready'
        || !checksum(selectedVersion.checksum)
        || checksum(member.sealed_checksum) !== selectedVersion.checksum) {
        throw new AssetIdentityError(409, 'ASSET_VERSION_UNUSABLE', '只能切换到已就绪且可核验的素材版本')
      }
      const changed = handle.currentAssetVersionId !== selectedVersion.id
      const nextRevision = changed ? handle.revision + 1 : handle.revision
      const now = new Date().toISOString()
      if (changed) {
        const updated = database.withSql((sql) => sql.run(`
          UPDATE asset_handles
          SET current_asset_version_id = ?, revision = ?, updated_at = ?
          WHERE id = ? AND project_id = ? AND revision = ?
        `,
        selectedVersion.id,
        nextRevision,
        now,
        handle.id,
        handle.projectId,
        handle.revision,
        ))
        if (updated.changes !== 1) {
          throw new AssetIdentityError(412, 'PRECONDITION_FAILED', '素材当前版本已更改，请刷新后重试')
        }
      }
      const auditId = randomUUID()
      database.withSql((sql) => sql.run(`
        INSERT INTO asset_version_switches (
          id, project_id, asset_id, previous_asset_version_id,
          selected_asset_version_id, selected_asset_version_checksum,
          handle_revision, idempotency_key, request_fingerprint, changed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      auditId,
      input.projectId,
      handle.id,
      handle.currentAssetVersionId,
      selectedVersion.id,
      selectedVersion.checksum,
      nextRevision,
      input.idempotencyKey,
      fingerprint,
      changed ? 1 : 0,
      now,
      ))
      const currentHandle = getHandle(database, input.projectId, input.assetId)
      const audit = priorSwitch(database, input.projectId, input.idempotencyKey)
      if (!currentHandle || !audit) throw new Error('Asset version switch transaction disappeared')
      return {
        ...handleSummary(database, currentHandle),
        selectedVersion,
        audit,
        idempotent: false,
        providerCallRequired: false as const,
      }
    })
    if (!result.idempotent) this.dependencies.onCurrentVersionChanged?.(result)
    return result
  }

  publicSummary(summary: AssetHandleSummary): JsonObject {
    return {
      assetId: summary.handle.id,
      projectId: summary.handle.projectId,
      kind: summary.handle.kind,
      currentAssetVersionId: summary.handle.currentAssetVersionId,
      revision: summary.handle.revision,
      versionCount: summary.versionCount,
      businessBinding: {
        domain: summary.businessBinding.domain,
        groupKey: summary.businessBinding.groupKey,
        groupLabel: summary.businessBinding.groupLabel,
        episodeId: summary.businessBinding.episodeId,
        sceneId: summary.businessBinding.sceneId,
        shotId: summary.businessBinding.shotId,
        lineId: summary.businessBinding.lineId,
        entityType: summary.businessBinding.entityType,
        entityId: summary.businessBinding.entityId,
        role: summary.businessBinding.role,
      },
      etag: summary.etag,
      currentVersion: summary.currentVersion
        ? this.dependencies.publicAsset(summary.currentVersion)
        : null,
      createdAt: summary.handle.createdAt,
      updatedAt: summary.handle.updatedAt,
    }
  }
}

function queryText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) throw new AssetIdentityError(400, 'INVALID_REQUEST', `${label} 不允许重复`)
  return identifier(value, label)
}

function queryLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const normalized = queryText(value, 'limit')
  if (!normalized || !/^\d+$/.test(normalized)) {
    throw new AssetIdentityError(400, 'INVALID_REQUEST', 'limit 格式无效')
  }
  return Number(normalized)
}

function ifMatch(request: Request): string {
  const value = request.get('if-match')?.trim()
  if (!value) throw new AssetIdentityError(428, 'PRECONDITION_REQUIRED', '必须提供 If-Match 素材版本')
  if (value.length > 200 || value.includes(',')) {
    throw new AssetIdentityError(400, 'INVALID_REQUEST', 'If-Match 格式无效')
  }
  return value
}

function idempotencyKey(request: Request): string {
  const value = request.get('idempotency-key')?.trim()
  if (!value) throw new AssetIdentityError(400, 'IDEMPOTENCY_KEY_REQUIRED', '必须提供 Idempotency-Key')
  if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AssetIdentityError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 格式无效')
  }
  return value
}

export function mountAssetIdentityRoutes(app: Express, dependencies: AssetIdentityDependencies): void {
  const service = new AssetIdentityService(dependencies)

  app.get('/api/v1/projects/:projectId/asset-handles', (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    try {
      const projectId = identifier(request.params.projectId, 'projectId')
      if (!dependencies.database.getProject(projectId)) {
        throw new AssetIdentityError(404, 'ASSET_HANDLE_NOT_FOUND', '项目不存在')
      }
      const summaries = service.list({
        projectId,
        episodeId: queryText(request.query.episodeId, 'episodeId'),
        kind: queryText(request.query.kind, 'kind'),
        assetVersionId: queryText(request.query.assetVersionId, 'assetVersionId'),
        limit: queryLimit(request.query.limit),
      })
      response.json({ assets: summaries.map((summary) => service.publicSummary(summary)) })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/v1/projects/:projectId/asset-handles/:assetId/versions', (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    try {
      const result = service.versions({
        projectId: identifier(request.params.projectId, 'projectId'),
        assetId: identifier(request.params.assetId, 'assetId'),
      })
      response.setHeader('ETag', result.summary.etag)
      response.json({
        asset: service.publicSummary(result.summary),
        versions: result.versions.map((version) => ({
          assetId: version.assetId,
          assetVersionId: version.assetVersionId,
          versionNumber: version.versionNumber,
          checksum: version.checksum,
          createdAt: version.createdAt,
          version: dependencies.publicAsset(version.asset),
        })),
      })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/v1/projects/:projectId/asset-handles/:assetId/current-version', (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    try {
      const body = record(request.body)
      if (!body) throw new AssetIdentityError(400, 'INVALID_REQUEST', '素材版本切换请求必须是 JSON 对象')
      const unknown = Object.keys(body).filter((key) => key !== 'assetVersionId')
      if (unknown.length > 0) {
        throw new AssetIdentityError(400, 'INVALID_REQUEST', `不支持的素材版本切换参数: ${unknown.join(', ')}`)
      }
      const result = service.switchCurrentVersion({
        projectId: identifier(request.params.projectId, 'projectId'),
        assetId: identifier(request.params.assetId, 'assetId'),
        assetVersionId: identifier(body.assetVersionId, 'assetVersionId'),
        ifMatch: ifMatch(request),
        idempotencyKey: idempotencyKey(request),
      })
      response.setHeader('ETag', result.etag)
      response.status(result.idempotent ? 200 : 201).json({
        asset: service.publicSummary(result),
        switch: {
          id: result.audit.id,
          assetId: result.audit.assetId,
          previousAssetVersionId: result.audit.previousAssetVersionId,
          selectedAssetVersionId: result.audit.selectedAssetVersionId,
          selectedAssetVersionChecksum: result.audit.selectedAssetVersionChecksum,
          handleRevision: result.audit.handleRevision,
          changed: result.audit.changed,
          createdAt: result.audit.createdAt,
          idempotent: result.idempotent,
          providerCallRequired: false,
        },
      })
    } catch (error) {
      next(error)
    }
  })
}
