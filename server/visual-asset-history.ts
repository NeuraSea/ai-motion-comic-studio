import { createHash, randomUUID } from 'node:crypto'

import type { Express, NextFunction, Request, Response } from 'express'

import type {
  GenerationJobRecord,
  ManjuDatabase,
  MediaAssetRecord,
  RevisionRecord,
} from './database.js'
import { stableAssetIdForVersion } from './asset-identity.js'
import { episodeEtag, episodeVersionMatches, versionTokenFromEtag } from './episode-version.js'
import { MediaStore } from './media.js'
import type { JsonObject, JsonValue } from './types.js'
import {
  resolveVisualAssetEntity,
  type VisualAssetEntityBinding,
  type VisualAssetEntityType,
  VISUAL_ASSET_ENTITY_TYPES,
} from './visual-asset-generation.js'

export const VISUAL_ASSET_HISTORY_ADOPTION_JOB_TYPE = 'asset.image.history.adopt'

const EXPECTED_KINDS: Record<VisualAssetEntityType, string> = {
  character: 'character-turnaround',
  location: 'location-concept',
  prop: 'prop-concept',
}

export type VisualAssetHistoryErrorCode =
  | 'ASSET_NOT_FOUND'
  | 'EPISODE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_REQUEST'
  | 'PRECONDITION_REQUIRED'
  | 'REVISION_CONFLICT'
  | 'SOURCE_REVISION_MISSING'
  | 'VISUAL_ASSET_HISTORY_INCOMPATIBLE'

export class VisualAssetHistoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: VisualAssetHistoryErrorCode,
    message: string,
    readonly details?: JsonObject,
  ) {
    super(message)
    this.name = 'VisualAssetHistoryError'
  }
}

interface EpisodeAuthority {
  projectId: string
  episodeId: string
  sourceRevisionId: string
  stylePreset: string
  aspectRatio: string
  updatedAt: string
}

interface VisualEntitySemantics {
  id: string
  name: string
  description: string
  visualDescription: string
  role: string | null
}

interface VisualSemanticDocument {
  version: 1
  title: string
  bibleVisualStyle: string
  entityType: VisualAssetEntityType
  entity: VisualEntitySemantics
  stylePreset: string
  aspectRatio: string
}

interface CompatibleHistoricalCandidate {
  asset: MediaAssetRecord
  sourceJob: GenerationJobRecord
  currentBinding: VisualAssetEntityBinding
  currentAuthority: EpisodeAuthority
  semanticDocument: VisualSemanticDocument
  semanticFingerprint: string
  assetFamilyId: string
}

export interface PublicHistoricalVisualAssetCandidate {
  asset: JsonObject
  assetFamilyId: string
  assetVersionId: string
  assetVersion: number
  priorSourceRevisionId: string
  currentSourceRevisionId: string
  semanticFingerprint: string
  compatibility: {
    entityIdentity: 'exact'
    visualSemantics: 'exact'
    stylePreset: 'exact'
    aspectRatio: 'exact'
    providerCallRequired: false
  }
}

export interface VisualAssetHistoryListResult {
  episodeId: string
  sourceRevisionId: string
  entityType: VisualAssetEntityType
  entityId: string
  episodeEtag: string
  candidates: PublicHistoricalVisualAssetCandidate[]
}

export interface HistoricalVisualAssetAdoptionResult {
  asset: MediaAssetRecord
  sourceAsset: MediaAssetRecord
  job: GenerationJobRecord
  revision: RevisionRecord
  assetFamilyId: string
  assetVersionId: string
  previousAssetVersionId: string
  sourceRevisionId: string
  priorSourceRevisionId: string
  semanticFingerprint: string
  episodeEtag: string
  idempotent: boolean
}

interface AdoptHistoricalVisualAssetInput {
  projectId: string
  episodeId: string
  entityType: VisualAssetEntityType
  entityId: string
  sourceAssetId: string
  expectedEpisodeVersion: string
  idempotencyKey: string
}

