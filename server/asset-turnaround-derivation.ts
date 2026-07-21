import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { assetImageEditEtag } from './asset-image-edit.js'
import type { GenerationJobRecord, ManjuDatabase, MediaAssetRecord } from './database.js'
import {
  resolveBundledFfmpegPath,
  SpawnProcessRunner,
  type RenderProcessRunner,
} from './ffmpeg-renderer.js'
import { imageDimensions, MediaStore, MediaStoreError } from './media.js'
import type { JsonObject } from './types.js'
import {
  resolveVisualAssetEntity,
  VisualAssetGenerationError,
  type VisualAssetEntityBinding,
} from './visual-asset-generation.js'
import {
  JobExecutionError,
  type JobHandler,
  type JobHandlerContext,
  type JobRecord,
} from './worker.js'

export const TURNAROUND_DERIVATION_JOB_TYPE = 'asset.image.turnaround.derive'
export const TURNAROUND_DERIVATION_ALGORITHM = 'ffmpeg-crop-seedance-safe-v2'
const LEGACY_TURNAROUND_DERIVATION_ALGORITHM = 'ffmpeg-crop-v1'
export type TurnaroundDerivationAlgorithm =
  | typeof TURNAROUND_DERIVATION_ALGORITHM
  | typeof LEGACY_TURNAROUND_DERIVATION_ALGORITHM
export const TURNAROUND_ROLES = ['front', 'side', 'back'] as const
export type TurnaroundRole = (typeof TURNAROUND_ROLES)[number]

export const MAX_TURNAROUND_SOURCE_BYTES = 30 * 1024 * 1024
export const MAX_TURNAROUND_OUTPUT_BYTES = 20 * 1024 * 1024
export const MAX_TURNAROUND_OUTPUT_TOTAL_BYTES = 60 * 1024 * 1024
export const MIN_TURNAROUND_CROP_PIXELS = 64
export const MAX_TURNAROUND_CROP_OVERLAP_RATIO = 0.2
export const DEFAULT_TURNAROUND_TIMEOUT_MS = 60_000

const SUPPORTED_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])

export type TurnaroundDerivationErrorCode =
  | 'ASSET_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_CROPS'
  | 'INVALID_SOURCE_ASSET'
  | 'PRECONDITION_FAILED'
  | 'PROJECT_NOT_FOUND'
  | 'SOURCE_REVISION_MISSING'
  | 'STALE_SOURCE'

export class TurnaroundDerivationError extends Error {
  constructor(
    readonly code: TurnaroundDerivationErrorCode,
    message: string,
    readonly details?: JsonObject,
  ) {
    super(message)
    this.name = 'TurnaroundDerivationError'
  }
}

export interface NormalizedTurnaroundCrop {
  role: TurnaroundRole
  x: number
  y: number
  width: number
  height: number
}

export interface PixelTurnaroundCrop {
  role: TurnaroundRole
  x: number
  y: number
  width: number
  height: number
}

export interface DurableTurnaroundCrop {
  role: TurnaroundRole
  normalized: Omit<NormalizedTurnaroundCrop, 'role'>
  pixels: Omit<PixelTurnaroundCrop, 'role'>
}

export interface TurnaroundSourceBinding {
  assetId: string
  projectId: string
  episodeId: string
  checksum: string
  version: number
  mimeType: string
  width: number
  height: number
  sourceRevisionId: string
  character: VisualAssetEntityBinding
}

export interface TurnaroundDerivationJobInput {
  operation: typeof TURNAROUND_DERIVATION_JOB_TYPE
  algorithm: TurnaroundDerivationAlgorithm
  sourceAssetId: string
  source: TurnaroundSourceBinding
  crops: DurableTurnaroundCrop[]
  assetEntityBinding: VisualAssetEntityBinding
}

export interface SeedanceSafeImageCanvas {
  width: number
  height: number
  contentWidth: number
  contentHeight: number
}

function evenCeil(value: number): number {
  const integer = Math.ceil(value)
  return integer % 2 === 0 ? integer : integer + 1
}

/**
 * Fits a crop into Seedance's open aspect-ratio interval without removing any
 * character pixels. The extra canvas is deterministic white padding; tiny
 * crops are uniformly upscaled first and extreme crops are capped at 6000px.
 */
