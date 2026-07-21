import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { Express, NextFunction, Request, Response } from 'express'

import type {
  GenerationJobRecord,
  ManjuDatabase,
  MediaAssetRecord,
  RevisionRecord,
} from './database.js'
import { episodeEtag, versionTokenFromEtag } from './episode-version.js'
import { MediaStore } from './media.js'
import {
  SHOT_VIDEO_HISTORY_ADOPTION_JOB_TYPE,
  ShotMediaReviewService,
  type ShotMediaDecisionResult,
} from './shot-media-review.js'
import type { JsonObject } from './types.js'

const PUBLIC_SHOT_ID = `CASE
  WHEN typeof(json_extract(shots.metadata_json, '$.storyId')) = 'text'
    AND length(trim(json_extract(shots.metadata_json, '$.storyId'))) > 0
  THEN json_extract(shots.metadata_json, '$.storyId')
  ELSE shots.id
END`

const PUBLIC_SCENE_ID = `CASE
  WHEN typeof(json_extract(scenes.metadata_json, '$.storyId')) = 'text'
    AND length(trim(json_extract(scenes.metadata_json, '$.storyId'))) > 0
  THEN json_extract(scenes.metadata_json, '$.storyId')
  ELSE scenes.id
END`

export class ShotVideoHistoryError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'INVALID_REQUEST'
      | 'ASSET_NOT_FOUND'
      | 'HISTORY_INCOMPATIBLE'
      | 'PRECONDITION_REQUIRED'
      | 'REVISION_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'ShotVideoHistoryError'
  }
}

interface ShotAuthority {
  projectId: string
  episodeId: string
  databaseShotId: string
  shotId: string
  sceneId: string
  sourceRevisionId: string
  episodeUpdatedAt: string
}

interface CompatibleHistoricalVideo {
  asset: MediaAssetRecord
  sourceJob: GenerationJobRecord
  priorRevision: RevisionRecord
  currentRevision: RevisionRecord
  authority: ShotAuthority
  semanticFingerprint: string
}

export interface PublicHistoricalShotVideoCandidate {
  asset: JsonObject
  priorSourceRevisionId: string
  currentSourceRevisionId: string
  semanticFingerprint: string
  compatibility: {
    storySnapshot: 'exact'
    shotIdentity: 'exact'
    providerCallRequired: false
  }
}

export interface HistoricalShotVideoListResult {
  projectId: string
  episodeId: string
  shotId: string
  sceneId: string
  sourceRevisionId: string
  episodeEtag: string
  candidates: PublicHistoricalShotVideoCandidate[]
}

export interface HistoricalShotVideoRestorationResult {
  asset: MediaAssetRecord
  sourceAsset: MediaAssetRecord
  job: GenerationJobRecord
  review: ShotMediaDecisionResult
  priorSourceRevisionId: string
  currentSourceRevisionId: string
  semanticFingerprint: string
  providerCallRequired: false
  idempotent: boolean
}