interface VisualAssetHistoryDependencies {
  database: ManjuDatabase
  mediaStore: MediaStore
  admit<T>(operation: () => Promise<T>): Promise<T>
  publicAsset(asset: MediaAssetRecord): JsonObject
  publicJob(job: GenerationJobRecord): JsonObject
  onAdopted?: (result: HistoricalVisualAssetAdoptionResult) => void
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function semanticText(value: unknown): string | null {
  const valueText = text(value)
  return valueText ? valueText.normalize('NFC').replace(/\r\n?/g, '\n').trim() : null
}

function identifier(value: unknown, label: string): string {
  const valueText = text(value)?.trim()
  if (!valueText || valueText.length > 200 || /[\u0000-\u001f\u007f]/.test(valueText)) {
    throw new VisualAssetHistoryError(400, 'INVALID_REQUEST', `${label} 格式无效`)
  }
  return valueText
}

function entityType(value: unknown): VisualAssetEntityType {
  const normalized = identifier(value, 'entityType') as VisualAssetEntityType
  if (!VISUAL_ASSET_ENTITY_TYPES.includes(normalized)) {
    throw new VisualAssetHistoryError(400, 'INVALID_REQUEST', 'entityType 必须是 character、location 或 prop')
  }
  return normalized
}

function episodeAuthority(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string },
): EpisodeAuthority {
  const row = database.withSql((sql) => sql.get(`
    SELECT project_id, id, source_revision_id, style_preset, aspect_ratio, updated_at
    FROM episodes
    WHERE id = ? AND project_id = ?
  `, input.episodeId, input.projectId))
  if (!row) {
    throw new VisualAssetHistoryError(404, 'EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
  }
  const sourceRevisionId = text(row.source_revision_id)
  if (!sourceRevisionId) {
    throw new VisualAssetHistoryError(409, 'SOURCE_REVISION_MISSING', '分集尚未绑定可追溯的剧本修订')
  }
  const stylePreset = semanticText(row.style_preset)
  const aspectRatio = semanticText(row.aspect_ratio)
  const updatedAt = text(row.updated_at)
  if (!stylePreset || !aspectRatio || !updatedAt) {
    throw new VisualAssetHistoryError(409, 'VISUAL_ASSET_HISTORY_INCOMPATIBLE', '当前分集缺少可核验的视觉风格或画幅')
  }
  return {
    projectId: input.projectId,
    episodeId: input.episodeId,
    sourceRevisionId,
    stylePreset,
    aspectRatio,
    updatedAt,
  }
}

function assertExpectedEpisodeVersion(authority: EpisodeAuthority, expectedVersion: string): void {
  if (!episodeVersionMatches(authority, expectedVersion)) {
    throw new VisualAssetHistoryError(
      412,
      'REVISION_CONFLICT',
      '分集已更新，请刷新历史素材候选后重试',
      {
        currentRevisionId: authority.sourceRevisionId,
        currentEtag: episodeEtag(authority),
      },
    )
  }
}

function storyEntity(
  snapshot: JsonObject,
  targetType: VisualAssetEntityType,
  targetId: string,
): VisualEntitySemantics | null {
  const collectionKey = targetType === 'character'
    ? 'characters'
    : targetType === 'location'
      ? 'locations'
      : 'props'
  const values = snapshot[collectionKey]
  if (!Array.isArray(values)) return null
  const matches = values.filter((value) => record(value)?.id === targetId)
  if (matches.length !== 1) return null
  const value = record(matches[0])!
  const id = text(value.id)
  const name = semanticText(value.name)
  const description = semanticText(
    targetType === 'prop' ? value.description : value.storyDescription,
  ) ?? ''
  const visualDescription = semanticText(value.visualDescription) ?? ''
  const role = targetType === 'character' ? semanticText(value.role) : null
  if (!id || !name) return null
  return { id, name, description, visualDescription, role }
}

function semanticDocument(
  revision: RevisionRecord,
  authority: EpisodeAuthority,
  targetType: VisualAssetEntityType,
  targetId: string,
): VisualSemanticDocument | null {
  const title = semanticText(revision.snapshot.title)
  const bible = record(revision.snapshot.bible)
  const bibleVisualStyle = semanticText(bible?.visualStyle)
  const entity = storyEntity(revision.snapshot, targetType, targetId)
  if (!title || !bibleVisualStyle || !entity) return null
  return {
    version: 1,
    title,
    bibleVisualStyle,
    entityType: targetType,
    entity,
    stylePreset: authority.stylePreset,
    aspectRatio: authority.aspectRatio,
  }
}

function fingerprint(value: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function sameSemanticDocument(left: VisualSemanticDocument, right: VisualSemanticDocument): boolean {
  return fingerprint(left as unknown as JsonValue) === fingerprint(right as unknown as JsonValue)
}

function binding(value: unknown): VisualAssetEntityBinding | null {
  const item = record(value)
  if (!item) return null
  const bindingType = item.entityType
  if (!VISUAL_ASSET_ENTITY_TYPES.includes(bindingType as VisualAssetEntityType)) return null
  if (![item.episodeId, item.entityId, item.databaseEntityId, item.expectedRevisionId]
    .every((candidate) => typeof candidate === 'string' && Boolean(candidate))) return null
  if (item.parentAssetId !== null && typeof item.parentAssetId !== 'string') return null
  if (!Number.isInteger(item.nextVersion) || Number(item.nextVersion) < 1) return null
  return item as unknown as VisualAssetEntityBinding
}

function outputContainsAsset(job: GenerationJobRecord, assetId: string): boolean {
  const output = record(job.output)
  return Array.isArray(output?.images) && output.images.some((value) => record(value)?.id === assetId)
}

function liveEntityMatches(
  live: ReturnType<typeof resolveVisualAssetEntity>,
  semantics: VisualEntitySemantics,
): boolean {
  return live.id === semantics.id
    && semanticText(live.name) === semantics.name
    && (semanticText(live.description) ?? '') === semantics.description
    && (semanticText(live.visualDescription) ?? '') === semantics.visualDescription
    && (semanticText(live.role) ?? null) === semantics.role
}

function compatibleCandidate(
  database: ManjuDatabase,
  asset: MediaAssetRecord,
  input: {
    authority: EpisodeAuthority
    entityType: VisualAssetEntityType
    entityId: string
  },
): CompatibleHistoricalCandidate | null {
  if (asset.projectId !== input.authority.projectId
    || asset.episodeId !== input.authority.episodeId
    || asset.sourceRevisionId === null
    || asset.sourceRevisionId === input.authority.sourceRevisionId
    || asset.kind !== EXPECTED_KINDS[input.entityType]
    || asset.status !== 'ready'
    || asset.source !== 'provider'
    || !asset.filePath
    || !asset.mimeType?.startsWith('image/')
    || !asset.checksum?.match(/^[a-f0-9]{64}$/)
    || !asset.generationJobId
    || asset.parentAssetId !== null) return null

  const sourceJob = database.getGenerationJob(asset.generationJobId)
  if (!sourceJob
    || sourceJob.type !== 'asset.image.generate'
    || sourceJob.status !== 'succeeded'
    || sourceJob.projectId !== input.authority.projectId
    || sourceJob.episodeId !== input.authority.episodeId
    || sourceJob.providerId !== asset.providerId
    || !sourceJob.providerId
    || !outputContainsAsset(sourceJob, asset.id)) return null

  const jobBinding = binding(sourceJob.input.assetEntityBinding)
  const jobEpisodeBinding = record(sourceJob.input.episodeBinding)
  const metadata = record(sourceJob.input.metadata)
  const historicalRevisionId = asset.sourceRevisionId
  if (!jobBinding
    || jobBinding.episodeId !== input.authority.episodeId
    || jobBinding.entityType !== input.entityType
    || jobBinding.entityId !== input.entityId
    || jobBinding.expectedRevisionId !== historicalRevisionId
    || jobBinding.parentAssetId !== null
    || metadata?.entityType !== input.entityType
    || metadata?.entityId !== input.entityId
    || metadata?.kind !== EXPECTED_KINDS[input.entityType]
    || jobEpisodeBinding?.episodeId !== input.authority.episodeId
    || jobEpisodeBinding.expectedRevisionId !== historicalRevisionId
    || semanticText(jobEpisodeBinding.stylePreset) !== input.authority.stylePreset
    || semanticText(jobEpisodeBinding.aspectRatio) !== input.authority.aspectRatio) return null

  const parameters = asset.generationParameters
  if (parameters.entityType !== input.entityType
    || parameters.entityId !== input.entityId
    || parameters.sourceRevisionId !== historicalRevisionId
    || semanticText(parameters.stylePreset) !== input.authority.stylePreset
    || semanticText(parameters.aspectRatio) !== input.authority.aspectRatio
    || parameters.prompt !== sourceJob.input.prompt
    || parameters.size !== sourceJob.input.size
    || parameters.quality !== sourceJob.input.quality) return null

  const currentRevision = database.getRevision(input.authority.sourceRevisionId)
  const historicalRevision = database.getRevision(historicalRevisionId)
  if (!currentRevision || !historicalRevision
    || currentRevision.projectId !== input.authority.projectId
    || historicalRevision.projectId !== input.authority.projectId) return null
  const currentSemantics = semanticDocument(
    currentRevision,
    input.authority,
    input.entityType,
    input.entityId,
  )
  const historicalSemantics = semanticDocument(
    historicalRevision,
    input.authority,
    input.entityType,
    input.entityId,
  )
  if (!currentSemantics || !historicalSemantics
    || !sameSemanticDocument(currentSemantics, historicalSemantics)) return null

  const live = resolveVisualAssetEntity(database, {
    projectId: input.authority.projectId,
    episodeId: input.authority.episodeId,
    entityType: input.entityType,
    entityId: input.entityId,
  })
  if (live.databaseId !== jobBinding.databaseEntityId
    || live.sourceRevisionId !== input.authority.sourceRevisionId
    || !liveEntityMatches(live, currentSemantics.entity)) return null

  const currentBinding: VisualAssetEntityBinding = {
    episodeId: input.authority.episodeId,
    entityType: input.entityType,
    entityId: input.entityId,
    databaseEntityId: live.databaseId,
    expectedRevisionId: input.authority.sourceRevisionId,
    parentAssetId: asset.id,
    nextVersion: asset.version + 1,
  }
  return {
    asset,
    sourceJob,
    currentBinding,
    currentAuthority: input.authority,
    semanticDocument: currentSemantics,
    semanticFingerprint: fingerprint(currentSemantics as unknown as JsonValue),
    assetFamilyId: stableAssetIdForVersion(database, asset.projectId, asset.id) ?? asset.id,
  }
}

function publicCandidate(
  value: CompatibleHistoricalCandidate,
  project: (asset: MediaAssetRecord) => JsonObject,
): PublicHistoricalVisualAssetCandidate {
  return {
    asset: project(value.asset),
    assetFamilyId: value.assetFamilyId,
    assetVersionId: value.asset.id,
    assetVersion: value.asset.version,
    priorSourceRevisionId: value.asset.sourceRevisionId!,
    currentSourceRevisionId: value.currentAuthority.sourceRevisionId,
    semanticFingerprint: value.semanticFingerprint,
    compatibility: {
      entityIdentity: 'exact',
      visualSemantics: 'exact',
      stylePreset: 'exact',
      aspectRatio: 'exact',
      providerCallRequired: false,
    },
  }
}

function currentFamilyVersion(
  database: ManjuDatabase,
  input: { projectId: string; assetFamilyId: string; sourceVersion: number },
): number {
  const row = database.withSql((sql) => sql.get(`
    SELECT MAX(version) AS max_version
    FROM media_assets
    WHERE project_id = ?
      AND (
        id = ?
        OR json_extract(generation_parameters_json, '$.assetFamilyId') = ?
      )
  `, input.projectId, input.assetFamilyId, input.assetFamilyId))
  const value = row?.max_version
  return typeof value === 'number' && Number.isInteger(value) && value >= input.sourceVersion
    ? value
    : input.sourceVersion
}

function sameAdoptionRequest(job: GenerationJobRecord, fingerprintValue: string): boolean {
  return job.type === VISUAL_ASSET_HISTORY_ADOPTION_JOB_TYPE
    && job.input.operation === VISUAL_ASSET_HISTORY_ADOPTION_JOB_TYPE
    && job.input.requestFingerprint === fingerprintValue
}

export class VisualAssetHistoryService {
  constructor(private readonly dependencies: VisualAssetHistoryDependencies) {}

  list(input: {
    projectId: string
    episodeId: string
    entityType: VisualAssetEntityType
    entityId: string
  }): VisualAssetHistoryListResult {
    const authority = episodeAuthority(this.dependencies.database, input)
    // Resolve first so an unknown public entity ID cannot be used to enumerate
    // historical assets from another logical target.
    resolveVisualAssetEntity(this.dependencies.database, input)
    const rows = this.dependencies.database.withSql((sql) => sql.all(`
      SELECT id
      FROM media_assets
      WHERE project_id = ?
        AND episode_id = ?
        AND source_revision_id IS NOT NULL
        AND source_revision_id <> ?
        AND kind = ?
        AND status = 'ready'
        AND source = 'provider'
        AND mime_type LIKE 'image/%'
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    `,
    input.projectId,
    input.episodeId,
    authority.sourceRevisionId,
    EXPECTED_KINDS[input.entityType],
    ))
    const candidates = rows.flatMap((row) => {
      const id = text(row.id)
      const asset = id ? this.dependencies.database.getMediaAsset(id) : undefined
      if (!asset) return []
      const compatible = compatibleCandidate(this.dependencies.database, asset, {
        authority,
        entityType: input.entityType,
        entityId: input.entityId,
      })
      return compatible ? [publicCandidate(compatible, this.dependencies.publicAsset)] : []
    })
    return {
      episodeId: input.episodeId,
      sourceRevisionId: authority.sourceRevisionId,
      entityType: input.entityType,
      entityId: input.entityId,
      episodeEtag: episodeEtag(authority),
      candidates,
    }
  }

  async adopt(input: AdoptHistoricalVisualAssetInput): Promise<HistoricalVisualAssetAdoptionResult> {
    return this.dependencies.admit(async () => {
      let authority = episodeAuthority(this.dependencies.database, input)
      assertExpectedEpisodeVersion(authority, input.expectedEpisodeVersion)
      const sourceAsset = this.dependencies.database.getMediaAsset(input.sourceAssetId)
      if (!sourceAsset
        || sourceAsset.projectId !== input.projectId
        || sourceAsset.episodeId !== input.episodeId) {
        throw new VisualAssetHistoryError(404, 'ASSET_NOT_FOUND', '历史图片不存在或不属于当前项目与分集')
      }
      let candidate = compatibleCandidate(this.dependencies.database, sourceAsset, {
        authority,
        entityType: input.entityType,
        entityId: input.entityId,
      })
      if (!candidate) {
        throw new VisualAssetHistoryError(
          409,
          'VISUAL_ASSET_HISTORY_INCOMPATIBLE',
          '历史图片与当前实体语义、视觉风格或画幅不完全一致，不能自动收养',
        )
      }
      const requestDocument: JsonObject = {
        version: 1,
        projectId: input.projectId,
        episodeId: input.episodeId,
        entityType: input.entityType,
        entityId: input.entityId,
        sourceAssetId: sourceAsset.id,
        sourceAssetChecksum: sourceAsset.checksum!,
        priorSourceRevisionId: sourceAsset.sourceRevisionId!,
        currentSourceRevisionId: authority.sourceRevisionId,
        semanticFingerprint: candidate.semanticFingerprint,
        stylePreset: authority.stylePreset,
        aspectRatio: authority.aspectRatio,
      }
      const requestFingerprint = fingerprint(requestDocument)
      const prior = this.dependencies.database.findGenerationJobByIdempotencyKey(
        input.projectId,
        input.idempotencyKey,
      )
      if (prior) {
        if (!sameAdoptionRequest(prior, requestFingerprint)) {
          throw new VisualAssetHistoryError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他请求')
        }
        const output = record(prior.output)
        const assetVersionId = text(output?.assetVersionId)
        const revisionId = text(output?.auditRevisionId)
        const adopted = assetVersionId
          ? this.dependencies.database.getMediaAsset(assetVersionId)
          : undefined
        const revision = revisionId ? this.dependencies.database.getRevision(revisionId) : undefined
        if (!adopted || !revision || prior.status !== 'succeeded') {
          throw new VisualAssetHistoryError(
            409,
            'VISUAL_ASSET_HISTORY_INCOMPATIBLE',
            '历史素材收养记录不完整，拒绝猜测恢复',
          )
        }
        return {
          asset: adopted,
          sourceAsset,
          job: prior,
          revision,
          assetFamilyId: String(prior.input.assetFamilyId),
          assetVersionId: adopted.id,
          previousAssetVersionId: sourceAsset.id,
          sourceRevisionId: authority.sourceRevisionId,
          priorSourceRevisionId: sourceAsset.sourceRevisionId!,
          semanticFingerprint: candidate.semanticFingerprint,
          episodeEtag: episodeEtag(authority),
          idempotent: true,
        }
      }

      const opened = await this.dependencies.mediaStore.openAsset(sourceAsset.id)
      let bytes: Buffer
      try {
        bytes = await opened.file.readFile()
      } finally {
        await opened.file.close().catch(() => undefined)
      }
      const observedChecksum = createHash('sha256').update(bytes).digest('hex')
      if (observedChecksum !== sourceAsset.checksum) {
        throw new VisualAssetHistoryError(
          409,
          'VISUAL_ASSET_HISTORY_INCOMPATIBLE',
          '历史图片文件与不可变校验和不一致，不能自动收养',
        )
      }

      const assetVersionId = randomUUID()
      const jobId = randomUUID()
      const auditRevisionId = randomUUID()
      const now = new Date().toISOString()
      const version = currentFamilyVersion(this.dependencies.database, {
        projectId: input.projectId,
        assetFamilyId: candidate.assetFamilyId,
        sourceVersion: sourceAsset.version,
      }) + 1
      const jobInput: JsonObject = {
        operation: VISUAL_ASSET_HISTORY_ADOPTION_JOB_TYPE,
        requestFingerprint,
        request: requestDocument,
        assetFamilyId: candidate.assetFamilyId,
        sourceAsset: {
          id: sourceAsset.id,
          version: sourceAsset.version,
          checksum: sourceAsset.checksum!,
          sourceRevisionId: sourceAsset.sourceRevisionId!,
          generationJobId: sourceAsset.generationJobId!,
        },
        assetEntityBinding: {
          ...candidate.currentBinding,
          nextVersion: version,
        },
        episodeBinding: {
          episodeId: input.episodeId,
          expectedRevisionId: authority.sourceRevisionId,
          stylePreset: authority.stylePreset,
          aspectRatio: authority.aspectRatio,
        },
      }
      const jobOutput: JsonObject = {
        operation: VISUAL_ASSET_HISTORY_ADOPTION_JOB_TYPE,
        sourceRevisionId: authority.sourceRevisionId,
        assetFamilyId: candidate.assetFamilyId,
        assetVersionId,
        previousAssetVersionId: sourceAsset.id,
        auditRevisionId,
        providerCallRequired: false,
        images: [{
          id: assetVersionId,
          url: `/api/v1/assets/${encodeURIComponent(assetVersionId)}/content`,
          mimeType: sourceAsset.mimeType!,
          ...(sourceAsset.width ? { width: sourceAsset.width } : {}),
          ...(sourceAsset.height ? { height: sourceAsset.height } : {}),
        }],
      }

      const adopted = await this.dependencies.mediaStore.save({
        id: assetVersionId,
        projectId: input.projectId,
        episodeId: input.episodeId,
        kind: sourceAsset.kind,
        version,
        bytes,
        mimeType: sourceAsset.mimeType!,
        source: 'history-adoption',
        providerId: sourceAsset.providerId,
        generationJobId: jobId,
        generationParameters: {
          operation: VISUAL_ASSET_HISTORY_ADOPTION_JOB_TYPE,
          assetFamilyId: candidate.assetFamilyId,
          previousAssetVersionId: sourceAsset.id,
          previousAssetVersion: sourceAsset.version,
          previousSourceRevisionId: sourceAsset.sourceRevisionId!,
          sourceAssetChecksum: sourceAsset.checksum!,
          sourceGenerationJobId: sourceAsset.generationJobId!,
          semanticFingerprint: candidate.semanticFingerprint,
          entityType: input.entityType,
          entityId: input.entityId,
          sourceRevisionId: authority.sourceRevisionId,
          stylePreset: authority.stylePreset,
          aspectRatio: authority.aspectRatio,
          providerCallRequired: false,
        },
        sourceRevisionId: authority.sourceRevisionId,
        parentAssetId: sourceAsset.id,
        width: sourceAsset.width,
        height: sourceAsset.height,
        durationSeconds: sourceAsset.durationSeconds,
      }, {
        beforeCreate: (transaction) => {
          authority = episodeAuthority(transaction, input)
          assertExpectedEpisodeVersion(authority, input.expectedEpisodeVersion)
          candidate = compatibleCandidate(transaction, sourceAsset, {
            authority,
            entityType: input.entityType,
            entityId: input.entityId,
          })
          if (!candidate || candidate.semanticFingerprint !== requestDocument.semanticFingerprint) {
            throw new VisualAssetHistoryError(
              409,
              'VISUAL_ASSET_HISTORY_INCOMPATIBLE',
              '实体语义、视觉风格或画幅在收养前发生变化，未创建新版本',
            )
          }
          const raced = transaction.findGenerationJobByIdempotencyKey(
            input.projectId,
            input.idempotencyKey,
          )
          if (raced) {
            throw new VisualAssetHistoryError(
              409,
              sameAdoptionRequest(raced, requestFingerprint)
                ? 'IDEMPOTENCY_CONFLICT'
                : 'IDEMPOTENCY_CONFLICT',
              '同一历史素材收养请求正在并发提交，请刷新后重试',
            )
          }
          transaction.createGenerationJob({
            id: jobId,
            projectId: input.projectId,
            episodeId: input.episodeId,
            type: VISUAL_ASSET_HISTORY_ADOPTION_JOB_TYPE,
            status: 'succeeded',
            progress: 100,
            resourceType: 'asset.image.family',
            resourceId: `${input.entityType}:${input.entityId}`,
            idempotencyKey: input.idempotencyKey,
            input: jobInput,
            progressDetail: { stage: 'completed', providerCallRequired: false },
            output: jobOutput,
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            completedAt: now,
          })
        },
        afterCreate: (asset, transaction) => {
          transaction.createRevision({
            id: auditRevisionId,
            projectId: input.projectId,
            parentRevisionId: authority.sourceRevisionId,
            summary: `收养历史${input.entityType === 'character' ? '角色' : input.entityType === 'location' ? '场景' : '道具'}视觉素材`.slice(0, 500),
            snapshot: {
              version: 1,
              kind: VISUAL_ASSET_HISTORY_ADOPTION_JOB_TYPE,
              projectId: input.projectId,
              episodeId: input.episodeId,
              sourceRevisionId: authority.sourceRevisionId,
              priorSourceRevisionId: sourceAsset.sourceRevisionId!,
              semanticFingerprint: candidate!.semanticFingerprint,
              assetFamilyId: candidate!.assetFamilyId,
              previousAssetVersionId: sourceAsset.id,
              assetVersionId: asset.id,
              assetVersion: asset.version,
              checksum: asset.checksum!,
              providerCallRequired: false,
              createdAt: now,
            },
            createdAt: now,
          })
        },
      })
      const job = this.dependencies.database.getGenerationJob(jobId)
      const revision = this.dependencies.database.getRevision(auditRevisionId)
      if (!job || !revision) throw new Error('Historical visual adoption transaction disappeared')
      const result: HistoricalVisualAssetAdoptionResult = {
        asset: adopted,
        sourceAsset,
        job,
        revision,
        assetFamilyId: candidate.assetFamilyId,
        assetVersionId: adopted.id,
        previousAssetVersionId: sourceAsset.id,
        sourceRevisionId: authority.sourceRevisionId,
        priorSourceRevisionId: sourceAsset.sourceRevisionId!,
        semanticFingerprint: candidate.semanticFingerprint,
        episodeEtag: episodeEtag(authority),
        idempotent: false,
      }
      this.dependencies.onAdopted?.(result)
      return result
    })
  }
}

function publicRevision(revision: RevisionRecord): JsonObject {
  return {
    id: revision.id,
    projectId: revision.projectId,
    parentRevisionId: revision.parentRevisionId,
    summary: revision.summary,
    createdAt: revision.createdAt,
  }
}

function parseIfMatch(request: Request): string {
  const raw = request.get('if-match')?.trim()
  if (!raw) {
    throw new VisualAssetHistoryError(428, 'PRECONDITION_REQUIRED', '必须提供 If-Match 分集版本')
  }
  const version = versionTokenFromEtag(raw)
  if (!version) throw new VisualAssetHistoryError(400, 'INVALID_REQUEST', 'If-Match 分集版本格式无效')
  return version
}

function parseIdempotencyKey(request: Request): string {
  const value = request.get('idempotency-key')?.trim()
  if (!value) {
    throw new VisualAssetHistoryError(400, 'IDEMPOTENCY_KEY_REQUIRED', '必须提供 Idempotency-Key')
  }
  if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new VisualAssetHistoryError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 格式无效')
  }
  return value
}

function queryText(value: unknown, label: string): string {
  return identifier(Array.isArray(value) ? undefined : value, label)
}

export function mountVisualAssetHistoryRoutes(
  app: Express,
  dependencies: VisualAssetHistoryDependencies,
): void {
  const service = new VisualAssetHistoryService(dependencies)
  app.get('/api/v1/episodes/:episodeId/visual-asset-history', (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    try {
      const result = service.list({
        projectId: queryText(request.query.projectId, 'projectId'),
        episodeId: identifier(request.params.episodeId, 'episodeId'),
        entityType: entityType(request.query.entityType),
        entityId: queryText(request.query.entityId, 'entityId'),
      })
      response.setHeader('ETag', result.episodeEtag)
      response.json({
        episodeId: result.episodeId,
        sourceRevisionId: result.sourceRevisionId,
        entityType: result.entityType,
        entityId: result.entityId,
        candidates: result.candidates,
      })
    } catch (error) {
      next(error)
    }
  })
  app.post('/api/v1/assets/:assetId/adopt-current-visual-revision', async (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    try {
      const body = record(request.body)
      if (!body) throw new VisualAssetHistoryError(400, 'INVALID_REQUEST', '历史素材收养请求必须是 JSON 对象')
      const unknown = Object.keys(body).filter((key) => ![
        'projectId',
        'episodeId',
        'entityType',
        'entityId',
      ].includes(key))
      if (unknown.length > 0) {
        throw new VisualAssetHistoryError(400, 'INVALID_REQUEST', `不支持的历史素材收养参数: ${unknown.join(', ')}`)
      }
      const result = await service.adopt({
        projectId: identifier(body.projectId, 'projectId'),
        episodeId: identifier(body.episodeId, 'episodeId'),
        entityType: entityType(body.entityType),
        entityId: identifier(body.entityId, 'entityId'),
        sourceAssetId: identifier(request.params.assetId, 'assetId'),
        expectedEpisodeVersion: parseIfMatch(request),
        idempotencyKey: parseIdempotencyKey(request),
      })
      response.setHeader('ETag', result.episodeEtag)
      response
        .status(result.idempotent ? 200 : 201)
        .json({
          adoption: {
            asset: dependencies.publicAsset(result.asset),
            sourceAsset: dependencies.publicAsset(result.sourceAsset),
            job: dependencies.publicJob(result.job),
            revision: publicRevision(result.revision),
            assetFamilyId: result.assetFamilyId,
            assetVersionId: result.assetVersionId,
            previousAssetVersionId: result.previousAssetVersionId,
            sourceRevisionId: result.sourceRevisionId,
            priorSourceRevisionId: result.priorSourceRevisionId,
            semanticFingerprint: result.semanticFingerprint,
            idempotent: result.idempotent,
            providerCallRequired: false,
          },
        })
    } catch (error) {
      next(error)
    }
  })
}