export function seedanceSafeImageCanvas(width: number, height: number): SeedanceSafeImageCanvas {
  if (!positiveInteger(width) || !positiveInteger(height)) throw new TypeError('image dimensions must be positive integers')
  const maxScale = 6_000 / Math.max(width, height)
  const desiredScale = Math.max(1, 300 / Math.min(width, height))
  const scale = Math.min(desiredScale, maxScale)
  const contentWidth = Math.max(1, Math.min(6_000, Math.round(width * scale)))
  const contentHeight = Math.max(1, Math.min(6_000, Math.round(height * scale)))
  let canvasWidth = Math.max(300, contentWidth)
  let canvasHeight = Math.max(300, contentHeight)
  if (canvasWidth / canvasHeight <= 0.4) canvasWidth = Math.max(canvasWidth, evenCeil(Math.floor(canvasHeight * 0.4) + 1))
  if (canvasWidth / canvasHeight >= 2.5) canvasHeight = Math.max(canvasHeight, evenCeil(Math.floor(canvasWidth / 2.5) + 1))
  if (canvasWidth > 6_000 || canvasHeight > 6_000
    || canvasWidth / canvasHeight <= 0.4 || canvasWidth / canvasHeight >= 2.5) {
    throw new TypeError('cannot fit image into Seedance reference envelope')
  }
  return { width: canvasWidth, height: canvasHeight, contentWidth, contentHeight }
}

export interface PrepareTurnaroundDerivationInput {
  projectId: string
  sourceAssetId: string
  sourceIfMatch: string
  crops: readonly NormalizedTurnaroundCrop[]
}

export interface PreparedTurnaroundDerivation {
  input: TurnaroundDerivationJobInput
  sourceEtag: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizedMime(value: string | null): string {
  return value?.split(';', 1)[0].trim().toLowerCase() ?? ''
}

function identifier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= 200 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

function parseVisualBinding(value: unknown): VisualAssetEntityBinding | null {
  if (!isPlainObject(value)) return null
  const allowed = new Set([
    'episodeId',
    'entityType',
    'entityId',
    'databaseEntityId',
    'expectedRevisionId',
    'parentAssetId',
    'nextVersion',
  ])
  if (Object.keys(value).some((key) => !allowed.has(key))
    || value.entityType !== 'character'
    || !identifier(value.episodeId)
    || !identifier(value.entityId)
    || !identifier(value.databaseEntityId)
    || !identifier(value.expectedRevisionId)
    || (value.parentAssetId !== null && !identifier(value.parentAssetId))
    || !positiveInteger(value.nextVersion)) return null
  return {
    episodeId: value.episodeId as string,
    entityType: 'character',
    entityId: value.entityId as string,
    databaseEntityId: value.databaseEntityId as string,
    expectedRevisionId: value.expectedRevisionId as string,
    parentAssetId: value.parentAssetId as string | null,
    nextVersion: value.nextVersion as number,
  }
}

function sourceCharacterBinding(
  database: ManjuDatabase,
  source: MediaAssetRecord,
): VisualAssetEntityBinding {
  if (!source.generationJobId) {
    throw new TurnaroundDerivationError(
      'INVALID_SOURCE_ASSET',
      '源图必须具有服务端固化的角色生成绑定',
    )
  }
  const job = database.getGenerationJob(source.generationJobId)
  const binding = parseVisualBinding(job?.input.assetEntityBinding)
  if (!job || job.status !== 'succeeded'
    || job.projectId !== source.projectId
    || job.episodeId !== source.episodeId
    || !binding
    || binding.episodeId !== source.episodeId
    || binding.expectedRevisionId !== source.sourceRevisionId
    || source.generationParameters.entityType !== 'character'
    || source.generationParameters.entityId !== binding.entityId) {
    throw new TurnaroundDerivationError(
      'INVALID_SOURCE_ASSET',
      '源图缺少一致的真实角色实体绑定',
    )
  }
  return binding
}

function episodeRevision(database: ManjuDatabase, projectId: string, episodeId: string): string {
  const row = database.withSql((sql) => sql.get(`
    SELECT source_revision_id FROM episodes WHERE id = ? AND project_id = ?
  `, episodeId, projectId))
  if (!row) throw new TurnaroundDerivationError('INVALID_SOURCE_ASSET', '源图所属分集不存在')
  if (typeof row.source_revision_id !== 'string' || !row.source_revision_id) {
    throw new TurnaroundDerivationError('SOURCE_REVISION_MISSING', '源图所属分集缺少剧本修订')
  }
  return row.source_revision_id
}

function overlapRatio(left: PixelTurnaroundCrop, right: PixelTurnaroundCrop): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  const intersection = width * height
  if (intersection === 0) return 0
  return intersection / Math.min(left.width * left.height, right.width * right.height)
}