interface Dependencies {
  database: ManjuDatabase
  mediaStore: MediaStore
  shotMediaReviewService: ShotMediaReviewService
  publicAsset(asset: MediaAssetRecord): JsonObject
  publicJob(job: GenerationJobRecord): JsonObject
  admit<T>(operation: () => Promise<T>): Promise<T>
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function identifier(value: unknown, label: string): string {
  const normalized = text(value)
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ShotVideoHistoryError(400, 'INVALID_REQUEST', `${label} 格式无效`)
  }
  return normalized
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function semanticFingerprint(revision: RevisionRecord): string {
  return sha256(JSON.stringify(revision.snapshot))
}

function shotAuthority(
  database: ManjuDatabase,
  input: { projectId: string; episodeId: string; shotId: string; sceneId?: string },
): ShotAuthority {
  const sceneId = input.sceneId ?? null
  const rows = database.withSql((sql) => sql.all(`
    SELECT shots.id AS database_shot_id,
           ${PUBLIC_SHOT_ID} AS public_shot_id,
           ${PUBLIC_SCENE_ID} AS public_scene_id,
           episodes.project_id,
           episodes.id AS episode_id,
           episodes.source_revision_id,
           episodes.updated_at
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
      JOIN episodes ON episodes.id = scenes.episode_id
     WHERE episodes.project_id = ? AND episodes.id = ?
       AND ${PUBLIC_SHOT_ID} = ?
       AND (? IS NULL OR ${PUBLIC_SCENE_ID} = ?)
     ORDER BY scenes.id, shots.id
     LIMIT 2
  `, input.projectId, input.episodeId, input.shotId, sceneId, sceneId))
  if (rows.length !== 1) {
    throw new ShotVideoHistoryError(
      rows.length === 0 ? 404 : 409,
      'INVALID_REQUEST',
      rows.length === 0 ? '镜头不存在或不属于当前项目与分集' : '镜头 ID 不唯一，必须提供 sceneId',
    )
  }
  const row = rows[0]!
  const sourceRevisionId = text(row.source_revision_id)
  const updatedAt = text(row.updated_at)
  if (!sourceRevisionId || !updatedAt) {
    throw new ShotVideoHistoryError(409, 'HISTORY_INCOMPATIBLE', '当前分集缺少可核验的剧本修订')
  }
  return {
    projectId: identifier(row.project_id, 'projectId'),
    episodeId: identifier(row.episode_id, 'episodeId'),
    databaseShotId: identifier(row.database_shot_id, 'databaseShotId'),
    shotId: identifier(row.public_shot_id, 'shotId'),
    sceneId: identifier(row.public_scene_id, 'sceneId'),
    sourceRevisionId,
    episodeUpdatedAt: updatedAt,
  }
}

function compatibleHistoricalVideo(
  database: ManjuDatabase,
  asset: MediaAssetRecord,
  authority: ShotAuthority,
): CompatibleHistoricalVideo | null {
  if (asset.projectId !== authority.projectId
    || asset.episodeId !== authority.episodeId
    || asset.kind !== 'shot.video'
    || (asset.status !== 'ready' && asset.status !== 'stale')
    || (asset.mimeType !== 'video/mp4' && asset.mimeType !== 'video/webm')
    || !asset.checksum
    || !asset.sourceRevisionId
    || asset.sourceRevisionId === authority.sourceRevisionId
    || !asset.generationJobId) return null
  const sourceJob = database.getGenerationJob(asset.generationJobId)
  const binding = sourceJob && record(sourceJob.input.binding)
  if (!sourceJob
    || sourceJob.type !== 'shot.video.generate'
    || sourceJob.status !== 'succeeded'
    || sourceJob.projectId !== authority.projectId
    || sourceJob.episodeId !== authority.episodeId
    || binding?.databaseShotId !== authority.databaseShotId
    || binding.shotId !== authority.shotId
    || binding.sceneId !== authority.sceneId
    || binding.expectedRevisionId !== asset.sourceRevisionId) return null
  const priorRevision = database.getRevision(asset.sourceRevisionId)
  const currentRevision = database.getRevision(authority.sourceRevisionId)
  if (!priorRevision
    || !currentRevision
    || priorRevision.projectId !== authority.projectId
    || currentRevision.projectId !== authority.projectId
    || !isDeepStrictEqual(priorRevision.snapshot, currentRevision.snapshot)) return null
  return {
    asset,
    sourceJob,
    priorRevision,
    currentRevision,
    authority,
    semanticFingerprint: semanticFingerprint(currentRevision),
  }
}

function publicCandidate(
  value: CompatibleHistoricalVideo,
  publicAsset: Dependencies['publicAsset'],
): PublicHistoricalShotVideoCandidate {
  return {
    asset: publicAsset(value.asset),
    priorSourceRevisionId: value.priorRevision.id,
    currentSourceRevisionId: value.currentRevision.id,
    semanticFingerprint: value.semanticFingerprint,
    compatibility: {
      storySnapshot: 'exact',
      shotIdentity: 'exact',
      providerCallRequired: false,
    },
  }
}

export class ShotVideoHistoryService {
  constructor(private readonly dependencies: Dependencies) {}