function pixelCrop(
  crop: NormalizedTurnaroundCrop,
  sourceWidth: number,
  sourceHeight: number,
): PixelTurnaroundCrop {
  const x = Math.floor(crop.x * sourceWidth)
  const y = Math.floor(crop.y * sourceHeight)
  const right = Math.ceil((crop.x + crop.width) * sourceWidth)
  const bottom = Math.ceil((crop.y + crop.height) * sourceHeight)
  return { role: crop.role, x, y, width: right - x, height: bottom - y }
}

export function validateTurnaroundCrops(
  value: unknown,
  sourceWidth: number,
  sourceHeight: number,
): DurableTurnaroundCrop[] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TurnaroundDerivationError('INVALID_CROPS', '必须人工确认 front、side、back 三个完整裁剪框')
  }
  const crops = value.map((raw): NormalizedTurnaroundCrop => {
    if (!isPlainObject(raw)) throw new TurnaroundDerivationError('INVALID_CROPS', '裁剪框必须是对象')
    const allowed = new Set(['role', 'x', 'y', 'width', 'height'])
    if (Object.keys(raw).some((key) => !allowed.has(key))
      || !TURNAROUND_ROLES.includes(raw.role as TurnaroundRole)) {
      throw new TurnaroundDerivationError('INVALID_CROPS', '裁剪框 role 必须是 front、side 或 back')
    }
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field])) {
        throw new TurnaroundDerivationError('INVALID_CROPS', `裁剪框 ${field} 必须是有限数值`)
      }
    }
    const crop = raw as unknown as NormalizedTurnaroundCrop
    if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
      || crop.x + crop.width > 1 + Number.EPSILON
      || crop.y + crop.height > 1 + Number.EPSILON) {
      throw new TurnaroundDerivationError('INVALID_CROPS', '裁剪框必须在 0..1 归一化边界内')
    }
    return { ...crop }
  })
  const roles = crops.map((crop) => crop.role)
  if (new Set(roles).size !== 3 || TURNAROUND_ROLES.some((role) => !roles.includes(role))) {
    throw new TurnaroundDerivationError('INVALID_CROPS', 'front、side、back 必须各出现一次')
  }
  const pixels = crops.map((crop) => pixelCrop(crop, sourceWidth, sourceHeight))
  if (pixels.some((crop) => (
    crop.width < MIN_TURNAROUND_CROP_PIXELS
    || crop.height < MIN_TURNAROUND_CROP_PIXELS
    || crop.x < 0
    || crop.y < 0
    || crop.x + crop.width > sourceWidth
    || crop.y + crop.height > sourceHeight
  ))) {
    throw new TurnaroundDerivationError(
      'INVALID_CROPS',
      `每个裁剪框必须完全位于源图且至少 ${MIN_TURNAROUND_CROP_PIXELS}×${MIN_TURNAROUND_CROP_PIXELS} 像素`,
    )
  }
  for (let left = 0; left < pixels.length; left += 1) {
    for (let right = left + 1; right < pixels.length; right += 1) {
      if (overlapRatio(pixels[left], pixels[right]) > MAX_TURNAROUND_CROP_OVERLAP_RATIO) {
        throw new TurnaroundDerivationError(
          'INVALID_CROPS',
          `三视图裁剪框两两重叠不能超过 ${Math.round(MAX_TURNAROUND_CROP_OVERLAP_RATIO * 100)}%`,
        )
      }
    }
  }
  const byRole = new Map(crops.map((crop, index) => [crop.role, { crop, pixels: pixels[index] }]))
  return TURNAROUND_ROLES.map((role) => {
    const selected = byRole.get(role)!
    return {
      role,
      normalized: {
        x: selected.crop.x,
        y: selected.crop.y,
        width: selected.crop.width,
        height: selected.crop.height,
      },
      pixels: {
        x: selected.pixels.x,
        y: selected.pixels.y,
        width: selected.pixels.width,
        height: selected.pixels.height,
      },
    }
  })
}

export function prepareTurnaroundDerivation(
  database: ManjuDatabase,
  request: PrepareTurnaroundDerivationInput,
): PreparedTurnaroundDerivation {
  if (!database.getProject(request.projectId)) {
    throw new TurnaroundDerivationError('PROJECT_NOT_FOUND', '项目不存在')
  }
  const source = database.getMediaAsset(request.sourceAssetId)
  if (!source || source.projectId !== request.projectId) {
    throw new TurnaroundDerivationError('ASSET_NOT_FOUND', '源资产不存在或不属于当前项目')
  }
  const etag = assetImageEditEtag(source)
  if (!etag || request.sourceIfMatch !== etag) {
    throw new TurnaroundDerivationError(
      'PRECONDITION_FAILED',
      '源资产版本已变更，请刷新后重试',
      { currentEtag: etag ?? null },
    )
  }
  const mimeType = normalizedMime(source.mimeType)
  if (source.status !== 'ready'
    || !SUPPORTED_MIME_TYPES.has(mimeType)
    || !source.episodeId
    || !source.sourceRevisionId
    || !source.checksum
    || !/^[a-f0-9]{64}$/i.test(source.checksum)
    || !positiveInteger(source.width)
    || !positiveInteger(source.height)) {
    throw new TurnaroundDerivationError(
      'INVALID_SOURCE_ASSET',
      '源资产必须是 ready 状态、尺寸与校验和已固化的分集图片',
    )
  }
  const currentRevisionId = episodeRevision(database, request.projectId, source.episodeId)
  if (source.sourceRevisionId !== currentRevisionId) {
    throw new TurnaroundDerivationError('STALE_SOURCE', '源图不属于当前分集剧本修订')
  }
  const character = sourceCharacterBinding(database, source)
  let currentCharacter
  try {
    currentCharacter = resolveVisualAssetEntity(database, {
      projectId: request.projectId,
      episodeId: source.episodeId,
      entityType: 'character',
      entityId: character.entityId,
    })
  } catch (error) {
    if (error instanceof VisualAssetGenerationError) {
      throw new TurnaroundDerivationError('STALE_SOURCE', '源图绑定的角色已变更')
    }
    throw error
  }
  if (currentCharacter.databaseId !== character.databaseEntityId
    || currentCharacter.sourceRevisionId !== character.expectedRevisionId) {
    throw new TurnaroundDerivationError('STALE_SOURCE', '源图绑定的角色已变更')
  }
  const crops = validateTurnaroundCrops(request.crops, source.width, source.height)
  return {
    sourceEtag: etag,
    input: {
      operation: TURNAROUND_DERIVATION_JOB_TYPE,
      algorithm: TURNAROUND_DERIVATION_ALGORITHM,
      sourceAssetId: source.id,
      source: {
        assetId: source.id,
        projectId: source.projectId,
        episodeId: source.episodeId,
        checksum: source.checksum.toLowerCase(),
        version: source.version,
        mimeType,
        width: source.width,
        height: source.height,
        sourceRevisionId: source.sourceRevisionId,
        character,
      },
      crops,
      assetEntityBinding: character,
    },
  }
}

function validDurableInput(value: unknown): value is TurnaroundDerivationJobInput {
  if (!isPlainObject(value)
    || Object.keys(value).some((key) => ![
      'operation',
      'algorithm',
      'sourceAssetId',
      'source',
      'crops',
      'assetEntityBinding',
    ].includes(key))
    || value.operation !== TURNAROUND_DERIVATION_JOB_TYPE
    || (value.algorithm !== TURNAROUND_DERIVATION_ALGORITHM
      && value.algorithm !== LEGACY_TURNAROUND_DERIVATION_ALGORITHM)
    || typeof value.sourceAssetId !== 'string'
    || !isPlainObject(value.source)
    || !Array.isArray(value.crops)
    || !parseVisualBinding(value.assetEntityBinding)) return false
  const source = value.source
  const binding = parseVisualBinding(source.character)
  if (Object.keys(source).some((key) => ![
    'assetId',
    'projectId',
    'episodeId',
    'checksum',
    'version',
    'mimeType',
    'width',
    'height',
    'sourceRevisionId',
    'character',
  ].includes(key))
    || source.assetId !== value.sourceAssetId
    || !identifier(source.assetId)
    || !identifier(source.projectId)
    || !identifier(source.episodeId)
    || typeof source.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(source.checksum)
    || !positiveInteger(source.version)
    || typeof source.mimeType !== 'string' || !SUPPORTED_MIME_TYPES.has(source.mimeType)
    || !positiveInteger(source.width)
    || !positiveInteger(source.height)
    || !identifier(source.sourceRevisionId)
    || !binding
    || !isDeepStrictEqual(binding, parseVisualBinding(value.assetEntityBinding))) return false

  const normalized: NormalizedTurnaroundCrop[] = []
  for (const raw of value.crops) {
    if (!isPlainObject(raw)
      || Object.keys(raw).some((key) => key !== 'role' && key !== 'normalized' && key !== 'pixels')
      || !TURNAROUND_ROLES.includes(raw.role as TurnaroundRole)
      || !isPlainObject(raw.normalized)
      || !isPlainObject(raw.pixels)) return false
    const normalizedKeys = Object.keys(raw.normalized)
    const pixelKeys = Object.keys(raw.pixels)
    if (normalizedKeys.length !== 4
      || normalizedKeys.some((key) => !['x', 'y', 'width', 'height'].includes(key))
      || pixelKeys.length !== 4
      || pixelKeys.some((key) => !['x', 'y', 'width', 'height'].includes(key))) return false
    normalized.push({
      role: raw.role as TurnaroundRole,
      x: raw.normalized.x as number,
      y: raw.normalized.y as number,
      width: raw.normalized.width as number,
      height: raw.normalized.height as number,
    })
  }
  try {
    return isDeepStrictEqual(
      validateTurnaroundCrops(normalized, source.width as number, source.height as number),
      value.crops,
    )
  } catch (error) {
    if (error instanceof TurnaroundDerivationError) return false
    throw error
  }
}