  list(input: {
    projectId: string
    episodeId: string
    shotId: string
    sceneId?: string
  }): HistoricalShotVideoListResult {
    const authority = shotAuthority(this.dependencies.database, input)
    const rows = this.dependencies.database.withSql((sql) => sql.all(`
      SELECT media_assets.id
        FROM media_assets
        JOIN generation_jobs ON generation_jobs.id = media_assets.generation_job_id
       WHERE media_assets.project_id = ?
         AND media_assets.episode_id = ?
         AND media_assets.kind = 'shot.video'
         AND media_assets.source_revision_id <> ?
         AND media_assets.status IN ('ready', 'stale')
         AND generation_jobs.type = 'shot.video.generate'
         AND generation_jobs.status = 'succeeded'
         AND json_extract(generation_jobs.input_json, '$.binding.databaseShotId') = ?
         AND json_extract(generation_jobs.input_json, '$.binding.shotId') = ?
         AND json_extract(generation_jobs.input_json, '$.binding.sceneId') = ?
       ORDER BY media_assets.created_at DESC, media_assets.id DESC
       LIMIT 200
    `,
    authority.projectId,
    authority.episodeId,
    authority.sourceRevisionId,
    authority.databaseShotId,
    authority.shotId,
    authority.sceneId,
    ))
    const candidates = rows.flatMap((row) => {
      const id = text(row.id)
      const asset = id ? this.dependencies.database.getMediaAsset(id) : undefined
      if (!asset) return []
      const compatible = compatibleHistoricalVideo(this.dependencies.database, asset, authority)
      return compatible ? [publicCandidate(compatible, this.dependencies.publicAsset)] : []
    })
    return {
      projectId: authority.projectId,
      episodeId: authority.episodeId,
      shotId: authority.shotId,
      sceneId: authority.sceneId,
      sourceRevisionId: authority.sourceRevisionId,
      episodeEtag: episodeEtag({
        sourceRevisionId: authority.sourceRevisionId,
        updatedAt: authority.episodeUpdatedAt,
      }),
      candidates,
    }
  }