function sourceStillCurrent(database: ManjuDatabase, input: TurnaroundDerivationJobInput): MediaAssetRecord {
  const source = database.getMediaAsset(input.source.assetId)
  let currentRevisionId: string
  try {
    currentRevisionId = episodeRevision(database, input.source.projectId, input.source.episodeId)
  } catch (error) {
    if (error instanceof TurnaroundDerivationError) {
      throw new JobExecutionError('STALE_SOURCE', '三视图源资产所属分集或修订已变更', false, 'validation')
    }
    throw error
  }
  if (!source
    || source.projectId !== input.source.projectId
    || source.episodeId !== input.source.episodeId
    || source.status !== 'ready'
    || source.checksum?.toLowerCase() !== input.source.checksum
    || source.version !== input.source.version
    || normalizedMime(source.mimeType) !== input.source.mimeType
    || source.width !== input.source.width
    || source.height !== input.source.height
    || source.sourceRevisionId !== input.source.sourceRevisionId
    || currentRevisionId !== input.source.sourceRevisionId) {
    throw new JobExecutionError('STALE_SOURCE', '三视图源资产或分集修订已变更', false, 'validation')
  }
  let currentCharacter
  try {
    currentCharacter = resolveVisualAssetEntity(database, {
      projectId: input.source.projectId,
      episodeId: input.source.episodeId,
      entityType: 'character',
      entityId: input.source.character.entityId,
    })
  } catch {
    throw new JobExecutionError('STALE_SOURCE', '三视图源图绑定的角色已变更', false, 'validation')
  }
  if (currentCharacter.databaseId !== input.source.character.databaseEntityId
    || currentCharacter.sourceRevisionId !== input.source.character.expectedRevisionId) {
    throw new JobExecutionError('STALE_SOURCE', '三视图源图绑定的角色已变更', false, 'validation')
  }
  try {
    if (!isDeepStrictEqual(sourceCharacterBinding(database, source), input.source.character)) {
      throw new JobExecutionError('STALE_SOURCE', '三视图源图的角色绑定已变更', false, 'validation')
    }
  } catch (error) {
    if (error instanceof JobExecutionError) throw error
    if (error instanceof TurnaroundDerivationError) {
      throw new JobExecutionError('STALE_SOURCE', '三视图源图的角色绑定已变更', false, 'validation')
    }
    throw error
  }
  return source
}

export interface TurnaroundCropResult {
  role: TurnaroundRole
  bytes: Uint8Array
  mimeType: 'image/png'
  width: number
  height: number
}

export interface TurnaroundCropRenderer {
  crop(input: {
    sourceBytes: Uint8Array
    sourceMimeType: string
    crops: readonly DurableTurnaroundCrop[]
    algorithm?: TurnaroundDerivationAlgorithm
    signal: AbortSignal
  }): Promise<TurnaroundCropResult[]>
}

export interface FfmpegTurnaroundCropRendererOptions {
  workingDirectory: string
  ffmpegPath?: string | null
  runner?: RenderProcessRunner
  timeoutMs?: number
}

function extensionForMime(mimeType: string): string {
  return mimeType === 'image/jpeg' ? 'jpg'
    : mimeType === 'image/webp' ? 'webp'
      : mimeType === 'image/gif' ? 'gif' : 'png'
}

export class FfmpegTurnaroundCropRenderer implements TurnaroundCropRenderer {
  private readonly ffmpegPath: string | null
  private readonly runner: RenderProcessRunner
  private readonly timeoutMs: number

  constructor(private readonly options: FfmpegTurnaroundCropRendererOptions) {
    this.ffmpegPath = options.ffmpegPath === undefined ? resolveBundledFfmpegPath() : options.ffmpegPath
    this.runner = options.runner ?? new SpawnProcessRunner()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TURNAROUND_TIMEOUT_MS
  }

  async crop(input: {
    sourceBytes: Uint8Array
    sourceMimeType: string
    crops: readonly DurableTurnaroundCrop[]
    algorithm?: TurnaroundDerivationAlgorithm
    signal: AbortSignal
  }): Promise<TurnaroundCropResult[]> {
    input.signal.throwIfAborted()
    if (!this.ffmpegPath) {
      throw new JobExecutionError('FFMPEG_UNAVAILABLE', '当前平台没有可用的固定 FFmpeg 二进制', false, 'internal')
    }
    const taskDirectory = await mkdtemp(join(this.options.workingDirectory, '.turnaround-'))
    try {
      const sourcePath = join(taskDirectory, `source.${extensionForMime(input.sourceMimeType)}`)
      await writeFile(sourcePath, input.sourceBytes, { flag: 'wx', mode: 0o600 })
      const outputPaths = TURNAROUND_ROLES.map((role) => join(taskDirectory, `${role}.png`))
      const cropByRole = new Map(input.crops.map((crop) => [crop.role, crop]))
      const outputByRole = new Map(input.crops.map((crop) => [
        crop.role,
        input.algorithm === LEGACY_TURNAROUND_DERIVATION_ALGORITHM
          ? {
              width: crop.pixels.width,
              height: crop.pixels.height,
              contentWidth: crop.pixels.width,
              contentHeight: crop.pixels.height,
            }
          : seedanceSafeImageCanvas(crop.pixels.width, crop.pixels.height),
      ]))
      const filters = TURNAROUND_ROLES.map((role, index) => {
        const crop = cropByRole.get(role)
        if (!crop) throw new JobExecutionError('INVALID_CROPS', '固化裁剪框缺少角色', false, 'validation')
        const output = outputByRole.get(role)!
        const cropFilter = `crop=${crop.pixels.width}:${crop.pixels.height}:${crop.pixels.x}:${crop.pixels.y}`
        const scaleFilter = output.contentWidth !== crop.pixels.width || output.contentHeight !== crop.pixels.height
          ? `,scale=${output.contentWidth}:${output.contentHeight}:flags=lanczos`
          : ''
        const padFilter = output.width !== output.contentWidth || output.height !== output.contentHeight
          ? `,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2:white`
          : ''
        return `[v${index}]${cropFilter}${scaleFilter}${padFilter}[${role}]`
      })
      const args = [
        '-nostdin',
        '-hide_banner',
        '-loglevel', 'error',
        '-n',
        '-i', sourcePath,
        '-filter_complex', `[0:v]split=3[v0][v1][v2];${filters.join(';')}`,
      ]
      for (let index = 0; index < TURNAROUND_ROLES.length; index += 1) {
        args.push(
          '-map', `[${TURNAROUND_ROLES[index]}]`,
          '-frames:v', '1',
          '-c:v', 'png',
          '-f', 'image2',
          outputPaths[index],
        )
      }
      const result = await this.runner.run({
        command: this.ffmpegPath,
        args,
        cwd: taskDirectory,
        signal: input.signal,
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 256 * 1024,
      })
      if (result.exitCode !== 0) {
        throw new JobExecutionError(
          'FFMPEG_CROP_FAILED',
          `FFmpeg 三视图裁剪失败（退出码 ${result.exitCode}）`,
          false,
          'internal',
        )
      }
      let totalBytes = 0
      const outputs: TurnaroundCropResult[] = []
      for (let index = 0; index < TURNAROUND_ROLES.length; index += 1) {
        const path = outputPaths[index]
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_TURNAROUND_OUTPUT_BYTES) {
          throw new JobExecutionError('INVALID_CROP_OUTPUT', 'FFmpeg 裁剪输出文件无效或超限', false, 'internal')
        }
        totalBytes += Number(info.size)
        if (totalBytes > MAX_TURNAROUND_OUTPUT_TOTAL_BYTES) {
          throw new JobExecutionError('INVALID_CROP_OUTPUT', 'FFmpeg 裁剪输出总大小超限', false, 'internal')
        }
        const bytes = await readFile(path)
        const dimensions = imageDimensions(bytes, 'image/png')
        const output = outputByRole.get(TURNAROUND_ROLES[index])!
        if (dimensions.width !== output.width || dimensions.height !== output.height) {
          throw new JobExecutionError('INVALID_CROP_OUTPUT', 'FFmpeg 裁剪输出尺寸与固化裁剪框不一致', false, 'internal')
        }
        outputs.push({
          role: TURNAROUND_ROLES[index],
          bytes,
          mimeType: 'image/png',
          width: output.width,
          height: output.height,
        })
      }
      return outputs
    } finally {
      await rm(taskDirectory, { recursive: true, force: true })
    }
  }
}