  async restore(input: {
    projectId: string
    episodeId: string
    shotId: string
    sceneId?: string
    sourceAssetId: string
    expectedEpisodeVersion: string
    idempotencyKey: string
  }): Promise<HistoricalShotVideoRestorationResult> {
    return this.dependencies.admit(async () => {
      const authority = shotAuthority(this.dependencies.database, input)
      const expectedEtag = episodeEtag({
        sourceRevisionId: authority.sourceRevisionId,
        updatedAt: authority.episodeUpdatedAt,
      })
      const existingJob = this.dependencies.database.findGenerationJobByIdempotencyKey(
        input.projectId,
        input.idempotencyKey,
      )
      if (existingJob) {
        const output = record(existingJob.output)
        const adoptedAssetId = text(output?.assetId)
        const reviewId = text(output?.reviewId)
        const sourceAssetId = text(output?.sourceAssetId)
        const adopted = adoptedAssetId
          ? this.dependencies.database.getMediaAsset(adoptedAssetId)
          : undefined
        const sourceAsset = sourceAssetId
          ? this.dependencies.database.getMediaAsset(sourceAssetId)
          : undefined
        if (!adopted || !sourceAsset || !reviewId || existingJob.status !== 'succeeded') {
          throw new ShotVideoHistoryError(409, 'IDEMPOTENCY_CONFLICT', '历史视频恢复记录不完整，请刷新后重试')
        }
        const snapshot = this.dependencies.shotMediaReviewService.list({
          projectId: input.projectId,
          episodeId: input.episodeId,
          shotId: input.shotId,
          ...(input.sceneId ? { sceneId: input.sceneId } : {}),
          mediaType: 'video',
        })
        const reviewRecord = snapshot.history.find((record) => record.id === reviewId)
        if (!reviewRecord) {
          throw new ShotVideoHistoryError(409, 'IDEMPOTENCY_CONFLICT', '历史视频恢复审计记录不存在')
        }
        return {
          asset: adopted,
          sourceAsset,
          job: existingJob,
          review: {
            review: reviewRecord,
            episodeEtag: snapshot.episodeEtag,
            currentSelectionAssetId: snapshot.currentSelectionAssetId,
            clearedVideoAssetId: null,
            timelineReconcileRequired: reviewRecord.timelineReconcileRequired,
            idempotent: true,
            headAdvanced: false,
          },
          priorSourceRevisionId: sourceAsset.sourceRevisionId!,
          currentSourceRevisionId: adopted.sourceRevisionId!,
          semanticFingerprint: String(existingJob.input.semanticFingerprint),
          providerCallRequired: false,
          idempotent: true,
        }
      }
      if (versionTokenFromEtag(expectedEtag) !== input.expectedEpisodeVersion) {
        throw new ShotVideoHistoryError(412, 'REVISION_CONFLICT', '分集已更新，请刷新历史视频后重试')
      }

      const sourceAsset = this.dependencies.database.getMediaAsset(input.sourceAssetId)
      if (!sourceAsset) {
        throw new ShotVideoHistoryError(
          404,
          'ASSET_NOT_FOUND',
          '历史视频不存在或不属于当前项目与分集',
        )
      }
      const candidate = compatibleHistoricalVideo(this.dependencies.database, sourceAsset, authority)
      if (!candidate) {
        throw new ShotVideoHistoryError(
          409,
          'HISTORY_INCOMPATIBLE',
          '历史视频与当前剧本快照或镜头身份不完全一致，不能安全恢复',
        )
      }
      const opened = await this.dependencies.mediaStore.openAsset(sourceAsset.id)
      let bytes: Buffer
      try {
        bytes = await opened.file.readFile()
      } finally {
        await opened.file.close().catch(() => undefined)
      }
      if (sha256(bytes) !== sourceAsset.checksum) {
        throw new ShotVideoHistoryError(409, 'HISTORY_INCOMPATIBLE', '历史视频文件与不可变 checksum 不一致')
      }

      const assetId = randomUUID()
      const jobId = randomUUID()
      const now = new Date().toISOString()
      const historyAdoption: JsonObject = {
        sourceAssetId: sourceAsset.id,
        priorSourceRevisionId: sourceAsset.sourceRevisionId!,
        currentSourceRevisionId: authority.sourceRevisionId,
        semanticFingerprint: candidate.semanticFingerprint,
        providerCallRequired: false,
      }
      const binding: JsonObject = {
        databaseShotId: authority.databaseShotId,
        episodeId: authority.episodeId,
        shotId: authority.shotId,
        sceneId: authority.sceneId,
        expectedRevisionId: authority.sourceRevisionId,
      }
      const adopted = await this.dependencies.mediaStore.save({
        id: assetId,
        projectId: authority.projectId,
        episodeId: authority.episodeId,
        kind: 'shot.video',
        version: sourceAsset.version + 1,
        bytes,
        mimeType: sourceAsset.mimeType!,
        source: 'history-adoption',
        providerId: sourceAsset.providerId,
        generationJobId: jobId,
        generationParameters: {
          operation: SHOT_VIDEO_HISTORY_ADOPTION_JOB_TYPE,
          shotId: authority.shotId,
          sceneId: authority.sceneId,
          historyAdoption,
        },
        sourceRevisionId: authority.sourceRevisionId,
        parentAssetId: sourceAsset.id,
        width: sourceAsset.width,
        height: sourceAsset.height,
        durationSeconds: sourceAsset.durationSeconds,
      }, {
        beforeCreate: (transaction) => {
          const current = shotAuthority(transaction, input)
          const currentEtag = episodeEtag({
            sourceRevisionId: current.sourceRevisionId,
            updatedAt: current.episodeUpdatedAt,
          })
          if (versionTokenFromEtag(currentEtag) !== input.expectedEpisodeVersion
            || !compatibleHistoricalVideo(transaction, sourceAsset, current)) {
            throw new ShotVideoHistoryError(412, 'REVISION_CONFLICT', '恢复前分集语义或选版已变化，未创建新 Asset')
          }
          if (transaction.findGenerationJobByIdempotencyKey(input.projectId, input.idempotencyKey)) {
            throw new ShotVideoHistoryError(409, 'IDEMPOTENCY_CONFLICT', '同一历史视频恢复请求正在并发提交')
          }
          transaction.createGenerationJob({
            id: jobId,
            projectId: authority.projectId,
            episodeId: authority.episodeId,
            // Keep the canonical generation job type so the database-level
            // shot-media audit trigger continues to enforce the same binding.
            // `operation` below distinguishes the provider-free history copy.
            type: 'shot.video.generate',
            status: 'succeeded',
            progress: 100,
            resourceType: 'shot.video',
            resourceId: authority.databaseShotId,
            idempotencyKey: input.idempotencyKey,
            input: {
              operation: SHOT_VIDEO_HISTORY_ADOPTION_JOB_TYPE,
              binding,
              historyAdoption,
              semanticFingerprint: candidate.semanticFingerprint,
            },
            progressDetail: { stage: 'completed', providerCallRequired: false },
            output: {
              assetId,
              sourceAssetId: sourceAsset.id,
              providerCallRequired: false,
            },
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            completedAt: now,
          })
        },
      })

      const review = this.dependencies.shotMediaReviewService.decide({
        projectId: authority.projectId,
        episodeId: authority.episodeId,
        shotId: authority.shotId,
        sceneId: authority.sceneId,
        mediaType: 'video',
        decision: 'adopt',
        assetId: adopted.id,
        note: `从旧修订 ${sourceAsset.sourceRevisionId!.slice(0, 8)} 恢复；未调用 Provider`,
        expectedEpisodeVersion: input.expectedEpisodeVersion,
        idempotencyKey: `shot-video-history-select-${sha256(input.idempotencyKey).slice(0, 48)}`,
      })
      const job = this.dependencies.database.updateGenerationJob(jobId, {
        output: {
          assetId: adopted.id,
          sourceAssetId: sourceAsset.id,
          reviewId: review.review.id,
          providerCallRequired: false,
        },
      })
      if (!job) throw new Error('历史视频恢复 Job 写入后丢失')
      return {
        asset: adopted,
        sourceAsset,
        job,
        review,
        priorSourceRevisionId: sourceAsset.sourceRevisionId!,
        currentSourceRevisionId: authority.sourceRevisionId,
        semanticFingerprint: candidate.semanticFingerprint,
        providerCallRequired: false,
        idempotent: false,
      }
    })
  }
}

function queryIdentifier(value: unknown, label: string): string {
  return identifier(Array.isArray(value) ? undefined : value, label)
}

function requiredIfMatch(request: Request): string {
  const value = request.get('if-match')?.trim()
  if (!value) throw new ShotVideoHistoryError(428, 'PRECONDITION_REQUIRED', '必须提供 If-Match 分集版本')
  const version = versionTokenFromEtag(value)
  if (!version) throw new ShotVideoHistoryError(400, 'INVALID_REQUEST', 'If-Match 分集版本格式无效')
  return version
}

function requiredIdempotencyKey(request: Request): string {
  return identifier(request.get('idempotency-key'), 'Idempotency-Key')
}

export function mountShotVideoHistoryRoutes(app: Express, dependencies: Dependencies): void {
  const service = new ShotVideoHistoryService(dependencies)
  app.get('/api/v1/shots/:shotId/video-history', (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    try {
      const result = service.list({
        projectId: queryIdentifier(request.query.projectId, 'projectId'),
        episodeId: queryIdentifier(request.query.episodeId, 'episodeId'),
        shotId: identifier(request.params.shotId, 'shotId'),
        ...(request.query.sceneId === undefined
          ? {}
          : { sceneId: queryIdentifier(request.query.sceneId, 'sceneId') }),
      })
      response.setHeader('ETag', result.episodeEtag)
      response.json({ videoHistory: result })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/v1/shots/:shotId/video-history/:assetId/restore', async (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    try {
      const body = record(request.body)
      if (!body) throw new ShotVideoHistoryError(400, 'INVALID_REQUEST', '恢复请求必须是 JSON 对象')
      const unknown = Object.keys(body).filter((key) => !['projectId', 'episodeId', 'sceneId'].includes(key))
      if (unknown.length > 0) {
        throw new ShotVideoHistoryError(400, 'INVALID_REQUEST', `不支持的恢复参数: ${unknown.join(', ')}`)
      }
      const result = await service.restore({
        projectId: identifier(body.projectId, 'projectId'),
        episodeId: identifier(body.episodeId, 'episodeId'),
        shotId: identifier(request.params.shotId, 'shotId'),
        ...(body.sceneId === undefined ? {} : { sceneId: identifier(body.sceneId, 'sceneId') }),
        sourceAssetId: identifier(request.params.assetId, 'assetId'),
        expectedEpisodeVersion: requiredIfMatch(request),
        idempotencyKey: requiredIdempotencyKey(request),
      })
      response.setHeader('ETag', result.review.episodeEtag)
      response.status(result.idempotent ? 200 : 201).json({
        restoration: {
          asset: dependencies.publicAsset(result.asset),
          sourceAsset: dependencies.publicAsset(result.sourceAsset),
          job: dependencies.publicJob(result.job),
          mediaReview: result.review,
          priorSourceRevisionId: result.priorSourceRevisionId,
          currentSourceRevisionId: result.currentSourceRevisionId,
          semanticFingerprint: result.semanticFingerprint,
          providerCallRequired: false,
          idempotent: result.idempotent,
        },
      })
    } catch (error) {
      next(error)
    }
  })
}