async function readSource(
  database: ManjuDatabase,
  mediaStore: MediaStore,
  input: TurnaroundDerivationJobInput,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const current = sourceStillCurrent(database, input)
  let opened
  try {
    opened = await mediaStore.openAsset(input.source.assetId)
  } catch (error) {
    if (error instanceof MediaStoreError) {
      throw new JobExecutionError('SOURCE_FILE_UNAVAILABLE', '三视图源文件不可用', false, 'validation')
    }
    throw error
  }
  try {
    if (opened.size > MAX_TURNAROUND_SOURCE_BYTES) {
      throw new JobExecutionError('SOURCE_TOO_LARGE', '三视图源图不能超过 30MB', false, 'validation')
    }
    const bytes = await opened.file.readFile()
    signal.throwIfAborted()
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const dimensions = imageDimensions(bytes, opened.mimeType)
    if (bytes.byteLength !== opened.size
      || opened.asset.id !== current.id
      || checksum !== input.source.checksum
      || opened.mimeType !== input.source.mimeType
      || dimensions.width !== input.source.width
      || dimensions.height !== input.source.height) {
      throw new JobExecutionError('STALE_SOURCE_BYTES', '三视图源文件与固化快照不一致', false, 'validation')
    }
    return bytes
  } finally {
    await opened.file.close().catch(() => undefined)
  }
}

function jobAssets(database: ManjuDatabase, jobId: string): MediaAssetRecord[] {
  const rows = database.withSql((sql) => sql.all(`
    SELECT id FROM media_assets WHERE generation_job_id = ? ORDER BY id
  `, jobId))
  return rows.flatMap((row) => (
    typeof row.id === 'string' ? [database.getMediaAsset(row.id)].filter(Boolean) as MediaAssetRecord[] : []
  ))
}

export async function cleanupTurnaroundJobAssets(
  database: ManjuDatabase,
  mediaStore: MediaStore,
  jobId: string,
): Promise<void> {
  const assets = jobAssets(database, jobId)
  for (const asset of assets) {
    await mediaStore.deleteUnreferencedFile(asset)
    database.deleteMediaAsset(asset.id)
  }
}

export async function cleanupIncompleteTurnaroundAssets(
  database: ManjuDatabase,
  mediaStore: MediaStore,
): Promise<void> {
  const rows = database.withSql((sql) => sql.all(`
    SELECT DISTINCT media_assets.generation_job_id AS job_id
    FROM media_assets
    JOIN generation_jobs ON generation_jobs.id = media_assets.generation_job_id
    WHERE generation_jobs.type = ? AND generation_jobs.status <> 'succeeded'
  `, TURNAROUND_DERIVATION_JOB_TYPE))
  for (const row of rows) {
    if (typeof row.job_id === 'string') await cleanupTurnaroundJobAssets(database, mediaStore, row.job_id)
  }
}

function assertPublication(
  database: ManjuDatabase,
  jobId: string,
  input: TurnaroundDerivationJobInput,
): void {
  const job = database.getGenerationJob(jobId)
  if (!job
    || job.type !== TURNAROUND_DERIVATION_JOB_TYPE
    || job.projectId !== input.source.projectId
    || job.episodeId !== input.source.episodeId
    || (job.status !== 'running' && job.status !== 'waiting_provider')) {
    throw new JobExecutionError('JOB_NOT_ACTIVE', '三视图派生任务已取消或结束；输出已回滚', false, 'cancelled')
  }
  sourceStillCurrent(database, input)
}

export interface TurnaroundDerivationHandlerDependencies {
  database: ManjuDatabase
  mediaStore: MediaStore
  renderer: TurnaroundCropRenderer
  publicAsset: (asset: MediaAssetRecord) => JsonObject
  publishAsset: (asset: MediaAssetRecord) => void
}

export function createTurnaroundDerivationHandler(
  dependencies: TurnaroundDerivationHandlerDependencies,
): JobHandler<TurnaroundDerivationJobInput, JsonObject> {
  return async (
    job: JobRecord<TurnaroundDerivationJobInput>,
    context: JobHandlerContext,
  ): Promise<JsonObject> => {
    if (!validDurableInput(job.input)
      || job.projectId !== job.input.source.projectId
      || job.providerId !== undefined
      || job.providerConfigRevision !== undefined) {
      throw new JobExecutionError('INVALID_TURNAROUND_BINDING', '三视图派生任务绑定无效', false, 'validation')
    }
    await cleanupTurnaroundJobAssets(dependencies.database, dependencies.mediaStore, job.id)
    sourceStillCurrent(dependencies.database, job.input)
    const sourceBytes = await readSource(
      dependencies.database,
      dependencies.mediaStore,
      job.input,
      context.signal,
    )
    await context.reportProgress(10, { stage: 'local-ffmpeg-crop', sourceAssetId: job.input.source.assetId })
    const rendered = await dependencies.renderer.crop({
      sourceBytes,
      sourceMimeType: job.input.source.mimeType,
      crops: job.input.crops,
      algorithm: job.input.algorithm,
      signal: context.signal,
    })
    if (rendered.length !== 3
      || new Set(rendered.map((item) => item.role)).size !== 3
      || TURNAROUND_ROLES.some((role) => !rendered.some((item) => item.role === role))) {
      throw new JobExecutionError('INVALID_CROP_OUTPUT', '本地裁剪未返回完整的三视图', false, 'internal')
    }
    let totalBytes = 0
    for (const output of rendered) {
      totalBytes += output.bytes.byteLength
      const crop = job.input.crops.find((candidate) => candidate.role === output.role)!
      const expected = job.input.algorithm === LEGACY_TURNAROUND_DERIVATION_ALGORITHM
        ? { width: crop.pixels.width, height: crop.pixels.height }
        : seedanceSafeImageCanvas(crop.pixels.width, crop.pixels.height)
      if (output.mimeType !== 'image/png'
        || output.bytes.byteLength < 1
        || output.bytes.byteLength > MAX_TURNAROUND_OUTPUT_BYTES
        || output.width !== expected.width
        || output.height !== expected.height) {
        throw new JobExecutionError('INVALID_CROP_OUTPUT', '本地裁剪输出格式、尺寸或大小无效', false, 'internal')
      }
    }
    if (totalBytes > MAX_TURNAROUND_OUTPUT_TOTAL_BYTES) {
      throw new JobExecutionError('INVALID_CROP_OUTPUT', '本地裁剪输出总大小超限', false, 'internal')
    }

    const created: Array<{ role: TurnaroundRole; asset: MediaAssetRecord }> = []
    try {
      for (const role of TURNAROUND_ROLES) {
        context.signal.throwIfAborted()
        const output = rendered.find((candidate) => candidate.role === role)!
        const crop = job.input.crops.find((candidate) => candidate.role === role)!
        const asset = await dependencies.mediaStore.save({
          projectId: job.input.source.projectId,
          episodeId: job.input.source.episodeId,
          kind: `character-reference.${role}`,
          version: 1,
          bytes: output.bytes,
          mimeType: output.mimeType,
          source: 'derived',
          providerId: null,
          generationJobId: job.id,
          generationParameters: {
            operation: TURNAROUND_DERIVATION_JOB_TYPE,
            algorithm: job.input.algorithm,
            orientation: role,
            entityType: 'character',
            entityId: job.input.source.character.entityId,
            assetEntityBinding: { ...job.input.source.character },
            source: {
              assetId: job.input.source.assetId,
              checksum: job.input.source.checksum,
              version: job.input.source.version,
              width: job.input.source.width,
              height: job.input.source.height,
              sourceRevisionId: job.input.source.sourceRevisionId,
            },
            crop: {
              normalized: { ...crop.normalized },
              pixels: { ...crop.pixels },
            },
            outputCanvas: {
              width: output.width,
              height: output.height,
              paddingPolicy: job.input.algorithm === LEGACY_TURNAROUND_DERIVATION_ALGORITHM
                ? 'none'
                : 'seedance-open-envelope-white',
            },
          },
          sourceRevisionId: job.input.source.sourceRevisionId,
          parentAssetId: job.input.source.assetId,
          width: output.width,
          height: output.height,
        }, {
          afterCreate(_asset, transaction) {
            context.signal.throwIfAborted()
            assertPublication(transaction, job.id, job.input)
          },
        })
        created.push({ role, asset })
        await context.reportProgress(35 + created.length * 20, {
          stage: 'saving-derived-assets',
          completed: created.length,
          total: 3,
          role,
        })
      }
      context.signal.throwIfAborted()
      assertPublication(dependencies.database, job.id, job.input)
      for (const item of created) dependencies.publishAsset(item.asset)
      return {
        operation: TURNAROUND_DERIVATION_JOB_TYPE,
        algorithm: TURNAROUND_DERIVATION_ALGORITHM,
        sourceAssetId: job.input.source.assetId,
        assets: created.map((item) => ({
          role: item.role,
          asset: dependencies.publicAsset(item.asset),
        })),
      }
    } catch (error) {
      await cleanupTurnaroundJobAssets(dependencies.database, dependencies.mediaStore, job.id)
      throw error
    }
  }
}

export function sameTurnaroundSubmission(
  existing: GenerationJobRecord,
  input: TurnaroundDerivationJobInput,
): boolean {
  return existing.type === TURNAROUND_DERIVATION_JOB_TYPE
    && existing.providerId === null
    && existing.providerConfigRevision === null
    && isDeepStrictEqual(existing.input, input)
}
